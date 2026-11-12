import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';

import {
  STACK_VM_DOMAIN_ADDRESSES,
  stackVmDefinition,
} from '../../cloud-accounts/aws/definitions/stack-vm-definition';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import {
  byCloud,
  cloudOrLegacy,
  credentialOf,
  onCloud,
} from '../../cloud-accounts/cloud-provider';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
  PerCloud,
} from '../../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT } from '../../cloud-accounts/cloud.port';
import type { AwsCloudPort } from '../../cloud-accounts/cloud.port';
import type { StackVmSettings } from '../../cloud-accounts/definitions/stack-vm';
import { googleRefusalReason } from '../../cloud-accounts/gcp/api-off';
import {
  GOOGLE_STACK_VM_DOMAIN_ADDRESSES,
  googleStackVmDefinition,
} from '../../cloud-accounts/gcp/definitions/stack-vm-definition';
import { readGooglePlan } from '../../cloud-accounts/gcp/plan-reader/read-plan';
import { InfrastructureStatesService } from '../../cloud-accounts/infrastructure-state/infrastructure-states.service';
import { describeError } from '../../common/describe-error';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { cloudAccount, compose } from '../../db/schema';
import type { Compose, Deployment, Domain } from '../../db/schema';
import type { CloudRunControl } from '../../deployment-queue/cloud-run-job.types';
import { CloudRunsService } from '../../deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../../deployments/deployments.service';
import { environmentNetworkName } from '../../deployments/service-scope';
import type { PointTarget } from '../../domains/cloud-domain';
import { stackRowOf, stackVmPublicKeyOf } from '../../stack-vm/stack-vm-rows';
import { AwsPlanReads } from '../aws-plan-reads.service';
import { googleNetworkNames } from '../cloud-sql-places';
import { savedDatabaseNetwork } from '../rds-postgres-places';
import {
  deleteForgottenCertificates,
  forgetUnnamedCertificates,
  recordAwsCertificates,
} from './aws-domain-certificates';
import { checkBeforeApply } from './cloud-deploy-steps';
import { onlyBlocks } from './domain-blocks';
import { GoogleDomainRuns } from './google-domain-runs.service';
import {
  awsStackVmDomains,
  awsStackVmLoadBalancer,
  stackVmCloudDomains,
  stackVmDomainPort as portOf,
} from './stack-vm-domain-pieces';
import { domainRunCheck, domainRunError } from './unmade-domains';

/** A stack on its Stack VM, made, as a Domain run works from it. */
type MadeStack = Compose & {
  readonly cloudAccountId: string;
  readonly region: string;
  readonly stackVm: StackVmSettings & {
    readonly made: NonNullable<StackVmSettings['made']>;
  };
};

/** How a stack's Domain run lives on each cloud (ADR-0043). */
const STACK_DOMAIN_RUNS: PerCloud<{ readonly writesNetwork: boolean }> = {
  // Its rules and certificates are in the stack's own state.
  aws: { writesNetwork: false },
  // Its rules are on the network's one URL map, which the run writes too.
  gcp: { writesNetwork: true },
};

/**
 * **A Compose stack's Domains on its Stack VM** (ADR-0070, #1371): the same
 * Domain rows and rules as a cloud `web`'s, served by the Environment
 * network's load balancer with the cloud's certificate, the backend the
 * Stack VM's private address on the Domain's port. The deploy publishes
 * that port on the Stack VM (`publishStackVmPorts`); every load balancer
 * piece that reaches it is in the stack's own Infrastructure state, so the
 * stack's Delete removes it with the Stack VM.
 *
 * **Each add, edit, remove and Ask again** is a short Cloud run of the stack,
 * recorded as its Deployment, with a log and no plan.
 *
 * - **On AWS** it writes the Stack VM's definition with its Domains as the
 *   database holds them and applies only their blocks (each Domain's
 *   certificate and host rule on the network's HTTPS listener, each port's
 *   target group with the Stack VM in it, and the security group's rules
 *   from the load balancer), so a removed Domain is destroyed by the same
 *   run. Before it changes anything the plan may touch nothing else, as a
 *   `web`'s Domain run. Certificates are ACM's, polled by the same poller.
 * - **On Google Cloud** the host rules and certificates are the network's
 *   (one URL map), and the backends the stack's: an instance group holding
 *   the Stack VM and, per port, a backend service and health check, with a
 *   firewall rule from the load balancer. So the run applies the stack's
 *   state with every port it needs, then the network's Domains, then the
 *   stack's state again without the ports no Domain reaches any more, so
 *   the URL map never names a backend that is not there. It waits as a run
 *   that touches the network.
 */
@Injectable()
export class StackVmDomainRuns {
  private readonly logger = new Logger(StackVmDomainRuns.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    private readonly states: InfrastructureStatesService,
    private readonly cloudAccounts: CloudAccountsService,
    private readonly awsReads: AwsPlanReads,
    private readonly deployments: DeploymentsService,
    private readonly moduleRef: ModuleRef,
    private readonly google: GoogleDomainRuns,
  ) {}

  /** The pool lives in the queue module, which this module cannot import. */
  private get cloudRuns(): CloudRunsService {
    return this.moduleRef.get(CloudRunsService, { strict: false });
  }

  /** Why the stack cannot take a Domain yet, or `null`. */
  async refusal(composeId: string): Promise<string | null> {
    const found = await this.stackOf(composeId);
    if (!found?.cloudAccountId || !found.region || !found.stackVm) {
      return 'This stack is not on a Stack VM, so its Domains are not the cloud’s';
    }
    if (!found.stackVm.made) {
      return `${found.configName}'s Stack VM is not made yet, so a Domain's rule has nothing to reach. Add the Domain once its Cloud run has made it`;
    }
    if (!(await this.pointTarget(composeId))) {
      return `The ${environmentNetworkName(found.region)} is not made, so there is no load balancer for a Domain`;
    }
    return null;
  }

  /**
   * Records the stack's Domain run and queues it; answers its Deployment's
   * id. On Google Cloud it writes the network's URL map too, so it waits as
   * a run that touches the network.
   */
  async queue(input: {
    composeId: string;
    title: string;
    description: string;
  }): Promise<string> {
    const found = await stackRowOf(this.db, input.composeId);
    const cloud = await this.cloudOf(found.cloudAccountId);
    const row = await this.deployments.recordComposeCloudRun({
      composeId: found.composeId,
      appName: found.appName,
      title: input.title,
      description: input.description,
    });
    void this.cloudRuns
      .submit(row.deploymentId, {
        kind: 'domain',
        stateKey: `compose:${found.composeId}`,
        environmentId: found.environmentId,
        touchesNetwork: byCloud(cloud, STACK_DOMAIN_RUNS).writesNetwork,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Domain run ${row.deploymentId} failed to settle: ${describeError(error)}`,
        ),
      );
    return row.deploymentId;
  }

  /**
   * What the stack's Domains point at: the AWS network's load balancer by
   * its DNS name, or the Google network's fixed IP; `null` while not made.
   */
  async pointTarget(composeId: string): Promise<PointTarget | null> {
    const found = await this.stackOf(composeId);
    if (!found?.cloudAccountId || !found.region) return null;
    return this.networkPointTarget({
      environmentId: found.environmentId,
      cloudAccountId: found.cloudAccountId,
      region: found.region,
    });
  }

  /**
   * What a stack's Domains in this Environment network would point at,
   * before any stack exists there: a Template's setup shows the records to
   * make for its typed hosts (#1379). `null` while the network is not made.
   */
  async networkPointTarget(place: {
    readonly environmentId: string;
    readonly cloudAccountId: string;
    readonly region: string;
  }): Promise<PointTarget | null> {
    return byCloud<() => Promise<PointTarget | null>>(
      await this.cloudOf(place.cloudAccountId),
      {
        aws: async () => {
          const network = await awsStackVmLoadBalancer(this.db, place);
          return network
            ? { dnsName: network.albDnsName, kind: 'load-balancer' }
            : null;
        },
        gcp: () => this.google.pointTarget(place),
      },
    )();
  }

  /** The stack's Domain run, as the pool runs it, read off its row. */
  async run(
    row: Deployment,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    const found = await this.stackOf(row.composeId ?? '');
    if (!found?.cloudAccountId || !found.region || !found.stackVm?.made) {
      throw new Error('This stack has no Stack VM made in a Cloud account');
    }
    const stack = found as MadeStack;
    const accountRow = await this.cloudAccounts.findForUse(
      stack.cloudAccountId,
    );
    if (!accountRow)
      throw new Error('The Cloud account this stack is in is gone');
    const state = await this.states.findForCompose(stack.composeId);
    if (!state)
      throw new Error(`${stack.configName} has no Infrastructure state`);
    const domains = await stackVmCloudDomains(this.db, stack.composeId);
    await log(
      `☁️ [Cloud run] Applying the Domains of ${stack.configName} on the load balancer, to its Stack VM in Cloud account ${accountRow.name}, ${stack.region}, Infrastructure state ${state.infrastructureStateId}`,
    );
    for (const one of domains) {
      await log(
        `  ${one.host}${one.path && one.path !== '/' ? one.path : ''} → ${one.serviceName ?? '?'} on port ${portOf(one)}`,
      );
    }
    if (domains.length === 0) {
      await log('  (no Domains: each one left is removed)');
    }
    const run = {
      stack,
      stateId: state.infrastructureStateId,
      domains,
      control,
      log,
    };
    await onCloud<Promise<void>>(accountRow, {
      aws: (account) => this.runOnAws(run, account),
      gcp: (account) => this.runOnGoogle(run, account),
    });
    await log(`✅ [Cloud run] The Domains of ${stack.configName} are applied`);
  }

  /**
   * A stack's Domains on AWS: its Stack VM's definition, written as its
   * create's run wrote it (recorded image, key, `native.aws`) with its
   * Domains, applied with `-target` on their blocks alone.
   */
  private async runOnAws(
    run: StackDomainRun,
    account: AwsCloudAccount,
  ): Promise<void> {
    const { stack, stateId, domains, control, log } = run;
    const credential = credentialOf(account);
    const refused = await this.awsReads.credentialRefusal(account, credential);
    if (refused) throw new Error(refused);
    const place = {
      environmentId: stack.environmentId,
      cloudAccountId: stack.cloudAccountId,
      region: stack.region,
    };
    const network = await savedDatabaseNetwork(this.db, place);
    const loadBalancer = await awsStackVmLoadBalancer(this.db, place);
    if (!network || !loadBalancer) {
      throw new Error(
        `The ${environmentNetworkName(stack.region)} is not made, so there is no load balancer for a Domain`,
      );
    }
    const { stackVm } = stack;
    const generated = stackVmDefinition({
      configName: stack.configName,
      serviceId: stack.composeId,
      account: {
        awsAccountId: account.cloudId,
        deployRoleArn: account.deployRoleArn,
        externalId: account.externalId,
        cloudAccountId: account.cloudAccountId,
      },
      region: stack.region,
      environmentId: stack.environmentId,
      stateId,
      network,
      machineType: stackVm.machineType,
      dataDiskGb: stackVm.dataDiskGb,
      snapshotDays: stackVm.snapshotDays,
      imageId: stackVm.made.imageId,
      // As it was made: a Domain run moves nothing else on the Stack VM.
      zone: stackVm.made.zone ?? null,
      pins: stackVm.made.pins,
      native: stackVm.native,
      sshPublicKey: await stackVmPublicKeyOf(this.db, stack),
      domains: awsStackVmDomains(domains),
      loadBalancer,
    });
    const check = domainRunCheck((show) =>
      checkBeforeApply(
        show,
        onlyBlocks(STACK_VM_DOMAIN_ADDRESSES, {
          other: "apply the stack's plan, then change the Domain again",
          drift: 'apply that plan, then change the Domain again',
          owns: () => true,
        }),
        () => control.beginApply(),
      ),
    );
    const applied = await this.states.apply({
      stateId,
      credential,
      definition: generated.definition,
      targets: [...STACK_VM_DOMAIN_ADDRESSES],
      forget: forgetUnnamedCertificates(this.db, {
        account,
        stateId,
        domains,
        log,
      }),
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: check.beforeApply,
    });
    if (!applied.ok) {
      throw await domainRunError(this.db, {
        check,
        applied,
        domains,
        madeBy: 'acmCertificateArn',
        refusal: applied.message,
        log,
      });
    }
    await recordAwsCertificates(this.db, {
      domains,
      outputs: applied.outputs,
      log,
      servedBy: 'the load balancer',
    });
    await deleteForgottenCertificates(
      { db: this.db, cloud: this.cloud, cloudAccounts: this.cloudAccounts },
      account,
      stateId,
      log,
    );
  }

  /**
   * A stack's Domains on Google Cloud: its backends grown to every port it
   * needs (and still has), the network's Domains applied, then its backends
   * shrunk to the ports its Domains reach, each step recorded in its
   * settings, so the network's URL map only ever names a made backend.
   */
  private async runOnGoogle(
    run: StackDomainRun,
    account: GcpCloudAccount,
  ): Promise<void> {
    const { stack, domains, control, log } = run;
    const needed = sortedPorts(domains.map(portOf));
    const routed = stack.stackVm.routedPorts ?? [];
    const grown = sortedPorts([...needed, ...routed]);
    await this.applyBackends(run, account, grown);
    const applied = await this.google.applyOnNetwork(
      {
        environmentId: stack.environmentId,
        cloudAccountId: stack.cloudAccountId,
        region: stack.region,
      },
      control,
      log,
    );
    if (!applied) {
      throw new Error(
        `The ${environmentNetworkName(stack.region)} is not made, so there is no load balancer for a Domain`,
      );
    }
    if (grown.length !== needed.length) {
      await log(
        `Closing the ports no Domain reaches any more: ${grown.filter((port) => !needed.includes(port)).join(', ')}`,
      );
      await this.applyBackends(run, account, needed);
    }
  }

  /** The stack's own load balancer pieces for `ports`, applied and recorded. */
  private async applyBackends(
    { stack, stateId, control, log }: StackDomainRun,
    account: GcpCloudAccount,
    ports: number[],
  ): Promise<void> {
    const session = await this.cloudAccounts.googleRunSession(account);
    if (!session.ok) throw new Error(session.refusal);
    const network = await googleNetworkNames(this.db, {
      environmentId: stack.environmentId,
      cloudAccountId: stack.cloudAccountId,
      region: stack.region,
    });
    if (network.standIns) {
      throw new Error(
        `The ${environmentNetworkName(stack.region)} is not made, so there is no load balancer for a Domain`,
      );
    }
    const { stackVm } = stack;
    await log(
      ports.length > 0
        ? `The Stack VM as the load balancer's backend on ports ${ports.join(', ')}`
        : 'The Stack VM taken off the load balancer: no Domain reaches it',
    );
    const generated = googleStackVmDefinition({
      configName: stack.configName,
      serviceId: stack.composeId,
      cloudAccountId: account.cloudAccountId,
      projectId: account.cloudId,
      region: stack.region,
      environmentId: stack.environmentId,
      stateId,
      network: network.names,
      machineType: stackVm.machineType,
      dataDiskGb: stackVm.dataDiskGb,
      snapshotDays: stackVm.snapshotDays,
      imageId: stackVm.made.imageId,
      zone: stackVm.made.zone ?? null,
      pins: stackVm.made.pins,
      native: stackVm.nativeGcp,
      sshPublicKey: await stackVmPublicKeyOf(this.db, stack),
      ports,
    });
    const applied = await this.states.apply({
      stateId,
      credential: session.credential,
      definition: generated.definition,
      targets: [...GOOGLE_STACK_VM_DOMAIN_ADDRESSES],
      onLine: (line) => void log(line),
      signal: control.signal,
      beforeApply: (show) =>
        checkBeforeApply(
          show,
          onlyBlocks(
            GOOGLE_STACK_VM_DOMAIN_ADDRESSES,
            "Check for changes, apply the stack's plan, then change the Domain again",
          ),
          () => control.beginApply(),
          [],
          (fresh) =>
            readGooglePlan({ show: fresh, nameSearch: [], context: {} }),
        ),
    });
    if (!applied.ok) {
      throw new Error(googleRefusalReason(applied.message, account.cloudId));
    }
    const [current] = await this.db
      .select({ stackVm: compose.stackVm })
      .from(compose)
      .where(eq(compose.composeId, stack.composeId));
    if (current?.stackVm) {
      await this.db
        .update(compose)
        .set({ stackVm: { ...current.stackVm, routedPorts: ports } })
        .where(eq(compose.composeId, stack.composeId));
    }
  }

  private async stackOf(composeId: string): Promise<Compose | null> {
    const [found] = await this.db
      .select()
      .from(compose)
      .where(eq(compose.composeId, composeId));
    return found ?? null;
  }

  private async cloudOf(cloudAccountId: string | null) {
    if (!cloudAccountId) return cloudOrLegacy(null);
    const [found] = await this.db
      .select({ cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    return cloudOrLegacy(found?.cloud);
  }
}

/** What one stack's Domain run works from, whatever its cloud. */
interface StackDomainRun {
  readonly stack: MadeStack;
  readonly stateId: string;
  readonly domains: Domain[];
  readonly control: CloudRunControl;
  readonly log: (line: string) => Promise<void>;
}

function sortedPorts(ports: readonly number[]): number[] {
  return [...new Set(ports)].sort((a, b) => a - b);
}
