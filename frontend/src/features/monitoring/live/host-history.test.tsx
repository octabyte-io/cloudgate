import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_TIME_RANGE } from "@/components/console/time-range";
import type { ServerMetric } from "@/lib/api/endpoints/monitoring";
import type { MetricsConfig } from "@/lib/api/endpoints/servers";
import type { SamplingState } from "@/lib/format/sampling";

import type { useWebServerMetrics } from "../use-monitoring";
import { HostHistory } from "./host-history";

afterEach(cleanup);

/**
 * The platform host's config after "Stop keeping a history", as
 * `GET /settings/web-server` sends it: the token projected out as
 * `hasToken: false`, everything the dialog wrote still in place.
 */
const STOPPED: MetricsConfig = {
  server: {
    type: "Cloudgate",
    refreshRate: 10,
    port: 4500,
    hasToken: false,
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

function sample(timestamp: string, cpu: string): ServerMetric {
  return {
    cpu,
    cpuModel: "",
    cpuCores: 2,
    cpuPhysicalCores: 1,
    cpuSpeed: 0,
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

function said(state: SamplingState, samples: ServerMetric[]): string {
  const history = {
    data: samples,
    error: null,
    isPending: false,
  } as unknown as ReturnType<typeof useWebServerMetrics>;
  render(
    <HostHistory
      range={DEFAULT_TIME_RANGE}
      config={STOPPED}
      state={state}
      configError={null}
      configPending={false}
      history={history}
      cannotMeasure={false}
      onSetUp={() => {}}
    />,
  );
  return document.body.textContent ?? "";
}

/**
 * **The fourth state**.
 * "Stop keeping a history" put this section straight back to the never-set-up
 * copy — "Nothing is stored for this machine" and "Keep a history of this host"
 * — while 158 host samples were still stored and inside their retention.
 */
describe("HostHistory", () => {
  it("draws what a stopped host stored, and names the way back as resuming", () => {
    const text = said("stopped", [
      sample("2026-09-15T18:46:27.000Z", "12.00"),
      sample("2026-09-15T18:46:37.330Z", "14.00"),
    ]);

    expect(text).not.toContain("Nothing is stored for this machine");
    expect(text).not.toContain("Keep a history of this host");
    expect(text).toContain("Cloudgate has stopped keeping a history of this host");
    expect(text).toContain("What it stored before that is kept and drawn above");
    expect(text).toContain("deleted once it is more than 2 days old");
    expect(text).toContain("Start keeping a history again");
    expect(text).toContain("2 samples");
  });

  it("says a stopped host's samples are kept when none fall in the range", () => {
    const text = said("stopped", []);

    expect(text).not.toContain("Nothing is stored for this machine");
    expect(text).toContain("a longer range shows whatever is left of it");
  });

  it("keeps the never-set-up section for a host that never kept a history", () => {
    const text = said("never", []);

    expect(text).toContain("Nothing is stored for this machine");
    expect(text).toContain("Keep a history of this host");
  });
});
