import { describe, expect, it } from "vitest";

import type { ComposeType } from "@/lib/api/endpoints/compose";
import type { ApplicationStatus } from "@/lib/api/endpoints/applications";

import { whyNothingRuns } from "./nothing-running";

const stack = (composeStatus: ApplicationStatus, composeType: ComposeType) => ({
  composeStatus,
  composeType,
});

/**
 * What the Containers and Logs tabs say over a stack with nothing running.
 *
 * **What broke.** Stop wrote `idle`, the column's own default, so both tabs
 * read a stack an operator had just stopped as the one case `idle` was
 * written for and said *"This stack has not been deployed yet"* — above a
 * Deployments tab listing the release that ran. Stop now writes `stopped`,
 * and these sentences are the readers that have to follow it: a stopped stack
 * is told the control that brings it back, which is Start for a
 * `docker-compose` stack and Deploy for a Swarm one, whose Stop was a
 * `docker stack rm`.
 */
describe("whyNothingRuns", () => {
  it.each(["containers", "output"] as const)(
    "on the %s tab, does not tell a stopped stack it was never deployed",
    (surface) => {
      for (const type of ["docker-compose", "stack"] as const) {
        const stopped = whyNothingRuns(stack("stopped", type), surface);
        const neverDeployed = whyNothingRuns(stack("idle", type), surface);

        expect(neverDeployed).toContain("not been deployed yet");
        expect(stopped).not.toContain("not been deployed");
        expect(stopped).toContain("stopped");
      }
    },
  );

  it.each(["containers", "output"] as const)(
    "on the %s tab, names Start for a docker-compose stack and Deploy for a Swarm one",
    (surface) => {
      const compose = whyNothingRuns(stack("stopped", "docker-compose"), surface);
      const swarm = whyNothingRuns(stack("stopped", "stack"), surface);

      expect(compose).toContain("Start");
      // A Swarm stack has no Start — the control is absent and the route
      // refuses it (H-106) — so pointing at it would be a dead end.
      expect(swarm).not.toContain("Start");
      expect(swarm).toContain("Deploy");
    },
  );

  it("keeps the build-log pointer for a stack that is meant to be up", () => {
    expect(whyNothingRuns(stack("done", "docker-compose"), "containers")).toContain(
      "Deployments tab",
    );
    expect(whyNothingRuns(stack("error", "stack"), "output")).toContain(
      "Deployments tab",
    );
  });
});
