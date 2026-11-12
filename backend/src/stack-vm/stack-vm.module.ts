import { Global, Module } from '@nestjs/common';

import { CloudAccountsModule } from '../cloud-accounts/cloud-accounts.module';
import { STACK_VM_CONNECTOR, STACK_VM_TUNNEL } from '../remote/stack-vm-remote';
import { IapTunnel } from './iap-tunnel';
import { SessionManagerTunnel } from './session-manager-tunnel';
import { StackVmConnections } from './stack-vm-connections.service';
import { StackVmPower } from './stack-vm-power';
import { StackVmTunnels } from './stack-vm-tunnels';

/**
 * How Cloudgate reaches a Stack VM (ADR-0070): each cloud's tunnel
 * (`STACK_VM_TUNNEL`, which every e2e replaces with a fake handing back a
 * local stand-in) and the connector the remote-execution layer asks for a
 * Stack VM's SSH connection (`STACK_VM_CONNECTOR`).
 *
 * Global so `ServersModule`'s `SERVER_KEY_PROVIDER` binding can compose the
 * connector in (`withStackVms`) without importing this module, and so a
 * stack's Stop, Start and Deployment reach its Stack VM's power
 * (`StackVmPower`) without importing it either.
 */
@Global()
@Module({
  imports: [CloudAccountsModule],
  providers: [
    SessionManagerTunnel,
    IapTunnel,
    { provide: STACK_VM_TUNNEL, useClass: StackVmTunnels },
    { provide: STACK_VM_CONNECTOR, useClass: StackVmConnections },
    StackVmPower,
  ],
  exports: [STACK_VM_TUNNEL, STACK_VM_CONNECTOR, StackVmPower],
})
export class StackVmModule {}
