import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { apikey, auditLog, environment, user } from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

/**
 * The MCP endpoint driven from outside (spec Testing Decisions §1):
 * a real Agent key against the real `POST /mcp`, asserting on the HTTP answer
 * and on the audit rows it leaves — never on the dispatcher's insides.
 *
 * The sentences are written out here rather than imported (§1.7: the expected
 * value comes from an independent source), so a reworded refusal reds.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const FINALITY =
  'This is an access decision, not a failure. Retrying, or trying another tool or id, will not change it. Tell the operator what you needed.';
const NOT_FOUND_OR_NOT_PERMITTED = `Not found or not permitted. ${FINALITY}`;
const INVALID_KEY = 'This key is not valid.';
const INVALID_TOKEN = 'Bearer error="invalid_token"';

/** A value long enough to be masked, stored as a secret below. */
const STORED_SECRET = 'sk-live-4f9a8b7c6d5e';
const MASK = '••••••';

interface AuditRow {
  userId: string | null;
  userRole: string;
  userName: string | null;
  action: string;
  outcome: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe('MCP endpoint (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;
  let ownerId: string;
  let organizationId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    ownerId = (res.body as { user: { id: string } }).user.id;
    const active = await request(httpServer)
      .get('/organizations/active')
      .set('Cookie', ownerCookie);
    organizationId = (active.body as { id: string }).id;
  });

  const ctxIn = (orgId: string): PermissionCtx => ({
    user: { id: ownerId },
    session: { activeOrganizationId: orgId },
  });

  /**
   * Two Projects, three Environments and one Service in the owner's
   * Organization, of which the Agent is granted Project A, Environment A1 and
   * the Service — and an Environment in a second Organization of the owner's.
   */
  async function tree() {
    const projects = ctx.app.get(ProjectsService);
    const environments = ctx.app.get(EnvironmentsService);
    const applications = ctx.app.get(ApplicationsService);
    const home = ctxIn(organizationId);

    const projectA = await projects.create(home, {
      name: 'storefront',
      description: `billing key ${STORED_SECRET}`,
      env: `STRIPE_KEY=${STORED_SECRET}`,
    });
    const projectB = await projects.create(home, { name: 'internal' });
    const a1 = await environments.create(home, {
      name: 'production',
      projectId: projectA.projectId,
    });
    const a2 = await environments.create(home, {
      name: 'staging',
      projectId: projectA.projectId,
    });
    const b1 = await environments.create(home, {
      name: 'production',
      projectId: projectB.projectId,
    });
    await ctx.db
      .update(environment)
      .set({
        env: `DATABASE_URL=postgres://app:${STORED_SECRET}@db/app`,
        description: `the one with ${STORED_SECRET} in it`,
      })
      .where(eq(environment.environmentId, a1.environmentId));
    const app = await applications.create(home, {
      name: 'Web',
      appName: 'web-app',
      environmentId: a1.environmentId,
    });
    await applications.create(home, {
      name: 'Worker',
      appName: 'worker-app',
      environmentId: a1.environmentId,
    });

    const second = await createOrganization(httpServer, ctx.db, ownerCookie, {
      name: 'Elsewhere',
    });
    expect(second.status).toBe(201);
    const elsewhere = ctxIn((second.body as { id: string }).id);
    const foreignProject = await projects.create(elsewhere, {
      name: 'foreign',
    });
    const foreign = await environments.create(elsewhere, {
      name: 'production',
      projectId: foreignProject.projectId,
    });

    return { projectA, projectB, a1, a2, b1, app, foreign };
  }

  async function createAgent(
    grant: Record<string, string[]> = {},
    role = 'agentReader',
  ): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({ name: 'deploy-bot', role, grant });
    expect(res.status).toBe(201);
    const body = res.body as { agent: { id: string }; key: string };
    return { id: body.agent.id, key: body.key };
  }

  /** A POST to `/mcp` as a 2025-era client sends it. */
  function post(
    key: string | null,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    let req = request(httpServer)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json');
    if (key) req = req.set('Authorization', `Bearer ${key}`);
    for (const [name, value] of Object.entries(headers))
      req = req.set(name, value);
    return req.send(body as object);
  }

  function callTool(
    key: string,
    name: string,
    args: Record<string, unknown> = {},
    revision = '2025-06-18',
  ) {
    return post(
      key,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      { 'MCP-Protocol-Version': revision },
    );
  }

  /** The tool result, which is JSON text inside the JSON-RPC result. */
  function resultOf(res: request.Response): ToolResult {
    expect(res.status).toBe(200);
    return (res.body as { result: ToolResult }).result;
  }

  function payloadOf(res: request.Response): unknown {
    const result = resultOf(res);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text) as unknown;
  }

  async function rowsOf(agentId: string): Promise<AuditRow[]> {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, agentId))
      .orderBy(asc(auditLog.createdAt));
    return rows.map((row) => ({
      userId: row.userId,
      userRole: row.userRole,
      userName: row.userName,
      action: row.action,
      outcome: row.outcome,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
    }));
  }

  /** Stateless and JSON, on every answer (ADR-0025). */
  function expectStatelessJson(res: request.Response) {
    expect(res.headers['mcp-session-id']).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-type']).not.toMatch(/event-stream/);
  }

  async function keyStart(
    agentId: string,
  ): Promise<{ id: string; start: string | null }> {
    const [row] = await ctx.db
      .select({ id: apikey.id, start: apikey.start })
      .from(apikey)
      .where(eq(apikey.referenceId, agentId));
    return row;
  }

  describe('navigation', () => {
    it('shows an Agent granted one Project only that Project, its granted Environment, and that Environment with its granted Service', async () => {
      const { projectA, projectB, a1, app } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
        accessedEnvironments: [a1.environmentId],
        accessedServices: [app.applicationId],
      });

      const projects = payloadOf(await callTool(agent.key, 'list_projects'));
      expect(projects).toEqual([
        {
          projectId: projectA.projectId,
          name: 'storefront',
          description: `billing key ${MASK}`,
          createdAt: projectA.createdAt,
          environmentCount: 1,
        },
      ]);

      const environments = payloadOf(
        await callTool(agent.key, 'list_environments', {
          projectId: projectA.projectId,
        }),
      );
      expect(environments).toEqual([
        {
          environmentId: a1.environmentId,
          name: 'production',
          description: `the one with ${MASK} in it`,
          createdAt: a1.createdAt,
          projectId: projectA.projectId,
        },
      ]);
      expect(
        payloadOf(
          await callTool(agent.key, 'list_environments', {
            projectId: projectB.projectId,
          }),
        ),
      ).toEqual([]);

      const found = payloadOf(
        await callTool(agent.key, 'get_environment', {
          environmentId: a1.environmentId,
        }),
      );
      expect(found).toEqual({
        environmentId: a1.environmentId,
        name: 'production',
        description: `the one with ${MASK} in it`,
        createdAt: a1.createdAt,
        projectId: projectA.projectId,
        hasEnv: true,
        services: [
          {
            serviceType: 'application',
            serviceId: app.applicationId,
            name: 'Web',
            configName: 'web',
            description: null,
            status: 'idle',
            createdAt: app.createdAt,
            openIncidents: 0,
          },
        ],
      });
    });

    it('never carries a stored secret: not the env, not a value echoed into a description', async () => {
      const { projectA, a1, app } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
        accessedEnvironments: [a1.environmentId],
        accessedServices: [app.applicationId],
      });

      for (const res of [
        await callTool(agent.key, 'list_projects'),
        await callTool(agent.key, 'list_environments', {
          projectId: projectA.projectId,
        }),
        await callTool(agent.key, 'get_environment', {
          environmentId: a1.environmentId,
        }),
      ]) {
        expect(res.text).not.toContain(STORED_SECRET);
        expect(res.text).not.toContain('STRIPE_KEY');
        expect(res.text).not.toContain('DATABASE_URL');
      }
    });

    it('writes one audit row per call, naming the Agent, the tool, the key and the twin', async () => {
      const { projectA, a1 } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
        accessedEnvironments: [a1.environmentId],
      });
      const key = await keyStart(agent.id);

      await callTool(agent.key, 'list_projects');
      await callTool(agent.key, 'list_environments', {
        projectId: projectA.projectId,
      });
      await callTool(agent.key, 'get_environment', {
        environmentId: a1.environmentId,
      });

      const rows = await rowsOf(agent.id);
      expect(
        rows.map((row) => [
          row.resourceType,
          row.action,
          row.outcome,
          row.resourceId,
        ]),
      ).toEqual([
        ['project', 'read', 'succeeded', null],
        ['environment', 'read', 'succeeded', null],
        ['environment', 'read', 'succeeded', a1.environmentId],
      ]);
      expect(rows.map((row) => row.metadata.tool)).toEqual([
        'list_projects',
        'list_environments',
        'get_environment',
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({
          userId: agent.id,
          userRole: 'agentReader',
          userName: 'deploy-bot',
        });
        expect(row.metadata.credential).toEqual({
          keyId: key.id,
          start: key.start,
        });
        expect(row.metadata.route).toBeUndefined();
        expect(row.metadata.reason).toBeUndefined();
      }
    });
  });

  describe('grant refusals', () => {
    it('answers a nonexistent id, an id in another Organization and an ungranted id with one byte-identical refusal', async () => {
      const { projectA, a1, a2, b1, foreign } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
        accessedEnvironments: [a1.environmentId],
      });

      const answers: string[] = [];
      for (const environmentId of [
        'no-such-environment',
        foreign.environmentId,
        a2.environmentId,
        b1.environmentId,
      ]) {
        const res = await callTool(agent.key, 'get_environment', {
          environmentId,
        });
        expectStatelessJson(res);
        answers.push(JSON.stringify(resultOf(res)));
      }

      expect(new Set(answers).size).toBe(1);
      expect(JSON.parse(answers[0])).toEqual({
        content: [{ type: 'text', text: NOT_FOUND_OR_NOT_PERMITTED }],
        structuredContent: {
          code: 'refused',
          reason: 'grant',
          message: NOT_FOUND_OR_NOT_PERMITTED,
        },
        isError: true,
      });

      const rows = await rowsOf(agent.id);
      expect(
        rows.map((row) => [row.outcome, row.metadata.reason, row.resourceId]),
      ).toEqual([
        ['refused', 'grant', 'no-such-environment'],
        ['refused', 'grant', foreign.environmentId],
        ['refused', 'grant', a2.environmentId],
        ['refused', 'grant', b1.environmentId],
      ]);
    });
  });

  describe('authentication', () => {
    it('refuses an unknown key, a revoked key and a missing key with 401, "This key is not valid." and no row', async () => {
      const { projectA } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
      });
      await ctx.db.delete(apikey).where(eq(apikey.referenceId, agent.id));

      for (const key of ['x'.repeat(64), agent.key, null]) {
        const res = await callTool(key as string, 'list_projects');
        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toBe(INVALID_TOKEN);
        expect(res.body).toEqual({
          code: 'invalid_token',
          message: INVALID_KEY,
        });
        expectStatelessJson(res);
      }
      expect(await ctx.db.select().from(auditLog)).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ userId: agent.id }),
        ]),
      );
      expect(await rowsOf(agent.id)).toEqual([]);
    });

    it('refuses an expired key with 401 naming the date, keeps the key, and writes a refused credential-expired row', async () => {
      const { projectA } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
      });
      await ctx.db
        .update(apikey)
        .set({ agentExpiresAt: new Date('2026-03-04T10:00:00Z') })
        .where(eq(apikey.referenceId, agent.id));

      const res = await callTool(agent.key, 'list_projects');

      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe(INVALID_TOKEN);
      expect(res.body).toEqual({
        code: 'invalid_token',
        message:
          'This agent key expired on 2026-03-04. An operator can issue a new one in the console.',
      });
      expect(
        await ctx.db
          .select()
          .from(apikey)
          .where(eq(apikey.referenceId, agent.id)),
      ).toHaveLength(1);
      const rows = await rowsOf(agent.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: 'refused',
        resourceType: 'project',
        action: 'read',
      });
      expect(rows[0].metadata).toMatchObject({
        tool: 'list_projects',
        reason: 'credential-expired',
      });
    });

    it('refuses a personal key with 401 telling the caller to create an Agent, and writes no row', async () => {
      const minted = await request(httpServer)
        .post('/users/me/api-keys')
        .set('Cookie', ownerCookie)
        .send({ name: 'ci-key' });
      expect(minted.status).toBe(201);

      const res = await callTool(
        (minted.body as { key: string }).key,
        'list_projects',
      );

      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe(INVALID_TOKEN);
      expect(res.body).toEqual({
        code: 'invalid_token',
        message:
          'This endpoint takes an agent key, and this is a personal key. Create an Agent in the console and use its key.',
      });
      expect(
        await ctx.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.userId, ownerId)),
      ).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ outcome: 'refused' }),
        ]),
      );
    });

    it('refuses a suspended Agent with 403, the suspension sentence and the finality sentence, and a refused suspended row', async () => {
      const { projectA } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
      });
      await ctx.db
        .update(user)
        .set({ banned: true })
        .where(eq(user.id, agent.id));

      const res = await callTool(agent.key, 'list_projects');

      expect(res.status).toBe(403);
      expect(res.headers['www-authenticate']).toBeUndefined();
      expect(res.body).toEqual({
        code: 'refused',
        reason: 'suspended',
        message: `This Agent has been suspended by an operator. ${FINALITY}`,
      });
      const rows = await rowsOf(agent.id);
      expect(
        rows.map((row) => [
          row.outcome,
          row.metadata.reason,
          row.metadata.tool,
        ]),
      ).toEqual([['refused', 'suspended', 'list_projects']]);
    });
  });

  describe('the revision pins', () => {
    const MODERN = '2026-07-28';
    function modernMeta(revision = MODERN) {
      return {
        'io.modelcontextprotocol/protocolVersion': revision,
        'io.modelcontextprotocol/clientInfo': {
          name: 'codex',
          version: '0.9.1',
        },
        'io.modelcontextprotocol/clientCapabilities': {},
      };
    }

    it('serves 2025-03-26, 2025-06-18 and 2025-11-25 and records the client as last connected', async () => {
      const { projectA } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
      });

      for (const revision of ['2025-03-26', '2025-06-18', '2025-11-25']) {
        const res = await post(agent.key, {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: revision,
            capabilities: {},
            clientInfo: { name: 'claude-code', version: '2.1.0' },
          },
        });
        expectStatelessJson(res);
        expect(res.status).toBe(200);
        expect(
          (res.body as { result: { protocolVersion: string } }).result
            .protocolVersion,
        ).toBe(revision);
        expect(
          (res.body as { result: { capabilities: { tools: object } } }).result
            .capabilities.tools,
        ).toEqual({ listChanged: false });
      }

      const [key] = await ctx.db
        .select()
        .from(apikey)
        .where(eq(apikey.referenceId, agent.id));
      expect(key).toMatchObject({
        lastClientName: 'claude-code',
        lastClientVersion: '2.1.0',
        lastProtocolRevision: '2025-11-25',
      });
      expect(key.lastConnectedAt).toBeInstanceOf(Date);
    });

    it('serves 2026-07-28 with a role-filtered, read-only-annotated tools/list carrying cacheScope private', async () => {
      const { projectA } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
      });

      const res = await post(
        agent.key,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: { _meta: modernMeta() },
        },
        { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/list' },
      );

      expectStatelessJson(res);
      expect(res.status).toBe(200);
      const result = (
        res.body as {
          result: {
            tools: Array<{
              name: string;
              annotations: { readOnlyHint: boolean };
            }>;
            cacheScope: string;
            ttlMs: number;
          };
        }
      ).result;
      expect(result.cacheScope).toBe('private');
      expect(result.ttlMs).toBe(300_000);
      expect(result.tools.map((tool) => tool.name)).toEqual([
        'list_projects',
        'list_environments',
        'get_environment',
        'get_service',
        'list_deployments',
        'read_deployment_log',
        'list_domains',
        'get_service_health',
        'list_previews',
        'get_preview',
        'get_project_config',
        'get_plan',
        'request_plan',
      ]);
      // Every tool a Reader is listed is read-only but request_plan,
      // which stores a plan under a read's statement.
      expect(
        result.tools
          .filter((tool) => !tool.annotations.readOnlyHint)
          .map((tool) => tool.name),
      ).toEqual(['request_plan']);

      const [key] = await ctx.db
        .select()
        .from(apikey)
        .where(eq(apikey.referenceId, agent.id));
      expect(key).toMatchObject({
        lastClientName: 'codex',
        lastClientVersion: '0.9.1',
        lastProtocolRevision: MODERN,
      });
    });

    it('calls a tool on 2026-07-28, recording the self-reported client in the row', async () => {
      const { projectA } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
      });

      const res = await post(
        agent.key,
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'list_projects', arguments: {}, _meta: modernMeta() },
        },
        {
          'MCP-Protocol-Version': MODERN,
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'list_projects',
        },
      );

      expectStatelessJson(res);
      expect(payloadOf(res)).toEqual([
        expect.objectContaining({ projectId: projectA.projectId }),
      ]);
      const [row] = await rowsOf(agent.id);
      expect(row.metadata).toMatchObject({
        tool: 'list_projects',
        revision: MODERN,
        clientInfo: { name: 'codex', version: '0.9.1' },
      });
    });

    it('refuses 2024-11-05 on initialize and in the header with 400, and writes a refused unsupported-revision row', async () => {
      const { projectA } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
      });

      const initialize = await post(agent.key, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'old', version: '1' },
        },
      });
      const listed = await post(
        agent.key,
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { 'MCP-Protocol-Version': '2024-11-05' },
      );

      for (const res of [initialize, listed]) {
        expectStatelessJson(res);
        expect(res.status).toBe(400);
        expect(
          (res.body as { error: { code: number; data: object } }).error,
        ).toMatchObject({
          code: -32602,
          data: {
            requested: '2024-11-05',
            supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
          },
        });
      }
      const rows = await rowsOf(agent.id);
      expect(
        rows.map((row) => [row.outcome, row.metadata.reason, row.resourceType]),
      ).toEqual([
        ['refused', 'unsupported-revision', 'session'],
        ['refused', 'unsupported-revision', 'session'],
      ]);
    });

    it('answers an unserved revision on the 2026 leg with 400 and -32022, and writes a refused unsupported-revision row', async () => {
      const { projectA } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
      });

      const res = await post(
        agent.key,
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'list_projects',
            arguments: {},
            _meta: modernMeta('2026-12-01'),
          },
        },
        {
          'MCP-Protocol-Version': '2026-12-01',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'list_projects',
        },
      );

      expectStatelessJson(res);
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: number } }).error.code).toBe(-32022);
      const rows = await rowsOf(agent.id);
      expect(
        rows.map((row) => [
          row.outcome,
          row.metadata.reason,
          row.metadata.tool,
        ]),
      ).toEqual([['refused', 'unsupported-revision', 'list_projects']]);
    });

    it('accepts a batch array on 2025-03-26 and answers it as one JSON array', async () => {
      const { projectA } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
      });

      const res = await post(
        agent.key,
        [
          { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
          {
            jsonrpc: '2.0',
            id: 6,
            method: 'tools/call',
            params: { name: 'list_projects', arguments: {} },
          },
        ],
        { 'MCP-Protocol-Version': '2025-03-26' },
      );

      expectStatelessJson(res);
      expect(res.status).toBe(200);
      expect(
        (res.body as Array<{ id: number }>).map((entry) => entry.id),
      ).toEqual([5, 6]);
      expect(await rowsOf(agent.id)).toHaveLength(1);
    });

    it('answers GET and DELETE with 405 and no session', async () => {
      const { projectA } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
      });

      for (const res of [
        await request(httpServer)
          .get('/mcp')
          .set('Authorization', `Bearer ${agent.key}`),
        await request(httpServer)
          .delete('/mcp')
          .set('Authorization', `Bearer ${agent.key}`),
      ]) {
        expect(res.status).toBe(405);
        expect(res.headers.allow).toBe('POST');
        expectStatelessJson(res);
      }
    });
  });

  describe('Origin', () => {
    it('refuses any request carrying an Origin header with 403, even with a valid key', async () => {
      const { projectA } = await tree();
      const agent = await createAgent({
        accessedProjects: [projectA.projectId],
      });

      const res = await callTool(agent.key, 'list_projects').set(
        'Origin',
        'http://localhost:3000',
      );

      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe('origin_refused');
      expect(await rowsOf(agent.id)).toEqual([]);
    });
  });
});
