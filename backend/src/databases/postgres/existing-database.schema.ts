import { relations, sql } from 'drizzle-orm';
import { boolean, check, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { cloudAccount } from '../../cloud-accounts/cloud-account.schema';
import type { PscConnectionStatus } from '../../cloud-accounts/google-cloud.port';
import { encryptedText, nanoidPk } from '../../db/columns';
import { mysql } from '../mysql/mysql.schema';
import { redis } from '../redis/redis.schema';
import { postgres } from './postgres.schema';
import type { RdsEndpoint } from './postgres.schema';

/**
 * An existing Cloud SQL's endpoint as its last read found it: its
 * `pscConnectionStatus`, or `NOT_FOUND` once Google no longer has it.
 */
export type ExistingEndpointStatus = PscConnectionStatus | 'NOT_FOUND';

/** One of the manual endpoints Cloudgate made for an existing Valkey. */
export interface ExistingEndpoint {
  readonly endpoint: 'primary' | 'reader';
  /** Its address's and forwarding rule's name. */
  readonly name: string;
  readonly address: string;
  readonly pscConnectionId: string;
  readonly serviceAttachment: string;
}

/**
 * An **Existing database** (ADR-0033): the third place of a Database
 * Service, beside a Server and a Cloud account (ADR-0035). The postgres row
 * it belongs to is a Service like any other — a plan matches it by Config
 * name, it hands out Outputs, it has a page and a Delete — and its login
 * columns hold the login the apps use (`databaseUser`, the encrypted
 * `databasePassword`, `databaseName`), typed by the operator and returned
 * only as "set". What makes it existing is this row: Cloudgate only reads
 * the database it names, and never changes it.
 *
 * - `cloudAccountId` and `region` are the Environment's Deploy target's when
 *   it was created, fixed for its life (ADR-0035): the lookup always runs
 *   there. No action on delete, so a Cloud account is never deleted from
 *   under it (its Delete is guarded).
 * - `postgresId`, `mysqlId` or `redisId`, exactly one: the Service
 *   it is the place of. A mysql's is an RDS for MySQL instance.
 *   A redis's is a node-based ElastiCache replication group with cluster
 *   mode off, whose AUTH token is the redis row's own encrypted
 *   `authToken`, returned only as `hasAuthToken`.
 * - `identifier` is the RDS instance's identifier (`acme-prod`), or the
 *   replication group's id.
 * - `tls` is a redis's TLS on/off, on by default: whether its Outputs
 *   are `rediss://` with a `ca`, or `redis://` with none. Always on for a
 *   postgres, whose lookup ignores it.
 * - `madeReachable` is the operator's "I made it reachable from this
 *   Environment" tick, which a database outside the Environment network's
 *   VPC needs, and which Cloudgate cannot check.
 * - `address` is where the last plan's lookup found it; deploys build its
 *   Outputs from it. `null` until a lookup has found it. A lookup that
 *   finds it at another host or port leaves it as it was: that plan's
 *   Apply saves the new one, then redeploys what links to it.
 * - `notFoundAt` is when a plan's lookup last found nothing under
 *   `identifier`, so its page says "AWS cannot find `acme-prod`";
 *   `null` once a lookup finds it again.
 *
 * On Google Cloud (ADR-0033 as amended) only a postgres's is
 * made: a Cloud SQL instance, reached through Cloudgate's own Private
 * Service Connect endpoint and private DNS zone, in the postgres's own
 * Infrastructure state. There:
 *
 * - `identifier` is its connection name, `project:region:instance`;
 *   `madeReachable` is never asked for, since Cloudgate checks the reach;
 * - `address` is its `….sql.goog.` name exactly as Google reports it,
 *   trailing dot included, and Postgres's port;
 * - `ca` is the server CA the instance reports, encrypted as every Output
 *   is (ADR-0006), and `foundCa` one a later lookup found in its place,
 *   which that plan's Apply saves as `ca` before it redeploys what links to
 *   it, as an address is;
 * - `serviceAttachment` is what the last lookup found the endpoint must
 *   point at, which the endpoint's Cloud run writes;
 * - `endpointStatus` is the endpoint's `pscConnectionStatus` as last read
 *   (after its Cloud run, and at each plan), `null` until one was made; the
 *   page says when it is not `ACCEPTED`, and `endpointCheckedAt` when.
 *
 * A redis's on Google Cloud is a Memorystore for Valkey instance
 * with cluster mode off, reached through Cloudgate's own two manual
 * endpoints, in the redis's own Infrastructure state. There:
 *
 * - `identifier` is its name, `project/region/instance`;
 * - `tls` and `ca` are read from the instance at every plan, never typed;
 * - `serviceAttachments` is what the last lookup found the two endpoints
 *   must point at, its primary's and its reader's;
 * - `endpoints` is what the endpoints' Cloud run made — each one's address,
 *   forwarding rule and connection id, which the page's `--add-endpoints`
 *   command names — and `address` is the primary's, with Valkey's port;
 * - `registrationStatus` is `waiting` until a read (after the run, and at
 *   each plan) finds both endpoints registered on the instance, then
 *   `registered`; `null` until they are made. `endpointCheckedAt` is when.
 */
export const existingDatabase = pgTable(
  'existing_database',
  {
    existingDatabaseId: nanoidPk('existing_database_id'),
    postgresId: text('postgres_id')
      .unique()
      .references(() => postgres.postgresId, { onDelete: 'cascade' }),
    mysqlId: text('mysql_id')
      .unique()
      .references(() => mysql.mysqlId, { onDelete: 'cascade' }),
    redisId: text('redis_id')
      .unique()
      .references(() => redis.redisId, { onDelete: 'cascade' }),
    cloudAccountId: text('cloud_account_id')
      .notNull()
      .references(() => cloudAccount.cloudAccountId, {
        onDelete: 'no action',
      }),
    region: text('region').notNull(),
    identifier: text('identifier').notNull(),
    madeReachable: boolean('made_reachable').notNull().default(false),
    tls: boolean('tls').notNull().default(true),
    address: jsonb('address').$type<RdsEndpoint>(),
    notFoundAt: text('not_found_at'),
    ca: encryptedText('ca'),
    foundCa: encryptedText('found_ca'),
    serviceAttachment: text('service_attachment'),
    endpointStatus: text('endpoint_status').$type<ExistingEndpointStatus>(),
    endpointCheckedAt: text('endpoint_checked_at'),
    serviceAttachments: jsonb('service_attachments').$type<{
      readonly primary: string;
      readonly reader: string;
    }>(),
    endpoints: jsonb('endpoints').$type<ExistingEndpoint[]>(),
    registrationStatus: text('registration_status').$type<
      'waiting' | 'registered'
    >(),
  },
  (t) => [
    // The place of exactly one Service: a postgres, a mysql or a
    // redis.
    check(
      'existing_database_one_service',
      sql`num_nonnulls(${t.postgresId}, ${t.mysqlId}, ${t.redisId}) = 1`,
    ),
  ],
);

export const existingDatabaseRelations = relations(
  existingDatabase,
  ({ one }) => ({
    postgres: one(postgres, {
      fields: [existingDatabase.postgresId],
      references: [postgres.postgresId],
    }),
    mysql: one(mysql, {
      fields: [existingDatabase.mysqlId],
      references: [mysql.mysqlId],
    }),
    redis: one(redis, {
      fields: [existingDatabase.redisId],
      references: [redis.redisId],
    }),
  }),
);

export type ExistingDatabase = typeof existingDatabase.$inferSelect;
