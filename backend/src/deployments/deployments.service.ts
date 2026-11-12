import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  SQL,
} from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { quote } from 'shell-quote';
import { application } from '../applications/application.schema';
import { refuseWhileCloudDelete } from '../applications/cloud-delete-refusal';
import { user } from '../auth/auth.schema';
import type { ServiceType } from '../applications/application.schema';
import { backup } from '../backups/backup.schema';
import type { BackupServiceType } from '../backups/backup.schema';
import { BackupsService } from '../backups/backups.service';
import type { BackupDatabaseType } from '../backups/commands';
import { ownerOnlyDirectoryCommand } from '../common/files/owner-only';
import { findParentService } from '../common/service-parent';
import { compose } from '../compose/compose.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { buildHostServerId } from '../deployment-engine/build-host';
import { deploymentLogsDirectoryOn } from '../deployment-engine/deployment-engine.paths';
import { parentColumns } from '../deployment-engine/ports/deployment-recorder';
import type {
  CreateDeploymentInput,
  DeploymentParent,
  DeploymentRecord,
  DeploymentRecorder,
} from '../deployment-engine/ports/deployment-recorder';
import {
  CANCEL_REFUSED_WHILE_APPLYING,
  CloudRunsService,
} from '../deployment-queue/cloud-runs.service';
import { getGroup, ownDeploymentId } from '../deployment-queue/job-types';
import type { DeploymentJob } from '../deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../deployment-queue/queue.port';
import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import {
  deployRefusal,
  refuseDeployUntilReady,
} from '../bought-servers/server-readiness';
import {
  maintenanceRefusal,
  refuseWhileInMaintenance,
} from '../servers/server-maintenance';
import type { QueuedJob, QueuePort } from '../deployment-queue/queue.port';
import { environmentNetwork } from '../environments/environment-network.schema';
import { environment } from '../environments/environment.schema';
import type { GithubPushEvent } from '../git-providers/strategies/github/github-webhook.util';
import { project } from '../projects/project.schema';
import { plan } from '../project-config/project-config.schema';
import type { DeploymentView } from 'api-schemas';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { execOnServer, execOnServerStdout } from '../remote/exec-dispatch';
import { RemoteExecService } from '../remote/remote-exec.service';
import { schedule } from '../scheduling/schedules/schedule.schema';
import { SchedulesService } from '../scheduling/schedules/schedules.service';
import { server } from '../servers/server.schema';
import { volumeBackup } from '../volume-backups/volume-backup.schema';
import { VolumeBackupsService } from '../volume-backups/volume-backups.service';
import { deployment } from './deployment.schema';
import type { Deployment, DeploymentStatus } from './deployment.schema';
import { missingSource } from './missing-source';
import type { SourceColumns } from './missing-source';
import {
  isPastLogRetention,
  logPresenceProbeCommand,
  readLogFileAbsence,
  reapedLogNotice,
} from './log-retention';
import { pushDeployMeta, pushHasNothingToBuild } from './push-deploy';
import { ownedServiceId, ownerOf, serviceScope } from './service-scope';
import type { DeploymentOwner, DeploymentOwnerFks } from './service-scope';
import type { JournalReason } from '../realtime/socket-access';
import { CRON_RUN_STOPPER } from '../cron-services/cron-run-stopper.port';
import type { CronRunStopper } from '../cron-services/cron-run-stopper.port';
import {
  STACK_VM_DOWN,
  StackVmPower,
  stackVmNotMadeRefusal,
} from '../stack-vm/stack-vm-power';
import type { StackVmSettings } from '../cloud-accounts/definitions/stack-vm';

/** Deployment record metadata: its title and description. */
/**
 * The Service types a Deployment builds — what a deploy queues, a queued
 * build is joined for, and a build's owner is. Databases are started, not
 * built.
 */
export type BuiltServiceType = Extract<ServiceType, 'application' | 'compose'>;

export interface DeployMeta {
  title?: string;
  description?: string;
}

/**
 * Which plan, if any, holds a pushed Application's build: the push's
 * plan of the Application's Environment when the same push changed its own
 * config entry, else `null`, and it builds as it always has. Answered by the
 * project-config module, which is the one that read the config.
 */
export type PushHoldFor = (app: {
  environmentId: string;
  configName: string;
}) => string | null;

/** A manual deploy's default title, and a redeploy's. */
const DEPLOY_TITLE = 'Manual deployment';
const REDEPLOY_TITLE = 'Rebuild deployment';

/**
 * A build's row still `running` at start-up: the process building it
 * is gone, so nothing will finish its record. It ends `error` with this, and
 * is not built again by itself — as a Cloud run's is, with
 * `CUT_OFF_BY_RESTART`, whose second half speaks of a cloud account's
 * resources and so is not a build's.
 */
export const BUILD_CUT_OFF_BY_RESTART =
  'Cut off by a Cloudgate restart before this build finished. Deploy again to build it.';

/**
 * A preview's build still `pending` at start-up whose preview was deleted
 * meanwhile (`requeuedJob`): its link was `set null`, so there is no
 * preview to build it as, and building it as its parent's production deploy
 * would be a guess nobody asked for. It ends `error` with this.
 */
export const PREVIEW_BUILD_NOT_REQUEUED =
  'Not built: Cloudgate restarted before this build started, and its preview has been deleted since.';

/**
 * Any other row still `pending` at start-up that is not queued again:
 * one that does not record what it was queued as — a build from before
 * Cloudgate kept that, or a cloud row (a cloud Delete, a Domain's Cloud run)
 * recorded a moment before its `cloud_run` was set — or one whose job could
 * not be queued. None of them had started, so this says only what is true of
 * them all: nothing ran. It names no action, because a build is deployed again
 * and a Delete retried.
 */
export const NOT_STARTED_BEFORE_RESTART =
  'Not started: Cloudgate restarted before this started, so nothing was run. Ask for it again if it is still wanted.';

/** The service columns deployment records care about: the log directory
 * is named after appName, and logs live on the server that builds. */
interface DeployTarget {
  appName: string;
  serverId: string | null;
  buildServerId: string | null;
}

/**
 * A service nobody has pointed at any source is refused before a
 * Deployment row or a job exists. `source_type` defaults to `github`, so such a
 * row used to queue and fail at the worker with "has no GitHub provider
 * linked" — a sentence about a connection, sent to someone who had not chosen
 * a source. `missingSource` says what is missing; a 409, because the request is
 * fine and the row is not ready. The row is the one the ownership read already
 * returned, so the check costs no query of its own.
 */
function refuseWithoutSource(
  kind: 'Application' | 'Compose stack',
  row: SourceColumns & { name: string },
): void {
  const missing = missingSource(row);
  if (missing) {
    throw new ConflictException(
      `${kind} "${row.name}" cannot be deployed: ${missing}. Set its source, then deploy`,
    );
  }
}

/** The half of a build's job its row decides: its own id and banner. */
function jobOfRow(
  row: Deployment,
  type: DeploymentJob['type'],
  serverId: string | null,
) {
  return {
    deploymentId: row.deploymentId,
    title: row.title,
    description: row.description ?? '',
    type,
    serverId,
  };
}

/**
 * The job a build's row still `pending` at start-up is queued again as
 * or `null` when the row cannot prove what it was queued as — and
 * then it is never queued as a guess. The row's `queued_as`, written by the
 * trigger that recorded it, must agree with the row: a preview's build still
 * names its preview, whose link is `set null` when the preview is deleted, and
 * a production build names none. Without that, a deleted preview's build would
 * read as a production deploy of its parent that nobody asked for, and a cloud
 * row recorded `pending` before its `cloud_run` was set as a Docker build.
 *
 * The job is rebuilt from the row, which names the Service, the preview and
 * its own id, and its `type` is the one `queued_as` recorded —
 * never read off the title, which a caller may choose for a redeploy too.
 */
function requeuedJob(
  row: Deployment,
  serverId: string | null,
): DeploymentJob | null {
  if (!row.queuedAs) return null;
  const base = jobOfRow(row, row.queuedAs.type, serverId);
  const { composeId, applicationId, previewDeploymentId } = row;
  switch (row.queuedAs.applicationType) {
    case 'compose':
      return composeId
        ? { ...base, applicationType: 'compose', composeId }
        : null;
    case 'application':
      return applicationId && !previewDeploymentId
        ? { ...base, applicationType: 'application', applicationId }
        : null;
    case 'application-preview':
      return applicationId && previewDeploymentId
        ? {
            ...base,
            applicationType: 'application-preview',
            applicationId,
            previewDeploymentId,
          }
        : null;
    default:
      return null;
  }
}

/** Why a row still `pending` at start-up was not queued again. */
function notRequeuedReason(row: Deployment): string {
  return row.queuedAs?.applicationType === 'application-preview' &&
    !row.previewDeploymentId
    ? PREVIEW_BUILD_NOT_REQUEUED
    : NOT_STARTED_BEFORE_RESTART;
}

/**
 * Whether `job` is the build of Deployment `deploymentId`, whose Service's
 * queue group is `group`. A local job names its row, and matches only
 * that row — never another build of the same Service. A job that names none
 * matches by Service — and by preview: a preview job
 * shares its parent's group, so a nameless one is the build of a row naming
 * that same preview and never of a production row, nor the reverse.
 */
function jobBuildsRecord(
  job: DeploymentJob,
  row: Pick<Deployment, 'deploymentId' | 'previewDeploymentId'>,
  group: string,
): boolean {
  const own = ownDeploymentId(job);
  if (own !== null) return own === row.deploymentId;
  const jobPreview =
    job.applicationType === 'application-preview'
      ? job.previewDeploymentId
      : null;
  return jobPreview === row.previewDeploymentId && getGroup(job) === group;
}

/**
 * Among the waiting jobs, in queue order, the first that `wanted` picks and
 * whose own row is still `pending` and inside `rowScope` — the row and the job
 * a new request would join rather than queue behind. A job that
 * names no row is never picked, and neither is a `pending` row no waiting job
 * names: its build is not waiting here to be joined — one recorded a moment
 * before its job is queued. (A restart
 * no longer leaves such rows: start-up queues them again.)
 */
async function firstJoinableBuild(
  db: DrizzleDB,
  queue: QueuePort,
  wanted: (job: DeploymentJob) => boolean,
  rowScope: SQL | undefined,
): Promise<{ pending: Deployment; waiting: DeploymentJob } | null> {
  const waitingJobs = new Map<string, DeploymentJob>();
  for (const { data } of await queue.getJobs(['waiting'])) {
    const own = ownDeploymentId(data);
    if (own === null || !wanted(data)) continue;
    waitingJobs.set(own, data);
  }
  if (waitingJobs.size === 0) return null;

  const rows = await db
    .select()
    .from(deployment)
    .where(
      and(
        rowScope,
        eq(deployment.status, 'pending'),
        inArray(deployment.deploymentId, [...waitingJobs.keys()]),
      ),
    );
  const pendingById = new Map(rows.map((row) => [row.deploymentId, row]));
  const joinedId = [...waitingJobs.keys()].find((id) => pendingById.has(id));
  const pending = joinedId && pendingById.get(joinedId);
  const waiting = joinedId && waitingJobs.get(joinedId);
  if (!pending || !waiting) return null;
  return { pending, waiting };
}

/**
 * The log directory an Environment network's runs write under, in
 * place of the `appName` a Service's runs use: a network has none. Its id
 * is a nanoid, so the name passes `isLogOwnerName` like an `appName` does,
 * and ADR-0020's age sweep reaches it like any other owner's directory.
 */
export function environmentNetworkLogOwner(environmentNetworkId: string) {
  return `environment-network-${environmentNetworkId}`;
}

/** The owning service id off a run row, which the schema leaves nullable per
 * service type even though the row's own discriminator picks exactly one. */
function requireServiceId(serviceId: string | null): string {
  if (!serviceId) throw new NotFoundException('Deployment not found');
  return serviceId;
}

/**
 * Deployment records with the names a feed row is titled by, left-joined to
 * every row their Organization is read through: the three run-owning
 * tables on the record's own FKs, the schedule's server, and the owning
 * service's environment → project. The one spelling of that read for
 * {@link DeploymentsService.listByOrganization} and
 * {@link DeploymentsService.findOwnedDeployment}, so {@link inOrganization}
 * means the same thing in the feed and in the by-id read. `service` is passed
 * in because the feed filters on it too.
 */
function selectWithOwners(
  db: DrizzleDB,
  service: ReturnType<typeof serviceScope>,
) {
  return (
    db
      .select({
        ...getTableColumns(deployment),
        serviceName: sql<string | null>`${service.name}`,
        scheduleName: schedule.name,
        volumeBackupName: volumeBackup.name,
        backupName: backup.appName,
        networkRegion: environmentNetwork.region,
        projectId: project.projectId,
        projectName: project.name,
        environmentId: environment.environmentId,
        environmentName: environment.name,
      })
      .from(deployment)
      // The owner rows a run hangs off, so the service under a run resolves
      // in the same query as the service under a build.
      .leftJoin(schedule, eq(schedule.scheduleId, deployment.scheduleId))
      .leftJoin(
        volumeBackup,
        eq(volumeBackup.volumeBackupId, deployment.volumeBackupId),
      )
      .leftJoin(backup, eq(backup.backupId, deployment.backupId))
      .leftJoin(
        environmentNetwork,
        eq(
          environmentNetwork.environmentNetworkId,
          deployment.environmentNetworkId,
        ),
      )
      .leftJoin(server, eq(server.serverId, schedule.serverId))
      .leftJoin(service, eq(service.serviceId, ownedServiceId()))
      // An Environment network's run owns no Service, so its Environment is
      // the network's own.
      .leftJoin(
        environment,
        eq(
          environment.environmentId,
          sql`coalesce(${service.environmentId}, ${environmentNetwork.environmentId})`,
        ),
      )
      .leftJoin(project, eq(project.projectId, environment.projectId))
  );
}

/**
 * A Deployment record belongs to `organizationId`: the owning service's
 * organization, or — for the two schedule kinds that own no service — the
 * schedule's server or the organization the host schedule was created in.
 * Over {@link selectWithOwners}'s tables. A parentless record reaches
 * none of them and belongs to no Organization.
 */
function inOrganization(organizationId: string): SQL {
  return sql`coalesce(${project.organizationId}, ${server.organizationId}, ${schedule.organizationId}) = ${organizationId}`;
}

/**
 * A row of the organization-wide feed: the record plus the names a feed
 * needs, since the row itself carries ids and no name. `project` and
 * `environment` are null for the runs that hang off no service — a server or
 * cloudgate-server schedule belongs to the organization directly.
 */
export interface DeploymentFeedRow extends Deployment {
  owner: DeploymentOwner;
  project: { projectId: string; name: string } | null;
  environment: { environmentId: string; name: string } | null;
}

/** One page of the feed; `nextCursor` is null on the last page. */
export interface DeploymentFeedPage {
  rows: DeploymentFeedRow[];
  nextCursor: string | null;
}

/** The feed's query: a page plus the two filters the screen offers. */
export interface DeploymentFeedQuery {
  limit: number;
  cursor?: string;
  status?: DeploymentStatus;
  projectId?: string;
}

/**
 * Where the previous page stopped. Keyset rather than an offset: the feed is
 * append-heavy, and an offset would repeat or skip rows as new attempts land
 * above the page the client is walking. `createdAt` alone is not a key —
 * two attempts can share an instant — so the id breaks the tie, exactly as
 * the ordering does.
 *
 * Opaque on the wire so a caller cannot probe for the existence of a
 * deployment id outside their organization by handing it back as a cursor.
 */
interface FeedCursor {
  createdAt: string;
  deploymentId: string;
}

function encodeCursor(row: FeedCursor): string {
  return Buffer.from(`${row.createdAt}|${row.deploymentId}`).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): FeedCursor {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  const createdAt = decoded.slice(0, separator);
  const deploymentId = decoded.slice(separator + 1);
  if (separator === -1 || !createdAt || !deploymentId) {
    throw new BadRequestException('Invalid cursor');
  }
  return { createdAt, deploymentId };
}

/** What the feed query selects: the record plus the resolved names, flat. */
interface FeedQueryRow extends Deployment {
  serviceName: string | null;
  scheduleName: string | null;
  volumeBackupName: string | null;
  backupName: string | null;
  networkRegion: string | null;
  projectId: string | null;
  projectName: string | null;
  environmentId: string | null;
  environmentName: string | null;
}

/** The flat query row as a feed row: names nested under what they name. */
function toFeedRow(row: FeedQueryRow): DeploymentFeedRow {
  const {
    serviceName,
    scheduleName,
    volumeBackupName,
    backupName,
    networkRegion,
    projectId,
    projectName,
    environmentId,
    environmentName,
    ...record
  } = row;
  return {
    ...record,
    owner: ownerOf(record, {
      serviceName,
      scheduleName,
      volumeBackupName,
      backupName,
      networkRegion,
    }),
    project: projectId ? { projectId, name: projectName ?? '' } : null,
    environment: environmentId
      ? { environmentId, name: environmentName ?? '' }
      : null,
  };
}

/**
 * Deployment records: one row per attempt to build and release an application,
 * holding its status and the path of the log file the engine pipes build output
 * into. Implements the Phase 21 `DeploymentRecorder` port.
 */
@Injectable()
export class DeploymentsService
  implements DeploymentRecorder, OnApplicationBootstrap
{
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
    private readonly schedules: SchedulesService,
    private readonly volumeBackups: VolumeBackupsService,
    private readonly backups: BackupsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private readonly logger = new Logger(DeploymentsService.name);

  /** Running builds a cancel can still reach, by Deployment id. */
  private readonly cancellableBuilds = new Map<string, AbortController>();

  /** Resolved lazily: constructor-injecting the queue would close the
   * deployments → queue → processor → engine → recorder instantiation cycle
   * (this service is the recorder the engine depends on). */
  private get queue(): QueuePort {
    return this.moduleRef.get<QueuePort>(DEPLOYMENT_QUEUE, { strict: false });
  }

  /** The Cloud run pool, resolved lazily for the queue's reason. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  /**
   * A Cron service's runs, resolved at call time: `CronServicesModule`
   * imports the Service modules this one sits beside.
   */
  private get cronRuns(): CronRunStopper {
    return this.moduleRef.get<CronRunStopper>(CRON_RUN_STOPPER, {
      strict: false,
    });
  }

  /**
   * Whoever can read the application and create deployments may trigger one.
   * The attempt is recorded as pending before it is enqueued, so history shows
   * queued deploys and the engine (via {@link create}) claims the record
   * instead of adding a second one. A build of the Application held for a
   * plan is cancelled: this build is the one with the saved settings.
   */
  async deploy(
    ctx: PermissionCtx,
    applicationId: string,
    meta: DeployMeta = {},
  ) {
    return this.triggerApplicationBuild(ctx, applicationId, 'deploy', meta);
  }

  /**
   * Builds the Application again from the source it already has,
   * without waiting for a new commit — the "the last deployment failed, try it
   * again" affordance. Same record, same queue, `type: 'redeploy'` so the
   * processor knows this is a rebuild of what is there rather than a fresh
   * trigger.
   */
  async redeploy(
    ctx: PermissionCtx,
    applicationId: string,
    meta: DeployMeta = {},
  ) {
    return this.triggerApplicationBuild(ctx, applicationId, 'redeploy', {
      title: meta.title ?? REDEPLOY_TITLE,
      description: meta.description,
    });
  }

  /**
   * Queues a Deployment of an Application for an action whose caller was
   * already allowed on what it changed: a bucket's Rotate key
   * redeploys every Service linking its key under that bucket's `service:
   * update`, asking no statement of its own (ADR-0037). Refused as
   * {@link deploy} refuses — no source, a cloud Delete under way — and a
   * build held for a plan is replaced by this one, as there.
   */
  async deployForLinkedOutput(
    applicationId: string,
    meta: { title: string; description: string },
  ): Promise<Deployment> {
    const app = await this.findOwnedApplication(null, applicationId);
    return this.queueBuild(app, 'deploy', meta);
  }

  /** Shared by {@link deploy} and {@link redeploy}: whoever can read the
   * Application and create deployments may trigger one, the attempt is
   * recorded pending before it is enqueued, and only the job's `type` and the
   * default title differ between them. */
  private async triggerApplicationBuild(
    ctx: PermissionCtx,
    applicationId: string,
    type: 'deploy' | 'redeploy',
    meta: DeployMeta,
  ) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    await this.permissions.checkServiceAccess(ctx, applicationId, 'read');
    const app = await this.findOwnedApplication(ctx, applicationId);
    return this.queueBuild(app, type, {
      title: meta.title ?? DEPLOY_TITLE,
      description: meta.description ?? '',
    });
  }

  /** A build of `app`, refused or recorded pending and queued. */
  private async queueBuild(
    app: Awaited<ReturnType<DeploymentsService['findOwnedApplication']>>,
    type: 'deploy' | 'redeploy',
    meta: { title: string; description: string },
  ): Promise<Deployment> {
    const { applicationId } = app;
    refuseWithoutSource('Application', app);
    // A cloud Service being deleted, or whose Delete is incomplete, is never
    // deployed: its state describes what is left in AWS (ADR-0038).
    refuseWhileCloudDelete(app);
    // Nothing is deployed to a Bought Server, or built on one, until it is
    // Ready (spec #1387).
    await refuseDeployUntilReady(this.db, [app.serverId, app.buildServerId]);
    // Nor on a Server in maintenance (spec #1420).
    await refuseWhileInMaintenance(this.db, [app.serverId, app.buildServerId]);

    // A build held for a plan is the one this replaces: this one
    // builds with the saved settings, as "build now" would release it to, so
    // there are never two. Its plan stays open and goes on naming it.
    await this.db
      .update(deployment)
      .set({ status: 'cancelled', finishedAt: new Date().toISOString() })
      .where(
        and(
          eq(deployment.applicationId, applicationId),
          eq(deployment.status, 'held'),
        ),
      );
    return this.recordAndEnqueue(app, type, meta);
  }

  /**
   * Deploys what a GitHub `push` delivery pushed: every Application on
   * the connection, repository and branch it names whose Deploy automatically
   * is on and whose trigger is a push, each recorded pending and enqueued the
   * way a manual deploy is, under {@link pushDeployMeta}'s title and
   * description. Returns the Deployments it recorded.
   *
   * **Scoped by the connection, not a caller.** A webhook has no session; what
   * vouches for it is the signature the controller verified with this
   * connection's secret, so the connection is the scope — the preview path
   * (`PreviewDeploymentsService.handlePullRequestEvent`) is keyed the same way.
   * A same-named repository behind another GitHub connection is another
   * installation's, and is not matched.
   *
   * **`auto_deploy` and `trigger_type` read null as their defaults** (on, and
   * push), because that is how the Source card renders a null — it promises an
   * automatic deploy on a push unless the column is `false` or `tag`. A tag
   * trigger is not deployed by a branch push; tag deploys are not wired.
   *
   * **One Application failing to record does not stop the others.** A build
   * Server that is unreachable refuses that Application's log bootstrap; each
   * target is attempted, each failure is logged by name, and the first is
   * rethrown so the delivery fails visibly on GitHub instead of reading as
   * accepted.
   *
   * **A build `holdFor` names a plan for is recorded `held`, not queued**
   * see {@link recordHeld}.
   */
  async deployOnGithubPush(
    githubId: string,
    event: GithubPushEvent,
    holdFor: PushHoldFor = () => null,
  ): Promise<Deployment[]> {
    if (pushHasNothingToBuild(event)) return [];
    const targets = await this.db
      .select({
        applicationId: application.applicationId,
        appName: application.appName,
        serverId: application.serverId,
        buildServerId: application.buildServerId,
        environmentId: application.environmentId,
        configName: application.configName,
      })
      .from(application)
      .where(
        and(
          eq(application.sourceType, 'github'),
          eq(application.githubId, githubId),
          eq(application.owner, event.owner),
          eq(application.repository, event.repository),
          eq(application.branch, event.branch),
          or(isNull(application.autoDeploy), eq(application.autoDeploy, true)),
          or(
            isNull(application.triggerType),
            eq(application.triggerType, 'push'),
          ),
          // Never a cloud Service being deleted or Delete incomplete.
          isNull(application.cloudDelete),
        ),
      );

    const meta = pushDeployMeta(event);
    const recorded: Deployment[] = [];
    let firstFailure: Error | null = null;
    for (const app of targets) {
      try {
        // Held or queued, nothing is recorded for a Server in maintenance
        // (spec #1420).
        await refuseWhileInMaintenance(this.db, [
          app.serverId,
          app.buildServerId,
        ]);
        const planId = holdFor(app);
        recorded.push(
          planId === null
            ? await this.recordAndEnqueue(app, 'deploy', meta)
            : await this.recordHeld(app, planId, meta),
        );
      } catch (caught) {
        const error =
          caught instanceof Error ? caught : new Error(String(caught));
        this.logger.error(
          `Push to ${event.branch} could not deploy Application ${app.appName}: ${error.message}`,
        );
        firstFailure ??= error;
      }
    }
    if (firstFailure) throw firstFailure;
    return recorded;
  }

  /** Records an Application build pending, then enqueues it — the half of a
   * deploy that follows the caller's authority, shared by a manual trigger and
   * a push. */
  private async recordAndEnqueue(
    app: DeployTarget & { applicationId: string },
    type: 'deploy' | 'redeploy',
    { title, description }: { title: string; description: string },
  ): Promise<Deployment> {
    const { deploymentId, logPath } = await this.initializeLog(app);
    const [row] = await this.db
      .insert(deployment)
      .values({
        deploymentId,
        applicationId: app.applicationId,
        queuedAs: { applicationType: 'application', type },
        title,
        description,
        status: 'pending',
        logPath,
      })
      .returning();

    await this.queue.add({
      applicationType: 'application',
      applicationId: app.applicationId,
      deploymentId,
      title,
      description,
      type,
      serverId: app.serverId,
    });
    return row;
  }

  /**
   * Records a pushed Application's build `held` for a plan (US51): the
   * row is written as {@link recordAndEnqueue} writes it, log bootstrap
   * included, but no job is queued until the build is released
   * ({@link releaseHeld}). A held build of the same Application already
   * waiting (an earlier push's, carried to this plan) is cancelled: this one
   * builds the newer commit, and one release is enough.
   *
   * The plan is locked and must still be open; one that stopped being open
   * in between holds nothing, and the build is queued as it always was.
   */
  private async recordHeld(
    app: DeployTarget & { applicationId: string },
    planId: string,
    { title, description }: { title: string; description: string },
  ): Promise<Deployment> {
    const { deploymentId, logPath } = await this.initializeLog(app);
    const [row] = await this.db.transaction(async (tx) => {
      const [open] = await tx
        .select({ planId: plan.planId })
        .from(plan)
        .where(and(eq(plan.planId, planId), eq(plan.status, 'open')))
        .for('update');
      if (open) {
        await tx
          .update(deployment)
          .set({ status: 'cancelled', finishedAt: new Date().toISOString() })
          .where(
            and(
              eq(deployment.applicationId, app.applicationId),
              eq(deployment.status, 'held'),
            ),
          );
      }
      return tx
        .insert(deployment)
        .values({
          deploymentId,
          applicationId: app.applicationId,
          // Released as a deploy (`enqueueRecorded`), whatever held it.
          queuedAs: { applicationType: 'application', type: 'deploy' },
          title,
          description,
          status: open ? 'held' : 'pending',
          heldByPlanId: open ? planId : null,
          logPath,
        })
        .returning();
    });
    if (row.status === 'pending') await this.enqueueRecorded(row, app.serverId);
    return row;
  }

  /**
   * Releases a held build: `pending`, and queued as a push's build is,
   * so it builds with whatever settings are saved when it starts — the plan's
   * after its Apply, the old ones after a dismiss or "build now". Internal, no
   * PermissionCtx: its callers are the plan's Apply (already held to
   * `deployment: create`), the plan transitions, and {@link buildNow}'s
   * gates. `null` when the build is no longer held.
   */
  async releaseHeld(deploymentId: string): Promise<Deployment | null> {
    const [released] = await this.db
      .update(deployment)
      .set({ status: 'pending' })
      .where(
        and(
          eq(deployment.deploymentId, deploymentId),
          eq(deployment.status, 'held'),
        ),
      )
      .returning();
    if (!released?.applicationId) return released ?? null;
    const app = await this.findApplication(released.applicationId);
    await this.enqueueRecorded(released, app.serverId);
    return released;
  }

  /**
   * Releases every held build of the Environment's Applications whose plan
   * is no longer open: applied, dismissed, superseded by a plan that
   * no longer changes the Application, or deleted. Called after each plan
   * transition, and idempotent, so a transition any path makes is answered
   * by the next call at the latest.
   */
  async releaseHeldOutsideOpenPlans(
    environmentId: string,
  ): Promise<Deployment[]> {
    const rows = await this.db
      .select({ deploymentId: deployment.deploymentId })
      .from(deployment)
      .innerJoin(
        application,
        eq(deployment.applicationId, application.applicationId),
      )
      .leftJoin(plan, eq(deployment.heldByPlanId, plan.planId))
      .where(
        and(
          eq(application.environmentId, environmentId),
          eq(deployment.status, 'held'),
          or(isNull(plan.planId), sql`${plan.status} <> 'open'`),
        ),
      );
    const released: Deployment[] = [];
    for (const { deploymentId } of rows) {
      const row = await this.releaseHeld(deploymentId);
      if (row) released.push(row);
    }
    return released;
  }

  /**
   * "Build now with saved settings" (US52): releases a held build at
   * once, so a plan nobody has reviewed does not block an urgent fix. Gated
   * as a deploy is: `deployment: create` and a read of the Application. The
   * plan stays open and goes on naming the build. A build that is not held is
   * a 409.
   */
  async buildNow(
    ctx: PermissionCtx,
    deploymentId: string,
  ): Promise<Deployment> {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const row = await this.findOwnedDeployment(ctx, deploymentId);
    if (row.applicationId) {
      await this.permissions.checkServiceAccess(ctx, row.applicationId, 'read');
    }
    const released =
      row.status === 'held' ? await this.releaseHeld(deploymentId) : null;
    if (!released) {
      throw new ConflictException(
        `This deployment is not held for a plan (it is ${row.status === 'held' ? 'already released' : row.status}), so there is nothing to build now`,
      );
    }
    return released;
  }

  /** Queues the job that builds a recorded Application row. */
  private async enqueueRecorded(row: Deployment, serverId: string | null) {
    if (!row.applicationId) return;
    await this.queue.add({
      ...jobOfRow(row, 'deploy', serverId),
      applicationType: 'application',
      applicationId: row.applicationId,
    });
  }

  /**
   * The compose sibling of {@link deploy} — records the attempt as pending,
   * then enqueues a compose job for the processor.
   */
  async deployCompose(
    ctx: PermissionCtx,
    composeId: string,
    meta: DeployMeta = {},
  ) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    await this.permissions.checkServiceAccess(ctx, composeId, 'read');
    return this.queueCompose(await this.findOwnedCompose(ctx, composeId), meta);
  }

  /**
   * A stack's first Deployment once its Stack VM is made (ADR-0070): the
   * Apply that created the stack was checked for `deployment: ['create']`
   * before any step ran, and the Cloud run that made the Stack VM queues
   * this one, as an Application's Apply queues its build.
   */
  async deployComposeOnItsStackVm(composeId: string, meta: DeployMeta = {}) {
    return this.queueCompose(
      await this.findOwnedCompose(null, composeId),
      meta,
    );
  }

  /** A stack's Deployment, refused or recorded pending and queued. */
  private async queueCompose(
    target: Awaited<ReturnType<DeploymentsService['findOwnedCompose']>>,
    meta: DeployMeta,
  ) {
    refuseWithoutSource('Compose stack', target);
    await this.refuseUntilStackVmRuns(target);
    await refuseDeployUntilReady(this.db, [target.serverId]);
    await refuseWhileInMaintenance(this.db, [target.serverId]);

    const title = meta.title ?? DEPLOY_TITLE;
    const description = meta.description ?? '';

    const { deploymentId, logPath } = await this.initializeLog(target);
    const [row] = await this.db
      .insert(deployment)
      .values({
        deploymentId,
        composeId: target.composeId,
        queuedAs: { applicationType: 'compose', type: 'deploy' },
        title,
        description,
        status: 'pending',
        logPath,
      })
      .returning();

    await this.queue.add({
      applicationType: 'compose',
      composeId: target.composeId,
      deploymentId,
      title,
      description,
      type: 'deploy',
      serverId: target.serverId,
    });
    return row;
  }

  /**
   * A stack whose Stack VM is stopped takes no Deployment (ADR-0070, #1370):
   * nothing can reach it until Start brings it back, so the operator is told
   * to start it first rather than handed a Deployment that fails at the
   * tunnel. Read from the cloud now, so a Stack VM stopped outside Cloudgate
   * is refused too; a read the cloud did not answer refuses nothing. One no
   * Apply has made yet (a console stack before its plan) is refused as
   * well, saying the plan makes it (#1357 review).
   */
  private async refuseUntilStackVmRuns(target: {
    name: string;
    configName: string;
    cloudAccountId: string | null;
    region: string | null;
    stackVm: StackVmSettings | null;
  }): Promise<void> {
    if (target.cloudAccountId === null) return;
    const { state } = await this.moduleRef
      .get(StackVmPower, { strict: false })
      .state(target);
    if (state === 'not-made') throw stackVmNotMadeRefusal(target.configName);
    if (STACK_VM_DOWN.has(state)) {
      throw new ConflictException(
        `${target.name}'s Stack VM is stopped: start it first, then deploy`,
      );
    }
  }

  /**
   * The Deployment of this Service a new build would join rather than queue
   * behind — or `null`, and the caller queues one. The MCP `deploy_service`
   * tool's coalescing (spec "Coalescing"); the console and webhook
   * deploy paths never call it and queue every request, as they always have.
   *
   * Gated exactly as {@link deploy} and {@link deployCompose} are — the
   * statement, the row-level grant, the ownership read — and before anything
   * is looked up, so a Service the caller may not deploy answers with the
   * same refusal a deploy would, never with a pending id.
   *
   * **Only a build still waiting in the queue is joined, under its own row.**
   * The row answered is the one a waiting job of the Service names, and
   * only while it is still `pending` — the row that job's build will claim.
   * A preview's build is a Deployment of this Application too, but it is
   * never joined: asking to ship production must not quietly mean "a
   * preview is already building". A job that names no row is not joined
   * either. A `pending` row no waiting
   * job names is never joined either: only a waiting job is sure to build its
   * row. The local queue is in memory, and a restart drops its jobs; their
   * rows are queued again at start-up, before the API listens, so they
   * are joinable again from then. A `running` build is never
   * joined — what it built from was read when it started.
   *
   * **A `deploy` on a queued `redeploy` upgrades it to a deploy.** The
   * processor builds both types the same way (`deployment-processor.ts`), and
   * the queue cannot rewrite a job it holds. So the upgrade is what is
   * observable: the row is retitled from the redeploy's default title to the
   * deploy's, and the type its `queued_as` records becomes `deploy`, which is
   * what a restart queues it again as; the waiting job is left as it
   * is. A title someone chose is left alone, and so is its row. A `redeploy`
   * on a queued deploy joins it unchanged.
   */
  async joinQueuedBuild(
    ctx: PermissionCtx,
    serviceType: BuiltServiceType,
    serviceId: string,
    type: 'deploy' | 'redeploy',
  ): Promise<Deployment | null> {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    await this.permissions.checkServiceAccess(ctx, serviceId, 'read');
    if (serviceType === 'application') {
      await this.findOwnedApplication(ctx, serviceId);
    } else {
      await this.findOwnedCompose(ctx, serviceId);
    }
    const group = `${serviceType}:${serviceId}`;

    // A preview's build is in its parent's group but is never a production
    // deploy's to join: fenced by the job's arm and by the row's link
    // column, so neither half alone decides it.
    const joinable = await firstJoinableBuild(
      this.db,
      this.queue,
      (job) =>
        job.applicationType !== 'application-preview' &&
        getGroup(job) === group,
      serviceType === 'application'
        ? and(
            eq(deployment.applicationId, serviceId),
            isNull(deployment.previewDeploymentId),
          )
        : eq(deployment.composeId, serviceId),
    );
    if (!joinable) return null;
    const { pending, waiting } = joinable;

    if (
      type === 'deploy' &&
      waiting.type === 'redeploy' &&
      pending.title === REDEPLOY_TITLE
    ) {
      const [upgraded] = await this.db
        .update(deployment)
        .set({
          title: DEPLOY_TITLE,
          queuedAs: pending.queuedAs && {
            applicationType: pending.queuedAs.applicationType,
            type: 'deploy',
          },
        })
        .where(
          and(
            eq(deployment.deploymentId, pending.deploymentId),
            eq(deployment.status, 'pending'),
          ),
        )
        .returning();
      // Started between the read and the write: it is building what a
      // deploy would, and the row stays as the engine claimed it.
      return upgraded ?? pending;
    }
    return pending;
  }

  /**
   * Records a Preview deployment's build `pending` as a Deployment of its
   * parent Application naming the preview, then enqueues the job that names
   * that row — {@link recordAndEnqueue}'s shape for the
   * preview arm. The row is in the parent's history and log directory, as a
   * preview build's always was, and from here it is visible and
   * cancellable while it waits, through the ordinary {@link cancel}.
   *
   * Internal, so no PermissionCtx: its two callers have already held the
   * request to its authority — the verified pull-request webhook, and
   * `PreviewDeploymentsService.redeploy`'s gates. The preview is passed with
   * its own `applicationId`, which is the only Application the link column
   * lets it qualify.
   */
  async queuePreviewBuild(
    preview: { previewDeploymentId: string; applicationId: string },
    type: 'deploy' | 'redeploy',
    { title, description }: { title: string; description: string },
  ): Promise<Deployment> {
    const parent = await this.findApplication(preview.applicationId);
    const { deploymentId, logPath } = await this.initializeLog(parent);
    const [row] = await this.db
      .insert(deployment)
      .values({
        deploymentId,
        applicationId: preview.applicationId,
        previewDeploymentId: preview.previewDeploymentId,
        queuedAs: { applicationType: 'application-preview', type },
        title,
        description,
        status: 'pending',
        logPath,
      })
      .returning();

    await this.queue.add({
      applicationType: 'application-preview',
      applicationId: preview.applicationId,
      previewDeploymentId: preview.previewDeploymentId,
      deploymentId,
      title,
      description,
      type,
      serverId: parent.serverId,
    });
    return row;
  }

  /**
   * The pending build of *this* preview a redeploy of it joins, or `null`.
   * Scoped by the link column rather than by the
   * parent's queue group, which production and every sibling preview share:
   * otherwise a preview redeploy would join a pending production deploy.
   * Only a job still waiting under its own `pending` row is joined, as in
   * {@link joinQueuedBuild}; a running build never is.
   *
   * Internal: `PreviewDeploymentsService.redeploy` gates first.
   */
  async joinQueuedPreviewBuild(
    previewDeploymentId: string,
  ): Promise<Deployment | null> {
    const joinable = await firstJoinableBuild(
      this.db,
      this.queue,
      (job) =>
        job.applicationType === 'application-preview' &&
        job.previewDeploymentId === previewDeploymentId,
      eq(deployment.previewDeploymentId, previewDeploymentId),
    );
    return joinable?.pending ?? null;
  }

  /**
   * Stops a build that was asked for, or one that is running.
   *
   * - a **queued** build is dequeued and its record left `cancelled`. The queue
   *   is the only thing holding a build that has not begun, so cancelling
   *   means taking the job back out of it: `QueuePort.cancel` removes a waiting
   *   job and answers false for one that has already started. The job taken
   *   out is the one naming this record, never another build of the
   *   same Service. It never runs. A worker that took the job first wins:
   *   `QueuePort.cancel` answers false for it, so this answers 409 and leaves
   *   the record for the engine's {@link create} to claim.
   * - a **running** build is killed. The engine claimed its record through
   *   {@link create}, which opened a cancel window: aborting it kills whichever
   *   of the build's shell steps is running — the process group on the
   *   platform host, the SSH session on a Server — and the engine, seeing the
   *   abort, writes no status of its own over the `cancelled` this writes. Its
   *   queue slot frees as soon as the engine returns, so the next build on
   *   that Server starts.
   *
   * What is refused is a build past its shell steps: the engine closes the
   * window before it releases the image as a Swarm service and waits for it to
   * converge, which a kill cannot stop part-way, so a record there stays
   * `running` and the release finishes on its own. It does not mark a record
   * `cancelled` while something carries on, because that reads as a stopped
   * build in history and would be overwritten with `done` minutes later.
   */
  async cancel(ctx: PermissionCtx, deploymentId: string): Promise<Deployment> {
    await this.permissions.checkPermission(ctx, { deployment: ['cancel'] });

    const row = await this.findOwnedDeployment(ctx, deploymentId);

    // An Environment network's run, a postgres on RDS's, a
    // redis on ElastiCache's and a bucket on AWS's is a Cloud
    // run and nothing else: there is no build before it to stop.
    if (
      row.environmentNetworkId ||
      row.postgresId ||
      row.mysqlId ||
      row.redisId ||
      row.bucketId
    ) {
      await this.resolveLogServer(ctx, row);
      const cloud = this.cloudRuns.cancel(deploymentId);
      if (cloud === 'applying') {
        throw new ConflictException(CANCEL_REFUSED_WHILE_APPLYING);
      }
      if (cloud === 'cancelled') return this.markCancelled(deploymentId);
      throw new ConflictException(
        row.postgresId || row.mysqlId || row.redisId || row.bucketId
          ? 'This Cloud run has already ended, so there is nothing to cancel'
          : 'This Environment network run has already ended, so there is nothing to cancel',
      );
    }

    // A Cron service's run is not a build and has nothing queued to take
    // back: cancelling it stops its job and settles it `cancelled`,
    // and its timetable keeps going.
    if (row.cronRun) {
      await this.permissions.checkServiceAccess(
        ctx,
        row.applicationId!,
        'read',
      );
      if (!(await this.cronRuns.cancelRun(deploymentId, ctx.user.id))) {
        throw new ConflictException(
          'This run has already ended, so there is nothing to cancel',
        );
      }
      const [cancelled] = await this.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      return cancelled;
    }

    // Only builds are ever enqueued: a schedule, backup or volume-backup run
    // is recorded as a deployment row but executed by its own service on a
    // cron, with nothing in the queue to take back.
    const group = await this.buildGroupOf(ctx, row);

    // A Cloud run in its pool: Cancel while it waits or plans, and a
    // refusal once its apply has begun. Its build, before it, is a build.
    const cloud = this.cloudRuns.cancel(deploymentId);
    if (cloud === 'applying') {
      throw new ConflictException(CANCEL_REFUSED_WHILE_APPLYING);
    }
    if (cloud === 'cancelled') return this.markCancelled(deploymentId);

    const outcome = await this.stopBuild(row, group);
    if ('refusal' in outcome) throw new ConflictException(outcome.refusal);
    return outcome.cancelled;
  }

  /**
   * **Stop the run** (spec US69/US111): ends a Cloud run whatever
   * phase it is in, its apply included — one interrupt, a kill 5 minutes
   * later — and its row ends `error` saying who stopped it, never
   * `cancelled`, and is never run again by itself. Gated like {@link cancel}
   * (`deployment: cancel`, Agents included): whoever may cancel a deploy may
   * end one that hangs. A run still waiting is Cancel's, and is refused here
   * with that said. Answers the row, still `running` until the run has ended.
   */
  async stopRun(ctx: PermissionCtx, deploymentId: string): Promise<Deployment> {
    await this.permissions.checkPermission(ctx, { deployment: ['cancel'] });
    const row = await this.findOwnedDeployment(ctx, deploymentId);
    if (
      row.environmentNetworkId ||
      row.postgresId ||
      row.mysqlId ||
      row.redisId ||
      row.bucketId
    ) {
      await this.resolveLogServer(ctx, row);
    } else {
      await this.buildGroupOf(ctx, row);
    }

    const [caller] = await this.db
      .select({
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      })
      .from(user)
      .where(eq(user.id, ctx.user.id));
    const by =
      `${caller?.firstName ?? ''} ${caller?.lastName ?? ''}`.trim() ||
      caller?.email ||
      ctx.user.id;

    const outcome = await this.cloudRuns.stop(deploymentId, by);
    if (outcome === 'waiting') {
      throw new ConflictException(
        'This Cloud run has not started, so there is nothing to stop. Cancel takes it out of the queue',
      );
    }
    if (outcome === 'unknown') {
      throw new ConflictException(
        'Only a running Cloud run can be stopped, and this deployment is not one. Cancel stops a build',
      );
    }
    const [current] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId));
    return current;
  }

  /**
   * Stops every build of one Preview deployment that can still be stopped,
   * and says whether one of its builds is still in flight. **The platform's cancel: no
   * caller, no gate, no audit** — its callers are `PreviewDeploymentsService`'s shared
   * teardown, which the
   * verified pull-request webhook and a gated `DELETE` reach, and the
   * expiry sweep, which runs as the platform.
   *
   * The builds are found through the link column: every row of the
   * parent naming this preview that is still `pending` or `running`. Each is
   * put through {@link stopBuild}, the core {@link cancel} runs after its
   * gates, so a waiting build is taken back out of the queue and a running
   * one inside its cancel window is killed — and a production build of the same
   * parent is never among them, because none names the preview.
   *
   * **`building` is read off the queue, not off the rows, because the row
   * settles before the build's work is over.** `engine.deploy` writes `done`
   * and then `deployPreview` still writes the preview's Traefik router, so a
   * teardown that waited for the row alone could remove the router and have it
   * written back a moment later. The job stays active until `deployPreview`
   * returns, whether the release finished or a killed build unwound, so an
   * active job of this preview is exactly "something may still create a
   * service or a router for it". A restart leaves no row held by nothing: its
   * waiting builds are queued again and its running one settled `error` at
   * start-up, before this can be reached.
   *
   * One pass, so it is the tick of a sweep as much as a step of a wait: the
   * caller decides whether to come back.
   *
   * `reason`, when given, replaces the description of every build this pass
   * cancels: the expiry sweep passes the words saying the preview
   * expired, so the history reads `cancelled` with why. A
   * build it cannot stop keeps its own description.
   */
  async cancelPreviewBuilds(
    previewDeploymentId: string,
    reason?: { description: string },
  ): Promise<{ cancelled: Deployment[]; building: boolean }> {
    const rows = await this.db
      .select()
      .from(deployment)
      .where(
        and(
          eq(deployment.previewDeploymentId, previewDeploymentId),
          inArray(deployment.status, ['pending', 'running']),
        ),
      );
    const cancelled: Deployment[] = [];
    for (const row of rows) {
      // A preview's row always qualifies its parent Application (the
      // `deployment_preview_qualifies_an_application` check), whose queue
      // group the preview's jobs share.
      const outcome = await this.stopBuild(
        row,
        `application:${row.applicationId}`,
        reason?.description,
      );
      if ('cancelled' in outcome) cancelled.push(outcome.cancelled);
    }
    const active = await this.queue.getJobs(['active']);
    const building = active.some(
      ({ data }) =>
        data.applicationType === 'application-preview' &&
        data.previewDeploymentId === previewDeploymentId,
    );
    return { cancelled, building };
  }

  /**
   * The cancel itself, once a caller — or the platform — may make it: the
   * record `cancelled`, or the sentence saying why it could not be. See
   * {@link cancel} for the three cases and the refusal.
   */
  private async stopBuild(
    row: Deployment,
    group: string,
    description?: string,
  ): Promise<{ cancelled: Deployment } | { refusal: string }> {
    const { deploymentId } = row;
    if (row.status === 'held') {
      // Held for a plan: no job exists, so the record is all there is.
      const [cancelled] = await this.settleCancelled(
        and(
          eq(deployment.deploymentId, deploymentId),
          eq(deployment.status, 'held'),
        ),
        description,
      );
      if (cancelled) return { cancelled };
      return {
        refusal:
          'This build was released from its plan a moment ago; cancel it again to take it out of the queue',
      };
    }
    if (row.status !== 'pending' && row.status !== 'running') {
      return {
        refusal: `This deployment is already ${row.status} — there is nothing left to cancel`,
      };
    }

    if (row.status === 'running') {
      // Read and abort with no await between, so the engine's own
      // `closeCancelWindow` lands wholly before or wholly after this.
      const build = this.cancellableBuilds.get(deploymentId);
      if (build) {
        this.cancellableBuilds.delete(deploymentId);
        build.abort();
        return {
          cancelled: await this.markCancelled(deploymentId, description),
        };
      }
    }

    // A running record's job is the active one; a queued record's is waiting
    // or just taken. A running record is never matched
    // against a waiting job: that job is a *later* build of the same service,
    // and dequeuing it would label this one cancelled while it ran on.
    const jobs = await this.queue.getJobs();
    const states: QueuedJob['state'][] =
      row.status === 'running' ? ['active'] : ['waiting', 'active'];
    const mine = states
      .flatMap((state) => jobs.filter((job) => job.state === state))
      .filter((job) => jobBuildsRecord(job.data, row, group));

    for (const job of mine) {
      if (await this.queue.cancel(job.id)) {
        return {
          cancelled: await this.markCancelled(deploymentId, description),
        };
      }
    }

    // A running record with no cancel window is releasing its image. One whose
    // build a restart cut off is never running here: start-up settled it
    // `error` before the API listened.
    return {
      refusal:
        row.status === 'running'
          ? 'This deployment has finished building and is releasing the image, which cannot be stopped part-way. It finishes on its own.'
          : 'This build is no longer waiting in the queue, so it cannot be taken back out of it. Once it shows as running, cancel it again to stop it.',
    };
  }

  /** The queue group a deployment record's build belongs to, once the caller
   * has been authorized against the service that owns it. Throws for a record
   * that is a schedule or backup run rather than a build. */
  private async buildGroupOf(
    ctx: PermissionCtx,
    row: Pick<Deployment, 'applicationId' | 'composeId'>,
  ): Promise<string> {
    if (row.applicationId) {
      await this.permissions.checkServiceAccess(ctx, row.applicationId, 'read');
      const app = await this.findOwnedApplication(ctx, row.applicationId);
      return `application:${app.applicationId}`;
    }
    if (row.composeId) {
      await this.permissions.checkServiceAccess(ctx, row.composeId, 'read');
      const target = await this.findOwnedCompose(ctx, row.composeId);
      return `compose:${target.composeId}`;
    }
    throw new BadRequestException(
      'Only a build can be cancelled; this deployment records a scheduled run',
    );
  }

  /** The record, terminal, with `description` in place of its own when
   * the platform says why. */
  private async markCancelled(
    deploymentId: string,
    description?: string,
  ): Promise<Deployment> {
    const [updated] = await this.settleCancelled(
      eq(deployment.deploymentId, deploymentId),
      description,
    );
    if (!updated) throw new NotFoundException('Deployment not found');
    return updated;
  }

  /** Every record `where` matches, settled `cancelled` — the one spelling of
   * that write for {@link markCancelled} and {@link emptyQueue}. Shares
   * {@link updateStatus}'s finishedAt stamp. */
  private settleCancelled(
    where: SQL | undefined,
    description?: string,
  ): Promise<Deployment[]> {
    return this.db
      .update(deployment)
      .set({
        status: 'cancelled',
        finishedAt: new Date().toISOString(),
        ...(description === undefined ? {} : { description }),
      })
      .where(where)
      .returning();
  }

  onApplicationBootstrap(): Promise<void> {
    return this.settleBuildsAtStartUp();
  }

  /**
   * Start-up for Docker builds, as `CloudRunsService.settleAtStartUp`
   * is for Cloud runs: the build queue is in memory, so the rows are
   * what survive a restart. A build still `pending` never started, and is
   * queued again — in `createdAt` order and under its own row, so the
   * engine claims it and Cancel reaches it as any waiting build — but only as
   * exactly the job it was queued as (`requeuedJob`). One that cannot prove
   * that is never built as a guess: a deleted preview's build ends `error`
   * with {@link PREVIEW_BUILD_NOT_REQUEUED}, and any other row, a cloud row
   * caught before its `cloud_run` was set among them, with
   * {@link NOT_STARTED_BEFORE_RESTART}. A build
   * still `running` was cut off: it ends `error` with
   * {@link BUILD_CUT_OFF_BY_RESTART}, the same sentence its log's last line,
   * and is never run again by itself. A `held` build is its plan's, and is
   * left as it is.
   *
   * **Which rows.** An Application's or a Compose stack's, with no
   * `cloud_run` (the Cloud run pool settles those) and no `cron_run` (a Cron
   * service's run is not a build). Every instance, hosted or not, holds its
   * builds in this process.
   *
   * Tolerant of an un-migrated database, like every boot hook: a boot that
   * cannot settle still boots. A row that cannot be settled is that row's
   * failure, not the rest's ({@link settleBuildAtStartUp}). The log lines are not waited for, so a Server
   * that cannot be reached does not hold the boot up.
   */
  async settleBuildsAtStartUp(): Promise<void> {
    try {
      const rows = await this.db
        .select()
        .from(deployment)
        .where(
          and(
            or(
              isNotNull(deployment.applicationId),
              isNotNull(deployment.composeId),
            ),
            isNull(deployment.cloudRun),
            isNull(deployment.cronRun),
            inArray(deployment.status, ['pending', 'running']),
          ),
        )
        .orderBy(deployment.createdAt);
      for (const row of rows) await this.settleBuildAtStartUp(row);
    } catch (error) {
      this.logger.error('Builds could not be settled at start-up', error);
    }
  }

  /**
   * One row of {@link settleBuildsAtStartUp}. A row that fails — its Service
   * cannot be read, or its job cannot be queued — is that row's failure
   * alone: it is logged and settled `error` as one not queued again, and the
   * rows after it are still settled. Otherwise one bad row would leave every
   * later build `pending` or `running` for ever, the dead end this removes.
   */
  private async settleBuildAtStartUp(row: Deployment): Promise<void> {
    try {
      const target = row.applicationId
        ? await this.findApplication(row.applicationId)
        : await this.findCompose(requireServiceId(row.composeId));
      const job =
        row.status === 'pending' ? requeuedJob(row, target.serverId) : null;
      if (job) {
        await this.queue.add(job);
        return;
      }
      await this.settleCutOff(
        row,
        row.status === 'pending'
          ? notRequeuedReason(row)
          : BUILD_CUT_OFF_BY_RESTART,
      );
    } catch (error) {
      this.logger.error(
        `Build ${row.deploymentId} could not be settled at start-up`,
        error,
      );
      await this.settleCutOff(
        row,
        row.status === 'pending'
          ? NOT_STARTED_BEFORE_RESTART
          : BUILD_CUT_OFF_BY_RESTART,
      ).catch((settleError: unknown) =>
        this.logger.error(
          `Build ${row.deploymentId} could not be settled at start-up`,
          settleError,
        ),
      );
    }
  }

  /** Ends a row start-up found `error` with `reason`, unless it moved on. */
  private async settleCutOff(row: Deployment, reason: string): Promise<void> {
    const [settled] = await this.db
      .update(deployment)
      .set({
        status: 'error',
        description: reason,
        finishedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(deployment.deploymentId, row.deploymentId),
          eq(deployment.status, row.status),
        ),
      )
      .returning();
    if (settled) void this.logLastLine(settled, reason);
  }

  /**
   * Settings → Instance → Empty the build queue: drops every build that
   * has not started, and settles the Deployment each one was recorded as.
   * Internal — the caller has already been held to instance authority.
   *
   * **The rows are the point.** Emptying the queue used to stop at the queue,
   * so a dropped build's row stayed `pending` for ever, and every reader of
   * `pending` went on presenting it as live work: a streaming log panel, an
   * enabled Cancel, and "A build is running" on the Deployments tab — for a
   * build that would never start. It is now `cancelled`, the status a queued
   * build taken back out of the queue already gets from {@link cancel}, with
   * `finishedAt` stamped and a last line in its log saying why and what to do.
   *
   * **Which rows.** Exactly the ones the dropped jobs name, and only
   * while still `pending`: every job carries the id of the row its trigger
   * inserted, so a row whose job a worker already holds is not among them,
   * and a running build is not touched.
   *
   * A preview build is among them: its job names the pending row
   * of the parent it was queued under, and that row is settled the same way.
   */
  async emptyQueue(): Promise<void> {
    const dropped = await this.queue.clearWaiting();

    const ids = dropped
      .map(({ data }) => ownDeploymentId(data))
      .filter((id) => id !== null);
    if (ids.length === 0) return;

    const settled = await this.settleCancelled(
      and(
        inArray(deployment.deploymentId, ids),
        eq(deployment.status, 'pending'),
      ),
    );
    for (const row of settled) {
      await this.logLastLine(
        row,
        'Dropped: the build queue was emptied before this build started, so it never ran. Deploy again to build it.',
      );
    }
  }

  /**
   * The last line of a build's log that ended without finishing: one dropped
   * from the queue, or cut off by a restart. It is all the console has
   * to show for it — until then, "Initializing deployment" and whatever the
   * build had printed. Written where the build logs. Best effort: the record
   * is already settled, and a Server that cannot be reached to write one line
   * must not turn emptying the queue, or a start-up, into an error.
   */
  private async logLastLine(
    row: Pick<Deployment, 'applicationId' | 'composeId' | 'logPath'>,
    line: string,
  ): Promise<void> {
    try {
      const target = row.applicationId
        ? await this.findApplication(row.applicationId)
        : row.composeId
          ? await this.findCompose(row.composeId)
          : null;
      if (!target) return;
      const command = `echo ${quote([line])} >> ${quote([row.logPath])};`;
      await execOnServer(this.remoteExec, buildHostServerId(target), command);
    } catch {
      // See above: the status is the record, the line is a courtesy.
    }
  }

  /**
   * The deployment engine calls this when a build starts. A deploy queued
   * through {@link deploy} already has a pending row (log file included), and
   * its job names it: claim exactly that row, or answer `null` when it
   * is no longer `pending` — settled between the dequeue and this claim, so
   * the engine builds nothing. A preview build's job names its row the same
   * way. Without an id, initialize a log file and record a fresh running attempt; a pending row is
   * never taken. Internal, so no PermissionCtx.
   *
   * **It branches on the input's discriminant and states no precedence**
   * (ADR-0017). It used to read `input.composeId ?? input.applicationId`
   * for the claim scope and the build target, and coalesce both through to the
   * insert — which meant this method carried a *compose-first* ranking of the
   * two parents while every reader of a record (`ownerOf` and
   * `ownedServiceId()` in `service-scope.ts`, {@link resolveCancelScope},
   * {@link resolveLogServer}, and 0064's normalization of the rows that
   * predated `deployment_at_most_one_parent`) ranked them application-first.
   * Both spellings could not be right, and the one to delete was this one: a
   * writer that is *told* which kind of record it is writing has no ranking to
   * get wrong, so the order is now written down in exactly one place, on
   * `ownerOf`. The `?? null` pair is gone with it — {@link parentColumns}
   * writes the one column the arm names.
   */
  async create(
    input: CreateDeploymentInput & { deploymentId?: undefined },
  ): Promise<DeploymentRecord>;
  async create(input: CreateDeploymentInput): Promise<DeploymentRecord | null>;
  async create(input: CreateDeploymentInput): Promise<DeploymentRecord | null> {
    if (input.deploymentId !== undefined) {
      const scope =
        input.kind === 'application'
          ? eq(deployment.applicationId, input.applicationId)
          : eq(deployment.composeId, input.composeId);
      if (await this.refuseFrozenClaim(input.deploymentId, input)) return null;
      if (await this.refuseServerClaim(input.deploymentId, input)) {
        return null;
      }
      const [claimed] = await this.db
        .update(deployment)
        .set({ status: 'running', startedAt: new Date().toISOString() })
        .where(
          and(
            eq(deployment.deploymentId, input.deploymentId),
            scope,
            eq(deployment.status, 'pending'),
          ),
        )
        .returning();
      if (!claimed) return null;
      return this.openCancelWindow({
        deploymentId: claimed.deploymentId,
        logPath: claimed.logPath,
      });
    }

    const target =
      input.kind === 'application'
        ? await this.findApplication(input.applicationId)
        : await this.findCompose(input.composeId);
    const { deploymentId, logPath } = await this.initializeLog(target);

    const [row] = await this.db
      .insert(deployment)
      .values({
        deploymentId,
        ...parentColumns(input),
        title: input.title,
        description: input.description,
        status: 'running',
        logPath,
        startedAt: new Date().toISOString(),
      })
      .returning();
    return this.openCancelWindow({
      deploymentId: row.deploymentId,
      logPath: row.logPath,
    });
  }

  /**
   * A queued build of a Frozen Organization never starts (ADR-0052):
   * whatever queued it — a deploy asked before the freeze, a build released
   * from its plan, a row queued again at start-up — its row ends `error`
   * with the refusal ("Pay to continue") at the claim, and the engine builds
   * nothing. A build already claimed is not asked again, so one running
   * when the freeze lands finishes.
   */
  private async refuseFrozenClaim(
    deploymentId: string,
    input: CreateDeploymentInput,
  ): Promise<boolean> {
    const refusal = await this.moduleRef
      .get(FrozenOrganizations, { strict: false })
      .refusalAt({
        serviceId:
          input.kind === 'application' ? input.applicationId : input.composeId,
      });
    if (refusal === null) return false;
    await this.db
      .update(deployment)
      .set({
        status: 'error',
        description: refusal,
        finishedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(deployment.deploymentId, deploymentId),
          eq(deployment.status, 'pending'),
        ),
      );
    return true;
  }

  /**
   * A queued build bound for a Bought Server that is not Ready (spec #1387),
   * or for a Server in maintenance (spec #1420), as its run or build Server,
   * never starts: one queued by a path that does not ask first, or before
   * maintenance began — a push, a release from its plan, a row queued again
   * at start-up — ends `error` at the claim with the refusal a deploy would
   * have been answered with, as {@link refuseFrozenClaim} does for a Frozen
   * Organization.
   */
  private async refuseServerClaim(
    deploymentId: string,
    input: CreateDeploymentInput,
  ): Promise<boolean> {
    // A Service gone since its build was queued is the claim's to find, not
    // this check's, so a missing one refuses nothing here.
    const target =
      input.kind === 'application'
        ? await this.findApplication(input.applicationId).catch(() => null)
        : await this.findCompose(input.composeId).catch(() => null);
    if (!target) return false;
    const servers = [target.serverId, target.buildServerId];
    const refusal =
      (await deployRefusal(this.db, servers)) ??
      (await maintenanceRefusal(this.db, servers));
    if (refusal === null) return false;
    await this.db
      .update(deployment)
      .set({
        status: 'error',
        description: refusal,
        finishedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(deployment.deploymentId, deploymentId),
          eq(deployment.status, 'pending'),
        ),
      );
    return true;
  }

  /**
   * Records an Environment network's Cloud run: a `pending` row whose
   * parent is the network (ADR-0017 extended) and its Deployment log, on the
   * platform host where `tofu` runs, under the network's own log directory
   * ({@link environmentNetworkLogOwner}). The caller then submits it to the
   * Cloud run pool, which turns it `running` and settles it. Internal, so no
   * PermissionCtx: the Apply that asks has already been allowed.
   */
  async recordEnvironmentNetworkRun(input: {
    environmentNetworkId: string;
    title: string;
    description: string;
    /**
     * The Service whose Domain the run is about, on Google Cloud (S14): the
     * run is listed on that Service too, its parent still the network.
     */
    forServiceId?: string;
  }): Promise<Deployment> {
    const deploymentId = nanoid();
    const logPath = `${deploymentLogsDirectoryOn(null, environmentNetworkLogOwner(input.environmentNetworkId))}/${deploymentId}.log`;
    await this.initLogFile(null, logPath);
    const [row] = await this.db
      .insert(deployment)
      .values({
        deploymentId,
        ...parentColumns({
          kind: 'environmentNetwork',
          environmentNetworkId: input.environmentNetworkId,
        }),
        forServiceId: input.forServiceId ?? null,
        title: input.title,
        description: input.description,
        status: 'pending',
        logPath,
      })
      .returning();
    return row;
  }

  /**
   * Records a postgres on RDS's Cloud run: a `pending` row whose
   * parent is the postgres (ADR-0017 extended) and its Deployment log on the
   * platform host, where `tofu` runs, under the database's `appName`. The
   * caller submits it to the Cloud run pool, which settles it. Internal, so
   * no PermissionCtx: the Apply that asks has already been allowed.
   */
  recordPostgresCloudRun(input: {
    postgresId: string;
    appName: string;
    title: string;
    description: string;
  }): Promise<Deployment> {
    const { postgresId, ...rest } = input;
    return this.recordDatabaseCloudRun({ kind: 'postgres', postgresId }, rest);
  }

  /** A mysql on RDS's Cloud run, recorded as a postgres's is. */
  recordMysqlCloudRun(input: {
    mysqlId: string;
    appName: string;
    title: string;
    description: string;
  }): Promise<Deployment> {
    const { mysqlId, ...rest } = input;
    return this.recordDatabaseCloudRun({ kind: 'mysql', mysqlId }, rest);
  }

  /** A redis on ElastiCache's Cloud run, recorded as a postgres's is. */
  recordRedisCloudRun(input: {
    redisId: string;
    appName: string;
    title: string;
    description: string;
  }): Promise<Deployment> {
    const { redisId, ...rest } = input;
    return this.recordDatabaseCloudRun({ kind: 'redis', redisId }, rest);
  }

  private async recordDatabaseCloudRun(
    parent: Extract<DeploymentParent, { kind: 'postgres' | 'mysql' | 'redis' }>,
    input: { appName: string; title: string; description: string },
  ): Promise<Deployment> {
    const deploymentId = nanoid();
    const logPath = `${deploymentLogsDirectoryOn(null, input.appName)}/${deploymentId}.log`;
    await this.initLogFile(null, logPath);
    const [row] = await this.db
      .insert(deployment)
      .values({
        deploymentId,
        ...parentColumns(parent),
        title: input.title,
        description: input.description,
        status: 'pending',
        logPath,
      })
      .returning();
    return row;
  }

  /**
   * Records a bucket on AWS's Cloud run, as
   * {@link recordPostgresCloudRun} records a postgres on RDS's: a `pending`
   * row whose parent is the bucket, its log on the platform host under the
   * bucket's `appName`.
   */
  async recordBucketCloudRun(input: {
    bucketId: string;
    appName: string;
    title: string;
    description: string;
  }): Promise<Deployment> {
    const deploymentId = nanoid();
    const logPath = `${deploymentLogsDirectoryOn(null, input.appName)}/${deploymentId}.log`;
    await this.initLogFile(null, logPath);
    const [row] = await this.db
      .insert(deployment)
      .values({
        deploymentId,
        ...parentColumns({ kind: 'bucket', bucketId: input.bucketId }),
        title: input.title,
        description: input.description,
        status: 'pending',
        logPath,
      })
      .returning();
    return row;
  }

  /**
   * Records a Compose stack's Stack VM run (ADR-0070), as
   * {@link recordBucketCloudRun} records a bucket's: a `pending` row whose
   * parent is the stack, its log on the platform host under the stack's
   * `appName`, where `tofu` runs.
   */
  async recordComposeCloudRun(input: {
    composeId: string;
    appName: string;
    title: string;
    description: string;
  }): Promise<Deployment> {
    const deploymentId = nanoid();
    const logPath = `${deploymentLogsDirectoryOn(null, input.appName)}/${deploymentId}.log`;
    await this.initLogFile(null, logPath);
    const [row] = await this.db
      .insert(deployment)
      .values({
        deploymentId,
        ...parentColumns({ kind: 'compose', composeId: input.composeId }),
        title: input.title,
        description: input.description,
        status: 'pending',
        logPath,
      })
      .returning();
    return row;
  }

  /**
   * Records a cloud Service's own short Cloud run that builds nothing — a
   * Domain's add, edit, remove or certificate: a `pending` row under
   * the Service and its Deployment log on the platform host, where `tofu`
   * runs. The caller submits it to the Cloud run pool, which settles it.
   * Internal, so no PermissionCtx: the Domain write that asks was allowed.
   */
  async recordApplicationCloudRun(input: {
    applicationId: string;
    appName: string;
    title: string;
    description: string;
  }): Promise<Deployment> {
    const deploymentId = nanoid();
    const logPath = `${deploymentLogsDirectoryOn(null, input.appName)}/${deploymentId}.log`;
    await this.initLogFile(null, logPath);
    const [row] = await this.db
      .insert(deployment)
      .values({
        deploymentId,
        ...parentColumns({
          kind: 'application',
          applicationId: input.applicationId,
        }),
        title: input.title,
        description: input.description,
        status: 'pending',
        logPath,
      })
      .returning();
    return row;
  }

  /**
   * A running build's handle, from the moment the engine claims its record
   * until {@link closeCancelWindow}. {@link cancel} aborts it, which
   * kills whichever of the build's shell steps is running. In-process, like
   * the queue that ran the build: only the process that started a build holds
   * anything that can stop it.
   */
  private openCancelWindow(
    record: Omit<DeploymentRecord, 'cancelled'>,
  ): DeploymentRecord {
    const controller = new AbortController();
    this.cancellableBuilds.set(record.deploymentId, controller);
    return { ...record, cancelled: controller.signal };
  }

  /** The engine is past the build's shell steps: see the port's docblock. */
  closeCancelWindow(deploymentId: string): void {
    this.cancellableBuilds.delete(deploymentId);
  }

  /**
   * Sets a deployment's status. Internal — the engine reports build
   * outcomes here; terminal statuses stamp finishedAt.
   */
  async updateStatus(
    deploymentId: string,
    status: DeploymentStatus,
  ): Promise<void> {
    const finished =
      status === 'done' || status === 'error' || status === 'cancelled';
    const [updated] = await this.db
      .update(deployment)
      .set({
        status,
        ...(finished && { finishedAt: new Date().toISOString() }),
      })
      .where(eq(deployment.deploymentId, deploymentId))
      .returning();
    if (!updated) throw new NotFoundException('Deployment not found');
  }

  /**
   * The organization's whole deployment history, newest first.
   * `deployment` has no organizationId, so the scope comes from the join
   * every service read already writes — service → environment → project →
   * organizationId — with the service resolved through `serviceScope` because
   * the owning id is polymorphic.
   */
  async listByOrganization(
    ctx: PermissionCtx,
    query: DeploymentFeedQuery,
  ): Promise<DeploymentFeedPage> {
    await this.permissions.checkPermission(ctx, { deployment: ['read'] });
    const memberRecord = await this.permissions.findMember(ctx);
    const isPrivileged =
      memberRecord.role === 'owner' || memberRecord.role === 'admin';
    if (!isPrivileged && memberRecord.accessedServices.length === 0) {
      return { rows: [], nextCursor: null };
    }

    const service = serviceScope(this.db);

    const conditions: SQL[] = [
      inOrganization(ctx.session.activeOrganizationId),
    ];
    if (query.status) conditions.push(eq(deployment.status, query.status));
    if (query.projectId) {
      conditions.push(eq(project.projectId, query.projectId));
    }
    if (!isPrivileged) {
      // The row-level half of checkServiceAccess, which every per-owner list
      // applies one row at a time: a restricted member's feed is the history
      // of the services granted in their member row, and nothing else. Runs
      // that resolve to no service (a server or cloudgate-server schedule)
      // fall out with them — SchedulesService gates those on the same roles.
      conditions.push(
        inArray(sql`${service.serviceId}`, memberRecord.accessedServices),
      );
    }
    if (query.cursor) {
      const after = decodeCursor(query.cursor);
      conditions.push(
        sql`(${deployment.createdAt}, ${deployment.deploymentId}) < (${after.createdAt}, ${after.deploymentId})`,
      );
    }

    // One row past the page, so "is there a next page" is answered without a
    // second count query — and never guessed at.
    const found = await selectWithOwners(this.db, service)
      .where(and(...conditions))
      .orderBy(desc(deployment.createdAt), desc(deployment.deploymentId))
      .limit(query.limit + 1);

    const page = found.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      rows: page.map((row) => toFeedRow(row)),
      nextCursor: found.length > query.limit ? encodeCursor(last) : null,
    };
  }

  /** An application's deployment history, access-scoped: visible to whoever
   * can read the application. It lists, too, the Environment network's runs
   * "for" it (S14, ADR-0017 amended): on Google Cloud a Domain of the
   * Service is a rule on the network, changed by the network's own run. */
  async findAllByApplicationId(ctx: PermissionCtx, applicationId: string) {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'read');
    const app = await this.findOwnedApplication(ctx, applicationId);
    return this.db.query.deployment.findMany({
      where: or(
        eq(deployment.applicationId, app.applicationId),
        eq(deployment.forServiceId, app.applicationId),
      ),
      orderBy: desc(deployment.createdAt),
    });
  }

  /** A compose stack's deployment history, access-scoped like the
   * application variant. */
  async findAllByComposeId(ctx: PermissionCtx, composeId: string) {
    await this.permissions.checkServiceAccess(ctx, composeId, 'read');
    const target = await this.findOwnedCompose(ctx, composeId);
    return this.db.query.deployment.findMany({
      where: eq(deployment.composeId, target.composeId),
      orderBy: desc(deployment.createdAt),
    });
  }

  /**
   * A schedule's run history (Phase 37 runs are recorded as deployment rows
   * by BackupRunRecorderService), the schedule sibling of the two lists
   * above. Access-scoped through SchedulesService.findOne so the answer is
   * exactly "whoever can read the schedule can read its runs" — including
   * its owner/admin gate on server and cloudgate-server schedules, and its
   * cross-organization rows reading as absent.
   */
  async findAllByScheduleId(ctx: PermissionCtx, scheduleId: string) {
    const row = await this.schedules.findOne(ctx, scheduleId);
    return this.db.query.deployment.findMany({
      where: eq(deployment.scheduleId, row.scheduleId),
      orderBy: desc(deployment.createdAt),
    });
  }

  /** A volume backup's run history, access-scoped through
   * VolumeBackupsService.findOne like the schedule variant — the read that
   * turns a silently failing backup schedule into a visible one. */
  async findAllByVolumeBackupId(ctx: PermissionCtx, volumeBackupId: string) {
    const row = await this.volumeBackups.findOne(ctx, volumeBackupId);
    return this.db.query.deployment.findMany({
      where: eq(deployment.volumeBackupId, row.volumeBackupId),
      orderBy: desc(deployment.createdAt),
    });
  }

  /**
   * Tails the deployment's log file on the server it was written to (the build
   * server when the application has one). Visible to whoever can read the row
   * the deployment belongs to, like the history list — for every owner the
   * schema allows, not only builds.
   */
  async readLogs(
    ctx: PermissionCtx,
    deploymentId: string,
    tail: number,
    /** `maxBuffer`: the most bytes the tail may answer, on either machine;
     * past it the read rejects with an `ExecError` that
     * `isMaxBufferExceeded` recognizes. The MCP log window sets it;
     * the HTTP route leaves it to the exec defaults. */
    options: { maxBuffer?: number } = {},
  ): Promise<string> {
    const { logPath, serverId, createdAt } = await this.resolveLogSource(
      ctx,
      deploymentId,
    );
    // `quote()`d, not double-quoted (H-38): `logPath` is the stored column,
    // `{logsDirectoryOn}/{appName}/{deploymentId}.log`, and a `$(…)` in it
    // substitutes inside `"…"` just as it would bare. `tail` is a number the
    // DTO has already validated and is not a word this can quote — it is an
    // operand of `-n`, and quoting a number changes nothing about it.
    const command = `tail -n ${tail} ${quote([logPath])} 2>/dev/null || echo ""`;
    const { stdout } = await execOnServer(
      this.remoteExec,
      serverId,
      command,
      options,
    );
    // The row and the file are two lifetimes, and they can genuinely
    // disagree: `DeploymentLogRetentionService` reaps a log file past
    // `DEPLOYMENT_LOG_RETENTION_DAYS` while the Deployment row survives for
    // ever. The command above cannot tell a reaped log from an empty one — the
    // `2>/dev/null || echo ""` was always there and always meant *"this build
    // has not written anything yet"*, which is the right answer for a queued
    // deployment and the wrong one for a log this platform deleted on purpose.
    // The row's own age is what separates them, at no extra round trip, and
    // ADR-0007's rule that the read answers *for the Deployment* is why it has
    // to answer something rather than nothing. `log-retention.ts` carries why
    // this is not a 404.
    if (!stdout.trim() && isPastLogRetention(createdAt)) {
      return reapedLogNotice();
    }
    return stdout;
  }

  /**
   * Which Service a Deployment is a build of — its Application or Compose —
   * or `null` when it is a schedule or backup run, parentless, or unknown.
   *
   * **Unscoped, and so answers nothing a caller may pass on.** It exists for
   * the MCP log tool, which narrows to Service builds *before* calling
   * {@link readLogs} and answers every `null` exactly as an unknown id; the
   * gate is `readLogs`' own, which runs next. Read with {@link ownerOf}'s
   * precedence, application before compose.
   */
  async serviceOwnerOf(deploymentId: string): Promise<{
    serviceType: BuiltServiceType;
    serviceId: string;
  } | null> {
    const [row] = await this.db
      .select({
        applicationId: deployment.applicationId,
        composeId: deployment.composeId,
      })
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId))
      .limit(1);
    if (row?.applicationId) {
      return { serviceType: 'application', serviceId: row.applicationId };
    }
    if (row?.composeId) {
      return { serviceType: 'compose', serviceId: row.composeId };
    }
    return null;
  }

  /**
   * Whether the log file is gone from the machine that wrote it — the half of
   * {@link readLogs}' predicate the socket cannot get for free.
   *
   * **Here, beside `readLogs`, because the point of the ticket is that the two
   * readers ask one question.** An earlier fix gave `DeploymentLogsGateway` the same
   * *answer* the read gives and left it asking a different question: age alone,
   * with no check that the file was actually gone, so a Deployment past the
   * window whose log was still there had HTTP streaming it while the socket
   * closed saying it had been reaped. The read composes absence with age out of
   * a tail it already has; a socket about to `tail -f` holds nothing, so it
   * asks — through the same `remoteExec` and the same dispatch, on the machine
   * {@link resolveLogSource} named.
   *
   * **It takes that method's own answer rather than a `deploymentId`, and the
   * entitlement is why it can.** `resolveLogSource` is the one place that turns
   * an id into a path, behind `checkServiceAccess`; both of these values come
   * from it and from nowhere else, exactly as the caller's `readValidDirectory`
   * assertion does. Re-resolving here would be a second read of one row for two
   * columns the caller is holding, and a second place for the gate to be
   * forgotten.
   *
   * `false` when nothing could be established — `readLogFileAbsence` carries
   * why, and it is `isPastLogRetention`'s own bias: never claim a log was
   * reaped on the strength of not knowing.
   *
   * **The signature says nothing about where the path came from, and that is
   * left that way on purpose rather than typed.** The objection is real
   * and is stated so the next reviewer does not have to re-derive it: this is
   * the one method on this service that would exec against a caller-supplied
   * path if a future call site handed it one, and its entitlement gate lives in
   * {@link resolveLogSource} rather than in it. Three fixes were weighed and
   * all three cost more than they buy here.
   *
   * - **A branded `logPath`** would be the first branded type in
   *   `backend/src` — a convention decision, not a drive-by — and it would
   *   attest at the wrong checkpoint. What entitles a caller is
   *   `resolveLogSource`; what makes a path safe to name in a program is that
   *   it is inside the platform tree, which is `readValidDirectory`, and
   *   `DeploymentLogsGateway` runs that **after** `resolveLogSource` on purpose
   *   (its own comment says why). A brand minted at resolution would certify
   *   the half that is not in question.
   * - **Taking `resolveLogSource`'s result object** instead of two fields buys
   *   nothing at all: the return type is structural, so
   *   `{ serverId, logPath: whateverTheCallerHas }` satisfies it exactly as two
   *   arguments do.
   * - **Moving the gate in** means taking `(ctx, deploymentId)` and re-reading
   *   the row — the paragraph above already rejects that, and the reason
   *   survives the re-examination: the caller is holding both columns, and the
   *   ordering it has to preserve (`readValidDirectory` first, then the age
   *   test, then this) is the gateway's rather than this method's.
   *
   * **And what it exposes if it is ever misused is a boolean, not a log.**
   * `logPresenceProbeCommand` `quote()`s the path and its program answers
   * `present`/`absent` on stdout, so a caller-supplied path buys *does this
   * file exist on this machine* — not the file, and not a shell. Its neighbour
   * {@link readLogs}, which is the method that returns content, has no path
   * parameter at all: it takes a `deploymentId` and resolves the path itself,
   * which is `CONTEXT.md`'s *Deployment log* rule (*"addressed by its
   * deployment, never by a path a caller supplies"*) and is why there is no
   * matching question to answer for it.
   *
   * So the property that holds today — every argument comes from
   * `resolveLogSource` — is held by there being exactly **one** caller rather
   * than by the type. The trigger for revisiting this is therefore a *second*
   * one: at two callers the answer is the device this repo already uses for a
   * claim about a helper's call sites, an enumeration off the AST
   * (`test/coding-standards/platform-root-call-sites.spec.ts`'s shape), so that
   * a new site cannot arrive without writing down where its path came from.
   */
  async logFileIsAbsent(
    serverId: string | null,
    logPath: string,
  ): Promise<boolean> {
    return readLogFileAbsence(() =>
      execOnServerStdout(
        this.remoteExec,
        serverId,
        logPresenceProbeCommand(logPath),
      ),
    );
  }

  /**
   * One Deployment's status and times: what the Cloudgate CLI asks
   * while it follows a Deployment log, which never closes by itself, to know
   * when to stop. Visible to exactly whoever may read that log — the row is
   * read org-scoped ({@link findOwnedDeployment}) and passes the same owner's
   * gate ({@link resolveLogServer}) — so the two reads cannot disagree about
   * who may follow a Deployment. Only these columns: the row also names its
   * log's path on the build host, which no caller needs.
   */
  async findStatus(
    ctx: PermissionCtx,
    deploymentId: string,
  ): Promise<DeploymentView> {
    const row = await this.findOwnedDeployment(ctx, deploymentId);
    await this.resolveLogServer(ctx, row);
    return {
      deploymentId: row.deploymentId,
      status: row.status,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  /**
   * Which file a deployment's log is, and which machine holds it — behind the
   * entitlement gate that answering either question has to pass.
   *
   * Extracted from `readLogs` for ADR-0007: `/listen-deployment` follows the
   * same file over a socket instead of tailing it once, and used to be handed
   * the path by its caller. Addressing both reads by deployment id is what
   * makes the log file reachable only through a row that carries the ownership
   * chain, so this is the single place that turns an id into a path.
   *
   * `serverId` is null for the cloudgate host, matching `resolveLogServer`.
   *
   * The row is read org-scoped ({@link findOwnedDeployment}), so the
   * HTTP read answers another Organization's Deployment as the socket does:
   * as if the id did not exist.
   */
  async resolveLogSource(
    ctx: PermissionCtx,
    deploymentId: string,
  ): Promise<{
    logPath: string;
    serverId: string | null;
    /** When the Deployment was recorded — what both readers of this log test
     * against `DEPLOYMENT_LOG_RETENTION_DAYS`: {@link readLogs}, to tell a
     * reaped log from an empty one, and `DeploymentLogsGateway`, to close
     * rather than follow a file that is not there. Read here rather than
     * in either of them because this is the one place that turns an id into a
     * log, and a second read of the same row for one column would be a second
     * place for the entitlement gate to be forgotten. */
    createdAt: string | null;
  }> {
    const row = await this.findOwnedDeployment(ctx, deploymentId);

    const serverId = await this.resolveLogServer(ctx, row);
    return { logPath: row.logPath, serverId, createdAt: row.createdAt };
  }

  /**
   * A Deployment record by id, read only inside the caller's active
   * Organization. Another Organization's record answers exactly as an
   * id that never existed — `404 Deployment not found` — before any Service
   * grant or owning module is asked about it, so no refusal further down can
   * tell the two apart. The scope is the feed's own ({@link inOrganization}),
   * so the list and the by-id read cannot disagree about whose a record is.
   * The row also carries the feed's names, which the one read brings along;
   * callers read only the record's own columns.
   *
   * **The journal still tells the two apart.** ADR-0007 keeps the difference
   * between "no such Deployment" and "not yours" off the wire on purpose and
   * in the journal on purpose, so a socket refusal can say which it was. An
   * empty scoped read therefore asks, unscoped, whether the id exists at all,
   * and a foreign id's exception carries a {@link JournalReason} that only
   * `socket-access.ts`'s `journalDetailOf` reads. The HTTP body is built from
   * the message alone and stays byte-identical, and both misses run the same
   * second query, so neither answer is slower than the other.
   */
  private async findOwnedDeployment(
    ctx: PermissionCtx,
    deploymentId: string,
  ): Promise<Deployment> {
    const [found] = await selectWithOwners(this.db, serviceScope(this.db))
      .where(
        and(
          eq(deployment.deploymentId, deploymentId),
          inOrganization(ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (found) return found;
    const elsewhere = await this.db.query.deployment.findFirst({
      where: eq(deployment.deploymentId, deploymentId),
      columns: { deploymentId: true },
    });
    const notFound = new NotFoundException('Deployment not found');
    if (!elsewhere) throw notFound;
    throw Object.assign(notFound, {
      journalReason: 'Deployment belongs to another organization',
    } satisfies JournalReason);
  }

  /**
   * Both halves of a log read in one pass: authorize the caller against
   * whichever row owns the deployment, and answer which server holds its log
   * file (null = the cloudgate host). Exactly one owning FK is set
   * (deployment.schema.ts), so the branches are exclusive; each resolves
   * through the owning module's own read path, inheriting its environment →
   * project organization join and its permission gates.
   */
  private async resolveLogServer(
    ctx: PermissionCtx,
    row: DeploymentOwnerFks & Pick<Deployment, 'cronRun'>,
  ): Promise<string | null> {
    if (row.applicationId) {
      await this.permissions.checkServiceAccess(ctx, row.applicationId, 'read');
      const app = await this.findOwnedApplication(ctx, row.applicationId);
      // A Cron service's run logs on the Server that ran it, its run Server
      // (ADR-0034), where `BackupRunRecorderService.start` wrote it.
      if (row.cronRun) return app.serverId;
      // The **build host**, which is where the log was written — one rule,
      // asked rather than re-derived (`buildHostServerId`, ADR-0018). This was
      // a fifth written-out copy of the `||` that was collapsed everywhere
      // else, and it and {@link initializeLog} are the read and the write of
      // exactly the same question, so they must not be two expressions.
      return buildHostServerId(app);
    }
    if (row.composeId) {
      await this.permissions.checkServiceAccess(ctx, row.composeId, 'read');
      const target = await this.findOwnedCompose(ctx, row.composeId);
      return target.serverId;
    }
    if (row.scheduleId) return this.scheduleRunServer(ctx, row.scheduleId);
    if (row.volumeBackupId) {
      return this.volumeBackupRunServer(ctx, row.volumeBackupId);
    }
    if (row.backupId) return this.backupRunServer(ctx, row.backupId);
    if (row.environmentNetworkId) {
      return this.environmentNetworkRunServer(ctx, row.environmentNetworkId);
    }
    // A postgres on RDS's Cloud run logs on the platform host, where
    // `tofu` runs; read by whoever may read the postgres.
    if (row.postgresId) {
      await this.permissions.checkServiceAccess(ctx, row.postgresId, 'read');
      return null;
    }
    // A mysql on RDS's, likewise.
    if (row.mysqlId) {
      await this.permissions.checkServiceAccess(ctx, row.mysqlId, 'read');
      return null;
    }
    // A bucket on AWS's Cloud run, likewise.
    if (row.bucketId) {
      await this.permissions.checkServiceAccess(ctx, row.bucketId, 'read');
      return null;
    }
    // A redis on ElastiCache's, likewise.
    if (row.redisId) {
      await this.permissions.checkServiceAccess(ctx, row.redisId, 'read');
      return null;
    }
    throw new NotFoundException('Deployment not found');
  }

  /**
   * Where an Environment network's run wrote its log: the platform
   * host, where every Cloud run's `tofu` runs. Read by whoever may read the
   * network's Environment (spec US112: `environment: read`).
   */
  private async environmentNetworkRunServer(
    ctx: PermissionCtx,
    environmentNetworkId: string,
  ): Promise<null> {
    const [network] = await this.db
      .select({ environmentId: environmentNetwork.environmentId })
      .from(environmentNetwork)
      .where(eq(environmentNetwork.environmentNetworkId, environmentNetworkId));
    if (!network) throw new NotFoundException('Deployment not found');
    await this.permissions.checkEnvironmentAccess(
      ctx,
      network.environmentId,
      'read',
    );
    return null;
  }

  /** Where a schedule run wrote its log: the owning service's server for
   * container schedules, the schedule's own server for server schedules, and
   * the cloudgate host (null) for cloudgate-server ones — the same target
   * SchedulesService ran the schedule on. */
  private async scheduleRunServer(
    ctx: PermissionCtx,
    scheduleId: string,
  ): Promise<string | null> {
    const row = await this.schedules.findOne(ctx, scheduleId);
    if (row.scheduleType === 'application' || row.scheduleType === 'compose') {
      const parent = await findParentService(
        this.db,
        ctx.session.activeOrganizationId,
        requireServiceId(row.applicationId ?? row.composeId),
        row.scheduleType,
      );
      return parent.serverId;
    }
    return row.serverId;
  }

  /** Where a volume backup run wrote its log: the backed-up service's own
   * server, which is where VolumeBackupsService tars the volume. */
  private async volumeBackupRunServer(
    ctx: PermissionCtx,
    volumeBackupId: string,
  ): Promise<string | null> {
    const row = await this.volumeBackups.findOne(ctx, volumeBackupId);
    const parent = await findParentService(
      this.db,
      ctx.session.activeOrganizationId,
      // Every service table's FK column on a run-owning row is named after
      // its service type (the volume_backup/backup schemas' shared shape).
      requireServiceId(row[`${row.serviceType}Id`]),
      row.serviceType,
    );
    return parent.serverId;
  }

  /** Where a database backup run wrote its log: the backed-up engine's (or
   * the stack's) own server, where BackupsService runs the dump pipeline. */
  private async backupRunServer(
    ctx: PermissionCtx,
    backupId: string,
  ): Promise<string | null> {
    const row = await this.backups.findOne(ctx, backupId);
    // A backup's owning service is its stack for compose backups and the
    // engine named by databaseType otherwise ('web-server' is reserved and
    // has no service row of its own).
    const serviceType: BackupServiceType =
      row.backupType === 'compose'
        ? 'compose'
        : (row.databaseType as BackupDatabaseType);
    const parent = await findParentService(
      this.db,
      ctx.session.activeOrganizationId,
      requireServiceId(row[`${serviceType}Id`]),
      serviceType,
    );
    return parent.serverId;
  }

  private async findApplication(applicationId: string): Promise<DeployTarget> {
    const app = await this.db.query.application.findFirst({
      where: eq(application.applicationId, applicationId),
      columns: {
        applicationId: true,
        appName: true,
        serverId: true,
        buildServerId: true,
      },
    });
    if (!app) throw new NotFoundException('Application not found');
    return app;
  }

  /** Compose stacks always build on their own server — no build server. */
  private async findCompose(composeId: string): Promise<DeployTarget> {
    const row = await this.db.query.compose.findFirst({
      where: eq(compose.composeId, composeId),
      columns: { appName: true, serverId: true },
    });
    if (!row) throw new NotFoundException('Compose not found');
    // A stack on its Stack VM has no Server: its Deployment logs are kept
    // on the platform host, where its program's output streams back to
    // (`RunTarget.execToLog`), as its Cloud runs' are.
    return { ...row, buildServerId: null };
  }

  /** Org scoping (environment → project) for controller-facing compose
   * paths, the same shape as ComposeService.findOwned. */
  /** Scoped to `ctx`'s organization; `null` for an action already scoped. */
  private async findOwnedCompose(ctx: PermissionCtx | null, composeId: string) {
    const [found] = await this.db
      .select({
        composeId: compose.composeId,
        appName: compose.appName,
        serverId: compose.serverId,
        // What `refuseUntilStackVmRuns` reads.
        configName: compose.configName,
        cloudAccountId: compose.cloudAccountId,
        region: compose.region,
        stackVm: compose.stackVm,
        // What `refuseWithoutSource` reads.
        name: compose.name,
        sourceType: compose.sourceType,
        repository: compose.repository,
        gitlabRepository: compose.gitlabRepository,
        giteaRepository: compose.giteaRepository,
        bitbucketRepository: compose.bitbucketRepository,
        customGitUrl: compose.customGitUrl,
      })
      .from(compose)
      .innerJoin(
        environment,
        eq(compose.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(compose.composeId, composeId),
          ctx === null
            ? undefined
            : eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Compose not found');
    return { ...found, buildServerId: null };
  }

  /** Org scoping (environment → project) for controller-facing paths, the
   * same shape as ApplicationsService.findOwned. */
  /** Scoped to `ctx`'s organization; `null` for an action already scoped. */
  private async findOwnedApplication(
    ctx: PermissionCtx | null,
    applicationId: string,
  ): Promise<
    DeployTarget &
      SourceColumns & {
        applicationId: string;
        name: string;
        cloudDelete: typeof application.$inferSelect.cloudDelete;
      }
  > {
    const [found] = await this.db
      .select({
        applicationId: application.applicationId,
        appName: application.appName,
        // A cloud Delete under way or incomplete refuses a deploy.
        cloudDelete: application.cloudDelete,
        serverId: application.serverId,
        buildServerId: application.buildServerId,
        // What `refuseWithoutSource` reads.
        name: application.name,
        sourceType: application.sourceType,
        repository: application.repository,
        gitlabRepository: application.gitlabRepository,
        giteaRepository: application.giteaRepository,
        bitbucketRepository: application.bitbucketRepository,
        customGitUrl: application.customGitUrl,
        dockerImage: application.dockerImage,
        dropBuildPath: application.dropBuildPath,
      })
      .from(application)
      .innerJoin(
        environment,
        eq(application.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(application.applicationId, applicationId),
          ctx
            ? eq(project.organizationId, ctx.session.activeOrganizationId)
            : undefined,
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Application not found');
    return found;
  }

  /** A fresh deployment id plus its initialized log file. */
  private async initializeLog(
    app: DeployTarget,
  ): Promise<{ deploymentId: string; logPath: string }> {
    const deploymentId = nanoid();
    // Rooted on whichever host holds the log: /etc/cloudgate on a build Server,
    // this instance's CLOUDGATE_DIRECTORY when the build runs in process.
    // The machine is `buildHostServerId`'s answer rather than a sixth copy of
    // its `||` (ADR-0018); `resolveLogServer` is the read side of the same
    // question and asks it the same way.
    const logHost = buildHostServerId(app);
    const logPath = `${deploymentLogsDirectoryOn(logHost, app.appName)}/${deploymentId}.log`;
    await this.initLogFile(logHost, logPath);
    return { deploymentId, logPath };
  }

  /**
   * The log bootstrap for a new record: the directory and an "Initializing
   * deployment" line, on whichever server holds the log.
   *
   * **Both words are `quote()`d, and that is the defence.** They were bare
   * until the quoting fix was reopened at the sibling sink in `docker/docker.utils.ts`
   * (H-12): the same `mkdir -p ${…}; … >> ${…}` shape, in a string handed
   * straight to `RemoteExecService`, so a `;` in either word ends the command
   * and everything after it is a second one the build server runs as itself.
   *
   * What made this one *not* exploitable was `appName` — the only
   * caller-influenced part of `logPath` — being held to `APP_NAME_REGEX` at
   * its mint (`db/columns.ts`'s `cleanAppName`), two modules and one table
   * away. That is a charset at a distance, which is precisely the shape that
   * failed twice at `getCreateFileCommand`: the charset is only ever right for
   * the context it was written for, and nothing links it to this word. So the
   * quoting is the defence here and the regex stands behind it —
   * `builders/build-strategy.ts` states the rule for every command builder in
   * the tree, and this is one.
   *
   * `quote()` rather than the `"…"` H-12 used: that sink has
   * `assertShellSafePath` refusing `$` and a backtick in front of it, and this
   * one has nothing. Single-quoting is what kills a substitution as well as a
   * separator, and it is what the eight sibling `mkdir -p ${quote([…])}` sites
   * in `git-providers/`, `applications/drop-archive.ts` and `traefik/` already
   * do. Widening a refusal to cover this word instead was rejected for the
   * reason it was rejected at H-12: a second charset is a second thing to keep
   * correct forever.
   *
   * **The directory is `0700`, made so by `ownerOnlyDirectoryCommand`,
   * which quotes its word the same way.** A build log is whatever the build
   * printed, and it used to be `0644` under `0755` directories that the
   * console's `cloudgate` user could walk. Only root reads it back — the log
   * socket `tail`s it through this process — so closing the directory costs no
   * reader anything, and `chmod` on every deployment corrects an older one.
   */
  private async initLogFile(
    serverId: string | null,
    logPath: string,
  ): Promise<void> {
    const directory = logPath.slice(0, logPath.lastIndexOf('/'));
    const command = `${ownerOnlyDirectoryCommand(directory)}; echo "Initializing deployment" >> ${quote([logPath])};`;
    if (serverId) {
      await this.remoteExec.execAsyncRemote(serverId, command);
    } else {
      await this.remoteExec.execAsync(command);
    }
  }
}
