import { spanReading, type TimeRangeValue } from "@/components/console/time-range";
import { rangeSeconds } from "@/components/console/time-range";
import type { ServerMetric } from "@/lib/api/endpoints/monitoring";
import { spanOf } from "@/lib/api/use-server-metrics";
import { timeExact } from "@/lib/format/time";

/**
 * The two things every card that draws **stored** samples needs.
 *
 * Both were written for `ServerCard` and are shared with the live card,
 * which merged the platform host's live reading and its stored history into one
 * card. Two copies of the span rule in particular would have been the wrong
 * kind of duplication: it is a rule about what a screen is allowed to *claim*,
 * and a rule stated twice drifts.
 *
 * They live under `features/monitoring/` rather than in `components/console/`
 * because only this feature has wanted them so far. If a second one does, that is
 * the signal to promote them — the way `no-listing.tsx` was promoted.
 */

/**
 * Where a percentage stops being fine, according to the host's own config.
 *
 * `metricsConfig.server.thresholds` is what `ThresholdService` compares every
 * sample against to decide whether to notify — so a meter that turned amber at
 * some other number would disagree with the alert the operator actually receives.
 * `0` means this host raises no alert for that metric, and there is then no
 * threshold to draw, which is a different thing from a threshold of zero.
 */
export function thresholdTone(
  percent: number,
  threshold: number,
): "brand" | "warn" | "alarm" {
  if (threshold > 0 && percent >= threshold) return "alarm";
  // Nine tenths of the way to a threshold the operator chose is worth a word.
  if (threshold > 0 && percent >= threshold * 0.9) return "warn";
  return "brand";
}

/**
 * What the samples in hand actually cover, against what was asked for.
 *
 * **The reading flipped direction, and it is a better check now.** While
 * the route took a sample count and no bounds, N samples could reach *further
 * back* than the range, so the tell was a span that was too long. With `start` and
 * `end` nothing outside the range can arrive — so a span that falls **short** is
 * the tell, and it means collection stopped or never started inside the window.
 * That is the more useful of the two: a host that went unreachable at 02:00 now
 * says so on the card instead of quietly drawing four hours of history under a
 * "24 hours" label.
 *
 * Either way the rule is the one that has not changed, and it is the reason this
 * is one component rather than a line of JSX in each card: report the span the
 * samples cover, **never** the window that was requested.
 */
export function SpanNote({
  samples,
  range,
}: {
  samples: ServerMetric[];
  range: TimeRangeValue;
}) {
  const span = spanOf(samples);
  const asked = rangeSeconds(range);
  const newest = samples[samples.length - 1];

  if (span === null) {
    return (
      <>
        One sample inside this range, taken {timeExact(newest.timestamp)}. A span
        needs two.
      </>
    );
  }

  // Under four fifths of the range is a gap rather than rounding — the bounds
  // cannot be overshot, so the only direction left to be wrong in is short.
  const short = span < asked * 0.8;
  return (
    <>
      {samples.length} samples covering {spanReading(span)}
      {short
        ? ` of the ${spanReading(asked)} asked for, so collection has a gap in it`
        : ""}
      . Newest {timeExact(newest.timestamp)}.
    </>
  );
}

/** `14:32` — a tick label, in the reader's own zone. */
export function shortTime(iso: string | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
