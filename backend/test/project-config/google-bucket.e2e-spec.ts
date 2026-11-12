import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { idKey } from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import {
  bucket,
  cloudAccount,
  deployment,
  webServerSettings,
} from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { wiredEnv } from '../../src/project-config/outputs';
import {
  storedGoogleOutputs,
  storedGooglePlan,
} from '../utils/fake-google-cloud-port';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(240_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';
const ORIGIN = 'https://app.example.com';

const UPLOADS = `version: 1
services:
  uploads:
    kind: bucket
`;

/** Two `web`s wired to the bucket's six Outputs between them. */
const WEBS_AND_BUCKET = `version: 1
services:
  uploads:
    kind: bucket
  api:
    kind: web
    source: { image: nginx }
    env:
      - S3_BUCKET: uploads.name
      - S3_REGION: uploads.region
      - S3_ENDPOINT: uploads.endpoint
      - AWS_ACCESS_KEY_ID: uploads.access_key_id
      - AWS_SECRET_ACCESS_KEY: uploads.secret_access_key
      - S3_PATH_STYLE: uploads.path_style
  admin:
    kind: web
    source: { image: nginx }
    env:
      - AWS_ACCESS_KEY_ID: uploads.access_key_id
      - AWS_SECRET_ACCESS_KEY: uploads.secret_access_key
`;

/** What the stored bucket apply answers, each output's value. */
const KEY = Object.fromEntries(
  Object.entries(storedGoogleOutputs('bucket-create')).map(([name, output]) => [
    name,
    (output as { value: unknown }).value,
  ]),
) as { access_key_id: string; secret_access_key: string; bucket_name: string };

/** The stored create with its CORS moved from no origin to {@link ORIGIN}, in place. */
function corsChange(): TofuShowJson {
  const show = storedGooglePlan('bucket-create') as TofuShowJson;
  return {
    ...show,
    resource_changes: (show.resource_changes ?? [])
      .filter((change) => change.type === 'google_storage_bucket')
      .map((change) => ({
        ...change,
        change: {
          ...change.change,
          actions: ['update'],
          before: { ...(change.change.after as object), cors: [] },
          after: {
            ...(change.change.after as object),
            cors: [
              {
                origin: [ORIGIN],
                method: ['GET', 'PUT', 'POST', 'HEAD'],
                response_header: ['Content-Type', 'ETag'],
                max_age_seconds: 3600,
              },
            ],
          },
        },
      })),
  };
}

interface Step {
  action: string;
  configName?: string;
  serviceId?: string;
  bucket?: { name: string; serviceId?: string };
  cors?: { from: string[]; to: string[] };
  cloudRead?: {
    status: 'reading' | 'read' | 'failed';
    reason?: string;
    stateId?: string;
    serviceId?: string;
    summary?: string[];
  };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
  notes: { kind: string }[];
}

/**
 * Spec "Bucket on Cloud Storage" (ADR-0032 as amended):
 * on a Google Cloud Deploy target a `bucket` becomes a Cloud Storage bucket,
 * named `cloudgate-<service key>-<8 random>` once by the plan that creates
 * it, in its own Infrastructure state, by a Cloud run that also makes the
 * bucket's own service account, its binding on the bucket and its HMAC key,
 * and saves the key encrypted. A linked Service is handed the six Outputs,
 * its key among them, the same key for every Service that links it; origins
 * edited on its page plan and apply as a CORS change, as on AWS. Against
 * `ctx.google`, whose stand-in `tofu` replays the stored Google plan and
 * apply outputs.
 */
describe('A bucket on a Google Cloud Deploy target becomes a Cloud Storage bucket with its own HMAC key (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: DEPLOYMENT_QUEUE, useValue: queue }],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    queue.add.mockClear();
    // The install's own address, which a Google provider names as its
    // issuer: a Google Environment is refused without it.
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
    projectId = (project.body as { projectId: string }).projectId;

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
        policyVersion: 3,
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

    ctx.google.replayPlanFor('network', 'network-create');
    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.replayPlanFor('bucket', 'bucket-create');
    ctx.google.replayOutputsFor('bucket', 'bucket-create');
    ctx.google.calls.length = 0;
    ctx.google.tofuInputs.length = 0;
  });

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  const checkForChanges = () =>
    request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);

  const apply = (planId: string) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

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

  /** A Deployment once its Cloud run has ended. */
  async function ended(deploymentId: string) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      if (row && row.status !== 'pending' && row.status !== 'running') {
        return row;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The Cloud run did not end');
  }

  function deploymentOf(applied: request.Response): string {
    return (applied.body as { results: { deploy: { deploymentId: string } }[] })
      .results[0].deploy.deploymentId;
  }

  /** Plans and applies the bucket's create, and waits for its Cloud run. */
  async function made() {
    expect((await save(UPLOADS)).status).toBe(201);
    const read = await readPlan();
    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    expect((await ended(deploymentOf(applied))).status).toBe('done');
    const [row] = await ctx.db.select().from(bucket);
    ctx.google.calls.length = 0;
    ctx.google.tofuInputs.length = 0;
    return row;
  }

  it('plans the create with its stored cloudgate-<service key>-<8 random> name and Google lines, and Apply makes it, its account, binding and key through a Cloud run', async () => {
    expect((await save(UPLOADS)).status).toBe(201);

    const read = await readPlan();
    // A bucket on Cloud Storage sits in no Environment network.
    expect(read.steps.map((step) => step.action)).toEqual(['create']);
    const [step] = read.steps;
    const serviceId = step.bucket!.serviceId!;
    expect(step.bucket!.name).toMatch(
      new RegExp(`^cloudgate-${idKey(serviceId)}-[a-z0-9]{8}$`),
    );
    expect(step.bucket!.name).toHaveLength(31);
    expect(step.cloudRead).toMatchObject({ status: 'read', serviceId });
    expect(step.cloudRead?.summary).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^Cloud Storage bucket `cloudgate-[a-z2-7]{12}-[a-z0-9]{8}`: create, soft delete off, uniform access, public access prevented, \$0\/month while empty/,
        ),
        "Bucket key (HMAC) of the bucket's own service account: create, shared by every Service that links the bucket",
      ]),
    );
    // The read wrote the definition under the name the plan shows, with no
    // CORS (no origin is trusted yet) and no grant on the project.
    const [readInput] = ctx.google.tofuInputs;
    expect(readInput.definition).toContain(`"name": "${step.bucket!.name}"`);
    expect(readInput.definition).toContain('"retention_duration_seconds": 0');
    expect(readInput.definition).not.toContain('"cors"');
    expect(readInput.definition).toContain('roles/storage.objectUser');
    expect(await ctx.db.select().from(deployment)).toEqual([]);

    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      results: [
        {
          configName: 'uploads',
          action: 'create',
          status: 'applied',
          serviceType: 'bucket',
          serviceId,
          deploy: { status: 'queued' },
        },
      ],
    });
    const run = await ended(deploymentOf(applied));
    expect(run).toMatchObject({
      bucketId: serviceId,
      title: 'Create uploads on Cloud Storage',
      status: 'done',
    });
    expect(
      ctx.google.calls.flatMap((call) =>
        call.method === 'apply' ? [call.kind] : [],
      ),
    ).toEqual(['bucket']);

    const [created] = await ctx.db.select().from(bucket);
    expect(created).toMatchObject({
      bucketId: serviceId,
      bucketName: step.bucket!.name,
      cloudAccountId,
      region: REGION,
      serverId: null,
      applicationStatus: 'done',
      appliedOrigins: [],
      accessKeyId: KEY.access_key_id,
      secretAccessKey: KEY.secret_access_key,
    });
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.bucketId, serviceId));
    expect(state).toMatchObject({
      infrastructureStateId: step.cloudRead!.stateId,
      provider: 'google',
    });
    // A bucket on Cloud Storage is never a Garage container.
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('stores the key encrypted, and its page reads it back only as set', async () => {
    const created = await made();

    const raw = await ctx.db.execute<{
      access_key_id: string;
      secret_access_key: string;
    }>(
      sql`select access_key_id, secret_access_key from bucket where bucket_id = ${created.bucketId}`,
    );
    for (const value of Object.values(raw.rows[0])) {
      expect(value).toMatch(/^enc:v1:/);
    }

    const page = await request(http)
      .get(`/buckets/${created.bucketId}`)
      .set('Cookie', cookie);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      bucketName: created.bucketName,
      region: REGION,
      hasKey: true,
    });
    expect(JSON.stringify(page.body)).not.toContain(KEY.secret_access_key);
    expect(JSON.stringify(page.body)).not.toContain(KEY.access_key_id);
  });

  it('plans a web and bucket together, the bucket first, with no note leaving a linked variable unset', async () => {
    expect((await save(WEBS_AND_BUCKET)).status).toBe(201);
    const read = await readPlan();
    const order = read.steps.map((step) => step.configName ?? step.action);
    expect(order[0]).toBe('network-create');
    expect([...order].sort()).toEqual(
      ['admin', 'api', 'network-create', 'uploads'].sort(),
    );
    // A link's source runs before what links to it.
    expect(order.indexOf('uploads')).toBeLessThan(order.indexOf('api'));
    expect(order.indexOf('uploads')).toBeLessThan(order.indexOf('admin'));
    expect(read.steps.every((step) => step.cloudRead?.status === 'read')).toBe(
      true,
    );
    expect(read.notes.map((note) => note.kind)).not.toContain(
      'task-role-access',
    );
    // Off until the walk by hand decides it.
    expect(read.notes.map((note) => note.kind)).not.toContain(
      'bucket-checksums',
    );
  });

  it('hands every linking Service the six Outputs at deploy, the same HMAC key to each', async () => {
    const created = await made();

    const api = await wiredEnv(ctx.db, environmentId, {
      S3_BUCKET: { source: 'uploads', output: 'name' },
      S3_REGION: { source: 'uploads', output: 'region' },
      S3_ENDPOINT: { source: 'uploads', output: 'endpoint' },
      AWS_ACCESS_KEY_ID: { source: 'uploads', output: 'access_key_id' },
      AWS_SECRET_ACCESS_KEY: {
        source: 'uploads',
        output: 'secret_access_key',
      },
      S3_PATH_STYLE: { source: 'uploads', output: 'path_style' },
    });
    expect(api).toEqual({
      S3_BUCKET: created.bucketName,
      S3_REGION: 'auto',
      S3_ENDPOINT: 'https://storage.googleapis.com',
      AWS_ACCESS_KEY_ID: KEY.access_key_id,
      AWS_SECRET_ACCESS_KEY: KEY.secret_access_key,
      S3_PATH_STYLE: 'true',
    });
    const admin = await wiredEnv(ctx.db, environmentId, {
      KEY_ID: { source: 'uploads', output: 'access_key_id' },
      KEY_SECRET: { source: 'uploads', output: 'secret_access_key' },
    });
    // One key per bucket, shared by every Service that links it.
    expect(admin).toEqual({
      KEY_ID: api.AWS_ACCESS_KEY_ID,
      KEY_SECRET: api.AWS_SECRET_ACCESS_KEY,
    });
  });

  it('fails a linked deploy while the bucket’s Cloud run has not saved its key', async () => {
    const created = await made();
    await ctx.db
      .update(bucket)
      .set({
        accessKeyId: null,
        secretAccessKey: null,
        applicationStatus: 'running',
      })
      .where(eq(bucket.bucketId, created.bucketId));

    await expect(
      wiredEnv(ctx.db, environmentId, {
        AWS_ACCESS_KEY_ID: { source: 'uploads', output: 'access_key_id' },
      }),
    ).rejects.toThrow(
      'AWS_ACCESS_KEY_ID links to uploads.access_key_id, but uploads is not made on Cloud Storage yet',
    );
  });

  it('plans origins edited on its page as a CORS change, and Apply writes them', async () => {
    const created = await made();

    const edited = await request(http)
      .put(`/buckets/${created.bucketId}/origins`)
      .set('Cookie', cookie)
      .send({ origins: [ORIGIN] });
    expect(edited.status).toBe(200);
    // Saved alone: nothing reaches Google until a plan's Apply.
    expect(ctx.google.calls).toEqual([]);

    ctx.google.replayShowFor('bucket', corsChange() as unknown as TofuShow);
    expect((await checkForChanges()).status).toBe(201);
    const read = await readPlan();
    expect(read.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'uploads',
        cors: { from: [], to: [ORIGIN] },
      }),
    ]);
    expect(read.steps[0].cloudRead?.summary).toEqual([
      expect.stringContaining(`: change, browser uploads from \`${ORIGIN}\``),
    ]);
    expect(ctx.google.tofuInputs.at(-1)!.definition).toContain(
      `"origin": [\n              "${ORIGIN}"`,
    );

    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    const run = await ended(deploymentOf(applied));
    expect(run).toMatchObject({
      bucketId: created.bucketId,
      title: 'Change uploads on Cloud Storage',
      status: 'done',
    });
    expect(ctx.google.tofuInputs.at(-1)).toMatchObject({ method: 'apply' });
    expect(ctx.google.tofuInputs.at(-1)!.definition).toContain(ORIGIN);
    const [after] = await ctx.db.select().from(bucket);
    expect(after.appliedOrigins).toEqual([ORIGIN]);
  });
});
