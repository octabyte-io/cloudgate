import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import {
  auditLog,
  bucket,
  cloudAccount,
  deployment,
  environment,
} from '../../src/db/schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

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
 * A bucket on AWS's Delete, inside the cloud Delete (ADR-0038),
 * through the HTTP API with the object-storage port's fake (`ctx.objectStorage`,
 * which keys S3 buckets by real name) and the `tofu` fake (`ctx.cloud`).
 *
 * A bucket that holds files is kept and named with its account and region,
 * its row and state gone and nothing in AWS touched; an empty one is
 * destroyed by a destroy-only Cloud run; "also delete its files" empties it
 * through the port first; an emptying that stops partway leaves it "partly
 * emptied" and the Delete incomplete; an Environment's Delete keeps and names
 * each bucket that holds files.
 */
describe('A bucket on AWS: Delete (e2e)', () => {
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
      .send({ name: 'Shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;

    const [row] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name: 'Production AWS',
        cloud: 'aws',
        cloudId: ACCOUNT,
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy`,
        taskExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution`,
        externalId: 'external-id-made-by-cloudgate',
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

    ctx.cloud.replayPlanFor('bucket', 'bucket-create');
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;
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

  /** The open plan once no step is still reading AWS. */
  async function readPlan(): Promise<PlanBody> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = await currentPlan();
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading AWS');
  }

  /** A Deployment once its Cloud run has ended, or `null` once it is gone with its bucket. */
  async function ended(deploymentId: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
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
    for (let attempt = 0; attempt < 200; attempt++) {
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
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;
    ctx.objectStorage.calls.length = 0;
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

  const destroys = () =>
    ctx.cloud.calls.filter((call) => call.method === 'destroy');

  /** What a kept bucket is named with: its account and region. */
  const keptIn = (bucketName: string, because = 'holds-files') => ({
    bucketName,
    because,
    cloud: {
      cloudAccountId,
      cloudAccountName: 'Production AWS',
      awsAccountId: ACCOUNT,
      region: REGION,
    },
  });

  describe("the bucket's own Delete", () => {
    it('keeps a bucket that holds files, names it with its account and region, and removes its row and state, touching nothing in AWS', async () => {
      const { uploads } = await made();
      const state = await stateOf(uploads.bucketId);
      expect(state).not.toBeNull();
      ctx.objectStorage.put(uploads.bucketName, 'version', 'a.jpg');

      const res = await deleteBucket(uploads.bucketId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        volumeLeftBehind: false,
        bucketLeftBehind: keptIn(uploads.bucketName),
      });
      // Read through the port against S3: AWS's own endpoint, the deploy
      // role's session, virtual-hosted addressing.
      expect(ctx.objectStorage.calls.map((one) => one.call)).toEqual([
        'contentsOf',
      ]);
      const [{ target }] = ctx.objectStorage.calls;
      expect(target).toMatchObject({
        endpoint: null,
        region: REGION,
        bucket: uploads.bucketName,
        pathStyle: false,
      });
      expect(target.credential.sessionToken).toEqual(expect.any(String));
      expect(destroys()).toEqual([]);
      expect(await ctx.db.select().from(bucket)).toEqual([]);
      expect(await stateOf(uploads.bucketId)).toBeNull();
      expect(
        await ctx.db
          .select()
          .from(infrastructureState)
          .where(
            eq(
              infrastructureState.infrastructureStateId,
              state.infrastructureStateId,
            ),
          ),
      ).toEqual([]);
      expect(ctx.objectStorage.entriesOf(uploads.bucketName)).toEqual([
        'version:a.jpg',
      ]);
    });

    it('keeps a bucket it cannot read, as if it holds files', async () => {
      const { uploads } = await made();
      ctx.objectStorage.makeUnreadable(uploads.bucketName);

      const res = await deleteBucket(uploads.bucketId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        volumeLeftBehind: false,
        bucketLeftBehind: keptIn(uploads.bucketName, 'unknown'),
      });
      expect(destroys()).toEqual([]);
    });

    it('destroys an empty bucket by a destroy-only Cloud run, then drops its row and state', async () => {
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
      expect(destroys()).toEqual([
        expect.objectContaining({ stateId: state.infrastructureStateId }),
      ]);
      // Checked afterwards by the state's tag.
      expect(ctx.cloud.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'findTagged',
            region: REGION,
            tags: { 'cloudgate:state': state.infrastructureStateId },
          }),
        ]),
      );
      expect(await stateOf(uploads.bucketId)).toBeNull();
      expect(
        await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.deploymentId, deploymentId)),
      ).toEqual([]);
      const audited = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resourceId, uploads.bucketId));
      expect(
        audited.map((entry) => [
          entry.action,
          entry.resourceType,
          JSON.parse(entry.metadata as string) as unknown,
        ]),
      ).toContainEqual(['delete', 'bucket', { cloudDelete: 'finished' }]);
    });

    it('"also delete its files" empties it through the port, old versions and delete markers included, then destroys it', async () => {
      const { uploads } = await made();
      ctx.objectStorage.put(uploads.bucketName, 'object', 'a.jpg');
      ctx.objectStorage.put(uploads.bucketName, 'version', 'a.jpg');
      ctx.objectStorage.put(uploads.bucketName, 'delete-marker', 'b.jpg');

      const res = await deleteBucket(uploads.bucketId, '?deleteFiles=true');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ cloudDelete: { status: 'deleting' } });
      expect(await settled(uploads.bucketId)).toBeNull();
      expect(ctx.objectStorage.entriesOf(uploads.bucketName)).toEqual([]);
      expect(ctx.objectStorage.calls.map((one) => one.call)).toEqual([
        'contentsOf',
        'empty',
      ]);
      expect(ctx.objectStorage.calls[1].target).toMatchObject({
        endpoint: null,
        bucket: uploads.bucketName,
        pathStyle: false,
      });
      expect(destroys()).toHaveLength(1);
      expect(await stateOf(uploads.bucketId)).toBeNull();
    });

    it('an emptying that stops partway leaves the bucket "partly emptied", destroys nothing and keeps the row Delete incomplete, until Forget', async () => {
      const { uploads } = await made();
      const state = await stateOf(uploads.bucketId);
      ctx.objectStorage.put(uploads.bucketName, 'object', 'a', 'b', 'c');
      ctx.objectStorage.failEmptyAfter(uploads.bucketName, 1);

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
            type: 's3',
            awsId: `arn:aws:s3:::${uploads.bucketName}`,
            region: REGION,
            tag: `cloudgate:state=${state.infrastructureStateId}`,
            because: 'partly-emptied',
          },
        ],
      });
      expect((await ended(deploymentId))?.status).toBe('error');
      expect(destroys()).toEqual([]);
      expect(ctx.objectStorage.entriesOf(uploads.bucketName)).toEqual([
        'object:b',
        'object:c',
      ]);
      expect(await stateOf(uploads.bucketId)).not.toBeNull();

      // Its page reads Delete incomplete, with what is left.
      const page = await request(http)
        .get(`/buckets/${uploads.bucketId}`)
        .set('Cookie', cookie);
      expect(page.body).toMatchObject({
        cloudDelete: {
          status: 'incomplete',
          left: [expect.objectContaining({ because: 'partly-emptied' })],
        },
      });
      // A second Delete is refused: only Retry or Forget end it.
      expect((await deleteBucket(uploads.bucketId)).status).toBe(409);
      // It has left the config: the next plan neither destroys nor keeps it.
      expect((await save(NO_SERVICES)).status).toBe(201);
      expect((await readPlan()).steps).toEqual([]);

      const forgotten = await bucketAction(uploads.bucketId, 'forget');
      expect(forgotten.status).toBe(200);
      expect(forgotten.body).toMatchObject({
        bucketId: uploads.bucketId,
        forgotten: [expect.objectContaining({ because: 'partly-emptied' })],
      });
      expect(await ctx.db.select().from(bucket)).toEqual([]);
      expect(await stateOf(uploads.bucketId)).toBeNull();
    });

    it('Retry of a partly emptied bucket empties it again, and destroys it once it is empty', async () => {
      const { uploads } = await made();
      ctx.objectStorage.put(uploads.bucketName, 'object', 'a', 'b');
      ctx.objectStorage.failEmptyAfter(uploads.bucketName, 1);
      expect(
        (await deleteBucket(uploads.bucketId, '?deleteFiles=true')).status,
      ).toBe(200);
      expect((await settled(uploads.bucketId))?.cloudDelete?.status).toBe(
        'incomplete',
      );

      // The fake fails every emptying after one entry: with one left, the
      // next takes it.
      const retried = await bucketAction(uploads.bucketId, 'retry');
      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({
        cloudDelete: { status: 'deleting' },
      });
      const after = await settled(uploads.bucketId);
      expect(after?.cloudDelete?.left).toEqual([
        expect.objectContaining({ because: 'partly-emptied' }),
      ]);
      expect(destroys()).toEqual([]);

      // Empty now, the next Retry destroys it, and the Delete finishes.
      expect(ctx.objectStorage.entriesOf(uploads.bucketName)).toEqual([]);
      expect((await bucketAction(uploads.bucketId, 'retry')).status).toBe(200);
      expect(await settled(uploads.bucketId)).toBeNull();
      expect(destroys()).toHaveLength(1);
    });
  });

  describe("a Plan's destroy", () => {
    it('shows holds files or empty, read against S3, and keeps the bucket that holds files unless its box is ticked', async () => {
      const { byName } = await made(TWO_BUCKETS);
      const uploads = byName('uploads');
      const avatars = byName('avatars');
      ctx.objectStorage.put(uploads.bucketName, 'object', 'a.jpg');
      ctx.objectStorage.put(avatars.bucketName, 'delete-marker', 'me.png');

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
        deploy: null,
      });
      expect(of('avatars')).toMatchObject({
        status: 'applied',
        leftovers: null,
        deploy: { status: 'queued' },
      });
      expect(await settled(avatars.bucketId)).toBeNull();
      expect(ctx.objectStorage.entriesOf(avatars.bucketName)).toEqual([]);
      expect(ctx.objectStorage.entriesOf(uploads.bucketName)).toEqual([
        'object:a.jpg',
      ]);
      expect(await ctx.db.select().from(bucket)).toEqual([]);
    });
  });

  describe("an Environment's Delete", () => {
    it('keeps and names each bucket that holds files, never deleting its files, and destroys the empty ones', async () => {
      const { byName } = await made(TWO_BUCKETS);
      const uploads = byName('uploads');
      const avatars = byName('avatars');
      ctx.objectStorage.put(uploads.bucketName, 'object', 'a.jpg');
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
      for (let attempt = 0; attempt < 200; attempt++) {
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
      expect(ctx.objectStorage.calls.map((one) => one.call)).not.toContain(
        'empty',
      );
      expect(ctx.objectStorage.entriesOf(uploads.bucketName)).toEqual([
        'object:a.jpg',
      ]);
      expect(destroys()).toEqual([
        expect.objectContaining({
          stateId: avatarsState.infrastructureStateId,
        }),
      ]);
      expect(await ctx.db.select().from(bucket)).toEqual([]);
      expect(await ctx.db.select().from(infrastructureState)).toEqual([]);
    });
  });
});
