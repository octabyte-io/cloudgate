import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
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

/** Weekdays at 03:00 UTC, held to the default `timeout` of 1h. */
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
const MONDAY_0300 = MONDAY_0200 + HOUR;

/** A multiplexed `docker service logs` answer: one stdout frame per line. */
function framed(...lines: string[]): Buffer {
  return Buffer.concat(
    lines.map((line) => {
      const body = Buffer.from(line);
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(body.length, 4);
      return Buffer.concat([header, body]);
    }),
  );
}

interface SwarmTask {
  Status: { State: string; ContainerStatus?: { ExitCode: number } };
}

interface RunRecord {
  deploymentId: string;
  status: string;
  logPath: string;
  finishedAt: string | null;
  cronRun: { job: string; startedBy: { kind: string } } | null;
}

/**
 * **no run goes on for ever, and none is left "running" for ever
 * after a restart** (ADR-0034). The backend holds every run of a
 * Cron service to its `timeout`, counted from the run's start on the Cron
 * service clock, and picks up at boot the runs a restart left running. The
 * clock stands still and the tick and the recovery are called directly; the
 * Swarm, the machines and the queue are the boundaries.
 */
describe('A Cron service run held to its timeout and through a restart (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;
  let runServerId: string;
  let applicationId: string;
  let appName: string;
  let organizationId: string;

  let now = MONDAY_0200;
  const clock = { now: () => now };

  const queue = new ListQueue();
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  /** The jobs on the Swarm, by name: a removed one is gone. */
  const jobs = new Set<string>();
  /** How a job's tasks read at the Swarm; a job not here reads `running`. */
  const tasks = new Map<string, SwarmTask[]>();
  const removed: string[] = [];
  let output: Buffer;
  const docker = {
    getService: jest.fn((name: string) => ({
      inspect: jest.fn(() =>
        jobs.has(name)
          ? Promise.resolve({ Spec: { Name: name } })
          : Promise.reject(
              Object.assign(new Error('no such service'), { statusCode: 404 }),
            ),
      ),
      remove: jest.fn(() => {
        jobs.delete(name);
        removed.push(name);
        return Promise.resolve();
      }),
      logs: jest.fn(() => Promise.resolve(output)),
    })),
    createService: jest.fn((spec: { Name: string }) => {
      jobs.add(spec.Name);
      return Promise.resolve(undefined);
    }),
    listTasks: jest.fn(({ filters }: { filters: { service: string[] } }) => {
      const [job] = filters.service;
      return Promise.resolve(
        tasks.get(job) ??
          (jobs.has(job) ? [{ Status: { State: 'running' } }] : []),
      );
    }),
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

  async function applyConfig(text: string) {
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
      .send({ planId: plan!.planId });
    expect(applied.status).toBe(200);
  }

  beforeEach(async () => {
    await ctx.resetDb();
    queue.jobs = [];
    jobs.clear();
    tasks.clear();
    removed.length = 0;
    output = framed('report: 42 rows\n');
    docker.createService.mockClear();
    getRemoteDocker.mockClear();
    execMock.execAsync.mockReset().mockImplementation(succeeds);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        succeeds(command),
      );
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
    [{ organizationId }] = await ctx.db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, ownerId));

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
  });

  /** Applies the config, puts the Cron service on a Server, and builds it. */
  async function cronService(text = REPORT) {
    await applyConfig(text);
    const [runner] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'runner',
        ipAddress: '203.0.113.20',
        port: 22,
        organizationId,
      })
      .returning();
    runServerId = runner.serverId;
    const [cron] = await ctx.db
      .update(application)
      .set({ serverId: runServerId })
      .where(eq(application.environmentId, environmentId))
      .returning();
    applicationId = cron.applicationId;
    appName = cron.appName;
    await ctx.db
      .update(deployment)
      .set({ status: 'done' })
      .where(eq(deployment.applicationId, applicationId));
  }

  async function recordOf(deploymentId: string): Promise<RunRecord> {
    const [row] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId));
    return row;
  }

  /** What was written into a log file, as lines in order, on the run Server. */
  function logLines(logPath: string): string[] {
    return (execMock.execAsyncRemote.mock.calls as [string, string][])
      .filter(
        ([on, command]) => on === runServerId && command.includes(logPath),
      )
      .map(([, command]) => {
        const appended = /^echo (\S+) \| base64 -d >> /.exec(command);
        if (appended) {
          return Buffer.from(appended[1].replace(/\\/g, ''), 'base64').toString(
            'utf8',
          );
        }
        const initialized = /; echo (.+) >> \S+;$/.exec(command);
        return `${initialized![1].replace(/^"|"$/g, '')}\n`;
      })
      .join('')
      .trimEnd()
      .split('\n');
  }

  /**
   * A Run record a Cloudgate that has since restarted left `running`: no
   * process is watching it. Its job is on the Swarm when `present`.
   */
  async function leftRunning(
    startedAt: number,
    present: boolean,
  ): Promise<RunRecord> {
    const deploymentId = nanoid();
    const job = `${appName}-run-${deploymentId.slice(0, 8).toLowerCase()}`;
    if (present) jobs.add(job);
    const [row] = await ctx.db
      .insert(deployment)
      .values({
        deploymentId,
        applicationId,
        cronRun: {
          job,
          image: `${appName}:latest`,
          startedBy: { kind: 'timetable' },
        },
        title: 'Timetable run',
        description: 'Run of report, started by the timetable',
        status: 'running',
        logPath: `${deploymentLogsDirectoryOn(runServerId, appName)}/${deploymentId}.log`,
        startedAt: new Date(startedAt).toISOString(),
      })
      .returning();
    return row;
  }

  it('stops a timetable run that reaches its timeout, records it failed and ends its log "timed out after 1h"', async () => {
    await cronService();
    now = MONDAY_0300 + 5_000;
    const [record] = await timetable().tick();
    const { job } = record.cronRun!;
    expect(jobs.has(job)).toBe(true);

    // A second short of its limit, it goes on.
    now = MONDAY_0300 + 5_000 + HOUR - 1_000;
    await timetable().tick();
    expect((await recordOf(record.deploymentId)).status).toBe('running');
    expect(removed).toEqual([]);

    now = MONDAY_0300 + 5_000 + HOUR;
    await timetable().tick();
    await runs().whenSettled(record.deploymentId);

    const row = await recordOf(record.deploymentId);
    expect(row.status).toBe('error');
    expect(row.finishedAt).not.toBeNull();
    expect(removed).toEqual([job]);
    const lines = logLines(row.logPath);
    expect(lines[0]).toContain('started by the timetable');
    // Its output so far is kept, read before its job went.
    expect(lines).toContain('report: 42 rows');
    expect(lines[lines.length - 1]).toBe('timed out after 1h');
    expect(lines.filter((line) => line.startsWith('exit code'))).toEqual([]);
  });

  it('keeps a run recorded running while its Server cannot be reached at its timeout, and stops it at the next tick that can', async () => {
    await cronService();
    now = MONDAY_0300 + 5_000;
    const [record] = await timetable().tick();
    const { job } = record.cronRun!;

    now += HOUR;
    getRemoteDocker.mockRejectedValueOnce(new Error('connection refused'));
    await timetable().tick();

    // Never recorded as over while its job may still be going.
    expect((await recordOf(record.deploymentId)).status).toBe('running');
    expect(removed).toEqual([]);

    now += 10_000;
    await timetable().tick();
    await runs().whenSettled(record.deploymentId);

    const row = await recordOf(record.deploymentId);
    expect(row.status).toBe('error');
    expect(removed).toEqual([job]);
    const lines = logLines(row.logPath);
    expect(lines[lines.length - 1]).toBe('timed out after 1h');
  });

  it('holds a Run now run to the same timeout', async () => {
    await cronService(
      REPORT.replace('    source:', '    timeout: 30m\n    source:'),
    );
    now = MONDAY_0200 + 10 * MINUTE;
    const res = await request(server)
      .post(`/applications/${applicationId}/run`)
      .set('Cookie', cookie);
    expect(res.status).toBe(201);
    const record = res.body as RunRecord;

    now += 30 * MINUTE;
    await timetable().tick();
    await runs().whenSettled(record.deploymentId);

    const row = await recordOf(record.deploymentId);
    expect(row.status).toBe('error');
    expect(removed).toEqual([record.cronRun!.job]);
    const lines = logLines(row.logPath);
    expect(lines[0]).toContain('started by Grace Hopper');
    expect(lines[lines.length - 1]).toBe('timed out after 30m');
  });

  it('keeps the ending of a run that ended before its timeout', async () => {
    await cronService();
    now = MONDAY_0300 + 5_000;
    const [record] = await timetable().tick();
    tasks.set(record.cronRun!.job, [
      { Status: { State: 'complete', ContainerStatus: { ExitCode: 0 } } },
    ]);
    await runs().whenSettled(record.deploymentId);

    now += 2 * HOUR;
    await timetable().tick();

    const row = await recordOf(record.deploymentId);
    expect(row.status).toBe('done');
    const lines = logLines(row.logPath);
    expect(lines[lines.length - 1]).toBe('exit code 0');
    expect(lines).not.toContain('timed out after 1h');
  });

  describe('after a restart', () => {
    beforeEach(async () => {
      await cronService();
      now = MONDAY_0300 + 5 * HOUR;
    });

    it('stops at once a run whose job is still there and which is past its limit from its original start', async () => {
      const record = await leftRunning(now - 2 * HOUR, true);

      await timetable().recover();
      await runs().whenSettled(record.deploymentId);

      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      expect(removed).toEqual([record.cronRun!.job]);
      const lines = logLines(row.logPath);
      expect(lines).toContain('report: 42 rows');
      expect(lines[lines.length - 1]).toBe('timed out after 1h');
    });

    it('watches again a run whose job is still there, its limit counted from its original start', async () => {
      const record = await leftRunning(now - 40 * MINUTE, true);

      await timetable().recover();
      expect((await recordOf(record.deploymentId)).status).toBe('running');
      expect(removed).toEqual([]);

      // 20 minutes on, not a fresh hour: it started 40 minutes before boot.
      now += 20 * MINUTE;
      await timetable().tick();
      await runs().whenSettled(record.deploymentId);

      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      expect(removed).toEqual([record.cronRun!.job]);
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toBe('timed out after 1h');
    });

    it('settles from its exit code a run that ended while Cloudgate was down', async () => {
      const record = await leftRunning(now - 10 * MINUTE, true);
      tasks.set(record.cronRun!.job, [
        { Status: { State: 'failed', ContainerStatus: { ExitCode: 3 } } },
      ]);

      await timetable().recover();
      await runs().whenSettled(record.deploymentId);

      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      expect(removed).toEqual([record.cronRun!.job]);
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toBe('exit code 3');
    });

    it.each([
      [0, 'done'],
      [2, 'error'],
    ])(
      'records a run whose job is gone from its exit status: exit code %i is %s',
      async (exitCode, status) => {
        const record = await leftRunning(now - 10 * MINUTE, false);
        tasks.set(record.cronRun!.job, [
          {
            Status: {
              State: exitCode === 0 ? 'complete' : 'failed',
              ContainerStatus: { ExitCode: exitCode },
            },
          },
        ]);

        await timetable().recover();

        const row = await recordOf(record.deploymentId);
        expect(row.status).toBe(status);
        expect(row.finishedAt).not.toBeNull();
        const lines = logLines(row.logPath);
        expect(lines[lines.length - 1]).toBe(`exit code ${exitCode}`);
      },
    );

    it('records as lost a run whose job is gone with no exit status', async () => {
      const record = await leftRunning(now - 10 * MINUTE, false);

      await timetable().recover();

      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      expect(row.finishedAt).not.toBeNull();
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toMatch(/^lost: /);
    });

    it('leaves alone a run this process is still watching', async () => {
      now = MONDAY_0300 - 5_000;
      timetable().arm();
      now += 10_000;
      const [record] = await timetable().tick();

      await timetable().recover();

      expect((await recordOf(record.deploymentId)).status).toBe('running');
      const lines = logLines(record.logPath);
      expect(lines.some((line) => line.includes('restarted'))).toBe(false);

      tasks.set(record.cronRun!.job, [
        { Status: { State: 'complete', ContainerStatus: { ExitCode: 0 } } },
      ]);
      await runs().whenSettled(record.deploymentId);
    });
  });
});
