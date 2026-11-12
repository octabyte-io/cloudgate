import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import {
  cloudAccount,
  deployment,
  environmentNetwork,
  infrastructureState,
  redis,
} from '../../src/db/schema';
import { tofuStates } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';

const REDIS = `version: 1
services:
  redis:
    kind: redis
    version: "7"
    size: small
`;

interface Step {
  action: string;
  configName?: string;
  fields?: { field: string; from: unknown; to: unknown }[];
  cache?: Record<string, unknown>;
  majorUpgrade?: { from: string; to: string };
  cloudRead?: {
    status: 'reading' | 'read' | 'failed';
    reason?: string;
    summary?: string[];
    outages?: { kind: string; serviceName: string; line: string }[];
  };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
}

/**
 * Once `redis` runs on ElastiCache, every change the operator makes
 * is planned honestly, as a postgres on RDS's is. A new size is a
 * node-type change marked "may drop connections briefly while it resizes";
 * a new major is shown apart as "may drop connections briefly, cannot be
 * undone" and confirmed at Apply by the Service's name; an older version
 * refuses, naming the Valkey it runs. The console's replica and snapshot
 * retention are Cloudgate's per Service, checked at the API, and shown in
 * the next plan. `ctx.cloud` replays stored change plans (`redis-resize`,
 * `redis-major-upgrade`, `redis-replica-on`).
 */
describe('Changes to a redis on ElastiCache (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };

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
    queue.add.mockClear();
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
          region: 'eu-central-1',
        },
      });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;

    const [network] = await ctx.db
      .insert(environmentNetwork)
      .values({
        environmentId,
        cloudAccountId: row.cloudAccountId,
        region: 'eu-central-1',
        status: 'ready',
        vpcId: 'vpc-0a1b',
        publicSubnetIds: ['subnet-0aaa', 'subnet-0bbb'],
        privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'],
        clusterArn: `arn:aws:ecs:eu-central-1:${ACCOUNT}:cluster/env`,
        httpsListenerArn: `arn:aws:elasticloadbalancing:eu-central-1:${ACCOUNT}:listener/app/env/1/2`,
        albSecurityGroupId: 'sg-0alb',
      })
      .returning();
    // Check for changes reads the made network for Drift too: it has
    // its state, and its read finds nothing to do.
    const [networkState] = await ctx.db
      .insert(infrastructureState)
      .values({ environmentNetworkId: network.environmentNetworkId })
      .returning();
    await ctx.db.insert(tofuStates).values({
      name: networkState.infrastructureStateId,
      data: 'encrypted-by-opentofu',
    });
    ctx.cloud.replayPlanFor('redis', 'redis-create');
  });

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  const checkForChanges = () =>
    request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);

  const apply = (
    planId: string,
    confirm: { confirmDestroy?: string[]; confirmUpgrade?: string[] } = {},
  ) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId, ...confirm });

  const cacheSettings = (redisId: string, body: Record<string, unknown>) =>
    request(http)
      .patch(`/redis/${redisId}/elasticache-settings`)
      .set('Cookie', cookie)
      .send(body);

  /** The open plan once no step is still reading AWS. */
  async function readPlan(): Promise<PlanBody> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const res = await request(http)
        .get(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      const found = (res.body as { plan: PlanBody }).plan;
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        // The network's Drift read is not what these specs are about.
        return {
          ...found,
          steps: found.steps.filter((step) => step.action !== 'network-change'),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading AWS');
  }

  /** A Deployment once its Cloud run has ended. */
  async function ended(deploymentId: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      if (row && row.status !== 'pending' && row.status !== 'running') {
        return row;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The Cloud run did not end');
  }

  /** Applies a plan and waits for the Cloud run its one step queued. */
  async function applyAndRun(
    planId: string,
    confirm: { confirmUpgrade?: string[] } = {},
  ) {
    const applied = await apply(planId, confirm);
    expect(applied.status).toBe(200);
    const { deploy } = (
      applied.body as {
        results: { deploy: { status: string; deploymentId: string } }[];
      }
    ).results[0];
    expect(deploy.status).toBe('queued');
    const run = await ended(deploy.deploymentId);
    expect(run.status).toBe('done');
    return run;
  }

  /** `redis` made on ElastiCache from `REDIS`, then the change plan `fixture` replayed. */
  async function madeOnElastiCache(fixture: string, text = REDIS) {
    expect((await save(text)).status).toBe(201);
    await applyAndRun((await readPlan()).planId);
    ctx.cloud.replayPlanFor('redis', fixture);
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;
    const [made] = await ctx.db.select().from(redis);
    return made;
  }

  /** The replication group's arguments in a tofu run's definition. */
  function groupOf(definition: string): Record<string, unknown> {
    const parsed = JSON.parse(definition) as {
      resource: {
        aws_elasticache_replication_group: {
          cache: Record<string, unknown>;
        };
      };
    };
    return parsed.resource.aws_elasticache_replication_group.cache;
  }

  it('plans a new size as a node-type change marked as dropping connections, and Apply resizes through a Cloud run', async () => {
    const made = await madeOnElastiCache('redis-resize');
    expect(made.elasticacheApplied).toEqual({
      nodeType: null,
      replica: false,
      snapshotRetentionDays: 1,
    });

    expect(
      (await save(REDIS.replace('size: small', 'size: medium'))).status,
    ).toBe(201);
    const plan = await readPlan();

    expect(plan.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'redis',
        fields: [{ field: 'size', from: 'small', to: 'medium' }],
        cache: {
          nodeType: {
            from: 'cache.t4g.small',
            to: 'cache.t4g.medium',
            machine: '2 vCPU, 3.09 GB',
            sizeName: 'medium',
          },
          version: null,
          settings: [],
        },
      }),
    ]);
    const [step] = plan.steps;
    expect(step.majorUpgrade).toBeUndefined();
    expect(step.cloudRead?.status).toBe('read');
    expect(step.cloudRead?.summary).toEqual([
      'redis medium → Valkey on cache.t4g.medium (2 vCPU, 3.09 GB), from cache.t4g.small',
      'redis: may drop connections briefly while it resizes',
    ]);
    expect(step.cloudRead?.outages).toEqual([
      {
        kind: 'restart',
        serviceName: 'redis',
        line: 'redis: may drop connections briefly while it resizes',
      },
    ]);
    // The read planned the replication group's own state with the new type.
    const [read] = ctx.cloud.tofuInputs;
    expect(groupOf(read.definition)).toMatchObject({
      node_type: 'cache.t4g.medium',
      apply_immediately: true,
    });

    const run = await applyAndRun(plan.planId);
    expect(run.title).toBe('Change redis on ElastiCache');

    const written = ctx.cloud.tofuInputs.at(-1)!;
    expect(groupOf(written.definition)).toMatchObject({
      node_type: 'cache.t4g.medium',
    });
    expect(written.definition).not.toContain(written.variables.auth_token);
    // Never started as a container.
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('turns the replica on as one replica in another zone with automatic failover, and snapshots kept longer, with no mark', async () => {
    const made = await madeOnElastiCache('redis-replica-on');

    const saved = await cacheSettings(made.redisId, {
      replica: true,
      snapshotRetentionDays: 7,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).not.toHaveProperty('authToken');
    const [row] = await ctx.db.select().from(redis);
    expect(row).toMatchObject({ replica: true, snapshotRetentionDays: 7 });

    expect((await checkForChanges()).status).toBe(201);
    const plan = await readPlan();
    expect(plan.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'redis',
        fields: [],
        cache: {
          nodeType: null,
          version: null,
          settings: [
            { setting: 'replica', from: false, to: true },
            { setting: 'snapshotRetentionDays', from: 1, to: 7 },
          ],
        },
      }),
    ]);
    const [step] = plan.steps;
    expect(step.cloudRead?.summary).toEqual([
      'redis replica: off → on, one replica in another zone with automatic failover',
      'redis snapshots: daily, kept 1 day → daily, kept 7 days',
    ]);
    expect(step.cloudRead?.outages).toBeUndefined();

    await applyAndRun(plan.planId);

    expect(groupOf(ctx.cloud.tofuInputs.at(-1)!.definition)).toMatchObject({
      num_cache_clusters: 2,
      automatic_failover_enabled: true,
      multi_az_enabled: true,
      snapshot_retention_limit: 7,
    });
    const [applied] = await ctx.db.select().from(redis);
    expect(applied.elasticacheApplied).toEqual({
      nodeType: null,
      replica: true,
      snapshotRetentionDays: 7,
    });
  });

  it('makes a plan made before a console edit stale', async () => {
    const made = await madeOnElastiCache('redis-resize');
    await save(REDIS.replace('size: small', 'size: medium'));
    const plan = await readPlan();

    await cacheSettings(made.redisId, { snapshotRetentionDays: 3 });

    const refused = await apply(plan.planId);
    expect(refused.status).toBe(409);
    expect((refused.body as { code: string }).code).toBe('PLAN_STALE');
  });

  it.each([
    [{ snapshotRetentionDays: 36 }, 'snapshotRetentionDays must be 0 to 35'],
    [{ snapshotRetentionDays: -1 }, 'snapshotRetentionDays must be 0 to 35'],
    [{ replica: 'yes' }, 'replica'],
    [{ nodeType: 'cache.t4g.medium' }, "redis's node type comes from its size"],
  ])('refuses %j through the API, naming why', async (body, message) => {
    const made = await madeOnElastiCache('redis-replica-on');

    const refused = await cacheSettings(made.redisId, body);

    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(message);
    const [row] = await ctx.db.select().from(redis);
    expect(row).toMatchObject({ snapshotRetentionDays: 1, replica: false });
  });

  it('takes 0 as snapshots off', async () => {
    const made = await madeOnElastiCache('redis-replica-on');

    const saved = await cacheSettings(made.redisId, {
      snapshotRetentionDays: 0,
    });

    expect(saved.status).toBe(200);
    const [row] = await ctx.db.select().from(redis);
    expect(row.snapshotRetentionDays).toBe(0);
  });

  it('takes the console node type for an entry with no size, one Cloudgate chooses', async () => {
    const made = await madeOnElastiCache(
      'redis-resize',
      'version: 1\nservices:\n  redis:\n    kind: redis\n    version: "7"\n',
    );
    expect(made.nodeType).toBe('cache.t4g.micro');

    const unknown = await cacheSettings(made.redisId, {
      nodeType: 'cache.r7g.large',
    });
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.body)).toContain(
      'is not a node type Cloudgate chooses',
    );
    const saved = await cacheSettings(made.redisId, {
      nodeType: 'cache.t4g.medium',
    });
    expect(saved.status).toBe(200);

    await checkForChanges();
    const plan = await readPlan();

    expect(plan.steps[0]).toMatchObject({
      action: 'change',
      cache: {
        nodeType: {
          from: 'cache.t4g.micro',
          to: 'cache.t4g.medium',
          sizeName: null,
        },
      },
    });
    expect(
      plan.steps[0].cloudRead?.outages?.map((outage) => outage.kind),
    ).toEqual(['restart']);
  });

  it('refuses ElastiCache settings on a redis on a Server', async () => {
    const made = await madeOnElastiCache('redis-replica-on');
    await ctx.db
      .update(redis)
      .set({ cloudAccountId: null, region: null })
      .where(eq(redis.redisId, made.redisId));

    const refused = await cacheSettings(made.redisId, { replica: true });

    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(
      'does not run on ElastiCache',
    );
  });

  it('shows "7" → "8" apart as a major upgrade and refuses its Apply until the Service is named', async () => {
    await madeOnElastiCache('redis-major-upgrade');

    expect(
      (await save(REDIS.replace('version: "7"', 'version: "8"'))).status,
    ).toBe(201);
    const plan = await readPlan();

    const [step] = plan.steps;
    expect(step).toMatchObject({
      action: 'change',
      configName: 'redis',
      majorUpgrade: { from: '7', to: '8' },
      cache: {
        version: {
          from: '7',
          to: '8',
          engineVersion: '8.1',
          parameterFamily: 'valkey8',
        },
      },
    });
    expect(step.cloudRead?.outages).toEqual([
      {
        kind: 'major-upgrade',
        serviceName: 'redis',
        line: 'redis major upgrade: Valkey 7.2.4 → 8.1, may drop connections briefly, cannot be undone',
      },
    ]);

    const unconfirmed = await apply(plan.planId);
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body).toMatchObject({
      code: 'PLAN_UPGRADE_NOT_CONFIRMED',
    });
    expect((unconfirmed.body as { message: string }).message).toContain(
      'it upgrades to a new major version redis, which the Apply does not confirm',
    );
    const misplaced = await apply(plan.planId, { confirmDestroy: ['redis'] });
    expect(misplaced.status).toBe(409);
    expect(ctx.cloud.calls.filter((call) => call.method === 'apply')).toEqual(
      [],
    );

    await applyAndRun(plan.planId, { confirmUpgrade: ['redis'] });

    const written = JSON.parse(ctx.cloud.tofuInputs.at(-1)!.definition) as {
      resource: Record<string, Record<string, unknown>>;
    };
    expect(
      Object.keys(written.resource.aws_elasticache_parameter_group),
    ).toEqual(['valkey8']);
    expect(groupOf(ctx.cloud.tofuInputs.at(-1)!.definition)).toMatchObject({
      engine_version: '8.1',
    });
    const [row] = await ctx.db.select().from(redis);
    expect(row.dockerImage).toBe('redis:8');
  });

  it('refuses "8" → "7", naming the Valkey redis runs', async () => {
    await madeOnElastiCache(
      'redis-major-upgrade',
      REDIS.replace('version: "7"', 'version: "8"'),
    );

    const refused = await save(REDIS);

    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toContain(
      'redis.version: "7" is older than Valkey 8.1, which redis runs on ElastiCache, and ElastiCache cannot move a cache back to an older version',
    );
  });
});
