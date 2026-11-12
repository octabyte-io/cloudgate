import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { member } from '../../src/db/schema';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionService } from '../../src/rbac/permission.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

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

/** The owner's bootstrap organization plus a service-seam permission ctx. */
async function setUpOwner(server: App) {
  const ownerSession = await signUp(server, owner);

  const orgs = await request(server)
    .get('/organizations')
    .set('Cookie', ownerSession.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;

  return { organizationId, owner: ownerSession };
}

/** Invites a user into the owner's organization and accepts as them. */
async function inviteUser(
  server: App,
  ownerCookie: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ cookie: string; id: string }> {
  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', ownerCookie)
    .send({ email, role });
  const inviteId = (invite.body as { id: string }).id;

  const su = await request(server)
    .post('/api/auth/sign-up/email')
    .set('x-cloudgate-token', inviteId)
    .send({ name: 'Ida Rhodes', email, password: 'super-secret-password' });
  const cookie = su.headers['set-cookie'];
  const id = (su.body as { user: { id: string } }).user.id;

  const accept = await request(server)
    .post(`/organizations/invitations/${inviteId}/accept`)
    .set('Cookie', cookie);
  expect(accept.status).toBe(201);

  return { cookie, id };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/** The shape `GET /projects` puts on the wire, as the Projects screen reads it. */
type ProjectListRow = {
  projectId: string;
  name: string;
  environmentCount: number;
  tags: { tagId: string; name: string; color: string | null }[];
};

async function createProject(
  server: App,
  cookie: string,
  name: string,
): Promise<string> {
  const res = await request(server)
    .post('/projects')
    .set('Cookie', cookie)
    .send({ name });
  expect(res.status).toBe(201);
  return (res.body as { projectId: string }).projectId;
}

async function createEnvironment(
  server: App,
  cookie: string,
  projectId: string,
  name: string,
): Promise<string> {
  const res = await request(server)
    .post('/environments')
    .set('Cookie', cookie)
    .send({ name, projectId });
  expect(res.status).toBe(201);
  return (res.body as { environmentId: string }).environmentId;
}

async function createTag(
  server: App,
  cookie: string,
  name: string,
  color?: string,
): Promise<string> {
  const res = await request(server)
    .post('/tags')
    .set('Cookie', cookie)
    .send({ name, color });
  expect(res.status).toBe(201);
  return (res.body as { tagId: string }).tagId;
}

async function assignTag(
  server: App,
  cookie: string,
  tagId: string,
  projectId: string,
): Promise<void> {
  const res = await request(server)
    .post(`/tags/${tagId}/projects/${projectId}`)
    .set('Cookie', cookie);
  expect(res.status).toBe(201);
}

/** Index a `GET /projects` body by project name for readable assertions. */
function byName(body: unknown): Record<string, ProjectListRow> {
  return Object.fromEntries(
    (body as ProjectListRow[]).map((row) => [row.name, row]),
  );
}

describe('Projects (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  describe('create → findOne', () => {
    it('creates a project retrievable by id', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await projects.create(ownerCtx, {
        name: 'cloudgate',
        description: 'deployment platform',
      });

      expect(created.projectId).toEqual(expect.any(String));
      expect(created.organizationId).toBe(organizationId);

      const found = await projects.findOne(ownerCtx, created.projectId);
      expect(found).toMatchObject({
        projectId: created.projectId,
        name: 'cloudgate',
        description: 'deployment platform',
        organizationId,
      });
    });

    it('stores env encrypted at rest and returns it decrypted', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await projects.create(ownerCtx, {
        name: 'with-env',
        env: 'API_KEY=super-secret',
      });

      const found = await projects.findOne(ownerCtx, created.projectId);
      expect(found.env).toBe('API_KEY=super-secret');

      const raw = await ctx.db.$client.query<{ env: string }>(
        'select env from project where project_id = $1',
        [created.projectId],
      );
      expect(raw.rows[0].env).not.toContain('super-secret');
      expect(raw.rows[0].env.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('list', () => {
    it('owner sees every project in the organization', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await projects.create(ownerCtx, { name: 'alpha' });
      await projects.create(ownerCtx, { name: 'beta' });

      const listed = await projects.list(ownerCtx);
      expect(listed.map((p) => p.name).sort()).toEqual(['alpha', 'beta']);
    });

    it('a member sees only projects granted in accessedProjects', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      const granted = await projects.create(ownerCtx, { name: 'granted' });
      await projects.create(ownerCtx, { name: 'hidden' });

      expect(await projects.list(inviteeCtx)).toEqual([]);

      const permissions = ctx.app.get(PermissionService);
      await permissions.addNewProject(inviteeCtx, granted.projectId);

      const listed = await projects.list(inviteeCtx);
      expect(listed.map((p) => p.projectId)).toEqual([granted.projectId]);
    });

    it('create grants the creator row-level access', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const admin = await inviteUser(
        server,
        ownerSession.cookie,
        'admin@example.com',
        'admin',
      );
      const adminCtx = permissionCtx(admin.id, organizationId);

      await projects.create(ownerCtx, { name: 'owners-project' });
      const own = await projects.create(adminCtx, { name: 'admins-project' });

      // Downgrade the creator to a plain member: only the row-level grant
      // made at create time can keep their project visible.
      await ctx.db
        .update(member)
        .set({ role: 'member' })
        .where(eq(member.userId, admin.id));

      const listed = await projects.list(adminCtx);
      expect(listed.map((p) => p.projectId)).toEqual([own.projectId]);
    });
  });

  describe('list rows carry their children', () => {
    it('each row reports its environment count and assigned tags', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const alpha = await createProject(server, cookie, 'alpha');
      await createProject(server, cookie, 'beta');

      await createEnvironment(server, cookie, alpha, 'production');
      await createEnvironment(server, cookie, alpha, 'staging');
      await createEnvironment(server, cookie, alpha, 'canary');

      const web = await createTag(server, cookie, 'web', '#00f');
      const ops = await createTag(server, cookie, 'ops', '#f00');
      await assignTag(server, cookie, web, alpha);
      await assignTag(server, cookie, ops, alpha);

      const listed = await request(server)
        .get('/projects')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);

      const rows = byName(listed.body);
      expect(rows.alpha.environmentCount).toBe(3);
      expect(rows.alpha.tags.map((t) => t.name)).toEqual(['ops', 'web']);
      expect(rows.alpha.tags.map((t) => t.tagId).sort()).toEqual(
        [web, ops].sort(),
      );
      expect(rows.alpha.tags[0]).toMatchObject({
        tagId: ops,
        name: 'ops',
        color: '#f00',
      });

      // A project with no children still reports the empty forms, so the
      // client never has to distinguish "absent" from "none".
      expect(rows.beta.environmentCount).toBe(0);
      expect(rows.beta.tags).toEqual([]);
    });

    it('the children never widen what a restricted member can see', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;
      const invitee = await inviteUser(
        server,
        cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      const granted = await createProject(server, cookie, 'granted');
      const hidden = await createProject(server, cookie, 'hidden');

      const visibleEnv = await createEnvironment(
        server,
        cookie,
        granted,
        'production',
      );
      await createEnvironment(server, cookie, granted, 'staging');
      await createEnvironment(server, cookie, hidden, 'production');

      const web = await createTag(server, cookie, 'web');
      await assignTag(server, cookie, web, granted);
      await assignTag(server, cookie, web, hidden);

      // Row-level grants: the project, and only one of its two environments.
      const permissions = ctx.app.get(PermissionService);
      await permissions.addNewProject(inviteeCtx, granted);
      await permissions.addNewEnvironment(inviteeCtx, visibleEnv);

      const listed = await request(server)
        .get('/projects')
        .set('Cookie', invitee.cookie);
      expect(listed.status).toBe(200);

      const body = listed.body as ProjectListRow[];
      // The joins must not leak the ungranted project as an extra row.
      expect(body.map((row) => row.name)).toEqual(['granted']);

      // The count is what the per-row request it replaces would have said,
      // not the true number of environments on the project.
      const perRow = await request(server)
        .get('/environments')
        .query({ projectId: granted })
        .set('Cookie', invitee.cookie);
      expect((perRow.body as unknown[]).length).toBe(1);
      expect(body[0].environmentCount).toBe(1);

      expect(body[0].tags.map((t) => t.name)).toEqual(['web']);
    });
  });

  describe('update', () => {
    it('changes the given fields and leaves the rest untouched', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await projects.create(ownerCtx, {
        name: 'before',
        description: 'kept as-is',
        env: 'API_KEY=old',
      });

      const updated = await projects.update(ownerCtx, created.projectId, {
        name: 'after',
        env: 'API_KEY=new',
      });
      expect(updated).toMatchObject({
        projectId: created.projectId,
        name: 'after',
        description: 'kept as-is',
        env: 'API_KEY=new',
      });

      const found = await projects.findOne(ownerCtx, created.projectId);
      expect(found.name).toBe('after');
      expect(found.env).toBe('API_KEY=new');
    });
  });

  describe('remove', () => {
    it('deletes the project', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await projects.create(ownerCtx, { name: 'doomed' });

      const removed = await projects.remove(ownerCtx, created.projectId);
      expect(removed.projectId).toBe(created.projectId);

      await expect(
        projects.findOne(ownerCtx, created.projectId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('permissions & cross-org isolation', () => {
    it('a project is invisible outside its own organization', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const created = await projects.create(secondOrgCtx, {
        name: 'org-b-only',
      });

      // Same user, but acting in the first organization: the project from
      // the second organization must not resolve, even for its creator.
      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        projects.findOne(firstOrgCtx, created.projectId),
      ).rejects.toThrow(NotFoundException);
      expect(await projects.list(firstOrgCtx)).toEqual([]);
    });

    it('a member without a row-level grant cannot read a project in their own organization', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      const created = await projects.create(ownerCtx, { name: 'ungranted' });

      await expect(
        projects.findOne(inviteeCtx, created.projectId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('POST /projects returns 403 for a member and 201 for the owner', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );

      const denied = await request(server)
        .post('/projects')
        .set('Cookie', invitee.cookie)
        .send({ name: 'not-allowed' });
      expect(denied.status).toBe(403);

      const allowed = await request(server)
        .post('/projects')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'allowed' });
      expect(allowed.status).toBe(201);
      expect(allowed.body).toMatchObject({ name: 'allowed' });
    });
  });

  describe('a name is unique in its organization', () => {
    const conflict =
      'A Project with this name already exists in your organization';

    it('POST /projects refuses a name already in the organization, in any letter case', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      await createProject(server, ownerSession.cookie, 'ui-tags');

      for (const name of ['ui-tags', 'UI-Tags', '  ui-tags  ']) {
        const res = await request(server)
          .post('/projects')
          .set('Cookie', ownerSession.cookie)
          .send({ name });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ message: conflict });
      }
      const listed = await request(server)
        .get('/projects')
        .set('Cookie', ownerSession.cookie);
      expect((listed.body as ProjectListRow[]).map((p) => p.name)).toEqual([
        'ui-tags',
      ]);
    });

    it('PATCH /projects/:id refuses a rename onto another Project, in any letter case', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      await createProject(server, ownerSession.cookie, 'ui-tags');
      const other = await createProject(server, ownerSession.cookie, 'other');

      const res = await request(server)
        .patch(`/projects/${other}`)
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'UI-TAGS' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ message: conflict });

      const kept = await request(server)
        .get(`/projects/${other}`)
        .set('Cookie', ownerSession.cookie);
      expect(kept.body).toMatchObject({ name: 'other' });
    });

    it('a Project may be renamed to a new letter case of its own name', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const id = await createProject(server, ownerSession.cookie, 'ui-tags');

      const res = await request(server)
        .patch(`/projects/${id}`)
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'UI-Tags' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: 'UI-Tags' });
    });

    it('the same name in another organization is still allowed', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      await projects.create(permissionCtx(ownerSession.id, organizationId), {
        name: 'shared',
      });
      await expect(
        projects.create(permissionCtx(ownerSession.id, secondOrgId), {
          name: 'Shared',
        }),
      ).resolves.toMatchObject({ name: 'Shared' });
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports the full CRUD round-trip over HTTP', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'http-project', env: 'A=1' });
      expect(created.status).toBe(201);
      const id = (created.body as { projectId: string }).projectId;

      const listed = await request(server)
        .get('/projects')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(
        (listed.body as { projectId: string }[]).map((p) => p.projectId),
      ).toEqual([id]);

      const one = await request(server)
        .get(`/projects/${id}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ name: 'http-project', env: 'A=1' });

      const patched = await request(server)
        .patch(`/projects/${id}`)
        .set('Cookie', cookie)
        .send({ description: 'now documented' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        name: 'http-project',
        description: 'now documented',
      });

      const removed = await request(server)
        .delete(`/projects/${id}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/projects/${id}`)
        .set('Cookie', cookie);
      expect(gone.status).toBe(404);
    });
  });
});
