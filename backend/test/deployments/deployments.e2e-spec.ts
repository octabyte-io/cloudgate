import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { application as applicationTable } from '../../src/applications/application.schema';
import { ApplicationsService } from '../../src/applications/applications.service';
import { ComposeService } from '../../src/compose/compose.service';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
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

describe('Deployments (e2e)', () => {
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
    getJobs: jest.fn(),
    cancel: jest.fn(),
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
      .mockResolvedValue({ stdout: '', stderr: '' });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    queueMock.add
      .mockReset()
      .mockImplementation((data: DeploymentJob) =>
        Promise.resolve({ id: 'job-1', data, state: 'waiting' }),
      );
    queueMock.getJobs.mockReset().mockResolvedValue([]);
    queueMock.cancel.mockReset().mockResolvedValue(false);
  });

  /** An owner ctx plus a project + environment + application to deploy. */
  async function setUpApplication({ withSource = true } = {}) {
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
    const application = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'web-app',
      environmentId: environment.environmentId,
    });
    // A source, so the deploy path has something to build: a row fresh from
    // create is refused (the last describe below).
    if (withSource) {
      await ctx.db
        .update(applicationTable)
        .set({ sourceType: 'docker', dockerImage: 'nginx:1.27' })
        .where(eq(applicationTable.applicationId, application.applicationId));
    }
    return {
      organizationId,
      ownerSession,
      ownerCtx,
      application,
      environmentId: environment.environmentId,
    };
  }

  describe('recorder: create + updateStatus (Phase 21 port)', () => {
    it('create records a running deployment and initializes its log file', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const record = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'Manual deployment',
        description: 'triggered from test',
      });

      expect(record.deploymentId).toEqual(expect.any(String));
      expect(record.logPath).toContain('/web-app/');
      expect(record.logPath.endsWith('.log')).toBe(true);

      // The log file is initialized on the local server (no build server).
      expect(execMock.execAsync).toHaveBeenCalledTimes(1);
      const [initCommand] = execMock.execAsync.mock.calls[0] as [string];
      expect(initCommand).toContain('mkdir -p');
      expect(initCommand).toContain(record.logPath);
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();

      const [row] = await deployments.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(row).toMatchObject({
        deploymentId: record.deploymentId,
        applicationId: application.applicationId,
        title: 'Manual deployment',
        description: 'triggered from test',
        status: 'running',
        logPath: record.logPath,
      });
      expect(row.startedAt).toEqual(expect.any(String));
      expect(row.finishedAt).toBeNull();
    });

    it('updateStatus persists running → done and stamps finishedAt', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const record = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'Manual deployment',
        description: '',
      });

      await deployments.updateStatus(record.deploymentId, 'done');

      const [row] = await deployments.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(row.status).toBe('done');
      expect(row.finishedAt).toEqual(expect.any(String));
    });

    it('updateStatus persists running → error', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const record = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'Manual deployment',
        description: '',
      });

      await deployments.updateStatus(record.deploymentId, 'error');

      const [row] = await deployments.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(row.status).toBe('error');
      expect(row.finishedAt).toEqual(expect.any(String));
    });
  });

  describe('trigger: deploy → enqueue', () => {
    it('records a pending deployment and enqueues the job', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const triggered = await deployments.deploy(
        ownerCtx,
        application.applicationId,
      );

      expect(queueMock.add).toHaveBeenCalledTimes(1);
      expect(queueMock.add).toHaveBeenCalledWith({
        applicationType: 'application',
        applicationId: application.applicationId,
        // The job names the row it recorded, which its build claims.
        deploymentId: triggered.deploymentId,
        title: 'Manual deployment',
        description: '',
        type: 'deploy',
        serverId: null,
      });

      const [row] = await deployments.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(row).toMatchObject({
        deploymentId: triggered.deploymentId,
        applicationId: application.applicationId,
        title: 'Manual deployment',
        status: 'pending',
      });
      expect(row.startedAt).toBeNull();
      // The log file is initialized up front so the record is tailable
      // (and the engine appendable) from the moment it is queued.
      expect(row.logPath).toContain('/web-app/');
      expect(execMock.execAsync).toHaveBeenCalledTimes(1);
    });

    it('the recorder claims the queued pending record instead of creating a second one', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const triggered = await deployments.deploy(
        ownerCtx,
        application.applicationId,
      );

      // What the engine does when the queued job starts building.
      const record = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'Manual deployment',
        description: '',
        deploymentId: triggered.deploymentId,
      });

      expect(record?.deploymentId).toBe(triggered.deploymentId);
      expect(record?.logPath).toBe(triggered.logPath);

      const rows = await deployments.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('running');
      expect(rows[0].startedAt).toEqual(expect.any(String));
      // The log file was initialized once, at trigger time.
      expect(execMock.execAsync).toHaveBeenCalledTimes(1);
    });

    /**
     * The job names its row, and the claim takes that row — not the
     * Service's oldest pending one, which is another trigger's build.
     */
    it('claims the pending record its job names, not the oldest', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const first = await deployments.deploy(
        ownerCtx,
        application.applicationId,
      );
      const second = await deployments.deploy(
        ownerCtx,
        application.applicationId,
        { title: 'Rebuild deployment' },
      );

      const claimed = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'Manual deployment',
        description: '',
        deploymentId: second.deploymentId,
      });

      expect(claimed?.deploymentId).toBe(second.deploymentId);
      const rows = await deployments.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      const byId = new Map(rows.map((row) => [row.deploymentId, row.status]));
      expect(byId.get(first.deploymentId)).toBe('pending');
      expect(byId.get(second.deploymentId)).toBe('running');
    });

    it('a named record that is no longer pending is not claimed, and nothing else is', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const settled = await deployments.deploy(
        ownerCtx,
        application.applicationId,
      );
      const other = await deployments.deploy(
        ownerCtx,
        application.applicationId,
      );
      await deployments.updateStatus(settled.deploymentId, 'cancelled');

      const claimed = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'Manual deployment',
        description: '',
        deploymentId: settled.deploymentId,
      });

      expect(claimed).toBeNull();
      const rows = await deployments.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows).toHaveLength(2);
      const byId = new Map(rows.map((row) => [row.deploymentId, row.status]));
      expect(byId.get(settled.deploymentId)).toBe('cancelled');
      expect(byId.get(other.deploymentId)).toBe('pending');
    });

    it('a named record of another Service is not claimed', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const triggered = await deployments.deploy(
        ownerCtx,
        application.applicationId,
      );

      const claimed = await deployments.create({
        kind: 'compose',
        composeId: 'not-this-service',
        title: 'Manual deployment',
        description: '',
        deploymentId: triggered.deploymentId,
      });

      expect(claimed).toBeNull();
      const [row] = await deployments.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(row.status).toBe('pending');
    });

    it('a build with no named record (a preview) records a fresh running one and leaves a pending production record alone', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const production = await deployments.deploy(
        ownerCtx,
        application.applicationId,
      );

      // What `PreviewDeploymentsService.deployPreview` reaches: the parent
      // Application's id, and no Deployment id.
      const preview = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'Preview Deployment',
        description: '',
      });

      expect(preview.deploymentId).not.toBe(production.deploymentId);
      const rows = await deployments.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      const byId = new Map(rows.map((row) => [row.deploymentId, row.status]));
      expect(byId.get(production.deploymentId)).toBe('pending');
      expect(byId.get(preview.deploymentId)).toBe('running');
    });
  });

  describe('history', () => {
    it('lists deployments for a service newest-first', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const oldest = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'first',
        description: '',
      });
      await deployments.updateStatus(oldest.deploymentId, 'done');
      const middle = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'second',
        description: '',
      });
      await deployments.updateStatus(middle.deploymentId, 'error');
      const newest = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'third',
        description: '',
      });

      const rows = await deployments.findAllByApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(rows.map((row) => row.deploymentId)).toEqual([
        newest.deploymentId,
        middle.deploymentId,
        oldest.deploymentId,
      ]);
    });
  });

  describe('logs', () => {
    it('readLogs tails the recorded log file', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const record = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'Manual deployment',
        description: '',
      });

      execMock.execAsync.mockResolvedValue({
        stdout: 'Initializing deployment\nbuild output',
        stderr: '',
      });

      const logs = await deployments.readLogs(
        ownerCtx,
        record.deploymentId,
        50,
      );

      expect(logs).toBe('Initializing deployment\nbuild output');
      const [tailCommand] = execMock.execAsync.mock.lastCall as [string];
      expect(tailCommand).toContain('tail -n 50');
      expect(tailCommand).toContain(record.logPath);
    });

    it('readLogs of an unknown deployment is a 404', async () => {
      const { ownerCtx } = await setUpApplication();

      await expect(
        deployments.readLogs(ownerCtx, 'no-such-deployment', 100),
      ).rejects.toThrow(NotFoundException);
    });

    // ADR-0007: `/listen-deployment` is addressed by deployment id, so the
    // gateway needs the same two answers `readLogs` resolves before it tails —
    // which file, and on which machine — behind the same entitlement gate.
    it('resolveLogSource answers the recorded path and the host that holds it', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const record = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'Manual deployment',
        description: '',
      });

      const source = await deployments.resolveLogSource(
        ownerCtx,
        record.deploymentId,
      );

      // `createdAt` joined the answer with log retention: `readLogs` tests it against
      // the retention window to tell a log this platform reaped from one a
      // queued build has not written yet, and this is the one place that turns
      // a deployment id into a log behind the entitlement gate.
      // `createdAt` is the row's own stamp, which the recorder's return type
      // does not carry — an ISO-8601 string, per `db/columns.ts`'s
      // `isoTimestamp`.
      const { createdAt, ...addressed } = source;
      expect(addressed).toEqual({ logPath: record.logPath, serverId: null });
      expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('resolveLogSource refuses a deployment the caller is not entitled to', async () => {
      const { ownerSession, organizationId, ownerCtx, application } =
        await setUpApplication();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const record = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'Manual deployment',
        description: '',
      });

      await expect(
        deployments.resolveLogSource(
          permissionCtx(invitee.id, organizationId),
          record.deploymentId,
        ),
      ).rejects.toThrow(ForbiddenException);

      // The owner, who is entitled, still gets it.
      await expect(
        deployments.resolveLogSource(ownerCtx, record.deploymentId),
      ).resolves.toMatchObject({
        logPath: record.logPath,
        serverId: null,
      });
    });

    it("resolveLogSource reads another Organization's deployment as absent", async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const record = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'Manual deployment',
        description: '',
      });
      const created = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      expect(created.status).toBe(201);
      const secondOrganizationId = (created.body as { id: string }).id;
      const activated = await request(server)
        .post('/api/auth/organization/set-active')
        .set('Cookie', ownerSession.cookie)
        .send({ organizationId: secondOrganizationId });
      expect(activated.status).toBe(200);
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );

      // The same answer as an id that never existed — not the owning
      // Application's 404 for the owner, nor the grant refusal for a member.
      for (const caller of [
        permissionCtx(ownerCtx.user.id, secondOrganizationId),
        permissionCtx(invitee.id, secondOrganizationId),
      ]) {
        await expect(
          deployments.resolveLogSource(caller, record.deploymentId),
        ).rejects.toThrow(new NotFoundException('Deployment not found'));
      }
    });

    it('resolveLogSource of an unknown deployment is a 404', async () => {
      const { ownerCtx } = await setUpApplication();

      await expect(
        deployments.resolveLogSource(ownerCtx, 'no-such-deployment'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('row-level access', () => {
    it('a member without a row-level grant can neither list nor trigger deployments', async () => {
      const { ownerSession, organizationId, ownerCtx, application } =
        await setUpApplication();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      const triggered = await deployments.deploy(
        ownerCtx,
        application.applicationId,
      );

      await expect(
        deployments.findAllByApplicationId(
          inviteeCtx,
          application.applicationId,
        ),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        deployments.deploy(inviteeCtx, application.applicationId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        deployments.readLogs(inviteeCtx, triggered.deploymentId, 100),
      ).rejects.toThrow(ForbiddenException);
      expect(queueMock.add).toHaveBeenCalledTimes(1);
    });

    it('deployments are invisible outside their own organization', async () => {
      const { ownerSession, application } = await setUpApplication();

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;
      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);

      // Same user, but acting in the second organization: the application
      // from the first organization must not resolve, even for its creator.
      await expect(
        deployments.findAllByApplicationId(
          secondOrgCtx,
          application.applicationId,
        ),
      ).rejects.toThrow(NotFoundException);
      await expect(
        deployments.deploy(secondOrgCtx, application.applicationId),
      ).rejects.toThrow(NotFoundException);
      expect(queueMock.add).not.toHaveBeenCalled();
    });
  });

  describe('HTTP endpoint surface', () => {
    it('triggers a deploy, lists history and reads logs over HTTP', async () => {
      const { ownerSession, application } = await setUpApplication();
      const cookie = ownerSession.cookie;

      const triggered = await request(server)
        .post(`/applications/${application.applicationId}/deployments`)
        .set('Cookie', cookie)
        .send({ description: 'ship it' });
      expect(triggered.status).toBe(201);
      expect(triggered.body).toMatchObject({
        applicationId: application.applicationId,
        title: 'Manual deployment',
        description: 'ship it',
        status: 'pending',
      });
      expect(queueMock.add).toHaveBeenCalledTimes(1);

      const history = await request(server)
        .get(`/applications/${application.applicationId}/deployments`)
        .set('Cookie', cookie);
      expect(history.status).toBe(200);
      expect(history.body).toHaveLength(1);

      const { deploymentId } = triggered.body as { deploymentId: string };
      execMock.execAsync.mockResolvedValue({
        stdout: 'Initializing deployment',
        stderr: '',
      });
      const logs = await request(server)
        .get(`/deployments/${deploymentId}/logs`)
        .query({ tail: 25 })
        .set('Cookie', cookie);
      expect(logs.status).toBe(200);
      expect(logs.text).toBe('Initializing deployment');
      const [tailCommand] = execMock.execAsync.mock.lastCall as [string];
      expect(tailCommand).toContain('tail -n 25');
    });

    /**
     * Every field of `triggerDeploymentSchema` is optional, so a POST
     * with no body at all is a semantically complete request — but Express
     * hands Nest `undefined` rather than `{}` when a request carries no body,
     * and the object schema refused it with a 400 whose `path` was empty and
     * which named nothing the caller could fix. The console always sends a
     * body and never saw it; this project's own phase briefs show
     * `curl -X POST …/redeploy` with no `-d`, which was the 400.
     */
    describe('a POST with no body at all', () => {
      it('triggers a deploy, defaulting the title the way `{}` always did', async () => {
        const { ownerSession, application } = await setUpApplication();

        const triggered = await request(server)
          .post(`/applications/${application.applicationId}/deployments`)
          .set('Cookie', ownerSession.cookie);
        expect(triggered.status).toBe(201);
        expect(triggered.body).toMatchObject({
          applicationId: application.applicationId,
          title: 'Manual deployment',
          status: 'pending',
        });
        expect(queueMock.add).toHaveBeenCalledTimes(1);
      });

      it('reaches the handler on redeploy, so an unknown application is a 404 and not a 400', async () => {
        const { ownerSession } = await setUpApplication();

        const redeployed = await request(server)
          .post('/applications/does-not-exist/redeploy')
          .set('Cookie', ownerSession.cookie);
        expect(redeployed.status).toBe(404);
      });

      it('still refuses a body that is present and wrong', async () => {
        const { ownerSession, application } = await setUpApplication();

        const refused = await request(server)
          .post(`/applications/${application.applicationId}/deployments`)
          .set('Cookie', ownerSession.cookie)
          .send({ title: '' });
        expect(refused.status).toBe(400);
        expect(queueMock.add).not.toHaveBeenCalled();
      });
    });

    it('a member without a row-level grant gets 403 over HTTP', async () => {
      const { ownerSession, application } = await setUpApplication();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );

      const denied = await request(server)
        .post(`/applications/${application.applicationId}/deployments`)
        .set('Cookie', invitee.cookie)
        .send({});
      expect(denied.status).toBe(403);
      expect(queueMock.add).not.toHaveBeenCalled();
    });
  });

  /**
   * One Deployment's status and times, which the Cloudgate CLI asks
   * while it follows a Deployment log that never closes by itself. Visible to
   * whoever may read its log, and to no one else.
   */
  describe('GET /deployments/:id', () => {
    it('answers the status and times alone, and the finish once it is done', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const triggered = await deployments.deploy(
        ownerCtx,
        application.applicationId,
      );

      const pending = await request(server)
        .get(`/deployments/${triggered.deploymentId}`)
        .set('Cookie', ownerSession.cookie);
      expect(pending.status).toBe(200);
      expect(pending.body).toEqual({
        deploymentId: triggered.deploymentId,
        status: 'pending',
        createdAt: expect.any(String) as string,
        startedAt: null,
        finishedAt: null,
      });

      await deployments.updateStatus(triggered.deploymentId, 'error');
      const failed = await request(server)
        .get(`/deployments/${triggered.deploymentId}`)
        .set('Cookie', ownerSession.cookie);
      expect(failed.status).toBe(200);
      const body = failed.body as { status: string; finishedAt: string };
      expect(body.status).toBe('error');
      expect(Number.isNaN(Date.parse(body.finishedAt))).toBe(false);
    });

    it('is a 404 for an unknown id and for another Organization’s Deployment', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const triggered = await deployments.deploy(
        ownerCtx,
        application.applicationId,
      );

      const unknown = await request(server)
        .get('/deployments/no-such-deployment')
        .set('Cookie', ownerSession.cookie);
      expect(unknown.status).toBe(404);
      expect((unknown.body as { message: string }).message).toBe(
        'Deployment not found',
      );

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;
      const key = await request(server)
        .post('/users/me/api-keys')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'ci' });
      const elsewhere = await request(server)
        .get(`/deployments/${triggered.deploymentId}`)
        .set('x-api-key', (key.body as { key: string }).key)
        .set('x-organization-id', secondOrgId);
      expect(elsewhere.status).toBe(404);
      expect((elsewhere.body as { message: string }).message).toBe(
        'Deployment not found',
      );
    });

    it('refuses a member without a grant on the Service with 403', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const triggered = await deployments.deploy(
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
        .get(`/deployments/${triggered.deploymentId}`)
        .set('Cookie', invitee.cookie);
      expect(denied.status).toBe(403);
    });
  });

  /**
   * `source_type` defaults to `github`, so an Application or a stack
   * fresh from create claims a GitHub source with no repository behind it. A
   * deploy of one used to be queued and fail at the worker with "has no GitHub
   * provider linked"; it is refused before a record or a job exists, and the
   * refusal names what is missing rather than the provider connection.
   */
  describe('a service with no source', () => {
    it('refuses to deploy or redeploy an Application nobody pointed anywhere', async () => {
      const { ownerSession, application } = await setUpApplication({
        withSource: false,
      });

      for (const route of ['deployments', 'redeploy']) {
        const refused = await request(server)
          .post(`/applications/${application.applicationId}/${route}`)
          .set('Cookie', ownerSession.cookie)
          .send({});
        expect(refused.status).toBe(409);
        const { message } = refused.body as { message: string };
        expect(message).toBe(
          'Application "Web App" cannot be deployed: no source is chosen. Set its source, then deploy',
        );
        expect(message).not.toContain('provider linked');
      }

      expect(queueMock.add).not.toHaveBeenCalled();
      const history = await request(server)
        .get(`/applications/${application.applicationId}/deployments`)
        .set('Cookie', ownerSession.cookie);
      expect(history.body).toEqual([]);
    });

    it('refuses a Compose stack created "From a repository" until one is set, and deploys it once it is', async () => {
      const { ownerSession, ownerCtx, environmentId } =
        await setUpApplication();
      const stack = await ctx.app
        .get(ComposeService)
        .create(ownerCtx, { name: 'ui-repo', environmentId });

      const refused = await request(server)
        .post(`/compose/${stack.composeId}/deployments`)
        .set('Cookie', ownerSession.cookie)
        .send({});
      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        'Compose stack "ui-repo" cannot be deployed: no source is chosen. Set its source, then deploy',
      );
      expect(queueMock.add).not.toHaveBeenCalled();

      await ctx.app.get(ComposeService).update(ownerCtx, stack.composeId, {
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/acme/shop.git',
      });
      const deployed = await request(server)
        .post(`/compose/${stack.composeId}/deployments`)
        .set('Cookie', ownerSession.cookie)
        .send({});
      expect(deployed.status).toBe(201);
      expect(queueMock.add).toHaveBeenCalledTimes(1);
    });
  });
});
