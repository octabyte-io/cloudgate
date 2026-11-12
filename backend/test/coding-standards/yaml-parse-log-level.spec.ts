import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * The property, stated once:
 *
 * > no `parse` call from `yaml` in `src/` inherits the library's default
 * > `logLevel`
 *
 * **What broke.** `yaml`'s `parse` ends with
 * `doc.warnings.forEach(w => log.warn(doc.options.logLevel, w))`; the default
 * `logLevel` is `'warn'`; `log.warn` is `process.emitWarning`; and with no
 * application `warning` listener anywhere in the tree Node's own default
 * handler formats the warning onto process **stderr**. The warning is
 * prettified with the same `prettifyError(source, lineCounter)` an error gets,
 * so it carries the offending source line plus a caret — and the document still
 * *parses*, so no exception exists at any point and every guard the tree has is
 * downstream of a path that never reaches it. That was found at
 * `parseComposeFile` and fixed it there. Three months of call sites later,
 * `TraefikFilesService` and `TraefikWriterService` still had four `parse` calls
 * inheriting the default, which is what was filed next: not a new mechanism, the
 * same one, unfixed at four fifths of its call sites.
 *
 * **Nothing else was ever going to say so.** The option is optional by design
 * and its default is the *noisy* one, so omitting it compiles, passes every
 * test, and changes the observable behaviour of `parse` not at all — the
 * document parses either way and the return value is byte-identical. The only
 * difference is on a stream no assertion in the suite reads. A gate that reads
 * the source is the only thing that can hold it, which is `pg-enum-names.spec.ts`'
 * argument for the same shape: ESLint sees one file's AST and would need
 * `no-restricted-syntax` to encode "an options argument, possibly a shared
 * const declared in another module, containing this key".
 *
 * **What this deliberately does not cover, measured rather than assumed.**
 * `parseDocument` and `parseAllDocuments` prettify `doc.warnings` and hand them
 * back on the document; **only `parse` iterates them into `log.warn`**. So they
 * have no diagnostic channel to close, requiring the option of them would
 * assert a property the library does not have, and
 * `TraefikFilesService.toggleRequests` passes nothing on purpose. What is not
 * covered either, and would need its own rule: a caller that reads
 * `doc.warnings` off a `parseDocument` and logs them itself. That is the
 * caller's echo rather than the library's default, and no site in `src/` does
 * it today.
 *
 * `'silent'` is not accepted as satisfying this and is not special-cased to be
 * refused either: it was rejected on measurement — it makes `parse` *return* a
 * half-read document instead of throwing — and this gate asks only that the
 * option be *stated*, so a `'silent'` would be a visible decision in a diff
 * rather than an invisible inheritance. That is the whole of what a gate over
 * source can honestly claim.
 *
 * The last `describe` is the gate on the gate, and it is not a formality: every
 * assertion here passes trivially if the walk stops finding call sites, so the
 * detector is run against synthetic sources that must each be reported, and the
 * live count is held at a floor.
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

/** One `parse` call, and whether it stated a `logLevel`. */
interface ParseCall {
  /** Path relative to `backend/`, so a failure is a thing you can open. */
  readonly file: string;
  readonly line: number;
  readonly stated: boolean;
  /** What the options argument was, for a failure message worth reading. */
  readonly options: string;
}

/**
 * Module-scope `const NAME = { … }` object literals, by name, across `src/`.
 *
 * The resolution step, and the reason it exists rather than the gate demanding
 * an inline literal: the four Traefik sites share one exported
 * `TRAEFIK_YAML_PARSE_OPTIONS` precisely so they cannot drift apart again, and a
 * gate that only understood inline literals would push them back into four
 * copies to satisfy itself. Names are collected tree-wide rather than per-file
 * import graph — a shadowing local const of the same name would be resolved to
 * the wrong declaration, which is a false *pass* rather than a false failure and
 * is not reachable in this tree, where the one name involved is unique.
 */
function objectLiteralConstsIn(
  file: string,
  text: string,
): Map<string, string> {
  const byName = new Map<string, string>();
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = unwrapAssertion(declaration.initializer);
      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        byName.set(declaration.name.text, initializer.getText(source));
      }
    }
  }
  return byName;
}

/** {@link objectLiteralConstsIn}, merged over a set of files. */
function objectLiteralConsts(files: readonly string[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const file of files) {
    for (const [name, literal] of objectLiteralConstsIn(
      file,
      readFileSync(file, 'utf8'),
    )) {
      byName.set(name, literal);
    }
  }
  return byName;
}

/** `{ … } as const` / `<T>{ … }`, down to the literal underneath. */
function unwrapAssertion(node?: ts.Expression): ts.Expression | undefined {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Every call of `yaml`'s `parse` in one file's source, and what it passed.
 *
 * Takes the text rather than only the path so the last `describe` can run the
 * detector over sources that are not in the tree — which is the only way a gate
 * whose passing state is an empty list can be shown to be capable of failing.
 *
 * Both import forms are recognised, including a rename: `import { parse } from
 * 'yaml'`, `import { parse as yamlParse }`, and `import * as yaml from 'yaml'`
 * with `yaml.parse(…)`. A local `parse` from anywhere else is *not* a match —
 * the gate is about one library's default, and `JSON.parse` and
 * `date-fns`' `parse` share the name.
 */
function parseCallsIn(
  file: string,
  text: string,
  consts: Map<string, string>,
): ParseCall[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const named = new Set<string>();
  const namespaces = new Set<string>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'yaml'
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'parse') {
          named.add(element.name.text);
        }
      }
    }
  }

  if (named.size === 0 && namespaces.size === 0) return [];

  const calls: ParseCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isYamlParse(node, named, namespaces)) {
      // `parse(src, reviver?, options?)` — the options object is the second
      // argument or the third, so every trailing argument is a candidate rather
      // than one fixed position.
      const candidates = node.arguments.slice(1);
      const stated = candidates.some((argument) =>
        statesLogLevel(argument, source, consts),
      );
      calls.push({
        file: relative(backendRoot, file),
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        stated,
        options:
          candidates.map((a) => a.getText(source)).join(', ') || '(no options)',
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function isYamlParse(
  node: ts.CallExpression,
  named: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return named.has(callee.text);
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression)
  ) {
    return (
      callee.name.text === 'parse' && namespaces.has(callee.expression.text)
    );
  }
  return false;
}

/** Whether one argument states a `logLevel`, inline or through a shared const. */
function statesLogLevel(
  argument: ts.Expression,
  source: ts.SourceFile,
  consts: Map<string, string>,
): boolean {
  const unwrapped = unwrapAssertion(argument) ?? argument;
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return unwrapped.properties.some(
      (property) => property.name?.getText(source) === 'logLevel',
    );
  }
  if (ts.isIdentifier(unwrapped)) {
    // A `logLevel` key in the resolved literal's own text. The literal came out
    // of the AST, so a `logLevel` in a comment beside it cannot be what matches.
    return /\blogLevel\s*:/.test(consts.get(unwrapped.text) ?? '');
  }
  return false;
}

/** Every `yaml.parse` call `src/` makes. */
function parseCalls(): ParseCall[] {
  const files = walk(srcRoot);
  const consts = objectLiteralConsts(files);
  return files.flatMap((file) =>
    parseCallsIn(file, readFileSync(file, 'utf8'), consts),
  );
}

// The title opens with a path rather than a symbol, on
// `pg-enum-names.spec.ts`' precedent and by the same escape in
// `describe-names.spec.ts`: the unit under test is a property of a *tree*, and
// no name `src` binds says "every yaml.parse call site". The separator is a
// spaced em dash for that gate's reason — it splits the title on whitespace and
// tests the first token with `existsSync`, so a comma welded to the path makes
// it a path that does not exist.
describe('backend/src — the logLevel every yaml.parse call states', () => {
  it('leaves no parse call inheriting the library default', () => {
    const inherited = parseCalls()
      .filter((call) => !call.stated)
      .map((call) => `${call.file}:${call.line} :: ${call.options}`)
      .sort();

    expect(inherited).toEqual([]);
  });

  /**
   * The gate on the gate. Both halves matter: the walk has to still be finding
   * the tree's call sites, and the detector has to still be capable of
   * reporting one — an empty list is the passing state of the assertion above,
   * so every way of breaking this gate makes it pass rather than fail.
   */
  describe('the detector itself', () => {
    /** Re-measured on 2026-09-09: one in compose, two in each Traefik service. */
    it('reads a tree that still calls yaml.parse', () => {
      expect(parseCalls().length).toBeGreaterThanOrEqual(5);
      expect(
        new Set(parseCalls().map((call) => call.file)).size,
      ).toBeGreaterThanOrEqual(3);
    });

    it('resolves the shared options const the Traefik sites pass', () => {
      // Not a restatement of the assertion above: it is the *resolution* step
      // that is being pinned, because a bug in it reads as a pass. If
      // `TRAEFIK_YAML_PARSE_OPTIONS` stopped resolving, four call sites would
      // go red at once and the wrong conclusion — "inline the literal" — is the
      // easy one to draw.
      const traefik = parseCalls().filter((call) =>
        call.options.includes('TRAEFIK_YAML_PARSE_OPTIONS'),
      );

      expect(traefik.length).toBeGreaterThanOrEqual(4);
      expect(traefik.every((call) => call.stated)).toBe(true);
    });

    describe.each([
      ['a bare call', "import { parse } from 'yaml';\nparse(text);\n"],
      [
        'an options object with no logLevel',
        "import { parse } from 'yaml';\nparse(text, { maxAliasCount: 10 });\n",
      ],
      [
        'a renamed import',
        "import { parse as yamlParse } from 'yaml';\nyamlParse(text);\n",
      ],
      [
        'a namespace import',
        "import * as yaml from 'yaml';\nyaml.parse(text);\n",
      ],
      [
        'a shared const that carries no logLevel',
        "import { parse } from 'yaml';\nconst OPTIONS = { maxAliasCount: 10 };\nparse(text, OPTIONS);\n",
      ],
      [
        'a reviver with no options after it',
        "import { parse } from 'yaml';\nparse(text, reviver);\n",
      ],
    ])('reports %s', (_shape, text) => {
      it('as inheriting the default', () => {
        const found = parseCallsIn(
          'src/probe.ts',
          text,
          objectLiteralConstsIn('src/probe.ts', text),
        );

        expect(found).toHaveLength(1);
        expect(found[0].stated).toBe(false);
      });
    });

    describe.each([
      [
        'an inline logLevel',
        "import { parse } from 'yaml';\nparse(text, { logLevel: 'error' });\n",
      ],
      [
        'a logLevel behind a reviver',
        "import { parse } from 'yaml';\nparse(text, reviver, { logLevel: 'error' });\n",
      ],
      [
        'a shared const carrying one',
        "import { parse } from 'yaml';\nconst OPTIONS = { logLevel: 'error' } as const;\nparse(text, OPTIONS);\n",
      ],
    ])('accepts %s', (_shape, text) => {
      it('as stating the option', () => {
        // The shared-const case declares it in the probe source itself, so the
        // resolution map is built from that rather than from the tree.
        const found = parseCallsIn(
          'src/probe.ts',
          text,
          objectLiteralConstsIn('src/probe.ts', text),
        );

        expect(found).toHaveLength(1);
        expect(found[0].stated).toBe(true);
      });
    });

    it('ignores a parse that is not the library’s', () => {
      // `JSON.parse` and `date-fns`' `parse` share the name, and a gate that
      // demanded a `logLevel` of those would be unsatisfiable.
      expect(
        parseCallsIn(
          'src/probe.ts',
          "import { parse } from 'date-fns';\nparse(text);\nJSON.parse(text);\n",
          new Map(),
        ),
      ).toEqual([]);
    });

    it('ignores parseDocument, which has no diagnostic channel to close', () => {
      // The measured boundary of the rule, held here so a later reader does not
      // widen it: `parseDocument` prettifies `doc.warnings` and returns them,
      // and only `parse` iterates them into `log.warn`.
      expect(
        parseCallsIn(
          'src/probe.ts',
          "import { parseDocument } from 'yaml';\nparseDocument(text);\n",
          new Map(),
        ),
      ).toEqual([]);
    });
  });
});
