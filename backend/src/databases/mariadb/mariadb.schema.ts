import { relations } from 'drizzle-orm';
import { bigint, integer, json, pgTable, text } from 'drizzle-orm/pg-core';
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

// Same shape as mysql — MariaDB keeps the separate application-user and root
// credentials too.
export const mariadb = pgTable(
  'mariadb',
  {
    mariadbId: nanoidPk('mariadb_id'),
    name: text('name').notNull(),
    /** Fixed key in a Project config; never follows a rename. */
    configName: configNameColumn(),
    appName: text('app_name')
      .notNull()
      .unique()
      .$defaultFn(() => generateAppName('mariadb')),
    databaseName: text('database_name').notNull(),
    databaseUser: text('database_user').notNull(),
    databasePassword: encryptedText('database_password').notNull(),
    databaseRootPassword: encryptedText('database_root_password').notNull(),
    description: text('description'),
    // MariaDB's published majors are 10.x and 11.x — there is no `mariadb:6`
    // tag to pull, so the default has to name a real one (matches the image the
    // frontend's create form prefills).
    dockerImage: text('docker_image').notNull().default('mariadb:11'),
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
  },
  (t) => configNameConstraints('mariadb', t),
);

export const mariadbRelations = relations(mariadb, ({ one }) => ({
  environment: one(environment, {
    fields: [mariadb.environmentId],
    references: [environment.environmentId],
  }),
  server: one(server, {
    fields: [mariadb.serverId],
    references: [server.serverId],
  }),
}));

export type Mariadb = typeof mariadb.$inferSelect;
