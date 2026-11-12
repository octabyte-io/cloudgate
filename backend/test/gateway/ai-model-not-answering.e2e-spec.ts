import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import {
  aiModelFacet,
  deployment,
  webServerSettings,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { GATEWAY_TRAEFIK_PORT } from '../../src/gateway/gateway.service';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * "AI model not answering" at the real Gateway (spec stories
 * 97-98): an operator hears **once** that an AI model meant to be running
 * cannot be reached, is told again only after a call has got through, and
 * never hears about a deliberate Stop or a caller's own mistake. Observed
 * where an operator observes it — a Slack webhook on the mocked fetch client.
 *
 * The upstream is a local stub standing in for the machine's Traefik and the
 * runtime behind it, as in `gateway.e2e-spec.ts`: `down` makes it drop every
 * connection, as an unreachable machine does, and `traefik502` makes it answer
 * as Traefik does when the runtime behind its router is gone. The episode
 * tracker and the notifier are the ones `GatewayModule` binds; every test's AI
 * model is new, so one process's memory of earlier tests' AI models is inert.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const MODEL = 'smollm2:135m';
const TITLE = 'AI Model Not Answering';

const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: MODEL,
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello there' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
};

type ExecOptions = { env?: Record<string, string | undefined> };

describe('AI model not answering (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  const fetchMock = jest.fn();
  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const machine = (command: string): Promise<ExecResult> =>
    Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok(''));
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string, ExecOptions?]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });
  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };

  /** How the machine behind the Gateway behaves. */
  let state: 'up' | 'down' | 'traefik502';
  /** The secret the stub's router accepts, per path prefix. */
  const routes = new Map<string, string>();
  const upstream: Server = createServer((req, res) => {
    // A kept-alive connection from before the machine went away goes too.
    if (state === 'down') {
      req.socket.destroy();
      return;
    }
    req.resume();
    req.on('end', () => {
      if (state === 'traefik502') {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('Bad Gateway');
        return;
      }
      const routed = [...routes].some(
        ([prefix, secret]) =>
          (req.url ?? '').startsWith(`${prefix}/`) &&
          req.headers['x-cloudgate-upstream'] === secret,
      );
      if (!routed) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('404 page not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(COMPLETION));
    });
  });
  // An unreachable machine: the connection goes before a byte is read.
  upstream.on('connection', (socket) => {
    if (state === 'down') socket.destroy();
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
        { provide: FETCH_CLIENT, useValue: fetchMock },
        {
          provide: GATEWAY_TRAEFIK_PORT,
          useValue: (upstream.address() as AddressInfo).port,
        },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
    await new Promise((resolve) => upstream.close(resolve));
  });

  let ownerCookie: string;
  let environmentId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    state = 'up';
    routes.clear();
    fetchMock.mockReset().mockResolvedValue({ ok: true, statusText: 'OK' });
    execMock.execAsync.mockReset().mockImplementation(machine);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId, command) => machine(command));
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.listTasks
      .mockReset()
      .mockResolvedValue([
        { Status: { State: 'running', Timestamp: '2026-10-16T00:00:00Z' } },
      ]);
    queueMock.add.mockReset().mockResolvedValue(undefined);

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', ownerCookie)
      .send({ name: 'support' });
    const created = await request(httpServer)
      .post('/environments')
      .set('Cookie', ownerCookie)
      .send({
        name: 'production',
        projectId: (project.body as { projectId: string }).projectId,
      });
    expect(created.status).toBe(201);
    environmentId = (created.body as { environmentId: string }).environmentId;
  });

  /** An AI model, routed on the stub as its router would be. */
  async function createAiModel(appName = 'llm'): Promise<string> {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', ownerCookie)
      .send({
        environmentId,
        name: appName,
        appName,
        aiModel: { runtime: 'ollama', model: MODEL },
      });
    expect(res.status).toBe(201);
    const { applicationId } = res.body as { applicationId: string };
    const [facet] = await ctx.db
      .select({ upstreamSecret: aiModelFacet.upstreamSecret })
      .from(aiModelFacet)
      .where(eq(aiModelFacet.applicationId, applicationId));
    routes.set(`/cloudgate-gateway/${applicationId}`, facet.upstreamSecret);
    return applicationId;
  }

  /** An AI model deployed through the real engine: meant to be running. */
  async function runningAiModel(appName = 'llm'): Promise<string> {
    const applicationId = await createAiModel(appName);
    const deployable = await ctx.app
      .get(ApplicationsService)
      .findDeployable(applicationId);
    await ctx.app.get(DeploymentEngineService).deploy(deployable);
    return applicationId;
  }

  async function createAgent(
    role: string,
    accessedServices: string[],
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({ name: 'support-bot', role, grant: { accessedServices } });
    expect(res.status).toBe(201);
    return (res.body as { key: string }).key;
  }

  function chat(
    key: string,
    applicationId: string,
    body: Record<string, unknown> = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Say hello' }],
    },
  ) {
    return request(httpServer)
      .post(`/ai/${applicationId}/v1/chat/completions`)
      .set('Authorization', `Bearer ${key}`)
      .send(body);
  }

  async function slackChannel(flags: Record<string, boolean>, hook: string) {
    const res = await request(httpServer)
      .post('/notifications/slack')
      .set('Cookie', ownerCookie)
      .send({
        name: hook,
        webhookUrl: `https://hooks.slack.com/services/T/B/${hook}`,
        channel: '#ops',
        ...flags,
      });
    expect(res.status).toBe(201);
    return res.body as { aiModelNotAnswering: boolean };
  }

  /** The bodies posted to one webhook, once the notifier has had its turn. */
  async function postedTo(hook: string, settle = 500): Promise<string[]> {
    // A call does not wait on the notifier, so the refusal is answered before
    // the notification goes out.
    await new Promise((resolve) => setTimeout(resolve, settle));
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith(`/${hook}`))
      .map(([, init]) => String((init as { body: string }).body));
  }

  it('is off on a channel created without it', async () => {
    const created = await slackChannel({ appDeploy: true }, 'DEFAULT');

    expect(created.aiModelNotAnswering).toBe(false);
  });

  it('tells once while the machine is unreachable, again only after a call got through', async () => {
    await slackChannel({ aiModelNotAnswering: true }, 'OPTED');
    const applicationId = await runningAiModel();
    const key = await createAgent('agentCaller', [applicationId]);
    await ctx.db
      .insert(webServerSettings)
      .values({ host: 'cloudgate.example.com', https: true });

    state = 'down';
    expect((await chat(key, applicationId)).status).toBe(502);
    const first = await postedTo('OPTED');
    expect(first).toHaveLength(1);
    for (const fragment of [
      TITLE,
      'llm',
      'support',
      'production',
      MODEL,
      'the platform host',
      `https://cloudgate.example.com/applications/${applicationId}/model`,
    ]) {
      expect(first[0]).toContain(fragment);
    }

    expect((await chat(key, applicationId)).status).toBe(502);
    expect(await postedTo('OPTED')).toHaveLength(1);

    state = 'up';
    expect((await chat(key, applicationId)).status).toBe(200);
    expect(await postedTo('OPTED')).toHaveLength(1);

    state = 'down';
    expect((await chat(key, applicationId)).status).toBe(502);
    expect(await postedTo('OPTED')).toHaveLength(2);
  });

  it("tells once when the machine's Traefik answers for a runtime that is gone", async () => {
    await slackChannel({ aiModelNotAnswering: true }, 'OPTED');
    const applicationId = await runningAiModel();
    const key = await createAgent('agentCaller', [applicationId]);
    state = 'traefik502';

    expect((await chat(key, applicationId)).status).toBe(502);
    expect((await chat(key, applicationId)).status).toBe(502);

    const sent = await postedTo('OPTED');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(TITLE);
  });

  it("tells once when the machine's Traefik has no router for the runtime", async () => {
    await slackChannel({ aiModelNotAnswering: true }, 'OPTED');
    const applicationId = await runningAiModel();
    const key = await createAgent('agentCaller', [applicationId]);
    // Traefik's own plain 404: the runtime's task, and so its router, is gone.
    routes.clear();

    const res = await chat(key, applicationId);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: { code: 'model_not_answering' } });
    const sent = await postedTo('OPTED');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(TITLE);
  });

  it('sends nothing to a channel with the switch off', async () => {
    await slackChannel(
      { agentRateLimited: true, serviceIncident: true },
      'OFF',
    );
    const applicationId = await runningAiModel();
    const key = await createAgent('agentCaller', [applicationId]);
    state = 'down';

    expect((await chat(key, applicationId)).status).toBe(502);

    expect(await postedTo('OFF')).toEqual([]);
  });

  it('never tells about a stopped AI model, or one never deployed', async () => {
    await slackChannel({ aiModelNotAnswering: true }, 'OPTED');
    const stopped = await runningAiModel();
    const idle = await createAiModel('llm-idle');
    const key = await createAgent('agentCaller', [stopped, idle]);
    const res = await request(httpServer)
      .post(`/applications/${stopped}/stop`)
      .set('Cookie', ownerCookie);
    expect(res.status).toBe(200);
    state = 'down';

    expect((await chat(key, stopped)).status).toBe(503);
    expect((await chat(key, stopped)).status).toBe(503);
    expect((await chat(key, idle)).status).toBe(503);

    expect(await postedTo('OPTED')).toEqual([]);
  });

  it('never tells while a redeploy has the runtime down, and tells once it has settled', async () => {
    await slackChannel({ aiModelNotAnswering: true }, 'OPTED');
    const applicationId = await runningAiModel();
    const key = await createAgent('agentCaller', [applicationId]);
    // A redeploy releasing stop-first: the runtime is gone on purpose.
    const [redeploy] = await ctx.db
      .insert(deployment)
      .values({
        applicationId,
        title: 'Redeploy',
        status: 'running',
        logPath: '/tmp/redeploy.log',
      })
      .returning();
    state = 'down';

    expect((await chat(key, applicationId)).status).toBe(502);
    expect(await postedTo('OPTED')).toEqual([]);

    // Settled, and still not answering: that is an outage.
    await ctx.db
      .update(deployment)
      .set({ status: 'error' })
      .where(eq(deployment.deploymentId, redeploy.deploymentId));
    expect((await chat(key, applicationId)).status).toBe(502);
    expect(await postedTo('OPTED')).toHaveLength(1);
  });

  it("never tells about a caller's own mistake, even while the machine is unreachable", async () => {
    await slackChannel({ aiModelNotAnswering: true }, 'OPTED');
    const applicationId = await runningAiModel();
    const caller = await createAgent('agentCaller', [applicationId]);
    const reader = await createAgent('agentReader', [applicationId]);
    state = 'down';

    // A bad key, a key without `call`, a path outside the allowlist, and a
    // model other than the one served.
    expect((await chat('cg_not-a-key', applicationId)).status).toBe(401);
    expect((await chat(reader, applicationId)).status).toBe(404);
    expect(
      (
        await request(httpServer)
          .post(`/ai/${applicationId}/api/pull`)
          .set('Authorization', `Bearer ${caller}`)
          .send({ model: MODEL })
      ).status,
    ).toBe(404);
    expect(
      (await chat(caller, applicationId, { model: 'llama3', messages: [] }))
        .status,
    ).toBe(400);

    expect(await postedTo('OPTED')).toEqual([]);
  });
});
