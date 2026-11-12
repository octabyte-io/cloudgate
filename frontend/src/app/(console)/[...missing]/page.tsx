import { notFound } from "next/navigation";

/**
 * Every address that matches no other route, answered **inside the console
 * shell**.
 *
 * Without this an unknown URL fell through to the root `app/not-found.tsx`,
 * which has no shell around it — so a signed-in operator who mistyped an
 * address lost the masthead and the rail, and was told that signing in would
 * take them to their Organization. `proxy.ts` sends anyone without a session to
 * sign-in before routing ever reaches here, and `DeadSessionExit` ends a
 * session that is only a stale cookie, so whoever this renders for is signed
 * in; `(console)/not-found.tsx` is the screen they get, under a real 404.
 *
 * A catch-all is the least specific route Next has, so every declared route
 * still wins over it, and the `beforeFiles` rewrites to Nest run before routing
 * at all (`next.config.ts`). The root not-found stays for a `notFound()` thrown
 * outside the console, where there may be no session to draw a shell around.
 */
export default function UnknownConsoleAddress(): never {
  notFound();
}
