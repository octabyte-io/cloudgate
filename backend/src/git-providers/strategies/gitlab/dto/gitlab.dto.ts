import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Create body: `name` names the base gitProvider row; the rest are the GitLab
// OAuth application credentials and the tokens obtained by the OAuth callback.
export const createGitlabSchema = z.object({
  name: z.string().min(1, 'name cannot be empty'),
  gitlabUrl: z.string().min(1).optional(),
  gitlabInternalUrl: z.string().nullish(),
  applicationId: z.string().optional(),
  redirectUri: z.string().optional(),
  secret: z.string().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  groupName: z.string().optional(),
  expiresAt: z.number().int().optional(),
});

export class CreateGitlabDto extends createZodDto(createGitlabSchema) {}

// Update body; gitlabId travels in the URL. `name` still addresses the base
// gitProvider row.
export const updateGitlabSchema = createGitlabSchema.partial();

export class UpdateGitlabDto extends createZodDto(updateGitlabSchema) {}

/**
 * A project the connection can reach, as offered to the UI. GitLab addresses
 * projects by numeric id (branch listing) and by path namespace (cloning).
 */
export interface GitlabRepositoryDto {
  id: number;
  name: string;
  owner: string;
  pathNamespace: string;
  /** The repository's default branch, as the provider reports it. */
  defaultBranch: string | null;
}

/** A branch of a reachable project. */
export interface GitlabBranchDto {
  name: string;
  commitSha: string;
}

// Branches query; gitlabId travels in the URL and the project is addressed by
// the numeric id from the repositories listing.
export const findGitlabBranchesSchema = z.object({
  projectId: z.coerce.number().int().positive(),
});

export class FindGitlabBranchesDto extends createZodDto(
  findGitlabBranchesSchema,
) {}
