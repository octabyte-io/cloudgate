import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { ai, aiModelFacet, aiUsage } from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { GATEWAY_TRAEFIK_PORT } from '../../src/gateway/gateway.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * Cloudgate's own AI provider pointed at an AI model through the Gateway
 * (spec slice 4): the operator pastes `<platform host>/ai/<id>/v1`
 * and a caller Agent's key into the custom OpenAI-compatible provider, and the
 * platform's AI features run on their own model.
 *
 * The backend dials the **public** Gateway URL over real HTTP — there is no
 * in-process shortcut — so this app listens on a real port, and the AI
 * provider's URL is that port. The call then goes the way any caller's does:
 * through the Gateway, its key check and its usage row, to the stub standing
 * in for the AI model's machine's Traefik (as in `gateway.e2e-spec.ts`).
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const MODEL = 'smollm2:135m';
const ANALYSIS = 'The build failed because the lockfile is out of date.';

describe('the AI provider pointed at the Gateway (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  /** Where the backend itself is listening: the "platform host". */
  let platformHost: string;

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const machine = (command: string): Promise<ExecResult> =>
    Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok(''));
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string, unknown?]>(),
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

  /** What reached the upstream: the path, and the body as sent. */
  const upstreamHears: { url: string; body: string }[] = [];
  /** The gateway-only router's prefix → upstream secret, per AI model. */
  const routes = new Map<string, string>();
  const upstream: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      upstreamHears.push({ url, body: Buffer.concat(chunks).toString('utf8') });
      const routed = [...routes].some(
        ([prefix, secret]) =>
          url.startsWith(`${prefix}/`) &&
          req.headers['x-cloudgate-upstream'] === secret,
      );
      if (!routed) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('404 page not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1_760_000_000,
          model: MODEL,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: ANALYSIS },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 11,
            total_tokens: 131,
          },
        }),
      );
    });
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
        {
          provide: GATEWAY_TRAEFIK_PORT,
          useValue: (upstream.address() as AddressInfo).port,
        },
      ],
    });
    // The AI SDK dials over real HTTP, so the app has to be reachable on one.
    await ctx.app.listen(0, '127.0.0.1');
    const listening = ctx.app.getHttpServer() as Server;
    httpServer = listening;
    const { port } = listening.address() as AddressInfo;
    platformHost = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await ctx.teardown();
    await new Promise((resolve) => upstream.close(resolve));
  });

  let ownerCookie: string;
  let environmentId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    upstreamHears.length = 0;
    routes.clear();
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
      .send({ name: 'platform' });
    const { projectId } = project.body as { projectId: string };
    const created = await request(httpServer)
      .post('/environments')
      .set('Cookie', ownerCookie)
      .send({ name: 'production', projectId });
    expect(created.status).toBe(201);
    environmentId = (created.body as { environmentId: string }).environmentId;
  });

  /** A running Ollama AI model, routed in the stub. */
  async function runningAiModel(): Promise<string> {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', ownerCookie)
      .send({
        environmentId,
        name: 'ollama-llm',
        appName: 'ollama-llm',
        aiModel: { runtime: 'ollama', model: MODEL },
      });
    expect(res.status).toBe(201);
    const { applicationId } = res.body as { applicationId: string };
    const [facet] = await ctx.db
      .select({ upstreamSecret: aiModelFacet.upstreamSecret })
      .from(aiModelFacet)
      .where(eq(aiModelFacet.applicationId, applicationId));
    routes.set(`/cloudgate-gateway/${applicationId}`, facet.upstreamSecret);
    const deployable = await ctx.app
      .get(ApplicationsService)
      .findDeployable(applicationId);
    await ctx.app.get(DeploymentEngineService).deploy(deployable);
    return applicationId;
  }

  async function callerAgent(
    applicationId: string,
  ): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({
        name: 'cloudgate-ai',
        role: 'agentCaller',
        grant: { accessedServices: [applicationId] },
      });
    expect(res.status).toBe(201);
    const body = res.body as { agent: { id: string }; key: string };
    return { id: body.agent.id, key: body.key };
  }

  /** The operator's paste: the Gateway URL and the Agent key, as a custom provider. */
  async function pointAiProviderAt(
    applicationId: string,
    key: string,
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/ai')
      .set('Cookie', ownerCookie)
      .send({
        name: 'own model',
        apiUrl: `${platformHost}/ai/${applicationId}/v1`,
        apiKey: key,
        model: MODEL,
        isEnabled: true,
      });
    expect(res.status).toBe(201);
    return (res.body as { aiId: string }).aiId;
  }

  const analyzeLogs = (aiId: string) =>
    request(httpServer)
      .post('/ai/analyze-logs')
      .set('Cookie', ownerCookie)
      .send({
        aiId,
        logs: 'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile"',
        context: 'build',
      });

  const aiRows = () => ctx.db.select().from(ai);

  it("analyze-logs runs on the AI model through the Gateway, metered as the caller Agent's Token spend", async () => {
    const applicationId = await runningAiModel();
    const caller = await callerAgent(applicationId);
    const aiId = await pointAiProviderAt(applicationId, caller.key);

    const res = await analyzeLogs(aiId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ analysis: ANALYSIS });
    // OpenAI-compatible `/v1/chat/completions`, not the Ollama SDK's
    // `/api/chat`, though the runtime behind the Gateway is Ollama. (A URL
    // that itself says "ollama" is `select-ai-provider.spec.ts`'s table.)
    expect(upstreamHears.map((heard) => heard.url)).toEqual([
      `/cloudgate-gateway/${applicationId}/v1/chat/completions`,
    ]);
    expect(JSON.parse(upstreamHears[0].body)).toMatchObject({ model: MODEL });
    expect(await ctx.db.select().from(aiUsage)).toEqual([
      expect.objectContaining({
        applicationId,
        agentUserId: caller.id,
        agentName: 'cloudgate-ai',
        model: MODEL,
        endpoint: '/v1/chat/completions',
        promptTokens: 120,
        completionTokens: 11,
        outcome: 'ok',
      }),
    ]);
  });

  it("no Agent is created for the platform: the only one is the operator's", async () => {
    const applicationId = await runningAiModel();
    const caller = await callerAgent(applicationId);
    const aiId = await pointAiProviderAt(applicationId, caller.key);
    expect((await analyzeLogs(aiId)).status).toBe(200);

    const agents = await request(httpServer)
      .get('/agents')
      .set('Cookie', ownerCookie);
    expect(agents.status).toBe(200);
    const list = agents.body as { id: string }[] | { agents: { id: string }[] };
    const ids = (Array.isArray(list) ? list : list.agents).map((a) => a.id);
    expect(ids).toEqual([caller.id]);
  });

  describe("when the Gateway refuses, the AI provider stays and the refusal is the Gateway's", () => {
    async function expectRefusedKeepingProvider(
      aiId: string,
      message: string,
    ): Promise<void> {
      const before = await aiRows();
      upstreamHears.length = 0;

      const res = await analyzeLogs(aiId);

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(message);
      expect(upstreamHears).toEqual([]);
      expect(await aiRows()).toEqual(before);
      expect(before).toHaveLength(1);
    }

    it('surfaces "Key refused" after the caller Agent is suspended', async () => {
      const applicationId = await runningAiModel();
      const caller = await callerAgent(applicationId);
      const aiId = await pointAiProviderAt(applicationId, caller.key);
      expect((await analyzeLogs(aiId)).status).toBe(200);

      const suspended = await request(httpServer)
        .post(`/agents/${caller.id}/suspend`)
        .set('Cookie', ownerCookie);
      expect(suspended.status).toBe(200);

      await expectRefusedKeepingProvider(aiId, 'Key refused');
      // A refused key writes nothing: the one row is the call before.
      expect(await ctx.db.select().from(aiUsage)).toHaveLength(1);
    });

    it('surfaces "Key refused" after the caller Agent is removed', async () => {
      const applicationId = await runningAiModel();
      const caller = await callerAgent(applicationId);
      const aiId = await pointAiProviderAt(applicationId, caller.key);

      const removed = await request(httpServer)
        .delete(`/agents/${caller.id}`)
        .set('Cookie', ownerCookie);
      expect(removed.status).toBe(200);

      await expectRefusedKeepingProvider(aiId, 'Key refused');
    });

    it('surfaces the not-found refusal after the AI model is deleted', async () => {
      const applicationId = await runningAiModel();
      const caller = await callerAgent(applicationId);
      const aiId = await pointAiProviderAt(applicationId, caller.key);

      const deleted = await request(httpServer)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie);
      expect(deleted.status).toBe(200);

      await expectRefusedKeepingProvider(
        aiId,
        'AI model not found or not permitted',
      );
    });
  });
});
