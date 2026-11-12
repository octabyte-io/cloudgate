import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { getTableConfig, PgDialect, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../src/db/schema';

/**
 * **A unique index that keys the platform host by `server_id IS NULL` is
 * `NULLS NOT DISTINCT` in the database**.
 *
 * **What broke, twice.** `dns_challenge_local_unique` and
 * `forward_auth_settings_local_unique` were both written as
 * `uniqueIndex(…).on(serverId).where(isNull(serverId))` — the platform-host
 * row made unique the way `serverId.unique()` makes a Server's — and both held
 * the platform host to nothing. Postgres counts every NULL distinct in a unique
 * index, so an index whose only rows are NULL-keyed never finds two equal: two
 * concurrent first saves both inserted, and the reader answered whichever row
 * it met first. The index *looked* like a constraint in the schema, in the
 * migration and in `\d`, and only a concurrent test could tell.
 *
 * **Why the migrations and not the schema.** drizzle cannot say
 * `NULLS NOT DISTINCT` on an index, so the clause lives only in a hand-written
 * migration (`0083_dns-challenge-local-unique.sql`,
 * `0084_forward-auth-local-unique.sql`) and the schema's `uniqueIndex` is
 * unchanged by the fix. The schema is therefore where the *obligation* is read
 * from — every unique index whose predicate is `IS NULL` on one of its own
 * indexed columns — and the migrations are where the *discharge* is read
 * from: the last `CREATE UNIQUE INDEX "<name>"` the journal replays must carry
 * the clause, with no `DROP INDEX "<name>"` after it. A third table repeating
 * the shape, or a later migration rebuilding one of these without the clause,
 * fails here rather than in production.
 *
 * Migrations are read in the journal's order, not the directory's, because the
 * journal is what `migrate` replays: a file on disk it does not name has not
 * run anywhere.
 */

const backendRoot = join(__dirname, '..', '..');
const drizzleRoot = join(backendRoot, 'drizzle');

interface Migration {
  readonly tag: string;
  readonly sql: string;
}

/** Every migration the journal replays, in replay order. */
function journalMigrations(): Migration[] {
  const journal = JSON.parse(
    readFileSync(join(drizzleRoot, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map(({ tag }) => ({
      tag,
      sql: readFileSync(join(drizzleRoot, `${tag}.sql`), 'utf8'),
    }));
}

/**
 * Every unique index in the schema whose `.where` is `IS NULL` on one of the
 * columns it indexes — the NULL-keyed shape NULLs-distinct makes inert.
 */
function nullKeyedUniqueIndexes(): string[] {
  const dialect = new PgDialect();
  const found: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const { name: table, indexes } = getTableConfig(value);
    for (const { config } of indexes) {
      if (!config.unique || !config.where) continue;
      const predicate = dialect.sqlToQuery(config.where).sql.trim();
      const keyed = config.columns.some(
        (column) =>
          'name' in column &&
          predicate === `"${table}"."${column.name}" is null`,
      );
      if (keyed) found.push(config.name as string);
    }
  }
  return found.sort();
}

/**
 * For each index name, the `CREATE UNIQUE INDEX` statement that is live after
 * every migration has run, or `null` where a later `DROP INDEX` took it away.
 */
function liveUniqueIndexStatements(
  migrations: readonly Migration[],
): Map<string, { tag: string; statement: string } | null> {
  const live = new Map<string, { tag: string; statement: string } | null>();
  for (const { tag, sql } of migrations) {
    for (const chunk of sql.split('--> statement-breakpoint')) {
      const statement = chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim();
      const created =
        /^CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/i.exec(
          statement,
        );
      if (created) live.set(created[1], { tag, statement });
      const dropped = /^DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i.exec(
        statement,
      );
      if (dropped) live.set(dropped[1], null);
    }
  }
  return live;
}

/** The indexes among `names` the migrations leave NULLs-distinct, with why. */
function offenders(
  names: readonly string[],
  migrations: readonly Migration[],
): string[] {
  const live = liveUniqueIndexStatements(migrations);
  return names.flatMap((name) => {
    const created = live.get(name);
    if (created === undefined) {
      return [`${name}: no migration creates it`];
    }
    if (created === null) {
      return [`${name}: dropped after its last CREATE UNIQUE INDEX`];
    }
    return /\bNULLS\s+NOT\s+DISTINCT\b/i.test(created.statement)
      ? []
      : [`${name}: last created in ${created.tag} without NULLS NOT DISTINCT`];
  });
}

describe('backend/drizzle/ — a unique index keyed by IS NULL is NULLS NOT DISTINCT', () => {
  it('finds the NULL-keyed unique indexes the schema declares', () => {
    // A rename or a blind walk must fail this file rather than empty it.
    expect(nullKeyedUniqueIndexes()).toEqual(
      expect.arrayContaining([
        'dns_challenge_local_unique',
        'forward_auth_settings_local_unique',
      ]),
    );
  });

  it('leaves every one of them NULLS NOT DISTINCT after the last migration', () => {
    expect(offenders(nullKeyedUniqueIndexes(), journalMigrations())).toEqual(
      [],
    );
  });

  describe('the migration reader', () => {
    const create = (clause: string) =>
      `CREATE UNIQUE INDEX "x_local_unique" ON "x" USING btree ("server_id")${clause} WHERE "x"."server_id" is null;`;

    it('refuses an index whose last CREATE lacks the clause', () => {
      expect(
        offenders(
          ['x_local_unique'],
          [
            { tag: '0001_a', sql: create(' NULLS NOT DISTINCT') },
            {
              tag: '0002_b',
              sql: `DROP INDEX "x_local_unique";\n--> statement-breakpoint\n${create('')}`,
            },
          ],
        ),
      ).toEqual([
        'x_local_unique: last created in 0002_b without NULLS NOT DISTINCT',
      ]);
    });

    it('accepts a clause-less CREATE a later migration rebuilds with it', () => {
      expect(
        offenders(
          ['x_local_unique'],
          [
            { tag: '0001_a', sql: create('') },
            {
              tag: '0002_b',
              sql: `-- CREATE UNIQUE INDEX "x_local_unique" in a comment is not a statement\nDROP INDEX "x_local_unique";\n--> statement-breakpoint\n${create(' NULLS NOT DISTINCT')}`,
            },
          ],
        ),
      ).toEqual([]);
    });

    it('refuses an index a later migration drops, or none creates', () => {
      expect(
        offenders(
          ['x_local_unique', 'y_local_unique'],
          [
            { tag: '0001_a', sql: create(' NULLS NOT DISTINCT') },
            { tag: '0002_b', sql: 'DROP INDEX "x_local_unique";' },
          ],
        ),
      ).toEqual([
        'x_local_unique: dropped after its last CREATE UNIQUE INDEX',
        'y_local_unique: no migration creates it',
      ]);
    });
  });
});
