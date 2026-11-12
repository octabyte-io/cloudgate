import type {
  ErrorRateThreshold,
  Incident,
  IncidentCloseReason,
  UptimeCheck,
  UptimeCheckHealth,
} from "@/lib/api/endpoints/service-health";
import type { Mark } from "@/lib/design/status";

/**
 * The Health tab's words for what the backend records as codes, in one place so
 * the banner, the checks and the history cannot say one thing three ways.
 */

/** The backend's own labels (`SERVICE_INCIDENT_REASON_LABELS`), so a Slack message and this tab agree. */
export const CLOSE_REASON_LABELS: Record<IncidentCloseReason, string> = {
  recovered: "Recovered",
  "service-stopped": "Service stopped",
  "turned-off": "Turned off",
  "port-unpublished": "Port no longer published",
};

/**
 * A Probe's error class as a sentence fragment. The classes are
 * `classifyProbeError`'s closed set plus `status NNN`; anything newer (such as
 * `keyword missing`) reads as the backend wrote it rather than as nothing.
 */
export function probeErrorWords(errorClass: string | null): string | null {
  if (!errorClass) return null;
  const status = /^status (\d{3})$/.exec(errorClass);
  if (status) return `Answered ${status[1]}`;
  switch (errorClass) {
    case "timeout":
      return "Timed out";
    case "dns":
      return "DNS lookup failed";
    case "refused":
      return "Connection refused";
    case "tls":
      return "TLS handshake failed";
    case "connection":
      return "Connection failed";
    default:
      return errorClass.charAt(0).toUpperCase() + errorClass.slice(1);
  }
}

/**
 * What a check aims at, as the message about it names it: the Domain's URL for
 * HTTP. Checks have no name, so this is how a row, a banner line and an
 * Incident all say which check they mean.
 */
export function checkTargetLabel(
  check: Pick<UptimeCheck, "target" | "tcpTarget" | "kind">,
): string {
  if (check.target) return check.target.url;
  if (check.tcpTarget) return `tcp://${check.tcpTarget.address}`;
  return check.kind === "tcp" ? "A TCP port" : "A check with no target";
}

/**
 * What owns an Incident, as a row names it: the check's target among the
 * Service's checks, or the Error rate for the threshold's.
 */
export function incidentTarget(
  incident: Pick<Incident, "uptimeCheckId" | "source">,
  checks: readonly UptimeCheck[],
): string {
  if (incident.source === "error-rate-threshold") return "Error rate";
  const check = checks.find(
    (candidate) => candidate.uptimeCheckId === incident.uptimeCheckId,
  );
  return check ? checkTargetLabel(check) : "An Uptime check";
}

/** The banner's line for an open Incident: what is wrong, in a few words. */
export function incidentTitle(
  incident: Pick<Incident, "uptimeCheckId" | "source">,
  checks: readonly UptimeCheck[],
): string {
  return incident.source === "error-rate-threshold"
    ? "The Error rate is over its threshold"
    : `${incidentTarget(incident, checks)} is down`;
}

/**
 * What opened an Incident: a check's Probe error in words, or the threshold's
 * opening window (`12.5 % of 40 requests answered 5xx`) and, once it grew,
 * the worst rate while open.
 */
export function incidentOpening(
  incident: Pick<
    Incident,
    "source" | "openingError" | "openingErrorRate" | "openingRequests" | "worstErrorRate"
  >,
): string | null {
  if (incident.source !== "error-rate-threshold") {
    return probeErrorWords(incident.openingError);
  }
  if (incident.openingErrorRate === null || incident.openingRequests === null) {
    return null;
  }
  const opening = `${rateWords(incident.openingErrorRate)} of ${requestsLabel(incident.openingRequests)} answered 5xx`;
  return incident.worstErrorRate !== null &&
    incident.worstErrorRate > incident.openingErrorRate
    ? `${opening}, worst ${rateWords(incident.worstErrorRate)}`
    : opening;
}

/** `40` → `"40 requests"`, `1` → `"1 request"`. */
export function requestsLabel(requests: number): string {
  return `${requests.toLocaleString()} ${requests === 1 ? "request" : "requests"}`;
}

/**
 * A fraction as a percentage to a tenth — `0.125` → `"12.5 %"` — the backend's
 * `rateWords`, so the tab and the Notification say one number one way.
 */
export function rateWords(rate: number): string {
  return `${Math.round(rate * 1000) / 10} %`;
}

/** `{5, 5}` → `"5 % over 5 minutes"`: the threshold as its Notification says it. */
export function thresholdWords(
  threshold: Pick<ErrorRateThreshold, "percentage" | "windowMinutes">,
): string {
  return `${threshold.percentage} % over ${minutesLabel(threshold.windowMinutes)}`;
}

/** `1` → `"1 minute"`, `15` → `"15 minutes"`. */
export function minutesLabel(minutes: number): string {
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * A check's state as one mark: off beats everything (it is not probed, so its
 * last verdict is history), then the last Probe's verdict, then "not probed
 * yet" for a check whose first Probe has not landed.
 */
export function checkMark(
  check: Pick<UptimeCheckHealth, "enabled" | "lastProbe">,
): Mark {
  if (!check.enabled) return { glyph: "⊘", tone: "mute", label: "off" };
  if (!check.lastProbe) return { glyph: "○", tone: "mute", label: "not probed yet" };
  return check.lastProbe.verdict === "up"
    ? { glyph: "●", tone: "ok", label: "up" }
    : { glyph: "✕", tone: "bad", label: "down" };
}

/** `["2xx", "301"]` → `"2xx, 301"`. */
export function expectedStatusesLabel(statuses: readonly string[]): string {
  return statuses.join(", ");
}

/** `"2xx, 301 401"` → `["2xx", "301", "401"]`: commas or spaces, either. */
export function parseExpectedStatuses(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/** `90` → `"1m 30s"`, `3600` → `"1h"`, for an interval or a timeout. */
export function secondsLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

/** Said on every check, because every check has exactly this one vantage. */
export const VANTAGE_LINE = "Checked from the platform host";
export const VANTAGE_HINT =
  "One vantage point: up means the platform host reached it, not that it is reachable from everywhere on the internet.";
