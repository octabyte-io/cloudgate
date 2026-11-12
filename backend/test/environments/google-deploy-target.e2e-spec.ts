import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import {
  cloudAccount,
  environment as environmentTable,
  licenseKey,
  member,
  organizationRole,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';

const messageOf = (res: request.Response) =>
  (res.body as { message: string }).message;
const idOf = (res: request.Response) =>
  (res.body as { environmentId: string }).environmentId;
const warningsOf = (res: request.Response) =>
  (res.body as { warnings: string[] }).warnings;

/**
 * "Region check" (S7): an Environment's
 * Deploy target can be a Google Cloud account and a region. Choosing one
 * signs in as the deploy service account through the Google client port
 * (`ctx.google`, the in-memory fake), refuses a region where Cloud Run or
 * Artifact Registry is not offered, naming it, and warns when the project's
 * networks near Google's 15. A plan there makes a `web` and refuses every
 * other kind, naming Google Cloud.
 */
describe('A Deploy target in a Google Cloud account (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    // The install's own address, which the tokens' issuer is made from.
    await ctx.db
      .insert(webServerSettings)
      .values({ host: 'cloudgate.example.com', https: true });
    const res = await request(http).post('/api/auth/sign-up/email').send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;
  });

  /** A connected Google Cloud account, as its connect would have saved it, with a key that signs. */
  async function addGoogleAccount(
    name = 'Production Google',
    inOrganization = organizationId,
  ): Promise<string> {
    const key = makeSigningKey();
    const [row] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId: inOrganization,
        name,
        cloud: 'gcp',
        cloudId: PROJECT,
        ...GOOGLE_COLUMNS,
        signingKey: key.privateKey,
        signingKeyId: key.keyId,
        signingPublicKey: JSON.stringify(key.publicJwk),
        policyVersion: 1,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    return row.cloudAccountId;
  }

  const onGoogle = (cloudAccountId: string, region = 'europe-west1') => ({
    kind: 'cloud',
    cloudAccountId,
    region,
  });

  const createEnvironment = (body: Record<string, unknown>, as = cookie) =>
    request(http)
      .post('/environments')
      .set('Cookie', as)
      .send({ projectId, ...body });

  const patchEnvironment = (
    environmentId: string,
    body: Record<string, unknown>,
  ) =>
    request(http)
      .patch(`/environments/${environmentId}`)
      .set('Cookie', cookie)
      .send(body);

  async function targetOf(environmentId: string) {
    const [row] = await ctx.db
      .select({ deployTarget: environmentTable.deployTarget })
      .from(environmentTable)
      .where(eq(environmentTable.environmentId, environmentId));
    return row.deployTarget;
  }

  describe('choosing a Google Cloud account and region', () => {
    it('stores the target after checking the region as the deploy service account, calling no AWS', async () => {
      const cloudAccountId = await addGoogleAccount();

      const created = await createEnvironment({
        name: 'production',
        deployTarget: onGoogle(cloudAccountId),
      });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        deployTarget: onGoogle(cloudAccountId),
        warnings: [],
      });
      expect(await targetOf(idOf(created))).toEqual(onGoogle(cloudAccountId));
      // Signed in as the deploy service account, then both APIs' locations
      // and the networks read in the project with its token.
      expect(ctx.google.calls).toEqual([
        expect.objectContaining({ method: 'exchangeToken' }),
        expect.objectContaining({
          method: 'impersonate',
          serviceAccount: GOOGLE_COLUMNS.deployServiceAccount,
          federated: true,
        }),
        {
          method: 'listLocations',
          projectId: PROJECT,
          api: 'run.googleapis.com',
          impersonated: true,
        },
        {
          method: 'listLocations',
          projectId: PROJECT,
          api: 'artifactregistry.googleapis.com',
          impersonated: true,
        },
        { method: 'countNetworks', projectId: PROJECT, impersonated: true },
      ]);
      // The token names this Cloud account, as the connect check's does.
      const [exchanged] = ctx.google.calls;
      expect(exchanged).toMatchObject({
        token: { claims: { sub: `cloudgate:${cloudAccountId}` } },
      });
      expect(ctx.cloud.calls).toEqual([]);
    });

    it("refuses a region Google does not have, by the Cloud account's cloud, calling no Google", async () => {
      const cloudAccountId = await addGoogleAccount();

      const refused = await createEnvironment({
        name: 'production',
        deployTarget: onGoogle(cloudAccountId, 'eu-west-1'),
      });

      expect(refused.status).toBe(400);
      expect(messageOf(refused)).toBe(
        'eu-west-1 is not a Google Cloud region Cloudgate deploys to',
      );
      expect(ctx.google.calls).toEqual([]);
    });

    it.each([
      ['run.googleapis.com', 'Cloud Run'],
      ['artifactregistry.googleapis.com', 'Artifact Registry'],
    ] as const)(
      'refuses a region where %s is not offered, naming the region, and keeps the saved target',
      async (api, name) => {
        const cloudAccountId = await addGoogleAccount();
        const created = await createEnvironment({
          name: 'production',
          deployTarget: onGoogle(cloudAccountId),
        });
        expect(created.status).toBe(201);
        ctx.google.notOfferedIn(api, 'europe-west12');

        const refused = await patchEnvironment(idOf(created), {
          deployTarget: onGoogle(cloudAccountId, 'europe-west12'),
        });

        expect(refused.status).toBe(400);
        expect(messageOf(refused)).toBe(
          `${name} is not offered in europe-west12 to project ${PROJECT}. Choose a region where Cloud Run and Artifact Registry are both offered`,
        );
        expect(await targetOf(idOf(created))).toEqual(onGoogle(cloudAccountId));
      },
    );

    it('names both when neither is offered', async () => {
      const cloudAccountId = await addGoogleAccount();
      ctx.google.notOfferedIn('run.googleapis.com', 'me-central2');
      ctx.google.notOfferedIn('artifactregistry.googleapis.com', 'me-central2');

      const refused = await createEnvironment({
        name: 'production',
        deployTarget: onGoogle(cloudAccountId, 'me-central2'),
      });

      expect(refused.status).toBe(400);
      expect(messageOf(refused)).toBe(
        `Cloud Run and Artifact Registry are not offered in me-central2 to project ${PROJECT}. Choose a region where Cloud Run and Artifact Registry are both offered`,
      );
      expect(await ctx.db.select().from(environmentTable)).toEqual([]);
    });

    it('refuses when the Cloud account can no longer sign in, saying what to do', async () => {
      const cloudAccountId = await addGoogleAccount();
      ctx.google.refuse(
        'exchangeToken',
        'invalid_grant',
        'The audience in ID Token does not match.',
      );

      const refused = await createEnvironment({
        name: 'production',
        deployTarget: onGoogle(cloudAccountId),
      });

      expect(refused.status).toBe(400);
      expect(messageOf(refused)).toBe(
        `Google's STS refused this Cloud account's token at ${GOOGLE_COLUMNS.workloadIdentityProvider} to check europe-west1: The audience in ID Token does not match. Run Check now on the Cloud account`,
      );
    });

    it("refuses when Google will not say where Cloud Run is offered, in Google's words", async () => {
      const cloudAccountId = await addGoogleAccount();
      ctx.google.permissionDenied('listLocations');

      const refused = await createEnvironment({
        name: 'production',
        deployTarget: onGoogle(cloudAccountId),
      });

      expect(refused.status).toBe(400);
      expect(messageOf(refused)).toBe(
        `Google refused to list where Cloud Run is offered to project ${PROJECT}, so europe-west1 cannot be checked: The caller does not have permission`,
      );
    });

    it("warns at 13 of Google's 15 networks, and says the network will not fit at 15; the target is kept either way", async () => {
      const cloudAccountId = await addGoogleAccount();
      ctx.google.haveNetworks(12);
      const below = await createEnvironment({
        name: 'staging',
        deployTarget: onGoogle(cloudAccountId),
      });
      expect(below.status).toBe(201);
      expect(warningsOf(below)).toEqual([]);

      ctx.google.haveNetworks(13);
      const near = await createEnvironment({
        name: 'production',
        deployTarget: onGoogle(cloudAccountId),
      });

      expect(near.status).toBe(201);
      expect(warningsOf(near)).toEqual([
        `Google Cloud project ${PROJECT} has 13 VPC networks, and Google allows 15 per project unless the quota is raised. The Environment network takes one of the 2 left`,
      ]);

      ctx.google.haveNetworks(15);
      const full = await patchEnvironment(idOf(near), {
        deployTarget: onGoogle(cloudAccountId, 'us-central1'),
      });
      expect(full.status).toBe(200);
      expect(warningsOf(full)).toEqual([
        `Google Cloud project ${PROJECT} has 15 VPC networks, and Google allows 15 per project unless the quota is raised. The Environment network will not fit: raise the quota or remove a network before the first deploy here`,
      ]);
      expect(await targetOf(idOf(near))).toEqual(
        onGoogle(cloudAccountId, 'us-central1'),
      );
    });

    it('warns, rather than refuses, when the networks cannot be counted', async () => {
      const cloudAccountId = await addGoogleAccount();
      ctx.google.permissionDenied('countNetworks');

      const created = await createEnvironment({
        name: 'production',
        deployTarget: onGoogle(cloudAccountId),
      });

      expect(created.status).toBe(201);
      expect(warningsOf(created)).toEqual([
        `Cloudgate could not count the VPC networks in project ${PROJECT} (The caller does not have permission), so it cannot say whether the project has room for the Environment network`,
      ]);
    });

    it("answers another Organization's Google Cloud account as not found, calling no Google", async () => {
      const mallory = await secondOrganizationOwner(http, ctx.db, cookie);
      const theirs = await addGoogleAccount(
        'Their Google',
        mallory.organizationId,
      );

      const refused = await createEnvironment({
        name: 'production',
        deployTarget: onGoogle(theirs),
      });

      expect(refused.status).toBe(404);
      expect(messageOf(refused)).toBe('Cloud account not found');
      expect(ctx.google.calls).toEqual([]);
    });

    it('answers a caller without cloudAccount: read as not found, calling no Google', async () => {
      const cloudAccountId = await addGoogleAccount();
      const ida = await signUpMember(http, cookie);
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'environment-editor',
        permission: { environment: ['read', 'create', 'update'] },
      });
      await ctx.db
        .update(member)
        .set({ role: 'environment-editor', accessedProjects: [projectId] })
        .where(
          and(
            eq(member.userId, ida.id),
            eq(member.organizationId, organizationId),
          ),
        );

      const refused = await createEnvironment(
        { name: 'production', deployTarget: onGoogle(cloudAccountId) },
        ida.cookie,
      );

      expect(refused.status).toBe(404);
      expect(messageOf(refused)).toBe('Cloud account not found');
      expect(ctx.google.calls).toEqual([]);
    });
  });

  describe('plans', () => {
    const save = (text: string) =>
      request(http)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({ text });

    it("plans a web there, its place the Environment's Google Cloud account and region", async () => {
      const cloudAccountId = await addGoogleAccount();
      await createEnvironment({
        name: 'production',
        deployTarget: onGoogle(cloudAccountId),
      });

      const saved = await save(
        'version: 1\nservices:\n  api:\n    kind: web\n    source: { image: nginx:1.27 }\n',
      );

      expect(saved.status).toBe(201);
      const [stored] = await ctx.db.select().from(planTable);
      expect(stored.steps).toContainEqual(
        expect.objectContaining({
          action: 'create',
          configName: 'api',
          placement: {
            kind: 'cloud',
            cloudAccountId,
            region: 'europe-west1',
          },
        }),
      );
    });
  });
});
