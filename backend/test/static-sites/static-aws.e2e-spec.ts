import * as fs from 'node:fs';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import {
  application,
  cloudAccount,
  deployment,
  domain,
} from '../../src/db/schema';
import { fakeDistributionId } from '../utils/fake-cloud-port';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

const DOCS = `version: 1
services:
  docs:
    kind: static
    size: small
    env: [API_URL]
    source: { git: https://example.com/docs.git }
    build:
      publish: dist
`;

interface Step {
  action: string;
  configName?: string;
  kind?: string;
  serviceType?: string;
  fields?: { field: string }[];
  site?: { spa: boolean };
  bucket?: { name: string; awsAccountId?: string; region?: string };
  cloudRead?: {
    status: 'reading' | 'read' | 'failed';
    reason?: string;
    summary?: string[];
    drift?: { address: string; line: string; deleted: boolean }[];
    stateId?: string;
    serviceId?: string;
  };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
  notes: { kind: string; configName: string; message: string }[];
}

/**
 * An Environment whose Deploy target is an AWS Cloud account makes a
 * `kind: static` entry as a private S3 bucket served by CloudFront, in its
 * own Infrastructure state, by a Cloud run that builds nothing. The plan
 * shows its AWS lines (`ctx.cloud` replays the stored real plans the static
 * moto lane saves); the fields only a container has are ignored with one
 * note; a `spa` change plans as the distribution's error responses; a hand
 * change in the console is Drift that Apply puts back.
 */
describe('A static site on AWS (e2e)', () => {
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

    ctx.cloud.replayPlanFor('static', 'static-create');
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

  /** The step's Deployment, from an Apply's answer. */
  function deploymentOf(applied: request.Response): string {
    return (applied.body as { results: { deploy: { deploymentId: string } }[] })
      .results[0].deploy.deploymentId;
  }

  /** Plans and applies the site's create, and waits for its Cloud run. */
  async function made() {
    expect((await save(DOCS)).status).toBe(201);
    const read = await readPlan();
    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    expect((await ended(deploymentOf(applied))).status).toBe('done');
    const [row] = await ctx.db.select().from(application);
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;
    return row;
  }

  it('plans the create with its bucket, OAC, bucket policy, function and distribution, and Apply makes it through a Cloud run', async () => {
    const saved = await save(DOCS);
    expect(saved.status).toBe(201);

    const read = await readPlan();
    // CloudFront and S3 sit in no Environment network: none is made.
    expect(read.steps.map((step) => step.action)).toEqual(['create']);
    const [step] = read.steps;
    expect(step).toMatchObject({
      configName: 'docs',
      kind: 'static',
      site: { spa: false },
      bucket: { awsAccountId: ACCOUNT, region: REGION },
    });
    expect(step.bucket?.name).toMatch(
      new RegExp(`^docs-[a-z0-9]{8}-${ACCOUNT}-${REGION}-an$`),
    );
    // `size` and `env` are ignored, never refused, and named once.
    expect(step.fields?.map((diff) => diff.field)).not.toContain('size');
    expect(read.notes).toEqual([
      expect.objectContaining({
        kind: 'ignored-on-s3',
        configName: 'docs',
        message:
          'docs: `size`, `env` have no meaning on S3 + CloudFront, so they are ignored',
      }),
    ]);
    expect(step.cloudRead?.status).toBe('read');
    expect(step.cloudRead?.summary).toEqual([
      'CloudFront distribution: create, HTTPS only, error responses 403 → 404',
      'CloudFront function (index.html for a path ending in /): create',
      'Origin Access Control: create, CloudFront signs every request to the bucket',
      "S3 bucket `docs-p4x8m2rt-123456789012-eu-central-1-an`: create, versioning off, S3's default encryption, Block Public Access on",
      'Bucket policy: create, only its CloudFront distribution reads the bucket',
    ]);
    // The read wrote the definition under the bucket name the plan shows,
    // with the origin at the bucket's root until a deploy switches it.
    const [readInput] = ctx.cloud.tofuInputs;
    expect(readInput.definition).toContain(`"bucket": "${step.bucket!.name}"`);
    expect(readInput.definition).toContain('aws_cloudfront_distribution');
    expect(readInput.definition).toContain('"origin_path": ""');
    expect(readInput.definition).not.toContain('ignore_changes');
    expect(await ctx.db.select().from(deployment)).toEqual([]);

    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      results: [
        {
          configName: 'docs',
          action: 'create',
          status: 'applied',
          serviceType: 'application',
          serviceId: step.cloudRead!.serviceId,
          deploy: { status: 'queued' },
        },
      ],
    });

    const [created] = await ctx.db.select().from(application);
    expect(created).toMatchObject({
      applicationId: step.cloudRead!.serviceId,
      configName: 'docs',
      configKind: 'static',
      cloudAccountId,
      region: REGION,
      serverId: null,
      cloudBucketName: step.bucket!.name,
      publishDirectory: 'dist',
    });
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.applicationId, created.applicationId));
    expect(state.infrastructureStateId).toBe(step.cloudRead!.stateId);

    // Its Cloud run is a Deployment of the Service, building nothing.
    const run = await ended(deploymentOf(applied));
    expect(run).toMatchObject({
      applicationId: created.applicationId,
      status: 'done',
      cloudRun: expect.objectContaining({ kind: 'static' }) as unknown,
    });
    expect(ctx.cloud.calls.filter((call) => call.method === 'apply')).toEqual([
      expect.objectContaining({ stateId: state.infrastructureStateId }),
    ]);
    expect(queue.add).not.toHaveBeenCalled();
    const [after] = await ctx.db.select().from(application);
    expect(after.applicationStatus).toBe('done');

    // Its distribution's own name is its generated Domain, shown on
    // the Service as a Server's generated Domain is.
    const generated = `${fakeDistributionId(state.infrastructureStateId).toLowerCase()}.cloudfront.net`;
    const shown = await request(http)
      .get(`/applications/${created.applicationId}`)
      .set('Cookie', cookie);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ cloudDistributionDomain: generated });
  });

  it('plans spa: true as the distribution answering a missing path with /index.html, and Apply writes it', async () => {
    await made();

    ctx.cloud.replayPlanFor('static', 'static-spa-change');
    const saved = await save(
      DOCS.replace('publish: dist', 'publish: dist\n      spa: true'),
    );
    expect(saved.status).toBe(201);
    const read = await readPlan();
    expect(read.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'docs',
        kind: 'static',
        fields: [expect.objectContaining({ field: 'build.spa' })],
        site: { spa: true },
      }),
    ]);
    expect(read.steps[0].cloudRead?.summary).toEqual([
      'CloudFront distribution: change, error responses 403 → 200 /index.html, 404 → 200 /index.html',
    ]);
    expect(ctx.cloud.tofuInputs.at(-1)!.definition).toContain(
      '"response_page_path": "/index.html"',
    );

    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    const run = await ended(deploymentOf(applied));
    expect(run.status).toBe('done');
    // Nothing is built for it: the run is its own, in the Cloud run pool.
    expect(queue.add).not.toHaveBeenCalled();
    const [after] = await ctx.db.select().from(application);
    expect(after.isStaticSpa).toBe(true);
    expect(ctx.cloud.tofuInputs.at(-1)!.definition).toContain(
      '"response_page_path": "/index.html"',
    );
  });

  it('shows a hand change in the AWS console as Drift, and Apply puts it back', async () => {
    const created = await made();

    ctx.cloud.replayPlanFor('static', 'static-drift');
    expect((await checkForChanges()).status).toBe(201);
    const read = await readPlan();
    expect(read.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'docs',
        kind: 'static',
        fields: [],
      }),
    ]);
    expect(read.steps[0].cloudRead?.drift).toEqual([
      expect.objectContaining({
        address: 'aws_cloudfront_distribution.site',
        line: 'CloudFront distribution: changed outside Cloudgate, will be put back',
      }),
      expect.objectContaining({
        address: 'aws_s3_bucket_policy.site',
        line: 'Bucket policy: will be made again',
        deleted: true,
      }),
    ]);

    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    const run = await ended(deploymentOf(applied));
    expect(run).toMatchObject({
      applicationId: created.applicationId,
      status: 'done',
      cloudRun: expect.objectContaining({ kind: 'static' }) as unknown,
    });
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.applicationId, created.applicationId));
    expect(ctx.cloud.calls.filter((call) => call.method === 'apply')).toEqual([
      expect.objectContaining({ stateId: state.infrastructureStateId }),
    ]);
  });

  it("queues the site's Domain run again once its Apply has put a hand change back", async () => {
    const created = await made();
    // A Domain whose add run met the hand change and changed nothing.
    await ctx.db.insert(domain).values({
      host: 'docs.example.com',
      path: '/',
      https: true,
      domainType: 'application',
      applicationId: created.applicationId,
      cloudCertificateStatus: 'waiting-for-dns',
    });

    ctx.cloud.replayPlanFor('static', 'static-oac-drift');
    expect((await checkForChanges()).status).toBe(201);
    const read = await readPlan();
    expect(read.steps[0].cloudRead?.drift).toEqual([
      expect.objectContaining({ address: 'aws_cloudfront_distribution.site' }),
    ]);
    const run = await ended(deploymentOf(await apply(read.planId)));
    expect(run.status).toBe('done');

    const [again] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.title, 'Finish the Domain docs.example.com'));
    expect(again).toMatchObject({ applicationId: created.applicationId });
    expect(fs.readFileSync(run.logPath, 'utf8')).toContain(
      `its change goes on in Deployment ${again.deploymentId}`,
    );
  });

  it('plans nothing when AWS is as Cloudgate made it', async () => {
    await made();

    ctx.cloud.replayShowFor('static', {
      format_version: '1.2',
      terraform_version: '1.13.1',
      resource_changes: [],
    });
    expect((await checkForChanges()).status).toBe(201);
    expect((await readPlan()).status).toBe('unchanged');
  });

  describe('native.aws on CloudFront', () => {
    const CDN = {
      'aws_cloudfront_distribution.site': {
        price_class: 'PriceClass_100',
        http_version: 'http2and3',
      },
    };
    const withNative = (lines: string) => `${DOCS}    native:
      aws:
        "aws_cloudfront_distribution.site":
${lines}`;

    it('plans price_class and http_version as native lines, applies them through the Cloud run, holds them with the site, and plans nothing next', async () => {
      await made();

      ctx.cloud.replayPlanFor('static', 'static-spa-change');
      const saved = await save(
        withNative(
          '          price_class: PriceClass_100\n          http_version: http2and3\n',
        ),
      );
      expect(saved.status).toBe(201);
      const read = await readPlan();
      const distribution = 'native.aws."aws_cloudfront_distribution.site"';
      expect(read.steps[0].fields?.map((diff) => diff.field)).toEqual([
        `${distribution}.price_class`,
        `${distribution}.http_version`,
      ]);
      // The read laid them over Cloudgate's definition.
      expect(ctx.cloud.tofuInputs.at(-1)!.definition).toContain(
        '"price_class": "PriceClass_100"',
      );

      const applied = await apply(read.planId);
      expect(applied.status).toBe(200);
      expect((await ended(deploymentOf(applied))).status).toBe('done');
      const [after] = await ctx.db.select().from(application);
      expect(after.nativeAws).toEqual(CDN);
      expect(ctx.cloud.tofuInputs.at(-1)!.definition).toContain(
        '"http_version": "http2and3"',
      );

      // Check for changes lays the applied block: nothing differs.
      ctx.cloud.replayShowFor('static', {
        format_version: '1.2',
        terraform_version: '1.13.1',
        resource_changes: [],
      });
      expect((await checkForChanges()).status).toBe(201);
      expect((await readPlan()).status).toBe('unchanged');
      expect(ctx.cloud.tofuInputs.at(-1)!.definition).toContain(
        '"price_class": "PriceClass_100"',
      );
    });

    it('refuses aliases with their reason, and custom_error_response while spa is set', async () => {
      const aliases = await save(
        withNative('          aliases: [docs.example.com]\n'),
      );
      expect(aliases.status).toBe(409);
      expect(JSON.stringify(aliases.body)).toContain(
        'docs.native.aws.\\"aws_cloudfront_distribution.site\\".aliases: refused - locked: the site\'s Domain is set through the Service\'s Domains',
      );

      const errors = await save(
        withNative(
          '          custom_error_response:\n            - { error_code: 404, response_code: 404, response_page_path: /404.html }\n',
        ).replace('publish: dist', 'publish: dist\n      spa: true'),
      );
      expect(errors.status).toBe(409);
      expect(JSON.stringify(errors.body)).toContain(
        'docs.native.aws.\\"aws_cloudfront_distribution.site\\".custom_error_response: refused - locked: the config\'s spa sets it',
      );
    });
  });
});
