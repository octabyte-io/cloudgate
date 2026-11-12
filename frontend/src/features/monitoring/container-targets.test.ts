import { describe, expect, it } from "vitest";

import type { MetricsConfig, Server } from "@/lib/api/endpoints/servers";

import {
  containerTargets,
  targetNoun,
  type ContainerTarget,
} from "./container-targets";

/**
 * The one piece of the platform-host fix that is logic rather than layout, so
 * it is the piece that gets a test (§1.7): which hosts the Containers card is
 * given at all. The defect was that the list was built from `Server[]`, which
 * structurally cannot contain the machine Cloudgate runs on — on a default
 * single-box install that is every Application there is.
 *
 * Configs are written out field by field rather than derived from a factory that
 * mirrors `metricsConfig`, so a wrong expectation cannot agree with the code.
 */
function config(overrides: {
  token?: string;
  cronJob?: string;
  include?: string[];
}): MetricsConfig {
  return {
    server: {
      type: "Remote",
      refreshRate: 60,
      port: 4500,
      token: overrides.token ?? "metrics-token-1",
      urlCallback: "",
      retentionDays: 2,
      cronJob: overrides.cronJob ?? "0 0 * * *",
      thresholds: { cpu: 0, memory: 0 },
    },
    containers: {
      refreshRate: 15,
      services: { include: overrides.include ?? ["app-cslg4y"], exclude: [] },
    },
  };
}

function server(serverId: string, name: string, metrics: MetricsConfig): Server {
  return {
    serverId,
    name,
    description: null,
    ipAddress: "203.0.113.10",
    port: 22,
    username: "root",
    serverStatus: "active",
    serverType: "deploy",
    command: "",
    enableDockerCleanup: false,
    requestMetricsEnabled: false,
    reachCheckedAt: null,
    reachOk: null,
    reachMessage: null,
    setupRanAt: null,
    setupOk: null,
    setupMessage: null,
    sshKeyId: null,
    hostKeyFingerprint: null,
    maintenanceSince: null,
    maintenanceStartedBy: null,
    metricsConfig: metrics,
    createdAt: "2026-08-01T00:00:00.000Z",
    organizationId: "org-1",
    boughtServer: null,
  };
}

describe("containerTargets", () => {
  /** The whole fix: no Servers, and a card all the same. */
  it("gives the platform host a target when no Server has been added", () => {
    const targets = containerTargets(config({}), []);

    expect(targets).toEqual<ContainerTarget[]>([
      { id: null, name: "this host", config: config({}) },
    ]);
  });

  it("keeps the host first and one target per collecting Server", () => {
    const targets = containerTargets(config({}), [
      server("srv-1", "worker-1", config({ include: ["redis"] })),
      server("srv-2", "worker-2", config({ include: ["postgres"] })),
    ]);

    expect(targets.map((target) => [target.id, target.name])).toEqual([
      [null, "this host"],
      ["srv-1", "worker-1"],
      ["srv-2", "worker-2"],
    ]);
  });

  /**
   * An empty include list is the common case and it means "no container samples,
   * ever" — there is no value meaning everything — so a card for it would be a
   * chart that can never fill.
   */
  it("drops a host whose include list is empty and one that was never set up", () => {
    const targets = containerTargets(config({ include: [] }), [
      server("srv-1", "never-set-up", config({ token: "", cronJob: "" })),
      server("srv-2", "nothing-included", config({ include: ["  "] })),
      server("srv-3", "watching", config({ include: ["app-zk77rz"] })),
    ]);

    expect(targets.map((target) => target.id)).toEqual(["srv-3"]);
  });

  it("returns nothing when no host anywhere is collecting containers", () => {
    expect(containerTargets(null, [])).toEqual([]);
    expect(
      containerTargets(null, [
        server("srv-1", "idle", config({ token: "", cronJob: "" })),
      ]),
    ).toEqual([]);
  });

  /**
   * Stopping clears the token and keeps the rest of the config — and the
   * samples. The card vanishing at the press told the operator nothing had been
   * stored for containers on this host, while every row was still there.
   */
  it("keeps a host whose collection was stopped, since its samples are kept", () => {
    const stopped = config({ token: "" });

    const targets = containerTargets(stopped, [
      server("srv-1", "stopped", config({ token: "" })),
    ]);

    expect(targets.map((target) => target.id)).toEqual([null, "srv-1"]);
  });
});

describe("targetNoun", () => {
  it("names a Server a Server and the platform host a host", () => {
    expect(targetNoun({ id: null, name: "this host", config: null })).toBe(
      "this host",
    );
    expect(targetNoun({ id: "srv-1", name: "worker-1", config: null })).toBe(
      "this Server",
    );
  });
});
