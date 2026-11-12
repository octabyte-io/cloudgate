import { Injectable, Logger } from '@nestjs/common';

import { BitbucketService } from '../git-providers/strategies/bitbucket/bitbucket.service';
import { GiteaService } from '../git-providers/strategies/gitea/gitea.service';
import { GithubService } from '../git-providers/strategies/github/github.service';
import { GitlabService } from '../git-providers/strategies/gitlab/gitlab.service';
import type { PermissionCtx } from '../rbac/permission.service';

/** A hosted provider a config `source` can name. */
export type HostedProvider = 'github' | 'gitlab' | 'gitea' | 'bitbucket';

/**
 * The organization's git provider connection that reaches a repository, and
 * what a plan-created Application takes from it: the
 * connection, the repository as the provider names it, and its default
 * branch, which becomes the Application's branch and is Cloudgate's after.
 */
export type ResolvedConnection =
  | {
      readonly sourceType: 'github';
      readonly githubId: string;
      readonly owner: string;
      readonly repository: string;
      readonly defaultBranch: string;
    }
  | {
      readonly sourceType: 'gitlab';
      readonly gitlabId: string;
      readonly projectId: number;
      readonly owner: string;
      readonly repository: string;
      readonly pathNamespace: string;
      readonly defaultBranch: string;
    }
  | {
      readonly sourceType: 'gitea';
      readonly giteaId: string;
      readonly owner: string;
      readonly repository: string;
      readonly defaultBranch: string;
    }
  | {
      readonly sourceType: 'bitbucket';
      readonly bitbucketId: string;
      readonly owner: string;
      readonly repository: string;
      readonly slug: string;
      readonly defaultBranch: string;
    };

/** What a provider that reports no default branch is taken to have. */
const FALLBACK_BRANCH = 'main';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Finds the connection of the named type that reaches a repository, asking
 * each of the organization's connections of that type for its repositories
 * through the provider services' own listings, newest connection first. A
 * connection whose provider cannot be reached is passed over, not fatal: the
 * question is whether *some* connection reaches the repository.
 *
 * A repository-kept config's own connection is asked first when it is of
 * the named type: the config location's connection is preferred when
 * it qualifies, so a plan-created Application from the config's repository
 * clones through the connection the config is read through.
 */
@Injectable()
export class GitConnectionResolver {
  private readonly logger = new Logger(GitConnectionResolver.name);

  constructor(
    private readonly github: GithubService,
    private readonly gitlab: GitlabService,
    private readonly gitea: GiteaService,
    private readonly bitbucket: BitbucketService,
  ) {}

  /**
   * @param preferred the config location's base `git_provider` id, asked
   * first when it is one of `provider`'s connections; `null` for none.
   */
  async resolve(
    ctx: PermissionCtx,
    provider: HostedProvider,
    repository: string,
    preferred: string | null = null,
  ): Promise<ResolvedConnection | null> {
    /** The strategy row ids, newest first, the preferred connection's first. */
    const order = <T extends { gitProvider: { gitProviderId: string } }>(
      rows: readonly T[],
      idOf: (row: T) => string,
    ) =>
      [
        ...rows.filter((row) => row.gitProvider.gitProviderId === preferred),
        ...rows.filter((row) => row.gitProvider.gitProviderId !== preferred),
      ].map(idOf);
    switch (provider) {
      case 'github':
        return this.first(
          order(await this.github.list(ctx), (row) => row.githubId),
          async (githubId) => {
            const found = (
              await this.github.listRepositoriesFor(ctx, githubId)
            ).find((repo) => same(`${repo.owner}/${repo.name}`, repository));
            return found
              ? {
                  sourceType: 'github',
                  githubId,
                  owner: found.owner,
                  repository: found.name,
                  defaultBranch: found.defaultBranch ?? FALLBACK_BRANCH,
                }
              : null;
          },
        );
      case 'gitlab':
        return this.first(
          order(await this.gitlab.list(ctx), (row) => row.gitlabId),
          async (gitlabId) => {
            const found = (
              await this.gitlab.listRepositoriesFor(ctx, gitlabId)
            ).find((repo) => same(repo.pathNamespace, repository));
            return found
              ? {
                  sourceType: 'gitlab',
                  gitlabId,
                  projectId: found.id,
                  owner: found.owner,
                  repository: found.name,
                  pathNamespace: found.pathNamespace,
                  defaultBranch: found.defaultBranch ?? FALLBACK_BRANCH,
                }
              : null;
          },
        );
      case 'gitea':
        return this.first(
          order(await this.gitea.list(ctx), (row) => row.giteaId),
          async (giteaId) => {
            const found = (
              await this.gitea.listRepositoriesFor(ctx, giteaId)
            ).find((repo) => same(`${repo.owner}/${repo.name}`, repository));
            return found
              ? {
                  sourceType: 'gitea',
                  giteaId,
                  owner: found.owner,
                  repository: found.name,
                  defaultBranch: found.defaultBranch ?? FALLBACK_BRANCH,
                }
              : null;
          },
        );
      case 'bitbucket':
        return this.first(
          order(await this.bitbucket.list(ctx), (row) => row.bitbucketId),
          async (bitbucketId) => {
            const found = (
              await this.bitbucket.listRepositoriesFor(ctx, bitbucketId)
            ).find(
              (repo) =>
                same(`${repo.owner}/${repo.slug}`, repository) ||
                same(`${repo.owner}/${repo.name}`, repository),
            );
            return found
              ? {
                  sourceType: 'bitbucket',
                  bitbucketId,
                  owner: found.owner,
                  // As the config names it, so the next plan compares equal.
                  repository: repository.slice(repository.indexOf('/') + 1),
                  slug: found.slug,
                  defaultBranch: found.defaultBranch ?? FALLBACK_BRANCH,
                }
              : null;
          },
        );
    }
  }

  private async first(
    ids: readonly string[],
    probe: (id: string) => Promise<ResolvedConnection | null>,
  ): Promise<ResolvedConnection | null> {
    for (const id of ids) {
      try {
        const found = await probe(id);
        if (found) return found;
      } catch (error) {
        this.logger.warn(
          `Git provider connection ${id} could not list its repositories: ${String(error)}`,
        );
      }
    }
    return null;
  }
}
