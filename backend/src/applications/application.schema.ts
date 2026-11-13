import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  integer,
  json,
  jsonb,
  pgEnum,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import {
  configLinksColumn,
  wiredChangedAtColumn,
  configNameColumn,
  configNameConstraints,
  encryptedText,
  generateAppName,
  isoTimestamp,
  nanoidPk,
} from '../db/columns';
import type {
  KeptResource,
  Leftover,
} from '../cloud-accounts/aws/delete-check';
import { cloudAccount } from '../cloud-accounts/cloud-account.schema';
import type { GoogleLeftover } from '../cloud-accounts/gcp/delete-check';
import { environment } from '../environments/environment.schema';
import { plan } from '../project-config/project-config.schema';
import { sourceTypeEnum } from '../git-providers/git-provider.schema';
import { bitbucket } from '../git-providers/strategies/bitbucket/bitbucket.schema';
import { gitea } from '../git-providers/strategies/gitea/gitea.schema';
import { github } from '../git-providers/strategies/github/github.schema';
import { gitlab } from '../git-providers/strategies/gitlab/gitlab.schema';
import { registry } from '../registries/registry.schema';
import { server } from '../servers/server.schema';
import { sshKey } from '../ssh-keys/ssh-key.schema';
import type {
  EndpointSpecSwarm,
  HealthCheckSwarm,
  LabelsSwarm,
  NetworkSwarm,
  PlacementSwarm,
  RestartPolicySwarm,
  ServiceModeSwarm,
  UlimitsSwarm,
  UpdateConfigSwarm,
} from './swarm.types';
import type { NativeAwsBlock } from '../native/aws-native';
import type { NativeGcpBlock } from '../native/gcp-native';

// Phase 20's application table. Rollbacks (Phase 24) contributed
// rollbackActive, preview deployments (Phase 25) the preview columns.

/**
 * `'stopped'` is the fifth member and the only one no row is created with.
 *
 * `'idle'` is the column's default, so it is what a workload that has never
 * been deployed wears — and a stop used to write it too, which collapsed
 * "never ran" and "an operator scaled it to zero" into one word. The console
 * has nothing else to read: a database writes no `deployment` row, so the
 * masthead pill, the facts card and the log header all said `idle` over a
 * Swarm service sitting at 0/0. Added rather than derived because the
 * distinction has to survive a reload, and the row is the only thing that does.
 *
 * Written by every Stop: `BaseDatabaseService.stop`
 * (`0068_stopped-status.sql` adds it to the Postgres type),
 * `ApplicationsService.stop` and the Stop half of its `reload`, and
 * `ComposeService.stop` and `removeContainers`. A row stopped before
 * this status existed still wears the `'idle'` that Stop wrote then; nothing rewrites it,
 * because nothing on the row says which `'idle'` rows were stopped ones.
 */
export const applicationStatusEnum = pgEnum('application_status', [
  'idle',
  'running',
  'done',
  'error',
  'stopped',
]);

export type ApplicationStatus =
  (typeof applicationStatusEnum.enumValues)[number];

/**
 * **A cloud Service's Delete under way, or one that could not finish**
 * (ADR-0038). `null` on every other row. The Delete is a Cloud run
 * that only destroys, so the row outlives the request:
 *
 * - `deleting` while its run is queued or running; the Service reads
 *   "Deleting";
 * - `incomplete` once a run ended with something left in AWS, or without
 *   finishing: the Service reads "Delete incomplete", lists `left`, and
 *   offers only Retry and Forget. It refuses Deploy and Start, because its
 *   state still describes what is left (ADR-0038).
 *
 * A clean finish drops the row, so a finished Delete is never recorded here.
 */
export interface CloudDeleteRecord<L = Leftover> {
  readonly status: 'deleting' | 'incomplete';
  /** The Deployment that records the latest run. */
  readonly deploymentId: string;
  /** The latest run is a Retry: a run that changes nothing goes back to `incomplete`, not to no Delete. */
  readonly retrying: boolean;
  /** Who asked (the Delete or the latest Retry), for the audit entry its clean finish writes. */
  readonly requestedBy: {
    readonly userId: string;
    readonly organizationId: string;
  } | null;
  /** The report's *Kept* list; empty in this slice. */
  readonly kept: readonly KeptResource[];
  /** The report's *Left* list, from the check afterwards. */
  readonly left: readonly L[];
  /** Why the latest run did not finish, when it did not; `null` when it did. */
  readonly unfinished: string | null;
  /**
   * On Google Cloud: the latest run is part of its Environment's
   * Delete, whose own network run took every Domain off the Environment
   * network first, so this run skips its network step. Absent otherwise.
   */
  readonly networkStepDone?: boolean;
}

/** What a cloud Service's Delete leaves: in AWS, or in Google Cloud. */
export type ServiceLeftover = Leftover | GoogleLeftover;

/** A cloud Service's {@link CloudDeleteRecord}, whose *Left* list is either cloud's. */
export type ServiceCloudDeleteRecord = CloudDeleteRecord<ServiceLeftover>;

/**
 * The `build_type` Postgres type, declared **here and nowhere else**.
 *
 * `builders/build-strategy.ts` used to declare a second `pgEnum` under this
 * same name carrying a seventh member, `'drop'`, and imported the type from
 * itself. Nothing objected — two `pgEnum` calls with one name are two unrelated
 * objects — so the column below kept these six while the builder registry
 * offered seven, and the seventh was unreachable for the life of the enum.
 * The reconciliation went this way round, rather than the table importing the
 * builders' copy, because this declaration is the one `drizzle-kit` diffs and
 * `drizzle/0017_applications.sql` created: leaving it untouched is what makes
 * the fix migration-free. `builders/build-strategy.ts` now imports
 * {@link BuildType} from here, and its docblock carries the argument for why
 * `'drop'` was deleted rather than added.
 */
export const buildTypeEnum = pgEnum('build_type', [
  'dockerfile',
  'heroku_buildpacks',
  'paketo_buildpacks',
  'nixpacks',
  'static',
  'railpack',
]);

export type BuildType = (typeof buildTypeEnum.enumValues)[number];

/**
 * What an Application is in Project config terms: the kind a config
 * entry names it by. Recorded, never worked out from `buildType`, because a
 * `worker`, a `web-private` and a `cron` build exactly as a `web` does.
 * Only `web` and `static` are written today; the rest are the kinds the spec
 * adds, declared now so that adding one is no migration.
 */
export const applicationConfigKindEnum = pgEnum('application_config_kind', [
  'web',
  'static',
  'worker',
  'web-private',
  'cron',
]);

export type ApplicationConfigKind =
  (typeof applicationConfigKindEnum.enumValues)[number];

/**
 * The `replicas` a new Service's row starts at, and so what its first deploy
 * writes: a plan read of its create plans the same count, since no
 * config sets it.
 */
export const NEW_SERVICE_REPLICAS = 1;

export const triggerTypeEnum = pgEnum('trigger_type', ['push', 'tag']);

export type TriggerType = (typeof triggerTypeEnum.enumValues)[number];

// The shared "which kind of service owns this row" discriminator that mounts
// (Phase 33) and friends reference, so it lives with the first service entity.
export const serviceTypeEnum = pgEnum('service_type', [
  'application',
  'postgres',
  'mysql',
  'mariadb',
  'mongo',
  'redis',
  'compose',
  'libsql',
  'bucket',
]);

export type ServiceType = (typeof serviceTypeEnum.enumValues)[number];

/**
 * The Service kinds that run a workload of their own: every kind but a
 * Bucket, which holds files and runs nothing itself (`CONTEXT.md`,
 * **Bucket**). The rows a workload has — a mount, an uptime check —
 * name one of these, never a Bucket. A volume backup names any kind: a
 * Bucket's files are on a volume of its own, which it backs up.
 */
export type WorkloadServiceType = Exclude<ServiceType, 'bucket'>;

export const WORKLOAD_SERVICE_TYPES = serviceTypeEnum.enumValues.filter(
  (type): type is WorkloadServiceType => type !== 'bucket',
) as [WorkloadServiceType, ...WorkloadServiceType[]];

export const application = pgTable(
  'application',
  {
    applicationId: nanoidPk('application_id'),
    name: text('name').notNull(),
    /** Fixed key in a Project config; never follows a rename. */
    configName: configNameColumn(),
    /**
     * Its kind in Project config terms, which every reader of "what
     * kind is this Application" reads. A console create writes `web`; a
     * build-type edit to or from `static` keeps a `web`/`static` row in step.
     */
    configKind: applicationConfigKindEnum('config_kind')
      .notNull()
      .default('web'),
    /**
     * A Cron service's timetable (ADR-0034), config-owned and written
     * only by a plan: its five-field `schedule`, the IANA `timezone` it is
     * read in, and a run's time limit in seconds. Set on a `cron` row and
     * `null` on every other (the check below).
     */
    cronSchedule: text('cron_schedule'),
    cronTimezone: text('cron_timezone'),
    cronTimeoutSeconds: integer('cron_timeout_seconds'),
    /**
     * The Plan that last wrote this Service's config-owned fields;
     * `null` for one no plan has written. A locked field shows it.
     */
    configPlanId: text('config_plan_id').references(() => plan.planId, {
      onDelete: 'set null',
    }),
    /** The wired variables its config entry last applied. */
    configLinks: configLinksColumn(),
    /**
     * The `native.aws` its config entry last applied (ADR-0044), as
     * written, on a Service on ECS: the next plan compares the entry's
     * against it, and each deploy and read for Drift lays it over
     * Cloudgate's definition. Never a record of anything Cloudgate writes
     * itself (ADR-0029). `null` when the entry has none, and off AWS.
     */
    nativeAws: jsonb('native_aws').$type<NativeAwsBlock>(),
    /**
     * The `native.gcp` its config entry last applied (ADR-0044), as
     * written, on a Service on Cloud Run: as {@link nativeAws} is on ECS.
     * `null` when the entry has none, and off Google Cloud.
     */
    nativeGcp: jsonb('native_gcp').$type<NativeGcpBlock>(),
    /** When a linked source's Output last changed outside a plan. */
    wiredChangedAt: wiredChangedAtColumn(),
    appName: text('app_name')
      .notNull()
      .unique()
      .$defaultFn(() => generateAppName('app')),
    description: text('description'),
    env: encryptedText('env'),
    buildArgs: encryptedText('build_args'),
    buildSecrets: encryptedText('build_secrets'),
    watchPaths: text('watch_paths').array(),
    memoryReservation: text('memory_reservation'),
    memoryLimit: text('memory_limit'),
    cpuReservation: text('cpu_reservation'),
    cpuLimit: text('cpu_limit'),
    command: text('command'),
    args: text('args').array(),
    /**
     * The Project config's `web.port`: the container port a `web`
     * Service listens on, which a Domain a plan creates points at.
     * Config-owned; the Domains themselves, each with its own port, stay
     * Cloudgate's. Backfilled from the Application's Domains where they all
     * agree (`drizzle/0097_project-config-plan.sql`), else the default.
     */
    port: integer('port').notNull().default(3000),
    /**
     * The deploy-webhook secret — the bearer half of the URL an outside system
     * would POST to trigger a deploy of this Application. Minted here by
     * `$defaultFn` and rotated by {@link ApplicationsService.refreshToken}. The
     * console neither shows nor rotates it: with no route that
     * accepts the URL, a Rotate control and a secret dialog advertised a
     * trigger that does not exist.
     *
     * **Despite the name it is not a git provider's OAuth refresh token.** Those
     * are `gitlab.refreshToken` and `gitea.refreshToken`, issued by the provider
     * and already encrypted; this is a locally generated nanoid that Cloudgate is
     * the sole issuer and sole verifier of. The original report assumed it was
     * the former and posed encrypt-or-delete on that reading; neither branch was
     * the column. Saying so here because the name is the only thing in the tree
     * that suggests otherwise, and the next reader will make the same guess.
     *
     * **`encryptedText`, on the threat model rather than the name.**
     * Possession is the entire authorization: no second factor, no expiry, and
     * rotation is manual and operator-initiated, so a value here is live until
     * somebody clicks Rotate. One `pg_dump`, read replica or backup file hands
     * its reader the deploy trigger for every Application and every Compose in
     * the install at once — a build of the configured branch on the operator's
     * own build host, which is the same lever a supply-chain attacker wants and,
     * at minimum, unbounded resource consumption. That is what `env`,
     * `buildArgs` and `buildSecrets` above and `password` below are encrypted
     * against, and `RollbacksService`'s `EXCLUDED_FROM_CONTEXT` has classified
     * this column as a secret since that list was written; the schema is what
     * disagreed.
     *
     * **The route that verifies it is not in this tree yet, which is the reason
     * to do this now rather than an argument against it.** Nothing under `src`
     * reads this column in a `where` — there is no inbound
     * `/deploy/:refreshToken` route yet, so today the column is minted and
     * rotated and never checked. Prospective exposure, then; but the column
     * type is invisible at the moment the consumer lands (`text` and
     * `encryptedText` compile and migrate identically — see
     * `test/coding-standards/secret-bearing-columns.spec.ts`), so the arrival of
     * that route is exactly the change that will not think to look here.
     *
     * **Being handed back on the row is not an argument against it either.**
     * `encryptedText` decrypts on read, so the rotate route and `findOne` still
     * answer the value. Encryption at rest defends the dump, not the authorized
     * reader.
     *
     * **No backfill, and no migration at all.** `encryptedText` declares the
     * same `text` at rest, so `drizzle-kit generate` answers "No schema changes"
     * against this diff — there is no DDL to write. Nor is there data to move:
     * ADR 0006 passes a value without the `enc:v1:` prefix through on read and
     * re-encrypts it on its next write, so every row written before this change
     * keeps working and becomes ciphertext the first time it is rotated
     * (`applications-lifecycle.e2e-spec.ts` asserts both halves). Clearing the
     * column instead was rejected: when the inbound route lands, a nulled row
     * would need a rotation before it could be triggered at all, and nothing
     * would say so. An install that wants its existing secrets ciphertext
     * rotates them through `POST /applications/:id/refresh-token`; the console
     * no longer offers that control.
     */
    refreshToken: encryptedText('refresh_token').$defaultFn(() => nanoid()),
    sourceType: sourceTypeEnum('source_type').notNull().default('github'),
    cleanCache: boolean('clean_cache').default(false),
    // GitHub
    repository: text('repository'),
    owner: text('owner'),
    branch: text('branch'),
    buildPath: text('build_path').default('/'),
    triggerType: triggerTypeEnum('trigger_type').default('push'),
    autoDeploy: boolean('auto_deploy').$defaultFn(() => true),
    // GitLab
    gitlabProjectId: integer('gitlab_project_id'),
    gitlabRepository: text('gitlab_repository'),
    gitlabOwner: text('gitlab_owner'),
    gitlabBranch: text('gitlab_branch'),
    gitlabBuildPath: text('gitlab_build_path').default('/'),
    gitlabPathNamespace: text('gitlab_path_namespace'),
    // Gitea
    giteaRepository: text('gitea_repository'),
    giteaOwner: text('gitea_owner'),
    giteaBranch: text('gitea_branch'),
    giteaBuildPath: text('gitea_build_path').default('/'),
    // Bitbucket
    bitbucketRepository: text('bitbucket_repository'),
    bitbucketRepositorySlug: text('bitbucket_repository_slug'),
    bitbucketOwner: text('bitbucket_owner'),
    bitbucketBranch: text('bitbucket_branch'),
    bitbucketBuildPath: text('bitbucket_build_path').default('/'),
    // Docker image source (registry pull credentials, encrypted like all secrets)
    username: text('username'),
    password: encryptedText('password'),
    dockerImage: text('docker_image'),
    registryUrl: text('registry_url'),
    // Custom git
    customGitUrl: text('custom_git_url'),
    customGitBranch: text('custom_git_branch'),
    customGitBuildPath: text('custom_git_build_path'),
    customGitSSHKeyId: text('custom_git_ssh_key_id').references(
      () => sshKey.sshKeyId,
      { onDelete: 'set null' },
    ),
    enableSubmodules: boolean('enable_submodules').notNull().default(false),
    dockerfile: text('dockerfile').default('Dockerfile'),
    dockerContextPath: text('docker_context_path'),
    dockerBuildStage: text('docker_build_stage'),
    // Drop (uploaded archive)
    dropBuildPath: text('drop_build_path'),
    /**
     * Whether an upload has landed on the build host: set only by the two
     * upload routes, beside `dropBuildPath`, and cleared when the source
     * moves off uploaded files (`ApplicationsService.update`). A plan
     * writes the build path of a folder source (ADR-0080) before any
     * upload, so the path alone no longer says the build host holds files
     * to build.
     */
    dropUploaded: boolean('drop_uploaded').notNull().default(false),
    // Docker swarm service-spec overrides
    healthCheckSwarm: json('health_check_swarm').$type<HealthCheckSwarm>(),
    restartPolicySwarm: json(
      'restart_policy_swarm',
    ).$type<RestartPolicySwarm>(),
    placementSwarm: json('placement_swarm').$type<PlacementSwarm>(),
    updateConfigSwarm: json('update_config_swarm').$type<UpdateConfigSwarm>(),
    rollbackConfigSwarm: json(
      'rollback_config_swarm',
    ).$type<UpdateConfigSwarm>(),
    modeSwarm: json('mode_swarm').$type<ServiceModeSwarm>(),
    labelsSwarm: json('labels_swarm').$type<LabelsSwarm>(),
    networkSwarm: json('network_swarm').$type<NetworkSwarm[]>(),
    stopGracePeriodSwarm: bigint('stop_grace_period_swarm', { mode: 'number' }),
    endpointSpecSwarm: json('endpoint_spec_swarm').$type<EndpointSpecSwarm>(),
    ulimitsSwarm: json('ulimits_swarm').$type<UlimitsSwarm>(),
    /** Whether successful deploys capture a rollback snapshot (Phase 24). */
    rollbackActive: boolean('rollback_active').notNull().default(false),
    /** Whether PRs against the tracked branch get preview deployments (Phase 25). */
    isPreviewDeploymentsActive: boolean('is_preview_deployments_active')
      .notNull()
      .default(false),
    /** The wildcard preview hosts are carved from, e.g. `*.preview.example.com`. */
    previewWildcard: text('preview_wildcard'),
    /**
     * Whether preview routers ask the preview machine's DNS-01 resolver for a
     * certificate covering `previewWildcard`, rather than relying on an
     * uploaded wildcard. Only allowed with a preview wildcard set and a DNS-01
     * setup on the machine previews run on.
     */
    previewDnsChallenge: boolean('preview_dns_challenge')
      .notNull()
      .default(false),
    /**
     * Whether a caller holding `deployment: ['create']` may ask for a Requested
     * preview of a branch (ADR-0026). Off by default and backfilled off: a
     * requested preview runs unmerged, unreviewed branch code against this
     * Application's storage and environment, so it exists only where the
     * operator said so. Written under `service: ['update']`, which neither agent
     * role holds, so no Agent can allow them for itself. A precondition on the
     * Application checked after the grant, not a second authorization path; it
     * never governs the pull-request webhook, which is
     * `isPreviewDeploymentsActive`'s alone.
     */
    requestedPreviewsAllowed: boolean('requested_previews_allowed')
      .notNull()
      .default(false),
    /**
     * How many pull-request previews this Application may hold at once:
     * counts `trigger = 'pullRequest'` rows only, so a Requested preview never
     * takes a contributor's slot. 0 refuses them all.
     */
    previewLimit: integer('preview_limit').notNull().default(3),
    /**
     * How many Requested previews this Application may hold at once
     * (ADR-0026): counts `trigger = 'requested'` rows only, an expired one
     * whose teardown is still pending included, because the cap is for the copy
     * occupying the Server. At least 1: turning them off is
     * `requestedPreviewsAllowed`'s job. Written under `service: ['update']`
     * beside the switch.
     */
    requestedPreviewLimit: integer('requested_preview_limit')
      .notNull()
      .default(3),
    /** The container port a preview's Traefik router points at. */
    previewPort: integer('preview_port').notNull().default(3000),
    /** Environment variables a preview build runs with, instead of `env`. */
    previewEnv: encryptedText('preview_env'),
    /** Build arguments a preview build runs with, instead of `buildArgs`. */
    previewBuildArgs: encryptedText('preview_build_args'),
    //
    replicas: integer('replicas').notNull().default(NEW_SERVICE_REPLICAS),
    /**
     * Whole GPUs reserved per running copy, so the Application holds
     * `replicas × gpus` cards. 0 to the run Server's card count, refused on
     * save beyond it (`settings/gpu-counts.ts`). Cloudgate's, never the
     * Project config's (ADR-0029): no plan reads or writes it, so it can
     * differ per Environment like the run Server.
     */
    gpus: integer('gpus').notNull().default(0),
    applicationStatus: applicationStatusEnum('application_status')
      .notNull()
      .default('idle'),
    buildType: buildTypeEnum('build_type').notNull().default('nixpacks'),
    railpackVersion: text('railpack_version').default('0.15.4'),
    herokuVersion: text('heroku_version').default('24'),
    publishDirectory: text('publish_directory'),
    isStaticSpa: boolean('is_static_spa'),
    createEnvFile: boolean('create_env_file').notNull().default(true),
    createdAt: isoTimestamp('created_at'),
    registryId: text('registry_id').references(() => registry.registryId, {
      onDelete: 'set null',
    }),
    buildRegistryId: text('build_registry_id').references(
      () => registry.registryId,
      { onDelete: 'set null' },
    ),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environment.environmentId, { onDelete: 'cascade' }),
    githubId: text('github_id').references(() => github.githubId, {
      onDelete: 'set null',
    }),
    gitlabId: text('gitlab_id').references(() => gitlab.gitlabId, {
      onDelete: 'set null',
    }),
    giteaId: text('gitea_id').references(() => gitea.giteaId, {
      onDelete: 'set null',
    }),
    bitbucketId: text('bitbucket_id').references(() => bitbucket.bitbucketId, {
      onDelete: 'set null',
    }),
    serverId: text('server_id').references(() => server.serverId, {
      onDelete: 'cascade',
    }),
    buildServerId: text('build_server_id').references(() => server.serverId, {
      onDelete: 'set null',
    }),
    /**
     * The Application's **cloud place** (ADR-0035): the Cloud
     * account and region it runs in, set together when a plan's Apply
     * creates it in a Cloud account and never changed after. `null` for an
     * Application on a Server or the platform host. A Cloud account is never
     * deleted from under its Services (its Delete is guarded), so the key
     * takes no action.
     */
    cloudAccountId: text('cloud_account_id').references(
      () => cloudAccount.cloudAccountId,
      { onDelete: 'no action' },
    ),
    region: text('region'),
    /**
     * A `static` site on AWS's own bucket (spec "Bucket naming"):
     * its real name in S3's account regional namespace, minted once by the
     * plan that created it and fixed for life. `null` on every other
     * Application.
     */
    cloudBucketName: text('cloud_bucket_name'),
    /**
     * A `static` site on AWS's CloudFront distribution id, saved by
     * the Cloud run that made it from its `distribution_id` output, so each
     * deploy can switch it, clear its cache and ask how far it has spread.
     * `null` until that run has applied, and on every other Application.
     */
    cloudDistributionId: text('cloud_distribution_id'),
    /**
     * That distribution's own `*.cloudfront.net` name, saved beside
     * its id: the site's generated Domain, which needs no certificate of its
     * own, and what its Domain's DNS record points at. `null` until that
     * run has applied, and on every other Application.
     */
    cloudDistributionDomain: text('cloud_distribution_domain'),
    /**
     * A `static` site on AWS's live folder (spec "Schema
     * changes"): the id of the Deployment whose `deployments/<id>/` folder
     * the distribution's origin path names, written by that Deployment's
     * switch. Every later deploy keeps it until its own switch has spread.
     * `null` before the first switch, and on every other Application.
     */
    cloudLiveFolder: text('cloud_live_folder'),
    /**
     * A `web` on Cloud Run's copy range (spec S10): Cloudgate's own,
     * 0 and 10 when a plan creates it, set by a direct call afterwards and
     * never compared by a plan. Two numbers rather than `replicas`, which
     * means one running count on every other target. `null` on every other
     * Application.
     */
    minCopies: integer('min_copies'),
    maxCopies: integer('max_copies'),
    /**
     * A `web` on Cloud Run's own `*.run.app` host (spec S11), saved
     * from its apply's `service_uri` output: its generated Domain, on
     * Google's certificate, which needs no DNS record. `null` until its
     * first deploy has applied, and on every other Application.
     */
    cloudRunAddress: text('cloud_run_address'),
    /** A cloud Delete under way or incomplete; see {@link CloudDeleteRecord}. */
    cloudDelete: jsonb('cloud_delete').$type<ServiceCloudDeleteRecord>(),
  },
  (t) => [
    ...configNameConstraints('application', t),
    // "A run Server (or the platform host) or a Cloud account + region":
    // the two cloud columns are set together, and never beside a Server.
    check(
      'application_place',
      sql`(${t.cloudAccountId} IS NULL) = (${t.region} IS NULL) AND (${t.cloudAccountId} IS NULL OR ${t.serverId} IS NULL)`,
    ),
    // A Cron service has its whole timetable, and nothing else has one.
    check(
      'application_cron_timetable',
      sql`(${t.configKind} = 'cron') = (${t.cronSchedule} IS NOT NULL) AND (${t.cronSchedule} IS NULL) = (${t.cronTimezone} IS NULL) AND (${t.cronSchedule} IS NULL) = (${t.cronTimeoutSeconds} IS NULL)`,
    ),
  ],
);

export const applicationRelations = relations(application, ({ one }) => ({
  environment: one(environment, {
    fields: [application.environmentId],
    references: [environment.environmentId],
  }),
  customGitSSHKey: one(sshKey, {
    fields: [application.customGitSSHKeyId],
    references: [sshKey.sshKeyId],
  }),
  registry: one(registry, {
    fields: [application.registryId],
    references: [registry.registryId],
    relationName: 'applicationRegistry',
  }),
  buildRegistry: one(registry, {
    fields: [application.buildRegistryId],
    references: [registry.registryId],
    relationName: 'applicationBuildRegistry',
  }),
  github: one(github, {
    fields: [application.githubId],
    references: [github.githubId],
  }),
  gitlab: one(gitlab, {
    fields: [application.gitlabId],
    references: [gitlab.gitlabId],
  }),
  gitea: one(gitea, {
    fields: [application.giteaId],
    references: [gitea.giteaId],
  }),
  bitbucket: one(bitbucket, {
    fields: [application.bitbucketId],
    references: [bitbucket.bitbucketId],
  }),
  server: one(server, {
    fields: [application.serverId],
    references: [server.serverId],
    relationName: 'applicationServer',
  }),
  buildServer: one(server, {
    fields: [application.buildServerId],
    references: [server.serverId],
    relationName: 'applicationBuildServer',
  }),
}));

export type Application = typeof application.$inferSelect;
