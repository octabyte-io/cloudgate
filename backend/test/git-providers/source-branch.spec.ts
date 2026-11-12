import type { CloneSource } from '../../src/git-providers/source-clone.service';
import { SourceCloneService } from '../../src/git-providers/source-clone.service';
import { onBranch } from '../../src/git-providers/source-branch';
import type { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import type { Github } from '../../src/git-providers/strategies/github/github.schema';
import type { GithubService } from '../../src/git-providers/strategies/github/github.service';
import type { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import { passThroughGuard } from '../outbound/pass-through-guard';

/**
 * A Requested preview builds a branch of any git-sourced Application,
 * and a preview build overrides the branch on the parent's row. Each provider
 * clones from a different column, and before the fix the override wrote `branch`
 * alone — the GitHub column — so a GitLab, Gitea, Bitbucket or plain git
 * Application would have built its configured branch while the Deployment
 * said `Requested preview of <branch>`.
 */
describe('onBranch', () => {
  const clones = new SourceCloneService(
    {
      getGithubToken: () => Promise.resolve('ghs_token'),
    } as unknown as GithubService,
    {
      refreshToken: () =>
        Promise.resolve({
          gitlabUrl: 'https://gitlab.com',
          accessToken: 'glpat',
        }),
    } as unknown as GitlabService,
    {
      refreshToken: () =>
        Promise.resolve({ giteaUrl: 'https://gitea.com', accessToken: 'gt' }),
    } as unknown as GiteaService,
    passThroughGuard,
  );

  /** Every source column set, each branch column naming the configured one. */
  const application = {
    appName: 'web-app',
    enableSubmodules: false,
    customGitUrl: 'https://example.com/octabyte/cloudgate.git',
    customGitBranch: 'configured',
    owner: 'octabyte',
    repository: 'cloudgate',
    branch: 'configured',
    gitlabOwner: 'octabyte',
    gitlabRepository: 'cloudgate',
    gitlabBranch: 'configured',
    gitlabPathNamespace: 'octabyte/cloudgate',
    giteaOwner: 'octabyte',
    giteaRepository: 'cloudgate',
    giteaBranch: 'configured',
    bitbucketOwner: 'octabyte',
    bitbucketRepository: 'cloudgate',
    bitbucketBranch: 'configured',
    github: {} as Github,
    gitlab: {} as CloneSource['gitlab'],
    gitea: {} as CloneSource['gitea'],
    bitbucket: {
      bitbucketUsername: 'octabyte',
      apiToken: 'bb',
      appPassword: null,
    } as unknown as CloneSource['bitbucket'],
  };

  it.each(['git', 'github', 'gitlab', 'gitea', 'bitbucket'] as const)(
    'clones the asked-for branch of a %s Application',
    async (sourceType) => {
      const { command } = await clones.cloneProgram(
        onBranch({ ...application, sourceType }, 'feature/asked'),
        '/apps/web-app/code',
        { on: { serverId: null, serviceId: 'app-1' } },
      );

      expect(command).toContain('--branch feature/asked');
      expect(command).not.toContain('configured');
    },
  );

  it('leaves the row it was given unchanged', () => {
    const source = { ...application, sourceType: 'gitlab' as const };

    onBranch(source, 'feature/asked');

    expect(source.gitlabBranch).toBe('configured');
  });
});
