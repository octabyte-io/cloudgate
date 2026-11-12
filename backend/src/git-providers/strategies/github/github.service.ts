import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../../db/drizzle.module';
import type { DrizzleDB } from '../../../db/drizzle.module';
import { github, gitProvider } from '../../../db/schema';
import type { Github, GitProvider } from '../../../db/schema';
import type { PermissionCtx } from '../../../rbac/permission.service';
import type {
  CreateGithubDto,
  FindGithubBranchesDto,
  GithubBranchDto,
  GithubRepositoryDto,
  UpdateGithubDto,
} from './dto/github.dto';
import { OCTOKIT_FACTORY } from './octokit.provider';
import type { OctokitFactory } from './octokit.provider';

/**
 * A GitHub connection as exposed over the API — the app's private key, client
 * secret and webhook secret never leave the server. The webhook secret is what
 * makes an inbound delivery provable, so handing it out would let any reader
 * forge one.
 */
export type SanitizedGithub = Omit<
  Github,
  'privateKey' | 'clientSecret' | 'webhookSecret'
> & {
  gitProvider: GitProvider;
};

function sanitize(row: Github, provider: GitProvider): SanitizedGithub {
  const { privateKey, clientSecret, webhookSecret, ...rest } = row;
  void privateKey;
  void clientSecret;
  void webhookSecret;
  return { ...rest, gitProvider: provider };
}

@Injectable()
export class GithubService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(OCTOKIT_FACTORY) private readonly createOctokit: OctokitFactory,
  ) {}

  /**
   * Mints an installation access token for the connection's GitHub App. The
   * token is short-lived and embedded in clone URLs / API calls; it never
   * touches the database.
   */
  async getGithubToken(
    row: Pick<Github, 'appId' | 'privateKey' | 'installationId'>,
  ): Promise<string> {
    const octokit = this.appOctokit(row);
    const installation = (await octokit.auth({ type: 'installation' })) as {
      token: string;
    };
    return installation.token;
  }

  /**
   * Every repository the app installation can reach, mapped to our DTO.
   */
  async listRepositories(
    row: Pick<Github, 'appId' | 'privateKey' | 'installationId'>,
  ): Promise<GithubRepositoryDto[]> {
    const octokit = this.appOctokit(row);
    const repositories = (await octokit.paginate(
      octokit.rest.apps.listReposAccessibleToInstallation,
    )) as unknown as Array<{
      name: string;
      owner: { login: string };
      html_url: string;
      default_branch?: string;
    }>;
    return repositories.map((repository) => ({
      name: repository.name,
      owner: repository.owner.login,
      url: repository.html_url,
      defaultBranch: repository.default_branch ?? null,
    }));
  }

  /** The branches of one reachable repository. */
  async listBranches(
    row: Pick<Github, 'appId' | 'privateKey' | 'installationId'>,
    { owner, repo }: FindGithubBranchesDto,
  ): Promise<GithubBranchDto[]> {
    const octokit = this.appOctokit(row);
    const branches = (await octokit.paginate(octokit.rest.repos.listBranches, {
      owner,
      repo,
    })) as unknown as Array<{ name: string; commit: { sha: string } }>;
    return branches.map((branch) => ({
      name: branch.name,
      commitSha: branch.commit.sha,
    }));
  }

  /** listRepositories for a connection addressed by id, org-scoped. */
  async listRepositoriesFor(
    ctx: PermissionCtx,
    githubId: string,
  ): Promise<GithubRepositoryDto[]> {
    const { row } = await this.findRow(ctx, githubId);
    return this.listRepositories(row);
  }

  /** listBranches for a connection addressed by id, org-scoped. */
  async listBranchesFor(
    ctx: PermissionCtx,
    githubId: string,
    params: FindGithubBranchesDto,
  ): Promise<GithubBranchDto[]> {
    const { row } = await this.findRow(ctx, githubId);
    return this.listBranches(row, params);
  }

  /**
   * Posts a preview-deployment comment on a pull request (issues API, as PRs
   * are issues to GitHub).
   */
  async postPrComment(
    row: Pick<Github, 'appId' | 'privateKey' | 'installationId'>,
    params: { owner: string; repo: string; issueNumber: number; body: string },
  ): Promise<{ commentId: number }> {
    const octokit = this.appOctokit(row);
    const comment = await octokit.rest.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.issueNumber,
      body: params.body,
    });
    return { commentId: comment.data.id };
  }

  /**
   * Used to validate PR authors before allowing preview deployments. Only
   * write, maintain and admin collaborators may trigger them; GitHub answers
   * 404 for non-collaborators.
   */
  async checkUserRepositoryPermissions(
    row: Pick<Github, 'appId' | 'privateKey' | 'installationId'>,
    params: { owner: string; repo: string; username: string },
  ): Promise<{ hasWriteAccess: boolean; permission: string | null }> {
    const octokit = this.appOctokit(row);
    try {
      const { data } =
        await octokit.rest.repos.getCollaboratorPermissionLevel(params);
      const allowed = ['write', 'admin', 'maintain'];
      return {
        hasWriteAccess: allowed.includes(data.permission),
        permission: data.permission,
      };
    } catch {
      return { hasWriteAccess: false, permission: null };
    }
  }

  /**
   * Resolves the connection a webhook delivery belongs to. Webhooks are
   * unauthenticated, so this is keyed by GitHub's installation id and NOT
   * org-scoped; the full row stays inside the webhook handler.
   */
  async findByInstallationId(installationId: string): Promise<Github | null> {
    const [found] = await this.db
      .select()
      .from(github)
      .where(eq(github.installationId, installationId))
      .limit(1);
    return found ?? null;
  }

  /**
   * The connection behind a `git_provider` row, for a reader that holds the
   * base row's id (a repository-kept Project config's location). Not
   * org-scoped: the caller resolved the id inside its organization when it
   * stored it. `null` when the connection is gone.
   */
  async findByGitProviderId(gitProviderId: string): Promise<Github | null> {
    const [found] = await this.db
      .select()
      .from(github)
      .where(eq(github.gitProviderId, gitProviderId))
      .limit(1);
    return found ?? null;
  }

  /**
   * An octokit client authenticated as the connection's app installation, for
   * a caller that speaks the API itself (the config reader). Refuses a
   * half-configured connection as {@link getGithubToken} does.
   */
  client(row: Pick<Github, 'appId' | 'privateKey' | 'installationId'>) {
    return this.appOctokit(row);
  }

  /**
   * An octokit client for a fully-installed app.
   *
   * **The refusal names the three boxes on the Connect GitHub dialog, not the
   * three columns behind them**. A connection may be saved before it is
   * finished, so this message is the one an operator meets on "Check a
   * connection" for a half-filled row — and it used to interpolate `appId`,
   * `privateKey` and `installationId`, which are spelled nowhere on that
   * screen. The labels are `providers.ts`'s `github` descriptor; if one of them
   * is ever reworded, this sentence is the other half of the pair.
   */
  private appOctokit(
    row: Pick<Github, 'appId' | 'privateKey' | 'installationId'>,
  ) {
    const { appId, privateKey, installationId } = row;
    if (!appId || !privateKey || !installationId) {
      throw new BadRequestException(
        'GitHub App is not configured correctly (App ID, Private key and Installation ID are required)',
      );
    }
    return this.createOctokit({ appId, privateKey, installationId });
  }

  /**
   * Create the base gitProvider row and the github detail row in one
   * transaction, in the session's active organization.
   */
  async create(
    ctx: PermissionCtx,
    data: CreateGithubDto,
  ): Promise<SanitizedGithub> {
    const { name, ...credentials } = data;
    return this.db.transaction(async (tx) => {
      const [provider] = await tx
        .insert(gitProvider)
        .values({
          name,
          providerType: 'github',
          organizationId: ctx.session.activeOrganizationId,
        })
        .returning();
      const [created] = await tx
        .insert(github)
        .values({ ...credentials, gitProviderId: provider.gitProviderId })
        .returning();
      return sanitize(created, provider);
    });
  }

  /**
   * Every connection in the organization, newest first, secrets stripped.
   * Deliberately unfiltered: the listing is the only place a githubId is
   * produced, so filtering out a connection whose app is not installed yet
   * would make it unreachable by findOne and update. Whether a connection can
   * actually clone is asked at use.
   */
  async list(ctx: PermissionCtx): Promise<SanitizedGithub[]> {
    const rows = await this.db
      .select()
      .from(github)
      .innerJoin(
        gitProvider,
        eq(github.gitProviderId, gitProvider.gitProviderId),
      )
      .where(eq(gitProvider.organizationId, ctx.session.activeOrganizationId))
      .orderBy(desc(gitProvider.createdAt));
    return rows.map((r) => sanitize(r.github, r.git_provider));
  }

  /** One connection by id — only visible inside its organization. */
  async findOne(
    ctx: PermissionCtx,
    githubId: string,
  ): Promise<SanitizedGithub> {
    const { row, provider } = await this.findRow(ctx, githubId);
    return sanitize(row, provider);
  }

  /**
   * Renames the base provider row and updates the credential fields together,
   * org-scoped through findRow.
   */
  async update(
    ctx: PermissionCtx,
    githubId: string,
    data: UpdateGithubDto,
  ): Promise<SanitizedGithub> {
    const current = await this.findRow(ctx, githubId);
    const { name, ...credentials } = data;
    return this.db.transaction(async (tx) => {
      let provider = current.provider;
      if (name !== undefined) {
        [provider] = await tx
          .update(gitProvider)
          .set({ name })
          .where(eq(gitProvider.gitProviderId, provider.gitProviderId))
          .returning();
      }
      let row = current.row;
      if (Object.keys(credentials).length > 0) {
        [row] = await tx
          .update(github)
          .set(credentials)
          .where(eq(github.githubId, current.row.githubId))
          .returning();
      }
      return sanitize(row, provider);
    });
  }

  /** The full github row + base provider, org-scoped through the join. */
  private async findRow(
    ctx: PermissionCtx,
    githubId: string,
  ): Promise<{ row: Github; provider: GitProvider }> {
    const [found] = await this.db
      .select()
      .from(github)
      .innerJoin(
        gitProvider,
        eq(github.gitProviderId, gitProvider.gitProviderId),
      )
      .where(
        and(
          eq(github.githubId, githubId),
          eq(gitProvider.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('GitHub provider not found');
    return { row: found.github, provider: found.git_provider };
  }
}
