import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';

import { CLOUD_DELETE_REFUSED_CODE } from '../../applications/cloud-delete-refusal';
import { destroyDefinition } from '../../cloud-accounts/aws/definitions/destroy-definition';
import {
  CLEAN_NETWORK_REMOVAL_LINE,
  deleteReportLines,
  findLeftovers,
  heldByState,
} from '../../cloud-accounts/aws/delete-check';
import type { Leftover } from '../../cloud-accounts/aws/delete-check';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import {
  cloudOrLegacy,
  credentialOf,
} from '../../cloud-accounts/cloud-provider';
import {
  HOLD_RETRY_AFTER_MS,
  HOLD_TRIES,
  subnetHoldSentence,
} from '../../cloud-accounts/gcp/delete-check';
import { byCloud, onCloud } from '../../cloud-accounts/cloud-provider';
import type { AwsCloudAccount } from '../../cloud-accounts/cloud-provider';
import {
  AWS_CLOUD_PORT,
  CHANGED_NOTHING,
} from '../../cloud-accounts/cloud.port';
import type {
  AwsCloudPort,
  TofuFailure,
  TofuShow,
} from '../../cloud-accounts/cloud.port';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { reclaimDeploymentLogs } from '../../common/teardown-steps';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { deployment, environmentNetwork } from '../../db/schema';
import type { EnvironmentNetwork } from '../../db/schema';
import { CloudReadWorks } from '../../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunJob,
} from '../../deployment-queue/cloud-run-job.types';
import {
  CloudRunsService,
  endingDescription,
} from '../../deployment-queue/cloud-runs.service';
import {
  DeploymentsService,
  environmentNetworkLogOwner,
} from '../../deployments/deployments.service';
import { environmentNetworkName } from '../../deployments/service-scope';
import type { DnsRecord } from '../../domains/domain.schema';
import type {
  EnvironmentNetworkStatus,
  NetworkLeftover,
} from '../../environments/environment-network.schema';
import { cloudServicesIn } from '../../environments/cloud-services-in';
import { dnsRecordLine } from '../../environments/network-dns-records';
import { subnetHoldOf } from '../../environments/subnet-hold';
import { RemoteExecService } from '../../remote/remote-exec.service';
import { NothingRemoved } from '../../common/nothing-removed';
import { GoogleNetworkRemovalSteps } from './google-network-removal';
import type { GoogleNetworkRemovalOutcome } from './google-network-removal';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';

/** What a network's removal said once its run ended. */
export type NetworkRemovalEnd =
  | { readonly removed: true; readonly dnsRecordsLeft: readonly DnsRecord[] }
  | {
      readonly removed: false;
      readonly status: EnvironmentNetworkStatus;
      readonly left: readonly NetworkLeftover[];
      /** Why the run did not finish, or `null` when it did and found something left. */
      readonly unfinished: string | null;
    };

/** A removal the pool is running. */
export interface StartedRemoval {
  readonly deploymentId: string;
  readonly ended: Promise<NetworkRemovalEnd>;
}

/**
 * **Removing an Environment network** (the AWS spec "Delete", ADR-0038):
 * a Cloud run that only destroys, recorded as a Deployment of the network
 * (its seventh parent, ADR-0017), waiting in the pool as a run that changes
 * the network, so it holds back every other run of its Environment.
 *
 * Two things remove a network: an Environment's Delete, once each of its
 * cloud Services' Deletes has finished, and the Apply of a plan's
 * `network-remove` step, for a network a Deploy target switch left with
 * nothing in it. Either way the run first refuses while a Service still
 * runs in the network (a security group of the Service would hold the VPC,
 * and the destroy fail after the provider's timeouts), then destroys
 * everything in the network's Infrastructure state, then checks: a tag
 * search by the state's tag, and by id the network cards AWS made on its
 * security groups (the load balancer's among them).
 *
 * Clean: the state, the network's row, its Deployments and their logs go,
 * and the run's log names the DNS records its Domains left at the
 * operator's DNS provider. Anything left, or a run that did not finish,
 * keeps the row `delete-incomplete` with the list and the state.
 *
 * **On Google Cloud** the run is {@link GoogleNetworkRemovalSteps}:
 * the destroy, then a search by the network's names. Google holds a used
 * subnet 1–2 hours after its services are gone, so a
 * removal it refuses for that is **held**: the row keeps Cloudgate's own
 * next try and how many are left (S13), about 2 hours and again about 4
 * hours after the first, which `SubnetHoldRetries` queues; after that it
 * waits for Retry or Forget. A removal asked by hand clears them.
 */
@Injectable()
export class EnvironmentNetworkRemovals implements OnModuleInit {
  /** The status each running removal found, to put back if it removed nothing. */
  private readonly before = new Map<string, EnvironmentNetworkStatus>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly deployments: DeploymentsService,
    private readonly remoteExec: RemoteExecService,
    private readonly moduleRef: ModuleRef,
    private readonly googleSteps: GoogleNetworkRemovalSteps,
  ) {}

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  onModuleInit(): void {
    this.moduleRef
      .get(CloudReadWorks, { strict: false })
      .handle('network-destroy', (job, control) => this.run(job, control));
  }

  /**
   * The removal's Deployment, the row `deleting`, and its run submitted.
   * Refused while the network is being made or removed. A removal asked by
   * hand clears Cloudgate's own tries at Google's subnet hold (S13); one
   * of those tries (`byCloudgate`) keeps how many are left.
   */
  async start(
    network: EnvironmentNetwork,
    options: { readonly byCloudgate?: boolean } = {},
  ): Promise<StartedRemoval> {
    const name = environmentNetworkName(network.region);
    if (network.status === 'creating' || network.status === 'deleting') {
      throw new ConflictException({
        message: `The ${name} is ${network.status === 'creating' ? 'being made' : 'being removed'}. Wait until its Deployment ends`,
        code: CLOUD_DELETE_REFUSED_CODE,
      });
    }
    const [claimed] = await this.db
      .update(environmentNetwork)
      .set({
        status: 'deleting',
        ...(options.byCloudgate
          ? {}
          : { holdNextTryAt: null, holdTriesLeft: null }),
      })
      .where(
        and(
          eq(
            environmentNetwork.environmentNetworkId,
            network.environmentNetworkId,
          ),
          eq(environmentNetwork.status, network.status),
        ),
      )
      .returning();
    if (!claimed) {
      throw new ConflictException({
        message: `The ${name} changed while it was being removed. Try again`,
        code: CLOUD_DELETE_REFUSED_CODE,
      });
    }
    const retrying = network.status === 'delete-incomplete';
    const cloud = await this.cloudOf(network);
    const run = await this.deployments.recordEnvironmentNetworkRun({
      environmentNetworkId: network.environmentNetworkId,
      title: options.byCloudgate
        ? `Cloudgate's own try at removing the ${name}`
        : retrying
          ? `Retry removing the ${name}`
          : `Remove the ${name}`,
      // What its cloud's removal runs (ADR-0043).
      description: byCloud(cloud, {
        aws: `Destroys everything in the network's Infrastructure state in ${network.region}`,
        gcp: `Destroys everything in the network's Infrastructure state in ${network.region}, then searches Google Cloud for anything left`,
      }),
    });
    this.before.set(run.deploymentId, network.status);
    const ended = this.cloudRuns
      .submit(run.deploymentId, {
        kind: 'network-destroy',
        stateKey: `network:${network.environmentNetworkId}`,
        environmentId: network.environmentId,
        touchesNetwork: true,
      })
      .then(async (ending) => {
        // Cancelled before it destroyed anything: the network is as it was.
        // Any other ending its run did not record leaves it incomplete.
        if (ending.kind === 'cancelled') {
          await this.putBack(run.deploymentId, network.environmentNetworkId);
        } else {
          await this.db
            .update(environmentNetwork)
            .set({ status: 'delete-incomplete' })
            .where(
              and(
                eq(
                  environmentNetwork.environmentNetworkId,
                  network.environmentNetworkId,
                ),
                eq(environmentNetwork.status, 'deleting'),
              ),
            );
        }
        this.before.delete(run.deploymentId);
        return this.ending(
          network.environmentNetworkId,
          ending.kind === 'finished'
            ? (ending.value as NetworkRemovalEnd | undefined)
            : undefined,
          ending.kind === 'cancelled'
            ? 'The removal was cancelled before it changed anything'
            : endingDescription(ending),
        );
      });
    return { deploymentId: run.deploymentId, ended };
  }

  /**
   * Forget: the network's state and row dropped with what is left
   * still in AWS, answering the list, which the Environment's audit entry
   * records. Its Deployments and their logs go with it.
   */
  async discard(network: EnvironmentNetwork): Promise<NetworkLeftover[]> {
    const state = await this.states.findForNetwork(
      network.environmentNetworkId,
    );
    if (state) await this.states.remove(state.infrastructureStateId);
    await this.dropRow(network.environmentNetworkId);
    return [...network.leftovers];
  }

  /** How a removal stands once its run ended. */
  private async ending(
    environmentNetworkId: string,
    value: NetworkRemovalEnd | undefined,
    why: string | null,
  ): Promise<NetworkRemovalEnd> {
    if (value?.removed) return value;
    const [row] = await this.db
      .select()
      .from(environmentNetwork)
      .where(eq(environmentNetwork.environmentNetworkId, environmentNetworkId));
    if (!row) return { removed: true, dnsRecordsLeft: [] };
    return {
      removed: false,
      status: row.status,
      left: row.leftovers,
      unfinished:
        subnetHoldOf(row) ??
        (row.leftovers.length > 0 ? null : (why ?? 'It ended')),
    };
  }

  /** The removal's run, as the pool runs it, read from its Deployment. */
  private async run(
    job: CloudRunJob,
    control: CloudRunControl,
  ): Promise<NetworkRemovalEnd> {
    const [row] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, job.deploymentId ?? ''));
    if (!row?.environmentNetworkId) {
      throw new Error('This Cloud run records no Environment network');
    }
    const [network] = await this.db
      .select()
      .from(environmentNetwork)
      .where(
        eq(environmentNetwork.environmentNetworkId, row.environmentNetworkId),
      );
    if (!network) throw new Error('The Environment network is gone');
    const log = (line: string) => this.cloudRuns.appendLog(row.logPath, line);
    try {
      return await this.remove(network, control, log);
    } catch (error) {
      if (error instanceof NothingRemoved) {
        await log(`❌ [Cloud run] ${error.message}`);
        await this.putBack(row.deploymentId, network.environmentNetworkId);
      }
      throw error;
    }
  }

  private async remove(
    network: EnvironmentNetwork,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<NetworkRemovalEnd> {
    const name = environmentNetworkName(network.region);
    const still = await this.servicesIn(network);
    if (still.length > 0) {
      throw new NothingRemoved(
        `The ${name} is kept: ${still.join(', ')} still ${still.length === 1 ? 'runs' : 'run'} in it. Nothing was removed`,
      );
    }
    const cloudAccountRow = await this.cloudAccounts.findForUse(
      network.cloudAccountId,
    );
    if (!cloudAccountRow) {
      throw new NothingRemoved(
        'The Cloud account this network is in is gone. Nothing was removed',
      );
    }
    // Each cloud's half (ADR-0043).
    return onCloud(cloudAccountRow, {
      aws: (account) => this.removeOnAws(network, account, control, log),
      gcp: async (account) =>
        this.removedOnGoogle(
          network,
          await this.googleSteps.run(network, account, control, log),
          log,
        ),
    });
  }

  /** The network's removal on AWS: its state destroyed, then what is left looked for. */
  private async removeOnAws(
    network: EnvironmentNetwork,
    account: AwsCloudAccount,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<NetworkRemovalEnd> {
    const name = environmentNetworkName(network.region);
    const reached = await this.cloudAccounts.deployRoleSession(account);
    if (!reached.ok) {
      throw new NothingRemoved(`${reached.refusal}. Nothing was removed`);
    }
    const state = await this.states.findForNetwork(
      network.environmentNetworkId,
    );

    let show: TofuShow | null = null;
    let unfinished: string | null = null;
    if (state) {
      await log(
        `🗑️ [Cloud run] Removing the ${name} from Cloud account ${account.name}: destroying everything in Infrastructure state ${state.infrastructureStateId}`,
      );
      let began = false;
      const outcome = await this.states.destroy({
        stateId: state.infrastructureStateId,
        credential: credentialOf(account),
        definition: destroyDefinition(
          {
            awsAccountId: account.cloudId,
            deployRoleArn: account.deployRoleArn,
            externalId: account.externalId,
          },
          network.region,
          {
            cloudAccountId: account.cloudAccountId,
            environmentId: network.environmentId,
            stateId: state.infrastructureStateId,
          },
        ),
        onLine: (line) => void log(line),
        signal: control.signal,
        beforeApply: () => {
          if (control.beginApply()) {
            began = true;
            return null;
          }
          return ENDED_BEFORE_DESTROYING;
        },
      });
      if (outcome.ok) {
        show = outcome.show;
      } else if (CHANGED_NOTHING.has(outcome.reason)) {
        throw new NothingRemoved(`${outcome.message} Nothing was removed`);
      } else {
        unfinished = began
          ? outcome.message
          : `${outcome.message} The run ended before it destroyed anything`;
      }
    } else {
      await log(
        `🗑️ [Cloud run] The ${name} has no Infrastructure state: nothing was made for it in AWS`,
      );
    }

    let left: Leftover[] = [];
    if (control.signal.killed) {
      unfinished ??= 'The run was killed before it could check what is left';
    } else if (state) {
      await log('🔎 [Cloud run] Checking AWS for anything left');
      const session = await this.cloudAccounts.deployRoleSession(account);
      const held = heldByState(show);
      const check = !session.ok
        ? { ok: false as const, message: session.refusal }
        : await findLeftovers(this.cloud, session.session, {
            region: network.region,
            stateId: state.infrastructureStateId,
            iamRoleNames: held.iamRoleNames,
            securityGroupIds: [
              ...held.securityGroupIds,
              ...(network.albSecurityGroupId
                ? [network.albSecurityGroupId]
                : []),
            ],
          });
      if (check.ok) left = check.left;
      else unfinished ??= `What is left could not be checked: ${check.message}`;
    }

    for (const line of deleteReportLines(
      { kept: [], left },
      CLEAN_NETWORK_REMOVAL_LINE,
    )) {
      await log(line);
    }
    if (unfinished === null && left.length === 0) {
      for (const line of dnsReminder(network.dnsRecordsLeft)) await log(line);
      if (state) await this.states.remove(state.infrastructureStateId);
      await this.dropRow(network.environmentNetworkId);
      return { removed: true, dnsRecordsLeft: network.dnsRecordsLeft };
    }
    await this.db
      .update(environmentNetwork)
      .set({ status: 'delete-incomplete', leftovers: left })
      .where(
        eq(
          environmentNetwork.environmentNetworkId,
          network.environmentNetworkId,
        ),
      );
    const summary = `Delete incomplete: ${
      left.length > 0
        ? `${left.length} resource${left.length === 1 ? ' is' : 's are'} left in AWS`
        : unfinished
    }. Retry destroys again from the kept state`;
    await log(`⚠️ [Cloud run] ${summary}`);
    throw new Error(summary);
  }

  /**
   * What the Google steps ended with, written as the AWS run writes its
   * own. A held removal keeps Cloudgate's own next try about 2 hours on
   * while it has tries left (S13): the first held removal starts with
   * {@link HOLD_TRIES}, and each of its own tries took one already.
   */
  private async removedOnGoogle(
    network: EnvironmentNetwork,
    outcome: GoogleNetworkRemovalOutcome,
    log: (line: string) => Promise<void>,
  ): Promise<NetworkRemovalEnd> {
    if (outcome.kind === 'nothing-removed') {
      throw new NothingRemoved(outcome.message);
    }
    if (outcome.kind === 'clean') {
      for (const line of dnsReminder(network.dnsRecordsLeft)) await log(line);
      if (outcome.stateId) await this.states.remove(outcome.stateId);
      await this.dropRow(network.environmentNetworkId);
      return { removed: true, dnsRecordsLeft: network.dnsRecordsLeft };
    }
    const { left, held } = outcome;
    const triesLeft = held ? (network.holdTriesLeft ?? HOLD_TRIES) : null;
    const nextTryAt =
      triesLeft !== null && triesLeft > 0
        ? new Date(Date.now() + HOLD_RETRY_AFTER_MS).toISOString()
        : null;
    await this.db
      .update(environmentNetwork)
      .set({
        status: 'delete-incomplete',
        leftovers: left,
        holdNextTryAt: nextTryAt,
        holdTriesLeft: triesLeft,
      })
      .where(
        eq(
          environmentNetwork.environmentNetworkId,
          network.environmentNetworkId,
        ),
      );
    const summary = held
      ? `Delete incomplete: ${subnetHoldSentence(left, nextTryAt)}`
      : `Delete incomplete: ${
          left.length > 0
            ? `${left.length} resource${left.length === 1 ? ' is' : 's are'} left in Google Cloud`
            : outcome.unfinished
        }. Retry destroys again from the kept state`;
    await log(`⚠️ [Cloud run] ${summary}`);
    throw new Error(summary);
  }

  /** The cloud the network is in, by the seam's rule when its Cloud account is gone. */
  private async cloudOf(network: EnvironmentNetwork): Promise<CloudKind> {
    const row = await this.cloudAccounts.findForUse(network.cloudAccountId);
    return cloudOrLegacy(row?.cloud);
  }

  /** The Services of the network's Environment that still run in its place. */
  private async servicesIn(network: EnvironmentNetwork): Promise<string[]> {
    return (await cloudServicesIn(this.db, network.environmentId))
      .filter(
        (one) =>
          one.cloudAccountId === network.cloudAccountId &&
          one.region === network.region,
      )
      .map((one) => one.name);
  }

  /** The row, its Deployments with it, and their logs on the platform host. */
  private async dropRow(environmentNetworkId: string): Promise<void> {
    await reclaimDeploymentLogs(this.remoteExec, [
      {
        appName: environmentNetworkLogOwner(environmentNetworkId),
        serverId: null,
      },
    ]);
    await this.db
      .delete(environmentNetwork)
      .where(eq(environmentNetwork.environmentNetworkId, environmentNetworkId));
  }

  /** Back to how the network was before this run: nothing was removed. */
  private async putBack(
    deploymentId: string,
    environmentNetworkId: string,
  ): Promise<void> {
    await this.db
      .update(environmentNetwork)
      .set({ status: this.before.get(deploymentId) ?? 'delete-incomplete' })
      .where(
        and(
          eq(environmentNetwork.environmentNetworkId, environmentNetworkId),
          eq(environmentNetwork.status, 'deleting'),
        ),
      );
  }
}

/** The lines naming the DNS records a removed network's Domains left. */
export function dnsReminder(records: readonly DnsRecord[]): string[] {
  if (records.length === 0) return [];
  return [
    'Cloudgate never writes DNS, so remove these records its Domains left at your DNS provider:',
    ...records.map((record) => `  ${dnsRecordLine(record)}`),
  ];
}

const ENDED_BEFORE_DESTROYING: TofuFailure = {
  ok: false,
  reason: 'interrupted',
  message: 'The run was ended before it destroyed anything.',
};
