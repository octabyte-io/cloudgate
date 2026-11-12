import { describe, expect, it } from "vitest";

/**
 * `/settings/audit-log` must not be statically prerendered.
 *
 * The section reads `?userId=` and `?outcome=` with `useSearchParams`, so the
 * Agents section can link to one Agent's trail. A prerendered route serves one
 * document for every query string and keys the client route cache by the
 * search it was *rendered* with — empty — which is the trap
 * `app/(console)/templates/page.tsx` documents: after a deep link, a
 * later navigation to the bare address adopts the filtered one. Rendering on
 * demand is what keeps the address meaning what it says.
 */
describe("the /settings/audit-log route", () => {
  it("is rendered on demand, so a filtered link cannot poison the route cache", async () => {
    const page = await import("./page");

    expect(page.dynamic).toBe("force-dynamic");
  }, 30_000);
});
