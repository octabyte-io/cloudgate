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

/**
 * A Compose stack's **Volume backups** tab (#163): there on a stack on a
 * Server or this host, and absent, with its reason, on a stack in a Cloud
 * account, which has no Server to tar its volumes on.
 */
describe("the Volume backups tab", () => {
  it("is there on a stack on a Server", () => {
    expect(
      visibleTabEntries("compose", { stackVm: false }).map((e) => e.slug),
    ).toContain("volume-backups");
  });

  it("is absent on a stack in a Cloud account, and says why", () => {
    expect(
      visibleTabEntries("compose", { stackVm: true }).map((e) => e.slug),
    ).not.toContain("volume-backups");
    const entry = tabEntry("compose", "volume-backups");
    expect(entry).not.toBeNull();
    expect(absentReason(entry!, { stackVm: true })).toBe(
      "Only a stack on a Server or on this host has Volume backups. This Compose stack runs in a Cloud account, so there is no Server to copy its volumes on.",
    );
  });
});
