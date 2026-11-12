import { createServer, request as httpRequest } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { aiModelFacet, aiUsage, apikey } from '../../src/db/schema';
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
 * The Gateway, streamed (spec slice 2, the gateway ADR): a stream
 * arrives as the runtime produces it and is metered however it ends, observed
 * where a caller and an operator observe it — the events the caller reads as
 * they come, what reached the upstream, whether the upstream's request was
 * abandoned, and the usage rows.
 *
 * The upstream is a local stub HTTP server standing in for the AI model's
 * machine's Traefik and the runtime behind it, as in `gateway.e2e-spec.ts`,
 * here scripted per test to stream server-sent events chunk by chunk (each
 * after the test lets it), with or without the usage chunk, to cut its
 * connection mid-stream, or to hold the stream open. The caller is a raw
 * `http.request` rather than supertest, which buffers the whole answer, so a
 * test can read each event as it arrives and hang up mid-stream.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const MODEL = 'smollm2:135m';
const OLLAMA = { runtime: 'ollama', model: MODEL };
const ASK = {
  model: MODEL,
  messages: [{ role: 'user', content: 'Say hello' }],
  stream: true,
};

const chunk = (content: string) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  model: MODEL,
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});
/** The usage chunk OpenAI defines for `include_usage`: no choices, only usage. */
const USAGE_CHUNK = {
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  model: MODEL,
  choices: [],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
};
const event = (data: unknown) =>
  `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

type ExecOptions = { env?: Record<string, string | undefined> };

/** What reached the upstream, and how its side of the call ended. */
interface Heard {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
  /** Resolves when the upstream request closes before its answer is whole. */
  abandoned: Promise<void>;
}

/** One streamed call, as its caller reads it. */
interface Streamed {
  status: number;
  headers: IncomingHttpHeaders;
  /** Resolves with the next event the caller reads, as `data:` payload. */
  next(): Promise<string>;
  /** Resolves with every event still to come, once the stream ends. */
  rest(): Promise<string[]>;
  /** Hangs up mid-stream. */
  hangUp(): void;
}

describe('Gateway, streamed (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let gatewayPort: number;

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

  const upstreamHears: Heard[] = [];
  /** The secret the stub's router accepts, per AI model's path prefix. */
  const routes = new Map<string, string>();
  /** How the runtime answers this test's calls, given the raw response. */
  let runtime: (heard: Heard, res: ServerResponse) => void;

  const upstream: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (data: Buffer) => chunks.push(data));
      req.on('end', () => {
        const abandoned = new Promise<void>((resolve) =>
          res.on('close', () => {
            if (!res.writableFinished) resolve();
          }),
        );
        const heard: Heard = {
          url: req.url ?? '',
          headers: req.headers,
          body: JSON.parse(
            Buffer.concat(chunks).toString('utf8') || '{}',
          ) as Record<string, unknown>,
          abandoned,
        };
        upstreamHears.push(heard);
        const routed = [...routes].some(
          ([prefix, secret]) =>
            heard.url.startsWith(`${prefix}/`) &&
            heard.headers['x-cloudgate-upstream'] === secret,
        );
        if (!routed) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('404 page not found');
          return;
        }
        runtime(heard, res);
      });
    },
  );

  /** The stub's stream, one event per `release()`, so a test paces it. */
  function pacedStream(events: string[]) {
    let res: ServerResponse | undefined;
    let sent = 0;
    const sendNext = () => {
      if (!res || sent >= events.length) return;
      res.write(events[sent]);
      sent += 1;
      if (sent === events.length) res.end();
    };
    return {
      runtime: (_heard: Heard, answer: ServerResponse) => {
        res = answer;
        answer.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        answer.flushHeaders();
        sendNext();
      },
      release: sendNext,
      /** Cuts the runtime's connection, the stream unfinished. */
      cut: () => res?.socket?.destroy(),
    };
  }

  /** Every event at once, then the end: a runtime that just streams. */
  const streams =
    (events: string[]) => (_heard: Heard, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const each of events) res.write(each);
      res.end();
    };

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
    const listening = ctx.app.getHttpServer() as Server;
    await new Promise<void>((resolve) =>
      listening.listen(0, '127.0.0.1', resolve),
    );
    gatewayPort = (listening.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await ctx.teardown();
    upstream.closeAllConnections();
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

  /** An AI model, deployed through the real engine, and routed by the stub. */
  async function runningAiModel(): Promise<string> {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', ownerCookie)
      .send({ environmentId, name: 'llm', appName: 'llm', aiModel: OLLAMA });
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

  async function createCaller(
    applicationId: string,
  ): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({
        name: 'support-bot',
        role: 'agentCaller',
        grant: { accessedServices: [applicationId] },
      });
    expect(res.status).toBe(201);
    const body = res.body as { agent: { id: string }; key: string };
    return { id: body.agent.id, key: body.key };
  }

  /** Opens a streamed chat completion as an OpenAI client would, raw. */
  function openStream(
    key: string,
    applicationId: string,
    body: Record<string, unknown> = ASK,
  ): Promise<Streamed> {
    const payload = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: gatewayPort,
        method: 'POST',
        path: `/ai/${applicationId}/v1/chat/completions`,
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'content-length': payload.length,
        },
      });
      req.on('error', reject);
      req.on('response', (res) => {
        const read: string[] = [];
        const waiting: ((data: string) => void)[] = [];
        let pending = '';
        let ended = false;
        const ends: (() => void)[] = [];
        res.setEncoding('utf8');
        res.on('data', (text: string) => {
          pending += text;
          let split = pending.indexOf('\n\n');
          while (split >= 0) {
            const data = pending.slice(0, split).replace(/^data: /, '');
            pending = pending.slice(split + 2);
            const waiter = waiting.shift();
            if (waiter) waiter(data);
            else read.push(data);
            split = pending.indexOf('\n\n');
          }
        });
        const end = () => {
          ended = true;
          ends.splice(0).forEach((done) => done());
        };
        res.on('end', end);
        res.on('close', end);
        res.on('error', () => undefined);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          next: () =>
            read.length > 0
              ? Promise.resolve(read.shift() as string)
              : new Promise((done) => waiting.push(done)),
          rest: () =>
            new Promise((done) => {
              const all = () => done(read.splice(0));
              if (ended) all();
              else ends.push(all);
            }),
          hangUp: () => req.destroy(),
        });
      });
      req.end(payload);
    });
  }

  /** The usage rows, once `count` of them have been written. */
  async function rowsOnce(count = 1) {
    for (let tries = 0; tries < 100; tries += 1) {
      const rows = await ctx.db.select().from(aiUsage);
      if (rows.length >= count) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return ctx.db.select().from(aiUsage);
  }

  it('hands on each event as the runtime produces it, forcing include_usage upstream and keeping the usage chunk from a caller who did not ask, writing a reported row', async () => {
    const applicationId = await runningAiModel();
    const caller = await createCaller(applicationId);
    const stub = pacedStream([
      event(chunk('Hello')),
      event(chunk(' there')),
      event(USAGE_CHUNK),
      event('[DONE]'),
    ]);
    runtime = stub.runtime;

    const stream = await openStream(caller.key, applicationId);

    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(stream.headers['cache-control']).toBe('no-cache');
    // The first event arrives while the runtime is still holding the second.
    expect(JSON.parse(await stream.next())).toEqual(chunk('Hello'));
    stub.release();
    expect(JSON.parse(await stream.next())).toEqual(chunk(' there'));
    stub.release();
    stub.release();
    expect(await stream.rest()).toEqual(['[DONE]']);

    const [heard] = upstreamHears;
    expect(heard.body).toEqual({
      ...ASK,
      stream_options: { include_usage: true },
    });
    expect(await rowsOnce()).toEqual([
      expect.objectContaining({
        streamed: true,
        outcome: 'ok',
        promptTokens: 12,
        promptTokensEstimated: false,
        completionTokens: 5,
        completionTokensEstimated: false,
      }),
    ]);
  });

  it('hands the usage chunk on to a caller who asked for it', async () => {
    const applicationId = await runningAiModel();
    const caller = await createCaller(applicationId);
    runtime = streams([
      event(chunk('Hello')),
      event(USAGE_CHUNK),
      event('[DONE]'),
    ]);

    const stream = await openStream(caller.key, applicationId, {
      ...ASK,
      stream_options: { include_usage: true },
    });

    expect(await stream.rest()).toEqual([
      JSON.stringify(chunk('Hello')),
      JSON.stringify(USAGE_CHUNK),
      '[DONE]',
    ]);
    expect(await rowsOnce()).toEqual([
      expect.objectContaining({
        outcome: 'ok',
        promptTokensEstimated: false,
        completionTokensEstimated: false,
      }),
    ]);
  });

  it('writes a row with its tokens flagged estimated when the usage never arrives', async () => {
    const applicationId = await runningAiModel();
    const caller = await createCaller(applicationId);
    runtime = streams([
      event(chunk('Hello')),
      event(chunk(' there')),
      event('[DONE]'),
    ]);

    const stream = await openStream(caller.key, applicationId);

    expect(await stream.rest()).toHaveLength(3);
    const rows = await rowsOnce();
    expect(rows).toEqual([
      expect.objectContaining({
        streamed: true,
        outcome: 'ok',
        promptTokensEstimated: true,
        completionTokensEstimated: true,
      }),
    ]);
    // Counted, not left at zero; how many is the tokenizer's business.
    expect(rows[0].promptTokens).toBeGreaterThan(0);
    expect(rows[0].completionTokens).toBeGreaterThan(0);
  });

  it("abandons the runtime's request when the caller hangs up, and writes a client-aborted row", async () => {
    const applicationId = await runningAiModel();
    const caller = await createCaller(applicationId);
    const stub = pacedStream([
      event(chunk('Hello')),
      event(chunk(' there')),
      event(USAGE_CHUNK),
      event('[DONE]'),
    ]);
    runtime = stub.runtime;

    const stream = await openStream(caller.key, applicationId);
    await stream.next();
    stream.hangUp();

    await upstreamHears[0].abandoned;
    expect(await rowsOnce()).toEqual([
      expect.objectContaining({
        streamed: true,
        outcome: 'client-aborted',
        promptTokensEstimated: true,
        completionTokensEstimated: true,
      }),
    ]);
  });

  it('writes a runtime-error row when the runtime breaks off mid-stream', async () => {
    const applicationId = await runningAiModel();
    const caller = await createCaller(applicationId);
    const stub = pacedStream([
      event(chunk('Hello')),
      event(chunk(' there')),
      event('[DONE]'),
    ]);
    runtime = stub.runtime;

    const stream = await openStream(caller.key, applicationId);
    await stream.next();
    stub.cut();

    // The caller's stream ends unfinished: no `[DONE]`.
    expect(await stream.rest()).not.toContain('[DONE]');
    expect(await rowsOnce()).toEqual([
      expect.objectContaining({
        streamed: true,
        outcome: 'runtime-error',
        promptTokensEstimated: true,
        completionTokensEstimated: true,
      }),
    ]);
  });

  it('lets a stream running when its key is revoked finish and write its row, and refuses the next call 401', async () => {
    const applicationId = await runningAiModel();
    const caller = await createCaller(applicationId);
    const stub = pacedStream([
      event(chunk('Hello')),
      event(USAGE_CHUNK),
      event('[DONE]'),
    ]);
    runtime = stub.runtime;

    const stream = await openStream(caller.key, applicationId);
    await stream.next();
    const [key] = await ctx.db
      .select({ id: apikey.id })
      .from(apikey)
      .where(eq(apikey.referenceId, caller.id));
    const revoked = await request(httpServer)
      .delete(`/agents/${caller.id}/keys/${key.id}`)
      .set('Cookie', ownerCookie);
    expect(revoked.status).toBe(200);
    stub.release();
    stub.release();

    expect(await stream.rest()).toEqual(['[DONE]']);
    expect(await rowsOnce()).toEqual([
      expect.objectContaining({ outcome: 'ok', promptTokens: 12 }),
    ]);

    const next = await request(httpServer)
      .post(`/ai/${applicationId}/v1/chat/completions`)
      .set('Authorization', `Bearer ${caller.key}`)
      .send(ASK);
    expect(next.status).toBe(401);
    expect(upstreamHears).toHaveLength(1);
    expect(await ctx.db.select().from(aiUsage)).toHaveLength(1);
  });
});
