import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  GCP_BUCKET_ACCOUNT_ADDRESS,
  GCP_BUCKET_ADDRESS,
  GCP_BUCKET_BINDING_ADDRESS,
  GCP_BUCKET_KEY_ADDRESS,
} from '../../src/cloud-accounts/gcp/definitions/bucket-definition';
import { idKey } from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import {
  auditLog,
  bucket,
  cloudAccount,
  deployment,
  environment,
  webServerSettings,
} from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
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

const UPLOADS = `version: 1
services:
  uploads:
    kind: bucket
`;

const TWO_BUCKETS = `version: 1
services:
  uploads:
    kind: bucket
  avatars:
    kind: bucket
`;

const NO_SERVICES = 'version: 1\nservices: {}\n';

/** The addresses a destroy limited to the key, its account and binding names. */
const KEY_TARGETS = [
  GCP_BUCKET_BINDING_ADDRESS,
  GCP_BUCKET_KEY_ADDRESS,
  GCP_BUCKET_ACCOUNT_ADDRESS,
];

interface Step {
  action: string;
  configName?: string;
  files?: string;
  cloudRead?: { status: 'reading' | 'read' | 'failed' };
}

interface StepResult {
  configName: string;
  action: string;
  status: string;
  leftovers: unknown;
  deploy: { status: string; deploymentId: string } | null;
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
  results?: StepResult[];
}

/**
 * A bucket on Google Cloud's Delete (ADR-0038) copies AWS's, through the HTTP API against
 * `ctx.google`, whose one-result list answers what a spec put in a bucket
 * and whose stand-in `tofu` replays the stored plans. An empty bucket is
 * destroyed by a destroy-only Cloud run; one that holds files is kept and
 * named once with its project and region; "also delete its files" sets
 * `force_destroy` for that run only; an emptying that stops partway leaves
 * it "partly emptied". Whatever happens to the bucket, its HMAC key and
 * service account are destroyed.
 */
describe('A bucket on Google Cloud: Delete (e2e)', () => {
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

    ctx.google.replayPlanFor('bucket', 'bucket-create');
    ctx.google.replayOutputsFor('bucket', 'bucket-create');
  });

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  const apply = (
    planId: string,
    confirmDestroy: string[] = [],
    deleteFilesOf: string[] = [],
  ) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId, confirmDestroy, deleteFilesOf });

  const deleteBucket = (bucketId: string, query = '') =>
    request(http).delete(`/buckets/${bucketId}${query}`).set('Cookie', cookie);

  const bucketAction = (bucketId: string, action: 'retry' | 'forget') =>
    request(http)
      .post(`/buckets/${bucketId}/delete/${action}`)
      .set('Cookie', cookie);

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

  /** A Deployment once its Cloud run has ended, or `null` once it is gone with its bucket. */
  async function ended(deploymentId: string) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      if (!row) return null;
      if (row.status !== 'pending' && row.status !== 'running') return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The Cloud run did not end');
  }

  /** Waits until the bucket's row is gone, or its Delete is incomplete. */
  async function settled(bucketId: string) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const [row] = await ctx.db
        .select()
        .from(bucket)
        .where(eq(bucket.bucketId, bucketId));
      if (!row || row.cloudDelete?.status === 'incomplete') return row ?? null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("The bucket's Delete did not end");
  }

  /** Plans and applies the buckets' creates, and waits for their Cloud runs. */
  async function made(text = UPLOADS) {
    expect((await save(text)).status).toBe(201);
    const read = await readPlan();
    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    for (const result of (applied.body as PlanBody).results ?? []) {
      expect((await ended(result.deploy!.deploymentId))?.status).toBe('done');
    }
    const rows = await ctx.db.select().from(bucket);
    // The apply before an emptying changes only what the state holds.
    ctx.google.replayPlanFor('bucket', null);
    ctx.google.calls.length = 0;
    ctx.google.tofuInputs.length = 0;
    const byName = (configName: string) =>
      rows.find((row) => row.configName === configName)!;
    return { uploads: byName('uploads'), byName };
  }

  const stateOf = async (bucketId: string) =>
    (
      await ctx.db
        .select()
        .from(infrastructureState)
        .where(eq(infrastructureState.bucketId, bucketId))
    )[0] ?? null;

  /** Each `tofu` run that changed something, in order: a destroy whole or of the key, or the apply before an emptying. */
  const runs = () =>
    ctx.google.calls.flatMap((call) =>
      call.method === 'destroy'
        ? [
            {
              run: call.targets ? 'destroy key' : 'destroy',
              stateId: call.stateId,
              ...(call.targets ? { targets: call.targets } : {}),
            },
          ]
        : call.method === 'apply'
          ? [{ run: 'apply', stateId: call.stateId, targets: call.targets }]
          : [],
    );

  /** The bucket's audited Delete, as the report names what it kept. */
  async function report(bucketId: string) {
    const entry = (
      await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resourceId, bucketId))
    ).find((one) => (one.metadata ?? '').includes('"cloudDelete":"finished"'));
    return JSON.parse(entry!.metadata!) as { kept?: unknown[] };
  }

  /** What a kept bucket is named with: its project and region. */
  const keptIn = (bucketName: string, because = 'holds-files') => ({
    bucketName,
    because,
    cloud: {
      cloudAccountId,
      cloudAccountName: 'Production Google',
      projectId: PROJECT,
      region: REGION,
    },
  });

  /** The report's one *Kept* entry for a Cloud Storage bucket. */
  const keptReport = (bucketName: string) => ({
    type: 'storage.googleapis.com/Bucket',
    awsId: bucketName,
    projectId: PROJECT,
    region: REGION,
    cost: expect.stringContaining('Cloud Storage') as unknown,
  });

  describe("the bucket's own Delete", () => {
    it('destroys an empty bucket, its key and its account by one destroy of its state; the report lists nothing kept', async () => {
      const { uploads } = await made();
      const state = await stateOf(uploads.bucketId);

      const res = await deleteBucket(uploads.bucketId);

      expect(res.status).toBe(200);
      const { deploymentId } = (
        res.body as { cloudDelete: { deploymentId: string } }
      ).cloudDelete;
      expect(res.body).toEqual({
        volumeLeftBehind: false,
        cloudDelete: { status: 'deleting', deploymentId },
      });
      expect(await settled(uploads.bucketId)).toBeNull();
      // Read with one result through the Google client port.
      expect(ctx.google.calls).toContainEqual(
        expect.objectContaining({
          method: 'listObjects',
          bucket: uploads.bucketName,
          maxResults: 1,
          impersonated: true,
        }),
      );
      expect(runs()).toEqual([
        { run: 'destroy', stateId: state.infrastructureStateId },
      ]);
      expect(await stateOf(uploads.bucketId)).toBeNull();
      expect(await report(uploads.bucketId)).toEqual({
        cloudDelete: 'finished',
      });
    });

    it('keeps a bucket that holds files and names it once with its project and region, destroying only its key and account, then forgets it', async () => {
      const { uploads } = await made();
      const state = await stateOf(uploads.bucketId);
      ctx.google.holdObjects(uploads.bucketName, 'a.jpg');

      const res = await deleteBucket(uploads.bucketId);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        volumeLeftBehind: false,
        bucketLeftBehind: keptIn(uploads.bucketName),
        cloudDelete: { status: 'deleting' },
      });
      expect(await settled(uploads.bucketId)).toBeNull();
      expect(runs()).toEqual([
        {
          run: 'destroy key',
          stateId: state.infrastructureStateId,
          targets: KEY_TARGETS,
        },
      ]);
      expect(await stateOf(uploads.bucketId)).toBeNull();
      expect(await ctx.db.select().from(bucket)).toEqual([]);
      expect((await report(uploads.bucketId)).kept).toEqual([
        keptReport(uploads.bucketName),
      ]);
    });

    it('destroys the key in whichever slots a rotation left it: the live one it moved, and a stray beside it', async () => {
      const { uploads } = await made();
      const state = await stateOf(uploads.bucketId);
      await ctx.db
        .update(bucket)
        .set({
          googleKeySlot: 'key_b',
          rotationKeys: { newKey: null, strayKeyIds: ['GOOG1OLD'] },
        })
        .where(eq(bucket.bucketId, uploads.bucketId));
      ctx.google.holdObjects(uploads.bucketName, 'a.jpg');

      const res = await deleteBucket(uploads.bucketId);

      expect(res.status).toBe(200);
      expect(await settled(uploads.bucketId)).toBeNull();
      expect(runs()).toEqual([
        {
          run: 'destroy key',
          stateId: state.infrastructureStateId,
          targets: [
            GCP_BUCKET_BINDING_ADDRESS,
            'google_storage_hmac_key.key_b',
            'google_storage_hmac_key.key',
            GCP_BUCKET_ACCOUNT_ADDRESS,
          ],
        },
      ]);
    });

    it('keeps a bucket Google would not list, as if it holds files, and still destroys its key', async () => {
      const { uploads } = await made();
      ctx.google.permissionDenied('listObjects');

      const res = await deleteBucket(uploads.bucketId);

      expect(res.body).toMatchObject({
        bucketLeftBehind: keptIn(uploads.bucketName, 'unknown'),
      });
      expect(await settled(uploads.bucketId)).toBeNull();
      expect(runs().map((one) => one.run)).toEqual(['destroy key']);
    });

    it('"also delete its files" sets force_destroy for that run only, then destroys the bucket, emptying it', async () => {
      const { uploads } = await made();
      const state = await stateOf(uploads.bucketId);
      ctx.google.holdObjects(uploads.bucketName, 'a.jpg', 'b.jpg');

      const res = await deleteBucket(uploads.bucketId, '?deleteFiles=true');

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('bucketLeftBehind');
      expect(await settled(uploads.bucketId)).toBeNull();
      const stateId = state.infrastructureStateId;
      expect(runs()).toEqual([
        { run: 'destroy key', stateId, targets: KEY_TARGETS },
        { run: 'apply', stateId, targets: [GCP_BUCKET_ADDRESS] },
        { run: 'destroy', stateId },
      ]);
      const forced = ctx.google.tofuInputs.find(
        (input) => input.method === 'apply',
      )!.definition;
      expect(forced).toContain('"force_destroy": true');
      expect(await stateOf(uploads.bucketId)).toBeNull();
      expect(await report(uploads.bucketId)).toEqual({
        cloudDelete: 'finished',
      });
    });

    it('an emptying that stops partway leaves the bucket "partly emptied" and the Delete incomplete, its key and account already destroyed; Retry empties again', async () => {
      const { uploads } = await made();
      const state = await stateOf(uploads.bucketId);
      const stateId = state.infrastructureStateId;
      ctx.google.holdObjects(uploads.bucketName, 'b.jpg');
      ctx.google.failDestroyOf(
        stateId,
        `Error trying to delete bucket ${uploads.bucketName} containing objects without force_destroy set to true`,
      );

      const res = await deleteBucket(uploads.bucketId, '?deleteFiles=true');
      expect(res.status).toBe(200);
      const { deploymentId } = (
        res.body as { cloudDelete: { deploymentId: string } }
      ).cloudDelete;

      const row = await settled(uploads.bucketId);
      expect(row?.cloudDelete).toMatchObject({
        status: 'incomplete',
        deleteFiles: true,
        unfinished: null,
        left: [
          {
            type: 'storage.googleapis.com/Bucket',
            awsId: uploads.bucketName,
            region: REGION,
            tag: `cloudgate-state=${idKey(stateId)}`,
            because: 'partly-emptied',
          },
        ],
      });
      expect((await ended(deploymentId))?.status).toBe('error');
      // The key and its account went first, before the emptying.
      expect(runs()).toEqual([
        { run: 'destroy key', stateId, targets: KEY_TARGETS },
        { run: 'apply', stateId, targets: [GCP_BUCKET_ADDRESS] },
        { run: 'destroy', stateId },
      ]);
      expect(await stateOf(uploads.bucketId)).not.toBeNull();
      // A second Delete is refused: only Retry or Forget end it.
      expect((await deleteBucket(uploads.bucketId)).status).toBe(409);

      ctx.google.failDestroyOf(stateId, null);
      ctx.google.holdObjects(uploads.bucketName);
      ctx.google.calls.length = 0;
      expect((await bucketAction(uploads.bucketId, 'retry')).status).toBe(200);
      expect(await settled(uploads.bucketId)).toBeNull();
      expect(runs().map((one) => one.run)).toEqual(['destroy']);
      expect(await stateOf(uploads.bucketId)).toBeNull();
    });
  });

  describe("a Plan's destroy", () => {
    it('shows holds files or empty, read through the Google client port, and keeps the bucket that holds files unless its box is ticked, destroying both keys', async () => {
      const { byName } = await made(TWO_BUCKETS);
      const uploads = byName('uploads');
      const avatars = byName('avatars');
      ctx.google.holdObjects(uploads.bucketName, 'a.jpg');
      ctx.google.holdObjects(avatars.bucketName, 'me.png');

      expect((await save(NO_SERVICES)).status).toBe(201);
      const open = await readPlan();
      expect(
        open.steps.map((step) => [step.action, step.configName, step.files]),
      ).toEqual(
        expect.arrayContaining([
          ['destroy', 'uploads', 'holds-files'],
          ['destroy', 'avatars', 'holds-files'],
        ]),
      );

      const applied = await apply(
        open.planId,
        ['uploads', 'avatars'],
        ['avatars'],
      );
      expect(applied.status).toBe(200);
      const results = (applied.body as PlanBody).results ?? [];
      const of = (configName: string) =>
        results.find((one) => one.configName === configName)!;
      expect(of('uploads')).toMatchObject({
        status: 'applied',
        leftovers: { bucketLeftBehind: keptIn(uploads.bucketName) },
        deploy: { status: 'queued' },
      });
      expect(of('avatars')).toMatchObject({
        status: 'applied',
        leftovers: null,
        deploy: { status: 'queued' },
      });
      expect(await settled(uploads.bucketId)).toBeNull();
      expect(await settled(avatars.bucketId)).toBeNull();
      expect(await ctx.db.select().from(bucket)).toEqual([]);
      expect(await ctx.db.select().from(infrastructureState)).toEqual([]);
      const keyDestroys = runs().filter((one) => one.run === 'destroy key');
      expect(keyDestroys).toHaveLength(2);
    });
  });

  describe("an Environment's Delete", () => {
    it('keeps a bucket that holds files with its key gone, never asking to delete its files, and leaves nothing else', async () => {
      const { byName } = await made(TWO_BUCKETS);
      const uploads = byName('uploads');
      const avatars = byName('avatars');
      ctx.google.holdObjects(uploads.bucketName, 'a.jpg');
      const uploadsState = await stateOf(uploads.bucketId);
      const avatarsState = await stateOf(avatars.bucketId);

      // Offers no box: a deleteFiles it is sent is not read.
      const res = await request(http)
        .delete(`/environments/${environmentId}?deleteFiles=true`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        environmentId,
        bucketsLeftBehind: [keptIn(uploads.bucketName)],
      });
      for (let attempt = 0; attempt < 400; attempt++) {
        const left = await ctx.db
          .select()
          .from(environment)
          .where(eq(environment.environmentId, environmentId));
        if (left.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(
        await ctx.db
          .select()
          .from(environment)
          .where(eq(environment.environmentId, environmentId)),
      ).toEqual([]);
      expect(ctx.google.calls.map((call) => call.method)).not.toContain(
        'apply',
      );
      expect(runs()).toEqual(
        expect.arrayContaining([
          {
            run: 'destroy key',
            stateId: uploadsState.infrastructureStateId,
            targets: KEY_TARGETS,
          },
          { run: 'destroy', stateId: avatarsState.infrastructureStateId },
        ]),
      );
      expect(runs()).toHaveLength(2);
      expect(await ctx.db.select().from(bucket)).toEqual([]);
      expect(await ctx.db.select().from(infrastructureState)).toEqual([]);
      expect((await report(uploads.bucketId)).kept).toEqual([
        keptReport(uploads.bucketName),
      ]);
    });
  });
});
