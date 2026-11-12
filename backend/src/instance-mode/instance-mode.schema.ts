import { sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';
import type { InstanceModeName } from 'api-schemas';
import { isoTimestamp } from '../db/columns';

/**
 * The key of the one row {@link recordedInstanceMode} holds. A fixed primary
 * key rather than a generated one, so two backends starting at once cannot
 * each insert a row: the second insert conflicts and reads the first's.
 */
export const RECORDED_INSTANCE_MODE_ID = 'instance';

/**
 * The Instance's recorded mode (ADR-0049): a single row, written by the
 * first start and compared against `HOSTED_MODE` by every start after it, so a
 * redeploy that drops the setting refuses to start instead of failing open.
 * Only the hand-run `set-instance-mode` command changes it.
 *
 * Its own table rather than a column on `web_server_settings`, whose row is
 * made lazily on first read with a generated id and may be absent at boot.
 */
export const recordedInstanceMode = pgTable(
  'recorded_instance_mode',
  {
    id: text('id').primaryKey().default(RECORDED_INSTANCE_MODE_ID),
    mode: text('mode').$type<InstanceModeName>().notNull(),
    recordedAt: isoTimestamp('recorded_at'),
    /** When `set-instance-mode` last changed it; null while never changed. */
    changedAt: text('changed_at'),
  },
  (table) => [
    check('recorded_instance_mode_single_row', sql`${table.id} = 'instance'`),
    check(
      'recorded_instance_mode_mode',
      sql`${table.mode} in ('hosted', 'self-hosted')`,
    ),
  ],
);

/** No relations: the row belongs to the Instance, not to any other row. */
export type RecordedInstanceMode = typeof recordedInstanceMode.$inferSelect;
