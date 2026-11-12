import type { IncomingMessage } from 'node:http';
import { Inject, Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { execOnServer } from '../../remote/exec-dispatch';
import { RemoteExecService } from '../../remote/remote-exec.service';
import { RunTargetForwardError, runTargetOn } from '../../remote/run-target';
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
import { WsAuthGuard } from '../ws-auth.guard';
import type { WsClient } from '../ws-client';
import {
  buildContainerLogsCommand,
  isValidContainerId,
  isValidSearch,
  isValidSince,
  isValidStackId,
  isValidTail,
} from '../ws.utils';

/**
 * How this socket ends when the output it follows does. Every other
 * exit is a validator's `4000` or `socket-access.ts`'s band.
 *
 * `4014`, the next free code after `4013` (`REAPED_LOG_CLOSE_CODE`), and in
 * the same band for the same reason: not a judgement of the request, and being
 * 4xxx is what stops the console redialling on its own — a redial of a
 * container that stopped would only replay its tail and end again, and of one
 * that restarted would silently hide that it restarted. Reconnect is the
 * operator's to press. The console keeps a copy (`gateways.ts`'s
 * `OUTPUT_ENDED_CLOSE_CODE`), pinned from `container-logs-close.spec.ts`.
 */
export const CONTAINER_LOGS_CLOSE = {
  /** The follower exited, or the Swarm service it followed was removed. */
  outputEnded: 4014,
} as const;

/**
 * The sentence the socket closes with when the follower exits.
 *
 * `docker logs --follow` exits 0 and prints nothing when its container stops,
 * and a restart is a stop — measured on Docker 29 against `traefik/whoami`. So
 * the exit is not a failure to report, it is the container's own end, and the
 * three things that cause it are named because the screen cannot tell which.
 * A follower that could not start at all (no such container, no such service)
 * exits the same way, having printed the daemon's words into the well first.
 */
export const outputEndedReason = (runType: string | null): string =>
  runType === 'swarm'
    ? "The service's output ended: it was stopped, removed or could not be read"
    : "The container's output ended: it stopped, restarted or was removed";

/**
 * The sentence for a Swarm service that went away under its follower.
 *
 * Its own sentence rather than {@link outputEndedReason}'s, because here the
 * gateway *knows* which of the three happened — the service is not listed.
 */
export const SERVICE_REMOVED_REASON =
  'The Swarm service was removed, so there is no output left to follow';

/**
 * How often a socket following a Swarm service asks whether it still exists.
 *
 * `docker service logs --follow` does not exit when `docker stack rm` removes
 * the service it follows (U09: the follower stayed alive after the stack read
 * `Nothing found in stack`, and ended only when the tab closed), so unlike a
 * container's follower there is no process event to close on. One
 * `docker service ls` per ten seconds per open service socket is the cost; the
 * lease already spends a query every thirty on the same socket.
 */
export const SERVICE_PRESENCE_INTERVAL_MS = 10_000;

/**
 * Whether `name` is a Swarm service on the Server or platform host, asked in a shape whose
 * "no" is an empty answer rather than an error to parse. `--filter name=`
 * matches a prefix, so the caller compares whole lines. Argv (§2.9): the name
 * is one word, on top of `isValidContainerId`.
 */
const listServiceCommand = (name: string): string[] => [
  'docker',
  'service',
  'ls',
  '--filter',
  `name=${name}`,
  '--format',
  '{{.Name}}',
];

/**
 * The /docker-container-logs socket: follow a container's (or
 * swarm service's) logs, optionally filtered, either on the local host
 * through a pty or on a remote server over SSH.
 *
 * Authorized by the Service that owns the container (ADR-0008): the gateway
 * used to authenticate and stop, so any member could read any container's logs
 * by id — including on the platform host, which the `if (serverId)` branch
 * never checked at all.
 */
@WebSocketGateway({ path: '/docker-container-logs' })
export class ContainerLogsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ContainerLogsGateway.name);

  constructor(
    private readonly wsAuth: WsAuthGuard,
    private readonly servers: ServersService,
    private readonly containerAccess: ContainerAccessService,
    private readonly sshChannels: SshChannelService,
    private readonly ptyChannels: PtyChannelService,
    private readonly remoteExec: RemoteExecService,
    @Inject(LEASE_RENEWAL_INTERVAL)
    private readonly leaseRenewalIntervalMs: number,
  ) {}

  async handleConnection(ws: WsClient, req: IncomingMessage) {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const containerId = url.searchParams.get('containerId');
    const tail = url.searchParams.get('tail') ?? '100';
    const search = url.searchParams.get('search') ?? '';
    const since = url.searchParams.get('since') ?? 'all';
    const serverId = url.searchParams.get('serverId');
    const runType = url.searchParams.get('runType');

    if (!containerId) {
      ws.close(4000, 'containerId not provided');
      return;
    }
    if (!isValidContainerId(containerId)) {
      ws.close(4000, 'Invalid container ID format');
      return;
    }
    if (!isValidTail(tail)) {
      ws.close(4000, 'Invalid tail parameter');
      return;
    }
    if (!isValidSince(since)) {
      ws.close(4000, 'Invalid since parameter');
      return;
    }
    if (search !== '' && !isValidSearch(search)) {
      ws.close(4000, 'Invalid search parameter');
      return;
    }

    const auth = await this.wsAuth.authenticate(ws, req);
    if (!auth) return;

    const ctx = permissionCtxOrDeny(ws, this.logger, auth);
    if (!ctx) return;

    // `follow=false` reads the tail and ends (the Cloudgate CLI's `logs`
    // without `-f`); absent, the socket follows, as the console's does.
    // Read only once the caller is known (§2.10): the parameters above it
    // predate that rule.
    const followParam = url.searchParams.get('follow');
    if (
      followParam !== null &&
      followParam !== 'true' &&
      followParam !== 'false'
    ) {
      ws.close(4000, 'Invalid follow parameter');
      return;
    }
    const follow = followParam !== 'false';

    // `taskPrefix=true` keeps Docker's per-copy prefix on a Swarm service's
    // lines, for an Application's Logs tab, which names each line's copy
    // (#1341). Absent, the lines come stripped, as the database and Compose
    // views have always read them. A single container has no copies to name.
    const taskPrefixParam = url.searchParams.get('taskPrefix');
    if (
      taskPrefixParam !== null &&
      taskPrefixParam !== 'true' &&
      taskPrefixParam !== 'false'
    ) {
      ws.close(4000, 'Invalid taskPrefix parameter');
      return;
    }
    const taskPrefix = taskPrefixParam === 'true';
    if (taskPrefix && runType !== 'swarm') {
      ws.close(4000, 'taskPrefix is only for a Swarm service');
      return;
    }

    // A stack on its own Stack VM (ADR-0070) is named by the stack, never by
    // a `serverId`: a Stack VM is no Server, and where it runs is read off the
    // stack the caller is entitled to, not trusted from the URL.
    const composeId = url.searchParams.get('composeId');
    if (
      composeId !== null &&
      (!isValidStackId(composeId) || serverId !== null || runType === 'swarm')
    ) {
      ws.close(4000, 'Invalid composeId parameter');
      return;
    }
    // What the run target and the lease reach: the Server in the URL, the
    // stack's Stack VM, or the platform host.
    let place: string | null = serverId;

    // The machine before the workload: a container is inspected on the server
    // being addressed, so an unowned server must not be reached at all. The
    // `if (serverId)` conditional stays — `checkServerAccess` returns undefined
    // for an absent id across the whole HTTP surface, so "no server row to
    // check" is the deliberate contract for the platform host. What was missing
    // here was never the lookup; it was any authorization of the host branch.
    if (serverId) {
      const server = await findAuthorizedServer(this.servers, auth, serverId, {
        logger: this.logger,
        subject: '/docker-container-logs',
      });
      if (!server) {
        ws.close();
        return;
      }
      // A server without an SSH key leaves the socket open and silent.
      if (!server.sshKeyId) return;
    }

    // Which Service owns this container, and whether this caller may reach it.
    // The resolution comes back because the lease below renews the entitlement
    // half without re-running it: `runType` goes with the id — it decides *what
    // kind of object* the id names, and so which `docker inspect` can resolve
    // its owner at all. With `runType=swarm` the parameter is a service name —
    // every database's log view sends one, and the console sends no container
    // id on that screen — and inspecting a service as a container does not come
    // back unlabelled, it errors.
    let ownerNames: string[];
    try {
      if (composeId !== null) {
        const stackVm = await this.containerAccess.authorizeStackVmContainer(
          ctx,
          composeId,
          containerId,
          'read',
        );
        place = stackVm.remoteId;
        ownerNames = stackVm.appNames;
      } else {
        ownerNames = await this.containerAccess.authorizeContainer(
          ctx,
          {
            containerId,
            serverId,
            runType,
          },
          'read',
        );
      }
    } catch (error) {
      // A machine that was never reached is not a refusal, so it does not get
      // the refusal frame. Ahead of the deny for the same reason
      // `rethrowIfHostUnreachable` runs ahead of the throw in `resolveTarget`'s
      // catch: this blanket catch is what turned an unreachable Server into
      // "not found or not permitted" — an authorization claim about a machine
      // nothing spoke to — and a 503 does not reach a WebSocket client.
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
      // The same one frame `authorizedOrDeny` would have sent, said here because
      // this call answers with the resolution the lease needs (as
      // `/listen-deployment` does with its log source).
      denyConnection(
        ws,
        this.logger,
        ctx,
        `container ${containerId}: ${(error as Error).message}`,
      );
      return;
    }

    armAuthorizationLease({
      ws,
      logger: this.logger,
      caller: auth,
      subject: `container ${containerId}`,
      renewalIntervalMs: this.leaseRenewalIntervalMs,
      credentials: this.wsAuth,
      // Everything just checked except the resolution: a Server can be deleted,
      // moved to another Organization or the caller's reach into it withdrawn,
      // and entitlement to the Service is a row that changes — while the
      // container's labels are fixed for its life (ADR-0012).
      //
      // `serverId` travels with the appNames: an unmanaged container
      // on the *platform host* additionally takes instance authority, which is
      // member rows and therefore exactly the mutable kind this renewal exists
      // to re-read. Captured from the URL rather than re-derived, so the
      // renewal asks about the same machine the connection was cleared for.
      authorize: async () => {
        if (serverId) {
          await authorizedServerOrThrow(this.servers, auth, serverId);
        }
        await this.containerAccess.authorizeAppNames(
          ctx,
          ownerNames,
          place,
          'read',
        );
      },
    });

    // The ping this gateway used to hand-roll, moved into `socket-access.ts`.
    // Same 45 seconds and the same reason — a proxy idle timeout looks
    // exactly like the container stopping — but the ping and the decision that
    // the peer is gone are now one mechanism instead of a write-only ping that
    // held dead sockets open past the timeout that would have ended them.
    armKeepAlive({
      ws,
      logger: this.logger,
      caller: auth,
      subject: `container ${containerId}`,
    });

    if (runType === 'swarm') {
      this.watchServicePresence(ws, serverId, containerId);
    }

    // Where the container runs: its Server over SSH, its stack's Stack VM
    // through the cloud's tunnel, or the platform host through a local pty
    // (`remote/run-target.ts`). The follower is one program for all three,
    // so nothing here picks a transport.
    const target = runTargetOn(place, {
      remoteExec: this.remoteExec,
      channels: { ssh: this.sshChannels, pty: this.ptyChannels },
    });
    const command = buildContainerLogsCommand({
      containerId,
      tail,
      since,
      search,
      runType,
      follow,
      taskPrefix,
    });

    try {
      let channel: StreamChannel;
      try {
        channel = await target.forward(
          { program: command },
          {
            pty: true,
            hostTerminal: {
              name: 'xterm-256color',
              cwd: process.env.HOME,
              env: process.env,
              encoding: 'utf8',
              cols: 80,
              rows: 30,
            },
          },
        );
      } catch (error) {
        // A Server that would not open the channel is said and the socket
        // ends; anything else is said by the catch below, as it always was.
        if (!(error instanceof RunTargetForwardError)) throw error;
        sendIfOpen(ws, error.message);
        ws.close();
        return;
      }
      channel.onData((data) => sendIfOpen(ws, data));
      // A pty merges stderr into its output; an SSH channel keeps it apart.
      channel.onStderr((data) => sendIfOpen(ws, data));
      // The follower exiting is the output ending. The platform host used to
      // wire only the other direction, so a container that restarted left
      // the socket open over a follower that was gone and the console read
      // "Following …" until the operator pressed Reconnect.
      channel.onClose(() => this.outputEnded(ws, runType));
      // Only an SSH channel fails after it opened; a local pty never says so.
      channel.onError((err) => {
        sendIfOpen(ws, `SSH error: ${err.message}`);
        ws.close();
      });
      ws.on('close', () => channel.close());
      // Input typed into the logs view is forwarded to the terminal running
      // the docker logs command, wherever it runs.
      ws.on('message', (message) => {
        try {
          channel.write(message.toString());
        } catch (error) {
          sendIfOpen(ws, (error as Error).message);
        }
      });
    } catch (error) {
      sendIfOpen(ws, (error as Error).message);
    }
  }

  /**
   * The follower ended, so the socket does too, saying so. Guarded,
   * because a viewer leaving closes the socket first and kills the follower,
   * whose exit then arrives here with nothing left to tell.
   */
  private outputEnded(ws: WsClient, runType: string | null): void {
    this.end(ws, outputEndedReason(runType));
  }

  private end(ws: WsClient, reason: string): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.close(CONTAINER_LOGS_CLOSE.outputEnded, reason);
  }

  /**
   * Close the socket once the Swarm service it follows is no longer listed —
   * which kills the follower, through the socket's own `close` teardown.
   *
   * Asked on the Server or platform host the follower runs on. A probe that could not run (an
   * unreachable Server, a daemon that did not answer, a node that is not a
   * manager) is not an answer, and ends nothing: ADR-0005's split, applied to
   * sockets by ADR-0012, the same way `docker-stats.gateway.ts` logs a failed
   * tick rather than closing. One probe at a time, so a slow Server does not
   * stack them.
   */
  private watchServicePresence(
    ws: WsClient,
    serverId: string | null,
    service: string,
  ): void {
    let probing = false;
    const timer = setInterval(() => {
      if (probing) return;
      probing = true;
      void this.serviceIsListed(serverId, service)
        .then((isListed) => {
          if (isListed === false) this.end(ws, SERVICE_REMOVED_REASON);
        })
        .finally(() => {
          probing = false;
        });
    }, SERVICE_PRESENCE_INTERVAL_MS);
    ws.on('close', () => clearInterval(timer));
  }

  /** `null` when the question could not be asked. */
  private async serviceIsListed(
    serverId: string | null,
    service: string,
  ): Promise<boolean | null> {
    try {
      const { stdout } = await execOnServer(
        this.remoteExec,
        serverId,
        listServiceCommand(service),
      );
      return stdout.split('\n').some((line) => line.trim() === service);
    } catch (error) {
      // Debug, not warn: a Server that stopped answering fails this every ten
      // seconds for as long as the socket is open, and the lease already
      // journals that Server's absence on the same socket.
      this.logger.debug(
        `Could not ask whether service ${service} still exists: ${(error as Error).message}`,
      );
      return null;
    }
  }
}
