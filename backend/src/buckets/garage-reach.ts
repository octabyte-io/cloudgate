import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { Injectable, Logger } from '@nestjs/common';
import { quote } from 'shell-quote';

import { execOnServer } from '../remote/exec-dispatch';
import { RemoteExecService } from '../remote/remote-exec.service';
import { SshForwardService } from '../remote/ssh-forward.service';
import { CLOUDGATE_NETWORK } from '../servers/server-audit';
import { GARAGE_S3_PORT } from './garage';
import { describeError } from '../common/describe-error';

/**
 * How Cloudgate reaches a bucket's Garage S3 API from the platform host, for
 * the object-storage port. Garage publishes no port — a Service
 * reaches it by name on `cloudgate-network` — and the backend runs on the
 * platform host outside that network, so the port's real adapter needs an
 * address opened for it. The e2e lane fakes this token with the port.
 */
export const GARAGE_REACH = Symbol('GARAGE_REACH');

/** An address of a bucket's S3 API, open until `close`. */
export interface GarageEndpoint {
  readonly endpoint: string;
  close(): Promise<void>;
}

export interface GarageReach {
  open(found: {
    readonly serverId: string | null;
    readonly appName: string;
  }): Promise<GarageEndpoint>;
}

/**
 * The relay's image: socat, pinned, as every image Cloudgate runs is. Its
 * entrypoint is `socat`, so its arguments are socat's.
 */
export const GARAGE_RELAY_IMAGE = 'alpine/socat:1.8.0.3';

/** The relay container of the bucket whose Swarm service is `appName`. */
export const garageRelayName = (appName: string): string =>
  `${appName}-s3-relay`;

/**
 * The program that opens the relay on the bucket's run Server: a plain
 * container on `cloudgate-network` that passes a loopback-only port through
 * to Garage's S3 API by name, then says which port Docker gave it. A relay a
 * previous Delete left is replaced. Loopback only, as a Trace store's UI
 * port is (ADR-0028): nothing off the Server can reach it.
 */
export function garageRelayProgram(appName: string): string {
  const name = quote([garageRelayName(appName)]);
  return [
    'set -e',
    `docker rm -f ${name} >/dev/null 2>&1 || true`,
    `docker run -d --rm --name ${name} --network ${quote([CLOUDGATE_NETWORK])} -p 127.0.0.1::${GARAGE_S3_PORT} ${quote([GARAGE_RELAY_IMAGE])} ${quote([`TCP-LISTEN:${GARAGE_S3_PORT},fork,reuseaddr`, `TCP:${appName}:${GARAGE_S3_PORT}`])} >/dev/null`,
    `docker port ${name} ${GARAGE_S3_PORT}/tcp`,
  ].join('\n');
}

/**
 * The loopback port `docker port` printed for the relay, or `null` when it
 * printed none there. Only a `127.0.0.1` binding is taken: the relay asked
 * for nothing else.
 */
export function readRelayPort(stdout: string): number | null {
  for (const line of stdout.split('\n')) {
    const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(line.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * The real reach: the relay on the bucket's run Server, dialled straight on
 * the platform host, and on a remote Server through an SSH channel to that
 * Server's loopback behind a listener of the backend's own, so the
 * port's adapter gets a plain `http://127.0.0.1:<port>`. The relay is
 * removed on `close`.
 */
@Injectable()
export class GarageRelayReach implements GarageReach {
  private readonly logger = new Logger(GarageRelayReach.name);

  constructor(
    private readonly remoteExec: RemoteExecService,
    private readonly forward: SshForwardService,
  ) {}

  async open(found: {
    readonly serverId: string | null;
    readonly appName: string;
  }): Promise<GarageEndpoint> {
    const { serverId, appName } = found;
    const removeRelay = async () => {
      await execOnServer(this.remoteExec, serverId, [
        'docker',
        'rm',
        '-f',
        garageRelayName(appName),
      ]).catch((error: unknown) =>
        this.logger.warn(
          `${appName}: its S3 relay was not removed — ${describeError(error)}`,
        ),
      );
    };
    const { stdout } = await execOnServer(
      this.remoteExec,
      serverId,
      garageRelayProgram(appName),
    );
    const port = readRelayPort(stdout);
    if (port === null) {
      await removeRelay();
      throw new Error(`Docker gave ${garageRelayName(appName)} no port`);
    }
    if (serverId === null) {
      return { endpoint: `http://127.0.0.1:${port}`, close: removeRelay };
    }
    const { listener, sockets } = await this.listenThrough(serverId, port);
    return {
      endpoint: `http://127.0.0.1:${(listener.address() as AddressInfo).port}`,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        await removeRelay();
      },
    };
  }

  /** A loopback listener whose every connection is a channel to `port` there. */
  private async listenThrough(
    serverId: string,
    port: number,
  ): Promise<{ listener: Server; sockets: Set<Socket> }> {
    const sockets = new Set<Socket>();
    const listener = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      this.forward
        .open(serverId, { host: '127.0.0.1', port })
        .then((channel) => {
          socket.once('close', channel.close);
          channel.socket.once('close', () => socket.destroy());
          socket.pipe(channel.socket).pipe(socket);
        })
        .catch(() => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => resolve());
    });
    return { listener, sockets };
  }
}
