import { BadRequestException } from '@nestjs/common';
import { dockerfileStrategy } from '../../src/builders/strategies/dockerfile.strategy';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';

describe('dockerfileStrategy.getProgram', () => {
  /**
   * The never-carry change, at the builder that had two leaks rather than one.
   *
   * The `NPM_TOKEN='secret token'` assignment prefix is gone and the
   * `--build-arg VERSION\=1.2.3` word no longer carries its value: both are
   * holders now, and the environment beside the command is what the exec layer
   * sends on the SSH channel. The `.env` body is the one thing still in the
   * string, base64 through `getCreateFileCommand`, which is the mask's covered wire
   * shape.
   */
  it('builds docker build with env file, build args, secrets, target stage and no-cache', () => {
    const program = dockerfileStrategy.getProgram({
      appName: 'api',
      buildAppDirectory: '/apps/api/code',
      dockerfilePath: '/apps/api/code/Dockerfile',
      buildNonce: 'nonce123456',
      env: 'NODE_ENV=production',
      createEnvFile: true,
      buildArgs: 'VERSION=1.2.3',
      buildSecrets: 'NPM_TOKEN=secret token',
      dockerBuildStage: 'runner',
      cleanCache: true,
    });

    expect(program.command).toBe(
      `mkdir -p "/apps/api/code";
echo "Tk9ERV9FTlY9cHJvZHVjdGlvbg==" | base64 -d > "/apps/api/code/.env";
echo 'Building api' ;
cd /apps/api/code/ || {
  echo '❌ The path /apps/api/code/ does not exist' ;
  exit 1;
}
docker build -t api -f /apps/api/code/Dockerfile . --target runner --no-cache --build-arg VERSION"=$CG_BUILD_ARG_0" --secret id=NPM_TOKEN,env=CG_BUILD_SECRET_0 || {
  echo "❌ Docker build failed" ;
  exit 1;
}
echo "✅ Docker build completed." ;`,
    );
    expect(program.env).toEqual({
      CG_BUILD_ARG_0: '1.2.3',
      CG_BUILD_SECRET_0: 'secret token',
    });
  });

  it('skips the env file when a publish directory is set and honors a custom context path', () => {
    const { command } = dockerfileStrategy.getProgram({
      appName: 'web',
      buildAppDirectory: '/apps/web/code',
      dockerfilePath: '/apps/web/code/docker/Dockerfile',
      buildNonce: 'nonce123456',
      env: 'NODE_ENV=production',
      createEnvFile: true,
      publishDirectory: 'dist',
      dockerContextPath: '/apps/web/code',
    });

    expect(command).toBe(
      `echo 'Building web' ;
cd /apps/web/code || {
  echo '❌ The path /apps/web/code does not exist' ;
  exit 1;
}
docker build -t web -f /apps/web/code/docker/Dockerfile . || {
  echo "❌ Docker build failed" ;
  exit 1;
}
echo "✅ Docker build completed." ;`,
    );
  });

  it('defaults to a Dockerfile inside the build directory when no dockerfile path is resolved', () => {
    const { command } = dockerfileStrategy.getProgram({
      appName: 'api',
      buildAppDirectory: '/apps/api/code',
      buildNonce: 'nonce123456',
    });

    // `-f` names a file even for a caller that only knows the directory —
    // it must never receive the bare directory.
    expect(command).toContain(
      'docker build -t api -f /apps/api/code/Dockerfile .',
    );
    expect(command).not.toContain('-f /apps/api/code .');
  });

  it('builds the minimal command without env file, args or secrets', () => {
    const { command } = dockerfileStrategy.getProgram({
      appName: 'api',
      buildAppDirectory: '/apps/api/code',
      dockerfilePath: '/apps/api/code/Dockerfile',
      buildNonce: 'nonce123456',
    });

    expect(command).toBe(
      `echo 'Building api' ;
cd /apps/api/code/ || {
  echo '❌ The path /apps/api/code/ does not exist' ;
  exit 1;
}
docker build -t api -f /apps/api/code/Dockerfile . || {
  echo "❌ Docker build failed" ;
  exit 1;
}
echo "✅ Docker build completed." ;`,
    );
  });

  /**
   * `dockerContextPath`, `dockerfile` and `dockerBuildStage` are
   * `PATCH /applications/:id` columns and were spliced bare into `cd`, `-f`
   * and `--target`, plus the two `echo`s — where `$` substitutes inside the
   * double quotes as well. One test per column would say the same thing four
   * times, so all four positions carry the payload at once.
   */
  it('quotes every column it interpolates, so an injected substitution reaches docker as a word', () => {
    const { command } = dockerfileStrategy.getProgram({
      appName: SHELL_PAYLOAD,
      buildAppDirectory: '/apps/api/code',
      dockerfilePath: `/apps/api/code/${SHELL_PAYLOAD}`,
      buildNonce: 'nonce123456',
      dockerBuildStage: SHELL_PAYLOAD,
      dockerContextPath: SHELL_PAYLOAD,
    });

    expectQuotedInCommand(command);
    // Every position, not just the first one the payload happened to reach.
    expect(command).toContain('--target');
    expect(command).toContain('does not exist');
  });

  /**
   * The seam between refusing and quoting, pinned so nobody harmonises it away.
   *
   * The injection finding lists `dockerfile` next to `dockerContextPath` and
   * `dockerBuildStage` as an unvalidated `PATCH /applications/:id` column, and
   * the test above quotes all three. `dockerfile` has a second destination the other two do
   * not: with `createEnvFile` set, its directory becomes the `outputPath` of
   * `getCreateFileCommand`, which an earlier fix made **refuse** a `SHELL_UNSAFE` path
   * rather than quote it — so this one column answers a metacharacter with a
   * 400 out of a pure command builder on one branch and with a quoted word on
   * the other.
   *
   * That asymmetry is deliberate and it is the safer half: refusing beats
   * running the payload, and a file mount's path is an operator-authored
   * constant in every legitimate use (`resolveShellSafePath`'s own note).
   * Asserted as the *refusal* rather than against a string, because a test that
   * pinned the emitted command would be the one a later "make it consistent"
   * pass could satisfy by quoting instead — which is exactly the regression.
   * `build-injection.e2e-spec.ts` carries the same fact through the route.
   */
  it('refuses a dockerfile path carrying a metacharacter when it writes the env file', () => {
    const withEnvFile = () =>
      dockerfileStrategy.getProgram({
        appName: 'api',
        buildAppDirectory: '/apps/api/code',
        dockerfilePath: `/apps/api/code/${SHELL_PAYLOAD}/Dockerfile`,
        buildNonce: 'nonce123456',
        env: 'NODE_ENV=production',
        createEnvFile: true,
      });

    expect(withEnvFile).toThrow(new BadRequestException('Invalid path'));

    // The same payload on the same column is *quoted* rather than refused once
    // the branch is not taken — the two halves of the seam, side by side.
    expect(() =>
      dockerfileStrategy.getProgram({
        appName: 'api',
        buildAppDirectory: '/apps/api/code',
        dockerfilePath: `/apps/api/code/${SHELL_PAYLOAD}/Dockerfile`,
        buildNonce: 'nonce123456',
        env: 'NODE_ENV=production',
        createEnvFile: false,
      }),
    ).not.toThrow();
  });

  it('quotes a build-secret key in the --secret argument and names the variable it reads', () => {
    const { command } = dockerfileStrategy.getProgram({
      appName: 'api',
      buildAppDirectory: '/apps/api/code',
      dockerfilePath: '/apps/api/code/Dockerfile',
      buildNonce: 'nonce123456',
      buildSecrets: 'NPM_TOKEN=value',
    });

    // `env=` is explicit rather than inferred from the id, which is what a
    // holder needs and also takes away buildx's silent `type=file` fallback for
    // an unset variable (`secretFlagValue`).
    expect(command).toContain('--secret id=NPM_TOKEN,env=CG_BUILD_SECRET_0');
  });
});
