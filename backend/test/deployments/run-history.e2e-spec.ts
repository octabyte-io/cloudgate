import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { BackupsService } from '../../src/backups/backups.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { deployment } from '../../src/deployments/deployment.schema';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { SchedulesService } from '../../src/scheduling/schedules/schedules.service';
import { server as serverTable } from '../../src/servers/server.schema';
import { VolumeBackupsService } from '../../src/volume-backups/volume-backups.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

// a schedule's runs and a volume backup's runs are recorded as
// deployment rows (BackupRunRecorderService), but until now the only list
// routes were keyed by application or compose — so the outcome of last
// night's 03:00 cron run had no read at all. These are the two missing
// halves, org-scoped through each module's own read path.

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

describe('Run history of schedules and volume backups (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let destinations: DestinationsService;
  let schedules: SchedulesService;
  let volumeBackups: VolumeBackupsService;
  let backups: BackupsService;
  let postgres: PostgresService;
  let deployments: DeploymentsService;
  let scheduling: SchedulingService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    scheduling = ctx.app.get(SchedulingService);
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    destinations = ctx.app.get(DestinationsService);
    schedules = ctx.app.get(SchedulesService);
    volumeBackups = ctx.app.get(VolumeBackupsService);
    backups = ctx.app.get(BackupsService);
    postgres = ctx.app.get(PostgresService);
    deployments = ctx.app.get(DeploymentsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    // Cron jobs registered by a previous test would leak across resets.
    for (const id of scheduling.ids()) {
      scheduling.unregister(id);
    }
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  /** An owner ctx plus an application to hang schedules and volume backups
   * off, and a destination for the backups to upload to. */
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
    const application = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'web-app',
      environmentId: environment.environmentId,
    });
    const destination = await destinations.create(ownerCtx, {
      name: 'prod-backups',
      provider: 'Cloudflare',
      accessKey: 'AKIAEXAMPLEACCESSKEY',
      secretAccessKey: 'wJalrXUtnFEMI-example-secret-key',
      bucket: 'cloudgate-backups',
      region: 'auto',
      endpoint: 'https://accountid.r2.cloudflarestorage.com',
    });
    return {
      organizationId,
      ownerSession,
      ownerCtx,
      environment,
      application,
      destination,
    };
  }

  const createSchedule = (
    ownerCtx: ReturnType<typeof permissionCtx>,
    application: { applicationId: string },
  ) =>
    schedules.create(ownerCtx, {
      name: 'Clear cache',
      cronExpression: '0 3 * * *',
      scheduleType: 'application',
      serviceId: application.applicationId,
      shellType: 'bash',
      command: 'rm -rf /tmp/cache',
    });

  const createVolumeBackup = (
    ownerCtx: ReturnType<typeof permissionCtx>,
    application: { applicationId: string },
    destination: { destinationId: string },
  ) =>
    volumeBackups.create(ownerCtx, {
      name: 'Nightly volume backup',
      volumeName: 'web-data',
      prefix: 'daily',
      schedule: '0 3 * * *',
      serviceType: 'application',
      serviceId: application.applicationId,
      turnOff: false,
      destinationId: destination.destinationId,
    });

  describe("a schedule's runs", () => {
    it('reads back the outcome of a run over HTTP', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const schedule = await createSchedule(ownerCtx, application);

      await schedules.runManual(ownerCtx, schedule.scheduleId);

      const history = await request(server)
        .get(`/schedules/${schedule.scheduleId}/deployments`)
        .set('Cookie', ownerSession.cookie);
      expect(history.status).toBe(200);
      expect(history.body).toHaveLength(1);
      const [run] = history.body as {
        scheduleId: string;
        applicationId: string | null;
        volumeBackupId: string | null;
        title: string;
        status: string;
        logPath: string;
        startedAt: string | null;
        finishedAt: string | null;
      }[];
      expect(run).toMatchObject({
        scheduleId: schedule.scheduleId,
        title: 'Schedule',
        status: 'done',
      });
      // The invariant the schema documents: only the schedule FK is set.
      expect(run.applicationId).toBeNull();
      expect(run.volumeBackupId).toBeNull();
      // The log file the run wrote is readable by deployment id.
      expect(run.logPath).toContain(`/${schedule.appName}/`);
      expect(run.finishedAt).toEqual(expect.any(String));
    });

    it('records a failed run as an error the history reports', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const schedule = await createSchedule(ownerCtx, application);

      execMock.execAsync
        .mockReset()
        // Log-file initialization succeeds…
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        // …the command itself fails.
        .mockRejectedValueOnce(new Error('container not found'));
      await expect(
        schedules.runManual(ownerCtx, schedule.scheduleId),
      ).rejects.toThrow('container not found');

      const history = await request(server)
        .get(`/schedules/${schedule.scheduleId}/deployments`)
        .set('Cookie', ownerSession.cookie);
      expect(history.status).toBe(200);
      expect((history.body as { status: string }[])[0].status).toBe('error');
    });

    it('lists runs newest-first', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const schedule = await createSchedule(ownerCtx, application);

      // Recorded runs, oldest first — inserted with explicit timestamps so
      // the ordering assertion cannot depend on clock resolution.
      for (const [index, createdAt] of [
        '2026-08-05T03:00:00.000Z',
        '2026-08-06T03:00:00.000Z',
        '2026-08-07T03:00:00.000Z',
      ].entries()) {
        await ctx.db.insert(deployment).values({
          deploymentId: `run-${index}`,
          scheduleId: schedule.scheduleId,
          title: 'Schedule',
          description: 'Schedule',
          status: 'done',
          logPath: `/etc/cloudgate/logs/${schedule.appName}/run-${index}.log`,
          createdAt,
        });
      }

      const history = await request(server)
        .get(`/schedules/${schedule.scheduleId}/deployments`)
        .set('Cookie', ownerSession.cookie);
      expect(
        (history.body as { deploymentId: string }[]).map(
          (row) => row.deploymentId,
        ),
      ).toEqual(['run-2', 'run-1', 'run-0']);
    });

    it("keeps the owning application's own deployments out of the list", async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const schedule = await createSchedule(ownerCtx, application);

      const build = await deployments.create({
        kind: 'application',
        applicationId: application.applicationId,
        title: 'Manual deployment',
        description: '',
      });
      await schedules.runManual(ownerCtx, schedule.scheduleId);

      const scheduleHistory = await request(server)
        .get(`/schedules/${schedule.scheduleId}/deployments`)
        .set('Cookie', ownerSession.cookie);
      expect(
        (scheduleHistory.body as { deploymentId: string }[]).map(
          (row) => row.deploymentId,
        ),
      ).not.toContain(build.deploymentId);
      expect(scheduleHistory.body).toHaveLength(1);

      // …and the application route is unchanged by the schedule's run.
      const buildHistory = await request(server)
        .get(`/applications/${application.applicationId}/deployments`)
        .set('Cookie', ownerSession.cookie);
      expect(
        (buildHistory.body as { deploymentId: string }[]).map(
          (row) => row.deploymentId,
        ),
      ).toEqual([build.deploymentId]);
    });

    it('is a 404 for an unknown schedule', async () => {
      const { ownerSession } = await setUpApplication();

      const missing = await request(server)
        .get('/schedules/no-such-schedule/deployments')
        .set('Cookie', ownerSession.cookie);
      expect(missing.status).toBe(404);
      expect((missing.body as { message: string }).message).toBe(
        'Schedule not found',
      );
    });

    it('reads as absent outside the owning organization', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const schedule = await createSchedule(ownerCtx, application);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      // Same user, acting in the second organization: the schedule from the
      // first organization must not resolve, even for its creator.
      await expect(
        deployments.findAllByScheduleId(secondOrgCtx, schedule.scheduleId),
      ).rejects.toThrow(NotFoundException);
    });

    it('denies a member without row access to the owning service', async () => {
      const { organizationId, ownerSession, ownerCtx, application } =
        await setUpApplication();
      const schedule = await createSchedule(ownerCtx, application);
      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );

      await expect(
        deployments.findAllByScheduleId(
          permissionCtx(member.id, organizationId),
          schedule.scheduleId,
        ),
      ).rejects.toThrow(ForbiddenException);

      const denied = await request(server)
        .get(`/schedules/${schedule.scheduleId}/deployments`)
        .set('Cookie', member.cookie);
      expect(denied.status).toBe(403);
    });
  });

  describe("a volume backup's runs", () => {
    it('reads back the outcome of a run over HTTP', async () => {
      const { ownerSession, ownerCtx, application, destination } =
        await setUpApplication();
      const backup = await createVolumeBackup(
        ownerCtx,
        application,
        destination,
      );

      await volumeBackups.runManual(ownerCtx, backup.volumeBackupId);

      const history = await request(server)
        .get(`/volume-backups/${backup.volumeBackupId}/deployments`)
        .set('Cookie', ownerSession.cookie);
      expect(history.status).toBe(200);
      expect(history.body).toHaveLength(1);
      const [run] = history.body as {
        volumeBackupId: string;
        applicationId: string | null;
        scheduleId: string | null;
        title: string;
        status: string;
        logPath: string;
        finishedAt: string | null;
      }[];
      expect(run).toMatchObject({
        volumeBackupId: backup.volumeBackupId,
        title: 'Volume Backup',
        status: 'done',
      });
      expect(run.applicationId).toBeNull();
      expect(run.scheduleId).toBeNull();
      expect(run.logPath).toContain(`/${backup.appName}/`);
      expect(run.finishedAt).toEqual(expect.any(String));
    });

    it('surfaces a silently failing backup as an error run', async () => {
      const { ownerSession, ownerCtx, application, destination } =
        await setUpApplication();
      const backup = await createVolumeBackup(
        ownerCtx,
        application,
        destination,
      );

      execMock.execAsync
        .mockReset()
        // Log-file initialization succeeds…
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
        // …the tar/rclone script fails, and the cleanup after it succeeds.
        .mockRejectedValueOnce(new Error('no space left on device'))
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      await expect(
        volumeBackups.runManual(ownerCtx, backup.volumeBackupId),
      ).rejects.toThrow('no space left on device');

      const history = await request(server)
        .get(`/volume-backups/${backup.volumeBackupId}/deployments`)
        .set('Cookie', ownerSession.cookie);
      expect(history.status).toBe(200);
      expect((history.body as { status: string }[])[0].status).toBe('error');
    });

    it('is a 404 for an unknown volume backup', async () => {
      const { ownerSession } = await setUpApplication();

      const missing = await request(server)
        .get('/volume-backups/no-such-backup/deployments')
        .set('Cookie', ownerSession.cookie);
      expect(missing.status).toBe(404);
      expect((missing.body as { message: string }).message).toBe(
        'Volume backup not found',
      );
    });

    it('reads as absent outside the owning organization', async () => {
      const { ownerSession, ownerCtx, application, destination } =
        await setUpApplication();
      const backup = await createVolumeBackup(
        ownerCtx,
        application,
        destination,
      );

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      await expect(
        deployments.findAllByVolumeBackupId(
          secondOrgCtx,
          backup.volumeBackupId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('denies a member without row access to the owning service', async () => {
      const {
        organizationId,
        ownerSession,
        ownerCtx,
        application,
        destination,
      } = await setUpApplication();
      const backup = await createVolumeBackup(
        ownerCtx,
        application,
        destination,
      );
      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );

      await expect(
        deployments.findAllByVolumeBackupId(
          permissionCtx(member.id, organizationId),
          backup.volumeBackupId,
        ),
      ).rejects.toThrow(ForbiddenException);

      const denied = await request(server)
        .get(`/volume-backups/${backup.volumeBackupId}/deployments`)
        .set('Cookie', member.cookie);
      expect(denied.status).toBe(403);
    });
  });

  // the lists above hand out deployment ids whose logs
  // GET /deployments/:deploymentId/logs refused — it resolved ownership as
  // applicationId ?? composeId, and a run row has neither. Ownership now
  // resolves through the same module read path each list uses.
  describe("a run's logs", () => {
    /** The single run recorded for `owner`, by deployment id. */
    async function onlyRunOf(
      ownerCtx: ReturnType<typeof permissionCtx>,
      list: (
        ctx: ReturnType<typeof permissionCtx>,
      ) => Promise<{ deploymentId: string; logPath: string }[]>,
    ) {
      const rows = await list(ownerCtx);
      expect(rows).toHaveLength(1);
      return rows[0];
    }

    it("reads a schedule run's log by deployment id over HTTP", async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const schedule = await createSchedule(ownerCtx, application);
      await schedules.runManual(ownerCtx, schedule.scheduleId);
      const run = await onlyRunOf(ownerCtx, (c) =>
        deployments.findAllByScheduleId(c, schedule.scheduleId),
      );

      execMock.execAsync.mockResolvedValue({
        stdout: 'Initializing schedule run\ncache cleared',
        stderr: '',
      });
      const logs = await request(server)
        .get(`/deployments/${run.deploymentId}/logs`)
        .query({ tail: 25 })
        .set('Cookie', ownerSession.cookie);

      expect(logs.status).toBe(200);
      expect(logs.text).toBe('Initializing schedule run\ncache cleared');
      const [tailCommand] = execMock.execAsync.mock.lastCall as [string];
      expect(tailCommand).toContain('tail -n 25');
      expect(tailCommand).toContain(run.logPath);
    });

    it("reads a volume backup run's log by deployment id over HTTP", async () => {
      const { ownerSession, ownerCtx, application, destination } =
        await setUpApplication();
      const backup = await createVolumeBackup(
        ownerCtx,
        application,
        destination,
      );
      await volumeBackups.runManual(ownerCtx, backup.volumeBackupId);
      const run = await onlyRunOf(ownerCtx, (c) =>
        deployments.findAllByVolumeBackupId(c, backup.volumeBackupId),
      );

      execMock.execAsync.mockResolvedValue({
        stdout: 'Initializing volume backup\nno space left on device',
        stderr: '',
      });
      const logs = await request(server)
        .get(`/deployments/${run.deploymentId}/logs`)
        .query({ tail: 25 })
        .set('Cookie', ownerSession.cookie);

      expect(logs.status).toBe(200);
      expect(logs.text).toBe(
        'Initializing volume backup\nno space left on device',
      );
      const [tailCommand] = execMock.execAsync.mock.lastCall as [string];
      expect(tailCommand).toContain(run.logPath);
    });

    it("reads a database backup run's log by deployment id over HTTP", async () => {
      const { ownerSession, ownerCtx, environment, destination } =
        await setUpApplication();
      const database = await postgres.create(ownerCtx, {
        name: 'Main DB',
        appName: 'main-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
      });
      const backup = await backups.create(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        backupType: 'database',
        databaseType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });
      await backups.runManual(ownerCtx, backup.backupId);

      const [run] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.backupId, backup.backupId));
      execMock.execAsync.mockResolvedValue({
        stdout: 'Initializing backup\npg_dump: error: connection refused',
        stderr: '',
      });
      const logs = await request(server)
        .get(`/deployments/${run.deploymentId}/logs`)
        .query({ tail: 25 })
        .set('Cookie', ownerSession.cookie);

      expect(logs.status).toBe(200);
      expect(logs.text).toBe(
        'Initializing backup\npg_dump: error: connection refused',
      );
      const [tailCommand] = execMock.execAsync.mock.lastCall as [string];
      expect(tailCommand).toContain(run.logPath);
    });

    /** A remote server to hang a server schedule off. */
    async function createServer(organizationId: string) {
      const [row] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'worker-1',
          ipAddress: '203.0.113.10',
          port: 22,
          organizationId,
        })
        .returning();
      return row;
    }

    it("tails a server schedule's run log on the server it ran on", async () => {
      const { organizationId, ownerSession, ownerCtx } =
        await setUpApplication();
      const remote = await createServer(organizationId);
      const schedule = await schedules.create(ownerCtx, {
        name: 'Update packages',
        cronExpression: '0 6 * * *',
        scheduleType: 'server',
        serviceId: remote.serverId,
        shellType: 'bash',
        command: '',
        script: 'apt update',
      });
      await schedules.runManual(ownerCtx, schedule.scheduleId);
      const run = await onlyRunOf(ownerCtx, (c) =>
        deployments.findAllByScheduleId(c, schedule.scheduleId),
      );

      execMock.execAsyncRemote.mockResolvedValue({
        stdout: 'Initializing schedule run\n42 packages upgraded',
        stderr: '',
      });
      const logs = await request(server)
        .get(`/deployments/${run.deploymentId}/logs`)
        .query({ tail: 25 })
        .set('Cookie', ownerSession.cookie);

      expect(logs.status).toBe(200);
      expect(logs.text).toBe('Initializing schedule run\n42 packages upgraded');
      // The log lives on the schedule's own server, not the cloudgate host.
      const [serverId, tailCommand] = execMock.execAsyncRemote.mock
        .lastCall as [string, string];
      expect(serverId).toBe(remote.serverId);
      expect(tailCommand).toContain(run.logPath);
    });

    it("gates a server schedule's run log to owners and admins", async () => {
      const { organizationId, ownerSession, ownerCtx } =
        await setUpApplication();
      const remote = await createServer(organizationId);
      const schedule = await schedules.create(ownerCtx, {
        name: 'Update packages',
        cronExpression: '0 6 * * *',
        scheduleType: 'server',
        serviceId: remote.serverId,
        shellType: 'bash',
        command: '',
        script: 'apt update',
      });
      await schedules.runManual(ownerCtx, schedule.scheduleId);
      const run = await onlyRunOf(ownerCtx, (c) =>
        deployments.findAllByScheduleId(c, schedule.scheduleId),
      );

      // A server schedule has no owning service, so there is no environment →
      // project organization join to authorize through; SchedulesService gates
      // those on the member's role, and the log read inherits that gate.
      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );
      const denied = await request(server)
        .get(`/deployments/${run.deploymentId}/logs`)
        .set('Cookie', member.cookie);
      expect(denied.status).toBe(403);

      const admin = await inviteUser(
        server,
        ownerSession.cookie,
        'ada@example.com',
        'admin',
      );
      const allowed = await request(server)
        .get(`/deployments/${run.deploymentId}/logs`)
        .set('Cookie', admin.cookie);
      expect(allowed.status).toBe(200);
    });

    it("tails a host schedule's run log on the cloudgate host", async () => {
      const { ownerSession, ownerCtx } = await setUpApplication();
      const schedule = await schedules.create(ownerCtx, {
        name: 'Host cleanup',
        cronExpression: '0 4 * * *',
        scheduleType: 'cloudgate-server',
        shellType: 'bash',
        command: '',
        script: 'docker system prune -f',
      });
      await schedules.runManual(ownerCtx, schedule.scheduleId);
      const run = await onlyRunOf(ownerCtx, (c) =>
        deployments.findAllByScheduleId(c, schedule.scheduleId),
      );

      execMock.execAsync.mockResolvedValue({
        stdout: 'Initializing schedule run\nTotal reclaimed space: 1.2GB',
        stderr: '',
      });
      const logs = await request(server)
        .get(`/deployments/${run.deploymentId}/logs`)
        .set('Cookie', ownerSession.cookie);

      expect(logs.status).toBe(200);
      expect(logs.text).toBe(
        'Initializing schedule run\nTotal reclaimed space: 1.2GB',
      );
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    });

    it("reads a run's log as absent outside the owning organization", async () => {
      const { ownerSession, ownerCtx, application, destination } =
        await setUpApplication();
      const schedule = await createSchedule(ownerCtx, application);
      await schedules.runManual(ownerCtx, schedule.scheduleId);
      const scheduleRun = await onlyRunOf(ownerCtx, (c) =>
        deployments.findAllByScheduleId(c, schedule.scheduleId),
      );
      const backup = await createVolumeBackup(
        ownerCtx,
        application,
        destination,
      );
      await volumeBackups.runManual(ownerCtx, backup.volumeBackupId);
      const backupRun = await onlyRunOf(ownerCtx, (c) =>
        deployments.findAllByVolumeBackupId(c, backup.volumeBackupId),
      );

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      await expect(
        deployments.readLogs(secondOrgCtx, scheduleRun.deploymentId, 100),
      ).rejects.toThrow(NotFoundException);
      await expect(
        deployments.readLogs(secondOrgCtx, backupRun.deploymentId, 100),
      ).rejects.toThrow(NotFoundException);
    });

    it("denies a member without row access to the run's owning service", async () => {
      const { organizationId, ownerSession, ownerCtx, application } =
        await setUpApplication();
      const schedule = await createSchedule(ownerCtx, application);
      await schedules.runManual(ownerCtx, schedule.scheduleId);
      const run = await onlyRunOf(ownerCtx, (c) =>
        deployments.findAllByScheduleId(c, schedule.scheduleId),
      );
      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );

      await expect(
        deployments.readLogs(
          permissionCtx(member.id, organizationId),
          run.deploymentId,
          100,
        ),
      ).rejects.toThrow(ForbiddenException);

      const denied = await request(server)
        .get(`/deployments/${run.deploymentId}/logs`)
        .set('Cookie', member.cookie);
      expect(denied.status).toBe(403);
    });

    it('is still a 404 for a deployment row that owns nothing', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const schedule = await createSchedule(ownerCtx, application);
      await ctx.db.insert(deployment).values({
        deploymentId: 'orphan-run',
        title: 'Schedule',
        description: 'Schedule',
        status: 'done',
        logPath: `/etc/cloudgate/logs/${schedule.appName}/orphan-run.log`,
      });

      const missing = await request(server)
        .get('/deployments/orphan-run/logs')
        .set('Cookie', ownerSession.cookie);
      expect(missing.status).toBe(404);
      expect((missing.body as { message: string }).message).toBe(
        'Deployment not found',
      );
    });
  });
});
