import type { ContainerTaskSpec, CreateServiceOptions } from 'dockerode';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { CronRunsService } from '../../src/cron-services/cron-runs.service';
import {
  application,
  deployment,
  licenseKey,
  member,
  organizationRole,
  postgres,
  registry,
  server as serverTable,
} from '../../src/db/schema';
import { logsDirectoryOn } from '../../src/deployment-engine/deployment-engine.paths';
import { mechanizeDockerContainer } from '../../src/deployment-engine/mechanize';
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

const REPORT = `version: 1
services:
  report:
    kind: cron
    command: node dist/report.js
    schedule: "0 3 * * MON-FRI"
    source:
      git: https://git.example.com/acme/report.git
`;

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

/** A service spec as the Swarm boundary is handed it. */
type ServiceSpec = CreateServiceOptions & {
  TaskTemplate: ContainerTaskSpec & {
    ContainerSpec: NonNullable<ContainerTaskSpec['ContainerSpec']>;
  };
};

interface RunRecord {
  deploymentId: string;
  status: string;
  title: string;
  description: string;
  logPath: string;
  applicationId: string | null;
  cronRun: {
    job: string;
    image: string;
    startedBy: { kind: string; userId?: string; name?: string };
  } | null;
}

/**
 * **Run now** on a Cron service (ADR-0034). A run is a
 * one-off Swarm job from the spec a `web` deploys with and the image of the
 * last successful build, recorded as a Run record under the Cron service and
 * logged on the Server that ran it. The Swarm, the machines and the queue
 * are the boundaries.
 */
describe('Run now on a Cron service (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let ownerId: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  let runServerId: string;
  let buildServerId: string;
  let applicationId: string;
  /** The image a run of it starts from: its build, pushed to the Registry. */
  let image: string;

  const queue = new ListQueue();
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  /** How the next job's task ends. */
  let ending: { State: string; ContainerStatus?: { ExitCode: number } };
  let output: Buffer;
  const removed: string[] = [];
  const docker = {
    getService: jest.fn((name: string) => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such service')),
      update: jest.fn(),
      remove: jest.fn(() => {
        removed.push(name);
        return Promise.resolve();
      }),
      logs: jest.fn(() => Promise.resolve(output)),
    })),
    createService: jest.fn().mockResolvedValue(undefined),
    listTasks: jest.fn(() => Promise.resolve([{ Status: ending }])),
  };
  const getRemoteDocker = jest.fn().mockResolvedValue(docker);

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: { getRemoteDocker } },
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

  beforeEach(async () => {
    await ctx.resetDb();
    queue.jobs = [];
    removed.length = 0;
    ending = { State: 'complete', ContainerStatus: { ExitCode: 0 } };
    output = framed('report: 42 rows\n');
    docker.createService.mockClear();
    docker.getService.mockClear();
    docker.listTasks.mockClear();
    getRemoteDocker.mockClear();
    execMock.execAsync.mockReset().mockImplementation(succeeds);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        succeeds(command),
      );

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

    const saved = await request(server)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: REPORT });
    expect(saved.status).toBe(201);
    const plan = (
      saved.body as { plans: { planId: string; environmentId: string }[] }
    ).plans.find((each) => each.environmentId === environmentId);
    const applied = await request(server)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: plan!.planId });
    expect(applied.status).toBe(200);

    // It runs on one Server and builds on another, through a Registry, with
    // the settings a run must carry over from the `web` path.
    const servers = await ctx.db
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
    runServerId = servers[0].serverId;
    buildServerId = servers[1].serverId;
    const [hub] = await ctx.db
      .insert(registry)
      .values({
        organizationId,
        name: 'Registry',
        username: 'acme',
        password: 'registry-password',
        url: 'registry.example.com',
        imagePrefix: 'acme',
      })
      .returning();
    const [cron] = await ctx.db
      .update(application)
      .set({
        serverId: runServerId,
        buildServerId,
        registryId: hub.registryId,
        env: 'REPORT_TO=ops@example.com',
        memoryLimit: '268435456',
        cpuLimit: '0.5',
        placementSwarm: { Constraints: ['node.labels.tier==batch'] },
      })
      .where(eq(application.environmentId, environmentId))
      .returning();
    applicationId = cron.applicationId;
    image = `registry.example.com/acme/${cron.appName}:latest`;
  });

  /** The Cron service's Build deployment, succeeded. */
  async function buildSucceeds() {
    await ctx.db
      .update(deployment)
      .set({ status: 'done' })
      .where(eq(deployment.applicationId, applicationId));
  }

  const runNow = (as = cookie) =>
    request(server)
      .post(`/applications/${applicationId}/run`)
      .set('Cookie', as);

  async function ranAndSettled(as = cookie): Promise<RunRecord> {
    const res = await runNow(as);
    expect(res.status).toBe(201);
    const record = res.body as RunRecord;
    await ctx.app.get(CronRunsService).whenSettled(record.deploymentId);
    return record;
  }

  async function runRecords(): Promise<RunRecord[]> {
    const rows = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.applicationId, applicationId));
    return rows.filter((row) => row.cronRun !== null) as RunRecord[];
  }

  /** What was written into a log file, in order, on the machine named. */
  function logOf(logPath: string, serverId: string): string {
    return (execMock.execAsyncRemote.mock.calls as [string, string][])
      .filter(([on, command]) => on === serverId && command.includes(logPath))
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
      .join('');
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

  it('writes a Run record under the Cron service and creates a job from the web path spec and the last build image', async () => {
    await buildSucceeds();

    const record = await ranAndSettled();

    expect(record).toMatchObject({
      applicationId,
      title: 'Run now',
      cronRun: {
        image,
        startedBy: { kind: 'member', userId: ownerId, name: 'Grace Hopper' },
      },
    });
    const { job } = record.cronRun!;
    const [{ appName }] = await ctx.db
      .select({ appName: application.appName })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    expect(job).toMatch(new RegExp(`^${appName}-run-[0-9a-z]{8}$`));
    expect(record.description).toBe('Run of report, started by Grace Hopper');
    expect(getRemoteDocker).toHaveBeenCalledWith(runServerId);

    expect(docker.createService).toHaveBeenCalledTimes(1);
    const [authconfig, spec] = docker.createService.mock.calls[0] as [
      Record<string, unknown>,
      ServiceSpec,
    ];
    expect(spec.Name).toBe(job);
    expect(spec.Mode).toEqual({
      ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 },
    });
    expect(spec.TaskTemplate.RestartPolicy).toEqual({ Condition: 'none' });
    expect(spec.TaskTemplate.ContainerSpec.Image).toBe(image);
    expect(spec).not.toHaveProperty('EndpointSpec');
    expect(spec).not.toHaveProperty('UpdateConfig');

    // The same spec the `web` path releases this Application with.
    const web = {
      getService: () => ({
        inspect: () => Promise.reject(new Error('no such service')),
      }),
      createService: jest.fn().mockResolvedValue(undefined),
    };
    const deployable = await ctx.app
      .get(ApplicationsService)
      .findDeployable(applicationId);
    await mechanizeDockerContainer(deployable, web as never);
    const [webAuth, webSpec] = web.createService.mock.calls[0] as [
      Record<string, unknown>,
      ServiceSpec,
    ];
    expect(authconfig).toEqual(webAuth);
    expect(authconfig).toMatchObject({ username: 'acme' });
    for (const field of [
      'Networks',
      'Placement',
      'Resources',
      'LogDriver',
    ] as const) {
      expect(spec.TaskTemplate[field]).toEqual(webSpec.TaskTemplate[field]);
    }
    expect(spec.TaskTemplate.ContainerSpec.Env).toEqual(
      webSpec.TaskTemplate.ContainerSpec.Env,
    );
    expect(spec.TaskTemplate.ContainerSpec.Env).toContain(
      'REPORT_TO=ops@example.com',
    );
    expect(spec.TaskTemplate.ContainerSpec.Command).toEqual([
      'node',
      'dist/report.js',
    ]);
    expect(spec.TaskTemplate.Placement?.Constraints).toContain(
      'node.labels.tier==batch',
    );
    expect(spec.TaskTemplate.Resources).toMatchObject({
      Limits: { MemoryBytes: 268435456 },
    });
  });

  it("starts from the image the last successful build pinned, not the Service's moving tag", async () => {
    const [first] = await ctx.db
      .update(deployment)
      .set({
        status: 'done',
        cronImage: `${image.split(':latest')[0]}@sha256:first`,
        finishedAt: '2026-09-28T01:00:00.000Z',
      })
      .where(eq(deployment.applicationId, applicationId))
      .returning();
    const later = (
      status: 'done' | 'error',
      finishedAt: string,
      pin?: string,
    ) =>
      ctx.db.insert(deployment).values({
        deploymentId: `${status}-${finishedAt.slice(11, 13)}`,
        applicationId,
        title: 'Build',
        status,
        logPath: `${first.logPath}.${status}`,
        cronImage: pin ?? null,
        finishedAt,
      });
    const pinned = `${image.split(':latest')[0]}@sha256:second`;
    await later('done', '2026-09-28T02:00:00.000Z', pinned);
    // A later build that failed, after it may have moved `:latest`.
    await later('error', '2026-09-28T03:00:00.000Z');

    const record = await ranAndSettled();

    expect(record.cronRun!.image).toBe(pinned);
    const [, spec] = docker.createService.mock.calls[0] as [
      Record<string, unknown>,
      ServiceSpec,
    ];
    expect(spec.TaskTemplate.ContainerSpec.Image).toBe(pinned);
  });

  it('hands a run the wired variables its config entry links, built from their source as a deploy builds them', async () => {
    const apply = async (text: string) => {
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
    };
    const PG = `  pg-1:
    kind: postgres
    database: shop
    user: shop
`;
    // A postgres beside it on its run Server, then the Cron service linking
    // the postgres's Output.
    await apply(`${REPORT}${PG}`);
    const [pg] = await ctx.db
      .update(postgres)
      .set({ serverId: runServerId })
      .returning();
    await apply(`${REPORT}    env: [{ DATABASE_URL: pg-1.url }]\n${PG}`);
    await buildSucceeds();

    await ranAndSettled();

    const [, spec] = docker.createService.mock.calls[0] as [
      Record<string, unknown>,
      ServiceSpec,
    ];
    expect(spec.TaskTemplate.ContainerSpec.Env).toContain(
      `DATABASE_URL=postgresql://shop:${encodeURIComponent(pg.databasePassword)}@${pg.appName}:5432/shop`,
    );
  });

  it('refuses a member without deployment: create, and writes nothing', async () => {
    await buildSucceeds();
    const reader = await memberWith(['read']);

    const res = await runNow(reader);

    expect(res.status).toBe(403);
    expect(await runRecords()).toEqual([]);
    expect(docker.createService).not.toHaveBeenCalled();
  });

  it('runs for a member with deployment: create, recording who started it', async () => {
    await buildSucceeds();
    const runner = await memberWith(['read', 'create']);

    const record = await ranAndSettled(runner);

    expect(record.cronRun?.startedBy).toMatchObject({
      kind: 'member',
      name: 'Ida Rhodes',
    });
    expect(await runRecords()).toHaveLength(1);
  });

  it('refuses with "waiting for first build" while no build has succeeded, and writes nothing', async () => {
    const res = await runNow();

    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toContain(
      'waiting for first build',
    );
    expect(await runRecords()).toEqual([]);
    expect(docker.createService).not.toHaveBeenCalled();
    expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
  });

  it('does not count a run as the first build', async () => {
    await buildSucceeds();
    await ranAndSettled();
    await ctx.db
      .update(deployment)
      .set({ status: 'error' })
      .where(
        and(
          eq(deployment.applicationId, applicationId),
          eq(deployment.title, 'Plan applied'),
        ),
      );

    const res = await runNow();

    expect(res.status).toBe(409);
  });

  it('creates two differently named jobs for two Run nows in a row, and records both', async () => {
    await buildSucceeds();

    const first = await ranAndSettled();
    const second = await ranAndSettled();

    const names = (docker.createService.mock.calls as unknown[][]).map(
      (call) => (call[call.length - 1] as { Name: string }).Name,
    );
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(names).toEqual([first.cronRun!.job, second.cronRun!.job]);
    expect((await runRecords()).map((row) => row.deploymentId).sort()).toEqual(
      [first.deploymentId, second.deploymentId].sort(),
    );
  });

  it.each([
    [0, 'done'],
    [3, 'error'],
  ])(
    'records exit code %i as %s, removes the job, and logs the image and starter first and the exit code last',
    async (exitCode, status) => {
      await buildSucceeds();
      ending = {
        State: exitCode === 0 ? 'complete' : 'failed',
        ContainerStatus: { ExitCode: exitCode },
      };

      const record = await ranAndSettled();

      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, record.deploymentId));
      expect(row.status).toBe(status);
      expect(row.finishedAt).not.toBeNull();
      expect(removed).toEqual([record.cronRun!.job]);

      // On the Server that ran it, in the usual place, so ADR-0020's sweep
      // of every Server's logs tree takes it with the rest.
      expect(row.logPath.startsWith(`${logsDirectoryOn(runServerId)}/`)).toBe(
        true,
      );
      expect(row.logPath.endsWith('.log')).toBe(true);
      const lines = logOf(row.logPath, runServerId).trimEnd().split('\n');
      expect(lines[0]).toContain(`'${image}'`);
      expect(lines[0]).toContain('started by Grace Hopper');
      expect(lines).toContain('report: 42 rows');
      expect(lines[lines.length - 1]).toBe(`exit code ${exitCode}`);
      expect(
        (execMock.execAsyncRemote.mock.calls as [string, string][]).filter(
          ([on, command]) =>
            on === buildServerId && command.includes(row.logPath),
        ),
      ).toEqual([]);
    },
  );

  it('reads a run log from the Server that ran it', async () => {
    await buildSucceeds();
    const record = await ranAndSettled();
    execMock.execAsyncRemote.mockClear();

    const res = await request(server)
      .get(`/deployments/${record.deploymentId}/logs`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    const reads = (execMock.execAsyncRemote.mock.calls as [string, string][])
      .filter(([, command]) => command.includes(record.logPath))
      .map(([on]) => on);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set([runServerId]));
  });

  it('lists the run under the Cron service, marked as a run, in both deployment feeds', async () => {
    await buildSucceeds();
    const record = await ranAndSettled();

    const organization = await request(server)
      .get('/deployments')
      .set('Cookie', cookie);
    expect(organization.status).toBe(200);
    const environmentFeed = await request(server)
      .get(`/environments/${environmentId}/deployments`)
      .set('Cookie', cookie);
    expect(environmentFeed.status).toBe(200);

    type FeedRow = RunRecord & {
      owner: { type: string; id: string; name: string };
    };
    for (const rows of [
      (organization.body as { rows: FeedRow[] }).rows,
      environmentFeed.body as FeedRow[],
    ]) {
      const run = rows.find((row) => row.deploymentId === record.deploymentId);
      const build = rows.find(
        (row) => row.deploymentId !== record.deploymentId,
      );
      expect(run).toMatchObject({
        owner: { type: 'application', id: applicationId, name: 'report' },
        cronRun: { job: record.cronRun!.job },
      });
      expect(build).toMatchObject({
        owner: { type: 'application', id: applicationId },
        cronRun: null,
      });
    }
  });

  it('is refused on a Service that is not a Cron service', async () => {
    await ctx.db
      .update(application)
      .set({
        configKind: 'web',
        cronSchedule: null,
        cronTimezone: null,
        cronTimeoutSeconds: null,
      })
      .where(eq(application.applicationId, applicationId));
    await buildSucceeds();

    const res = await runNow();

    expect(res.status).toBe(409);
    expect(await runRecords()).toEqual([]);
  });
});
