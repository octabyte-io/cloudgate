import { Injectable } from '@nestjs/common';
import type { Duplex } from 'node:stream';

import { onCloudOf } from '../cloud-accounts/cloud-provider';
import type { StackVmEndpoint, StackVmTunnel } from '../remote/stack-vm-remote';
import { IapTunnel } from './iap-tunnel';
import { SessionManagerTunnel } from './session-manager-tunnel';

/**
 * `STACK_VM_TUNNEL`: each cloud's tunnel, by the endpoint's cloud. AWS's is
 * Session Manager, Google Cloud's is IAP's TCP forwarding; nothing above
 * tells them apart.
 */
@Injectable()
export class StackVmTunnels implements StackVmTunnel {
  constructor(
    private readonly sessionManager: SessionManagerTunnel,
    private readonly iap: IapTunnel,
  ) {}

  open(endpoint: StackVmEndpoint): Promise<Duplex> {
    return onCloudOf(endpoint, {
      aws: (aws) => this.sessionManager.open(aws),
      gcp: (google) => this.iap.open(google),
    });
  }
}
