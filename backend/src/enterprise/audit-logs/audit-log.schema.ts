import { relations, sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { nanoidPk } from '../../db/columns';
import { organization } from '../../organizations/organizations.schema';
import { user } from '../../auth/auth.schema';

// An append-only trail of who changed what (see audit-routes.ts for exactly
// which writes it records). Both FKs are `set null` so deleting an organization
// or user keeps the history rather than erasing it — and it stays readable: a
// row whose organization is gone is served by `GET /audit-logs?scope=deleted-
// organizations` to the instance organization's owners and admins.

export const auditLog = pgTable(
  'audit_log',
  {
    auditLogId: nanoidPk('audit_log_id'),
    organizationId: text('organization_id').references(() => organization.id, {
      onDelete: 'set null',
    }),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    // The actor is denormalized: the row must stay readable after the user
    // record is gone, and their role at the time is what the trail records.
    //
    // Null exactly on a row the platform wrote with no caller
    // (`platform-actor.ts`): the platform has no address, and a fixed one
    // would be an identity the "Email contains" filter could match and a
    // reader could mistake for a person's — the synthetic-address trap
    // already closed for Agents. Every member-written row still has one.
    userEmail: text('user_email'),
    userRole: text('user_role').notNull(),
    // The actor's display name when the row was written, kept for the
    // same reason as the email: an Agent's row must still name it after the
    // Agent is deleted, and an Agent's email is a synthetic address the
    // console never shows. Written for people too, so the column never tells
    // the two apart — `user_role` does, since the agent roles are Agent-only.
    // Null on rows written before the column existed.
    userName: text('user_name'),
    action: text('action').notNull(),
    // How the call ended. Every row written before the column existed
    // was a success, and so is every row `AuditInterceptor` writes; `refused`
    // and `failed` rows come from the MCP dispatcher, and `refused` ones also
    // from `AuthGuard` when it refuses an Agent key on a REST route,
    // with the reason in `metadata.reason`.
    outcome: text('outcome')
      .$type<AuditOutcome>()
      .notNull()
      .default('succeeded'),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    resourceName: text('resource_name'),
    metadata: text('metadata'),
    // The caller's address where a request is in scope, null for writes with
    // no request behind them (cron, boot hooks).
    ip: text('ip'),
    // Millisecond precision, not the default microseconds: the driver hands
    // back millisecond Dates, so a microsecond-precise row would never satisfy
    // a `to` bound taken from its own returned createdAt.
    createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    index('audit_log_organization_id_idx').on(table.organizationId),
    index('audit_log_user_id_idx').on(table.userId),
    index('audit_log_created_at_idx').on(table.createdAt),
    // An Agent's refusals by time: the "Rate-limited N times in the
    // last hour" count on its row and the loop signal's one read after a
    // restart. Partial, because refusals are the few rows only the MCP
    // dispatcher writes; the reason stays in `metadata` and is filtered in
    // the row (`rateLimitRefusal` in rate-limit-refusals.ts).
    index('audit_log_refused_user_created_at_idx')
      .on(table.userId, table.createdAt)
      .where(sql`"outcome" = 'refused'`),
  ],
);

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  organization: one(organization, {
    fields: [auditLog.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [auditLog.userId],
    references: [user.id],
  }),
}));

export type AuditLog = typeof auditLog.$inferSelect;

/**
 * Every action the trail writes — and only those, because the console's Action
 * filter is built from this list and a word nothing writes is a filter that can
 * never match. `test/coding-standards/audit-log-kinds.spec.ts` holds it
 * equal to what the writers produce: the routes `AuditInterceptor` records (see
 * `audit-routes.ts`) and the services that call `AuditLogService.audit`.
 * `read` is the one word ahead of its writer — the MCP dispatcher — and
 * the census names it pending until the writer lands.
 */
export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'deploy',
  'cancel',
  'redeploy',
  'rollback',
  'login',
  'logout',
  'restore',
  'run',
  'start',
  'stop',
  'restart',
  'kill',
  'reload',
  'rebuild',
  'read',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * How a recorded call ended. `refused` and `failed` carry a reason in
 * `metadata.reason`; the console's Outcome filter is built from this list.
 */
export const AUDIT_OUTCOMES = ['succeeded', 'refused', 'failed'] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * Why a `refused` or `failed` row ended so, as `metadata.reason` carries it.
 * The whole vocabulary: a writer names one of these constants, so a
 * reason the console, `rate-limit-refusals.ts` or `docs/connecting-an-agent.md`
 * does not know cannot be written.
 *
 * - `permission` — the role lacks the statement (a tool, or an Agent key on a
 *   REST route); `grant` — the target is outside the Agent's grant;
 *   `rate-limit` — a 429; `suspended`, `credential-expired`,
 *   `unsupported-revision` — the request was turned away before any tool.
 * - `unknown-tool` — a `tools/call` naming no tool; `batch-refused` — a call
 *   that never ran because another call in its batch was refused.
 * - `invalid-arguments` (`failed`) — arguments the tool's input schema
 *   rejects; `deadline` (`failed`) — the 30-second deadline passed.
 * - `preview-limit` (`failed`) — a Requested preview's create refused at the
 *   Application's `requestedPreviewLimit`, so an Agent looping on it
 *   shows under the Outcome filter.
 * - `frozen` (`refused`) — a write tool called for a Frozen Organization
 *   (ADR-0052), refused with the frozen error its HTTP twin answers.
 */
export const AUDIT_REASON = {
  permission: 'permission',
  grant: 'grant',
  rateLimit: 'rate-limit',
  suspended: 'suspended',
  credentialExpired: 'credential-expired',
  unsupportedRevision: 'unsupported-revision',
  unknownTool: 'unknown-tool',
  batchRefused: 'batch-refused',
  invalidArguments: 'invalid-arguments',
  deadline: 'deadline',
  previewLimit: 'preview-limit',
  frozen: 'frozen',
} as const;

export type AuditReason = (typeof AUDIT_REASON)[keyof typeof AUDIT_REASON];

/**
 * Every resource kind the trail writes, held equal to its writers by the same
 * census as {@link AUDIT_ACTIONS}. Adding a kind here without a writer, or a
 * writer without the kind, fails it.
 */
export const AUDIT_RESOURCE_TYPES = [
  'aiProvider',
  'application',
  'backup',
  'billing',
  'bucket',
  'certificate',
  'cloudAccount',
  'cluster',
  'compose',
  'customRole',
  'database',
  'deployment',
  'destination',
  'docker',
  'domain',
  'environment',
  'errorRateThreshold',
  'gitProvider',
  'license',
  'mount',
  'notification',
  'organization',
  'patch',
  'port',
  'previewDeployment',
  'project',
  'redirect',
  'registry',
  'schedule',
  'scim',
  'security',
  'server',
  'session',
  'settings',
  'sshKey',
  'sso',
  'tag',
  'traces',
  'uptimeCheck',
  'user',
  'volumeBackup',
] as const;

export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];
