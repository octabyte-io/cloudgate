import { ConflictException, NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { ProjectsService } from '../../src/projects/projects.service';
import { TagsService } from '../../src/tags/tags.service';
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

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

describe('Tags (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let tags: TagsService;
  let projects: ProjectsService;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
    tags = ctx.app.get(TagsService);
    projects = ctx.app.get(ProjectsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  describe('assign / unassign', () => {
    it('assigning a tag makes the project list it; unassigning removes it', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const project = await projects.create(ownerCtx, { name: 'tagged' });
      const created = await tags.create(ownerCtx, { name: 'production' });

      await tags.assignToProject(ownerCtx, project.projectId, created.tagId);
      const assigned = await tags.listByProject(ownerCtx, project.projectId);
      expect(assigned.map((t) => t.tagId)).toEqual([created.tagId]);

      await tags.removeFromProject(ownerCtx, project.projectId, created.tagId);
      expect(await tags.listByProject(ownerCtx, project.projectId)).toEqual([]);
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports the full CRUD + assign round-trip over HTTP', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/tags')
        .set('Cookie', cookie)
        .send({ name: 'http-tag', color: '#123456' });
      expect(created.status).toBe(201);
      const id = (created.body as { tagId: string }).tagId;

      const listed = await request(server).get('/tags').set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect((listed.body as { tagId: string }[]).map((t) => t.tagId)).toEqual([
        id,
      ]);

      const one = await request(server)
        .get(`/tags/${id}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ name: 'http-tag', color: '#123456' });

      const patched = await request(server)
        .patch(`/tags/${id}`)
        .set('Cookie', cookie)
        .send({ color: '#654321' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        name: 'http-tag',
        color: '#654321',
      });

      const projectRes = await request(server)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'http-tagged' });
      const projectId = (projectRes.body as { projectId: string }).projectId;

      const assigned = await request(server)
        .post(`/tags/${id}/projects/${projectId}`)
        .set('Cookie', cookie);
      expect(assigned.status).toBe(201);

      const byProject = await request(server)
        .get(`/tags?projectId=${projectId}`)
        .set('Cookie', cookie);
      expect(byProject.status).toBe(200);
      expect(
        (byProject.body as { tagId: string }[]).map((t) => t.tagId),
      ).toEqual([id]);

      const unassigned = await request(server)
        .delete(`/tags/${id}/projects/${projectId}`)
        .set('Cookie', cookie);
      expect(unassigned.status).toBe(200);

      const removed = await request(server)
        .delete(`/tags/${id}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/tags/${id}`)
        .set('Cookie', cookie);
      expect(gone.status).toBe(404);
    });
  });

  describe('cross-org isolation', () => {
    it('a tag is invisible and unusable outside its own organization', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const foreign = await tags.create(secondOrgCtx, { name: 'org-b-only' });

      // Same user, but acting in the first organization: the tag from the
      // second organization must not resolve, even for its creator.
      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(tags.findOne(firstOrgCtx, foreign.tagId)).rejects.toThrow(
        NotFoundException,
      );
      expect(await tags.list(firstOrgCtx)).toEqual([]);

      // Nor can it be assigned to a first-organization project.
      const project = await projects.create(firstOrgCtx, { name: 'org-a' });
      await expect(
        tags.assignToProject(firstOrgCtx, project.projectId, foreign.tagId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove cascades', () => {
    it('deleting a tag removes its project assignments', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const project = await projects.create(ownerCtx, { name: 'tagged' });
      const created = await tags.create(ownerCtx, { name: 'ephemeral' });
      await tags.assignToProject(ownerCtx, project.projectId, created.tagId);

      await tags.remove(ownerCtx, created.tagId);

      expect(await tags.listByProject(ownerCtx, project.projectId)).toEqual([]);
    });
  });

  describe('duplicate names', () => {
    it('rejects a duplicate tag name within the organization with a conflict', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await tags.create(ownerCtx, { name: 'production' });

      await expect(
        tags.create(ownerCtx, { name: 'production' }),
      ).rejects.toThrow(ConflictException);
    });

    /**
     * The filter, the tick-box dialog and every Project row show a Tag as
     * a plain word, so `frontend` and `Frontend` are one name to anyone reading
     * them — and the constraint compared bytes. Refused over HTTP because the
     * trim lives in the DTO, which the service seam never passes through.
     */
    it('refuses a name that differs from an existing one only by case or surrounding space', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;
      const conflict = {
        statusCode: 409,
        message: 'A tag with this name already exists in your organization',
      };

      const first = await request(server)
        .post('/tags')
        .set('Cookie', cookie)
        .send({ name: 'frontend' });
      expect(first.status).toBe(201);

      for (const name of ['Frontend', ' frontend ', ' FRONTEND']) {
        const again = await request(server)
          .post('/tags')
          .set('Cookie', cookie)
          .send({ name });
        expect({ name, status: again.status }).toEqual({ name, status: 409 });
        expect(again.body).toMatchObject(conflict);
      }

      const other = await request(server)
        .post('/tags')
        .set('Cookie', cookie)
        .send({ name: '  infra  ' });
      expect(other.status).toBe(201);
      expect(other.body).toMatchObject({ name: 'infra' });
      const otherId = (other.body as { tagId: string }).tagId;

      const renamed = await request(server)
        .patch(`/tags/${otherId}`)
        .set('Cookie', cookie)
        .send({ name: 'FRONTEND' });
      expect(renamed.status).toBe(409);
      expect(renamed.body).toMatchObject(conflict);

      const listed = await request(server).get('/tags').set('Cookie', cookie);
      expect((listed.body as { name: string }[]).map((t) => t.name)).toEqual([
        'frontend',
        'infra',
      ]);
    });

    it('lets a tag change the case of its own name', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await tags.create(ownerCtx, { name: 'frontend' });
      const updated = await tags.update(ownerCtx, created.tagId, {
        name: 'Frontend',
      });
      expect(updated).toMatchObject({ tagId: created.tagId, name: 'Frontend' });
    });

    it('refuses a name that is only whitespace', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const blank = await request(server)
        .post('/tags')
        .set('Cookie', ownerSession.cookie)
        .send({ name: '   ' });
      expect(blank.status).toBe(400);
    });
  });

  describe('remove', () => {
    it('deletes the tag', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await tags.create(ownerCtx, { name: 'doomed' });

      const removed = await tags.remove(ownerCtx, created.tagId);
      expect(removed.tagId).toBe(created.tagId);

      await expect(tags.findOne(ownerCtx, created.tagId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('changes the given fields and leaves the rest untouched', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await tags.create(ownerCtx, {
        name: 'before',
        color: '#00ff00',
      });

      const updated = await tags.update(ownerCtx, created.tagId, {
        name: 'after',
      });
      expect(updated).toMatchObject({
        tagId: created.tagId,
        name: 'after',
        color: '#00ff00',
      });
    });
  });

  describe('list', () => {
    it('lists the organization tags sorted by name', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await tags.create(ownerCtx, { name: 'staging' });
      await tags.create(ownerCtx, { name: 'backend' });

      const listed = await tags.list(ownerCtx);
      expect(listed.map((t) => t.name)).toEqual(['backend', 'staging']);
    });
  });

  describe('create → findOne', () => {
    it('creates a tag in the organization retrievable by id', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await tags.create(ownerCtx, {
        name: 'production',
        color: '#ff0000',
      });

      expect(created.tagId).toEqual(expect.any(String));
      expect(created.organizationId).toBe(organizationId);

      const found = await tags.findOne(ownerCtx, created.tagId);
      expect(found).toMatchObject({
        tagId: created.tagId,
        name: 'production',
        color: '#ff0000',
        organizationId,
      });
    });
  });
});
