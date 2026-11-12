import { NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import type { FetchClient } from '../../src/git-providers/fetch.provider';
import { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

// A fully-connected GitLab OAuth application (the `gitlab` row).
const gitlabCredentials = {
  name: 'Team GitLab',
  gitlabUrl: 'https://gitlab.example.com',
  gitlabInternalUrl: 'http://gitlab.internal:8080',
  applicationId: 'gitlab-application-id',
  redirectUri: 'https://cloudgate.example.com/callback',
  secret: 'gitlab-oauth-secret',
  accessToken: 'glpat-access-token',
  refreshToken: 'glrt-refresh-token',
  groupName: 'octabyte',
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

describe('GitLab provider (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let gitlabService: GitlabService;

  // The GitLab API is a system boundary: the e2e app swaps the fetch client
  // for a stub serving a fixed project and branch listing.
  const stubFetch = ((url: string | URL) => {
    const body = String(url).includes('/repository/branches')
      ? [{ name: 'main', commit: { id: 'abc123' } }]
      : [
          {
            id: 43,
            name: 'infra',
            path_with_namespace: 'octabyte/infra',
            default_branch: 'main',
            namespace: {
              path: 'octabyte',
              full_path: 'octabyte',
              kind: 'group',
            },
          },
        ];
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'x-total': '1' }),
      json: () => Promise.resolve(body),
    } as Response);
  }) as FetchClient;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: FETCH_CLIENT, useValue: stubFetch }],
    });
    server = ctx.app.getHttpServer() as App;
    gitlabService = ctx.app.get(GitlabService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  describe('create → findOne', () => {
    it('creates the base provider row plus the gitlab detail row, secrets encrypted at rest and stripped from responses', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await gitlabService.create(ownerCtx, gitlabCredentials);

      expect(created.gitlabId).toEqual(expect.any(String));
      expect(created).toMatchObject({
        gitlabUrl: 'https://gitlab.example.com',
        gitlabInternalUrl: 'http://gitlab.internal:8080',
        applicationId: 'gitlab-application-id',
        redirectUri: 'https://cloudgate.example.com/callback',
        groupName: 'octabyte',
        expiresAt: 1893456000,
      });
      expect(created).not.toHaveProperty('secret');
      expect(created).not.toHaveProperty('accessToken');
      expect(created).not.toHaveProperty('refreshToken');
      expect(created.gitProvider).toMatchObject({
        name: 'Team GitLab',
        providerType: 'gitlab',
        organizationId,
      });

      const found = await gitlabService.findOne(ownerCtx, created.gitlabId);
      expect(found).toMatchObject({
        gitlabId: created.gitlabId,
        gitProviderId: created.gitProviderId,
        applicationId: 'gitlab-application-id',
      });
      expect(found).not.toHaveProperty('secret');
      expect(found).not.toHaveProperty('accessToken');
      expect(found).not.toHaveProperty('refreshToken');

      const raw = await ctx.db.$client.query<{
        secret: string;
        access_token: string;
        refresh_token: string;
      }>(
        'select secret, access_token, refresh_token from gitlab where gitlab_id = $1',
        [created.gitlabId],
      );
      expect(raw.rows[0].secret).not.toContain('gitlab-oauth-secret');
      expect(raw.rows[0].secret.startsWith('enc:v1:')).toBe(true);
      expect(raw.rows[0].access_token).not.toContain('glpat-access-token');
      expect(raw.rows[0].access_token.startsWith('enc:v1:')).toBe(true);
      expect(raw.rows[0].refresh_token).not.toContain('glrt-refresh-token');
      expect(raw.rows[0].refresh_token.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('list', () => {
    it("returns the organization's connections, secrets stripped", async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await gitlabService.create(ownerCtx, gitlabCredentials);
      // A connection whose OAuth flow has not completed (no tokens yet) is
      // still the organization's connection: hiding it strands the only copy
      // of its id.
      await gitlabService.create(ownerCtx, {
        name: 'Half-connected',
        applicationId: 'other-app-id',
        secret: 'other-secret',
      });

      const listed = await gitlabService.list(ownerCtx);
      expect(listed).toHaveLength(2);
      expect(listed.map((c) => c.gitProvider.name).sort()).toEqual([
        'Half-connected',
        'Team GitLab',
      ]);
      for (const connection of listed) {
        expect(connection).not.toHaveProperty('secret');
        expect(connection).not.toHaveProperty('accessToken');
        expect(connection).not.toHaveProperty('refreshToken');
      }
    });
  });

  describe('update', () => {
    it('renames the base provider row and rotates credentials, re-encrypted at rest', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await gitlabService.create(ownerCtx, gitlabCredentials);

      const updated = await gitlabService.update(ownerCtx, created.gitlabId, {
        name: 'Renamed GitLab',
        accessToken: 'rotated-access-token',
        groupName: 'octabyte,cloudgate',
      });

      expect(updated).toMatchObject({
        gitlabId: created.gitlabId,
        groupName: 'octabyte,cloudgate',
        applicationId: 'gitlab-application-id',
        gitProvider: { name: 'Renamed GitLab' },
      });
      expect(updated).not.toHaveProperty('secret');
      expect(updated).not.toHaveProperty('accessToken');
      expect(updated).not.toHaveProperty('refreshToken');

      const raw = await ctx.db.$client.query<{ access_token: string }>(
        'select access_token from gitlab where gitlab_id = $1',
        [created.gitlabId],
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
      const foreign = await gitlabService.create(
        secondOrgCtx,
        gitlabCredentials,
      );

      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        gitlabService.findOne(firstOrgCtx, foreign.gitlabId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        gitlabService.update(firstOrgCtx, foreign.gitlabId, {
          name: 'stolen',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(await gitlabService.list(firstOrgCtx)).toEqual([]);
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports create, one, all and update over HTTP with secrets stripped', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      // gitlabUrl is omitted: the column defaults to the hosted gitlab.com.
      const { gitlabUrl, gitlabInternalUrl, ...hostedCredentials } =
        gitlabCredentials;
      void gitlabUrl;
      void gitlabInternalUrl;
      const created = await request(server)
        .post('/gitlab')
        .set('Cookie', cookie)
        .send(hostedCredentials);
      expect(created.status).toBe(201);
      const body = created.body as { gitlabId: string; gitlabUrl: string };
      expect(body.gitlabId).toEqual(expect.any(String));
      expect(body.gitlabUrl).toBe('https://gitlab.com');
      expect(created.body).not.toHaveProperty('secret');
      expect(created.body).not.toHaveProperty('accessToken');
      expect(created.body).not.toHaveProperty('refreshToken');

      const rejected = await request(server)
        .post('/gitlab')
        .set('Cookie', cookie)
        .send({ name: '' });
      expect(rejected.status).toBe(400);

      const one = await request(server)
        .get(`/gitlab/${body.gitlabId}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        applicationId: 'gitlab-application-id',
        gitProvider: { name: 'Team GitLab' },
      });
      expect(one.body).not.toHaveProperty('secret');

      const listed = await request(server).get('/gitlab').set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(listed.body as unknown[]).toHaveLength(1);

      const patched = await request(server)
        .patch(`/gitlab/${body.gitlabId}`)
        .set('Cookie', cookie)
        .send({ name: 'renamed' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        gitProvider: { name: 'renamed' },
      });
    });

    it('a connection saved before its OAuth flow completes is listed, and its id round-trips through GET /gitlab/:id and PATCH /gitlab/:id', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      // The OAuth application exists but the callback has not run yet, so
      // there is no token pair.
      const created = await request(server)
        .post('/gitlab')
        .set('Cookie', cookie)
        .send({
          name: 'Half-connected',
          applicationId: 'gitlab-application-id',
          secret: 'gitlab-oauth-secret',
        });
      expect(created.status).toBe(201);
      const { gitlabId } = created.body as { gitlabId: string };

      const listed = await request(server).get('/gitlab').set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(listed.body as { gitlabId: string }[]).toHaveLength(1);
      expect((listed.body as { gitlabId: string }[])[0].gitlabId).toBe(
        gitlabId,
      );

      const one = await request(server)
        .get(`/gitlab/${gitlabId}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ gitlabId });

      // The token pair arrives later; the same row takes it and is still
      // listed exactly once.
      const patched = await request(server)
        .patch(`/gitlab/${gitlabId}`)
        .set('Cookie', cookie)
        .send({
          accessToken: 'glpat-access-token',
          refreshToken: 'glrt-refresh-token',
        });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ gitlabId });

      const relisted = await request(server)
        .get('/gitlab')
        .set('Cookie', cookie);
      expect(relisted.body as { gitlabId: string }[]).toHaveLength(1);
      expect((relisted.body as { gitlabId: string }[])[0].gitlabId).toBe(
        gitlabId,
      );
    });

    it('lists repositories and branches through the connection', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/gitlab')
        .set('Cookie', cookie)
        .send(gitlabCredentials);
      const { gitlabId } = created.body as { gitlabId: string };

      const repositories = await request(server)
        .get(`/gitlab/${gitlabId}/repositories`)
        .set('Cookie', cookie);
      expect(repositories.status).toBe(200);
      expect(repositories.body).toEqual([
        {
          id: 43,
          name: 'infra',
          owner: 'octabyte',
          pathNamespace: 'octabyte/infra',
          // Read off GitLab's `default_branch`.
          defaultBranch: 'main',
        },
      ]);

      const branches = await request(server)
        .get(`/gitlab/${gitlabId}/branches`)
        .query({ projectId: 43 })
        .set('Cookie', cookie);
      expect(branches.status).toBe(200);
      expect(branches.body).toEqual([{ name: 'main', commitSha: 'abc123' }]);

      const missingParams = await request(server)
        .get(`/gitlab/${gitlabId}/branches`)
        .set('Cookie', cookie);
      expect(missingParams.status).toBe(400);
    });
  });
});
