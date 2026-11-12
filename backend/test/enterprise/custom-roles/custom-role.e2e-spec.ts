import {
  BadRequestException,
  Controller,
  ForbiddenException,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { invitation, member, organizationRole } from '../../../src/db/schema';
import { AuditLogService } from '../../../src/enterprise/audit-logs/audit-log.service';
import { CustomRolesService } from '../../../src/enterprise/custom-roles/custom-roles.service';
import { LicenseService } from '../../../src/enterprise/license/license.service';
import {
  adminRole,
  agentCallerRole,
  agentOperatorRole,
  agentReaderRole,
  memberRole,
  ownerRole,
  statements,
} from '../../../src/rbac/access-control';
import { RequirePermission } from '../../../src/rbac/decorators/require-permission.decorator';
import { PermissionService } from '../../../src/rbac/permission.service';
import type { PermissionCtx } from '../../../src/rbac/permission.service';
import { createTestApp, TestAppContext } from '../../utils/test-app';
import { createOrganization as postOrganization } from '../../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** The license answer every test in this file runs against; flipped per test. */
const license = { hasValidLicense: jest.fn<Promise<boolean>, [string]>() };

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
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

const ctxFor = (userId: string, organizationId: string): PermissionCtx => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/**
 * Owner org plus one member who actually accepted the invitation — signing up
 * with a token alone creates no member row.
 */
async function setUpOrgWithMember(server: App) {
  const ownerSession = await signUp(server, owner);
  const organizationId = await activeOrganizationId(
    server,
    ownerSession.cookie,
  );

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
    organizationId,
    owner: ownerSession,
    invitee: { cookie: inviteeCookie, id: inviteeId },
  };
}

/** A route protected the way feature controllers protect theirs. */
@Controller('custom-role-probe')
class CustomRoleProbeController {
  @Post('projects')
  @RequirePermission('project', 'create')
  createProject() {
    return { ok: true };
  }
}

/**
 * **`auditLog: ['read']` is this suite's stand-in grant, and it used to be
 * `logs: ['read']`.** Almost every case here needs one arbitrary valid
 * statement — the grant is arrangement, not subject — and `logs` had become
 * that statement everywhere, including in the two assertions that read it back
 * off `GET /custom-roles/statements`. An earlier cleanup deleted `logs` along
 * with `api` and `envVars`: all three were declared, granted by the static roles, and
 * consulted by nothing, which is also *why* one of them had drifted into being
 * the safe example. `auditLog` replaces it because it is the same shape —
 * enterprise-only, one `read` action, so the "Valid actions: read" refusal
 * below still has a resource to name — and unlike `logs` it is really gated,
 * by `@RequirePermission('auditLog', 'read')` on `GET /audit-logs`.
 */
describe('Custom roles (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let customRoles: CustomRolesService;
  let permissions: PermissionService;
  let auditLogs: AuditLogService;

  /** Arrangement only — the assignment path itself is exercised further down. */
  const assignRole = (userId: string, role: string) =>
    ctx.db.update(member).set({ role }).where(eq(member.userId, userId));

  const memberId = async (userId: string) => {
    const [row] = await ctx.db
      .select({ id: member.id })
      .from(member)
      .where(eq(member.userId, userId));
    return row.id;
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      controllers: [CustomRoleProbeController],
      overrideProviders: [{ provide: LicenseService, useValue: license }],
    });
    server = ctx.app.getHttpServer() as App;
    customRoles = ctx.app.get(CustomRolesService);
    permissions = ctx.app.get(PermissionService);
    auditLogs = ctx.app.get(AuditLogService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    license.hasValidLicense.mockResolvedValue(true);
  });

  describe('CRUD', () => {
    it('creates a role whose grants come back through the listing', async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );

      const created = await customRoles.create(
        ctxFor(ownerSession.id, organizationId),
        {
          roleName: 'deployer',
          permissions: { deployment: ['read', 'create'], auditLog: ['read'] },
        },
      );

      expect(created.role).toBe('deployer');
      expect(created.organizationId).toBe(organizationId);

      const roles = await customRoles.findAll(
        ctxFor(ownerSession.id, organizationId),
      );
      expect(roles).toEqual([
        expect.objectContaining({
          role: 'deployer',
          permissions: { deployment: ['read', 'create'], auditLog: ['read'] },
          ids: [created.id],
          memberCount: 0,
        }),
      ]);
    });

    it('refuses to define a role without a valid enterprise license', async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      license.hasValidLicense.mockResolvedValue(false);

      await expect(
        customRoles.create(ctxFor(ownerSession.id, organizationId), {
          roleName: 'deployer',
          permissions: { deployment: ['read'] },
        }),
      ).rejects.toThrow('Valid enterprise license required');
    });

    it('refuses to define a role for a plain member of the organization', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);

      await expect(
        customRoles.create(ctxFor(invitee.id, organizationId), {
          roleName: 'deployer',
          permissions: { deployment: ['read'] },
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        customRoles.findAll(ctxFor(invitee.id, organizationId)),
      ).resolves.toEqual([]);
    });

    // better-auth reads a role string as a comma-separated list, so
    // `ops,admin` would be an admin to every route Cloudgate delegates to it.
    it('refuses a role name with a comma, and writes no row', async () => {
      const ownerSession = await signUp(server, owner);

      const res = await request(server)
        .post('/custom-roles')
        .set('Cookie', ownerSession.cookie)
        .send({ roleName: 'ops,admin', permissions: { auditLog: ['read'] } });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain(
        'A role name cannot contain a comma',
      );
      expect(await ctx.db.select().from(organizationRole)).toEqual([]);
    });
  });

  describe('grant validation', () => {
    let ownerCtx: PermissionCtx;

    beforeEach(async () => {
      const ownerSession = await signUp(server, owner);
      ownerCtx = ctxFor(
        ownerSession.id,
        await activeOrganizationId(server, ownerSession.cookie),
      );
    });

    it('rejects a resource that is not an access-control statement', async () => {
      await expect(
        customRoles.create(ownerCtx, {
          roleName: 'deployer',
          permissions: { spaceship: ['read'] },
        }),
      ).rejects.toThrow('Unknown resource: spaceship');
    });

    it('rejects an action the resource does not define', async () => {
      await expect(
        customRoles.create(ownerCtx, {
          roleName: 'deployer',
          permissions: { auditLog: ['write'] },
        }),
      ).rejects.toThrow(
        'Invalid action "write" for resource "auditLog". Valid actions: read',
      );
    });

    /**
     * The write-verb scoping added `write` to the `docker` resource.
     * `validatePermissions` reads `statements` rather than a list of its own, so
     * an operator can grant the new action the day it lands — asserted rather
     * than assumed, because a second copy of the catalogue is exactly the kind of
     * thing that would make the narrowing unusable while looking correct.
     */
    it('accepts the docker write action the destructive container verbs require', async () => {
      const created = await customRoles.create(ownerCtx, {
        roleName: 'container-operator',
        permissions: { docker: ['read', 'write'] },
      });

      expect(created.permission).toEqual({ docker: ['read', 'write'] });
    });

    it('rejects internally managed resources', async () => {
      await expect(
        customRoles.create(ownerCtx, {
          roleName: 'deployer',
          permissions: { organization: ['delete'] },
        }),
      ).rejects.toThrow(
        'Resource "organization" is managed internally and cannot be assigned to custom roles',
      );
    });

    it('leaves nothing behind when a grant map is rejected', async () => {
      await expect(
        customRoles.create(ownerCtx, {
          roleName: 'deployer',
          permissions: { auditLog: ['read'], spaceship: ['read'] },
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(customRoles.findAll(ownerCtx)).resolves.toEqual([]);
    });
  });

  describe('create limits', () => {
    let ownerCtx: PermissionCtx;

    beforeEach(async () => {
      const ownerSession = await signUp(server, owner);
      ownerCtx = ctxFor(
        ownerSession.id,
        await activeOrganizationId(server, ownerSession.cookie),
      );
    });

    it('refuses a role name already defined in the organization', async () => {
      await customRoles.create(ownerCtx, {
        roleName: 'deployer',
        permissions: { auditLog: ['read'] },
      });

      await expect(
        customRoles.create(ownerCtx, {
          roleName: 'deployer',
          permissions: { monitoring: ['read'] },
        }),
      ).rejects.toThrow('Role "deployer" already exists');
    });

    it('caps an organization at ten distinct roles', async () => {
      for (let i = 0; i < 10; i++) {
        await customRoles.create(ownerCtx, {
          roleName: `role-${i}`,
          permissions: { auditLog: ['read'] },
        });
      }

      await expect(
        customRoles.create(ownerCtx, {
          roleName: 'role-10',
          permissions: { auditLog: ['read'] },
        }),
      ).rejects.toThrow('Maximum of 10 custom roles per organization reached');
      await expect(customRoles.findAll(ownerCtx)).resolves.toHaveLength(10);
    });
  });

  describe('permission resolution', () => {
    it('grants a member exactly the actions their custom role lists', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      const ownerCtx = ctxFor(ownerSession.id, organizationId);

      await customRoles.create(ownerCtx, {
        roleName: 'deployer',
        // project:create and deployment:cancel discriminate against the static
        // member role: it denies the first and grants the second.
        permissions: { project: ['create'], deployment: ['read'] },
      });
      await assignRole(invitee.id, 'deployer');

      const inviteeCtx = ctxFor(invitee.id, organizationId);
      await expect(
        permissions.checkPermission(inviteeCtx, { project: ['create'] }),
      ).resolves.toBeUndefined();
      await expect(
        permissions.checkPermission(inviteeCtx, { deployment: ['read'] }),
      ).resolves.toBeUndefined();
      await expect(
        permissions.checkPermission(inviteeCtx, { project: ['delete'] }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        permissions.checkPermission(inviteeCtx, { deployment: ['cancel'] }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        permissions.checkPermission(inviteeCtx, { service: ['read'] }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('opens an org-level enterprise resource a plain member cannot reach', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      const inviteeCtx = ctxFor(invitee.id, organizationId);

      // The static member role grants nothing on `server`.
      await expect(
        permissions.checkPermission(inviteeCtx, { server: ['create'] }),
      ).rejects.toThrow(ForbiddenException);

      await customRoles.create(ctxFor(ownerSession.id, organizationId), {
        roleName: 'infra',
        permissions: { server: ['read', 'create'] },
      });
      await assignRole(invitee.id, 'infra');

      await expect(
        permissions.checkPermission(inviteeCtx, { server: ['create'] }),
      ).resolves.toBeUndefined();
      await expect(
        permissions.checkPermission(inviteeCtx, { server: ['delete'] }),
      ).rejects.toThrow(ForbiddenException);
    });

    /**
     * A role assigned while licensed outlives the license — nothing deletes the
     * `organization_role` rows or moves anyone off them. It stops resolving, and
     * the bug was that it used to stop resolving as `Invalid role`, which reads as a
     * broken assignment rather than a lapsed license.
     */
    it('stops resolving a custom role once the license stops being valid, and says why', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      await customRoles.create(ctxFor(ownerSession.id, organizationId), {
        roleName: 'deployer',
        permissions: { project: ['create'] },
      });
      await assignRole(invitee.id, 'deployer');

      license.hasValidLicense.mockResolvedValue(false);

      await expect(
        permissions.checkPermission(ctxFor(invitee.id, organizationId), {
          project: ['create'],
        }),
      ).rejects.toThrow(/"deployer".*valid enterprise license/);
    });

    it('unions the grants of every row carrying the role name', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      await customRoles.create(ctxFor(ownerSession.id, organizationId), {
        roleName: 'deployer',
        permissions: { deployment: ['read'] },
      });
      // A second row under the same name — legacy data `create` no longer makes,
      // but which both readers still merge.
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'deployer',
        permission: { deployment: ['cancel'], auditLog: ['read'] },
      });
      await assignRole(invitee.id, 'deployer');

      await expect(
        permissions.checkPermission(ctxFor(invitee.id, organizationId), {
          deployment: ['read', 'cancel'],
          auditLog: ['read'],
        }),
      ).resolves.toBeUndefined();

      const [listed] = await customRoles.findAll(
        ctxFor(ownerSession.id, organizationId),
      );
      expect(listed.permissions).toEqual({
        deployment: ['read', 'cancel'],
        auditLog: ['read'],
      });
      expect(listed.ids).toHaveLength(2);
      expect(listed.memberCount).toBe(1);
    });
  });

  describe('update', () => {
    it('replaces the grants a role hands its members', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      const ownerCtx = ctxFor(ownerSession.id, organizationId);
      await customRoles.create(ownerCtx, {
        roleName: 'deployer',
        permissions: { project: ['create'] },
      });
      await assignRole(invitee.id, 'deployer');

      const updated = await customRoles.update(ownerCtx, {
        roleName: 'deployer',
        permissions: { auditLog: ['read'] },
      });
      expect(updated.permission).toEqual({ auditLog: ['read'] });

      const inviteeCtx = ctxFor(invitee.id, organizationId);
      await expect(
        permissions.checkPermission(inviteeCtx, { auditLog: ['read'] }),
      ).resolves.toBeUndefined();
      await expect(
        permissions.checkPermission(inviteeCtx, { project: ['create'] }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('carries the members over when the role is renamed', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      const ownerCtx = ctxFor(ownerSession.id, organizationId);
      await customRoles.create(ownerCtx, {
        roleName: 'deployer',
        permissions: { auditLog: ['read'] },
      });
      await assignRole(invitee.id, 'deployer');

      await customRoles.update(ownerCtx, {
        roleName: 'deployer',
        newRoleName: 'releaser',
        permissions: { auditLog: ['read'] },
      });

      expect(await customRoles.findAll(ownerCtx)).toEqual([
        expect.objectContaining({ role: 'releaser', memberCount: 1 }),
      ]);
      // The grants follow the member, who is now on the new name.
      await expect(
        permissions.checkPermission(ctxFor(invitee.id, organizationId), {
          auditLog: ['read'],
        }),
      ).resolves.toBeUndefined();
    });

    it('refuses to rename onto a name already in use', async () => {
      const ownerSession = await signUp(server, owner);
      const ownerCtx = ctxFor(
        ownerSession.id,
        await activeOrganizationId(server, ownerSession.cookie),
      );
      await customRoles.create(ownerCtx, {
        roleName: 'deployer',
        permissions: { auditLog: ['read'] },
      });
      await customRoles.create(ownerCtx, {
        roleName: 'releaser',
        permissions: { monitoring: ['read'] },
      });

      await expect(
        customRoles.update(ownerCtx, {
          roleName: 'deployer',
          newRoleName: 'releaser',
          permissions: { auditLog: ['read'] },
        }),
      ).rejects.toThrow('Role "releaser" already exists');

      const roles = await customRoles.findAll(ownerCtx);
      expect(roles.map((role) => role.role).sort()).toEqual([
        'deployer',
        'releaser',
      ]);
    });

    it('reports a role that does not exist as missing', async () => {
      const ownerSession = await signUp(server, owner);
      const ownerCtx = ctxFor(
        ownerSession.id,
        await activeOrganizationId(server, ownerSession.cookie),
      );

      await expect(
        customRoles.update(ownerCtx, {
          roleName: 'ghost',
          permissions: { auditLog: ['read'] },
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('leaves the role and its members untouched when a rename is rejected', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      const ownerCtx = ctxFor(ownerSession.id, organizationId);
      await customRoles.create(ownerCtx, {
        roleName: 'deployer',
        permissions: { auditLog: ['read'] },
      });
      await assignRole(invitee.id, 'deployer');

      await expect(
        customRoles.update(ownerCtx, {
          roleName: 'deployer',
          newRoleName: 'releaser',
          permissions: { spaceship: ['read'] },
        }),
      ).rejects.toThrow(BadRequestException);

      expect(await customRoles.findAll(ownerCtx)).toEqual([
        expect.objectContaining({
          role: 'deployer',
          permissions: { auditLog: ['read'] },
          memberCount: 1,
        }),
      ]);
      await expect(
        permissions.checkPermission(ctxFor(invitee.id, organizationId), {
          auditLog: ['read'],
        }),
      ).resolves.toBeUndefined();
    });

    it('refuses a rename onto a name with a comma, leaving the role and its members', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      const ownerCtx = ctxFor(ownerSession.id, organizationId);
      await customRoles.create(ownerCtx, {
        roleName: 'deployer',
        permissions: { auditLog: ['read'] },
      });
      await assignRole(invitee.id, 'deployer');

      const res = await request(server)
        .patch('/custom-roles/deployer')
        .set('Cookie', ownerSession.cookie)
        .send({ newRoleName: 'x,owner', permissions: { auditLog: ['read'] } });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain(
        'A role name cannot contain a comma',
      );
      expect(await customRoles.findAll(ownerCtx)).toEqual([
        expect.objectContaining({
          role: 'deployer',
          permissions: { auditLog: ['read'] },
          memberCount: 1,
        }),
      ]);
      const [row] = await ctx.db
        .select({ role: member.role })
        .from(member)
        .where(eq(member.userId, invitee.id));
      expect(row.role).toBe('deployer');
    });

    it('refuses to modify a built-in role', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);

      await expect(
        customRoles.update(ctxFor(ownerSession.id, organizationId), {
          roleName: 'member',
          permissions: { server: ['create'] },
        }),
      ).rejects.toThrow('Cannot modify built-in roles');

      await expect(
        permissions.checkPermission(ctxFor(invitee.id, organizationId), {
          server: ['create'],
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('remove', () => {
    it('deletes an unassigned role', async () => {
      const ownerSession = await signUp(server, owner);
      const ownerCtx = ctxFor(
        ownerSession.id,
        await activeOrganizationId(server, ownerSession.cookie),
      );
      await customRoles.create(ownerCtx, {
        roleName: 'deployer',
        permissions: { auditLog: ['read'] },
      });

      await expect(customRoles.remove(ownerCtx, 'deployer')).resolves.toEqual({
        deleted: 1,
      });
      await expect(customRoles.findAll(ownerCtx)).resolves.toEqual([]);
    });

    it('refuses to delete a role members still hold', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      const ownerCtx = ctxFor(ownerSession.id, organizationId);
      await customRoles.create(ownerCtx, {
        roleName: 'deployer',
        permissions: { auditLog: ['read'] },
      });
      await assignRole(invitee.id, 'deployer');

      await expect(customRoles.remove(ownerCtx, 'deployer')).rejects.toThrow(
        'Cannot delete role "deployer": 1 member(s) are currently assigned to it. Reassign them first.',
      );
      await expect(customRoles.findAll(ownerCtx)).resolves.toHaveLength(1);
    });

    it('refuses to delete a built-in role', async () => {
      const { organizationId, owner: ownerSession } =
        await setUpOrgWithMember(server);

      await expect(
        customRoles.remove(ctxFor(ownerSession.id, organizationId), 'member'),
      ).rejects.toThrow('Cannot delete built-in roles');
    });

    it('reports a role that does not exist as missing', async () => {
      const ownerSession = await signUp(server, owner);
      const ownerCtx = ctxFor(
        ownerSession.id,
        await activeOrganizationId(server, ownerSession.cookie),
      );

      await expect(customRoles.remove(ownerCtx, 'ghost')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('leaves another organization’s role of the same name alone', async () => {
      const ownerSession = await signUp(server, owner);
      const firstCtx = ctxFor(
        ownerSession.id,
        await activeOrganizationId(server, ownerSession.cookie),
      );
      const secondCtx = ctxFor(
        ownerSession.id,
        await createOrganization(
          server,
          ctx.db,
          ownerSession.cookie,
          'Second Org',
        ),
      );

      await customRoles.create(firstCtx, {
        roleName: 'deployer',
        permissions: { auditLog: ['read'] },
      });
      await customRoles.create(secondCtx, {
        roleName: 'deployer',
        permissions: { monitoring: ['read'] },
      });

      await customRoles.remove(firstCtx, 'deployer');

      await expect(customRoles.findAll(firstCtx)).resolves.toEqual([]);
      await expect(customRoles.findAll(secondCtx)).resolves.toEqual([
        expect.objectContaining({
          role: 'deployer',
          permissions: { monitoring: ['read'] },
        }),
      ]);
    });
  });

  describe('reads open to any member', () => {
    it('lists who holds a role, with their identity', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      await customRoles.create(ctxFor(ownerSession.id, organizationId), {
        roleName: 'deployer',
        permissions: { auditLog: ['read'] },
      });
      await assignRole(invitee.id, 'deployer');

      // Any member may read the roster; it asks for no permission.
      const inviteeCtx = ctxFor(invitee.id, organizationId);
      await expect(
        customRoles.membersByRole(inviteeCtx, 'deployer'),
      ).resolves.toEqual([
        expect.objectContaining({
          userId: invitee.id,
          email: 'invitee@example.com',
        }),
      ]);
      await expect(
        customRoles.membersByRole(inviteeCtx, 'releaser'),
      ).resolves.toEqual([]);
    });

    it('exposes the access-control statements a role can be built from', () => {
      const exposed = customRoles.getStatements();

      expect(exposed.statements).toBe(statements);
      expect(exposed.statements.auditLog).toEqual(['read']);
    });
  });

  /**
   * The three constants the console used to keep its own copy of.
   *
   * `STATIC_ROLE_PERMISSIONS`, `ENTERPRISE_ONLY_RESOURCES` and
   * `INTERNAL_RESOURCES` were transcriptions of `rbac/access-control.ts` and
   * `custom-roles.service.ts` maintained by hand in
   * `frontend/src/lib/api/endpoints/roles.ts`, and they had drifted in both
   * directions: one action was missing from a role's entry, rendering as
   * "not allowed" for a caller who held it, and entries for statements
   * that no longer existed rendering nowhere and therefore reading as correct
   * forever. `use-permission.ts` answers real questions from them, so either
   * drift is a wrong answer rather than dead data.
   *
   * **The identity assertions below are the load-bearing ones**, and they are
   * why this is not a fifth copy with a test in front of it. `toBe` says the
   * response hands out *the same objects* `PermissionService.checkPermission`
   * and `validatePermissions` consult — better-auth's `role()` keeps the map it
   * was given as `.statements`, so `ownerRole.statements` is the grant map
   * `authorize` reads. There is nothing left to drift. The hand-written
   * expectations beside them are the specific drifts that happened (§1.7:
   * derived from the issues, not from the objects under test).
   */
  describe('the role vocabulary the console renders', () => {
    /** The five statements the earlier cleanups retired, hand-written (§1.7). */
    const RETIRED = [
      'projectEnvVars',
      'environmentEnvVars',
      'api',
      'envVars',
      'logs',
    ];

    it('hands out the very grant maps checkPermission authorizes against', () => {
      const { staticRoles: served } = customRoles.getStatements();

      expect(served.owner).toBe(ownerRole.statements);
      expect(served.admin).toBe(adminRole.statements);
      expect(served.member).toBe(memberRole.statements);
      // The Agent-only roles are built-in too, so the console can
      // say what an Agent's role allows from the same read.
      expect(served.agentReader).toBe(agentReaderRole.statements);
      expect(served.agentOperator).toBe(agentOperatorRole.statements);
      expect(served.agentCaller).toBe(agentCallerRole.statements);
      expect(Object.keys(served)).toEqual([
        'owner',
        'admin',
        'member',
        'agentReader',
        'agentOperator',
        'agentCaller',
      ]);
    });

    it('carries the update actions earlier changes added and later found missing', () => {
      const { staticRoles: served } = customRoles.getStatements();

      // The console showed an owner as unable to rewrite a Service and a member
      // as unable to rewrite the Environment they work in, for two releases.
      expect(served.owner.service).toContain('update');
      expect(served.owner.environment).toContain('update');
      expect(served.owner.project).toContain('update');
      expect(served.member.service).toContain('update');
      expect(served.member.environment).toContain('update');
    });

    it('withholds from the member role exactly what the static roles withhold', () => {
      const { staticRoles: served } = customRoles.getStatements();

      // The Project write was taken off the base member and the docker scoping never gave
      // them a docker action; both are answers the console renders.
      expect(served.member.project).toEqual([]);
      expect(served.member.docker).toEqual([]);
      expect(served.admin.organization).toEqual(['update']);
      expect(served.owner.organization).toEqual(['update', 'delete']);
    });

    it('names no retired statement anywhere, in any of the four fields', () => {
      const vocabulary = customRoles.getStatements();

      const named = [
        ...Object.keys(vocabulary.statements),
        ...Object.values(vocabulary.staticRoles).flatMap((grants) =>
          Object.keys(grants),
        ),
        ...vocabulary.enterpriseOnlyResources,
        ...vocabulary.internalResources,
      ];

      expect(RETIRED.filter((resource) => named.includes(resource))).toEqual(
        [],
      );
    });

    it('declares every resource it names in either annotation', () => {
      const vocabulary = customRoles.getStatements();
      const undeclared = (resources: string[]) =>
        resources.filter((resource) => !(resource in vocabulary.statements));

      expect(undeclared(vocabulary.enterpriseOnlyResources)).toEqual([]);
      expect(undeclared(vocabulary.internalResources)).toEqual([]);
      for (const [role, grants] of Object.entries(vocabulary.staticRoles)) {
        expect({ role, undeclared: undeclared(Object.keys(grants)) }).toEqual({
          role,
          undeclared: [],
        });
      }
    });

    it('marks the resources a static role is never checked on, and not the others', () => {
      const { enterpriseOnlyResources: bypassed } = customRoles.getStatements();

      // `auditLog` and `server` are bypassed for owner and admin, which is why
      // the grid has to say so; `docker`, `service` and `project` are not, and
      // the docker scoping's whole argument was that a docker check really is evaluated for
      // an owner.
      expect(bypassed).toContain('auditLog');
      expect(bypassed).toContain('server');
      expect(bypassed).not.toContain('docker');
      expect(bypassed).not.toContain('service');
      expect(bypassed).not.toContain('project');
    });

    it('names the resources a custom role is refused, and is refused them', async () => {
      const ownerSession = await signUp(server, owner);
      const ownerCtx = ctxFor(
        ownerSession.id,
        await activeOrganizationId(server, ownerSession.cookie),
      );
      const { internalResources } = customRoles.getStatements();

      expect(internalResources).toEqual([
        'organization',
        'invitation',
        'team',
        'ac',
      ]);

      // Not just a list: each of them really is refused, so the builder that
      // disables these rows is describing the refusal rather than inventing it.
      for (const resource of internalResources) {
        await expect(
          customRoles.create(ownerCtx, {
            roleName: `probe-${resource}`,
            permissions: { [resource]: ['read'] },
          }),
        ).rejects.toThrow('managed internally');
      }
    });

    it('serves all four fields over HTTP to a plain member', async () => {
      const { invitee } = await setUpOrgWithMember(server);

      const res = await request(server)
        .get('/custom-roles/statements')
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(200);
      const body = res.body as {
        statements: Record<string, string[]>;
        staticRoles: Record<string, Record<string, string[]>>;
        enterpriseOnlyResources: string[];
        internalResources: string[];
      };
      expect(body.statements.auditLog).toEqual(['read']);
      expect(body.staticRoles.member.service).toEqual(['read', 'update']);
      expect(body.staticRoles.owner.organization).toEqual(['update', 'delete']);
      expect(body.enterpriseOnlyResources).toContain('auditLog');
      expect(body.internalResources).toContain('ac');
    });
  });

  describe('assignment to members', () => {
    it('hands a member the role’s grants once it is assigned', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      await customRoles.create(ctxFor(ownerSession.id, organizationId), {
        roleName: 'deployer',
        permissions: { project: ['create'] },
      });
      const inviteeCtx = ctxFor(invitee.id, organizationId);
      await expect(
        permissions.checkPermission(inviteeCtx, { project: ['create'] }),
      ).rejects.toThrow(ForbiddenException);

      const assigned = await request(server)
        .patch(`/organizations/members/${await memberId(invitee.id)}`)
        .set('Cookie', ownerSession.cookie)
        .send({ role: 'deployer' });
      expect(assigned.status).toBe(200);

      await expect(
        permissions.checkPermission(inviteeCtx, { project: ['create'] }),
      ).resolves.toBeUndefined();
      await expect(
        customRoles.membersByRole(inviteeCtx, 'deployer'),
      ).resolves.toHaveLength(1);
    });

    it('refuses a role name the organization has not defined', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);

      const res = await request(server)
        .patch(`/organizations/members/${await memberId(invitee.id)}`)
        .set('Cookie', ownerSession.cookie)
        .send({ role: 'ghost' });

      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        'Custom role "ghost" not found',
      );
    });

    it('still refuses to hand over the owner role', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);

      const res = await request(server)
        .patch(`/organizations/members/${await memberId(invitee.id)}`)
        .set('Cookie', ownerSession.cookie)
        .send({ role: 'owner' });

      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toBe(
        'The owner role is nontransferable',
      );
    });

    /**
     * A comma-named row written before `roleNameSchema` refused one is
     * never newly handed out — better-auth, which the member, invitation and
     * team routes delegate to, would read `x,owner` as an owner.
     */
    it('refuses a comma-named legacy role for a role change and for an invitation', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'x,owner',
        permission: { auditLog: ['read'] },
      });

      const changed = await request(server)
        .patch(`/organizations/members/${await memberId(invitee.id)}`)
        .set('Cookie', ownerSession.cookie)
        .send({ role: 'x,owner' });
      expect(changed.status).toBe(400);
      expect((changed.body as { message: string }).message).toBe(
        'A role name cannot contain a comma',
      );
      const [row] = await ctx.db
        .select({ role: member.role })
        .from(member)
        .where(eq(member.userId, invitee.id));
      expect(row.role).toBe('member');

      const invited = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', ownerSession.cookie)
        .send({ email: 'someone@example.com', role: 'x,owner' });
      expect(invited.status).toBe(400);
      expect((invited.body as { message: string }).message).toBe(
        'A role name cannot contain a comma',
      );
      expect(
        await ctx.db
          .select()
          .from(invitation)
          .where(eq(invitation.email, 'someone@example.com')),
      ).toEqual([]);
    });
  });

  describe('HTTP surface', () => {
    it('defines, renames and deletes a role over the API', async () => {
      const { owner: ownerSession } = await setUpOrgWithMember(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/custom-roles')
        .set('Cookie', cookie)
        .send({ roleName: 'deployer', permissions: { auditLog: ['read'] } });
      expect(created.status).toBe(201);
      expect(created.body).toEqual(
        expect.objectContaining({
          role: 'deployer',
          permission: { auditLog: ['read'] },
        }),
      );

      const listed = await request(server)
        .get('/custom-roles')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([
        expect.objectContaining({ role: 'deployer', memberCount: 0 }),
      ]);

      const renamed = await request(server)
        .patch('/custom-roles/deployer')
        .set('Cookie', cookie)
        .send({
          newRoleName: 'releaser',
          permissions: { auditLog: ['read'], monitoring: ['read'] },
        });
      expect(renamed.status).toBe(200);
      expect((renamed.body as { role: string }).role).toBe('releaser');

      const removed = await request(server)
        .delete('/custom-roles/releaser')
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);
      expect(removed.body).toEqual({ deleted: 1 });
    });

    it('serves the statements catalogue and role roster to a member', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      await request(server)
        .post('/custom-roles')
        .set('Cookie', ownerSession.cookie)
        .send({ roleName: 'deployer', permissions: { auditLog: ['read'] } });

      const catalogue = await request(server)
        .get('/custom-roles/statements')
        .set('Cookie', invitee.cookie);
      expect(catalogue.status).toBe(200);
      // `statements` is a field on the response rather than the response since
      // an earlier change; what this case is about is that a plain member is answered at
      // all, and the four fields are asserted in that issue's own block above.
      expect(
        (catalogue.body as { statements: Record<string, string[]> }).statements
          .auditLog,
      ).toEqual(['read']);

      const roster = await request(server)
        .get('/custom-roles/deployer/members')
        .set('Cookie', invitee.cookie);
      expect(roster.status).toBe(200);
      expect(roster.body).toEqual([]);
    });

    it('refuses mutations from a member and from an unlicensed organization', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);

      const asMember = await request(server)
        .post('/custom-roles')
        .set('Cookie', invitee.cookie)
        .send({ roleName: 'deployer', permissions: { auditLog: ['read'] } });
      expect(asMember.status).toBe(403);

      license.hasValidLicense.mockResolvedValue(false);
      const unlicensed = await request(server)
        .post('/custom-roles')
        .set('Cookie', ownerSession.cookie)
        .send({ roleName: 'deployer', permissions: { auditLog: ['read'] } });
      expect(unlicensed.status).toBe(403);

      // Reads stay open — the listing asks for neither a licence nor a
      // permission.
      const listed = await request(server)
        .get('/custom-roles')
        .set('Cookie', invitee.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([]);
    });

    it('lets an owner delete a kept role without a valid license, and a member not', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      await request(server)
        .post('/custom-roles')
        .set('Cookie', ownerSession.cookie)
        .send({ roleName: 'deployer', permissions: { auditLog: ['read'] } })
        .expect(201);

      license.hasValidLicense.mockResolvedValue(false);
      const asMember = await request(server)
        .delete('/custom-roles/deployer')
        .set('Cookie', invitee.cookie);
      expect(asMember.status).toBe(403);

      const removed = await request(server)
        .delete('/custom-roles/deployer')
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);
      expect(removed.body).toEqual({ deleted: 1 });
    });

    it('rejects malformed role definitions', async () => {
      const { owner: ownerSession } = await setUpOrgWithMember(server);
      const cookie = ownerSession.cookie;

      for (const body of [
        { roleName: 'admin', permissions: { auditLog: ['read'] } },
        { roleName: '', permissions: { auditLog: ['read'] } },
        { roleName: 'deployer' },
        { roleName: 'deployer', permissions: { auditLog: 'read' } },
      ]) {
        const res = await request(server)
          .post('/custom-roles')
          .set('Cookie', cookie)
          .send(body);
        expect(res.status).toBe(400);
      }
    });

    it('requires authentication', async () => {
      const res = await request(server).get('/custom-roles');
      expect(res.status).toBe(401);
    });
  });

  describe('PermissionsGuard', () => {
    it('lets a custom role through a @RequirePermission route', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);

      const denied = await request(server)
        .post('/custom-role-probe/projects')
        .set('Cookie', invitee.cookie);
      expect(denied.status).toBe(403);

      await customRoles.create(ctxFor(ownerSession.id, organizationId), {
        roleName: 'deployer',
        permissions: { project: ['create'] },
      });
      await assignRole(invitee.id, 'deployer');

      const allowed = await request(server)
        .post('/custom-role-probe/projects')
        .set('Cookie', invitee.cookie);
      expect(allowed.status).toBe(201);
      expect(allowed.body).toEqual({ ok: true });
    });
  });

  describe('audit trail', () => {
    it('records the role lifecycle against the acting owner', async () => {
      const ownerSession = await signUp(server, owner);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const ownerCtx = ctxFor(ownerSession.id, organizationId);

      await customRoles.create(
        ownerCtx,
        { roleName: 'deployer', permissions: { auditLog: ['read'] } },
        '10.0.0.7',
      );
      await customRoles.update(ownerCtx, {
        roleName: 'deployer',
        newRoleName: 'releaser',
        permissions: { auditLog: ['read'] },
      });
      await customRoles.remove(ownerCtx, 'releaser');

      const { logs } = await auditLogs.findAll(organizationId, {
        resourceType: 'customRole',
      });
      expect(
        logs.map((entry) => ({
          action: entry.action,
          resourceName: entry.resourceName,
          userEmail: entry.userEmail,
          userRole: entry.userRole,
          ip: entry.ip,
        })),
      ).toEqual([
        {
          action: 'delete',
          resourceName: 'releaser',
          userEmail: owner.email,
          userRole: 'owner',
          ip: null,
        },
        {
          action: 'update',
          resourceName: 'releaser',
          userEmail: owner.email,
          userRole: 'owner',
          ip: null,
        },
        {
          action: 'create',
          resourceName: 'deployer',
          userEmail: owner.email,
          userRole: 'owner',
          ip: '10.0.0.7',
        },
      ]);
    });
  });
});
