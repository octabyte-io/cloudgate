import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { networkNamePrefix } from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import {
  cloudAccount,
  deployment,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';

const WEB = `version: 1
services:
  api:
    kind: web
    size: small
    source: { image: nginx }
`;

/** Google's own words for an API that is off, as the provider prints them. */
const RUN_API_OFF =
  'Error creating Service: googleapi: Error 403: Cloud Run Admin API has not been used in project 123456789012 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/run.googleapis.com/overview?project=123456789012 then retry.';

/** A step as the API answers it, loosely: the fields these specs read. */
interface Step {
  action: string;
  configName?: string;
  cloud?: { size: { name: string | null; pair: Record<string, unknown> } };
  cloudRead?: {
    status: 'reading' | 'read' | 'failed';
    reason?: string;
    summary?: string[];
    raw?: { address: string; action: string }[];
    stateId?: string;
    serviceId?: string;
  };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
}

/**
 * Spec "Plan behaviour" (T12): in an Environment whose Deploy target
 * is a Google Cloud account, a plan that creates a `web` reads Google before
 * anything is spent. Its cloud steps are stored "reading", then each is read
 * as a plan-only Cloud run: a 2-hour proof signed for the run, the
 * definition, `tofu plan` through the real shared runner — whose stand-in
 * `tofu` (`ctx.google`'s) replays the stored Google plans — and a search by
 * name over the Google client port. The first `web` brings the Environment
 * network as its own step; a failed read names its reason; Apply waits for
 * every read.
 */
describe('Plans that read Google Cloud for a web create (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let environmentId: string;
  let cloudAccountId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
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
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    const projectId = (project.body as { projectId: string }).projectId;

    // A connected Google Cloud account, as its connect saved it, with a key that signs.
    const key = makeSigningKey();
    const [row] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name: 'Production Google',
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
    cloudAccountId = row.cloudAccountId;
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId,
        name: 'production',
        deployTarget: { kind: 'cloud', cloudAccountId, region: REGION },
      });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;
    savePlan = (text) =>
      request(http)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({ text });

    ctx.google.replayPlanFor('network', 'network-create');
    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.calls.length = 0;
  });

  let savePlan: (text: string) => request.Test;

  async function savedPlan(text: string): Promise<PlanBody> {
    const res = await savePlan(text);
    expect(res.status).toBe(201);
    return (res.body as { plans: PlanBody[] }).plans[0];
  }

  async function currentPlan(): Promise<PlanBody> {
    const res = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: PlanBody }).plan;
  }

  /** The open plan once no step is still reading Google. */
  async function readPlan(): Promise<PlanBody> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const found = await currentPlan();
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading Google Cloud');
  }

  const apply = (planId: string) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

  describe('the first web', () => {
    it('shows the network step at $0 with the load balancer at about $18/month, and the Service its Cloud Run lines', async () => {
      const stored = await savedPlan(WEB);

      expect(stored.steps).toEqual([
        {
          action: 'network-create',
          cloudAccountId,
          region: REGION,
          cloudRead: { status: 'reading' },
        },
        expect.objectContaining({
          action: 'create',
          configName: 'api',
          cloud: expect.objectContaining({
            size: {
              name: 'small',
              pair: {
                runsOn: 'Cloud Run',
                wording: '1 CPU / 1 GB',
                roundedUpFrom: '0.5 CPU',
                notes: [
                  'CPU only during requests',
                  '0–10 copies: scales to zero, so the first request after idle waits for a start',
                ],
              },
            },
          }) as unknown,
          cloudRead: { status: 'reading' },
        }),
      ]);

      const read = await readPlan();
      const [network, web] = read.steps;

      expect(network.cloudRead?.status).toBe('read');
      expect(network.cloudRead?.summary).toContain(
        'Environment network: create, $0/month for the network, about $18/month while idle for the load balancer',
      );
      expect(web.cloudRead?.status).toBe('read');
      expect(web.cloudRead?.summary).toContain(
        'Cloud Run service `api`: create, `small` → 1 CPU / 1 GB, CPU only during requests, 0–10 copies',
      );
      expect(web.cloudRead?.raw?.map((line) => line.address)).toContain(
        'google_cloud_run_v2_service.service',
      );
      expect(web.cloudRead?.stateId).toEqual(expect.any(String));
      expect(web.cloudRead?.serviceId).toEqual(expect.any(String));

      // Nothing reached AWS; a read is a plan-only Cloud run, no Deployment.
      expect(ctx.cloud.calls).toEqual([]);
      expect(await ctx.db.select().from(deployment)).toEqual([]);
    });

    it('signs a 2-hour proof for each read, plans through the shared runner, and searches by name for what each creates', async () => {
      await savedPlan(WEB);
      const read = await readPlan();
      const serviceState = read.steps[1].cloudRead?.stateId;

      const plans = ctx.google.calls.flatMap((call) =>
        call.method === 'plan' ? [call] : [],
      );
      expect(plans.map((call) => call.kind).sort()).toEqual(['network', 'web']);
      for (const call of plans) {
        // Each read's own proof, for the deploy service account, 2 hours long.
        expect(call.credential).toEqual({
          type: 'fake_external_account',
          audience: `//iam.googleapis.com/${GOOGLE_COLUMNS.workloadIdentityProvider}`,
          serviceAccount: GOOGLE_COLUMNS.deployServiceAccount,
        });
        expect(call.proof.claims).toMatchObject({
          iss: GOOGLE_COLUMNS.tokenIssuer,
          sub: `cloudgate:${cloudAccountId}`,
        });
        const { iat, exp } = call.proof.claims as { iat: number; exp: number };
        expect(exp - iat).toBe(2 * 60 * 60);
      }
      expect(plans.find((call) => call.kind === 'web')?.stateId).toBe(
        serviceState,
      );
      expect(plans.find((call) => call.kind === 'network')?.variables).toEqual([
        'default_certificate_body',
        'default_certificate_private_key',
      ]);

      // The search by name: as the deploy service account, one list call
      // per kind each plan creates, by its state's name prefix.
      const searches = ctx.google.calls.flatMap((call) =>
        call.method === 'findByName' ? [call] : [],
      );
      expect(searches.every((call) => call.impersonated)).toBe(true);
      expect(searches.map((call) => call.resourceType)).toEqual(
        expect.arrayContaining([
          'google_compute_network',
          'google_compute_subnetwork',
          'google_cloud_run_v2_service',
          'google_artifact_registry_repository',
          'google_service_account',
        ]),
      );
      const webSearch = searches.find(
        (call) => call.resourceType === 'google_cloud_run_v2_service',
      );
      expect(webSearch).toMatchObject({
        projectId: PROJECT,
        region: REGION,
        namePrefix: expect.stringMatching(/^cloudgate-[a-z2-7]{12}$/) as string,
      });
      const networkSearch = searches.find(
        (call) => call.resourceType === 'google_compute_network',
      );
      expect(networkSearch?.namePrefix).toMatch(/^cloudgate-[a-z2-7]{12}-$/);
    });

    it('leaves no proof behind: each run had its credential file, readable by it alone, and it is gone after the read', async () => {
      await savedPlan(WEB);
      await readPlan();

      const files = ctx.google.credentialFiles();
      expect(files).toHaveLength(2);
      expect(files.map(({ mode, there }) => ({ mode, there }))).toEqual([
        { mode: '600', there: false },
        { mode: '600', there: false },
      ]);
      expect(ctx.google.runFolders()).toEqual([]);
    });

    it("notes what Cloudgate's names find in Google Cloud that no state holds", async () => {
      const prefix = networkNamePrefix(environmentId);
      ctx.google.find({
        resourceType: 'google_compute_network',
        name: `${prefix}net`,
        id: `projects/${PROJECT}/global/networks/${prefix}net`,
        description: 'Made by hand',
      });

      await savedPlan(WEB);
      const read = await readPlan();

      expect(read.steps[0].cloudRead?.status).toBe('read');
      expect(JSON.stringify(read.steps[0].cloudRead)).toContain(
        `projects/${PROJECT}/global/networks/${prefix}net`,
      );
    });
  });

  describe('a failed read', () => {
    it('names an API that is off and the setup step that turns it on, and Apply is refused until a read succeeds', async () => {
      ctx.google.failRunFor('web', RUN_API_OFF);

      const { planId } = await savedPlan(WEB);
      const read = await readPlan();

      expect(read.steps[0].cloudRead?.status).toBe('read');
      expect(read.steps[1].cloudRead).toEqual({
        status: 'failed',
        reason: `The Cloud Run Admin API (run.googleapis.com) is off in Google Cloud project ${PROJECT}. Cloudgate never turns on an API: turn it on as step 1 of the setup script does (gcloud services enable run.googleapis.com), then Check for changes`,
      });
      // The failed run's proof is gone too.
      expect(ctx.google.credentialFiles().every((file) => !file.there)).toBe(
        true,
      );

      const refused = await apply(planId);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'PLAN_AWS_NOT_READ',
        message: expect.stringMatching(
          /^Apply waits until Google Cloud is read for every step of this plan: the read failed for api \(The Cloud Run Admin API \(run\.googleapis\.com\) is off/,
        ) as string,
      });
    });

    it('fails each read naming the Cloud account when it cannot sign in, before anything reaches tofu, and records it', async () => {
      ctx.google.permissionDenied(
        'impersonate',
        "Permission 'iam.serviceAccounts.getAccessToken' denied on resource",
      );

      await savedPlan(WEB);
      const read = await readPlan();

      const reason = `Cloud account Production Google could not sign in to Google Cloud: it could not act as its deploy service account ${GOOGLE_COLUMNS.deployServiceAccount}, answering PERMISSION_DENIED: Permission 'iam.serviceAccounts.getAccessToken' denied on resource. Run Check now on it in Organization settings, then Check for changes`;
      expect(read.steps.map((step) => step.cloudRead)).toEqual([
        { status: 'failed', reason },
        { status: 'failed', reason },
      ]);
      expect(ctx.google.calls.some((call) => call.method === 'plan')).toBe(
        false,
      );
      const [account] = await ctx.db
        .select()
        .from(cloudAccount)
        .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
      expect(account.lastCheckResult).toBe('failed');
    });
  });

  describe('a read still running', () => {
    it('refuses Apply, naming Google Cloud and what it waits on', async () => {
      const release = ctx.google.holdSignIn();
      const { planId } = await savedPlan(WEB);

      const refused = await apply(planId);
      release();

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'PLAN_AWS_NOT_READ',
        message:
          'Apply waits until Google Cloud is read for every step of this plan: still reading Google Cloud for the Environment network (europe-west1), api',
      });
      await readPlan();
      expect(
        (await ctx.db.select().from(planTable)).map((row) => row.status),
      ).toEqual(['open']);
    });
  });
});
