import { useSyncExternalStore } from "react";

/**
 * `false` for the server render and for the client render that hydrates it,
 * `true` from the render after.
 *
 * For anything the client already knows on its first render that the server
 * could not: a cached Organization list, a session. Rendered straight away, that
 * is a hydration mismatch React logs and does not repair — and under `next dev`
 * the re-render it falls back to also recreated the shell's inline `<script>`s,
 * which is the second error the same pages logged.
 * `useSyncExternalStore`'s server snapshot is what hydration reads, so the
 * client value arrives one render later with no effect and no flash.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
}

/** Hydration is the only change this waits for, and it happens once. */
function subscribeToNothing() {
  return () => {};
}
