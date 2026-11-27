import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * **No console copy sends a user to a file in this repository** (#187).
 *
 * The Console domain card ended its warning with "(docs/deploy.md §3)", and
 * the reset-password screen with "(docs/deploy.md, "Locked out")". A person
 * using the console has the console, not a checkout of its source, so a path
 * into the repository is a reference nobody reading it can follow. The steps
 * the reference stood for belong in the sentence itself, or behind a link to
 * the public docs (`features/help/help-links.ts`).
 *
 * The sibling of `no-tracker-links.test.ts`, and scoped the same way: every
 * string the AST holds in `src/` (JSX text, attribute values, string literals,
 * template parts), **never comments**, since a comment citing `docs/deploy.md`
 * is how this tree records why and is read only by someone with the source.
 * `*.test.ts(x)` and `app/dev/**` are out of scope, as there.
 *
 * **What counts as a repository file is enumerated, not listed**: every
 * Markdown file in the repository, by its path from the root and, inside a
 * package, from that package (`frontend/docs/design-system.md` is also
 * `docs/design-system.md`). A document added tomorrow is covered the day it
 * lands.
 *
 * ### Falsified
 *
 * Run over the tree before the fix, it reported exactly the two strings the
 * fix rewrote: `console-origin-remedy.tsx`'s `docs/deploy.md` span and the
 * text of `forgot-password-form.tsx`'s outcome; not the `docs/deploy.md`
 * citations in that file's JSX comment or in `two-factor-form.tsx`'s.
 */

const FEATURES = dirname(fileURLToPath(import.meta.url));
const SRC = join(FEATURES, "..");
const FRONTEND = join(SRC, "..");
const ROOT = join(FRONTEND, "..");
const DEV = join(SRC, "app", "dev") + sep;
const PACKAGES = ["frontend", "backend", "cli", "api-schemas"];
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "coverage"]);

function* walk(
  dir: string,
  keep: (file: string) => boolean,
): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) {
        yield* walk(here, keep);
      }
    } else if (keep(here)) {
      yield here;
    }
  }
}

/** Every way console copy could spell a Markdown file of this repository. */
function repositoryDocuments(): string[] {
  const spellings = new Set<string>();
  for (const file of walk(ROOT, (here) => here.endsWith(".md"))) {
    const path = relative(ROOT, file).split(sep).join("/");
    spellings.add(path);
    const [head, ...rest] = path.split("/");
    if (PACKAGES.includes(head) && rest.length > 0)
      spellings.add(rest.join("/"));
  }
  return [...spellings];
}

const DOCUMENTS = repositoryDocuments();

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAMES_A_DOCUMENT = new RegExp(
  `(?:^|[^\\w./-])(?:${DOCUMENTS.map(escape).join("|")})(?![\\w/-])`,
);

/** `file:line :: text` for every string-shaped node naming a repository file. */
function repositoryPathsIn(file: string, text: string): string[] {
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
      NAMES_A_DOCUMENT.test(node.text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${file}:${line + 1} :: ${node.text.trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const files = [
  ...walk(
    SRC,
    (here) =>
      /\.tsx?$/.test(here) &&
      !/\.test\.tsx?$/.test(here) &&
      !here.startsWith(DEV),
  ),
];

describe("no-repository-file-paths", () => {
  it("finds no rendered string naming a file in this repository", () => {
    const paths = files.flatMap((file) =>
      repositoryPathsIn(relative(SRC, file), readFileSync(file, "utf8")),
    );

    expect(paths).toEqual([]);
  });

  /** The gate on the gate: an empty list passes however the walk breaks. */
  describe("the detector itself", () => {
    it("enumerates the repository's documents, in both spellings", () => {
      expect(DOCUMENTS).toContain("docs/deploy.md");
      expect(DOCUMENTS).toContain("CONTEXT.md");
      expect(DOCUMENTS).toContain("frontend/docs/design-system.md");
      expect(DOCUMENTS).toContain("docs/design-system.md");
    });

    it("walks the console's source and skips the dev gallery", () => {
      const walked = files.map((file) => relative(SRC, file));
      expect(walked.length).toBeGreaterThanOrEqual(500);
      expect(walked).toContain(
        join("features", "settings", "platform", "console-origin-remedy.tsx"),
      );
      expect(walked.some((file) => file.startsWith(join("app", "dev")))).toBe(
        false,
      );
    });

    it.each([
      [
        "a path in JSX text",
        "<p>restart the backend (docs/deploy.md, “Locked out”).</p>",
      ],
      [
        "a path in a mono span",
        '<span className="font-mono">docs/deploy.md</span>',
      ],
      ["a root file in a hint", 'const hint = "Terms are in CONTEXT.md.";'],
      ["a template part", "const hint = `See docs/testing.md for ${lane}`;"],
    ])("reports %s", (_shape, text) => {
      expect(repositoryPathsIn("synthetic.tsx", text)).toHaveLength(1);
    });

    it("does not report a comment, or a path that only ends like one", () => {
      const text = [
        "/** Its steps are `docs/deploy.md` §3. */",
        '// docs/deploy.md, "Locked out"',
        "const x = <p>{/* docs/deploy.md */}fine</p>;",
        'const y = "/srv/app/docs/deploy.md.bak";',
      ].join("\n");

      expect(repositoryPathsIn("synthetic.tsx", text)).toEqual([]);
    });
  });
});
