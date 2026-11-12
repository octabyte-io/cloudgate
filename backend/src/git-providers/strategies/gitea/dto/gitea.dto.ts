import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Create body: `name` names the base gitProvider row; the rest are the Gitea
// OAuth application credentials and the tokens obtained by the OAuth callback.
export const createGiteaSchema = z.object({
  name: z.string().min(1, 'name cannot be empty'),
  giteaUrl: z.string().min(1).optional(),
  giteaInternalUrl: z.string().nullish(),
  redirectUri: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().int().optional(),
  scopes: z.string().optional(),
  lastAuthenticatedAt: z.number().int().optional(),
});

export class CreateGiteaDto extends createZodDto(createGiteaSchema) {}

// Update body; giteaId travels in the URL. `name` still addresses the base
// gitProvider row.
export const updateGiteaSchema = createGiteaSchema.partial();

export class UpdateGiteaDto extends createZodDto(updateGiteaSchema) {}

/** A repository the connection can reach, as offered to the UI. */
export interface GiteaRepositoryDto {
  id: number;
  name: string;
  owner: string;
  url: string;
  /** The repository's default branch, as the provider reports it. */
  defaultBranch: string | null;
}

/** A branch of a reachable repository. */
export interface GiteaBranchDto {
  name: string;
  commitSha: string;
}

// Branches query; giteaId travels in the URL.
export const findGiteaBranchesSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

export class FindGiteaBranchesDto extends createZodDto(
  findGiteaBranchesSchema,
) {}
