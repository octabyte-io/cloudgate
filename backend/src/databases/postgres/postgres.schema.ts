import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  integer,
  json,
  jsonb,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { applicationStatusEnum } from '../../applications/application.schema';
import { cloudAccount } from '../../cloud-accounts/cloud-account.schema';
import type {
  EndpointSpecSwarm,
  HealthCheckSwarm,
  LabelsSwarm,
  NetworkSwarm,
  PlacementSwarm,
  RestartPolicySwarm,
  ServiceModeSwarm,
  UlimitsSwarm,
  UpdateConfigSwarm,
} from '../../applications/swarm.types';
import {
  configLinksColumn,
  wiredChangedAtColumn,
  configNameColumn,
  configNameConstraints,
  encryptedJson,
  encryptedText,
  generateAppName,
  isoTimestamp,
  nanoidPk,
} from '../../db/columns';
import { environment } from '../../environments/environment.schema';
import type { DatabaseCloudDeleteRecord } from '../common/cloud-database-delete-record';
import type {
  CloudSqlAppliedSettings,
  RdsConsoleSettings,
} from '../../project-config/planner/plan.types';
import { plan } from '../../project-config/project-config.schema';
import type { NativeAwsBlock } from '../../native/aws-native';
import type { NativeGcpBlock } from '../../native/gcp-native';
import { server } from '../../servers/server.schema';

/** Where an RDS instance answers: its address and port. */
export interface RdsEndpoint {
  readonly host: string;
  readonly port: number;
}

/**
 * Where a Cloud SQL instance answers (spec "Outputs"): its own
 * Private Service Connect DNS name, never the endpoint's IP, so a full
 * certificate check passes; the port; and its own server CA, the `ca` its
 * linked Services are handed. `ca` is an Output, and every Output is a
 * secret, so the whole is kept encrypted (ADR-0006).
 */
export interface CloudSqlEndpoint extends RdsEndpoint {
  /** The instance's own CA (`server_ca_cert`), PEM. */
  readonly ca: string;
}

// The first managed database engine. Mount rows (Phase 33) don't exist yet —
// the data volume is derived from the appName at deploy time instead.
export const postgres = pgTable(
  'postgres',
  {
    postgresId: nanoidPk('postgres_id'),
    name: text('name').notNull(),
    /** Fixed key in a Project config; never follows a rename. */
    configName: configNameColumn(),
    /**
     * The Plan that last wrote this Service's config-owned fields;
     * `null` for one no plan has written. A locked field shows it.
     */
    configPlanId: text('config_plan_id').references(() => plan.planId, {
      onDelete: 'set null',
    }),
    /** The wired variables its config entry last applied. */
    configLinks: configLinksColumn(),
    /** When a linked source's Output last changed outside a plan. */
    wiredChangedAt: wiredChangedAtColumn(),
    appName: text('app_name')
      .notNull()
      .unique()
      .$defaultFn(() => generateAppName('postgres')),
    databaseName: text('database_name').notNull(),
    databaseUser: text('database_user').notNull(),
    databasePassword: encryptedText('database_password').notNull(),
    description: text('description'),
    dockerImage: text('docker_image').notNull().default('postgres:18'),
    command: text('command'),
    args: text('args').array(),
    env: encryptedText('env'),
    memoryReservation: text('memory_reservation'),
    memoryLimit: text('memory_limit'),
    cpuReservation: text('cpu_reservation'),
    cpuLimit: text('cpu_limit'),
    externalPort: integer('external_port'),
    applicationStatus: applicationStatusEnum('application_status')
      .notNull()
      .default('idle'),
    // Docker swarm service-spec overrides, same shape as application
    healthCheckSwarm: json('health_check_swarm').$type<HealthCheckSwarm>(),
    restartPolicySwarm: json(
      'restart_policy_swarm',
    ).$type<RestartPolicySwarm>(),
    placementSwarm: json('placement_swarm').$type<PlacementSwarm>(),
    updateConfigSwarm: json('update_config_swarm').$type<UpdateConfigSwarm>(),
    rollbackConfigSwarm: json(
      'rollback_config_swarm',
    ).$type<UpdateConfigSwarm>(),
    modeSwarm: json('mode_swarm').$type<ServiceModeSwarm>(),
    labelsSwarm: json('labels_swarm').$type<LabelsSwarm>(),
    networkSwarm: json('network_swarm').$type<NetworkSwarm[]>(),
    stopGracePeriodSwarm: bigint('stop_grace_period_swarm', { mode: 'number' }),
    endpointSpecSwarm: json('endpoint_spec_swarm').$type<EndpointSpecSwarm>(),
    ulimitsSwarm: json('ulimits_swarm').$type<UlimitsSwarm>(),
    replicas: integer('replicas').notNull().default(1),
    createdAt: isoTimestamp('created_at'),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.environmentId, { onDelete: 'cascade' }),
    serverId: text('server_id').references(() => server.serverId, {
      onDelete: 'cascade',
    }),
    /**
     * A postgres made in a Cloud account (ADR-0035): an RDS instance
     * in that account and region, set together by the plan's Apply that
     * creates it and never changed after. `null` on a Server or the platform
     * host. Leaves room for a third place, an existing database. A
     * Cloud account is never deleted from under it (its Delete is guarded).
     */
    cloudAccountId: text('cloud_account_id').references(
      () => cloudAccount.cloudAccountId,
      { onDelete: 'no action' },
    ),
    region: text('region'),
    /**
     * Cloudgate's own settings of a postgres on RDS (spec "Schema
     * changes"), never in the config, stored with their defaults; editing
     * them is the cloud Database page's. `instanceClass` is the class Cloudgate chose for an
     * entry with no size (the smallest), `null` when the size decides it.
     * On Cloud SQL it is the machine the instance is made on,
     * whatever decided it, saved by every Apply that makes or moves it: the
     * one its Cloud runs write.
     */
    instanceClass: text('instance_class'),
    storageGb: integer('storage_gb').notNull().default(20),
    maxStorageGb: integer('max_storage_gb').notNull().default(200),
    multiAz: boolean('multi_az').notNull().default(false),
    backupRetentionDays: integer('backup_retention_days').notNull().default(7),
    /**
     * Those settings as the last Apply wrote them to the instance,
     * so an edit on the cloud Database page plans as a change until the
     * next Apply makes it. `null` off RDS.
     */
    rdsApplied: jsonb('rds_applied').$type<RdsConsoleSettings>(),
    /**
     * The `native.aws` its config entry last applied (ADR-0044), as
     * written: the next plan compares the entry's against it, and each
     * Cloud run lays it over Cloudgate's definition. Never a record of
     * anything Cloudgate writes itself (ADR-0029); a console-owned value in
     * it is written to its console column too. `null` when the entry has
     * none, and off AWS.
     */
    nativeAws: jsonb('native_aws').$type<NativeAwsBlock>(),
    /**
     * The `native.gcp` its config entry last applied (ADR-0044), as
     * written, on Cloud SQL: as {@link nativeAws} is on AWS, a console-owned
     * value in it written to its console column too. `null` when the entry
     * has none, and off Google Cloud.
     */
    nativeGcp: jsonb('native_gcp').$type<NativeGcpBlock>(),
    /**
     * Where the RDS instance answers inside the Environment network, as its
     * last Cloud run that made or changed it read it from `tofu`'s outputs
     * the address its wired variables are built from (ADR-0031).
     * Not a secret, and no Output's value is kept beside it. `null` until
     * the instance is made, and off RDS.
     */
    rdsEndpoint: jsonb('rds_endpoint').$type<RdsEndpoint>(),
    /**
     * Where a Cloud SQL instance answers, and its CA, as its last
     * Cloud run read them from `tofu`'s outputs: what its wired variables
     * are built from (ADR-0031). `null` until the instance is made, and off
     * Cloud SQL.
     */
    cloudSqlEndpoint: encryptedJson<CloudSqlEndpoint>('cloud_sql_endpoint'),
    /**
     * A postgres on Cloud SQL's backup retention, and whether
     * point-in-time recovery is on (absent is on), as the last Apply
     * wrote them to the instance: `backupRetentionDays` above is its
     * Backups tab's setting (1–365 on Cloud SQL), so an edit there plans as
     * a change until the next Apply makes it. `null` on one made before
     * Cloud SQL backups, whose definition writes none until its catch-up,
     * and off Cloud SQL.
     */
    cloudSqlApplied:
      jsonb('cloud_sql_applied').$type<CloudSqlAppliedSettings>(),
    /**
     * The stop record of a postgres on RDS: when AWS starts the
     * instance again by itself, seven days after Cloudgate's Stop, as an ISO
     * time. Set beside `stopped` by Stop and cleared by Start; once it has
     * passed, the instance reads "Started again by AWS" and nothing waits on
     * it (`rds-stop.ts`). Cloudgate never stops it again by itself. `null`
     * while it is not stopped, and off RDS.
     */
    restartsAt: text('restarts_at'),
    /**
     * A Delete in its Cloud account under way or incomplete
     * (ADR-0038); see {@link DatabaseCloudDeleteRecord}. `null` otherwise.
     */
    cloudDelete: jsonb('cloud_delete').$type<DatabaseCloudDeleteRecord>(),
  },
  (t) => [
    ...configNameConstraints('postgres', t),
    // A Server (or the platform host) or a Cloud account + region: the two
    // cloud columns are set together, and never beside a Server.
    check(
      'postgres_place',
      sql`(${t.cloudAccountId} IS NULL) = (${t.region} IS NULL) AND (${t.cloudAccountId} IS NULL OR ${t.serverId} IS NULL)`,
    ),
  ],
);

export const postgresRelations = relations(postgres, ({ one }) => ({
  environment: one(environment, {
    fields: [postgres.environmentId],
    references: [environment.environmentId],
  }),
  server: one(server, {
    fields: [postgres.serverId],
    references: [server.serverId],
  }),
}));

export type Postgres = typeof postgres.$inferSelect;
