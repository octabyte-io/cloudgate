import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render } from "@testing-library/react";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { schedulesSpec } from "@/features/application/advanced/schedules-spec";
import { swarmConcerns } from "@/features/application/advanced/swarm/swarm-concerns";
import { toSwarmValues } from "@/features/application/advanced/swarm/swarm-values";
import { volumeBackupsSpec } from "@/features/application/advanced/volume-backups-spec";

afterEach(cleanup);

/**
 * A `FieldSpec.hint` is a `ReactNode` and **nothing renders Markdown in one**,
 * so a backtick in a hint is a backtick on screen.
 *
 * Three hints shipped with their examples fenced in them
 * and an operator
 * read `` `0 2 * * *` `` with the punctuation included. One mistake at three
 * sites, which is what makes this a census rather than three assertions
 * (`CODING_STANDARDS.md` §1.7, "One mistake at N sites"): the fix is a sweep, and a sweep leaves
 * the tree right with nothing keeping it there.
 *
 * **It has two halves, because agreeing is not the same as being right.** The
 * census can only prove that no hint carries a backtick, and a tree where every
 * hint had simply had its backticks deleted would satisfy it while throwing away
 * the distinction the backticks were reaching for. So the second half renders
 * the three real hints and asserts the positive: the example is inside a
 * `<code>`, set the way the console sets every other literal, which is the
 * treatment the database backup form's `CronReading` already had right.
 *
 * ### What the census looks at, and why it is wider than `FieldSpec`
 *
 * Every `hint:` property in the tree whose value contains text — a string
 * literal, a template chunk, or JSX text under it — and not only the ones typed
 * as `FieldSpec`. Narrowing it to that type would need the checker and a whole
 * program, and it would be narrowing for its own sake: `Field`, `ResourceField`,
 * `RowColumn` and `LogRefusal` all render a `hint` into a `<p>` on the same
 * terms, and none of them renders Markdown either.
 *
 * JSX text is in scope deliberately, and it is the shape the fix could
 * regress into: the three hints are fragments now, so the next backtick here
 * would arrive as body text rather than inside a quoted string, and a census
 * reading only string literals would not see it.
 *
 * `*.test.ts(x)` is out of scope, on `eslint.config.mjs`' argument for keeping
 * the cross-file-line rule off `.mjs`: a fixture quotes the forbidden shape as
 * data, and a gate that reports its own falsification is a gate someone turns
 * off. Nothing ships out of a test file, so there is no site to lose.
 *
 * The one shape it cannot see is a hint that is a *component*
 * (`hint: <CronReading />`) — the backtick would sit in that component's own
 * body, under no `hint:` property at all. The render half covers the hints that
 * matter, and a rule for "a function a hint points at" would be a guess about
 * where to stop.
 *
 * ### Falsified, not merely observed green
 *
 * The red run is recorded here, because a census that has
 * never failed is indistinguishable from one that cannot. Three runs, each
 * reverted by hand:
 *
 * 1. The original string hint restored at `volume-backups-spec.tsx` — **2
 *    failed**, the census naming that site and the render half reporting
 *    ``expected 'Five fields. `0 2 * * *` is every day…' not to contain '`'``.
 * 2. A backtick added as **JSX text** inside one of the new fragments — the
 *    same 2 failed, the same site named. This is the shape the fix itself could
 *    regress into, and the one a string-literal-only census would have missed.
 * 3. The backticks merely **deleted**, with no `<code>` — the census **passes**
 *    and the render half fails on `expected undefined to be '0 2 * * *'`. That
 *    is the two halves doing separate work, measured rather than argued.
 */

/** The console's whole source tree, which is what makes this a census. */
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

/**
 * Every string a `hint:` property puts on screen, tagged with the
 * `src/path.tsx:LINE` of the property it hangs off.
 *
 * Parsed rather than grepped. A regex over `hint: "…"` finds the three known
 * sites and misses a hint wrapped onto the next line, one built by a helper
 * call and one written as JSX — a gate that can be stepped over by reformatting
 * is not a gate. `createSourceFile` on its own is enough, because this needs the
 * shape of each file and never a type: no program to build, and the whole tree
 * parses in a fraction of a second.
 */
function hintStrings(): { at: string; text: string }[] {
  const found: { at: string; text: string }[] = [];

  for (const file of sourceFiles(SRC)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      false,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (isHintProperty(node)) {
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        const at = `src/${relative(SRC, file).split(sep).join("/")}:${line + 1}`;
        for (const text of textUnder(node.initializer)) found.push({ at, text });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }

  return found;
}

/** `hint: …` in an object literal, however the key is spelled. */
function isHintProperty(node: ts.Node): node is ts.PropertyAssignment {
  if (!ts.isPropertyAssignment(node)) return false;
  const { name } = node;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text === "hint";
  }
  return false;
}

/**
 * Every literal chunk of text inside one expression, at any depth.
 *
 * A template's own pieces are read off the node rather than left to the walk:
 * only its head is a `StringLiteralLike`, and its middles and tail are token
 * kinds that `isStringLiteralLike` answers false for — which is how a backtick
 * in the *second* half of an interpolated hint would otherwise pass.
 */
function textUnder(node: ts.Node): string[] {
  const texts: string[] = [];

  const visit = (here: ts.Node): void => {
    if (ts.isStringLiteralLike(here)) texts.push(here.text);
    else if (ts.isJsxText(here)) texts.push(here.text);
    else if (ts.isTemplateExpression(here)) {
      texts.push(here.head.text);
      for (const span of here.templateSpans) texts.push(span.literal.text);
    }
    ts.forEachChild(here, visit);
  };
  visit(node);

  return texts;
}

describe("a form hint", () => {
  it("carries no literal backtick anywhere in the console", () => {
    const hints = hintStrings();

    // Not a vacuous pass. A walk that found nothing — a renamed directory, a
    // parse that gave up on every file — would leave the assertion below green
    // over an empty list, which is the one way this gate could rot silently.
    expect(hints.length).toBeGreaterThan(100);

    const offenders = hints
      .filter(({ text }) => text.includes("`"))
      .map(({ at }) => at);

    expect(offenders).toEqual([]);
  });
});

/** One named field's hint, out of a spec's field list. */
function hintOn(
  fields: { name: string; hint?: React.ReactNode }[],
  name: string,
): React.ReactNode {
  const field = fields.find((one) => one.name === name);
  if (!field?.hint) throw new Error(`${name} has no hint`);
  return field.hint;
}

/**
 * The three hints that were found, taken from the specs the screens really build
 * rather than copied into this file. The census proves the sites agree; only
 * rendering one proves what they agree *on*.
 */
const FENCED = [
  {
    screen: "an Application's schedules",
    hint: hintOn(
      schedulesSpec({
        applicationId: "app_1",
        create: async () => {},
        update: async () => {},
        remove: async () => {},
      }).fields,
      "cronExpression",
    ),
    example: "0 3 * * *",
  },
  {
    screen: "an Application's volume backups",
    hint: hintOn(
      volumeBackupsSpec({
        serviceId: "app_1",
        destinations: [],
        destinationsPending: false,
        create: async () => {},
        update: async () => {},
        remove: async () => {},
      }).fields,
      "schedule",
    ),
    example: "0 2 * * *",
  },
  {
    screen: "an Application's Swarm ulimits",
    hint: hintOn(
      swarmConcerns(toSwarmValues({} as never)).flatMap(
        (concern) => concern.fields,
      ),
      "ulimits",
    ),
    example: "nofile",
  },
];

describe.each(FENCED)("the hint on $screen", ({ hint, example }) => {
  // Inside a `<p>` because that is where `Field` and `ResourceField` put a hint,
  // so a hint that needed a block element would fail here as it does on screen.
  it("sets its example as code and shows no backtick", () => {
    const { container } = render(<p>{hint}</p>);

    expect(container.textContent).not.toContain("`");
    expect(container.querySelector("code")?.textContent).toBe(example);
  });
});
