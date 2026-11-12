import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { AGENT_ROLES } from '../../src/rbac/access-control';

/**
 * **`member.role` has exactly one writer** (ADR-0023).
 *
 * `src/rbac/member-role.ts` keeps an Agent on its two agent roles and a person
 * off both — which is what keeps an Agent off `admin`, and so off the
 * platform host, and what lets an audit row's role say whether a person or an
 * Agent acted. A rule held by one function is only as good as the count of
 * writers that go round it, and `member.role` had two before better-auth's
 * was closed: this file is what stops a third arriving in `src`.
 *
 * **The property.** Parsed, not grepped, for the reason
 * `user-email-writes.spec.ts` gives. For every `.update(T).set(x)` and
 * `.insert(T).values(x)` in `src` where `T` is the `member` table — imported
 * by name from a schema module, under any alias, or reached as
 * `schema.member` — outside `member-role.ts`:
 *
 * - **an update may not write `role`**: `x` has to be an object literal (or a
 *   `const` bound to one) that neither names `role` nor spreads anything, since
 *   a spread is a role write nothing at the call site can see — and whose
 *   computed keys, if any, are a parameter typed `AccessColumn`, the one
 *   computed key `src` writes (`PermissionService.grantAccess`);
 * - **an insert may write `role` only as a string literal naming a person's
 *   role** — the owner row of a new Organization, a provider's plain member —
 *   never a variable and never an agent role. An Agent's membership is
 *   written by `insertAgentMember`, in the writer.
 *
 * And inside `member-role.ts`, exactly one update and one insert, so the
 * writer itself cannot quietly grow a second, unguarded path.
 *
 * Not covered, and why that is enough: raw SQL, which no `src` write to this
 * table uses (the census fails if a template ever spells `UPDATE "member"`);
 * better-auth's own writes, which are not in `src` — its role write is closed
 * by `disabledPaths`, and so is its invite-member, so an
 * accepted invitation carries a role `inviteMember` has already validated;
 * and the test tree,
 * whose fixtures write roles straight to the table on purpose.
 */

const backendRoot = join(__dirname, '..', '..');
const srcRoot = join(backendRoot, 'src');
const WRITER = 'src/rbac/member-role.ts';

const SCHEMA_MODULE = /(^|\/)(db\/schema|organizations\.schema)$/;

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

interface MemberWrite {
  /** `file:line`, repo-relative from `backend/`. */
  readonly at: string;
  readonly verb: 'update' | 'insert';
  /** Why it fails the property, or null when it holds. */
  readonly problem: string | null;
}

/** The local names this file gives the `member` table, and schema namespaces. */
function memberTableNames(source: ts.SourceFile): {
  direct: Set<string>;
  namespaces: Set<string>;
} {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (statement.importClause?.isTypeOnly) continue;
    const from = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (!SCHEMA_MODULE.test(from)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    } else {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (imported === 'member') direct.add(element.name.text);
      }
    }
  }
  return { direct, namespaces };
}

/** The object literal a write passes, resolving a same-file `const`. */
function writtenObject(
  source: ts.SourceFile,
  argument: ts.Expression | undefined,
): ts.ObjectLiteralExpression[] | null {
  if (!argument) return null;
  if (ts.isObjectLiteralExpression(argument)) return [argument];
  if (ts.isArrayLiteralExpression(argument)) {
    const all: ts.ObjectLiteralExpression[] = [];
    for (const element of argument.elements) {
      const found = writtenObject(source, element);
      if (!found) return null;
      all.push(...found);
    }
    return all;
  }
  if (ts.isIdentifier(argument)) {
    let init: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === argument.text &&
        node.initializer &&
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        init = node.initializer;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (init && ts.isObjectLiteralExpression(init)) return [init];
  }
  return null;
}

/**
 * Whether a computed key is one of the three grant columns: an identifier
 * that is a parameter of the enclosing function annotated `AccessColumn`,
 * which is `PermissionService.grantAccess`'s shape. Any other computed key
 * could be `role`, and is unreadable.
 */
function isAccessColumnKey(name: ts.ComputedPropertyName): boolean {
  const key = name.expression;
  if (!ts.isIdentifier(key)) return false;
  for (let node: ts.Node | undefined = name; node; node = node.parent) {
    if (!ts.isFunctionLike(node)) continue;
    const parameter = node.parameters.find(
      (candidate) =>
        ts.isIdentifier(candidate.name) && candidate.name.text === key.text,
    );
    if (parameter) return parameter.type?.getText() === 'AccessColumn';
  }
  return false;
}

function roleProperty(
  literal: ts.ObjectLiteralExpression,
): ts.ObjectLiteralElementLike | 'unreadable' | undefined {
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) return 'unreadable';
    const name = property.name;
    if (name && ts.isComputedPropertyName(name) && !isAccessColumnKey(name)) {
      return 'unreadable';
    }
    if (name && ts.isIdentifier(name) && name.text === 'role') return property;
  }
  return undefined;
}

function updateProblem(
  source: ts.SourceFile,
  argument: ts.Expression | undefined,
): string | null {
  const objects = writtenObject(source, argument);
  if (!objects) return 'writes a value this census cannot read';
  for (const literal of objects) {
    const role = roleProperty(literal);
    if (role === 'unreadable') {
      return 'spreads or computes a key, so it can write `role` unseen';
    }
    if (role) return 'writes `role` outside the one writer';
  }
  return null;
}

function insertProblem(
  source: ts.SourceFile,
  argument: ts.Expression | undefined,
): string | null {
  const objects = writtenObject(source, argument);
  if (!objects) return 'writes a value this census cannot read';
  for (const literal of objects) {
    const role = roleProperty(literal);
    if (role === 'unreadable') {
      return 'spreads or computes a key, so it can write `role` unseen';
    }
    if (!role) return 'inserts a member without a `role`';
    if (!ts.isPropertyAssignment(role)) {
      return 'inserts a `role` that is not a string literal';
    }
    const value = role.initializer;
    if (!ts.isStringLiteral(value)) {
      return 'inserts a `role` that is not a string literal';
    }
    if ((AGENT_ROLES as readonly string[]).includes(value.text)) {
      return 'inserts an agent role outside the one writer';
    }
  }
  return null;
}

/** The `member`-table writes in one source file, judged. */
function memberWrites(path: string, text: string): MemberWrite[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const file = relative(backendRoot, path).split('\\').join('/');
  const { direct, namespaces } = memberTableNames(source);
  const isMemberTable = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && direct.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text) &&
      node.name.text === 'member');

  const writes: MemberWrite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['update', 'insert'].includes(node.expression.name.text) &&
      node.arguments.length === 1 &&
      isMemberTable(node.arguments[0])
    ) {
      const verb = node.expression.name.text as 'update' | 'insert';
      const chained = verb === 'update' ? 'set' : 'values';
      const access = node.parent;
      const call = access?.parent;
      const line =
        source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const at = `${file}:${line}`;
      if (
        ts.isPropertyAccessExpression(access) &&
        access.name.text === chained &&
        ts.isCallExpression(call)
      ) {
        const problem =
          file === WRITER
            ? null
            : verb === 'update'
              ? updateProblem(source, call.arguments[0])
              : insertProblem(source, call.arguments[0]);
        writes.push({ at, verb, problem });
      } else {
        writes.push({
          at,
          verb,
          problem: `has no .${chained}() this census can read`,
        });
      }
    }
    if (
      (ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isStringLiteral(node)) &&
      /\b(update\s+"?member"?\s+set|insert\s+into\s+"?member"?)\b/i.test(
        node.text,
      )
    ) {
      const line =
        source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      writes.push({
        at: `${file}:${line}`,
        verb: 'update',
        problem:
          'writes the member table in raw SQL, which this census cannot read',
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return writes;
}

function census(): MemberWrite[] {
  return walk(srcRoot)
    .sort()
    .flatMap((path) => memberWrites(path, readFileSync(path, 'utf8')));
}

describe('writeMemberRole', () => {
  describe('as the one writer of member.role', () => {
    it('leaves no write of the member table elsewhere that could set a role', () => {
      const offenders = census().filter((write) => write.problem !== null);
      expect(offenders).toEqual([]);
    });

    it('writes the column once for a change and once for an Agent’s membership', () => {
      const inWriter = census()
        .filter((write) => write.at.startsWith(`${WRITER}:`))
        .map((write) => write.verb)
        .sort();
      expect(inWriter).toEqual(['insert', 'update']);
    });

    it('finds the writes it was frozen against, so a rename cannot empty it', () => {
      const files = census().map((write) => write.at.split(':')[0]);
      expect(files).toEqual(
        expect.arrayContaining([
          WRITER,
          'src/organizations/organizations.service.ts',
          'src/auth/auth.config.ts',
          'src/rbac/permission.service.ts',
        ]),
      );
    });

    it('refuses the writes the rule exists for, and accepts the ones that stay', () => {
      const imports = "import { member } from '../db/schema';\n";
      const judge = (body: string) =>
        memberWrites('src/x.ts', imports + body).map((write) => write.problem);

      expect(judge("db.update(member).set({ role: 'admin' });")).toEqual([
        'writes `role` outside the one writer',
      ]);
      expect(judge('db.update(member).set({ ...changes });')).toEqual([
        'spreads or computes a key, so it can write `role` unseen',
      ]);
      expect(judge("db.update(member).set({ [key]: 'admin' });")).toEqual([
        'spreads or computes a key, so it can write `role` unseen',
      ]);
      expect(judge('db.update(member).set(changes);')).toEqual([
        'writes a value this census cannot read',
      ]);
      expect(
        judge("db.insert(member).values({ userId, role: 'agentOperator' });"),
      ).toEqual(['inserts an agent role outside the one writer']);
      expect(judge('db.insert(member).values({ userId, role });')).toEqual([
        'inserts a `role` that is not a string literal',
      ]);
      expect(
        memberWrites(
          'src/x.ts',
          "import { member as m } from '../organizations/organizations.schema';\n" +
            "db.update(m).set({ role: 'owner' });",
        ).map((write) => write.problem),
      ).toEqual(['writes `role` outside the one writer']);
      expect(
        memberWrites(
          'src/x.ts',
          "import * as schema from '../db/schema';\n" +
            "tx.update(schema.member).set({ role: 'owner' });",
        ).map((write) => write.problem),
      ).toEqual(['writes `role` outside the one writer']);
      expect(
        judge('db.execute(sql`UPDATE "member" SET role = ${r}`);'),
      ).toEqual([
        'writes the member table in raw SQL, which this census cannot read',
      ]);

      expect(judge('db.update(member).set({ isDefault: true });')).toEqual([
        null,
      ]);
      expect(
        judge(
          'function grant(column: AccessColumn) {\n' +
            '  db.update(member).set({ [column]: ids });\n' +
            '}',
        ),
      ).toEqual([null]);
      expect(
        judge("db.insert(member).values({ userId, role: 'owner' });"),
      ).toEqual([null]);
    });
  });
});
