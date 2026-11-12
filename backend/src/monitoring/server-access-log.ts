import {
  backwardStopRule,
  finishedAt,
  inDateRange,
  parseKeptLine,
  retainedFrom,
  windowBounds,
} from './access-log.parser';
import type { DateRange, LogEntry } from './access-log.parser';
import { hideQueryValues } from './access-log.parser';

/**
 * The pure half of reading a **Server's** Access log (ADR-0056): what one
 * read of the end of the file holds for a window, which Service each line
 * belongs to. The SSH half, and who may see which line (ADR-0055), are
 * `ServerAccessLogService`'s; the query values no one is shown are hidden by
 * the shared parser's `hideQueryValues`, every reader's rule.
 *
 * Built on the shared parser — the line parser, the backwards stop
 * rule and `retainedFrom` — and on none of the platform host reader's
 * machinery: there is no hour index, inode fingerprint or cache for a file
 * on someone else's disk, and nothing read here is kept.
 *
 * The line match and the per-line split (`rowsTheCallerSees`) are the
 * platform host's read's too (`platform-host-requests.ts`, ADR-0061).
 */

/**
 * The most one read fetches from the end of the live file: about 20,000
 * requests. A starting value; it may be tuned against
 * real Servers.
 */
export const SERVER_ACCESS_LOG_READ_BYTES = 16 * 1024 * 1024;

/** How long a read may run before it is stopped and answered as too slow. */
export const SERVER_ACCESS_LOG_READ_TIMEOUT_MS = 10_000;

/** The Service a line belongs to, as the Requests table names it. */
export interface RequestService {
  serviceId: string;
  name: string;
}

/**
 * One row of a read: the line, with its query values hidden, and the Service
 * it belongs to — null for a line that matched no Domain, which only a
 * `server: ['read']` holder is ever sent on a Server, and only the Instance
 * organization's authority on the platform host (ADR-0061).
 */
export type RequestRow = LogEntry & { service?: RequestService | null };

/** The Service filter, when anything was picked in it. */
export interface ServiceChoice {
  serviceIds: Set<string>;
  /** Lines that matched no Domain. */
  noService: boolean;
  /** The one Service a Service's Requests tab is fixed to. */
  fixed?: RequestService;
}

/** A line, with the Service it was matched to for this caller, or none. */
export interface MatchedLine {
  line: LogEntry;
  serviceId: string | null;
}

/**
 * The rows a caller is sent, from lines already matched to a Service: those
 * whose Service (or, for null, the lines of none) `sees` allows, narrowed by
 * the Service filter — after the split, so it can only narrow what the
 * caller already sees and an id they cannot read finds nothing. Each row
 * names its Service and has its query values hidden. `onSkipped` hears every
 * line left out, either way.
 */
export function rowsTheCallerSees<T extends MatchedLine>(
  matched: Iterable<T>,
  sees: (serviceId: string | null) => boolean,
  chosen: ServiceChoice | null,
  names: ReadonlyMap<string, string>,
  onSkipped?: (skipped: T) => void,
): RequestRow[] {
  const rows: RequestRow[] = [];
  for (const entry of matched) {
    const { line, serviceId } = entry;
    const picked =
      !chosen ||
      (serviceId === null
        ? chosen.noService
        : chosen.serviceIds.has(serviceId));
    if (!sees(serviceId) || !picked) {
      onSkipped?.(entry);
      continue;
    }
    rows.push({
      ...line,
      ...(line.RequestPath !== undefined
        ? { RequestPath: hideQueryValues(line.RequestPath) }
        : {}),
      service:
        serviceId === null
          ? null
          : { serviceId, name: names.get(serviceId) ?? serviceId },
    });
  }
  return rows;
}

/** One Domain on the Server, as the line-to-Service match needs it. */
export interface DomainRoute {
  serviceId: string;
  host: string;
  /** The Domain's path prefix; null or `/` is the whole host. */
  path: string | null;
}

/** `/api` and `/api/` both match `/api` and `/api/x`, never `/apiary`. */
function pathMatches(prefix: string, requestPath: string): boolean {
  const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (bare === '') return true;
  return requestPath === bare || requestPath.startsWith(`${bare}/`);
}

/**
 * The Service a line belongs to: the one whose Domain its host matched, the
 * longest path prefix winning where two Services share a host — which is how
 * Traefik picks between their routers. Null when no Domain on the Server
 * names the host (a scanner, an IP, a host since removed), which is a line
 * only `server: ['read']` holders see.
 *
 * Matched on the host rather than `RouterName`, which is `<appName>-<n>-…`
 * and would have to be taken apart to find a Service; a Domain *is* a host
 * and a path (CONTEXT.md).
 */
export function serviceIdForLine(
  row: { RequestHost?: string; RequestPath?: string },
  routes: DomainRoute[],
): string | null {
  const host = hostOfLine(row);
  if (host === null) return null;
  const requestPath = (row.RequestPath ?? '/').split('?')[0] || '/';

  let best: DomainRoute | null = null;
  let bestLength = -1;
  for (const route of routes) {
    if (route.host.toLowerCase() !== host) continue;
    const prefix = route.path ?? '/';
    if (!pathMatches(prefix, requestPath)) continue;
    if (prefix.length > bestLength) {
      best = route;
      bestLength = prefix.length;
    }
  }
  return best?.serviceId ?? null;
}

/** A line's host as a Domain's is compared: lowercase, without a port. */
function hostOfLine(row: { RequestHost?: string }): string | null {
  if (!row.RequestHost) return null;
  return row.RequestHost.toLowerCase().replace(/:\d+$/, '');
}

/** One Domain on the platform host, with the Organization whose Service holds it. */
export interface PlatformHostRoute extends DomainRoute {
  organizationId: string;
}

/**
 * What a platform-host line matched (ADR-0061): a Service, a host more than
 * one Organization holds there (`shared`, named so a reader can tell whether
 * it is one of theirs), or nothing.
 *
 * A shared line matches no Service for any Organization, but `routedTo` says
 * which one Traefik sent it to — the longest path prefix across every
 * Organization's Domains on the host, null when none prefixes the path — for
 * the one reader who sees every line with its Service named, the Instance
 * organization's authority. No one else may be told it.
 */
export type PlatformHostMatch =
  | { kind: 'service'; serviceId: string }
  | { kind: 'shared'; host: string; routedTo: string | null }
  | { kind: 'none' };

/**
 * The line match for the platform host's access log, which holds every
 * Organization's traffic. It is {@link serviceIdForLine} over **every**
 * Organization's platform-host Domains, so another Organization's `host/blog`
 * is never read as the caller's `host/`, less the hosts more than one
 * Organization holds there: those match no Service at all, whatever the path,
 * because Domain claims on the platform host are not airtight and a line
 * attributed to the wrong Organization is the disclosure ADR-0013 guards.
 * Such a line still says where Traefik routed it (`routedTo`), for the
 * Instance organization's authority alone.
 *
 * Rejected: matching only the caller's own Domains, best route wins, as a
 * Server read does — on the one machine two Organizations share, a host both
 * hold would hand one the other's visitors.
 */
export function platformHostMatcher(
  routes: PlatformHostRoute[],
): (row: { RequestHost?: string; RequestPath?: string }) => PlatformHostMatch {
  const holders = new Map<string, Set<string>>();
  for (const route of routes) {
    const host = route.host.toLowerCase();
    const orgs = holders.get(host) ?? new Set<string>();
    orgs.add(route.organizationId);
    holders.set(host, orgs);
  }
  const shared = new Set(
    [...holders].filter(([, orgs]) => orgs.size > 1).map(([host]) => host),
  );
  const matchable = routes.filter(
    (route) => !shared.has(route.host.toLowerCase()),
  );

  return (row) => {
    const host = hostOfLine(row);
    if (host !== null && shared.has(host)) {
      return { kind: 'shared', host, routedTo: serviceIdForLine(row, routes) };
    }
    const serviceId = serviceIdForLine(row, matchable);
    return serviceId === null
      ? { kind: 'none' }
      : { kind: 'service', serviceId };
  };
}

/** What one `tail -c` of the live file printed. */
export interface TailRead {
  text: string;
  /** Whether the read began at the file's first byte (the file was no larger). */
  fromStart: boolean;
}

/** The rows of a window one read holds, and how far back it reached. */
export interface TailWindow {
  /** Every kept line whose request started inside the window. */
  rows: LogEntry[];
  /**
   * Set when the read ran out — at the read bound or at the top of the
   * file — before it reached the start of the window: the finish of the
   * oldest line it held, which is from when on it holds every request.
   */
  retainedFrom?: string;
}

/**
 * The rows of a window in one read of the end of the log, walked newest
 * first with the shared backwards stop rule, which allows for lines landing
 * late by up to their request's duration (Traefik writes a line when its
 * request finishes).
 *
 * A read that did not start at the top of the file begins mid-line, so its
 * first line is dropped rather than handed to the parser half-written.
 *
 * `retainedFrom` is the finish, not the start, of the oldest line held: the
 * file is in completion order, so every request that finished after that
 * line is in the read, and a request that started after it finished after it
 * too. Nothing is said when the stop rule fired, or when the oldest line
 * held is already older than the window — the window is covered.
 */
export function windowFromTail(
  read: TailRead,
  dateRange?: DateRange,
): TailWindow {
  const lines = read.text.split('\n');
  if (!read.fromStart) lines.shift();

  const stop = backwardStopRule(dateRange);
  const rows: LogEntry[] = [];
  let stopped = false;
  let oldestFinish = Number.POSITIVE_INFINITY;

  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const row = parseKeptLine(lines[at]) as LogEntry | null;
    if (row === null || !row.StartUTC) continue;
    const finished = finishedAt(row);
    if (!Number.isNaN(finished) && finished < oldestFinish) {
      oldestFinish = finished;
    }
    if (stop(row)) {
      stopped = true;
      break;
    }
    if (inDateRange(row.StartUTC, dateRange)) rows.push(row);
  }

  if (stopped || !Number.isFinite(oldestFinish)) return { rows };
  const held = retainedFrom(
    new Date(oldestFinish).toISOString(),
    windowBounds(dateRange).startsAt,
  );
  return held === undefined ? { rows } : { rows, retainedFrom: held };
}
