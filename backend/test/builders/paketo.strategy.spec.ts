import { paketoStrategy } from '../../src/builders/strategies/paketo.strategy';
import {
  packInstallation,
  packRunImagePull,
} from '../../src/builders/pack-install';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';

/** Every program opens by installing `pack` when the Server has none —
 * `pack-install.spec.ts` pins what the snippet does. */
const PACK_INSTALLATION = packInstallation('Paketo', 'nonce123456');

describe('paketoStrategy.getProgram', () => {
  // The value is in the environment, not in the flag — see
  // `builders/build-env.ts`.
  it('builds the pack command with the jammy-full builder and env words that reference their values', () => {
    const program = paketoStrategy.getProgram({
      appName: 'api',
      buildAppDirectory: '/apps/api/code',
      buildNonce: 'nonce123456',
      env: 'NODE_ENV=production',
    });

    expect(program.command).toBe(
      `${PACK_INSTALLATION}
${packRunImagePull('paketobuildpacks/builder-jammy-full')}
echo "Starting Paketo build..." ;
pack build api --path /apps/api/code --builder paketobuildpacks/builder-jammy-full --env NODE_ENV"=$CG_BUILD_ENV_0" || {
  echo "❌ Paketo build failed" ;
  exit 1;
}
echo "✅ Paketo build completed." ;`,
    );
    expect(program.env).toEqual({ CG_BUILD_ENV_0: 'production' });
  });

  it('clears the buildpack cache when asked', () => {
    const { command } = paketoStrategy.getProgram({
      appName: 'api',
      buildAppDirectory: '/apps/api/code',
      buildNonce: 'nonce123456',
      cleanCache: true,
    });

    expect(command).toBe(
      `${PACK_INSTALLATION}
${packRunImagePull('paketobuildpacks/builder-jammy-full')}
echo "Starting Paketo build..." ;
pack build api --path /apps/api/code --builder paketobuildpacks/builder-jammy-full --clear-cache || {
  echo "❌ Paketo build failed" ;
  exit 1;
}
echo "✅ Paketo build completed." ;`,
    );
  });

  // The `pack` arguments carry the same two values the other builders do.
  it('quotes the app name and the build directory', () => {
    const { command } = paketoStrategy.getProgram({
      appName: SHELL_PAYLOAD,
      buildAppDirectory: `/apps/${SHELL_PAYLOAD}/code`,
      buildNonce: 'nonce123456',
    });

    expectQuotedInCommand(command);
    expect(command).toContain('--path');
  });
});
