import request from 'supertest';
import { App } from 'supertest/types';
import { eq } from 'drizzle-orm';
import { auditLog } from '../../../src/enterprise/audit-logs/audit-log.schema';
import { AuditLogService } from '../../../src/enterprise/audit-logs/audit-log.service';
import { LicenseService } from '../../../src/enterprise/license/license.service';
import { createTestApp, TestAppContext } from '../../utils/test-app';
import {
  secondOrganizationOwner,
  createOrganization as postOrganization,
} from '../../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

interface MemberRow {
  id: string;
  userId: string;
  role: string;
}

async function createOrganization(
  server: App,
  db: TestAppContext['db'],
  cookie: string,
  name: string,
): Promise<string> {
  const res = await postOrganization(server, db, cookie, { name });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function activeOrganizationId(
  server: App,
  cookie: string,
): Promise<string> {
  const res = await request(server)
    .get('/organizations/active')
    .set('Cookie', cookie);
  expect(res.status).toBe(200);
  return (res.body as { id: string }).id;
}

/**
 * Owner org plus one member who actually accepted the invitation — signing up
 * with a token alone creates no member row.
 */
async function setUpOrgWithMember(server: App) {
  const ownerSession = await signUp(server, owner);

  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', ownerSession.cookie)
    .send({ email: 'invitee@example.com', role: 'member' });
  const inviteId = (invite.body as { id: string }).id;

  const su = await request(server)
    .post('/api/auth/sign-up/email')
    .set('x-cloudgate-token', inviteId)
    .send({
      name: 'Ida Rhodes',
      email: 'invitee@example.com',
      password: 'super-secret-password',
    });
  const inviteeCookie = su.headers['set-cookie'];
  const inviteeId = (su.body as { user: { id: string } }).user.id;

  const accept = await request(server)
    .post(`/organizations/invitations/${inviteId}/accept`)
    .set('Cookie', inviteeCookie);
  expect(accept.status).toBe(201);

  return {
    owner: ownerSession,
    invitee: { cookie: inviteeCookie, id: inviteeId },
  };
}

/** Distinct createdAt values: defaultNow() ties inside the same millisecond. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('Audit logs (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let service: AuditLogService;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
    service = ctx.app.get(AuditLogService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  describe('record', () => {
    it('persists an entry retrievable through the query interface', async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );

      await service.record({
        organizationId,
        userId: ownerSession.id,
        userEmail: owner.email,
        userRole: 'owner',
        action: 'create',
        resourceType: 'project',
        resourceId: 'project-1',
        resourceName: 'my-app',
        metadata: { source: 'test' },
        ip: '203.0.113.7',
      });

      // scoped past the login the sign-up itself recorded
      const { logs, total } = await service.findAll(organizationId, {
        resourceType: 'project',
      });

      expect(total).toBe(1);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        organizationId,
        userId: ownerSession.id,
        userEmail: owner.email,
        userRole: 'owner',
        action: 'create',
        resourceType: 'project',
        resourceId: 'project-1',
        resourceName: 'my-app',
        metadata: JSON.stringify({ source: 'test' }),
        ip: '203.0.113.7',
      });
      expect(logs[0].createdAt).toBeInstanceOf(Date);
    });
  });

  describe('query', () => {
    it('returns newest first and pages with limit/offset while total counts every match', async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const base = {
        organizationId,
        userId: ownerSession.id,
        userEmail: owner.email,
        userRole: 'owner',
        action: 'create',
        resourceType: 'project',
      } as const;

      for (const resourceName of ['first', 'second', 'third']) {
        await service.record({ ...base, resourceName });
        await tick();
      }

      const page1 = await service.findAll(organizationId, {
        resourceType: 'project',
        limit: 2,
        offset: 0,
      });
      expect(page1.logs.map((log) => log.resourceName)).toEqual([
        'third',
        'second',
      ]);
      expect(page1.total).toBe(3);

      const page2 = await service.findAll(organizationId, {
        resourceType: 'project',
        limit: 2,
        offset: 2,
      });
      expect(page2.logs.map((log) => log.resourceName)).toEqual(['first']);
      expect(page2.total).toBe(3);
    });

    it('filters by user, email, action, resource type, resource name and date window', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      // A second organization, so the trail under test holds exactly the three
      // entries below — sign-up logins land in the default organization.
      const organizationId = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        'Filters Org',
      );
      await tick();

      await service.record({
        organizationId,
        userId: ownerSession.id,
        userEmail: owner.email,
        userRole: 'owner',
        action: 'create',
        resourceType: 'project',
        resourceName: 'apollo',
      });
      await tick();
      await service.record({
        organizationId,
        userId: ownerSession.id,
        userEmail: owner.email,
        userRole: 'owner',
        action: 'delete',
        resourceType: 'database',
        resourceName: 'gemini',
      });
      await tick();
      await service.record({
        organizationId,
        userId: invitee.id,
        userEmail: 'invitee@example.com',
        userRole: 'member',
        action: 'login',
        resourceType: 'session',
      });

      const all = await service.findAll(organizationId, {});
      // newest first: the three above, then the entry creating the organization
      expect(all.total).toBe(4);
      const [login, gemini, apollo, orgCreated] = all.logs;

      const byUser = await service.findAll(organizationId, {
        userId: invitee.id,
      });
      expect(byUser.logs.map((log) => log.auditLogId)).toEqual([
        login.auditLogId,
      ]);
      expect(byUser.total).toBe(1);

      const byEmail = await service.findAll(organizationId, {
        userEmail: 'invitee',
      });
      expect(byEmail.logs.map((log) => log.auditLogId)).toEqual([
        login.auditLogId,
      ]);

      const byAction = await service.findAll(organizationId, {
        action: 'delete',
      });
      expect(byAction.logs.map((log) => log.auditLogId)).toEqual([
        gemini.auditLogId,
      ]);

      const byResourceType = await service.findAll(organizationId, {
        resourceType: 'project',
      });
      expect(byResourceType.logs.map((log) => log.auditLogId)).toEqual([
        apollo.auditLogId,
      ]);

      const byResourceName = await service.findAll(organizationId, {
        resourceName: 'poll',
      });
      expect(byResourceName.logs.map((log) => log.auditLogId)).toEqual([
        apollo.auditLogId,
      ]);

      const since = await service.findAll(organizationId, {
        from: gemini.createdAt,
      });
      expect(since.logs.map((log) => log.auditLogId)).toEqual([
        login.auditLogId,
        gemini.auditLogId,
      ]);

      const until = await service.findAll(organizationId, {
        to: gemini.createdAt,
      });
      expect(until.logs.map((log) => log.auditLogId)).toEqual([
        gemini.auditLogId,
        apollo.auditLogId,
        orgCreated.auditLogId,
      ]);
    });

    it('scopes results to one organization', async () => {
      const ownerSession = await signUp(server, owner);
      const orgA = await activeOrganizationId(server, ownerSession.cookie);

      const orgB = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        'Second Org',
      );

      const actor = {
        userId: ownerSession.id,
        userEmail: owner.email,
        userRole: 'owner',
        action: 'create',
        resourceType: 'project',
      } as const;
      await service.record({
        ...actor,
        organizationId: orgA,
        resourceName: 'in-a',
      });
      await service.record({
        ...actor,
        organizationId: orgB,
        resourceName: 'in-b',
      });

      const fromA = await service.findAll(orgA, { resourceType: 'project' });
      expect(fromA.total).toBe(1);
      expect(fromA.logs[0].resourceName).toBe('in-a');

      const fromB = await service.findAll(orgB, { resourceType: 'project' });
      expect(fromB.total).toBe(1);
      expect(fromB.logs[0].resourceName).toBe('in-b');
    });
  });

  describe('auth events', () => {
    it('records a login when a session is created', async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );

      const signIn = await request(server)
        .post('/api/auth/sign-in/email')
        .send({ email: owner.email, password: owner.password });
      expect(signIn.status).toBe(200);

      const { logs, total } = await service.findAll(organizationId, {
        action: 'login',
      });
      // one for the sign-up's auto sign-in, one for the explicit sign-in
      expect(total).toBe(2);
      for (const log of logs) {
        expect(log).toMatchObject({
          userId: ownerSession.id,
          userEmail: owner.email,
          userRole: 'owner',
          action: 'login',
          resourceType: 'session',
          resourceId: null,
          resourceName: null,
        });
      }
    });

    it('records a logout when the session is deleted, with the role held at the time', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );

      const signOut = await request(server)
        .post('/api/auth/sign-out')
        .set('Cookie', invitee.cookie);
      expect(signOut.status).toBe(200);

      const { logs, total } = await service.findAll(organizationId, {
        action: 'logout',
      });
      expect(total).toBe(1);
      expect(logs[0]).toMatchObject({
        userId: invitee.id,
        userEmail: 'invitee@example.com',
        userRole: 'member',
        action: 'logout',
        resourceType: 'session',
      });
    });
  });

  describe('organization events', () => {
    it('records organization create, update and set-default with the caller address', async () => {
      const ownerSession = await signUp(server, owner);

      const orgId = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        'Wartime Ops',
      );

      const renamed = await request(server)
        .patch(`/organizations/${orgId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'Peacetime Ops' });
      expect(renamed.status).toBe(200);

      const setDefault = await request(server)
        .post(`/organizations/${orgId}/set-default`)
        .set('Cookie', ownerSession.cookie);
      expect(setDefault.status).toBe(200);

      const { logs } = await service.findAll(orgId, {});
      expect(
        logs.map((log) => ({
          action: log.action,
          resourceType: log.resourceType,
          resourceId: log.resourceId,
          resourceName: log.resourceName,
          metadata: log.metadata,
        })),
      ).toEqual([
        {
          action: 'update',
          resourceType: 'organization',
          resourceId: orgId,
          resourceName: null,
          metadata: JSON.stringify({ type: 'setDefault' }),
        },
        {
          action: 'update',
          resourceType: 'organization',
          resourceId: orgId,
          resourceName: 'Peacetime Ops',
          metadata: null,
        },
        {
          action: 'create',
          resourceType: 'organization',
          resourceId: orgId,
          resourceName: 'Wartime Ops',
          metadata: null,
        },
      ]);
      for (const log of logs) {
        expect(log.userId).toBe(ownerSession.id);
        expect(log.userEmail).toBe(owner.email);
        expect(log.userRole).toBe('owner');
        expect(log.ip).toContain('127.0.0.1');
      }
    });

    it('records sending and withdrawing an invitation', async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );

      const invite = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', ownerSession.cookie)
        .send({ email: 'newbie@example.com', role: 'member' });
      expect(invite.status).toBe(201);
      const inviteId = (invite.body as { id: string }).id;

      const withdrawn = await request(server)
        .delete(`/organizations/invitations/${inviteId}`)
        .set('Cookie', ownerSession.cookie);
      expect(withdrawn.status).toBe(200);

      const { logs } = await service.findAll(organizationId, {
        resourceType: 'organization',
      });
      expect(
        logs.map((log) => ({
          action: log.action,
          resourceId: log.resourceId,
          resourceName: log.resourceName,
          metadata: log.metadata,
        })),
      ).toEqual([
        {
          action: 'delete',
          resourceId: inviteId,
          resourceName: 'newbie@example.com',
          metadata: JSON.stringify({ type: 'removeInvitation' }),
        },
        {
          action: 'create',
          resourceId: inviteId,
          resourceName: 'newbie@example.com',
          metadata: JSON.stringify({ type: 'inviteMember', role: 'member' }),
        },
      ]);
    });
  });

  describe('member events', () => {
    it('records a role change with the roles held before and after, and the removal', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );

      const members = await request(server)
        .get('/organizations/members')
        .set('Cookie', ownerSession.cookie);
      expect(members.status).toBe(200);
      const memberRows = (members.body as { members: MemberRow[] }).members;
      const targetMember = memberRows.find(
        (row) => row.userId === invitee.id,
      ) as MemberRow;

      const promoted = await request(server)
        .patch(`/organizations/members/${targetMember.id}`)
        .set('Cookie', ownerSession.cookie)
        .send({ role: 'admin' });
      expect(promoted.status).toBe(200);

      const removed = await request(server)
        .delete(`/organizations/members/${targetMember.id}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);

      const { logs } = await service.findAll(organizationId, {
        resourceType: 'user',
      });
      expect(
        logs.map((log) => ({
          action: log.action,
          resourceId: log.resourceId,
          resourceName: log.resourceName,
          metadata: log.metadata,
        })),
      ).toEqual([
        {
          action: 'delete',
          resourceId: invitee.id,
          resourceName: 'invitee@example.com',
          metadata: null,
        },
        {
          action: 'update',
          resourceId: invitee.id,
          resourceName: 'invitee@example.com',
          metadata: JSON.stringify({ before: 'member', after: 'admin' }),
        },
      ]);
      // the actor is the owner who made the change, not the member it happened to
      for (const log of logs) {
        expect(log.userId).toBe(ownerSession.id);
        expect(log.userRole).toBe('owner');
      }
    });
  });

  describe('user events', () => {
    it('records a profile update and the api-key lifecycle', async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );

      const profile = await request(server)
        .patch('/users/me')
        .set('Cookie', ownerSession.cookie)
        .send({ lastName: 'Murray Hopper' });
      expect(profile.status).toBe(200);

      const key = await request(server)
        .post('/users/me/api-keys')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'ci-runner' });
      expect(key.status).toBe(201);
      const keyId = (key.body as { id: string }).id;

      const revoked = await request(server)
        .delete(`/users/me/api-keys/${keyId}`)
        .set('Cookie', ownerSession.cookie);
      expect(revoked.status).toBe(200);

      const { logs } = await service.findAll(organizationId, {
        resourceType: 'user',
      });
      expect(
        logs.map((log) => ({
          action: log.action,
          resourceId: log.resourceId,
          resourceName: log.resourceName,
        })),
      ).toEqual([
        { action: 'delete', resourceId: keyId, resourceName: 'ci-runner' },
        { action: 'create', resourceId: keyId, resourceName: 'ci-runner' },
        {
          action: 'update',
          resourceId: ownerSession.id,
          resourceName: owner.email,
        },
      ]);
    });
  });

  describe('GET /audit-logs', () => {
    it('serves the active organization trail to an owner, with filters applied', async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      await service.record({
        organizationId,
        userId: ownerSession.id,
        userEmail: owner.email,
        userRole: 'owner',
        action: 'deploy',
        resourceType: 'application',
        resourceId: 'app-1',
        resourceName: 'checkout-api',
      });

      const res = await request(server)
        .get('/audit-logs')
        .query({ resourceType: 'application' })
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      const body = res.body as {
        logs: Array<Record<string, unknown>>;
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.logs).toHaveLength(1);
      expect(body.logs[0]).toMatchObject({
        organizationId,
        action: 'deploy',
        resourceType: 'application',
        resourceId: 'app-1',
        resourceName: 'checkout-api',
      });
    });

    it('denies a member, who has no auditLog:read permission', async () => {
      const { invitee } = await setUpOrgWithMember(server);

      const res = await request(server)
        .get('/audit-logs')
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(403);
    });

    it('rejects malformed query parameters', async () => {
      const ownerSession = await signUp(server, owner);

      const badAction = await request(server)
        .get('/audit-logs')
        .query({ action: 'obliterate' })
        .set('Cookie', ownerSession.cookie);
      expect(badAction.status).toBe(400);

      const badLimit = await request(server)
        .get('/audit-logs')
        .query({ limit: 501 })
        .set('Cookie', ownerSession.cookie);
      expect(badLimit.status).toBe(400);
    });

    it('filters by outcome, and refuses an outcome the trail does not write', async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const base = {
        organizationId,
        userId: ownerSession.id,
        userEmail: owner.email,
        userRole: 'owner',
        action: 'deploy',
        resourceType: 'application',
      } as const;
      await service.record({ ...base, resourceName: 'ok' });
      await service.record({
        ...base,
        resourceName: 'no',
        outcome: 'refused',
        metadata: { reason: 'permission' },
      });
      await service.record({
        ...base,
        resourceName: 'broke',
        outcome: 'failed',
      });

      const names = async (outcome: string) => {
        const res = await request(server)
          .get('/audit-logs')
          .query({ resourceType: 'application', outcome })
          .set('Cookie', ownerSession.cookie);
        expect(res.status).toBe(200);
        const body = res.body as {
          logs: Array<{ resourceName: string; outcome: string }>;
          total: number;
        };
        expect(body.total).toBe(body.logs.length);
        expect(body.logs.every((log) => log.outcome === outcome)).toBe(true);
        return body.logs.map((log) => log.resourceName);
      };
      expect(await names('succeeded')).toEqual(['ok']);
      expect(await names('refused')).toEqual(['no']);
      expect(await names('failed')).toEqual(['broke']);

      const bad = await request(server)
        .get('/audit-logs')
        .query({ outcome: 'denied' })
        .set('Cookie', ownerSession.cookie);
      expect(bad.status).toBe(400);
    });

    it('selects the platform as the actor, and only the platform', async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      await service.record({
        organizationId,
        userId: ownerSession.id,
        userEmail: owner.email,
        userRole: 'owner',
        action: 'delete',
        resourceType: 'previewDeployment',
        resourceName: 'by-a-person',
      });
      // A Member who held a custom role named `system` before 0080 renamed
      // it: the role alone is not the platform, a caller-less row is.
      await service.record({
        organizationId,
        userId: ownerSession.id,
        userEmail: owner.email,
        userRole: 'system',
        action: 'delete',
        resourceType: 'previewDeployment',
        resourceName: 'by-a-member-on-a-custom-role',
      });
      // And the same Member once their user is deleted, which nulls the id
      // and keeps the address.
      await ctx.db.insert(auditLog).values({
        organizationId,
        userId: null,
        userEmail: 'gone@example.com',
        userRole: 'system',
        action: 'delete',
        resourceType: 'previewDeployment',
        resourceName: 'by-a-deleted-member-on-a-custom-role',
      });
      await service.recordAsPlatform(organizationId, {
        action: 'delete',
        resourceType: 'previewDeployment',
        resourceName: 'by-the-platform',
        metadata: { cause: 'expiry' },
      });

      const res = await request(server)
        .get('/audit-logs')
        .query({ actor: 'platform' })
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);
      const body = res.body as {
        logs: Array<Record<string, unknown>>;
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.logs).toEqual([
        expect.objectContaining({
          resourceName: 'by-the-platform',
          userId: null,
          userEmail: null,
          userRole: 'system',
          userName: 'Cloudgate',
          outcome: 'succeeded',
        }),
      ]);

      const bad = await request(server)
        .get('/audit-logs')
        .query({ actor: 'someone' })
        .set('Cookie', ownerSession.cookie);
      expect(bad.status).toBe(400);
    });

    it('serves the trail to an owner of an unlicensed organization', async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      // Asserted rather than assumed: the harness boots with no license, and
      // a suite that quietly gained one would make this prove nothing.
      await expect(
        ctx.app.get(LicenseService).hasValidLicense(organizationId),
      ).resolves.toBe(false);

      const res = await request(server)
        .get('/audit-logs')
        .query({ outcome: 'succeeded' })
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      // The sign-up's own login, written unlicensed and read back unlicensed.
      expect(
        (res.body as { logs: Array<{ action: string }> }).logs.map(
          (log) => log.action,
        ),
      ).toContain('login');
    });

    it("names an Agent's row by the name it had when written, after the Agent is deleted", async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const created = await request(server)
        .post('/agents')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'deploy-bot', role: 'agentOperator' });
      expect(created.status).toBe(201);
      const agentId = (created.body as { agent: { id: string } }).agent.id;

      await service.audit(
        { userId: agentId, organizationId },
        {
          action: 'read',
          resourceType: 'project',
          resourceName: 'storefront',
          outcome: 'refused',
          metadata: { reason: 'grant' },
        },
      );
      const removed = await request(server)
        .delete(`/agents/${agentId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);

      const res = await request(server)
        .get('/audit-logs')
        .query({ action: 'read' })
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);
      const { logs } = res.body as { logs: Array<Record<string, unknown>> };
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        userId: null,
        userName: 'deploy-bot',
        userRole: 'agentOperator',
        action: 'read',
        outcome: 'refused',
        metadata: JSON.stringify({ reason: 'grant' }),
      });

      // A person's row carries their name too, so the column never tells a
      // person from an Agent — `userRole` does.
      const own = await request(server)
        .get('/audit-logs')
        .query({ action: 'login', userId: ownerSession.id })
        .set('Cookie', ownerSession.cookie);
      expect(
        (own.body as { logs: Array<Record<string, unknown>> }).logs[0],
      ).toMatchObject({ userName: owner.name, userRole: 'owner' });
    });

    it('never serves another organization rows', async () => {
      const ownerSession = await signUp(server, owner);
      const otherOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        'Elsewhere',
      );
      await service.record({
        organizationId: otherOrg,
        userId: ownerSession.id,
        userEmail: owner.email,
        userRole: 'owner',
        action: 'delete',
        resourceType: 'server',
        resourceName: 'edge-1',
      });

      const res = await request(server)
        .get('/audit-logs')
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      const body = res.body as { logs: Array<{ resourceName: string | null }> };
      expect(body.logs.map((log) => log.resourceName)).not.toContain('edge-1');
    });
  });
  describe('AuditInterceptor', () => {
    const destination = {
      name: 'prod-backups',
      provider: 'Cloudflare',
      accessKey: 'AKIAEXAMPLEACCESSKEY',
      secretAccessKey: 'wJalrXUtnFEMI-example-secret-key',
      bucket: 'cloudgate-backups',
      region: 'auto',
      endpoint: 'https://accountid.r2.cloudflarestorage.com',
    };

    it('records creating and deleting a Destination, naming the actor and the resource, and never the credentials', async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );

      const created = await request(server)
        .post('/destinations')
        .set('Cookie', ownerSession.cookie)
        .send(destination);
      expect(created.status).toBe(201);
      const { destinationId } = created.body as { destinationId: string };

      const removed = await request(server)
        .delete(`/destinations/${destinationId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);

      const res = await request(server)
        .get('/audit-logs')
        .query({ resourceType: 'destination' })
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);
      const body = res.body as {
        logs: Array<Record<string, unknown>>;
        total: number;
      };
      expect(body.total).toBe(2);
      const [deleted, createdEntry] = body.logs;
      expect(createdEntry).toMatchObject({
        organizationId,
        userId: ownerSession.id,
        userEmail: owner.email,
        userRole: 'owner',
        action: 'create',
        resourceType: 'destination',
        resourceId: destinationId,
        resourceName: 'prod-backups',
        metadata: JSON.stringify({ route: 'POST /destinations' }),
        // An HTTP write is recorded only once it has succeeded; the other
        // outcomes are the MCP dispatcher's, not a route's.
        outcome: 'succeeded',
      });
      expect(deleted).toMatchObject({
        action: 'delete',
        resourceType: 'destination',
        resourceId: destinationId,
        resourceName: 'prod-backups',
        metadata: JSON.stringify({ route: 'DELETE /destinations/:id' }),
      });

      const rows = JSON.stringify(await ctx.db.select().from(auditLog));
      expect(rows).not.toContain(destination.secretAccessKey);
      expect(rows).not.toContain(destination.accessKey);
    });

    it('records a Project create with its environment left out of the row', async () => {
      const ownerSession = await signUp(server, owner);

      const created = await request(server)
        .post('/projects')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'storefront', env: 'STRIPE_KEY=sk_live_do_not_log' });
      expect(created.status).toBe(201);

      const rows = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resourceType, 'project'));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'create',
        resourceName: 'storefront',
        resourceId: (created.body as { projectId: string }).projectId,
      });
      expect(JSON.stringify(rows)).not.toContain('sk_live_do_not_log');
    });

    it('records nothing for a refused or failed write', async () => {
      const { invitee, owner: ownerSession } = await setUpOrgWithMember(server);

      const refused = await request(server)
        .post('/destinations')
        .set('Cookie', invitee.cookie)
        .send(destination);
      expect(refused.status).toBe(403);

      const missing = await request(server)
        .delete('/destinations/no-such-destination')
        .set('Cookie', ownerSession.cookie);
      expect(missing.status).toBe(404);

      const rows = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resourceType, 'destination'));
      expect(rows).toEqual([]);
    });
  });

  describe('deleted organizations', () => {
    it('keeps an entry recorded in a deleted Organization readable by the instance owner', async () => {
      const ownerSession = await signUp(server, owner);
      const elsewhere = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        'Elsewhere',
      );
      await service.record({
        organizationId: elsewhere,
        userId: ownerSession.id,
        userEmail: owner.email,
        userRole: 'owner',
        action: 'delete',
        resourceType: 'server',
        resourceName: 'edge-1',
      });

      const deleted = await request(server)
        .delete(`/organizations/${elsewhere}`)
        .set('Cookie', ownerSession.cookie);
      expect(deleted.status).toBe(200);

      // The organization's own trail can no longer hold it...
      const own = await request(server)
        .get('/audit-logs')
        .set('Cookie', ownerSession.cookie);
      expect(own.status).toBe(200);
      const ownBody = own.body as {
        logs: Array<{ resourceName: string | null }>;
        deletedOrganizationEntries: number | null;
      };
      expect(ownBody.logs.map((log) => log.resourceName)).not.toContain(
        'edge-1',
      );
      // ...but the screen is told how many entries are elsewhere,
      expect(ownBody.deletedOrganizationEntries).toBeGreaterThanOrEqual(1);

      // ...and the documented route reaches it.
      const orphaned = await request(server)
        .get('/audit-logs')
        .query({ scope: 'deleted-organizations', resourceType: 'server' })
        .set('Cookie', ownerSession.cookie);
      expect(orphaned.status).toBe(200);
      const body = orphaned.body as {
        logs: Array<Record<string, unknown>>;
        total: number;
        deletedOrganizationEntries: number;
      };
      expect(body.total).toBe(1);
      expect(body.logs[0]).toMatchObject({
        organizationId: null,
        userEmail: owner.email,
        action: 'delete',
        resourceType: 'server',
        resourceName: 'edge-1',
      });
      expect(body.deletedOrganizationEntries).toBe(
        ownBody.deletedOrganizationEntries,
      );
    });

    it('refuses the deleted-organizations trail to a second Organization owner and tells them no count', async () => {
      const ownerSession = await signUp(server, owner);
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
      );

      const refused = await request(server)
        .get('/audit-logs')
        .query({ scope: 'deleted-organizations' })
        .set('Cookie', mallory.cookie);
      expect(refused.status).toBe(403);
      expect((refused.body as { message: string }).message).toMatch(
        /instance organization/,
      );

      const own = await request(server)
        .get('/audit-logs')
        .set('Cookie', mallory.cookie);
      expect(own.status).toBe(200);
      expect(
        (own.body as { deletedOrganizationEntries: unknown })
          .deletedOrganizationEntries,
      ).toBeNull();
    });
  });
});
