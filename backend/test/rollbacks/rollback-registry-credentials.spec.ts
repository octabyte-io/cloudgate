import type Docker from 'dockerode';
import type { ApplicationsService } from '../../src/applications/applications.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { DeployableApplication } from '../../src/deployment-engine/deployment-engine.types';
import { mechanizeDockerContainer } from '../../src/deployment-engine/mechanize';
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
 * A second out-of-scope finding of the rollback-snapshot fix. A docker-sourced
 * Application keeps its registry pull credentials in three of its **own** columns —
 * `registryUrl`, `username`, `password` — and `resolveAuthConfig` reads all
 * three off the merged context, not off the `registry` relation, so the snapshot fix's
 * relation exclusions never covered this arm. `password` was excluded and came
 * off the live row; the other two were not and came off the snapshot. Rotating
 * a registry therefore paired the **current** secret with the **retired** host
 * and the **retired** username, and `mechanizeDockerContainer` hands that blob
 * to the daemon as `X-Registry-Auth` (dockerode lifts `opts.authconfig` off the
 * service-update body), which is the credential the Swarm service pulls its
 * image with.
 *
 * Nothing in `test/` observed the pairing, which is how a `password` that the snapshot fix
 * deliberately excluded ended up travelling with a stale host — so the pin is
 * the whole three-field blob at the one place all three meet, driven through
 * the real `capture` → `rollback` → `mechanize` path rather than asserted about
 * the exclusion list. Doubles are the daemon and the database, both boundaries
 * (§1.7); `mechanizeDockerContainer` stays real, which is the collaborator the snapshot fix
 * declined to `jest.mock` and the only thing that can see an `authconfig`.
 *
 * Expected values are the rotated row this test wrote, never the merge
 * recomputed (§1.7). The `Image` assertion is here for the decision rather than
 * the defect: a rollback converges onto `RollbacksService.capture`'s
 * `${appName}:v${version}` tag, which `DeploymentEngineService.captureRollback`
 * makes with a local `docker tag` and no registry serves, so the snapshot's
 * registry coordinates had no consumer to lose when they were excluded.
 *
 * **A later fix took the consumer away entirely, and this file's answer changed with
 * it.** That `Image` is a *bare* tag, which the daemon normalizes to
 * `docker.io/library/<appName>` — so shipping the live triple beside it offered
 * the operator's registry password to Docker Hub. A pinned converge now carries
 * a credential naming nobody, so the question this file used to answer about a
 * rollback ("whose credential travels?") has the answer "none". The original
 * property survives in two places: `capture` still persists no part of the
 * triple, and an *ordinary* converge of the same Application still reads all
 * three off the live row — the last test here, which is the only remaining
 * place `resolveAuthConfig`'s docker branch can be watched assembling a blob.
 */

/** The registry the Application deployed against before the rotation. */
const RETIRED = {
  registryUrl: 'registry.retired.example',
  username: 'shop-pull-2024',
  password: 'retired-secret',
};

/** The registry it was moved to — new host, new user, new secret, one save of
 * the console's docker source form. */
const ROTATED = {
  registryUrl: 'registry.acme.dev',
  username: 'shop-pull-2026',
  password: 'rotated-secret',
};

const dockerSourced = (creds: typeof RETIRED): DeployableApplication =>
  makeApp({
    sourceType: 'docker',
    github: null,
    dockerImage: `${creds.registryUrl}/shop/web:1.4`,
    ...creds,
  });

interface Written {
  values?: { fullContext?: Partial<DeployableApplication> };
}

/** `capture`'s two writes, on `rollback-context.spec.ts`' terms: the insert
 * that mints the version and the update that lands image and snapshot. */
const makeCaptureDb = (written: Written) =>
  ({
    transaction: <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        insert: () => ({
          values: () => ({
            returning: () =>
              Promise.resolve([{ rollbackId: 'rb-1', version: 7 }]),
          }),
        }),
        update: () => ({
          set: (values: Written['values']) => ({
            where: () => {
              written.values = values;
              return Promise.resolve(undefined);
            },
          }),
        }),
      }),
  }) as unknown as DrizzleDB;

/** `findOwnedRollback`'s one org-scoped select, answered with `row`. */
const makeRollbackDb = (row: unknown) => {
  const chain: Record<string, unknown> = {
    limit: () => Promise.resolve([row]),
  };
  for (const method of ['select', 'from', 'innerJoin', 'where']) {
    chain[method] = () => chain;
  }
  return chain as unknown as DrizzleDB;
};

/** The daemon: the service exists, so the converge takes the update branch a
 * rollback of a running Application always takes. */
const makeDocker = () => {
  const update = jest
    .fn<Promise<unknown>, [Record<string, unknown>]>()
    .mockResolvedValue(undefined);
  const service = {
    inspect: () =>
      Promise.resolve({
        Version: { Index: '41' },
        Spec: { TaskTemplate: { ForceUpdate: 3 } },
      }),
    update,
  };
  return {
    docker: { getService: () => service } as unknown as Docker,
    update,
  };
};

const stubs = {
  permissions: {
    checkPermission: () => Promise.resolve(),
    checkServiceAccess: () => Promise.resolve(),
  } as unknown as PermissionService,
  ctx: {
    user: { id: 'user-1' },
    session: { activeOrganizationId: 'org-1' },
  } satisfies PermissionCtx,
};

/** The snapshot `capture` persists for a docker source at `creds`. */
async function captureContext(
  creds: typeof RETIRED,
): Promise<Partial<DeployableApplication>> {
  const written: Written = {};
  const rollbacks = new RollbacksService(
    makeCaptureDb(written),
    stubs.permissions,
    {} as ApplicationsService,
    {} as RemoteDockerFactory,
    {} as RemoteExecService,
    {} as ModuleRef,
  );
  await rollbacks.capture('dep-1', dockerSourced(creds));
  const context = written.values?.fullContext;
  // A `capture` that stopped writing `fullContext` at all would satisfy every
  // `not.toHaveProperty` below.
  expect(context).toBeDefined();
  return context as Partial<DeployableApplication>;
}

/** The service-update body a rollback of `snapshot` sends the daemon while the
 * live row sits at `ROTATED`. */
async function rollbackSettings(
  snapshot: Partial<DeployableApplication>,
): Promise<Record<string, unknown>> {
  const { docker, update } = makeDocker();
  const rollbacks = new RollbacksService(
    makeRollbackDb({
      rollback: {
        rollbackId: 'rb-1',
        image: 'shop-api-x1:v7',
        fullContext: snapshot,
      },
      applicationId: 'app-1',
      serverId: null,
    }),
    stubs.permissions,
    {
      findDeployable: () => Promise.resolve(dockerSourced(ROTATED)),
    } as unknown as ApplicationsService,
    { getRemoteDocker: () => Promise.resolve(docker) } as RemoteDockerFactory,
    {} as RemoteExecService,
    {} as ModuleRef,
  );

  await rollbacks.rollback(stubs.ctx, 'rb-1');

  expect(update).toHaveBeenCalledTimes(1);
  return update.mock.calls[0][0];
}

describe('RollbacksService.capture', () => {
  it('persists neither the registry host nor the registry username of a docker source, so the live row supplies all three pull credentials', async () => {
    const context = await captureContext(RETIRED);

    expect(context).not.toHaveProperty('registryUrl');
    expect(context).not.toHaveProperty('username');
    expect(context).not.toHaveProperty('password');
    // Still a snapshot: `dockerImage` is config and not a credential, and it
    // stays — an exclusion list that grew to cover the whole docker arm would
    // pass the three assertions above.
    expect(context).toMatchObject({
      sourceType: 'docker',
      dockerImage: 'registry.retired.example/shop/web:1.4',
    });
  });
});

describe('RollbacksService.rollback', () => {
  it('authenticates the converge as nobody, because the tag it converges onto names no registry', async () => {
    // Present and empty, not absent: an update request carrying no
    // `X-Registry-Auth` leaves the credential the daemon already stored on the
    // Service in place, and that one is aimed at the same Docker Hub pull the
    // bare tag below resolves to.
    const settings = await rollbackSettings(await captureContext(RETIRED));

    expect(settings.authconfig).toEqual({
      username: '',
      password: '',
      serveraddress: '',
    });
  });

  it('converges onto the locally preserved rollback tag, which is why the snapshot needs no registry coordinates', async () => {
    const settings = (await rollbackSettings(
      await captureContext(RETIRED),
    )) as unknown as {
      TaskTemplate: { ContainerSpec: { Image: string } };
    };

    expect(settings.TaskTemplate.ContainerSpec.Image).toBe('shop-api-x1:v7');
  });

  it('sends no part of either registry to the daemon — not the retired one it deployed against, not the live one it was rotated to', async () => {
    // The credential blob is what the daemon persists on the Swarm service and
    // offers on every later task pull, so the retired host must not reach it
    // even beside a correct username — and neither must the live secret,
    // because the pull that blob authenticates is aimed at Docker Hub.
    const settings = await rollbackSettings(await captureContext(RETIRED));
    const body = JSON.stringify(settings);

    for (const part of [...Object.values(RETIRED), ...Object.values(ROTATED)]) {
      expect(body).not.toContain(part);
    }
  });

  /**
   * The guard on that fix's scope, and the last place the original property can be
   * watched. `resolveAuthConfig` still reads `registryUrl`, `username` and
   * `password` off the row for a converge that is *not* pinned — the ordinary
   * Deployment of a docker-sourced Application, whose `Image` really is the
   * private-registry ref and really does need them. A fix that reached further
   * than the pinned path would break every private-registry deploy on the
   * install, and nothing else in `test/rollbacks` would notice.
   */
  it('leaves an ordinary converge of the same Application authenticating as the live registry credentials', async () => {
    const { docker, update } = makeDocker();

    await mechanizeDockerContainer(dockerSourced(ROTATED), docker);

    const settings = update.mock.calls[0][0];
    expect(settings.authconfig).toEqual({
      username: ROTATED.username,
      password: ROTATED.password,
      serveraddress: ROTATED.registryUrl,
    });
  });
});
