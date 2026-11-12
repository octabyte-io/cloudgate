import { Segmented } from "@/components/console/segmented";

/**
 * The window every observe screen is looking at — one control, four presets.
 *
 * **One range, three screens.** The Monitoring, Requests and Deployments screens
 * each answer "what happened lately" from a different route, and the `dataviz`
 * skill's composition rule is the reason this is shared rather than three
 * controls: filters sit in one row above the content they scope, never inside a
 * chart card, and every figure below re-renders against the same slice. Three
 * ranges that could drift would let two screens disagree about the last hour and
 * both be right.
 *
 * The three routes take the window three different ways, which is what this
 * module exists to hide:
 *
 * | Screen | What the route takes | How the range reaches it |
 * |---|---|---|
 * | Monitoring | `start` / `end`, plus an optional `limit` that is a sample count | `rangeBounds`, no `limit` — a bounded read with no cap is uncapped |
 * | Requests | `dateRange: { start, end }` | `rangeBounds`, both ends always sent |
 * | Deployments | nothing — the list route has no filter at all | `withinRange` filters the rows in hand |
 *
 * **The bounds are rounded to the minute, and that is load-bearing.** A
 * `dateRange` computed from `Date.now()` is a different value every millisecond,
 * so it would be a different TanStack query key on every render — an infinite
 * refetch that looks like a slow backend. Rounding down to the start of the
 * minute makes the key stable for 60 seconds, which is also roughly how fresh
 * anyone needs an access-log summary to be. `refetchInterval` is what keeps it
 * moving, deliberately, rather than a key that can never hit.
 *
 * **There is no "all time", and the reason moved rather than went away.** Dropping
 * both bounds puts the Requests route into its unfiltered mode, which answers the
 * newest 500 lines and nothing older (`UNFILTERED_LINE_LIMIT`) — so the count under
 * the table would quietly stop meaning "every request in this window" and start
 * meaning "the last 500". A *ranged* read is bounded by the window instead of
 * capped, which is why both ends are always sent: the read takes the end of the
 * log rather than the start, and seeks to the window's own hours in a
 * log that gets rotated. A preset that silently changes what the numbers mean is
 * not a preset.
 */

/** The four windows. Four is `Segmented`'s maximum, and the fifth would be a Select. */
export const TIME_RANGES = [
  { value: "1h" as const, label: "Last hour", seconds: 3_600 },
  { value: "6h" as const, label: "6 hours", seconds: 21_600 },
  { value: "24h" as const, label: "24 hours", seconds: 86_400 },
  { value: "7d" as const, label: "7 days", seconds: 604_800 },
];

/**
 * A fifth window that is no preset: the Requests page offers it only when a
 * Server's read took too long ("Try the last 15 minutes"), and holds it
 * in its address. The control shows none of the four selected while it is
 * the range. Every lookup below knows it, so a screen that reads it sizes,
 * names and bounds it like the others.
 */
export const NARROW_RANGE = {
  value: "15m" as const,
  label: "Last 15 minutes",
  seconds: 900,
};

const EVERY_RANGE = [NARROW_RANGE, ...TIME_RANGES];

export type TimeRangeValue =
  | (typeof TIME_RANGES)[number]["value"]
  | typeof NARROW_RANGE.value;

/** The default. An hour is the window an incident is looked at in. */
export const DEFAULT_TIME_RANGE: TimeRangeValue = "1h";

export function rangeSeconds(range: TimeRangeValue): number {
  return EVERY_RANGE.find((each) => each.value === range)?.seconds ?? 3_600;
}

/** "6 hours" — for a sentence that has to name the window in prose. */
export function rangeLabel(range: TimeRangeValue): string {
  return (
    EVERY_RANGE.find((each) => each.value === range)?.label.replace(
      /^Last /,
      "",
    ) ?? "hour"
  );
}

/**
 * ISO bounds for a range, both ends, rounded down to the start of the minute.
 *
 * Called during render, so it must be stable across renders within a minute —
 * see the note above about what an unrounded `end` does to a query key.
 */
export function rangeBounds(range: TimeRangeValue): {
  start: string;
  end: string;
} {
  const minute = 60_000;
  const end = Math.floor(Date.now() / minute) * minute;
  return {
    start: new Date(end - rangeSeconds(range) * 1000).toISOString(),
    end: new Date(end).toISOString(),
  };
}

/** Is this timestamp inside the range? For a list the backend cannot filter. */
export function withinRange(iso: string, range: TimeRangeValue): boolean {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return false;
  return at >= Date.now() - rangeSeconds(range) * 1000;
}

/**
 * A window, in words: "9 hours", "42 minutes", "3 days".
 *
 * Used to report the span samples **actually** cover, which is a different
 * number from the one that was asked for whenever collection has a gap in it.
 */
export function spanReading(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) {
    const rounded = Math.max(1, Math.round(seconds));
    return `${rounded} ${rounded === 1 ? "second" : "seconds"}`;
  }
  const days = Math.round(seconds / 86_400);
  if (seconds >= 86_400) return `${days} ${days === 1 ? "day" : "days"}`;
  const hours = Math.round(seconds / 3_600);
  if (seconds >= 3_600) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * The control itself. A `Segmented`, because all four choices are worth seeing
 * at once and each acts immediately.
 */
export function TimeRange({
  value,
  onChange,
  label = "How far back",
}: {
  value: TimeRangeValue;
  onChange: (value: TimeRangeValue) => void;
  label?: string;
}) {
  return (
    <Segmented
      label={label}
      options={TIME_RANGES.map(({ value: option, label: text }) => ({
        value: option,
        label: text,
      }))}
      value={value}
      onChange={onChange}
    />
  );
}
