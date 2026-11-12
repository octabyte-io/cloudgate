import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { compose } from '../compose/compose.schema';
import { databaseTypeEnum } from '../databases/common/database.schema';
import { libsql } from '../databases/libsql/libsql.schema';
import { mariadb } from '../databases/mariadb/mariadb.schema';
import { mongo } from '../databases/mongo/mongo.schema';
import { mysql } from '../databases/mysql/mysql.schema';
import { postgres } from '../databases/postgres/postgres.schema';
import {
  encryptedJson,
  generateAppName,
  isoTimestamp,
  nanoidPk,
} from '../db/columns';
import { destination } from '../destinations/destination.schema';

// No userId or includeEncryptionKey: both belong only to a backup of the
// instance itself (the "web-server" backup), which needs the web-server
// settings phase. The shared database_type enum lives with the databases
// (Phase 26 note); 'web-server' stays a reserved value.

export const backupTypeEnum = pgEnum('backup_type', ['database', 'compose']);

export type BackupType = (typeof backupTypeEnum.enumValues)[number];

/**
 * Compose backups carry the target's credentials in the row — the engine
 * runs inside the user's stack, so there is no database row to read from.
 *
 * **Three of the four members are a database password, so the column is
 * {@link encryptedJson} (ADR 0006).** `mariadb.databasePassword`,
 * `mongo.databasePassword` and `mysql.databaseRootPassword` are what
 * `BackupsService.credentialsFor` hands the engine's dump and restore
 * commands, and they are the *same values* the engine tables hold — where
 * every one of them has been `encryptedText` since it was written
 * (`mariadb.schema.ts`, `mongo`, `mysql`, `postgres`, `redis`, `libsql`). A
 * value that is a secret on one table and cleartext on another is the
 * classic failure mode, and the rest of this module had already decided which it is:
 * `BackupListItem` is `Omit<Backup, 'metadata'>`, `listByService` projects the
 * column out with `columns: { metadata: false }`, and the comment over both
 * calls it "the stack engine's user and password". Only the column disagreed.
 *
 * **The echo this classification obliged a check for is closed.** ADR 0015's
 * fourth consequence says that calling a column a secret obliges finding where
 * the value is *printed*, because a docblock claiming one thing while a log does
 * another is worse than the plain column was — and the conversion left exactly that:
 * these three passwords were words of `mysqldump --password=…`,
 * `mariadb -p…` and `mongodump -p …`, and `ExecError` captures the command a
 * failed exec ran, which pino then writes six times over. They now travel in
 * the environment instead (`commands/utils.ts`' `DATABASE_PASSWORD_ENV`), so
 * the only echo this column has left is back to its own author, which the
 * projections above already deny.
 *
 * **The whole blob, not `databasePassword` lifted out of it**, on the
 * `encryptedJson` argument transferred: the alternative is three `encryptedText` columns beside
 * a `jsonb` remainder, which multiplies one nullable column into four that
 * must agree about a value a dump command runs as, and changes a shape three
 * DTOs mirror. The precondition for the narrow change is that something
 * still needs the non-secret fields *in SQL*, and nothing does — see the
 * column below.
 *
 * **`databaseUser` comes along, and that is the point rather than a cost.**
 * The two remaining fields name the engine account the dump authenticates as.
 * They are not secrets on their own, they are half of one, and splitting a
 * user from its password so the user can stay queryable would be paying the
 * cost above for a query nobody makes.
 */
export interface ComposeBackupMetadata {
  postgres?: { databaseUser: string };
  mariadb?: { databaseUser: string; databasePassword: string };
  mongo?: { databaseUser: string; databasePassword: string };
  mysql?: { databaseRootPassword: string };
}

/**
 * The parent that is set is the one the `backupType`/`databaseType` pair
 * names, as a database fact.
 *
 * **The discriminant here is two columns, not one, which is why this table is
 * the awkward one.** `BackupsService`' `serviceIdOf` is
 * `row.backupType === 'compose' ? row.composeId : row[BACKUP_FK_FIELD[row.databaseType]]`,
 * and the `CASE` below is that expression transcribed: `backup_type` is tested
 * first and `database_type` only decides an engine backup. On a **compose**
 * backup `database_type` is still `NOT NULL` and still meaningful — it says
 * which engine inside the stack is dumped — so a constraint keyed on
 * `database_type` alone would have refused every compose backup in the
 * product. That is the same mistake nearly made on `deployment`, one
 * table over.
 *
 * **`database_type = 'web-server'` with `backup_type = 'database'` is refused,
 * and that is deliberate.** It is the reserved value this file's header names:
 * a backup of the instance itself, which has no column here because it has no
 * service row, so the `CASE` returns `NULL` and `BACKUP_FK_FIELD` has no entry
 * for it either — `serviceIdOf` would throw
 * `NotFoundException('Backup has no owning service')` on any such row today.
 * `createBackupSchema` already refuses it on the wire (`z.enum(backupDatabaseTypes)`
 * is the five engines), so nothing can produce one. The phase that lands
 * web-server backups adds a column and replaces this constraint in the same
 * migration; a constraint loose enough to pre-admit a row shape no reader can
 * resolve would have bought that phase nothing.
 */
export const backupParentMatchesType = check(
  'backup_parent_matches_type',
  sql`num_nonnulls("compose_id", "postgres_id", "mariadb_id", "mysql_id", "mongo_id", "libsql_id") = 1
    AND (CASE
           WHEN "backup_type" = 'compose'     THEN "compose_id"
           WHEN "database_type" = 'postgres'  THEN "postgres_id"
           WHEN "database_type" = 'mariadb'   THEN "mariadb_id"
           WHEN "database_type" = 'mysql'     THEN "mysql_id"
           WHEN "database_type" = 'mongo'     THEN "mongo_id"
           WHEN "database_type" = 'libsql'    THEN "libsql_id"
         END) IS NOT NULL`,
);

export const backup = pgTable(
  'backup',
  {
    backupId: nanoidPk('backup_id'),
    /** Names the S3 fallback prefix and the run-log directory. */
    appName: text('app_name')
      .notNull()
      .unique()
      .$defaultFn(() => generateAppName('backup')),
    /** Cron expression — scheduling wiring lands with Phase 37. */
    schedule: text('schedule').notNull(),
    enabled: boolean('enabled'),
    /** Name of the database inside the engine that gets dumped. */
    database: text('database').notNull(),
    /** S3 path fragment between the service's appName and the dump file. */
    prefix: text('prefix').notNull(),
    /** Compose backups only: which service in the stack holds the engine. */
    serviceName: text('service_name'),
    destinationId: text('destination_id')
      .notNull()
      .references(() => destination.destinationId, { onDelete: 'cascade' }),
    /** Prune target: keep the newest N dumps after each run (null/0 = keep all). */
    keepLatestCount: integer('keep_latest_count'),
    backupType: backupTypeEnum('backup_type').notNull().default('database'),
    databaseType: databaseTypeEnum('database_type').notNull(),
    composeId: text('compose_id').references(() => compose.composeId, {
      onDelete: 'cascade',
    }),
    postgresId: text('postgres_id').references(() => postgres.postgresId, {
      onDelete: 'cascade',
    }),
    mariadbId: text('mariadb_id').references(() => mariadb.mariadbId, {
      onDelete: 'cascade',
    }),
    mysqlId: text('mysql_id').references(() => mysql.mysqlId, {
      onDelete: 'cascade',
    }),
    mongoId: text('mongo_id').references(() => mongo.mongoId, {
      onDelete: 'cascade',
    }),
    libsqlId: text('libsql_id').references(() => libsql.libsqlId, {
      onDelete: 'cascade',
    }),
    /**
     * The stack engine's credentials on a compose backup, `null` on every
     * database one — `encryptedJson`, converted by `0066`.
     * {@link ComposeBackupMetadata} carries why the blob and not one field.
     *
     * **Nothing reads inside it in SQL, which is what makes this a column
     * change and not a schema change** (the `encryptedJson` question, asked again here). The
     * only access to this blob anywhere in `src` is
     * `BackupsService.credentialsFor`, in the process, off a row already
     * fetched: no `->>`, no `->`, no containment operator, no `where`, no
     * ordering and no index on `metadata` in any of the 66 migrations. Which
     * matters because an encrypted column *cannot* be looked up by value —
     * AES-256-GCM under a random IV, and drizzle applies `toDriver` to the
     * bound parameter too, so `where metadata = $1` matches nothing (ADR 0006,
     * as extended).
     *
     * **Nullable with no `.default()`, and both are deliberate.** drizzle never
     * hands `null` to a `customType`'s `toDriver`/`fromDriver` — the mappers
     * guard it on the way in and out, on the core path and the relational one
     * alike — so a nullable `encryptedJson` needs no guard of its own, and
     * `custom.headers` has been exactly this shape for a long time. A default
     * is not available even in principle: it would have to *contain* the
     * credentials to be worth anything, and a secret in DDL is tied to the
     * `APP_ENCRYPTION_SECRET` that generated the migration (ADR 0006). That is
     * why the column is held by the census in
     * `test/coding-standards/secret-bearing-columns.spec.ts` rather than by
     * the default-walking property, which cannot see it.
     */
    metadata: encryptedJson<ComposeBackupMetadata>('metadata'),
    createdAt: isoTimestamp('created_at'),
  },
  () => [backupParentMatchesType],
);

export const backupRelations = relations(backup, ({ one }) => ({
  destination: one(destination, {
    fields: [backup.destinationId],
    references: [destination.destinationId],
  }),
  compose: one(compose, {
    fields: [backup.composeId],
    references: [compose.composeId],
  }),
  postgres: one(postgres, {
    fields: [backup.postgresId],
    references: [postgres.postgresId],
  }),
  mariadb: one(mariadb, {
    fields: [backup.mariadbId],
    references: [mariadb.mariadbId],
  }),
  mysql: one(mysql, {
    fields: [backup.mysqlId],
    references: [mysql.mysqlId],
  }),
  mongo: one(mongo, {
    fields: [backup.mongoId],
    references: [mongo.mongoId],
  }),
  libsql: one(libsql, {
    fields: [backup.libsqlId],
    references: [libsql.libsqlId],
  }),
}));

export type Backup = typeof backup.$inferSelect;

/** The services a backup can hang off — the five engines with a dump command
 * plus a compose stack. Redis has no dump tool and applications are not backed
 * up, so neither has a `backup` FK column. */
export const backupServiceTypes = [
  'postgres',
  'mysql',
  'mariadb',
  'mongo',
  'libsql',
  'compose',
] as const;

export type BackupServiceType = (typeof backupServiceTypes)[number];

/** The backup FK column each service type's rows hang off, for callers that
 * query backups by backed-up service (the mountServiceFk precedent). */
export const backupServiceFk = {
  postgres: backup.postgresId,
  mysql: backup.mysqlId,
  mariadb: backup.mariadbId,
  mongo: backup.mongoId,
  libsql: backup.libsqlId,
  compose: backup.composeId,
} as const satisfies Record<BackupServiceType, AnyPgColumn>;
