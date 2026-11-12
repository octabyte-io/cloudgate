import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import {
  application as applicationTable,
  deployment as deploymentTable,
} from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type { QueuedJob } from '../../src/deployment-queue/queue.port';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
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

/**
 * The two deployment-side routes: rebuilding from the last known
 * source, and stopping a build that has been asked for. A build killed while
 * it runs is `running-build-cancel.e2e-spec.ts`, on real processes.
 *
 * The queue is mocked at `DEPLOYMENT_QUEUE` because what these routes are
 * *for* is what they ask the queue — the real in-memory queue drains a job the
 * moment it is added, so a queued deployment would never be observable long
 * enough to cancel.
 */
describe('Deployment lifecycle (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let deployments: DeploymentsService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  const queueMock = {
    add: jest.fn(),
    getJobs: jest.fn<Promise<QueuedJob[]>, [string[]?]>(),
    cancel: jest.fn<Promise<boolean>, [string]>(),
    clearWaiting: jest.fn<Promise<QueuedJob[]>, []>(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    deployments = ctx.app.get(DeploymentsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    queueMock.add.mockReset().mockResolvedValue({ id: 'job-1' });
    queueMock.getJobs.mockReset().mockResolvedValue([]);
    queueMock.cancel.mockReset().mockResolvedValue(false);
    queueMock.clearWaiting.mockReset().mockResolvedValue([]);
  });

  /** An owner with a project, an environment and one Application in it. */
  async function setUpApplication(appName = 'web-app') {
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
      appName,
      environmentId: environment.environmentId,
    });
    // A source, so the deploy is not refused as having none.
    await ctx.db
      .update(applicationTable)
      .set({ sourceType: 'docker', dockerImage: 'nginx:1.27' })
      .where(eq(applicationTable.applicationId, created.applicationId));

    return { ownerSession, organizationId, ownerCtx, environment, created };
  }

  describe('redeploy', () => {
    it('records a pending Deployment and enqueues a redeploy of the same source', async () => {
      const { ownerSession, created } = await setUpApplication();

      const res = await request(server)
        .post(`/applications/${created.applicationId}/redeploy`)
        .set('Cookie', ownerSession.cookie)
        // A body, like its `:id/deployments` sibling: both take the same
        // optional title/description DTO, and the pipe wants an object.
        .send({});

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        applicationId: created.applicationId,
        status: 'pending',
        title: 'Rebuild deployment',
      });
      // `type: 'redeploy'` is what tells the processor this is a rebuild of
      // what is already there rather than a fresh trigger.
      expect(queueMock.add).toHaveBeenCalledWith({
        applicationType: 'application',
        applicationId: created.applicationId,
        // The row it just recorded, so the build claims that one.
        deploymentId: (res.body as { deploymentId: string }).deploymentId,
        title: 'Rebuild deployment',
        description: '',
        type: 'redeploy',
        serverId: null,
      });
    });
  });

  describe('cancel', () => {
    /** A waiting job for one application, as the queue reports it, naming
     * the Deployment row its trigger recorded — or `null`, a job that
     * names none. */
    const waitingJob = (
      applicationId: string,
      id = 'job-1',
      deploymentId: string | null = null,
    ): QueuedJob => ({
      id,
      state: 'waiting',
      data: {
        applicationType: 'application',
        applicationId,
        deploymentId,
        title: 'Manual deployment',
        description: '',
        type: 'deploy',
        serverId: null,
      },
    });

    it('a queued Deployment is dequeued and left cancelled', async () => {
      const { ownerSession, ownerCtx, created } = await setUpApplication();
      const queued = await deployments.deploy(ownerCtx, created.applicationId);
      expect(queued.status).toBe('pending');

      queueMock.getJobs.mockResolvedValue([
        waitingJob(created.applicationId, 'job-7', queued.deploymentId),
      ]);
      queueMock.cancel.mockResolvedValue(true);

      const res = await request(server)
        .post(`/deployments/${queued.deploymentId}/cancel`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      // The job the queue was actually holding, by its own handle.
      expect(queueMock.cancel).toHaveBeenCalledWith('job-7');
      expect(res.body).toMatchObject({
        deploymentId: queued.deploymentId,
        status: 'cancelled',
      });
      const [row] = await ctx.db
        .select()
        .from(deploymentTable)
        .where(eq(deploymentTable.deploymentId, queued.deploymentId));
      expect(row.status).toBe('cancelled');
      // A cancelled attempt is finished: history stamps it, so it can never be
      // claimed by the next build that starts.
      expect(row.finishedAt).toBeTruthy();
    });

    it('refuses a build the queue can no longer take back, and leaves the record alone', async () => {
      const { ownerSession, ownerCtx, created } = await setUpApplication();
      const queued = await deployments.deploy(ownerCtx, created.applicationId);

      // The job has left the waiting list but the engine has not claimed the
      // record yet: the in-memory queue answers false for an active job, and
      // there is no running build to kill until the record reads running.
      queueMock.getJobs.mockResolvedValue([
        {
          ...waitingJob(created.applicationId, 'job-1', queued.deploymentId),
          state: 'active',
        },
      ]);
      queueMock.cancel.mockResolvedValue(false);

      const res = await request(server)
        .post(`/deployments/${queued.deploymentId}/cancel`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toContain(
        'no longer waiting in the queue',
      );
      const [row] = await ctx.db
        .select()
        .from(deploymentTable)
        .where(eq(deploymentTable.deploymentId, queued.deploymentId));
      // Not cancelled: the build is still going, and a record that claimed
      // otherwise would be the silent no-op this route exists to avoid.
      expect(row.status).toBe('pending');
    });

    /**
     * A running record the engine is not holding a cancel window for —
     * its build is past the shell steps and releasing — is refused, and it is
     * never matched against a *waiting* job: that job is a later build of the
     * same service, and dequeuing it used to label this record cancelled while
     * it ran on and leave the later one's record pending for ever.
     */
    it('refuses a running build past its shell steps without dequeuing the build queued behind it', async () => {
      const { ownerSession, ownerCtx, created } = await setUpApplication();
      const running = await deployments.deploy(ownerCtx, created.applicationId);
      await ctx.db
        .update(deploymentTable)
        .set({ status: 'running' })
        .where(eq(deploymentTable.deploymentId, running.deploymentId));
      const later = await deployments.deploy(ownerCtx, created.applicationId);
      queueMock.getJobs.mockResolvedValue([
        {
          ...waitingJob(created.applicationId, 'job-1', running.deploymentId),
          state: 'active',
        },
        waitingJob(created.applicationId, 'job-2', later.deploymentId),
      ]);
      queueMock.cancel.mockImplementation((id) =>
        Promise.resolve(id === 'job-2'),
      );

      const res = await request(server)
        .post(`/deployments/${running.deploymentId}/cancel`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toContain(
        'finished building and is releasing',
      );
      expect(queueMock.cancel).not.toHaveBeenCalledWith('job-2');
      const [row] = await ctx.db
        .select()
        .from(deploymentTable)
        .where(eq(deploymentTable.deploymentId, running.deploymentId));
      expect(row.status).toBe('running');
    });

    /**
     * Before a job carried its Deployment id, cancel took out the first
     * waiting job of the Service, and the build processor claimed the oldest
     * pending row — so cancelling B left B's build running under A's row.
     */
    it('cancelling the newer of two queued Deployments dequeues its own job and leaves the older one queued', async () => {
      const { ownerSession, ownerCtx, created } = await setUpApplication();
      const older = await deployments.deploy(ownerCtx, created.applicationId);
      const newer = await deployments.deploy(ownerCtx, created.applicationId);
      queueMock.getJobs.mockResolvedValue([
        waitingJob(created.applicationId, 'job-a', older.deploymentId),
        waitingJob(created.applicationId, 'job-b', newer.deploymentId),
      ]);
      queueMock.cancel.mockResolvedValue(true);

      const res = await request(server)
        .post(`/deployments/${newer.deploymentId}/cancel`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      expect(queueMock.cancel).toHaveBeenCalledTimes(1);
      expect(queueMock.cancel).toHaveBeenCalledWith('job-b');
      const [olderRow] = await ctx.db
        .select()
        .from(deploymentTable)
        .where(eq(deploymentTable.deploymentId, older.deploymentId));
      expect(olderRow.status).toBe('pending');

      // And the build left in the queue claims its own row, not the
      // cancelled one.
      const claimed = await deployments.create({
        kind: 'application',
        applicationId: created.applicationId,
        title: 'Manual deployment',
        description: '',
        deploymentId: older.deploymentId,
      });
      expect(claimed?.deploymentId).toBe(older.deploymentId);
    });

    it('a production cancel never dequeues a waiting preview build of the same Application', async () => {
      const { ownerSession, ownerCtx, created } = await setUpApplication();
      const queued = await deployments.deploy(ownerCtx, created.applicationId);
      // The preview job shares the Application's queue group and waits ahead
      // of the production one; the production job was already taken. It names
      // no row, so only the preview fence in `jobBuildsRecord` keeps it from
      // matching by group.
      queueMock.getJobs.mockResolvedValue([
        {
          id: 'job-preview',
          state: 'waiting',
          data: {
            applicationType: 'application-preview',
            applicationId: created.applicationId,
            previewDeploymentId: 'preview-1',
            deploymentId: null,
            title: 'Preview Deployment',
            description: '',
            type: 'deploy',
            serverId: null,
          },
        },
      ]);
      queueMock.cancel.mockResolvedValue(true);

      const res = await request(server)
        .post(`/deployments/${queued.deploymentId}/cancel`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(409);
      expect(queueMock.cancel).not.toHaveBeenCalled();
      const [row] = await ctx.db
        .select()
        .from(deploymentTable)
        .where(eq(deploymentTable.deploymentId, queued.deploymentId));
      expect(row.status).toBe('pending');
    });

    it('refuses a Deployment that has already finished', async () => {
      const { ownerSession, ownerCtx, created } = await setUpApplication();
      const queued = await deployments.deploy(ownerCtx, created.applicationId);
      await deployments.updateStatus(queued.deploymentId, 'done');

      const res = await request(server)
        .post(`/deployments/${queued.deploymentId}/cancel`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(409);
      expect(queueMock.cancel).not.toHaveBeenCalled();
    });

    it('reads as absent from another organization', async () => {
      const { ownerSession, ownerCtx, created } = await setUpApplication();
      const queued = await deployments.deploy(ownerCtx, created.applicationId);
      queueMock.getJobs.mockResolvedValue([waitingJob(created.applicationId)]);
      queueMock.cancel.mockResolvedValue(true);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      expect(secondOrg.status).toBe(201);
      const activated = await request(server)
        .post('/api/auth/organization/set-active')
        .set('Cookie', ownerSession.cookie)
        .send({ organizationId: (secondOrg.body as { id: string }).id });
      expect(activated.status).toBe(200);

      const res = await request(server)
        .post(`/deployments/${queued.deploymentId}/cancel`)
        .set('Cookie', ownerSession.cookie);

      // The body a never-existed id gets, not the owning Application's own
      // 404: the owner of both Organizations learns nothing from it.
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ message: 'Deployment not found' });
      expect(queueMock.cancel).not.toHaveBeenCalled();
    });
  });

  /**
   * Settings → Instance → Empty the build queue. The queue only ever
   * held jobs; the Deployment rows are what every screen reads, and a dropped
   * build's row used to stay `pending` for ever — a live log, a Cancel, and
   * "A build is running" for a build that would never start.
   */
  describe('emptying the build queue', () => {
    const job = (
      applicationId: string,
      id: string,
      state: QueuedJob['state'],
      deploymentId: string,
    ): QueuedJob => ({
      id,
      state,
      data: {
        applicationType: 'application',
        applicationId,
        deploymentId,
        title: 'Manual deployment',
        description: '',
        type: 'deploy',
        serverId: null,
      },
    });

    const statusOf = async (deploymentId: string) => {
      const [row] = await ctx.db
        .select()
        .from(deploymentTable)
        .where(eq(deploymentTable.deploymentId, deploymentId));
      return row;
    };

    it('settles each dropped Deployment as cancelled, says why in its log, and leaves a running build alone', async () => {
      const { ownerSession, ownerCtx, environment, created } =
        await setUpApplication();
      const other = await applications.create(ownerCtx, {
        name: 'Worker',
        appName: 'worker-app',
        environmentId: environment.environmentId,
      });
      await ctx.db
        .update(applicationTable)
        .set({ sourceType: 'docker', dockerImage: 'nginx:1.27' })
        .where(eq(applicationTable.applicationId, other.applicationId));

      // The first Application: one build running (claimed by the engine), one
      // queued behind it.
      const running = await deployments.deploy(ownerCtx, created.applicationId);
      const queued = await deployments.deploy(ownerCtx, created.applicationId);
      await deployments.create({
        kind: 'application',
        applicationId: created.applicationId,
        title: 'Manual deployment',
        description: '',
        deploymentId: running.deploymentId,
      });
      // The second: a job the queue has already handed to a worker whose
      // engine has not claimed its row yet, and one waiting behind it. The
      // handed-over one's row must stay claimable.
      const starting = await deployments.deploy(ownerCtx, other.applicationId);
      const waiting = await deployments.deploy(ownerCtx, other.applicationId);

      queueMock.clearWaiting.mockResolvedValue([
        job(created.applicationId, 'job-2', 'waiting', queued.deploymentId),
        job(other.applicationId, 'job-4', 'waiting', waiting.deploymentId),
      ]);
      execMock.execAsync.mockClear();

      const res = await request(server)
        .post('/settings/clean-deployment-queue')
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);
      expect(queueMock.clearWaiting).toHaveBeenCalledTimes(1);

      for (const dropped of [queued, waiting]) {
        const row = await statusOf(dropped.deploymentId);
        expect(row.status).toBe('cancelled');
        expect(row.finishedAt).toBeTruthy();
        // The log the console shows for it says what happened and what to do.
        expect(execMock.execAsync).toHaveBeenCalledWith(
          expect.stringContaining(row.logPath),
        );
      }
      const dropLines = execMock.execAsync.mock.calls
        .map(([command]) => command as string)
        .filter((command) => command.includes('build queue was emptied'));
      expect(dropLines).toHaveLength(2);
      expect(dropLines[0]).toContain('Deploy again');

      expect((await statusOf(running.deploymentId)).status).toBe('running');
      expect((await statusOf(running.deploymentId)).finishedAt).toBeNull();
      expect((await statusOf(starting.deploymentId)).status).toBe('pending');

      // The projection the Overview and Deployments tab read: nothing about
      // the second Application is live but the build the queue really has.
      const listed = await request(server)
        .get(`/applications/${other.applicationId}/deployments`)
        .set('Cookie', ownerSession.cookie);
      expect(listed.status).toBe(200);
      expect(
        (listed.body as { deploymentId: string; status: string }[])
          .filter((row) => row.status === 'pending' || row.status === 'running')
          .map((row) => row.deploymentId),
      ).toEqual([starting.deploymentId]);
    });

    /**
     * The rows settled are exactly the ones the dropped jobs name —
     * not the Service's newest `n` pending ones. Here the dropped job is the
     * *older* row's, and the newer row's job is the one a worker holds.
     */
    it("settles exactly the dropped jobs' own rows, whatever their age", async () => {
      const { ownerSession, ownerCtx, created } = await setUpApplication();
      const older = await deployments.deploy(ownerCtx, created.applicationId);
      const newer = await deployments.deploy(ownerCtx, created.applicationId);
      queueMock.clearWaiting.mockResolvedValue([
        job(created.applicationId, 'job-1', 'waiting', older.deploymentId),
      ]);

      const res = await request(server)
        .post('/settings/clean-deployment-queue')
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      expect((await statusOf(older.deploymentId)).status).toBe('cancelled');
      expect((await statusOf(newer.deploymentId)).status).toBe('pending');
    });

    it('with nothing queued, touches no Deployment', async () => {
      const { ownerSession, ownerCtx, created } = await setUpApplication();
      const orphan = await deployments.deploy(ownerCtx, created.applicationId);
      queueMock.clearWaiting.mockResolvedValue([]);

      const res = await request(server)
        .post('/settings/clean-deployment-queue')
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      // A pending row the queue did not drop is not this route's to settle:
      // for all it knows, a worker is about to claim it.
      expect((await statusOf(orphan.deploymentId)).status).toBe('pending');
    });
  });
});
