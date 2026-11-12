import { useQuery } from "@tanstack/react-query";

import {
  monitoringApi,
  type MetricsWindow,
  type ServerMetric,
} from "@/lib/api/endpoints/monitoring";
import { keys } from "@/lib/api/keys";
import type { Server } from "@/lib/api/endpoints/servers";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { configCollects, samplingState } from "@/lib/format/sampling";

/**
 * A Server's telemetry series.
 *
 * Read `endpoints/monitoring.ts` first: it says why this is the route the Telemetry
 * tab uses rather than the socket the phase brief named, and what has to be true
 * before there is anything to read.
 *
 * **There are two reads, and which one a screen wants depends on its control.**
 * `useServerMetrics` answers "the last N samples" and `useServerMetricsInWindow`
 * answers "everything between these two instants".
 * They share one query, whose poll interval is the Server's own — see
 * `useMetricsQuery`.
 *
 * **Built by F13 in `features/server/telemetry/`, moved here by F14** — the second
 * feature to read a Server's samples, which is the signal `design-system.md` names.
 * The old path re-exports, so no F13 call site changed. It sits beside
 * `use-servers.ts` and `use-ssh-keys.ts` for the same reason those are here: a read
 * several features share belongs to none of them.
 */

/**
 * Whether anything is being collected for this Server at all — `configCollects`
 * (`lib/format/sampling.ts`) asked of a `Server` row, so a `filter` can take it.
 *
 * It was a second spelling of that predicate while `configCollects` lived in
 * `features/monitoring/`, which `lib/` does not import from. Both are in `lib/`
 * now, so there is one: `hasToken` first, then the value — only `GET /servers`
 * and `GET /servers/:id` still carry the value, and every other read of a
 * Server sends the flag in its place (`MetricsConfig`).
 */
export function isCollecting(server: Server): boolean {
  return configCollects(server.metricsConfig);
}

/**
 * **The last N samples**, for a screen whose control is a count.
 *
 * The Server's own Telemetry tab is the one: its choices are "Last 50", "Last 200"
 * and "Everything", which are questions about the *data* rather than about time,
 * and `limit` answers them exactly. A screen whose control is a time range wants
 * `useServerMetricsInWindow` below.
 */
export function useServerMetrics(
  server: Server,
  /** `"50"`, `"200"`, `"all"` — the agent's own query semantics. */
  limit: string,
  enabled = true,
) {
  return useMetricsQuery(server, { limit }, limit, enabled);
}

/**
 * **Every sample inside a time range**.
 *
 * `start` and `end` with no `limit`, which is what makes this the right read for a
 * range control: `parseMetricsRange` treats a bounded request with no cap as
 * uncapped, so six hours really answers six hours of samples rather than the last
 * fifty of them.
 *
 * **This replaced a conversion.** At first the only parameter was a sample
 * count, so a shared "last 6 hours" had to be turned into a number per host from
 * that host's `refreshRate` — 360 samples on a Server sampled every minute, 4,320
 * on one sampled every five seconds — and clamped, because the arithmetic could
 * ask for more than a plot can draw. Every part of that was a guess about
 * timestamps the route never looked at. The bounds are not.
 *
 * What it did **not** replace is `spanOf`: a window bounds what can come back, and
 * says nothing about whether the host was being sampled throughout it.
 */
export function useServerMetricsInWindow(
  server: Server,
  bounds: { start: string; end: string },
  enabled = true,
) {
  return useMetricsQuery(
    server,
    bounds,
    `${bounds.start}..${bounds.end}`,
    enabled,
  );
}

/**
 * One query for both reads above.
 *
 * **The poll follows the Server's own refresh rate.** `metricsConfig.server`
 * `refreshRate` is the interval at which the backend samples this host, so asking
 * more often than that just re-reads the same newest row; asking less often makes
 * a "live" reading stale by design. Reading the rate off the row means a Server
 * sampled every five minutes is polled every five minutes, which nothing else in
 * the console can know.
 *
 * `slice` is what the key is keyed on — a count or a pair of bounds, as one
 * string. Two resolutions of one host are two different answers, not one answer
 * cached twice, and `keys.monitoring.serverMetrics` has always taken that as its
 * third component.
 *
 * **A stopped Server is read, and not polled**
 * "Stop
 * collecting" clears the token and keeps the rest of the config — `cronJob`
 * included, which is `''` only on a Server that was never set up — and the
 * samples, which the backend's retention cleanup goes on pruning. Gating on
 * `isCollecting` left those samples unreadable the moment the button was
 * pressed. They are fetched unless `samplingState` says the Server was never
 * set up, and the poll is off unless it says collecting, because nothing new can
 * arrive. Every screen passes its own `enabled` from the same function, so the
 * gate here and the screen's can only disagree by the screen asking for less.
 */
function useMetricsQuery(
  server: Server,
  request: MetricsWindow,
  slice: string,
  enabled: boolean,
) {
  const { organizationId } = useActiveOrganizationId();
  const state = samplingState(server.metricsConfig);
  const refresh = Math.max(2, server.metricsConfig.server.refreshRate || 60);

  return useQuery({
    queryKey: keys.monitoring.serverMetrics(
      organizationId,
      server.serverId,
      slice,
    ),
    queryFn: () => monitoringApi.serverMetrics(server.serverId, request),
    enabled: enabled && state !== "never" && organizationId !== null,
    refetchInterval: state === "collecting" ? refresh * 1_000 : false,
  });
}

/**
 * The numbers, as numbers.
 *
 * Every float in a sample arrives as a **string** — the Go agent's `fmt "%.2f"`,
 * reproduced verbatim by `convertToSystemMetrics` — so a series has to be converted
 * before it can be plotted, and `Number("")` is `0` while a missing sample is not
 * zero of anything. Doing it in one place is what stops one card charting strings and
 * reading `NaN%` while the one beside it happens to have coerced.
 */
export function series(
  samples: readonly ServerMetric[],
  field: "cpu" | "memUsed" | "diskUsed" | "memUsedGB" | "networkIn" | "networkOut",
): number[] {
  return samples.map((sample) => {
    const value = Number(sample[field]);
    return Number.isFinite(value) ? value : 0;
  });
}

/** The newest sample, or `null` — which is what "nothing has been collected" is. */
export function latest(
  samples: readonly ServerMetric[] | undefined,
): ServerMetric | null {
  return samples && samples.length > 0 ? samples[samples.length - 1] : null;
}

/** "4 days", "6 hours", "18 minutes" — uptime, in the one unit worth reading. */
export function uptimeReading(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown";
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return `${days} ${days === 1 ? "day" : "days"}`;
  const hours = Math.floor(seconds / 3_600);
  if (hours >= 1) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const minutes = Math.max(1, Math.floor(seconds / 60));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/* ------------------------------------------------------------------ *
 * Did collection actually cover the window?
 * ------------------------------------------------------------------ */

/**
 * The window the samples in hand really cover, in seconds, or `null` for fewer
 * than two of them (one sample spans nothing).
 *
 * **This survived the bounds and changed job.** While `limit` was the only parameter it
 * was the *only* way to know what had come back: the route answered the last N
 * samples whatever their timestamps, so their span was a discovery. Bounds settle
 * that — nothing outside `start`/`end` can arrive now.
 *
 * What bounds cannot say is whether the host was being sampled for all of it. A
 * range that answers six samples for six hours is a Server that stopped being
 * reachable, and the numbers on the screen are still real. So this is a **gap
 * check**: compare the span against the requested range and against the sample
 * count, and say what collection actually did rather than what was asked for.
 */
export function spanOf(samples: readonly ServerMetric[]): number | null {
  if (samples.length < 2) return null;
  const first = Date.parse(samples[0].timestamp);
  const last = Date.parse(samples[samples.length - 1].timestamp);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return Math.max(0, (last - first) / 1000);
}

/* ------------------------------------------------------------------ *
 * The container series is not here
 * ------------------------------------------------------------------ *
 *
 * `useContainerMetrics` took a `Server`, and a `Server` is exactly what the
 * machine Cloudgate runs on does not have — so container samples collected
 * for the platform host, which on a default single-box install is every
 * Application there is, were served by the route and drawn nowhere. It moved to
 * `features/monitoring/use-monitoring.ts` and now takes a collection target whose
 * id may be `null`, gated on the config-shaped `samplingState`
 * (`lib/format/sampling.ts`) and `includedFrom` (`features/monitoring/setup/`). Its `includedServices` companion went with it by
 * being deleted: it was `includedFrom` with a `Server` in place of a config, and
 * only the config shape can describe a host with no row (§1.4).
 *
 * It did not stay here re-shaped, for two reasons: the Monitoring screen is the
 * only feature that reads container samples, so by the promotion rule the read
 * belongs to it; and nothing in `lib/` imports from `features/` anywhere in this
 * tree, which reaching `includedFrom` from here would have been the first case
 * of.
 *
 * `isCollecting` above stays: a Server's Telemetry tab and this screen both read
 * a Server's *server-level* series, and that is the `Server`-shaped question
 * they ask.
 * ------------------------------------------------------------------ */
