import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * The property, stated once:
 *
 * > no two `pgEnum` calls in `src/` declare the same Postgres type name, and
 * > every file that declares one is reachable from `src/db/schema.ts`
 *
 * **What broke.** `build_type` was declared twice —
 * `builders/build-strategy.ts` with a seventh member `'drop'`,
 * `applications/application.schema.ts` with six — and the `application` table
 * used the six-member one. So `dropStrategy` was registered in
 * `getBuildStrategy`'s map, tested by `build-strategy-registry.spec.ts`,
 * offered by `BuildType`, and **unreachable**: no migration ever added `'drop'`
 * to the Postgres type, and `updateApplicationSchema`'s own `z.enum` has the
 * six. A `buildType` nobody could set had a strategy, a spec and a docblock for
 * the length of two audits.
 *
 * **Nothing was ever going to say so.** `pgEnum` is a factory, not a
 * registration: two calls with one name produce two unrelated objects, and
 * neither drizzle nor the compiler has any reason to compare them — the second
 * declaration is a fresh value with a fresh TypeScript union, and a column
 * binds whichever one its own module imported. `drizzle-kit generate` cannot
 * see the disagreement either, and for the reason this file's second assertion
 * exists: it serializes what `src/db/schema.ts` re-exports, and
 * `builders/build-strategy.ts` is not in that list, so the seven-member
 * declaration was never a candidate for a migration and never produced one to
 * conflict. Two declarations, no error anywhere, and the only symptom is a
 * `INSERT` Postgres refuses — in production, on the one row that used the
 * member the database has never heard of.
 *
 * **Two alternatives were rejected.** A lint rule sees one file's AST, and
 * *"is this name declared elsewhere"* is a question about the other twenty-four
 * files — the same reason `describe-names.spec.ts` is a spec rather than
 * `jest/valid-title`. Comparing the declarations against the live Postgres
 * catalogue would catch the *migration* half and nothing else: it needs a
 * container, it belongs to the e2e lane, and it would still pass here, because
 * the duplicate that Postgres never heard of is exactly the one it cannot see.
 * Reading the source is what closes it, and it costs a file walk.
 *
 * The second assertion is deliberately here rather than in its own file,
 * because it is the same defect's other half rather than a new rule: an enum
 * outside the schema closure is one drizzle-kit is not diffing, which is what
 * made a duplicate survivable long enough to grow a strategy. It has no
 * exemption list on purpose — the tree has none today, and a `pgEnum` that
 * genuinely wants to be invisible to migrations should have to argue for it
 * here rather than be granted it by an unread import graph.
 */

const backendRoot = join(__dirname, '..', '..');
const srcRoot = join(backendRoot, 'src');

/** Every `.ts` file under `dir`, recursively. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found.sort();
}

/**
 * The file's code, with every comment blanked out and its newlines kept so line
 * numbers still point at the right line.
 *
 * Not optional: this gate is read by whoever it fails, so the docblocks that
 * explain it quote `pgEnum('build_type', …)` in prose — and without this the
 * *explanation* of the duplicate is itself reported as one, which is a gate
 * that punishes the comment the house style asks for. The narrow cost is a
 * `//` inside a string literal (a URL) truncating the rest of that line; no
 * `pgEnum` call in the tree shares a line with one, and a declaration that did
 * would fail loudly here rather than pass quietly.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (found) =>
    found.replace(/[^\n]/g, ' '),
  );
}

interface EnumDeclaration {
  /** The Postgres type name — `pgEnum`'s first argument. */
  readonly name: string;
  /** Path relative to `backend/`, so a failure is a thing you can open. */
  readonly file: string;
  readonly line: number;
}

/**
 * Every `pgEnum('…')` call in `src`, wherever it sits.
 *
 * Matched on the source text rather than on a parsed AST: the whole tree writes
 * the name as a literal first argument — a computed one would be a `pgEnum`
 * whose Postgres type name cannot be read from the file that declares it, which
 * is a worse problem than a duplicate and is not one this gate has to model
 * until it exists.
 */
function pgEnumDeclarations(): EnumDeclaration[] {
  const declared: EnumDeclaration[] = [];
  const call = /\bpgEnum\(\s*(['"`])([^'"`]+)\1/g;

  for (const path of walk(srcRoot)) {
    const text = withoutComments(readFileSync(path, 'utf8'));
    for (const match of text.matchAll(call)) {
      declared.push({
        name: match[2],
        file: relative(backendRoot, path),
        // The line the call opens on, counted from the match's own offset so
        // it survives a declaration spanning several lines.
        line: text.slice(0, match.index).split('\n').length,
      });
    }
  }
  return declared;
}

/**
 * Every module `src/db/schema.ts` re-exports, transitively.
 *
 * That file is `drizzle.config.ts`'s `schema`, so this set *is* what
 * `drizzle-kit generate` diffs the database against. The walk follows
 * `export * from` through whatever it reaches; nothing in the tree chains
 * today, and the day one does, this stays right rather than quietly narrowing.
 */
function schemaClosure(): Set<string> {
  const entry = join(srcRoot, 'db', 'schema.ts');
  const reached = new Set<string>([entry]);
  const pending = [entry];

  while (pending.length > 0) {
    const path = pending.pop() as string;
    const text = withoutComments(readFileSync(path, 'utf8'));
    for (const [, specifier] of text.matchAll(/^export \* from '([^']+)'/gm)) {
      const resolved = `${resolve(dirname(path), specifier)}.ts`;
      if (!reached.has(resolved)) {
        reached.add(resolved);
        pending.push(resolved);
      }
    }
  }
  return reached;
}

// The title opens with the path rather than a symbol, on
// `harness-js-is-linted.spec.ts`'s precedent and by the same escape in
// `describe-names.spec.ts`: the unit under test is a *file's* export list, and
// no name `src` binds says "the schema drizzle-kit diffs". The separator is a
// spaced em dash rather than a comma because that gate splits the title on
// whitespace and tests the first token with `existsSync` — a comma welded to
// the path makes it a path that does not exist.
describe('backend/src/db/schema.ts — the pgEnum names src declares', () => {
  it('declares each Postgres enum type in exactly one place', () => {
    const byName = new Map<string, EnumDeclaration[]>();
    for (const found of pgEnumDeclarations()) {
      byName.set(found.name, [...(byName.get(found.name) ?? []), found]);
    }

    const duplicated = [...byName.entries()]
      .filter(([, sites]) => sites.length > 1)
      .map(
        ([name, sites]) =>
          `${name}: ${sites.map((s) => `${s.file}:${s.line}`).join(', ')}`,
      )
      .sort();

    expect(duplicated).toEqual([]);
  });

  it('declares every Postgres enum type in a module the schema re-exports', () => {
    const closure = schemaClosure();

    const invisible = pgEnumDeclarations()
      .filter((found) => !closure.has(join(backendRoot, found.file)))
      .map((found) => `${found.name}: ${found.file}:${found.line}`)
      .sort();

    expect(invisible).toEqual([]);
  });

  /**
   * The gate on the gate: both assertions above pass trivially if the walk
   * stops finding declarations — a moved `src`, a renamed `pgEnum`, a regex
   * that stopped matching. The count is the tree's, re-measured on 2026-09-09,
   * and it is a floor rather than an equality so a new enum does not fail an
   * unrelated change.
   */
  it('reads a schema tree that still declares enums', () => {
    expect(pgEnumDeclarations().length).toBeGreaterThanOrEqual(25);
    expect(schemaClosure().size).toBeGreaterThanOrEqual(45);
  });
});
