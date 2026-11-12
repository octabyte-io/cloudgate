import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { quote } from 'shell-quote';
import { checkServerAccess } from '../common/owned-server';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import {
  CONTAINER_DENIAL_MESSAGE,
  isPlatformContainerName,
} from '../realtime/container-access.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import type { Server } from '../servers/server.schema';
import { rethrowIfHostUnreachable } from './host-reachability';
import { execByServer } from './server-access';

/** A swarm query scoped to one server (the local daemon when absent). */
interface ServerScopedQuery {
  serverId?: string | null;
}

/**
 * Swarm monitoring endpoints — nodes, one node's inspect document, services,
 * their tasks and a container stats snapshot: `docker … --format '{{json .}}'`
 * listings parsed line by line. All guarded by server:read.
 *
 * **And all five inherited the swallow X11-4 filed**: `getNodeApplications` and
 * `getApplicationInfo` answered `[]` for a Server nobody reached, so
 * `GET /swarm/apps` said `200 []` about a host at `127.0.0.1:1` and the
 * console's Swarm services card read that as *"No Swarm services are running
 * here."* Every catch here now runs `rethrowIfHostUnreachable` first; what is
 * left of each swallow is a docker that ran and failed, which is what the
 * `stderr` branches above them already describe. `host-reachability.ts` carries
 * the argument.
 */
@Injectable()
export class SwarmService {
  private readonly logger = new Logger(SwarmService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
  ) {}

  /**
   * The target a swarm route names, and the authority it takes (H-63).
   *
   * `ClusterService.instanceOrServerScoped`'s twin, and it exists because
   * closing that one alone would have been theatre: `GET /cluster/nodes` and
   * `GET /swarm/nodes` answer the *same* `docker node ls` listing, over the same
   * absent-`serverId` branch, behind the same `server:read`. Gating one sibling
   * and not the other leaves the fact reachable and only moves which route
   * discloses it.
   *
   * A `serverId` names a Server in the caller's organization: the statement plus
   * `checkServerAccess`, exactly as before. **Its absence names the platform
   * host** (ADR-0008's second consequence), where the statement was the whole
   * gate — and `memberRole` aside, `server:read` is grantable to a licensed
   * custom role, which ADR-0013's third consequence rejects as a carrier for
   * host-level power.
   *
   * All five callers are reads, and all five take the write's boundary for
   * ADR-0013's first reason. `getNodeInfo` answers a full `docker node inspect`
   * — a manager node's address, labels, TLS status and swarm role;
   * `getAllContainerStats` answers a `docker stats` snapshot of **every
   * container on the platform host**, which is every other organization's
   * containers by name and by load, with none of the owner-label filtering
   * `DockerOpsService` applies to its own listing.
   */
  private async instanceOrServerScoped(
    ctx: PermissionCtx,
    serverId: string | null | undefined,
  ): Promise<Server | undefined> {
    await this.permissions.checkPermission(ctx, { server: ['read'] });
    if (!serverId) {
      await this.permissions.checkInstanceAuthority(ctx);
      return undefined;
    }
    return checkServerAccess(this.db, ctx, serverId);
  }

  /** `docker node ls` as parsed JSON lines. */
  async getSwarmNodes(
    ctx: PermissionCtx,
    query: ServerScopedQuery,
  ): Promise<unknown[] | undefined> {
    const scoped = await this.instanceOrServerScoped(ctx, query.serverId);
    try {
      const command = "docker node ls --format '{{json .}}'";
      const { stdout, stderr } = await execByServer(
        this.remoteExec,
        scoped?.serverId,
        command,
      );

      if (stderr) {
        this.logger.error(`Error: ${stderr}`);
        return;
      }

      return stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
    } catch (error) {
      // A worker refusing `docker node ls` and a Server nobody reached both
      // arrived here and both answered nothing, so the card that exists to say
      // *"this is the normal answer from a worker"* said it about an
      // unreachable host too (X11-4).
      rethrowIfHostUnreachable(this.logger, scoped?.serverId, error);
      this.logger.error('getSwarmNodes error:', error);
    }
  }

  /** One node's `docker node inspect` document. */
  async getNodeInfo(
    ctx: PermissionCtx,
    query: ServerScopedQuery & { nodeId: string },
  ): Promise<unknown> {
    const scoped = await this.instanceOrServerScoped(ctx, query.serverId);
    try {
      // `NodeIdParamsDto` holds `nodeId` to `containerIdRegex`, so
      // nothing shell-special reaches here; quoted anyway because
      // `builders/build-strategy.ts` asks every interpolation site to quote its
      // own words rather than rely on a guard one layer up.
      const command = `docker node inspect ${quote([query.nodeId])} --format '{{json .}}'`;
      const { stdout, stderr } = await execByServer(
        this.remoteExec,
        scoped?.serverId,
        command,
      );

      if (stderr) {
        this.logger.error(`Error: ${stderr}`);
        return;
      }

      return JSON.parse(stdout) as unknown;
    } catch (error) {
      // An unknown node answers undefined — but a host nobody reached is not an
      // unknown node (X11-4).
      rethrowIfHostUnreachable(this.logger, scoped?.serverId, error);
    }
  }

  /**
   * `docker service ls`, hiding the platform's own services — the ones
   * prefixed `cloudgate-`.
   *
   * **The predicate is {@link isPlatformContainerName}, shared with the gate.**
   * This filter was a private `startsWith('cloudgate-')` — the same
   * listing-versus-acting split already closed for containers, one surface over:
   * the platform's own swarm services were hidden here while
   * {@link getApplicationInfo} handed their tasks to anyone holding
   * `server: ['read']`. A second copy of the test is how the two came to
   * disagree, so there is one copy and both halves read it.
   *
   * Two rows move as a result, and both are intended. `cloudgate-monitoring`
   * now appears — CONTEXT.md carves it out as a thing the operator sets up and
   * manages from the console, and the acting half answers for it, so hiding it
   * was the listing disagreeing with the routes in the other direction. And a
   * service whose name merely *carries* `cloudgate` is now hidden where the
   * prefix test let it through.
   *
   * That second one is a real widening and is accepted rather than overlooked.
   * {@link isPlatformContainerName}'s own docblock confines it to a target that
   * resolves to no Service, which is what keeps a member's
   * `my-cloudgate-thing` reachable on the container routes;
   * `ContainerAccessService` does that resolution and this service has none —
   * every route here is gated on `server: ['read']` and asks the daemon rather
   * than the database. Adding a Service lookup for it would mean a second
   * resolution path for a listing nobody addresses a workload from: the console
   * reaches an Application's tasks through
   * `DockerOpsService.getServiceContainersByAppName`, which is unaffected. If
   * this surface ever grows a Service resolution, this is the call site that
   * should take the `branch === 'machine'` guard the container gate has.
   */
  async getNodeApplications(
    ctx: PermissionCtx,
    query: ServerScopedQuery,
  ): Promise<unknown[] | undefined> {
    const scoped = await this.instanceOrServerScoped(ctx, query.serverId);
    try {
      const command = "docker service ls --format '{{json .}}'";
      const { stdout, stderr } = await execByServer(
        this.remoteExec,
        scoped?.serverId,
        command,
      );

      if (stderr) {
        this.logger.error(`Error: ${stderr}`);
        return;
      }

      if (!stdout.trim()) {
        return [];
      }

      return stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { Name: string })
        .filter((service) => !isPlatformContainerName(service.Name));
    } catch (error) {
      rethrowIfHostUnreachable(this.logger, scoped?.serverId, error);
      this.logger.error('getNodeApplications error:', error);
      // `undefined` rather than the `[]` this answered until X11-4. What is
      // left after the transport failure is a docker that ran and failed —
      // `docker service ls` on a host with no Swarm is the common one — which
      // is the same fact as the `stderr` branch above, and the console already
      // renders that as *"This host cannot list Swarm services"* rather than as
      // an empty Swarm.
      return;
    }
  }

  /**
   * `docker service ps` over all names at once.
   *
   * **The acting half of {@link getNodeApplications}' filter.**
   * This route is addressed by name, and nothing refused the names the listing
   * hides — so `cloudgate-traefik` was in nobody's listing and its task states,
   * nodes and errors were readable by every caller holding `server: ['read']`,
   * which is every owner and admin of every organization on the host. The
   * container fix closed exactly this split on the container routes; the swarm listing is
   * where it survived.
   *
   * Refused rather than filtered out of the command. Dropping the name silently
   * would answer a partial listing that reads as "that service has no tasks",
   * which is a different and worse lie than a refusal; and `docker service ps`
   * takes every name in one invocation, so one refused name refuses the
   * request. Nothing an operator legitimately does to the platform's own
   * services goes through here — `/settings/traefik/*` and the runtime probes
   * are the surface, and they are gated on `requireOwnerOrAdmin`.
   *
   * {@link CONTAINER_DENIAL_MESSAGE} rather than a message of its own: it is
   * the one thing a refused container-addressed caller is told on every
   * transport, and `ContainerAccessService.resolveTarget` already answers a
   * swarm-addressed target with it. A second sentence here would tell a caller
   * which refusal they had hit.
   */
  async getApplicationInfo(
    ctx: PermissionCtx,
    query: ServerScopedQuery & { appNames: string[] },
  ): Promise<unknown[] | undefined> {
    const scoped = await this.instanceOrServerScoped(ctx, query.serverId);
    if (query.appNames.length === 0) {
      return [];
    }
    const platform = query.appNames.filter(isPlatformContainerName);
    if (platform.length > 0) {
      this.logger.warn(
        `Refused swarm service: ${platform.join(', ')} is one of this instance's own — managed through /settings/traefik and the runtime probes, not through the swarm routes`,
      );
      throw new ForbiddenException(CONTAINER_DENIAL_MESSAGE);
    }
    try {
      const command = `docker service ps ${query.appNames.join(' ')} --format '{{json .}}' --no-trunc`;
      const { stdout, stderr } = await execByServer(
        this.remoteExec,
        scoped?.serverId,
        command,
      );

      if (stderr) {
        this.logger.error(`Error: ${stderr}`);
        return;
      }

      if (!stdout.trim()) {
        return [];
      }

      return stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
    } catch (error) {
      rethrowIfHostUnreachable(this.logger, scoped?.serverId, error);
      this.logger.error('getApplicationInfo error:', error);
      // `undefined`, for {@link getNodeApplications}' reason: this route has a
      // `stderr` branch that means *docker would not say*, and answering `[]`
      // for the same fact said "that service has no tasks" instead — the lie
      // this method's own docblock refuses to tell one paragraph up.
      return;
    }
  }

  /** One `docker stats` snapshot. */
  async getAllContainerStats(
    ctx: PermissionCtx,
    query: ServerScopedQuery,
  ): Promise<unknown[]> {
    const scoped = await this.instanceOrServerScoped(ctx, query.serverId);
    try {
      const command =
        'docker stats --no-stream --format \'{"BlockIO":"{{.BlockIO}}","CPUPerc":"{{.CPUPerc}}","Container":"{{.Container}}","ID":"{{.ID}}","MemPerc":"{{.MemPerc}}","MemUsage":"{{.MemUsage}}","Name":"{{.Name}}","NetIO":"{{.NetIO}}"}\'';

      const { stdout } = await execByServer(
        this.remoteExec,
        scoped?.serverId,
        command,
      );

      if (!stdout.trim()) {
        return [];
      }

      return stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
    } catch (error) {
      // The `[]` stays for everything else: this is the one reader with no
      // `stderr` branch and a non-nullable return, so it has no *would not say*
      // state to widen into, and nothing in the console reads it (X11-4).
      rethrowIfHostUnreachable(this.logger, scoped?.serverId, error);
      this.logger.error('getAllContainerStats error:', error);
      return [];
    }
  }
}
