import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { MIGRATIONS_FOLDER, migrationsUpTo } from './migrations-up-to';

/**
 * `migrationsUpTo` was the third copy of one helper, and it is the one
 * thing a data migration cannot be proved without — `migrations-up-to.ts`'
 * docblock carries why, and what the copies were.
 *
 * Two claims are asserted here and they answer different questions. The first
 * two `it`s are about the helper: a truncated history is what makes a
 * migration proof real, and a *silently* untruncated one would make every
 * proof in the tree green against a migration that ran on empty tables. The
 * third is the property, on `test/coding-standards/parent-id-writes.spec.ts`'
 * terms — a list of the three specs that shared a copy rots as fast as the
 * specs do, and the fourth data migration is the one this is for.
 *
 * A unit spec rather than an e2e one, deliberately: nothing here needs a
 * Postgres. What is under test is a folder copy and a JSON edit, which is the
 * half of the technique that can be wrong without anything failing.
 *
 * **The title is the module's path rather than `migrationsUpTo`**, which is
 * §1.7's second escape and the one `test/settings/server-setup.spec.ts` uses
 * for `deploy/install.sh`: `describe-names.spec.ts` accepts a symbol only if
 * `backend/src` binds it, and this unit lives in `backend/test/` because it is
 * the harness rather than the product. The path *is* the name of the unit here,
 * and the gate resolves it, so a typo in it fails rather than passing as prose.
 */
describe('backend/test/utils/migrations-up-to.ts', () => {
  /** Two real, adjacent tags — 0053 is the tree's first data migration. */
  const CUTOFF = '0052_environment-description';
  const AFTER_CUTOFF = '0053_mariadb-default-image';

  const journalOf = async (folder: string) =>
    JSON.parse(
      await readFile(join(folder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };

  it('leaves the history stopping at the tag it is given', async () => {
    const folder = await migrationsUpTo(CUTOFF);
    const tags = (await journalOf(folder)).entries.map((entry) => entry.tag);

    // The named tag is the last thing `migrate()` will see, and the migration
    // after it — the one a proof written against this cutoff is about — is not
    // in the journal at all.
    expect(tags[tags.length - 1]).toBe(CUTOFF);
    expect(tags).toContain('0051_billing');
    expect(tags).not.toContain(AFTER_CUTOFF);
    expect(tags).not.toContain('0063_exactly-one-parent-id');
  });

  it('copies the folder rather than editing the committed journal', async () => {
    const before = readFileSync(
      join(MIGRATIONS_FOLDER, 'meta', '_journal.json'),
      'utf8',
    );

    await migrationsUpTo(CUTOFF);

    // The one way this helper could be catastrophic: `drizzle/` is committed,
    // and a truncated journal in the working tree would take every migration
    // after the cutoff out of the product.
    expect(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ).toBe(before);
    // And the `.sql` past the cutoff is still on disk in the copy — it is the
    // journal that decides, not the presence of the file.
    const folder = await migrationsUpTo(CUTOFF);
    expect(readdirSync(folder)).toContain(`${AFTER_CUTOFF}.sql`);
  });

  it('refuses a tag no journal entry carries, and names it', async () => {
    // The failure that would otherwise be silent-ish: a typo in a caller's
    // constant. `-1` sliced as `0, 0` would hand back an *empty* history, so
    // this is not a nicety.
    await expect(
      migrationsUpTo('0052_environment-descriptoin'),
    ).rejects.toThrow("No migration tagged '0052_environment-descriptoin'");
  });

  it('is the only copy of itself in the test tree', () => {
    // The property, not a list of the three specs that had a copy.
    // One copy named the other two in prose and could not remove them; the
    // fourth data migration is what this assertion is for.
    const testRoot = join(__dirname, '..');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
      });

    const declaring = walk(testRoot)
      .filter((path) => path.endsWith('.ts'))
      .filter((path) => path !== join(__dirname, 'migrations-up-to.ts'))
      .filter((path) =>
        /(function|const)\s+migrationsUpTo\b/.test(readFileSync(path, 'utf8')),
      )
      .map((path) => relative(testRoot, path));

    expect(declaring).toEqual([]);
  });
});
