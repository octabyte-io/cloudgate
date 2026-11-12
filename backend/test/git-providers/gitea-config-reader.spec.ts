import type { DrizzleDB } from '../../src/db/drizzle.module';
import { passThroughGuard } from '../outbound/pass-through-guard';
import type { Gitea } from '../../src/db/schema';
import type { FetchClient } from '../../src/git-providers/fetch.provider';
import { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import { GiteaConfigReader } from '../../src/project-config/reader/gitea-config-reader';

// The Gitea API is the system boundary: the fetch client is stubbed with the
// shapes Gitea's REST API v1 answers (recorded from
// `GET /repos/{owner}/{repo}`, `GET /repos/{owner}/{repo}/branches/{branch}`
// and `GET /repos/{owner}/{repo}/contents/{filepath}?ref=`), and the
// connection row the reader looks up is the database's, stubbed the same way.
const db = {} as DrizzleDB;

const row: Gitea = {
  giteaId: 'gt-1',
  giteaUrl: 'https://gitea.example.com',
  giteaInternalUrl: null,
  redirectUri: null,
  clientId: 'gitea-client-id',
  clientSecret: 'gitea-client-secret',
  accessToken: 'gta-access',
  refreshToken: 'gtr-refresh',
  expiresAt: 4102444800, // 2100-01-01: no refresh needed
  scopes: 'repo,repo:status,read:user,read:org',
  lastAuthenticatedAt: null,
  gitProviderId: 'gp-1',
};

const request = {
  connection: { gitProviderId: 'gp-1', providerType: 'gitea' as const },
  repository: 'acme/shop',
  path: 'cloudgate.yaml',
  ref: null,
};

const CONFIG = 'version: 1\nservices:\n  cache:\n    kind: redis\n';

const REPOSITORY = {
  id: 3,
  name: 'shop',
  full_name: 'acme/shop',
  owner: { id: 1, login: 'acme' },
  private: true,
  empty: false,
  html_url: 'https://gitea.example.com/acme/shop',
  default_branch: 'trunk',
};

function branch(name: string, sha: string) {
  return {
    name,
    commit: {
      id: sha,
      message: 'Describe the shop\n',
      url: `https://gitea.example.com/acme/shop/commit/${sha}`,
    },
    protected: false,
  };
}

function contents(path: string, sha: string, text: string) {
  return {
    name: path.split('/').pop(),
    path,
    sha: 'blob-sha',
    last_commit_sha: sha,
    type: 'file',
    size: text.length,
    encoding: 'base64',
    content: Buffer.from(text).toString('base64'),
    html_url: `https://gitea.example.com/acme/shop/src/commit/${sha}/${path}`,
    download_url: `https://gitea.example.com/acme/shop/raw/commit/${sha}/${path}`,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Gitea's own 404 body. */
const notFound = () =>
  json(
    {
      errors: ['object does not exist'],
      message: "The target couldn't be found.",
      url: 'https://gitea.example.com/api/swagger',
    },
    404,
  );

function readerWith(
  routes: Record<string, () => Response>,
  found: Gitea | null = row,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const route = routes[String(url).replace('https://gitea.example.com', '')];
    return Promise.resolve(
      route ? route() : json({ message: 'unexpected' }, 500),
    );
  }) as FetchClient;
  const gitea = new GiteaService(db, fetch, passThroughGuard);
  jest.spyOn(gitea, 'findByGitProviderId').mockResolvedValue(found);
  return { reader: new GiteaConfigReader(gitea), calls };
}

describe('GiteaConfigReader', () => {
  it("reads the file on the repository's default branch at that branch's head commit, with the connection's token", async () => {
    const { reader, calls } = readerWith({
      '/api/v1/repos/acme/shop': () => json(REPOSITORY),
      '/api/v1/repos/acme/shop/branches/trunk': () =>
        json(branch('trunk', 'c0ffee1')),
      '/api/v1/repos/acme/shop/contents/cloudgate.yaml?ref=c0ffee1': () =>
        json(contents('cloudgate.yaml', 'c0ffee1', CONFIG)),
    });

    const read = await reader.read(request);

    expect(read).toEqual({
      ok: true,
      text: CONFIG,
      commitSha: 'c0ffee1',
      branch: 'trunk',
      fileUrl:
        'https://gitea.example.com/acme/shop/src/commit/c0ffee1/cloudgate.yaml',
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://gitea.example.com/api/v1/repos/acme/shop',
      'https://gitea.example.com/api/v1/repos/acme/shop/branches/trunk',
      'https://gitea.example.com/api/v1/repos/acme/shop/contents/cloudgate.yaml?ref=c0ffee1',
    ]);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get('authorization')).toBe(
        'token gta-access',
      );
    }
  });

  it('reads the named branch and a nested path', async () => {
    const { reader } = readerWith({
      '/api/v1/repos/acme/shop': () => json(REPOSITORY),
      '/api/v1/repos/acme/shop/branches/release/2': () =>
        json(branch('release/2', 'beef002')),
      '/api/v1/repos/acme/shop/contents/deploy/cloudgate.yaml?ref=beef002':
        () => json(contents('deploy/cloudgate.yaml', 'beef002', CONFIG)),
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

  it('refuses a repository the connection cannot see, naming it', async () => {
    const { reader, calls } = readerWith({
      '/api/v1/repos/acme/shop': notFound,
    });

    const read = await reader.read({ ...request, ref: 'staging' });

    expect(read).toEqual({
      ok: false,
      reason: 'repository-unreachable',
      branch: 'staging',
      message: expect.stringContaining('acme/shop') as string,
    });
    expect(calls).toHaveLength(1);
  });

  it('refuses a branch the repository does not have, naming the repository and branch', async () => {
    const { reader } = readerWith({
      '/api/v1/repos/acme/shop': () => json(REPOSITORY),
      '/api/v1/repos/acme/shop/branches/staging': notFound,
    });

    const read = await reader.read({ ...request, ref: 'staging' });

    expect(read).toMatchObject({
      ok: false,
      reason: 'branch-missing',
      branch: 'staging',
    });
    expect(read.ok ? '' : read.message).toMatch(/acme\/shop.*staging/);
  });

  it('refuses a path with no file on the branch, naming the path', async () => {
    const { reader } = readerWith({
      '/api/v1/repos/acme/shop': () => json(REPOSITORY),
      '/api/v1/repos/acme/shop/branches/trunk': () =>
        json(branch('trunk', 'c0ffee1')),
      '/api/v1/repos/acme/shop/contents/cloudgate.yaml?ref=c0ffee1': notFound,
    });

    const read = await reader.read(request);

    expect(read).toMatchObject({
      ok: false,
      reason: 'file-missing',
      branch: 'trunk',
    });
    expect(read.ok ? '' : read.message).toMatch(
      /cloudgate\.yaml.*acme\/shop.*trunk/,
    );
  });

  it('refuses a path that names a directory as a missing file', async () => {
    const { reader } = readerWith({
      '/api/v1/repos/acme/shop': () => json(REPOSITORY),
      '/api/v1/repos/acme/shop/branches/trunk': () =>
        json(branch('trunk', 'c0ffee1')),
      // Gitea answers a directory's listing as an array.
      '/api/v1/repos/acme/shop/contents/deploy?ref=c0ffee1': () =>
        json([
          {
            ...contents('deploy/cloudgate.yaml', 'c0ffee1', CONFIG),
            content: null,
            encoding: null,
          },
        ]),
    });

    const read = await reader.read({ ...request, path: 'deploy' });

    expect(read).toMatchObject({ ok: false, reason: 'file-missing' });
  });

  it('refuses a provider that does not answer as an unreachable repository', async () => {
    const { reader } = readerWith({
      '/api/v1/repos/acme/shop': () =>
        json({ message: 'token is required' }, 401),
    });

    const read = await reader.read(request);

    expect(read).toMatchObject({
      ok: false,
      reason: 'repository-unreachable',
      branch: null,
    });
    expect(read.ok ? '' : read.message).toContain('401');
  });

  it('refuses a connection that is gone without calling Gitea', async () => {
    const { reader, calls } = readerWith({}, null);

    const read = await reader.read(request);

    expect(read).toMatchObject({ ok: false, reason: 'repository-unreachable' });
    expect(calls).toEqual([]);
  });
});
