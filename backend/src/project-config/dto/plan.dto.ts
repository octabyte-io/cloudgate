import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Dismiss names the plan it means: one a newer plan already replaced is
 * refused rather than the dismiss landing on the newer one.
 */
export const dismissPlanSchema = z.object({
  planId: z.string().min(1, 'planId cannot be empty'),
});

export class DismissPlanDto extends createZodDto(dismissPlanSchema) {}

const confirmedNames = z
  .array(z.string().min(1, 'a confirmed name cannot be empty'))
  .max(1000)
  .default([]);

/**
 * Apply names the plan it means, for the same reason dismiss does, and the
 * Config name of every Service it destroys and of every Service it
 * upgrades to a new major version: each set must equal the plan's
 * steps exactly, so an operator confirms each one by name. Absent is the
 * empty set, so a client that knows only `confirmDestroy` applies every
 * plan without a major upgrade as before.
 *
 * `deleteFilesOf` names the destroyed buckets whose files go too — "also
 * delete its files", one tick per bucket. Each must be a
 * bucket this plan destroys; absent is none, and every bucket that holds
 * files is kept.
 *
 * `deleteDataOf` names the destroyed cloud databases (a postgres on RDS, a
 * redis on ElastiCache) and Compose stacks on a Stack VM whose data goes
 * too — "also delete its data (no final snapshot)", one tick per destroy
 * row. Each must be one this plan destroys; absent is none, and every one
 * keeps a final snapshot.
 */
export const applyPlanSchema = dismissPlanSchema.extend({
  confirmDestroy: confirmedNames,
  confirmUpgrade: confirmedNames,
  deleteFilesOf: z
    .array(z.string().min(1, 'a bucket name cannot be empty'))
    .max(1000)
    .default([]),
  deleteDataOf: z
    .array(z.string().min(1, 'a database name cannot be empty'))
    .max(1000)
    .default([]),
});

export class ApplyPlanDto extends createZodDto(applyPlanSchema) {}

/**
 * The Project config page's whole-YAML edit: the full text, planned
 * against every Environment and stored only when a plan of it is applied.
 */
export const saveConfigTextSchema = z.object({
  text: z
    .string()
    .min(1, 'text cannot be empty')
    .max(256 * 1024, 'text must be at most 256 KiB'),
});

export class SaveConfigTextDto extends createZodDto(saveConfigTextSchema) {}

/**
 * Where a move takes the config, keyed on `kind`:
 *
 * - `repository`: a git provider connection of the caller's
 *   organization, the repository as that provider names it, and the file's
 *   path. Omitted, the move finds it once: `cloudgate.yaml`, or
 *   `cloudgate.yml` when every Config branch has only that, and stores the
 *   one it found (#1344). Left optional rather than defaulted so an
 *   explicit `cloudgate.yaml` is never searched for.
 * - `cloudgate`: out of the repository, keeping one copy as the
 *   Cloudgate-kept text — the copy `fromEnvironmentId`'s Config branch has,
 *   or, when omitted, the copy on the repository's default branch (US64).
 */
export const configLocationTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cloudgate'),
    fromEnvironmentId: z
      .string()
      .min(1, 'fromEnvironmentId cannot be empty')
      .nullish(),
  }),
  z.object({
    kind: z.literal('repository'),
    gitProviderId: z.string().min(1, 'gitProviderId cannot be empty'),
    repository: z
      .string()
      .trim()
      .max(512)
      .regex(
        /^[^/\s]+(\/[^/\s]+)+$/,
        'repository must be owner/repo as the provider names it',
      ),
    path: z
      .string()
      .trim()
      .max(1024)
      .regex(
        /^(?!\/)(?!(.*\/)?\.\.?(\/|$))[^\s\\]+$/,
        'path must name a file inside the repository, like cloudgate.yaml',
      )
      .optional(),
  }),
]);

export type ConfigLocationTarget = z.infer<typeof configLocationTargetSchema>;

export const previewMoveSchema = z.object({ to: configLocationTargetSchema });

export class PreviewMoveDto extends createZodDto(previewMoveSchema) {}

/**
 * What one Environment's copy at the new place read as in the preview: the
 * commit (a repository's) and the hash of the text. A confirm carries every
 * Environment's back, and is refused if any changed.
 */
export const configReadSchema = z.object({
  environmentId: z.string().min(1),
  commitSha: z.string().min(1).nullable(),
  textHash: z.string().min(1),
});

export type ConfigRead = z.infer<typeof configReadSchema>;

export const confirmMoveSchema = previewMoveSchema.extend({
  reads: z.array(configReadSchema).max(1000),
});

export class ConfirmMoveDto extends createZodDto(confirmMoveSchema) {}
