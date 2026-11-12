import type { QueryClient } from "@tanstack/react-query";

import { isApiError } from "@/lib/api/api-error";
import { endAllTerminals } from "@/lib/realtime/gateways";

import { AuthError, unwrap } from "./auth-error";
import { signOut } from "./client";

/**
 * Signing out, as its steps — and the reason it is a function rather than
 * only the `useSignOut` hook.
 *
 * Two callers need this sequence and neither may have its own version of it.
 *
 * - **`use-sign-out.ts`** — a person pressing a button, which also wants a
 *   `pending` flag and a toast when it fails.
 * - **`lib/api/query-client.ts`** — the one place a 401 is acted on (§3.5), which
 *   is not a component and cannot call a hook.
 *
 * That second one is why this exists. It used to answer a 401 by redirecting to
 * `/sign-in` **with the dead cookie still set**, and the cookie is the only thing
 * `src/proxy.ts` looks at — so the gate bounced them straight back to where they
 * came from, which 401'd again. A round trip, not a correction, and the promise
 * that a first 401 self-corrects an expired-but-present cookie is the entire
 * justification for that gate checking presence rather than validity. Ending the
 * session is what makes it true.
 *
 * The steps, in order, and each one for its own reason:
 *
 * 1. **End the session on the backend**, so the cookie is gone. better-auth's
 *    `/sign-out` clears it and answers 200 whether or not the session was still
 *    good (`api/routes/sign-out.ts`), which is what makes this safe to call on a
 *    session already known to be dead.
 * 2. **End every terminal in this tab**, before anything else is
 *    torn down: a shell docked in the console layout is a socket that would
 *    otherwise stay open until the document goes, and the gateway's lease
 *    would end it only within 30 s of the cookie going (ADR-0012). The docked
 *    panel closes with it.
 * 3. **Empty the query cache.** Not redundant with the reload below: `assign()`
 *    does not stop React, so between here and the new document components can
 *    re-render and paint the previous person's rows. Every tenant key is scoped
 *    by active Organization, which stops one Organization's rows reaching another
 *    and does nothing about a *different person* on the same tab.
 * 4. **Leave with a full navigation.** `useSession` reads a module-level store the
 *    auth client owns, and any number of components hold rows fetched as the
 *    previous user; reloading the document is the only step that is guaranteed to
 *    leave none of it behind.
 *
 * It **throws** when step 1 fails for any reason other than the session already
 * being gone, and does not go on to the rest. Clearing the tab while the
 * cookie is still valid would be a lie, and navigating anyway is the redirect
 * ping-pong above. Each caller decides what to say about that.
 */
export async function endSession(
  queryClient: QueryClient,
  to: string,
): Promise<void> {
  try {
    await unwrap(signOut());
  } catch (error) {
    // A 401 is the outcome that was asked for: the session is already gone.
    const alreadyGone =
      error instanceof AuthError
        ? error.isUnauthenticated
        : isApiError(error) && error.isUnauthenticated;
    if (!alreadyGone) throw error;
  }

  endAllTerminals();
  queryClient.clear();
  window.location.assign(to);
}
