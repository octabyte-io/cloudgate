import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

/**
 * **Everything a delete can answer with reaches the console** (closing
 * the class of unrendered teardown fields).
 *
 * The defect this exists for is one mistake made four times over nine tickets.
 * A delete learns to report an artifact it could not reclaim — the source tree
 * the Traefik config and the patch-repo clone, the file-mounts
 * tree, and a managed database's file mounts — and each time the
 * field is added to the response and **nothing renders it**. At one point,
 * `grep -rn "unreclaimed" frontend/` returned nothing at all: four fields, zero
 * consumers, over five weeks.
 *
 * **Why that is worse than an unrendered field usually is.** The row is gone
 * from the database by the time the body is written. `teardown-steps.ts`'
 * `UnreclaimedArtifact` docblock says it outright — the response is *"the last
 * place the triple (kind, machine, path) exists"* — so there is no route to ask
 * again and nothing to come back to. A field dropped here is a leaked path an
 * operator can never learn about, and for `'traefik-config'` it is a public
 * hostname still answering 404 at the edge, and for `'file-mounts'` it is the
 * last copy in existence of the operator's own file bodies, in plaintext
 * (ADR-0015).
 *
 * **Why a census rather than a UI test.** A test that renders the panel with a
 * fixture proves the fields in the fixture are rendered, and the fixture is
 * written by the same person adding the field — so the field they forget in the
 * component is the field they forget in the fixture. This asks the *backend's
 * own declarations* what a delete can answer with and holds the console to
 * that set, which is the thing a fixture cannot do. Same argument as
 * `platform-root-call-sites.spec.ts`: an enumeration built from the producer
 * cannot miss a producer.
 *
 * **What is asserted, in both directions.**
 *
 * 1. The `UnreclaimedArtifactKind` union and the console's copy table have
 *    exactly the same members. A new kind with no copy renders a bare slug on
 *    the one surface where the operator has no other source of information; a
 *    copy entry for a kind the backend cannot send is dead reassurance.
 * 2. Every "left behind" field on `CascadeDeleted` appears on the console's
 *    `TeardownReport`. This is the one that was failing for five weeks.
 * 3. Every field of `TeardownReport` is read by **both** `teardownReportIsEmpty`
 *    and `teardownReportCount`. A field the predicate does not read is worse
 *    than an unrendered one: the panel is skipped entirely, so the delete looks
 *    clean.
 *
 * **What deliberately is not.** Whether the rendering is *good* — that is
 * design, and `teardown.test.ts` covers the copy table's shape. And whether a
 * reclamation exists for every artifact the platform creates, which is the
 * other half of this class and is not statically
 * decidable from here: it needs the set of things a build and a deploy write,
 * and nothing enumerates that. This gate holds the *reporting* half, which is
 * the half that silently loses information.
 */

const backendRoot = join(__dirname, '..', '..');
const repoRoot = join(backendRoot, '..');
const consoleTeardown = join(
  repoRoot,
  'frontend',
  'src',
  'lib',
  'api',
  'endpoints',
  'teardown.ts',
);

const parse = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

/** The string members of a `type X = 'a' | 'b'` union declaration. */
function unionMembers(source: ts.SourceFile, name: string): string[] {
  let found: string[] | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === name &&
      ts.isUnionTypeNode(node.type)
    ) {
      found = node.type.types
        .filter(ts.isLiteralTypeNode)
        .map((t) => t.literal)
        .filter(ts.isStringLiteral)
        .map((l) => l.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found)
    throw new Error(`no string union named ${name} in ${source.fileName}`);
  return found.sort();
}

/** The property names of an `interface X {}` or `type X = { … }` declaration. */
function memberNames(source: ts.SourceFile, name: string): string[] {
  let found: string[] | undefined;
  const collect = (members: ts.NodeArray<ts.TypeElement>) =>
    members
      .filter(ts.isPropertySignature)
      .map((m) => (ts.isIdentifier(m.name) ? m.name.text : undefined))
      .filter((n): n is string => n !== undefined);

  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      found = collect(node.members);
    }
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      // `CascadeDeleted<TRow> = TRow & { … }` — the object half of the
      // intersection is where the report fields are declared.
      const literals = ts.isIntersectionTypeNode(node.type)
        ? node.type.types.filter(ts.isTypeLiteralNode)
        : ts.isTypeLiteralNode(node.type)
          ? [node.type]
          : [];
      found = literals.flatMap((l) => collect(l.members));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`no type named ${name} in ${source.fileName}`);
  return found.sort();
}

/** The keys of an object literal assigned to `const NAME = { … }`. */
function objectKeys(source: ts.SourceFile, name: string): string[] {
  let found: string[] | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      found = node.initializer.properties
        .filter(ts.isPropertyAssignment)
        .map((p) =>
          ts.isStringLiteral(p.name) || ts.isIdentifier(p.name)
            ? p.name.text
            : undefined,
        )
        .filter((n): n is string => n !== undefined);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`no object literal named ${name}`);
  return found.sort();
}

/** The source text of a named function declaration, for a "does it read X" check. */
function functionText(source: ts.SourceFile, name: string): string {
  let found: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`no function named ${name}`);
  return found;
}

describe('UnreclaimedArtifact, on every field a delete can report and the console must render', () => {
  const teardownSteps = parse(
    join(backendRoot, 'src', 'common', 'teardown-steps.ts'),
  );
  const serviceCascade = parse(
    join(backendRoot, 'src', 'common', 'service-cascade.ts'),
  );
  const console_ = parse(consoleTeardown);

  it('gives every artifact kind the backend can send its own copy in the console', () => {
    expect(objectKeys(console_, 'UNRECLAIMED_ARTIFACT_KIND')).toStrictEqual(
      unionMembers(teardownSteps, 'UnreclaimedArtifactKind'),
    );
  });

  it("mirrors the backend's kind union in the console's own union", () => {
    // Two spellings of one list, because the console cannot import from the
    // backend. This is the assertion that makes the duplicate safe.
    expect(unionMembers(console_, 'UnreclaimedArtifactKind')).toStrictEqual(
      unionMembers(teardownSteps, 'UnreclaimedArtifactKind'),
    );
  });

  /**
   * `CascadeDeleted` is where a delete's report fields are declared, and every
   * one of them is a thing an operator may have to act on. The console's
   * `TeardownReport` may carry *more* than this — a per-engine delete adds
   * nothing today, but a field that reaches only one route would be legitimate
   * — so the direction asserted is that nothing on the backend is missing from
   * the console, not that the two are identical.
   */
  it('renders every left-behind field a cascade delete can answer with', () => {
    const backendFields = memberNames(serviceCascade, 'CascadeDeleted');
    const consoleFields = memberNames(console_, 'TeardownReport');
    expect(
      backendFields.filter((f) => !consoleFields.includes(f)),
    ).toStrictEqual([]);
  });

  it('reads every report field when deciding whether a delete was clean', () => {
    // A field the predicate does not read is worse than an unrendered one: the
    // panel never opens, so the delete reads as clean and the operator is told
    // nothing at all.
    const isEmpty = functionText(console_, 'teardownReportIsEmpty');
    const count = functionText(console_, 'teardownReportCount');
    for (const field of memberNames(console_, 'TeardownReport')) {
      expect(isEmpty).toContain(field);
      expect(count).toContain(field);
    }
  });
});
