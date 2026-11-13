import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { DropComparison, VariableList } from 'api-schemas';
import { and, eq, ne, not, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  APPLICATION_CREDENTIAL_REFS,
  resolveCredentialRefs,
} from '../common/credential-refs';
import type {
  ApplicationCredentialRef,
  CredentialRefResolvers,
} from '../common/credential-refs';
import { checkServerAccess } from '../common/owned-server';
import { runLogOwnersOf } from '../common/run-log-owners';
import { withoutSecrets } from '../common/service-read-relations';
import {
  awaitImageRelease,
  reclaimDeploymentLogs,
  reclaimFileMounts,
  runTeardownSteps,
} from '../common/teardown-steps';
import type {
  UnreclaimedArtifact,
  UnreclaimedImages,
} from '../common/teardown-steps';
import type { OrphanedWorkload } from '../common/workload-presence';
import { workloadKeptRefusal } from '../common/workload-kept-refusal';
import {
  admitAiModelEdit,
  aiModelApplicationSettings,
  insertAiModel,
  joinAiNetworkForFirstAiModel,
  readAiModelFacet,
} from '../ai-models/ai-model-facet';
import { assertAiModelLocksHeld } from '../ai-models/ai-model-locks';
import { aiModelEndpoint } from '../ai-models/ai-model-endpoint';
import { reclaimWeightsVolumes } from '../ai-models/weights-volume';
import { cleanAppName, generateAppName } from '../db/columns';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  aiModelFacet,
  application,
  environment,
  mount,
  port,
  project,
} from '../db/schema';
import {
  claimServiceConfigName,
  mintServiceConfigName,
} from '../environments/config-name';
import type { ApplicationStatus } from '../db/schema';
import { buildHostServerId } from '../deployment-engine/build-host';
import { gpuReleaseRefusal } from '../deployment-engine/gpu-deploy-check';
import {
  cloudPlaceOf,
  refuseNativeSetCaps,
  refuseOnCloudService,
} from './cloud-place';
import { CloudServiceDeletes } from './cloud-delete';
import { refuseWhileCloudDelete } from './cloud-delete-refusal';
import type { CloudDeleteTarget } from './cloud-delete';
import { CloudServiceLifecycle } from './cloud-lifecycle';
import type { CloudLifecycleTarget } from './cloud-lifecycle';
import { runServerFor } from '../environments/deploy-target';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { keepDomainRecordsOnNetwork } from '../environments/network-dns-records';
import { BitbucketService } from '../git-providers/strategies/bitbucket/bitbucket.service';
import { GiteaService } from '../git-providers/strategies/gitea/gitea.service';
import { GithubService } from '../git-providers/strategies/github/github.service';
import { GitlabService } from '../git-providers/strategies/gitlab/gitlab.service';
// A plain function taking this service's `RemoteExecService` rather than
// `PatchRepoService`, which injects *this* service — the same import knot
// `reclaimPreservedImages` and `tearDownApplicationPreviews` are plain
// functions to avoid, and here a hard one: `patch-repo.service.ts`'s
// `@Injectable()` metadata would evaluate `ApplicationsService` mid-load.
import { reclaimApplicationPatchRepos } from '../patch/patch-repo-clone';
// A plain function taking this service's `DrizzleDB` and `RemoteExecService`
// rather than `PreviewDeploymentsService`, which injects *this* service — the
// same `forwardRef` knot `reclaimPreservedImages` is a plain function to avoid.
import {
  admitPreviewDnsChallenge,
  dnsChallengeWildcardOf,
  reroutePreviews,
} from '../preview-deployments/preview-dns-challenge';
import { refuseCloudPreviewSwitches } from '../preview-deployments/cloud-preview';
import { tearDownApplicationPreviews } from '../preview-deployments/preview-teardown';
import type { PermissionCtx } from '../rbac/permission.service';
import { IncidentsService } from '../service-health/incidents.service';
import { InstanceUrlService } from '../settings/instance-url.service';
import { PermissionService } from '../rbac/permission.service';
import {
  ConsoleSaves,
  KEEP_NOTHING,
  writeKept,
} from '../project-config/console-saves';
import type { KeepConfig } from '../project-config/console-saves';
import { refuseTypedLinkedNames } from '../project-config/outputs';
import { RegistriesService } from '../registries/registries.service';
import { ReachabilityMemo } from '../remote/reachability-memo';
import { RemoteExecService } from '../remote/remote-exec.service';
import {
  applicationTraceOwner,
  reclaimTraceStores,
} from '../traces/trace-store';
// A plain function taking this service's `DrizzleDB` rather than
// `RollbacksService`, because `RollbacksService` injects *this* service and a
// provider would be a `forwardRef` knot — `common/service-cascade.ts`'s
// precedent and its stated reason.
import { reclaimPreservedImages } from '../rollbacks/preserved-images';
import { nestedServer } from '../servers/nested-server';
import {
  gpuReservationRefusal,
  readGpuAdmission,
} from '../settings/gpu-counts';
import { SshKeysService } from '../ssh-keys/ssh-keys.service';
import { TraefikAppConfigService } from '../traefik/app-config.service';
import { TraefikWriterService } from '../traefik/traefik-writer.service';
import { removeGatewayRouteStep } from '../gateway/gateway-route';
import {
  applicationVolumeNames,
  callerMayName,
  reclaimApplicationVolumes,
} from './application-volumes';
import { reclaimBuildLeftovers } from './build-leftovers';
import { reclaimBuiltImages } from './built-image';
import { readGpuWait } from './gpu-wait';
import {
  refuseUnsetOfMissing,
  variableNames,
  withVariables,
} from './runtime-variables';
import type { GpuWait } from './gpu-wait';
import {
  applicationServiceId,
  applicationServicePresence,
  reclaimApplicationDirectory,
  removeApplicationService,
  removeTraefikConfigStep,
  scaleApplicationService,
} from './application-ops';
import type { ScaleOptions } from './application-ops';
import { refuseWhileBuilding } from './build-in-progress';
import {
  dropCodeDirectory,
  materializeDrop,
  readDropArchive,
} from './drop-archive';
import {
  applyDropChanges,
  compareDropFiles,
  readBuildHostTree,
  readDropFileList,
} from './drop-changes';
import type {
  ChangeVariablesDto,
  CopyRangeDto,
  CreateApplicationDto,
  SaveApplicationEnvironmentDto,
  TestApplicationRegistryLoginDto,
  UpdateApplicationDto,
  UploadApplicationDropDto,
} from './dto/application.dto';
import { configKindAfter } from './config-kind';
import { moveDomainsOnPort, portChangeOf } from './domain-port-move';
import type { DomainPortMove, PortChange } from './domain-port-move';
import { CRON_RUN_STOPPER } from '../cron-services/cron-run-stopper.port';
import type { CronRunStopper } from '../cron-services/cron-run-stopper.port';
import {
  assertKindAllows,
  assertKindTakesSwarmSettings,
  assertPreviewSwitchesAllowed,
  internalAddressOf,
} from './config-kind-locks';
import { readCronService } from '../cron-services/cron-service-read';
import {
  CRON_SERVICE_CLOCK,
  systemCronServiceClock,
} from '../cron-services/cron-service.clock';
import type { CronServiceClock } from '../cron-services/cron-service.clock';
import type { Application, ApplicationConfigKind } from './application.schema';
import type { DrizzleTx } from '../environments/config-name';
import { refuseWhileInMaintenance } from '../servers/server-maintenance';

/**
 * What a Plan's create writes beyond a console create's fields: the
 * config's key, the entry's kind and its config-owned settings. The
 * kind is here rather than in {@link UpdateApplicationDto}, so that no PATCH
 * can write it.
 */
export interface PlanCreate {
  readonly configName: string;
  readonly configKind: ApplicationConfigKind;
  readonly settings: UpdateApplicationDto;
  /** A Cron service's timetable, which only a plan writes. */
  readonly cron?: CronTimetable;
  /**
   * A `web` an Apply creates in a Cloud account: its cloud place,
   * fixed for life (ADR-0035), and its id, which is the Service id its plan
   * was read with, so the resources its plan showed are the ones made.
   */
  readonly cloud?: {
    readonly applicationId: string;
    readonly cloudAccountId: string;
    readonly region: string;
    /** A `static` site's own bucket's real name, as its plan minted it. */
    readonly cloudBucketName?: string;
    /** A `web` on Cloud Run's copy range, 0 and 10 at create (spec S10). */
    readonly minCopies?: number;
    readonly maxCopies?: number;
  };
}

/**
 * A Cron service's timetable columns (ADR-0034). Config-owned and
 * written only by a plan's create or change, never by a PATCH, so they are
 * not in {@link UpdateApplicationDto}.
 */
export interface CronTimetable {
  readonly cronSchedule: string;
  readonly cronTimezone: string;
  readonly cronTimeoutSeconds: number;
}

/**
 * `common/credential-refs.ts`' {@link APPLICATION_CREDENTIAL_REFS} and its
 * `ApplicationCredentialRef`, re-exported under the names this module
 * published them under.
 *
 * **The re-export is not tidiness and must not be deleted.** The list moved to
 * `common/` because the rule it belongs to was stated in three modules with no
 * single home — see that file for the argument — and
 * because `rollbacks/rollback.schema.ts` needs the names without pointing a
 * table definition at a service. But `RollbacksService.EXCLUDED_FROM_CONTEXT`
 * **spreads** this list, imported from here, and the annotation
 * `Exclude<keyof DeployableApplication, keyof RollbackContext>[]` is what makes
 * an eighth credential id fail to compile there until `RollbackContext` omits
 * it too. Breaking this name would take that guard off in a module that
 * has no other statement of the rule.
 */
export { APPLICATION_CREDENTIAL_REFS };
export type { ApplicationCredentialRef };

/** Why Reload is refused on a stopped cloud Service. */
export const CLOUD_RELOAD_WHILE_STOPPED =
  'This Service is stopped, so it has no running copy to replace. Start it first';

/** A Service's cloud place for its lifecycle, or `null` off a cloud. */
function cloudTargetOf(row: {
  applicationId: string;
  appName: string;
  configName: string | null;
  environmentId: string;
  cloudAccountId: string | null;
  region: string | null;
  replicas: number;
  minCopies: number | null;
  maxCopies: number | null;
  configKind: ApplicationConfigKind;
}): CloudLifecycleTarget | null {
  if (!row.cloudAccountId || !row.region) return null;
  return { ...row, cloudAccountId: row.cloudAccountId, region: row.region };
}

/**
 * What a cloud Service's Delete answers beside its row: none of a Server
 * Delete's leftovers, since its report is its run's. Typed as theirs
 * so that a Delete's answer reads the same whichever place it ran.
 */
const NO_SERVER_LEFTOVERS: {
  unreclaimedImages?: UnreclaimedImages[];
  orphanedPreviews?: OrphanedWorkload[];
  unreclaimedArtifacts?: UnreclaimedArtifact[];
} = {};

/** A Service's cloud place and Delete record for its Delete, or `null` off a cloud. */
function cloudDeleteTargetOf(
  row: Parameters<typeof cloudTargetOf>[0] & {
    name: string;
    cloudDelete: CloudDeleteTarget['cloudDelete'];
    cloudBucketName: string | null;
  },
): CloudDeleteTarget | null {
  const target = cloudTargetOf(row);
  return target
    ? {
        ...target,
        name: row.name,
        cloudDelete: row.cloudDelete,
        cloudBucketName: row.cloudBucketName,
      }
    : null;
}

@Injectable()
export class ApplicationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
    // The writer rather than TraefikAppConfigService: Delete wants the file
    // gone unconditionally, and `regenerate` would rewrite it — the domain rows
    // are still there when the teardown runs, because the row that cascades
    // them has not been dropped yet. `certificates.service.ts` injects
    // the writer the same way.
    private readonly traefikWriter: TraefikWriterService,
    // The six owning services, injected only so that
    // {@link credentialRefResolvers} can delegate to the org-scoped lookup
    // each one already has. Every one of them is a
    // `findOne`
    // that filters the id and `organizationId` **together** and raises its own
    // `NotFoundException` whichever predicate misses, which is precisely why
    // this is six injections rather than six more `id = ? AND
    // organization_id = ?` selects in this file: no seventh copy of an
    // ownership lookup (§1.4), and no new refusal wording to
    // keep in sync with the module that owns the row.
    private readonly sshKeys: SshKeysService,
    private readonly registries: RegistriesService,
    private readonly github: GithubService,
    private readonly gitlab: GitlabService,
    private readonly gitea: GiteaService,
    private readonly bitbucket: BitbucketService,
    // Only to rewrite live previews' routers when the DNS-01 switch moves
    // `routePreview` is the one writer of a preview's router.
    private readonly traefikConfig: TraefikAppConfigService,
    // The Stop hook: a Stop closes the Service's open Incidents with
    // `service-stopped`, announced once each.
    private readonly incidents: IncidentsService,
    // An AI model's endpoint is built on the platform host URL.
    private readonly instanceUrl: InstanceUrlService,
    // Stop, Start and Reload of a Service in a Cloud account: direct
    // ECS calls through the cloud port.
    private readonly cloudLifecycle: CloudServiceLifecycle,
    // A console create with no Server named is never put on the Hosted
    // instance's own host (ADR-0053 seam 2).
    private readonly instanceMode: InstanceMode,
    // Console Saves on a Cloudgate-kept config: each create, settings
    // write and Delete below keeps the Project config in step with it.
    // Optional only so a spec that builds this service by hand still
    // compiles; `ApplicationsModule` always provides it.
    @Optional() private readonly consoleSaves?: ConsoleSaves,
    // A Cron service's runs in flight, which its Stop and Delete end.
    // Optional for `consoleSaves`' reason.
    @Optional() private readonly moduleRef?: ModuleRef,
    // A cloud Service's Delete, Retry and Forget: a destroy-only Cloud
    // run. Optional for `consoleSaves`' reason; `ApplicationsModule` always
    // provides it, and it drops the row through this service on a clean finish.
    @Optional() private readonly cloudDeletes?: CloudServiceDeletes,
    // A Cron service's next fire times are read on the clock its timetable
    // fires on, so a suite that stands time still sees the two agree.
    // Optional for `consoleSaves`' reason.
    @Optional()
    @Inject(CRON_SERVICE_CLOCK)
    private readonly cronClock: CronServiceClock = systemCronServiceClock,
  ) {
    this.cloudDeletes?.dropWith((applicationId) =>
      this.dropCloudService(applicationId),
    );
  }

  /**
   * Ends a Cron service's runs in flight, through the port
   * `CronServicesModule` binds: that module imports this one, so the
   * service is resolved at call time. Answers the jobs left behind.
   */
  private async stopCronRuns(
    ctx: PermissionCtx,
    applicationId: string,
    kind: 'stopped' | 'deleted',
  ): Promise<string[]> {
    const stopper = this.moduleRef?.get<CronRunStopper>(CRON_RUN_STOPPER, {
      strict: false,
    });
    if (!stopper) return [];
    return stopper.stopRunsOf(applicationId, { kind, userId: ctx.user.id });
  }

  /**
   * Resolves the target environment inside the caller's organization, requires
   * service:create on its project, inserts in a transaction with the
   * unique-appName check, then grants the creator row-level access.
   *
   * An unknown or unowned `serverId` is refused 404 before the insert; `null`
   * is the platform host, and a console create that sends none lands
   * on the Environment's Deploy target's Server (`runServerFor`).
   *
   * **A plain create resolves no credential refs**, because
   * `createApplicationSchema` carries no credential-bearing parent id at all
   * — "everything else is configured through update". The one caller
   * that sets more at create is a Plan, through `initial`: a
   * plan-created Application is written whole, with its git provider
   * connection, in this one insert, so the Apply needs no `service: update`
   * on a Service it is still creating (`composed-creates.spec.ts`'s
   * property). Its ids are resolved here exactly as {@link update} resolves
   * them, before anything is written. `initial.configName` is the config's
   * key, claimed as it is rather than minted from the display name.
   */
  async create(
    ctx: PermissionCtx,
    data: CreateApplicationDto,
    initial?: PlanCreate,
  ) {
    // A plan's own create is the plan's step, not a console Save.
    if (initial || !this.consoleSaves) {
      return this.insertApplication(ctx, data, KEEP_NOTHING, initial);
    }
    return this.consoleSaves.create(
      ctx,
      { serviceType: 'application', environmentId: data.environmentId },
      (keep) => this.insertApplication(ctx, data, keep),
    );
  }

  private async insertApplication(
    ctx: PermissionCtx,
    data: CreateApplicationDto,
    keep: KeepConfig,
    initial?: PlanCreate,
  ) {
    const parent = await this.findParentEnvironment(ctx, data.environmentId);
    await this.permissions.checkServiceAccess(ctx, parent.projectId, 'create');
    // After the permission gate, never before — see
    // databases/common/database-service.ts's createDatabase for why.
    // A console create that names no Server lands where the Environment's
    // Deploy target says; a plan's create names its own place.
    const serverId = initial
      ? data.serverId
      : runServerFor(data.serverId, parent.deployTarget, this.instanceMode);
    // A body's own `null`, or a plan's create with neither a Server nor a
    // Cloud account, is the platform host: refused on the Hosted instance
    // (ADR-0053 seam 3). ADR-0008's Self-hosted branch is unchanged.
    if (!serverId && !initial?.cloud) {
      this.instanceMode.refusePlatformHost('services');
    }
    const runServer = await checkServerAccess(this.db, ctx, serverId);
    await this.admitGpus(runServer, data.gpus);
    // The facet is its own row, never a column of the spread below.
    const { aiModel: facet, ...fields } = data;
    if (facet) {
      await joinAiNetworkForFirstAiModel(this.db, this.remoteExec, serverId);
    }
    const authorized = initial
      ? await resolveCredentialRefs(
          APPLICATION_CREDENTIAL_REFS,
          this.credentialRefResolvers(ctx),
          initial.settings,
        )
      : {};

    const appName = data.appName
      ? cleanAppName(data.appName)
      : generateAppName('app');

    const created = await this.db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ applicationId: application.applicationId })
        .from(application)
        .where(eq(application.appName, appName))
        .limit(1);
      if (taken) {
        throw new ConflictException(
          "Application with this 'appName' already exists",
        );
      }
      const configName = initial
        ? await claimServiceConfigName(
            tx,
            data.environmentId,
            initial.configName,
          )
        : await mintServiceConfigName(
            tx,
            data.environmentId,
            'application',
            data.name,
          );
      const [row] = await tx
        .insert(application)
        .values({
          ...initial?.settings,
          ...initial?.cron,
          ...authorized,
          ...fields,
          ...(facet && aiModelApplicationSettings(facet, data.gpus ?? 0)),
          ...initial?.cloud,
          serverId,
          appName,
          configName,
          // A console create takes no build type, so it is the `web` it
          // always was; a plan's create names its entry's kind.
          configKind: initial?.configKind ?? 'web',
        })
        .returning();
      const aiModel = facet
        ? await insertAiModel(tx, row.applicationId, facet)
        : null;
      await keep(tx, { serviceId: row.applicationId });
      return { ...row, aiModel };
    });

    await this.permissions.addNewService(ctx, created.applicationId);
    return created;
  }

  /**
   * Row-level service access, then the deep relation tree. Org-scoped through
   * environment → project.
   *
   * **No relation on this read carries a secret, and the list of what that
   * means is not here** — `common/service-read-relations.ts` holds the rule and
   * `test/coding-standards/service-read-relations.spec.ts` derives it from the
   * schema. This site had four holes at once when that rule was written
   * `customGitSSHKey` was `true`, so the whole `ssh_key` row came back
   * with its private half; `github` withheld two of its three secrets and not
   * `webhookSecret`; `gitlab` withheld its tokens and not its OAuth `secret`;
   * and the `server` row was spread whole, `metricsConfig.server.token`
   * included, which is the entirety of `POST /notifications/receive`'s
   * authentication. A base member with one id in `accessedServices` reaches
   * every one of them.
   */
  async findOne(ctx: PermissionCtx, applicationId: string) {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'read');

    const found = await this.db.query.application.findFirst({
      where: eq(application.applicationId, applicationId),
      with: {
        environment: { with: { project: true } },
        customGitSSHKey: withoutSecrets.sshKey,
        registry: withoutSecrets.registry,
        buildRegistry: withoutSecrets.registry,
        github: withoutSecrets.github,
        gitlab: withoutSecrets.gitlab,
        gitea: withoutSecrets.gitea,
        bitbucket: withoutSecrets.bitbucket,
        // The one relation whose secret is a *field* rather than a column, so
        // the column is loaded and the field withheld below at its own depth.
        server: true,
        buildServer: true,
      },
    });
    if (
      !found ||
      found.environment.project.organizationId !==
        ctx.session.activeOrganizationId
    ) {
      throw new NotFoundException('Application not found');
    }
    // Its Cloud account and region, on a cloud Service.
    const cloudPlace = await cloudPlaceOf(this.db, found);
    return {
      ...found,
      server: nestedServer(found.server),
      buildServer: nestedServer(found.buildServer),
      // Projected by column, never as a relation of the tree above: the
      // facet's row holds the upstream secret.
      aiModel: await this.aiModelOf(applicationId),
      // Where the other Services on its Server, or of its
      // Environment network in a Cloud account, reach a
      // web-private; `null` for every other kind.
      internalAddress: internalAddressOf(found, cloudPlace),
      // A Cron service's timetable and next fire times; `null` on
      // any other kind.
      cronService: await readCronService(
        this.db,
        found,
        new Date(this.cronClock.now()),
      ),
      cloudPlace,
    };
  }

  /**
   * An AI model's facet as a read shows it, with its endpoint on the gateway
   * `null` on a plain Application. Never the upstream secret.
   */
  private async aiModelOf(applicationId: string) {
    const facet = await readAiModelFacet(this.db, applicationId);
    if (!facet) return null;
    return {
      ...facet,
      endpoint: aiModelEndpoint(
        await this.instanceUrl.getInstanceUrl(),
        applicationId,
      ),
    };
  }

  /**
   * Whether the Application is waiting for a GPU — `gpu-wait.ts` says
   * what that reads. Row-level service `read`, so a member who can see the
   * Application sees why it is not running without holding `docker: ['read']`,
   * which the task listing behind the failure banner needs. Not an MCP tool.
   */
  async gpuWait(ctx: PermissionCtx, applicationId: string): Promise<GpuWait> {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'read');
    const [found] = await this.db
      .select({
        appName: application.appName,
        serverId: application.serverId,
        gpus: application.gpus,
      })
      .from(application)
      .innerJoin(
        environment,
        eq(environment.environmentId, application.environmentId),
      )
      .innerJoin(project, eq(project.projectId, environment.projectId))
      .where(
        and(
          eq(application.applicationId, applicationId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      );
    if (!found) throw new NotFoundException('Application not found');
    return readGpuWait(this.remoteExec, found);
  }

  /**
   * Updates an Application, access-scoped through findOwnedForUpdate.
   *
   * **Every parent id in the body is resolved inside the caller's organization
   * before anything is written.** `findOwnedForUpdate` scopes the
   * *Application*; it says nothing about the rows the body attaches to it, and
   * `.set(data)` used to spread all eight straight onto the row —
   * `buildServerId`, which an earlier fix had already handled, plus the seven
   * credential-bearing ids in {@link APPLICATION_CREDENTIAL_REFS}, which
   * nothing resolved at all. See that constant for what a build then did with
   * them.
   *
   * **The Previews DNS-01 switch is admitted before the write and reaches live
   * previews after it** — `preview-deployments/preview-dns-challenge.ts`
   * says what it refuses and which previews are rewritten.
   */
  async update(
    ctx: PermissionCtx,
    applicationId: string,
    data: UpdateApplicationDto,
    cron?: CronTimetable,
  ) {
    return this.saved(ctx, applicationId, (keep) =>
      this.updateRow(ctx, applicationId, data, keep, cron),
    );
  }

  /**
   * The console's edit of an Application (`PATCH /applications/:id`): an
   * {@link update}, which also refuses a CPU or memory cap its applied
   * native block sets, since native wins at deploy. An
   * Apply's own write of the size's caps is the config's and goes through
   * {@link update}.
   */
  async edit(
    ctx: PermissionCtx,
    applicationId: string,
    data: UpdateApplicationDto,
  ) {
    return this.saved(ctx, applicationId, (keep) =>
      this.updateRow(ctx, applicationId, data, keep, undefined, true),
    );
  }

  /**
   * `cron` is a plan's change of a Cron service's timetable; no
   * route passes one. `fromConsole` is {@link edit}'s.
   */
  private async updateRow(
    ctx: PermissionCtx,
    applicationId: string,
    data: UpdateApplicationDto,
    keep: KeepConfig,
    cron?: CronTimetable,
    fromConsole = false,
  ): Promise<Application & { domainPortMove?: DomainPortMove }> {
    const current = await this.findOwnedForUpdate(ctx, applicationId);
    // `buildServerId` is the one Server reference `update` accepts
    // (dto/application.dto.ts's updateApplicationSchema). It reached the same
    // foreign key as create's `serverId` and answered the same 500.
    // `serverId` itself is deliberately not in the update schema.
    await checkServerAccess(this.db, ctx, data.buildServerId);
    await refuseOnCloudService(this.db, current, data);
    // A cap its native block sets is the config's.
    if (fromConsole) {
      await refuseNativeSetCaps(this.db, current.applicationId, data);
    }
    await admitPreviewDnsChallenge(this.db, current, data);
    await assertAiModelLocksHeld(this.db, current.applicationId, data);
    // `env` only: a preview's `previewEnv` may override a link (ADR-0021).
    refuseTypedLinkedNames(data.env, current.configLinks);
    // What the recorded kind rules out: a web-private or a worker
    // has no previews, and a web-private publishes no port, the Swarm
    // endpoint spec's included.
    assertPreviewSwitchesAllowed(current.configKind, data);
    // Nor does an Application in a Cloud account (`cloud-preview.ts`).
    refuseCloudPreviewSwitches(current, data);
    // A Cron service's run takes no health check, restart policy, update or
    // rollback: refused here as its plan refuses them.
    assertKindTakesSwarmSettings(current.configKind, data);
    if ((data.endpointSpecSwarm?.Ports?.length ?? 0) > 0) {
      assertKindAllows(current.configKind, 'port');
    }
    if (data.gpus) {
      await this.admitGpus(
        await checkServerAccess(this.db, ctx, current.serverId),
        data.gpus,
      );
    }
    const { aiModel: facetEdit, ...fields } = data;
    const authorized = await resolveCredentialRefs(
      APPLICATION_CREDENTIAL_REFS,
      this.credentialRefResolvers(ctx),
      fields,
    );
    // A port edit moves the Domains on the old port with it, in the
    // transaction that writes the port (ADR-0068).
    const movesDomains = portChangeOf(current, fields) !== null;
    const write = (db: DrizzleTx) =>
      this.writeSettings(db, current, fields, facetEdit, authorized, cron);
    const { row: updated, domainPortMove } = await writeKept(
      this.db,
      keep,
      (db) => (movesDomains ? db.transaction(write) : write(db)),
      ({ row }) => (row ? { serviceId: row.applicationId } : null),
    );
    if (
      updated &&
      dnsChallengeWildcardOf(updated) !== dnsChallengeWildcardOf(current)
    ) {
      await reroutePreviews(this.db, this.traefikConfig, updated);
    }
    return domainPortMove ? { ...updated, domainPortMove } : updated;
  }

  /**
   * {@link updateRow}'s statements, on `db`: the row's columns, then, for a
   * port edit, the Domains on the old port moved to the new one and their
   * routing rewritten (ADR-0068). The rewrite runs before `db` commits, the
   * file written and the transaction held open across it, because a port
   * changed with its Domains unmoved is the 502 this exists to end: a
   * routing write that fails, a Server out of reach included, refuses the
   * whole edit. The old port is read again under a row lock, so two edits
   * at once cannot both move from the port the other has already left.
   */
  private async writeSettings(
    db: DrizzleTx,
    current: {
      applicationId: string;
      appName: string;
      serverId: string | null;
      configKind: ApplicationConfigKind;
      cloudAccountId: string | null;
      port: number;
    },
    fields: Omit<UpdateApplicationDto, 'aiModel'>,
    facetEdit: UpdateApplicationDto['aiModel'],
    authorized: object,
    cron: CronTimetable | undefined,
  ): Promise<{
    row: Application;
    domainPortMove: DomainPortMove | null;
  }> {
    // A `gpus` edit too: it chooses vLLM's or llama.cpp's CPU or GPU
    // image, and llama.cpp's GPU offload args.
    const facetWrites = await admitAiModelEdit(
      db,
      current.applicationId,
      facetEdit,
      fields.gpus,
    );
    const set = {
      ...fields,
      ...facetWrites,
      ...authorized,
      ...configKindAfter(current.configKind, fields.buildType),
      ...(current.configKind === 'cron' ? cron : undefined),
    };
    // A facet edit that rewrites no column (a Hugging Face token alone)
    // leaves this row as it is.
    if (Object.keys(set).length === 0) {
      const [row] = await db
        .select()
        .from(application)
        .where(eq(application.applicationId, current.applicationId));
      return { row, domainPortMove: null };
    }
    const change = await this.lockedPortChange(db, current, fields);
    const [row] = await db
      .update(application)
      // The ids that land are the ones the lookups returned, not the ones the
      // request carried ("the row is written from the id that
      // was authorized"). They are equal by construction today — each lookup
      // filters on the very id it was given — so this is belt-and-braces
      // behind the refusals above rather than a second rule. It is here
      // because it is what stops `.set(data)` being the thing that decides:
      // the write now reads from the authorization result, so a resolver that
      // ever returned a different row would be honoured rather than ignored.
      .set(set)
      .where(eq(application.applicationId, current.applicationId))
      .returning();
    if (!row || !change) return { row, domainPortMove: null };
    const domainPortMove = await moveDomainsOnPort(
      db,
      current.applicationId,
      change,
    );
    // The rewrite a Domain edit makes (`DomainsService`), once for all of
    // them: the file is the Application's, every Domain in it. Not for a
    // Service in a Cloud account, which has no Traefik file: its `serverId`
    // is `null`, which the writer reads as the platform host
    // (`regenerate` asks again).
    if (domainPortMove.moved.length > 0 && !current.cloudAccountId) {
      await this.traefikConfig.regenerate(
        {
          applicationId: current.applicationId,
          appName: current.appName,
          serverId: current.serverId,
        },
        db,
      );
    }
    return { row, domainPortMove };
  }

  /**
   * The port change an edit makes, from the port read under a row lock, or
   * `null` when it moves no Domain; read only when the unlocked read said it
   * would, so an edit with no port in it takes no lock.
   */
  private async lockedPortChange(
    db: DrizzleTx,
    current: {
      applicationId: string;
      port: number;
      cloudAccountId: string | null;
    },
    fields: { port?: number },
  ): Promise<PortChange | null> {
    if (portChangeOf(current, fields) === null) return null;
    const [locked] = await db
      .select({ port: application.port })
      .from(application)
      .where(eq(application.applicationId, current.applicationId))
      .for('update');
    return locked
      ? portChangeOf({ ...current, port: locked.port }, fields)
      : null;
  }

  /**
   * Refuses a GPU reservation the run Server could never hold: more
   * GPUs per copy than it advertises by card ID, or any on a machine that
   * does not qualify or whose runtime would not hand a task its card.
   * Read live from the machine, never cached; whether
   * enough cards are free right now is the deploy's question, not the save's.
   * A run Server cannot change after create (ADR-0035), so create and an
   * edit of `gpus` are the two saves that check.
   */
  private async admitGpus(
    runServer: { serverId: string; name: string } | undefined,
    gpus: number | undefined,
  ): Promise<void> {
    if (!gpus) return;
    const { admission } = await readGpuAdmission(
      this.remoteExec,
      runServer?.serverId ?? null,
    );
    const refusal = gpuReservationRefusal(
      admission,
      gpus,
      runServer?.name ?? 'The platform host',
    );
    if (refusal) throw new BadRequestException(refusal);
  }

  /**
   * One org-scoped lookup per id in {@link APPLICATION_CREDENTIAL_REFS}, each
   * answering with the id it authorized — the only half of the rule that is
   * this module's own (since extracted to `common/credential-refs.ts`).
   *
   * The loop over these lives in {@link resolveCredentialRefs}, which also
   * carries the argument for why it is sequential, why it takes no
   * `PermissionCtx` of its own, and why a refusal raised here is passed
   * through untouched. What is left here is *which service owns which row*,
   * which is the one thing `common/` cannot know: this bundle is where the
   * dependency on six other modules lives, and it is why the extraction did
   * not simply move the whole method — a shared resolver would have to import
   * all six, and `ComposeService`'s five differ from these seven.
   *
   * **Delegating to each provider's own `findOne` rather than writing a
   * seventh ownership lookup** (§1.4, the same decision one id
   * over). Every one of these filters the id and `organizationId` **together**
   * and raises its own `NotFoundException` whichever predicate misses, so a
   * foreign id is refused byte-identically to one that exists nowhere with no
   * new wording for this file to keep in sync — and `findOne` rather than
   * `findOneWithCredentials` means resolving an id never decrypts a secret.
   *
   * `ctx` is closed over rather than threaded through
   * {@link resolveCredentialRefs}: that is what lets a caller with no session
   * — a scheduled run — supply a bundle of its own. See
   * `common/credential-refs.ts`.
   */
  private credentialRefResolvers(
    ctx: PermissionCtx,
  ): CredentialRefResolvers<ApplicationCredentialRef> {
    // `CredentialRefResolvers<ApplicationCredentialRef>` on purpose: this is
    // the type that makes the list load-bearing, because a name added there
    // with no lookup here fails to compile.
    return {
      githubId: async (id) => (await this.github.findOne(ctx, id)).githubId,
      gitlabId: async (id) => (await this.gitlab.findOne(ctx, id)).gitlabId,
      giteaId: async (id) => (await this.gitea.findOne(ctx, id)).giteaId,
      bitbucketId: async (id) =>
        (await this.bitbucket.findOne(ctx, id)).bitbucketId,
      customGitSSHKeyId: async (id) =>
        (await this.sshKeys.findOne(ctx, id)).sshKeyId,
      // Both registry columns resolve through the one Registry lookup — they
      // are two references to the same table (pull credentials and push
      // credentials), which is why `findDeployable` loads `registry` and
      // `buildRegistry` off it. `findOne` rather than
      // `findOneWithCredentials`: resolving an id has no business decrypting a
      // password, the same reason an SSH key is resolved through the
      // sanitized `findOne`.
      registryId: async (id) =>
        (await this.registries.findOne(ctx, id)).registryId,
      buildRegistryId: async (id) =>
        (await this.registries.findOne(ctx, id)).registryId,
    };
  }

  /**
   * Whether the registry a Docker-image source pulls from accepts the
   * login on screen, before a Deployment finds out at the pull. Access-scoped
   * through findOwnedForUpdate — the check saving the same form makes — so a
   * Member who may edit this source may test it, which the Registry routes
   * (`registry: []` for a Member) could not offer.
   *
   * An omitted or empty password means the stored one — **but only against the
   * registry and username it was stored for.** The stored password is handed to
   * whichever host the login names, so honouring a typed hostname with it would
   * let a caller who never held the secret send it to a registry they run and
   * read it off the wire. A test of different values has to bring its own
   * password; the refusal says so before anything runs.
   *
   * It runs on the build host, which is where `dockerStrategy`'s pull — and so
   * its login — happens: `buildHostServerId`, the rule `DeploymentEngineService`
   * dispatches the clone program by.
   *
   * On the Hosted instance an Application with no build host of its own — a
   * cloud web Application, built in the cloud — would have the login run on
   * Cloudgate's shared box with the customer's password, so it is refused with
   * the checks sentence instead (ADR-0053).
   */
  async testRegistryLogin(
    ctx: PermissionCtx,
    applicationId: string,
    data: TestApplicationRegistryLoginDto,
  ): Promise<void> {
    const current = await this.findOwnedForUpdate(ctx, applicationId);
    const host = buildHostServerId(current);
    if (!host) this.instanceMode.refusePlatformHost('checks');
    const registryUrl = data.registryUrl ?? '';
    if (data.password) {
      return this.registries.probeLogin(
        { url: registryUrl, username: data.username, password: data.password },
        host,
      );
    }
    const [stored] = await this.db
      .select({
        password: application.password,
        registryUrl: application.registryUrl,
        username: application.username,
      })
      .from(application)
      .where(eq(application.applicationId, current.applicationId))
      .limit(1);
    if (!stored?.password) {
      throw new BadRequestException(
        'No registry password is stored for this Application',
      );
    }
    // `''` and `null` both spell Docker Hub in this column (`registryUrlSchema`).
    if (
      registryUrl !== (stored.registryUrl ?? '') ||
      data.username !== (stored.username ?? '')
    ) {
      throw new BadRequestException(
        'The stored password is only tested against the registry and username it was saved with. Type the password to test these values',
      );
    }
    return this.registries.probeLogin(
      { url: registryUrl, username: data.username, password: stored.password },
      host,
    );
  }

  /**
   * env/buildArgs/buildSecrets land in encrypted columns; the update is
   * access-scoped through findOwnedForUpdate.
   */
  async saveEnvironment(
    ctx: PermissionCtx,
    applicationId: string,
    data: SaveApplicationEnvironmentDto,
  ) {
    return this.saved(ctx, applicationId, (keep) =>
      this.saveEnvironmentRow(ctx, applicationId, data, keep),
    );
  }

  private async saveEnvironmentRow(
    ctx: PermissionCtx,
    applicationId: string,
    data: SaveApplicationEnvironmentDto,
    keep: KeepConfig,
  ) {
    const current = await this.findOwnedForUpdate(ctx, applicationId);
    await assertAiModelLocksHeld(this.db, current.applicationId, data);
    refuseTypedLinkedNames(data.env, current.configLinks);
    return this.writeRow(current.applicationId, data, keep);
  }

  /**
   * The Application's own runtime variables by name, each with the
   * Output it is wired to; never a value (ADR 0019). Read-scoped through
   * findOwned.
   */
  async listVariables(
    ctx: PermissionCtx,
    applicationId: string,
  ): Promise<VariableList> {
    const current = await this.findOwned(ctx, applicationId);
    const [row] = await this.db
      .select({ env: application.env })
      .from(application)
      .where(eq(application.applicationId, current.applicationId));
    return { variables: variableNames(row?.env ?? null, current.configLinks) };
  }

  /**
   * Sets and unsets named keys in the Application's own runtime variables
   * leaving every other key as it was, and answers the names, never
   * a value (ADR 0019). Update-scoped through findOwnedForUpdate. Nothing is
   * deployed.
   *
   * The row is read `FOR UPDATE` in the transaction that writes it, so two
   * changes to different keys at once both land rather than the later one
   * writing back the text the earlier one replaced. A wired name refuses a
   * typed value as `PATCH :id/environment` does, and like that write this is
   * a console Save of a Cloudgate-kept config (a new name joins the
   * Service's entry) and is checked against a repository-kept one.
   */
  async updateVariables(
    ctx: PermissionCtx,
    applicationId: string,
    data: ChangeVariablesDto,
  ): Promise<VariableList> {
    return this.saved(ctx, applicationId, (keep) =>
      this.changeVariablesRow(ctx, applicationId, data, keep),
    );
  }

  private async changeVariablesRow(
    ctx: PermissionCtx,
    applicationId: string,
    data: ChangeVariablesDto,
    keep: KeepConfig,
  ): Promise<VariableList> {
    const current = await this.findOwnedForUpdate(ctx, applicationId);
    const set = data.set ?? {};
    const unset = data.unset ?? [];
    const typed = withVariables(null, set, []);
    await assertAiModelLocksHeld(this.db, current.applicationId, {
      env: typed,
    });
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ env: application.env, configLinks: application.configLinks })
        .from(application)
        .where(eq(application.applicationId, current.applicationId))
        .for('update');
      refuseTypedLinkedNames(typed, row.configLinks);
      refuseUnsetOfMissing(row.env, row.configLinks, unset, current.configName);
      const env = withVariables(row.env, set, unset);
      await tx
        .update(application)
        .set({ env })
        .where(eq(application.applicationId, current.applicationId));
      await keep(tx, { serviceId: current.applicationId });
      return { variables: variableNames(env, row.configLinks) };
    });
  }

  /**
   * The upload half of a drop deployment: extract the zip into the
   * application's code directory on its build server and switch the row to the
   * `drop` source. Deploying stays a separate call, so a screen can show what
   * landed before committing to a build.
   *
   * The archive is untrusted — readDropArchive rejects an entry that could
   * escape the code directory, before any path reaches a command.
   *
   * **The build host, not `serverId` — the write side of the build-host defect, in the
   * same file as the Delete side.** The docblock above has said *"on its build
   * server"* since this route landed and the code said `current.serverId`; the
   * path it writes is
   * `{applicationsDirectoryOn(buildHostServerId)}/{appName}/code`, byte for
   * byte what {@link DeploymentEngineService.deploy} clones into and what the
   * build then reads. So on an install with a dedicated build Server the tree
   * was written to the runner and looked for on the builder. Once the Delete
   * began removing it from the build host (the other half of that fix) the two
   * disagreed the other way round as well: a `drop` Application's tree would
   * be written to one machine and `rm -rf`'d on the other, which *moves* a
   * leak rather than closing it. `buildHostServerId` is the one statement of
   * the rule and this is its fifth call site.
   *
   * `execOnServer` rather than this method's own `serverId ? … : …` fork, which
   * was the sixth copy of the dispatch `remote/exec-dispatch.ts` exists to hold
   * through {@link materializeDrop}. The string arm, because
   * `dropArchiveCommand` is a shell *program* — `rm -rf`, `mkdir -p` and one
   * `base64 -d` redirect per file — and it `quote()`s every path it
   * interpolates, which is §2.9's contract for that shape. It travels on the
   * shell's stdin rather than as its argument, so a tree of several MB is not
   * refused by the kernel's 128 KiB cap on one argument.
   */
  async uploadDrop(
    ctx: PermissionCtx,
    applicationId: string,
    zip: Buffer,
    data: UploadApplicationDropDto,
  ) {
    return this.saved(ctx, applicationId, (keep) =>
      this.uploadDropRow(ctx, applicationId, zip, data, keep),
    );
  }

  private async uploadDropRow(
    ctx: PermissionCtx,
    applicationId: string,
    zip: Buffer,
    data: UploadApplicationDropDto,
    keep: KeepConfig,
  ) {
    const current = await this.findDropTarget(ctx, applicationId);
    const entries = readDropArchive(zip);
    await materializeDrop(
      this.remoteExec,
      buildHostServerId(current),
      dropCodeDirectory(current),
      entries,
    );
    return this.switchToDrop(current.applicationId, data, keep);
  }

  /**
   * The first half of uploading only the changed files (spec #10): which
   * of the folder's `files` the build host is missing or holds different, and
   * how many it holds already and beyond the list. Refused as
   * {@link uploadDrop} is, since it is the first step of one: changes nothing.
   */
  async compareDrop(
    ctx: PermissionCtx,
    applicationId: string,
    files: Buffer,
  ): Promise<DropComparison> {
    const current = await this.findDropTarget(ctx, applicationId);
    const list = readDropFileList(files);
    const tree = await readBuildHostTree(
      this.remoteExec,
      buildHostServerId(current),
      dropCodeDirectory(current),
    );
    return compareDropFiles(list, tree);
  }

  /**
   * The second half: the whole folder's `files` and a `zip` of only the ones
   * {@link compareDrop} asked for, applied on the build host as one swap
   * (`drop-changes.ts`), then the source switched exactly as
   * {@link uploadDrop} switches it. A tree that does not match the list is a
   * 409 and switches nothing.
   */
  async applyDrop(
    ctx: PermissionCtx,
    applicationId: string,
    files: Buffer,
    zip: Buffer,
    data: UploadApplicationDropDto,
  ) {
    return this.saved(ctx, applicationId, async (keep) => {
      const current = await this.findDropTarget(ctx, applicationId);
      const list = readDropFileList(files);
      const entries = readDropArchive(zip);
      const listed = new Set(list.map((file) => file.path));
      const stray = entries.find(
        (entry) => entry.content !== null && !listed.has(entry.path),
      );
      if (stray) {
        throw new BadRequestException(
          `Zip entry "${stray.path}" is not in the file list`,
        );
      }
      await applyDropChanges(
        this.remoteExec,
        buildHostServerId(current),
        dropCodeDirectory(current),
        list,
        entries,
      );
      return this.switchToDrop(current.applicationId, data, keep);
    });
  }

  /**
   * The Application an upload lands in, refused where any upload is: one
   * whose source an AI model holds, one a build is reading, and one whose run
   * or build Server is in maintenance.
   */
  private async findDropTarget(ctx: PermissionCtx, applicationId: string) {
    const current = await this.findOwnedForUpdate(ctx, applicationId);
    // A drop switches the source, which an AI model's is not.
    await assertAiModelLocksHeld(this.db, current.applicationId, {
      sourceType: 'drop',
    });
    // Never pulls the tree from under a build reading it.
    await refuseWhileBuilding(this.db, current.applicationId);
    // Nor lands a drop for a Server in maintenance, run or build (spec
    // #1420): the archive is written onto the build Server.
    await refuseWhileInMaintenance(this.db, [
      current.serverId,
      current.buildServerId,
    ]);
    return current;
  }

  /** The row's source switched to uploaded files, through the console Save. */
  private switchToDrop(
    applicationId: string,
    data: UploadApplicationDropDto,
    keep: KeepConfig,
  ) {
    return this.writeRow(
      applicationId,
      {
        sourceType: 'drop',
        // Default: the archive root.
        dropBuildPath: data.dropBuildPath ?? '/',
      },
      keep,
    );
  }

  /**
   * Scales the swarm service up and marks the row done. The same
   * lifecycle every managed database engine has had since the shared base class
   * landed.
   *
   * `options.detach` is the MCP tool's: the scale returns once Swarm
   * has the replica count instead of once the task runs, and `done` is
   * written ahead of convergence — the agent polls the status. The console
   * route passes nothing and waits, as it always has.
   *
   * **In a Cloud account** the ECS desired count goes back to the
   * Service's `replicas` — one direct call, which answers once ECS has it,
   * so `detach` changes nothing there. On Cloud Run the service's
   * automatic scaling comes back, in its copy range.
   */
  async start(
    ctx: PermissionCtx,
    applicationId: string,
    options: ScaleOptions = {},
  ) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const current = await this.findOwned(ctx, applicationId);
    // Nothing new starts on a Server in maintenance (spec #1420), a Cron
    // service's next run included.
    await refuseWhileInMaintenance(this.db, [current.serverId]);
    // A Cron service has no Swarm service to scale: Start ends its pause,
    // and its timetable fires again from the next fire time.
    if (current.configKind === 'cron') {
      return this.resumeCron(current.applicationId);
    }
    refuseWhileCloudDelete(current);
    const cloud = cloudTargetOf(current);
    if (cloud) {
      await this.cloudLifecycle.start(cloud);
    } else {
      await this.admitGpuStart(current);
      await this.scaleOrRefuse(current, 1, 'start', options);
    }
    return this.updateStatus(current.applicationId, 'done');
  }

  /**
   * A Stopped Cron service armed again: `done`, read by the
   * timetable as not Stopped. A Cron service not Stopped is left as it is,
   * so a Start never hides a failed build's `error`. Nothing is made up:
   * the timetable's window moved on while it was Stopped.
   */
  private async resumeCron(applicationId: string) {
    const [resumed] = await this.db
      .update(application)
      .set({ applicationStatus: 'done' })
      .where(
        and(
          eq(application.applicationId, applicationId),
          eq(application.applicationStatus, 'stopped'),
        ),
      )
      .returning();
    if (resumed) return resumed;
    const [current] = await this.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));
    if (!current) throw new NotFoundException('Application not found');
    return current;
  }

  /**
   * A Cron service whose Delete is refused, armed again as it was before the
   * Delete paused it: a Delete that did not happen is not a Stop.
   */
  private async unpauseRefusedCronDelete(current: {
    applicationId: string;
    configKind: string;
    applicationStatus: ApplicationStatus;
  }): Promise<void> {
    if (
      current.configKind !== 'cron' ||
      current.applicationStatus === 'stopped'
    ) {
      return;
    }
    await this.db
      .update(application)
      .set({ applicationStatus: current.applicationStatus })
      .where(eq(application.applicationId, current.applicationId));
  }

  /**
   * Scales the swarm service to zero and marks the row stopped. The image, the
   * volumes, the domains and the row survive — this is downtime, not deletion.
   *
   * **`'stopped'`, not `'idle'`.** `'idle'` is the column's default, so
   * writing it here made an Application an operator had just stopped wear the
   * word one that had never been deployed wears — on the masthead, in the
   * facts card, and again after a reload. An earlier fix made the same write in
   * `BaseDatabaseService.stop`; this is that fix one module over.
   *
   * `options.detach` as {@link start}'s.
   *
   * **In a Cloud account** the ECS desired count is set to zero, or
   * a Cloud Run service switched to manual scaling at no copies, so it
   * refuses traffic. What
   * the Service still costs while stopped — its share of the Environment
   * network, its stored images and its Runtime log — and its Domains'
   * 503 until Start are the console's to say before it is pressed.
   */
  async stop(
    ctx: PermissionCtx,
    applicationId: string,
    options: ScaleOptions = {},
  ) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const current = await this.findOwned(ctx, applicationId);
    // A Cron service's Stop is its per-Environment pause (ADR-0034):
    // `stopped` disarms its timetable, and each run in flight is stopped and
    // recorded so. The Project config is not touched.
    if (current.configKind === 'cron') {
      const paused = await this.updateStatus(current.applicationId, 'stopped');
      await this.stopCronRuns(ctx, current.applicationId, 'stopped');
      await this.incidents.closeForService(
        'application',
        current.applicationId,
      );
      return paused;
    }
    const cloud = cloudTargetOf(current);
    if (cloud) {
      await this.cloudLifecycle.stop(cloud);
    } else {
      await this.scaleOrRefuse(current, 0, 'stop', options);
    }
    const stopped = await this.updateStatus(current.applicationId, 'stopped');
    // After the status write, so the tick that follows sees a Stopped Service
    // and probes nothing. Never throws: the Stop has happened.
    await this.incidents.closeForService('application', current.applicationId);
    return stopped;
  }

  /**
   * Scales the service down and straight back up, so the task is recreated on
   * the spec the service already has. Nothing is cloned, built or pushed — that
   * is {@link DeploymentsService.deploy}'s job — which is why an Application
   * whose only problem is a wedged process does not need a build to come back.
   *
   * Scale rather than `docker service update --force`: the forced update rolls
   * tasks under the service's own UpdateConfig, and an Application with a
   * one-replica non-parallel update config would sit waiting on the very task
   * that is wedged.
   *
   * **In a Cloud account** it is ECS's `forceNewDeployment`: every
   * running copy is replaced by a fresh one of the same version, and the
   * status is left as it was. A stopped Service has no copy to replace, so
   * Reload is refused with the reason until Start; scaling it up here would
   * be a Start the operator did not ask for. On Cloud Run it is a fresh
   * revision of the same image, by Reload's revision label (S9).
   */
  async reload(ctx: PermissionCtx, applicationId: string) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const current = await this.findOwned(ctx, applicationId);
    if (current.configKind === 'cron') {
      throw new ConflictException(
        'A Cron service has nothing running to restart: each run starts a fresh container and leaves none. Run now starts a run',
      );
    }
    // A reload starts the Service's task again, which a Server in
    // maintenance refuses as it refuses Start (spec #1420).
    await refuseWhileInMaintenance(this.db, [current.serverId]);
    const cloud = cloudTargetOf(current);
    if (cloud) {
      if (current.applicationStatus === 'stopped') {
        throw new ConflictException(CLOUD_RELOAD_WHILE_STOPPED);
      }
      await this.cloudLifecycle.reload(cloud);
      const [row] = await this.db
        .select()
        .from(application)
        .where(eq(application.applicationId, current.applicationId));
      return row;
    }
    // Before the scale down, so a refused Restart leaves the task it has.
    await this.admitGpuStart(current);
    await this.scaleOrRefuse(current, 0, 'restart');
    // What Stop writes, for what Stop did: if the scale back up throws,
    // this is the status the row keeps, over a service at zero.
    await this.updateStatus(current.applicationId, 'stopped');
    await this.scaleOrRefuse(current, 1, 'restart');
    return this.updateStatus(current.applicationId, 'done');
  }

  /**
   * A Cloud Run Service's copy range (spec S10):
   * Cloudgate's, never the config's, set on the service by a direct call
   * and then saved, so a range Google refuses is never kept. Before any
   * deploy has made the service it is only saved, and the first deploy
   * creates it so. `service: ['update']`, as any edit of the Service.
   */
  async setCopyRange(
    ctx: PermissionCtx,
    applicationId: string,
    data: CopyRangeDto,
  ) {
    const current = await this.findOwnedForUpdate(ctx, applicationId);
    refuseWhileCloudDelete(current);
    const cloud = cloudTargetOf(current);
    if (!cloud) {
      throw new ConflictException(
        `Only a Service on Cloud Run has a copy range; ${current.name} has replicas`,
      );
    }
    await this.cloudLifecycle.setCopyRange(cloud, {
      min: data.minCopies,
      max: data.maxCopies,
    });
    const [row] = await this.db
      .update(application)
      .set({ minCopies: data.minCopies, maxCopies: data.maxCopies })
      .where(eq(application.applicationId, current.applicationId))
      .returning();
    return row;
  }

  /**
   * Refuses a Start or Restart of a GPU reservation the run Server cannot meet
   * now, with a 409 and the deploy's words (ADR-0039). Each scales the
   * service to one copy and so starts a task off the reservation already
   * saved: on a Server set up again the old way since the save, Swarm would
   * place it on a card its container never sees, and with the card taken by
   * another Service while this one was stopped it would wait `pending` —
   * which `docker service scale`, waiting for convergence, would wait on too.
   * The service's own running task counts as free, so a Restart, or a Start
   * of a Service already up, on a Server it alone fills passes.
   */
  private async admitGpuStart(current: {
    serverId: string | null;
    appName: string;
    gpus: number;
  }): Promise<void> {
    if (!current.gpus) return;
    const refusal = await gpuReleaseRefusal(this.remoteExec, this.db, {
      serverId: current.serverId,
      gpus: current.gpus,
      copies: 1,
      ownServiceId: () =>
        applicationServiceId(
          this.remoteExec,
          current.serverId,
          current.appName,
        ),
    });
    if (refusal) throw new ConflictException(refusal);
  }

  /**
   * `docker service scale`, refused with a 409 when there is no service to
   * scale.
   *
   * An Application no Deployment has released — its only build failed, or it
   * was never deployed — has no Swarm service, and the scale exits "service …
   * not found". Unhandled, that was a 500, which the console has to read as
   * "the proxy stopped listening while the service converged" and reported as
   * possibly still running: about a request that came back at once, with
   * nothing running and nothing about to.
   *
   * **The presence read decides, not the scale's stderr**, and only once the
   * scale has failed, so the common path is the one command it always was.
   * {@link applicationServicePresence} is Delete's read and already
   * separates "no such service" from a daemon or a Server that cannot be
   * reached; only `absent` is refused. `unknown`, or a service that is there
   * and failed to scale for its own reasons, rethrows what the scale threw.
   */
  private async scaleOrRefuse(
    current: { serverId: string | null; appName: string },
    replicas: 0 | 1,
    verb: 'start' | 'stop' | 'restart',
    options: ScaleOptions = {},
  ): Promise<void> {
    try {
      await scaleApplicationService(
        this.remoteExec,
        current.serverId,
        current.appName,
        replicas,
        options,
      );
    } catch (error) {
      const presence = await applicationServicePresence(
        this.remoteExec,
        current.serverId,
        current.appName,
      );
      if (presence !== 'absent') throw error;
      throw new ConflictException(
        `There is no Swarm service '${current.appName}' to ${verb}: no Deployment of this Application has finished and released one, or it was removed outside Cloudgate, so deploy the Application to create it`,
      );
    }
  }

  /**
   * Rotates the secret in the Application's deploy-webhook URL. A new value in
   * the existing column — the column already defaults through
   * `$defaultFn(nanoid)`, so rotation is the same generator, not a new shape.
   *
   * Gated exactly like {@link update} and {@link saveEnvironment} —
   * {@link findOwnedForUpdate}'s `service: ['update']` and row-level access, no
   * extra org-level statement: rotating this is a service config change, and
   * whoever may repoint the Application's branch may certainly invalidate its
   * webhook.
   */
  async refreshToken(ctx: PermissionCtx, applicationId: string) {
    const current = await this.findOwnedForUpdate(ctx, applicationId);
    const [updated] = await this.db
      .update(application)
      .set({ refreshToken: nanoid() })
      .where(eq(application.applicationId, current.applicationId))
      .returning();
    return updated;
  }

  /**
   * Delete, in `CONTEXT.md`'s sense: the swarm service, the Traefik dynamic
   * config that routes at it, the Application's directory and its patch-repo
   * clone on its build host, and then the row. Volumes survive unless asked for
   * — `database-service.ts` says the same thing in its own words, "only rebuild
   * destroys data".
   *
   * **The row goes last, and a teardown that cannot be confirmed refuses the
   * delete.** This used to be `db.delete(application)` and nothing else,
   * deferring the runtime cleanup to a Phase 21 that has since arrived —
   * `deployment-engine/` is what deploys the service in the first place. The
   * consequence was not litter. The row is the only handle the product has on
   * the workload, so dropping it while the service still ran left a container
   * that no console screen and no API route could reach; and per ADR-0008 a
   * container that resolves to no Service is *unmanaged*, reached through
   * machine-level `docker:read` — "where there is no Service to ask about".
   * After "managed" became the thing that decides what a listing
   * may show and what a socket may reach, deleting an Application therefore
   * moved its running container from private-to-one-organization to readable
   * and actable by every organization on the host. ADR-0008 never contemplated
   * a case where there *was* a Service to ask about and the product destroyed
   * the ability to ask; this is that case, and this ordering is what closes it.
   *
   * So the sequence is teardown → verify → row, deliberately not wrapped in a
   * transaction: a transaction cannot span a Docker call, and a row that
   * committed while the exec was still in flight would be the worse failure.
   * The sequence is safe in the direction that matters. Dying between the
   * teardown and the delete leaves a row naming a workload that is gone, which
   * the console shows as a service you can still delete again. Row gone,
   * workload alive is the state that is unrecoverable through the product, and
   * it is the one this order makes impossible.
   *
   * `force` is the escape hatch for a Server that is never coming back —
   * "a dead server must not make deletion impossible" is a real constraint —
   * but it is a deliberate act with a truthful answer: the response names what
   * was left behind instead of a bare 200.
   *
   * **A fourth step joins the three teardowns, and it is not one of them: the
   * preserved rollback images** (ADR-0016). `rollback.image` is the only
   * record of a `${appName}:v${version}` tag `captureRollback` made — nothing
   * else in the database names one, and a `docker images` listing cannot tell a
   * preserved snapshot from anything else — and `deployment.applicationId`'s
   * cascade destroys every such row here. So the images were left on disk with
   * nothing able to identify them, on the **default single-Server install** as
   * much as on a build-Server one. It is not in the `teardown` array above
   * because it must run *after* the presence refusal rather than before it: a
   * kept Application whose snapshots' images had been deleted would still offer
   * Rollback on every one of them. `?force=true` does not gate it — a leftover
   * image is disk rather than ADR-0008's unmanaged container — and a failure
   * never blocks the delete; it is named in `unreclaimedImages` instead.
   *
   * **A fifth step joins it, in the same slot and for a sharper reason: the
   * preview deployments**. Everything above names *this Application's*
   * `appName`, and a preview runs under its own — so
   * `preview_deployment.applicationId`'s cascade dropped every preview row
   * while its Swarm service kept running, which unlike a leftover image *is*
   * ADR-0008's unmanaged container and is the same finding reached through a
   * table that fix never looked at. `preview-teardown.ts` carries the argument for
   * why it sits here rather than in the `teardown` array (tearing previews down
   * ahead of the refusal would destroy the live previews of an Application the
   * caller is then told still exists) and why it reports rather than refuses.
   *
   * **The directory step goes to the build host, not to `serverId`**.
   * The engine clones into
   * `{applicationsDirectoryOn(buildHostServerId)}/{appName}/code`, i.e. on
   * `buildServerId || serverId`, and this is the only thing that removes it; the
   * two ids coincide on a single-Server install, which is why aiming at the
   * wrong one stayed green everywhere it was tested. `buildHostServerId` is now
   * the one statement of that rule, and {@link uploadDrop} is the write side of
   * the same one. **And it runs after the refusal, not before it**: on a
   * single-Server install that directory is the parent of the file mounts and
   * the Trace store, so a 409 must leave it whole.
   *
   * **And every machine step whose failure nothing else can see now says what
   * it left**. The presence read below asks the *run* Server about
   * a Swarm service: it answers for `removeApplicationService` and for nothing
   * else. It says nothing about the source tree on the builder, nothing about
   * the Traefik dynamic config on its own Server, and nothing about the
   * patch-repo clone — so a failure of any of the three went into the
   * best-effort `catch` and appeared in no field of the response, and this route
   * answered a clean 200 having leaked an artifact it knew it had not removed.
   * The Traefik one is the sharpest of the three, because it is the only one
   * that is not merely disk: a router fragment that outlives the Application
   * keeps a public hostname advertised at a backend that is gone. All three are
   * named in `unreclaimedArtifacts`, and like a leftover image none of them
   * refuses the delete; `common/teardown-steps.ts` carries the argument,
   * including why one field with a `kind` and not one field per artifact.
   *
   * **A sixth step joins the reclamations: the patch-repo clone**. It is
   * the browsable copy of the entity's source that the patch editor lists and
   * reads, `{patchReposDirectory()}/application/{appName}` on the build host,
   * and nothing in the product reclaimed it — `PatchRepoService.cleanRepos`
   * globs the whole tree on an operator-named Server and is a maintenance
   * sweep, not a reclamation. It sits in this slot rather than the `teardown`
   * array for the reason the images do, sharpened: the clone is a cache
   * `ensureRepo` rebuilds, so destroying it ahead of a refusal would take the
   * patch editor away from an Application the caller is then told still exists,
   * and would re-clone on the next open for nothing.
   *
   * **A seventh joins them, and it is the last of ADR-0016's images: the
   * `${appName}:latest` a build leaves on the build host**. Nothing in
   * the product removed it on any path — before this, `docker image rm`
   * occurred in exactly one file of `src`, `rollbacks.service.ts` — so the only
   * sweep was the machine-wide `docker image prune --all` from Settings →
   * Maintenance. Two
   * things decide its shape and both are argued in
   * `applications/built-image.ts`: a `sourceType: 'docker'` Application builds
   * nothing and its image is the operator's own `dockerImage`, so that arm
   * reclaims nothing; and the buildkit cache beside the image is **not**
   * reclaimed, because a BuildKit cache record carries no image, tag or
   * repository field to scope a prune by — measured, not assumed. It shares
   * `unreclaimedImages` with the preserved tags rather than adding a field or a
   * fourth `UnreclaimedArtifact` `kind`, which
   * `common/teardown-steps.ts`'s `UnreclaimedImages` argues. Its slot is this
   * one for `reclaimPreservedImages`' reason at its sharpest: this tag is the
   * image the Swarm service *is running*, so untagging it ahead of a 409 would
   * leave a live Application whose next scheduled task cannot pull its own
   * image.
   */
  async remove(
    ctx: PermissionCtx,
    applicationId: string,
    force = false,
    deleteVolumes = false,
  ) {
    if (!this.consoleSaves) {
      return this.removeRow(
        ctx,
        applicationId,
        force,
        deleteVolumes,
        KEEP_NOTHING,
      );
    }
    return this.consoleSaves.remove(
      ctx,
      { serviceType: 'application', serviceId: applicationId },
      (keep) => this.removeRow(ctx, applicationId, force, deleteVolumes, keep),
    );
  }

  /**
   * **Retry** a cloud Service's incomplete Delete (ADR-0038): another
   * destroy-only Cloud run from the kept state. Needs the Delete's own
   * `service: delete`.
   */
  async retryCloudDelete(ctx: PermissionCtx, applicationId: string) {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'delete');
    const cloud = cloudDeleteTargetOf(await this.findOwned(ctx, applicationId));
    if (!cloud) throw new NotFoundException('This Service has no cloud Delete');
    return this.requireCloudDeletes().request(ctx, cloud, KEEP_NOTHING, true);
  }

  /**
   * **Forget** a cloud Service's incomplete Delete (ADR-0038): the row
   * dropped with its leftovers still in AWS, the list written into the audit
   * entry. Needs `service: delete`.
   */
  async forgetCloudDelete(ctx: PermissionCtx, applicationId: string) {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'delete');
    const cloud = cloudDeleteTargetOf(await this.findOwned(ctx, applicationId));
    if (!cloud) throw new NotFoundException('This Service has no cloud Delete');
    return this.requireCloudDeletes().forget(ctx, cloud);
  }

  /**
   * The end of a cloud Service's Delete, clean or forgotten: what a
   * Server's Delete reclaims on the platform host, where a cloud Service
   * builds — its built image and build leftovers, its patch-repo clone, its
   * directory and its Deployment logs (ADR-0018) — then the row, whose
   * Deployments go with it. Nothing of it ran on a Server, so there is no
   * Swarm service, Traefik file, mount or volume to reclaim. Answers what it
   * could not reclaim, each field absent rather than empty.
   */
  async dropCloudService(applicationId: string) {
    const [current] = await this.db
      .select({
        applicationId: application.applicationId,
        appName: application.appName,
        serverId: application.serverId,
        buildServerId: application.buildServerId,
        sourceType: application.sourceType,
      })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    if (!current) return {};
    const deleteExec = new ReachabilityMemo(this.remoteExec);
    // Nothing of a cloud Service runs on its build host, so no container
    // holds the image there for long.
    const unreclaimedImages = await reclaimBuiltImages(
      deleteExec,
      [current],
      awaitImageRelease(),
    );
    await reclaimBuildLeftovers(deleteExec, [current]);
    const unreclaimedArtifacts = [
      ...(await reclaimApplicationPatchRepos(deleteExec, [current])),
      ...(await reclaimApplicationDirectory(deleteExec, current)),
      ...(await reclaimDeploymentLogs(deleteExec, [
        { appName: current.appName, serverId: buildHostServerId(current) },
      ])),
    ];
    // Its Domains' DNS records outlive the row at the operator's DNS
    // provider; its Environment network keeps them, to name them again when
    // it is removed.
    await keepDomainRecordsOnNetwork(this.db, applicationId);
    await this.db
      .delete(application)
      .where(eq(application.applicationId, applicationId));
    return {
      ...(unreclaimedImages.length > 0 ? { unreclaimedImages } : {}),
      ...(unreclaimedArtifacts.length > 0 ? { unreclaimedArtifacts } : {}),
    };
  }

  private requireCloudDeletes(): CloudServiceDeletes {
    if (!this.cloudDeletes) {
      throw new Error('This Cloudgate cannot delete a cloud Service');
    }
    return this.cloudDeletes;
  }

  /**
   * A console write to an Application's settings, kept in step with a
   * Cloudgate-kept Project config.
   */
  private saved<T>(
    ctx: PermissionCtx,
    applicationId: string,
    write: (keep: KeepConfig) => Promise<T>,
  ): Promise<T> {
    if (!this.consoleSaves) return write(KEEP_NOTHING);
    return this.consoleSaves.update(
      ctx,
      { serviceType: 'application', serviceId: applicationId },
      write,
    );
  }

  /**
   * One settings write, in the transaction its console Save's config
   * rewrite commits in.
   */
  private writeRow(
    applicationId: string,
    values: Partial<typeof application.$inferInsert>,
    keep: KeepConfig,
  ) {
    return writeKept(
      this.db,
      keep,
      async (db) => {
        const [row] = await db
          .update(application)
          .set(values)
          .where(eq(application.applicationId, applicationId))
          .returning();
        return row;
      },
      (row) => (row ? { serviceId: applicationId } : null),
    );
  }

  private async removeRow(
    ctx: PermissionCtx,
    applicationId: string,
    force: boolean,
    deleteVolumes: boolean,
    keep: KeepConfig,
  ) {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'delete');
    const current = await this.findOwned(ctx, applicationId);
    // In a Cloud account the Delete is a destroy-only Cloud run
    // (ADR-0038): the row stays, `deleting`, until it finishes clean.
    const cloud = cloudDeleteTargetOf(current);
    if (cloud) {
      // A Cron service on ECS: its timetable disarmed and each run
      // in flight stopped first, as on a Server. A task not confirmed
      // stopped keeps the row, so the Delete is refused and armed again.
      if (current.configKind === 'cron') {
        await this.updateStatus(current.applicationId, 'stopped');
        const left = await this.stopCronRuns(
          ctx,
          current.applicationId,
          'deleted',
        );
        if (left.length > 0 && !force) {
          await this.unpauseRefusedCronDelete(current);
          throw new ConflictException(
            `Cloudgate could not confirm the run task ${left.join(', ')} of this Cron service is stopped, so it was kept, and that run goes on — delete again when AWS answers, or delete with ?force=true`,
          );
        }
      }
      return {
        ...(await this.requireCloudDeletes().request(ctx, cloud, keep, false)),
        ...NO_SERVER_LEFTOVERS,
      };
    }
    // Every step below dials through this one, so a Server it could not
    // connect to is dialled once for the whole Delete rather than once per
    // step — `remote/reachability-memo.ts`.
    const deleteExec = new ReachabilityMemo(this.remoteExec);
    // Read once, before anything goes: `ai_model` cascades with the row, and
    // both the gateway router and the weights volume below hang on it.
    const aiModel = (await readAiModelFacet(this.db, applicationId)) !== null;

    // A Cron service's timetable is disarmed first, so no fire time starts a
    // run while the ones in flight are stopped (ADR-0034). Its Run
    // records then cascade with the row, and their logs go with the run
    // Server's below. A refused Delete arms it again as it was: the operator
    // asked for a Delete, not a Stop.
    const cronJobsLeft =
      current.configKind === 'cron'
        ? await this.updateStatus(current.applicationId, 'stopped').then(() =>
            this.stopCronRuns(ctx, current.applicationId, 'deleted'),
          )
        : [];

    // Each step best-effort in its own try/catch, in
    // preview-deployments.service.ts's shape and for its stated reason: a
    // missing service can't strand the others. Removing the dynamic config is
    // not optional — `domain.applicationId` cascades, so the domain rows go
    // with the row, but the file they generated does not, and without this the
    // delete leaves a public hostname routed at nothing.
    //
    // The Application's directory is not in this array: see the
    // reclamation after the refusal below.
    const teardown = [
      {
        run: () =>
          removeApplicationService(
            deleteExec,
            current.serverId,
            current.appName,
          ),
      },
      // The run Server's file, and the second of the three steps that now names
      // what it left. `domain.applicationId` cascades, so the domain
      // rows go with the row and the dynamic-config file they generated does
      // not — and the presence read below asks that same Server about a Swarm
      // service, so it can say nothing about a file. A failure here therefore
      // used to leave a public hostname advertised at a backend that was gone,
      // reported nowhere, behind a clean 200.
      removeTraefikConfigStep(
        this.traefikWriter,
        current.serverId,
        current.appName,
        deleteExec,
      ),
      // An AI model's gateway-only router, which no Domain wrote and
      // `regenerate` never touches.
      ...(aiModel
        ? [
            removeGatewayRouteStep(
              deleteExec,
              current.serverId,
              current.appName,
            ),
          ]
        : []),
    ];
    // Best effort per step: what is left is decided by the presence read below
    // and by what this answers, not by which of these threw.
    const teardownLeaks = await runTeardownSteps(teardown);

    const presence = await applicationServicePresence(
      deleteExec,
      current.serverId,
      current.appName,
    );
    // A run's job whose removal is unconfirmed is a container the row is the
    // only handle on, as the Swarm service is.
    if (cronJobsLeft.length > 0 && !force) {
      await this.unpauseRefusedCronDelete(current);
      throw workloadKeptRefusal(
        'unknown',
        `Cloudgate could not confirm the run job ${cronJobsLeft.join(', ')} of this Cron service is gone, so it was kept, and that run goes on — delete again when its Server is reachable, or delete with ?force=true`,
      );
    }
    if (presence !== 'absent' && !force) {
      await this.unpauseRefusedCronDelete(current);
      throw workloadKeptRefusal(
        presence,
        presence === 'present'
          ? `Swarm service ${current.appName} is still running, so the Application was kept: deleting the record would leave the workload unreachable through Cloudgate — stop it, then delete again, or delete with ?force=true`
          : `Cloudgate could not reach Docker to confirm swarm service ${current.appName} is gone, so the Application was kept — delete again when the server is reachable, or delete with ?force=true`,
      );
    }

    // Three reclamations share this slot — after the refusal above and before
    // the row below — and both halves of that are load-bearing for the reason
    // `reclaimPreservedImages` states at length (ADR-0016).
    //
    // The previews go first: they are the arm that drops containers, and an
    // image is only disk. `preview_deployment.applicationId` cascades, so the
    // statement below destroys every preview row while its Swarm service keeps
    // running — ADR-0008's unmanaged container, reachable through machine-level
    // `docker:read` by every organization on the host, which is the same finding
    // reached through a table it never looked at.
    const previews = await tearDownApplicationPreviews(this.db, deleteExec, [
      current.applicationId,
    ]);
    // `rollback.image` is the only record of a preserved `${appName}:v${version}`
    // tag, and `deployment.applicationId`'s cascade is about to destroy every
    // row that names one.
    //
    // One wait for both image reclamations, so a container that outlasts it
    // costs the budget once per machine rather than once per reclamation. A
    // forced Delete past a service or run job it could not confirm gone only
    // untags: that container is running the image, so waiting for it would
    // only spend the budget (`ImageRelease`).
    const imageRelease =
      presence === 'absent' && cronJobsLeft.length === 0
        ? awaitImageRelease()
        : 'untag-only';
    const unreclaimedPreserved = await reclaimPreservedImages(
      this.db,
      deleteExec,
      ctx,
      [current.applicationId],
      imageRelease,
    );
    // And the patch-repo clone, which nothing reclaimed at all: the only
    // removal in the product is `PatchRepoService.cleanRepos`, a machine-wide
    // glob an operator has to think to run on a Server they have to name, and
    // that file's own docblock records the gap — *"nothing removes a clone when
    // its Application or Compose row goes away"*. So the entity's source tree
    // stayed on the build host under an `appName` no row named any more.
    // Reclaimed here rather than in the `teardown` array above for
    // `reclaimPreservedImages`' reason: the clone is `ensureRepo`'s cache, and
    // wiping it ahead of the refusal would strip the patch editor of an
    // Application the caller is then told still exists.
    // And the `${appName}:latest` its builds left on the build host,
    // which nothing in the product removed at all: before this, `docker image
    // rm` occurred in exactly one file of `src`, `rollbacks.service.ts`, so the
    // only sweep was the machine-wide `docker image prune --all` an operator
    // has to think to run from Settings → Maintenance. It is in this slot rather than the `teardown`
    // array for the sharpest version of `reclaimPreservedImages`' reason: this
    // tag is the image the Swarm service *is running*, so untagging it ahead of
    // a 409 would leave a live Application whose next scheduled task cannot pull
    // its own image. `applications/built-image.ts` carries why the docker arm
    // reclaims nothing, and why the buildkit cache beside it is not touched.
    const unreclaimedBuilt = await reclaimBuiltImages(
      deleteExec,
      [current],
      imageRelease,
    );
    // And the artifacts a *killed* build left on the build host: a
    // railpack buildx builder plus its state volume, and the container
    // `nixpacksStrategy`'s `publishDirectory` branch copies out of. The build
    // strategies reclaim those in the *next* build of the same Application,
    // which bounds the leak at one leftover rather than closing it — an
    // Application killed mid-build that never builds again keeps its leftover
    // until here. It is in this slot rather than the `teardown` array above so
    // that a delete which is then **refused** cannot have taken a live build's
    // builder out from under it, since what the sweeps match is a pattern
    // rather than a name a row records.
    //
    // Alone among the reclamations it answers nothing, and
    // `build-leftovers.ts` carries the argument: neither name is a `path` (so
    // no `UnreclaimedArtifact` `kind`, which is `built-image.ts`' own first reason) nor an
    // image reference (so not `unreclaimedImages` either), and a *sweep* has no
    // artifact identity to report — it exits 0 whether it matched nothing or
    // everything, so a failed exec means "the sweep did not run" rather than
    // "this was left behind". The build host it could not reach is already
    // named by the three reclamations above it.
    await reclaimBuildLeftovers(deleteExec, [current]);
    const unreclaimedRepos = await reclaimApplicationPatchRepos(deleteExec, [
      current,
    ]);
    // And the `files` half of this Application's own tree, on the **run**
    // Server. `{root}/applications/{appName}` spans two machines —
    // the `code` half on the build host, the `files` half written and
    // bind-mounted on `current.serverId` — and the directory's `rm -rf` below
    // names only the first, so on a dedicated-build-Server install
    // the operator's own config files outlived every delete. `mount.applicationId`
    // is `onDelete: 'cascade'`, so the statement below destroys the rows that
    // named them while the files stay.
    //
    // In this slot rather than the `teardown` array for the sharpest form of
    // `reclaimPreservedImages`' reason after the built tag's: nothing in the
    // product re-materializes a file mount — `writeFileMount`'s only callers
    // are `MountsService.create` and `.update` — so removing it ahead of a 409
    // would leave a live Application, one the caller has just been told still
    // exists, with its config files gone and no path back to them short of the
    // operator re-saving every mount by hand.
    const unreclaimedFileMounts = await reclaimFileMounts(deleteExec, [
      current,
    ]);
    // And its Trace store, container and directory, on the run Server
    // (ADR-0028). `trace_store.applicationId` cascades, so the row that says
    // there is one is read before the statement below; in this slot because
    // nothing regenerates a trace — `traces/trace-store.ts` carries the rest.
    const unreclaimedTraceStores = await reclaimTraceStores(
      this.db,
      deleteExec,
      [applicationTraceOwner(current)],
    );
    // And the Application's directory on the build host, last of the trees
    // under it because it is their parent. It ran in the `teardown`
    // array ahead of the refusal until then, on the reasoning that the next
    // clone rewrites it — true of `code`, and not of the rest: on a
    // single-Server install the build host *is* the run Server, so
    // `{applications}/{appName}` also holds the `files` and `traces` the two
    // reclamations above wait for the refusal to protect, and a 409 answered
    // with both already gone. Nothing irreversible runs before the refusal, and
    // the clone gets no carve-out: removing `code` early saves nothing.
    //
    // The build host, **not** `current.serverId`: the engine clones into
    // `{applicationsDirectoryOn(buildHostServerId)}/{appName}/code`, and this is
    // the only thing that removes it, so aimed at the run Server it exited
    // non-zero on a dedicated-build-Server install and the build tree survived
    // every delete. Rooted on that host as well as sent to it, because
    // `uploadDrop` above and `DeploymentEngineService`'s `codeDirectory` are the
    // writers of the same path and a removal converted alone moves the leak
    // rather than closing it (ADR-0018). And it names what it left, because the
    // presence read asks the *run* Server about a Swarm service and can say
    // nothing about a directory on the builder — `common/teardown-steps.ts`.
    const unreclaimedTree = await reclaimApplicationDirectory(
      deleteExec,
      current,
    );
    // And its deployment logs, `{logs}/{appName}` on the build host —
    // where `DeploymentsService.initializeLog` wrote them, on
    // `buildHostServerId`'s answer. `deployment.applicationId` cascades, so the
    // statement below destroys every row that could open one, and before this
    // the directory waited 90 days for ADR-0020's sweep. In this slot rather
    // than the `teardown` array because nothing regenerates a log: removing it
    // ahead of a 409 would erase the build history of an Application the
    // caller is then told still exists.
    //
    // Its schedules' and volume backups' run logs go with it: those rows
    // cascade from this one and wrote under their own `appName`s, on the run
    // Server (`common/run-log-owners.ts`).
    const unreclaimedLogs = await reclaimDeploymentLogs(deleteExec, [
      { appName: current.appName, serverId: buildHostServerId(current) },
      // A Cron service's runs logged on its run Server (ADR-0034).
      ...(current.configKind === 'cron' &&
      current.serverId !== buildHostServerId(current)
        ? [{ appName: current.appName, serverId: current.serverId }]
        : []),
      ...(await runLogOwnersOf(this.db, [
        { serviceId: current.applicationId, serverId: current.serverId },
      ])),
    ]);

    // And, only when asked, the named volumes of its own `volume` mounts on
    // its run Server — `application-volumes.ts` carries which ones, when
    // one is kept instead, and why the removal waits for the task to let go.
    // Last in this slot for two reasons: `mount.applicationId` cascades, so the
    // names have to be read before the statement below, and every step above
    // is time the removed service's task spends stopping, which is what the
    // removal would otherwise wait on. The previews above share these volumes
    // (`preview-deployments.service.ts` spreads the parent's mounts), which is
    // why this cannot run before they are torn down.
    const unreclaimedVolumes = deleteVolumes
      ? await reclaimApplicationVolumes(
          {
            db: this.db,
            remoteExec: deleteExec,
            canName: (owner) => callerMayName(this.permissions, ctx, owner),
          },
          current,
          await applicationVolumeNames(this.db, current.applicationId),
          presence === 'absent',
        )
      : [];
    // And an AI model's weights volume, always: a cache of what can be
    // downloaded again, so `deleteVolumes` does not keep it, and nothing else
    // would ever remove tens of GB with no owner.
    const unreclaimedWeights = aiModel
      ? await reclaimWeightsVolumes(deleteExec, [
          {
            appName: current.appName,
            serverId: current.serverId,
            serviceGone: presence === 'absent',
          },
        ])
      : [];

    // This Application's own artifacts first, its previews' next, then the
    // clone, its file-mounts tree, its Trace store, its directory, its
    // deployment logs, its volumes and its weights volume, which is the order
    // they were attempted in.
    const unreclaimedArtifacts = [
      ...teardownLeaks,
      ...previews.unreclaimedArtifacts,
      ...unreclaimedRepos,
      ...unreclaimedFileMounts,
      ...unreclaimedTraceStores,
      ...unreclaimedTree,
      ...unreclaimedLogs,
      ...unreclaimedVolumes,
      ...unreclaimedWeights,
    ];
    // The preserved snapshot tags first, then the built tag, which is the order
    // they were attempted in. One array because they are one claim — images
    // this delete could not reclaim, per machine — rather than a second field or
    // a fourth `UnreclaimedArtifact` `kind`, which
    // `common/teardown-steps.ts`'s `UnreclaimedImages` argues at length.
    const unreclaimedImages = [...unreclaimedPreserved, ...unreclaimedBuilt];
    // Absent rather than empty, on `cascadeDelete`'s rule for `orphaned`: a
    // bare `unreclaimedImages: []` on every healthy delete would make the field
    // mean "this route can leak images" instead of "these were left behind".
    // `orphanedPreviews` and `unreclaimedArtifacts` follow the same rule, and
    // `orphanedPreviews` is its own field rather than part of `orphaned`: that
    // one is this Application's own workload and is what the 409 is about, and
    // folding a preview into it would say the refusal had been forced when it
    // had not.
    const leftBehind = {
      ...(unreclaimedImages.length > 0 ? { unreclaimedImages } : {}),
      ...(previews.orphaned.length > 0
        ? { orphanedPreviews: previews.orphaned }
        : {}),
      ...(unreclaimedArtifacts.length > 0 ? { unreclaimedArtifacts } : {}),
    };
    // The row goes in the transaction its console Save's config rewrite
    // commits in.
    const removed = await writeKept(
      this.db,
      keep,
      async (db) => {
        const [row] = await db
          .delete(application)
          .where(eq(application.applicationId, current.applicationId))
          .returning();
        return row;
      },
      () => ({ serviceId: current.applicationId, removed: leftBehind }),
    );
    if (presence === 'absent') return { ...removed, ...leftBehind };
    // Forced. Say what was left behind rather than answering a bare 200: the
    // console can surface it, and more importantly the API stops lying.
    return {
      ...removed,
      ...leftBehind,
      orphaned: {
        appName: current.appName,
        serverId: current.serverId,
        reason: presence,
      },
    };
  }

  /**
   * The deploy engine's load: the full relation tree with credentials intact —
   * registry passwords and git-provider secrets, which {@link findOne} strips,
   * are exactly what a build needs. Internal — called by the queue's job
   * processor, so no PermissionCtx.
   *
   * **`mounts` is projected to the five columns `ServiceMount` declares, and
   * that is a fix rather than a tidy-up.** It was `select().from(mount)`
   * — whole rows — against a field declared `ServiceMount[]`, which names
   * `type`, `mountPath`, `volumeName`, `hostPath` and `filePath` and no
   * `content`; `mount.content` is an `encryptedText` column holding the body of
   * a file mount, which is where an operator puts a config file with
   * credentials in it (ADR 0006). So eleven undeclared columns rode along, and
   * an audit found the decrypted body of one of them in `rollback.full_context`,
   * served over HTTP by `RollbacksService.findAllByApplicationId` to every
   * reader of the Application, *with the type still saying it could not be
   * there*.
   *
   * **Nothing was ever going to say so.** TypeScript's excess-property check
   * fires on object *literals*; a value out of a query builder is not fresh and
   * neither is an array of them, so annotating this method
   * `Promise<DeployableApplication>` would catch a *missing* field and not a
   * surplus one — which is why the projection is the fix and
   * `test/applications/deployable-relation-projections.spec.ts` is what holds
   * the seam to it. The first fix — projecting at one consumer,
   * `toSnapshotMount` — could only ever defend that consumer, and it stays
   * where it is for a reason that survives this change: it also runs on the way
   * *out*, over snapshot rows written before either issue.
   *
   * **`ports` stays a bare `select()`**, and the difference is the point of the
   * rule rather than an inconsistency: `Port` is `typeof port.$inferSelect`, so
   * the declared type *is* the row and cannot be narrower than it.
   * `ServiceMount` is the one hand-written interface among these relations —
   * the deploy engine's input shape, not a row shape — and being hand-written
   * is what let it fall behind the table.
   */
  async findDeployable(applicationId: string) {
    const found = await this.db.query.application.findFirst({
      where: eq(application.applicationId, applicationId),
      with: {
        environment: { with: { project: true } },
        customGitSSHKey: true,
        registry: true,
        buildRegistry: true,
        github: true,
        gitlab: true,
        gitea: true,
        bitbucket: true,
      },
    });
    if (!found) throw new NotFoundException('Application not found');

    // Published-port rows feed mechanize's EndpointSpec fallback (Phase 32)
    // and mount rows its ContainerSpec.Mounts (Phase 33); both are queried
    // separately to keep applicationRelations free of schema cycles.
    const ports = await this.db
      .select()
      .from(port)
      .where(eq(port.applicationId, applicationId));
    // The column list is `ServiceMount`'s five fields, named one at a time so a
    // later secret column on `mount` is excluded by never having been named
    // (§2.6 puts any projection on `select().from()`).
    const mounts = await this.db
      .select({
        type: mount.type,
        mountPath: mount.mountPath,
        volumeName: mount.volumeName,
        hostPath: mount.hostPath,
        filePath: mount.filePath,
      })
      .from(mount)
      .where(eq(mount.applicationId, applicationId));
    // `DeployableAiModel`'s three columns, never the upstream secret.
    const aiModel = await this.db
      .select({
        runtime: aiModelFacet.runtime,
        model: aiModelFacet.model,
        imageTag: aiModelFacet.imageTag,
      })
      .from(aiModelFacet)
      .where(eq(aiModelFacet.applicationId, applicationId))
      .then(([row]) => row ?? null);
    return { ...found, ports, mounts, aiModel };
  }

  /**
   * Sets the Application's status. Internal — called by the deployment
   * engine (Phase 21) as builds progress, never from a controller, so it
   * takes no PermissionCtx.
   */
  async updateStatus(
    applicationId: string,
    status: ApplicationStatus,
    options: { keepCronPause?: boolean } = {},
  ) {
    const [updated] = await this.db
      .update(application)
      .set({ applicationStatus: status })
      .where(
        and(
          eq(application.applicationId, applicationId),
          // A build's end does not undo a Cron service's Stop: only
          // Start ends the pause.
          options.keepCronPause
            ? or(
                ne(application.configKind, 'cron'),
                not(eq(application.applicationStatus, 'stopped')),
              )
            : undefined,
        ),
      )
      .returning();
    if (updated) return updated;
    const [kept] = options.keepCronPause
      ? await this.db
          .select()
          .from(application)
          .where(eq(application.applicationId, applicationId))
      : [];
    if (!kept) throw new NotFoundException('Application not found');
    return kept;
  }

  /**
   * {@link findOwned} at the write level.
   *
   * `findOwned` is correctly `'read'` — it is the lookup both readers and
   * writers share, and raising it would raise the reads with it — so the
   * `'update'` claim is made here instead, once, rather than inline in each of
   * the four **definition** writes that need it. `ComposeService` and the
   * database base class carry the same pair for the same reason.
   *
   * **{@link start}, {@link stop} and {@link reload} deliberately keep
   * `findOwned`.** They are not definition writes, and each already runs
   * `checkPermission({ deployment: ['create'] })` — the statement a custom role
   * is granted precisely so it may operate a workload it may not redefine.
   * Requiring `service: ['update']` on them as well would destroy the level
   * the operate permission exists to create: *"see and operate this service, but do not rewrite
   * its definition"* is unsayable if operating it needs the rewrite action.
   * `ComposeService.removeContainers` says the same thing in its own words.
   *
   * The order is the point of the method. Asking for `'update'` *before*
   * `findOwned` runs means a caller holding `read` and not `update` is refused
   * without learning whether the id resolves, so the route is not an
   * enumeration oracle for a service the caller may read about but not change
   * (§2.2). The redundant `'read'` check inside `findOwned` afterwards costs a
   * second pass over the member row and is deliberate: a custom role granted
   * `update` without `read` is refused, because there is no writing a
   * definition you cannot see.
   */
  private async findOwnedForUpdate(ctx: PermissionCtx, applicationId: string) {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'update');
    return this.findOwned(ctx, applicationId);
  }

  /**
   * Row-level service access plus org scoping (environment → project), the
   * write-path counterpart of findOne without the relation tree.
   *
   * Read-level, and stays so: {@link findOwnedForUpdate} is the write-path
   * entry.
   */
  private async findOwned(ctx: PermissionCtx, applicationId: string) {
    await this.permissions.checkServiceAccess(ctx, applicationId, 'read');
    const [found] = await this.db
      .select({
        applicationId: application.applicationId,
        appName: application.appName,
        serverId: application.serverId,
        // The machine a build's artifacts are on, which is not always the one
        // the workload is on: `remove` has to reach both.
        buildServerId: application.buildServerId,
        // Whether a build ever produced a `${appName}:latest` for `remove` to
        // reclaim, or whether the image is the operator's own `dockerImage`
        // that this platform only pulled — `built-image.ts`'s `builtImageTag`.
        sourceType: application.sourceType,
        // What `update` admits the Previews DNS-01 switch by.
        previewWildcard: application.previewWildcard,
        previewDnsChallenge: application.previewDnsChallenge,
        // What a build-type edit keeps in step (`config-kind.ts`).
        configKind: application.configKind,
        // What a cloud Service refuses (`cloud-place.ts`).
        cloudAccountId: application.cloudAccountId,
        // Whether an edit switches previews on, which a cloud Service
        // refuses (`cloud-preview.ts`).
        isPreviewDeploymentsActive: application.isPreviewDeploymentsActive,
        requestedPreviewsAllowed: application.requestedPreviewsAllowed,
        // Where a cloud Service's Stop, Start and Reload reach.
        region: application.region,
        environmentId: application.environmentId,
        configName: application.configName,
        replicas: application.replicas,
        // A Cloud Run Service's copy range, which its Start puts back (S10).
        minCopies: application.minCopies,
        maxCopies: application.maxCopies,
        applicationStatus: application.applicationStatus,
        // A cloud Delete under way or incomplete, and the name its
        // audit entry gives.
        cloudDelete: application.cloudDelete,
        name: application.name,
        // A static site's own S3 bucket, which its cloud Delete empties.
        cloudBucketName: application.cloudBucketName,
        // What a typed env refuses: a linked name has one source.
        configLinks: application.configLinks,
        // What a Start or Restart admits against the run Server.
        gpus: application.gpus,
        // What a port edit moves its Domains from (ADR-0068).
        port: application.port,
      })
      .from(application)
      .innerJoin(
        environment,
        eq(application.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(application.applicationId, applicationId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Application not found');
    return found;
  }

  /** The environment (with its projectId) inside the caller's organization. */
  private async findParentEnvironment(
    ctx: PermissionCtx,
    environmentId: string,
  ) {
    const [found] = await this.db
      .select({
        environmentId: environment.environmentId,
        projectId: environment.projectId,
        deployTarget: environment.deployTarget,
      })
      .from(environment)
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(environment.environmentId, environmentId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Environment not found');
    return found;
  }
}
