import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';

import { ApplicationsService } from '../../applications/applications.service';
import type { PlanReading } from '../../cloud-accounts/aws/plan-reader/read-plan';
import type { GcpCloudAccount } from '../../cloud-accounts/cloud-provider';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import type {
  GoogleCredential,
  TofuApplyRequest,
  TofuShow,
} from '../../cloud-accounts/cloud.port';
import { googleRefusalReason } from '../../cloud-accounts/gcp/api-off';
import {
  failedRevisionLogFilter,
  rolloutOf,
  workerPoolRolloutOf,
} from '../../cloud-accounts/gcp/cloud-run-rollout';
import type { Rollout } from '../../cloud-accounts/gcp/cloud-run-rollout';
import {
  CLOUD_RUN_COPIES,
  cloudRunSize,
  formatInstanceCount,
} from '../../cloud-accounts/gcp/definitions/cloud-run-size';
import { withGoogleImports } from '../../cloud-accounts/gcp/definitions/imports';
import { serviceName } from '../../cloud-accounts/gcp/definitions/names';
import {
  cloudRunResourceOf,
  cloudRunRoutingOf,
  cloudRunServiceDefinition,
  CONTAINER_NAME,
  GCP_REPOSITORY_ADDRESSES,
  CLOUD_RUN_OUTPUTS,
  internalRunAppUrl,
} from '../../cloud-accounts/gcp/definitions/cloud-run-definition';
import { RUN_APP_SETTLE_WORDS } from '../../cloud-accounts/gcp/definitions/run-app-zone';
import type { CloudRunResource } from '../../cloud-accounts/gcp/definitions/cloud-run-definition';
import { readGooglePlan } from '../../cloud-accounts/gcp/plan-reader/read-plan';
import { GOOGLE_CLOUD_PORT } from '../../cloud-accounts/google-cloud.port';
import type {
  GoogleAccessToken,
  GoogleAnswer,
  GoogleCloudPort,
} from '../../cloud-accounts/google-cloud.port';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { describeError } from '../../common/describe-error';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { application, deployment, environmentNetwork } from '../../db/schema';
import type { Deployment } from '../../db/schema';
import type { CloudRunControl } from '../../deployment-queue/cloud-run-job.types';
import { environmentNetworkName } from '../../deployments/service-scope';
import {
  blameNativeGcp,
  closesRunApp,
  storedNativeGcpRefusal,
} from '../../native/gcp-lay';
import { getEnvironmentVariablesObject } from '../../docker/docker.utils';
import { RemoteExecService } from '../../remote/remote-exec.service';
import { clearWiredChanged, wiredEnv } from '../outputs';
import {
  checkBeforeApply,
  FAILED_TASK_LOG_LINES,
  PUSH_PASSWORD_HOLDER,
  pushProgram,
  refusalMessage,
  refusalOf,
  repositoryOnly,
  webEntryOf,
} from './cloud-deploy-steps';
import type { Approval } from './cloud-deploy-steps';
import type { BuiltImage } from './aws-cloud-builds.service';
import { GoogleCloudBuilds } from './google-cloud-builds.service';

/** The cloud, as a Google deploy's refusals and log lines name it. */
export const GOOGLE_CLOUD = 'Google Cloud';

/** What Cloud Run runs, for an image of another CPU. */
export const CLOUD_RUN_RUNS =
  'Cloud Run runs x86 (amd64) images only, so nothing was pushed. Deploy an x86 image';

/** The user name Artifact Registry takes an access token under. */
const ACCESS_TOKEN_USER = 'oauth2accesstoken';

/** A sign-in is asked again after this long (its access token lasts an hour). */
const SESSION_REFRESH_MS = 30 * 60_000;

type DeployableApp = Awaited<ReturnType<ApplicationsService['findDeployable']>>;

/** What a deploy's shared end reads: the image it keeps and where it is. */
interface DeployEnd {
  readonly imageTag: string;
  readonly session: () => Promise<{ token: GoogleAccessToken }>;
  readonly place: { projectId: string; region: string; name: string };
  readonly wiredBuiltAt: string;
  readonly log: (line: string) => Promise<void>;
}

/** What a deploy no Apply queued met beyond its new image, and the plan it met it in. */
export interface GoogleDiffers {
  readonly reading: PlanReading;
  readonly show: TofuShow;
  readonly detail: string;
}

/**
 * One Google deploy, as `CloudServiceDeploys` hands it over: the Deployment,
 * its Service and Cloud account, what it may apply, and the shared steps
 * that are not Google's (the image's CPU, the plan opened for review).
 */
export interface GoogleDeploy {
  readonly row: Deployment;
  readonly app: DeployableApp;
  readonly account: GcpCloudAccount;
  readonly stateId: string;
  readonly control: CloudRunControl;
  readonly log: (line: string) => Promise<void>;
  /** The live image a put-back runs as it is, or `null` for a new image. */
  readonly putBack: string | null;
  /** The image tag this deploy runs: the Deployment's id, or the live one. */
  readonly imageTag: string;
  /** No earlier Cloud run of the Service finished: its repository is to make. */
  readonly firstRun: boolean;
  readonly approval: Approval;
  /** The built image's CPU, recorded on the row. */
  readonly architecture: () => Promise<'amd64' | 'arm64'>;
  /**
   * The image is built in Cloud Build in the Cloud account (ADR-0047), in place
   * of step 2's inspect and step 5's push: nothing was
   * built on the platform host.
   */
  readonly buildsInItsCloud: boolean;
  /** The image Cloud Build built: its CPU and check onto the row. */
  readonly recordImage: (image: BuiltImage) => Promise<void>;
  /** Stops before any change, the plan left open for review. */
  readonly stopForReview: (differs: GoogleDiffers) => Promise<never>;
}

/**
 * **A `web`'s deploy to Cloud Run** (the Google Cloud spec, "A `web` deploy"): the
 * Google half of `CloudServiceDeploys`, which runs the
 * same Deployment's Cloud run after its build on the platform host and
 * dispatches here on the Cloud account's cloud. Slice 3's sequence with
 * Google's pieces:
 *
 * 1. the run's own 2-hour proof and the deploy service account's access
 *    token (S16), or the run fails before any change, naming the Cloud
 *    account;
 * 2. the image's CPU (`docker image inspect`): Cloud Run runs x86 only, so
 *    an image of another CPU fails here, before any push;
 * 3. the Service's definition, at its size's Cloud Run pair and its copy
 *    range (S10), with the Deployment's id as the image tag, and its
 *    variables — typed, and wired ones filled in now (ADR-0031) — as Secret
 *    Manager secrets whose values reach `tofu` only as `TF_VAR_`s (S1). A
 *    variable added, changed or removed is not image-only (S19): a deploy no
 *    Apply queued stops with its plan opened;
 * 4. **a first deploy makes its Artifact Registry repository first**: Google
 *    read again, the whole plan checked against what was approved, then
 *    only the repository applied (`-target`);
 * 5. one `docker login` as `oauth2accesstoken` with a fresh access token,
 *    against a throwaway `DOCKER_CONFIG`, the password in the environment
 *    only, never stored or logged; the push; the local copy removed;
 * 6. Google read again, and the apply only if that plan is what was
 *    approved; the `run.app` address saved as the generated Domain (S11),
 *    unless its `native.gcp` closes it, when none is saved or said;
 * 7. automatic scaling in the Service's copy range put back, which is what
 *    starts a stopped Service — but never by a put-back
 * which writes no setting — then a wait for Cloud Run to call
 *    the new revision ready and serving all traffic. A revision that fails ends the Deployment `error`, quoting its
 *    not-ready reason and its last {@link FAILED_TASK_LOG_LINES} log lines,
 *    and keeps the image still running;
 * 8. once serving, every image version but the live one deleted, with its
 *    tags. There is no rollback.
 *
 * **On the Hosted instance** (ADR-0047) the build slot only checked
 * the source out, and the build is this run's: Cloud Build in the Cloud
 * account (`GoogleCloudBuilds`), in place of steps 2 and 5. It comes after
 * step 4, since the build pushes into the repository, and fails an image
 * of another CPU itself, before its push.
 *
 * **A Private web service** is the same sequence on an
 * internal-only Cloud Run service: at step 6 its `run.app` URL (the
 * project-number form of its `urls`) is saved as its internal address, not
 * as a generated Domain. Nothing waits for Google to let its Environment's
 * callers in, which takes a few minutes after the service is first made
 * the docs say so.
 *
 * **A Worker** is the same sequence on its Cloud Run worker pool:
 * no `run.app` address is saved, step 7 sets the worker pool's instance
 * count to its `replicas` (which starts a stopped Worker), and the wait is
 * for its latest revision to be ready and running that count. A revision
 * that fails to start fails the Deployment with Google's condition message
 * and the worker pool's last log lines.
 *
 * **A Cron service** is steps 1–6 on its Cloud Run job, and ends
 * there: the job runs the new image, nothing is scaled or waited on, and no
 * execution is started. The image each later run starts from is recorded on
 * the Deployment.
 */
/**
 * The codes of a Cloud Run read that may answer the next time (a live
 * walk saw a 503 UNAVAILABLE on the wait after an apply that had succeeded,
 * which marked the deploy an error while the service served). Any other
 * refusal fails the wait at once.
 */
const PASSING_READ_CODES: ReadonlySet<string> = new Set([
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'INTERNAL',
  'Unreachable',
  '500',
  '502',
  '503',
  '504',
]);

/** How many passing errors in a row the wait for a revision rides out. */
const ROLLOUT_READ_TRIES = 5;

@Injectable()
export class GoogleServiceDeploys {
  /** How often the wait for the revision asks Cloud Run; shortened by the e2e suite. */
  pollIntervalMs = 5_000;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly remoteExec: RemoteExecService,
    private readonly cloudBuilds: GoogleCloudBuilds,
  ) {}

  async deploy(run: GoogleDeploy): Promise<void> {
    const { row, app, account, stateId, control, log, putBack, imageTag } = run;
    const region = app.region ?? '';
    const projectId = account.cloudId;
    const name = serviceName(app.applicationId);
    const network = await this.readyNetwork(app.environmentId, account, region);

    await log(
      `☁️ [Cloud run] Deploying ${app.name} to Cloud account ${account.name} in ${region}, Infrastructure state ${stateId}`,
    );
    const session = this.sessions(account);
    await session();

    // Before any push: Cloud Run runs x86 only. An image
    // Cloud Build builds is checked there, before its push.
    if (!run.buildsInItsCloud) {
      const architecture = await run.architecture();
      if (architecture !== 'amd64') {
        throw new Error(
          `The image is built for ${architecture}; ${CLOUD_RUN_RUNS}`,
        );
      }
    }
    if (putBack) {
      await log(
        `♻️ [Cloud run] Putting ${GOOGLE_CLOUD} back to Cloudgate's version, on the live image ${putBack}`,
      );
    }

    const entry = webEntryOf(app);
    const sizing = cloudRunSize(app.configName ?? app.appName, entry.size);
    if (!sizing.ok) throw new Error(sizing.refusal.message);
    const wiredBuiltAt = new Date().toISOString();
    const values = {
      ...getEnvironmentVariablesObject(
        app.env,
        app.environment.project.env,
        app.environment.env,
      ),
      ...(await wiredEnv(this.db, app.environmentId, app.configLinks)),
    };
    const variableNames = Object.keys(values).filter(
      (one) => values[one] !== '',
    );
    const copies = {
      min: app.minCopies ?? CLOUD_RUN_COPIES.min,
      max: app.maxCopies ?? CLOUD_RUN_COPIES.max,
    };
    // A `web` behind the load balancer, a Worker's worker pool at its
    // `replicas`.
    const resource = cloudRunResourceOf(app.configKind);
    const routing = cloudRunRoutingOf(app.configKind, app.port, app.replicas);
    // The instance count the wait asks of a worker pool: a put-back writes
    // no setting, so a stopped Worker stays stopped and the pool's own count
    // is taken.
    const instances =
      routing.kind === 'none' && !putBack ? routing.instances : null;
    // Its stored `native.gcp`, refused whole, before anything
    // changes, when it now holds a value locked since it was applied.
    const refusedNative = storedNativeGcpRefusal(
      app.configName ?? app.appName,
      app.configKind,
      app.nativeGcp,
    );
    if (refusedNative) throw new Error(refusedNative);
    const generated = cloudRunServiceDefinition({
      configName: app.configName ?? app.appName,
      entry,
      routing,
      service: { serviceId: app.applicationId, copies },
      cloudAccountId: account.cloudAccountId,
      projectId,
      region,
      environmentId: app.environmentId,
      stateId,
      network,
      pair: sizing.pair,
      imageTag,
      variables: values,
      // What its last Apply laid, over Cloudgate's definition.
      native: app.nativeGcp,
    });
    if (!generated.ok) throw new Error(generated.refusal.message);
    // A value only Google can judge names the native path it refused.
    const googleRefused = (message: string) =>
      blameNativeGcp(googleRefusalReason(message, projectId), app.nativeGcp);

    const read = (show: TofuShow, names: readonly string[] = variableNames) =>
      readGooglePlan({
        show,
        nameSearch: [],
        context: { variableNames: names },
      });
    const request = async (): Promise<TofuApplyRequest<GoogleCredential>> => ({
      stateId,
      credential: (await session()).credential,
      // What the Apply adopts by name is imported, not made again.
      definition: withGoogleImports(
        generated.definition,
        run.approval.byApply?.adopt ?? [],
      ),
      variables: generated.variables,
      onLine: (line) => void log(line),
      signal: control.signal,
    });

    let made = new Set<string>();
    let differs: GoogleDiffers | null = null;
    const refuse = (now: PlanReading, show: TofuShow): string | null => {
      const refusal = refusalOf(run.approval, now, made, GOOGLE_CLOUD);
      if (refusal?.kind === 'differs') {
        differs = { reading: now, show, detail: refusal.detail };
      }
      return refusal ? refusalMessage(refusal, GOOGLE_CLOUD) : null;
    };
    const stop = (message: string): Promise<never> =>
      differs ? run.stopForReview(differs) : Promise.reject(new Error(message));

    if (run.firstRun) {
      await log(`Reading ${GOOGLE_CLOUD} again before anything changes`);
      const planned = await this.states.plan(await request());
      if (!planned.ok) {
        throw new Error(googleRefused(planned.message));
      }
      const refused = refuse(read(planned.show), planned.show);
      if (refused) return stop(refused);
      await log(
        "📦 [Push] Making the Service's Artifact Registry repository first, so the image has somewhere to go",
      );
      const repository = await this.states.apply({
        ...(await request()),
        targets: [...GCP_REPOSITORY_ADDRESSES],
        beforeApply: (show) =>
          checkBeforeApply(
            show,
            repositoryOnly(
              GCP_REPOSITORY_ADDRESSES,
              'Artifact Registry repository',
            ),
            () => control.beginApply(),
            variableNames,
            read,
          ),
      });
      if (!repository.ok) {
        throw new Error(googleRefused(repository.message));
      }
      made = new Set(read(repository.show).raw.map((line) => line.address));
    }

    if (run.buildsInItsCloud) {
      const built = await this.cloudBuilds.build({
        row,
        app,
        account,
        region,
        repository: name,
        image: CONTAINER_NAME,
        token: async () => (await session()).token,
        control,
        log,
        runs: CLOUD_RUN_RUNS,
      });
      await run.recordImage(built);
    } else if (!putBack) {
      await this.push(row, app, { projectId, region, name }, session, log);
    }

    await log(`Reading ${GOOGLE_CLOUD} again before applying`);
    let checked = false;
    const applied = await this.states.apply({
      ...(await request()),
      beforeApply: (show) => {
        for (const line of read(show).summary) {
          void log(`📋 [Cloud run] ${line}`);
        }
        const refusal = checkBeforeApply(
          show,
          refuse,
          () => control.beginApply(),
          variableNames,
          read,
        );
        checked = refusal === null;
        return refusal;
      },
    });
    const service = { projectId, region, name };
    if (!applied.ok) {
      if (!checked) return stop(applied.message);
      // The provider waits for the revision: one that never got ready
      // fails the apply, and Cloud Run says why. A job has no revision to
      // wait on: its runs are executions.
      const { token } = await session();
      const read =
        resource === 'job'
          ? null
          : await this.rollout(token, service, resource, instances).catch(
              () => null,
            );
      const rollout = read?.ok ? read.value : null;
      if (rollout?.state === 'failed') {
        return this.failRevision(rollout, token, service, resource, log);
      }
      throw new Error(googleRefused(applied.message));
    }

    if (resource === 'job') {
      return this.finishJob(row, app, {
        outputs: applied.outputs,
        imageTag,
        putBack,
        session,
        place: { projectId, region, name },
        wiredBuiltAt,
        log,
      });
    }

    if (routing.kind === 'internal-only') {
      // A Private web service: its `run.app` URL, the project-number
      // form of its `urls`, is the address its Environment's Services call,
      // saved for its internal-address card, never a generated Domain.
      const url = internalRunAppUrl(
        applied.outputs[CLOUD_RUN_OUTPUTS.serviceUrls],
        region,
      );
      await this.db
        .update(application)
        .set({ cloudRunAddress: runAppHost(url) })
        .where(eq(application.applicationId, app.applicationId));
      if (url) {
        await log(
          `🔒 [Cloud run] ${app.name} answers only inside this Environment, at ${url}; a new one can answer 404 there for ${RUN_APP_SETTLE_WORDS} while Google sets it up`,
        );
      }
    }
    const address =
      routing.kind === 'internal-only'
        ? null
        : runAppHost(applied.outputs[CLOUD_RUN_OUTPUTS.serviceUri]);
    if (address && closesRunApp(app.nativeGcp)) {
      // Closed by its `native.gcp`: Cloud Run still reports the
      // address, but nothing outside the Environment is answered there, so
      // it is no longer its generated Domain, nor said to answer.
      await this.db
        .update(application)
        .set({ cloudRunAddress: null })
        .where(eq(application.applicationId, app.applicationId));
      await log(
        `🔒 [Cloud run] ${app.name}'s run.app address is closed: only its Domains and this Environment reach it`,
      );
    } else if (address) {
      await this.db
        .update(application)
        .set({ cloudRunAddress: address })
        .where(eq(application.applicationId, app.applicationId));
      await log(`🌐 [Cloud run] ${app.name} answers at https://${address}`);
    }

    // A Deploy starts a stopped Service: the definition
    // ignores the service's scaling (S9), so automatic scaling in its copy
    // range is put back here, as an ECS deploy writes `replicas` back. A
    // put-back writes no setting: Stop is never drift, so a
    // stopped Service stays stopped.
    // A Worker's is its instance count, `replicas`, as an ECS deploy writes
    // its running count back.
    if (instances !== null) {
      const scaled = await this.google.setWorkerPoolInstances(
        (await session()).token,
        service,
        instances,
      );
      if (!scaled.ok) {
        throw new Error(
          `Cloud Run refused the worker pool's instance count of ${instances}: ${scaled.code}: ${googleRefusalReason(scaled.message, projectId)}`,
        );
      }
    } else if (!putBack && resource === 'service') {
      const scaled = await this.google.setCloudRunScaling(
        (await session()).token,
        service,
        { mode: 'automatic', copies },
      );
      if (!scaled.ok) {
        throw new Error(
          `Cloud Run refused automatic scaling in ${copies.min}–${copies.max} copies: ${scaled.code}: ${googleRefusalReason(scaled.message, projectId)}`,
        );
      }
    }

    await log(
      resource === 'worker-pool'
        ? `⏳ [Cloud run] Waiting for Cloud Run to call the worker pool's new revision ready${instances === null ? '' : ` and running ${formatInstanceCount(instances)}`}`
        : '⏳ [Cloud run] Waiting for Cloud Run to call the new revision ready and serving all traffic',
    );
    await this.awaitServing(
      service,
      { resource, instances },
      session,
      control,
      log,
    );

    await this.endDeploy(
      app,
      { imageTag, session, place: service, wiredBuiltAt, log },
      putBack
        ? `✅ [Cloud run] ${GOOGLE_CLOUD} is Cloudgate's version again; ${app.name} runs its live image`
        : `✅ [Cloud run] ${app.name} runs the image of this Deployment`,
    );
  }

  /**
   * **A Cron service's deploy ends at its apply** (the Google Cloud kinds spec):
   * the job now runs the new image, and no execution is started — a
   * deploy never fires the job. What each later run starts from is
   * recorded on the Deployment, named in each run's first line; a run in
   * flight is an execution that keeps the image it began with. Then every
   * other image version goes, as after a `web`'s.
   */
  private async finishJob(
    row: Deployment,
    app: DeployableApp,
    done: DeployEnd & {
      readonly outputs: Record<string, unknown>;
      readonly putBack: string | null;
    },
  ): Promise<void> {
    const repository = done.outputs[CLOUD_RUN_OUTPUTS.repositoryUrl];
    if (typeof repository === 'string') {
      await this.db
        .update(deployment)
        .set({
          cronImage: `${repository}/${CONTAINER_NAME}:${done.imageTag}`,
        })
        .where(eq(deployment.deploymentId, row.deploymentId));
    }
    await this.endDeploy(
      app,
      done,
      done.putBack
        ? `✅ [Cloud run] ${GOOGLE_CLOUD} is Cloudgate's version again; ${app.name}'s runs start from its live image`
        : `✅ [Cloud run] ${app.name}'s runs start from the image of this Deployment; no run was started`,
    );
  }

  /**
   * The end every Cloud Run deploy shares, a job's too: every image
   * version but the live one goes, the Service's wired variables are no
   * longer marked changed, and `last` is the Deployment's last line.
   */
  private async endDeploy(
    app: DeployableApp,
    end: DeployEnd,
    last: string,
  ): Promise<void> {
    await this.removeOlderImages(end.session, end.place, end.imageTag, end.log);
    await clearWiredChanged(
      this.db,
      { serviceType: 'application', serviceId: app.applicationId },
      end.wiredBuiltAt,
    );
    await end.log(last);
  }

  /** Every image version but the live one deleted, with its tags. */
  private async removeOlderImages(
    session: () => Promise<{ token: GoogleAccessToken }>,
    place: { projectId: string; region: string; name: string },
    keepTag: string,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const cleaned = await this.google
      .deleteImageVersionsExcept((await session()).token, {
        projectId: place.projectId,
        region: place.region,
        repository: place.name,
        image: CONTAINER_NAME,
        keepTag,
      })
      .catch((error: unknown) => ({
        ok: false as const,
        code: 'Unreachable',
        message: describeError(error),
      }));
    await log(
      cleaned.ok
        ? `🧹 [Push] Removed ${cleaned.value.deleted} older image${cleaned.value.deleted === 1 ? '' : 's'} from Artifact Registry; only the live one is kept`
        : `⚠️ [Push] Older images were not removed from Artifact Registry (${cleaned.code}: ${cleaned.message}); the next deploy removes them`,
    );
  }

  /**
   * The run's proof and access token, signed once and again when near the
   * token's end. The first refusal fails the run before any change.
   */
  private sessions(
    account: GcpCloudAccount,
  ): () => Promise<{ credential: GoogleCredential; token: GoogleAccessToken }> {
    let held: {
      value: { credential: GoogleCredential; token: GoogleAccessToken };
      at: number;
    } | null = null;
    return async () => {
      if (held && Date.now() - held.at < SESSION_REFRESH_MS) return held.value;
      const signed = await this.cloudAccounts.googleRunSession(account);
      if (!signed.ok) throw new Error(signed.refusal);
      held = {
        value: { credential: signed.credential, token: signed.token },
        at: Date.now(),
      };
      return held.value;
    };
  }

  /**
   * A fresh access token from the deploy service account, one login as
   * `oauth2accesstoken`, the push, and the local copies removed. The token is
   * in the program's environment only.
   */
  private async push(
    row: Deployment,
    app: DeployableApp,
    place: { projectId: string; region: string; name: string },
    session: () => Promise<{ token: GoogleAccessToken }>,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const { token } = await session();
    const registry = `${place.region}-docker.pkg.dev`;
    const remote = `${registry}/${place.projectId}/${place.name}/${CONTAINER_NAME}:${row.deploymentId}`;
    await log(`📦 [Push] Uploading image to '${remote}'`);
    try {
      await this.remoteExec.execAsync(
        pushProgram({
          registry,
          username: ACCESS_TOKEN_USER,
          app,
          remote,
          logPath: row.logPath,
        }),
        { env: { ...process.env, [PUSH_PASSWORD_HOLDER]: token.accessToken } },
      );
    } catch {
      throw new Error(
        `The image of ${app.appName} could not be pushed to its Artifact Registry repository; the lines above say why`,
      );
    }
    await log('✅ Image Pushed');
  }

  private async rollout(
    token: GoogleAccessToken,
    service: { projectId: string; region: string; name: string },
    resource: CloudRunResource,
    instances: number | null,
  ): Promise<GoogleAnswer<Rollout>> {
    if (resource === 'worker-pool') {
      const answer = await this.google.cloudRunWorkerPool(token, service);
      if (!answer.ok) {
        return {
          ...answer,
          message: `Cloud Run could not be asked about the worker pool's new revision: ${answer.code}: ${answer.message}`,
        };
      }
      return {
        ok: true,
        value: workerPoolRolloutOf(
          answer.value,
          instances ?? answer.value.instanceCount ?? 0,
        ),
      };
    }
    const answer = await this.google.cloudRunService(token, service);
    if (!answer.ok) {
      return {
        ...answer,
        message: `Cloud Run could not be asked about the new revision: ${answer.code}: ${answer.message}`,
      };
    }
    return { ok: true, value: rolloutOf(answer.value) };
  }

  /**
   * Polls Cloud Run until the new revision serves all traffic (a Worker's: runs
   * its instance count), or failed. A read Google answers with a
   * passing error is asked again, up to {@link ROLLOUT_READ_TRIES} in a row.
   */
  private async awaitServing(
    service: { projectId: string; region: string; name: string },
    awaited: {
      readonly resource: CloudRunResource;
      /** A worker pool's count to wait for; `null` takes the pool's own. */
      readonly instances: number | null;
    },
    session: () => Promise<{ token: GoogleAccessToken }>,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    let unread = 0;
    for (;;) {
      if (control.signal.interrupted) {
        throw new Error(
          'The run was ended while Cloud Run started the new revision',
        );
      }
      const { token } = await session();
      const read = await this.rollout(
        token,
        service,
        awaited.resource,
        awaited.instances,
      ).catch((error: unknown): GoogleAnswer<Rollout> => ({
        ok: false,
        code: 'Unreachable',
        message: `Cloud Run could not be asked about the new revision: ${describeError(error)}`,
      }));
      if (!read.ok) {
        unread += 1;
        if (
          !PASSING_READ_CODES.has(read.code) ||
          unread >= ROLLOUT_READ_TRIES
        ) {
          throw new Error(read.message);
        }
        await log(`${read.message}; asking again`);
      } else {
        unread = 0;
        const rollout = read.value;
        if (rollout.state === 'serving') return;
        if (rollout.state === 'failed') {
          return this.failRevision(
            rollout,
            (await session()).token,
            service,
            awaited.resource,
            log,
          );
        }
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

  /**
   * A revision that never got ready: its not-ready reason and
   * its last lines into the Deployment log, then the Deployment ends
   * `error`. Nothing is cleaned up: the image still running stays.
   */
  private async failRevision(
    rollout: Extract<Rollout, { state: 'failed' }>,
    token: GoogleAccessToken,
    service: { projectId: string; region: string; name: string },
    resource: CloudRunResource,
    log: (line: string) => Promise<void>,
  ): Promise<never> {
    await log(
      `❌ [Cloud run] Revision ${rollout.revision ?? '(unnamed)'} is not ready: ${rollout.reason}`,
    );
    if (rollout.revision) {
      const entries = await this.google
        .listLogEntries(token, {
          projectId: service.projectId,
          filter: failedRevisionLogFilter(
            service.name,
            rollout.revision,
            resource,
          ),
          limit: FAILED_TASK_LOG_LINES,
        })
        .catch((error: unknown) => ({
          ok: false as const,
          code: 'Unreachable',
          message: describeError(error),
        }));
      if (!entries.ok) {
        await log(
          `Its log could not be read (${entries.code}: ${entries.message})`,
        );
      } else if (entries.value.length === 0) {
        await log('It printed nothing to its log');
      } else {
        await log(`Its last ${entries.value.length} log lines:`);
        for (const entry of [...entries.value].reverse()) {
          await log(`  ${entry.text}`);
        }
      }
    }
    throw new Error(
      `The new revision failed to become ready: ${rollout.reason}`,
    );
  }

  /** The Environment network's saved names there, or the run fails saying so. */
  private async readyNetwork(
    environmentId: string,
    account: GcpCloudAccount,
    region: string,
  ): Promise<{ networkName: string; subnetName: string }> {
    const [found] = await this.db
      .select({
        networkName: environmentNetwork.networkName,
        subnetName: environmentNetwork.subnetName,
      })
      .from(environmentNetwork)
      .where(
        and(
          eq(environmentNetwork.environmentId, environmentId),
          eq(environmentNetwork.cloudAccountId, account.cloudAccountId),
          eq(environmentNetwork.region, region),
          eq(environmentNetwork.status, 'ready'),
          isNotNull(environmentNetwork.networkName),
          isNotNull(environmentNetwork.subnetName),
        ),
      );
    if (!found) {
      throw new Error(
        `The ${environmentNetworkName(region)} is not made, so there is nowhere to run this Service. Check for changes, then apply the plan`,
      );
    }
    return { networkName: found.networkName!, subnetName: found.subnetName! };
  }
}

/** The host of the `service_uri` output (`https://<host>`), or `null`. */
function runAppHost(uri: unknown): string | null {
  if (typeof uri !== 'string' || uri === '') return null;
  return uri.replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;
}
