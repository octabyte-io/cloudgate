import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import {
  cloudAccount,
  deployment,
  plan as planTable,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(240_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

const TWO_WEBS = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
  api:
    kind: web
    size: small
    source: { image: nginx }
`;

/** What `tofu output -json` answers after the network's apply. */
const OUTPUTS = {
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

/** What `tofu show -json` prints for a plan with nothing to do. */
const NOTHING: TofuShow = {
  format_version: '1.2',
  terraform_version: '1.13.1',
  resource_changes: [],
};

/** Every variable value the stored plans carry, in clear. */
const SECRET_VALUES = ['hunter2-very-secret', 'changed-by-hand-secret'];

interface Aws {
  status: 'reading' | 'read' | 'failed';
  reason?: string;
  summary?: string[];
  raw?: { address: string; action: string; drift: boolean }[];
  counts?: Record<string, number>;
  drift?: {
    address: string;
    line: string;
    deleted: boolean;
    replaceForcing: boolean;
    fields: { field: string; hand: string; cloudgate: string }[];
  }[];
  adopt?: { address: string; arn: string; line: string }[];
  noState?: { arn: string; address: string | null; line: string }[];
  stateId?: string;
  serviceId?: string;
  liveImage?: string | null;
}

interface Step {
  action: string;
  configName?: string;
  serviceId?: string;
  environmentNetworkId?: string;
  fields?: unknown[];
  cloudRead?: Aws;
}

interface Result {
  configName: string;
  action: string;
  status: string;
  message: string | null;
  deploy: { status: string; deploymentId?: string; message?: string } | null;
  network?: { environmentNetworkId: string; deploymentId: string };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
  results: Result[] | null;
}

/** What one made cloud Service is, as the Apply that made it left it. */
interface Made {
  applicationId: string;
  stateId: string;
  /** Its live image: the tag of its finished deploy. */
  liveImage: string;
}

/**
 * Spec "Plan behaviour", "Drift", "Recovery by tag": a plan
 * reads what exists in a Cloud account for Drift, and Apply always puts
 * back Cloudgate's version.
 *
 * Two cloud webs and their Environment network are made through a real
 * Apply, each web's deploy then marked finished on its image.
 * "Check for changes" then reads every cloud Service and the network; a
 * push or Save plan reads what it touches plus the Services an open plan
 * found drift on. Drift shows each field's hand value and Cloudgate's, red
 * when only a replace puts it back, and "will be made again" for what was
 * deleted by hand; sensitive values never. A drift-only plan stays open,
 * and its Apply ("put AWS back") queues a Deployment on the live image per
 * drifted Service and a network run for the network, which apply exactly
 * that. Every read searches by Cloudgate's tags: a find at an address the
 * plan would create (a state that lost its record) is adopted, and its
 * Apply imports it; a find no state wants is "found in AWS, in no state".
 *
 * Against the fake cloud port (`ctx.cloud`) replaying stored real
 * `tofu show -json` files; no build runs (the queue is a double).
 */
describe('Drift, adopt by tag and what each plan reads (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  let environmentNetworkId: string;
  let networkStateId: string;
  let web: Made;
  let api: Made;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-drift-'));
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    // Every Cloud run's Deployment log is written on the platform host.
    process.env.CLOUDGATE_DIRECTORY = root;
    ctx = await createTestApp({
      overrideProviders: [{ provide: DEPLOYMENT_QUEUE, useValue: queue }],
    });
    http = ctx.app.getHttpServer() as App;
    ctx.app.get(CloudServiceDeploys).pollIntervalMs = 10;
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(root, { recursive: true, force: true });
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

    await makeTwoWebs();
    // From here AWS is as Cloudgate made it, unless a spec says otherwise.
    ctx.cloud.replayShowFor('network', NOTHING);
    ctx.cloud.replayShowFor('web', NOTHING);
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;
    queue.add.mockClear();
  });

  /**
   * The two webs and their network, made by a real Apply, and each web's
   * deploy marked finished as a Cloud run would leave it: its live image.
   */
  async function makeTwoWebs(): Promise<void> {
    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('web', 'web-create');
    const saved = await save(TWO_WEBS);
    expect(saved.status).toBe(201);
    const read = await readPlan();
    networkStateId = read.steps[0].cloudRead!.stateId!;
    ctx.cloud.outputsFor(networkStateId, OUTPUTS);
    expect((await apply(read.planId)).status).toBe(200);
    const row = await settled(read.planId);
    const made = (name: string): Made => {
      const step = read.steps.find((one) => one.configName === name)!;
      const result = row.results!.find((one) => one.configName === name)!;
      expect(result).toMatchObject({ status: 'applied' });
      return {
        applicationId: step.cloudRead!.serviceId!,
        stateId: step.cloudRead!.stateId!,
        liveImage: (result.deploy as { deploymentId: string }).deploymentId,
      };
    };
    web = made('web');
    api = made('api');
    environmentNetworkId = row.results!.find(
      (one) => one.action === 'network-create',
    )!.network!.environmentNetworkId;
    for (const one of [web, api]) {
      await ctx.db
        .update(deployment)
        .set({
          status: 'done',
          cloudRun: {
            kind: 'deploy',
            stateKey: `application:${one.applicationId}`,
            environmentId,
            touchesNetwork: false,
            architecture: 'arm64',
          },
        })
        .where(eq(deployment.deploymentId, one.liveImage));
    }
  }

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  const checkForChanges = () =>
    request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie)
      .send({});

  const apply = (planId: string, confirmDestroy?: string[]) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId, ...(confirmDestroy ? { confirmDestroy } : {}) });

  async function currentPlan(): Promise<PlanBody> {
    const res = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: PlanBody }).plan;
  }

  /** The Environment's plan once no step is still reading AWS. */
  async function readPlan(): Promise<PlanBody> {
    for (let attempt = 0; attempt < 300; attempt++) {
      const found = await currentPlan();
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading AWS');
  }

  /** "Check for changes", read: the plan it stores once AWS is read. */
  async function checked(): Promise<PlanBody> {
    const res = await checkForChanges();
    expect(res.status).toBe(201);
    return readPlan();
  }

  /** The plan's row once no result says `running`: the Apply is over. */
  async function settled(planId: string): Promise<Plan> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const [row] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, planId));
      if (
        row.results !== null &&
        !row.results.some((result) => result.status === 'running')
      ) {
        return row;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The Apply never ended');
  }

  /** The Deployment once its Cloud run has ended. */
  async function ended(deploymentId: string): Promise<Deployment> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      if (row && !['pending', 'running'].includes(row.status)) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The Cloud run never ended');
  }

  const stepOf = (found: PlanBody, name: string) =>
    found.steps.find((step) => step.configName === name)!;

  /** The states each `tofu plan` since the calls were cleared ran against. */
  const plannedStates = () =>
    ctx.cloud.calls
      .flatMap((call) => (call.method === 'plan' ? [call.stateId] : []))
      .sort();

  describe('what each plan reads', () => {
    it('reads every cloud Service and the network on Check for changes, each against its own state and live image', async () => {
      const res = await checkForChanges();
      expect(res.status).toBe(201);
      const stored = res.body as PlanBody;

      // Stored reading: the network, then each Service as a change of no field.
      expect(stored.status).toBe('open');
      expect(stored.steps[0]).toEqual({
        action: 'network-change',
        environmentNetworkId,
        cloudAccountId,
        region: REGION,
        cloudRead: { status: 'reading' },
      });
      expect(stored.steps.slice(1)).toEqual(
        expect.arrayContaining(
          [web, api].map((one): unknown =>
            expect.objectContaining({
              action: 'change',
              serviceId: one.applicationId,
              fields: [],
              cloudRead: { status: 'reading' },
            }),
          ),
        ),
      );
      expect(stored.steps).toHaveLength(3);

      await readPlan();
      expect(plannedStates()).toEqual(
        [networkStateId, web.stateId, api.stateId].sort(),
      );
      // Written with the live image, on the CPU its deploy recorded.
      const webInput = ctx.cloud.tofuInputs.find(
        (input) => input.stateId === web.stateId,
      )!;
      expect(webInput.definition).toContain(`:${web.liveImage}`);
      // Deployed before its image's HEALTHCHECK was recorded, so written
      // with none, as that deploy registered it: no change.
      expect(webInput.definition).not.toContain('healthCheck');
      expect(ctx.cloud.calls).toContainEqual(
        expect.objectContaining({
          method: 'plan',
          stateId: web.stateId,
          cpuArchitecture: 'ARM64',
        }),
      );
      // Each read searched by the Environment's and Cloud account's tags.
      expect(
        ctx.cloud.calls.filter((call) => call.method === 'findTagged'),
      ).toHaveLength(3);
    });

    it('is unchanged once every read finds AWS as Cloudgate made it', async () => {
      const read = await checked();

      expect(read.status).toBe('unchanged');
      expect(
        read.steps.every((step) => step.cloudRead?.raw?.length === 0),
      ).toBe(true);
      expect(stepOf(read, 'web').cloudRead?.liveImage).toBe(web.liveImage);
    });

    it('reads, for a Save, only the Service it changes, never the network or another Service', async () => {
      const res = await save(
        TWO_WEBS.replace(
          '    size: small\n',
          '    size: small\n    port: 8080\n',
        ),
      );
      expect(res.status).toBe(201);
      const read = await readPlan();

      expect(read.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'web',
          fields: [{ field: 'port', from: 3000, to: 8080 }],
          cloudRead: expect.objectContaining({ status: 'read' }) as unknown,
        }),
      ]);
      expect(plannedStates()).toEqual([web.stateId]);
    });

    it('reads, for a Save, the Services the open plan it replaces found drift on too', async () => {
      ctx.cloud.replayPlan('drift-field', api.stateId);
      const drifted = await checked();
      expect(stepOf(drifted, 'api').cloudRead?.counts?.drift).toBe(2);
      ctx.cloud.calls.length = 0;

      const res = await save(
        TWO_WEBS.replace(
          '    size: small\n',
          '    size: small\n    port: 8080\n',
        ),
      );
      expect(res.status).toBe(201);
      const read = await readPlan();

      expect(read.steps.map((step) => [step.action, step.configName])).toEqual([
        ['change', 'web'],
        ['change', 'api'],
      ]);
      expect(stepOf(read, 'api').cloudRead?.drift).toHaveLength(2);
      expect(plannedStates()).toEqual([web.stateId, api.stateId].sort());
    });
  });

  describe('Drift', () => {
    it("lists each drifted field's hand value and Cloudgate's, never a sensitive value, and keeps a drift-only plan open", async () => {
      ctx.cloud.replayPlan('drift-field', web.stateId);

      const read = await checked();
      const drift = stepOf(read, 'web').cloudRead!;

      expect(read.status).toBe('open');
      expect(drift.counts).toMatchObject({ drift: 2, change: 0, create: 0 });
      expect(drift.drift).toEqual([
        expect.objectContaining({
          address: 'aws_security_group.service',
          deleted: false,
          replaceForcing: false,
          fields: [expect.objectContaining({ field: 'ingress' })],
        }),
        expect.objectContaining({
          line: 'Variable `API_KEY`: changed outside Cloudgate, will be put back',
          fields: [
            { field: 'value', hand: '(sensitive)', cloudgate: '(sensitive)' },
          ],
        }),
      ]);
      const answered = JSON.stringify(read);
      for (const secret of SECRET_VALUES) {
        expect(answered).not.toContain(secret);
      }
    });

    it('shows a drift only a replace puts back in red, with brief downtime, and applies it with no typing', async () => {
      ctx.cloud.replayPlan('replace-drift', web.stateId);

      const read = await checked();
      const aws = stepOf(read, 'web').cloudRead!;

      expect(aws.counts).toMatchObject({ drift: 1, briefDowntime: 1 });
      expect(aws.drift).toEqual([
        expect.objectContaining({
          line: 'Variable `API_KEY`: changed outside Cloudgate, will be put back, brief downtime',
          replaceForcing: true,
        }),
      ]);
      // Typed confirmation is for removing a Service, never a replace in a step.
      const res = await apply(read.planId);
      expect(res.status).toBe(200);
    });

    it('marks what was deleted by hand as will be made again', async () => {
      ctx.cloud.replayPlan('drift-tags-noise', web.stateId);

      const read = await checked();

      expect(read.status).toBe('open');
      expect(stepOf(read, 'web').cloudRead?.drift).toEqual([
        expect.objectContaining({
          line: '`aws_cloudwatch_log_group.service`: will be made again',
          deleted: true,
        }),
        expect.objectContaining({
          line: 'ECS service `web`: will be made again',
          deleted: true,
        }),
        expect.objectContaining({
          address: 'aws_security_group.service',
          deleted: false,
        }),
      ]);
    });
  });

  describe('Apply: put AWS back', () => {
    it('queues a Deployment on the live image for each drifted Service, which applies the approved put-back and builds nothing', async () => {
      ctx.cloud.replayPlan('drift-field', web.stateId);
      const read = await checked();
      ctx.cloud.calls.length = 0;
      ctx.cloud.tofuInputs.length = 0;

      const res = await apply(read.planId);

      expect(res.status).toBe(200);
      const answered = res.body as PlanBody;
      expect(answered.status).toBe('applied');
      // The quiet network and api have nothing to put back, so no result.
      expect(answered.results).toEqual([
        expect.objectContaining({
          configName: 'web',
          action: 'change',
          status: 'applied',
          deploy: {
            status: 'queued',
            deploymentId: expect.any(String) as string,
          },
        }),
      ]);
      const { deploymentId } = answered.results![0].deploy!;
      const row = await ended(deploymentId!);

      expect(row).toMatchObject({
        applicationId: web.applicationId,
        title: 'Put AWS back',
        status: 'done',
        cloudRun: {
          kind: 'deploy',
          stateKey: `application:${web.applicationId}`,
          liveImage: web.liveImage,
          architecture: 'arm64',
        },
      });
      // No build was queued, no image pushed; the apply ran the live image.
      expect(queue.add).not.toHaveBeenCalled();
      const methods = ctx.cloud.calls.map((call) => call.method);
      expect(methods).not.toContain('ecrAuthorizationToken');
      expect(methods).toContain('apply');
      expect(
        ctx.cloud.tofuInputs.find((input) => input.stateId === web.stateId)
          ?.definition,
      ).toContain(`:${web.liveImage}`);
      expect(ctx.cloud.calls).toContainEqual(
        expect.objectContaining({
          method: 'ecrDeleteImagesExcept',
          keepTag: web.liveImage,
        }),
      );
      // A put-back writes no setting, so its Service stays where it was.
      expect(fs.readFileSync(row.logPath, 'utf8')).toContain(
        "Putting AWS back to Cloudgate's version",
      );
    });

    it('queues a network run when the network drifted, which applies what was read', async () => {
      ctx.cloud.replayPlanFor('network', 'drift-tags-noise');
      const read = await checked();

      const res = await apply(read.planId);

      expect(res.status).toBe(200);
      const [result] = (res.body as PlanBody).results!;
      expect(result).toMatchObject({
        configName: `Environment network (${REGION})`,
        action: 'network-change',
        status: 'applied',
        network: { environmentNetworkId },
      });
      const row = await ended(result.network!.deploymentId);
      expect(row).toMatchObject({
        environmentNetworkId,
        title: `Put the Environment network (${REGION}) back`,
        status: 'done',
        cloudRun: { kind: 'network', touchesNetwork: true },
      });
      expect(ctx.cloud.calls).toContainEqual(
        expect.objectContaining({ method: 'apply', stateId: networkStateId }),
      );
    });

    it('refuses a put-back whose AWS moved since the plan was read, changing nothing', async () => {
      ctx.cloud.replayPlan('drift-field', web.stateId);
      const read = await checked();
      ctx.cloud.replayPlan('replace-drift', web.stateId);

      const res = await apply(read.planId);
      const row = await ended(
        (res.body as PlanBody).results![0].deploy!.deploymentId!,
      );

      expect(row.status).toBe('error');
      expect(row.description).toContain(
        'AWS no longer matches the plan that was applied',
      );
    });
  });

  describe('Recovery by tag', () => {
    const tags = (stateId: string, address: string) => ({
      'cloudgate:cloud-account': cloudAccountId,
      'cloudgate:environment': environmentId,
      'cloudgate:state': stateId,
      'cloudgate:address': address,
    });
    const repositoryArn = `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/cloudgate/svc_1`;

    it('adopts what a state lost its record of at an address the plan would create, and its Apply imports it', async () => {
      // The state's record is gone (an older backup): its plan makes it all.
      ctx.cloud.replayPlan('web-create', web.stateId);
      ctx.cloud.leaveTagged(
        REGION,
        repositoryArn,
        tags(web.stateId, 'aws_ecr_repository.service'),
      );

      const read = await checked();
      const aws = stepOf(read, 'web').cloudRead!;

      expect(aws.adopt).toEqual([
        {
          address: 'aws_ecr_repository.service',
          resourceType: 'aws_ecr_repository',
          arn: repositoryArn,
          line: "ECR repository `cloudgate/svc_1`: found in AWS, taken back into Cloudgate's record",
        },
        // Untaggable, made with the repository and adopted with it.
        {
          address: 'aws_ecr_lifecycle_policy.service',
          resourceType: 'aws_ecr_lifecycle_policy',
          arn: repositoryArn,
          line: "`aws_ecr_lifecycle_policy.service`: found in AWS, taken back into Cloudgate's record",
        },
      ]);
      expect(aws.raw).toContainEqual(
        expect.objectContaining({
          address: 'aws_ecr_repository.service',
          action: 'adopt',
        }),
      );
      ctx.cloud.tofuInputs.length = 0;

      const res = await apply(read.planId);
      const row = await ended(
        (res.body as PlanBody).results![0].deploy!.deploymentId!,
      );

      expect(row.status).toBe('done');
      const applied = ctx.cloud.tofuInputs.find(
        (input) => input.stateId === web.stateId,
      )!;
      expect(JSON.parse(applied.definition)).toMatchObject({
        import: [
          { to: 'aws_ecr_repository.service', id: 'cloudgate/svc_1' },
          { to: 'aws_ecr_lifecycle_policy.service', id: 'cloudgate/svc_1' },
        ],
      });
    });

    it("notes what carries Cloudgate's tags but no state it knows, once, as found in AWS, in no state", async () => {
      const stray = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/cg-old/1`;
      ctx.cloud.leaveTagged(
        REGION,
        stray,
        tags('state-from-a-restored-backup', 'aws_lb_target_group.service'),
      );

      const read = await checked();
      const notes = read.steps.flatMap((step) => step.cloudRead?.noState ?? []);

      expect(notes).toEqual([
        {
          arn: stray,
          address: 'aws_lb_target_group.service',
          line: `found in AWS, in no state: ${stray}`,
        },
      ]);
      // A note changes nothing.
      expect(read.status).toBe('unchanged');
    });
  });
});
