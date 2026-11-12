import { EventEmitter } from 'node:events';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Client } from 'ssh2';
import type { ClientChannel } from 'ssh2';
import { sshConnectConfig, sshFailure } from '../../remote/host-key';
import { SERVER_KEY_PROVIDER } from '../../remote/server-key.provider';
import type {
  ServerConnection,
  ServerKeyProvider,
} from '../../remote/server-key.provider';
import { DEFAULT_TERMINAL_SIZE } from '../terminal-protocol';
import type { StreamChannel } from './stream-channel';

/** Open against a stored server row, or with explicit connection details
 * (the local-server terminal builds its own ConnectConfig). */
export type SshTarget = { serverId: string } | { connection: ServerConnection };

export interface SshOpenOptions {
  /** Command to exec; omitted → interactive shell. */
  command?: string;
  /**
   * Allocate a pty so the remote process receives SIGHUP on disconnect. That is
   * the process sshd started and no further: for `docker exec` it is the
   * client, and the process Docker started inside the container never hears it
   * — `container-terminal.gateway.ts` ends that one itself.
   */
  pty?: boolean;
  /**
   * The window the remote pty opens at. ssh2 defaults to 80 x 24 and a later
   * `setWindow` cannot un-draw what the first screen already drew at that size,
   * so a caller that knows the client's size says it here.
   */
  cols?: number;
  rows?: number;
}

/**
 * Streaming SSH channels for the realtime gateways. RemoteExecService covers
 * buffered one-shot commands; the wss handlers need long-lived duplex streams
 * (follow logs, interactive shells) that close with the WebSocket.
 */
@Injectable()
export class SshChannelService {
  constructor(
    @Optional()
    @Inject(SERVER_KEY_PROVIDER)
    private readonly serverKeyProvider?: ServerKeyProvider,
  ) {}

  async open(
    target: SshTarget,
    options: SshOpenOptions = {},
  ): Promise<StreamChannel> {
    const connection =
      'connection' in target
        ? target.connection
        : await this.resolveConnection(target.serverId);

    return new Promise((resolve, reject) => {
      const conn = new Client();
      // A tunnel's session ends with the connection that ran inside it.
      conn.once('close', () => connection.sock?.destroy());
      const emitter = new EventEmitter();
      // What came before anyone listened to it. A command that answers at
      // once can send its output and its close in the same read as the
      // channel's opening, before the caller's `await` resumes to add its
      // listeners; emitted then, they reached no one, and a log follower's
      // socket showed nothing and never ended. Held, each kind is handed
      // over in order to the first listener of that kind.
      const early: [string, unknown][] = [];
      const emit = (event: string, payload: unknown) => {
        if (emitter.listenerCount(event) > 0) emitter.emit(event, payload);
        else early.push([event, payload]);
      };
      const listen =
        (event: string) =>
        (listener: (payload: never) => void): void => {
          emitter.on(event, listener);
          const held = early.filter(([kind]) => kind === event);
          if (held.length === 0) return;
          early.splice(
            0,
            early.length,
            ...early.filter(([kind]) => kind !== event),
          );
          for (const [, payload] of held) emitter.emit(event, payload);
        };
      let settled = false;

      const wire = (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          settled = true;
          conn.end();
          reject(err);
          return;
        }
        stream
          .on('close', (code?: number) => {
            conn.end();
            emit('close', code);
          })
          .on('data', (data: Buffer | string) => {
            emit('data', data.toString());
          })
          .stderr.on('data', (data: Buffer | string) => {
            emit('stderr', data.toString());
          });

        settled = true;
        resolve({
          write: (data) => void stream.write(data),
          // ssh2 counts a window rows-first, and takes the pixel dimensions of
          // the drawing area after it. A browser grid knows neither, and 0 is
          // the protocol's "no information" for both.
          resize: (cols, rows) => void stream.setWindow(rows, cols, 0, 0),
          close: () => {
            stream.end();
            conn.end();
          },
          onData: listen('data'),
          onStderr: listen('stderr'),
          onClose: listen('close'),
          onError: listen('error'),
        });
      };

      const window = {
        cols: options.cols ?? DEFAULT_TERMINAL_SIZE.cols,
        rows: options.rows ?? DEFAULT_TERMINAL_SIZE.rows,
      };

      conn
        .once('ready', () => {
          if (options.command === undefined) {
            conn.shell(window, wire);
          } else {
            // A pty is requested with the window it should have; without one
            // there is no terminal for a size to describe.
            conn.exec(
              options.command,
              { pty: options.pty ? window : false },
              wire,
            );
          }
        })
        .on('error', (err: Error) => {
          conn.end();
          const failure = sshFailure(connection, err);
          if (!settled) {
            settled = true;
            reject(failure);
          } else {
            emit('error', failure);
          }
        })
        .connect(sshConnectConfig(connection));
    });
  }

  private resolveConnection(serverId: string): Promise<ServerConnection> {
    if (!this.serverKeyProvider) {
      throw new Error(
        'No ServerKeyProvider registered; cannot resolve SSH connection details',
      );
    }
    return this.serverKeyProvider.getConnection(serverId);
  }
}
