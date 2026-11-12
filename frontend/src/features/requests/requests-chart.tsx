import { Card } from "@/components/console/card";
import { Chart } from "@/components/console/chart";
import { Skeleton } from "@/components/console/skeleton";
import { StatGrid, StatTile } from "@/components/console/stat-tile";
import {
  rangeLabel,
  type TimeRangeValue,
} from "@/components/console/time-range";
import { errorMessage } from "@/lib/api/error-message";
import { Icon } from "@/lib/design/icons";
import type {
  RequestStatsPoint,
  RequestsRead,
} from "@/lib/api/endpoints/monitoring";

/**
 * Requests per hour over the chosen window, and the two figures worth leading
 * with.
 *
 * **Counted from the same read as the table under it**, after the split by
 * Service and after every filter, so the chart, the totals and the table
 * agree: a member who sees only some Services is counted only those lines.
 * It used to have its own route that took a time range and nothing else, and
 * said so in its header whenever a filter was on.
 *
 * **The gaps are filled.** The answer buckets by UTC hour and leaves out the
 * hours that had no traffic; plotting it as it arrives draws a line straight
 * through a four-hour outage. So every hour in the window is materialised,
 * missing ones at zero, before anything is drawn.
 *
 * **An area chart, not bars.** One series, a count, over time — and a bar per
 * hour over a 168-hour window is 168 marks two pixels wide.
 *
 * **Filled zeros are only zeros where the read reached.** One read takes the
 * newest ~16 MiB of the live file and never the rotated ones, so on a busy or
 * just-rotated log it can stop short of the window's start; the answer says
 * where in `retainedFrom`. Those hours are not quiet, they are unread: a note
 * above the card says how far back the page shows and suggests a shorter
 * range, the start of the plot is striped "Not read before HH:MM", and the
 * quiet-hours count leaves them out.
 */
export function RequestsChart({
  range,
  bounds,
  read,
}: {
  range: TimeRangeValue;
  bounds: { start: string; end: string };
  read: { data?: RequestsRead; error: unknown; isPending: boolean };
}) {
  const hours = read.data ? fillHours(read.data.hours, bounds) : [];
  const counts = hours.map((hour) => hour.count);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const peak = counts.length > 0 ? Math.max(...counts) : 0;
  const cut = readReachedTo(read.data?.retainedFrom, bounds);
  const reachedBack = cut === null ? null : clockLabel(cut, bounds.end);
  // An hour that began before the read reached back is partly or wholly
  // unread, so its count says nothing about how quiet it was.
  const quiet = hours.filter(
    (hour) =>
      hour.count === 0 && (cut === null || Date.parse(hour.hour) >= cut),
  ).length;
  const unread =
    cut === null || reachedBack === null || hours.length === 0
      ? undefined
      : {
          until: (cut - Date.parse(hours[0].hour)) / HOUR,
          label: `Not read before ${reachedBack}`,
        };

  return (
    <>
      {reachedBack === null ? null : (
        <p
          role="note"
          className="flex items-start gap-2.5 rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-body text-tx"
        >
          <Icon name="alert" className="mt-0.5 flex-none text-warn" />
          <span>
            <b className="font-semibold">Showing back to {reachedBack} only.</b>{" "}
            One read covers only the newest part of the log, at most about
            20,000 requests, and never older rotated files, so it stopped short
            of this range. Pick a shorter range to see all of it.
          </span>
        </p>
      )}
      <Card>
        <Card.Header
          title="Requests per hour"
          sub={`Bucketed by UTC hour, over the last ${rangeLabel(range)}.`}
          headingLevel={2}
        />
        <Card.Body className="flex flex-col gap-4">
          {read.error ? (
            <p className="text-body text-tx-2">{errorMessage(read.error)}</p>
          ) : read.isPending ? (
            <div className="grid gap-3.5" aria-busy="true">
              <Skeleton className="h-plot w-full" />
              <Skeleton className="h-14" />
            </div>
          ) : total === 0 ? (
            <p className="text-body text-tx-2">
              Nothing was recorded in this window.
            </p>
          ) : (
            <>
              <Chart
                label="Requests per hour"
                value={total.toLocaleString()}
                detail={`across ${hours.length} ${hours.length === 1 ? "hour" : "hours"} · peak ${peak.toLocaleString()} in one hour`}
                values={counts}
                // A count has no natural ceiling, so the domain is the series' own
                // peak — the opposite of the Server cards, whose percentages are
                // drawn against 0–100 so that jitter stays flat.
                domain={[0, Math.max(1, peak)]}
                format={(value) =>
                  `${Math.round(value).toLocaleString()} requests`
                }
                labelAt={(index) => hourLabel(hours[index]?.hour)}
                tickCount={4}
                unread={unread}
              />
              <StatGrid>
                <StatTile
                  label="Requests"
                  value={total.toLocaleString()}
                  detail={`in the last ${rangeLabel(range)}`}
                />
                <StatTile
                  label="Busiest hour"
                  value={peak.toLocaleString()}
                  detail={busiestHour(hours)}
                />
                <StatTile
                  label="Quiet hours"
                  value={quiet}
                  detail={
                    cut === null
                      ? "hours in this window with no requests at all"
                      : "hours read in full with no requests at all"
                  }
                />
              </StatGrid>
            </>
          )}
        </Card.Body>
      </Card>
    </>
  );
}

const HOUR = 3_600_000;

/**
 * Where the read stopped, in ms, when that is inside the window; otherwise
 * null. A time at or before the start means the read covered the window, and
 * one after the end cannot be a shortfall of it.
 */
function readReachedTo(
  retainedFrom: string | undefined,
  bounds: { start: string; end: string },
): number | null {
  if (retainedFrom === undefined) return null;
  const at = Date.parse(retainedFrom);
  if (!Number.isFinite(at)) return null;
  return at > Date.parse(bounds.start) && at < Date.parse(bounds.end)
    ? at
    : null;
}

/**
 * `14:05` in the reader's own zone, with the weekday in front when it is not
 * the window's last day — over 7 days a bare time would name the wrong one.
 */
function clockLabel(at: number, end: string): string {
  const time = new Date(at);
  const clock = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
  return time.toDateString() === new Date(end).toDateString()
    ? clock
    : `${time.toLocaleDateString(undefined, { weekday: "short" })} ${clock}`;
}

/**
 * Every hour in the window, with the ones that had no traffic at zero.
 *
 * The API omits empty hours; a plot must not. Bounded at 200 points so a 7-day
 * window (168) fits and nothing pathological gets through.
 */
function fillHours(
  points: RequestStatsPoint[],
  bounds: { start: string; end: string },
): RequestStatsPoint[] {
  const byHour = new Map(points.map((point) => [point.hour, point.count]));
  const hour = 3_600_000;
  const from = Math.floor(Date.parse(bounds.start) / hour) * hour;
  const to = Math.floor(Date.parse(bounds.end) / hour) * hour;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from)
    return points;

  const filled: RequestStatsPoint[] = [];
  for (let at = from; at <= to && filled.length < 200; at += hour) {
    // The key the backend writes: an ISO string truncated to the hour, `Z`.
    const key = `${new Date(at).toISOString().slice(0, 13)}:00:00Z`;
    filled.push({ hour: key, count: byHour.get(key) ?? 0 });
  }
  return filled;
}

/** `14:00` in the reader's own zone — the buckets are UTC, the labels are not. */
function hourLabel(hour: string | undefined): string {
  if (!hour) return "";
  const at = new Date(hour);
  if (Number.isNaN(at.getTime())) return "";
  return `${String(at.getHours()).padStart(2, "0")}:00`;
}

function busiestHour(hours: RequestStatsPoint[]): string {
  if (hours.length === 0) return "no hours in this window";
  const busiest = hours.reduce((most, hour) =>
    hour.count > most.count ? hour : most,
  );
  return `at ${hourLabel(busiest.hour)} in your own time zone`;
}
