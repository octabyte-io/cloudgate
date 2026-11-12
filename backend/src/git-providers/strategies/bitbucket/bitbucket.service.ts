import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../../db/drizzle.module';
import type { DrizzleDB } from '../../../db/drizzle.module';
import { bitbucket, gitProvider } from '../../../db/schema';
import type { Bitbucket, GitProvider } from '../../../db/schema';
import type { PermissionCtx } from '../../../rbac/permission.service';
import { FETCH_CLIENT } from '../../fetch.provider';
import type { FetchClient } from '../../fetch.provider';
import type {
  BitbucketBranchDto,
  BitbucketRepositoryDto,
  CreateBitbucketDto,
  FindBitbucketBranchesDto,
  UpdateBitbucketDto,
} from './dto/bitbucket.dto';

/**
 * A Bitbucket connection as exposed over the API — the app password and API
 * token never leave the server.
 */
export type SanitizedBitbucket = Omit<Bitbucket, 'appPassword' | 'apiToken'> & {
  gitProvider: GitProvider;
};

function sanitize(row: Bitbucket, provider: GitProvider): SanitizedBitbucket {
  const { appPassword, apiToken, ...rest } = row;
  void appPassword;
  void apiToken;
  return { ...rest, gitProvider: provider };
}

type BitbucketCredentials = Pick<
  Bitbucket,
  'bitbucketUsername' | 'bitbucketEmail' | 'appPassword' | 'apiToken'
>;

/**
 * Basic auth from whichever credential style the connection carries: an
 * Atlassian API token authenticates as {account email}:{token}, an app password
 * as {username}:{app password}.
 */
export function bitbucketAuthHeaders(row: BitbucketCredentials): {
  Authorization: string;
} {
  if (row.apiToken) {
    if (!row.bitbucketEmail) {
      throw new BadRequestException(
        'Atlassian account email is required when using an API token',
      );
    }
    return {
      Authorization: `Basic ${Buffer.from(
        `${row.bitbucketEmail}:${row.apiToken}`,
      ).toString('base64')}`,
    };
  }
  if (!row.bitbucketUsername || !row.appPassword) {
    throw new BadRequestException(
      'Username and app password are required when not using an API token',
    );
  }
  return {
    Authorization: `Basic ${Buffer.from(
      `${row.bitbucketUsername}:${row.appPassword}`,
    ).toString('base64')}`,
  };
}

const API_BASE = 'https://api.bitbucket.org/2.0';

@Injectable()
export class BitbucketService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(FETCH_CLIENT) private readonly fetch: FetchClient,
  ) {}

  /**
   * The repositories of the configured workspace (falling back to the user's
   * own), mapped to our DTO.
   */
  async listRepositories(row: Bitbucket): Promise<BitbucketRepositoryDto[]> {
    const account = row.bitbucketWorkspaceName || row.bitbucketUsername;
    const repositories = await this.fetchAllPages<{
      name: string;
      slug: string;
      links: { html: { href: string } };
      workspace: { slug: string };
      mainbranch?: { name: string } | null;
    }>(row, `${API_BASE}/repositories/${account}?pagelen=100`);
    return repositories.map((repository) => ({
      name: repository.name,
      slug: repository.slug,
      owner: repository.workspace.slug,
      url: repository.links.html.href,
      defaultBranch: repository.mainbranch?.name ?? null,
    }));
  }

  /** The branches of one repository. */
  async listBranches(
    row: Bitbucket,
    { owner, repo }: FindBitbucketBranchesDto,
  ): Promise<BitbucketBranchDto[]> {
    const branches = await this.fetchAllPages<{
      name: string;
      target: { hash: string };
    }>(
      row,
      `${API_BASE}/repositories/${owner}/${repo}/refs/branches?pagelen=100`,
    );
    return branches.map((branch) => ({
      name: branch.name,
      commitSha: branch.target.hash,
    }));
  }

  /** listRepositories for a connection addressed by id, org-scoped. */
  async listRepositoriesFor(
    ctx: PermissionCtx,
    bitbucketId: string,
  ): Promise<BitbucketRepositoryDto[]> {
    const { row } = await this.findRow(ctx, bitbucketId);
    return this.listRepositories(row);
  }

  /** listBranches for a connection addressed by id, org-scoped. */
  async listBranchesFor(
    ctx: PermissionCtx,
    bitbucketId: string,
    params: FindBitbucketBranchesDto,
  ): Promise<BitbucketBranchDto[]> {
    const { row } = await this.findRow(ctx, bitbucketId);
    return this.listBranches(row, params);
  }

  /**
   * The connection row behind a base `git_provider` id, deliberately
   * not org-scoped: the caller resolved the id inside its organization when
   * it stored it. `null` when the connection is gone.
   */
  async findByGitProviderId(gitProviderId: string): Promise<Bitbucket | null> {
    const [found] = await this.db
      .select()
      .from(bitbucket)
      .where(eq(bitbucket.gitProviderId, gitProviderId))
      .limit(1);
    return found ?? null;
  }

  /**
   * One authenticated GET of the REST API (`path` from `/2.0`), answered as
   * Bitbucket answered it, for a caller that reads statuses itself (the
   * config reader). Rejects a connection with incomplete credentials.
   */
  async get(row: Bitbucket, path: string): Promise<Response> {
    return this.fetch(`${API_BASE}${path}`, {
      headers: bitbucketAuthHeaders(row),
    });
  }

  /** Pages through a Bitbucket collection by following its `next` links. */
  private async fetchAllPages<T>(
    row: Bitbucket,
    firstUrl: string,
  ): Promise<T[]> {
    const headers = bitbucketAuthHeaders(row);
    const all: T[] = [];
    let url: string | null = firstUrl;
    while (url) {
      const response = await this.fetch(url, { headers });
      if (!response.ok) {
        throw new BadRequestException(
          `Failed to fetch from Bitbucket: ${response.statusText}`,
        );
      }
      const data = (await response.json()) as {
        values: T[];
        next: string | null;
      };
      all.push(...data.values);
      url = data.next || null;
    }
    return all;
  }

  /**
   * Create the base gitProvider row and the bitbucket detail row in one
   * transaction, in the session's active organization.
   */
  async create(
    ctx: PermissionCtx,
    data: CreateBitbucketDto,
  ): Promise<SanitizedBitbucket> {
    const { name, ...credentials } = data;
    return this.db.transaction(async (tx) => {
      const [provider] = await tx
        .insert(gitProvider)
        .values({
          name,
          providerType: 'bitbucket',
          organizationId: ctx.session.activeOrganizationId,
        })
        .returning();
      const [created] = await tx
        .insert(bitbucket)
        .values({ ...credentials, gitProviderId: provider.gitProviderId })
        .returning();
      return sanitize(created, provider);
    });
  }

  /**
   * The organization's connections, newest first, secrets stripped. Basic-auth
   * credentials have no OAuth callback to wait for, so no requirements filter
   * applies.
   */
  async list(ctx: PermissionCtx): Promise<SanitizedBitbucket[]> {
    const rows = await this.db
      .select()
      .from(bitbucket)
      .innerJoin(
        gitProvider,
        eq(bitbucket.gitProviderId, gitProvider.gitProviderId),
      )
      .where(eq(gitProvider.organizationId, ctx.session.activeOrganizationId))
      .orderBy(desc(gitProvider.createdAt));
    return rows.map((r) => sanitize(r.bitbucket, r.git_provider));
  }

  /** One connection by id — only visible inside its organization. */
  async findOne(
    ctx: PermissionCtx,
    bitbucketId: string,
  ): Promise<SanitizedBitbucket> {
    const { row, provider } = await this.findRow(ctx, bitbucketId);
    return sanitize(row, provider);
  }

  /**
   * Renames the base provider row and updates the credential fields together,
   * org-scoped through findRow.
   */
  async update(
    ctx: PermissionCtx,
    bitbucketId: string,
    data: UpdateBitbucketDto,
  ): Promise<SanitizedBitbucket> {
    const current = await this.findRow(ctx, bitbucketId);
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
          .update(bitbucket)
          .set(credentials)
          .where(eq(bitbucket.bitbucketId, current.row.bitbucketId))
          .returning();
      }
      return sanitize(row, provider);
    });
  }

  /** The full bitbucket row + base provider, org-scoped through the join. */
  private async findRow(
    ctx: PermissionCtx,
    bitbucketId: string,
  ): Promise<{ row: Bitbucket; provider: GitProvider }> {
    const [found] = await this.db
      .select()
      .from(bitbucket)
      .innerJoin(
        gitProvider,
        eq(bitbucket.gitProviderId, gitProvider.gitProviderId),
      )
      .where(
        and(
          eq(bitbucket.bitbucketId, bitbucketId),
          eq(gitProvider.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Bitbucket provider not found');
    return { row: found.bitbucket, provider: found.git_provider };
  }
}
