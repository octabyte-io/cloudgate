import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { Bitbucket } from '../../src/db/schema';
import type { FetchClient } from '../../src/git-providers/fetch.provider';
import { BitbucketService } from '../../src/git-providers/strategies/bitbucket/bitbucket.service';
import { BitbucketConfigReader } from '../../src/project-config/reader/bitbucket-config-reader';

// The Bitbucket Cloud API is the system boundary: the fetch client is stubbed
// with the shapes its REST API 2.0 answers (recorded from
// `GET /repositories/{workspace}/{repo_slug}`, `…/refs/branches/{name}`,
// `…/src/{commit}/{path}?format=meta` and the raw `…/src/{commit}/{path}`),
// and the connection row the reader looks up is the database's, stubbed the
// same way.
const db = {} as DrizzleDB;

const row: Bitbucket = {
  bitbucketId: 'bb-1',
  bitbucketUsername: 'grace',
  bitbucketEmail: 'grace@example.com',
  appPassword: null,
  apiToken: 'bb-api-token',
  bitbucketWorkspaceName: 'acme',
  gitProviderId: 'gp-1',
};

const request = {
  connection: { gitProviderId: 'gp-1', providerType: 'bitbucket' as const },
  repository: 'acme/shop',
  path: 'cloudgate.yaml',
  ref: null,
};

const CONFIG = 'version: 1\nservices:\n  cache:\n    kind: redis\n';
const API = 'https://api.bitbucket.org/2.0/repositories/acme/shop';

const REPOSITORY = {
  type: 'repository',
  full_name: 'acme/shop',
  name: 'shop',
  slug: 'shop',
  is_private: true,
  scm: 'git',
  workspace: { type: 'workspace', slug: 'acme' },
  mainbranch: { type: 'branch', name: 'trunk' },
  links: { html: { href: 'https://bitbucket.org/acme/shop' } },
};

function branch(name: string, sha: string) {
  return {
    type: 'branch',
    name,
    target: {
      type: 'commit',
      hash: sha,
      message: 'Describe the shop\n',
      links: {
        html: { href: `https://bitbucket.org/acme/shop/commits/${sha}` },
      },
    },
    links: { html: { href: `https://bitbucket.org/acme/shop/branch/${name}` } },
  };
}

function meta(path: string, sha: string, type = 'commit_file') {
  return {
    type,
    path,
    commit: { type: 'commit', hash: sha },
    attributes: [],
    escaped_path: path,
    size: CONFIG.length,
    mimetype: null,
    links: {
      self: { href: `${API}/src/${sha}/${path}` },
      meta: { href: `${API}/src/${sha}/${path}?format=meta` },
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const raw = (text: string) =>
  new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });

/** Bitbucket's own 404 body. */
const notFound = (message: string) => () =>
  json({ type: 'error', error: { message } }, 404);

function readerWith(
  routes: Record<string, () => Response>,
  found: Bitbucket | null = row,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const route = routes[String(url).replace(API, '')];
    return Promise.resolve(
      route ? route() : json({ message: 'unexpected' }, 500),
    );
  }) as FetchClient;
  const bitbucket = new BitbucketService(db, fetch);
  jest.spyOn(bitbucket, 'findByGitProviderId').mockResolvedValue(found);
  return { reader: new BitbucketConfigReader(bitbucket), calls };
}

describe('BitbucketConfigReader', () => {
  it("reads the file on the repository's main branch at that branch's head commit, with the connection's credentials", async () => {
    const { reader, calls } = readerWith({
      '': () => json(REPOSITORY),
      '/refs/branches/trunk': () => json(branch('trunk', 'c0ffee1')),
      '/src/c0ffee1/cloudgate.yaml?format=meta': () =>
        json(meta('cloudgate.yaml', 'c0ffee1')),
      '/src/c0ffee1/cloudgate.yaml': () => raw(CONFIG),
    });

    const read = await reader.read(request);

    expect(read).toEqual({
      ok: true,
      text: CONFIG,
      commitSha: 'c0ffee1',
      branch: 'trunk',
      fileUrl: 'https://bitbucket.org/acme/shop/src/c0ffee1/cloudgate.yaml',
    });
    expect(calls.map((call) => call.url)).toEqual([
      API,
      `${API}/refs/branches/trunk`,
      `${API}/src/c0ffee1/cloudgate.yaml?format=meta`,
      `${API}/src/c0ffee1/cloudgate.yaml`,
    ]);
    const basic = `Basic ${Buffer.from('grace@example.com:bb-api-token').toString('base64')}`;
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get('authorization')).toBe(basic);
    }
  });

  it('reads the named branch and a nested path', async () => {
    const { reader } = readerWith({
      '': () => json(REPOSITORY),
      '/refs/branches/release/2': () => json(branch('release/2', 'beef002')),
      '/src/beef002/deploy/cloudgate.yaml?format=meta': () =>
        json(meta('deploy/cloudgate.yaml', 'beef002')),
      '/src/beef002/deploy/cloudgate.yaml': () => raw(CONFIG),
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

  it('refuses a repository the credentials cannot see, naming it', async () => {
    const { reader, calls } = readerWith({
      '': notFound('Repository acme/shop not found'),
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
      '': () => json(REPOSITORY),
      '/refs/branches/staging': notFound('Branch "staging" does not exist.'),
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
      '': () => json(REPOSITORY),
      '/refs/branches/trunk': () => json(branch('trunk', 'c0ffee1')),
      '/src/c0ffee1/cloudgate.yaml?format=meta': notFound(
        'No such file or directory: cloudgate.yaml',
      ),
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

  it('refuses a path that names a directory as a missing file, without reading it', async () => {
    const { reader, calls } = readerWith({
      '': () => json(REPOSITORY),
      '/refs/branches/trunk': () => json(branch('trunk', 'c0ffee1')),
      '/src/c0ffee1/deploy?format=meta': () =>
        json(meta('deploy', 'c0ffee1', 'commit_directory')),
    });

    const read = await reader.read({ ...request, path: 'deploy' });

    expect(read).toMatchObject({ ok: false, reason: 'file-missing' });
    expect(calls).toHaveLength(3);
  });

  it('refuses credentials Bitbucket rejects as an unreachable repository', async () => {
    const { reader } = readerWith({
      '': () => new Response('Unauthorized', { status: 401 }),
    });

    const read = await reader.read(request);

    expect(read).toMatchObject({
      ok: false,
      reason: 'repository-unreachable',
      branch: null,
    });
    expect(read.ok ? '' : read.message).toContain('401');
  });

  it('refuses a connection with incomplete credentials as an unreachable repository, without calling Bitbucket', async () => {
    const { reader, calls } = readerWith(
      {},
      { ...row, apiToken: null, appPassword: null },
    );

    const read = await reader.read(request);

    expect(read).toMatchObject({ ok: false, reason: 'repository-unreachable' });
    expect(calls).toEqual([]);
  });

  it('refuses a connection that is gone without calling Bitbucket', async () => {
    const { reader, calls } = readerWith({}, null);

    const read = await reader.read(request);

    expect(read).toMatchObject({ ok: false, reason: 'repository-unreachable' });
    expect(calls).toEqual([]);
  });
});
