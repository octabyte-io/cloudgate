import { Chart } from "@/components/console/chart";
import { Skeleton } from "@/components/console/skeleton";
import { rangeLabel, type TimeRangeValue } from "@/components/console/time-range";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { MetricsConfig } from "@/lib/api/endpoints/servers";
import { series } from "@/lib/api/use-server-metrics";
import {
  retentionDeletion,
  type SamplingState,
} from "@/lib/format/sampling";

import { SpanNote, shortTime } from "../stored-samples";
import type { useWebServerMetrics } from "../use-monitoring";

/**
 * What Cloudgate has **stored** for this host, in the four states that are
 * genuinely different.
 * Never a frame at zero: an empty plot and a host doing nothing are the same
 * picture and opposite facts, which is the rule the per-Server card was built on.
 *
 * ## Four states, and the third is not the rare one
 *
 * - **Never set up** — live only, and this section says what setting it up would
 *   add rather than showing an empty frame.
 * - **Set up, nothing stored yet** — the jobs exist; the first sample is up to
 *   `refreshRate` seconds away. Distinguishing this from the above is the reason
 *   the card reads the config and not just the samples.
 * - **Set up and storing nothing, for ever** — the case a platform host that is
 *   not Linux lands in. `SERVER_STATS_COMMAND` reads `/proc`, and a
 *   sample whose totals are all zero is *not stored* rather than stored as an idle
 *   machine, so the history stays empty however long it runs. The card can say so
 *   with confidence rather than as a possibility, because the socket has already
 *   told it: `isUnmeasured` on the live frame is the same fact about the same
 *   `/proc`, and arrives here as `cannotMeasure`.
 * - **Set up, stopped, samples kept** — "Stop keeping a history" clears the
 *   token and nothing else. This state used to be drawn as the first one, so
 *   the card said "Nothing is stored for this machine" beside 158 rows still in
 *   the table and inside their retention. The rows are still read and
 *   drawn, the card says they stop at the press and when they expire — the
 *   backend keeps the retention cleanup running for a stopped host — and the
 *   way back is named as resuming rather than as setting up. `samplingState`
 *   says how the config tells this apart from never.
 */
export function HostHistory({
  range,
  config,
  state,
  configError,
  configPending,
  history,
  cannotMeasure,
  onSetUp,
}: {
  range: TimeRangeValue;
  config: MetricsConfig | null;
  state: SamplingState;
  configError: unknown;
  configPending: boolean;
  history: ReturnType<typeof useWebServerMetrics>;
  /** The live frame already proved this host has no `/proc`. */
  cannotMeasure: boolean;
  onSetUp: () => void;
}) {
  const samples = history.data ?? [];

  if (configPending) {
    return <Skeleton className="h-8" aria-busy="true" />;
  }

  if (configError) {
    return (
      <p className="text-body text-tx-2">
        Cloudgate could not read whether a history is being kept for this host:{" "}
        {errorMessage(configError)}
      </p>
    );
  }

  if (state === "never") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-ui text-tx-2">No history</p>
        <p className="text-body text-tx-2">
          Nothing is stored for this machine. The reading above comes from a stream
          that keeps no past you can query, so there is nothing to plot and no
          threshold to breach — however loaded this host gets, it raises no CPU or
          memory notification while every set-up Server does. Setting up sampling
          stores a sample on an interval, keeps it for as long as you choose, and
          notifies your channels when it goes over a percentage you set.
        </p>
        <Button variant="pri" size="sm" onClick={onSetUp}>
          Keep a history of this host
        </Button>
      </div>
    );
  }

  if (history.error) {
    return <p className="text-body text-tx-2">{errorMessage(history.error)}</p>;
  }

  if (state === "stopped") {
    return (
      <StoppedHistory
        range={range}
        config={config}
        history={history}
        onSetUp={onSetUp}
      />
    );
  }

  if (history.isPending) {
    return (
      <div className="grid gap-3.5" aria-busy="true">
        <Skeleton className="h-plot w-full" />
        <Skeleton className="h-8" />
      </div>
    );
  }

  if (samples.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-ui text-tx-2">History</p>
        {cannotMeasure ? (
          /* The one state a per-Server card never has, and it is *this* host's
             normal state on a Mac or a Windows box. The live frame has already
             established the fact — every total zero — so this is not hedged. */
          <p className="text-body text-tx-2">
            Sampling is set up, and there will never be anything here. These
            figures are read from <code className="font-mono">/proc</code>, which
            this host does not have, so every sample comes back with every total at
            zero — and Cloudgate{" "}
            <strong className="font-medium text-tx">
              drops those rather than storing them
            </strong>
            , because a row of zeros reads back as a perfectly idle machine. The
            backend log says so once every five minutes rather than on every tick.
            Nothing is wrong with the configuration; the host is the wrong shape for
            it.
          </p>
        ) : (
          <p className="text-body text-tx-2">
            Sampling is set up and nothing has been stored in the last{" "}
            {rangeLabel(range)}. If it has just been switched on, the first sample
            lands within {config?.server.refreshRate || 60} seconds. A longer range
            will show whether anything was ever stored.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-ui text-tx-2">
        History{" "}
        <span className="text-meta text-tx-3">
          · from stored samples, every {config?.server.refreshRate || 60} seconds
        </span>
      </p>
      <CpuHistory
        samples={samples}
        threshold={config?.server.thresholds.cpu ?? 0}
      />
      <p className="text-meta text-tx-3">
        <SpanNote samples={samples} range={range} />
      </p>
    </div>
  );
}

/**
 * The fourth state: nothing new is being stored, and what was stored is still
 * there. Drawn exactly as a collecting history is — these are the same
 * rows — under a heading that says they stop, with the retention stated as the
 * thing that will delete them, because it still runs.
 */
function StoppedHistory({
  range,
  config,
  history,
  onSetUp,
}: {
  range: TimeRangeValue;
  config: MetricsConfig | null;
  history: ReturnType<typeof useWebServerMetrics>;
  onSetUp: () => void;
}) {
  const samples = history.data ?? [];

  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-ui text-tx-2">
        History{" "}
        <span className="text-meta text-tx-3">· stopped</span>
      </p>
      {history.isPending ? (
        <div className="grid w-full gap-3.5" aria-busy="true">
          <Skeleton className="h-plot w-full" />
          <Skeleton className="h-8" />
        </div>
      ) : samples.length > 0 ? (
        <div className="flex w-full flex-col gap-2">
          <CpuHistory
            samples={samples}
            threshold={config?.server.thresholds.cpu ?? 0}
          />
          <p className="text-meta text-tx-3">
            <SpanNote samples={samples} range={range} />
          </p>
        </div>
      ) : null}
      <p className="text-body text-tx-2">
        Cloudgate has stopped keeping a history of this host, so nothing new is
        stored and no CPU or memory notification can fire for it.{" "}
        {samples.length > 0 ? (
          <>What it stored before that is kept and drawn above,</>
        ) : (
          <>
            None of what it stored falls in the last {rangeLabel(range)} — a
            longer range shows whatever is left of it,
          </>
        )}{" "}
        and each sample is {retentionDeletion(config)}. Starting again keeps every
        setting it had.
      </p>
      <Button variant="pri" size="sm" onClick={onSetUp}>
        Start keeping a history again
      </Button>
    </div>
  );
}

/** The stored CPU series, drawn the way `ServerCard` draws a Server's. */
function CpuHistory({
  samples,
  threshold,
}: {
  samples: ServerMetricRows;
  threshold: number;
}) {
  const values = series(samples, "cpu");
  const newest = samples[samples.length - 1];
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
      tone={threshold > 0 && peak >= threshold ? "hot" : "brand"}
      format={(value) => `${value.toFixed(2)}%`}
      labelAt={(index) => shortTime(samples[index]?.timestamp)}
      tickCount={4}
    />
  );
}

/** The rows `useWebServerMetrics` hands back — one host's stored samples. */
type ServerMetricRows = NonNullable<
  ReturnType<typeof useWebServerMetrics>["data"]
>;
