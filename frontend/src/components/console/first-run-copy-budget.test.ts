import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * **The first-run screens keep to the copy budget** (design-system.md
 * rule 8).
 *
 * The audit found the console explaining itself in the voice of its own design
 * notes: how the data model works, what is *not* true, why a table is empty. On
 * a first-run screen that copy is most of what is on the page, and the action
 * becomes the smallest thing there. The budget is:
 *
 * - a `PageHeader` `lede` is one sentence, and there is no `strap` under it;
 * - an empty-state body (an `EmptyState`'s children, a list card's `empty`, an
 *   empty output's `body`) is one or two sentences;
 * - a meta strip (a `<MetaStrip>`, a `VariablesCard`'s `meta`) is one sentence.
 *
 * "And the first names the next action" is half of the rule, and no census can
 * read it. That half is for review.
 *
 * **The census reads a list, not the tree.** The rest of the console has not
 * been brought within the budget yet, and the first-run path came
 * first, screen by screen. A screen joins `SCREENS` once its copy is within the
 * budget, and from then on this holds it there.
 *
 * What it reads in each file: every string literal or template literal (with
 * each `${…}` read as one word) that is a `lede=`, `strap=` or `empty=`
 * attribute, every text child of an `<EmptyState>` (the JSX text joined, and
 * each string literal inside a `{…}` counted on its own, since a ternary
 * between two bodies is two bodies), and every `body:` string in an object.
 * A value assembled at run time (`{empty.body}`) is read where it is declared,
 * or not at all.
 *
 * Falsified against these screens before their copy was cut: it reported nine. The
 * Templates `strap`, the Deployments strip's "build is a phase, not a synonym",
 * the "not inherited" strips over a Project's Environments and an
 * Environment's Services, and five variables `meta`s that each explained the
 * same rule in two or three sentences. The empty states it passed were within
 * the count but led with an explanation rather than the action. That is the
 * half of the rule no census reads.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCREENS = [
  "app/(console)/_components/home/organization-home.tsx",
  "features/project/projects-screen.tsx",
  "features/project/panels/environments.tsx",
  "features/environment/panels/services.tsx",
  "features/environment/panels/variables.tsx",
  "features/deployments/deployments-screen.tsx",
  "features/deployments/deployments-table-card.tsx",
  "features/templates/templates-screen.tsx",
  "features/templates/catalogue-view.tsx",
  "features/application/panels/overview.tsx",
  "features/application/panels/variables.tsx",
  "components/console/variables-card.tsx",
];

type Copy = {
  file: string;
  kind: "lede" | "strap" | "empty" | "meta";
  text: string;
};

/** The literal text of a string or template literal; `${…}` reads as "X". */
function literal(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans.map((span) => `X${span.literal.text}`).join("")
    );
  }
  return null;
}

/** Every string or template literal anywhere under `node`. */
function literals(node: ts.Node): string[] {
  const own = literal(node);
  if (own !== null) return [own];
  const found: string[] = [];
  ts.forEachChild(node, (child) => {
    found.push(...literals(child));
  });
  return found;
}

/** The visible text of a JSX subtree's own text nodes, whitespace folded. */
function jsxText(node: ts.Node): string {
  if (ts.isJsxText(node)) return node.text;
  if (ts.isJsxExpression(node)) {
    // `{" "}` is a space, and anything else is read on its own.
    return node.expression && literal(node.expression) === " " ? " " : "";
  }
  let text = "";
  ts.forEachChild(node, (child) => {
    text += jsxText(child);
  });
  return text;
}

const fold = (text: string) => text.replace(/\s+/g, " ").trim();

function copyIn(file: string): Copy[] {
  const path = join(SRC, file);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: Copy[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText();
      if (name === "lede" || name === "strap" || name === "empty") {
        for (const text of literals(node.initializer)) {
          found.push({ file, kind: name, text });
        }
      }
      if (name === "meta") {
        const init = node.initializer;
        const markup =
          ts.isJsxExpression(init) && init.expression ? init.expression : init;
        const joined = fold(jsxText(markup));
        if (joined) found.push({ file, kind: "meta", text: joined });
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "body"
    ) {
      for (const text of literals(node.initializer)) {
        found.push({ file, kind: "empty", text });
      }
    }
    const tag = ts.isJsxElement(node)
      ? node.openingElement.tagName.getText()
      : null;
    if (ts.isJsxElement(node) && (tag === "EmptyState" || tag === "MetaStrip")) {
      const kind = tag === "EmptyState" ? "empty" : "meta";
      const joined = fold(node.children.map(jsxText).join(""));
      if (joined) found.push({ file, kind, text: joined });
      for (const child of node.children) {
        if (ts.isJsxExpression(child) && child.expression) {
          for (const text of literals(child.expression)) {
            // A count's noun ("Deployment" : "Deployments") is a word, not a body.
            if (/[.!?]/.test(text)) found.push({ file, kind, text });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Sentences in `text`: ends of sentence, plus one for an unpunctuated tail. */
function sentences(text: string): number {
  const plain = fold(text).replace(/\b(e\.g|i\.e)\./g, "$1");
  if (!plain) return 0;
  const ends = plain.match(/[.!?](?=\s|$)/g)?.length ?? 0;
  return /[.!?]$/.test(plain) ? ends : ends + 1;
}

const BUDGET = { lede: 1, strap: 0, empty: 2, meta: 1 } as const;

describe("sentences", () => {
  it("counts ends of sentence, and an unpunctuated tail as one", () => {
    expect(sentences("Add a Server.")).toBe(1);
    expect(sentences("Add a Server. It is reached over SSH.")).toBe(2);
    expect(sentences("Variables any service can reference by name")).toBe(1);
    expect(sentences("Set it, e.g. nightly, then save.")).toBe(1);
  });
});

describe("the first-run copy budget", () => {
  const copy = SCREENS.flatMap(copyIn);

  it("finds the copy it is meant to hold (a census that reads nothing passes)", () => {
    expect(copy.filter((one) => one.kind === "lede").length).toBeGreaterThan(5);
    expect(copy.filter((one) => one.kind === "empty").length).toBeGreaterThan(10);
    expect(copy.filter((one) => one.kind === "meta").length).toBeGreaterThan(5);
  });

  it("keeps every lede and meta strip to one sentence, every empty-state body to two, and no strap", () => {
    const over = copy
      .filter((one) => sentences(one.text) > BUDGET[one.kind])
      .map((one) => `${one.file} ${one.kind}: ${fold(one.text)}`);
    expect(over).toEqual([]);
  });
});
