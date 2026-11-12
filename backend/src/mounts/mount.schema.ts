import { relations, sql } from 'drizzle-orm';
import { check, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import {
  application,
  serviceTypeEnum,
} from '../applications/application.schema';
import type { WorkloadServiceType } from '../applications/application.schema';
import { compose } from '../compose/compose.schema';
import { libsql } from '../databases/libsql/libsql.schema';
import { mariadb } from '../databases/mariadb/mariadb.schema';
import { mongo } from '../databases/mongo/mongo.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import { redis } from '../databases/redis/redis.schema';
import { encryptedText, nanoidPk } from '../db/columns';

// One polymorphic table for volume, bind and file mounts, discriminated by
// serviceType with a nullable FK per owner. serviceTypeEnum itself lives with
// the application schema (Phase 26 note).

export const mountTypeEnum = pgEnum('mount_type', ['bind', 'volume', 'file']);

export type MountType = (typeof mountTypeEnum.enumValues)[number];

/**
 * The parent that is set is the one `serviceType` names, as a database fact
 * (the shape an earlier sweep found and left alone).
 *
 * **Two clauses, and the second is the one worth having.** `num_nonnulls(…) =
 * 1` alone would be the eight-`IS NULL`-terms constraint offered as the
 * alternative, and it says only *"no more than one owner"*. The `CASE` says
 * the rule this table actually runs on: `MountsService`' `serviceIdOf` reads
 * `row[MOUNT_FK_FIELD[row.serviceType]]` and nothing else, so the discriminant
 * — not the set column — is what decides which Service a mount is
 * access-checked against, materialized on, and deleted with. A row whose
 * `service_type` says `application` while only `postgres_id` is set passes
 * "at most one" and is still unreadable: `serviceIdOf` throws
 * `NotFoundException('Mount has no owning service')` for it, while
 * `listByService` — which keys off the raw column, not the discriminant —
 * happily lists it under the Postgres engine. The `CASE` is what makes those
 * two agree.
 *
 * **What it costs, named because it is a real closure.** The eight arms are
 * every value of `service_type`, so adding a ninth service kind means a
 * migration that replaces this constraint as well as one that adds the column.
 * That is the trade asked for: a constraint stating the rule, rather than
 * one stating a weaker rule that never needs touching.
 *
 * **No `mount` row has ever been able to disagree with its discriminant**, so
 * the migration's normalization is a repair for a state only a hand-run
 * `UPDATE` could have produced, not for one this repository shipped — checked
 * rather than assumed, in `0064_parent-matches-discriminant.sql`.
 */
export const mountParentMatchesServiceType = check(
  'mount_parent_matches_service_type',
  sql`num_nonnulls("application_id", "compose_id", "libsql_id", "mariadb_id", "mongo_id", "mysql_id", "postgres_id", "redis_id") = 1
    AND (CASE "service_type"
           WHEN 'application' THEN "application_id"
           WHEN 'compose'     THEN "compose_id"
           WHEN 'libsql'      THEN "libsql_id"
           WHEN 'mariadb'     THEN "mariadb_id"
           WHEN 'mongo'       THEN "mongo_id"
           WHEN 'mysql'       THEN "mysql_id"
           WHEN 'postgres'    THEN "postgres_id"
           WHEN 'redis'       THEN "redis_id"
         END) IS NOT NULL`,
);

export const mount = pgTable(
  'mount',
  {
    mountId: nanoidPk('mount_id'),
    type: mountTypeEnum('type').notNull(),
    hostPath: text('host_path'),
    volumeName: text('volume_name'),
    filePath: text('file_path'),
    // File-mount content can carry secrets (env files, credentials), so it is
    // encrypted at rest like env columns.
    content: encryptedText('content'),
    // A Bucket has no mounts: its files are its own volume.
    serviceType: serviceTypeEnum('service_type')
      .$type<WorkloadServiceType>()
      .notNull()
      .default('application'),
    mountPath: text('mount_path').notNull(),
    applicationId: text('application_id').references(
      () => application.applicationId,
      { onDelete: 'cascade' },
    ),
    composeId: text('compose_id').references(() => compose.composeId, {
      onDelete: 'cascade',
    }),
    libsqlId: text('libsql_id').references(() => libsql.libsqlId, {
      onDelete: 'cascade',
    }),
    mariadbId: text('mariadb_id').references(() => mariadb.mariadbId, {
      onDelete: 'cascade',
    }),
    mongoId: text('mongo_id').references(() => mongo.mongoId, {
      onDelete: 'cascade',
    }),
    mysqlId: text('mysql_id').references(() => mysql.mysqlId, {
      onDelete: 'cascade',
    }),
    postgresId: text('postgres_id').references(() => postgres.postgresId, {
      onDelete: 'cascade',
    }),
    redisId: text('redis_id').references(() => redis.redisId, {
      onDelete: 'cascade',
    }),
  },
  () => [mountParentMatchesServiceType],
);

export const mountRelations = relations(mount, ({ one }) => ({
  application: one(application, {
    fields: [mount.applicationId],
    references: [application.applicationId],
  }),
  compose: one(compose, {
    fields: [mount.composeId],
    references: [compose.composeId],
  }),
  libsql: one(libsql, {
    fields: [mount.libsqlId],
    references: [libsql.libsqlId],
  }),
  mariadb: one(mariadb, {
    fields: [mount.mariadbId],
    references: [mariadb.mariadbId],
  }),
  mongo: one(mongo, {
    fields: [mount.mongoId],
    references: [mongo.mongoId],
  }),
  mysql: one(mysql, {
    fields: [mount.mysqlId],
    references: [mysql.mysqlId],
  }),
  postgres: one(postgres, {
    fields: [mount.postgresId],
    references: [postgres.postgresId],
  }),
  redis: one(redis, {
    fields: [mount.redisId],
    references: [redis.redisId],
  }),
}));

export type Mount = typeof mount.$inferSelect;

/** The mount FK column each service type's rows hang off, for callers that
 * query mounts by owning service (deploy paths, listings). */
export const mountServiceFk = {
  application: mount.applicationId,
  postgres: mount.postgresId,
  mysql: mount.mysqlId,
  mariadb: mount.mariadbId,
  mongo: mount.mongoId,
  redis: mount.redisId,
  compose: mount.composeId,
  libsql: mount.libsqlId,
} as const;
