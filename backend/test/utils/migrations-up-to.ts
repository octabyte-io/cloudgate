import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { ADMIN_URL_ENV, withDatabase } from './test-postgres';

/**
 * The one way this tree can prove a data migration, and the one thing a data
 * migration cannot be proved without.
 *
 * **What broke first.** `test/utils/global-setup.ts` migrates the template
 * database *before* any test data exists, so a migration under test runs there
 * against empty tables and an ordinary suite watches nothing happen. Every
 * assertion about a normalization then passes against a migration that does
 * nothing at all. The technique that works is to build a database whose
 * migration history stops one entry short, write rows in the old shape, and
 * run the real migrator over them.
 *
 * That helper existed **three times** — `databases/mariadb-image-migration.e2e-spec.ts`
 * (0053, the original), `rollbacks/legacy-context-scrub.e2e-spec.ts` (0062)
 * and `patch/parent-id-constraint.e2e-spec.ts` (0063) — three
 * copies of the one function that decides whether a migration proof is real.
 * Neither earlier change extracted it because two of the three files were held
 * by other agents in the same batch; one copy says so in its own docblock
 * rather than leaving the duplication silent. That is the shape
 * `common/owned-server.ts`' docblock is about — *"five copies … that drifted
 * apart, plus the one that never got written"* — one directory over, and
 * `test/utils/migrations-up-to.spec.ts` now holds the tree to having one.
 *
 * **The shared-server form is the whole of it, and the container form is
 * gone.** The original started a Postgres of its own; the two newer specs
 * created a database on the server the run already shares. What a migration
 * proof needs is a per-database *history*, which is per-database — a server of
 * its own buys nothing and costs the run a container and about a gigabyte,
 * which is exactly what the machine-wide lock in `test/utils/global-setup.ts`
 * exists to stop happening five times at once. So the mariadb spec was
 * converted rather than the option kept: a helper with a second mode and no
 * caller for it is the thing `common/cron-expression.ts` declines to build.
 */

/** The committed migrations, as `drizzle-kit` writes them. */
export const MIGRATIONS_FOLDER = join(__dirname, '..', '..', 'drizzle');

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}

/**
 * A copy of the migrations folder whose journal stops at `lastTag` — running it
 * leaves the database at that point in its history, so the migrations after it
 * can be applied against data that already exists.
 *
 * The journal is what `migrate()` reads to decide the order and the set, so
 * truncating it is what makes a partial history; the `.sql` files are all
 * copied and the ones past the cutoff are simply never named.
 *
 * **A thrown `Error` rather than an `expect`,** unlike the three copies this
 * replaces: a tag no journal entry carries is a typo in the caller's constant,
 * and the failure has to name the tag. An `expect(cutoff).toBeGreaterThanOrEqual(0)`
 * reported `-1` is not `>= 0` and left the reader to work out which of two
 * constants was wrong — and it only works inside a test, which a helper other
 * setup code may call should not require.
 */
export async function migrationsUpTo(lastTag: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'cloudgate-migrations-'));
  await cp(MIGRATIONS_FOLDER, folder, { recursive: true });

  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;
  const cutoff = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (cutoff < 0) {
    throw new Error(
      `No migration tagged '${lastTag}' in drizzle/meta/_journal.json — ` +
        'a migration proof names the entry its history stops at, so a tag ' +
        'that is not there would migrate the whole way and prove nothing.',
    );
  }
  journal.entries = journal.entries.slice(0, cutoff + 1);
  await writeFile(journalPath, JSON.stringify(journal));

  return folder;
}

/** A database whose migration history stops one or more entries short. */
export interface LegacyDatabase {
  /** The database's name on the shared server, for a message that needs it. */
  readonly name: string;
  /** A pool onto it, sized 1 — a migration proof is sequential throughout. */
  readonly pool: Pool;
  /** Applies every migration after the cutoff: the one under test, for real. */
  migrateToHead(): Promise<void>;
  /** Closes the pool and drops the database. Safe to call after a failed setup. */
  drop(): Promise<void>;
}

/**
 * Create a database on the server the run already shares, with its migration
 * history stopping at `lastTag`.
 *
 * **Not `create database … template "${TEMPLATE_DB}"`**, which is how every
 * other suite gets its database and is exactly what cannot be used here: the
 * template's history already includes the migration under test, and a database
 * that has run it cannot store the row it has to normalize. So this one replays
 * `drizzle/` up to the cutoff, which is the cost the technique is.
 *
 * `label` only has to be unique enough to read in `\l` — the name carries six
 * random bytes, so two suites (or two workers) never collide.
 */
export async function startLegacyDatabase(
  label: string,
  lastTag: string,
): Promise<LegacyDatabase> {
  const adminUrl = process.env[ADMIN_URL_ENV];
  if (!adminUrl) {
    throw new Error(
      `A migration proof needs the shared server ${ADMIN_URL_ENV} names, ` +
        'which test/utils/global-setup.ts sets — run it under ' +
        'test/jest-e2e.json.',
    );
  }

  const name = `cg_${label}_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  let pool: Pool | undefined;

  try {
    await admin.query(`create database "${name}"`);
    pool = new Pool({
      connectionString: withDatabase(adminUrl, name),
      max: 1,
    });
    await migrate(drizzle(pool), {
      migrationsFolder: await migrationsUpTo(lastTag),
    });
  } catch (error) {
    // A setup that fails half way would otherwise leave the database behind on
    // a server the whole run shares, where the next suite's `\l` inherits it.
    if (pool) await endAndWait(pool);
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
    throw error;
  }

  const opened = pool;
  return {
    name,
    pool: opened,
    migrateToHead: async () => {
      await migrate(drizzle(opened), { migrationsFolder: MIGRATIONS_FOLDER });
    },
    drop: async () => {
      await endAndWait(opened);
      await admin.query(`drop database if exists "${name}" with (force)`);
      await admin.end();
    },
  };
}

/**
 * `pool.end()`, resolved only once every connection has actually closed.
 *
 * `pg-pool`'s own `end()` resolves as soon as it has *asked* its idle clients
 * to close — it drops them from its list and calls `client.end()` without
 * waiting — so the forced `drop database` that follows can reach the server
 * while that connection's backend is still alive. The server then terminates
 * it with `57P01 terminating connection due to administrator command`, the
 * client re-emits that on the pool, and a pool with no `'error'` listener
 * throws it: jest reports "Test suite failed to run" against a suite whose
 * every test passed, and the suite is green alone. That was the one "random"
 * suite in each of the first three e2e runs on a GitHub runner, every time one
 * of this helper's callers naming its own `cg_i<NNN>_…` database. The app's
 * pool never hit it because `src/db/drizzle.module.ts` gives it a listener.
 *
 * A pool emits `'remove'` once a client's connection has ended, which is the
 * moment the database is safe to drop.
 */
async function endAndWait(pool: Pool): Promise<void> {
  let open = pool.totalCount;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) return resolve();
    pool.on('remove', () => {
      if (--open === 0) resolve();
    });
  });
  await pool.end();
  await closed;
}
