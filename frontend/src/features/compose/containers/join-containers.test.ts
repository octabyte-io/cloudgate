import { describe, expect, it } from "vitest";

import type { ContainerMatch, SwarmTask } from "@/lib/api/endpoints/docker";

import { joinContainers } from "./join-containers";

function member(name: string): ContainerMatch {
  return { containerId: `id-${name}`, name, state: "running", status: "Up" };
}

function task(name: string, node: string): SwarmTask {
  return {
    containerId: "",
    name,
    state: "Running",
    node,
    currentState: "Running",
    error: "",
  };
}

/**
 * A service whose name is the start of another's (`ackee` and `ackee-mongo`, the
 * Ackee template) once put the mongo container under `ackee` and listed
 * `ackee-mongo` as not running.
 */
describe("joinContainers", () => {
  it("attributes each compose container to its own service when one name prefixes another", () => {
    const rows = joinContainers({
      appName: "compose-plm1ni",
      swarm: false,
      declared: ["ackee", "ackee-mongo"],
      members: [
        member("compose-plm1ni-ackee-1"),
        member("compose-plm1ni-ackee-mongo-1"),
      ],
      listing: undefined,
      tasks: undefined,
    });

    expect(rows.map((row) => [row.service, row.name])).toEqual([
      ["ackee", "compose-plm1ni-ackee-1"],
      ["ackee-mongo", "compose-plm1ni-ackee-mongo-1"],
    ]);
  });

  it("attributes the prefixed service correctly whichever order the file declares them in", () => {
    const rows = joinContainers({
      appName: "stack",
      swarm: false,
      declared: ["web-api", "web"],
      members: [member("stack-web-api-1"), member("stack-web-2")],
      listing: undefined,
      tasks: undefined,
    });

    expect(rows.map((row) => row.service)).toEqual(["web-api", "web"]);
  });

  it("attributes swarm containers by the full service name", () => {
    const rows = joinContainers({
      appName: "stack",
      swarm: true,
      declared: ["ackee", "ackee-mongo"],
      members: [member("stack_ackee.1.abc"), member("stack_ackee-mongo.1.def")],
      listing: undefined,
      tasks: undefined,
    });

    expect(rows.map((row) => row.service)).toEqual(["ackee", "ackee-mongo"]);
  });

  it("matches a swarm container to its own slot's task, not one whose slot number it starts with", () => {
    const rows = joinContainers({
      appName: "stack",
      swarm: true,
      declared: ["web"],
      members: [member("stack_web.10.xyz")],
      listing: undefined,
      tasks: [task("stack_web.1", "node-a"), task("stack_web.10", "node-b")],
    });

    expect(rows[0]?.node).toBe("node-b");
  });
});
