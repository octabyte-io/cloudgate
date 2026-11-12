import { ServiceUnavailableException } from '@nestjs/common';
import type Docker from 'dockerode';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { ClusterService } from '../../src/docker-ops/cluster.service';
import {
  HOST_UNREACHABLE_CODE,
  PLATFORM_HOST_UNREACHABLE_CODE,
} from '../../src/docker-ops/host-reachability';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';

/**
 * The Swarm join commands go through dockerode, not `RemoteExecService`, so an
 * SSH handshake timeout reached the caller as `ssh2`'s own error and answered
 * 500. It now takes the same 503 `HOST_UNREACHABLE` every other Server
 * read does, which the console already renders.
 *
 * The fixtures are the shapes `docker-modem` hands back unchanged: `ssh2`'s
 * error carries a `level`, a socket error a `code`, and an answer from the
 * daemon a `statusCode` — the one that means the request arrived.
 */

const SERVER_ID = 'srv-unreachable';

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

const handshakeTimeout = () =>
  Object.assign(new Error('Timed out while waiting for handshake'), {
    level: 'client-timeout',
  });

const socketRefused = () =>
  Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), {
    code: 'ECONNREFUSED',
  });

const notAManager = () =>
  Object.assign(
    new Error('(HTTP code 503) unexpected - This node is not a swarm manager.'),
    { statusCode: 503, reason: 'unexpected' },
  );

const makeDb = () => {
  const chain = {
    where: () => ({
      limit: () =>
        Promise.resolve([{ serverId: SERVER_ID, ipAddress: '10.0.0.9' }]),
    }),
  };
  return { select: () => ({ from: () => chain }) } as unknown as DrizzleDB;
};

const makeCluster = (swarmInspect: () => Promise<unknown>) => {
  const docker = {
    swarmInspect,
    version: () => Promise.resolve({ Version: '27.0.0' }),
    info: () => Promise.resolve({ Swarm: { NodeAddr: '10.0.0.9' } }),
  } as unknown as Docker;
  return new ClusterService(
    makeDb(),
    {
      checkPermission: jest.fn().mockResolvedValue(undefined),
      checkInstanceAuthority: jest.fn().mockResolvedValue(undefined),
    } as unknown as PermissionService,
    {} as RemoteExecService,
    {
      getRemoteDocker: () => Promise.resolve(docker),
    } as unknown as RemoteDockerFactory,
  );
};

async function refusalOf(call: Promise<unknown>) {
  const error: unknown = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  return error;
}

describe('ClusterService join commands', () => {
  it.each(['addWorker', 'addManager'] as const)(
    '%s answers 503 HOST_UNREACHABLE when the SSH handshake times out',
    async (method) => {
      const cluster = makeCluster(() => Promise.reject(handshakeTimeout()));
      const error = await refusalOf(
        cluster[method](ctx, { serverId: SERVER_ID }),
      );

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(
        (error as ServiceUnavailableException).getResponse(),
      ).toMatchObject({
        code: HOST_UNREACHABLE_CODE,
      });
    },
  );

  it('names the platform host when no serverId was given', async () => {
    const cluster = makeCluster(() => Promise.reject(socketRefused()));
    const error = await refusalOf(cluster.addWorker(ctx, {}));

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: PLATFORM_HOST_UNREACHABLE_CODE,
    });
  });

  it('lets an answer from the daemon through untouched, since the host was reached', async () => {
    const refusal = notAManager();
    const cluster = makeCluster(() => Promise.reject(refusal));
    const error = await refusalOf(
      cluster.addWorker(ctx, { serverId: SERVER_ID }),
    );

    // Not a claim that the Server was unreachable: it answered.
    expect(error).toBe(refusal);
  });

  it('still builds the command for a reachable Swarm', async () => {
    const cluster = makeCluster(() =>
      Promise.resolve({
        JoinTokens: { Worker: 'SWMTKN-w', Manager: 'SWMTKN-m' },
      }),
    );
    await expect(
      cluster.addManager(ctx, { serverId: SERVER_ID }),
    ).resolves.toEqual({
      command: 'docker swarm join --token SWMTKN-m 10.0.0.9:2377',
      version: '27.0.0',
    });
  });
});
