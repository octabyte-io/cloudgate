import {
  changeVariablesSchema,
  uploadApplicationDropSchema as sharedUploadApplicationDropSchema,
  variableListSchema,
} from 'api-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { buildPathSchema } from '../../common/build-path';
import { serviceNameSchema } from '../../common/service-name';
import {
  createAiModelSchema,
  updateAiModelSchema,
} from '../../ai-models/dto/ai-model.dto';
import { APP_NAME_MESSAGE, APP_NAME_REGEX } from '../../db/columns';
import {
  INVALID_HOSTNAME_MESSAGE,
  hostSchema,
} from '../../domains/dto/domain.dto';
import { insideDirectorySchema } from '../../mounts/dto/mount.dto';
import { customGitUrlSchema } from '../../git-providers/git-clone-url';
import {
  imageReferenceSchema,
  registryUrlSchema,
} from '../../registries/dto/registry.dto';
import {
  endpointSpecSwarmSchema,
  healthCheckSwarmSchema,
  labelsSwarmSchema,
  networkSwarmSchema,
  placementSwarmSchema,
  restartPolicySwarmSchema,
  serviceModeSwarmSchema,
  ulimitsSwarmSchema,
  updateConfigSwarmSchema,
} from '../swarm.types';

/**
 * Stand-in for the application's build directory. The real one is
 * `{applicationsDirectoryOn(buildHostServerId)}/{appName}/code` on the build
 * host, but the rule is base-invariant — see `insideDirectorySchema` — so a
 * sentinel decides it once for every application.
 */
const SENTINEL_BUILD_DIRECTORY = '/code';

/**
 * What a caller-supplied `publishDirectory` may be.
 *
 * `nixpacks.strategy.ts` does `path.join(buildAppDirectory, publishDirectory)`,
 * which *normalises*, and `docker cp`s the built artifacts to whatever comes
 * out — so `../../../etc/traefik` took the copy straight out of the
 * application's tree, as the account that drives Docker on the build server.
 * The container side of the same interpolation (`/app/${publishDirectory}`)
 * escapes too, which is why the value is refused here rather than the joined
 * path confined at the builder.
 *
 * Refused rather than confined, on the mounts rule's reasoning: `path.join` would silently
 * re-root `/dist` under the build directory and store a column that lies about
 * itself. Semantically the field names a directory inside the built image's
 * `/app` — the console's own hint is *"the directory that is served"* — so
 * "outside the build directory" is not a configuration to confine.
 *
 * `null` **and** `''` stay legal, and neither is an oversight: every builder
 * reads a falsy value as "unset" (`nixpacks.strategy.ts` skips the copy-out
 * entirely, `static.strategy.ts` falls back to `.`), the console sends `null`,
 * and the API has accepted `''` since the column existed. Refusing it would be
 * a gratuitous 400 for a client that is asking for the default.
 *
 * That allowance is `insideDirectorySchema`'s `allowUnset` rather than a
 * `z.union([z.literal(''), …])` here, so that the published contract does not
 * move: this column renders as `{ type: 'string', nullable: true }` today, and a
 * union renders as an `anyOf` documenting nothing more (a zod refinement never
 * reaches `openapi.json`), which is churn for every generated consumer (§2.11).
 */
const publishDirectorySchema = insideDirectorySchema(
  SENTINEL_BUILD_DIRECTORY,
  'publishDirectory must stay inside the build directory',
  { allowUnset: true },
);

/**
 * What an application's `previewWildcard` may be: `*.` and then a hostname
 * (H-41).
 *
 * **The rule the field was missing, and what it is missing it *for*.** The
 * column was `z.string().startsWith('*.')` and nothing else, so
 * ``*.example.com`) || Host(`victim.example.com`` was a 200 — and
 * `PreviewDeploymentsService.ensurePreview` mints
 * `wildcard.replace('*', appName)` straight into `preview_deployment.domain`.
 * That is the same shape as the Domain `host` once was: a hostname assembled out of a
 * stored fragment nothing held to a charset.
 *
 * **Pre-emptive, and written down as pre-emptive so nobody cites it as a live
 * break.** Both halves were checked rather than assumed. `preview.domain` has
 * exactly one reader in the tree — the pull-request comment body,
 * ``✅ Preview deployment ready: http://${preview.domain}``
 * (`preview-deployments.service.ts:309`) — and no Traefik router, label or
 * config generator reads it at all: a preview deploys under its own `appName`
 * through the regular engine and gets no Domain row, which is why
 * `DomainsService.assertHostUnclaimed` already names preview hosts as a blind
 * spot it does not cover. The comment sink is not an injection surface either:
 * it reaches GitHub's issue-comment API as a JSON `body` field, so markdown is
 * the worst a payload gets to be, and a preview only exists for a PR on a
 * repository the application is already connected to.
 *
 * So this was the moment before the H-14 family, not a member of it. Now
 * a preview host *is* routed — `TraefikAppConfigService.routePreview`
 * interpolates it into a `Host()` rule — and a wildcard stored before this
 * rule is a value already in the database that no write will ever revisit,
 * which is precisely the mechanism H-25 and H-39 were swept back out
 * of the file provider. So the emitter holds the substituted host to
 * `hostSchema` as well, and a preview whose host fails it is reported on its
 * pull request as not routable rather than written.
 *
 * `hostSchema` on the part after `*.`, not a regex of this file's own (§2.4):
 * it is the repo's hostname rule, it is what a Domain's `host` is held to, and
 * the substituted result is meant to *be* a Domain-shaped host. `.refine`
 * rather than folding the two arms into one `.regex()` on purpose — the
 * published contract keeps its `pattern: "^\\*\\..*"` and a refinement never
 * reaches `openapi.json` (§2.11), so no generated consumer moves for a rule
 * that only ever narrows what was already accepted.
 *
 * `null` is no wildcard: a preview's host then carries the address of the
 * machine it runs on, or the preview is refused (`preview-host.ts`).
 */
const previewWildcardSchema = z
  .string()
  .startsWith('*.', 'previewWildcard must start with "*."')
  .refine((value) => hostSchema.safeParse(value.slice(2)).success, {
    message: INVALID_HOSTNAME_MESSAGE,
  });

// Create input: name/appName/description/environmentId/serverId — everything
// else is configured through update.
export const createApplicationSchema = z.object({
  name: serviceNameSchema,
  appName: z
    .string()
    .min(1)
    .max(63)
    .regex(APP_NAME_REGEX, APP_NAME_MESSAGE)
    .optional(),
  description: z.string().optional(),
  environmentId: z.string().min(1, 'environmentId cannot be empty'),
  // `.nullish()`, not `.optional()`: a row on the platform host carries
  // `serverId: null`, so `null` is the value a client reads off the resource
  // and sends back — ADR-0008's "no server row" contract. `.optional()`
  // answered 400 to the API's own output; widening keeps every payload that
  // was already accepted. Absent is not `null`: it is the
  // Environment's Deploy target's Server (`runServerFor`).
  serverId: z.string().nullish(),
  /**
   * Whole GPUs per copy, checked against `serverId`'s cards as an
   * edit is. The one setting create takes besides placement, because a
   * reservation is checked against the run Server, which is chosen here.
   */
  gpus: z.number().int().min(0).optional(),
  /**
   * The model facet that makes this Application an **AI model**, for
   * life: the platform writes its image, command, port and health check, and
   * a plain Application can never be given one later.
   */
  aiModel: createAiModelSchema.optional(),
});

export class CreateApplicationDto extends createZodDto(
  createApplicationSchema,
) {}

// Update input: the configurable columns, all optional. No serverId, no
// appName (immutable — it names containers, volumes and Traefik routers) and
// no environmentId (applications don't move environments), and no
// cloudAccountId or region: a cloud place is set by the Apply that creates
// the Application and never changes after (ADR-0035), so they are stripped.
// applicationStatus changes go through the internal updateStatus instead.
export const updateApplicationSchema = z
  .object({
    name: serviceNameSchema,
    description: z.string().nullable(),
    env: z.string().nullable(),
    buildArgs: z.string().nullable(),
    buildSecrets: z.string().nullable(),
    watchPaths: z.array(z.string()).nullable(),
    memoryReservation: z.string().nullable(),
    memoryLimit: z.string().nullable(),
    cpuReservation: z.string().nullable(),
    cpuLimit: z.string().nullable(),
    command: z.string().nullable(),
    args: z.array(z.string()).nullable(),
    /** The container port a `web` listens on (the config's `port`). */
    port: z.number().int().min(1).max(65535),
    sourceType: z.enum([
      'docker',
      'git',
      'github',
      'gitlab',
      'bitbucket',
      'gitea',
      'drop',
    ]),
    cleanCache: z.boolean().nullable(),
    // GitHub
    repository: z.string().nullable(),
    owner: z.string().nullable(),
    branch: z.string().nullable(),
    buildPath: buildPathSchema('buildPath').nullable(),
    triggerType: z.enum(['push', 'tag']).nullable(),
    autoDeploy: z.boolean().nullable(),
    githubId: z.string().nullable(),
    // GitLab
    gitlabProjectId: z.number().int().nullable(),
    gitlabRepository: z.string().nullable(),
    gitlabOwner: z.string().nullable(),
    gitlabBranch: z.string().nullable(),
    gitlabBuildPath: buildPathSchema('gitlabBuildPath').nullable(),
    gitlabPathNamespace: z.string().nullable(),
    gitlabId: z.string().nullable(),
    // Gitea
    giteaRepository: z.string().nullable(),
    giteaOwner: z.string().nullable(),
    giteaBranch: z.string().nullable(),
    giteaBuildPath: buildPathSchema('giteaBuildPath').nullable(),
    giteaId: z.string().nullable(),
    // Bitbucket
    bitbucketRepository: z.string().nullable(),
    bitbucketRepositorySlug: z.string().nullable(),
    bitbucketOwner: z.string().nullable(),
    bitbucketBranch: z.string().nullable(),
    bitbucketBuildPath: buildPathSchema('bitbucketBuildPath').nullable(),
    bitbucketId: z.string().nullable(),
    // Docker image source — the pull credentials for `dockerImage`, and the
    // same three values a Registry row carries under `url`/`username`/
    // `password` (H-54). They were the field two lines from the one H-47
    // constrained and were left in the shape H-34 found that one in.
    //
    // **`username` gets what the Registry's own username gets, which is a trim
    // and no charset**, and `registry.dto.ts` records why one module over: it
    // is a credential before it is anything else — ECR wants exactly `AWS`,
    // Artifact Registry wants `_json_key` or `oauth2accesstoken`, Docker Hub
    // takes an email — so a charset over that set refuses logins that work.
    // `.nullable()` rather than the Registry's `.min(1)`, because there the
    // column is NOT NULL and a Registry without a login is not a Registry,
    // while here `null` and `''` both already mean "this image needs no
    // credentials" to every reader (`if (username && password)` in both
    // `docker.strategy.ts` and `mechanize.ts`).
    username: z.string().trim().nullable(),
    // **The password gets nothing, deliberately.** There is no specification to
    // transcribe the way `imageReferenceSchema` transcribes
    // `distribution/reference`: a registry token is minted by somebody else's
    // system — a GitHub PAT, an ECR `get-login-password` blob, a base64
    // service-account key — so every character a rule here refused would be a
    // credential this instance could not store for a registry that works, and
    // it is not the kind of value a charset makes safe anyway. What makes it
    // safe is that it is not a word of any command: `dockerStrategy.sourceProgram`
    // puts it in the program's **environment** under `PULL_PASSWORD_HOLDER` and
    // `registry.utils.ts`' `dockerLoginCommand` emits `printf %s
    // "$CG_SOURCE_REGISTRY_PASSWORD" | docker login … --password-stdin`, so the
    // remote shell
    // expands a name this tree invented and the secret never reaches
    // `ExecError.command`. It went over `--password-stdin` before that
    // too, `shEscape`d into the pipeline — which kept it out of `docker`'s argv
    // and never out of the command string pino writes; this comment named that
    // spelling once. `encryptedText` at rest either way.
    password: z.string().nullable(),
    // The grammar H-34 left this column without (H-47). H-34 found this value
    // reaching `docker tag` as a bare word and fixed the *sinks*, by quoting
    // them — which is the defence and still is. But the sentence
    // `builders/build-strategy.ts` states for the tree is "the quoting is the
    // defence, and every charset in the tree is belt-and-braces behind it", and
    // behind these five sinks there was no charset at all: the column was
    // `z.string().nullable()`, so `nginx:a$(id); touch /tmp/h34-pwn #` was a
    // 200 that stored a value no registry could ever serve.
    //
    // `imageReferenceSchema` is `distribution/reference`'s own grammar rather
    // than a metacharacter blocklist of this file's — an image reference is
    // specified, and a rule invented here would refuse
    // `registry:5000/team/app@sha256:…` while a reference carrying a `;` is not
    // a reference at all. `allowUnset` because `''` is this column's existing
    // spelling of "no image", the same allowance `publishDirectory` makes.
    dockerImage: imageReferenceSchema({ allowUnset: true }).nullable(),
    // `registryUrlSchema`, which is the rule the *same value* carries on the
    // Registry row (`registry.dto.ts`, `url`) — hostname or hostname:port, no
    // scheme and no path. Not a second expression of this file's own (§2.4):
    // two schemas for one value is how a Registry's `localhost:5000` and an
    // Application's `localhost:5000` end up disagreeing, and the reason this
    // one had no rule at all is that the constrained twin made the pair read as
    // guarded. It reaches `docker login ${shEscape(registryUrl)}` and
    // dockerode's `authconfig.serveraddress`; both keep quoting, and `''`
    // stays legal because that is how both readers spell "Docker Hub".
    registryUrl: registryUrlSchema.nullable(),
    // Custom git
    customGitUrl: customGitUrlSchema,
    customGitBranch: z.string().nullable(),
    customGitBuildPath: buildPathSchema('customGitBuildPath').nullable(),
    customGitSSHKeyId: z.string().nullable(),
    enableSubmodules: z.boolean(),
    dockerfile: z.string().nullable(),
    dockerContextPath: z.string().nullable(),
    dockerBuildStage: z.string().nullable(),
    // Drop
    dropBuildPath: buildPathSchema('dropBuildPath').nullable(),
    // Swarm overrides
    healthCheckSwarm: healthCheckSwarmSchema.nullable(),
    restartPolicySwarm: restartPolicySwarmSchema.nullable(),
    placementSwarm: placementSwarmSchema.nullable(),
    updateConfigSwarm: updateConfigSwarmSchema.nullable(),
    rollbackConfigSwarm: updateConfigSwarmSchema.nullable(),
    modeSwarm: serviceModeSwarmSchema.nullable(),
    labelsSwarm: labelsSwarmSchema.nullable(),
    networkSwarm: networkSwarmSchema.nullable(),
    stopGracePeriodSwarm: z.number().nullable(),
    endpointSpecSwarm: endpointSpecSwarmSchema.nullable(),
    ulimitsSwarm: ulimitsSwarmSchema.nullable(),
    // Rollbacks
    rollbackActive: z.boolean(),
    // Preview deployments
    isPreviewDeploymentsActive: z.boolean(),
    /** Whether Requested previews may be asked for (ADR-0026). */
    requestedPreviewsAllowed: z.boolean(),
    previewWildcard: previewWildcardSchema.nullable(),
    /**
     * Whether preview routers ask the preview machine's DNS-01 resolver for
     * the preview wildcard. Refused `409` while no preview wildcard is
     * set, and turning it on is refused `409` when that machine has no DNS-01
     * setup (`preview-deployments/preview-dns-challenge.ts`).
     */
    previewDnsChallenge: z.boolean(),
    /** How many pull-request previews the application may hold at once; 0 refuses them. */
    previewLimit: z.number().int().min(0),
    /**
     * How many Requested previews the application may hold at once.
     * At least 1: turning them off is `requestedPreviewsAllowed`'s job.
     */
    requestedPreviewLimit: z.number().int().min(1),
    /** The container port a preview's router points at. */
    previewPort: z.number().int().min(1).max(65535),
    previewEnv: z.string().nullable(),
    previewBuildArgs: z.string().nullable(),
    //
    replicas: z.number().int().min(0),
    /** Whole GPUs per copy, up to the run Server's card count. */
    gpus: z.number().int().min(0),
    /**
     * An AI model's model and image tag. Refused 409 on a plain
     * Application, as `null`, and as a change of `runtime`.
     */
    aiModel: updateAiModelSchema.nullable(),
    buildType: z.enum([
      'dockerfile',
      'heroku_buildpacks',
      'paketo_buildpacks',
      'nixpacks',
      'static',
      'railpack',
    ]),
    railpackVersion: z.string().nullable(),
    herokuVersion: z.string().nullable(),
    publishDirectory: publishDirectorySchema.nullable(),
    isStaticSpa: z.boolean().nullable(),
    createEnvFile: z.boolean(),
    registryId: z.string().nullable(),
    buildRegistryId: z.string().nullable(),
    buildServerId: z.string().nullable(),
  })
  .partial();

export class UpdateApplicationDto extends createZodDto(
  updateApplicationSchema,
) {}

/**
 * The most copies Cloud Run lets a service ask for without a quota increase
 * past its own ceiling; a project's lower quota is Google's to refuse, in its
 * words.
 */
export const CLOUD_RUN_MAX_COPIES = 1000;

/**
 * A Cloud Run Service's copy range (spec S10): the
 * fewest copies, which may be none (it then scales to zero), and the most,
 * at least one.
 */
export const copyRangeSchema = z
  .object({
    minCopies: z.number().int().min(0).max(CLOUD_RUN_MAX_COPIES),
    maxCopies: z.number().int().min(1).max(CLOUD_RUN_MAX_COPIES),
  })
  .refine((range) => range.minCopies <= range.maxCopies, {
    path: ['minCopies'],
    message: 'The fewest copies cannot be more than the most copies',
  });

export class CopyRangeDto extends createZodDto(copyRangeSchema) {}

// The non-file half of the drop upload (applicationId travels in the URL, and
// the zip arrives as the multipart `zip` part). Multipart fields are always
// strings.
// The schema lives in `api-schemas`: the Cloudgate CLI sends it. The server
// holds `dropBuildPath` to the rule every build path carries, which
// the CLI never breaks: it always lands the folder at the build root.
export const uploadApplicationDropSchema =
  sharedUploadApplicationDropSchema.extend({
    dropBuildPath: buildPathSchema(
      'dropBuildPath',
      sharedUploadApplicationDropSchema.shape.dropBuildPath.unwrap(),
    ).optional(),
  });

export class UploadApplicationDropDto extends createZodDto(
  uploadApplicationDropSchema,
) {}

// Environment input (applicationId travels in the URL, not the body).
export const saveApplicationEnvironmentSchema = z.object({
  env: z.string().optional(),
  buildArgs: z.string().optional(),
  buildSecrets: z.string().optional(),
  createEnvFile: z.boolean().optional(),
});

export class SaveApplicationEnvironmentDto extends createZodDto(
  saveApplicationEnvironmentSchema,
) {}

// The registry-login check's input for a Docker-image source: the registry login the
// Source form has on screen, taken off the update schema so a value the test accepts is
// one the
// save accepts. `username` is required here and nowhere else — a login with no
// user is not a question a registry can answer. `password` may be left out (or
// empty) only to test the stored one against the hostname and username it was
// saved with — `ApplicationsService.testRegistryLogin` refuses to send it
// anywhere else.
export const testApplicationRegistryLoginSchema = updateApplicationSchema
  .pick({ registryUrl: true, username: true, password: true })
  .extend({ username: z.string().trim().min(1, 'username cannot be empty') });

export class TestApplicationRegistryLoginDto extends createZodDto(
  testApplicationRegistryLoginSchema,
) {}

/**
 * `PATCH /applications/:id/variables` and the names it and the `GET` beside
 * it answer with. The schemas live in `api-schemas`, where the
 * Cloudgate CLI reads the same objects (ADR 0046).
 */
export class ChangeVariablesDto extends createZodDto(changeVariablesSchema) {}
export class VariableListDto extends createZodDto(variableListSchema) {}
