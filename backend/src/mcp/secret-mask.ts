import { Inject, Injectable } from '@nestjs/common';
import { eq, getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { elideEncodedPayloads } from '../common/logging/error-payloads';
import { MIN_MASKED_CREDENTIAL_LENGTH } from '../destinations/s3-credentials';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import * as schema from '../db/schema';
import { SERVICE_SOURCES } from '../environments/environment-services';

/**
 * The one mask every tool result goes through (ADR-0024): every stored
 * secret value reachable from the call's target is replaced, then the existing
 * error-payload patterns (`elideEncodedPayloads`) run over what is left.
 *
 * **Which values, derived from the schema rather than listed.** A secret is a
 * value in an encrypted-at-rest column — `encryptedText` or `encryptedJson`,
 * which drizzle reports as `PgCustomColumn` and nothing else in the schema is.
 * *Reachable* is read off the foreign keys:
 *
 * 1. the target row itself;
 * 2. every row its foreign keys reach, transitively — a Service's
 *    Environment and Project, its registry, its git provider, its Server and
 *    that Server's SSH key;
 * 3. when the target is a Service, each of its child rows (the tables whose
 *    foreign key names it: mounts, patches, basic-auth credentials, schedules,
 *    backups…) and everything *their* foreign keys reach — a backup's
 *    Destination.
 *
 * Only paths that end at an encrypted column are walked, so an Environment
 * read costs a read of its Project and not of its Organization's owner. A new
 * encrypted column anywhere on those paths joins the mask with no edit here;
 * `test/coding-standards/tool-secret-mask.spec.ts` holds the derivation to an
 * independent walk of the schema and freezes the encrypted columns that no
 * Service reaches.
 *
 * **Its limit is stated, not discovered** (ADR-0024): it cannot mask what a
 * build prints that Cloudgate never stored, an encoded value, or a value
 * shorter than {@link MIN_MASKED_CREDENTIAL_LENGTH} — `s3-credentials.ts`'s
 * floor, below which a mask would eat ordinary words.
 */

/** What a masked value is replaced with — `s3-credentials.ts`'s marker. */
export const SECRET_MASK = '••••••';

/** A row a tool's result is about, from which the mask's reach is walked. */
export interface SecretRoot {
  readonly table: PgTable;
  readonly id: string;
}

interface Edge {
  /** The column holding the reference, on the table the edge leaves. */
  readonly column: AnyPgColumn;
  /** The table and column the edge arrives at. */
  readonly table: PgTable;
  readonly target: AnyPgColumn;
}

const TABLES: ReadonlyArray<readonly [string, PgTable]> = (
  Object.entries(schema) as Array<[string, unknown]>
)
  .filter((entry): entry is [string, PgTable] => is(entry[1], PgTable))
  .sort(([left], [right]) => left.localeCompare(right));

const NAME_OF = new Map<PgTable, string>();
for (const [name, table] of TABLES)
  if (!NAME_OF.has(table)) NAME_OF.set(table, name);

/** The table's name as `db/schema` exports it — `sshKey`, not `ssh_key`. */
export function tableName(table: PgTable): string {
  return NAME_OF.get(table) ?? '(unknown table)';
}

/** The keys of a table's encrypted-at-rest columns. */
export function encryptedColumnsOf(table: PgTable): string[] {
  return Object.entries(getTableColumns(table))
    .filter(([, column]) => column.columnType === 'PgCustomColumn')
    .map(([key]) => key);
}

/**
 * Every encrypted column's property name anywhere in the schema. A projection
 * may not carry a field under, or from, any of these names (`assertProjection`).
 */
export function encryptedColumnNames(): ReadonlySet<string> {
  return new Set(TABLES.flatMap(([, table]) => encryptedColumnsOf(table)));
}

/** A table's single-column foreign keys, as edges leaving it. */
function outgoing(table: PgTable): Edge[] {
  return getTableConfig(table)
    .foreignKeys.map((fk) => fk.reference())
    .filter((ref) => ref.columns.length === 1)
    .map((ref) => ({
      column: ref.columns[0],
      table: ref.foreignTable,
      target: ref.foreignColumns[0],
    }));
}

/** Edges arriving at `table`: each child table's foreign key naming it. */
function incoming(table: PgTable): Array<Edge & { child: PgTable }> {
  return TABLES.flatMap(([, child]) =>
    outgoing(child)
      .filter((edge) => edge.table === table)
      .map((edge) => ({ ...edge, child })),
  );
}

const SERVICE_TABLES = new Set<PgTable>(
  Object.values(SERVICE_SOURCES).map((source) => source.table),
);

/** Whether an encrypted column lies at or beyond `table` along foreign keys. */
function leadsToSecret(
  table: PgTable,
  avoid: ReadonlySet<PgTable>,
  seen = new Set<PgTable>(),
): boolean {
  if (seen.has(table)) return false;
  seen.add(table);
  if (encryptedColumnsOf(table).length > 0) return true;
  return outgoing(table).some(
    (edge) => !avoid.has(edge.table) && leadsToSecret(edge.table, avoid, seen),
  );
}

interface Plan {
  readonly secrets: string[];
  /** Foreign keys worth following: they end at an encrypted column. */
  readonly up: Edge[];
  /** For a Service root: child tables worth reading. */
  readonly down: Array<Edge & { child: PgTable }>;
}

const PLANS = new Map<PgTable, Plan>();

function planFor(table: PgTable): Plan {
  const known = PLANS.get(table);
  if (known) return known;
  const plan: Plan = {
    secrets: encryptedColumnsOf(table),
    up: outgoing(table).filter((edge) => leadsToSecret(edge.table, new Set())),
    down: SERVICE_TABLES.has(table)
      ? incoming(table).filter((edge) =>
          leadsToSecret(edge.child, new Set([table])),
        )
      : [],
  };
  PLANS.set(table, plan);
  return plan;
}

/**
 * Every `table.column` the mask covers for a target in `root`, by the rule in
 * this file's docblock — what the census compares against its own walk.
 */
export function secretReachOf(root: PgTable): string[] {
  const covered = new Set<string>();
  const seen = new Set<PgTable>();
  const walkUp = (table: PgTable) => {
    if (seen.has(table)) return;
    seen.add(table);
    const plan = planFor(table);
    for (const key of plan.secrets) covered.add(`${tableName(table)}.${key}`);
    for (const edge of plan.up) walkUp(edge.table);
  };
  walkUp(root);
  for (const edge of planFor(root).down) walkUp(edge.child);
  return [...covered].sort();
}

/**
 * The values a stored secret contributes to the mask: the whole value, and —
 * because `env`, `buildArgs` and their kin are `KEY=VALUE` blobs — each
 * line's value on its own. An `encryptedJson` value contributes every string
 * inside it. Values under the floor are dropped.
 */
export function secretValuesOf(value: unknown): string[] {
  const found: string[] = [];
  const visit = (current: unknown) => {
    if (typeof current === 'string') {
      found.push(current.trim());
      for (const line of current.split(/\r?\n/)) {
        const assignment =
          /^\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*=\s*(.*)$/.exec(line);
        if (!assignment) continue;
        const raw = assignment[1].trim();
        found.push(raw, raw.replace(/^(['"])(.*)\1$/, '$2'));
      }
    } else if (Array.isArray(current)) {
      current.forEach(visit);
    } else if (current && typeof current === 'object') {
      Object.values(current).forEach(visit);
    }
  };
  visit(value);
  return found.filter((entry) => entry.length >= MIN_MASKED_CREDENTIAL_LENGTH);
}

/**
 * Replaces every secret in every string of `value`, longest secret first so a
 * value that contains another is masked whole, then elides the error-payload
 * patterns. Object keys are the projection's own and are left alone.
 */
export function maskValue(value: unknown, secrets: readonly string[]): unknown {
  const ordered = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') {
      let out = current;
      for (const secret of ordered) out = out.split(secret).join(SECRET_MASK);
      return elideEncodedPayloads(out);
    }
    if (Array.isArray(current)) return current.map(visit);
    if (current && typeof current === 'object') {
      return Object.fromEntries(
        Object.entries(current).map(([key, inner]) => [key, visit(inner)]),
      );
    }
    return current;
  };
  return visit(value);
}

/**
 * The most child rows one step down from a Service is read as — its mounts,
 * schedules, backups and the like. A bound on a runaway read, far above what
 * one Service holds, not a page size: nothing past it is expected to exist.
 */
const MAX_CHILD_ROWS = 10_000;

function primaryKeyOf(table: PgTable): AnyPgColumn {
  const column = Object.values(getTableColumns(table)).find((c) => c.primary);
  if (!column) throw new Error(`${tableName(table)} has no primary key`);
  return column;
}

@Injectable()
export class SecretMask {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Every stored secret value reachable from `roots`. */
  async secretsFor(roots: readonly SecretRoot[]): Promise<string[]> {
    const values: string[] = [];
    const visited = new Set<string>();

    const read = async (
      table: PgTable,
      column: AnyPgColumn,
      value: unknown,
      many: boolean,
    ): Promise<Record<string, unknown>[]> => {
      if (typeof value !== 'string' && typeof value !== 'number') return [];
      const key = `${tableName(table)}:${column.name}:${value}`;
      if (visited.has(key)) return [];
      visited.add(key);
      const rows = (await this.db
        .select()
        .from(table)
        .where(eq(column, value))
        .limit(many ? MAX_CHILD_ROWS : 1)) as Record<string, unknown>[];
      return rows;
    };

    const walkUp = async (table: PgTable, row: Record<string, unknown>) => {
      const plan = planFor(table);
      for (const key of plan.secrets) values.push(...secretValuesOf(row[key]));
      for (const edge of plan.up) {
        const columnKey = keyOf(table, edge.column);
        for (const parent of await read(
          edge.table,
          edge.target,
          row[columnKey],
          false,
        )) {
          await walkUp(edge.table, parent);
        }
      }
    };

    for (const root of roots) {
      const pk = primaryKeyOf(root.table);
      for (const row of await read(root.table, pk, root.id, false)) {
        await walkUp(root.table, row);
      }
      for (const edge of planFor(root.table).down) {
        for (const child of await read(
          edge.child,
          edge.column,
          root.id,
          true,
        )) {
          await walkUp(edge.child, child);
        }
      }
    }
    return values;
  }
}

/** The property key under which `column` sits on `table`'s selected rows. */
function keyOf(table: PgTable, column: AnyPgColumn): string {
  const entry = Object.entries(getTableColumns(table)).find(
    ([, candidate]) => candidate === column,
  );
  if (!entry)
    throw new Error(`${column.name} is not a column of ${tableName(table)}`);
  return entry[0];
}
