import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Optional,
  NotFoundException,
} from '@nestjs/common';
import { stackRootId } from './stack-root';
import { and, eq } from 'drizzle-orm';
import { quote } from 'shell-quote';
// `import type` only, exactly as `databases/common/database-ops.ts` takes them:
// one three-valued presence union and one shape for what a forced delete admits
// it left behind, shared across the three siblings so they cannot drift, with
// no runtime coupling to the applications module. The compose probe that
// produces the union is `compose.utils.ts`'s `readComposeWorkloadPresence`,
// which wraps `readWorkloadPresence` once per compose type (H-87).
import type {
  OrphanedWorkload,
  WorkloadPresence,
} from '../common/workload-presence';
import {
  COMPOSE_CREDENTIAL_REFS,
  resolveCredentialRefs,
} from '../common/credential-refs';
import type {
  ComposeCredentialRef,
  CredentialRefResolvers,
} from '../common/credential-refs';
import { checkServerAccess } from '../common/owned-server';
import { refuseWhileInMaintenance } from '../servers/server-maintenance';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { workloadKeptRefusal } from '../common/workload-kept-refusal';
import { runLogOwnersOf } from '../common/run-log-owners';
import {
  awaitImageRelease,
  reclaimDeploymentLogs,
} from '../common/teardown-steps';
import type {
  UnreclaimedArtifact,
  UnreclaimedImages,
} from '../common/teardown-steps';
import { withoutSecrets } from '../common/service-read-relations';
import { cleanAppName, generateAppName } from '../db/columns';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { compose, environment, project, volumeBackup } from '../db/schema';
import {
  claimServiceConfigName,
  mintServiceConfigName,
} from '../environments/config-name';
import { refuseUnchosenInCloud } from '../environments/deploy-target';
import { StackVmPower } from '../stack-vm/stack-vm-power';
import type { StackVmStatus } from '../stack-vm/stack-vm-power';
import type { ApplicationStatus, Compose } from '../db/schema';
import {
  busyVolumeNameFrom,
  isVolumeLockBusyError,
  volumeLockBusyMessage,
} from '../deployment-engine/volume-lock';
import { DomainsService } from '../domains/domains.service';
import { BitbucketService } from '../git-providers/strategies/bitbucket/bitbucket.service';
import { GiteaService } from '../git-providers/strategies/gitea/gitea.service';
import { GithubService } from '../git-providers/strategies/github/github.service';
import { GitlabService } from '../git-providers/strategies/gitlab/gitlab.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { IncidentsService } from '../service-health/incidents.service';
import {
  ConsoleSaves,
  KEEP_NOTHING,
  writeKept,
} from '../project-config/console-saves';
import type { KeepConfig } from '../project-config/console-saves';
import { PermissionService } from '../rbac/permission.service';
import { ReachabilityMemo } from '../remote/reachability-memo';
import { RemoteExecService } from '../remote/remote-exec.service';
import { runTargetOn } from '../remote/run-target';
import type { RunTarget } from '../remote/run-target';
import { nestedServer } from '../servers/nested-server';
import { SshKeysService } from '../ssh-keys/ssh-keys.service';
import { withoutTraceCredential } from '../traces/compose-trace-wiring';
import {
  composeTraceOwner,
  reclaimTraceStores,
  traceStoreRowOf,
} from '../traces/trace-store';
import { reclaimComposeBuiltImages } from './compose-images';
import { reclaimComposeDirectory } from './compose-directory';
import { reclaimComposeNetwork } from './compose-network';
import { ComposeLabelRefusal } from './compose-labels';
import type { ComposeHostClaim } from './compose-labels';
import {
  awaitComposeWorkloadAbsent,
  COMPOSE_SETTLE_CLOCK,
  composeAiNetworkRefusal,
  composeFileParseRefusal,
  composeServiceUsesMapFormLabels,
  composeStartCommand,
  composeLifecycleCommand,
  composeTeardownCommand,
  getComposeFilePath,
  listComposePublishedPorts,
  listComposeVolumes,
  listComposeServices,
  mapFormLabelsRefusal,
  readComposeHostClaims,
  composeCodeDirectory,
  composeProjectDirectory,
  readComposeDirectoryPresence,
  readComposeWorkloadPresence,
  removeComposeContainersCommand,
  writeDomainsToCompose,
} from './compose.utils';
import type { ComposeRefusalEcho, SettleClock } from './compose.utils';
import { sourceTypeOnCreate } from './compose-source-type';
import { publishStackVmPorts } from './stack-vm-ports';
import { ComposeStackVms } from './compose-stack-vms';
import type { ComposeCloudPlace } from './compose-stack-vms';
import { StackVmDeletes } from './stack-vm-deletes';
import type {
  CreateComposeDto,
  SaveComposeEnvironmentDto,
  SaveComposeStackVmDto,
  UpdateComposeDto,
} from './dto/compose.dto';

/**
 * `common/credential-refs.ts`' {@link COMPOSE_CREDENTIAL_REFS} and its
 * `ComposeCredentialRef`, re-exported under the names this module published
 * them under.
 *
 * The list moved because the rule it belongs to was stated in three modules
 * with no single home — this file's copy and
 * `ApplicationsService`' were two statements of one rule, written twice
 * because the only in-set alternative was `compose/` importing
 * `applications/`, which inverts the dependency direction the tree keeps. See
 * `common/credential-refs.ts` for the argument and for why the two lists are
 * two exports rather than one.
 */
export { COMPOSE_CREDENTIAL_REFS };
export type { ComposeCredentialRef };

export {
  STACK_VM_RUNS_NO_SWARM,
  STACK_VM_TAKES_NO_SERVER,
} from './compose-stack-vms';
export type { ComposeCloudPlace } from './compose-stack-vms';

@Injectable()
export class ComposeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
    private readonly domains: DomainsService,
    // The settle poll's clock (H-99), a provider rather than a default
    // parameter so a suite can exhaust a fifteen-second window without spending
    // fifteen seconds — see `SettleClock`. `ComposeModule` binds it to the
    // system clock and nothing in the product binds anything else.
    @Inject(COMPOSE_SETTLE_CLOCK) private readonly settleClock: SettleClock,
    // The five owning services, injected only so that
    // {@link credentialRefResolvers} can delegate to the org-scoped lookup
    // each one already has. Every one of them is a
    // `findOne`
    // filtering the id and `organizationId` **together**, raising its own
    // `NotFoundException` whichever predicate misses — which is why this is
    // five injections rather than five more `id = ? AND organization_id = ?`
    // selects in this file: no sixth copy of an ownership lookup (§1.4), and
    // no new refusal wording to keep in sync with the
    // module that owns the row.
    private readonly sshKeys: SshKeysService,
    private readonly github: GithubService,
    private readonly gitlab: GitlabService,
    private readonly gitea: GiteaService,
    private readonly bitbucket: BitbucketService,
    // The Stop hook: Stop and Remove containers close the stack's open
    // Incidents with `service-stopped`, announced once each.
    private readonly incidents: IncidentsService,
    // Refuses a stack on the platform host on the Hosted instance.
    private readonly instanceMode: InstanceMode,
    // Console Saves on a Cloudgate-kept config: a stack's create and
    // Delete add and drop its `managed: console` line. Optional only so a
    // spec that builds this service by hand still compiles.
    @Optional() private readonly consoleSaves?: ConsoleSaves,
    // A stack on a Stack VM's Delete (#1367): a destroy-only Cloud run in
    // its Cloud account. Optional only so a hand-built spec still compiles.
    @Optional() stackVmDeletes?: StackVmDeletes,
    // A Stack VM stack's Stop and Start of the VM itself, and its running
    // state (ADR-0070). Optional only so a spec that builds this service by
    // hand still compiles; a Stack VM stack without it is refused.
    @Optional() stackVmPower?: StackVmPower,
  ) {
    this.stackVms = new ComposeStackVms(
      db,
      instanceMode,
      stackVmDeletes,
      stackVmPower,
    );
  }

  /** The Stack VM half of this service (ADR-0070): `compose-stack-vms.ts`. */
  private readonly stackVms: ComposeStackVms;

  /**
   * Resolves the target environment inside the caller's organization,
   * requires service:create on its project, inserts in a transaction with the
   * unique-appName check, then grants the creator row-level access.
   *
   * An unknown or unowned `serverId` is refused 404 before the insert; nullish
   * is the platform host.
   *
   * **Deliberately no {@link resolveCredentialRefs} call.** The credential fix asked the same
   * question of this path and the answer is that `createComposeSchema` carries
   * no credential-bearing parent id at all — name, appName, description,
   * environmentId, composeType, serverId, composeFile, sourceType, and the five of
   * {@link COMPOSE_CREDENTIAL_REFS} are update-only ("everything else is
   * configured through update"). Adding one of them here would need the same
   * resolution; the absence is the reason there is none, not an omission.
   */
  async create(
    ctx: PermissionCtx,
    data: CreateComposeDto,
    /**
     * A plan's create of the stack a `compose` entry names (ADR-0069):
     * its Config name is the entry's key, claimed rather than minted, and
     * the write is the plan's step, not a console Save. `cloud` is its
     * place when the Environment's Deploy target is a Cloud account: it
     * runs on its own Stack VM there (ADR-0070), under the id its plan
     * was read with, and never on a Server.
     */
    initial?: { configName: string; cloud?: ComposeCloudPlace },
  ) {
    if (initial || !this.consoleSaves) {
      return this.insertCompose(ctx, data, KEEP_NOTHING, initial);
    }
    return this.consoleSaves.create(
      ctx,
      { serviceType: 'compose', environmentId: data.environmentId },
      (keep) => this.insertCompose(ctx, data, keep),
    );
  }

  private async insertCompose(
    ctx: PermissionCtx,
    data: CreateComposeDto,
    keep: KeepConfig,
    initial?: { configName: string; cloud?: ComposeCloudPlace },
  ) {
    const parent = await this.findParentEnvironment(ctx, data.environmentId);
    await this.permissions.checkServiceAccess(ctx, parent.projectId, 'create');
    const cloud = initial?.cloud;
    // In a Cloud Environment every new stack runs on its own Stack VM: a
    // plan's under the id its plan was read with (ADR-0070), a console
    // create's made by the Environment's next plan (#1372). No Server is
    // asked for, and none may be named.
    const onStackVm = cloud
      ? await this.stackVms.insertPlanned(data, initial.configName, cloud)
      : parent.deployTarget.kind === 'cloud'
        ? await this.stackVms.insertConsole(data, keep, parent.deployTarget)
        : null;
    if (onStackVm) {
      await this.permissions.addNewService(ctx, onStackVm.composeId);
      return onStackVm;
    }
    // After the permission gate, never before — see
    // databases/common/database-service.ts's createDatabase for why.
    // {@link createByTemplate} deliberately gets no check: its only caller
    // already runs `servers.findOne` first (ai.service.ts).
    //
    // No Server is the platform host: refused on the Hosted instance
    // (ADR-0053 seam 3); ADR-0008's Self-hosted branch is unchanged.
    // Left out in a cloud Environment, it is asked for rather than assumed.
    if (!data.serverId) this.instanceMode.refusePlatformHost('services');
    refuseUnchosenInCloud(data.serverId, parent.deployTarget);
    await checkServerAccess(this.db, ctx, data.serverId);
    // H-83, and after `checkServerAccess` for the reason
    // `assertHostsUnclaimed` states as a precondition: it answers about other
    // organizations' rows, so the caller has to have been authorized for this
    // Server first or the refusal is an oracle.
    await this.assertComposeContentClaimable(
      {
        organizationId: ctx.session.activeOrganizationId,
        serverId: data.serverId ?? null,
      },
      data.composeFile ?? '',
      // `'verbatim'`: this refusal answers an HTTP request from a caller
      // already admitted to this stack, which is the audience
      // `compose.composeFile` already has.
      'verbatim',
    );

    const appName = data.appName
      ? cleanAppName(data.appName)
      : generateAppName('compose');

    const created = await this.db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ composeId: compose.composeId })
        .from(compose)
        .where(eq(compose.appName, appName))
        .limit(1);
      if (taken) {
        throw new ConflictException(
          "Compose with this 'appName' already exists",
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
            'compose',
            data.name,
          );
      const [row] = await tx
        .insert(compose)
        .values({
          ...data,
          composeFile: data.composeFile ?? '',
          // #1338: a pasted file with no `sourceType` is `raw`, not the
          // column's `github`; `undefined` still leaves the default.
          sourceType: sourceTypeOnCreate(data),
          appName,
          configName,
        })
        .returning();
      await keep(tx, { serviceId: row.composeId });
      return row;
    });

    await this.permissions.addNewService(ctx, created.composeId);
    return created;
  }

  /**
   * The full-row insert the template deploy path uses (raw source, pre-built
   * env, isolation flag).
   *
   * **It authorizes nothing, and "guarded by the caller" is no longer the whole
   * of the contract.** It used to say only that, and what a reader
   * takes from that sentence is that the guarding is optional detail. It is the
   * only thing standing between this method and a cross-organization write: there is no `ctx` here,
   * so {@link findEnvironmentOrganization} resolves `data.environmentId`
   * **unscoped** — any environment on the instance — and a caller that had not
   * already resolved the same id inside the requester's organization would
   * insert a Compose into somebody else's Environment, and would have this
   * method's own H-83 check run against that organization's claims rather than
   * the requester's. Its one caller, `AiService.deploy`, resolves it first,
   * with `findParentEnvironment(ctx, input.environmentId)` followed by
   * `checkServiceAccess(ctx, parent.projectId, 'create')`. The other caller,
   * the `template.toml` deploy, was removed in #1364; a Template's compose
   * part is made by `PlanApplier` through {@link create}, which takes a
   * `ctx`. No controller reaches this method.
   *
   * **The precondition is checked, not merely written down**, which is the
   * decision taken here — a docblock is what a third caller reads *after*
   * deciding it does not need to. `test/compose/create-by-template-callers.spec.ts`
   * holds the caller set closed and asserts, per caller, that the method
   * containing the call resolves the very `environmentId` expression it passes
   * through an org-scoped lookup first. A third caller therefore cannot arrive
   * without going red, and cannot go green by editing a list without also
   * carrying the guard. Taking a `PermissionCtx` here and doing the scoping
   * in-sink is the fix that would need no list at all and was **not** rejected
   * on merit — it is a signature change across `ai.service.ts` and its
   * suites, i.e. outside the file set this was
   * implemented in; the spec is what holds the property until then, and states
   * that.
   *
   * `composePath` is off the parameter. It is the one column this
   * signature would let a caller set without the DTO rule that keeps it inside
   * the stack's code directory ever running — `dto/compose.dto.ts` holds that
   * rule, and its one caller (`AiService`) passes
   * `sourceType: 'raw'` and take the column's default anyway, so nothing is
   * given up by making the bypass unavailable to a future one.
   */
  async createByTemplate(
    data: Omit<typeof compose.$inferInsert, 'composePath' | 'configName'> & {
      appName: string;
    },
  ) {
    if (!this.consoleSaves) return this.insertByTemplate(data, KEEP_NOTHING);
    // No request context here, and none is needed: a stack is listed
    // `managed: console`, which records no plan.
    return this.consoleSaves.create(
      null,
      { serviceType: 'compose', environmentId: data.environmentId },
      (keep) => this.insertByTemplate(data, keep),
    );
  }

  private async insertByTemplate(
    data: Omit<typeof compose.$inferInsert, 'composePath' | 'configName'> & {
      appName: string;
    },
    keep: KeepConfig,
  ) {
    // No Server is the platform host: refused on the Hosted instance (ADR-0053
    // seam 4), first and before anything is read. AI deploy reaches this
    // insert without `insertCompose`'s `checkServerAccess`, so seam 3 never
    // sees it; here is the sink, the place H-83's guard below sits for the
    // same reason. Self-hosted is unchanged.
    if (!data.serverId) this.instanceMode.refusePlatformHost('services');
    const appName = cleanAppName(data.appName);
    // H-83: the guard for `POST /ai/deploy` (and, until #1364 removed it,
    // `POST /templates/deploy`), placed here rather than in each caller on
    // purpose. A caller builds a compose file and hands it to this method, whose contract already leans on
    // the caller for authorization — which is exactly the arrangement H-20
    // named as the shape to avoid: two writers reaching one sink, each carrying
    // its own copy of the rule, and a third one arriving later with none. The
    // organization comes off the target environment rather than a `ctx` because
    // this signature has no `ctx` to take it from, and resolving it here means a
    // future caller cannot supply the wrong one.
    const parent = await this.findEnvironmentOrganization(data.environmentId);
    // Left out in a cloud Environment, the Server is asked for rather than
    // assumed: this sink is its caller's for that too.
    refuseUnchosenInCloud(data.serverId, parent.deployTarget);
    await this.assertComposeContentClaimable(
      {
        organizationId: parent.organizationId,
        serverId: data.serverId ?? null,
      },
      data.composeFile ?? '',
      // `'verbatim'`: this refusal answers an HTTP request from a caller
      // already admitted to this stack, which is the audience
      // `compose.composeFile` already has.
      'verbatim',
    );
    return await this.db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ composeId: compose.composeId })
        .from(compose)
        .where(eq(compose.appName, appName))
        .limit(1);
      if (taken) {
        throw new ConflictException(
          "Service with this 'AppName' already exists",
        );
      }
      const configName = await mintServiceConfigName(
        tx,
        data.environmentId,
        'compose',
        data.name,
      );
      const [row] = await tx
        .insert(compose)
        .values({ ...data, appName, configName })
        .returning();
      await keep(tx, { serviceId: row.composeId });
      return row;
    });
  }

  /**
   * Row-level service access, then the relation tree. Org-scoped through
   * environment → project.
   *
   * **No relation on this read carries a secret**, and what that means is
   * declared once in `common/service-read-relations.ts` rather than here —
   * `ApplicationsService.findOne` carries the long form of why. This
   * site had three of that finding's four holes: the whole `ssh_key` row,
   * `github.webhookSecret`, `gitlab.secret`, and the `server` row spread whole.
   */
  async findOne(ctx: PermissionCtx, composeId: string) {
    await this.permissions.checkServiceAccess(ctx, composeId, 'read');

    const found = await this.db.query.compose.findFirst({
      where: eq(compose.composeId, composeId),
      with: {
        environment: { with: { project: true } },
        customGitSSHKey: withoutSecrets.sshKey,
        github: withoutSecrets.github,
        gitlab: withoutSecrets.gitlab,
        gitea: withoutSecrets.gitea,
        bitbucket: withoutSecrets.bitbucket,
        server: true,
      },
    });
    if (
      !found ||
      found.environment.project.organizationId !==
        ctx.session.activeOrganizationId
    ) {
      throw new NotFoundException('Compose not found');
    }
    return {
      ...found,
      server: nestedServer(found.server),
      // Its Stack VM as its page shows it, on a stack in a Cloud account
      // (ADR-0070, #1372); `null` on a Server and the platform host.
      stackVmFacts: await this.stackVms.factsOf(found),
    };
  }

  /**
   * The stack page's Stack VM setting (#1372): a console-managed stack's
   * size, and the data disk grown to, which never shrinks below what it
   * has. Written as the console's setting only; the Environment's next
   * plan shows the change with its prices and makes it once applied, as a
   * described stack's size change does (#1368). A described stack's size
   * is its config entry's, so its plans read this size only while the
   * stack is console-managed.
   */
  async saveStackVm(
    ctx: PermissionCtx,
    composeId: string,
    data: SaveComposeStackVmDto,
  ) {
    const current = await this.findOwnedForUpdate(ctx, composeId);
    return this.stackVms.save(current.composeId, data);
  }

  /**
   * Updates a Compose, access-scoped through findOwnedForUpdate.
   *
   * **Every parent id in the body is resolved inside the caller's organization
   * before anything is written.** `findOwnedForUpdate` scopes the
   * *Compose*; it says nothing about the rows the body attaches to it, and
   * `.set(data)` used to spread all five of
   * {@link COMPOSE_CREDENTIAL_REFS} straight onto the row. See that constant
   * for what a build then did with them.
   *
   * **H-83 is checked against the file this update *leaves behind*, not against
   * the field the request carried** — `data.composeFile ?? row.composeFile`.
   * `updateComposeSchema` is `.partial()`, so a PATCH that omits `composeFile`
   * writes every other column while the stored file goes unexamined, and a file
   * stored before this rule existed would have been resurrected by the next
   * unrelated edit and re-emitted by the next deploy. That is X05's H-14 shape
   * and the Domain path's no-backfill residual one schema over, and the fix is the same
   * one: make the rule a statement about the row's resulting state rather than
   * about the request body. The cost is that an unrelated PATCH to a stack
   * poisoned before the rule shipped is refused until its file is fixed, which
   * is the correct direction — the alternative is a route that quietly keeps a
   * hijack live.
   *
   * `saveEnvironment` deliberately gets no check beside this one, and the reason
   * is not that env is harmless: a compose file's env is interpolated into
   * labels on the build server. It is that a rule the guard admitted cannot be
   * *changed* by env — every host literal containing `${` is already refused as
   * uninterpolatable, and a `${…}` anywhere else in a rule fails to parse — so
   * there is no env value that turns an admitted rule into a different claim.
   */
  async update(ctx: PermissionCtx, composeId: string, data: UpdateComposeDto) {
    if (!this.consoleSaves) {
      return this.updateRow(ctx, composeId, data, KEEP_NOTHING);
    }
    // A stack's source, compose file path and type are a `compose`
    // entry's (ADR-0069): a Save of them is kept in step with a
    // Cloudgate-kept config, and refused where a repository-kept one
    // describes the stack.
    return this.consoleSaves.update(
      ctx,
      { serviceType: 'compose', serviceId: composeId },
      (keep) => this.updateRow(ctx, composeId, data, keep),
    );
  }

  private async updateRow(
    ctx: PermissionCtx,
    composeId: string,
    data: UpdateComposeDto,
    keep: KeepConfig,
  ) {
    const current = await this.findOwnedForUpdate(ctx, composeId);
    const row = await this.findRow(current.composeId);
    // First of the three guards on purpose. This one is a statement
    // about the ids the *request* carries, and settling entitlement to
    // everything the PATCH attaches before the two content rules keeps a
    // cross-organization refusal from depending on whether this stack's own
    // file happens to be poisoned — the same direction argued for putting
    // the own-consistency check second.
    const authorized = await resolveCredentialRefs(
      COMPOSE_CREDENTIAL_REFS,
      this.credentialRefResolvers(ctx),
      data,
    );
    await this.assertComposeContentClaimable(
      {
        organizationId: ctx.session.activeOrganizationId,
        serverId: row.serverId,
      },
      data.composeFile ?? row.composeFile,
      // `'verbatim'`: this refusal answers an HTTP request from a caller
      // already admitted to this stack, which is the audience
      // `compose.composeFile` already has.
      'verbatim',
    );
    // Last on purpose: the two guards above answer about *another*
    // organization's hostnames and *another* organization's credentials, so a
    // PATCH that is a hijack attempt is refused the same way whether or not
    // this stack's own rows stay routable.
    await this.assertComposeContentRoutable(
      current.composeId,
      data.composeType ?? row.composeType,
      data.composeFile ?? row.composeFile,
    );
    // The row goes in the transaction its console Save's config rewrite
    // commits in.
    return writeKept(
      this.db,
      keep,
      async (db) => {
        const [updated] = await db
          .update(compose)
          // The ids that land are the ones the lookups returned, not the ones
          // the request carried ("the row is written from the id that
          // was authorized"). Equal by construction today — each lookup
          // filters on the very id it was given — so this is belt-and-braces
          // behind the refusal rather than a second rule. It is here because
          // it is what stops `.set(data)` being the thing that decides.
          .set({ ...data, ...authorized })
          .where(eq(compose.composeId, current.composeId))
          .returning();
        return updated;
      },
      (updated) => (updated ? { serviceId: updated.composeId } : null),
    );
  }

  /**
   * One org-scoped lookup per id in {@link COMPOSE_CREDENTIAL_REFS}, each
   * answering with the id it authorized — the only half of the rule that is
   * this module's own (since extracted to `common/credential-refs.ts`).
   *
   * The loop over these lives in {@link resolveCredentialRefs}, which also
   * carries the argument for why it is sequential, why it takes no
   * `PermissionCtx` of its own, and why a refusal raised here is passed
   * through untouched. What is left here is *which service owns which row*,
   * which is the one thing `common/` cannot know — and it is why the
   * extraction did not move the whole method: this bundle is five injections
   * of this module's own, and `ApplicationsService`' is six.
   *
   * **Delegating to each provider's own `findOne` rather than writing a sixth
   * ownership lookup** (§1.4, the same decision one id over).
   * Every one of these filters the id and `organizationId` **together** and
   * raises its own `NotFoundException` whichever predicate misses, so a
   * foreign id is refused byte-identically to one that exists nowhere with no
   * new wording for this file to keep in sync.
   *
   * `ctx` is closed over rather than threaded through
   * {@link resolveCredentialRefs}: that is what lets a caller with no session
   * — a scheduled run — supply a bundle of its own. See
   * `common/credential-refs.ts`.
   */
  private credentialRefResolvers(
    ctx: PermissionCtx,
  ): CredentialRefResolvers<ComposeCredentialRef> {
    // `CredentialRefResolvers<ComposeCredentialRef>` on purpose: this is the
    // type that makes the list load-bearing, because a name added there with
    // no lookup here fails to compile.
    return {
      githubId: async (id) => (await this.github.findOne(ctx, id)).githubId,
      gitlabId: async (id) => (await this.gitlab.findOne(ctx, id)).gitlabId,
      giteaId: async (id) => (await this.gitea.findOne(ctx, id)).giteaId,
      bitbucketId: async (id) =>
        (await this.bitbucket.findOne(ctx, id)).bitbucketId,
      // `findOne` rather than `findOneWithPrivateKey`: resolving an id has no
      // business decrypting a private key, which is the reason a Server's
      // `sshKeyId` is resolved through the sanitized method too.
      customGitSSHKeyId: async (id) =>
        (await this.sshKeys.findOne(ctx, id)).sshKeyId,
    };
  }

  /**
   * Refuse a `PATCH /compose/:id` that would leave one of this stack's own
   * Domain rows aimed at a service whose labels are a **map**.
   *
   * This is the seam that *creates* the state the map-form refusal made a refusal everywhere
   * else, which recorded it as its own follow-up rather than fixing it.
   * {@link assertComposeContentClaimable} reads the file and has no idea which
   * of its services carry Domain rows, so a PATCH rewriting a routed service's
   * `labels:` from a list into a map was taken, and the Domain row went on
   * pointing at a service Cloudgate can no longer add routing to. The outcome
   * was never *silent* after the map-form refusal — the Converted tab and the next deploy both
   * refuse, naming the service, and the next edit of that Domain refuses — so
   * what this closes is that the operator learned about it later than they
   * need to, from a different screen than the one they broke it on.
   *
   * **One rule, reused rather than reimplemented**, on
   * {@link assertComposeContentClaimable}'s own terms: the predicate is
   * `composeServiceUsesMapFormLabels` and the sentence is
   * `mapFormLabelsRefusal`, both already exported by `compose.utils.ts` for
   * `DomainsService.assertComposeServiceRoutable` and
   * `addDomainsToComposeSpec`. A third seam that spelled the sentence itself
   * would be the fourth wording of one rule.
   *
   * **Whole-parent, and that is the asymmetry with the map-form pre-flight.**
   * `DomainsService.assertComposeServiceRoutable` is per-row, and its docblock
   * argues for that: a domain write names one Domain, and the file it is held
   * against is not the thing changing. Here the file *is* what changes, and one
   * file is shared by every Domain row of the stack — there is no row in the
   * URL to check, and a check that looked at one would watch the same PATCH
   * poison its siblings. `DomainsService.assertParentRowsRoutable` is the
   * existing precedent for re-reading every Domain of a parent, and the reason
   * is the same in both places: the guard reads exactly the set the injector
   * will read.
   *
   * **The row's resulting state, not the request body** — `data.composeFile ??
   * row.composeFile` and `data.composeType ?? row.composeType`, for the reason
   * {@link update} states for H-83. `updateComposeSchema` is `.partial()`, so a
   * PATCH can carry a new file without a `composeType`, or flip `composeType`
   * without a file and change whether the question is asked at all — a stack
   * takes no routing labels (H-87's shape: a safety property keyed
   * off a column the same request may rewrite).
   *
   * **Not gated on `sourceType`**, unlike the domains pre-flight, which returns
   * early for anything but `raw`. That gate is right there and wrong here: it
   * exists because a domain write cannot *see* a git stack's file, whereas this
   * one is handed the `composeFile` column as the request leaves it — and the
   * same `.partial()` PATCH can set `sourceType: 'raw'`, so a check that read
   * the column only for a stack that is already raw would answer about a column
   * this very request can make live.
   *
   * **Every remediation still gets through**, which is the property to preserve
   * when editing this — `assertParentRowsRoutable`'s rule, applied here. The
   * PATCH that rewrites the map back into a list passes, because what is
   * checked is the file the request leaves behind; and `DELETE /domains/:id`
   * was never checked at all, so deleting the row is still the other way out.
   *
   * Two residuals, stated so neither is rediscovered as a bug:
   *
   * - A stack already in this state — the no-backfill case — refuses *every*
   *   PATCH, including one that touches only `name`, until its labels are fixed
   *   or its Domain is deleted. That is the same trade {@link update} already
   *   took for H-83 and the correct direction: the alternative is a route that
   *   quietly keeps writing to a stack whose next deploy cannot succeed.
   * - `DomainsService.findComposeDomains` applies the stored-row check to
   *   every row it returns, so a stack carrying a Domain poisoned *that* way
   *   refuses this PATCH too, with that check's message rather than this one. A lean
   *   private `select serviceName from domain` here would have avoided it and
   *   was rejected: it would be a second reader of the injection set, free to
   *   drift from the one {@link getConverted} and the deployment engine feed to
   *   the injector, which is the whole reason this guard reads that set. The
   *   refusal is also not a loss — such a stack cannot deploy or render its
   *   Converted tab either, and that check's sentence names the Domain and says to
   *   correct or delete it.
   */
  private async assertComposeContentRoutable(
    composeId: string,
    composeType: Compose['composeType'],
    content: string,
  ): Promise<void> {
    const domains = await this.domains.findComposeDomains(composeId);
    for (const { host, serviceName } of domains) {
      // Fails open on an empty file, YAML that does not parse and a service the
      // incoming content does not declare — deliberately, and see the
      // predicate: each is already some other guard's refusal
      // (`getConverted`'s empty-file 400, its unknown-service 400), and none of
      // them is a refusal `PATCH /compose/:id` has ever made. A seam that grew
      // new refusals while it was here for one would be a second rule riding
      // inside this one.
      if (!composeServiceUsesMapFormLabels(composeType, content, serviceName)) {
        continue;
      }
      // A 400 rather than a 409, for the reading the sibling seams give: the
      // compose file is the caller's own configuration and rewriting it is the
      // caller's to do (§2.5).
      throw new BadRequestException(
        mapFormLabelsRefusal(composeType, host, serviceName),
      );
    }
  }

  /**
   * env lands in the encrypted column; the update is access-scoped through
   * findOwnedForUpdate.
   */
  async saveEnvironment(
    ctx: PermissionCtx,
    composeId: string,
    data: SaveComposeEnvironmentDto,
  ) {
    const current = await this.findOwnedForUpdate(ctx, composeId);
    const [updated] = await this.db
      .update(compose)
      .set(data)
      .where(eq(compose.composeId, current.composeId))
      .returning();
    return updated;
  }

  /**
   * Tears the runtime down, confirms the workload is gone, then deletes the
   * row.
   *
   * This used to say "remove the row, then tear the runtime down best-effort —
   * a dead daemon must not resurrect the database row", and the code did that.
   * The reason that is now wrong is not tidiness. The row is the only handle
   * the product has on the workload, and per ADR-0008 a container that resolves
   * to no Service is *unmanaged*, reached through machine-level `docker:read`
   * "where there is no Service to ask about" — so, with "managed" deciding access, dropping
   * the row while the stack still runs moves it from private-to-one-
   * organization to readable and actable by every organization on the host.
   * A dead daemon no longer has to resurrect anything, because the row is never
   * dropped until the workload is confirmed gone, and `force` covers the daemon
   * that is never coming back. Matches `applications.service.ts` and
   * `databases/common/database-service.ts`; `deleteVolumes` keeps its meaning.
   *
   * The presence read is `readComposeWorkloadPresence` rather than the siblings'
   * `docker service inspect`, because a compose stack has no single swarm
   * service to inspect: the two compose types are two different questions, and
   * only `compose.utils.ts` knows how to ask them. It asks **both**, and
   * `teardownCommand` runs both, because keying either half off the row's
   * `composeType` made this route's safety property depend on a column
   * `updateComposeSchema` lets a caller `PATCH` (H-87) — see those two
   * functions.
   *
   * **It reclaims the images this stack's own build left**, in
   * ADR-0016's slot — after the presence refusal, before the row — and answers
   * with the ones it could not in `unreclaimedImages`, the field the three
   * Application deletes carry. `compose/compose-images.ts`
   * owns which tags those are and why two whole stack shapes name none; this
   * method owns the two orderings that make it work.
   *
   * **The file is read *before* the project directory goes, and the removal
   * issued *after* the refusal.** The compose file is what names the images — a
   * stack's tags are `${appName}-${service}`, one per `build:` service — and
   * for a git-sourced stack the only copy Cloudgate can read is the one on the
   * Server, inside that directory. The teardown program used to end by
   * `rm -rf`ing it, so the read had to precede the teardown; the directory now
   * goes last, after the refusal, so the read sits beside the removal it feeds.
   * The removal must not move earlier: `docker image rm` ahead of a 409 would
   * untag the image a still-running project is using while the caller is told
   * the stack still exists, which is `built-image.ts`' own sharpened form of ADR-0016's
   * slot.
   *
   * The read is best-effort for the reason `composeBuiltImageTags` fails open:
   * a `cat` on a Server that is gone, or a stack that never deployed, must not
   * turn a delete into a 500 — *"a dead server must not make deletion
   * impossible"*. A stack whose file could not be read reclaims nothing
   * and reports nothing, because `unreclaimedImages` holds image references and
   * there is no reference to put in it; the delete's own `?force=true` answer
   * is what already tells the operator the machine was unreachable.
   */
  async remove(
    ctx: PermissionCtx,
    composeId: string,
    deleteVolumes = false,
    force = false,
    /**
     * A stack on a Stack VM's Delete (#1367): whether its data disk goes
     * with no final snapshot. A Plan's destroy says so per stack
     * (`deleteDataOf`); absent, the console's `deleteVolumes` does.
     */
    stackVm?: { readonly deleteData: boolean },
  ): Promise<
    Compose & {
      orphaned?: OrphanedWorkload;
      unreclaimedImages?: UnreclaimedImages[];
      unreclaimedArtifacts?: UnreclaimedArtifact[];
      /** A Stack VM stack's Delete: the Cloud run that removes it (#1367). */
      stackVmDelete?: { readonly deploymentId: string };
    }
  > {
    const remove = (keep: KeepConfig) =>
      this.removeOnStackVm(
        ctx,
        composeId,
        stackVm?.deleteData ?? deleteVolumes,
        keep,
      ).then(
        (onStackVm) =>
          onStackVm ??
          this.removeRow(ctx, composeId, deleteVolumes, force, keep),
      );
    if (!this.consoleSaves) return remove(KEEP_NOTHING);
    return this.consoleSaves.remove(
      ctx,
      { serviceType: 'compose', serviceId: composeId },
      remove,
    );
  }

  /**
   * A stack on its own Stack VM's Delete (ADR-0070, #1367), handed to
   * {@link ComposeStackVms.remove} once the caller may delete it; `null` for
   * a stack not on a Stack VM.
   */
  private async removeOnStackVm(
    ctx: PermissionCtx,
    composeId: string,
    deleteData: boolean,
    keep: KeepConfig,
  ) {
    await this.permissions.checkServiceAccess(ctx, composeId, 'delete');
    const current = await this.findOwned(ctx, composeId);
    return this.stackVms.remove(ctx, current.composeId, deleteData, keep);
  }

  private async removeRow(
    ctx: PermissionCtx,
    composeId: string,
    deleteVolumes: boolean,
    force: boolean,
    keep: KeepConfig,
  ): Promise<
    Compose & {
      orphaned?: OrphanedWorkload;
      unreclaimedImages?: UnreclaimedImages[];
      unreclaimedArtifacts?: UnreclaimedArtifact[];
    }
  > {
    await this.permissions.checkServiceAccess(ctx, composeId, 'delete');
    const current = await this.findOwned(ctx, composeId);
    const row = await this.findRow(current.composeId);
    // Every step below dials through this one, so a Server it could not
    // connect to is dialled once for the whole Delete —
    // `remote/reachability-memo.ts`.
    const deleteExec = new ReachabilityMemo(this.remoteExec);

    let accepted = true;
    try {
      await this.runTarget(row, deleteExec).exec(
        this.teardownCommand(row, deleteVolumes),
      );
    } catch {
      // Best-effort: what is left is decided by the presence read below. The
      // flag says only whether the settle wait below has anything to wait *for*
      // (H-99): a teardown the daemon never accepted has nothing draining, so
      // re-asking about it would delay a refusal that is already correct.
      accepted = false;
    }

    const presence = await this.workloadPresence(row, accepted, deleteExec);
    if (presence !== 'absent' && !force) {
      throw workloadKeptRefusal(
        presence,
        presence === 'present'
          ? this.stillPresentMessage(row)
          : `Cloudgate could not reach Docker to confirm compose stack ${row.appName} is gone, so the Compose was kept — delete again when the server is reachable, or delete with ?force=true`,
      );
    }

    // After the refusal, before the row (ADR-0016's slot). The file is
    // read here and not earlier because nothing before this removes it: the
    // project directory goes last, below (see above).
    // A forced Delete past a stack it could not confirm gone only untags:
    // a running container holds the image, so waiting for it would only
    // spend the budget (`ImageRelease`).
    const unreclaimedImages = await reclaimComposeBuiltImages(
      deleteExec,
      row,
      await this.readComposeFileForReclamation(row, deleteExec),
      presence === 'absent' ? awaitImageRelease() : 'untag-only',
    );

    // And the stack's deployment logs, `{logs}/{appName}` on
    // `compose.serverId` — where `DeploymentsService.initializeLog` wrote them,
    // a stack being built where it runs. The project directory's `rm -rf`
    // names only the project tree, and `deployment.composeId` cascades, so
    // before this the directory outlived every row that could open it. Same
    // slot as the images, for the same reason: nothing regenerates a log.
    // With them, the run logs of its schedules, backups and volume backups,
    // whose rows cascade from this one (`common/run-log-owners.ts`).
    // And the network Network isolation gave it, which `down` never
    // removes because the rewrite declares it external. The teardown already
    // tried; this is the retry a Swarm stack needs once its tasks have left
    // the overlay, and the one place a refusal is reported.
    // And its Trace store, container, directory and network, for the
    // images' reason: nothing regenerates a trace.
    // And then the project directory itself, which the teardown program
    // used to end with ahead of the refusal — erasing the `files/` and
    // `traces/` of a stack the caller was then told still exists. After the
    // Trace store, which is its child and whose container writes into it.
    const unreclaimedArtifacts = [
      ...(await reclaimComposeNetwork(deleteExec, row)),
      ...(await reclaimTraceStores(this.db, deleteExec, [
        composeTraceOwner(row),
      ])),
      ...(await reclaimComposeDirectory(deleteExec, row)),
      ...(await reclaimDeploymentLogs(deleteExec, [
        { appName: row.appName, serverId: row.serverId },
        ...(await runLogOwnersOf(this.db, [
          { serviceId: row.composeId, serverId: row.serverId },
        ])),
      ])),
    ];

    // Absent rather than empty, like every other field in this family: a
    // healthy delete reports nothing and the field keeps meaning *these were
    // left behind* (`common/teardown-steps.ts`).
    const leftBehind = {
      ...(unreclaimedImages.length > 0 ? { unreclaimedImages } : {}),
      ...(unreclaimedArtifacts.length > 0 ? { unreclaimedArtifacts } : {}),
    };
    // The row goes in the transaction its console Save's config rewrite
    // commits in.
    const removed = await writeKept(
      this.db,
      keep,
      async (db) => {
        const [deleted] = await db
          .delete(compose)
          .where(eq(compose.composeId, current.composeId))
          .returning();
        return deleted;
      },
      () => ({ serviceId: current.composeId, removed: leftBehind }),
    );
    if (presence === 'absent') return { ...removed, ...leftBehind };
    // Forced. Say what was left behind rather than answering a bare 200.
    return {
      ...removed,
      ...leftBehind,
      orphaned: {
        appName: row.appName,
        serverId: row.serverId,
        reason: presence,
      },
    };
  }

  /**
   * The stack's own compose file for {@link composeBuiltImageTags}, or `''`.
   *
   * A wrapper around {@link readComposeFile} rather than a second reader,
   * differing from it in exactly one way: it never throws. `remove` calls it
   * for one purpose — naming images — and every failure it can meet is a stack
   * that has nothing to reclaim anyway: a raw stack answers from a column and
   * cannot fail, and a git-sourced stack's `cat` fails when the Server is
   * unreachable or when nothing was ever cloned there. Neither may cost the
   * operator their delete.
   */
  private async readComposeFileForReclamation(
    row: Parameters<ComposeService['readComposeFile']>[0],
    remoteExec: RemoteExecService,
  ): Promise<string> {
    try {
      return await this.readComposeFile(row, remoteExec);
    } catch {
      return '';
    }
  }

  /**
   * The 409 for a workload that is still there after the teardown, worded for
   * the branch it is answering (H-99).
   *
   * *"Stop it, then delete again"* is right for a `docker-compose` project —
   * `ComposeService.stop` runs `docker compose stop`, the probe's
   * `docker compose ps --quiet` stops naming the containers, and the next delete
   * goes through. It is **wrong for a `stack`**, where `Stop` *is*
   * `docker stack rm`: the very command `remove` ran one statement earlier. So
   * the advice a stack gets is the one that works — wait, then delete again —
   * and `?force=true` is offered either way.
   *
   * **This reads `composeType` and that does not reintroduce H-87.** What H-87
   * forbids is deciding a *safety* property from a column a caller may `PATCH`:
   * the teardown runs both subsystems and the presence read asks both questions,
   * neither consults this column, and neither changes here. A wrong wording
   * costs a retry that is already offered; a wrong probe drops a row while the
   * workload keeps running. Only the second is keyed off anything immutable.
   */
  private stillPresentMessage(
    row: Pick<Compose, 'appName' | 'composeType'>,
  ): string {
    const kept = `so the Compose was kept: deleting the record would leave them unreachable through Cloudgate`;
    return row.composeType === 'stack'
      ? `Swarm stack ${row.appName} still has tasks, ${kept} — Docker is still shutting the stack down, so delete again in a moment, or delete with ?force=true`
      : `Compose stack ${row.appName} still has containers, ${kept} — stop it, then delete again, or delete with ?force=true`;
  }

  /**
   * Whether the stack's workload survived the teardown, in
   * `applicationServicePresence`'s three-valued shape and for its reason: a
   * daemon that cannot be reached at all is not the same answer as "gone", and
   * treating it as gone is the shortcut that manufactures the orphan.
   * Only the command differs, because only the command is compose-specific.
   *
   * `composeType` is deliberately **not** in the `Pick`: the read asks both
   * compose questions and takes the pessimistic answer, so this route no longer
   * has a mutable discriminator to be wrong about (H-87). See
   * `readComposeWorkloadPresence`.
   *
   * `settle` is whether the daemon accepted the teardown, and therefore whether
   * there is a removal in flight worth waiting on (H-99): `docker stack rm`
   * returns on acceptance while its tasks linger in `Shutdown` for several
   * seconds, so "is it gone" has no final answer yet. It waits for the daemon to
   * agree rather than deciding without it, and a spent budget still returns the
   * probe's own last answer — see `awaitComposeWorkloadAbsent`.
   */
  private async workloadPresence(
    row: Pick<Compose, 'appName' | 'serverId' | 'composeId' | 'cloudAccountId'>,
    settle: boolean,
    remoteExec: RemoteExecService,
  ): Promise<WorkloadPresence> {
    const target = this.runTarget(row, remoteExec);
    const run = async (command: string) => (await target.exec(command)).stdout;
    return settle
      ? awaitComposeWorkloadAbsent(row.appName, run, this.settleClock)
      : readComposeWorkloadPresence(row.appName, run);
  }

  /**
   * Disconnects traefik from the app network and takes the stack/project down.
   * The project directory is not its business: `remove` drops it
   * after the refusal, with `reclaimComposeDirectory`.
   *
   * The command itself moved to `compose.utils.ts` beside
   * `composePresenceCommand`, because a Project or Environment delete has to
   * tear its compose children down the same way this route does and a second
   * copy would drift. This stays as the row-shaped call site the rest of
   * the service reads.
   *
   * It takes the stack down *and* the project down rather than choosing by
   * `composeType`, for the reason `composeTeardownCommand` gives: the row's type
   * is `PATCH`-able, and a teardown aimed at the wrong daemon subsystem fails
   * into the caller's `catch` where nothing sees it (H-87).
   */
  private teardownCommand(
    row: Pick<Compose, 'appName' | 'serverId'>,
    deleteVolumes: boolean,
  ): string {
    return composeTeardownCommand(row.serverId, row.appName, deleteVolumes);
  }

  /**
   * Brings an already-built project up from its code directory. Only meaningful
   * for the docker-compose type — a stack is (re)started by deploying it, and
   * since H-106 a `stack` row is refused here rather than answered.
   *
   * **H-83 is checked here against the bytes on disk, and that is not the same
   * check the write surfaces run.** It runs `docker compose up -d` over the
   * *converted* file `getBuildComposeCommand` left in the code directory — so a
   * stack poisoned before the rule existed, or by a route the rule does not
   * cover, would come back up straight past every write-path guard. It is the
   * on-disk file that reaches Docker, so it is the on-disk file that is checked:
   * the column can differ from it (an edit without a deploy), and checking the
   * column would be checking a file this command will not read.
   *
   * **The two platform defaults are re-applied to that same file before the
   * `up -d` (H-98), and that is the only thing this route regenerates.** `up -d`
   * creates containers, which makes this a create site for the log cap
   * (`common/config/container-logs.ts`, kind 3) and for the restart policy —
   * and it was the one create site in `backend/src` that read neither. The
   * stored converted file of every stack deployed before those defaults carries
   * `restart:` zero times and `logging:` zero times (verified on all four such
   * stacks on the host), so Start brought them back with `RestartPolicy=no` and
   * an uncapped log driver, the next daemon restart dropped them again, and
   * nothing told the operator that Deploy — not Start — was the cure.
   * `composeStartCommand` holds the rewrite, K-6's two residuals included: a
   * service that declares its own `logging:` keeps it whole, and a `stack` row
   * gets no `restart:` key.
   *
   * **Rejected, still: routing `start` through the deploy path.** That is the
   * other way to close both of these, and it would change what the action *is*.
   * `start` deliberately preserves container identity and the writable layer and
   * does not clone, patch, re-inject or rebuild (ADR-0011); making it
   * deploy would turn a lifecycle rung into a deploy, take the volume-lock and
   * log-path machinery with it, and change the answer every existing caller
   * gets. A guard must not buy its coverage by redefining the verb it guards.
   * Re-applying two keys to a file Cloudgate itself wrote is not redefining the
   * verb: nothing is cloned, nothing is built, no domain is re-injected and no
   * `.env` is rewritten.
   *
   * **A `stack` row is refused with a 400 (H-106), where it used to run nothing
   * and report `done`.** That it runs nothing was always deliberate — a swarm
   * stack is (re)started by `docker stack deploy` and this method has no such
   * command — but the status write was not: `stop` on a `stack` row is
   * `docker stack rm`, so Stop → Start left the row claiming `done` with zero
   * tasks on the host, which is the one thing a status must never say. The two
   * repairs available were to make the status true (write back what the row
   * already was) or to refuse the verb, and the verb is refused because a
   * lifecycle rung that cannot move the workload has nothing to report either
   * way: the operator wants Deploy, and only a refusal says so.
   *
   * The refusal follows `removeContainers`, which turns away a `stack` for the
   * neighbouring reason and in the same register — a plain `BadRequestException`
   * naming the control the caller wanted (ADR 0005: no per-module error shape).
   * As there, the console already hides Start for this type
   * (`frontend/src/features/compose/lifecycle/compose-actions.tsx`), so this is
   * defence in depth against a direct API call rather than a change anyone using
   * the console sees.
   *
   * Because nothing but a `docker-compose` row now reaches the body, the read
   * below is unconditional: the `composeType === 'docker-compose' ? … : null`
   * ternary this method used to open with had no reachable `null` branch left,
   * and a guard that cannot fire reads as a second opinion about the type. The
   * `docker-compose` behaviour itself is unchanged (H-98).
   *
   * Safe to run over converted content because the ownership rule admits
   * Cloudgate's own generated labels by construction — they name this stack's
   * own `domain` rows — so no author/generated discrimination is needed. See
   * `compose-labels.ts`.
   *
   * The `cat` is unconditional rather than `readComposeFile`'s raw shortcut: for
   * a raw stack that helper answers from the `composeFile` column, which is
   * exactly the file this command does *not* run.
   */
  async start(ctx: PermissionCtx, composeId: string) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const current = await this.findOwned(ctx, composeId);
    const row = await this.findRow(current.composeId);

    // Refused rather than answered with a status nothing on the host backs
    // (H-106). Before any status is written and before anything runs: the row is
    // left exactly as the operator left it, which for a stopped stack is the
    // `stopped` that Stop wrote.
    if (row.composeType !== 'docker-compose') {
      throw new BadRequestException(
        'Start applies only to a compose stack of the docker-compose type; a swarm stack is (re)started by deploying it, so Deploy is the action you want',
      );
    }
    // Nothing new starts on a Server in maintenance (spec #1420).
    await refuseWhileInMaintenance(this.db, [row.serverId]);

    // `''` is "nothing on disk", which still runs the `up -d`: on a stack that
    // was never deployed it fails, and `notDeployedRefusal` below is what says
    // why — the `cd` alone used to, as a bare 500. The read is the
    // claim check's, reused rather than repeated: `up -d` reads this file and
    // so does the guard, and one `cat` answers both (H-98).
    // A Stack VM stack's VM first (ADR-0070, #1370): Start brings back a
    // Stack VM its Stop stopped, and nothing below reaches it before its
    // tunnel answers. Refused before any status is written, as above.
    if (row.cloudAccountId !== null) {
      await this.stackVms.start(row, this.runTarget(row));
      return this.startOnStackVm(row);
    }

    const onDisk = await this.readClaimableOnDiskCompose(
      ctx.session.activeOrganizationId,
      row,
    );

    try {
      await this.runTarget(row).exec(composeStartCommand(row, onDisk));
      return await this.updateStatus(row.composeId, 'done');
    } catch (error) {
      const refusal = await this.notDeployedRefusal(
        row,
        composeCodeDirectory(stackRootId(row), row.appName),
        'start',
      );
      if (refusal) throw refusal;
      // `error`, as Stop's failure. This wrote `idle`, the column's
      // never-deployed default, over a stack whose directory had just proved a
      // Deployment ran — and after an `up -d` that may have brought some of its
      // services up. A state nobody knows is what `error` means here.
      await this.updateStatus(row.composeId, 'error');
      throw error;
    }
  }

  /**
   * `compose stop` / `stack rm`, and the row goes `stopped`.
   *
   * **`'stopped'`, not `'idle'`.** `'idle'` is the column's default, so
   * a stack an operator had just stopped and one that had never been deployed
   * were the same row to every reader — the stopped-status defect, one module over.
   */
  async stop(ctx: PermissionCtx, composeId: string) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const current = await this.findOwned(ctx, composeId);
    const row = await this.findRow(current.composeId);

    // A Stack VM already down has no containers running and no tunnel to
    // reach them by, so its Stop only records it stopped.
    if (row.cloudAccountId !== null && (await this.stackVms.isDown(row))) {
      const stopped = await this.updateStatus(row.composeId, 'stopped');
      await this.incidents.closeForService('compose', row.composeId);
      return stopped;
    }

    try {
      if (row.composeType === 'docker-compose') {
        await this.runTarget(row).exec(composeLifecycleCommand(row, 'stop'));
      } else {
        await this.runTarget(row).exec(
          `docker stack rm ${quote([row.appName])}`,
        );
      }
      // Then a Stack VM stack's VM (ADR-0070, #1370), so a stopped stack
      // pays only for its disk. Its containers stopped cleanly first.
      if (row.cloudAccountId !== null) await this.stackVms.stop(row);
      const stopped = await this.updateStatus(row.composeId, 'stopped');
      await this.incidents.closeForService('compose', row.composeId);
      return stopped;
    } catch (error) {
      // `docker stack rm` has no directory to be missing, so only the
      // docker-compose branch can be refused as never deployed.
      const refusal =
        row.composeType === 'docker-compose'
          ? await this.notDeployedRefusal(
              row,
              composeProjectDirectory(stackRootId(row), row.appName),
              'stop',
            )
          : null;
      if (refusal) throw refusal;
      await this.updateStatus(row.composeId, 'error');
      throw error;
    }
  }

  /**
   * `docker compose restart`: the stack's containers restart where they run,
   * and nothing else does — on a Stack VM, never the VM itself (ADR-0070,
   * #1370). Gated as Stop and Start are. A Stack VM that is down is refused,
   * saying to Start it, since only Start brings the VM back.
   */
  async restart(ctx: PermissionCtx, composeId: string) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const current = await this.findOwned(ctx, composeId);
    const row = await this.findRow(current.composeId);

    if (row.composeType !== 'docker-compose') {
      throw new BadRequestException(
        'Restart applies only to a compose stack of the docker-compose type; a swarm stack is restarted by deploying it, so Deploy is the action you want',
      );
    }
    // A restart starts the stack's containers again, which a Server in
    // maintenance refuses as it refuses Start (spec #1420).
    await refuseWhileInMaintenance(this.db, [row.serverId]);
    if (row.cloudAccountId !== null && (await this.stackVms.isDown(row))) {
      throw new ConflictException(
        `${row.configName}'s Stack VM is stopped: start it first`,
      );
    }

    try {
      await this.runTarget(row).exec(composeLifecycleCommand(row, 'restart'));
      return await this.updateStatus(row.composeId, 'done');
    } catch (error) {
      const refusal = await this.notDeployedRefusal(
        row,
        composeProjectDirectory(stackRootId(row), row.appName),
        'restart',
      );
      if (refusal) throw refusal;
      await this.updateStatus(row.composeId, 'error');
      throw error;
    }
  }

  /**
   * Whether the stack's Stack VM runs, read from its cloud now (ADR-0070,
   * #1370): what the stack page shows, so a VM problem is told apart from
   * an app problem. A stack that is not on a Stack VM is refused.
   */
  async stackVmStatus(
    ctx: PermissionCtx,
    composeId: string,
  ): Promise<StackVmStatus> {
    const current = await this.findOwned(ctx, composeId);
    return this.stackVms.status(await this.findRow(current.composeId));
  }

  /**
   * Start's second half on a Stack VM (#1370): `docker compose start` on
   * the containers its Stop stopped, as the spec asks, never `up -d` —
   * every stack on a Stack VM was deployed with the platform defaults, so
   * there is nothing for {@link composeStartCommand} to re-apply (H-98),
   * and its containers keep who they were (ADR-0011).
   */
  private async startOnStackVm(
    row: Awaited<ReturnType<ComposeService['findRow']>>,
  ) {
    try {
      await this.runTarget(row).exec(composeLifecycleCommand(row, 'start'));
      return await this.updateStatus(row.composeId, 'done');
    } catch (error) {
      const refusal = await this.notDeployedRefusal(
        row,
        composeProjectDirectory(stackRootId(row), row.appName),
        'start',
      );
      if (refusal) throw refusal;
      await this.updateStatus(row.composeId, 'error');
      throw error;
    }
  }

  /**
   * Remove containers — the lifecycle rung between `stop` and `remove`
   * (ADR-0011).
   *
   * `stop` runs `docker compose stop`, which leaves the containers `Exited` and
   * still holding their volumes, so a volume restore refused and the only
   * control that cleared it was `remove`, which destroys this row too. ADR-0011
   * records why `stop` was not simply changed to remove instead: `stop` →
   * `start` preserves container identity and the writable layer, which is what
   * every existing caller of it wants.
   *
   * On the gate, which is a deliberate hybrid rather than either neighbour's:
   * `stop`'s lifecycle statement, plus row-level service access, and pointedly
   * not `remove`'s `service:['delete']` — a custom role holding
   * `volumeBackup:['restore']` without delete rights has to be able to finish
   * the restore this action unblocks, and gating on delete would rebuild the
   * same dead end one door along. The row-level half is not a second check
   * written here: `findOwned` already runs `checkServiceAccess(…, 'read')`,
   * which is both the `service:['read']` statement and the caller's
   * `accessedServices` membership, and is what already refuses a member with no
   * grant on this stack. Repeating it inline would cost two more queries and
   * refuse nobody new; raising it to `'delete'` is the dead end above.
   *
   * **`'read'` and not `'update'`, and this paragraph is why.** The operate
   * level moved every write of a Service's *definition* to `service: ['update']`,
   * and the first pass moved this one with them — which turned
   * `compose.e2e-spec.ts`'s assertion that a custom role holding
   * `volumeBackup:['restore']` and `deployment:['create']` may finish its
   * restore red. That is the dead end above, rebuilt one door further along: the
   * role is granted the lifecycle statement precisely so it can do this, and
   * `update` is the action for rewriting the stack, which it is deliberately
   * not granted. The level it makes expressible is *"see and operate this
   * service, but do not rewrite its definition"*, and requiring `update` to
   * operate it would have made that level unsayable again.
   *
   * It also takes the volume lock for every volume a turn-off
   * backup of this stack names, and answers a held lock with a 409 rather than
   * queueing behind a tar — the removal is what pulls the container out from
   * under a backup that stopped it and is still tarring.
   */
  async removeContainers(ctx: PermissionCtx, composeId: string) {
    await this.permissions.checkPermission(ctx, { deployment: ['create'] });
    const current = await this.findOwned(ctx, composeId);
    const row = await this.findRow(current.composeId);

    // Refused rather than quietly treated as a second Stop. A swarm stack's
    // `stop` runs `docker stack rm`, which already leaves no container holding
    // a volume, so there is nothing here for this action to do — and answering
    // 200 would report containers removed by a command that never ran. The
    // console hides the control for this type, so anything reaching this line is
    // talking to the API directly and is told which control it wanted
    // (ADR 0005: a plain HttpException, no per-module error shape).
    if (row.composeType !== 'docker-compose') {
      throw new BadRequestException(
        'Remove containers applies only to a compose stack of the docker-compose type; a swarm stack leaves no containers behind when it is stopped, so Stop is the action you want',
      );
    }

    const volumeNames = await this.lockedVolumeNames(row.composeId);

    try {
      await this.runTarget(row).exec(
        removeComposeContainersCommand(row.serverId, row.appName, volumeNames),
      );
      // `stopped`, as Stop: deployed, taken down on purpose, and Start
      // brings it back from the project directory — none of which the
      // never-deployed `idle` says.
      const stopped = await this.updateStatus(row.composeId, 'stopped');
      // Stopped, so the Stop hook closes its open Incidents too.
      await this.incidents.closeForService('compose', row.composeId);
      return stopped;
    } catch (error) {
      // `volumeNames.length` is part of the condition because only a command
      // that took a lock can have been refused by one: with no volumes to hold
      // there is no preamble, so an exit 75 out of the `rm` itself is an
      // ordinary failure and must not be dressed up as a 409 about no volume.
      if (volumeNames.length > 0 && isVolumeLockBusyError(error)) {
        // The status is deliberately left alone. `catch` paints the stack
        // `'error'` because a `rm` that failed part-way leaves it in a state
        // nobody knows; a refused acquisition ran nothing at all — no container
        // was stopped and none removed — so the stack is exactly as the operator
        // left it, and reporting damage that did not happen would send them
        // looking for it.
        //
        // The marker line does reach us: unlike the volume-backup run, this
        // command's output is not redirected into a log file. The fallback names
        // the candidates rather than nothing, which with one lock held is
        // exactly the right name and with several is honest about the set the
        // contention is inside.
        throw new ConflictException(
          volumeLockBusyMessage(
            busyVolumeNameFrom(error) ?? volumeNames.join("' or '"),
          ),
        );
      }
      const refusal = await this.notDeployedRefusal(
        row,
        composeProjectDirectory(stackRootId(row), row.appName),
        'remove the containers of',
      );
      if (refusal) throw refusal;
      await this.updateStatus(row.composeId, 'error');
      throw error;
    }
  }

  /**
   * The 409 for a lifecycle command that failed because the stack was never
   * deployed, or `null` when that is not why.
   *
   * Start, Stop and Remove containers each `cd` into a directory only a
   * Deployment creates. Without this the shell's `can't cd` was an unhandled
   * 500, and the console — which has to read a 5xx on these routes as the
   * proxy giving up on a slow `docker compose up` — told the operator Docker
   * "may have carried on", about a command Docker never saw. Asked only once
   * the command has failed, of the directory the command `cd`'d into; only
   * `'absent'` is refused, so a Server that cannot be reached, or a stack
   * that is there and failed for its own reasons, rethrows as before.
   *
   * The caller throws it **before** its status write: nothing ran, so the row
   * keeps the status it had rather than the `error` a failed command paints.
   */
  private async notDeployedRefusal(
    row: Pick<Compose, 'serverId' | 'appName' | 'composeId' | 'cloudAccountId'>,
    directory: string,
    verb: 'start' | 'stop' | 'restart' | 'remove the containers of',
  ): Promise<ConflictException | null> {
    const target = this.runTarget(row);
    const presence = await readComposeDirectoryPresence(
      directory,
      async (command) => (await target.exec(command)).stdout,
    );
    if (presence !== 'absent') return null;
    return new ConflictException(
      `There is nothing of '${row.appName}' on its Server to ${verb}: no Deployment of this stack has run there yet, so deploy the stack first`,
    );
  }

  /**
   * The service names of the compose file — the stored definition for raw
   * sources, the cloned file on the build server otherwise.
   *
   * **The one route with no content guard in front of it, and the content
   * guard's sixth 500.** `listComposeServices` parses through the unguarded
   * {@link parseComposeFile}, and unlike every write surface this method has no
   * {@link assertComposeContentClaimable} ahead of it — correctly, since it emits
   * nothing and claims nothing. So a file the parser will not read answered
   * `Internal server error` here, for a `raw` stack whose stored column predates
   * the guard and — the case that matters — for **every git-sourced stack whose
   * repository holds a broken compose file**, which reaches no DTO at all and is
   * an ordinary state for a repository to be in.
   *
   * The refusal rather than an empty list, and rather than the 500: the console's
   * own `declared-services.tsx` already tells an operator that a file which is
   * not valid YAML "fails here too", so this screen is where they are sent to
   * find out — it just had no sentence to show them. Answering `[]` was the other
   * candidate and is rejected for H-74's reason one link back: a list of no
   * services is indistinguishable from a file that declares none, and that is
   * exactly the confusion once recorded (an untouched file read as healthy, with
   * Deploy offering to apply it).
   */
  async loadServices(ctx: PermissionCtx, composeId: string) {
    await this.permissions.checkServiceAccess(ctx, composeId, 'read');
    const current = await this.findOwned(ctx, composeId);
    const row = await this.findRow(current.composeId);

    const content = await this.readComposeFile(row);
    const parseRefusal = composeFileParseRefusal(content);
    if (parseRefusal !== null) {
      throw new BadRequestException(parseRefusal);
    }
    return listComposeServices(content);
  }

  /**
   * The compose file as the deploy actually applies it — the same rewrite
   * `getBuildComposeCommand` pipes onto the build server
   * (`writeDomainsToCompose`), fed the same domains the deployment engine
   * loads, serialized back to YAML. Read-scoped like loadServices; the stored
   * file is never touched.
   */
  async getConverted(ctx: PermissionCtx, composeId: string): Promise<string> {
    await this.permissions.checkServiceAccess(ctx, composeId, 'read');
    const current = await this.findOwned(ctx, composeId);
    const row = await this.findRow(current.composeId);

    const content = await this.readComposeFile(row);
    const domains = await this.domains.findComposeDomains(row.composeId);
    // On a Stack VM its Domains' ports are published there by the deploy
    // (#1371), so the file shown is the one it runs, as the engine writes it.
    const routes = row.cloudAccountId
      ? await this.domains.findStackVmRoutes(row.composeId)
      : [];
    try {
      // `'verbatim'`: `GET /compose/:id/converted` answers a caller
      // `checkServiceAccess(…, 'read')` admitted, and the whole point of the
      // screen is to show them their own file.
      return withoutTraceCredential(
        writeDomainsToCompose(
          row,
          publishStackVmPorts(content, routes),
          domains,
          'verbatim',
        ),
        await traceStoreRowOf(this.db, 'compose', row.composeId),
      );
    } catch (error) {
      // The rewrite rejects an empty file and a domain pointing at a service
      // the file does not declare — both are the stack's own configuration,
      // so they read as 400 rather than a logged 500 (ADR 0005).
      const message =
        typeof (error as { message?: unknown })?.message === 'string'
          ? (error as { message: string }).message
          : 'Compose file could not be converted';
      throw new BadRequestException(message);
    }
  }

  /**
   * The compose file's content: the stored definition for raw sources, the
   * cloned file on the build server otherwise.
   *
   * The path is argv rather than a word this method quotes: a `cat` of a
   * path is the single-command shape, `getComposeFilePath` composes it from
   * `appName` and the row's `composePath`, and it is read on whichever host
   * built the stack. It was one of the two sites a quoting bug shipped at — a path
   * spliced into a trivial `cat` — so it is the site the argv form exists for,
   * and the quoting is now `execOnServer`'s rather than this file's.
   */
  private async readComposeFile(
    row: Pick<
      Compose,
      | 'appName'
      | 'sourceType'
      | 'composePath'
      | 'composeFile'
      | 'serverId'
      | 'composeId'
      | 'cloudAccountId'
    >,
    remoteExec: RemoteExecService = this.remoteExec,
  ): Promise<string> {
    if (row.sourceType === 'raw') return row.composeFile;

    const { stdout } = await this.runTarget(row, remoteExec).exec([
      'cat',
      getComposeFilePath(row),
    ]);
    return stdout;
  }

  /**
   * The deploy path's load: the full relation tree with git-provider
   * credentials intact — exactly what a clone needs. Internal — called by the
   * queue's job processor, so no PermissionCtx.
   */
  async findDeployable(composeId: string) {
    const found = await this.db.query.compose.findFirst({
      where: eq(compose.composeId, composeId),
      with: {
        environment: { with: { project: true } },
        customGitSSHKey: true,
        github: true,
        gitlab: true,
        gitea: true,
        bitbucket: true,
      },
    });
    if (!found) throw new NotFoundException('Compose not found');
    return found;
  }

  /**
   * Sets the stack's composeStatus. Internal — called by the
   * deployment engine as builds progress, never from a controller, so it
   * takes no PermissionCtx.
   */
  async updateStatus(composeId: string, status: ApplicationStatus) {
    const [updated] = await this.db
      .update(compose)
      .set({ composeStatus: status })
      .where(eq(compose.composeId, composeId))
      .returning();
    if (!updated) throw new NotFoundException('Compose not found');
    return updated;
  }

  /**
   * Records what a **successful** deploy's file declared: the fixed TCP
   * ports it published, so a TCP Uptime check on a stack from a repository
   * can be aimed at one (`publishedPortsOf` reads them back), and the
   * volumes its Delete removes (`compose.deployedVolumes`, ADR-0069),
   * recorded for every source since a plan's destroy line reads them, from
   * the stack's name and type. Internal — called by
   * `DeploymentEngineService.deployCompose` once the build has succeeded,
   * never on a failure, which leaves the previous record as it was.
   *
   * **`content` is the bytes that deploy already read and admitted** with
   * {@link assertComposeContentClaimable}, handed over rather than read again:
   * a second `cat` here would be a second way to read the file off the
   * Server, one no claim check had seen. A `raw` deploy clears the record,
   * because its ports are read from `composeFile` (see
   * `compose.deployedPublishedPorts`).
   */
  async recordDeployedFile(
    stack: Pick<
      Compose,
      'composeId' | 'sourceType' | 'appName' | 'composeType'
    >,
    content: string,
  ): Promise<void> {
    await this.db
      .update(compose)
      .set({
        deployedPublishedPorts:
          stack.sourceType === 'raw'
            ? null
            : listComposePublishedPorts(content),
        deployedVolumes: listComposeVolumes(
          content,
          stack.appName,
          stack.composeType,
        ),
      })
      .where(eq(compose.composeId, stack.composeId));
  }

  /**
   * The row by id — for internal paths that already checked access.
   *
   * **A projection rather than the `select()` this was, and the `composeFile`
   * encryption is what made that worth writing down.** Three of this table's columns are
   * `encryptedText` — `composeFile`, `env` and `refreshToken` — and `encryptedText`
   * decrypts at the driver boundary, so a `select()` ran AES-256-GCM three times for the
   * seven callers of this
   * method, of which exactly three read `composeFile` and *none* reads `env`
   * or `refreshToken`. `update`, `remove`, `start`, `stop`, `removeContainers`,
   * `loadServices` and `getConverted` between them read the eight columns
   * below and nothing else, which the compiler holds them to: every consumer
   * takes a `Pick<Compose, …>`, so a caller that grows a ninth field fails to
   * compile here rather than reading `undefined`.
   *
   * Not narrowed further, and the reason is the asymmetry: `composeFile` is
   * *needed* by `update`'s claim check, `loadServices` and `getConverted`, so
   * splitting this into a with-file read and a without-file read would trade
   * two decryptions on four paths for a second method whose two callers can
   * drift. `TraefikSetupService.reconnectServicesToTraefik` is the site where
   * the narrowing does pay outright, because that one reads a single column of
   * every stack on the instance.
   */
  private async findRow(composeId: string) {
    const [row] = await this.db
      .select({
        composeId: compose.composeId,
        appName: compose.appName,
        configName: compose.configName,
        serverId: compose.serverId,
        cloudAccountId: compose.cloudAccountId,
        region: compose.region,
        stackVm: compose.stackVm,
        composeType: compose.composeType,
        sourceType: compose.sourceType,
        composePath: compose.composePath,
        composeFile: compose.composeFile,
        isolatedDeployment: compose.isolatedDeployment,
        command: compose.command,
      })
      .from(compose)
      .where(eq(compose.composeId, composeId))
      .limit(1);
    if (!row) throw new NotFoundException('Compose not found');
    return row;
  }

  /**
   * The volumes Remove containers has to hold for the duration of its `rm`
   * every distinct `volumeName` of a turn-off volume backup of this
   * stack. Those are the only volumes this action can contend for — a turn-off
   * backup is the one that stops the containers and tars underneath them, so it
   * is the one a removal can pull a volume out from under.
   *
   * `enabled` is pointedly not in the `where`. A disabled row's *schedule* does
   * not fire, but its run can still be triggered by hand from the console, so
   * its volume is every bit as contendable as an enabled row's — and filtering
   * it out would drop the lock in the case where a run is most likely to have
   * been started by hand.
   */
  private async lockedVolumeNames(composeId: string): Promise<string[]> {
    const rows = await this.db
      .select({ volumeName: volumeBackup.volumeName })
      .from(volumeBackup)
      .where(
        and(
          eq(volumeBackup.composeId, composeId),
          eq(volumeBackup.turnOff, true),
        ),
      );
    return [...new Set(rows.map(({ volumeName }) => volumeName))];
  }

  /**
   * Where this stack runs: its Stack VM through its cloud's tunnel, its
   * Server over SSH, or the platform host (`remote/run-target.ts`). Every
   * command this service sends the stack goes through it, so none of them
   * chooses a transport for itself. A Delete passes its `ReachabilityMemo`
   * so a place it could not reach is dialled once.
   */
  private runTarget(
    row: Pick<Compose, 'serverId' | 'composeId' | 'cloudAccountId'>,
    remoteExec: RemoteExecService = this.remoteExec,
  ): RunTarget {
    return runTargetOn(row, { remoteExec });
  }

  /**
   * H-83's ownership half: every hostname a compose file's own Traefik labels
   * claim has to be one this organization may claim on this Server.
   *
   * **One rule, reused rather than reimplemented.**
   * `DomainsService.assertHostsUnclaimed` is what `POST /domains` and
   * `POST /ai/deploy` already apply, and it is called here through its
   * organization-shaped entry point. Writing a second ownership predicate would
   * be the H-20 shape — a writer that reaches the sink around the guard — and
   * the two would drift on the first change to either.
   *
   * The static half (`readComposeHostClaims`) is the part that has to fail
   * closed, and it does: a `HostRegexp` nobody can own, a rule not bounded to a
   * hostname, a rule the parser cannot fully read, a host compose has still to
   * interpolate, and a `com.docker.*` key are all refused before any query runs.
   * A parser that fell back to "found no hosts" would admit exactly the rules it
   * failed to read, which is H-74's lesson one chain-link back.
   *
   * **The two refusals answer differently on purpose.** A malformed or unownable
   * label is the caller's own file being wrong — a 400 naming the label. A
   * hostname another organization holds is a 409 carrying
   * `HOST_CLAIMED_MESSAGE`, which is deliberately the same opaque sentence
   * `POST /domains` answers with, so this route is not an enumeration oracle for
   * another organization's hostnames when its sibling is not.
   *
   * Claims are de-duplicated because Cloudgate's own injector writes the same
   * host twice for an https domain (a `web` redirect router and a `websecure`
   * one), and a stack with a dozen domains would otherwise run a dozen pairs of
   * identical queries.
   *
   * **`GET /compose/:id/converted` deliberately gets the static half only**, and
   * it gets it for free — `writeDomainsToCompose` carries it, and that route
   * already turns the emitter's throws into a 400 naming the label, which is the
   * right answer for a stack whose own file is unroutable. It does *not* get the
   * ownership query, and the reason is that the route emits nothing to Traefik:
   * it re-serializes a file for the Converted tab and writes nowhere, so a
   * refusal there would buy no safety that the write surfaces have not already
   * bought. It is not an oracle argument — a caller who wants to know whether a
   * hostname is held can ask `POST /domains`, and gets the same opaque sentence.
   *
   * **A third refusal, and the reason it is also stated in the DTO**.
   * `readComposeHostClaims` parses, and it used to parse unguarded here: a
   * compose file `parse` will not read threw straight out of this method and the
   * filter rendered it as a **500** — on `POST /compose`, `PATCH /compose/:id`,
   * `POST /compose/:id/start`, `createByTemplate`'s caller and
   * `deployment-engine.service.ts`' pre-flight. `dto/compose.dto.ts`'
   * `composeFileSchema` now refuses it at the field for every route that carries
   * one, which is where §2.4 wants the rule; **this half cannot be deleted on
   * the strength of that**, because three of the callers hand over content no
   * DTO ever saw — `update`'s `data.composeFile ?? row.composeFile` reads the
   * stored column, {@link readClaimableOnDiskCompose} reads the file back off
   * the Server, and the deployment engine reads a cloned repository, which is
   * the only seam a git-sourced stack's file is ever visible at.
   *
   * **The refusal is asked for ahead of `readComposeHostClaims`, not folded into
   * its `catch`**, and that placement is the load-bearing part.
   * `composeFileParseRefusal` wraps exactly one call — the library's `parse` —
   * so *everything* it converts came from the parser and nothing came from
   * `readComposeHostClaimsFromSpec`. Widening the `catch` below instead would
   * have made a future bug in that rule a 400 blaming the operator's file for
   * it, and it is `ReferenceError`s and `TypeError`s that a bug most often
   * raises — the very classes the alias refusals arrive as. The cost is one
   * extra parse of content about to be parsed again, which is inside a budget
   * `update` already spends per Domain row through
   * `composeServiceUsesMapFormLabels`.
   *
   * **This is why the neighbour legitimately differs.**
   * `composeServiceUsesMapFormLabels` wraps the same parse in a `try` and
   * answers `false`, and that was chosen deliberately — it is a *predicate*, and
   * every input it cannot read is already some other guard's refusal. This is a
   * *guard*: content it cannot read is content it has not admitted, and a
   * fail-open here would store a file nothing can deploy. That asymmetry between
   * two adjacent parses is what surfaced the content guard.
   *
   * **`echo` decides what the refusal may quote, and it defaults to
   * `'summary'`.** `compose.composeFile` is `encryptedText` (ADR 0015),
   * and this method's five own call sites and its sixth answer ADR 0015's
   * echo question differently. `create`, `update`, `createByTemplate` and
   * `readClaimableOnDiskCompose` are answering an HTTP request from a caller
   * `checkServiceAccess` has already admitted to this stack — the audience the
   * column already has — so they pass `'verbatim'` and an operator still gets
   * the parser's own words and the offending label named. The sixth is
   * `DeploymentEngineService.deployCompose`'s pre-flight, whose `catch` hands
   * one string to `appendErrorToLog` *and* to `notifier.buildError`: email,
   * mattermost, telegram, pushover and a **customer-supplied webhook**. That is
   * a different audience, so it gets the summary.
   *
   * **The default is the summary rather than the verbatim form, and that is the
   * decision rather than an accident of ordering.** A refusal that reaches a
   * third party by default is a leak the next caller inherits; a refusal that is
   * too terse by default is a caller passing an argument. The five drifted
   * copies of `checkServerAccess` — one of which was never written, and was the
   * security bug — is the precedent for choosing the direction in which
   * forgetting is safe.
   *
   * **What the deployment log loses, said plainly.** `deployCompose`'s `catch`
   * reads `error.message` for both sinks, so one string serves both and the log
   * is summarized along with the notification. That is a real cost and the
   * argument for keeping a schedule's log echo verbatim applies here in
   * principle — the log sits behind `checkRowAccess`, the same predicate as the
   * column. It is accepted for three reasons and it is recoverable. The
   * operator's own source still holds the bytes (the column for a raw stack,
   * the repository for a git one) and a refused deploy has changed neither; the
   * position survives into the summary, which is already recorded as the part
   * *"an operator navigates by"*; and the parser's own words stay one click
   * away, both from `POST /compose/:id/start` and `PATCH /compose/:id`, which
   * run this same guard with `'verbatim'`, and from the console editor's local
   * `yamlProblem`, which drives the same parser with the same options. **The
   * one line that would buy the log its verbatim words back is in
   * `deployment-engine.service.ts`' `deployCompose` `catch`, not here**: split
   * the two sinks, hand `appendErrorToLog` the message and `notifier.buildError`
   * {@link composeContentRefusalSummary}'s answer. That file was owned by
   * another change while this one landed, which is why the split is at the
   * refusal rather than at the sink.
   *
   * The third refusal this method can make needs nothing: `HOST_CLAIMED_MESSAGE`
   * is *"This hostname is already in use"*, deliberately opaque so it is not an
   * ownership oracle, so it quotes no byte of anything either way.
   */
  async assertComposeContentClaimable(
    scope: { organizationId: string; serverId: string | null },
    content: string,
    echo: ComposeRefusalEcho = 'summary',
  ): Promise<void> {
    // Before the read below rather than inside its `catch` — see the
    // docblock. Even the verbatim sentence carries the parser's words without
    // the caret diagram quoting the file; `echo` decides whether the words
    // themselves travel, because `error.message` from here reaches a Deployment
    // log and a build-failure notification.
    const parseRefusal = composeFileParseRefusal(content, echo);
    if (parseRefusal !== null) {
      throw new BadRequestException(parseRefusal);
    }
    // No Compose joins the AI models' overlay, whichever route or
    // deploy pre-flight brought the content here.
    const aiNetworkRefusal = composeAiNetworkRefusal(content);
    if (aiNetworkRefusal !== null) {
      throw new BadRequestException(aiNetworkRefusal);
    }
    let claims: ComposeHostClaim[];
    try {
      claims = readComposeHostClaims(content);
    } catch (error) {
      // ADR 0005: a plain HttpException, no per-module error shape. The
      // verbatim message names the label, because the caller's next step is to
      // remove it; the summary names the reason and not the label, because a
      // label key is a word of an `encryptedText` column and ADR 0015's rule
      // is that the platform cannot know which of its words are the secret.
      if (error instanceof ComposeLabelRefusal) {
        throw new BadRequestException(
          echo === 'summary' ? error.summary : error.message,
        );
      }
      // Deliberately still a 500: the parse cannot fail here (the line above
      // has already read this same content), so anything arriving is this
      // module's bug rather than the caller's file.
      throw error;
    }
    if (claims.length === 0) return;
    await this.domains.assertHostsUnclaimedInOrganization(
      scope.organizationId,
      [...new Set(claims.map((claim) => claim.host))],
      scope.serverId,
    );
  }

  /**
   * The converted compose file on the stack's own server — what
   * `POST /compose/:id/start` is about to run — after
   * {@link assertComposeContentClaimable} has admitted it. Returns the bytes so
   * the caller can hand them to `composeStartCommand`, which re-applies the two
   * platform defaults to them (H-98); one `cat` answers both questions, because
   * both are about the same file.
   *
   * A missing file is not a refusal, and answers `''`: `start` on a stack that
   * was never deployed has nothing on disk, the `docker compose up` fails and
   * {@link notDeployedRefusal} says why, and answering "your labels are
   * wrong" for an absent file would name the wrong problem. `2>/dev/null || true` is the same
   * zero-exit-either-way shape `composePresenceCommand` uses and for the same
   * reason — `RemoteExecService` rejects on any non-zero exit, so "not there" has
   * to be said on stdout rather than in the exit status.
   *
   * **The check runs before the rewrite, and the rewrite cannot invalidate it.**
   * `applyComposeDefaults` writes `restart:` and `logging:` and nothing else, and
   * `readComposeHostClaims` reads neither, so the claims of the bytes written
   * back are the claims of the bytes admitted here. A file whose labels are
   * refused is never written to.
   *
   * A shell string rather than `readComposeFile`'s argv, because the redirect and
   * the `|| true` *are* the contract (`exec-dispatch.ts`), which makes the path
   * this builder's to `quote()` (§2.9) — as `appName` and `composePath` are
   * everywhere else in this file.
   */
  private async readClaimableOnDiskCompose(
    organizationId: string,
    row: Pick<
      Compose,
      | 'appName'
      | 'sourceType'
      | 'composePath'
      | 'serverId'
      | 'composeType'
      | 'composeId'
      | 'cloudAccountId'
    >,
  ): Promise<string> {
    const { stdout } = await this.runTarget(row).exec(
      `cat ${quote([getComposeFilePath(row)])} 2>/dev/null || true`,
    );
    if (stdout.trim() === '') return '';
    await this.assertComposeContentClaimable(
      { organizationId, serverId: row.serverId },
      stdout,
      // `'verbatim'`: this refusal answers an HTTP request from a caller
      // already admitted to this stack, which is the audience
      // `compose.composeFile` already has.
      'verbatim',
    );
    return stdout;
  }

  /**
   * The organization a target environment belongs to, for a call with no ctx —
   * **any** environment on the instance, which is the half worth saying.
   *
   * The sibling {@link findParentEnvironment} carries
   * `eq(project.organizationId, ctx.session.activeOrganizationId)` and this one
   * cannot: its only caller, {@link createByTemplate}, has no `ctx` to take it
   * from. So this answers "which organization owns this id", never "may the
   * requester use this id" — the second question is the caller's, and
   * `createByTemplate`'s docblock names the caller that answers it and the
   * spec that holds them to it.
   *
   * Having `createByTemplate` take the organization as a parameter instead was
   * rejected when this was written and stays rejected: resolving it from the
   * environment means a caller cannot supply the *wrong* one, which is a
   * different failure from the one above and the more likely of the two.
   */
  private async findEnvironmentOrganization(environmentId: string) {
    const [found] = await this.db
      .select({
        organizationId: project.organizationId,
        deployTarget: environment.deployTarget,
      })
      .from(environment)
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(eq(environment.environmentId, environmentId))
      .limit(1);
    if (!found) throw new NotFoundException('Environment not found');
    return found;
  }

  /**
   * {@link findOwned} at the write level.
   *
   * `findOwned` is correctly `'read'` — it is the lookup both readers and
   * writers share, and raising it would raise `loadServices` and
   * `getConverted` with it — so the `'update'` claim is made here instead,
   * once, for the two **definition** writes. `ApplicationsService` and the
   * database base class carry the same pair for the same reason.
   *
   * **{@link start}, {@link stop} and {@link removeContainers} deliberately
   * keep `findOwned`** — see `removeContainers`, which argued the shape of this
   * before the operate level existed and would have been broken by it.
   *
   * The order is the point of the method. Asking for `'update'` *before*
   * `findOwned` runs means a caller holding `read` and not `update` is refused
   * without learning whether the id resolves (§2.2). The redundant `'read'`
   * check inside `findOwned` afterwards costs a second pass over the member row
   * and is deliberate: a custom role granted `update` without `read` is
   * refused, because there is no writing a definition you cannot see.
   */
  private async findOwnedForUpdate(ctx: PermissionCtx, composeId: string) {
    await this.permissions.checkServiceAccess(ctx, composeId, 'update');
    return this.findOwned(ctx, composeId);
  }

  /**
   * Row-level service access plus org scoping (environment → project), the
   * write-path counterpart of findOne without the relation tree.
   *
   * Read-level, and stays so: {@link findOwnedForUpdate} is the write-path
   * entry.
   */
  private async findOwned(ctx: PermissionCtx, composeId: string) {
    await this.permissions.checkServiceAccess(ctx, composeId, 'read');
    const [found] = await this.db
      .select({ composeId: compose.composeId })
      .from(compose)
      .innerJoin(
        environment,
        eq(compose.environmentId, environment.environmentId),
      )
      .innerJoin(project, eq(environment.projectId, project.projectId))
      .where(
        and(
          eq(compose.composeId, composeId),
          eq(project.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Compose not found');
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
