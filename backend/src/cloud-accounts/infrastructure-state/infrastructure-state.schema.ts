import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  pgSchema,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { application } from '../../applications/application.schema';
import { bucket } from '../../buckets/bucket.schema';
import { compose } from '../../compose/compose.schema';
import { mysql } from '../../databases/mysql/mysql.schema';
import { postgres } from '../../databases/postgres/postgres.schema';
import { redis } from '../../databases/redis/redis.schema';
import { isoTimestamp, nanoidPk } from '../../db/columns';
import { environmentNetwork } from '../../environments/environment-network.schema';
import { INFRASTRUCTURE_STATE_SCHEMA } from '../definitions/tofu-json';
import type { StateProvider } from './state-versions';

/**
 * Where every **Infrastructure state** lives (ADR-0036, the AWS spec): OpenTofu's
 * `pg` backend, in a schema of its own that only the state login reaches.
 *
 * Cloudgate's migrations make the schema and the table, and every definition
 * sets `skip_schema_creation`, `skip_table_creation` and
 * `skip_index_creation`, so `tofu` — and the state login, which may create
 * nothing — never runs DDL. The table is exactly what OpenTofu 1.13's
 * backend would have made (`internal/backend/remote-state/pg/backend.go`):
 * `id`, `name` (the workspace, which is the state's id), `data` (the state,
 * encrypted whole by OpenTofu before it arrives), and the `states_by_name`
 * index. One difference: OpenTofu puts its id sequence in `public`, which the
 * state login must not reach, so it is here instead; the backend only ever
 * reads the column's default, never names the sequence.
 *
 * The shape is OpenTofu's, so this table keeps its bare `id` and plural name
 * rather than Cloudgate's conventions (CODING_STANDARDS §2.6). Cloudgate's
 * own code never reads or writes it — no route, tool or service hands out a
 * raw state — save to delete a state's row once everything in it is
 * destroyed; it is declared here so the migrations make it.
 */
export const infrastructureStateSchema = pgSchema(INFRASTRUCTURE_STATE_SCHEMA);

export const infrastructureStateIdSequence = infrastructureStateSchema.sequence(
  'global_states_id_seq',
);

export const tofuStates = infrastructureStateSchema.table(
  'states',
  {
    id: bigint('id', { mode: 'number' })
      .primaryKey()
      .default(
        sql`nextval('${sql.raw(INFRASTRUCTURE_STATE_SCHEMA)}.global_states_id_seq')`,
      ),
    name: text('name').unique('states_name_key'),
    data: text('data'),
  },
  (table) => [uniqueIndex('states_by_name').on(table.name)],
);

/**
 * Cloudgate's own row for each Infrastructure state: what owns it,
 * what last wrote it and whether it can still be read. **No history is
 * kept**: each write replaces the versions.
 *
 * - `infrastructureStateId` is also the state's OpenTofu workspace, so the
 *   row and the `states` row it describes share one name. The `states` row
 *   appears on the state's first run and may be missing for a row that has
 *   never run, or after an older backup is restored — a run then starts
 *   empty and adopts by tag (the AWS spec, "Recovery by tag").
 * - The owner is a cloud Service (`applicationId`, `postgresId` for an RDS
 *   postgres, `mysqlId` for an RDS mysql, `redisId` for an ElastiCache redis,
 *   `bucketId` for an S3 bucket, or `composeId` for a Compose stack's
 *   Stack VM) or an Environment network
 *   (`environmentNetworkId`), exactly one.
 * - `provider` is the provider the state is written with, `aws` or
 *   `google` (the Google Cloud spec); every state made before Google Cloud is `aws`.
 * - `tofuVersion` and `providerVersion` are the OpenTofu and that provider
 *   that last wrote the state; null until its first apply. A newer pair than
 *   the install's pins for that provider is refused, naming both and saying
 *   to upgrade Cloudgate; an older one is brought forward by the next write.
 * - `readable` turns false when a run cannot decrypt or read the state, which
 *   then fails every run, naming it, until Rebuild from the cloud.
 */
export const infrastructureState = pgTable(
  'infrastructure_state_record',
  {
    infrastructureStateId: nanoidPk('infrastructure_state_id'),
    applicationId: text('application_id').references(
      () => application.applicationId,
      { onDelete: 'cascade' },
    ),
    /**
     * No action on delete: a network's state goes only once everything in
     * it is destroyed (ADR-0036), so its row is removed with the state,
     * never under it.
     */
    environmentNetworkId: text('environment_network_id').references(
      () => environmentNetwork.environmentNetworkId,
      { onDelete: 'no action' },
    ),
    /**
     * No action on delete, like the network's: an RDS instance's state goes
     * only once its instance is destroyed (ADR-0036), never under it.
     */
    postgresId: text('postgres_id').references(() => postgres.postgresId, {
      onDelete: 'no action',
    }),
    /**
     * A bucket on AWS's. No action on delete, like an RDS instance's:
     * the state goes only once its bucket is destroyed or kept.
     */
    bucketId: text('bucket_id').references(() => bucket.bucketId, {
      onDelete: 'no action',
    }),
    /** No action on delete, as a postgres's: an RDS mysql's. */
    mysqlId: text('mysql_id').references(() => mysql.mysqlId, {
      onDelete: 'no action',
    }),
    /** No action on delete, as a postgres's: an ElastiCache redis's. */
    redisId: text('redis_id').references(() => redis.redisId, {
      onDelete: 'no action',
    }),
    /**
     * No action on delete, as a postgres's: a Compose stack's Stack VM
     * (ADR-0070). Its state goes only once everything in it is gone.
     */
    composeId: text('compose_id').references(() => compose.composeId, {
      onDelete: 'no action',
    }),
    provider: text('provider').$type<StateProvider>().notNull().default('aws'),
    tofuVersion: text('tofu_version'),
    providerVersion: text('provider_version'),
    readable: boolean('readable').notNull().default(true),
    createdAt: isoTimestamp('created_at'),
  },
  (table) => [
    check(
      'infrastructure_state_record_one_owner',
      sql`num_nonnulls(${table.applicationId}, ${table.environmentNetworkId}, ${table.postgresId}, ${table.mysqlId}, ${table.bucketId}, ${table.redisId}, ${table.composeId}) = 1`,
    ),
    uniqueIndex('infrastructure_state_record_compose_unique').on(
      table.composeId,
    ),
    uniqueIndex('infrastructure_state_record_mysql_unique').on(table.mysqlId),
    uniqueIndex('infrastructure_state_record_bucket_unique').on(table.bucketId),
    uniqueIndex('infrastructure_state_record_redis_unique').on(table.redisId),
    uniqueIndex('infrastructure_state_record_postgres_unique').on(
      table.postgresId,
    ),
    uniqueIndex('infrastructure_state_record_application_unique').on(
      table.applicationId,
    ),
    uniqueIndex('infrastructure_state_record_environment_network_unique').on(
      table.environmentNetworkId,
    ),
  ],
);

export const infrastructureStateRelations = relations(
  infrastructureState,
  ({ one }) => ({
    application: one(application, {
      fields: [infrastructureState.applicationId],
      references: [application.applicationId],
    }),
    environmentNetwork: one(environmentNetwork, {
      fields: [infrastructureState.environmentNetworkId],
      references: [environmentNetwork.environmentNetworkId],
    }),
    postgres: one(postgres, {
      fields: [infrastructureState.postgresId],
      references: [postgres.postgresId],
    }),
    mysql: one(mysql, {
      fields: [infrastructureState.mysqlId],
      references: [mysql.mysqlId],
    }),
    bucket: one(bucket, {
      fields: [infrastructureState.bucketId],
      references: [bucket.bucketId],
    }),
    redis: one(redis, {
      fields: [infrastructureState.redisId],
      references: [redis.redisId],
    }),
    compose: one(compose, {
      fields: [infrastructureState.composeId],
      references: [compose.composeId],
    }),
  }),
);

export type InfrastructureState = typeof infrastructureState.$inferSelect;
