import { getGitProviderStrategy } from '../../src/git-providers/git-provider.strategy';
import { githubStrategy } from '../../src/git-providers/strategies/github/github.strategy';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';

describe('githubStrategy.cloneProgram', () => {
  it('clones over https with the installation token as oauth2 credentials', () => {
    const { command } = githubStrategy.cloneProgram({
      owner: 'octabyte-io',
      repository: 'cloudgate',
      branch: 'main',
      outputPath: '/apps/api/code',
      githubToken: 'ghs_installation-token',
    });

    expect(command).toBe(
      `set -e;
rm -rf /apps/api/code;
mkdir -p /apps/api/code;
echo 'Cloning repo github.com/octabyte-io/cloudgate.git to /apps/api/code';
cg_clone=$(mktemp -d);
{ GIT_TERMINAL_PROMPT=0 git -c protocol.file.allow=never clone --branch main --depth 1 --progress -- https\\://oauth2\\:ghs_installation-token\\@github.com/octabyte-io/cloudgate.git /apps/api/code 2>&1 || touch "$cg_clone/failed"; } | tee "$cg_clone/output";
if [ -e "$cg_clone/failed" ]; then
  if grep -q 'terminal prompts disabled' "$cg_clone/output"; then echo 'The server asked for credentials, so the repository is private or does not exist. Clone it over SSH with an SSH key, or through a connected git provider.'; fi;
  rm -rf "$cg_clone";
  echo '❌ Failed to clone repository github.com/octabyte-io/cloudgate.git';
  exit 1;
fi
rm -rf "$cg_clone";
echo '✅ Cloned repo github.com/octabyte-io/cloudgate.git';`,
    );
  });

  it('adds --recurse-submodules when submodules are enabled', () => {
    const { command } = githubStrategy.cloneProgram({
      owner: 'octabyte-io',
      repository: 'cloudgate',
      branch: 'main',
      outputPath: '/apps/api/code',
      githubToken: 'ghs_tok',
      enableSubmodules: true,
    });

    expect(command).toContain(
      'git -c protocol.file.allow=never clone --branch main --depth 1 --recurse-submodules --progress -- https\\://oauth2\\:ghs_tok\\@github.com/octabyte-io/cloudgate.git /apps/api/code',
    );
  });

  it('emits an error command listing what is missing instead of cloning', () => {
    const { command } = githubStrategy.cloneProgram({
      owner: 'octabyte-io',
      repository: null,
      branch: null,
      outputPath: '/apps/api/code',
      githubToken: 'ghs_tok',
    });

    expect(command).toBe(
      `set -e;
echo "Error: ❌ GitHub repository configuration is incomplete";
echo "Reasons:";
echo "Repository not assigned.
Branch not defined.";
exit 1;`,
    );
  });

  it('emits an error command when no installation token was resolved', () => {
    const { command } = githubStrategy.cloneProgram({
      owner: 'octabyte-io',
      repository: 'cloudgate',
      branch: 'main',
      outputPath: '/apps/api/code',
    });

    expect(command).toBe(
      `set -e;
echo "Error: ❌ GitHub repository configuration is incomplete";
echo "Reasons:";
echo "Installation token not resolved.";
exit 1;`,
    );
  });
});

describe('githubStrategy shell safety', () => {
  // The same `rm -rf` / `git -c protocol.file.allow=never clone --branch` shape as every other
  // provider — `branch` and the resolved `outputPath` are value words, and the
  // credential baked into the clone url is one too.
  it('quotes the branch, the output path and the credentialed clone url', () => {
    const { command } = githubStrategy.cloneProgram({
      owner: 'octabyte-io',
      repository: 'cloudgate',
      branch: SHELL_PAYLOAD,
      outputPath: `/apps/${SHELL_PAYLOAD}/code`,
      githubToken: SHELL_PAYLOAD,
    });

    // One substitution is the clone's own: `cg_clone=$(mktemp -d)`.
    expectQuotedInCommand(command, SHELL_PAYLOAD, 1);
    expect(command).toContain('rm -rf');
  });

  it('quotes the output path of a commit read', () => {
    expectQuotedInCommand(
      githubStrategy.getCommitInfo({
        outputPath: `/apps/${SHELL_PAYLOAD}/code`,
      }),
    );
  });
});

describe('strategy registry', () => {
  it('resolves the github source type to the github strategy', () => {
    expect(getGitProviderStrategy('github')).toBe(githubStrategy);
  });
});
