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
  infrastructureState,
  plan as planTable,
  tofuStates,
} from '../../src/db/schema';
import type { Plan } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { member } from '../../src/organizations/organizations.schema';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';

jest.setTimeout(240_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

const ONE_WEB = `version: 1
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

/** What `tofu show -json` prints for a plan with nothing to do. */
const NOTHING: TofuShow = {
  format_version: '1.2',
  terraform_version: '1.13.1',
  resource_changes: [],
};

/** Values the stored state holds that no list may ever show. */
const STATE_VALUES = [
  'PARAMETER-SECRET-VALUE',
  'TASK-DEFINITION-VALUE',
  'OUTPUT-SECRET-VALUE',
  'IMMUTABLE',
];

interface Resource {
  type: string;
  awsId: string;
  region: string;
  tags: Record<string, string>;
  findableByTag: boolean;
}

interface ResourceList {
  stateId: string | null;
  readable: boolean;
  failure: string | null;
  resources: Resource[];
  networkCardsUnread: string | null;
}

interface Step {
  action: string;
  configName?: string;
  serviceId?: string;
  cloudRead?: {
    status: 'reading' | 'read' | 'failed';
    reason?: string;
    adopt?: { address: string; arn: string; line: string }[];
    stateId?: string;
    serviceId?: string;
  };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
}

/**
 * Spec "Infrastructure state", ADR-0036 item 3: an operator
 * finds everything Cloudgate made without reading a raw state. A cloud
 * Service and an Environment network each list type, AWS id, region and
 * tags, never a value, and mark what a tag search cannot find. A state
 * Cloudgate cannot read fails every run on it, naming it, and is marked
 * unreadable; Rebuild from the cloud, confirmed by name, discards it and
 * plans an adopt by tag.
 *
 * One cloud web and its Environment network are made by a real Apply
 * against the fake cloud port; no build runs.
 */
describe('Resource lists, unreadable states and Rebuild from the cloud (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  let environmentNetworkId: string;
  let networkStateId: string;
  let applicationId: string;
  let webStateId: string;
  const root = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), 'cloudgate-state-resources-'),
  );
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
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

    await makeWeb();
    ctx.cloud.replayShowFor('network', NOTHING);
    ctx.cloud.replayShowFor('web', NOTHING);
    ctx.cloud.calls.length = 0;
    queue.add.mockClear();
  });

  /** The web and its network, made by a real Apply, its deploy finished. */
  async function makeWeb(): Promise<void> {
    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('web', 'web-create');
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: ONE_WEB });
    expect(saved.status).toBe(201);
    const read = await readPlan();
    networkStateId = read.steps[0].cloudRead!.stateId!;
    ctx.cloud.outputsFor(networkStateId, OUTPUTS);
    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(applied.status).toBe(200);
    const row = await settled(read.planId);
    const step = read.steps.find((one) => one.configName === 'web')!;
    const result = row.results!.find((one) => one.configName === 'web')!;
    expect(result).toMatchObject({ status: 'applied' });
    applicationId = step.cloudRead!.serviceId!;
    webStateId = step.cloudRead!.stateId!;
    environmentNetworkId = row.results!.find(
      (one) => one.action === 'network-create',
    )!.network!.environmentNetworkId;
    await ctx.db
      .update(deployment)
      .set({
        status: 'done',
        cloudRun: {
          kind: 'deploy',
          stateKey: `application:${applicationId}`,
          environmentId,
          touchesNetwork: false,
          architecture: 'arm64',
        },
      })
      .where(
        eq(
          deployment.deploymentId,
          (result.deploy as { deploymentId: string }).deploymentId,
        ),
      );
  }

  async function currentPlan(): Promise<PlanBody> {
    const res = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: PlanBody }).plan;
  }

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

  async function checked(): Promise<PlanBody> {
    const res = await request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie)
      .send({});
    expect(res.status).toBe(201);
    return readPlan();
  }

  const serviceList = (as = cookie) =>
    request(http)
      .get(`/applications/${applicationId}/cloud-resources`)
      .set('Cookie', as);

  const networkList = (as = cookie) =>
    request(http)
      .get(
        `/environments/${environmentId}/networks/${environmentNetworkId}/resources`,
      )
      .set('Cookie', as);

  const rebuildService = (confirmName: string, as = cookie) =>
    request(http)
      .post(`/applications/${applicationId}/state/rebuild`)
      .set('Cookie', as)
      .send({ confirmName });

  const rebuildNetwork = (confirmName: string, as = cookie) =>
    request(http)
      .post(
        `/environments/${environmentId}/networks/${environmentNetworkId}/state/rebuild`,
      )
      .set('Cookie', as)
      .send({ confirmName });

  async function readableOf(stateId: string): Promise<boolean> {
    const [row] = await ctx.db
      .select({ readable: infrastructureState.readable })
      .from(infrastructureState)
      .where(eq(infrastructureState.infrastructureStateId, stateId));
    return row.readable;
  }

  describe('the resource list', () => {
    it("lists a cloud Service's resources by type, AWS id, region and tags, marking what a tag search cannot find, and never a value", async () => {
      ctx.cloud.stateHolds(webStateId, 'web-state');
      ctx.cloud.leaveNetworkInterface(REGION, 'eni-0task', 'sg-0service');

      const res = await serviceList();

      expect(res.status).toBe(200);
      const body = res.body as ResourceList;
      expect(body).toMatchObject({
        stateId: webStateId,
        readable: true,
        failure: null,
        networkCardsUnread: null,
      });
      expect(
        body.resources.map(({ type, awsId, region, findableByTag }) => [
          type,
          awsId,
          region,
          findableByTag,
        ]),
      ).toEqual([
        ['aws_ecr_repository', 'cloudgate-svc_1', REGION, true],
        ['aws_ssm_parameter', '/cloudgate/env_1/svc_1/API_KEY', REGION, true],
        ['aws_ecs_task_definition', 'cloudgate-svc_1', REGION, true],
        ['aws_security_group', 'sg-0service', REGION, true],
        ['aws_iam_role', 'cloudgate-task-svc_1', 'global', false],
        [
          'aws_iam_role_policy_attachment',
          'cloudgate-task-svc_1-20261017000000000000000001',
          'global',
          false,
        ],
        // A network card AWS made for a task, on the Service's group.
        ['aws_network_interface', 'eni-0task', REGION, false],
      ]);
      expect(body.resources[0].tags).toMatchObject({
        'cloudgate:state': 'state-web',
        'cloudgate:address': 'aws_ecr_repository.image',
      });
      for (const resource of body.resources) {
        expect(Object.keys(resource).sort()).toEqual([
          'awsId',
          'findableByTag',
          'region',
          'tags',
          'type',
        ]);
      }
      for (const value of STATE_VALUES) {
        expect(res.text).not.toContain(value);
      }
      // Read with the state's own id and region; nothing planned or applied.
      expect(ctx.cloud.calls).toContainEqual({
        method: 'stateResources',
        stateId: webStateId,
        region: REGION,
      });
      expect(
        ctx.cloud.calls.filter((call) =>
          ['plan', 'apply', 'destroy'].includes(call.method),
        ),
      ).toEqual([]);
    });

    it("lists the Environment network's resources under environment: read", async () => {
      const res = await networkList();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        cloud: 'aws',
        stateId: networkStateId,
        readable: true,
        failure: null,
        resources: [],
        networkCardsUnread: null,
      });
    });

    it('refuses a member without the Service or the Environment, and lets one granted the Service read its list only', async () => {
      const ida = await signUpMember(http, cookie, {
        email: 'ida@example.com',
      });

      expect((await serviceList(ida.cookie)).status).toBe(403);
      expect((await networkList(ida.cookie)).status).toBe(403);
      expect((await rebuildService('web', ida.cookie)).status).toBe(403);
      expect((await rebuildNetwork('production', ida.cookie)).status).toBe(403);

      await ctx.db
        .update(member)
        .set({ accessedServices: [applicationId] })
        .where(eq(member.userId, ida.id));

      expect((await serviceList(ida.cookie)).status).toBe(200);
      expect((await networkList(ida.cookie)).status).toBe(403);
    });

    it('has no route that hands out a raw state', async () => {
      for (const path of [
        `/applications/${applicationId}/state`,
        `/applications/${applicationId}/cloud-resources/state`,
        `/environments/${environmentId}/networks/${environmentNetworkId}/state`,
      ]) {
        expect(
          (await request(http).get(path).set('Cookie', cookie)).status,
        ).toBe(404);
      }
    });
  });

  describe('an unreadable state', () => {
    it('fails the run on it, naming the state, marks it unreadable, and every later run fails before tofu', async () => {
      ctx.cloud.unreadableState(webStateId);

      const read = await checked();
      const step = read.steps.find((one) => one.serviceId === applicationId)!;

      expect(step.cloudRead).toMatchObject({ status: 'failed' });
      expect(step.cloudRead!.reason).toContain(webStateId);
      expect(await readableOf(webStateId)).toBe(false);

      // The list says so, and offers Rebuild.
      const listed = await serviceList();
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({
        stateId: webStateId,
        readable: false,
        resources: [],
      });
      expect((listed.body as ResourceList).failure).toContain(webStateId);

      // Never written over: the next read refuses without running tofu.
      ctx.cloud.calls.length = 0;
      const again = await checked();
      expect(
        again.steps.find((one) => one.serviceId === applicationId)!.cloudRead!
          .reason,
      ).toContain('Rebuild from the cloud');
      expect(
        ctx.cloud.calls.filter(
          (call) => 'stateId' in call && call.stateId === webStateId,
        ),
      ).toEqual([]);
    });

    it("shows on the Environment's network card", async () => {
      await ctx.db
        .update(infrastructureState)
        .set({ readable: false })
        .where(eq(infrastructureState.infrastructureStateId, networkStateId));

      const res = await request(http)
        .get(`/environments/${environmentId}/networks`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        expect.objectContaining({ environmentNetworkId, stateReadable: false }),
      ]);
    });
  });

  describe('Rebuild from the cloud', () => {
    const repositoryArn = `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/cloudgate/svc_1`;

    async function lose(stateId: string): Promise<void> {
      await ctx.db
        .insert(tofuStates)
        .values({ name: stateId, data: 'unreadable ciphertext' });
      await ctx.db
        .update(infrastructureState)
        .set({ readable: false, tofuVersion: '1.13.1' })
        .where(eq(infrastructureState.infrastructureStateId, stateId));
    }

    it('refuses a state Cloudgate can read, discarding nothing', async () => {
      const res = await rebuildService('web');

      expect(res.status).toBe(409);
      expect(await readableOf(webStateId)).toBe(true);
    });

    it("refuses a name that is not the Service's", async () => {
      await lose(webStateId);

      const res = await rebuildService('api');

      expect(res.status).toBe(400);
      expect(await readableOf(webStateId)).toBe(false);
    });

    it('discards the state and produces a plan that adopts by tag what the state held', async () => {
      await lose(webStateId);
      // Against an empty state, the plan makes everything; the tag search
      // finds what is there under the state's id.
      ctx.cloud.replayPlan('web-create', webStateId);
      ctx.cloud.leaveTagged(REGION, repositoryArn, {
        'cloudgate:cloud-account': cloudAccountId,
        'cloudgate:environment': environmentId,
        'cloudgate:state': webStateId,
        'cloudgate:address': 'aws_ecr_repository.service',
      });
      // No tag search sees a role: it is found by its name (ADR-0036 §6).
      const roleArn = `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-svc_1`;
      ctx.cloud.leaveIamRole('cloudgate-svc_1', roleArn);

      const res = await rebuildService('web');

      expect(res.status).toBe(200);
      expect((res.body as PlanBody).status).toBe('open');
      const [state] = await ctx.db
        .select()
        .from(infrastructureState)
        .where(eq(infrastructureState.infrastructureStateId, webStateId));
      expect(state).toMatchObject({
        readable: true,
        tofuVersion: null,
        providerVersion: null,
      });
      expect(
        await ctx.db
          .select()
          .from(tofuStates)
          .where(eq(tofuStates.name, webStateId)),
      ).toEqual([]);

      const read = await readPlan();
      const step = read.steps.find((one) => one.serviceId === applicationId)!;
      expect(step.cloudRead).toMatchObject({
        status: 'read',
        stateId: webStateId,
      });
      // The repository by tag, its lifecycle policy with it, and the task
      // role by name: nothing the state held is made twice.
      expect(
        [...(step.cloudRead!.adopt ?? [])].sort((a, b) =>
          a.address.localeCompare(b.address),
        ),
      ).toEqual([
        expect.objectContaining({
          address: 'aws_ecr_lifecycle_policy.service',
          arn: repositoryArn,
        }),
        expect.objectContaining({
          address: 'aws_ecr_repository.service',
          arn: repositoryArn,
        }),
        expect.objectContaining({ address: 'aws_iam_role.task', arn: roleArn }),
      ]);
    });

    it("rebuilds an Environment network's state, confirmed by the Environment's name", async () => {
      await lose(networkStateId);

      expect((await rebuildNetwork('web')).status).toBe(400);
      const res = await rebuildNetwork('production');

      expect(res.status).toBe(200);
      expect(await readableOf(networkStateId)).toBe(true);
      const read = await readPlan();
      expect(
        read.steps.find((one) => one.action === 'network-change')!.cloudRead,
      ).toMatchObject({ status: 'read', stateId: networkStateId });
    });
  });
});
