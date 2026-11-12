import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * **Nothing in the console builds a person's name by hand.**
 *
 * Six components wrote `user.name?.trim() || user.email` each, and the account
 * menu a seventh variant without the trim, so when Settings → Account promised
 * the last name "wherever Cloudgate names you" there was no one place to add it
 * to — and none of them did.
 * `lib/format/person.ts` is that place now, and this census keeps it the only
 * one (`CODING_STANDARDS.md` §1.7, "One mistake at N sites").
 *
 * Two shapes count as building a name by hand, parsed rather than grepped so an
 * expression split across lines is still one expression:
 *
 * - **A name falling back to an address**: an `||` or `??` with a `.name` or
 *   `.firstName` read on one side and an `.email` read on the other —
 *   `user.name?.trim() || user.email`, `user.name ?? user.email ?? "…"`.
 * - **A first and last name joined**: an array literal, a template or a `+`
 *   that reads `.lastName` beside `.name` or `.firstName` —
 *   `[member.firstName, member.lastName].join(" ")`.
 *
 * Forms are not caught by either, and should not be: a form reads
 * `profile.lastName` into a field of its own, which is editing the columns, not
 * naming the person.
 *
 * `*.test.ts(x)` is out of scope, as is `lib/format/person.ts` itself.
 *
 * ### Falsified
 *
 * Against the tree before the fix it reported `avatar-menu.tsx`,
 * `members-card.tsx` (twice), `change-role-modal.tsx`, `manage-access-modal.tsx`,
 * `remove-member-modal.tsx`, `team-row.tsx` (twice) and
 * `role-members-modal.tsx` — every site the ticket names.
 */

/**
 * `src/…:LINE` → why this site builds a name by hand. Every entry must still
 * offend, so a fix that lands without deleting its line reds the second case.
 */
const DELIBERATELY_BY_HAND: Record<string, string> = {};

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELPER = "src/lib/format/person.ts";

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(here);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield here;
    }
  }
}

/** Every property name read anywhere under `node` (`a.b` and `a?.b` both). */
function reads(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (here: ts.Node): void => {
    if (ts.isPropertyAccessExpression(here)) names.add(here.name.text);
    ts.forEachChild(here, visit);
  };
  visit(node);
  return names;
}

const readsName = (names: Set<string>) => names.has("name") || names.has("firstName");

function fallsBackToEmail(node: ts.BinaryExpression): boolean {
  const kind = node.operatorToken.kind;
  if (
    kind !== ts.SyntaxKind.BarBarToken &&
    kind !== ts.SyntaxKind.QuestionQuestionToken
  ) {
    return false;
  }
  const left = reads(node.left);
  const right = reads(node.right);
  return (
    (readsName(left) && right.has("email")) ||
    (left.has("email") && readsName(right))
  );
}

function joinsNames(node: ts.Node): boolean {
  const isJoin =
    ts.isArrayLiteralExpression(node) ||
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken);
  if (!isJoin) return false;
  const names = reads(node);
  return names.has("lastName") && readsName(names);
}

type Site = { at: string };

function handBuiltNames(): { sites: Site[]; callers: string[] } {
  const sites: Site[] = [];
  const callers: string[] = [];

  for (const file of sourceFiles(SRC)) {
    const where = `src/${relative(SRC, file).split(sep).join("/")}`;
    if (where === HELPER) continue;
    const text = readFileSync(file, "utf8");
    if (/from "@\/lib\/format\/person"/.test(text)) callers.push(where);

    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const at = (node: ts.Node) => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      return `${where}:${line + 1}`;
    };

    const visit = (node: ts.Node): void => {
      if (
        (ts.isBinaryExpression(node) && fallsBackToEmail(node)) ||
        joinsNames(node)
      ) {
        sites.push({ at: at(node) });
        // The outermost expression is the site; `a || b || c` is one of them.
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return { sites, callers };
}

describe("a person's name", () => {
  const { sites, callers } = handBuiltNames();

  it("is built by lib/format/person.ts and nowhere else in the console", () => {
    // Not a vacuous pass: the masthead, the Members table, the three member
    // dialogs, the team rows and the custom-role members all name somebody
    // through the helper. A walk that saw none of them — a moved module, a
    // parse that read nothing — would leave the assertion below green.
    expect(callers.length).toBeGreaterThanOrEqual(7);

    const offenders = sites
      .map(({ at }) => at)
      .filter((at) => !(at in DELIBERATELY_BY_HAND));

    expect(offenders).toEqual([]);
  });

  it("lists no deliberate exception that no longer builds a name by hand", () => {
    const found = new Set(sites.map(({ at }) => at));
    const stale = Object.keys(DELIBERATELY_BY_HAND).filter((at) => !found.has(at));

    expect(stale).toEqual([]);
  });
});
