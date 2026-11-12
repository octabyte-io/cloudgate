import { quote } from 'shell-quote';

import { CLOUD_BUILDER_IMAGE } from '../builders/cloud-builder-image';
import type { CloudBuildConfig } from '../cloud-accounts/google-cloud.port';
import { CLOUD_RUN_PLATFORM } from '../deployment-engine/cloud-build';
import { IMAGE_INSPECT_FORMAT } from '../project-config/applier/cloud-deploy-steps';
import { buildProgramLines, CLOUD_BUILD_SCRIPT } from './codebuild-program';
import {
  imageCopyLines,
  REGISTRY_PASSWORD_VARIABLE,
} from './image-copy-program';
import type { ImageCopySource } from './image-copy-program';

/**
 * **What a hosted Cloud Build build runs** (ADR-0047): the build
 * config this Deployment's `builds.create` sends, and the build program it
 * calls, which travels in the source zip beside the checkout, as on AWS
 * (`codebuild-program.ts`, whose zip layout and value files this shares:
 * `code/`, `cloudgate/build.sh`, `cloudgate/env/<NAME>`; no value is a step
 * `env`, which `builds.get` and the Cloud Build console show in plain
 * text). Pure: every value is the caller's.
 *
 * **One step, from the pinned builder image**: `bash
 * cloudgate/build.sh` in `/workspace`, where Cloud Build unpacks the zip.
 * The step has the worker's Docker daemon, so docker, pack, nixpacks and
 * railpack work as they are.
 *
 * **The push signs in as the build identity**, never with a token of the
 * deploy service account's: the step asks the metadata server for the
 * build's own access token and logs in to Artifact Registry as
 * `oauth2accesstoken` (the platform host's push does the same with the
 * deploy service account's token), against a throwaway
 * `DOCKER_CONFIG`. The build identity may push only to repositories
 * Cloudgate names.
 *
 * **Cloud Run runs x86 only**: the image's CPU is read
 * before the push, and an image of another CPU fails the build with
 * nothing pushed.
 *
 * **A ready-made image is copied, not built**: its zip holds
 * `cloudgate/build.sh` alone, {@link googleCopyScript}, which pulls the
 * image for `linux/amd64` (`image-copy-program.ts`), checks its CPU and
 * pushes it as the build does. A private registry's password is the step's
 * one `secretEnv`, which Cloud Build reads as the build identity from the
 * Secret Manager version the config's `availableSecrets` names, never a
 * value.
 *
 * **What the build found** comes back through the step's
 * `$BUILDER_OUTPUT/output`, which Cloud Build answers as the build's
 * `results.buildStepOutputs` ("Cloud Builders can produce this output by
 * writing to `$BUILDER_OUTPUT/output`. Only the first 50KB of data is
 * stored", the `Results` message of the Cloud Build v1 API), not through a
 * log line the build's own output could imitate.
 *
 * **The log option is `CLOUD_LOGGING_ONLY`** — a fact to
 * establish, not a choice among equals:
 *
 * - a build run as a user-specified service account must name where its
 *   log goes: a user-owned Cloud Storage bucket (`GCS_ONLY` with a
 *   `logsBucket`), Cloud Logging (`CLOUD_LOGGING_ONLY`), or `NONE`
 *   ("Configure user-specified service accounts", Cloud Build docs:
 *   "you must store your build logs in one of the following bucket types";
 *   the build config schema's `logging` values);
 * - `NONE` keeps no line, and the build identity may write no bucket, only
 *   Cloud Logging (`roles/logging.logWriter`);
 * - and Cloud Logging has a build's lines while it runs: the Google Cloud
 *   CLI streams a running `CLOUD_LOGGING_ONLY` build's log by tailing them
 *   there (`googlecloudsdk/api_lib/cloudbuild/logs.py`, SDK 570.0.0:
 *   `CloudBuildClient.Stream` picks `GCLLogTailer` for `CLOUD_LOGGING_ONLY`
 *   and keeps it tailing while the build is `QUEUED` or `WORKING`, with the
 *   filter `gcp/cloud-build-log.ts` reads with).
 *
 * Cloud Logging shows an entry a few seconds after it is taken, so the
 * Cloud run reads the log on for a little while after the build has ended
 * (`CloudBuildHalf.logSettle`). The build's timeout is
 * Cloud Build's default of 60 minutes (unset); Cloudgate's own time limit,
 * the queue excluded, ends a longer one and cancels it.
 */

/** The exported value holding `docker image inspect`'s answer, as on AWS. */
export { IMAGE_EXPORT } from './codebuild-program';

/** Who reads the build's own access token: the step's metadata server. */
const TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

export interface GoogleBuildScriptInput {
  /** The Service's build program over `CLOUD_BUILD_CODE`. */
  readonly program: string;
  /** The image it builds, e.g. `web:latest`. */
  readonly local: string;
  /** `<region>-docker.pkg.dev/<project>/<repository>/<image>:<Deployment id>`. */
  readonly remote: string;
  /** The Artifact Registry host the login is for. */
  readonly registry: string;
}

/** `cloudgate/build.sh`: the build, the image's facts, and the push. */
export function googleBuildScript(input: GoogleBuildScriptInput): string {
  return [
    '#!/usr/bin/env bash',
    "# Written by Cloudgate for one Deployment's build.",
    'set -eo pipefail',
    // Cloud Build runs the step in /workspace, where it unpacked the zip.
    'src="$PWD"',
    ...buildProgramLines(input.program),
    ...artifactRegistryPushLines(input),
    '',
  ].join('\n');
}

export interface GoogleCopyScriptInput {
  /** The ready-made image; pulled for `linux/amd64`, which Cloud Run runs. */
  readonly source: Omit<ImageCopySource, 'platform'>;
  /** `<region>-docker.pkg.dev/<project>/<repository>/<image>:<Deployment id>`. */
  readonly remote: string;
  /** The Artifact Registry host the login is for. */
  readonly registry: string;
}

/** `cloudgate/build.sh` of a ready-made image: the pull, the image's facts, and the push. */
export function googleCopyScript(input: GoogleCopyScriptInput): string {
  return [
    '#!/usr/bin/env bash',
    "# Written by Cloudgate to copy one Deployment's ready-made image.",
    'set -eo pipefail',
    'src="$PWD"',
    ...imageCopyLines({ ...input.source, platform: CLOUD_RUN_PLATFORM }),
    ...artifactRegistryPushLines({
      local: input.source.image,
      remote: input.remote,
      registry: input.registry,
    }),
    '',
  ].join('\n');
}

/**
 * The image's facts into the step's output, an image of another CPU than
 * x86 stopped, and the push as the build identity.
 */
function artifactRegistryPushLines(input: {
  readonly local: string;
  readonly remote: string;
  readonly registry: string;
}): string[] {
  const { local, remote, registry } = input;
  const runs =
    'Cloud Run runs x86 (amd64) images only, so nothing was pushed. Deploy an x86 image';
  return [
    `image="$(docker image inspect --format ${quote([IMAGE_INSPECT_FORMAT])} ${quote([local])})"`,
    ': "${BUILDER_OUTPUT:=/builder/outputs}"',
    'mkdir -p "$BUILDER_OUTPUT"',
    `printf '%s' "$image" > "$BUILDER_OUTPUT/output"`,
    'case "${image%% *}" in',
    '  amd64) ;;',
    `  *) echo ${quote([`❌ The image is built for `])}"\${image%% *}"${quote([`; ${runs}`])} >&2; exit 1 ;;`,
    'esac',
    `echo ${quote([`📦 [Push] Uploading image to '${remote}'`])}`,
    'DOCKER_CONFIG="$(mktemp -d)"',
    'export DOCKER_CONFIG',
    `token="$(curl -fsS -H 'Metadata-Flavor: Google' ${quote([TOKEN_URL])} | sed -E 's/.*"access_token" *: *"([^"]+)".*/\\1/')"`,
    `printf '%s' "$token" | docker login -u oauth2accesstoken --password-stdin ${quote([registry])}`,
    'unset token',
    `docker tag ${quote([local])} ${quote([remote])}`,
    `docker push ${quote([remote])}`,
    'rm -rf "$DOCKER_CONFIG"',
    "echo '✅ Image Pushed'",
  ];
}

export interface GoogleBuildConfigInput {
  readonly projectId: string;
  /** The Environment's source bucket and the zip's name in it. */
  readonly bucket: string;
  readonly object: string;
  /** The Cloud account's build identity. */
  readonly serviceAccountEmail: string;
  readonly deploymentId: string;
  /**
   * The Secret Manager version of a private registry's password, for the
   * build that copies a ready-made image: the step's one
   * `secretEnv`, which Cloud Build reads as the build identity.
   */
  readonly registryPassword?: { readonly versionName: string };
}

/** The `Build` this Deployment's `builds.create` sends. */
export function googleBuildConfig(
  input: GoogleBuildConfigInput,
): CloudBuildConfig {
  return {
    source: {
      storageSource: { bucket: input.bucket, object: input.object },
    },
    steps: [
      {
        name: CLOUD_BUILDER_IMAGE,
        entrypoint: 'bash',
        args: [CLOUD_BUILD_SCRIPT],
        ...(input.registryPassword
          ? { secretEnv: [REGISTRY_PASSWORD_VARIABLE] }
          : {}),
      },
    ],
    ...(input.registryPassword
      ? {
          availableSecrets: {
            secretManager: [
              {
                versionName: input.registryPassword.versionName,
                env: REGISTRY_PASSWORD_VARIABLE,
              },
            ],
          },
        }
      : {}),
    serviceAccount: `projects/${input.projectId}/serviceAccounts/${input.serviceAccountEmail}`,
    options: { logging: 'CLOUD_LOGGING_ONLY' },
    // A tag is `[\w][\w.-]{0,127}`: a Deployment's id is nanoid's
    // `[A-Za-z0-9_-]`, so it is one after its prefix.
    tags: ['cloudgate', `cloudgate-deployment-${input.deploymentId}`],
  };
}
