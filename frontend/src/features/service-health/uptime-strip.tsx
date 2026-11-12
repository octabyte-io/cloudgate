import type { StripBucket } from "@/lib/api/endpoints/service-health";
import { timeExact } from "@/lib/format/time";
import { cn } from "@/lib/utils";

type BucketState = "up" | "down" | "mixed" | "none";

const FILL: Record<BucketState, string> = {
  up: "bg-ok",
  down: "bg-bad",
  mixed: "bg-warn",
  // Not probed is not a verdict: the quiet fill a segmented progress uses for
  // "not yet", never a status hue.
  none: "bg-raise-2",
};

const WORD: Record<BucketState, string> = {
  up: "every Probe up",
  down: "every Probe down",
  mixed: "some Probes down",
  none: "not probed",
};

export function bucketState(bucket: StripBucket): BucketState {
  if (bucket.up === 0 && bucket.down === 0) return "none";
  if (bucket.down === 0) return "up";
  if (bucket.up === 0) return "down";
  return "mixed";
}

/** `0.9876` → `"98.8%"`; a whole share reads without the decimal. */
export function shareLabel(share: number): string {
  const percent = share * 100;
  return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
}

/**
 * **The last 24 hours of one Uptime check, in 48 half-hours**, oldest on the
 * left and the one now is in on the right.
 *
 * A half-hour is green when every Probe in it was up, red when every one was
 * down, amber when it held both, and the quiet fill when nothing was probed —
 * a check that was off, a Service that was Stopped, or a platform restart
 * ("neither up nor down"). Not probed is deliberately not a status hue:
 * it is the absence of a verdict, and painting it grey-as-down would claim a
 * down stretch no Probe saw.
 *
 * **The hues never carry it alone** (rule 5): the ribbon is `aria-hidden`, a
 * sentence under it says the up share and how many half-hours saw a down, and
 * each segment's `title` names its half-hour and what happened in it.
 */
export function UptimeStrip({
  strip,
  upShare,
  className,
}: {
  strip: StripBucket[];
  upShare: number | null;
  className?: string;
}) {
  const states = strip.map(bucketState);
  const withDowns = states.filter(
    (state) => state === "down" || state === "mixed",
  ).length;
  const probed = states.filter((state) => state !== "none").length;

  return (
    <div data-slot="uptime-strip" className={cn("grid gap-1", className)}>
      <div aria-hidden="true" className="flex h-4 gap-px">
        {strip.map((bucket, index) => (
          <span
            key={bucket.start}
            title={`${timeExact(bucket.start) ?? bucket.start}: ${WORD[states[index]]}${
              states[index] === "none" ? "" : ` (${bucket.up} up, ${bucket.down} down)`
            }`}
            className={cn("min-w-0.5 flex-1 rounded-xs", FILL[states[index]])}
          />
        ))}
      </div>
      <p className="text-meta text-tx-3">
        {upShare === null
          ? "Not probed in the last 24 hours"
          : `${shareLabel(upShare)} up over 24 hours`}
        {withDowns > 0
          ? ` · down in ${withDowns} of ${probed} half-hours probed`
          : null}
      </p>
    </div>
  );
}
