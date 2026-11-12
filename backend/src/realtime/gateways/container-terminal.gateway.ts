import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Inject, Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { RunTargetForwardError, runTargetOn } from '../../remote/run-target';
import type { RunTarget } from '../../remote/run-target';
import { ServersService } from '../../servers/servers.service';
import { PtyChannelService } from '../channels/pty-channel.service';
import { SshChannelService } from '../channels/ssh-channel.service';
import type { StreamChannel } from '../channels/stream-channel';
import { ContainerAccessService } from '../container-access.service';
import {
  authorizedServerOrThrow,
  findAuthorizedServer,
} from '../server-access';
import {
  armAuthorizationLease,
  armKeepAlive,
  closeIfHostUnreachable,
  denyConnection,
  LEASE_RENEWAL_INTERVAL,
  permissionCtxOrDeny,
  sendIfOpen,
} from '../socket-access';
import {
  bridgeTerminalInput,
  captureInitialSize,
  SHELL_OPEN_FRAME,
  TERMINAL_CLOSE,
  terminalCloseReason,
} from '../terminal-protocol';
import type { InitialSizeCapture } from '../terminal-protocol';
import { WsAuthGuard } from '../ws-auth.guard';
import type { WsClient } from '../ws-client';
import { isValidContainerId, isValidShell, isValidStackId } from '../ws.utils';
import { terminalLine } from './server-terminal.gateway';

/**
 * The variable every container shell is started with, naming its session.
 * Every process the shell starts inherits it, which is what lets a
 * close find them.
 */
export const TERMINAL_SESSION_VARIABLE = 'CLOUDGATE_TERMINAL';

/**
 * How this socket ends when the shell does. Every other exit is
 * `socket-access.ts`'s or a validator's `4000`.
 *
 * `shellClosed` is `/terminal`'s own `1000`: a shell that ended is the same
 * event on both sockets, and the console words it the same way. `noShell` is
 * this socket's alone and reads as its HTTP status with a 4000 offset, the
 * scheme `TERMINAL_CLOSE` uses — the shell asked for is not in the image, and
 * asking again will not put it there. The console keeps a copy
 * (`terminals.ts`'s `NO_SHELL_CLOSE_CODE`), pinned from
 * `container-terminal-close.spec.ts`.
 */
export const CONTAINER_TERMINAL_CLOSE = {
  /** The shell ended. Nothing went wrong. */
  shellClosed: TERMINAL_CLOSE.shellClosed,
  /** The image has no such shell: `docker exec` could not start it at all. */
  noShell: 4404,
} as const;

/**
 * How the container runtime's refusal starts when the shell is not in the
 * image, for a bare name (`… executable file not found in $PATH`) and an
 * absolute path (`… stat /bin/sh: no such file or directory`) alike; `docker
 * exec` then exits 127. Measured on Docker 29.
 */
const NO_SHELL_OUTPUT = /OCI runtime exec failed/;
const NO_SHELL_EXIT_CODE = 127;

/** How much of a session's opening output is kept to recognise that refusal.
 *  The runtime's line is all a shell that never started prints. */
const OPENING_OUTPUT_LIMIT = 1024;

/** How long a reaper may take before its channel is torn down regardless. */
const REAP_TIMEOUT_MS = 10_000;

/**
 * What a close runs inside the container: hang up every process carrying this
 * session's variable, give them a second, then kill whatever ignored it.
 *
 * Found through `/proc/<pid>/environ` rather than a PID the shell reported,
 * because the shell is not the only thing to end — a `sleep 600` left in the
 * foreground, or a job sent to the background, is reparented to the
 * container's init when the shell dies and would survive a kill of the shell
 * alone. `tr` first because `environ` is NUL-separated and busybox's `grep`
 * stops reading a line at the first NUL. The redirection's own error (a
 * process that exited mid-loop) is silenced before `<` is attempted.
 *
 * One argument of the reaper's `<shell> -c`: the run target passes it as argv
 * to a local pty, and quotes it once like every other word of that command
 * over SSH
 * (CODING_STANDARDS §2.9), so nothing in it is shaped around the remote shell.
 */
export function reapScript(session: string): string {
  return [
    `m=${TERMINAL_SESSION_VARIABLE}=${session};`,
    'for s in HUP KILL; do',
    'for f in /proc/[0-9]*/environ; do',
    'if tr "\\0" "\\n" 2>/dev/null < $f | grep -qx $m; then',
    'p=${f#/proc/}; kill -$s ${p%/environ} 2>/dev/null;',
    'fi; done;',
    '[ $s = HUP ] && sleep 1;',
    'done; true',
  ].join(' ');
}

/**
 * The /docker-container-terminal socket: an interactive
 * `docker exec` shell inside a container, locally through a pty or on a
 * remote server over SSH.
 *
 * What the browser may say on this socket — input, and the one resize control
 * frame — is `terminal-protocol.ts`. Read it before touching `bridge`.
 *
 * Authorized by the Service that owns the container (ADR-0008). This is the
 * sharpest of the three container sockets: an interactive shell inside any
 * container on the host, reachable with authentication alone, on a platform
 * whose containers hold application secrets and database data.
 */
@WebSocketGateway({ path: '/docker-container-terminal' })
export class ContainerTerminalGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ContainerTerminalGateway.name);

  constructor(
    private readonly wsAuth: WsAuthGuard,
    private readonly servers: ServersService,
    private readonly containerAccess: ContainerAccessService,
    private readonly sshChannels: SshChannelService,
    private readonly ptyChannels: PtyChannelService,
    @Inject(LEASE_RENEWAL_INTERVAL)
    private readonly leaseRenewalIntervalMs: number,
  ) {}

  async handleConnection(ws: WsClient, req: IncomingMessage) {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const containerId = url.searchParams.get('containerId');
    const activeWay = url.searchParams.get('activeWay');
    const serverId = url.searchParams.get('serverId');

    if (!containerId) {
      ws.close(4000, 'containerId not provided');
      return;
    }
    if (!isValidContainerId(containerId)) {
      ws.close(4000, 'Invalid container ID format');
      return;
    }
    if (activeWay && !isValidShell(activeWay)) {
      ws.close(4000, 'Invalid shell specified');
      return;
    }
    const shell = activeWay || 'sh';

    // Before the first await: a browser sends its size as soon as the socket is
    // open, and that is long before there is a pty to give it to.
    const initialSize = captureInitialSize(ws);

    const auth = await this.wsAuth.authenticate(ws, req);
    if (!auth) return;

    const ctx = permissionCtxOrDeny(ws, this.logger, auth);
    if (!ctx) return;

    // A stack on its own Stack VM (ADR-0070) is named by the stack, never by
    // a `serverId`: a Stack VM is no Server, and where it runs is read off the
    // stack the caller is entitled to, not trusted from the URL.
    const composeId = url.searchParams.get('composeId');
    if (
      composeId !== null &&
      (!isValidStackId(composeId) || serverId !== null)
    ) {
      ws.close(4000, 'Invalid composeId parameter');
      return;
    }
    // What the run target and the lease reach: the Server in the URL, the
    // stack's Stack VM, or the platform host.
    let place: string | null = serverId;

    // The machine before the workload: the container is inspected on the server
    // being addressed, so an unowned server must not be reached at all. The
    // `if (serverId)` conditional stays — an absent id means the platform host,
    // which has no server row to check and is now authorized all the same.
    let missingKey = false;
    if (serverId) {
      const server = await findAuthorizedServer(this.servers, auth, serverId, {
        logger: this.logger,
        subject: '/docker-container-terminal',
      });
      if (!server) {
        ws.close();
        return;
      }
      missingKey = !server.sshKeyId;
    }

    // Which Service owns this container, and whether this caller may reach it.
    // The resolution comes back because the lease below renews the entitlement
    // half without re-running it (ADR-0012).
    let ownerNames: string[];
    try {
      // `update`, not `read`: a shell writes inside the workload, and
      // `service: ['read']` means read only. ADR-0008 records the cost
      // to a read-only custom role.
      if (composeId !== null) {
        const stackVm = await this.containerAccess.authorizeStackVmContainer(
          ctx,
          composeId,
          containerId,
          'update',
        );
        place = stackVm.remoteId;
        ownerNames = stackVm.appNames;
      } else {
        ownerNames = await this.containerAccess.authorizeContainer(
          ctx,
          { containerId, serverId },
          'update',
        );
      }
    } catch (error) {
      // A machine that was never reached is not a refusal. Same guard,
      // ahead of the same blanket catch, as `/docker-container-logs`: a 503
      // cannot reach a WebSocket client, so without this the shell surface
      // keeps telling an operator they may not touch a container on a Server
      // nothing spoke to.
      if (
        closeIfHostUnreachable(
          ws,
          this.logger,
          ctx,
          `container ${containerId}`,
          error,
        )
      ) {
        return;
      }
      denyConnection(
        ws,
        this.logger,
        ctx,
        `container ${containerId}: ${(error as Error).message}`,
      );
      return;
    }

    // The socket may have closed while it was being authorized: React
    // StrictMode opens a Shell tab's socket and closes it at once, and an
    // operator can change the picker or leave the tab inside the connect
    // window. Its `'close'` has fired already and will not fire again, so a
    // shell started now would have no reaper and stay in the container
    // for good. Nothing has been started yet, so nothing needs ending.
    if (ws.readyState !== ws.OPEN) return;

    // Uniform with the log streams, terminals included (ADR-0012): the
    // intuition that a shell dropped mid-command costs more than a log tail
    // dropped mid-stream argues for renewing this *more* often, not less. What
    // is on the other end of this socket is `docker exec` inside a container
    // holding application secrets, so a policy gentler here than on
    // `deployment-logs` would grant the longest survival to the thing most
    // worth revoking.
    armAuthorizationLease({
      ws,
      logger: this.logger,
      caller: auth,
      subject: `container ${containerId}`,
      renewalIntervalMs: this.leaseRenewalIntervalMs,
      credentials: this.wsAuth,
      // `serverId` travels with the appNames, as on
      // `/docker-container-logs`: an unmanaged container on the *platform host*
      // additionally takes instance authority, and a renewal that dropped the
      // machine would re-run the weaker of the two checks for as long as the
      // shell was held open.
      authorize: async () => {
        if (serverId) {
          await authorizedServerOrThrow(this.servers, auth, serverId);
        }
        // The same action as at connect, or revoking `service:update` would
        // leave an open shell standing until it closed by itself.
        await this.containerAccess.authorizeAppNames(
          ctx,
          ownerNames,
          place,
          'update',
        );
      },
    });
    // A shell at a prompt is the quietest socket in the module: nothing arrives
    // and nothing leaves, so a peer that vanished without a close frame is
    // invisible until something asks.
    armKeepAlive({
      ws,
      logger: this.logger,
      caller: auth,
      subject: `container ${containerId}`,
    });

    // Hanging up the channel ends the `docker exec` *client* and nothing else:
    // Docker does not pass that hangup to the shell it started, which stays in
    // the container on a pty dockerd holds open. So the shell carries a
    // session of its own, and a close ends every process that inherited it.
    const session = randomBytes(16).toString('hex');
    const shellArgs = [
      'exec',
      '-it',
      '-e',
      `${TERMINAL_SESSION_VARIABLE}=${session}`,
      '-w',
      '/',
      containerId,
      shell,
    ];
    // Where the container runs: its Server over SSH, its stack's Stack VM
    // through the cloud's tunnel, or the platform host through a local pty
    // (`remote/run-target.ts`). The shell and its reaper both go through it,
    // so neither picks a transport.
    const target = runTargetOn(place, {
      channels: { ssh: this.sshChannels, pty: this.ptyChannels },
    });
    const reap = () => this.reap({ containerId, target, shell, session });

    try {
      if (missingKey) {
        throw new Error('No SSH key available for this server');
      }

      let channel: StreamChannel;
      try {
        channel = await target.forward(
          { argv: ['docker', ...shellArgs] },
          { pty: true, ...initialSize.take() },
        );
      } catch (error) {
        // A Server that would not open the channel is said and the socket
        // ends; anything else is said by the catch below, as it always was.
        if (!(error instanceof RunTargetForwardError)) throw error;
        if (this.say(ws, error.message)) ws.close();
        return;
      }
      // Closed while the channel was opening — over SSH that takes long
      // enough to be the likelier window of the two: this channel's
      // `docker exec` may already have started a shell, so it is ended the
      // way a close of an open one is.
      if (ws.readyState !== ws.OPEN) {
        channel.close();
        reap();
        return;
      }
      this.bridge(ws, channel, initialSize, reap, shell);
      // Only an SSH channel fails after it opened; a local pty never says so.
      channel.onError((err) => {
        if (this.say(ws, `SSH error: ${err.message}`)) ws.close();
      });
    } catch (error) {
      this.say(ws, (error as Error).message);
    }
  }

  /**
   * A frame this gateway composed itself, in the line discipline the console
   * expects.
   *
   * Same well, same emulator, same defect as `/terminal`: `convertEol: false`
   * means a bare LF drops the cursor without returning the carriage, so these
   * four frames staircased under the shell's own output. `bridge`'s
   * `onData`/`onStderr` do not come through here — those are the pty's bytes,
   * which already carry CRLF — but they do go through `sendIfOpen`, which is
   * about whether there is a socket left rather than about the bytes.
   *
   * Answers whether the frame went out, so the two callers that close afterwards
   * do not close a socket that was already gone.
   */
  private say(ws: WsClient, text: string): boolean {
    return sendIfOpen(ws, terminalLine(text));
  }

  /** Terminal plumbing shared by both branches: output → socket, input and
   * resizes → channel, the shell ending ends the socket, and the socket closing
   * tears the channel down and then ends what it started inside the container. */
  private bridge(
    ws: WsClient,
    channel: StreamChannel,
    initialSize: InitialSizeCapture,
    reap: () => void,
    shell: string,
  ) {
    // The shell is open: sent before any of the channel's bytes, so
    // the console's pill can leave `pending` on it and on nothing earlier.
    sendIfOpen(ws, SHELL_OPEN_FRAME);
    let opening = '';
    const forward = (data: string) => {
      if (opening.length < OPENING_OUTPUT_LIMIT) opening += data;
      sendIfOpen(ws, data);
    };
    channel.onData(forward);
    channel.onStderr(forward);
    channel.onClose((code) => this.shellEnded(ws, code, opening, shell));
    // The channel exists now, so resizes go to it rather than into the capture
    // — including one that arrived while it was being opened.
    initialSize.handOver(channel);
    bridgeTerminalInput(ws, channel);
    ws.on('close', () => {
      channel.close();
      reap();
    });
  }

  /**
   * The shell ended, so the socket does too, saying why.
   *
   * This used to print a line and leave the socket open, which is the defect
   * fixed on `/terminal`: a green "running" pill over a shell that was
   * gone, and keystrokes into a socket attached to nothing. The line named the
   * wrong thing as well — "Container closed" — when what ended was the
   * `docker exec` and the container was still up.
   *
   * An image with no such shell is the same close with a 127 in it, and the
   * runtime's refusal is all the operator saw. It keeps its own code,
   * and a line in words under the runtime's: a 127 alone is not enough to say
   * so, because a shell whose last command was not found exits 127 too.
   *
   * ssh2 reports no code for a shell killed by a signal, and the absence is not
   * interpolated.
   */
  private shellEnded(
    ws: WsClient,
    code: number | undefined,
    opening: string,
    shell: string,
  ) {
    if (code === NO_SHELL_EXIT_CODE && NO_SHELL_OUTPUT.test(opening)) {
      const noShell = `This image has no shell to open: ${shell} is not in it`;
      this.say(ws, `\n${noShell}.\n`);
      this.end(ws, CONTAINER_TERMINAL_CLOSE.noShell, noShell);
      return;
    }
    const ended =
      typeof code === 'number'
        ? {
            line: `The shell exited with code ${code}.`,
            reason: `shell exited with code ${code}`,
          }
        : {
            line: 'The shell ended without an exit code.',
            reason: 'shell ended without an exit code',
          };
    this.say(ws, `\n${ended.line}\n`);
    this.end(ws, CONTAINER_TERMINAL_CLOSE.shellClosed, ended.reason);
  }

  /** End the socket saying why, unless it is already gone. */
  private end(ws: WsClient, code: number, reason: string): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.close(code, terminalCloseReason(reason));
  }

  /**
   * End every process in the container that carries this session, over
   * the same transport the shell used: a second SSH exec on a Server, a second
   * `docker exec` on the platform host. One-shot and without a terminal.
   *
   * It runs on every close, including after a shell the operator already
   * exited, where it finds nothing. A reaper that cannot run — the Server went
   * away, the container was removed — is journalled and dropped: the socket is
   * already gone, so there is nobody to tell, and a container that no longer
   * exists has nothing left in it.
   */
  private reap({
    containerId,
    target,
    shell,
    session,
  }: {
    containerId: string;
    target: RunTarget;
    shell: string;
    session: string;
  }) {
    const script = reapScript(session);
    const failed = (error: unknown) =>
      this.logger.warn(
        `Could not end the shell in container ${containerId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    const bounded = (channel: StreamChannel) => {
      channel.onError(failed);
      const timeout = setTimeout(() => channel.close(), REAP_TIMEOUT_MS);
      timeout.unref();
      channel.onClose(() => clearTimeout(timeout));
    };

    target
      .forward({ argv: ['docker', 'exec', containerId, shell, '-c', script] })
      .then(bounded)
      .catch((error: unknown) =>
        failed(error instanceof RunTargetForwardError ? error.cause : error),
      );
  }
}
