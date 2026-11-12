import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  json,
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

// No separate database name — the root user owns the whole server — plus
// replicaSets, which switches the deploy to a single-node replica-set
// bootstrap.
export const mongo = pgTable(
  'mongo',
  {
    mongoId: nanoidPk('mongo_id'),
    name: text('name').notNull(),
    /** Fixed key in a Project config; never follows a rename. */
    configName: configNameColumn(),
    appName: text('app_name')
      .notNull()
      .unique()
      .$defaultFn(() => generateAppName('mongo')),
    databaseUser: text('database_user').notNull(),
    databasePassword: encryptedText('database_password').notNull(),
    description: text('description'),
    dockerImage: text('docker_image').notNull().default('mongo:8'),
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
    replicaSets: boolean('replica_sets').notNull().default(false),
    createdAt: isoTimestamp('created_at'),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.environmentId, { onDelete: 'cascade' }),
    serverId: text('server_id').references(() => server.serverId, {
      onDelete: 'cascade',
    }),
  },
  (t) => configNameConstraints('mongo', t),
);

export const mongoRelations = relations(mongo, ({ one }) => ({
  environment: one(environment, {
    fields: [mongo.environmentId],
    references: [environment.environmentId],
  }),
  server: one(server, {
    fields: [mongo.serverId],
    references: [server.serverId],
  }),
}));

export type Mongo = typeof mongo.$inferSelect;
