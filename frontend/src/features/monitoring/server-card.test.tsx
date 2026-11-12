import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TIME_RANGE } from "@/components/console/time-range";
import type { ServerMetric } from "@/lib/api/endpoints/monitoring";
import type { MetricsConfig, Server } from "@/lib/api/endpoints/servers";

const useServerMetricsInWindow = vi.hoisted(() => vi.fn());
const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// Two system boundaries, replaced rather than driven: the HTTP read of the
// stored samples, and better-auth's session store that the setup mutation's
// `useInvalidate` reads at render. Every branch under test is the card's own.
vi.mock("@/lib/api/use-server-metrics", async (original) => ({
  ...(await original<typeof import("@/lib/api/use-server-metrics")>()),
  useServerMetricsInWindow,
}));

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { ServerCard } = await import("./server-card");

afterEach(() => {
  cleanup();
  useServerMetricsInWindow.mockReset();
  useActiveOrganizationId.mockReset();
});

/**
 * The config "Stop collecting" leaves behind, field for field as the U-run read
 * it off `GET /backend/servers/:id` after the press: every setting the
 * dialog writes is still there, and only the token is empty. Written out rather
 * than derived from a factory, on `container-targets.test.ts`' argument.
 */
const STOPPED: MetricsConfig = {
  server: {
    type: "Remote",
    refreshRate: 10,
    port: 4500,
    token: "",
    urlCallback: "http://127.0.0.1:4500/metrics",
    retentionDays: 2,
    cronJob: "0 3 * * *",
    thresholds: { cpu: 0, memory: 0 },
  },
  containers: {
    refreshRate: 60,
    services: { include: ["app-t64tnx"], exclude: [] },
  },
};

/** A Server as created: `defaultMetricsConfig`, which nobody has saved over. */
const NEVER: MetricsConfig = {
  server: {
    type: "Remote",
    refreshRate: 60,
    port: 4500,
    token: "",
    urlCallback: "",
    retentionDays: 2,
    cronJob: "",
    thresholds: { cpu: 0, memory: 0 },
  },
  containers: { refreshRate: 60, services: { include: [], exclude: [] } },
};

function server(metricsConfig: MetricsConfig): Server {
  return {
    serverId: "FsvHbV4hCtu-DKnuBy4fq",
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

function sample(timestamp: string, cpu: string): ServerMetric {
  return {
    cpu,
    cpuModel: "Intel(R) Xeon(R)",
    cpuCores: 2,
    cpuPhysicalCores: 1,
    cpuSpeed: 2400,
    os: "linux",
    distro: "Ubuntu 24.04",
    kernel: "6.8.0",
    arch: "x64",
    memUsed: "41.20",
    memUsedGB: "1.60",
    memTotal: "3.80",
    uptime: 86_400,
    diskUsed: "22.00",
    totalDisk: "38.00",
    networkIn: "101.00",
    networkOut: "51.00",
    timestamp,
  };
}

function said(config: MetricsConfig, samples: ServerMetric[]): string {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  useServerMetricsInWindow.mockReturnValue({
    data: samples,
    error: null,
    isPending: false,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ServerCard server={server(config)} range={DEFAULT_TIME_RANGE} />
    </QueryClientProvider>,
  );
  return document.body.textContent ?? "";
}

/** The stopped-state paragraph's text, exactly as rendered. */
function stoppedNote(): string | null {
  const note = [...document.querySelectorAll("p")].find((p) =>
    p.textContent?.startsWith("Collection is stopped for this Server"),
  );
  return note?.textContent ?? null;
}

/**
 * **Stopped is not never**.
 * "Stop collecting" clears the token and nothing else, and the card read that as
 * a Server that had never been set up: "there are no samples and there never
 * will be until it is", with a "Set up monitoring" button — beside 124 stored
 * rows and a config that was whole. The first case is the pin the ticket asked
 * for; the last keeps the never-set-up sentence where it is still true.
 */
describe("ServerCard", () => {
  it("draws a stopped Server's stored samples and offers the way to all of them", () => {
    const text = said(STOPPED, [
      sample("2026-09-15T18:41:55.000Z", "22.45"),
      sample("2026-09-15T18:42:05.000Z", "24.90"),
      sample("2026-09-15T18:42:15.946Z", "23.10"),
    ]);

    expect(text).not.toContain("there are no samples");
    expect(text).not.toContain("Set up monitoring");
    expect(text).toContain("Collection is stopped for this Server");
    expect(text).toContain("The samples stored before the stop are kept");
    expect(text).toContain("deleted once it is more than 2 days old");
    expect(text).toContain("Start collecting again");
    const history = document.querySelector(
      'a[href="/servers/FsvHbV4hCtu-DKnuBy4fq/telemetry"]',
    );
    expect(history?.textContent).toBe("Every stored sample");
    // The read is asked for while stopped — the gate that hid the rows.
    expect(useServerMetricsInWindow).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "FsvHbV4hCtu-DKnuBy4fq" }),
      expect.anything(),
      true,
    );
  });

  it("says a stopped Server's samples are kept when none fall in the range", () => {
    const text = said(STOPPED, []);

    expect(text).not.toContain("there are no samples");
    expect(text).toContain("none of them falls in the last");
    expect(
      document.querySelector(
        'a[href="/servers/FsvHbV4hCtu-DKnuBy4fq/telemetry"]',
      ),
    ).not.toBeNull();
  });

  /**
   * The whole paragraph, as the screen reads it. The first press of this card
   * on a live install read "more than 2 daysold": the text node after the unit
   * began with its space and carried an `&rsquo;`, which the build decodes at
   * the cost of that space. This pins the words and every space between them
   * with `toBe`; the build-only half of that defect is not visible to this
   * runner's transform, and `cloudgate/jsx-inline-element-spacing` is what
   * holds it.
   */
  it("says in one run of words how long a stopped Server's samples stay", () => {
    said(STOPPED, [
      sample("2026-09-15T18:41:55.000Z", "22.45"),
      sample("2026-09-15T18:42:05.000Z", "24.90"),
    ]);
    expect(stoppedNote()).toBe(
      "Collection is stopped for this Server, so nothing new is sampled and no CPU or memory notification can fire for it. The samples stored before the stop are kept, and drawn above. Each one is deleted once it is more than 2 days old, by the retention cleanup that goes on running, and the Server’s Telemetry tab reads all of them whatever the range here. Starting again keeps every setting it had.",
    );

    cleanup();
    said({ ...STOPPED, server: { ...STOPPED.server, retentionDays: 1 } }, []);
    expect(stoppedNote()).toBe(
      "Collection is stopped for this Server, so nothing new is sampled and no CPU or memory notification can fire for it. The samples stored before the stop are kept, and none of them falls in the last hour. Each one is deleted once it is more than 1 day old, by the retention cleanup that goes on running, and the Server’s Telemetry tab reads all of them whatever the range here. Starting again keeps every setting it had.",
    );
  });

  it("keeps the never-set-up sentence, and asks for nothing, where it is true", () => {
    const text = said(NEVER, []);

    expect(text).toContain("there are no samples and there never will be");
    expect(text).toContain("Set up monitoring");
    expect(text).not.toContain("Collection is stopped");
    expect(useServerMetricsInWindow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      false,
    );
  });
});
