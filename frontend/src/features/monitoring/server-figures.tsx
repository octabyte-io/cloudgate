import { Chart } from "@/components/console/chart";
import { Meter } from "@/components/console/meter";
import { StatGrid, StatTile } from "@/components/console/stat-tile";
import type { ServerMetric } from "@/lib/api/endpoints/monitoring";
import type { Server } from "@/lib/api/endpoints/servers";
import { latest, series, uptimeReading } from "@/lib/api/use-server-metrics";

import { shortTime, thresholdTone } from "./stored-samples";

/**
 * One Server's stored samples, drawn — a CPU history, memory and disk as meters,
 * and network beside uptime.
 *
 * **The thresholds are the Server's own.** `metricsConfig.server.thresholds` is
 * what `ThresholdService` compares every sample against to decide whether to
 * notify — so a meter that turned amber at some other number would disagree with
 * the alert the operator actually receives. `0` means the Server raises no alert
 * for that metric, and the meter then has no threshold to draw, which is a
 * different thing from a threshold of zero.
 *
 * **Network is a total, not a rate.** The reference shows Mb/**s**; these counters
 * are cumulative megabytes since boot, straight out of `/proc/net/dev`, so the tile
 * says total and says which. A per-second figure would need two samples and a claim
 * about the interval between them, and `refreshRate` is the interval collection
 * *aims* for rather than the one any two rows are actually apart. Time bounds
 * narrow which samples come back; they do not make the spacing regular.
 */
export function ServerFigures({
  server,
  samples,
}: {
  server: Server;
  samples: ServerMetric[];
}) {
  const newest = latest(samples);

  return (
    <>
      <CpuChart server={server} samples={samples} />
      <Utilisation server={server} newest={newest} />
      <StatGrid>
        <StatTile
          label="Network in"
          value={newest?.networkIn ?? "—"}
          unit="MB"
          detail="total since boot, not a rate"
        />
        <StatTile
          label="Network out"
          value={newest?.networkOut ?? "—"}
          unit="MB"
          detail="total since boot, not a rate"
        />
        <StatTile
          label="Uptime"
          value={newest ? uptimeReading(newest.uptime) : "—"}
          detail="since it last booted"
        />
      </StatGrid>
    </>
  );
}

function CpuChart({
  server,
  samples: rows,
}: {
  server: Server;
  samples: ServerMetric[];
}) {
  // `series` converts the "%.2f" strings the route sends; the reasoning is in
  // `use-server-metrics.ts`, and doing it anywhere else is how one card charts
  // strings while the one beside it happens to coerce.
  const values = series(rows, "cpu");
  const newest = rows[rows.length - 1];
  const threshold = server.metricsConfig.server.thresholds.cpu;
  const peak = values.length > 0 ? Math.max(...values) : 0;

  return (
    <Chart
      label="CPU"
      value={newest?.cpu ?? "—"}
      unit="%"
      detail={`peak ${peak.toFixed(1)}% · ${values.length} ${values.length === 1 ? "sample" : "samples"}`}
      values={values}
      // A percentage is drawn against 0–100 and not its own extremes; the
      // reasoning is on `PERCENT` in `lib/design/chart.ts`.
      domain={[0, 100]}
      // The tone is *state*, which is what `--chart-*` is for: a series over the
      // Server's own alert threshold goes `hot`. Never a series slot — that ramp
      // means identity, and there is one series here.
      tone={threshold > 0 && peak >= threshold ? "hot" : "brand"}
      format={(value) => `${value.toFixed(2)}%`}
      labelAt={(index) => shortTime(rows[index]?.timestamp)}
      tickCount={4}
    />
  );
}

function Utilisation({
  server,
  newest,
}: {
  server: Server;
  newest: ServerMetric | null;
}) {
  if (!newest) return null;
  const thresholds = server.metricsConfig.server.thresholds;
  const memory = Number(newest.memUsed);
  const disk = Number(newest.diskUsed);

  return (
    <div className="flex flex-col gap-3.5">
      <Meter
        label="Memory"
        value={`${newest.memUsedGB} of ${newest.memTotal} GB`}
        percent={memory}
        tone={thresholdTone(memory, thresholds.memory)}
        note={`${newest.memUsed}% in use`}
      />
      <Meter
        label="Disk"
        value={`${newest.diskUsed}% of ${newest.totalDisk} GB`}
        percent={disk}
        // No disk threshold exists on the row — `thresholds` is CPU and memory
        // only — so this meter carries no alert tone rather than one invented
        // here. A meter that went red at a number nobody configured would
        // promise a notification that is not coming.
        tone="brand"
      />
    </div>
  );
}
