import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Redeploy input (the id travels in the URL, not the body).
export const redeployPreviewDeploymentSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
});

export class RedeployPreviewDeploymentDto extends createZodDto(
  redeployPreviewDeploymentSchema,
) {}

/**
 * How long a Requested preview is asked or extended for, in whole minutes.
 * Only the shape is checked here; the instance maximum is the refusal chain's
 * validation step, after the grant and the switch (`requested-preview.ts`).
 */
const ttlMinutesSchema = z
  .number()
  .int('ttlMinutes must be a whole number of minutes')
  .min(1, 'ttlMinutes must be at least 1');

/**
 * `POST /applications/:applicationId/preview-deployments` body.
 *
 * **A branch and nothing else about the source**: there is no field
 * for a repository URL or a fork, so the build can only clone the parent's own
 * repository through the parent's own connection. Nothing checks the branch
 * exists — a missing one fails the build, and the caller reads that in the
 * log. What is refused here is a name git could never check out: blank, with
 * whitespace or a control character, leading `-` (which a clone would read as
 * an option), or carrying one of the characters `git check-ref-format` forbids.
 */
export const createRequestedPreviewSchema = z.object({
  branch: z
    .string()
    .min(1, 'branch cannot be empty')
    .max(255, 'branch is longer than 255 characters')
    .regex(
      // eslint-disable-next-line no-control-regex
      /^(?!-)(?!.*\.\.)[^\s\x00-\x1f\x7f~^:?*[\\]+$/,
      'branch is not a name git can check out',
    ),
  ttlMinutes: ttlMinutesSchema.optional(),
});

export class CreateRequestedPreviewDto extends createZodDto(
  createRequestedPreviewSchema,
) {}

/** `POST /preview-deployments/:id/extend` body: a new window from now. */
export const extendRequestedPreviewSchema = z.object({
  ttlMinutes: ttlMinutesSchema.optional(),
});

export class ExtendRequestedPreviewDto extends createZodDto(
  extendRequestedPreviewSchema,
) {}
