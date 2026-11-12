import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { BucketsService } from '../../src/buckets/buckets.service';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import { bucketKeyAccountEmail } from '../../src/cloud-accounts/gcp/definitions/bucket-definition';
import { bucketAccessRevoke } from '../../src/cloud-accounts/gcp/plan-reader/existing-bucket';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import type { StorageBucketRead } from '../../src/cloud-accounts/google-cloud.port';
import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import {
  bucket,
  cloudAccount,
  deployment,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import type { Plan } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { wiredEnv } from '../../src/project-config/outputs';
import {
  cloudReadOf,
  isQuietRead,
} from '../../src/project-config/planner/cloud-steps';
import type { PlanStep } from '../../src/project-config/planner/plan.types';
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
/** The operator's own bucket, made outside Cloudgate. */
const NAME = 'acme-prod-uploads';

const UPLOADS = `version: 1
services:
  uploads:
    kind: bucket
`;

/** The bucket as Cloud Storage reads it: in another project, in the region. */
const ELSEWHERE: StorageBucketRead = {
  location: 'EUROPE-WEST1',
  locationType: 'region',
  dataLocations: [],
  requesterPays: false,
  labels: { team: 'shop' },
  projectNumber: '999999999999',
};

/** The key the stored apply of an existing bucket's definition answers. */
const KEY = (() => {
  const outputs = storedGoogleOutputs('existing-bucket-create') as Record<
    string,
    { value: string }
  >;
  return {
    accessKeyId: outputs.access_key_id.value,
    secretAccessKey: outputs.secret_access_key.value,
  };
})();

/** The key a rotation makes, in the bucket's other key slot. */
const NEW = {
  accessKeyId: 'GOOG1ENEWKEYNEWKEYNEWKEYNEWKEYNEWKEYNEWKEYNEWKEYNEWKEYNEWK',
  secretAccessKey: 'masked-hmac-secret-of-the-rotated-key',
};

const LINKS = {
  S3_BUCKET: { source: 'uploads', output: 'name' },
  S3_REGION: { source: 'uploads', output: 'region' },
  S3_ENDPOINT: { source: 'uploads', output: 'endpoint' },
  AWS_ACCESS_KEY_ID: { source: 'uploads', output: 'access_key_id' },
  AWS_SECRET_ACCESS_KEY: { source: 'uploads', output: 'secret_access_key' },
  S3_PATH_STYLE: { source: 'uploads', output: 'path_style' },
};

/** A plan of the bucket's state that would make or destroy these keys. */
function keysPlan(...changes: [string, 'create' | 'delete'][]): TofuShow {
  const show = storedGooglePlan('existing-bucket-create') as TofuShowJson;
  const made = (show.resource_changes ?? []).find(
    (change) => change.type === 'google_storage_hmac_key',
  )!;
  return {
    ...show,
    resource_changes: changes.map(([address, action]) => {
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
    }),
  };
}

interface GoogleAccess {
  status: string;
  serviceAccount: string;
  grant: string;
  sentence: string | null;
}

/**
 * An existing bucket on Google Cloud (ADR-0033 as amended): a Cloud Storage
 * bucket made outside Cloudgate, in any project, used as an Environment's
 * `bucket`, through the HTTP API against `ctx.google`. Every plan looks it up
 * through the Google client port; Cloudgate makes only the bucket Service's own
 * service account and HMAC key, at $0/month, and never changes the bucket or adds
 * the grant. Access is checked by a one-file list made with the key, never ticked; its
 * Delete leaves the bucket and names the grant left on it.
 */
describe('An existing Cloud Storage bucket used as an Environment’s bucket on Google Cloud (e2e)', () => {
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

    ctx.google.replayPlanFor('existing-bucket', 'existing-bucket-create');
    ctx.google.replayOutputsFor('existing-bucket', 'existing-bucket-create');
    ctx.google.replayPlanFor('bucket', 'bucket-create');
    ctx.google.replayOutputsFor('bucket', 'bucket-create');
    ctx.google.storageBucketAnswers(NAME, ELSEWHERE);
  });

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  const apply = (planId: string, body: Record<string, unknown> = {}) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId, ...body });

  const page = (bucketId: string) =>
    request(http).get(`/buckets/${bucketId}`).set('Cookie', cookie);

  async function until<T>(
    look: () => Promise<T | undefined | null>,
    what: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 600; attempt++) {
      const found = await look();
      if (found !== undefined && found !== null) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Waited in vain for ${what}`);
  }

  /** The open plan once no step still reads Google Cloud. */
  const readPlan = () =>
    until(async () => {
      const res = await request(http)
        .get(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie);
      const found = (res.body as { plan?: Plan & { steps: PlanStep[] } }).plan;
      return found &&
        !found.steps.some((step) => cloudReadOf(step)?.status === 'reading') &&
        // A plan of quiet reads only is settled `unchanged` just after its
        // last read is written.
        !(found.status === 'open' && found.steps.every(isQuietRead))
        ? found
        : undefined;
    }, 'the plan to be read');

  /** "Use an existing bucket" for `uploads`: the bucket Service, named. */
  async function created(bucketName = NAME): Promise<string> {
    const res = await request(http)
      .post('/buckets/existing')
      .set('Cookie', cookie)
      .send({ environmentId, configName: 'uploads', bucketName });
    expect(res.status).toBe(201);
    return (res.body as { bucketId: string }).bucketId;
  }

  /** A plan of `text`, and its `uploads` step. */
  async function lookupOf(text = UPLOADS) {
    expect((await save(text)).status).toBe(201);
    const read = await readPlan();
    const step = read.steps.find(
      (one) => 'configName' in one && one.configName === 'uploads',
    );
    if (!step) throw new Error('uploads has no step');
    return { plan: read, step, read: cloudReadOf(step)! };
  }

  const appliedPlan = (planId: string) =>
    until(async () => {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, planId));
      return found?.results &&
        !found.results.some((result) => result.status === 'running')
        ? found
        : undefined;
    }, 'the Apply to end');

  const ended = (deploymentId: string) =>
    until(async () => {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      return row && ['done', 'error', 'cancelled'].includes(row.status)
        ? row
        : undefined;
    }, `Deployment ${deploymentId} to end`);

  /** The Deployment a step's result queued. */
  function runOf(result: { deploy?: unknown } | undefined): string {
    const id = (result?.deploy as { deploymentId?: string } | null | undefined)
      ?.deploymentId;
    if (!id) throw new Error(`No run was queued: ${JSON.stringify(result)}`);
    return id;
  }

  /** Looks it up and applies the plan: its account and key made. */
  async function made() {
    const bucketId = await created();
    const { plan } = await lookupOf();
    const res = await apply(plan.planId);
    expect(res.status).toBe(200);
    const applied = await appliedPlan(plan.planId);
    const result = applied.results!.find((one) => one.configName === 'uploads');
    expect(result).toMatchObject({ status: 'applied' });
    const run = await ended(runOf(result));
    expect(run.status).toBe('done');
    // A later plan of the state finds the key as written.
    ctx.google.replayPlanFor('existing-bucket', null);
    const [row] = await ctx.db
      .select()
      .from(bucket)
      .where(eq(bucket.bucketId, bucketId));
    ctx.google.calls.length = 0;
    ctx.google.tofuInputs.length = 0;
    return row;
  }

  const keyAccount = (bucketId: string) =>
    bucketKeyAccountEmail(bucketId, PROJECT);

  it('shows the form the legacyBucketReader grant Cloudgate’s service account needs on a bucket in another project', async () => {
    const res = await request(http)
      .get(
        `/buckets/existing/reach?environmentId=${encodeURIComponent(environmentId)}`,
      )
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      google: {
        projectId: PROJECT,
        serviceAccount: GOOGLE_COLUMNS.deployServiceAccount,
        readGrant: `gcloud storage buckets add-iam-policy-binding gs://<bucket> --member=serviceAccount:${GOOGLE_COLUMNS.deployServiceAccount} --role=roles/storage.legacyBucketReader`,
      },
    });
  });

  it('refuses a name Cloud Storage would not take, and takes one with underscores', async () => {
    const refused = await request(http)
      .post('/buckets/existing')
      .set('Cookie', cookie)
      .send({ environmentId, configName: 'uploads', bucketName: 'a_' });
    expect(refused.status).toBe(400);
    expect(await ctx.db.select().from(bucket)).toEqual([]);

    await created('acme_prod_uploads');
  });

  it('plans a bucket in another project at $0/month, used as given, making only its own service account and key', async () => {
    const bucketId = await created();

    const { step, read } = await lookupOf();

    expect(step).toMatchObject({
      action: 'change',
      serviceId: bucketId,
      existing: { identifier: NAME },
    });
    if (read.status !== 'read') throw new Error(JSON.stringify(read));
    expect(read.summary[0]).toBe(
      `uploads: existing bucket ${NAME} in EUROPE-WEST1, in another project, used as given: Cloudgate changes nothing in it and makes only its own service account and HMAC key for it, $0/month`,
    );
    expect(
      read.raw.map(({ address, action }) => ({ address, action })),
    ).toEqual([
      { address: 'google_service_account.bucket', action: 'create' },
      { address: 'google_storage_hmac_key.key', action: 'create' },
    ]);
    // Looked up with Cloudgate's own token; the definition holds no bucket.
    expect(ctx.google.calls).toContainEqual({
      method: 'storageBucket',
      impersonated: true,
      bucket: NAME,
    });
    const [planned] = ctx.google.tofuInputs.filter(
      (one) => one.method === 'plan',
    );
    const definition = JSON.parse(planned.definition) as {
      resource: Record<string, unknown>;
    };
    expect(Object.keys(definition.resource).sort()).toEqual([
      'google_service_account',
      'google_storage_hmac_key',
    ]);
    // Nothing is made before its Apply.
    expect(await ctx.db.select().from(infrastructureState)).toEqual([]);
  });

  it.each([
    [
      'a bucket Google Cloud cannot find',
      () => ctx.google.storageBucketAnswers(NAME, null),
      `uploads uses the existing bucket ${NAME}, but Google Cloud cannot find it. Check its name on uploads's page`,
    ],
    [
      'a bucket Cloudgate may not read, naming the legacyBucketReader grant',
      () => ctx.google.permissionDenied('storageBucket', 'Access denied.'),
      `uploads uses the existing bucket ${NAME}, but Cloudgate may not read it (Access denied.). A bucket in another project needs Cloudgate's service account to read it, so that every plan can look it up: \`gcloud storage buckets add-iam-policy-binding gs://${NAME} --member=serviceAccount:${GOOGLE_COLUMNS.deployServiceAccount} --role=roles/storage.legacyBucketReader\``,
    ],
    [
      'a requester-pays bucket, naming how to turn it off',
      () =>
        ctx.google.storageBucketAnswers(NAME, {
          ...ELSEWHERE,
          requesterPays: true,
        }),
      `uploads uses the existing bucket ${NAME}, but it has requester pays on, and the S3 SDK its linked Services use cannot name a project to bill. Turn it off: \`gcloud storage buckets update gs://${NAME} --no-requester-pays\``,
    ],
    [
      "a bucket carrying Cloudgate's labels",
      () =>
        ctx.google.storageBucketAnswers(NAME, {
          ...ELSEWHERE,
          labels: { 'cloudgate-state': 'abc' },
        }),
      `uploads uses the existing bucket ${NAME}, but it carries Cloudgate's labels (cloudgate-state), so Cloudgate made it for an Environment; an existing bucket must be one Cloudgate did not make`,
    ],
  ])('refuses %s, refusing the Apply', async (_what, script, reason) => {
    await created();
    script();

    const { plan, read } = await lookupOf();

    expect(read).toEqual({ status: 'failed', reason });
    const res = await apply(plan.planId);
    expect(res.status).toBe(409);
    expect(await ctx.db.select().from(infrastructureState)).toEqual([]);
  });

  it("notes a location that does not hold the Environment's region, and plans it all the same", async () => {
    await created();
    ctx.google.storageBucketAnswers(NAME, {
      ...ELSEWHERE,
      location: 'US',
      locationType: 'multi-region',
    });

    const { read } = await lookupOf();

    if (read.status !== 'read') throw new Error(JSON.stringify(read));
    expect(read.summary).toContain(
      `uploads: ${NAME} is in US, which does not hold this Environment's region europe-west1: its linked Services reach it across regions, which is slower and charged between regions`,
    );
  });

  it('after the Apply shows the add-iam-policy-binding command and "waiting for access", ok once the key’s list succeeds, "no access" when it fails later, while a linked web is handed its Outputs throughout', async () => {
    const row = await made();
    const grant = `gcloud storage buckets add-iam-policy-binding gs://${NAME} --member=serviceAccount:${keyAccount(row.bucketId)} --role=roles/storage.objectUser`;
    const outputs = {
      S3_BUCKET: NAME,
      S3_REGION: 'auto',
      S3_ENDPOINT: 'https://storage.googleapis.com',
      AWS_ACCESS_KEY_ID: KEY.accessKeyId,
      AWS_SECRET_ACCESS_KEY: KEY.secretAccessKey,
      S3_PATH_STYLE: 'true',
    };

    // The run saved the key, then checked it: no grant yet.
    expect(row).toMatchObject({
      accessKeyId: KEY.accessKeyId,
      applicationStatus: 'done',
      googleAccess: 'waiting',
      appliedOrigins: [],
    });
    const waiting = await page(row.bucketId);
    expect(waiting.status).toBe(200);
    expect(waiting.body).toMatchObject({ existing: true, hasKey: true });
    // Its place names its own project, its key the Cloud account's.
    expect((waiting.body as { place: unknown }).place).toEqual({
      kind: 'cloud',
      cloudAccountId: expect.any(String) as string,
      cloudAccountName: 'Production Google',
      cloudId: PROJECT,
      cloud: 'gcp',
      region: REGION,
      bucketProjectNumber: ELSEWHERE.projectNumber,
    });
    expect(
      (waiting.body as { googleAccess: GoogleAccess }).googleAccess,
    ).toEqual({
      status: 'waiting',
      checkedAt: expect.any(String) as string,
      serviceAccount: keyAccount(row.bucketId),
      grant,
      sentence: `Waiting for access: ${NAME} does not let uploads's key in yet. Grant it on the bucket, then reload this page: \`${grant}\``,
    });
    expect(JSON.stringify(waiting.body)).not.toContain(KEY.secretAccessKey);
    // The check is a list made with the bucket's key, never a token,
    // through the object-storage port at Cloud Storage's S3 API.
    expect(ctx.objectStorage.calls).toContainEqual({
      call: 'access',
      target: {
        endpoint: 'https://storage.googleapis.com',
        region: 'auto',
        bucket: NAME,
        credential: KEY,
        pathStyle: true,
      },
    });
    // A linked web deploys at once: it is never held for the grant.
    expect(await wiredEnv(ctx.db, environmentId, LINKS)).toEqual(outputs);

    ctx.objectStorage.keyReaches(NAME, true);
    // The page is read once, its access check folded into that read.
    const reads = jest.spyOn(ctx.app.get(BucketsService), 'findOne');
    const ok = await page(row.bucketId);
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
    expect(ok.body).toMatchObject({
      googleAccess: { status: 'ok', grant, sentence: null },
    });

    ctx.objectStorage.keyReaches(NAME, false);
    const lost = await page(row.bucketId);
    expect(lost.body).toMatchObject({
      googleAccess: {
        status: 'no-access',
        grant,
        sentence: `No access: uploads's key can no longer list ${NAME}, so the Services linking it cannot reach its files. Grant it again: \`${grant}\``,
      },
    });
    expect(await wiredEnv(ctx.db, environmentId, LINKS)).toEqual(outputs);

    // A plan neither waits on it nor refuses for it.
    const { read } = await lookupOf();
    expect(read.status).toBe('read');
    const [after] = await ctx.db.select().from(bucket);
    expect(after.googleAccess).toBe('no-access');
  });

  it('never writes its browser-upload origins', async () => {
    const bucketId = await created();

    const res = await request(http)
      .put(`/buckets/${bucketId}/origins`)
      .set('Cookie', cookie)
      .send({ origins: ['https://shop.example.com'] });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'EXISTING_BUCKET_NOT_MANAGED',
      message: `${NAME} is an existing bucket, which Cloudgate uses but never changes, so its browser-upload origins are its own CORS, set in Google Cloud`,
    });
  });

  describe('Delete', () => {
    it('leaves the bucket untouched, destroys its key and account, refuses "also delete its files" and names the remove-iam-policy-binding command', async () => {
      const row = await made();
      ctx.google.holdObjects(NAME, 'a.jpg');
      const remove = bucketAccessRevoke(NAME, keyAccount(row.bucketId));

      const refused = await request(http)
        .delete(`/buckets/${row.bucketId}?deleteFiles=true`)
        .set('Cookie', cookie);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'EXISTING_BUCKET_FILES_NOT_DELETED',
      });

      const res = await request(http)
        .delete(`/buckets/${row.bucketId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        volumeLeftBehind: false,
        cloudDelete: {
          status: 'deleting',
          deploymentId: expect.any(String) as string,
        },
        bucketLeftAsItWas: {
          bucketName: NAME,
          grantLeft: {
            serviceAccount: keyAccount(row.bucketId),
            command: remove,
          },
          message: `${NAME} was left as it was, files and all; it is yours. Cloudgate destroys only the HMAC key and service account it made for uploads. The grant you added on ${NAME} is left too, naming ${keyAccount(row.bucketId)}, which gives nobody access once it is gone; remove it with \`${remove}\`. If the Project config still lists uploads, the next plan creates it as a new, empty bucket.`,
        },
      });
      await until(async () => {
        const rows = await ctx.db.select().from(bucket);
        return rows.length === 0 ? true : undefined;
      }, 'the bucket row to go');
      // A destroy of its whole state: its account and key, nothing else.
      const destroys = ctx.google.calls.filter(
        (one) => one.method === 'destroy',
      );
      expect(destroys).toHaveLength(1);
      expect(destroys[0]).toMatchObject({ kind: 'destroy' });
      expect(destroys[0]).not.toHaveProperty('targets');
      // Its files were never read nor touched.
      expect(
        ctx.google.calls.filter((one) =>
          ['listObjects', 'deleteObject'].includes(one.method),
        ),
      ).toEqual([]);
      expect(ctx.google.objectsOf(NAME)).toEqual(['a.jpg']);
      expect(await ctx.db.select().from(infrastructureState)).toEqual([]);
    });

    it("a plan's destroy takes no files tick, destroys its key and names the grant left", async () => {
      const row = await made();
      expect((await save('version: 1\nservices: {}\n')).status).toBe(201);
      const read = await readPlan();
      const destroy = read.steps.find((one) => one.action === 'destroy');
      expect(destroy).toMatchObject({
        configName: 'uploads',
        existing: { identifier: NAME },
      });

      const ticked = await apply(read.planId, {
        confirmDestroy: ['uploads'],
        deleteFilesOf: ['uploads'],
      });
      expect(ticked.status).toBe(409);
      const res = await apply(read.planId, { confirmDestroy: ['uploads'] });
      expect(res.status).toBe(200);
      const applied = await appliedPlan(read.planId);
      const result = applied.results!.find(
        (one) => one.configName === 'uploads',
      );
      expect(result).toMatchObject({
        action: 'destroy',
        deploy: { status: 'queued' },
      });
      expect(result?.leftovers?.bucketLeftAsItWas?.grantLeft).toEqual({
        serviceAccount: keyAccount(row.bucketId),
        command: bucketAccessRevoke(NAME, keyAccount(row.bucketId)),
      });
      await until(async () => {
        const rows = await ctx.db.select().from(bucket);
        return rows.length === 0 ? true : undefined;
      }, 'the bucket row to go');
    });
  });

  it('rotates its key as a Cloudgate-made bucket’s: a new key in the other slot, then the old one destroyed, each run holding only its account and keys', async () => {
    const row = await made();
    ctx.google.replayShowFor(
      'existing-bucket',
      keysPlan(
        ['google_storage_hmac_key.key_b', 'create'],
        ['google_storage_hmac_key.key', 'delete'],
      ),
    );
    ctx.google.replayOutputValuesFor(
      'existing-bucket',
      {
        bucket_name: NAME,
        access_key_id: KEY.accessKeyId,
        secret_access_key: KEY.secretAccessKey,
        spare_access_key_id: NEW.accessKeyId,
        spare_secret_access_key: NEW.secretAccessKey,
      },
      ['secret_access_key', 'spare_secret_access_key'],
    );

    const started = await request(http)
      .post(`/buckets/${row.bucketId}/rotate-key`)
      .set('Cookie', cookie);
    expect(started.status).toBe(200);

    const rotated = await until(async () => {
      const [found] = await ctx.db.select().from(bucket);
      return found?.keyRotation?.status === 'done' ? found : undefined;
    }, 'the rotation to end');
    expect(rotated).toMatchObject({
      accessKeyId: NEW.accessKeyId,
      secretAccessKey: NEW.secretAccessKey,
      googleKeySlot: 'key_b',
      rotationKeys: null,
    });
    const applies = ctx.google.tofuInputs
      .filter((one) => one.method === 'apply')
      .map(
        (one) =>
          JSON.parse(one.definition) as {
            resource: Record<string, Record<string, unknown>>;
          },
      );
    expect(
      applies.map((definition) => ({
        kinds: Object.keys(definition.resource).sort(),
        slots: Object.keys(definition.resource.google_storage_hmac_key),
      })),
    ).toEqual([
      {
        kinds: ['google_service_account', 'google_storage_hmac_key'],
        slots: ['key', 'key_b'],
      },
      {
        kinds: ['google_service_account', 'google_storage_hmac_key'],
        slots: ['key_b'],
      },
    ]);
    expect(await wiredEnv(ctx.db, environmentId, LINKS)).toMatchObject({
      AWS_ACCESS_KEY_ID: NEW.accessKeyId,
      AWS_SECRET_ACCESS_KEY: NEW.secretAccessKey,
    });
  });

  it('switches between a Cloudgate-made and an existing bucket as on AWS: the made one’s Delete keeps its files, then the entry uses the existing one; its Delete leaves it, and the next plan makes a new, empty bucket', async () => {
    // A Cloudgate-made bucket first, holding files.
    expect((await save(UPLOADS)).status).toBe(201);
    const first = await readPlan();
    expect(first.steps.find((one) => one.action === 'create')).toMatchObject({
      configName: 'uploads',
      kind: 'bucket',
    });
    expect((await apply(first.planId)).status).toBe(200);
    const madeRun = await appliedPlan(first.planId);
    await ended(runOf(madeRun.results![0]));
    const [ours] = await ctx.db.select().from(bucket);
    expect(ours.existing).toBe(false);
    ctx.google.holdObjects(ours.bucketName, 'a.jpg');

    // Its Config name is taken while it is there.
    const taken = await request(http)
      .post('/buckets/existing')
      .set('Cookie', cookie)
      .send({ environmentId, configName: 'uploads', bucketName: NAME });
    expect(taken.status).toBe(409);

    // Its Delete keeps it, named, with its files; nothing is copied.
    const deleted = await request(http)
      .delete(`/buckets/${ours.bucketId}`)
      .set('Cookie', cookie);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({
      bucketLeftBehind: { bucketName: ours.bucketName, because: 'holds-files' },
    });
    await until(async () => {
      const rows = await ctx.db.select().from(bucket);
      return rows.length === 0 ? true : undefined;
    }, 'the made bucket to go');
    expect(ctx.google.objectsOf(ours.bucketName)).toEqual(['a.jpg']);

    // Then the entry uses the existing bucket: looked up, never created.
    const bucketId = await created();
    const { plan, step } = await lookupOf();
    expect(plan.steps.some((one) => one.action === 'create')).toBe(false);
    expect(step).toMatchObject({ action: 'change', serviceId: bucketId });
    expect((await apply(plan.planId)).status).toBe(200);
    const keyRun = await appliedPlan(plan.planId);
    await ended(
      runOf(keyRun.results!.find((one) => one.configName === 'uploads')),
    );

    // Its Delete leaves it; the next plan makes a new, empty bucket.
    ctx.google.holdObjects(NAME, 'b.jpg');
    expect(
      (await request(http).delete(`/buckets/${bucketId}`).set('Cookie', cookie))
        .status,
    ).toBe(200);
    await until(async () => {
      const rows = await ctx.db.select().from(bucket);
      return rows.length === 0 ? true : undefined;
    }, 'the existing bucket’s row to go');
    expect(ctx.google.objectsOf(NAME)).toEqual(['b.jpg']);
    expect((await save(`${UPLOADS}    description: Uploads\n`)).status).toBe(
      201,
    );
    const again = await readPlan();
    const create = again.steps.find((one) => one.action === 'create');
    expect(create).toMatchObject({ configName: 'uploads', kind: 'bucket' });
    expect(
      create?.action === 'create' ? create.bucket?.name : undefined,
    ).toMatch(/^cloudgate-[a-z0-9]+-[a-z0-9]{8}$/);
  });
});
