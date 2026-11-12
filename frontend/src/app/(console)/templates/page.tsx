import type { Metadata } from "next";
import { Suspense } from "react";

import { TabPending } from "@/components/console/tab-pending";
import { TemplatesScreen } from "@/features/templates/templates-screen";

export const metadata: Metadata = { title: "Templates" };

/**
 * **This route is rendered on demand, and `?template=` is the whole reason**.
 *
 * Prerendered, `/templates` and `/templates?template=whoami` are the *same
 * document*. `next build` writes one `templates.html` whose router payload
 * records `"q":""` — the search string the page was rendered with, which at
 * build time is empty — and the server hands that file to both addresses.
 *
 * On the client the two halves of the address are then read from different
 * places. `createInitialRouterState` takes the canonical URL from
 * `location.href`, search included, and the rendered search from the baked `q`.
 * It files the route-cache entry under the **rendered** search
 * (`segment-cache/cache.js`'s `writeRouteIntoCache` →
 * `getFulfilledRouteVaryPath(pathname, renderedSearch, …)`), so a page loaded at
 * `?template=whoami` lands in the cache under the key that belongs to a bare
 * `/templates`, while still carrying `/templates?template=whoami` as its
 * canonical URL.
 *
 * Every later client navigation to `/templates` reads that entry and adopts its
 * canonical URL rather than the href it was asked for —
 * `segment-cache/navigation.js`'s `navigateUsingPrefetchedRouteTree` is literally
 * `canonicalUrl = route.canonicalUrl + url.hash`. So after a reload or a deep
 * link, the flow's **All templates** button and the rail's **Templates** row both
 * push `/templates` and land back on `/templates?template=whoami`: the catalogue
 * cannot be reached without editing the address bar, and the rail's bare
 * `href="/templates"` appears to grow a search parameter that nothing in this
 * codebase ever put on it. Neither control is at fault, which is why neither
 * could be fixed where it lives.
 *
 * Rendering on demand is what makes the two halves agree: `q` is then the
 * request's own query (`app-render.ts`'s `getRenderedSearch`), the entry is keyed
 * by the search it actually carries, and `/templates` is a separate entry with
 * its own canonical URL. The cost is one server render per visit of a screen that
 * fetches nothing on the server — the catalogue is a client query with an hour's
 * `staleTime` — and it buys back a route whose address means what it says.
 *
 * Nothing about the screen changes. The page segment stays `__PAGE__` either way
 * (the segment cache strips search params out of it — `cache.js`,
 * `convertFlightRouterStateToRouteTree`), so moving between the catalogue and a
 * template still re-renders `TemplatesScreen` in place rather than remounting it,
 * and the search and tag filter it was left on survive, which is what
 * `templates-screen.tsx` holds that state for.
 *
 * **This export is the first route-segment config in the app, and it is on a
 * clock.** Next 16 removes `dynamic` (with `dynamicParams`, `revalidate` and
 * `fetchCache`) once `cacheComponents` is enabled in `next.config.ts`, which it
 * is not (`02-route-segment-config/index.md`, the v16.0.0 row). Turning that on
 * therefore does not merely drop a hint — it silently restores the trap above,
 * and this route has to be made request-rendered again by whatever that model
 * offers instead. `page.test.ts` is what fails first.
 */
export const dynamic = "force-dynamic";

/**
 * The `Suspense` boundary was required rather than stylistic, and F06 hit the
 * same wall on every one of its doors: the screen reads `?template=` with
 * `useSearchParams`, which Next will not prerender without one. The line above
 * means this route is no longer prerendered, so the build no longer insists —
 * it is kept because the demand returns the moment that line does, and because
 * a boundary is what this screen's first paint wants either way.
 */
export default function Page() {
  return (
    <Suspense fallback={<TabPending />}>
      <TemplatesScreen />
    </Suspense>
  );
}
