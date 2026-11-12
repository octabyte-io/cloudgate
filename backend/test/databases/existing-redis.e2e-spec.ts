import { and, desc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { valueVariable } from '../../src/cloud-accounts/definitions/tofu-json';
import { ELASTICACHE_CA_BUNDLE } from '../../src/cloud-accounts/aws/elasticache-ca';
import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import {
  cloudAccount,
  deployment,
  environmentNetwork,
  existingDatabase,
  plan as planTable,
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
/** Where the stored lookup finds `acme-cache`: its primary endpoint. */
const HOST = 'master.acme-cache.x1y2z3.euc1.cache.amazonaws.com';
const ACME_VPC = 'vpc-0f00ba11';
/** The cache's AUTH token, typed by the operator: a secret, never returned. */
const TOKEN = 'acme-auth-token-0123456789+=';

const CACHE_ONLY = `version: 1
services:
  cache:
    kind: redis
    version: "8"
    size: small
`;

/** A cloud `web` linking `cache`'s URL, and its `ca` when asked. */
const stack = (withCa: boolean) => `${CACHE_ONLY}  web:
    kind: web
    size: small
    source: { image: nginx }
    env: [{ REDIS_URL: cache.url }${withCa ? ', { REDIS_CA: cache.ca }' : ''}]
`;

/** What `tofu output -json` answers after the network's apply. */
const NETWORK_OUTPUTS = {
  vpc_id: 'vpc-0e0e0e0e',
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

/** What the provider answers for a replication group AWS does not have. */
const NO_GROUP =
  "reading ElastiCache Replication Group (acme-cache): couldn't find resource";
const NO_SERVERLESS =
  "reading ElastiCache Serverless Cache (acme-cache): couldn't find resource";

type Resource = { type: string; values: Record<string, unknown> };

/** The stored lookup, the values of one of its data sources changed. */
function lookupWith(type: string, values: Record<string, unknown>): TofuShow {
  const show = structuredClone(storedPlan('existing-redis-lookup')) as {
    prior_state: { values: { root_module: { resources: Resource[] } } };
  };
  const one = show.prior_state.values.root_module.resources.find(
    (resource) => resource.type === type,
  )!;
  Object.assign(one.values, values);
  return show;
}

/**
 * An Environment's `cache` (ADR-0033) uses `acme-cache`, a node-based
 * ElastiCache replication group the operator already has. Created from the
 * console with its AUTH token and TLS flag, it is looked up at every plan
 * through OpenTofu `data` sources, never created, changed or deleted, hands
 * out `rediss://` or `redis://` by its TLS flag from the typed token and the
 * looked-up address, and its Delete removes only Cloudgate's records.
 * Against the fake cloud port (`ctx.cloud`) and, for a cloud `web`'s
 * deploy, a real shell whose `docker` is the fake above.
 */
describe('An existing cache used as an Environment’s redis (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const shell = fakeBinShell('existing-redis', { docker: FAKE_DOCKER });
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
    ctx.cloud.replayPlanFor('existing-redis', 'existing-redis-lookup');
  });

  const useExisting = (body: Record<string, unknown> = {}) =>
    request(http)
      .post('/redis/existing')
      .set('Cookie', cookie)
      .send({
        environmentId,
        configName: 'cache',
        identifier: 'acme-cache',
        authToken: TOKEN,
        ...body,
      });

  async function created(body: Record<string, unknown> = {}) {
    const res = await useExisting(body);
    expect(res.status).toBe(201);
    return (res.body as { redisId: string }).redisId;
  }

  /** The Environment network, made, in the VPC given. */
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

  async function lookupOf(text = CACHE_ONLY) {
    const saved = await save(text);
    expect(saved.status).toBe(201);
    const read = await readPlan();
    const step = read.steps.find(
      (one) => 'configName' in one && one.configName === 'cache',
    );
    if (step?.action !== 'change') throw new Error('cache has no change step');
    return { plan: read, step, aws: step.cloudRead! };
  }

  const apply = (planId: string) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

  /** Every `tofu` run and AWS call that writes. */
  const writes = () =>
    ctx.cloud.calls.filter(
      (call) =>
        call.method === 'apply' ||
        call.method === 'destroy' ||
        call.method.startsWith('ecs') ||
        call.method.startsWith('ecr'),
    );

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

  describe('Create', () => {
    it('makes a redis Service under the Config name, its token set and never returned', async () => {
      const callsBefore = ctx.cloud.calls.length;
      const res = await useExisting();

      expect(res.status).toBe(201);
      expect(res.text).not.toContain(TOKEN);
      expect(res.body).toMatchObject({
        configName: 'cache',
        hasAuthToken: true,
        existing: {
          identifier: 'acme-cache',
          cloudAccountId,
          region: REGION,
          madeReachable: false,
          tls: true,
          address: null,
        },
      });
      expect(res.body).not.toHaveProperty('authToken');
      const redisId = (res.body as { redisId: string }).redisId;
      const read = await request(http)
        .get(`/redis/${redisId}`)
        .set('Cookie', cookie);
      expect(read.status).toBe(200);
      expect(read.text).not.toContain(TOKEN);
      expect(read.body).toMatchObject({ hasAuthToken: true });
      // Stored encrypted, the column's own (ADR-0006).
      const [row] = await ctx.db
        .select()
        .from(redis)
        .where(eq(redis.redisId, redisId));
      expect(row.authToken).toBe(TOKEN);
      // Nothing reached AWS, and no Project config was written.
      expect(ctx.cloud.calls.slice(callsBefore)).toEqual([]);
      const config = await request(http)
        .get(`/projects/${projectId}/config`)
        .set('Cookie', cookie);
      expect(config.text).not.toContain('acme-cache');
    });

    it('edits the token and TLS on its page, never returning the token', async () => {
      const redisId = await created();

      const res = await request(http)
        .patch(`/redis/${redisId}/existing`)
        .set('Cookie', cookie)
        .send({ authToken: 'another-auth-token-9876543210', tls: false });

      expect(res.status).toBe(200);
      expect(res.text).not.toContain('another-auth-token-9876543210');
      expect(res.body).toMatchObject({
        hasAuthToken: true,
        existing: { tls: false },
      });

      const cleared = await request(http)
        .patch(`/redis/${redisId}/existing`)
        .set('Cookie', cookie)
        .send({ authToken: '' });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toMatchObject({ hasAuthToken: false });
    });

    it('refuses a token ElastiCache would not take', async () => {
      const res = await useExisting({ authToken: 'short' });

      expect(res.status).toBe(400);
      expect(res.text).not.toContain('short"');
    });

    it('refuses an Environment whose Deploy target is not a Cloud account', async () => {
      const env = await request(http)
        .post('/environments')
        .set('Cookie', cookie)
        .send({ projectId, name: 'staging' });
      expect(env.status).toBe(201);

      const res = await useExisting({
        environmentId: (env.body as { environmentId: string }).environmentId,
      });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'EXISTING_DATABASE_NEEDS_CLOUD' });
    });

    it("shows the Environment's network and the port to let in", async () => {
      await networkIn(ACME_VPC);

      const res = await request(http)
        .get(`/redis/existing/reach?environmentId=${environmentId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        cloudAccountName: 'Production AWS',
        vpcId: ACME_VPC,
        port: 6379,
        securityGroups: [],
      });
    });
  });

  describe('Each plan’s lookup', () => {
    it('creates nothing, reads acme-cache through data sources and saves where it answers', async () => {
      const redisId = await created();
      await networkIn(ACME_VPC);

      const { plan, step, aws } = await lookupOf();

      expect(plan.steps).toHaveLength(1);
      expect(plan.steps.some((one) => one.action === 'create')).toBe(false);
      expect(step).toMatchObject({
        serviceId: redisId,
        serviceType: 'redis',
        fields: [],
        existing: { identifier: 'acme-cache', version: 'redis:8' },
      });
      expect(aws).toMatchObject({
        status: 'read',
        summary: [
          `cache: existing cache acme-cache, Valkey 8.0.1, at ${HOST}:6379, TLS on (rediss://); used as given, Cloudgate changes nothing in it`,
        ],
      });
      expect(plan.status).toBe('unchanged');
      expect(plan.notes).toContainEqual({
        kind: 'existing-not-applied',
        configName: 'cache',
        message:
          "cache uses the existing cache acme-cache: the config's size and version are not applied to it",
      });
      const [saved] = await ctx.db
        .select()
        .from(existingDatabase)
        .where(eq(existingDatabase.redisId, redisId));
      expect(saved.address).toEqual({ host: HOST, port: 6379 });
      // Only data sources were planned; the token never reached `tofu`.
      const run = ctx.cloud.tofuInputs.at(-1)!;
      expect(run.definition).toContain('aws_elasticache_replication_group');
      expect(run.definition).not.toContain('"resource"');
      expect(run.definition).not.toContain(TOKEN);
      expect(run.variables).toEqual({});
      expect(writes()).toEqual([]);
    });

    it('refuses a replication group AWS does not have, naming id, Cloud account and region', async () => {
      await created();
      ctx.cloud.failRunFor('existing-redis', NO_GROUP);
      ctx.cloud.failRunFor('existing-redis-serverless', NO_SERVERLESS);

      const { plan, aws } = await lookupOf();

      expect(aws).toEqual({
        status: 'failed',
        reason: `cache uses the existing cache acme-cache, but AWS has no ElastiCache replication group acme-cache in Cloud account Production AWS (${ACCOUNT}), region ${REGION}. Check the replication group id on cache's page; it must be in this Environment's Cloud account and region`,
      });
      const refused = await apply(plan.planId);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'PLAN_AWS_NOT_READ' });
    });

    it('refuses a serverless cache, naming it', async () => {
      await created();
      ctx.cloud.failRunFor('existing-redis', NO_GROUP);
      ctx.cloud.replayPlanFor(
        'existing-redis-serverless',
        'existing-redis-serverless',
      );

      const { aws } = await lookupOf();

      expect(aws).toEqual({
        status: 'failed',
        reason:
          'cache uses the existing cache acme-cache, but acme-cache is a serverless ElastiCache cache, so a redis cannot use it: give the id of a node-based replication group with cluster mode off',
      });
    });

    it('refuses one in cluster mode', async () => {
      await created();
      await networkIn(ACME_VPC);
      ctx.cloud.replayShowFor(
        'existing-redis',
        lookupWith('aws_elasticache_replication_group', {
          cluster_mode: 'enabled',
          num_node_groups: 3,
          primary_endpoint_address: '',
          configuration_endpoint_address:
            'clustercfg.acme-cache.x1y2z3.euc1.cache.amazonaws.com',
        }),
      );

      const { aws } = await lookupOf();

      expect(aws.status === 'failed' && aws.reason).toBe(
        'cache uses the existing cache acme-cache, but acme-cache is in cluster mode, so a redis cannot use it: it hands out one URL, to one primary endpoint. Give the id of a replication group with cluster mode off',
      );
    });

    it('refuses one whose engine is neither Valkey nor Redis OSS', async () => {
      await created();
      await networkIn(ACME_VPC);
      ctx.cloud.replayShowFor(
        'existing-redis',
        lookupWith('aws_elasticache_cluster', { engine: 'memcached' }),
      );

      const { aws } = await lookupOf();

      expect(aws.status === 'failed' && aws.reason).toBe(
        'cache uses the existing cache acme-cache, but acme-cache runs memcached, not Valkey or Redis OSS, so a redis cannot use it',
      );
    });

    it("refuses one carrying Cloudgate's tags", async () => {
      await created();
      await networkIn(ACME_VPC);
      ctx.cloud.replayShowFor(
        'existing-redis',
        lookupWith('aws_elasticache_cluster', {
          tags: {
            'cloudgate:cloud-account': cloudAccountId,
            'cloudgate:environment': 'another-environment',
          },
        }),
      );

      const { aws } = await lookupOf();

      expect(aws.status === 'failed' && aws.reason).toContain(
        "acme-cache carries Cloudgate's tags (cloudgate:cloud-account, cloudgate:environment)",
      );
    });

    it('refuses one in another VPC without the tick', async () => {
      await created();
      await networkIn('vpc-0e0e0e0e');

      const { aws } = await lookupOf();

      expect(aws.status === 'failed' && aws.reason).toContain(
        `acme-cache is in VPC ${ACME_VPC}, not this Environment network's VPC vpc-0e0e0e0e`,
      );
    });
  });

  it.each([
    {
      tls: true,
      url: `rediss://default:${encodeURIComponent(TOKEN)}@${HOST}:6379`,
      ca: ELASTICACHE_CA_BUNDLE,
    },
    {
      tls: false,
      url: `redis://default:${encodeURIComponent(TOKEN)}@${HOST}:6379`,
      ca: undefined,
    },
  ])(
    'applies a linked cloud web with the URL its TLS flag says (TLS $tls), creating no cache',
    async ({ tls, url, ca }) => {
      const redisId = await created({ madeReachable: true, tls });

      const saved = await save(stack(true));
      expect(saved.status).toBe(201);
      const read = await readPlan();
      expect(
        read.steps.map((step) =>
          'configName' in step
            ? `${step.action}:${step.configName}`
            : step.action,
        ),
      ).toEqual(['network-create', 'change:cache', 'create:web']);
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
      const webStateId = webStep.cloudRead.stateId;

      const res = await apply(read.planId);
      expect(res.status).toBe(200);
      const applied = await until(async () => {
        const [found] = await ctx.db
          .select()
          .from(planTable)
          .where(eq(planTable.planId, read.planId));
        return found?.results &&
          !found.results.some((result) => result.status === 'running')
          ? found
          : undefined;
      }, 'the Apply to end');
      const web = applied.results!.find((one) => one.configName === 'web');
      if (web?.deploy?.status !== 'queued') {
        throw new Error('web queued nothing');
      }
      expect((await settled(web.deploy.deploymentId)).status).toBe('done');

      // Nothing applied but the network's and web's: no cache was made.
      const appliedStates = ctx.cloud.calls.flatMap((call) =>
        call.method === 'apply' ? [call.stateId] : [],
      );
      expect(new Set(appliedStates)).toEqual(
        new Set([networkStep.cloudRead.stateId, webStep.cloudRead.stateId]),
      );

      const webApply = ctx.cloud.tofuInputs
        .filter((input) => input.stateId === webStateId)
        .at(-1)!;
      expect(webApply.variables[valueVariable('REDIS_URL')]).toBe(url);
      // `ca` only with TLS on; with it off the variable is left unset.
      expect(webApply.variables[valueVariable('REDIS_CA')]).toBe(ca);
      expect(webApply.definition).not.toContain(TOKEN);

      // Delete is refused while web links to it, and nothing reached AWS.
      const callsBefore = ctx.cloud.calls.length;
      const refused = await request(http)
        .delete(`/redis/${redisId}`)
        .set('Cookie', cookie);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'SERVICE_IS_LINKED' });
      expect(ctx.cloud.calls.length).toBe(callsBefore);
    },
  );

  describe('Delete', () => {
    it("removes only Cloudgate's records, reaches no AWS write, and says the cache was left", async () => {
      const redisId = await created();
      await networkIn(ACME_VPC);
      await lookupOf();
      const callsBefore = ctx.cloud.calls.length;

      const res = await request(http)
        .delete(`/redis/${redisId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.text).not.toContain(TOKEN);
      expect((res.body as { left: unknown }).left).toEqual({
        identifier: 'acme-cache',
        message:
          'acme-cache was left as it was; it is yours. Cloudgate removed only its own records of cache; if the Project config still lists cache, the next plan creates it as a new database.',
      });
      expect(ctx.cloud.calls.slice(callsBefore)).toEqual([]);
      expect(writes()).toEqual([]);
      expect(await ctx.db.select().from(redis)).toEqual([]);
      expect(await ctx.db.select().from(existingDatabase)).toEqual([]);
    });
  });

  describe('What Cloudgate never does to it', () => {
    it('refuses a volume backup', async () => {
      const redisId = await created();

      const res = await request(http)
        .post('/volume-backups')
        .set('Cookie', cookie)
        .send({
          name: 'cache data',
          volumeName: 'cache-data',
          prefix: 'cache',
          schedule: '0 3 * * *',
          serviceType: 'redis',
          serviceId: redisId,
          destinationId: 'any-destination',
        });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'EXISTING_DATABASE_NO_BACKUP' });
    });

    it.each(['start', 'stop', 'rebuild', 'deploy'])(
      'refuses %s with the sentence',
      async (action) => {
        const redisId = await created();

        const res = await request(http)
          .post(`/redis/${redisId}/${action}`)
          .set('Cookie', cookie);

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          message: "Cloudgate uses this database but doesn't manage it.",
          code: 'EXISTING_DATABASE_NOT_MANAGED',
        });
      },
    );

    it('refuses its settings through the ordinary settings write', async () => {
      const redisId = await created();

      const res = await request(http)
        .patch(`/redis/${redisId}`)
        .set('Cookie', cookie)
        .send({ dockerImage: 'redis:7' });

      expect(res.status).toBe(400);
    });
  });
});
