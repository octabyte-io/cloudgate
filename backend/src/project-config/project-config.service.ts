import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ConfigRepositorySources } from 'api-schemas';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Node } from 'yaml';

import { CLOUD_NAMES, cloudOrLegacy } from '../cloud-accounts/cloud-provider';
import { BillingService } from '../cloud/billing/billing.service';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  application,
  cloudAccount,
  mysql,
  plan,
  postgres,
  projectConfigLocation,
  redis,
} from '../db/schema';
import type { Environment, Plan } from '../db/schema';
import { environmentNetworkName } from '../deployments/service-scope';
import type { DrizzleTx } from '../environments/config-name';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import type { PlanStepResult } from './applier/apply.types';
import { EnvironmentNetworkRuns } from './applier/environment-network-runs.service';
import type { StartedNetwork } from './applier/environment-network-runs.service';
import {
  emptyResult,
  PLAN_REFUSED_CODE,
  PlanApplier,
  refusedPlan,
} from './applier/plan-applier';
import type { ApplyInput, Connections } from './applier/plan-applier';
import { ConfigLocations } from './config-locations.service';
import { moveVersion } from './config-version';
import { ConfigMoves } from './config-moves.service';
import { whilePlanApplies } from './console-saves';
import {
  CONFIG_UNREADABLE_CODE,
  PROJECT_CONFIG_REPOSITORY_KEPT_CODE,
} from './console-saves/repository-kept';
import type { ConfigLocationTarget, ConfigRead } from './dto/plan.dto';
import { parseProjectConfig } from './format/parse-config';
import { serviceEntries, withServiceEntries } from './format/config-entries';
import {
  dropPendingSetups,
  dropUnusedSetupRecords,
  pendingValuesOf,
  pendingWritesOf,
} from '../templates/setup/pending-setups';
import { describeError } from '../common/describe-error';
import {
  LISTED_NAMES,
  ONLY_WHEN_STATED,
  statedFields,
  VARIABLE_LISTS,
} from './planner/fields';
import type { VariableList } from './planner/fields';
import { isNetworkStep, isQuietRead } from './planner/cloud-steps';
import type { DeployTarget, PlanStep } from './planner/plan.types';
import {
  deployTargetMoved,
  inCopy,
  inEnvironment,
  notOpen,
  refuseDataOfNoCloudDatabaseDestroy,
  refuseFilesOfNoBucketDestroy,
  refuseUnconfirmed,
  refuseUnreadAws,
  stalePlan,
  unreadable,
} from './plan-errors';
import { keptRead, PlanStore, repositoryRead } from './plan-store.service';
import type { Planned, PlanReads } from './plan-store.service';
import type {
  ConfirmedMove,
  EnvironmentConfigCopy,
  LockedService,
  MovePreview,
  PlanView,
  ProjectConfigView,
  SavedConfigPlans,
} from './project-config.views';
import type { ConfigReadResult } from './reader/config-reader.port';
import {
  readSavedServices,
  settingsFingerprint,
  textHash,
} from './saved-settings';

export { PLAN_REFUSED_CODE };
// `CONFIG_UNREADABLE` (US54) and `PROJECT_CONFIG_REPOSITORY_KEPT`
// live beside the console Saves seam, which refuses with them
// too; the rest beside the refusals that use them. They are answered from
// here as before.
export { CONFIG_UNREADABLE_CODE, PROJECT_CONFIG_REPOSITORY_KEPT_CODE };
export {
  CONFIG_PATH_AMBIGUOUS_CODE,
  MOVE_STALE_CODE,
  PLAN_DESTROY_NOT_CONFIRMED_CODE,
  PLAN_NOT_OPEN_CODE,
  PLAN_STALE_CODE,
  PLAN_UPGRADE_NOT_CONFIRMED_CODE,
  PROJECT_CONFIG_MISSING_CODE,
  PROJECT_CONFIG_NOT_REPOSITORY_KEPT_CODE,
} from './plan-errors';

/**
 * The text a new Project's config starts as (US13): `version: 1` and no
 * Services, so "every Project has one" has no exception.
 */
export const EMPTY_CONFIG_TEXT = 'version: 1\nservices: {}\n';

/**
 * The project-config module's service: what every other module and
 * the module's controllers call. Its internals — the format, the planner,
 * the saved-settings reader, the Applier, the plan store, moves
 * ({@link ConfigMoves}) and push plans (`PushPlans`) — are reached only
 * through here.
 */
@Injectable()
export class ProjectConfigService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly applier: PlanApplier,
    private readonly locations: ConfigLocations,
    private readonly plans: PlanStore,
    private readonly moves: ConfigMoves,
    private readonly networks: EnvironmentNetworkRuns,
    // An Apply onto the platform host is refused on the Hosted instance
    // (ADR-0053).
    private readonly instanceMode: InstanceMode,
    // An Apply's first cloud Service in an Environment is a Cloud
    // Environment on a Hosted plan (ADR-0048).
    private readonly billing: BillingService,
  ) {}

  /**
   * Starts a new Project's Cloudgate-kept config, empty (US13). Called inside
   * the transaction that inserts the Project, so a Project never exists
   * without one.
   */
  async createEmpty(tx: DrizzleTx, projectId: string): Promise<void> {
    await tx
      .insert(projectConfigLocation)
      .values({ projectId, kind: 'cloudgate', text: EMPTY_CONFIG_TEXT });
  }

  /**
   * The Project's config, on the Project's read entitlement. A Project from
   * before configs existed answers `location: null` rather than 404: the
   * Project is there, it has no config yet.
   */
  async findConfig(
    ctx: PermissionCtx,
    projectId: string,
  ): Promise<ProjectConfigView> {
    await this.findProject(ctx, projectId);
    return {
      projectId,
      location: await this.locations.locationView(projectId),
    };
  }

  /**
   * One Environment's copy of the config (US55), on `environment: read`: a
   * repository-kept config's is read now from the Environment's Config
   * branch and answered with its commit and a link to the file, or with why
   * it cannot be read. It is never stored.
   */
  async findCopy(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<EnvironmentConfigCopy> {
    const env = await this.locations.findEnvironment(
      ctx,
      environmentId,
      'read',
    );
    const place = await this.locations.repositoryPlace(env.projectId);
    if (!place) return { kind: 'cloudgate', environmentId };
    const read = await this.locations.readCopy(place, env.configBranch);
    return {
      kind: 'repository',
      environmentId,
      repository: place.repository,
      path: place.path,
      configBranch: env.configBranch,
      copy: read.ok
        ? {
            text: read.text,
            commitSha: read.commitSha,
            branch: read.branch,
            fileUrl: read.fileUrl,
          }
        : null,
      refusal: read.ok
        ? null
        : { reason: read.reason, branch: read.branch, message: read.message },
      services: await this.lockedServices(environmentId, read),
    };
  }

  /**
   * The Services the config, as this Environment reads it, gives a
   * repository as their source, and where it is kept: a
   * Cloudgate-kept config's stored text, a repository-kept one's copy on the
   * Environment's Config branch.
   * A `managed: console` entry, one with no `source` and an image source name
   * none. A Project with no config names none; a copy that cannot be read or
   * parsed is `readable: false`, and names none either.
   */
  async repositorySources(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<ConfigRepositorySources> {
    const env = await this.locations.findEnvironment(
      ctx,
      environmentId,
      'read',
    );
    const location = await this.locations.findLocation(env.projectId);
    const keptIn = location?.kind ?? null;
    let text: string | null = null;
    if (location?.kind === 'cloudgate') {
      text = location.text;
    } else if (location?.kind === 'repository') {
      const place = await this.locations.repositoryPlace(env.projectId);
      const read = place
        ? await this.locations.readCopy(place, env.configBranch)
        : null;
      if (!read?.ok) return { keptIn, readable: false, services: [] };
      text = read.text;
    }
    if (text === null) return { keptIn, readable: true, services: [] };
    const parsed = parseProjectConfig(text);
    if (!parsed.ok) return { keptIn, readable: false, services: [] };
    const services = Object.entries(parsed.config.services).flatMap(
      ([configName, entry]) => {
        const source =
          entry.managed === false && 'source' in entry ? entry.source : null;
        // An image and uploaded files name no repository.
        if (
          !source ||
          source.sourceType === 'docker' ||
          source.sourceType === 'drop'
        ) {
          return [];
        }
        return [
          {
            configName,
            provider: source.sourceType,
            repository:
              source.sourceType === 'git'
                ? source.customGitUrl
                : source.repository,
          },
        ];
      },
    );
    return { keptIn, readable: true, services };
  }

  /** A move's preview; see {@link ConfigMoves.preview}. */
  previewMove(
    ctx: PermissionCtx,
    projectId: string,
    to: ConfigLocationTarget,
  ): Promise<MovePreview> {
    return this.moves.preview(ctx, projectId, to);
  }

  /** A move's confirm; see {@link ConfigMoves.confirm}. */
  confirmMove(
    ctx: PermissionCtx,
    projectId: string,
    to: ConfigLocationTarget,
    reads: readonly ConfigRead[],
  ): Promise<ConfirmedMove> {
    return this.moves.confirm(ctx, projectId, to, reads);
  }

  /**
   * "Check for changes" (US21): plans the Project's config against this
   * Environment's saved settings and stores the result. It reads AWS for
   * every cloud Service and Environment network there, so a plan
   * with nothing to change in the config stays open until those reads say
   * AWS does not differ either. A plan with steps
   * is the Environment's one open plan, replacing any open one (US22); a
   * plan with none says so as `unchanged` and is never open (US24), though
   * it too replaces an open one, which no longer describes anything to do.
   *
   * A config that cannot be planned — it does not parse, the planner refuses
   * it, or no git provider connection reaches a repository a create names —
   * is a 409 naming each place, and leaves the open plan as it was.
   */
  async requestPlan(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<PlanView> {
    const env = await this.locations.findEnvironment(
      ctx,
      environmentId,
      'read',
    );
    const place = await this.locations.repositoryPlace(env.projectId);
    if (place) {
      // A repository-kept config is read from this Environment's Config
      // branch, and an unreadable one refuses the plan: no fallback (US54).
      const read = await this.locations.readCopy(place, env.configBranch);
      if (!read.ok) throw unreadable(env.name, place, read);
      const parsed = parseProjectConfig(read.text);
      if (!parsed.ok) {
        throw inCopy(
          refusedPlan([parsed.refusal]),
          env.name,
          place,
          read.branch,
        );
      }
      let planned: Planned;
      try {
        planned = await this.plans.planOne(
          ctx,
          env,
          parsed.config,
          await this.plans.previousOf(environmentId, { kind: 'repository' }),
          place.gitProviderId,
          'everything',
        );
      } catch (error) {
        throw inCopy(error, env.name, place, read.branch);
      }
      const made = await this.db.transaction((tx) =>
        this.plans.store(tx, ctx.user.id, planned, repositoryRead(read)),
      );
      await this.plans.releaseHeld([environmentId]);
      return this.plans.view(made);
    }

    return this.planKept(ctx, env, new Map(), 'everything');
  }

  /**
   * A Template set up in one more Environment of a Cloudgate-kept config
   * (#1377): plans only that Environment, from the stored text with the
   * setup's `entries` it does not list yet, and stores its plan. The other
   * Environments are not planned again: the entries are the Project's
   * already, and each holds them back until the template is set up there.
   */
  async planSetupIn(
    ctx: PermissionCtx,
    environmentId: string,
    entries: ReadonlyMap<string, Node>,
  ): Promise<PlanView> {
    const env = await this.locations.findEnvironment(
      ctx,
      environmentId,
      'read',
    );
    return this.planKept(ctx, env, entries, 'touched');
  }

  /** A Cloudgate-kept config's plan of one Environment, stored. */
  private async planKept(
    ctx: PermissionCtx,
    env: Environment,
    entries: ReadonlyMap<string, Node>,
    reads: PlanReads,
  ): Promise<PlanView> {
    const { environmentId } = env;
    const stored = await this.locations.storedText(env.projectId);
    // A Template setup's entries, held only by the open plan until Apply.
    const text = withServiceEntries(
      await this.plans.withPendingEntries(environmentId, stored),
      entries,
    );
    const parsed = parseProjectConfig(text);
    if (!parsed.ok) throw refusedPlan([parsed.refusal]);

    const planned = await this.plans.planOne(
      ctx,
      env,
      parsed.config,
      await this.plans.previousOf(environmentId, {
        kind: 'cloudgate',
        text: stored,
      }),
      null,
      reads,
    );
    const made = await this.db.transaction((tx) =>
      this.plans.store(tx, ctx.user.id, planned, keptRead(text, stored)),
    );
    await this.plans.releaseHeld([environmentId]);
    return this.plans.view(made);
  }

  /**
   * The Project config page's whole-YAML edit (US16): plans the edited text
   * against every Environment of the Project and stores a plan for each,
   * each replacing that Environment's open plan. **Nothing is applied and
   * the text is not stored**: it is stored when one of these plans is
   * applied. A text that changes nothing anywhere is stored at once, since
   * there is no plan to apply and it would otherwise be lost (a comment, a
   * reordering).
   *
   * One Environment refusing the text refuses the save, naming the
   * Environment, and stores no plan. Needs `environment: read` on each
   * Environment, as asking for each plan would.
   */
  async savePlans(
    ctx: PermissionCtx,
    projectId: string,
    text: string,
    startedFrom?: number,
  ): Promise<SavedConfigPlans> {
    await this.findProject(ctx, projectId);
    const stored = await this.locations.storedText(projectId);
    // An edit naming the version it started from is refused once the
    // config has moved on (ADR-0080); one naming none plans as it always has.
    if (startedFrom !== undefined) {
      await this.locations.refuseStaleVersion(this.db, projectId, startedFrom);
    }
    const parsed = parseProjectConfig(text);
    if (!parsed.ok) throw refusedPlan([parsed.refusal]);

    const environments = await this.locations.environmentsOf(projectId);
    const planned: { planned: Planned; text: string }[] = [];
    for (const env of environments) {
      await this.permissions.checkEnvironmentAccess(
        ctx,
        env.environmentId,
        'read',
      );
      // An open setup's entries this text was saved without (ADR-0065).
      const own = await this.plans.withPendingEntries(env.environmentId, text);
      const config =
        own === text ? parsed.config : parseOrRefuse(own, env.name);
      try {
        planned.push({
          text: own,
          planned: await this.plans.planOne(
            ctx,
            env,
            config,
            await this.plans.previousOf(env.environmentId, {
              kind: 'cloudgate',
              text: stored,
            }),
          ),
        });
      } catch (error) {
        throw inEnvironment(error, env.name);
      }
    }

    const storeNow = planned.every((one) => one.planned.steps.length === 0);
    const plans = await this.db.transaction(async (tx) => {
      // Again, holding the config row: a write may have landed while
      // planning. First, the order an Apply and a console Save lock in.
      await this.locations.refuseStaleVersion(tx, projectId, startedFrom);
      const made: Plan[] = [];
      for (const one of planned) {
        made.push(
          await this.plans.store(
            tx,
            ctx.user.id,
            one.planned,
            keptRead(one.text, stored),
          ),
        );
      }
      if (storeNow) {
        await this.locations.writeText(tx, projectId, text, ctx.user.id);
      }
      return made;
    });
    await this.plans.releaseHeld(
      planned.map((one) => one.planned.environmentId),
    );
    return { stored: storeNow, plans: await this.plans.views(plans) };
  }

  /**
   * The Environment's open plan, or else its latest, or `null` when it has
   * never been planned.
   */
  async findPlan(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<{ plan: PlanView | null }> {
    await this.locations.findEnvironment(ctx, environmentId, 'read');
    const [found] = await this.db
      .select()
      .from(plan)
      .where(eq(plan.environmentId, environmentId))
      .orderBy(
        sql`(${plan.status} = 'open') desc`,
        desc(plan.createdAt),
        desc(plan.planId),
      )
      .limit(1);
    return { plan: found ? await this.plans.view(found) : null };
  }

  /**
   * Applies the Environment's open plan (US23, US27–US30, US36), naming it,
   * so an Apply aimed at a plan a newer one has replaced is refused.
   *
   * Refused, with nothing written: on the Hosted instance, any Apply in an
   * Environment whose Deploy target is the platform host
   * (`PLATFORM_HOST_REFUSED`, ADR-0053); a plan no longer open; a
   * `confirmDestroy` that is not exactly the Config names of the plan's
   * destroys (`PLAN_DESTROY_NOT_CONFIRMED`), or a `confirmUpgrade` that is
   * not exactly those of its major upgrades (`PLAN_UPGRADE_NOT_CONFIRMED`),
   * or a `deleteFilesOf` naming anything but a bucket it destroys
   * (`PLAN_DESTROY_NOT_CONFIRMED`), or a `deleteDataOf` naming
   * anything but a cloud database it destroys; a plan whose stored text or
   * compared settings have moved on (`PLAN_STALE`), the text being current
   * when it is still the one the plan was made against or already the plan's
   * own; a step whose statement the caller lacks (403); a repository no
   * connection reaches any more (`PLAN_REFUSED`).
   *
   * Then the plan is claimed, so a second Apply of it is refused, each step
   * runs on its own, and the plan ends `applied` or `partly-applied` with
   * each step's result. The plan's text is stored either way: what is left
   * is what the next plan of it shows (US28).
   */
  async applyPlan(
    ctx: PermissionCtx,
    environmentId: string,
    planId: string,
    confirm: {
      readonly destroy?: readonly string[];
      readonly upgrade?: readonly string[];
    } = {},
    deleteFilesOf: readonly string[] = [],
    deleteDataOf: readonly string[] = [],
  ): Promise<PlanView> {
    const env = await this.locations.findEnvironment(
      ctx,
      environmentId,
      'read',
    );
    // On the Hosted instance a plan creates nothing on the platform host
    // (ADR-0053): ahead of the plan's own checks, since none of them
    // can make an Apply there right.
    if (env.deployTarget.kind === 'platform-host') {
      this.instanceMode.refusePlatformHost('services');
    }
    const found = await this.findOpenPlan(environmentId, planId);
    refuseUnconfirmed(found.steps, {
      destroy: confirm.destroy ?? [],
      upgrade: confirm.upgrade ?? [],
    });
    refuseFilesOfNoBucketDestroy(found.steps, deleteFilesOf);
    refuseDataOfNoCloudDatabaseDestroy(found.steps, deleteDataOf);

    // A Deploy target switch is said as such, ahead of everything else the
    // plan may have gone stale on: its creates name the old place.
    const targetMoved = deployTargetMoved(found.deployTarget, env.deployTarget);
    if (targetMoved) throw stalePlan(targetMoved);
    // A cloud Service in an Environment that holds none yet is one more
    // Cloud Environment: refused naming the Add-on when the count is
    // full, before anything is read or written.
    if (
      found.steps.some(
        (step) => step.action === 'create' && step.placement.kind === 'cloud',
      )
    ) {
      await this.billing.assertRoomForCloudServices(
        ctx.session.activeOrganizationId,
        environmentId,
      );
    }
    // Never a half-read plan, named by the cloud it reads.
    refuseUnreadAws(found.steps, await this.cloudNameOf(env.deployTarget));

    const place = await this.locations.repositoryPlace(env.projectId);
    const saved = await readSavedServices(this.db, environmentId);
    const settingsMoved =
      settingsFingerprint(saved, env.deployTarget) !==
      found.settingsFingerprint;
    let text: string;
    let stored: string | null = null;
    let configRepository: ApplyInput['configRepository'] = null;
    if (place) {
      // The Config branch is read again: an Apply runs the commit the plan
      // read, or nothing (US23, US36).
      const read = await this.locations.readCopy(place, env.configBranch);
      if (!read.ok) throw unreadable(env.name, place, read);
      if (
        found.commitSha === null ||
        found.commitSha !== read.commitSha ||
        found.branch !== read.branch ||
        found.textHash !== textHash(read.text) ||
        settingsMoved
      ) {
        throw stalePlan(
          found.commitSha !== null && found.commitSha !== read.commitSha
            ? `its Config branch ${read.branch} is at commit ${read.commitSha} now, not ${found.commitSha}`
            : 'the config or its saved settings changed since it was made',
        );
      }
      text = read.text;
      if (place.gitProviderId && place.providerType) {
        configRepository = {
          gitProviderId: place.gitProviderId,
          providerType: place.providerType,
          repository: place.repository,
          branch: read.branch,
        };
      }
    } else {
      stored = await this.locations.storedText(env.projectId);
      const storedHash = textHash(stored);
      const planText =
        found.text ?? (storedHash === found.textHash ? stored : null);
      if (
        planText === null ||
        // A plan of a repository copy, made before the config moved here.
        found.commitSha !== null ||
        (storedHash !== found.baseTextHash && storedHash !== found.textHash) ||
        settingsMoved
      ) {
        throw stalePlan(
          'the config or its saved settings changed since it was made',
        );
      }
      text = planText;
    }
    const parsed = parseProjectConfig(text);
    if (!parsed.ok) throw refusedPlan([parsed.refusal]);

    // A Template part's values, still waiting in its Pending setup.
    const templateParts = found.steps.flatMap((step) =>
      step.action === 'create' && step.template
        ? [
            {
              pendingSetupId: step.template.pendingSetupId,
              configName: step.configName,
            },
          ]
        : [],
    );
    const templateValues = await pendingValuesOf(
      this.db,
      environmentId,
      templateParts,
    );
    const used = templateParts.find(
      (part) => !templateValues.has(part.configName),
    );
    if (used) {
      throw stalePlan(
        `the Pending setup ${used.configName} was to be created from has been cancelled, used, or dropped after 30 days unused`,
      );
    }

    const input: ApplyInput = {
      projectId: env.projectId,
      environmentId,
      deployTarget: env.deployTarget,
      planId,
      steps: found.steps,
      config: parsed.config,
      saved,
      configRepository,
      heldBuilds: await this.plans.heldBuildsOf(planId),
      deleteFilesOf: new Set(deleteFilesOf),
      deleteDataOf: new Set(deleteDataOf),
      templateValues,
      templateWrites: await pendingWritesOf(
        this.db,
        environmentId,
        templateParts,
      ),
    };
    const connections = await this.applier.check(ctx, input);
    const networkStep = found.steps.find(
      (step): step is Extract<PlanStep, { action: 'network-create' }> =>
        step.action === 'network-create',
    );
    if (networkStep) await this.networks.refuseBusy(environmentId, networkStep);

    const now = new Date().toISOString();
    const claimed = await this.db.transaction(async (tx) => {
      // Every Apply moves the config's version, whatever its text does
      // (ADR-0080): a push's, a whole-YAML edit's or a check's. The config
      // row first, the order a console Save and a whole-YAML edit lock in.
      await moveVersion(tx, env.projectId, ctx.user.id);
      const [made] = await tx
        .update(plan)
        .set({ status: 'applied', appliedBy: ctx.user.id, appliedAt: now })
        .where(and(eq(plan.planId, planId), eq(plan.status, 'open')))
        .returning();
      if (!made) throw notOpen('applied');
      return made;
    });

    // A made network's Drift is put back by its own run, queued first.
    const putBacks: PlanStepResult[] = [];
    for (const step of found.steps) {
      if (step.action === 'network-change' && !isQuietRead(step)) {
        putBacks.push(await this.networks.putBack(environmentId, step));
      }
    }
    const applyTheRest = (before: PlanStepResult[], steps: PlanStep[]) =>
      this.runSteps(ctx, env.projectId, { ...input, steps }, connections, {
        text,
        stored,
        before: [...putBacks, ...before],
      });
    if (!networkStep) {
      return this.plans.view(await applyTheRest([], [...found.steps]));
    }

    // The Environment network first: its run takes minutes, so the
    // Apply answers with the network `running` and the rest follows it.
    let started: StartedNetwork;
    try {
      started = await this.networks.start(environmentId, networkStep);
    } catch (error) {
      const [ended] = await this.db
        .update(plan)
        .set({
          status: 'partly-applied',
          results: found.steps.map((step) => ({
            ...emptyResult(
              isNetworkStep(step)
                ? environmentNetworkName(step.region)
                : step.configName,
              step.action,
            ),
            message: `Not applied: ${describeError(error)}`,
          })),
        })
        .where(eq(plan.planId, planId))
        .returning();
      await this.plans.releaseHeld([environmentId]);
      return this.plans.view(ended);
    }
    const [running] = await this.db
      .update(plan)
      .set({ results: [...putBacks, started.result] })
      .where(eq(plan.planId, planId))
      .returning();
    void this.networks.continueApply(claimed, networkStep, started, {
      applyTheRest: async (made) => {
        await applyTheRest(
          [made],
          found.steps.filter((step) => step.action !== 'network-create'),
        );
      },
      keepText: (tx) =>
        this.keepText(tx, env.projectId, text, stored, ctx.user.id),
    });
    return this.plans.view(running);
  }

  /** An applied plan's text, stored; a repository copy's never is (ADR-0029). */
  private async keepText(
    tx: DrizzleTx,
    projectId: string,
    text: string,
    stored: string | null,
    changedBy: string,
  ): Promise<void> {
    if (stored !== null && text !== stored) {
      await this.locations.writeText(tx, projectId, text, changedBy);
    }
  }

  /**
   * An Apply's steps, run by the Applier, and the plan settled with their
   * results after `before` (the network's): `applied` when every one
   * was, else `partly-applied`. The plan's text is stored either way: what
   * is left is what the next plan of it shows (US28).
   */
  private async runSteps(
    ctx: PermissionCtx,
    projectId: string,
    input: ApplyInput,
    connections: Connections,
    settle: {
      text: string;
      stored: string | null;
      before: PlanStepResult[];
    },
  ): Promise<Plan> {
    // The steps write through the console's own paths; they are this plan's,
    // not console Saves to keep the config in step with.
    const results = [
      ...settle.before,
      ...(await whilePlanApplies(() =>
        this.applier.run(ctx, input, connections),
      )),
    ];
    const [applied] = await this.db.transaction(async (tx) => {
      await this.keepText(
        tx,
        projectId,
        settle.text,
        settle.stored,
        ctx.user.id,
      );
      return tx
        .update(plan)
        .set({
          status: results.every((result) => result.status === 'applied')
            ? 'applied'
            : 'partly-applied',
          results,
        })
        .where(eq(plan.planId, input.planId))
        .returning();
    });
    this.applier.startDatabaseDeploys(ctx, results);
    // What the Apply did not release itself (a failed step's) builds with
    // the settings there are now.
    await this.plans.releaseHeld([input.environmentId]);
    return applied;
  }

  /**
   * Dismisses the Environment's open plan (US35), on `environment: update`.
   * Names the plan, so a dismiss aimed at a plan a newer one has replaced is
   * refused rather than landing on the newer one.
   */
  async dismissPlan(
    ctx: PermissionCtx,
    environmentId: string,
    planId: string,
  ): Promise<PlanView> {
    const env = await this.locations.findEnvironment(
      ctx,
      environmentId,
      'update',
    );
    const [dismissed] = await this.db
      .update(plan)
      .set({
        status: 'dismissed',
        dismissedBy: ctx.user.id,
        dismissedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(plan.planId, planId),
          eq(plan.environmentId, environmentId),
          eq(plan.status, 'open'),
        ),
      )
      .returning();
    if (dismissed) {
      await this.dropDismissedSetups(env.projectId, dismissed);
      // Its held builds build with the old settings.
      await this.plans.releaseHeld([environmentId]);
      return this.plans.view(dismissed);
    }
    await this.findOpenPlan(environmentId, planId);
    throw notOpen('dismissed');
  }

  /**
   * A dismissed plan's Template setups, dropped (ADR-0065): on a
   * Cloudgate-kept config the text changes only at Apply, so the Pending
   * setups its creates were to use, and a Setup record that then records
   * nothing, are all a setup left. A repository-kept config's setups wait
   * for the next push instead; a plan a move dismissed is not a dismiss.
   */
  private async dropDismissedSetups(
    projectId: string,
    dismissed: Plan,
  ): Promise<void> {
    if (await this.locations.repositoryPlace(projectId)) return;
    const pendingSetupIds = [
      ...new Set(
        dismissed.steps.flatMap((step) =>
          step.action === 'create' && step.template
            ? [step.template.pendingSetupId]
            : [],
        ),
      ),
    ];
    if (pendingSetupIds.length === 0) return;
    const stored = await this.locations.storedText(projectId);
    await this.db.transaction(async (tx) => {
      const records = await dropPendingSetups(
        tx,
        dismissed.environmentId,
        pendingSetupIds,
      );
      await dropUnusedSetupRecords(
        tx,
        records,
        new Set(serviceEntries(stored).keys()),
      );
    });
  }

  /**
   * The Environment's describable Services as its copy locks them:
   * by the same rule the console Saves seam refuses by — owned when the
   * file describes it, or when the file cannot be read or parsed.
   */
  private async lockedServices(
    environmentId: string,
    read: ConfigReadResult,
  ): Promise<LockedService[]> {
    const parsed = read.ok ? parseProjectConfig(read.text) : null;
    const config = parsed?.ok ? parsed.config : null;
    const applied = {
      planId: plan.planId,
      commitSha: plan.commitSha,
      branch: plan.branch,
      appliedAt: plan.appliedAt,
    };
    const [applications, postgresRows, mysqlRows, redisRows] =
      await Promise.all([
        this.db
          .select({
            serviceId: application.applicationId,
            configName: application.configName,
            plan: applied,
          })
          .from(application)
          .leftJoin(plan, eq(application.configPlanId, plan.planId))
          .where(eq(application.environmentId, environmentId)),
        this.db
          .select({
            serviceId: postgres.postgresId,
            configName: postgres.configName,
            plan: applied,
          })
          .from(postgres)
          .leftJoin(plan, eq(postgres.configPlanId, plan.planId))
          .where(eq(postgres.environmentId, environmentId)),
        this.db
          .select({
            serviceId: mysql.mysqlId,
            configName: mysql.configName,
            plan: applied,
          })
          .from(mysql)
          .leftJoin(plan, eq(mysql.configPlanId, plan.planId))
          .where(eq(mysql.environmentId, environmentId)),
        this.db
          .select({
            serviceId: redis.redisId,
            configName: redis.configName,
            plan: applied,
          })
          .from(redis)
          .leftJoin(plan, eq(redis.configPlanId, plan.planId))
          .where(eq(redis.environmentId, environmentId)),
      ]);
    const described = (configName: string) => {
      const entry = config?.services[configName];
      return entry !== undefined && entry.managed !== 'console' ? entry : null;
    };
    const owned = (configName: string) =>
      config === null || described(configName) !== null;
    const stated = (configName: string) => {
      if (config === null) return [...ONLY_WHEN_STATED];
      const entry = described(configName);
      return entry ? [...statedFields(entry)] : [];
    };
    const listed = (configName: string) => {
      const entry = described(configName);
      return Object.fromEntries(
        VARIABLE_LISTS.map((list) => [
          list,
          entry ? [...LISTED_NAMES[list](entry)] : [],
        ]),
      ) as Record<VariableList, string[]>;
    };
    return [
      ...applications.map((row) => ({
        ...row,
        serviceType: 'application' as const,
      })),
      ...postgresRows.map((row) => ({
        ...row,
        serviceType: 'postgres' as const,
      })),
      ...mysqlRows.map((row) => ({ ...row, serviceType: 'mysql' as const })),
      ...redisRows.map((row) => ({ ...row, serviceType: 'redis' as const })),
    ]
      .map((row) => ({
        serviceType: row.serviceType,
        serviceId: row.serviceId,
        configName: row.configName,
        owned: owned(row.configName),
        stated: stated(row.configName),
        listed: listed(row.configName),
        appliedFrom: row.plan,
      }))
      .sort((a, b) => a.configName.localeCompare(b.configName));
  }

  /** The Project, on its read entitlement, inside the caller's organization. */
  private async findProject(ctx: PermissionCtx, projectId: string) {
    await this.permissions.checkProjectAccess(ctx, 'read', projectId);
    return this.locations.projectInOrganization(ctx, projectId);
  }

  /** The plan, in this Environment, still open; 404 or 409 otherwise. */
  /** How a refusal names the cloud a Deploy target's Cloud account is in (the Google Cloud spec). */
  private async cloudNameOf(target: DeployTarget): Promise<string> {
    if (target.kind !== 'cloud') return 'AWS';
    const [found] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, target.cloudAccountId));
    return CLOUD_NAMES[cloudOrLegacy(found?.cloud)];
  }

  private async findOpenPlan(environmentId: string, planId: string) {
    const [found] = await this.db
      .select()
      .from(plan)
      .where(
        and(eq(plan.planId, planId), eq(plan.environmentId, environmentId)),
      )
      .limit(1);
    if (!found) throw new NotFoundException('Plan not found');
    if (found.status !== 'open') throw notOpen(found.status);
    return found;
  }
}

/**
 * A text with a setup's entries carried into it, parsed. Each entry parsed
 * once already, in the open plan it came from, so a refusal here is a text
 * the save itself made unreadable around it; it is named by Environment.
 */
function parseOrRefuse(text: string, environmentName: string) {
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) {
    throw inEnvironment(refusedPlan([parsed.refusal]), environmentName);
  }
  return parsed.config;
}
