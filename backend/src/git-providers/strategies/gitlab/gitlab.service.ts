import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../../db/drizzle.module';
import type { DrizzleDB } from '../../../db/drizzle.module';
import { gitlab, gitProvider } from '../../../db/schema';
import type { Gitlab, GitProvider } from '../../../db/schema';
import type { PermissionCtx } from '../../../rbac/permission.service';
import { OutboundAddressGuard } from '../../../outbound/outbound-address-guard';
import { FETCH_CLIENT } from '../../fetch.provider';
import type { FetchClient } from '../../fetch.provider';
import { requestOAuthTokenRefresh } from '../../oauth-refresh.util';
import type {
  CreateGitlabDto,
  FindGitlabBranchesDto,
  GitlabBranchDto,
  GitlabRepositoryDto,
  UpdateGitlabDto,
} from './dto/gitlab.dto';

/**
 * A GitLab connection as exposed over the API — the OAuth application secret
 * and both tokens never leave the server.
 */
export type SanitizedGitlab = Omit<
  Gitlab,
  'secret' | 'accessToken' | 'refreshToken'
> & {
  gitProvider: GitProvider;
};

function sanitize(row: Gitlab, provider: GitProvider): SanitizedGitlab {
  const { secret, accessToken, refreshToken, ...rest } = row;
  void secret;
  void accessToken;
  void refreshToken;
  return { ...rest, gitProvider: provider };
}

/** GitLab reachable on a private address wins over the public URL. */
function baseUrl(row: Pick<Gitlab, 'gitlabUrl' | 'gitlabInternalUrl'>): string {
  return (row.gitlabInternalUrl || row.gitlabUrl).replace(/\/+$/, '');
}

@Injectable()
export class GitlabService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(FETCH_CLIENT) private readonly transport: FetchClient,
    private readonly guard: OutboundAddressGuard,
  ) {}

  /**
   * The transport for a call to this connection's GitLab, guarded at the dial
   *: `gitlabInternalUrl` or `gitlabUrl`, whichever {@link baseUrl}
   * picks, is refused when it is, or resolves to, loopback, a private or
   * link-local range or the metadata address — unless the connection belongs
   * to the instance organization, whose operator pointing it at a GitLab on
   * their own network is the case the internal URL exists for. The refusal
   * names whichever of the two fields was dialled.
   */
  fetchFor(row: Gitlab): FetchClient {
    return this.guard.fetchFor(this.transport, {
      place: { gitProviderId: row.gitProviderId },
      field: row.gitlabInternalUrl ? 'gitlabInternalUrl' : 'gitlabUrl',
    });
  }

  /**
   * GitLab OAuth access tokens are short-lived, so every API call goes through
   * here first. A token still valid past the safety margin is kept; otherwise
   * the refresh-token grant rotates the pair and the row is updated before use.
   */
  async refreshToken(row: Gitlab): Promise<Gitlab> {
    const safetyMargin = 60;
    const now = Math.floor(Date.now() / 1000);
    if (row.expiresAt && now + safetyMargin < row.expiresAt) {
      return row;
    }

    const result = await requestOAuthTokenRefresh(
      this.fetchFor(row),
      `${baseUrl(row)}/oauth/token`,
      {
        refreshToken: row.refreshToken ?? '',
        clientId: row.applicationId ?? '',
        clientSecret: row.secret ?? '',
      },
    );
    if (!result.ok) {
      throw new BadRequestException(
        `Failed to refresh token: ${result.statusText}`,
      );
    }

    const [updated] = await this.db
      .update(gitlab)
      .set({
        accessToken: result.grant.accessToken,
        refreshToken: result.grant.refreshToken ?? row.refreshToken,
        expiresAt:
          Math.floor(Date.now() / 1000) + (result.grant.expiresIn ?? 3600),
      })
      .where(eq(gitlab.gitlabId, row.gitlabId))
      .returning();
    return updated;
  }

  /**
   * The projects the connected user is a member of, restricted to the
   * configured comma-separated group names when set, personal projects
   * otherwise.
   */
  async listRepositories(row: Gitlab): Promise<GitlabRepositoryDto[]> {
    const fresh = await this.refreshToken(row);
    const projects = await this.fetchAllPages<{
      id: number;
      name: string;
      path_with_namespace: string;
      namespace: { path: string; full_path: string; kind: string };
      default_branch?: string | null;
    }>(fresh, '/api/v4/projects?membership=true');

    const groupNames = (fresh.groupName ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0);
    return projects
      .filter((project) =>
        groupNames.length > 0
          ? groupNames.some((name) =>
              project.namespace.full_path.toLowerCase().startsWith(name),
            )
          : project.namespace.kind === 'user',
      )
      .map((project) => ({
        id: project.id,
        name: project.name,
        owner: project.namespace.path,
        pathNamespace: project.path_with_namespace,
        defaultBranch: project.default_branch ?? null,
      }));
  }

  /** The branches of one reachable project. */
  async listBranches(
    row: Gitlab,
    { projectId }: FindGitlabBranchesDto,
  ): Promise<GitlabBranchDto[]> {
    const fresh = await this.refreshToken(row);
    const branches = await this.fetchAllPages<{
      name: string;
      commit: { id: string };
    }>(fresh, `/api/v4/projects/${projectId}/repository/branches`);
    return branches.map((branch) => ({
      name: branch.name,
      commitSha: branch.commit.id,
    }));
  }

  /** listRepositories for a connection addressed by id, org-scoped. */
  async listRepositoriesFor(
    ctx: PermissionCtx,
    gitlabId: string,
  ): Promise<GitlabRepositoryDto[]> {
    const { row } = await this.findRow(ctx, gitlabId);
    return this.listRepositories(row);
  }

  /** listBranches for a connection addressed by id, org-scoped. */
  async listBranchesFor(
    ctx: PermissionCtx,
    gitlabId: string,
    params: FindGitlabBranchesDto,
  ): Promise<GitlabBranchDto[]> {
    const { row } = await this.findRow(ctx, gitlabId);
    return this.listBranches(row, params);
  }

  /**
   * The connection row behind a base `git_provider` id, deliberately
   * not org-scoped: the caller resolved the id inside its organization when
   * it stored it. `null` when the connection is gone.
   */
  async findByGitProviderId(gitProviderId: string): Promise<Gitlab | null> {
    const [found] = await this.db
      .select()
      .from(gitlab)
      .where(eq(gitlab.gitProviderId, gitProviderId))
      .limit(1);
    return found ?? null;
  }

  /**
   * One authenticated GET of the REST API (`path` from `/api/v4`), answered
   * as GitLab answered it, for a caller that reads statuses itself (the
   * config reader). Refreshes the token first, which throws when it
   * cannot be refreshed.
   */
  async get(row: Gitlab, path: string): Promise<Response> {
    const fresh = await this.refreshToken(row);
    return this.fetchFor(fresh)(`${baseUrl(fresh)}${path}`, {
      headers: { Authorization: `Bearer ${fresh.accessToken}` },
    });
  }

  /**
   * Pages through a GitLab collection endpoint (GitLab caps per_page at 100)
   * until a page comes back empty or the x-total header is reached.
   */
  private async fetchAllPages<T>(row: Gitlab, path: string): Promise<T[]> {
    const separator = path.includes('?') ? '&' : '?';
    const all: T[] = [];
    let page = 1;
    for (;;) {
      const response = await this.fetchFor(row)(
        `${baseUrl(row)}${path}${separator}page=${page}&per_page=100`,
        { headers: { Authorization: `Bearer ${row.accessToken}` } },
      );
      if (!response.ok) {
        throw new BadRequestException(
          `Failed to fetch from GitLab: ${response.statusText}`,
        );
      }
      const items = (await response.json()) as T[];
      if (items.length === 0) break;
      all.push(...items);
      page += 1;
      const total = response.headers.get('x-total');
      if (total && all.length >= Number.parseInt(total, 10)) break;
    }
    return all;
  }

  /**
   * Create the base gitProvider row and the gitlab detail row in one
   * transaction, in the session's active organization.
   */
  async create(
    ctx: PermissionCtx,
    data: CreateGitlabDto,
  ): Promise<SanitizedGitlab> {
    const { name, ...credentials } = data;
    return this.db.transaction(async (tx) => {
      const [provider] = await tx
        .insert(gitProvider)
        .values({
          name,
          providerType: 'gitlab',
          organizationId: ctx.session.activeOrganizationId,
        })
        .returning();
      const [created] = await tx
        .insert(gitlab)
        .values({ ...credentials, gitProviderId: provider.gitProviderId })
        .returning();
      return sanitize(created, provider);
    });
  }

  /**
   * Every connection in the organization, newest first, secrets stripped.
   * Deliberately unfiltered: the listing is the only place a gitlabId is
   * produced, so filtering out a connection whose OAuth callback has not run
   * yet would make it unreachable by findOne and update. Whether a connection
   * can actually clone is asked at use.
   */
  async list(ctx: PermissionCtx): Promise<SanitizedGitlab[]> {
    const rows = await this.db
      .select()
      .from(gitlab)
      .innerJoin(
        gitProvider,
        eq(gitlab.gitProviderId, gitProvider.gitProviderId),
      )
      .where(eq(gitProvider.organizationId, ctx.session.activeOrganizationId))
      .orderBy(desc(gitProvider.createdAt));
    return rows.map((r) => sanitize(r.gitlab, r.git_provider));
  }

  /** One connection by id — only visible inside its organization. */
  async findOne(
    ctx: PermissionCtx,
    gitlabId: string,
  ): Promise<SanitizedGitlab> {
    const { row, provider } = await this.findRow(ctx, gitlabId);
    return sanitize(row, provider);
  }

  /**
   * Renames the base provider row and updates the credential fields together,
   * org-scoped through findRow.
   */
  async update(
    ctx: PermissionCtx,
    gitlabId: string,
    data: UpdateGitlabDto,
  ): Promise<SanitizedGitlab> {
    const current = await this.findRow(ctx, gitlabId);
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
          .update(gitlab)
          .set(credentials)
          .where(eq(gitlab.gitlabId, current.row.gitlabId))
          .returning();
      }
      return sanitize(row, provider);
    });
  }

  /** The full gitlab row + base provider, org-scoped through the join. */
  private async findRow(
    ctx: PermissionCtx,
    gitlabId: string,
  ): Promise<{ row: Gitlab; provider: GitProvider }> {
    const [found] = await this.db
      .select()
      .from(gitlab)
      .innerJoin(
        gitProvider,
        eq(gitlab.gitProviderId, gitProvider.gitProviderId),
      )
      .where(
        and(
          eq(gitlab.gitlabId, gitlabId),
          eq(gitProvider.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('GitLab provider not found');
    return { row: found.gitlab, provider: found.git_provider };
  }
}
