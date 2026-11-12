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
import type {
  CloudSqlAppliedSettings,
  RdsConsoleSettings,
} from '../../project-config/planner/plan.types';
import { plan } from '../../project-config/project-config.schema';
import type { DatabaseCloudDeleteRecord } from '../common/cloud-database-delete-record';
import type {
  CloudSqlEndpoint,
  RdsEndpoint,
} from '../postgres/postgres.schema';
import type { NativeAwsBlock } from '../../native/aws-native';
import type { NativeGcpBlock } from '../../native/gcp-native';
import { server } from '../../servers/server.schema';

// Same shape as postgres plus the root password — MySQL manages the application
// user and root as separate credentials.
export const mysql = pgTable(
  'mysql',
  {
    mysqlId: nanoidPk('mysql_id'),
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
      .$defaultFn(() => generateAppName('mysql')),
    databaseName: text('database_name').notNull(),
    databaseUser: text('database_user').notNull(),
    databasePassword: encryptedText('database_password').notNull(),
    databaseRootPassword: encryptedText('database_root_password').notNull(),
    description: text('description'),
    dockerImage: text('docker_image').notNull().default('mysql:8.4'),
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
     * A mysql made in a Cloud account (ADR-0035): an RDS for MySQL
     * instance, or a Cloud SQL for MySQL one on Google Cloud, in
     * that account and region, as a postgres on RDS or Cloud SQL is,
     * set together by the Apply that creates it and never changed after.
     * `null` on a Server or the platform host. A Cloud account is never
     * deleted from under it (its Delete is guarded).
     */
    cloudAccountId: text('cloud_account_id').references(
      () => cloudAccount.cloudAccountId,
      { onDelete: 'no action' },
    ),
    region: text('region'),
    /**
     * Cloudgate's own settings of a mysql on RDS, a postgres on RDS's
     * (spec "Schema changes"): never in the config, stored with
     * their defaults and edited on its cloud Database page. `instanceClass`
     * is the class Cloudgate chose for an entry with no size, `null` when
     * the size decides it.
     */
    instanceClass: text('instance_class'),
    storageGb: integer('storage_gb').notNull().default(20),
    maxStorageGb: integer('max_storage_gb').notNull().default(200),
    multiAz: boolean('multi_az').notNull().default(false),
    backupRetentionDays: integer('backup_retention_days').notNull().default(7),
    /** Those settings as the last Apply wrote them; `null` off RDS. */
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
     * The `native.gcp` its config entry last applied on Cloud SQL,
     * as a postgres's. `null` when the entry has none, and off
     * Google Cloud.
     */
    nativeGcp: jsonb('native_gcp').$type<NativeGcpBlock>(),
    /**
     * Where the RDS instance answers inside the Environment network, as its
     * last Cloud run read it: what its wired variables are built
     * from. `null` until the instance is made, and off RDS.
     */
    rdsEndpoint: jsonb('rds_endpoint').$type<RdsEndpoint>(),
    /**
     * Where a mysql's Cloud SQL instance answers, and its own CA, as
     * a postgres's: encrypted, since `ca` is an Output. `null` until
     * the instance is made, and off Cloud SQL.
     */
    cloudSqlEndpoint: encryptedJson<CloudSqlEndpoint>('cloud_sql_endpoint'),
    /**
     * A mysql on Cloud SQL's backups and point-in-time recovery as the last
     * Apply wrote them, as a postgres's. `null`
     * until its create's Apply, and off Cloud SQL.
     */
    cloudSqlApplied:
      jsonb('cloud_sql_applied').$type<CloudSqlAppliedSettings>(),
    /**
     * When AWS starts a mysql on RDS Cloudgate stopped again by itself, as
     * for a postgres: set by Stop, cleared by Start. `null` while it
     * is not stopped, and off RDS.
     */
    restartsAt: text('restarts_at'),
    /**
     * A Delete in its Cloud account under way or incomplete
     * (ADR-0038); see {@link DatabaseCloudDeleteRecord}. `null` otherwise.
     */
    cloudDelete: jsonb('cloud_delete').$type<DatabaseCloudDeleteRecord>(),
  },
  (t) => [
    ...configNameConstraints('mysql', t),
    // A Server (or the platform host) or a Cloud account + region, as a
    // postgres's: the two cloud columns set together, never beside a Server.
    check(
      'mysql_place',
      sql`(${t.cloudAccountId} IS NULL) = (${t.region} IS NULL) AND (${t.cloudAccountId} IS NULL OR ${t.serverId} IS NULL)`,
    ),
  ],
);

export const mysqlRelations = relations(mysql, ({ one }) => ({
  environment: one(environment, {
    fields: [mysql.environmentId],
    references: [environment.environmentId],
  }),
  server: one(server, {
    fields: [mysql.serverId],
    references: [server.serverId],
  }),
}));

export type Mysql = typeof mysql.$inferSelect;
