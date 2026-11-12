import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { serviceNameSchema } from '../../common/service-name';
import { APP_NAME_MESSAGE, APP_NAME_REGEX } from '../../db/columns';
import { insideDirectorySchema } from '../../mounts/dto/mount.dto';
import { customGitUrlSchema } from '../../git-providers/git-clone-url';
import { composeFileParseRefusal } from '../compose.utils';
import { SIZE_NAMES } from '../../project-config/format/config-size';

/**
 * Stand-in for the stack's checked-out code directory. The real one is
 * `composeDirectoryOn(compose.serverId)/<appName>/code` on the stack's own
 * Server — what `getComposeFilePath` joins onto — but the rule is
 * base-invariant (see `insideDirectorySchema`), so a sentinel decides it once
 * for every stack. It once said `composeDirectory()`, a since-deleted local
 * spelling.
 */
const SENTINEL_COMPOSE_CODE_DIRECTORY = '/code';

/**
 * What a caller-supplied `composePath` may be.
 *
 * `getComposeFilePath` does
 * `join(composeDirectoryOn(compose.serverId), appName, 'code', path)`, which
 * *normalises*, and **three of its six callers write** through the result:
 * `getCreateComposeEnvFileCommand` puts the interpolated `.env` beside it
 * (`dirname` + a `printf` redirect), `getBuildComposeCommand` writes the
 * domain-injected compose file to it, and `composeStartCommand` rewrites that
 * file on a Start. The other three `cat` it, and `createComposeCommand` puts it
 * in `-f`/`-c` relative to a `cd <projectPath>`. So
 * `../../../etc/traefik/dynamic/x.yml` moved every one of those writes off the
 * stack's tree, on the stack's own Server as the account that drives Docker.
 * (This said "two of its four callers" and named the local `composeDirectory()`
 * — a census counted six and three.)
 *
 * Nesting is deliberately still legal and is a tested feature — a leading `./`
 * is the norm and `./deploy/docker-compose.yml` resolves inside the code
 * directory, which is why the rule is `resolve` + prefix rather than "no `..`"
 * or "one segment".
 *
 * The `.min(1)` is kept rather than dropped as redundant — the traversal
 * rule already refuses `''`, which resolves to the directory itself — because it
 * is what `openapi.json` publishes about the column, and the traversal rule is
 * invisible there.
 */
const composePathSchema = insideDirectorySchema(
  SENTINEL_COMPOSE_CODE_DIRECTORY,
  'composePath must stay inside the compose code directory',
  { subject: z.string().min(1) },
);

/**
 * A caller-supplied compose file has to be one `parse` can read.
 *
 * **What broke.** Nothing here refused content the parser rejects, so it reached
 * `ComposeService.assertComposeContentClaimable`, whose `readComposeHostClaims`
 * → `parseComposeFile` chain parses unguarded — a throw out of a guard
 * documented as 400-and-409, rendered a **500** on `POST /compose` and
 * `PATCH /compose/:id` alike. A file that will not parse is a shape violation,
 * so §2.4 puts the answer here: one 400, at this field's own path, for every
 * route that carries the field.
 *
 * `composeFileParseRefusal` owns *which* throws are the caller's file being
 * wrong and which stay a 500 — that is a two-class question, not the
 * syntax-error one it looks like, and its docblock is where the set is
 * enumerated. It is exported so `dto/ai.dto.ts`' `dockerCompose` can take the
 * same rule; `POST /ai/deploy` carries a caller-supplied compose file into
 * `createByTemplate` and had the same 500.
 *
 * **One constant shared by both schemas**, not the refinement written twice.
 * `updateComposeSchema` is its own `z.object({…}).partial()` rather than
 * `createComposeSchema.partial()` — the two objects overlap in three fields out
 * of forty — so §2.4's "derive, never re-declare" applies at the field: the
 * create schema takes `composeFileSchema.optional()` and the update schema takes
 * it as-is, and `.partial()` makes it optional there.
 *
 * **Empty stays legal, and so does a file with no services yet.** `composeFile`
 * is optional on create and the column defaults to empty, so a stack is
 * routinely created before its file is written; the empty-file refusal is
 * `parseComposeFileOrThrow`'s, at deploy and Converted time, and this rule does
 * not move it forward. Nor does it check that the document is a *compose spec*
 * — `just a string` parses, and what a parsed document has to contain is that
 * same helper's question. That helper answers it: a document
 * declaring neither `services` nor `include` is refused where the deploy would
 * act on it, which is a step later than this schema and deliberately so — a
 * half-written file is saved on the way to a finished one.
 *
 * **This is one of two places the rule lives**, deliberately:
 * `assertComposeContentClaimable` keeps its own half because it is also asked
 * about content that reached no DTO — the stored column on a `.partial()` PATCH
 * naming other fields, and the cloned repository a git-sourced stack's file
 * lives in. `composeFileParseRefusal` is the one sentence both say.
 */
export const composeFileSchema = z.string().superRefine((content, ctx) => {
  const refusal = composeFileParseRefusal(content);
  if (refusal) ctx.addIssue({ code: 'custom', message: refusal });
});

/**
 * Where a stack's compose file comes from: the shared `source_type` enum's
 * compose subset, without the Application-only `docker` and `drop`. One
 * constant because create and update both take it, and §2.4 says derive.
 */
export const composeSourceTypeSchema = z.enum([
  'git',
  'github',
  'gitlab',
  'bitbucket',
  'gitea',
  'raw',
]);

export type ComposeSourceType = z.infer<typeof composeSourceTypeSchema>;

// Create input: name/appName/description/environmentId/composeType/serverId/
// composeFile/sourceType — everything else is configured through update.
export const createComposeSchema = z.object({
  name: serviceNameSchema,
  appName: z
    .string()
    .min(1)
    .max(63)
    .regex(APP_NAME_REGEX, APP_NAME_MESSAGE)
    .optional(),
  description: z.string().optional(),
  environmentId: z.string().min(1, 'environmentId cannot be empty'),
  composeType: z.enum(['docker-compose', 'stack']).optional(),
  // `.nullish()`, not `.optional()`: a row on the platform host carries
  // `serverId: null`, so `null` is the value a client reads off the resource
  // and sends back — ADR-0008's "no server row" contract. `.optional()`
  // answered 400 to the API's own output; widening keeps every payload that
  // was already accepted.
  serverId: z.string().nullish(),
  composeFile: composeFileSchema.optional(),
  // #1338: optional, and inferred when left out — see `sourceTypeOnCreate`
  // (compose-source-type.ts).
  sourceType: composeSourceTypeSchema.optional(),
});

export class CreateComposeDto extends createZodDto(createComposeSchema) {}

// Update input: the configurable columns, all optional. No serverId, and no
// appName (immutable — it names the stack, networks and Traefik routers) or
// environmentId (compose stacks don't move environments). composeStatus changes
// go through the internal updateStatus instead.
//
// `composeType` **stays mutable**, and H-87 is the reason it is safe to. A
// deployed row whose type is flipped used to aim both halves of Delete's safety
// property — the teardown and the presence probe — at the wrong daemon
// subsystem, so the delete orphaned a running stack behind a bare 200. The fix
// is not a refusal here: it is that neither half consults the column any more
// (`compose.utils.ts`'s `readComposeWorkloadPresence` and
// `composeTeardownCommand`). Refusing the `PATCH` would have left the row whose
// type was wrong from the start — an import, a restore, a migration — orphanable
// by exactly the same path, and would have taken away a supported edit as well.
// So do not add `composeType` to the immutable list without moving the guard
// somewhere; a mutable discriminator is only a bug when something safety-shaped
// reads it.
export const updateComposeSchema = z
  .object({
    name: serviceNameSchema,
    description: z.string().nullable(),
    env: z.string().nullable(),
    composeFile: composeFileSchema,
    composePath: composePathSchema,
    composeType: z.enum(['docker-compose', 'stack']),
    command: z.string(),
    isolatedDeployment: z.boolean(),
    sourceType: composeSourceTypeSchema,
    triggerType: z.enum(['push', 'tag']).nullable(),
    autoDeploy: z.boolean().nullable(),
    watchPaths: z.array(z.string()).nullable(),
    enableSubmodules: z.boolean(),
    // GitHub
    repository: z.string().nullable(),
    owner: z.string().nullable(),
    branch: z.string().nullable(),
    githubId: z.string().nullable(),
    // GitLab
    gitlabProjectId: z.number().int().nullable(),
    gitlabRepository: z.string().nullable(),
    gitlabOwner: z.string().nullable(),
    gitlabBranch: z.string().nullable(),
    gitlabPathNamespace: z.string().nullable(),
    gitlabId: z.string().nullable(),
    // Gitea
    giteaRepository: z.string().nullable(),
    giteaOwner: z.string().nullable(),
    giteaBranch: z.string().nullable(),
    giteaId: z.string().nullable(),
    // Bitbucket
    bitbucketRepository: z.string().nullable(),
    bitbucketRepositorySlug: z.string().nullable(),
    bitbucketOwner: z.string().nullable(),
    bitbucketBranch: z.string().nullable(),
    bitbucketId: z.string().nullable(),
    // Custom git
    customGitUrl: customGitUrlSchema,
    customGitBranch: z.string().nullable(),
    customGitSSHKeyId: z.string().nullable(),
  })
  .partial();

export class UpdateComposeDto extends createZodDto(updateComposeSchema) {}

// Environment input (composeId travels in the URL, not the body).
export const saveComposeEnvironmentSchema = z.object({
  env: z.string().optional(),
});

export class SaveComposeEnvironmentDto extends createZodDto(
  saveComposeEnvironmentSchema,
) {}

/**
 * The stack page's Stack VM setting (#1372): a console-managed stack's
 * size, and the data disk grown to, in GB. Its next plan applies them.
 */
export const saveComposeStackVmSchema = z
  .object({
    size: z.enum(SIZE_NAMES).optional(),
    dataDiskGb: z.number().int().min(1).max(16384).optional(),
  })
  .strict()
  .refine(
    (body) => body.size !== undefined || body.dataDiskGb !== undefined,
    'Set a size, a data disk size, or both',
  );

export class SaveComposeStackVmDto extends createZodDto(
  saveComposeStackVmSchema,
) {}
