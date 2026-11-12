import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { normalizeEmail } from '../../src/users/user-email';

/**
 * **Every write of `user.email` outside better-auth goes through
 * `normalizeEmail`**.
 *
 * better-auth looks a user up by the lower-cased address, an exact match on the
 * column, and lower-cases every write it makes itself. `PATCH /users/me` was
 * the one write that did not — `db.update(user).set({ ...data })` — so a saved
 * capital letter locked the account out for good. The fix is one line; what
 * this file is for is that a second route writing the column cannot bring the
 * lockout back without failing here.
 *
 * **The property.** Parsed, not grepped, for the reason
 * `platform-root-call-sites.spec.ts` gives (these names are everywhere in
 * prose). For each `.update(T).set(x)` and `.insert(T).values(x)` in `src`
 * where `T` is the `user` table — imported by name from a schema module, under
 * any alias, or reached as `schema.user` — `x` has to be an object literal (or
 * a `const` bound to one) that:
 *
 * - **spreads nothing.** A spread is exactly how the unnormalised email got in:
 *   the column was never named at the write, so nothing at the write could
 *   normalise it.
 * - sets `email`, if at all, from an expression that calls `normalizeEmail`,
 *   or from a `const` in the same file whose initializer does.
 *
 * An argument this parser cannot read (a parameter, a call result) fails too:
 * a write the census cannot see is the same hole as a spread.
 *
 * Not covered: `onConflictDoUpdate({ set })` and raw SQL, neither of which any
 * `src` write to this table uses. better-auth's own writes are not in `src` and
 * normalise themselves (`internal-adapter.mjs`).
 */

const backendRoot = join(__dirname, '..', '..');
const srcRoot = join(backendRoot, 'src');

const SCHEMA_MODULE = /(^|\/)(db\/schema|auth\.schema)$/;

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

interface UserWrite {
  /** `file:line`, repo-relative from `backend/`. */
  readonly at: string;
  /** Why it fails the property, or null when it holds. */
  readonly problem: string | null;
}

/** The local names this file gives the `user` table, and its schema namespaces. */
function userTableNames(source: ts.SourceFile): {
  direct: Set<string>;
  namespaces: Set<string>;
} {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const from = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (!SCHEMA_MODULE.test(from)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === 'user') direct.add(element.name.text);
      }
    }
  }
  return { direct, namespaces };
}

function callsNormalizeEmail(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === 'normalizeEmail'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Every `const <name> = <init>` in the file. */
function constInitializers(
  source: ts.SourceFile,
  name: string,
): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      found.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function objectProblem(
  source: ts.SourceFile,
  literal: ts.ObjectLiteralExpression,
): string | null {
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      return 'spreads a value into the row, so `email` can arrive un-normalised';
    }
    const name = property.name;
    if (!name || !ts.isIdentifier(name) || name.text !== 'email') continue;

    let value: ts.Expression | undefined;
    if (ts.isShorthandPropertyAssignment(property)) value = property.name;
    else if (ts.isPropertyAssignment(property)) value = property.initializer;
    if (!value) return 'sets `email` in a form this census cannot read';
    if (callsNormalizeEmail(value)) continue;
    if (
      ts.isIdentifier(value) &&
      constInitializers(source, value.text).some(callsNormalizeEmail)
    ) {
      continue;
    }
    return 'sets `email` without `normalizeEmail`';
  }
  return null;
}

function argumentProblem(
  source: ts.SourceFile,
  argument: ts.Expression | undefined,
): string | null {
  if (!argument) return 'writes nothing this census can read';
  if (ts.isObjectLiteralExpression(argument)) {
    return objectProblem(source, argument);
  }
  if (ts.isArrayLiteralExpression(argument)) {
    for (const element of argument.elements) {
      const problem = argumentProblem(source, element);
      if (problem) return problem;
    }
    return null;
  }
  if (ts.isIdentifier(argument)) {
    const [init] = constInitializers(source, argument.text);
    if (init && ts.isObjectLiteralExpression(init)) {
      return objectProblem(source, init);
    }
  }
  return 'writes a value this census cannot read (not an object literal)';
}

/** The `user`-table writes in one source file, judged. */
function userEmailWrites(path: string, text: string): UserWrite[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const { direct, namespaces } = userTableNames(source);
  const isUserTable = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && direct.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      node.name.text === 'user');

  const writes: UserWrite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['update', 'insert'].includes(node.expression.name.text) &&
      node.arguments.length === 1 &&
      isUserTable(node.arguments[0])
    ) {
      const verb = node.expression.name.text === 'update' ? 'set' : 'values';
      const access = node.parent;
      const call = access?.parent;
      const line =
        source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const at = `${relative(backendRoot, path).split('\\').join('/')}:${line}`;
      if (
        ts.isPropertyAccessExpression(access) &&
        access.name.text === verb &&
        ts.isCallExpression(call)
      ) {
        writes.push({
          at,
          problem: argumentProblem(source, call.arguments[0]),
        });
      } else {
        writes.push({ at, problem: `has no .${verb}() this census can read` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return writes;
}

function census(): UserWrite[] {
  return walk(srcRoot)
    .sort()
    .flatMap((path) => userEmailWrites(path, readFileSync(path, 'utf8')));
}

describe('normalizeEmail', () => {
  it('stores the form better-auth looks an address up by', () => {
    expect(normalizeEmail('  Jane.Doe@Company.COM ')).toBe(
      'jane.doe@company.com',
    );
  });

  describe('as the one door every non-better-auth write of user.email uses', () => {
    it('leaves no write of the user table that could store an un-normalised email', () => {
      const offenders = census().filter((write) => write.problem !== null);
      expect(offenders).toEqual([]);
    });

    it('finds the writes it was frozen against, so a rename cannot empty it', () => {
      const files = census().map((write) => write.at.split(':')[0]);
      expect(files).toEqual(
        expect.arrayContaining([
          'src/users/users.service.ts',
          'src/enterprise/sso/sso.service.ts',
          'src/enterprise/scim/scim-tombstone.ts',
        ]),
      );
    });

    it('refuses the write the unnormalised email came from, and accepts the one that fixed it', () => {
      const imports =
        "import { user } from '../db/schema';\n" +
        "import { normalizeEmail } from './user-email';\n";

      const spread = userEmailWrites(
        'src/x.ts',
        `${imports}db.update(user).set({ ...data, updatedAt: new Date() });`,
      );
      expect(spread.map((w) => w.problem)).toEqual([
        'spreads a value into the row, so `email` can arrive un-normalised',
      ]);

      const raw = userEmailWrites(
        'src/x.ts',
        `${imports}db.update(user).set({ email: data.email });`,
      );
      expect(raw.map((w) => w.problem)).toEqual([
        'sets `email` without `normalizeEmail`',
      ]);

      const aliased = userEmailWrites(
        'src/x.ts',
        "import { user as u } from '../auth/auth.schema';\n" +
          'db.insert(u).values([{ email: input }]);',
      );
      expect(aliased.map((w) => w.problem)).toEqual([
        'sets `email` without `normalizeEmail`',
      ]);

      const fixed = userEmailWrites(
        'src/x.ts',
        `${imports}const email = normalizeEmail(data.email);\n` +
          'db.update(user).set({ firstName: data.firstName, email });',
      );
      expect(fixed.map((w) => w.problem)).toEqual([null]);
    });
  });
});
