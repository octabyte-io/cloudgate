import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { AUTH_TOKEN_VARIABLE } from '../../src/cloud-accounts/aws/definitions/redis-definition';
import { valueVariable } from '../../src/cloud-accounts/definitions/tofu-json';
import { ELASTICACHE_CA_BUNDLE } from '../../src/cloud-accounts/aws/elasticache-ca';
import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import {
  cloudAccount,
  deployment,
  plan as planTable,
  postgres,
  redis,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { fakeBinShell } from '../utils/fake-bin-shell';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const CACHE_ENDPOINT = 'master.cloudgate-redis.abc123.euc1.cache.amazonaws.com';
const PG_ENDPOINT =
  'shop-production-pg-1.c9akciq32.eu-central-1.rds.amazonaws.com';

const REDIS = `version: 1
services:
  redis:
    kind: redis
    version: "7"
    size: small
`;

/** The acceptance config: web, pg-1 and redis, both URLs wired. */
const STACK = `version: 1
services:
  pg-1:
    kind: postgres
    version: "17"
    size: small
  redis:
    kind: redis
    version: "7"
    size: small
  web:
    kind: web
    size: small
    source: { image: nginx }
    env: [{ DATABASE_URL: pg-1.url }, { REDIS_URL: redis.url }, { REDIS_CA: redis.ca }]
`;

/** What `tofu output -json` answers after the network's apply. */
const NETWORK_OUTPUTS = {
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

/**
 * An Environment whose Deploy target is an AWS Cloud account plans a
 * `redis` as a one-node ElastiCache for Valkey replication group. The plan
 * names Valkey and the node type its size lands on, with the note a
 * version of 7 or lower gets, read from a stored real plan (`ctx.cloud`
 * replays `redis-create.json`). Apply records the redis in its cloud place
 * with a generated AUTH token — never answered, only its presence — and
 * makes it through a Cloud run in its own Infrastructure state. A cloud
 * `web` linking it gets the `rediss://` URL as an SSM SecureString, its
 * Cloud run after the redis's.
 *
 * Against the fake cloud port and a real shell whose `docker` is the fake
 * above, through the real deployment queue.
 */
describe('Plans that make a redis on ElastiCache (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;
  const shell = fakeBinShell('redis', { docker: FAKE_DOCKER });
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

    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId,
        name: 'production',
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: row.cloudAccountId,
          region: REGION,
        },
      });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;

    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('postgres', 'postgres-create');
    ctx.cloud.replayPlanFor('redis', 'redis-create');
    ctx.cloud.replayPlanFor('web', 'web-create');
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;
  });

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

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

  /** The open plan, once every step has read AWS. */
  const openPlan = (): Promise<Plan> =>
    until(async () => {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.status, 'open'));
      return found &&
        !found.steps.some(
          (step) =>
            (step.action === 'create' || step.action === 'network-create') &&
            step.cloudRead?.status === 'reading',
        )
        ? found
        : undefined;
    }, 'the plan to read AWS');

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

  const stateOf = (read: Plan, configName: string): string => {
    const step = read.steps.find(
      (one) => one.action === 'create' && one.configName === configName,
    );
    if (step?.action !== 'create' || step.cloudRead?.status !== 'read') {
      throw new Error(`${configName} was not read`);
    }
    return step.cloudRead.stateId;
  };

  /** Applies the read plan with each made thing's outputs scripted. */
  async function apply(read: Plan): Promise<(configName: string) => string> {
    const network = read.steps[0];
    if (
      network.action !== 'network-create' ||
      network.cloudRead.status !== 'read'
    ) {
      throw new Error('the network was not read');
    }
    ctx.cloud.outputsFor(network.cloudRead.stateId, NETWORK_OUTPUTS);
    ctx.cloud.outputsFor(stateOf(read, 'redis'), {
      primary_endpoint_address: CACHE_ENDPOINT,
      port: 6379,
      replication_group_id: 'cloudgate-redis',
    });
    if (read.steps.some((s) => 'configName' in s && s.configName === 'pg-1')) {
      ctx.cloud.outputsFor(stateOf(read, 'pg-1'), {
        endpoint_address: PG_ENDPOINT,
        endpoint_port: 5432,
        instance_identifier: 'shop-production-pg-1',
      });
    }
    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    const row = await until(async () => {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, read.planId));
      return found?.results &&
        !found.results.some((result) => result.status === 'running')
        ? found
        : undefined;
    }, 'the Apply to end');
    return (configName) => {
      const result = row.results!.find((one) => one.configName === configName);
      if (result?.deploy?.status !== 'queued') {
        throw new Error(`${configName} queued no Cloud run`);
      }
      return result.deploy.deploymentId;
    };
  }

  it('plans a redis as Valkey on the node type its size lands on, noting 7 runs as Valkey 7.2', async () => {
    const saved = await save(REDIS);
    expect(saved.status).toBe(201);
    const read = await openPlan();

    expect(read.steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);
    expect(read.steps[1]).toMatchObject({
      configName: 'redis',
      kind: 'redis',
      cache: {
        size: { name: 'small', nodeType: 'cache.t4g.small' },
        version: { written: '7', engineVersion: '7.2' },
      },
      cloudRead: {
        status: 'read',
        summary: [
          'redis small → Valkey on cache.t4g.small (2 vCPU, 1.37 GB)',
          'redis snapshots: daily, kept 1 day',
          'redis version: Valkey 7.2',
        ],
      },
    });
    expect(read.notes).toContainEqual({
      kind: 'cloud-version-oldest',
      configName: 'redis',
      message: 'redis.version: redis 7 → Valkey 7.2 (oldest on AWS)',
    });

    // What the read planned: the replication group, in its own new state,
    // with a throwaway token as a sensitive variable only.
    const input = ctx.cloud.tofuInputs.find(
      (one) => one.stateId === stateOf(read, 'redis'),
    )!;
    expect(input.definition).toContain('aws_elasticache_replication_group');
    expect(input.definition).toContain('"engine_version": "7.2"');
    expect(input.definition).toContain('"node_type": "cache.t4g.small"');
    expect(input.definition).not.toContain(
      input.variables[AUTH_TOKEN_VARIABLE],
    );
  });

  it('refuses a redis version ElastiCache does not offer, storing nothing', async () => {
    const refused = await save(REDIS.replace('"7"', '"9"'));

    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toContain(
      'redis.version: 9 is not offered by ElastiCache for Valkey',
    );
    expect(await ctx.db.select().from(planTable)).toEqual([]);
  });

  it('applies it through a Cloud run in its own state, with a generated AUTH token only its presence answers', async () => {
    expect((await save(REDIS)).status).toBe(201);
    const read = await openPlan();
    const runOf = await apply(read);

    const run = await settled(runOf('redis'));
    expect(run.status).toBe('done');
    const [made] = await ctx.db.select().from(redis);
    expect(made).toMatchObject({
      configName: 'redis',
      serverId: null,
      region: REGION,
      nodeType: null,
      replica: false,
      snapshotRetentionDays: 1,
      applicationStatus: 'done',
      elasticacheEndpoint: { host: CACHE_ENDPOINT, port: 6379 },
    });
    expect(made.cloudAccountId).not.toBeNull();
    expect(made.authToken).toMatch(/^[A-Za-z0-9]{64}$/);
    expect(run.redisId).toBe(made.redisId);
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.redisId, made.redisId));
    expect(state.infrastructureStateId).toBe(stateOf(read, 'redis'));

    // The token reached tofu as a sensitive variable, never in the file.
    const applied = ctx.cloud.tofuInputs
      .filter((one) => one.stateId === state.infrastructureStateId)
      .at(-1)!;
    expect(applied.variables[AUTH_TOKEN_VARIABLE]).toBe(made.authToken);
    expect(applied.definition).not.toContain(made.authToken!);
    expect(
      ctx.cloud.calls.some(
        (call) =>
          call.method === 'apply' &&
          call.stateId === state.infrastructureStateId,
      ),
    ).toBe(true);

    // The API answers whether a token is set, never the token.
    const read1 = await request(http)
      .get(`/redis/${made.redisId}`)
      .set('Cookie', cookie);
    expect(read1.status).toBe(200);
    expect(read1.body).toMatchObject({ hasAuthToken: true });
    expect(read1.body).not.toHaveProperty('authToken');
    const answers = [
      read1,
      await request(http)
        .patch(`/redis/${made.redisId}`)
        .set('Cookie', cookie)
        .send({ description: 'queues' }),
      await request(http)
        .get(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie),
      await request(http)
        .get(`/deployments/${run.deploymentId}/logs`)
        .set('Cookie', cookie),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(answer.text).not.toContain(made.authToken);
    }
  });

  it('answers where the replication group is and that its AUTH token is set, never the Server password, and refuses a password edit, writing nothing', async () => {
    expect((await save(REDIS)).status).toBe(201);
    const runOf = await apply(await openPlan());
    expect((await settled(runOf('redis'))).status).toBe('done');
    const [made] = await ctx.db.select().from(redis);

    const shown = await request(http)
      .get(`/redis/${made.redisId}`)
      .set('Cookie', cookie);
    expect(shown.status).toBe(200);
    expect(shown.body).not.toHaveProperty('databasePassword');
    expect(shown.body).not.toHaveProperty('authToken');
    expect(shown.body).toMatchObject({
      hasAuthToken: true,
      elasticacheEndpoint: { host: CACHE_ENDPOINT, port: 6379 },
    });

    const refused = await request(http)
      .patch(`/redis/${made.redisId}`)
      .set('Cookie', cookie)
      .send({ databasePassword: 'a-new-password' });
    expect(refused.status).toBe(400);
    expect((refused.body as { message: string }).message).toBe(
      'redis runs on ElastiCache, where its password is the AUTH token Cloudgate made for it, which is never edited',
    );
    const [after] = await ctx.db
      .select()
      .from(redis)
      .where(eq(redis.redisId, made.redisId));
    expect(after.databasePassword).toBe(made.databasePassword);
    expect(after.wiredChangedAt).toEqual(made.wiredChangedAt);
  });

  it('plans and applies web, pg-1 and redis with both URLs wired, REDIS_URL reaching web as rediss:// after the redis run', async () => {
    expect((await save(STACK)).status).toBe(201);
    const read = await openPlan();
    expect(
      read.steps.map((step) =>
        'configName' in step ? step.configName : step.action,
      ),
    ).toEqual(['network-create', 'pg-1', 'redis', 'web']);

    // The plan read already wrote web's wired parameters, at stand-ins.
    const webState = stateOf(read, 'web');
    const webRead = ctx.cloud.tofuInputs.find(
      (one) => one.stateId === webState,
    )!;
    expect(webRead.variables[valueVariable('REDIS_CA')]).toBe(
      ELASTICACHE_CA_BUNDLE,
    );

    const runOf = await apply(read);
    expect((await settled(runOf('pg-1'))).status).toBe('done');
    expect((await settled(runOf('redis'))).status).toBe('done');
    const web = await settled(runOf('web'));
    expect(web.status).toBe('done');

    const [cache] = await ctx.db.select().from(redis);
    const [pg] = await ctx.db.select().from(postgres);
    expect(web.cloudRun).toMatchObject({
      after: [`postgres:${pg.postgresId}`, `redis:${cache.redisId}`].sort(),
    });

    // redis's apply came before every call of web's run's apply.
    const order = ctx.cloud.calls.map((call) =>
      'stateId' in call ? `${call.method}:${call.stateId}` : call.method,
    );
    const redisApply = order.indexOf(`apply:${stateOf(read, 'redis')}`);
    const webApply = order.indexOf(`apply:${webState}`);
    expect(redisApply).toBeGreaterThanOrEqual(0);
    expect(webApply).toBeGreaterThan(redisApply);

    // Each wired value one SSM SecureString of web's, never in its file.
    const applied = ctx.cloud.tofuInputs
      .filter((one) => one.stateId === webState)
      .at(-1)!;
    expect(applied.variables[valueVariable('REDIS_URL')]).toBe(
      `rediss://default:${cache.authToken}@${CACHE_ENDPOINT}:6379`,
    );
    expect(applied.variables[valueVariable('REDIS_CA')]).toBe(
      ELASTICACHE_CA_BUNDLE,
    );
    expect(applied.variables[valueVariable('DATABASE_URL')]).toContain(
      `@${PG_ENDPOINT}:5432/pg_1?sslmode=require`,
    );
    expect(applied.definition).toContain('SecureString');
    expect(applied.definition).not.toContain(cache.authToken!);
    expect(applied.definition).not.toContain('rediss://');
  });
});
