import { describe, expect, it } from "vitest";

import { absentReason, tabEntry, visibleTabEntries } from "../tab-registry";

/**
 * A Server's **Bought Server** tab (#198): there just above Settings on a
 * Server bought from Cloudgate, and absent, with its reason, on a Server of
 * the customer's own.
 */
describe("the Bought Server tab", () => {
  const bought = { stage: "ready", deletesOn: null, deletedAt: null };

  it("comes right before Settings on a Bought Server", () => {
    const tabs = visibleTabEntries("server", { boughtServer: bought }).map(
      (entry) => entry.slug,
    );
    expect(tabs).toContain("bought-server");
    expect(tabs.indexOf("bought-server")).toBe(tabs.indexOf("settings") - 1);
  });

  it.each([null, undefined])(
    "is absent on a Server of the customer's own (%s), and says why",
    (boughtServer) => {
      expect(
        visibleTabEntries("server", { boughtServer }).map((e) => e.slug),
      ).not.toContain("bought-server");
      const entry = tabEntry("server", "bought-server");
      expect(entry).not.toBeNull();
      expect(absentReason(entry!, { boughtServer })).toBe(
        "Only a Server bought from Cloudgate has this tab. This one is a machine of your own, so its backups, size and price are with whoever provides it.",
      );
    },
  );
});
