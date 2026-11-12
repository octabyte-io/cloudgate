import type { CreateServiceOptions } from 'dockerode';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { CronRunsService } from '../../src/cron-services/cron-runs.service';
import { CRON_SERVICE_CLOCK } from '../../src/cron-services/cron-service.clock';
import { CronTimetable } from '../../src/cron-services/cron-timetable.service';
import {
  application,
  deployment,
  member,
  server as serverTable,
} from '../../src/db/schema';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  freezeOrganization,
  thawOrganization,
} from '../utils/frozen-organization';
import { createTestApp, TestAppContext } from '../utils/test-app';
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
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Monday's 03:00 UTC fire time. */
const MONDAY_0300 = MONDAY_0200 + HOUR;

interface RunRecord {
  deploymentId: string;
  status: string;
  title: string;
  logPath: string;
  cronRun: { job: string; startedBy: { kind: string } } | null;
}

/**
 * A Cron service's **timetable** on a Server (ADR-0034). At
 * each fire time it starts a run through the Run now path, recorded as
 * started by the timetable. The clock stands still and the tick is called
 * directly; the Swarm, the machines and the queue are the boundaries.
 */
describe('A Cron service timetable (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;
  let runServerId: string;
  let applicationId: string;
  let organizationId: string;

  let now = MONDAY_0200;
  const clock = { now: () => now };

  const queue = new ListQueue();
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  /** How every job's task reads at the Swarm. */
  let taskState: { State: string; ContainerStatus?: { ExitCode: number } };
  const docker = {
    getService: jest.fn(() => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such service')),
      update: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
      logs: jest.fn(() => Promise.resolve(Buffer.alloc(0))),
    })),
    createService: jest.fn().mockResolvedValue(undefined),
    listTasks: jest.fn(() => Promise.resolve([{ Status: taskState }])),
    listServices: jest.fn().mockResolvedValue([]),
    listContainers: jest.fn().mockResolvedValue([]),
  };
  const getRemoteDocker = jest.fn().mockResolvedValue(docker);

  const timetable = () => ctx.app.get(CronTimetable);

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
    taskState = { State: 'complete', ContainerStatus: { ExitCode: 0 } };
    docker.createService.mockClear();
    getRemoteDocker.mockClear();
    execMock.execAsync.mockReset().mockImplementation(succeeds);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        succeeds(command),
      );
    // Cloudgate boots before the Cron service exists.
    now = MONDAY_0200;
    timetable().arm();

    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    const ownerId = (res.body as { user: { id: string } }).user.id;
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

    const [runner] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'runner',
        ipAddress: '203.0.113.20',
        port: 22,
        organizationId: row.organizationId,
      })
      .returning();
    runServerId = runner.serverId;
    const [cron] = await ctx.db
      .update(application)
      .set({ serverId: runServerId })
      .where(eq(application.environmentId, environmentId))
      .returning();
    applicationId = cron.applicationId;
  });

  /** The Cron service's Build deployment, succeeded. */
  async function buildSucceeds() {
    await ctx.db
      .update(deployment)
      .set({ status: 'done' })
      .where(eq(deployment.applicationId, applicationId));
  }

  async function runRecords(): Promise<RunRecord[]> {
    const rows = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.applicationId, applicationId));
    return rows.filter((row) => row.cronRun !== null);
  }

  /** Moves the clock to `at` and ticks there. */
  async function tickAt(at: number): Promise<RunRecord[]> {
    now = at;
    return await timetable().tick();
  }

  /** Every job's name the Swarm was asked to create, in order. */
  const jobsCreated = () =>
    (docker.createService.mock.calls as [CreateServiceOptions][]).map(
      ([spec]) => spec.Name,
    );

  it('starts a run through the Run now path at a fire time, recorded as started by the timetable', async () => {
    await buildSucceeds();

    expect(await tickAt(MONDAY_0300 - 5_000)).toEqual([]);
    const [record, ...more] = await tickAt(MONDAY_0300 + 5_000);
    expect(more).toEqual([]);
    expect(record).toMatchObject({
      title: 'Timetable run',
      cronRun: { startedBy: { kind: 'timetable' } },
    });
    expect(jobsCreated()).toEqual([record.cronRun!.job]);
    expect(getRemoteDocker).toHaveBeenCalledWith(runServerId);

    await ctx.app.get(CronRunsService).whenSettled(record.deploymentId);
    const [settled] = await runRecords();
    expect(settled.status).toBe('done');
    // The first line of its log says what started it.
    const init = (execMock.execAsyncRemote.mock.calls as [string, string][])
      .map(([, command]) => command)
      .find((command) => command.includes(record.logPath));
    expect(init).toContain('started by the timetable');

    // A fire time is fired once, however often the timetable looks again.
    expect(await tickAt(MONDAY_0300 + 15_000)).toEqual([]);
    expect(await runRecords()).toHaveLength(1);
  });

  it('does not make up the fire times crossed while Cloudgate was down', async () => {
    await buildSucceeds();

    // Down from Monday 02:00 until Thursday 03:30: four fire times pass with
    // no tick, then Cloudgate boots.
    now = MONDAY_0200 + 3 * DAY + 90 * MINUTE;
    timetable().arm();
    expect(await tickAt(now + 5_000)).toEqual([]);
    expect(docker.createService).not.toHaveBeenCalled();
    expect(await runRecords()).toEqual([]);

    // Friday's fires as usual.
    expect(await tickAt(MONDAY_0300 + 4 * DAY + 5_000)).toHaveLength(1);
  });

  it('fires late, rather than drops, a fire time a late tick crossed while Cloudgate was up', async () => {
    await buildSucceeds();

    // The tick before held up for ten minutes, across Monday's 03:00.
    expect(await tickAt(MONDAY_0300 - 5_000)).toEqual([]);
    const late = await tickAt(MONDAY_0300 + 10 * MINUTE);

    expect(late).toHaveLength(1);
    expect(late[0].cronRun!.startedBy.kind).toBe('timetable');
  });

  it('starts the next run while the last is still going: runs overlap', async () => {
    await buildSucceeds();
    taskState = { State: 'running' };
    // Its longest `timeout`, so Monday's run is still within it on Tuesday.
    await ctx.db
      .update(application)
      .set({ cronTimeoutSeconds: 24 * 60 * 60 })
      .where(eq(application.applicationId, applicationId));

    const [monday] = await tickAt(MONDAY_0300 + 5_000);
    const [tuesday] = await tickAt(MONDAY_0300 + DAY + 1_000);

    expect(jobsCreated()).toEqual([monday.cronRun!.job, tuesday.cronRun!.job]);
    expect(monday.cronRun!.job).not.toBe(tuesday.cronRun!.job);
    expect((await runRecords()).map((run) => run.status)).toEqual([
      'running',
      'running',
    ]);

    taskState = { State: 'complete', ContainerStatus: { ExitCode: 0 } };
    const runs = ctx.app.get(CronRunsService);
    await Promise.all([
      runs.whenSettled(monday.deploymentId),
      runs.whenSettled(tuesday.deploymentId),
    ]);
  });

  it('fires nothing for a Cron service waiting for its first build, and writes no Run record', async () => {
    expect(await tickAt(MONDAY_0300 + 5_000)).toEqual([]);

    expect(docker.createService).not.toHaveBeenCalled();
    expect(await runRecords()).toEqual([]);
  });

  it('arms every live Cron service at boot', async () => {
    await buildSucceeds();
    now = MONDAY_0200 + 30 * MINUTE;
    timetable().arm();

    expect(await tickAt(MONDAY_0300 + 5_000)).toHaveLength(1);
  });

  it('re-arms a Cron service on the new times when a plan changes its schedule and timezone', async () => {
    await buildSucceeds();
    // 06:30 in Berlin, which is 04:30 UTC in September.
    await applyConfig(
      REPORT.replace(
        'schedule: "0 3 * * MON-FRI"',
        'schedule: "30 6 * * *"\n    timezone: Europe/Berlin',
      ),
    );
    const [changed] = await ctx.db
      .select({
        schedule: application.cronSchedule,
        timezone: application.cronTimezone,
      })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    expect(changed).toEqual({
      schedule: '30 6 * * *',
      timezone: 'Europe/Berlin',
    });

    expect(await tickAt(MONDAY_0300 + 5_000)).toEqual([]);
    expect(await tickAt(MONDAY_0300 + 90 * MINUTE + 5_000)).toHaveLength(1);
  });

  it('disarms a Cron service a plan destroys', async () => {
    await buildSucceeds();
    await applyConfig('version: 1\nservices: {}\n', ['report']);
    expect(
      await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId)),
    ).toEqual([]);

    expect(await tickAt(MONDAY_0300 + 5_000)).toEqual([]);
    expect(docker.createService).not.toHaveBeenCalled();
  });

  describe('of a Frozen Organization', () => {
    afterEach(() => jest.restoreAllMocks());

    it('fires nothing while the Organization is frozen, and asks nothing of its Server', async () => {
      await buildSucceeds();
      await freezeOrganization(ctx, organizationId);
      execMock.execAsyncRemote.mockClear();

      expect(await tickAt(MONDAY_0300 + 5_000)).toEqual([]);

      expect(docker.createService).not.toHaveBeenCalled();
      expect(getRemoteDocker).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
      expect(await runRecords()).toEqual([]);
    });

    it('fires again from the next fire time once paid, with none of the missed ones run late', async () => {
      await buildSucceeds();
      await freezeOrganization(ctx, organizationId);
      expect(await tickAt(MONDAY_0300 + 5_000)).toEqual([]);
      expect(await tickAt(MONDAY_0300 + DAY + 5_000)).toEqual([]);

      await thawOrganization(ctx, organizationId);
      // The first tick after paying: no burst of Monday's and Tuesday's.
      expect(await tickAt(MONDAY_0300 + DAY + 15_000)).toEqual([]);
      expect(docker.createService).not.toHaveBeenCalled();
      // Wednesday's fires, once.
      const [wednesday, ...more] = await tickAt(MONDAY_0300 + 2 * DAY + 5_000);
      expect(more).toEqual([]);
      expect(wednesday.cronRun!.startedBy.kind).toBe('timetable');
      expect(await runRecords()).toHaveLength(1);
      await ctx.app.get(CronRunsService).whenSettled(wednesday.deploymentId);
    });
  });
});
