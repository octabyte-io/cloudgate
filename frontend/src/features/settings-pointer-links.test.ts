import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { SETTINGS_SECTIONS } from "@/lib/settings/sections";

/**
 * **A sentence that sends the operator to a Settings screen links to it.**
 *
 * "Connect GitHub under Settings" and "Add one under Organization settings → AI"
 * were plain text,
 * the first on an Application page whose rail has no Settings entry at all. The
 * screen they name exists and has a route, so the sentence can take the
 * operator there in one click, and saying where without going there is the
 * dead pointer the ticket reports.
 *
 * One mistake at more than one site is a census, not N assertions
 * (`CODING_STANDARDS.md` §1.7, "One mistake at N sites"). What counts as a pointer:
 *
 * - "under Settings" / "under Organization settings", in any case; and
 * - "Settings → X" where X is the label of a real section in
 *   `lib/settings/sections.ts` — so "Settings → Developer settings" on GitHub
 *   or "Settings → Applications" in Gitea, which are other products' screens in
 *   a git-provider setup guide, are not pointers at ours. And "the Settings
 *   tab" is a Server's own tab, not this screen.
 *
 * A pointer in **JSX** passes when the innermost element whose text holds it —
 * the `<p>`, or the link itself once the words are a link — is or contains a
 * `Link`, `a` or `LinkButton` whose `href` reads `/settings…` or calls
 * `settingsHref(…)`. A pointer in a **string** (a hint, a description, an
 * attribute) always fails: a string cannot carry a link, and the fix is to
 * move the sentence into JSX.
 *
 * Parsed rather than grepped, as in `components/console/hint-backticks.test.tsx`:
 * the pointers here wrap across lines ("under Organization settings →\n AI"),
 * and a line-oriented grep cannot see those.
 *
 * `*.test.ts(x)` is out of scope — a fixture quotes the forbidden shape as data.
 *
 * The render halves are `application/source/no-connection.test.tsx` and
 * `integrations/ai/draft-service-modal.test.tsx`: this proves every pointer
 * carries *a* settings link, those prove the link goes to the section named.
 *
 * ### Falsified
 *
 * Against the tree before the fix it reported
 * `src/features/application/source/no-connection.tsx` and the three branches of
 * `src/features/integrations/ai/draft-service-modal.tsx` — the two sites it
 * fixed.
 */

/**
 * `src/…` file → why a pointer in it is not linked yet. Every entry must still
 * offend, so a fix that lands without deleting its line reds the second case.
 */
const KNOWN_UNLINKED: Record<string, string> = {};

const FEATURES = dirname(fileURLToPath(import.meta.url));
const SRC = join(FEATURES, "..");

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(here);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield here;
    }
  }
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LABELS = SETTINGS_SECTIONS.map((section) => escape(section.label)).join(
  "|",
);
const POINTERS = [
  /\bunder (?:the )?(?:organization )?settings\b(?! tab)/i,
  new RegExp(
    `\\b(?:organization )?settings\\s*(?:→|->)\\s*(?:${LABELS})\\b`,
    "i",
  ),
];

function pointsAtSettings(text: string): boolean {
  const flat = text.replace(/&rarr;/g, "→").replace(/\s+/g, " ");
  return POINTERS.some((pointer) => pointer.test(flat));
}

type Jsx = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment;

function isJsx(node: ts.Node): node is Jsx {
  return (
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node)
  );
}

/** What an element says, with its child elements' words in place. */
function textOf(node: Jsx): string {
  if (ts.isJsxSelfClosingElement(node)) return " ";
  return node.children
    .map((child) => {
      if (ts.isJsxText(child)) return child.text;
      if (isJsx(child)) return textOf(child);
      if (ts.isJsxExpression(child) && child.expression) {
        const inner = child.expression;
        if (ts.isStringLiteralLike(inner)) return inner.text;
        if (isJsx(inner)) return textOf(inner);
      }
      return " ";
    })
    .join("");
}

function childElements(node: Jsx): Jsx[] {
  if (ts.isJsxSelfClosingElement(node)) return [];
  return node.children.flatMap((child) => {
    if (isJsx(child)) return [child];
    if (ts.isJsxExpression(child) && child.expression && isJsx(child.expression)) {
      return [child.expression];
    }
    return [];
  });
}

function isSettingsLink(node: ts.Node): boolean {
  const opening = ts.isJsxElement(node)
    ? node.openingElement
    : ts.isJsxSelfClosingElement(node)
      ? node
      : null;
  if (!opening) return false;
  if (!["Link", "a", "LinkButton"].includes(opening.tagName.getText())) {
    return false;
  }
  return opening.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) &&
      attribute.name.getText() === "href" &&
      attribute.initializer !== undefined &&
      /["'`]\/settings\b|settingsHref\(/.test(attribute.initializer.getText()),
  );
}

function holdsSettingsLink(node: ts.Node): boolean {
  if (isSettingsLink(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found) found = holdsSettingsLink(child);
  });
  return found;
}

/** A string that is JSX body text — read as part of its element instead. */
function isElementText(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isJsxExpression(parent) &&
    (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))
  );
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
  }
  return null;
}

type Pointer = { at: string; linked: boolean };

/** Every sentence under `features/` that points at a Settings screen. */
function settingsPointers(): Pointer[] {
  const found: Pointer[] = [];

  for (const file of sourceFiles(FEATURES)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const where = (node: ts.Node) => {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      return `src/${relative(SRC, file).split(sep).join("/")}:${line + 1}`;
    };

    const visit = (node: ts.Node): void => {
      if (isJsx(node) && pointsAtSettings(textOf(node))) {
        // Only the innermost element holding the whole pointer is the site;
        // its parents hold the same words and would report it again.
        const inner = childElements(node).some((child) =>
          pointsAtSettings(textOf(child)),
        );
        if (!inner) {
          found.push({ at: where(node), linked: holdsSettingsLink(node) });
        }
      }

      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      const text = literalText(node);
      if (text !== null && !isElementText(node) && pointsAtSettings(text)) {
        found.push({ at: where(node), linked: false });
      }

      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }

  return found;
}

const fileOf = (at: string) => at.replace(/:\d+$/, "");

describe("a sentence pointing at a Settings screen", () => {
  const pointers = settingsPointers();

  it("links to it, everywhere under features/", () => {
    const offenders = pointers
      .filter(({ linked, at }) => !linked && !(fileOf(at) in KNOWN_UNLINKED))
      .map(({ at }) => at);

    expect(offenders).toEqual([]);

    // Not a vacuous pass: the two links the fix added are pointers still (the
    // Git providers one in `no-connection.tsx`, the AI one the draft dialog's
    // three sentences share), so a walk that found none has gone blind rather
    // than clean.
    const linked = pointers.filter((pointer) => pointer.linked);
    expect(linked.length).toBeGreaterThanOrEqual(2);
  });

  it("lists no known-unlinked file that no longer has an unlinked pointer", () => {
    const unlinked = new Set(
      pointers.filter(({ linked }) => !linked).map(({ at }) => fileOf(at)),
    );
    const stale = Object.keys(KNOWN_UNLINKED).filter(
      (file) => !unlinked.has(file),
    );

    expect(stale).toEqual([]);
  });
});
