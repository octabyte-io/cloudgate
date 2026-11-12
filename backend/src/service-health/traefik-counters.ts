import { REQUEST_METRICS_URL } from '../common/config/request-metrics';
import { TRAEFIK_CONTAINER_NAME } from '../settings/traefik-files.service';

/**
 * Reading a Server's Traefik request counters and turning two reads into
 * per-service deltas (ADR-0027). Pure except for the command text, so the
 * delta rules are unit-tested without a machine.
 *
 * What Traefik v3 (the pinned 3.6.7, measured) serves on the loopback metrics
 * entryPoint, and the three lines this reads of it:
 *
 * ```
 * process_start_time_seconds 1.79035486292e+09
 * traefik_service_requests_total{code="502",method="GET",protocol="http",service="my-app-service-3@file"} 2
 * traefik_service_request_duration_seconds_bucket{code="502",method="GET",protocol="http",service="my-app-service-3@file",le="1.2"} 2
 * ```
 *
 * A series appears on its first request and every series is gone after a
 * restart, when counting starts again from zero; a removed service keeps its
 * last values until then.
 */

/**
 * The filter runs on the Server, so a read carries two lines per
 * (service, code, method, protocol) plus the start time, whatever the traffic.
 * The start-time line is also the proof the endpoint answered: without it
 * `grep` exits 1 and the read fails, rather than reading as a Traefik with no
 * traffic — which it would otherwise be indistinguishable from, and which a
 * Traefik still restarting (a 404, measured) would be mistaken for.
 *
 * The container is resolved by name filter, as `TraefikFilesService.reopenLogs`
 * does, because Traefik runs standalone or as a swarm task
 * (`cloudgate-traefik.1.<task-id>`). No part of it comes from a caller.
 */
export const REQUEST_COUNTERS_COMMAND =
  `docker exec "$(docker ps -q --filter name=${TRAEFIK_CONTAINER_NAME} --filter status=running | head -n 1)" ` +
  `wget -qO- ${REQUEST_METRICS_URL} | ` +
  `grep -E '^(process_start_time_seconds |traefik_service_requests_total\\{|traefik_service_request_duration_seconds_bucket\\{.*le="1\\.2"\\})'`;

/** One (service, code, method, protocol) series: its request and fast counts. */
export interface CounterSeries {
  service: string;
  code: string;
  requests: number;
  /** Requests at or under 1.2 s — the `le="1.2"` bucket. */
  fast: number;
}

/** One read of a Traefik's counters. */
export interface CounterRead {
  /** `process_start_time_seconds`; a change means Traefik restarted. */
  startTime: number | null;
  /** By series key (every label but `le`). */
  series: Map<string, CounterSeries>;
}

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/**
 * Parses the filtered read. Anything else on the page — or a line this does
 * not recognise — is skipped, so a wider read parses the same.
 */
export function parseCounterRead(text: string): CounterRead {
  let startTime: number | null = null;
  const series = new Map<string, CounterSeries>();
  for (const raw of text.split('\n')) {
    const match = LINE.exec(raw.trim());
    if (!match) continue;
    const [, name, labelText = '', valueText] = match;
    const value = Number(valueText);
    if (!Number.isFinite(value)) continue;
    if (name === 'process_start_time_seconds') {
      startTime = value;
      continue;
    }
    const isRequests = name === 'traefik_service_requests_total';
    const isBucket = name === 'traefik_service_request_duration_seconds_bucket';
    if (!isRequests && !isBucket) continue;

    const labels = new Map<string, string>();
    for (const label of labelText.matchAll(LABEL)) {
      labels.set(label[1], label[2]);
    }
    if (isBucket && labels.get('le') !== '1.2') continue;
    const service = labels.get('service');
    const code = labels.get('code');
    if (!service || !code) continue;
    labels.delete('le');
    const key = [...labels.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const entry = series.get(key) ?? { service, code, requests: 0, fast: 0 };
    if (isRequests) entry.requests = value;
    else entry.fast = value;
    series.set(key, entry);
  }
  return { startTime, series };
}

/** What one service answered between two reads. */
export interface CounterDelta {
  requests: number;
  /** 5xx, Traefik's own (a 502 with the containers down) included. */
  errors: number;
  /** Slower than 1.2 s. */
  slow: number;
}

/**
 * The per-service deltas from `previous` to `current`.
 *
 * - **A Traefik restart is a reset**, never a negative delta: when the start
 *   time moved every series counts from zero, and whatever the start time says,
 *   a series whose counter went down is read as having started again at zero.
 * - **A series `previous` did not have is new since it** — a series appears on
 *   its first request, so all of its count is in this interval.
 * - A series in `previous` and missing now contributes nothing.
 *
 * The caller decides what `previous` is; it must be a read of the same
 * Traefik, and there must be one — the first read after the backend starts is
 * a baseline, because its counts cover an unknown stretch before it.
 */
export function counterDeltas(
  previous: CounterRead,
  current: CounterRead,
): Map<string, CounterDelta> {
  const restarted =
    previous.startTime !== null &&
    current.startTime !== null &&
    previous.startTime !== current.startTime;
  const deltas = new Map<string, CounterDelta>();
  for (const [key, now] of current.series) {
    const before = restarted ? undefined : previous.series.get(key);
    const requests = counterDelta(before?.requests, now.requests);
    const fast = counterDelta(before?.fast, now.fast);
    const total = deltas.get(now.service) ?? {
      requests: 0,
      errors: 0,
      slow: 0,
    };
    total.requests += requests;
    if (now.code.startsWith('5')) total.errors += requests;
    total.slow += Math.max(0, requests - fast);
    deltas.set(now.service, total);
  }
  return deltas;
}

function counterDelta(before: number | undefined, now: number): number {
  if (before === undefined || now < before) return Math.round(now);
  return Math.round(now - before);
}
