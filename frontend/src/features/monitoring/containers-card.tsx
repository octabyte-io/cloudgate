import { Card } from "@/components/console/card";
import { Chart } from "@/components/console/chart";
import { Chip } from "@/components/console/chip";
import { Skeleton } from "@/components/console/skeleton";
import { rangeBounds, type TimeRangeValue } from "@/components/console/time-range";
import { errorMessage } from "@/lib/api/error-message";
import type { ContainerMetric } from "@/lib/api/endpoints/monitoring";
import { retentionSpan, samplingState } from "@/lib/format/sampling";

import { targetNoun, type ContainerTarget } from "./container-targets";
import { exclusionsFor, includedFrom } from "./setup/metrics-config-spec";
import { useContainerMetrics, WEB_SERVER_KEY } from "./use-monitoring";

/**
 * Container-level CPU for the services a host has been told to watch.
 *
 * **One card per collection target, and the platform host is one of them**
 * This took
 * `Server[]` and filtered it, which structurally excluded the machine Cloudgate
 * runs on: that host's config is the `webServerSettings` singleton and it has no
 * `server` row, so samples collected for it were readable over the API and
 * drawn nowhere — and in a default single-box install every Application has
 * `serverId: null`, which made the card unreachable for all of them. The list is
 * now built by `containerTargets` and the screen mounts this card outside the
 * "no Servers yet" branch it used to live inside. A synthetic Server row for the
 * host was rejected: that was decided against early, and ADR-0010 and the
 * screen's strap both turn on the host genuinely not having one.
 *
 * **The include list is why this card is conditional rather than empty.**
 * `collectContainerMetrics` returns before it runs `docker stats` unless
 * `metricsConfig.containers.services.include` has at least one entry, and there is
 * no value meaning "everything" — so a host set up with the defaults collects
 * server metrics and *no* container metrics, for ever. That is a configuration
 * answer, not a "no data" answer, and it belongs in the words rather than in an
 * empty chart. The setup dialog is where the list is edited. `containerTargets`
 * is where that test now lives, so an empty `targets` really means "nobody asked
 * for container samples" and rendering nothing is the honest answer.
 *
 * **The exclude list is the same kind of answer, one row down**
 * A name can be in
 * both boxes — they are edited side by side and nothing stops it — and then the
 * exclusion wins, so this card draws a row that can never fill. That was
 * explained by the backend's refusal, which offers two causes and on this path
 * both of them are false. `exclusionsFor` is that test, made where the config
 * is.
 *
 * One chart per included service, at most four, because these are four separate
 * series of the same measure and a chart each keeps one axis per chart — the
 * `dataviz` rule that two measures never share a plot applies to two *entities*
 * on one axis too once the reader has to tell them apart by hue. Past four
 * included services the card says how many it is not drawing rather than
 * generating hues for them.
 *
 * **The range reaches this card as bounds**.
 * That is a small change with an outsized effect here: containers have their own
 * `refreshRate`, so under the old sample-count read one window meant two different
 * sample counts on one host, and this file computed the second by handing
 * `samplesForWindow` a Server whose server refresh rate had been swapped for the
 * container one. Bounds mean both reads ask for the same six hours in the same
 * words, and the swap is gone.
 */
export function ContainerMetricsCard({
  targets,
  range,
}: {
  targets: ContainerTarget[];
  range: TimeRangeValue;
}) {
  if (targets.length === 0) return null;

  return (
    <>
      {targets.map((target) => (
        <TargetContainers
          key={target.id ?? WEB_SERVER_KEY}
          target={target}
          range={range}
        />
      ))}
    </>
  );
}

/** How many services one card will draw. The fifth is named, not coloured. */
const DRAWN = 4;

function TargetContainers({
  target,
  range,
}: {
  target: ContainerTarget;
  range: TimeRangeValue;
}) {
  const included = includedFrom(target.config);
  const drawn = included.slice(0, DRAWN);
  const rest = included.length - drawn.length;
  // A stopped target keeps its card: the samples are still stored, and
  // the heading is where it says that nothing new is arriving.
  const stopped = samplingState(target.config) === "stopped";

  return (
    <Card>
      <Card.Header
        title={`Containers on ${target.name}`}
        sub={
          stopped
            ? `Sampling is stopped. What was stored for the names ${targetNoun(target)} includes is kept until it is more than ${retentionSpan(target.config)} old, and drawn below.`
            : `Sampled every ${target.config?.containers.refreshRate || 60} seconds, for the names ${targetNoun(target)} includes.`
        }
        headingLevel={2}
      />
      <Card.Body className="flex flex-col gap-4.5">
        {drawn.map((name) => (
          <ServiceSeries
            key={name}
            target={target}
            appName={name}
            range={range}
          />
        ))}
      </Card.Body>
      <Card.Footer>
        {rest > 0
          ? `${rest} more included ${rest === 1 ? "name is" : "names are"} ${stopped ? "stored" : "being collected"} and not drawn here — four series is as many as this palette can tell apart. `
          : ""}
        A name is matched as a substring of the container&rsquo;s name, and only the
        first container per service is sampled — so a service with three replicas
        is one line, not an average of three.
      </Card.Footer>
    </Card>
  );
}

function ServiceSeries({
  target,
  appName,
  range,
}: {
  target: ContainerTarget;
  appName: string;
  range: TimeRangeValue;
}) {
  const metrics = useContainerMetrics(target, appName, rangeBounds(range));
  const samples = metrics.data ?? [];
  const newest = samples[samples.length - 1] ?? null;
  const excludedBy = exclusionsFor(target.config, appName);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="flex items-center gap-2 text-meta text-tx-2">
        <Chip variant="mono">{appName}</Chip>
        {newest ? (
          <span className="truncate">{newest.Name}</span>
        ) : excludedBy.length > 0 ? (
          // "yet" is the word that has to go: nothing is coming.
          <span>excluded from collection</span>
        ) : samplingState(target.config) === "stopped" ? (
          <span>nothing stored under this name in this range</span>
        ) : (
          <span>nothing sampled under this name yet</span>
        )}
      </p>
      {excludedBy.length > 0 && samples.length === 0 ? (
        /**
         * **The cause the operator can act on, in place of two they cannot**.
         *
         * With this name in both boxes the read 400s, and the refusal underneath
         * says "Either nothing running here that you can read matches that
         * name, or collection has not stored its first sample yet". Driven on a box: the container was
         * `Up 3 days` and offered in the live card's own picker on this same
         * screen, and the store had 0 rows for it against 21 for the included
         * service beside it — so the first cause was false and the second was
         * false for ever. It is the same confidently-wrong shape the sentence
         * below this one was rewritten to get rid of, arriving through the
         * backend instead.
         *
         * It is placed **before** the refusal rather than instead of it, and
         * only while there is nothing to draw: an exclusion added to a name that
         * already has samples in this window must not blank the chart that is
         * still true. It also takes precedence over `isPending`, because this
         * answer does not depend on the request — flashing a skeleton at
         * something already known is how the old "not yet" reading got written.
         * `useContainerMetrics` no longer even issues the request for an
         * excluded name, so on a fresh visit this is what the row shows and the
         * refusal below is never fetched; the `samples.length === 0` guard is
         * what keeps a cached chart on screen when the exclusion is added while
         * it is being watched.
         */
        <p className="max-w-copy text-meta text-tx-3">
          <strong>{appName}</strong> is in{" "}
          <strong className="font-medium text-tx">Never collect for</strong>,
          matched by <code className="font-mono">{excludedBy.join(", ")}</code> —
          and collection checks that list first, so an exclusion beats the
          inclusion above it. Nothing is being sampled under this name on{" "}
          {targetNoun(target)}, and nothing will be until that entry is removed.
        </p>
      ) : metrics.error ? (
        <p className="text-body text-tx-2">{errorMessage(metrics.error)}</p>
      ) : metrics.isPending ? (
        <Skeleton className="h-plot w-full" />
      ) : samples.length === 0 ? (
        /**
         * **This sentence is the finding**.
         * The include list matches by *substring* when collecting and the read
         * route matches by *exact name or Swarm task prefix*, so `redis` collects
         * samples under `redis-12sp3x.1.kyc0…` that no `appName` of `redis` can
         * ever return. Driven: 63 rows stored, 0 rows readable, until the entry
         * was changed to the full service name.
         *
         * The first version of this said "no container on this Server has that in
         * its name" — which is confidently wrong in the common case, because the
         * container was running and being sampled the entire time.
         *
         * It used to offer three reasons, and two of
         * them are gone: the read now refuses an appName it cannot resolve
         * with a 400 that says so, rather than answering `[]`. That refusal
         * renders in the `metrics.error` branch above, so the only way left to
         * reach this sentence is a name that *does* resolve to a service whose
         * samples all fall outside the window.
         *
         * One case was later taken back off that refusal — a name the operator has excluded, which
         * the branch above answers from the config. What is left reaching the
         * refusal is the case its two causes are honest about: a name that is
         * not excluded and has never been sampled.
         */
        <p className="max-w-copy text-meta text-tx-3">
          <strong>{appName}</strong> resolves to a service on{" "}
          {targetNoun(target)}, and none of its samples falls in this range — try
          a longer one. A name that resolves to nothing is refused outright, with
          a message of its own in place of this one.
        </p>
      ) : (
        <Chart
          label={`CPU of ${appName}`}
          value={newest ? newest.CPU.toFixed(2) : "—"}
          unit="%"
          detail={memoryReading(newest)}
          values={samples.map((sample) => sample.CPU)}
          // A container's CPU percentage can exceed 100 — `docker stats` reports
          // it per-core-summed, so a 4-core container at full tilt reads 400%.
          // Autoscaling to the observed peak is right here and wrong for a host,
          // which is why this domain is computed and the Server card's is fixed.
          domain={[0, cpuCeiling(samples)]}
          format={(value) => `${value.toFixed(2)}%`}
          labelAt={(index) => shortTime(samples[index]?.timestamp)}
          tickCount={4}
        />
      )}
    </div>
  );
}

/** "412 MB of 7.65 GB" — the units the collector chose, unconverted. */
function memoryReading(newest: ContainerMetric | null): string {
  if (!newest) return "no sample yet";
  const { used, usedUnit, total, totalUnit, percentage } = newest.Memory;
  return `${used} ${usedUnit} of ${total} ${totalUnit} · ${percentage.toFixed(1)}% of its limit`;
}

/**
 * 100, or the next hundred above the peak.
 *
 * A container's CPU is summed across cores, so 100 is not the ceiling — but
 * scaling a quiet container to its own 3% peak turns jitter into a mountain
 * range, which is the reason `PERCENT` exists. Rounding up to a hundred keeps a
 * quiet series flat and still fits a busy one.
 */
function cpuCeiling(samples: ContainerMetric[]): number {
  const peak = Math.max(0, ...samples.map((sample) => sample.CPU));
  return Math.max(100, Math.ceil(peak / 100) * 100);
}

function shortTime(iso: string | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
