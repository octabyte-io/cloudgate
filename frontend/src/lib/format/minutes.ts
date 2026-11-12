import { counted } from "@/lib/format/plural";

/**
 * A whole number of minutes, as an operator reads a lifetime: the requested-
 * preview maximum on Platform → This instance, and the same maximum in an
 * Application's Extend dialog. Moved here from
 * `requested-preview-max-ttl-card.tsx` under §1.4 once the second feature
 * imported it.
 *
 * `1440` → "24 hours", `90` → "1 hour 30 minutes", `10080` → "168 hours (7 days)".
 */
export function readMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const read = [
    hours > 0 ? counted(hours, "hour", "hours") : null,
    rest > 0 ? counted(rest, "minute", "minutes") : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  // Days only beside a whole number of them past the first, where the hours
  // stop being a figure anybody reads at a glance.
  const days = minutes / 1440;
  return Number.isInteger(days) && days > 1
    ? `${read} (${counted(days, "day", "days")})`
    : read;
}
