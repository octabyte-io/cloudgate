import { getGitProviderStrategy } from '../../src/git-providers/git-provider.strategy';
import { bitbucketStrategy } from '../../src/git-providers/strategies/bitbucket/bitbucket.strategy';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';

describe('bitbucketStrategy.cloneProgram', () => {
  it('clones over https with the API token as the x-bitbucket-api-token-auth credential', () => {
    const { command } = bitbucketStrategy.cloneProgram({
      owner: 'octabyte',
      repository: 'cloudgate',
      branch: 'main',
      outputPath: '/apps/api/code',
      apiToken: 'bb-api-token',
    });

    expect(command).toBe(
      `set -e;
rm -rf /apps/api/code;
mkdir -p /apps/api/code;
echo 'Cloning repo bitbucket.org/octabyte/cloudgate.git to /apps/api/code';
cg_clone=$(mktemp -d);
{ GIT_TERMINAL_PROMPT=0 git -c protocol.file.allow=never clone --branch main --depth 1 --progress -- https\\://x-bitbucket-api-token-auth\\:bb-api-token\\@bitbucket.org/octabyte/cloudgate.git /apps/api/code 2>&1 || touch "$cg_clone/failed"; } | tee "$cg_clone/output";
if [ -e "$cg_clone/failed" ]; then
  if grep -q 'terminal prompts disabled' "$cg_clone/output"; then echo 'The server asked for credentials, so the repository is private or does not exist. Clone it over SSH with an SSH key, or through a connected git provider.'; fi;
  rm -rf "$cg_clone";
  echo '❌ Failed to clone repository bitbucket.org/octabyte/cloudgate.git';
  exit 1;
fi
rm -rf "$cg_clone";
echo '✅ Cloned repo bitbucket.org/octabyte/cloudgate.git';`,
    );
  });

  it('clones with username and app password when no API token is set', () => {
    const { command } = bitbucketStrategy.cloneProgram({
      owner: 'octabyte',
      repository: 'cloudgate',
      branch: 'main',
      outputPath: '/apps/api/code',
      username: 'grace',
      appPassword: 'bb-app-password',
    });

    expect(command).toContain(
      'git -c protocol.file.allow=never clone --branch main --depth 1 --progress -- https\\://grace\\:bb-app-password\\@bitbucket.org/octabyte/cloudgate.git /apps/api/code',
    );
  });

  it('adds --recurse-submodules when submodules are enabled', () => {
    const { command } = bitbucketStrategy.cloneProgram({
      owner: 'octabyte',
      repository: 'cloudgate',
      branch: 'main',
      outputPath: '/apps/api/code',
      apiToken: 'bb-api-token',
      enableSubmodules: true,
    });

    expect(command).toContain(
      'git -c protocol.file.allow=never clone --branch main --depth 1 --recurse-submodules --progress -- https\\://x-bitbucket-api-token-auth\\:bb-api-token\\@bitbucket.org/octabyte/cloudgate.git /apps/api/code',
    );
  });

  it('emits an error command listing what is missing instead of cloning', () => {
    const { command } = bitbucketStrategy.cloneProgram({
      owner: 'octabyte',
      repository: null,
      branch: null,
      outputPath: '/apps/api/code',
      apiToken: 'bb-api-token',
    });

    expect(command).toBe(
      `set -e;
echo "Error: ❌ Bitbucket repository configuration is incomplete";
echo "Reasons:";
echo "Repository not assigned.
Branch not defined.";
exit 1;`,
    );
  });

  it('emits an error command when neither an API token nor username + app password were resolved', () => {
    const { command } = bitbucketStrategy.cloneProgram({
      owner: 'octabyte',
      repository: 'cloudgate',
      branch: 'main',
      outputPath: '/apps/api/code',
      username: 'grace',
    });

    expect(command).toBe(
      `set -e;
echo "Error: ❌ Bitbucket repository configuration is incomplete";
echo "Reasons:";
echo "Credentials not resolved.";
exit 1;`,
    );
  });
});

describe('strategy registry', () => {
  it('resolves the bitbucket source type to the bitbucket strategy', () => {
    expect(getGitProviderStrategy('bitbucket')).toBe(bitbucketStrategy);
  });
});

describe('bitbucketStrategy shell safety', () => {
  // The `rm -rf` / `git -c protocol.file.allow=never clone --branch` shape this strategy shares with
  // its three siblings — `branch`, the resolved `outputPath` and the
  // credentialed clone url are all value words.
  it('quotes the branch, the output path and the credentialed clone url', () => {
    const { command } = bitbucketStrategy.cloneProgram({
      owner: 'octabyte',
      repository: 'cloudgate',
      branch: SHELL_PAYLOAD,
      outputPath: `/apps/${SHELL_PAYLOAD}/code`,
      apiToken: SHELL_PAYLOAD,
    });

    // One substitution is the clone's own: `cg_clone=$(mktemp -d)`.
    expectQuotedInCommand(command, SHELL_PAYLOAD, 1);
    expect(command).toContain('rm -rf');
  });

  it('quotes the output path of a commit read', () => {
    expectQuotedInCommand(
      bitbucketStrategy.getCommitInfo({
        outputPath: `/apps/${SHELL_PAYLOAD}/code`,
      }),
    );
  });
});
