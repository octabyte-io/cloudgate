import { cleanStores } from "nanostores";
import { afterEach, beforeAll } from "vitest";

import { apiOriginScript } from "@/lib/config";

/**
 * What the root layout does for every page it serves: hand the browser the
 * API's address the console was started with (ADR-0082). A console test is a
 * page that layout served, so it gets the same script, with the address
 * `pnpm dev:backend` listens on.
 *
 * Only where there is a page: a file marked `// @vitest-environment node`
 * (`src/proxy.test.ts`, the request proxy) runs where the server does, with no
 * `window` to hand anything to, and reads the address from its environment.
 */
if (typeof window !== "undefined") {
  new Function(
    apiOriginScript({ CLOUDGATE_API_URL: "http://localhost:4000" }),
  )();
}

/**
 * **Release better-auth's stores after every test, while the page is still
 * there** (#81).
 *
 * A test that mounts the real auth client — `useSession()` and the hooks over
 * it — leaves its atoms mounted on a nanostores timer: unmounting the last
 * reader schedules the atom's cleanup a second later (`STORE_UNMOUNT_DELAY`),
 * and that cleanup takes better-auth's listeners off `window`. When a file ends
 * inside that second, jsdom is gone by the time it runs, and the lane ends on
 * an unhandled `ReferenceError: window is not defined` with every test green.
 * `cleanStores` runs the cleanup now and leaves the timer nothing to do.
 *
 * Here rather than in each file because a run with the teardown forced showed
 * two dozen files mounting the client — most of them through a component that
 * reads the session, not the client by name — and the next one would not know
 * to add it. `session-store-release.test.tsx` is the gate.
 *
 * Only once the store has been mounted, which is when better-auth creates its
 * page-wide broadcast channel: importing the client here for a file that never
 * did would create it before that file stubs `fetch`, and the client keeps the
 * `fetch` it was created with. The channel is cleared before each file so one
 * file's mount is not read as the next one's.
 */
const BROADCAST_CHANNEL = Symbol.for("better-auth:broadcast-channel");

beforeAll(() => {
  delete (globalThis as Record<symbol, unknown>)[BROADCAST_CHANNEL];
});

afterEach(async () => {
  if (!(BROADCAST_CHANNEL in globalThis)) return;
  let atoms: AuthAtoms | undefined;
  try {
    atoms = (await import("@/lib/auth/client")).authClient.$store.atoms;
  } catch {
    return; // A file that mocks the client without one: nothing real to release.
  }
  if (!atoms) return;
  // The atoms that mount — the session, and the organization plugin's reads
  // over it; the signals beside them have no lifecycle. By name, because the
  // client hands `atoms` out through a proxy that lists no keys.
  cleanStores(
    atoms.session,
    atoms.listOrganizations,
    atoms.activeOrganization,
    atoms.activeMember,
    atoms.activeMemberRole,
  );
});

type AuthAtoms =
  (typeof import("@/lib/auth/client"))["authClient"]["$store"]["atoms"];
