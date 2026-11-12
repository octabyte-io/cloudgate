import { relations } from 'drizzle-orm';
import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { isoTimestamp, nanoidPk } from '../db/columns';
import { server } from '../servers/server.schema';

/**
 * The metrics store: one store for every host, keyed by a server FK (cascade
 * — a deleted server takes its samples with it). Timestamps are RFC3339 text,
 * so samples are ordered and windowed by string comparison; the container
 * record body is one JSON blob.
 *
 * `serverId` is nullable, and null is the *web server* — the instance's own
 * machine, which has no `server` row. That is the `serverId: null` convention
 * the docker, traefik and forward-auth code already reads as "this machine",
 * and it is what lets the config `POST /admin/setup-monitoring` stores drive a
 * real collection job instead of nothing at all. The composite
 * indexes still serve those reads: Postgres btrees index NULLs, so
 * `server_id IS NULL AND timestamp …` is the same range scan a Server gets.
 */
export const serverMetric = pgTable(
  'server_metric',
  {
    serverMetricId: nanoidPk('server_metric_id'),
    timestamp: text('timestamp').notNull(),
    cpu: doublePrecision('cpu').notNull(),
    cpuModel: text('cpu_model').notNull(),
    cpuCores: integer('cpu_cores').notNull(),
    cpuPhysicalCores: integer('cpu_physical_cores').notNull(),
    cpuSpeed: doublePrecision('cpu_speed').notNull(),
    os: text('os').notNull(),
    distro: text('distro').notNull(),
    kernel: text('kernel').notNull(),
    arch: text('arch').notNull(),
    memUsed: doublePrecision('mem_used').notNull(),
    memUsedGB: doublePrecision('mem_used_gb').notNull(),
    memTotal: doublePrecision('mem_total').notNull(),
    uptime: bigint('uptime', { mode: 'number' }).notNull(),
    diskUsed: doublePrecision('disk_used').notNull(),
    totalDisk: doublePrecision('total_disk').notNull(),
    networkIn: doublePrecision('network_in').notNull(),
    networkOut: doublePrecision('network_out').notNull(),
    createdAt: isoTimestamp('created_at'),
    /** Null means the web server — the instance's own machine. */
    serverId: text('server_id').references(() => server.serverId, {
      onDelete: 'cascade',
    }),
  },
  (table) => [
    index('server_metric_server_timestamp_idx').on(
      table.serverId,
      table.timestamp,
    ),
  ],
);

export const containerMetric = pgTable(
  'container_metric',
  {
    containerMetricId: nanoidPk('container_metric_id'),
    timestamp: text('timestamp').notNull(),
    containerId: text('container_id').notNull(),
    containerName: text('container_name').notNull(),
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull(),
    createdAt: isoTimestamp('created_at'),
    /** Null means the web server — the instance's own machine. */
    serverId: text('server_id').references(() => server.serverId, {
      onDelete: 'cascade',
    }),
  },
  (table) => [
    // Per-host lookups by timestamp and by container name.
    index('container_metric_server_timestamp_idx').on(
      table.serverId,
      table.timestamp,
    ),
    index('container_metric_server_name_idx').on(
      table.serverId,
      table.containerName,
    ),
  ],
);

export const serverMetricRelations = relations(serverMetric, ({ one }) => ({
  server: one(server, {
    fields: [serverMetric.serverId],
    references: [server.serverId],
  }),
}));

export const containerMetricRelations = relations(
  containerMetric,
  ({ one }) => ({
    server: one(server, {
      fields: [containerMetric.serverId],
      references: [server.serverId],
    }),
  }),
);

export type ServerMetric = typeof serverMetric.$inferSelect;
export type ContainerMetric = typeof containerMetric.$inferSelect;
