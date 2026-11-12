import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { application as applicationTable } from '../../src/applications/application.schema';
import { ApplicationsService } from '../../src/applications/applications.service';
import { BackupsService } from '../../src/backups/backups.service';
import { ComposeService } from '../../src/compose/compose.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type { QueuedJob } from '../../src/deployment-queue/queue.port';
import { deployment } from '../../src/deployments/deployment.schema';
import type { Deployment } from '../../src/deployments/deployment.schema';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { SchedulesService } from '../../src/scheduling/schedules/schedules.service';
import { VolumeBackupsService } from '../../src/volume-backups/volume-backups.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(180_000);

/**
 * A Deployment id outside the caller's active Organization answers
 * exactly as an id that never existed does — the enumeration oracle ADR-0013
 * closed for containers, here on the HTTP routes addressed by
 * Deployment id.
 *
 * Two halves. The **enumeration** reads every controller in `src` and asserts
 * the routes carrying `:deploymentId` are exactly the keys of {@link ROUTES},
 * so a new one goes red by name until it is added here. The **behaviour**
 * half sends every route every parent kind of foreign Deployment, as Org B's
 * owner, admin and a member with no grants, and asserts status and body match
 * a never-existed id's.
 */

const srcRoot = join(__dirname, '..', '..', 'src');

/** Every route in a Deployment-id-addressed shape, as `VERB path`. */
const ROUTES: Record<string, (server: App, id: string) => request.Test> = {
  // One Deployment's status and times, which `cloudgate deploy` asks
  // while it follows a build; gated as the log is.
  'GET deployments/:deploymentId': (server, id) =>
    request(server).get(`/deployments/${id}`),
  'GET deployments/:deploymentId/logs': (server, id) =>
    request(server).get(`/deployments/${id}/logs`),
  // "Build now with saved settings" on a build held for a plan.
  'POST deployments/:deploymentId/build-now': (server, id) =>
    request(server).post(`/deployments/${id}/build-now`),
  'POST deployments/:deploymentId/cancel': (server, id) =>
    request(server).post(`/deployments/${id}/cancel`),
  // Stop the run, on a Cloud run past the point Cancel refuses.
  'POST deployments/:deploymentId/stop-run': (server, id) =>
    request(server).post(`/deployments/${id}/stop-run`),
};

function controllers(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...controllers(full));
    else if (entry.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

/** `VERB path` for every handler in `src` whose path names `:deploymentId`,
 * joined onto its controller's prefix. */
function deploymentIdRoutes(): string[] {
  const found: string[] = [];
  for (const file of controllers(srcRoot)) {
    const source = readFileSync(file, 'utf8');
    const prefix =
      /@Controller\(\s*['"`]([^'"`]*)['"`]/.exec(source)?.[1] ?? '';
    for (const match of source.matchAll(
      /@(Get|Post|Patch|Put|Delete)\(\s*['"`]([^'"`]*)['"`]/g,
    )) {
      const path = posix.join(prefix, match[2]).replace(/^\/+|\/+$/g, '');
      if (path.includes(':deploymentId')) {
        found.push(`${match[1].toUpperCase()} ${path}`);
      }
    }
  }
  return found.sort();
}

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

/** Invites a user into the inviter's active Organization and accepts as them. */
async function inviteUser(
  server: App,
  inviterCookie: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ cookie: string; id: string }> {
  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', inviterCookie)
    .send({ email, role });
  expect(invite.status).toBe(201);
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

/** What a caller learns from an answer: everything but the echo of its own
 * request and the clock. */
function answer(res: request.Response) {
  const body = { ...(res.body as Record<string, unknown>) };
  delete body.path;
  delete body.timestamp;
  return { status: res.status, body };
}

describe('Deployment id oracle (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

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
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  describe('the routes addressed by Deployment id', () => {
    it('are exactly the ones this spec sends', () => {
      expect(deploymentIdRoutes()).toEqual(Object.keys(ROUTES).sort());
    });
  });

  describe('a Deployment in another Organization', () => {
    /** Org A's Deployments, one per parent kind, by what they are. */
    let foreign: Record<string, string>;
    /** Org B's own build, the in-organization control. */
    let ownBuild: string;
    let callers: Record<'owner' | 'admin' | 'member', string>;

    beforeAll(async () => {
      await ctx.resetDb();
      execMock.execAsync.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });
      execMock.execAsyncRemote.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      const session = await signUp(server, owner);
      const orgs = await request(server)
        .get('/organizations')
        .set('Cookie', session.cookie);
      const orgA = (orgs.body as { id: string }[])[0].id;
      const ownerA = permissionCtx(session.id, orgA);

      // Org A: a service of each built kind, and one owner of each run kind.
      const project = await ctx.app
        .get(ProjectsService)
        .create(ownerA, { name: 'cloudgate' });
      const environment = await ctx.app
        .get(EnvironmentsService)
        .create(ownerA, { name: 'production', projectId: project.projectId });
      const environmentId = environment.environmentId;
      const app = await ctx.app.get(ApplicationsService).create(ownerA, {
        name: 'Web App',
        appName: 'web-app',
        environmentId,
      });
      await ctx.db
        .update(applicationTable)
        .set({ sourceType: 'docker', dockerImage: 'nginx:1.27' })
        .where(eq(applicationTable.applicationId, app.applicationId));
      const stack = await ctx.app.get(ComposeService).create(ownerA, {
        name: 'Wordpress',
        appName: 'wordpress-stack',
        environmentId,
      });
      const schedule = await ctx.app.get(SchedulesService).create(ownerA, {
        name: 'Clear cache',
        cronExpression: '0 3 * * *',
        scheduleType: 'application',
        serviceId: app.applicationId,
        shellType: 'bash',
        command: 'rm -rf /tmp/cache',
      });
      const destination = await ctx.app
        .get(DestinationsService)
        .create(ownerA, {
          name: 'prod-backups',
          provider: 'Cloudflare',
          accessKey: 'AKIAEXAMPLEACCESSKEY',
          secretAccessKey: 'wJalrXUtnFEMI-example-secret-key',
          bucket: 'cloudgate-backups',
          region: 'auto',
          endpoint: 'https://accountid.r2.cloudflarestorage.com',
        });
      const volumeBackup = await ctx.app
        .get(VolumeBackupsService)
        .create(ownerA, {
          name: 'Nightly volume backup',
          volumeName: 'web-data',
          prefix: 'daily',
          schedule: '0 3 * * *',
          serviceType: 'application',
          serviceId: app.applicationId,
          turnOff: false,
          destinationId: destination.destinationId,
        });
      const database = await ctx.app.get(PostgresService).create(ownerA, {
        name: 'Main DB',
        appName: 'main-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId,
      });
      const backup = await ctx.app.get(BackupsService).create(ownerA, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        backupType: 'database',
        databaseType: 'postgres',
        serviceId: database.postgresId,
        destinationId: destination.destinationId,
      });

      const record = async (
        deploymentId: string,
        status: Deployment['status'],
        owner: Partial<Deployment>,
      ) => {
        await ctx.db.insert(deployment).values({
          deploymentId,
          title: 'Recorded',
          description: '',
          status,
          logPath: `/etc/cloudgate/logs/oracle/${deploymentId}.log`,
          ...owner,
        });
        return deploymentId;
      };
      foreign = {
        // Pending: a leak would reach the queue, which holds its job.
        'a pending Application build': await record(
          'a-app-pending',
          'pending',
          {
            applicationId: app.applicationId,
          },
        ),
        // Finished: a leak would answer the 409.
        'a finished Application build': await record('a-app-done', 'done', {
          applicationId: app.applicationId,
        }),
        'a pending Compose build': await record('a-compose', 'pending', {
          composeId: stack.composeId,
        }),
        // Runs: a leak would answer cancel's scheduled-run 400, or the
        // owning module's own 404 on the log read.
        'a Schedule run': await record('a-schedule', 'running', {
          scheduleId: schedule.scheduleId,
        }),
        'a VolumeBackup run': await record('a-volume-backup', 'running', {
          volumeBackupId: volumeBackup.volumeBackupId,
        }),
        'a Backup run': await record('a-backup', 'running', {
          backupId: backup.backupId,
        }),
      };
      queueMock.getJobs.mockResolvedValue([
        {
          id: 'job-app',
          state: 'waiting',
          data: {
            applicationType: 'application',
            applicationId: app.applicationId,
            deploymentId: 'a-app-pending',
            title: 'Recorded',
            description: '',
            type: 'deploy',
            serverId: null,
          },
        },
        {
          id: 'job-compose',
          state: 'waiting',
          data: {
            applicationType: 'compose',
            composeId: stack.composeId,
            deploymentId: 'a-compose',
            title: 'Recorded',
            description: '',
            type: 'deploy',
            serverId: null,
          },
        },
      ]);
      queueMock.cancel.mockResolvedValue(true);

      // Org B: the same owner switched into it, and two people invited there.
      const created = await createOrganization(server, ctx.db, session.cookie, {
        name: 'Second Org',
      });
      expect(created.status).toBe(201);
      const orgB = (created.body as { id: string }).id;
      const activated = await request(server)
        .post('/api/auth/organization/set-active')
        .set('Cookie', session.cookie)
        .send({ organizationId: orgB });
      expect(activated.status).toBe(200);
      const ownerB = permissionCtx(session.id, orgB);
      const admin = await inviteUser(
        server,
        session.cookie,
        'admin@example.com',
        'admin',
      );
      const member = await inviteUser(
        server,
        session.cookie,
        'member@example.com',
        'member',
      );
      callers = {
        owner: session.cookie,
        admin: admin.cookie,
        member: member.cookie,
      };

      const projectB = await ctx.app
        .get(ProjectsService)
        .create(ownerB, { name: 'other-co' });
      const environmentB = await ctx.app
        .get(EnvironmentsService)
        .create(ownerB, { name: 'production', projectId: projectB.projectId });
      const appB = await ctx.app.get(ApplicationsService).create(ownerB, {
        name: 'Their App',
        appName: 'their-app',
        environmentId: environmentB.environmentId,
      });
      ownBuild = await record('b-app-done', 'done', {
        applicationId: appB.applicationId,
      });
    });

    beforeEach(() => {
      queueMock.cancel.mockClear();
    });

    // The control: each caller really is acting in Org B, so an answer that
    // matches the never-existed one below is the scope talking, not a caller
    // who reached nothing at all.
    it.each([
      ['owner', 409],
      ['admin', 409],
      ['member', 403],
    ] as const)(
      "cancel answers the %s about Org B's own finished build as in-organization (%i)",
      async (caller, status) => {
        const res = await ROUTES['POST deployments/:deploymentId/cancel'](
          server,
          ownBuild,
        ).set('Cookie', callers[caller]);
        expect(res.status).toBe(status);
      },
    );

    const cases = Object.keys(ROUTES).flatMap((route) =>
      (['owner', 'admin', 'member'] as const).flatMap((caller) =>
        [
          'a pending Application build',
          'a finished Application build',
          'a pending Compose build',
          'a Schedule run',
          'a VolumeBackup run',
          'a Backup run',
        ].map((kind) => [route, caller, kind] as const),
      ),
    );

    it.each(cases)(
      '%s answers the %s about %s as about an id that never existed',
      async (route, caller, kind) => {
        const send = ROUTES[route];
        const cookie = callers[caller];

        const missing = await send(server, 'never-existed').set(
          'Cookie',
          cookie,
        );
        const theirs = await send(server, foreign[kind]).set('Cookie', cookie);

        expect(answer(missing)).toEqual({
          status: 404,
          body: {
            statusCode: 404,
            error: 'Not Found',
            message: 'Deployment not found',
          },
        });
        expect(answer(theirs)).toEqual(answer(missing));
        expect(queueMock.cancel).not.toHaveBeenCalled();
      },
    );
  });
});
