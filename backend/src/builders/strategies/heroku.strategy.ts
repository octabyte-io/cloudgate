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
 * CNB build via `pack`, on the `heroku/builder` image.
 *
 * `pack` is installed on the build Server by the program itself when the
 * Server has none — see `builders/pack-install.ts`.
 *
 * **The `--env` values travel in the environment, not in the flags** —
 * `builders/build-env.ts` carries the argument.
 */
export const herokuStrategy: BuildStrategy = {
  buildType: 'heroku_buildpacks',

  getProgram(input: BuildCommandInput): BuildProgram {
    const {
      appName,
      buildAppDirectory,
      env,
      projectEnv,
      environmentEnv,
      cleanCache,
      buildNonce,
      herokuVersion,
    } = input;

    const carried = carryBuildEnv(
      'CG_BUILD_ENV',
      prepareEnvironmentVariables(env ?? null, projectEnv, environmentEnv),
    );

    // Quoted per word; the env words pushed below quote the operator's key and
    // reference the value. See `BuildStrategy` for the rule —
    // `herokuVersion` is a `PATCH`-able column like every other value here.
    const builder = `heroku/builder:${quote([herokuVersion || '24'])}`;
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
        packInstallation('Heroku', buildNonce),
        packRunImagePull(builder),
        'echo "Starting heroku build..." ;',
        `pack ${args.join(' ')} || {`,
        '  echo "❌ Heroku build failed" ;',
        '  exit 1;',
        '}',
        'echo "✅ Heroku build completed." ;',
      ].join('\n'),
      env: carried.env,
    };
  },
};
