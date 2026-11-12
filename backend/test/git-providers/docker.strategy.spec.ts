import { dockerStrategy } from '../../src/git-providers/strategies/docker.strategy';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';

describe('dockerStrategy.cloneProgram', () => {
  it('pulls the image reference as a shell-escaped word when no credentials are given', () => {
    const { command } = dockerStrategy.cloneProgram({
      outputPath: '/apps/api/code',
      dockerImage: 'nginx:1.27',
    });

    expect(command).toBe(
      `set -e;
echo 'Pulling image nginx:1.27';
if ! docker pull 'nginx:1.27'; then
  echo '❌ Failed to pull image nginx:1.27';
  exit 1;
fi
echo '✅ Pulled image nginx:1.27';`,
    );
  });

  it('pulls for the platform it is given, as Cloud Run takes only linux/amd64', () => {
    const { command } = dockerStrategy.cloneProgram({
      outputPath: '/apps/api/code',
      dockerImage: 'nginx:1.27',
      platform: 'linux/amd64',
    });

    expect(command).toContain(
      "if ! docker pull --platform 'linux/amd64' 'nginx:1.27'; then",
    );
  });

  /**
   * The second stdin login site. The password used to be `shEscape`d into the
   * pipeline — `printf %s 's3cr'\''et' | docker login …` — where `ExecError`
   * captured it and pino wrote it six times over, and the error mask's `STDIN_CREDENTIAL`
   * masked it on the way out. It now travels in {@link SourceProgram.env} and
   * the command references it.
   *
   * The assertion that matters is the absence, and it is asserted twice over:
   * once on the whole emitted program by `toBe` (so a password reappearing
   * *anywhere* in it reds, not only in the login word), and once as an explicit
   * `not.toContain` — which is the one that names the property rather than
   * pinning a string. The `env` assertion beside them is what stops the test
   * passing on a strategy that simply dropped the credential: the ugly value is
   * carried through byte for byte, which is also the shape of the old
   * `shEscape` test's own point (a quote in a password must survive).
   */
  it('references the pull credential and never carries it', () => {
    const password = "s3cr'et";
    const { command, env } = dockerStrategy.cloneProgram({
      outputPath: '/apps/api/code',
      dockerImage: 'registry.example.com/team/api:v2',
      registryUrl: 'registry.example.com',
      username: 'octabyte',
      password,
    });

    expect(command).not.toContain(password);
    expect(env).toEqual({ CG_SOURCE_REGISTRY_PASSWORD: password });
    expect(command).toBe(
      `set -e;
if ! printf %s "$CG_SOURCE_REGISTRY_PASSWORD" | docker login 'registry.example.com' -u 'octabyte' --password-stdin; then
  echo "❌ Registry login failed";
  exit 1;
fi
echo 'Pulling image registry.example.com/team/api:v2';
if ! docker pull 'registry.example.com/team/api:v2'; then
  echo '❌ Failed to pull image registry.example.com/team/api:v2';
  exit 1;
fi
echo '✅ Pulled image registry.example.com/team/api:v2';`,
    );
  });

  it('declares no environment when the image is public', () => {
    // An empty map is what keeps a clone with nothing to protect on the SSH
    // transport it has always used, rather than on `sh -s`
    // (`RemoteExecService`'s `buildEnvScript`).
    expect(
      dockerStrategy.cloneProgram({
        outputPath: '/apps/api/code',
        dockerImage: 'nginx:1.27',
      }).env,
    ).toEqual({});
    // …and a username with no password is not a login at all, so it is not a
    // half-declared environment either.
    expect(
      dockerStrategy.cloneProgram({
        outputPath: '/apps/api/code',
        dockerImage: 'nginx:1.27',
        registryUrl: 'ghcr.io',
        username: 'octabyte',
      }).env,
    ).toEqual({});
  });

  it('emits an error command when the image reference is missing', () => {
    const { command } = dockerStrategy.cloneProgram({
      outputPath: '/apps/api/code',
    });

    expect(command).toBe(`set -e;
echo "Error: ❌ Docker image not found"; exit 1;`);
  });
});

describe('dockerStrategy branches/commits', () => {
  it('has no branches or commit info', () => {
    expect(dockerStrategy.listBranches({})).toBeNull();
    expect(dockerStrategy.getCommitInfo({ outputPath: '/x' })).toBeNull();
  });
});

describe('dockerStrategy shell safety', () => {
  // `dockerImage` is a `PATCH /applications/:id` column and was the one
  // word in this file that went in bare, beside three that already used
  // `shEscape`.
  it('escapes the image reference in the pull and both echoes', () => {
    const { command } = dockerStrategy.cloneProgram({
      outputPath: '/apps/api/code',
      dockerImage: `nginx:${SHELL_PAYLOAD}`,
    });

    expectQuotedInCommand(command);
    expect(command).toContain('docker pull');
  });
});
