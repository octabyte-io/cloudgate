import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * **Nothing under `src/app/dev/` writes to the backend**.
 *
 * `/dev/data`'s stream panel built a Project, an Environment and an Application
 * and deployed it, and its refusal panel created a Project called "Scope
 * probe" — each one press, in whatever Organization the reader was signed in
 * to. The galleries are open signed-out under `next dev` (`src/proxy.ts`), and
 * the page a design review opens is not somewhere a click should manufacture
 * infrastructure.
 *
 * One mistake at more than one site is a census, not N assertions
 * (`CODING_STANDARDS.md` §1.7, "One mistake at N sites"). What it reads: every call in every
 * non-test module under `app/dev/` whose callee is a method on a typed endpoint
 * object (`projectsApi.create`, `deploymentsApi.deployApplication`) or on the
 * bare client (`api.post`). Only **reads** are allowed — a method named for
 * one (`list`, `find…`, `get…`, `me`). An allowlist rather than a list of
 * forbidden verbs on purpose: `redeploy`, `start` and `cancel` are writes too,
 * and a new endpoint's verb is one nobody thought to forbid.
 *
 * better-auth's client (`signIn`, `signOut`, `organization.setActive`) is not an
 * endpoint object and is out of scope: `/dev/data` exists to prove the session
 * works, and none of those creates a row.
 *
 * ### Falsified
 *
 * Run over `app/dev/` as it stood before the fix, the census reported exactly
 * the six calls the fix removed: `stream-panel.tsx`'s `projectsApi.create`,
 * `environmentsApi.create`, `applicationsApi.create` and
 * `deploymentsApi.deployApplication`, and `refusal-panel.tsx`'s
 * `projectsApi.create` twice, once per button — and none of the reads beside
 * them (`projectsApi.list`, `projectsApi.findOne`, `api.get`, `usersApi.me`).
 */

const DEV = dirname(fileURLToPath(import.meta.url));

/** `projectsApi`, `usersApi`, … and the bare client `api`. */
const ENDPOINT_OBJECT = /^(?:[a-z][A-Za-z]*Api|api)$/;

/** Method names that only read. Anything else on an endpoint object is a write. */
const READ_METHOD = /^(?:list[A-Z]?\w*|find[A-Z]?\w*|get[A-Z]?\w*|me)$/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(here);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield here;
    }
  }
}

/** `file:line :: callee` for every endpoint call that is not a read. */
function writesIn(file: string, text: string): string[] {
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
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ENDPOINT_OBJECT.test(node.expression.expression.text) &&
      !READ_METHOD.test(node.expression.name.text)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      const where = relative(DEV, file).split(sep).join("/");
      found.push(`${where}:${line + 1} :: ${node.expression.getText(source)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("dev-pages-write-nothing", () => {
  it("the census reads the harness it is about", () => {
    const files = [...sourceFiles(DEV)].map((file) =>
      relative(DEV, file).split(sep).join("/"),
    );
    // If these move, the census is reading an empty tree and passes on nothing.
    expect(files).toContain("data/_components/session-panel.tsx");
    expect(files).toContain("data/_components/org-panel.tsx");
  });

  it("the detector finds a write, and passes a read", () => {
    expect(
      writesIn(
        join(DEV, "fixture.tsx"),
        [
          "projectsApi.list();",
          "projectsApi.findOne('x');",
          "api.get('/servers');",
          "usersApi.me();",
          "projectsApi.create({ name: 'x' });",
          "deploymentsApi.deployApplication('a', {});",
          "api.post('/projects', {});",
          "applicationsApi.redeploy('a');",
        ].join("\n"),
      ),
    ).toEqual([
      "fixture.tsx:5 :: projectsApi.create",
      "fixture.tsx:6 :: deploymentsApi.deployApplication",
      "fixture.tsx:7 :: api.post",
      "fixture.tsx:8 :: applicationsApi.redeploy",
    ]);
  });

  it("no module under src/app/dev calls an endpoint that writes", () => {
    const writes = [...sourceFiles(DEV)].flatMap((file) =>
      writesIn(file, readFileSync(file, "utf8")),
    );
    expect(writes).toEqual([]);
  });
});
