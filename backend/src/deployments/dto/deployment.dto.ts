import {
  deploymentSchema,
  deploymentStatusSchema,
  triggerDeploymentSchema,
} from 'api-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export { triggerDeploymentSchema };

// The trigger body: the application travels in the URL, title/description
// default to the manual-deployment banner.
//
// `.default({})` is the whole body's default, not any one field's, and it is
// what makes a bodyless POST mean what the two optional fields already say it
// means. Express hands Nest `undefined` — not `{}` — when a request
// carries no body at all, so without it the object schema refused the call
// with a "Validation failed" whose `path` was empty and which named nothing a
// caller could fix. The console always sent a body and never saw it; a scripted
// `curl -X POST …/redeploy` with no `-d` saw nothing else.
//
// The schema lives in `api-schemas` because the Cloudgate CLI sends
// this body too (ADR 0046); the wrapper stays here, as every DTO's does.

export class TriggerDeploymentDto extends createZodDto(
  triggerDeploymentSchema,
) {}

// The organization-wide feed's query. A page is a limit plus an
// opaque cursor (the last row of the previous page), and the two filters the
// feed screen offers — a status and a project.
export const listDeploymentsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
  status: deploymentStatusSchema.optional(),
  projectId: z.string().min(1).optional(),
});

export class ListDeploymentsDto extends createZodDto(listDeploymentsSchema) {}

// How many lines of the log to tail.
export const readDeploymentLogsSchema = z.object({
  tail: z.coerce.number().int().min(1).max(10000).default(100),
});

export class ReadDeploymentLogsDto extends createZodDto(
  readDeploymentLogsSchema,
) {}

/**
 * `GET /deployments/:deploymentId`'s answer, declared for the OpenAPI
 * document only; the schema lives in `api-schemas` because the Cloudgate CLI
 * parses it with the same zod object.
 */
export class DeploymentStatusDto extends createZodDto(deploymentSchema) {}
