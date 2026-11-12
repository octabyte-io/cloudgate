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
  ElastiCacheConsoleSettings,
  MemorystoreConsoleSettings,
} from '../../project-config/planner/plan.types';
import type { DatabaseCloudDeleteRecord } from '../common/cloud-database-delete-record';
import { plan } from '../../project-config/project-config.schema';
import type { NativeAwsBlock } from '../../native/aws-native';
import type { NativeGcpBlock } from '../../native/gcp-native';
import { server } from '../../servers/server.schema';

/** Where an ElastiCache replication group answers: its primary endpoint. */
export interface ElastiCacheEndpoint {
  readonly host: string;
  readonly port: number;
}

/**
 * Where a Memorystore for Valkey instance answers (spec
 * "Outputs"): its primary endpoint's address on the private link, the
 * port, and its own CA, the `ca` its linked Services are handed.
 */
export interface MemorystoreEndpoint extends ElastiCacheEndpoint {
  /** The instance's CA (`managed_server_ca`), PEM. */
  readonly ca: string;
}

// No per-database identity at all — Redis is a single keyspace guarded by one
// password (`database_password`).
export const redis = pgTable(
  'redis',
  {
    redisId: nanoidPk('redis_id'),
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
      .$defaultFn(() => generateAppName('redis')),
    databasePassword: encryptedText('database_password').notNull(),
    description: text('description'),
    dockerImage: text('docker_image').notNull().default('redis:8'),
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
     * A redis made in a Cloud account (ADR-0035): an ElastiCache for
     * Valkey replication group in that account and region, set together by
     * the plan's Apply that creates it and never changed after. `null` on a
     * Server or the platform host.
     */
    cloudAccountId: text('cloud_account_id').references(
      () => cloudAccount.cloudAccountId,
      { onDelete: 'no action' },
    ),
    region: text('region'),
    /**
     * Cloudgate's own settings of a redis on ElastiCache (spec "Schema
     * changes"), never in the config, stored with their defaults and edited
     * on its cloud Database page. `nodeType` is the type Cloudgate chose for an entry
     * with no size (the smallest), `null` when the size decides it.
     */
    nodeType: text('node_type'),
    replica: boolean('replica').notNull().default(false),
    snapshotRetentionDays: integer('snapshot_retention_days')
      .notNull()
      .default(1),
    /**
     * The replication group's one AUTH token: 64 characters Cloudgate
     * generates when the Apply creates it, encrypted (ADR-0006) and never
     * returned, only `hasAuthToken` (ADR-0019). It is the `password` Output
     * on AWS; `databasePassword` stays the Server's. `null` off ElastiCache.
     */
    authToken: encryptedText('auth_token'),
    /**
     * Where the replication group answers inside the Environment network,
     * as its last Cloud run read it from `tofu`'s outputs: the address its
     * wired variables are built from (ADR-0031). Not a secret. `null` until
     * it is made, and off ElastiCache.
     */
    elasticacheEndpoint: jsonb(
      'elasticache_endpoint',
    ).$type<ElastiCacheEndpoint>(),
    /**
     * Where a Memorystore instance answers, and its CA, as its last
     * Cloud run read them from `tofu`'s outputs: its primary endpoint on the
     * private link, which its wired variables are built from (ADR-0031).
     * `ca` is an Output, and every Output is a secret, so the
     * whole is kept encrypted (ADR-0006). `null` until the instance is made,
     * and off Memorystore.
     */
    memorystoreEndpoint: encryptedJson<MemorystoreEndpoint>(
      'memorystore_endpoint',
    ),
    /**
     * A redis on Memorystore's high availability (spec "Schema
     * changes"): Cloudgate's own setting, never in the config, off by
     * default and edited on its cloud Database page. On, the instance has
     * one replica in another zone (`replica_count = 1`), two nodes. Applied
     * by the next plan's Apply. Unused off Memorystore.
     */
    memorystoreHighAvailability: boolean('memorystore_high_availability')
      .notNull()
      .default(false),
    /**
     * A redis on Memorystore's backup retention (spec "Schema
     * changes"): Cloudgate's own setting, never in the config, edited on
     * its Backups tab. How many days each daily automated backup is kept,
     * 0 (off) to 365; 1 by default. Applied by the next plan's Apply, which
     * records it in `memorystoreApplied`. Unused off Memorystore.
     */
    memorystoreBackupRetentionDays: integer('memorystore_backup_retention_days')
      .notNull()
      .default(1),
    /**
     * That setting as the last Apply wrote it to the instance, so an
     * edit on the cloud Database page plans as a change until the next
     * Apply makes it. `null` off Memorystore.
     */
    memorystoreApplied: jsonb(
      'memorystore_applied',
    ).$type<MemorystoreConsoleSettings>(),
    /**
     * The `engine_version` a redis on Memorystore runs, `VALKEY_9_1`:
     * the one its create's plan read and its Apply made it with, moved only
     * by an Apply of a planned version change. A version naming only its
     * major keeps the minor it was made on, so a newer minor Google offers
     * later is never written by a resize or a high availability Apply.
     * `null` off Memorystore, and on one made before this setting (read from its
     * written version, as then).
     */
    memorystoreEngineVersion: text('memorystore_engine_version'),
    /**
     * Those settings as the last Apply wrote them to the replication group
     * so an edit on the cloud Database page plans as a change until
     * the next Apply makes it. `null` off ElastiCache.
     */
    elasticacheApplied: jsonb(
      'elasticache_applied',
    ).$type<ElastiCacheConsoleSettings>(),
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
     * written, on Memorystore: as {@link nativeAws} is on AWS, a console-owned
     * value in it written to its console column too. `null` when the entry
     * has none, and off Google Cloud.
     */
    nativeGcp: jsonb('native_gcp').$type<NativeGcpBlock>(),
    /**
     * A Delete in its Cloud account under way or incomplete
     * (ADR-0038); see {@link DatabaseCloudDeleteRecord}. `null` otherwise.
     */
    cloudDelete: jsonb('cloud_delete').$type<DatabaseCloudDeleteRecord>(),
  },
  (t) => [
    ...configNameConstraints('redis', t),
    // A Server (or the platform host) or a Cloud account + region: the two
    // cloud columns are set together, and never beside a Server.
    check(
      'redis_place',
      sql`(${t.cloudAccountId} IS NULL) = (${t.region} IS NULL) AND (${t.cloudAccountId} IS NULL OR ${t.serverId} IS NULL)`,
    ),
  ],
);

export const redisRelations = relations(redis, ({ one }) => ({
  environment: one(environment, {
    fields: [redis.environmentId],
    references: [environment.environmentId],
  }),
  server: one(server, {
    fields: [redis.serverId],
    references: [server.serverId],
  }),
}));

export type Redis = typeof redis.$inferSelect;
