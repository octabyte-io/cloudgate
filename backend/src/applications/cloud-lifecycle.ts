import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';

import { ecsServiceName } from '../cloud-accounts/aws/definitions/web-definition';
import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { onCloud } from '../cloud-accounts/cloud-provider';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT } from '../cloud-accounts/cloud.port';
import type {
  AwsAnswer,
  AwsCloudPort,
  AwsCredential,
  EcsServiceRef,
} from '../cloud-accounts/cloud.port';
import { googleRefusalReason } from '../cloud-accounts/gcp/api-off';
import { CLOUD_RUN_COPIES } from '../cloud-accounts/gcp/definitions/cloud-run-size';
import { serviceName } from '../cloud-accounts/gcp/definitions/names';
import {
  cloudRunResourceOf,
  RELOAD_LABEL,
} from '../cloud-accounts/gcp/definitions/cloud-run-definition';
import type { ApplicationConfigKind } from './application.schema';
import {
  GOOGLE_CLOUD_PORT,
  NOT_FOUND,
} from '../cloud-accounts/google-cloud.port';
import type {
  CloudRunServiceRef,
  CopyRange,
  GoogleAccessToken,
  GoogleAnswer,
  GoogleCloudPort,
} from '../cloud-accounts/google-cloud.port';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { environmentNetwork } from '../db/schema';

/**
 * The `code` of a 409 a cloud Service's Stop, Start or Reload answers when
 * the cloud refused it, or there was nothing in the cloud to act on, so the
 * MCP tools can tell it from a Server's "nothing to start".
 */
export const CLOUD_LIFECYCLE_REFUSED_CODE = 'CLOUD_LIFECYCLE_REFUSED';

/** What a cloud Service's lifecycle reads off its row. */
export interface CloudLifecycleTarget {
  readonly applicationId: string;
  readonly appName: string;
  readonly configName: string | null;
  readonly environmentId: string;
  readonly cloudAccountId: string;
  readonly region: string;
  /** ECS's running count on Start. */
  readonly replicas: number;
  /** Cloud Run's copy range on Start (S10); `null` reads as the create's 0–10. */
  readonly minCopies: number | null;
  readonly maxCopies: number | null;
  /** A `worker` runs as a Cloud Run worker pool on Google Cloud. */
  readonly configKind: ApplicationConfigKind;
}

/** Where a Service's lifecycle calls reach on ECS. */
interface EcsReached {
  readonly session: AwsCredential;
  readonly service: EcsServiceRef;
}

/** Where a Service's lifecycle calls reach on Cloud Run. */
interface CloudRunReached {
  readonly accountName: string;
  readonly projectId: string;
  readonly token: GoogleAccessToken;
  readonly service: CloudRunServiceRef;
}

/** A cloud Service's lifecycle calls on its own cloud (ADR-0043). */
interface LifecycleCalls {
  stop(): Promise<void>;
  start(): Promise<void>;
  reload(at: Date): Promise<void>;
  setCopyRange(copies: CopyRange): Promise<boolean>;
}

/**
 * **Stop, Start and Reload of a `web` in a Cloud account** (spec
 * "Lifecycle"): direct calls through the
 * cloud's port, signed in as its deploy identity, never a Cloud run. Each is
 * one update and answers once the cloud has taken it, so it takes seconds
 * rather than a run's minutes; the Service's status is read from its
 * row, as on a Server.
 *
 * On ECS:
 * - Stop sets the desired count to zero.
 * - Start sets it to the Service's `replicas`, which stays Cloudgate's.
 * - Reload forces a new deployment of the same task definition.
 *
 * On Cloud Run:
 * - Stop switches the service to manual scaling at no copies, so it refuses
 *   traffic rather than waiting idle.
 * - Start puts back automatic scaling, its revisions in the Service's copy
 *   range (S10), which stays Cloudgate's and is set by {@link setCopyRange}.
 * - Reload sets the revision label `cloudgate-reload` to the time of the
 *   call: a fresh revision of the same image (S9).
 *
 * None of it is in any plan: ECS's definition ignores `desired_count`
 * and the Cloud Run service's ignores its scaling, its copy range
 * and Reload's label (S9), so a stopped Service is not Drift a plan would
 * put back. A Deploy writes the running count or the scaling back itself
 * which is what starts a stopped Service.
 */
@Injectable()
export class CloudServiceLifecycle {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
    private readonly cloudAccounts: CloudAccountsService,
  ) {}

  async stop(target: CloudLifecycleTarget): Promise<void> {
    await (await this.reach(target)).stop();
  }

  async start(target: CloudLifecycleTarget): Promise<void> {
    await (await this.reach(target)).start();
  }

  /** Every running copy replaced by a fresh one of the same version. */
  async reload(target: CloudLifecycleTarget, at = new Date()): Promise<void> {
    await (await this.reach(target)).reload(at);
  }

  /**
   * A Cloud Run Service's copy range set by a direct call (S10). Answers
   * `false`, changing nothing, when no deploy has made the Cloud Run service
   * yet: its first deploy creates it at the range its row holds.
   */
  async setCopyRange(
    target: CloudLifecycleTarget,
    copies: CopyRange,
  ): Promise<boolean> {
    return (await this.reach(target)).setCopyRange(copies);
  }

  /**
   * The Service's lifecycle calls on its Cloud account's cloud (ADR-0043),
   * signed in as its deploy identity. A refused sign-in is recorded on the
   * Cloud account like any use and answered as the 409 it is.
   */
  private async reach(target: CloudLifecycleTarget): Promise<LifecycleCalls> {
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      target.cloudAccountId,
    );
    if (!cloudAccountRow) {
      throw refused('The Cloud account this Service runs in is gone');
    }
    return onCloud<Promise<LifecycleCalls>>(cloudAccountRow, {
      aws: (account) => this.onEcs(target, account),
      gcp: (account) =>
        cloudRunResourceOf(target.configKind) === 'worker-pool'
          ? this.onWorkerPool(target, account)
          : this.onCloudRun(target, account),
    });
  }

  /**
   * On ECS: a deploy-role session and the Service's ECS service in its
   * Environment network's cluster. Stop sets the desired count to zero,
   * Start to `replicas`, and Reload forces a new deployment.
   */
  private async onEcs(
    target: CloudLifecycleTarget,
    account: AwsCloudAccount,
  ): Promise<LifecycleCalls> {
    const reached = await this.reachAws(target, account);
    return {
      stop: () => this.setRunningCount(target, reached, 0),
      start: () => this.setRunningCount(target, reached, target.replicas),
      reload: () =>
        this.answered(
          this.cloud.ecsForceNewDeployment(reached.session, reached.service),
          `ECS refused to replace the running copies of ${target.appName}`,
        ),
      setCopyRange: () => {
        throw refused(
          `Only a Service on Cloud Run has a copy range; ${nameOf(target)} runs on ECS, which has replicas`,
        );
      },
    };
  }

  /**
   * On Cloud Run: the deploy service account's access token and the
   * Service's Cloud Run service by its fixed name (S4).
   */
  private async onCloudRun(
    target: CloudLifecycleTarget,
    account: GcpCloudAccount,
  ): Promise<LifecycleCalls> {
    const signed = await this.cloudAccounts.googleRunSession(account);
    if (!signed.ok) throw refused(signed.refusal);
    const reached: CloudRunReached = {
      accountName: account.name,
      projectId: account.cloudId,
      token: signed.token,
      service: {
        projectId: account.cloudId,
        region: target.region,
        name: serviceName(target.applicationId),
      },
    };
    return {
      stop: () =>
        this.googleAnswered(
          target,
          reached,
          this.google.setCloudRunScaling(reached.token, reached.service, {
            mode: 'stopped',
          }),
          `stop ${nameOf(target)}`,
        ),
      start: () =>
        this.googleAnswered(
          target,
          reached,
          this.google.setCloudRunScaling(reached.token, reached.service, {
            mode: 'automatic',
            copies: copyRangeOf(target),
          }),
          `start ${nameOf(target)}`,
        ),
      reload: (at) =>
        this.googleAnswered(
          target,
          reached,
          this.google.setRevisionLabel(reached.token, reached.service, {
            key: RELOAD_LABEL,
            // Whole seconds: a label value takes no `:` or `.`.
            value: String(Math.floor(at.getTime() / 1000)),
          }),
          `reload ${nameOf(target)}`,
        ),
      setCopyRange: async (copies) => {
        const answer = await this.google.setCloudRunCopies(
          reached.token,
          reached.service,
          copies,
        );
        if (!answer.ok && answer.code === NOT_FOUND) return false;
        await this.googleAnswered(
          target,
          reached,
          Promise.resolve(answer),
          `the copy range of ${nameOf(target)}`,
          'refused',
        );
        return true;
      },
    };
  }

  /**
   * On a Worker's Cloud Run worker pool: Stop sets its manual
   * instance count to 0, so it bills nothing; Start sets it back to
   * `replicas`, which stays Cloudgate's; Reload sets the revision label
   * `cloudgate-reload`, as on a service. It has no copy range.
   */
  private async onWorkerPool(
    target: CloudLifecycleTarget,
    account: GcpCloudAccount,
  ): Promise<LifecycleCalls> {
    const signed = await this.cloudAccounts.googleRunSession(account);
    if (!signed.ok) throw refused(signed.refusal);
    const reached: CloudRunReached = {
      accountName: account.name,
      projectId: account.cloudId,
      token: signed.token,
      service: {
        projectId: account.cloudId,
        region: target.region,
        name: serviceName(target.applicationId),
      },
    };
    const answered = (
      answer: ReturnType<GoogleCloudPort['setWorkerPoolInstances']>,
      what: string,
    ) =>
      this.googleAnswered(
        target,
        reached,
        answer,
        what,
        'refused to',
        'worker pool',
      );
    const instances = (count: number, what: string) =>
      answered(
        this.google.setWorkerPoolInstances(
          reached.token,
          reached.service,
          count,
        ),
        what,
      );
    return {
      stop: () => instances(0, `stop ${nameOf(target)}`),
      start: () => instances(target.replicas, `start ${nameOf(target)}`),
      reload: (at) =>
        answered(
          this.google.setWorkerPoolRevisionLabel(
            reached.token,
            reached.service,
            {
              key: RELOAD_LABEL,
              value: String(Math.floor(at.getTime() / 1000)),
            },
          ),
          `reload ${nameOf(target)}`,
        ),
      setCopyRange: () => {
        throw refused(
          `Only a Service on Cloud Run has a copy range; ${nameOf(target)} is a Worker, whose replicas are its worker pool's instance count`,
        );
      },
    };
  }

  private async setRunningCount(
    target: CloudLifecycleTarget,
    reached: EcsReached,
    count: number,
  ): Promise<void> {
    await this.answered(
      this.cloud.ecsSetDesiredCount(reached.session, {
        ...reached.service,
        desiredCount: count,
      }),
      `ECS refused to set the running count of ${target.appName} to ${count}`,
    );
  }

  private async reachAws(
    target: CloudLifecycleTarget,
    account: AwsCloudAccount,
  ): Promise<EcsReached> {
    const [network] = await this.db
      .select({ clusterArn: environmentNetwork.clusterArn })
      .from(environmentNetwork)
      .where(
        and(
          eq(environmentNetwork.environmentId, target.environmentId),
          eq(environmentNetwork.cloudAccountId, target.cloudAccountId),
          eq(environmentNetwork.region, target.region),
          eq(environmentNetwork.status, 'ready'),
          isNotNull(environmentNetwork.clusterArn),
        ),
      );
    if (!network?.clusterArn) {
      throw refused(
        `${target.appName} has nothing running in Cloud account ${account.name} yet: its Environment network is not made. Deploy it first`,
      );
    }
    const answer = await this.cloudAccounts.deployRoleSession(account);
    if (!answer.ok) throw refused(answer.refusal);
    return {
      session: answer.session,
      service: {
        region: target.region,
        cluster: network.clusterArn,
        service: ecsServiceName(
          target.configName ?? target.appName,
          target.applicationId,
        ),
      },
    };
  }

  private async answered(
    call: Promise<AwsAnswer<true>>,
    refusal: string,
  ): Promise<void> {
    const answer = await call;
    if (!answer.ok) {
      throw refused(`${refusal}: ${answer.code}: ${answer.message}`);
    }
  }

  /**
   * Google's answer, or a 409 in its words: a service no deploy has made
   * says so, and an API turned off names the setup step that turns it on.
   */
  private async googleAnswered(
    target: CloudLifecycleTarget,
    reached: CloudRunReached,
    call: Promise<GoogleAnswer<true>>,
    what: string,
    verb: 'refused to' | 'refused' = 'refused to',
    made: 'service' | 'worker pool' = 'service',
  ): Promise<void> {
    const answer = await call;
    if (answer.ok) return;
    if (answer.code === NOT_FOUND) {
      throw refused(
        `${nameOf(target)} has nothing running in Cloud account ${reached.accountName} yet: no deploy has made its Cloud Run ${made}. Deploy it first`,
      );
    }
    const words = googleRefusalReason(answer.message, reached.projectId);
    throw refused(
      words === answer.message
        ? `Google Cloud ${verb} ${what}: ${answer.code}: ${answer.message}`
        : `Google Cloud ${verb} ${what}: ${words}`,
    );
  }
}

/** The Service as Google's refusals name it: its Config name, as the operator wrote it. */
function nameOf(target: CloudLifecycleTarget): string {
  return target.configName ?? target.appName;
}

/** A Cloud Run Service's copy range, the create's 0–10 until one is saved. */
function copyRangeOf(target: CloudLifecycleTarget): CopyRange {
  return {
    min: target.minCopies ?? CLOUD_RUN_COPIES.min,
    max: target.maxCopies ?? CLOUD_RUN_COPIES.max,
  };
}

function refused(message: string): ConflictException {
  return new ConflictException({
    message,
    code: CLOUD_LIFECYCLE_REFUSED_CODE,
  });
}
