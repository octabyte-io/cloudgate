import { ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { licenseKey, member, organizationRole } from '../../src/db/schema';
import { CustomRolesService } from '../../src/enterprise/custom-roles/custom-roles.service';
import {
  agentCallerRole,
  agentOperatorRole,
  agentReaderRole,
} from '../../src/rbac/access-control';
import { PermissionService } from '../../src/rbac/permission.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * The authorization pins of an Agent (ADR-0023): the three agent roles on
 * an unlicensed install, instance authority an Agent never has whatever its
 * role says, and the one writer of `member.role` seen through the role route.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The two refusals `member-role.ts` makes, hand-written (§1.7). */
const AGENT_ROLE_REFUSAL =
  'An Agent can hold only the agentReader, agentOperator or agentCaller role';
const PERSON_ROLE_REFUSAL =
  'The agentReader, agentOperator and agentCaller roles are held only by Agents';

const INSTANCE_AUTHORITY_REFUSAL =
  'Only an owner or admin of the instance organization can configure the platform host';

describe('Agent roles (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let permissions: PermissionService;
  let ownerCookie: string;
  let ownerId: string;
  let organizationId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    httpServer = ctx.app.getHttpServer() as App;
    permissions = ctx.app.get(PermissionService);
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

  const ctxFor = (userId: string): PermissionCtx => ({
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
  });

  async function createAgent(
    role: 'agentReader' | 'agentOperator' | 'agentCaller',
  ): Promise<{ id: string; memberId: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({ name: `${role}-bot`, role });
    expect(res.status).toBe(201);
    return (res.body as { agent: { id: string; memberId: string } }).agent;
  }

  async function roleOf(memberId: string): Promise<string> {
    const [row] = await ctx.db
      .select({ role: member.role })
      .from(member)
      .where(eq(member.id, memberId));
    return row.role;
  }

  /** Why `checkPermission` refused, or `'allowed'`. */
  async function decide(
    userId: string,
    request: Parameters<PermissionService['checkPermission']>[1],
  ): Promise<string> {
    try {
      await permissions.checkPermission(ctxFor(userId), request);
      return 'allowed';
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      return 'refused';
    }
  }

  describe('on an unlicensed install', () => {
    it('refuses Reader a deploy and lets Operator deploy and cancel', async () => {
      const reader = await createAgent('agentReader');
      const operator = await createAgent('agentOperator');

      expect(await decide(reader.id, { deployment: ['create'] })).toBe(
        'refused',
      );
      expect(await decide(reader.id, { deployment: ['read'] })).toBe('allowed');
      expect(await decide(reader.id, { service: ['read'] })).toBe('allowed');
      expect(await decide(operator.id, { deployment: ['create'] })).toBe(
        'allowed',
      );
      expect(await decide(operator.id, { deployment: ['cancel'] })).toBe(
        'allowed',
      );
    });

    it('refuses Operator a backup, and neither role any statement beyond its four', async () => {
      const reader = await createAgent('agentReader');
      const operator = await createAgent('agentOperator');

      for (const id of [reader.id, operator.id]) {
        for (const request of [
          { backup: ['read' as const] },
          { service: ['update' as const] },
          { project: ['update' as const] },
          { monitoring: ['read' as const] },
          { tag: ['read' as const] },
          { ac: ['read' as const] },
          { docker: ['read' as const] },
        ]) {
          expect([id, request, await decide(id, request)]).toEqual([
            id,
            request,
            'refused',
          ]);
        }
      }
    });

    it('never holds a docker statement, which is what keeps a tool out of a container', () => {
      // ADR-0024's standing prohibition is pinned here rather than by an
      // absence of tools.
      expect(Object.keys(agentReaderRole.statements)).not.toContain('docker');
      expect(Object.keys(agentOperatorRole.statements)).not.toContain('docker');
      expect(agentReaderRole.statements).toEqual({
        service: ['read'],
        environment: ['read'],
        deployment: ['read'],
        domain: ['read'],
      });
      expect(agentOperatorRole.statements).toEqual({
        service: ['read'],
        environment: ['read'],
        deployment: ['read', 'create', 'cancel'],
        domain: ['read'],
      });
    });
  });

  describe("service: ['call']", () => {
    it('grants call to owner, admin and Caller, and refuses member, Reader, Operator and a stored custom role', async () => {
      const caller = await createAgent('agentCaller');
      const reader = await createAgent('agentReader');
      const operator = await createAgent('agentOperator');
      const admin = await signUpMember(httpServer, ownerCookie, {
        email: 'admin@example.com',
        role: 'admin',
      });
      const person = await signUpMember(httpServer, ownerCookie);
      // A custom role stored before `call` existed, holding every other
      // service action: it gains nothing by the action being declared.
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'service-admin',
        permission: { service: ['create', 'read', 'update', 'delete'] },
      });
      const custom = await signUpMember(httpServer, ownerCookie, {
        email: 'custom@example.com',
      });
      await ctx.db
        .update(member)
        .set({ role: 'service-admin' })
        .where(eq(member.userId, custom.id));

      const answers: Array<[string, string]> = [];
      for (const [who, id] of [
        ['owner', ownerId],
        ['admin', admin.id],
        ['agentCaller', caller.id],
        ['member', person.id],
        ['agentReader', reader.id],
        ['agentOperator', operator.id],
        ['service-admin', custom.id],
      ]) {
        answers.push([who, await decide(id, { service: ['call'] })]);
      }

      expect(answers).toEqual([
        ['owner', 'allowed'],
        ['admin', 'allowed'],
        ['agentCaller', 'allowed'],
        ['member', 'refused'],
        ['agentReader', 'refused'],
        ['agentOperator', 'refused'],
        ['service-admin', 'refused'],
      ]);
    });

    it('holds Caller to call alone: no read, no deploy', async () => {
      const caller = await createAgent('agentCaller');

      expect(agentCallerRole.statements).toEqual({ service: ['call'] });
      for (const request of [
        { service: ['read' as const] },
        { environment: ['read' as const] },
        { deployment: ['read' as const] },
        { deployment: ['create' as const] },
        { domain: ['read' as const] },
        { docker: ['read' as const] },
      ]) {
        expect([request, await decide(caller.id, request)]).toEqual([
          request,
          'refused',
        ]);
      }
    });
  });

  describe('instance authority', () => {
    it('refuses an Agent written straight to admin in the instance organization', async () => {
      const agent = await createAgent('agentOperator');
      // Past every writer: the property has to hold on its own.
      await ctx.db
        .update(member)
        .set({ role: 'admin' })
        .where(eq(member.id, agent.memberId));

      await expect(
        permissions.checkInstanceAuthority(ctxFor(agent.id)),
      ).rejects.toThrow(INSTANCE_AUTHORITY_REFUSAL);
      // The same row shape on a person passes, so it is the kind that refused.
      const person = await signUpMember(httpServer, ownerCookie, {
        role: 'admin',
      });
      await expect(
        permissions.checkInstanceAuthority(ctxFor(person.id)),
      ).resolves.toBeUndefined();
      await expect(
        permissions.checkInstanceAuthority(ctxFor(ownerId)),
      ).resolves.toBeUndefined();
    });

    it('refuses an Agent written straight to owner too', async () => {
      const agent = await createAgent('agentReader');
      await ctx.db
        .update(member)
        .set({ role: 'owner' })
        .where(eq(member.id, agent.memberId));

      await expect(
        permissions.checkInstanceAuthority(ctxFor(agent.id)),
      ).rejects.toThrow(INSTANCE_AUTHORITY_REFUSAL);
    });
  });

  describe('the role route', () => {
    const changeRole = (memberId: string, role: string) =>
      request(httpServer)
        .patch(`/organizations/members/${memberId}`)
        .set('Cookie', ownerCookie)
        .send({ role });

    it('moves an Agent between its two roles', async () => {
      const agent = await createAgent('agentReader');

      const res = await changeRole(agent.memberId, 'agentOperator');

      expect(res.status).toBe(200);
      expect(await roleOf(agent.memberId)).toBe('agentOperator');
    });

    it('refuses to move an Agent to owner, admin, member or a custom role', async () => {
      const agent = await createAgent('agentReader');
      // Licensed, so the custom role gets past the licence check and it is the
      // writer that refuses it.
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'deployer',
        permission: { deployment: ['read', 'create'] },
      });

      const answers: Array<[string, number, string]> = [];
      for (const role of ['owner', 'admin', 'member', 'deployer']) {
        const res = await changeRole(agent.memberId, role);
        answers.push([
          role,
          res.status,
          (res.body as { message: string }).message,
        ]);
      }

      expect(answers).toEqual([
        ['owner', 403, 'The owner role is nontransferable'],
        ['admin', 403, AGENT_ROLE_REFUSAL],
        ['member', 403, AGENT_ROLE_REFUSAL],
        ['deployer', 403, AGENT_ROLE_REFUSAL],
      ]);
      expect(await roleOf(agent.memberId)).toBe('agentReader');
    });

    it('refuses to move a person to any agent role', async () => {
      const person = await signUpMember(httpServer, ownerCookie);
      const [row] = await ctx.db
        .select({ id: member.id })
        .from(member)
        .where(eq(member.userId, person.id));

      for (const role of ['agentReader', 'agentOperator', 'agentCaller']) {
        const res = await changeRole(row.id, role);
        expect([
          role,
          res.status,
          (res.body as { message: string }).message,
        ]).toEqual([role, 403, PERSON_ROLE_REFUSAL]);
      }
      expect(await roleOf(row.id)).toBe('member');
    });

    it('refuses to invite a person onto an agent role, inviting nobody', async () => {
      const res = await request(httpServer)
        .post('/organizations/invitations')
        .set('Cookie', ownerCookie)
        .send({ email: 'ada@example.com', role: 'agentOperator' });

      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toBe(
        PERSON_ROLE_REFUSAL,
      );
      const listed = await request(httpServer)
        .get('/organizations/invitations')
        .set('Cookie', ownerCookie);
      expect(listed.body).toEqual([]);
    });
  });

  describe('the custom-role rename', () => {
    it('moves no one when the new name would put people on an agent role', async () => {
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'deployer',
        permission: { deployment: ['read'] },
      });
      const person = await signUpMember(httpServer, ownerCookie);
      await ctx.db
        .update(member)
        .set({ role: 'deployer' })
        .where(eq(member.userId, person.id));

      // Past the DTO, which reserves the name: the writer is what refuses.
      await expect(
        ctx.app.get(CustomRolesService).update(ctxFor(ownerId), {
          roleName: 'deployer',
          newRoleName: 'agentOperator',
          permissions: { deployment: ['read'] },
        }),
      ).rejects.toThrow(PERSON_ROLE_REFUSAL);

      // Rolled back whole: the role kept its name and its holder kept it.
      const roles = await ctx.db
        .select({ role: organizationRole.role })
        .from(organizationRole)
        .where(eq(organizationRole.organizationId, organizationId));
      expect(roles).toEqual([{ role: 'deployer' }]);
      const [held] = await ctx.db
        .select({ role: member.role })
        .from(member)
        .where(eq(member.userId, person.id));
      expect(held.role).toBe('deployer');
    });

    it('refuses the agent role names at the route', async () => {
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });

      const res = await request(httpServer)
        .post('/custom-roles')
        .set('Cookie', ownerCookie)
        .send({ roleName: 'agentReader', permissions: {} });

      expect(res.status).toBe(400);
    });
  });
});
