import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SETTINGS_SECTIONS } from "./sections";

const SETTINGS_ROUTES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../app/(console)/settings",
);

/** The sections from the one whose `groupLabel` is `label` up to the next group. */
function group(label: string) {
  const start = SETTINGS_SECTIONS.findIndex(
    (section) => section.groupLabel === label,
  );
  const rest = SETTINGS_SECTIONS.slice(start + 1);
  const end = rest.findIndex((section) => section.groupLabel !== undefined);
  return SETTINGS_SECTIONS.slice(start, end === -1 ? undefined : start + 1 + end);
}

/**
 * **Branding is a Settings section, and cannot be dropped silently**.
 *
 * White-labeling was a finished, licence-gated backend feature with no entry
 * in this list and no screen behind one — `grep -i whitelabel frontend/src`
 * returned nothing. The strip, the index page and the page heading all come
 * from `SETTINGS_SECTIONS`, so losing the line loses the screen from every
 * place anyone could find it.
 */
describe("SETTINGS_SECTIONS", () => {
  it("offers Branding in the Enterprise group, beside the other licensed sections", () => {
    const enterprise = group("Enterprise").map((section) => section.slug);

    expect(enterprise).toContain("branding");
    expect(enterprise).toEqual(
      expect.arrayContaining(["license", "roles", "sso", "forward-auth"]),
    );
  });

  // An Agent is a Member, so it is found next to Members.
  it("offers Agents in the Organization group, right after Members", () => {
    const organization = group("Organization").map((section) => section.slug);

    expect(organization.slice(0, 2)).toEqual(["members", "agents"]);
  });

  it("has a route for every section it lists", () => {
    const missing = SETTINGS_SECTIONS.filter(
      (section) => !existsSync(join(SETTINGS_ROUTES, section.slug, "page.tsx")),
    ).map((section) => section.slug);

    expect(missing).toEqual([]);
  });
});
