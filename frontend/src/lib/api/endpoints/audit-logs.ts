import { api } from "../client";

/**
 * `enterprise/audit-logs/audit-log.controller.ts` — the Organization's
 * append-only trail of who did what.
 *
 * **What is recorded.** Every successful create, update, delete
 * and lifecycle action a signed-in caller makes through the API — the console's
 * own requests included — written by `AuditInterceptor` from the route alone
 * (the path template, the route's id, the returned row's name; never the
 * request body), plus sign-ins and sign-outs and the membership, role, API-key
 * and forward-auth changes their services write themselves. Those rows all
 * read `outcome: 'succeeded'`: a person's reads, connection tests, previews,
 * and refused or failed requests are not recorded, and neither is anything
 * done with no signed-in caller (webhooks, schedules). An Agent's calls are
 * the exception: every one is recorded, reads included, with an outcome of
 * `succeeded`, `refused` or `failed`.
 *
 * **One route, and it is not licensed.** `GET /audit-logs` rides
 * `@RequirePermission('auditLog', 'read')` and nothing else: the controller's
 * own comment records that the route deliberately carries no licence gate. So
 * the trail is readable on an unlicensed instance — by an owner or admin, who bypass
 * the check, and by a custom role granted `auditLog: read`. A plain `member` is
 * refused, because `auditLog` is in `ENTERPRISE_ONLY_RESOURCES` and the static
 * roles grant it to owner and admin only.
 *
 * That is why the audit-log screen is **not** wrapped in `LicenseGate` while its
 * four neighbours are. Gating it would be inventing a refusal the backend does
 * not make.
 *
 * ## The response is an object, not an array
 *
 * `{ logs, total }`. F16's first defect was a `DataTable` crashing on
 * `sorted.map is not a function` because `GET /users/me/api-keys` had this exact
 * shape and was typed as a list. The pager needs `total` anyway, so this one is
 * declared as what it is.
 *
 * ## What the filters really do
 *
 * `listAuditLogsSchema` is the authority and the four text filters do not all
 * behave the same way, which the filter bar has to say out loud:
 *
 * - `userEmail` and `resourceName` are **substring** matches (`ilike '%…%'`).
 * - `action` and `resourceType` are **exact** and closed — the two unions below
 *   are the whole vocabulary, they are the DTO's, and they hold exactly what the
 *   trail writes: every entry can be filtered for, and no filter names a kind
 *   that is never written.
 * - `userId` is exact. No control produces one — a person is picked by
 *   address — but the audit page reads it from `?userId=`, so the Agents
 *   section can link to one Agent's trail. `outcome` is exact too, and
 *   read from `?outcome=` the same way.
 * - `from`/`to` are `z.coerce.date()`, so an ISO string is what to send.
 * - `limit` is capped at **500** and defaults to 50; `offset` pages.
 *
 * ## `metadata` is a string, and may be anything
 *
 * The column is `text` and every writer serialises into it independently, so the
 * detail view parses defensively and falls back to showing the raw value. A
 * detail view that threw on one malformed row would take the whole trail with
 * it.
 */

/**
 * `AUDIT_ACTIONS` from `audit-log.schema.ts`, verbatim and in order — every
 * action the trail writes and no other. `audit-logs.test.ts` reads the
 * backend's list and fails when the two differ.
 */
export const AUDIT_ACTIONS = [
  "create",
  "update",
  "delete",
  "deploy",
  "cancel",
  "redeploy",
  "rollback",
  "login",
  "logout",
  "restore",
  "run",
  "start",
  "stop",
  "restart",
  "kill",
  "reload",
  "rebuild",
  "read",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * `AUDIT_OUTCOMES` from `audit-log.schema.ts`, verbatim and in order — how a
 * recorded call ended. A `refused` or `failed` row carries its reason in
 * `metadata.reason`. `audit-logs.test.ts` holds the two lists equal.
 */
export const AUDIT_OUTCOMES = ["succeeded", "refused", "failed"] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * `AUDIT_ACTORS` from the backend's `audit-log.dto.ts`, verbatim: the kinds of
 * actor the trail can be narrowed to. Only the platform, whose rows have
 * no address for the "Email contains" filter to find.
 */
export const AUDIT_ACTORS = ["platform"] as const;

export type AuditActorKind = (typeof AUDIT_ACTORS)[number];

/**
 * `PLATFORM_ACTOR_ROLE` from the backend's `platform-actor.ts`: the role a row
 * the platform wrote with no caller records, and one no Member can hold
 * since migration 0080. A row is the platform's when it also has no user and no
 * address, since rows from before 0080 can carry the role with a person behind
 * it (`platform-actor.ts`).
 */
export const PLATFORM_ACTOR_ROLE = "system";

/**
 * `AUDIT_RESOURCE_TYPES` from `audit-log.schema.ts`, verbatim and in order —
 * every kind the trail writes and no other. The backend's census
 * (`test/coding-standards/audit-log-kinds.spec.ts`) holds that list equal to
 * its writers, and `audit-logs.test.ts` holds this one equal to that.
 */
export const AUDIT_RESOURCE_TYPES = [
  "aiProvider",
  "application",
  "backup",
  "billing",
  "bucket",
  "certificate",
  "cloudAccount",
  "cluster",
  "compose",
  "customRole",
  "database",
  "deployment",
  "destination",
  "docker",
  "domain",
  "environment",
  "errorRateThreshold",
  "gitProvider",
  "license",
  "mount",
  "notification",
  "organization",
  "patch",
  "port",
  "previewDeployment",
  "project",
  "redirect",
  "registry",
  "schedule",
  "scim",
  "security",
  "server",
  "session",
  "settings",
  "sshKey",
  "sso",
  "tag",
  "traces",
  "uptimeCheck",
  "user",
  "volumeBackup",
] as const;

export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

/**
 * One row of the trail.
 *
 * The actor is **denormalised on purpose**: `userId` is `onDelete: 'set null'`,
 * so a row stays readable after the account is gone, and `userRole` records the
 * role they held *at the time* rather than the one they hold now. Which is why
 * the table renders these and not a joined user.
 *
 * **An Agent's row is told apart by `userRole`**: the agent roles are
 * Agent-only (`isAgentRole`). Its `userEmail` is a synthetic address that must
 * never render, so such a row is named by `userName` instead, which was
 * written with the row and so outlives the Agent.
 */
export interface AuditLogEntry {
  auditLogId: string;
  organizationId: string | null;
  userId: string | null;
  /** `null` exactly on a row the platform wrote, which has no address. */
  userEmail: string | null;
  /** The actor's name when the row was written; `null` on older rows. */
  userName: string | null;
  userRole: string;
  /** Widened: the column is `text`, so a writer can record an unlisted verb. */
  action: string;
  outcome: AuditOutcome;
  resourceType: string;
  resourceId: string | null;
  resourceName: string | null;
  /** Serialised by whoever wrote the row. Shape is not guaranteed. */
  metadata: string | null;
  /** `""` for a write with no request behind it, `null` on older rows. */
  ip: string | null;
  createdAt: string;
}

/**
 * Which trail. `organization` is the active Organization's.
 * `deleted-organizations` is every entry whose Organization has been deleted —
 * the rows survive (the FK is `set null`) but belong to no Organization, so
 * they are read by instance authority: an owner or admin of the instance
 * organization. Anyone else is refused with a 403.
 */
export const AUDIT_SCOPES = ["organization", "deleted-organizations"] as const;
export type AuditScope = (typeof AUDIT_SCOPES)[number];

export interface AuditLogFilters {
  scope?: AuditScope;
  /** One actor, exactly — an Agent's user id from the Agents section. */
  userId?: string;
  userEmail?: string;
  resourceName?: string;
  action?: AuditAction;
  resourceType?: AuditResourceType;
  outcome?: AuditOutcome;
  /** `platform`: only the rows the platform wrote with no caller. */
  actor?: AuditActorKind;
  /** ISO strings — the DTO coerces them to dates. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogPage {
  logs: AuditLogEntry[];
  total: number;
  /**
   * How many entries were recorded in Organizations since deleted — a number
   * for a caller who can read them (instance authority), `null` for one who
   * cannot, who is told nothing about other Organizations.
   */
  deletedOrganizationEntries: number | null;
}

/** The DTO's own ceiling. A larger `limit` is a 400, not a bigger page. */
export const AUDIT_LOG_MAX_LIMIT = 500;

export const auditLogsApi = {
  list: (filters: AuditLogFilters = {}) =>
    api.get<AuditLogPage>("/audit-logs", { query: { ...filters } }),
};
