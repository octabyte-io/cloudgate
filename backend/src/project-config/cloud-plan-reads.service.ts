import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, eq, inArray } from 'drizzle-orm';

import { ApplicationsService } from '../applications/applications.service';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../cloud-accounts/cloud-provider';
import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { credentialOf } from '../cloud-accounts/cloud-provider';
import { InfrastructureStatesService } from '../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { bucket, compose, environmentNetwork, plan, redis } from '../db/schema';
import type { Plan } from '../db/schema';
import { CloudReadWorks } from '../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunEnding,
} from '../deployment-queue/cloud-run-job.types';
import { CloudRunsService } from '../deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../deployments/deployments.service';
import { AwsPlanReads } from './aws-plan-reads.service';
import { GooglePlanReads } from './google-plan-reads.service';
import type {
  Change,
  CloudStep,
  Create,
  KeptIds,
  StepReadOptions,
} from './cloud-step-reader';
import { failed } from './cloud-step-reader';
import { onCloud } from '../cloud-accounts/cloud-provider';
import { readExistingBucket } from './existing-bucket-reads';
import type { GoogleExistingBucket } from './existing-bucket-reads';
import { addressMovePatch, movedLinkers } from './existing-database-address';
import { readExistingDatabase } from './existing-database-reads';
import type {
  GoogleExisting,
  GoogleExistingCache,
} from './existing-database-reads';
import { findRdsRow } from '../databases/common/rds-rows';
import { describeError } from '../common/describe-error';
import { cloudReadOf, cloudStepName, isQuietRead } from './planner/cloud-steps';
import type { CloudRead, PlanStep } from './planner/plan.types';

/** What a read's run answers: the read, and which step asked for it. */
interface ReadDone {
  readonly asked: string;
  readonly read: CloudRead;
}

/**
 * The real name of each bucket a plan's steps create in a Cloud account
 * by Config name.
 */
function plannedBuckets(steps: readonly PlanStep[]): Map<string, string> {
  return new Map(
    steps.flatMap((step) =>
      step.action === 'create' &&
      step.kind === 'bucket' &&
      step.placement.kind === 'cloud' &&
      step.bucket
        ? [[step.configName, step.bucket.name] as const]
        : [],
    ),
  );
}

/**
 * Plans that read a cloud (the AWS spec "Plan behaviour"; the Google Cloud
 * spec). The planner is pure and synchronous, so a plan is stored with each
 * cloud step `reading`; once the plan's transaction has committed, each such
 * step is read here.
 *
 * **A read is a Cloud run.** It waits in the Cloud run pool behind any
 * waiting deploy and takes its state's lock, so a read never runs
 * beside a deploy of the same state. What it reads is its cloud's half's
 * (ADR-0043): `AwsPlanReads` or `GooglePlanReads`, both a
 * `CloudStepReader`, picked by the step's Cloud account's cloud. A change
 * to a postgres on RDS or a redis on ElastiCache is AWS's only; an Existing
 * database's and an existing bucket's lookups pick their cloud's half
 * themselves (`readExistingDatabase`, `readExistingBucket`), Google's being
 * a Cloud SQL postgres's and a Cloud Storage bucket's.
 *
 * **A late read writes nothing.** Each step is patched by plan id and index,
 * and only while that plan is still open and the step still `reading`: a
 * plan a newer one superseded, or one dismissed, keeps what it had. A read
 * cut off by a shutdown leaves its step `reading`, and start-up reads the
 * open plans' `reading` steps again. Once a plan's last read is written, a
 * plan whose every step turned out to have nothing to do is `unchanged`: a
 * plan is unchanged only when neither the config nor AWS differs.
 */
@Injectable()
export class CloudPlanReads implements OnApplicationBootstrap {
  private readonly logger = new Logger(CloudPlanReads.name);
  /** `planId:index` of each read asked for and not yet written. */
  private readonly inFlight = new Set<string>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly states: InfrastructureStatesService,
    private readonly applications: ApplicationsService,
    private readonly deployments: DeploymentsService,
    private readonly moduleRef: ModuleRef,
    private readonly awsReads: AwsPlanReads,
    private readonly googleReads: GooglePlanReads,
  ) {}

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  private get works(): CloudReadWorks {
    return this.moduleRef.get(CloudReadWorks, { strict: false });
  }

  /** Start-up: the open plans' steps still `reading` are read again. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const open = await this.db
        .select()
        .from(plan)
        .where(eq(plan.status, 'open'));
      for (const row of open) this.readPlan(row);
    } catch (error) {
      // Tolerant of an un-migrated database, like every boot hook.
      this.logger.error(
        `Plans could not be read from their Cloud accounts at start-up: ${describeError(error)}`,
      );
    }
  }

  /**
   * After a plan transition committed: each Environment's open plan has its
   * `reading` steps read. Returns once they are asked for, not once read.
   */
  async readOpenPlans(environmentIds: readonly string[]): Promise<void> {
    if (environmentIds.length === 0) return;
    const open = await this.db
      .select()
      .from(plan)
      .where(
        and(
          inArray(plan.environmentId, [...new Set(environmentIds)]),
          eq(plan.status, 'open'),
        ),
      );
    for (const row of open) this.readPlan(row);
  }

  private readPlan(row: Plan): void {
    const first = row.steps.findIndex((step) => cloudReadOf(step) !== null);
    row.steps.forEach((step, index) => {
      if (cloudReadOf(step)?.status !== 'reading') return;
      const key = `${row.planId}:${index}`;
      if (this.inFlight.has(key)) return;
      this.inFlight.add(key);
      void this.readStep(row, index, step as CloudStep, index === first)
        .catch((error: unknown) =>
          this.logger.error(
            `Plan ${row.planId}: ${cloudStepName(step)} could not be read from its Cloud account: ${describeError(error)}`,
          ),
        )
        .finally(() => this.inFlight.delete(key));
    });
  }

  private async readStep(
    row: Plan,
    index: number,
    step: CloudStep,
    notesStrays: boolean,
  ): Promise<void> {
    const asked = `${row.planId}:${index}`;
    // A read of what exists takes its state's lock, so it never runs beside
    // that state's deploy; a create's plans a state no run has written yet.
    const stateKey =
      step.action === 'change'
        ? `${stateOwnerKind(step.serviceType)}:${step.serviceId}`
        : step.action === 'network-change'
          ? `network:${step.environmentNetworkId}`
          : `plan:${asked}`;
    // A read of the same state already running answers what another plan's
    // step asked of it; this step's own is then asked again, once.
    for (let attempt = 0; attempt < 2; attempt++) {
      this.works.register(stateKey, async (control) => ({
        asked,
        read: await this.read(row.environmentId, step, control, {
          notesStrays,
          creates: createdKinds(row.steps),
          plannedBuckets: plannedBuckets(row.steps),
        }),
      }));
      const ending = await this.cloudRuns.read({
        stateKey,
        environmentId: row.environmentId,
        touchesNetwork: false,
      });
      // Cut off by a shutdown: left `reading`, for start-up to read again.
      if (ending.kind === 'shutdown') return;
      const done =
        ending.kind === 'finished' ? (ending.value as ReadDone) : null;
      if (done && done.asked !== asked && attempt === 0) continue;
      await this.write(row, index, done ? done.read : settled(ending));
      return;
    }
  }

  /**
   * One step's read, run by the pool: the credential, the tag search, the
   * definition, the `tofu plan`, the plan reader's lines. Every refusal is
   * the step's `failed` reason; only a fault of Cloudgate's own throws.
   */
  private async read(
    environmentId: string,
    step: CloudStep,
    control: CloudRunControl,
    options: Omit<StepReadOptions, 'unfinishedNetworkState'>,
  ): Promise<CloudRead> {
    if (step.action === 'change' && step.existing) {
      const looked = { ...step, existing: step.existing };
      const deps = {
        db: this.db,
        states: this.states,
        findAccount: (id: string) => this.cloudAccounts.findForUse(id),
        credentialRefusal: (account: AwsCloudAccount) =>
          this.awsReads.credentialRefusal(account, credentialOf(account)),
        // An existing Cloud SQL postgres or mysql on Google Cloud.
        readGoogle: (account: GcpCloudAccount, existing: GoogleExisting) =>
          this.googleReads.readExistingCloudSql(
            account,
            existing,
            looked,
            control,
          ),
        // An existing Memorystore for Valkey redis.
        readGoogleRedis: (
          account: GcpCloudAccount,
          existing: GoogleExistingCache,
        ) =>
          this.googleReads.readExistingRedis(
            account,
            existing,
            looked,
            control,
          ),
        // An existing Cloud Storage bucket.
        readGoogleBucket: (
          account: GcpCloudAccount,
          existing: GoogleExistingBucket,
        ) =>
          this.googleReads.readExistingBucket(account, existing, step, control),
      };
      // An existing bucket's lookup, or an Existing database's.
      if (step.serviceType === 'bucket') {
        return readExistingBucket(deps, step, control.signal);
      }
      return readExistingDatabase(deps, looked, control.signal);
    }
    if (step.action === 'change' && step.database) {
      return this.awsReads.readPostgresChange(
        { ...step, database: step.database },
        control,
      );
    }
    if (step.action === 'change' && step.cache) {
      return this.awsReads.readRedisChange(
        { ...step, cache: step.cache },
        control,
      );
    }
    const place =
      step.action === 'network-create' || step.action === 'network-change'
        ? { cloudAccountId: step.cloudAccountId, region: step.region }
        : step.action === 'change'
          ? step.serviceType === 'bucket'
            ? await this.bucketPlaceOf(step.serviceId)
            : step.serviceType === 'postgres' || step.serviceType === 'mysql'
              ? await this.rdsPlaceOf(step.serviceType, step.serviceId)
              : step.serviceType === 'redis'
                ? await this.redisPlaceOf(step.serviceId)
                : step.serviceType === 'compose'
                  ? await this.composePlaceOf(step.serviceId)
                  : await this.placeOf(step.serviceId)
          : step.placement.kind === 'cloud'
            ? step.placement
            : null;
    if (place === null) {
      return failed(`${cloudStepName(step)} is not in a Cloud account`);
    }
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      place.cloudAccountId,
    );
    if (!cloudAccountRow) {
      return failed(
        'The Cloud account this plan was made for is gone. Choose a Deploy target, then Check for changes',
      );
    }
    // Each cloud's reads are its own half's (ADR-0043): AWS's, or Google's
    // (the Google Cloud spec).
    const where = { environmentId, region: place.region };
    const readOptions = {
      ...options,
      unfinishedNetworkState:
        step.action === 'network-create'
          ? await this.unfinishedNetworkState(
              environmentId,
              cloudAccountRow.cloudAccountId,
              place.region,
            )
          : null,
    };
    return onCloud(cloudAccountRow, {
      aws: (account) =>
        this.awsReads.read(account, where, step, control, readOptions),
      gcp: (account) =>
        this.googleReads.read(account, where, step, control, readOptions),
    });
  }

  /**
   * Where a postgres or a mysql in a Cloud account is, or
   * `null` for one on a Server.
   */
  private async rdsPlaceOf(
    kind: 'postgres' | 'mysql',
    id: string,
  ): Promise<{ cloudAccountId: string; region: string } | null> {
    const found = await findRdsRow(this.db, kind, id);
    return found?.cloudAccountId && found.region
      ? { cloudAccountId: found.cloudAccountId, region: found.region }
      : null;
  }

  /** Where a redis in a Cloud account is, or `null` for one on a Server. */
  private async redisPlaceOf(
    redisId: string,
  ): Promise<{ cloudAccountId: string; region: string } | null> {
    const [found] = await this.db
      .select({ cloudAccountId: redis.cloudAccountId, region: redis.region })
      .from(redis)
      .where(eq(redis.redisId, redisId));
    return found?.cloudAccountId && found.region
      ? { cloudAccountId: found.cloudAccountId, region: found.region }
      : null;
  }

  /** Where a stack on its Stack VM is, or `null` for one on a Server. */
  private async composePlaceOf(
    composeId: string,
  ): Promise<{ cloudAccountId: string; region: string } | null> {
    const [found] = await this.db
      .select({
        cloudAccountId: compose.cloudAccountId,
        region: compose.region,
      })
      .from(compose)
      .where(eq(compose.composeId, composeId));
    return found?.cloudAccountId && found.region
      ? { cloudAccountId: found.cloudAccountId, region: found.region }
      : null;
  }

  /** Where a bucket on AWS is, or `null` for one on a Server. */
  private async bucketPlaceOf(
    bucketId: string,
  ): Promise<{ cloudAccountId: string; region: string } | null> {
    const [found] = await this.db
      .select({
        cloudAccountId: bucket.cloudAccountId,
        region: bucket.region,
      })
      .from(bucket)
      .where(eq(bucket.bucketId, bucketId));
    return found?.cloudAccountId && found.region
      ? { cloudAccountId: found.cloudAccountId, region: found.region }
      : null;
  }

  /** Where a cloud Service runs, or `null` for one on a Server. */
  private async placeOf(
    applicationId: string,
  ): Promise<{ cloudAccountId: string; region: string } | null> {
    const app = await this.applications.findDeployable(applicationId);
    return app.cloudAccountId && app.region
      ? { cloudAccountId: app.cloudAccountId, region: app.region }
      : null;
  }

  /**
   * A cloud create's step read again by its Apply, once the Environment
   * network it needed is made: with the network's
   * saved ids in place of the stand-ins, and the state and Service ids the
   * plan was read with. A Cloud run like any read, in the pool, so it waits
   * behind the network run and every deploy before it. `steps` are its
   * plan's, whose bucket creates are not made yet either.
   */
  async reread(
    environmentId: string,
    stateKey: string,
    step: Create,
    steps: readonly PlanStep[],
  ): Promise<CloudRead> {
    if (
      !step.cloud &&
      !step.database &&
      !step.cache &&
      !step.cloudSql &&
      !step.memorystore &&
      // A Stack VM create (ADR-0070), described or a Template's (#1379).
      !step.stackVm
    ) {
      return failed(`${step.configName} reads no cloud`);
    }
    const shown = step.cloudRead?.status === 'read' ? step.cloudRead : null;
    const kept: KeptIds = shown
      ? { stateId: shown.stateId, serviceId: shown.serviceId }
      : {};
    this.works.register(stateKey, async (control) => ({
      asked: stateKey,
      read: await this.read(environmentId, step as CloudStep, control, {
        notesStrays: false,
        plannedBuckets: plannedBuckets(steps),
        kept,
      }),
    }));
    const ending = await this.cloudRuns.read({
      stateKey,
      environmentId,
      touchesNetwork: false,
    });
    if (ending.kind === 'shutdown') {
      return failed('Cloudgate shut down while AWS was read again');
    }
    return ending.kind === 'finished'
      ? (ending.value as ReadDone).read
      : settled(ending);
  }

  /**
   * The state of a network this Environment has in that place whose create
   * did not finish, or `null`: none, or one that is made.
   */
  private async unfinishedNetworkState(
    environmentId: string,
    cloudAccountId: string,
    region: string,
  ): Promise<string | null> {
    const [network] = await this.db
      .select({
        environmentNetworkId: environmentNetwork.environmentNetworkId,
      })
      .from(environmentNetwork)
      .where(
        and(
          eq(environmentNetwork.environmentId, environmentId),
          eq(environmentNetwork.cloudAccountId, cloudAccountId),
          eq(environmentNetwork.region, region),
          eq(environmentNetwork.status, 'create-failed'),
        ),
      );
    if (!network) return null;
    const state = await this.states.findForNetwork(
      network.environmentNetworkId,
    );
    return state?.infrastructureStateId ?? null;
  }

  /**
   * The read written on its step, only while the plan is open and the step
   * still `reading`, in one transaction holding the plan's row, so two steps
   * of one plan finishing together never write over each other. The plan's
   * last read settles it `unchanged` in the same statement when nothing in it
   * turned out to differ, so no reader ever sees it `open` with every read
   * landed — a no-op plan someone could Apply — between the two.
   *
   * An Existing database's lookup that found it at a new address also
   * writes what the move redeploys (`addressMovePatch`) there, so a second
   * move landing at the same time adds to these steps rather than beside
   * them.
   */
  private async write(
    row: Plan,
    index: number,
    read: CloudRead,
  ): Promise<void> {
    const moved = read.status === 'read' ? read.addressMoved : undefined;
    const step = row.steps[index];
    if (moved && step?.action !== 'change') return;
    // Read before the row is held: the Services the move redeploys.
    const linkers =
      moved && step?.action === 'change'
        ? await movedLinkers(this.db, row.environmentId, step.configName, moved)
        : undefined;
    const settled = await this.db.transaction(async (tx) => {
      const [held] = await tx
        .select()
        .from(plan)
        .where(and(eq(plan.planId, row.planId), eq(plan.status, 'open')))
        .for('update');
      const at = held?.steps[index];
      if (!held || !at || cloudReadOf(at)?.status !== 'reading') return false;
      const patch = linkers
        ? addressMovePatch(held.steps, linkers, held.outline)
        : undefined;
      const steps: PlanStep[] = [
        ...held.steps.map((one, i) => {
          if (i === index) return { ...one, cloudRead: read } as PlanStep;
          const because = patch?.because.get(i);
          return because ? ({ ...one, because } as PlanStep) : one;
        }),
        ...(patch?.append ?? []),
      ];
      const unchanged = steps.every(isQuietRead);
      await tx
        .update(plan)
        .set({ steps, ...(unchanged && { status: 'unchanged' as const }) })
        .where(eq(plan.planId, row.planId));
      return unchanged;
    });
    // What the plan held now builds with the settings there are.
    if (settled) {
      await this.deployments.releaseHeldOutsideOpenPlans(row.environmentId);
    }
  }
}

/** The kind of each Service a plan's steps create, by Config name. */
function createdKinds(steps: readonly PlanStep[]): Record<string, string> {
  return Object.fromEntries(
    steps.flatMap((step) =>
      step.action === 'create' ? [[step.configName, step.kind]] : [],
    ),
  );
}

/**
 * The kind of owner a cloud Service's state lock is named after: a stack
 * on its Stack VM's as its Cloud runs name it (#1368).
 */
function stateOwnerKind(serviceType: Change['serviceType']): string {
  switch (serviceType) {
    case 'postgres':
    case 'mysql':
    case 'redis':
    case 'bucket':
    case 'compose':
      return serviceType;
    default:
      return 'application';
  }
}

/** The step's read, from how its run in the pool ended. */
function settled(ending: CloudRunEnding): CloudRead {
  switch (ending.kind) {
    case 'finished':
      return (ending.value as ReadDone).read;
    case 'failed':
      return failed(ending.message);
    case 'stopped':
      return failed(`The read was stopped by ${ending.by}`);
    case 'timed-out':
      return failed(
        `The read was ended by the Cloud run time limit of ${ending.minutes} minutes`,
      );
    default:
      return failed('The read was cancelled');
  }
}
