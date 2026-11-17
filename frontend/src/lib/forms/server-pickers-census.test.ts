import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * **Every Server picker greys out a Server nothing can be deployed to.**
 *
 * A Bought Server an Operator powered off (#1401) stayed a choice in the
 * Template setup, the create forms and the build-server picker: each built
 * its options from the Server list on its own, and only the ones that called
 * `notReadyYet` knew about Bought Servers at all, and that only by stage.
 * The rule now lives in `notReadyYet` (stage short of Ready, or powered
 * off), and this census holds every picker to calling it.
 *
 * One mistake at more than one site is a census (`CODING_STANDARDS.md` §1.7,
 * "One mistake at N sites"). What it enumerates is the producer's own shape:
 * every object literal whose `value` is some Server's `serverId`, which is
 * how a Picker option for a Server is built, in every non-test file under
 * `src/` outside the `app/dev` galleries. Each such file must call
 * `notReadyYet`. Parsed rather than grepped, so a comment naming `serverId`
 * counts for nothing.
 *
 * ### Falsified
 *
 * Run before the fix it named exactly the sites that built options without
 * `notReadyYet`: `build-server-card.tsx`, `probe-server-picker.ts` and
 * `requests-screen.tsx` (the last a read-only filter, now exempt by name),
 * while `deploy-target.ts` and `create-server-picker.ts` passed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..");
const DEV = join(SRC, "app", "dev") + sep;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!(here + sep).startsWith(DEV)) yield* sourceFiles(here);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      yield here;
    }
  }
}

/** Whether the file builds `{ value: <x>.serverId, … }`, and whether it calls `notReadyYet`. */
function scan(file: string, text: string) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let buildsOptions = false;
  let callsPredicate = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === "value" &&
      ts.isPropertyAccessExpression(node.initializer) &&
      node.initializer.name.text === "serverId"
    ) {
      buildsOptions = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "notReadyYet"
    ) {
      callsPredicate = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { buildsOptions, callsPredicate };
}

const scanned = [...sourceFiles(SRC)].map((file) => ({
  file: relative(SRC, file),
  ...scan(file, readFileSync(file, "utf8")),
}));
/**
 * Pickers that choose a Server to read about, never one to deploy or run on,
 * each with why: a powered-off Server's past is still worth reading.
 */
const READ_ONLY_PICKERS: Record<string, string> = {
  [join("features", "requests", "requests-screen.tsx")]:
    "chooses whose request log to read",
};

const pickers = scanned.filter(
  (entry) => entry.buildsOptions && !(entry.file in READ_ONLY_PICKERS),
);

describe("server-pickers census", () => {
  it("every file that builds Server options calls notReadyYet", () => {
    expect(
      pickers.filter((entry) => !entry.callsPredicate).map((e) => e.file),
    ).toEqual([]);
  });

  /** The gate on the gate: the detector finds the pickers it exists for. */
  it("finds the known Server pickers, and nothing in the dev gallery", () => {
    expect(pickers.map((entry) => entry.file).sort()).toEqual(
      expect.arrayContaining([
        join("features", "application", "advanced", "build-server-card.tsx"),
        join("features", "environment", "deploy-target.ts"),
        join("lib", "forms", "create-server-picker.ts"),
        join("lib", "forms", "probe-server-picker.ts"),
      ]),
    );
    expect(
      scanned.some((entry) => entry.file.startsWith(join("app", "dev"))),
    ).toBe(false);
    // An exemption names a file that still builds Server options.
    for (const file of Object.keys(READ_ONLY_PICKERS)) {
      expect(scanned.find((entry) => entry.file === file)?.buildsOptions).toBe(
        true,
      );
    }
  });

  it("tells an option built from serverId from one that is not", () => {
    expect(
      scan("a.ts", "const o = servers.map((s) => ({ value: s.serverId }));"),
    ).toEqual({ buildsOptions: true, callsPredicate: false });
    expect(
      scan(
        "b.ts",
        "// value: s.serverId\nconst o = list.map((s) => ({ value: s.id, d: notReadyYet(s) }));",
      ),
    ).toEqual({ buildsOptions: false, callsPredicate: true });
  });
});
