import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { quote } from 'shell-quote';
import { checkServerAccess } from '../common/owned-server';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { RemoteDockerFactory } from '../docker/remote-docker.factory';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import { RemoteExecService } from '../remote/remote-exec.service';
import type { Server } from '../servers/server.schema';
import { rethrowIfHostUnreachable } from './host-reachability';
import { execByServer } from './server-access';

/** A cluster operation scoped to one server (the local daemon when absent). */
interface ServerScopedQuery {
  serverId?: string | null;
}

/**
 * Multi-node cluster management: dockerode for node listing and the swarm join
 * tokens, plain docker commands for removing a node. Permissions: server:read
 * to look, server:create to mint join commands, server:delete to remove.
 *
 * Every route here is Server-scoped by a `serverId` **whose absence names the
 * platform host's own swarm** — the one this instance's console, database and
 * every organization's services run in (ADR-0008's second consequence). The
 * statements above are asked of the caller's own organization and
 * `checkServerAccess` returns for an absent id by design, so on that branch the
 * whole gate was "hold `server:create` somewhere on this instance", which an
 * owner of any second Organization holds in their own by construction. Since
 * H-63 that branch additionally takes instance authority; see
 * {@link instanceOrServerScoped}.
 */
@Injectable()
export class ClusterService {
  private readonly logger = new Logger(ClusterService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
    private readonly dockerFactory: RemoteDockerFactory,
  ) {}

  /**
   * The target a cluster route names, and the authority it takes (H-63).
   *
   * A `serverId` names a Server, a Server belongs to an organization, and an
   * organization's owner administers its own fleet: the `server` statement plus
   * `checkServerAccess`, exactly as before. **Its absence names the platform
   * host's swarm, which belongs to no organization**, so it takes instance
   * authority *as well* — the second question ADR-0010 named and ADR-0013
   * answered, asked of the branch that has no row to check.
   *
   * The statement stays in front of both branches and is not sufficient on its
   * own for the host: ADR-0013's third consequence rejects gating host-level
   * power on anything from `statements`, because a licensed custom role can be
   * granted `server:create` and would then quietly carry the platform swarm.
   * It is kept rather than replaced because it is a different question — what
   * may you do — and because these methods are reached both through the
   * controller's `@RequirePermission` and directly.
   *
   * **Reads take the same boundary as writes here, and `add-manager` is why.**
   * A *manager* join token is not a disclosure, it is an invitation: whoever
   * holds it can join a node to this swarm as a manager, which is the raft
   * quorum, every service spec and every secret in it. There is no second
   * request to gate — the read *is* the compromise. `add-worker` and `getNodes`
   * are the reconnaissance half of the same act and take the same answer
   * (ADR-0013's first consequence); `removeWorker` is the write.
   */
  private async instanceOrServerScoped(
    ctx: PermissionCtx,
    serverId: string | null | undefined,
    action: 'read' | 'create' | 'delete',
  ): Promise<Server | undefined> {
    await this.permissions.checkPermission(ctx, { server: [action] });
    if (!serverId) {
      await this.permissions.checkInstanceAuthority(ctx);
      return undefined;
    }
    return checkServerAccess(this.db, ctx, serverId);
  }

  /** The raw dockerode node listing. */
  async getNodes(
    ctx: PermissionCtx,
    query: ServerScopedQuery,
  ): Promise<unknown[]> {
    const scoped = await this.instanceOrServerScoped(
      ctx,
      query.serverId,
      'read',
    );
    const docker = await this.dockerFactory.getRemoteDocker(scoped?.serverId);
    return (await docker.listNodes()) as unknown[];
  }

  /** The swarm join command for a new worker. */
  addWorker(ctx: PermissionCtx, query: ServerScopedQuery) {
    return this.buildJoinCommand(ctx, query, 'Worker');
  }

  /** The swarm join command for a new manager. */
  addManager(ctx: PermissionCtx, query: ServerScopedQuery) {
    return this.buildJoinCommand(ctx, query, 'Manager');
  }

  /**
   * The shared body of addWorker/addManager: the swarm's join token plus the
   * address peers must dial — the swarm's advertised NodeAddr when known,
   * otherwise the target server's IP (remote) or the first private
   * interface address (local), in that order.
   */
  private async buildJoinCommand(
    ctx: PermissionCtx,
    query: ServerScopedQuery,
    role: 'Worker' | 'Manager',
  ): Promise<{ command: string; version: string }> {
    const scoped = await this.instanceOrServerScoped(
      ctx,
      query.serverId,
      'create',
    );
    const docker = await this.dockerFactory.getRemoteDocker(scoped?.serverId);
    let result: { JoinTokens: { Worker: string; Manager: string } };
    let dockerVersion: { Version: string };
    let info: { Swarm?: { NodeAddr?: string } } | null;
    try {
      result = (await docker.swarmInspect()) as typeof result;
      dockerVersion = await docker.version();
      info = (await docker.info()) as typeof info;
    } catch (error) {
      // An SSH handshake timeout answered 500 here, so the Swarm join card
      // dead-ended where every other Server read says "could not be reached".
      // What the daemon itself refused still falls through.
      rethrowIfHostUnreachable(this.logger, scoped?.serverId, error);
      throw error;
    }

    const swarmNodeAddr = info?.Swarm?.NodeAddr;
    let ip = swarmNodeAddr || (await this.getLocalServerIp());
    if (!swarmNodeAddr && scoped) {
      ip = scoped.ipAddress;
    }

    return {
      command: `docker swarm join --token ${result.JoinTokens[role]} ${ip}:2377`,
      version: dockerVersion.Version,
    };
  }

  /**
   * Drains the node, then force-removes it. Any failure is wrapped in a 500
   * (`InternalServerErrorException`).
   */
  async removeWorker(
    ctx: PermissionCtx,
    input: ServerScopedQuery & { nodeId: string },
  ): Promise<boolean> {
    const scoped = await this.instanceOrServerScoped(
      ctx,
      input.serverId,
      'delete',
    );
    try {
      // As in `swarm.service.ts`: `NodeIdParamsDto` refuses anything outside
      // `containerIdRegex`, and both words are quoted regardless, per
      // `builders/build-strategy.ts`'s per-site rule.
      const nodeId = quote([input.nodeId]);
      const drainCommand = `docker node update --availability drain ${nodeId}`;
      const removeCommand = `docker node rm ${nodeId} --force`;

      await execByServer(this.remoteExec, scoped?.serverId, drainCommand);
      await execByServer(this.remoteExec, scoped?.serverId, removeCommand);
      return true;
    } catch (error) {
      throw new InternalServerErrorException('Error removing the node', {
        cause: error,
      });
    }
  }

  /**
   * The first private interface address, with an apologetic placeholder when
   * none is found.
   */
  private async getLocalServerIp(): Promise<string> {
    try {
      // The pattern's dots are unescaped, so each matches any character.
      // Writing them as `\.` would change nothing: a template literal drops the
      // backslash of an unknown escape, so the shell gets the same bytes.
      const command = `ip addr show | grep -E "inet (192.168.|10.|172.1[6-9].|172.2[0-9].|172.3[0-1].)" | head -n1 | awk '{print $2}' | cut -d/ -f1`;
      const { stdout } = await this.remoteExec.execAsync(command);
      const ip = stdout.trim();
      return (
        ip ||
        'We were unable to obtain the local server IP, please use your private IP address'
      );
    } catch (error) {
      this.logger.error('Error to obtain local server IP', error);
      return 'We were unable to obtain the local server IP, please use your private IP address';
    }
  }
}
