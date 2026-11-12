import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { endSession } from "@/lib/auth/end-session";
import { recheckMembership } from "@/lib/auth/membership";
import { SIGN_IN_PATH, isAuthPath, signInWithNext } from "@/lib/auth/routes";

import { ApiError, isApiError, isUnreachableHost } from "./api-error";

/**
 * Re-exported for the callers F02 pointed at this module. The constant itself
 * moved to `src/lib/auth/routes.ts` when F06 built the screen: `src/proxy.ts`
 * needs it too, and the proxy cannot import this file — it would pull TanStack
 * Query into every request.
 */
export { SIGN_IN_PATH };

/**
 * Defaults tuned for an infrastructure console rather than a content site.
 *
 * The premise: most of what this app shows is expensive to fetch — a Server
 * audit shells out over SSH, a Deployment list joins across a Project — and
 * none of it changes because someone alt-tabbed. Anything that genuinely moves
 * on its own arrives over a socket (`src/lib/realtime/`), not by polling.
 */
export function makeQueryClient(): QueryClient {
  // `recheckMembership` beside the 401 handler, and for the same reason it is
  // here rather than on a screen: a session whose Organization dropped its
  // user is refused by every card at once, and none of them should have to
  // know that the shell's gate is the one to act on it.
  const onError = (error: Error) => {
    handleAuthFailure(error, client);
    recheckMembership(error);
  };
  // The client is handed to its own caches' error handlers, because ending a
  // session includes emptying this cache. Referencing it from inside its own
  // initializer is safe and deliberate: nothing calls `onError` while the
  // constructor runs, and the annotation is what keeps it from inferring `any`.
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        // Alt-tabbing is not a reason to re-run an SSH command.
        refetchOnWindowFocus: false,
        // Long enough that moving between tabs of one Application does not
        // refetch, short enough that coming back to a list shows current state.
        staleTime: 30_000,
        retry: retryUnlessTheAnswerWillNotChange,
      },
      mutations: {
        // A mutation is someone pressing a button. Retrying it silently could
        // deploy twice; if it failed, say so and let them press it again.
        retry: false,
      },
    },
  });

  return client;
}

/**
 * Retrying a 4xx just asks the same refused question again — the session is
 * gone, the role does not allow it, or the row is not there. Retry only what
 * could plausibly answer differently: a 5xx, or a request that never landed.
 *
 * **The one 5xx that will not answer differently is a machine nobody reached**
 * The docker and
 * swarm reads answer 503 `HOST_UNREACHABLE` for that (`isUnreachableHost`, and
 * `HOST_UNREACHABLE_CODE` in `backend/src/docker-ops/host-reachability.ts` is
 * where the name is decided), and the arithmetic is what makes it worth a
 * branch: the failed attempt has already spent `ssh2`'s 20-second
 * `readyTimeout` against a host that is firewalled or down, so two retries buy
 * a second and a third 20 seconds — **a minute of spinner** — for an answer
 * three SSH connects inside one window are not going to change. A screen that
 * polls (`useStackContainers` refetches every 4 seconds while a converge is
 * live) still notices a host that comes back, and so does its refetch button.
 *
 * **The platform host is the same call, and the arithmetic is *not* the reason**
 * That issue
 * split it onto `PLATFORM_HOST_UNREACHABLE`, and `isUnreachableHost` covers
 * both arms on purpose, so no code here changed and this paragraph is the whole
 * decision. There is no SSH dial on that arm — the platform host's reads are
 * `child_process`, and its transport failure is `execFile` unable to spawn
 * `docker` at all — so the 20 seconds is not what is being saved. What holds is
 * the other half of the argument, which is the load-bearing one: the answer
 * will not change. A `docker` binary that is missing, or a daemon socket the
 * backend cannot open, is not going to appear inside the two attempts that
 * follow, and each one costs an SSH-free but still-real spawn. Retrying it
 * would buy a spinner and no new fact. The screens that poll and the refetch
 * buttons notice the moment it comes back, exactly as on the Server arm.
 *
 * **An instance with templates off is the third.** The 503
 * `TEMPLATES_CATALOGUE_NOT_CONFIGURED` is answered before any fetch leaves the
 * backend, and it stays true until the backend is restarted with other
 * settings, so a retry costs a spinner and cannot produce a catalogue.
 *
 * **Here rather than on the queries**, which is the
 * whole point: `useStackContainers`'s three reads had inherited the two retries
 * without anyone noticing, so a Swarm stack's Containers tab cost nine SSH
 * attempts, and `use-server-docker.ts`'s cards had the fix hand-written as
 * `retry: false` — the second copy of which would have been the third. Every
 * docker query written after this one gets it for free.
 *
 * **Not a message match**, and the constraint comes from the backend that
 * publishes it: `host-reachability.ts` says so outright, its two sentences are
 * §2.5 strings written for whoever reads the journal, and `auth-error.ts`
 * records exactly that pattern as deleted. `isUnreachableHost` reads the code
 * beside the status, so an **uncoded** 503 — the backend's own, a dependency
 * that answered badly rather than a machine nobody reached, which may well
 * answer on the second attempt — keeps both its retries. That distinction is
 * pinned: a fix written as "never retry a 503" passes every other case in
 * `query-client.test.ts`. (Read *uncoded* rather than *unnamed machine*: now
 * the platform host has a name of its own and does not retry either.)
 *
 * Exported for that test and for nothing else — the same reason
 * {@link isDeadSession} is, and the same argument: this is a policy every query
 * in the console inherits without declaring, so the place it is stated is the
 * place it has to be pinned. Nothing should call it; set `retry` on a query if
 * that query needs something else.
 */
export function retryUnlessTheAnswerWillNotChange(
  failureCount: number,
  error: Error,
): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) {
    return false;
  }
  if (isUnreachableHost(error)) {
    return false;
  }
  if (isApiError(error) && error.isCatalogueNotConfigured) {
    return false;
  }
  return failureCount < 2;
}

/**
 * The single place a dead session is acted on — and it **ends the session**
 * rather than redirecting to `/sign-in`.
 *
 * Every query and every mutation routes its errors through here, so no feature
 * has to think about 401, and §3.5 requires that this stay the only such place.
 *
 * A 403 deliberately falls through: the caller is signed in, and their role does
 * not carry the action. Signing them out would misdescribe what happened and
 * lose their place. The screen shows the refusal where the control is. That
 * includes a caller no longer in the Organization: their session is
 * still good, and it is the one they switch Organization with, so that refusal
 * only makes `recheckMembership` read the list again for the shell's gate.
 *
 * **Why it ends the session**:
 * this used to `assign(signInWithNext(...))` and nothing else, which left the
 * dead cookie in place — and cookie presence is the whole of what `src/proxy.ts`
 * checks, so its `isAuthPath && hasSession` branch sent them straight back to
 * `next`, which 401'd again. A ping-pong, not a self-correction, on every screen
 * in the console that fetches. The gate is optimistic *on the promise* that the
 * first 401 corrects an expired-but-present cookie; `endSession` is what keeps
 * that promise, because the cookie is the thing that has to go.
 *
 * The one screen this must never fire on is a door: `isAuthPath` and not just
 * `/sign-in`, because the action is now destructive rather than a redirect, and
 * a public read that 401s on the way in must not sign anyone out of the session
 * they are in the middle of establishing.
 */
function handleAuthFailure(error: unknown, queryClient: QueryClient): void {
  if (typeof window === "undefined") return;
  if (!isDeadSession(error, window.location.pathname)) return;
  // Every query on the screen 401s together, and one dead session needs one
  // sign-out, not one per card. A module-level latch rather than per-client
  // state: this is only ever reached in a browser, where there is exactly one
  // document, and it is released again if the sign-out itself never lands.
  if (leaving) return;
  leaving = true;

  void endSession(
    queryClient,
    signInWithNext(window.location.pathname + window.location.search),
  ).catch(() => {
    // The sign-out request itself failed — the backend is unreachable, since
    // better-auth answers this one 200 whether or not the session was good. Say
    // nothing extra: the query that produced the 401 is already rendering
    // `errorMessage()`'s "Your session has ended. Sign in again to pick up where
    // you left off.", which is both true and the way out. Navigating anyway
    // would be the ping-pong this exists to end.
    leaving = false;
  });
}

/** Set for as long as one dead session is being ended. See `handleAuthFailure`. */
let leaving = false;

/**
 * Whether a failed request means the session is gone — the two-line decision
 * that must not widen, extracted so it can be pinned.
 *
 * It got sharper teeth in that issue: this used to lead to a redirect, and now it
 * ends the session. Both ways of being wrong are silent. Widen it to a 403 and a
 * role refusal signs someone out of an Organization they are a member of; let it
 * reach a door and a public read failing on the way in destroys the session
 * someone is in the middle of establishing.
 */
export function isDeadSession(error: unknown, pathname: string): boolean {
  if (!(error instanceof ApiError) || !error.isUnauthenticated) return false;
  return !isAuthPath(pathname);
}
