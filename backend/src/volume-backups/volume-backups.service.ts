import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { quote } from 'shell-quote';
import { refuseWeightsVolumeBackup } from '../ai-models/weights-volume';
import { refuseCloudServiceHostWork } from '../common/cloud-service-host-work';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { refuseCloudDatabaseDump } from '../databases/common/server-only-dumps';
import type { ServiceType } from '../applications/application.schema';
import { BackupRunRecorderService } from '../backups/run-recorder.service';
import {
  bucketKeySegments,
  bucketPrefixCandidates,
  buildPruneCommand,
  getBackupTimestamp,
  normalizeS3Path,
} from '../backups/commands';
import {
  assertPrefixOwnersEntitled,
  servicesOwningPrefixes,
} from '../common/bucket-prefix-owners';
import type { BucketPrefixOwner } from '../common/bucket-prefix-owners';
import { resolveCredentialRefs } from '../common/credential-refs';
import type { CredentialRefResolvers } from '../common/credential-refs';
import { findParentService } from '../common/service-parent';
import type { ServiceParent } from '../common/service-parent';
import {
  reclaimDeploymentLogs,
  withUnreclaimedArtifacts,
} from '../common/teardown-steps';
import type { UnreclaimedArtifact } from '../common/teardown-steps';
import { refuseExistingDatabaseBackup } from '../databases/postgres/existing-postgres';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { Destination } from '../db/schema';
import { volumeBackupsDirectoryOn } from '../deployment-engine/deployment-engine.paths';
import {
  isVolumeLockBusyError,
  volumeLockBusyMessage,
} from '../deployment-engine/volume-lock';
import type { VolumeLockMode } from '../deployment-engine/volume-lock';
import { DestinationsService } from '../destinations/destinations.service';
import { execRclone, rcloneFailureMessage } from '../destinations/rclone-exec';
import { NotificationDispatcherService } from '../notifications/dispatcher.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { volumeBackup, volumeBackupServiceFk } from './volume-backup.schema';
import type { VolumeBackup } from './volume-backup.schema';
import {
  buildVolumeBackupScript,
  buildVolumeRestoreScript,
} from './volume-backup-commands';
import type {
  VolumeBackupStopTarget,
  VolumeRestoreTarget,
} from './volume-backup-commands';
import { storedVolumeBackupShellSchema } from './dto/volume-backup.dto';
import type {
  CreateVolumeBackupDto,
  ListVolumeBackupsDto,
  RestoreVolumeBackupDto,
  UpdateVolumeBackupDto,
} from './dto/volume-backup.dto';

/**
 * Every parent id a volume-backup body accepts that names a
 * **credential-bearing** row.
 *
 * `BackupsService`' `BACKUP_CREDENTIAL_REFS` one table over carries the
 * argument — the same column, the same `destination` row, the same two write
 * seams that resolved it by hand and the same `.set(data)` that then wrote the
 * request's id rather than the authorized one. The list is separate rather
 * than shared because it answers about *these* two schemas, which is the
 * reason `common/credential-refs.ts` keeps the Application's seven and the
 * Compose stack's five as two exports of one home.
 *
 * `serviceId` is deliberately absent: it is the owning Service, resolved over
 * nine tables by `common/service-parent.ts`' `findParentService`.
 */
export const VOLUME_BACKUP_CREDENTIAL_REFS = ['destinationId'] as const;

/** One of {@link VOLUME_BACKUP_CREDENTIAL_REFS}. */
export type VolumeBackupCredentialRef =
  (typeof VOLUME_BACKUP_CREDENTIAL_REFS)[number];

/** The volume-backup row's FK insert field for each owning service type. */
const VOLUME_BACKUP_FK_FIELD = {
  application: 'applicationId',
  postgres: 'postgresId',
  mysql: 'mysqlId',
  mariadb: 'mariadbId',
  mongo: 'mongoId',
  redis: 'redisId',
  compose: 'composeId',
  libsql: 'libsqlId',
  bucket: 'bucketId',
} as const satisfies Record<
  ServiceType,
  keyof typeof volumeBackup.$inferInsert
>;

/**
 * What `syncJob` needs to keep a cron job in step with a volume backup: a
 * stored row satisfies it, and so does the value object `create` builds before
 * the row exists.
 */
type SchedulableVolumeBackup = {
  volumeBackupId: string;
  schedule: string;
  enabled?: boolean | null;
};

/** The owning service's id off a volume-backup row (exactly one FK is set). */
function serviceIdOf(row: VolumeBackup): string {
  const serviceId = row[VOLUME_BACKUP_FK_FIELD[row.serviceType]];
  if (!serviceId) {
    throw new NotFoundException('Volume backup has no owning service');
  }
  return serviceId;
}

@Injectable()
export class VolumeBackupsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VolumeBackupsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
    private readonly destinations: DestinationsService,
    private readonly runRecorder: BackupRunRecorderService,
    private readonly scheduling: SchedulingService,
    private readonly dispatcher: NotificationDispatcherService,
    private readonly frozen: FrozenOrganizations,
    // `execRclone`'s platform-host rule (ADR-0053).
    private readonly instanceMode: InstanceMode,
  ) {}

  /** Runs at server boot: re-registers the cron job of every enabled volume
   * backup. */
  async onApplicationBootstrap(): Promise<void> {
    await this.initializeJobs();
  }

  async initializeJobs(): Promise<void> {
    // Never fails the boot — it logs and moves on.
    try {
      const rows = await this.db
        .select()
        .from(volumeBackup)
        .where(eq(volumeBackup.enabled, true));
      for (const row of rows) {
        this.registerJob(row);
      }
    } catch (error) {
      this.logger.error('Failed to initialize volume-backup schedules', error);
    }
  }

  /**
   * The backup runs by row id on its cron.
   *
   * Takes the three fields it reads rather than a `VolumeBackup`, because
   * `create` hands it the value object it is *about* to persist — the job
   * is registered before the row exists.
   */
  private registerJob(row: SchedulableVolumeBackup): void {
    this.scheduling.register(row.volumeBackupId, row.schedule, null, () =>
      this.runScheduled(row.volumeBackupId),
    );
  }

  /** Keeps the cron job in sync with the row after create/update/remove. */
  private syncJob(row: SchedulableVolumeBackup): void {
    if (row.enabled) {
      this.registerJob(row);
    } else {
      this.scheduling.unregister(row.volumeBackupId);
    }
  }

  /**
   * volumeBackup-create permission plus a *definition-write* level on the
   * owning service. The destination is resolved org-scoped, as backups do.
   *
   * **`'update'` on the owning Service, not `checkServiceAccess`'s defaulted
   * `'read'` — and the whole argument for the three writes lives here.**
   * {@link update} and {@link restore} cite this block rather than repeat it.
   *
   * The `service: update` change looked at this module and deliberately left it
   * alone.
   * `MountsService.create`'s docblock records why, and it is worth quoting
   * because it is the sentence that stopped being true: *"A Backup, a
   * Schedule and a Domain **are** their own resource, so `backup:update` and
   * `domain:delete` set the level of those writes and `checkServiceAccess` is
   * only answering entitlement, for which `read` is right."* That holds for
   * exactly as long as the row's **effect** lands on the row's own parent. A
   * volume backup's does not: `volumeName` is caller-supplied and held to a
   * charset alone — see `VOLUME_NAME_REGEX` in `dto/volume-backup.dto.ts` for
   * why that stays true — so `volumeBackup: ['create']` plus `service: ['read']`
   * on **one** Service authorized naming *any* volume on that Service's host
   * and having it tarred into a Destination the caller controls, a sibling
   * Service's database volume included. The resource's own statement was
   * therefore never setting the level of this write; it was naming a capability
   * whose target the caller chose afterwards.
   *
   * **What this costs, and to whom — the whole of it.** Nothing, for all three
   * static roles: `ownerRole` and `adminRole` hold
   * `service: ['create', 'read', 'update', 'delete']` and `memberRole` holds
   * `service: ['read', 'update']`, so every one of them passes. The loss
   * falls on exactly one shape — a licensed custom role granted `volumeBackup`
   * actions together with `service: ['read']` and not `'update'`, which could
   * register, re-point and restore a volume backup before and now cannot.
   * Nothing is migrated on its behalf, on the precedent
   * `PermissionService.checkServiceAccess` and the `service` statement in
   * `access-control.ts` both argue at length: **to restore what such a role
   * could do, add `update` to its `service` actions.** What it does not lose is
   * reading its volume backups or running one — see below.
   *
   * **Rejected: a fourth `service` action for the restore.** The precedent
   * for adding an action rather than overloading `read` is real and is the
   * wrong tool twice over here. The destructiveness already *has* a name —
   * `volumeBackup: ['restore']`, its own action in its own statement, which
   * `POST /volume-backups/restore` requires; what was missing was never a
   * capability name but the **entitlement level on the Service whose host the
   * volume lives on**, and `'update'` is the action that already means "may
   * change what this Service is and what it runs". A new action would also have
   * to be withheld from `memberRole` to buy anything at all, which is a feature
   * removal from the base member rather than a level being made expressible.
   *
   * **Rejected: `'delete'`.** It reads well for a restore that runs
   * `docker volume rm`, and `memberRole` holds no `service: ['delete']` — so it
   * would take volume restores away from every base member, which is the
   * `service: update` change's own test for a fix that has turned into a feature
   * removal.
   *
   * **Not raised: {@link runManual} and {@link remove}, deliberately.** A
   * manual run executes a **stored** row, and after this the row can only have
   * been written by somebody who held `'update'` on the parent, so running one
   * is the "operate the workload it may not redefine" — the carve-out that
   * keeps `deploy`, `start` and `rebuild` at `'read'` beside their own
   * `deployment: ['create']`. `remove` deletes the registration and no data.
   *
   * **ADR-0014 is not authority for leaving this at `'read'`, and its reasoning
   * does not extend here.** That decision is about a
   * *value a child asked for*: a `${{project.KEY}}` reference the Service itself
   * wrote, resolved down a tree the grant names, where reaching every
   * Environment under the Project is the product feature — "the grant means
   * what it says". This is the opposite geometry. The volume belongs to a
   * **sibling** the grant does not name, it is reached sideways because the
   * target is a free-form string rather than inherited down anything, and
   * nothing on the far side asked for it. ADR-0014 says so itself: it lists "a
   * volume backup's and a restore's caller-named `volumeName`" among the writes
   * recorded elsewhere that are "a *side effect* of a write rather than a value
   * a child asked for, so none of them can cite this decision". No ADR is added
   * for that reason — this is a level that was wrong, not a question with two
   * defensible answers.
   *
   * **What this does not close, stated so it is not mistaken for closed.**
   * `memberRole` holds `service: ['read', 'update']`, so a base member entitled
   * to one Service on a shared Server still passes this gate and can still name
   * a sibling's volume. Closing that needs either the free-form target bound
   * (rejected at `VOLUME_NAME_REGEX`'s docblock, with reasons) or a decision
   * about `volumeBackup: ['restore']` in `memberRole` — a change to
   * `access-control.ts`, which this does not make. Reported rather than done.
   *
   * The insert is deliberately last. It used to come first, and
   * `syncJob` registered the job after it — `register` throws synchronously
   * on an expression it cannot parse, so `{"schedule":"not a cron"}` answered 500
   * with the backup committed and nothing ever running it. That half is closed
   * at the DTO now (`common/cron-expression.ts`, shared with the schedules DTO
   * that found it), which turns it into a 400 that writes nothing; the
   * ordering closes what is left, so any other failure in `register` leaves no
   * row behind either. `volumeBackupId` is minted here rather than left to the
   * column's `$defaultFn` because the job is keyed by it and is registered
   * first — the `$defaultFn` stays as the safety net for any other writer.
   *
   * `appName` is deliberately *not* minted with it: nothing before the insert
   * reads it. It names the staging directory and the run-log directory, and
   * both are built from a stored row inside `run()`.
   *
   * No transaction. When the registration succeeds and the insert
   * then fails, the residue is a cron job this process holds for an id no row
   * has; its first tick raises `Volume backup not found`, which
   * `SchedulingService` catches and logs, and it does not survive a restart.
   * Unregistering it in a `catch` was the alternative and is rejected for the
   * reason the compensating delete was: a second action in the failure path,
   * for a residue that is inert and self-limiting.
   */
  async create(
    ctx: PermissionCtx,
    data: CreateVolumeBackupDto,
  ): Promise<VolumeBackup> {
    const serviceType = data.serviceType ?? 'application';
    const parent = await this.findParentService(
      ctx.session.activeOrganizationId,
      data.serviceId,
      serviceType,
    );
    await this.permissions.checkPermission(ctx, { volumeBackup: ['create'] });
    // `'update'` written out as a literal here, and again in `update` and
    // `restore`, rather than threaded through one private — `MountsService`'s
    // reason: the gate stays readable at the entry point, and
    // `test/coding-standards/composed-creates.spec.ts` reads it there too.
    await this.permissions.checkServiceAccess(ctx, data.serviceId, 'update');
    // The tarball's key is `{appName}/{prefix}/{volumeName}-{timestamp}.tar`
    // and `restore` now authorizes by that leading `appName`, so the prefix
    // under it has to stay inside the Service's own directory.
    // `bucketKeySegments` carries what that guard is and is not worth.
    bucketKeySegments(data.prefix);
    // An AI model's weights are downloaded again, not restored.
    await refuseWeightsVolumeBackup(this.db, data.volumeName);
    // An Existing database has no volume of Cloudgate's.
    if (serviceType === 'postgres' || serviceType === 'redis') {
      await refuseExistingDatabaseBackup(this.db, data.serviceId);
    }
    // A database in a Cloud account has no volume of Cloudgate's, and
    // neither has any other Service there.
    await refuseCloudDatabaseDump(this.db, serviceType, data.serviceId);
    refuseCloudServiceHostWork(parent, 'volumeBackups');
    const authorized = await resolveCredentialRefs(
      VOLUME_BACKUP_CREDENTIAL_REFS,
      this.credentialRefResolvers(ctx),
      data,
    );

    const { serviceId, ...rest } = data;
    const values = {
      ...rest,
      // The destination that lands is the one the lookup returned, not the one
      // the request carried — argued at `update`'s spread.
      ...authorized,
      volumeBackupId: nanoid(),
      serviceType,
      [VOLUME_BACKUP_FK_FIELD[serviceType]]: serviceId,
    };
    this.syncJob(values);

    const [created] = await this.db
      .insert(volumeBackup)
      .values(values)
      .returning();
    return created;
  }

  /**
   * Builds the tar → rclone copyto script against the org's destination, runs
   * it on the service's server with output appended to the run's log file,
   * and records the run as a deployment that ends done or error. The owning
   * service's serverId decides where the run executes, for every service type.
   *
   * Fails fast on a held volume lock and answers 409: somebody is
   * waiting on this HTTP response, and the thing that holds the lock is a tar
   * of a whole volume.
   *
   * **Still `'read'` on the owning Service, unlike {@link create},
   * {@link update} and {@link restore}.** This run has no caller-named target:
   * it executes a stored row, and that row can only have been
   * written by somebody holding `service: ['update']` on the parent. So it is
   * the operate-the-workload carve-out — `deploy`, `start` and `rebuild` all
   * take `'read'` here beside their own `deployment: ['create']`, and a role
   * built to run a workload it may not redefine keeps working.
   *
   * **Not clean, and reported rather than changed.** A row with
   * `turnOff` set scales the parent's swarm service to 0 for the duration of
   * the tar, so this route does *stop* a workload a `service: ['read']` role
   * may not redefine. That is a level question about an operate verb rather
   * than about a caller-named target, so raising it here would decide
   * the carve-out in passing; it belongs with the `deployment: ['create']`
   * family, and `volumeBackup: ['create']` — not `['read']` — is what gates the
   * route in the meantime.
   */
  async runManual(ctx: PermissionCtx, volumeBackupId: string): Promise<void> {
    const row = await this.findRow(volumeBackupId);
    const parent = await this.findParentService(
      ctx.session.activeOrganizationId,
      serviceIdOf(row),
      row.serviceType,
    );
    await this.permissions.checkPermission(ctx, { volumeBackup: ['create'] });
    await this.permissions.checkServiceAccess(ctx, serviceIdOf(row));
    const destination = await this.destinations.findOneWithCredentials(
      ctx,
      row.destinationId,
    );
    await this.run(row, parent, destination, 'fail-fast');
  }

  /**
   * The cron callback: a cron-fired run executes with no user session, so the
   * parent and destination resolve without org scoping (both were org-checked
   * when the row was created or updated).
   *
   * Blocks on a held volume lock rather than refusing: nobody is holding
   * a request open on it, and the next cron tick is an hour or a day away, so
   * giving up would mean skipping the backup outright.
   *
   * **This seam is why `resolveCredentialRefs` takes no `PermissionCtx`.**
   * `destinationId` reaches `DestinationsService.findOne(ctx, …)`
   * from {@link create} and {@link update} and `findForScheduledRun` from here,
   * with no ctx and no organization filter, because there is no session to
   * filter against and the row was organization-checked when it was written. A
   * ctx-bearing loop could only express that with a nullable ctx threaded
   * through every lookup — the shape `findParentService` already regrets, its
   * `organizationId: string | null` existing only so this method can pass
   * `null` one line above. So {@link credentialRefResolvers} closes over its
   * `ctx` and this run closes over nothing.
   *
   * `BackupsService.runScheduled` carries why this method, {@link runManual}
   * and {@link restore} are not themselves loop callers: they write no id and
   * need the decrypted row back, and the loop deliberately answers with ids.
   */
  async runScheduled(volumeBackupId: string): Promise<void> {
    const row = await this.findRow(volumeBackupId);
    // A Frozen Organization's backups do not run (ADR-0052): the
    // tick is skipped, recording nothing, and the next one asks again.
    if (await this.frozen.isFrozenAt({ serviceId: serviceIdOf(row) })) return;
    const parent = await this.findParentService(
      null,
      serviceIdOf(row),
      row.serviceType,
    );
    const destination = await this.destinations.findForScheduledRun(
      row.destinationId,
    );
    await this.run(row, parent, destination, 'wait');
  }

  /** The run core shared by manual and scheduled volume backups. The lock mode
   * is a parameter and not a property of the row: it follows from how the run
   * was invoked, which is the one thing the two callers differ in. */
  private async run(
    row: VolumeBackup,
    parent: ServiceParent,
    destination: Destination,
    lockMode: VolumeLockMode,
  ): Promise<void> {
    // Before the run is recorded: its log is written on the parent's machine,
    // which for a Service in a Cloud account reads as the platform host. Here
    // rather than in the two callers, so a row saved before the refusal
    // cannot run by either way in.
    refuseCloudServiceHostWork(parent, 'volumeBackups');
    const run = await this.runRecorder.start({
      appName: row.appName,
      serverId: parent.serverId,
      title: 'Volume Backup',
      description: 'Volume Backup',
      initMessage: 'Initializing volume backup',
      parent: { kind: 'volumeBackup', volumeBackupId: row.volumeBackupId },
    });

    // Rooted on the machine the script is dispatched to, not on this process.
    // The same string reaches `buildVolumeBackupScript` and
    // `removeStagedTarball`, which is what keeps the tarball's writer and its
    // destroyer naming one directory — ADR-0018's rule stated for roots.
    const volumeBackupPath = `${volumeBackupsDirectoryOn(parent.serverId)}/${row.appName}`;
    const backupFileName = `${row.volumeName}-${getBackupTimestamp()}.tar`;

    try {
      // H-21: the row *is* the input to a shell script, and a row older than
      // the rules now governing these fields has no write left to validate it.
      // Inside the `try`, and after the run is recorded, on purpose — see
      // `assertStoredValuesShellSafe`.
      this.assertStoredValuesShellSafe(row);

      const rcloneDestination = `:s3:${destination.bucket}/${this.s3AppName(row, parent)}/${normalizeS3Path(row.prefix)}${backupFileName}`;
      const script = buildVolumeBackupScript({
        serverId: parent.serverId,
        volumeName: row.volumeName,
        backupFileName,
        volumeBackupPath,
        rcloneDestination,
        turnOff: row.turnOff,
        target: this.stopTarget(row, parent),
        lockMode,
      });
      const command = `(${script}) >> ${quote([run.logPath])} 2>&1`;

      await execRclone(this.remoteExec, command, {
        destination,
        serverId: parent.serverId,
        platformHost: this.instanceMode,
      });
      await this.runRecorder.finish(run.deploymentId, 'done');
      await this.notifyRun(row, parent, 'success');
    } catch (error) {
      await this.removeStagedTarball(
        parent.serverId,
        volumeBackupPath,
        backupFileName,
      );
      // Already masked: an rclone failure comes back through execRclone with
      // the credentials taken out, so the notification a person reads and the
      // rethrow the exception filter journals are safe to build from it.
      //
      // A lock-contention failure is recorded and notified exactly like any
      // other, deliberately. It *is* a run that was asked for and did
      // not happen, and the run history is where an operator goes to find out
      // what a backup has been doing; a refusal that left no trace there would
      // read as a backup that never ran at all.
      //
      // Only a manual run can reach this: a scheduled run acquires in `wait`
      // mode and therefore blocks instead of exiting busy. So the notification
      // this dispatches always has a 409 already on its way to whoever clicked,
      // which is duplication — accepted on the grounds above, and the thing to
      // revisit first if the notification proves noisy in practice.
      await this.runRecorder.finish(run.deploymentId, 'error');
      await this.notifyRun(
        row,
        parent,
        'error',
        (error as { message?: string })?.message || 'Unknown error',
      );
      if (isVolumeLockBusyError(error)) {
        throw new ConflictException(volumeLockBusyMessage(row.volumeName));
      }
      throw error;
    }
    await this.pruneOldBackups(row, parent, destination);
  }

  /**
   * The stored row's shell-bound fields, or a 400 naming the one that is wrong
   * (H-21).
   *
   * **Why here and not only at the DTO.** `volumeName` and `prefix` are
   * interpolated into `buildVolumeBackupScript`'s `docker run -v`, its
   * `bash -c`, the `rclone copyto` destination and the `echo` lines beside
   * them, and `deployment-engine/volume-lock.ts` takes `volumeName` too. Those
   * words are `quote()`d now and the DTOs refuse the charset behind them — but
   * a volume backup is a **cron job**: `runScheduled` reads the row and builds
   * the script with no request anywhere in the call, so a row written before
   * either rule existed can never reach a DTO again. There is no write to
   * validate. Left at the DTO alone, the schedule would go on executing that
   * stored value on the run host every night, and the operator's only way to
   * stop it would be to edit or delete a row nothing told them about. That is
   * X05-1's shape with the request taken out of it.
   *
   * **A refusal, not a silent skip, and not a sanitize.** All three were
   * weighed. Skipping the run quietly is the X05-1 failure one
   * layer further in — the poisoned row stays, the backups stop, and the first
   * anyone hears of it is a restore that finds nothing. Rewriting the value to
   * something safe would silently point the run at a different volume or a
   * different S3 prefix, which for a *backup* means writing the wrong object
   * and believing it. A refusal is the only one of the three where the row's
   * owner finds out.
   *
   * **And it is thrown from inside `run`'s `try`, after the run is recorded**,
   * which is the whole of the answer to "what does this do to a scheduled
   * run". The catch below already argues the case for its own failures — *"the
   * run history is where an operator goes to find out what a backup has been
   * doing; a refusal that left no trace there would read as a backup that
   * never ran at all"* — and a poisoned row is exactly that kind of failure.
   * So it ends as a `deployment` row with status `error` and a notification
   * through the configured channels, on the scheduled path as much as the
   * manual one; `SchedulingService`'s `logger.error` catches the rethrow on
   * top of that. Guarding before `runRecorder.start` was the alternative and
   * is rejected for that reason: it is cheaper, and it makes the scheduled
   * case invisible in the one place built for looking at it.
   *
   * The field is named and the value is never echoed: an operator needs to
   * know *which* box on *which* backup is poisoned, and repeating a stored
   * injection payload into an error body — which is journalled, notified and
   * rendered in the console — puts it somewhere new for no gain (§2.5).
   */
  private assertStoredValuesShellSafe(row: VolumeBackup): void {
    const checked = storedVolumeBackupShellSchema.safeParse(row);
    if (checked.success) return;

    const fields = checked.error.issues
      .map((issue) => `${issue.path.join('.')} (${issue.message})`)
      .join('; ');
    throw new BadRequestException(
      `Volume backup ${row.volumeBackupId} has a stored value that cannot be given to a shell — ${fields}. Correct or delete that volume backup; until then every run of it is refused`,
    );
  }

  /** The notification sent after every run. */
  private async notifyRun(
    row: VolumeBackup,
    parent: ServiceParent,
    status: 'success' | 'error',
    errorMessage?: string,
  ): Promise<void> {
    await this.dispatcher.dispatch(parent.organizationId, {
      type: 'volume-backup',
      projectName: parent.projectName,
      applicationName: parent.name,
      volumeName: row.volumeName,
      serviceType: row.serviceType,
      status,
      errorMessage,
    });
  }

  /** Runs after every successful backup: keeps the newest keepLatestCount
   * tarballs of this volume and deletes the rest. Prune failures never fail the
   * backup that just succeeded. */
  private async pruneOldBackups(
    row: VolumeBackup,
    parent: ServiceParent,
    destination: Destination,
  ): Promise<void> {
    if (!row.keepLatestCount) return;
    try {
      const command = buildPruneCommand({
        backupFilesPath: `:s3:${destination.bucket}/${this.s3AppName(row, parent)}/${normalizeS3Path(row.prefix)}`,
        include: `${row.volumeName}-*.tar`,
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
      this.logger.error('Volume backup prune failed', error);
    }
  }

  /** One volume backup, access-scoped through the owning service. */
  async findOne(ctx: PermissionCtx, volumeBackupId: string) {
    const row = await this.findRow(volumeBackupId);
    await this.findParentService(
      ctx.session.activeOrganizationId,
      serviceIdOf(row),
      row.serviceType,
    );
    await this.permissions.checkPermission(ctx, { volumeBackup: ['read'] });
    await this.permissions.checkServiceAccess(ctx, serviceIdOf(row));
    return row;
  }

  /** A service's volume backups, newest first. */
  async listByService(ctx: PermissionCtx, query: ListVolumeBackupsDto) {
    await this.findParentService(
      ctx.session.activeOrganizationId,
      query.serviceId,
      query.serviceType,
    );
    await this.permissions.checkPermission(ctx, { volumeBackup: ['read'] });
    await this.permissions.checkServiceAccess(ctx, query.serviceId);
    return this.db
      .select()
      .from(volumeBackup)
      .where(eq(volumeBackupServiceFk[query.serviceType], query.serviceId))
      .orderBy(desc(volumeBackup.createdAt));
  }

  /**
   * The backup stays pointed at its service; a new destination is resolved
   * org-scoped like on create.
   *
   * **`'update'` on the owning Service, argued in {@link create}.** The
   * patch can rewrite `volumeName`, so this route has create's whole reach: a
   * backup registered against this Service's own volume can be re-pointed at a
   * sibling's, on the same host, in one `PATCH`.
   */
  async update(
    ctx: PermissionCtx,
    volumeBackupId: string,
    data: UpdateVolumeBackupDto,
  ) {
    const current = await this.findRow(volumeBackupId);
    const parent = await this.findParentService(
      ctx.session.activeOrganizationId,
      serviceIdOf(current),
      current.serviceType,
    );
    await this.permissions.checkPermission(ctx, { volumeBackup: ['update'] });
    await this.permissions.checkServiceAccess(
      ctx,
      serviceIdOf(current),
      'update',
    );
    refuseCloudServiceHostWork(parent, 'volumeBackups');
    // Create's guard, for the same reason: a `PATCH` is the other way a row's
    // `prefix` comes to carry a segment that climbs.
    if (data.prefix !== undefined) bucketKeySegments(data.prefix);
    if (data.volumeName !== undefined) {
      await refuseWeightsVolumeBackup(this.db, data.volumeName);
    }
    const authorized = await resolveCredentialRefs(
      VOLUME_BACKUP_CREDENTIAL_REFS,
      this.credentialRefResolvers(ctx),
      data,
    );

    const [updated] = await this.db
      .update(volumeBackup)
      // The id that lands is the one the lookup returned, not the one the
      // request carried ("the row is written from the id that
      // was authorized"). Equal by construction today — the lookup filters on
      // the very id it was given — so this is behind the refusal above rather
      // than a second rule. It is here because it is what stops `.set(data)`
      // being the thing that decides.
      .set({ ...data, ...authorized })
      .where(eq(volumeBackup.volumeBackupId, current.volumeBackupId))
      .returning();
    this.syncJob(updated);
    return updated;
  }

  /**
   * The org-scoped lookup for each id in
   * {@link VOLUME_BACKUP_CREDENTIAL_REFS}, each answering with the id it
   * authorized — the only half of the rule that is this module's own
   * (the loop is `common/credential-refs.ts`' {@link resolveCredentialRefs}).
   *
   * `BackupsService.credentialRefResolvers` carries the argument, including why
   * this is `findOne` and not `findOneWithCredentials` and why `ctx` is closed
   * over rather than threaded through the loop. {@link runScheduled} is the
   * seam that makes the second half of that necessary.
   */
  private credentialRefResolvers(
    ctx: PermissionCtx,
  ): CredentialRefResolvers<VolumeBackupCredentialRef> {
    // `CredentialRefResolvers<VolumeBackupCredentialRef>` on purpose: this is
    // the type that makes the list load-bearing, because a name added there
    // with no lookup here fails to compile.
    return {
      destinationId: async (id) =>
        (await this.destinations.findOne(ctx, id)).destinationId,
    };
  }

  /** Still `'read'` on the owning Service — see {@link create}: this
   * deletes the registration and its cron job, names no volume, and destroys no
   * data, so `volumeBackup: ['delete']` really is setting the level of the
   * write here. */
  async remove(
    ctx: PermissionCtx,
    volumeBackupId: string,
  ): Promise<VolumeBackup & { unreclaimedArtifacts?: UnreclaimedArtifact[] }> {
    const current = await this.findRow(volumeBackupId);
    const parent = await this.findParentService(
      ctx.session.activeOrganizationId,
      serviceIdOf(current),
      current.serviceType,
    );
    await this.permissions.checkPermission(ctx, { volumeBackup: ['delete'] });
    await this.permissions.checkServiceAccess(ctx, serviceIdOf(current));

    // The run logs, on the machine {@link run} wrote them to: the run
    // Deployments cascade with the row, so nothing could open them afterwards.
    const unreclaimedArtifacts = await reclaimDeploymentLogs(this.remoteExec, [
      { appName: current.appName, serverId: parent.serverId },
    ]);
    const [removed] = await this.db
      .delete(volumeBackup)
      .where(eq(volumeBackup.volumeBackupId, current.volumeBackupId))
      .returning();
    this.scheduling.unregister(current.volumeBackupId);
    return withUnreclaimedArtifacts(removed, unreclaimedArtifacts);
  }

  /**
   * Downloads the tarball from the org's destination and untars it into the
   * re-created volume on the target service's server — refusing volumes still
   * in use. Runs to completion, with no log streaming.
   *
   * **`'update'` on the target Service, argued in {@link create}, and
   * this is the route that made the argument.** The script this builds runs
   * `docker volume rm --force` and then `docker volume create` and untars into
   * the replacement, and both the volume and the object key come off the wire
   * rather than out of a stored row — `restoreVolumeBackupSchema`'s own comment
   * says so: *"any tarball in the destination can be restored into any
   * volume"*. `service: ['read']` on one Service therefore used to authorize
   * destroying and replacing a volume of a Service on the same host that the
   * caller was never entitled to. It is not a read, and it is not "operating"
   * the workload either (which is why {@link runManual} keeps `'read'` and this
   * does not): the data the volume held before is gone whether or not the
   * archive extracts, as `replaceVolumeCommand`'s own failure message spells
   * out.
   *
   * **The second half of the key-prefix fix, and the one the level does not
   * close: a Destination's bucket is organization-wide.** Every Service's
   * tarballs live in one bucket, so a caller holding `volumeBackup: ['restore']`
   * and entitlement to Service A could name **Service B's** tarball as
   * `backupFileName`, untar it into a volume of A, and read another Service's
   * data through a Service they *are* entitled to. That is a sideways reach
   * across the entitlement column which turns a restore into a **read**,
   * mediated by the shared Destination rather than by the Server — which is why
   * the raised level was worth doing on its own and was never going to be
   * enough. `test/volume-backups/volume-backup-authorization.e2e-spec.ts`
   * asserted that request as *allowed* once.
   *
   * {@link checkTarballAccess} closes it. The short form: a tarball's key begins
   * with the `appName` of the Service that wrote it, so the key names its own
   * owner, and the caller must be entitled to that owner.
   *
   * **`backupFileName` keeps its `S3_KEY_REGEX`, and the schema was never the
   * thing that was wrong.** `restoreVolumeBackupSchema`'s own comment conceded
   * that any tarball in the destination can be restored into any volume; a
   * tighter charset does not make a key somebody else's tarball. What changed is
   * that the key is now *authorized*, against rows.
   */
  async restore(ctx: PermissionCtx, data: RestoreVolumeBackupDto) {
    const parent = await this.findParentService(
      ctx.session.activeOrganizationId,
      data.serviceId,
      data.serviceType,
    );
    await this.permissions.checkPermission(ctx, { volumeBackup: ['restore'] });
    await this.permissions.checkServiceAccess(ctx, data.serviceId, 'update');
    refuseCloudServiceHostWork(parent, 'volumeBackups');
    await this.checkTarballAccess(ctx, data.backupFileName);
    const destination = await this.destinations.findOneWithCredentials(
      ctx,
      data.destinationId,
    );

    const script = buildVolumeRestoreScript({
      serverId: parent.serverId,
      volumeName: data.volumeName,
      backupFileName: data.backupFileName,
      bucket: destination.bucket,
      target: this.restoreTarget(data.serviceType, parent),
    });
    // The script is written to be read: the in-use branch lists every
    // container holding the volume, its state and its type, and prints three
    // numbered steps for freeing it. All of that is its stdout, so the refusal
    // is answered to whoever asked for the restore instead of ending as a 500
    // with the text alive only in this instance's journal.
    try {
      await execRclone(this.remoteExec, script, {
        destination,
        serverId: parent.serverId,
        platformHost: this.instanceMode,
      });
    } catch (error) {
      // One exit code is answered ahead of the stdout-first message:
      // a script that never got past its own lock preamble has no diagnosis in
      // its stdout to relay, and "try again" is a different answer from "this
      // request was wrong" — 409, not 400.
      if (isVolumeLockBusyError(error)) {
        throw new ConflictException(volumeLockBusyMessage(data.volumeName));
      }
      throw new BadRequestException(
        rcloneFailureMessage(error, 'Failed to restore the volume'),
      );
    }
  }

  /**
   * Who may restore this object key — the half the raised level
   * does not close.
   *
   * `assertPrefixOwnersEntitled` carries the whole rule and the alternatives it
   * beat; this is the key convention it is applied through here. A tarball lands
   * at `{appName}/{prefix}/{volumeName}-{timestamp}.tar` — {@link run} builds
   * that path and {@link s3AppName} picks its leading segment — so the leading
   * segment resolves back to the Service that wrote it, through
   * `bucketPrefixCandidates` because a compose backup's segment is
   * `{appName}_{serviceName}` and `serviceName` may carry `_` of its own
   * (Compose's charset).
   *
   * **`bucketKeySegments` first, and here it is not only about well-posedness.**
   * On the bucket a `..` segment is inert: rclone's S3 encoding turns `.` and
   * `..` into fullwidth stops (`--s3-encoding` defaults to
   * `Slash,InvalidUtf8,Dot` for every provider) and an S3 key is an opaque byte
   * string either way, so nothing climbs out of a prefix there — measured
   * against a local endpoint with this application's own invocation form, and it
   * is why the first half is *not* the finding it was filed as. What is live
   * is the **local** path: `buildVolumeRestoreScript` stages the download at
   * `{volumeBackupsDirectoryOn(serverId)}/{volumeName}/{backupFileName}` and the
   * `trap … EXIT` runs `rm -f` on it whether the download happened or not, so a
   * key carrying `..` was an arbitrary-path delete — and the download beside it
   * an arbitrary-path write — on the Server, as the account that drives Docker.
   * `S3_KEY_REGEX` refuses a *leading* dot only, so `a/../../../etc/x` passed
   * it. That refusal also keeps the question above well-posed, which is the
   * lesser of the two reasons rather than the only one.
   */
  private async checkTarballAccess(
    ctx: PermissionCtx,
    backupFileName: string,
  ): Promise<void> {
    const [prefix] = bucketKeySegments(backupFileName);
    if (!prefix) {
      throw new BadRequestException('A backup file path is required');
    }
    const owners = await this.tarballPrefixOwners(
      bucketPrefixCandidates(prefix),
    );
    await assertPrefixOwnersEntitled(this.permissions, ctx, owners);
  }

  /** The Services claiming any of these names as their `appName` (shared
   * eight-table resolver). A method rather than a bare call so the decision
   * above can be driven at the unit seam without the union — the same reason
   * {@link findParentService} is one. */
  private tarballPrefixOwners(names: string[]): Promise<BucketPrefixOwner[]> {
    return servicesOwningPrefixes(this.db, names);
  }

  /**
   * The S3 directory the tarballs live under — the stack service gets its own
   * directory for compose backups.
   *
   * **`serviceName` is the other caller-supplied value that reaches a bucket
   * path in this module, and it was left unguarded while recording why it was
   * safe to.** It was `z.string().optional()` with no charset at all, so it
   * could carry `/` and `.` segments — but it is *suffixed onto
   * `parent.appName`*, and `bucketPrefixCandidates` trims the leading segment
   * back at every `_`, so `parent.appName` is always among the candidates
   * {@link checkTarballAccess} resolves. A compose row therefore could not make
   * its key's leading segment name a Service other than its own parent,
   * whatever it put here; the worst it bought is the narrow false refusal
   * `assertPrefixOwnersEntitled` already records, when some *other* Service is
   * genuinely named `{appName}_{serviceName}`.
   *
   * **It has a charset all the same**, because both halves of that
   * argument are one edit away from not holding — a change to the trimming, or
   * a new builder that interpolates without `quote()` — and a field with no
   * rule at all is what neither half is about.
   * `COMPOSE_SERVICE_NAME_REGEX` carries the decision, including why it is
   * Compose's own set rather than `S3_KEY_REGEX`; the practical effect here is
   * that no `/` can reach this shape, so the leading segment is one path
   * component by construction rather than by the trimming's good manners.
   * `storedVolumeBackupShellSchema` holds a stored row to the same rule before
   * a scheduled run builds anything, which is the half that covers a row
   * written before it existed.
   *
   * The audit behind that sentence, so the next reader does not redo it: the
   * values reaching an rclone path here are `row.prefix` (guarded on the
   * register and the re-point), `data.backupFileName` (guarded in
   * {@link checkTarballAccess}), this `serviceName`, `row.volumeName` — which
   * `VOLUME_NAME_REGEX` forbids a `/` in, so it cannot make a segment —
   * `row.appName` and `parent.appName`, both platform-minted, and
   * `destination.bucket` off an org-scoped row. There is no listing route in
   * this module, so nothing here answers to `search`: the restore's file
   * picker is `GET /destinations/:id/objects`, which is `DestinationsService`'
   * and is neither bounded nor filtered.
   */
  private s3AppName(row: VolumeBackup, parent: ServiceParent): string {
    return row.serviceType === 'compose' && row.serviceName
      ? `${parent.appName}_${row.serviceName}`
      : parent.appName;
  }

  /** The Service a restore names in its log, and for a bucket the Garage
   * Swarm service it stops while it replaces the volume. */
  private restoreTarget(
    serviceType: RestoreVolumeBackupDto['serviceType'],
    parent: ServiceParent,
  ): VolumeRestoreTarget {
    if (serviceType === 'compose') {
      return {
        serviceType: 'compose',
        appName: parent.appName,
        composeType: parent.composeType ?? 'docker-compose',
      };
    }
    return { serviceType, appName: parent.appName };
  }

  /** What a turn-off backup stops: the application's or the bucket's swarm
   * service, or the compose service's container. Database engines cannot be stopped this
   * way, so their turn-off falls back to a plain backup: the backup still
   * runs, it just stops nothing. */
  private stopTarget(
    row: VolumeBackup,
    parent: ServiceParent,
  ): VolumeBackupStopTarget | undefined {
    if (row.serviceType === 'application') {
      return { serviceType: 'application', appName: parent.appName };
    }
    // A bucket's Garage is a Swarm service named after its appName, as an
    // Application is, and its metadata store is on the same volume.
    if (row.serviceType === 'bucket') {
      return { serviceType: 'bucket', appName: parent.appName };
    }
    if (row.serviceType === 'compose') {
      return {
        serviceType: 'compose',
        appName: parent.appName,
        serviceName: row.serviceName ?? '',
        composeType: parent.composeType ?? 'docker-compose',
      };
    }
    return undefined;
  }

  /**
   * The one tarball a failed run staged, removed from the staging directory.
   *
   * Named, not globbed. `rm -rf {volumeBackupPath}/*.tar` read as safe
   * because the staging directory is per row — but `runManual` and
   * `runScheduled` both fall straight through to `run()` with no in-flight
   * guard, so one row can be running twice at once, and the timestamps in the
   * file names make the two tarballs siblings in one directory. The glob then
   * deleted the healthy run's tarball mid-flight and that run failed at upload
   * on a missing local file. The volume lock narrows the window and does not
   * close it: the lock lives inside the generated script and this runs in the
   * service's `catch`, after the script has exited and released it.
   *
   * `rm -f`, because a run can fail before the tar ever wrote anything, and a
   * cleanup that has nothing to clean up is not a second failure. And the whole
   * thing is best-effort: the error being recovered from is what gets recorded
   * on the run and dispatched as the notification, so a failure here is logged
   * and swallowed rather than replacing it.
   */
  private async removeStagedTarball(
    serverId: string | null,
    volumeBackupPath: string,
    backupFileName: string,
  ): Promise<void> {
    try {
      // `quote()`d, not double-quoted (H-21): `backupFileName` is
      // `{row.volumeName}-{timestamp}.tar`, and `$(…)` substitutes inside
      // `"…"` exactly as it does in a bare word. This is the one sink on the
      // *failure* path, which is where a poisoned row is most likely to end up.
      await this.exec(
        serverId,
        `rm -f ${quote([`${volumeBackupPath}/${backupFileName}`])}`,
      );
    } catch (error) {
      this.logger.error('Volume backup staged tarball cleanup failed', error);
    }
  }

  /** A script that touches no bucket, and so needs no credentials and no
   * masking — the staged tarball cleanup after a failed run. Everything that
   * does reach the Destination goes through `execRclone` instead. */
  private async exec(serverId: string | null, command: string): Promise<void> {
    if (serverId) {
      await this.remoteExec.execAsyncRemote(serverId, command);
    } else {
      await this.remoteExec.execAsync(command);
    }
  }

  /** The full row by id, before any access decision needs its parent. */
  private async findRow(volumeBackupId: string): Promise<VolumeBackup> {
    const [row] = await this.db
      .select()
      .from(volumeBackup)
      .where(eq(volumeBackup.volumeBackupId, volumeBackupId))
      .limit(1);
    if (!row) throw new NotFoundException('Volume backup not found');
    return row;
  }

  /** The service the volume backup targets, org-scoped (shared helper); a
   * null organizationId skips the org filter (scheduled runs). */
  private findParentService(
    organizationId: string | null,
    serviceId: string,
    serviceType: ServiceType,
  ): Promise<ServiceParent> {
    return findParentService(this.db, organizationId, serviceId, serviceType);
  }
}
