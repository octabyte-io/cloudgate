import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { server as serverTable } from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { rollback } from '../../src/rollbacks/rollback.schema';
import { RollbacksService } from '../../src/rollbacks/rollbacks.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

/**
 * A third out-of-scope finding of the rollback-image work: the preserved
 * `${appName}:v${version}` tag outliving every row that names it.
 *
 * `DeploymentEngineService.captureRollback` writes that tag on the Server that
 * built the Deployment, and the `rollback` row is the only thing in the
 * database that records it — `RollbacksService.remove`'s own docblock says so,
 * and a `docker images` listing cannot tell a preserved snapshot from anything
 * else. `rollback.deploymentId` and `deployment.applicationId` both cascade, so
 * **every** delete of an Application destroys those rows, and until the fix
 * nothing on any of the three delete paths reclaimed the images first.
 *
 * The ticket framed this as an asymmetry between `application.serverId`
 * (`cascade`) and `application.buildServerId` (`set null`), reachable by
 * retiring a run Server. It is not reachable that way: `ServersService.remove`
 * has refused a Server that any Application names. What is
 * reachable is the ordinary gesture — delete the Application, its Environment
 * or its Project — and that leaks on a **single-Server** install too, where the
 * preserved tags sit on the run Server. So these tests are led by the
 * single-Server arm, which is live, with the build-Server arm beside it.
 *
 * Doubles are the exec layer, the Docker daemon and the Traefik writer, all
 * boundaries (§1.7). Capture is real, through Postgres, so the tags asserted on
 * are the ones `captureRollback` actually wrote.
 */
describe('Preserved rollback images on delete (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let rollbacks: RollbacksService;
  let engine: DeploymentEngineService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
  });

  /**
   * The teardown answer a Delete needs: `absent` for the presence probe, `ok`
   * for everything else. An empty stdout reads as `'unknown'` and would 409,
   * which is the `applications.e2e-spec.ts` note one file over.
   */
  const teardownSucceeds = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command) ? { ...ok, stdout: 'absent' } : ok,
    );

  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
    writeCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };

  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };
  const convergedTasks = [1, 2, 3].map((n) => ({
    Status: { State: 'running', Timestamp: `2026-09-07T00:00:0${n}Z` },
  }));
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    rollbacks = ctx.app.get(RollbacksService);
    engine = ctx.app.get(DeploymentEngineService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockImplementation(teardownSucceeds);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        teardownSucceeds(command),
      );
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
    Object.values(traefikWriterMock).forEach((mock) => mock.mockReset());
  });

  const permissionCtx = (userId: string, organizationId: string) => ({
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
  });

  async function signUp(body: {
    name: string;
    email: string;
    password: string;
  }) {
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(body);
    expect(res.status).toBe(200);
    return {
      cookie: res.headers['set-cookie'],
      id: (res.body as { user: { id: string } }).user.id,
    };
  }

  /**
   * An owner, a Project, an Environment and a docker-sourced Application with
   * capture on — docker-sourced because it builds nothing, so the engine runs
   * end to end against the doubled exec and daemon.
   */
  async function setUp(appName = 'web-app') {
    const session = await signUp({
      name: 'Grace Hopper',
      email: `grace+${appName}@example.com`,
      password: 'super-secret-password',
    });
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', session.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(session.id, organizationId);

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const created = await applications.create(ownerCtx, {
      name: 'Web App',
      appName,
      environmentId: environment.environmentId,
    });
    const application = await applications.update(
      ownerCtx,
      created.applicationId,
      {
        sourceType: 'docker',
        dockerImage: 'registry.example.com/acme/web:1',
        rollbackActive: true,
      },
    );
    return {
      session,
      organizationId,
      ownerCtx,
      project,
      environment,
      application,
    };
  }

  /** Deploys through the real engine, as the queue processor would. */
  async function deploy(applicationId: string) {
    await engine.deploy(await applications.findDeployable(applicationId));
  }

  /** Which machines were asked to remove an image, and with what. */
  function imageRemovals() {
    return {
      platformHost: execMock.execAsync.mock.calls
        .map(([command]) => command)
        .filter((command) => command.includes('docker image rm')),
      servers: execMock.execAsyncRemote.mock.calls
        .filter(([, command]) => command.includes('docker image rm'))
        .map(([serverId, command]) => ({ serverId, command })),
    };
  }

  /**
   * A snapshot's Server pair written straight into `full_context`, which is the
   * only way to produce a build-Server row: the capture refuses to capture one, so
   * this is the shape an install that had a build Server before the fix already
   * has, and nothing revisits a `full_context`.
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

  describe('deleting an Application', () => {
    it('reclaims every preserved image its snapshots named, on the server that holds them', async () => {
      const { ownerCtx, application } = await setUp();
      await deploy(application.applicationId);
      await deploy(application.applicationId);
      const snapshots = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(snapshots.map((row) => row.image)).toEqual([
        'web-app:v2',
        'web-app:v1',
      ]);

      await applications.remove(ownerCtx, application.applicationId);

      // `web-app\:v1`: the tag is an argv word and `shell-quote`
      // escapes its `:`, which the shell strips before `docker` sees it. This
      // Application has no Server, so the platform host is the machine that
      // holds the tags — the single-Server arm, which is the live one.
      const { platformHost, servers } = imageRemovals();
      expect(platformHost).toEqual([
        'docker image rm web-app\\:v1 --force',
        'docker image rm web-app\\:v2 --force',
      ]);
      expect(servers).toEqual([]);
    });

    it('reaches the build server a snapshot names, not the server the service ran on', async () => {
      const { organizationId, ownerCtx, application } = await setUp();
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

      await applications.remove(ownerCtx, application.applicationId);

      const { platformHost, servers } = imageRemovals();
      expect(servers).toEqual([
        {
          serverId: builder.serverId,
          command: 'docker image rm web-app\\:v1 --force',
        },
      ]);
      // Nothing was asked of the machine the service ran on, where the tag has
      // never been.
      expect(platformHost).toEqual([]);
    });

    it('leaves the preserved images alone when the delete is refused', async () => {
      const { ownerCtx, application } = await setUp();
      await deploy(application.applicationId);
      // The workload survived its teardown, so the row is kept — and a
      // reclamation ahead of that refusal would have made every snapshot the
      // console still offers unrestorable.
      execMock.execAsync.mockImplementation((command: string) =>
        Promise.resolve(
          isPresenceProbe(command) ? { ...ok, stdout: 'present' } : ok,
        ),
      );

      await expect(
        applications.remove(ownerCtx, application.applicationId),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(imageRemovals().platformHost).toEqual([]);
      expect(
        await rollbacks.findAllByApplicationId(
          ownerCtx,
          application.applicationId,
        ),
      ).toHaveLength(1);
    });

    it('does not touch a machine in another organization that a snapshot names', async () => {
      const { session, ownerCtx, application } = await setUp();
      await deploy(application.applicationId);
      const [snapshot] = await rollbacks.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      const secondOrg = await createOrganization(
        server,
        ctx.db,
        session.cookie,
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
      // `full_context` is a `json` column no foreign key constrains, and the
      // rollback-snapshot fix is the proof that ids in it can name another
      // organization's rows.
      await poisonSnapshot(snapshot.rollbackId, {
        buildServerId: foreign.serverId,
      });

      await applications.remove(ownerCtx, application.applicationId);

      const { platformHost, servers } = imageRemovals();
      expect(servers).toEqual([]);
      // Nor was the removal quietly re-aimed at the machine this organization
      // does own, which would delete an image the snapshot never named.
      expect(platformHost).toEqual([]);
    });

    it('names the images it could not reclaim rather than answering a bare 200', async () => {
      const { organizationId, ownerCtx, application } = await setUp();
      await deploy(application.applicationId);
      await deploy(application.applicationId);
      const snapshots = await rollbacks.findAllByApplicationId(
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
      for (const snapshot of snapshots) {
        await poisonSnapshot(snapshot.rollbackId, {
          buildServerId: builder.serverId,
        });
      }
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          command.includes('docker image rm')
            ? Promise.reject(
                new ExecError('Remote command failed with exit code 1', {
                  command,
                  stderr: 'ssh: connect to host 203.0.113.7 port 22: timed out',
                  exitCode: 255,
                }),
              )
            : teardownSucceeds(command),
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      // The Application is gone — "forget this machine's workload" must always
      // be completable — and the answer says what is left on which machine.
      expect(removed).toMatchObject({
        unreclaimedImages: [
          { serverId: builder.serverId, images: ['web-app:v1', 'web-app:v2'] },
        ],
      });
      // Asked once and then not again: an unreachable Server must not multiply
      // an SSH connect timeout by the tag count.
      expect(imageRemovals().servers).toHaveLength(1);
    });

    it('completes when the preserved image is already gone from the machine', async () => {
      const { ownerCtx, application } = await setUp();
      await deploy(application.applicationId);
      // `docker image rm` exits non-zero for an image the daemon does not
      // have, so an operator who has run `docker image prune -a` must not be
      // told anything was left behind.
      execMock.execAsync.mockImplementation((command: string) =>
        command.includes('docker image rm')
          ? Promise.reject(
              new ExecError('Command failed with exit code 1', {
                command,
                stderr: 'Error: No such image: web-app:v1',
                exitCode: 1,
              }),
            )
          : teardownSucceeds(command),
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      expect(removed).not.toHaveProperty('unreclaimedImages');
      expect(imageRemovals().platformHost).toHaveLength(1);
    });
  });

  describe('deleting a Project or an Environment', () => {
    it('reclaims the preserved images of every Application under the Project', async () => {
      const { ownerCtx, project, environment, application } =
        await setUp('web-app');
      const second = await applications.create(ownerCtx, {
        name: 'Worker',
        appName: 'worker-app',
        environmentId: environment.environmentId,
      });
      await applications.update(ownerCtx, second.applicationId, {
        sourceType: 'docker',
        dockerImage: 'registry.example.com/acme/worker:1',
        rollbackActive: true,
      });
      await deploy(application.applicationId);
      await deploy(second.applicationId);

      await projects.remove(ownerCtx, project.projectId);

      // The bulk delete's own lesson: deleting a Project is one click and deleting eleven
      // Services is eleven, so the bulk path must reclaim what the per-Service
      // path does.
      expect(imageRemovals().platformHost.sort()).toEqual([
        'docker image rm web-app\\:v1 --force',
        'docker image rm worker-app\\:v2 --force',
      ]);
    });

    it('reclaims the preserved images of every Application under the Environment', async () => {
      const { ownerCtx, environment, application } = await setUp();
      await deploy(application.applicationId);

      await environments.remove(ownerCtx, environment.environmentId);

      expect(imageRemovals().platformHost).toEqual([
        'docker image rm web-app\\:v1 --force',
      ]);
    });
  });
});
