// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../../utils/hosted-mode';
useHostedMode();

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { subscription } from '../../../src/cloud/billing/billing.schema';
import {
  application,
  cloudAccount,
  environment,
  postgres,
  server as serverTable,
} from '../../../src/db/schema';
import type { DeployTarget } from '../../../src/environments/deploy-target';
import { DEPLOYMENT_QUEUE } from '../../../src/deployment-queue/queue.port';
import { InstanceMode } from '../../../src/instance-mode/instance-mode.service';
import { MailService } from '../../../src/mail/mail.service';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../../utils/test-app';

jest.setTimeout(180_000);

const ACCOUNT = '123456789012';
const OTHER_ACCOUNT = '210987654321';
const REGION = 'eu-central-1';
const KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

const WEB = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
`;

const CHOOSE_A_PLAN =
  'Choose a plan to add a Cloud Environment. Starter and Business each include 3 Servers and 3 Cloud Environments; choose one under Settings > Billing.';

const allowanceFull = (count: number) =>
  `This Organization has ${count} Cloud Environments, all its plan allows. Buy an Add-on for one more Server and one more Cloud Environment under Settings > Billing.`;

interface Step {
  action: string;
  cloudRead?: { status: string };
}

interface PlanBody {
  planId: string;
  steps: Step[];
}

/**
 * The Cloud Environment count (ADR-0048): an Environment counts once
 * when its Deploy target is a Cloud account or it holds a Service in one,
 * however many accounts and regions it uses, and stops counting once neither
 * is true or it is deleted. Giving a not-yet-counted Environment a cloud
 * Deploy target, and a Project config Apply that would put the first cloud
 * Service into an Environment beyond the count, go through the same
 * allowance check as a Server create. Connecting a Cloud account is never
 * counted. Self-hosted counterparts close the file.
 */
describe('The Cloud Environment count (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let otherAccountId: string;
  const mail = new MailRecorder();
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        { provide: MailService, useValue: mail },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await ctx.resetDb();
    mail.clear();
    await openHostedSignUp(ctx.db);
    const customer = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    cookie = customer.cookie;
    organizationId = customer.organizationId;
    projectId = await newProject('shop');
    cloudAccountId = await givenCloudAccount('Production AWS', ACCOUNT);
    otherAccountId = await givenCloudAccount('Second AWS', OTHER_ACCOUNT);
    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('web', 'web-create');
    ctx.cloud.calls.length = 0;
  });

  const givenSelfHostedInstance = () =>
    jest
      .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
      .mockReturnValue(false);

  const inCloud = (accountId: string, region = REGION): DeployTarget => ({
    kind: 'cloud',
    cloudAccountId: accountId,
    region,
  });

  async function newProject(name: string): Promise<string> {
    const res = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name });
    expect(res.status).toBe(201);
    return (res.body as { projectId: string }).projectId;
  }

  /** Arrangement only: a Cloud account checked at the hosted version. */
  async function givenCloudAccount(name: string, cloudId: string) {
    const [row] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name,
        cloud: 'aws',
        cloudId,
        accessKeyId: KEY,
        secretAccessKey: SECRET,
        deployRoleArn: `arn:aws:iam::${cloudId}:role/cloudgate-deploy`,
        taskExecutionRoleArn: `arn:aws:iam::${cloudId}:role/cloudgate-task-execution`,
        externalId: `external-id-${cloudId}`,
        policyVersion: 3,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    return row.cloudAccountId;
  }

  /** Arrangement only: the Hosted plan with `addOns` Add-ons, as the webhook stores it. */
  async function givenPlan(addOns: number) {
    await ctx.db.insert(subscription).values({
      organizationId,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      plan: 'starter',
      status: 'active',
      addOns,
    });
  }

  /** Arrangement only: one of the Organization's Servers. */
  async function givenServer(): Promise<string> {
    const [row] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'box-1',
        ipAddress: '203.0.113.10',
        port: 22,
        organizationId,
      })
      .returning();
    return row.serverId;
  }

  /**
   * Arrangement only: an Environment straight to its row, as one made before
   * the count existed would be (the API now checks the count on the way in).
   */
  async function environmentRow(
    name: string,
    deployTarget: DeployTarget,
    inProject = projectId,
  ): Promise<string> {
    const [row] = await ctx.db
      .insert(environment)
      .values({ name, projectId: inProject, deployTarget })
      .returning();
    return row.environmentId;
  }

  /** Arrangement only: a cloud `web` in the Environment, as an Apply leaves it. */
  async function cloudWeb(
    environmentId: string,
    accountId: string,
    region = REGION,
  ) {
    await ctx.db.insert(application).values({
      name: `web-${region}`,
      environmentId,
      configName: `web-${region}`,
      configKind: 'web',
      sourceType: 'docker',
      dockerImage: 'nginx',
      cloudAccountId: accountId,
      region,
      replicas: 1,
      applicationStatus: 'done',
    });
  }

  /** Arrangement only: a postgres on RDS in the Environment. */
  async function rdsPostgres(environmentId: string, accountId: string) {
    await ctx.db.insert(postgres).values({
      name: 'pg-1',
      configName: 'pg-1',
      environmentId,
      databaseName: 'pg_1',
      databaseUser: 'pg_1',
      databasePassword: 'super-secret-database-password',
      cloudAccountId: accountId,
      region: 'us-east-1',
      instanceClass: null,
    });
  }

  async function usage(): Promise<{
    servers: number;
    cloudEnvironments: number;
  }> {
    const res = await request(http)
      .get('/billing/subscription')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (
      res.body as { usage: { servers: number; cloudEnvironments: number } }
    ).usage;
  }

  const createEnvironment = (
    name: string,
    deployTarget: DeployTarget,
    inProject = projectId,
  ) =>
    request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ projectId: inProject, name, deployTarget });

  const retarget = (environmentId: string, deployTarget: DeployTarget) =>
    request(http)
      .patch(`/environments/${environmentId}`)
      .set('Cookie', cookie)
      .send({ deployTarget });

  async function currentPlan(environmentId: string): Promise<PlanBody> {
    const res = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: PlanBody }).plan;
  }

  /** Saves {@link WEB} into the Project and waits for its plan's AWS read. */
  async function plannedWeb(
    environmentId: string,
    inProject: string,
  ): Promise<PlanBody> {
    const saved = await request(http)
      .post(`/projects/${inProject}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: WEB });
    expect(saved.status).toBe(201);
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = await currentPlan(environmentId);
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading AWS');
  }

  const apply = (environmentId: string, planId: string) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

  describe('the count', () => {
    it('counts an Environment once across several Cloud accounts and regions, and never one on a Server', async () => {
      await givenPlan(0);
      const serverId = await givenServer();
      const created = await createEnvironment(
        'production',
        inCloud(cloudAccountId),
      );
      expect(created.status).toBe(201);
      const productionId = (created.body as { environmentId: string })
        .environmentId;
      // Its target's account and region, a second region, and a second account.
      await cloudWeb(productionId, cloudAccountId);
      await cloudWeb(productionId, cloudAccountId, 'eu-west-1');
      await rdsPostgres(productionId, otherAccountId);
      expect(
        (await createEnvironment('staging', { kind: 'server', serverId }))
          .status,
      ).toBe(201);

      expect(await usage()).toEqual({ servers: 1, cloudEnvironments: 1 });
    });

    it('keeps counting a retargeted Environment while it holds a cloud Service, and stops once it is emptied', async () => {
      await givenPlan(0);
      const serverId = await givenServer();
      const environmentId = await environmentRow(
        'production',
        inCloud(cloudAccountId),
      );
      await cloudWeb(environmentId, cloudAccountId);
      await rdsPostgres(environmentId, otherAccountId);
      expect((await usage()).cloudEnvironments).toBe(1);

      const moved = await retarget(environmentId, { kind: 'server', serverId });
      expect(moved.status).toBe(200);
      expect((await usage()).cloudEnvironments).toBe(1);

      await ctx.db
        .delete(application)
        .where(eq(application.environmentId, environmentId));
      expect((await usage()).cloudEnvironments).toBe(1);
      await ctx.db
        .delete(postgres)
        .where(eq(postgres.environmentId, environmentId));
      expect((await usage()).cloudEnvironments).toBe(0);
    });

    it('stops counting a deleted Environment', async () => {
      await givenPlan(0);
      const created = await createEnvironment(
        'preview',
        inCloud(cloudAccountId),
      );
      expect(created.status).toBe(201);
      expect((await usage()).cloudEnvironments).toBe(1);

      const removed = await request(http)
        .delete(
          `/environments/${(created.body as { environmentId: string }).environmentId}`,
        )
        .set('Cookie', cookie);
      expect(removed.status).toBeLessThan(300);
      expect((await usage()).cloudEnvironments).toBe(0);
    });
  });

  describe('a cloud Deploy target', () => {
    it('is refused with "choose a plan" when the Organization has none, and makes no Environment', async () => {
      const refused = await createEnvironment(
        'production',
        inCloud(cloudAccountId),
      );
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'PLAN_REQUIRED',
        message: CHOOSE_A_PLAN,
      });

      const serverId = await givenServer();
      const onServer = await environmentRow('staging', {
        kind: 'server',
        serverId,
      });
      const switched = await retarget(onServer, inCloud(cloudAccountId));
      expect(switched.status).toBe(403);
      expect(switched.body).toMatchObject({ code: 'PLAN_REQUIRED' });

      const rows = await ctx.db.select().from(environment);
      expect(rows.map((row) => row.deployTarget)).toEqual([
        { kind: 'server', serverId },
      ]);
    });

    it('is refused naming the Add-on once the count is full, for a new Environment and a switch alike', async () => {
      await givenPlan(0);
      for (const name of ['one', 'two', 'three']) {
        expect(
          (await createEnvironment(name, inCloud(cloudAccountId))).status,
        ).toBe(201);
      }

      const refused = await createEnvironment('four', inCloud(otherAccountId));
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        statusCode: 403,
        code: 'ALLOWANCE_FULL',
        message: allowanceFull(3),
      });

      const serverId = await givenServer();
      const onServer = await environmentRow('staging', {
        kind: 'server',
        serverId,
      });
      const switched = await retarget(onServer, inCloud(cloudAccountId));
      expect(switched.status).toBe(403);
      expect(switched.body).toMatchObject({
        code: 'ALLOWANCE_FULL',
        message: allowanceFull(3),
      });
      const [kept] = await ctx.db
        .select()
        .from(environment)
        .where(eq(environment.environmentId, onServer));
      expect(kept.deployTarget).toEqual({ kind: 'server', serverId });
    });

    it('is never refused for an Environment that already counts: another account or region, or a cloud Service still in it', async () => {
      await givenPlan(0);
      const serverId = await givenServer();
      const ids: string[] = [];
      for (const name of ['one', 'two', 'three']) {
        const created = await createEnvironment(name, inCloud(cloudAccountId));
        expect(created.status).toBe(201);
        ids.push((created.body as { environmentId: string }).environmentId);
      }

      // Another account and region for one that counts by its target.
      const moved = await retarget(
        ids[0],
        inCloud(otherAccountId, 'eu-west-1'),
      );
      expect(moved.status).toBe(200);

      // One moved to a Server keeps counting by its cloud Service, and may
      // move back.
      await cloudWeb(ids[1], cloudAccountId);
      expect(
        (await retarget(ids[1], { kind: 'server', serverId })).status,
      ).toBe(200);
      expect((await retarget(ids[1], inCloud(cloudAccountId))).status).toBe(
        200,
      );
      expect((await usage()).cloudEnvironments).toBe(3);
    });

    it('fits again once an Add-on raises the count', async () => {
      await givenPlan(1);
      for (const name of ['one', 'two', 'three', 'four']) {
        expect(
          (await createEnvironment(name, inCloud(cloudAccountId))).status,
        ).toBe(201);
      }
      expect(
        (await createEnvironment('five', inCloud(cloudAccountId))).body,
      ).toMatchObject({ code: 'ALLOWANCE_FULL', message: allowanceFull(4) });
    });
  });

  describe('a Project config Apply', () => {
    /**
     * Four Environments targeting a cloud from before the count, in their own
     * Project each: three already hold a cloud Service, the last holds none.
     */
    async function overTheCount(holding: number): Promise<string> {
      for (let index = 0; index < 3; index++) {
        const elsewhere = await newProject(`other-${index}`);
        const id = await environmentRow(
          `env-${index}`,
          inCloud(cloudAccountId),
          elsewhere,
        );
        if (index < holding) await cloudWeb(id, cloudAccountId);
      }
      return environmentRow('production', inCloud(cloudAccountId));
    }

    it('is refused naming the Add-on when it would put a cloud Service into an Environment beyond the count', async () => {
      await givenPlan(0);
      const environmentId = await overTheCount(3);
      const planned = await plannedWeb(environmentId, projectId);
      expect(planned.steps.map((step) => step.action)).toContain('create');

      const refused = await apply(environmentId, planned.planId);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'ALLOWANCE_FULL',
        message: allowanceFull(3),
      });
      // Nothing was made, and the plan is still open.
      expect(
        await ctx.db
          .select()
          .from(application)
          .where(eq(application.environmentId, environmentId)),
      ).toEqual([]);
      expect((await currentPlan(environmentId)).planId).toBe(planned.planId);
    });

    it('is refused with "choose a plan" without one', async () => {
      const environmentId = await overTheCount(0);
      const planned = await plannedWeb(environmentId, projectId);
      const refused = await apply(environmentId, planned.planId);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'PLAN_REQUIRED' });
    });

    it('is not refused while the Environments holding cloud Services leave room', async () => {
      await givenPlan(0);
      const environmentId = await overTheCount(2);
      const planned = await plannedWeb(environmentId, projectId);
      const applied = await apply(environmentId, planned.planId);
      expect(applied.status).toBe(200);
    });
  });

  describe('a Cloud account', () => {
    it('is connected with no plan, and beyond any count', async () => {
      for (const cloudId of ['111111111111', '222222222222']) {
        const setup = await request(http)
          .post('/cloud-accounts/setup')
          .set('Cookie', cookie)
          .send({ cloudId });
        expect(setup.status).toBe(200);
        const res = await request(http)
          .post('/cloud-accounts')
          .set('Cookie', cookie)
          .send({
            setupToken: (setup.body as { setupToken: string }).setupToken,
            name: `AWS ${cloudId}`,
            cloudId,
            accessKeyId: KEY,
            secretAccessKey: SECRET,
            deployRoleArn: `arn:aws:iam::${cloudId}:role/cloudgate-deploy`,
            taskExecutionRoleArn: `arn:aws:iam::${cloudId}:role/cloudgate-task-execution`,
          });
        expect(res.status).toBe(201);
      }
      expect((await usage()).cloudEnvironments).toBe(0);
    });
  });

  describe('a Self-hosted instance, where nothing is metered', () => {
    it('takes a cloud Deploy target with no plan', async () => {
      givenSelfHostedInstance();
      for (const name of ['one', 'two', 'three', 'four']) {
        expect(
          (await createEnvironment(name, inCloud(cloudAccountId))).status,
        ).toBe(201);
      }
    });

    it('applies a cloud Service into any Environment', async () => {
      const environmentId = await overTheCount();
      givenSelfHostedInstance();
      const planned = await plannedWeb(environmentId, projectId);
      expect((await apply(environmentId, planned.planId)).status).toBe(200);
    });

    async function overTheCount(): Promise<string> {
      for (let index = 0; index < 3; index++) {
        const elsewhere = await newProject(`other-${index}`);
        const id = await environmentRow(
          `env-${index}`,
          inCloud(cloudAccountId),
          elsewhere,
        );
        await cloudWeb(id, cloudAccountId);
      }
      return environmentRow('production', inCloud(cloudAccountId));
    }
  });
});
