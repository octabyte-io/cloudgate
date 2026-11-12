import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { valueVariable } from '../../src/cloud-accounts/definitions/tofu-json';
import type {
  TofuApplyOutcome,
  TofuApplyRequest,
} from '../../src/cloud-accounts/cloud.port';
import {
  application,
  bucket,
  cloudAccount,
  deployment,
  plan as planTable,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { fakeBinShell } from '../utils/fake-bin-shell';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

/** `web` links all six of `uploads`' Outputs. */
const STACK = `version: 1
services:
  uploads:
    kind: bucket
  web:
    kind: web
    size: small
    source: { image: nginx }
    env:
      - S3_BUCKET: uploads.name
      - AWS_REGION: uploads.region
      - S3_ENDPOINT: uploads.endpoint
      - S3_FORCE_PATH_STYLE: uploads.path_style
      - AWS_ACCESS_KEY_ID: uploads.access_key_id
      - AWS_SECRET_ACCESS_KEY: uploads.secret_access_key
`;

/** What `tofu output -json` answers after the network's apply. */
const NETWORK_OUTPUTS = {
  vpc_id: 'vpc-0f00ba11',
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

interface PlanNoteBody {
  kind: string;
  configName: string;
  variable?: string;
  message: string;
}

/**
 * A cloud `web` linking a bucket on S3 (ADR-0032). Both are made by
 * one Apply: the bucket's Cloud run first, `web`'s waiting for it in the
 * Cloud run pool. `web`'s run writes the bucket's name, region, S3's
 * regional endpoint and `path_style` as SSM SecureStrings, writes no
 * parameter at all for the two key variables, and gives its task role
 * object access on that bucket alone. The plan says the key variables are
 * left unset, and warns about apps that pass keys by hand. A Service on a
 * Server linking a bucket on S3 refuses the plan.
 *
 * Against the fake cloud port (`ctx.cloud`) and a real shell whose `docker`
 * is the fake above, through the HTTP API and the real deployment queue.
 */
describe('A cloud web linking a bucket on S3 (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const shell = fakeBinShell('s3link', { docker: FAKE_DOCKER });
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
    organizationId = (orgs.body as { id: string }[])[0].id;
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

    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('bucket', 'bucket-create');
    ctx.cloud.replayPlanFor('web', 'web-create');
  });

  async function environment(deployTarget?: object): Promise<string> {
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId,
        name: 'production',
        ...(deployTarget ? { deployTarget } : {}),
      });
    expect(env.status).toBe(201);
    return (env.body as { environmentId: string }).environmentId;
  }

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

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

  /** The open plan once no step is still reading AWS. */
  const openPlan = (): Promise<Plan> =>
    until(async () => {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.status, 'open'));
      return found &&
        !found.steps.some(
          (step) =>
            (step.action === 'create' || step.action === 'network-create') &&
            step.cloudRead?.status === 'reading',
        )
        ? found
        : undefined;
    }, 'the plan to be read');

  const deploymentRow = async (deploymentId: string) =>
    (
      await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId))
    )[0];

  const settled = (deploymentId: string): Promise<Deployment> =>
    until(async () => {
      const row = await deploymentRow(deploymentId);
      return row && ['done', 'error', 'cancelled'].includes(row.status)
        ? row
        : undefined;
    }, `Deployment ${deploymentId} to end`);

  /** Each Service's Deployment, once the Apply of `planId` has queued them. */
  async function appliedRuns(
    planId: string,
  ): Promise<(configName: string) => string> {
    const row = await until(async () => {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, planId));
      return found?.results &&
        !found.results.some((result) => result.status === 'running')
        ? found
        : undefined;
    }, 'the Apply to end');
    return (configName) => {
      const result = row.results!.find((one) => one.configName === configName);
      if (result?.deploy?.status !== 'queued') {
        throw new Error(`${configName} queued no Cloud run`);
      }
      return result.deploy.deploymentId;
    };
  }

  it("makes the bucket first, then writes web's four Outputs as SSM SecureStrings, leaves the key variables unset and gives web's task role that bucket's objects", async () => {
    environmentId = await environment({
      kind: 'cloud',
      cloudAccountId,
      region: REGION,
    });
    const saved = await save(STACK);
    expect(saved.status).toBe(201);
    const read = await openPlan();
    expect(
      read.steps.map((step) =>
        'configName' in step ? step.configName : step.action,
      ),
    ).toEqual(['network-create', 'uploads', 'web']);
    const [networkStep, bucketStep, webStep] = read.steps;
    if (
      networkStep.action !== 'network-create' ||
      networkStep.cloudRead.status !== 'read' ||
      bucketStep.action !== 'create' ||
      bucketStep.cloudRead?.status !== 'read' ||
      !bucketStep.bucket ||
      webStep.action !== 'create' ||
      webStep.cloudRead?.status !== 'read'
    ) {
      throw new Error('the plan was not read');
    }
    const bucketName = bucketStep.bucket.name;
    const webStateId = webStep.cloudRead.stateId;
    const webId = webStep.cloudRead.serviceId!;

    // The plan, as the API answers it: a note on each key variable.
    const shown = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(shown.status).toBe(200);
    const notes = (shown.body as { plan: { notes: PlanNoteBody[] } }).plan
      .notes;
    expect(notes.filter((note) => note.kind === 'task-role-access')).toEqual([
      {
        kind: 'task-role-access',
        configName: 'web',
        variable: 'AWS_ACCESS_KEY_ID',
        message:
          "web.env.AWS_ACCESS_KEY_ID links to uploads.access_key_id: on AWS the task's role gives access, so AWS_ACCESS_KEY_ID is left unset. An app that passes keys to its S3 client by hand breaks on AWS; let its SDK find its credentials by itself.",
      },
      {
        kind: 'task-role-access',
        configName: 'web',
        variable: 'AWS_SECRET_ACCESS_KEY',
        message:
          "web.env.AWS_SECRET_ACCESS_KEY links to uploads.secret_access_key: on AWS the task's role gives access, so AWS_SECRET_ACCESS_KEY is left unset. An app that passes keys to its S3 client by hand breaks on AWS; let its SDK find its credentials by itself.",
      },
    ]);

    // web's read already wrote the four parameters with the bucket's real
    // values, though the bucket is not made yet, and its task role's access
    // to it by the name the plan minted.
    const webRead = ctx.cloud.tofuInputs.find(
      (input) => input.stateId === webStateId,
    )!;
    expect(webRead.variables).toMatchObject({
      [valueVariable('S3_BUCKET')]: bucketName,
      [valueVariable('AWS_REGION')]: REGION,
    });
    expect(Object.keys(webRead.variables)).not.toContain(
      valueVariable('AWS_ACCESS_KEY_ID'),
    );
    expect(webRead.definition).toContain('aws_iam_role_policy');
    expect(webRead.definition).toContain(`arn:aws:s3:::${bucketName}/*`);

    ctx.cloud.outputsFor(networkStep.cloudRead.stateId, NETWORK_OUTPUTS);
    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    const runOf = await appliedRuns(read.planId);

    // web's run waits on the bucket's state in the Cloud run pool.
    const [made] = await ctx.db.select().from(bucket);
    expect(made).toMatchObject({ bucketName, cloudAccountId, region: REGION });
    const waiting = await until(async () => {
      const row = await deploymentRow(runOf('web'));
      return row?.cloudRun ? row : undefined;
    }, "web's build to hand its row to the Cloud run pool");
    expect(waiting.cloudRun).toMatchObject({
      after: [`bucket:${made.bucketId}`],
    });

    expect((await settled(runOf('uploads'))).status).toBe('done');
    expect((await settled(runOf('web'))).status).toBe('done');

    // The bucket's apply came before web's.
    const order = ctx.cloud.calls.map((call) =>
      'stateId' in call ? `${call.method}:${call.stateId}` : call.method,
    );
    const bucketApply = order.indexOf(`apply:${bucketStep.cloudRead.stateId}`);
    const webApply = order.indexOf(`apply:${webStateId}`);
    expect(bucketApply).toBeGreaterThanOrEqual(0);
    expect(webApply).toBeGreaterThan(bucketApply);

    // web's apply: the four values, each a SecureString parameter...
    const applied = ctx.cloud.tofuInputs
      .filter((input) => input.stateId === webStateId)
      .at(-1)!;
    expect(applied.variables).toMatchObject({
      [valueVariable('S3_BUCKET')]: bucketName,
      [valueVariable('AWS_REGION')]: REGION,
      [valueVariable('S3_ENDPOINT')]: `https://s3.${REGION}.amazonaws.com`,
      [valueVariable('S3_FORCE_PATH_STYLE')]: 'false',
    });
    for (const name of [
      'S3_BUCKET',
      'AWS_REGION',
      'S3_ENDPOINT',
      'S3_FORCE_PATH_STYLE',
    ]) {
      expect(applied.definition).toContain(
        `/cloudgate/${environmentId}/${webId}/${name}`,
      );
    }
    // ...and nothing at all for the key variables: no parameter, no empty
    // entry, so the SDK falls back to the task role.
    expect(Object.keys(applied.variables)).not.toEqual(
      expect.arrayContaining([
        valueVariable('AWS_ACCESS_KEY_ID'),
        valueVariable('AWS_SECRET_ACCESS_KEY'),
      ]),
    );
    expect(applied.definition).not.toContain('AWS_ACCESS_KEY_ID');
    expect(applied.definition).not.toContain('AWS_SECRET_ACCESS_KEY');

    // The task role's policy: that bucket's objects, and nothing else.
    const definition = JSON.parse(applied.definition) as {
      resource: Record<string, Record<string, Record<string, unknown>>>;
    };
    const policy = JSON.parse(
      definition.resource.aws_iam_role_policy.buckets.policy as string,
    ) as { Statement: { Action: string[]; Resource: string[] }[] };
    expect(policy.Statement.flatMap((one) => one.Resource)).toEqual([
      `arn:aws:s3:::${bucketName}/*`,
      `arn:aws:s3:::${bucketName}`,
    ]);
    expect(policy.Statement.flatMap((one) => one.Action)).not.toEqual(
      expect.arrayContaining(['s3:PutBucketCORS']),
    );

    // The app row saves the links, never a value.
    const [web] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.applicationId, webId));
    expect(JSON.stringify(web)).not.toContain(bucketName);
  });

  it('fails web with a sentence when the bucket was not made, and applies nothing of it', async () => {
    environmentId = await environment({
      kind: 'cloud',
      cloudAccountId,
      region: REGION,
    });
    expect((await save(STACK)).status).toBe(201);
    const read = await openPlan();
    const [networkStep, , webStep] = read.steps;
    if (
      networkStep.action !== 'network-create' ||
      networkStep.cloudRead.status !== 'read' ||
      webStep.action !== 'create' ||
      webStep.cloudRead?.status !== 'read'
    ) {
      throw new Error('the plan was not read');
    }
    ctx.cloud.outputsFor(networkStep.cloudRead.stateId, NETWORK_OUTPUTS);
    const real = ctx.cloud.apply.bind(ctx.cloud) as (
      input: TofuApplyRequest,
    ) => Promise<TofuApplyOutcome>;
    jest
      .spyOn(ctx.cloud, 'apply')
      .mockImplementation((input: TofuApplyRequest) => {
        const resources: object = input.definition.resource ?? {};
        if ('aws_s3_bucket' in resources) {
          return Promise.resolve({
            ok: false,
            reason: 'failed',
            message: 'S3 refused the bucket',
          });
        }
        return real(input);
      });
    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    const runOf = await appliedRuns(read.planId);

    expect((await settled(runOf('uploads'))).status).toBe('error');
    const web = await settled(runOf('web'));
    expect(web.status).toBe('error');
    expect(web.description).toBe(
      'S3_BUCKET links to uploads.name, but uploads is not made on S3: its Cloud run failed before the bucket was made. Its Deployment log says why; apply the plan again, then deploy this Service.',
    );
    const webState = webStep.cloudRead.stateId;
    expect(
      ctx.cloud.calls.some(
        (call) => call.method === 'apply' && call.stateId === webState,
      ),
    ).toBe(false);
  });

  it('refuses a web on the platform host linking a bucket on S3, naming the Service and variable', async () => {
    environmentId = await environment();
    await ctx.db.insert(bucket).values({
      name: 'uploads',
      configName: 'uploads',
      environmentId,
      bucketName: `uploads-k3f9a2qd-${ACCOUNT}-${REGION}-an`,
      adminCredential: { rpcSecret: 'unused', adminToken: 'unused' },
      volumeName: 'unused',
      cloudAccountId,
      region: REGION,
      appliedOrigins: [],
    });

    const refused = await save(STACK);

    expect(refused.status).toBe(409);
    const { message } = refused.body as { message: string };
    expect(message).toContain('web.env.S3_BUCKET links to uploads.name');
    expect(message).toContain('cannot reach it');
    expect(
      await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.environmentId, environmentId)),
    ).toEqual([]);
  });
});
