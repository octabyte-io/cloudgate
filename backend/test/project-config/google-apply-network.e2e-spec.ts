import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import {
  cloudAccount,
  deployment,
  environmentNetwork,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import type { Plan } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { storedGoogleOutputs } from '../utils/fake-google-cloud-port';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';

const WEB = `version: 1
services:
  api:
    kind: web
    size: small
    source: { image: nginx }
`;

const TWO_WEBS = `${WEB}  admin:
    kind: web
    size: small
    source: { image: nginx }
`;

/** What the stored network apply answers, each output's value. */
const OUTPUTS = Object.fromEntries(
  Object.entries(storedGoogleOutputs('network-create')).map(
    ([name, output]) => [name, (output as { value: string }).value],
  ),
);

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
 * Spec "The network's Apply" (T13): on a Google Cloud Deploy
 * target, Apply makes the Environment network first, as on AWS: a
 * Deployment of the network whose Cloud run applies the network's state —
 * written with the Google provider — through the Google client port, saves
 * Google's outputs on the network row, plans each Service step again with
 * the network's real names, and goes on only if it still makes what was
 * shown. Against `ctx.google`, whose stand-in `tofu` replays the stored
 * Google plans and the stored network apply's outputs.
 */
describe('Apply makes the Google Environment network first (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gnet-'));
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    // The network's Deployment log is written on the platform host.
    process.env.CLOUDGATE_DIRECTORY = root;
    // The Service's Deployment is queued and never built here (T14's).
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

    ctx.google.replayPlanFor('network', 'network-create');
    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.replayOutputsFor('network', 'network-create');
  });

  async function currentPlan(): Promise<PlanBody> {
    const res = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: PlanBody }).plan;
  }

  /** The open plan once no step is still reading Google. */
  async function readPlan(): Promise<PlanBody> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const found = await currentPlan();
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading Google Cloud');
  }

  async function planned(text: string): Promise<PlanBody> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });
    expect(saved.status).toBe(201);
    return readPlan();
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

  it('makes the network as a Deployment of it, saves Google’s outputs on its row, plans the Service again with its names and queues it', async () => {
    const read = await planned(WEB);
    expect(read.steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);
    const [networkStep, webStep] = read.steps;
    ctx.google.calls.length = 0;

    const res = await apply(read.planId);

    // The Apply answers while the network is made.
    expect(res.status).toBe(200);
    expect((res.body as PlanBody).results).toEqual([
      expect.objectContaining({
        configName: `Environment network (${REGION})`,
        action: 'network-create',
        status: 'running',
      }),
    ]);
    const { environmentNetworkId, deploymentId } = (res.body as PlanBody)
      .results![0].network!;

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
        configName: 'api',
        action: 'create',
        status: 'applied',
        message: null,
        serviceId: webStep.cloudRead!.serviceId,
        deploy: {
          status: 'queued',
          deploymentId: expect.any(String) as string,
        },
      }),
    ]);

    // Google's outputs are saved on the network's row, which is ready; no
    // AWS id is.
    const [network] = await ctx.db
      .select()
      .from(environmentNetwork)
      .where(eq(environmentNetwork.environmentNetworkId, environmentNetworkId));
    expect(network).toMatchObject({
      environmentId,
      cloudAccountId,
      region: REGION,
      status: 'ready',
      networkName: OUTPUTS.network_name,
      subnetName: OUTPUTS.subnet_name,
      ipAddress: OUTPUTS.ip_address,
      urlMapName: OUTPUTS.url_map_name,
      certificateMapName: OUTPUTS.certificate_map_name,
      vpcId: null,
      albDnsName: null,
    });

    // Its state is the one its plan was read against, written with the
    // Google provider; so is the Service's.
    const states = await ctx.db.select().from(infrastructureState);
    expect(
      states.map(
        ({ infrastructureStateId, provider, environmentNetworkId: n }) => ({
          infrastructureStateId,
          provider,
          network: n !== null,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          infrastructureStateId: networkStep.cloudRead!.stateId,
          provider: 'google',
          network: true,
        },
        {
          infrastructureStateId: webStep.cloudRead!.stateId,
          provider: 'google',
          network: false,
        },
      ]),
    );
    expect(states).toHaveLength(2);

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
      },
    });
    const log = await request(http)
      .get(`/deployments/${deploymentId}/logs`)
      .set('Cookie', cookie);
    expect(log.status).toBe(200);
    expect(log.text).toContain(
      `Making the Environment network (${REGION}) in Cloud account Production Google`,
    );
    expect(log.text).toContain('Apply complete!');
    expect(log.text).toContain(
      `its load balancer answers at ${OUTPUTS.ip_address}`,
    );

    // The network applied against its state with its own 2-hour proof, then
    // the Service was planned again keeping its state; nothing reached AWS.
    const tofu = ctx.google.calls.flatMap((call) =>
      call.method === 'plan' || call.method === 'apply' ? [call] : [],
    );
    expect(tofu).toEqual([
      expect.objectContaining({
        method: 'apply',
        kind: 'network',
        stateId: networkStep.cloudRead!.stateId,
        variables: [
          'default_certificate_body',
          'default_certificate_private_key',
        ],
      }),
      expect.objectContaining({
        method: 'plan',
        kind: 'web',
        stateId: webStep.cloudRead!.stateId,
      }),
    ]);
    const { iat, exp } = tofu[0].proof.claims as { iat: number; exp: number };
    expect(exp - iat).toBe(2 * 60 * 60);
    expect(ctx.google.credentialFiles().every((file) => !file.there)).toBe(
      true,
    );
    expect(ctx.cloud.calls).toEqual([]);

    // The console's card: Google's fixed IP and idle cost, no DNS name.
    const networks = await request(http)
      .get(`/environments/${environmentId}/networks`)
      .set('Cookie', cookie);
    expect(networks.status).toBe(200);
    expect(networks.body).toEqual([
      expect.objectContaining({
        environmentNetworkId,
        cloud: 'gcp',
        cloudAccountName: 'Production Google',
        region: REGION,
        status: 'ready',
        albDnsName: null,
        ipAddress: OUTPUTS.ip_address,
        idleCost:
          '$0/month for the network, about $18/month while idle for the load balancer',
        serviceCount: 1,
      }),
    ]);
  });

  it('stops after the network, keeping it, and leaves the Service planned again as the open plan when it no longer makes what was shown', async () => {
    const read = await planned(WEB);
    // Google reads differently once the network is there.
    ctx.google.replayPlanFor('web', 'drift-field');

    await apply(read.planId);
    const row = await settled(read.planId);

    expect(row.status).toBe('partly-applied');
    expect(row.results![0]).toMatchObject({
      action: 'network-create',
      status: 'applied',
    });
    expect(row.results![1]).toMatchObject({
      configName: 'api',
      action: 'create',
      status: 'failed',
    });
    expect(row.results![1].message).toMatch(
      /^Not applied: planned again with the Environment network’s ids, this plan no longer makes what it showed \(api: it .*\)\. Review the new open plan, then apply it$/,
    );

    const [network] = await ctx.db.select().from(environmentNetwork);
    expect(network).toMatchObject({
      status: 'ready',
      ipAddress: OUTPUTS.ip_address,
    });

    const open = await currentPlan();
    expect(open.planId).not.toBe(read.planId);
    expect(open.status).toBe('open');
    expect(open.steps).toHaveLength(1);
    expect(open.steps[0]).toMatchObject({
      action: 'create',
      configName: 'api',
      cloudRead: {
        status: 'read',
        stateId: read.steps[1].cloudRead!.stateId,
        serviceId: read.steps[1].cloudRead!.serviceId,
      },
    });
  });

  it('plans no new network for a second web in the same Environment', async () => {
    const first = await planned(WEB);
    await apply(first.planId);
    expect((await settled(first.planId)).status).toBe('applied');
    ctx.google.calls.length = 0;

    const second = await planned(TWO_WEBS);

    expect(second.steps).toEqual([
      expect.objectContaining({
        action: 'create',
        configName: 'admin',
        cloudRead: expect.objectContaining({ status: 'read' }) as unknown,
      }),
    ]);
    expect(
      ctx.google.calls.flatMap((call) =>
        call.method === 'plan' ? [call.kind] : [],
      ),
    ).toEqual(['web']);
    expect(await ctx.db.select().from(environmentNetwork)).toHaveLength(1);
  });

  it('leaves a network whose apply failed `create-failed` and the Service not applied', async () => {
    const read = await planned(WEB);
    ctx.google.failApplyFor(
      'network',
      'Error creating GlobalAddress: googleapi: Error 403: QUOTA_EXCEEDED',
    );

    await apply(read.planId);
    const row = await settled(read.planId);

    expect(row.status).toBe('partly-applied');
    expect(row.results).toEqual([
      expect.objectContaining({
        action: 'network-create',
        status: 'failed',
        message: expect.stringContaining('QUOTA_EXCEEDED') as string,
      }),
      expect.objectContaining({
        configName: 'api',
        status: 'failed',
        message: 'Not applied: the Environment network was not made',
      }),
    ]);
    const [network] = await ctx.db.select().from(environmentNetwork);
    expect(network).toMatchObject({
      status: 'create-failed',
      ipAddress: null,
    });
  });
});
