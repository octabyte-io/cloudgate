import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { application } from '../../src/applications/application.schema';
import { APPLICATION_CREDENTIAL_REFS } from '../../src/applications/applications.service';
import { mount } from '../../src/mounts/mount.schema';

/**
 * The residual 91ee164 named and could not reach. That fix closed
 * both *reachable* paths to a legacy `rollback.full_context` —
 * `toRollbackContext` now runs on the way out as well as on the way in, so a
 * pre-fix snapshot can neither win `RollbacksService.rollback`'s merge nor be
 * served by `findAllByApplicationId` — and left the bytes. A row written
 * before that commit still holds decrypted `previewEnv`, `previewBuildArgs`,
 * each file mount's `content` and the seven credential ids in a plain `json`
 * column, which a `pg_dump` or a physical backup carries. `0062` scrubs them.
 *
 * **This spec is worth more than the migration it checks.** A migration is a
 * frozen artefact: it cannot import `EXCLUDED_FROM_CONTEXT`, so its key list
 * is a retyped copy of a list that lives in two places in `src` — the exact
 * shape of the defect that fix fixed, where `previewEnv` and `previewBuildArgs`
 * arrived three weeks after the exclusion list was written and were
 * simply absent from it with nothing to object. So the list is checked here
 * against the same **independent sources** `rollback-context.spec.ts` uses
 * (§1.7): the credential ids off `APPLICATION_CREDENTIAL_REFS`, the encrypted
 * columns off the `application` and `mount` tables themselves.
 *
 * When this goes red it is not asking for an edit to `0062`, which is frozen
 * and has already run on the installs that needed it. It is saying that a name
 * has joined the exclusion list since, that every row written between `0062`
 * and that change still holds it at rest, and that the answer is a **new**
 * scrub migration beside this one.
 */

const DRIZZLE = join(__dirname, '..', '..', 'drizzle');
const TAG = '0062_scrub-legacy-rollback-context';

const sql = readFileSync(join(DRIZZLE, `${TAG}.sql`), 'utf8');

/**
 * The keys `0062`'s first statement deletes, read off the one `ARRAY[…]` in
 * its `scrub(keys)` CTE.
 *
 * The CTE exists so the list is written once: the statement needs it twice —
 * once to delete and once in the `?|` test that makes a second run match no
 * row — and two copies would leave this parse having to decide which one is
 * authoritative.
 */
const SCRUBBED_KEYS = (() => {
  const array = /VALUES \(ARRAY\[([^\]]*)\]\)/.exec(sql);
  if (!array) throw new Error(`no scrub(keys) ARRAY[…] in ${TAG}.sql`);
  return [...array[1].matchAll(/'([^']+)'/g)].map(([, key]) => key);
})();

/** The keys its second statement deletes from each element of `mounts`. */
const SCRUBBED_MOUNT_KEYS = [...sql.matchAll(/m\.value - '([^']+)'/g)].map(
  ([, key]) => key,
);

/**
 * Columns a table stores encrypted at rest (ADR 0006). `encryptedText` is a
 * drizzle `customType`, so it reports as `PgCustomColumn` and nothing else on
 * either table is one — `nanoidPk` and `isoTimestamp` are plain `text`.
 * Enumerated rather than listed so a later encrypted column joins the set on
 * its own, which is the whole point of the file.
 */
const encryptedColumns = (table: Parameters<typeof getTableColumns>[0]) =>
  Object.entries(getTableColumns(table))
    .filter(([, column]) => column.columnType === 'PgCustomColumn')
    .map(([key]) => key);

interface Journal {
  entries: { idx: number; version: string; when: number; tag: string }[];
}

describe('backend/drizzle/0062_scrub-legacy-rollback-context.sql', () => {
  it('enumerates the three sources it is asserting from', () => {
    // Every assertion below is a containment check, and containment in an
    // empty needle passes against a migration that scrubs nothing. A parse
    // that silently matched no quoted string is the failure mode.
    expect(SCRUBBED_KEYS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(SCRUBBED_KEYS).size).toBe(SCRUBBED_KEYS.length);
    expect(SCRUBBED_MOUNT_KEYS.length).toBeGreaterThan(0);
    expect(APPLICATION_CREDENTIAL_REFS.length).toBe(7);
    expect(encryptedColumns(application)).toEqual(
      expect.arrayContaining(['previewEnv', 'previewBuildArgs']),
    );
  });

  it.each(APPLICATION_CREDENTIAL_REFS.map((ref) => [ref] as const))(
    'scrubs %s, which a pre-fix row could hold for another organization',
    (ref) => {
      expect(SCRUBBED_KEYS).toContain(ref);
    },
  );

  it.each(
    APPLICATION_CREDENTIAL_REFS.map((ref) => [ref.replace(/Id$/, '')] as const),
  )('scrubs the %s relation the id loads through', (relation) => {
    // The relations were excluded from the day the list was written, so no
    // snapshot `capture` produced should carry one. Derived from the ids
    // rather than restated because the seven pairs differ only by the suffix,
    // and because a row's shape is whatever some past version of `capture`
    // wrote — a snapshot older than the exclusion list is exactly the row
    // this migration exists for.
    expect(SCRUBBED_KEYS).toContain(relation);
  });

  it.each(encryptedColumns(application).map((column) => [column] as const))(
    'scrubs %s, an encrypted column that reached the json column in cleartext',
    (column) => {
      expect(SCRUBBED_KEYS).toContain(column);
    },
  );

  it.each(encryptedColumns(mount).map((column) => [column] as const))(
    'scrubs mounts[].%s, which findDeployable filled from whole mount rows',
    (column) => {
      expect(SCRUBBED_MOUNT_KEYS).toContain(column);
    },
  );

  it('is registered in the journal, without which the file never runs', () => {
    // A migration is renamed by hand here (CODING_STANDARDS §2.6) and
    // `drizzle-kit generate` writes nothing for a data-only one, so the file
    // and its journal entry are two separate edits and the second is the one
    // that gets forgotten. `drizzle-kit migrate` reads the journal, not the
    // directory: a file with no entry is inert and silently so.
    const journal = JSON.parse(
      readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8'),
    ) as Journal;
    const entry = journal.entries.find((candidate) => candidate.tag === TAG);

    expect(entry).toMatchObject({ tag: TAG, version: '7' });
    expect(entry?.idx).toBe(62);
  });
});
