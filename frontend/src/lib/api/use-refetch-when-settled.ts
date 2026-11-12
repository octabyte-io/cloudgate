import { useEffect, useRef } from "react";

/**
 * Read a service's row once more when the build it was polled for ends.
 *
 * An Application's and a Compose stack's status are columns the deployment
 * engine writes **at the end** of a build, just before the Deployment's own
 * status — so by the time the Deployments list reads a build as settled, the
 * row already carries its outcome. The row is polled only while a build is
 * live, and "live" comes from that list — so the list's poll that sees `done`
 * is also the one that switches the row's poll off, and the status the build
 * had just written was never read. The screen went on saying `error` over a service that had just
 * released, or `idle` with Start offered over one that was running, until a
 * reload.
 *
 * So the transition itself fetches: live → not live refetches once. Not on
 * mount (a screen opened after the build has nothing to catch up on), and not
 * on not live → live, which the poll covers.
 */
export function useRefetchWhenSettled(
  live: boolean,
  refetch: () => Promise<unknown>,
): void {
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) void refetch();
    wasLive.current = live;
  }, [live, refetch]);
}
