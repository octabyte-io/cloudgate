import { relations } from 'drizzle-orm';
import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { encryptedText, isoTimestamp, nanoidPk } from '../../db/columns';
import { environment } from '../../environments/environment.schema';

/** Which way a switch goes: to an Existing database, or to one Cloudgate makes. */
export type DatabaseSwitchTo = 'existing' | 'made';

/** The kind of Service a switch is asked on: a postgres, a mysql or a redis. */
export type DatabaseSwitchKind = 'postgres' | 'mysql' | 'redis';

/**
 * A **switch** an operator asked for and no Apply has made yet (ADR-0033):
 * the Environment's `postgres` or `redis` (`kind`) under
 * `configName` is to stop being the one Cloudgate made and use an existing
 * database instead, or the other way. A switch is one plan that removes one Service and adds the
 * other, so until that plan's Apply the Service is as it was and this row
 * is only the choice, which the planner reads beside the saved Services.
 *
 * Keyed by Environment and Config name, not by the Service: a Cloudgate-made
 * instance's Delete is a Cloud run that ends after the Apply, and the choice
 * outlives it, so the plan after it creates the existing Service. It goes
 * once that create (or the Cloudgate-made one's) is applied, or when the
 * operator cancels it.
 *
 * - `to: 'existing'` holds what "Use an existing database" holds: the RDS
 *   identifier, the reachability tick, and the apps' login, its password
 *   encrypted and never returned; on a redis, the replication group id,
 *   the tick, the TLS flag and the AUTH token, encrypted and never
 *   returned. The Cloud account and region are the Environment's Deploy
 *   target's when the create runs.
 * - `to: 'made'` holds nothing more: the config's entry says what is made.
 */
export const databaseSwitch = pgTable(
  'database_switch',
  {
    databaseSwitchId: nanoidPk('database_switch_id'),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.environmentId, { onDelete: 'cascade' }),
    configName: text('config_name').notNull(),
    kind: text('kind')
      .$type<DatabaseSwitchKind>()
      .notNull()
      .default('postgres'),
    to: text('to').$type<DatabaseSwitchTo>().notNull(),
    identifier: text('identifier'),
    madeReachable: boolean('made_reachable').notNull().default(false),
    databaseUser: text('database_user'),
    databaseName: text('database_name'),
    databasePassword: encryptedText('database_password'),
    /** A redis's: TLS on hands out `rediss://` and a `ca`. */
    tls: boolean('tls').notNull().default(true),
    /** A redis's AUTH token, `null` for a cache with none. */
    authToken: encryptedText('auth_token'),
    createdAt: isoTimestamp('created_at'),
  },
  (t) => [
    uniqueIndex('database_switch_environment_config_name_unique').on(
      t.environmentId,
      t.configName,
    ),
  ],
);

export const databaseSwitchRelations = relations(databaseSwitch, ({ one }) => ({
  environment: one(environment, {
    fields: [databaseSwitch.environmentId],
    references: [environment.environmentId],
  }),
}));

export type DatabaseSwitch = typeof databaseSwitch.$inferSelect;
