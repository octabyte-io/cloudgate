import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { quote } from 'shell-quote';
import {
  assertPrefixOwnersEntitled,
  refusedBucketPrefixes,
  servicesOwningPrefixes,
} from '../common/bucket-prefix-owners';
import type { BucketPrefixOwner } from '../common/bucket-prefix-owners';
import { resolveCredentialRefs } from '../common/credential-refs';
import type { CredentialRefResolvers } from '../common/credential-refs';
import { checkServerAccess } from '../common/owned-server';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import {
  reclaimDeploymentLogs,
  withUnreclaimedArtifacts,
} from '../common/teardown-steps';
import type { UnreclaimedArtifact } from '../common/teardown-steps';
import { compose } from '../compose/compose.schema';
import type { ComposeType } from '../compose/compose.schema';
import { libsql } from '../databases/libsql/libsql.schema';
import { mariadb } from '../databases/mariadb/mariadb.schema';
import { mongo } from '../databases/mongo/mongo.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { refuseExistingDatabaseBackup } from '../databases/postgres/existing-postgres';
import { postgres } from '../databases/postgres/postgres.schema';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { Destination } from '../db/schema';
import { DestinationsService } from '../destinations/destinations.service';
import type { SanitizedDestination } from '../destinations/destinations.service';
import {
  boundedRcloneFlags,
  bulkDownloadCommand,
  execRclone,
  reachabilityProbeCommand,
  rcloneFailureMessage,
} from '../destinations/rclone-exec';
import { environment } from '../environments/environment.schema';
import { NotificationDispatcherService } from '../notifications/dispatcher.service';
import { project } from '../projects/project.schema';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { backup, backupServiceFk } from './backup.schema';
import { backupRunFailureMessage } from './run-failure';
import { BackupRunRecorderService } from './run-recorder.service';
import type {
  Backup,
  BackupServiceType,
  BackupType,
  ComposeBackupMetadata,
} from './backup.schema';
import {
  BACKUP_COMMANDS,
  BACKUP_FILES_INCLUDE,
  bucketKeySegments,
  bucketPrefixCandidates,
  buildBackupScript,
  buildPruneCommand,
  buildRestoreScript,
  getBackupTimestamp,
  getComposeContainerCommand,
  getServiceContainerCommand,
  normalizeS3Path,
} from './commands';
import type {
  BackupDatabaseType,
  DatabaseCredentials,
  EngineCommand,
} from './commands';
import { refuseCloudServiceHostWork } from '../common/cloud-service-host-work';
import { refuseCloudDatabaseDump } from '../databases/common/server-only-dumps';
import { storedBackupShellSchema } from './dto/backup.dto';
import type {
  CreateBackupDto,
  ListBackupFilesDto,
  ListBackupsDto,
  RestoreBackupDto,
  UpdateBackupDto,
} from './dto/backup.dto';

/**
 * Every parent id a Backup body accepts that names a **credential-bearing**
 * row.
 *
 * **What broke first.** `destinationId` is a foreign key into `destination`,
 * whose `secret_access_key` is what every dump, prune and restore
 * authenticates to S3 with, and the constraint requires only that the row
 * *exist*. `create` and `update` each resolved it by hand — one
 * `findOneWithCredentials(ctx, …)` whose result was thrown away — and `update`
 * then wrote `.set(data)`, so the id that landed on the row was the one the
 * request carried rather than the one the lookup authorized. That is the same
 * sentence and loop restated a third time in a fourth module, which is
 * the shape `common/owned-server.ts`' docblock is about; {@link
 * resolveCredentialRefs} is where the rule lives now.
 *
 * **One name rather than the Application's seven, and it stays a list.** A
 * one-element list looks like ceremony until the second one arrives: what the
 * list buys is `CredentialRefResolvers<BackupCredentialRef>`, which refuses a
 * name added here with no lookup beside it, and
 * `test/backups/backup-credential-refs.spec.ts`, which refuses a second `*Id`
 * added to `createBackupSchema`/`updateBackupSchema` with no entry here. The loop
 * exists because `buildServerId` was resolved and the seven beside it were
 * not.
 *
 * **It lives here rather than in `common/credential-refs.ts`** — that file's
 * own docblock says the *mechanism* moves and the *column list* stays each
 * module's own, and the two lists that do sit there are there for a reason
 * this module does not have: `rollbacks/rollback.schema.ts` needs
 * `ApplicationCredentialRef` without pointing a table definition at a service.
 *
 * `serviceId` is deliberately absent: it is the backed-up Service, resolved
 * over eight tables by {@link BackupsService.findParentService}, which answers
 * about a workload rather than about a credential and has a
 * `serviceType`-discriminated contract this loop must not imitate.
 */
export const BACKUP_CREDENTIAL_REFS = ['destinationId'] as const;

/** One of {@link BACKUP_CREDENTIAL_REFS}. */
export type BackupCredentialRef = (typeof BACKUP_CREDENTIAL_REFS)[number];

/** The backup row's FK insert field for each engine (compose aside). */
const BACKUP_FK_FIELD = {
  postgres: 'postgresId',
  mysql: 'mysqlId',
  mariadb: 'mariadbId',
  mongo: 'mongoId',
  libsql: 'libsqlId',
} as const satisfies Record<
  BackupDatabaseType,
  keyof typeof backup.$inferInsert
>;

/** The engine tables the polymorphic parent lookup dispatches over, plus the
 * credential columns each engine's dump command reads (mysql dumps as root,
 * so its "password" is the root password; libsql needs none). */
const ENGINE_TABLES: Record<
  BackupDatabaseType,
  {
    table: PgTable;
    id: AnyPgColumn;
    name: AnyPgColumn;
    appName: AnyPgColumn;
    environmentId: AnyPgColumn;
    serverId: AnyPgColumn;
    /** The engines a Cloud account can run (`refuseCloudDatabaseDump`). */
    cloudAccountId?: AnyPgColumn;
    databaseUser?: AnyPgColumn;
    databasePassword?: AnyPgColumn;
  }
> = {
  postgres: {
    table: postgres,
    id: postgres.postgresId,
    name: postgres.name,
    appName: postgres.appName,
    environmentId: postgres.environmentId,
    serverId: postgres.serverId,
    cloudAccountId: postgres.cloudAccountId,
    databaseUser: postgres.databaseUser,
  },
  mysql: {
    table: mysql,
    id: mysql.mysqlId,
    name: mysql.name,
    appName: mysql.appName,
    environmentId: mysql.environmentId,
    serverId: mysql.serverId,
    cloudAccountId: mysql.cloudAccountId,
    databasePassword: mysql.databaseRootPassword,
  },
  mariadb: {
    table: mariadb,
    id: mariadb.mariadbId,
    name: mariadb.name,
    appName: mariadb.appName,
    environmentId: mariadb.environmentId,
    serverId: mariadb.serverId,
    databaseUser: mariadb.databaseUser,
    databasePassword: mariadb.databasePassword,
  },
  mongo: {
    table: mongo,
    id: mongo.mongoId,
    name: mongo.name,
    appName: mongo.appName,
    environmentId: mongo.environmentId,
    serverId: mongo.serverId,
    databaseUser: mongo.databaseUser,
    databasePassword: mongo.databasePassword,
  },
  libsql: {
    table: libsql,
    id: libsql.libsqlId,
    name: libsql.name,
    appName: libsql.appName,
    environmentId: libsql.environmentId,
    serverId: libsql.serverId,
  },
};

/**
 * A backup as a list row: the destination it writes to travels with it, so a
 * schedule list can say where its dumps go. Nothing credential-bearing does —
 * not the destination's secret access key, and not `metadata`, which holds the
 * stack engine's user and password on a compose backup.
 *
 * **This `Omit` is what the conversion took as the tree's own classification of the
 * column**, and it stays after the conversion rather than being made
 * redundant by it. `encryptedJson` defends the database; the column decrypts
 * on read, so a listing that carried `metadata` would carry three plaintext
 * passwords to every caller with `backup:read` on the Service. The `findOne`
 * route is the one echo the classification permits, argued at
 * {@link BackupsService.findOne}'s caller in
 * `test/backups/backup-metadata-at-rest.e2e-spec.ts`.
 */
export type BackupListItem = Omit<Backup, 'metadata'> & {
  destination: SanitizedDestination;
};

/** One rclone lsjson entry — what the backup-file browser renders. */
export interface RcloneFile {
  Path: string;
  Name: string;
  Size: number;
  IsDir: boolean;
  Tier?: string;
  Hashes?: { MD5?: string; SHA1?: string };
}

/** The backed-up service, org-scoped, with what a run needs to know. */
interface BackupParent {
  serviceId: string;
  /** The service's display name (notification payloads). */
  name: string;
  appName: string;
  serverId: string | null;
  /**
   * Set when the Service runs in a Cloud account — a cloud database, or a
   * Compose stack on its own Stack VM (ADR-0070) — whose `serverId` is
   * `null` all the same: {@link BackupsService.refuseCloudParent}.
   */
  cloudAccountId: string | null;
  /** The owning project's name and organization (notification payloads). */
  projectName: string;
  organizationId: string;
  /** Compose parents only — picks the container-search label set. */
  composeType: ComposeType | null;
  /** Engine parents only — credential fields for the dump command. */
  databaseUser?: string;
  databasePassword?: string;
}

/** How a run was started — the only thing `runManual` and `runScheduled`
 * differ in by the time they reach `BackupsService.run`. */
type BackupRunTrigger = 'manual' | 'scheduled';

/**
 * What the run history calls each, on the `deployment` row `BackupsService.run`
 * records.
 *
 * Both titles used to be `'Manual backup'`, so every cron-fired dump was
 * recorded as one somebody pressed. The row is not private bookkeeping:
 * `DeploymentsService.listByOrganization` is the feed every run lands in — it
 * left-joins `backup` for exactly this kind of row — and the console's
 * `deploymentColumns` renders `title` as the Deployment column's own text and
 * `DeploymentTable` uses it as the row's name. `description` is
 * `Backup of {database}` on both, and `backupId` is not on screen, so the
 * title was the only thing that could have told the two apart and it said the
 * wrong one.
 *
 * **It matters more here than the word "cosmetic" suggests**, because a
 * database backup has no run history of its own: run-history routes were added
 * for schedules and volume backups and not for these, which
 * `backup-schedules-card.tsx` records as the thing that tab still cannot
 * answer. The organization-wide feed is therefore the only place a scheduled
 * dump's outcome is legible at all — including a run
 * {@link assertStoredValuesShellSafe} refuses, which is deliberately reported
 * as an `error` row here rather than as a silent skip.
 *
 * Sentence case, keeping the spelling the manual title already had rather than
 * matching `VolumeBackupsService`' title-cased `'Volume Backup'`: an existing
 * history reads consistently only if the word that was there does not move.
 */
const BACKUP_RUN_TITLE: Record<BackupRunTrigger, string> = {
  manual: 'Manual backup',
  scheduled: 'Scheduled backup',
};

/** The owning service's id off a backup row (exactly one FK is set). */
function serviceIdOf(row: Backup): string {
  const serviceId =
    row.backupType === 'compose'
      ? row.composeId
      : row[BACKUP_FK_FIELD[row.databaseType as BackupDatabaseType]];
  if (!serviceId) throw new NotFoundException('Backup has no owning service');
  return serviceId;
}

@Injectable()
export class BackupsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackupsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
    private readonly destinations: DestinationsService,
    private readonly runRecorder: BackupRunRecorderService,
    private readonly scheduling: SchedulingService,
    private readonly dispatcher: NotificationDispatcherService,
    private readonly frozen: FrozenOrganizations,
    // The restore picker's listing with no Server runs rclone on the
    // platform host — refused in hosted mode.
    private readonly instanceMode: InstanceMode,
  ) {}

  /** Runs at server boot: re-registers the cron job of every enabled
   * backup. */
  async onApplicationBootstrap(): Promise<void> {
    await this.initializeJobs();
  }

  async initializeJobs(): Promise<void> {
    // Never fails the boot — it logs and moves on.
    try {
      const rows = await this.db
        .select()
        .from(backup)
        .where(eq(backup.enabled, true));
      for (const row of rows) {
        this.registerJob(row);
      }
    } catch (error) {
      this.logger.error('Failed to initialize backup schedules', error);
    }
  }

  /** The backup runs by row id on its cron. */
  private registerJob(row: Backup): void {
    this.scheduling.register(row.backupId, row.schedule, null, () =>
      this.runScheduled(row.backupId),
    );
  }

  /** Keeps the cron job in sync with the row after create/update/remove. */
  private syncJob(row: Backup): void {
    if (row.enabled) {
      this.registerJob(row);
    } else {
      this.scheduling.unregister(row.backupId);
    }
  }

  /**
   * backup-create permission plus a *definition-write* level on the backed-up
   * service. The destination is resolved org-scoped, so a backup can only
   * point at a bucket of the caller's own organization.
   *
   * **`'update'` on the backed-up Service, not `checkServiceAccess`'s defaulted
   * `'read'` — and the argument for all three writes lives here.**
   * {@link update} and {@link restore} cite this block rather than repeat it.
   * It is the volume-backup fix's argument one module over.
   *
   * The operate-level change looked at this module and deliberately left it alone.
   * `MountsService.create`'s docblock records why: *"A Backup, a Schedule and a
   * Domain **are** their own resource, so `backup:update` and `domain:delete`
   * set the level of those writes and `checkServiceAccess` is only answering
   * entitlement, for which `read` is right."* That holds for exactly as long as
   * the row's **effect** lands on the row's own parent, and a restore's does
   * not: it overwrites the parent's database, from an object key that comes off
   * the wire rather than out of a stored row. A create's effect is the schedule
   * that produces such objects, and a `PATCH` can re-point one at another
   * bucket in one request. So the resource's own statement was never setting
   * the level of these three; it was naming a capability whose target the
   * caller chooses afterwards.
   *
   * **What this costs, and to whom — the whole of it, checked against
   * `access-control.ts` rather than taken from the report.** Nothing, for all
   * three static roles: `ownerRole` and `adminRole` hold
   * `service: ['create', 'read', 'update', 'delete']` and `memberRole` holds
   * `service: ['read', 'update']`, and all three hold every `backup`
   * action. The loss falls on exactly one shape — a licensed custom role
   * granted `backup` actions together with `service: ['read']` and not
   * `'update'`, which could register, re-point and restore before and now
   * cannot. Nothing is migrated on its behalf, on the precedent
   * `PermissionService.checkServiceAccess` and the `service` statement in
   * `access-control.ts` both argue at length: **to restore what such a role
   * could do, add `update` to its `service` actions.**
   *
   * **Not raised: {@link runManual}, {@link findOne}, {@link listByService} and
   * {@link remove}, deliberately.** A manual run executes a **stored** row,
   * and after this the row can only have been written by somebody holding
   * `'update'` on the parent — the "operate the workload it may not
   * redefine" carve-out, the same one that keeps `deploy`, `start` and
   * `rebuild` at `'read'` beside their own `deployment: ['create']`. `remove`
   * deletes the registration and its cron job and no data, so
   * `backup: ['delete']` really is setting the level there.
   *
   * **`'delete'` was rejected** for the volume-backup fix's reason: `memberRole` holds no
   * `service: ['delete']`, so it would take restores away from every base
   * member, which is the operate level's own test for a fix that has turned into a feature
   * removal. **A new dedicated `service` action was rejected** too — the
   * destructiveness already has a name in `backup: ['restore']`, its own action
   * in its own statement; what was missing was the entitlement *level* on the
   * Service whose database the dump lands in.
   *
   * **The level was never the whole of the fix, and {@link restore} carries the
   * other half** — the shared bucket, and why a dump's own prefix decides who
   * may restore it.
   */
  async create(ctx: PermissionCtx, data: CreateBackupDto): Promise<Backup> {
    const backupType = data.backupType ?? 'database';
    const parent = await this.findParentService(
      ctx.session.activeOrganizationId,
      data.serviceId,
      backupType,
      data.databaseType,
    );
    await this.permissions.checkPermission(ctx, { backup: ['create'] });
    // `'update'` written out as a literal here, and again in `update` and
    // `restore`, rather than threaded through one private — `MountsService`'s
    // reason: the gate stays readable at the entry point.
    await this.permissions.checkServiceAccess(ctx, data.serviceId, 'update');
    // An Existing database is never Cloudgate's to dump. A redis
    // takes no dump Backup at all; its volume backup is refused there.
    if (
      backupType === 'database' &&
      (data.databaseType === 'postgres' || data.databaseType === 'mysql')
    ) {
      await refuseExistingDatabaseBackup(this.db, data.serviceId);
    }
    // A postgres or a mysql on RDS keeps RDS's own backups; dumps
    // are Server-only.
    if (backupType === 'database') {
      await refuseCloudDatabaseDump(this.db, data.databaseType, data.serviceId);
    }
    // A Compose stack on its own Stack VM, the other kind a Cloud account
    // runs that takes a Backup.
    this.refuseCloudParent(parent);
    // The dump's key is `{appName}/{prefix}/{timestamp}` and `restore` now
    // authorizes by that leading `appName`, so a `prefix` that climbs out of it
    // would put this Service's dumps — and `pruneOldBackups`' `rclone delete` —
    // under a sibling's. `bucketKeySegments` carries the finding.
    bucketKeySegments(data.prefix);
    const authorized = await resolveCredentialRefs(
      BACKUP_CREDENTIAL_REFS,
      this.credentialRefResolvers(ctx),
      data,
    );

    const { serviceId, ...rest } = data;
    const fkField =
      backupType === 'compose'
        ? 'composeId'
        : BACKUP_FK_FIELD[data.databaseType];
    const [created] = await this.db
      .insert(backup)
      // The destination that lands is the one the lookup returned, not the one
      // the request carried — and `update`'s spread carries
      // the argument for both.
      .values({ ...rest, ...authorized, backupType, [fkField]: serviceId })
      .returning();
    this.syncJob(created);
    return created;
  }

  /**
   * Dispatched over the row's backupType/databaseType: builds the
   * dump | gzip | rclone rcat pipeline against the org's destination, runs it
   * on the service's server, and records the run as a deployment that ends
   * done or error.
   */
  async runManual(ctx: PermissionCtx, backupId: string): Promise<void> {
    const row = await this.findRow(backupId);
    const parent = await this.findParentService(
      ctx.session.activeOrganizationId,
      serviceIdOf(row),
      row.backupType,
      row.databaseType as BackupDatabaseType,
    );
    await this.permissions.checkPermission(ctx, { backup: ['create'] });
    await this.permissions.checkServiceAccess(ctx, serviceIdOf(row));
    // `run` asks again; here so the refusal comes before the Destination's
    // keys are decrypted for nothing.
    this.refuseCloudParent(parent);
    const destination = await this.destinations.findOneWithCredentials(
      ctx,
      row.destinationId,
    );
    await this.run(row, parent, destination, 'manual');
  }

  /**
   * The cron callback: a cron-fired run executes with no user session, so the
   * parent and destination resolve without org scoping (both were org-checked
   * when the row was created or updated).
   *
   * **This seam is why `resolveCredentialRefs` takes no `PermissionCtx`, and
   * the sentence belongs here rather than only in `common/credential-refs.ts`.**
   * `destinationId` on a Backup reaches
   * `DestinationsService.findOne(ctx, …)` from {@link create} and
   * {@link update} and `findForScheduledRun(row.destinationId)` from here —
   * deliberately with no ctx and no organization filter, because there is no
   * session to filter against and the row was organization-checked when it was
   * written. A ctx-bearing helper cannot express that without a nullable ctx
   * threaded through every lookup, which is the shape `findParentService`
   * already regrets: its `organizationId: string | null` exists only so this
   * method can pass `null`, one line above. A bundle of closures says it once
   * at the seam that knows — {@link credentialRefResolvers} closes over its
   * `ctx`, and this run closes over nothing.
   *
   * **It is not itself a {@link resolveCredentialRefs} caller, and neither are
   * {@link runManual}, {@link listBackupFiles} or {@link restore}.** That loop
   * authorizes the ids a request is about to *write* and answers with ids, not
   * rows, precisely so nothing a resolution touches leaks into the write.
   * These four resolve the destination in order to **use** it: they write no
   * id, and what they need back is the decrypted row `execRclone`
   * authenticates with. Routing them through a loop that answers with an id
   * would mean a second `SELECT` and a second decrypt of the same row per run,
   * or a resolver that smuggled the row out through a closure. The two write
   * seams are the loop's; the asymmetry this docblock is about is between
   * their `ctx` and this method's absence of one.
   */
  async runScheduled(backupId: string): Promise<void> {
    const row = await this.findRow(backupId);
    // A Frozen Organization's backups do not run (ADR-0052): the
    // tick is skipped, recording nothing, and the next one asks again.
    if (await this.frozen.isFrozenAt({ serviceId: serviceIdOf(row) })) return;
    const parent = await this.findParentService(
      null,
      serviceIdOf(row),
      row.backupType,
      row.databaseType as BackupDatabaseType,
    );
    const destination = await this.destinations.findForScheduledRun(
      row.destinationId,
    );
    await this.run(row, parent, destination, 'scheduled');
  }

  /**
   * The run core shared by manual and scheduled backups: record the run as
   * a deployment, execute the dump pipeline, prune after success.
   *
   * **The trigger is a parameter and not a property of the row**, on
   * `VolumeBackupsService.run`'s `lockMode` precedent: it follows from
   * how the run was invoked, which is the one thing {@link runManual} and
   * {@link runScheduled} differ in. It exists because the row cannot answer the
   * question — the same `backup` row is behind both — and because until this
   * every cron-fired run was recorded under the title `'Manual backup'`.
   * {@link BACKUP_RUN_TITLE} carries where that string is read.
   */
  private async run(
    row: Backup,
    parent: BackupParent,
    destination: Destination,
    trigger: BackupRunTrigger,
  ): Promise<void> {
    // Before the run is recorded, for a manual and a scheduled run alike, so
    // a row saved before the refusal runs nothing.
    this.refuseCloudParent(parent);
    const run = await this.runRecorder.start({
      appName: row.appName,
      serverId: parent.serverId,
      title: BACKUP_RUN_TITLE[trigger],
      description: `Backup of ${row.database}`,
      initMessage: 'Initializing backup',
      parent: { kind: 'backup', backupId: row.backupId },
    });
    try {
      // The row *is* the input to a shell script, and a row older than
      // the rules now governing these fields has no write left to validate it.
      // Inside the `try`, and after the run is recorded, on purpose — see
      // `assertStoredValuesShellSafe`.
      this.assertStoredValuesShellSafe(row);

      const { command, env } = this.buildRunScript(
        row,
        parent,
        destination,
        run.logPath,
      );
      // The dump pipeline opens with `set -eo pipefail`, so it names bash on
      // both sides of the SSH boundary rather than inheriting whichever shell
      // the side happens to default to.
      //
      // `env` is the engine's database password, which is now the one
      // thing this script needs and does not contain (the same value is
      // ciphertext at rest, and a cleartext journal line beside it is the
      // docblock lie ADR 0015 warns about). It matters *here* as much as in the
      // journal: `notifyRun` below builds a notification body out of the failed
      // exec's message, and on the local branch — `serverId === null` — that
      // message is Node's own `Command failed: <the whole script>`. So the
      // password used to leave the instance in an email as well.
      await execRclone(this.remoteExec, command, {
        destination,
        serverId: parent.serverId,
        platformHost: this.instanceMode,
        shell: '/bin/bash',
        env,
      });
      await this.runRecorder.finish(run.deploymentId, 'done');
      await this.notifyRun(row, parent, 'success');
    } catch (error) {
      // Already masked: an rclone failure comes back through execRclone, which
      // takes the credentials out of it before anything reads its message. So
      // both the notification a person reads and the rethrow the exception
      // filter writes to the journal are safe to build from it as-is.
      await this.runRecorder.finish(run.deploymentId, 'error');
      await this.notifyRun(
        row,
        parent,
        'error',
        (error as { message?: string })?.message || 'Unknown error',
      );
      // A pressed Run now is answered with what broke. The run above is
      // already recorded, so a bare 500 — which the console reads as "nothing
      // changed" — was the one answer that was certainly wrong. A 400 because
      // that is the status the console renders the backend's own words for, and
      // the one a failed volume restore already answers with; a refusal that is
      // already an HTTP answer (the stored-row guard's 400) keeps its own.
      //
      // Only the manual trigger: a cron-fired run has nobody to answer, and
      // `SchedulingService` journals the raw exec failure, which is the more
      // useful thing for the journal to hold.
      if (trigger === 'manual' && !(error instanceof HttpException)) {
        throw new BadRequestException(
          backupRunFailureMessage(error, {
            database: row.database,
            destination: destination.name,
          }),
        );
      }
      throw error;
    }
    await this.pruneOldBackups(row, parent, destination);
  }

  /**
   * The stored row's shell-bound fields, or a 400 naming the ones that are
   * wrong.
   *
   * **Why here and not only at the DTO.** {@link buildRunScript} interpolates
   * `prefix`, `serviceName`, `database` and `metadata`'s credentials into the
   * dump pipeline, and {@link pruneOldBackups} takes `prefix` into an
   * `rclone delete` path. Those words are `quote()`d now (H-36, H-37) and the
   * DTOs refuse what they refuse — but a backup is a **cron job**:
   * {@link runScheduled} reads the row and builds the script with no request
   * anywhere in the call, so a row written before a rule existed can never
   * reach a DTO again. There is no write to validate. `prefix` took the
   * segment rule and `serviceName` took Compose's charset on `create` and
   * `update` alone, so without this the schedule goes on executing the stored
   * value every night and the operator's only way to stop it is to edit or
   * delete a row nothing told them about — the stored-value shape with the request taken
   * out of it. `volume-backups/` has had this since H-21, on the newer rows;
   * `storedBackupShellSchema` carries what it can and cannot refuse.
   *
   * **A refusal, not a silent skip, and not a sanitize.** All three were
   * weighed one module over and the answer transfers unchanged: skipping the
   * run quietly leaves the poisoned row in place, stops the backups, and the
   * first anyone hears of it is a restore that finds nothing. Rewriting the
   * value would point the run at a different S3 prefix or a different database,
   * which for a *backup* means writing the wrong object and believing it. A
   * refusal is the only one of the three where the row's owner finds out.
   *
   * **And it is thrown from inside {@link run}'s `try`, after the run is
   * recorded**, which is the whole of the answer to "what does this do to a
   * scheduled run". It ends as a `deployment` row with status `error` and a
   * notification through the configured channels — and `notifyRun` passes the
   * caught message as the notification's `errorMessage`, so what the operator
   * reads names the field rather than only saying the backup failed. That is
   * the difference between a silent stop and a fixable one.
   * `SchedulingService`'s `logger.error` catches the rethrow on top of that.
   * Guarding before `runRecorder.start` was the alternative and is rejected for
   * that reason: it is cheaper, and it makes the scheduled case invisible in
   * the one place built for looking at it.
   *
   * The fields are named and the values are never echoed: an operator needs to
   * know *which* box on *which* backup is poisoned, and repeating a stored
   * injection payload into an error body — which is journalled, notified and
   * rendered in the console — puts it somewhere new for no gain (§2.5).
   */
  private assertStoredValuesShellSafe(row: Backup): void {
    const checked = storedBackupShellSchema.safeParse(row);
    if (checked.success) return;

    const fields = checked.error.issues
      .map((issue) => `${issue.path.join('.')} (${issue.message})`)
      .join('; ');
    throw new BadRequestException(
      `Backup ${row.backupId} has a stored value that cannot be given to a shell — ${fields}. Correct or delete that backup; until then every run of it is refused`,
    );
  }

  /** The notification sent after every run. */
  private async notifyRun(
    row: Backup,
    parent: BackupParent,
    status: 'success' | 'error',
    errorMessage?: string,
  ): Promise<void> {
    await this.dispatcher.dispatch(parent.organizationId, {
      type: 'database-backup',
      projectName: parent.projectName,
      applicationName: parent.name,
      databaseType: row.databaseType,
      status,
      databaseName: row.database,
      errorMessage,
    });
  }

  /**
   * Runs after every successful backup: lists the destination's dump files,
   * keeps the newest keepLatestCount, deletes the rest. Prune failures never
   * fail the backup that just succeeded.
   */
  private async pruneOldBackups(
    row: Backup,
    parent: BackupParent,
    destination: Destination,
  ): Promise<void> {
    if (!row.keepLatestCount) return;
    try {
      const command = buildPruneCommand({
        backupFilesPath: `:s3:${destination.bucket}/${this.s3AppName(row, parent)}/${normalizeS3Path(row.prefix)}`,
        include: BACKUP_FILES_INCLUDE,
        keepLatestCount: row.keepLatestCount,
      });
      await execRclone(this.remoteExec, command, {
        destination,
        serverId: parent.serverId,
        platformHost: this.instanceMode,
      });
    } catch (error) {
      // Swallowed rather than failing the backup that just succeeded — but
      // still written out, and execRclone has already masked it.
      this.logger.error('Backup prune failed', error);
    }
  }

  /** One backup, access-scoped through the backed-up service. */
  async findOne(ctx: PermissionCtx, backupId: string): Promise<Backup> {
    const row = await this.findRow(backupId);
    await this.findParentService(
      ctx.session.activeOrganizationId,
      serviceIdOf(row),
      row.backupType,
      row.databaseType as BackupDatabaseType,
    );
    await this.permissions.checkPermission(ctx, { backup: ['read'] });
    await this.permissions.checkServiceAccess(ctx, serviceIdOf(row));
    return row;
  }

  /**
   * The schedules of one backed-up service. The shape is mounts' listByService
   * — `?serviceId=&serviceType=`, scoped through the same organization join the
   * write path resolves the service by, so another organization's service reads
   * as absent rather than forbidden.
   */
  async listByService(
    ctx: PermissionCtx,
    query: ListBackupsDto,
  ): Promise<BackupListItem[]> {
    await this.findParentForServiceType(
      ctx.session.activeOrganizationId,
      query.serviceId,
      query.serviceType,
    );
    await this.permissions.checkPermission(ctx, { backup: ['read'] });
    await this.permissions.checkServiceAccess(ctx, query.serviceId);

    // The applications.findOne precedent: select the relation, project the
    // credentials out of it. `metadata` goes too — a compose backup keeps the
    // stack engine's user and password there, and a listing never needs them.
    return this.db.query.backup.findMany({
      where: eq(backupServiceFk[query.serviceType], query.serviceId),
      columns: { metadata: false },
      with: { destination: { columns: { secretAccessKey: false } } },
      orderBy: desc(backup.createdAt),
    });
  }

  /**
   * The backup stays pointed at its service; a new destination is resolved
   * org-scoped like on create.
   *
   * **`'update'` on the backed-up Service, argued in {@link create}.**
   * The patch can rewrite `destinationId`, `database`, `prefix` and
   * `metadata`, so this route has create's whole reach in one `PATCH`: the
   * Service's dumps can be re-pointed at another bucket, and a compose row's
   * `metadata` credentials are what its dump command runs as.
   */
  async update(
    ctx: PermissionCtx,
    backupId: string,
    data: UpdateBackupDto,
  ): Promise<Backup> {
    const current = await this.findRow(backupId);
    const parent = await this.findParentService(
      ctx.session.activeOrganizationId,
      serviceIdOf(current),
      current.backupType,
      current.databaseType as BackupDatabaseType,
    );
    await this.permissions.checkPermission(ctx, { backup: ['update'] });
    await this.permissions.checkServiceAccess(
      ctx,
      serviceIdOf(current),
      'update',
    );
    this.refuseCloudParent(parent);
    // Create's guard, for the same reason: a `PATCH` is the other way a row's
    // `prefix` comes to name somebody else's.
    if (data.prefix !== undefined) bucketKeySegments(data.prefix);
    const authorized = await resolveCredentialRefs(
      BACKUP_CREDENTIAL_REFS,
      this.credentialRefResolvers(ctx),
      data,
    );

    const [updated] = await this.db
      .update(backup)
      // The id that lands is the one the lookup returned, not the one the
      // request carried ("the row is written from the id that
      // was authorized"). Equal by construction today — the lookup filters on
      // the very id it was given — so this is behind the refusal above rather
      // than a second rule. It is here because it is what stops `.set(data)`
      // being the thing that decides.
      .set({ ...data, ...authorized })
      .where(eq(backup.backupId, current.backupId))
      .returning();
    this.syncJob(updated);
    return updated;
  }

  /**
   * The org-scoped lookup for each id in {@link BACKUP_CREDENTIAL_REFS}, each
   * answering with the id it authorized — the only half of the rule that is
   * this module's own (the loop is `common/credential-refs.ts`' {@link
   * resolveCredentialRefs}).
   *
   * The loop carries the argument for why it is sequential, why it takes no
   * `PermissionCtx` of its own, and why a refusal raised here is passed
   * through untouched. What is left here is *which service owns the row*,
   * which is the one thing `common/` cannot know.
   *
   * **`findOne` rather than `findOneWithCredentials`, and the difference is
   * smaller than it looks — say so rather than claim the rule outright.**
   * `DestinationsService.findOne` *is* `findOneWithCredentials` with
   * `stripSecret` over it, and `secretAccessKey` is an `encryptedText` column,
   * so the decrypt happens in the `SELECT` either way: this does not skip one.
   * What it buys is that the plaintext never reaches a local in this module —
   * the most of *"resolving an id has no business decrypting a secret"*
   * (reached here through a Destination) that is available without a
   * projected read in `DestinationsService`, which would trade this for a
   * hand-written column list that drifts, and that is the projection defect one table
   * over. The refusal is unchanged in either spelling: both filter
   * `destination_id` and `organization_id` together and raise the same
   * `NotFoundException` whichever predicate misses, so a foreign id stays
   * indistinguishable from one that exists nowhere (§2.2 / ADR-0008).
   *
   * `ctx` is closed over rather than threaded through the loop, and this
   * module is why the shared signature looks that way: see
   * {@link runScheduled}.
   */
  private credentialRefResolvers(
    ctx: PermissionCtx,
  ): CredentialRefResolvers<BackupCredentialRef> {
    // `CredentialRefResolvers<BackupCredentialRef>` on purpose: this is the
    // type that makes the list load-bearing, because a name added there with
    // no lookup here fails to compile.
    return {
      destinationId: async (id) =>
        (await this.destinations.findOne(ctx, id)).destinationId,
    };
  }

  /**
   * Deletes the backup row and its cron job, and the run logs on the machine
   * the runs wrote them to — `parent.serverId`, which is what
   * {@link run} hands `BackupRunRecorderService.start`. The run Deployments cascade
   * with the row, so no screen could open those logs afterwards; one the
   * machine would not give up is named in `unreclaimedArtifacts`.
   */
  async remove(
    ctx: PermissionCtx,
    backupId: string,
  ): Promise<Backup & { unreclaimedArtifacts?: UnreclaimedArtifact[] }> {
    const current = await this.findRow(backupId);
    const parent = await this.findParentService(
      ctx.session.activeOrganizationId,
      serviceIdOf(current),
      current.backupType,
      current.databaseType as BackupDatabaseType,
    );
    await this.permissions.checkPermission(ctx, { backup: ['delete'] });
    await this.permissions.checkServiceAccess(ctx, serviceIdOf(current));

    const unreclaimedArtifacts = await reclaimDeploymentLogs(this.remoteExec, [
      { appName: current.appName, serverId: parent.serverId },
    ]);
    const [removed] = await this.db
      .delete(backup)
      .where(eq(backup.backupId, current.backupId))
      .returning();
    this.scheduling.unregister(current.backupId);
    return withUnreclaimedArtifacts(removed, unreclaimedArtifacts);
  }

  /**
   * Browses a destination's dump files via rclone lsjson so the restore UI can
   * pick one. The search's directory part narrows the listing server-side; the
   * rest filters the result.
   *
   * **Bounded to the prefixes the caller is entitled to.** A
   * Destination's bucket is organization-wide, so this route used to hand every
   * Service's dump filenames to anybody holding `backup: ['read']` — the
   * listing half of the reach {@link restore} carries the argument for.
   * {@link visibleBackupFiles} decides it, and states why it is a filter rather
   * than a refusal.
   */
  async listBackupFiles(
    ctx: PermissionCtx,
    query: ListBackupFilesDto,
  ): Promise<RcloneFile[]> {
    await this.permissions.checkPermission(ctx, { backup: ['read'] });
    if (!query.serverId) this.instanceMode.refusePlatformHost('checks');
    const destination = await this.destinations.findOneWithCredentials(
      ctx,
      query.destinationId,
    );
    await checkServerAccess(this.db, ctx, query.serverId);

    const bucketPath = `:s3:${destination.bucket}`;
    const search = query.search ?? '';
    // The listing is bounded by the leading segment of each path it answers
    // with, so a search that can climb out of one would defeat the bound
    // exactly as it would on `restore` — `bucketKeySegments` carries it.
    bucketKeySegments(search);
    const lastSlashIndex = search.lastIndexOf('/');
    const baseDir =
      lastSlashIndex !== -1
        ? normalizeS3Path(search.slice(0, lastSlashIndex + 1))
        : '';
    const searchTerm =
      lastSlashIndex !== -1 ? search.slice(lastSlashIndex + 1) : search;

    const searchPath = baseDir ? `${bucketPath}/${baseDir}` : bucketPath;
    // No `2>/dev/null`: it discarded the one thing a failed listing
    // has to say, and it was never what kept the answer parseable — stdout and
    // stderr arrive as separate streams either side of the SSH boundary, so the
    // JSON below is unaffected by leaving stderr be.
    // Bounded with the same flags the destination listing already carried
    // unbounded, rclone's own defaults — 3 retries × 10 low-level
    // retries, backing off — held this request open for 95 s against a stopped
    // MinIO while the bounded listing next door answered in 0.0 s. `30s` is the
    // *idle* timeout, so a large bucket that is merely slow still finishes.
    // `quote()`d, not double-quoted (H-38). `searchPath` is built from
    // `query.search`, which is `z.string().default('')` on
    // `listBackupFilesSchema` — a browse box on the restore picker, straight
    // off the wire — and this command goes to `RemoteExecService`. Double
    // quotes stop a space and not a `$(…)`, which is the distinction H-12,
    // H-19 and H-32 each turned on.
    const command = `rclone lsjson ${boundedRcloneFlags({ idle: '30s' })} ${quote([searchPath])} --no-mimetype --no-modtime`;

    // A destination that is unreachable, misconfigured or empty of the prefix
    // asked for is the caller's problem to fix, so it is answered rather than
    // left to the exception filter's 500.
    let stdout: string;
    try {
      ({ stdout } = await execRclone(this.remoteExec, command, {
        destination,
        serverId: query.serverId ?? null,
        platformHost: this.instanceMode,
      }));
    } catch (error) {
      throw new BadRequestException(
        rcloneFailureMessage(error, 'Failed to list the backup files'),
      );
    }

    let files: RcloneFile[];
    try {
      files = JSON.parse(stdout) as RcloneFile[];
    } catch {
      throw new BadRequestException('Failed to parse backup files list');
    }

    const results = baseDir
      ? files.map((file) => ({ ...file, Path: `${baseDir}${file.Path}` }))
      : files;
    // Before the search term, not after: the entitlement filter is about which
    // paths exist for this caller at all, and running it second would let the
    // hundred-row cap be filled by rows that are then dropped.
    const visible = await this.visibleBackupFiles(ctx, results);
    if (searchTerm) {
      return visible
        .filter((file) =>
          file.Path.toLowerCase().includes(searchTerm.toLowerCase()),
        )
        .slice(0, 100);
    }
    return visible.slice(0, 100);
  }

  /** The full row by id, before any access decision needs its parent. */
  private async findRow(backupId: string): Promise<Backup> {
    const [row] = await this.db
      .select()
      .from(backup)
      .where(eq(backup.backupId, backupId))
      .limit(1);
    if (!row) throw new NotFoundException('Backup not found');
    return row;
  }

  /**
   * The service the backup targets, org-scoped through environment → project
   * like every service lookup, dispatched over the owning table. A null
   * organizationId skips the org filter (scheduled runs have no session).
   */
  private findParentService(
    organizationId: string | null,
    serviceId: string,
    backupType: Backup['backupType'],
    databaseType: BackupDatabaseType,
  ): Promise<BackupParent> {
    return backupType === 'compose'
      ? this.findComposeParent(organizationId, serviceId)
      : this.findEngineParent(organizationId, serviceId, databaseType);
  }

  /**
   * The backed-up service behind a list query. A serviceType *is* the
   * backupType/databaseType pair, so it resolves through the same
   * organization-scoped join the write path uses.
   */
  private findParentForServiceType(
    organizationId: string,
    serviceId: string,
    serviceType: BackupServiceType,
  ): Promise<BackupParent> {
    return serviceType === 'compose'
      ? this.findComposeParent(organizationId, serviceId)
      : this.findEngineParent(organizationId, serviceId, serviceType);
  }

  /** findParentService's compose branch — the stack the backup runs inside. */
  private async findComposeParent(
    organizationId: string | null,
    serviceId: string,
  ): Promise<BackupParent> {
    const [found] = await this.db
      .select({
        serviceId: compose.composeId,
        name: compose.name,
        appName: compose.appName,
        serverId: compose.serverId,
        cloudAccountId: compose.cloudAccountId,
        projectName: project.name,
        organizationId: project.organizationId,
        composeType: compose.composeType,
      })
      .from(compose)
      .innerJoin(
        environment,
        eq(compose.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(compose.composeId, serviceId),
          ...(organizationId
            ? [eq(project.organizationId, organizationId)]
            : []),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Service not found');
    return found;
  }

  /** findParentService's database branch — the engine row, with the columns
   * its dump command needs. */
  private async findEngineParent(
    organizationId: string | null,
    serviceId: string,
    databaseType: BackupDatabaseType,
  ): Promise<BackupParent> {
    const columns = ENGINE_TABLES[databaseType];
    const fields: Record<string, AnyPgColumn> = {
      serviceId: columns.id,
      name: columns.name,
      appName: columns.appName,
      serverId: columns.serverId,
      projectName: project.name,
      organizationId: project.organizationId,
    };
    if (columns.cloudAccountId) fields.cloudAccountId = columns.cloudAccountId;
    if (columns.databaseUser) fields.databaseUser = columns.databaseUser;
    if (columns.databasePassword) {
      fields.databasePassword = columns.databasePassword;
    }
    const [found] = await this.db
      .select(fields)
      .from(columns.table)
      .innerJoin(
        environment,
        eq(columns.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(columns.id, serviceId),
          ...(organizationId
            ? [eq(project.organizationId, organizationId)]
            : []),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Service not found');
    return {
      composeType: null,
      cloudAccountId: null,
      ...found,
    } as unknown as BackupParent;
  }

  /**
   * The Services claiming any of these names as their `appName`.
   *
   * **Eight tables, where there were six, and the widening is the whole
   * of the change here.** This was first built over `ENGINE_TABLES` plus `compose`,
   * on the grounds that what sits under these prefixes is a *database dump* and
   * only those six can own one — and recorded the cost: an `application`'s or a
   * `redis`' prefix read as unowned, so a **volume-backup tarball** parked under
   * one was restorable by anyone the level let through. That is the same gap, from
   * the other side: `volume-backups` needs the same question answered for all
   * eight service types, and the two kinds of object share one bucket, so a rule
   * that disagreed with itself between them would be the same reach with an
   * extra step. `servicesOwningPrefixes` in `common/bucket-prefix-owners.ts` is now the
   * one resolver, over `serviceScope`'s eight tables (§1.4).
   *
   * A method rather than a bare call so {@link checkBackupFileAccess}'s decision
   * can be driven at the unit seam without standing up the eight-table union —
   * the same reason {@link findParentService} is one.
   */
  private servicesOwningPrefixes(
    names: string[],
  ): Promise<BucketPrefixOwner[]> {
    return servicesOwningPrefixes(this.db, names);
  }

  /**
   * Who may restore this object key — the second half of the restore fix, and the half the
   * raised level does not close.
   *
   * **The fact this rests on.** Every dump this product writes lands at
   * `{bucket}/{appName}/{prefix}/{timestamp}.{ext}`: `buildRunScript` builds
   * that path and `s3AppName` picks its leading segment, which is the backed-up
   * Service's own `appName` — or `{appName}_{serviceName}` for one stack
   * service of a compose backup. So a dump's key *names the Service that wrote
   * it*, and this asks that Service's own entitlement question. A caller
   * entitled to Service A can no longer name Service B's dump and load B's data
   * into A.
   *
   * **The rule itself moved out and is not restated here** (§1.4):
   * `assertPrefixOwnersEntitled` in `common/bucket-prefix-owners.ts` carries why every
   * resolved owner must be entitled rather than one of them, why a prefix no
   * Service claims stays available, why another organization's prefix is refused
   * rather than filtered, and why the level on the *source* is `'read'` while
   * {@link restore} claims `'update'` on the target. `volume-backups` asks the
   * same question of the same bucket, so the two share the rule as well as the
   * resolver.
   */
  private async checkBackupFileAccess(
    ctx: PermissionCtx,
    backupFile: string,
  ): Promise<void> {
    const [prefix] = bucketKeySegments(backupFile);
    if (!prefix) {
      throw new BadRequestException('A backup file path is required');
    }
    const owners = await this.servicesOwningPrefixes(
      bucketPrefixCandidates(prefix),
    );
    await assertPrefixOwnersEntitled(this.permissions, ctx, owners);
  }

  /**
   * {@link checkBackupFileAccess}' rule applied to a listing: the dumps of a
   * Service the caller is not entitled to are not theirs to see either.
   *
   * **The rule itself moved out and is not restated here** (§1.4):
   * `refusedBucketPrefixes` in `common/bucket-prefix-owners.ts` carries why this
   * is a filter and not a refusal, why it is decided from the member row's
   * `accessedServices` rather than with a `checkServiceAccess` per prefix, why a
   * prefix no Service claims stays listed, and why another Organization's is
   * dropped for everybody. `GET /destinations/:id/objects` — the *volume*
   * restore's picker, over the same Organization-wide bucket — was the third
   * caller that needed it and the reach it was moved for; a listing rule that
   * disagreed with itself between two pickers onto one bucket would be the same
   * disclosure with an extra step.
   *
   * What stays here is the row shape: which part of an `RcloneFile` is the
   * bucket's top-level prefix.
   */
  private async visibleBackupFiles(
    ctx: PermissionCtx,
    files: RcloneFile[],
  ): Promise<RcloneFile[]> {
    const prefixOf = (file: RcloneFile): string => file.Path.split('/')[0];
    const prefixes = [...new Set(files.map(prefixOf))].filter(
      (prefix) => prefix.length > 0,
    );
    const refused = await refusedBucketPrefixes(
      this.db,
      this.permissions,
      ctx,
      prefixes.map((prefix) => ({
        prefix,
        candidates: bucketPrefixCandidates(prefix),
      })),
    );
    return refused.size === 0
      ? files
      : files.filter((file) => !refused.has(prefixOf(file)));
  }

  /**
   * Dispatched over backupType/databaseType like the manual run: downloads the
   * dump from the destination and feeds it into the engine's import command.
   * Any dump in the destination can be restored, so the target service and
   * database name come from the request rather than a backup row — as long as
   * the caller is entitled to the Service whose dumps the key sits under.
   *
   * **`'update'` on the target Service, argued in {@link create}, and
   * this is the route that made the argument.** The effect of this call is that
   * the target's database is overwritten — `buildRestoreScript` pipes the
   * downloaded dump into `pg_restore --clean --if-exists`, `mysql`,
   * `mongorestore` or `sqlite3` — from a key that comes off the wire.
   * `service: ['read']` on one Service used to authorize it, and overwriting a
   * database is plainly not a read.
   *
   * **The second half of the restore fix, and the one the level alone does not close: a
   * Destination's bucket is organization-wide.** Every Service's dumps live in
   * one bucket, so a caller holding `backup: ['restore']` and entitlement to
   * Service A could name **Service B's** dump as `backupFile` and load it into
   * A's engine, then read another Service's data through a Service they *are*
   * entitled to. That is a sideways reach across the entitlement column which
   * turns a restore into a **read**, mediated by the shared Destination rather
   * than by the Server — which is why raising the level was worth doing on its
   * own and was never going to be enough.
   *
   * {@link checkBackupFileAccess} closes it and carries the mechanism. The
   * short form: a dump's key begins with the `appName` of the Service that
   * wrote it, so the key names its own owner, and the caller must be entitled
   * to that owner.
   *
   * **Why a *positive* prefix rule, where the volume-backup fix rejected a negative one.** It
   * asked the same question of `volumeName` and refused to bind it, because the
   * binding available there was negative — refuse a name some *other* Service's
   * mount row claims — and its false refusals landed on the case hardest to
   * explain, with a refusal that could not say why without becoming an oracle
   * for another Service's mounts (§2.2, ADR-0008). This module has a stronger
   * fact to stand on: the platform itself *writes* the key, at
   * `{appName}/{prefix}/{timestamp}` (`buildRunScript`), and the console
   * already treats that as the convention — `BackupFilesCard` defaults its
   * browse box to the Service's own `appName/`. So the rule here is about where
   * a Service's own dumps live rather than about where anybody else's do.
   *
   * **`backupFile` keeps its `z.string().min(1)`, deliberately.** The schema
   * was never the thing that was wrong — the comment below already conceded the
   * caller sends "anything else they care to send", and a shape check is not an
   * authorization check. What changed is that the key is now *authorized*, in
   * the service, against rows.
   */
  async restore(ctx: PermissionCtx, data: RestoreBackupDto): Promise<void> {
    const backupType = data.backupType ?? 'database';
    const parent = await this.findParentService(
      ctx.session.activeOrganizationId,
      data.databaseId,
      backupType,
      data.databaseType,
    );
    await this.permissions.checkPermission(ctx, { backup: ['restore'] });
    await this.permissions.checkServiceAccess(ctx, data.databaseId, 'update');
    // Before the Destination is read: the restore prelude's rclone probe
    // runs even with no container to restore into, and its error comes back
    // in this call's 400, so on the platform host it was a request from the
    // box to the caller's endpoint with the caller's keys.
    if (backupType === 'database') {
      await refuseCloudDatabaseDump(
        this.db,
        data.databaseType,
        data.databaseId,
      );
    }
    this.refuseCloudParent(parent);
    await this.checkBackupFileAccess(ctx, data.backupFile);
    const destination = await this.destinations.findOneWithCredentials(
      ctx,
      data.destinationId,
    );

    const builder = BACKUP_COMMANDS[data.databaseType];
    const backupPath = `:s3:${destination.bucket}/${data.backupFile}`;
    // mongorestore wants a seekable archive (rclone copy + temp dir); the
    // libsql tarball gunzips inside tar; everything else pipes over gunzip.
    //
    // Bounded, on the third unbounded call site the rclone bounds did not name: a database
    // restore is one synchronous HTTP request, exactly like the volume restore
    // that answered after 5 min 55 s against a stopped MinIO. Two different idle
    // timeouts here, and what separates them is who consumes the bytes:
    //
    // - mongo's `rclone copy` writes into a local temp dir before the import
    //   reads it, so it is the same shape as the volume restore's download and
    //   takes the same profile — a longer idle bound and a connect timeout that
    //   tolerates a cross-region endpoint.
    // - the two piped shapes are drained by the engine's own import, which
    //   legitimately stalls — a COPY or an index build on a small box goes quiet
    //   for minutes — and `--timeout` is an *idle* timeout, so tightening it
    //   would abort healthy long restores part-way through a database. `5m` is
    //   rclone's own default, kept on purpose: the only dimensions bounded on
    //   this path are the two actually measured, `--contimeout` (1m → 5s)
    //   and the top-level retry (3 → 1).
    //
    // **Mongo's `copy` is `bulkDownloadCommand` and the two piped shapes are
    // not, and that asymmetry is measured rather than reasoned**
    // (reopened). It is the same operation as the volume restore's download — a
    // large object landing on a local disk while somebody waits — so it takes
    // the same profile from the same place, wall clock included, and
    // `boundedRcloneFlags` carries why each value is what it is.
    //
    // That wall clock is a `timeout` around the process rather than
    // `--max-duration`, which is accepted and inert on the rclone this product
    // installs (H-120) — `bulkDownloadCommand` carries the measurement. This
    // call site was not itself driven: it is the same shared constant and the
    // same single-object shape as the volume restore, which was.
    //
    // What the piped shapes cannot use is the half of that profile that matters:
    // `--low-level-retries` resumes at the offset already read, which is what
    // lets a degraded link assemble a download to a file, and on `rclone cat` it
    // is **inert** — the same object through the same stalling proxy stopped at
    // 60 s with 39 997 344 bytes and rc=5 at *both* 1 and 10, because a stream
    // already written to stdout cannot be rewound. Left at 1 rather than raised
    // for symmetry: it would buy nothing and is not free, since the same counter
    // governs a connect that never completes — against a socket that swallows
    // packets the same `cat` answered in 80 s at 1 and 626 s at 10. The
    // top-level `--retries` is spent on every path alike, and on these two it is
    // the one that would feed the import the head of the dump a second time.
    //
    // Worth knowing and not fixed here: that also means the piped restores have
    // no defence against an endpoint that stalls mid-stream, by rclone's
    // construction rather than by this choice. What is bounded is how long they
    // wait to find out.
    //
    // The wall clock is not applied to them either, and that is a decision rather
    // than an omission: their wall clock is the *engine's* import, which
    // legitimately runs for as long as the database takes, so a cap there would
    // kill a healthy restore mid-database for a property `rclone cat` does not
    // own.
    // The object path is `quote()`d in all three shapes (H-38). It is
    // `:s3:{bucket}/{data.backupFile}`, and `backupFile` is
    // `z.string().min(1)` on `restoreBackupSchema` — the key the operator
    // picked out of the browse listing, or anything else they care to send.
    const objectPath = quote([backupPath]);
    const rcloneCommand =
      data.databaseType === 'mongo'
        ? bulkDownloadCommand({ verb: 'copy', args: objectPath })
        : data.databaseType === 'libsql'
          ? `rclone cat ${boundedRcloneFlags({ idle: '5m', contimeout: '10s' })} ${objectPath}`
          : `rclone cat ${boundedRcloneFlags({ idle: '5m', contimeout: '10s' })} ${objectPath} | gunzip`;

    const containerSearch =
      backupType === 'compose'
        ? getComposeContainerCommand(
            parent.appName,
            data.metadata?.serviceName ?? '',
            parent.composeType,
          )
        : getServiceContainerCommand(parent.appName);

    // A restore is as sensitive as a dump, and the credential fix named both directions of
    // all three engines for that reason: `mysql -p…`, `mariadb -p…` and
    // `mongorestore --password …` carried the credential exactly as their dump
    // siblings did, and the restore path journals it through the same
    // `ExecError` — and then hands it to `rcloneFailureMessage`, which is what
    // the caller's own 400 says.
    const restore = builder.restore(
      this.credentialsFor(
        {
          backupType,
          database: data.databaseName,
          metadata: data.metadata ?? null,
        },
        parent,
      ),
    );
    const script = buildRestoreScript({
      containerSearch,
      restoreCommand: restore.command,
      rcloneCommand,
      // The same probe the volume restore runs first, for the same reason
      // the flags above are chosen so a *degraded* link still assembles,
      // and the counter that buys that also governs a connect that never
      // completes — so an endpoint that is simply absent is asked about once, by
      // a listing that refuses in tens of seconds, rather than paid for by the
      // download's budget. It answers reachability only: a key that is not there
      // exits 0, and stays the engine's refusal to report.
      reachabilityProbe: reachabilityProbeCommand(backupPath),
      databaseType: data.databaseType,
      backupFile: data.backupFile,
    });

    // The engine's own refusal — "database does not exist", "no such object",
    // rclone's 403 — is what the person driving the restore needs, and it is
    // theirs to act on rather than this instance's fault.
    try {
      await execRclone(this.remoteExec, script, {
        destination,
        serverId: parent.serverId,
        platformHost: this.instanceMode,
        // bash on both sides of the SSH boundary, for the `pipefail` the
        // restore script opens with — under `sh` a failed download is
        // reported as whatever the engine's import made of an empty stream, and
        // `mysql` makes exit 0 of it. `buildRestoreScript` carries the detail.
        shell: '/bin/bash',
        env: restore.env,
      });
    } catch (error) {
      throw new BadRequestException(
        rcloneFailureMessage(error, 'Failed to restore the backup'),
      );
    }
  }

  /**
   * Refuses a Backup, its run or its restore where it would land on the
   * platform host for a Service that does not run there (ADR-0053).
   *
   * - **A Service in a Cloud account**, in every mode: a cloud database and a
   *   Compose stack on its own Stack VM (ADR-0070) both have `serverId:
   *   null`, which `execRclone` reads as the platform host. A database's own
   *   refusal, `refuseCloudDatabaseDump`, is asked first where it applies;
   *   this one is the Compose stack's, and the backstop for any other kind.
   * - **Any Service on the platform host, on the Hosted instance**, where no
   *   Service is (a row from before hosted mode was turned on): before the
   *   run is recorded, rather than at `execRclone`'s own refusal.
   */
  private refuseCloudParent(parent: BackupParent): void {
    refuseCloudServiceHostWork(parent, 'backups');
    if (!parent.serverId) this.instanceMode.refusePlatformHost('services');
  }

  /** The credential set the engine's dump/restore commands run with: the
   * engine row's for database backups, the caller-supplied metadata for
   * compose (the engine lives inside the user's stack, so no row exists). */
  private credentialsFor(
    source: {
      backupType: BackupType;
      database: string;
      metadata: ComposeBackupMetadata | null;
    },
    parent: BackupParent,
  ): DatabaseCredentials {
    if (source.backupType === 'compose') {
      const metadata = source.metadata ?? {};
      return {
        database: source.database,
        databaseUser:
          metadata.postgres?.databaseUser ??
          metadata.mariadb?.databaseUser ??
          metadata.mongo?.databaseUser,
        databasePassword:
          metadata.mariadb?.databasePassword ??
          metadata.mongo?.databasePassword ??
          metadata.mysql?.databaseRootPassword,
      };
    }
    return {
      database: source.database,
      databaseUser: parent.databaseUser,
      databasePassword: parent.databasePassword,
    };
  }

  /** The backup run's command: dump | gzip streamed via rclone rcat to
   * `bucket/{appName}/{prefix}/{timestamp}.{ext}`. */
  private buildRunScript(
    row: Backup,
    parent: BackupParent,
    destination: Destination,
    logPath: string,
  ): EngineCommand {
    const builder = BACKUP_COMMANDS[row.databaseType as BackupDatabaseType];
    const fileName = `${getBackupTimestamp()}.${builder.extension}`;
    const bucketDestination = `${this.s3AppName(row, parent)}/${normalizeS3Path(row.prefix)}${fileName}`;
    // The destination is `quote()`d and handed to the builder rather than left
    // for it to parse back out of this string (H-36). It carries `row.prefix` —
    // `S3_KEY_REGEX` on `createBackupSchema` and on the stored row, held over
    // exactly the `normalizeS3Path` call below it, so what the charset admits
    // and what this word contains are the same string — and `row.serviceName`,
    // which took Compose's own charset. The quoting is still the
    // defence and the charsets stand behind it (`builders/build-strategy.ts`):
    // a `"…"` does not stop a `$(…)`, and this line goes to `RemoteExecService`
    // on the Server that runs the dump.
    const uploadTarget = `:s3:${destination.bucket}/${bucketDestination}`;
    const rcloneCommand = `rclone rcat ${quote([uploadTarget])}`;
    const containerSearch =
      row.backupType === 'compose'
        ? getComposeContainerCommand(
            parent.appName,
            row.serviceName ?? '',
            parent.composeType,
          )
        : getServiceContainerCommand(parent.appName);
    // The engine's own pair, reused as this method's: `buildBackupScript` wraps
    // the dump command and carries none of its own environment, so the script
    // and the variables the dump inside it reads travel on together to
    // `execRclone`. A second interface for the same shape would only be
    // a second place to forget the environment.
    const dump = builder.dump(this.credentialsFor(row, parent));
    return {
      command: buildBackupScript({
        containerSearch,
        dumpCommand: dump.command,
        rcloneCommand,
        logPath,
        uploadTarget,
      }),
      env: dump.env,
    };
  }

  /**
   * The S3 prefix a service's dumps live under — the stack service gets its own
   * directory for compose backups.
   *
   * `serviceName` is held to `COMPOSE_SERVICE_NAME_REGEX`, which is
   * what keeps this one path component: with no `/` in that set the segment
   * cannot split, and `bucketPrefixCandidates` trims the `_` back so
   * `parent.appName` is always among the candidates
   * {@link checkBackupFileAccess} resolves. `VolumeBackupsService.s3AppName`
   * renders the same shape from the same rule.
   */
  private s3AppName(row: Backup, parent: BackupParent): string {
    return row.backupType === 'compose' && row.serviceName
      ? `${parent.appName}_${row.serviceName}`
      : parent.appName;
  }
}
