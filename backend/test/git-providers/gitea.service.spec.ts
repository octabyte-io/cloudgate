import type { DrizzleDB } from '../../src/db/drizzle.module';
import { passThroughGuard } from '../outbound/pass-through-guard';
import { selfHostedOwnAddresses } from '../outbound/self-hosted-own-addresses';
import type { Gitea } from '../../src/db/schema';
import type { FetchClient } from '../../src/git-providers/fetch.provider';
import { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import { BadRequestException } from '@nestjs/common';
import {
  OUTBOUND_ADDRESS_REFUSED_CODE,
  OutboundAddressGuard,
} from '../../src/outbound/outbound-address-guard';

// The Gitea API is a system boundary: unit tests swap the fetch client for
// a stub and drive the service through its public methods only.
const db = {} as DrizzleDB;

const connectedRow: Gitea = {
  giteaId: 'gt-1',
  giteaUrl: 'https://gitea.example.com',
  giteaInternalUrl: null,
  redirectUri: null,
  clientId: 'gitea-client-id',
  clientSecret: 'gitea-client-secret',
  accessToken: 'gta-old-access',
  refreshToken: 'gtr-old-refresh',
  expiresAt: 4102444800, // 2100-01-01: comfortably fresh
  scopes: 'repo,repo:status,read:user,read:org',
  lastAuthenticatedAt: null,
  gitProviderId: 'gp-1',
};

/** A fetch stub that records calls and replies from a fixed script. */
function fetchStub(
  responses: Array<Partial<Response> & { json?: () => Promise<unknown> }>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let call = 0;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: () => Promise.resolve({}),
      ...response,
    } as Response);
  }) as FetchClient;
  return { fetch, calls };
}

const persistingDb = (persisted: unknown[]) =>
  ({
    update: () => ({
      set: (values: Record<string, unknown>) => {
        persisted.push(values);
        return {
          where: () => ({
            returning: () => Promise.resolve([{ ...connectedRow, ...values }]),
          }),
        };
      },
    }),
  }) as unknown as DrizzleDB;

describe('GiteaService.refreshToken', () => {
  it('returns the row untouched while the access token is still fresh, without calling Gitea', async () => {
    const fetch = jest.fn() as unknown as FetchClient;
    const service = new GiteaService(db, fetch, passThroughGuard);

    const row = await service.refreshToken(connectedRow);

    expect(row).toEqual(connectedRow);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes an expired token via the oauth endpoint and persists the new pair', async () => {
    const { fetch, calls } = fetchStub([
      {
        json: () =>
          Promise.resolve({
            access_token: 'gta-new-access',
            refresh_token: 'gtr-new-refresh',
            expires_in: 3600,
          }),
      },
    ]);
    const persisted: unknown[] = [];
    const service = new GiteaService(
      persistingDb(persisted),
      fetch,
      passThroughGuard,
    );

    const before = Math.floor(Date.now() / 1000);
    const row = await service.refreshToken({ ...connectedRow, expiresAt: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://gitea.example.com/login/oauth/access_token',
    );
    expect(calls[0].init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect((calls[0].init?.body as URLSearchParams).toString()).toBe(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'gtr-old-refresh',
        client_id: 'gitea-client-id',
        client_secret: 'gitea-client-secret',
      }).toString(),
    );

    expect(row.accessToken).toBe('gta-new-access');
    expect(row.refreshToken).toBe('gtr-new-refresh');
    expect(row.expiresAt).toBeGreaterThanOrEqual(before + 3600);
    expect(persisted).toHaveLength(1);
  });

  it('keeps the current token when Gitea rejects the refresh instead of failing the caller', async () => {
    const { fetch } = fetchStub([
      { ok: false, status: 401, statusText: 'Unauthorized' },
    ]);
    const service = new GiteaService(db, fetch, passThroughGuard);

    const row = await service.refreshToken({ ...connectedRow, expiresAt: 1 });

    expect(row).toEqual({ ...connectedRow, expiresAt: 1 });
  });

  it('skips the refresh entirely when the OAuth app credentials are incomplete', async () => {
    const fetch = jest.fn() as unknown as FetchClient;
    const service = new GiteaService(db, fetch, passThroughGuard);

    const row = await service.refreshToken({
      ...connectedRow,
      expiresAt: 1,
      refreshToken: null,
    });

    expect(row).toEqual({ ...connectedRow, expiresAt: 1, refreshToken: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('GiteaService.listRepositories', () => {
  it("maps the user's repositories and paginates while pages come back full", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      name: `repo-${i + 1}`,
      owner: { login: 'octabyte' },
      html_url: `https://gitea.example.com/octabyte/repo-${i + 1}`,
    }));
    const { fetch, calls } = fetchStub([
      { json: () => Promise.resolve(fullPage) },
      {
        json: () =>
          Promise.resolve([
            {
              id: 51,
              name: 'cloudgate',
              owner: { login: 'octabyte' },
              html_url: 'https://gitea.example.com/octabyte/cloudgate',
              default_branch: 'trunk',
            },
          ]),
      },
    ]);
    const service = new GiteaService(db, fetch, passThroughGuard);

    const repositories = await service.listRepositories(connectedRow);

    expect(calls.map((c) => c.url)).toEqual([
      'https://gitea.example.com/api/v1/user/repos?page=1&limit=50',
      'https://gitea.example.com/api/v1/user/repos?page=2&limit=50',
    ]);
    expect(calls[0].init).toMatchObject({
      headers: { Authorization: 'token gta-old-access' },
    });
    expect(repositories).toHaveLength(51);
    expect(repositories[50]).toEqual({
      id: 51,
      name: 'cloudgate',
      owner: 'octabyte',
      url: 'https://gitea.example.com/octabyte/cloudgate',
      defaultBranch: 'trunk',
    });
  });

  it('throws when Gitea rejects the listing', async () => {
    const { fetch } = fetchStub([
      { ok: false, status: 403, statusText: 'Forbidden' },
    ]);
    const service = new GiteaService(db, fetch, passThroughGuard);

    await expect(service.listRepositories(connectedRow)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('GiteaService.listBranches', () => {
  it('maps the branches of the addressed repository to our branch DTO', async () => {
    const { fetch, calls } = fetchStub([
      {
        json: () =>
          Promise.resolve([
            { name: 'main', commit: { id: 'abc123' } },
            { name: 'develop', commit: { id: 'def456' } },
          ]),
      },
    ]);
    const service = new GiteaService(db, fetch, passThroughGuard);

    const branches = await service.listBranches(connectedRow, {
      owner: 'octabyte',
      repo: 'cloudgate',
    });

    expect(calls[0].url).toBe(
      'https://gitea.example.com/api/v1/repos/octabyte/cloudgate/branches?page=1&limit=50',
    );
    expect(branches).toEqual([
      { name: 'main', commitSha: 'abc123' },
      { name: 'develop', commitSha: 'def456' },
    ]);
  });
});

describe("GiteaService, on where a connection's calls may be dialled", () => {
  /** A database whose one read answers which Organization owns the connection. */
  const ownedBy = (organizationId: string) =>
    ({
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ organizationId }]) }),
        }),
      }),
    }) as unknown as DrizzleDB;

  const guardFor = (owner: string) =>
    new OutboundAddressGuard(
      () =>
        Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' })),
      {
        instanceOrganizationId: () => Promise.resolve('org_instance'),
      } as never,
      ownedBy(owner),
      selfHostedOwnAddresses,
    );

  const internalRow: Gitea = {
    ...connectedRow,
    giteaInternalUrl: 'http://10.0.0.5:3000',
  };

  it("refuses a customer's internal URL, naming giteaInternalUrl, and calls nothing", async () => {
    const { fetch, calls } = fetchStub([{ json: () => Promise.resolve([]) }]);
    const service = new GiteaService(db, fetch, guardFor('org_customer'));

    const refused = await service.listRepositories(internalRow).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(BadRequestException);
    expect((refused as BadRequestException).getResponse()).toMatchObject({
      code: OUTBOUND_ADDRESS_REFUSED_CODE,
      field: 'giteaInternalUrl',
    });
    // Nothing was dialled on the way to being refused.
    expect(calls).toEqual([]);
  });

  it("calls the instance organization's Gitea on its internal URL", async () => {
    const { fetch, calls } = fetchStub([{ json: () => Promise.resolve([]) }]);
    const service = new GiteaService(db, fetch, guardFor('org_instance'));

    await service.listRepositories(internalRow);

    expect(calls.map((call) => call.url)).toEqual([
      'http://10.0.0.5:3000/api/v1/user/repos?page=1&limit=50',
    ]);
  });
});
