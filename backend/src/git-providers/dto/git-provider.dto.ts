import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const gitProviderTypeSchema = z.enum([
  'github',
  'gitlab',
  'bitbucket',
  'gitea',
]);

export const createGitProviderSchema = z.object({
  name: z.string().min(1, 'name cannot be empty'),
  providerType: gitProviderTypeSchema.default('github'),
});

export class CreateGitProviderDto extends createZodDto(
  createGitProviderSchema,
) {}

// Partial update; gitProviderId travels in the URL.
export const updateGitProviderSchema = createGitProviderSchema.partial();

export class UpdateGitProviderDto extends createZodDto(
  updateGitProviderSchema,
) {}
