import request from 'supertest';
import { App } from 'supertest/types';

import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { cloudAccount, webServerSettings } from '../../src/db/schema';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

interface StepBody {
  action: string;
  configName?: string;
  cloudRead?: { status: string; reason?: string };
  cloudSql?: { lines: string[] };
  memorystore?: { lines: string[] };
}

interface PlanBody {
  planId: string;
  steps: StepBody[];
}

/**
 * A plan for an Environment whose Deploy target is a
 * Google Cloud project names the Cloud SQL machine of a `postgres` and the
 * Valkey node type of a `redis`. The postgres is read from Google Cloud as
 * a Cloud SQL instance (`google-cloud-sql.e2e-spec.ts`), and the
 * redis as a Memorystore one (`google-memorystore.e2e-spec.ts`),
 * never through AWS's definitions.
 */
describe('Postgres and Redis plans on Google Cloud (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;

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
    projectId = (project.body as { projectId: string }).projectId;

    const key = makeSigningKey();
    const [account] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name: 'Production Google',
        cloud: 'gcp',
        cloudId: 'shop-prod',
        ...GOOGLE_COLUMNS,
        signingKey: key.privateKey,
        signingKeyId: key.keyId,
        signingPublicKey: JSON.stringify(key.publicJwk),
        policyVersion: 1,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    const environment = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId,
        name: 'production',
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: account.cloudAccountId,
          region: 'europe-west1',
        },
      });
    expect(environment.status).toBe(201);
    environmentId = (environment.body as { environmentId: string })
      .environmentId;
  });

  async function currentPlan(): Promise<PlanBody> {
    const res = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: PlanBody }).plan;
  }

  /** The open plan once no step is still reading its cloud. */
  async function settledPlan(): Promise<PlanBody> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = await currentPlan();
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading');
  }

  it('names the machine and node type, and reads both from Google Cloud, never through AWS', async () => {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({
        text: 'version: 1\nservices:\n  pg-1:\n    kind: postgres\n    size: small\n  redis:\n    kind: redis\n',
      });
    expect(saved.status).toBe(201);

    const plan = await settledPlan();
    const pg = plan.steps.find((step) => step.configName === 'pg-1');
    const redis = plan.steps.find((step) => step.configName === 'redis');
    // Each is made backed up, with no restart mark.
    expect(pg?.cloudSql?.lines).toEqual([
      'pg-1 small → db-g1-small (shared CPU, 1.7 GB, no SLA: for testing)',
      'pg-1 backups: 7 days, point-in-time recovery on',
    ]);
    expect(redis?.memorystore?.lines).toEqual([
      'redis no size → custom-pico (smallest: 1.08 GB, 1 node)',
      'redis backups: 1 day',
    ]);
    // A postgres is read as a Cloud SQL instance, a redis as a
    // Memorystore one.
    expect(pg?.cloudRead?.status).toBe('read');
    expect(redis?.cloudRead?.status).toBe('read');
    expect(
      ctx.google.tofuInputs
        .filter((input) => input.method === 'plan')
        .map((input) =>
          /google_sql_database_instance/.test(input.definition)
            ? 'postgres'
            : /google_memorystore_instance/.test(input.definition)
              ? 'redis'
              : 'network',
        )
        .sort(),
    ).toEqual(['network', 'postgres', 'redis']);
    // Neither went through AWS's OpenTofu definitions.
    expect(
      ctx.cloud.tofuInputs.filter((input) =>
        /aws_db_instance|aws_elasticache|google_sql|google_memorystore/.test(
          input.definition,
        ),
      ),
    ).toEqual([]);
  });
});
