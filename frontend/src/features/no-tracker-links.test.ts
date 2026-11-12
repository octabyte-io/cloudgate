import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * **No console copy points at this project's repository**.
 *
 * Four sentences each stated a gap and linked the ticket that tracked it — "its
 * output is not kept — nothing streams a setup run", "there is no
 * endpoint to upload them", "not readable here …", "no way to list
 * those schedules". Every one of those tickets had closed, so every
 * sentence was false, and every link was dead to the person reading it: the
 * repository is private, and a self-hosting operator cannot open it. Nothing
 * tied a sentence to its ticket's state, and nothing can, so the rule is that
 * operator-facing copy does not cite the tracker at all.
 *
 * One mistake at more than one site is a census, not N assertions
 * (`CODING_STANDARDS.md` §1.7, "One mistake at N sites"). What it reads: every string the AST
 * holds in `src/` — JSX text, attribute values, string literals and template
 * parts — so an `href`, a hint in a spec object and a toast's description are
 * all in scope. **Comments are not**, and that is why this parses rather than
 * greps: a code comment citing a ticket is how this tree records *why*, it is
 * read only by someone with access, and `{/* … *\/}` inside JSX is a comment
 * too. `*.test.ts(x)` is out of scope (a fixture quotes URLs as data), and so is
 * `app/dev/**`, which is a development-only gallery.
 *
 * The backend half, for what Cloudgate *sends* rather than renders (the ntfy
 * test notification's button was the site there), is
 * `backend/test/coding-standards/no-repository-links.spec.ts`.
 *
 * ### Falsified
 *
 * Run over the four files as they stood before the fix, the detector
 * reported exactly the four `href`s it removed — in
 * `setup-command-card.tsx`, `source-card.tsx`, `backup-schedules-card.tsx` and
 * `destinations-spec.tsx` — and not the tracker URLs that
 * `delete-server-modal.tsx` and `local-shell-card.tsx` carry inside JSX
 * comments.
 */

const FEATURES = dirname(fileURLToPath(import.meta.url));
const SRC = join(FEATURES, "..");
const DEV = join(SRC, "app", "dev") + sep;

/** The project's repository, and every URL under it (issues, pulls, blobs). */
const REPOSITORY = /github\.com\/octabyte-io\/cloudgate\b/i;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!(here + sep).startsWith(DEV)) yield* sourceFiles(here);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield here;
    }
  }
}

/** `file:line :: text` for every string-shaped node naming the repository. */
function trackerLinksIn(file: string, text: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)) &&
      REPOSITORY.test(node.text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${file}:${line + 1} :: ${node.text.trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const files = [...sourceFiles(SRC)];

describe("no-tracker-links", () => {
  it("finds no rendered string pointing at the project's repository", () => {
    const links = files.flatMap((file) =>
      trackerLinksIn(relative(SRC, file), readFileSync(file, "utf8")),
    );

    expect(links).toEqual([]);
  });

  /**
   * The gate on the gate: an empty list is the passing state above, so every
   * way of breaking the walk or the detector would pass it.
   */
  describe("the detector itself", () => {
    it("walks the console's features and skips the dev gallery", () => {
      const walked = files.map((file) => relative(SRC, file));
      expect(walked.length).toBeGreaterThanOrEqual(500);
      expect(walked).toContain(
        join("features", "server", "settings", "setup-command-card.tsx"),
      );
      expect(walked.some((file) => file.startsWith(join("app", "dev")))).toBe(
        false,
      );
    });

    it.each([
      [
        "an href, the setup card's shape",
        '<a href="https://github.com/octabyte-io/cloudgate/issues/27">#26</a>',
      ],
      [
        "JSX text",
        "<p>See https://github.com/octabyte-io/cloudgate/issues/12 for why.</p>",
      ],
      [
        "a template in a hint",
        "const hint = `tracked at https://github.com/octabyte-io/cloudgate/issues/${n}`;",
      ],
      [
        "an expression-wrapped string",
        '<a href={"https://github.com/octabyte-io/cloudgate/issues/20"}>#20</a>',
      ],
    ])("reports %s", (_shape, text) => {
      expect(trackerLinksIn("synthetic.tsx", text)).toHaveLength(1);
    });

    it("does not report a comment, in code or in JSX", () => {
      const text = [
        "/** [#27](https://github.com/octabyte-io/cloudgate/issues/27) */",
        "// https://github.com/octabyte-io/cloudgate/issues/12",
        "const x = <p>{/* https://github.com/octabyte-io/cloudgate/issues/214 */}fine</p>;",
      ].join("\n");

      expect(trackerLinksIn("synthetic.tsx", text)).toEqual([]);
    });
  });
});
