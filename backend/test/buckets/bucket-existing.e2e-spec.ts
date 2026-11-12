import { and, desc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { valueVariable } from '../../src/cloud-accounts/definitions/tofu-json';
import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import {
  bucket,
  cloudAccount,
  deployment,
  plan as planTable,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import {
  cloudReadOf,
  isQuietRead,
} from '../../src/project-config/planner/cloud-steps';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { fakeBinShell } from '../utils/fake-bin-shell';
import { storedPlan } from '../utils/fake-cloud-port';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
/** The stored lookup's region. */
const REGION = 'eu-west-1';
const NAME = 'acme-prod-uploads';

const BUCKET_ONLY = `version: 1
services:
  uploads:
    kind: bucket
`;

/** `web` links `uploads`' Outputs, the key ones too. */
const STACK = `${BUCKET_ONLY}  web:
    kind: web
    size: small
    source: { image: nginx }
    env:
      - S3_BUCKET: uploads.name
      - AWS_REGION: uploads.region
      - S3_ENDPOINT: uploads.endpoint
      - S3_FORCE_PATH_STYLE: uploads.path_style
      - AWS_ACCESS_KEY_ID: uploads.access_key_id
`;

/** What `tofu output -json` answers after the network's apply. */
const NETWORK_OUTPUTS = {
  vpc_id: 'vpc-0e0e0e0e',
  public_subnet_ids: ['subnet-0a11', 'subnet-0b22'],
  private_subnet_ids: ['subnet-0c33', 'subnet-0d44'],
  cluster_arn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/cloudgate-env`,
  alb_arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/cg/50dc6c495c0c9188`,
  alb_dns_name: `cg-1234567890.${REGION}.elb.amazonaws.com`,
  alb_zone_id: 'Z215JYRZR1TBD5',
  alb_security_group_id: 'sg-0a1b',
  https_listener_arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/cg/50dc6c495c0c9188/f2f7dc8efc522ab2`,
  default_certificate_arn: `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/0e4a7d52-2b1c-4f0d-9a43-5b3c1c2d7e11`,
};

/** A `docker` that pulls, pushes and logs in without a daemon. */
const FAKE_DOCKER = `#!/bin/bash
case "$1" in
  login) cat > /dev/null; echo "Login Succeeded" ;;
  pull) echo "Status: Downloaded newer image for $2" ;;
  push) echo "\${2##*:}: digest: sha256:0f1e size: 1570" ;;
  image) [ "$2" = inspect ] && echo amd64 ;;
esac
exit 0
`;

type Resource = { type: string; values: Record<string, unknown> };

/** The stored lookup, what it found changed. */
function lookupShowing(
  change: (resources: Resource[]) => Resource[],
): TofuShow {
  const show = storedPlan('existing-bucket-lookup') as {
    prior_state: { values: { root_module: { resources: Resource[] } } };
  };
  const resources = change(
    structuredClone(show.prior_state.values.root_module.resources),
  );
  return {
    ...show,
    prior_state: { values: { root_module: { resources } } },
  };
}

/**
 * An Environment's `uploads` uses `acme-prod-uploads`, an
 * S3 bucket the operator already has. Chosen from the console by its name,
 * it is looked up at every plan through OpenTofu `data` sources, never
 * created, changed or deleted, hands out the same Outputs and task-role
 * access as a bucket Cloudgate made, and its Delete removes only
 * Cloudgate's records. Against the fake cloud port (`ctx.cloud`) and, for
 * a cloud `web`'s deploy, a real shell whose `docker` is the fake above.
 */
describe('An existing bucket used as an Environment’s bucket (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const shell = fakeBinShell('existing-bucket', { docker: FAKE_DOCKER });
  const { execMock } = shell;

  beforeAll(async () => {
    shell.setUp();
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    http = ctx.app.getHttpServer() as App;
    ctx.app.get(CloudServiceDeploys).pollIntervalMs = 10;
  });

  afterAll(async () => {
    await ctx?.teardown();
    shell.tearDown();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await ctx.resetDb();
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

    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('bucket', 'bucket-create');
    ctx.cloud.replayPlanFor('web', 'web-create');
    ctx.cloud.replayPlanFor('existing-bucket', 'existing-bucket-lookup');
  });

  const useExisting = (body: Record<string, unknown> = {}) =>
    request(http)
      .post('/buckets/existing')
      .set('Cookie', cookie)
      .send({
        environmentId,
        configName: 'uploads',
        bucketName: NAME,
        ...body,
      });

  async function created(): Promise<string> {
    const res = await useExisting();
    expect(res.status).toBe(201);
    return (res.body as { bucketId: string }).bucketId;
  }

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  /** The Environment's latest plan, once every AWS read of it has landed. */
  async function readPlan(): Promise<Plan> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(
          and(
            eq(planTable.environmentId, environmentId),
            inArray(planTable.status, ['open', 'unchanged']),
          ),
        )
        .orderBy(desc(planTable.createdAt))
        .limit(1);
      if (
        found &&
        !found.steps.some((step) => cloudReadOf(step)?.status === 'reading') &&
        // A plan of quiet reads only is settled `unchanged` just after its
        // last read is written.
        !(found.status === 'open' && found.steps.every(isQuietRead))
      ) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading AWS');
  }

  async function lookupOf(text = BUCKET_ONLY) {
    const saved = await save(text);
    expect(saved.status).toBe(201);
    const read = await readPlan();
    const step = read.steps.find(
      (one) => 'configName' in one && one.configName === 'uploads',
    );
    if (step?.action !== 'change') {
      throw new Error('uploads has no change step');
    }
    return { plan: read, step, aws: step.cloudRead! };
  }

  const apply = (planId: string, body: Record<string, unknown> = {}) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId, ...body });

  /** Every `tofu` run and AWS call that writes. */
  const writes = () =>
    ctx.cloud.calls.filter(
      (call) =>
        call.method === 'apply' ||
        call.method === 'destroy' ||
        call.method.startsWith('ecs') ||
        call.method.startsWith('ecr'),
    );

  async function until<T>(
    look: () => Promise<T | undefined>,
    what: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 600; attempt++) {
      const found = await look();
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Waited in vain for ${what}`);
  }

  const settled = (deploymentId: string): Promise<Deployment> =>
    until(async () => {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      return row && ['done', 'error', 'cancelled'].includes(row.status)
        ? row
        : undefined;
    }, `Deployment ${deploymentId} to end`);

  const appliedPlan = (planId: string): Promise<Plan> =>
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

  describe('Create', () => {
    it('makes a bucket Service under the Config name, in the Cloud account and region, reaching no AWS', async () => {
      const callsBefore = ctx.cloud.calls.length;
      const res = await useExisting();

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        configName: 'uploads',
        bucketName: NAME,
        existing: true,
        region: REGION,
        volumeName: null,
        hasKey: false,
        place: {
          kind: 'cloud',
          cloudAccountId,
          cloudAccountName: 'Production AWS',
          cloudId: ACCOUNT,
          region: REGION,
        },
      });
      expect(ctx.cloud.calls.slice(callsBefore)).toEqual([]);
      const config = await request(http)
        .get(`/projects/${projectId}/config`)
        .set('Cookie', cookie);
      expect(config.text).not.toContain(NAME);
    });

    it('refuses an Environment whose Deploy target is not a Cloud account', async () => {
      const env = await request(http)
        .post('/environments')
        .set('Cookie', cookie)
        .send({ projectId, name: 'staging' });
      expect(env.status).toBe(201);

      const res = await useExisting({
        environmentId: (env.body as { environmentId: string }).environmentId,
      });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'EXISTING_BUCKET_NEEDS_CLOUD' });
    });

    it('refuses a Config name the Environment already has, and a name S3 would not take', async () => {
      await created();

      expect((await useExisting()).status).toBe(409);
      expect(
        (await useExisting({ configName: 'other', bucketName: 'Acme_Uploads' }))
          .status,
      ).toBe(400);
    });
  });

  describe('Each plan’s lookup', () => {
    it('creates nothing, reads the bucket through data sources only, and changes nothing', async () => {
      const bucketId = await created();

      const { plan, step, aws } = await lookupOf();

      expect(plan.steps).toHaveLength(1);
      expect(plan.steps.some((one) => one.action === 'create')).toBe(false);
      expect(step).toMatchObject({
        serviceId: bucketId,
        fields: [],
        existing: { identifier: NAME, version: null },
      });
      expect(aws).toMatchObject({
        status: 'read',
        summary: [
          `uploads: existing bucket ${NAME} in ${REGION}; used as given, Cloudgate changes nothing in it — no CORS, versioning or encryption — and makes nothing in it`,
        ],
      });
      // Found as given: nothing to apply, so the plan is unchanged.
      expect(plan.status).toBe('unchanged');
      const run = ctx.cloud.tofuInputs.at(-1)!;
      expect(run.stateId).toBe(bucketId);
      expect(run.definition).toContain('aws_s3_buckets');
      expect(run.definition).not.toContain('"resource"');
      expect(run.definition).not.toContain('cors');
      expect(writes()).toEqual([]);
      const [row] = await ctx.db
        .select()
        .from(bucket)
        .where(eq(bucket.bucketId, bucketId));
      expect(row.applicationStatus).toBe('done');
    });

    it('refuses a bucket AWS does not have, naming it, the Cloud account and the region', async () => {
      await created();
      // As the provider reads a search that found nothing: `buckets` null,
      // not empty, and no tags read (the moto lane runs this plan).
      ctx.cloud.replayShowFor(
        'existing-bucket',
        lookupShowing((resources) =>
          resources
            .filter((one) => one.type === 'aws_s3_buckets')
            .map((one) => ({
              ...one,
              values: { ...one.values, buckets: null },
            })),
        ),
      );

      const { plan, aws } = await lookupOf();

      expect(aws).toEqual({
        status: 'failed',
        reason: `uploads uses the existing bucket ${NAME}, but AWS has no S3 bucket ${NAME} in Cloud account Production AWS (${ACCOUNT}), region ${REGION}. Check the name on uploads's page; it must be in this Environment's Cloud account and region`,
      });
      const refused = await apply(plan.planId);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'PLAN_AWS_NOT_READ' });
      expect((refused.body as { message: string }).message).toContain(
        `AWS has no S3 bucket ${NAME}`,
      );
    });

    it("refuses a bucket carrying Cloudgate's tags", async () => {
      await created();
      ctx.cloud.replayShowFor(
        'existing-bucket',
        lookupShowing((resources) =>
          resources.map((one) =>
            one.type === 'aws_resourcegroupstaggingapi_resources'
              ? {
                  ...one,
                  values: {
                    ...one.values,
                    resource_tag_mapping_list: [
                      {
                        resource_arn: `arn:aws:s3:::${NAME}`,
                        compliance_details: [],
                        tags: {
                          'cloudgate:cloud-account': cloudAccountId,
                          'cloudgate:environment': 'another-environment',
                          'cloudgate:state': 'st-1',
                        },
                      },
                    ],
                  },
                }
              : one,
          ),
        ),
      );

      const { aws } = await lookupOf();

      expect(aws.status).toBe('failed');
      expect(aws.status === 'failed' && aws.reason).toContain(
        `${NAME} carries Cloudgate's tags (cloudgate:cloud-account, cloudgate:environment, cloudgate:state)`,
      );
    });
  });

  it("applies a linked cloud web with the same Outputs as a made bucket's and task-role access to it, creating no bucket", async () => {
    await created();

    const saved = await save(STACK);
    expect(saved.status).toBe(201);
    const read = await readPlan();
    expect(
      read.steps.map((step) =>
        'configName' in step
          ? `${step.action}:${step.configName}`
          : step.action,
      ),
    ).toEqual(['network-create', 'change:uploads', 'create:web']);
    const [networkStep, , webStep] = read.steps;
    if (
      networkStep.action !== 'network-create' ||
      networkStep.cloudRead.status !== 'read' ||
      webStep.action !== 'create' ||
      webStep.cloudRead?.status !== 'read'
    ) {
      throw new Error('the plan was not read');
    }
    // The key variable is left unset, as on a bucket Cloudgate made.
    expect(read.notes).toContainEqual(
      expect.objectContaining({
        kind: 'task-role-access',
        configName: 'web',
        variable: 'AWS_ACCESS_KEY_ID',
      }),
    );
    ctx.cloud.outputsFor(networkStep.cloudRead.stateId, NETWORK_OUTPUTS);
    const webStateId = webStep.cloudRead.stateId;

    const res = await apply(read.planId);
    expect(res.status).toBe(200);
    const applied = await appliedPlan(read.planId);
    const web = applied.results!.find((one) => one.configName === 'web');
    if (web?.deploy?.status !== 'queued') throw new Error('web queued nothing');
    expect((await settled(web.deploy.deploymentId)).status).toBe('done');
    // The lookup changed nothing, so no run of `uploads` was queued.
    const uploads = applied.results!.find(
      (one) => one.configName === 'uploads',
    );
    expect(uploads?.deploy ?? null).toBeNull();

    // Nothing applied but the network's and web's: no bucket was made.
    const appliedStates = ctx.cloud.calls.flatMap((call) =>
      call.method === 'apply' ? [call.stateId] : [],
    );
    expect(new Set(appliedStates)).toEqual(
      new Set([networkStep.cloudRead.stateId, webStep.cloudRead.stateId]),
    );

    const webApply = ctx.cloud.tofuInputs
      .filter((input) => input.stateId === webStateId)
      .at(-1)!;
    expect(webApply.variables).toMatchObject({
      [valueVariable('S3_BUCKET')]: NAME,
      [valueVariable('AWS_REGION')]: REGION,
      [valueVariable('S3_ENDPOINT')]: `https://s3.${REGION}.amazonaws.com`,
      [valueVariable('S3_FORCE_PATH_STYLE')]: 'false',
    });
    expect(Object.keys(webApply.variables)).not.toContain(
      valueVariable('AWS_ACCESS_KEY_ID'),
    );
    const definition = JSON.parse(webApply.definition) as {
      resource: Record<string, Record<string, Record<string, unknown>>>;
    };
    const policy = JSON.parse(
      definition.resource.aws_iam_role_policy.buckets.policy as string,
    ) as { Statement: { Resource: string[] }[] };
    expect(policy.Statement.flatMap((one) => one.Resource)).toEqual([
      `arn:aws:s3:::${NAME}/*`,
      `arn:aws:s3:::${NAME}`,
    ]);
  });

  describe('Delete', () => {
    it("removes only Cloudgate's records, reaches no AWS, and says the bucket was left as it was", async () => {
      const bucketId = await created();
      await lookupOf();
      const callsBefore = ctx.cloud.calls.length;

      const res = await request(http)
        .delete(`/buckets/${bucketId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        volumeLeftBehind: false,
        bucketLeftAsItWas: {
          bucketName: NAME,
          message: `${NAME} was left as it was, files and all; it is yours. Cloudgate removed only its own records of uploads; if the Project config still lists uploads, the next plan creates it as a new, empty bucket.`,
        },
      });
      expect(ctx.cloud.calls.slice(callsBefore)).toEqual([]);
      expect(await ctx.db.select().from(bucket)).toEqual([]);
    });

    it('refuses "also delete its files", keeping the Service', async () => {
      const bucketId = await created();

      const res = await request(http)
        .delete(`/buckets/${bucketId}?deleteFiles=true`)
        .set('Cookie', cookie);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'EXISTING_BUCKET_FILES_NOT_DELETED',
      });
      expect(await ctx.db.select().from(bucket)).toHaveLength(1);
    });

    it("a plan's destroy reads no files, takes no files tick, and leaves the bucket", async () => {
      const bucketId = await created();
      // Its description is Cloudgate's to write, so the plan is applied,
      // and the config in effect describes `uploads`.
      const first = await lookupOf(
        `${BUCKET_ONLY}    description: Customer uploads\n`,
      );
      expect(first.step.fields).toEqual([
        { field: 'description', from: null, to: 'Customer uploads' },
      ]);
      expect((await apply(first.plan.planId)).status).toBe(200);
      await appliedPlan(first.plan.planId);
      const [described] = await ctx.db.select().from(bucket);
      expect(described.description).toBe('Customer uploads');
      expect(writes()).toEqual([]);
      const callsBefore = ctx.cloud.calls.length;

      const saved = await save('version: 1\nservices: {}\n');
      expect(saved.status).toBe(201);
      const read = await readPlan();
      const destroy = read.steps.find((one) => one.action === 'destroy');
      expect(destroy).toMatchObject({
        configName: 'uploads',
        serviceId: bucketId,
        existing: { identifier: NAME },
      });
      expect(destroy).not.toHaveProperty('files');

      const ticked = await apply(read.planId, {
        confirmDestroy: ['uploads'],
        deleteFilesOf: ['uploads'],
      });
      expect(ticked.status).toBe(409);

      const res = await apply(read.planId, { confirmDestroy: ['uploads'] });
      expect(res.status).toBe(200);
      const applied = await appliedPlan(read.planId);
      const destroyed = applied.results!.find(
        (one) => one.configName === 'uploads',
      );
      expect(destroyed).toMatchObject({ action: 'destroy', status: 'applied' });
      expect(destroyed?.leftovers?.bucketLeftAsItWas?.bucketName).toBe(NAME);
      expect(ctx.cloud.calls.slice(callsBefore)).toEqual([]);
      expect(await ctx.db.select().from(bucket)).toEqual([]);
    });
  });

  it('never writes its browser-upload origins', async () => {
    const bucketId = await created();

    const res = await request(http)
      .put(`/buckets/${bucketId}/origins`)
      .set('Cookie', cookie)
      .send({ origins: ['https://shop.example.com'] });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'EXISTING_BUCKET_NOT_MANAGED' });
    const [row] = await ctx.db.select().from(bucket);
    expect(row.origins).toEqual([]);
  });
});
