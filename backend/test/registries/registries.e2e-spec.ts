import { NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { RegistriesService } from '../../src/registries/registries.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const dockerHub = {
  name: 'docker-hub',
  username: 'octabyte',
  password: 'registry-secret-token',
  url: '',
  registryType: 'cloud' as const,
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

describe('Registries (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let registries: RegistriesService;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
    registries = ctx.app.get(RegistriesService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  describe('create → findOne', () => {
    it('stores a registry retrievable by id, password encrypted at rest and stripped from responses', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await registries.create(ownerCtx, dockerHub);

      expect(created.registryId).toEqual(expect.any(String));
      expect(created.organizationId).toBe(organizationId);
      expect(created).not.toHaveProperty('password');

      const found = await registries.findOne(ownerCtx, created.registryId);
      expect(found).toMatchObject({
        registryId: created.registryId,
        name: 'docker-hub',
        username: 'octabyte',
        url: '',
        registryType: 'cloud',
        organizationId,
      });
      expect(found).not.toHaveProperty('password');

      const raw = await ctx.db.$client.query<{ password: string }>(
        'select password from registry where registry_id = $1',
        [created.registryId],
      );
      expect(raw.rows[0].password).not.toContain('registry-secret-token');
      expect(raw.rows[0].password.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('list', () => {
    it('lists the organization registries newest first, passwords stripped', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await registries.create(ownerCtx, { ...dockerHub, name: 'older' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await registries.create(ownerCtx, { ...dockerHub, name: 'newer' });

      const listed = await registries.list(ownerCtx);
      expect(listed.map((r) => r.name)).toEqual(['newer', 'older']);
      for (const item of listed) {
        expect(item).not.toHaveProperty('password');
      }
    });
  });

  describe('update', () => {
    it('changes the given fields; a new password is encrypted and still stripped from the response', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await registries.create(ownerCtx, dockerHub);

      const updated = await registries.update(ownerCtx, created.registryId, {
        name: 'renamed',
        url: 'registry.example.com',
        registryType: 'selfHosted',
        password: 'rotated-secret',
      });
      expect(updated).toMatchObject({
        registryId: created.registryId,
        name: 'renamed',
        url: 'registry.example.com',
        registryType: 'selfHosted',
        username: 'octabyte',
      });
      expect(updated).not.toHaveProperty('password');

      const raw = await ctx.db.$client.query<{ password: string }>(
        'select password from registry where registry_id = $1',
        [created.registryId],
      );
      expect(raw.rows[0].password).not.toContain('rotated-secret');
      expect(raw.rows[0].password.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('remove', () => {
    it('deletes the registry', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await registries.create(ownerCtx, dockerHub);

      const removed = await registries.remove(ownerCtx, created.registryId);
      expect(removed.registryId).toBe(created.registryId);
      expect(removed).not.toHaveProperty('password');

      await expect(
        registries.findOne(ownerCtx, created.registryId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('cross-org isolation', () => {
    it('a registry is invisible and unremovable outside its own organization', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const foreign = await registries.create(secondOrgCtx, {
        ...dockerHub,
        name: 'org-b-only',
      });

      // Same user, but acting in the first organization: the registry from
      // the second organization must not resolve, even for its creator.
      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        registries.findOne(firstOrgCtx, foreign.registryId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        registries.update(firstOrgCtx, foreign.registryId, { name: 'stolen' }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        registries.remove(firstOrgCtx, foreign.registryId),
      ).rejects.toThrow(NotFoundException);
      expect(await registries.list(firstOrgCtx)).toEqual([]);
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports the full CRUD round-trip over HTTP, never leaking the password', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/registries')
        .set('Cookie', cookie)
        .send(dockerHub);
      expect(created.status).toBe(201);
      expect(created.body).not.toHaveProperty('password');
      const id = (created.body as { registryId: string }).registryId;

      const rejected = await request(server)
        .post('/registries')
        .set('Cookie', cookie)
        .send({ ...dockerHub, url: 'http://registry; rm -rf /' });
      expect(rejected.status).toBe(400);

      const listed = await request(server)
        .get('/registries')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      const listedBody = listed.body as { name: string }[];
      expect(listedBody.map((r) => r.name)).toEqual(['docker-hub']);
      expect(listedBody[0]).not.toHaveProperty('password');

      const one = await request(server)
        .get(`/registries/${id}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        name: 'docker-hub',
        username: 'octabyte',
        registryType: 'cloud',
      });
      expect(one.body).not.toHaveProperty('password');

      const patched = await request(server)
        .patch(`/registries/${id}`)
        .set('Cookie', cookie)
        .send({ imagePrefix: 'octabyte-staging' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        name: 'docker-hub',
        imagePrefix: 'octabyte-staging',
      });
      expect(patched.body).not.toHaveProperty('password');

      const removed = await request(server)
        .delete(`/registries/${id}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/registries/${id}`)
        .set('Cookie', cookie);
      expect(gone.status).toBe(404);
    });
  });
});
