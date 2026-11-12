import { BadRequestException } from '@nestjs/common';
import { passThroughGuard } from '../outbound/pass-through-guard';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { Gitlab } from '../../src/db/schema';
import type { FetchClient } from '../../src/git-providers/fetch.provider';
import { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';

// The GitLab API is a system boundary: unit tests swap the fetch client for
// a stub and drive the service through its public methods only.
const db = {} as DrizzleDB;

const connectedRow: Gitlab = {
  gitlabId: 'gl-1',
  gitlabUrl: 'https://gitlab.example.com',
  gitlabInternalUrl: null,
  applicationId: 'gitlab-application-id',
  redirectUri: null,
  secret: 'gitlab-oauth-secret',
  accessToken: 'glpat-old-access',
  refreshToken: 'glrt-old-refresh',
  groupName: null,
  expiresAt: 4102444800, // 2100-01-01: comfortably fresh
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

describe('GitlabService.refreshToken', () => {
  it('returns the row untouched while the access token is still fresh, without calling GitLab', async () => {
    const fetch = jest.fn() as unknown as FetchClient;
    const service = new GitlabService(db, fetch, passThroughGuard);

    const row = await service.refreshToken(connectedRow);

    expect(row).toEqual(connectedRow);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes an expired token via the oauth token endpoint and persists the new pair', async () => {
    const { fetch, calls } = fetchStub([
      {
        json: () =>
          Promise.resolve({
            access_token: 'glpat-new-access',
            refresh_token: 'glrt-new-refresh',
            expires_in: 7200,
          }),
      },
    ]);
    const persisted: unknown[] = [];
    const dbStub = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          persisted.push(values);
          return {
            where: () => ({
              returning: () =>
                Promise.resolve([{ ...connectedRow, ...values }]),
            }),
          };
        },
      }),
    } as unknown as DrizzleDB;
    const service = new GitlabService(dbStub, fetch, passThroughGuard);

    const before = Math.floor(Date.now() / 1000);
    const row = await service.refreshToken({ ...connectedRow, expiresAt: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://gitlab.example.com/oauth/token');
    expect(calls[0].init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect((calls[0].init?.body as URLSearchParams).toString()).toBe(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'glrt-old-refresh',
        client_id: 'gitlab-application-id',
        client_secret: 'gitlab-oauth-secret',
      }).toString(),
    );

    expect(row.accessToken).toBe('glpat-new-access');
    expect(row.refreshToken).toBe('glrt-new-refresh');
    expect(row.expiresAt).toBeGreaterThanOrEqual(before + 7200);
    expect(persisted).toEqual([
      {
        accessToken: 'glpat-new-access',
        refreshToken: 'glrt-new-refresh',
        expiresAt: row.expiresAt,
      },
    ]);
  });

  it('reaches a self-hosted GitLab through its internal url when one is set', async () => {
    const { fetch, calls } = fetchStub([
      {
        json: () =>
          Promise.resolve({
            access_token: 'a',
            refresh_token: 'r',
            expires_in: 60,
          }),
      },
    ]);
    const dbStub = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: () => Promise.resolve([{ ...connectedRow, ...values }]),
          }),
        }),
      }),
    } as unknown as DrizzleDB;
    const service = new GitlabService(dbStub, fetch, passThroughGuard);

    await service.refreshToken({
      ...connectedRow,
      gitlabInternalUrl: 'http://gitlab.internal:8080',
      expiresAt: 1,
    });

    expect(calls[0].url).toBe('http://gitlab.internal:8080/oauth/token');
  });

  it('throws when GitLab rejects the refresh', async () => {
    const { fetch } = fetchStub([
      { ok: false, status: 401, statusText: 'Unauthorized' },
    ]);
    const service = new GitlabService(db, fetch, passThroughGuard);

    await expect(
      service.refreshToken({ ...connectedRow, expiresAt: 1 }),
    ).rejects.toThrow(BadRequestException);
  });
});

const graceProject = {
  id: 42,
  name: 'cloudgate',
  path_with_namespace: 'grace/cloudgate',
  namespace: { path: 'grace', full_path: 'grace', kind: 'user' },
  default_branch: 'main',
};
const octabyteProject = {
  id: 43,
  name: 'infra',
  path_with_namespace: 'octabyte/infra',
  namespace: { path: 'octabyte', full_path: 'octabyte', kind: 'group' },
};

describe('GitlabService.listRepositories', () => {
  it('maps the projects the user is a member of, keeping personal projects when no group is configured', async () => {
    const { fetch, calls } = fetchStub([
      {
        headers: new Headers({ 'x-total': '2' }),
        json: () => Promise.resolve([graceProject, octabyteProject]),
      },
    ]);
    const service = new GitlabService(db, fetch, passThroughGuard);

    const repositories = await service.listRepositories(connectedRow);

    expect(calls[0].url).toBe(
      'https://gitlab.example.com/api/v4/projects?membership=true&page=1&per_page=100',
    );
    expect(calls[0].init).toMatchObject({
      headers: { Authorization: 'Bearer glpat-old-access' },
    });
    expect(repositories).toEqual([
      {
        id: 42,
        name: 'cloudgate',
        owner: 'grace',
        pathNamespace: 'grace/cloudgate',
        defaultBranch: 'main',
      },
    ]);
  });

  it('keeps only projects under the configured comma-separated group names', async () => {
    const acmeProject = {
      id: 44,
      name: 'tools',
      path_with_namespace: 'acme/tools',
      namespace: { path: 'acme', full_path: 'acme', kind: 'group' },
    };
    const { fetch } = fetchStub([
      {
        headers: new Headers({ 'x-total': '3' }),
        json: () =>
          Promise.resolve([graceProject, octabyteProject, acmeProject]),
      },
    ]);
    const service = new GitlabService(db, fetch, passThroughGuard);

    const repositories = await service.listRepositories({
      ...connectedRow,
      groupName: 'octabyte, acme',
    });

    expect(repositories.map((r) => r.pathNamespace)).toEqual([
      'octabyte/infra',
      'acme/tools',
    ]);
  });

  it('follows pagination until the reported total is reached', async () => {
    const { fetch, calls } = fetchStub([
      {
        headers: new Headers({ 'x-total': '2' }),
        json: () => Promise.resolve([graceProject]),
      },
      {
        headers: new Headers({ 'x-total': '2' }),
        json: () =>
          Promise.resolve([
            { ...graceProject, id: 45, path_with_namespace: 'grace/blog' },
          ]),
      },
    ]);
    const service = new GitlabService(db, fetch, passThroughGuard);

    const repositories = await service.listRepositories(connectedRow);

    expect(calls.map((c) => c.url)).toEqual([
      'https://gitlab.example.com/api/v4/projects?membership=true&page=1&per_page=100',
      'https://gitlab.example.com/api/v4/projects?membership=true&page=2&per_page=100',
    ]);
    expect(repositories).toHaveLength(2);
  });

  it('refreshes an expired token before calling the API', async () => {
    const { fetch, calls } = fetchStub([
      {
        json: () =>
          Promise.resolve({
            access_token: 'glpat-new-access',
            refresh_token: 'glrt-new-refresh',
            expires_in: 7200,
          }),
      },
      { json: () => Promise.resolve([]) },
    ]);
    const dbStub = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: () => Promise.resolve([{ ...connectedRow, ...values }]),
          }),
        }),
      }),
    } as unknown as DrizzleDB;
    const service = new GitlabService(dbStub, fetch, passThroughGuard);

    const repositories = await service.listRepositories({
      ...connectedRow,
      expiresAt: 1,
    });

    expect(repositories).toEqual([]);
    expect(calls[0].url).toBe('https://gitlab.example.com/oauth/token');
    expect(calls[1].init).toMatchObject({
      headers: { Authorization: 'Bearer glpat-new-access' },
    });
  });

  it('throws when GitLab rejects the listing', async () => {
    const { fetch } = fetchStub([
      { ok: false, status: 403, statusText: 'Forbidden' },
    ]);
    const service = new GitlabService(db, fetch, passThroughGuard);

    await expect(service.listRepositories(connectedRow)).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('GitlabService.listBranches', () => {
  it('maps the branches of the addressed project to our branch DTO', async () => {
    const { fetch, calls } = fetchStub([
      {
        headers: new Headers({ 'x-total': '2' }),
        json: () =>
          Promise.resolve([
            { name: 'main', commit: { id: 'abc123' } },
            { name: 'develop', commit: { id: 'def456' } },
          ]),
      },
    ]);
    const service = new GitlabService(db, fetch, passThroughGuard);

    const branches = await service.listBranches(connectedRow, {
      projectId: 42,
    });

    expect(calls[0].url).toBe(
      'https://gitlab.example.com/api/v4/projects/42/repository/branches?page=1&per_page=100',
    );
    expect(branches).toEqual([
      { name: 'main', commitSha: 'abc123' },
      { name: 'develop', commitSha: 'def456' },
    ]);
  });
});
