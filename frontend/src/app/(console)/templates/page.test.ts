import { describe, expect, it } from "vitest";

/**
 * `/templates` must not be statically prerendered.
 *
 * This looks like a test of a constant, and it is a test of a whole screen's
 * reachability. Prerendered, `next build` writes **one** `templates.html` for
 * this route and serves it for `/templates` and `/templates?template=whoami`
 * alike. Its baked router payload carries `"q":""` — measured, the string
 * `\"c\":[\"\",\"templates\"],\"q\":\"\"` sits in that file — while the client
 * takes the canonical URL from `location.href`. Next files the route-cache entry
 * under the *rendered* search, so the deep-linked page occupies the cache slot
 * for a bare `/templates` and keeps `?template=whoami` as its canonical URL; from
 * then on every client navigation to `/templates` adopts that URL and the
 * catalogue cannot be reached. `page.tsx`'s docblock has the full chain, with the
 * two Next source lines that do it.
 *
 * So the thing that has to stay true is *"this route is rendered on demand"*, and
 * the segment config is where a route says that. The build is what proves the
 * two are the same statement, and it was run both ways rather than assumed:
 *
 * ```
 * before   └ ○ /templates      prerender-manifest: /templates present
 * after    └ ƒ /templates      prerender-manifest: /templates absent
 * ```
 *
 * There is no cheaper seam. `dynamic` is read by the compiler, not by anything
 * this app calls, so nothing in the running console can be asserted instead — a
 * jsdom test of the back control passes whether or not the catalogue is
 * reachable, which is exactly how this shipped. (The `?template=` flow went
 * with the `template.toml` reader, ADR-0066; the setup form that replaces it
 * opens from this route, so the route stays rendered on demand.)
 */
describe("the /templates route", () => {
  it("is rendered on demand, so ?template= cannot poison the route cache", async () => {
    const page = await import("./page");

    expect(page.dynamic).toBe("force-dynamic");
  }, 30_000);
});
