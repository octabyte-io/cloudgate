import { describe, expect, it } from "vitest";

import { agreeing, counted } from "./plural";

/**
 * The bug this exists for is a sentence with **two** words to agree and only one
 * of them looked at: "1 variables are now set here"
 * So the noun and
 * the verb are pinned separately, and 0 is pinned too — it is plural in English
 * and it is the count a screen shows most often.
 */

describe("counted", () => {
  it("agrees the noun with the count", () => {
    expect(counted(1, "variable", "variables")).toBe("1 variable");
    expect(counted(2, "variable", "variables")).toBe("2 variables");
    expect(counted(0, "variable", "variables")).toBe("0 variables");
  });

  it("takes a plural that is not the singular plus s", () => {
    expect(counted(1, "entry", "entries")).toBe("1 entry");
    expect(counted(4, "entry", "entries")).toBe("4 entries");
  });
});

describe("agreeing", () => {
  it("picks the word that agrees with the count", () => {
    expect(agreeing(1, "is", "are")).toBe("is");
    expect(agreeing(0, "is", "are")).toBe("are");
    expect(agreeing(7, "is", "are")).toBe("are");
  });
});
