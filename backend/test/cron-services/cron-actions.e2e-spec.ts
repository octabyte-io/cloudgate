import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { CronRunsService } from '../../src/cron-services/cron-runs.service';
import { CRON_SERVICE_CLOCK } from '../../src/cron-services/cron-service.clock';
import { CronTimetable } from '../../src/cron-services/cron-timetable.service';
import {
  application,
  deployment,
  licenseKey,
  member,
  organizationRole,
  server as serverTable,
} from '../../src/db/schema';
import { deploymentLogsDirectoryOn } from '../../src/deployment-engine/deployment-engine.paths';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The deployment queue as a list: a queued build is never run. */
class ListQueue implements QueuePort {
  jobs: QueuedJob[] = [];
  private next = 0;

  add(data: DeploymentJob): Promise<QueuedJob> {
    const job: QueuedJob = { id: `job-${++this.next}`, data, state: 'waiting' };
    this.jobs.push(job);
    return Promise.resolve({ ...job });
  }

  getJobs(states?: JobState[]): Promise<QueuedJob[]> {
    return Promise.resolve(
      this.jobs.filter((job) => !states || states.includes(job.state)),
    );
  }

  cancel(): Promise<boolean> {
    return Promise.resolve(false);
  }

  clearWaiting(): Promise<QueuedJob[]> {
    return Promise.resolve([]);
  }
}

/** Weekdays at 03:00 UTC. */
const REPORT = `version: 1
services:
  report:
    kind: cron
    command: node dist/report.js
    schedule: "0 3 * * MON-FRI"
    source:
      git: https://git.example.com/acme/report.git
`;

/** Monday 2026-09-28, an hour before the report's first fire time. */
const MONDAY_0200 = Date.parse('2026-09-28T02:00:00.000Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** Monday's 03:00 UTC fire time. */
const MONDAY_0300 = MONDAY_0200 + HOUR;

interface RunRecord {
  deploymentId: string;
  status: string;
  logPath: string;
  cronRun: {
    job: string;
    startedBy: { kind: string; userId?: string; name?: string };
    stopped?: true;
  } | null;
}

/**
 * The lifecycle actions on a Cron service (spec US44–48,
 * ADR-0034) — cancelling one run, Stop and Start as the per-Environment
 * pause, Run now while paused, no Remove containers, and Delete (and a plan
 * destroy) taking a run in flight, the timetable, the Run records and their
 * logs with it. The clock stands still and the tick is called directly; the
 * Swarm, the machines and the queue are the boundaries.
 */
describe('A Cron service’s actions (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let ownerId: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  let runServerId: string;
  let applicationId: string;
  let appName: string;

  let now = MONDAY_0200;
  const clock = { now: () => now };

  const queue = new ListQueue();
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
    execRemote: jest.fn(),
  };
  /** How every job's task reads at the Swarm. */
  let taskState: { State: string; ContainerStatus?: { ExitCode: number } };
  /** Every job the Swarm was asked to remove, in order. */
  const removed: string[] = [];
  /** Whether the Swarm refuses to remove a job (its Server unreachable). */
  let removeFails = false;
  const docker = {
    getService: jest.fn((name: string) => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such service')),
      update: jest.fn(),
      remove: jest.fn(() => {
        if (removeFails) return Promise.reject(new Error('connection refused'));
        removed.push(name);
        return Promise.resolve();
      }),
      logs: jest.fn(() => Promise.resolve(Buffer.alloc(0))),
    })),
    createService: jest.fn().mockResolvedValue(undefined),
    listTasks: jest.fn(() => Promise.resolve([{ Status: taskState }])),
    listServices: jest.fn().mockResolvedValue([]),
    listContainers: jest.fn().mockResolvedValue([]),
  };
  const getRemoteDocker = jest.fn().mockResolvedValue(docker);

  const timetable = () => ctx.app.get(CronTimetable);
  const runs = () => ctx.app.get(CronRunsService);

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: { getRemoteDocker } },
        { provide: CRON_SERVICE_CLOCK, useValue: clock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  const succeeds = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command)
        ? { stdout: 'absent', stderr: '' }
        : { stdout: '', stderr: '' },
    );

  /** Saves the text and applies the plan it stored for the Environment. */
  async function applyConfig(text: string, confirmDestroy?: string[]) {
    const saved = await request(server)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });
    expect(saved.status).toBe(201);
    const plan = (
      saved.body as { plans: { planId: string; environmentId: string }[] }
    ).plans.find((each) => each.environmentId === environmentId);
    const applied = await request(server)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: plan!.planId, confirmDestroy });
    expect(applied.status).toBe(200);
  }

  beforeEach(async () => {
    await ctx.resetDb();
    queue.jobs = [];
    removed.length = 0;
    removeFails = false;
    taskState = { State: 'running' };
    docker.createService.mockClear();
    getRemoteDocker.mockClear();
    execMock.execAsync.mockReset().mockImplementation(succeeds);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        succeeds(command),
      );
    execMock.execRemote.mockReset().mockImplementation(() => succeeds(''));
    now = MONDAY_0200;
    timetable().arm();

    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerId = (res.body as { user: { id: string } }).user.id;
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const [row] = await ctx.db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, ownerId));
    organizationId = row.organizationId;

    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;
    const created = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name: 'production', projectId });
    expect(created.status).toBe(201);
    environmentId = (created.body as { environmentId: string }).environmentId;

    await applyConfig(REPORT);

    // It runs on one Server and builds on another, so its run logs are not
    // where its build logs are.
    const [runner, builder] = await ctx.db
      .insert(serverTable)
      .values([
        { name: 'runner', ipAddress: '203.0.113.20', port: 22, organizationId },
        {
          name: 'builder',
          ipAddress: '203.0.113.21',
          port: 22,
          organizationId,
        },
      ])
      .returning();
    runServerId = runner.serverId;
    const [cron] = await ctx.db
      .update(application)
      .set({ serverId: runServerId, buildServerId: builder.serverId })
      .where(eq(application.environmentId, environmentId))
      .returning();
    applicationId = cron.applicationId;
    appName = cron.appName;
    // Its Build deployment succeeded.
    await ctx.db
      .update(deployment)
      .set({ status: 'done' })
      .where(eq(deployment.applicationId, applicationId));
  });

  afterEach(async () => {
    // No watch outlives its test.
    removeFails = false;
    taskState = { State: 'complete', ContainerStatus: { ExitCode: 0 } };
    await Promise.all(
      (await runRecords()).map((run) => runs().whenSettled(run.deploymentId)),
    );
  });

  async function runRecords(): Promise<RunRecord[]> {
    if (!applicationId) return [];
    const rows = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.applicationId, applicationId));
    return rows.filter((row) => row.cronRun !== null);
  }

  async function recordOf(deploymentId: string): Promise<RunRecord> {
    const [row] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId));
    return row;
  }

  /** Moves the clock to `at` and ticks there. */
  async function tickAt(at: number): Promise<RunRecord[]> {
    now = at;
    return await timetable().tick();
  }

  /** A run the timetable started at Monday's fire time, still going. */
  async function runInFlight(): Promise<RunRecord> {
    const [run, ...more] = await tickAt(MONDAY_0300 + 5_000);
    expect(more).toEqual([]);
    expect(run.status).toBe('running');
    return run;
  }

  /** What was appended to a log file on the run Server, in order. */
  function appendedTo(logPath: string): string[] {
    return (execMock.execAsyncRemote.mock.calls as [string, string][])
      .filter(
        ([on, command]) => on === runServerId && command.includes(logPath),
      )
      .flatMap(([, command]) => {
        const appended = /^echo (\S+) \| base64 -d >> /.exec(command);
        return appended
          ? Buffer.from(appended[1].replace(/\\/g, ''), 'base64')
              .toString('utf8')
              .trimEnd()
              .split('\n')
          : [];
      });
  }

  /** A member whose custom role holds `deployment` as given, on this Service. */
  async function memberWith(deployment_: string[]): Promise<string> {
    const fixture = await signUpMember(server, cookie);
    await ctx.db.insert(licenseKey).values({
      organizationId,
      key: 'test-license-key',
      status: 'active',
      enableEnterpriseFeatures: true,
    });
    await ctx.db.insert(organizationRole).values({
      organizationId,
      role: 'runner',
      permission: { service: ['read'], deployment: deployment_ },
    });
    await ctx.db
      .update(member)
      .set({
        role: 'runner',
        accessedProjects: [projectId],
        accessedEnvironments: [environmentId],
        accessedServices: [applicationId],
      })
      .where(
        and(
          eq(member.userId, fixture.id),
          eq(member.organizationId, organizationId),
        ),
      );
    return fixture.cookie;
  }

  const cancel = (deploymentId: string, as = cookie) =>
    request(server)
      .post(`/deployments/${deploymentId}/cancel`)
      .set('Cookie', as);

  describe('cancelling one run', () => {
    it('stops its job and records it cancelled, saying who; the next fire time still fires', async () => {
      const run = await runInFlight();

      const res = await cancel(run.deploymentId);

      expect(res.status).toBe(200);
      expect((res.body as RunRecord).status).toBe('cancelled');
      await runs().whenSettled(run.deploymentId);
      expect((await recordOf(run.deploymentId)).status).toBe('cancelled');
      expect(removed).toContain(run.cronRun!.job);
      expect(appendedTo(run.logPath).at(-1)).toBe(
        '⏹️ [Run] Cancelled by Grace Hopper',
      );

      // The timetable keeps going.
      expect(await tickAt(MONDAY_0300 + DAY + 5_000)).toHaveLength(1);
    });

    it('is refused for a member without deployment: cancel, and the run goes on', async () => {
      const run = await runInFlight();
      const without = await memberWith(['read', 'create']);

      const res = await cancel(run.deploymentId, without);

      expect(res.status).toBe(403);
      expect((await recordOf(run.deploymentId)).status).toBe('running');
      expect(removed).toEqual([]);
    });

    it('is allowed for a member with deployment: cancel', async () => {
      const run = await runInFlight();
      const canceller = await memberWith(['read', 'cancel']);

      expect((await cancel(run.deploymentId, canceller)).status).toBe(200);
      expect((await recordOf(run.deploymentId)).status).toBe('cancelled');
    });

    it('is refused while its job cannot be removed, and the run is still recorded running; a later cancel ends it', async () => {
      const run = await runInFlight();
      removeFails = true;

      const refused = await cancel(run.deploymentId);

      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toContain(
        run.cronRun!.job,
      );
      expect((await recordOf(run.deploymentId)).status).toBe('running');

      removeFails = false;
      expect((await cancel(run.deploymentId)).status).toBe(200);
      expect((await recordOf(run.deploymentId)).status).toBe('cancelled');
      expect(removed).toEqual([run.cronRun!.job]);
    });

    it('is refused for a run that has already ended, which keeps its ending', async () => {
      taskState = { State: 'complete', ContainerStatus: { ExitCode: 0 } };
      const [run] = await tickAt(MONDAY_0300 + 5_000);
      await runs().whenSettled(run.deploymentId);

      const res = await cancel(run.deploymentId);

      expect(res.status).toBe(409);
      expect((await recordOf(run.deploymentId)).status).toBe('done');
    });
  });

  describe('Stop and Start, the pause', () => {
    const stop = () =>
      request(server)
        .post(`/applications/${applicationId}/stop`)
        .set('Cookie', cookie);
    const start = () =>
      request(server)
        .post(`/applications/${applicationId}/start`)
        .set('Cookie', cookie);

    it('stops a run in flight, recorded as stopped, and fires nothing until Start; then the next fire time fires', async () => {
      const run = await runInFlight();

      const stopped = await stop();

      expect(stopped.status).toBe(200);
      expect(
        (stopped.body as { applicationStatus: string }).applicationStatus,
      ).toBe('stopped');
      const ended = await recordOf(run.deploymentId);
      expect(ended.status).toBe('cancelled');
      // Recorded as stopped, not as a cancel.
      expect(ended.cronRun!.stopped).toBe(true);
      expect(removed).toContain(run.cronRun!.job);
      expect(appendedTo(run.logPath).at(-1)).toBe(
        '⏹️ [Run] Stopped: Grace Hopper stopped the Cron service',
      );
      // No Swarm service is scaled: a Cron service has none.
      expect(
        (execMock.execAsyncRemote.mock.calls as [string, string][]).some(
          ([, command]) => command.includes('docker service scale'),
        ),
      ).toBe(false);

      // Paused: Tuesday's fire time starts nothing.
      docker.createService.mockClear();
      expect(await tickAt(MONDAY_0300 + DAY + 5_000)).toEqual([]);
      expect(docker.createService).not.toHaveBeenCalled();

      const started = await start();
      expect(started.status).toBe(200);
      expect(
        (started.body as { applicationStatus: string }).applicationStatus,
      ).toBe('done');
      // Nothing crossed while paused is made up; Wednesday's fires.
      expect(await tickAt(MONDAY_0300 + DAY + 15_000)).toEqual([]);
      expect(await tickAt(MONDAY_0300 + 2 * DAY + 5_000)).toHaveLength(1);
    });

    it('keeps a run whose Server cannot be reached recorded running, and stops it at a later tick once it can be', async () => {
      const run = await runInFlight();
      getRemoteDocker.mockRejectedValueOnce(new Error('connection refused'));

      expect((await stop()).status).toBe(200);

      // Not recorded as over while its job may still be going.
      expect((await recordOf(run.deploymentId)).status).toBe('running');
      expect(removed).toEqual([]);

      await tickAt(MONDAY_0300 + 15_000);

      const ended = await recordOf(run.deploymentId);
      expect(ended.status).toBe('cancelled');
      expect(ended.cronRun!.stopped).toBe(true);
      expect(removed).toEqual([run.cronRun!.job]);
      expect(appendedTo(run.logPath).at(-1)).toBe(
        '⏹️ [Run] Stopped: Grace Hopper stopped the Cron service',
      );
    });

    it('does not stop a Run now started while paused', async () => {
      await stop();
      const res = await request(server)
        .post(`/applications/${applicationId}/run`)
        .set('Cookie', cookie);
      expect(res.status).toBe(201);

      // Within its timeout: the tick has nothing of a Stop left to end.
      await tickAt(MONDAY_0200 + 30_000);

      expect(
        (await recordOf((res.body as RunRecord).deploymentId)).status,
      ).toBe('running');
    });

    it('leaves the Project config alone', async () => {
      const before = await request(server)
        .get(`/projects/${projectId}/config`)
        .set('Cookie', cookie);
      await stop();
      await start();
      const after = await request(server)
        .get(`/projects/${projectId}/config`)
        .set('Cookie', cookie);
      expect(after.status).toBe(before.status);
      expect(after.body).toEqual(before.body);
    });

    it('refuses Restart: a Cron service has nothing running to restart', async () => {
      const res = await request(server)
        .post(`/applications/${applicationId}/reload`)
        .set('Cookie', cookie);
      expect(res.status).toBe(409);
    });

    it('lets Run now start a run while paused, recording who started it', async () => {
      await stop();

      const res = await request(server)
        .post(`/applications/${applicationId}/run`)
        .set('Cookie', cookie);

      expect(res.status).toBe(201);
      expect((res.body as RunRecord).cronRun!.startedBy).toEqual({
        kind: 'member',
        userId: ownerId,
        name: 'Grace Hopper',
      });
      expect(docker.createService).toHaveBeenCalledTimes(1);
      // And it is still paused.
      const [row] = await ctx.db
        .select({ status: application.applicationStatus })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(row.status).toBe('stopped');
    });
  });

  it('lists its next fire times on the clock its timetable fires on', async () => {
    const res = await request(server)
      .get(`/applications/${applicationId}`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    const read = res.body as { cronService: { nextFireTimes: string[] } };
    expect(read.cronService.nextFireTimes[0]).toBe(
      new Date(MONDAY_0300).toISOString(),
    );
  });

  it('offers no Remove containers on a Cron service', async () => {
    const res = await request(server)
      .post(`/applications/${applicationId}/remove-containers`)
      .set('Cookie', cookie);
    expect(res.status).toBe(404);
  });

  describe('Delete', () => {
    /** Asserts the run in flight was stopped and everything went with it. */
    async function takenWithIt(run: RunRecord) {
      expect(removed).toContain(run.cronRun!.job);
      expect(appendedTo(run.logPath).at(-1)).toBe(
        '⏹️ [Run] Stopped: Grace Hopper deleted the Cron service',
      );
      expect(
        await ctx.db
          .select()
          .from(application)
          .where(eq(application.applicationId, applicationId)),
      ).toEqual([]);
      expect(
        await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.applicationId, applicationId)),
      ).toEqual([]);
      // The run logs, on the run Server.
      expect(
        (execMock.execRemote.mock.calls as [string, string[]][]).filter(
          ([on, argv]) =>
            on === runServerId &&
            argv.join(' ') ===
              `rm -rf ${deploymentLogsDirectoryOn(runServerId, appName)}`,
        ),
      ).not.toEqual([]);

      // Disarmed: the next fire time starts nothing.
      docker.createService.mockClear();
      expect(await tickAt(MONDAY_0300 + DAY + 5_000)).toEqual([]);
      expect(docker.createService).not.toHaveBeenCalled();
    }

    it('stops a run in flight, disarms the timetable, and removes the Service with its Run records and logs', async () => {
      const run = await runInFlight();

      const res = await request(server)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      await takenWithIt(run);
    });

    it('keeps the Service as it was, its run going on, when a run job cannot be confirmed gone', async () => {
      const run = await runInFlight();
      const [before] = await ctx.db
        .select({ status: application.applicationStatus })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      removeFails = true;

      const res = await request(server)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(409);
      const [kept] = await ctx.db
        .select({ status: application.applicationStatus })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      // A refused Delete is not a Stop: the timetable is armed again.
      expect(kept.status).toBe(before.status);
      expect(kept.status).not.toBe('stopped');
      expect((await recordOf(run.deploymentId)).status).toBe('running');
      removeFails = false;
      expect(await tickAt(MONDAY_0300 + DAY + 5_000)).toHaveLength(1);
    });

    it('does the same when a plan destroys the cron entry', async () => {
      const run = await runInFlight();

      await applyConfig('version: 1\nservices: {}\n', ['report']);

      await takenWithIt(run);
    });
  });
});
