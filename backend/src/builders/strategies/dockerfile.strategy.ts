import path from 'node:path';
import { quote } from 'shell-quote';
import {
  getCreateFileCommand,
  prepareEnvironmentVariables,
} from '../../docker/docker.utils';
import { carryBuildEnv, envFlagWord, secretFlagValue } from '../build-env';
import type {
  BuildCommandInput,
  BuildProgram,
  BuildStrategy,
} from '../build-strategy';

/**
 * `docker build` against the app's Dockerfile. `dockerfilePath` is the
 * Dockerfile file (resolved by the caller from the application's `dockerfile`
 * column); its directory is the build context unless `dockerContextPath`
 * overrides it.
 *
 * **This is the builder with two separate leaks found in it, and they got the same
 * mechanism for two different reasons.**
 *
 * `buildSecrets` was the worse of the two and the plainer to fix. It rode as a
 * bare shell assignment prefix — `SECRET_TOKEN=sk_live_… docker build …` — so a
 * column *named* `buildSecrets` was the first thing in the string `ExecError`
 * captures, and the `--secret type=env,id=…` flag beside it was already the
 * right idea: buildx reads the value out of its own environment, so the prefix
 * was never the mechanism, only the delivery. It is gone, and the value now
 * arrives on the SSH channel (`builders/build-env.ts`). Nothing about the
 * build changes: `/run/secrets/<key>` inside the Dockerfile is byte-identical.
 *
 * `buildArgs` needed the same treatment for the journal and **must not be read
 * as having been made secret by it.** Docker is explicit that a build argument
 * is not a secret carrier — *"Build arguments are visible in the `docker
 * history` command and in `max` mode provenance attestations"* (Dockerfile
 * reference, `ARG`) — so a credential in `application.buildArgs` is recoverable
 * from the built image whatever this file does, and the fix here closes the
 * journal echo only. That is the whole reason `buildSecrets` exists as a second
 * column beside it, and the honest advice for a credential is still to move it
 * there. What is fixed is narrower and real: a *failed* build used to publish
 * the arguments to the journal of an operator who never got an image at all.
 */
export const dockerfileStrategy: BuildStrategy = {
  buildType: 'dockerfile',

  getProgram(input: BuildCommandInput): BuildProgram {
    const {
      appName,
      buildAppDirectory,
      env,
      projectEnv,
      environmentEnv,
      buildArgs,
      buildSecrets,
      dockerBuildStage,
      cleanCache,
      publishDirectory,
      createEnvFile,
      dockerContextPath,
    } = input;

    // `-f` must name a file. Callers that don't resolve one fall back to the
    // same default the `dockerfile` column carries.
    const dockerfilePath =
      input.dockerfilePath || path.join(buildAppDirectory, 'Dockerfile');

    const defaultContextPath =
      dockerfilePath.substring(0, dockerfilePath.lastIndexOf('/') + 1) || '.';
    const contextPath = dockerContextPath || defaultContextPath;

    // Quoted as each word is built rather than over the joined string, and the
    // env words below quote the operator's key and reference the value — see
    // `BuildStrategy` for the rule and what it is defending.
    const commandArgs = [
      'build',
      '-t',
      quote([appName]),
      '-f',
      quote([dockerfilePath]),
      '.',
    ];

    if (dockerBuildStage) {
      commandArgs.push('--target', quote([dockerBuildStage]));
    }

    if (cleanCache) {
      commandArgs.push('--no-cache');
    }

    const carriedArgs = carryBuildEnv(
      'CG_BUILD_ARG',
      prepareEnvironmentVariables(
        buildArgs ?? null,
        projectEnv,
        environmentEnv,
      ),
    );
    for (const entry of carriedArgs.entries) {
      commandArgs.push('--build-arg', envFlagWord(entry));
    }

    // Secrets are handed to buildx through the environment, and the flag now
    // names the variable rather than leaving buildx to infer it from the id —
    // which is both what a holder requires and a fix in its own right, see
    // `secretFlagValue`.
    // See: https://docs.docker.com/reference/cli/docker/buildx/build/#secret
    const carriedSecrets = carryBuildEnv(
      'CG_BUILD_SECRET',
      prepareEnvironmentVariables(
        buildSecrets ?? null,
        projectEnv,
        environmentEnv,
      ),
    );
    for (const entry of carriedSecrets.entries) {
      commandArgs.push('--secret', secretFlagValue(entry));
    }

    let command = '';
    // No .env when publishDirectory is set — the artifacts get copied out
    // of the image and the file could end up publicly served.
    if (!publishDirectory && createEnvFile) {
      command += getCreateFileCommand(
        path.dirname(dockerfilePath),
        '.env',
        prepareEnvironmentVariables(
          env ?? null,
          projectEnv,
          environmentEnv,
        ).join('\n'),
      );
    }

    command += [
      `echo ${quote([`Building ${appName}`])} ;`,
      `cd ${quote([contextPath])} || {`,
      `  echo ${quote([`❌ The path ${contextPath} does not exist`])} ;`,
      '  exit 1;',
      '}',
      `docker ${commandArgs.join(' ')} || {`,
      '  echo "❌ Docker build failed" ;',
      '  exit 1;',
      '}',
      'echo "✅ Docker build completed." ;',
    ].join('\n');

    return {
      command,
      env: { ...carriedArgs.env, ...carriedSecrets.env },
    };
  },
};
