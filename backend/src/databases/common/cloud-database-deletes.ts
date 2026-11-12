import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { quote } from 'shell-quote';

import { CLOUD_DELETE_REFUSED_CODE } from '../../applications/cloud-delete-refusal';
import { ELASTICACHE_NODE_TYPES } from '../../cloud-accounts/aws/definitions/database-class';
import { destroyDefinition } from '../../cloud-accounts/aws/definitions/destroy-definition';
import {
  finalSnapshotIdentifier,
  POSTGRES_INSTANCE_ADDRESS,
  rdsInstanceIdentifier,
} from '../../cloud-accounts/aws/definitions/postgres-definition';
import { REDIS_GROUP_ADDRESS } from '../../cloud-accounts/aws/definitions/redis-definition';
import type { TofuDefinition } from '../../cloud-accounts/definitions/tofu-json';
import {
  deleteReportLines,
  findLeftovers,
  heldByState,
} from '../../cloud-accounts/aws/delete-check';
import type {
  KeptResource,
  Leftover,
} from '../../cloud-accounts/aws/delete-check';
import {
  dataDeletedLine,
  formatUsd,
  isAutomatedSnapshotArn,
  isSnapshotArn,
  keptSnapshot,
  snapshotMonthlyUsd,
  UNTIL_DELETED_IN_AWS,
} from '../../cloud-accounts/aws/final-snapshot';
import type { SnapshotService } from '../../cloud-accounts/aws/final-snapshot';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../../cloud-accounts/cloud-provider';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import {
  cloudOrLegacy,
  credentialOf,
} from '../../cloud-accounts/cloud-provider';
import { cloudAccount } from '../../cloud-accounts/cloud-account.schema';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import { byCloud, onCloud } from '../../cloud-accounts/cloud-provider';
import { googleRefusalReason } from '../../cloud-accounts/gcp/api-off';
import { CLOUD_SQL_INSTANCE_ADDRESS } from '../../cloud-accounts/gcp/definitions/cloud-sql-definition';
import { destroyDefinition as googleDestroyDefinition } from '../../cloud-accounts/gcp/definitions/destroy-definition';
import { serviceName } from '../../cloud-accounts/gcp/definitions/names';
import { GOOGLE_CLEAN_DELETE_LINE } from '../../cloud-accounts/gcp/delete-check';
import {
  backupDataDeletedLine,
  backupMonthlyUsd,
  backupSizeGb,
  CLOUD_SQL_DISK_GIB,
  cloudSqlBackupLocation,
  finalBackupName,
  keepsBackupSentence,
  keptBackup,
} from '../../cloud-accounts/gcp/final-backup';
import type { BackupProduct } from '../../cloud-accounts/gcp/final-backup';
import {
  AWS_CLOUD_PORT,
  CHANGED_NOTHING,
} from '../../cloud-accounts/cloud.port';
import type {
  AwsCloudPort,
  AwsCredential,
  GoogleCredential,
  TofuFailure,
  TofuShow,
} from '../../cloud-accounts/cloud.port';
import {
  GOOGLE_CLOUD_PORT,
  NOT_FOUND,
} from '../../cloud-accounts/google-cloud.port';
import type {
  GoogleAccessToken,
  GoogleAnswer,
  GoogleCloudPort,
  TakenBackup,
} from '../../cloud-accounts/google-cloud.port';
import type { InfrastructureState } from '../../cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { ownerOnlyDirectoryCommand } from '../../common/files/owner-only';
import { reclaimDeploymentLogs } from '../../common/teardown-steps';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import {
  deployment,
  existingDatabase,
  mysql,
  postgres,
  redis,
} from '../../db/schema';
import type { Deployment, Mysql, Postgres, Redis } from '../../db/schema';
import { NothingRemoved } from '../../common/nothing-removed';
import {
  deleteRdsRow,
  findRdsRow,
  findRdsState,
  rdsExistingColumn,
  rdsIdOf,
  rdsKindOf,
  updateRdsRow,
} from './rds-rows';
import type { RdsRow } from './rds-rows';
import { deploymentLogsDirectoryOn } from '../../deployment-engine/deployment-engine.paths';
import { parentColumns } from '../../deployment-engine/ports/deployment-recorder';
import { CloudReadWorks } from '../../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunJob,
} from '../../deployment-queue/cloud-run-job.types';
import {
  CloudRunsService,
  endingDescription,
} from '../../deployment-queue/cloud-runs.service';
import { AuditLogService } from '../../enterprise/audit-logs/audit-log.service';
import {
  googleNetworkNames,
  savedCloudSqlDefinition,
} from '../../project-config/cloud-sql-places';
import { writeKept } from '../../project-config/console-saves';
import type { KeepConfig } from '../../project-config/console-saves';
import { savedRedisDefinition } from '../../project-config/elasticache-redis-places';
import {
  savedDatabaseNetwork,
  savedRdsDatabaseDefinition,
  snapshotDate,
  snapshotNames,
} from '../../project-config/rds-postgres-places';
import { memorystoreWritableGb } from '../../project-config/planner/memorystore';
import type { PermissionCtx } from '../../rbac/permission.service';
import { RemoteExecService } from '../../remote/remote-exec.service';
import type { DatabaseCloudDeleteRecord } from './cloud-database-delete-record';

/** The kinds of database Cloudgate makes in a Cloud account: a mysql on RDS too. */
export type CloudDatabaseKind = 'postgres' | 'mysql' | 'redis';

/** Whether a kind is an RDS instance on AWS: a postgres's or a mysql's. */
function onRds(kind: CloudDatabaseKind): kind is 'postgres' | 'mysql' {
  return kind !== 'redis';
}

/** What a cloud database's Delete reads off its row. */
export interface CloudDatabaseTarget {
  readonly kind: CloudDatabaseKind;
  readonly databaseId: string;
  readonly appName: string;
  /** Its display name, for the audit entry and the log. */
  readonly name: string;
  readonly configName: string | null;
  readonly environmentId: string;
  readonly cloudAccountId: string;
  readonly region: string;
  readonly cloudDelete: DatabaseCloudDeleteRecord | null;
  /**
   * An Existing database's connection name: its Delete destroys only
   * what Cloudgate made for it — on Google Cloud its endpoint and zone — and
   * leaves the instance as it was, with no final backup to keep.
   */
  readonly existing?: string;
}

/**
 * The Delete dialog's line before it is pressed: the final snapshot
 * this Delete would keep, named for today, and about what it would cost a
 * month — RDS's from its allocated storage, ElastiCache's from its node's
 * memory, so an estimate, said as one. On Google Cloud it is the final
 * backup: Cloud SQL's from its disk, Valkey's from its node's
 * writable memory.
 */
export interface FinalSnapshotPreview {
  /** Which cloud keeps it: a snapshot on AWS, a backup on Google Cloud. */
  readonly cloud: CloudKind;
  readonly name: string;
  readonly region: string;
  readonly sizeGb: number;
  readonly monthlyUsd: number;
  /**
   * `keeps snapshot <name>, about $X a month, until you delete it in AWS`,
   * or `keeps backup <name>, …, until you delete it in Google Cloud`.
   */
  readonly sentence: string;
}

const SNAPSHOT_SERVICE: Readonly<Record<CloudDatabaseKind, SnapshotService>> = {
  postgres: 'rds',
  mysql: 'rds',
  redis: 'elasticache',
};

const ENGINE: Readonly<Record<CloudDatabaseKind, string>> = {
  postgres: 'RDS',
  mysql: 'RDS',
  redis: 'ElastiCache',
};

/** Each kind's backup on Google Cloud, by the product that keeps it. */
const BACKUP_PRODUCT: Readonly<Record<CloudDatabaseKind, BackupProduct>> = {
  postgres: 'cloud-sql',
  mysql: 'cloud-sql',
  redis: 'memorystore',
};

/** Each kind's product on Google Cloud. */
const GOOGLE_ENGINE: Readonly<Record<CloudDatabaseKind, string>> = {
  postgres: 'Cloud SQL',
  mysql: 'Cloud SQL',
  redis: 'Memorystore',
};

/**
 * **A cloud database's Delete** (spec "Delete"; ADR-0038): a
 * postgres on RDS or a redis on ElastiCache is deleted by a cloud Service's
 * destroy-only Cloud run, recorded as a Deployment of the database,
 * and never loses data by accident.
 *
 * 1. The request checks the Cloud account can be reached (nothing removed
 *    otherwise), names the final snapshot for the day it was asked —
 *    `<project>-<environment>-<service>-final-<date>` — unless it asked for
 *    the data to go, records the Deployment and marks the row `deleting`.
 * 2. The run lifts RDS's deletion protection first, through the cloud
 *    port's direct call (ElastiCache has none); from here on a failure says
 *    the protection is now off.
 * 3. It applies, limited to the instance or replication group, the two
 *    settings a destroy reads from the state: protection off and the final
 *    snapshot named — or skipped, when asked. Nothing else moves: a plan
 *    that would make or replace anything stops the Delete there.
 * 4. It destroys everything in the database's state; the snapshot carries
 *    Cloudgate's tags (copied from the instance).
 * 5. It checks what is left (the snapshot, found by its copied tags, is not
 *    a leftover) and reads the snapshot's size, and the report's *kept* list
 *    names it once with its region, size and monthly cost.
 * 6. A clean finish removes the state, drops the row and its Deployments
 *    and writes the report into the audit entry; nothing of the snapshot is
 *    stored after. Anything else leaves the row Delete incomplete, for Retry
 *    or Forget, as a cloud Service's does.
 *
 * An Environment's Delete runs each database's Delete with the snapshot
 * kept: only the database's own Delete, or its Plan destroy, can ask for the
 * data to go.
 *
 * On Google Cloud the kept copy is a **backup**: see
 * {@link CloudDatabaseDeletes.destroyOnGoogle}.
 */
@Injectable()
export class CloudDatabaseDeletes implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly remoteExec: RemoteExecService,
    private readonly auditLogs: AuditLogService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** The pool lives in the queue module, which imports this one. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  onModuleInit(): void {
    this.moduleRef
      .get(CloudReadWorks, { strict: false })
      .handle('database-destroy', (job, control) => this.run(job, control));
  }

  /** The database's row as a Delete reads it, or `null` off a Cloud account. */
  async targetOf(
    kind: CloudDatabaseKind,
    databaseId: string,
  ): Promise<CloudDatabaseTarget | null> {
    const row = await this.rowOf(kind, databaseId);
    if (!row) return null;
    return targetOfRow(kind, row) ?? (await this.existingTargetOf(kind, row));
  }

  /**
   * An Existing database whose own state holds what Cloudgate made for it
   * on Google Cloud a Cloud SQL postgres's endpoint and zone, which
   * only a destroy-only Cloud run removes, in its existing row's place. One
   * with no state (every AWS one, whose lookup holds nothing) is no cloud
   * Delete: its records alone go (ADR-0033).
   */
  private async existingTargetOf(
    kind: CloudDatabaseKind,
    row: Postgres | Mysql | Redis,
  ): Promise<CloudDatabaseTarget | null> {
    // An existing Valkey's two endpoints, in the redis's own state.
    if (kind === 'redis') {
      const cache = row as Redis;
      const [existing] = await this.db
        .select()
        .from(existingDatabase)
        .where(eq(existingDatabase.redisId, cache.redisId));
      if (!existing) return null;
      if (!(await this.states.findForRedis(cache.redisId))) return null;
      return {
        kind,
        databaseId: cache.redisId,
        appName: cache.appName,
        name: cache.name,
        configName: cache.configName,
        environmentId: cache.environmentId,
        cloudAccountId: existing.cloudAccountId,
        region: existing.region,
        cloudDelete: cache.cloudDelete,
        existing: existing.identifier,
      };
    }
    // A Cloud SQL postgres's or mysql's endpoint and zone.
    const database = row as Postgres | Mysql;
    const id = rdsIdOf(database);
    const [existing] = await this.db
      .select()
      .from(existingDatabase)
      .where(eq(rdsExistingColumn(rdsKindOf(database)), id));
    if (!existing) return null;
    const state = await findRdsState(this.states, rdsKindOf(database), id);
    if (!state) return null;
    return {
      kind,
      databaseId: id,
      appName: database.appName,
      name: database.name,
      configName: database.configName,
      environmentId: database.environmentId,
      cloudAccountId: existing.cloudAccountId,
      region: existing.region,
      cloudDelete: database.cloudDelete,
      existing: existing.identifier,
    };
  }

  /** Every cloud database of an Environment, as its Delete reads it. */
  async targetsIn(environmentId: string): Promise<CloudDatabaseTarget[]> {
    const pg = await this.db
      .select()
      .from(postgres)
      .where(eq(postgres.environmentId, environmentId));
    const my = await this.db
      .select()
      .from(mysql)
      .where(eq(mysql.environmentId, environmentId));
    const rd = await this.db
      .select()
      .from(redis)
      .where(eq(redis.environmentId, environmentId));
    // An Existing database's endpoint and zone too, which sit in
    // the Environment network and must go before it.
    const existing = await Promise.all([
      ...pg
        .filter((row) => targetOfRow('postgres', row) === null)
        .map((row) => this.existingTargetOf('postgres', row)),
      // An existing Cloud SQL mysql's alike.
      ...my
        .filter((row) => targetOfRow('mysql', row) === null)
        .map((row) => this.existingTargetOf('mysql', row)),
      // An existing Valkey's endpoints alike.
      ...rd
        .filter((row) => targetOfRow('redis', row) === null)
        .map((row) => this.existingTargetOf('redis', row)),
    ]);
    return [
      ...pg.map((row) => targetOfRow('postgres', row)),
      ...existing,
      ...my.map((row) => targetOfRow('mysql', row)),
      ...rd.map((row) => targetOfRow('redis', row)),
    ]
      .filter((one): one is CloudDatabaseTarget => one !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The Delete (or, `retrying`, its Retry): refused while one runs, and a
   * first Delete refused once incomplete. A Retry keeps the snapshot the
   * Delete named. Answers the row, marked `deleting`.
   */
  async request(
    ctx: PermissionCtx,
    target: CloudDatabaseTarget,
    keep: KeepConfig,
    options: { readonly retrying: boolean; readonly deleteData: boolean },
  ): Promise<Postgres | Mysql | Redis | undefined> {
    return (await this.start(ctx, target, keep, options)).row;
  }

  /** {@link request}, with when its run ended: what an Environment's Delete waits on. */
  async start(
    ctx: PermissionCtx,
    target: CloudDatabaseTarget,
    keep: KeepConfig,
    options: { readonly retrying: boolean; readonly deleteData: boolean },
  ): Promise<{
    row: Postgres | Mysql | Redis | undefined;
    ended: Promise<void>;
  }> {
    const { retrying } = options;
    const record = await this.settled(target);
    if (record?.status === 'deleting') {
      throw refused(`${target.name} is already being deleted`);
    }
    if (!retrying && record?.status === 'incomplete') {
      throw refused(
        `${target.name} is Delete incomplete: Retry the Delete, or Forget it`,
      );
    }
    if (retrying && record?.status !== 'incomplete') {
      throw refused(
        `${target.name} has no Delete to retry: Retry is for a Service whose Delete is incomplete`,
      );
    }

    // A Delete whose Cloud account cannot be reached fails and removes
    // nothing: asked here, before a Deployment exists.
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      target.cloudAccountId,
    );
    if (!cloudAccountRow) {
      throw refused(
        'The Cloud account this Service runs in is gone. Nothing was removed',
      );
    }
    const signInRefusal =
      await this.cloudAccounts.signInRefusal(cloudAccountRow);
    if (signInRefusal !== null) {
      throw refused(`${signInRefusal}. Nothing was removed`);
    }
    const stopped = await this.stoppedRefusal(target, options);
    if (stopped !== null) throw refused(stopped);
    const finalSnapshot = await byCloud(cloudAccountRow.cloud, {
      aws: async () =>
        target.existing !== undefined
          ? null
          : retrying
            ? (record?.finalSnapshot ?? null)
            : options.deleteData
              ? null
              : await this.snapshotNameFor(target, new Date()),
      // A Cloud SQL or Memorystore instance's final backup, named
      // as an AWS final snapshot is. An Existing database's is the
      // operator's to keep: its Delete takes none.
      gcp: async () =>
        target.existing !== undefined
          ? null
          : retrying
            ? (record?.finalSnapshot ?? null)
            : options.deleteData
              ? null
              : finalBackupName(await this.snapshotNameFor(target, new Date())),
    })();
    const run = await this.record(
      target,
      retrying,
      byCloud(cloudAccountRow.cloud, { aws: ENGINE, gcp: GOOGLE_ENGINE })[
        target.kind
      ],
    );
    const next: DatabaseCloudDeleteRecord = {
      status: 'deleting',
      deploymentId: run.deploymentId,
      retrying,
      requestedBy: {
        userId: ctx.user.id,
        organizationId: ctx.session.activeOrganizationId,
      },
      kept: [],
      left: record?.left ?? [],
      unfinished: null,
      finalSnapshot,
      // A Retry takes no second backup of a Google database.
      ...(retrying && record?.backupTaken
        ? { backupTaken: record.backupTaken }
        : {}),
    };
    let row: Postgres | Mysql | Redis | undefined;
    try {
      row = await writeKept(
        this.db,
        keep,
        (db) => this.writeRecord(target.kind, target.databaseId, next, db),
        (written) =>
          written ? { serviceId: target.databaseId, removed: {} } : null,
      );
    } catch (error) {
      await this.db
        .delete(deployment)
        .where(eq(deployment.deploymentId, run.deploymentId));
      throw error;
    }

    const ended = this.cloudRuns
      .submit(run.deploymentId, {
        kind: 'database-destroy',
        stateKey: `${target.kind}:${target.databaseId}`,
        environmentId: target.environmentId,
        touchesNetwork: false,
      })
      .then(async (ending) => {
        if (ending.kind === 'shutdown' && !ending.started) return;
        await this.endedOutside(
          target,
          run.deploymentId,
          ending.kind === 'cancelled'
            ? null
            : (endingDescription(ending) ?? 'The Delete ended'),
        );
      })
      .catch(() => undefined);
    return { row, ended };
  }

  /**
   * Why a Delete that keeps a final backup cannot run now, or `null`
   * Google takes no on-demand backup of a Cloud SQL
   * instance that is stopped, so its Delete would lift the deletion
   * protection and then never finish. It is refused before anything is
   * changed on Google, unless its data goes with it (no backup to take)
   * or a backup was already taken by an earlier run. An Environment's
   * Delete, which keeps every database's backup, is refused alike.
   */
  async stoppedRefusal(
    target: CloudDatabaseTarget,
    options: { readonly retrying: boolean; readonly deleteData: boolean },
  ): Promise<string | null> {
    // Cloud SQL's instances, a postgres's or a mysql's.
    if (target.kind === 'redis' || target.existing !== undefined) {
      return null;
    }
    if (!options.retrying && options.deleteData) return null;
    const record = await this.settled(target);
    if (options.retrying && (!record?.finalSnapshot || record.backupTaken)) {
      return null;
    }
    const cloud = await this.cloudOf(target);
    if (!cloud) return null;
    return byCloud(cloud, {
      // RDS takes a final snapshot of a stopped instance.
      aws: () => Promise.resolve(null),
      gcp: async () => {
        const row = await this.rowOf(target.kind, target.databaseId);
        return row?.applicationStatus === 'stopped'
          ? `${target.name} is stopped. Start it first, then delete it.`
          : null;
      },
    })();
  }

  /**
   * The Delete dialog's read: the snapshot a Delete pressed now keeps,
   * and about what it costs a month. `null` off a Cloud account.
   */
  async preview(
    target: CloudDatabaseTarget,
  ): Promise<FinalSnapshotPreview | null> {
    const row = await this.rowOf(target.kind, target.databaseId);
    if (!row) return null;
    // An Existing database's Delete keeps no backup: the instance is the
    // operator's, left as it was.
    if (target.existing !== undefined) return null;
    return byCloud<() => Promise<FinalSnapshotPreview | null>>(
      cloudOrLegacy(await this.cloudOf(target)),
      {
        aws: () => this.finalSnapshotPreview(target, row),
        gcp: () => this.finalBackupPreview(target, row),
      },
    )();
  }

  /** The Cloud SQL or Valkey backup a Delete pressed now keeps, and its monthly cost. */
  private async finalBackupPreview(
    target: CloudDatabaseTarget,
    row: NonNullable<Awaited<ReturnType<CloudDatabaseDeletes['rowOf']>>>,
  ): Promise<FinalSnapshotPreview> {
    const product = BACKUP_PRODUCT[target.kind];
    const sizeGb = estimatedBackupGb(target.kind, row);
    const name = finalBackupName(
      await this.snapshotNameFor(target, new Date()),
    );
    const monthlyUsd = backupMonthlyUsd(product, sizeGb);
    return {
      cloud: 'gcp',
      name,
      region:
        product === 'cloud-sql'
          ? cloudSqlBackupLocation(target.region)
          : target.region,
      sizeGb,
      monthlyUsd,
      sentence: keepsBackupSentence(name, monthlyUsd),
    };
  }

  /** The RDS or ElastiCache snapshot a Delete pressed now keeps, and its monthly cost. */
  private async finalSnapshotPreview(
    target: CloudDatabaseTarget,
    row: NonNullable<Awaited<ReturnType<CloudDatabaseDeletes['rowOf']>>>,
  ): Promise<FinalSnapshotPreview> {
    const service = SNAPSHOT_SERVICE[target.kind];
    const sizeGb = estimatedSizeGb(target.kind, row);
    const name = await this.snapshotNameFor(target, new Date());
    const monthlyUsd = snapshotMonthlyUsd(service, sizeGb);
    return {
      cloud: 'aws',
      name,
      region: target.region,
      sizeGb,
      monthlyUsd,
      sentence: `keeps snapshot ${name}, about ${formatUsd(monthlyUsd)} a month, ${UNTIL_DELETED_IN_AWS}`,
    };
  }

  /** The record as it stands; a `deleting` whose run is gone reads incomplete. */
  settledRecord(
    target: CloudDatabaseTarget,
  ): Promise<DatabaseCloudDeleteRecord | null> {
    return this.settled(target);
  }

  /**
   * An incomplete Delete forgotten as part of its Environment's Forget
   * the state and the row dropped, answering what was left.
   */
  async discard(target: CloudDatabaseTarget): Promise<Leftover[]> {
    const record = await this.settled(target);
    const state = await this.stateOf(target);
    if (state) await this.states.remove(state.infrastructureStateId);
    await this.drop(target);
    return [...(record?.left ?? [])];
  }

  /**
   * Forget: the row dropped with what is left still in AWS, the list
   * written into the audit entry (ADR-0038).
   */
  async forget(ctx: PermissionCtx, target: CloudDatabaseTarget) {
    const record = await this.settled(target);
    if (record?.status !== 'incomplete') {
      throw refused(
        record?.status === 'deleting'
          ? `${target.name} is being deleted; Forget is for a Delete that is incomplete`
          : `${target.name} has no incomplete Delete to forget`,
      );
    }
    const state = await this.stateOf(target);
    if (state) await this.states.remove(state.infrastructureStateId);
    const leftBehind = await this.drop(target);
    await this.auditLogs.audit(
      { userId: ctx.user.id, organizationId: ctx.session.activeOrganizationId },
      {
        action: 'delete',
        resourceType: 'database',
        resourceId: target.databaseId,
        resourceName: target.name,
        metadata: {
          cloudDelete: 'forgotten',
          left: record.left,
          ...(record.unfinished ? { unfinished: record.unfinished } : {}),
          ...leftBehind,
        },
      },
    );
    return { databaseId: target.databaseId, forgotten: record.left };
  }

  /** `<project>-<environment>-<service>-final-<date>`, dated `at` (UTC). */
  private async snapshotNameFor(
    target: CloudDatabaseTarget,
    at: Date,
  ): Promise<string> {
    return finalSnapshotIdentifier({
      ...(await snapshotNames(this.db, target.environmentId)),
      configName: target.configName ?? target.name,
      date: snapshotDate(at),
    });
  }

  private async settled(
    target: CloudDatabaseTarget,
  ): Promise<DatabaseCloudDeleteRecord | null> {
    const record = target.cloudDelete;
    if (record?.status !== 'deleting') return record;
    const [run] = await this.db
      .select({ status: deployment.status })
      .from(deployment)
      .where(eq(deployment.deploymentId, record.deploymentId));
    if (run && (run.status === 'pending' || run.status === 'running')) {
      return record;
    }
    return {
      ...record,
      status: 'incomplete',
      unfinished:
        record.unfinished ?? 'The Delete was cut off before it finished',
    };
  }

  /** The Delete's Deployment, `pending`, its log on the platform host. */
  private async record(
    target: CloudDatabaseTarget,
    retrying: boolean,
    engine: string = ENGINE[target.kind],
  ): Promise<Deployment> {
    const deploymentId = nanoid();
    const logPath = `${deploymentLogsDirectoryOn(null, target.appName)}/${deploymentId}.log`;
    const directory = logPath.slice(0, logPath.lastIndexOf('/'));
    await this.remoteExec.execAsync(
      `${ownerOnlyDirectoryCommand(directory)}; echo "Initializing deployment" >> ${quote([logPath])};`,
    );
    const [row] = await this.db
      .insert(deployment)
      .values({
        deploymentId,
        ...(target.kind === 'postgres'
          ? parentColumns({ kind: 'postgres', postgresId: target.databaseId })
          : target.kind === 'mysql'
            ? parentColumns({ kind: 'mysql', mysqlId: target.databaseId })
            : parentColumns({ kind: 'redis', redisId: target.databaseId })),
        title: retrying ? 'Retry Delete' : 'Delete',
        description:
          target.existing === undefined
            ? `Destroys the ${engine} ${onRds(target.kind) || engine === GOOGLE_ENGINE.redis ? 'instance' : 'replication group'} and everything in its Infrastructure state in ${target.region}`
            : `Destroys ${madeForExisting(target.kind)} for the existing database ${target.existing} in ${target.region}, and leaves ${target.existing} as it was`,
        status: 'pending',
        logPath,
      })
      .returning();
    return row;
  }

  /** The run, as the pool runs it. */
  private async run(job: CloudRunJob, control: CloudRunControl) {
    const [row] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, job.deploymentId ?? ''));
    const owner: [CloudDatabaseKind, string] | null = row?.postgresId
      ? ['postgres', row.postgresId]
      : row?.mysqlId
        ? ['mysql', row.mysqlId]
        : row?.redisId
          ? ['redis', row.redisId]
          : null;
    if (!row || !owner) throw new Error('This Cloud run records no database');
    const target = await this.targetOf(...owner);
    const record = target?.cloudDelete;
    if (!target || !record) {
      throw new Error('This database has no Delete under way');
    }
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    try {
      await this.destroy(
        { ...target, cloudDelete: record },
        record,
        control,
        log,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof NothingRemoved) {
        await log(`❌ [Cloud run] ${message}`);
        await this.revert(target, record, message);
      }
      throw error;
    }
  }

  private async destroy(
    target: CloudDatabaseTarget,
    record: DatabaseCloudDeleteRecord,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      target.cloudAccountId,
    );
    if (!cloudAccountRow) {
      throw new NothingRemoved(
        'The Cloud account this Service runs in is gone. Nothing was removed',
      );
    }
    // Each cloud's half (ADR-0043).
    await onCloud(cloudAccountRow, {
      aws: (account) =>
        this.destroyOnAws(target, record, account, control, log),
      gcp: (account) =>
        this.destroyOnGoogle(target, record, account, control, log),
    });
  }

  /** A postgres's or a mysql's on RDS or a redis on ElastiCache's Delete: protection off, a final snapshot unless asked not to, then the destroy. */
  private async destroyOnAws(
    target: CloudDatabaseTarget,
    record: DatabaseCloudDeleteRecord,
    account: AwsCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const reached = await this.cloudAccounts.deployRoleSession(account);
    if (!reached.ok) {
      throw new NothingRemoved(`${reached.refusal}. Nothing was removed`);
    }
    const state = await this.stateOf(target);
    const engine = ENGINE[target.kind];
    await log(
      `🗑️ [Cloud run] Deleting ${target.name} from Cloud account ${account.name} in ${target.region}` +
        (record.finalSnapshot
          ? `, keeping a final snapshot ${record.finalSnapshot}`
          : ', its data deleted for good: no final snapshot'),
    );
    if (!control.beginApply()) {
      throw new NothingRemoved(
        'The run was ended before it changed anything. Nothing was removed',
      );
    }

    // 1. RDS refuses to delete a protected instance: lifted first, by the
    // port's direct call. From here a failure says the protection is off.
    let protectionOff = false;
    if (onRds(target.kind)) {
      const instanceIdentifier = rdsInstanceIdentifier(target.databaseId);
      const lifted = await this.cloud
        .rdsLiftDeletionProtection(reached.session, {
          region: target.region,
          identifier: instanceIdentifier,
        })
        .catch((error: unknown) => ({
          ok: false as const,
          code: 'Unreachable',
          message: error instanceof Error ? error.message : String(error),
        }));
      if (!lifted.ok) {
        throw new NothingRemoved(
          `RDS refused to lift ${target.name}'s deletion protection: AWS answered ${lifted.code}: ${lifted.message}. Nothing was removed`,
        );
      }
      if (lifted.value === 'lifted') {
        protectionOff = true;
        await log(
          `🔓 [Cloud run] Deletion protection lifted on RDS instance ${instanceIdentifier}`,
        );
      } else {
        await log(
          `[Cloud run] RDS has no instance ${instanceIdentifier}: no deletion protection to lift`,
        );
      }
    }
    const protectionNote = protectionOff
      ? ` ${target.name}'s deletion protection is now off.`
      : '';

    let show: TofuShow | null = null;
    let unfinished: string | null = null;
    let destroyed = false;
    if (state) {
      // 2. The two settings a destroy reads from the state.
      const prepared = await this.prepare(
        target,
        account,
        state,
        record,
        control,
        log,
      );
      if (!prepared.ok) {
        if (CHANGED_NOTHING.has(prepared.reason) && !protectionOff) {
          throw new NothingRemoved(`${prepared.message} Nothing was removed`);
        }
        unfinished = `${prepared.message} Nothing was destroyed.${protectionNote}`;
      } else {
        // 3. The destroy.
        await log(
          `🗑️ [Cloud run] Destroying everything in Infrastructure state ${state.infrastructureStateId}`,
        );
        const outcome = await this.states.destroy({
          stateId: state.infrastructureStateId,
          credential: credentialOf(account),
          definition: destroyDefinition(accessOf(account), target.region, {
            cloudAccountId: account.cloudAccountId,
            environmentId: target.environmentId,
            stateId: state.infrastructureStateId,
          }),
          onLine: (line) => void log(line),
          signal: control.signal,
          beforeApply: () =>
            control.beginApply() ? null : ENDED_BEFORE_DESTROYING,
        });
        if (outcome.ok) {
          show = outcome.show;
          destroyed = true;
        } else if (CHANGED_NOTHING.has(outcome.reason) && !protectionOff) {
          throw new NothingRemoved(`${outcome.message} Nothing was removed`);
        } else {
          unfinished = `${outcome.message}${protectionNote}`;
        }
      }
    } else {
      await log(
        `🗑️ [Cloud run] ${target.name} has no Infrastructure state: nothing was made for it in AWS`,
      );
      destroyed = true;
    }

    // 4. The check afterwards, with a fresh session, and the snapshot read.
    let left: Leftover[] = [...record.left];
    const kept: KeptResource[] = [];
    if (control.signal.killed) {
      unfinished ??= `The run was killed before it could check what is left.${protectionNote}`;
    } else if (destroyed) {
      await log('🔎 [Cloud run] Checking AWS for anything left');
      const session = await this.cloudAccounts.deployRoleSession(account);
      if (!session.ok) {
        unfinished ??= `What is left could not be checked: ${session.refusal}`;
      } else {
        const check = state
          ? await findLeftovers(this.cloud, session.session, {
              region: target.region,
              stateId: state.infrastructureStateId,
              iamRoleNames: [],
              securityGroupIds: heldByState(show).securityGroupIds,
            })
          : { ok: true as const, left: [] };
        if (check.ok) {
          // The snapshot carries the instance's tags, so the tag search
          // finds it: it is kept on purpose, not left. So do the
          // instance's automated backups, which RDS deletes with it but the
          // tag index lists a while longer: gone with it, not left.
          const snapshot = record.finalSnapshot;
          const instance = onRds(target.kind)
            ? rdsInstanceIdentifier(target.databaseId)
            : null;
          left = check.left.filter(
            (one) =>
              !(snapshot && isSnapshotArn(one.awsId, snapshot)) &&
              !(instance && isAutomatedSnapshotArn(one.awsId, instance)),
          );
        } else {
          unfinished ??= `What is left could not be checked: ${check.message}`;
        }
        if (record.finalSnapshot) {
          const found = await this.snapshotKept(
            target,
            session.session,
            record.finalSnapshot,
          );
          if (found) kept.push(found);
          else {
            await log(
              `⚠️ [Cloud run] ${engine} has no snapshot ${record.finalSnapshot}: there was no ${onRds(target.kind) ? 'instance' : 'replication group'} left to take it from`,
            );
          }
        }
      }
    }

    // 5. The report, then the row.
    if (destroyed && !record.finalSnapshot) {
      await log(dataDeletedLine(target.name));
    }
    for (const line of deleteReportLines({ kept, left })) await log(line);
    if (unfinished === null && left.length === 0) {
      if (state) await this.states.remove(state.infrastructureStateId);
      await this.finish(target, record, kept);
      return;
    }
    await this.writeRecord(target.kind, target.databaseId, {
      ...record,
      status: 'incomplete',
      kept,
      left,
      unfinished,
    });
    const summary = `Delete incomplete: ${
      left.length > 0
        ? `${left.length} resource${left.length === 1 ? ' is' : 's are'} left in AWS`
        : unfinished
    }. Retry destroys again from the kept state`;
    await log(`⚠️ [Cloud run] ${summary}`);
    throw new Error(summary);
  }

  /**
   * A postgres on Cloud SQL's Delete, and a redis on Memorystore's
   * keeping a final backup unless it asked for the data to go:
   *
   * - **Cloud SQL**, in order: deletion protection off, Google's by the
   *   port's direct call and the provider's by an apply limited to the
   *   instance, since the provider refuses to destroy an instance its state
   *   protects; then one on-demand backup described by the backup's name,
   *   which outlives the instance since it retains its backups on delete —
   *   or, when the data is to go, retained-backups-on-delete off instead, so
   *   every backup goes with it; then the destroy. From the first step on a
   *   failure says the protection is now off.
   * - **Memorystore**, which has no deletion protection: one on-demand
   *   backup with the backup's name as its id and no TTL, then the destroy.
   *
   * Everything in its own state is destroyed — the instance, and with it
   * the address Google gave it on the Environment network's private link,
   * which stays, free, in the network's state. The report's *kept*
   * list names the backup once with where it is kept, its size and monthly
   * cost; once Google renames a Cloud SQL backup after its instance goes,
   * only its description finds it, and Cloudgate forgets it. A clean finish
   * removes the state and drops the row; anything else leaves the row
   * Delete incomplete, for Retry or Forget, and a Retry takes no second
   * backup.
   */
  private async destroyOnGoogle(
    target: CloudDatabaseTarget,
    record: DatabaseCloudDeleteRecord,
    account: GcpCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) {
      throw new NothingRemoved(`${session.refusal}. Nothing was removed`);
    }
    const state = await this.stateOf(target);
    const engine = GOOGLE_ENGINE[target.kind];
    const product = BACKUP_PRODUCT[target.kind];
    const backup = record.finalSnapshot;
    await log(
      target.existing === undefined
        ? `🗑️ [Cloud run] Deleting ${target.name} from Cloud account ${account.name} in ${target.region}` +
            (backup
              ? `, keeping a final backup ${backup}`
              : ', its data deleted for good: no final backup')
        : `🗑️ [Cloud run] Deleting ${madeForExisting(target.kind)} for ${target.name} from Cloud account ${account.name} in ${target.region}: the existing database ${target.existing} is left as it was`,
    );
    if (!control.beginApply()) {
      throw new NothingRemoved(
        'The run was ended before it changed anything. Nothing was removed',
      );
    }

    let taken = record.backupTaken ?? null;
    let protectionOff = false;
    let unfinished: string | null = null;
    let destroyed = false;
    const instanceName = serviceName(target.databaseId);
    const said = (answer: { code: string; message: string }) =>
      `Google answered ${answer.code}: ${googleRefusalReason(answer.message, account.cloudId)}`;

    if (state) {
      // 1–2. Everything before the destroy: protection off and the backup
      // taken (or, on Cloud SQL, no longer kept on delete).
      // An Existing database's instance is the operator's: its
      // protection and backups are left as they are, and only Cloudgate's
      // endpoint and zone are destroyed.
      const before: BeforeGoogleDestroy =
        target.existing !== undefined
          ? { ok: true, protectionOff: false, taken: null }
          : product === 'cloud-sql'
            ? await this.beforeCloudSqlDestroy(target, {
                account,
                state,
                token: session.token,
                credential: session.credential,
                instanceName,
                backup,
                taken,
                said,
                control,
                log,
              })
            : await this.beforeMemorystoreDestroy(target, {
                account,
                token: session.token,
                instanceName,
                backup,
                taken,
                said,
                log,
              });
      protectionOff = before.protectionOff;
      if (before.taken && !taken) {
        taken = before.taken;
        // Kept on the record at once, so a Retry takes no second one.
        await this.writeRecord(target.kind, target.databaseId, {
          ...record,
          backupTaken: taken,
        });
      }
      const protectionNote = protectionOff
        ? ` ${target.name}'s deletion protection is now off.`
        : '';
      if (!before.ok) {
        if (!protectionOff && !taken) {
          throw new NothingRemoved(`${before.message} Nothing was removed`);
        }
        unfinished = `${before.message} Nothing was destroyed.${protectionNote}`;
      } else {
        // 3. The destroy.
        await log(
          `🗑️ [Cloud run] Destroying everything in Infrastructure state ${state.infrastructureStateId}`,
        );
        const outcome = await this.states.destroy({
          stateId: state.infrastructureStateId,
          credential: session.credential,
          definition: googleDestroyDefinition(account.cloudId, target.region),
          onLine: (line) => void log(line),
          signal: control.signal,
          beforeApply: () =>
            control.beginApply() ? null : ENDED_BEFORE_DESTROYING,
        });
        if (outcome.ok) {
          destroyed = true;
        } else if (
          CHANGED_NOTHING.has(outcome.reason) &&
          !protectionOff &&
          !taken
        ) {
          throw new NothingRemoved(`${outcome.message} Nothing was removed`);
        } else {
          unfinished = `${googleRefusalReason(outcome.message, account.cloudId)}${protectionNote}`;
        }
      }
    } else {
      await log(
        `🗑️ [Cloud run] ${target.name} has no Infrastructure state: nothing was made for it in Google Cloud`,
      );
      destroyed = true;
    }

    // 4. The report, then the row.
    const kept =
      taken && backup
        ? [
            keptBackup({
              product,
              name: backup,
              region: taken.region,
              sizeGb: taken.sizeGb,
            }),
          ]
        : [];
    if (destroyed && target.existing !== undefined) {
      await log(
        `[Cloud run] ${target.existing} was left as it was; it is yours, and Cloudgate removed only what it made for ${target.name}`,
      );
    } else if (destroyed && backup === null) {
      await log(backupDataDeletedLine(target.name));
    } else if (destroyed && !taken) {
      await log(
        `⚠️ [Cloud run] ${engine} has no backup ${backup}: there was no instance left to take it from`,
      );
    }
    for (const line of deleteReportLines(
      { kept, left: record.left },
      GOOGLE_CLEAN_DELETE_LINE,
    )) {
      await log(line);
    }
    if (unfinished === null && record.left.length === 0) {
      if (state) await this.states.remove(state.infrastructureStateId);
      await this.finish(target, record, kept);
      return;
    }
    await this.writeRecord(target.kind, target.databaseId, {
      ...record,
      ...(taken ? { backupTaken: taken } : {}),
      status: 'incomplete',
      kept,
      left: record.left,
      unfinished,
    });
    const summary = `Delete incomplete: ${unfinished ?? 'something is left in Google Cloud'}. Retry destroys again from the kept state`;
    await log(`⚠️ [Cloud run] ${summary}`);
    throw new Error(summary);
  }

  /**
   * A Cloud SQL instance's steps before its destroy: Google's
   * deletion protection off by the port, the provider's by an apply limited
   * to the instance, then the backup — or retained backups off. An instance
   * Google no longer has, or the state no longer holds, has nothing to
   * protect or back up.
   */
  private async beforeCloudSqlDestroy(
    target: CloudDatabaseTarget,
    run: {
      readonly account: GcpCloudAccount;
      readonly state: InfrastructureState;
      readonly token: GoogleAccessToken;
      readonly credential: GoogleCredential;
      readonly instanceName: string;
      readonly backup: string | null;
      readonly taken: BackupTaken | null;
      readonly said: (answer: { code: string; message: string }) => string;
      readonly control: CloudRunControl;
      readonly log: (line: string) => Promise<void>;
    },
  ): Promise<BeforeGoogleDestroy> {
    const { account, token, instanceName, log, said } = run;
    const instance = { projectId: account.cloudId, name: instanceName };
    const lifted = await answered(
      this.google.liftCloudSqlDeletionProtection(token, instance),
    );
    if (!lifted.ok && lifted.code === NOT_FOUND) {
      await log(
        `[Cloud run] Cloud SQL has no instance ${instanceName}: no deletion protection to lift, and nothing to back up`,
      );
      return { ok: true, protectionOff: false, taken: null };
    }
    if (!lifted.ok) {
      return {
        ok: false,
        protectionOff: false,
        taken: null,
        message: `Cloud SQL refused to lift ${target.name}'s deletion protection: ${said(lifted)}.`,
      };
    }
    await log(
      `🔓 [Cloud run] Deletion protection lifted on Cloud SQL instance ${instanceName}`,
    );

    // The provider's own flag, which only its state holds.
    const applied = await this.liftInState(target, run);
    if (!applied.ok) {
      return {
        ok: false,
        protectionOff: true,
        taken: null,
        message: applied.message,
      };
    }
    if (applied.absent) return { ok: true, protectionOff: true, taken: null };

    if (run.backup === null) {
      const stopped = await answered(
        this.google.stopRetainingCloudSqlBackups(token, instance),
      );
      if (!stopped.ok) {
        return {
          ok: false,
          protectionOff: true,
          taken: null,
          message: `Cloud SQL refused to stop keeping ${target.name}'s backups on delete: ${said(stopped)}.`,
        };
      }
      await log(
        `[Cloud run] Cloud SQL instance ${instanceName} keeps no backup once deleted: everything goes with it`,
      );
      return { ok: true, protectionOff: true, taken: null };
    }
    if (run.taken) {
      await log(
        `[Cloud run] The final backup ${run.backup} was taken by an earlier run`,
      );
      return { ok: true, protectionOff: true, taken: run.taken };
    }
    await log(
      `📸 [Cloud run] Taking the final backup ${run.backup} of Cloud SQL instance ${instanceName}`,
    );
    const took = await answered(
      this.google.takeCloudSqlBackup(token, instance, run.backup),
    );
    if (!took.ok) {
      return {
        ok: false,
        protectionOff: true,
        taken: null,
        message: `Cloud SQL could not take the final backup ${run.backup}: ${said(took)}.`,
      };
    }
    const row = await this.rowOf(target.kind, target.databaseId);
    return {
      ok: true,
      protectionOff: true,
      taken: takenOf(target.kind, row, took.value),
    };
  }

  /**
   * The apply before a Cloud SQL destroy, limited to the instance: the
   * saved definition with both protections off. A plan that would
   * make the instance (the state no longer holds it) has nothing to back up
   * and is not applied; one that would replace or remove it stops the
   * Delete, since a destroy is the only thing that removes.
   */
  private async liftInState(
    target: CloudDatabaseTarget,
    run: {
      readonly account: GcpCloudAccount;
      readonly state: InfrastructureState;
      readonly credential: GoogleCredential;
      readonly control: CloudRunControl;
      readonly log: (line: string) => Promise<void>;
    },
  ): Promise<{ ok: true; absent: boolean } | { ok: false; message: string }> {
    const { account, state, control, log } = run;
    const row = await this.rowOf(target.kind, target.databaseId);
    if (!row) return { ok: false, message: `${target.name} is gone.` };
    if (target.kind === 'redis') {
      return {
        ok: false,
        message: `${target.name} is not a postgres or a mysql: Cloudgate writes no Cloud SQL definition for it.`,
      };
    }
    const network = await googleNetworkNames(this.db, {
      environmentId: target.environmentId,
      cloudAccountId: target.cloudAccountId,
      region: target.region,
    });
    if (network.standIns !== null) {
      return {
        ok: false,
        message: `The Environment network in ${target.region} is not made, so ${target.name}'s definition cannot be written.`,
      };
    }
    const written = savedCloudSqlDefinition({
      row: row as Postgres | Mysql,
      account,
      stateId: state.infrastructureStateId,
      network: network.names,
      deletionProtectionLifted: true,
    });
    if (!written.ok) return { ok: false, message: `${written.message}.` };
    await log(
      `🔓 [Cloud run] Lifting the provider's deletion protection in Infrastructure state ${state.infrastructureStateId}`,
    );
    let absent = false;
    const address = CLOUD_SQL_INSTANCE_ADDRESS;
    const outcome = await this.states.apply({
      stateId: state.infrastructureStateId,
      credential: run.credential,
      definition: written.generated.definition,
      variables: written.generated.variables,
      targets: [address],
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: (show) => {
        const actions = changesAt(show, address);
        if (actions.includes('create') && !actions.includes('delete')) {
          absent = true;
          return NOTHING_TO_SNAPSHOT;
        }
        if (actions.includes('delete') || actions.includes('create')) {
          return {
            ok: false,
            reason: 'failed',
            message: `Google Cloud no longer matches ${target.name}'s state: lifting its deletion protection would replace it. Check for changes, then Retry the Delete.`,
          };
        }
        return control.beginApply() ? null : ENDED_BEFORE_DESTROYING;
      },
    });
    if (absent) {
      await log(
        `[Cloud run] Infrastructure state ${state.infrastructureStateId} holds no instance: there is nothing to back up`,
      );
      return { ok: true, absent: true };
    }
    return outcome.ok
      ? { ok: true, absent: false }
      : {
          ok: false,
          message: googleRefusalReason(outcome.message, account.cloudId),
        };
  }

  /**
   * A Memorystore instance's step before its destroy: the backup,
   * with no TTL; it has no deletion protection. An instance Google no longer
   * has has nothing to back up; a backup already under that id is the one
   * an earlier run took.
   */
  private async beforeMemorystoreDestroy(
    target: CloudDatabaseTarget,
    run: {
      readonly account: GcpCloudAccount;
      readonly token: GoogleAccessToken;
      readonly instanceName: string;
      readonly backup: string | null;
      readonly taken: BackupTaken | null;
      readonly said: (answer: { code: string; message: string }) => string;
      readonly log: (line: string) => Promise<void>;
    },
  ): Promise<BeforeGoogleDestroy> {
    const { account, token, instanceName, backup, log } = run;
    if (backup === null) return { ok: true, protectionOff: false, taken: null };
    if (run.taken) {
      await log(
        `[Cloud run] The final backup ${backup} was taken by an earlier run`,
      );
      return { ok: true, protectionOff: false, taken: run.taken };
    }
    await log(
      `📸 [Cloud run] Taking the final backup ${backup} of Memorystore instance ${instanceName}`,
    );
    const took = await answered(
      this.google.takeMemorystoreBackup(
        token,
        {
          projectId: account.cloudId,
          region: target.region,
          name: instanceName,
        },
        backup,
      ),
    );
    if (!took.ok && took.code === NOT_FOUND) {
      await log(
        `[Cloud run] Memorystore has no instance ${instanceName}: there is nothing to back up`,
      );
      return { ok: true, protectionOff: false, taken: null };
    }
    const row = await this.rowOf(target.kind, target.databaseId);
    if (!took.ok && took.code === ALREADY_EXISTS) {
      return {
        ok: true,
        protectionOff: false,
        taken: takenOf(target.kind, row, {
          location: target.region,
          sizeBytes: null,
        }),
      };
    }
    if (!took.ok) {
      return {
        ok: false,
        protectionOff: false,
        taken: null,
        message: `Memorystore could not take the final backup ${backup}: ${run.said(took)}.`,
      };
    }
    return {
      ok: true,
      protectionOff: false,
      taken: takenOf(target.kind, row, took.value),
    };
  }

  /** The cloud a database's Cloud account is in. */
  private async cloudOf(
    target: CloudDatabaseTarget,
  ): Promise<CloudKind | null> {
    const [found] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, target.cloudAccountId));
    return found?.cloud ?? null;
  }

  /**
   * The apply before the destroy, limited to the instance or replication
   * group: protection off and the final snapshot named, or skipped. A plan
   * that would make anything (the state no longer holds it) has nothing to
   * snapshot and is not applied; one that would replace or remove anything
   * stops the Delete, since a destroy is the only thing that removes.
   */
  private async prepare(
    target: CloudDatabaseTarget,
    account: AwsCloudAccount,
    state: InfrastructureState,
    record: DatabaseCloudDeleteRecord,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<{ ok: true } | TofuFailure> {
    const generated = await this.deletingDefinition(
      target,
      account,
      state,
      record,
    );
    if (!generated.ok) {
      return { ok: false, reason: 'failed', message: generated.message };
    }
    const address = onRds(target.kind)
      ? POSTGRES_INSTANCE_ADDRESS
      : REDIS_GROUP_ADDRESS;
    await log(
      record.finalSnapshot
        ? `📸 [Cloud run] Naming the final snapshot ${record.finalSnapshot} in Infrastructure state ${state.infrastructureStateId}`
        : `[Cloud run] Skipping the final snapshot in Infrastructure state ${state.infrastructureStateId}`,
    );
    let absent = false;
    const outcome = await this.states.apply({
      stateId: state.infrastructureStateId,
      credential: credentialOf(account),
      definition: generated.definition,
      variables: generated.variables,
      targets: [address],
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: (show) => {
        const actions = changesAt(show, address);
        if (actions.includes('create') && !actions.includes('delete')) {
          absent = true;
          return NOTHING_TO_SNAPSHOT;
        }
        if (actions.includes('delete') || actions.includes('create')) {
          return {
            ok: false,
            reason: 'failed',
            message: `AWS no longer matches ${target.name}'s state: naming its final snapshot would replace it. Check for changes, then Retry the Delete.`,
          };
        }
        return control.beginApply() ? null : ENDED_BEFORE_DESTROYING;
      },
    });
    if (absent) {
      await log(
        `[Cloud run] Infrastructure state ${state.infrastructureStateId} holds no ${onRds(target.kind) ? 'instance' : 'replication group'}: there is nothing to snapshot`,
      );
      return { ok: true };
    }
    return outcome.ok ? { ok: true } : outcome;
  }

  private async deletingDefinition(
    target: CloudDatabaseTarget,
    account: AwsCloudAccount,
    state: InfrastructureState,
    record: DatabaseCloudDeleteRecord,
  ): Promise<
    | {
        ok: true;
        definition: TofuDefinition;
        variables: Record<string, string>;
      }
    | { ok: false; message: string }
  > {
    const network = await savedDatabaseNetwork(this.db, {
      environmentId: target.environmentId,
      cloudAccountId: target.cloudAccountId,
      region: target.region,
    });
    if (!network) {
      return {
        ok: false,
        message: `The Environment network in ${target.region} is not made, so ${target.name}'s definition cannot be written.`,
      };
    }
    const deleting = { finalSnapshot: record.finalSnapshot };
    const row = await this.rowOf(target.kind, target.databaseId);
    if (!row) return { ok: false, message: `${target.name} is gone.` };
    const written = onRds(target.kind)
      ? await savedRdsDatabaseDefinition(this.db, {
          row: row as RdsRow,
          account,
          stateId: state.infrastructureStateId,
          network,
          deleting,
        })
      : await savedRedisDefinition(this.db, {
          row: row as Redis,
          account,
          stateId: state.infrastructureStateId,
          network,
          deleting,
        });
    if (!written.ok) return { ok: false, message: `${written.message}.` };
    return {
      ok: true,
      definition: written.generated.definition,
      variables: written.generated.variables,
    };
  }

  /** The kept snapshot as AWS describes it, or `null` when there is none. */
  private async snapshotKept(
    target: CloudDatabaseTarget,
    session: AwsCredential,
    name: string,
  ): Promise<KeptResource | null> {
    const service = SNAPSHOT_SERVICE[target.kind];
    const ref = { region: target.region, name };
    const answer = await (
      service === 'rds'
        ? this.cloud.rdsSnapshot(session, ref)
        : this.cloud.elastiCacheSnapshot(session, ref)
    ).catch(() => null);
    if (answer?.ok && answer.value === null) return null;
    // A snapshot AWS would not describe is still named, sized as estimated.
    const row = await this.rowOf(target.kind, target.databaseId);
    const sizeGb =
      answer?.ok && answer.value
        ? answer.value.sizeGb
        : row
          ? estimatedSizeGb(target.kind, row)
          : 0;
    return keptSnapshot({ service, name, region: target.region, sizeGb });
  }

  /** A clean finish: the row and its Deployments dropped, the report audited. */
  private async finish(
    target: CloudDatabaseTarget,
    record: DatabaseCloudDeleteRecord,
    kept: readonly KeptResource[],
  ) {
    const leftBehind = await this.drop(target);
    const asked = record.requestedBy;
    if (!asked) return;
    await this.auditLogs.audit(asked, {
      action: 'delete',
      resourceType: 'database',
      resourceId: target.databaseId,
      resourceName: target.name,
      metadata: {
        cloudDelete: 'finished',
        kept,
        dataDeleted: record.finalSnapshot === null,
        ...leftBehind,
      },
    });
  }

  /**
   * The row dropped, its Deployments with it (they cascade), and their logs
   * on the platform host reclaimed (ADR-0018). Answers what it could not
   * reclaim.
   */
  private async drop(
    target: CloudDatabaseTarget,
  ): Promise<Record<string, unknown>> {
    const unreclaimedArtifacts = await reclaimDeploymentLogs(this.remoteExec, [
      { appName: target.appName, serverId: null },
    ]);
    if (onRds(target.kind)) {
      await deleteRdsRow(this.db, target.kind, target.databaseId);
    } else {
      await this.db.delete(redis).where(eq(redis.redisId, target.databaseId));
    }
    return unreclaimedArtifacts.length > 0 ? { unreclaimedArtifacts } : {};
  }

  /** Back to how the database was before this run: nothing was removed. */
  private async revert(
    target: CloudDatabaseTarget,
    record: DatabaseCloudDeleteRecord,
    why: string,
  ): Promise<void> {
    await this.writeRecord(
      target.kind,
      target.databaseId,
      record.retrying
        ? { ...record, status: 'incomplete', unfinished: why }
        : null,
    );
  }

  /** A Cancel before it began puts the database back; any other ending leaves it incomplete. */
  private async endedOutside(
    target: CloudDatabaseTarget,
    deploymentId: string,
    why: string | null,
  ): Promise<void> {
    const row = await this.rowOf(target.kind, target.databaseId);
    const record = row?.cloudDelete;
    if (!record || record.deploymentId !== deploymentId) return;
    if (why === null) {
      await this.revert(target, record, 'The Delete was cancelled');
      return;
    }
    if (record.status !== 'deleting') return;
    await this.writeRecord(target.kind, target.databaseId, {
      ...record,
      status: 'incomplete',
      unfinished: why,
    });
  }

  private stateOf(
    target: CloudDatabaseTarget,
  ): Promise<InfrastructureState | null> {
    return onRds(target.kind)
      ? findRdsState(this.states, target.kind, target.databaseId)
      : this.states.findForRedis(target.databaseId);
  }

  private async rowOf(
    kind: CloudDatabaseKind,
    databaseId: string,
  ): Promise<Postgres | Mysql | Redis | null> {
    if (onRds(kind)) return findRdsRow(this.db, kind, databaseId);
    const [row] = await this.db
      .select()
      .from(redis)
      .where(eq(redis.redisId, databaseId));
    return row ?? null;
  }

  private async writeRecord(
    kind: CloudDatabaseKind,
    databaseId: string,
    record: DatabaseCloudDeleteRecord | null,
    db: Pick<DrizzleDB, 'update'> = this.db,
  ): Promise<Postgres | Mysql | Redis | undefined> {
    if (onRds(kind)) {
      return updateRdsRow(db, kind, databaseId, { cloudDelete: record });
    }
    const [row] = await db
      .update(redis)
      .set({ cloudDelete: record })
      .where(eq(redis.redisId, databaseId))
      .returning();
    return row;
  }
}

/** A cloud database's row as its Delete reads it, or `null` off a Cloud account. */
export function targetOfRow(
  kind: CloudDatabaseKind,
  row: Postgres | Mysql | Redis,
): CloudDatabaseTarget | null {
  if (!row.cloudAccountId || !row.region) return null;
  return {
    kind,
    databaseId: onRds(kind) ? rdsIdOf(row as RdsRow) : (row as Redis).redisId,
    appName: row.appName,
    name: row.name,
    configName: row.configName,
    environmentId: row.environmentId,
    cloudAccountId: row.cloudAccountId,
    region: row.region,
    cloudDelete: row.cloudDelete,
  };
}

/**
 * About how much the final snapshot holds, before it is taken: an RDS
 * instance's allocated storage (what its snapshot is billed by), an
 * ElastiCache node's memory (the most its snapshot can hold).
 */
function estimatedSizeGb(
  kind: CloudDatabaseKind,
  row: Postgres | Mysql | Redis,
): number {
  if (onRds(kind)) {
    const pg = row as RdsRow;
    return pg.rdsApplied?.storageGb ?? pg.storageGb;
  }
  const rd = row as Redis;
  const type =
    ELASTICACHE_NODE_TYPES.types.find((one) => one.name === rd.nodeType) ??
    ELASTICACHE_NODE_TYPES.smallest;
  return Math.round((type.memoryMb / 1024) * 100) / 100;
}

/**
 * About how much a Google database's final backup holds before it is taken
 * a Cloud SQL instance's disk, a Valkey node's writable memory.
 */
function estimatedBackupGb(
  kind: CloudDatabaseKind,
  row: Postgres | Mysql | Redis,
): number {
  if (BACKUP_PRODUCT[kind] === 'cloud-sql') return CLOUD_SQL_DISK_GIB;
  return memorystoreWritableGb((row as Redis).nodeType) ?? 1;
}

/** A Google database's final backup once taken: {@link DatabaseCloudDeleteRecord.backupTaken}. */
type BackupTaken = NonNullable<DatabaseCloudDeleteRecord['backupTaken']>;

/**
 * What the steps before a Google database's destroy did: whether
 * they lifted its deletion protection and took its backup, and, when one
 * failed, why.
 */
type BeforeGoogleDestroy = {
  readonly protectionOff: boolean;
  readonly taken: BackupTaken | null;
} & ({ readonly ok: true } | { readonly ok: false; readonly message: string });

/** Google's status for a backup id already used: the one an earlier run took. */
const ALREADY_EXISTS = 'ALREADY_EXISTS';

/** A port call that got no answer reads as one Google refused, so a step fails rather than throws. */
async function answered<T>(
  call: Promise<GoogleAnswer<T>>,
): Promise<GoogleAnswer<T>> {
  return call.catch((error: unknown) => ({
    ok: false as const,
    code: 'UNREACHABLE',
    message: error instanceof Error ? error.message : String(error),
  }));
}

/** A taken backup as the record keeps it: sized as Google said, else as estimated. */
function takenOf(
  kind: CloudDatabaseKind,
  row: Postgres | Mysql | Redis | null,
  backup: TakenBackup,
): BackupTaken {
  const product = BACKUP_PRODUCT[kind];
  return {
    region: backup.location,
    sizeGb:
      backup.sizeBytes !== null
        ? backupSizeGb(product, backup.sizeBytes)
        : row
          ? estimatedBackupGb(kind, row)
          : 0,
  };
}

/** Every action a plan takes on one address. */
function changesAt(show: TofuShow, address: string): string[] {
  const changes = (show.resource_changes ?? []) as {
    address?: string;
    change?: { actions?: string[] };
  }[];
  return changes
    .filter((one) => one.address === address)
    .flatMap((one) => one.change?.actions ?? []);
}

const ENDED_BEFORE_DESTROYING: TofuFailure = {
  ok: false,
  reason: 'interrupted',
  message: 'The run was ended before it destroyed anything.',
};

/** Said by the apply before the destroy when the state holds nothing to snapshot. */
const NOTHING_TO_SNAPSHOT: TofuFailure = {
  ok: false,
  reason: 'failed',
  message: 'The state holds nothing to snapshot.',
};

function accessOf(account: AwsCloudAccount) {
  return {
    awsAccountId: account.cloudId,
    deployRoleArn: account.deployRoleArn,
    externalId: account.externalId,
  };
}

function refused(message: string): ConflictException {
  return new ConflictException({ message, code: CLOUD_DELETE_REFUSED_CODE });
}

/**
 * What Cloudgate made for an Existing database on Google Cloud, which its
 * Delete destroys: a Cloud SQL postgres's or mysql's endpoint and
 * private DNS zone, a Valkey redis's two endpoints.
 */
function madeForExisting(kind: CloudDatabaseKind): string {
  return kind === 'redis'
    ? "Cloudgate's two endpoints"
    : "Cloudgate's endpoint and private DNS zone";
}
