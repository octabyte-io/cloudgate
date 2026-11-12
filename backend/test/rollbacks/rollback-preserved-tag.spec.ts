import type Docker from 'dockerode';
import type { ApplicationsService } from '../../src/applications/applications.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { server } from '../../src/servers/server.schema';
import type { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import type { ModuleRef } from '@nestjs/core';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { RollbacksService } from '../../src/rollbacks/rollbacks.service';
import { makeApp } from '../deployment-engine/application.fixture';

/**
 * A second out-of-scope finding of the rollback work, at the reading end.
 * `DeploymentEngineService.captureRollback` preserves a released image with a
 * `docker tag … ${appName}:v${version}` on the Server that **built** it, and
 * `RollbacksService.rollback` converges onto that tag through a Docker handle
 * taken from `fresh.serverId`. When those two are different Servers the tag is
 * on neither the right machine nor any registry — the rollback work pinned that nothing
 * pushes it — so the converge is accepted and the Service's tasks then fail
 * pulling `docker.io/library/${appName}`, a *bare* tag being Docker Hub. The
 * operator saw a 204.
 *
 * The capture is refused, which stops new rows; this covers the rows already
 * in the column, which no write revisits — the same shape as the snapshot fix's residual.
 * The condition is read out of the **snapshot**, not off the live row, and that
 * is what makes it exact rather than a heuristic: `buildServerId` and
 * `serverId` are two of the few columns `EXCLUDED_FROM_CONTEXT` deliberately
 * keeps, so a snapshot records where its own tag was made. A single-Server
 * install that *later* gains a build Server keeps every snapshot it already
 * took, and an Application moved to another Server loses them — both of which
 * the live row alone would get backwards.
 *
 * Doubles are the daemon and the database, both boundaries (§1.7);
 * `mechanizeDockerContainer` stays real, so "no converge happened" is observed
 * at the daemon rather than asserted about a guard.
 */

/**
 * `findOwnedRollback`'s one org-scoped select, answered with `row`, and the
 * maintenance read of its Server, answered with none in maintenance.
 */
const makeRollbackDb = (row: unknown) => {
  const chain: Record<string, unknown> = {
    limit: () => Promise.resolve([row]),
  };
  const noServer: Record<string, unknown> = {
    limit: () => Promise.resolve([]),
  };
  for (const method of ['innerJoin', 'where']) {
    chain[method] = () => chain;
    noServer[method] = () => noServer;
  }
  chain.from = (table: unknown) => (table === server ? noServer : chain);
  chain.select = () => chain;
  return chain as unknown as DrizzleDB;
};

/** The daemon: the Service exists, so a converge that gets this far updates. */
const makeDocker = () => {
  const update = jest
    .fn<Promise<unknown>, [Record<string, unknown>]>()
    .mockResolvedValue(undefined);
  const getService = jest.fn(() => ({
    inspect: () =>
      Promise.resolve({
        Version: { Index: '41' },
        Spec: { TaskTemplate: { ForceUpdate: 3 } },
      }),
    update,
  }));
  return { docker: { getService } as unknown as Docker, getService, update };
};

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

const permissions = {
  checkPermission: () => Promise.resolve(),
  checkServiceAccess: () => Promise.resolve(),
} as unknown as PermissionService;

/**
 * A rollback of a snapshot captured on `snapshot`'s Server pair while the live
 * row sits on `live`'s.
 */
function rollbackOf(
  snapshot: { serverId: string | null; buildServerId: string | null },
  live: { serverId: string | null; buildServerId: string | null },
) {
  const { docker, getService, update } = makeDocker();
  const rollbacks = new RollbacksService(
    makeRollbackDb({
      rollback: {
        rollbackId: 'rb-1',
        image: 'shop-api-x1:v7',
        fullContext: makeApp(snapshot) as unknown as Partial<
          Record<string, unknown>
        >,
      },
      applicationId: 'app-1',
      serverId: live.serverId,
    }),
    permissions,
    {
      findDeployable: () => Promise.resolve(makeApp(live)),
    } as unknown as ApplicationsService,
    { getRemoteDocker: () => Promise.resolve(docker) } as RemoteDockerFactory,
    {} as RemoteExecService,
    {} as ModuleRef,
  );
  return { run: () => rollbacks.rollback(ctx, 'rb-1'), getService, update };
}

describe('RollbacksService.rollback', () => {
  it('refuses a snapshot whose image was preserved on a build server, rather than converging onto a tag that server cannot serve', async () => {
    const { run, getService, update } = rollbackOf(
      { serverId: 'srv-run', buildServerId: 'srv-build' },
      { serverId: 'srv-run', buildServerId: 'srv-build' },
    );

    await expect(run()).rejects.toThrow(/preserved/i);
    // Refused before the daemon was touched: a converge onto an unpullable tag
    // replaces the spec of a Service that is currently up.
    expect(getService).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a snapshot captured before the Application was moved to another server', async () => {
    const { run, update } = rollbackOf(
      { serverId: 'srv-old', buildServerId: null },
      { serverId: 'srv-new', buildServerId: null },
    );

    await expect(run()).rejects.toThrow(/preserved/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('restores a snapshot captured on the server that now runs the service', async () => {
    const { run, update } = rollbackOf(
      { serverId: 'srv-run', buildServerId: null },
      { serverId: 'srv-run', buildServerId: null },
    );

    await run();

    const settings = update.mock.calls[0][0] as {
      TaskTemplate: { ContainerSpec: { Image: string } };
    };
    expect(settings.TaskTemplate.ContainerSpec.Image).toBe('shop-api-x1:v7');
  });

  it('restores a snapshot taken before a build server was configured, because the tag is still where it was made', async () => {
    // The live row alone would refuse this one, and it is the case that says
    // why the pair is read off the snapshot: nothing moved the image.
    const { run, update } = rollbackOf(
      { serverId: 'srv-run', buildServerId: null },
      { serverId: 'srv-run', buildServerId: 'srv-build' },
    );

    await run();

    expect(update).toHaveBeenCalledTimes(1);
  });
});
