import { z } from "zod";

/**
 * The reads the Cloudgate CLI's target lookup makes: Organizations,
 * Projects, Environments and an Environment's Services, as far as the CLI
 * relies on them.
 *
 * **Only the fields the lookup reads.** zod drops every other key, and that is
 * the point: `GET /projects` carries a Project's shared variables (`env`,
 * decrypted on read) and a Cloudgate-kept config view carries the whole config
 * `text`. Neither may reach anything the CLI prints, so neither is parsed —
 * except by {@link projectConfigCopySchema}, whose `text` is written to a
 * Project folder's `cloudgate.yaml` and never printed.
 *
 * The backend does not declare these answers with these objects yet; a route
 * that starts to (for its OpenAPI document) wraps them in `createZodDto`.
 */

/** `GET /organizations`: each Organization with the caller's membership. */
export const organizationListSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
  }),
);

/** `GET /projects`, in the Organization `x-organization-id` names. */
export const projectListSchema = z.array(
  z.object({ projectId: z.string(), name: z.string() }),
);

/** `GET /environments?projectId=`. */
export const environmentListSchema = z.array(
  z.object({ environmentId: z.string(), name: z.string() }),
);

/** `GET /environments/:id`: the Environment and every Service in it. */
export const environmentWithServicesSchema = z.object({
  environmentId: z.string(),
  name: z.string(),
  services: z.array(
    z.object({
      /** `application`, `compose`, `postgres`, … */
      serviceType: z.string(),
      serviceId: z.string(),
      name: z.string(),
      /** The Service's fixed key in a Project config. */
      configName: z.string(),
    }),
  ),
});

/**
 * `GET /projects/:projectId/config`: where the Project's config is kept. Only
 * a repository location says anything the CLI can match a folder against;
 * every other kind is read as "not in a repository".
 */
export const projectConfigLocationSchema = z.object({
  location: z
    .object({
      kind: z.string(),
      repository: z.string().nullish(),
      path: z.string().nullish(),
    })
    .nullable(),
});

/**
 * `GET /projects/:projectId/config` as a Project folder reads it (ADR-0080):
 * a Cloudgate-kept config's text and version, which `cloudgate link` and
 * `cloudgate config pull` write to `cloudgate.yaml` and record; or, kept in
 * a repository, where, which they name when they refuse it. `version` is
 * compared only for equality.
 */
export const projectConfigCopySchema = z.object({
  location: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("cloudgate"),
        text: z.string(),
        version: z.number().int(),
      }),
      z.object({
        kind: z.literal("repository"),
        repository: z.string(),
        path: z.string(),
        version: z.number().int(),
      }),
    ])
    .nullable(),
});

/**
 * `GET /environments/:environmentId/config/repository-sources`: the
 * Services the Project config, as this Environment reads it, gives a
 * repository as their source, and where that config is kept (`null`: the
 * Project has none). `cloudgate deploy` refuses to upload to such a Service
 * while the config is kept in a repository: the file is the record, and its
 * next plan would put the repository back. A Cloudgate-kept entry is
 * rewritten by the upload itself, as by any console Save.
 *
 * `provider` is `github`, `gitlab`, `bitbucket`, `gitea`, or `git` for a
 * plain URL; `repository` is `owner/repo`, or that URL (the format refuses
 * one carrying a credential). `readable` is false when the config is kept in
 * a repository Cloudgate cannot read now, or does not parse: then the list
 * says nothing, and the upload's own refusal speaks if the config objects.
 */
export const configRepositorySourcesSchema = z.object({
  keptIn: z.enum(["cloudgate", "repository"]).nullable(),
  readable: z.boolean(),
  services: z.array(
    z.object({
      configName: z.string(),
      provider: z.string(),
      repository: z.string(),
    }),
  ),
});

export type ConfigRepositorySources = z.infer<
  typeof configRepositorySourcesSchema
>;

export type OrganizationList = z.infer<typeof organizationListSchema>;
export type ProjectList = z.infer<typeof projectListSchema>;
export type EnvironmentList = z.infer<typeof environmentListSchema>;
export type EnvironmentWithServices = z.infer<
  typeof environmentWithServicesSchema
>;
export type ProjectConfigLocation = z.infer<typeof projectConfigLocationSchema>;
export type ProjectConfigCopy = z.infer<typeof projectConfigCopySchema>;
