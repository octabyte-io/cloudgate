import { getGitProviderStrategy } from '../../src/git-providers/git-provider.strategy';
import { gitlabStrategy } from '../../src/git-providers/strategies/gitlab/gitlab.strategy';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';

describe('gitlabStrategy.cloneProgram', () => {
  it('clones over https with the access token as oauth2 credentials, against gitlab.com by default', () => {
    const { command } = gitlabStrategy.cloneProgram({
      owner: 'octabyte',
      repository: 'cloudgate',
      branch: 'main',
      outputPath: '/apps/api/code',
      accessToken: 'glpat-token',
      gitlabPathNamespace: 'octabyte/cloudgate',
    });

    expect(command).toBe(
      `set -e;
rm -rf /apps/api/code;
mkdir -p /apps/api/code;
echo 'Cloning repo gitlab.com/octabyte/cloudgate.git to /apps/api/code';
cg_clone=$(mktemp -d);
{ GIT_TERMINAL_PROMPT=0 git -c protocol.file.allow=never clone --branch main --depth 1 --progress -- https\\://oauth2\\:glpat-token\\@gitlab.com/octabyte/cloudgate.git /apps/api/code 2>&1 || touch "$cg_clone/failed"; } | tee "$cg_clone/output";
if [ -e "$cg_clone/failed" ]; then
  if grep -q 'terminal prompts disabled' "$cg_clone/output"; then echo 'The server asked for credentials, so the repository is private or does not exist. Clone it over SSH with an SSH key, or through a connected git provider.'; fi;
  rm -rf "$cg_clone";
  echo '❌ Failed to clone repository gitlab.com/octabyte/cloudgate.git';
  exit 1;
fi
rm -rf "$cg_clone";
echo '✅ Cloned repo gitlab.com/octabyte/cloudgate.git';`,
    );
  });

  it('clones from a self-hosted instance, keeping its protocol', () => {
    const { command } = gitlabStrategy.cloneProgram({
      owner: 'octabyte',
      repository: 'cloudgate',
      branch: 'develop',
      outputPath: '/apps/api/code',
      accessToken: 'glpat-token',
      gitlabUrl: 'http://gitlab.internal:8080',
      gitlabPathNamespace: 'octabyte/cloudgate',
    });

    expect(command).toContain(
      'git -c protocol.file.allow=never clone --branch develop --depth 1 --progress -- http\\://oauth2\\:glpat-token\\@gitlab.internal\\:8080/octabyte/cloudgate.git /apps/api/code',
    );
  });

  it('adds --recurse-submodules when submodules are enabled', () => {
    const { command } = gitlabStrategy.cloneProgram({
      owner: 'octabyte',
      repository: 'cloudgate',
      branch: 'main',
      outputPath: '/apps/api/code',
      accessToken: 'glpat-token',
      gitlabPathNamespace: 'octabyte/cloudgate',
      enableSubmodules: true,
    });

    expect(command).toContain(
      'git -c protocol.file.allow=never clone --branch main --depth 1 --recurse-submodules --progress -- https\\://oauth2\\:glpat-token\\@gitlab.com/octabyte/cloudgate.git /apps/api/code',
    );
  });

  it('emits an error command listing what is missing instead of cloning', () => {
    const { command } = gitlabStrategy.cloneProgram({
      owner: 'octabyte',
      repository: null,
      branch: null,
      outputPath: '/apps/api/code',
      accessToken: 'glpat-token',
    });

    expect(command).toBe(
      `set -e;
echo "Error: ❌ GitLab repository configuration is incomplete";
echo "Reasons:";
echo "Repository not assigned.
Branch not defined.
Path namespace not defined.";
exit 1;`,
    );
  });

  it('emits an error command when no access token was resolved', () => {
    const { command } = gitlabStrategy.cloneProgram({
      owner: 'octabyte',
      repository: 'cloudgate',
      branch: 'main',
      outputPath: '/apps/api/code',
      gitlabPathNamespace: 'octabyte/cloudgate',
    });

    expect(command).toBe(
      `set -e;
echo "Error: ❌ GitLab repository configuration is incomplete";
echo "Reasons:";
echo "Access token not resolved.";
exit 1;`,
    );
  });
});

describe('strategy registry', () => {
  it('resolves the gitlab source type to the gitlab strategy', () => {
    expect(getGitProviderStrategy('gitlab')).toBe(gitlabStrategy);
  });
});

describe('gitlabStrategy shell safety', () => {
  // The `rm -rf` / `git -c protocol.file.allow=never clone --branch` shape this strategy shares with
  // its three siblings — `branch`, the resolved `outputPath` and the
  // credentialed clone url are all value words.
  it('quotes the branch, the output path and the credentialed clone url', () => {
    const { command } = gitlabStrategy.cloneProgram({
      owner: 'octabyte',
      repository: 'cloudgate',
      branch: SHELL_PAYLOAD,
      outputPath: `/apps/${SHELL_PAYLOAD}/code`,
      gitlabPathNamespace: 'octabyte/cloudgate',
      accessToken: SHELL_PAYLOAD,
    });

    // One substitution is the clone's own: `cg_clone=$(mktemp -d)`.
    expectQuotedInCommand(command, SHELL_PAYLOAD, 1);
    expect(command).toContain('rm -rf');
  });

  it('quotes the output path of a commit read', () => {
    expectQuotedInCommand(
      gitlabStrategy.getCommitInfo({
        outputPath: `/apps/${SHELL_PAYLOAD}/code`,
      }),
    );
  });
});
