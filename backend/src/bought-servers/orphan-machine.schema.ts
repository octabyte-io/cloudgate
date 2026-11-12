import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The machines nothing owns (spec #1387, #1402), as the hourly orphan check
 * last found them: each machine in the provider's account carrying a
 * Cloudgate label with no live Bought Server behind it
 * (`orphansAmong`). The Operator page lists these, and a machine is
 * emailed to the Operators when its row is first written, so once.
 *
 * Nothing here is deleted by the check except a row whose machine is gone
 * or owned again; the machine itself is deleted only by an Operator's
 * Delete, since a database restored from a backup leaves live machines
 * with no record too.
 */
export const boughtServerOrphan = pgTable('bought_server_orphan', {
  /** The machine's id at the provider. */
  providerServerId: integer('provider_server_id').primaryKey(),
  name: text('name').notNull(),
  location: text('location').notNull(),
  labels: jsonb('labels').$type<Record<string, string>>().notNull(),
  /**
   * Its Volumes and Primary IPs when last seen, which a deleted machine
   * leaves behind: kept, so a Delete cut off after the machine went still
   * deletes them when pressed again.
   */
  volumeIds: integer('volume_ids').array().notNull(),
  primaryIpIds: integer('primary_ip_ids').array().notNull(),
  /** When the provider made the machine: its age on the page. */
  machineCreatedAt: timestamp('machine_created_at', {
    precision: 3,
  }).notNull(),
  /** The tick that first found it, and emailed it. */
  foundAt: timestamp('found_at', { precision: 3 }).notNull(),
  /** The last tick that found it still there and unowned. */
  seenAt: timestamp('seen_at', { precision: 3 }).notNull(),
});

export type BoughtServerOrphan = typeof boughtServerOrphan.$inferSelect;
