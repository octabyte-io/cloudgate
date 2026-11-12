import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * **Every `organization.setActive(` is unwrapped.**
 *
 * better-auth's client resolves to `{ data, error }` and never throws, so an
 * `await organization.setActive(…)` inside a `try` swallows a refusal whole:
 * the `catch` never runs, nothing is said, and `organizationChanged()` runs
 * after a switch that did not happen. A live check found it on the
 * not-a-member screen — a 403 `INVALID_ORIGIN` left the one way out silent —
 * and the same shape sat in the masthead switcher, Settings → Organizations and
 * the delete that moves the session first. One mistake at several sites is a
 * census (`CODING_STANDARDS.md` §1.7, "One mistake at N sites"), so this reads them all.
 *
 * A call passes when it is the argument of `unwrap(`, allowing whitespace and a
 * line break between them. Grepped rather than parsed: the call has one
 * spelling, and a site that aliases the client is a site this would miss and a
 * reviewer would not. `*.test.ts(x)` is out of scope.
 *
 * ### Falsified
 *
 * Against the tree before this fix it reported `org-switcher.tsx`,
 * `not-a-member.tsx`, `organizations-section.tsx`,
 * `organization-danger-zone.tsx` and `app/dev/data/_components/org-panel.tsx`.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CALL = /organization\.setActive\(/g;
const UNWRAPPED = /unwrap\(\s*$/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      return [];
    }
    return [path];
  });
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(CALL)) {
      if (!UNWRAPPED.test(text.slice(0, match.index))) {
        const line = text.slice(0, match.index).split("\n").length;
        found.push(`${relative(SRC, file).split(sep).join("/")}:${line}`);
      }
    }
  }
  return found;
}

describe("organization.setActive", () => {
  it("is unwrapped at every call site, so a refused switch throws", () => {
    expect(offenders()).toEqual([]);
  });

  it("finds the call sites it is meant to be reading", () => {
    // A census that matches nothing passes for ever.
    const all = sources(SRC).filter((file) =>
      readFileSync(file, "utf8").includes("organization.setActive("),
    );
    expect(all.length).toBeGreaterThanOrEqual(5);
  });
});
