import { api } from "../client";

import type { ServiceType } from "./applications";

/**
 * `service-health/*.controller.ts` — a Service's Uptime checks,
 * its Probes' verdicts, its Error rate and its Incidents, read by anyone who may read the
 * Service and configured by anyone who may update it (`service: ['update']`). `monitoring:
 * ['read']` has nothing to do with any of it.
 *
 * **Three controllers, one screen.** `/uptime-checks` is the four writes and a
 * list; `/error-rate-thresholds/:serviceId` gets, puts and deletes the one
 * Error-rate threshold; `/service-health/:serviceType/:serviceId` is the Health tab's one read
 * — every check with its last Probe and 24-hour strip, the open Incidents and a
 * page of Incident history. The tab reads the summary only: the list route
 * answers the same checks without their Probes.
 *
 * A Service is named by `serviceType` + `serviceId`, `mounts`' shape, so one
 * set of routes serves all seven kinds. A database's `serviceType` is its
 * engine (`postgres`, `redis`, …), which is the `DatabaseKind` in its URL.
 */

/** An HTTP `GET` of a Domain, or a TCP connect to a published port. */
export type UptimeCheckKind = "http" | "tcp";

export type ProbeVerdict = "up" | "down";

/**
 * Why an Incident closed. `null` while it is open. `port-unpublished` is a TCP
 * check Cloudgate turned off because its port is no longer published.
 */
export type IncidentCloseReason =
  | "recovered"
  | "service-stopped"
  | "turned-off"
  | "port-unpublished";

/** The Domain an HTTP check probes, resolved from the Domain row every read. */
export interface UptimeCheckTarget {
  domainId: string;
  host: string;
  path: string | null;
  https: boolean;
  /** Exactly what is requested: scheme, host and path. */
  url: string;
}

/** The published port a TCP check dials, on its Server's address. */
export interface UptimeCheckTcpTarget {
  host: string;
  port: number;
  /** `host:port` — what the console and a Notification call it. */
  address: string;
}

/**
 * `UptimeCheckView` — a check's definition. **Never the header value**
 * it is write-only, and `hasHeaderValue` is all a read says about it.
 */
export interface UptimeCheck {
  uptimeCheckId: string;
  serviceType: ServiceType;
  serviceId: string;
  kind: UptimeCheckKind;
  /** An HTTP check's Domain; `null` for a TCP check. */
  target: UptimeCheckTarget | null;
  /** A TCP check's published port; `null` for an HTTP check. */
  tcpTarget: UptimeCheckTcpTarget | null;
  intervalSeconds: number;
  timeoutSeconds: number;
  /** Classes (`2xx`) or exact codes (`301`). */
  expectedStatuses: string[];
  /** How many downs in a row open an Incident. */
  downAfter: number;
  enabled: boolean;
  /**
   * Why Cloudgate turned the check off, as a sentence — today only that its
   * port is no longer published. `null` when it is on or the operator
   * turned it off.
   */
  disabledReason: string | null;
  createdAt: string;
  /** A string an HTTP check's body must contain; a body without it is down. */
  keyword: string | null;
  /** The one header an HTTP check sends, by name. */
  headerName: string | null;
  /** Whether a header value is stored. The value itself never comes back. */
  hasHeaderValue: boolean;
}

/** One Probe: never a body, only the verdict and a short error class. */
export interface Probe {
  probedAt: string;
  verdict: ProbeVerdict;
  latencyMs: number | null;
  /** `timeout`, `dns`, `refused`, `tls`, `connection`, `status NNN` or `keyword missing`. */
  errorClass: string | null;
}

/** Half an hour of the 24-hour strip. Both zero is "not probed". */
export interface StripBucket {
  start: string;
  up: number;
  down: number;
}

/** A check as the summary answers it. */
export interface UptimeCheckHealth extends UptimeCheck {
  lastProbe: Probe | null;
  /** 48 half-hour buckets, oldest first; the last is the one now is in. */
  strip: StripBucket[];
  /** Up Probes over all Probes in the last 24 hours; `null` with none. */
  upShare24h: number | null;
}

export interface Incident {
  incidentId: string;
  /** What opened it: an Uptime check or the Error-rate threshold. */
  source: "uptime-check" | "error-rate-threshold";
  uptimeCheckId: string | null;
  errorRateThresholdId: string | null;
  openedAt: string;
  closedAt: string | null;
  /** Closed ones only. */
  durationSeconds: number | null;
  /** A check's: the opening Probe's error class. */
  openingError: string | null;
  /** A threshold's: the opening window's Error rate, a fraction. */
  openingErrorRate: number | null;
  /** A threshold's: the opening window's request count. */
  openingRequests: number | null;
  /** A threshold's: the worst judged window's rate while open. */
  worstErrorRate: number | null;
  closeReason: IncidentCloseReason | null;
}

/** The windows a threshold is judged over, in minutes. */
export const ERROR_RATE_THRESHOLD_WINDOWS = [1, 5, 15, 30] as const;

/**
 * `ErrorRateThresholdView` — a Service's one Error-rate threshold.
 * Only an Application or a Compose can have one; a database is refused.
 */
export interface ErrorRateThreshold {
  errorRateThresholdId: string;
  serviceType: "application" | "compose";
  serviceId: string;
  /** A percent: 5 is 5 %. */
  percentage: number;
  windowMinutes: number;
  /** Below this many requests in the window, nothing is judged. */
  minRequests: number;
  enabled: boolean;
  createdAt: string;
}

/** `PUT`'s body: the whole rule, created or replaced. */
export type PutErrorRateThresholdInput = Pick<
  ErrorRateThreshold,
  "percentage" | "windowMinutes" | "minRequests" | "enabled"
>;

export interface PageMeta {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Why a Service has no Error rate — the backend's closed set
 * (`ERROR_RATE_UNAVAILABLE`), each with the sentence the console shows as it
 * is. None of them is 0 %.
 */
export type ErrorRateUnavailableReason =
  | "database"
  | "no-domain"
  | "metrics-not-enabled"
  | "no-samples";

/** Summed request deltas; a share is `null` when there were no requests. */
export interface ErrorRateTotals {
  requests: number;
  /** Answered 5xx — by the app, or by Traefik with the containers down. */
  errors: number;
  /** Slower than 1.2 s. */
  slow: number;
  errorRate: number | null;
  slowShare: number | null;
}

/**
 * A Service's Error rate over the last 24 hours (ADR-0027), read from
 * its Server's Traefik counters — or the reason it has none.
 */
export type ErrorRate =
  | {
      available: false;
      reason: ErrorRateUnavailableReason;
      /** Shown verbatim. */
      message: string;
    }
  | {
      available: true;
      /** Start of the window. */
      since: string;
      lastCollectedAt: string;
      totals: ErrorRateTotals;
      /** 96 quarter-hours, oldest first; the last is the one now is in. */
      series: (ErrorRateTotals & { start: string })[];
      /** Every Domain of the Service, host order. */
      domains: (ErrorRateTotals & { domainId: string; host: string })[];
    };

/** `GET /service-health/:serviceType/:serviceId`. */
export interface ServiceHealth {
  serviceType: ServiceType;
  serviceId: string;
  /** The Overview's fact line; the Health column's rule. */
  state: ServiceHealthState;
  uptimeChecks: UptimeCheckHealth[];
  errorRate: ErrorRate;
  /** The Service's one Error-rate threshold, or `null`. */
  errorRateThreshold: ErrorRateThreshold | null;
  /** At most one per check and one for the threshold, newest first. */
  openIncidents: Incident[];
  /** Every Incident, open ones included, newest first. */
  incidents: { items: Incident[]; meta: PageMeta };
}

/**
 * A Service's worst current health, decided by the backend's
 * `worstState` alone so the Overview and the Health column cannot disagree:
 * `incident` (an Incident is open) › `down` (an enabled check's last Probe was
 * down, no Incident yet) › `pending` (an enabled check not probed yet) › `up`
 * › `unchecked` (no enabled check, or the Service is Stopped).
 */
export type ServiceHealthState =
  | "incident"
  | "down"
  | "pending"
  | "up"
  | "unchecked";

/** One Service's row in `GET /environments/:id/health`. */
export interface ServiceHealthRow {
  serviceType: ServiceType;
  serviceId: string;
  state: ServiceHealthState;
  openIncident: boolean;
  openIncidents: number;
  /** The oldest open Incident's `openedAt`; `null` with none open. */
  openSince: string | null;
}

/**
 * `GET /environments/:id/health` — the Services table's Health column in one
 * request. Only the Services the caller may see, as `GET /environments/:id`'s
 * `services` names them.
 */
export interface EnvironmentHealth {
  environmentId: string;
  services: ServiceHealthRow[];
}

/** The rule a check probes by. The owner and kind are fixed for its life. */
export interface UptimeCheckRule {
  intervalSeconds: number;
  timeoutSeconds: number;
  expectedStatuses: string[];
  downAfter: number;
  enabled: boolean;
}

/** What only an HTTP check has. */
export interface HttpCheckExtras {
  /** `null` clears it. */
  keyword: string | null;
  /** `null` removes the header, value and all. */
  headerName: string | null;
  /**
   * **Write-only.** A string replaces the stored value, `null` removes it,
   * and leaving it out keeps it.
   */
  headerValue: string | null;
}

export type CreateUptimeCheckInput =
  | (UptimeCheckRule &
      Partial<HttpCheckExtras> & {
        serviceType: ServiceType;
        serviceId: string;
        kind: "http";
        /** One of the Service's own Domains — never a URL. */
        domainId: string;
      })
  | (Omit<UptimeCheckRule, "expectedStatuses"> & {
      serviceType: ServiceType;
      serviceId: string;
      kind: "tcp";
      /** One of the Service's published TCP ports. */
      port: number;
    });

export type UpdateUptimeCheckInput = Partial<
  UptimeCheckRule & HttpCheckExtras & { domainId: string; port: number }
>;

/** One published TCP port a check may dial. */
export interface PublishedPort {
  port: number;
  /** "Database", "Container port 22", "redis → 6379". */
  label: string;
}

/** `GET /uptime-checks/published-ports` — the TCP picker's options. */
export interface PublishedPorts {
  /** The address a TCP check on this Service dials. */
  host: string;
  ports: PublishedPort[];
  /** Why there is nothing to dial, and how to publish a port; `null` when there is. */
  unavailableReason: string | null;
}

export const serviceHealthApi = {
  summary: (
    serviceType: ServiceType,
    serviceId: string,
    page: { page: number; limit: number },
  ) =>
    api.get<ServiceHealth>(`/service-health/${serviceType}/${serviceId}`, {
      query: page,
    }),

  /** Every visible Service in one Environment, in one request. */
  environment: (environmentId: string) =>
    api.get<EnvironmentHealth>(`/environments/${environmentId}/health`),

  /** The ports a TCP check on this Service may dial. */
  publishedPorts: (serviceType: ServiceType, serviceId: string) =>
    api.get<PublishedPorts>("/uptime-checks/published-ports", {
      query: { serviceType, serviceId },
    }),

  createCheck: (input: CreateUptimeCheckInput) =>
    api.post<UptimeCheck>("/uptime-checks", input),

  /** Turning a check off closes its open Incident with `turned-off`. */
  updateCheck: (uptimeCheckId: string, input: UpdateUptimeCheckInput) =>
    api.patch<UptimeCheck>(`/uptime-checks/${uptimeCheckId}`, input),

  /** Its Probes and Incidents go with it, and nothing is announced. */
  removeCheck: (uptimeCheckId: string) =>
    api.delete<UptimeCheck>(`/uptime-checks/${uptimeCheckId}`),

  /**
   * Creates the threshold or replaces its whole rule. Turning it off closes
   * its open Incident with `turned-off`; a database is refused.
   */
  putThreshold: (
    serviceType: ServiceType,
    serviceId: string,
    input: PutErrorRateThresholdInput,
  ) =>
    api.put<ErrorRateThreshold>(`/error-rate-thresholds/${serviceId}`, input, {
      query: { serviceType },
    }),

  /** Its Incidents go with it, and nothing is announced. */
  removeThreshold: (serviceType: ServiceType, serviceId: string) =>
    api.delete<ErrorRateThreshold>(`/error-rate-thresholds/${serviceId}`, {
      query: { serviceType },
    }),
};
