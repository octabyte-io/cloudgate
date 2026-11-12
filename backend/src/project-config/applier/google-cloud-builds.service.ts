import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  buildPieceNames,
  registryPasswordSecretId,
} from '../../cloud-accounts/gcp/cloud-build-names';
import { LABEL_KEYS } from '../../cloud-accounts/gcp/definitions/mark';
import { idKey } from '../../cloud-accounts/gcp/definitions/names';
import {
  logPlaceOf,
  logPlaceText,
  nextLogPlace,
} from '../../cloud-accounts/gcp/execution-log';
import type { GcpCloudAccount } from '../../cloud-accounts/cloud-provider';
import {
  GOOGLE_CLOUD_PORT,
  NOT_FOUND,
} from '../../cloud-accounts/google-cloud.port';
import type {
  CloudBuildState,
  GoogleAccessToken,
  GoogleAnswer,
  GoogleCloudPort,
  SecretRef,
} from '../../cloud-accounts/google-cloud.port';
import { runCloudBuild } from '../../cloud-builds/cloud-build-run';
import type {
  CloudBuildHalf,
  CloudBuildLogSettle,
  CloudBuildProgress,
} from '../../cloud-builds/cloud-build-run';
import {
  CLOUD_BUILD_CODE,
  codeBuildFiles,
} from '../../cloud-builds/codebuild-program';
import {
  googleBuildConfig,
  googleBuildScript,
  googleCopyScript,
  IMAGE_EXPORT,
} from '../../cloud-builds/google-build-program';
import { copySignsIn } from '../../cloud-builds/image-copy-program';
import { writeSourceZip } from '../../cloud-builds/source-zip';
import { CLOUD_LOG_SETTLE } from '../../cron-services/cron-run-place.port';
import { describeError } from '../../common/describe-error';
import type { Deployment } from '../../db/schema';
import { applicationBuildProgram } from '../../deployment-engine/application-build-program';
import { cloudBuildDirectory } from '../../deployment-engine/deployment-engine.paths';
import type { DeployableApplication } from '../../deployment-engine/deployment-engine.types';
import type { CloudRunControl } from '../../deployment-queue/cloud-run-job.types';
import { buildSourcePrefix, SOURCE_ZIP } from './aws-cloud-builds.service';
import type { BuiltImage } from './aws-cloud-builds.service';
import { inspectedImage, localImageOf } from './cloud-deploy-steps';

/** How many of a build's log entries one read takes. */
const LOG_PAGE = 500;

export interface GoogleCloudBuildRequest {
  readonly row: Deployment;
  readonly app: DeployableApplication;
  readonly account: GcpCloudAccount;
  readonly region: string;
  /** Where it is pushed: the Service's Artifact Registry repository and image. */
  readonly repository: string;
  readonly image: string;
  /** The deploy service account's access token, asked again when near its end. */
  readonly token: () => Promise<GoogleAccessToken>;
  readonly control: CloudRunControl;
  readonly log: (line: string) => Promise<void>;
  /** What the log says of an image of a CPU Cloud Run does not run. */
  readonly runs: string;
}

/**
 * **Google Cloud's half of a hosted cloud build** (ADR-0047): Cloud
 * Build in the customer's project, from the Environment network's source
 * bucket (named by `gcp/cloud-build-names.ts`), run as the Cloud
 * account's build identity. Every call is the deploy service account's
 * access token through the Google port (`cloudbuild.builds.*`, the zip's
 * `storage.objects.*`, the log's `logging.logEntries.list`); none is
 * `tofu`. `runCloudBuild` drives it, as it drives CodeBuild
 * (`AwsCloudBuilds`), whose zip and build program this shares.
 *
 * Its Deployment's build slot copied the checkout to
 * {@link cloudBuildDirectory}'s `code/`; this zips it with the build program
 * (`google-build-program.ts`), uploads the zip to
 * `gs://<source bucket>/builds/<Deployment id>/source.zip`, builds, and
 * removes the zip and the folder, however the build ended (the bucket's
 * one-day lifecycle rule is only the fallback).
 *
 * **A ready-made image** has no checkout: its zip is the copy
 * program alone (`google-build-program.ts`' `googleCopyScript`). A private
 * registry's password is written as this Deployment's own Secret Manager
 * secret (`cloud-build-names.ts`), which only the build identity may read,
 * named in the build's `availableSecrets`, and deleted once the build has
 * ended, however it ended.
 */
@Injectable()
export class GoogleCloudBuilds {
  private readonly logger = new Logger(GoogleCloudBuilds.name);
  /** How often Cloud Build is asked about the build; shortened by the e2e suite. */
  pollIntervalMs = 5_000;
  /** How long the log is read on after the end (Cloud Logging lags); shortened by the e2e suite. */
  logSettle: CloudBuildLogSettle = CLOUD_LOG_SETTLE;

  constructor(
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
  ) {}

  /** Builds and pushes the image `<Deployment id>`; its CPU and check. */
  async build(request: GoogleCloudBuildRequest): Promise<BuiltImage> {
    const { row, app, account, region, control, log } = request;
    const projectId = account.cloudId;
    const names = buildPieceNames({
      projectId,
      cloudAccountId: account.cloudAccountId,
      environmentId: app.environmentId,
    });
    const folder = cloudBuildDirectory(app.appName, row.deploymentId);
    const upload = `${folder}/upload`;
    const copies = app.sourceType === 'docker';
    const signsIn = copies && copySignsIn(app);
    const secretId = registryPasswordSecretId({
      cloudAccountId: account.cloudAccountId,
      deploymentId: row.deploymentId,
    });
    let secretPut = false;
    try {
      if (!copies && !existsSync(`${folder}/code`)) {
        throw new Error(
          "This Deployment's checkout is not on Cloudgate's host any more, so there is nothing to build; deploy again",
        );
      }
      const registry = `${region}-docker.pkg.dev`;
      const remote = `${registry}/${projectId}/${request.repository}/${request.image}:${row.deploymentId}`;
      await mkdir(upload, { recursive: true, mode: 0o700 });
      const zip = `${upload}/${SOURCE_ZIP}`;
      if (copies) {
        await writeSourceZip(zip, {
          files: codeBuildFiles(
            googleCopyScript({
              source: {
                image: app.dockerImage ?? '',
                registryUrl: app.registryUrl,
                username: app.username,
                signsIn,
              },
              remote,
              registry,
            }),
            {},
          ),
        });
      } else {
        const program = applicationBuildProgram(app, CLOUD_BUILD_CODE);
        await writeSourceZip(zip, {
          tree: { path: `${folder}/code`, under: 'code/' },
          files: codeBuildFiles(
            googleBuildScript({
              program: program.command,
              local: localImageOf(app),
              remote,
              registry,
            }),
            program.env,
          ),
        });
      }
      let registryPassword: { versionName: string } | undefined;
      if (signsIn) {
        // Marked before the call: a secret made half-way is deleted too.
        secretPut = true;
        await log(
          `🔐 [Copy] Handing the registry password to Cloud Build through Secret Manager, as ${secretId}`,
        );
        const put = await this.google.putBuildSecret(await request.token(), {
          projectId,
          secretId,
          value: app.password ?? '',
          readerEmail: names.buildServiceAccountEmail,
          labels: {
            [LABEL_KEYS.cloudAccount]: idKey(account.cloudAccountId),
            [LABEL_KEYS.environment]: idKey(app.environmentId),
          },
        });
        if (!put.ok) {
          throw new Error(
            `Secret Manager refused the registry password's secret: ${put.code}: ${put.message}`,
          );
        }
        registryPassword = put.value;
      }
      const exported = await runCloudBuild(
        this.half({
          projectId,
          region,
          bucket: names.sourceBucketName,
          object: `${buildSourcePrefix(row.deploymentId)}${SOURCE_ZIP}`,
          zip,
          serviceAccountEmail: names.buildServiceAccountEmail,
          deploymentId: row.deploymentId,
          registryPassword,
          token: request.token,
        }),
        { control, log, pollIntervalMs: this.pollIntervalMs },
      );
      return builtImageOf(exported[IMAGE_EXPORT], request.runs, copies);
    } finally {
      if (secretPut) {
        await this.deleteRegistryPassword(
          request.token,
          { projectId, secretId },
          log,
        );
      }
      await rm(folder, { recursive: true, force: true }).catch(
        (error: unknown) =>
          this.logger.warn(
            `The cloud build folder of ${row.deploymentId} was not removed: ${describeError(error)}`,
          ),
      );
    }
  }

  /**
   * The registry password's secret deleted, however the build ended. A
   * refusal is logged, never thrown over the build's own outcome.
   */
  private async deleteRegistryPassword(
    token: () => Promise<GoogleAccessToken>,
    secret: SecretRef,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const said = await token()
      .then((held) => this.google.deleteSecret(held, secret))
      .then((answer) =>
        answer.ok ? null : `${answer.code}: ${answer.message}`,
      )
      .catch((error: unknown) => describeError(error));
    await log(
      said === null
        ? `🧹 [Copy] Removed the registry password's secret ${secret.secretId}`
        : `⚠️ [Copy] The registry password's secret ${secret.secretId} could not be removed (${said}); delete it in Secret Manager`,
    );
  }

  private half(input: {
    projectId: string;
    region: string;
    bucket: string;
    object: string;
    zip: string;
    serviceAccountEmail: string;
    deploymentId: string;
    registryPassword: { versionName: string } | undefined;
    token: () => Promise<GoogleAccessToken>;
  }): CloudBuildHalf {
    const { projectId, region, bucket, object } = input;
    const asked = async <T>(
      call: (token: GoogleAccessToken) => Promise<GoogleAnswer<T>>,
      refused: (code: string, message: string) => string,
    ): Promise<T> => {
      const answer = await call(await input.token());
      if (!answer.ok) throw new Error(refused(answer.code, answer.message));
      return answer.value;
    };
    return {
      service: 'Cloud Build',
      sourcePlace: `gs://${bucket}/${object}`,
      logSettle: this.logSettle,
      upload: async () => {
        await asked(
          (token) =>
            this.google.uploadObject(token, {
              bucket,
              name: object,
              file: input.zip,
              contentType: 'application/zip',
            }),
          (code, message) =>
            code === NOT_FOUND || code === '404'
              ? `Cloud Storage has no bucket ${bucket}: this Environment network was made before cloud builds. Check for changes, then apply the plan, which makes it (${message})`
              : `The source could not be uploaded to ${bucket}: ${code}: ${message}`,
        );
      },
      start: () =>
        asked(
          (token) =>
            this.google.startCloudBuild(token, {
              projectId,
              region,
              build: googleBuildConfig({
                projectId,
                bucket,
                object,
                serviceAccountEmail: input.serviceAccountEmail,
                deploymentId: input.deploymentId,
                ...(input.registryPassword
                  ? { registryPassword: input.registryPassword }
                  : {}),
              }),
            }),
          (code, message) =>
            `Cloud Build refused the build: ${code}: ${message}`,
        ).then((started) => started.buildId),
      progress: async (buildId) =>
        progressOf(
          await asked(
            (token) =>
              this.google.cloudBuild(token, { projectId, region, buildId }),
            (code, message) =>
              `Cloud Build could not be asked about build ${buildId}: ${code}: ${message}`,
          ),
        ),
      readLog: async (buildId, from) => {
        const place = logPlaceOf(from);
        const entries = await asked(
          (token) =>
            this.google.cloudBuildLogEntries(token, {
              projectId,
              buildId,
              from: place,
              limit: LOG_PAGE,
            }),
          (code, message) => `${code}: ${message}`,
        );
        // A read that found nothing leaves the place where it was.
        const next = nextLogPlace(place, entries);
        return {
          lines: entries.map((entry) => entry.text),
          next: next ? logPlaceText(next) : null,
        };
      },
      stop: async (buildId) => {
        await asked(
          (token) =>
            this.google.cancelCloudBuild(token, { projectId, region, buildId }),
          (code, message) => `${code}: ${message}`,
        );
      },
      removeSource: async () => {
        const removed = await this.google.deleteObject(await input.token(), {
          bucket,
          name: object,
        });
        if (!removed.ok && removed.code !== NOT_FOUND) {
          throw new Error(`${removed.code}: ${removed.message}`);
        }
      },
    };
  }
}

/** Cloud Build's answer in the terms both clouds share. */
function progressOf(state: CloudBuildState): CloudBuildProgress {
  if (state.phase !== 'ended') return { phase: state.phase };
  switch (state.status) {
    case 'SUCCESS':
      return {
        phase: 'succeeded',
        exported: { [IMAGE_EXPORT]: state.stepOutputs[0] ?? '' },
      };
    case 'CANCELLED':
      return { phase: 'stopped' };
    default:
      return {
        phase: 'failed',
        reason: state.reason
          ? `${state.status}: ${state.reason}`
          : state.status,
      };
  }
}

/** The image's facts from what the build wrote, or a throw naming why not. */
function builtImageOf(
  said: string | undefined,
  runs: string,
  copied = false,
): BuiltImage {
  if (!said?.trim()) {
    throw new Error(
      `Cloud Build ${copied ? 'copied' : 'built'} the image but did not say what it ${copied ? 'copied' : 'built'}, so it cannot be run`,
    );
  }
  const { architecture, healthCheck } = inspectedImage(said);
  if (architecture !== 'amd64') {
    throw new Error(
      `The image is built for ${said.trim().split(/\s/)[0] || 'an unknown CPU'}; ${runs}`,
    );
  }
  return { architecture, healthCheck };
}
