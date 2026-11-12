import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  deployment,
  domain,
  member,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
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

interface FieldDiff {
  field: string;
  from: unknown;
  to: unknown;
}

interface PlanBody {
  planId: string;
  environmentId: string;
  status: string;
  steps: {
    action: string;
    configName: string;
    kind: string;
    fields?: FieldDiff[];
  }[];
  results:
    | {
        configName: string;
        action: string;
        status: string;
        serviceId: string | null;
        domain: string | null;
        deploy: { status: string; deploymentId?: string } | null;
      }[]
    | null;
}

interface CronServiceRead {
  schedule: string;
  timezone: string;
  timeout: string;
  timeoutSeconds: number;
  nextFireTimes: string[];
  waitingForFirstBuild: boolean;
}

/** The deployment queue as a list: a queued job is asserted, never run. */
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

/** A Cron service at 03:00 UTC on weekdays, built from a custom git URL. */
const REPORT = `version: 1
services:
  report:
    kind: cron
    command: node dist/report.js
    schedule: "0 3 * * MON-FRI"
    source:
      git: https://git.example.com/acme/report.git
`;

/** The same Service as a `web`. */
const REPORT_AS_WEB = `version: 1
services:
  report:
    kind: web
    source:
      git: https://git.example.com/acme/report.git
`;

/**
 * A `kind: cron` entry, planned and applied (ADR-0034). The
 * Cron service is an Application with the cron kind recorded and its
 * timetable as config-owned fields; its builds are ordinary Build
 * deployments, and until one succeeds it is waiting for its first build.
 * It does not fire yet. The deployment queue, the Swarm and the
 * machines are the boundaries.
 */
describe('A Cron service from the Project config (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;

  const queue = new ListQueue();
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  const docker = {
    getService: jest.fn(() => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such service')),
      update: jest.fn(),
    })),
    createService: jest.fn().mockResolvedValue(undefined),
    listTasks: jest.fn().mockResolvedValue([{ Status: { State: 'running' } }]),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        { provide: RemoteExecService, useValue: execMock },
        {
          provide: RemoteDockerFactory,
          useValue: { getRemoteDocker: jest.fn().mockResolvedValue(docker) },
        },
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
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');

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
    // The platform host's public address, which a `web`'s generated Domain
    // carries; a Cron service gets none.
    await ctx.db.insert(webServerSettings).values({ serverIp: '198.51.100.7' });
  });

  async function planFor(text: string) {
    const saved = await request(server)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });
    expect(saved.status).toBe(201);
    const found = (saved.body as { plans: PlanBody[] }).plans.find(
      (plan) => plan.environmentId === environmentId,
    );
    expect(found).toBeDefined();
    return found as PlanBody;
  }

  const apply = (planId: string, confirmDestroy?: string[], as = cookie) =>
    request(server)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', as)
      .send(
        confirmDestroy === undefined ? { planId } : { planId, confirmDestroy },
      );

  async function applied(text: string) {
    const open = await planFor(text);
    const res = await apply(open.planId);
    expect(res.status).toBe(200);
    const body = res.body as PlanBody;
    expect(body.status).toBe('applied');
    return body;
  }

  async function cronRow() {
    const [row] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.environmentId, environmentId));
    return row;
  }

  async function read(applicationId: string) {
    const res = await request(server)
      .get(`/applications/${applicationId}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as {
      configKind: string;
      cronService: CronServiceRead | null;
    };
  }

  describe('planning and applying', () => {
    it('plans a create showing its command and schedule', async () => {
      const open = await planFor(REPORT);

      expect(open.steps).toEqual([
        expect.objectContaining({
          action: 'create',
          configName: 'report',
          kind: 'cron',
          fields: [
            { field: 'command', from: null, to: 'node dist/report.js' },
            { field: 'schedule', from: null, to: '0 3 * * MON-FRI' },
            {
              field: 'source',
              from: null,
              to: { git: 'https://git.example.com/acme/report.git', path: '/' },
            },
          ],
        }),
      ]);
    });

    it('creates the Cron service with its timetable, no Domain, and its Build deployment queued', async () => {
      const body = await applied(REPORT);

      const row = await cronRow();
      expect(row).toMatchObject({
        configName: 'report',
        configKind: 'cron',
        command: 'node dist/report.js',
        cronSchedule: '0 3 * * MON-FRI',
        cronTimezone: 'UTC',
        cronTimeoutSeconds: 3600,
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/acme/report.git',
        configPlanId: body.planId,
      });
      expect(
        await ctx.db
          .select()
          .from(domain)
          .where(eq(domain.applicationId, row.applicationId)),
      ).toEqual([]);

      const [result] = body.results ?? [];
      expect(result).toMatchObject({ action: 'create', domain: null });
      const builds = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.applicationId, row.applicationId));
      expect(builds).toHaveLength(1);
      expect(builds[0].status).toBe('pending');
      expect(result.deploy).toEqual({
        status: 'queued',
        deploymentId: builds[0].deploymentId,
      });
      expect(queue.jobs.map((job) => job.data.deploymentId)).toEqual([
        builds[0].deploymentId,
      ]);
    });

    it('writes a stated timezone and timeout', async () => {
      await applied(`${REPORT}    timezone: Europe/Berlin\n    timeout: 30m\n`);

      expect(await cronRow()).toMatchObject({
        cronTimezone: 'Europe/Berlin',
        cronTimeoutSeconds: 1800,
      });
    });

    it.each([
      [
        'schedule',
        REPORT.replace('0 3 * * MON-FRI', '*/30 * * * *'),
        { field: 'schedule', from: '0 3 * * MON-FRI', to: '*/30 * * * *' },
        { cronSchedule: '*/30 * * * *' },
      ],
      [
        'timezone',
        `${REPORT}    timezone: Asia/Tokyo\n`,
        { field: 'timezone', from: 'UTC', to: 'Asia/Tokyo' },
        { cronTimezone: 'Asia/Tokyo' },
      ],
      [
        'timeout',
        `${REPORT}    timeout: 2h\n`,
        { field: 'timeout', from: '1h', to: '2h' },
        { cronTimeoutSeconds: 7200 },
      ],
    ])(
      'plans a change of its %s in place, and Apply writes it',
      async (_field, text, diff, written) => {
        await applied(REPORT);
        const before = await cronRow();

        const open = await planFor(text);
        expect(open.steps).toEqual([
          expect.objectContaining({
            action: 'change',
            configName: 'report',
            kind: 'cron',
            fields: [diff],
          }),
        ]);
        const res = await apply(open.planId);

        expect(res.status).toBe(200);
        const after = await cronRow();
        expect(after.applicationId).toBe(before.applicationId);
        expect(after).toMatchObject(written);
      },
    );

    it('plans nothing once applied', async () => {
      await applied(`${REPORT}    timeout: 90m\n`);

      expect((await planFor(`${REPORT}    timeout: 90m\n`)).steps).toEqual([]);
    });
  });

  describe('a kind change to or from cron', () => {
    it('destroys a web and creates a Cron service, confirmed by name', async () => {
      await applied(REPORT_AS_WEB);
      const web = await cronRow();
      expect(web.configKind).toBe('web');

      const open = await planFor(REPORT);
      expect(open.steps.map((step) => [step.action, step.kind])).toEqual([
        ['destroy', 'web'],
        ['create', 'cron'],
      ]);
      const refused = await apply(open.planId);
      expect(refused.status).toBe(409);
      expect((refused.body as { code: string }).code).toBe(
        'PLAN_DESTROY_NOT_CONFIRMED',
      );

      const res = await apply(open.planId, ['report']);

      expect(res.status).toBe(200);
      const rows = await ctx.db
        .select({
          applicationId: application.applicationId,
          configKind: application.configKind,
        })
        .from(application);
      expect(rows).toHaveLength(1);
      expect(rows[0].configKind).toBe('cron');
      expect(rows[0].applicationId).not.toBe(web.applicationId);
    });

    it('destroys a Cron service and creates a web, confirmed by name', async () => {
      await applied(REPORT);

      const open = await planFor(REPORT_AS_WEB);
      expect(open.steps.map((step) => [step.action, step.kind])).toEqual([
        ['destroy', 'cron'],
        ['create', 'web'],
      ]);
      const res = await apply(open.planId, ['report']);

      expect(res.status).toBe(200);
      expect(await cronRow()).toMatchObject({
        configKind: 'web',
        cronSchedule: null,
        cronTimezone: null,
        cronTimeoutSeconds: null,
      });
    });
  });

  /**
   * A Cron service has no Swarm service: each run is a one-off job that
   * publishes nothing, so a Domain, a published port or a preview could
   * never reach it, and each is refused, pointing to the kind.
   */
  describe('what it refuses, through the API', () => {
    const send = (method: 'post' | 'patch', path: string, body: object) =>
      request(server)[method](path).set('Cookie', cookie).send(body);
    const refusal = (res: request.Response) =>
      res.body as { code?: string; message: string };

    it('refuses a Domain, a published port and the preview switches, naming the way out', async () => {
      await applied(REPORT);
      const { applicationId } = await cronRow();

      const withDomain = await send('post', '/domains', {
        host: 'report.example.com',
        applicationId,
        domainType: 'application',
        port: 3000,
      });
      expect(withDomain.status).toBe(409);
      expect(refusal(withDomain)).toMatchObject({
        code: 'KIND_TAKES_NO_DOMAIN',
        message: expect.stringContaining('change its kind to web') as string,
      });
      expect(
        await ctx.db
          .select()
          .from(domain)
          .where(eq(domain.applicationId, applicationId)),
      ).toEqual([]);

      const withPort = await send('post', '/ports', {
        applicationId,
        publishedPort: 8080,
        targetPort: 3000,
      });
      expect(withPort.status).toBe(409);
      expect(refusal(withPort).code).toBe('KIND_PUBLISHES_NO_PORT');

      for (const flag of [
        'isPreviewDeploymentsActive',
        'requestedPreviewsAllowed',
      ]) {
        const on = await send('patch', `/applications/${applicationId}`, {
          [flag]: true,
        });
        expect(on.status).toBe(409);
        expect(refusal(on).code).toBe('KIND_TAKES_NO_PREVIEWS');
      }
    });

    it('refuses a health check, a restart policy, an update and a rollback in its Swarm settings, with the plan’s reasons', async () => {
      await applied(REPORT);
      const { applicationId } = await cronRow();

      for (const [body, reason] of [
        [{ healthCheckSwarm: { Test: ['CMD', 'true'] } }, 'exit code'],
        [{ restartPolicySwarm: { Condition: 'any' } }, 'never retried'],
        [
          { updateConfigSwarm: { Parallelism: 1, Order: 'start-first' } },
          'no copies to update',
        ],
        [
          { rollbackConfigSwarm: { Parallelism: 1, Order: 'start-first' } },
          'nothing to roll back',
        ],
      ] as const) {
        const saved = await send(
          'patch',
          `/applications/${applicationId}`,
          body,
        );
        expect(saved.status).toBe(409);
        expect(refusal(saved)).toMatchObject({
          code: 'KIND_TAKES_NO_SWARM_SETTING',
          message: expect.stringContaining(reason) as string,
        });
      }
      expect(await cronRow()).toMatchObject({
        healthCheckSwarm: null,
        restartPolicySwarm: null,
        updateConfigSwarm: null,
        rollbackConfigSwarm: null,
      });
    });
  });

  describe('native.docker', () => {
    const NATIVE = `${REPORT}    native:
      docker:
        Labels:
          com.example.team: billing
        StopGracePeriod: 20000000000
        Ulimits:
          - Name: nofile
            Soft: 1024
            Hard: 2048
`;

    it('plans its labels, stop grace and ulimits, writes the Swarm columns, plans nothing next, and puts them back when removed', async () => {
      const open = await planFor(NATIVE);
      expect(open.steps).toEqual([
        expect.objectContaining({
          action: 'create',
          configName: 'report',
          fields: expect.arrayContaining([
            expect.objectContaining({
              field: 'native.docker.Labels."com.example.team"',
              to: 'billing',
              native: true,
            }),
            expect.objectContaining({
              field: 'native.docker.StopGracePeriod',
              to: 20_000_000_000,
              native: true,
            }),
            expect.objectContaining({
              field: 'native.docker.Ulimits',
              native: true,
            }),
          ]) as unknown,
        }),
      ]);
      expect((await apply(open.planId)).status).toBe(200);
      expect(await cronRow()).toMatchObject({
        labelsSwarm: { 'com.example.team': 'billing' },
        stopGracePeriodSwarm: 20_000_000_000,
        ulimitsSwarm: [{ Name: 'nofile', Soft: 1024, Hard: 2048 }],
        healthCheckSwarm: null,
        restartPolicySwarm: null,
        updateConfigSwarm: null,
        rollbackConfigSwarm: null,
      });
      expect((await planFor(NATIVE)).steps).toEqual([]);

      const removed = await planFor(REPORT);
      expect(removed.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          fields: expect.arrayContaining([
            expect.objectContaining({
              field: 'native.docker.StopGracePeriod',
              from: 20_000_000_000,
              to: null,
              toDefault: true,
            }),
          ]) as unknown,
        }),
      ]);
      expect((await apply(removed.planId)).status).toBe(200);
      expect(await cronRow()).toMatchObject({
        labelsSwarm: null,
        stopGracePeriodSwarm: null,
        ulimitsSwarm: null,
      });
      expect((await planFor(REPORT)).steps).toEqual([]);
    });

    it('refuses a restart policy by its full path with the reason', async () => {
      const saved = await request(server)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({
          text: `${REPORT}    native:\n      docker:\n        RestartPolicy:\n          Condition: on-failure\n`,
        });
      expect(saved.status).toBe(409);
      expect(JSON.stringify(saved.body)).toContain(
        'report.native.docker.RestartPolicy: refused - a run is never retried; Cloudgate runs it with Condition none',
      );
    });
  });

  describe('its Service read', () => {
    it('reports "waiting for first build" with its timetable and next fire times, and has no Run records', async () => {
      await applied(REPORT);
      const row = await cronRow();
      const asked = Date.now();

      const { configKind, cronService } = await read(row.applicationId);

      expect(configKind).toBe('cron');
      expect(cronService).toMatchObject({
        schedule: '0 3 * * MON-FRI',
        timezone: 'UTC',
        timeout: '1h',
        timeoutSeconds: 3600,
        waitingForFirstBuild: true,
      });
      const times = cronService!.nextFireTimes.map((time) => new Date(time));
      expect(times).toHaveLength(5);
      for (const [index, time] of times.entries()) {
        expect(time.getTime()).toBeGreaterThan(asked);
        expect(time.getUTCHours()).toBe(3);
        expect(time.getUTCMinutes()).toBe(0);
        expect([1, 2, 3, 4, 5]).toContain(time.getUTCDay());
        if (index > 0) expect(time > times[index - 1]).toBe(true);
      }

      // Only its Build deployment: nothing has fired.
      const listed = await request(server)
        .get(`/applications/${row.applicationId}/deployments`)
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      const deployments = listed.body as { title: string; status: string }[];
      expect(deployments).toHaveLength(1);
      expect(deployments[0]).toMatchObject({
        title: 'Plan applied',
        status: 'pending',
      });
    });

    it('is no longer waiting once a Build deployment has succeeded', async () => {
      await applied(REPORT);
      const row = await cronRow();
      await ctx.db
        .update(deployment)
        .set({ status: 'error' })
        .where(eq(deployment.applicationId, row.applicationId));
      expect(
        (await read(row.applicationId)).cronService?.waitingForFirstBuild,
      ).toBe(true);

      await ctx.db
        .update(deployment)
        .set({ status: 'done' })
        .where(eq(deployment.applicationId, row.applicationId));

      expect(
        (await read(row.applicationId)).cronService?.waitingForFirstBuild,
      ).toBe(false);
    });

    it('is null on any other Application', async () => {
      await applied(REPORT_AS_WEB);

      expect((await read((await cronRow()).applicationId)).cronService).toBe(
        null,
      );
    });
  });

  it('checks an Apply against the statements an Application create already needs', async () => {
    const open = await planFor(REPORT);
    // A built-in member holds service: read/update, not create.
    const fixture = await signUpMember(server, cookie);
    await ctx.db
      .update(member)
      .set({
        accessedProjects: [projectId],
        accessedEnvironments: [environmentId],
      })
      .where(eq(member.userId, fixture.id));

    const res = await apply(open.planId, undefined, fixture.cookie);

    expect(res.status).toBe(403);
    expect(await ctx.db.select().from(application)).toHaveLength(0);
    const [still] = await ctx.db
      .select({ status: planTable.status })
      .from(planTable)
      .where(eq(planTable.planId, open.planId));
    expect(still.status).toBe('open');
  });
});
