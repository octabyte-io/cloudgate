import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  auditLog,
  member,
  organization,
  webServerSettings,
} from '../../src/db/schema';
import {
  countRateLimitedQuery,
  lastRateLimitedQuery,
} from '../../src/enterprise/audit-logs/rate-limit-refusals';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { MCP_RATE_BUCKET_CLOCK } from '../../src/mcp/rate-bucket';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * The loop signal at the real endpoint (spec stories 53–54): a real
 * Agent key run past its read budget at `POST /mcp`, observed where an operator
 * observes it — the Agent's row in `GET /agents`, and a Slack webhook on the
 * mocked fetch client, the only proof anybody was told.
 *
 * The bucket's clock stands still, as in `mcp-rate-limit.e2e-spec.ts`, so "the
 * 61st call" is not a race. The episode tracker, its audit read and the
 * notifier are the ones `McpModule` binds, on the real clock: every test's
 * Agent is new, so one process's memory of earlier tests' Agents is inert.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** Reads: a burst of 60. */
const READ_BURST = 60;
const MINUTE = 60_000;

const clock = { now: () => 5_000_000 };
const fetchMock = jest.fn();

describe('Agent rate limited (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MCP_RATE_BUCKET_CLOCK, useValue: clock },
        { provide: FETCH_CLIENT, useValue: fetchMock },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    fetchMock.mockReset().mockResolvedValue({ ok: true, statusText: 'OK' });
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
  });

  async function createAgent(
    name = 'loop-bot',
  ): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({ name, role: 'agentReader', grant: {} });
    expect(res.status).toBe(201);
    const body = res.body as { agent: { id: string }; key: string };
    return { id: body.agent.id, key: body.key };
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

  /** Spends the burst, then earns `times` 429s. */
  async function runDry(key: string, times: number): Promise<void> {
    for (let i = 0; i < READ_BURST; i++) {
      expect((await listProjects(key)).status).toBe(200);
    }
    for (let i = 0; i < times; i++) {
      expect((await listProjects(key)).status).toBe(429);
    }
  }

  async function agentRow(id: string) {
    const res = await request(httpServer)
      .get('/agents')
      .set('Cookie', ownerCookie);
    expect(res.status).toBe(200);
    return (res.body as { id: string; rateLimitedLastHour: number }[]).find(
      (agent) => agent.id === id,
    )!;
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
    return res.body as { agentRateLimited: boolean };
  }

  /** The bodies posted to one webhook, once the listener has had its turn. */
  async function postedTo(hook: string, settle = 1_000): Promise<string[]> {
    // The dispatcher does not wait on the listener, so the 429 is answered
    // before the notification goes out; give it the time the audit read and
    // the fan-out take, then read what arrived.
    await new Promise((resolve) => setTimeout(resolve, settle));
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith(`/${hook}`))
      .map(([, init]) => String((init as { body: string }).body));
  }

  /** A rate-limit refusal row written `ago` ms back, as a previous process left it. */
  async function earlierRefusal(
    agentId: string,
    ago: number,
    reason = 'rate-limit',
  ) {
    const [row] = await ctx.db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, agentId));
    await ctx.db.insert(auditLog).values({
      organizationId: row.organizationId,
      userId: agentId,
      userEmail: `${agentId}@agents.cloudgate.invalid`,
      userRole: 'agentReader',
      action: 'read',
      resourceType: 'project',
      outcome: 'refused',
      metadata: JSON.stringify({ tool: 'list_projects', reason }),
      createdAt: new Date(Date.now() - ago),
    });
  }

  describe("the Agent's row", () => {
    it('reads no rate limits before a 429', async () => {
      const agent = await createAgent();

      expect((await agentRow(agent.id)).rateLimitedLastHour).toBe(0);
    });

    it("counts the Agent's 429s in the last hour, and only those", async () => {
      const agent = await createAgent();
      await earlierRefusal(agent.id, 2 * 60 * MINUTE);
      await earlierRefusal(agent.id, 5 * MINUTE, 'permission');

      await runDry(agent.key, 2);

      expect((await agentRow(agent.id)).rateLimitedLastHour).toBe(2);
    });
  });

  describe('the Notification', () => {
    it('is off on a channel created without it', async () => {
      const created = await slackChannel({ appDeploy: true }, 'DEFAULT');

      expect(created.agentRateLimited).toBe(false);
    });

    it('reaches only the channels that opted in, once for an episode', async () => {
      await slackChannel({ agentRateLimited: true }, 'OPTED');
      await slackChannel({ appDeploy: true, licenseLapse: true }, 'DEFAULT');
      const agent = await createAgent();

      await runDry(agent.key, 3);

      const opted = await postedTo('OPTED');
      expect(opted).toHaveLength(1);
      const [org] = await ctx.db.select().from(organization).limit(1);
      for (const fragment of [
        'loop-bot',
        org.name,
        'reads, 120 a minute with bursts of 60',
        'Suspend it to stop it now; its keys and access are kept.',
      ]) {
        expect(opted[0]).toContain(fragment);
      }
      // No instance URL is configured here, so there is no row to link to.
      expect(opted[0]).not.toContain('/settings/agents');
      expect(await postedTo('DEFAULT', 0)).toEqual([]);
    });

    it("names the key and links to the Agent's row on the instance", async () => {
      await ctx.db
        .insert(webServerSettings)
        .values({ host: 'cloudgate.example.com', https: true });
      await slackChannel({ agentRateLimited: true }, 'OPTED');
      const agent = await createAgent();

      await runDry(agent.key, 1);

      const [sent] = await postedTo('OPTED');
      expect(sent).toContain(
        `https://cloudgate.example.com/settings/agents#agent-${agent.id}`,
      );
      expect(sent).toContain(`${agent.key.slice(0, 6)}…`);
      expect(sent).not.toContain(agent.key);
    });

    it('stays silent after a restart when the episode was already open', async () => {
      await slackChannel({ agentRateLimited: true }, 'OPTED');
      const agent = await createAgent();
      await earlierRefusal(agent.id, 10 * MINUTE);

      await runDry(agent.key, 1);

      expect(await postedTo('OPTED')).toEqual([]);
    });

    it('raises it after a restart when the last 429 before it is over an hour old', async () => {
      await slackChannel({ agentRateLimited: true }, 'OPTED');
      const agent = await createAgent();
      await earlierRefusal(agent.id, 70 * MINUTE);

      await runDry(agent.key, 1);

      expect(await postedTo('OPTED')).toHaveLength(1);
    });
  });

  /**
   * The restart check and the row's count are each one query, and each reads
   * `audit_log_refused_user_created_at_idx` rather than scanning the trail —
   * asserted on the plan Postgres chooses for the exact SQL the service runs,
   * over a trail where the Agent's refusals are a sliver of its rows.
   */
  describe('the audit reads', () => {
    const INDEX = 'audit_log_refused_user_created_at_idx';

    async function planOf(query: { getSQL(): ReturnType<typeof sql> }) {
      const result = await ctx.db.execute(
        sql`explain (format json) ${query.getSQL()}`,
      );
      const [row] = result.rows as { 'QUERY PLAN': unknown }[];
      return JSON.stringify(row['QUERY PLAN']);
    }

    beforeEach(async () => {
      const agent = await createAgent();
      const [org] = await ctx.db.select().from(organization).limit(1);
      await ctx.db.execute(sql`
        insert into audit_log (audit_log_id, organization_id, user_id, user_email, user_role, action, resource_type, outcome, metadata, created_at)
        select 'bulk-' || n, ${org.id}, ${agent.id}, 'x@agents.cloudgate.invalid', 'agentReader', 'read', 'project',
               case when n % 50 = 0 then 'refused' else 'succeeded' end,
               case when n % 50 = 0 then '{"reason":"rate-limit"}' else '{"tool":"list_projects"}' end,
               now() - (n || ' seconds')::interval
          from generate_series(1, 20000) as n
      `);
      await ctx.db.execute(sql`analyze audit_log`);
    });

    it('answers the restart check from the index, in one query', async () => {
      const [bulk] = await ctx.db
        .select({ userId: auditLog.userId })
        .from(auditLog)
        .limit(1);
      const now = Date.now();

      const plan = await planOf(
        lastRateLimitedQuery(
          ctx.db,
          bulk.userId!,
          new Date(now - 60 * MINUTE),
          new Date(now),
        ),
      );

      expect(plan).toContain(`"Index Name":"${INDEX}"`);
      expect(plan).not.toContain('Seq Scan');
    });

    it("answers the row's count from the index, in one query", async () => {
      const [bulk] = await ctx.db
        .select({ userId: auditLog.userId })
        .from(auditLog)
        .limit(1);

      const plan = await planOf(
        countRateLimitedQuery(
          ctx.db,
          [bulk.userId!],
          new Date(Date.now() - 60 * MINUTE),
        ),
      );

      expect(plan).toContain(`"Index Name":"${INDEX}"`);
      expect(plan).not.toContain('Seq Scan');
    });
  });
});
