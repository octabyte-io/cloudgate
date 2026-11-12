import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  APPLICATION_CREDENTIAL_REFS,
  ApplicationsService,
} from '../../src/applications/applications.service';
import { server as serverTable } from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { rollback } from '../../src/rollbacks/rollback.schema';
import { RollbacksService } from '../../src/rollbacks/rollbacks.service';
import {
  NODE_GPU_RESOURCES_COMMAND,
  RUNNING_TASK_GPUS_COMMAND,
} from '../../src/settings/gpu-counts';
import {
  nvidiaRuntimeAnswer,
  RUNTIME_TOML,
} from '../settings/gpu-runtime.fixture';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/** Invites a user into the owner's organization and accepts as them. */
async function inviteUser(
  server: App,
  ownerCookie: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ cookie: string; id: string }> {
  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', ownerCookie)
    .send({ email, role });
  const inviteId = (invite.body as { id: string }).id;

  const su = await request(server)
    .post('/api/auth/sign-up/email')
    .set('x-cloudgate-token', inviteId)
    .send({ name: 'Ida Rhodes', email, password: 'super-secret-password' });
  const cookie = su.headers['set-cookie'];
  const id = (su.body as { user: { id: string } }).user.id;

  const accept = await request(server)
    .post(`/organizations/invitations/${inviteId}/accept`)
    .set('Cookie', cookie);
  expect(accept.status).toBe(201);

  return { cookie, id };
}

describe('Rollbacks (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let deployments: DeploymentsService;
  let rollbacks: RollbacksService;
  let engine: DeploymentEngineService;

  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });

  /** A Swarm with no existing service: inspect rejects, so the engine (and a
   * rollback) converge by creating the service. */
  const dockerService = {
    inspect: jest.fn(),
    update: jest.fn(),
  };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };

  /** A release is now followed by a convergence poll that counts the
   * Service's running tasks. Three already running satisfies every replica
   * count these tests deploy, so the poll answers on its first read and
   * nothing here waits out a budget. */
  const convergedTasks = [1, 2, 3].map((n) => ({
    Status: { State: 'running', Timestamp: `2026-08-24T00:00:0${n}Z` },
  }));
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };

  const queueMock = {
    add: jest.fn(),
    getJobs: jest.fn(),
    cancel: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    deployments = ctx.app.get(DeploymentsService);
    rollbacks = ctx.app.get(RollbacksService);
    engine = ctx.app.get(DeploymentEngineService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.getService.mockClear();
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.listTasks.mockReset().mockResolvedValue(convergedTasks);
    dockerFactoryMock.getRemoteDocker.mockClear();
    queueMock.add.mockReset().mockResolvedValue({ id: 'job-1' });
    queueMock.getJobs.mockReset().mockResolvedValue([]);
    queueMock.cancel.mockReset().mockResolvedValue(false);
  });

  /** An owner ctx plus a docker-sourced application: nothing to build, so the
   * engine deploys it end-to-end against the mocked exec/docker layer. */
  async function setUpApplication() {
    const ownerSession = await signUp(server, owner);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const created = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'web-app',
      environmentId: environment.environmentId,
    });
    const application = await applications.update(
      ownerCtx,
      created.applicationId,
      { sourceType: 'docker', dockerImage: 'registry.example.com/acme/web:1' },
    );
    return { organizationId, ownerSession, ownerCtx, application };
  }

  /** Deploys through the real engine, as the queue processor would. */
  async function deploy(applicationId: string) {
    const deployable = await applications.findDeployable(applicationId);
    await engine.deploy(deployable);
  }

  /**
   * The snapshot fix's first residual: rows already in `rollback.full_context` still carry
   * what an older `capture` wrote, and no write revisits them. Both reads are
   * therefore stripped as well, so this is fixed for the rows already there
   * and not only for the next capture.
   *
   * The legacy shape is written straight into the column rather than produced
   * by the code under test — a snapshot the current `capture` cannot make is
   * exactly what has to be tested here, and `githubId` on an Application's own
   * row was reachable through `PATCH /applications/:id` until the fix.
   *
   * At suite scope rather than inside the describe that introduced it:
   * the Server pair is written the same way and for the same reason. The capture
   * refuses to *capture* a snapshot whose image would land on a build Server,
   * so a row naming one is again a row the current code cannot make and every
   * install that had a build Server before the fix already has.
   */
  async function poisonSnapshot(rollbackId: string, extra: object) {
    const [row] = await ctx.db
      .select({ fullContext: rollback.fullContext })
      .from(rollback)
      .where(eq(rollback.rollbackId, rollbackId));
    await ctx.db
      .update(rollback)
      .set({ fullContext: { ...row.fullContext, ...extra } as never })
      .where(eq(rollback.rollbackId, rollbackId));
  }

  describe('capture on successful deploy', () => {
    it('a deploy with rollback capture disabled (the default) records no snapshot', async () => {
      const { ownerCtx, application } = await setUpApplication();

      await deploy(application.applicationId);

      // The deploy itself succeeded…
      const [deployment] = await deployments.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(deployment.status).toBe('done');
      // …but nothing was captured.
      const rows = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toEqual([]);
    });

    it('a successful deploy with capture enabled snapshots the released image and its config', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
      });

      await deploy(application.applicationId);

      const [deployment] = await deployments.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      const rows = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        deploymentId: deployment.deploymentId,
        image: 'web-app:v1',
      });
      expect(rows[0].createdAt).toEqual(expect.any(String));

      // The released image is preserved under the version tag on the server,
      // so later deploys can't overwrite what the snapshot points at.
      const commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      // `\:` is `shell-quote`'s wording of a `:` — both tags are `quote()`d
      // since H-34, because the left-hand one is the unconstrained
      // `dockerImage` column for a docker-sourced Application.
      expect(
        commands.some((command) =>
          command.includes(
            'docker tag registry.example.com/acme/web\\:1 web-app\\:v1',
          ),
        ),
      ).toBe(true);

      // The config snapshot carries what a redeploy needs — but no secrets:
      // env and credentials stay in encrypted columns, not JSON.
      expect(rows[0].fullContext).toMatchObject({ appName: 'web-app' });
      expect(rows[0].fullContext).not.toHaveProperty('env');
      expect(rows[0].fullContext).not.toHaveProperty('password');
      // …and no credential id either. Through Postgres and the real
      // `capture`, so this covers the column as it is actually written and not
      // just the projection: the ids are `null` on this Application, which is
      // the point — the *key* is what a rollback's `{ ...fresh, ...snapshot }`
      // merge would have overridden the live row with.
      for (const ref of APPLICATION_CREDENTIAL_REFS) {
        expect(rows[0].fullContext).not.toHaveProperty(ref);
      }
      expect(rows[0].fullContext).not.toHaveProperty('previewEnv');
      expect(rows[0].fullContext).not.toHaveProperty('previewBuildArgs');
    });

    it('a failed deploy captures nothing even with capture enabled', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
      });
      execMock.execAsync.mockRejectedValue(new Error('pull failed'));

      await expect(deploy(application.applicationId)).rejects.toThrow(
        'pull failed',
      );

      const rows = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toEqual([]);
    });

    it('a deploy that builds on a dedicated build server captures nothing, because the preserved tag would be on the wrong server', async () => {
      // A second out-of-scope finding of the rollback work. Through Postgres and a real
      // `server` row, which is what makes this the two-Server *configuration*
      // rather than an argument about a column: `captureRollback` preserves the
      // image with a `docker tag` on the Server that built, and
      // `RollbacksService.rollback` converges through a handle taken from the
      // Application's own `serverId`. Nothing carries a local tag between them
      // — `uploadImageCommands` pushes `getRegistryTag`, a different name, and
      // only with a Registry linked — so the snapshot was offered in the
      // console and failed at the one moment it was wanted. Two Docker daemons
      // is the half no e2e in this tree can build; what it would add is the
      // task's pull failing, which is moby's behaviour and not this repo's.
      const { organizationId, ownerCtx, application } =
        await setUpApplication();
      const [builder] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'builder-eu',
          ipAddress: '203.0.113.7',
          port: 22,
          organizationId,
        })
        .returning();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
        buildServerId: builder.serverId,
      });

      await deploy(application.applicationId);

      // The Deployment still succeeded — capture is not worth failing a deploy
      // over — and left no snapshot to fail with later.
      const [deployment] = await deployments.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(deployment.status).toBe('done');
      const rows = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toEqual([]);
      // And no tag was made either: a preserved image with no row pointing at
      // it is disk the console can never reclaim.
      const commands = execMock.execAsyncRemote.mock.calls.map(
        ([, command]: [string, string]) => command,
      );
      expect(commands.some((command) => command.includes('docker tag'))).toBe(
        false,
      );
    });
  });

  describe('rollback action', () => {
    it('rolling back converges the service onto the recorded image and config', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
      });
      await deploy(application.applicationId);
      const [snapshot] = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );

      // A newer release has since shipped a different image and scaled up.
      await applications.update(ownerCtx, application.applicationId, {
        dockerImage: 'registry.example.com/acme/web:2',
        replicas: 3,
      });
      await deploy(application.applicationId);
      docker.createService.mockClear();

      await rollbacks.rollback(ownerCtx, snapshot.rollbackId);

      expect(docker.createService).toHaveBeenCalledTimes(1);
      // Two arguments on every pinned converge: dockerode sends the
      // first as `X-Registry-Auth`, and a rollback's is a credential naming
      // nobody, because the tag in `Image` names no registry.
      const [, settings] = docker.createService.mock.lastCall as [
        object,
        {
          Name: string;
          Mode: { Replicated: { Replicas: number } };
          TaskTemplate: { ContainerSpec: { Image: string } };
        },
      ];
      expect(settings.Name).toBe('web-app');
      // The prior image, not what the application currently points at…
      expect(settings.TaskTemplate.ContainerSpec.Image).toBe('web-app:v1');
      // …and the config as it was when the snapshot was captured.
      expect(settings.Mode).toEqual({ Replicated: { Replicas: 1 } });
    });

    it('rolling back after a registry rotation authenticates as neither registry, so no private credential is offered against the rollback tag', async () => {
      // A second out-of-scope finding of the snapshot fix. `resolveAuthConfig`'s docker
      // branch reads `registryUrl`, `username` and `password` off the merged
      // context — the Application's own columns, not the `registry` relation,
      // which is why the snapshot fix's relation exclusions never reached this arm — and
      // only `password` was excluded, so the snapshot's retired host and user
      // won the merge and travelled with the live secret. Through Postgres and
      // the real `encryptedText` round-trip, so the secrets below are ones that
      // were decrypted off a row rather than read back out of JSON.
      //
      // A later fix then took the consumer away: the `Image` a rollback converges onto
      // is `web-app:v1`, a bare tag the daemon reads as
      // `docker.io/library/web-app`, so the live triple this test used to
      // expect was the operator's private-registry password aimed at Docker
      // Hub. What the converge carries now is a credential naming nobody —
      // present rather than absent, because an update with no
      // `X-Registry-Auth` leaves the one the daemon already stored in place.
      const { ownerCtx, application } = await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
        registryUrl: 'registry.retired.example',
        username: 'shop-pull-2024',
        password: 'retired-secret',
      });
      await deploy(application.applicationId);
      const [snapshot] = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      // The snapshot holds no part of the credential, so no part of it can win
      // the merge — the same shape as the credential ids above.
      expect(snapshot.fullContext).not.toHaveProperty('registryUrl');
      expect(snapshot.fullContext).not.toHaveProperty('username');
      expect(snapshot.fullContext).not.toHaveProperty('password');

      // The registry is rotated — new host, new user, new secret, which is one
      // save of the console's docker source form.
      await applications.update(ownerCtx, application.applicationId, {
        registryUrl: 'registry.acme.dev',
        username: 'shop-pull-2026',
        password: 'rotated-secret',
      });
      docker.createService.mockClear();

      await rollbacks.rollback(ownerCtx, snapshot.rollbackId);

      // The first argument is what dockerode sends as `X-Registry-Auth`, which
      // is the credential the Swarm service pulls its image with.
      const [auth] = docker.createService.mock.lastCall as [
        { username: string; password: string; serveraddress: string },
      ];
      expect(auth).toEqual({
        username: '',
        password: '',
        serveraddress: '',
      });
      // Neither registry, in any field of the whole converge: the retired host
      // and user kept out of the snapshot, and the live secret kept
      // off the pinned path.
      const body = JSON.stringify(docker.createService.mock.lastCall);
      for (const part of [
        'registry.retired.example',
        'shop-pull-2024',
        'retired-secret',
        'registry.acme.dev',
        'shop-pull-2026',
        'rotated-secret',
      ]) {
        expect(body).not.toContain(part);
      }
    });
  });

  describe('snapshots captured before the exclusion list covered them', () => {
    it('serves a snapshot that stored a credential id without it', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
      });
      await deploy(application.applicationId);
      const [captured] = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      await poisonSnapshot(captured.rollbackId, {
        githubId: 'another-orgs-github-connection',
        env: 'STRIPE_KEY=sk_live_1',
      });

      const [served] = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );

      expect(served.fullContext).not.toHaveProperty('githubId');
      expect(served.fullContext).not.toHaveProperty('env');
      // The snapshot is still a snapshot — only the excluded keys went.
      expect(served.fullContext).toMatchObject({ appName: 'web-app' });
    });

    it('rolls back onto the live row’s environment, not a stored one', async () => {
      // `env` is the one excluded column `mechanize` reads, so it is the only
      // one whose provenance a converge can actually be asked about — and the
      // answer covers the credential ids beside it, which the same strip
      // removes on the same read.
      const { ownerCtx, application } = await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
      });
      await deploy(application.applicationId);
      const [captured] = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      await poisonSnapshot(captured.rollbackId, { env: 'TOKEN=stale' });
      await applications.saveEnvironment(ownerCtx, application.applicationId, {
        env: 'TOKEN=current',
      });
      docker.createService.mockClear();

      await rollbacks.rollback(ownerCtx, captured.rollbackId);

      // The pinned converge's blank credential is the first argument.
      const [, settings] = docker.createService.mock.lastCall as [
        object,
        { TaskTemplate: { ContainerSpec: { Env: string[] } } },
      ];
      expect(settings.TaskTemplate.ContainerSpec.Env).toContain(
        'TOKEN=current',
      );
      expect(settings.TaskTemplate.ContainerSpec.Env).not.toContain(
        'TOKEN=stale',
      );
    });

    it('refuses a snapshot whose image was preserved on a build server instead of converging onto a tag it cannot reach', async () => {
      // The other half. The capture side now refuses to write such a row,
      // which is exactly why this one is written straight into the column: it
      // is the shape every install that had a build server before the fix already
      // has, and no write revisits a `full_context` (the snapshot fix's residual).
      const { ownerCtx, application } = await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
      });
      await deploy(application.applicationId);
      const [captured] = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      await poisonSnapshot(captured.rollbackId, { buildServerId: 'srv-build' });
      docker.createService.mockClear();

      // 409 and not 404: the row is there and it is the caller's Application —
      // what is wrong is the Server its image sits on.
      await expect(
        rollbacks.rollback(ownerCtx, captured.rollbackId),
      ).rejects.toBeInstanceOf(ConflictException);
      // Refused before the daemon was touched: the converge would have
      // replaced the spec of a Service that is currently up.
      expect(docker.createService).not.toHaveBeenCalled();
      expect(dockerService.update).not.toHaveBeenCalled();
    });
  });

  /**
   * From the GPU change's review: a Rollback point keeps its `gpus`, and
   * restoring it starts a task as a deploy does, so it is admitted as a deploy is
   * (ADR-0039) — before anything is released, in the deploy's words, as a 409.
   */
  describe('a point with a GPU reservation', () => {
    const card = '{"NamedResourceSpec":{"Kind":"GPU","Value":"GPU-a"}}';
    /** The platform host with one card by ID; `held` its running tasks' lines. */
    const gpuHost = (held: string[], toml: string = RUNTIME_TOML.configured) =>
      execMock.execAsync.mockImplementation(
        (command: string) =>
          nvidiaRuntimeAnswer(command, toml) ??
          Promise.resolve({
            stdout:
              command === NODE_GPU_RESOURCES_COMMAND
                ? `[${card}]`
                : command === RUNNING_TASK_GPUS_COMMAND
                  ? held.join('\n')
                  : '',
            stderr: '',
          }),
      );

    /** A point taken with no GPUs, then given one, as a GPU release's is. */
    async function gpuPoint() {
      const { ownerCtx, application } = await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
      });
      await deploy(application.applicationId);
      const [point] = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      await poisonSnapshot(point.rollbackId, { gpus: 1 });
      docker.createService.mockClear();
      return { ownerCtx, rollbackId: point.rollbackId };
    }

    async function refusalOf(run: Promise<unknown>) {
      const error = await run.then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ConflictException);
      return (error as ConflictException).message;
    }

    it('refuses a point on a host whose runtime cannot hand the task its card, releasing nothing', async () => {
      const { ownerCtx, rollbackId } = await gpuPoint();
      gpuHost([], RUNTIME_TOML.theOldWay);

      expect(await refusalOf(rollbacks.rollback(ownerCtx, rollbackId))).toBe(
        'The platform host is not set up to hand a reserved card to its container; run GPU setup on it again',
      );
      expect(docker.createService).not.toHaveBeenCalled();
      expect(dockerService.update).not.toHaveBeenCalled();
    });

    it('refuses a point whose card another Service holds, releasing nothing', async () => {
      const { ownerCtx, rollbackId } = await gpuPoint();
      gpuHost([`svc-other [${card}]`]);

      expect(await refusalOf(rollbacks.rollback(ownerCtx, rollbackId))).toBe(
        '1 GPU needed, 0 of 1 free on the platform host',
      );
      expect(docker.createService).not.toHaveBeenCalled();
      expect(dockerService.update).not.toHaveBeenCalled();
    });

    it('restores a point whose card the Service’s own running task holds', async () => {
      const { ownerCtx, rollbackId } = await gpuPoint();
      dockerService.inspect.mockResolvedValue({
        ID: 'svc-own',
        Version: { Index: 7 },
        Spec: { TaskTemplate: { ForceUpdate: 0 } },
      });
      gpuHost([`svc-own [${card}]`]);

      await rollbacks.rollback(ownerCtx, rollbackId);

      expect(dockerService.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('history', () => {
    it('lists an application’s snapshots newest-first', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
      });

      await deploy(application.applicationId);
      await deploy(application.applicationId);

      const rows = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows.map((row) => row.image)).toEqual([
        'web-app:v2',
        'web-app:v1',
      ]);
    });

    it('removing a snapshot deletes its row and the preserved image', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
      });
      await deploy(application.applicationId);
      const [snapshot] = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );

      await rollbacks.remove(ownerCtx, snapshot.rollbackId);

      const rows = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toEqual([]);
      const commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      // `web-app\:v1`: the image tag is an argv word and
      // `shell-quote` escapes its `:`, which the shell strips before `docker`
      // sees it. Asserted as emitted because the whole command is four words.
      expect(
        commands.some((command) =>
          command.includes('docker image rm web-app\\:v1 --force'),
        ),
      ).toBe(true);
    });
  });

  describe('removing a snapshot captured on another server', () => {
    /**
     * The first out-of-scope finding of the capture refusal. `remove` ran its
     * `docker image rm` through the Application's own `serverId` — the **run**
     * Server — while `DeploymentEngineService.captureRollback` makes the tag on
     * the Server that *built* the Deployment. So on a build-Server install the
     * removal failed for an image that machine never had, and a failed removal
     * deliberately keeps the row: paired with the capture refusal's 409, which refuses to
     * restore exactly those snapshots, the row could be neither rolled back nor
     * deleted. One unreclaimable image per Deployment, on the host chosen
     * precisely because builds fill disks.
     *
     * The Server pair is written straight into `full_context` for the reason
     * {@link poisonSnapshot} gives: the capture refuses to capture such a row, so this
     * is the shape an install that had a build Server before the fix already has,
     * and nothing revisits a `full_context`.
     */
    async function setUpSnapshotOnBuilder() {
      const { organizationId, ownerSession, ownerCtx, application } =
        await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
      });
      await deploy(application.applicationId);
      const [snapshot] = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      const [builder] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'builder-eu',
          ipAddress: '203.0.113.7',
          port: 22,
          organizationId,
        })
        .returning();
      await poisonSnapshot(snapshot.rollbackId, {
        buildServerId: builder.serverId,
      });
      return {
        organizationId,
        ownerSession,
        ownerCtx,
        application,
        snapshot,
        builder,
      };
    }

    /** Which machines were asked to delete an image, and with what. */
    function imageRemovals() {
      return {
        // The Application here has no Server, so the platform host is the
        // machine the old `owned.serverId` reading would have addressed.
        platformHost: (execMock.execAsync.mock.calls as [string][])
          .map(([command]) => command)
          .filter((command) => command.includes('docker image rm')),
        servers: (execMock.execAsyncRemote.mock.calls as [string, string][])
          .filter(([, command]) => command.includes('docker image rm'))
          .map(([serverId, command]) => ({ serverId, command })),
      };
    }

    const remaining = (ownerCtx: PermissionCtx, applicationId: string) =>
      rollbacks.findAllByApplicationId(ownerCtx, applicationId);

    it('removes the preserved image from the server that built the deployment, not the one the service runs on', async () => {
      const { ownerCtx, application, snapshot, builder } =
        await setUpSnapshotOnBuilder();

      await rollbacks.remove(ownerCtx, snapshot.rollbackId);

      const { platformHost, servers } = imageRemovals();
      // `web-app\:v1`: the tag is an argv word and `shell-quote`
      // escapes its `:`, which the shell strips before `docker` sees it.
      expect(servers).toHaveLength(1);
      expect(servers[0].serverId).toBe(builder.serverId);
      expect(servers[0].command).toContain(
        'docker image rm web-app\\:v1 --force',
      );
      // Nothing was asked of the machine the service runs on, where the tag
      // has never been — that request is the one that used to fail.
      expect(platformHost).toEqual([]);
      expect(await remaining(ownerCtx, application.applicationId)).toEqual([]);
    });

    it('deletes a snapshot whose build server has since been removed from the fleet', async () => {
      const { ownerCtx, application, snapshot, builder } =
        await setUpSnapshotOnBuilder();
      // `application.build_server_id` is `onDelete: 'set null'` while
      // `server_id` is `onDelete: 'cascade'`, and `ServersService.remove`
      // refuses a Server any Application names — which it does not
      // do for a build Server, deliberately. So retiring a build Server is the
      // one thing that leaves a snapshot naming a `server` row that is gone.
      // Not because a run Server's retirement takes the Application with it,
      // which is what this comment used to say and what a later fix corrected: that
      // cascade is unreachable through the HTTP surface. What destroys these
      // rows is the delete of the Application, and
      // `preserved-image-reclamation.e2e-spec.ts` is that path.
      await ctx.db
        .delete(serverTable)
        .where(eq(serverTable.serverId, builder.serverId));

      await rollbacks.remove(ownerCtx, snapshot.rollbackId);

      expect(await remaining(ownerCtx, application.applicationId)).toEqual([]);
      // And no machine was addressed on the way: there is no row to read an
      // SSH key out of, so the image is not this instance's to reclaim.
      const { platformHost, servers } = imageRemovals();
      expect(servers).toEqual([]);
      expect(platformHost).toEqual([]);
    });

    it('deletes a snapshot naming a server in another organization without touching that machine', async () => {
      const { ownerSession, ownerCtx, application, snapshot } =
        await setUpSnapshotOnBuilder();
      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const [foreign] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'someone-elses-builder',
          ipAddress: '198.51.100.9',
          port: 22,
          organizationId: (secondOrg.body as { id: string }).id,
        })
        .returning();
      // `full_context` is a `json` column no foreign key constrains, and the snapshot fix
      // is the proof that ids in it can name another organization's rows.
      await poisonSnapshot(snapshot.rollbackId, {
        buildServerId: foreign.serverId,
      });

      await rollbacks.remove(ownerCtx, snapshot.rollbackId);

      expect(await remaining(ownerCtx, application.applicationId)).toEqual([]);
      const { platformHost, servers } = imageRemovals();
      expect(servers).toEqual([]);
      // Nor was the request quietly re-aimed at the machine this organization
      // does own, which would delete an image the snapshot never named.
      expect(platformHost).toEqual([]);
    });

    it('refuses to delete a snapshot whose preserved image could not be removed, and keeps the row', async () => {
      const { ownerCtx, application, snapshot } =
        await setUpSnapshotOnBuilder();
      execMock.execAsyncRemote.mockRejectedValue(
        new ExecError('Remote command failed with exit code 1', {
          command: 'docker image rm web-app:v1 --force',
          stderr: 'Error response from daemon: conflict: unable to delete',
          exitCode: 1,
        }),
      );

      // 409 and not the ExecError's 500: the row is there and it is the
      // caller's — what is wrong is the state of the machine.
      await expect(
        rollbacks.remove(ownerCtx, snapshot.rollbackId),
      ).rejects.toBeInstanceOf(ConflictException);

      // The row is the only thing that names the tag, so it outlives a failed
      // removal rather than leaving the image on disk with nothing pointing
      // at it.
      expect(await remaining(ownerCtx, application.applicationId)).toHaveLength(
        1,
      );
    });

    it('deletes a snapshot whose preserved image the server no longer has', async () => {
      const { ownerCtx, application, snapshot } =
        await setUpSnapshotOnBuilder();
      // `docker image rm` exits non-zero for an image that is not there, so an
      // operator who has run `docker image prune -a` would meet the refusal
      // above with nothing left to act on.
      execMock.execAsyncRemote.mockRejectedValue(
        new ExecError('Remote command failed with exit code 1', {
          command: 'docker image rm web-app:v1 --force',
          stderr: 'Error: No such image: web-app:v1',
          exitCode: 1,
        }),
      );

      await rollbacks.remove(ownerCtx, snapshot.rollbackId);

      expect(await remaining(ownerCtx, application.applicationId)).toEqual([]);
      // The removal was attempted, on the builder, and its refusal is what was
      // read — the row did not simply go unasked.
      expect(imageRemovals().servers).toHaveLength(1);
    });
  });

  describe('row-level access', () => {
    /** Capture one snapshot as the owner and hand back both ctxs. */
    async function setUpSnapshot() {
      const { ownerSession, organizationId, ownerCtx, application } =
        await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
      });
      await deploy(application.applicationId);
      const [snapshot] = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      docker.createService.mockClear();
      return { ownerSession, organizationId, ownerCtx, application, snapshot };
    }

    it('a member without a row-level grant can neither list, roll back, nor remove', async () => {
      const { ownerSession, organizationId, ownerCtx, application, snapshot } =
        await setUpSnapshot();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      await expect(
        rollbacks.findAllByApplicationId(inviteeCtx, application.applicationId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        rollbacks.rollback(inviteeCtx, snapshot.rollbackId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        rollbacks.remove(inviteeCtx, snapshot.rollbackId),
      ).rejects.toThrow(ForbiddenException);

      // Nothing converged and nothing was deleted.
      expect(docker.createService).not.toHaveBeenCalled();
      const rows = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toHaveLength(1);
    });

    it('rollbacks are invisible outside their own organization', async () => {
      const { ownerSession, application, snapshot } = await setUpSnapshot();

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;
      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);

      // Same user, but acting in the second organization: the snapshot from
      // the first organization must not resolve, even for its creator.
      await expect(
        rollbacks.findAllByApplicationId(
          secondOrgCtx,
          application.applicationId,
        ),
      ).rejects.toThrow(NotFoundException);
      await expect(
        rollbacks.rollback(secondOrgCtx, snapshot.rollbackId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        rollbacks.remove(secondOrgCtx, snapshot.rollbackId),
      ).rejects.toThrow(NotFoundException);
      expect(docker.createService).not.toHaveBeenCalled();
    });
  });

  describe('HTTP endpoint surface', () => {
    it('lists snapshots, rolls back, and deletes over HTTP', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const cookie = ownerSession.cookie;
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
      });
      await deploy(application.applicationId);
      docker.createService.mockClear();

      const history = await request(server)
        .get(`/applications/${application.applicationId}/rollbacks`)
        .set('Cookie', cookie);
      expect(history.status).toBe(200);
      expect(history.body).toHaveLength(1);
      const { rollbackId } = (history.body as { rollbackId: string }[])[0];

      const rolled = await request(server)
        .post(`/rollbacks/${rollbackId}/rollback`)
        .set('Cookie', cookie);
      expect(rolled.status).toBe(202);
      expect(rolled.body).toEqual({ deploymentId: null });
      expect(docker.createService).toHaveBeenCalledTimes(1);
      // The pinned converge's blank credential is the first argument.
      const [, settings] = docker.createService.mock.lastCall as [
        object,
        { TaskTemplate: { ContainerSpec: { Image: string } } },
      ];
      expect(settings.TaskTemplate.ContainerSpec.Image).toBe('web-app:v1');

      const removed = await request(server)
        .delete(`/rollbacks/${rollbackId}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);
      const emptied = await request(server)
        .get(`/applications/${application.applicationId}/rollbacks`)
        .set('Cookie', cookie);
      expect(emptied.body).toEqual([]);
    });

    it('a member without a row-level grant gets 403 over HTTP', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      await applications.update(ownerCtx, application.applicationId, {
        rollbackActive: true,
      });
      await deploy(application.applicationId);
      const [snapshot] = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );

      const denied = await request(server)
        .post(`/rollbacks/${snapshot.rollbackId}/rollback`)
        .set('Cookie', invitee.cookie);
      expect(denied.status).toBe(403);
    });
  });
});
