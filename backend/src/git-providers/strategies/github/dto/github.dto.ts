import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Create body: `name` names the base gitProvider row; the rest are the GitHub
// App credentials from the app-manifest flow.
export const createGithubSchema = z.object({
  name: z.string().min(1, 'name cannot be empty'),
  appName: z.string().optional(),
  appId: z.number().int().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  installationId: z.string().optional(),
  privateKey: z.string().optional(),
  webhookSecret: z.string().optional(),
});

export class CreateGithubDto extends createZodDto(createGithubSchema) {}

// Update body; githubId travels in the URL. `name` still addresses the base
// gitProvider row.
export const updateGithubSchema = createGithubSchema.partial();

export class UpdateGithubDto extends createZodDto(updateGithubSchema) {}

/** A repository the app installation can reach, as offered to the UI. */
export interface GithubRepositoryDto {
  name: string;
  owner: string;
  url: string;
  /** The repository's default branch, as the provider reports it. */
  defaultBranch: string | null;
}

/** A branch of a reachable repository. */
export interface GithubBranchDto {
  name: string;
  commitSha: string;
}

// Branches query; githubId travels in the URL.
export const findGithubBranchesSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

export class FindGithubBranchesDto extends createZodDto(
  findGithubBranchesSchema,
) {}
