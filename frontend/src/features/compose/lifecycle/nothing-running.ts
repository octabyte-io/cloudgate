import type { Compose } from "@/lib/api/endpoints/compose";

/**
 * Why the Containers or Logs tab has nothing to show, read off the row.
 *
 * **Three answers, because the row has three**. `idle` is the column's
 * default, so it is a stack no Deployment has run. `stopped` is written by
 * Stop and by Remove containers and by nothing else, so it is a stack that ran
 * and was taken down on purpose. Anything else was meant to be up, and the
 * build log is where to look. Stop once wrote `idle` too, and both tabs
 * told an operator who had just pressed it that the stack had never been
 * deployed.
 *
 * **The way back depends on the type**, and a stopped stack is told it: Start
 * runs `compose up -d` over the code already on the deploy target, but a Swarm
 * stack's Stop was `docker stack rm` and it has no Start — the control is
 * absent and the route refuses it (H-106) — so Deploy is the one to name.
 */
export function whyNothingRuns(
  compose: Pick<Compose, "composeStatus" | "composeType">,
  surface: "containers" | "output",
): string {
  if (compose.composeStatus === "idle") {
    return surface === "containers"
      ? "This stack has not been deployed yet. Deploying reads its compose file and creates a container for every service in it."
      : "This stack has not been deployed yet. A container writes its output from the moment it starts.";
  }
  if (compose.composeStatus === "stopped") {
    const lede =
      surface === "containers"
        ? "This stack is stopped."
        : "This stack is stopped, so no container is writing output.";
    return compose.composeType === "stack"
      ? `${lede} Stop removed its services from Swarm, and Deploy recreates them.`
      : `${lede} Start brings its containers back up from the code already on the deploy target, without a build.`;
  }
  return surface === "containers"
    ? "Docker has no containers under this stack's name. The build log on the Deployments tab says what happened to the last attempt."
    : "No container under this stack's name is on the deploy target. The build log on the Deployments tab says what happened.";
}
