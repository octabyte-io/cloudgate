import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { monitoringApi, type ServerMetric } from "@/lib/api/endpoints/monitoring";
import type { MetricsConfig, Server } from "@/lib/api/endpoints/servers";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { useServerMetricsInWindow } = await import("./use-server-metrics");

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * The three configs a Server row can carry, written out rather than derived
 * (`container-targets.test.ts`' argument). `refreshRate: 2` is the floor
 * `useMetricsQuery` clamps to, so a poll shows up inside a few seconds of fake
 * time.
 */
function metricsConfig(server: Partial<MetricsConfig["server"]>): MetricsConfig {
  return {
    server: {
      type: "Remote",
      refreshRate: 2,
      port: 4500,
      token: "",
      urlCallback: "http://127.0.0.1:4500/metrics",
      retentionDays: 2,
      cronJob: "0 3 * * *",
      thresholds: { cpu: 0, memory: 0 },
      ...server,
    },
    containers: { refreshRate: 60, services: { include: [], exclude: [] } },
  };
}

/** What "Stop collecting" leaves: the token cleared, the setup it made kept. */
const STOPPED = metricsConfig({ token: "" });
/** A Server as created: nobody has saved a setup over `defaultMetricsConfig`. */
const NEVER = metricsConfig({ token: "", urlCallback: "", cronJob: "" });
/** Sampling now; the flag is how every read but `GET /servers/:id` says so. */
const COLLECTING = metricsConfig({ token: undefined, hasToken: true });

function server(config: MetricsConfig): Server {
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
    metricsConfig: config,
    createdAt: "2026-09-15T18:00:00.000Z",
    organizationId: "org-1",
    boughtServer: null,
  };
}

const STORED: ServerMetric[] = [];

const BOUNDS = {
  start: "2026-09-15T17:42:15.000Z",
  end: "2026-09-15T18:42:15.000Z",
};

function mount(config: MetricsConfig) {
  const read = vi
    .spyOn(monitoringApi, "serverMetrics")
    .mockResolvedValue(STORED);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const hook = renderHook(
    () => useServerMetricsInWindow(server(config), BOUNDS),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { read, hook };
}

/** Let several poll intervals' worth of fake time pass. */
async function afterSeveralPolls() {
  await act(() => vi.advanceTimersByTimeAsync(7_000));
}

/**
 * **The gate the Server card's test cannot see**.
 * `server-card.test.tsx` replaces this hook, so it proves the card *asks* for a
 * stopped Server's samples and not that the query then runs. Gated on "a token
 * is set", it did not: the card sat on a skeleton for ever beside 124 stored
 * rows. The cases are the three states `samplingState` names, each read for
 * whether the request is made and whether it is repeated.
 */
describe("useServerMetricsInWindow", () => {
  it("reads a stopped Server's stored samples once, and does not poll", async () => {
    const { read, hook } = mount(STOPPED);

    await waitFor(() => expect(hook.result.current.isPending).toBe(false));
    expect(hook.result.current.data).toEqual([]);
    expect(read).toHaveBeenCalledWith("FsvHbV4hCtu-DKnuBy4fq", BOUNDS);

    await afterSeveralPolls();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing for a Server that was never set up", async () => {
    const { read, hook } = mount(NEVER);

    await afterSeveralPolls();
    expect(read).not.toHaveBeenCalled();
    expect(hook.result.current.fetchStatus).toBe("idle");
  });

  it("polls a collecting Server at its own refresh rate", async () => {
    const { read, hook } = mount(COLLECTING);

    await waitFor(() => expect(hook.result.current.isPending).toBe(false));
    await afterSeveralPolls();
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
