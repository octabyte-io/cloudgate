import type { BucketBudget } from '../../mcp/rate-bucket';
import { formatEventTime } from './event-time';

/**
 * The events that fan out to an organization's notification channels, as
 * one discriminated union. Each event type maps to the notification-row flag
 * that opts a channel into it (EVENT_FLAG_COLUMNS).
 *
 * instance-restart fires from main.ts bootstrap and docker-cleanup from its
 * settings-module cron; nothing dispatches instance-backup yet, because
 * there is no web-server backup to call it.
 */

/**
 * A domain a deployed application is reachable on — the custom webhook's
 * `domains` string and telegram's domain buttons.
 */
export interface DeployedDomain {
  host: string;
  https: boolean | null;
}

/** A successful build. buildLink comes from the
 * web-server settings instance URL and stays optional — link fields are
 * omitted while no host/serverIp is configured.
 *
 * `domains` is filled by `DeploymentNotifierAdapter.deployedDomains`, which
 * is the only producer there is. It stays optional for the channels' sake,
 * not the producer's: both readers already spell `event.domains ?? []`, and
 * that is what renders "no domains" as nothing at all rather than as an empty
 * label. Until it was fixed there was no producer, so the field was
 * empty on every channel of every install rather than in some case — if you
 * are adding a second producer, it carries the domains or the promise the
 * event's own description makes goes back to being false. */
export interface AppDeployEvent {
  type: 'app-deploy';
  projectName: string;
  applicationName: string;
  applicationType: string;
  environmentName: string;
  buildLink?: string;
  domains?: readonly DeployedDomain[];
}

/** A failed build. */
export interface AppBuildErrorEvent {
  type: 'app-build-error';
  projectName: string;
  applicationName: string;
  applicationType: string;
  errorMessage: string;
  buildLink?: string;
}

/** A database backup's outcome. The engine name is
 * interpolated verbatim, so it stays a plain string (backup rows carry the
 * backup schema's database_type values). */
export interface DatabaseBackupEvent {
  type: 'database-backup';
  projectName: string;
  applicationName: string;
  databaseType: string;
  status: 'success' | 'error';
  databaseName: string;
  errorMessage?: string;
}

/** A volume backup's outcome. */
export interface VolumeBackupEvent {
  type: 'volume-backup';
  projectName: string;
  applicationName: string;
  volumeName: string;
  serviceType: string;
  status: 'success' | 'error';
  errorMessage?: string;
  backupSize?: string;
}

/** A completed docker cleanup run. */
export interface DockerCleanupEvent {
  type: 'docker-cleanup';
  message: string;
}

/**
 * A Server's CPU or memory **Server threshold** breach: announced once
 * when it opens and once when it closes, never per sample. Both are this one
 * event under the one `serverThreshold` flag, so a channel opted into the
 * alert also hears that it is over. An event with no `close` is the opening
 * alert — and is also all the token-authenticated receive endpoint for
 * external agents sends, since it reports only breaches.
 *
 * `value` is the sample that opened or closed it, `threshold` the setting
 * that sample was compared against: on a `turned-off` close that is 0, which
 * the channels render as {@link describeServerThreshold} says.
 */
export interface ServerThresholdEvent {
  type: 'server-threshold';
  serverName: string;
  metric: 'CPU' | 'Memory';
  value: number;
  threshold: number;
  message: string;
  timestamp: string;
  /** Set when the breach closed; absent on the opening alert. */
  close?: ServerThresholdClose;
}

/** Why a Server threshold's breach closed. A deleted Server announces nothing. */
export type ServerThresholdCloseReason = 'recovered' | 'turned-off';

/** How a Server threshold's breach ended. */
export interface ServerThresholdClose {
  reason: ServerThresholdCloseReason;
  /** When the breach opened, ISO-8601. */
  breachedSince: string;
}

/**
 * The Notification's title, `Server CPU Alert` on the open as it always was,
 * and ASCII like every title here.
 */
export function serverThresholdTitle(event: ServerThresholdEvent): string {
  if (!event.close) return `Server ${event.metric} Alert`;
  return event.close.reason === 'recovered'
    ? `Server ${event.metric} Recovered`
    : `Server ${event.metric} Alert Turned Off`;
}

/** `80.00%`, or `Off` for the 0 a turned-off close carries. */
export function describeServerThreshold(event: ServerThresholdEvent): string {
  return event.threshold > 0 ? `${event.threshold.toFixed(2)}%` : 'Off';
}

/** Each close reason in the words a person reads. */
export const SERVER_THRESHOLD_REASON_LABELS: Record<
  ServerThresholdCloseReason,
  string
> = {
  recovered: 'Recovered',
  'turned-off': 'Turned off',
};

/**
 * The facts a close adds after the opening alert's, in order — none on the
 * open, so the opening alert reads exactly as it did before closes were
 * announced.
 */
export function serverThresholdCloseFacts(
  event: ServerThresholdEvent,
): { label: string; value: string }[] {
  if (!event.close) return [];
  return [
    {
      label: 'Breached Since',
      value: formatEventTime(new Date(event.close.breachedSince)),
    },
    { label: 'Why', value: SERVER_THRESHOLD_REASON_LABELS[event.close.reason] },
  ];
}

/** The Cloudgate instance's own backup outcome. */
export interface InstanceBackupEvent {
  type: 'instance-backup';
  status: 'success' | 'error';
  errorMessage?: string;
  backupSize?: string;
}

/** The Cloudgate instance restarted (no payload). */
export interface InstanceRestartEvent {
  type: 'instance-restart';
}

/**
 * One member a lapsed license locked out, as a channel names them — the
 * notification-facing projection of `LicenseLapseService`'s `StrandedMember`
 * row, which carries db columns this side has no use for.
 *
 * Structured rather than a pre-rendered `Name <email> (role)` line, which is how
 * the log says it: `<ida@example.com>` inside telegram's `parse_mode: 'HTML'` is
 * an unsupported start tag, and telegram rejects the whole message rather than
 * dropping the fragment — the alert would silently not arrive on the one channel
 * most likely to be watched. Every format renders these fields itself, through
 * `describeStrandedMember`.
 *
 * **This bought the template and not the values, and the difference cost a
 * notification.** The paragraph above used to end *"and none of them
 * emits a bare angle bracket"*, which was true of `describeStrandedMember`'s
 * punctuation and false of the three fields it interpolates: `name` is whatever
 * the account holder typed into their profile, so `Ada <Lovelace>` puts the
 * unsupported start tag straight back. Escaping is the html-rendering channel's
 * job and lives at the channel (`escapeHtml` in `telegram.strategy.ts`), which
 * is the only place that knows its own parse mode — a value escaped here would
 * arrive as `&lt;` in the eleven channels that are not parsing HTML.
 */
export interface StrandedMemberSummary {
  /** Display name, or the email when the account has no name. */
  name: string;
  email: string;
  /** The custom role that no longer resolves. */
  role: string;
}

/** `Ida Rhodes (ida@example.com) — read-only`, for any channel's body. */
export function describeStrandedMember(person: StrandedMemberSummary): string {
  return `${person.name} (${person.email}) — ${person.role}`;
}

/**
 * An enterprise license that expired — the only event here that nothing
 * *does*. Expiry is derived at read time, so no action triggers it and no row
 * changes when it happens; `LicenseLapseService` finds the transition on a
 * schedule and dispatches this once per lapse, whether or not anybody holds a
 * custom role. `stopped` lists what the lapse turned off, and
 * `strandedMembers` is empty when nobody was locked out — every channel then
 * leaves the "Locked Out" part out rather than rendering an empty one.
 *
 * `message` carries the consequence and the guidance as prose, and every channel
 * renders it. That is deliberate rather than filler: it says *why nobody was
 * migrated off their role*, which was settled earlier and which is the first
 * thing an operator proposes on reading this alert. The static `member` role
 * grants backups, volumes and environment variables outright, so falling back to
 * it would silently widen a deliberately narrow custom role — worse than
 * refusing access. Keeping that reason in the payload means it reaches whoever
 * is paged, not only whoever later reads the log.
 */
export interface LicenseLapseEvent {
  type: 'license-lapse';
  organizationId: string;
  organizationName: string;
  /** The expiry that passed, ISO-8601 (ServerThresholdEvent's convention). */
  validUntil: string;
  /** What stopped working, one line each (`STOPPED_BY_LAPSE`). */
  stopped: readonly string[];
  /** Empty when nobody holds a custom role. */
  strandedMembers: readonly StrandedMemberSummary[];
  /** What the lapse costs, what to do, and why nobody was moved for you. */
  message: string;
}

/**
 * An enterprise license nearing its `validUntil`: sent once 14 days
 * before it and once 3 days before it, so whoever renews hears before
 * `license-lapse` would tell them it is too late. Like the lapse, nothing
 * *does* this — `LicenseExpiringService` finds the moment on its daily pass
 * and marks each point sent on the `license_key` row.
 *
 * `validUntil` is the date on the key and the only date named (ADR-0054): the
 * 14 days of grace Octabyte adds when issuing a key are already inside it.
 */
export interface LicenseExpiringEvent {
  type: 'license-expiring';
  organizationId: string;
  organizationName: string;
  /** The expiry ahead, ISO-8601 (ServerThresholdEvent's convention). */
  validUntil: string;
  /** Which warning this is: 14 days out, or 3. */
  daysLeft: 14 | 3;
  /** What stops on that date and what to do about it. */
  message: string;
}

/**
 * The loop signal: an Agent ran out of a rate budget, and this is
 * the first 429 of an episode — the episode closes after an hour with none, so
 * a looping Agent is announced once, not once a second.
 *
 * Opt-in and off by default like every flag, and org-scoped: it reaches the
 * channels of the Agent's own Organization. What an operator does next is in
 * `message` ({@link AGENT_RATE_LIMITED_ADVICE}); `agentLink` opens the Agent's
 * row, never a write, and is omitted while no instance URL is configured, as
 * the deployment links are.
 *
 * `agentName` and `organizationName` are operator-typed, so every channel with
 * markup escapes them itself (the rule restated on
 * {@link StrandedMemberSummary}).
 */
export interface AgentRateLimitedEvent {
  type: 'agent-rate-limited';
  organizationId: string;
  organizationName: string;
  agentName: string;
  /** The budget that ran dry, with the numbers it allows. */
  budget: AgentBudgetSummary;
  /** The first characters of the key the 429 came in on. Never the key. */
  keyPrefix: string | null;
  /** The Agent's row in the console's Agents section. */
  agentLink?: string;
  /** What to do about it: {@link AGENT_RATE_LIMITED_ADVICE}. */
  message: string;
}

/** A rate budget as a notification names it (`rate-bucket.ts`'s numbers). */
export interface AgentBudgetSummary {
  kind: BucketBudget;
  perMinute: number;
  burst: number;
}

/** The sentence: the way to stop a looping Agent, and its cost. */
export const AGENT_RATE_LIMITED_ADVICE =
  'Suspend it to stop it now; its keys and access are kept.';

/** The rate-limited Notification's title, ASCII because ntfy sends it as a header. */
export const AGENT_RATE_LIMITED_TITLE = 'Agent Rate Limited';

/** The label on the link to the Agent's row. */
export const AGENT_ROW_LINK_LABEL = 'Open the Agent';

/** `reads, 120 a minute with bursts of 60`. */
export function describeAgentBudget(budget: AgentBudgetSummary): string {
  const kind = budget.kind === 'read' ? 'reads' : 'writes';
  return `${kind}, ${budget.perMinute} a minute with bursts of ${budget.burst}`;
}

/**
 * The facts every channel renders for a rate-limited Agent, in order, with raw
 * values: escaping them is each channel's job, since only it knows its markup.
 * `typed` marks the values an operator typed, which are the ones to escape —
 * the budget and the key prefix are Cloudgate's own, and a key prefix like
 * `cg_x` should not arrive as `cg\\_x`.
 */
export function agentRateLimitedFacts(
  event: AgentRateLimitedEvent,
): { label: string; value: string; typed: boolean }[] {
  return [
    { label: 'Agent', value: event.agentName, typed: true },
    { label: 'Organization', value: event.organizationName, typed: true },
    {
      label: 'Budget',
      value: describeAgentBudget(event.budget),
      typed: false,
    },
    {
      label: 'Key',
      value: event.keyPrefix === null ? 'unknown' : `${event.keyPrefix}…`,
      typed: false,
    },
  ];
}

/**
 * The platform's own sweep is stuck (ADR-0026): on one
 * Server, expired Requested previews have been retried for fifteen minutes and
 * their copies are still not confirmed gone. Fired once per Server per
 * episode by `TeardownStuckEpisodes`, never per preview or per pass; the
 * episode closes when the Server has no pending teardown left.
 *
 * Why anyone needs telling: an expired row counts toward its Application's
 * requested-preview cap until its copy is gone (ADR-0026), so leftovers on a
 * dead Server quietly refuse every later create — {@link
 * PREVIEW_TEARDOWN_STUCK_ADVICE} says so. Opt-in and off by default like every
 * flag, and dispatched to the Server's own Organization.
 *
 * `serverName` and the Application names are operator-typed, so every channel
 * with markup escapes them itself (the rule restated on {@link
 * StrandedMemberSummary}).
 */
export interface PreviewTeardownStuckEvent {
  type: 'preview-teardown-stuck';
  organizationId: string;
  /** The Server row's id; null for the platform host. */
  serverId: string | null;
  /** The Server's name, or {@link PLATFORM_HOST_NAME}. */
  serverName: string;
  /** How many requested previews are stuck on it. */
  stuckCount: number;
  /** The Applications holding those slots, each with how many it holds. */
  applications: readonly StuckApplicationSummary[];
  /** When the oldest of them was first seen pending, ISO-8601. */
  stuckSince: string;
  /** That the slots stay taken until the copies are gone. */
  message: string;
}

/** One Application whose requested-preview slots a stuck teardown holds. */
export interface StuckApplicationSummary {
  name: string;
  /** How many of its requested previews are stuck on the Server. */
  stuck: number;
}

/** What a stuck teardown costs and what the platform keeps doing. */
export const PREVIEW_TEARDOWN_STUCK_ADVICE =
  'Their slots stay taken until the copies are gone, so new requested previews on these Applications may be refused. Cloudgate keeps retrying the teardown every minute.';

/** The stuck-teardown Notification's title, ASCII because ntfy sends it as a header. */
export const PREVIEW_TEARDOWN_STUCK_TITLE = 'Preview Teardown Stuck';

/** What the platform host is called where a Server's name would be. */
export const PLATFORM_HOST_NAME = 'the platform host';

const verbatim = (value: string): string => value;

/** `Web App (2), API`, each name through `escape` and the counts not. */
export function describeStuckApplications(
  applications: readonly StuckApplicationSummary[],
  escape: (value: string) => string = verbatim,
): string {
  return applications
    .map(({ name, stuck }) =>
      stuck > 1 ? `${escape(name)} (${stuck})` : escape(name),
    )
    .join(', ');
}

/**
 * The facts every channel renders for a stuck teardown, in order. `escape` is
 * the channel's own markup escape, applied to the operator-typed parts only —
 * the Server's name and each Application's — so Cloudgate's own `(2)` does
 * not arrive as `\(2\)`. A channel without markup passes nothing.
 */
export function previewTeardownStuckFacts(
  event: PreviewTeardownStuckEvent,
  escape: (value: string) => string = verbatim,
): { label: string; value: string }[] {
  return [
    { label: 'Server', value: escape(event.serverName) },
    {
      label: 'Stuck',
      value: `${event.stuckCount} requested preview${event.stuckCount === 1 ? '' : 's'}`,
    },
    {
      label: 'Applications',
      value: describeStuckApplications(event.applications, escape),
    },
    {
      label: 'Retried since',
      value: formatEventTime(new Date(event.stuckSince)),
    },
  ];
}

/**
 * An AI model that is meant to be running cannot be reached through the
 * Gateway (spec stories 97-98): a call to it could not reach
 * its runtime, or the runtime's machine answered for it with a server error.
 * Told **once per episode** by `AiModelNotAnsweringEpisodes` in `gateway/`,
 * which re-arms on the next call that gets through; every failing call in
 * between is in the usage rows as `runtime-error`. Not an Incident, and no
 * history is kept.
 *
 * A deliberate Stop never sends it (a stopped AI model is refused before the
 * hop), and neither does a refusal that is the caller's own mistake. Opt-in
 * and off by default like every flag, and dispatched to the AI model's own
 * Organization.
 *
 * `aiModelName`, `projectName`, `environmentName`, `model` and `serverName`
 * are operator-typed, so every channel with markup escapes them itself
 * (the rule restated on {@link StrandedMemberSummary}).
 */
export interface AiModelNotAnsweringEvent {
  type: 'ai-model-not-answering';
  organizationId: string;
  aiModelName: string;
  projectName: string;
  environmentName: string;
  /** The model the AI model serves, e.g. `llama3.1:8b`. */
  model: string;
  /** The Server it runs on, or {@link PLATFORM_HOST_NAME}. */
  serverName: string;
  /** When the call that opened the episode failed, ISO-8601. */
  failedAt: string;
  /** The AI model's Model tab; omitted while no instance URL is configured. */
  aiModelLink?: string;
  /** What it means and when the operator hears again: {@link AI_MODEL_NOT_ANSWERING_ADVICE}. */
  message: string;
}

/** What an operator reads under the facts. */
export const AI_MODEL_NOT_ANSWERING_ADVICE =
  'Calls through the gateway are failing while it should be running. Check its tasks and logs; you are told again only after a call gets through and a later one fails.';

/** The not-answering Notification's title, ASCII because ntfy sends it as a header. */
export const AI_MODEL_NOT_ANSWERING_TITLE = 'AI Model Not Answering';

/** The label on the link to the AI model's Model tab. */
export const AI_MODEL_LINK_LABEL = 'Open the AI model';

/**
 * The facts every channel renders for an AI model not answering, in order.
 * `escape` is the channel's own markup escape, applied to the operator-typed
 * values only. A channel without markup passes nothing.
 */
export function aiModelNotAnsweringFacts(
  event: AiModelNotAnsweringEvent,
  escape: (value: string) => string = verbatim,
): { label: string; value: string }[] {
  return [
    { label: 'AI model', value: escape(event.aiModelName) },
    {
      label: 'Environment',
      value: `${escape(event.projectName)} / ${escape(event.environmentName)}`,
    },
    { label: 'Model', value: escape(event.model) },
    { label: 'Runs on', value: escape(event.serverName) },
    { label: 'Failed', value: formatEventTime(new Date(event.failedAt)) },
  ];
}

/**
 * Why an Incident closed, as the close message words it. A Delete
 * closes nothing: the Incident goes with its owner and nothing is announced.
 * Spelled here rather than imported from the schema so this file stays free
 * of drizzle; `service-health.schema.ts`'s `incident_close_reason` is the
 * same four. `port-unpublished` is a TCP check Cloudgate turned off because
 * its Service no longer publishes its port.
 */
export type ServiceIncidentCloseReason =
  'recovered' | 'service-stopped' | 'turned-off' | 'port-unpublished';

/** Each close reason in the words a person reads. */
export const SERVICE_INCIDENT_REASON_LABELS: Record<
  ServiceIncidentCloseReason,
  string
> = {
  recovered: 'Recovered',
  'service-stopped': 'Service stopped',
  'turned-off': 'Turned off',
  'port-unpublished': 'Port no longer published',
};

/**
 * A Service's **Incident** opened or closed: announced
 * exactly twice, once each way, and never for a Delete. Fired by
 * `IncidentsService` in `service-health/`, dispatched to the Service's own
 * Organization.
 *
 * `source` is what owns the Incident. For an Uptime check, `target` is what
 * it watches — an HTTP check's URL, a TCP check's port — because a
 * check has no name of its own, and `openingError` the opening Probe's error
 * class. For an Error-rate threshold, `target` is the threshold in
 * words (`5 % over 5 minutes`), `openingError` the rate and request count of
 * the window that opened it (`12.5 % of 40 requests`), and a close carries
 * the worst rate while it was open in `worstRate`.
 *
 * **Never the check's header, a response body or the keyword**: none
 * of them is a field here, so no channel can render one. `openingError` is a
 * short class (`timeout`, `status 503`), never a body.
 *
 * `serviceName`, `projectName`, `environmentName` and `target` are
 * operator-typed, so every channel with markup escapes them itself (the
 * rule restated on {@link StrandedMemberSummary}).
 */
export interface ServiceIncidentEvent {
  type: 'service-incident';
  organizationId: string;
  state: 'opened' | 'closed';
  source: 'uptime-check' | 'error-rate-threshold';
  serviceName: string;
  projectName: string;
  environmentName: string;
  /**
   * What the owner watches: an HTTP check's `https://host/path`, or a
   * threshold's `5 % over 5 minutes`.
   */
  target: string;
  /**
   * The error class of the Probe that opened it, or the opening window's
   * `12.5 % of 40 requests`.
   */
  openingError: string;
  /** Threshold only, on a close: the worst window's rate, `31.3 %`. */
  worstRate?: string;
  /** ISO-8601. */
  openedAt: string;
  /** ISO-8601; set when `state` is `closed`. */
  closedAt?: string;
  /** Set when `state` is `closed`. */
  reason?: ServiceIncidentCloseReason;
  /** The Service's Health tab; omitted while no instance URL is configured. */
  serviceLink?: string;
}

/** The label on the link to the Service's Health tab. */
export const SERVICE_HEALTH_LINK_LABEL = 'Open the Health tab';

/**
 * The Incident Notification's title, ASCII because ntfy sends it as a header.
 */
export function serviceIncidentTitle(event: ServiceIncidentEvent): string {
  return event.state === 'opened'
    ? 'Service Incident Opened'
    : 'Service Incident Closed';
}

/**
 * The priority an Incident is sent at on the three channels that have one:
 * high, and never emergency — Pushover's 2 demands an acknowledgement
 * and repeats until it gets one, which a message told exactly twice must not.
 * The connection's own priority is not consulted, so a channel set to 2 for
 * something else still sends this at 1. gotify's 8 is the bottom of the band
 * its Android client shows as high.
 */
export const SERVICE_INCIDENT_PRIORITY = {
  pushover: 1,
  ntfy: 4,
  gotify: 8,
} as const;

/**
 * The facts every channel renders for an Incident, in order. `escape` is the
 * channel's own markup escape, applied to the operator-typed values only, so
 * Cloudgate's own `status 503` and times are not escaped. A channel without
 * markup passes nothing.
 */
export function serviceIncidentFacts(
  event: ServiceIncidentEvent,
  escape: (value: string) => string = verbatim,
): { label: string; value: string }[] {
  const facts = [
    { label: 'Service', value: escape(event.serviceName) },
    {
      label: 'Environment',
      value: `${escape(event.projectName)} / ${escape(event.environmentName)}`,
    },
    // A threshold's target and rate are Cloudgate's own words, not typed.
    event.source === 'error-rate-threshold'
      ? { label: 'Threshold', value: event.target }
      : { label: 'Target', value: escape(event.target) },
    {
      label: event.source === 'error-rate-threshold' ? 'Error rate' : 'Error',
      value: event.openingError,
    },
    { label: 'Opened', value: formatEventTime(new Date(event.openedAt)) },
  ];
  if (event.state === 'closed') {
    if (event.worstRate) {
      facts.push({ label: 'Worst rate', value: event.worstRate });
    }
    if (event.closedAt) {
      facts.push({
        label: 'Closed',
        value: formatEventTime(new Date(event.closedAt)),
      });
    }
    if (event.reason) {
      facts.push({
        label: 'Why',
        value: SERVICE_INCIDENT_REASON_LABELS[event.reason],
      });
    }
  }
  return facts;
}

export type NotificationEvent =
  | AppDeployEvent
  | AppBuildErrorEvent
  | DatabaseBackupEvent
  | VolumeBackupEvent
  | DockerCleanupEvent
  | ServerThresholdEvent
  | InstanceBackupEvent
  | InstanceRestartEvent
  | LicenseLapseEvent
  | LicenseExpiringEvent
  | AgentRateLimitedEvent
  | PreviewTeardownStuckEvent
  | ServiceIncidentEvent
  | AiModelNotAnsweringEvent;

/** The notification-row flag that opts a channel into each event type. */
export const EVENT_FLAG_COLUMNS = {
  'app-deploy': 'appDeploy',
  'app-build-error': 'appBuildError',
  'database-backup': 'databaseBackup',
  'volume-backup': 'volumeBackup',
  'docker-cleanup': 'dockerCleanup',
  'server-threshold': 'serverThreshold',
  'instance-backup': 'instanceBackup',
  'instance-restart': 'instanceRestart',
  'license-lapse': 'licenseLapse',
  'license-expiring': 'licenseExpiring',
  'agent-rate-limited': 'agentRateLimited',
  'preview-teardown-stuck': 'previewTeardownStuck',
  'service-incident': 'serviceIncident',
  'ai-model-not-answering': 'aiModelNotAnswering',
} as const satisfies Record<NotificationEvent['type'], string>;
