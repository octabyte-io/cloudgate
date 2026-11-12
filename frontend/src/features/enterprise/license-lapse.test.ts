import { describe, expect, it } from "vitest";

import { lapsedOn } from "./license-lapse";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const PAST = "2026-08-01T00:00:00.000Z";
const FUTURE = "2030-06-01T00:00:00.000Z";

describe("lapsedOn", () => {
  it("answers the expiry of an active key that no longer licenses anything", () => {
    expect(
      lapsedOn({ licensed: false, status: "active", validUntil: PAST }, NOW),
    ).toBe(PAST);
  });

  it.each([
    [
      "still licensed",
      { licensed: true, status: "active", validUntil: FUTURE },
    ],
    [
      "never activated",
      { licensed: false, status: "inactive", validUntil: null },
    ],
    [
      "refused by the license server",
      { licensed: false, status: "invalid", validUntil: PAST },
    ],
    [
      "active with no expiry",
      { licensed: false, status: "active", validUntil: null },
    ],
  ] as const)("is null for a key %s", (_case, report) => {
    expect(lapsedOn(report, NOW)).toBeNull();
  });

  it("is null before the status has been read", () => {
    expect(lapsedOn(undefined, NOW)).toBeNull();
  });
});
