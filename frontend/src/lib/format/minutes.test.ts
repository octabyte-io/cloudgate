import { describe, expect, it } from "vitest";

import { readMinutes } from "./minutes";

describe("readMinutes", () => {
  it.each([
    [1, "1 minute"],
    [60, "1 hour"],
    [90, "1 hour 30 minutes"],
    [1440, "24 hours"],
    [2880, "48 hours (2 days)"],
    [10080, "168 hours (7 days)"],
  ])("reads %i as %s", (minutes, read) => {
    expect(readMinutes(minutes)).toBe(read);
  });
});
