import { Inject, Injectable, Optional } from '@nestjs/common';
import Docker from 'dockerode';
import { SERVER_KEY_PROVIDER } from '../remote/server-key.provider';
import type { ServerKeyProvider } from '../remote/server-key.provider';
import { stackOfRemoteId } from '../remote/stack-vm-remote';
import { DOCKER_CLIENT } from './docker-client.provider';

/**
 * Hands out a dockerode client for a given server: the local daemon when no
 * serverId is given, otherwise dockerode-over-SSH using the connection
 * resolved by the ServerKeyProvider.
 */
@Injectable()
export class RemoteDockerFactory {
  constructor(
    @Inject(DOCKER_CLIENT) private readonly localDocker: Docker,
    @Optional()
    @Inject(SERVER_KEY_PROVIDER)
    private readonly serverKeyProvider?: ServerKeyProvider,
  ) {}

  async getRemoteDocker(serverId?: string | null): Promise<Docker> {
    if (!serverId) {
      return this.localDocker;
    }

    // dockerode dials a new SSH connection per request, and a Stack VM has
    // no address to dial: it is reached only through one tunnel at a time,
    // by the run target (ADR-0070).
    if (stackOfRemoteId(serverId) !== null) {
      throw new Error(
        "A Stack VM's Docker is reached through its run target, not dockerode",
      );
    }

    if (!this.serverKeyProvider) {
      throw new Error(
        'No ServerKeyProvider registered; cannot resolve SSH connection for remote docker',
      );
    }

    const connection = await this.serverKeyProvider.getConnection(serverId);

    return new Docker({
      protocol: 'ssh',
      host: connection.host,
      port: connection.port,
      username: connection.username,
      // dockerode's typings omit sshOptions, but it forwards them to ssh2's
      // connect, which is where the host key is checked (ADR-0074). A refused
      // key reaches a dockerode caller as ssh2's own `Host denied
      // (verification failed)`: dockerode hands back no hook to swap it for
      // the refusal, which `RemoteExecService` and the socket channels do.
      sshOptions: {
        privateKey: connection.privateKey,
        hostVerifier: connection.hostKey.verifier,
      },
    });
  }
}
