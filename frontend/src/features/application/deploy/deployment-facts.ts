import type { Deployment } from "@/lib/api/endpoints/deployments";

/**
 * What is serving once the last Deployment has failed.
 *
 * The banner used to answer "the previous Deployment" every time, and it was
 * wrong twice over: after a **first** Deployment fails nothing has ever run,
 * and after Swarm rolls a service back to a spec no node can schedule the
 * previous Deployment is not running either (0/1, a 502 at the domain).
 *
 * Two readings, and each answers a different half:
 *
 * - The Deployment history, which every caller can read, says whether there
 *   **is** a previous release: without a `done` row nothing of this
 *   Application was ever swapped in, so no sentence may say "previous".
 * - `running` — tasks of the service Swarm reports running, from
 *   `docker service ps` — says whether anything is up **now**. `null` when
 *   that read could not answer (see `useRunningTasks`).
 *
 * So with no `done` row a running task is not a previous Deployment serving:
 * it is the release that just failed — a first Deployment whose container
 * started and then failed its health check — still up until Swarm stops it.
 * That is `running-unproven`, and it says so rather than borrowing the
 * previous-release copy.
 *
 * With `running` unknown and a `done` in the history, the answer stays the
 * previous Deployment — the ticket's own case, and the one a failed Deployment
 * normally leaves.
 */
export type AfterFailure =
  | "previous-serving"
  | "nothing-running"
  | "running-unproven"
  | "never-ran";

export function afterFailure(
  deployments: Deployment[],
  running: number | null,
): AfterFailure {
  const everDone = deployments.some((row) => row.status === "done");
  if (!everDone) {
    return running !== null && running > 0 ? "running-unproven" : "never-ran";
  }
  return running === 0 ? "nothing-running" : "previous-serving";
}

/**
 * The Build output card's subtitle for the live Deployment, shared by the
 * Overview and Deployments tabs so the two cannot drift
 * a `pending`
 * build is waiting for a slot and has written nothing yet, so it is not
 * "streaming".
 */
export function liveBuildSub(live: Pick<Deployment, "status">): string {
  return live.status === "pending"
    ? "Queued. It starts when a build slot frees up."
    : "Streaming as the build writes it.";
}
