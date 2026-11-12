import { appendFile } from 'node:fs/promises';

import type { IPtyForkOptions } from 'node-pty';
import { quote } from 'shell-quote';

import type { PtyChannelService } from '../realtime/channels/pty-channel.service';
import type { SshChannelService } from '../realtime/channels/ssh-channel.service';
import type { StreamChannel } from '../realtime/channels/stream-channel';
import { getShell } from '../realtime/ws.utils';
import { execOnServer } from './exec-dispatch';
import type { ShellProgramOptions } from './exec-dispatch';
import type { ExecResult, RemoteExecService } from './remote-exec.service';
import { stackOfRemoteId, stackVmRemoteId } from './stack-vm-remote';

/**
 * Where a Compose stack runs, as everything that runs something there sees
 * it: the deploy engine's compose program, Stop, Start, Remove containers, the
 * stack's file writes, its logs and its container terminal. A caller asks it
 * for an **exec** (a one-shot command or shell program, answered whole) and a
 * **forward** (a long-lived program whose bytes stream both ways), and never
 * asks which kind of place it is.
 *
 * Three kinds:
 *
 * - **a Server**, reached over SSH;
 * - **the platform host**, this machine;
 * - **a Stack VM** (ADR-0070), reached over SSH inside its cloud's tunnel:
 *   the remote-execution layer is asked for it by its own id
 *   (`stack-vm-remote.ts`), and only its tunnel answers that id. A stack's
 *   row says which kind it is ({@link RunPlace}), so no caller asks.
 *
 * **Not a second dispatch.** `exec` is `execOnServer`, the one local-or-remote
 * fork the tree has (`remote/exec-dispatch.ts`), so the SSH client, a Delete's
 * {@link ReachabilityMemo} (pass it as `remoteExec`) and a Deployment's
 * cancellation (`signal`) are the remote-execution layer's own. And like
 * `execOnServer` it is a free function over the services rather than a method
 * on them, so in a test it is the real code calling whichever doubled method
 * the place picks.
 *
 * @see ReachabilityMemo in `./reachability-memo.ts`.
 */
export interface RunTarget {
  /**
   * The Server this is, or `null` for the platform host and for a Stack VM,
   * which is never a Server. It names the Server in a Deployment's log. It is
   * never read to pick a transport, which is what `exec` and `forward` are
   * for.
   */
  readonly serverId: string | null;
  /**
   * The id the remote-execution layer reaches this by — a Server's id, a
   * Stack VM's (`stackVmRemoteId`) — or `null` for the platform host. What
   * roots the stack's paths (`composeDirectoryOn`): a Stack VM's are rooted
   * as a Server's are.
   */
  readonly remoteId: string | null;
  /** One command as argv: the caller quotes nothing (CODING_STANDARDS §2.9). */
  exec(command: string[]): Promise<ExecResult>;
  /** A shell program: every interpolation in it is its builder's to quote. */
  exec(command: string, options?: ShellProgramOptions): Promise<ExecResult>;
  /**
   * A shell program whose output (stdout and stderr) goes to the end of a
   * Deployment's log, its stdin closed. A Deployment's log is kept where
   * Cloudgate reads it back (`DeploymentsService.resolveLogSource`): on a
   * Server or the platform host the program appends to it there itself; a
   * Stack VM's stack keeps its logs on the platform host, so the output
   * streams back through the tunnel and is appended here as it arrives.
   */
  execToLog(
    program: string,
    logPath: string,
    options?: ShellProgramOptions,
  ): Promise<ExecResult>;
  /**
   * A long-lived program whose stdin and output stream to the caller: a
   * followed log, an interactive shell. On a Server a failure to open it
   * rejects with {@link RunTargetForwardError}.
   */
  forward(
    program: ForwardedProgram,
    options?: ForwardOptions,
  ): Promise<StreamChannel>;
}

/**
 * What a forward runs: one command as argv (quoted once, for SSH), or a shell
 * program (`-c` of this machine's shell on the platform host).
 */
export type ForwardedProgram =
  { readonly argv: readonly string[] } | { readonly program: string };

export interface ForwardOptions {
  /**
   * A terminal for the program, so it hears a hangup when the channel ends.
   * The platform host always runs a forward on a pty, as it always has.
   */
  readonly pty?: boolean;
  /** The terminal's window, where the caller knows it. */
  readonly cols?: number;
  readonly rows?: number;
  /**
   * How the platform host's pty is spawned beyond its window (node-pty's
   * name, cwd, env, encoding). A Server's SSH channel takes none of these, so
   * a Server is not sent them.
   */
  readonly hostTerminal?: IPtyForkOptions;
}

/** What a run target is built from. */
export interface RunTargetTransports {
  /** The exec layer, or a Delete's `ReachabilityMemo` over it. */
  readonly remoteExec?: RemoteExecService;
  /** The streaming transports, for `forward`. Only the sockets forward. */
  readonly channels?: {
    readonly ssh: Pick<SshChannelService, 'open'>;
    readonly pty: Pick<PtyChannelService, 'spawn'>;
  };
}

/**
 * A forward the Server would not open, worded as the sockets say it. The
 * cause's own text is kept: it is what the operator reads to tell a refused
 * port from a rejected key.
 */
export class RunTargetForwardError extends Error {
  constructor(readonly cause: unknown) {
    super(
      `SSH error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'RunTargetForwardError';
  }
}

/**
 * Where a stack runs, as its row says: a Cloud account means its own Stack
 * VM there, whatever else the row holds (ADR-0070); otherwise its Server, or
 * the platform host when it has none. A compose row is one.
 */
export interface StackPlace {
  readonly composeId: string;
  readonly serverId: string | null;
  readonly cloudAccountId: string | null;
}

/**
 * A run target's place: a stack's row, or the id the remote-execution layer
 * reaches it by — a Server's, a Stack VM's — or `null` for the platform host.
 */
export type RunPlace = StackPlace | string | null | undefined;

/** The id the remote-execution layer reaches `place` by, `null` for here. */
export function remoteIdOf(place: RunPlace): string | null {
  if (place === null || place === undefined || typeof place === 'string') {
    return place || null;
  }
  return place.cloudAccountId
    ? stackVmRemoteId(place.composeId)
    : place.serverId || null;
}

/**
 * The run target at `place`: a stack's Stack VM, its Server, or the platform
 * host (see {@link RunPlace}).
 */
export function runTargetOn(
  place: RunPlace,
  transports: RunTargetTransports,
): RunTarget {
  const remoteId = remoteIdOf(place);
  if (remoteId === null) return platformHostTarget(transports);
  return stackOfRemoteId(remoteId) === null
    ? sshTarget(remoteId, remoteId, transports)
    : sshTarget(null, remoteId, transports);
}

/**
 * A Server, or a Stack VM (`serverId` null): both are SSH through the
 * remote-execution layer at `remoteId`, which reaches a Stack VM's only
 * through its tunnel. They differ in where a Deployment's log is kept.
 */
function sshTarget(
  serverId: string | null,
  remoteId: string,
  transports: RunTargetTransports,
): RunTarget {
  return {
    serverId,
    remoteId,
    exec: (command: string | string[], options?: ShellProgramOptions) =>
      execAt(transports, remoteId, command, options),
    execToLog: (program, logPath, options) =>
      serverId === null
        ? execStreamedToLog(transports, remoteId, program, logPath, options)
        : execAt(transports, remoteId, appendingTo(program, logPath), options),
    async forward(program, options = {}) {
      const command = 'argv' in program ? quote(program.argv) : program.program;
      try {
        return await channelsOf(transports).ssh.open(
          { serverId: remoteId },
          {
            command,
            ...(options.pty ? { pty: true } : {}),
            ...windowOf(options),
          },
        );
      } catch (error) {
        throw new RunTargetForwardError(error);
      }
    },
  };
}

function platformHostTarget(transports: RunTargetTransports): RunTarget {
  return {
    serverId: null,
    remoteId: null,
    exec: (command: string | string[], options?: ShellProgramOptions) =>
      execAt(transports, null, command, options),
    execToLog: (program, logPath, options) =>
      execAt(transports, null, appendingTo(program, logPath), options),
    forward(program, options = {}) {
      const [file, args] =
        'argv' in program
          ? [program.argv[0], program.argv.slice(1)]
          : [getShell(), ['-c', program.program]];
      // A pty that will not spawn throws; it rejects here, as an SSH channel
      // that will not open does, so a caller has one failure path to read.
      try {
        return Promise.resolve(
          channelsOf(transports).pty.spawn(file, args, {
            ...options.hostTerminal,
            ...windowOf(options),
          }),
        );
      } catch (error) {
        return Promise.reject(error as Error);
      }
    },
  };
}

/** `execOnServer`, the one fork, at this place: argv takes no options. */
function execAt(
  transports: RunTargetTransports,
  serverId: string | null,
  command: string | string[],
  options?: ShellProgramOptions,
): Promise<ExecResult> {
  const remoteExec = execLayer(transports);
  return Array.isArray(command)
    ? execOnServer(remoteExec, serverId, command)
    : execOnServer(remoteExec, serverId, command, options);
}

/** `program`, appending all it prints to `logPath` where it runs. */
function appendingTo(program: string, logPath: string): string {
  return `(${program}) >> ${quote([logPath])} 2>&1 < /dev/null`;
}

/**
 * `program` on a Stack VM, everything it prints appended, in order, to the
 * Deployment log on the platform host. Through the remote-execution layer
 * itself, the one method that hands back output as it arrives, with the same
 * environment and cancellation `execOnServer` would carry.
 */
async function execStreamedToLog(
  transports: RunTargetTransports,
  remoteId: string,
  program: string,
  logPath: string,
  options: ShellProgramOptions = {},
): Promise<ExecResult> {
  let written = Promise.resolve();
  const onData = (chunk: string) => {
    written = written.then(() =>
      appendFile(logPath, chunk).catch(() => undefined),
    );
  };
  const { env, signal, maxBuffer, programOnStdin } = options;
  const named = {
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(signal ? { signal } : {}),
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
    ...(programOnStdin ? { programOnStdin } : {}),
  };
  try {
    return await execLayer(transports).execAsyncRemote(
      remoteId,
      `(${program}) 2>&1 < /dev/null`,
      onData,
      named,
    );
  } finally {
    await written;
  }
}

function windowOf(options: ForwardOptions): { cols?: number; rows?: number } {
  return {
    ...(options.cols === undefined ? {} : { cols: options.cols }),
    ...(options.rows === undefined ? {} : { rows: options.rows }),
  };
}

function execLayer(transports: RunTargetTransports): RemoteExecService {
  if (!transports.remoteExec) {
    throw new Error('This run target was built without the exec layer');
  }
  return transports.remoteExec;
}

function channelsOf(
  transports: RunTargetTransports,
): NonNullable<RunTargetTransports['channels']> {
  if (!transports.channels) {
    throw new Error('This run target was built without its stream channels');
  }
  return transports.channels;
}
