import { Controller, ForbiddenException, Logger, Post } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { ac } from '../../src/rbac/access-control';
import {
  environment as environmentTable,
  licenseKey,
  member,
  mount,
  organizationRole,
  port,
  redirect,
  security,
} from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RequirePermission } from '../../src/rbac/decorators/require-permission.decorator';
import { PermissionService } from '../../src/rbac/permission.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

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

/** Owner org plus one accepted member (role 'member') — same fixture as the organizations spec. */
async function setUpOrgWithMember(server: App) {
  const ownerSession = await signUp(server, owner);

  const orgs = await request(server)
    .get('/organizations')
    .set('Cookie', ownerSession.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;

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

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/** Guard probe: a route protected the way feature controllers will protect theirs. */
@Controller('rbac-probe')
class RbacProbeController {
  @Post('projects')
  @RequirePermission('project', 'create')
  createProject() {
    return { ok: true };
  }
}

describe('RBAC (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let permissions: PermissionService;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;

  beforeAll(async () => {
    ctx = await createTestApp({ controllers: [RbacProbeController] });
    server = ctx.app.getHttpServer() as App;
    permissions = ctx.app.get(PermissionService);
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  describe('PermissionService.checkPermission', () => {
    it('owner passes static-role checks', async () => {
      const { organizationId, owner: ownerSession } =
        await setUpOrgWithMember(server);

      await expect(
        permissions.checkPermission(
          permissionCtx(ownerSession.id, organizationId),
          { project: ['create', 'delete'], organization: ['delete'] },
        ),
      ).resolves.toBeUndefined();
    });

    it('member is denied a resource not granted to the member role', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);

      await expect(
        permissions.checkPermission(permissionCtx(invitee.id, organizationId), {
          project: ['create'],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('member passes a check the member role grants', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);

      await expect(
        permissions.checkPermission(permissionCtx(invitee.id, organizationId), {
          service: ['read'],
          environment: ['read'],
        }),
      ).resolves.toBeUndefined();
    });

    it('owner and admin bypass enterprise-only resource checks', async () => {
      const { organizationId, owner: ownerSession } =
        await setUpOrgWithMember(server);

      await expect(
        permissions.checkPermission(
          permissionCtx(ownerSession.id, organizationId),
          { server: ['create'], registry: ['read'] },
        ),
      ).resolves.toBeUndefined();
    });

    it('a custom (non-static) role is denied without an enterprise license', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);

      await ctx.db
        .update(member)
        .set({ role: 'deployer' })
        .where(eq(member.userId, invitee.id));

      await expect(
        permissions.checkPermission(permissionCtx(invitee.id, organizationId), {
          service: ['read'],
        }),
      ).rejects.toThrow('valid enterprise license');
    });

    /**
     * `docker` had one action and `containerOp` gated `stop`, `kill`,
     * `start`, `restart` and `docker rm -f` on it, so a **read** statement
     * authorized five destructive verbs. `docker: ['write']` is what they
     * require now — and so does `uploadFileToContainer`, the
     * `docker cp` route first scoped out and left on `read`. These assertions are
     * about the action at the `checkPermission` seam, so the sixth verb needed
     * nothing added here; `test/docker-ops/docker-ops.e2e-spec.ts` is where the
     * upload's own gate is pinned.
     *
     * Driven through `checkPermission` rather than off the role objects
     * (`test/rbac/access-control.spec.ts` has that half) because the thing worth
     * pinning here is the *service's* answer: `docker` is not in
     * `enterpriseOnlyResources`, so the owner/admin bypass never fires for it
     * and both static roles are answered by `role.authorize`. An owner refused
     * their own console's Stop button is how forgetting that would ship.
     */
    describe("the docker resource's write action", () => {
      async function grantCustomRole(
        organizationId: string,
        userId: string,
        permission: Record<string, string[]>,
      ) {
        await ctx.db.insert(licenseKey).values({
          organizationId,
          key: 'test-license-key',
          status: 'active',
          enableEnterpriseFeatures: true,
        });
        await ctx.db
          .insert(organizationRole)
          .values({ organizationId, role: 'container-operator', permission });
        await ctx.db
          .update(member)
          .set({ role: 'container-operator' })
          .where(eq(member.userId, userId));
      }

      it('allows an owner, whose role is authorized rather than bypassed', async () => {
        const { organizationId, owner: ownerSession } =
          await setUpOrgWithMember(server);

        await expect(
          permissions.checkPermission(
            permissionCtx(ownerSession.id, organizationId),
            { docker: ['read', 'write'] },
          ),
        ).resolves.toBeUndefined();
      });

      it('allows an admin, whose role is authorized rather than bypassed', async () => {
        const { organizationId, invitee } = await setUpOrgWithMember(server);
        await ctx.db
          .update(member)
          .set({ role: 'admin' })
          .where(eq(member.userId, invitee.id));

        await expect(
          permissions.checkPermission(
            permissionCtx(invitee.id, organizationId),
            { docker: ['read', 'write'] },
          ),
        ).resolves.toBeUndefined();
      });

      it('refuses a licensed custom role holding docker read alone', async () => {
        const { organizationId, invitee } = await setUpOrgWithMember(server);
        await grantCustomRole(organizationId, invitee.id, {
          docker: ['read'],
        });

        await expect(
          permissions.checkPermission(
            permissionCtx(invitee.id, organizationId),
            { docker: ['write'] },
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('still allows that role the read half it does hold', async () => {
        const { organizationId, invitee } = await setUpOrgWithMember(server);
        await grantCustomRole(organizationId, invitee.id, {
          docker: ['read'],
        });

        await expect(
          permissions.checkPermission(
            permissionCtx(invitee.id, organizationId),
            { docker: ['read'] },
          ),
        ).resolves.toBeUndefined();
      });

      it('allows a licensed custom role holding docker read and write', async () => {
        const { organizationId, invitee } = await setUpOrgWithMember(server);
        await grantCustomRole(organizationId, invitee.id, {
          docker: ['read', 'write'],
        });

        await expect(
          permissions.checkPermission(
            permissionCtx(invitee.id, organizationId),
            { docker: ['read', 'write'] },
          ),
        ).resolves.toBeUndefined();
      });
    });

    it('a user with no membership in the organization is denied', async () => {
      const { owner: ownerSession } = await setUpOrgWithMember(server);

      await expect(
        permissions.checkPermission(
          permissionCtx(ownerSession.id, 'no-such-org'),
          { service: ['read'] },
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('row-level access (accessedProjects)', () => {
    it('a member with the project in accessedProjects passes checkProjectAccess', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);

      await ctx.db
        .update(member)
        .set({ accessedProjects: ['proj-1'] })
        .where(eq(member.userId, invitee.id));

      await expect(
        permissions.checkProjectAccess(
          permissionCtx(invitee.id, organizationId),
          'read',
          'proj-1',
        ),
      ).resolves.toBeUndefined();
    });

    it('a member without the project in accessedProjects is denied', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);

      await expect(
        permissions.checkProjectAccess(
          permissionCtx(invitee.id, organizationId),
          'read',
          'proj-1',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('owner and admin skip the row-level check', async () => {
      const { organizationId, owner: ownerSession } =
        await setUpOrgWithMember(server);

      await expect(
        permissions.checkProjectAccess(
          permissionCtx(ownerSession.id, organizationId),
          'delete',
          'proj-never-granted',
        ),
      ).resolves.toBeUndefined();
    });

    it('a member is still denied project:delete even with row-level access', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);

      await ctx.db
        .update(member)
        .set({ accessedProjects: ['proj-1'] })
        .where(eq(member.userId, invitee.id));

      await expect(
        permissions.checkProjectAccess(
          permissionCtx(invitee.id, organizationId),
          'delete',
          'proj-1',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('row-level access (accessedServices / accessedEnvironments)', () => {
    it('a member sees only services granted in accessedServices', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);

      await ctx.db
        .update(member)
        .set({ accessedServices: ['svc-1'] })
        .where(eq(member.userId, invitee.id));

      const inviteeCtx = permissionCtx(invitee.id, organizationId);
      await expect(
        permissions.checkServiceAccess(inviteeCtx, 'svc-1', 'read'),
      ).resolves.toBeUndefined();
      await expect(
        permissions.checkServiceAccess(inviteeCtx, 'svc-2', 'read'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('a member sees only environments granted in accessedEnvironments', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);

      await ctx.db
        .update(member)
        .set({ accessedEnvironments: ['env-1'] })
        .where(eq(member.userId, invitee.id));

      const inviteeCtx = permissionCtx(invitee.id, organizationId);
      await expect(
        permissions.checkEnvironmentAccess(inviteeCtx, 'env-1', 'read'),
      ).resolves.toBeUndefined();
      await expect(
        permissions.checkEnvironmentAccess(inviteeCtx, 'env-2', 'read'),
      ).rejects.toThrow(ForbiddenException);
    });

    /**
     * The refusing direction above was the only one there was:
     * `addNewService` is grant-on-create and `memberRole` has no
     * `service: create`, so nothing could put an id in the column for anybody
     * but the creator. `setMemberEntitlements` is the writer that was missing,
     * and the ids have to be real because it refuses one this Organization does
     * not own.
     */
    describe('granting a member a service', () => {
      async function setUpTwoServices(ownerId: string, organizationId: string) {
        const ownerCtx = permissionCtx(ownerId, organizationId);
        const project = await projects.create(ownerCtx, { name: 'cloudgate' });
        const environment = await environments.create(ownerCtx, {
          name: 'production',
          projectId: project.projectId,
        });
        const granted = await applications.create(ownerCtx, {
          name: 'Granted',
          appName: 'granted-app',
          environmentId: environment.environmentId,
        });
        const withheld = await applications.create(ownerCtx, {
          name: 'Withheld',
          appName: 'withheld-app',
          environmentId: environment.environmentId,
        });
        return { granted, withheld };
      }

      it('lets a granted member read a service it could not read before', async () => {
        const {
          organizationId,
          owner: ownerSession,
          invitee,
        } = await setUpOrgWithMember(server);
        const { granted } = await setUpTwoServices(
          ownerSession.id,
          organizationId,
        );
        const inviteeCtx = permissionCtx(invitee.id, organizationId);
        const [row] = await ctx.db
          .select()
          .from(member)
          .where(eq(member.userId, invitee.id));

        await expect(
          permissions.checkServiceAccess(
            inviteeCtx,
            granted.applicationId,
            'read',
          ),
        ).rejects.toThrow(ForbiddenException);

        await permissions.setMemberEntitlements(organizationId, row.id, {
          accessedServices: [granted.applicationId],
        });

        await expect(
          permissions.checkServiceAccess(
            inviteeCtx,
            granted.applicationId,
            'read',
          ),
        ).resolves.toBeUndefined();
      });

      it('still refuses the same member every service it was not granted', async () => {
        const {
          organizationId,
          owner: ownerSession,
          invitee,
        } = await setUpOrgWithMember(server);
        const { granted, withheld } = await setUpTwoServices(
          ownerSession.id,
          organizationId,
        );
        const [row] = await ctx.db
          .select()
          .from(member)
          .where(eq(member.userId, invitee.id));

        await permissions.setMemberEntitlements(organizationId, row.id, {
          accessedServices: [granted.applicationId],
        });

        await expect(
          permissions.checkServiceAccess(
            permissionCtx(invitee.id, organizationId),
            withheld.applicationId,
            'read',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('clears a grant when the array is sent empty', async () => {
        const {
          organizationId,
          owner: ownerSession,
          invitee,
        } = await setUpOrgWithMember(server);
        const { granted } = await setUpTwoServices(
          ownerSession.id,
          organizationId,
        );
        const [row] = await ctx.db
          .select()
          .from(member)
          .where(eq(member.userId, invitee.id));
        const inviteeCtx = permissionCtx(invitee.id, organizationId);

        await permissions.setMemberEntitlements(organizationId, row.id, {
          accessedServices: [granted.applicationId],
        });
        const cleared = await permissions.setMemberEntitlements(
          organizationId,
          row.id,
          { accessedServices: [] },
        );

        expect(cleared.accessedServices).toEqual([]);
        await expect(
          permissions.checkServiceAccess(
            inviteeCtx,
            granted.applicationId,
            'read',
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('refuses a service id this organization does not own', async () => {
        const { organizationId, invitee } = await setUpOrgWithMember(server);
        const [row] = await ctx.db
          .select()
          .from(member)
          .where(eq(member.userId, invitee.id));

        await expect(
          permissions.setMemberEntitlements(organizationId, row.id, {
            accessedServices: ['svc-nowhere'],
          }),
        ).rejects.toThrow('Service not found: svc-nowhere');

        // Nothing was granted on the way to being refused.
        const [after] = await ctx.db
          .select()
          .from(member)
          .where(eq(member.id, row.id));
        expect(after.accessedServices).toEqual([]);
      });
    });

    it('addNewProject/Service/Environment grant the caller row-level access', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      await permissions.addNewProject(inviteeCtx, 'proj-9');
      await permissions.addNewService(inviteeCtx, 'svc-9');
      await permissions.addNewEnvironment(inviteeCtx, 'env-9');

      await expect(
        permissions.checkProjectAccess(inviteeCtx, 'read', 'proj-9'),
      ).resolves.toBeUndefined();
      await expect(
        permissions.checkServiceAccess(inviteeCtx, 'svc-9', 'read'),
      ).resolves.toBeUndefined();
      await expect(
        permissions.checkEnvironmentAccess(inviteeCtx, 'env-9', 'read'),
      ).resolves.toBeUndefined();
    });

    // One case per column, because grantAccess interpolates the column name and
    // a statement that appends to the wrong array would still pass a
    // single-column test.
    describe.each([
      ['accessedProjects' as const, 'addNewProject' as const, 'proj'],
      ['accessedServices' as const, 'addNewService' as const, 'svc'],
      ['accessedEnvironments' as const, 'addNewEnvironment' as const, 'env'],
    ])('two concurrent grants into %s', (column, grant, prefix) => {
      it('keep both ids — neither create loses its grant', async () => {
        const { organizationId, invitee } = await setUpOrgWithMember(server);
        const inviteeCtx = permissionCtx(invitee.id, organizationId);
        const [a, b] = [`${prefix}-race-a`, `${prefix}-race-b`];

        // Genuinely concurrent, not sequential: both calls read the member row
        // before either writes, which is exactly the interleaving that made a
        // read-modify-write drop one of the two ids.
        await Promise.all([
          permissions[grant](inviteeCtx, a),
          permissions[grant](inviteeCtx, b),
        ]);

        const [row] = await ctx.db
          .select()
          .from(member)
          .where(eq(member.userId, invitee.id));
        expect(row[column]).toEqual(expect.arrayContaining([a, b]));
      });
    });
  });

  /**
   * A member refused a Service for want of a Manage access grant
   * was told their *role* was the problem, because every 403 reached the
   * console as the same uncoded refusal and the console had one sentence for
   * it. The row-level branch now names itself with a code; the role's refusal
   * and a caller with no member row at all keep the bodies they had.
   */
  describe('which refusal a 403 names', () => {
    async function setUpWithheldTree() {
      const fixture = await setUpOrgWithMember(server);
      const ownerCtx = permissionCtx(fixture.owner.id, fixture.organizationId);
      const project = await projects.create(ownerCtx, { name: 'cloudgate' });
      const environment = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const application = await applications.create(ownerCtx, {
        name: 'Withheld',
        appName: 'withheld-app',
        environmentId: environment.environmentId,
      });
      return { ...fixture, project, environment, application };
    }

    it('names a missing grant on a Service, an Environment and a Project, each by its own code', async () => {
      const { invitee, project, environment, application } =
        await setUpWithheldTree();

      const refusals = await Promise.all(
        [
          `/applications/${application.applicationId}`,
          `/environments/${environment.environmentId}`,
          `/projects/${project.projectId}`,
        ].map((path) =>
          request(server).get(path).set('Cookie', invitee.cookie),
        ),
      );

      expect(
        refusals.map((res) => [
          res.status,
          (res.body as { code?: string }).code,
        ]),
      ).toEqual([
        [403, 'SERVICE_ACCESS_NOT_GRANTED'],
        [403, 'ENVIRONMENT_ACCESS_NOT_GRANTED'],
        [403, 'PROJECT_ACCESS_NOT_GRANTED'],
      ]);
      // The message the journal and the existing unit specs read is unchanged.
      expect((refusals[0].body as { message: string }).message).toBe(
        "You don't have access to this service",
      );
    });

    it("leaves the role's own refusal uncoded", async () => {
      const { invitee } = await setUpOrgWithMember(server);

      const res = await request(server)
        .post('/rbac-probe/projects')
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(403);
      expect(res.body).not.toHaveProperty('code');
    });

    it('does not call a caller with no member row a missing grant', async () => {
      const { invitee, application } = await setUpWithheldTree();
      await ctx.db.delete(member).where(eq(member.userId, invitee.id));

      const res = await request(server)
        .get(`/applications/${application.applicationId}`)
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(403);
      expect((res.body as { code?: string }).code ?? '').not.toMatch(
        /ACCESS_NOT_GRANTED/,
      );
    });

    /**
     * A member removed while signed in keeps a session pointed at
     * the Organization, and every route refused them with the uncoded 403 the
     * console reads as a role problem — so it told them to ask for a role
     * change in an Organization they were no longer in. The refusal names the
     * fact with the code better-auth already uses for it on its own routes, so
     * the console learns one code for one fact, whichever surface refused.
     */
    it('names a caller with no member row as not a member', async () => {
      const { invitee, application } = await setUpWithheldTree();
      await ctx.db.delete(member).where(eq(member.userId, invitee.id));

      const refusals = await Promise.all(
        [`/applications/${application.applicationId}`, '/projects'].map(
          (path) => request(server).get(path).set('Cookie', invitee.cookie),
        ),
      );

      expect(
        refusals.map((res) => [
          res.status,
          (res.body as { code?: string }).code,
        ]),
      ).toEqual([
        [403, 'YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION'],
        [403, 'YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION'],
      ]);
    });
  });

  describe('PermissionsGuard + @RequirePermission', () => {
    it('returns 403 for a member on a route requiring project:create', async () => {
      const { invitee } = await setUpOrgWithMember(server);

      const res = await request(server)
        .post('/rbac-probe/projects')
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(403);
    });

    it('lets the owner through', async () => {
      const { owner: ownerSession } = await setUpOrgWithMember(server);

      const res = await request(server)
        .post('/rbac-probe/projects')
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });
    });

    it('still requires authentication', async () => {
      const res = await request(server).post('/rbac-probe/projects');
      expect(res.status).toBe(401);
    });
  });

  /**
   * Driven on a real guarded route. A custom role granting
   * `certificate: read` on an instance with zero rows in `license_key` used to
   * answer `Invalid role` — the role did not resolve at all, so the grant was
   * refused along with everything else. The plain `member` role is the
   * comparison: it reaches the same 403 for the honest reason, because
   * `memberRole` grants nothing on `certificate`.
   *
   * The role row is inserted directly rather than through
   * `CustomRolesService.create`, which is license-gated: this is the state an
   * Organization is left in when its license lapses, since nothing deletes the
   * `organization_role` rows.
   */
  describe('a custom role on an unlicensed instance', () => {
    async function defineReadOnlyRole(organizationId: string) {
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'read-only',
        permission: {
          service: ['read'],
          environment: ['read'],
          certificate: ['read'],
        },
      });
    }

    it('refuses a plain member the resource their role does not grant', async () => {
      const { invitee } = await setUpOrgWithMember(server);

      const res = await request(server)
        .get('/certificates')
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toContain(
        'unauthorized to access resource "certificate"',
      );
    });

    it('tells a member on an unresolvable custom role that the license is what is missing', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);
      // The premise of the matrix: nothing has ever licensed this instance.
      expect(await ctx.db.select().from(licenseKey)).toEqual([]);

      await defineReadOnlyRole(organizationId);
      await ctx.db
        .update(member)
        .set({ role: 'read-only' })
        .where(eq(member.userId, invitee.id));

      const res = await request(server)
        .get('/certificates')
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(403);
      const { message } = res.body as { message: string };
      expect(message).not.toBe('Invalid role');
      expect(message).toContain('read-only');
      expect(message).toContain('valid enterprise license');
    });

    it('still calls an unknown role invalid — no row carries it, licensed or not', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });

      await ctx.db
        .update(member)
        .set({ role: 'never-defined' })
        .where(eq(member.userId, invitee.id));

      const res = await request(server)
        .get('/certificates')
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toBe('Invalid role');
    });
  });
  /**
   * The `service: ['update']` level, over HTTP and per module. `service`
   * carried no `update`, so `PermissionService.checkServiceAccess` defaulted to
   * `'read'` at every write that consulted it — and `PATCH /applications/:id`,
   * `PATCH /compose/:id` and the `PATCH /{engine}/:id` family carry no
   * `@RequirePermission` at all, so that default was their only gate. Eighteen
   * routes on which `service: ['read']` authorized a wholesale rewrite of a
   * Service's definition.
   *
   * **One suite rather than eight.** The triage asks for this per module, and
   * it is per module — every assertion below is an HTTP request to a different
   * module's real route, and `createTestApp` builds the whole `AppModule`, so
   * the guard, the DTO and the service all run. What it is not is spread across
   * `applications.e2e-spec.ts`, `compose.e2e-spec.ts`, the six engine suites
   * and the four child-row suites, because each of those is ~1 GB and a
   * container (`docs/testing.md`) and the property under test is
   * one property. Their own suites still cover the modules; this covers the
   * action.
   *
   * **The fixtures are designed so that the action is the only variable.** A
   * custom role is given every grant `memberRole` holds *except* `service`, and
   * then the `service` array alone is changed between the two. So a refusal
   * below cannot be explained by a missing `volume:create` or `deployment:
   * create`, which is what would happen if the fixture were simply
   * `{ service: ['read'] }`.
   *
   * **The action covers definition writes and not lifecycle verbs**, and the
   * last test here is what pins that rather than leaving it to a docblock.
   * `start`, `stop`, `reload`, `deploy`, `changeStatus`, `rebuild` and
   * `removeContainers` keep `checkServiceAccess(…, 'read')` and their own
   * `deployment: ['create']`, because a custom role granted the lifecycle
   * statement so it may run a stack it may not redefine *is* the level this
   * exists to make expressible — requiring `update` to operate a service would
   * have made it unsayable in the act of creating it.
   *
   * Two routes in the set have no assertion here, both for the same reason —
   * the allowed direction needs a double this suite does not install, and the
   * gate they run is byte-identical to one asserted below:
   * `POST /applications/:id/drop` takes a multipart zip, and
   * `POST /{engine}/:id/external-port` converges the swarm service through
   * `deployInternal`. Both run
   * {@link ApplicationsService.findOwnedForUpdate}'s and
   * `BaseDatabaseService.findOwnedForUpdate`'s single
   * `checkServiceAccess(…, 'update')`.
   */
  describe("the service resource's update action", () => {
    /**
     * `memberRole`'s grants minus `service`, written out because a custom role
     * stores a plain JSON object and nothing in `access-control.ts` exposes a
     * static role's grants for a test to read. Kept in the same order as
     * `memberRole` so the two can be diffed by eye; `access-control.spec.ts`
     * asserts the static role's own half.
     *
     * `projectEnvVars` and `environmentEnvVars` were in this list and are gone
     * with the statements themselves — nothing consulted either, so they never
     * contributed to any refusal asserted here. The env writes they looked like
     * they gated are `project: ['update']` and `environment: ['update']`,
     * exercised in the project and environment block below.
     *
     * `envVars` and `logs` went the same way later, and `envVars` is the one
     * worth naming here: this fixture's whole subject is the eight
     * `PATCH /{engine}/:id/environment` twins among the eighteen routes, and
     * `envVars: ['read', 'write']` sat in the grant map reading as if it were
     * what let the invitee through them. It was not — nothing consulted it —
     * so the refusals below were always `service`'s and now say so with nothing
     * beside them to be confused for the gate.
     */
    const MEMBER_GRANTS_EXCEPT_SERVICE: Record<string, string[]> = {
      ac: ['read'],
      // `['read', 'update']` since the base member was given the Environment
      // write it already had; kept in step so this really is `memberRole`
      // minus `service`. Nothing in this set consults an environment action.
      environment: ['read', 'update'],
      volume: ['read', 'create', 'delete'],
      deployment: ['read', 'create', 'cancel'],
      backup: ['read', 'create', 'update', 'delete', 'restore'],
      volumeBackup: ['read', 'create', 'update', 'delete', 'restore'],
      schedule: ['read', 'create', 'update', 'delete'],
      domain: ['read', 'create', 'delete'],
      monitoring: ['read'],
      tag: ['read'],
    };

    /**
     * One Application, one compose stack, one Postgres, and one child row of
     * each kind hanging off the Application — with the invitee entitled to all
     * three services.
     *
     * The child rows are inserted rather than posted. `RedirectsService` and
     * `SecurityService` regenerate the Application's Traefik file on every
     * write and this suite installs no exec double, and what is under test is
     * the gate, which runs before any of that. The three Services go through
     * their real create routes, because those already require
     * `service: ['create']` and the fixture has to be built by somebody who
     * holds it.
     */
    async function setUpEntitledMember() {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const project = await projects.create(ownerCtx, { name: 'cloudgate' });
      const environment = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const application = await applications.create(ownerCtx, {
        name: 'Shop',
        appName: 'shop-app',
        environmentId: environment.environmentId,
      });

      const composeRes = await request(server)
        .post('/compose')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'blog',
          appName: 'blog-stack',
          environmentId: environment.environmentId,
        });
      expect(composeRes.status).toBe(201);
      const { composeId } = composeRes.body as { composeId: string };

      const postgresRes = await request(server)
        .post('/postgres')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          appName: 'main-db',
          databaseName: 'shop',
          databaseUser: 'shop_user',
          databasePassword: 'sup3rS3cret',
          environmentId: environment.environmentId,
        });
      expect(postgresRes.status).toBe(201);
      const { postgresId } = postgresRes.body as { postgresId: string };

      const [portRow] = await ctx.db
        .insert(port)
        .values({
          applicationId: application.applicationId,
          publishedPort: 8080,
          targetPort: 3000,
          protocol: 'tcp',
        })
        .returning();
      const [redirectRow] = await ctx.db
        .insert(redirect)
        .values({
          applicationId: application.applicationId,
          regex: '^/old',
          replacement: '/new',
        })
        .returning();
      const [securityRow] = await ctx.db
        .insert(security)
        .values({
          applicationId: application.applicationId,
          username: 'ada',
          password: 'hunter2',
        })
        .returning();
      const [mountRow] = await ctx.db
        .insert(mount)
        .values({
          type: 'volume',
          volumeName: 'shop-data',
          mountPath: '/data',
          serviceType: 'application',
          applicationId: application.applicationId,
        })
        .returning();

      const [memberRow] = await ctx.db
        .select()
        .from(member)
        .where(eq(member.userId, invitee.id));
      await permissions.setMemberEntitlements(organizationId, memberRow.id, {
        accessedProjects: [project.projectId],
        accessedEnvironments: [environment.environmentId],
        accessedServices: [application.applicationId, composeId, postgresId],
      });

      return {
        organizationId,
        ownerSession,
        invitee,
        applicationId: application.applicationId,
        composeId,
        postgresId,
        portId: portRow.portId,
        redirectId: redirectRow.redirectId,
        securityId: securityRow.securityId,
        mountId: mountRow.mountId,
      };
    }

    /** Moves the invitee onto a licensed custom role holding `serviceActions`. */
    async function assignServiceRole(
      organizationId: string,
      userId: string,
      serviceActions: string[],
    ) {
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'service-operator',
        permission: {
          ...MEMBER_GRANTS_EXCEPT_SERVICE,
          service: serviceActions,
        },
      });
      await ctx.db
        .update(member)
        .set({ role: 'service-operator' })
        .where(eq(member.userId, userId));
    }

    /**
     * Every mutation in the set, as one request each, so a single `it` can
     * say "all of these are refused" or "all of these are allowed" and the
     * failure names the route rather than a boolean.
     */
    const mutations = (fixture: {
      applicationId: string;
      composeId: string;
      postgresId: string;
      portId: string;
      redirectId: string;
      securityId: string;
      mountId: string;
    }) => [
      {
        route: 'PATCH /applications/{id}',
        send: (cookie: string) =>
          request(server)
            .patch(`/applications/${fixture.applicationId}`)
            .set('Cookie', cookie)
            .send({ name: 'Renamed' }),
      },
      {
        route: 'PATCH /applications/{id}/environment',
        send: (cookie: string) =>
          request(server)
            .patch(`/applications/${fixture.applicationId}/environment`)
            .set('Cookie', cookie)
            .send({ env: 'A=1' }),
      },
      {
        route: 'POST /applications/{id}/refresh-token',
        send: (cookie: string) =>
          request(server)
            .post(`/applications/${fixture.applicationId}/refresh-token`)
            .set('Cookie', cookie),
      },
      {
        route: 'PATCH /compose/{id}',
        send: (cookie: string) =>
          request(server)
            .patch(`/compose/${fixture.composeId}`)
            .set('Cookie', cookie)
            .send({ name: 'Renamed' }),
      },
      {
        route: 'PATCH /compose/{id}/environment',
        send: (cookie: string) =>
          request(server)
            .patch(`/compose/${fixture.composeId}/environment`)
            .set('Cookie', cookie)
            .send({ env: 'A=1' }),
      },
      {
        route: 'PATCH /postgres/{id}',
        send: (cookie: string) =>
          request(server)
            .patch(`/postgres/${fixture.postgresId}`)
            .set('Cookie', cookie)
            .send({ name: 'Renamed' }),
      },
      {
        route: 'PATCH /postgres/{id}/environment',
        send: (cookie: string) =>
          request(server)
            .patch(`/postgres/${fixture.postgresId}/environment`)
            .set('Cookie', cookie)
            .send({ env: 'A=1' }),
      },
      {
        route: 'PATCH /ports/{portId}',
        send: (cookie: string) =>
          request(server)
            .patch(`/ports/${fixture.portId}`)
            .set('Cookie', cookie)
            .send({ publishedPort: 9090 }),
      },
      {
        route: 'PATCH /redirects/{redirectId}',
        send: (cookie: string) =>
          request(server)
            .patch(`/redirects/${fixture.redirectId}`)
            .set('Cookie', cookie)
            .send({ replacement: '/newer' }),
      },
      {
        route: 'PATCH /security/{securityId}',
        send: (cookie: string) =>
          request(server)
            .patch(`/security/${fixture.securityId}`)
            .set('Cookie', cookie)
            .send({ password: 'hunter3' }),
      },
      {
        route: 'PATCH /mounts/{mountId}',
        send: (cookie: string) =>
          request(server)
            .patch(`/mounts/${fixture.mountId}`)
            .set('Cookie', cookie)
            .send({ mountPath: '/data-2' }),
      },
    ];

    /** The read of each thing the mutations above write. */
    const reads = (fixture: {
      applicationId: string;
      composeId: string;
      postgresId: string;
      portId: string;
      redirectId: string;
      securityId: string;
      mountId: string;
    }) => [
      {
        route: 'GET /applications/{id}',
        send: (cookie: string) =>
          request(server)
            .get(`/applications/${fixture.applicationId}`)
            .set('Cookie', cookie),
      },
      {
        route: 'GET /compose/{id}',
        send: (cookie: string) =>
          request(server)
            .get(`/compose/${fixture.composeId}`)
            .set('Cookie', cookie),
      },
      {
        route: 'GET /postgres/{id}',
        send: (cookie: string) =>
          request(server)
            .get(`/postgres/${fixture.postgresId}`)
            .set('Cookie', cookie),
      },
      {
        route: 'GET /ports/{portId}',
        send: (cookie: string) =>
          request(server).get(`/ports/${fixture.portId}`).set('Cookie', cookie),
      },
      {
        route: 'GET /redirects/{redirectId}',
        send: (cookie: string) =>
          request(server)
            .get(`/redirects/${fixture.redirectId}`)
            .set('Cookie', cookie),
      },
      {
        route: 'GET /security/{securityId}',
        send: (cookie: string) =>
          request(server)
            .get(`/security/${fixture.securityId}`)
            .set('Cookie', cookie),
      },
      {
        route: 'GET /mounts/{mountId}',
        send: (cookie: string) =>
          request(server)
            .get(`/mounts/${fixture.mountId}`)
            .set('Cookie', cookie),
      },
    ];

    const statuses = async (
      cookie: string,
      requests: ReturnType<typeof mutations> | ReturnType<typeof reads>,
    ) =>
      Object.fromEntries(
        await Promise.all(
          requests.map(async ({ route, send }) => [
            route,
            (await send(cookie)).status,
          ]),
        ),
      ) as Record<string, number>;

    /**
     * The finding itself, in the direction that used to succeed. Every one of
     * these routes used to answer 200 for this role, because
     * `checkServiceAccess`'s default was the only level a write consulted.
     */
    it('refuses every service mutation to a licensed custom role holding service read alone', async () => {
      const fixture = await setUpEntitledMember();
      await assignServiceRole(fixture.organizationId, fixture.invitee.id, [
        'read',
      ]);

      const answers = await statuses(
        fixture.invitee.cookie,
        mutations(fixture),
      );

      expect(
        Object.entries(answers).filter(([, status]) => status !== 403),
      ).toEqual([]);
    });

    it('still allows that role every corresponding read', async () => {
      const fixture = await setUpEntitledMember();
      await assignServiceRole(fixture.organizationId, fixture.invitee.id, [
        'read',
      ]);

      const answers = await statuses(fixture.invitee.cookie, reads(fixture));

      expect(
        Object.entries(answers).filter(([, status]) => status !== 200),
      ).toEqual([]);
    });

    /**
     * What makes the two tests above load-bearing rather than a restatement of
     * the route decorators. `PATCH /ports/:portId` and its siblings already
     * required `service: ['create']` at the guard, so a `['read']`-only role
     * was refused those before too — this role holds `create` and
     * `delete` and every non-`service` grant `memberRole` has, so `update` is
     * the only thing it is missing and the only thing that can explain the
     * refusal.
     */
    it('refuses the same mutations to a role holding every service action except update', async () => {
      const fixture = await setUpEntitledMember();
      await assignServiceRole(fixture.organizationId, fixture.invitee.id, [
        'create',
        'read',
        'delete',
      ]);

      const answers = await statuses(
        fixture.invitee.cookie,
        mutations(fixture),
      );

      expect(
        Object.entries(answers).filter(([, status]) => status !== 403),
      ).toEqual([]);
    });

    /**
     * The regression risk, asserted per route rather than trusted to the role
     * diff. `memberRole` gained `service: ['update']` precisely so that a base
     * member entitled to a Service keeps every write they had, and if that line
     * is ever removed this is what says so.
     *
     * The four child-row routes are the exception, and they were already the
     * exception: `PATCH /ports/:portId`, `/redirects/:redirectId` and
     * `/security/:securityId` require `service: ['create']` at the guard, which
     * `memberRole` does not hold, so a base member has been refused those since
     * before and still is. `PATCH /mounts/:mountId` needs
     * `volume: ['create']`, which they do hold, so it stays allowed.
     */
    it('leaves the base member static role every mutation it held before', async () => {
      const fixture = await setUpEntitledMember();

      const answers = await statuses(
        fixture.invitee.cookie,
        mutations(fixture),
      );

      expect(answers).toEqual({
        'PATCH /applications/{id}': 200,
        'PATCH /applications/{id}/environment': 200,
        // `@HttpCode(200)` on the route, not Nest's POST default of 201.
        'POST /applications/{id}/refresh-token': 200,
        'PATCH /compose/{id}': 200,
        'PATCH /compose/{id}/environment': 200,
        'PATCH /postgres/{id}': 200,
        'PATCH /postgres/{id}/environment': 200,
        // Refused before and refused after, on `service: ['create']` at
        // the guard — see the docblock.
        'PATCH /ports/{portId}': 403,
        'PATCH /redirects/{redirectId}': 403,
        'PATCH /security/{securityId}': 403,
        'PATCH /mounts/{mountId}': 200,
      });
    });

    /**
     * The other half of "not a feature removal": a base member may still add a
     * mount to a Service they are entitled to. `volume: ['create']` was never
     * the whole gate — `checkServiceAccess` runs beside it, and is now raised
     * that call to `'update'`, so this route would have started refusing every
     * member if `memberRole` had not gained the action.
     */
    it('leaves the base member static role able to add a mount to an entitled service', async () => {
      const fixture = await setUpEntitledMember();

      const created = await request(server)
        .post('/mounts')
        .set('Cookie', fixture.invitee.cookie)
        .send({
          type: 'volume',
          volumeName: 'shop-logs',
          mountPath: '/logs',
          serviceId: fixture.applicationId,
        });

      expect(created.status).toBe(201);
    });

    /**
     * And the direction that must not move, asserted on `POST /mounts` rather
     * than only on `PATCH /mounts/:mountId` in the list above.
     *
     * The regression this caused was in a *composed* create — a role holding
     * `service: ['create', 'read']` authorized a template/AI stack, wrote it,
     * was granted it, and was then refused its own config-file mounts by this
     * same method. The fix routes those two callers through
     * `MountsService.createForNewService`, which takes `'read'` because the
     * caller was authorized for the whole operation at the Project before
     * anything was written. It would have been much cheaper to lower the level
     * on `create` itself, and that is exactly what must not have happened:
     * this route edits the definition of a Service somebody else's statement
     * built, and the mounts docblock argues at length that `volume` — the
     * Docker volume — is not the Mount row that references it.
     *
     * The role is the same "everything but update" one two tests up, so
     * `volume: ['create']` is held and `service: ['update']` is the only thing
     * that can account for the 403.
     */
    it('still refuses POST /mounts to a role holding every service action except update', async () => {
      const fixture = await setUpEntitledMember();
      await assignServiceRole(fixture.organizationId, fixture.invitee.id, [
        'create',
        'read',
        'delete',
      ]);

      const refused = await request(server)
        .post('/mounts')
        .set('Cookie', fixture.invitee.cookie)
        .send({
          type: 'volume',
          volumeName: 'shop-logs',
          mountPath: '/logs',
          serviceId: fixture.applicationId,
        });

      expect(refused.status).toBe(403);
    });

    it('leaves owner and admin every mutation', async () => {
      const fixture = await setUpEntitledMember();
      await ctx.db
        .update(member)
        .set({ role: 'admin' })
        .where(eq(member.userId, fixture.invitee.id));

      const asOwner = await statuses(
        fixture.ownerSession.cookie,
        mutations(fixture),
      );
      const asAdmin = await statuses(
        fixture.invitee.cookie,
        mutations(fixture),
      );

      expect(
        Object.entries(asOwner).filter(([, status]) => status >= 400),
      ).toEqual([]);
      expect(
        Object.entries(asAdmin).filter(([, status]) => status >= 400),
      ).toEqual([]);
    });

    /**
     * The carve-out, and the assertion that makes it a decision rather than an
     * omission. This role holds `service: ['read']` and nothing else on the
     * resource — the same fixture that was refused all eleven definition
     * writes above — and it is still allowed to change the workload's status,
     * because `changeStatus` asks for `deployment: ['create']` and row-level
     * *read* access. That is "see and operate this service, but do not rewrite
     * its definition", which is the level this was for, and it is only sayable
     * because the lifecycle verbs were left on `'read'`.
     *
     * `POST /{engine}/:id/status` is the witness rather than `start`, `stop` or
     * `remove-containers` because it is the one lifecycle verb that writes a
     * column and shells out to nothing, so it needs no exec double.
     * `compose.e2e-spec.ts` covers `remove-containers` for the same role shape,
     * and that assertion is what caught the first pass raising these too.
     */
    it('still allows a service-read role the lifecycle verbs its own statement grants', async () => {
      const fixture = await setUpEntitledMember();
      await assignServiceRole(fixture.organizationId, fixture.invitee.id, [
        'read',
      ]);

      const res = await request(server)
        .post(`/postgres/${fixture.postgresId}/status`)
        .set('Cookie', fixture.invitee.cookie)
        .send({ applicationStatus: 'idle' });

      expect(res.status).toBe(200);
    });

    /**
     * §2.2 / ADR-0008, on the pair of refusals `checkServiceAccess` can now
     * answer with. A base member holds `service: ['update']`, so the only thing
     * that can refuse them a Service they are not entitled to is the row-level
     * `accessedServices` branch — and that refusal has to be
     * indistinguishable, on the wire, from the refusal for an id that does not
     * exist at all. Otherwise `PATCH /applications/:id` is an existence oracle
     * for every Service in the instance.
     */
    it('answers an unentitled service and a nonexistent one identically on the wire', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const project = await projects.create(ownerCtx, { name: 'cloudgate' });
      const environment = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const withheld = await applications.create(ownerCtx, {
        name: 'Withheld',
        appName: 'withheld-app',
        environmentId: environment.environmentId,
      });

      const unentitled = await request(server)
        .patch(`/applications/${withheld.applicationId}`)
        .set('Cookie', invitee.cookie)
        .send({ name: 'Renamed' });
      const absent = await request(server)
        .patch('/applications/no-such-application')
        .set('Cookie', invitee.cookie)
        .send({ name: 'Renamed' });

      expect(unentitled.status).toBe(403);
      expect(absent.status).toBe(403);
      expect((unentitled.body as { message: string }).message).toBe(
        (absent.body as { message: string }).message,
      );
      // The access-grant code rides the row-level branch, which never looks the
      // id up, so it names the missing grant without telling the two apart
      // either.
      expect((unentitled.body as { code?: string }).code).toBe(
        (absent.body as { code?: string }).code,
      );
      // Nothing was renamed on the way to being refused.
      const [row] = await ctx.db
        .select()
        .from(member)
        .where(eq(member.userId, invitee.id));
      expect(row.accessedServices).toEqual([]);
    });
  });

  /**
   * The project and environment levels, over HTTP and per resource.
   * `environment` carried no `update` and `project` carried neither `update`
   * nor `read`, so the writes that consulted them consulted read level — and
   * `PATCH /environments/:id`, `PATCH /projects/:id` and the two `projectTag`
   * routes carry no `@RequirePermission` at all, so that read-level check was
   * their only gate. For `project` it was weaker still:
   * `PermissionService.checkProjectAccess` skips `checkPermission` entirely for
   * `'read'` because there is no `project: ['read']` statement, so the write
   * was gated by the member row's `accessedProjects` and nothing else — any
   * role that could see a Project could rewrite it.
   *
   * **What those writes reach is why the level matters.**
   * `updateEnvironmentSchema` and `updateProjectSchema` both carry `env`, and
   * `prepareEnvironmentVariables` (`docker/docker.utils.ts`) merges both
   * columns into every Service beneath them at its next deploy. A Project's
   * reaches Environments the caller's own `accessedEnvironments` never named.
   *
   * **One suite rather than three**, for the reason the `service` block above
   * gives: every assertion here is an HTTP request to a real route and
   * `createTestApp` builds the whole `AppModule`, so the guard, the DTO and the
   * service all run — but the property under test is one property, and
   * `projects.e2e-spec.ts`, `environments.e2e-spec.ts` and `tags.e2e-spec.ts`
   * are ~1 GB and a container each (`docs/testing.md`).
   *
   * **The fixtures are designed so that the action is the only variable.** The
   * custom role is given every grant `memberRole` holds *except* `environment`
   * and `project` — including `service: ['read', 'update']` and full CRUD on
   * `tag` — and then those two arrays alone are changed between the tests. So
   * a refusal below cannot be explained by a missing `tag: ['update']` or a
   * missing `service` action.
   *
   * **The delete verbs are the carve-out**, and the test that names them is
   * what makes it a decision rather than an omission. `DELETE
   * /environments/:id` and `DELETE /projects/:id` already carry `environment:
   * ['delete']` and `project: ['delete']` at the guard and ask
   * `checkServiceAccess(…, 'delete')` of every child, so both keep resolving
   * their row at read level. Requiring `update` as well would refuse a role
   * deliberately granted the delete — which is
   * `test/projects/service-cascade-delete.e2e-spec.ts`'s `deployer` (`project:
   * ['delete']`, `environment: ['read', 'delete']`) — and would make "may
   * retire this Project but not rewrite it" unsayable in the act of creating
   * the level. The `service` level learned that from an e2e assertion rather
   * than a review.
   */
  describe("the environment and project resources' update action", () => {
    /**
     * `memberRole`'s grants minus `environment` and `project`, written out
     * because a custom role stores a plain JSON object and nothing in
     * `access-control.ts` exposes a static role's grants for a test to read.
     * `tag` is deliberately *wider* than `memberRole`'s `['read']`: the two
     * `projectTag` routes have no `tag` gate of their own, and this is what
     * proves their refusal is `project: ['update']` and not a tag action.
     * `access-control.spec.ts` asserts the static role's own half.
     *
     * `projectEnvVars` and `environmentEnvVars` were in this list too and went
     * with the statements, and `envVars` and `logs` went with them later.
     * Their absence is what makes this fixture the cleaner proof of
     * this gate: not one of the grants that *read* as if they covered a
     * Project's, an Environment's or a Service's `env` is here to be confused
     * with the ones that do.
     */
    const GRANTS_EXCEPT_SCOPES: Record<string, string[]> = {
      ac: ['read'],
      service: ['read', 'update'],
      volume: ['read', 'create', 'delete'],
      deployment: ['read', 'create', 'cancel'],
      backup: ['read', 'create', 'update', 'delete', 'restore'],
      volumeBackup: ['read', 'create', 'update', 'delete', 'restore'],
      schedule: ['read', 'create', 'update', 'delete'],
      domain: ['read', 'create', 'delete'],
      monitoring: ['read'],
      tag: ['read', 'create', 'update', 'delete'],
    };

    /**
     * One Project, one Environment in it with no Services, and one Tag — with
     * the invitee entitled to the Project and the Environment.
     *
     * **No Services on purpose.** The two delete routes are in the set, and a
     * cascade with no children reaches neither the exec layer nor the Traefik
     * writer (`common/service-cascade.ts`), so the carve-out can be asserted
     * over HTTP without an exec double. The gate under test runs before any of
     * that either way.
     *
     * The Project and Environment go through the services rather than the
     * routes because `POST /projects` and `POST /environments` require
     * `project: ['create']` and `environment: ['create']`, which is the shape
     * the `service` block above uses for the same reason; the Tag goes through
     * its real route, since an owner holds `tag: ['create']` by the
     * enterprise-resource bypass.
     */
    async function setUpEntitledMember() {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const project = await projects.create(ownerCtx, { name: 'cloudgate' });
      const environment = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });

      const tagRes = await request(server)
        .post('/tags')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'critical' });
      expect(tagRes.status).toBe(201);
      const { tagId } = tagRes.body as { tagId: string };

      const [memberRow] = await ctx.db
        .select()
        .from(member)
        .where(eq(member.userId, invitee.id));
      await permissions.setMemberEntitlements(organizationId, memberRow.id, {
        accessedProjects: [project.projectId],
        accessedEnvironments: [environment.environmentId],
        accessedServices: [],
      });

      return {
        organizationId,
        ownerSession,
        invitee,
        projectId: project.projectId,
        environmentId: environment.environmentId,
        tagId,
      };
    }

    /**
     * Moves the invitee onto a licensed custom role holding `environment` and
     * `project` as given, and every other `memberRole` grant unchanged.
     */
    async function assignScopeRole(
      organizationId: string,
      userId: string,
      scopes: { environment: string[]; project: string[] },
    ) {
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'project-operator',
        permission: { ...GRANTS_EXCEPT_SCOPES, ...scopes },
      });
      await ctx.db
        .update(member)
        .set({ role: 'project-operator' })
        .where(eq(member.userId, userId));
    }

    type Fixture = {
      projectId: string;
      environmentId: string;
      tagId: string;
    };

    /**
     * Every mutation in this set, as one request each, so a single `it` can
     * say "all of these are refused" or "all of these are allowed" and the
     * failure names the route rather than a boolean. Each body carries `env`
     * as well as the name, because `env` is the field that made the level
     * worth naming.
     */
    const mutations = (fixture: Fixture) => [
      {
        route: 'PATCH /environments/{id}',
        send: (cookie: string) =>
          request(server)
            .patch(`/environments/${fixture.environmentId}`)
            .set('Cookie', cookie)
            .send({ name: 'staging', env: 'INJECTED=1' }),
      },
      {
        route: 'PATCH /projects/{id}',
        send: (cookie: string) =>
          request(server)
            .patch(`/projects/${fixture.projectId}`)
            .set('Cookie', cookie)
            .send({ name: 'renamed', env: 'INJECTED=1' }),
      },
      {
        route: 'POST /tags/{id}/projects/{projectId}',
        send: (cookie: string) =>
          request(server)
            .post(`/tags/${fixture.tagId}/projects/${fixture.projectId}`)
            .set('Cookie', cookie),
      },
      {
        route: 'DELETE /tags/{id}/projects/{projectId}',
        send: (cookie: string) =>
          request(server)
            .delete(`/tags/${fixture.tagId}/projects/${fixture.projectId}`)
            .set('Cookie', cookie),
      },
    ];

    /** The read of each thing the mutations above write. */
    const reads = (fixture: Fixture) => [
      {
        route: 'GET /environments/{id}',
        send: (cookie: string) =>
          request(server)
            .get(`/environments/${fixture.environmentId}`)
            .set('Cookie', cookie),
      },
      {
        route: 'GET /environments?projectId=',
        send: (cookie: string) =>
          request(server)
            .get(`/environments?projectId=${fixture.projectId}`)
            .set('Cookie', cookie),
      },
      {
        route: 'GET /projects/{id}',
        send: (cookie: string) =>
          request(server)
            .get(`/projects/${fixture.projectId}`)
            .set('Cookie', cookie),
      },
      {
        route: 'GET /tags?projectId=',
        send: (cookie: string) =>
          request(server)
            .get(`/tags?projectId=${fixture.projectId}`)
            .set('Cookie', cookie),
      },
    ];

    /**
     * One request at a time, unlike the `service` block above, and the reason is
     * `unique_project_tag`: the assign and the unassign in `mutations` are the
     * same `projectTag` row, so running them concurrently leaves it undefined
     * whether the row survives the set — and a second run inside the same `it`
     * would then hit the unique constraint rather than the gate. Sequenced,
     * every set of four leaves the fixture exactly as it found it.
     */
    const statuses = async (
      cookie: string,
      requests: ReturnType<typeof mutations> | ReturnType<typeof reads>,
    ) => {
      const answers: Record<string, number> = {};
      for (const { route, send } of requests) {
        answers[route] = (await send(cookie)).status;
      }
      return answers;
    };

    /**
     * The finding itself, in the direction that used to succeed. Every one of
     * these four routes used to answer 200 or 201 for this role, because
     * a read-level check was the only level any of them consulted.
     */
    it('refuses every environment and project mutation to a licensed custom role holding the read-only statements', async () => {
      const fixture = await setUpEntitledMember();
      await assignScopeRole(fixture.organizationId, fixture.invitee.id, {
        environment: ['read'],
        project: [],
      });

      const answers = await statuses(
        fixture.invitee.cookie,
        mutations(fixture),
      );

      expect(
        Object.entries(answers).filter(([, status]) => status !== 403),
      ).toEqual([]);
    });

    it('still allows that role every corresponding read', async () => {
      const fixture = await setUpEntitledMember();
      await assignScopeRole(fixture.organizationId, fixture.invitee.id, {
        environment: ['read'],
        project: [],
      });

      const answers = await statuses(fixture.invitee.cookie, reads(fixture));

      expect(
        Object.entries(answers).filter(([, status]) => status !== 200),
      ).toEqual([]);
    });

    /**
     * What makes the two tests above load-bearing rather than a restatement of
     * the guard. This role holds every action `environment` and `project`
     * offered before — `create` and `delete` on both, `read` on the
     * Environment — plus every non-scope grant `memberRole` has, including
     * full CRUD on `tag`. So `update` is the only thing it is missing and the
     * only thing that can explain the refusal.
     */
    it('refuses the same mutations to a role holding every action those resources had before', async () => {
      const fixture = await setUpEntitledMember();
      await assignScopeRole(fixture.organizationId, fixture.invitee.id, {
        environment: ['create', 'read', 'delete'],
        project: ['create', 'delete'],
      });

      const answers = await statuses(
        fixture.invitee.cookie,
        mutations(fixture),
      );

      expect(
        Object.entries(answers).filter(([, status]) => status !== 403),
      ).toEqual([]);
    });

    /** The allowed direction, so the refusals above are about the action. */
    it('allows every one of them to a role granted the two update actions', async () => {
      const fixture = await setUpEntitledMember();
      await assignScopeRole(fixture.organizationId, fixture.invitee.id, {
        environment: ['read', 'update'],
        project: ['update'],
      });

      const answers = await statuses(
        fixture.invitee.cookie,
        mutations(fixture),
      );

      expect(answers).toEqual({
        'PATCH /environments/{id}': 200,
        'PATCH /projects/{id}': 200,
        // The assignment *is* a row, so `201` and no `@HttpCode`.
        'POST /tags/{id}/projects/{projectId}': 201,
        'DELETE /tags/{id}/projects/{projectId}': 200,
      });
    });

    /**
     * **The carve-out**, and the assertion that makes it a decision rather
     * than an omission. This is `service-cascade-delete.e2e-spec.ts`'s
     * `deployer` grant verbatim — `project: ['delete']`,
     * `environment: ['read', 'delete']`, no `update` on either — and it is
     * still allowed both deletes while being refused both `PATCH`es. That is
     * "may retire this Project and its Environments, but not rewrite them",
     * which is a level this has to leave sayable: moving `remove` onto
     * `findOneForUpdate` / `findOwnedForUpdate` would have refused a role
     * deliberately granted the delete, which is exactly the mistake the
     * `service` level's first pass made one resource down.
     *
     * The Environment is deleted before the Project so both statements are
     * exercised; neither cascade has a child, so neither reaches the exec
     * layer.
     */
    it('still allows a role granted the delete and not the update to delete an Environment and a Project', async () => {
      const fixture = await setUpEntitledMember();
      await assignScopeRole(fixture.organizationId, fixture.invitee.id, {
        environment: ['read', 'delete'],
        project: ['delete'],
      });

      const patches = await statuses(
        fixture.invitee.cookie,
        mutations(fixture).slice(0, 2),
      );
      expect(patches).toEqual({
        'PATCH /environments/{id}': 403,
        'PATCH /projects/{id}': 403,
      });

      const environmentDeleted = await request(server)
        .delete(`/environments/${fixture.environmentId}`)
        .set('Cookie', fixture.invitee.cookie);
      expect(environmentDeleted.status).toBe(200);

      const projectDeleted = await request(server)
        .delete(`/projects/${fixture.projectId}`)
        .set('Cookie', fixture.invitee.cookie);
      expect(projectDeleted.status).toBe(200);
    });

    /**
     * The regression risk, asserted per route and per resource rather than
     * trusted to the role diff — and for `project` it is not a regression but
     * **the deliberate narrowing**, which is why this is a whole-object
     * comparison rather than a filter.
     *
     * `memberRole` gained `environment: ['update']` so a base member entitled
     * to an Environment keeps the write they had. `project` stayed empty, so
     * the same member loses three: the `PATCH` and both tag assignments. The
     * argument is at `memberRole`'s `project` line in `access-control.ts` —
     * `project.env` reaches Environments and Services the member's own grants
     * never named, and the base member holds no other project mutation to be
     * inconsistent with. If a later change grants the base member
     * `project: ['update']`, this is what says so out loud.
     */
    it('leaves the base member static role its Environment write and takes its Project writes away', async () => {
      const fixture = await setUpEntitledMember();

      const answers = await statuses(
        fixture.invitee.cookie,
        mutations(fixture),
      );

      expect(answers).toEqual({
        'PATCH /environments/{id}': 200,
        // The one narrowing of a static role: `memberRole.project` is `[]`.
        'PATCH /projects/{id}': 403,
        'POST /tags/{id}/projects/{projectId}': 403,
        'DELETE /tags/{id}/projects/{projectId}': 403,
      });
    });

    /** And every read a base member had, so the narrowing is of writes only. */
    it('leaves the base member static role every corresponding read', async () => {
      const fixture = await setUpEntitledMember();

      const answers = await statuses(fixture.invitee.cookie, reads(fixture));

      expect(
        Object.entries(answers).filter(([, status]) => status !== 200),
      ).toEqual([]);
    });

    it('leaves owner and admin every mutation', async () => {
      const fixture = await setUpEntitledMember();
      await ctx.db
        .update(member)
        .set({ role: 'admin' })
        .where(eq(member.userId, fixture.invitee.id));

      const asAdmin = await statuses(
        fixture.invitee.cookie,
        mutations(fixture),
      );
      // Sequenced after the admin's run: see `statuses`.
      const asOwner = await statuses(
        fixture.ownerSession.cookie,
        mutations(fixture),
      );

      expect(
        Object.entries(asAdmin).filter(([, status]) => status >= 400),
      ).toEqual([]);
      expect(
        Object.entries(asOwner).filter(([, status]) => status >= 400),
      ).toEqual([]);
    });

    /**
     * §2.2 / ADR-0008, on the pair of refusals each check can now answer with.
     * A base member holds `environment: ['update']`, so the only thing that
     * can refuse them an Environment they are not entitled to is the row-level
     * `accessedEnvironments` branch — and that refusal has to be
     * indistinguishable, on the wire, from the refusal for an id that does not
     * exist at all. Otherwise `PATCH /environments/:id` is an existence oracle
     * for every Environment in the instance.
     *
     * This is also what `findOwnedForUpdate`'s ordering buys: the action is
     * claimed before the ownership lookup, so a caller holding `read` and not
     * `update` never learns whether the id resolved either.
     */
    it('answers an unentitled environment and a nonexistent one identically on the wire', async () => {
      const {
        organizationId,
        owner: ownerSession,
        invitee,
      } = await setUpOrgWithMember(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const project = await projects.create(ownerCtx, { name: 'cloudgate' });
      const withheld = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });

      const unentitled = await request(server)
        .patch(`/environments/${withheld.environmentId}`)
        .set('Cookie', invitee.cookie)
        .send({ name: 'staging' });
      const absent = await request(server)
        .patch('/environments/no-such-environment')
        .set('Cookie', invitee.cookie)
        .send({ name: 'staging' });

      expect(unentitled.status).toBe(403);
      expect(absent.status).toBe(403);
      expect((unentitled.body as { message: string }).message).toBe(
        (absent.body as { message: string }).message,
      );
      // The access-grant code rides the row-level branch, which never looks the
      // id up, so it names the missing grant without telling the two apart
      // either.
      expect((unentitled.body as { code?: string }).code).toBe(
        (absent.body as { code?: string }).code,
      );
      // Nothing was renamed on the way to being refused.
      const [row] = await ctx.db
        .select()
        .from(environmentTable)
        .where(eq(environmentTable.environmentId, withheld.environmentId));
      expect(row.name).toBe('production');
    });
  });

  /**
   * A licensed Organization, one custom role named `legacy-auditor` holding
   * `permission`, and `userId` moved onto it. Hoisted out of the
   * undeclared-name describe, since the internal-name one needs the same
   * fixture for the other kind of inert grant.
   *
   * The row is inserted straight into `organization_role` rather than created
   * over the API, which is the point in both issues: `validatePermissions`
   * refuses what these rows carry, so the reachable population is exactly the
   * rows that did not come through it.
   */
  async function assignStoredRole(
    organizationId: string,
    userId: string,
    permission: Record<string, string[]>,
  ) {
    await ctx.db.insert(licenseKey).values({
      organizationId,
      key: 'test-license-key',
      status: 'active',
      enableEnterpriseFeatures: true,
    });
    await ctx.db.insert(organizationRole).values({
      organizationId,
      role: 'legacy-auditor',
      permission,
    });
    await ctx.db
      .update(member)
      .set({ role: 'legacy-auditor' })
      .where(eq(member.userId, userId));
  }

  /**
   * What `resolveRole` hands better-auth when a stored `organization_role` row
   * carries a grant the vocabulary no longer declares.
   *
   * **This is not a hypothetical row.** `logs: ['read']` was declared in
   * `statements`, granted by all three static roles, and — in this very suite —
   * the universal example grant, until it was deleted. Every role an operator
   * saved before that deletion still carries it in its `permission` JSON, and
   * `validatePermissions` cannot have refused it, because it was declared when
   * the row was written.
   *
   * The two halves are asserted separately because they fail differently. The
   * grant map is observed at `ac.newRole`, which is the exact seam the issue is
   * about; the log is counted across three checks, because `resolveRole` runs
   * once per permission check and a line per check would be the noise that gets
   * a warning filtered out rather than acted on.
   */
  describe('a stored grant the statements no longer declare', () => {
    const RETIRED = 'logs';

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('resolves the role without the undeclared grant, and with everything it declares', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);
      await assignStoredRole(organizationId, invitee.id, {
        auditLog: ['read'],
        [RETIRED]: ['read'],
      });
      const newRole = jest.spyOn(ac, 'newRole');

      await expect(
        permissions.checkPermission(permissionCtx(invitee.id, organizationId), {
          auditLog: ['read'],
        }),
      ).resolves.toBeUndefined();

      // The grant map better-auth is actually given, rather than the row.
      expect(newRole).toHaveBeenCalledTimes(1);
      expect(newRole.mock.calls[0][0]).toEqual({ auditLog: ['read'] });
    });

    /**
     * The half that makes the drop safe to ship: the role still answers every
     * request it answered before. Two earlier changes each deleted statements
     * with no migration precisely because a granted key nothing requests is
     * never read, so a filter that changed one answer would be that migration
     * arriving unannounced.
     */
    it('refuses and allows exactly what the same row allowed before', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);
      await assignStoredRole(organizationId, invitee.id, {
        auditLog: ['read'],
        service: ['read'],
        [RETIRED]: ['read'],
      });
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      await expect(
        permissions.checkPermission(inviteeCtx, { service: ['read'] }),
      ).resolves.toBeUndefined();
      await expect(
        permissions.checkPermission(inviteeCtx, { service: ['update'] }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        permissions.checkPermission(inviteeCtx, { auditLog: ['read'] }),
      ).resolves.toBeUndefined();
    });

    it('says so once for the role rather than once per permission check', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);
      await assignStoredRole(organizationId, invitee.id, {
        auditLog: ['read'],
        [RETIRED]: ['read'],
      });
      const inviteeCtx = permissionCtx(invitee.id, organizationId);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      await permissions.checkPermission(inviteeCtx, { auditLog: ['read'] });
      await permissions.checkPermission(inviteeCtx, { auditLog: ['read'] });
      await permissions.checkPermission(inviteeCtx, { auditLog: ['read'] });

      const lines = warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes(RETIRED));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('legacy-auditor');
    });

    /** A role with nothing undeclared says nothing at all. */
    it('is silent for a role whose every grant the statements declare', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);
      await assignStoredRole(organizationId, invitee.id, {
        auditLog: ['read'],
        service: ['read', 'update'],
      });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      await permissions.checkPermission(
        permissionCtx(invitee.id, organizationId),
        { auditLog: ['read'] },
      );

      expect(
        warn.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.includes('legacy-auditor')),
      ).toEqual([]);
    });
  });

  /**
   * The same seam for a grant of a resource better-auth's organization plugin
   * owns.
   *
   * **`team: ['read']` is the row, and it is a real shape rather than a
   * hypothetical one.** `team` is a declared statement, so the undeclared-name
   * drop kept it; `read` is not one of its declared actions, so before this
   * drop the row resolved as `team: []` and was reported as the undeclared
   * *action* `team:read` — pointing an operator at a retired statement over a
   * resource that is not retired and never was assignable.
   * `validatePermissions` has refused all four internal resources since custom
   * roles shipped, on `create` and on `update`, so a row carrying one came from
   * a migration or a hand-run `UPDATE`: this test writes it the same way.
   *
   * The three halves fail differently and are asserted apart, as in the
   * undeclared-name block above — the grant map at `ac.newRole`, the answers
   * the role still gives, and which of the two lines fires.
   */
  describe('a stored grant of a resource better-auth owns', () => {
    const INTERNAL = 'team';

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('resolves the role without the internal grant, and with everything else', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);
      await assignStoredRole(organizationId, invitee.id, {
        auditLog: ['read'],
        [INTERNAL]: ['read'],
      });
      const newRole = jest.spyOn(ac, 'newRole');

      await expect(
        permissions.checkPermission(permissionCtx(invitee.id, organizationId), {
          auditLog: ['read'],
        }),
      ).resolves.toBeUndefined();

      // The grant map better-auth is actually given, rather than the row. The
      // key is gone outright — not `team: []`, which is what the undeclared
      // *action* branch would have left behind.
      expect(newRole).toHaveBeenCalledTimes(1);
      expect(newRole.mock.calls[0][0]).toEqual({ auditLog: ['read'] });
    });

    it('refuses and allows exactly what the same row allowed before', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);
      await assignStoredRole(organizationId, invitee.id, {
        auditLog: ['read'],
        service: ['read'],
        [INTERNAL]: ['create'],
      });
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      await expect(
        permissions.checkPermission(inviteeCtx, { service: ['read'] }),
      ).resolves.toBeUndefined();
      await expect(
        permissions.checkPermission(inviteeCtx, { service: ['update'] }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        permissions.checkPermission(inviteeCtx, { auditLog: ['read'] }),
      ).resolves.toBeUndefined();
    });

    /**
     * The line is the whole visible half of this change, and it has to be the
     * internal one: the undeclared-name line sends the reader after a retired
     * statement, which `team` is not.
     */
    it('says the plugin manages it rather than that a statement was retired', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);
      await assignStoredRole(organizationId, invitee.id, {
        auditLog: ['read'],
        [INTERNAL]: ['read'],
      });
      const inviteeCtx = permissionCtx(invitee.id, organizationId);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      await permissions.checkPermission(inviteeCtx, { auditLog: ['read'] });
      await permissions.checkPermission(inviteeCtx, { auditLog: ['read'] });
      await permissions.checkPermission(inviteeCtx, { auditLog: ['read'] });

      const lines = warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('legacy-auditor'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(INTERNAL);
      expect(lines[0]).toContain("better-auth's organization plugin");
      expect(lines[0]).not.toContain('no longer declare');
    });

    /** A row carrying one of each is two lines, not one hedged one. */
    it('reports the internal grant and the retired one separately', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember(server);
      await assignStoredRole(organizationId, invitee.id, {
        auditLog: ['read'],
        logs: ['read'],
        [INTERNAL]: ['read'],
      });
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      await permissions.checkPermission(
        permissionCtx(invitee.id, organizationId),
        { auditLog: ['read'] },
      );

      const lines = warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('legacy-auditor'));
      expect(lines).toHaveLength(2);
      expect(
        lines.filter((line) => line.includes('no longer declare')),
      ).toEqual([expect.stringContaining('logs')]);
      expect(
        lines.filter((line) =>
          line.includes("better-auth's organization plugin"),
        ),
      ).toEqual([expect.stringContaining(INTERNAL)]);
    });
  });
});
