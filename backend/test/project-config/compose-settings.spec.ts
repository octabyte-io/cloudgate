import { composeSettings } from '../../src/project-config/applier/compose-settings';
import { isNewRepository } from '../../src/project-config/applier/service-settings';
import type { ComposeEntry, SavedService } from '../../src/project-config';

const entry = (fields: Partial<ComposeEntry> = {}): ComposeEntry => ({
  kind: 'compose',
  managed: false,
  source: { sourceType: 'github', repository: 'acme/analytics' },
  env: [],
  ...fields,
});

const github = {
  sourceType: 'github' as const,
  githubId: 'gh-1',
  owner: 'acme',
  repository: 'analytics',
  defaultBranch: 'main',
};

function stack(owner: string, repository: string): SavedService {
  return {
    serviceType: 'compose',
    serviceId: 'compose-1',
    name: 'analytics',
    configName: 'analytics',
    settings: {
      sourceType: 'github',
      owner,
      repository,
      gitlabOwner: null,
      gitlabRepository: null,
      gitlabPathNamespace: null,
      giteaOwner: null,
      giteaRepository: null,
      bitbucketOwner: null,
      bitbucketRepository: null,
      customGitUrl: null,
      composePath: './docker-compose.yml',
      composeType: 'docker-compose',
    },
    variables: { env: [] },
  };
}

/**
 * What the Applier writes through a stack's own update path for a
 * `compose` entry (ADR-0069): the three fields the config owns, and the
 * connection and branch only when the repository is new to the stack.
 */
describe('composeSettings', () => {
  it('writes the file from the code directory and the type, at their defaults when left out', () => {
    expect(composeSettings(entry(), null)).toEqual({
      composePath: './docker-compose.yml',
      composeType: 'docker-compose',
    });
    expect(
      composeSettings(
        entry({ composePath: 'deploy/compose.yml', composeType: 'stack' }),
        null,
      ),
    ).toEqual({ composePath: './deploy/compose.yml', composeType: 'stack' });
  });

  it('writes a new repository with its connection and default branch', () => {
    expect(
      composeSettings(entry(), { connection: github, isNewRepository: true }),
    ).toEqual({
      composePath: './docker-compose.yml',
      composeType: 'docker-compose',
      sourceType: 'github',
      githubId: 'gh-1',
      owner: 'acme',
      repository: 'analytics',
      branch: 'main',
    });
  });

  it('writes a git URL, its branch only when the URL is new', () => {
    const git = entry({
      source: {
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/a.git',
      },
    });
    expect(
      composeSettings(git, { connection: null, isNewRepository: true }),
    ).toMatchObject({
      sourceType: 'git',
      customGitUrl: 'https://git.example.com/a.git',
      customGitBranch: 'main',
    });
    expect(
      composeSettings(git, { connection: null, isNewRepository: false }),
    ).not.toHaveProperty('customGitBranch');
  });
});

describe('isNewRepository, on a Compose stack', () => {
  it('is new for another repository or source, and not for the same one in any case', () => {
    const source = {
      sourceType: 'github',
      repository: 'Acme/Analytics',
    } as const;
    expect(isNewRepository(stack('acme', 'analytics'), source)).toBe(false);
    expect(isNewRepository(stack('acme', 'other'), source)).toBe(true);
    expect(
      isNewRepository(stack('acme', 'analytics'), {
        sourceType: 'gitea',
        repository: 'acme/analytics',
      }),
    ).toBe(true);
    expect(isNewRepository(undefined, source)).toBe(true);
  });
});
