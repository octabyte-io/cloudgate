import { NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import type { FetchClient } from '../../src/git-providers/fetch.provider';
import { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

// A fully-connected Gitea OAuth application (the `gitea` row).
const giteaCredentials = {
  name: 'Team Gitea',
  giteaUrl: 'https://gitea.example.com',
  redirectUri: 'https://cloudgate.example.com/callback',
  clientId: 'gitea-client-id',
  clientSecret: 'gitea-client-secret',
  accessToken: 'gta-access-token',
  refreshToken: 'gtr-refresh-token',
  expiresAt: 1893456000,
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

describe('Gitea provider (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let giteaService: GiteaService;

  // The Gitea API is a system boundary: the e2e app swaps the fetch client
  // for a stub serving a fixed repository and branch listing.
  const stubFetch = ((url: string | URL) => {
    const body = String(url).includes('/branches')
      ? [{ name: 'main', commit: { id: 'abc123' } }]
      : [
          {
            id: 7,
            name: 'cloudgate',
            owner: { login: 'octabyte' },
            html_url: 'https://gitea.example.com/octabyte/cloudgate',
            default_branch: 'main',
          },
        ];
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: () => Promise.resolve(body),
    } as Response);
  }) as FetchClient;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: FETCH_CLIENT, useValue: stubFetch }],
    });
    server = ctx.app.getHttpServer() as App;
    giteaService = ctx.app.get(GiteaService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  describe('create → findOne', () => {
    it('creates the base provider row plus the gitea detail row, secrets encrypted at rest and stripped from responses', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await giteaService.create(ownerCtx, giteaCredentials);

      expect(created.giteaId).toEqual(expect.any(String));
      expect(created).toMatchObject({
        giteaUrl: 'https://gitea.example.com',
        clientId: 'gitea-client-id',
        redirectUri: 'https://cloudgate.example.com/callback',
        expiresAt: 1893456000,
        scopes: 'repo,repo:status,read:user,read:org',
      });
      expect(created).not.toHaveProperty('clientSecret');
      expect(created).not.toHaveProperty('accessToken');
      expect(created).not.toHaveProperty('refreshToken');
      expect(created.gitProvider).toMatchObject({
        name: 'Team Gitea',
        providerType: 'gitea',
        organizationId,
      });

      const found = await giteaService.findOne(ownerCtx, created.giteaId);
      expect(found).toMatchObject({
        giteaId: created.giteaId,
        gitProviderId: created.gitProviderId,
        clientId: 'gitea-client-id',
      });
      expect(found).not.toHaveProperty('clientSecret');
      expect(found).not.toHaveProperty('accessToken');
      expect(found).not.toHaveProperty('refreshToken');

      const raw = await ctx.db.$client.query<{
        client_secret: string;
        access_token: string;
        refresh_token: string;
      }>(
        'select client_secret, access_token, refresh_token from gitea where gitea_id = $1',
        [created.giteaId],
      );
      expect(raw.rows[0].client_secret).not.toContain('gitea-client-secret');
      expect(raw.rows[0].client_secret.startsWith('enc:v1:')).toBe(true);
      expect(raw.rows[0].access_token).not.toContain('gta-access-token');
      expect(raw.rows[0].access_token.startsWith('enc:v1:')).toBe(true);
      expect(raw.rows[0].refresh_token).not.toContain('gtr-refresh-token');
      expect(raw.rows[0].refresh_token.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('list', () => {
    it("returns the organization's connections, secrets stripped", async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await giteaService.create(ownerCtx, giteaCredentials);
      // A connection saved before its OAuth application exists is still the
      // organization's connection: hiding it strands the only copy of its id.
      await giteaService.create(ownerCtx, { name: 'Half-connected' });

      const listed = await giteaService.list(ownerCtx);
      expect(listed).toHaveLength(2);
      expect(listed.map((c) => c.gitProvider.name).sort()).toEqual([
        'Half-connected',
        'Team Gitea',
      ]);
      for (const connection of listed) {
        expect(connection).not.toHaveProperty('clientSecret');
        expect(connection).not.toHaveProperty('accessToken');
        expect(connection).not.toHaveProperty('refreshToken');
      }
    });
  });

  describe('update', () => {
    it('renames the base provider row and rotates credentials, re-encrypted at rest', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await giteaService.create(ownerCtx, giteaCredentials);

      const updated = await giteaService.update(ownerCtx, created.giteaId, {
        name: 'Renamed Gitea',
        accessToken: 'rotated-access-token',
      });

      expect(updated).toMatchObject({
        giteaId: created.giteaId,
        clientId: 'gitea-client-id',
        gitProvider: { name: 'Renamed Gitea' },
      });
      expect(updated).not.toHaveProperty('clientSecret');
      expect(updated).not.toHaveProperty('accessToken');
      expect(updated).not.toHaveProperty('refreshToken');

      const raw = await ctx.db.$client.query<{ access_token: string }>(
        'select access_token from gitea where gitea_id = $1',
        [created.giteaId],
      );
      expect(raw.rows[0].access_token).not.toContain('rotated-access-token');
      expect(raw.rows[0].access_token.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('cross-org isolation', () => {
    it('a connection is invisible and unwritable outside its own organization', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const foreign = await giteaService.create(secondOrgCtx, giteaCredentials);

      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        giteaService.findOne(firstOrgCtx, foreign.giteaId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        giteaService.update(firstOrgCtx, foreign.giteaId, {
          name: 'stolen',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(await giteaService.list(firstOrgCtx)).toEqual([]);
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports create, one, all and update over HTTP with secrets stripped', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      // giteaUrl is omitted: the column defaults to the hosted gitea.com.
      const { giteaUrl, ...hostedCredentials } = giteaCredentials;
      void giteaUrl;
      const created = await request(server)
        .post('/gitea')
        .set('Cookie', cookie)
        .send(hostedCredentials);
      expect(created.status).toBe(201);
      const body = created.body as { giteaId: string; giteaUrl: string };
      expect(body.giteaId).toEqual(expect.any(String));
      expect(body.giteaUrl).toBe('https://gitea.com');
      expect(created.body).not.toHaveProperty('clientSecret');
      expect(created.body).not.toHaveProperty('accessToken');
      expect(created.body).not.toHaveProperty('refreshToken');

      const rejected = await request(server)
        .post('/gitea')
        .set('Cookie', cookie)
        .send({ name: '' });
      expect(rejected.status).toBe(400);

      const one = await request(server)
        .get(`/gitea/${body.giteaId}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        clientId: 'gitea-client-id',
        gitProvider: { name: 'Team Gitea' },
      });
      expect(one.body).not.toHaveProperty('clientSecret');

      const listed = await request(server).get('/gitea').set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(listed.body as unknown[]).toHaveLength(1);

      const patched = await request(server)
        .patch(`/gitea/${body.giteaId}`)
        .set('Cookie', cookie)
        .send({ name: 'renamed' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        gitProvider: { name: 'renamed' },
      });
    });

    it('a connection saved without its OAuth application is listed, and its id round-trips through GET /gitea/:id and PATCH /gitea/:id', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      // Only an access token — no OAuth application yet.
      const created = await request(server)
        .post('/gitea')
        .set('Cookie', cookie)
        .send({
          name: 'Token-only Gitea',
          giteaUrl: 'https://gitea.example.com',
          accessToken: 'gta-access-token',
        });
      expect(created.status).toBe(201);
      const { giteaId } = created.body as { giteaId: string };

      const listed = await request(server).get('/gitea').set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(listed.body as { giteaId: string }[]).toHaveLength(1);
      expect((listed.body as { giteaId: string }[])[0].giteaId).toBe(giteaId);

      const one = await request(server)
        .get(`/gitea/${giteaId}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ giteaId });

      // The OAuth application arrives later; the same row takes it and is
      // still listed exactly once.
      const patched = await request(server)
        .patch(`/gitea/${giteaId}`)
        .set('Cookie', cookie)
        .send({
          clientId: 'gitea-client-id',
          clientSecret: 'gitea-client-secret',
        });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        giteaId,
        clientId: 'gitea-client-id',
      });

      const relisted = await request(server)
        .get('/gitea')
        .set('Cookie', cookie);
      expect(relisted.body as { giteaId: string }[]).toHaveLength(1);
      expect((relisted.body as { giteaId: string }[])[0].giteaId).toBe(giteaId);
    });

    it('lists repositories and branches through the connection', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/gitea')
        .set('Cookie', cookie)
        .send(giteaCredentials);
      const { giteaId } = created.body as { giteaId: string };

      const repositories = await request(server)
        .get(`/gitea/${giteaId}/repositories`)
        .set('Cookie', cookie);
      expect(repositories.status).toBe(200);
      expect(repositories.body).toEqual([
        {
          id: 7,
          name: 'cloudgate',
          owner: 'octabyte',
          url: 'https://gitea.example.com/octabyte/cloudgate',
          // Read off Gitea's `default_branch`.
          defaultBranch: 'main',
        },
      ]);

      const branches = await request(server)
        .get(`/gitea/${giteaId}/branches`)
        .query({ owner: 'octabyte', repo: 'cloudgate' })
        .set('Cookie', cookie);
      expect(branches.status).toBe(200);
      expect(branches.body).toEqual([{ name: 'main', commitSha: 'abc123' }]);

      const missingParams = await request(server)
        .get(`/gitea/${giteaId}/branches`)
        .set('Cookie', cookie);
      expect(missingParams.status).toBe(400);
    });
  });
});
