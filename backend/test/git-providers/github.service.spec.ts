import { BadRequestException } from '@nestjs/common';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import type { OctokitFactory } from '../../src/git-providers/strategies/github/octokit.provider';

// The GitHub API is a system boundary: unit tests swap the octokit factory
// for a stub and drive the service through its public methods only.
const db = {} as DrizzleDB;

describe('GithubService.getGithubToken', () => {
  it('mints an installation token through the app-authenticated octokit client', async () => {
    const credentialsSeen: unknown[] = [];
    const authSeen: unknown[] = [];
    const factory = ((credentials: unknown) => {
      credentialsSeen.push(credentials);
      return {
        auth: (options: unknown) => {
          authSeen.push(options);
          return Promise.resolve({ token: 'ghs_installation-token' });
        },
      };
    }) as unknown as OctokitFactory;
    const service = new GithubService(db, factory);

    const token = await service.getGithubToken({
      appId: 12345,
      privateKey: 'PEM-PRIVATE-KEY',
      installationId: '99887766',
    });

    expect(token).toBe('ghs_installation-token');
    expect(credentialsSeen).toEqual([
      {
        appId: 12345,
        privateKey: 'PEM-PRIVATE-KEY',
        installationId: '99887766',
      },
    ]);
    expect(authSeen).toEqual([{ type: 'installation' }]);
  });

  it('rejects a half-configured connection without calling the GitHub API', async () => {
    const factory = jest.fn();
    const service = new GithubService(db, factory);

    await expect(
      service.getGithubToken({
        appId: 12345,
        privateKey: 'PEM-PRIVATE-KEY',
        installationId: null,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(factory).not.toHaveBeenCalled();
  });

  /**
   * The refusal an operator actually meets, worded in the vocabulary of the
   * screen they were just on.
   *
   * "A connection can be saved before it is finished" is by design, so this is
   * the ordinary path for a half-filled row rather than an edge case, and the
   * sentence was asking for `appId`, `privateKey` and `installationId` — three
   * names spelled nowhere on the Connect GitHub dialog, whose boxes are
   * **App ID**, **Private key** and **Installation ID**.
   */
  it('asks for the three boxes by the names the Connect GitHub dialog gives them', async () => {
    const service = new GithubService(db, jest.fn());

    const refusal = await service
      .getGithubToken({
        appId: null,
        privateKey: null,
        installationId: null,
      })
      .catch((error: Error) => error.message);

    expect(refusal).toBe(
      'GitHub App is not configured correctly (App ID, Private key and Installation ID are required)',
    );
    // And the code's own property names went with it — the point of the change
    // is that nothing an operator reads here is a field of `github.schema.ts`.
    expect(refusal).not.toMatch(/appId|privateKey|installationId/);
  });
});

const configured = {
  appId: 12345,
  privateKey: 'PEM-PRIVATE-KEY',
  installationId: '99887766',
};

describe('GithubService.listRepositories', () => {
  it('maps the paginated installation repositories to our repository DTO', async () => {
    const listReposEndpoint = Symbol('listReposAccessibleToInstallation');
    const paginateSeen: unknown[] = [];
    const factory = (() => ({
      rest: { apps: { listReposAccessibleToInstallation: listReposEndpoint } },
      paginate: (endpoint: unknown) => {
        paginateSeen.push(endpoint);
        return Promise.resolve([
          {
            name: 'cloudgate',
            owner: { login: 'octabyte-io' },
            html_url: 'https://github.com/octabyte-io/cloudgate',
            default_branch: 'main',
            extra_api_field: 'dropped',
          },
          {
            name: 'shop',
            owner: { login: 'acme' },
            html_url: 'https://github.com/acme/shop',
          },
        ]);
      },
    })) as unknown as OctokitFactory;
    const service = new GithubService(db, factory);

    const repositories = await service.listRepositories(configured);

    expect(repositories).toEqual([
      {
        name: 'cloudgate',
        owner: 'octabyte-io',
        url: 'https://github.com/octabyte-io/cloudgate',
        defaultBranch: 'main',
      },
      {
        name: 'shop',
        owner: 'acme',
        url: 'https://github.com/acme/shop',
        defaultBranch: null,
      },
    ]);
    expect(paginateSeen).toEqual([listReposEndpoint]);
  });
});

describe('GithubService.listBranches', () => {
  it('maps the paginated branches of the requested repository to our branch DTO', async () => {
    const listBranchesEndpoint = Symbol('listBranches');
    const paginateSeen: unknown[] = [];
    const factory = (() => ({
      rest: { repos: { listBranches: listBranchesEndpoint } },
      paginate: (endpoint: unknown, params: unknown) => {
        paginateSeen.push([endpoint, params]);
        return Promise.resolve([
          { name: 'main', commit: { sha: 'abc123' }, protected: true },
          { name: 'develop', commit: { sha: 'def456' }, protected: false },
        ]);
      },
    })) as unknown as OctokitFactory;
    const service = new GithubService(db, factory);

    const branches = await service.listBranches(configured, {
      owner: 'octabyte-io',
      repo: 'cloudgate',
    });

    expect(branches).toEqual([
      { name: 'main', commitSha: 'abc123' },
      { name: 'develop', commitSha: 'def456' },
    ]);
    expect(paginateSeen).toEqual([
      [listBranchesEndpoint, { owner: 'octabyte-io', repo: 'cloudgate' }],
    ]);
  });
});

describe('GithubService.postPrComment', () => {
  it('creates the issue comment with the expected arguments and returns the comment id', async () => {
    const createSeen: unknown[] = [];
    const factory = (() => ({
      rest: {
        issues: {
          createComment: (args: unknown) => {
            createSeen.push(args);
            return Promise.resolve({ data: { id: 4242 } });
          },
        },
      },
    })) as unknown as OctokitFactory;
    const service = new GithubService(db, factory);

    const comment = await service.postPrComment(configured, {
      owner: 'octabyte-io',
      repo: 'cloudgate',
      issueNumber: 17,
      body: 'Preview deployment ready',
    });

    expect(comment).toEqual({ commentId: 4242 });
    expect(createSeen).toEqual([
      {
        owner: 'octabyte-io',
        repo: 'cloudgate',
        issue_number: 17,
        body: 'Preview deployment ready',
      },
    ]);
  });
});

describe('GithubService.checkUserRepositoryPermissions', () => {
  const serviceReporting = (permission: string) => {
    const factory = (() => ({
      rest: {
        repos: {
          getCollaboratorPermissionLevel: () =>
            Promise.resolve({ data: { permission } }),
        },
      },
    })) as unknown as OctokitFactory;
    return new GithubService(db, factory);
  };

  it.each([
    ['write', true],
    ['maintain', true],
    ['admin', true],
    ['read', false],
    ['triage', false],
  ] as const)(
    'grants write access for the %s permission level: %s',
    async (permission, hasWriteAccess) => {
      const result = await serviceReporting(
        permission,
      ).checkUserRepositoryPermissions(configured, {
        owner: 'octabyte-io',
        repo: 'cloudgate',
        username: 'pr-author',
      });

      expect(result).toEqual({ hasWriteAccess, permission });
    },
  );

  it('treats a non-collaborator (GitHub 404) as having no access', async () => {
    const factory = (() => ({
      rest: {
        repos: {
          getCollaboratorPermissionLevel: () =>
            Promise.reject(new Error('Not Found')),
        },
      },
    })) as unknown as OctokitFactory;
    const service = new GithubService(db, factory);

    const result = await service.checkUserRepositoryPermissions(configured, {
      owner: 'octabyte-io',
      repo: 'cloudgate',
      username: 'drive-by-user',
    });

    expect(result).toEqual({ hasWriteAccess: false, permission: null });
  });
});
