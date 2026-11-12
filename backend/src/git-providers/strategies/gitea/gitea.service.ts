import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../../db/drizzle.module';
import type { DrizzleDB } from '../../../db/drizzle.module';
import { gitea, gitProvider } from '../../../db/schema';
import type { Gitea, GitProvider } from '../../../db/schema';
import type { PermissionCtx } from '../../../rbac/permission.service';
import { OutboundAddressGuard } from '../../../outbound/outbound-address-guard';
import { FETCH_CLIENT } from '../../fetch.provider';
import type { FetchClient } from '../../fetch.provider';
import { requestOAuthTokenRefresh } from '../../oauth-refresh.util';
import type {
  CreateGiteaDto,
  FindGiteaBranchesDto,
  GiteaBranchDto,
  GiteaRepositoryDto,
  UpdateGiteaDto,
} from './dto/gitea.dto';

/**
 * A Gitea connection as exposed over the API — the OAuth client secret and
 * both tokens never leave the server.
 */
export type SanitizedGitea = Omit<
  Gitea,
  'clientSecret' | 'accessToken' | 'refreshToken'
> & {
  gitProvider: GitProvider;
};

function sanitize(row: Gitea, provider: GitProvider): SanitizedGitea {
  const { clientSecret, accessToken, refreshToken, ...rest } = row;
  void clientSecret;
  void accessToken;
  void refreshToken;
  return { ...rest, gitProvider: provider };
}

/** Gitea reachable on a private address wins over the public URL. */
function baseUrl(row: Pick<Gitea, 'giteaUrl' | 'giteaInternalUrl'>): string {
  return (row.giteaInternalUrl || row.giteaUrl).replace(/\/+$/, '');
}

@Injectable()
export class GiteaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(FETCH_CLIENT) private readonly transport: FetchClient,
    private readonly guard: OutboundAddressGuard,
  ) {}

  /**
   * The transport for a call to this connection's Gitea, guarded at the dial
   *: `giteaInternalUrl` or `giteaUrl`, whichever {@link baseUrl}
   * picks, is refused when it is, or resolves to, loopback, a private or
   * link-local range or the metadata address — unless the connection belongs
   * to the instance organization, whose operator pointing it at a Gitea on
   * their own network is the case the internal URL exists for. The refusal
   * names whichever of the two fields was dialled.
   */
  fetchFor(row: Gitea): FetchClient {
    return this.guard.fetchFor(this.transport, {
      place: { gitProviderId: row.gitProviderId },
      field: row.giteaInternalUrl ? 'giteaInternalUrl' : 'giteaUrl',
    });
  }

  /**
   * Refresh the OAuth token, deliberately non-fatal: a connection that cannot
   * refresh (incomplete app credentials, provider rejection) keeps its current
   * token and lets the actual API call surface the error.
   */
  async refreshToken(row: Gitea): Promise<Gitea> {
    if (!row.clientId || !row.clientSecret || !row.refreshToken) {
      return row;
    }
    const safetyMargin = 300;
    const now = Math.floor(Date.now() / 1000);
    if (
      row.expiresAt &&
      row.expiresAt > now + safetyMargin &&
      row.accessToken
    ) {
      return row;
    }

    const result = await requestOAuthTokenRefresh(
      this.fetchFor(row),
      `${baseUrl(row)}/login/oauth/access_token`,
      {
        refreshToken: row.refreshToken,
        clientId: row.clientId,
        clientSecret: row.clientSecret,
      },
    );
    if (!result.ok) {
      return row;
    }

    const [updated] = await this.db
      .update(gitea)
      .set({
        accessToken: result.grant.accessToken,
        refreshToken: result.grant.refreshToken ?? row.refreshToken,
        expiresAt:
          Math.floor(Date.now() / 1000) + (result.grant.expiresIn ?? 3600),
      })
      .where(eq(gitea.giteaId, row.giteaId))
      .returning();
    return updated;
  }

  /** The user's repositories, mapped. */
  async listRepositories(row: Gitea): Promise<GiteaRepositoryDto[]> {
    const fresh = await this.refreshToken(row);
    const repositories = await this.fetchAllPages<{
      id: number;
      name: string;
      owner: { login: string };
      html_url: string;
      default_branch?: string;
    }>(fresh, '/api/v1/user/repos');
    return repositories.map((repository) => ({
      id: repository.id,
      name: repository.name,
      owner: repository.owner.login,
      url: repository.html_url,
      defaultBranch: repository.default_branch ?? null,
    }));
  }

  /** The branches of one repository. */
  async listBranches(
    row: Gitea,
    { owner, repo }: FindGiteaBranchesDto,
  ): Promise<GiteaBranchDto[]> {
    const fresh = await this.refreshToken(row);
    const branches = await this.fetchAllPages<{
      name: string;
      commit: { id: string };
    }>(fresh, `/api/v1/repos/${owner}/${repo}/branches`);
    return branches.map((branch) => ({
      name: branch.name,
      commitSha: branch.commit.id,
    }));
  }

  /** listRepositories for a connection addressed by id, org-scoped. */
  async listRepositoriesFor(
    ctx: PermissionCtx,
    giteaId: string,
  ): Promise<GiteaRepositoryDto[]> {
    const { row } = await this.findRow(ctx, giteaId);
    return this.listRepositories(row);
  }

  /** listBranches for a connection addressed by id, org-scoped. */
  async listBranchesFor(
    ctx: PermissionCtx,
    giteaId: string,
    params: FindGiteaBranchesDto,
  ): Promise<GiteaBranchDto[]> {
    const { row } = await this.findRow(ctx, giteaId);
    return this.listBranches(row, params);
  }

  /**
   * The connection row behind a base `git_provider` id, deliberately
   * not org-scoped: the caller resolved the id inside its organization when
   * it stored it. `null` when the connection is gone.
   */
  async findByGitProviderId(gitProviderId: string): Promise<Gitea | null> {
    const [found] = await this.db
      .select()
      .from(gitea)
      .where(eq(gitea.gitProviderId, gitProviderId))
      .limit(1);
    return found ?? null;
  }

  /**
   * One authenticated GET of the REST API (`path` from `/api/v1`), answered
   * as Gitea answered it, for a caller that reads statuses itself (the
   * config reader). Refreshes the token first, as every call does.
   */
  async get(row: Gitea, path: string): Promise<Response> {
    const fresh = await this.refreshToken(row);
    return this.fetchFor(fresh)(`${baseUrl(fresh)}${path}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `token ${fresh.accessToken}`,
      },
    });
  }

  /**
   * Pages through a Gitea collection endpoint (50 per page) until a page
   * comes back short — Gitea reports no total.
   */
  private async fetchAllPages<T>(row: Gitea, path: string): Promise<T[]> {
    const limit = 50;
    const all: T[] = [];
    let page = 1;
    for (;;) {
      const response = await this.fetchFor(row)(
        `${baseUrl(row)}${path}?page=${page}&limit=${limit}`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: `token ${row.accessToken}`,
          },
        },
      );
      if (!response.ok) {
        throw new BadRequestException(
          `Failed to fetch from Gitea: ${response.statusText}`,
        );
      }
      const items = (await response.json()) as T[];
      if (!Array.isArray(items) || items.length === 0) break;
      all.push(...items);
      if (items.length < limit) break;
      page += 1;
    }
    return all;
  }

  /**
   * Create the base gitProvider row and the gitea detail row in one
   * transaction, in the session's active organization.
   */
  async create(
    ctx: PermissionCtx,
    data: CreateGiteaDto,
  ): Promise<SanitizedGitea> {
    const { name, ...credentials } = data;
    return this.db.transaction(async (tx) => {
      const [provider] = await tx
        .insert(gitProvider)
        .values({
          name,
          providerType: 'gitea',
          organizationId: ctx.session.activeOrganizationId,
        })
        .returning();
      const [created] = await tx
        .insert(gitea)
        .values({ ...credentials, gitProviderId: provider.gitProviderId })
        .returning();
      return sanitize(created, provider);
    });
  }

  /**
   * Every connection in the organization, newest first, secrets stripped.
   * Deliberately unfiltered: the listing is the only place a giteaId is
   * produced, so filtering out a connection whose OAuth application is not
   * stored yet would make it unreachable by findOne and update. Whether a
   * connection can actually clone is asked at use.
   */
  async list(ctx: PermissionCtx): Promise<SanitizedGitea[]> {
    const rows = await this.db
      .select()
      .from(gitea)
      .innerJoin(
        gitProvider,
        eq(gitea.gitProviderId, gitProvider.gitProviderId),
      )
      .where(eq(gitProvider.organizationId, ctx.session.activeOrganizationId))
      .orderBy(desc(gitProvider.createdAt));
    return rows.map((r) => sanitize(r.gitea, r.git_provider));
  }

  /** One connection by id — only visible inside its organization. */
  async findOne(ctx: PermissionCtx, giteaId: string): Promise<SanitizedGitea> {
    const { row, provider } = await this.findRow(ctx, giteaId);
    return sanitize(row, provider);
  }

  /**
   * Renames the base provider row and updates the credential fields together,
   * org-scoped through findRow.
   */
  async update(
    ctx: PermissionCtx,
    giteaId: string,
    data: UpdateGiteaDto,
  ): Promise<SanitizedGitea> {
    const current = await this.findRow(ctx, giteaId);
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
          .update(gitea)
          .set(credentials)
          .where(eq(gitea.giteaId, current.row.giteaId))
          .returning();
      }
      return sanitize(row, provider);
    });
  }

  /** The full gitea row + base provider, org-scoped through the join. */
  private async findRow(
    ctx: PermissionCtx,
    giteaId: string,
  ): Promise<{ row: Gitea; provider: GitProvider }> {
    const [found] = await this.db
      .select()
      .from(gitea)
      .innerJoin(
        gitProvider,
        eq(gitea.gitProviderId, gitProvider.gitProviderId),
      )
      .where(
        and(
          eq(gitea.giteaId, giteaId),
          eq(gitProvider.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Gitea provider not found');
    return { row: found.gitea, provider: found.git_provider };
  }
}
