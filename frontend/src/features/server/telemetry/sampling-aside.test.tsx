import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { MetricsConfig, Server } from "@/lib/api/endpoints/servers";

import { SamplingAside } from "./sampling-aside";

afterEach(cleanup);

function server(token: string, cronJob: string): Server {
  const metricsConfig: MetricsConfig = {
    server: {
      type: "Remote",
      refreshRate: 10,
      port: 4500,
      token,
      urlCallback: "http://127.0.0.1:4500/metrics",
      retentionDays: 2,
      cronJob,
      thresholds: { cpu: 0, memory: 0 },
    },
    containers: { refreshRate: 60, services: { include: [], exclude: [] } },
  };
  return {
    serverId: "srv-1",
    name: "ui-self",
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
    metricsConfig,
    createdAt: "2026-09-15T18:00:00.000Z",
    organizationId: "org-1",
    boughtServer: null,
  };
}

/**
 * After "Stop collecting" this panel read `Collecting: not set up`,
 * `Interval: —`, `Retention: —` over a config that still held all three.
 */
describe("SamplingAside", () => {
  it("shows a stopped Server as configured but off, not as never set up", () => {
    render(<SamplingAside server={server("", "0 3 * * *")} />);
    const text = document.body.textContent ?? "";

    expect(text).not.toContain("not set up");
    expect(text).toContain("stopped — samples kept");
    expect(text).toContain("10s, when started again");
    expect(text).toContain("2 days");
  });

  it("still says not set up for a Server nobody has configured", () => {
    render(<SamplingAside server={server("", "")} />);

    expect(document.body.textContent).toContain("not set up");
  });
});
