import { quote } from 'shell-quote';

import { IMAGE_INSPECT_FORMAT } from '../project-config/applier/cloud-deploy-steps';
import { imageCopyLines } from './image-copy-program';
import type { ImageCopySource } from './image-copy-program';
import type { SourceZipFile } from './source-zip';

/**
 * **What a hosted CodeBuild build runs** (ADR-0047): the buildspec
 * this Deployment's `StartBuild` overrides the project's with, and the build
 * program it calls, which travels in the source zip beside the checkout.
 * Pure: every value is the caller's.
 *
 * The zip holds
 *
 * - `code/` — the checkout, as the build slot copied it, without `.git`;
 * - `cloudgate/build.sh` — {@link codeBuildScript}: the Service's own build
 *   program (the one its build slot would run, over the checkout at
 *   {@link CLOUD_BUILD_CODE}), then the push to its ECR repository as the
 *   Cloud account's build identity, then the built image's CPU and
 *   `HEALTHCHECK`;
 * - `cloudgate/env/<NAME>` — one file per value the build program reads out
 *   of its environment (`CG_BUILD_ENV_*`): the Service's variables and
 *   build secrets, so none of them is a CodeBuild environment variable, which
 *   `BatchGetBuilds` and the CodeBuild console show in plain text for as long
 *   as the build is kept. The script reads them into its own environment and
 *   deletes the folder before the build starts; the zip itself is deleted
 *   from the bucket once the build has ended.
 *
 * **The push signs in as the build identity**, never with a token of the
 * deploy role's: the builder image's `docker-credential-ecr-login` reads the
 * build's own container credentials, and the build identity may push only
 * to repositories carrying its Cloud account's tag.
 *
 * **A ready-made image is copied, not built**: its zip holds
 * `cloudgate/build.sh` alone, {@link codeBuildCopyScript}, which pulls the
 * image (`image-copy-program.ts`) and pushes it as the build does. A private
 * registry's password is the build's one variable, read by CodeBuild from an
 * SSM parameter (`CodeBuildStartRequest.parameterVariables`), never a value.
 *
 * **What the build found** comes back through the buildspec's
 * `exported-variables` ({@link IMAGE_EXPORT}), which only Cloudgate's own
 * last command sets, not through a log line the build's own output could
 * imitate.
 */

/** Where the build program finds the checkout inside the build container. */
export const CLOUD_BUILD_CODE = '/cloudgate/code';

/** The exported variable holding `docker image inspect`'s answer. */
export const IMAGE_EXPORT = 'CLOUDGATE_IMAGE';

/** The build program's path in the zip, and the folder of its values. */
export const CLOUD_BUILD_SCRIPT = 'cloudgate/build.sh';
const SCRIPT = CLOUD_BUILD_SCRIPT;
const ENV_DIRECTORY = 'cloudgate/env';
const IMAGE_FILE = 'cloudgate/image';

/**
 * The buildspec (YAML, version 0.2: one shell for every command, so the
 * last command's export is the build's). Every command is a JSON string,
 * which YAML reads as a double-quoted scalar.
 */
export function codeBuildBuildspec(): string {
  const commands = [
    // The builder image starts no daemon of its own in CodeBuild.
    'cloudgate-start-dockerd',
    `bash ${SCRIPT}`,
    `export ${IMAGE_EXPORT}="$(cat ${IMAGE_FILE})"`,
  ];
  return [
    'version: 0.2',
    'env:',
    '  shell: bash',
    '  exported-variables:',
    `    - ${IMAGE_EXPORT}`,
    'phases:',
    '  build:',
    '    commands:',
    ...commands.map((command) => `      - ${JSON.stringify(command)}`),
    '',
  ].join('\n');
}

export interface CodeBuildScriptInput {
  /** The Service's build program over {@link CLOUD_BUILD_CODE}. */
  readonly program: string;
  /** The image it builds, e.g. `web:latest`. */
  readonly local: string;
  /** `<registry>/<repository>:<Deployment id>`. */
  readonly remote: string;
  /** The ECR registry host the credential helper answers for. */
  readonly registry: string;
}

/** `cloudgate/build.sh`: the build, the push and the image's facts. */
export function codeBuildScript(input: CodeBuildScriptInput): string {
  return [
    '#!/usr/bin/env bash',
    "# Written by Cloudgate for one Deployment's build.",
    'set -eo pipefail',
    'src="${CODEBUILD_SRC_DIR:-$PWD}"',
    ...buildProgramLines(input.program),
    ...ecrPushLines(input),
    '',
  ].join('\n');
}

export interface CodeBuildCopyScriptInput {
  /** The ready-made image, pulled for the build's own CPU: ECS takes it as it is. */
  readonly source: Omit<ImageCopySource, 'platform'>;
  /** `<registry>/<repository>:<Deployment id>`. */
  readonly remote: string;
  /** The ECR registry host the credential helper answers for. */
  readonly registry: string;
}

/** `cloudgate/build.sh` of a ready-made image: the pull, the push and the image's facts. */
export function codeBuildCopyScript(input: CodeBuildCopyScriptInput): string {
  return [
    '#!/usr/bin/env bash',
    "# Written by Cloudgate to copy one Deployment's ready-made image.",
    'set -eo pipefail',
    'src="${CODEBUILD_SRC_DIR:-$PWD}"',
    ...imageCopyLines({ ...input.source, platform: null }),
    ...ecrPushLines({
      local: input.source.image,
      remote: input.remote,
      registry: input.registry,
    }),
    '',
  ].join('\n');
}

/**
 * The push to ECR as the build identity, through the builder image's
 * `docker-credential-ecr-login`, then the image's facts for the export.
 */
function ecrPushLines(input: {
  readonly local: string;
  readonly remote: string;
  readonly registry: string;
}): string[] {
  const { local, remote, registry } = input;
  const dockerConfig = JSON.stringify({
    credHelpers: { [registry]: 'ecr-login' },
  });
  return [
    `echo ${quote([`📦 [Push] Uploading image to '${remote}'`])}`,
    'mkdir -p "$HOME/.docker"',
    `printf '%s' ${quote([dockerConfig])} > "$HOME/.docker/config.json"`,
    `docker tag ${quote([local])} ${quote([remote])}`,
    `docker push ${quote([remote])}`,
    `docker image inspect --format ${quote([IMAGE_INSPECT_FORMAT])} ${quote([local])} > "$src"/${IMAGE_FILE}`,
    "echo '✅ Image Pushed'",
  ];
}

/**
 * The part of a cloud build's script both clouds share, once `$src` names
 * the unpacked zip: the build program's values read out of their files into
 * its environment and the files deleted, the checkout put where the program
 * looks for it, and the program run.
 */
export function buildProgramLines(program: string): string[] {
  return [
    // Each value exactly as it was, a trailing newline included.
    `for file in "$src"/${ENV_DIRECTORY}/*; do`,
    '  [ -e "$file" ] || continue',
    '  value="$(cat "$file"; printf x)"',
    '  export "${file##*/}=${value%x}"',
    'done',
    `rm -rf "$src"/${ENV_DIRECTORY}`,
    'mkdir -p /cloudgate',
    `ln -sfn "$src/code" ${quote([CLOUD_BUILD_CODE])}`,
    '(',
    program,
    ')',
  ];
}

/** The zip's files beside the checkout: the script and one file per value. */
export function codeBuildFiles(
  script: string,
  env: Readonly<Record<string, string>>,
): SourceZipFile[] {
  return [
    { path: SCRIPT, content: script, mode: 0o755 },
    ...Object.entries(env).map(([name, value]) => ({
      path: `${ENV_DIRECTORY}/${name}`,
      content: value,
      mode: 0o600,
    })),
  ];
}
