import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import { application as applicationTable } from '../../src/applications/application.schema';
import {
  deploymentLogsDirectoryOn,
  logsDirectory,
} from '../../src/deployment-engine/deployment-engine.paths';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { deployment as deploymentTable } from '../../src/deployments/deployment.schema';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import {
  DEPLOYMENT_LOG_RETENTION_DAYS,
  reapedLogNotice,
} from '../../src/deployments/log-retention';
import {
  DEPLOYMENT_LOG_RETENTION_CRON,
  DeploymentLogRetentionService,
} from '../../src/deployments/log-retention.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { server as serverTable } from '../../src/servers/server.schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * Deployment-log retention: the sweep that reaches every machine, and what a
 * read answers once a log has been reaped (ADR-0020).
 *
 * **What was wrong.** Nothing in the product had ever deleted a
 * `deployment.logPath`. There is no `delete(deployment)` anywhere in the tree,
 * the only log cron rotates Traefik's access log, and every Maintenance sweep
 * is a `docker` prune that never touches the platform's own tree — so every
 * build log every Application had ever written was still on its build host,
 * for the life of the install.
 *
 * **Two properties, and both are what the e2e adds over
 * `log-retention.spec.ts`.** The unit spec runs the sweep program under `sh`
 * against a real tree, which is where "does the predicate select the right
 * files" is settled. What only this file can settle is *which machines are
 * asked, and with which root* — a deployment log is written on the **build
 * host**, so a sweep that only reached the platform host would leave every
 * Server's tree exactly as unbounded as it was. Like
 * `application-delete-machines.e2e-spec.ts`, every assertion here therefore
 * names the host: the command is identical on all of them and only the machine
 * and the root differ.
 *
 * **`CLOUDGATE_DIRECTORY` is set here rather than defaulted, and without that
 * half of this file cannot fail.** The two roots — this instance's own and the
 * `/etc/cloudgate` literal every Server's `serverSetupCommand` lays out — are
 * the *same string* on an install that configures neither, so a sweep that sent
 * the local root to every Server would be byte-identical to a correct one and
 * every assertion below would pass. Measured: aiming `sweepOne` at
 * `logsDirectory()` for every machine reds one test here with the variable set
 * and **none** with it unset. That is the same invisibility `applicationsDirectory`
 * has lived behind.
 *
 * The exec layer and the deployment queue are the only doubles, both
 * boundaries (§1.7).
 */
describe('Deployment log retention (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let deployments: DeploymentsService;
  let retention: DeploymentLogRetentionService;
  let scheduling: SchedulingService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = {
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
  };
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };

  /** A real temp directory, and every expectation names the resolved path:
   * /etc/cloudgate exists and is writable on some dev machines, so an
   * accidental fall back to the default would otherwise pass silently —
   * `test/common/cloudgate-directory.spec.ts`' rule. */
  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-retention-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    // Before `createTestApp`, because `localCloudgateDirectory` reads
    // `process.env` on every call but `validateEnv` runs once at boot.
    process.env.CLOUDGATE_DIRECTORY = configuredRoot;
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
    retention = ctx.app.get(DeploymentLogRetentionService);
    scheduling = ctx.app.get(SchedulingService);
  });

  afterAll(async () => {
    await ctx.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(configuredRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockResolvedValue(ok);
    execMock.execAsyncRemote.mockReset().mockResolvedValue(ok);
    queueMock.add.mockReset().mockResolvedValue({ id: 'job-1' });
    queueMock.getJobs.mockReset().mockResolvedValue([]);
    queueMock.cancel.mockReset().mockResolvedValue(false);
  });

  const permissionCtx = (userId: string, organizationId: string) => ({
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
  });

  async function signUp(email: string) {
    const res = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email,
      password: 'super-secret-password',
    });
    expect(res.status).toBe(200);
    return {
      cookie: res.headers['set-cookie'],
      id: (res.body as { user: { id: string } }).user.id,
    };
  }

  /** An owner, a Project, an Environment and an Application on the platform
   * host — the default single-box install, where the log is local. */
  async function setUp(email = 'grace@example.com') {
    const session = await signUp(email);
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
    const application = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'web-app',
      environmentId: environment.environmentId,
    });
    return { session, organizationId, ownerCtx, application };
  }

  async function addServer(organizationId: string, name: string, ip: string) {
    const [row] = await ctx.db
      .insert(serverTable)
      .values({ name, ipAddress: ip, port: 22, organizationId })
      .returning();
    return row.serverId;
  }

  /** Every command the sweep issued, with the machine it was issued to —
   * `null` being the platform host (ADR-0008). */
  const swept = () =>
    [
      ...execMock.execAsync.mock.calls.map(([command]) => ({
        serverId: null as string | null,
        command,
      })),
      ...execMock.execAsyncRemote.mock.calls.map(([serverId, command]) => ({
        serverId,
        command,
      })),
    ].filter(({ command }) => command.includes('-mtime'));

  describe('the cron', () => {
    // Armed at boot rather than by an operator turning it on: unlike
    // `logCleanupCron` there is nothing to configure, and an install that
    // forgot to enable retention is the install this ticket is about.
    it('is armed at boot, daily, at a minute of its own', () => {
      expect(scheduling.has('deployment-log-retention')).toBe(true);
      // Not the access log's `0 0 * * *` and not the docker prune's
      // `50 23 * * *`: this one reaches every Server, so it must not stack its
      // SSH timeouts on another sweep's.
      expect(DEPLOYMENT_LOG_RETENTION_CRON).toBe('20 4 * * *');
    });
  });

  describe('which machines a sweep reaches', () => {
    it('sweeps the platform host under this instance’s own root', async () => {
      await setUp();

      await retention.sweep();

      expect(swept().map(({ serverId }) => serverId)).toEqual([null]);
      expect(swept()[0].command).toContain(logsDirectory());
      expect(swept()[0].command).toContain(
        `-mtime +${DEPLOYMENT_LOG_RETENTION_DAYS}`,
      );
    });

    /**
     * The property the whole cron exists for: a deployment log is written on
     * the **build host**, so a sweep confined to the platform host would leave
     * every Server's tree as unbounded as it was. And each Server is asked
     * under `REMOTE_CLOUDGATE_DIRECTORY`, not under this instance's root, for
     * `cloudgate-directory.ts`'s reason: that is the tree `serverSetupCommand`
     * created there.
     */
    it('sweeps every Server too, under the root its own setup laid out', async () => {
      const { organizationId } = await setUp();
      const builder = await addServer(
        organizationId,
        'builder-eu',
        '203.0.113.7',
      );
      const runner = await addServer(
        organizationId,
        'runner-us',
        '198.51.100.4',
      );

      await retention.sweep();

      // The two roots spelled out rather than taken from `logsDirectoryOn`,
      // because with `CLOUDGATE_DIRECTORY` set they are genuinely different
      // strings and naming both is the assertion.
      expect(swept().map(({ serverId }) => serverId)).toEqual([
        null,
        builder,
        runner,
      ]);
      const [platform, ...remotes] = swept();
      expect(platform.command).toContain(`${configuredRoot}/logs`);
      for (const { command } of remotes) {
        expect(command).toContain(`${REMOTE_CLOUDGATE_DIRECTORY}/logs`);
        expect(command).not.toContain(configuredRoot);
      }
    });

    // A Server enrolled since boot is swept on the next run, which is the
    // property that makes one instance-wide job right rather than one per
    // Server.
    it('sweeps a Server that was enrolled after the job was armed', async () => {
      const { organizationId } = await setUp();
      await retention.sweep();
      const late = await addServer(organizationId, 'late-one', '203.0.113.9');
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();

      await retention.sweep();

      expect(swept().map(({ serverId }) => serverId)).toEqual([null, late]);
    });

    it('carries on to the next machine when one cannot be reached', async () => {
      const { organizationId } = await setUp();
      const unreachable = await addServer(
        organizationId,
        'down-one',
        '203.0.113.7',
      );
      const reachable = await addServer(
        organizationId,
        'up-one',
        '198.51.100.4',
      );
      execMock.execAsyncRemote.mockImplementation((serverId: string) =>
        serverId === unreachable
          ? Promise.reject(new Error('ssh: connect to host: timed out'))
          : Promise.resolve(ok),
      );

      // Nothing thrown: the sweep is housekeeping nothing is waiting on, and a
      // Server that is down must not cost the machines after it.
      await expect(retention.sweep()).resolves.toBeUndefined();

      expect(swept().map(({ serverId }) => serverId)).toEqual([
        null,
        unreachable,
        reachable,
      ]);
    });
  });

  /**
   * The row and the file are two lifetimes, and ADR-0007 makes
   * `GET /deployments/:id/logs` answer *for the Deployment* — so a Deployment
   * whose log retention has reaped has to answer something coherent. It
   * answers a sentence, and a `404` was rejected because this route already
   * spends `404` on *"no such deployment"*.
   */
  describe('reading a log retention has reaped', () => {
    /** Ages the row rather than the file: the file is on a doubled exec layer
     * and was never written, which is exactly the state a reaped log leaves. */
    async function age(deploymentId: string, days: number) {
      await ctx.db
        .update(deploymentTable)
        .set({
          createdAt: new Date(
            Date.now() - days * 24 * 60 * 60 * 1000,
          ).toISOString(),
        })
        .where(eq(deploymentTable.deploymentId, deploymentId));
    }

    async function record(applicationId: string) {
      return deployments.create({
        kind: 'application',
        applicationId,
        title: 'Manual deployment',
        description: '',
      });
    }

    it('says the log is gone and names the window, rather than answering nothing', async () => {
      const { ownerCtx, application } = await setUp();
      const created = await record(application.applicationId);
      await age(created.deploymentId, DEPLOYMENT_LOG_RETENTION_DAYS + 10);
      // What `tail … 2>/dev/null || echo ""` answers for a file that is not
      // there — the same thing it answers for one that is empty, which is the
      // ambiguity the row's age resolves.
      execMock.execAsync.mockResolvedValue({ ...ok, stdout: '\n' });

      expect(
        await deployments.readLogs(ownerCtx, created.deploymentId, 100),
      ).toBe(reapedLogNotice());
    });

    it('still answers nothing for a young deployment that has not written yet', async () => {
      const { ownerCtx, application } = await setUp();
      const created = await record(application.applicationId);
      execMock.execAsync.mockResolvedValue({ ...ok, stdout: '' });

      // A queued build has written nothing and its log has not been reaped, and
      // telling an operator it was would be worse than saying nothing.
      expect(
        await deployments.readLogs(ownerCtx, created.deploymentId, 100),
      ).toBe('');
    });

    it('answers the log itself when an old deployment’s log is still there', async () => {
      const { ownerCtx, application } = await setUp();
      const created = await record(application.applicationId);
      await age(created.deploymentId, DEPLOYMENT_LOG_RETENTION_DAYS + 10);
      execMock.execAsync.mockResolvedValue({
        ...ok,
        stdout: 'Initializing deployment\n',
      });

      expect(
        await deployments.readLogs(ownerCtx, created.deploymentId, 100),
      ).toBe('Initializing deployment\n');
    });

    // The route's own contract: it answers `text/plain`, so the notice
    // composes with a log tail rather than needing a second response shape.
    it('answers the notice over HTTP as plain text with a 200', async () => {
      const { session, application } = await setUp();
      const created = await record(application.applicationId);
      await age(created.deploymentId, DEPLOYMENT_LOG_RETENTION_DAYS + 10);
      execMock.execAsync.mockResolvedValue({ ...ok, stdout: '' });

      const res = await request(server)
        .get(`/deployments/${created.deploymentId}/logs`)
        .set('Cookie', session.cookie);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toBe(reapedLogNotice());
    });
  });

  /**
   * US41: a Cron service's run keeps its own Deployment log on the
   * Server that ran it (ADR-0034), and that log is swept like any other.
   */
  it('sweeps a Cron service run log on the Server that ran it, and reads it as reaped once it is', async () => {
    const { ownerCtx, organizationId, application } = await setUp();
    const runner = await addServer(organizationId, 'runner', '203.0.113.20');
    const [run] = await ctx.db
      .insert(deploymentTable)
      .values({
        deploymentId: 'run-1',
        applicationId: application.applicationId,
        cronRun: {
          job: 'web-app-run-abcd1234',
          image: 'web-app:latest',
          startedBy: { kind: 'timetable' },
        },
        title: 'Timetable run',
        status: 'done',
        logPath: `${deploymentLogsDirectoryOn(runner, 'web-app')}/run-1.log`,
        createdAt: new Date(
          Date.now() - (DEPLOYMENT_LOG_RETENTION_DAYS + 10) * 86_400_000,
        ).toISOString(),
      })
      .returning();
    // The run ran on the runner, whatever the Application runs on now.
    await ctx.db
      .update(applicationTable)
      .set({ serverId: runner })
      .where(eq(applicationTable.applicationId, application.applicationId));

    await retention.sweep();

    const onRunner = swept().filter(({ serverId }) => serverId === runner);
    expect(onRunner).toHaveLength(1);
    const sweptRoot = `${REMOTE_CLOUDGATE_DIRECTORY}/logs`;
    expect(onRunner[0].command).toContain(sweptRoot);
    expect(run.logPath.startsWith(`${sweptRoot}/`)).toBe(true);

    // What a reaped file reads as, on the runner.
    execMock.execAsyncRemote.mockResolvedValue({ ...ok, stdout: '' });
    expect(await deployments.readLogs(ownerCtx, run.deploymentId, 100)).toBe(
      reapedLogNotice(),
    );
  });
});
