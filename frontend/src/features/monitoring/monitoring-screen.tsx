"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { EmptyState } from "@/components/console/empty-state";
import { LinkButton } from "@/components/console/link-button";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import {
  DEFAULT_TIME_RANGE,
  TimeRange,
  rangeLabel,
  type TimeRangeValue,
} from "@/components/console/time-range";
import { Toolbar } from "@/components/console/toolbar";
import { errorMessage } from "@/lib/api/error-message";
import { useServers } from "@/lib/api/use-servers";
import { isCollecting } from "@/lib/api/use-server-metrics";
import { samplingState, type SamplingState } from "@/lib/format/sampling";

import { containerTargets } from "./container-targets";
import { ContainerMetricsCard } from "./containers-card";
import { HealthCard } from "./health-card";
import { LiveCard } from "./live-card";
import { ServerCard } from "./server-card";
import { useWebServerMonitoring } from "./use-monitoring";

/**
 * What the fleet is doing — the observe half of the Organization rail.
 *
 * **The filter row is above everything and there is exactly one of it.** That is
 * the `dataviz` composition rule, and it is the one place this phase overrode an
 * arrangement already in the codebase: F13's Telemetry tab puts its window control
 * in a card header, which is fine for a screen with one chart and wrong for a
 * screen with several. Every figure below the row re-renders against the same
 * window, so two cards can never disagree about the last hour.
 *
 * **Two clocks on one screen, said out loud rather than blended.** The live card
 * streams from a socket that reaches only the platform's own host; the Server cards
 * poll stored samples that exist only where monitoring has been set up. Those are
 * different mechanisms with different coverage, and a screen that presented them as
 * one "monitoring" would leave an operator thinking a remote Server's CPU was live.
 * Each card says which it is — and the
 * platform host's card carries **both**, because that machine now has a stored history as well and
 * two cards for one host is worse than one card with two clocks in it.
 *
 * **The strap counts hosts, not `server` rows, and that is the whole of the copy
 * fix.** It used to read "N of M Servers are being sampled", which structurally
 * could not include the platform host: the host has no `server` row, by design. The
 * sentence became false the moment `POST /admin/setup-monitoring` started
 * collecting. It now names the host separately in every state, because "2 of 3"
 * with the instance's own machine silently outside the fraction is the kind of
 * number an operator would reasonably act on.
 *
 * The reference (`viewMonitoring`) has a pause control and a banner saying every
 * number is the last sample taken. **Neither is here**: its numbers were simulated
 * on a 1300ms timer that pausing genuinely stopped, whereas these come from a poll
 * whose interval is the Server's own and from a socket that closes with the card.
 * Pausing a poll would freeze a reading while the host moved on, which is the one
 * thing a monitoring screen must not do quietly.
 */
export function MonitoringScreen() {
  const [range, setRange] = useState<TimeRangeValue>(DEFAULT_TIME_RANGE);
  const servers = useServers();
  const web = useWebServerMonitoring();
  const rows = servers.data ?? [];
  const monitored = rows.filter(isCollecting);
  const stopped = rows.filter(
    (server) => samplingState(server.metricsConfig) === "stopped",
  );
  const containerHosts = containerTargets(web.config, rows);

  return (
    <Page>
      <PageHeader
        title="Monitoring"
        icon="activity"
        lede="CPU, memory, disk and network for every Server and for the host Cloudgate runs on — live, and from the samples Cloudgate stores."
        strap={
          servers.isPending || web.isPending
            ? undefined
            : strapFor(rows.length, monitored.length, stopped.length, web.state)
        }
      />

      <Toolbar>
        <TimeRange value={range} onChange={setRange} />
        <p className="text-meta text-tx-3">
          Everything below covers the last {rangeLabel(range)}.
        </p>
      </Toolbar>

      <div className="mt-4.5 flex flex-col gap-4.5">
        <HealthCard />
        <LiveCard range={range} />

        {servers.error ? (
          <Card>
            <Card.Body>
              <p className="text-body text-tx-2">{errorMessage(servers.error)}</p>
            </Card.Body>
          </Card>
        ) : servers.isPending ? (
          <div className="grid gap-4.5" aria-busy="true">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        ) : rows.length === 0 ? (
          <Card>
            <Card.Body flush>
              <EmptyState
                icon="hdd"
                title="No Servers to monitor yet"
                action={
                  <LinkButton variant="pri" size="sm" href="/servers">
                    Go to Servers
                  </LinkButton>
                }
              >
                Add a Server, and this screen fills itself in. Cloudgate samples
                it over the SSH connection it already deploys with.
              </EmptyState>
            </Card.Body>
          </Card>
        ) : (
          <>
            {/* One column, not the reference's `auto-fit, minmax(320px, 1fr)`
                grid: each card holds a plot, two meters and three figures, and
                at 320px the plot is 240px of line under four tick labels that
                collide. The cards stack instead and stay legible. */}
            {rows.map((server) => (
              <ServerCard key={server.serverId} server={server} range={range} />
            ))}
          </>
        )}

        {/* **Outside the ternary above, on purpose.** The Containers card
            used to be the last child of the `rows.length > 0` branch, so on an
            instance with no Servers added it was not merely fed the wrong list —
            it was never mounted, and the screen said "No Servers to monitor yet"
            while the backend was storing container samples for the machine it
            was running on. The card is the platform host's as much as a Server's
            now, and how many `server` rows exist decides nothing about it. It
            stays *below* the Server cards so each host's containers still read
            after that host, and it renders nothing at all when no host is
            collecting containers — which is the common case. */}
        <ContainerMetricsCard targets={containerHosts} range={range} />
      </div>
    </Page>
  );
}

/**
 * One sentence that is true in all six states, and it has to name the platform
 * host **separately** rather than folding it into a fraction.
 *
 * The old sentence was `N of M Servers are being sampled`, and the host could
 * never be part of either number: it has no `server` row, which is the design
 * decision kept rather than inventing a synthetic one. So a fraction that read
 * "2 of 3" while the instance's own machine was also being sampled was under by
 * one and gave no way to tell; and one that read "2 of 3" while the host was *not*
 * being sampled was correct about Servers and silent about the machine most likely
 * to fall over. Two clauses, so neither fact can hide behind the other.
 *
 * "A history" rather than "sampled", because the platform host **is** sampled
 * either way — the live card does it with no setup at all. What setup changes is
 * whether anything is kept, and whether a threshold can fire.
 *
 * **A stopped history is its own clause**.
 * "None of this instance's own host" was what a stopped host read as too, while
 * its samples were still stored and drawn on the card below. Stopped is said as
 * stopped, for the host and for a count of Servers, with where the samples went.
 */
function strapFor(
  serverCount: number,
  monitoredCount: number,
  stoppedCount: number,
  hostState: SamplingState,
): string {
  const host = "this instance's own host";
  // One sentence in every state (design-system.md rule 8). How long a stopped
  // history is kept is said on the stopped card itself, beside the samples it
  // is about, rather than here as a second sentence on every visit.
  if (serverCount === 0) {
    return hostState === "collecting"
      ? `Cloudgate is keeping a history of ${host}, and no Servers have been added yet.`
      : hostState === "stopped"
        ? `Cloudgate has stopped keeping a history of ${host}, and no Servers have been added yet.`
        : `Cloudgate is keeping no history yet — not of ${host}, and there are no Servers.`;
  }
  const servers = `${monitoredCount} of ${serverCount} ${serverCount === 1 ? "Server" : "Servers"}`;
  const stoppedServers =
    stoppedCount === 0
      ? ""
      : `; ${stoppedCount} ${stoppedCount === 1 ? "Server has" : "Servers have"} been stopped`;
  const sentence =
    hostState === "collecting"
      ? `Cloudgate is keeping a history of ${host} and of ${servers}`
      : hostState === "stopped"
        ? `Cloudgate is keeping a history of ${servers}, and has stopped keeping one of ${host}`
        : `Cloudgate is keeping a history of ${servers}, and none of ${host}`;
  return `${sentence}${stoppedServers}.`;
}
