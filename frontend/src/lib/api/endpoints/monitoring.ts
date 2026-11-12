import { api } from "../client";
import type { Server } from "./servers";

/**
 * `monitoring.controller.ts` — a Server's own telemetry, and the Organization's
 * request analytics.
 *
 * F13 declared only what a Server's Telemetry tab reads. **F14 owns the
 * Monitoring and Requests screens and has filled the module in**: the setup
 * mutation, the container series and the two `POST` request-analytics routes are
 * all here now, each with what driving it taught.
 *
 * ## Why this module exists at all, when the phase brief named a socket
 *
 * The F13 brief points the Telemetry tab at `/listen-docker-stats-monitoring`.
 * That gateway cannot answer for a Server: it takes an `appName` and **no
 * `serverId`** — the gateway's own comment says it is local-host only, with no
 * `serverId` parameter — and `appName: "cloudgate"` samples
 * *the machine the platform is running on*. Pointing a remote Server's Telemetry
 * tab at it would put the platform host's CPU under another host's name, which is
 * the most confident kind of wrong number a console can print.
 *
 * What *is* server-scoped is this route. `MonitoringService` collects
 * in-process: an interval per Server runs
 * `SERVER_STATS_COMMAND` over SSH, writes a `server_metric` row, and
 * `GET /monitoring/metrics?serverId=` reads them back oldest-first. Real numbers,
 * from the right host, with the CPU model and the kernel alongside.
 *
 * ## The one condition
 *
 * **No collection happens until a Server has been set up for monitoring.**
 * `registerServer` returns early unless `metricsConfig.server.token` is a
 * non-empty string, so a Server whose token is `""` — which is every Server as
 * created, since `defaultMetricsConfig` sets it empty — has no interval and no
 * rows, for ever. That is a state to *say*, not to render as a flat line at zero:
 * an empty chart and a chart of a host doing nothing look identical and mean
 * opposite things. The tab reads the token off the row it already has and
 * branches on it before it asks for a single sample.
 *
 * Setting it up is `POST /monitoring/servers/:serverId/setup`, which takes the
 * whole `metricsConfig` — a refresh rate, a port, a token, a `urlCallback` that
 * must be a URL, a retention window, a cleanup cron and two thresholds. That is a
 * form, and it is **F14's**; F13's Telemetry tab points at it rather than growing
 * a second one.
 *
 * ## Four things F14 found by driving the rest of the controller
 *
 * 1. **Three of the setup fields do nothing in this backend.** `token` is read by
 *    `registerServer` as a *presence* check and never sent anywhere, so it is the
 *    on switch wearing a secret's clothes. `port` and `urlCallback` are stored and
 *    read by nothing at all: they describe where an *external* agent would post to
 *    `POST /notifications/receive`, which is a route for agents Cloudgate does not
 *    deploy. `MonitoringService` samples over SSH from here. The form says which
 *    fields change behaviour and which are stored for an agent that does not exist.
 * 2. **A time window exists now, and `limit` still does**
 * Both metrics
 *    reads take `start` and `end` alongside `limit`, and the two compose in one
 *    place — `parseMetricsRange` — so the rules are worth knowing before sending
 *    either. See `MetricsWindow` below. At first there was only a sample
 *    *count*, so a window had to be converted per Server from that Server's own
 *    `refreshRate` and was exact only while collection had been continuous; the
 *    conversion (`samplesForWindow`) is gone from `use-server-metrics.ts` with
 *    this. What survives is the rule it existed to protect: **never assert the
 *    requested window back at the operator.** A window bounds what can come back;
 *    it does not promise the host was being sampled throughout it, so a screen
 *    still reports the span its samples actually cover.
 * 3. **Container samples need a non-empty `include` list.**
 *    `collectContainerMetrics` returns before it runs `docker stats` unless
 *    `metricsConfig.containers.services.include` has at least one entry, so a
 *    Server set up with the defaults collects host metrics and no container
 *    metrics, for ever. There is no "everything" value. Matching is by
 *    **substring** (`shouldMonitorContainer`), and only the *first* container per
 *    service name is kept.
 * 4. **The instance-wide counterpart collects, and this module now speaks it**.
 *    `POST /admin/setup-monitoring` used to store the platform host's config
 *    with nothing collecting against it, because jobs were registered per `server`
 *    row and the host has none. It registers under `serverId: null` now — the same
 *    "this machine" convention the `docker` and `traefik` routes already use — so
 *    it samples, raises threshold notifications, and stores rows that
 *    `GET /monitoring/metrics` reads back **without** a `serverId`.
 *
 *    So `setupWebServer` is declared below, and `serverId` is **optional** on both
 *    metrics reads: passing nothing asks about the web server. `null` and
 *    `undefined` both work, because `toSearchParams` drops either — which is what
 *    lets a caller hold "which host" as one nullable value and pass it straight
 *    through, the way `docker` and `traefik` callers already do.
 *
 *    **`setupWebServer` is an `/admin` route in a monitoring module, on purpose.**
 *    It lives on the admin controller, but what it configures is `MonitoringService`, its body is the same
 *    `metricsConfig` as the per-Server route, and every rule in note 1 and note 3
 *    applies to it word for word. Filing it by controller would put the two halves
 *    of one capability in two modules and leave whoever reads either one of them
 *    guessing about the other.
 *
 *    **Two differences from the per-Server route, both worth knowing.** It answers
 *    the sanitized `web_server_settings` row rather than a `server` row (there is
 *    no row for this machine, which is the whole reason for it), and it forces
 *    `type: 'Cloudgate'` where the per-Server route forces `'Remote'` — neither
 *    accepts the discriminator as input.
 *
 * ## What driving the instance-wide half taught
 *
 * **A host that cannot be measured stores nothing, rather than storing zeros.**
 * `SERVER_STATS_COMMAND` reads `/proc`, and it is a `;`-joined list whose last
 * member ends in `|| true` — so on a macOS or Windows platform host every section
 * comes back empty, the shell exits 0, and the parser answers a *well-formed*
 * sample of zeros: 0% CPU, no memory fitted, no disk. Those were once stored; now
 * they are not: `collectServerMetrics` drops a sample whose memory **and** disk totals are
 * both zero, before the insert and before the threshold check, and says so in the
 * backend log at most once every five minutes per host.
 *
 * The rule is deliberately the same shape as `isUnmeasured` in
 * `features/monitoring/live/units.ts`,
 * which had already been guarding the socket against the same quirk from the read
 * side: **the test is on the totals, not the values**, because a real host can sit
 * at 0% CPU with nothing on the network and calling that unmeasured would hide a
 * genuinely idle machine. Two guards, one definition.
 *
 * What that means for a screen: on such a host, setup succeeds, the jobs register,
 * and the history stays **empty for ever**. "Set up" and "has samples" are
 * therefore two different questions and a card has to answer both.
 */

/**
 * One sample, as `convertToSystemMetrics` formats it.
 *
 * **The numbers arrive as strings** — the Go agent's `fmt "%.2f"`, reproduced
 * verbatim over the float columns — so every one of them needs a `Number()` before
 * it can be plotted. `cpuCores`, `cpuPhysicalCores`, `cpuSpeed` and `uptime` are
 * the four that are already numbers, because the agent never formatted them.
 */
export interface ServerMetric {
  /** A percentage, `"12.40"`. Not `"12.40%"` — the unit is ours to add. */
  cpu: string;
  cpuModel: string;
  cpuCores: number;
  cpuPhysicalCores: number;
  /** MHz. */
  cpuSpeed: number;
  os: string;
  distro: string;
  kernel: string;
  arch: string;
  /** A percentage of memory in use. */
  memUsed: string;
  /** Gigabytes in use. */
  memUsedGB: string;
  /** Gigabytes fitted. */
  memTotal: string;
  /** Seconds since boot. */
  uptime: number;
  /** A percentage of the disk in use. */
  diskUsed: string;
  /** Gigabytes of disk, total. */
  totalDisk: string;
  /** Megabytes, cumulative since boot — a counter, not a rate. */
  networkIn: string;
  networkOut: string;
  timestamp: string;
}

/**
 * One container sample, as the agent's `processContainerMetrics` stores it.
 *
 * **The units are strings and they are not normalised.** `docker stats` prints
 * `MiB` / `GiB` and the collector relabels exactly those two to `MB` / `GB`;
 * `KiB` survives untouched, and its *value* parses to 0 because the trim cutset
 * is `MiBGiB`. Network and block units are stored verbatim. So a container using
 * 900 KiB reads `0 KiB` — a real reading of a real quirk, which is why nothing
 * here converts: a screen that turned these into bytes would have to invent the
 * definition the collector never chose.
 */
export interface ContainerMetric {
  /** A percentage. Already a number here, unlike `ServerMetric`. */
  CPU: number;
  Memory: {
    percentage: number;
    used: number;
    total: number;
    usedUnit: string;
    totalUnit: string;
  };
  Network: {
    input: number;
    output: number;
    inputUnit: string;
    outputUnit: string;
  };
  BlockIO: { read: number; write: number; readUnit: string; writeUnit: string };
  /** The container id — `Container` and `ID` are the same value. */
  Container: string;
  ID: string;
  /** The container's name, replica suffix and all: `redis-12sp3x.1.kyc0…`. */
  Name: string;
  timestamp: string;
}

/**
 * What `POST /monitoring/servers/:serverId/setup` **and**
 * `POST /admin/setup-monitoring` take. The whole config, every time — there is no
 * partial write, so a form has to send back what it did not change. Note 1 in this
 * file says which three fields change nothing.
 *
 * **One type for both routes because the two zod schemas are identical**, member
 * for member and refusal for refusal (`monitoring.dto.ts` and `admin.dto.ts` are
 * the same object with a different class name around it). That is checked rather
 * than assumed — `test/monitoring/setup-schemas-agree.spec.ts` — and
 * it is what lets one form serve both hosts.
 *
 * **It was not checked before, and they had diverged.** `token` was made
 * optional on the instance-wide schema and left it required on the per-Server
 * one, so this type's own three-case contract below was true of one of its two
 * routes: `toMetricsConfig` omits the field for any config it was not shown the
 * value of, and that shape then became reachable for a `server` row, at which
 * point the shared form would have built a body the per-Server route answered
 * `400` to. Both are optional now and the spec is what keeps them so.
 */
export interface MetricsConfigInput {
  server: {
    /** Seconds between samples. The route refuses anything under 2. */
    refreshRate: number;
    /** Refused below 1. Stored for an external agent; nothing here reads it. */
    port: number;
    /**
     * Non-empty is what turns collection on.
     *
     * **Three cases, and `undefined` is one of them.** Omitted keeps whatever
     * the host has stored — which is how a change is saved to a host whose token
     * the route projected out of the read (`MetricsConfig`); `''` clears it,
     * which is the only way to stop collecting; anything else sets or rotates
     * it. `toMetricsConfig` picks between them.
     */
    token?: string;
    /** Must parse as a URL (`z.url()`), including when it is doing nothing. */
    urlCallback: string;
    /** Days. The cleanup cron deletes samples older than this. */
    retentionDays: number;
    /** A cron expression for that cleanup. Refused empty. */
    cronJob: string;
    /** Percentages. `0` means "do not alert on this one" (`ThresholdService`). */
    thresholds: { cpu: number; memory: number };
  };
  containers: {
    refreshRate: number;
    /** `include` must be non-empty or nothing is collected. Substring matches. */
    services: { include?: string[]; exclude?: string[] };
  };
}

/**
 * How much of a Server's history a metrics read is asking for.
 *
 * `limit` and the two bounds are one decision, made server-side in
 * `parseMetricsRange`, and it is not the composition most people would guess:
 *
 * - **Neither bound** — the last `limit` samples, whatever their timestamps.
 *   `limit` defaults to 50 and *falls back* to 50 for anything unparsable rather
 *   than refusing; `"all"` means no cap. This is the original behaviour, unchanged.
 * - **A bound and no `limit`** — no sample cap at all. The window is the bound, so
 *   asking for six hours of a host sampled every five seconds really does answer
 *   4,320 samples. Quietly capping that at 50 would answer a different question
 *   than the one asked, which is the defect the window exists to fix.
 * - **A bound and a `limit`** — the window filters and `limit` caps, keeping the
 *   **most recent** samples inside the window. Still returned oldest-first.
 * - **One bound only** — the other end is open.
 *
 * Both bounds are **inclusive**, and both must be RFC3339 —
 * `2026-07-24T02:00:00Z`. A bare date is **refused with a 400**, deliberately: for
 * `start` it would have to mean midnight and for `end` the end of the day, and a
 * parameter meaning two things is not one a caller can rely on. A bound with no
 * zone is read as **UTC**, which is the scale the samples are stored on. `end`
 * before `start` is a 400 too.
 */
export interface MetricsWindow {
  /** `"50"`, `"200"`, `"all"` — the agent's own query semantics. */
  limit?: string;
  /** Inclusive RFC3339 lower bound. */
  start?: string;
  /** Inclusive RFC3339 upper bound. */
  end?: string;
}

/** One hour of `RequestsRead.hours`: an ISO hour and its count. */
export interface RequestStatsPoint {
  /** `2026-08-05T14:00:00Z` — UTC, always on the hour. */
  hour: string;
  count: number;
}

/**
 * One line of Traefik's access log, as the parser hands it back.
 *
 * Traefik writes ~40 fields per line and this declares the ones the table
 * renders plus the ones the API filters on. The rest come down and are ignored
 * on purpose: a type that named all forty would imply the screen had decided
 * what to do with them.
 *
 * `Duration`, `OriginDuration` and `Overhead` are **nanoseconds**.
 * `DownstreamStatus` is `0` on a request Traefik never got an answer for.
 *
 * **The optional fields are keys Traefik leaves out, not ones that arrive
 * empty**: a request with no `Host` header has no `RequestHost`, one no
 * router matched has no `RouterName`, one no service answered has no
 * `ServiceName` or `Origin*`. The backend's `LogEntry` says the same, and a
 * template string over one of these renders the word `undefined`.
 */
export interface RequestLogEntry {
  RequestHost?: string;
  RequestPath?: string;
  RequestMethod: string;
  RequestProtocol: string;
  RequestScheme: string;
  RequestAddr: string;
  DownstreamStatus: number;
  DownstreamContentSize: number;
  OriginStatus?: number;
  /** Nanoseconds. */
  Duration: number;
  /** Nanoseconds. */
  OriginDuration?: number;
  /** Nanoseconds. */
  Overhead: number;
  RetryAttempts: number;
  ClientHost: string;
  ClientAddr: string;
  ServiceName?: string;
  RouterName?: string;
  entryPointName: string;
  /** Traefik names a kept header `request_<Header>` in its own spelling, hyphen included. */
  "request_User-Agent"?: string;
  /** The one the parser sorts and ranges on. RFC3339 with a zone. */
  StartUTC: string;
  StartLocal: string;
  time: string;
  level: string;
}

/**
 * The five status *classes* `isStatusInRange` understands. Not codes — there is
 * no way to ask for 404 on its own.
 */
export type RequestStatusClass =
  | "info"
  | "success"
  | "redirect"
  | "client"
  | "server";

/** The Service a Server's log line belongs to, by its Domain. */
export interface RequestService {
  serviceId: string;
  name: string;
}

/**
 * One row of `GET /monitoring/requests`. `service` is the Service whose
 * Domain the line matched, or `null` for a line that matched none — which
 * only a `server: ['read']` holder is ever sent on a Server, and only the
 * Instance organization's authority on the platform host (ADR-0061). Query
 * values in `RequestPath` arrive as `***`, their names kept.
 */
export type RequestRow = RequestLogEntry & { service?: RequestService | null };

/**
 * How a read went. Only `ok` carries lines; the others are answered instead
 * of an empty read, so no lines is never "0 requests":
 * `unreachable` (SSH failed), `logging-off` (no `accessLog` block in the
 * Server's traefik.yml), `awaiting-restart` (the block is there, the file is
 * not), `empty` (the file has no lines) and `too-slow` (stopped at 10 s).
 */
export type RequestsReadState =
  | "ok"
  | "unreachable"
  | "logging-off"
  | "awaiting-restart"
  | "empty"
  | "too-slow";

/** `GET /monitoring/requests`: one live read of one Access log. */
export interface RequestsRead {
  state: RequestsReadState;
  /** Which log: a Server, or the platform host (`serverId: null`). */
  target: { serverId: string | null; name: string };
  /**
   * Whether the caller may turn this log on or off: owner or admin of the
   * Server's Organization; instance authority on the platform host, where
   * anyone else is told to ask the Instance organization's owners or admins.
   */
  canSwitchLogging: boolean;
  /** When the read happened, ISO. */
  readAt: string;
  /** One page, newest first. */
  data: RequestRow[];
  /** Every row the caller may see in the window and filters. */
  totalCount: number;
  /** Those same rows per UTC hour; hours with none are absent. */
  hours: RequestStatsPoint[];
  /** How far back the read reached, when it fell short of the window. */
  retainedFrom?: string;
  /**
   * The Service filter's options: the Services on this Server, or on the
   * platform host, the caller may read, by name.
   */
  services: RequestService[];
  /**
   * Whether "No Service" is an option: `server: ['read']` on this Server,
   * instance authority on the platform host.
   */
  noService: boolean;
  /**
   * Whether the caller sees every line on this Server, whatever the filter:
   * the filter's "All", or "All yours" when false.
   */
  wholeServer: boolean;
  /** What the totals count. */
  covers: RequestsCoverage;
  /**
   * Lines withheld because their host, held on the platform host by a
   * Service this read covers, is held there by another Organization too
   * (ADR-0061). Always 0 on a Server.
   */
  withheldShared: number;
}

/**
 * What a read's totals count: the whole Server; only the Services the caller
 * may read, because some of its lines are not theirs ("to your Services");
 * the Services picked in the filter ("to the chosen Services"); or, on a
 * Service's Requests tab, that one Service.
 */
export type RequestsCoverage =
  | "server"
  | "your-services"
  | "chosen-services"
  | "service";

/**
 * `GET /monitoring/requests/services/:serviceId`: a Service's Requests tab.
 * Its Server's read, or the platform host's, with the Service filter fixed to
 * it — or `cloud-account` for a Service in a Cloud account, whose requests
 * are in the cloud's own load balancer or CDN logs.
 */
export type ServiceRequestsRead =
  | RequestsRead
  | {
      state: "cloud-account";
      service: RequestService;
    };

/** Its query: a read's window and filters, with no Server or Service filter. */
export type ServiceRequestsReadQuery = Omit<
  RequestsReadQuery,
  "serverId" | "serviceId" | "noService"
>;

/** Its query, which is also its key. */
export interface RequestsReadQuery {
  /**
   * A Server; absent reads the platform host (instance authority, or the
   * lines of the caller's own Services there).
   */
  serverId?: string;
  start: string;
  end: string;
  pageIndex?: number;
  pageSize?: number;
  search?: string;
  status?: RequestStatusClass[];
  method?: string[];
  /** The Service filter: any of these Services. Neither this nor `noService` is every line. */
  serviceId?: string[];
  /** The Service filter: lines that matched no Domain. */
  noService?: boolean;
}

/** `GET /monitoring/requests/servers`: the Server picker's entries. */
export interface RequestsTargets {
  servers: { serverId: string; name: string }[];
  /**
   * Whether the platform host is one more entry: instance authority, or a
   * Service there the caller may read.
   */
  platformHost: boolean;
  /** Whether the caller can read a Service that runs in a Cloud account. */
  cloudAccountServices: boolean;
}

export const monitoringApi = {
  /**
   * Samples for one host, **oldest first** — which is the order a plot wants,
   * and the reason the service reverses its own descending read rather than
   * making every caller do it.
   *
   * **`serverId` is a Server's id, or nothing at all for the web server** — the
   * machine Cloudgate itself runs on, which has no `server` row and so no id to
   * name (note 4). `null` and `undefined` are the same request here; the
   * client drops both from the query string, and the route reads an absent
   * `serverId` as this machine. It is `.min(1)` when present, so an **empty
   * string is a 400** rather than a quiet answer about the wrong host.
   *
   * `request` is a count, a time range, or both; `MetricsWindow` above has the
   * composition rules and the two ways it answers 400. An unknown Server is a 404
   * from the org-scoped lookup. The web server is not org-scoped — it is one
   * machine shared by every Organization, so the route's `monitoring:read` in the
   * caller's own Organization is the whole gate.
   */
  serverMetrics: (
    serverId: string | null | undefined,
    request: MetricsWindow = {},
  ) =>
    api.get<ServerMetric[]>("/monitoring/metrics", {
      query: { serverId, ...request },
    }),

  /**
   * One service's container samples on one host, oldest first. `serverId` is
   * optional in exactly the sense it is above: nothing means the web server.
   *
   * `appName` is matched against the stored container name **exactly or by its
   * Swarm task suffix** (`name` or `name.%`), which is why it takes a service
   * name rather than a container id. A missing or empty `appName` is refused
   * with a 400 by the DTO, and a name that resolves to no service is refused
   * with a 400 naming it — so `[]` means only "no samples in this
   * window", which is what the empty state below is written for.
   *
   * Nothing is stored at all unless that host's `include` list matched
   * something when the sample was taken; see note 3.
   *
   * A `start`/`end` window narrows the samples the same way it does above, and
   * **narrows only those** — it never changes which service `appName` resolves to.
   */
  containerMetrics: (
    serverId: string | null | undefined,
    appName: string,
    request: MetricsWindow = {},
  ) =>
    api.get<ContainerMetric[]>("/monitoring/metrics/containers", {
      query: { serverId, appName, ...request },
    }),

  /**
   * Turn collection on for a Server, or change how it collects.
   *
   * Answers the updated `server` row **sanitized**, like the
   * `setupWebServer` twin below: `metricsConfig.server.hasToken` stands where
   * the credential was, which is the fact the screen needs and the only fact it
   * ever took off this body (`isCollecting`, and `useSetupMonitoring` re-reads
   * the row on `onSettled` regardless). This route once echoed the raw token —
   * harmless while `token` was a required field, since the response then
   * only repeated what the request had just carried, and a disclosure the
   * moment an omitted `token` came to mean *keep what is stored*. See
   * `MetricsConfig` in `endpoints/servers.ts` for the route split.
   *
   * `registerServer` runs synchronously inside the request, so the row coming
   * back means the intervals exist — but the *first sample* is up to
   * `refreshRate` seconds away, and that is a different thing to say.
   */
  setupServer: (serverId: string, metricsConfig: MetricsConfigInput) =>
    api.post<Server>(`/monitoring/servers/${serverId}/setup`, {
      metricsConfig,
    }),

  /**
   * Turn collection on for **the web server** — the machine Cloudgate runs on —
   * or change how it collects. Note 4 says why this route is declared here.
   *
   * **Instance authority** (`checkInstanceAuthority`, H-63 of ADR-0013), unlike
   * the per-Server route, which is `monitoring:write` in the Organization. That
   * is the right gate for it: the platform host is not any one Organization's,
   * and its threshold breaches notify instance-wide.
   *
   * Answers the **sanitized** `web_server_settings` row — that singleton carries
   * two secrets, the instance's SSH private key and the metrics agent token, and
   * this route projects out both (and the token with it). `metricsConfig`
   * on that row is what a screen wants back, with `server.hasToken` standing in
   * for the credential: that flag is the only way to know collection is
   * registered, and on a `server` row the same fact is a non-empty `token`.
   *
   * As with the per-Server route, the jobs are registered synchronously inside
   * the request, so a response means the intervals exist. It does **not** mean a
   * sample is coming: the first is up to `refreshRate` seconds away, and on a
   * platform host with no `/proc` there will never be one at all (note 4).
   */
  setupWebServer: (metricsConfig: MetricsConfigInput) =>
    api.post<{ metricsConfig: MetricsConfigInput | null }>(
      "/admin/setup-monitoring",
      { metricsConfig },
    ),

  /**
   * The Requests page's Server picker: every Server where the caller can read
   * at least one Service, or holds `server: ['read']`, whether or not its
   * logging is on, sorted by name. Reaches no Server.
   */
  requestTargets: () =>
    api.get<RequestsTargets>("/monitoring/requests/servers"),

  /**
   * One live read of a Server's Access log over SSH, split by Service — or of
   * the platform host's, when `serverId` is absent. A Server the caller may
   * not read answers 404, the same as one that does not exist.
   */
  readRequests: (query: RequestsReadQuery) =>
    api.get<RequestsRead>("/monitoring/requests", { query: { ...query } }),

  /**
   * A Service's Requests tab: the backend finds the Service's Server itself,
   * so the tab's address needs none. A Service the caller may not read, a
   * Database and any other id answer 404.
   */
  readServiceRequests: (serviceId: string, query: ServiceRequestsReadQuery) =>
    api.get<ServiceRequestsRead>(
      `/monitoring/requests/services/${encodeURIComponent(serviceId)}`,
      { query: { ...query } },
    ),
};
