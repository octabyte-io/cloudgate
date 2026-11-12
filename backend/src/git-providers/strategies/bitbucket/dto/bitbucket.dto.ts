import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Create body: `name` names the base gitProvider row; the rest are the
// Basic-auth credentials (API token or app password).
export const createBitbucketSchema = z.object({
  name: z.string().min(1, 'name cannot be empty'),
  bitbucketUsername: z.string().optional(),
  bitbucketEmail: z.string().optional(),
  appPassword: z.string().optional(),
  apiToken: z.string().optional(),
  bitbucketWorkspaceName: z.string().optional(),
});

export class CreateBitbucketDto extends createZodDto(createBitbucketSchema) {}

// Update body; bitbucketId travels in the URL. `name` still addresses the base
// gitProvider row.
export const updateBitbucketSchema = createBitbucketSchema.partial();

export class UpdateBitbucketDto extends createZodDto(updateBitbucketSchema) {}

/**
 * A repository the connection can reach, as offered to the UI. Bitbucket
 * addresses repositories by workspace + slug.
 */
export interface BitbucketRepositoryDto {
  name: string;
  slug: string;
  owner: string;
  url: string;
  /** The repository's default branch, as the provider reports it. */
  defaultBranch: string | null;
}

/** A branch of a reachable repository. */
export interface BitbucketBranchDto {
  name: string;
  commitSha: string;
}

// Branches query; bitbucketId travels in the URL.
export const findBitbucketBranchesSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

export class FindBitbucketBranchesDto extends createZodDto(
  findBitbucketBranchesSchema,
) {}
