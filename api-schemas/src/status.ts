import { z } from 'zod';

/**
 * The reads `cloudgate status` makes: one Service's own row, its
 * Domains and its Deployments, as far as the CLI relies on them.
 *
 * **Only the fields status reads.** zod drops every other key, and that is the
 * point: `GET /applications/:id` carries the Application's decrypted `env`,
 * `buildArgs` and `buildSecrets`, and a database's row its password. None of
 * them is parsed, so none can reach anything the CLI prints. `customGitUrl` is
 * left out too: a git URL may carry a credential.
 *
 * The backend does not declare these answers with these objects yet; a route
 * that starts to (for its OpenAPI document) wraps them in `createZodDto`.
 */

/**
 * `GET /applications/:id`, `GET /compose/:id`, `GET /<engine>/:id` and
 * `GET /buckets/:id`: the one row every Service kind answers with. Each kind
 * carries only some of these; Compose names its state `composeStatus`.
 */
export const serviceRowSchema = z.object({
  /** `idle | running | done | error | stopped`, every kind but Compose. */
  applicationStatus: z.string().nullish(),
  /** The same enum, on a Compose stack. */
  composeStatus: z.string().nullish(),
  /** `docker | git | github | gitlab | bitbucket | gitea | drop | raw`. */
  sourceType: z.string().nullish(),
  dockerImage: z.string().nullish(),
  owner: z.string().nullish(),
  repository: z.string().nullish(),
  gitlabOwner: z.string().nullish(),
  gitlabRepository: z.string().nullish(),
  giteaOwner: z.string().nullish(),
  giteaRepository: z.string().nullish(),
  bitbucketOwner: z.string().nullish(),
  bitbucketRepository: z.string().nullish(),
});

/** `GET /applications/:id/domains` and its Compose and bucket siblings. */
export const serviceDomainListSchema = z.array(
  z.object({ host: z.string(), path: z.string().nullish() }),
);

/**
 * `GET /applications/:id/deployments` and `GET /compose/:id/deployments`,
 * newest first. `error` is what the console and the CLI call failed.
 */
export const serviceDeploymentListSchema = z.array(
  z.object({
    deploymentId: z.string(),
    status: z.string(),
    createdAt: z.string(),
  }),
);

export type ServiceRow = z.infer<typeof serviceRowSchema>;
export type ServiceDomainList = z.infer<typeof serviceDomainListSchema>;
export type ServiceDeploymentList = z.infer<typeof serviceDeploymentListSchema>;
