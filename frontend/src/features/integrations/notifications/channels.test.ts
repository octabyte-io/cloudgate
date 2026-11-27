import { describe, expect, it } from "vitest";

import { EVENT_FIELDS } from "./channels";

describe("notification event hints", () => {
  /**
   * The nightly Docker cleanup runs every prune but volumes
   * (`CleanupService.cleanupAll`, `excludedCleanupAllCommands`): a stopped
   * container's volume is data. The hint said it pruned volumes (#187).
   */
  it("describes the scheduled Docker cleanup as leaving volumes alone", () => {
    const hint = EVENT_FIELDS.find(
      (field) => field.name === "dockerCleanup",
    )?.hint;

    expect(hint).toBe(
      "The nightly prune of stopped containers, unused images and build cache. It never removes volumes.",
    );
  });
});
