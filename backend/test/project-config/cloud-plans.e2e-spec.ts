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
  environmentNetwork,
  plan as planTable,
  registry,
} from '../../src/db/schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const DEPLOY_ROLE = `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy`;

const WEB = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
`;

const TWO_WEBS = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
  api:
    kind: web
    source: { image: nginx }
`;

/** A step as the API answers it, loosely: the fields these specs read. */
interface Step {
  action: string;
  configName?: string;
  placement?: Record<string, unknown>;
  cloud?: {
    size: {
      name: string | null;
      pair: { runsOn: string; wording: string; roundedUpFrom?: string };
    };
  };
  cloudRead?: {
    status: 'reading' | 'read' | 'failed';
    reason?: string;
    summary?: string[];
    raw?: { address: string; action: string }[];
    counts?: Record<string, number>;
    stateId?: string;
    serviceId?: string;
  };
  cloudAccountId?: string;
  region?: string;
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
}

const messageOf = (res: request.Response) =>
  (res.body as { message: string }).message;

/**
 * In an Environment whose Deploy target is a Cloud account, a plan
 * that creates a `web` reads AWS before anything is spent. The plan is
 * stored with its cloud steps "reading AWS…"; each read then runs in the
 * Cloud run pool through the cloud port (`ctx.cloud`, replaying stored real
 * `tofu show -json` files) and its plain summary and raw AWS lines land on
 * the step. A first cloud `web` brings the Environment network as its own
 * step; a failed read shows its reason and holds Apply back, naming it; and
 * applying a cloud create makes the Service with no generated Domain and
 * queues its Deployment.
 */
describe('Plans that read AWS for a cloud web (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };

  beforeAll(async () => {
    // An applied Service's Deployment is queued and never built here.
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
        deployRoleArn: DEPLOY_ROLE,
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
        deployTarget: { kind: 'cloud', cloudAccountId, region: 'eu-central-1' },
      });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;

    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('web', 'web-create');
    ctx.cloud.calls.length = 0;
  });

  /** An Environment network already made here, its ids saved. */
  function readyNetwork() {
    return {
      environmentId,
      cloudAccountId,
      region: 'eu-central-1',
      status: 'ready' as const,
      vpcId: 'vpc-0a1b2c3d',
      publicSubnetIds: ['subnet-0aaa', 'subnet-0bbb'] as [string, string],
      clusterArn: `arn:aws:ecs:eu-central-1:${ACCOUNT}:cluster/env`,
      httpsListenerArn: `arn:aws:elasticloadbalancing:eu-central-1:${ACCOUNT}:listener/app/env/1/2`,
      albSecurityGroupId: 'sg-0alb',
    };
  }

  /** Saves a whole YAML text, which plans it here and stores the plan. */
  async function save(text: string): Promise<request.Response> {
    return request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });
  }

  async function savedPlan(text: string): Promise<PlanBody> {
    const res = await save(text);
    expect(res.status).toBe(201);
    return (res.body as { plans: PlanBody[] }).plans[0];
  }

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

  const apply = (planId: string) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

  describe('the first cloud web', () => {
    it('is stored reading AWS, then carries the network step and the Service its AWS lines, with stand-ins', async () => {
      const stored = await savedPlan(WEB);

      // Stored before AWS is read: every cloud step says so.
      expect(stored.status).toBe('open');
      expect(stored.steps).toEqual([
        {
          action: 'network-create',
          cloudAccountId,
          region: 'eu-central-1',
          cloudRead: { status: 'reading' },
        },
        expect.objectContaining({
          action: 'create',
          configName: 'web',
          kind: 'web',
          placement: { kind: 'cloud', cloudAccountId, region: 'eu-central-1' },
          cloud: {
            size: {
              name: 'small',
              pair: { runsOn: 'Fargate', wording: '0.5 vCPU / 1 GB' },
            },
            service: {
              port: 3000,
              command: null,
              args: [],
              size: { name: 'small', cpu: 0.5, memoryMb: 1024 },
            },
          },
          cloudRead: { status: 'reading' },
        }),
      ]);

      const read = await readPlan();
      const [network, web] = read.steps;

      expect(network.cloudRead?.status).toBe('read');
      expect(network.cloudRead?.summary).toEqual([
        'Environment network: create, about $24/month while idle',
      ]);
      expect(network.cloudRead?.raw?.map((line) => line.address)).toEqual(
        expect.arrayContaining([
          'aws_vpc.network',
          'aws_subnet.public_a',
          'aws_subnet.public_b',
          'aws_lb.network',
        ]),
      );
      expect(
        network.cloudRead?.raw?.every((line) => line.action === 'create'),
      ).toBe(true);

      expect(web.cloudRead?.status).toBe('read');
      expect(web.cloudRead?.summary).toEqual(
        expect.arrayContaining([
          'ECS service `web`: create, `small` → 0.5 vCPU / 1 GB, 1 task',
          'Task definition: create, new image, built by this deploy',
          'Environment network ids (`cluster`, `ingress`, `listener_arn`, `network_configuration`, `vpc_id`): made by this plan (Environment network)',
        ]),
      );
      expect(web.cloudRead?.counts).toMatchObject({ create: 11, destroy: 0 });
      // A new state, and the id the Service's definition was written with.
      expect(web.cloudRead?.stateId).toEqual(expect.any(String));
      expect(web.cloudRead?.serviceId).toEqual(expect.any(String));
      expect(JSON.stringify(read.steps)).not.toContain('cloudgate-stand-in');

      // Each read took on the deploy role, searched by Cloudgate's tags
      // then planned, and the web's looked for the task role it
      // would make by name, which no tag search sees; nothing applied.
      const methods = ctx.cloud.calls.map((call) => call.method).sort();
      expect(methods).toEqual([
        'assumeRole',
        'assumeRole',
        'findIamRole',
        'findTagged',
        'findTagged',
        'plan',
        'plan',
      ]);
      expect(
        ctx.cloud.calls.filter((call) => call.method === 'findTagged'),
      ).toEqual([
        {
          method: 'findTagged',
          region: 'eu-central-1',
          tags: {
            'cloudgate:environment': environmentId,
            'cloudgate:cloud-account': cloudAccountId,
          },
        },
        {
          method: 'findTagged',
          region: 'eu-central-1',
          tags: {
            'cloudgate:environment': environmentId,
            'cloudgate:cloud-account': cloudAccountId,
          },
        },
      ]);
      const plans = ctx.cloud.calls.filter((call) => call.method === 'plan');
      expect(plans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            variables: [
              'default_certificate_body',
              'default_certificate_private_key',
            ],
          }),
          // A Service a plan creates has no values yet: its digest only.
          expect.objectContaining({ variables: ['variables_digest'] }),
        ]),
      );
      // A read is a plan-only Cloud run: it records no Deployment.
      expect(await ctx.db.select().from(deployment)).toEqual([]);
    });

    it('answers MCP get_plan with the same AWS lines', async () => {
      await savedPlan(WEB);
      const read = await readPlan();
      const created = await request(http)
        .post('/agents')
        .set('Cookie', cookie)
        .send({
          name: 'reader-bot',
          role: 'agentReader',
          grant: {
            accessedProjects: [projectId],
            accessedEnvironments: [environmentId],
            accessedServices: [],
          },
        });
      expect(created.status).toBe(201);
      const { key } = created.body as { key: string };

      const res = await request(http)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${key}`)
        .set('MCP-Protocol-Version', '2025-06-18')
        .send({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'get_plan', arguments: { environmentId } },
        });

      expect(res.status).toBe(200);
      const result = (res.body as { result: { content: { text: string }[] } })
        .result;
      const payload = JSON.parse(result.content[0].text) as {
        plan: PlanBody;
      };
      // The same lines; the definition's inputs are the step's fields already.
      expect(payload.plan.steps).toMatchObject(
        read.steps.map(({ cloud, ...step }) =>
          cloud ? { ...step, cloud: { size: cloud.size } } : step,
        ),
      );
    });

    it('applies a plan that makes Services but no network: the web in its cloud place under its read ids, no Domain, its state and its Deployment queued', async () => {
      await ctx.db.insert(environmentNetwork).values(readyNetwork());
      const { planId } = await savedPlan(WEB);
      const read = await readPlan();
      expect(read.steps.map((step) => step.action)).toEqual(['create']);
      // The plan says how it will be reached instead of a generated Domain.
      const notes = (
        (await currentPlan()) as PlanBody & {
          notes: { kind: string; message: string }[];
        }
      ).notes;
      expect(notes).toContainEqual({
        kind: 'cloud-no-domain',
        configName: 'web',
        message:
          'web: no Domain yet, add one in the console once its first deploy is done',
      });

      const applied = await apply(planId);

      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({
        status: 'applied',
        results: [
          {
            configName: 'web',
            action: 'create',
            status: 'applied',
            serviceId: read.steps[0].cloudRead!.serviceId,
            domain: null,
            deploy: { status: 'queued' },
          },
        ],
      });
      const [created] = await ctx.db.select().from(application);
      expect(created).toMatchObject({
        applicationId: read.steps[0].cloudRead!.serviceId,
        configName: 'web',
        cloudAccountId,
        region: 'eu-central-1',
        serverId: null,
      });
      const [state] = await ctx.db
        .select()
        .from(infrastructureState)
        .where(eq(infrastructureState.applicationId, created.applicationId));
      expect(state.infrastructureStateId).toBe(
        read.steps[0].cloudRead!.stateId,
      );
      expect(await ctx.db.select().from(domain)).toEqual([]);
      expect(queue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          applicationType: 'application',
          applicationId: created.applicationId,
          title: 'Plan applied',
        }),
      );
    });
  });

  describe('a second cloud web', () => {
    it('has no network step once the Environment has its network there', async () => {
      await ctx.db.insert(environmentNetwork).values(readyNetwork());

      const stored = await savedPlan(TWO_WEBS);

      expect(stored.steps.map((step) => step.action)).toEqual([
        'create',
        'create',
      ]);
      const read = await readPlan();
      expect(read.steps.map((step) => step.cloudRead?.status)).toEqual([
        'read',
        'read',
      ]);
      expect(read.steps[1].cloud?.size).toEqual({
        name: null,
        pair: { runsOn: 'Fargate', wording: '0.25 vCPU / 0.5 GB' },
      });
      expect(
        ctx.cloud.calls.filter((call) => call.method === 'plan'),
      ).toHaveLength(2);
    });
  });

  describe('a failed read', () => {
    it('shows its reason on the step and refuses Apply, naming the step, until a read succeeds', async () => {
      ctx.cloud.failRunFor(
        'web',
        'creating ECS Service (web): AccessDeniedException: User is not authorized to perform: ecs:CreateService',
      );
      const { planId } = await savedPlan(WEB);
      const read = await readPlan();

      expect(read.steps[0].cloudRead?.status).toBe('read');
      expect(read.steps[1].cloudRead).toEqual({
        status: 'failed',
        reason:
          'creating ECS Service (web): AccessDeniedException: User is not authorized to perform: ecs:CreateService',
      });

      const refused = await apply(planId);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'PLAN_AWS_NOT_READ',
        message:
          'Apply waits until AWS is read for every step of this plan: the read failed for web (creating ECS Service (web): AccessDeniedException: User is not authorized to perform: ecs:CreateService), so Check for changes to read it again',
      });

      // Planning again reads again; this time AWS answers.
      ctx.cloud.reset();
      ctx.cloud.replayPlanFor('network', 'network-create');
      ctx.cloud.replayPlanFor('web', 'web-create');
      await savedPlan(WEB);
      const reread = await readPlan();
      expect(reread.planId).not.toBe(planId);
      expect(reread.steps.map((step) => step.cloudRead?.status)).toEqual([
        'read',
        'read',
      ]);
    });

    it('records a Cloud account credential that stopped working on the Cloud account, and names it on each step', async () => {
      ctx.cloud.refuseRole(
        `User: arn:aws:iam::${ACCOUNT}:user/cloudgate is not authorized to perform: sts:AssumeRole on resource: ${DEPLOY_ROLE}`,
      );
      await savedPlan(WEB);
      const read = await readPlan();

      const reason = `Cloud account Production AWS could not take on its deploy role: AWS answered AccessDenied: User: arn:aws:iam::${ACCOUNT}:user/cloudgate is not authorized to perform: sts:AssumeRole on resource: ${DEPLOY_ROLE}. Fix its credential or role in Organization settings, then Check for changes`;
      expect(read.steps.map((step) => step.cloudRead)).toEqual([
        { status: 'failed', reason },
        { status: 'failed', reason },
      ]);
      // Nothing reached tofu.
      expect(ctx.cloud.calls.some((call) => call.method === 'plan')).toBe(
        false,
      );
      const [account] = await ctx.db
        .select()
        .from(cloudAccount)
        .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
      expect(account.lastCheckResult).toBe('failed');
      expect(account.lastCheckReason).toBe(
        `AccessDenied: User: arn:aws:iam::${ACCOUNT}:user/cloudgate is not authorized to perform: sts:AssumeRole on resource: ${DEPLOY_ROLE}`,
      );
    });
  });

  describe('refusals at plan time', () => {
    it("refuses a size above Fargate's largest pair, naming the entry", async () => {
      const refused = await save(
        'version: 1\nservices:\n  web:\n    kind: web\n    size: { cpu: 32, memory: 64 GB }\n',
      );

      expect(refused.status).toBe(409);
      expect(messageOf(refused)).toContain(
        "web: size 32 CPU / 64 GB is above Fargate's largest pair, 16 vCPU / 120 GB",
      );
      expect(await ctx.db.select().from(planTable)).toEqual([]);
    });

    it('refuses a Registry linked to a cloud Service the config describes, naming the Registry', async () => {
      const made = await request(http)
        .post('/applications')
        .set('Cookie', cookie)
        .send({ name: 'Site', environmentId, serverId: null });
      expect(made.status).toBe(201);
      const { applicationId } = made.body as { applicationId: string };
      const [hub] = await ctx.db
        .insert(registry)
        .values({
          organizationId,
          name: 'Docker Hub',
          username: 'acme',
          password: 'hub-password',
          url: 'docker.io',
        })
        .returning();
      await ctx.db
        .update(application)
        .set({
          cloudAccountId,
          region: 'eu-central-1',
          registryId: hub.registryId,
        })
        .where(eq(application.applicationId, applicationId));

      const refused = await save(
        'version: 1\nservices:\n  site:\n    kind: web\n    source: { image: nginx }\n',
      );

      expect(refused.status).toBe(409);
      expect(messageOf(refused)).toContain(
        "site runs in a Cloud account, where its image always goes to the Service's own ECR repository, so the Registry Docker Hub linked to it is refused. Unlink it in the console",
      );
    });
  });

  describe("an Application's cloud place", () => {
    it('is a Cloud account and a region together, never beside a Server, and no edit changes it', async () => {
      const made = await request(http)
        .post('/applications')
        .set('Cookie', cookie)
        .send({ name: 'Site', environmentId, serverId: null });
      const { applicationId } = made.body as { applicationId: string };
      const place = (values: Partial<typeof application.$inferInsert>) =>
        ctx.db
          .update(application)
          .set(values)
          .where(eq(application.applicationId, applicationId));

      await expect(place({ cloudAccountId })).rejects.toThrow();
      await expect(place({ region: 'eu-central-1' })).rejects.toThrow();
      await place({ cloudAccountId, region: 'eu-central-1' });

      const edited = await request(http)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({ cloudAccountId: null, region: 'us-east-1', description: 'x' });
      expect(edited.status).toBe(200);
      const [row] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(row).toMatchObject({ cloudAccountId, region: 'eu-central-1' });
    });
  });

  // Last: its read never ends until the app shuts down and interrupts it.
  describe('a read still running', () => {
    it('shows "reading AWS…" on its step and refuses Apply, naming what it waits on', async () => {
      ctx.cloud.hangFor('web');
      const { planId } = await savedPlan(WEB);
      for (let attempt = 0; attempt < 200; attempt++) {
        const found = await currentPlan();
        if (found.steps[0].cloudRead?.status === 'read') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const found = await currentPlan();
      expect(found.steps.map((step) => step.cloudRead?.status)).toEqual([
        'read',
        'reading',
      ]);
      const refused = await apply(planId);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'PLAN_AWS_NOT_READ',
        message:
          'Apply waits until AWS is read for every step of this plan: still reading AWS for web',
      });
    });
  });
});
