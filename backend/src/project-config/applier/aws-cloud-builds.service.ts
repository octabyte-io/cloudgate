import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  buildPieceNames,
  registryPasswordParameterName,
} from '../../cloud-accounts/aws/cloud-build-names';
import type { ImageHealthCheck } from '../../cloud-accounts/aws/definitions/container-health-check';
import { ecrRepositoryName } from '../../cloud-accounts/aws/definitions/web-definition';
import type { AwsCloudAccount } from '../../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT } from '../../cloud-accounts/cloud.port';
import type {
  AwsAnswer,
  AwsCloudPort,
  AwsCredential,
  CodeBuildParameterVariable,
  CodeBuildState,
} from '../../cloud-accounts/cloud.port';
import { runCloudBuild } from '../../cloud-builds/cloud-build-run';
import type {
  CloudBuildHalf,
  CloudBuildProgress,
} from '../../cloud-builds/cloud-build-run';
import {
  CLOUD_BUILD_CODE,
  codeBuildBuildspec,
  codeBuildCopyScript,
  codeBuildFiles,
  codeBuildScript,
  IMAGE_EXPORT,
} from '../../cloud-builds/codebuild-program';
import {
  copySignsIn,
  REGISTRY_PASSWORD_VARIABLE,
} from '../../cloud-builds/image-copy-program';
import { writeSourceZip } from '../../cloud-builds/source-zip';
import { describeError } from '../../common/describe-error';
import type { Deployment } from '../../db/schema';
import { applicationBuildProgram } from '../../deployment-engine/application-build-program';
import { cloudBuildDirectory } from '../../deployment-engine/deployment-engine.paths';
import type { DeployableApplication } from '../../deployment-engine/deployment-engine.types';
import type { CloudRunControl } from '../../deployment-queue/cloud-run-job.types';
import { OBJECT_STORAGE } from '../../object-storage/object-storage.port';
import type {
  ObjectStoragePort,
  ObjectStorageTarget,
} from '../../object-storage/object-storage.port';
import { inspectedImage, localImageOf } from './cloud-deploy-steps';

/** Where in the source bucket one Deployment's zip goes. */
export const buildSourcePrefix = (deploymentId: string) =>
  `builds/${deploymentId}/`;

/** The zip's name, in its folder on the host and in the bucket. */
export const SOURCE_ZIP = 'source.zip';

/** The built image's facts, as a Cloud run records them on its row. */
export interface BuiltImage {
  readonly architecture: 'amd64' | 'arm64';
  readonly healthCheck: ImageHealthCheck | null;
}

export interface AwsCloudBuildRequest {
  readonly row: Deployment;
  readonly app: DeployableApplication;
  readonly account: AwsCloudAccount;
  readonly region: string;
  /** A deploy-role session, asked again when near its end. */
  readonly session: () => Promise<AwsCredential>;
  readonly control: CloudRunControl;
  readonly log: (line: string) => Promise<void>;
  /** What the log says of an image of a CPU the cloud does not run. */
  readonly runs: string;
}

/**
 * **AWS's half of a hosted cloud build** (ADR-0047): CodeBuild in the
 * customer's account, on the Environment network's standing project, source
 * bucket and log group (named by `cloud-build-names.ts`). Every call
 * is the deploy role's session through the cloud port (`codebuild:*` on the
 * tagged project) and the object-storage port (the bucket's files); the
 * build itself runs as the Cloud account's build identity, which the project
 * names. `runCloudBuild` drives it.
 *
 * Its Deployment's build slot copied the checkout to
 * {@link cloudBuildDirectory}'s `code/`; this zips it with the build program
 * (`codebuild-program.ts`), uploads the zip to
 * `s3://<source bucket>/builds/<Deployment id>/source.zip`, builds, and
 * removes the zip and the folder, however the build ended.
 *
 * **A ready-made image** has no checkout: its zip is the copy
 * program alone (`codebuild-program.ts`' `codeBuildCopyScript`). A private
 * registry's password is written as this Deployment's own SecureString
 * parameter (`cloud-build-names.ts`), named to CodeBuild as a
 * `PARAMETER_STORE` variable, which CodeBuild reads as the build identity,
 * and deleted once the build has ended, however it ended.
 */
@Injectable()
export class AwsCloudBuilds {
  private readonly logger = new Logger(AwsCloudBuilds.name);
  /** How often CodeBuild is asked about the build; shortened by the e2e suite. */
  pollIntervalMs = 5_000;

  constructor(
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    @Inject(OBJECT_STORAGE) private readonly objectStorage: ObjectStoragePort,
  ) {}

  /** Builds and pushes the image `<Deployment id>`; its CPU and check. */
  async build(request: AwsCloudBuildRequest): Promise<BuiltImage> {
    const { row, app, account, region, session, control, log } = request;
    const names = buildPieceNames({
      accountId: account.cloudId,
      tagValue: account.cloudAccountId,
      environmentId: app.environmentId,
      region,
    });
    const folder = cloudBuildDirectory(app.appName, row.deploymentId);
    const upload = `${folder}/upload`;
    const copies = app.sourceType === 'docker';
    const signsIn = copies && copySignsIn(app);
    const parameterName = registryPasswordParameterName({
      tagValue: account.cloudAccountId,
      deploymentId: row.deploymentId,
    });
    let parameterPut = false;
    try {
      if (!copies && !existsSync(`${folder}/code`)) {
        throw new Error(
          "This Deployment's checkout is not on Cloudgate's host any more, so there is nothing to build; deploy again",
        );
      }
      const registry = `${account.cloudId}.dkr.ecr.${region}.amazonaws.com`;
      const remote = `${registry}/${ecrRepositoryName(app.applicationId)}:${row.deploymentId}`;
      await mkdir(upload, { recursive: true, mode: 0o700 });
      if (copies) {
        await writeSourceZip(`${upload}/${SOURCE_ZIP}`, {
          files: codeBuildFiles(
            codeBuildCopyScript({
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
        await writeSourceZip(`${upload}/${SOURCE_ZIP}`, {
          tree: { path: `${folder}/code`, under: 'code/' },
          files: codeBuildFiles(
            codeBuildScript({
              program: program.command,
              local: localImageOf(app),
              remote,
              registry,
            }),
            program.env,
          ),
        });
      }
      const parameterVariables: CodeBuildParameterVariable[] = [];
      if (signsIn) {
        // Marked before the call: a put that failed half-way is deleted too.
        parameterPut = true;
        await this.putRegistryPassword(
          await session(),
          {
            region,
            name: parameterName,
            value: app.password ?? '',
            tagValue: account.cloudAccountId,
          },
          log,
        );
        parameterVariables.push({
          name: REGISTRY_PASSWORD_VARIABLE,
          parameterName,
        });
      }
      const prefix = buildSourcePrefix(row.deploymentId);
      const exported = await runCloudBuild(
        this.half({
          region,
          projectName: names.projectName,
          bucket: names.sourceBucketName,
          logGroupName: names.logGroupName,
          prefix,
          upload,
          idempotencyToken: row.deploymentId,
          parameterVariables,
          session,
        }),
        { control, log, pollIntervalMs: this.pollIntervalMs },
      );
      return builtImageOf(exported[IMAGE_EXPORT], request.runs, copies);
    } finally {
      if (parameterPut) {
        await this.deleteRegistryPassword(session, region, parameterName, log);
      }
      await rm(folder, { recursive: true, force: true }).catch(
        (error: unknown) =>
          this.logger.warn(
            `The cloud build folder of ${row.deploymentId} was not removed: ${describeError(error)}`,
          ),
      );
    }
  }

  /** The registry password into its SecureString parameter, or a throw naming why not. */
  private async putRegistryPassword(
    session: AwsCredential,
    put: Parameters<AwsCloudPort['putBuildParameter']>[1],
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    await log(
      `🔐 [Copy] Handing the registry password to CodeBuild through SSM Parameter Store, as ${put.name}`,
    );
    const answer = await this.cloud.putBuildParameter(session, put);
    if (!answer.ok) {
      throw new Error(
        `SSM refused the registry password's parameter: ${answer.code}: ${answer.message}`,
      );
    }
  }

  /**
   * The registry password's parameter deleted, however the build ended. A
   * refusal is logged, never thrown over the build's own outcome.
   */
  private async deleteRegistryPassword(
    session: () => Promise<AwsCredential>,
    region: string,
    name: string,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const said = await session()
      .then((credential) =>
        this.cloud.deleteParameter(credential, { region, name }),
      )
      .then((answer) =>
        answer.ok ? null : `${answer.code}: ${answer.message}`,
      )
      .catch((error: unknown) => describeError(error));
    await log(
      said === null
        ? `🧹 [Copy] Removed the registry password's parameter ${name}`
        : `⚠️ [Copy] The registry password's parameter ${name} could not be removed (${said}); delete it in SSM Parameter Store`,
    );
  }

  private half(input: {
    region: string;
    projectName: string;
    bucket: string;
    logGroupName: string;
    prefix: string;
    upload: string;
    idempotencyToken: string;
    parameterVariables: readonly CodeBuildParameterVariable[];
    session: () => Promise<AwsCredential>;
  }): CloudBuildHalf {
    const { region, projectName, bucket, logGroupName, prefix } = input;
    const target = async (): Promise<ObjectStorageTarget> => ({
      endpoint: null,
      region,
      bucket,
      credential: await input.session(),
      pathStyle: false,
    });
    const asked = async <T>(
      call: (session: AwsCredential) => Promise<AwsAnswer<T>>,
      refused: (code: string, message: string) => string,
    ): Promise<T> => {
      const answer = await call(await input.session());
      if (!answer.ok) throw new Error(refused(answer.code, answer.message));
      return answer.value;
    };
    /** The build's log stream, once CodeBuild has named it. */
    let stream: string | null = null;
    return {
      service: 'CodeBuild',
      sourcePlace: `s3://${bucket}/${prefix}${SOURCE_ZIP}`,
      upload: async () => {
        const uploaded = await this.objectStorage.uploadFolder(await target(), {
          directory: input.upload,
          prefix,
        });
        if (!uploaded.ok) {
          throw new Error(
            `The source could not be uploaded to ${bucket}: ${uploaded.message}`,
          );
        }
      },
      start: () =>
        asked(
          (session) =>
            this.cloud.codeBuildStart(session, {
              region,
              projectName,
              sourceLocation: `${bucket}/${prefix}${SOURCE_ZIP}`,
              buildspec: codeBuildBuildspec(),
              idempotencyToken: input.idempotencyToken,
              ...(input.parameterVariables.length
                ? { parameterVariables: input.parameterVariables }
                : {}),
            }),
          (code, message) =>
            code === 'ResourceNotFoundException'
              ? `CodeBuild has no project ${projectName} in ${region}: this Environment network was made before cloud builds. Check for changes, then apply the plan, which makes it (${message})`
              : `CodeBuild refused the build: ${code}: ${message}`,
        ).then((started) => started.buildId),
      progress: async (buildId) => {
        const state = await asked(
          (session) => this.cloud.codeBuildState(session, { region, buildId }),
          (code, message) =>
            `CodeBuild could not be asked about build ${buildId}: ${code}: ${message}`,
        );
        stream = state.logStreamName ?? stream;
        return progressOf(state);
      },
      readLog: async (_buildId, from) => {
        if (stream === null) return { lines: [], next: from };
        const logStreamName = stream;
        const read = await asked(
          (session) =>
            this.cloud.readLogStream(session, {
              region,
              logGroupName,
              logStreamName,
              from,
            }),
          (code, message) => `${code}: ${message}`,
        );
        return { lines: read.messages, next: read.next };
      },
      stop: async (buildId) => {
        await asked(
          (session) => this.cloud.codeBuildStop(session, { region, buildId }),
          (code, message) => `${code}: ${message}`,
        );
      },
      removeSource: async () => {
        const removed = await this.objectStorage.deleteFolder(
          await target(),
          prefix,
        );
        if (!removed.ok) throw new Error(removed.message);
      },
    };
  }
}

/** CodeBuild's answer in the terms both clouds share. */
function progressOf(state: CodeBuildState): CloudBuildProgress {
  if (state.phase !== 'ended') return { phase: state.phase };
  switch (state.status) {
    case 'SUCCEEDED':
      return { phase: 'succeeded', exported: state.exportedVariables };
    case 'STOPPED':
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

/** The image's facts from what the build exported, or a throw naming why not. */
function builtImageOf(
  said: string | undefined,
  runs: string,
  copied = false,
): BuiltImage {
  if (!said?.trim()) {
    throw new Error(
      `CodeBuild ${copied ? 'copied' : 'built'} the image but did not say what it ${copied ? 'copied' : 'built'}, so it cannot be run`,
    );
  }
  const { architecture, healthCheck } = inspectedImage(said);
  if (!architecture) {
    throw new Error(
      `The image is built for ${said.trim().split(/\s/)[0] || 'an unknown CPU'}; ${runs}`,
    );
  }
  return { architecture, healthCheck };
}
