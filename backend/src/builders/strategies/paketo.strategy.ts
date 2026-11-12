import { quote } from 'shell-quote';
import { prepareEnvironmentVariables } from '../../docker/docker.utils';
import { carryBuildEnv, envFlagWord } from '../build-env';
import { packInstallation, packRunImagePull } from '../pack-install';
import type {
  BuildCommandInput,
  BuildProgram,
  BuildStrategy,
} from '../build-strategy';

/**
 * CNB build via `pack`, on `paketobuildpacks/builder-jammy-full`.
 *
 * `pack` is installed on the build Server by the program itself when the
 * Server has none — see `builders/pack-install.ts`.
 *
 * **The `--env` values travel in the environment, not in the flags** —
 * `builders/build-env.ts` carries the argument.
 */
export const paketoStrategy: BuildStrategy = {
  buildType: 'paketo_buildpacks',

  getProgram(input: BuildCommandInput): BuildProgram {
    const {
      appName,
      buildAppDirectory,
      env,
      projectEnv,
      environmentEnv,
      cleanCache,
      buildNonce,
    } = input;

    const carried = carryBuildEnv(
      'CG_BUILD_ENV',
      prepareEnvironmentVariables(env ?? null, projectEnv, environmentEnv),
    );

    // Quoted per word; the env words pushed below quote the operator's key and
    // reference the value. See `BuildStrategy` for the rule.
    const builder = 'paketobuildpacks/builder-jammy-full';
    const args = [
      'build',
      quote([appName]),
      '--path',
      quote([buildAppDirectory]),
      '--builder',
      builder,
    ];

    if (cleanCache) {
      args.push('--clear-cache');
    }

    for (const entry of carried.entries) {
      args.push('--env', envFlagWord(entry));
    }

    return {
      command: [
        packInstallation('Paketo', buildNonce),
        packRunImagePull(builder),
        'echo "Starting Paketo build..." ;',
        `pack ${args.join(' ')} || {`,
        '  echo "❌ Paketo build failed" ;',
        '  exit 1;',
        '}',
        'echo "✅ Paketo build completed." ;',
      ].join('\n'),
      env: carried.env,
    };
  },
};
