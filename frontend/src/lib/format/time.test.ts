import { describe, expect, it } from "vitest";

import { clockTime } from "./time";

describe("clockTime", () => {
  it("reads the time of day on a 24-hour clock, in the reader's own zone", () => {
    // Built in the local zone, so the answer does not depend on the runner's.
    expect(clockTime(new Date(2026, 10, 6, 0, 5, 9).toISOString())).toBe(
      "00:05:09",
    );
    expect(clockTime(new Date(2026, 10, 6, 14, 32, 7).toISOString())).toBe(
      "14:32:07",
    );
  });

  it("is a dash for a stamp it cannot read", () => {
    expect(clockTime("not a time")).toBe("—");
  });
});
