import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  member,
  mongo,
  plan as planTable,
  postgres,
  projectConfigLocation,
  redis,
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

interface StepResult {
  configName: string;
  action: string;
  status: 'applied' | 'failed';
  message: string | null;
  serviceType: string | null;
  serviceId: string | null;
  leftovers?: Record<string, unknown> | null;
}

interface PlanBody {
  planId: string;
  environmentId: string;
  status: string;
  steps: { action: string; configName: string; kind: string }[];
  notes: { kind: string; configName: string }[];
  results: StepResult[] | null;
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

/**
 * A plan's destroys are applied, confirmed by Config name, each through
 * the existing Delete (ADR-0018), after the creates and changes. The Swarm and
 * the machines are the boundaries: the presence probe decides whether a
 * Delete refuses, and a failed `rm -rf` is a leftover it reports.
 */
describe('Applying a Plan: destroys (e2e)', () => {
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

  /** Every machine command succeeds, and every workload is gone. */
  const machines = (answer: (command: string) => Promise<object> | null) => {
    const run = (command: string) =>
      answer(command) ??
      Promise.resolve(
        isPresenceProbe(command)
          ? { stdout: 'absent', stderr: '' }
          : { stdout: '', stderr: '' },
      );
    execMock.execAsync.mockReset().mockImplementation(run);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) => run(command));
  };

  beforeEach(async () => {
    await ctx.resetDb();
    queue.jobs = [];
    machines(() => null);

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
  });

  const save = (text: string) =>
    request(server)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  const apply = (planId: string, confirmDestroy?: string[], as = cookie) =>
    request(server)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', as)
      .send(
        confirmDestroy === undefined ? { planId } : { planId, confirmDestroy },
      );

  async function planFor(text: string) {
    const saved = await save(text);
    expect(saved.status).toBe(201);
    const found = (saved.body as { plans: PlanBody[] }).plans.find(
      (plan) => plan.environmentId === environmentId,
    );
    expect(found).toBeDefined();
    return found as PlanBody;
  }

  /** A redis made in the console, then the config that lists it applied. */
  async function consoleRedis(name: string) {
    const made = await request(server)
      .post('/redis')
      .set('Cookie', cookie)
      .send({ name, environmentId });
    expect(made.status).toBe(201);
    return (made.body as { redisId: string }).redisId;
  }

  async function planStatus(planId: string) {
    const [row] = await ctx.db
      .select({ status: planTable.status })
      .from(planTable)
      .where(eq(planTable.planId, planId));
    return row.status;
  }

  describe('confirmation', () => {
    it.each([
      ['no confirmation', undefined],
      ['a missing name', []],
      ['an extra name', ['cache', 'db']],
      ['a different name', ['cash']],
    ])(
      'refuses an Apply with %s, writing nothing',
      async (_label, confirmDestroy) => {
        await consoleRedis('cache');
        const open = await planFor('version: 1\nservices: {}\n');
        expect(open.steps).toEqual([
          expect.objectContaining({ action: 'destroy', configName: 'cache' }),
        ]);

        const applied = await apply(open.planId, confirmDestroy);

        expect(applied.status).toBe(409);
        expect((applied.body as { code: string }).code).toBe(
          'PLAN_DESTROY_NOT_CONFIRMED',
        );
        expect((applied.body as { message: string }).message).toMatch(
          confirmDestroy?.includes('cache') ? /db/ : /cache/,
        );
        expect(await ctx.db.select().from(redis)).toHaveLength(1);
        expect(await planStatus(open.planId)).toBe('open');
      },
    );

    it('refuses a confirmation of a plan that destroys nothing', async () => {
      const open = await planFor(
        'version: 1\nservices:\n  db:\n    kind: postgres\n',
      );

      const applied = await apply(open.planId, ['db']);

      expect(applied.status).toBe(409);
      expect((applied.body as { code: string }).code).toBe(
        'PLAN_DESTROY_NOT_CONFIRMED',
      );
      expect(await ctx.db.select().from(postgres)).toHaveLength(0);
    });
  });

  describe('applying', () => {
    it('destroys a Service the config no longer lists, after the creates', async () => {
      await consoleRedis('cache');
      const text = 'version: 1\nservices:\n  db:\n    kind: postgres\n';
      const open = await planFor(text);

      const applied = await apply(open.planId, ['cache']);

      expect(applied.status).toBe(200);
      const body = applied.body as PlanBody;
      expect(body.status).toBe('applied');
      expect(
        body.results?.map((result) => [
          result.action,
          result.configName,
          result.status,
        ]),
      ).toEqual([
        ['create', 'db', 'applied'],
        ['destroy', 'cache', 'applied'],
      ]);
      expect(await ctx.db.select().from(redis)).toHaveLength(0);
      const [row] = await ctx.db
        .select({ text: projectConfigLocation.text })
        .from(projectConfigLocation)
        .where(eq(projectConfigLocation.projectId, projectId));
      expect(row.text).toBe(text);
    });

    it('fails only the step whose Delete refuses, and keeps that Service', async () => {
      const cacheId = await consoleRedis('cache');
      await consoleRedis('queue');
      const [kept] = await ctx.db
        .select({ appName: redis.appName })
        .from(redis)
        .where(eq(redis.redisId, cacheId));
      // `cache`'s workload is still running, so its Delete refuses.
      machines((command) =>
        isPresenceProbe(command) && command.includes(kept.appName)
          ? Promise.resolve({ stdout: 'present', stderr: '' })
          : null,
      );
      const open = await planFor('version: 1\nservices: {}\n');

      const applied = await apply(open.planId, ['queue', 'cache']);

      expect(applied.status).toBe(200);
      const body = applied.body as PlanBody;
      expect(body.status).toBe('partly-applied');
      const byName = new Map(
        body.results?.map((result) => [result.configName, result]),
      );
      expect(byName.get('cache')).toMatchObject({
        action: 'destroy',
        status: 'failed',
        serviceId: cacheId,
      });
      expect(byName.get('cache')?.message).toMatch(/still running/);
      expect(byName.get('queue')).toMatchObject({ status: 'applied' });
      const left = await ctx.db.select({ id: redis.redisId }).from(redis);
      expect(left).toEqual([{ id: cacheId }]);

      // The next plan still destroys it.
      const next = await request(server)
        .post(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie);
      expect((next.body as PlanBody).steps).toEqual([
        expect.objectContaining({ action: 'destroy', configName: 'cache' }),
      ]);
    });

    it('shows the leftovers a Delete reports on its step', async () => {
      await consoleRedis('cache');
      machines((command) =>
        command.startsWith('rm -rf ') && command.endsWith('/files')
          ? Promise.reject(new Error('ssh: connect: no route to host'))
          : null,
      );
      const open = await planFor('version: 1\nservices: {}\n');

      const applied = await apply(open.planId, ['cache']);

      expect(applied.status).toBe(200);
      const [result] = (applied.body as PlanBody).results ?? [];
      expect(result).toMatchObject({
        action: 'destroy',
        status: 'applied',
        leftovers: {
          unreclaimedArtifacts: [
            expect.objectContaining({ kind: 'file-mounts', serverId: null }),
          ],
        },
      });
      expect(await ctx.db.select().from(redis)).toHaveLength(0);
    });

    it('applies a kind change as a destroy plus a create under the same name', async () => {
      await consoleRedis('cache');
      const open = await planFor(
        'version: 1\nservices:\n  cache:\n    kind: postgres\n',
      );
      expect(open.steps.map((step) => [step.action, step.kind])).toEqual([
        ['destroy', 'redis'],
        ['create', 'postgres'],
      ]);

      const refused = await apply(open.planId);
      expect(refused.status).toBe(409);

      const applied = await apply(open.planId, ['cache']);

      expect(applied.status).toBe(200);
      const body = applied.body as PlanBody;
      expect(body.status).toBe('applied');
      expect(
        body.results?.map((result) => [result.action, result.serviceType]),
      ).toEqual([
        ['destroy', 'redis'],
        ['create', 'postgres'],
      ]);
      expect(await ctx.db.select().from(redis)).toHaveLength(0);
      const [made] = await ctx.db
        .select({ configName: postgres.configName })
        .from(postgres);
      expect(made.configName).toBe('cache');
    });

    it('applies a web to static change as a destroy plus a create, matched against the recorded kind', async () => {
      const made = await request(server)
        .post('/applications')
        .set('Cookie', cookie)
        .send({ name: 'site', environmentId });
      expect(made.status).toBe(201);
      expect((made.body as { configKind: string }).configKind).toBe('web');

      const open = await planFor(
        'version: 1\nservices:\n  site:\n    kind: static\n    source: { git: https://example.com/site.git }\n',
      );
      expect(open.steps.map((step) => [step.action, step.kind])).toEqual([
        ['destroy', 'web'],
        ['create', 'static'],
      ]);

      const refused = await apply(open.planId);
      expect(refused.status).toBe(409);
      expect((refused.body as { code: string }).code).toBe(
        'PLAN_DESTROY_NOT_CONFIRMED',
      );

      const applied = await apply(open.planId, ['site']);

      expect(applied.status).toBe(200);
      expect((applied.body as PlanBody).status).toBe('applied');
      const rows = await ctx.db
        .select({
          configName: application.configName,
          configKind: application.configKind,
          buildType: application.buildType,
        })
        .from(application);
      expect(rows).toEqual([
        { configName: 'site', configKind: 'static', buildType: 'static' },
      ]);

      // And back: the recorded `static` is what the next plan matches.
      const back = await planFor(
        'version: 1\nservices:\n  site:\n    kind: web\n    source: { git: https://example.com/site.git }\n',
      );
      expect(back.steps.map((step) => [step.action, step.kind])).toEqual([
        ['destroy', 'static'],
        ['create', 'web'],
      ]);
    });

    it('applies a web to worker change as a destroy plus a create under name confirmation, and plans the way back alike', async () => {
      const made = await request(server)
        .post('/applications')
        .set('Cookie', cookie)
        .send({ name: 'jobs', environmentId });
      expect(made.status).toBe(201);

      const open = await planFor(
        'version: 1\nservices:\n  jobs:\n    kind: worker\n    source: { git: https://example.com/jobs.git }\n',
      );
      expect(open.steps.map((step) => [step.action, step.kind])).toEqual([
        ['destroy', 'web'],
        ['create', 'worker'],
      ]);

      const refused = await apply(open.planId);
      expect(refused.status).toBe(409);
      expect((refused.body as { code: string }).code).toBe(
        'PLAN_DESTROY_NOT_CONFIRMED',
      );

      const applied = await apply(open.planId, ['jobs']);

      expect(applied.status).toBe(200);
      expect((applied.body as PlanBody).status).toBe('applied');
      const rows = await ctx.db
        .select({
          applicationId: application.applicationId,
          configName: application.configName,
          configKind: application.configKind,
        })
        .from(application);
      expect(rows).toEqual([
        expect.objectContaining({ configName: 'jobs', configKind: 'worker' }),
      ]);
      expect(rows[0].applicationId).not.toBe(
        (made.body as { applicationId: string }).applicationId,
      );

      const back = await planFor(
        'version: 1\nservices:\n  jobs:\n    kind: web\n    source: { git: https://example.com/jobs.git }\n',
      );
      expect(back.steps.map((step) => [step.action, step.kind])).toEqual([
        ['destroy', 'worker'],
        ['create', 'web'],
      ]);
      const unconfirmed = await apply(back.planId);
      expect(unconfirmed.status).toBe(409);
      expect((unconfirmed.body as { code: string }).code).toBe(
        'PLAN_DESTROY_NOT_CONFIRMED',
      );
    });

    it('does not create the replacement when the old kind cannot be deleted', async () => {
      const cacheId = await consoleRedis('cache');
      machines((command) =>
        isPresenceProbe(command)
          ? Promise.resolve({ stdout: 'present', stderr: '' })
          : null,
      );
      const open = await planFor(
        'version: 1\nservices:\n  cache:\n    kind: postgres\n',
      );

      const body = (await apply(open.planId, ['cache'])).body as PlanBody;

      expect(body.status).toBe('partly-applied');
      expect(
        body.results?.map((result) => [result.action, result.status]),
      ).toEqual([
        ['destroy', 'failed'],
        ['create', 'failed'],
      ]);
      expect(body.results?.[1].message).toMatch(/cache/);
      expect(await ctx.db.select().from(postgres)).toHaveLength(0);
      const left = await ctx.db.select({ id: redis.redisId }).from(redis);
      expect(left).toEqual([{ id: cacheId }]);
    });

    it('checks service: delete for every destroy up front, writing nothing', async () => {
      const cacheId = await consoleRedis('cache');
      const queueId = await consoleRedis('queue');
      const open = await planFor(
        'version: 1\nservices:\n  cache:\n    kind: redis\n    version: "7"\n',
      );
      // A built-in member holds service: read/update, not delete.
      const fixture = await signUpMember(server, cookie);
      await ctx.db
        .update(member)
        .set({
          accessedProjects: [projectId],
          accessedEnvironments: [environmentId],
          accessedServices: [cacheId, queueId],
        })
        .where(eq(member.userId, fixture.id));

      const applied = await apply(open.planId, ['queue'], fixture.cookie);

      expect(applied.status).toBe(403);
      expect(await ctx.db.select().from(redis)).toHaveLength(2);
      const [cache] = await ctx.db
        .select({ dockerImage: redis.dockerImage })
        .from(redis)
        .where(eq(redis.redisId, cacheId));
      expect(cache.dockerImage).toBe('redis:8');
      expect(await planStatus(open.planId)).toBe('open');
    });

    it('never destroys a Service whose console-managed line is dropped', async () => {
      await ctx.db.insert(mongo).values({
        name: 'Docs',
        configName: 'docs',
        databaseUser: 'docs',
        databasePassword: 'secret',
        environmentId,
      });
      const listed = await save(
        'version: 1\nservices:\n  docs:\n    kind: mongo\n    managed: console\n',
      );
      expect((listed.body as { stored: boolean }).stored).toBe(true);

      const open = await planFor(
        'version: 1\nservices:\n  db:\n    kind: postgres\n',
      );
      expect(open.steps.map((step) => step.action)).toEqual(['create']);
      expect(open.notes).toEqual([
        expect.objectContaining({
          kind: 'console-managed-dropped',
          configName: 'docs',
        }),
      ]);

      const named = await apply(open.planId, ['docs']);
      expect(named.status).toBe(409);
      const applied = await apply(open.planId, []);
      expect(applied.status).toBe(200);
      expect(await ctx.db.select().from(mongo)).toHaveLength(1);
    });
  });
});
