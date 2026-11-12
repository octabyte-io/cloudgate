import { relations, sql } from 'drizzle-orm';
import { jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { encryptedText, isoTimestamp, nanoidPk } from '../db/columns';
import { project } from '../projects/project.schema';
import type { Leftover } from '../cloud-accounts/aws/delete-check';
import type { GoogleLeftover } from '../cloud-accounts/gcp/delete-check';
import type { DnsRecord } from '../domains/domain.schema';
import type { DeployTarget } from './deploy-target';

/**
 * One thing an Environment's Delete left in AWS (ADR-0038), or in
 * Google Cloud: a leftover of one of its cloud Services or of one
 * of its Environment networks, with whose it is.
 */
export type EnvironmentLeftover = (Leftover | GoogleLeftover) & {
  /** Whose it was: `Service web`, `Environment network (eu-central-1)`. */
  readonly of: string;
};

/**
 * An Environment's Delete in a Cloud account, under way or incomplete
 * (ADR-0038). `null` on every Environment no such Delete has touched.
 *
 * The Delete destroys each cloud Service through its own Delete,
 * then each Environment network in a destroy-only run, then the rest of the
 * Environment as a Delete always has. The row stays while any of it is
 * left, `incomplete`, until Retry or Forget.
 */
export interface EnvironmentDeleteRecord {
  readonly status: 'deleting' | 'incomplete';
  /** The latest run is a Retry. */
  readonly retrying: boolean;
  /** Who asked (the Delete or the latest Retry), for the audit entry its clean finish writes. */
  readonly requestedBy: {
    readonly userId: string;
    readonly organizationId: string;
  } | null;
  /** The Delete's `?force=true`, for the Services that run on a Server. */
  readonly force: boolean;
  /** What is left in AWS, each with whose it is. */
  readonly left: readonly EnvironmentLeftover[];
  /**
   * The DNS records its Domains left at the operator's DNS provider,
   * Cloudgate never having written them: named when the Delete is asked,
   * and again in the audit entry of its end.
   */
  readonly dnsRecordsLeft: readonly DnsRecord[];
  /** Why the latest run did not finish, when it did not; `null` when it did. */
  readonly unfinished: string | null;
  /**
   * The Google Cloud accounts whose projects the label search after the
   * Delete looks in: every one any part of the Environment was in
   * when the Delete or a Retry was asked, kept so a Retry after its rows
   * are gone still searches them. Absent on an AWS-only Delete's record.
   */
  readonly labelSearchAccounts?: readonly string[];
  /**
   * What the latest label search found left, each part of
   * {@link left} too, until a later search replaces it; what Forget writes
   * into the audit entry with the rest.
   */
  readonly labelSearchLeft?: readonly EnvironmentLeftover[];
}

// Feature-module schema: the grouping inside a project that
// applications/databases/compose attach to.
export const environment = pgTable(
  'environment',
  {
    environmentId: nanoidPk('environment_id'),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: isoTimestamp('created_at'),
    projectId: text('project_id')
      .notNull()
      .references(() => project.projectId, { onDelete: 'cascade' }),
    env: encryptedText('env').notNull().default(''),
    // Where a Service a plan creates here will run. jsonb with no
    // foreign key, so the Server it names is guarded by
    // `ServersService.remove` instead. The column default is the platform host
    // so a row written below the API (a seed, a fixture) still holds a choice;
    // `EnvironmentsService.create` is what asks for one when the organization
    // has a Server to choose.
    deployTarget: jsonb('deploy_target')
      .$type<DeployTarget>()
      .notNull()
      .default({ kind: 'platform-host' }),
    // The branch a repository-kept Project config is read from for this
    // Environment; `null` is the repository's default branch. Also the
    // branch a plan-created Application building from the config's own
    // repository gets. Changing it reads nothing until the next plan.
    configBranch: text('config_branch'),
    /** A Delete in a Cloud account under way or incomplete; see {@link EnvironmentDeleteRecord}. */
    cloudDelete: jsonb('cloud_delete').$type<EnvironmentDeleteRecord>(),
  },
  // An Environment's name is unique in its Project regardless of letter
  // case, for the Project's reason in `project.schema.ts`.
  // `EnvironmentsService` turns a violation into a 409 (`mapUniqueViolation`).
  (table) => [
    uniqueIndex('unique_project_environment_name').on(
      table.projectId,
      sql`lower(${table.name})`,
    ),
  ],
);

export const environmentRelations = relations(environment, ({ one }) => ({
  project: one(project, {
    fields: [environment.projectId],
    references: [project.projectId],
  }),
}));

export type Environment = typeof environment.$inferSelect;
