import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, desc, eq, ne, sql } from 'drizzle-orm';

import { makeDefaultCertificate } from '../../cloud-accounts/definitions/default-certificate';
import {
  NETWORK_OUTPUTS,
  networkDefinition,
} from '../../cloud-accounts/aws/definitions/network-definition';
import { DEFAULT_CERTIFICATE_VARIABLES } from '../../cloud-accounts/definitions/default-certificate';
import { withImports } from '../../cloud-accounts/aws/definitions/imports';
import { readPlan } from '../../cloud-accounts/aws/plan-reader/read-plan';
import { cloudOrLegacy, onCloud } from '../../cloud-accounts/cloud-provider';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../../cloud-accounts/cloud-provider';
import type { PlanReading } from '../../cloud-accounts/aws/plan-reader/read-plan';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import { CLOUD_NAMES } from '../../cloud-accounts/cloud-provider';
import type {
  TofuApplyRequest,
  TofuCredential,
  TofuFailure,
  TofuShow,
} from '../../cloud-accounts/cloud.port';
import { googleRefusalReason } from '../../cloud-accounts/gcp/api-off';
import { withGoogleImports } from '../../cloud-accounts/gcp/definitions/imports';
import {
  GCP_NETWORK_OUTPUTS,
  networkDefinition as googleNetworkDefinition,
} from '../../cloud-accounts/gcp/definitions/network-definition';
import { linksAfter } from '../../cloud-accounts/definitions/network-links';
import type { NetworkLinkKind } from '../../cloud-accounts/definitions/network-links';
import { RUN_APP_ZONE_PART } from '../../cloud-accounts/gcp/definitions/run-app-zone';
import { CLOUD_NAT_PART } from '../../cloud-accounts/gcp/definitions/cloud-nat';
import { readGooglePlan } from '../../cloud-accounts/gcp/plan-reader/read-plan';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import type { InfrastructureState } from '../../cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { stateProviderOf } from '../../cloud-accounts/infrastructure-state/state-versions';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { deployment, environmentNetwork, plan } from '../../db/schema';
import type { EnvironmentNetwork, Plan } from '../../db/schema';
import type { DrizzleTx } from '../../environments/config-name';
import { CloudReadWorks } from '../../deployment-queue/cloud-read-work';
import type {
  CloudRunControl,
  CloudRunEnding,
  CloudRunJob,
} from '../../deployment-queue/cloud-run-job.types';
import {
  CloudRunsService,
  endingDescription,
} from '../../deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../../deployments/deployments.service';
import { environmentNetworkName } from '../../deployments/service-scope';
import { CloudPlanReads } from '../cloud-plan-reads.service';
import { AwsPlanReads } from '../aws-plan-reads.service';
import { credentialOf } from '../../cloud-accounts/cloud-provider';
import { describeError } from '../../common/describe-error';
import { networkBusy } from '../plan-errors';
import { PlanStore } from '../plan-store.service';
import { isCloudCreate, isNetworkStep } from '../planner/cloud-steps';
import type { PlanStep } from '../planner/plan.types';
import type { PlanStepNetwork, PlanStepResult } from './apply.types';
import { networkDomains } from './google-network-domains';
import { emptyResult } from './plan-applier';
import { changesDiffer } from './same-changes';
import { InstanceMode } from '../../instance-mode/instance-mode.service';

type NetworkStep = Extract<PlanStep, { action: 'network-create' }>;
type NetworkChange = Extract<PlanStep, { action: 'network-change' }>;

/** The ids an AWS network's run saves, as its row stores them. */
type SavedIds = Pick<
  EnvironmentNetwork,
  | 'vpcId'
  | 'publicSubnetIds'
  | 'privateSubnetIds'
  | 'clusterArn'
  | 'albArn'
  | 'albDnsName'
  | 'albZoneId'
  | 'httpsListenerArn'
  | 'albSecurityGroupId'
  | 'defaultCertificateArn'
  | 'privateDnsNamespaceId'
>;

/** What a Google network's run saves: Google's outputs (the Google Cloud spec). */
type SavedOutputs = Pick<
  EnvironmentNetwork,
  | 'networkName'
  | 'subnetName'
  | 'ipAddress'
  | 'urlMapName'
  | 'certificateMapName'
>;

/**
 * One cloud's half of a network's apply: what `tofu` is handed, how its
 * fresh plan reads, and what the row keeps of its outputs. The apply itself
 * is the definition's whole, whatever it holds (slice 7 adds its PSC pieces
 * to Google's), so nothing here names a resource.
 */
interface NetworkApply {
  readonly request: Pick<
    TofuApplyRequest<TofuCredential>,
    'credential' | 'definition' | 'variables'
  >;
  /** The fresh plan, as this cloud's reader reads it. */
  readonly read: (show: TofuShow) => PlanReading;
  /** The row's columns from `tofu output -json`, or `null` if one is missing. */
  readonly saved: (
    outputs: Record<string, unknown>,
  ) => SavedIds | SavedOutputs | null;
  /** Where the made network's load balancer answers, for its log. */
  readonly answersAt: (saved: SavedIds | SavedOutputs) => string;
  /** The cloud, as a refusal names it. */
  readonly cloudName: string;
  /** A failed run's words, as its cloud's refusals are worded. */
  readonly failure: (message: string) => string;
}

/** A network run the Apply started, and how it will end. */
export interface StartedNetwork {
  readonly result: PlanStepResult;
  readonly network: PlanStepNetwork;
  readonly ending: Promise<CloudRunEnding>;
}

/** What the Apply that started a network run leaves to its end. */
export interface AfterTheNetwork {
  /** The rest of the steps, once the network is made and nothing differs. */
  readonly applyTheRest: (network: PlanStepResult) => Promise<void>;
  /**
   * Stores the plan's config text, in the transaction that ends the Apply
   * otherwise: what is left is what the next plan of it shows (US28).
   */
  readonly keepText: (tx: DrizzleTx) => Promise<void>;
}

/** Said on each step an Apply did not reach because Cloudgate restarted. */
const RESTARTED =
  'Not applied: Cloudgate restarted during this Apply. The Environment network’s run is its own Deployment, which says how it ended; Check for changes, then apply the new plan';

/**
 * **Apply makes the Environment network first** (the AWS spec "Ordering inside
 * an Apply").
 *
 * An Apply whose plan has a network step writes the network's row
 * (`creating`), keeps the Infrastructure state its plan was read against,
 * and records the run as a Deployment whose parent is the network (ADR-0017
 * extended), with its own Deployment log. The run waits in the Cloud run
 * pool as a `network` run, so it holds back every other Cloud run of the
 * Environment, and runs the network generator's definition.
 * Before it changes anything it reads the cloud again, and applies only if
 * that plan makes what the Apply approved. When it succeeds the network's
 * ids are saved on the row, `ready`: on AWS the VPC, subnets, cluster, load
 * balancer and its DNS name, listener, its security group and default
 * certificate; on Google Cloud (the Google Cloud spec) the VPC's and subnet's
 * names, the fixed IP, and the URL map's and certificate map's names. The
 * run dispatches on the network's Cloud account: a Google one signs its own
 * 2-hour proof (S16) and applies through the Google client port, its state
 * written with the Google provider.
 *
 * Then each cloud Service step is planned again with the real ids (a read
 * in the pool, keeping the state and Service ids its plan showed), and the
 * Apply goes on only if each still makes exactly what was shown. Otherwise
 * it stops there: the plan ends `partly-applied`, and what was planned
 * again is the Environment's new open plan.
 *
 * **The Apply answers while the network is made**, which takes minutes:
 * the plan is claimed and its results say the network is `running`, and
 * they are written again when the rest has run. A restart part-way leaves
 * the run to the pool's start-up rules and ends the Apply, saying so.
 *
 * **A made network's Drift is put back by its own run**: the Apply
 * of a plan whose network step found AWS differing records a Deployment of
 * the network and queues it, as a `network` run, applying exactly what
 * that read showed. It answers at once; the run's Deployment says how it
 * ended. What a read adopts by tag is imported (`import` blocks).
 */
@Injectable()
export class EnvironmentNetworkRuns
  implements OnModuleInit, OnApplicationBootstrap
{
  private readonly logger = new Logger(EnvironmentNetworkRuns.name);
  /**
   * What each started run's Apply approved, by its Deployment, until the run
   * reads it. After a restart a run finds it on its plan's results instead.
   */
  private readonly approved = new Map<string, ApprovedNetwork>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly reads: CloudPlanReads,
    private readonly awsReads: AwsPlanReads,
    private readonly deployments: DeploymentsService,
    private readonly plans: PlanStore,
    private readonly moduleRef: ModuleRef,
    private readonly instanceMode: InstanceMode,
  ) {}

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  onModuleInit(): void {
    this.moduleRef
      .get(CloudReadWorks, { strict: false })
      .handle('network', (job, control) => this.run(job, control));
  }

  /** Start-up: what a restart cut off is said, never left `creating`. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.settleAtStartUp();
    } catch (error) {
      this.logger.error(
        `Environment network Applies could not be settled at start-up: ${describeError(error)}`,
      );
    }
  }

  /** An Apply is refused while another Apply is making the same network. */
  async refuseBusy(environmentId: string, step: NetworkStep): Promise<void> {
    const row = await this.placeRow(environmentId, step);
    if (row?.status === 'creating') throw networkBusy(step.region);
  }

  /**
   * The network's row, its state and its Deployment, and its run submitted
   * to the pool. A network whose create failed is the same row and state
   * again, so its run finishes what the last one made.
   */
  async start(
    environmentId: string,
    step: NetworkStep,
  ): Promise<StartedNetwork> {
    if (step.cloudRead.status !== 'read') {
      throw new Error('The Environment network was not read from its cloud');
    }
    const account = await this.cloudAccounts.findForUse(step.cloudAccountId);
    if (!account) {
      throw new Error('The Cloud account this network uses is gone');
    }
    const network = await this.claimRow(environmentId, step);
    const state =
      (await this.states.findForNetwork(network.environmentNetworkId)) ??
      (await this.states.create(
        { environmentNetworkId: network.environmentNetworkId },
        step.cloudRead.stateId,
        stateProviderOf(account.cloud),
      ));
    const record = await this.deployments.recordEnvironmentNetworkRun({
      environmentNetworkId: network.environmentNetworkId,
      title: `Make the ${environmentNetworkName(step.region)}`,
      description: `Applied from a plan, into Infrastructure state ${state.infrastructureStateId}`,
    });
    this.approved.set(record.deploymentId, approvedOf(step, step.cloudRead));
    const ids: PlanStepNetwork = {
      environmentNetworkId: network.environmentNetworkId,
      deploymentId: record.deploymentId,
    };
    const ending = this.cloudRuns.submit(record.deploymentId, {
      kind: 'network',
      stateKey: `network:${network.environmentNetworkId}`,
      environmentId,
      touchesNetwork: true,
    });
    return {
      network: ids,
      result: networkResult(step.region, ids, 'running', null),
      ending,
    };
  }

  /**
   * Queues the run that puts a made network back to Cloudgate's version in
   * its cloud: its Deployment recorded, and the run submitted to the
   * pool. The step's result names the run; it is `applied` once queued.
   */
  async putBack(
    environmentId: string,
    step: NetworkChange,
  ): Promise<PlanStepResult> {
    const base = emptyResult(
      environmentNetworkName(step.region),
      'network-change',
    );
    const [network] = await this.db
      .select()
      .from(environmentNetwork)
      .where(
        eq(environmentNetwork.environmentNetworkId, step.environmentNetworkId),
      );
    if (step.cloudRead.status !== 'read' || network?.status !== 'ready') {
      return {
        ...base,
        message: `Not applied: the ${environmentNetworkName(step.region)} is not made, or was not read. Check for changes, then apply the new plan`,
      };
    }
    // A network gaining a private link is the same
    // run, said so.
    const linking = (step.privateLinks ?? []).length > 0;
    // Its NAT taken off once no Stack VM needs it (#1367).
    const unlinking = (step.removedLinks ?? []).length > 0;
    const account = await this.cloudAccounts.findForUse(network.cloudAccountId);
    const cloud = CLOUD_NAMES[cloudOrLegacy(account?.cloud)];
    const link = linkWords(step.privateLinks ?? []);
    const unlink = linkWords(step.removedLinks ?? []);
    const record = await this.deployments.recordEnvironmentNetworkRun({
      environmentNetworkId: network.environmentNetworkId,
      title: linking
        ? `Add ${link.parts} to the ${environmentNetworkName(step.region)}`
        : unlinking
          ? `Take ${unlink.parts} off the ${environmentNetworkName(step.region)}`
          : `Put the ${environmentNetworkName(step.region)} back`,
      description: linking
        ? `Applied from a plan: ${link.phrase} ${link.verb} added, Infrastructure state ${step.cloudRead.stateId}`
        : unlinking
          ? `Applied from a plan: ${unlink.phrase} ${unlink.verb} taken off, since the Environment has no Stack VM left, Infrastructure state ${step.cloudRead.stateId}`
          : `Applied from a plan: Cloudgate's version is put back in ${cloud}, Infrastructure state ${step.cloudRead.stateId}`,
    });
    this.approved.set(record.deploymentId, approvedOf(step, step.cloudRead));
    void this.cloudRuns
      .submit(record.deploymentId, {
        kind: 'network',
        stateKey: `network:${network.environmentNetworkId}`,
        environmentId,
        touchesNetwork: true,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `The run putting back ${environmentNetworkName(step.region)} failed to settle: ${describeError(error)}`,
        ),
      )
      .finally(() => this.approved.delete(record.deploymentId));
    const ids: PlanStepNetwork = {
      environmentNetworkId: network.environmentNetworkId,
      deploymentId: record.deploymentId,
    };
    return {
      ...base,
      status: 'applied',
      network: ids,
      deploy: { status: 'queued', deploymentId: record.deploymentId },
    };
  }

  /**
   * The rest of an Apply once its network run ended: stopped there if the
   * network was not made; otherwise each cloud Service step planned again
   * with the network's ids, and the rest applied only if each makes what
   * the plan showed. Never throws; a fault of Cloudgate's own fails the
   * Apply.
   */
  async continueApply(
    row: Plan,
    step: NetworkStep,
    started: StartedNetwork,
    after: AfterTheNetwork,
  ): Promise<void> {
    try {
      const ending = await started.ending;
      this.approved.delete(started.network.deploymentId);
      if (ending.kind !== 'finished') {
        await this.markFailed(started.network.environmentNetworkId);
        const why =
          ending.kind === 'cancelled'
            ? 'Its run was cancelled before it changed anything'
            : (endingDescription(ending) ?? 'Its run ended');
        await this.endApply(
          row,
          [
            networkResult(step.region, started.network, 'failed', why),
            ...notApplied(
              row.steps,
              'Not applied: the Environment network was not made',
            ),
          ],
          after.keepText,
        );
        return;
      }
      const made = networkResult(step.region, started.network, 'applied', null);
      const planned = await this.planAgain(row);
      if (planned.differences.length === 0) {
        await after.applyTheRest(made);
        return;
      }
      await this.leaveNewPlan(row, planned, made, after.keepText);
    } catch (error) {
      this.logger.error(
        `Plan ${row.planId}: the Apply after its Environment network failed: ${describeError(error)}`,
      );
      await this.endApply(
        row,
        [
          networkResult(
            step.region,
            started.network,
            'failed',
            describeError(error),
          ),
          ...notApplied(row.steps, `Not applied: ${describeError(error)}`),
        ],
        after.keepText,
      ).catch(() => undefined);
    }
  }

  /**
   * The network's Cloud run, as the pool runs it: everything it needs is
   * read from its Deployment, so a run queued again at start-up runs alike.
   * Any ending but the ids saved leaves the network `create-failed`.
   */
  private async run(
    job: CloudRunJob,
    control: CloudRunControl,
  ): Promise<SavedIds | SavedOutputs> {
    const [row] = await this.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, job.deploymentId ?? ''));
    if (!row?.environmentNetworkId) {
      throw new Error('This Cloud run records no Environment network');
    }
    try {
      return await this.make(
        row.deploymentId,
        row.environmentNetworkId,
        row.logPath,
        control,
      );
    } catch (error) {
      await this.markFailed(row.environmentNetworkId);
      throw error;
    }
  }

  private async make(
    deploymentId: string,
    environmentNetworkId: string,
    logPath: string,
    control: CloudRunControl,
  ): Promise<SavedIds | SavedOutputs> {
    const log = (line: string) => this.cloudRuns.appendLog(logPath, line);
    const [network] = await this.db
      .select()
      .from(environmentNetwork)
      .where(eq(environmentNetwork.environmentNetworkId, environmentNetworkId));
    if (!network) throw new Error('The Environment network is gone');
    const approved =
      this.approved.get(deploymentId) ??
      (await this.approvedOnPlan(deploymentId, environmentNetworkId));
    if (!approved) {
      throw new Error(
        'No applied plan names this run, so it changes nothing. Check for changes, then apply the new plan',
      );
    }
    const account = await this.cloudAccounts.findForUse(network.cloudAccountId);
    if (!account)
      throw new Error('The Cloud account this network uses is gone');
    const state = await this.states.findForNetwork(environmentNetworkId);
    if (!state) throw new Error('The Environment network has no state');
    // The private link the network holds and the kinds this run adds,
    // without the ones it takes off.
    const privateLinks = linksAfter(network.privateLinks, approved);
    // Each cloud's half (ADR-0043).
    const run = await onCloud(account, {
      aws: (onAws) =>
        this.onAws(onAws, network, state, approved.reading, privateLinks),
      gcp: (onGoogle) =>
        this.onGoogle(onGoogle, network, state, approved.reading, privateLinks),
    });

    const added = privateLinks.filter(
      (kind) => !network.privateLinks.includes(kind),
    );
    const adding = added.length > 0;
    const link = linkWords(added);
    const taken = network.privateLinks.filter(
      (kind) => !privateLinks.includes(kind),
    );
    await log(
      network.status !== 'ready'
        ? `Making the ${environmentNetworkName(network.region)} in Cloud account ${account.name}, Infrastructure state ${state.infrastructureStateId}`
        : adding
          ? `Adding ${link.phrase} to the ${environmentNetworkName(network.region)} in Cloud account ${account.name}, Infrastructure state ${state.infrastructureStateId}`
          : taken.length > 0
            ? `Taking ${linkWords(taken).phrase} off the ${environmentNetworkName(network.region)} in Cloud account ${account.name}: no Stack VM needs it any more. Infrastructure state ${state.infrastructureStateId}`
            : `Putting the ${environmentNetworkName(network.region)} back to Cloudgate's version in Cloud account ${account.name}, Infrastructure state ${state.infrastructureStateId}`,
    );
    const outcome = await this.states.apply({
      stateId: state.infrastructureStateId,
      ...run.request,
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: (show) =>
        beforeApply(approved.reading, run.read(show), control, run.cloudName),
    });
    if (!outcome.ok) throw new Error(run.failure(outcome.message));
    const saved = run.saved(outcome.outputs);
    if (!saved) {
      throw new Error(
        'The Environment network was made, but OpenTofu did not answer all of its ids. Check for changes to read it again',
      );
    }
    await this.db
      .update(environmentNetwork)
      .set({
        ...saved,
        status: 'ready',
        // Kept from now on, so every later run writes the link again.
        privateLinks,
      })
      .where(eq(environmentNetwork.environmentNetworkId, environmentNetworkId));
    await log(
      `The ${environmentNetworkName(network.region)} is made; its load balancer answers at ${run.answersAt(saved)}`,
    );
    return saved;
  }

  /**
   * An AWS network's apply: the Cloud account's key, and the ids it saves.
   * The private DNS namespace the network holds, or this run adds, is
   * written with it.
   */
  private async onAws(
    account: AwsCloudAccount,
    network: EnvironmentNetwork,
    state: InfrastructureState,
    approved: PlanReading,
    privateLinks: readonly NetworkLinkKind[],
  ): Promise<NetworkApply> {
    const credential = credentialOf(account);
    const refused = await this.awsReads.credentialRefusal(account, credential);
    if (refused) throw new Error(refused);
    const certificate = makeDefaultCertificate();
    return {
      request: {
        credential,
        // What the Apply adopts by tag is imported, not made again.
        definition: withImports(
          networkDefinition({
            cloudAccountId: account.cloudAccountId,
            account: {
              awsAccountId: account.cloudId,
              deployRoleArn: account.deployRoleArn,
              externalId: account.externalId,
            },
            region: network.region,
            environmentId: network.environmentId,
            stateId: state.infrastructureStateId,
            privateLinks,
            // A hosted cloud build's standing pieces, as the plan read.
            cloudBuilds: this.instanceMode.isHosted,
          }),
          approved.adopt,
        ),
        variables: {
          [DEFAULT_CERTIFICATE_VARIABLES.certificate]:
            certificate.certificatePem,
          [DEFAULT_CERTIFICATE_VARIABLES.privateKey]: certificate.privateKeyPem,
        },
      },
      read: (show) => readPlan({ show, tagSearch: [], context: {} }),
      saved: (outputs) => savedIds(outputs, privateLinks),
      answersAt: (saved) => (saved as SavedIds).albDnsName ?? '',
      cloudName: 'AWS',
      failure: (message) => message,
    };
  }

  /**
   * A Google network's apply (the Google Cloud spec): the run's own 2-hour proof
   * (S16), the network generator's definition with what the plan adopted by
   * name imported, and Google's outputs saved. The private
   * link the network holds and the kinds this run adds are written with it.
   * A sign-in that fails is the Cloud account's refusal, before
   * `tofu` runs.
   */
  private async onGoogle(
    account: GcpCloudAccount,
    network: EnvironmentNetwork,
    state: InfrastructureState,
    approved: PlanReading,
    privateLinks: readonly NetworkLinkKind[],
  ): Promise<NetworkApply> {
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) throw new Error(session.refusal);
    const certificate = makeDefaultCertificate();
    return {
      request: {
        credential: session.credential,
        definition: withGoogleImports(
          googleNetworkDefinition({
            cloudAccountId: account.cloudAccountId,
            projectId: account.cloudId,
            region: network.region,
            environmentId: network.environmentId,
            stateId: state.infrastructureStateId,
            // Every Domain on the network as the database holds it, so a
            // run of the network never takes one off.
            domains: await networkDomains(this.db, network),
            privateLinks,
            // A hosted cloud build's source bucket, as the plan read.
            cloudBuilds: this.instanceMode.isHosted,
          }),
          approved.adopt,
        ),
        variables: {
          [DEFAULT_CERTIFICATE_VARIABLES.certificate]:
            certificate.certificatePem,
          [DEFAULT_CERTIFICATE_VARIABLES.privateKey]: certificate.privateKeyPem,
        },
      },
      read: (show) => readGooglePlan({ show, nameSearch: [], context: {} }),
      saved: savedOutputs,
      answersAt: (saved) => (saved as SavedOutputs).ipAddress ?? '',
      cloudName: 'Google Cloud',
      failure: (message) => googleRefusalReason(message, account.cloudId),
    };
  }

  /** What the plan whose Apply recorded this run approved for its network. */
  private async approvedOnPlan(
    deploymentId: string,
    environmentNetworkId: string,
  ): Promise<ApprovedNetwork | null> {
    const [found] = await this.db
      .select({ steps: plan.steps })
      .from(plan)
      .where(
        sql`jsonb_contains(${plan.results}, ${JSON.stringify([{ network: { deploymentId } }])}::jsonb)`,
      )
      .limit(1);
    // The network's create, or its put-back: a plan has one of them per
    // network, and may take a NAT off another network (#1367).
    const steps = (found?.steps ?? []).filter(
      (one): one is NetworkStep | NetworkChange =>
        one.action === 'network-create' || one.action === 'network-change',
    );
    const step =
      steps.find(
        (one) =>
          one.action === 'network-change' &&
          one.environmentNetworkId === environmentNetworkId,
      ) ?? steps.find((one) => one.action === 'network-create');
    return step?.cloudRead.status === 'read'
      ? approvedOf(step, step.cloudRead)
      : null;
  }

  /**
   * Each step but the network's as the rest of the Apply would run it, a
   * cloud create planned again with the network's saved ids, and every way
   * one no longer makes what the plan showed.
   */
  private async planAgain(
    row: Plan,
  ): Promise<{ steps: PlanStep[]; differences: string[] }> {
    const steps: PlanStep[] = [];
    const differences: string[] = [];
    for (const [index, step] of row.steps.entries()) {
      if (step.action === 'network-create') continue;
      if (!isCloudCreate(step)) {
        steps.push(step);
        continue;
      }
      const cloudRead = await this.reads.reread(
        row.environmentId,
        `apply:${row.planId}:${index}`,
        step,
        row.steps,
      );
      steps.push({ ...step, cloudRead });
      if (cloudRead.status !== 'read') {
        differences.push(
          `${step.configName} could not be read again (${cloudRead.status === 'failed' ? cloudRead.reason : 'still reading'})`,
        );
        continue;
      }
      const shown = step.cloudRead?.status === 'read' ? step.cloudRead : null;
      const differs = shown
        ? changesDiffer(shown, cloudRead)
        : 'it was not read';
      if (differs) differences.push(`${step.configName}: ${differs}`);
    }
    return { steps, differences };
  }

  /**
   * Stops the Apply after its network: the plan ends
   * `partly-applied`, and what was planned again becomes the Environment's
   * open plan, read against what the Apply read, so its own Apply checks
   * staleness alike.
   */
  private async leaveNewPlan(
    row: Plan,
    { steps, differences }: { steps: PlanStep[]; differences: string[] },
    made: PlanStepResult,
    keepText: AfterTheNetwork['keepText'],
  ): Promise<void> {
    const message = `Not applied: planned again with the Environment network’s ids, this plan no longer makes what it showed (${differences.join('; ')}). Review the new open plan, then apply it`;
    await this.db.transaction(async (tx) => {
      await keepText(tx);
      await tx
        .update(plan)
        .set({
          status: 'partly-applied',
          results: [made, ...notApplied(row.steps, message)],
        })
        .where(eq(plan.planId, row.planId));
      await this.plans.store(
        tx,
        row.appliedBy,
        {
          environmentId: row.environmentId,
          steps,
          notes: [...row.notes],
          settingsFingerprint: row.settingsFingerprint,
          deployTarget: row.deployTarget ?? { kind: 'platform-host' },
          outline: row.outline ?? { services: {} },
        },
        {
          text: row.text,
          textHash: row.textHash,
          baseTextHash: row.baseTextHash,
          commitSha: row.commitSha,
          branch: row.branch,
        },
        { source: row.source },
      );
    });
    await this.plans.releaseHeld([row.environmentId]);
  }

  /**
   * The Apply ends here, `partly-applied`, with these results, its text
   * kept when the Apply that started it is the one ending it.
   */
  private async endApply(
    row: Plan,
    results: PlanStepResult[],
    keepText?: AfterTheNetwork['keepText'],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await keepText?.(tx);
      await tx
        .update(plan)
        .set({ status: 'partly-applied', results })
        .where(eq(plan.planId, row.planId));
    });
    await this.plans.releaseHeld([row.environmentId]);
  }

  /** The network's row for its place, made `creating` for this Apply. */
  private async claimRow(
    environmentId: string,
    step: NetworkStep,
  ): Promise<EnvironmentNetwork> {
    const existing = await this.placeRow(environmentId, step);
    if (existing) {
      const [claimed] = await this.db
        .update(environmentNetwork)
        .set({ status: 'creating', leftovers: [] })
        .where(
          and(
            eq(
              environmentNetwork.environmentNetworkId,
              existing.environmentNetworkId,
            ),
            eq(environmentNetwork.status, 'create-failed'),
          ),
        )
        .returning();
      if (!claimed) throw networkBusy(step.region);
      return claimed;
    }
    const [created] = await this.db
      .insert(environmentNetwork)
      .values({
        environmentId,
        cloudAccountId: step.cloudAccountId,
        region: step.region,
        status: 'creating',
      })
      .onConflictDoNothing()
      .returning();
    if (!created) throw networkBusy(step.region);
    return created;
  }

  private async placeRow(
    environmentId: string,
    step: NetworkStep,
  ): Promise<EnvironmentNetwork | null> {
    const [row] = await this.db
      .select()
      .from(environmentNetwork)
      .where(
        and(
          eq(environmentNetwork.environmentId, environmentId),
          eq(environmentNetwork.cloudAccountId, step.cloudAccountId),
          eq(environmentNetwork.region, step.region),
        ),
      );
    return row ?? null;
  }

  private async markFailed(environmentNetworkId: string): Promise<void> {
    await this.db
      .update(environmentNetwork)
      .set({ status: 'create-failed' })
      .where(
        and(
          eq(environmentNetwork.environmentNetworkId, environmentNetworkId),
          eq(environmentNetwork.status, 'creating'),
        ),
      );
  }

  /**
   * After a restart: a network `creating` with no run waiting to make it
   * failed; an Apply whose network was still `running` ended, its steps
   * said not applied. A run queued again still makes its network, which
   * the next plan then finds.
   */
  private async settleAtStartUp(): Promise<void> {
    const creating = await this.db
      .select({ id: environmentNetwork.environmentNetworkId })
      .from(environmentNetwork)
      .where(eq(environmentNetwork.status, 'creating'));
    for (const { id } of creating) {
      const [latest] = await this.db
        .select({ status: deployment.status })
        .from(deployment)
        .where(eq(deployment.environmentNetworkId, id))
        .orderBy(desc(deployment.createdAt))
        .limit(1);
      if (latest?.status !== 'pending') await this.markFailed(id);
    }
    const cutOff = await this.db
      .select()
      .from(plan)
      .where(
        and(
          ne(plan.status, 'open'),
          sql`jsonb_contains(${plan.results}, ${JSON.stringify([{ status: 'running' }])}::jsonb)`,
        ),
      );
    for (const row of cutOff) {
      await this.endApply(row, [
        ...(row.results ?? []).map((result) =>
          result.status === 'running'
            ? { ...result, status: 'failed' as const, message: RESTARTED }
            : result,
        ),
        ...notApplied(row.steps, RESTARTED),
      ]);
    }
  }
}

/**
 * What an Apply approved for a network's run: its read, and the kinds of
 * private link its step adds, which the run writes with the ones the
 * network holds.
 */
interface ApprovedNetwork {
  readonly reading: PlanReading;
  readonly privateLinks: readonly NetworkLinkKind[];
  /** The kinds its step takes off: a NAT no Stack VM needs any more. */
  readonly removedLinks: readonly NetworkLinkKind[];
}

function approvedOf(
  step: NetworkStep | NetworkChange,
  reading: PlanReading,
): ApprovedNetwork {
  return {
    reading,
    privateLinks: step.privateLinks ?? [],
    removedLinks:
      step.action === 'network-change' ? (step.removedLinks ?? []) : [],
  };
}

/** The network step's result. */
function networkResult(
  region: string,
  network: PlanStepNetwork,
  status: PlanStepResult['status'],
  message: string | null,
): PlanStepResult {
  return {
    ...emptyResult(environmentNetworkName(region), 'network-create'),
    status,
    message,
    network,
  };
}

/** Every step but the network's, failed with `message`: the Apply never ran it. */
function notApplied(
  steps: readonly PlanStep[],
  message: string,
): PlanStepResult[] {
  return steps.flatMap((step) => {
    if (step.action === 'network-remove') {
      return [
        {
          ...emptyResult(environmentNetworkName(step.region), step.action),
          message,
        },
      ];
    }
    if (isNetworkStep(step)) return [];
    const base = emptyResult(step.configName, step.action);
    return [
      step.action === 'create'
        ? { ...base, message }
        : {
            ...base,
            message,
            serviceType: step.serviceType,
            serviceId: step.serviceId,
          },
    ];
  });
}

/**
 * Just before the network's apply: AWS read again must make what the Apply
 * approved (the AWS spec, "Cloud run"), and the run must not have been asked
 * to end — the one point where Cancel stops being possible.
 */
function beforeApply(
  approved: PlanReading,
  now: PlanReading,
  control: CloudRunControl,
  cloudName: string,
): TofuFailure | null {
  const differs = changesDiffer(approved, now);
  if (differs) {
    return {
      ok: false,
      reason: 'failed',
      message: `${cloudName} no longer matches the plan that was applied: ${differs}. Nothing was changed; Check for changes, then apply the new plan`,
    };
  }
  if (!control.beginApply()) {
    return {
      ok: false,
      reason: 'interrupted',
      message: 'The run was ended before it changed anything',
    };
  }
  return null;
}

/** A Google network's outputs from `tofu output -json`, or `null` if one is missing. */
function savedOutputs(outputs: Record<string, unknown>): SavedOutputs | null {
  const text = (name: string) => {
    const value = outputs[name];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  const saved = {
    networkName: text(GCP_NETWORK_OUTPUTS.networkName),
    subnetName: text(GCP_NETWORK_OUTPUTS.subnetName),
    ipAddress: text(GCP_NETWORK_OUTPUTS.ipAddress),
    urlMapName: text(GCP_NETWORK_OUTPUTS.urlMapName),
    certificateMapName: text(GCP_NETWORK_OUTPUTS.certificateMapName),
  };
  return Object.values(saved).every((value) => value !== null) ? saved : null;
}

/**
 * An AWS network's ids from `tofu output -json`, or `null` if one is
 * missing: the private DNS namespace's among them once the network holds
 * one, and null on the row until then.
 */
function savedIds(
  outputs: Record<string, unknown>,
  privateLinks: readonly NetworkLinkKind[],
): SavedIds | null {
  const text = (name: string) => {
    const value = outputs[name];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  const pair = (name: string): [string, string] | null => {
    const value = outputs[name];
    return Array.isArray(value) &&
      value.length === 2 &&
      value.every((one) => typeof one === 'string')
      ? [value[0], value[1]]
      : null;
  };
  const ids = {
    vpcId: text(NETWORK_OUTPUTS.vpcId),
    publicSubnetIds: pair(NETWORK_OUTPUTS.publicSubnetIds),
    privateSubnetIds: pair(NETWORK_OUTPUTS.privateSubnetIds),
    clusterArn: text(NETWORK_OUTPUTS.clusterArn),
    albArn: text(NETWORK_OUTPUTS.albArn),
    albDnsName: text(NETWORK_OUTPUTS.albDnsName),
    albZoneId: text(NETWORK_OUTPUTS.albZoneId),
    httpsListenerArn: text(NETWORK_OUTPUTS.httpsListenerArn),
    albSecurityGroupId: text(NETWORK_OUTPUTS.albSecurityGroupId),
    defaultCertificateArn: text(NETWORK_OUTPUTS.defaultCertificateArn),
  };
  if (!Object.values(ids).every((value) => value !== null)) return null;
  const namespace = text(NETWORK_OUTPUTS.privateDnsNamespaceId);
  if (privateLinks.includes('private-dns') && namespace === null) return null;
  return { ...ids, privateDnsNamespaceId: namespace };
}

/**
 * How a network run names a part a plan adds to it:
 * on Google Cloud its databases' private link or its Private web services'
 * `run.app` zone or its Stack VMs' Cloud NAT, on AWS its Private web
 * services' private DNS namespace or its Stack VMs' NAT gateway.
 */
const LINK_WORDS: {
  readonly [kind in NetworkLinkKind]: {
    readonly part: string;
    readonly purpose: string;
  };
} = {
  'cloud-sql': {
    part: 'private link',
    purpose: "this Environment's databases",
  },
  memorystore: {
    part: 'private link',
    purpose: "this Environment's databases",
  },
  'run-app-zone': {
    part: RUN_APP_ZONE_PART,
    purpose: "this Environment's Private web services",
  },
  'private-dns': {
    part: 'private DNS namespace',
    purpose: "this Environment's Private web services",
  },
  'nat-gateway': {
    part: 'NAT gateway',
    purpose: "this Environment's Stack VMs' way out",
  },
  'cloud-nat': {
    part: CLOUD_NAT_PART,
    purpose: "this Environment's Stack VMs' way out",
  },
};

/**
 * The parts `kinds` add, each named once: `parts` for a run's title, and
 * `phrase` (each part with what it is for) for its description and log.
 */
function linkWords(kinds: readonly NetworkLinkKind[]): {
  readonly parts: string;
  readonly phrase: string;
  readonly verb: 'is' | 'are';
} {
  const words = [
    ...new Map(
      kinds.map((kind) => [LINK_WORDS[kind].part, LINK_WORDS[kind]]),
    ).values(),
  ];
  return {
    parts: words.map((one) => `the ${one.part}`).join(' and '),
    phrase: words
      .map((one) => `the ${one.part} for ${one.purpose}`)
      .join(' and '),
    verb: words.length > 1 ? 'are' : 'is',
  };
}
