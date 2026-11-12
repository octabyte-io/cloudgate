import { describe, expect, it } from "vitest";

/**
 * `/get-started` must not be statically prerendered, for the reason
 * `templates/page.test.ts` gives: a prerendered page files a deep link's
 * route-cache entry under the bare address, and this page is only ever
 * reached by a deep link.
 */
describe("the /get-started route", () => {
  it("is rendered on demand, so its query cannot poison the route cache", async () => {
    const page = await import("./page");

    expect(page.dynamic).toBe("force-dynamic");
  }, 30_000);
});
