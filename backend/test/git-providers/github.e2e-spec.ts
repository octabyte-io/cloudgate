import { createHmac } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { OCTOKIT_FACTORY } from '../../src/git-providers/strategies/github/octokit.provider';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

// A fully-configured GitHub App connection (the `github` row).
const appCredentials = {
  name: 'Team GitHub',
  appName: 'cloudgate-app',
  appId: 12345,
  clientId: 'Iv1.abc123',
  clientSecret: 'github-client-secret',
  installationId: '99887766',
  privateKey:
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----',
  webhookSecret: 'wh-secret',
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

describe('GitHub provider (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let githubService: GithubService;

  // The GitHub API is a system boundary: the e2e app swaps the octokit
  // factory for a stub serving fixed repositories and branches.
  const stubOctokit = {
    rest: {
      apps: { listReposAccessibleToInstallation: 'repos-endpoint' },
      repos: { listBranches: 'branches-endpoint' },
    },
    auth: () => Promise.resolve({ token: 'ghs_stub-token' }),
    paginate: (endpoint: unknown) =>
      endpoint === 'repos-endpoint'
        ? Promise.resolve([
            {
              name: 'cloudgate',
              owner: { login: 'octabyte-io' },
              html_url: 'https://github.com/octabyte-io/cloudgate',
              default_branch: 'main',
            },
          ])
        : Promise.resolve([{ name: 'main', commit: { sha: 'abc123' } }]),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: OCTOKIT_FACTORY, useValue: () => stubOctokit },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    githubService = ctx.app.get(GithubService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  describe('create → findOne', () => {
    it('creates the base provider row plus the github detail row, secrets encrypted at rest and stripped from responses', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await githubService.create(ownerCtx, appCredentials);

      expect(created.githubId).toEqual(expect.any(String));
      expect(created).toMatchObject({
        appName: 'cloudgate-app',
        appId: 12345,
        clientId: 'Iv1.abc123',
        installationId: '99887766',
      });
      expect(created).not.toHaveProperty('privateKey');
      expect(created).not.toHaveProperty('clientSecret');
      // The webhook secret is what makes an inbound delivery provable: anyone
      // holding it can forge one, so it never leaves the server either.
      expect(created).not.toHaveProperty('webhookSecret');
      expect(created.gitProvider).toMatchObject({
        name: 'Team GitHub',
        providerType: 'github',
        organizationId,
      });

      const found = await githubService.findOne(ownerCtx, created.githubId);
      expect(found).toMatchObject({
        githubId: created.githubId,
        gitProviderId: created.gitProviderId,
        appId: 12345,
      });
      expect(found).not.toHaveProperty('privateKey');
      expect(found).not.toHaveProperty('clientSecret');
      expect(found).not.toHaveProperty('webhookSecret');

      const raw = await ctx.db.$client.query<{
        private_key: string;
        client_secret: string;
        webhook_secret: string;
      }>(
        'select private_key, client_secret, webhook_secret from github where github_id = $1',
        [created.githubId],
      );
      expect(raw.rows[0].private_key).not.toContain('MIIEfake');
      expect(raw.rows[0].private_key.startsWith('enc:v1:')).toBe(true);
      expect(raw.rows[0].client_secret).not.toContain('github-client-secret');
      expect(raw.rows[0].client_secret.startsWith('enc:v1:')).toBe(true);
      expect(raw.rows[0].webhook_secret).not.toContain('wh-secret');
      expect(raw.rows[0].webhook_secret.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('list', () => {
    it("returns the organization's connections, secrets stripped", async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await githubService.create(ownerCtx, appCredentials);
      // A half-installed app (no installationId until the trip to github.com
      // completes) is still the organization's connection: hiding it strands
      // the only copy of its id.
      await githubService.create(ownerCtx, {
        name: 'Half-installed',
        appId: 777,
        privateKey: 'KEY',
      });

      const listed = await githubService.list(ownerCtx);
      expect(listed).toHaveLength(2);
      expect(listed.map((c) => c.gitProvider.name).sort()).toEqual([
        'Half-installed',
        'Team GitHub',
      ]);
      for (const connection of listed) {
        expect(connection).not.toHaveProperty('privateKey');
        expect(connection).not.toHaveProperty('clientSecret');
        expect(connection).not.toHaveProperty('webhookSecret');
      }
    });
  });

  describe('update', () => {
    it('renames the base provider row and rotates credentials, re-encrypted at rest', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await githubService.create(ownerCtx, appCredentials);

      const updated = await githubService.update(ownerCtx, created.githubId, {
        name: 'Renamed GitHub',
        privateKey: 'rotated-private-key',
        webhookSecret: 'rotated-wh-secret',
        installationId: '11223344',
      });

      expect(updated).toMatchObject({
        githubId: created.githubId,
        installationId: '11223344',
        appName: 'cloudgate-app',
        gitProvider: { name: 'Renamed GitHub' },
      });
      expect(updated).not.toHaveProperty('privateKey');
      expect(updated).not.toHaveProperty('clientSecret');
      expect(updated).not.toHaveProperty('webhookSecret');

      const raw = await ctx.db.$client.query<{
        private_key: string;
        webhook_secret: string;
      }>(
        'select private_key, webhook_secret from github where github_id = $1',
        [created.githubId],
      );
      expect(raw.rows[0].private_key).not.toContain('rotated-private-key');
      expect(raw.rows[0].private_key.startsWith('enc:v1:')).toBe(true);
      expect(raw.rows[0].webhook_secret).not.toContain('rotated-wh-secret');
      expect(raw.rows[0].webhook_secret.startsWith('enc:v1:')).toBe(true);
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
      const foreign = await githubService.create(secondOrgCtx, appCredentials);

      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        githubService.findOne(firstOrgCtx, foreign.githubId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        githubService.update(firstOrgCtx, foreign.githubId, {
          name: 'stolen',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(await githubService.list(firstOrgCtx)).toEqual([]);
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports create, one, all and update over HTTP with secrets stripped', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/github')
        .set('Cookie', cookie)
        .send(appCredentials);
      expect(created.status).toBe(201);
      const body = created.body as { githubId: string };
      expect(body.githubId).toEqual(expect.any(String));
      expect(created.body).not.toHaveProperty('privateKey');
      expect(created.body).not.toHaveProperty('clientSecret');
      expect(created.body).not.toHaveProperty('webhookSecret');

      const rejected = await request(server)
        .post('/github')
        .set('Cookie', cookie)
        .send({ name: '' });
      expect(rejected.status).toBe(400);

      const one = await request(server)
        .get(`/github/${body.githubId}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        appName: 'cloudgate-app',
        gitProvider: { name: 'Team GitHub' },
      });
      expect(one.body).not.toHaveProperty('privateKey');
      expect(one.body).not.toHaveProperty('webhookSecret');

      const listed = await request(server).get('/github').set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(listed.body as unknown[]).toHaveLength(1);
      expect((listed.body as unknown[])[0]).not.toHaveProperty('webhookSecret');

      const patched = await request(server)
        .patch(`/github/${body.githubId}`)
        .set('Cookie', cookie)
        .send({ name: 'renamed' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        gitProvider: { name: 'renamed' },
      });
    });

    it('a connection saved before the app is installed is listed, and its id round-trips through GET /github/:id and PATCH /github/:id', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      // Saved before the trip to github.com that mints the installation id.
      const created = await request(server)
        .post('/github')
        .set('Cookie', cookie)
        .send({
          name: 'Half-installed',
          appName: 'cloudgate-app',
          appId: 777,
        });
      expect(created.status).toBe(201);
      const { githubId } = created.body as { githubId: string };

      const listed = await request(server).get('/github').set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(listed.body as { githubId: string }[]).toHaveLength(1);
      expect((listed.body as { githubId: string }[])[0].githubId).toBe(
        githubId,
      );

      const one = await request(server)
        .get(`/github/${githubId}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({ githubId });

      // The installation completes later; the same row takes it and is still
      // listed exactly once.
      const patched = await request(server)
        .patch(`/github/${githubId}`)
        .set('Cookie', cookie)
        .send({ privateKey: 'KEY', installationId: '99887766' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        githubId,
        installationId: '99887766',
      });

      const relisted = await request(server)
        .get('/github')
        .set('Cookie', cookie);
      expect(relisted.body as { githubId: string }[]).toHaveLength(1);
      expect((relisted.body as { githubId: string }[])[0].githubId).toBe(
        githubId,
      );
    });

    it('lists repositories and branches through the app installation', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/github')
        .set('Cookie', cookie)
        .send(appCredentials);
      const { githubId } = created.body as { githubId: string };

      const repositories = await request(server)
        .get(`/github/${githubId}/repositories`)
        .set('Cookie', cookie);
      expect(repositories.status).toBe(200);
      expect(repositories.body).toEqual([
        {
          name: 'cloudgate',
          owner: 'octabyte-io',
          url: 'https://github.com/octabyte-io/cloudgate',
          defaultBranch: 'main',
        },
      ]);

      const branches = await request(server)
        .get(`/github/${githubId}/branches`)
        .query({ owner: 'octabyte-io', repo: 'cloudgate' })
        .set('Cookie', cookie);
      expect(branches.status).toBe(200);
      expect(branches.body).toEqual([{ name: 'main', commitSha: 'abc123' }]);

      const missingParams = await request(server)
        .get(`/github/${githubId}/branches`)
        .set('Cookie', cookie);
      expect(missingParams.status).toBe(400);
    });
  });

  describe('webhook', () => {
    // Signs the payload exactly as GitHub does; the scheme itself is pinned
    // against an openssl-computed literal in github-webhook.util.spec.ts.
    const sign = (secret: string, payload: object) =>
      `sha256=${createHmac('sha256', secret)
        .update(JSON.stringify(payload))
        .digest('hex')}`;

    const pushPayload = {
      ref: 'refs/heads/main',
      installation: { id: 99887766 },
      repository: {
        name: 'cloudgate',
        owner: { name: 'octabyte-io', login: 'octabyte-io' },
      },
      head_commit: { id: '5a4e1c2d', message: 'feat: phase 16' },
    };

    async function setUpConnection(server: App) {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      await githubService.create(ownerCtx, appCredentials);
    }

    // What a push deploys is pinned in github-push-deploy.e2e-spec.ts;
    // here there is no Application, so the answer says nothing was queued.
    it('accepts a correctly signed push event without authentication and answers what it queued', async () => {
      await setUpConnection(server);

      const res = await request(server)
        .post('/github/webhook')
        .set('x-github-event', 'push')
        .set('x-hub-signature-256', sign('wh-secret', pushPayload))
        .send(pushPayload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        message: 'Push event processed',
        deploymentsQueued: 0,
      });
    });

    it('answers a signed ping event', async () => {
      await setUpConnection(server);
      const payload = {
        zen: 'Design for failure.',
        installation: { id: 99887766 },
      };

      const res = await request(server)
        .post('/github/webhook')
        .set('x-github-event', 'ping')
        .set('x-hub-signature-256', sign('wh-secret', payload))
        .send(payload);

      expect(res.status).toBe(200);
    });

    it('rejects a missing signature, a bad signature and an unknown installation', async () => {
      await setUpConnection(server);

      const unsigned = await request(server)
        .post('/github/webhook')
        .set('x-github-event', 'push')
        .send(pushPayload);
      expect(unsigned.status).toBe(401);

      const badSignature = await request(server)
        .post('/github/webhook')
        .set('x-github-event', 'push')
        .set('x-hub-signature-256', sign('wrong-secret', pushPayload))
        .send(pushPayload);
      expect(badSignature.status).toBe(401);

      const unknownInstallation = {
        ...pushPayload,
        installation: { id: 4040404 },
      };
      const unknown = await request(server)
        .post('/github/webhook')
        .set('x-github-event', 'push')
        .set('x-hub-signature-256', sign('wh-secret', unknownInstallation))
        .send(unknownInstallation);
      expect(unknown.status).toBe(400);
    });

    it('a connection whose webhook secret predates encryption still verifies deliveries, and is encrypted on the next write of the column', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await githubService.create(ownerCtx, appCredentials);

      // Every row that predates this column becoming encryptedText holds its
      // secret in the clear. ADR 0006 passes values without the `enc:v1:`
      // prefix straight through on read, so such a row keeps working.
      await ctx.db.$client.query(
        'update github set webhook_secret = $1 where github_id = $2',
        ['legacy-plaintext-secret', created.githubId],
      );

      const accepted = await request(server)
        .post('/github/webhook')
        .set('x-github-event', 'push')
        .set(
          'x-hub-signature-256',
          sign('legacy-plaintext-secret', pushPayload),
        )
        .send(pushPayload);
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ message: 'Push event processed' });

      // ...and the next write of that column leaves it encrypted at rest.
      await githubService.update(ownerCtx, created.githubId, {
        webhookSecret: 'legacy-plaintext-secret',
      });

      const raw = await ctx.db.$client.query<{ webhook_secret: string }>(
        'select webhook_secret from github where github_id = $1',
        [created.githubId],
      );
      expect(raw.rows[0].webhook_secret).not.toContain(
        'legacy-plaintext-secret',
      );
      expect(raw.rows[0].webhook_secret.startsWith('enc:v1:')).toBe(true);

      const stillAccepted = await request(server)
        .post('/github/webhook')
        .set('x-github-event', 'push')
        .set(
          'x-hub-signature-256',
          sign('legacy-plaintext-secret', pushPayload),
        )
        .send(pushPayload);
      expect(stillAccepted.status).toBe(200);
    });

    it('rejects event types other than push and ping', async () => {
      await setUpConnection(server);

      const res = await request(server)
        .post('/github/webhook')
        .set('x-github-event', 'issues')
        .set('x-hub-signature-256', sign('wh-secret', pushPayload))
        .send(pushPayload);

      expect(res.status).toBe(400);
    });
  });
});
