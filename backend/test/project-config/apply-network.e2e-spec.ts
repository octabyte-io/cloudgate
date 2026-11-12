import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import {
  cloudAccount,
  deployment,
  environmentNetwork,
  plan as planTable,
} from '../../src/db/schema';
import type { Plan } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

const WEB = `version: 1
services:
  web:
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

interface Step {
  action: string;
  configName?: string;
  cloudRead?: {
    status: 'reading' | 'read' | 'failed';
    reason?: string;
    stateId?: string;
    serviceId?: string;
    raw?: { address: string; action: string }[];
  };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
  results:
    | {
        configName: string;
        action: string;
        status: string;
        message: string | null;
        network?: { environmentNetworkId: string; deploymentId: string };
      }[]
    | null;
}

/**
 * Apply makes the Environment network first. Its create is a Cloud run
 * against the network's own state, recorded as a Deployment of the
 * Environment network with its own Deployment log; once it is made its ids
 * are saved and each cloud Service step is planned again with them. The
 * Apply goes on only if that plan makes what was shown (the Service is then
 * created and its Deployment queued; its run is
 * `deployments/cloud-deploy.e2e-spec.ts`'s), and otherwise stops,
 * leaving what was planned again as the open plan. Against the fake cloud
 * port (`ctx.cloud`), replaying stored real `tofu show -json` files.
 */
describe('Apply makes the Environment network first (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-net-'));
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    // The network's Deployment log is written on the platform host, so the
    // platform root is one this suite can write and read back.
    process.env.CLOUDGATE_DIRECTORY = root;
    // The Service's Deployment is queued and never built here.
    ctx = await createTestApp({
      overrideProviders: [{ provide: DEPLOYMENT_QUEUE, useValue: queue }],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(root, { recursive: true, force: true });
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
    ctx.cloud.replayPlanFor('web', 'web-create');
  });

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

  /** A plan of the config, read from AWS, with the network's outputs scripted. */
  async function plannedWeb(): Promise<PlanBody> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: WEB });
    expect(saved.status).toBe(201);
    const read = await readPlan();
    expect(read.steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);
    ctx.cloud.outputsFor(read.steps[0].cloudRead!.stateId!, OUTPUTS);
    return read;
  }

  const apply = (planId: string) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

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

  it('makes the network as a Deployment of the Environment network with its own log, saves its ids, and goes on when the Service planned again makes what was shown', async () => {
    const read = await plannedWeb();
    const [networkStep, webStep] = read.steps;
    ctx.cloud.calls.length = 0;

    const res = await apply(read.planId);

    // The Apply answers while the network is made.
    expect(res.status).toBe(200);
    const answered = res.body as PlanBody;
    expect(answered.status).toBe('applied');
    expect(answered.results).toEqual([
      expect.objectContaining({
        configName: `Environment network (${REGION})`,
        action: 'network-create',
        status: 'running',
      }),
    ]);
    const { environmentNetworkId, deploymentId } =
      answered.results![0].network!;
    expect(typeof environmentNetworkId).toBe('string');
    expect(typeof deploymentId).toBe('string');

    const row = await settled(read.planId);
    expect(row.status).toBe('applied');
    expect(row.results).toEqual([
      expect.objectContaining({
        action: 'network-create',
        status: 'applied',
        message: null,
        network: { environmentNetworkId, deploymentId },
      }),
      expect.objectContaining({
        configName: 'web',
        action: 'create',
        status: 'applied',
        message: null,
        serviceId: webStep.cloudRead!.serviceId,
        domain: null,
        deploy: {
          status: 'queued',
          deploymentId: expect.any(String) as string,
        },
      }),
    ]);

    // The network's ids are saved on its row, which is ready.
    const [network] = await ctx.db
      .select()
      .from(environmentNetwork)
      .where(eq(environmentNetwork.environmentNetworkId, environmentNetworkId));
    expect(network).toMatchObject({
      environmentId,
      cloudAccountId,
      region: REGION,
      status: 'ready',
      vpcId: OUTPUTS.vpc_id,
      publicSubnetIds: OUTPUTS.public_subnet_ids,
      privateSubnetIds: OUTPUTS.private_subnet_ids,
      clusterArn: OUTPUTS.cluster_arn,
      albArn: OUTPUTS.alb_arn,
      albDnsName: OUTPUTS.alb_dns_name,
      httpsListenerArn: OUTPUTS.https_listener_arn,
      albSecurityGroupId: OUTPUTS.alb_security_group_id,
      defaultCertificateArn: OUTPUTS.default_certificate_arn,
      leftovers: [],
    });

    // Its state is the one its plan was read against: no second workspace.
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(
        eq(infrastructureState.environmentNetworkId, environmentNetworkId),
      );
    expect(state.infrastructureStateId).toBe(networkStep.cloudRead!.stateId);

    // A Deployment of the Environment network, a `network` Cloud run.
    const [run] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId));
    expect(run).toMatchObject({
      environmentNetworkId,
      applicationId: null,
      status: 'done',
      title: `Make the Environment network (${REGION})`,
      cloudRun: {
        kind: 'network',
        stateKey: `network:${environmentNetworkId}`,
        environmentId,
        touchesNetwork: true,
      },
    });
    const log = await request(http)
      .get(`/deployments/${deploymentId}/logs`)
      .set('Cookie', cookie);
    expect(log.status).toBe(200);
    expect(log.text).toContain(
      `Making the Environment network (${REGION}) in Cloud account Production AWS`,
    );
    expect(log.text).toContain('Apply complete!');
    expect(log.text).toContain(
      `its load balancer answers at ${OUTPUTS.alb_dns_name}`,
    );

    // The network applied against its state; then the Service was planned
    // again, keeping the state its plan was read with; nothing else applied.
    const tofu = ctx.cloud.calls.filter(
      (call) => call.method === 'plan' || call.method === 'apply',
    );
    expect(tofu).toEqual([
      expect.objectContaining({
        method: 'apply',
        stateId: networkStep.cloudRead!.stateId,
        variables: [
          'default_certificate_body',
          'default_certificate_private_key',
        ],
      }),
      expect.objectContaining({
        method: 'plan',
        stateId: webStep.cloudRead!.stateId,
      }),
    ]);

    // No new plan was left open: the plan applied is the latest.
    expect((await currentPlan()).planId).toBe(read.planId);

    // The Organization's feed lists the run under the network's Environment.
    const feed = await request(http).get('/deployments').set('Cookie', cookie);
    expect(feed.status).toBe(200);
    expect(
      (feed.body as { rows: Record<string, unknown>[] }).rows,
    ).toContainEqual(
      expect.objectContaining({
        deploymentId,
        owner: {
          type: 'environmentNetwork',
          id: environmentNetworkId,
          name: `Environment network (${REGION})`,
        },
        environment: { environmentId, name: 'production' },
      }),
    );

    // The console's card: ready, its idle cost, and the Service now in it.
    const networks = await request(http)
      .get(`/environments/${environmentId}/networks`)
      .set('Cookie', cookie);
    expect(networks.status).toBe(200);
    expect(networks.body).toEqual([
      expect.objectContaining({
        environmentNetworkId,
        cloudAccountName: 'Production AWS',
        region: REGION,
        status: 'ready',
        albDnsName: OUTPUTS.alb_dns_name,
        idleCost: 'about $24/month while idle',
        serviceCount: 1,
      }),
    ]);
    expect(
      (networks.body as { lastRun: Record<string, unknown> }[])[0].lastRun,
    ).toMatchObject({ deploymentId, status: 'done' });
  });

  it('stops after the network and leaves the Service planned again as the open plan when it no longer makes what was shown', async () => {
    const read = await plannedWeb();
    // AWS reads differently once the network is there.
    ctx.cloud.replayPlanFor('web', 'drift-field');

    const res = await apply(read.planId);
    expect(res.status).toBe(200);

    const row = await settled(read.planId);
    expect(row.status).toBe('partly-applied');
    expect(row.results![0]).toMatchObject({
      action: 'network-create',
      status: 'applied',
    });
    expect(row.results![1]).toMatchObject({
      configName: 'web',
      action: 'create',
      status: 'failed',
    });
    expect(row.results![1].message).toMatch(
      /^Not applied: planned again with the Environment network’s ids, this plan no longer makes what it showed \(web: it now would .*\)\. Review the new open plan, then apply it$/,
    );

    // The network is made all the same, and kept.
    const [network] = await ctx.db.select().from(environmentNetwork);
    expect(network.status).toBe('ready');

    // What was planned again is the open plan: the Service, read with the
    // network's ids, and no second network step.
    const open = await currentPlan();
    expect(open.planId).not.toBe(read.planId);
    expect(open.status).toBe('open');
    expect(open.steps).toHaveLength(1);
    expect(open.steps[0]).toMatchObject({
      action: 'create',
      configName: 'web',
      cloudRead: {
        status: 'read',
        stateId: read.steps[1].cloudRead!.stateId,
        serviceId: read.steps[1].cloudRead!.serviceId,
      },
    });
    expect(open.steps[0].cloudRead!.raw).not.toEqual(
      read.steps[1].cloudRead!.raw,
    );
  });

  it('leaves a network whose run failed to be made again by the next plan, against the same state', async () => {
    const read = await plannedWeb();
    const stateId = read.steps[0].cloudRead!.stateId!;
    ctx.cloud.failRunFor(
      'network',
      'creating ELBv2 application Load Balancer: TooManyLoadBalancers',
    );

    await apply(read.planId);
    const row = await settled(read.planId);

    expect(row.status).toBe('partly-applied');
    expect(row.results).toEqual([
      expect.objectContaining({
        action: 'network-create',
        status: 'failed',
        message:
          'creating ELBv2 application Load Balancer: TooManyLoadBalancers',
      }),
      expect.objectContaining({
        configName: 'web',
        status: 'failed',
        message: 'Not applied: the Environment network was not made',
      }),
    ]);
    const [network] = await ctx.db.select().from(environmentNetwork);
    expect(network.status).toBe('create-failed');
    const [run] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.environmentNetworkId, network.environmentNetworkId));
    expect(run.status).toBe('error');

    // The next plan lists the network again, read against its own state.
    ctx.cloud.reset();
    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('web', 'web-create');
    const again = await request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(again.status).toBe(201);
    const reread = await readPlan();
    expect(reread.steps[0]).toMatchObject({
      action: 'network-create',
      cloudRead: { status: 'read', stateId },
    });
  });

  it('refuses deleting the Cloud account while the network is there, naming it', async () => {
    const read = await plannedWeb();
    await apply(read.planId);
    await settled(read.planId);

    const account = await request(http)
      .delete(`/cloud-accounts/${cloudAccountId}`)
      .set('Cookie', cookie);
    expect(account.status).toBe(409);
    expect((account.body as { message: string }).message).toContain(
      `1 Environment network (shop / production in ${REGION})`,
    );
    expect(await ctx.db.select().from(environmentNetwork)).toHaveLength(1);
  });
});
