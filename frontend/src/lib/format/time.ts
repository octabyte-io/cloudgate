/**
 * Times, as an operator reads them.
 *
 * Three shapes, and the product needs all three: "when did this happen" is
 * relative (a Deployment two minutes ago), "how long did it take" is a duration
 * (a build of 1m 12s), and "exactly when" is absolute — the title on the other
 * two, because a relative stamp is quick to read and impossible to correlate with
 * a log line.
 *
 * **Never call these from a Server Component.** Every one of them reads the
 * clock, so a value rendered on the server and hydrated on the client would
 * disagree by the length of the request and React would not patch it up. That is
 * not a theoretical risk in this app — it is why nothing here is used above a
 * client fetch, and every table that shows a time is a Client Component whose
 * rows arrive after mount.
 *
 * The locale is fixed to `en` on purpose: it is the language every string beside
 * these is written in, and reading the browser's locale would give one row in
 * German next to a heading in English.
 */

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const SAME_YEAR = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
});

const OTHER_YEAR = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const EXACT = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "medium",
});

const CLOCK = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * "just now", "14 minutes ago", "yesterday", "3 Aug".
 *
 * It stops being relative after a week, because "5 weeks ago" is a worse answer
 * than a date: nobody counts weeks, and by then the question has changed from
 * "how recent" to "which day".
 *
 * A stamp in the future is not clamped to "just now" — a clock skewed against the
 * backend's is worth seeing rather than hiding.
 */
export function timeAgo(iso: string | null | undefined): string | null {
  const at = parse(iso);
  if (at === null) return null;

  const delta = at.getTime() - Date.now();
  const ago = Math.abs(delta);

  if (ago < 45_000) return "just now";
  if (ago < HOUR) return RELATIVE.format(Math.round(delta / MINUTE), "minute");
  if (ago < DAY) return RELATIVE.format(Math.round(delta / HOUR), "hour");
  if (ago < WEEK) return RELATIVE.format(Math.round(delta / DAY), "day");

  return (
    at.getFullYear() === new Date().getFullYear() ? SAME_YEAR : OTHER_YEAR
  ).format(at);
}

/**
 * `14:32:07` — the time of day on a 24-hour clock, in the reader's own zone,
 * which is what a log is scanned by: a log's last line (epoch ms) or a line's
 * stamp (ISO). A dash for a stamp it cannot read.
 */
export function clockTime(at: number | string): string {
  const when = typeof at === "number" ? new Date(at) : parse(at);
  return when === null || Number.isNaN(when.getTime())
    ? "—"
    : CLOCK.format(when);
}

/** The whole stamp, for the `title` on a relative one. */
export function timeExact(iso: string | null | undefined): string | undefined {
  const at = parse(iso);
  return at === null ? undefined : EXACT.format(at);
}

/**
 * "12s", "1m 12s", "1h 04m" — how long something took, or has been running.
 *
 * Two units at most: the third is never what anyone is asking. Seconds are
 * dropped past an hour for the same reason, and the minutes are padded there so a
 * column of them lines up.
 *
 * `to` may be `null`, which is the live case — a run that has started and not
 * finished — and the answer is how long it has been going. Both `null` means it
 * has not started, and there is no duration to state.
 */
export function timeTaken(
  from: string | null | undefined,
  to: string | null | undefined,
): string | null {
  const start = parse(from);
  if (start === null) return null;
  const end = parse(to) ?? new Date();

  const ms = end.getTime() - start.getTime();
  if (ms < 0) return null;

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A stamp we cannot read is not a date — and not a crash either. */
function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}
