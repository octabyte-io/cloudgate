import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, or } from 'drizzle-orm';

import type {
  Application,
  ServiceCloudDeleteRecord,
  ServiceLeftover,
} from '../applications/application.schema';
import { CloudServiceDeletes } from '../applications/cloud-delete';
import type { CloudDeleteTarget } from '../applications/cloud-delete';
import { CLOUD_DELETE_REFUSED_CODE } from '../applications/cloud-delete-refusal';
import type { CloudBucketKept } from '../buckets/bucket-files';
import type { Bucket } from '../buckets/bucket.schema';
import { CloudBucketDeletes } from '../buckets/cloud-bucket-deletes.service';
import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import {
  CLOUD_NAMES,
  cloudOrLegacy,
  googleAccountOf,
  LEGACY_CLOUD,
} from '../cloud-accounts/cloud-provider';
import { findGoogleLabelLeftovers } from '../cloud-accounts/gcp/delete-check';
import { GOOGLE_CLOUD_PORT } from '../cloud-accounts/google-cloud.port';
import type { GoogleCloudPort } from '../cloud-accounts/google-cloud.port';
import { CloudDatabaseDeletes } from '../databases/common/cloud-database-deletes';
import { byCloud } from '../cloud-accounts/cloud-provider';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  application,
  bucket,
  domain,
  environment,
  environmentNetwork,
  infrastructureState,
  mysql,
  postgres,
  redis,
} from '../db/schema';
import type { EnvironmentNetwork } from '../db/schema';
import type { CloudRunEnding } from '../deployment-queue/cloud-run-job.types';
import { endingDescription } from '../deployment-queue/cloud-runs.service';
import { environmentNetworkName } from '../deployments/service-scope';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import type {
  EnvironmentCloudDeletesPort,
  FinishEnvironmentDelete,
  StartedEnvironmentDelete,
} from '../environments/environment-cloud-deletes.port';
import type {
  Environment,
  EnvironmentDeleteRecord,
  EnvironmentLeftover,
} from '../environments/environment.schema';
import { environmentDnsRecords } from '../environments/network-dns-records';
import { subnetHoldOf } from '../environments/subnet-hold';
import type { PermissionCtx } from '../rbac/permission.service';
import { EnvironmentNetworkRemovals } from './applier/environment-network-removals.service';
import { GoogleDomainRuns } from './applier/google-domain-runs.service';
import { KEEP_NOTHING } from './console-saves';
import { describeError } from '../common/describe-error';
import type { CloudKind } from '../cloud-accounts/cloud-account.schema';

/** Forget's warning, which the console shows before it is pressed. */
export const ENVIRONMENT_FORGET_WARNING =
  'Forget drops this Environment from Cloudgate and keeps no record of what is left but the audit log. What is left may still bill you in AWS until you remove it there.';

/** {@link ENVIRONMENT_FORGET_WARNING}, for an Environment on Google Cloud. */
export const GOOGLE_ENVIRONMENT_FORGET_WARNING =
  'Forget drops this Environment from Cloudgate and keeps no record of what is left but the audit log. What is left may still bill you in Google Cloud until you remove it there.';

/**
 * One step of an Environment's Delete, in the order
 * {@link EnvironmentCloudDeletes} runs them: it answers whether the Delete
 * goes on, having written the Environment `incomplete` when it does not.
 */
type DeleteStep = (running: RunningDelete) => Promise<boolean>;

/** What every step of one Delete's run shares. */
interface RunningDelete {
  readonly ctx: PermissionCtx;
  readonly environmentId: string;
  /** The run is one of Cloudgate's own tries at Google's subnet hold (S13). */
  readonly byCloudgate: boolean;
  /** The buckets on AWS the request started. */
  readonly buckets: StartedBuckets;
}

/** Said of a Delete a restart cut off: nothing runs it any more. */
const CUT_OFF =
  'The Delete was cut off by a Cloudgate restart before it finished';

/**
 * **An Environment's Delete in a Cloud account** (the AWS spec "Delete",
 * ADR-0038): it leaves nothing billable behind in AWS, or names
 * exactly what it left.
 *
 * 1. The request refuses while any part is busy (a Service's own Delete
 *    running, a network being made or removed) or a Cloud account cannot
 *    be reached — removing nothing — then marks the row `deleting` and
 *    answers with the DNS records its Domains will leave behind.
 * 2. Each cloud Service is deleted through its own Delete — Retry
 *    for one already incomplete — and the Delete waits for them all. So is
 *    each bucket on AWS, never asked to delete its files: one that
 *    holds files is kept and named at once in the answer, with its account
 *    and region, and an empty one goes by its own destroy-only run. So is
 *    each postgres on RDS and redis on ElastiCache, which always
 *    keeps its final snapshot: an Environment's Delete never asks for a
 *    database's data to go.
 * 3. Only when none is left is each Environment network removed, in its
 *    own destroy-only run recorded as a Deployment of the network: AWS
 *    will not delete a VPC whose security groups a Service still holds.
 * 4. Then the rest goes as an Environment's Delete always went (its
 *    Services on a Server, then the row), and the audit log records it.
 *
 * **On Google Cloud** (the Google Cloud spec, "Delete") one step
 * comes first: one network run takes every Domain off each Google network
 * (its host rules, certificates, map entries and DNS authorizations), so
 * each Service's Delete skips its own network step. The network goes last,
 * its private link with it. Google holds a used subnet 1–2 hours after its
 * services are gone, so the first Delete usually ends
 * `incomplete` naming the subnet and network and when Cloudgate tries
 * again by itself, which `SubnetHoldRetries` does: a Retry of this Delete
 * {@link byCloudgate}, about 2 hours and again about 4 hours after (S13).
 *
 * The steps are {@link steps}, in order. On Google Cloud the databases go
 * with the Services, before any network; the private link goes with its
 * network; and once every network is gone a **label search** (the Google Cloud databases spec)
 * looks in each Google project for anything still carrying the
 * Environment's label — such as a Private Service Connect address Google
 * still lists as `CLOSED` — and names each by type, Google id, region and
 * label. Anything found, or a search Google refused, keeps the Environment
 * `incomplete`, as any leftover does.
 *
 * Anything left at any step keeps the Environment — and the Service and
 * network rows and their states — `incomplete`, listing each leftover with
 * whose it is, until **Retry** (the same steps again, from the kept states)
 * or **Forget** (every row dropped, the list written into the audit entry).
 * Both need `environment: delete`, as the Delete does.
 *
 * The steps run in this process; a restart part-way leaves the Delete
 * `incomplete`, saying so, for Retry or Forget — each run it started is its
 * own Deployment, which the pool's start-up rules settle.
 */
@Injectable()
export class EnvironmentCloudDeletes implements EnvironmentCloudDeletesPort {
  private readonly logger = new Logger(EnvironmentCloudDeletes.name);
  /** The Environments whose Delete this process is running. */
  private readonly running = new Set<string>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly serviceDeletes: CloudServiceDeletes,
    private readonly bucketDeletes: CloudBucketDeletes,
    private readonly databaseDeletes: CloudDatabaseDeletes,
    private readonly removals: EnvironmentNetworkRemovals,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly auditLogs: AuditLogService,
    private readonly googleDomainRuns: GoogleDomainRuns,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
  ) {}

  /**
   * The Delete's steps, in order: the Domains off each Google
   * network; the Services, buckets and databases, each by its own Delete,
   * so every database and its own address is gone before any network; the
   * networks, each with its private link (its policies, subnet and Redis
   * firewall rule are in the network's state, so they go with it, Google's
   * subnet hold retried by Cloudgate); then the label search on Google.
   */
  private readonly steps: readonly DeleteStep[] = [
    (running) => this.domainsOffNetworks(running),
    (running) => this.cloudServices(running),
    (running) => this.networks(running),
    (running) => this.labelSearch(running),
  ];

  async inCloud(environmentIds: readonly string[]): Promise<string[]> {
    if (environmentIds.length === 0) return [];
    const ids = [...environmentIds];
    const services = await this.db
      .selectDistinct({ environmentId: application.environmentId })
      .from(application)
      .where(
        and(
          inArray(application.environmentId, ids),
          isNotNull(application.cloudAccountId),
        ),
      );
    const networks = await this.db
      .selectDistinct({ environmentId: environmentNetwork.environmentId })
      .from(environmentNetwork)
      .where(inArray(environmentNetwork.environmentId, ids));
    const databases = await this.db
      .selectDistinct({ environmentId: postgres.environmentId })
      .from(postgres)
      .where(
        and(
          inArray(postgres.environmentId, ids),
          isNotNull(postgres.cloudAccountId),
        ),
      );
    // A mysql on RDS, as a postgres there.
    const mysqls = await this.db
      .selectDistinct({ environmentId: mysql.environmentId })
      .from(mysql)
      .where(
        and(inArray(mysql.environmentId, ids), isNotNull(mysql.cloudAccountId)),
      );
    const buckets = await this.db
      .selectDistinct({ environmentId: bucket.environmentId })
      .from(bucket)
      .where(
        and(
          inArray(bucket.environmentId, ids),
          isNotNull(bucket.cloudAccountId),
          bucketWithCloudDelete(this.db),
        ),
      );
    const caches = await this.db
      .selectDistinct({ environmentId: redis.environmentId })
      .from(redis)
      .where(
        and(inArray(redis.environmentId, ids), isNotNull(redis.cloudAccountId)),
      );
    const recorded = await this.db
      .select({ environmentId: environment.environmentId })
      .from(environment)
      .where(
        and(
          inArray(environment.environmentId, ids),
          isNotNull(environment.cloudDelete),
        ),
      );
    const found = new Set(
      [
        ...services,
        ...networks,
        ...databases,
        ...mysqls,
        ...buckets,
        ...caches,
        ...recorded,
      ].map((row) => row.environmentId),
    );
    return ids.filter((id) => found.has(id));
  }

  async refusal(current: Environment, retrying: boolean): Promise<void> {
    const record = this.settled(current);
    if (record?.status === 'deleting') {
      throw refused(`${current.name} is already being deleted`);
    }
    if (!retrying && record?.status === 'incomplete') {
      throw refused(
        `${current.name} is Delete incomplete: Retry the Delete, or Forget it`,
      );
    }
    if (retrying && record?.status !== 'incomplete') {
      throw refused(
        `${current.name} has no Delete to retry: Retry is for an Environment whose Delete is incomplete`,
      );
    }
    const services = await this.servicesOf(current.environmentId);
    for (const service of services) {
      const own = await this.serviceDeletes.settledRecord(targetOf(service));
      if (own?.status === 'deleting') {
        throw refused(
          `${service.name} is being deleted. Wait until its Delete ends, then delete the Environment`,
        );
      }
    }
    const buckets = await this.bucketsOf(current.environmentId);
    for (const one of buckets) {
      const own = await this.bucketDeletes.settled(one);
      if (own?.status === 'deleting') {
        throw refused(
          `${one.name} is being deleted. Wait until its Delete ends, then delete the Environment`,
        );
      }
    }
    const databases = await this.databaseDeletes.targetsIn(
      current.environmentId,
    );
    for (const database of databases) {
      const own = await this.databaseDeletes.settledRecord(database);
      if (own?.status === 'deleting') {
        throw refused(
          `${database.name} is being deleted. Wait until its Delete ends, then delete the Environment`,
        );
      }
      // Its Delete keeps a final backup, which a stopped Cloud SQL
      // instance cannot take.
      const stopped = await this.databaseDeletes.stoppedRefusal(database, {
        retrying: own?.status === 'incomplete',
        deleteData: false,
      });
      if (stopped !== null) throw refused(stopped);
    }
    const networks = await this.networksOf(current.environmentId);
    for (const network of networks) {
      if (network.status === 'creating' || network.status === 'deleting') {
        throw refused(
          `The ${environmentNetworkName(network.region)} is ${network.status === 'creating' ? 'being made by an Apply' : 'being removed'}. Wait until its Deployment ends`,
        );
      }
    }
    // A Delete whose Cloud account cannot be reached fails and removes
    // nothing, whichever of its parts would have reached it.
    const accounts = new Set([
      ...services.map((one) => one.cloudAccountId ?? ''),
      ...buckets.map((one) => one.cloudAccountId ?? ''),
      ...databases.map((one) => one.cloudAccountId),
      ...networks.map((one) => one.cloudAccountId),
    ]);
    for (const cloudAccountId of accounts) {
      const cloudAccountRow =
        await this.cloudAccounts.findForUse(cloudAccountId);
      if (!cloudAccountRow) {
        throw refused(
          `A Cloud account ${current.name} runs in is gone. Nothing was removed`,
        );
      }
      const signInRefusal =
        await this.cloudAccounts.signInRefusal(cloudAccountRow);
      if (signInRefusal !== null) {
        throw refused(`${signInRefusal}. Nothing was removed`);
      }
    }
  }

  async request(
    ctx: PermissionCtx,
    current: Environment,
    options: {
      readonly retrying: boolean;
      readonly force: boolean;
      readonly finish: FinishEnvironmentDelete;
      readonly byCloudgate?: boolean;
    },
  ): Promise<StartedEnvironmentDelete> {
    await this.refusal(current, options.retrying);
    const dnsRecordsLeft = await environmentDnsRecords(
      this.db,
      current.environmentId,
    );
    const record: EnvironmentDeleteRecord = {
      status: 'deleting',
      retrying: options.retrying,
      requestedBy: {
        userId: ctx.user.id,
        organizationId: ctx.session.activeOrganizationId,
      },
      force: options.force,
      left: current.cloudDelete?.left ?? [],
      dnsRecordsLeft,
      unfinished: null,
      ...(await this.labelSearchFields(current)),
    };
    const [row] = await this.db
      .update(environment)
      .set({ cloudDelete: record })
      .where(eq(environment.environmentId, current.environmentId))
      .returning();
    this.running.add(current.environmentId);
    // Its buckets on AWS first, here: one that holds files is kept and
    // gone at once, and named in this answer.
    const buckets = await this.startBuckets(ctx, current.environmentId);
    const ended = this.run(
      {
        ctx,
        environmentId: current.environmentId,
        byCloudgate: options.byCloudgate === true,
        buckets,
      },
      row,
      options.finish,
    )
      .catch(async (error: unknown) => {
        this.logger.error(
          `The Delete of Environment ${current.environmentId} failed: ${describeError(error)}`,
        );
        await this.incomplete(current.environmentId, describeError(error));
        return false;
      })
      .finally(() => this.running.delete(current.environmentId));
    return {
      environment: row,
      dnsRecordsLeft,
      bucketsLeftBehind: buckets.kept,
      ended,
    };
  }

  /**
   * The record's label-search fields: the Google Cloud accounts
   * every part of the Environment is in now, its Deploy target's among
   * them, with those an earlier run kept; and what the latest search found,
   * kept until this run's search replaces it.
   */
  private async labelSearchFields(
    current: Environment,
  ): Promise<
    Pick<EnvironmentDeleteRecord, 'labelSearchAccounts' | 'labelSearchLeft'>
  > {
    const id = current.environmentId;
    const candidates = new Set([
      ...(current.cloudDelete?.labelSearchAccounts ?? []),
      ...(current.deployTarget.kind === 'cloud'
        ? [current.deployTarget.cloudAccountId]
        : []),
      ...(await this.servicesOf(id)).map((one) => one.cloudAccountId ?? ''),
      ...(await this.bucketsOf(id)).map((one) => one.cloudAccountId ?? ''),
      ...(await this.databaseDeletes.targetsIn(id)).map(
        (one) => one.cloudAccountId,
      ),
      ...(await this.networksOf(id)).map((one) => one.cloudAccountId),
    ]);
    const accounts: string[] = [];
    for (const cloudAccountId of candidates) {
      if (!cloudAccountId) continue;
      if (current.cloudDelete?.labelSearchAccounts?.includes(cloudAccountId)) {
        accounts.push(cloudAccountId);
        continue;
      }
      // The Cloud accounts each cloud's Delete searches by label afterwards
      // (ADR-0043): none on AWS, whose leftovers each state's own tag search
      // finds as it is destroyed; a Google one, for what only the
      // Environment's label still marks.
      accounts.push(
        ...byCloud(await this.cloudOf(cloudAccountId), {
          aws: [],
          gcp: [cloudAccountId],
        }),
      );
    }
    const kept = current.cloudDelete?.labelSearchLeft;
    return {
      ...(accounts.length > 0 ? { labelSearchAccounts: accounts } : {}),
      ...(kept?.length ? { labelSearchLeft: kept } : {}),
    };
  }

  /**
   * Each bucket on AWS's own Delete, never asked to delete its
   * files — Retry for one already incomplete: the kept ones, gone already,
   * and the runs of the rest. A Delete that would not start is named.
   */
  private async startBuckets(
    ctx: PermissionCtx,
    environmentId: string,
  ): Promise<StartedBuckets> {
    const started: StartedBuckets = { kept: [], runs: [], unstarted: [] };
    for (const one of await this.bucketsOf(environmentId)) {
      try {
        const own = await this.bucketDeletes.settled(one);
        const answer = await this.bucketDeletes.start(
          ctx,
          one,
          { deleteFiles: false, retrying: own?.status === 'incomplete' },
          KEEP_NOTHING,
        );
        if (answer.kind === 'kept') started.kept.push(answer.kept);
        else {
          // On Google Cloud a kept bucket's run destroys its key.
          if (answer.kept) started.kept.push(answer.kept);
          started.runs.push(answer.ended);
        }
      } catch (error) {
        started.unstarted.push(`${one.name}: ${describeError(error)}`);
      }
    }
    return started;
  }

  async forget(
    ctx: PermissionCtx,
    current: Environment,
    finish: FinishEnvironmentDelete,
  ) {
    const record = this.settled(current);
    if (record?.status !== 'incomplete') {
      throw refused(
        record?.status === 'deleting'
          ? `${current.name} is being deleted; Forget is for a Delete that is incomplete`
          : `${current.name} has no incomplete Delete to forget`,
      );
    }
    // Cut off by a restart, as a Service's Delete can be: Retry
    // lists what is left first.
    if (current.cloudDelete?.status === 'deleting') {
      throw refused(
        `${current.name}'s Delete was cut off before it checked what is left in ${await this.cloudName(current.environmentId)}, so Forget would record nothing of it. Retry it first`,
      );
    }
    for (const network of await this.networksOf(current.environmentId)) {
      if (network.status === 'deleting' || network.status === 'creating') {
        throw refused(
          `The ${environmentNetworkName(network.region)} is ${network.status === 'creating' ? 'being made' : 'being removed'}. Wait until its Deployment ends`,
        );
      }
    }
    const forgotten: EnvironmentLeftover[] = [];
    const leftBehind = await finish(async () => {
      for (const service of await this.servicesOf(current.environmentId)) {
        const left = await this.serviceDeletes.discard(targetOf(service));
        forgotten.push(...of(`Service ${service.name}`, left));
      }
      for (const one of await this.bucketsOf(current.environmentId)) {
        const left = await this.bucketDeletes.discard(one);
        forgotten.push(...of(`Service ${one.name}`, left));
      }
      for (const database of await this.databaseDeletes.targetsIn(
        current.environmentId,
      )) {
        const left = await this.databaseDeletes.discard(database);
        forgotten.push(...of(`Service ${database.name}`, left));
      }
      for (const network of await this.networksOf(current.environmentId)) {
        const left = await this.removals.discard(network);
        forgotten.push(...of(environmentNetworkName(network.region), left));
      }
      // What the latest label search found on Google Cloud.
      forgotten.push(...(record.labelSearchLeft ?? []));
    });
    await this.auditLogs.audit(
      { userId: ctx.user.id, organizationId: ctx.session.activeOrganizationId },
      {
        action: 'delete',
        resourceType: 'environment',
        resourceId: current.environmentId,
        resourceName: current.name,
        metadata: {
          cloudDelete: 'forgotten',
          left: forgotten,
          ...(record.unfinished ? { unfinished: record.unfinished } : {}),
          dnsRecordsLeft: record.dnsRecordsLeft,
          ...leftBehind,
        },
      },
    );
    return { environmentId: current.environmentId, forgotten };
  }

  /**
   * The record as it stands: a `deleting` this process is not running was
   * cut off by a restart, and reads as incomplete so Retry and Forget
   * reach it.
   */
  private settled(current: Environment): EnvironmentDeleteRecord | null {
    const record = current.cloudDelete;
    if (record?.status !== 'deleting') return record;
    if (this.running.has(current.environmentId)) return record;
    return { ...record, status: 'incomplete', unfinished: CUT_OFF };
  }

  /**
   * One of Cloudgate's own tries at Google's subnet hold (S13) for a
   * network no Environment's Delete is under: a plan's removal of an
   * unused network, queued again as it was.
   */
  async retryHeldNetwork(network: EnvironmentNetwork): Promise<void> {
    await this.removals.start(network, { byCloudgate: true });
  }

  /** The Delete's {@link steps}, then the rest. Answers whether the Environment is gone. */
  private async run(
    running: RunningDelete,
    current: Environment,
    finish: FinishEnvironmentDelete,
  ): Promise<boolean> {
    const { environmentId, buckets } = running;
    for (const step of this.steps) {
      if (!(await step(running))) return false;
    }

    // Then the rest, as an Environment's Delete always went.
    let leftBehind: Record<string, unknown>;
    try {
      leftBehind = await finish(() => Promise.resolve());
    } catch (error) {
      await this.incomplete(
        environmentId,
        `Everything in ${await this.cloudName(environmentId)} is gone, but the rest of the Environment was not deleted: ${describeError(error)}`,
      );
      return false;
    }
    const asked = current.cloudDelete?.requestedBy;
    if (asked) {
      await this.auditLogs.audit(asked, {
        action: 'delete',
        resourceType: 'environment',
        resourceId: environmentId,
        resourceName: current.name,
        metadata: {
          cloudDelete: 'finished',
          dnsRecordsLeft: current.cloudDelete?.dnsRecordsLeft ?? [],
          ...leftBehind,
          ...(buckets.kept.length > 0
            ? { cloudBucketsKept: buckets.kept }
            : {}),
        },
      });
    }
    return true;
  }

  /**
   * On Google Cloud: one network run per made Google
   * network takes every Domain off its load balancer, the Environment
   * being marked as deleted, before any Service is touched. A run that
   * fails stops the Delete there, nothing else removed.
   */
  private async domainsOffNetworks(running: RunningDelete): Promise<boolean> {
    const runs: { name: string; ended: Promise<CloudRunEnding> }[] = [];
    const unstarted: string[] = [];
    for (const network of await this.networksOf(running.environmentId)) {
      // What takes its Domains off each cloud's network first (ADR-0043):
      // nothing on AWS, where a Domain's rule goes with its Service's state.
      const takeOff = byCloud(await this.cloudOf(network.cloudAccountId), {
        aws: null,
        gcp: () => this.googleDomainRuns.removeEnvironmentDomains(network),
      });
      if (takeOff === null) continue;
      if (!(await this.hasDomains(network))) continue;
      const name = environmentNetworkName(network.region);
      try {
        const started = await takeOff();
        if (started) runs.push({ name, ended: started.ended });
      } catch (error) {
        unstarted.push(`${name}: ${describeError(error)}`);
      }
    }
    const failed = [...unstarted];
    for (const one of runs) {
      const ending = await one.ended;
      if (ending.kind !== 'finished') {
        failed.push(
          `${one.name}: ${endingDescription(ending) ?? 'it was cancelled'}`,
        );
      }
    }
    if (failed.length === 0) return true;
    await this.incomplete(
      running.environmentId,
      `The network step that takes every Domain off failed before any Service was touched: ${failed.join('; ')}`,
    );
    return false;
  }

  /**
   * Each cloud Service through its own Delete, all waited for, and the
   * runs of its buckets on AWS that were empty; on Google Cloud each
   * skips its network step, the one before having taken every Domain off.
   */
  private async cloudServices(running: RunningDelete): Promise<boolean> {
    const { ctx, environmentId, buckets } = running;
    const unstarted: string[] = [...buckets.unstarted];
    const runs: Promise<void>[] = [...buckets.runs];
    for (const service of await this.servicesOf(environmentId)) {
      const target = targetOf(service);
      const own = await this.serviceDeletes.settledRecord(target);
      try {
        const started = await this.serviceDeletes.start(
          ctx,
          target,
          KEEP_NOTHING,
          own?.status === 'incomplete',
          // Read on Google Cloud only: an AWS Service has no network step.
          { networkStepDone: true },
        );
        runs.push(started.ended);
      } catch (error) {
        unstarted.push(`${service.name}: ${describeError(error)}`);
      }
    }
    // Each database keeps its final snapshot: only its own Delete or Plan
    // destroy may ask for its data to go.
    for (const database of await this.databaseDeletes.targetsIn(
      environmentId,
    )) {
      const own = await this.databaseDeletes.settledRecord(database);
      try {
        const started = await this.databaseDeletes.start(
          ctx,
          database,
          KEEP_NOTHING,
          { retrying: own?.status === 'incomplete', deleteData: false },
        );
        runs.push(started.ended);
      } catch (error) {
        unstarted.push(`${database.name}: ${describeError(error)}`);
      }
    }
    await Promise.all(runs);
    if (
      (await this.servicesOf(environmentId)).length > 0 ||
      (await this.bucketsOf(environmentId)).length > 0 ||
      (await this.databaseDeletes.targetsIn(environmentId)).length > 0
    ) {
      await this.incomplete(
        environmentId,
        unstarted.length > 0 ? `The Delete of ${unstarted.join('; ')}` : null,
      );
      return false;
    }
    return true;
  }

  /**
   * Each Environment network, once nothing runs in it, last. On Google
   * Cloud a removal Google's subnet hold refuses keeps Cloudgate's own
   * next try (S13); this Delete's Retry by hand clears it.
   */
  private async networks(running: RunningDelete): Promise<boolean> {
    const { environmentId } = running;
    const unstarted: string[] = [];
    const removals: Promise<unknown>[] = [];
    for (const network of await this.networksOf(environmentId)) {
      try {
        removals.push(
          (
            await this.removals.start(network, {
              byCloudgate: running.byCloudgate,
            })
          ).ended,
        );
      } catch (error) {
        unstarted.push(
          `${environmentNetworkName(network.region)}: ${describeError(error)}`,
        );
      }
    }
    await Promise.all(removals);
    if ((await this.networksOf(environmentId)).length > 0) {
      await this.incomplete(
        environmentId,
        unstarted.length > 0 ? `The removal of ${unstarted.join('; ')}` : null,
      );
      return false;
    }
    return true;
  }

  /**
   * Last, on Google Cloud (the Google Cloud databases spec, "Deleting the Environment"):
   * the label search in each Google project the Environment was in, for
   * anything still carrying its label once its databases, private link and
   * networks are gone. Each thing found is named by type, Google id, region
   * and label, as whose the project's; a search Google refused, or that
   * could not sign in, is never taken as clean. Either keeps the
   * Environment `incomplete` for Retry, which searches again, or Forget.
   */
  private async labelSearch(running: RunningDelete): Promise<boolean> {
    const { environmentId } = running;
    const [row] = await this.db
      .select({ cloudDelete: environment.cloudDelete })
      .from(environment)
      .where(eq(environment.environmentId, environmentId));
    const record = row?.cloudDelete;
    if (!record?.labelSearchAccounts?.length) return true;
    const left: EnvironmentLeftover[] = [];
    const unchecked: string[] = [];
    for (const cloudAccountId of record.labelSearchAccounts) {
      const found = await this.cloudAccounts.findForUse(cloudAccountId);
      if (!found) {
        unchecked.push('A Google Cloud account the Environment was in is gone');
        continue;
      }
      const account = googleAccountOf(found);
      const session = await this.cloudAccounts.googleRunSession(account);
      if (!session.ok) {
        unchecked.push(session.refusal);
        continue;
      }
      const check = await findGoogleLabelLeftovers(this.google, session.token, {
        projectId: account.cloudId,
        environmentId,
      });
      if (check.ok) {
        left.push(...of(labelSearchOf(account.cloudId), check.left));
      } else {
        unchecked.push(check.message);
      }
    }
    if (left.length === 0 && unchecked.length === 0) return true;
    await this.db
      .update(environment)
      .set({
        cloudDelete: {
          ...record,
          status: 'incomplete',
          left,
          labelSearchLeft: left,
          unfinished:
            unchecked.length > 0
              ? `What is left in Google Cloud could not be checked: ${unchecked.join('; ')}`
              : null,
        },
      })
      .where(eq(environment.environmentId, environmentId));
    return false;
  }

  /**
   * The Environment kept `incomplete`, with what is left as its Services'
   * and networks' own records say, and what the latest label search found,
   * and why it stopped when nothing is.
   */
  private async incomplete(
    environmentId: string,
    why: string | null,
  ): Promise<void> {
    const left: EnvironmentLeftover[] = [];
    const unfinished: string[] = [];
    for (const service of await this.servicesOf(environmentId)) {
      const own: ServiceCloudDeleteRecord | null =
        await this.serviceDeletes.settledRecord(targetOf(service));
      left.push(...of(`Service ${service.name}`, own?.left ?? []));
      if (own?.unfinished)
        unfinished.push(`${service.name}: ${own.unfinished}`);
      if (!own) unfinished.push(`${service.name}: its Delete removed nothing`);
    }
    for (const one of await this.bucketsOf(environmentId)) {
      const own = await this.bucketDeletes.settled(one);
      left.push(...of(`Service ${one.name}`, own?.left ?? []));
      if (own?.unfinished) unfinished.push(`${one.name}: ${own.unfinished}`);
      if (!own) unfinished.push(`${one.name}: its Delete removed nothing`);
    }
    for (const database of await this.databaseDeletes.targetsIn(
      environmentId,
    )) {
      const own = await this.databaseDeletes.settledRecord(database);
      left.push(...of(`Service ${database.name}`, own?.left ?? []));
      if (own?.unfinished) {
        unfinished.push(`${database.name}: ${own.unfinished}`);
      }
      if (!own) unfinished.push(`${database.name}: its Delete removed nothing`);
    }
    for (const network of await this.networksOf(environmentId)) {
      const name = environmentNetworkName(network.region);
      left.push(...of(name, network.leftovers));
      const hold = subnetHoldOf(network);
      if (hold) {
        unfinished.push(`${name}: ${hold}`);
      } else if (network.leftovers.length === 0 && network.status !== 'ready') {
        unfinished.push(`${name}: its removal did not finish`);
      }
    }
    const [row] = await this.db
      .select({ cloudDelete: environment.cloudDelete })
      .from(environment)
      .where(eq(environment.environmentId, environmentId));
    if (!row?.cloudDelete) return;
    left.push(...(row.cloudDelete.labelSearchLeft ?? []));
    const reason =
      why ??
      (unfinished.length > 0
        ? unfinished.join('; ')
        : left.length > 0
          ? null
          : 'The Delete did not finish');
    await this.db
      .update(environment)
      .set({
        cloudDelete: {
          ...row.cloudDelete,
          status: 'incomplete',
          left,
          unfinished: reason,
        },
      })
      .where(eq(environment.environmentId, environmentId));
  }

  private servicesOf(environmentId: string): Promise<Application[]> {
    return this.db
      .select()
      .from(application)
      .where(
        and(
          eq(application.environmentId, environmentId),
          isNotNull(application.cloudAccountId),
        ),
      )
      .orderBy(asc(application.name));
  }

  /** Its buckets on AWS, by name. */
  private bucketsOf(environmentId: string): Promise<Bucket[]> {
    return this.db
      .select()
      .from(bucket)
      .where(
        and(
          eq(bucket.environmentId, environmentId),
          isNotNull(bucket.cloudAccountId),
          bucketWithCloudDelete(this.db),
        ),
      )
      .orderBy(asc(bucket.name));
  }

  private networksOf(environmentId: string): Promise<EnvironmentNetwork[]> {
    return this.db
      .select()
      .from(environmentNetwork)
      .where(eq(environmentNetwork.environmentId, environmentId))
      .orderBy(asc(environmentNetwork.region));
  }

  /** The cloud a Cloud account is at, by the seam's rule when it is gone. */
  private async cloudOf(cloudAccountId: string): Promise<CloudKind> {
    const row = await this.cloudAccounts.findForUse(cloudAccountId);
    return cloudOrLegacy(row?.cloud);
  }

  /**
   * Where the Environment's cloud parts are, as a sentence names it: a
   * cloud other than the legacy one any part is in, else the legacy one.
   */
  private async cloudName(environmentId: string): Promise<string> {
    const places = [
      ...(await this.networksOf(environmentId)),
      ...(await this.servicesOf(environmentId)),
    ];
    for (const place of places) {
      if (!place.cloudAccountId) continue;
      const cloud = await this.cloudOf(place.cloudAccountId);
      if (cloud !== LEGACY_CLOUD) return CLOUD_NAMES[cloud];
    }
    return CLOUD_NAMES[LEGACY_CLOUD];
  }

  /** Whether a Domain of the Environment's Services is on this Google network. */
  private async hasDomains(network: EnvironmentNetwork): Promise<boolean> {
    const [found] = await this.db
      .select({ domainId: domain.domainId })
      .from(domain)
      .innerJoin(
        application,
        eq(application.applicationId, domain.applicationId),
      )
      .where(
        and(
          eq(application.environmentId, network.environmentId),
          eq(application.cloudAccountId, network.cloudAccountId),
          eq(application.region, network.region),
          isNotNull(domain.cloudCertificateStatus),
        ),
      )
      .limit(1);
    return found !== undefined;
  }
}

/** What an Environment's Delete started of its buckets on AWS. */
interface StartedBuckets {
  /** Kept because each holds files or could not be read, and gone already. */
  readonly kept: CloudBucketKept[];
  readonly runs: Promise<void>[];
  readonly unstarted: string[];
}

/** A cloud Service's row as its Delete reads it. */
function targetOf(service: Application): CloudDeleteTarget {
  return {
    applicationId: service.applicationId,
    appName: service.appName,
    name: service.name,
    configName: service.configName,
    environmentId: service.environmentId,
    cloudAccountId: service.cloudAccountId ?? '',
    region: service.region ?? '',
    cloudDelete: service.cloudDelete,
    cloudBucketName: service.cloudBucketName,
  };
}

/** Whose a thing the label search found is: the Google project it is in. */
function labelSearchOf(projectId: string): string {
  return `Google Cloud project ${projectId}, by its label`;
}

function of(
  whose: string,
  left: readonly ServiceLeftover[],
): EnvironmentLeftover[] {
  return left.map((one) => ({ ...one, of: whose }));
}

function refused(message: string): ConflictException {
  return new ConflictException({ message, code: CLOUD_DELETE_REFUSED_CODE });
}

/**
 * A cloud bucket its own Delete removes from the cloud: every one Cloudgate
 * made, and an existing one whose own state holds what Cloudgate made for
 * it — on Google Cloud its key account and key. Any other existing
 * bucket is left as it was: only its row goes.
 */
function bucketWithCloudDelete(db: DrizzleDB) {
  return or(
    eq(bucket.existing, false),
    inArray(
      bucket.bucketId,
      db
        .select({ bucketId: infrastructureState.bucketId })
        .from(infrastructureState)
        .where(isNotNull(infrastructureState.bucketId)),
    ),
  );
}
