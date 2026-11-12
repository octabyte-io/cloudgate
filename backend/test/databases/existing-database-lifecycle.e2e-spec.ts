import { and, desc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { valueVariable } from '../../src/cloud-accounts/definitions/tofu-json';
import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import {
  application,
  cloudAccount,
  databaseSwitch,
  deployment,
  environmentNetwork,
  existingDatabase,
  plan as planTable,
  postgres,
  redis,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { cloudReadOf } from '../../src/project-config/planner/cloud-steps';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { fakeBinShell } from '../utils/fake-bin-shell';
import { storedPlan } from '../utils/fake-cloud-port';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
/** Where the stored lookup finds `acme-prod`. */
const HOST = 'acme-prod.aaaaaaaaaa.eu-central-1.rds.amazonaws.com';
/** Where it answers once it has moved. */
const NEW_HOST = 'acme-prod-2.aaaaaaaaaa.eu-central-1.rds.amazonaws.com';
const ACME_VPC = 'vpc-00000000000000001';
const LOGIN_PASSWORD = 'apps-login-p@ss/w0rd';
const NOT_MANAGED = "Cloudgate uses this database but doesn't manage it.";

const PG_ONLY = `version: 1
services:
  pg-1:
    kind: postgres
    version: "17"
    size: small
`;

const STACK = `${PG_ONLY}  web:
    kind: web
    size: small
    source: { image: nginx }
    env: [{ DATABASE_URL: pg-1.url }]
`;

/** What `tofu output -json` answers after the network's apply. */
const NETWORK_OUTPUTS = {
  vpc_id: ACME_VPC,
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

type Resource = { type: string; values: Record<string, unknown> };

/** The stored lookup, its instance's values (or what it found) changed. */
function lookupShowing(
  change: (resources: Resource[]) => Resource[],
): TofuShow {
  const show = storedPlan('existing-postgres-lookup') as {
    prior_state: { values: { root_module: { resources: Resource[] } } };
  };
  const resources = change(
    structuredClone(show.prior_state.values.root_module.resources),
  );
  return {
    ...show,
    prior_state: { values: { root_module: { resources } } },
  };
}

const instanceOf = (resources: Resource[]) =>
  resources.find((one) => one.type === 'aws_db_instance')!;

/** `acme-prod` found at `host`, or not found at all. */
const movedTo = (host: string) =>
  lookupShowing((resources) => {
    instanceOf(resources).values.address = host;
    return resources;
  });
const gone = () =>
  lookupShowing((resources) =>
    resources.filter((one) => one.type === 'aws_db_instances'),
  );

/**
 * An Existing database over time (ADR-0033, US59–61, US80).
 * A plan that finds it at a new address shows the Output change and the
 * linked redeploy, and its Apply saves the address before redeploying; a
 * login edited on its page marks the linking Services instead; a lookup
 * that finds it gone says so on its page; switching to or from a
 * Cloudgate-made database is one plan; and its lifecycle is refused.
 */
describe('An existing database over time (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let cloudAccountId: string;
  let projectId: string;
  let environmentId: string;
  const shell = fakeBinShell('existing-time', { docker: FAKE_DOCKER });
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
    const organizationId = (orgs.body as { id: string }[])[0].id;
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
    ctx.cloud.replayPlanFor('postgres', 'postgres-create');
    ctx.cloud.replayPlanFor('existing-postgres', 'existing-postgres-lookup');
  });

  async function created(body: Record<string, unknown> = {}) {
    const res = await request(http)
      .post('/postgres/existing')
      .set('Cookie', cookie)
      .send({
        environmentId,
        configName: 'pg-1',
        identifier: 'acme-prod',
        databaseUser: 'shop_app',
        databasePassword: LOGIN_PASSWORD,
        databaseName: 'shop',
        madeReachable: false,
        ...body,
      });
    expect(res.status).toBe(201);
    return (res.body as { postgresId: string }).postgresId;
  }

  /** The Environment network, made, in `acme-prod`'s VPC. */
  async function networkIn(vpcId: string) {
    await ctx.db.insert(environmentNetwork).values({
      environmentId,
      cloudAccountId,
      region: REGION,
      status: 'ready',
      vpcId,
      publicSubnetIds: ['subnet-0a11', 'subnet-0b22'],
      privateSubnetIds: ['subnet-0c33', 'subnet-0d44'],
      clusterArn: NETWORK_OUTPUTS.cluster_arn,
      httpsListenerArn: NETWORK_OUTPUTS.https_listener_arn,
      albSecurityGroupId: 'sg-0a1b',
    });
  }

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  /** The Environment's latest plan, once every AWS read of it has landed. */
  async function readPlan(): Promise<Plan> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(
          and(
            eq(planTable.environmentId, environmentId),
            inArray(planTable.status, ['open', 'unchanged']),
          ),
        )
        .orderBy(desc(planTable.createdAt))
        .limit(1);
      if (
        found &&
        !found.steps.some((step) => cloudReadOf(step)?.status === 'reading')
      ) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading AWS');
  }

  async function planOf(text: string): Promise<Plan> {
    const saved = await save(text);
    expect(saved.status).toBe(201);
    return readPlan();
  }

  const apply = (planId: string, body: Record<string, unknown> = {}) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId, ...body });

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

  const settled = (deploymentId: string): Promise<Deployment> =>
    until(async () => {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      return row && ['done', 'error', 'cancelled'].includes(row.status)
        ? row
        : undefined;
    }, `Deployment ${deploymentId} to end`);

  /** The plan once its Apply has run every step. */
  const applied = (planId: string): Promise<Plan> =>
    until(async () => {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, planId));
      return found?.results &&
        !found.results.some((result) => result.status === 'running')
        ? found
        : undefined;
    }, 'the Apply to end');

  const shape = (steps: Plan['steps']) =>
    steps.map((step) =>
      'configName' in step ? `${step.action}:${step.configName}` : step.action,
    );

  /** `pg-1` used as `acme-prod`, and `web` on AWS linking `pg-1.url`, applied. */
  async function linkedStack(): Promise<{
    postgresId: string;
    webStateId: string;
  }> {
    const postgresId = await created({ madeReachable: true });
    const read = await planOf(STACK);
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
    expect((await apply(read.planId)).status).toBe(200);
    const done = await applied(read.planId);
    const web = done.results!.find((one) => one.configName === 'web');
    if (web?.deploy?.status !== 'queued') throw new Error('web queued nothing');
    expect((await settled(web.deploy.deploymentId)).status).toBe('done');
    return { postgresId, webStateId: webStep.cloudRead.stateId };
  }

  const webVariable = (stateId: string, name: string) =>
    ctx.cloud.tofuInputs.filter((input) => input.stateId === stateId).at(-1)!
      .variables[valueVariable(name)];

  describe('A new address', () => {
    it("shows pg-1.url changed with web's redeploy, and its Apply saves the address before queuing web", async () => {
      const { postgresId, webStateId } = await linkedStack();
      expect(webVariable(webStateId, 'DATABASE_URL')).toContain(`@${HOST}:`);
      ctx.cloud.replayShowFor('existing-postgres', movedTo(NEW_HOST));

      const read = await planOf(STACK);

      expect(shape(read.steps)).toEqual(['change:pg-1', 'redeploy:web']);
      const [lookup, redeploy] = read.steps;
      if (lookup.action !== 'change' || lookup.cloudRead?.status !== 'read') {
        throw new Error('pg-1 was not looked up');
      }
      expect(lookup.cloudRead.addressMoved).toEqual({
        from: { host: HOST, port: 5432 },
        to: { host: NEW_HOST, port: 5432 },
        moved: ['pg-1.url', 'pg-1.host'],
      });
      expect(lookup.cloudRead.summary).toContain(
        `pg-1: acme-prod now answers at ${NEW_HOST}:5432, not ${HOST}:5432; pg-1.url, pg-1.host changed, so Apply saves the new address, then redeploys what links to them`,
      );
      expect(redeploy).toMatchObject({
        action: 'redeploy',
        configName: 'web',
        because: ['pg-1.url'],
      });
      expect(read.status).toBe('open');
      // Nothing is saved until the Apply: deploys keep the old address.
      const [before] = await ctx.db
        .select()
        .from(existingDatabase)
        .where(eq(existingDatabase.postgresId, postgresId));
      expect(before.address).toEqual({ host: HOST, port: 5432 });

      // web's redeploy reads AWS again: its image and its variable move.
      ctx.cloud.replayPlanFor('web', 'image-only-no-variables');
      expect((await apply(read.planId)).status).toBe(200);
      const done = await applied(read.planId);

      expect(done.results!.map((one) => one.configName)).toEqual([
        'pg-1',
        'web',
      ]);
      const [after] = await ctx.db
        .select()
        .from(existingDatabase)
        .where(eq(existingDatabase.postgresId, postgresId));
      expect(after.address).toEqual({ host: NEW_HOST, port: 5432 });
      const web = done.results!.find((one) => one.configName === 'web');
      if (web?.deploy?.status !== 'queued') {
        throw new Error('web was not redeployed');
      }
      expect((await settled(web.deploy.deploymentId)).status).toBe('done');
      expect(webVariable(webStateId, 'DATABASE_URL')).toContain(
        `@${NEW_HOST}:`,
      );
    });

    it('plans nothing when it is found where it was', async () => {
      await linkedStack();

      const read = await planOf(STACK);

      expect(read.status).toBe('unchanged');
      expect(shape(read.steps)).toEqual(['change:pg-1']);
    });
  });

  it('marks web "deploy to pick up the new value" when the login is edited on its page, queuing nothing', async () => {
    const { postgresId } = await linkedStack();
    const [web] = await ctx.db.select().from(application);
    expect(web.wiredChangedAt).toBeNull();
    const deploymentsBefore = await ctx.db.select().from(deployment);

    const edited = await request(http)
      .patch(`/postgres/${postgresId}/existing`)
      .set('Cookie', cookie)
      .send({ databasePassword: 'a-new-apps-password' });
    expect(edited.status).toBe(200);

    const read = await request(http)
      .get(`/applications/${web.applicationId}`)
      .set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(
      (read.body as { wiredChangedAt: string | null }).wiredChangedAt,
    ).toEqual(expect.any(String));
    expect(await ctx.db.select().from(deployment)).toHaveLength(
      deploymentsBefore.length,
    );
  });

  describe('Vanished', () => {
    it('says "AWS cannot find acme-prod" on its API view once a plan finds it gone, until one finds it', async () => {
      const postgresId = await created();
      await networkIn(ACME_VPC);
      ctx.cloud.replayShowFor('existing-postgres', gone());

      const refused = await planOf(PG_ONLY);

      // The plan is refused as before.
      expect(cloudReadOf(refused.steps[0])?.status).toBe('failed');
      const read = await request(http)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', cookie);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        existing: {
          notFound: {
            sentence: 'AWS cannot find acme-prod',
            since: expect.any(String) as string,
          },
        },
      });

      ctx.cloud.replayPlanFor('existing-postgres', 'existing-postgres-lookup');
      await planOf(`${PG_ONLY}    description: found again\n`);
      const again = await request(http)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', cookie);
      expect(again.body).toMatchObject({ existing: { notFound: null } });
    });
  });

  describe('Switching', () => {
    /** `pg-1` on RDS, as Cloudgate made it. */
    async function madeOnRds(): Promise<string> {
      const [pg] = await ctx.db
        .insert(postgres)
        .values({
          name: 'pg-1',
          environmentId,
          configName: 'pg-1',
          dockerImage: 'postgres:17',
          databaseName: 'pg_1',
          databaseUser: 'pg_1',
          databasePassword: 'super-secret-database-password',
          cloudAccountId,
          region: REGION,
          instanceClass: 'db.t4g.micro',
          applicationStatus: 'done',
        })
        .returning();
      return pg.postgresId;
    }

    it('plans a Cloudgate-made pg-1 switched to acme-prod as a destroy keeping a final snapshot and an add, saying no data is copied', async () => {
      const postgresId = await madeOnRds();
      await networkIn(ACME_VPC);

      const asked = await request(http)
        .post(`/postgres/${postgresId}/switch/to-existing`)
        .set('Cookie', cookie)
        .send({
          identifier: 'acme-prod',
          databaseUser: 'shop_app',
          databasePassword: LOGIN_PASSWORD,
          databaseName: 'shop',
        });
      expect(asked.status).toBe(200);
      expect(asked.text).not.toContain(LOGIN_PASSWORD);
      expect(asked.body).toMatchObject({
        switch: { to: 'existing', identifier: 'acme-prod' },
      });
      const [kept] = await ctx.db.select().from(databaseSwitch);
      // Stored encrypted, the column's own (ADR-0006).
      expect(kept.databasePassword).toBe(LOGIN_PASSWORD);

      const read = await planOf(PG_ONLY);

      expect(shape(read.steps)).toEqual(['destroy:pg-1', 'create:pg-1']);
      const [destroy, create] = read.steps;
      expect(destroy).toMatchObject({
        action: 'destroy',
        serviceId: postgresId,
        finalSnapshot: {
          name: expect.stringContaining('pg-1-final-') as string,
          monthlyUsd: expect.any(Number) as number,
        },
      });
      expect(destroy).not.toHaveProperty('existing');
      expect(create).toMatchObject({
        action: 'create',
        existing: { identifier: 'acme-prod' },
      });
      expect(read.notes).toContainEqual({
        kind: 'data-not-copied',
        configName: 'pg-1',
        message:
          'pg-1: switches to the existing database acme-prod, which keeps its own data; no data is copied from the database Cloudgate made',
      });
      // The Cloudgate-made side keeps its destroy guard.
      const unconfirmed = await apply(read.planId);
      expect(unconfirmed.status).toBe(409);
      expect(unconfirmed.body).toMatchObject({
        code: 'PLAN_DESTROY_NOT_CONFIRMED',
      });
    });

    it('applies acme-prod switched to a Cloudgate-made pg-1 as a records-only removal and a create, leaving acme-prod untouched', async () => {
      const postgresId = await created();
      await networkIn(ACME_VPC);

      const asked = await request(http)
        .post(`/postgres/${postgresId}/switch/to-made`)
        .set('Cookie', cookie);
      expect(asked.status).toBe(200);
      expect(asked.body).toMatchObject({ switch: { to: 'made' } });

      const read = await planOf(PG_ONLY);

      expect(shape(read.steps)).toEqual(['destroy:pg-1', 'create:pg-1']);
      const [destroy, create] = read.steps;
      expect(destroy).toMatchObject({
        serviceId: postgresId,
        existing: { identifier: 'acme-prod' },
      });
      expect(destroy).not.toHaveProperty('finalSnapshot');
      expect(create).toMatchObject({
        action: 'create',
        database: expect.any(Object) as object,
      });
      expect(create).not.toHaveProperty('existing');
      expect(read.notes).toContainEqual({
        kind: 'data-not-copied',
        configName: 'pg-1',
        message:
          'pg-1: the database Cloudgate makes starts empty; no data is copied from the existing database acme-prod, which is left as it was',
      });

      const destroysBefore = ctx.cloud.calls.filter(
        (call) => call.method === 'destroy',
      ).length;
      expect(
        (await apply(read.planId, { confirmDestroy: ['pg-1'] })).status,
      ).toBe(200);
      const done = await applied(read.planId);

      expect(done.results!.map((one) => `${one.action}:${one.status}`)).toEqual(
        ['destroy:applied', 'create:applied'],
      );
      // acme-prod is left as it was: nothing of it reached AWS.
      expect(
        ctx.cloud.calls.filter((call) => call.method === 'destroy'),
      ).toHaveLength(destroysBefore);
      expect(await ctx.db.select().from(existingDatabase)).toEqual([]);
      const rows = await ctx.db.select().from(postgres);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        configName: 'pg-1',
        cloudAccountId,
        region: REGION,
      });
      expect(await ctx.db.select().from(databaseSwitch)).toEqual([]);
      const run = done.results!.find((one) => one.action === 'create');
      if (run?.deploy?.status === 'queued') {
        await settled(run.deploy.deploymentId);
      }
    });

    it('cancels a switch, so the next plan keeps the Service', async () => {
      const postgresId = await created();
      await networkIn(ACME_VPC);
      await request(http)
        .post(`/postgres/${postgresId}/switch/to-made`)
        .set('Cookie', cookie)
        .expect(200);

      const cancelled = await request(http)
        .delete(`/postgres/${postgresId}/switch`)
        .set('Cookie', cookie);

      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ switch: null });
      expect(shape((await planOf(PG_ONLY)).steps)).toEqual(['change:pg-1']);
    });

    it('refuses a switch to an existing database on one that is existing already', async () => {
      const postgresId = await created();

      const res = await request(http)
        .post(`/postgres/${postgresId}/switch/to-existing`)
        .set('Cookie', cookie)
        .send({
          identifier: 'other-db',
          databaseUser: 'shop_app',
          databasePassword: LOGIN_PASSWORD,
          databaseName: 'shop',
        });

      expect(res.status).toBe(400);
    });
  });

  describe('Switching a redis', () => {
    const CACHE_ONLY = `version: 1
services:
  cache:
    kind: redis
    version: "7"
    size: small
`;
    const TOKEN = 'existing-cache-auth-token-0123';

    beforeEach(() => {
      ctx.cloud.replayPlanFor('redis', 'redis-create');
      ctx.cloud.replayPlanFor('existing-redis', 'existing-redis-lookup');
    });

    /** `cache` on ElastiCache, as Cloudgate made it. */
    async function madeOnElastiCache(): Promise<string> {
      const [made] = await ctx.db
        .insert(redis)
        .values({
          name: 'cache',
          environmentId,
          configName: 'cache',
          dockerImage: 'redis:7',
          databasePassword: 'super-secret-cache-password',
          cloudAccountId,
          region: REGION,
          nodeType: 'cache.t4g.micro',
          applicationStatus: 'done',
        })
        .returning();
      return made.redisId;
    }

    /** `cache` used as the existing replication group `acme-cache`. */
    async function existingCache(): Promise<string> {
      const res = await request(http)
        .post('/redis/existing')
        .set('Cookie', cookie)
        .send({
          environmentId,
          configName: 'cache',
          identifier: 'acme-cache',
          authToken: TOKEN,
        });
      expect(res.status).toBe(201);
      return (res.body as { redisId: string }).redisId;
    }

    it('plans a Cloudgate-made cache switched to acme-cache as a destroy and an add, keeping its token unread', async () => {
      const redisId = await madeOnElastiCache();
      await networkIn(ACME_VPC);

      const asked = await request(http)
        .post(`/redis/${redisId}/switch/to-existing`)
        .set('Cookie', cookie)
        .send({ identifier: 'acme-cache', authToken: TOKEN });
      expect(asked.status).toBe(200);
      expect(asked.text).not.toContain(TOKEN);
      expect(asked.body).toMatchObject({
        switch: { to: 'existing', identifier: 'acme-cache' },
      });
      const [kept] = await ctx.db.select().from(databaseSwitch);
      expect(kept).toMatchObject({ kind: 'redis', authToken: TOKEN });

      const read = await planOf(CACHE_ONLY);

      expect(shape(read.steps)).toEqual(['destroy:cache', 'create:cache']);
      const [destroy, create] = read.steps;
      expect(destroy).toMatchObject({ action: 'destroy', serviceId: redisId });
      expect(destroy).not.toHaveProperty('existing');
      expect(create).toMatchObject({
        action: 'create',
        kind: 'redis',
        existing: { identifier: 'acme-cache' },
      });
      expect(read.notes).toContainEqual(
        expect.objectContaining({
          kind: 'data-not-copied',
          configName: 'cache',
        }),
      );
    });

    it('applies acme-cache switched to a Cloudgate-made cache as a records-only removal and a create, leaving acme-cache untouched', async () => {
      const redisId = await existingCache();
      await networkIn(ACME_VPC);

      const asked = await request(http)
        .post(`/redis/${redisId}/switch/to-made`)
        .set('Cookie', cookie);
      expect(asked.status).toBe(200);
      expect(asked.body).toMatchObject({ switch: { to: 'made' } });

      const read = await planOf(CACHE_ONLY);

      expect(shape(read.steps)).toEqual(['destroy:cache', 'create:cache']);
      const [destroy, create] = read.steps;
      expect(destroy).toMatchObject({
        serviceId: redisId,
        existing: { identifier: 'acme-cache' },
      });
      expect(create).not.toHaveProperty('existing');

      const destroysBefore = ctx.cloud.calls.filter(
        (call) => call.method === 'destroy',
      ).length;
      expect(
        (await apply(read.planId, { confirmDestroy: ['cache'] })).status,
      ).toBe(200);
      const done = await applied(read.planId);

      expect(done.results!.map((one) => `${one.action}:${one.status}`)).toEqual(
        ['destroy:applied', 'create:applied'],
      );
      expect(
        ctx.cloud.calls.filter((call) => call.method === 'destroy'),
      ).toHaveLength(destroysBefore);
      expect(await ctx.db.select().from(existingDatabase)).toEqual([]);
      const rows = await ctx.db.select().from(redis);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        configName: 'cache',
        cloudAccountId,
        region: REGION,
      });
      expect(await ctx.db.select().from(databaseSwitch)).toEqual([]);
      const run = done.results!.find((one) => one.action === 'create');
      if (run?.deploy?.status === 'queued') {
        await settled(run.deploy.deploymentId);
      }
    });

    it('creates acme-cache from the switch once the Cloudgate-made cache it replaces is gone', async () => {
      const redisId = await madeOnElastiCache();
      await networkIn(ACME_VPC);
      await request(http)
        .post(`/redis/${redisId}/switch/to-existing`)
        .set('Cookie', cookie)
        .send({ identifier: 'acme-cache', authToken: TOKEN, tls: false })
        .expect(200);
      // Its Delete's Cloud run has ended.
      await ctx.db.delete(redis).where(eq(redis.redisId, redisId));

      const read = await planOf(CACHE_ONLY);
      expect(shape(read.steps)).toEqual(['create:cache']);
      expect((await apply(read.planId)).status).toBe(200);
      const done = await applied(read.planId);

      expect(done.results!.map((one) => `${one.action}:${one.status}`)).toEqual(
        ['create:applied'],
      );
      const [row] = await ctx.db.select().from(redis);
      expect(row).toMatchObject({ configName: 'cache', authToken: TOKEN });
      const [place] = await ctx.db.select().from(existingDatabase);
      expect(place).toMatchObject({
        redisId: row.redisId,
        identifier: 'acme-cache',
        tls: false,
      });
      expect(await ctx.db.select().from(databaseSwitch)).toEqual([]);
    });

    it('cancels a switch, so the next plan keeps the Service', async () => {
      const redisId = await existingCache();
      await networkIn(ACME_VPC);
      await request(http)
        .post(`/redis/${redisId}/switch/to-made`)
        .set('Cookie', cookie)
        .expect(200);

      const cancelled = await request(http)
        .delete(`/redis/${redisId}/switch`)
        .set('Cookie', cookie);

      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ switch: null });
      expect(shape((await planOf(CACHE_ONLY)).steps)).toEqual(['change:cache']);
    });
  });

  describe('Lifecycle', () => {
    it.each(['start', 'stop', 'rebuild'])(
      'refuses %s with the exact sentence',
      async (action) => {
        const postgresId = await created();

        const res = await request(http)
          .post(`/postgres/${postgresId}/${action}`)
          .set('Cookie', cookie);

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          message: NOT_MANAGED,
          code: 'EXISTING_DATABASE_NOT_MANAGED',
        });
      },
    );

    it('refuses a status write, as an Agent’s start or stop would make', async () => {
      const postgresId = await created();

      const res = await request(http)
        .post(`/postgres/${postgresId}/status`)
        .set('Cookie', cookie)
        .send({ applicationStatus: 'idle' });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ message: NOT_MANAGED });
    });
  });
});
