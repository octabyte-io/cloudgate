/**
 * Traefik access-log analytics, as pure functions over the log's JSON lines.
 * The dashboard's own traefik service — `cloudgate-service-app@file`, the
 * name the web-server traefik config writes — is filtered out of every view.
 *
 * **Everything here is shared by every reader of an Access log**: the line
 * parser, hour bucketing, the totals, the stop rule and `retainedFrom`. What
 * belongs to one reader only — the platform host's `.hours` index, its inode
 * fingerprint and its in-process cache — stays in access-log.index.ts and
 * access-log.service.ts, so that a reader with no local file (a Server's log,
 * read over SSH) can use this module without inheriting any of it.
 */

/**
 * One line of Traefik's access log.
 *
 * **The optional half is not defensiveness — Traefik omits those keys.** A
 * request that arrives with no `Host` header is written with no `RequestHost`
 * key at all, and internet scanners send those to any public :80/:443
 * routinely; a request no router matched has no `RouterName`, and one no
 * service answered has no `ServiceName`, `ServiceAddr`, `ServiceURL` or
 * `Origin*` trio. The header-derived keys are absent whenever the header was.
 * They were all declared `string`, so `SEARCH_TIERS[0]` handed `undefined` to
 * `.toLowerCase()` and **one** such line in the window made every search a 500.
 * Marking them optional is what makes the compiler refuse the next one.
 *
 * What stays required is what the entry point that received the request writes
 * whatever happened to it afterwards: the client, the request line, the
 * downstream answer, the timings and the timestamps.
 */
export interface LogEntry {
  ClientAddr: string;
  ClientHost: string;
  ClientPort: string;
  ClientUsername: string;
  DownstreamContentSize: number;
  DownstreamStatus: number;
  Duration: number;
  OriginContentSize?: number;
  OriginDuration?: number;
  OriginStatus?: number;
  Overhead: number;
  RequestAddr: string;
  RequestContentSize: number;
  RequestCount: number;
  RequestHost?: string;
  RequestMethod: string;
  RequestPath?: string;
  RequestPort: string;
  RequestProtocol: string;
  RequestScheme: string;
  RetryAttempts: number;
  RouterName?: string;
  ServiceAddr?: string;
  ServiceName?: string;
  ServiceURL?: {
    Scheme: string;
    Opaque: string;
    User: null;
    Host: string;
    Path: string;
    RawPath: string;
    ForceQuery: boolean;
    RawQuery: string;
    Fragment: string;
    RawFragment: string;
  };
  StartLocal: string;
  StartUTC: string;
  /**
   * A kept header is `<prefix>_<Header>` in the header's own canonical
   * spelling, hyphen and all (Traefik's `accesslog` fields), so these are
   * quoted keys: `request_User-Agent`, never `request_User_Agent`.
   */
  'downstream_Content-Type'?: string;
  entryPointName: string;
  level: string;
  msg: string;
  'origin_Content-Type'?: string;
  'request_Content-Type'?: string;
  'request_User-Agent'?: string;
  time: string;
}

/** The Cloudgate dashboard's traefik service (traefik/config/web-server.ts). */
export const DASHBOARD_SERVICE = 'cloudgate-service-app@file';

export interface HourlyData {
  hour: string;
  count: number;
}

export interface DateRange {
  start?: string;
  end?: string;
}

export interface PageInfo {
  pageIndex: number;
  pageSize: number;
}

export interface SortInfo {
  id: string;
  desc: boolean;
}

/**
 * Could this line be a JSON object? Traefik writes one object per line.
 *
 * Shared with the reader in access-log.service.ts, which now decides line by
 * line what to keep instead of handing the file over whole — the two must
 * agree on what a log line is, or the reader drops rows the parser would count.
 */
export function isJsonObjectLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== '' && trimmed.startsWith('{') && trimmed.endsWith('}');
}

/** Lines that could be a JSON object; traefik writes one object per line. */
function jsonLines(raw: string): string[] {
  return raw.split('\n').filter(isJsonObjectLine);
}

/** Also the reader's filter, for the same reason as `isJsonObjectLine`. */
export function inDateRange(timestamp: string, dateRange?: DateRange): boolean {
  if (!dateRange?.start && !dateRange?.end) return true;
  const logDate = new Date(timestamp).getTime();
  const start = dateRange.start ? new Date(dateRange.start).getTime() : 0;
  const end = dateRange.end
    ? new Date(dateRange.end).getTime()
    : Number.POSITIVE_INFINITY;
  return logDate >= start && logDate <= end;
}

/**
 * A line's row, or null when it is not one any reader would keep: not a JSON
 * object, invalid JSON (Traefik's last line is routinely a half-written one),
 * or the dashboard's own traffic.
 */
export function parseKeptLine(line: string): AccessLogRow | null {
  if (!isJsonObjectLine(line)) return null;
  let row: AccessLogRow & { ServiceName?: string };
  try {
    row = JSON.parse(line.trim()) as typeof row;
  } catch {
    return null;
  }
  return row.ServiceName === DASHBOARD_SERVICE ? null : row;
}

/** The part of a row the readers decide on; the rest is the parser's. */
export interface AccessLogRow {
  StartUTC?: string;
  /** Nanoseconds, as Traefik writes a Go `time.Duration`. */
  Duration?: number;
}

/**
 * The UTC hour a row belongs to — the hour its request **started** — or null
 * when its timestamp is unreadable.
 *
 * One function for the chart's buckets and the index's buckets, because they
 * have to be the same buckets.
 */
export function hourBucketFor(startUtc: string): string | null {
  const at = new Date(startUtc).getTime();
  if (Number.isNaN(at)) return null;
  return `${new Date(at).toISOString().slice(0, 13)}:00:00Z`;
}

/** A window as epoch milliseconds; an absent bound is unbounded. */
export function windowBounds(dateRange?: DateRange): {
  startsAt: number;
  endsAt: number;
} {
  return {
    startsAt: dateRange?.start
      ? new Date(dateRange.start).getTime()
      : Number.NEGATIVE_INFINITY,
    endsAt: dateRange?.end
      ? new Date(dateRange.end).getTime()
      : Number.POSITIVE_INFINITY,
  };
}

/**
 * When a request finished, which is when Traefik wrote its line: `StartUTC`
 * plus `Duration`. NaN when the start is unreadable.
 */
export function finishedAt(row: AccessLogRow): number {
  const startedAt = new Date(row.StartUTC ?? '').getTime();
  return startedAt + (row.Duration ?? 0) / 1_000_000;
}

/**
 * How many lines in a row must have finished before the window opened before
 * a backwards walk believes it.
 *
 * Not a buffer size. Traefik's `bufferingSize` is the length of the queue
 * between request handlers and the one writer — its default is **0**; 100 is
 * the value Cloudgate writes (`TraefikFilesService.toggleRequests`) — and a
 * queue delays lines, it does not reorder them. What does reorder them is
 * that two requests finishing in the same instant race to that queue, so the
 * order is completion order give or take a hair. One stray line is no proof;
 * a run of them is.
 */
export const STOP_RULE_TOLERANCE = 100;

/**
 * The stop rule for walking an Access log **backwards** from its end: a
 * predicate fed each row, newest line first, that answers true once every
 * line still ahead (older in the file) is certain to be outside the window.
 *
 * **Traefik writes a line when its request finishes, but stamps `StartUTC`
 * when it started.** So the file is in completion order, and a long download,
 * a long poll or a WebSocket lands late: its line sits behind lines of
 * requests that started after it — and, walking backwards, *behind lines
 * that started before the window*. Stopping at the first line whose start is
 * older than the window, which is the obvious rule and the one this replaced,
 * drops every such request without a trace.
 *
 * What is sound is the line's **finish**: a line that finished before the
 * window opened was written before every request that started inside it
 * finished, so everything older in the file finished — and therefore started
 * — earlier still. A line that started before the window but finished inside
 * it proves nothing, and does not count towards the run.
 *
 * Stateful on purpose, so that a reader can feed it from a stream and stop
 * reading the moment it says so.
 */
export function backwardStopRule(
  dateRange?: DateRange,
): (row: AccessLogRow) => boolean {
  const { startsAt } = windowBounds(dateRange);
  let finishedBefore = 0;
  return (row) => {
    const finished = finishedAt(row);
    // A line with no usable timestamp is no evidence about where we are.
    if (Number.isNaN(finished)) return false;
    finishedBefore = finished < startsAt ? finishedBefore + 1 : 0;
    return finishedBefore > STOP_RULE_TOLERANCE;
  };
}

/**
 * The oldest hour a read still holds, when the window asked for something
 * older and the read could not go there.
 *
 * `oldestHeld` is set by the reader only when something older is *known* to be
 * missing — rotated away, or past what one read may fetch. A window that merely
 * predates a log nothing was lost from gets nothing back: an empty answer is
 * the truth there. The difference is the whole point — one is "no traffic",
 * the other is "we no longer have that".
 */
export function retainedFrom(
  oldestHeld: string | undefined,
  startsAt: number,
): string | undefined {
  if (oldestHeld === undefined) return undefined;
  return startsAt < new Date(oldestHeld).getTime() ? oldestHeld : undefined;
}

/** Requests bucketed per UTC hour — the hour each request started. */
export function processLogs(
  logString: string,
  dateRange?: DateRange,
): HourlyData[] {
  if (!logString) return [];

  const counts = new Map<string, number>();
  for (const line of jsonLines(logString)) {
    let log: LogEntry;
    try {
      log = JSON.parse(line) as LogEntry;
    } catch (error) {
      console.error('Error parsing log entry:', error);
      continue;
    }
    if (log.ServiceName === DASHBOARD_SERVICE) continue;
    if (!inDateRange(log.StartUTC, dateRange)) continue;

    const hour = hourBucketFor(log.StartUTC);
    if (hour === null) continue;
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => new Date(a.hour).getTime() - new Date(b.hour).getTime());
}

const isStatusInRange = (status: number, range: string): boolean => {
  switch (range) {
    case 'info':
      return status >= 100 && status <= 199;
    case 'success':
      return status >= 200 && status <= 299;
    case 'redirect':
      return status >= 300 && status <= 399;
    case 'client':
      return status >= 400 && status <= 499;
    case 'server':
      return status >= 500 && status <= 599;
    default:
      return false;
  }
};

/**
 * The fields `search` looks at, **in precedence order**.
 *
 * The term is matched against `RequestHost` first and the wider fields are only
 * consulted when the host matched nothing at all. That tiering is what makes
 * widening the search additive: a caller that sends a term matching some host —
 * every caller there was before the path and service filters — gets exactly the
 * rows it got before, and never a path or a service dragged in alongside them.
 * Type a path or a service name, which no host can contain, and the fallback
 * tiers answer instead.
 *
 * **Each tier answers the empty string for a key Traefik did not write, and
 * joining rather than interpolating is the point**. Interpolation turned
 * an absent path into the searchable text `"undefined"`, so searching for the
 * word `undefined` matched every unrouted line — and the host tier threw
 * outright on the first one. An empty string matches no non-empty term, which
 * is the right answer: a line with no host is not a line whose host is
 * anything.
 */
const SEARCH_TIERS: ((log: LogEntry) => string)[] = [
  (log) => log.RequestHost ?? '',
  (log) => [log.RequestPath, log.ServiceName].filter(Boolean).join(' '),
];

/** The first tier that matches anything wins; ties are impossible by design. */
function applySearch<T extends LogEntry>(logs: T[], search: string): T[] {
  const term = search.toLowerCase();
  for (const field of SEARCH_TIERS) {
    const matched = logs.filter((log) =>
      field(log).toLowerCase().includes(term),
    );
    if (matched.length > 0) return matched;
  }
  return [];
}

/** lodash orderBy's pairwise comparison for one column. */
function compareBy(id: string, desc: boolean) {
  return (a: LogEntry, b: LogEntry): number => {
    const left = a[id as keyof LogEntry] as unknown as string | number;
    const right = b[id as keyof LogEntry] as unknown as string | number;
    const order = left < right ? -1 : left > right ? 1 : 0;
    return desc ? -order : order;
  };
}

/** Every query value becomes this; the names are kept. */
export const HIDDEN_QUERY_VALUE = '***';

/**
 * `RequestPath` with each query value replaced by `***`, the names kept
 * (`/reset?token=***`). No switch: password-reset and signed-download tokens
 * travel in query strings, and Traefik can only keep or drop the whole path,
 * so the file keeps them and the read hides them (ADR-0055). Every reader:
 * a Server's, and the platform host's, which fronts every Organization's
 * Domains (#1342).
 *
 * An empty value is hidden too, so a value cannot be told from none by what
 * comes back; a name with no `=` has no value to hide and is kept as it is.
 */
export function hideQueryValues(requestPath: string): string {
  const mark = requestPath.indexOf('?');
  if (mark === -1) return requestPath;
  const query = requestPath
    .slice(mark + 1)
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      return equals === -1
        ? pair
        : `${pair.slice(0, equals)}=${HIDDEN_QUERY_VALUE}`;
    })
    .join('&');
  return `${requestPath.slice(0, mark)}?${query}`;
}

/**
 * Filter, sort and paginate raw access-log lines — the platform host's rows,
 * for both routes that answer them (`GET /monitoring/requests` with no
 * Server, and `POST /monitoring/requests/logs`).
 *
 * Each row's query values are hidden as it is parsed, before the search runs,
 * as a Server's read does: the platform host fronts every Organization's
 * Domains, so the Instance organization's authority to read the file is no
 * reason to show another Organization's reset tokens (#1342). The file itself
 * is not changed.
 */
export function parseRawConfig(
  rawConfig: string,
  page?: PageInfo,
  sort?: SortInfo,
  search?: string,
  status?: string[],
  dateRange?: DateRange,
  method?: string[],
): { data: LogEntry[]; totalCount: number } {
  if (!rawConfig) return { data: [], totalCount: 0 };

  let parsedLogs: LogEntry[] = [];
  for (const line of jsonLines(rawConfig)) {
    try {
      const log = JSON.parse(line) as LogEntry;
      if (log.RequestPath !== undefined) {
        log.RequestPath = hideQueryValues(log.RequestPath);
      }
      parsedLogs.push(log);
    } catch (error) {
      console.error('Error parsing log line:', error);
    }
  }

  parsedLogs = parsedLogs.filter(
    (log) => log.ServiceName !== DASHBOARD_SERVICE,
  );

  const filtered = filterLogEntries(parsedLogs, {
    search,
    status,
    dateRange,
    method,
  });
  return {
    data: sortAndPage(filtered, page, sort),
    totalCount: filtered.length,
  };
}

/** The filters every Requests read takes, besides who may see which line. */
export interface LogFilters {
  search?: string;
  status?: string[];
  dateRange?: DateRange;
  method?: string[];
}

/**
 * The window, search, status and method filters over parsed rows — what
 * `parseRawConfig` applies, for a reader that already holds rows rather than
 * raw lines (a Server's, which splits them by Service first).
 */
export function filterLogEntries<T extends LogEntry>(
  logs: T[],
  { search, status, dateRange, method }: LogFilters,
): T[] {
  let kept = logs;

  if (dateRange?.start || dateRange?.end) {
    kept = kept.filter((log) => inDateRange(log.StartUTC, dateRange));
  }

  if (search) {
    kept = applySearch(kept, search);
  }

  if (status && status.length > 0) {
    kept = kept.filter((log) =>
      status.some((range) => isStatusInRange(log.DownstreamStatus, range)),
    );
  }

  // Verbs, not classes: an exact match on the whole method, case-folded because
  // the term arrives from a caller and `RequestMethod` is Traefik's uppercase.
  // Several methods means *any* of them, like `status`.
  if (method && method.length > 0) {
    const wanted = new Set(method.map((verb) => verb.toUpperCase()));
    kept = kept.filter((log) => wanted.has(log.RequestMethod?.toUpperCase()));
  }

  return kept;
}

/** Sorted (newest first unless told otherwise), then one page of it. */
export function sortAndPage<T extends LogEntry>(
  logs: T[],
  page?: PageInfo,
  sort?: SortInfo,
): T[] {
  const sorted = [...logs].sort(
    sort ? compareBy(sort.id, sort.desc) : compareBy('time', true),
  );
  if (!page) return sorted;
  const startIndex = page.pageIndex * page.pageSize;
  return sorted.slice(startIndex, startIndex + page.pageSize);
}

/**
 * Rows counted per UTC hour — the hour each request started — oldest first,
 * with hours that had none left out, as `processLogs` answers them.
 */
export function bucketByHour(logs: LogEntry[]): HourlyData[] {
  const counts = new Map<string, number>();
  for (const log of logs) {
    const hour = hourBucketFor(log.StartUTC);
    if (hour === null) continue;
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));
}
