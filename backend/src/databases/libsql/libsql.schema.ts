import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  json,
  pgEnum,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { applicationStatusEnum } from '../../applications/application.schema';
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
  configNameColumn,
  configNameConstraints,
  encryptedText,
  generateAppName,
  isoTimestamp,
  nanoidPk,
} from '../../db/columns';
import { environment } from '../../environments/environment.schema';
import { server } from '../../servers/server.schema';

// A sqld process is either the primary or a read replica following one.
export const sqldNodeEnum = pgEnum('sqld_node', ['primary', 'replica']);

// sqld node topology plus three published ports (http/grpc/admin). args and
// ulimitsSwarm are kept so the shared base's spec source stays uniform across
// engines.
export const libsql = pgTable(
  'libsql',
  {
    libsqlId: nanoidPk('libsql_id'),
    name: text('name').notNull(),
    /** Fixed key in a Project config; never follows a rename. */
    configName: configNameColumn(),
    appName: text('app_name')
      .notNull()
      .unique()
      .$defaultFn(() => generateAppName('libsql')),
    databaseUser: text('database_user').notNull(),
    databasePassword: encryptedText('database_password').notNull(),
    sqldNode: sqldNodeEnum('sqld_node').notNull().default('primary'),
    sqldPrimaryUrl: text('sqld_primary_url'),
    enableNamespaces: boolean('enable_namespaces').notNull().default(false),
    description: text('description'),
    dockerImage: text('docker_image')
      .notNull()
      .default('ghcr.io/tursodatabase/libsql-server:v0.24.32'),
    command: text('command'),
    args: text('args').array(),
    env: encryptedText('env'),
    memoryReservation: text('memory_reservation'),
    memoryLimit: text('memory_limit'),
    cpuReservation: text('cpu_reservation'),
    cpuLimit: text('cpu_limit'),
    externalPort: integer('external_port'),
    externalGRPCPort: integer('external_grpc_port'),
    externalAdminPort: integer('external_admin_port'),
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
  },
  (t) => configNameConstraints('libsql', t),
);

export const libsqlRelations = relations(libsql, ({ one }) => ({
  environment: one(environment, {
    fields: [libsql.environmentId],
    references: [environment.environmentId],
  }),
  server: one(server, {
    fields: [libsql.serverId],
    references: [server.serverId],
  }),
}));

export type Libsql = typeof libsql.$inferSelect;
