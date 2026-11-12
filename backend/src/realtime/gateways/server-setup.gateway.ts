import type { IncomingMessage } from 'node:http';
import { Inject, Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { PermissionService } from '../../rbac/permission.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import {
  SETUP_FAILED_PREFIX,
  SETUP_FINISHED_LINE,
  ServerSetupRuns,
} from '../../servers/server-setup-runs';
import { ServersService } from '../../servers/servers.service';
import {
  entitledToServerOrThrow,
  findAuthorizedServer,
} from '../server-access';
import {
  armAuthorizationLease,
  armKeepAlive,
  LEASE_RENEWAL_INTERVAL,
  sendIfOpen,
} from '../socket-access';
import { WsAuthGuard } from '../ws-auth.guard';
import type { WsClient } from '../ws-client';

/**
 * The transport for `serversService.setup`.
 *
 * A setup call that answers only when the script ends streams nothing, which
 * is the defect. The shape is
 * `/listen-deployment`'s — a wss handler that takes an id, streams into the
 * socket and closes when the run resolves — with one difference that matters:
 * this socket *starts* the work instead of following a file somebody else wrote.
 *
 * That difference is the whole design:
 *
 * - **The run belongs to the machine, not to the socket.** `serverSetupCommand()`
 *   pipes `get.docker.com` into `sh`, does `docker swarm init` and starts a
 *   Traefik container on 80 and 443; on a cold host that is minutes. A socket
 *   closing means somebody stopped watching, so it detaches a watcher and
 *   nothing else. There is deliberately no cancel: `execAsyncRemote` cannot
 *   stop a script mid-flight, and a half-finished Docker install is worse than
 *   a finished one.
 * - **A connection says whether it starts or watches (ADR-0058).** Only a dial
 *   carrying `start=true` may start a run, and the console sends it only on the
 *   dial right after an operator confirms *Run setup*. Every other dial — a
 *   backoff redial after a drop, a page opened later, a client that has never
 *   heard of the flag — watches: it attaches to the run in flight, or, with none,
 *   starts nothing and closes {@link SETUP_CLOSE.notRunning}. Without that, a
 *   drop in a run's last seconds or a backend restart mid-run redialled into a
 *   second provisioning that nobody asked for.
 * - **The runs are `ServerSetupRuns`', not this socket's.** The same map holds
 *   a Bought Server's first run, which the backend starts by itself once the
 *   machine answers (the amendment to ADR-0058), so a dial here attaches to
 *   that run too and the customer watches it as any other.
 * - **A second connection attaches, it does not provision again.** React's
 *   development double-mount, a change of target and any reconnect after a
 *   dropped frame all arrive here while the first run is still going. Each one
 *   — start-dial or watch-dial — attaches to the run in flight and gets what it
 *   missed replayed first.
 * - **The outcome is a frame, not a close code.** A close code cannot be trusted
 *   to arrive — a proxy or a dropped connection closes sockets too — so the run
 *   ends by *saying* how it ended, in the `✅`/`❌` register the setup script
 *   itself already prints. The codes below are a second, coarser signal.
 */

/** This gateway's whole close-code contract. */
export const SETUP_CLOSE = {
  /** The request was wrong and will be wrong again — no serverId. */
  badRequest: 4000,
  /** The run failed. Its message is the last frame; this reason is only a label. */
  failed: 4001,
  /** The caller can see this Server but may not provision it. */
  forbidden: 4003,
  /**
   * A watch-dial found no run in flight, so nothing was started (ADR-0058).
   * Not 1000, which is a run that finished while this socket heard it end, and
   * not a refusal: the run, if there was one, ended while nobody was connected,
   * and how it went is on the Server (`setupOk`, `setupMessage`).
   * `4015`, the next code after `container-logs`'s `4014`.
   */
  notRunning: 4015,
} as const;

/** The query flag a start-dial carries. Any other value, or none, watches. */
export const SETUP_START_PARAM = 'start';
const SETUP_START_VALUE = 'true';

/** The two lines a client can key on, kept beside the runs that print them. */
export { SETUP_FAILED_PREFIX, SETUP_FINISHED_LINE };

@WebSocketGateway({ path: '/listen-server-setup' })
export class ServerSetupGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ServerSetupGateway.name);

  constructor(
    private readonly wsAuth: WsAuthGuard,
    private readonly servers: ServersService,
    private readonly permissions: PermissionService,
    private readonly runs: ServerSetupRuns,
    @Inject(LEASE_RENEWAL_INTERVAL)
    private readonly leaseRenewalIntervalMs: number,
  ) {}

  async handleConnection(ws: WsClient, req: IncomingMessage) {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const serverId = url.searchParams.get('serverId');
    const starts =
      url.searchParams.get(SETUP_START_PARAM) === SETUP_START_VALUE;

    if (!serverId) {
      ws.close(SETUP_CLOSE.badRequest, 'serverId not provided');
      return;
    }

    const auth = await this.wsAuth.authenticate(ws, req);
    if (!auth) return;

    const server = await findAuthorizedServer(this.servers, auth, serverId, {
      logger: this.logger,
      subject: '/listen-server-setup',
    });
    if (!server) {
      ws.close();
      return;
    }

    const ctx: PermissionCtx = {
      user: { id: auth.user.id },
      session: { activeOrganizationId: server.organizationId },
    };

    // `POST /servers/:id/setup` carries @RequirePermission('server', 'create')
    // and Nest guards never run for a raw ws upgrade, so the same check is made
    // by hand here. The other gateways get away without one because they only
    // read; this is the socket that installs software on a machine, and a
    // `member` — whose role grants no `server` action at all — must not open it.
    //
    // A code rather than the neighbours' silent close: the caller has already
    // been shown this Server, so there is nothing left to leak, and a socket
    // that closed without a word is indistinguishable from a run that finished.
    const authorize = () =>
      entitledToServerOrThrow(
        { servers: this.servers, permissions: this.permissions },
        auth,
        serverId,
        'create',
      );
    try {
      await authorize();
    } catch {
      ws.close(
        SETUP_CLOSE.forbidden,
        'Not allowed to run setup on this Server',
      );
      return;
    }

    // A watch-dial with nothing to watch ends here, before a lease or a ping is
    // armed for a socket that is about to close. Decided after the entitlement
    // check on purpose: a caller who may not provision learns `4003`, not
    // whether a run happens to be going.
    if (!starts && !this.runs.inFlight(server.serverId)) {
      ws.close(SETUP_CLOSE.notRunning, 'No setup run in flight');
      return;
    }

    // A provisioning run goes minutes between lines and the socket pings to stay
    // up through it, so this is exactly the socket that outlives the access it
    // opened with. What the lease closes is the *watcher*: the run belongs
    // to the Server, and it goes on whether or not anyone is still looking.
    armAuthorizationLease({
      ws,
      logger: this.logger,
      caller: auth,
      subject: `server setup ${serverId}`,
      renewalIntervalMs: this.leaseRenewalIntervalMs,
      credentials: this.wsAuth,
      authorize,
    });

    // Keep-alive: a provisioning run can go several minutes between lines
    // (`apt-get update -y >/dev/null`), and an idle-timeout in a proxy would look
    // exactly like the run dying. Hand-rolled here and in `container-logs` until
    // it became one helper — the ping that keeps a socket alive and the check
    // that decides it is dead have to be the same mechanism.
    armKeepAlive({
      ws,
      logger: this.logger,
      caller: auth,
      subject: `server setup ${serverId}`,
    });

    // Read again rather than reusing the check above: nothing between them
    // awaits today, but the start decision has to be made against the run map
    // as it is when the run would be created.
    if (this.runs.inFlight(server.serverId)) {
      this.attach(server.serverId, ws);
      return;
    }
    if (!starts) {
      ws.close(SETUP_CLOSE.notRunning, 'No setup run in flight');
      return;
    }

    // Started and attached in the same tick, so the first chunk has a watcher.
    this.runs.start(server.serverId, ctx);
    this.attach(server.serverId, ws);
  }

  /**
   * Put a socket on a run: replay what it missed, then follow.
   *
   * Attaching rather than starting a second run is the one invariant this
   * gateway cannot get wrong. Every redial arrives here — React's development
   * double-mount, a reconnect after a dropped frame, a second operator opening
   * the same tab — and `docker swarm init` is not something to do twice because
   * a socket blinked.
   */
  private attach(serverId: string, ws: WsClient): void {
    // Checked once, here, rather than only per frame — and both, deliberately.
    //
    // Per frame is what `sendIfOpen` gives every send in the module and is the
    // guard that is correct by construction rather than by reasoning; the replay
    // loop below is synchronous today, so `readyState` cannot change inside it,
    // but that is a property of the loop and not of the contract, and the next
    // person to make buffering async would silently lose the guarantee.
    //
    // Once up front is what makes this replay different from a stray frame: a
    // wedged run holds up to MAX_BUFFERED_CHUNKS, so a socket that went away
    // during `authenticate` or the entitlement check — both awaited before
    // `handleConnection` reaches here — would otherwise walk five thousand
    // no-ops to write nothing. And returning before the watch is the part
    // that actually matters: `'close'` has already fired for a socket that is
    // gone, so the listener below would never run and a dead watcher would sit
    // in the set for the life of the run.
    if (ws.readyState !== ws.OPEN) return;
    const detach = this.runs.watch(serverId, {
      send: (chunk) => {
        sendIfOpen(ws, chunk);
      },
      end: (line, ok) => {
        if (!sendIfOpen(ws, line)) return;
        if (ok) ws.close(1000, 'Setup finished');
        else ws.close(SETUP_CLOSE.failed, 'Setup failed');
      },
    });
    if (detach) ws.on('close', detach);
  }
}
