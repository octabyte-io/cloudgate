import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { Github } from '../../src/db/schema';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import type { OctokitFactory } from '../../src/git-providers/strategies/github/octokit.provider';
import { GithubConfigReader } from '../../src/project-config/reader/github-config-reader';

// The GitHub API is the system boundary: the octokit factory is stubbed with
// the shapes GitHub's REST API answers (recorded from
// `GET /repos/{owner}/{repo}`, `GET /repos/{owner}/{repo}/branches/{branch}`
// and `GET /repos/{owner}/{repo}/contents/{path}?ref=`), and the connection
// row the reader looks up is the database's, stubbed the same way.
const db = {} as DrizzleDB;

const row = {
  githubId: 'gh_1',
  appId: 12345,
  privateKey: 'PEM-PRIVATE-KEY',
  installationId: '99887766',
} as Github;

const request = {
  connection: { gitProviderId: 'gp_1', providerType: 'github' as const },
  repository: 'acme/shop',
  path: 'cloudgate.yaml',
  ref: null,
};

const CONFIG = 'version: 1\nservices:\n  cache:\n    kind: redis\n';

/** GitHub's own 404, as octokit's RequestError carries it. */
function notFound(message: string) {
  return Object.assign(new Error(message), { status: 404 });
}

const REPOSITORY = {
  id: 1296269,
  name: 'shop',
  full_name: 'acme/shop',
  private: true,
  owner: { login: 'acme', id: 1, type: 'Organization' },
  html_url: 'https://github.com/acme/shop',
  default_branch: 'trunk',
};

function branch(name: string, sha: string) {
  return {
    name,
    commit: {
      sha,
      url: `https://api.github.com/repos/acme/shop/commits/${sha}`,
      commit: { message: 'Describe the shop' },
    },
    protected: false,
    _links: { html: `https://github.com/acme/shop/tree/${name}` },
  };
}

function contents(path: string, sha: string, text: string) {
  // GitHub wraps the base64 body at 60 characters.
  const encoded = Buffer.from(text).toString('base64');
  return {
    type: 'file',
    encoding: 'base64',
    size: text.length,
    name: path.split('/').pop(),
    path,
    content: `${encoded.match(/.{1,60}/g)?.join('\n')}\n`,
    sha: 'blob-sha',
    url: `https://api.github.com/repos/acme/shop/contents/${path}?ref=${sha}`,
    git_url: 'https://api.github.com/repos/acme/shop/git/blobs/blob-sha',
    html_url: `https://github.com/acme/shop/blob/${sha}/${path}`,
    download_url: `https://raw.githubusercontent.com/acme/shop/${sha}/${path}`,
  };
}

interface Api {
  get?: (args: unknown) => Promise<unknown>;
  getBranch?: (args: unknown) => Promise<unknown>;
  getContent?: (args: unknown) => Promise<unknown>;
}

function readerWith(api: Api, found: Github | null = row) {
  const calls: Array<[string, unknown]> = [];
  const recorded =
    (name: keyof Api) =>
    (args: unknown): Promise<unknown> => {
      calls.push([name, args]);
      const handler = api[name];
      return handler
        ? handler(args)
        : Promise.reject(new Error(`${name} was not expected`));
    };
  const factory = (() => ({
    rest: {
      repos: {
        get: recorded('get'),
        getBranch: recorded('getBranch'),
        getContent: recorded('getContent'),
      },
    },
  })) as unknown as OctokitFactory;
  const github = new GithubService(db, factory);
  jest.spyOn(github, 'findByGitProviderId').mockResolvedValue(found);
  return { reader: new GithubConfigReader(github), calls };
}

describe('GithubConfigReader', () => {
  it("reads the file on the repository's default branch at that branch's head commit", async () => {
    const { reader, calls } = readerWith({
      get: () => Promise.resolve({ data: REPOSITORY }),
      getBranch: () => Promise.resolve({ data: branch('trunk', 'c0ffee1') }),
      getContent: () =>
        Promise.resolve({
          data: contents('cloudgate.yaml', 'c0ffee1', CONFIG),
        }),
    });

    const read = await reader.read(request);

    expect(read).toEqual({
      ok: true,
      text: CONFIG,
      commitSha: 'c0ffee1',
      branch: 'trunk',
      fileUrl: 'https://github.com/acme/shop/blob/c0ffee1/cloudgate.yaml',
    });
    // The content is read at the commit, so the text is that commit's.
    expect(calls).toEqual([
      ['get', { owner: 'acme', repo: 'shop' }],
      ['getBranch', { owner: 'acme', repo: 'shop', branch: 'trunk' }],
      [
        'getContent',
        { owner: 'acme', repo: 'shop', path: 'cloudgate.yaml', ref: 'c0ffee1' },
      ],
    ]);
  });

  it('reads the named branch and a nested path', async () => {
    const { reader, calls } = readerWith({
      get: () => Promise.resolve({ data: REPOSITORY }),
      getBranch: () => Promise.resolve({ data: branch('staging', 'beef002') }),
      getContent: () =>
        Promise.resolve({
          data: contents('deploy/cloudgate.yaml', 'beef002', CONFIG),
        }),
    });

    const read = await reader.read({
      ...request,
      path: 'deploy/cloudgate.yaml',
      ref: 'staging',
    });

    expect(read).toMatchObject({
      ok: true,
      text: CONFIG,
      commitSha: 'beef002',
      branch: 'staging',
    });
    expect(calls[1]).toEqual([
      'getBranch',
      { owner: 'acme', repo: 'shop', branch: 'staging' },
    ]);
  });

  it('refuses a repository GitHub does not show the installation, naming it', async () => {
    const { reader, calls } = readerWith({
      get: () => Promise.reject(notFound('Not Found')),
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
      get: () => Promise.resolve({ data: REPOSITORY }),
      getBranch: () => Promise.reject(notFound('Branch not found')),
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
      get: () => Promise.resolve({ data: REPOSITORY }),
      getBranch: () => Promise.resolve({ data: branch('trunk', 'c0ffee1') }),
      getContent: () => Promise.reject(notFound('Not Found')),
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
      get: () => Promise.resolve({ data: REPOSITORY }),
      getBranch: () => Promise.resolve({ data: branch('trunk', 'c0ffee1') }),
      // GitHub answers a directory's listing as an array.
      getContent: () =>
        Promise.resolve({
          data: [
            { type: 'file', name: 'cloudgate.yaml', path: 'x/cloudgate.yaml' },
          ],
        }),
    });

    const read = await reader.read({ ...request, path: 'x' });

    expect(read).toMatchObject({ ok: false, reason: 'file-missing' });
  });

  it('refuses a provider that does not answer as an unreachable repository', async () => {
    const { reader } = readerWith({
      get: () =>
        Promise.reject(
          Object.assign(new Error('Bad credentials'), { status: 401 }),
        ),
    });

    const read = await reader.read(request);

    expect(read).toMatchObject({
      ok: false,
      reason: 'repository-unreachable',
      branch: null,
    });
    expect(read.ok ? '' : read.message).toContain('Bad credentials');
  });

  it('refuses a connection that is gone without calling GitHub', async () => {
    const { reader, calls } = readerWith({}, null);

    const read = await reader.read(request);

    expect(read).toMatchObject({ ok: false, reason: 'repository-unreachable' });
    expect(calls).toEqual([]);
  });
});
