import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * **A table cell that truncates sits in a column that bounds it.**
 *
 * `truncate` is `overflow: hidden` plus `white-space: nowrap` plus an ellipsis,
 * and it only clips against a box whose width something else decided. A
 * `DataTable` cell is not that box: the table is auto-layout, so a cell is as
 * wide as its longest unbreakable line, and a `truncate` inside it truncates
 * nothing. The cell grows to the whole string and pushes the row's last column
 * — the Actions — behind the table's horizontal scroll.
 *
 * The ticket found it at five screens: the Sessions user agent, the Docker
 * containers' name and ports, the Domains host (which the Environment and
 * Compose Domains tables share), and the Compose containers' service and task
 * name. The answer is `truncate: true` on the `Column`, which `DataTable` turns
 * into a column that shares the width the other columns leave and clips its
 * content to it. This census makes that the only way a table cell truncates.
 *
 * What it reads is every `Column` literal in `src` (an object with `id`, `head`
 * and `cell`) — the producer's own declarations rather than a list of tables,
 * so a new column set is covered the day it is written. A column offends when
 * `truncate` appears as a class in its `cell` or its own `className` and the
 * column does not say `truncate: true`.
 *
 * **What it cannot see**, said rather than implied:
 *
 * - a `truncate` inside another component the cell renders — `RowSub`'s
 *   sub-line is the one in the tree. A sub-line under a key cell is short by
 *   what it holds (an email, a kind), and a column that renders one with a long
 *   value still owes a `truncate: true`;
 * - a long value with no `truncate` at all. jsdom has no layout, so "long" is
 *   not something a unit test can measure. `DataTable`'s `wrap` tone now carries
 *   `wrap-anywhere`, which is the other half: a column that wraps can wrap an
 *   identifier with no spaces in it, which the Docker image column could not.
 *
 * A bounded host is not enough on its own: once it sits at its floor, every
 * other column's *minimum* decides whether the row fits, and a `nowrap` header
 * is a minimum ("Container port" held 151px on Application Domains at 1470px,
 * after the first half of this fix). That half is the header's words: now
 * a header is one line, so the Domains table's heads are single words,
 * and `data-table.test.tsx` pins that.
 *
 * `*.test.ts(x)` and `app/dev/**` (the component gallery) are out of scope.
 *
 * ### Falsified
 *
 * Against the tree before the fix it reported twelve columns. Six were the
 * known sites: `session-columns.tsx:device`, `server/docker/container-columns.tsx`
 * `:name` and `:ports`, `application/domains/domain-columns.tsx:host` and
 * `:service` (a compose service name, which lost its inert `truncate`), and
 * `compose/containers/container-columns.tsx:service`. Six more
 * are the same mistake on screens the run did not measure:
 * `rows/deployment-row.tsx:title`, `advanced/patches-spec.tsx:filePath`,
 * `advanced/preview-columns.tsx:pullRequest` and `requests/request-columns.tsx`
 * `:host`, `:service` and `:client` (an address, which lost its inert
 * `truncate` rather than gaining a bound).
 */

/**
 * `src/…:columnId` → why that column's `truncate` needs no bound. Every entry
 * must still offend, so a fix that lands without deleting its line reds the
 * second case.
 */
const DELIBERATELY_UNBOUNDED: Record<string, string> = {};

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(SRC, here).split(sep).join("/") === "app/dev") continue;
      yield* sourceFiles(here);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield here;
    }
  }
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

const TRUNCATE = /(^|\s)truncate(\s|$)/;
const CAPPED = /(^|\s)max-w-/;

/**
 * Any string in `node` that carries the `truncate` class without a `max-w-*`
 * beside it — a cap on the same element is a bound of its own.
 */
function carriesTruncate(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (
    (ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)) &&
    TRUNCATE.test(node.text) &&
    !CAPPED.test(node.text)
  ) {
    return true;
  }
  return ts.forEachChild(node, (child) => carriesTruncate(child) || undefined) ?? false;
}

/** Whether a `className` anywhere under `cell` holds `truncate`. */
function cellTruncates(cell: ts.Node | undefined): boolean {
  if (!cell) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText() === "className" &&
      carriesTruncate(node.initializer)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(cell);
  return found;
}

type Site = { at: string; truncates: boolean; bounded: boolean };

/** Every `Column` literal in the console: whether it truncates, and whether it says so. */
function columnSites(): Site[] {
  const sites: Site[] = [];

  for (const file of sourceFiles(SRC)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const where = `src/${relative(SRC, file).split(sep).join("/")}`;

    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const id = property(node, "id")?.initializer;
        const cell = property(node, "cell");
        if (id && ts.isStringLiteralLike(id) && property(node, "head") && cell) {
          sites.push({
            at: `${where}:${id.text}`,
            truncates:
              cellTruncates(cell.initializer) ||
              carriesTruncate(property(node, "className")?.initializer),
            bounded:
              property(node, "truncate")?.initializer.kind ===
              ts.SyntaxKind.TrueKeyword,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return sites;
}

describe("a truncating table cell", () => {
  const sites = columnSites();

  it("sits in a column declared truncate, everywhere in the console", () => {
    // Not a vacuous pass: well over a hundred column literals when this was
    // written. A walk that found none — a renamed property, a parse that saw
    // nothing — would leave the assertion below green over an empty list.
    expect(sites.length).toBeGreaterThanOrEqual(100);
    expect(sites.filter((site) => site.bounded).length).toBeGreaterThanOrEqual(6);

    const offenders = sites
      .filter(
        ({ at, truncates, bounded }) =>
          truncates && !bounded && !(at in DELIBERATELY_UNBOUNDED),
      )
      .map(({ at }) => at);

    expect(offenders).toEqual([]);
  });

  it("lists no deliberate exception that is not an unbounded truncating column", () => {
    const unbounded = new Set(
      sites
        .filter(({ truncates, bounded }) => truncates && !bounded)
        .map(({ at }) => at),
    );
    const stale = Object.keys(DELIBERATELY_UNBOUNDED).filter(
      (at) => !unbounded.has(at),
    );

    expect(stale).toEqual([]);
  });
});
