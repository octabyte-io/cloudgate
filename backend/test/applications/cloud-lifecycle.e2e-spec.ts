import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import {
  application,
  cloudAccount,
  environmentNetwork,
} from '../../src/db/schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const CLUSTER = `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/cloudgate-env`;

/**
 * A `web` in a Cloud account is stopped, started and reloaded by
 * direct ECS calls through the cloud port, never a Cloud run. Stop sets the
 * desired count to zero, Start puts back `replicas`, and Reload forces a new
 * deployment, refused while the Service is stopped. There is no Remove
 * containers. `agentOperator` does all three, as on a Server.
 *
 * The Service and its Environment network are written as a finished deploy
 * leaves them (`cloud-deploy.e2e-spec.ts` makes them for real), against the
 * fake cloud port (`ctx.cloud`).
 */
describe('Stop, Start and Reload of a cloud Service (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  let cloudAccountId: string;
  let applicationId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
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

    const [account] = await ctx.db
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
    cloudAccountId = account.cloudAccountId;
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

    await ctx.db.insert(environmentNetwork).values({
      environmentId,
      cloudAccountId,
      region: REGION,
      status: 'ready',
      vpcId: 'vpc-0f00ba11',
      publicSubnetIds: ['subnet-0a11', 'subnet-0b22'],
      clusterArn: CLUSTER,
      httpsListenerArn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/cg/50dc6c495c0c9188/f2f7dc8efc522ab2`,
      albSecurityGroupId: 'sg-0a1b',
    });
    const [web] = await ctx.db
      .insert(application)
      .values({
        name: 'web',
        environmentId,
        configName: 'web',
        configKind: 'web',
        sourceType: 'docker',
        dockerImage: 'nginx',
        cloudAccountId,
        region: REGION,
        replicas: 3,
        applicationStatus: 'done',
      })
      .returning();
    applicationId = web.applicationId;
    ctx.cloud.calls.length = 0;
  });

  const ecsService = () => ({
    region: REGION,
    cluster: CLUSTER,
    service: `web-${applicationId}`,
  });

  /** What the cloud port was asked of ECS, in order. */
  const ecsCalls = () =>
    ctx.cloud.calls.filter((call) => call.method.startsWith('ecs'));

  const statusOf = async () => {
    const [row] = await ctx.db
      .select({ status: application.applicationStatus })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    return row.status;
  };

  const post = (action: string) =>
    request(http)
      .post(`/applications/${applicationId}/${action}`)
      .set('Cookie', cookie);

  /** An Agent of `role`, granted the Project, Environment and Service. */
  async function agent(role: 'agentOperator' | 'agentReader') {
    const created = await request(http)
      .post('/agents')
      .set('Cookie', cookie)
      .send({
        name: `${role}-bot`,
        role,
        grant: {
          accessedProjects: [projectId],
          accessedEnvironments: [environmentId],
          accessedServices: [applicationId],
        },
      });
    expect(created.status).toBe(201);
    const id = (created.body as { agent: { id: string } }).agent.id;
    return { user: { id }, session: { activeOrganizationId: organizationId } };
  }

  /** The Service made a Worker on ECS, which stops, starts and reloads as a `web` does. */
  const asKind = (kind: 'web' | 'worker' | 'web-private') =>
    ctx.db
      .update(application)
      .set({ configKind: kind })
      .where(eq(application.applicationId, applicationId));

  it.each(['web', 'worker', 'web-private'] as const)(
    'stops a %s by setting the desired count to zero, and starts it by putting back replicas',
    async (kind) => {
      await asKind(kind);
      const stopped = await post('stop');
      expect(stopped.status).toBe(200);
      expect(stopped.body).toMatchObject({ applicationStatus: 'stopped' });
      expect(ecsCalls()).toEqual([
        { method: 'ecsSetDesiredCount', ...ecsService(), desiredCount: 0 },
      ]);
      // Through a deploy-role session, as every call outside tofu is.
      expect(ctx.cloud.calls[0]).toMatchObject({ method: 'assumeRole' });

      ctx.cloud.calls.length = 0;
      const started = await post('start');
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({ applicationStatus: 'done' });
      expect(ecsCalls()).toEqual([
        { method: 'ecsSetDesiredCount', ...ecsService(), desiredCount: 3 },
      ]);
      // Nothing runs on a Server and nothing is a Cloud run.
      expect(
        ctx.cloud.calls.filter((call) =>
          ['plan', 'apply', 'destroy'].includes(call.method),
        ),
      ).toEqual([]);
    },
  );

  it.each(['web', 'worker', 'web-private'] as const)(
    'reloads a %s with forceNewDeployment, and refuses it while stopped, saying why',
    async (kind) => {
      await asKind(kind);
      const reloaded = await post('reload');
      expect(reloaded.status).toBe(200);
      expect(reloaded.body).toMatchObject({ applicationStatus: 'done' });
      expect(ecsCalls()).toEqual([
        { method: 'ecsForceNewDeployment', ...ecsService() },
      ]);

      expect((await post('stop')).status).toBe(200);
      ctx.cloud.calls.length = 0;
      const refused = await post('reload');
      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        'This Service is stopped, so it has no running copy to replace. Start it first',
      );
      expect(ctx.cloud.calls).toEqual([]);
      expect(await statusOf()).toBe('stopped');
    },
  );

  it('offers no Remove containers on a cloud Service', async () => {
    const res = await post('remove-containers');
    expect(res.status).toBe(404);
    expect(ctx.cloud.calls).toEqual([]);
    expect(await statusOf()).toBe('done');
  });

  it('refuses before any ECS call when the Cloud account cannot take on its deploy role, and records it', async () => {
    ctx.cloud.refuseRole(
      'User: arn:aws:iam::123456789012:user/cloudgate is not authorized to perform: sts:AssumeRole',
    );

    const res = await post('stop');

    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toBe(
      'Cloud account Production AWS could not take on its deploy role: AWS answered AccessDenied: User: arn:aws:iam::123456789012:user/cloudgate is not authorized to perform: sts:AssumeRole. Fix its credential or role in Organization settings, then Check for changes',
    );
    expect(ecsCalls()).toEqual([]);
    expect(await statusOf()).toBe('done');
    const [account] = await ctx.db
      .select()
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    expect(account.lastCheckResult).toBe('failed');
  });

  it('lets agentOperator stop, start and reload a cloud Service, and not agentReader', async () => {
    const applications = ctx.app.get(ApplicationsService);
    const operator = await agent('agentOperator');

    await applications.stop(operator, applicationId, { detach: true });
    expect(await statusOf()).toBe('stopped');
    await applications.start(operator, applicationId, { detach: true });
    expect(await statusOf()).toBe('done');
    await applications.reload(operator, applicationId);
    expect(ecsCalls().map((call) => call.method)).toEqual([
      'ecsSetDesiredCount',
      'ecsSetDesiredCount',
      'ecsForceNewDeployment',
    ]);

    ctx.cloud.calls.length = 0;
    const reader = await agent('agentReader');
    for (const act of [
      () => applications.stop(reader, applicationId),
      () => applications.start(reader, applicationId),
      () => applications.reload(reader, applicationId),
    ]) {
      await expect(act()).rejects.toMatchObject({ status: 403 });
    }
    expect(ecsCalls()).toEqual([]);
  });
});
