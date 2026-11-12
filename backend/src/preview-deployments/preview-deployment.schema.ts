import { relations, sql } from 'drizzle-orm';
import { check, pgEnum, pgTable, text, unique } from 'drizzle-orm/pg-core';
import {
  application,
  applicationStatusEnum,
} from '../applications/application.schema';
import { user } from '../auth/auth.schema';
import { isoTimestamp, nanoidPk } from '../db/columns';

/**
 * What made a Preview deployment (ADR-0026): a pull request the webhook
 * saw, or a caller who asked for one — a **Requested preview**. One table for
 * both, because every reader of a preview row (`container-access.service.ts`,
 * `previewTeardownSteps`, the cascade from Application, the audit kind) would
 * otherwise have to be taught a second one.
 */
export const previewTriggerEnum = pgEnum('preview_trigger', [
  'pullRequest',
  'requested',
]);

export type PreviewTrigger = (typeof previewTriggerEnum.enumValues)[number];

/**
 * What expired a Requested preview: its clock ran out, or a
 * caller deleted it — which is expiring it now. Carried to the
 * platform's audit row as `metadata.cause`.
 */
export const previewExpiryCauseEnum = pgEnum('preview_expiry_cause', [
  'expiry',
  'delete',
]);

export type PreviewExpiryCause =
  (typeof previewExpiryCauseEnum.enumValues)[number];

// The preview host is a plain text column instead of a domain-table FK
// (domains arrive with a later phase), and the PR comment id lands with the
// comment slice.
export const previewDeployment = pgTable(
  'preview_deployment',
  {
    previewDeploymentId: nanoidPk('preview_deployment_id'),
    /**
     * What made it. Rows written before Requested previews were all the
     * webhook's, so the default is what the migration backfills and what the
     * webhook's insert still relies on.
     */
    trigger: previewTriggerEnum('trigger').notNull().default('pullRequest'),
    /** The branch the preview builds: the PR's head, or the one asked for. */
    branch: text('branch').notNull(),
    // Set exactly when the trigger is `pullRequest` — the check below.
    pullRequestId: text('pull_request_id'),
    pullRequestNumber: text('pull_request_number'),
    pullRequestTitle: text('pull_request_title'),
    pullRequestURL: text('pull_request_url'),
    /**
     * Who asked for a Requested preview: the person for a session or personal
     * key, the Agent for an Agent key. **Recorded, not checked** — reach
     * is the parent's grant (ADR-0026) — and `set null` when the user goes,
     * because the copy is not torn down by a database cascade. Who asked is
     * *displayed* from the create audit row, which keeps the name.
     */
    requesterId: text('requester_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    /**
     * When a Requested preview's copy goes: an absolute ISO instant,
     * set at create and moved only by an explicit extend. Null exactly on a
     * pull-request preview, which lives until its pull request closes.
     */
    expiresAt: text('expires_at'),
    /**
     * When the preview was marked **expired**: set once, by the
     * sweep when `expiresAt` passes or by a `DELETE`, and never cleared. From
     * then on nothing is built into it, extend and redeploy are refused, and
     * the row reads *expired, teardown pending* until the sweep sees its
     * running copy gone and deletes it. Not a soft delete: the row is removed
     * the moment the copy is, and only a row that is gone answers 404.
     */
    expiredAt: text('expired_at'),
    /** Why it expired; set exactly when {@link expiredAt} is. */
    expiryCause: previewExpiryCauseEnum('expiry_cause'),
    /** The isolated service name the preview runs under, beside production. */
    appName: text('app_name').notNull().unique(),
    /** The preview's host, carved out of the application's preview wildcard. */
    domain: text('domain').notNull(),
    previewStatus: applicationStatusEnum('preview_status')
      .notNull()
      .default('idle'),
    createdAt: isoTimestamp('created_at'),
    applicationId: text('application_id')
      .notNull()
      .references(() => application.applicationId, { onDelete: 'cascade' }),
  },
  (table) => [
    /**
     * The trigger decides which columns a row carries (ADR-0026's pin):
     * a pull-request preview has its pull request and no expiry, a requested
     * one has an expiry and no pull request. "Exactly" both ways, so a
     * requested row can never be mistaken for a pull request's by the closed
     * webhook, and the expiry sweep can never find a pull-request preview.
     */
    check(
      'preview_deployment_fields_match_trigger',
      sql`(${table.trigger} = 'pullRequest' AND ${table.pullRequestId} IS NOT NULL AND ${table.pullRequestNumber} IS NOT NULL AND ${table.pullRequestTitle} IS NOT NULL AND ${table.pullRequestURL} IS NOT NULL AND ${table.expiresAt} IS NULL) OR (${table.trigger} = 'requested' AND ${table.pullRequestId} IS NULL AND ${table.pullRequestNumber} IS NULL AND ${table.pullRequestTitle} IS NULL AND ${table.pullRequestURL} IS NULL AND ${table.expiresAt} IS NOT NULL)`,
    ),
    /**
     * Only a Requested preview expires, and an expired one always says why:
     * the mark and its cause are set together, in one write.
     */
    check(
      'preview_deployment_expired_is_requested',
      sql`(${table.expiredAt} IS NULL AND ${table.expiryCause} IS NULL) OR (${table.expiredAt} IS NOT NULL AND ${table.expiryCause} IS NOT NULL AND ${table.trigger} = 'requested')`,
    ),
    /**
     * The key `deployment_preview_belongs_to_its_application` references:
     * a preview together with its parent, so a Deployment can name
     * a preview only beside that preview's own Application. The id alone is
     * already unique; this is the pair a composite foreign key needs.
     */
    unique('preview_deployment_id_application_id_unique').on(
      table.previewDeploymentId,
      table.applicationId,
    ),
  ],
);

export const previewDeploymentRelations = relations(
  previewDeployment,
  ({ one }) => ({
    application: one(application, {
      fields: [previewDeployment.applicationId],
      references: [application.applicationId],
    }),
  }),
);

export type PreviewDeployment = typeof previewDeployment.$inferSelect;
