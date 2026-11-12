import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import type { Auth } from '../../src/auth/auth.config';
import { AUTH } from '../../src/auth/auth.constants';
import {
  account,
  apikey,
  auditLog,
  member,
  session,
  user,
} from '../../src/db/schema';
import { AuditLogService } from '../../src/enterprise/audit-logs/audit-log.service';
import { routedAuthEndpoints } from '../utils/auth-endpoints';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * An Agent over HTTP (ADR-0023): created with its first key, refused on
 * every surface but the MCP endpoint (which does not exist yet), unable to
 * sign in, and removed with its member row and keys while its audit trail
 * stays.
 *
 * The better-auth pins here fail if a later better-auth upgrade changes the
 * behaviour they lean on: the api-key plugin answering `/get-session`
 * from its own before-hook, and deleting what it expires.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The refusal an Agent gets everywhere but `/mcp`, hand-written (§1.7). */
const AGENT_REFUSAL = {
  code: 'AGENT_NOT_ALLOWED_HERE',
  message: 'An Agent can act only through the MCP endpoint',
};

const DAY = 86_400_000;

interface CreatedAgent {
  agent: {
    id: string;
    memberId: string;
    name: string;
    role: string;
    keys: Array<{ id: string; expiresAt: string; expired: boolean }>;
  };
  key: string;
}

describe('Agents (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;
  let ownerId: string;

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
  });

  async function createAgent(
    body: Record<string, unknown> = { name: 'deploy-bot' },
    cookie = ownerCookie,
  ): Promise<CreatedAgent> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', cookie)
      .send(body);
    expect(res.status).toBe(201);
    return res.body as CreatedAgent;
  }

  describe('creating an Agent', () => {
    it('answers its key once and leaves one agent user with no account, one member row and one key row', async () => {
      const before = Date.now();
      const { agent, key } = await createAgent({
        name: 'deploy-bot',
        role: 'agentOperator',
      });

      expect(key).toMatch(/^[A-Za-z]{64}$/);
      expect(agent).toMatchObject({
        name: 'deploy-bot',
        role: 'agentOperator',
      });

      const [row] = await ctx.db
        .select()
        .from(user)
        .where(eq(user.id, agent.id));
      expect(row).toMatchObject({
        kind: 'agent',
        emailVerified: false,
        firstName: 'deploy-bot',
        email: `${agent.id}@agents.cloudgate.invalid`,
      });
      expect(
        await ctx.db.select().from(account).where(eq(account.userId, agent.id)),
      ).toEqual([]);

      const memberships = await ctx.db
        .select()
        .from(member)
        .where(eq(member.userId, agent.id));
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({
        id: agent.memberId,
        role: 'agentOperator',
        isDefault: true,
        accessedProjects: [],
        accessedEnvironments: [],
        accessedServices: [],
      });

      const keys = await ctx.db
        .select()
        .from(apikey)
        .where(eq(apikey.referenceId, agent.id));
      expect(keys).toHaveLength(1);
      // The plugin's expiry stays empty: it deletes what it expires, and an
      // Agent key's expiry is Cloudgate's.
      expect(keys[0].expiresAt).toBeNull();
      expect(keys[0].permissions).toBeNull();
      expect(keys[0].metadata).toBeNull();
      expect(keys[0].key).not.toBe(key);
      const lifetime = keys[0].agentExpiresAt!.getTime() - before;
      expect(lifetime).toBeGreaterThan(90 * DAY - 60_000);
      expect(lifetime).toBeLessThan(90 * DAY + 60_000);
    });

    it('starts an Agent on Reader with nothing granted, and never answers its address', async () => {
      const { agent } = await createAgent({ name: 'reader-bot' });

      expect(agent.role).toBe('agentReader');
      const listed = await request(httpServer)
        .get('/agents')
        .set('Cookie', ownerCookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect(JSON.stringify(listed.body)).not.toContain(
        'agents.cloudgate.invalid',
      );
      expect(JSON.stringify(listed.body)).not.toContain('permissions');
    });

    it('offers 30, 90 or 365 days for the first key and nothing else', async () => {
      for (const keyExpiresInDays of [0, 7, 3650, null]) {
        const res = await request(httpServer)
          .post('/agents')
          .set('Cookie', ownerCookie)
          .send({ name: 'bot', keyExpiresInDays });
        expect([keyExpiresInDays, res.status]).toEqual([keyExpiresInDays, 400]);
      }
      const { agent } = await createAgent({
        name: 'bot',
        keyExpiresInDays: 30,
      });
      const [row] = await ctx.db
        .select({ agentExpiresAt: apikey.agentExpiresAt })
        .from(apikey)
        .where(eq(apikey.referenceId, agent.id));
      expect(row.agentExpiresAt!.getTime() - Date.now()).toBeLessThan(
        30 * DAY + 60_000,
      );
    });

    it('refuses any role but the two agent roles, creating nothing', async () => {
      for (const role of ['owner', 'admin', 'member']) {
        const res = await request(httpServer)
          .post('/agents')
          .set('Cookie', ownerCookie)
          .send({ name: 'bot', role });
        expect([role, res.status]).toEqual([role, 400]);
      }
      expect(
        await ctx.db.select().from(user).where(eq(user.kind, 'agent')),
      ).toEqual([]);
    });

    it('refuses a grant naming an id outside the Organization, creating nothing', async () => {
      const res = await request(httpServer)
        .post('/agents')
        .set('Cookie', ownerCookie)
        .send({ name: 'bot', grant: { accessedServices: ['not-a-service'] } });

      expect(res.status).toBe(404);
      expect(
        await ctx.db.select().from(user).where(eq(user.kind, 'agent')),
      ).toEqual([]);
    });

    it('is refused to a plain member, who can still read the Agents', async () => {
      await createAgent();
      const plain = await signUpMember(httpServer, ownerCookie);

      const res = await request(httpServer)
        .post('/agents')
        .set('Cookie', plain.cookie)
        .send({ name: 'bot' });
      expect(res.status).toBe(403);

      const listed = await request(httpServer)
        .get('/agents')
        .set('Cookie', plain.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
    });
  });

  describe('reading an Agent at rest', () => {
    it('names who created it, and still does after that person has left the Organization and deleted their account', async () => {
      const admin = await signUpMember(httpServer, ownerCookie, {
        email: 'katherine@example.com',
        name: 'Katherine Johnson',
        role: 'admin',
      });
      const { agent } = await createAgent({ name: 'deploy-bot' }, admin.cookie);

      const [adminMember] = await ctx.db
        .select({ id: member.id })
        .from(member)
        .where(eq(member.userId, admin.id));
      const left = await request(httpServer)
        .delete(`/organizations/members/${adminMember.id}`)
        .set('Cookie', ownerCookie);
      expect(left.status).toBe(200);
      await ctx.db.delete(user).where(eq(user.id, admin.id));

      const listed = await request(httpServer)
        .get('/agents')
        .set('Cookie', ownerCookie);
      expect(listed.status).toBe(200);
      const [shown] = listed.body as Array<
        CreatedAgent['agent'] & {
          createdBy: { name: string | null; email: string } | null;
        }
      >;
      // The Agent outlives its creator: its row, its member row and its key.
      expect(shown).toMatchObject({ id: agent.id, name: 'deploy-bot' });
      expect(shown.keys).toHaveLength(1);
      expect(shown.createdBy).toEqual({
        name: 'Katherine Johnson',
        email: 'katherine@example.com',
      });
    });

    it('names nobody when no create row exists for it', async () => {
      const { agent } = await createAgent();
      await ctx.db.delete(auditLog).where(eq(auditLog.resourceId, agent.id));

      const listed = await request(httpServer)
        .get('/agents')
        .set('Cookie', ownerCookie);
      expect(
        (listed.body as Array<{ createdBy: unknown }>)[0].createdBy,
      ).toBeNull();
    });

    it('reads an Agent as suspended while a ban on its user is in force, and not once the ban has lapsed', async () => {
      const { agent } = await createAgent();
      const suspended = async () => {
        const listed = await request(httpServer)
          .get('/agents')
          .set('Cookie', ownerCookie);
        return (listed.body as Array<{ suspended: boolean }>)[0].suspended;
      };

      expect(await suspended()).toBe(false);
      await ctx.db
        .update(user)
        .set({ banned: true, banExpires: null })
        .where(eq(user.id, agent.id));
      expect(await suspended()).toBe(true);
      await ctx.db
        .update(user)
        .set({ banExpires: new Date(Date.now() - DAY) })
        .where(eq(user.id, agent.id));
      expect(await suspended()).toBe(false);
    });
  });

  describe('an Agent cannot sign in', () => {
    it('has no password to sign in with', async () => {
      const { agent } = await createAgent();

      const res = await request(httpServer)
        .post('/api/auth/sign-in/email')
        .send({
          email: `${agent.id}@agents.cloudgate.invalid`,
          password: 'anything-at-all',
        });

      expect(res.status).toBe(401);
      expect(
        await ctx.db.select().from(session).where(eq(session.userId, agent.id)),
      ).toEqual([]);
    });

    it('is refused a session even when an account row is written for it by hand', async () => {
      const { agent } = await createAgent();
      const now = new Date();
      await ctx.db.insert(account).values({
        accountId: agent.id,
        providerId: 'credential',
        userId: agent.id,
        password: await hashPassword('a-password-nobody-should-have'),
        createdAt: now,
        updatedAt: now,
      });

      const res = await request(httpServer)
        .post('/api/auth/sign-in/email')
        .send({
          email: `${agent.id}@agents.cloudgate.invalid`,
          password: 'a-password-nobody-should-have',
        });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject(AGENT_REFUSAL);
      // Nothing was created on the way to being refused.
      expect(
        await ctx.db.select().from(session).where(eq(session.userId, agent.id)),
      ).toEqual([]);
    });
  });

  describe('an Agent key', () => {
    it('is refused on a REST route, where a personal key of the same Organization is not', async () => {
      const { key } = await createAgent({ name: 'bot', role: 'agentOperator' });
      const minted = await request(httpServer)
        .post('/users/me/api-keys')
        .set('Cookie', ownerCookie)
        .send({ name: 'ci' });
      expect(minted.status).toBe(201);

      const refused = await request(httpServer)
        .get('/projects')
        .set('x-api-key', key);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject(AGENT_REFUSAL);

      // The baseline: a personal key still works on the same route.
      const personal = await request(httpServer)
        .get('/projects')
        .set('x-api-key', (minted.body as { key: string }).key);
      expect(personal.status).toBe(200);
    });

    it('is refused on every /api/auth endpoint and method, before the endpoint runs', async () => {
      const { agent, key } = await createAgent();
      const auth = ctx.app.get<Auth>(AUTH);
      const disabled = new Set(auth.options.disabledPaths ?? []);

      const answers: string[] = [];
      for (const { path, methods } of routedAuthEndpoints(ctx.app)) {
        const url = `/api/auth${path.replace(/:[A-Za-z]+/g, 'x')}`;
        for (const method of methods) {
          const verb = method.toLowerCase() as 'get' | 'post';
          const res = await request(httpServer)
            [verb](url)
            .set('x-api-key', key)
            .send({ name: 'renamed-by-the-agent' });
          const expected = disabled.has(path)
            ? '404'
            : `403 ${AGENT_REFUSAL.code}`;
          const actual = disabled.has(path)
            ? String(res.status)
            : `${res.status} ${(res.body as { code?: string }).code}`;
          if (actual !== expected) answers.push(`${method} ${path}: ${actual}`);
        }
      }

      expect(answers).toEqual([]);
      // `/update-user` did not run: the refusal came first.
      const [row] = await ctx.db
        .select({ firstName: user.firstName })
        .from(user)
        .where(eq(user.id, agent.id));
      expect(row.firstName).toBe('deploy-bot');
    });

    it('is refused on /get-session, which the api-key plugin answers from its own hook', async () => {
      const { key } = await createAgent();

      const res = await request(httpServer)
        .get('/api/auth/get-session')
        .set('x-api-key', key);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject(AGENT_REFUSAL);
    });

    it('stays a row once expired, where a personal key the plugin expires is deleted', async () => {
      const { agent, key } = await createAgent();
      await ctx.db
        .update(apikey)
        .set({ agentExpiresAt: new Date(Date.now() - DAY) })
        .where(eq(apikey.referenceId, agent.id));

      // The control, and the plugin behaviour the column exists to avoid: a
      // key past the plugin's own `expiresAt` is deleted by verifying it.
      const minted = await request(httpServer)
        .post('/users/me/api-keys')
        .set('Cookie', ownerCookie)
        .send({ name: 'ci' });
      expect(minted.status).toBe(201);
      const personal = minted.body as { id: string; key: string };
      await ctx.db
        .update(apikey)
        .set({ expiresAt: new Date(Date.now() - DAY) })
        .where(eq(apikey.id, personal.id));
      const expired = await request(httpServer)
        .get('/projects')
        .set('x-api-key', personal.key);
      expect(expired.status).toBe(401);
      expect(
        await ctx.db.select().from(apikey).where(eq(apikey.id, personal.id)),
      ).toEqual([]);

      const refused = await request(httpServer)
        .get('/projects')
        .set('x-api-key', key);
      expect(refused.status).toBe(403);

      const listed = await request(httpServer)
        .get('/agents')
        .set('Cookie', ownerCookie);
      const [shown] = listed.body as CreatedAgent['agent'][];
      expect(shown.keys).toHaveLength(1);
      expect(shown.keys[0].expired).toBe(true);
    });
  });

  describe('deleting an Agent', () => {
    it('removes its member row and keys, and its audit rows survive', async () => {
      const { agent } = await createAgent();
      // A row the Agent itself wrote: the dispatcher writes these, and they
      // have to outlive the Agent.
      const organizationId = (
        await ctx.db
          .select({ organizationId: member.organizationId })
          .from(member)
          .where(eq(member.userId, agent.id))
      )[0].organizationId;
      await ctx.app.get(AuditLogService).audit(
        { userId: agent.id, organizationId },
        {
          action: 'deploy',
          resourceType: 'application',
          resourceId: 'app-1',
        },
      );

      const res = await request(httpServer)
        .delete(`/agents/${agent.id}`)
        .set('Cookie', ownerCookie);
      expect(res.status).toBe(200);

      expect(
        await ctx.db.select().from(user).where(eq(user.id, agent.id)),
      ).toEqual([]);
      expect(
        await ctx.db.select().from(member).where(eq(member.userId, agent.id)),
      ).toEqual([]);
      expect(
        await ctx.db
          .select()
          .from(apikey)
          .where(eq(apikey.referenceId, agent.id)),
      ).toEqual([]);

      const [survivor] = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resourceId, 'app-1'));
      expect(survivor).toMatchObject({
        userId: null,
        userEmail: `${agent.id}@agents.cloudgate.invalid`,
        userRole: 'agentReader',
        action: 'deploy',
      });
      const trail = await ctx.db
        .select({ action: auditLog.action, userId: auditLog.userId })
        .from(auditLog)
        .where(eq(auditLog.resourceId, agent.id));
      expect(trail).toEqual(
        expect.arrayContaining([
          { action: 'create', userId: ownerId },
          { action: 'delete', userId: ownerId },
        ]),
      );
    });

    it('reads a person, or an id nobody holds, as no Agent at all', async () => {
      const plain = await signUpMember(httpServer, ownerCookie);

      for (const id of [plain.id, 'no-such-agent']) {
        const res = await request(httpServer)
          .delete(`/agents/${id}`)
          .set('Cookie', ownerCookie);
        expect([id, res.status]).toEqual([id, 404]);
      }
      expect(
        await ctx.db.select().from(user).where(eq(user.id, plain.id)),
      ).toHaveLength(1);
    });
  });
});
