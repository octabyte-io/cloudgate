import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { mintAgentKey } from '../../src/agents/agent-key';
import { apikey, auditLog, user } from '../../src/db/schema';
import {
  MCP_RATE_BUCKET_CLOCK,
  MCP_RATE_LIMIT_LISTENER,
} from '../../src/mcp/rate-bucket';
import type { AgentRateLimited } from '../../src/mcp/rate-bucket';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * The per-Agent rate bucket at the real endpoint (spec Testing
 * Decisions §1 and §5): a real Agent key against `POST /mcp`, asserting on the
 * HTTP answer and the audit rows.
 *
 * The one double is the bucket's clock, which stands still unless a test moves
 * it — otherwise the two reads a second that refill during 60 HTTP calls would
 * make "the 61st call" a race. The bucket, its budgets and the dispatcher are
 * the ones `McpModule` binds. The listener is replaced by a recorder, which is
 * how the episode tracker will see the same 429.
 *
 * The sentences are written out rather than imported (§1.7).
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const FINALITY =
  'This is an access decision, not a failure. Retrying, or trying another tool or id, will not change it. Tell the operator what you needed.';

/** Reads: a burst of 60, refilled at two a second. */
const READ_BURST = 60;
/** Writes: a burst of 5. */
const WRITE_BURST = 5;

let now = 5_000_000;
const clock = { now: () => now };
const rateLimited: AgentRateLimited[] = [];
const listener = {
  rateLimited: (event: AgentRateLimited) => {
    rateLimited.push(event);
  },
};

describe('MCP rate limit (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MCP_RATE_BUCKET_CLOCK, useValue: clock },
        { provide: MCP_RATE_LIMIT_LISTENER, useValue: listener },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    rateLimited.length = 0;
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
  });

  async function createAgent(): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({ name: 'loop-bot', role: 'agentReader', grant: {} });
    expect(res.status).toBe(201);
    const body = res.body as { agent: { id: string }; key: string };
    return { id: body.agent.id, key: body.key };
  }

  /** A second key on the same Agent, as key rotation will mint one. */
  async function secondKey(agentId: string): Promise<string> {
    const minted = await mintAgentKey(agentId, 90);
    await ctx.db.insert(apikey).values(minted.row);
    return minted.key;
  }

  function listProjects(key: string) {
    return request(httpServer)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('MCP-Protocol-Version', '2025-06-18')
      .set('Authorization', `Bearer ${key}`)
      .send({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'list_projects', arguments: {} },
      });
  }

  function postMcp(
    key: string,
    body: unknown,
    headers: Record<string, string> = { 'MCP-Protocol-Version': '2025-06-18' },
  ) {
    let req = request(httpServer)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${key}`);
    for (const [name, value] of Object.entries(headers)) {
      req = req.set(name, value);
    }
    return req.send(body as object);
  }

  const toolCall = (id: number, name: string, args: object = {}) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  const DEPLOY_ARGS = { serviceType: 'application', serviceId: 'svc-1' };

  /** A Reader's deploys: 403 on permission while tokens remain, 429 after. */
  async function deployStatuses(key: string, times: number) {
    const statuses: number[] = [];
    for (let i = 0; i < times; i++) {
      statuses.push(
        (await postMcp(key, toolCall(9, 'deploy_service', DEPLOY_ARGS))).status,
      );
    }
    return statuses;
  }

  async function rowsOf(agentId: string) {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, agentId))
      .orderBy(asc(auditLog.createdAt));
    return rows.map((row) => {
      const metadata = JSON.parse(row.metadata ?? '{}') as Record<
        string,
        unknown
      >;
      return [row.outcome, metadata.reason ?? null, metadata.tool];
    });
  }

  async function callTimes(key: string, times: number): Promise<number[]> {
    const statuses: number[] = [];
    for (let i = 0; i < times; i++) {
      statuses.push((await listProjects(key)).status);
    }
    return statuses;
  }

  async function refusals(agentId: string) {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, agentId))
      .orderBy(asc(auditLog.createdAt));
    return rows
      .filter((row) => row.outcome === 'refused')
      .map((row) => {
        const metadata = JSON.parse(row.metadata ?? '{}') as Record<
          string,
          unknown
        >;
        return [row.resourceType, row.action, metadata.reason, metadata.tool];
      });
  }

  it('answers the read past the burst with 429, Retry-After, the wait sentence and no finality sentence, and a refused rate-limit row', async () => {
    const agent = await createAgent();

    expect(await callTimes(agent.key, READ_BURST)).toEqual(
      Array.from({ length: READ_BURST }, () => 200),
    );
    const res = await listProjects(agent.key);

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      code: 'refused',
      reason: 'rate-limit',
      tool: 'list_projects',
      message:
        'Rate limit reached for this Agent. Wait 1 seconds before the next call.',
    });
    expect(JSON.stringify(res.body)).not.toContain(FINALITY);
    expect(await refusals(agent.id)).toEqual([
      ['project', 'read', 'rate-limit', 'list_projects'],
    ]);
    expect(rateLimited).toEqual([
      expect.objectContaining({
        agentUserId: agent.id,
        tool: 'list_projects',
        budget: 'read',
        retryAfterSeconds: 1,
      }),
    ]);

    // Waiting is the answer: after Retry-After the next read goes through.
    now += 1_000;
    expect((await listProjects(agent.key)).status).toBe(200);
  });

  it('refuses a suspended Agent past its budget with 403, never 429', async () => {
    const agent = await createAgent();
    await callTimes(agent.key, READ_BURST);
    expect((await listProjects(agent.key)).status).toBe(429);
    rateLimited.length = 0;

    await ctx.db
      .update(user)
      .set({ banned: true })
      .where(eq(user.id, agent.id));
    const res = await listProjects(agent.key);

    expect(res.status).toBe(403);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.body).toEqual({
      code: 'refused',
      reason: 'suspended',
      message: `This Agent has been suspended by an operator. ${FINALITY}`,
    });
    expect(await callTimes(agent.key, 5)).toEqual([403, 403, 403, 403, 403]);
    expect((await refusals(agent.id)).map((row) => row[2])).toEqual([
      'rate-limit',
      'suspended',
      'suspended',
      'suspended',
      'suspended',
      'suspended',
      'suspended',
    ]);
    expect(rateLimited).toEqual([]);
  });

  it("spends nothing from a suspended Agent's budget, so reinstated it has its whole burst", async () => {
    const agent = await createAgent();
    await ctx.db
      .update(user)
      .set({ banned: true })
      .where(eq(user.id, agent.id));
    expect(new Set(await callTimes(agent.key, READ_BURST + 5))).toEqual(
      new Set([403]),
    );

    await ctx.db
      .update(user)
      .set({ banned: false })
      .where(eq(user.id, agent.id));
    expect(await callTimes(agent.key, READ_BURST)).toEqual(
      Array.from({ length: READ_BURST }, () => 200),
    );
    expect((await listProjects(agent.key)).status).toBe(429);
  });

  it('counts two keys on one Agent against one bucket', async () => {
    const agent = await createAgent();
    const other = await secondKey(agent.id);
    const half = READ_BURST / 2;

    expect(await callTimes(agent.key, half)).toEqual(
      Array.from({ length: half }, () => 200),
    );
    expect(await callTimes(other, half)).toEqual(
      Array.from({ length: half }, () => 200),
    );

    expect((await listProjects(other)).status).toBe(429);
    expect((await listProjects(agent.key)).status).toBe(429);
    expect(await refusals(agent.id)).toEqual([
      ['project', 'read', 'rate-limit', 'list_projects'],
      ['project', 'read', 'rate-limit', 'list_projects'],
    ]);
  });

  it('keeps one Agent running dry from touching another Agent', async () => {
    const dry = await createAgent();
    const fresh = await createAgent();
    await callTimes(dry.key, READ_BURST);

    expect((await listProjects(dry.key)).status).toBe(429);
    expect((await listProjects(fresh.key)).status).toBe(200);
  });

  describe('every call is accounted for', () => {
    it("answers a Reader's deploy_service at an unserved 2026 revision with 400 and -32022, one unsupported-revision row, and no token spent", async () => {
      const agent = await createAgent();

      const res = await postMcp(
        agent.key,
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'deploy_service',
            arguments: DEPLOY_ARGS,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-12-01',
              'io.modelcontextprotocol/clientInfo': {
                name: 'codex',
                version: '1',
              },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        },
        {
          'MCP-Protocol-Version': '2026-12-01',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'deploy_service',
        },
      );

      expect(res.status).toBe(400);
      expect((res.body as { error: { code: number } }).error.code).toBe(-32022);
      expect(await rowsOf(agent.id)).toEqual([
        ['refused', 'unsupported-revision', 'deploy_service'],
      ]);
      // The whole write burst is still there: five permission refusals (each
      // spends, as the bucket runs before permission), then the 429.
      expect(await deployStatuses(agent.key, WRITE_BURST + 1)).toEqual([
        403, 403, 403, 403, 403, 429,
      ]);
    });

    it('writes one refused unknown-tool row for a call naming no tool, and spends nothing', async () => {
      const agent = await createAgent();

      const res = await postMcp(agent.key, toolCall(5, 'drop_database'));

      expect(res.status).toBe(200);
      expect(await rowsOf(agent.id)).toEqual([
        ['refused', 'unknown-tool', null],
      ]);
    });

    it('writes one failed invalid-arguments row for arguments the input schema rejects, and spends nothing', async () => {
      const agent = await createAgent();

      const res = await postMcp(
        agent.key,
        toolCall(6, 'list_environments', { projectId: 42 }),
      );

      expect(res.status).toBe(200);
      expect(await rowsOf(agent.id)).toEqual([
        ['failed', 'invalid-arguments', 'list_environments'],
      ]);
      expect(await callTimes(agent.key, READ_BURST)).toEqual(
        Array.from({ length: READ_BURST }, () => 200),
      );
      expect((await listProjects(agent.key)).status).toBe(429);
    });

    it('refuses a 2025-03-26 batch as a whole: the refused call has its row, every call that never ran a batch-refused row, and none of those spends a token', async () => {
      const agent = await createAgent();

      const res = await postMcp(
        agent.key,
        [
          toolCall(1, 'list_projects'),
          toolCall(2, 'deploy_service', DEPLOY_ARGS),
          toolCall(3, 'list_projects'),
        ],
        { 'MCP-Protocol-Version': '2025-03-26' },
      );

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: 'refused',
        reason: 'permission',
        tool: 'deploy_service',
      });
      expect(await rowsOf(agent.id)).toEqual([
        ['refused', 'batch-refused', 'list_projects'],
        ['refused', 'permission', 'deploy_service'],
        ['refused', 'batch-refused', 'list_projects'],
      ]);
      // Neither list_projects spent a read token...
      expect(await callTimes(agent.key, READ_BURST)).toEqual(
        Array.from({ length: READ_BURST }, () => 200),
      );
      expect((await listProjects(agent.key)).status).toBe(429);
      // ...and the refused deploy spent the one token a lone refused deploy
      // spends, the bucket running before permission.
      expect(await deployStatuses(agent.key, WRITE_BURST)).toEqual([
        403, 403, 403, 403, 429,
      ]);
    });

    it('refuses a batch that runs past the budget with 429, giving back the token of the call admitted before it', async () => {
      const agent = await createAgent();
      expect(await callTimes(agent.key, READ_BURST - 1)).toEqual(
        Array.from({ length: READ_BURST - 1 }, () => 200),
      );

      const res = await postMcp(
        agent.key,
        [
          toolCall(1, 'list_projects'),
          toolCall(2, 'list_projects'),
          toolCall(3, 'no_such_tool'),
        ],
        { 'MCP-Protocol-Version': '2025-03-26' },
      );

      expect(res.status).toBe(429);
      expect(await rowsOf(agent.id)).toEqual([
        ...Array.from({ length: READ_BURST - 1 }, () => [
          'succeeded',
          null,
          'list_projects',
        ]),
        ['refused', 'batch-refused', 'list_projects'],
        ['refused', 'rate-limit', 'list_projects'],
        ['refused', 'unknown-tool', null],
      ]);
      // The first call's token came back: one read is still left.
      expect((await listProjects(agent.key)).status).toBe(200);
      expect((await listProjects(agent.key)).status).toBe(429);
    });
  });
});
