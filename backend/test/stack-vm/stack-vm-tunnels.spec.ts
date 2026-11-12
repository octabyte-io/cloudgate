import { PassThrough } from 'node:stream';

import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../../src/cloud-accounts/cloud-provider';
import type { IapTunnel } from '../../src/stack-vm/iap-tunnel';
import type { SessionManagerTunnel } from '../../src/stack-vm/session-manager-tunnel';
import { StackVmTunnels } from '../../src/stack-vm/stack-vm-tunnels';

/**
 * `STACK_VM_TUNNEL`: a Stack VM is reached through its own cloud's tunnel,
 * Session Manager on AWS and IAP on Google Cloud, never the other's.
 */
describe('StackVmTunnels', () => {
  const sessionManagerStream = new PassThrough();
  const iapStream = new PassThrough();
  const sessionManager = { open: jest.fn() };
  const iap = { open: jest.fn() };
  const tunnels = new StackVmTunnels(
    sessionManager as unknown as SessionManagerTunnel,
    iap as unknown as IapTunnel,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    sessionManager.open.mockResolvedValue(sessionManagerStream);
    iap.open.mockResolvedValue(iapStream);
  });

  it("opens an AWS Stack VM's tunnel through Session Manager", async () => {
    const endpoint = {
      cloud: 'aws' as const,
      account: { cloud: 'aws' } as AwsCloudAccount,
      region: 'eu-central-1',
      instanceId: 'i-0stackvm',
    };

    expect(await tunnels.open(endpoint)).toBe(sessionManagerStream);
    expect(sessionManager.open).toHaveBeenCalledWith(endpoint);
    expect(iap.open).not.toHaveBeenCalled();
  });

  it("opens a Google Stack VM's tunnel through IAP", async () => {
    const endpoint = {
      cloud: 'gcp' as const,
      account: { cloud: 'gcp' } as GcpCloudAccount,
      zone: 'europe-west1-b',
      instanceName: 'cg-analytics-vm',
    };

    expect(await tunnels.open(endpoint)).toBe(iapStream);
    expect(iap.open).toHaveBeenCalledWith(endpoint);
    expect(sessionManager.open).not.toHaveBeenCalled();
  });
});
