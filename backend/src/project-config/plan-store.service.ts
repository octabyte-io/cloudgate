import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import { byCloud } from '../cloud-accounts/cloud-provider';
import { BucketDeletes } from '../buckets/bucket-deletes.service';
import { CloudDatabaseDeletes } from '../databases/common/cloud-database-deletes';
import { switchesOf } from '../databases/postgres/database-switches';
import {
  mintAwsBucketName,
  mintBucketName,
  mintGoogleBucketName,
} from '../buckets/bucket-name';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  application,
  cloudAccount,
  compose,
  deployment,
  environment,
  environmentNetwork,
  plan,
  projectConfigLocation,
} from '../db/schema';
import type { Environment, Plan, PlanSource } from '../db/schema';
import { DeploymentsService } from '../deployments/deployments.service';
import { cloudServicesIn } from '../environments/cloud-services-in';
import type { DrizzleTx } from '../environments/config-name';
import type { PermissionCtx } from '../rbac/permission.service';
import { stackVmFinalSnapshotName } from '../cloud-accounts/definitions/stack-vm-final-snapshot';
import {
  pendingSetupsOf,
  setupRecordsOf,
} from '../templates/setup/pending-setups';
import { serviceEntries, withServiceEntries } from './format/config-entries';
import { snapshotDate, snapshotNames } from './rds-postgres-places';
import { stoppedInCloud, withStoppedBlocked } from './stopped-databases';
import { imageHealthChecksOf } from './applier/live-image';
import { PlanApplier, refusedPlan } from './applier/plan-applier';
import { CloudPlanReads } from './cloud-plan-reads.service';
import { outlineOf, outlineOfText } from './planner/config-outline';
import { planEnvironment } from './planner/plan-environment';
import type {
  ConfigOutline,
  DeployTarget,
  PlanNote,
  PlanStep,
} from './planner/plan.types';
import type { ProjectConfig } from './project-config.types';
import { toView } from './project-config.views';
import type {
  HeldBuild,
  PlanView,
  StoppedDeployment,
} from './project-config.views';
import type { ConfigReadResult } from './reader/config-reader.port';
import {
  readSavedServices,
  settingsFingerprint,
  textHash,
} from './saved-settings';

/** One Environment's plan, worked out and not yet stored. */
export interface Planned {
  readonly environmentId: string;
  readonly steps: PlanStep[];
  readonly notes: PlanNote[];
  readonly settingsFingerprint: string;
  /** The Deploy target it was planned for. */
  readonly deployTarget: DeployTarget;
  /** What the planned config listed, which the next plan reads as previous. */
  readonly outline: ConfigOutline;
}

/**
 * What a plan read, as it is stored: a Cloudgate-kept config's text, or a
 * repository copy's commit and branch with no text (ADR-0029).
 */
export interface StoredRead {
  readonly text: string | null;
  readonly textHash: string;
  readonly baseTextHash: string;
  readonly commitSha: string | null;
  readonly branch: string | null;
}

/** A Cloudgate-kept read: the text planned, and the stored text it was planned against. */
export function keptRead(text: string, baseText: string): StoredRead {
  return {
    text,
    textHash: textHash(text),
    baseTextHash: textHash(baseText),
    commitSha: null,
    branch: null,
  };
}

/** A repository read: its commit and branch, and only the hash of its text. */
export function repositoryRead(
  read: Extract<ConfigReadResult, { ok: true }>,
): StoredRead {
  const hash = textHash(read.text);
  return {
    text: null,
    textHash: hash,
    baseTextHash: hash,
    commitSha: read.commitSha,
    branch: read.branch,
  };
}

/**
 * What the config in effect was, for {@link PlanStore.previousOf}: a
 * Cloudgate-kept config's stored text, or a repository-kept one, whose text
 * Cloudgate never keeps.
 */
export type PreviousSource =
  | { readonly kind: 'cloudgate'; readonly text: string | null }
  | { readonly kind: 'repository' };

/** What a plan's config listed: its outline, or its text's for a plan from before outlines. */
function outlineOfPlan(row: Plan): ConfigOutline | null {
  return row.outline ?? (row.text === null ? null : outlineOfText(row.text));
}

/** A cloud bucket create's real name, minted for its Config name and region. */
type CloudBucketNamer = (
  configName: string,
  region: string,
) => NonNullable<Extract<PlanStep, { action: 'create' }>['bucket']>;

/**
 * Each bucket create with its real name, minted here, as the plan is
 * stored, because the planner is pure: the plan shows the name and its
 * Apply makes exactly that one. A plan made again mints again, which is
 * harmless — no name exists until an Apply makes it. A `static` site
 * created on AWS has its own bucket, named the same way. In a Cloud
 * account the name is its cloud's (`inCloud`, chosen by `cloudBucketNamer`).
 */
function withBucketNames(
  steps: readonly PlanStep[],
  inCloud: CloudBucketNamer | null,
): PlanStep[] {
  return steps.map((step) => {
    if (step.action !== 'create') return step;
    const site = step.kind === 'static' && step.site !== undefined;
    if (step.kind !== 'bucket' && !site) return step;
    const { placement } = step;
    if (placement.kind === 'cloud' && inCloud !== null) {
      return { ...step, bucket: inCloud(step.configName, placement.region) };
    }
    if (site) return step;
    return { ...step, bucket: { name: mintBucketName(step.configName) } };
  });
}

/**
 * How a bucket in a Cloud account is named, by its cloud (ADR-0043). On AWS
 * in the account regional namespace of the Cloud account's AWS
 * account and the Deploy target's region, which the plan shows beside it
 * On Google Cloud by the bucket Service's own key, so its id
 * is minted here with the name and kept by its read and its Apply.
 */
function cloudBucketNamer(account: {
  cloud: CloudKind;
  cloudId: string;
}): CloudBucketNamer {
  return byCloud<CloudBucketNamer>(account.cloud, {
    aws: (configName, region) => ({
      name: mintAwsBucketName(configName, account.cloudId, region),
      awsAccountId: account.cloudId,
      region,
    }),
    gcp: () => {
      const serviceId = nanoid();
      return { name: mintGoogleBucketName(serviceId), serviceId };
    },
  });
}

/**
 * Which cloud Services and networks a plan reads for Drift (the AWS spec "When
 * AWS is read"): `everything` on "Check for changes"; otherwise what
 * its steps touch, plus the Services the open plan it replaces found drift
 * on, plus the network when it must be made.
 */
export type PlanReads = 'everything' | 'touched';

/** A plan an operator or a newer plan left standing as what is in effect. */
const SETTLED: Plan['status'][] = ['applied', 'partly-applied', 'unchanged'];

/**
 * Plans as the module makes and keeps them: one Environment's
 * plan of a config, worked out with the config in effect as its previous;
 * stored, replacing the open plan and carrying its held builds; and read
 * back as the API answers it.
 */
@Injectable()
export class PlanStore {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly applier: PlanApplier,
    private readonly deployments: DeploymentsService,
    private readonly cloudReads: CloudPlanReads,
    private readonly bucketDeletes: BucketDeletes,
    private readonly databaseDeletes: CloudDatabaseDeletes,
  ) {}

  /**
   * One Environment's plan of `config`, or a 409 naming why it cannot be
   * planned. A create of an Application whose repository no git provider
   * connection reaches is refused here, before the plan is stored.
   * `preferred` is the repository-kept config's connection, asked first for
   * a hosted source; `null` for a Cloudgate-kept one.
   */
  async planOne(
    ctx: PermissionCtx,
    env: Environment,
    config: ProjectConfig,
    previous: ConfigOutline | null,
    preferred: string | null = null,
    reads: PlanReads = 'touched',
  ): Promise<Planned> {
    const saved = await readSavedServices(this.db, env.environmentId);
    const { deployTarget } = env;
    const rows = await this.db
      .select()
      .from(environmentNetwork)
      .where(eq(environmentNetwork.environmentId, env.environmentId));
    // Every cloud Service holds its network, a Delete under way or
    // incomplete included, which the saved settings leave out.
    const holding = await cloudServicesIn(this.db, env.environmentId);
    // A network whose create failed is made again by the next plan's
    // network step, against its own state. Only a made network is
    // read for Drift.
    const networks = rows
      .filter((row) => row.status !== 'create-failed')
      .map(
        ({
          cloudAccountId,
          region,
          status,
          environmentNetworkId,
          privateLinks,
        }) => ({
          cloudAccountId,
          region,
          ...(status === 'ready' ? { environmentNetworkId } : {}),
          // A Google network's private link; none on AWS.
          ...(privateLinks.length > 0 ? { privateLinks } : {}),
        }),
      );
    const targetAccount = await this.targetAccountOf(deployTarget);
    const pendingSetups = await pendingSetupsOf(this.db, env.environmentId);
    const [location] = await this.db
      .select({ kind: projectConfigLocation.kind })
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, env.projectId));
    const outcome = planEnvironment({
      config,
      saved,
      deployTarget,
      // The kinds a plan may create there are its Cloud account's cloud's.
      cloud: targetAccount?.cloud,
      // Its role's version, which a Stack VM create is refused below (#1366).
      ...(targetAccount
        ? {
            cloudAccount: {
              name: targetAccount.name,
              policyVersion: targetAccount.policyVersion,
            },
          }
        : {}),
      context: { previous },
      networks,
      // One being made or removed is its run's until it ends.
      removableNetworks: rows.filter(
        (row) =>
          row.status !== 'creating' &&
          row.status !== 'deleting' &&
          !holding.some(
            (one) =>
              one.cloudAccountId === row.cloudAccountId &&
              one.region === row.region,
          ),
      ),
      cloudReads: {
        everything: reads === 'everything',
        services: await this.driftedInOpenPlan(env.environmentId),
      },
      // A switch to an existing database whose Service is gone.
      existingCreates: (await switchesOf(this.db, env.environmentId)).flatMap(
        (one) =>
          one.to === 'existing' &&
          one.identifier !== null &&
          !saved.some((found) => found.configName === one.configName)
            ? [
                {
                  configName: one.configName,
                  kind: one.kind,
                  identifier: one.identifier,
                },
              ]
            : [],
      ),
      // A Template's parts waiting here, by name and kind: no values.
      pendingSetups,
      // Their picked Domain hosts taken since setup, refused now (#1373).
      takenHosts: await this.applier.takenTemplateHosts(
        ctx,
        deployTarget,
        pendingSetups.flatMap((setup) =>
          setup.parts.flatMap((part) => part.domains ?? []),
        ),
      ),
      // A Template stack's minimum size, where its Stack VM starts (#1379).
      stackVmStartingSizes: Object.fromEntries(
        pendingSetups.flatMap((setup) =>
          setup.parts.flatMap((part) =>
            part.size === undefined ? [] : [[part.configName, part.size]],
          ),
        ),
      ),
      // The Project's setups, held back here where none was set up (#1377).
      setupRecords: await setupRecordsOf(this.db, env.projectId),
      // A pasted file's part renamed from its setup's is noted (#1378).
      ...(location ? { configKept: location.kind } : {}),
      // A cloud Service's live image whose HEALTHCHECK its cloud may not run.
      imageHealthChecks: await imageHealthChecksOf(
        this.db,
        saved.flatMap((one) =>
          one.serviceType === 'application' && one.cloud ? [one.serviceId] : [],
        ),
      ),
    });
    if (!outcome.ok) throw refusedPlan(outcome.refusals);
    const { refusals } = await this.applier.resolveConnections(
      ctx,
      outcome.steps,
      config,
      saved,
      preferred,
    );
    if (refusals.length > 0) throw refusedPlan(refusals);
    return {
      environmentId: env.environmentId,
      steps: withStoppedBlocked(
        await this.withFinalSnapshots(
          await this.withComposeVolumes(
            await this.withBucketFiles(
              withBucketNames(
                outcome.steps,
                targetAccount ? cloudBucketNamer(targetAccount) : null,
              ),
            ),
          ),
          env.environmentId,
        ),
        await stoppedInCloud(this.db, env.environmentId, new Date()),
      ),
      notes: [...outcome.notes],
      settingsFingerprint: settingsFingerprint(saved, deployTarget),
      deployTarget,
      outline: outlineOf(config),
    };
  }

  /**
   * A cloud Deploy target's Cloud account: its cloud, its own id there
   * (the AWS account id a bucket's name carries), its name and the
   * permissions version its last passing check held it to, else `null`.
   */
  private async targetAccountOf(target: DeployTarget): Promise<{
    cloud: CloudKind;
    cloudId: string;
    name: string;
    policyVersion: number;
  } | null> {
    if (target.kind !== 'cloud') return null;
    const [found] = await this.db
      .select({
        cloud: cloudAccount.cloud,
        cloudId: cloudAccount.cloudId,
        name: cloudAccount.name,
        policyVersion: cloudAccount.policyVersion,
      })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, target.cloudAccountId));
    return found ?? null;
  }

  /**
   * The cloud Services the Environment's open plan found Drift on:
   * a push plan replacing it reads them again, so found drift stays in view.
   */
  private async driftedInOpenPlan(environmentId: string): Promise<string[]> {
    const [open] = await this.db
      .select({ steps: plan.steps })
      .from(plan)
      .where(
        and(eq(plan.environmentId, environmentId), eq(plan.status, 'open')),
      );
    return (open?.steps ?? []).flatMap((step) =>
      step.action === 'change' &&
      step.cloudRead?.status === 'read' &&
      step.cloudRead.drift.length > 0
        ? [step.serviceId]
        : [],
    );
  }

  /**
   * Each destroy of a postgres or a mysql on RDS or a redis on
   * ElastiCache with the
   * final snapshot its Delete keeps unless the Apply ticks "also delete its
   * data": named for today and with about what it costs a month. On
   * Google Cloud, a Cloud SQL or Memorystore destroy's final backup.
   * The Delete names its own when it runs, so this is what the row shows.
   */
  private async withFinalSnapshots(
    steps: PlanStep[],
    environmentId: string,
  ): Promise<PlanStep[]> {
    const read: PlanStep[] = [];
    for (const step of steps) {
      // A stack on a Stack VM keeps a final snapshot of its data disk
      // (#1367), named for today, priced by the planner from the disk.
      if (step.action === 'destroy' && step.stackVm) {
        read.push({
          ...step,
          finalSnapshot: {
            cloud: step.stackVm.cloud,
            name: stackVmFinalSnapshotName(step.stackVm.cloud, {
              ...(await snapshotNames(this.db, environmentId)),
              configName: step.configName,
              date: snapshotDate(new Date()),
            }),
            monthlyUsd: step.stackVm.finalSnapshotMonthlyUsd,
            of: 'data-disk',
          },
        });
        continue;
      }
      if (
        step.action !== 'destroy' ||
        (step.serviceType !== 'postgres' &&
          step.serviceType !== 'mysql' &&
          step.serviceType !== 'redis')
      ) {
        read.push(step);
        continue;
      }
      const target = await this.databaseDeletes.targetOf(
        step.serviceType,
        step.serviceId,
      );
      const preview = target
        ? await this.databaseDeletes.preview(target)
        : null;
      read.push(
        preview
          ? {
              ...step,
              finalSnapshot: {
                cloud: preview.cloud,
                name: preview.name,
                monthlyUsd: preview.monthlyUsd,
              },
            }
          : step,
      );
    }
    return read;
  }

  /**
   * Each bucket destroy with whether the bucket holds files:
   * one cheap read per bucket, the plan's own. The destroy reads it again
   * when it runs, so this is what the row shows, never what the Delete does.
   */
  private async withBucketFiles(steps: PlanStep[]): Promise<PlanStep[]> {
    const read: PlanStep[] = [];
    for (const step of steps) {
      read.push(
        // An existing bucket's files are never read: its Delete
        // leaves it as it was.
        step.action === 'destroy' &&
          step.serviceType === 'bucket' &&
          !step.existing
          ? { ...step, files: await this.bucketDeletes.filesOf(step.serviceId) }
          : step,
      );
    }
    return read;
  }

  /**
   * Each Compose stack destroy with the volumes its Delete removes
   * (ADR-0069), as its last successful deploy recorded them, `null` when
   * none has: the planner reads no compose file, and neither does this.
   */
  private async withComposeVolumes(steps: PlanStep[]): Promise<PlanStep[]> {
    const ids = steps.flatMap((step) =>
      step.action === 'destroy' && step.serviceType === 'compose'
        ? [step.serviceId]
        : [],
    );
    if (ids.length === 0) return steps;
    const rows = await this.db
      .select({
        composeId: compose.composeId,
        deployedVolumes: compose.deployedVolumes,
      })
      .from(compose)
      .where(inArray(compose.composeId, ids));
    const volumes = new Map(
      rows.map((row) => [row.composeId, row.deployedVolumes]),
    );
    return steps.map((step) =>
      step.action === 'destroy' && step.serviceType === 'compose'
        ? { ...step, volumes: volumes.get(step.serviceId) ?? null }
        : step,
    );
  }

  /**
   * A Cloudgate-kept text to plan in this Environment, with the open plan's
   * Template entries carried forward (ADR-0065, amended): a setup's entries
   * live only in its open plan's text until Apply, so a newer plan made from
   * the stored text (Check for changes, another save, an Agent's
   * `request_plan`, a stopped Service's deploy) would otherwise drop them and
   * leave the Pending setup with nothing to create. An entry is carried when
   * a Pending setup here still holds its Config name, the open plan's text
   * lists it and `text` does not. Every other line is `text`'s.
   */
  async withPendingEntries(
    environmentId: string,
    text: string,
  ): Promise<string> {
    const names = (await pendingSetupsOf(this.db, environmentId)).flatMap(
      (setup) => setup.parts.map((part) => part.configName),
    );
    if (names.length === 0) return text;
    const [open] = await this.db
      .select({ text: plan.text })
      .from(plan)
      .where(
        and(eq(plan.environmentId, environmentId), eq(plan.status, 'open')),
      )
      .limit(1);
    if (!open?.text) return text;
    const listed = serviceEntries(text);
    const held = serviceEntries(open.text);
    const carried = new Map(
      names.flatMap((name) => {
        const node = held.get(name);
        return node && !listed.has(name) ? [[name, node] as const] : [];
      }),
    );
    return withServiceEntries(text, carried);
  }

  /**
   * What the config in effect in this Environment listed: its plan's
   * `previous` (US33, US34), so that only a Service that config *described*
   * is destroyed when a new one does not list it, and a `managed: console`
   * line it already had is not checked again.
   *
   * - A Cloudgate-kept config's is its stored text: what was last applied
   *   or saved.
   * - A repository-kept config's is the outline of the Environment's last
   *   settled plan — applied, partly applied, or with nothing to change —
   *   which is what the file said when the Environment last agreed with it.
   *   A plan that was dismissed, replaced or left open changed nothing, so
   *   it is not what is in effect. With none, nothing is known (`null`), so
   *   nothing unlisted is destroyed.
   *
   * Either way, a destroy that plan's Apply could not make (its Delete
   * refused) is still the config's to make (US28): that Service counts as
   * described, so the next plan picks the destroy up again. And a
   * `managed: console` line the Environment's newest plan took — open,
   * replaced or settled — counts as listed, since a stored plan was never
   * refused: a line in a move's still-open plan is not "added" again by the
   * next push, and its Service is never destroyed by dropping it.
   */
  async previousOf(
    environmentId: string,
    source: PreviousSource,
  ): Promise<ConfigOutline | null> {
    const latest = (statuses?: Plan['status'][]) =>
      this.db
        .select()
        .from(plan)
        .where(
          and(
            eq(plan.environmentId, environmentId),
            statuses ? inArray(plan.status, statuses) : undefined,
          ),
        )
        .orderBy(desc(plan.createdAt), desc(plan.planId))
        .limit(1);
    const [[settled], [newest]] = await Promise.all([
      latest(SETTLED),
      latest(),
    ]);
    const base =
      source.kind === 'cloudgate'
        ? source.text === null
          ? null
          : outlineOfText(source.text)
        : settled
          ? outlineOfPlan(settled)
          : null;
    const services: Record<string, ConfigOutline['services'][string]> = {
      ...(base?.services ?? {}),
    };
    // A destroy the settled plan's Apply could not make is still the
    // config's to make (US28).
    for (const result of settled?.results ?? []) {
      if (result.action !== 'destroy' || result.status !== 'failed') continue;
      if (Object.hasOwn(services, result.configName)) continue;
      const step = settled?.steps.find(
        (one): one is Extract<PlanStep, { action: 'destroy' }> =>
          one.action === 'destroy' && one.configName === result.configName,
      );
      if (step)
        services[result.configName] = { kind: step.kind, managed: false };
    }
    // A `managed: console` line the newest plan took, open or not, was
    // checked then (a stored plan was never refused), and it changes
    // nothing, so it is not checked again; and a Service it lists that way
    // is never destroyed by dropping the line (US34).
    const newestOutline = newest ? outlineOfPlan(newest) : null;
    for (const [name, entry] of Object.entries(newestOutline?.services ?? {})) {
      if (entry.managed === 'console') services[name] = entry;
    }
    if (base === null && Object.keys(services).length === 0) return null;
    return { services };
  }

  /**
   * Stores a plan, replacing the Environment's open one: `superseded` by a
   * newer plan, or `dismissed` by `by` when a move replaces it. `by` is who
   * asked, `null` for a push.
   *
   * **Held builds.** A build the replaced plan held moves to the new
   * plan when that one is open and still changes the build's Application:
   * the reason it waits is still there, and an Apply of the new plan is what
   * gives it its settings. Any other is released by the caller's
   * {@link releaseHeld} once this transaction commits, with the settings
   * there are then.
   */
  async store(
    tx: DrizzleTx,
    by: string | null,
    planned: Planned,
    read: StoredRead,
    {
      source = 'request',
      replacedAs = 'superseded',
    }: { source?: PlanSource; replacedAs?: 'superseded' | 'dismissed' } = {},
  ): Promise<Plan> {
    const { environmentId } = planned;
    // One plan made at a time per Environment, so the open one replaced is
    // the one there is, and the partial unique index never fires on a race.
    await tx
      .select({ environmentId: environment.environmentId })
      .from(environment)
      .where(eq(environment.environmentId, environmentId))
      .for('update');
    const now = new Date().toISOString();
    const replaced = await tx
      .update(plan)
      .set(
        replacedAs === 'dismissed'
          ? { status: 'dismissed', dismissedBy: by, dismissedAt: now }
          : { status: 'superseded', dismissedAt: now },
      )
      .where(
        and(eq(plan.environmentId, environmentId), eq(plan.status, 'open')),
      )
      .returning({ planId: plan.planId });
    const [created] = await tx
      .insert(plan)
      .values({
        environmentId,
        source,
        text: read.text,
        textHash: read.textHash,
        baseTextHash: read.baseTextHash,
        commitSha: read.commitSha,
        branch: read.branch,
        settingsFingerprint: planned.settingsFingerprint,
        deployTarget: planned.deployTarget,
        steps: planned.steps,
        notes: planned.notes,
        outline: planned.outline,
        status: planned.steps.length > 0 ? 'open' : 'unchanged',
        requestedBy: by,
        createdAt: now,
      })
      .returning();
    const changed = planned.steps.flatMap((step) =>
      step.action === 'change' ? [step.serviceId] : [],
    );
    if (
      replacedAs === 'superseded' &&
      replaced.length > 0 &&
      created.status === 'open' &&
      changed.length > 0
    ) {
      await tx
        .update(deployment)
        .set({ heldByPlanId: created.planId })
        .where(
          and(
            inArray(
              deployment.heldByPlanId,
              replaced.map((one) => one.planId),
            ),
            eq(deployment.status, 'held'),
            inArray(deployment.applicationId, changed),
          ),
        );
    }
    return created;
  }

  async view(row: Plan): Promise<PlanView> {
    const [view] = await this.views([row]);
    return view;
  }

  async views(rows: readonly Plan[]): Promise<PlanView[]> {
    const planIds = rows.map((row) => row.planId);
    const [held, stopped] = await Promise.all([
      this.heldBuildsByPlan(planIds),
      this.stoppedDeploymentsByPlan(planIds),
    ]);
    return rows.map((row) =>
      toView(row, held.get(row.planId) ?? [], stopped.get(row.planId) ?? null),
    );
  }

  /** The deploy each plan was opened for, by plan. */
  private async stoppedDeploymentsByPlan(
    planIds: readonly string[],
  ): Promise<Map<string, StoppedDeployment>> {
    const byPlan = new Map<string, StoppedDeployment>();
    if (planIds.length === 0) return byPlan;
    const rows = await this.db
      .select({
        planId: deployment.reviewPlanId,
        deploymentId: deployment.deploymentId,
        applicationId: application.applicationId,
        configName: application.configName,
        appName: application.appName,
        title: deployment.title,
        status: deployment.status,
        createdAt: deployment.createdAt,
      })
      .from(deployment)
      .innerJoin(
        application,
        eq(deployment.applicationId, application.applicationId),
      )
      .where(inArray(deployment.reviewPlanId, [...planIds]))
      .orderBy(deployment.createdAt, deployment.deploymentId);
    for (const { planId, configName, appName, ...stopped } of rows) {
      if (planId === null) continue;
      byPlan.set(planId, { ...stopped, configName: configName ?? appName });
    }
    return byPlan;
  }

  /** Each Application's build the plan still holds, by Application. */
  async heldBuildsOf(planId: string): Promise<Map<string, string>> {
    const held = (await this.heldBuildsByPlan([planId])).get(planId) ?? [];
    return new Map(
      held
        .filter((build) => build.status === 'held')
        .map((build) => [build.applicationId, build.deploymentId]),
    );
  }

  /**
   * Releases the held builds whose plan stopped being open: after
   * every plan transition, once its transaction committed, so a build queues
   * only for a plan that is settled. A new open plan's cloud steps are read
   * from AWS from here too, in the Cloud run pool: asked for now,
   * written on the plan when each read ends.
   */
  async releaseHeld(environmentIds: readonly string[]) {
    for (const environmentId of new Set(environmentIds)) {
      await this.deployments.releaseHeldOutsideOpenPlans(environmentId);
    }
    await this.cloudReads.readOpenPlans(environmentIds);
  }

  /** The builds each plan holds or held, oldest first. */
  private async heldBuildsByPlan(
    planIds: readonly string[],
  ): Promise<Map<string, HeldBuild[]>> {
    const byPlan = new Map<string, HeldBuild[]>();
    if (planIds.length === 0) return byPlan;
    const rows = await this.db
      .select({
        planId: deployment.heldByPlanId,
        deploymentId: deployment.deploymentId,
        applicationId: application.applicationId,
        configName: application.configName,
        title: deployment.title,
        description: deployment.description,
        status: deployment.status,
        createdAt: deployment.createdAt,
      })
      .from(deployment)
      .innerJoin(
        application,
        eq(deployment.applicationId, application.applicationId),
      )
      .where(inArray(deployment.heldByPlanId, [...planIds]))
      .orderBy(deployment.createdAt, deployment.deploymentId);
    for (const { planId, ...held } of rows) {
      if (planId === null) continue;
      byPlan.set(planId, [...(byPlan.get(planId) ?? []), held]);
    }
    return byPlan;
  }
}
