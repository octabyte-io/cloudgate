import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";

import { BrandingStyle } from "@/components/console/branding-style";
import { ConsoleShell } from "@/components/shell/console-shell";
import { DeadSessionExit } from "@/components/shell/dead-session-exit";
import { brandingMetadata } from "@/lib/branding/branding";
import { brandingState, loadBranding } from "@/lib/branding/load-branding";

/**
 * Every console page's title template and favicon follow the branding:
 * `"%s · <app name>"` replaces the root's `"%s · Cloudgate"` for everything
 * under this group. A resource scope's own title is built on the client
 * (`scope-title.tsx`) and reads the same branding.
 */
export async function generateMetadata(): Promise<Metadata> {
  return brandingMetadata(await loadBranding());
}

/**
 * Everything inside the console: masthead, scope rail, ⌘K, and the page.
 *
 * A route group rather than a segment, so none of it shows up in a URL — the
 * auth screens F06 builds sit outside this shell and must not inherit it.
 *
 * The rail's collapsed state is written onto `<html>` before first paint by a
 * blocking inline script, so a collapsed rail is already 60px wide rather than
 * snapping shut after hydration (`rail-state.ts`). That script lives in the
 * *root* layout's `<head>`, not here: this layout is mounted on the
 * client by any navigation in from the doors, and React will not run — and
 * logs about — a `<script>` it has to create.
 *
 * **There is deliberately no `loading.tsx` beside this file, and there must not
 * be one.** There was, and it cost every 404 under this shell its status
 * `loading.js`
 * wraps `page.js`, `not-found.js` and every *nested* `layout.js` in a Suspense
 * boundary — everything but the layout in its own segment
 * (`03-file-conventions/loading.md`) — so the shell, status line included,
 * flushed before any `[[...tab]]/page.tsx` ran its registry check, and an
 * invented tab drew the right not-found screen under `200 OK`. Measured both
 * ways on every scope: with the file, 200; without it, 404. Next's own answer is
 * the same one — "ensure the resource exists before the response body is
 * streamed" — and the only other place that could is `proxy.ts`, which would
 * have to import the tab registry and the 43 panels hanging off it to do a job
 * six route files already do.
 *
 * Nothing was waiting behind that boundary. No page under here fetches on the
 * server; every screen is a client feature screen that draws its own pending
 * state the moment it mounts, and a lazily-imported panel brings its own
 * `TabPending` (`lib/shell/tab-registry.ts`). All it added to a first load was a
 * skeleton flash and 5KB of markup — measured, `/servers` went 61,931 → 56,496
 * bytes with time-to-first-byte unchanged.
 *
 * What it did cost, and the honest half of the trade: an undeclared slug now
 * serves an **empty body** under its 404 and paints on hydration, where before
 * it served the shell and a skeleton under a 200. Either way the words *"That
 * page is not here"* were never in the HTML — `notFound()` is caught by a client
 * boundary, and React does not run those during SSR — so what a first paint
 * loses is the masthead and rail, on a screen behind a sign-in wall that needs
 * JavaScript for every other pixel it draws. `undeclared-tab.test.ts` keeps the
 * boundary gone.
 *
 * `DeadSessionExit` is the **one** layout guard this app has, and
 * `CODING_STANDARDS.md` §3.7 permits no second one. `src/proxy.ts` lets an
 * expired-but-present cookie through on the understanding that the first 401
 * corrects it — and nothing under this shell ever sends a first request, since
 * every query is `enabled: organizationId !== null` and a dead session has no
 * Organization. So no 401 came: the frame below painted in full, empty, for a
 * visitor with no session, and `/sign-up` on an instance nobody owns became
 * unreachable from that browser
 * It wraps the
 * shell rather than sitting inside it so there is no authenticated frame to look
 * at while the session is being ended. Anything a *route* can protect belongs in
 * the proxy instead.
 *
 * **The branding is the one thing this layout fetches on the server**,
 * and it is not data a screen renders: it is the name in the title, the
 * favicon and the colours, seeded into the query cache so the masthead's mark
 * is right on the first paint. `fetch-branding.ts` has the argument. The
 * operator's custom CSS applies here — every signed-in page — and only here;
 * `BrandingStyle` says why the doors do not take it.
 */
export default async function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const branding = await loadBranding();

  return (
    <HydrationBoundary state={brandingState(branding)}>
      <BrandingStyle customCss />
      <DeadSessionExit>
        <ConsoleShell>{children}</ConsoleShell>
      </DeadSessionExit>
    </HydrationBoundary>
  );
}
