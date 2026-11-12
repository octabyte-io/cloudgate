import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { deployTargetSchema } from '../deploy-target';

// Create input: name/projectId and an optional `env`, as in the project DTO —
// the name trimmed for the same reason.
// `description` takes the same optional shape the project DTO already has: an
// Environment named `blue` or `pr-482` needs the note more than its Project
// does.
export const createEnvironmentSchema = z.object({
  name: z.string().trim().min(1, 'name cannot be empty'),
  description: z.string().optional(),
  projectId: z.string().min(1, 'projectId cannot be empty'),
  env: z.string().optional(),
  // Where a Service a plan creates here will run. Optional on the wire
  // only: `EnvironmentsService.create` refuses its absence once the
  // organization has a deploy Server, and takes the platform host otherwise.
  deployTarget: deployTargetSchema.optional(),
  // The branch a repository-kept Project config is read from here;
  // `null` (or an empty string, which a cleared form field sends) is the
  // repository's default branch.
  configBranch: z
    .string()
    .trim()
    .max(255, 'configBranch must be at most 255 characters')
    .regex(
      /^$|^(?!-)(?!.*\.\.)(?!.*\/\/)[^\s~^:?*[\\]+(?<![./])$/,
      'configBranch must be a git branch name',
    )
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
});

export class CreateEnvironmentDto extends createZodDto(
  createEnvironmentSchema,
) {}

// The list route's input: projectId as a query param.
export const listEnvironmentsSchema = createEnvironmentSchema.pick({
  projectId: true,
});

export class ListEnvironmentsDto extends createZodDto(listEnvironmentsSchema) {}

// Update input (partial fields; environmentId travels in the URL, not the body
// — environments don't move projects).
export const updateEnvironmentSchema = createEnvironmentSchema
  .omit({ projectId: true })
  .partial();

export class UpdateEnvironmentDto extends createZodDto(
  updateEnvironmentSchema,
) {}
