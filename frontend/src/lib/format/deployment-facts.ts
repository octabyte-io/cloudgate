import type { Deployment } from "@/lib/api/endpoints/deployments";

/**
 * Which of a service's Deployments is live, and which one a screen is showing.
 *
 * Moved out of `features/application/deploy/` under the promotion rule
 * (CODING_STANDARDS §1.4): the Compose screens import both, and
 * `useCompose` decides its poll with `newestLive`. What stays behind,
 * `afterFailure`, reads an Application's Swarm tasks and is that feature's
 * alone.
 */

/**
 * The newest Deployment still writing, or `null`.
 *
 * `createdAt` decides, not `startedAt`: a queued build has no `startedAt` at all,
 * and it is exactly the one someone is waiting to see start.
 */
export function newestLive(deployments: Deployment[]): Deployment | null {
  const live = deployments.filter(
    (row) => row.status === "pending" || row.status === "running",
  );
  if (live.length === 0) return null;
  return live.reduce((newest, row) =>
    row.createdAt > newest.createdAt ? row : newest,
  );
}

/**
 * Whether the Deployment being watched is some other one than `newest` — the
 * only case in which an offer to show the newest would change what is on screen.
 *
 * **Ids, not rows, and `null` is not a Deployment.** The offer used to be
 * `watching !== live`, and `newestLive` is `null` the moment the build someone
 * just started finishes — so every finished deploy grew a button that re-showed
 * the Deployment already shown. With nothing to compare against there is nothing
 * newer to offer.
 */
export function watchingOther(
  watching: Deployment | null,
  newest: Deployment | null,
): boolean {
  return (
    watching !== null &&
    newest !== null &&
    watching.deploymentId !== newest.deploymentId
  );
}
