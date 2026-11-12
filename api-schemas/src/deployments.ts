import { z } from 'zod';

/**
 * A Deployment as the Cloudgate CLI reads it: `deploy` and `logs`
 * follow a Deployment log that never closes on its own (`tail -f` behind
 * `/listen-deployment`), so they stop when this says the Deployment finished.
 */

/**
 * Every status a Deployment row can hold (`deploymentStatusEnum` in
 * `backend/src/deployments/deployment.schema.ts`). A failed Deployment is
 * `error` on the wire, as in every other route; the CLI's words say "failed".
 */
export const DEPLOYMENT_STATUSES = [
  'pending',
  'running',
  'done',
  'error',
  'cancelled',
  'held',
] as const;

export const deploymentStatusSchema = z.enum(DEPLOYMENT_STATUSES);

/** The statuses a Deployment never leaves. */
export const FINISHED_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  'done',
  'error',
  'cancelled',
];

/**
 * `GET /deployments/:id`: one Deployment's status and times, ISO 8601.
 * `startedAt` is null until a build starts (and on rows from before it was
 * kept), `finishedAt` until it finishes. The answer to
 * `POST /applications/:id/deployments` carries the same fields, among others.
 */
export const deploymentSchema = z.object({
  deploymentId: z.string(),
  status: deploymentStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

/**
 * The body of `POST /applications/:applicationId/deployments` (and of its
 * redeploy and Compose siblings): the Service travels in the URL, and both
 * fields default to the manual-deployment banner. `.default({})` makes a
 * bodyless POST mean the same.
 */
export const triggerDeploymentSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .default({});

/**
 * `GET /applications/:applicationId/deployments`, newest first, as far as
 * `cloudgate deploy` reads it to find a build in progress. The list
 * also carries a preview's builds, a Cron service's runs and an Environment
 * network's runs for the Service (`applicationId` null), which read no
 * uploaded tree; these fields tell them apart.
 */
export const applicationBuildListSchema = z.array(
  z.object({
    deploymentId: z.string(),
    status: z.string(),
    createdAt: z.string(),
    applicationId: z.string().nullish(),
    previewDeploymentId: z.string().nullish(),
    cronRun: z.unknown().optional(),
  }),
);

export type ApplicationBuildList = z.infer<typeof applicationBuildListSchema>;

export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;
export type DeploymentView = z.infer<typeof deploymentSchema>;
