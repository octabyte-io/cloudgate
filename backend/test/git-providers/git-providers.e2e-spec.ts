import { NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { GitProvidersService } from '../../src/git-providers/git-providers.service';
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

describe('Git providers (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let gitProviders: GitProvidersService;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
    gitProviders = ctx.app.get(GitProvidersService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  describe('create → findOne', () => {
    it('stores a provider retrievable by id inside its organization', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await gitProviders.create(ownerCtx, {
        name: 'Team GitHub',
        providerType: 'github',
      });

      expect(created.gitProviderId).toEqual(expect.any(String));
      expect(created.organizationId).toBe(organizationId);

      const found = await gitProviders.findOne(ownerCtx, created.gitProviderId);
      expect(found).toMatchObject({
        gitProviderId: created.gitProviderId,
        name: 'Team GitHub',
        providerType: 'github',
        organizationId,
      });
    });
  });

  describe('list', () => {
    it('lists the organization providers newest first', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await gitProviders.create(ownerCtx, {
        name: 'older',
        providerType: 'github',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await gitProviders.create(ownerCtx, {
        name: 'newer',
        providerType: 'gitlab',
      });

      const listed = await gitProviders.list(ownerCtx);
      expect(listed.map((p) => p.name)).toEqual(['newer', 'older']);
    });
  });

  describe('update', () => {
    it('changes the given fields', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await gitProviders.create(ownerCtx, {
        name: 'Team GitHub',
        providerType: 'github',
      });

      const updated = await gitProviders.update(
        ownerCtx,
        created.gitProviderId,
        { name: 'renamed' },
      );
      expect(updated).toMatchObject({
        gitProviderId: created.gitProviderId,
        name: 'renamed',
        providerType: 'github',
      });
    });
  });

  describe('remove', () => {
    it('deletes the provider', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await gitProviders.create(ownerCtx, {
        name: 'Team GitHub',
        providerType: 'github',
      });

      const removed = await gitProviders.remove(
        ownerCtx,
        created.gitProviderId,
      );
      expect(removed.gitProviderId).toBe(created.gitProviderId);

      await expect(
        gitProviders.findOne(ownerCtx, created.gitProviderId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('cross-org isolation', () => {
    it('a provider is invisible and unremovable outside its own organization', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const foreign = await gitProviders.create(secondOrgCtx, {
        name: 'org-b-only',
        providerType: 'gitea',
      });

      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        gitProviders.findOne(firstOrgCtx, foreign.gitProviderId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        gitProviders.update(firstOrgCtx, foreign.gitProviderId, {
          name: 'stolen',
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        gitProviders.remove(firstOrgCtx, foreign.gitProviderId),
      ).rejects.toThrow(NotFoundException);
      expect(await gitProviders.list(firstOrgCtx)).toEqual([]);
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports the full CRUD round-trip over HTTP', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/git-providers')
        .set('Cookie', cookie)
        .send({ name: 'Team GitHub', providerType: 'github' });
      expect(created.status).toBe(201);
      const id = (created.body as { gitProviderId: string }).gitProviderId;

      const rejected = await request(server)
        .post('/git-providers')
        .set('Cookie', cookie)
        .send({ name: '', providerType: 'github' });
      expect(rejected.status).toBe(400);

      const badType = await request(server)
        .post('/git-providers')
        .set('Cookie', cookie)
        .send({ name: 'x', providerType: 'svn' });
      expect(badType.status).toBe(400);

      const listed = await request(server)
        .get('/git-providers')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect((listed.body as { name: string }[]).map((p) => p.name)).toEqual([
        'Team GitHub',
      ]);

      const one = await request(server)
        .get(`/git-providers/${id}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        name: 'Team GitHub',
        providerType: 'github',
      });

      const patched = await request(server)
        .patch(`/git-providers/${id}`)
        .set('Cookie', cookie)
        .send({ name: 'renamed' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ name: 'renamed' });

      const removed = await request(server)
        .delete(`/git-providers/${id}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/git-providers/${id}`)
        .set('Cookie', cookie);
      expect(gone.status).toBe(404);
    });
  });
});
