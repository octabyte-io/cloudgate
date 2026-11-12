import { useState } from "react";

import { Card } from "@/components/console/card";
import { LinkButton } from "@/components/console/link-button";
import { Skeleton } from "@/components/console/skeleton";
import { StatusPill } from "@/components/console/status-pill";
import {
  rangeBounds,
  rangeLabel,
  type TimeRangeValue,
} from "@/components/console/time-range";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { Server } from "@/lib/api/endpoints/servers";
import { useServerMetricsInWindow } from "@/lib/api/use-server-metrics";
import { retentionDeletion, samplingState } from "@/lib/format/sampling";
import { serverMark } from "@/lib/design/server-mark";

import { MonitoringSetupModal } from "./setup/monitoring-setup-modal";
import { stopCollecting } from "./setup/metrics-config-spec";
import { ServerFigures } from "./server-figures";
import { SpanNote } from "./stored-samples";
import { useSetupMonitoring } from "./use-monitoring";

/**
 * One Server's telemetry, in the shape the prototype chose (`viewMonitoring`,
 * `e-console.html:3311-3348`).
 *
 * **The departure from the reference that matters is a state it had no idea
 * about, and it is the common one.** The reference has a "no telemetry" tone for a
 * host it cannot reach and draws a flat line at zero for it. Here a Server may
 * never have been **set up for monitoring** — which is every Server as created
 * (`metricsConfig.server.token` is `''` and `registerServer` returns early). That
 * state gets the setup action instead of a chart, because a flat line at zero and
 * an idle host are the same picture and opposite facts. The samples themselves are
 * drawn by `server-figures.tsx`, which carries the rest of the reasoning.
 *
 * **"Never set up" and "stopped" are different facts**
 * "Stop
 * collecting" empties the token and keeps everything else, and once this
 * card had one off-state, written for a Server that was never set up — so the
 * press left it saying "there are no samples and there never will be" beside
 * 124 stored rows and an intact config. `samplingState` separates the two off
 * the config. A stopped Server's samples are still read and still drawn, the
 * card says they stop at the press and when retention deletes them (the backend
 * keeps that cleanup running), links to the Telemetry tab that reads all of
 * them whatever this range is, and offers to *resume* rather than to set up.
 *
 * **The span note and the threshold toning are shared with the live card** —
 * they live in
 * `stored-samples.tsx`, because the platform host's card now draws stored samples
 * too and the rule about which span a screen may claim is not one to state twice.
 */
export function ServerCard({
  server,
  range,
}: {
  server: Server;
  range: TimeRangeValue;
}) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [openings, setOpenings] = useState(0);
  const state = samplingState(server.metricsConfig);
  const collecting = state === "collecting";
  // Rounded to the minute by `rangeBounds`, which is what keeps the query key
  // stable across renders — see the note in `time-range.tsx`.
  const bounds = rangeBounds(range);
  const metrics = useServerMetricsInWindow(server, bounds, state !== "never");
  const setup = useSetupMonitoring(server.serverId);

  const samples = metrics.data ?? [];

  function openSetup() {
    setOpenings((count) => count + 1);
    setSetupOpen(true);
  }

  return (
    <Card>
      <Card.Header
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <a
              href={`/servers/${server.serverId}`}
              title={server.name}
              className="truncate font-semibold text-tx underline-offset-2 hover:underline focus-visible:underline"
            >
              {server.name}
            </a>
            <StatusPill mark={serverMark(server)} />
          </span>
        }
        sub={`${server.ipAddress}:${server.port} · ${server.serverType} server`}
        headingLevel={2}
        actions={
          collecting ? (
            <Button
              size="xs"
              onClick={openSetup}
              aria-label={`Change how ${server.name} is sampled`}
            >
              Sampling
            </Button>
          ) : null
        }
      />

      {state === "never" ? (
        <Card.Body className="flex flex-col items-start gap-3.5">
          <p className="text-body text-tx-2">
            Nothing is being collected for this Server. Cloudgate samples a host on
            an interval over SSH, and that interval only exists once monitoring has
            been set up for the Server — so there are no samples and there never
            will be until it is. That is a different thing from a host with nothing
            happening on it, which is why there are no charts here rather than
            charts at zero.
          </p>
          <Button variant="pri" size="sm" onClick={openSetup}>
            Set up monitoring
          </Button>
        </Card.Body>
      ) : metrics.error ? (
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(metrics.error)}</p>
        </Card.Body>
      ) : metrics.isPending ? (
        <Card.Body>
          <div className="grid gap-3.5" aria-busy="true">
            <Skeleton className="h-plot w-full" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        </Card.Body>
      ) : state === "stopped" ? (
        <Card.Body className="flex flex-col gap-4">
          {samples.length > 0 ? (
            <ServerFigures server={server} samples={samples} />
          ) : null}
          <StoppedNote server={server} range={range} drawn={samples.length > 0} />
          <div className="flex flex-wrap gap-2">
            <Button variant="pri" size="sm" onClick={openSetup}>
              Start collecting again
            </Button>
            <LinkButton size="sm" href={`/servers/${server.serverId}/telemetry`}>
              Every stored sample
            </LinkButton>
          </div>
        </Card.Body>
      ) : samples.length === 0 ? (
        <Card.Body>
          {/* Now that the read is bounded, empty means "nothing in this range"
              and not "nothing ever" — two facts that used to be the same
              answer. Naming the range is what keeps this from reading as a
              Server that has never been sampled. */}
          <p className="text-body text-tx-2">
            Nothing was sampled in the last {rangeLabel(range)}. If monitoring has
            just been switched on, the first sample lands within{" "}
            {server.metricsConfig.server.refreshRate || 60} seconds; otherwise the
            Server is set up and Cloudgate cannot reach it, and its Infrastructure
            tab is where that is checked. A longer range will show whether it was
            ever being sampled.
          </p>
        </Card.Body>
      ) : (
        <Card.Body className="flex flex-col gap-4">
          <ServerFigures server={server} samples={samples} />
        </Card.Body>
      )}

      {collecting && samples.length > 0 ? (
        <Card.Footer>
          <SpanNote samples={samples} range={range} />
          {" · "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => {
              void setup
                .mutateAsync(stopCollecting(server.metricsConfig))
                .then(() =>
                  toast.done(`Cloudgate has stopped sampling ${server.name}.`),
                )
                .catch((error: unknown) => toast.error(error));
            }}
          >
            Stop collecting
          </button>
        </Card.Footer>
      ) : state === "stopped" && samples.length > 0 ? (
        <Card.Footer>
          <SpanNote samples={samples} range={range} />
        </Card.Footer>
      ) : null}

      {/* Keyed by opening — F09's defect: a dialog that stays mounted across a
          close keeps what was typed, so a half-edited retention window would
          come back next time. */}
      <MonitoringSetupModal
        key={openings}
        target={{
          name: server.name,
          state,
          config: server.metricsConfig,
          reach: "over SSH",
          description:
            "Cloudgate reads this host's own /proc over the SSH connection it already uses. Saving registers the collection jobs; the first sample lands one interval later.",
          save: (input) => setup.mutateAsync(input),
        }}
        open={setupOpen}
        onOpenChange={setSetupOpen}
      />
    </Card>
  );
}

/**
 * What a stopped Server's card says, with or without samples in the range.
 * Every clause is a fact the config or the backend guarantees: the token
 * is empty so nothing is sampled and no threshold is checked, the rows are kept,
 * and the retention cleanup is still registered for a stopped Server, so they do
 * expire — on the schedule the Server's own retention sets.
 */
function StoppedNote({
  server,
  range,
  drawn,
}: {
  server: Server;
  range: TimeRangeValue;
  /** Whether any stored sample fell inside the range and is drawn above. */
  drawn: boolean;
}) {
  return (
    <p className="text-body text-tx-2">
      Collection is stopped for this Server, so nothing new is sampled and no CPU
      or memory notification can fire for it.{" "}
      {drawn ? (
        <>The samples stored before the stop are kept, and drawn above.</>
      ) : (
        <>
          The samples stored before the stop are kept, and none of them falls in
          the last {rangeLabel(range)}.
        </>
      )}{" "}
      Each one is {retentionDeletion(server.metricsConfig)}, and the
      Server&rsquo;s Telemetry tab reads all of them whatever the range here.
      Starting again keeps every setting it had.
    </p>
  );
}
