import { Card } from "@/components/console/card";
import { LinkButton } from "@/components/console/link-button";
import { Meter } from "@/components/console/meter";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import type { Server } from "@/lib/api/endpoints/servers";
import { samplingState } from "@/lib/format/sampling";

import { latest, useServerMetrics } from "./use-server-metrics";

/**
 * How full this machine is — three meters, or the reason there are none.
 *
 * Shared by the Overview and the Telemetry tab, because "is this host running out of
 * anything" is the question both are answering and one of them should not answer it
 * differently. `Meter` rather than a plot: a percentage of a fixed total is what a
 * meter is for, and the history belongs on the tab that is about history.
 *
 * **The `mute` state is the point of this component.** A Server that has never been
 * set up for monitoring has no samples and never will, so three meters at 0% would
 * say "this host is completely idle" about a host that might be on fire. The tones
 * are the reference's own thresholds read as words, and `Meter` renders one beside
 * the figure whenever it is not `brand`.
 *
 * **A stopped Server gets the same refusal to draw, for a different reason**
 * Its newest
 * sample exists, and is from before the stop — three meters on it would read as
 * the machine now. So it is not fetched here, and the card says where the
 * stored samples are rather than that there are none.
 */

/** Where a percentage stops being fine. The reference's `metricsConfig` defaults. */
function tone(percent: number): "brand" | "warn" | "alarm" {
  if (percent >= 90) return "alarm";
  if (percent >= 75) return "warn";
  return "brand";
}

export function UtilisationCard({
  server,
  /** Link to the tab that explains the numbers. Off on the Telemetry tab itself. */
  linkToTelemetry = true,
}: {
  server: Server;
  linkToTelemetry?: boolean;
}) {
  const state = samplingState(server.metricsConfig);
  const collecting = state === "collecting";
  // One sample is all a meter needs, and it is the cheapest read of this route.
  const metrics = useServerMetrics(server, "1", collecting);
  const sample = latest(metrics.data);

  return (
    <Card>
      <Card.Header
        title="Utilisation"
        sub={collecting ? "The newest sample from this host." : undefined}
        headingLevel={2}
        actions={
          linkToTelemetry ? (
            <LinkButton
              size="sm"
              href={`/servers/${server.serverId}/telemetry`}
            >
              Telemetry
            </LinkButton>
          ) : undefined
        }
      />
      <Card.Body>
        {state === "stopped" ? (
          <p className="text-body text-tx-2">
            {/* Meters drawn from the last stored sample would read as this
                machine now, so there are none. */}
            Collection is stopped for this Server, so there is no current
            reading. What it stored is drawn{" "}
            {linkToTelemetry ? "on the Telemetry tab" : "above"}.
          </p>
        ) : !collecting ? (
          <p className="text-body text-tx-2">
            {/* Three meters at zero would say this machine is idle rather
                than unmeasured. */}
            Set up monitoring for this Server to see its CPU, memory and disk
            here.
          </p>
        ) : metrics.error ? (
          <p className="text-body text-tx-2">{errorMessage(metrics.error)}</p>
        ) : metrics.isPending ? (
          <div className="grid gap-3.5" aria-busy="true">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : !sample ? (
          <p className="text-body text-tx-2">
            Monitoring is on and no sample has arrived yet. The first one lands
            within {server.metricsConfig.server.refreshRate || 60} seconds.
          </p>
        ) : (
          <div className="flex flex-col gap-3.5">
            <Meter
              label="CPU"
              value={`${sample.cpu}%`}
              percent={Number(sample.cpu)}
              tone={tone(Number(sample.cpu))}
            />
            <Meter
              label="Memory"
              value={`${sample.memUsedGB} of ${sample.memTotal} GB`}
              percent={Number(sample.memUsed)}
              tone={tone(Number(sample.memUsed))}
              note={`${sample.memUsed}% in use`}
            />
            <Meter
              label="Disk"
              value={`${sample.diskUsed}% of ${sample.totalDisk} GB`}
              percent={Number(sample.diskUsed)}
              tone={tone(Number(sample.diskUsed))}
            />
          </div>
        )}
      </Card.Body>
      {collecting && sample ? (
        <Card.Footer>
          {sample.cpuCores} {sample.cpuCores === 1 ? "core" : "cores"} ·{" "}
          {sample.distro || sample.os} · {sample.arch}
        </Card.Footer>
      ) : null}
    </Card>
  );
}
