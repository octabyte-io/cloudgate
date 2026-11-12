import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { AuditAction, AuditResourceType } from './audit-log.schema';

/**
 * Which HTTP writes the audit trail records, and as what.
 *
 * The trail used to be written only by the services that call
 * `AuditLogService.audit` themselves — sessions, users, organization
 * membership, custom roles and forward auth — while the console's Kind filter
 * offered thirty kinds. Everything else a signed-in operator changes arrives
 * as a mutating HTTP request, so `AuditInterceptor` records it at that one
 * seam instead of in some thirty services, and this file is what it consults.
 *
 * **A route is recorded as (kind, action), derived from its path template.**
 * The first segment names the kind ({@link KIND_BY_SEGMENT}); the verb and the
 * last static segment name the action ({@link auditTargetFor}). Only the
 * template, the route's own id parameter and the response's `name` are kept —
 * never a request body, so a password, token or environment variable cannot
 * reach `metadata`.
 *
 * **Every mutating route is either recorded here or named below with the reason
 * it is not.** `test/coding-standards/audit-log-kinds.spec.ts` walks every
 * controller and fails on a route that is neither, on an entry here whose
 * route is gone, and on a kind the filter offers that nothing writes.
 */

/** The kind each first path segment records. */
export const KIND_BY_SEGMENT: Readonly<Record<string, AuditResourceType>> = {
  admin: 'settings',
  ai: 'aiProvider',
  applications: 'application',
  backups: 'backup',
  billing: 'billing',
  bitbucket: 'gitProvider',
  // Buying a Server, and finishing or cancelling its payment (ADR-0071).
  'bought-servers': 'server',
  // A bucket's browser-upload origins, keyed on the bucket's id.
  buckets: 'bucket',
  certificates: 'certificate',
  'cloud-accounts': 'cloudAccount',
  cluster: 'cluster',
  compose: 'compose',
  deployments: 'deployment',
  destinations: 'destination',
  docker: 'docker',
  domains: 'domain',
  environments: 'environment',
  // A Service's Error-rate threshold: put (create, edit, off/on) and
  // delete, keyed on the Service's id.
  'error-rate-thresholds': 'errorRateThreshold',
  'git-providers': 'gitProvider',
  gitea: 'gitProvider',
  github: 'gitProvider',
  gitlab: 'gitProvider',
  libsql: 'database',
  license: 'license',
  mariadb: 'database',
  monitoring: 'server',
  mongo: 'database',
  mounts: 'mount',
  mysql: 'database',
  notifications: 'notification',
  organizations: 'organization',
  patches: 'patch',
  ports: 'port',
  postgres: 'database',
  'preview-deployments': 'previewDeployment',
  projects: 'project',
  redirects: 'redirect',
  redis: 'database',
  registries: 'registry',
  rollbacks: 'deployment',
  schedules: 'schedule',
  scim: 'scim',
  security: 'security',
  servers: 'server',
  settings: 'settings',
  'ssh-keys': 'sshKey',
  sso: 'sso',
  tags: 'tag',
  // A Service's traces setting: on, off and retention, one PUT keyed
  // on the Service's id.
  traces: 'traces',
  // A Service's Uptime checks: create, edit, off/on and delete.
  'uptime-checks': 'uptimeCheck',
  users: 'user',
  'volume-backups': 'volumeBackup',
};

/**
 * Segments whose every POST changes a setting rather than creating a row, so
 * `POST /settings/ip` reads `update settings` and not `create settings`.
 */
const POST_UPDATES_SEGMENTS: ReadonlySet<string> = new Set([
  'admin',
  'billing',
  'license',
  'settings',
]);

/** A last static segment that names the action outright. */
const ACTION_BY_SEGMENT: Readonly<Record<string, AuditAction>> = {
  cancel: 'cancel',
  deploy: 'deploy',
  deployments: 'deploy',
  kill: 'kill',
  rebuild: 'rebuild',
  redeploy: 'redeploy',
  reload: 'reload',
  restart: 'restart',
  restore: 'restore',
  rollback: 'rollback',
  run: 'run',
  start: 'start',
  stop: 'stop',
  // Stop the run: ends a Cloud run, its apply included.
  'stop-run': 'stop',
};

/** Routes whose recorded (kind, action) the path alone would get wrong. */
export const ROUTE_OVERRIDES: Readonly<
  Record<string, { resourceType: AuditResourceType; action: AuditAction }>
> = {
  'POST /users/me/sessions/revoke': {
    resourceType: 'session',
    action: 'delete',
  },
  // Creates a Compose stack from a generated template.
  'POST /ai/deploy': { resourceType: 'compose', action: 'create' },
  // A Template's setup adds entries to a Project's config and opens its
  // plans, as a whole-YAML save does; the Services come at Apply.
  'POST /templates/setup': { resourceType: 'project', action: 'update' },
  // Cancelling a Pending setup changes what waits on the Environment, as
  // dismissing its plan does; the path alone would read `delete environment`.
  'DELETE /environments/:environmentId/pending-setups/:pendingSetupId': {
    resourceType: 'environment',
    action: 'update',
  },
  // A bucket's Rotate key is an update of the bucket, not a create.
  'POST /buckets/:id/rotate-key': { resourceType: 'bucket', action: 'update' },
  // Retry of a cloud Service's incomplete Delete is the Delete again.
  'POST /applications/:id/delete/retry': {
    resourceType: 'application',
    action: 'delete',
  },
  // Retry of a bucket on AWS's incomplete Delete is the Delete again.
  'POST /buckets/:id/delete/retry': {
    resourceType: 'bucket',
    action: 'delete',
  },
  // Retry of an Environment's incomplete cloud Delete is the Delete again.
  'POST /environments/:id/delete/retry': {
    resourceType: 'environment',
    action: 'delete',
  },
};

/**
 * A mutating route the interceptor deliberately does not record.
 *
 * - `service`: the service behind it writes its own, richer entry (the file
 *   named), so recording the request too would put every such action in the
 *   trail twice. The census checks the file still writes one.
 * - `probe`: a POST that changes nothing Cloudgate keeps — a connection test, a
 *   preview, a suggestion, a read that takes a body — or an `@All` route that
 *   forwards only reads, which the interceptor, keyed on `ALL`, never records.
 *
 * `@Public()` routes are not listed: they have no signed-in actor to record,
 * and the interceptor skips any request without one.
 */
export type NotRecorded = { service: string } | { probe: string };

const ORGANIZATIONS = { service: 'src/organizations/organizations.service.ts' };
const USERS = { service: 'src/users/users.service.ts' };
const AGENTS = { service: 'src/agents/agents.service.ts' };
const MCP_DISPATCHER = { service: 'src/mcp/mcp-dispatcher.ts' };
const PREVIEW_DEPLOYMENTS = {
  service: 'src/preview-deployments/preview-deployments.service.ts',
};
const CUSTOM_ROLES = {
  service: 'src/enterprise/custom-roles/custom-roles.service.ts',
};
const FORWARD_AUTH = {
  service: 'src/enterprise/forward-auth/forward-auth.service.ts',
};
// An Operator's suspend and lift and Enterprise switch: one
// row in the target Organization's log and a copy in the Instance
// organization's, which the interceptor — recording against the caller's
// active Organization — cannot. The Server markup and margin floor are the
// instance's, so their one row goes in the Instance organization's log,
// through the same `recordWrite`, as are the abuse actions (#1401):
// forwarding and closing an abuse report, powering a Bought Server off and on.
const OPERATOR = { service: 'src/operator/operator.service.ts' };
const SAVED_CREDENTIALS = { probe: 'tests saved credentials' };
const UNSAVED_CREDENTIALS = { probe: 'tests unsaved credentials' };

export const NOT_RECORDED_ROUTES: Readonly<Record<string, NotRecorded>> = {
  // Written by their own service, with before/after detail the path lacks.
  'POST /organizations': ORGANIZATIONS,
  'PATCH /organizations/:id': ORGANIZATIONS,
  'DELETE /organizations/:id': ORGANIZATIONS,
  'POST /organizations/:id/set-default': ORGANIZATIONS,
  'POST /organizations/invitations': ORGANIZATIONS,
  'DELETE /organizations/invitations/:id': ORGANIZATIONS,
  'PATCH /organizations/members/:id': ORGANIZATIONS,
  'PATCH /organizations/members/:id/entitlements': ORGANIZATIONS,
  'DELETE /organizations/members/:id': ORGANIZATIONS,
  'POST /operator/organizations/:id/suspension': OPERATOR,
  'DELETE /operator/organizations/:id/suspension': OPERATOR,
  'PUT /operator/organizations/:id/enterprise': OPERATOR,
  'PUT /operator/bought-servers/settings': OPERATOR,
  'DELETE /operator/bought-servers/orphans/:providerServerId': OPERATOR,
  'POST /operator/organizations/:id/abuse-reports': OPERATOR,
  'POST /operator/abuse-reports/:id/close': OPERATOR,
  'POST /operator/bought-servers/:id/power-off': OPERATOR,
  'POST /operator/bought-servers/:id/power-on': OPERATOR,
  'POST /operator/bought-servers/reprice': OPERATOR,
  'POST /operator/bought-servers/reprice/preview': {
    probe: 'previews a reprice and keeps nothing',
  },
  'POST /agents': AGENTS,
  'DELETE /agents/:id': AGENTS,
  'POST /agents/:id/suspend': AGENTS,
  'POST /agents/:id/resume': AGENTS,
  'POST /agents/:id/keys': AGENTS,
  'DELETE /agents/:id/keys/:keyId': AGENTS,
  // One row per tool call, allowed or refused, with the tool's twin's kind
  // and action. The route is `@Public()`, so the interceptor would
  // record nothing anyway; the entry says who does.
  'POST /mcp': MCP_DISPATCHER,
  // The Gateway into an AI model: `@Public()`, so the interceptor has
  // no actor to record, and named here because its first segment is `ai`,
  // which would otherwise read as an `aiProvider` change. A call's one record
  // is its usage row; it writes no audit row.
  'ALL /ai/:applicationId/*rest': {
    probe: 'forwards a call to an AI model, recorded as its usage row',
  },
  // A Requested preview's create and extend carry the branch and the expiry,
  // which the path cannot; create would otherwise read `update application`.
  // The console reads "requested by" from the create row.
  'POST /applications/:applicationId/preview-deployments': PREVIEW_DEPLOYMENTS,
  'POST /preview-deployments/:previewDeploymentId/extend': PREVIEW_DEPLOYMENTS,
  // Forget of a cloud Service's incomplete Delete writes what is left in AWS
  // into its entry (ADR-0038), which the path cannot carry; so does the clean
  // finish of a cloud Delete, which no request is waiting on.
  'POST /applications/:id/delete/forget': {
    service: 'src/applications/cloud-delete.ts',
  },
  // A bucket on AWS's Forget, likewise.
  'POST /buckets/:id/delete/forget': {
    service: 'src/buckets/cloud-bucket-deletes.service.ts',
  },
  // An Environment's Forget, likewise.
  'POST /environments/:id/delete/forget': {
    service: 'src/project-config/environment-cloud-deletes.service.ts',
  },
  'PATCH /users/me': USERS,
  'POST /users/me/api-keys': USERS,
  'DELETE /users/me/api-keys/:id': USERS,
  'POST /custom-roles': CUSTOM_ROLES,
  'PATCH /custom-roles/:roleName': CUSTOM_ROLES,
  'DELETE /custom-roles/:roleName': CUSTOM_ROLES,
  'PUT /forward-auth/settings': FORWARD_AUTH,
  'DELETE /forward-auth/settings': FORWARD_AUTH,
  'POST /forward-auth/proxy': FORWARD_AUTH,
  'DELETE /forward-auth/proxy': FORWARD_AUTH,
  'POST /forward-auth/domains/:domainId/enable': FORWARD_AUTH,
  'POST /forward-auth/domains/:domainId/disable': FORWARD_AUTH,
  // A Service's wired variables: its kind is the `:serviceType` sent,
  // which the path's first segment cannot say.
  'PUT /services/:serviceType/:serviceId/links': {
    service: 'src/project-config/wired-variables.service.ts',
  },
  // Names the Server (or the platform host) the change was made on (US77).
  'POST /settings/traefik/request-metrics': {
    service: 'src/settings/request-metrics.service.ts',
  },
  // Turning the Access log on or off, likewise.
  'POST /settings/traefik/requests': {
    service: 'src/settings/request-logging.service.ts',
  },

  // Change nothing Cloudgate keeps.
  'POST /ai/models': { probe: 'lists the models a provider offers' },
  'POST /ai/suggest': { probe: 'asks the provider for a suggestion' },
  'POST /ai/analyze-logs': { probe: 'asks the provider to read logs' },
  'POST /ai/test-connection': UNSAVED_CREDENTIALS,
  'POST /ai/:id/test-connection': SAVED_CREDENTIALS,
  'POST /applications/:id/test-registry-login': SAVED_CREDENTIALS,
  'POST /billing/checkout': { probe: 'opens a payment page' },
  'POST /billing/portal': { probe: 'opens the billing portal' },
  'POST /cloud-accounts/setup': {
    probe: 'hands out a setup template and keeps nothing',
  },
  'POST /destinations/test-connection': UNSAVED_CREDENTIALS,
  'POST /destinations/:id/test-connection': SAVED_CREDENTIALS,
  'POST /domains/generate': { probe: 'suggests a hostname' },
  'POST /domains/validate': { probe: 'checks a hostname resolves' },
  'POST /license/validate': { probe: 'checks the stored key' },
  'POST /monitoring/requests/logs': { probe: 'reads the access log' },
  'POST /monitoring/requests/stats': { probe: 'reads request statistics' },
  'POST /registries/test-connection': UNSAVED_CREDENTIALS,
  'POST /registries/:id/test-connection': SAVED_CREDENTIALS,
  'POST /notifications/:id/test': { probe: 'sends a test message' },
  // The Trace store proxy: forwards GET, HEAD and the UI's trace-file
  // render, and refuses every other verb, so nothing through it is a write.
  // `@Public()` since ADR-0075 (a frame token is its credential), so the
  // interceptor has no actor to record anyway.
  'ALL /traces/:serviceId/ui/t/:token{/*rest}': {
    probe: 'reads a Trace store through the backend',
  },
  ...Object.fromEntries(
    [
      'slack',
      'telegram',
      'discord',
      'email',
      'resend',
      'gotify',
      'ntfy',
      'mattermost',
      'custom',
      'lark',
      'pushover',
      'teams',
    ].map((channel) => [
      `POST /notifications/${channel}/test`,
      { probe: 'sends a test message with unsaved settings' },
    ]),
  ),
};

/** Longest resource id or name kept; a row is a record, not a payload. */
export const MAX_FIELD = 200;

/** `value` cut to {@link MAX_FIELD}. */
export function clip(value: string): string {
  return value.length > MAX_FIELD ? value.slice(0, MAX_FIELD) : value;
}

/**
 * The value of the route's first id parameter (`/applications/:applicationId`
 * → the request's `applicationId`), clipped — the `resourceId` a row about
 * this request carries, whether `AuditInterceptor` records its success or
 * `AuthGuard` its refusal.
 */
export function routeParamOf(
  path: string,
  params: Record<string, string | string[]> | undefined,
): string | undefined {
  const param = path
    .split('/')
    .find((part) => part.startsWith(':'))
    ?.slice(1);
  const value = param ? params?.[param] : undefined;
  return typeof value === 'string' && value !== '' ? clip(value) : undefined;
}

/** What the interceptor records for one route. */
export interface AuditTarget {
  resourceType: AuditResourceType;
  action: AuditAction;
}

/** `METHOD /path/:param` — the key the tables above use. */
export function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

/**
 * The (kind, action) a successful request to this route records, or `null`
 * when it is not recorded (not mutating, listed above, or an unknown segment).
 */
export function auditTargetFor(
  method: string,
  path: string,
): AuditTarget | null {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;
  const key = routeKey(method, path);
  if (key in NOT_RECORDED_ROUTES) return null;
  if (key in ROUTE_OVERRIDES) return ROUTE_OVERRIDES[key];

  const segments = path.split('/').filter(Boolean);
  const resourceType = KIND_BY_SEGMENT[segments[0]];
  if (!resourceType) return null;
  return { resourceType, action: actionFor(method, segments) };
}

/**
 * The facet fields an AI model's update names: which of its
 * model, image tag and Hugging Face token the request changed, never a
 * value. `metadata.changed` on an ordinary `update application` row, so an AI
 * model's trail is an Application's with no kind of its own. Field *names*,
 * so nothing the operator typed can land in the row; `[]` when the request
 * changed none.
 *
 * **A change, not a mention**: the console's form sends the model and the
 * image tag on every save, so each is compared with `stored`, the facet as it
 * was before the request (the tag as read, the pin standing for none). The
 * token is write-only and never compared: setting one, or clearing one that
 * is set, is the change.
 */
export interface StoredFacet {
  model: string;
  imageTag: string;
  pin: string;
  hasHfToken: boolean;
}

export function isAiModelUpdateRoute(method: string, path: string): boolean {
  return routeKey(method, path) === 'PATCH /applications/:id';
}

export function changedFacetFieldsOf(
  method: string,
  path: string,
  body: unknown,
  stored: StoredFacet | null,
): string[] {
  if (!stored || !isAiModelUpdateRoute(method, path)) return [];
  if (!body || typeof body !== 'object') return [];
  const facet = (body as { aiModel?: unknown }).aiModel;
  if (!facet || typeof facet !== 'object') return [];
  const sent = facet as {
    model?: unknown;
    imageTag?: unknown;
    hfToken?: unknown;
  };
  const changed: string[] = [];
  if (sent.model !== undefined && sent.model !== stored.model) {
    changed.push('model');
  }
  if (
    sent.imageTag !== undefined &&
    (sent.imageTag ?? stored.pin) !== stored.imageTag
  ) {
    changed.push('imageTag');
  }
  if (
    sent.hfToken !== undefined &&
    ((sent.hfToken !== null && sent.hfToken !== '') || stored.hasHfToken)
  ) {
    changed.push('hfToken');
  }
  return changed;
}

/**
 * The (kind, action) a *refused* request to this route records — an Agent's
 * credential on a REST route (`AuthGuard`) — which, unlike
 * {@link auditTargetFor}, always answers: a refusal is recorded whatever the
 * route, a read and a route whose success its service records included.
 *
 * A route the interceptor records keeps that vocabulary; any other takes its
 * kind from its first segment, `read` for a `GET`, and the action a success
 * would have had otherwise. A first segment with no kind of its own
 * (`/agents`, `/audit-logs`) is a refused `session` — the connection, as the
 * MCP dispatcher records a refusal that names no tool.
 */
export function refusedTargetFor(method: string, path: string): AuditTarget {
  const recorded = auditTargetFor(method, path);
  if (recorded) return recorded;
  const key = routeKey(method, path);
  if (key in ROUTE_OVERRIDES) return ROUTE_OVERRIDES[key];
  const segments = path.split('/').filter(Boolean);
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  return {
    resourceType: KIND_BY_SEGMENT[segments[0] ?? ''] ?? 'session',
    action:
      mutating && segments.length > 0 ? actionFor(method, segments) : 'read',
  };
}

function actionFor(method: string, segments: string[]): AuditAction {
  if (method === 'DELETE') return 'delete';
  if (method !== 'POST') return 'update';

  const last = segments[segments.length - 1];
  if (!last.startsWith(':') && last in ACTION_BY_SEGMENT) {
    return ACTION_BY_SEGMENT[last];
  }
  if (POST_UPDATES_SEGMENTS.has(segments[0])) return 'update';
  // A collection (`/projects`) or a typed collection under one
  // (`/notifications/slack`, `/sso/providers`) is a create; anything that
  // names an existing row first (`/applications/:id/drop`) is a change to it.
  const creates =
    segments.length <= 2 && segments.every((part) => !part.startsWith(':'));
  return creates ? 'create' : 'update';
}

/**
 * The HTTP method and path template Nest serves a handler at, read off the
 * same `@Controller`/`@Post` metadata the router is built from.
 */
export function routeOf(
  controller: object,
  handler: object,
): { method: string; path: string } | null {
  const verb = Reflect.getMetadata(METHOD_METADATA, handler) as
    RequestMethod | undefined;
  if (verb === undefined) return null;
  const parts = [
    ...toPaths(Reflect.getMetadata(PATH_METADATA, controller)),
    ...toPaths(Reflect.getMetadata(PATH_METADATA, handler)),
  ];
  const path = `/${parts.join('/')}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return { method: RequestMethod[verb], path: path || '/' };
}

function toPaths(value: unknown): string[] {
  const first = Array.isArray(value) ? (value[0] as unknown) : value;
  return typeof first === 'string' ? first.split('/').filter(Boolean) : [];
}
