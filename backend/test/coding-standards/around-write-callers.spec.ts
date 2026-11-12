import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * **Every `around*Write` protocol `src/traefik` exports is called from `src`**.
 *
 * The defect this exists for was not a wrong line anywhere. `aroundConsoleWrite`
 * — "Anchor, write, then look" — was written, documented down to the two writers
 * it names, covered by a unit spec that drove it directly, and **never invoked
 * by anything in `src`**. So the Console routing card refreshed only on the back
 * of an unrelated Application's regeneration, which is precisely the fallback
 * the method's own docblock describes as what it was meant to improve on, and an
 * operator read a 55-minute-old observation of somebody else's write as the
 * verdict on the console domain they had just saved.
 *
 * **Why a census rather than more tests of the protocol.** Every test the
 * protocol had passed with zero callers, because a spec that constructs its
 * subject proves the subject works and says nothing about whether the product
 * reaches it. Nor would a reviewer have caught it: the docblock *reads* like a
 * wiring description, and the one thing that distinguishes "is called by
 * `updateServerTraefik`" from "is for `updateServerTraefik`" is a grep nobody
 * has a reason to run. That is the shape this file makes mechanical.
 *
 * **Scope is deliberately this one class of method in this one directory** and
 * not "exports with no callers" at large. The narrow question has an
 * unambiguous answer — an observe-around-a-write wrapper is inert unless a
 * writer wraps itself in it, and there is no legitimate reason for one to exist
 * uncalled — whereas the general question does not: `logsDirectory` is an export
 * with no call site in `src` on purpose, and `test/coding-standards/platform-root-call-sites.spec.ts`
 * documents that. A rule that would flag it is a rule that gets suppressed.
 *
 * **What is asserted.** That the walk finds the protocol at all — a rename must
 * fail this file rather than empty it — and that each one it finds is called
 * from at least one file in `src` other than the one that defines it. A call in
 * the defining file is not wiring: `verifyConsoleInBackground` calls
 * `verifyConsole`, which is the method being packaged rather than a writer
 * reaching for the package.
 *
 * Not asserted: *which* writers call it, or that every writer of a watched
 * Traefik file does. Both need a call graph this parser does not have, and the
 * second is a judgement about what counts as a console write — which is what the
 * docblock is for. What this buys is that the protocol cannot go back to having
 * none.
 */

const backendRoot = join(__dirname, '..', '..');
const srcRoot = join(backendRoot, 'src');
const traefikRoot = join(srcRoot, 'traefik');

/** `aroundConsoleWrite`, and any sibling a later writer's protocol adds. */
const AROUND_WRITE = /^around[A-Z][A-Za-z0-9]*Write$/;

/** Every `.ts` file under `dir`, recursively. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );

const repoPath = (path: string): string =>
  relative(backendRoot, path).split('\\').join('/');

interface Protocol {
  readonly name: string;
  /** Repo-relative, from `backend/`, so a failure is a thing you can open. */
  readonly file: string;
}

/**
 * The public `around*Write` methods of every exported class in `src/traefik`.
 *
 * Read from the parser rather than by grep for the reason
 * `platform-root-call-sites.spec.ts` gives: these names appear far more often in
 * prose than in code, and a docblock naming a call site is the exact thing this
 * ticket is about not trusting.
 */
function protocols(): Protocol[] {
  const found: Protocol[] = [];
  for (const path of walk(traefikRoot).sort()) {
    const source = parse(path);
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      const exported = statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!exported) continue;

      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        if (!ts.isIdentifier(member.name)) continue;
        const isPrivate = member.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
        );
        if (isPrivate) continue;
        if (!AROUND_WRITE.test(member.name.text)) continue;
        found.push({ name: member.name.text, file: repoPath(path) });
      }
    }
  }
  return found;
}

/**
 * Which files in `src` call `x.<name>(…)`, the defining file excluded.
 *
 * A property access rather than a resolved symbol: the parser has no checker, so
 * `this.configStatus.aroundConsoleWrite(…)` is matched on the method name at the
 * end of it. That can only over-count — a second class with the same method name
 * would satisfy the census wrongly — and over-counting is the safe direction
 * here, because the failure being prevented is *zero* call sites rather than the
 * wrong ones.
 */
function callersOf(protocol: Protocol): string[] {
  const callers = new Set<string>();
  for (const path of walk(srcRoot)) {
    const file = repoPath(path);
    if (file === protocol.file) continue;

    const source = parse(path);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === protocol.name
      ) {
        callers.add(file);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...callers].sort();
}

describe('TraefikConfigStatusService.aroundConsoleWrite, and every around-a-write protocol src/traefik exports', () => {
  /**
   * The guard every census of this shape needs: a walk that finds nothing passes
   * the assertion below for the wrong reason, and renaming the method is exactly
   * how it would come to find nothing.
   */
  it('finds the console write protocol at all', () => {
    expect(protocols().map(({ name }) => name)).toContain('aroundConsoleWrite');
  });

  it('leaves no around-a-write protocol without a caller in src', () => {
    const uncalled = protocols()
      .filter((protocol) => callersOf(protocol).length === 0)
      .map(
        ({ name, file }) =>
          `${file} :: ${name}() is exported, documented and never called — the write it was written to observe is not wrapped in it`,
      );

    expect(uncalled).toEqual([]);
  });
});
