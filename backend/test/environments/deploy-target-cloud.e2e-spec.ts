import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  cloudAccount,
  deployment,
  environment as environmentTable,
  licenseKey,
  member,
  mysql,
  organizationRole,
  plan as planTable,
  server as serverTable,
} from '../../src/db/schema';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const DEPLOY_ROLE = `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy`;

class ListQueue implements QueuePort {
  jobs: QueuedJob[] = [];
  private next = 0;

  add(data: DeploymentJob): Promise<QueuedJob> {
    const job: QueuedJob = { id: `job-${++this.next}`, data, state: 'waiting' };
    this.jobs.push(job);
    return Promise.resolve({ ...job });
  }

  getJobs(states?: JobState[]): Promise<QueuedJob[]> {
    return Promise.resolve(
      this.jobs.filter((job) => !states || states.includes(job.state)),
    );
  }

  cancel(): Promise<boolean> {
    return Promise.resolve(false);
  }

  clearWaiting(): Promise<QueuedJob[]> {
    return Promise.resolve([]);
  }
}

const messageOf = (res: request.Response) =>
  (res.body as { message: string }).message;
const idOf = (res: request.Response) =>
  (res.body as { environmentId: string }).environmentId;

/**
 * An Environment's Deploy target can be a Cloud account plus a region.
 * Choosing one needs `cloudAccount: read` on it and runs the region check
 * through the cloud port (`ctx.cloud`, the in-memory fake); a plan there
 * refuses what a Cloud account cannot make yet, and a plan made before a
 * switch is refused at Apply. The Cloud account cannot be deleted while a
 * Deploy target names it.
 */
describe('A Deploy target in a Cloud account (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  const queue = new ListQueue();

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
    queue.jobs = [];
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
  });

  /** A connected Cloud account, as the connect flow would have saved it. */
  async function addCloudAccount(
    name = 'Production AWS',
    inOrganization = organizationId,
  ): Promise<string> {
    const [row] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId: inOrganization,
        name,
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
    return row.cloudAccountId;
  }

  const onCloud = (cloudAccountId: string, region = 'eu-west-1') => ({
    kind: 'cloud',
    cloudAccountId,
    region,
  });

  const createEnvironment = (body: Record<string, unknown>, as = cookie) =>
    request(http)
      .post('/environments')
      .set('Cookie', as)
      .send({ projectId, ...body });

  const patchEnvironment = (
    environmentId: string,
    body: Record<string, unknown>,
    as = cookie,
  ) =>
    request(http)
      .patch(`/environments/${environmentId}`)
      .set('Cookie', as)
      .send(body);

  async function targetOf(environmentId: string) {
    const [row] = await ctx.db
      .select({ deployTarget: environmentTable.deployTarget })
      .from(environmentTable)
      .where(eq(environmentTable.environmentId, environmentId));
    return row.deployTarget;
  }

  /** A member holding only the custom role `permission` grants. */
  async function memberWith(permission: Record<string, string[]>) {
    const ida = await signUpMember(http, cookie);
    await ctx.db.insert(licenseKey).values({
      organizationId,
      key: 'test-license-key',
      status: 'active',
      enableEnterpriseFeatures: true,
    });
    await ctx.db.insert(organizationRole).values({
      organizationId,
      role: 'environment-editor',
      permission,
    });
    await ctx.db
      .update(member)
      .set({ role: 'environment-editor', accessedProjects: [projectId] })
      .where(
        and(
          eq(member.userId, ida.id),
          eq(member.organizationId, organizationId),
        ),
      );
    return ida;
  }

  describe('choosing a Cloud account and region', () => {
    it('stores the target, runs the region check in that region, and moves nothing', async () => {
      const cloudAccountId = await addCloudAccount();
      const created = await createEnvironment({ name: 'production' });
      const environmentId = idOf(created);
      const web = await request(http)
        .post('/applications')
        .set('Cookie', cookie)
        .send({ name: 'web', environmentId });
      expect(web.status).toBe(201);
      const deploymentsBefore = await ctx.db.select().from(deployment);

      const changed = await patchEnvironment(environmentId, {
        deployTarget: onCloud(cloudAccountId),
      });

      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({
        deployTarget: onCloud(cloudAccountId),
        warnings: [],
      });
      expect(await targetOf(environmentId)).toEqual(onCloud(cloudAccountId));

      // The region check: the role taken on with the external id, every
      // simulation in eu-west-1, the network creates dry-run there with the
      // Cloud account's tag, and the VPCs counted.
      const methods = ctx.cloud.calls.map((call) => call.method);
      expect(methods[0]).toBe('assumeRole');
      expect(ctx.cloud.calls[0]).toMatchObject({
        roleArn: DEPLOY_ROLE,
        externalId: 'external-id-made-by-cloudgate',
      });
      const simulations = ctx.cloud.calls.filter(
        (call) => call.method === 'simulatePrincipalPolicy',
      );
      expect(simulations.length).toBeGreaterThan(0);
      for (const call of simulations) {
        expect(call.context).toContainEqual({
          key: 'aws:RequestedRegion',
          values: ['eu-west-1'],
          type: 'string',
        });
      }
      expect(
        ctx.cloud.calls.filter((call) => call.method === 'ec2DryRun'),
      ).toEqual(
        ['CreateVpc', 'CreateInternetGateway'].map((action) => ({
          method: 'ec2DryRun',
          region: 'eu-west-1',
          action,
          tags: { 'cloudgate:cloud-account': cloudAccountId },
        })),
      );
      expect(methods.at(-1)).toBe('countVpcs');

      // Nothing moved and nothing was queued.
      const services = await ctx.db
        .select({ serverId: application.serverId })
        .from(application)
        .where(eq(application.environmentId, environmentId));
      expect(services).toEqual([{ serverId: null }]);
      expect(await ctx.db.select().from(deployment)).toEqual(deploymentsBefore);
      expect(queue.jobs).toEqual([]);

      // To another region, then back off the cloud: still nothing queued.
      const otherRegion = await patchEnvironment(environmentId, {
        deployTarget: onCloud(cloudAccountId, 'us-east-2'),
      });
      expect(otherRegion.status).toBe(200);
      const back = await patchEnvironment(environmentId, {
        deployTarget: { kind: 'platform-host' },
      });
      expect(back.status).toBe(200);
      expect(await targetOf(environmentId)).toEqual({ kind: 'platform-host' });
      expect(queue.jobs).toEqual([]);
      expect(await ctx.db.select().from(deployment)).toEqual(deploymentsBefore);
    });

    it('takes a Cloud account on a new Environment too', async () => {
      const cloudAccountId = await addCloudAccount();

      const created = await createEnvironment({
        name: 'production',
        deployTarget: onCloud(cloudAccountId),
      });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        deployTarget: onCloud(cloudAccountId),
        warnings: [],
      });
    });

    it("refuses a region AWS does not have, by the Cloud account's cloud, calling no AWS", async () => {
      const cloudAccountId = await addCloudAccount();

      const refused = await createEnvironment({
        name: 'production',
        deployTarget: onCloud(cloudAccountId, 'eu-west1'),
      });

      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(
        'eu-west1 is not an AWS region Cloudgate deploys to',
      );
      expect(ctx.cloud.calls).toEqual([]);
    });

    it("answers another Organization's Cloud account as not found, calling no AWS", async () => {
      const mallory = await secondOrganizationOwner(http, ctx.db, cookie);
      const theirs = await addCloudAccount('Their AWS', mallory.organizationId);

      const refused = await createEnvironment({
        name: 'production',
        deployTarget: onCloud(theirs),
      });

      expect(refused.status).toBe(404);
      expect(messageOf(refused)).toBe('Cloud account not found');
      expect(ctx.cloud.calls).toEqual([]);
    });

    it('needs cloudAccount: read beside environment: create — without it, not found', async () => {
      const cloudAccountId = await addCloudAccount();
      const ida = await memberWith({
        environment: ['read', 'create', 'update'],
      });

      const refused = await createEnvironment(
        { name: 'production', deployTarget: onCloud(cloudAccountId) },
        ida.cookie,
      );

      expect(refused.status).toBe(404);
      expect(messageOf(refused)).toBe('Cloud account not found');
      expect(ctx.cloud.calls).toEqual([]);
      expect(await ctx.db.select().from(environmentTable)).toEqual([]);
    });

    it('lets a custom role holding cloudAccount: read choose it', async () => {
      const cloudAccountId = await addCloudAccount();
      const ida = await memberWith({
        environment: ['read', 'create', 'update'],
        cloudAccount: ['read'],
      });

      const created = await createEnvironment(
        { name: 'production', deployTarget: onCloud(cloudAccountId) },
        ida.cookie,
      );

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        deployTarget: onCloud(cloudAccountId),
      });
    });

    it('refuses when the simulation denies actions in the region, naming the region and each action, and keeps the old target', async () => {
      const cloudAccountId = await addCloudAccount();
      const created = await createEnvironment({ name: 'production' });
      ctx.cloud.denyActions(['ecs:CreateService', 'ec2:CreateVpc']);

      const refused = await patchEnvironment(idOf(created), {
        deployTarget: onCloud(cloudAccountId, 'ap-south-1'),
      });

      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        message:
          'The deploy role cannot work in ap-south-1: AWS denies ecs:CreateService, ec2:CreateVpc. ' +
          'Update the role from the setup template, or allow the region in the AWS account',
      });
      expect(await targetOf(idOf(created))).toEqual({ kind: 'platform-host' });
    });

    it('refuses when a dry run is refused — an SCP or a region not enabled — naming each action', async () => {
      const cloudAccountId = await addCloudAccount();
      ctx.cloud.refuseDryRuns(['CreateVpc']);
      ctx.cloud.refuseDryRuns(
        ['CreateInternetGateway'],
        'OptInRequired',
        'You are not subscribed to this service.',
      );

      const refused = await createEnvironment({
        name: 'production',
        deployTarget: onCloud(cloudAccountId, 'me-south-1'),
      });

      expect(refused.status).toBe(400);
      expect(messageOf(refused)).toBe(
        'The deploy role cannot work in me-south-1: AWS denies ec2:CreateVpc, ec2:CreateInternetGateway. ' +
          'Update the role from the setup template, or allow the region in the AWS account',
      );
      expect(await ctx.db.select().from(environmentTable)).toEqual([]);
    });

    it('warns, and still saves, when the account is near 5 VPCs in the region', async () => {
      const cloudAccountId = await addCloudAccount();
      ctx.cloud.vpcCountIs(4);

      const near = await createEnvironment({
        name: 'production',
        deployTarget: onCloud(cloudAccountId),
      });

      expect(near.status).toBe(201);
      expect((near.body as { warnings: string[] }).warnings).toEqual([
        "The AWS account has 4 VPCs in eu-west-1, and AWS allows 5 per region unless the quota is raised. The Environment network's VPC takes the last one",
      ]);

      ctx.cloud.vpcCountIs(5);
      const full = await patchEnvironment(idOf(near), {
        deployTarget: onCloud(cloudAccountId),
      });
      expect(full.status).toBe(200);
      expect((full.body as { warnings: string[] }).warnings).toEqual([
        "The AWS account has 5 VPCs in eu-west-1, and AWS allows 5 per region unless the quota is raised. The Environment network's VPC will not fit: raise the quota or remove a VPC before the first deploy here",
      ]);
    });
  });

  describe('plans', () => {
    const save = (text: string) =>
      request(http)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({ text });

    it('plans the cloud kinds in the Cloud account and creates nothing on a Server, and a Server Environment of the Project plans them there (a worker on ECS, a web-private, a cron, a mysql on RDS)', async () => {
      const [server] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'worker-1',
          ipAddress: '10.0.0.5',
          port: 22,
          organizationId,
          serverType: 'deploy',
        })
        .returning();
      await createEnvironment({
        name: 'staging',
        deployTarget: { kind: 'server', serverId: server.serverId },
      });
      const cloudAccountId = await addCloudAccount();
      const production = await createEnvironment({
        name: 'production',
        deployTarget: onCloud(cloudAccountId),
      });
      const text = [
        'version: 1',
        'services:',
        '  shop-db:',
        '    kind: mysql',
        '  api:',
        '    kind: web-private',
        '    port: 4000',
        '    source: { image: nginx:1.27 }',
        '  report:',
        '    kind: cron',
        '    command: node dist/report.js',
        '    schedule: "0 3 * * *"',
        '    source: { image: acme/reports:1 }',
        '',
      ].join('\n');
      const planned = await save(text);

      expect(planned.status).toBe(201);
      expect(await ctx.db.select().from(application)).toEqual([]);
      expect(await ctx.db.select().from(mysql)).toEqual([]);
      expect(queue.jobs).toEqual([]);

      // The same entries, once production is on the Server too, plan there.
      await patchEnvironment(idOf(production), {
        deployTarget: { kind: 'server', serverId: server.serverId },
      });
      const saved = await save(text);

      expect(saved.status).toBe(201);
      const { plans } = saved.body as {
        plans: { steps: { action: string; configName: string }[] }[];
      };
      expect(plans).toHaveLength(2);
      for (const { steps } of plans) {
        expect(
          steps.map((step) => `${step.action} ${step.configName}`),
        ).toEqual(['create shop-db', 'create api', 'create report']);
      }
    });

    it('plans creating a web there, reading AWS, and queues nothing', async () => {
      const cloudAccountId = await addCloudAccount();
      await createEnvironment({
        name: 'production',
        deployTarget: onCloud(cloudAccountId),
      });

      const saved = await save(
        'version: 1\nservices:\n  web:\n    kind: web\n    source: { image: nginx }\n',
      );

      expect(saved.status).toBe(201);
      const { steps } = (
        saved.body as { plans: { steps: { action: string }[] }[] }
      ).plans[0];
      expect(steps.map((step) => step.action)).toEqual([
        'network-create',
        'create',
      ]);
      expect(queue.jobs).toEqual([]);
    });

    it('refuses at Apply a plan made before a Deploy target switch, saying so', async () => {
      const cloudAccountId = await addCloudAccount();
      const created = await createEnvironment({ name: 'production' });
      const environmentId = idOf(created);
      const saved = await save(
        'version: 1\nservices:\n  db:\n    kind: postgres\n',
      );
      expect(saved.status).toBe(201);
      const { planId } = (saved.body as { plans: { planId: string }[] })
        .plans[0];

      // Planned for the platform host; the switch makes it name the old place.
      const switched = await patchEnvironment(environmentId, {
        deployTarget: onCloud(cloudAccountId),
      });
      expect(switched.status).toBe(200);

      const refused = await request(http)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId });

      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'PLAN_STALE',
        message:
          "This plan no longer describes this Environment: the Environment's Deploy target changed since it was made, from the platform host to a Cloud account in eu-west-1. Check for changes, then apply the new plan",
      });
      const [row] = await ctx.db
        .select({ status: planTable.status })
        .from(planTable)
        .where(eq(planTable.planId, planId));
      expect(row.status).toBe('open');
      expect(queue.jobs).toEqual([]);
    });

    it('refuses at Apply a plan made before a switch to another Server', async () => {
      const [first, second] = await ctx.db
        .insert(serverTable)
        .values(
          ['worker-1', 'worker-2'].map((name) => ({
            name,
            ipAddress: '10.0.0.5',
            port: 22,
            organizationId,
            serverType: 'deploy' as const,
          })),
        )
        .returning();
      const created = await createEnvironment({
        name: 'production',
        deployTarget: { kind: 'server', serverId: first.serverId },
      });
      const saved = await save(
        'version: 1\nservices:\n  db:\n    kind: postgres\n',
      );
      const { planId } = (saved.body as { plans: { planId: string }[] })
        .plans[0];
      await patchEnvironment(idOf(created), {
        deployTarget: { kind: 'server', serverId: second.serverId },
      });

      const refused = await request(http)
        .post(`/environments/${idOf(created)}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId });

      expect(refused.status).toBe(409);
      expect(messageOf(refused)).toContain(
        "the Environment's Deploy target changed since it was made, from a Server to another Server",
      );
    });
  });

  describe('deleting the Cloud account', () => {
    it('is refused while a Deploy target uses it, naming each Environment, and allowed once none does', async () => {
      const cloudAccountId = await addCloudAccount();
      const production = await createEnvironment({
        name: 'production',
        deployTarget: onCloud(cloudAccountId),
      });
      const staging = await createEnvironment({
        name: 'staging',
        deployTarget: onCloud(cloudAccountId, 'us-east-1'),
      });

      const refused = await request(http)
        .delete(`/cloud-accounts/${cloudAccountId}`)
        .set('Cookie', cookie);

      expect(refused.status).toBe(409);
      expect(messageOf(refused)).toBe(
        'Cloud account Production AWS is still used by 2 Environments (shop / production, shop / staging) as their Deploy target',
      );
      expect(await ctx.db.select().from(cloudAccount)).toHaveLength(1);

      for (const environment of [production, staging]) {
        await patchEnvironment(idOf(environment), {
          deployTarget: { kind: 'platform-host' },
        });
      }
      const deleted = await request(http)
        .delete(`/cloud-accounts/${cloudAccountId}`)
        .set('Cookie', cookie);
      expect(deleted.status).toBe(200);
      expect(await ctx.db.select().from(cloudAccount)).toEqual([]);
    });
  });
});
