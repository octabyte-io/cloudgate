import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import {
  BucketKeyRotation,
  KEY_ROTATION_CLOCK,
} from '../../src/buckets/bucket-key-rotation.service';
import {
  application,
  bucket,
  cloudAccount,
  deployment,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import type { Bucket } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { clearWiredChanged, wiredEnv } from '../../src/project-config/outputs';
import {
  storedGoogleOutputs,
  storedGooglePlan,
} from '../utils/fake-google-cloud-port';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(240_000);

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';

/** The bucket and two `web`s linking its key, one also its name. */
const STACK = `version: 1
services:
  uploads:
    kind: bucket
  api:
    kind: web
    source: { image: nginx }
    env:
      - S3_BUCKET: uploads.name
      - AWS_ACCESS_KEY_ID: uploads.access_key_id
      - AWS_SECRET_ACCESS_KEY: uploads.secret_access_key
  admin:
    kind: web
    source: { image: nginx }
    env:
      - KEY_ID: uploads.access_key_id
      - KEY_SECRET: uploads.secret_access_key
`;

/** The key the bucket's create made, as the stored apply answers it. */
const OLD = Object.fromEntries(
  Object.entries(storedGoogleOutputs('bucket-create')).map(([name, output]) => [
    name,
    (output as { value: string }).value,
  ]),
) as { access_key_id: string; secret_access_key: string; bucket_name: string };

/** The key a rotation makes, in the bucket's other key slot. */
const NEW = {
  accessKeyId: 'GOOG1ENEWKEYNEWKEYNEWKEYNEWKEYNEWKEYNEWKEYNEWKEYNEWKEYNEWK',
  secretAccessKey: 'masked-hmac-secret-of-the-rotated-key',
};

/** The stored create's HMAC key change, as `tofu` plans it at `address`. */
function keyChange(
  address: string,
  action: 'create' | 'delete',
): NonNullable<TofuShowJson['resource_changes']>[number] {
  const show = storedGooglePlan('bucket-create') as TofuShowJson;
  const made = (show.resource_changes ?? []).find(
    (change) => change.type === 'google_storage_hmac_key',
  )!;
  const name = address.split('.')[1];
  return action === 'create'
    ? { ...made, address, name }
    : {
        ...made,
        address,
        name,
        change: {
          ...made.change,
          actions: ['delete'],
          before: made.change.after,
          after: null,
          after_unknown: {},
        },
      };
}

/** A plan of the bucket's state that would make or destroy these keys. */
function keysPlan(...changes: [string, 'create' | 'delete'][]): TofuShow {
  const show = storedGooglePlan('bucket-create') as TofuShowJson;
  return {
    ...show,
    resource_changes: changes.map(([address, action]) =>
      keyChange(address, action),
    ),
  };
}

interface Rotation {
  status: string;
  phase: string | null;
  failed: string[];
  message: string | null;
  redeploys: { configName: string; deploymentId: string | null }[];
  putBacks: { configName: string; deploymentId: string | null }[];
}

/**
 * A bucket on Cloud Storage's Rotate key (ADR-0037), which copies a
 * Server's, through the HTTP API. A new HMAC key
 * is made in the bucket's other key slot by a short Cloud run of its own
 * Infrastructure state, every Service linking the key is redeployed with
 * it, and only once all succeeded is the old key turned off and deleted by
 * another, the new key stored encrypted and its slot the live one, so the
 * next plan holds only it. A failed redeploy puts the others back, removes
 * the new key and names the Service. Against `ctx.google`, whose stand-in
 * `tofu` replays what the spec scripts; the build queue is a stub whose
 * Deployments the spec ends by hand.
 */
describe('Bucket Rotate key on Google Cloud (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        {
          provide: KEY_ROTATION_CLOCK,
          useValue: { everyMs: 25, budgetMs: 60_000 },
        },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    queue.add.mockClear();
    // A Google Environment is refused without the install's own address.
    await ctx.db
      .insert(webServerSettings)
      .values({ host: 'cloudgate.example.com', https: true });
    const res = await request(http).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
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
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId,
        name: 'production',
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: row.cloudAccountId,
          region: REGION,
        },
      });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;

    ctx.google.replayPlanFor('network', 'network-create');
    ctx.google.replayOutputsFor('network', 'network-create');
    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.replayPlanFor('bucket', 'bucket-create');
    ctx.google.replayOutputsFor('bucket', 'bucket-create');
  });

  /** Polls until `check` answers something, or fails naming `what`. */
  async function until<T>(
    what: string,
    check: () => Promise<T | null | undefined | false>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 600; attempt++) {
      const found = await check();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Never: ${what}`);
  }

  async function currentPlan() {
    const res = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (
      res.body as {
        plan: {
          planId: string;
          steps: {
            action: string;
            configName?: string;
            cloudRead?: { status: string };
          }[];
        } | null;
      }
    ).plan;
  }

  const readPlan = () =>
    until('the plan read Google Cloud', async () => {
      const found = await currentPlan();
      return found &&
        !found.steps.some((step) => step.cloudRead?.status === 'reading')
        ? found
        : null;
    });

  /** Plans and applies {@link STACK}: the bucket made with its first key. */
  async function made(): Promise<Bucket> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: STACK });
    expect(saved.status).toBe(201);
    const read = await readPlan();
    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(applied.status).toBe(200);
    await until('the Apply ended', async () => {
      const [row] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, read.planId));
      return (
        row.results !== null &&
        !row.results.some((result) => result.status === 'running')
      );
    });
    const row = await until('the bucket made with its key', async () => {
      const [found] = await ctx.db.select().from(bucket);
      return found?.applicationStatus === 'done' && found.accessKeyId
        ? found
        : null;
    });
    expect(row.accessKeyId).toBe(OLD.access_key_id);
    ctx.google.calls.length = 0;
    ctx.google.tofuInputs.length = 0;
    return row;
  }

  const rotate = (bucketId: string) =>
    request(http).post(`/buckets/${bucketId}/rotate-key`).set('Cookie', cookie);

  async function rotation(bucketId: string): Promise<Rotation> {
    const res = await request(http)
      .get(`/buckets/${bucketId}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { keyRotation: Rotation }).keyRotation;
  }

  const ended = (bucketId: string, status: 'done' | 'failed') =>
    until(`the rotation ${status}`, async () => {
      const found = await rotation(bucketId);
      return found.status === status ? found : null;
    });

  /** Ends a queued Deployment as its worker would. */
  const finish = (deploymentId: string | null, status: 'done' | 'error') =>
    ctx.db
      .update(deployment)
      .set({ status, finishedAt: new Date().toISOString() })
      .where(eq(deployment.deploymentId, deploymentId ?? ''));

  /** What a deploy of `configName` now would be handed for its links. */
  async function envOf(configName: string) {
    const [row] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, configName));
    return wiredEnv(ctx.db, environmentId, row.configLinks);
  }

  /** Each key run's `tofu` apply: the slots its definition holds, and its target. */
  const keyApplies = () => {
    const calls = ctx.google.calls.filter((one) => one.method === 'apply');
    return ctx.google.tofuInputs
      .filter((input) => input.method === 'apply')
      .map((input, at) => {
        const definition = JSON.parse(input.definition) as {
          resource: Record<string, Record<string, unknown>>;
        };
        const call = calls[at];
        return {
          slots: Object.keys(definition.resource.google_storage_hmac_key),
          targets: 'targets' in call ? call.targets : undefined,
        };
      });
  };

  const keyRuns = (bucketId: string) =>
    ctx.db
      .select({ title: deployment.title, status: deployment.status })
      .from(deployment)
      .where(
        sql`${deployment.bucketId} = ${bucketId} and ${deployment.title} like '%key'`,
      )
      .orderBy(deployment.createdAt);

  it('makes a new key in the other slot, redeploys every Service linking it with that key, and turns the old one off and deletes it only once all succeeded; the next plan holds only the new key', async () => {
    const created = await made();
    ctx.google.replayShowFor(
      'bucket',
      keysPlan(
        ['google_storage_hmac_key.key_b', 'create'],
        ['google_storage_hmac_key.key', 'delete'],
      ),
    );
    ctx.google.replayOutputValuesFor(
      'bucket',
      {
        bucket_name: created.bucketName,
        access_key_id: OLD.access_key_id,
        secret_access_key: OLD.secret_access_key,
        spare_access_key_id: NEW.accessKeyId,
        spare_secret_access_key: NEW.secretAccessKey,
      },
      ['secret_access_key', 'spare_secret_access_key'],
    );

    const started = await rotate(created.bucketId);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      hasKey: true,
      place: { kind: 'cloud', cloud: 'gcp' },
      keyRotation: { status: 'running', phase: 'redeploying' },
    });
    // The new key, made beside the old by a Cloud run limited to it.
    expect(keyApplies()).toEqual([
      { slots: ['key', 'key_b'], targets: ['google_storage_hmac_key.key_b'] },
    ]);
    expect(await keyRuns(created.bucketId)).toEqual([
      { title: 'Make a new key', status: 'done' },
    ]);

    const state = await rotation(created.bucketId);
    expect(state.redeploys.map((one) => one.configName)).toEqual([
      'admin',
      'api',
    ]);
    // The redeploys are handed the new key, while the old stays stored.
    expect(await envOf('api')).toMatchObject({
      AWS_ACCESS_KEY_ID: NEW.accessKeyId,
      AWS_SECRET_ACCESS_KEY: NEW.secretAccessKey,
    });
    const [during] = await ctx.db.select().from(bucket);
    expect(during.accessKeyId).toBe(OLD.access_key_id);
    // Kept apart from the stored key, encrypted.
    const raw = await ctx.db.execute<{ rotation_keys: string }>(
      sql`select rotation_keys from bucket where bucket_id = ${created.bucketId}`,
    );
    expect(raw.rows[0].rotation_keys).toMatch(/^enc:v1:/);

    // Not while one redeploy is still running.
    await finish(state.redeploys[1].deploymentId, 'done');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(keyApplies()).toHaveLength(1);

    await finish(state.redeploys[0].deploymentId, 'done');
    const done = await ended(created.bucketId, 'done');
    expect(done).toMatchObject({
      failed: [],
      message:
        'admin and api run with the new key, and the old key was removed',
    });
    // The old key destroyed in its slot, the definition holding only the new.
    expect(keyApplies()).toEqual([
      { slots: ['key', 'key_b'], targets: ['google_storage_hmac_key.key_b'] },
      { slots: ['key_b'], targets: ['google_storage_hmac_key.key'] },
    ]);
    expect(await keyRuns(created.bucketId)).toEqual([
      { title: 'Make a new key', status: 'done' },
      { title: 'Remove the old key', status: 'done' },
    ]);

    const [after] = await ctx.db.select().from(bucket);
    expect(after).toMatchObject({
      accessKeyId: NEW.accessKeyId,
      secretAccessKey: NEW.secretAccessKey,
      googleKeySlot: 'key_b',
      rotationKeys: null,
    });
    const stored = await ctx.db.execute<{
      access_key_id: string;
      secret_access_key: string;
    }>(
      sql`select access_key_id, secret_access_key from bucket where bucket_id = ${created.bucketId}`,
    );
    for (const value of Object.values(stored.rows[0])) {
      expect(value).toMatch(/^enc:v1:/);
    }
    // Every linking Service's next deploy is handed the new key.
    expect(await envOf('admin')).toEqual({
      KEY_ID: NEW.accessKeyId,
      KEY_SECRET: NEW.secretAccessKey,
    });
    // Read back only as set.
    const page = await request(http)
      .get(`/buckets/${created.bucketId}`)
      .set('Cookie', cookie);
    expect(page.body).toMatchObject({ hasKey: true });
    for (const secret of [
      OLD.access_key_id,
      OLD.secret_access_key,
      NEW.accessKeyId,
      NEW.secretAccessKey,
    ]) {
      expect(JSON.stringify(page.body)).not.toContain(secret);
      expect(JSON.stringify(started.body)).not.toContain(secret);
    }

    // The next plan that reads the bucket writes only the live key, in its
    // slot: no change to it. An unchanged Project config plans nothing and
    // reads nothing, so an origin edited on its page makes the bucket's a
    // change step, whose read Google answers with no change to any key.
    for (const kind of ['network', 'web', 'bucket'] as const) {
      ctx.google.replayPlanFor(kind, null);
    }
    ctx.google.replayShowFor('bucket', keysPlan());
    const edited = await request(http)
      .put(`/buckets/${created.bucketId}/origins`)
      .set('Cookie', cookie)
      .send({ origins: ['https://shop.example.com'] });
    expect(edited.status).toBe(200);
    ctx.google.tofuInputs.length = 0;
    const again = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: STACK });
    expect(again.status).toBe(201);
    const next = await readPlan();
    expect(next.steps).toEqual([
      expect.objectContaining({ action: 'change', configName: 'uploads' }),
    ]);
    expect(next.steps[0].cloudRead?.status).toBe('read');
    const read = ctx.google.tofuInputs.find(
      (input) =>
        input.method === 'plan' &&
        input.definition.includes('google_storage_bucket'),
    )!;
    const definition = JSON.parse(read.definition) as {
      resource: Record<string, Record<string, unknown>>;
      output: Record<string, { value: string }>;
    };
    expect(Object.keys(definition.resource.google_storage_hmac_key)).toEqual([
      'key_b',
    ]);
    expect(definition.output.access_key_id.value).toBe(
      '${google_storage_hmac_key.key_b.access_id}',
    );
  });

  it('puts the Services already on the new key back on the old one, removes the new key and names the Service whose redeploy failed', async () => {
    const created = await made();
    ctx.google.replayShowFor(
      'bucket',
      keysPlan(['google_storage_hmac_key.key_b', 'create']),
    );
    ctx.google.replayOutputValuesFor(
      'bucket',
      {
        bucket_name: created.bucketName,
        access_key_id: OLD.access_key_id,
        secret_access_key: OLD.secret_access_key,
        spare_access_key_id: NEW.accessKeyId,
        spare_secret_access_key: NEW.secretAccessKey,
      },
      ['secret_access_key', 'spare_secret_access_key'],
    );

    expect((await rotate(created.bucketId)).status).toBe(200);
    // The new key's removal, once it comes, destroys it in its slot.
    ctx.google.replayShowFor(
      'bucket',
      keysPlan(['google_storage_hmac_key.key_b', 'delete']),
    );
    const state = await rotation(created.bucketId);
    const [admin, api] = state.redeploys;
    await finish(api.deploymentId, 'done');
    await finish(admin.deploymentId, 'error');

    const putting = await until('api put back', async () => {
      const found = await rotation(created.bucketId);
      return found.putBacks.length === 1 ? found : null;
    });
    expect(putting).toMatchObject({
      status: 'running',
      phase: 'putting-back',
      failed: ['admin'],
    });
    expect(putting.putBacks[0].configName).toBe('api');
    // The put-back is handed the old key, which stayed valid throughout.
    expect(await envOf('api')).toMatchObject({
      AWS_ACCESS_KEY_ID: OLD.access_key_id,
      AWS_SECRET_ACCESS_KEY: OLD.secret_access_key,
    });
    expect(keyApplies()).toHaveLength(1);

    await finish(putting.putBacks[0].deploymentId, 'done');
    const failed = await ended(created.bucketId, 'failed');
    expect(failed).toMatchObject({
      phase: null,
      failed: ['admin'],
      message:
        'The redeploy of admin failed, so the old key stays in use and the new key was removed — fix admin, then rotate again',
    });
    // The new key destroyed in its slot, the definition holding only the old.
    expect(keyApplies()).toEqual([
      { slots: ['key', 'key_b'], targets: ['google_storage_hmac_key.key_b'] },
      { slots: ['key'], targets: ['google_storage_hmac_key.key_b'] },
    ]);
    expect(await keyRuns(created.bucketId)).toEqual([
      { title: 'Make a new key', status: 'done' },
      { title: 'Remove the new key', status: 'done' },
    ]);
    const [after] = await ctx.db.select().from(bucket);
    expect(after).toMatchObject({
      accessKeyId: OLD.access_key_id,
      secretAccessKey: OLD.secret_access_key,
      googleKeySlot: null,
      rotationKeys: null,
    });
  });

  it('after a put-back that failed, refuses the next rotation, naming the Service still on the kept key, until that Service is deployed again; only then is the kept key destroyed', async () => {
    const created = await made();
    const spare = (key: { accessKeyId: string; secretAccessKey: string }) =>
      ctx.google.replayOutputValuesFor(
        'bucket',
        {
          bucket_name: created.bucketName,
          access_key_id: OLD.access_key_id,
          secret_access_key: OLD.secret_access_key,
          spare_access_key_id: key.accessKeyId,
          spare_secret_access_key: key.secretAccessKey,
        },
        ['secret_access_key', 'spare_secret_access_key'],
      );
    ctx.google.replayShowFor(
      'bucket',
      keysPlan(
        ['google_storage_hmac_key.key_b', 'delete'],
        ['google_storage_hmac_key.key_b', 'create'],
      ),
    );
    spare(NEW);

    // admin's redeploy fails, and api's put-back onto the old key fails too:
    // api runs with the new key, which stays in the other slot for it.
    expect((await rotate(created.bucketId)).status).toBe(200);
    const state = await rotation(created.bucketId);
    const [admin, api] = state.redeploys;
    await finish(api.deploymentId, 'done');
    await finish(admin.deploymentId, 'error');
    const putting = await until('api put back', async () => {
      const found = await rotation(created.bucketId);
      return found.putBacks.length === 1 ? found : null;
    });
    await finish(putting.putBacks[0].deploymentId, 'error');
    const failed = await ended(created.bucketId, 'failed');
    expect(failed.message).toBe(
      'The redeploy of admin failed, so the old key stays in use; api could not be put back on it, so the new key stays valid for it until the next rotation removes it',
    );
    const [apiRow] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'api'));
    expect(apiRow.wiredChangedAt).not.toBeNull();
    expect(keyApplies()).toHaveLength(1);

    // The next rotation would destroy the key api runs with before
    // redeploying it: refused, with nothing changed on Google.
    ctx.google.calls.length = 0;
    const refused = await rotate(created.bucketId);
    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toBe(
      "api still runs with the key uploads's last rotation could not take back, and a new key would replace it: deploy api first, so it runs with the key in use, then rotate",
    );
    expect(ctx.google.calls).toEqual([]);
    expect((await rotation(created.bucketId)).status).toBe('failed');

    // api is deployed again, with the stored key: the rotation goes ahead,
    // destroying the kept key before making the newest in its slot.
    await clearWiredChanged(
      ctx.db,
      { serviceType: 'application', serviceId: apiRow.applicationId },
      new Date().toISOString(),
    );
    ctx.google.tofuInputs.length = 0;
    spare({
      accessKeyId: 'GOOG1ENEWESTKEYNEWESTKEYNEWESTKEYNEWESTKEYNEWESTKEYNEWES',
      secretAccessKey: 'masked-hmac-secret-of-the-newest-key',
    });
    const again = await rotate(created.bucketId);
    expect(again.status).toBe(200);
    expect(keyApplies()).toEqual([
      { slots: ['key'], targets: ['google_storage_hmac_key.key_b'] },
      { slots: ['key', 'key_b'], targets: ['google_storage_hmac_key.key_b'] },
    ]);
  });

  it('destroys the key a rotation cut off by a restart may have made before it was stored, so the next plan shows no Drift', async () => {
    const created = await made();
    // Google made the new key in the other slot, then Cloudgate restarted
    // before the row held it: the rotation is running, its phase not set.
    ctx.google.replayShowFor(
      'bucket',
      keysPlan(['google_storage_hmac_key.key_b', 'delete']),
    );
    await ctx.db
      .update(bucket)
      .set({
        keyRotation: {
          status: 'running',
          phase: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          queued: false,
          redeploys: [],
          putBacks: [],
          failed: [],
          message: null,
        },
      })
      .where(eq(bucket.bucketId, created.bucketId));

    await ctx.app.get(BucketKeyRotation).onApplicationBootstrap();

    const failed = await ended(created.bucketId, 'failed');
    expect(failed.message).toBe(
      'The rotation was interrupted before its new key was stored, so nothing changed and the old key stays in use — rotate again',
    );
    // Destroyed in its slot, the definition holding only the live key.
    expect(keyApplies()).toEqual([
      { slots: ['key'], targets: ['google_storage_hmac_key.key_b'] },
    ]);
    expect(await keyRuns(created.bucketId)).toEqual([
      { title: 'Remove the unstored key', status: 'done' },
    ]);
    const [after] = await ctx.db.select().from(bucket);
    expect(after).toMatchObject({
      accessKeyId: OLD.access_key_id,
      googleKeySlot: null,
      rotationKeys: null,
    });
  });

  it('refuses a rotation whose key run would do more than make the new key, applying nothing', async () => {
    const created = await made();
    // A key already in the other slot, which the run would replace.
    const replace = keyChange('google_storage_hmac_key.key_b', 'create');
    ctx.google.replayShowFor('bucket', {
      ...(storedGooglePlan('bucket-create') as TofuShowJson),
      resource_changes: [
        {
          ...replace,
          change: { ...replace.change, actions: ['delete', 'create'] },
        },
      ],
    });

    const refused = await rotate(created.bucketId);
    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toBe(
      'Cloudgate could not make a new key for uploads, so nothing changed and the old key stays in use — its Make a new key run says why; try again',
    );
    expect(await keyRuns(created.bucketId)).toEqual([
      { title: 'Make a new key', status: 'error' },
    ]);
    const [run] = await ctx.db
      .select({ description: deployment.description })
      .from(deployment)
      .where(sql`${deployment.title} = 'Make a new key'`);
    expect(run.description).toContain(
      'Rotating the key would also replace google_storage_hmac_key.key_b. Nothing was applied',
    );
    const [after] = await ctx.db.select().from(bucket);
    expect(after).toMatchObject({
      accessKeyId: OLD.access_key_id,
      rotationKeys: null,
    });
    expect(after.keyRotation?.status).toBe('failed');
  });

  it('refuses a bucket whose Cloud run has not made it yet', async () => {
    const created = await made();
    await ctx.db
      .update(bucket)
      .set({ applicationStatus: 'running' })
      .where(eq(bucket.bucketId, created.bucketId));

    const refused = await rotate(created.bucketId);
    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toBe(
      "uploads's key cannot be rotated while its Cloud run has not finished; rotate once it is made",
    );
    expect(ctx.google.calls).toEqual([]);
  });
});
