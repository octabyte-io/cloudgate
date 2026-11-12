import { NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { utils as sshUtils } from 'ssh2';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * A real pair, because a pasted one is now parsed and matched before it is
 * stored — the fake armour this file used to paste is exactly what that
 * refuses. `privateKeyMaterial` is a line from inside the private half's body,
 * the bytes the "never leaves the server" tests look for on the wire.
 */
const generatedPair = sshUtils.generateKeyPairSync('ed25519', {
  comment: 'test',
});
const suppliedKeyPair = {
  publicKey: generatedPair.public,
  privateKey: generatedPair.private,
};
const privateKeyMaterial = generatedPair.private.split('\n')[2];

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

describe('SSH keys (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let sshKeys: SshKeysService;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
    sshKeys = ctx.app.get(SshKeysService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  describe('create → findOne', () => {
    it('stores a supplied keypair retrievable by id, private key encrypted at rest', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await sshKeys.create(ownerCtx, {
        name: 'deploy-key',
        description: 'used by the staging server',
        ...suppliedKeyPair,
      });

      expect(created.sshKeyId).toEqual(expect.any(String));
      expect(created.organizationId).toBe(organizationId);

      // findOneWithPrivateKey is the internal accessor: the private key
      // round-trips for server-side consumers, but never over HTTP.
      const found = await sshKeys.findOneWithPrivateKey(
        ownerCtx,
        created.sshKeyId,
      );
      expect(found).toMatchObject({
        sshKeyId: created.sshKeyId,
        name: 'deploy-key',
        description: 'used by the staging server',
        publicKey: suppliedKeyPair.publicKey,
        privateKey: suppliedKeyPair.privateKey,
        organizationId,
      });

      const raw = await ctx.db.$client.query<{ private_key: string }>(
        'select private_key from ssh_key where ssh_key_id = $1',
        [created.sshKeyId],
      );
      expect(raw.rows[0].private_key).not.toContain(privateKeyMaterial);
      expect(raw.rows[0].private_key.startsWith('enc:v1:')).toBe(true);
    });

    it('generates a keypair when none is supplied', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await sshKeys.create(ownerCtx, { name: 'generated' });

      const found = await sshKeys.findOneWithPrivateKey(
        ownerCtx,
        created.sshKeyId,
      );
      // A generated key defaults to RSA (4096 bits).
      expect(found.publicKey.startsWith('ssh-rsa ')).toBe(true);
      expect(found.privateKey).toContain('PRIVATE KEY-----');
    });

    it('generates an ed25519 keypair when that type is requested', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await sshKeys.create(ownerCtx, {
        name: 'generated-ed25519',
        type: 'ed25519',
      });

      const found = await sshKeys.findOneWithPrivateKey(
        ownerCtx,
        created.sshKeyId,
      );
      expect(found.publicKey.startsWith('ssh-ed25519 ')).toBe(true);
      expect(found.privateKey).toContain('PRIVATE KEY-----');
    });
  });

  describe('list', () => {
    it('lists the organization keys newest first', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await sshKeys.create(ownerCtx, { name: 'older', ...suppliedKeyPair });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await sshKeys.create(ownerCtx, { name: 'newer', ...suppliedKeyPair });

      const listed = await sshKeys.list(ownerCtx);
      // The list orders by createdAt desc.
      expect(listed.map((k) => k.name)).toEqual(['newer', 'older']);
    });
  });

  describe('remove', () => {
    it('deletes the key', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await sshKeys.create(ownerCtx, {
        name: 'doomed',
        ...suppliedKeyPair,
      });

      const removed = await sshKeys.remove(ownerCtx, created.sshKeyId);
      expect(removed.sshKeyId).toBe(created.sshKeyId);
      // Nothing needs the private key back after a delete.
      expect(removed).not.toHaveProperty('privateKey');

      await expect(sshKeys.findOne(ownerCtx, created.sshKeyId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('changes the given fields and leaves the keypair untouched', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await sshKeys.create(ownerCtx, {
        name: 'before',
        ...suppliedKeyPair,
      });

      const updated = await sshKeys.update(ownerCtx, created.sshKeyId, {
        name: 'after',
        description: 'rotated soon',
        lastUsedAt: '2026-07-16T00:00:00.000Z',
      });
      expect(updated).toMatchObject({
        sshKeyId: created.sshKeyId,
        name: 'after',
        description: 'rotated soon',
        lastUsedAt: '2026-07-16T00:00:00.000Z',
        publicKey: suppliedKeyPair.publicKey,
      });
      // Nothing needs the private key back after a rename.
      expect(updated).not.toHaveProperty('privateKey');

      // The keypair is still the one that was stored — the internal accessor
      // is the only way to see that.
      const found = await sshKeys.findOneWithPrivateKey(
        ownerCtx,
        created.sshKeyId,
      );
      expect(found.privateKey).toBe(suppliedKeyPair.privateKey);
    });
  });

  describe('cross-org isolation', () => {
    it('a key is invisible and unremovable outside its own organization', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const foreign = await sshKeys.create(secondOrgCtx, {
        name: 'org-b-only',
        ...suppliedKeyPair,
      });

      // Same user, but acting in the first organization: the key from the
      // second organization must not resolve, even for its creator.
      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        sshKeys.findOne(firstOrgCtx, foreign.sshKeyId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        sshKeys.remove(firstOrgCtx, foreign.sshKeyId),
      ).rejects.toThrow(NotFoundException);
      expect(await sshKeys.list(firstOrgCtx)).toEqual([]);
    });
  });

  /**
   * At the HTTP boundary: the U-run's two pastes, which were stored and
   * listed as keys, and the pair whose halves do not match. Each is a 400 on
   * the field that is wrong, and the table is still empty afterwards.
   */
  describe('POST /ssh-keys refuses a pasted pair it cannot use', () => {
    const otherPair = sshUtils.generateKeyPairSync('ed25519');

    it.each([
      [
        'a public half that is not a key',
        {
          publicKey: 'hello this is not a key',
          privateKey: suppliedKeyPair.privateKey,
        },
        ['publicKey'],
      ],
      [
        'a private half that is not a key',
        {
          publicKey: suppliedKeyPair.publicKey,
          privateKey:
            '-----BEGIN OPENSSH PRIVATE KEY-----\nnot really\n-----END OPENSSH PRIVATE KEY-----',
        },
        ['privateKey'],
      ],
      [
        'halves from two different pairs',
        {
          publicKey: otherPair.public,
          privateKey: suppliedKeyPair.privateKey,
        },
        ['privateKey'],
      ],
    ])('answers 400 for %s and stores nothing', async (_case, pair, paths) => {
      const { owner: ownerSession } = await setUpOwner(server);

      const refused = await request(server)
        .post('/ssh-keys')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'ui-garbage', ...pair });

      expect(refused.status).toBe(400);
      const details = (
        refused.body as { details: { path: string; message: string }[] }
      ).details;
      expect(details.map((d) => d.path)).toEqual(paths);
      // A refusal quotes ssh2's reason, never the pasted private bytes.
      expect(JSON.stringify(refused.body)).not.toContain(privateKeyMaterial);

      const stored = await ctx.db.$client.query(
        'select 1 from ssh_key where name = $1',
        ['ui-garbage'],
      );
      expect(stored.rows).toHaveLength(0);
    });
  });

  describe('private key never leaves the server', () => {
    it('GET /ssh-keys returns the organization keys with no private key material', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      await request(server)
        .post('/ssh-keys')
        .set('Cookie', cookie)
        .send({
          name: 'leaky',
          description: 'used by the staging server',
          ...suppliedKeyPair,
        });

      const listed = await request(server)
        .get('/ssh-keys')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);

      const rows = listed.body as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('privateKey');
      // Belt and braces: no private key bytes anywhere on the wire.
      expect(JSON.stringify(listed.body)).not.toContain(privateKeyMaterial);
      // The fields the pickers do read survive the sanitization.
      expect(rows[0]).toMatchObject({
        name: 'leaky',
        description: 'used by the staging server',
        publicKey: suppliedKeyPair.publicKey,
        organizationId,
      });
      expect(typeof rows[0].sshKeyId).toBe('string');
      expect(typeof rows[0].createdAt).toBe('string');
      expect(Object.keys(rows[0]).sort()).toEqual([
        'createdAt',
        'description',
        'lastUsedAt',
        'name',
        'organizationId',
        'publicKey',
        'sshKeyId',
      ]);
    });

    it('GET /ssh-keys/:id returns the one key with no private key material', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/ssh-keys')
        .set('Cookie', cookie)
        .send({
          name: 'leaky-one',
          description: 'used by the staging server',
          ...suppliedKeyPair,
        });
      const id = (created.body as { sshKeyId: string }).sshKeyId;

      const one = await request(server)
        .get(`/ssh-keys/${id}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);

      const body = one.body as Record<string, unknown>;
      expect(body).not.toHaveProperty('privateKey');
      expect(JSON.stringify(one.body)).not.toContain(privateKeyMaterial);
      expect(body).toMatchObject({
        sshKeyId: id,
        name: 'leaky-one',
        description: 'used by the staging server',
        publicKey: suppliedKeyPair.publicKey,
      });
      expect(Object.keys(body).sort()).toEqual([
        'createdAt',
        'description',
        'lastUsedAt',
        'name',
        'organizationId',
        'publicKey',
        'sshKeyId',
      ]);
    });

    it('POST /ssh-keys does not echo an imported private key back', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const created = await request(server)
        .post('/ssh-keys')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'imported', ...suppliedKeyPair });
      expect(created.status).toBe(201);

      // The caller supplied the private half, so it already has it; sending it
      // back only widens where the bytes travel.
      expect(created.body).not.toHaveProperty('privateKey');
      expect(JSON.stringify(created.body)).not.toContain(privateKeyMaterial);
      expect(Object.keys(created.body as object).sort()).toEqual([
        'createdAt',
        'description',
        'lastUsedAt',
        'name',
        'organizationId',
        'publicKey',
        'sshKeyId',
      ]);
    });

    it('POST /ssh-keys returns a generated private key, the one place it is ever visible', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const created = await request(server)
        .post('/ssh-keys')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'generated-over-http', type: 'ed25519' });
      expect(created.status).toBe(201);

      const body = created.body as Record<string, unknown>;
      expect(typeof body.privateKey).toBe('string');
      expect(body.privateKey as string).toContain('PRIVATE KEY-----');
      expect((body.publicKey as string).startsWith('ssh-ed25519 ')).toBe(true);

      // …and only here. The reads never hand it back again.
      const id = body.sshKeyId as string;
      const one = await request(server)
        .get(`/ssh-keys/${id}`)
        .set('Cookie', ownerSession.cookie);
      expect(one.body).not.toHaveProperty('privateKey');
    });

    it('PATCH /ssh-keys/:id returns the renamed key with no private key material', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/ssh-keys')
        .set('Cookie', cookie)
        .send({ name: 'before-http', ...suppliedKeyPair });
      const id = (created.body as { sshKeyId: string }).sshKeyId;

      const patched = await request(server)
        .patch(`/ssh-keys/${id}`)
        .set('Cookie', cookie)
        .send({ name: 'after-http' });
      expect(patched.status).toBe(200);

      expect(patched.body).not.toHaveProperty('privateKey');
      expect(JSON.stringify(patched.body)).not.toContain(privateKeyMaterial);
      expect(patched.body).toMatchObject({
        sshKeyId: id,
        name: 'after-http',
        publicKey: suppliedKeyPair.publicKey,
      });
      expect(Object.keys(patched.body as object).sort()).toEqual([
        'createdAt',
        'description',
        'lastUsedAt',
        'name',
        'organizationId',
        'publicKey',
        'sshKeyId',
      ]);
    });

    it('DELETE /ssh-keys/:id returns the deleted key with no private key material', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/ssh-keys')
        .set('Cookie', cookie)
        .send({ name: 'doomed-http', ...suppliedKeyPair });
      const id = (created.body as { sshKeyId: string }).sshKeyId;

      const removed = await request(server)
        .delete(`/ssh-keys/${id}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      expect(removed.body).not.toHaveProperty('privateKey');
      expect(JSON.stringify(removed.body)).not.toContain(privateKeyMaterial);
      expect(removed.body).toMatchObject({ sshKeyId: id, name: 'doomed-http' });
      expect(Object.keys(removed.body as object).sort()).toEqual([
        'createdAt',
        'description',
        'lastUsedAt',
        'name',
        'organizationId',
        'publicKey',
        'sshKeyId',
      ]);
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports the full CRUD round-trip over HTTP', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/ssh-keys')
        .set('Cookie', cookie)
        .send({ name: 'http-key', ...suppliedKeyPair });
      expect(created.status).toBe(201);
      const id = (created.body as { sshKeyId: string }).sshKeyId;

      const generated = await request(server)
        .post('/ssh-keys')
        .set('Cookie', cookie)
        .send({ name: 'http-generated', type: 'ed25519' });
      expect(generated.status).toBe(201);
      expect(
        (generated.body as { publicKey: string }).publicKey.startsWith(
          'ssh-ed25519 ',
        ),
      ).toBe(true);

      const listed = await request(server)
        .get('/ssh-keys')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect((listed.body as { name: string }[]).map((k) => k.name)).toEqual([
        'http-generated',
        'http-key',
      ]);

      const one = await request(server)
        .get(`/ssh-keys/${id}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        name: 'http-key',
        publicKey: suppliedKeyPair.publicKey,
      });

      const patched = await request(server)
        .patch(`/ssh-keys/${id}`)
        .set('Cookie', cookie)
        .send({ description: 'renamed over http' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        name: 'http-key',
        description: 'renamed over http',
      });

      const removed = await request(server)
        .delete(`/ssh-keys/${id}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/ssh-keys/${id}`)
        .set('Cookie', cookie);
      expect(gone.status).toBe(404);
    });
  });
});
