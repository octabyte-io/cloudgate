import type { IncomingMessage } from 'node:http';
import { ForbiddenException, Inject, Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type Docker from 'dockerode';
import { DOCKER_CLIENT } from '../../docker/docker-client.provider';
import type { PermissionCtx } from '../../rbac/permission.service';
import { RemoteExecService } from '../../remote/remote-exec.service';
import {
  CONTAINER_DENIAL_MESSAGE,
  ContainerAccessService,
  OWNER_LABELS,
} from '../container-access.service';
import { HostStatsService } from '../host-stats.service';
import type { ContainerStat } from '../live-stats';
import { liveStatsFrame } from '../live-stats';
import {
  armAuthorizationLease,
  armKeepAlive,
  authorizedOrDeny,
  LEASE_RENEWAL_INTERVAL,
  permissionCtxOrDeny,
  sendIfOpen,
} from '../socket-access';
import { WsAuthGuard } from '../ws-auth.guard';
import type { WsClient } from '../ws-client';

export type StatsAppType = 'application' | 'stack' | 'docker-compose';

/**
 * What the socket's `appName` was authorized as, and so what every tick
 * samples.
 *
 * - `service`: it names a Service, whose own containers are found by their
 *   **owner label** — an exact match, so a Compose called `traefik` is its
 *   `com.docker.compose.project=traefik` containers and nothing else.
 * - `container`: it named no Service and is Docker's own name for one
 *   container, the live picker's case — matched **exactly**. Docker's `name`
 *   filter is a substring match, and asking it for `traefik` on the platform
 *   host handed back `cloudgate-traefik`.
 *
 * Only `docker-compose` reads it: the other two kinds already select by an
 * exact label.
 */
export type StatsMatch = 'service' | 'container';

/**
 * The wss handler's per-container docker stats invocation (its format string
 * also carries the Container placeholder, unlike the metrics agent's).
 *
 * Argv rather than a command string: the JSON template is one word to
 * `docker` — which is what the single quotes around it were for — and the
 * container id is a word rather than something a shell parses. The id is
 * `isValidContainerId`-checked on the way in (§2.10), so this is one fewer word
 * to review rather than a fix.
 */
const dockerStatsCommand = (containerId: string): string[] => [
  'docker',
  'stats',
  containerId,
  '--no-stream',
  '--format',
  '{"BlockIO":"{{.BlockIO}}","CPUPerc":"{{.CPUPerc}}","Container":"{{.Container}}","ID":"{{.ID}}","MemPerc":"{{.MemPerc}}","MemUsage":"{{.MemUsage}}","Name":"{{.Name}}","NetIO":"{{.NetIO}}"}',
];

/**
 * The one `appName` that is not a workload: the platform host itself, sampled
 * through `HostStatsService` rather than through a container. The console's copy
 * of this literal is `features/monitoring/live/target-options.ts`'s `HOST`.
 *
 * Not to be confused with the `cloudgate` substring `isPlatformContainerName`
 * tests: that one is part of a container *name*, this one is a reserved
 * parameter value meaning "sample the machine".
 */
const HOST_STATS_APP_NAME = 'cloudgate';

/**
 * The machine every target on this socket lives on.
 *
 * This gateway takes no `serverId` parameter — it samples the local daemon and
 * `HostStatsService`, both of which are the platform host — so every
 * `authorizeAppNames` call here means "the platform host", which is what an
 * absent `serverId` names across the whole surface (ADR-0008's second
 * consequence). Named rather than written as a bare `undefined` at its four call
 * sites because the argument is a claim about the target rather than
 * a parameter nobody filled in: an unmanaged target on this machine takes
 * instance authority, and the renewal below has to say so too.
 */
const PLATFORM_HOST: undefined = undefined;

/**
 * How this socket ends when the container it was sampling is gone.
 *
 * Deliberately not `4000`. That band is the connect-time validators' — a
 * malformed parameter, *"the caller's own bug and safe to be specific about"*
 * (`socket-access.ts`) — and reusing it for a post-authorization runtime state
 * is exactly what made "no Service owns this name" distinguishable from "a
 * Service in another organization does". And deliberately not
 * `DENIED_CLOSE_CODE`: this caller has already been authorized against this
 * container, so there is nothing left to enumerate and a specific reason costs
 * nothing (the same carve-out ADR-0012 made for `4010` and ADR-0010 for
 * `local`).
 *
 * `4011` sits beside `LEASE_CLOSE_CODE`'s `4010` because it is its sibling —
 * both end a socket that was authorized and streaming, for a reason that is not
 * a judgement of the request — and outside `400x` for the same reason `4010` is.
 * 4xxx keeps the console from redialling a stream with nothing to follow.
 */
export const STATS_CLOSE = {
  workloadGone: 4011,
  workloadGoneReason: 'No running container to sample',
} as const;

/**
 * The /listen-docker-stats-monitoring socket: every 1300ms sample
 * the app's first running container (or the host itself when monitoring the
 * platform) and push that reading. Nothing is written to disk.
 * Local-host only (no serverId parameter exists).
 *
 * Authorized by the Service `appName` names, and — when it names none — by the
 * owner labels of the container it actually resolves to (ADR-0008). Of
 * the three container sockets this was the one with no check of any kind
 * beyond authentication. Monitoring the platform itself names no Service and no
 * container, and so falls to machine-level `docker:read` — plus instance
 * authority, because this socket's machine is always the platform
 * host and the readings are the machine's own. That is the boundary ADR-0013's
 * H-64 already put on `MonitoringService.findReadableTarget` for the same fact
 * over HTTP; this socket was the transport it left behind.
 */
@WebSocketGateway({ path: '/listen-docker-stats-monitoring' })
export class DockerStatsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(DockerStatsGateway.name);

  constructor(
    private readonly wsAuth: WsAuthGuard,
    private readonly containerAccess: ContainerAccessService,
    @Inject(DOCKER_CLIENT) private readonly docker: Docker,
    private readonly remoteExec: RemoteExecService,
    private readonly hostStats: HostStatsService,
    @Inject(LEASE_RENEWAL_INTERVAL)
    private readonly leaseRenewalIntervalMs: number,
  ) {}

  async handleConnection(ws: WsClient, req: IncomingMessage) {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const appName = url.searchParams.get('appName');
    const appType = (url.searchParams.get('appType') ||
      'application') as StatsAppType;

    if (!appName) {
      ws.close(4000, 'appName not provided');
      return;
    }

    const auth = await this.wsAuth.authenticate(ws, req);
    if (!auth) return;

    const ctx = permissionCtxOrDeny(ws, this.logger, auth);
    if (!ctx) return;

    // Captured at connect and renewed on the clock (ADR-0012): the *resolution*
    // is the expensive step and cannot go stale in a way that matters, the
    // entitlement is what changes.
    let owners: string[] = [];
    let match: StatsMatch = 'container';
    const allowed = await authorizedOrDeny(
      ws,
      this.logger,
      ctx,
      `appName ${appName}`,
      async () => {
        ({ owners, match } = await this.resolveAndAuthorize(
          ctx,
          appName,
          appType,
        ));
      },
    );
    if (!allowed) return;

    const authorize = () =>
      this.containerAccess.authorizeAppNames(
        ctx,
        owners,
        PLATFORM_HOST,
        'read',
      );

    armAuthorizationLease({
      ws,
      logger: this.logger,
      caller: auth,
      subject: `appName ${appName}`,
      renewalIntervalMs: this.leaseRenewalIntervalMs,
      credentials: this.wsAuth,
      authorize,
    });

    // Before the sampler, because the sampler is what it is protecting the box
    // from. This gateway armed no ping, so nothing made a vanished peer
    // observable, and `'close'` — the sampler's only teardown — never arrived
    // for a peer that went away without a close frame: the interval kept
    // spawning a `docker stats` subprocess every 1300ms after the page had
    // navigated away and after the tab was closed with zero TCP connections to
    // the port, and what finally reaped one nine-minute socket was a lease
    // renewal being refused rather than any teardown. `terminate()` emits
    // `'close'`, so this hook is what makes the two lines below fire at all.
    armKeepAlive({
      ws,
      logger: this.logger,
      caller: auth,
      subject: `appName ${appName}`,
    });

    const intervalId = setInterval(() => {
      void this.collectAndSend(ws, appName, appType, match);
    }, 1300);
    intervalId.unref?.();
    ws.on('close', () => clearInterval(intervalId));
  }

  /**
   * The first running container this `appName` names, on the local daemon, or
   * null. Both the connect-time authorization and every sampling tick go
   * through it, so they cannot disagree about which container is meant.
   *
   * **Every match is exact**. A `docker-compose` target was asked for
   * with Docker's `name` filter, which is a substring match, so a Compose a
   * customer called `traefik` streamed `cloudgate-traefik`'s readings while
   * the gate had only cleared that customer's own Service. A Service is now
   * found by its owner label, and a container name is still narrowed by the
   * daemon's filter but kept only when one of the container's names *is* it.
   */
  private async firstRunningContainer(
    appName: string,
    appType: StatsAppType,
    match: StatsMatch,
  ): Promise<Docker.ContainerInfo | null> {
    const byName = appType === 'docker-compose' && match === 'container';
    const filter = {
      status: ['running'],
      ...(appType === 'application' && {
        label: [`com.docker.swarm.service.name=${appName}`],
      }),
      ...(appType === 'stack' && {
        label: [`com.docker.swarm.task.name=${appName}`],
      }),
      ...(appType === 'docker-compose' &&
        match === 'service' && {
          label: [`com.docker.compose.project=${appName}`],
        }),
      ...(byName && { name: [appName] }),
    };
    const containers = await this.docker.listContainers({
      filters: JSON.stringify(filter),
    });
    const container = byName
      ? containers.find((row) => row.Names?.includes(`/${appName}`))
      : containers[0];
    return container && container.State === 'running' ? container : null;
  }

  /**
   * Authorize what this socket will actually sample, and answer the appNames its
   * lease renews against (ADR-0008, ADR-0012).
   *
   * `appName` here is two kinds of name and the oracle lived in the gap.
   * ADR-0008 says this socket "names its workload directly", and for an
   * Application it does — but the live picker sends Docker's own container name
   * (`target-options.ts` maps `docker ps` rows straight into the parameter), and
   * a swarm task's `${appName}.1.${taskId}` matches no Service row. Every one of
   * those fell to machine `docker:read` and reached the sampler, so
   * `4000 Container not running` meant "no Service owns this name" while `4003`
   * meant "a Service in another organization does" — and asking for another
   * organization's *container* name streamed its readings outright.
   *
   * So the name is resolved to the container it names, and the container is
   * authorized by its own owner labels. That is ADR-0008's rule as written, and
   * what the logs and terminal sockets already do; the labels arrive on the
   * `listContainers` row, so it costs no extra call.
   *
   * The order is load-bearing twice. The Service lookup is a DB read and runs
   * first, so a member entitled to their workload never needs `docker:read` —
   * ADR-0008's first consequence. And the daemon is asked only after
   * `docker:read` has been granted, so an unentitled caller does not reach a
   * daemon call on the way to being refused (ADR-0010's gate-before-side-effect
   * rule).
   *
   * A known limit, stated so nobody "finishes the job": a foreign Service's name
   * is refused without a daemon call while a name owned by nobody costs one
   * `docker ps`, so the two differ in *timing*. ADR-0008's rule is about the
   * frame, nothing in this codebase defends against timing side channels
   * anywhere, and closing it would mean listing containers for every refusal — a
   * daemon call for an unentitled caller, which ADR-0010 argues against.
   * Accepted, not overlooked.
   *
   * Throws on every denial, and `authorizedOrDeny` turns all of them into the
   * one `4003` frame with the specific cause in the journal.
   */
  private async resolveAndAuthorize(
    ctx: PermissionCtx,
    appName: string,
    appType: StatsAppType,
  ): Promise<{ owners: string[]; match: StatsMatch }> {
    // The platform host is not a container and names no Service, so the machine
    // gate is the whole answer — and `authorizeAppNames([])` *is* that gate,
    // which is why this needs no separate branch in the service.
    if (appName === HOST_STATS_APP_NAME) {
      await this.containerAccess.authorizeAppNames(
        ctx,
        [],
        PLATFORM_HOST,
        'read',
      );
      return { owners: [], match: 'container' };
    }

    // `service` only for a Service that runs on the platform host: the gate
    // sends one placed anywhere else to the machine branch, so a
    // customer's Service on their own Server is never sampled on this box.
    const branch = await this.containerAccess.authorizeAppNames(
      ctx,
      [appName],
      PLATFORM_HOST,
      'read',
    );
    if (branch === 'service') return { owners: [appName], match: 'service' };

    const container = await this.firstRunningContainer(
      appName,
      appType,
      'container',
    );
    if (!container) {
      // Byte-identical with the refusal a foreign Service's name gets, which is
      // the whole point (ADR-0008).
      throw new ForbiddenException(CONTAINER_DENIAL_MESSAGE);
    }
    const owners = OWNER_LABELS.map(
      (label) => container.Labels?.[label],
    ).filter((value): value is string => Boolean(value));
    // A managed container reached by its container name is authorized as its
    // Service; a genuinely unmanaged one has no labels, so this is the machine
    // gate again — already held, since the branch above granted it.
    await this.containerAccess.authorizeAppNames(
      ctx,
      owners,
      PLATFORM_HOST,
      'read',
    );
    return { owners, match: 'container' };
  }

  /**
   * End the socket saying why. Idempotent by readyState: a tick that finishes
   * after the peer has gone would otherwise close a socket that is already
   * closed, which `ws` throws on.
   */
  private end(ws: WsClient, code: number, reason: string): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.close(code, reason);
  }

  /** One sampling tick, of what the socket was authorized as (`match`). */
  async collectAndSend(
    ws: WsClient,
    appName: string,
    appType: StatsAppType,
    match: StatsMatch,
  ) {
    try {
      // Monitoring the platform itself samples the host, not a container.
      if (appName === HOST_STATS_APP_NAME) {
        const { stat, disk } = await this.hostStats.collect();
        // §2.10's last rule, and not decoration here: a tick that started while
        // the socket was open finishes after it is gone, because collecting a
        // sample awaits the host.
        sendIfOpen(ws, JSON.stringify({ data: liveStatsFrame(stat, disk) }));
        return;
      }

      const container = await this.firstRunningContainer(
        appName,
        appType,
        match,
      );
      if (!container) {
        this.end(ws, STATS_CLOSE.workloadGone, STATS_CLOSE.workloadGoneReason);
        return;
      }

      // Destructured rather than handed to `execOnServer` as an array: this
      // gateway is local-host only (no `serverId` exists to dispatch on), so it
      // addresses `execFileAsync` — the shell-free branch — directly.
      const [program, ...args] = dockerStatsCommand(container.Id);
      const { stdout, stderr } = await this.remoteExec.execFileAsync(
        program,
        args,
      );
      if (stderr) {
        this.logger.error(`Docker stats error: ${stderr}`);
        return;
      }
      const stat = JSON.parse(stdout) as ContainerStat;

      sendIfOpen(ws, JSON.stringify({ data: liveStatsFrame(stat) }));
    } catch (error) {
      // Logged, not closed. ADR-0005's split, and ADR-0012 applies it to
      // sockets: this is the system failing to *answer*, not answering "no", so
      // it must not end a stream. `Error: ${message}` on the wire was also an
      // internal detail no HTTP route would have been allowed to return (§2.5) —
      // the catch covers `listContainers`, `execAsync` and `JSON.parse`, so a
      // daemon's own error text reached the browser. A socket whose peer or
      // authorization has genuinely gone is ended by the keep-alive and the
      // lease (ADR-0012), not by one bad tick.
      this.logger.warn(
        `Stats sampling failed for ${appName}: ${(error as Error).message}`,
      );
    }
  }
}
