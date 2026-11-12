import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { quote } from 'shell-quote';
import { Client } from 'ssh2';
import { sshConnectConfig, sshFailure } from './host-key';
import type { ClientChannel } from 'ssh2';
import { SERVER_KEY_PROVIDER } from './server-key.provider';
import type {
  ServerConnection,
  ServerKeyProvider,
} from './server-key.provider';

/** A port on a remote Server, as that Server's own sshd dials it. */
export interface ForwardTarget {
  host: string;
  port: number;
}

/**
 * One open channel to a port on a remote Server, and what to close once it is
 * no longer needed.
 */
export interface ForwardedConnection {
  /**
   * The channel, shaped as the socket `http.request`'s `createConnection`
   * wants: bytes both ways, plus the socket methods Node's HTTP client calls,
   * including a working idle `setTimeout`.
   */
  socket: Socket;
  /**
   * The channel as `http.request`'s `createConnection`. It honours the
   * request's `timeout` the way `net.createConnection` does, which Node's HTTP
   * client leaves to whoever makes the socket.
   */
  createConnection: (options?: { timeout?: number }) => Socket;
  /**
   * Ends the channel and gives its share of the Server's connection back.
   * Safe to call more than once.
   */
  close: () => void;
}

/** How one {@link SshForwardService.exec} may be cut short. */
export interface ForwardExecOptions {
  /**
   * Aborting it closes the command's channel and rejects the call at once
   * with {@link ForwardExecAbortedError}; the connection itself stays pooled.
   * What lets a reader put a time limit on a read whose answer is no longer
   * wanted, rather than leave it streaming into a promise nobody awaits.
   */
  signal?: AbortSignal;
}

/** What {@link SshForwardService.exec} rejects with once its signal aborted. */
export class ForwardExecAbortedError extends Error {
  constructor(readonly serverId: string) {
    super('The command was stopped before it finished');
    this.name = 'ForwardExecAbortedError';
  }
}

/** What a command run over the Server's connection printed, and its exit code. */
export interface ForwardExecResult {
  stdout: string;
  stderr: string;
  /** The exit code; null when the Server reported a signal instead. */
  code: number | null;
}

/** Why a channel could not be opened, in words an operator can act on. */
export class SshForwardError extends Error {
  constructor(
    message: string,
    readonly serverId: string,
    readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'SshForwardError';
  }
}

/**
 * How long a Server's connection is kept open with nothing using it. Long
 * enough that the burst of requests one Jaeger UI page makes, and the next
 * page's, share it; short enough that nothing holds a Server's sshd for long
 * after the last reader left.
 */
export const SSH_FORWARD_IDLE_CLOSE_MS = 30_000;

/**
 * ssh2's keepalive: a connection whose Server stopped answering (a dropped
 * route, not a closed socket) is noticed after this many unanswered probes
 * this far apart, and evicted like one that closed.
 */
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 3;

/**
 * Gives an SSH channel the socket methods `http.request` calls on its socket.
 * `setTimeout` is a real idle timer — reset by bytes either way, emitting
 * `timeout` — because the HTTP client's own request timeout rides on it, and a
 * no-op there would make a silent remote store hang a request forever.
 */
function asSocket(channel: ClientChannel): Socket {
  let idleMs = 0;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer =
      idleMs > 0
        ? setTimeout(() => channel.emit('timeout'), idleMs)
        : undefined;
  };
  channel.on('data', arm);
  channel.on('close', () => {
    if (timer) clearTimeout(timer);
  });
  const write = channel.write.bind(channel) as ClientChannel['write'];
  const decorated = Object.assign(channel, {
    write: ((...args: Parameters<ClientChannel['write']>) => {
      arm();
      return write(...args);
    }) as ClientChannel['write'],
    setTimeout: (ms: number, onTimeout?: () => void) => {
      idleMs = ms;
      if (onTimeout) channel.once('timeout', onTimeout);
      arm();
      return decorated;
    },
    setNoDelay: () => decorated,
    setKeepAlive: () => decorated,
    ref: () => decorated,
    unref: () => decorated,
    destroySoon: () => channel.destroy(),
  });
  return decorated as unknown as Socket;
}

/** One Server's SSH connection in the pool. */
interface PooledConnection {
  serverId: string;
  /** Which connection details it was dialled with (host, port, user, key). */
  fingerprint: string;
  client: Client;
  /** Settles once the handshake is done; every request waits on this one. */
  ready: Promise<void>;
  /** Channels and commands holding it now. */
  users: number;
  /** The channels open on it, destroyed if it drops under them. */
  channels: Set<ClientChannel>;
  idle?: NodeJS.Timeout;
  /** It closed, or was retired; never handed out again. */
  gone: boolean;
}

/** A share of a pooled connection, given back with `release`. */
interface Lease {
  client: Client;
  entry: PooledConnection;
  /** Whether this request dialled the connection rather than reusing it. */
  dialled: boolean;
  release(): void;
}

const fingerprintOf = (details: ServerConnection): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        details.host,
        details.port,
        details.username,
        details.privateKey,
      ]),
    )
    .digest('hex');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What ssh2 says when the connection under a request was already gone: it
 * throws `Not connected` from a call on a closed socket, and answers a pending
 * channel with `No response from server` when the socket closes. Either on a
 * reused connection means it died between requests, not that the Server
 * refused this one, so the request is tried once more on a new connection.
 */
const connectionWasGone = (error: unknown): boolean =>
  /^(Not connected|No response from server)$/.test(messageOf(error));

/**
 * The SSH connection to a remote Server that carries bytes (ADR-0028):
 * **the one way the backend opens a stream to a port on a remote Server**,
 * and the commands that stream depends on. `RemoteExecService` runs programs
 * each over a connection of its own; this keeps one.
 *
 * **One ssh2 connection per Server, shared.** Its one caller, the Trace store
 * proxy, reads the store's port (`docker port`) and opens a `forwardOut`
 * channel for every request, and a Jaeger UI page fires a dozen requests at
 * once. A connection for each would be two handshakes per request, and
 * OpenSSH's default `MaxStartups 10:30:100` starts dropping unauthenticated
 * connections past ten at a time, so a page would fail at random. So:
 *
 * - **Concurrent first requests share one handshake**: the dial is in the pool
 *   before it completes, and every request waits on the same one.
 * - **Every request asks the key provider** for the Server's connection
 *   details. A Server whose key, host, port or user changed has a new
 *   fingerprint: the old connection is retired (ended once nothing holds it)
 *   and a new one dialled. A Server that was deleted fails that lookup, and
 *   its connection is retired too.
 * - **A connection that dies is evicted**: its close, or ssh2's keepalive
 *   giving up on it, takes it out of the pool and destroys the channels on it,
 *   so the next request dials again. A request that finds its reused
 *   connection already dead ({@link connectionWasGone}) is tried once more.
 * - **Idle for {@link SSH_FORWARD_IDLE_CLOSE_MS}, it is ended**, so an sshd is
 *   not held open for nobody.
 * - **App shutdown ends every connection** ({@link onModuleDestroy}).
 *
 * **Failures reject with {@link SshForwardError}**: a connect error, a refused
 * key, a refused forward, a connection closed before it was ready, or no key
 * provider. A dial that fails is never pooled.
 */
@Injectable()
export class SshForwardService implements OnModuleDestroy {
  /** How long an unused connection is kept; a test may shorten it. */
  idleCloseMs = SSH_FORWARD_IDLE_CLOSE_MS;

  private readonly pool = new Map<string, PooledConnection>();

  constructor(
    @Optional()
    @Inject(SERVER_KEY_PROVIDER)
    private readonly serverKeyProvider?: ServerKeyProvider,
  ) {}

  /** Opens a channel to `target` as the Server sees it, over its connection. */
  open(serverId: string, target: ForwardTarget): Promise<ForwardedConnection> {
    return this.withConnection(serverId, (lease) =>
      this.forward(serverId, lease, target),
    );
  }

  /**
   * Runs one command on the Server over its connection, as argv — each word
   * shell-quoted, since an SSH `exec` hands its command to the account's
   * shell — and answers what it printed and its exit code. A non-zero exit is
   * an answer, not an error.
   *
   * The output is decoded once, whole, so a multi-byte character split across
   * two SSH packets reads back as itself rather than as two replacement
   * characters — an access log carries whatever paths and User-Agents
   * visitors sent.
   */
  exec(
    serverId: string,
    argv: readonly string[],
    options: ForwardExecOptions = {},
  ): Promise<ForwardExecResult> {
    if (options.signal?.aborted) {
      return Promise.reject(new ForwardExecAbortedError(serverId));
    }
    return this.withConnection(serverId, (lease) =>
      this.run(serverId, lease, argv, options.signal),
    );
  }

  /** Ends every connection, and every channel on them. */
  onModuleDestroy(): void {
    this.closeAll();
  }

  /** Ends every connection now, whatever holds it. */
  closeAll(): void {
    for (const entry of [...this.pool.values()]) this.end(entry);
    this.pool.clear();
  }

  /**
   * A lease on the Server's connection for `use`, which releases it when its
   * work is over; released here if `use` fails. Tried once more on a new
   * connection when a reused one turns out to have died.
   */
  private async withConnection<T>(
    serverId: string,
    use: (lease: Lease) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const lease = await this.lease(serverId);
      try {
        return await use(lease);
      } catch (error) {
        lease.release();
        const original: unknown =
          error instanceof SshForwardError ? error.originalError : error;
        if (attempt === 0 && !lease.dialled && connectionWasGone(original)) {
          this.retire(lease.entry);
          continue;
        }
        throw error;
      }
    }
  }

  private async lease(serverId: string): Promise<Lease> {
    if (!this.serverKeyProvider) {
      throw new SshForwardError(
        'No ServerKeyProvider registered; cannot resolve SSH connection details',
        serverId,
      );
    }
    let details: ServerConnection;
    try {
      details = await this.serverKeyProvider.getConnection(serverId);
    } catch (error) {
      // A Server that no longer resolves — deleted, or its key gone — keeps
      // no connection here.
      const stale = this.pool.get(serverId);
      if (stale) this.retire(stale);
      throw new SshForwardError(
        `The Server's SSH connection details could not be read: ${messageOf(error)}`,
        serverId,
        error,
      );
    }
    const fingerprint = fingerprintOf(details);

    // Synchronous from here to the `users` count: two requests that both
    // awaited the lookup above find, or make, the same entry.
    let entry = this.pool.get(serverId);
    if (entry && (entry.gone || entry.fingerprint !== fingerprint)) {
      this.retire(entry);
      entry = undefined;
    }
    const dialled = !entry;
    if (!entry) {
      entry = this.dial(serverId, details, fingerprint);
      this.pool.set(serverId, entry);
    }
    entry.users += 1;
    if (entry.idle) {
      clearTimeout(entry.idle);
      entry.idle = undefined;
    }
    const held = entry;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.release(held);
    };
    try {
      await held.ready;
    } catch (error) {
      release();
      throw error;
    }
    return { client: held.client, entry: held, dialled, release };
  }

  private dial(
    serverId: string,
    details: ServerConnection,
    fingerprint: string,
  ): PooledConnection {
    const client = new Client();
    const entry: PooledConnection = {
      serverId,
      fingerprint,
      client,
      users: 0,
      channels: new Set(),
      gone: false,
      ready: Promise.resolve(),
    };
    entry.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string, error?: unknown) => {
        if (settled) return;
        settled = true;
        reject(new SshForwardError(message, serverId, error));
      };
      client
        .once('ready', () => {
          settled = true;
          resolve();
        })
        .on('error', (error: Error & { level?: string }) => {
          const refusal = sshFailure(details, error);
          fail(
            refusal !== error
              ? refusal.message
              : error.level === 'client-authentication'
                ? `Authentication failed: the SSH key was not accepted by the server. (${error.message})`
                : `SSH connection error: ${error.message}`,
            refusal !== error ? refusal : error,
          );
          // Before or after the handshake, an error ends the connection:
          // what is on it now reads the error, and nothing new is put on it.
          this.drop(entry, error);
        })
        .on('close', () => {
          fail('SSH connection closed before it was ready');
          this.drop(entry, new Error('SSH connection closed'));
        })
        .connect({
          ...sshConnectConfig(details),
          keepaliveInterval: KEEPALIVE_INTERVAL_MS,
          keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        });
    });
    // Every lease awaits `ready` and handles its rejection; this keeps a dial
    // that fails with no lease left waiting from being an unhandled one.
    entry.ready.catch(() => undefined);
    return entry;
  }

  private forward(
    serverId: string,
    lease: Lease,
    target: ForwardTarget,
  ): Promise<ForwardedConnection> {
    return new Promise<ForwardedConnection>((resolve, reject) => {
      const opened = (error: Error | undefined, channel: ClientChannel) => {
        if (error) {
          reject(
            connectionWasGone(error)
              ? error
              : new SshForwardError(
                  `The Server refused the forward to ${target.host}:${target.port}: ${error.message}`,
                  serverId,
                  error,
                ),
          );
          return;
        }
        const { entry } = lease;
        if (entry.gone) {
          channel.destroy();
          reject(new Error('No response from server'));
          return;
        }
        entry.channels.add(channel);
        const socket = asSocket(channel);
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          entry.channels.delete(channel);
          if (!channel.destroyed) channel.destroy();
          lease.release();
        };
        // The far end closing the channel gives its share back too.
        channel.once('close', close);
        resolve({
          socket,
          createConnection: (options) => {
            if (options?.timeout) socket.setTimeout(options.timeout);
            return socket;
          },
          close,
        });
      };
      try {
        // The source address is what sshd is told the connection came from;
        // nothing listens there, so loopback and port 0 say "the backend".
        lease.client.forwardOut(
          '127.0.0.1',
          0,
          target.host,
          target.port,
          opened,
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private run(
    serverId: string,
    lease: Lease,
    argv: readonly string[],
    signal?: AbortSignal,
  ): Promise<ForwardExecResult> {
    return new Promise<ForwardExecResult>((resolve, reject) => {
      try {
        lease.client.exec(quote([...argv]), (error, channel) => {
          if (error) {
            reject(
              connectionWasGone(error)
                ? error
                : new SshForwardError(
                    `The Server would not run the command: ${error.message}`,
                    serverId,
                    error,
                  ),
            );
            return;
          }
          lease.entry.channels.add(channel);
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          let code: number | null = null;
          // Rejects now and closes the channel; its `close` below then gives
          // the lease back, and its `resolve` is a no-op on a settled promise.
          const stop = () => {
            reject(new ForwardExecAbortedError(serverId));
            channel.close();
          };
          if (signal?.aborted) stop();
          signal?.addEventListener('abort', stop, { once: true });
          channel.on('data', (chunk: Buffer) => stdout.push(chunk));
          channel.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
          channel.on('exit', (exitCode: number | null) => (code = exitCode));
          channel.once('error', (channelError: Error) => {
            signal?.removeEventListener('abort', stop);
            lease.entry.channels.delete(channel);
            reject(channelError);
          });
          channel.once('close', () => {
            signal?.removeEventListener('abort', stop);
            lease.entry.channels.delete(channel);
            lease.release();
            resolve({
              stdout: Buffer.concat(stdout).toString('utf8'),
              stderr: Buffer.concat(stderr).toString('utf8'),
              code,
            });
          });
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private release(entry: PooledConnection): void {
    entry.users -= 1;
    if (entry.users > 0) return;
    if (entry.gone) {
      entry.client.end();
      return;
    }
    entry.idle = setTimeout(() => {
      if (entry.users === 0) this.retire(entry);
    }, this.idleCloseMs);
    entry.idle.unref();
  }

  /**
   * Takes a connection out of the pool; it ends now if nothing holds it, and
   * when the last holder releases it otherwise.
   */
  private retire(entry: PooledConnection): void {
    entry.gone = true;
    if (this.pool.get(entry.serverId) === entry) {
      this.pool.delete(entry.serverId);
    }
    if (entry.idle) clearTimeout(entry.idle);
    if (entry.users <= 0) entry.client.end();
  }

  /** The connection dropped: out of the pool, and its channels with it. */
  private drop(entry: PooledConnection, error: Error): void {
    this.retire(entry);
    for (const channel of entry.channels) {
      // ssh2's types omit `destroy`'s error; the channel is a Duplex.
      if (!channel.destroyed) (channel as Duplex).destroy(error);
    }
    entry.channels.clear();
    entry.client.end();
  }

  /** Ends a connection whatever holds it (shutdown). */
  private end(entry: PooledConnection): void {
    this.drop(entry, new Error('The backend is shutting down'));
  }
}
