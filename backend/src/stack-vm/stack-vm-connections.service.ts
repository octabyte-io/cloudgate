import { Inject, Injectable } from '@nestjs/common';

import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import { onCloud } from '../cloud-accounts/cloud-provider';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { unverifiedHostKey } from '../remote/host-key';
import { STACK_VM_TUNNEL } from '../remote/stack-vm-remote';
import type {
  StackVmConnection,
  StackVmConnector,
  StackVmEndpoint,
  StackVmTunnel,
} from '../remote/stack-vm-remote';

import { stackRowOf, stackVmPrivateKeyOf } from './stack-vm-rows';

/**
 * The user Cloudgate signs in as on a Stack VM: its first boot authorizes
 * the stack's key for it (`stack-vm-cloud-init.ts`), and the compose program
 * writes under `/etc/cloudgate`, as on a Server.
 */
export const STACK_VM_SSH_USER = 'root';

/**
 * `STACK_VM_CONNECTOR`: a stack's Stack VM's SSH connection, its stack's own
 * key over its cloud's tunnel (ADR-0070). Read by id below the permission
 * layer, as a Server's connection is (`ServerConnectionProvider`): what
 * reaches here was authorized by whoever named the stack.
 */
@Injectable()
export class StackVmConnections implements StackVmConnector {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly cloudAccounts: CloudAccountsService,
    @Inject(STACK_VM_TUNNEL) private readonly tunnel: StackVmTunnel,
  ) {}

  async connect(composeId: string): Promise<StackVmConnection> {
    const found = await stackRowOf(this.db, composeId);
    const name = found.configName;
    if (!found.cloudAccountId || !found.region || !found.stackVm) {
      throw new Error(`${name} has no Stack VM`);
    }
    const made = found.stackVm.made;
    // The instance its Apply recorded: EC2's id, or Compute Engine's name.
    const instanceId = made?.instanceId;
    if (!instanceId) throw new Error(`${name}'s Stack VM is not made yet`);
    const privateKey = await stackVmPrivateKeyOf(this.db, found);
    const account = await this.cloudAccounts.findForUse(found.cloudAccountId);
    if (!account) throw new Error(`The Cloud account ${name} is in is gone`);
    const region = found.region;
    const endpoint = onCloud<StackVmEndpoint>(account, {
      aws: (aws) => ({ cloud: 'aws', account: aws, region, instanceId }),
      gcp: (google) => {
        if (!made.zone) throw new Error(`${name}'s Stack VM has no zone`);
        return {
          cloud: 'gcp',
          account: google,
          zone: made.zone,
          instanceName: instanceId,
        };
      },
    });
    const sock = await this.tunnel.open(endpoint);
    return {
      host: instanceId,
      port: 22,
      username: STACK_VM_SSH_USER,
      privateKey,
      sock,
      // The tunnel is opened by the cloud's session service to this one
      // instance, which is what says which machine answers; a Stack VM has no
      // Server row to record a host key on (ADR-0074).
      hostKey: unverifiedHostKey(),
    };
  }
}
