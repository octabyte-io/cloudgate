import { describe, expect, it } from "vitest";

import { stillConverging } from "./use-database";

/**
 * A deploy answers within a bound under the proxy's. The row it answers
 * with says which toast is true — `done` is deployed, `running` is still
 * converging and the status moves on its own.
 */
describe("stillConverging", () => {
  it("reads a running answer as Swarm still deciding", () => {
    expect(stillConverging({ applicationStatus: "running" })).toBe(true);
  });

  it("reads a done answer, or no row at all, as decided", () => {
    expect(stillConverging({ applicationStatus: "done" })).toBe(false);
    expect(stillConverging(undefined)).toBe(false);
    expect(stillConverging(null)).toBe(false);
  });
});
