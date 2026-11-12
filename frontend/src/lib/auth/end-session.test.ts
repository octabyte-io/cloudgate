import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signOut = vi.hoisted(() => vi.fn());

vi.mock("./client", async (original) => ({
  ...(await original<typeof import("./client")>()),
  signOut,
}));

const endAllTerminals = vi.hoisted(() => vi.fn());

vi.mock("@/lib/realtime/gateways", () => ({ endAllTerminals }));

const { endSession } = await import("./end-session");

/**
 * Sign-out is three steps in one order, and everything else in this tree that
 * leaves the console leans on that order rather than restating it.
 *
 * `CODING_STANDARDS.md` §3.7 names all three ("end the session, empty the query
 * cache, leave with a full navigation") and
 * the dead-session loop is what happens when the first one is skipped:
 * `src/proxy.ts` reads cookie *presence*, so a navigation to `/sign-in` with
 * the dead cookie still set is answered by a bounce back to `/`, which 401s
 * again.
 *
 * Pinned here because a second thing now rests on it.
 * `console-gate.ts`'s expired branch leaves for `signInWithNext(at)` rather than
 * a bare `/sign-in`, and the dead-session triage forbade that parameter
 * *because of the loop*. The loop is the cookie's, not the parameter's — so the
 * parameter is safe exactly as long as step 1 still happens before step 3, and
 * nothing in the tree asserted that until this file.
 */

/** Every step, in the order it actually ran. */
let steps: string[];
let client: QueryClient;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  steps = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(client, "clear").mockImplementation(() => {
    steps.push("clear");
  });
  endAllTerminals.mockReset().mockImplementation(() => {
    steps.push("endAllTerminals");
  });
  assign = vi.fn((to: string) => {
    steps.push(`assign ${to}`);
  });
  // jsdom's own `location.assign` throws "Not implemented", and the point of the
  // test is the *order* of the three calls rather than what a real navigation
  // does — so the boundary is replaced, not driven.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign, href: "http://localhost/servers" },
  });
});

afterEach(() => {
  signOut.mockReset();
  vi.restoreAllMocks();
});

/**
 * better-auth resolves rather than throwing; `unwrap` is what re-throws.
 *
 * The label is recorded off a timer on purpose: a real `/sign-out` is a request,
 * and it settles turns of the loop later. A stub that recorded synchronously
 * would push "signOut" first even from a version of `endSession` that never
 * awaited it — so the ordering assertion would pass on the one regression it
 * exists to catch.
 */
function answers(result: { data: unknown; error: unknown }) {
  signOut.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(() => {
          steps.push("signOut");
          resolve(result);
        }, 0);
      }),
  );
}

describe("endSession", () => {
  it("ends the session before it navigates", async () => {
    answers({ data: { success: true }, error: null });

    await endSession(client, "/sign-in?next=%2Fservers");

    // The whole dead-session fix, and the whole of what licenses `?next=` on
    // `console-gate.ts`'s expired branch: by the time the browser asks for the
    // sign-in URL the cookie is gone, so `src/proxy.ts` has nothing to bounce
    // off — whatever the URL carries.
    expect(steps).toEqual([
      "signOut",
      "endAllTerminals",
      "clear",
      "assign /sign-in?next=%2Fservers",
    ]);
  });

  it("navigates when the session was already gone", async () => {
    // `/sign-out` answering 401 is the outcome that was asked for. Treating it
    // as a failure would strand whoever is already signed out on a console
    // screen that cannot fetch anything.
    answers({ data: null, error: { status: 401, message: "Unauthorized" } });

    await endSession(client, "/sign-in");

    expect(steps).toEqual([
      "signOut",
      "endAllTerminals",
      "clear",
      "assign /sign-in",
    ]);
  });

  it("does not navigate when the session could not be ended", async () => {
    // A 503 is the backend being unreachable, not the session being over. The
    // cookie is still valid, so navigating would hand `src/proxy.ts` a live
    // cookie on an auth path — the ping-pong this exists to stop — and clearing
    // the cache would empty a tab that is still perfectly signed in.
    answers({ data: null, error: { status: 503, message: "Service Unavailable" } });

    await expect(endSession(client, "/sign-in?next=%2Fservers")).rejects.toThrow(
      "Service Unavailable",
    );

    expect(steps).toEqual(["signOut"]);
    expect(assign).not.toHaveBeenCalled();
    // Still signed in, so the shells are still theirs.
    expect(endAllTerminals).not.toHaveBeenCalled();
  });
});
