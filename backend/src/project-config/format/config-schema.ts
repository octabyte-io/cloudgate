import { z } from 'zod';

import { buildTypeEnum } from '../../applications/application.schema';
import type { ServiceType } from '../../applications/application.schema';
import {
  DURATION,
  formatTimeout,
  isIanaTimezone,
  MAX_TIMEOUT_SECONDS,
  scheduleProblem,
  timeoutSeconds,
} from '../../cron-services/cron-fields';
import { buildPathSchema } from '../../common/build-path';
import { gitCloneUrlSchema } from '../../git-providers/git-clone-url';
import { insideDirectorySchema } from '../../mounts/dto/mount.dto';
import { nativeWireSchema } from '../../native/native-wire';
import { imageReferenceSchema } from '../../registries/dto/registry.dto';
import { sizeWireSchema } from './config-size';

/**
 * The `version: 1` Project config, **as it is written**: snake_case
 * field names, a size by name or pair, a source by provider key. This file is
 * the single source for two things that must never disagree — what
 * {@link parseProjectConfig} accepts and the JSON Schema an editor is served at
 * `/schema/project-config/v1.json` — which is why it holds no `.transform()`:
 * Zod's `toJSONSchema` cannot describe one, and the backend names are given in
 * `config-wire.ts` instead, in one place.
 *
 * Every object is strict, so a field Cloudgate does not know refuses the plan
 * and is named, rather than being skipped. A refinement (the git URL's
 * credentials, `publish` staying inside the build directory) is the parser's
 * alone: JSON Schema cannot say it, and an editor not saying it costs only an
 * error one step later.
 */

/**
 * A Config name: lowercase letters, digits and hyphens, starting with a
 * letter, at most 63 characters (`CONTEXT.md`, **Config name**).
 */
export const CONFIG_NAME_REGEX = /^[a-z][a-z0-9-]{0,62}$/;

/** The kinds this version can describe; any other is `managed: console`. */
export const EXPRESSIBLE_KINDS = [
  'web',
  'web-private',
  'static',
  'worker',
  'postgres',
  'mysql',
  'redis',
  'cron',
  'bucket',
  'compose',
] as const;

/**
 * The Service kinds whose rows those kinds describe — an Application is a
 * `web`, a `web-private`, a `static` or a `worker`, a Compose stack a
 * `compose` (ADR-0069) — so every other kind is console-managed. The one list
 * the saved-settings reader, the console Saves seam and the locks read.
 */
export const EXPRESSIBLE_SERVICE_TYPES = [
  'application',
  'postgres',
  'mysql',
  'redis',
  'bucket',
  'compose',
] as const satisfies readonly ServiceType[];

export type ExpressibleServiceType = (typeof EXPRESSIBLE_SERVICE_TYPES)[number];

export function isExpressibleServiceType(
  serviceType: ServiceType,
): serviceType is ExpressibleServiceType {
  return (EXPRESSIBLE_SERVICE_TYPES as readonly ServiceType[]).includes(
    serviceType,
  );
}

/** The git providers a `source` may name, each by `owner/repo`. */
export const SOURCE_PROVIDERS = [
  'github',
  'gitlab',
  'gitea',
  'bitbucket',
] as const;

/**
 * A variable's name, never its value (ADR-0006). Loose on purpose: the
 * names are compared with the keys of a stored dotenv blob, and a rule stricter
 * than what that blob already holds would refuse a config generated from it.
 */
const VARIABLE_NAME_REGEX = /^[^\s=]+$/;

const variableName = z
  .string({
    error: 'must be a variable name; only env takes a link to an Output',
  })
  .regex(VARIABLE_NAME_REGEX, 'must be a variable name, with no value');

/** `build_args` and `build_secrets`: names only, never a link (ADR-0031). */
const variableNames = z
  .array(variableName)
  .refine((names) => new Set(names).size === names.length, {
    message: 'lists a variable name twice',
  });

/**
 * A link's target, `<Config name>.<Output>` (ADR-0031). Which Outputs exist
 * depends on the source's kind and Deploy target, so that is the planner's
 * check; here it is only the shape.
 */
export const LINK_TARGET_REGEX = new RegExp(
  `${CONFIG_NAME_REGEX.source.slice(0, -1)}\\.[a-z][a-z_]*$`,
);

/**
 * A wired variable (ADR-0031): a one-key map `{ NAME: <service>.<output> }`,
 * whose value Cloudgate fills in at each deploy.
 */
const variableLink = z
  .record(
    z.string().regex(VARIABLE_NAME_REGEX, 'must be a variable name'),
    z
      .string()
      .regex(
        LINK_TARGET_REGEX,
        'must link to <service>.<output>, e.g. pg-1.url',
      ),
  )
  .refine((link) => Object.keys(link).length === 1, {
    message: 'must link one variable: { NAME: <service>.<output> }',
  })
  .meta({ minProperties: 1, maxProperties: 1 });

/** An `env` entry's name, whether it is a plain name or a link. */
export function envEntryName(entry: string | Record<string, string>): string {
  return typeof entry === 'string' ? entry : Object.keys(entry)[0];
}

/**
 * `env`: each entry a variable name, or a link to another Service's Output
 * (ADR-0031). A name is listed once, whichever form it takes.
 */
const envEntries = z.array(z.union([variableName, variableLink])).refine(
  (entries) => {
    const names = entries.map(envEntryName);
    return new Set(names).size === names.length;
  },
  { message: 'lists a variable name twice' },
);

const nonEmpty = z.string().min(1, 'cannot be empty');

/**
 * Whether a git URL carries a credential: a password anywhere, or any user on
 * `http(s)` (a token in the user slot is how GitHub and GitLab take one). The
 * user of an `ssh://git@…` or scp-like `git@host:path` URL is the login, not a
 * secret, so those pass. A URL is refused rather than stripped: the operator
 * wrote the credential into text they may commit, and quietly dropping it would
 * leave it there (the generated config's rule, held at the parser too).
 */
export function gitUrlCarriesCredentials(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.password) return true;
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    parsed.username !== ''
  );
}

const repositoryPath = z
  .string()
  .regex(/^[^/\s]+(\/[^/\s]+)+$/, 'must be owner/repo');

/**
 * A folder inside the repository, `/` its root; never one that leaves it
 * (`buildPathRefusal`).
 */
const buildPath = buildPathSchema('the build path', nonEmpty);

const providerSources = SOURCE_PROVIDERS.map((provider) =>
  z.strictObject({ [provider]: repositoryPath, path: buildPath.optional() }),
);

const gitSource = z.strictObject({
  git: gitCloneUrlSchema.refine((url) => !gitUrlCarriesCredentials(url), {
    message:
      'carries a credential; give the URL without it and keep the credential in Cloudgate',
  }),
  path: buildPath.optional(),
});

const imageSource = z.strictObject({ image: imageReferenceSchema() });

const repositorySource = z.union([...providerSources, gitSource]);

/**
 * `publish` names a directory inside the built image, so it stays inside the
 * build directory; `/code` stands in for that directory, as it does in
 * `application.dto.ts`.
 */
const publishDirectory = insideDirectorySchema(
  '/code',
  'must stay inside the build directory',
  { subject: nonEmpty },
);

const sharedBuild = {
  publish: publishDirectory.optional(),
  create_env_file: z.boolean().optional(),
  submodules: z.boolean().optional(),
  watch_paths: z.array(nonEmpty).optional(),
};

/** `static` is the `static` kind, not a `web` build type. */
const WEB_BUILD_TYPES = buildTypeEnum.enumValues.filter(
  (type) => type !== 'static',
) as [string, ...string[]];

const webBuild = z.strictObject({
  type: z.enum(WEB_BUILD_TYPES).optional(),
  railpack_version: nonEmpty.optional(),
  heroku_version: nonEmpty.optional(),
  dockerfile: nonEmpty.optional(),
  context: nonEmpty.optional(),
  stage: nonEmpty.optional(),
  ...sharedBuild,
});

const staticBuild = z.strictObject({
  spa: z.boolean().optional(),
  ...sharedBuild,
});

/**
 * `native` (ADR-0044): settings in a Deploy target's own language, on
 * every described entry and never on a console-managed one. Adding it
 * did not move `version`: adding anything optional never does.
 */
const native = { native: nativeWireSchema.optional() };

const shared = {
  description: z.string().optional(),
  size: sizeWireSchema.optional(),
  env: envEntries.optional(),
  ...native,
};

const buildable = {
  ...shared,
  command: nonEmpty.optional(),
  args: z.array(z.string()).optional(),
  build_args: variableNames.optional(),
  build_secrets: variableNames.optional(),
};

const webEntry = z.strictObject({
  kind: z.literal('web'),
  ...buildable,
  source: z.union([repositorySource, imageSource]).optional(),
  build: webBuild.optional(),
  port: z.number().int().min(1).max(65535).optional(),
});

/**
 * A `web` other Services on its Server reach at its internal address and
 * nothing outside can: `web`'s fields, with `port` required, since the
 * port is what its callers are given.
 */
const webPrivateEntry = webEntry.extend({
  kind: z.literal('web-private'),
  port: webEntry.shape.port.unwrap(),
});

/**
 * A Worker: a `web` with no `port`, which runs all the time and never
 * gets a Domain or a preview. Strict, so a `port` on one is named like any
 * other field Cloudgate does not know; there is no `replicas` either, the
 * count staying Cloudgate's per Environment.
 */
const workerEntry = webEntry
  .omit({ port: true })
  .extend({ kind: z.literal('worker') });

const staticEntry = z.strictObject({
  kind: z.literal('static'),
  ...buildable,
  source: repositorySource.optional(),
  build: staticBuild.optional(),
});

/**
 * A Cron service's timetable: five-field unix cron only, so the
 * same text means the same thing on a Server and in a cloud. Each refusal is
 * its own sentence (`cron-fields.ts`); the JSON Schema shows a string.
 */
const cronSchedule = z.string().superRefine((schedule, ctx) => {
  const problem = scheduleProblem(schedule);
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
});

const ianaTimezone = z
  .string()
  .refine(
    isIanaTimezone,
    'must be an IANA time zone name, e.g. Europe/Berlin or UTC',
  );

const cronTimeout = z
  .string()
  .regex(DURATION, 'must be a duration in minutes or hours, e.g. 30m or 2h')
  .refine(
    (timeout) => (timeoutSeconds(timeout) ?? 0) <= MAX_TIMEOUT_SECONDS,
    `is longer than the ${formatTimeout(MAX_TIMEOUT_SECONDS)} a run may take`,
  );

/**
 * A Cron service (ADR-0034): a `web`'s build fields without `port`,
 * a `command` it must name, since a run is a command that exits, and its
 * timetable. `timezone` is `UTC` and `timeout` `1h` when left out.
 */
const cronEntry = webEntry.omit({ port: true }).extend({
  kind: z.literal('cron'),
  command: nonEmpty,
  schedule: cronSchedule,
  timezone: ianaTimezone.optional(),
  timeout: cronTimeout.optional(),
});

/**
 * A database's `version` is its image tag, so `postgres` with `version: "18"`
 * runs `postgres:18`. A string only: YAML reads `version: 8.0` as the number 8,
 * and an image tag that silently lost its `.0` would be a different image.
 */
const imageTag = z
  .string({ error: 'must be a quoted image tag, e.g. "18"' })
  .regex(/^[\w][\w.-]{0,127}$/, 'must be an image tag, e.g. "18"');

const postgresEntry = z.strictObject({
  kind: z.literal('postgres'),
  ...shared,
  version: imageTag.optional(),
  database: nonEmpty.optional(),
  user: nonEmpty.optional(),
});

/** MySQL's own limit on a user name, which Cloudgate never shortens. */
export const MYSQL_USER_MAX_LENGTH = 32;

/**
 * A `mysql` takes exactly a `postgres`'s fields. No root password,
 * `charset` or `collation`: Cloudgate generates both passwords, and the
 * image's own defaults stand. A `user` past MySQL's limit is refused, never
 * shortened; a Config name that would default past it is the parser's check,
 * since the schema does not see the key.
 */
const mysqlEntry = z.strictObject({
  kind: z.literal('mysql'),
  ...shared,
  version: imageTag.optional(),
  database: nonEmpty.optional(),
  user: nonEmpty
    .max(
      MYSQL_USER_MAX_LENGTH,
      `is longer than MySQL's ${MYSQL_USER_MAX_LENGTH} characters; write a shorter user:`,
    )
    .optional(),
});

const redisEntry = z.strictObject({
  kind: z.literal('redis'),
  ...shared,
  version: imageTag.optional(),
});

/**
 * A Bucket: its kind and description only. No
 * `size`, since a size is CPU and memory and a bucket has neither; no `env`,
 * since it reads no variables; no region, versioning or place, which are
 * Cloudgate's or its Environment's. Strict, so any of them is named as a
 * field Cloudgate does not know. Its `native` is read so the plan can refuse
 * a `native.docker` on it by name rather than as an unknown field.
 */
const bucketEntry = z.strictObject({
  kind: z.literal('bucket'),
  description: z.string().optional(),
  ...native,
});

/** What a `compose` entry's `type` is when it names none. */
export const DEFAULT_COMPOSE_TYPE = 'docker-compose';

/** What a `compose` entry's `file` is when it names none. */
export const DEFAULT_COMPOSE_FILE = 'docker-compose.yml';

/**
 * A `compose` entry's repository: one provider key or a git URL, and no
 * `path`, since `file` is the path, from the repository's root.
 */
const composeSource = z.union([
  ...SOURCE_PROVIDERS.map((provider) =>
    z.strictObject({ [provider]: repositoryPath }),
  ),
  gitSource.omit({ path: true }),
]);

/**
 * The compose file a `compose` entry names, from the repository's root,
 * never one that leaves it; `/code` stands in for the stack's checked-out
 * code directory, as it does in `compose.dto.ts`.
 */
const composeFile = insideDirectorySchema(
  '/code',
  'must stay inside the repository',
  { subject: nonEmpty },
);

/**
 * A Compose stack (ADR-0069): the compose file it is built and deployed
 * from, **named, never held** — its repository, the file's path in it and
 * how it is deployed. Nothing of the file's contents is a field, and neither
 * is anything that differs per Environment (branch, Domains, mounts,
 * variable values, run Server), which stay Cloudgate's. Its `native` is read
 * so the plan can refuse it by name: a stack's container settings are its
 * compose file's.
 */
const composeEntry = z.strictObject({
  kind: z.literal('compose'),
  source: composeSource,
  file: composeFile.optional(),
  type: z.enum(['docker-compose', 'stack']).optional(),
  /**
   * In a Cloud Environment, the size of the stack's Stack VM
   * (ADR-0070): the smallest machine type at least as large. On a Server
   * a stack shares the Server, so it picks nothing there.
   */
  size: sizeWireSchema.optional(),
  ...native,
});

/**
 * A Service listed by name and kind only. Any kind may be, an
 * expressible one included: removing `managed: console` from it is how an
 * operator hands it to the config.
 */
export const consoleManagedEntrySchema = z.strictObject({
  kind: z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be a kind, e.g. mongo'),
  managed: z.literal('console'),
});

export const describedEntrySchema = z.discriminatedUnion('kind', [
  webEntry,
  webPrivateEntry,
  staticEntry,
  workerEntry,
  postgresEntry,
  mysqlEntry,
  redisEntry,
  cronEntry,
  bucketEntry,
  composeEntry,
]);

export const serviceEntrySchema = z.union([
  consoleManagedEntrySchema,
  describedEntrySchema,
]);

export const projectConfigWireSchema = z
  .strictObject({
    version: z.literal(1),
    services: z
      .record(z.string().regex(CONFIG_NAME_REGEX), serviceEntrySchema)
      // `services:` with nothing under it is YAML's null: a config whose last
      // Service was just removed, not a malformed one.
      .nullable()
      .optional(),
  })
  .meta({
    title: 'Cloudgate Project config, version 1',
    description:
      'What a Cloudgate Project runs: its Services, keyed by Config name.',
  });

export type ProjectConfigWire = z.infer<typeof projectConfigWireSchema>;
export type ServiceEntryWire = z.infer<typeof serviceEntrySchema>;

/**
 * The JSON Schema served unauthenticated at `/schema/project-config/v1.json`,
 * generated from the very schema the parser runs, so the two cannot drift.
 * Computed on each call rather than at import time; it is cheap, and
 * nothing holds a copy that could go stale.
 */
export function projectConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(projectConfigWireSchema, {
    target: 'draft-7',
  });
}
