import { pgTable, text } from 'drizzle-orm/pg-core';

import { isoTimestamp } from '../db/columns';

/**
 * The last good copy of the **Template catalogue** (ADR-0062), one row per
 * catalogue address. A row exists only once a `catalogue.zip` from that
 * address passed the Template check (ADR-0072), so "no row" is "no saved copy" and the
 * catalogue routes answer 502/504 rather than an empty list.
 *
 * Keyed by the address rather than kept as one row, so an operator who points
 * `CLOUDGATE_TEMPLATES_URL` at a mirror never sees the official copy served as
 * the mirror's, and pointing it back finds the old copy still there.
 *
 * Its own table, not a field of `web_server_settings`: a catalogue is up to
 * 10 MB, and that row is read on many paths that never need it.
 *
 * **Its key is the address, not a `nanoidPk`.** The address is the only
 * thing a copy is ever looked up by, and two rows for one address would be
 * two saved copies with no rule for which is served: a generated id would
 * need a unique index on `source_url` to say the same, and nothing would
 * ever read the id. `certificate_deletion`'s ARN key is the precedent.
 */
export const templateCatalogue = pgTable('template_catalogue', {
  /** The `CLOUDGATE_TEMPLATES_URL` the copy was read from. */
  sourceUrl: text('source_url').primaryKey(),
  /**
   * The release this copy is, when the address names one: where a `latest`
   * address redirected to (`…/releases/download/<tag>/catalogue.zip`). A
   * check that finds the same release reads no body. For an address that
   * does not redirect, such as a mirror serving one file in place, the
   * file's `ETag` or `Last-Modified` (`etag "…"`, `last-modified …`); null
   * when it sends neither, and only then is each check a full read.
   */
  release: text('release'),
  /**
   * The `catalogue.zip` exactly as fetched, at most 10 MB, as base64: write
   * with `toString('base64')`, read with `Buffer.from(body, 'base64')`, and
   * the Template check runs on exactly the bytes that were fetched.
   *
   * Base64 in `text` rather than a `bytea` column: a zip is not UTF-8, so
   * the `utf8` round trip a format-1 `catalogue.json` took would corrupt it,
   * and Drizzle's `pg-core` has no built-in `bytea` type, so one would be a
   * hand-written custom type and a column rewrite for a value that is only
   * ever read whole. The cost is a third more bytes in a one-row-per-address
   * table. Rows from before ADR-0072 held format-1 JSON and were deleted by
   * migration `0221_drop-format-1-catalogue-copies`.
   */
  body: text('body').notNull(),
  /** When this copy was fetched. How old the copy is, on the templates screen. */
  fetchedAt: isoTimestamp('fetched_at'),
  /** When the address was last checked for a newer copy, whatever came of it. */
  checkedAt: isoTimestamp('checked_at'),
  /**
   * Why the last check kept this copy rather than a newer one: the address
   * could not be reached, or what it served was refused. Null when the last
   * check succeeded.
   */
  problem: text('problem'),
});

export type TemplateCatalogueRow = typeof templateCatalogue.$inferSelect;
