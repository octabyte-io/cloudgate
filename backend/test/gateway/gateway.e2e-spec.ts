import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { parse } from 'yaml';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import {
  aiModelFacet,
  aiUsage,
  apikey,
  application,
  auditLog,
  environment,
  server as serverTable,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { GATEWAY_TRAEFIK_PORT } from '../../src/gateway/gateway.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import type { FileConfig } from '../../src/traefik/config/file-types';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { TEST_PLATFORM_ROOT } from '../utils/platform-root';
import { freezeOrganization } from '../utils/frozen-organization';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * The Gateway, non-streamed (spec slice 2, the gateway ADR):
 * `<platform host>/ai/<AI model>/v1`, the Agent key its only guard, the hop
 * through the AI model's machine's Traefik with the upstream secret, and one
 * usage row per call — observed where a caller and an operator observe them:
 * the response, what reached the upstream, the rows, and the audit trail.
 *
 * The upstream is a local stub HTTP server speaking OpenAI `/v1`, standing in
 * for the machine's Traefik and the runtime behind it: it answers only a call
 * that carries the AI model's upstream secret under the gateway's path prefix,
 * as the gateway-only router does, and Traefik's own 404 otherwise. The
 * Gateway reaches it by the configured address, the platform host's Traefik
 * or a Server's IP, on {@link GATEWAY_TRAEFIK_PORT}, which is the stub's port.
 * `RemoteExecService` and `RemoteDockerFactory` are the doubles the AI model
 * suite uses; the routes, the deployment engine and the Gateway run for real.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const MODEL = 'smollm2:135m';
/** The AI model `llm`'s gateway-only router on the platform host. */
const ROUTE_FILE = `${TEST_PLATFORM_ROOT}/traefik/dynamic/ai-gateway+llm.yml`;
const OLLAMA = { runtime: 'ollama', model: MODEL };

/** Every refusal of a key, whichever kind of key it was. */
const KEY_REFUSED = {
  error: {
    message: 'Key refused',
    type: 'invalid_request_error',
    code: 'key_refused',
  },
};
/** Every refusal that would otherwise tell a key which AI models exist. */
const NOT_FOUND = {
  error: {
    message: 'AI model not found or not permitted',
    type: 'invalid_request_error',
    code: 'model_not_found',
  },
};

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

describe('Gateway (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

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

  /** What reached the upstream, whole. */
  interface Heard {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
  }
  const upstreamHears: Heard[] = [];
  /** The secret and prefix the stub's router accepts, per AI model. */
  const routes = new Map<string, string>();
  /** What the runtime answers, unless a test scripts otherwise. */
  let runtime: (heard: Heard) => { status: number; body: unknown } | 'cut';
  const answerAsOllama = (heard: Heard) =>
    heard.url.endsWith('/v1/models')
      ? {
          status: 200,
          body: { object: 'list', data: [{ id: MODEL, object: 'model' }] },
        }
      : { status: 200, body: COMPLETION };
  const upstream: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const heard: Heard = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      upstreamHears.push(heard);
      // The gateway-only router: its path prefix and the upstream secret, or
      // Traefik's own 404.
      const routed = [...routes].find(
        ([prefix, secret]) =>
          heard.url.startsWith(`${prefix}/`) &&
          heard.headers['x-cloudgate-upstream'] === secret,
      );
      if (!routed) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('404 page not found');
        return;
      }
      const answer = runtime(heard);
      if (answer === 'cut') {
        req.socket.destroy();
        return;
      }
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
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
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
    await new Promise((resolve) => upstream.close(resolve));
  });

  let ownerCookie: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    upstreamHears.length = 0;
    routes.clear();
    runtime = answerAsOllama;
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
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', ownerCookie);
    organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', ownerCookie)
      .send({ name: 'support' });
    projectId = (project.body as { projectId: string }).projectId;
    const created = await request(httpServer)
      .post('/environments')
      .set('Cookie', ownerCookie)
      .send({ name: 'production', projectId });
    expect(created.status).toBe(201);
    environmentId = (created.body as { environmentId: string }).environmentId;
  });

  /** Creates an AI model and routes the stub to it as its router would. */
  async function createAiModel(
    appName = 'llm',
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', ownerCookie)
      .send({
        environmentId,
        name: appName,
        appName,
        aiModel: OLLAMA,
        ...extra,
      });
    expect(res.status).toBe(201);
    const { applicationId } = res.body as { applicationId: string };
    routes.set(
      `/cloudgate-gateway/${applicationId}`,
      await storedSecret(applicationId),
    );
    return applicationId;
  }

  /** An AI model, deployed through the real engine, so it is running. */
  async function runningAiModel(appName = 'llm'): Promise<string> {
    const applicationId = await createAiModel(appName);
    const deployable = await ctx.app
      .get(ApplicationsService)
      .findDeployable(applicationId);
    await ctx.app.get(DeploymentEngineService).deploy(deployable);
    return applicationId;
  }

  async function storedSecret(applicationId: string): Promise<string> {
    const [row] = await ctx.db
      .select({ upstreamSecret: aiModelFacet.upstreamSecret })
      .from(aiModelFacet)
      .where(eq(aiModelFacet.applicationId, applicationId));
    return row.upstreamSecret;
  }

  async function createAgent(
    role: string,
    accessedServices: string[],
    name = 'support-bot',
  ): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({ name, role, grant: { accessedServices } });
    expect(res.status).toBe(201);
    const body = res.body as { agent: { id: string }; key: string };
    return { id: body.agent.id, key: body.key };
  }

  function chat(
    key: string | null,
    applicationId: string,
    body: Record<string, unknown> = {
      model: MODEL,
      messages: [{ role: 'user', content: 'Say hello' }],
    },
  ) {
    let req = request(httpServer).post(
      `/ai/${applicationId}/v1/chat/completions`,
    );
    if (key) req = req.set('Authorization', `Bearer ${key}`);
    return req.send(body);
  }

  const usageRows = () => ctx.db.select().from(aiUsage);
  const auditRows = () => ctx.db.select().from(auditLog);

  describe('a call that gets through', () => {
    it("reaches the runtime with the upstream secret and answers the runtime's completion, writing a reported ok row", async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      const [key] = await ctx.db
        .select({ id: apikey.id })
        .from(apikey)
        .where(eq(apikey.referenceId, caller.id));

      const res = await chat(caller.key, applicationId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(COMPLETION);
      expect(upstreamHears).toHaveLength(1);
      const [heard] = upstreamHears;
      expect(heard.method).toBe('POST');
      expect(heard.url).toBe(
        `/cloudgate-gateway/${applicationId}/v1/chat/completions`,
      );
      expect(heard.headers['x-cloudgate-upstream']).toBe(
        await storedSecret(applicationId),
      );
      // The caller's key goes no further than the Gateway.
      expect(heard.headers.authorization).toBeUndefined();
      expect(JSON.stringify(heard)).not.toContain(caller.key);
      expect(JSON.parse(heard.body)).toEqual({
        model: MODEL,
        messages: [{ role: 'user', content: 'Say hello' }],
      });

      const rows = await usageRows();
      expect(rows).toEqual([
        expect.objectContaining({
          applicationId,
          agentUserId: caller.id,
          agentName: 'support-bot',
          apikeyId: key.id,
          model: MODEL,
          endpoint: '/v1/chat/completions',
          streamed: false,
          promptTokens: 12,
          promptTokensEstimated: false,
          completionTokens: 5,
          completionTokensEstimated: false,
          outcome: 'ok',
        }),
      ]);
      expect(Date.parse(rows[0].endedAt)).toBeGreaterThanOrEqual(
        Date.parse(rows[0].startedAt),
      );
      // Never a body, and never the key.
      const text = JSON.stringify(rows);
      expect(text).not.toContain('Say hello');
      expect(text).not.toContain('Hello there');
      expect(text).not.toContain(caller.key);

      // The row is the AI model's: its Environment's and its Project's.
      const [owned] = await ctx.db
        .select({
          environmentId: application.environmentId,
          projectId: environment.projectId,
        })
        .from(aiUsage)
        .innerJoin(
          application,
          eq(application.applicationId, aiUsage.applicationId),
        )
        .innerJoin(
          environment,
          eq(environment.environmentId, application.environmentId),
        );
      expect(owned).toEqual({ environmentId, projectId });
    });

    it("forwards a Frozen Organization's call to its running AI model, as before the freeze", async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      await freezeOrganization(ctx, organizationId);

      const res = await chat(caller.key, applicationId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(COMPLETION);
      expect(upstreamHears).toHaveLength(1);
      expect(await usageRows()).toEqual([
        expect.objectContaining({ applicationId, outcome: 'ok' }),
      ]);
      jest.restoreAllMocks();
    });

    it('forwards a body past the 100 kB every other route takes', async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      const content = 'x'.repeat(1024 * 1024);

      const res = await chat(caller.key, applicationId, {
        model: MODEL,
        messages: [{ role: 'user', content }],
      });

      expect(res.status).toBe(200);
      expect(upstreamHears).toHaveLength(1);
      expect(JSON.parse(upstreamHears[0].body)).toEqual({
        model: MODEL,
        messages: [{ role: 'user', content }],
      });
      expect(await usageRows()).toEqual([
        expect.objectContaining({ outcome: 'ok' }),
      ]);
    });

    it('holds calls to the model served until an edit of it is deployed', async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      const edited = await request(httpServer)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie)
        .send({ aiModel: { model: 'all-minilm' } });
      expect(edited.status).toBe(200);

      // Saved, not deployed: the running version still serves the first.
      expect((await chat(caller.key, applicationId)).status).toBe(200);
      const early = await chat(caller.key, applicationId, {
        model: 'all-minilm',
        messages: [],
      });
      expect(early.status).toBe(400);
      expect(early.body).toMatchObject({
        error: {
          message: `This AI model serves '${MODEL}'; set "model" to it`,
        },
      });

      const deployable = await ctx.app
        .get(ApplicationsService)
        .findDeployable(applicationId);
      await ctx.app.get(DeploymentEngineService).deploy(deployable);

      expect(
        (
          await chat(caller.key, applicationId, {
            model: 'all-minilm',
            messages: [],
          })
        ).status,
      ).toBe(200);
      expect((await chat(caller.key, applicationId)).status).toBe(400);
      expect((await usageRows()).map((row) => row.model)).toEqual([
        MODEL,
        MODEL,
        'all-minilm',
        'all-minilm',
      ]);
    });

    it('lists the models the runtime serves on GET /v1/models', async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);

      const res = await request(httpServer)
        .get(`/ai/${applicationId}/v1/models`)
        .set('Authorization', `Bearer ${caller.key}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        object: 'list',
        data: [{ id: MODEL, object: 'model' }],
      });
      expect(await usageRows()).toEqual([
        expect.objectContaining({ endpoint: '/v1/models', outcome: 'ok' }),
      ]);
    });

    it("reaches an AI model on a Server through that Server's address", async () => {
      const [onServer] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'gpu-1',
          ipAddress: '127.0.0.1',
          port: 22,
          organizationId,
        })
        .returning();
      const applicationId = await createAiModel('llm', {
        serverId: onServer.serverId,
      });
      await ctx.db
        .update(application)
        .set({ applicationStatus: 'done' })
        .where(eq(application.applicationId, applicationId));
      const caller = await createAgent('agentCaller', [applicationId]);

      const res = await chat(caller.key, applicationId);

      expect(res.status).toBe(200);
      expect(upstreamHears).toHaveLength(1);
    });

    it("writes the AI model's gateway-only router at deploy: its path and its secret, stripped before the runtime", async () => {
      const applicationId = await runningAiModel();

      const file = parse(readFileSync(ROUTE_FILE, 'utf8')) as FileConfig;
      const secret = await storedSecret(applicationId);
      const prefix = `/cloudgate-gateway/${applicationId}`;
      expect(file.http?.routers).toEqual({
        'llm-gateway-router': {
          rule: `PathPrefix(\`${prefix}/\`) && Header(\`X-Cloudgate-Upstream\`, \`${secret}\`)`,
          service: 'llm-gateway-service',
          entryPoints: ['web'],
          middlewares: ['llm-gateway-strip', 'llm-gateway-unsecret'],
        },
      });
      expect(file.http?.middlewares).toEqual({
        'llm-gateway-strip': { stripPrefix: { prefixes: [prefix] } },
        'llm-gateway-unsecret': {
          headers: { customRequestHeaders: { 'X-Cloudgate-Upstream': '' } },
        },
      });
      expect(file.http?.services).toEqual({
        'llm-gateway-service': {
          loadBalancer: { servers: [{ url: 'http://llm:11434' }] },
        },
      });
    });

    it('writes no audit row for a call', async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      const before = (await auditRows()).length;

      expect((await chat(caller.key, applicationId)).status).toBe(200);
      expect(
        (
          await chat(caller.key, applicationId, {
            model: 'llama3',
            messages: [],
          })
        ).status,
      ).toBe(400);

      expect(await auditRows()).toHaveLength(before);
    });

    it("answers 502 and writes a runtime-error row when the runtime's answer is cut", async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      runtime = () => 'cut';

      const res = await chat(caller.key, applicationId);

      expect(res.status).toBe(502);
      expect(res.body).toEqual({
        error: {
          message: 'AI model did not answer',
          type: 'server_error',
          code: 'model_not_answering',
        },
      });
      expect(await usageRows()).toEqual([
        expect.objectContaining({
          outcome: 'runtime-error',
          promptTokens: 0,
          completionTokens: 0,
        }),
      ]);
    });

    it("takes the model as the runtime's own listing names it, forwarding the caller's spelling", async () => {
      // Ollama's `GET /v1/models` names a bare `all-minilm` as
      // `all-minilm:latest`; a client that sends that id back is asking for
      // the model served.
      const applicationId = await createAiModel('embed', {
        aiModel: { runtime: 'ollama', model: 'all-minilm' },
      });
      const deployable = await ctx.app
        .get(ApplicationsService)
        .findDeployable(applicationId);
      await ctx.app.get(DeploymentEngineService).deploy(deployable);
      const caller = await createAgent('agentCaller', [applicationId]);

      const listed = await chat(caller.key, applicationId, {
        model: 'all-minilm:latest',
        messages: [{ role: 'user', content: 'Say hello' }],
      });
      const asFacet = await chat(caller.key, applicationId, {
        model: 'all-minilm',
        messages: [{ role: 'user', content: 'Say hello' }],
      });

      expect(listed.status).toBe(200);
      expect(asFacet.status).toBe(200);
      expect(
        upstreamHears
          .filter((heard) => heard.url.endsWith('/v1/chat/completions'))
          .map((heard) => (JSON.parse(heard.body) as { model: string }).model),
      ).toEqual(['all-minilm:latest', 'all-minilm']);
    });
  });

  describe("the machine's Traefik answering for a runtime it could not reach", () => {
    it("answers 502 OpenAI-shaped and writes a runtime-error row for Traefik's own 404", async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      // The runtime's router is gone, as while its task is down.
      routes.clear();

      const res = await chat(caller.key, applicationId);

      expect(res.status).toBe(502);
      expect(res.body).toEqual({
        error: {
          message: 'AI model did not answer',
          type: 'server_error',
          code: 'model_not_answering',
        },
      });
      expect(await usageRows()).toEqual([
        expect.objectContaining({ outcome: 'runtime-error', promptTokens: 0 }),
      ]);
    });

    it("hands on the runtime's own JSON error as the runtime's answer", async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      const refusal = {
        error: { message: 'model not found', type: 'api_error' },
      };
      runtime = () => ({ status: 404, body: refusal });

      const res = await chat(caller.key, applicationId);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(refusal);
      expect(await usageRows()).toEqual([
        expect.objectContaining({ outcome: 'ok' }),
      ]);
    });
  });

  describe('refused before authentication: 401 Key refused, and no row', () => {
    async function expectKeyRefused(key: string | null, applicationId: string) {
      const res = await chat(key, applicationId);
      expect(res.status).toBe(401);
      expect(res.body).toEqual(KEY_REFUSED);
    }

    afterEach(async () => {
      expect(await usageRows()).toEqual([]);
      expect(upstreamHears).toEqual([]);
    });

    it('refuses no key and an unknown key', async () => {
      const applicationId = await runningAiModel();

      await expectKeyRefused(null, applicationId);
      await expectKeyRefused('cg_not-a-key-anyone-minted', applicationId);
    });

    it("refuses a person's key", async () => {
      const applicationId = await runningAiModel();
      const minted = await request(httpServer)
        .post('/users/me/api-keys')
        .set('Cookie', ownerCookie)
        .send({ name: 'ci-key' });
      expect(minted.status).toBe(201);

      await expectKeyRefused(
        (minted.body as { key: string }).key,
        applicationId,
      );
    });

    it('refuses a revoked key', async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      const [key] = await ctx.db
        .select({ id: apikey.id })
        .from(apikey)
        .where(eq(apikey.referenceId, caller.id));
      const revoked = await request(httpServer)
        .delete(`/agents/${caller.id}/keys/${key.id}`)
        .set('Cookie', ownerCookie);
      expect(revoked.status).toBe(200);

      await expectKeyRefused(caller.key, applicationId);
    });

    it('refuses an expired key', async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      await ctx.db
        .update(apikey)
        .set({ agentExpiresAt: new Date('2026-03-04T10:00:00Z') })
        .where(eq(apikey.referenceId, caller.id));

      await expectKeyRefused(caller.key, applicationId);
    });

    it("refuses a suspended Agent's key", async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      const suspended = await request(httpServer)
        .post(`/agents/${caller.id}/suspend`)
        .set('Cookie', ownerCookie);
      expect(suspended.status).toBe(200);

      await expectKeyRefused(caller.key, applicationId);
    });
  });

  describe('404 AI model not found or not permitted', () => {
    afterEach(() => {
      expect(upstreamHears).toEqual([]);
    });

    it('refuses a deleted AI model, and writes no row', async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      const deleted = await request(httpServer)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie);
      expect(deleted.status).toBe(200);

      const res = await chat(caller.key, applicationId);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      expect(await usageRows()).toEqual([]);
    });

    it('refuses a plain Application, and writes no row', async () => {
      const plain = await request(httpServer)
        .post('/applications')
        .set('Cookie', ownerCookie)
        .send({ environmentId, name: 'web', appName: 'web' });
      const { applicationId } = plain.body as { applicationId: string };
      const caller = await createAgent('agentCaller', [applicationId]);

      const res = await chat(caller.key, applicationId);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      expect(await usageRows()).toEqual([]);
    });

    it("refuses an AI model outside the Agent's grant, and writes a refused row", async () => {
      const granted = await runningAiModel('llm');
      const other = await runningAiModel('embedder');
      const caller = await createAgent('agentCaller', [granted]);

      const res = await chat(caller.key, other);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      expect(await usageRows()).toEqual([
        expect.objectContaining({
          applicationId: other,
          outcome: 'refused',
          promptTokens: 0,
          completionTokens: 0,
        }),
      ]);
    });

    it('refuses a key whose Agent does not hold call, and writes a refused row', async () => {
      const applicationId = await runningAiModel();
      const reader = await createAgent('agentReader', [applicationId]);

      const res = await chat(reader.key, applicationId);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      expect(await usageRows()).toEqual([
        expect.objectContaining({
          applicationId,
          agentUserId: reader.id,
          endpoint: '/v1/chat/completions',
          outcome: 'refused',
          promptTokens: 0,
          promptTokensEstimated: false,
          completionTokens: 0,
          completionTokensEstimated: false,
        }),
      ]);
    });
  });

  describe('refused after authentication, before the runtime', () => {
    afterEach(() => {
      expect(upstreamHears).toEqual([]);
    });

    const refusedRow = (endpoint: string): unknown =>
      expect.objectContaining({
        endpoint,
        outcome: 'refused',
        promptTokens: 0,
        completionTokens: 0,
      });

    it('refuses /api/pull and other paths outside the allowlist with 404', async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);

      const pull = await request(httpServer)
        .post(`/ai/${applicationId}/api/pull`)
        .set('Authorization', `Bearer ${caller.key}`)
        .send({ model: MODEL });
      const other = await request(httpServer)
        .post(`/ai/${applicationId}/v1/images/generations`)
        .set('Authorization', `Bearer ${caller.key}`)
        .send({ model: MODEL });
      const wrongVerb = await request(httpServer)
        .get(`/ai/${applicationId}/v1/chat/completions`)
        .set('Authorization', `Bearer ${caller.key}`);

      for (const res of [pull, other, wrongVerb]) {
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({
          error: {
            type: 'invalid_request_error',
            code: 'unsupported_endpoint',
          },
        });
      }
      expect(await usageRows()).toEqual([
        refusedRow('/api/pull'),
        refusedRow('/v1/images/generations'),
        refusedRow('/v1/chat/completions'),
      ]);
    });

    it('refuses a body over 16 MiB with 413, and malformed JSON with 400', async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);

      const large = await request(httpServer)
        .post(`/ai/${applicationId}/v1/chat/completions`)
        .set('Authorization', `Bearer ${caller.key}`)
        .set('content-type', 'application/json')
        .send(
          JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: 'x'.repeat(17 * 1024 * 1024) }],
          }),
        );
      const malformed = await request(httpServer)
        .post(`/ai/${applicationId}/v1/chat/completions`)
        .set('Authorization', `Bearer ${caller.key}`)
        .set('content-type', 'application/json')
        .send('{"model":');

      expect(large.status).toBe(413);
      expect(large.body).toEqual({
        error: {
          message: 'The request body is larger than the gateway takes (16 MiB)',
          type: 'invalid_request_error',
          code: 'request_too_large',
        },
      });
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({
        error: { type: 'invalid_request_error', code: 'invalid_json' },
      });
      expect(await usageRows()).toEqual([
        refusedRow('/v1/chat/completions'),
        refusedRow('/v1/chat/completions'),
      ]);
    });

    it('refuses a model other than the one served with 400, never rewriting it', async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);

      const res = await chat(caller.key, applicationId, {
        model: 'llama3',
        messages: [{ role: 'user', content: 'Say hello' }],
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: {
          message: `This AI model serves '${MODEL}'; set "model" to it`,
          type: 'invalid_request_error',
          code: 'model_mismatch',
        },
      });
      expect(await usageRows()).toEqual([refusedRow('/v1/chat/completions')]);
    });

    it('refuses a stopped AI model with 503', async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      const stopped = await request(httpServer)
        .post(`/applications/${applicationId}/stop`)
        .set('Cookie', ownerCookie);
      expect(stopped.status).toBe(200);

      const res = await chat(caller.key, applicationId);

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: {
          message: 'AI model is not running',
          type: 'server_error',
          code: 'model_not_running',
        },
      });
      expect(await usageRows()).toEqual([refusedRow('/v1/chat/completions')]);
    });
  });

  describe('how long a row lives', () => {
    it("outlives the Agent's removal, keeping its name", async () => {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      expect((await chat(caller.key, applicationId)).status).toBe(200);

      const removed = await request(httpServer)
        .delete(`/agents/${caller.id}`)
        .set('Cookie', ownerCookie);
      expect(removed.status).toBe(200);

      expect(await usageRows()).toEqual([
        expect.objectContaining({
          applicationId,
          agentUserId: null,
          agentName: 'support-bot',
          outcome: 'ok',
        }),
      ]);
    });

    async function oneCall(): Promise<string> {
      const applicationId = await runningAiModel();
      const caller = await createAgent('agentCaller', [applicationId]);
      expect((await chat(caller.key, applicationId)).status).toBe(200);
      expect(await usageRows()).toHaveLength(1);
      return applicationId;
    }

    it('goes with the AI model, whose Delete removes its gateway-only router', async () => {
      const applicationId = await oneCall();
      expect(existsSync(ROUTE_FILE)).toBe(true);

      const deleted = await request(httpServer)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie);

      expect(deleted.status).toBe(200);
      expect(await usageRows()).toEqual([]);
      expect(existsSync(ROUTE_FILE)).toBe(false);
    });

    it("goes with the AI model's Environment, whose Delete removes its gateway-only router", async () => {
      await oneCall();
      expect(existsSync(ROUTE_FILE)).toBe(true);

      const deleted = await request(httpServer)
        .delete(`/environments/${environmentId}`)
        .set('Cookie', ownerCookie);

      expect(deleted.status).toBe(200);
      expect(await usageRows()).toEqual([]);
      expect(existsSync(ROUTE_FILE)).toBe(false);
    });

    it("goes with the AI model's Project", async () => {
      await oneCall();

      const deleted = await request(httpServer)
        .delete(`/projects/${projectId}`)
        .set('Cookie', ownerCookie);

      expect(deleted.status).toBe(200);
      expect(await usageRows()).toEqual([]);
    });
  });

  describe('beside the AI provider routes under /ai', () => {
    it("leaves the AI provider's own routes to AiController", async () => {
      const list = await request(httpServer)
        .get('/ai')
        .set('Cookie', ownerCookie);
      expect(list.status).toBe(200);
      expect(Array.isArray(list.body)).toBe(true);

      const probe = await request(httpServer)
        .post('/ai/no-such-provider/test-connection')
        .set('Cookie', ownerCookie);
      expect(probe.body).not.toEqual(KEY_REFUSED);
      expect(probe.status).toBe(404);
    });
  });
});
