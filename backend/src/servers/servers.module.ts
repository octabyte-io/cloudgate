import { Global, Module } from '@nestjs/common';
import { SERVER_KEY_PROVIDER } from '../remote/server-key.provider';
import { STACK_VM_CONNECTOR, withStackVms } from '../remote/stack-vm-remote';
import type { StackVmConnector } from '../remote/stack-vm-remote';
import { addressResolverProvider } from '../ai/ai-destination';
import { BoughtServersModule } from '../bought-servers/bought-servers.module';
import { SshKeysModule } from '../ssh-keys/ssh-keys.module';
import { ServerAddressGuard } from './server-address-guard';
import { ServerConnectionProvider } from './server-connection.provider';
import { ServerSetupRuns } from './server-setup-runs';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';

/**
 * Global so the SERVER_KEY_PROVIDER binding is visible to the (also global)
 * RemoteModule and DockerModule, whose services optionally inject it without
 * importing this module.
 *
 * `SshKeysModule` is imported for `ServersService.ownedSshKeyId`: the
 * `sshKeyId` in a create or update body is resolved through
 * `SshKeysService.findOne`, which is the organization-scoped lookup for that
 * table, instead of a sixth private copy of one (§1.4).
 *
 * `ServerAddressGuard` resolves names through `ADDRESS_RESOLVER`, the
 * same token the AI destination check uses, so one override keeps a test off
 * real DNS for both.
 *
 * `ServerSetupRuns` is exported for the two that start a Setup run: the
 * `/listen-server-setup` gateway on a confirmed press, and the Bought Server
 * stages for the first run Buy pressed for (the amendment to ADR-0058).
 *
 * `BoughtServersModule` is imported for Delete: a Bought Server's Delete
 * deletes its machine too (`ServersService.remove`).
 *
 * SERVER_KEY_PROVIDER answers a Stack VM's id too, through its tunnel
 * (`withStackVms`): the Stack VM connector is the global `StackVmModule`'s,
 * and a Stack VM is never looked up as a Server.
 */
@Global()
@Module({
  imports: [SshKeysModule, BoughtServersModule],
  controllers: [ServersController],
  providers: [
    ServersService,
    ServerSetupRuns,
    ServerAddressGuard,
    addressResolverProvider,
    ServerConnectionProvider,
    {
      provide: SERVER_KEY_PROVIDER,
      useFactory: (
        servers: ServerConnectionProvider,
        stackVms?: StackVmConnector,
      ) => withStackVms(servers, stackVms),
      inject: [
        ServerConnectionProvider,
        { token: STACK_VM_CONNECTOR, optional: true },
      ],
    },
  ],
  exports: [
    ServersService,
    ServerSetupRuns,
    ServerAddressGuard,
    SERVER_KEY_PROVIDER,
  ],
})
export class ServersModule {}
