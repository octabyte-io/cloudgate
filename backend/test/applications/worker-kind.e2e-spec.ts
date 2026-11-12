import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  domain,
  port,
  previewDeployment,
} from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * A Worker serves no HTTP (spec US16–US18): adding a Domain or
 * turning on a preview, a pull request's or a requested one, is refused
 * with a pointer to changing the kind — over HTTP and through the MCP tool
 * that asks for a preview — while everything else an Application has (a
 * published port, a Schedule, the replica count) works as for any other.
 * Sentences are written out here, not imported.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const NO_DOMAIN =
  'A worker takes no Domain: it serves no HTTP. To serve HTTP, change its kind to web in the Project config';
const NO_PREVIEW =
  'A worker has no previews: a preview is reached at its own Domain, and a worker serves no HTTP. To serve HTTP, change its kind to web in the Project config';
/** MCP's answer, the same for every kind with no previews. */
const MCP_NO_PREVIEWS =
  "This Application's kind has no previews: a preview is reached at a Domain of its own, and this kind takes none. Its operator can change its kind to web in the Project config.";

type ExecOptions = { env?: Record<string, string | undefined> };

describe('A worker takes no Domain and no preview (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const machine = (command: string): Promise<ExecResult> =>
    Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok(''));
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string, ExecOptions?]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        {
          provide: RemoteDockerFactory,
          useValue: { getRemoteDocker: jest.fn() },
        },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  let cookie: string;
  let projectId: string;
  let environmentId: string;
  let workerId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockImplementation(machine);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId, command) => machine(command));
    queueMock.add.mockReset().mockResolvedValue(undefined);

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    projectId = (project.body as { projectId: string }).projectId;
    const environment = await request(httpServer)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name: 'production', projectId });
    environmentId = (environment.body as { environmentId: string })
      .environmentId;

    // Only a plan creates a worker (`apply-plan.e2e-spec.ts`); here the
    // recorded kind is what is under test, so it is written directly, on an
    // Application a requested preview could otherwise be asked of.
    const made = await request(httpServer)
      .post('/applications')
      .set('Cookie', cookie)
      .send({ environmentId, name: 'jobs', appName: 'jobs' });
    expect(made.status).toBe(201);
    workerId = (made.body as { applicationId: string }).applicationId;
    await ctx.db
      .update(application)
      .set({
        configKind: 'worker',
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/acme/jobs.git',
        customGitBranch: 'main',
        previewWildcard: '*.preview.example.com',
      })
      .where(eq(application.applicationId, workerId));
  });

  const send = (
    method: 'post' | 'patch',
    path: string,
    body: Record<string, unknown>,
  ) => request(httpServer)[method](path).set('Cookie', cookie).send(body);

  async function row() {
    const [found] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.applicationId, workerId));
    return found;
  }

  describe('refused, pointing to changing the kind', () => {
    it('refuses a Domain', async () => {
      const res = await send('post', '/domains', {
        host: 'jobs.example.com',
        applicationId: workerId,
        domainType: 'application',
        port: 3000,
      });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        message: NO_DOMAIN,
        code: 'KIND_TAKES_NO_DOMAIN',
      });
      expect(await ctx.db.select().from(domain)).toEqual([]);
    });

    it.each([['isPreviewDeploymentsActive'], ['requestedPreviewsAllowed']])(
      'refuses turning %s on, and lets it be turned off',
      async (field) => {
        const on = await send('patch', `/applications/${workerId}`, {
          [field]: true,
        });

        expect(on.status).toBe(409);
        expect(on.body).toMatchObject({
          message: NO_PREVIEW,
          code: 'KIND_TAKES_NO_PREVIEWS',
        });
        expect(await row()).toMatchObject({
          isPreviewDeploymentsActive: false,
          requestedPreviewsAllowed: false,
        });

        const off = await send('patch', `/applications/${workerId}`, {
          [field]: false,
        });
        expect(off.status).toBe(200);
      },
    );

    it('refuses a requested preview, even with the switch on', async () => {
      // A switch set before the kind was recorded still never admits one.
      await ctx.db
        .update(application)
        .set({ requestedPreviewsAllowed: true })
        .where(eq(application.applicationId, workerId));

      const res = await send(
        'post',
        `/applications/${workerId}/preview-deployments`,
        { branch: 'feature/login' },
      );

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        message: NO_PREVIEW,
        code: 'KIND_TAKES_NO_PREVIEWS',
      });
      expect(await ctx.db.select().from(previewDeployment)).toEqual([]);
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('answers an Agent asking for a preview through MCP, pointing to the kind', async () => {
      const agent = await request(httpServer)
        .post('/agents')
        .set('Cookie', cookie)
        .send({
          name: 'op-bot',
          role: 'agentOperator',
          grant: {
            accessedProjects: [projectId],
            accessedEnvironments: [environmentId],
            accessedServices: [workerId],
          },
        });
      expect(agent.status).toBe(201);
      const { key } = agent.body as { key: string };

      const res = await request(httpServer)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${key}`)
        .set('MCP-Protocol-Version', '2025-06-18')
        .send({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: {
            name: 'create_preview',
            arguments: { applicationId: workerId, branch: 'feature/login' },
          },
        });

      expect(res.status).toBe(200);
      expect((res.body as { result: unknown }).result).toEqual({
        content: [{ type: 'text', text: MCP_NO_PREVIEWS }],
        structuredContent: { code: 'failed', message: MCP_NO_PREVIEWS },
        isError: true,
      });
      expect(await ctx.db.select().from(previewDeployment)).toEqual([]);
    });
  });

  describe('as for any Application', () => {
    it('publishes a port', async () => {
      const res = await send('post', '/ports', {
        applicationId: workerId,
        publishedPort: 9000,
        targetPort: 9000,
      });

      expect(res.status).toBe(201);
      expect(await ctx.db.select().from(port)).toHaveLength(1);
    });

    it('takes a Schedule', async () => {
      const res = await send('post', '/schedules', {
        name: 'Nightly sweep',
        cronExpression: '0 6 * * *',
        scheduleType: 'application',
        serviceId: workerId,
        command: 'node sweep.js',
        enabled: false,
      });

      expect(res.status).toBe(201);
    });

    it('sets its replica count', async () => {
      const res = await send('patch', `/applications/${workerId}`, {
        replicas: 3,
      });

      expect(res.status).toBe(200);
      expect((await row()).replicas).toBe(3);
    });
  });
});
