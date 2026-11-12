import type {
  SpendCalls,
  TokenSpend,
} from "@/lib/api/endpoints/token-spend";
import { spendTokens as tokens } from "@/lib/format/token-spend";

/**
 * The Token spend section's reading of `GET /applications/:id/token-spend`.
 * Pure, so the spec needs no DOM.
 */

/** The four windows. Four is `Segmented`'s maximum. */
export const SPEND_RANGES = [
  { value: "7d" as const, label: "7 days", days: 7 },
  { value: "30d" as const, label: "30 days", days: 30 },
  { value: "90d" as const, label: "90 days", days: 90 },
  { value: "all" as const, label: "All", days: null },
];

export type SpendRange = (typeof SPEND_RANGES)[number]["value"];

export const DEFAULT_SPEND_RANGE: SpendRange = "30d";

const DAY_MS = 86_400_000;
const utcDay = (at: Date) => at.toISOString().slice(0, 10);

/**
 * The `from`/`to` a range asks for: the last N **UTC** days, today included,
 * because UTC days are the route's only grain. A day string is the
 * same all day, so the query key it lands in is stable until midnight UTC.
 *
 * **"All" sends neither.** The route starts it on the day the AI model was
 * created and ends it on *its* today, which the console cannot know better.
 */
export function spendWindow(
  range: SpendRange,
  now: Date,
): { from?: string; to?: string } {
  const days = SPEND_RANGES.find((each) => each.value === range)?.days ?? null;
  if (days === null) return {};
  return {
    from: utcDay(new Date(now.getTime() - (days - 1) * DAY_MS)),
    to: utcDay(now),
  };
}


export type SpendDay = { day: string; reported: number; estimated: number };

/** One column per day of the window, zero days included as the route sends them. */
export function spendDays(days: TokenSpend["days"]): SpendDay[] {
  return days.map((each) => ({ day: each.day, ...tokens(each) }));
}

export type SpendRow = {
  id: string;
  agentName: string;
  /** The Agent was removed; its name is the one it had, kept by the rollup. */
  removed: boolean;
  model: string;
  reported: number;
  estimated: number;
  calls: SpendCalls;
};

/**
 * Agent × model served, biggest spender first. Keyed by the Agent's id,
 * which the route keeps past its removal (`agentUserId: null` then), so two
 * removed Agents that shared a name stay two rows.
 */
export function breakdownRows(breakdown: TokenSpend["breakdown"]): SpendRow[] {
  return breakdown
    .map((each) => ({
      id: `${each.agentId}/${each.model}`,
      agentName: each.agentName,
      removed: each.agentUserId === null,
      model: each.model,
      ...tokens(each),
      calls: each.calls,
    }))
    .sort(
      (a, b) =>
        b.reported + b.estimated - (a.reported + a.estimated) ||
        a.agentName.localeCompare(b.agentName),
    );
}

export const totalCalls = (calls: SpendCalls) =>
  calls.ok + calls.runtimeError + calls.clientAborted + calls.refused;


const DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** "Oct 1" for `2026-10-01`, read as the UTC day it is. */
export const dayLabel = (day: string) =>
  DAY.format(new Date(`${day}T00:00:00.000Z`));
