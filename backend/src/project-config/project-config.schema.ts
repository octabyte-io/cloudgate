import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { user } from '../auth/auth.schema';
import { encryptedText, isoTimestamp, nanoidPk } from '../db/columns';
import { environment } from '../environments/environment.schema';
import { gitProvider } from '../git-providers/git-provider.schema';
import type { GitProviderType } from '../git-providers/git-provider.schema';
import { project } from '../projects/project.schema';
import type {
  ConfigOutline,
  DeployTarget,
  PlanNote,
  PlanStep,
} from './planner/plan.types';
import type { PlanStepResult } from './applier/apply.types';

/**
 * Where a Project's config is kept (ADR-0029): `cloudgate`, with the
 * text here, or `repository`, read from a repository and never copied
 * here ("no fallback copy").
 */
export const projectConfigKindEnum = pgEnum('project_config_kind', [
  'cloudgate',
  'repository',
]);

/** Where a Cloudgate-kept config was read before it was moved out. */
export interface MovedOutOf {
  readonly providerType: GitProviderType | null;
  readonly repository: string;
  readonly path: string;
  readonly movedAt: string;
}

/**
 * One row per Project: its **Project config location**. A Project
 * created before configs existed has no row, and so no config, until the
 * upgrade step generates one at boot (`ConfigGenerationService`).
 *
 * `text` is `encryptedText` by ADR-0015's argument: it is a body the operator
 * authors (pasted whole on the Project config page), and YAML comments carry
 * anything at all, a credential included; nothing looks it up by value. What
 * a plan needs to know whether it has moved on is the hash of the text, which
 * is computed from the decrypted value and stored on the plan, not here.
 */
export const projectConfigLocation = pgTable(
  'project_config_location',
  {
    projectId: text('project_id')
      .primaryKey()
      .references(() => project.projectId, { onDelete: 'cascade' }),
    kind: projectConfigKindEnum('kind').notNull(),
    text: encryptedText('text'),
    /**
     * A repository-kept config's git provider connection, whose type
     * picks the config reader. `set null` when the connection is deleted, so
     * deleting one never deletes a Project's config location: every read then
     * refuses, naming the repository, until the config is moved.
     */
    gitProviderId: text('git_provider_id').references(
      () => gitProvider.gitProviderId,
      { onDelete: 'set null' },
    ),
    /** `owner/repo` as the provider names it; `null` when Cloudgate-kept. */
    repository: text('repository'),
    /** The file inside the repository, `cloudgate.yaml` unless named. */
    path: text('path'),
    /**
     * The file a config moved out of a repository was read from (US65), so the
     * config page can say it is no longer read; `null` once
     * the config moves into a repository again, and for one never moved out.
     */
    movedOutOf: jsonb('moved_out_of').$type<MovedOutOf>(),
    /**
     * The config's version (ADR-0080): moved by every write of the text and
     * every Apply, so a whole-YAML edit naming the version it started from
     * is refused once the config has moved on. Compared only for equality.
     */
    version: integer('version').notNull().default(1),
    /** Who last moved the version; `null` for Cloudgate itself, or before. */
    changedBy: text('changed_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: isoTimestamp('created_at'),
    /** When the version last moved, or the location changed. */
    updatedAt: isoTimestamp('updated_at'),
  },
  (table) => [
    // A Cloudgate-kept config is its text; a repository-kept one never has it.
    check(
      'project_config_location_text_iff_cloudgate',
      sql`(${table.kind} = 'cloudgate') = (${table.text} IS NOT NULL)`,
    ),
    // A repository-kept config names its repository and path, and only it.
    check(
      'project_config_location_repository_iff_repository',
      sql`(${table.kind} = 'repository') = (${table.repository} IS NOT NULL AND ${table.path} IS NOT NULL)`,
    ),
  ],
);

/** What made a plan: the ways a plan comes to exist. */
export const planSourceEnum = pgEnum('plan_source', [
  'push',
  'request',
  'save',
  'move',
  'generate',
  // A cloud Service's deploy that stopped on more than its new image.
  'deploy',
]);

/**
 * A plan's status. `open` is waiting for an Apply or a dismiss, and at most
 * one per Environment is (the partial unique index below). Beside the spec's
 * four (`open`, `applied`, `partly-applied`, `dismissed`), two record what a
 * newer plan did rather than what an operator did, so `dismissed` always names
 * a person: `superseded` is an open plan a newer one replaced (US22), and
 * `unchanged` is a plan that found nothing to change, which says so and is
 * never open (US24).
 */
export const planStatusEnum = pgEnum('plan_status', [
  'open',
  'applied',
  'partly-applied',
  'dismissed',
  'superseded',
  'unchanged',
]);

/**
 * A **Plan**: what applying the Project config would create,
 * change and destroy in one Environment, with notes. `textHash` and
 * `settingsFingerprint` are what it read, so an Apply can refuse a plan
 * that no longer describes reality (US23). `steps` and `notes` are the
 * planner's output as it was, kept so the plan reads the same later.
 */
export const plan = pgTable(
  'plan',
  {
    planId: nanoidPk('plan_id'),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.environmentId, { onDelete: 'cascade' }),
    source: planSourceEnum('source').notNull(),
    /**
     * `sha256:<hex>` of the text this plan was made from: the Cloudgate-kept
     * text, or the repository copy read at `commitSha`.
     */
    textHash: text('text_hash').notNull(),
    /**
     * The commit a repository-kept config was read at (US36), and the
     * Config branch it was read from. An Apply reads the branch again and is
     * refused when its head is no longer this commit. Both `null` on a plan
     * of a Cloudgate-kept config, which has no commit and whose `text` is set
     * instead: a repository copy's text is never stored (ADR-0029).
     */
    commitSha: text('commit_sha'),
    branch: text('branch'),
    /**
     * The config text this plan was made from, which an Apply writes
     * and stores. For a "Check for changes" it is the stored text; for a
     * whole-YAML edit it is the edited text, which is stored only when a plan
     * of it is applied. `encryptedText` for the reason the location's `text`
     * is. `null` on a plan made before this was stored, whose text is the stored one its
     * `textHash` names.
     */
    text: encryptedText('text'),
    /**
     * `sha256:<hex>` of the stored text when the plan was made. An Apply is
     * refused unless the stored text is still this one, or already the
     * plan's own (another Environment's plan of the same edit applied first).
     */
    baseTextHash: text('base_text_hash').notNull(),
    /** A hash of the saved settings (and Deploy target) it compared with. */
    settingsFingerprint: text('settings_fingerprint').notNull(),
    steps: jsonb('steps').$type<PlanStep[]>().notNull(),
    notes: jsonb('notes').$type<PlanNote[]>().notNull(),
    /**
     * Which Services the config it was made from listed, by Config name, with
     * each one's kind and whether it was `managed: console` — no field, no
     * value, so it is no copy of a repository-kept text (ADR-0029). The next
     * plan of a repository-kept config reads it as `previous`: only what the
     * config in effect described may be destroyed (US34). `null` on a plan
     * made before it was kept.
     */
    outline: jsonb('outline').$type<ConfigOutline>(),
    /**
     * The Environment's Deploy target when the plan was made, so an
     * Apply after a switch is refused saying so, not only as "settings
     * changed" (the fingerprint also covers it). `null` on a plan made before
     * it was kept.
     */
    deployTarget: jsonb('deploy_target').$type<DeployTarget>(),
    status: planStatusEnum('status').notNull(),
    /**
     * Each step's result, in the order the Apply ran them: what it
     * wrote and the Deployment it queued. `null` until the plan is applied.
     */
    results: jsonb('results').$type<PlanStepResult[]>(),
    /** Who asked; `null` for a plan no person asked for (a push). */
    requestedBy: text('requested_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: isoTimestamp('created_at'),
    appliedBy: text('applied_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    appliedAt: text('applied_at'),
    dismissedBy: text('dismissed_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    /** When it stopped being open by a dismiss, or by a newer plan. */
    dismissedAt: text('dismissed_at'),
  },
  (table) => [
    uniqueIndex('plan_one_open_per_environment')
      .on(table.environmentId)
      .where(sql`${table.status} = 'open'`),
    index('plan_environment_created_at_idx').on(
      table.environmentId,
      table.createdAt,
    ),
  ],
);

export const projectConfigLocationRelations = relations(
  projectConfigLocation,
  ({ one }) => ({
    project: one(project, {
      fields: [projectConfigLocation.projectId],
      references: [project.projectId],
    }),
    gitProvider: one(gitProvider, {
      fields: [projectConfigLocation.gitProviderId],
      references: [gitProvider.gitProviderId],
    }),
  }),
);

export const planRelations = relations(plan, ({ one }) => ({
  environment: one(environment, {
    fields: [plan.environmentId],
    references: [environment.environmentId],
  }),
}));

export type ProjectConfigLocation = typeof projectConfigLocation.$inferSelect;
export type Plan = typeof plan.$inferSelect;
export type PlanStatus = (typeof planStatusEnum.enumValues)[number];
export type PlanSource = (typeof planSourceEnum.enumValues)[number];
