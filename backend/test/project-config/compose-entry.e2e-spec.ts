import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  compose,
  deployment,
  projectConfigLocation,
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
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

interface StepBody {
  action: string;
  configName: string;
  kind: string;
  volumes?: string[] | null;
}

interface PlanBody {
  planId: string;
  environmentId: string;
  status: string;
  steps: StepBody[];
  notes: { kind: string; configName: string; message: string }[];
  results:
    | {
        configName: string;
        action: string;
        status: string;
        message: string | null;
        serviceType: string | null;
        serviceId: string | null;
        deploy: { status: string } | null;
      }[]
    | null;
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

const URL = 'https://git.example.com/acme/analytics.git';

/** A config describing the `analytics` stack by the file it names. */
const analytics = (...lines: string[]) =>
  [
    'version: 1',
    'services:',
    '  analytics:',
    '    kind: compose',
    '    source:',
    `      git: ${URL}`,
    ...lines.map((line) => `    ${line}`),
    '',
  ].join('\n');

/**
 * A `kind: compose` entry (ADR-0069): a plan creates, changes and destroys a
 * Compose stack through the stack's own create, update and Delete paths,
 * queuing ordinary Deployments, and never reads or holds its compose file.
 * The queue and the machines are the boundaries.
 */
describe('Compose entries in the Project config (e2e)', () => {
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
  const commands: string[] = [];

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        { provide: RemoteExecService, useValue: execMock },
        {
          provide: RemoteDockerFactory,
          useValue: { getRemoteDocker: jest.fn() },
        },
      ],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  /** Every machine command succeeds, and every workload is gone. */
  const succeeds = (command: string) => {
    commands.push(command);
    return Promise.resolve(
      isPresenceProbe(command)
        ? { stdout: 'absent', stderr: '' }
        : { stdout: '', stderr: '' },
    );
  };

  beforeEach(async () => {
    await ctx.resetDb();
    queue.jobs = [];
    commands.length = 0;
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
  });

  const send = (
    method: 'post' | 'patch' | 'get',
    path: string,
    body?: object,
  ) => request(server)[method](path).set('Cookie', cookie).send(body);

  const save = (text: string) =>
    send('post', `/projects/${projectId}/config/plans`, { text });

  async function planFor(text: string) {
    const saved = await save(text);
    expect(saved.status).toBe(201);
    const found = (saved.body as { plans: PlanBody[] }).plans.find(
      (plan) => plan.environmentId === environmentId,
    );
    expect(found).toBeDefined();
    return found as PlanBody;
  }

  const apply = (planId: string, confirmDestroy?: string[]) =>
    send(
      'post',
      `/environments/${environmentId}/plan/apply`,
      confirmDestroy === undefined ? { planId } : { planId, confirmDestroy },
    );

  async function stacks() {
    return ctx.db
      .select()
      .from(compose)
      .where(eq(compose.environmentId, environmentId));
  }

  /** The config's `analytics` planned and applied; answers its row. */
  async function appliedAnalytics(text = analytics()) {
    const open = await planFor(text);
    const applied = await apply(open.planId);
    expect(applied.status).toBe(200);
    expect((applied.body as PlanBody).status).toBe('applied');
    const [row] = await stacks();
    return row;
  }

  async function storedText() {
    const [row] = await ctx.db
      .select({ text: projectConfigLocation.text })
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId));
    return row.text ?? '';
  }

  describe('a plan that creates one', () => {
    it('creates the stack from the file it names, under its Config name, and queues its Deployment', async () => {
      const open = await planFor(
        analytics('file: deploy/docker-compose.yml', 'type: stack'),
      );
      expect(open.steps).toEqual([
        expect.objectContaining({
          action: 'create',
          configName: 'analytics',
          kind: 'compose',
        }),
      ]);

      const applied = await apply(open.planId);

      expect(applied.status).toBe(200);
      const [result] = (applied.body as PlanBody).results ?? [];
      expect(result).toMatchObject({
        status: 'applied',
        serviceType: 'compose',
      });
      expect(result.deploy).toMatchObject({ status: 'queued' });

      const [row] = await stacks();
      expect(row).toMatchObject({
        configName: 'analytics',
        name: 'analytics',
        sourceType: 'git',
        customGitUrl: URL,
        customGitBranch: 'main',
        composePath: './deploy/docker-compose.yml',
        composeType: 'stack',
        // Nothing of a compose file is ever written by a plan.
        composeFile: '',
      });
      const [queued] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.composeId, row.composeId));
      expect(queued.status).toBe('pending');
      expect(queue.jobs.map((job) => job.data)).toEqual([
        expect.objectContaining({
          applicationType: 'compose',
          composeId: row.composeId,
        }),
      ]);

      // The next plan of the same text has nothing to change.
      expect(
        (
          await planFor(
            analytics('file: deploy/docker-compose.yml', 'type: stack'),
          )
        ).steps,
      ).toEqual([]);
    });
  });

  describe('a plan that changes one', () => {
    it('writes a new file path through the stack’s own update and deploys it, keeping its branch', async () => {
      const row = await appliedAnalytics();
      await ctx.db
        .update(compose)
        .set({ customGitBranch: 'release' })
        .where(eq(compose.composeId, row.composeId));
      queue.jobs = [];

      const open = await planFor(analytics('file: compose.prod.yml'));
      expect(open.steps).toEqual([
        expect.objectContaining({ action: 'change', configName: 'analytics' }),
      ]);
      const applied = await apply(open.planId);

      expect(applied.status).toBe(200);
      const [after] = await stacks();
      expect(after).toMatchObject({
        composeId: row.composeId,
        composePath: './compose.prod.yml',
        customGitBranch: 'release',
      });
      expect(queue.jobs).toHaveLength(1);
    });

    it('destroys and creates a stack whose type changes', async () => {
      const row = await appliedAnalytics();

      const open = await planFor(analytics('type: stack'));
      expect(open.steps.map((step) => step.action)).toEqual([
        'destroy',
        'create',
      ]);
      const applied = await apply(open.planId, ['analytics']);

      expect(applied.status).toBe(200);
      const [after] = await stacks();
      expect(after.composeId).not.toBe(row.composeId);
      expect(after.composeType).toBe('stack');
    });
  });

  describe('a plan that destroys one', () => {
    it('names the volumes its Delete removes, then deletes it with them once confirmed by name', async () => {
      const row = await appliedAnalytics();
      await ctx.db
        .update(compose)
        .set({ deployedVolumes: [`${row.appName}_data`] })
        .where(eq(compose.composeId, row.composeId));

      const open = await planFor('version: 1\nservices: {}\n');
      expect(open.steps).toEqual([
        expect.objectContaining({
          action: 'destroy',
          configName: 'analytics',
          kind: 'compose',
          volumes: [`${row.appName}_data`],
        }),
      ]);

      const applied = await apply(open.planId, ['analytics']);

      expect(applied.status).toBe(200);
      expect((applied.body as PlanBody).status).toBe('applied');
      expect(await stacks()).toEqual([]);
      expect(
        commands.some((command) =>
          command.includes(`docker compose -p ${row.appName} down --volumes`),
        ),
      ).toBe(true);
    });

    it('says its volumes are not known before a deploy has recorded them', async () => {
      await appliedAnalytics();

      const open = await planFor('version: 1\nservices: {}\n');

      expect(open.steps).toEqual([
        expect.objectContaining({ action: 'destroy', volumes: null }),
      ]);
    });
  });

  describe('a stack whose compose file is not in a repository', () => {
    async function templateLike() {
      const created = await send('post', '/compose', {
        name: 'analytics',
        environmentId,
        composeFile: 'services:\n  web:\n    image: nginx:1.27\n',
      });
      expect(created.status).toBe(201);
      return created.body as { composeId: string; sourceType: string };
    }

    it('refuses a plan that would describe it, and notes nothing of it when it is console-managed', async () => {
      const made = await templateLike();
      expect(made.sourceType).toBe('raw');

      const refused = await save(analytics());
      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toMatch(
        /analytics: its compose file is kept in Cloudgate/,
      );

      const consoleManaged = await planFor(
        'version: 1\nservices:\n  analytics:\n    kind: compose\n    managed: console\n',
      );
      expect(consoleManaged.steps).toEqual([]);
      expect(consoleManaged.notes).toEqual([]);
    });
  });

  describe('a console-managed stack from a repository', () => {
    it('is noted as one that can now be described, and a Save of its file path leaves the config as it is', async () => {
      const made = await send('post', '/compose', {
        name: 'analytics',
        environmentId,
        sourceType: 'git',
      });
      expect(made.status).toBe(201);
      const composeId = (made.body as { composeId: string }).composeId;
      const configured = await send('patch', `/compose/${composeId}`, {
        customGitUrl: URL,
      });
      expect(configured.status).toBe(200);

      const text =
        'version: 1\nservices:\n  analytics:\n    kind: compose\n    managed: console\n';
      const open = await planFor(text);
      expect(open.steps).toEqual([]);
      expect(open.notes).toEqual([
        expect.objectContaining({
          kind: 'compose-can-be-described',
          configName: 'analytics',
        }),
      ]);

      const patched = await send('patch', `/compose/${composeId}`, {
        composePath: './deploy/compose.yml',
      });
      expect(patched.status).toBe(200);
      expect(await storedText()).toBe(text);
    });
  });

  describe('a described stack on a Cloudgate-kept config', () => {
    it('keeps the config in step with a console Save of its file path', async () => {
      const row = await appliedAnalytics();

      const patched = await send('patch', `/compose/${row.composeId}`, {
        composePath: './deploy/compose.yml',
      });

      expect(patched.status).toBe(200);
      expect(await storedText()).toContain('file: deploy/compose.yml');
      expect((await planFor(await storedText())).steps).toEqual([]);
    });
  });
});
