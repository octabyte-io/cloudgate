import { describe, expect, it } from "vitest";

import {
  absentReason,
  tabEntry,
  visibleTabEntries,
  type TabSubject,
} from "../tab-registry";

/**
 * A Compose stack's **Config files** tab (#135): there after Shell for a
 * stack with one or more `file` mounts, and absent, with its reason, for a
 * stack with none, a role that cannot read volumes, or while the read is out.
 */
describe("the Config files tab", () => {
  const slugs = (configFiles: TabSubject["configFiles"]) =>
    visibleTabEntries("compose", { configFiles }).map((entry) => entry.slug);

  it("comes right after Shell for a stack with config files", () => {
    const tabs = slugs(true);
    expect(tabs).toContain("config-files");
    expect(tabs.indexOf("config-files")).toBe(tabs.indexOf("shell") + 1);
  });

  it.each([
    [false, /has none/],
    [undefined, /has none/],
    ["refused", /cannot read this Compose stack's config files/],
  ] as const)(
    "is absent when the files read %s, and says why",
    (configFiles, reason) => {
      expect(slugs(configFiles)).not.toContain("config-files");
      const entry = tabEntry("compose", "config-files");
      expect(entry).not.toBeNull();
      expect(absentReason(entry!, { configFiles })).toMatch(reason);
    },
  );
});
