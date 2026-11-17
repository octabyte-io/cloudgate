import type { Compose } from "@/lib/api/endpoints/compose";
import type { ContainerMatch } from "@/lib/api/endpoints/docker";

/**
 * Docker's states for a container that is up: `restarting` is Docker
 * keeping one up through its restart policy, which Start's `up -d` would
 * leave exactly as it is.
 */
const UP = new Set(["running", "restarting"]);

/**
 * Which of the two a `docker-compose` stack's row offers in Start's place.
 *
 * **One slot, never both.** On a stack whose containers are all up, Start is
 * `docker compose up -d` (or `start`, on a Stack VM) over containers that are
 * already running, so it does nothing and looked as usable as anything else
 * in the row. Restart is the press that means something there, and it is the
 * same route either way: `docker compose restart`, which on a Stack VM leaves
 * the VM running (ADR-0070).
 *
 * - **`idle` and `stopped` are Start.** `idle` is off with its reason; a
 *   stopped stack, with its containers exited or removed, is what Start is for.
 * - **On a Server, the containers decide** once their membership read has
 *   answered: every one of them up is Restart. One exited, or none there at
 *   all, is Start, since `up -d` brings back what is down and Restart would
 *   leave a removed container removed. Until the read answers, `done`, the
 *   status a successful Deploy, Start or Restart writes, stands in for it.
 * - **On a Stack VM only the status says**: its membership is not read from
 *   the VM. `done` is Restart; `error` is Start, because a failed Start may
 *   have left the VM down, and only Start brings the VM back (Restart refuses
 *   a stopped VM, naming Start).
 *
 * A Swarm stack has neither: Start is absent and the restart route refuses it,
 * since Deploy is what restarts a Swarm stack.
 */
export function startOrRestart({
  composeStatus,
  stackVm,
  members,
}: {
  composeStatus: Compose["composeStatus"];
  stackVm: boolean;
  /** The membership read's answer, `undefined` while it has none. */
  members: readonly Pick<ContainerMatch, "state">[] | undefined;
}): "start" | "restart" {
  if (composeStatus === "idle" || composeStatus === "stopped") return "start";
  if (stackVm || members === undefined) {
    return composeStatus === "done" ? "restart" : "start";
  }
  return members.length > 0 && members.every((c) => UP.has(c.state))
    ? "restart"
    : "start";
}
