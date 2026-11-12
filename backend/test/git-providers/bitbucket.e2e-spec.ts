import { NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import type { FetchClient } from '../../src/git-providers/fetch.provider';
import { BitbucketService } from '../../src/git-providers/strategies/bitbucket/bitbucket.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

// A Bitbucket connection (the `bitbucket` row) carrying both credential
// styles — the API token wins where both are present.
const bitbucketCredentials = {
  name: 'Team Bitbucket',
  bitbucketUsername: 'grace',
  bitbucketEmail: 'grace@example.com',
  appPassword: 'bb-app-password',
  apiToken: 'bb-api-token',
  bitbucketWorkspaceName: 'octabyte',
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

describe('Bitbucket provider (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let bitbucketService: BitbucketService;

  // The Bitbucket API is a system boundary: the e2e app swaps the fetch
  // client for a stub serving a fixed repository and branch listing.
  const stubFetch = ((url: string | URL) => {
    const body = String(url).includes('/refs/branches')
      ? {
          values: [{ name: 'main', target: { hash: 'abc123' } }],
          next: null,
        }
      : {
          values: [
            {
              name: 'cloudgate',
              slug: 'cloudgate',
              links: {
                html: { href: 'https://bitbucket.org/octabyte/cloudgate' },
              },
              workspace: { slug: 'octabyte' },
              mainbranch: { name: 'main' },
            },
          ],
          next: null,
        };
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
    bitbucketService = ctx.app.get(BitbucketService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  describe('create → findOne', () => {
    it('creates the base provider row plus the bitbucket detail row, secrets encrypted at rest and stripped from responses', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await bitbucketService.create(
        ownerCtx,
        bitbucketCredentials,
      );

      expect(created.bitbucketId).toEqual(expect.any(String));
      expect(created).toMatchObject({
        bitbucketUsername: 'grace',
        bitbucketEmail: 'grace@example.com',
        bitbucketWorkspaceName: 'octabyte',
      });
      expect(created).not.toHaveProperty('appPassword');
      expect(created).not.toHaveProperty('apiToken');
      expect(created.gitProvider).toMatchObject({
        name: 'Team Bitbucket',
        providerType: 'bitbucket',
        organizationId,
      });

      const found = await bitbucketService.findOne(
        ownerCtx,
        created.bitbucketId,
      );
      expect(found).toMatchObject({
        bitbucketId: created.bitbucketId,
        gitProviderId: created.gitProviderId,
        bitbucketUsername: 'grace',
      });
      expect(found).not.toHaveProperty('appPassword');
      expect(found).not.toHaveProperty('apiToken');

      const raw = await ctx.db.$client.query<{
        app_password: string;
        api_token: string;
      }>(
        'select app_password, api_token from bitbucket where bitbucket_id = $1',
        [created.bitbucketId],
      );
      expect(raw.rows[0].app_password).not.toContain('bb-app-password');
      expect(raw.rows[0].app_password.startsWith('enc:v1:')).toBe(true);
      expect(raw.rows[0].api_token).not.toContain('bb-api-token');
      expect(raw.rows[0].api_token.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('list', () => {
    it("returns the organization's connections, secrets stripped", async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await bitbucketService.create(ownerCtx, bitbucketCredentials);
      // The list applies no credential filter: Basic-auth credentials have no
      // OAuth callback to wait for.
      await bitbucketService.create(ownerCtx, { name: 'Bare Bitbucket' });

      const listed = await bitbucketService.list(ownerCtx);
      expect(listed).toHaveLength(2);
      for (const connection of listed) {
        expect(connection).not.toHaveProperty('appPassword');
        expect(connection).not.toHaveProperty('apiToken');
      }
    });
  });

  describe('update', () => {
    it('renames the base provider row and rotates credentials, re-encrypted at rest', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await bitbucketService.create(
        ownerCtx,
        bitbucketCredentials,
      );

      const updated = await bitbucketService.update(
        ownerCtx,
        created.bitbucketId,
        {
          name: 'Renamed Bitbucket',
          apiToken: 'rotated-api-token',
          bitbucketWorkspaceName: 'cloudgate',
        },
      );

      expect(updated).toMatchObject({
        bitbucketId: created.bitbucketId,
        bitbucketWorkspaceName: 'cloudgate',
        bitbucketUsername: 'grace',
        gitProvider: { name: 'Renamed Bitbucket' },
      });
      expect(updated).not.toHaveProperty('appPassword');
      expect(updated).not.toHaveProperty('apiToken');

      const raw = await ctx.db.$client.query<{ api_token: string }>(
        'select api_token from bitbucket where bitbucket_id = $1',
        [created.bitbucketId],
      );
      expect(raw.rows[0].api_token).not.toContain('rotated-api-token');
      expect(raw.rows[0].api_token.startsWith('enc:v1:')).toBe(true);
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
      const foreign = await bitbucketService.create(
        secondOrgCtx,
        bitbucketCredentials,
      );

      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        bitbucketService.findOne(firstOrgCtx, foreign.bitbucketId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        bitbucketService.update(firstOrgCtx, foreign.bitbucketId, {
          name: 'stolen',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(await bitbucketService.list(firstOrgCtx)).toEqual([]);
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports create, one, all and update over HTTP with secrets stripped', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/bitbucket')
        .set('Cookie', cookie)
        .send(bitbucketCredentials);
      expect(created.status).toBe(201);
      const body = created.body as { bitbucketId: string };
      expect(body.bitbucketId).toEqual(expect.any(String));
      expect(created.body).not.toHaveProperty('appPassword');
      expect(created.body).not.toHaveProperty('apiToken');

      const rejected = await request(server)
        .post('/bitbucket')
        .set('Cookie', cookie)
        .send({ name: '' });
      expect(rejected.status).toBe(400);

      const one = await request(server)
        .get(`/bitbucket/${body.bitbucketId}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        bitbucketUsername: 'grace',
        gitProvider: { name: 'Team Bitbucket' },
      });
      expect(one.body).not.toHaveProperty('appPassword');

      const listed = await request(server)
        .get('/bitbucket')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(listed.body as unknown[]).toHaveLength(1);

      const patched = await request(server)
        .patch(`/bitbucket/${body.bitbucketId}`)
        .set('Cookie', cookie)
        .send({ name: 'renamed' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        gitProvider: { name: 'renamed' },
      });
    });

    it('lists repositories and branches through the connection', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/bitbucket')
        .set('Cookie', cookie)
        .send(bitbucketCredentials);
      const { bitbucketId } = created.body as { bitbucketId: string };

      const repositories = await request(server)
        .get(`/bitbucket/${bitbucketId}/repositories`)
        .set('Cookie', cookie);
      expect(repositories.status).toBe(200);
      expect(repositories.body).toEqual([
        {
          name: 'cloudgate',
          slug: 'cloudgate',
          owner: 'octabyte',
          url: 'https://bitbucket.org/octabyte/cloudgate',
          // Read off Bitbucket's `mainbranch`.
          defaultBranch: 'main',
        },
      ]);

      const branches = await request(server)
        .get(`/bitbucket/${bitbucketId}/branches`)
        .query({ owner: 'octabyte', repo: 'cloudgate' })
        .set('Cookie', cookie);
      expect(branches.status).toBe(200);
      expect(branches.body).toEqual([{ name: 'main', commitSha: 'abc123' }]);

      const missingParams = await request(server)
        .get(`/bitbucket/${bitbucketId}/branches`)
        .set('Cookie', cookie);
      expect(missingParams.status).toBe(400);
    });
  });
});
