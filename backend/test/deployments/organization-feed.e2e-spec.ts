import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { deployment } from '../../src/deployments/deployment.schema';
import { BackupsService } from '../../src/backups/backups.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { SchedulesService } from '../../src/scheduling/schedules/schedules.service';
import { VolumeBackupsService } from '../../src/volume-backups/volume-backups.service';
import { member } from '../../src/organizations/organizations.schema';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

// every deployment read was keyed by one owner, so an
// organization had no Deployment history at all — a client cannot even fan
// out, because nothing enumerates an Environment's services. GET /deployments
// is that feed: org-scoped through environment → project, newest first.

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

interface FeedRow {
  deploymentId: string;
  status: string;
  createdAt: string;
  owner: { type: string; id: string; name: string };
  project: { projectId: string; name: string } | null;
  environment: { environmentId: string; name: string } | null;
}

describe('Organization deployment feed (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let deployments: DeploymentsService;
  let destinations: DestinationsService;
  let schedules: SchedulesService;
  let volumeBackups: VolumeBackupsService;
  let backups: BackupsService;
  let postgres: PostgresService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    deployments = ctx.app.get(DeploymentsService);
    destinations = ctx.app.get(DestinationsService);
    schedules = ctx.app.get(SchedulesService);
    volumeBackups = ctx.app.get(VolumeBackupsService);
    backups = ctx.app.get(BackupsService);
    postgres = ctx.app.get(PostgresService);
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
  });

  /** An owner acting in a fresh organization, with one project/environment. */
  async function setUpOrganization(projectName = 'cloudgate') {
    const session = await signUp(server, owner);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', session.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(session.id, organizationId);

    const project = await projects.create(ownerCtx, { name: projectName });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    return { session, organizationId, ownerCtx, project, environment };
  }

  const createApplication = (
    ownerCtx: ReturnType<typeof permissionCtx>,
    environmentId: string,
    name: string,
    appName: string,
  ) => applications.create(ownerCtx, { name, appName, environmentId });

  /** A recorded attempt with an explicit timestamp, so ordering assertions
   * never depend on clock resolution. */
  const record = (values: {
    deploymentId: string;
    createdAt: string;
    status?: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
    applicationId?: string;
    composeId?: string;
    scheduleId?: string;
    volumeBackupId?: string;
    backupId?: string;
  }) =>
    ctx.db.insert(deployment).values({
      title: 'Manual deployment',
      description: '',
      status: 'done',
      logPath: `/etc/cloudgate/logs/${values.deploymentId}.log`,
      ...values,
    });

  it("lists the organization's deployments newest first", async () => {
    const { session, ownerCtx, environment } = await setUpOrganization();
    const web = await createApplication(
      ownerCtx,
      environment.environmentId,
      'Web App',
      'web-app',
    );
    const api = await createApplication(
      ownerCtx,
      environment.environmentId,
      'API',
      'api',
    );

    await record({
      deploymentId: 'web-1',
      applicationId: web.applicationId,
      createdAt: '2026-08-05T03:00:00.000Z',
    });
    await record({
      deploymentId: 'api-1',
      applicationId: api.applicationId,
      createdAt: '2026-08-07T03:00:00.000Z',
    });
    await record({
      deploymentId: 'web-2',
      applicationId: web.applicationId,
      createdAt: '2026-08-06T03:00:00.000Z',
    });

    const feed = await request(server)
      .get('/deployments')
      .set('Cookie', session.cookie);

    expect(feed.status).toBe(200);
    const { rows } = feed.body as { rows: FeedRow[] };
    expect(rows.map((row) => row.deploymentId)).toEqual([
      'api-1',
      'web-2',
      'web-1',
    ]);
  });

  describe('cross-organization isolation', () => {
    /** A second organization for the same owner, with a service of its own:
     * a second sign-up in one spec returns 400, so the isolation case
     * travels through POST /organizations (the compose-converted precedent).
     * The owner of both is the strongest form of the property — the feed is
     * scoped by the active organization, not by who the caller is. */
    async function setUpSecondOrganization(cookie: string, userId: string) {
      const created = await createOrganization(server, ctx.db, cookie, {
        name: 'Second Org',
      });
      expect(created.status).toBe(201);
      const organizationId = (created.body as { id: string }).id;
      const secondCtx = permissionCtx(userId, organizationId);

      const secondProject = await projects.create(secondCtx, {
        name: 'other-co',
      });
      const secondEnvironment = await environments.create(secondCtx, {
        name: 'production',
        projectId: secondProject.projectId,
      });
      const theirApp = await createApplication(
        secondCtx,
        secondEnvironment.environmentId,
        'Their App',
        'their-app',
      );
      return { organizationId, secondCtx, theirApp };
    }

    const setActive = async (cookie: string, organizationId: string) => {
      const activated = await request(server)
        .post('/api/auth/organization/set-active')
        .set('Cookie', cookie)
        .send({ organizationId });
      expect(activated.status).toBe(200);
    };

    it("never shows another organization's deployments", async () => {
      const { session, ownerCtx, organizationId, environment } =
        await setUpOrganization();
      const web = await createApplication(
        ownerCtx,
        environment.environmentId,
        'Web App',
        'web-app',
      );
      await record({
        deploymentId: 'our-build',
        applicationId: web.applicationId,
        createdAt: '2026-08-07T03:00:00.000Z',
      });

      const second = await setUpSecondOrganization(
        session.cookie,
        ownerCtx.user.id,
      );
      await record({
        deploymentId: 'their-build',
        applicationId: second.theirApp.applicationId,
        // Newer, so a feed that leaked would leak it into first place.
        createdAt: '2026-08-08T03:00:00.000Z',
      });

      await setActive(session.cookie, organizationId);
      const ourFeed = await request(server)
        .get('/deployments')
        .set('Cookie', session.cookie);
      expect(ourFeed.status).toBe(200);
      expect(
        (ourFeed.body as { rows: FeedRow[] }).rows.map(
          (row) => row.deploymentId,
        ),
      ).toEqual(['our-build']);

      await setActive(session.cookie, second.organizationId);
      const theirFeed = await request(server)
        .get('/deployments')
        .set('Cookie', session.cookie);
      expect(
        (theirFeed.body as { rows: FeedRow[] }).rows.map(
          (row) => row.deploymentId,
        ),
      ).toEqual(['their-build']);

      // …and at the service seam, where the ctx is the only difference.
      const page = await deployments.listByOrganization(second.secondCtx, {
        limit: 20,
      });
      expect(page.rows.map((row) => row.deploymentId)).toEqual(['their-build']);
    });

    it("keeps another organization's runs out of the feed too", async () => {
      const { session, ownerCtx, organizationId } = await setUpOrganization();
      const second = await setUpSecondOrganization(
        session.cookie,
        ownerCtx.user.id,
      );

      // Every owner kind the schema allows, all in the second organization.
      const theirSchedule = await schedules.create(second.secondCtx, {
        name: 'Clear cache',
        cronExpression: '0 3 * * *',
        scheduleType: 'application',
        serviceId: second.theirApp.applicationId,
        shellType: 'bash',
        command: 'rm -rf /tmp/cache',
      });
      const theirDestination = await destinations.create(second.secondCtx, {
        name: 'their-backups',
        provider: 'Cloudflare',
        accessKey: 'AKIAEXAMPLEACCESSKEY',
        secretAccessKey: 'wJalrXUtnFEMI-example-secret-key',
        bucket: 'their-backups',
        region: 'auto',
        endpoint: 'https://accountid.r2.cloudflarestorage.com',
      });
      const theirVolumeBackup = await volumeBackups.create(second.secondCtx, {
        name: 'Nightly volume backup',
        volumeName: 'web-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'application',
        serviceId: second.theirApp.applicationId,
        turnOff: false,
        destinationId: theirDestination.destinationId,
      });
      await record({
        deploymentId: 'their-schedule-run',
        scheduleId: theirSchedule.scheduleId,
        createdAt: '2026-08-08T03:00:00.000Z',
      });
      await record({
        deploymentId: 'their-volume-backup-run',
        volumeBackupId: theirVolumeBackup.volumeBackupId,
        createdAt: '2026-08-08T04:00:00.000Z',
      });

      await setActive(session.cookie, organizationId);
      const feed = await request(server)
        .get('/deployments')
        .set('Cookie', session.cookie);
      expect(feed.status).toBe(200);
      expect((feed.body as { rows: FeedRow[] }).rows).toEqual([]);
    });
  });

  describe('what a row says', () => {
    it('names the deployed service and where it lives', async () => {
      const { session, ownerCtx, project, environment } =
        await setUpOrganization();
      const web = await createApplication(
        ownerCtx,
        environment.environmentId,
        'Web App',
        'web-app',
      );
      await record({
        deploymentId: 'web-1',
        applicationId: web.applicationId,
        createdAt: '2026-08-07T03:00:00.000Z',
      });

      const feed = await request(server)
        .get('/deployments')
        .set('Cookie', session.cookie);

      const [row] = (feed.body as { rows: FeedRow[] }).rows;
      expect(row.owner).toEqual({
        type: 'application',
        id: web.applicationId,
        name: 'Web App',
      });
      expect(row.project).toEqual({
        projectId: project.projectId,
        name: 'cloudgate',
      });
      expect(row.environment).toEqual({
        environmentId: environment.environmentId,
        name: 'production',
      });
    });
  });

  // The three owner kinds with no list route of their own before the fix, and
  // the ones a client-side fan-out over services could never have found.
  describe('runs that belong to no service build', () => {
    it("includes a schedule's runs, named after the schedule", async () => {
      const { session, ownerCtx, project, environment } =
        await setUpOrganization();
      const web = await createApplication(
        ownerCtx,
        environment.environmentId,
        'Web App',
        'web-app',
      );
      const schedule = await schedules.create(ownerCtx, {
        name: 'Clear cache',
        cronExpression: '0 3 * * *',
        scheduleType: 'application',
        serviceId: web.applicationId,
        shellType: 'bash',
        command: 'rm -rf /tmp/cache',
      });
      await record({
        deploymentId: 'schedule-run',
        scheduleId: schedule.scheduleId,
        createdAt: '2026-08-07T03:00:00.000Z',
      });

      const feed = await request(server)
        .get('/deployments')
        .set('Cookie', session.cookie);

      const [row] = (feed.body as { rows: FeedRow[] }).rows;
      expect(row.deploymentId).toBe('schedule-run');
      expect(row.owner).toEqual({
        type: 'schedule',
        id: schedule.scheduleId,
        name: 'Clear cache',
      });
      // A container schedule hangs off a service, so it places on the feed.
      expect(row.project).toEqual({
        projectId: project.projectId,
        name: 'cloudgate',
      });
      expect(row.environment).toEqual({
        environmentId: environment.environmentId,
        name: 'production',
      });
    });

    it("includes a volume backup's and a database backup's runs", async () => {
      const { session, ownerCtx, environment } = await setUpOrganization();
      const web = await createApplication(
        ownerCtx,
        environment.environmentId,
        'Web App',
        'web-app',
      );
      const destination = await destinations.create(ownerCtx, {
        name: 'prod-backups',
        provider: 'Cloudflare',
        accessKey: 'AKIAEXAMPLEACCESSKEY',
        secretAccessKey: 'wJalrXUtnFEMI-example-secret-key',
        bucket: 'cloudgate-backups',
        region: 'auto',
        endpoint: 'https://accountid.r2.cloudflarestorage.com',
      });
      const volumeBackup = await volumeBackups.create(ownerCtx, {
        name: 'Nightly volume backup',
        volumeName: 'web-data',
        prefix: 'daily',
        schedule: '0 3 * * *',
        serviceType: 'application',
        serviceId: web.applicationId,
        turnOff: false,
        destinationId: destination.destinationId,
      });
      const database = await postgres.create(ownerCtx, {
        name: 'Main DB',
        appName: 'main-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
      });
      const databaseBackup = await backups.create(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        backupType: 'database',
        databaseType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });

      await record({
        deploymentId: 'volume-backup-run',
        volumeBackupId: volumeBackup.volumeBackupId,
        createdAt: '2026-08-07T03:00:00.000Z',
      });
      await record({
        deploymentId: 'database-backup-run',
        backupId: databaseBackup.backupId,
        createdAt: '2026-08-07T04:00:00.000Z',
      });

      const feed = await request(server)
        .get('/deployments')
        .set('Cookie', session.cookie);

      const { rows } = feed.body as { rows: FeedRow[] };
      expect(rows.map((row) => row.deploymentId)).toEqual([
        'database-backup-run',
        'volume-backup-run',
      ]);
      expect(rows.map((row) => row.owner.type)).toEqual([
        'backup',
        'volumeBackup',
      ]);
      expect(rows[1].owner).toEqual({
        type: 'volumeBackup',
        id: volumeBackup.volumeBackupId,
        name: 'Nightly volume backup',
      });
      // A database backup has no name of its own; its appName is what the
      // backup screens show, and the row it hangs off is the database.
      expect(rows[0].owner.id).toBe(databaseBackup.backupId);
      expect(rows[0].owner.name).toBe(databaseBackup.appName);
      expect(rows[0].environment).toEqual({
        environmentId: environment.environmentId,
        name: 'production',
      });
    });

    it("includes a host schedule's runs, which belong to no project", async () => {
      const { session, ownerCtx } = await setUpOrganization();
      const schedule = await schedules.create(ownerCtx, {
        name: 'Host cleanup',
        cronExpression: '0 4 * * *',
        scheduleType: 'cloudgate-server',
        shellType: 'bash',
        command: '',
        script: 'docker system prune -f',
      });
      await record({
        deploymentId: 'host-run',
        scheduleId: schedule.scheduleId,
        createdAt: '2026-08-07T03:00:00.000Z',
      });

      const feed = await request(server)
        .get('/deployments')
        .set('Cookie', session.cookie);

      const [row] = (feed.body as { rows: FeedRow[] }).rows;
      expect(row.deploymentId).toBe('host-run');
      expect(row.owner).toEqual({
        type: 'schedule',
        id: schedule.scheduleId,
        name: 'Host cleanup',
      });
      // The cloudgate host has no service row, so there is no project or
      // environment to name — the feed says so rather than inventing one.
      expect(row.project).toBeNull();
      expect(row.environment).toBeNull();
    });
  });

  describe('paging', () => {
    /** Five attempts of one application, oldest first. */
    async function fiveDeployments() {
      const set = await setUpOrganization();
      const web = await createApplication(
        set.ownerCtx,
        set.environment.environmentId,
        'Web App',
        'web-app',
      );
      for (const [index, createdAt] of [
        '2026-08-03T03:00:00.000Z',
        '2026-08-04T03:00:00.000Z',
        '2026-08-05T03:00:00.000Z',
        '2026-08-06T03:00:00.000Z',
        '2026-08-07T03:00:00.000Z',
      ].entries()) {
        await record({
          deploymentId: `build-${index}`,
          applicationId: web.applicationId,
          createdAt,
        });
      }
      return set;
    }

    const page = (cookie: string, query: Record<string, string | number>) =>
      request(server).get('/deployments').query(query).set('Cookie', cookie);

    it('walks the whole history a page at a time', async () => {
      const { session } = await fiveDeployments();

      const first = await page(session.cookie, { limit: 2 });
      expect(first.status).toBe(200);
      const firstPage = first.body as {
        rows: FeedRow[];
        nextCursor: string | null;
      };
      expect(firstPage.rows.map((row) => row.deploymentId)).toEqual([
        'build-4',
        'build-3',
      ]);
      expect(firstPage.nextCursor).toEqual(expect.any(String));

      const second = await page(session.cookie, {
        limit: 2,
        cursor: firstPage.nextCursor as string,
      });
      const secondPage = second.body as {
        rows: FeedRow[];
        nextCursor: string | null;
      };
      expect(secondPage.rows.map((row) => row.deploymentId)).toEqual([
        'build-2',
        'build-1',
      ]);

      const third = await page(session.cookie, {
        limit: 2,
        cursor: secondPage.nextCursor as string,
      });
      const lastPage = third.body as {
        rows: FeedRow[];
        nextCursor: string | null;
      };
      expect(lastPage.rows.map((row) => row.deploymentId)).toEqual(['build-0']);
      // Nothing left, so the client stops rather than looping on an empty page.
      expect(lastPage.nextCursor).toBeNull();
    });

    it('says there is no next page when the last row is the last row', async () => {
      const { session } = await fiveDeployments();

      const only = await page(session.cookie, { limit: 5 });
      expect((only.body as { rows: FeedRow[] }).rows).toHaveLength(5);
      expect(
        (only.body as { nextCursor: string | null }).nextCursor,
      ).toBeNull();
    });

    it('separates deployments recorded in the same instant', async () => {
      const { session, ownerCtx, environment } = await setUpOrganization();
      const web = await createApplication(
        ownerCtx,
        environment.environmentId,
        'Web App',
        'web-app',
      );
      // Two attempts sharing a createdAt: a cursor on the timestamp alone
      // would either repeat one or skip one.
      for (const deploymentId of ['build-a', 'build-b']) {
        await record({
          deploymentId,
          applicationId: web.applicationId,
          createdAt: '2026-08-07T03:00:00.000Z',
        });
      }

      const first = await page(session.cookie, { limit: 1 });
      const firstPage = first.body as {
        rows: FeedRow[];
        nextCursor: string | null;
      };
      const second = await page(session.cookie, {
        limit: 1,
        cursor: firstPage.nextCursor as string,
      });
      const secondPage = second.body as { rows: FeedRow[] };

      expect([
        firstPage.rows[0].deploymentId,
        secondPage.rows[0].deploymentId,
      ]).toEqual(expect.arrayContaining(['build-a', 'build-b']));
      expect(firstPage.rows[0].deploymentId).not.toBe(
        secondPage.rows[0].deploymentId,
      );
    });

    // The cursor is opaque on purpose: handing back a deployment id would
    // make the feed an existence oracle for ids in other organizations.
    it('refuses a cursor it did not issue', async () => {
      const { session } = await fiveDeployments();

      const bad = await page(session.cookie, {
        limit: 2,
        cursor: 'no-such-deployment',
      });
      expect(bad.status).toBe(400);
    });
  });

  describe('filters', () => {
    it('narrows the feed to one status', async () => {
      const { session, ownerCtx, environment } = await setUpOrganization();
      const web = await createApplication(
        ownerCtx,
        environment.environmentId,
        'Web App',
        'web-app',
      );
      await record({
        deploymentId: 'failed-build',
        applicationId: web.applicationId,
        status: 'error',
        createdAt: '2026-08-06T03:00:00.000Z',
      });
      await record({
        deploymentId: 'good-build',
        applicationId: web.applicationId,
        status: 'done',
        createdAt: '2026-08-07T03:00:00.000Z',
      });

      const failed = await request(server)
        .get('/deployments')
        .query({ status: 'error' })
        .set('Cookie', session.cookie);

      expect(failed.status).toBe(200);
      expect(
        (failed.body as { rows: FeedRow[] }).rows.map(
          (row) => row.deploymentId,
        ),
      ).toEqual(['failed-build']);
    });

    it('narrows the feed to one project', async () => {
      const { session, ownerCtx, project, environment } =
        await setUpOrganization();
      const web = await createApplication(
        ownerCtx,
        environment.environmentId,
        'Web App',
        'web-app',
      );
      const otherProject = await projects.create(ownerCtx, {
        name: 'internal',
      });
      const otherEnvironment = await environments.create(ownerCtx, {
        name: 'staging',
        projectId: otherProject.projectId,
      });
      const tool = await createApplication(
        ownerCtx,
        otherEnvironment.environmentId,
        'Admin Tool',
        'admin-tool',
      );
      await record({
        deploymentId: 'web-build',
        applicationId: web.applicationId,
        createdAt: '2026-08-06T03:00:00.000Z',
      });
      await record({
        deploymentId: 'tool-build',
        applicationId: tool.applicationId,
        createdAt: '2026-08-07T03:00:00.000Z',
      });

      const scoped = await request(server)
        .get('/deployments')
        .query({ projectId: project.projectId })
        .set('Cookie', session.cookie);

      expect(scoped.status).toBe(200);
      expect(
        (scoped.body as { rows: FeedRow[] }).rows.map(
          (row) => row.deploymentId,
        ),
      ).toEqual(['web-build']);
    });
  });

  // The per-owner routes gate every read on checkServiceAccess, so a feed
  // that skipped the row-level check would hand a restricted member exactly
  // the history those routes refuse them.
  describe('a member with row-level access to some services', () => {
    /** Invites a user into the owner's organization and accepts as them. */
    async function inviteMember(ownerCookie: string, email: string) {
      const invite = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', ownerCookie)
        .send({ email, role: 'member' });
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

    it('sees the history of those services and no others', async () => {
      const { session, ownerCtx, environment } = await setUpOrganization();
      const web = await createApplication(
        ownerCtx,
        environment.environmentId,
        'Web App',
        'web-app',
      );
      const secrets = await createApplication(
        ownerCtx,
        environment.environmentId,
        'Payroll',
        'payroll',
      );
      await record({
        deploymentId: 'web-build',
        applicationId: web.applicationId,
        createdAt: '2026-08-06T03:00:00.000Z',
      });
      await record({
        deploymentId: 'payroll-build',
        applicationId: secrets.applicationId,
        createdAt: '2026-08-07T03:00:00.000Z',
      });

      const ida = await inviteMember(session.cookie, 'ida@example.com');
      await ctx.db
        .update(member)
        .set({ accessedServices: [web.applicationId] })
        .where(eq(member.userId, ida.id));

      const feed = await request(server)
        .get('/deployments')
        .set('Cookie', ida.cookie);

      expect(feed.status).toBe(200);
      expect(
        (feed.body as { rows: FeedRow[] }).rows.map((row) => row.deploymentId),
      ).toEqual(['web-build']);
    });

    it('sees no runs of the services it was not granted', async () => {
      const { session, ownerCtx, environment } = await setUpOrganization();
      const secrets = await createApplication(
        ownerCtx,
        environment.environmentId,
        'Payroll',
        'payroll',
      );
      const schedule = await schedules.create(ownerCtx, {
        name: 'Rotate secrets',
        cronExpression: '0 3 * * *',
        scheduleType: 'application',
        serviceId: secrets.applicationId,
        shellType: 'bash',
        command: 'rotate',
      });
      const hostSchedule = await schedules.create(ownerCtx, {
        name: 'Host cleanup',
        cronExpression: '0 4 * * *',
        scheduleType: 'cloudgate-server',
        shellType: 'bash',
        command: '',
        script: 'docker system prune -f',
      });
      await record({
        deploymentId: 'secrets-run',
        scheduleId: schedule.scheduleId,
        createdAt: '2026-08-07T03:00:00.000Z',
      });
      await record({
        deploymentId: 'host-run',
        scheduleId: hostSchedule.scheduleId,
        createdAt: '2026-08-07T04:00:00.000Z',
      });

      const ida = await inviteMember(session.cookie, 'ida@example.com');

      const feed = await request(server)
        .get('/deployments')
        .set('Cookie', ida.cookie);

      // Nothing granted, so nothing to see — including the host schedule's
      // run, which SchedulesService gates to owners and admins.
      expect(feed.status).toBe(200);
      expect((feed.body as { rows: FeedRow[] }).rows).toEqual([]);
    });
  });
});
