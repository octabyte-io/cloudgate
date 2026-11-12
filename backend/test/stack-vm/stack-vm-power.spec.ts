import { ConflictException } from '@nestjs/common';

import type { CloudAccountsService } from '../../src/cloud-accounts/cloud-accounts.service';
import type { StackVmSettings } from '../../src/cloud-accounts/definitions/stack-vm';
import type { CloudAccount } from '../../src/db/schema';
import { StackVmPower } from '../../src/stack-vm/stack-vm-power';
import type { StackVmStack } from '../../src/stack-vm/stack-vm-power';
import { FakeCloudPort } from '../utils/fake-cloud-port';
import { FakeGoogleCloudPort } from '../utils/fake-google-cloud-port';

const PINS = { dockerEngine: '5:28.0.0', composePlugin: '2.33.0' };

const settings = (
  made: Partial<NonNullable<StackVmSettings['made']>> | null,
): StackVmSettings => ({
  machineType: 't3.small',
  sizeName: 'medium',
  dataDiskGb: 20,
  snapshotDays: 7,
  made: made && {
    imageId: 'ami-0ubuntu',
    pins: PINS,
    instanceId: 'i-0stackvm',
    privateIp: '10.0.1.5',
    dataVolumeId: 'vol-0data',
    ...made,
  },
});

const AWS_STACK: StackVmStack = {
  configName: 'analytics',
  cloudAccountId: 'acct-aws',
  region: 'eu-central-1',
  stackVm: settings({}),
};

const GOOGLE_STACK: StackVmStack = {
  configName: 'analytics',
  cloudAccountId: 'acct-gcp',
  region: 'europe-west1',
  stackVm: settings({ instanceId: 'cg-analytics-vm', zone: 'europe-west1-b' }),
};

const ACCOUNTS: Record<string, Partial<CloudAccount>> = {
  'acct-aws': {
    cloudAccountId: 'acct-aws',
    name: 'Production AWS',
    cloud: 'aws',
  },
  'acct-gcp': {
    cloudAccountId: 'acct-gcp',
    name: 'Production Google',
    cloud: 'gcp',
    cloudId: 'shop-prod',
  },
};

/**
 * **A Stack VM's Stop, Start and running state** (ADR-0070, #1370): one
 * direct call each through its cloud's port, never a Cloud run, and the
 * state read back from the cloud in words both clouds share.
 */
describe('StackVmPower', () => {
  let aws: FakeCloudPort;
  let google: FakeGoogleCloudPort;
  let power: StackVmPower;

  beforeEach(() => {
    aws = new FakeCloudPort();
    google = new FakeGoogleCloudPort();
    const cloudAccounts = {
      findForUse: jest.fn((id: string) =>
        Promise.resolve((ACCOUNTS[id] as CloudAccount) ?? null),
      ),
      deployRoleSession: jest.fn().mockResolvedValue({
        ok: true,
        session: {
          accessKeyId: 'ASIA',
          secretAccessKey: 's',
          sessionToken: 't',
        },
      }),
      googleRunSession: jest.fn().mockResolvedValue({
        ok: true,
        token: { accessToken: 'fake-impersonated-token' },
      }),
    } as unknown as CloudAccountsService;
    power = new StackVmPower(cloudAccounts, aws, google);
  });

  describe('on AWS', () => {
    it("stops the stack's EC2 instance, and reads it back as stopped", async () => {
      await power.stop(AWS_STACK);

      expect(aws.calls).toContainEqual({
        method: 'ec2StopInstance',
        region: 'eu-central-1',
        instanceId: 'i-0stackvm',
      });
      expect(await power.state(AWS_STACK)).toEqual({ state: 'stopped' });
    });

    it('starts it again, and reads it back as running', async () => {
      await power.stop(AWS_STACK);
      await power.start(AWS_STACK);

      expect(aws.calls).toContainEqual({
        method: 'ec2StartInstance',
        region: 'eu-central-1',
        instanceId: 'i-0stackvm',
      });
      expect(await power.state(AWS_STACK)).toEqual({ state: 'running' });
    });

    it.each([
      ['pending', 'starting'],
      ['stopping', 'stopping'],
      ['shutting-down', 'gone'],
      ['terminated', 'gone'],
    ] as const)('reads EC2 %s as %s', async (ec2, state) => {
      aws.setEc2InstanceState('i-0stackvm', ec2);

      expect(await power.state(AWS_STACK)).toEqual({ state });
    });

    it("refuses a Stop EC2 refused, in EC2's words and naming the stack", async () => {
      aws.refuseEc2Instances('UnauthorizedOperation', 'You are not authorized');

      const stopping = power.stop(AWS_STACK);

      await expect(stopping).rejects.toBeInstanceOf(ConflictException);
      await expect(stopping).rejects.toThrow(
        "AWS refused to stop analytics's Stack VM: UnauthorizedOperation: You are not authorized",
      );
    });

    it("answers a read EC2 refused as unknown, with EC2's words", async () => {
      aws.refuseEc2Instances('UnauthorizedOperation', 'You are not authorized');

      expect(await power.state(AWS_STACK)).toEqual({
        state: 'unknown',
        reason: 'UnauthorizedOperation: You are not authorized',
      });
    });
  });

  describe('on Google Cloud', () => {
    const ref = {
      projectId: 'shop-prod',
      zone: 'europe-west1-b',
      name: 'cg-analytics-vm',
      impersonated: true,
    };

    it("stops the stack's Compute Engine VM in its zone, and reads it back as stopped", async () => {
      await power.stop(GOOGLE_STACK);

      expect(google.calls).toContainEqual({
        method: 'stopComputeInstance',
        ...ref,
      });
      expect(await power.state(GOOGLE_STACK)).toEqual({ state: 'stopped' });
    });

    it('starts it again, and reads it back as running', async () => {
      await power.stop(GOOGLE_STACK);
      await power.start(GOOGLE_STACK);

      expect(google.calls).toContainEqual({
        method: 'startComputeInstance',
        ...ref,
      });
      expect(await power.state(GOOGLE_STACK)).toEqual({ state: 'running' });
    });

    it.each([
      ['STAGING', 'starting'],
      ['PROVISIONING', 'starting'],
      ['REPAIRING', 'starting'],
      ['STOPPING', 'stopping'],
      ['SUSPENDING', 'stopping'],
      ['SUSPENDED', 'stopped'],
    ] as const)('reads Compute Engine %s as %s', async (status, state) => {
      google.setComputeInstanceStatus('cg-analytics-vm', status);

      expect(await power.state(GOOGLE_STACK)).toEqual({ state });
    });

    it('reads a VM Google does not have as gone', async () => {
      google.refuse('computeInstanceStatus', 'NOT_FOUND', 'was not found');

      expect(await power.state(GOOGLE_STACK)).toEqual({ state: 'gone' });
    });
  });

  it('answers a Stack VM no Apply has made yet as not made, asking no cloud', async () => {
    const stack = { ...AWS_STACK, stackVm: settings(null) };

    expect(await power.state(stack)).toEqual({ state: 'not-made' });
    await expect(power.stop(stack)).rejects.toThrow(
      "analytics's Stack VM is not made yet",
    );
    expect(aws.calls).toEqual([]);
  });
});
