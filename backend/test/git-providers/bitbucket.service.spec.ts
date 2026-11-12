import { BadRequestException } from '@nestjs/common';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { Bitbucket } from '../../src/db/schema';
import type { FetchClient } from '../../src/git-providers/fetch.provider';
import { BitbucketService } from '../../src/git-providers/strategies/bitbucket/bitbucket.service';

// The Bitbucket API is a system boundary: unit tests swap the fetch client
// for a stub and drive the service through its public methods only.
const db = {} as DrizzleDB;

const connectedRow: Bitbucket = {
  bitbucketId: 'bb-1',
  bitbucketUsername: 'grace',
  bitbucketEmail: 'grace@example.com',
  appPassword: 'bb-app-password',
  apiToken: 'bb-api-token',
  bitbucketWorkspaceName: 'octabyte',
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

const cloudgateRepo = {
  name: 'cloudgate',
  slug: 'cloudgate',
  links: { html: { href: 'https://bitbucket.org/octabyte/cloudgate' } },
  workspace: { slug: 'octabyte' },
};

describe('BitbucketService.listRepositories', () => {
  it('authenticates with email + API token, addresses the workspace and follows pagination', async () => {
    const nextUrl =
      'https://api.bitbucket.org/2.0/repositories/octabyte?pagelen=100&page=2';
    const { fetch, calls } = fetchStub([
      {
        json: () =>
          Promise.resolve({
            values: [{ ...cloudgateRepo, mainbranch: { name: 'main' } }],
            next: nextUrl,
          }),
      },
      {
        json: () =>
          Promise.resolve({
            values: [{ ...cloudgateRepo, name: 'shop', slug: 'shop' }],
            next: null,
          }),
      },
    ]);
    const service = new BitbucketService(db, fetch);

    const repositories = await service.listRepositories(connectedRow);

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.bitbucket.org/2.0/repositories/octabyte?pagelen=100',
      nextUrl,
    ]);
    // Bitbucket API tokens authenticate as {atlassian email}:{token}.
    const basic = Buffer.from('grace@example.com:bb-api-token').toString(
      'base64',
    );
    expect(calls[0].init).toMatchObject({
      headers: { Authorization: `Basic ${basic}` },
    });
    expect(repositories).toEqual([
      {
        name: 'cloudgate',
        slug: 'cloudgate',
        owner: 'octabyte',
        url: 'https://bitbucket.org/octabyte/cloudgate',
        defaultBranch: 'main',
      },
      {
        name: 'shop',
        slug: 'shop',
        owner: 'octabyte',
        url: 'https://bitbucket.org/octabyte/cloudgate',
        defaultBranch: null,
      },
    ]);
  });

  it('falls back to username + app password auth and the username path without an API token or workspace', async () => {
    const { fetch, calls } = fetchStub([
      { json: () => Promise.resolve({ values: [cloudgateRepo], next: null }) },
    ]);
    const service = new BitbucketService(db, fetch);

    await service.listRepositories({
      ...connectedRow,
      apiToken: null,
      bitbucketWorkspaceName: null,
    });

    expect(calls[0].url).toBe(
      'https://api.bitbucket.org/2.0/repositories/grace?pagelen=100',
    );
    const basic = Buffer.from('grace:bb-app-password').toString('base64');
    expect(calls[0].init).toMatchObject({
      headers: { Authorization: `Basic ${basic}` },
    });
  });

  it('rejects an API token without the Atlassian account email', async () => {
    const fetch = jest.fn() as unknown as FetchClient;
    const service = new BitbucketService(db, fetch);

    await expect(
      service.listRepositories({ ...connectedRow, bitbucketEmail: null }),
    ).rejects.toThrow(BadRequestException);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a connection with neither an API token nor username + app password', async () => {
    const fetch = jest.fn() as unknown as FetchClient;
    const service = new BitbucketService(db, fetch);

    await expect(
      service.listRepositories({
        ...connectedRow,
        apiToken: null,
        appPassword: null,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws when Bitbucket rejects the listing', async () => {
    const { fetch } = fetchStub([
      { ok: false, status: 403, statusText: 'Forbidden' },
    ]);
    const service = new BitbucketService(db, fetch);

    await expect(service.listRepositories(connectedRow)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('BitbucketService.listBranches', () => {
  it('maps the branches of the addressed repository to our branch DTO', async () => {
    const { fetch, calls } = fetchStub([
      {
        json: () =>
          Promise.resolve({
            values: [
              { name: 'main', target: { hash: 'abc123' } },
              { name: 'develop', target: { hash: 'def456' } },
            ],
            next: null,
          }),
      },
    ]);
    const service = new BitbucketService(db, fetch);

    const branches = await service.listBranches(connectedRow, {
      owner: 'octabyte',
      repo: 'cloudgate',
    });

    expect(calls[0].url).toBe(
      'https://api.bitbucket.org/2.0/repositories/octabyte/cloudgate/refs/branches?pagelen=100',
    );
    expect(branches).toEqual([
      { name: 'main', commitSha: 'abc123' },
      { name: 'develop', commitSha: 'def456' },
    ]);
  });
});
