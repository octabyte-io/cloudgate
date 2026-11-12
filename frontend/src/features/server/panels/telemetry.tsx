"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chart } from "@/components/console/chart";
import { LinkButton } from "@/components/console/link-button";
import { NoListing } from "@/components/console/no-listing";
import { Segmented } from "@/components/console/segmented";
import { Skeleton } from "@/components/console/skeleton";
import { StatGrid, StatTile } from "@/components/console/stat-tile";
import { errorMessage } from "@/lib/api/error-message";
import type { Server } from "@/lib/api/endpoints/servers";
import {
  retentionDeletion,
  retentionSpan,
  samplingState,
} from "@/lib/format/sampling";
import { timeAgo } from "@/lib/format/time";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { UtilisationCard } from "../telemetry/utilisation-card";
import {
  latest,
  series,
  uptimeReading,
  useServerMetrics,
} from "../telemetry/use-server-metrics";
import { ServerPanel } from "../server-panel";
import { SamplingAside } from "../telemetry/sampling-aside";

/**
 * CPU, memory, disk and network on this host, over time.
 *
 * **The brief pointed this tab at `/listen-docker-stats-monitoring` and it cannot
 * answer.** That gateway takes an `appName` and no `serverId` — its own comment says
 * "local-host only … no serverId parameter exists" — and `appName: "cloudgate"`
 * samples *the machine the platform runs on*. Aiming a remote Server's Telemetry tab
 * at it would print the platform host's CPU under another host's name. So this tab
 * reads `GET /monitoring/metrics?serverId=`, which is per Server, real, and carries
 * the CPU model and the kernel besides. `endpoints/monitoring.ts` has the full
 * reasoning.
 *
 * That route has one condition and it decides the whole screen: **nothing is
 * collected until a Server has been set up for monitoring.** The interval is
 * registered only when `metricsConfig.server.token` is non-empty, and a Server as
 * created has it empty. An empty chart and a chart of an idle host look identical
 * and mean opposite things, so this branches *before* it asks for a sample — and the
 * setup form is F14's screen, not a second one here.
 *
 * **Not collecting is two states, and only one of them has nothing to show**
 * "Stop
 * collecting" clears the token and keeps the config and every stored sample, and
 * this tab used to read that as never set up — "Until then there are no samples"
 * over rows it could have drawn. `samplingState` tells the two apart from the
 * config. A stopped Server gets its stored history, under a note saying it has
 * stopped and when retention deletes it; this tab is where the Monitoring card
 * sends somebody to read all of it, because its windows are counts rather than a
 * time range.
 */

/** The agent's own `limit` semantics. `all` is a real value to that route. */
const WINDOWS = [
  { value: "50" as const, label: "Last 50" },
  { value: "200" as const, label: "Last 200" },
  { value: "all" as const, label: "Everything" },
];

export default function Panel(props: PanelProps) {
  return (
    <ServerPanel
      panel={props}
      aside={(server) => <SamplingAside server={server} />}
    >
      {(server) => <Telemetry server={server} />}
    </ServerPanel>
  );
}

function Telemetry({ server }: { server: Server }) {
  const [window, setWindow] = useState<"50" | "200" | "all">("50");
  const state = samplingState(server.metricsConfig);
  const metrics = useServerMetrics(server, window, state !== "never");

  if (state === "never") {
    return (
      <Card>
        <Card.Body flush>
          <NoListing
            icon="activity"
            title="This Server is not being monitored"
            footer={
              <LinkButton size="sm" href="/monitoring">
                Go to Monitoring
              </LinkButton>
            }
          >
            {/* No samples is not a host with nothing happening on it, so this
                says so rather than drawing a flat line at zero. */}
            Set up monitoring for this Server on Monitoring, and Cloudgate
            samples it over SSH from then on.
          </NoListing>
        </Card.Body>
      </Card>
    );
  }

  const samples = metrics.data ?? [];
  const newest = latest(samples);
  const cpu = series(samples, "cpu");

  return (
    <>
      {state === "stopped" ? (
        <Card>
          <Card.Body className="flex flex-col items-start gap-3">
            <p className="text-body text-tx-2">
              <strong className="font-medium text-tx">
                Collection is stopped for this Server.
              </strong>{" "}
              Start it again from Monitoring, with every setting it had. Until
              then no CPU or memory notification can fire, and what is below is
              kept — each sample is {retentionDeletion(server.metricsConfig)}.
            </p>
            <LinkButton size="sm" href="/monitoring">
              Go to Monitoring
            </LinkButton>
          </Card.Body>
        </Card>
      ) : null}

      <Card>
        <Card.Header
          title="CPU"
          headingLevel={2}
          actions={
            <Segmented
              label="How much history"
              options={WINDOWS}
              value={window}
              onChange={setWindow}
            />
          }
        />
        <Card.Body>
          {metrics.error ? (
            <p className="text-body text-tx-2">{errorMessage(metrics.error)}</p>
          ) : metrics.isPending ? (
            <Skeleton className="h-plot w-full" />
          ) : cpu.length === 0 ? (
            <p className="text-body text-tx-2">
              {state === "stopped" ? (
                <>
                  No stored sample of this Server is left — either none was
                  stored before the stop, or every one grew more than{" "}
                  {retentionSpan(server.metricsConfig)} old and the retention
                  cleanup deleted it.
                </>
              ) : (
                <>
                  Monitoring is on and nothing has been sampled yet. The first
                  sample lands within{" "}
                  {server.metricsConfig.server.refreshRate || 60} seconds.
                </>
              )}
            </p>
          ) : (
            <Chart
              label="CPU"
              value={newest?.cpu ?? "—"}
              unit="%"
              detail={`${cpu.length} ${cpu.length === 1 ? "sample" : "samples"} · peak ${Math.max(...cpu).toFixed(2)}%`}
              values={cpu}
              domain={[0, 100]}
              // A series that has stopped reporting is `dead`: dashed, the
              // stopped card above carrying the word.
              tone={state === "stopped" ? "dead" : undefined}
              format={(value) => `${value.toFixed(2)}%`}
              labelAt={(index) => timeAgo(samples[index]?.timestamp) ?? ""}
              tickCount={4}
            />
          )}
        </Card.Body>
      </Card>

      <UtilisationCard server={server} linkToTelemetry={false} />

      <Card>
        <Card.Header
          title="This machine"
          // A stopped Server's newest sample is from before the stop, and uptime
          // and the totals below would otherwise read as now.
          sub={
            state === "stopped" && newest
              ? `As of the last sample before the stop, ${timeAgo(newest.timestamp) ?? "at an unknown time"}.`
              : undefined
          }
          headingLevel={2}
        />
        <Card.Body>
          {newest ? (
            <StatGrid>
              <StatTile
                label="Uptime"
                value={uptimeReading(newest.uptime)}
                detail="since it last booted"
              />
              <StatTile
                label="Cores"
                value={newest.cpuCores}
                // `cpuSpeed` is 0 on hosts whose /proc/cpuinfo carries no MHz —
                // every aarch64 machine, among others — and "0.0 GHz" is a
                // confident wrong number rather than a missing one. Found by
                // driving it on an arm64 host. Same rule as `cpuModel` below.
                detail={coreDetail(newest)}
              />
              <StatTile
                label="Network in"
                value={newest.networkIn}
                unit="MB"
                detail="total since boot, not a rate"
              />
              <StatTile
                label="Network out"
                value={newest.networkOut}
                unit="MB"
                detail="total since boot, not a rate"
              />
            </StatGrid>
          ) : (
            <p className="text-body text-tx-2">
              Nothing has been sampled yet, so the machine has not described
              itself.
            </p>
          )}
        </Card.Body>
        {newest ? (
          <Card.Footer>
            {newest.cpuModel || "CPU model not reported"} ·{" "}
            {newest.distro || newest.os} · kernel {newest.kernel} ·{" "}
            {newest.arch}
          </Card.Footer>
        ) : null}
      </Card>
    </>
  );
}

/** "10 physical · 3.2 GHz", dropping either half the host did not report. */
function coreDetail(sample: {
  cpuPhysicalCores: number;
  cpuSpeed: number;
}): string | undefined {
  const parts = [
    sample.cpuPhysicalCores ? `${sample.cpuPhysicalCores} physical` : null,
    sample.cpuSpeed ? `${(sample.cpuSpeed / 1000).toFixed(1)} GHz` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
