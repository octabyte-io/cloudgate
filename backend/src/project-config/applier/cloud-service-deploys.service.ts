import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { and, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';

import { ApplicationsService } from '../../applications/applications.service';
import {
  CRON_OUTPUTS,
  ECR_ADDRESSES,
  ecrRepositoryName,
  ecsDefinitionOf,
  ecsServiceName,
  logGroupName,
  taskLogStream,
} from '../../cloud-accounts/aws/definitions/web-definition';
import type { CronTask } from '../../cron-services/cron-run.types';
import type { PlanReading } from '../../cloud-accounts/aws/plan-reader/read-plan';
import { setupNames } from '../../cloud-accounts/aws/setup-template';
import type { AwsCloudAccount } from '../../cloud-accounts/cloud-provider';
import { cloudOrLegacy, onCloud } from '../../cloud-accounts/cloud-provider';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import {
  CLOUD_NAMES,
  googleAccountOf,
} from '../../cloud-accounts/cloud-provider';
import type { CloudAccount } from '../../cloud-accounts/cloud-account.schema';
import { AWS_CLOUD_PORT } from '../../cloud-accounts/cloud.port';
import type {
  AwsCloudPort,
  AwsCredential,
  EcsServiceRef,
  StoppedTask,
  TofuApplyRequest,
  TofuShow,
} from '../../cloud-accounts/cloud.port';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import type { Env } from '../../common/config/env.schema';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { deployment, environmentNetwork, plan } from '../../db/schema';
import type { Deployment } from '../../db/schema';
import { CloudReadWorks } from '../../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunJob,
} from '../../deployment-queue/cloud-run-job.types';
import { CloudRunsService } from '../../deployment-queue/cloud-runs.service';
import { environmentNetworkName } from '../../deployments/service-scope';
import { getEnvironmentVariablesObject } from '../../docker/docker.utils';
import { execOnServerStdout } from '../../remote/exec-dispatch';
import { RemoteExecService } from '../../remote/remote-exec.service';
import { withImports } from '../../cloud-accounts/aws/definitions/imports';
import { DEPLOYMENT_NOTIFIER } from '../../deployment-engine/ports/deployment-notifier';
import type {
  DeploymentNotification,
  DeploymentNotifier,
} from '../../deployment-engine/ports/deployment-notifier';
import { DeploymentsService } from '../../deployments/deployments.service';
import { AwsPlanReads } from '../aws-plan-reads.service';
import { credentialOf } from '../../cloud-accounts/cloud-provider';
import { clearWiredChanged, linkedS3Buckets, wiredEnv } from '../outputs';
import { describeError } from '../../common/describe-error';
import type { StoppedDeployPlans } from '../stopped-deploy-plans.service';
import type { CloudRead, PlanStep } from '../planner/plan.types';
import type { PlanStepDeploy } from './apply.types';
import {
  checkBeforeApply,
  cloudDiffers,
  FAILED_TASK_LOG_LINES,
  PUSH_PASSWORD_HOLDER,
  inspectedImage,
  localImageOf,
  pushProgram,
  readImage,
  readNow,
  refusalMessage,
  refusalOf,
  repositoryOnly,
  webEntryOf,
} from './cloud-deploy-steps';
import type { Approval, LocalImageSource } from './cloud-deploy-steps';
import type { ImageHealthCheck } from '../../cloud-accounts/aws/definitions/container-health-check';
import { deployedDomains } from './deployed-domains';
import {
  CLOUD_RUN_RUNS,
  GOOGLE_CLOUD,
  GoogleServiceDeploys,
} from './google-service-deploys.service';
import { liveImageOf } from './live-image';
import { blameNativeAws, storedNativeAwsRefusal } from '../../native/aws-lay';
import { buildsInItsCloud } from '../../cloud-builds/cloud-build-place';
import { CLOUD_RUN_PLATFORM } from '../../deployment-engine/cloud-build';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { AwsCloudBuilds } from './aws-cloud-builds.service';
import type { BuiltImage } from './aws-cloud-builds.service';

/** A read an Apply approved, with the live image it was made on, when it was. */
export type ApprovedRead = PlanReading & { readonly liveImage?: string | null };

export { FAILED_TASK_LOG_LINES } from './cloud-deploy-steps';

/** What an image of another CPU is told on ECS. */
const FARGATE_RUNS = 'Fargate runs x86 (amd64) or ARM (arm64) images only';

/**
 * What a hosted cloud build's definition is written with before the build
 * has said what it built: only a first deploy's ECR repository is
 * applied from it, which no image's facts change. The Service's own apply
 * is written again from the built image.
 */
const NOT_BUILT_YET: BuiltImage = { architecture: 'amd64', healthCheck: null };

/** A deploy-role session is asked again after this long (STS gives 15 minutes). */
const SESSION_REFRESH_MS = 10 * 60_000;

/**
 * **A cloud `web`'s deploy** (the AWS spec "Image and ECR", "Running the
 * work"): the Cloud run that follows its build.
 *
 * One Deployment row and one Deployment log. The build (or the pull of a
 * ready-made image) runs as today in the build slot on the platform host
 * (`DeploymentEngineService.deploy`); the queue then hands the row to the
 * Cloud run pool as a `deploy` run, freeing the build slot, and this runs it:
 *
 * **On the Hosted instance** (ADR-0047) the build slot only checked
 * the source out, and the build itself is this run's: CodeBuild in the
 * Cloud account (`AwsCloudBuilds`), in place of steps 2's inspect and 4's
 * push. It comes after step 3, since the build pushes into the repository,
 * and its image's CPU and `HEALTHCHECK` write the definition step 5 applies.
 *
 * 1. the Cloud account's key takes on its deploy role, or the run fails
 *    before any change, naming the Cloud account and AWS's words, and the
 *    failure is recorded on the Cloud account;
 * 2. the image's CPU (`docker image inspect`) picks the task's runtime
 *    platform, and the Service's definition is written with the
 *    Deployment's id as the image tag;
 * 3. **a first deploy makes its ECR repository first.** The repository is a
 *    create in the Service's own plan and lives in its state (the AWS spec),
 *    so nothing exists to push into until a run has applied it. A first
 *    deploy therefore reads AWS again and checks the whole plan against what
 *    was approved, then applies only the repository and its lifecycle rule
 *    (`-target`), and only then pushes. Every later deploy pushes straight
 *    away. This keeps the push before the apply, which is what lets the
 *    task definition name an image that exists;
 * 4. a fresh ECR token per Deployment (the cloud port), one `docker login`
 *    against a throwaway `DOCKER_CONFIG` with the password in the
 *    environment only, the push, and the local copy removed;
 * 5. AWS read again, and the apply only if that plan is what was approved
 *    (`cloud-deploy-steps.ts`' `refusalOf`);
 * 6. `replicas` written back as the ECS desired count (the definition leaves
 *    the running count to Stop and Start, so it is set here), then a wait
 *    for ECS to call the new tasks steady. A new task that stops ends the
 *    Deployment `error`, quoting its `stoppedReason` and its last
 *    {@link FAILED_TASK_LOG_LINES} log lines; otherwise nothing of the app's
 *    is quoted;
 * 7. once steady, every ECR image but the live one is removed.
 *
 * What it does is read from the Deployment row, so a run start-up queues
 * again runs alike.
 *
 * **On Google Cloud** (the Google Cloud spec) the run dispatches on the Cloud
 * account's cloud: what it may apply is worked out here alike, and the rest
 * is `GoogleServiceDeploys`' — an Artifact Registry repository, a push as
 * `oauth2accesstoken`, and a wait for the new Cloud Run revision.
 *
 * **The auto-apply rule** (the AWS spec): a deploy no Apply queued — a
 * push's, a console Save's, a redeploy, an Agent's — applies on its own only
 * an image-only plan, or, until the Service's first Cloud run finishes, what
 * its create's plan listed. On Google (S19) image-only is one update
 * of the Cloud Run service changing only a container's image, so a secret
 * or setting beside it is not.
 * Anything else (drift, a create, a destroy, any other replace) stops it at
 * step 3 or 5, before any change: the Deployment ends `error` with
 * {@link cloudDiffers} naming its cloud, and its whole plan becomes the
 * Environment's open plan, linked both ways (`StoppedDeployPlans`).
 *
 * **A put-back** (the AWS spec "Drift"): the Apply of a plan whose step
 * only found Drift queues a Deployment that runs the live image — no build,
 * no push — and applies exactly the read that Apply approved, putting AWS
 * back to Cloudgate's version. An Apply that approved what it adopts by tag
 * imports it (`import` blocks), so nothing is made twice.
 */
/** What a deploy no Apply queued met beyond its new image, and the plan it met it in. */
interface Differs {
  readonly reading: PlanReading;
  readonly show: TofuShow;
  readonly detail: string;
}

@Injectable()
export class CloudServiceDeploys implements OnModuleInit {
  private readonly logger = new Logger(CloudServiceDeploys.name);
  /** What each Apply approved for the deploy it queued, until its run reads it. */
  private readonly approved = new Map<string, ApprovedRead>();
  /** How often the wait for steady asks ECS; shortened by the e2e suite. */
  pollIntervalMs = 5_000;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly awsReads: AwsPlanReads,
    private readonly applications: ApplicationsService,
    private readonly remoteExec: RemoteExecService,
    private readonly moduleRef: ModuleRef,
    private readonly config: ConfigService<Env, true>,
    private readonly deployments: DeploymentsService,
    private readonly google: GoogleServiceDeploys,
    private readonly instanceMode: InstanceMode,
    private readonly cloudBuilds: AwsCloudBuilds,
  ) {}

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  /**
   * Queues a put-back: a Deployment of the Service on the live image
   * its approved read was made on, with nothing built or pushed, whose Cloud
   * run applies that read. Refused, with nothing queued, when the Service
   * has no live image or another one went live since the plan was read.
   * Named for its Cloud account's cloud: "Put Google Cloud back".
   */
  async putBack(
    applicationId: string,
    aws: Extract<CloudRead, { status: 'read' }>,
  ): Promise<PlanStepDeploy> {
    const app = await this.applications.findDeployable(applicationId);
    const live = await liveImageOf(this.db, applicationId);
    const account = app.cloudAccountId
      ? await this.cloudAccounts.findForUse(app.cloudAccountId)
      : null;
    const cloud = CLOUD_NAMES[cloudOrLegacy(account?.cloud)];
    if (!live || !aws.liveImage) {
      return {
        status: 'not-deployed',
        message: `${app.name} has no live image yet to put ${cloud} back with; deploy it, then Check for changes`,
      };
    }
    if (live.tag !== aws.liveImage) {
      return {
        status: 'not-deployed',
        message: `${app.name} runs another image since this plan read ${cloud}; Check for changes, then apply the new plan`,
      };
    }
    const row = await this.deployments.recordApplicationCloudRun({
      applicationId,
      appName: app.appName,
      title: `Put ${cloud} back`,
      description: `Queued by applying a plan: Cloudgate's version is put back in ${cloud}, on the live image`,
    });
    this.approve(row.deploymentId, aws);
    await this.cloudRuns.handOff(row.deploymentId, {
      kind: 'deploy',
      stateKey: `application:${applicationId}`,
      environmentId: app.environmentId,
      touchesNetwork: false,
      liveImage: live.tag,
      architecture: live.architecture,
      healthCheck: live.healthCheck,
    });
    return { status: 'queued', deploymentId: row.deploymentId };
  }

  onModuleInit(): void {
    this.moduleRef
      .get(CloudReadWorks, { strict: false })
      .handle('deploy', (job, control) => this.run(job, control));
  }

  /**
   * The Deployment's outcome to the Organization's notification channels,
   * as a Server's build announces its own (the AWS spec: the same Deployment as
   * a Docker deploy). The build's own failure is the engine's to announce;
   * this is the Cloud run's: done, or why not ("AWS differs …" included).
   * A notification that cannot be sent never changes the outcome.
   */
  private async announce(
    applicationId: string,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      const app = await this.applications.findDeployable(applicationId);
      const notification: DeploymentNotification = {
        projectName: app.environment.project.name,
        applicationName: app.name,
        applicationType: 'application',
        environmentName: app.environment.name,
        organizationId: app.environment.project.organizationId,
        projectId: app.environment.projectId,
        environmentId: app.environmentId,
        serviceId: app.applicationId,
      };
      const notifier = this.moduleRef.get<DeploymentNotifier>(
        DEPLOYMENT_NOTIFIER,
        { strict: false },
      );
      await (errorMessage === null
        ? notifier.buildSuccess(notification)
        : notifier.buildError({ ...notification, errorMessage }));
    } catch (error) {
      this.logger.warn(
        `The outcome of ${applicationId}'s Cloud run was not announced: ${describeError(error)}`,
      );
    }
  }

  /** The plan step an Apply approved for the Deployment it queued. */
  approve(deploymentId: string, reading: ApprovedRead): void {
    this.approved.set(deploymentId, reading);
  }

  private async run(job: CloudRunJob, control: CloudRunControl) {
    const [row] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, job.deploymentId ?? ''));
    if (!row?.applicationId) {
      throw new Error('This Cloud run records no Service');
    }
    try {
      await this.deploy(row, row.applicationId, control);
      await this.applications.updateStatus(row.applicationId, 'done');
      await this.announce(row.applicationId, null);
    } catch (error) {
      await this.applications
        .updateStatus(row.applicationId, 'error')
        .catch(() => undefined);
      await this.announce(row.applicationId, describeError(error));
      throw error;
    } finally {
      this.approved.delete(row.deploymentId);
    }
  }

  private async deploy(
    row: Deployment,
    applicationId: string,
    control: CloudRunControl,
  ): Promise<void> {
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    const app = await this.applications.findDeployable(applicationId);
    if (!app.cloudAccountId || !app.region) {
      throw new Error(`${app.name} does not run in a Cloud account`);
    }
    const region = app.region;
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      app.cloudAccountId,
    );
    if (!cloudAccountRow)
      throw new Error('The Cloud account this Service runs in is gone');
    // Each cloud's half (ADR-0043).
    await onCloud(cloudAccountRow, {
      aws: (account) =>
        this.deployOnAws(row, app, region, account, control, log),
      gcp: (account) => this.deployOnGoogle(row, app, account, control, log),
    });
  }

  /** A `web`'s deploy on ECS. */
  private async deployOnAws(
    row: Deployment,
    app: Awaited<ReturnType<ApplicationsService['findDeployable']>>,
    region: string,
    account: AwsCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const applicationId = app.applicationId;
    const state = await this.states.findForApplication(applicationId);
    if (!state) throw new Error(`${app.name} has no Infrastructure state`);
    const network = await this.readyNetwork(app.environmentId, account, region);

    await log(
      `☁️ [Cloud run] Deploying ${app.name} to Cloud account ${account.name} in ${region}, Infrastructure state ${state.infrastructureStateId}`,
    );
    const credential = credentialOf(account);
    const session = this.sessions(account, credential);
    await session();

    // A put-back runs the live image as it is: nothing to inspect or push.
    const putBack = row.cloudRun?.liveImage ?? null;
    const local = localImageOf(app);
    const imageTag = putBack ?? row.deploymentId;
    // ADR-0047: on the Hosted instance the image is built here, in
    // CodeBuild, and says what it is once built; a ready-made image is
    // copied there, never pulled on the platform host.
    const inItsCloud =
      !putBack && buildsInItsCloud(this.instanceMode.isHosted, app);
    // A put-back runs the live image with the check its deploy recorded
    // so it writes the task definition that deploy did.
    const image: BuiltImage | null = putBack
      ? {
          architecture: row.cloudRun?.architecture ?? 'amd64',
          healthCheck: row.cloudRun?.healthCheck ?? null,
        }
      : inItsCloud
        ? null
        : await this.inspectImage(row, local);
    if (putBack) {
      await log(
        `♻️ [Cloud run] Putting AWS back to Cloudgate's version, on the live image ${putBack}`,
      );
    }
    // Resolved as a Server's container env is (`mechanize.ts`); written to
    // AWS by this run alone, so a task ECS restarts gets this deploy's.
    // Its wired variables are built now from their sources and win
    // over a typed value, as on a Server; each is one more SecureString,
    // never kept, never in the task definition.
    const wiredBuiltAt = new Date().toISOString();
    const values = {
      ...getEnvironmentVariablesObject(
        app.env,
        app.environment.project.env,
        app.environment.env,
      ),
      ...(await wiredEnv(this.db, app.environmentId, app.configLinks)),
    };
    // The names whose parameters this deploy writes: an emptied variable's
    // parameter is one the deploy removes.
    const variableNames = Object.keys(values).filter(
      (name) => values[name] !== '',
    );
    const cron = app.configKind === 'cron';
    // A link is the access: the task role reaches what it links.
    const buckets = await linkedS3Buckets(
      this.db,
      app.environmentId,
      app.configLinks,
    );
    // Its stored `native.aws`, refused whole, before anything
    // changes, when it now holds a value locked since it was applied.
    const refusedNative = storedNativeAwsRefusal(
      app.configName ?? app.appName,
      app.configKind,
      app.nativeAws,
      { linkedKinds: buckets.length > 0 ? ['bucket'] : [] },
    );
    if (refusedNative) throw new Error(refusedNative);
    const domains = cron ? [] : await deployedDomains(this.db, applicationId);
    // A `web` behind its target group, a Worker routed by nothing,
    // a Cron service its task definition with no ECS service.
    const generatedFor = ({ architecture, healthCheck }: BuiltImage) =>
      ecsDefinitionOf(
        app.configKind,
        {
          configName: app.configName ?? app.appName,
          entry: webEntryOf(app),
          service: { serviceId: applicationId, replicas: app.replicas },
          account: {
            awsAccountId: account.cloudId,
            deployRoleArn: account.deployRoleArn,
            externalId: account.externalId,
            cloudAccountId: account.cloudAccountId,
            taskExecutionRoleArn: account.taskExecutionRoleArn,
            permissionsBoundaryArn: setupNames({
              accountId: account.cloudId,
              tagValue: account.cloudAccountId,
            }).boundaryPolicyArn,
          },
          region,
          environmentId: app.environmentId,
          stateId: state.infrastructureStateId,
          network,
          image: { tag: imageTag, architecture, healthCheck },
          variables: {
            values,
            digestSecret: this.config.get('APP_ENCRYPTION_SECRET', {
              infer: true,
            }),
          },
          buckets,
          // What its last Apply laid, over Cloudgate's definition.
          native: app.nativeAws,
        },
        {
          port: app.port,
          domains,
        },
      );

    const byApply =
      this.approved.get(row.deploymentId) ??
      (await this.approvedByApply(row.deploymentId, app.configName));
    if (putBack && !byApply) {
      throw new Error(
        'No applied plan names this put-back, so it changes nothing. Check for changes, then apply the new plan',
      );
    }
    // Before a first Cloud run finished, its ECR repository and the rest of
    // its create are still to make.
    const firstRun =
      !putBack && !(await this.hasLiveImage(applicationId, row.deploymentId));
    const approval: Approval = {
      byApply,
      listed: firstRun
        ? await this.lastApplied(app.configPlanId, app.configName)
        : null,
      newImage:
        byApply?.liveImage !== undefined && byApply.liveImage !== imageTag,
    };
    const requestFor = (built: BuiltImage): TofuApplyRequest => {
      const generated = generatedFor(built);
      if (!generated.ok) throw new Error(generated.refusal.message);
      return {
        stateId: state.infrastructureStateId,
        credential,
        // What the Apply adopts by tag is imported, not made again.
        definition: withImports(generated.definition, byApply?.adopt ?? []),
        variables: generated.variables,
        onLine: (line) => void log(line),
        signal: control.signal,
      };
    };
    let request = requestFor(image ?? NOT_BUILT_YET);

    let made = new Set<string>();
    // What a deploy no Apply queued met beyond its new image: it
    // stops before any change, and its plan is left open for review.
    let differs: Differs | null = null;
    const refuse = (now: PlanReading, show: TofuShow): string | null => {
      const refusal = refusalOf(approval, now, made);
      if (refusal?.kind === 'differs') {
        differs = { reading: now, show, detail: refusal.detail };
      }
      return refusal ? refusalMessage(refusal) : null;
    };
    const stop = (message: string): Promise<never> =>
      differs
        ? this.stopForReview(
            row,
            app,
            state.infrastructureStateId,
            differs,
            log,
            {
              cloudName: 'AWS',
              // The plan it opens searches by the state's tag, as every
              // plan does: what a lost state would make twice reads
              // as adopt there.
              search: (show) =>
                session().then((session) =>
                  this.awsReads.readFound(
                    {
                      session,
                      region,
                      account,
                      environmentId: app.environmentId,
                    },
                    show,
                    state.infrastructureStateId,
                    { variableNames },
                  ),
                ),
            },
          )
        : Promise.reject(new Error(message));

    if (firstRun) {
      await log('Reading AWS again before anything changes');
      const planned = await this.states.plan(request);
      if (!planned.ok) {
        throw new Error(blameNativeAws(planned.message, app.nativeAws));
      }
      const refused = refuse(
        readNow(planned.show, variableNames),
        planned.show,
      );
      if (refused) return stop(refused);
      await log(
        `📦 [Push] Making the Service's ECR repository first, so the image has somewhere to go`,
      );
      const repository = await this.states.apply({
        ...request,
        targets: [...ECR_ADDRESSES],
        beforeApply: (show) =>
          checkBeforeApply(
            show,
            repositoryOnly(ECR_ADDRESSES),
            () => control.beginApply(),
            variableNames,
          ),
      });
      if (!repository.ok) {
        throw new Error(blameNativeAws(repository.message, app.nativeAws));
      }
      made = new Set(readNow(repository.show).raw.map((line) => line.address));
    }

    if (inItsCloud) {
      const built = await this.cloudBuilds.build({
        row,
        app,
        account,
        region,
        session,
        control,
        log,
        runs: FARGATE_RUNS,
      });
      await this.recordImage(row, built);
      request = requestFor(built);
    } else if (!putBack) {
      await this.push(row, app, region, await session(), log);
    }

    await log('Reading AWS again before applying');
    const applied = await this.states.apply({
      ...request,
      beforeApply: (show) => {
        // What the apply does, in the plan's own words: names only, values
        // never, the Advanced parameter's cost on its line.
        for (const line of readNow(show, variableNames).summary) {
          void log(`📋 [Cloud run] ${line}`);
        }
        return checkBeforeApply(
          show,
          refuse,
          () => control.beginApply(),
          variableNames,
        );
      },
    });
    // A value only AWS can judge names the native path it refused.
    if (!applied.ok)
      return stop(blameNativeAws(applied.message, app.nativeAws));

    // A Cron service has no ECS service to scale or wait on: its
    // deploy registers a new task definition revision, which every run
    // started from now on is a task of, and starts none.
    if (cron) {
      await this.registerCronTask(row, app.name, applied.outputs, imageTag);
      await this.removeOlderImages(
        await session(),
        region,
        applicationId,
        imageTag,
        log,
      );
      await clearWiredChanged(
        this.db,
        { serviceType: 'application', serviceId: applicationId },
        wiredBuiltAt,
      );
      await log(
        putBack
          ? `✅ [Cloud run] AWS is Cloudgate's version again; ${app.name}'s runs start from its live image`
          : `✅ [Cloud run] ${app.name}'s runs start from the image of this Deployment; no run was started`,
      );
      return;
    }

    const service: EcsServiceRef = {
      region,
      cluster: network.clusterArn,
      service:
        typeof applied.outputs.ecs_service_name === 'string'
          ? applied.outputs.ecs_service_name
          : ecsServiceName(app.configName ?? app.appName, applicationId),
    };
    const scaled = await this.cloud.ecsSetDesiredCount(await session(), {
      ...service,
      desiredCount: app.replicas,
    });
    if (!scaled.ok) {
      throw new Error(
        `ECS refused the running count of ${app.replicas}: ${scaled.code}: ${scaled.message}`,
      );
    }
    await log(
      `⏳ [Cloud run] Waiting for ECS to call ${app.replicas} new task${app.replicas === 1 ? '' : 's'} steady`,
    );
    // A task ECS stops for a native value (a health check the image cannot
    // run) names that path too.
    await this.awaitSteady(service, session, control, async (task) => {
      await this.quoteFailedTask(
        task,
        await session(),
        region,
        logGroupName(app.environmentId, applicationId),
        log,
      );
    }).catch((error: unknown) => {
      const message = describeError(error);
      const blamed = blameNativeAws(message, app.nativeAws);
      throw blamed === message ? error : new Error(blamed);
    });

    await this.removeOlderImages(
      await session(),
      region,
      applicationId,
      imageTag,
      log,
    );
    // A "deploy to pick up the new value" notice marked before the
    // variables above were built is answered by this deploy.
    await clearWiredChanged(
      this.db,
      { serviceType: 'application', serviceId: applicationId },
      wiredBuiltAt,
    );
    await log(
      putBack
        ? `✅ [Cloud run] AWS is Cloudgate's version again; ${app.name} runs its live image`
        : `✅ [Cloud run] ${app.name} runs the image of this Deployment`,
    );
  }

  /** Every ECR image but the live one removed, once a deploy is done. */
  private async removeOlderImages(
    session: AwsCredential,
    region: string,
    applicationId: string,
    imageTag: string,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const cleaned = await this.cloud.ecrDeleteImagesExcept(session, {
      region,
      repositoryName: ecrRepositoryName(applicationId),
      keepTag: imageTag,
    });
    await log(
      cleaned.ok
        ? `🧹 [Push] Removed ${cleaned.value.deleted} older image${cleaned.value.deleted === 1 ? '' : 's'} from ECR; only the live one is kept`
        : `⚠️ [Push] Older images were not removed from ECR (${cleaned.code}: ${cleaned.message}); the next deploy removes them`,
    );
  }

  /**
   * What a Cron service's deploy registered, onto its Deployment:
   * the task definition revision and security group each later run is
   * started with, and the image they run, named in each run's first line.
   * A run in flight keeps the revision it started on.
   */
  private async registerCronTask(
    row: Deployment,
    name: string,
    outputs: Record<string, unknown>,
    imageTag: string,
  ): Promise<void> {
    const taskDefinitionArn = outputs[CRON_OUTPUTS.taskDefinitionArn];
    const securityGroupId = outputs[CRON_OUTPUTS.securityGroupId];
    if (
      typeof taskDefinitionArn !== 'string' ||
      typeof securityGroupId !== 'string'
    ) {
      throw new Error(
        `AWS answered no task definition for ${name}, so no run could start from this Deployment`,
      );
    }
    const repository = outputs.ecr_repository_url;
    const cronTask: CronTask = { taskDefinitionArn, securityGroupId };
    await this.db
      .update(deployment)
      .set({
        cloudRun: sql`coalesce(${deployment.cloudRun}, '{}'::jsonb) || ${JSON.stringify({ cronTask })}::jsonb`,
        ...(typeof repository === 'string'
          ? { cronImage: `${repository}:${imageTag}` }
          : {}),
      })
      .where(eq(deployment.deploymentId, row.deploymentId));
  }

  /**
   * A Service on Cloud Run (the Google Cloud spec): what it may apply worked out as on
   * AWS, the rest Google's (`GoogleServiceDeploys`).
   */
  private async deployOnGoogle(
    row: Deployment,
    app: Awaited<ReturnType<ApplicationsService['findDeployable']>>,
    accountRow: CloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const state = await this.states.findForApplication(app.applicationId);
    if (!state) throw new Error(`${app.name} has no Infrastructure state`);
    const stateId = state.infrastructureStateId;
    const putBack = row.cloudRun?.liveImage ?? null;
    const imageTag = putBack ?? row.deploymentId;
    const byApply =
      this.approved.get(row.deploymentId) ??
      (await this.approvedByApply(row.deploymentId, app.configName));
    if (putBack && !byApply) {
      throw new Error(
        'No applied plan names this put-back, so it changes nothing. Check for changes, then apply the new plan',
      );
    }
    const firstRun =
      !putBack &&
      !(await this.hasLiveImage(app.applicationId, row.deploymentId));
    // ADR-0047: on the Hosted instance the image is built in
    // Cloud Build, in this run, and says what it is once built; a
    // ready-made image is copied there.
    const inItsCloud =
      !putBack && buildsInItsCloud(this.instanceMode.isHosted, app);
    await this.google.deploy({
      row,
      app,
      account: googleAccountOf(accountRow),
      stateId,
      control,
      log,
      putBack,
      imageTag,
      firstRun,
      approval: {
        byApply,
        listed: firstRun
          ? await this.lastApplied(app.configPlanId, app.configName)
          : null,
        newImage:
          byApply?.liveImage !== undefined && byApply.liveImage !== imageTag,
      },
      architecture: () =>
        putBack
          ? Promise.resolve(row.cloudRun?.architecture ?? 'amd64')
          : // Its HEALTHCHECK recorded too, which a plan notes Cloud Run
            // cannot run; no probe is written from it.
            this.inspectImage(
              row,
              localImageOf(app),
              CLOUD_RUN_RUNS,
              CLOUD_RUN_PLATFORM,
            ).then((image) => image.architecture),
      buildsInItsCloud: inItsCloud,
      recordImage: (image) => this.recordImage(row, image),
      // Google keeps no tag to search by; the plan shows what was read.
      stopForReview: (differs) =>
        this.stopForReview(row, app, stateId, differs, log, {
          cloudName: GOOGLE_CLOUD,
          search: null,
        }),
    });
  }

  /**
   * The built image (`docker image inspect`, once): its CPU, which picks the
   * task's runtime platform on ECS and is checked before any push to Cloud
   * Run, and its `HEALTHCHECK`, which a task on ECS
   * runs and a plan on Google Cloud notes Cloud Run cannot. The two
   * are recorded on the row together, so a put-back, a plan and a drift
   * read write what this deploy does. `runs` says which CPUs the Service's
   * cloud runs, for an image of another. `pulledFor` is the platform the
   * image was pulled for (Cloud Run's), or `null` for the host's own (ECS's).
   */
  private async inspectImage(
    row: Deployment,
    local: string,
    runs = FARGATE_RUNS,
    pulledFor: string | null = null,
  ): Promise<{
    architecture: 'amd64' | 'arm64';
    healthCheck: ImageHealthCheck | null;
  }> {
    const said = await readImage(
      (argv) => execOnServerStdout(this.remoteExec, null, argv),
      local,
      pulledFor,
    ).catch((error: unknown) => {
      const { stderr, message } = error as {
        stderr?: string;
        message?: string;
      };
      throw new Error(
        `The image ${local} could not be inspected on Cloudgate's host: ${stderr?.trim() || message}`,
      );
    });
    const { architecture, healthCheck } = inspectedImage(said);
    if (!architecture) {
      throw new Error(
        `The image is built for ${said.trim().split(/\s/)[0] || 'an unknown CPU'}; ${runs}`,
      );
    }
    await this.recordImage(row, { architecture, healthCheck });
    return { architecture, healthCheck };
  }

  /**
   * The image's CPU and check onto the row, so a put-back, a plan and a
   * drift read write what this deploy does.
   */
  private async recordImage(row: Deployment, image: BuiltImage): Promise<void> {
    const { architecture, healthCheck } = image;
    await this.db
      .update(deployment)
      .set({
        cloudRun: sql`coalesce(${deployment.cloudRun}, '{}'::jsonb) || ${JSON.stringify({ architecture, healthCheck })}::jsonb`,
      })
      .where(eq(deployment.deploymentId, row.deploymentId));
  }

  /**
   * A deploy no Apply queued that met more than its new image: what
   * it met into its log, its whole plan stored as the Environment's open
   * plan and linked both ways, and the Deployment ended `error` with
   * {@link cloudDiffers}. Nothing in the cloud was changed. `search` reads
   * what a lost state would make twice, where the cloud has one.
   */
  async stopForReview(
    row: Deployment,
    app: {
      applicationId: string;
      environmentId: string;
      name: string;
      configName: string | null;
      appName: string;
    },
    stateId: string,
    differs: Differs,
    log: (line: string) => Promise<void>,
    cloud: {
      readonly cloudName: string;
      readonly search:
        | ((
            show: TofuShow,
          ) => Promise<
            { ok: true; reading: PlanReading } | { ok: false; reason: string }
          >)
        | null;
    },
  ): Promise<never> {
    await log(
      `⛔ [Cloud run] ${cloud.cloudName} differs from what Cloudgate made, so nothing was applied: ${differs.detail}`,
    );
    const found = cloud.search
      ? await cloud.search(differs.show).catch((error: unknown) => ({
          ok: false as const,
          reason: describeError(error),
        }))
      : null;
    if (found && !found.ok) {
      await log(
        `🔎 [Cloud run] The search by Cloudgate's tags failed (${found.reason}); the plan shows what the deploy read without it`,
      );
    }
    const reading = found?.ok ? found.reading : differs.reading;
    const opened = await this.stoppedPlans.open(
      row.deploymentId,
      {
        applicationId: app.applicationId,
        environmentId: app.environmentId,
        configName: app.configName ?? app.appName,
        name: app.name,
      },
      {
        status: 'read',
        ...reading,
        stateId,
        serviceId: app.applicationId,
        readAt: new Date().toISOString(),
      },
    );
    await log(
      opened.ok
        ? `📋 [Cloud run] Its whole plan is the Environment's open plan now (${opened.planId}): review it, then Apply`
        : `📋 [Cloud run] Its plan could not be stored (${opened.reason}); Check for changes to see it`,
    );
    throw new Error(cloudDiffers(cloud.cloudName));
  }

  /**
   * Where a stopped deploy's plan is stored. It plans through the plan
   * store, whose applier holds this service, so it hands itself in at
   * start-up rather than being injected here.
   */
  private stoppedPlans!: Pick<StoppedDeployPlans, 'open'>;

  reviewWith(plans: Pick<StoppedDeployPlans, 'open'>): void {
    this.stoppedPlans = plans;
  }

  /**
   * A deploy-role session, asked once and again when it is near its end.
   * The first refusal fails the run before any change, as a plan read's
   * does, and is recorded on the Cloud account.
   */
  private sessions(
    account: AwsCloudAccount,
    credential: AwsCredential,
  ): () => Promise<AwsCredential> {
    let held: { session: AwsCredential; at: number } | null = null;
    return async () => {
      if (held && Date.now() - held.at < SESSION_REFRESH_MS) {
        return held.session;
      }
      const answer = await this.cloudAccounts.deployRoleSession(
        account,
        credential,
      );
      if (!answer.ok) throw new Error(answer.refusal);
      held = { session: answer.session, at: Date.now() };
      return answer.session;
    };
  }

  /** A fresh ECR token, one login, the push, and the copies it owns removed. */
  private async push(
    row: Deployment,
    app: LocalImageSource,
    region: string,
    session: AwsCredential,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const token = await this.cloud.ecrAuthorizationToken(session, region);
    if (!token.ok) {
      throw new Error(
        `ECR refused a push credential: ${token.code}: ${token.message}`,
      );
    }
    const repository = `${token.value.registry}/${ecrRepositoryName(row.applicationId ?? '')}`;
    const remote = `${repository}:${row.deploymentId}`;
    await log(`📦 [Push] Uploading image to '${remote}'`);
    try {
      await this.remoteExec.execAsync(
        pushProgram({
          registry: token.value.registry,
          username: token.value.username,
          app,
          remote,
          logPath: row.logPath,
        }),
        {
          env: { ...process.env, [PUSH_PASSWORD_HOLDER]: token.value.password },
        },
      );
    } catch {
      throw new Error(
        `The image of ${app.appName} could not be pushed to its ECR repository; the lines above say why`,
      );
    }
    await log('✅ Image Pushed');
  }

  /** Polls ECS until the new tasks are steady, or one of them stopped. */
  private async awaitSteady(
    service: EcsServiceRef,
    session: () => Promise<AwsCredential>,
    control: CloudRunControl,
    onStopped: (task: StoppedTask) => Promise<void>,
  ): Promise<void> {
    for (;;) {
      if (control.signal.interrupted) {
        throw new Error('The run was ended while ECS started the new tasks');
      }
      const rollout = await this.cloud.ecsRollout(await session(), service);
      if (!rollout.ok) {
        throw new Error(
          `ECS could not be asked about the new tasks: ${rollout.code}: ${rollout.message}`,
        );
      }
      const { state, reason, stoppedTask } = rollout.value;
      if (stoppedTask) {
        await onStopped(stoppedTask);
        throw new Error(
          `A new task failed to start: ${stoppedTask.stoppedReason}`,
        );
      }
      if (state === 'completed') return;
      if (state === 'failed') {
        throw new Error(
          `ECS could not start the new tasks${reason ? `: ${reason}` : ''}`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pollIntervalMs);
        control.signal.onInterrupt(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** The stopped task's reason and its last log lines, into the Deployment log. */
  private async quoteFailedTask(
    task: StoppedTask,
    session: AwsCredential,
    region: string,
    group: string,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    await log(
      `❌ [Cloud run] Task ${task.taskId} stopped: ${task.stoppedReason}`,
    );
    const events = await this.cloud
      .filterLogEvents(session, {
        region,
        logGroupName: group,
        logStreamNames: [taskLogStream(task.taskId)],
        limit: FAILED_TASK_LOG_LINES,
      })
      .catch((error: unknown) => ({
        ok: false as const,
        code: 'Unreachable',
        message: describeError(error),
      }));
    if (!events.ok) {
      await log(
        `Its log could not be read (${events.code}: ${events.message})`,
      );
      return;
    }
    if (events.value.length === 0) {
      await log('It printed nothing to its log');
      return;
    }
    await log(`Its last ${events.value.length} log lines:`);
    for (const event of events.value) await log(`  ${event.message}`);
  }

  /** The Environment network's saved ids there, or the run fails saying so. */
  private async readyNetwork(
    environmentId: string,
    account: AwsCloudAccount,
    region: string,
  ) {
    const [found] = await this.db
      .select()
      .from(environmentNetwork)
      .where(
        and(
          eq(environmentNetwork.environmentId, environmentId),
          eq(environmentNetwork.cloudAccountId, account.cloudAccountId),
          eq(environmentNetwork.region, region),
          eq(environmentNetwork.status, 'ready'),
          isNotNull(environmentNetwork.vpcId),
          isNotNull(environmentNetwork.publicSubnetIds),
          isNotNull(environmentNetwork.clusterArn),
          isNotNull(environmentNetwork.httpsListenerArn),
          isNotNull(environmentNetwork.albSecurityGroupId),
        ),
      );
    if (!found) {
      throw new Error(
        `The ${environmentNetworkName(region)} is not made, so there is nowhere to run this Service. Check for changes, then apply the plan`,
      );
    }
    return {
      vpcId: found.vpcId!,
      publicSubnetIds: found.publicSubnetIds!,
      clusterArn: found.clusterArn!,
      httpsListenerArn: found.httpsListenerArn!,
      albSecurityGroupId: found.albSecurityGroupId!,
      // What a Private web service is listed in; a web or a Worker
      // never reads it.
      ...(found.privateDnsNamespaceId
        ? { privateDnsNamespaceId: found.privateDnsNamespaceId }
        : {}),
    };
  }

  /**
   * Whether an earlier Cloud run of this Service finished: its repository
   * is made, and an image of it is live.
   */
  async hasLiveImage(
    applicationId: string,
    deploymentId: string,
  ): Promise<boolean> {
    const [found] = await this.db
      .select({ id: deployment.deploymentId })
      .from(deployment)
      .where(
        and(
          eq(deployment.applicationId, applicationId),
          ne(deployment.deploymentId, deploymentId),
          eq(deployment.status, 'done'),
          isNotNull(deployment.cloudRun),
        ),
      )
      .orderBy(desc(deployment.createdAt))
      .limit(1);
    return found !== undefined;
  }

  /** What the Apply that queued this Deployment approved, read off its plan. */
  async approvedByApply(
    deploymentId: string,
    configName: string | null,
  ): Promise<ApprovedRead | null> {
    const [found] = await this.db
      .select({ steps: plan.steps })
      .from(plan)
      .where(
        sql`jsonb_contains(${plan.results}, ${JSON.stringify([{ deploy: { deploymentId } }])}::jsonb)`,
      )
      .limit(1);
    return found ? stepReading(found.steps, configName) : null;
  }

  /** The Service's step in the plan that last wrote it, if it read AWS. */
  async lastApplied(
    planId: string | null,
    configName: string | null,
  ): Promise<PlanReading | null> {
    if (!planId) return null;
    const [found] = await this.db
      .select({ steps: plan.steps })
      .from(plan)
      .where(eq(plan.planId, planId));
    return found ? stepReading(found.steps, configName) : null;
  }
}

function stepReading(
  steps: readonly PlanStep[],
  configName: string | null,
): ApprovedRead | null {
  const step = steps.find(
    (one) =>
      (one.action === 'create' || one.action === 'change') &&
      one.configName === configName,
  );
  // A create's read, or the read a stopped deploy left on its change.
  return (step?.action === 'create' || step?.action === 'change') &&
    step.cloudRead?.status === 'read'
    ? step.cloudRead
    : null;
}
