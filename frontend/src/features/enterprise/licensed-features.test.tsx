import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LicenseStatusCard } from "./license/license-status-card";
import {
  LICENSED_FEATURE_LIST,
  LICENSED_FEATURES,
  licensedFeaturesInline,
  type LicensedFeatureId,
} from "./licensed-features";
import type { useLicenseStatus } from "./use-license";

/**
 * **The License screen's list is the list of what the gates refuse.**
 *
 * The screen listed four features while Branding, Concurrent builds and the
 * Cloud run limit were refused by the same `LicenseGate` / `LicenseLocked`. One
 * mistake that any new gate repeats is a census, not an assertion per page
 * (`CODING_STANDARDS.md` §1.7, "One mistake at N sites"): every `<LicenseGate>` and
 * `<LicenseLocked>` in `src/` names its registry entry, and every registry entry
 * is named by at least one gate. The `feature` prop being required already makes
 * the first half a type error; this reads the source so the second half — an
 * entry left in the list after its gate is gone — fails too.
 *
 * ### Falsified
 *
 * Dropping `feature="branding"` from the Branding gate fails both halves (the
 * gate names nothing, and `branding` is read by no gate); adding an entry to the
 * registry without a gate fails the second. An action refused for a licensed
 * feature, greyed out rather than locked away, counts as its gate when the
 * element giving the reason carries `data-licensed-feature="<id>"`.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(here);
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      yield here;
    }
  }
}

type Gate = { at: string; ids: string[] };

/** Every gate element in the tree, with the ids its `feature` prop names. */
function gates(): Gate[] {
  const found: Gate[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    // The opening tag, up to its first unquoted `>` that is not part of `=>`.
    for (const match of text.matchAll(/<(LicenseGate|LicenseLocked)\b([^>]*)>/g)) {
      const line = text.slice(0, match.index).split("\n").length;
      const attrs = match[2];
      const feature =
        /feature=(?:"([^"]+)"|\{\s*\[([^\]]*)\]\s*\}|\{([^}]*)\})/.exec(attrs);
      const ids = feature
        ? feature[1]
          ? [feature[1]]
          : feature[2]
            ? [...feature[2].matchAll(/"([^"]+)"/g)].map((m) => m[1])
            : [`<expression ${feature[3].trim()}>`]
        : [];
      found.push({ at: `${relative(SRC, file)}:${line}`, ids });
    }
    // A licensed feature refused as a greyed-out action rather than a locked
    // section — "New organization" — names its entry on the element that
    // carries the reason, as `LicenseLocked` does on its own.
    for (const match of text.matchAll(/data-licensed-feature="([^"]+)"/g)) {
      const line = text.slice(0, match.index).split("\n").length;
      found.push({ at: `${relative(SRC, file)}:${line}`, ids: [match[1]] });
    }
  }
  return found;
}

afterEach(cleanup);

describe("licensed features", () => {
  const all = gates();
  // `LicenseGate` forwards its own `feature` to `LicenseLocked`; that one
  // passes a variable, not a literal, and is the gate's plumbing, not a gate.
  const sites = all.filter((gate) => !gate.ids.some((id) => id === "<expression feature>"));

  it("finds the gates it is meant to count", () => {
    expect(sites.length).toBeGreaterThanOrEqual(6);
  });

  it("has every gate name a registry entry", () => {
    const unnamed = sites
      .filter(
        (gate) =>
          gate.ids.length === 0 ||
          gate.ids.some((id) => !(id in LICENSED_FEATURES)),
      )
      .map((gate) => `${gate.at} → ${gate.ids.join(", ") || "(no feature)"}`);
    expect(unnamed).toEqual([]);
  });

  it("has every registry entry read by at least one gate", () => {
    const read = new Set(sites.flatMap((gate) => gate.ids));
    const unread = (Object.keys(LICENSED_FEATURES) as LicensedFeatureId[]).filter(
      (id) => !read.has(id),
    );
    expect(unread).toEqual([]);
  });

  it("lists every registry entry on the License screen, and names them all when unlicensed", () => {
    render(
      <LicenseStatusCard
        status={
          {
            data: { licensed: false, status: "none", validUntil: null, features: [] },
            error: null,
            isPending: false,
          } as unknown as ReturnType<typeof useLicenseStatus>
        }
      />,
    );
    const items = [...document.querySelectorAll("li")].map((li) => li.textContent ?? "");
    for (const feature of LICENSED_FEATURE_LIST) {
      expect(items.some((text) => text.startsWith(feature.label))).toBe(true);
    }
    expect(items).toHaveLength(LICENSED_FEATURE_LIST.length);
    // The seventh, from the one-Organization limit (ADR-0059).
    expect(items.some((text) => text.startsWith("More than one Organization"))).toBe(true);
  });

  it("joins the inline names into one phrase", () => {
    expect(licensedFeaturesInline()).toMatch(
      /^custom roles, single sign-on, .+ and concurrent Cloud runs$/,
    );
  });
});
