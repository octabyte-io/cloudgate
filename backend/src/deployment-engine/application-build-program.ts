import path from 'node:path';
import { nanoid } from 'nanoid';

import { getBuildProgram } from '../builders/build-strategy';
import { buildPathRefusal } from '../common/build-path';
import type { BuildProgram } from '../builders/build-strategy';
import type { DeployableApplication } from './deployment-engine.types';

/**
 * An Application's build program over a checkout at `codeDirectory`: the
 * one the build slot runs on the machine that cloned it
 * (`DeploymentEngineService`), and the one a hosted cloud build runs in its
 * cloud's build service over the same checkout unzipped, so a
 * Service builds alike in both places. Pure: the caller says where the
 * checkout is.
 */
export function applicationBuildProgram(
  application: DeployableApplication,
  codeDirectory: string,
): BuildProgram {
  const buildAppDirectory = buildAppDirectoryIn(codeDirectory, application);
  return getBuildProgram({
    buildType: application.buildType,
    appName: application.appName,
    buildAppDirectory,
    // The dockerfile builder needs the file, not the directory every other
    // builder takes — resolve it here from the column that stores it.
    dockerfilePath: path.join(
      buildAppDirectory,
      application.dockerfile || 'Dockerfile',
    ),
    buildNonce: nanoid(),
    env: application.env,
    projectEnv: application.environment.project.env,
    environmentEnv: application.environment.env,
    cleanCache: application.cleanCache,
    publishDirectory: application.publishDirectory,
    isStaticSpa: application.isStaticSpa,
    herokuVersion: application.herokuVersion,
    railpackVersion: application.railpackVersion,
    buildArgs: application.buildArgs,
    buildSecrets: application.buildSecrets,
    dockerBuildStage: application.dockerBuildStage,
    dockerContextPath: application.dockerContextPath,
    createEnvFile: application.createEnvFile,
  });
}

/** The build path inside the checkout, the folder `publish` is read from. */
export function buildAppDirectoryIn(
  codeDirectory: string,
  application: DeployableApplication,
): string {
  const buildPath = buildPathOf(application);
  // The save refuses a build path that leaves the repository; a row saved
  // before that rule is refused here, so it cannot run.
  if (buildPathRefusal(buildPath) !== null) {
    throw new Error(
      `Cannot deploy: the build path '${buildPath}' leads outside the repository, or carries a character no build path may. Set a folder inside the repository, then deploy again.`,
    );
  }
  // The default buildPath is '/', which path.join keeps as a trailing
  // slash — strip it so build commands get a canonical directory path.
  return path.join(codeDirectory, buildPath).replace(/(?<=.)\/+$/, '');
}

/**
 * Per-source build path inside the cloned repository, read off the column
 * the source type uses.
 *
 * **The `drop` arm is the drop lane being finished rather than a separate
 * fix.** `dropBuildPath` is the column `POST /applications/:id/drop` writes —
 * it is the *only* column that route sets besides `sourceType`, it defaults
 * to `'/'` there, and `PATCH /applications/:id` cannot set it at all — while
 * `buildPath` belongs to the github/gitlab/gitea/bitbucket sources and
 * `customGitBuildPath` to `git`. Falling through to `buildPath` meant an
 * operator who uploaded a zip and said *"build from `/frontend`"* got a build
 * of the archive root, and one who had previously configured a github source
 * on the same Application got a build of *that* source's subdirectory.
 * Unreachable before now, because the deploy raised in the clone step (see
 * `strategies/drop.strategy.ts`), which is why it comes with the branch that
 * made the lane deployable rather than ahead of it.
 */
function buildPathOf(application: DeployableApplication): string {
  switch (application.sourceType) {
    case 'git':
      return application.customGitBuildPath ?? '/';
    case 'drop':
      return application.dropBuildPath ?? '/';
    default:
      return application.buildPath ?? '/';
  }
}
