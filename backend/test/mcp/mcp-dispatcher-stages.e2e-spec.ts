import { BadRequestException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { z } from 'zod';

import { auditLog } from '../../src/db/schema';
import { ProjectsController } from '../../src/projects/projects.controller';
import { ProjectsService } from '../../src/projects/projects.service';
import { defineTool, ROW_SCOPED } from '../../src/mcp/tool-definition';
import type { AnyTool } from '../../src/mcp/tool-definition';
import { row } from '../../src/mcp/tool-projection';
import { ToolRegistry } from '../../src/mcp/tool-registry';
import { MCP_TOOLS } from '../../src/mcp/tools';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * The dispatcher's stages that no tool can reach on its own (the spec's
 * Testing Decisions §1): the Reader and Operator roles hold
 * `environment: ['read']`, so neither the permission refusal nor a role-filtered `tools/list` can be
 * seen through the navigation tools, and none of them fails or hangs on cue.
 *
 * So the registry is built here with the real tools plus four probes — a write
 * tool the Reader lacks, and three that throw, fail as declared, and never
 * finish. Everything else is the real endpoint: the real key, the one check,
 * the real audit rows. The probes go through `ToolRegistry`'s boot check like
 * any tool.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const FINALITY =
  'This is an access decision, not a failure. Retrying, or trying another tool or id, will not change it. Tell the operator what you needed.';

const noSecrets = () => [];
const probeTwin = { controller: ProjectsController, handler: 'list' };
const probeTarget = { service: ProjectsService, method: 'list' };

const PROBES: AnyTool[] = [
  defineTool({
    name: 'probe_write',
    title: 'Probe a write',
    description: 'A write the Reader role lacks.',
    kind: 'write',
    input: z.object({}),
    permissions: { deployment: ['create'] },
    twin: probeTwin,
    target: probeTarget,
    call: () => Promise.resolve({ queued: true }),
    audit: { resourceType: 'deployment', action: 'create' },
    projection: row<{ queued: boolean }>({ fields: ['queued'] }),
    errors: [],
    maskRoots: noSecrets,
  }),
  defineTool({
    name: 'probe_throws',
    title: 'Probe an unmapped failure',
    description: 'Throws something no table maps.',
    kind: 'read',
    input: z.object({}),
    permissions: ROW_SCOPED,
    twin: probeTwin,
    target: probeTarget,
    call: () =>
      Promise.reject(
        new Error('connect ECONNREFUSED postgres://app:hunter2hunter2@db'),
      ),
    audit: { resourceType: 'project', action: 'read' },
    projection: row<object>({ fields: [] }),
    errors: [],
    maskRoots: noSecrets,
  }),
  defineTool({
    name: 'probe_declared',
    title: 'Probe a declared failure',
    description: 'Fails the way its table says.',
    kind: 'read',
    input: z.object({}),
    permissions: ROW_SCOPED,
    twin: probeTwin,
    target: probeTarget,
    call: () =>
      Promise.reject(new BadRequestException('Application has no source')),
    audit: { resourceType: 'project', action: 'read' },
    projection: row<object>({ fields: [] }),
    errors: [
      {
        exception: BadRequestException,
        answer: { failed: 'This Service has no source to deploy from.' },
      },
    ],
    maskRoots: noSecrets,
  }),
  defineTool({
    name: 'probe_slow',
    title: 'Probe the deadline',
    description: 'Never finishes.',
    kind: 'read',
    input: z.object({}),
    permissions: ROW_SCOPED,
    twin: probeTwin,
    target: probeTarget,
    call: () => new Promise<never>(() => undefined),
    audit: { resourceType: 'project', action: 'read' },
    projection: row<object>({ fields: [] }),
    errors: [],
    maskRoots: noSecrets,
  }),
];

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

describe('MCP dispatcher stages (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        {
          provide: ToolRegistry,
          useValue: new ToolRegistry([...MCP_TOOLS, ...PROBES]),
        },
      ],
    });
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
  });

  async function createAgent(
    role: string,
  ): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({ name: `${role}-bot`, role });
    expect(res.status).toBe(201);
    const body = res.body as { agent: { id: string }; key: string };
    return { id: body.agent.id, key: body.key };
  }

  function post(key: string, body: unknown) {
    return request(httpServer)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('MCP-Protocol-Version', '2025-06-18')
      .set('Authorization', `Bearer ${key}`)
      .send(body as object);
  }

  const callTool = (key: string, name: string) =>
    post(key, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    });

  const listTools = async (key: string) => {
    const res = await post(key, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    expect(res.status).toBe(200);
    return (
      res.body as {
        result: { tools: Array<{ name: string; annotations: object }> };
      }
    ).result.tools;
  };

  async function rowsOf(agentId: string) {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, agentId))
      .orderBy(asc(auditLog.createdAt));
    return rows.map((found) => ({
      auditLogId: found.auditLogId,
      outcome: found.outcome,
      resourceType: found.resourceType,
      action: found.action,
      metadata: JSON.parse(found.metadata ?? '{}') as Record<string, unknown>,
    }));
  }

  describe('permission', () => {
    it('filters tools/list to the role and annotates a write as not read-only', async () => {
      const reader = await createAgent('agentReader');
      const operator = await createAgent('agentOperator');

      const readerTools = (await listTools(reader.key)).map(
        (tool) => tool.name,
      );
      const operatorTools = await listTools(operator.key);

      expect(readerTools).not.toContain('probe_write');
      expect(readerTools).toContain('get_environment');
      expect(
        operatorTools.find((tool) => tool.name === 'probe_write')?.annotations,
      ).toEqual({
        readOnlyHint: false,
        openWorldHint: false,
      });
    });

    it('refuses a statement the role lacks with 403, the exact body, no WWW-Authenticate, and a refused permission row', async () => {
      const reader = await createAgent('agentReader');

      const res = await callTool(reader.key, 'probe_write');

      expect(res.status).toBe(403);
      expect(res.headers['www-authenticate']).toBeUndefined();
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.body).toEqual({
        code: 'refused',
        reason: 'permission',
        tool: 'probe_write',
        missing: 'deployment:create',
        message: `This Agent's role does not include deployment:create. ${FINALITY}`,
      });
      const rows = await rowsOf(reader.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: 'refused',
        resourceType: 'deployment',
        action: 'create',
      });
      expect(rows[0].metadata).toMatchObject({
        tool: 'probe_write',
        reason: 'permission',
      });
    });

    it('answers a Caller key an empty tools/list', async () => {
      const caller = await createAgent('agentCaller');

      expect(await listTools(caller.key)).toEqual([]);
    });

    it('refuses a Caller key every tool, a row-scoped one included, with 403, the Gateway-only body and a refused permission row', async () => {
      const caller = await createAgent('agentCaller');

      const answers: Array<[string, number, unknown]> = [];
      for (const name of ['list_projects', 'probe_write']) {
        const res = await callTool(caller.key, name);
        answers.push([name, res.status, res.body]);
      }

      const body = (tool: string) => ({
        code: 'refused',
        reason: 'permission',
        tool,
        message: `This Agent's role only calls AI models through the Gateway and holds no tool here. ${FINALITY}`,
      });
      expect(answers).toEqual([
        ['list_projects', 403, body('list_projects')],
        ['probe_write', 403, body('probe_write')],
      ]);
      expect(
        (await rowsOf(caller.id)).map((found) => ({
          outcome: found.outcome,
          tool: found.metadata.tool,
          reason: found.metadata.reason,
        })),
      ).toEqual([
        { outcome: 'refused', tool: 'list_projects', reason: 'permission' },
        { outcome: 'refused', tool: 'probe_write', reason: 'permission' },
      ]);
    });

    it('runs the same tool for a role that holds the statement', async () => {
      const operator = await createAgent('agentOperator');

      const res = await callTool(operator.key, 'probe_write');

      const result = (res.body as { result: ToolResult }).result;
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0].text)).toEqual({ queued: true });
      expect((await rowsOf(operator.id)).map((found) => found.outcome)).toEqual(
        ['succeeded'],
      );
    });
  });

  describe('failures', () => {
    it('answers an unmapped failure with "The call failed." and the id of the failed row that holds the detail, never the thrown message', async () => {
      const reader = await createAgent('agentReader');

      const res = await callTool(reader.key, 'probe_throws');

      const result = (res.body as { result: ToolResult }).result;
      const [failed] = await rowsOf(reader.id);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        `The call failed. The detail is in audit entry ${failed.auditLogId}.`,
      );
      expect(res.text).not.toContain('hunter2');
      expect(res.text).not.toContain('ECONNREFUSED');
      expect(res.text).not.toContain(FINALITY);
      expect(failed.outcome).toBe('failed');
      expect(failed.metadata.error).toMatchObject({ type: 'Error' });
    });

    it("answers a mapped failure with the tool's declared text and no finality sentence", async () => {
      const reader = await createAgent('agentReader');

      const res = await callTool(reader.key, 'probe_declared');

      const result = (res.body as { result: ToolResult }).result;
      expect(result).toMatchObject({
        isError: true,
        content: [
          { type: 'text', text: 'This Service has no source to deploy from.' },
        ],
      });
      expect(res.text).not.toContain('Application has no source');
      expect((await rowsOf(reader.id)).map((found) => found.outcome)).toEqual([
        'failed',
      ]);
    });

    it('answers a tool that does not finish in 30 seconds with a failed outcome and a row, not a cut socket', async () => {
      const reader = await createAgent('agentReader');
      const started = Date.now();

      const res = await callTool(reader.key, 'probe_slow');

      // A timer can fire a millisecond or two early against Date.now().
      expect(Date.now() - started).toBeGreaterThanOrEqual(29_900);
      const result = (res.body as { result: ToolResult }).result;
      const [failed] = await rowsOf(reader.id);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        `The call did not finish within 30 seconds and was abandoned. The detail is in audit entry ${failed.auditLogId}.`,
      );
      expect(res.text).not.toContain(FINALITY);
      expect(failed).toMatchObject({ outcome: 'failed' });
      expect(failed.metadata.reason).toBe('deadline');
    });
  });
});
