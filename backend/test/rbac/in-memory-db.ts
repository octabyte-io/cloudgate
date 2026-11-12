import { getTableColumns, getTableName, is, SQL } from 'drizzle-orm';
import type { Column, Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DrizzleDB } from '../../src/db/drizzle.module';

/**
 * A database for the unit lane that answers the handful of Drizzle query
 * shapes the Instance-organization pin and instance authority use, without
 * Postgres: `select … from … [inner|left]Join … where … limit`, and
 * `insert … values … onConflictDoNothing … returning`.
 *
 * Conditions are rendered by Drizzle's own `PgDialect` and evaluated from the
 * SQL text, so a test sees which columns a query really asked about. Only `=`
 * (column = parameter, column = column) joined by `and` is understood, and
 * anything else throws rather than being answered wrongly. Rows come back in
 * insertion order; `orderBy` is accepted and ignored, so a fixture inserts
 * rows in the order it means them to sort.
 */
type Row = Record<string, unknown>;

const dialect = new PgDialect();

function columnKey(column: Column<any>): string {
  return `${getTableName(column.table)}.${column.name}`;
}

/** `"t"."c" = $1` and `"t"."c" = "u"."d"` pairs of an `and`-only condition. */
function equalities(
  condition: SQL,
): Array<{ left: string; right: { key: string } | { value: unknown } }> {
  const { sql, params } = dialect.sqlToQuery(condition);
  const stripped = sql.replace(/[()]/g, ' ');
  if (/\b(or|not|in|like|is)\b/i.test(stripped) || /[<>!]/.test(stripped)) {
    throw new Error(`in-memory-db: unsupported condition: ${sql}`);
  }
  const terms = stripped.split(/\band\b/i).map((term) => term.trim());
  return terms.map((term) => {
    const match =
      /^"([^"]+)"\."([^"]+)"\s*=\s*(?:\$(\d+)|"([^"]+)"\."([^"]+)")$/.exec(
        term,
      );
    if (!match) throw new Error(`in-memory-db: unsupported term: ${term}`);
    const left = `${match[1]}.${match[2]}`;
    return match[3]
      ? { left, right: { value: params[Number(match[3]) - 1] } }
      : { left, right: { key: `${match[4]}.${match[5]}` } };
  });
}

function matches(row: Row, condition: SQL | undefined): boolean {
  if (!condition) return true;
  return equalities(condition).every(({ left, right }) =>
    'value' in right ? row[left] === right.value : row[left] === row[right.key],
  );
}

export class InMemoryDb {
  private readonly tables = new Map<string, Row[]>();

  /** The rows of `table`, keyed by column name. */
  rows(table: Table): Row[] {
    const name = getTableName(table);
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  /** Inserts rows keyed by property name, as `insert().values()` takes them. */
  seed(table: Table, values: Row[]): void {
    for (const value of values) this.insertRow(table, value);
  }

  /** Removes rows by a property's value, as a delete the app did not make would. */
  remove(table: Table, property: string, value: unknown): void {
    const column = getTableColumns(table)[property];
    const kept = this.rows(table).filter((row) => row[column.name] !== value);
    this.tables.set(getTableName(table), kept);
  }

  /** The DrizzleDB face the code under test is given. */
  get db(): DrizzleDB {
    return this as unknown as DrizzleDB;
  }

  private insertRow(table: Table, value: Row): Row | null {
    const columns = getTableColumns(table);
    const row: Row = {};
    for (const [property, column] of Object.entries(columns)) {
      let cell = value[property];
      if (cell === undefined && column.defaultFn) cell = column.defaultFn();
      if (cell === undefined && column.default !== undefined) {
        cell = is(column.default, SQL) ? undefined : column.default;
      }
      row[column.name] = cell ?? null;
    }
    const unique = Object.values(columns).filter(
      (column) => column.primary || column.isUnique,
    );
    const existing = this.rows(table);
    const conflict = existing.some((other) =>
      unique.some(
        (column) =>
          row[column.name] !== null && other[column.name] === row[column.name],
      ),
    );
    if (conflict) return null;
    existing.push(row);
    return row;
  }

  select(projection: Record<string, Column>) {
    const joins: Array<{ table: Table; on: SQL; kind: 'inner' | 'left' }> = [];
    let base: Table;
    let condition: SQL | undefined;
    let limit = Infinity;
    const run = (): Row[] => {
      let rows: Row[] = this.rows(base).map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [
            `${getTableName(base)}.${k}`,
            v,
          ]),
        ),
      );
      for (const join of joins) {
        const name = getTableName(join.table);
        const prefixed = this.rows(join.table).map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([k, v]) => [`${name}.${k}`, v]),
          ),
        );
        const blank = Object.fromEntries(
          Object.values(getTableColumns(join.table)).map((c) => [
            columnKey(c),
            null,
          ]),
        );
        rows = rows.flatMap((left) => {
          const found = prefixed
            .map((right) => ({ ...left, ...right }))
            .filter((both) => matches(both, join.on));
          if (found.length > 0) return found;
          return join.kind === 'left' ? [{ ...left, ...blank }] : [];
        });
      }
      return rows
        .filter((row) => matches(row, condition))
        .slice(0, limit)
        .map((row) =>
          Object.fromEntries(
            Object.entries(projection).map(([key, column]) => [
              key,
              row[columnKey(column)] ?? null,
            ]),
          ),
        );
    };
    const query = {
      from: (table: Table) => ((base = table), query),
      innerJoin: (table: Table, on: SQL) => (
        joins.push({ table, on, kind: 'inner' }),
        query
      ),
      leftJoin: (table: Table, on: SQL) => (
        joins.push({ table, on, kind: 'left' }),
        query
      ),
      where: (where: SQL | undefined) => ((condition = where), query),
      orderBy: () => query,
      limit: (n: number) => ((limit = n), query),
      then: <T>(resolve: (rows: Row[]) => T, reject?: (e: unknown) => T) => {
        try {
          return Promise.resolve(resolve(run()));
        } catch (error) {
          if (reject) return Promise.resolve(reject(error));
          return Promise.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
    };
    return query;
  }

  insert(table: Table) {
    let pending: Row[] = [];
    let ignoreConflicts = false;
    const project = (rows: Row[], projection?: Record<string, Column>) =>
      projection
        ? rows.map((row) =>
            Object.fromEntries(
              Object.entries(projection).map(([key, column]) => [
                key,
                row[column.name],
              ]),
            ),
          )
        : rows;
    let projection: Record<string, Column> | undefined;
    const run = (): Row[] => {
      const written: Row[] = [];
      for (const value of pending) {
        const row = this.insertRow(table, value);
        if (!row && !ignoreConflicts) {
          throw new Error(
            `in-memory-db: duplicate key in ${getTableName(table)}`,
          );
        }
        if (row) written.push(row);
      }
      return project(written, projection);
    };
    const query = {
      values: (values: Row | Row[]) => (
        (pending = Array.isArray(values) ? values : [values]),
        query
      ),
      onConflictDoNothing: () => ((ignoreConflicts = true), query),
      returning: (returned?: Record<string, Column>) => (
        (projection = returned ?? getTableColumns(table)),
        query
      ),
      then: <T>(resolve: (rows: Row[]) => T, reject?: (e: unknown) => T) => {
        try {
          return Promise.resolve(resolve(run()));
        } catch (error) {
          if (reject) return Promise.resolve(reject(error));
          return Promise.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
    };
    return query;
  }

  /** Runs `work` against this database; a throw discards nothing (no rollback). */
  transaction<T>(work: (tx: InMemoryDb) => Promise<T>): Promise<T> {
    return work(this);
  }

  /** Advisory locks and other raw statements: accepted, nothing to do. */
  execute(): Promise<{ rows: Row[] }> {
    return Promise.resolve({ rows: [] });
  }
}
