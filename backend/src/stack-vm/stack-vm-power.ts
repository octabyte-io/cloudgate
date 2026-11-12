import { ConflictException, Inject, Injectable } from '@nestjs/common';

import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { CLOUD_NAMES, onCloud } from '../cloud-accounts/cloud-provider';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT } from '../cloud-accounts/cloud.port';
import type {
  AwsCloudPort,
  Ec2InstanceState,
} from '../cloud-accounts/cloud.port';
import type { StackVmSettings } from '../cloud-accounts/definitions/stack-vm';
import { googleRefusalReason } from '../cloud-accounts/gcp/api-off';
import {
  GOOGLE_CLOUD_PORT,
  NOT_FOUND,
} from '../cloud-accounts/google-cloud.port';
import type {
  ComputeInstanceStatus,
  GoogleCloudPort,
} from '../cloud-accounts/google-cloud.port';

/** What a Stack VM's Stop, Start and state read off its stack's row. */
export interface StackVmStack {
  readonly configName: string;
  readonly cloudAccountId: string | null;
  readonly region: string | null;
  readonly stackVm: StackVmSettings | null;
}

/**
 * Whether a Stack VM runs, in words both clouds share:
 *
 * - `running`, `starting`, `stopping`, `stopped`: as they read;
 * - `gone`: the cloud no longer has it, or is removing it;
 * - `not-made`: no Apply has made it yet, so no cloud was asked;
 * - `unknown`: the cloud did not answer, `reason` saying why.
 */
export type StackVmRunState =
  | 'running'
  | 'starting'
  | 'stopping'
  | 'stopped'
  | 'gone'
  | 'not-made'
  | 'unknown';

export interface StackVmStatus {
  readonly state: StackVmRunState;
  /** The cloud's own words, when the state is `unknown`. */
  readonly reason?: string;
}

/** The states in which a Stack VM takes no Deployment: Start it first. */
export const STACK_VM_DOWN: ReadonlySet<StackVmRunState> = new Set([
  'stopping',
  'stopped',
]);

/**
 * Said, up front, to a Deployment, Stop, Start or Restart of a stack whose
 * Stack VM no Apply has made yet (a console stack before its Environment's
 * next plan, #1372): nothing can reach it, so nothing is queued to fail at
 * the tunnel (#1357 review).
 */
export function stackVmNotMadeRefusal(configName: string): ConflictException {
  return new ConflictException(
    `${configName}'s Stack VM is not made yet: the Environment's next plan makes it once applied, and nothing runs on it until then`,
  );
}

type Verb = 'stop' | 'start';

/** Where one stack's Stack VM is, as its Apply recorded it. */
interface Made {
  readonly name: string;
  readonly region: string;
  readonly instanceId: string;
  readonly zone: string | undefined;
}

const EC2_STATES: Readonly<Record<Ec2InstanceState, StackVmRunState>> = {
  pending: 'starting',
  running: 'running',
  stopping: 'stopping',
  stopped: 'stopped',
  'shutting-down': 'gone',
  terminated: 'gone',
};

const COMPUTE_STATUSES: Readonly<
  Record<ComputeInstanceStatus, StackVmRunState>
> = {
  PROVISIONING: 'starting',
  STAGING: 'starting',
  REPAIRING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  SUSPENDING: 'stopping',
  STOPPED: 'stopped',
  SUSPENDED: 'stopped',
  TERMINATED: 'stopped',
};

/**
 * **A Stack VM's Stop, Start and running state** (ADR-0070, #1370): one
 * direct call each through its cloud's port, signed in as the Cloud
 * account's deploy identity, never a Cloud run, as a cloud database's Stop
 * and Start are (`cloud-database-lifecycle.ts`).
 *
 * - On **AWS**: EC2's `StopInstances`, `StartInstances` and
 *   `DescribeInstances` of the instance its Apply recorded.
 * - On **Google Cloud**: Compute Engine's `instances.stop`, `.start` and
 *   `.get` of the VM its Apply recorded, in its zone.
 *
 * A stopped Stack VM keeps its disks, so only they are billed. What runs
 * on it is the stack's own: Stop and Start of its containers go through the
 * run target (`ComposeService`), around these calls.
 */
@Injectable()
export class StackVmPower {
  constructor(
    private readonly cloudAccounts: CloudAccountsService,
    @Inject(AWS_CLOUD_PORT) private readonly aws: AwsCloudPort,
    @Inject(GOOGLE_CLOUD_PORT) private readonly google: GoogleCloudPort,
  ) {}

  stop(stack: StackVmStack): Promise<void> {
    return this.call(stack, 'stop');
  }

  start(stack: StackVmStack): Promise<void> {
    return this.call(stack, 'start');
  }

  /** Whether it runs, read from its cloud now. Never throws for the cloud's answer. */
  async state(stack: StackVmStack): Promise<StackVmStatus> {
    const made = madeOf(stack);
    if (!made) return { state: 'not-made' };
    const account = await this.accountOf(stack);
    return onCloud<Promise<StackVmStatus>>(account, {
      aws: async (aws) => {
        const session = await this.cloudAccounts.deployRoleSession(aws);
        if (!session.ok) return { state: 'unknown', reason: session.refusal };
        const read = await this.aws.ec2InstanceState(session.session, {
          region: made.region,
          instanceId: made.instanceId,
        });
        if (read.ok) return { state: EC2_STATES[read.value] };
        if (read.code === 'InvalidInstanceID.NotFound')
          return { state: 'gone' };
        return { state: 'unknown', reason: `${read.code}: ${read.message}` };
      },
      gcp: async (google) => {
        const signed = await this.cloudAccounts.googleRunSession(google);
        if (!signed.ok) return { state: 'unknown', reason: signed.refusal };
        const read = await this.google.computeInstanceStatus(
          signed.token,
          computeRef(google, made),
        );
        if (read.ok) return { state: COMPUTE_STATUSES[read.value] };
        if (read.code === NOT_FOUND) return { state: 'gone' };
        return {
          state: 'unknown',
          reason: `${read.code}: ${googleRefusalReason(read.message, google.cloudId)}`,
        };
      },
    });
  }

  private async call(stack: StackVmStack, verb: Verb): Promise<void> {
    const made = madeOf(stack);
    if (!made) throw stackVmNotMadeRefusal(stack.configName);
    const account = await this.accountOf(stack);
    await onCloud<Promise<void>>(account, {
      aws: (aws) => this.onEc2(aws, made, verb),
      gcp: (google) => this.onComputeEngine(google, made, verb),
    });
  }

  private async onEc2(
    account: AwsCloudAccount,
    made: Made,
    verb: Verb,
  ): Promise<void> {
    const session = await this.cloudAccounts.deployRoleSession(account);
    if (!session.ok) throw refused(session.refusal);
    const ref = { region: made.region, instanceId: made.instanceId };
    const answer =
      verb === 'stop'
        ? await this.aws.ec2StopInstance(session.session, ref)
        : await this.aws.ec2StartInstance(session.session, ref);
    if (!answer.ok) {
      throw refused(
        `${CLOUD_NAMES.aws} refused to ${verb} ${made.name}'s Stack VM: ${answer.code}: ${answer.message}`,
      );
    }
  }

  private async onComputeEngine(
    account: GcpCloudAccount,
    made: Made,
    verb: Verb,
  ): Promise<void> {
    const signed = await this.cloudAccounts.googleRunSession(account);
    if (!signed.ok) throw refused(signed.refusal);
    const ref = computeRef(account, made);
    const answer =
      verb === 'stop'
        ? await this.google.stopComputeInstance(signed.token, ref)
        : await this.google.startComputeInstance(signed.token, ref);
    if (answer.ok) return;
    throw refused(
      `${CLOUD_NAMES.gcp} refused to ${verb} ${made.name}'s Stack VM: ${answer.code}: ${googleRefusalReason(answer.message, account.cloudId)}`,
    );
  }

  private async accountOf(stack: StackVmStack) {
    const account = stack.cloudAccountId
      ? await this.cloudAccounts.findForUse(stack.cloudAccountId)
      : null;
    if (!account) {
      throw refused(`The Cloud account ${stack.configName} runs in is gone`);
    }
    return account;
  }
}

/** Where the stack's Apply made its Stack VM, or `null` before it has. */
function madeOf(stack: StackVmStack): Made | null {
  const made = stack.stackVm?.made;
  if (!made || !stack.region) return null;
  return {
    name: stack.configName,
    region: stack.region,
    instanceId: made.instanceId,
    zone: made.zone,
  };
}

function computeRef(account: GcpCloudAccount, made: Made) {
  if (!made.zone) throw new Error(`${made.name}'s Stack VM has no zone`);
  return { projectId: account.cloudId, zone: made.zone, name: made.instanceId };
}

function refused(message: string): ConflictException {
  return new ConflictException(message);
}
