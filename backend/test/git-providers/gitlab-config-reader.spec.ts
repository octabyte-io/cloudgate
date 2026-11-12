import type { DrizzleDB } from '../../src/db/drizzle.module';
import { passThroughGuard } from '../outbound/pass-through-guard';
import type { Gitlab } from '../../src/db/schema';
import type { FetchClient } from '../../src/git-providers/fetch.provider';
import { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import { GitlabConfigReader } from '../../src/project-config/reader/gitlab-config-reader';

// The GitLab API is the system boundary: the fetch client is stubbed with the
// shapes GitLab's REST API v4 answers (recorded from `GET /projects/:id`,
// `GET /projects/:id/repository/branches/:branch` and
// `GET /projects/:id/repository/files/:file_path?ref=`), and the connection
// row the reader looks up is the database's, stubbed the same way.
const db = {} as DrizzleDB;

const row: Gitlab = {
  gitlabId: 'gl-1',
  gitlabUrl: 'https://gitlab.example.com',
  gitlabInternalUrl: 'http://gitlab.internal:8080/',
  applicationId: 'gitlab-application-id',
  redirectUri: null,
  secret: 'gitlab-oauth-secret',
  accessToken: 'glpat-access',
  refreshToken: 'glrt-refresh',
  groupName: null,
  expiresAt: 4102444800, // 2100-01-01: no refresh needed
  gitProviderId: 'gp-1',
};

const request = {
  connection: { gitProviderId: 'gp-1', providerType: 'gitlab' as const },
  repository: 'acme/platform/shop',
  path: 'cloudgate.yaml',
  ref: null,
};

const CONFIG = 'version: 1\nservices:\n  cache:\n    kind: redis\n';

const PROJECT = {
  id: 42,
  name: 'shop',
  path: 'shop',
  path_with_namespace: 'acme/platform/shop',
  default_branch: 'trunk',
  visibility: 'private',
  web_url: 'https://gitlab.example.com/acme/platform/shop',
  namespace: {
    id: 7,
    path: 'platform',
    full_path: 'acme/platform',
    kind: 'group',
  },
};

function branch(name: string, sha: string) {
  return {
    name,
    merged: false,
    protected: true,
    default: name === 'trunk',
    commit: {
      id: sha,
      short_id: sha.slice(0, 8),
      title: 'Describe the shop',
      web_url: `https://gitlab.example.com/acme/platform/shop/-/commit/${sha}`,
    },
    web_url: `https://gitlab.example.com/acme/platform/shop/-/tree/${name}`,
  };
}

function file(path: string, sha: string, text: string) {
  return {
    file_name: path.split('/').pop(),
    file_path: path,
    size: text.length,
    encoding: 'base64',
    content: Buffer.from(text).toString('base64'),
    content_sha256: 'c4a1',
    ref: sha,
    blob_id: 'blob-id',
    commit_id: sha,
    last_commit_id: sha,
    execute_filemode: false,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** GitLab's own 404 body. */
const notFound = (what: string) =>
  json({ message: `404 ${what} Not Found` }, 404);

/** A fetch stub answering by path (after the base URL), recording each call. */
function readerWith(
  routes: Record<string, () => Response>,
  found: Gitlab | null = row,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const path = String(url).replace('http://gitlab.internal:8080', '');
    const route = routes[path];
    return Promise.resolve(
      route ? route() : json({ message: 'unexpected' }, 500),
    );
  }) as FetchClient;
  const gitlab = new GitlabService(db, fetch, passThroughGuard);
  jest.spyOn(gitlab, 'findByGitProviderId').mockResolvedValue(found);
  return { reader: new GitlabConfigReader(gitlab), calls };
}

const PROJECT_PATH = '/api/v4/projects/acme%2Fplatform%2Fshop';

describe('GitlabConfigReader', () => {
  it("reads the file on the project's default branch at that branch's head commit, with the connection's token", async () => {
    const { reader, calls } = readerWith({
      [PROJECT_PATH]: () => json(PROJECT),
      '/api/v4/projects/42/repository/branches/trunk': () =>
        json(branch('trunk', 'c0ffee1')),
      '/api/v4/projects/42/repository/files/cloudgate.yaml?ref=c0ffee1': () =>
        json(file('cloudgate.yaml', 'c0ffee1', CONFIG)),
    });

    const read = await reader.read(request);

    expect(read).toEqual({
      ok: true,
      text: CONFIG,
      commitSha: 'c0ffee1',
      branch: 'trunk',
      fileUrl:
        'https://gitlab.example.com/acme/platform/shop/-/blob/c0ffee1/cloudgate.yaml',
    });
    // The file is read at the commit, so the text is that commit's.
    expect(calls.map((call) => call.url)).toEqual([
      `http://gitlab.internal:8080${PROJECT_PATH}`,
      'http://gitlab.internal:8080/api/v4/projects/42/repository/branches/trunk',
      'http://gitlab.internal:8080/api/v4/projects/42/repository/files/cloudgate.yaml?ref=c0ffee1',
    ]);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get('authorization')).toBe(
        'Bearer glpat-access',
      );
    }
  });

  it('reads the named branch and a nested path, encoding both', async () => {
    const { reader } = readerWith({
      [PROJECT_PATH]: () => json(PROJECT),
      '/api/v4/projects/42/repository/branches/release%2F2': () =>
        json(branch('release/2', 'beef002')),
      '/api/v4/projects/42/repository/files/deploy%2Fcloudgate.yaml?ref=beef002':
        () => json(file('deploy/cloudgate.yaml', 'beef002', CONFIG)),
    });

    const read = await reader.read({
      ...request,
      path: 'deploy/cloudgate.yaml',
      ref: 'release/2',
    });

    expect(read).toMatchObject({
      ok: true,
      text: CONFIG,
      commitSha: 'beef002',
      branch: 'release/2',
    });
  });

  it('refuses a project the connection cannot see, naming it', async () => {
    const { reader, calls } = readerWith({
      [PROJECT_PATH]: () => notFound('Project'),
    });

    const read = await reader.read({ ...request, ref: 'staging' });

    expect(read).toEqual({
      ok: false,
      reason: 'repository-unreachable',
      branch: 'staging',
      message: expect.stringContaining('acme/platform/shop') as string,
    });
    expect(calls).toHaveLength(1);
  });

  it('refuses a branch the project does not have, naming the repository and branch', async () => {
    const { reader } = readerWith({
      [PROJECT_PATH]: () => json(PROJECT),
      '/api/v4/projects/42/repository/branches/staging': () =>
        notFound('Branch'),
    });

    const read = await reader.read({ ...request, ref: 'staging' });

    expect(read).toMatchObject({
      ok: false,
      reason: 'branch-missing',
      branch: 'staging',
    });
    expect(read.ok ? '' : read.message).toMatch(
      /acme\/platform\/shop.*staging/,
    );
  });

  it('refuses a path with no file on the branch, naming the path', async () => {
    const { reader } = readerWith({
      [PROJECT_PATH]: () => json(PROJECT),
      '/api/v4/projects/42/repository/branches/trunk': () =>
        json(branch('trunk', 'c0ffee1')),
      '/api/v4/projects/42/repository/files/cloudgate.yaml?ref=c0ffee1': () =>
        notFound('File'),
    });

    const read = await reader.read(request);

    expect(read).toMatchObject({
      ok: false,
      reason: 'file-missing',
      branch: 'trunk',
    });
    expect(read.ok ? '' : read.message).toMatch(
      /cloudgate\.yaml.*acme\/platform\/shop.*trunk/,
    );
  });

  it('refuses a provider that does not answer as an unreachable repository', async () => {
    const { reader } = readerWith({
      [PROJECT_PATH]: () => json({ message: '401 Unauthorized' }, 401),
    });

    const read = await reader.read(request);

    expect(read).toMatchObject({
      ok: false,
      reason: 'repository-unreachable',
      branch: null,
    });
    expect(read.ok ? '' : read.message).toContain('401');
  });

  it('refuses a connection whose token cannot be refreshed as an unreachable repository', async () => {
    const { reader } = readerWith(
      { '/oauth/token': () => json({ error: 'invalid_grant' }, 400) },
      { ...row, expiresAt: 1 },
    );

    const read = await reader.read(request);

    expect(read).toMatchObject({ ok: false, reason: 'repository-unreachable' });
  });

  it('refuses a connection that is gone without calling GitLab', async () => {
    const { reader, calls } = readerWith({}, null);

    const read = await reader.read(request);

    expect(read).toMatchObject({ ok: false, reason: 'repository-unreachable' });
    expect(calls).toEqual([]);
  });
});
