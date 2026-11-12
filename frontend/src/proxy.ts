import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  NEXT_PARAM,
  isAuthPath,
  safeNextPath,
  signInWithNext,
} from "@/lib/auth/routes";

/**
 * The gate in front of the console.
 *
 * **This file is `proxy.ts`, not `middleware.ts`.** Next 16 renamed the
 * convention — same behaviour, new name, and the old one is deprecated
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`).
 * A `middleware.ts` here would simply never run, which is the worst way for an
 * auth gate to be wrong.
 *
 * It does exactly one thing: **it looks for a session cookie.** It does not
 * validate the cookie, and it must not — Next's own guidance is that this layer
 * is for optimistic checks, not for authorization, and every request it made
 * would sit in front of every navigation. The backend is the authority: each controller
 * resolves the session itself, and F02 routes a 401 back here from anywhere in
 * the app **that fetches**. So the honest description of this file is *it keeps
 * signed-out visitors off screens that would only 401*, and nothing more. (The
 * one exception is `/dev/*` under `next dev` — the matcher's note says why.)
 *
 * That qualifier used to read "from anywhere in the app", and it was the whole
 * justification for checking presence rather than validity, and it was not true
 * Two ways:
 *
 * - **Nothing fetched.** Every query under the console shell is
 *   `enabled: organizationId !== null`, and with no session there is no
 *   Organization — so a stale cookie brought no 401 at all. The shell painted its
 *   full authenticated frame over skeletons that never resolved, and `/sign-up`
 *   on an instance nobody owned was redirected away from the one visitor who
 *   could have claimed it.
 * - **A 401 alone cannot correct it.** `query-client.ts` answers one by leaving
 *   for `/sign-in?next=…`, and the cookie is still set — so the branch below
 *   sends them back to `next`, which 401s again. Round trip, not correction.
 *
 * Both are the same missing step: **something has to end the session**, because
 * the cookie is what this file reads. Validating it here instead would be a
 * session lookup in front of every navigation, which is the cost this layer
 * exists not to pay. So it is ended once, in
 * `components/shell/dead-session-exit.tsx` — and `CODING_STANDARDS.md` §3.7
 * permits that one layout guard and no other: a second one means this matcher was
 * wrong.
 *
 * The matcher earns its complexity. Proxy runs **before** `beforeFiles` rewrites
 * (the execution order is in that doc), so without the exclusions below it would
 * also see `/api/auth/*` and `/backend/*` — the two paths `next.config.ts`
 * forwards to Nest. Redirecting a sign-in POST to `/sign-in` because it has no
 * session cookie yet is a gate that locks the door it is standing in front of.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  // Presence, not validity. An expired-but-present cookie gets through here and
  // is refused by the backend, which then sends them back with `?next=` intact —
  // one round trip, and no session lookup on the hot path. Where nothing is sent
  // and so nothing is refused, `DeadSessionExit` is what sends them back.
  const hasSession = getSessionCookie(request) !== null;

  // The galleries, under `next dev` only. `next build` inlines `NODE_ENV` as
  // `"production"`, so in what ships this branch is dead code and `/dev/*` is
  // gated like every other screen.
  if (isDevGallery(pathname) && process.env.NODE_ENV !== "production") {
    return NextResponse.next();
  }

  if (isAuthPath(pathname)) {
    if (!hasSession) return NextResponse.next();
    // Already signed in, so these screens have nothing to offer. `?next=` is
    // honoured on the way past: it is how a 401 mid-session lands someone back
    // where they were, and by the time they arrive the cookie may be valid again
    // (another tab signed in).
    const intended = safeNextPath(request.nextUrl.searchParams.get(NEXT_PARAM));
    return NextResponse.redirect(new URL(intended, request.url));
  }

  if (hasSession) return NextResponse.next();

  // A console route with no session. Carry where they were headed, so signing in
  // finishes the navigation they started rather than dropping them at home.
  return NextResponse.redirect(
    new URL(signInWithNext(pathname + search), request.url),
  );
}

/**
 * `/dev` and everything under it — the design-system galleries and the
 * data-layer harness in `src/app/dev/`. A path test, not a prefix test, so
 * `/devices` is not one.
 */
function isDevGallery(pathname: string): boolean {
  return pathname === "/dev" || pathname.startsWith("/dev/");
}

export const config = {
  /*
   * Everything except:
   *
   * - `api/auth` and `backend` — Nest, reached through this app's origin. They
   *   are rewritten in `beforeFiles`, which runs *after* this, so they arrive
   *   here as ordinary paths and would be gated like pages.
   * - `_next/static`, `_next/image` — the build output. A matcher that catches
   *   these redirects the CSS of the very page it redirected to.
   * - `accept-invitation` — the one screen that is correct for a signed-in and a
   *   signed-out visitor alike. It handles both itself (`routes.ts` says why).
   * - `favicon.ico` and anything with a file extension — public assets.
   *
   * A negative lookahead rather than a list of protected paths on purpose: a new
   * screen is protected by existing, and forgetting to add it to a list is a
   * mistake that leaves it open.
   *
   * **`dev` is not excluded, and must not be**. The token, primitive,
   * row and data galleries used to be, on the grounds that they "make no
   * authenticated calls" — which was untrue of `/dev/data`, and a production
   * install then answered 200 to a signed-out request for all five. They are
   * how the design system is reviewed, so `proxy()` lets them through under
   * `next dev` (`isDevGallery` above); in a production build they are behind
   * the gate like everything else. A lookahead is a prefix test, too: a bare
   * `dev` here also exempted `/devices` and `/developer`. `src/proxy.test.ts`
   * pins both halves.
   *
   * **`mcp$` is excluded, and only that exact path**. An MCP client
   * carries an Agent key and never a session cookie, so the gate would answer
   * every call with a 307 to `/sign-in` before the rewrite forwarded it; the
   * endpoint authenticates the key itself. Anchored, for the prefix reason
   * above: `/mcp-anything` stays behind the gate.
   *
   * **`ai/` is excluded, as a prefix with its slash**: the Gateway's
   * `/ai/<AI model id>/v1/*`, which `next.config.ts` forwards on an install
   * with no console domain. A caller carries an Agent key, never a session
   * cookie, and the Gateway authenticates the key itself. The slash keeps
   * `/ai` itself and `/aim` behind the gate.
   */
  matcher: [
    "/((?!api/auth|backend|mcp$|ai/|_next/static|_next/image|accept-invitation|favicon.ico|.*\\.[^/]+$).*)",
  ],
};
