import { timingSafeEqual } from 'node:crypto';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Server, utils } from 'ssh2';
import type { ParsedKey } from 'ssh2';
import {
  hostKeyFingerprint,
  unverifiedHostKey,
} from '../../src/remote/host-key';
import type { ServerConnection } from '../../src/remote/server-key.provider';

/**
 * A real SSH server in the test process, standing in for a remote Server's
 * sshd: it accepts one key, and answers a `direct-tcpip` request — what
 * a `forwardOut` asks for — by dialling the named host and port **here**, the
 * way sshd dials them on its own machine. So a test points the destination at
 * a local stub and observes both what the channel carried and what the "Server"
 * was asked to reach.
 *
 * It also answers an `exec` with {@link SshForwardServer.execAnswer}, standing
 * in for the Server's shell: a test says what `docker port` prints there.
 *
 * It records every connection, every forward and every command it was asked
 * for, and whether each connection has closed, so a test can say "no
 * connection was left open", "no channel was ever opened" and "every request
 * shared one handshake".
 */
export interface SshForwardServer {
  /**
   * The details a `ServerKeyProvider` would answer for this Server. A fake
   * provider's: its host key is not checked. A Server row pointed at this
   * server is checked by the real provider, against {@link hostKeyFingerprint}.
   */
  connection: ServerConnection;
  /** The fingerprint of the host key this server presents (ADR-0074). */
  hostKeyFingerprint: string;
  /** A second key the server does not accept. */
  wrongKey: string;
  /** Each forward the client asked for, in order. */
  forwards: { destIP: string; destPort: number }[];
  /** Every client connection, open or closed. */
  connections: { closed: boolean }[];
  /** What the next forward request is answered with. */
  forwardAnswer: 'accept' | 'reject';
  /** Each command an `exec` asked for, in order. */
  execs: string[];
  /**
   * Each program read off stdin, as `RemoteExecService` sends one with an
   * environment (`sh -s`): the request, and the script it wrote.
   */
  scripts: { command: string; stdin: string }[];
  /**
   * What an `exec` prints and exits with; exit 127 unless a test says. A
   * `… -s` request is answered once its stdin has ended, with the script.
   */
  execAnswer: (command: string, stdin?: string) => SshExecAnswer;
  /** Accepts a further key, as an `authorized_keys` line, beside its own. */
  authorize(publicKeyLine: string): void;
  /** Ends every open connection from the server's side, as a dying sshd would. */
  dropConnections(): void;
  /** Resolves once every connection so far has closed. */
  allClosed(): Promise<void>;
  close(): Promise<void>;
}

/** What the stand-in shell answers one command with. */
export interface SshExecAnswer {
  stdout?: string;
  stderr?: string;
  code: number;
  /**
   * Prints `stdout` and never exits, as a read stuck on a slow disk would;
   * the channel stays open until the client closes it.
   */
  hang?: boolean;
}

function keyOf(material: string): ParsedKey {
  const parsed = utils.parseKey(material);
  if (parsed instanceof Error) throw parsed;
  return Array.isArray(parsed) ? (parsed[0] as ParsedKey) : parsed;
}

/**
 * An ed25519 key pair ssh2 can read back. ssh2 1.17's `generateKeyPairSync`
 * now and then writes an OpenSSH private key its own parser refuses
 * ("Malformed OpenSSH private key"), which reddened a random test here; a pair
 * that does not parse is generated again.
 */
function parseableKeyPair(): { private: string; public: string } {
  for (;;) {
    const pair = utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
}

export async function startSshForwardServer(
  options: {
    /** The user it accepts; `deploy` unless a test says (a Stack VM's is `root`). */
    username?: string;
  } = {},
): Promise<SshForwardServer> {
  const username = options.username ?? 'deploy';
  const hostKey = parseableKeyPair();
  const clientKey = parseableKeyPair();
  const wrongKey = parseableKeyPair();
  const accepted: ParsedKey[] = [keyOf(clientKey.public)];

  const closeWaiters: (() => void)[] = [];
  const open = new Set<{ end(): unknown }>();
  const state: Omit<
    SshForwardServer,
    'connection' | 'hostKeyFingerprint' | 'close' | 'allClosed'
  > = {
    wrongKey: wrongKey.private,
    forwards: [],
    connections: [],
    forwardAnswer: 'accept',
    execs: [],
    scripts: [],
    execAnswer: () => ({ stderr: 'sh: not found\n', code: 127 }),
    authorize: (publicKeyLine: string) => {
      accepted.push(keyOf(publicKeyLine));
    },
    dropConnections: () => {
      for (const client of open) client.end();
    },
  };
  const settleWaiters = () => {
    if (state.connections.every((c) => c.closed)) {
      closeWaiters.splice(0).forEach((resolve) => resolve());
    }
  };

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    const record = { closed: false };
    state.connections.push(record);
    open.add(client);
    client
      .on('authentication', (ctx) => {
        if (ctx.method !== 'publickey' || ctx.username !== username) {
          return ctx.reject(['publickey']);
        }
        const offered = ctx.key.data;
        const allowed = accepted.find((key) => {
          const allowedSsh = key.getPublicSSH();
          return (
            ctx.key.algo === key.type &&
            offered.length === allowedSsh.length &&
            timingSafeEqual(offered, allowedSsh)
          );
        });
        if (!allowed) {
          return ctx.reject(['publickey']);
        }
        if (
          ctx.signature &&
          ctx.blob &&
          allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true
        ) {
          return ctx.reject(['publickey']);
        }
        ctx.accept();
      })
      .on('ready', () => {
        client.on('tcpip', (accept, reject, info) => {
          state.forwards.push({
            destIP: info.destIP,
            destPort: info.destPort,
          });
          if (state.forwardAnswer === 'reject') return reject();
          const channel = accept();
          const socket = connect(info.destPort, info.destIP);
          socket.on('error', () => channel.destroy());
          channel.on('error', () => socket.destroy());
          channel.pipe(socket).pipe(channel);
        });
        client.on('session', (acceptSession) => {
          const session = acceptSession();
          // A terminal, for a forwarded log follower or a shell.
          session.on('pty', (acceptPty) => acceptPty?.());
          session.on('exec', (acceptExec, _reject, info) => {
            state.execs.push(info.command);
            const stream = acceptExec();
            const reply = (stdin?: string) => {
              const answer = state.execAnswer(info.command, stdin);
              if (answer.stderr) stream.stderr.write(answer.stderr);
              if (answer.hang) {
                stream.write(answer.stdout ?? '');
                return;
              }
              stream.exit(answer.code);
              stream.end(answer.stdout ?? '');
            };
            if (!info.command.endsWith(' -s')) {
              reply();
              return;
            }
            let stdin = '';
            stream.on('data', (chunk: Buffer) => {
              stdin += chunk.toString();
            });
            stream.on('end', () => {
              state.scripts.push({ command: info.command, stdin });
              reply(stdin);
            });
          });
        });
      })
      .on('error', () => undefined)
      .on('close', () => {
        record.closed = true;
        open.delete(client);
        settleWaiters();
      });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return Object.assign(state, {
    connection: {
      host: '127.0.0.1',
      port,
      username: 'deploy',
      privateKey: clientKey.private,
      hostKey: unverifiedHostKey(),
    },
    hostKeyFingerprint: hostKeyFingerprint(
      keyOf(hostKey.public).getPublicSSH(),
    ),
    allClosed: () =>
      new Promise<void>((resolve) => {
        closeWaiters.push(resolve);
        settleWaiters();
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  });
}
