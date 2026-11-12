import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { bucket, cloudAccount, deployment, domain } from '../../src/db/schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const ORIGIN = 'https://app.example.com';

const UPLOADS = `version: 1
services:
  uploads:
    kind: bucket
`;

interface Step {
  action: string;
  configName?: string;
  serviceType?: string;
  fields?: unknown[];
  bucket?: { name: string; awsAccountId?: string; region?: string };
  cors?: { from: string[]; to: string[] };
  cloudRead?: {
    status: 'reading' | 'read' | 'failed';
    reason?: string;
    summary?: string[];
    raw?: { address: string; action: string; drift: boolean }[];
    drift?: { address: string; line: string; deleted: boolean }[];
    stateId?: string;
    serviceId?: string;
  };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
}

/** What `tofu show -json` prints when AWS is as the definition says. */
const NOTHING_TO_DO = {
  format_version: '1.2',
  terraform_version: '1.13.1',
  resource_changes: [],
};

/**
 * An Environment whose Deploy target is an AWS Cloud account makes a
 * `kind: bucket` entry as an S3 bucket, in its own Infrastructure state, by a
 * Cloud run. The plan shows the name it mints in the account regional
 * namespace with its account and region, and its AWS lines (`ctx.cloud`
 * replays the stored real plans the bucket moto lane saves); origins edited
 * on the bucket's page plan as a CORS change; a hand change in the console is
 * Drift that Apply puts back.
 */
describe('A bucket on AWS (e2e)', () => {
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

  /** A Deployment once its Cloud run has ended. */
  async function ended(deploymentId: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
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

  /** Plans and applies the bucket's create, and waits for its Cloud run. */
  async function made() {
    expect((await save(UPLOADS)).status).toBe(201);
    const read = await readPlan();
    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    const { deploymentId } = (
      applied.body as { results: { deploy: { deploymentId: string } }[] }
    ).results[0].deploy;
    expect((await ended(deploymentId)).status).toBe('done');
    const [row] = await ctx.db.select().from(bucket);
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;
    return row;
  }

  /** The step's Deployment, from an Apply's answer. */
  function deploymentOf(applied: request.Response): string {
    return (applied.body as { results: { deploy: { deploymentId: string } }[] })
      .results[0].deploy.deploymentId;
  }

  it('plans the create with its minted name, account, region and AWS lines, and Apply makes it through a Cloud run', async () => {
    const saved = await save(UPLOADS);
    expect(saved.status).toBe(201);

    const read = await readPlan();
    // An S3 bucket sits in no Environment network: none is made for it.
    expect(read.steps.map((step) => step.action)).toEqual(['create']);
    const [step] = read.steps;
    expect(step.bucket?.name).toMatch(
      new RegExp(`^uploads-[a-z0-9]{8}-${ACCOUNT}-${REGION}-an$`),
    );
    expect(step.bucket).toMatchObject({
      awsAccountId: ACCOUNT,
      region: REGION,
    });
    expect(step.cloudRead?.status).toBe('read');
    expect(step.cloudRead?.summary).toEqual([
      "S3 bucket `uploads-k3f9a2qd-123456789012-eu-central-1-an`: create, versioning off, S3's default encryption, Block Public Access on",
    ]);
    // The read wrote the definition under the name the plan shows, in the
    // account regional namespace, with no CORS: no origin is trusted yet.
    const [readInput] = ctx.cloud.tofuInputs;
    expect(readInput.definition).toContain(`"bucket": "${step.bucket!.name}"`);
    expect(readInput.definition).toContain(
      '"bucket_namespace": "account-regional"',
    );
    expect(readInput.definition).not.toContain(
      'aws_s3_bucket_cors_configuration',
    );
    // A read is a plan-only Cloud run: it records no Deployment.
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
          serviceId: step.cloudRead!.serviceId,
          deploy: { status: 'queued' },
        },
      ],
    });

    const [created] = await ctx.db.select().from(bucket);
    expect(created).toMatchObject({
      bucketId: step.cloudRead!.serviceId,
      configName: 'uploads',
      bucketName: step.bucket!.name,
      cloudAccountId,
      region: REGION,
      serverId: null,
      origins: [],
      accessKeyId: null,
    });
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.bucketId, created.bucketId));
    expect(state.infrastructureStateId).toBe(step.cloudRead!.stateId);

    // Its Cloud run is a Deployment of the bucket, which ends done.
    const run = await ended(deploymentOf(applied));
    expect(run).toMatchObject({
      bucketId: created.bucketId,
      applicationId: null,
      postgresId: null,
      status: 'done',
      cloudRun: expect.objectContaining({ kind: 'bucket' }) as object,
    });
    expect(ctx.cloud.calls.filter((call) => call.method === 'apply')).toEqual([
      expect.objectContaining({ stateId: state.infrastructureStateId }),
    ]);
    const [after] = await ctx.db.select().from(bucket);
    expect(after).toMatchObject({
      applicationStatus: 'done',
      appliedOrigins: [],
    });
    // An S3 bucket is never a Garage container.
    expect(queue.add).not.toHaveBeenCalled();

    // Its page names its place: the Cloud account and region, and no volume.
    const page = await request(http)
      .get(`/buckets/${created.bucketId}`)
      .set('Cookie', cookie);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      bucketName: step.bucket!.name,
      region: REGION,
      place: {
        kind: 'cloud',
        cloudAccountId,
        cloudAccountName: 'Production AWS',
        cloudId: ACCOUNT,
        region: REGION,
      },
      volumeName: null,
      hasKey: false,
    });

    // An S3 bucket has no Garage to route a host to, so it takes no Domain
    // and the plan made it none.
    const refused = await request(http)
      .post('/domains')
      .set('Cookie', cookie)
      .send({ host: 'files.example.com', bucketId: created.bucketId });
    expect(refused.status).toBe(400);
    expect((refused.body as { message: string }).message).toContain(
      'A bucket on AWS takes no Domain',
    );
    expect(
      await ctx.db
        .select()
        .from(domain)
        .where(eq(domain.bucketId, created.bucketId)),
    ).toEqual([]);
  });

  it('plans origins edited on its page as a CORS change, and Apply writes them', async () => {
    const created = await made();

    const edited = await request(http)
      .put(`/buckets/${created.bucketId}/origins`)
      .set('Cookie', cookie)
      .send({ origins: [ORIGIN] });
    expect(edited.status).toBe(200);
    // Saved alone: no Garage, and nothing reaches AWS until a plan's Apply.
    expect(ctx.cloud.calls).toEqual([]);

    ctx.cloud.replayPlanFor('bucket', 'bucket-cors-change');
    expect((await checkForChanges()).status).toBe(201);
    const read = await readPlan();
    expect(read.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'uploads',
        serviceType: 'bucket',
        fields: [],
        cors: { from: [], to: [ORIGIN] },
      }),
    ]);
    expect(read.steps[0].cloudRead?.summary).toEqual([
      `Browser uploads (CORS): allow ${ORIGIN}`,
    ]);
    expect(ctx.cloud.tofuInputs.at(-1)!.definition).toContain(
      `"allowed_origins": [\n              "${ORIGIN}"`,
    );

    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      results: [
        {
          configName: 'uploads',
          action: 'change',
          status: 'applied',
          deploy: { status: 'queued' },
        },
      ],
    });
    const run = await ended(deploymentOf(applied));
    expect(run).toMatchObject({ bucketId: created.bucketId, status: 'done' });
    expect(ctx.cloud.tofuInputs.at(-1)!.definition).toContain(
      'aws_s3_bucket_cors_configuration',
    );
    const [after] = await ctx.db.select().from(bucket);
    expect(after.appliedOrigins).toEqual([ORIGIN]);

    // Written, the origins are no change any more.
    ctx.cloud.replayShowFor('bucket', NOTHING_TO_DO);
    expect((await checkForChanges()).status).toBe(201);
    expect((await readPlan()).status).toBe('unchanged');
  });

  it('shows a hand change in the AWS console as Drift, and Apply puts it back', async () => {
    const created = await made();

    ctx.cloud.replayPlanFor('bucket', 'bucket-drift');
    expect((await checkForChanges()).status).toBe(201);
    const read = await readPlan();
    expect(read.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'uploads',
        serviceType: 'bucket',
        fields: [],
      }),
    ]);
    expect(read.steps[0].cloudRead?.drift).toEqual([
      expect.objectContaining({
        address: 'aws_s3_bucket_cors_configuration.bucket',
        line: 'Browser uploads (CORS): changed outside Cloudgate, will be put back',
      }),
      expect.objectContaining({
        address: 'aws_s3_bucket_public_access_block.bucket',
        line: 'Block Public Access: will be made again',
        deleted: true,
      }),
    ]);

    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    const run = await ended(deploymentOf(applied));
    expect(run).toMatchObject({ bucketId: created.bucketId, status: 'done' });
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.bucketId, created.bucketId));
    expect(ctx.cloud.calls.filter((call) => call.method === 'apply')).toEqual([
      expect.objectContaining({ stateId: state.infrastructureStateId }),
    ]);
  });

  it('refuses the Apply of a put back when AWS has moved since the plan, applying nothing', async () => {
    await made();

    ctx.cloud.replayPlanFor('bucket', 'bucket-drift');
    expect((await checkForChanges()).status).toBe(201);
    const read = await readPlan();

    // AWS now differs from what the plan showed.
    ctx.cloud.replayPlanFor('bucket', 'bucket-cors-change');
    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    const run = await ended(deploymentOf(applied));

    expect(run.status).toBe('error');
    const [after] = await ctx.db.select().from(bucket);
    expect(after.applicationStatus).toBe('error');
  });

  describe('native.aws on S3', () => {
    const ENCRYPTION =
      'aws_s3_bucket_server_side_encryption_configuration.bucket';
    const KMS = {
      [ENCRYPTION]: {
        rule: [
          {
            apply_server_side_encryption_by_default: {
              sse_algorithm: 'aws:kms',
            },
            bucket_key_enabled: true,
          },
        ],
      },
    };
    const UPLOADS_KMS = `${UPLOADS}    native:
      aws:
        "${ENCRYPTION}":
          rule:
            - apply_server_side_encryption_by_default: { sse_algorithm: "aws:kms" }
              bucket_key_enabled: true
`;

    it('plans a native encryption setting as a native line, applies it through the Cloud run, holds it with the bucket, and plans nothing next', async () => {
      expect((await save(UPLOADS_KMS)).status).toBe(201);
      const read = await readPlan();
      const [step] = read.steps;
      expect(step.cloudRead?.status).toBe('read');
      expect(
        (step.fields as { field: string; native?: boolean }[])
          .filter((field) => field.native)
          .map((field) => field.field),
      ).toEqual([`native.aws."${ENCRYPTION}".rule`]);
      // The read laid it over Cloudgate's definition.
      expect(ctx.cloud.tofuInputs.at(-1)!.definition).toContain('"aws:kms"');

      const applied = await apply(read.planId);
      expect(applied.status).toBe(200);
      expect((await ended(deploymentOf(applied))).status).toBe('done');
      // Held with the bucket, as written; the run laid it.
      const [row] = await ctx.db.select().from(bucket);
      expect(row.nativeAws).toEqual(KMS);
      expect(ctx.cloud.tofuInputs.at(-1)!.definition).toContain('"aws:kms"');

      // Check for changes lays the applied block: AWS as it says is no
      // change, and the config is what was applied.
      ctx.cloud.tofuInputs.length = 0;
      ctx.cloud.replayShowFor('bucket', NOTHING_TO_DO);
      expect((await checkForChanges()).status).toBe(201);
      expect((await readPlan()).status).toBe('unchanged');
      expect(ctx.cloud.tofuInputs.at(-1)!.definition).toContain('"aws:kms"');
    });

    it('refuses a native change planned as a bucket replace, naming the path, and applies nothing', async () => {
      // Every argument the pinned provider replaces a bucket for
      // (object_lock_enabled, bucket, bucket_namespace) is locked, so
      // the plan here is AWS's word that an open one would: the rule reads
      // the plan's actions, whatever the leaf.
      await made();
      ctx.cloud.replayShowFor('bucket', {
        format_version: '1.2',
        terraform_version: '1.13.1',
        resource_changes: [
          {
            address: 'aws_s3_bucket.bucket',
            mode: 'managed',
            type: 'aws_s3_bucket',
            name: 'bucket',
            provider_name: 'registry.opentofu.org/hashicorp/aws',
            change: {
              actions: ['delete', 'create'],
              before: { acceleration_status: '' },
              after: { acceleration_status: 'Enabled' },
              after_unknown: {},
              replace_paths: [['acceleration_status']],
            },
          },
        ],
      });
      expect(
        (
          await save(`${UPLOADS}    native:
      aws:
        "aws_s3_bucket.bucket":
          acceleration_status: Enabled
`)
        ).status,
      ).toBe(201);
      const read = await readPlan();
      expect(read.steps[0].cloudRead).toMatchObject({
        status: 'failed',
        reason:
          'uploads.native.aws."aws_s3_bucket.bucket".acceleration_status: refused - OpenTofu would replace the bucket for it, losing every file in it',
      });

      const applied = await apply(read.planId);
      expect(applied.status).toBe(409);
      expect(ctx.cloud.calls.filter((call) => call.method === 'apply')).toEqual(
        [],
      );
    });
  });
});
