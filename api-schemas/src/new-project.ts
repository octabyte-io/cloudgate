import { z } from "zod";

/**
 * A Project created from the CLI (spec #14, ADR-0080): the routes "Create a
 * new Project" at a first `cloudgate deploy` reads and writes, as far as the
 * CLI relies on them, and the starter `cloudgate.yaml` it stores.
 */

/**
 * The Project config a Project created from the CLI starts with, stored in
 * Cloudgate and written to the new Project folder as its working copy. It
 * holds no app, so a plan of it changes nothing, and one commented example of
 * an app built from a subfolder. Shared so the backend's suite can hold the
 * text the CLI writes, example and all, to the config parser.
 */
export const STARTER_PROJECT_CONFIG = [
  "# This Project's config. Cloudgate keeps it; this file is your working copy.",
  "# Add your apps under services, then run cloudgate deploy here: it shows",
  "# the plan, applies it on a yes, and builds each app from its folder.",
  "version: 1",
  "services:",
  "  # An app built from a subfolder of this folder names it as its source:",
  "  # web:",
  "  #   kind: web",
  "  #   source: { folder: apps/web }",
  "",
].join("\n");

/** `POST /projects`: the Project made. */
export const createdProjectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
});

/** `POST /environments`: the Environment made. */
export const createdEnvironmentSchema = z.object({
  environmentId: z.string(),
  name: z.string(),
});

/**
 * `GET /servers`: only what offering a Server as a Deploy target reads. A
 * `build` Server runs no Service, and a Bought Server is not one to deploy to
 * until its stage is `ready`.
 */
export const serverListSchema = z.array(
  z.object({
    serverId: z.string(),
    name: z.string(),
    serverType: z.string(),
    ipAddress: z.string(),
    boughtServer: z.object({ stage: z.string() }).nullable().optional(),
  }),
);

/** `GET /cloud-accounts`: only what offering one as a Deploy target reads. */
export const cloudAccountListSchema = z.array(
  z.object({
    cloudAccountId: z.string(),
    name: z.string(),
    /** `aws` or `gcp`. */
    cloud: z.string(),
    /** The cloud's own id for the account. */
    cloudId: z.string().nullable().optional(),
  }),
);
