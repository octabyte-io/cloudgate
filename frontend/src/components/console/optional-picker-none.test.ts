import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * **Every optional picker offers its empty choice as an option.**
 *
 * An optional field's "none" was spelled as the `Picker`'s `placeholder` at two
 * sites — the
 * custom-git SSH key and the Build card's push registry. A placeholder shows only
 * while nothing is chosen, so once a key or a registry had been saved the list
 * held the chosen one and nothing else, and the field could never be set back.
 * `Picker` already has the answer (an option worth `""`, its `NONE` sentinel);
 * those two call sites did not use it while five others did.
 *
 * One mistake at two sites is a census, not two assertions
 * (`CODING_STANDARDS.md` §1.7, "One mistake at N sites"). What it covers are the two shapes an
 * optional picker is written in:
 *
 * - **JSX** — a `<Picker>` anywhere under a `<Field … optional>`.
 * - **A field spec** — an object literal with `kind: "select"` and
 *   `optional: true`, which `ResourceField` renders as a `Picker` under an
 *   optional `Field` (`resource-field.tsx`).
 *
 * The `options` pass when they are an array literal holding an element
 * `{ value: "", … }`, or an identifier bound in the same file to one. Anything
 * the parse cannot see into — a bare `.map(…)`, a value from another module — is
 * reported, because "cannot tell" is exactly how the two sites passed review. A
 * site that is optional and genuinely has no "none" is listed in
 * {@link DELIBERATELY_WITHOUT_NONE} with its reason; that list is empty today.
 *
 * One door from another module is read: the Service create forms' Server
 * picker (`useCreateServerPicker`). Its `options(…)` holds `""` (this
 * Cloudgate host) exactly when its `optional` is true: the Hosted instance
 * leaves the host out (ADR-0053), and a cloud Environment offers it under a
 * value of its own so that `""` is nothing chosen — so such a `Picker`
 * passes only under a `Field optional={picker.optional}` naming the same
 * binding: the field is optional precisely while the empty choice is offered,
 * and a bare `optional` over it is still reported.
 * `create-server-picker.test.tsx` proves the hook's half (host offered
 * self-hosted, left out hosted, asked for in a cloud Environment).
 *
 * The component test beside the two forms (`optional-pickers.test.tsx`) is the
 * other half: this proves the sites agree, that one proves what picking the
 * empty choice *does* — it saves `null`.
 *
 * ### Falsified
 *
 * Run with the two forms as they were before the fix, it reports exactly the
 * `Picker` in `BuildForm` and the one in `CustomGitForm`, the two known
 * sites, and nothing else; the fix turns it green.
 */

/** `src/…:LINE` → why this optional picker deliberately has no empty option. */
const DELIBERATELY_WITHOUT_NONE: Record<string, string> = {};

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(here);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield here;
    }
  }
}

type Site = { at: string; offersNone: boolean };

function openingOf(
  node: ts.Node,
): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  if (ts.isJsxElement(node)) return node.openingElement;
  if (ts.isJsxSelfClosingElement(node)) return node;
  return null;
}

function jsxAttribute(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): ts.JsxAttribute | undefined {
  return element.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

/** `optional`, `optional={true}` — anything but an explicit `false`. */
function isOptionalField(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): boolean {
  if (element.tagName.getText() !== "Field") return false;
  const attribute = jsxAttribute(element, "optional");
  if (!attribute) return false;
  const value = attribute.initializer;
  if (!value) return true;
  return !(
    ts.isJsxExpression(value) &&
    value.expression?.kind === ts.SyntaxKind.FalseKeyword
  );
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (one): one is ts.PropertyAssignment =>
      ts.isPropertyAssignment(one) &&
      (ts.isIdentifier(one.name) || ts.isStringLiteralLike(one.name)) &&
      one.name.text === name,
  );
}

/** The names this file binds to `useCreateServerPicker()`. */
function serverPickerBindings(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "useCreateServerPicker"
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** `optional={X.optional}` → `X`, else null. */
function serverPickerOptionalOf(
  field: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): string | null {
  const value = jsxAttribute(field, "optional")?.initializer;
  if (!value || !ts.isJsxExpression(value) || !value.expression) return null;
  const read = value.expression;
  return ts.isPropertyAccessExpression(read) &&
    ts.isIdentifier(read.expression) &&
    read.name.text === "optional"
    ? read.expression.text
    : null;
}

/** `X.options(…)` → `X`, else null. */
function serverPickerOptionsOf(
  expression: ts.Expression | undefined,
): string | null {
  return expression &&
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.name.text === "options"
    ? expression.expression.expression.text
    : null;
}

/** An array literal with an element `{ value: "" }`, or a same-file const bound to one. */
function offersNone(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
): boolean {
  let here = expression;
  while (
    here &&
    (ts.isAsExpression(here) ||
      ts.isParenthesizedExpression(here) ||
      ts.isSatisfiesExpression(here))
  ) {
    here = here.expression;
  }
  if (!here) return false;

  if (ts.isIdentifier(here)) {
    const name = here.text;
    let bound: ts.Expression | undefined;
    const find = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name
      ) {
        bound = node.initializer;
      }
      if (!bound) ts.forEachChild(node, find);
    };
    find(source);
    return bound ? offersNone(bound, source) : false;
  }

  if (!ts.isArrayLiteralExpression(here)) return false;
  return here.elements.some((element) => {
    if (!ts.isObjectLiteralExpression(element)) return false;
    const value = property(element, "value")?.initializer;
    return (
      value !== undefined && ts.isStringLiteralLike(value) && value.text === ""
    );
  });
}

/** Every optional picker in the console, and whether it offers `""`. */
function optionalPickers(): Site[] {
  const sites: Site[] = [];

  for (const file of sourceFiles(SRC)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const at = (node: ts.Node) => {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      return `src/${relative(SRC, file).split(sep).join("/")}:${line + 1}`;
    };

    const serverPickers = serverPickerBindings(source);

    type OptionalField = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
    const visit = (
      node: ts.Node,
      underOptionalField: OptionalField | null,
    ): void => {
      const element = openingOf(node);
      let optional = underOptionalField;

      if (element) {
        if (element.tagName.getText() === "Field") {
          optional = isOptionalField(element) ? element : null;
        }
        if (element.tagName.getText() === "Picker" && underOptionalField) {
          const initializer = jsxAttribute(element, "options")?.initializer;
          const options =
            initializer && ts.isJsxExpression(initializer)
              ? initializer.expression
              : undefined;
          const serverPicker = serverPickerOptionsOf(options);
          sites.push({
            at: at(element),
            offersNone:
              serverPicker !== null && serverPickers.has(serverPicker)
                ? serverPickerOptionalOf(underOptionalField) === serverPicker
                : offersNone(options, source),
          });
        }
      }

      if (ts.isObjectLiteralExpression(node)) {
        const kind = property(node, "kind")?.initializer;
        const isOptional = property(node, "optional")?.initializer;
        if (
          kind &&
          ts.isStringLiteralLike(kind) &&
          kind.text === "select" &&
          isOptional?.kind === ts.SyntaxKind.TrueKeyword
        ) {
          sites.push({
            at: at(node),
            offersNone: offersNone(
              property(node, "options")?.initializer,
              source,
            ),
          });
        }
      }

      ts.forEachChild(node, (child) => visit(child, optional));
    };
    visit(source, null);
  }

  return sites;
}

describe("an optional picker", () => {
  const sites = optionalPickers();

  it("offers its empty choice as an option everywhere in the console", () => {
    // Not a vacuous pass: seven JSX sites and four field specs when this was
    // written. A walk that found none — a renamed component, a parse that saw
    // nothing — would leave the assertion below green over an empty list.
    expect(sites.length).toBeGreaterThanOrEqual(10);

    const offenders = sites
      .filter(
        ({ at, offersNone }) =>
          !offersNone && !(at in DELIBERATELY_WITHOUT_NONE),
      )
      .map(({ at }) => at);

    expect(offenders).toEqual([]);
  });

  it("lists no deliberate exception that is not an optional picker without one", () => {
    const without = new Set(
      sites.filter(({ offersNone }) => !offersNone).map(({ at }) => at),
    );
    const stale = Object.keys(DELIBERATELY_WITHOUT_NONE).filter(
      (at) => !without.has(at),
    );

    expect(stale).toEqual([]);
  });
});
