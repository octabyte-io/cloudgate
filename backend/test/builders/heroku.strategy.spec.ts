import { herokuStrategy } from '../../src/builders/strategies/heroku.strategy';
import {
  packInstallation,
  packRunImagePull,
} from '../../src/builders/pack-install';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';

/** Every program opens by installing `pack` when the Server has none —
 * `pack-install.spec.ts` pins what the snippet does. */
const PACK_INSTALLATION = packInstallation('Heroku', 'nonce123456');

describe('herokuStrategy.getProgram', () => {
  // The `--env` words used to be the quoted `KEY=VALUE` pairs
  // themselves. They now name the key and expand the value out of a holder the
  // exec layer sends on the SSH channel, so `pack` receives the same two
  // arguments while `ExecError.command` carries neither value.
  it('builds the pack command with the default builder and env words that reference their values', () => {
    const program = herokuStrategy.getProgram({
      appName: 'api',
      buildAppDirectory: '/apps/api/code',
      buildNonce: 'nonce123456',
      env: 'NODE_ENV=production\nGREETING=hello world',
    });

    expect(program.command).toBe(
      `${PACK_INSTALLATION}
${packRunImagePull('heroku/builder:24')}
echo "Starting heroku build..." ;
pack build api --path /apps/api/code --builder heroku/builder:24 --env NODE_ENV"=$CG_BUILD_ENV_0" --env GREETING"=$CG_BUILD_ENV_1" || {
  echo "❌ Heroku build failed" ;
  exit 1;
}
echo "✅ Heroku build completed." ;`,
    );
    expect(program.env).toEqual({
      CG_BUILD_ENV_0: 'production',
      CG_BUILD_ENV_1: 'hello world',
    });
  });

  it('uses the configured builder version and clears the cache when asked', () => {
    const { command } = herokuStrategy.getProgram({
      appName: 'api',
      buildAppDirectory: '/apps/api/code',
      buildNonce: 'nonce123456',
      cleanCache: true,
      herokuVersion: '22',
    });

    expect(command).toBe(
      `${PACK_INSTALLATION}
${packRunImagePull('heroku/builder:22')}
echo "Starting heroku build..." ;
pack build api --path /apps/api/code --builder heroku/builder:22 --clear-cache || {
  echo "❌ Heroku build failed" ;
  exit 1;
}
echo "✅ Heroku build completed." ;`,
    );
  });

  // The `${{project.X}}` fan-out (ADR-0014) still resolves at the
  // builder; what changed is where the resolved value goes. The command names
  // the key and nothing else, and the value is in the environment — so this
  // asserts both halves, because either alone would pass a broken fix.
  it('resolves project-level references in env values, into the environment rather than the command', () => {
    const program = herokuStrategy.getProgram({
      appName: 'api',
      buildAppDirectory: '/apps/api/code',
      buildNonce: 'nonce123456',
      env: 'API_URL=${{project.BASE}}/v1',
      projectEnv: 'BASE=https://x.dev',
    });

    expect(program.command).toContain(`--env API_URL"=$CG_BUILD_ENV_0" `);
    expect(program.command).not.toContain('x.dev');
    expect(program.env).toEqual({ CG_BUILD_ENV_0: 'https://x.dev/v1' });
  });

  // Same shape as the dockerfile and nixpacks builders — `herokuVersion`
  // is as much a `PATCH`-able column as the app name and the directory.
  it('quotes the app name, the build directory and the builder version', () => {
    const { command } = herokuStrategy.getProgram({
      appName: SHELL_PAYLOAD,
      buildAppDirectory: `/apps/${SHELL_PAYLOAD}/code`,
      buildNonce: 'nonce123456',
      herokuVersion: SHELL_PAYLOAD,
    });

    expectQuotedInCommand(command);
    expect(command).toContain('--builder');
  });
});
