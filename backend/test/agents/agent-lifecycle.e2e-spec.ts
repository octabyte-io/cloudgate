import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { apikey, auditLog, member, user } from '../../src/db/schema';
import { ProjectsService } from '../../src/projects/projects.service';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * An Agent's life after creation, driven from the console's routes and
 * checked at the MCP endpoint: Suspend and Resume, Add key and Revoke,
 * removing an expired key, the "last connected" line, and the Members route
 * that must not remove one.
 *
 * The sentences are written out here rather than imported (§1.7), so a
 * reworded refusal reds.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const FINALITY =
  'This is an access decision, not a failure. Retrying, or trying another tool or id, will not change it. Tell the operator what you needed.';
const SUSPENDED = {
  code: 'refused',
  reason: 'suspended',
  message: `This Agent has been suspended by an operator. ${FINALITY}`,
};
const INVALID_KEY = {
  code: 'invalid_token',
  message: 'This key is not valid.',
};

const DAY = 86_400_000;

interface ListedKey {
  id: string;
  start: string | null;
  expiresAt: string;
  expired: boolean;
}

interface ListedAgent {
  id: string;
  memberId: string;
  role: string;
  suspended: boolean;
  accessedProjects: string[];
  keys: ListedKey[];
  lastConnection: {
    at: string;
    clientName: string | null;
    clientVersion: string | null;
    revision: string | null;
  } | null;
}

describe('Agent lifecycle (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;
  let ownerId: string;
  let organizationId: string;
  let projectId: string;

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
    const project = await ctx.app.get(ProjectsService).create(
      {
        user: { id: ownerId },
        session: { activeOrganizationId: organizationId },
      },
      { name: 'storefront' },
    );
    projectId = project.projectId;
  });

  async function createAgent(): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({
        name: 'deploy-bot',
        role: 'agentOperator',
        grant: { accessedProjects: [projectId] },
      });
    expect(res.status).toBe(201);
    const body = res.body as { agent: { id: string }; key: string };
    return { id: body.agent.id, key: body.key };
  }

  async function listed(agentId: string): Promise<ListedAgent> {
    const res = await request(httpServer)
      .get('/agents')
      .set('Cookie', ownerCookie);
    expect([res.status, res.body]).toEqual([200, expect.anything()]);
    const found = (res.body as ListedAgent[]).find(
      (each) => each.id === agentId,
    );
    expect(found).toBeDefined();
    return found!;
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
        id: 1,
        method: 'tools/call',
        params: { name: 'list_projects', arguments: {} },
      });
  }

  /** The Projects a tool call answered, by id — the grant, seen from outside. */
  function projectIds(res: request.Response): string[] {
    expect(res.status).toBe(200);
    const result = (
      res.body as {
        result: { content: Array<{ text: string }>; isError?: boolean };
      }
    ).result;
    expect(result.isError).toBeFalsy();
    return (
      JSON.parse(result.content[0].text) as Array<{ projectId: string }>
    ).map((each) => each.projectId);
  }

  function write(
    method: 'post' | 'delete',
    path: string,
    cookie = ownerCookie,
    body?: object,
  ) {
    const req = request(httpServer)[method](path).set('Cookie', cookie);
    return body ? req.send(body) : req;
  }

  /** The owner's rows about this Agent, oldest first, as `metadata.type`s. */
  async function operatorRows(agentId: string) {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, ownerId))
      .orderBy(asc(auditLog.createdAt));
    return rows
      .filter((row) => row.resourceId === agentId)
      .map((row) => ({
        action: row.action,
        resourceType: row.resourceType,
        type: (JSON.parse(row.metadata ?? '{}') as { type?: string }).type,
      }));
  }

  describe('Suspend and Resume', () => {
    it('refuses the next /mcp call with 403 suspended, and Resume restores the same keys and grant', async () => {
      const agent = await createAgent();
      expect(projectIds(await listProjects(agent.key))).toEqual([projectId]);
      const before = await listed(agent.id);

      const suspended = await write('post', `/agents/${agent.id}/suspend`);
      expect(suspended.status).toBe(200);
      expect((suspended.body as ListedAgent).suspended).toBe(true);

      const refused = await listProjects(agent.key);
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual(SUSPENDED);
      const whileSuspended = await listed(agent.id);
      expect(whileSuspended.suspended).toBe(true);
      expect(whileSuspended.keys.map((key) => key.id)).toEqual(
        before.keys.map((key) => key.id),
      );

      const resumed = await write('post', `/agents/${agent.id}/resume`);
      expect(resumed.status).toBe(200);
      expect((resumed.body as ListedAgent).suspended).toBe(false);

      expect(projectIds(await listProjects(agent.key))).toEqual([projectId]);
      const after = await listed(agent.id);
      expect(after.keys.map((key) => key.id)).toEqual(
        before.keys.map((key) => key.id),
      );
      expect(after.accessedProjects).toEqual([projectId]);
      expect(after.role).toBe('agentOperator');

      expect(await operatorRows(agent.id)).toEqual([
        { action: 'create', resourceType: 'user', type: 'createAgent' },
        { action: 'update', resourceType: 'user', type: 'suspendAgent' },
        { action: 'update', resourceType: 'user', type: 'resumeAgent' },
      ]);
    });

    it('writes the ban with an operator reason and no expiry, and lifts all of it', async () => {
      const agent = await createAgent();
      await write('post', `/agents/${agent.id}/suspend`).expect(200);
      const [banned] = await ctx.db
        .select()
        .from(user)
        .where(eq(user.id, agent.id));
      expect(banned).toMatchObject({
        banned: true,
        banReason: 'Suspended by an operator',
        banExpires: null,
      });

      await write('post', `/agents/${agent.id}/resume`).expect(200);
      const [lifted] = await ctx.db
        .select()
        .from(user)
        .where(eq(user.id, agent.id));
      expect(lifted).toMatchObject({
        banned: false,
        banReason: null,
        banExpires: null,
      });
    });

    it('is refused to a plain member, and reads a person as no Agent at all', async () => {
      const agent = await createAgent();
      const plain = await signUpMember(httpServer, ownerCookie);

      for (const path of ['suspend', 'resume']) {
        const res = await write(
          'post',
          `/agents/${agent.id}/${path}`,
          plain.cookie,
        );
        expect([path, res.status]).toEqual([path, 403]);
        const person = await write('post', `/agents/${plain.id}/${path}`);
        expect([path, person.status]).toEqual([path, 404]);
      }
      expect((await listed(agent.id)).suspended).toBe(false);
      const [row] = await ctx.db
        .select({ banned: user.banned })
        .from(user)
        .where(eq(user.id, plain.id));
      expect(row.banned).toBeFalsy();
    });
  });

  describe('keys', () => {
    it('Add key then Revoke leaves the new key working and the old one refused with "This key is not valid."', async () => {
      const agent = await createAgent();
      const [first] = (await listed(agent.id)).keys;

      const added = await write(
        'post',
        `/agents/${agent.id}/keys`,
        ownerCookie,
        {
          expiresInDays: 30,
        },
      );
      expect(added.status).toBe(201);
      const { key: second, agent: afterAdd } = added.body as {
        key: string;
        agent: ListedAgent;
      };
      expect(second).toMatch(/^[A-Za-z]{64}$/);
      expect(second).not.toBe(agent.key);
      expect(afterAdd.keys).toHaveLength(2);
      const newKey = afterAdd.keys.find((key) => key.id !== first.id)!;
      expect(newKey.start).toBe(second.slice(0, 6));
      const lifetime = Date.parse(newKey.expiresAt) - Date.now();
      expect(lifetime).toBeGreaterThan(30 * DAY - 60_000);
      expect(lifetime).toBeLessThan(30 * DAY + 60_000);
      // The raw key is never stored, and the new row carries no authority.
      const [row] = await ctx.db
        .select()
        .from(apikey)
        .where(eq(apikey.id, newKey.id));
      expect(row).toMatchObject({
        referenceId: agent.id,
        expiresAt: null,
        permissions: null,
        metadata: null,
      });
      expect(row.key).not.toBe(second);

      // Both work until one is revoked.
      expect(projectIds(await listProjects(agent.key))).toEqual([projectId]);
      expect(projectIds(await listProjects(second))).toEqual([projectId]);

      const revoked = await write(
        'delete',
        `/agents/${agent.id}/keys/${first.id}`,
      );
      expect(revoked.status).toBe(200);
      expect((revoked.body as ListedAgent).keys.map((key) => key.id)).toEqual([
        newKey.id,
      ]);

      const old = await listProjects(agent.key);
      expect(old.status).toBe(401);
      expect(old.body).toEqual(INVALID_KEY);
      expect(projectIds(await listProjects(second))).toEqual([projectId]);

      expect(await operatorRows(agent.id)).toEqual([
        { action: 'create', resourceType: 'user', type: 'createAgent' },
        { action: 'create', resourceType: 'user', type: 'addAgentKey' },
        { action: 'delete', resourceType: 'user', type: 'revokeAgentKey' },
      ]);
    });

    it('defaults a new key to 90 days and offers 30, 90 or 365 only', async () => {
      const agent = await createAgent();
      for (const expiresInDays of [0, 7, 3650, null, 'never']) {
        const res = await write(
          'post',
          `/agents/${agent.id}/keys`,
          ownerCookie,
          {
            expiresInDays,
          },
        );
        expect([expiresInDays, res.status]).toEqual([expiresInDays, 400]);
      }
      const res = await write(
        'post',
        `/agents/${agent.id}/keys`,
        ownerCookie,
        {},
      );
      expect(res.status).toBe(201);
      const keys = (res.body as { agent: ListedAgent }).agent.keys;
      const lifetime = Date.parse(keys[1].expiresAt) - Date.now();
      expect(lifetime).toBeGreaterThan(90 * DAY - 60_000);
      expect(lifetime).toBeLessThan(90 * DAY + 60_000);
    });

    it('removes an expired key, which stays listed as expired until then', async () => {
      const agent = await createAgent();
      const [first] = (await listed(agent.id)).keys;
      await ctx.db
        .update(apikey)
        .set({ agentExpiresAt: new Date(Date.now() - DAY) })
        .where(eq(apikey.id, first.id));
      expect((await listed(agent.id)).keys).toEqual([
        expect.objectContaining({ id: first.id, expired: true }),
      ]);

      const removed = await write(
        'delete',
        `/agents/${agent.id}/keys/${first.id}`,
      );
      expect(removed.status).toBe(200);
      expect((await listed(agent.id)).keys).toEqual([]);
      expect(await operatorRows(agent.id)).toEqual([
        { action: 'create', resourceType: 'user', type: 'createAgent' },
        {
          action: 'delete',
          resourceType: 'user',
          type: 'removeExpiredAgentKey',
        },
      ]);
    });

    it('reads a key of another Agent, or of a person, as no key of this Agent', async () => {
      const agent = await createAgent();
      const other = await createAgent();
      const [otherKey] = (await listed(other.id)).keys;
      const personal = await request(httpServer)
        .post('/users/me/api-keys')
        .set('Cookie', ownerCookie)
        .send({ name: 'ci-key' });
      expect(personal.status).toBe(201);
      const personalId = (personal.body as { id: string }).id;

      for (const keyId of [otherKey.id, personalId, 'nope']) {
        const res = await write('delete', `/agents/${agent.id}/keys/${keyId}`);
        expect([keyId, res.status]).toEqual([keyId, 404]);
      }
      expect(await ctx.db.select().from(apikey)).toHaveLength(3);
    });

    it('is refused to a plain member', async () => {
      const agent = await createAgent();
      const [first] = (await listed(agent.id)).keys;
      const plain = await signUpMember(httpServer, ownerCookie);

      const add = await write(
        'post',
        `/agents/${agent.id}/keys`,
        plain.cookie,
        {},
      );
      expect(add.status).toBe(403);
      const revoke = await write(
        'delete',
        `/agents/${agent.id}/keys/${first.id}`,
        plain.cookie,
      );
      expect(revoke.status).toBe(403);
      expect((await listed(agent.id)).keys).toHaveLength(1);
    });
  });

  describe('a caller Agent', () => {
    it("writes today's createAgent row with role agentCaller and an addAgentKey row, and nothing else", async () => {
      const created = await write('post', '/agents', ownerCookie, {
        name: 'chat-frontend',
        role: 'agentCaller',
      });
      expect(created.status).toBe(201);
      const { id } = (created.body as { agent: { id: string } }).agent;
      expect((await listed(id)).role).toBe('agentCaller');

      const added = await write('post', `/agents/${id}/keys`, ownerCookie, {
        expiresInDays: 30,
      });
      expect(added.status).toBe(201);

      expect(await operatorRows(id)).toEqual([
        { action: 'create', resourceType: 'user', type: 'createAgent' },
        { action: 'create', resourceType: 'user', type: 'addAgentKey' },
      ]);
      const [createRow] = await ctx.db
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(eq(auditLog.resourceId, id))
        .orderBy(asc(auditLog.createdAt))
        .limit(1);
      expect(JSON.parse(createRow.metadata ?? '{}')).toMatchObject({
        type: 'createAgent',
        role: 'agentCaller',
      });
    });
  });

  describe('last connected', () => {
    it('lists what the client said about itself on its last initialize, and nothing before one', async () => {
      const agent = await createAgent();
      expect((await listed(agent.id)).lastConnection).toBeNull();

      const init = await request(httpServer)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${agent.key}`)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'claude-code', version: '2.1.0' },
          },
        });
      expect(init.status).toBe(200);

      const { lastConnection } = await listed(agent.id);
      expect(lastConnection).toEqual({
        at: expect.any(String) as string,
        clientName: 'claude-code',
        clientVersion: '2.1.0',
        revision: '2025-06-18',
      });
    });
  });

  describe('the Members route', () => {
    it('refuses to remove an Agent, leaving its user, member row and keys', async () => {
      const agent = await createAgent();
      const before = await listed(agent.id);

      const res = await write(
        'delete',
        `/organizations/members/${before.memberId}`,
      );
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        message:
          'An Agent is deleted from the Agents section, not removed as a member',
      });

      expect(
        await ctx.db.select().from(member).where(eq(member.userId, agent.id)),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .select()
          .from(apikey)
          .where(eq(apikey.referenceId, agent.id)),
      ).toHaveLength(1);
      expect(projectIds(await listProjects(agent.key))).toEqual([projectId]);
    });

    // better-auth's own remove-member is closed, so the hook's one door
    // is Cloudgate's route above, which stays its pin.
    it("better-auth's own remove-member endpoint is closed, and the Agent stays", async () => {
      const agent = await createAgent();
      const before = await listed(agent.id);

      const res = await request(httpServer)
        .post('/api/auth/organization/remove-member')
        .set('Cookie', ownerCookie)
        .send({ memberIdOrEmail: before.memberId, organizationId });
      expect(res.status).toBe(404);
      expect(
        await ctx.db.select().from(member).where(eq(member.userId, agent.id)),
      ).toHaveLength(1);
    });

    it('still removes a person', async () => {
      const plain = await signUpMember(httpServer, ownerCookie);
      const [row] = await ctx.db
        .select({ id: member.id })
        .from(member)
        .where(eq(member.userId, plain.id));
      const res = await write('delete', `/organizations/members/${row.id}`);
      expect(res.status).toBe(200);
    });
  });
});
