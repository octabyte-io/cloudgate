import { describe, expect, it } from "vitest";

import { describeCron } from "./cron";

/**
 * The bug this exists for is a step of **one**
 * a schedule on
 * an every-minute stepped expression read "Every 1 minutes" in the Schedules
 * table's When column, because the sentence was written plural and the numeral
 * in front of it was not looked at.
 *
 * So the singular and the plural are pinned separately at both grains the
 * builder steps on, minutes and hours, and the expected strings are written out
 * here rather than composed the way `describeCron` composes them — a wrong
 * expectation must not be able to agree with the code (§1.7).
 *
 * The first assertion is the one that matters most and is not about grammar: a
 * step of one and a bare `*` are the *same schedule*, so they have to be the
 * same sentence. A reading that differs between two spellings of one cron is
 * how an operator concludes they have two different schedules.
 */

describe("describeCron", () => {
  it("reads a minute step of one the way a bare star already reads", () => {
    expect(describeCron("*/1 * * * *")).toBe("Every minute");
    expect(describeCron("*/1 * * * *")).toBe(describeCron("* * * * *"));
  });

  it("keeps the plural for a minute step above one", () => {
    expect(describeCron("*/5 * * * *")).toBe("Every 5 minutes");
  });

  it("reads an hour step of one as every hour", () => {
    expect(describeCron("0 */1 * * *")).toBe("Every hour, at 00 past");
  });

  it("keeps the plural for an hour step above one", () => {
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours, at 00 past");
    expect(describeCron("30 */6 * * *")).toBe("Every 6 hours, at 30 past");
  });
});
