import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { serviceName } from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import {
  application,
  auditLog,
  cloudAccount,
  deployment,
  environmentNetwork,
  plan as planTable,
  redis,
  webServerSettings,
} from '../../src/db/schema';
import type { Plan, Redis } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { wiredEnv } from '../../src/project-config/outputs';
import { MEMORYSTORE_VALKEY } from '../../src/project-config/planner/memorystore';
import { storedGoogleOutputs } from '../utils/fake-google-cloud-port';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(240_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';

/** Slice 4's sample: a web given the cache's URL and CA through its links. */
const WEB_AND_REDIS = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
    env:
      - REDIS_URL: redis.url
      - REDIS_CA: redis.ca
      - REDIS_PASSWORD: redis.password
  redis:
    kind: redis
    version: "8"
`;

const REDIS_ONLY = (version: string) =>
  `version: 1\nservices:\n  redis:\n    kind: redis\n    version: "${version}"\n`;

const LINK_LINE =
  "Private link: lets this Environment's databases get a private address; made once, kept until the Environment is deleted";
const SUBNET_LINE =
  'Private link subnet `cloudgate-w33lemwkholw-psc` (10.64.16.0/24): create, $0/month';
const POLICY_LINE =
  'Private link for Memorystore (service connection policy `cloudgate-w33lemwkholw-psc-redis`): create, $0/month';
const FIREWALL_LINE =
  'Private link firewall rule `cloudgate-w33lemwkholw-psc-redis-ports` (TCP 6379, 11000–13047): create, $0/month';

/** What the stored Memorystore apply answers, each output's value. */
const CACHE_OUTPUTS = Object.fromEntries(
  Object.entries(storedGoogleOutputs('memorystore-create')).map(
    ([name, output]) => [name, (output as { value: unknown }).value],
  ),
) as { address: string; port: number; ca: string };

interface Step {
  action: string;
  configName?: string;
  fields?: unknown[];
  privateLinks?: string[];
  memorystore?: { lines: string[]; version?: unknown };
  majorUpgrade?: { from: string; to: string };
  cloudRead?: {
    status: 'reading' | 'read' | 'failed';
    reason?: string;
    stateId?: string;
    serviceId?: string;
    summary?: string[];
  };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
}

/**
 * Spec "Redis on Memorystore" and "The private link": on a Google Cloud Deploy
 * target a `redis` becomes a Memorystore for Valkey instance, and the first
 * plan that creates one adds Memorystore's private link — its policy and the
 * firewall rule for Redis's ports, and the subnet when no postgres made it — to
 * the Environment network at $0/month. One Apply makes the link and the
 * instance, which has no password (ADR-0042), so its Cloud run reads no token;
 * the linked `web` gets the `rediss://` URL with no userinfo and the instance's
 * CA at deploy, and a `password` link is left unset. A run that fails after the
 * create, before saving where the instance answers, is run again by the next
 * plan; a change is made in place, a major upgrade only once named; a
 * database's Delete removes only its instance. Against `ctx.google`, whose
 * stand-in `tofu` replays the stored Google plans and apply outputs.
 */
describe('A redis on a Google Cloud Deploy target becomes a Memorystore instance with no password on the private link (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gmem-'));
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    // Every Deployment log is written on the platform host.
    process.env.CLOUDGATE_DIRECTORY = root;
    // The web's own Deployment is queued and never built here.
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
        policyVersion: 2,
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

    ctx.google.replayPlanFor('network', 'network-create-memorystore-link');
    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.replayPlanFor('redis', 'memorystore-create');
    ctx.google.replayOutputsFor('network', 'network-create');
    ctx.google.replayOutputsFor('redis', 'memorystore-create');
  });

  async function currentPlan(): Promise<PlanBody> {
    const res = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: PlanBody }).plan;
  }

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  async function planned(text: string): Promise<PlanBody> {
    expect((await save(text)).status).toBe(201);
    for (let attempt = 0; attempt < 400; attempt++) {
      const found = await currentPlan();
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading Google Cloud');
  }

  const apply = (planId: string, confirm: { confirmUpgrade?: string[] } = {}) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId, ...confirm });

  /** Polls until `check` answers something, or fails naming `what`. */
  async function until<T>(
    what: string,
    check: () => Promise<T | null | undefined>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 600; attempt++) {
      const found = await check();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Never: ${what}`);
  }

  async function settled(planId: string): Promise<Plan> {
    return until('the Apply ended', async () => {
      const [row] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, planId));
      return row.results !== null &&
        !row.results.some((result) => result.status === 'running')
        ? row
        : null;
    });
  }

  /** The redis's row once its Cloud run saved where it answers. */
  function made(): Promise<Redis> {
    return until('redis made on Memorystore', async () => {
      const [row] = await ctx.db
        .select()
        .from(redis)
        .where(eq(redis.configName, 'redis'));
      return row?.memorystoreEndpoint ? row : null;
    });
  }

  /** Each Cloud run of the redis once it has ended, oldest first. */
  function runsOf(redisId: string, count: number) {
    return until(`${count} Cloud runs of redis ended`, async () => {
      const rows = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.redisId, redisId))
        .orderBy(deployment.createdAt);
      return rows.length === count &&
        rows.every(
          (row) => row.status !== 'pending' && row.status !== 'running',
        )
        ? rows
        : null;
    });
  }

  /** The `tofu` runs the fake was asked for, in order, by kind. */
  const tofuRuns = () =>
    ctx.google.calls.flatMap((call) =>
      call.method === 'plan' ||
      call.method === 'apply' ||
      call.method === 'destroy'
        ? [`${call.method} ${call.kind}`]
        : [],
    );

  /** A made Google network in the Environment, with its state, as its Apply leaves it. */
  async function madeNetwork(privateLinks: ('cloud-sql' | 'memorystore')[]) {
    const [network] = await ctx.db
      .insert(environmentNetwork)
      .values({
        environmentId,
        cloudAccountId,
        region: REGION,
        status: 'ready',
        networkName: 'cloudgate-net',
        subnetName: 'cloudgate-subnet',
        ipAddress: '34.117.42.7',
        urlMapName: 'cloudgate-urls',
        certificateMapName: 'cloudgate-certs',
        privateLinks,
      })
      .returning();
    await ctx.app
      .get(InfrastructureStatesService)
      .create(
        { environmentNetworkId: network.environmentNetworkId },
        'state_net_1',
        'google',
      );
    return network;
  }

  /** `redis` made on Memorystore on a made network, by its own plan's Apply. */
  async function madeRedis(version = '8'): Promise<Redis> {
    await madeNetwork(['memorystore']);
    const read = await planned(REDIS_ONLY(version));
    expect((await apply(read.planId)).status).toBe(200);
    const row = await made();
    await runsOf(row.redisId, 1);
    ctx.google.calls.length = 0;
    return row;
  }

  it("shows Memorystore's private link under a new network at $0/month and the instance from the planner; one Apply makes them with no token read, and the web gets the rediss:// URL with no password and the CA at deploy", async () => {
    const read = await planned(WEB_AND_REDIS);

    expect(read.steps.map((step) => [step.action, step.configName])).toEqual([
      ['network-create', undefined],
      ['create', 'redis'],
      ['create', 'web'],
    ]);
    const [network, cache] = read.steps;
    expect(network.privateLinks).toEqual(['memorystore']);
    // No postgres made the subnet, so this plan's link has it.
    expect(network.cloudRead?.summary).toEqual(
      expect.arrayContaining([
        FIREWALL_LINE,
        SUBNET_LINE,
        POLICY_LINE,
        LINK_LINE,
      ]),
    );
    expect(cache.memorystore?.lines).toEqual([
      'redis no size → custom-pico (smallest: 1.08 GB, 1 node)',
      'redis backups: 1 day',
    ]);
    // What the instance is made with, as the plan's read shows it.
    expect(cache.cloudRead?.status).toBe('read');
    expect(cache.cloudRead?.summary).toEqual([
      "Memorystore instance `redis`: create, CUSTOM_PICO, VALKEY_8_0, 1 node, cluster mode off, no password: only this Environment's private network reaches it, over TLS with its own CA, maxmemory-policy noeviction, no deletion protection",
      '`redis` private addresses (primary and reader): create, made by Google with the instance on the private link subnet (10.64.16.0/24), about $14.60/month',
    ]);
    ctx.google.calls.length = 0;

    const res = await apply(read.planId);
    expect(res.status).toBe(200);
    const row = await settled(read.planId);
    expect(row.status).toBe('applied');
    const cacheRow = await made();
    const [run] = await runsOf(cacheRow.redisId, 1);
    expect(run).toMatchObject({
      title: 'Create redis on Memorystore',
      status: 'done',
    });

    // The network and its link first, then the instance, each a Cloud run,
    // and nothing after it: no call names Memorystore's tokens.
    const runs = tofuRuns();
    expect(runs.indexOf('apply redis')).toBeGreaterThan(
      runs.indexOf('apply network'),
    );
    expect(ctx.google.calls.map((call) => call.method)).not.toContainEqual(
      expect.stringMatching(/memorystore|authToken/i),
    );
    expect(JSON.stringify(ctx.google.calls)).not.toMatch(
      /tokenAuthUsers|authTokens/,
    );
    // No password: nothing secret reaches `tofu`.
    expect(
      ctx.google.tofuInputs.filter((input) =>
        input.definition.includes('google_memorystore_instance'),
      ),
    ).toEqual([
      expect.objectContaining({ method: 'plan', variables: {} }),
      expect.objectContaining({ method: 'plan', variables: {} }),
      expect.objectContaining({ method: 'apply', variables: {} }),
    ]);
    const [networkRow] = await ctx.db.select().from(environmentNetwork);
    expect(networkRow.privateLinks).toEqual(['memorystore']);
    expect(cacheRow).toMatchObject({
      redisId: cache.cloudRead?.serviceId,
      cloudAccountId,
      region: REGION,
      nodeType: 'CUSTOM_PICO',
      applicationStatus: 'done',
      memorystoreEndpoint: {
        host: CACHE_OUTPUTS.address,
        port: 6379,
        ca: CACHE_OUTPUTS.ca,
      },
      authToken: null,
    });
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.redisId, cacheRow.redisId));
    expect(state).toMatchObject({
      infrastructureStateId: cache.cloudRead?.stateId,
      provider: 'google',
    });

    // Where it answers and its CA are kept encrypted (ADR-0006).
    const stored = await ctx.db.execute<{ endpoint: string }>(
      sql`SELECT memorystore_endpoint AS endpoint FROM redis WHERE redis_id = ${cacheRow.redisId}`,
    );
    expect(stored.rows[0].endpoint).not.toContain(CACHE_OUTPUTS.address);
    expect(stored.rows[0].endpoint).not.toContain('PLACEHOLDER-MEMORYSTORE');

    // At deploy the web's variables are built from what the run saved: a
    // URL with no userinfo, and no `password` variable at all.
    const [web] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'web'));
    const env = await wiredEnv(ctx.db, environmentId, web.configLinks);
    expect(env).toEqual({
      REDIS_URL: `rediss://${CACHE_OUTPUTS.address}:6379`,
      REDIS_CA: CACHE_OUTPUTS.ca,
    });
    // Never saved on the web's row.
    expect(JSON.stringify(web)).not.toContain('PLACEHOLDER-MEMORYSTORE');
  });

  it("adds only Memorystore's policy and the firewall rule to a network Cloud SQL's link is on, as its own network run before the instance", async () => {
    const network = await madeNetwork(['cloud-sql']);
    ctx.google.replayPlanFor('network', 'memorystore-link-add');

    const read = await planned(REDIS_ONLY('8'));

    expect(read.steps.map((step) => step.action)).toEqual([
      'network-change',
      'create',
    ]);
    expect(read.steps[0]).toMatchObject({
      privateLinks: ['memorystore'],
      cloudRead: {
        status: 'read',
        summary: [FIREWALL_LINE, POLICY_LINE, LINK_LINE],
      },
    });
    ctx.google.calls.length = 0;

    expect((await apply(read.planId)).status).toBe(200);
    await made();
    const linked = await until('the network linked', async () => {
      const [row] = await ctx.db
        .select()
        .from(environmentNetwork)
        .where(
          eq(
            environmentNetwork.environmentNetworkId,
            network.environmentNetworkId,
          ),
        );
      return row.privateLinks.length > 1 ? row : null;
    });
    expect(linked.privateLinks).toEqual(['cloud-sql', 'memorystore']);
    const runs = tofuRuns();
    expect(runs.indexOf('apply redis')).toBeGreaterThan(
      runs.indexOf('apply network'),
    );
  });

  it('adds no second link for another redis once the network has it', async () => {
    await madeNetwork(['memorystore']);

    const read = await planned(REDIS_ONLY('8'));

    expect(read.steps.map((step) => [step.action, step.configName])).toEqual([
      ['create', 'redis'],
    ]);
  });

  it('fails the Cloud run, saying so, when Google answers no address after the create, and hands no URL out; the next plan runs it again, and its Apply saves the url the wired web gets', async () => {
    await madeNetwork(['memorystore']);
    ctx.google.replayOutputsFor('redis', null);
    const read = await planned(REDIS_ONLY('8'));

    expect((await apply(read.planId)).status).toBe(200);
    const [row] = await until('the redis row', async () =>
      (await ctx.db.select().from(redis)).length > 0
        ? ctx.db.select().from(redis)
        : null,
    );
    const [run] = await runsOf(row.redisId, 1);

    expect(run.status).toBe('error');
    expect(run.description).toContain(
      'redis is made, but Google did not answer its primary endpoint and CA. Check for changes, then apply the new plan',
    );
    const [after] = await ctx.db.select().from(redis);
    expect(after).toMatchObject({
      applicationStatus: 'error',
      memorystoreEndpoint: null,
    });
    const links = {
      REDIS_URL: { source: 'redis', output: 'url' },
      REDIS_CA: { source: 'redis', output: 'ca' },
    };
    await expect(wiredEnv(ctx.db, environmentId, links)).rejects.toThrow(
      'redis is not made on Memorystore',
    );
    // A link to its password alone, which has no value, fails it the same.
    await expect(
      wiredEnv(ctx.db, environmentId, {
        REDIS_PASSWORD: { source: 'redis', output: 'password' },
      }),
    ).rejects.toThrow('redis is not made on Memorystore');

    // The instance is in its state now: a plan of it changes nothing on
    // Google, and its apply answers the outputs the first one did not.
    ctx.google.replayPlanFor('redis', null);
    ctx.google.replayOutputsFor('redis', 'memorystore-create');
    const again = await planned(REDIS_ONLY('8'));

    expect(again.steps).toHaveLength(1);
    expect(again.steps[0]).toMatchObject({
      action: 'change',
      configName: 'redis',
      memorystore: { lines: [] },
      cloudRead: { status: 'read' },
    });
    expect((await apply(again.planId)).status).toBe(200);
    const [, rerun] = await runsOf(row.redisId, 2);

    expect(rerun).toMatchObject({
      title: 'Change redis on Memorystore',
      status: 'done',
    });
    const [fixed] = await ctx.db.select().from(redis);
    expect(fixed).toMatchObject({
      applicationStatus: 'done',
      memorystoreEndpoint: {
        host: CACHE_OUTPUTS.address,
        port: 6379,
        ca: CACHE_OUTPUTS.ca,
      },
    });
    expect(await wiredEnv(ctx.db, environmentId, links)).toEqual({
      REDIS_URL: `rediss://${CACHE_OUTPUTS.address}:6379`,
      REDIS_CA: CACHE_OUTPUTS.ca,
    });
    // Made and saved now, it plans nothing more.
    expect((await planned(REDIS_ONLY('8'))).steps).toEqual([]);
  });

  it('moves the node type in place through a Cloud run when the size moves', async () => {
    const row = await madeRedis();
    ctx.google.replayPlanFor('redis', 'memorystore-change');

    const read = await planned(`${REDIS_ONLY('8')}    size: medium\n`);

    const [step] = read.steps;
    expect(step).toMatchObject({
      action: 'change',
      configName: 'redis',
      memorystore: {
        lines: [
          'redis medium → custom-micro (2 GB, 1 node), from custom-pico',
          'redis: may drop connections briefly while it resizes',
        ],
      },
      cloudRead: {
        status: 'read',
        summary: [
          'Memorystore instance `redis`: change, CUSTOM_PICO → CUSTOM_MICRO, in place',
        ],
      },
    });
    expect((await apply(read.planId)).status).toBe(200);
    const [, change] = await runsOf(row.redisId, 2);

    expect(change).toMatchObject({
      title: 'Change redis on Memorystore',
      status: 'done',
    });
    const written = ctx.google.tofuInputs.filter(
      (input) => input.method === 'apply',
    );
    expect(written.at(-1)?.definition).toContain('"node_type": "CUSTOM_MICRO"');
    const [after] = await ctx.db.select().from(redis);
    expect(after.nodeType).toBe('CUSTOM_MICRO');
  });

  it('shows a Valkey major upgrade apart and refuses its Apply until the Service is named, then upgrades in place', async () => {
    const row = await madeRedis();
    ctx.google.replayPlanFor('redis', 'memorystore-upgrade');

    const read = await planned(REDIS_ONLY('9'));

    const [step] = read.steps;
    expect(step).toMatchObject({
      action: 'change',
      majorUpgrade: { from: '8', to: '9' },
      memorystore: {
        lines: [
          'major upgrade 8 → 9: may drop connections briefly, cannot be undone',
        ],
      },
    });
    const unconfirmed = await apply(read.planId);
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body).toMatchObject({
      code: 'PLAN_UPGRADE_NOT_CONFIRMED',
    });
    expect(tofuRuns()).not.toContain('apply redis');

    expect(
      (await apply(read.planId, { confirmUpgrade: ['redis'] })).status,
    ).toBe(200);
    const [, upgrade] = await runsOf(row.redisId, 2);

    expect(upgrade.status).toBe('done');
    const written = ctx.google.tofuInputs.filter(
      (input) => input.method === 'apply',
    );
    expect(written.at(-1)?.definition).toContain(
      '"engine_version": "VALKEY_9_1"',
    );
  });

  // A node type here would be written as the instance's unplanned, and a
  // replica and snapshot days are ElastiCache's settings, not Memorystore's.
  it('refuses the ElastiCache settings of a redis on Memorystore, naming where its own are, and changes nothing', async () => {
    const row = await rowOf((await madeRedis('9')).redisId);
    for (const edit of [
      { nodeType: 'cache.t4g.small' },
      { replica: true },
      { snapshotRetentionDays: 3 },
    ]) {
      const refused = await request(http)
        .patch(`/redis/${row.redisId}/elasticache-settings`)
        .set('Cookie', cookie)
        .send(edit);
      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toBe(
        `redis runs on Memorystore, not ElastiCache, so it has no ElastiCache settings: its node type is its size's, or its native.gcp node_type's, in the Project config, and its high availability and backup retention are its Memorystore settings (PATCH /redis/${row.redisId}/memorystore-settings)`,
      );
    }
    expect(await rowOf(row.redisId)).toMatchObject({
      nodeType: row.nodeType,
      replica: row.replica,
      snapshotRetentionDays: row.snapshotRetentionDays,
    });
  });

  it('refuses a downgrade, naming the Valkey version it runs', async () => {
    await madeRedis('9');

    const refused = await save(REDIS_ONLY('8'));

    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toContain(
      'redis.version: "8" is older than Valkey 9.1, which redis runs on Memorystore',
    );
  });

  describe('a version naming only its major keeps the minor it was made on', () => {
    const offered = MEMORYSTORE_VALKEY.versions as string[];

    // Google now offers a newer Valkey 9 minor than the one `redis` is made on.
    beforeEach(() => {
      offered.push('9.2');
    });

    afterEach(() => {
      offered.splice(offered.indexOf('9.2'), 1);
    });

    /** The `engine_version` the last `tofu apply` of the instance wrote. */
    function appliedEngineVersion(): unknown {
      const [input] = ctx.google.tofuInputs
        .filter(
          (one) =>
            one.method === 'apply' &&
            one.definition.includes('google_memorystore_instance'),
        )
        .slice(-1);
      const parsed = JSON.parse(input.definition) as {
        resource: {
          google_memorystore_instance: { cache: { engine_version: unknown } };
        };
      };
      return parsed.resource.google_memorystore_instance.cache.engine_version;
    }

    /** `redis` made with `version: "9"` while Valkey 9.1 was the newest 9. */
    async function madeOnNineOne(): Promise<Redis> {
      offered.splice(offered.indexOf('9.2'), 1);
      try {
        const row = await madeRedis('9');
        expect(await rowOf(row.redisId)).toMatchObject({
          memorystoreEngineVersion: 'VALKEY_9_1',
        });
        return row;
      } finally {
        offered.push('9.2');
      }
    }

    it('plans nothing once Google offers a newer minor, and a resize Apply keeps VALKEY_9_1', async () => {
      const row = await madeOnNineOne();

      expect((await planned(REDIS_ONLY('9'))).steps).toEqual([]);

      ctx.google.replayPlanFor('redis', 'memorystore-change');
      const read = await planned(`${REDIS_ONLY('9')}    size: medium\n`);
      expect(read.steps[0]).toMatchObject({
        action: 'change',
        memorystore: {
          version: null,
          lines: [
            'redis medium → custom-micro (2 GB, 1 node), from custom-pico',
            'redis: may drop connections briefly while it resizes',
          ],
        },
      });
      expect((await apply(read.planId)).status).toBe(200);
      await runsOf(row.redisId, 2);

      expect(appliedEngineVersion()).toBe('VALKEY_9_1');
      expect(await rowOf(row.redisId)).toMatchObject({
        nodeType: 'CUSTOM_MICRO',
        memorystoreEngineVersion: 'VALKEY_9_1',
      });
    });

    it('keeps VALKEY_9_1 through a high availability Apply', async () => {
      const row = await madeOnNineOne();
      const saved = await request(http)
        .patch(`/redis/${row.redisId}/memorystore-settings`)
        .set('Cookie', cookie)
        .send({ highAvailability: true });
      expect(saved.status).toBe(200);
      ctx.google.replayPlanFor('redis', 'memorystore-replica-add');

      const read = await planned(REDIS_ONLY('9'));
      expect(read.steps[0].memorystore).toMatchObject({ version: null });
      expect((await apply(read.planId)).status).toBe(200);
      await runsOf(row.redisId, 2);

      expect(appliedEngineVersion()).toBe('VALKEY_9_1');
    });

    it('moves to the newer minor only through a planned version change', async () => {
      const row = await madeOnNineOne();
      ctx.google.replayPlanFor('redis', 'memorystore-upgrade');

      const read = await planned(REDIS_ONLY('9.2'));

      expect(read.steps[0]).toMatchObject({
        action: 'change',
        memorystore: {
          version: { from: '9', to: '9.2', engineVersion: 'VALKEY_9_2' },
          lines: ['redis version: Valkey 9.1 → 9.2'],
        },
      });
      expect(read.steps[0].majorUpgrade).toBeUndefined();
      expect((await apply(read.planId)).status).toBe(200);
      await runsOf(row.redisId, 2);

      expect(appliedEngineVersion()).toBe('VALKEY_9_2');
      expect(await rowOf(row.redisId)).toMatchObject({
        memorystoreEngineVersion: 'VALKEY_9_2',
      });
    });
  });

  async function rowOf(redisId: string): Promise<Redis> {
    const [row] = await ctx.db
      .select()
      .from(redis)
      .where(eq(redis.redisId, redisId));
    return row;
  }

  it('answers where the instance is and no password, and refuses a password edit, writing nothing', async () => {
    const row = await madeRedis();

    const shown = await request(http)
      .get(`/redis/${row.redisId}`)
      .set('Cookie', cookie);
    expect(shown.status).toBe(200);
    expect(shown.body).not.toHaveProperty('databasePassword');
    expect(shown.body).toMatchObject({
      memorystoreEndpoint: { host: CACHE_OUTPUTS.address, port: 6379 },
      hasAuthToken: false,
    });

    const refused = await request(http)
      .patch(`/redis/${row.redisId}`)
      .set('Cookie', cookie)
      .send({ databasePassword: 'a-new-password' });
    expect(refused.status).toBe(400);
    expect((refused.body as { message: string }).message).toBe(
      "redis runs on Memorystore, which has no password: only this Environment's private network reaches it, over TLS",
    );
    const after = await rowOf(row.redisId);
    expect(after.databasePassword).toBe(row.databasePassword);
    expect(after.wiredChangedAt).toEqual(row.wiredChangedAt);
  });

  it('answers a caller who may not edit the redis as for one it cannot reach, never naming its cloud', async () => {
    const row = await madeRedis();
    // A member with no access to the Project, and the owner of another
    // Organization.
    const member = await signUpMember(http, cookie);
    const mallory = await secondOrganizationOwner(http, ctx.db, cookie);

    for (const caller of [member.cookie, mallory.cookie]) {
      const refused = await request(http)
        .patch(`/redis/${row.redisId}`)
        .set('Cookie', caller)
        .send({ databasePassword: 'a-new-password' });

      expect([403, 404]).toContain(refused.status);
      expect(JSON.stringify(refused.body)).not.toMatch(
        /Memorystore|runs on|password/,
      );
    }
    expect((await rowOf(row.redisId)).databasePassword).toBe(
      row.databasePassword,
    );
  });

  it('is made keeping a day of backups, and plans a retention edited on its Backups tab as an in-place change its Apply makes', async () => {
    const row = await madeRedis();
    expect(await rowOf(row.redisId)).toMatchObject({
      memorystoreBackupRetentionDays: 1,
      memorystoreApplied: { highAvailability: false, backupRetentionDays: 1 },
    });
    const backupsWritten = () => {
      const [input] = ctx.google.tofuInputs
        .filter(
          (one) =>
            one.method === 'apply' &&
            one.definition.includes('google_memorystore_instance'),
        )
        .slice(-1);
      const parsed = JSON.parse(input.definition) as {
        resource: {
          google_memorystore_instance: {
            cache: { automated_backup_config?: unknown };
          };
        };
      };
      return parsed.resource.google_memorystore_instance.cache
        .automated_backup_config;
    };
    expect(backupsWritten()).toEqual({
      fixed_frequency_schedule: { start_time: { hours: 3 } },
      retention: '86400s',
    });

    const saved = await request(http)
      .patch(`/redis/${row.redisId}/memorystore-settings`)
      .set('Cookie', cookie)
      .send({ backupRetentionDays: 7 });
    expect(saved.status).toBe(200);
    ctx.google.replayPlanFor('redis', 'memorystore-change');
    const read = await planned(REDIS_ONLY('8'));

    expect(read.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'redis',
        fields: [],
        memorystore: expect.objectContaining({
          backupRetentionDays: { from: 1, to: 7 },
          lines: ['redis backups: 1 day → 7 days'],
        }) as unknown,
      }),
    ]);
    expect((await apply(read.planId)).status).toBe(200);
    await runsOf(row.redisId, 2);

    expect(backupsWritten()).toMatchObject({ retention: '604800s' });
    expect((await rowOf(row.redisId)).memorystoreApplied).toEqual({
      highAvailability: false,
      backupRetentionDays: 7,
    });
    ctx.google.replayPlanFor('redis', null);
    expect((await planned(REDIS_ONLY('8'))).steps).toEqual([]);
  });

  it('catches a redis made before backups up: one in-place change, with no restart mark, writes its retention, and its Apply records it', async () => {
    const row = await madeRedis();
    // As one made before backups reads: no retention in what its Apply wrote.
    await ctx.db
      .update(redis)
      .set({ memorystoreApplied: { highAvailability: false } })
      .where(eq(redis.redisId, row.redisId));
    ctx.google.replayPlanFor('redis', 'memorystore-change');
    ctx.google.tofuInputs.length = 0;
    const read = await planned(REDIS_ONLY('8'));

    expect(read.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'redis',
        fields: [],
        memorystore: expect.objectContaining({
          backupRetentionDays: { from: 0, to: 1 },
          lines: ['redis backups: off → 1 day'],
        }) as unknown,
      }),
    ]);
    // The read writes the retention it catches up to.
    const readDefinition = ctx.google.tofuInputs.find(
      (one) =>
        one.method === 'plan' &&
        one.definition.includes('google_memorystore_instance'),
    )!.definition;
    expect(readDefinition).toContain('"retention": "86400s"');
    expect((await apply(read.planId)).status).toBe(200);
    await runsOf(row.redisId, 2);

    const applied = ctx.google.tofuInputs
      .filter(
        (one) =>
          one.method === 'apply' &&
          one.definition.includes('google_memorystore_instance'),
      )
      .slice(-1)[0].definition;
    expect(applied).toContain('"retention": "86400s"');
    expect((await rowOf(row.redisId)).memorystoreApplied).toEqual({
      highAvailability: false,
      backupRetentionDays: 1,
    });
    ctx.google.replayPlanFor('redis', null);
    expect((await planned(REDIS_ONLY('8'))).steps).toEqual([]);
  });

  describe('high availability, a console setting', () => {
    const settings = (redisId: string, body: unknown) =>
      request(http)
        .patch(`/redis/${redisId}/memorystore-settings`)
        .set('Cookie', cookie)
        .send(body as object);

    /** The `replica_count` the last `tofu apply` of the instance wrote. */
    function appliedReplicas(): unknown {
      const [input] = ctx.google.tofuInputs
        .filter(
          (one) =>
            one.method === 'apply' &&
            one.definition.includes('google_memorystore_instance'),
        )
        .slice(-1);
      const parsed = JSON.parse(input.definition) as {
        resource: {
          google_memorystore_instance: { cache: { replica_count: unknown } };
        };
      };
      return parsed.resource.google_memorystore_instance.cache.replica_count;
    }

    /** `redis` made, with high availability on and applied. */
    async function madeAvailable(): Promise<Redis> {
      const row = await madeRedis();
      await ctx.db
        .update(redis)
        .set({
          memorystoreHighAvailability: true,
          memorystoreApplied: {
            highAvailability: true,
            backupRetentionDays: 1,
          },
        })
        .where(eq(redis.redisId, row.redisId));
      return row;
    }

    it('is off on a new one; turned on, the next plan adds a replica in place, naming 2 nodes, and its Apply makes one replica', async () => {
      const row = await madeRedis();
      const shown = await request(http)
        .get(`/redis/${row.redisId}`)
        .set('Cookie', cookie);
      expect(shown.body).toMatchObject({
        memorystore: { highAvailability: false },
      });
      expect((await rowOf(row.redisId)).memorystoreApplied).toEqual({
        highAvailability: false,
        backupRetentionDays: 1,
      });

      const saved = await settings(row.redisId, { highAvailability: true });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        memorystore: { highAvailability: true },
      });
      ctx.google.replayPlanFor('redis', 'memorystore-replica-add');

      const read = await planned(REDIS_ONLY('8'));

      expect(read.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'redis',
          fields: [],
          memorystore: expect.objectContaining({
            highAvailability: { from: false, to: true },
            lines: [
              'redis → custom-pico (1.08 GB, 2 nodes), from 1 node',
              'redis high availability: off → on, one replica in another zone, added in place; about double the node cost',
            ],
          }) as unknown,
          cloudRead: expect.objectContaining({
            status: 'read',
            summary: [
              'Memorystore instance `redis`: change, 1 node → 2 nodes, in place',
            ],
          }) as unknown,
        }),
      ]);
      expect((await apply(read.planId)).status).toBe(200);
      const [, change] = await runsOf(row.redisId, 2);

      expect(change).toMatchObject({
        title: 'Change redis on Memorystore',
        status: 'done',
      });
      expect(appliedReplicas()).toBe(1);
      expect((await rowOf(row.redisId)).memorystoreApplied).toEqual({
        highAvailability: true,
        backupRetentionDays: 1,
      });
      // Made: the next plan has nothing to do.
      expect((await planned(REDIS_ONLY('8'))).steps).toEqual([]);
    });

    it('turned off again, plans the replica removed, and its Apply leaves one node', async () => {
      const row = await madeAvailable();

      expect(
        (await settings(row.redisId, { highAvailability: false })).status,
      ).toBe(200);
      ctx.google.replayPlanFor('redis', 'memorystore-replica-remove');
      const read = await planned(REDIS_ONLY('8'));

      expect(read.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          memorystore: expect.objectContaining({
            highAvailability: { from: true, to: false },
            lines: [
              'redis → custom-pico (1.08 GB, 1 node), from 2 nodes',
              'redis high availability: on → off, its replica removed in place; one node',
            ],
          }) as unknown,
          cloudRead: expect.objectContaining({
            summary: [
              'Memorystore instance `redis`: change, 2 nodes → 1 node, in place',
            ],
          }) as unknown,
        }),
      ]);
      expect((await apply(read.planId)).status).toBe(200);
      await runsOf(row.redisId, 2);
      expect(appliedReplicas()).toBe(0);
      expect((await rowOf(row.redisId)).memorystoreApplied).toEqual({
        highAvailability: false,
        backupRetentionDays: 1,
      });
    });

    it('is never moved by a plan from the Project config, whose change keeps the replica', async () => {
      const row = await madeAvailable();
      ctx.google.replayPlanFor('redis', 'memorystore-change');

      const read = await planned(`${REDIS_ONLY('8')}    size: medium\n`);

      expect(read.steps[0].memorystore?.lines).toEqual([
        'redis medium → custom-micro (2 GB, 2 nodes), from custom-pico',
        'redis: may drop connections briefly while it resizes',
      ]);
      expect((await apply(read.planId)).status).toBe(200);
      await runsOf(row.redisId, 2);
      expect(appliedReplicas()).toBe(1);
      expect(await rowOf(row.redisId)).toMatchObject({
        memorystoreHighAvailability: true,
        memorystoreApplied: { highAvailability: true },
      });
      // The config has no such setting to write.
      const refused = await save(
        `${REDIS_ONLY('8')}    highAvailability: true\n`,
      );
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
    });

    /**
     * ADR-0044 rule 10: a `replica_count` the config's
     * `native.gcp` sets wins, the Database page refuses to change it and
     * says why, and taking the key out leaves it where it is and hands it
     * back to the page.
     */
    it('lets native replica_count win, refuses it on the Database page while native sets it, and hands it back where it is once taken out', async () => {
      const row = await madeRedis();
      const NATIVE = `${REDIS_ONLY('8')}    native:
      gcp:
        "google_memorystore_instance.cache":
          replica_count: 1
          engine_configs:
            maxmemory-policy: allkeys-lru
`;
      ctx.google.replayPlanFor('redis', 'memorystore-replica-add');
      const read = await planned(NATIVE);
      expect(read.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'redis',
          fields: [
            {
              field:
                'native.gcp."google_memorystore_instance.cache".replica_count',
              from: 0,
              to: 1,
              native: true,
              fromConsole: true,
            },
            {
              field:
                'native.gcp."google_memorystore_instance.cache".engine_configs.maxmemory-policy',
              from: 'noeviction',
              to: 'allkeys-lru',
              native: true,
              fromDefault: true,
            },
          ],
        }),
      ]);
      expect((await apply(read.planId)).status).toBe(200);
      await runsOf(row.redisId, 2);
      expect(appliedReplicas()).toBe(1);
      expect(await rowOf(row.redisId)).toMatchObject({
        memorystoreHighAvailability: true,
        memorystoreApplied: { highAvailability: true },
        nativeGcp: {
          'google_memorystore_instance.cache': {
            replica_count: 1,
            engine_configs: { 'maxmemory-policy': 'allkeys-lru' },
          },
        },
      });

      const refused = await settings(row.redisId, { highAvailability: false });
      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        'highAvailability is set by redis.native.gcp."google_memorystore_instance.cache".replica_count in the Project config, which owns it while it sets it; change it there, or take the key out to hand it back to this page',
      );
      expect(await rowOf(row.redisId)).toMatchObject({
        memorystoreHighAvailability: true,
      });

      // Taken out: handed back to the console with its replica, never one node.
      ctx.google.replayPlanFor('redis', 'memorystore-change');
      const removed = await planned(REDIS_ONLY('8'));
      expect(removed.steps[0]).toMatchObject({
        action: 'change',
        fields: expect.arrayContaining([
          {
            field:
              'native.gcp."google_memorystore_instance.cache".replica_count',
            from: 1,
            to: 1,
            native: true,
            toConsole: true,
          },
        ]) as unknown,
      });
      expect((await apply(removed.planId)).status).toBe(200);
      await runsOf(row.redisId, 3);
      expect(appliedReplicas()).toBe(1);
      expect(await rowOf(row.redisId)).toMatchObject({
        memorystoreHighAvailability: true,
        nativeGcp: null,
      });
      expect(
        (await settings(row.redisId, { highAvailability: false })).status,
      ).toBe(200);
    });

    it.each([
      [{ highAvailability: 'yes' }],
      [{ highAvailability: true, replicas: 2 }],
      [{}],
    ])('refuses %j, saving nothing', async (body) => {
      const row = await madeRedis();

      expect((await settings(row.redisId, body)).status).toBe(400);
      expect(await rowOf(row.redisId)).toMatchObject({
        memorystoreHighAvailability: false,
      });
    });

    it('is refused for a redis not on Memorystore, and none is offered', async () => {
      const [local] = await ctx.db
        .insert(redis)
        .values({
          name: 'cache',
          configName: 'cache',
          appName: 'cache-local',
          databasePassword: 'local-password',
          dockerImage: 'redis:8',
          environmentId,
        })
        .returning();

      const refused = await settings(local.redisId, {
        highAvailability: true,
      });

      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toBe(
        'cache does not run on Memorystore, so it has no high availability setting: that is a setting of a redis Cloudgate makes on Google Cloud',
      );
      const shown = await request(http)
        .get(`/redis/${local.redisId}`)
        .set('Cookie', cookie);
      expect(shown.body).toMatchObject({ memorystore: null });
      expect(await rowOf(local.redisId)).toMatchObject({
        memorystoreHighAvailability: false,
      });
    });
  });

  /**
   * A Memorystore `redis` has no deletion protection, and its Delete
   * takes one on-demand backup with the id
   * `<project>-<environment>-<service>-final-<date>` and no TTL, then
   * destroys, naming the backup once as kept; asked to delete its data, it
   * takes none.
   */
  describe('Delete', () => {
    const BACKUP = () =>
      `shop-production-redis-final-${new Date().toISOString().slice(0, 10)}`;
    /** What reached Google before and at the destroy, in order. */
    const steps = () =>
      ctx.google.calls.flatMap((call) =>
        call.method === 'takeMemorystoreBackup'
          ? [`backup ${call.backupId}`]
          : call.method === 'plan' ||
              call.method === 'apply' ||
              call.method === 'destroy'
            ? [`${call.method} ${call.kind}`]
            : [],
      );

    async function deleted(row: Redis, query = '') {
      const res = await request(http)
        .delete(`/redis/${row.redisId}${query}`)
        .set('Cookie', cookie);
      expect(res.status).toBeLessThan(300);
      await until('redis deleted', async () => {
        const rows = await ctx.db
          .select()
          .from(redis)
          .where(eq(redis.redisId, row.redisId));
        return rows.length === 0 ? true : null;
      });
      const entry = (
        await ctx.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.resourceId, row.redisId))
      ).find((one) =>
        (one.metadata ?? '').includes('"cloudDelete":"finished"'),
      );
      return {
        body: res.body as { cloudDelete: { finalSnapshot: string | null } },
        report: JSON.parse(entry!.metadata!) as {
          kept: unknown[];
          dataDeleted: boolean;
        },
      };
    }

    it("takes the backup with its id and no TTL, then destroys only the instance and its own address, listing the backup once as kept; the link stays in the network's state", async () => {
      const row = await madeRedis();
      ctx.google.replayPlanFor('destroy', 'memorystore-destroy');
      const [state] = await ctx.db
        .select()
        .from(infrastructureState)
        .where(eq(infrastructureState.redisId, row.redisId));

      const { body, report } = await deleted(row);

      expect(body.cloudDelete.finalSnapshot).toBe(BACKUP());
      expect(steps()).toEqual([`backup ${BACKUP()}`, 'destroy destroy']);
      // The port takes no TTL: Google keeps it 100 years.
      expect(
        ctx.google.calls.find(
          (call) => call.method === 'takeMemorystoreBackup',
        ),
      ).toEqual({
        method: 'takeMemorystoreBackup',
        impersonated: true,
        projectId: PROJECT,
        region: REGION,
        name: serviceName(row.redisId),
        backupId: BACKUP(),
      });
      expect(
        ctx.google.calls.find((call) => call.method === 'destroy'),
      ).toMatchObject({ stateId: state.infrastructureStateId });
      // No deletion protection to lift on Memorystore.
      expect(
        ctx.google.calls.filter(
          (call) => call.method === 'liftCloudSqlDeletionProtection',
        ),
      ).toEqual([]);
      expect(report).toMatchObject({
        dataDeleted: false,
        kept: [
          {
            type: 'memorystore:backup',
            awsId: BACKUP(),
            region: REGION,
            size: '1.07 GB',
            cost: 'about $0.09 a month until you delete it in Google Cloud',
          },
        ],
      });

      const states = await ctx.db.select().from(infrastructureState);
      expect(states.map((one) => one.redisId)).toEqual([null]);
      const [after] = await ctx.db.select().from(environmentNetwork);
      expect(after.privateLinks).toEqual(['memorystore']);
    });

    it('asked to delete its data, takes no backup and lists nothing kept', async () => {
      const row = await madeRedis();
      ctx.google.replayPlanFor('destroy', 'memorystore-destroy');

      const { body, report } = await deleted(row, '?deleteData=true');

      expect(body.cloudDelete.finalSnapshot).toBeNull();
      expect(steps()).toEqual(['destroy destroy']);
      expect(report).toMatchObject({ dataDeleted: true, kept: [] });
    });

    it("names the backup and about what it costs a month in the Delete dialog's preview, from its node's writable memory", async () => {
      const row = await madeRedis();

      const preview = await request(http)
        .get(`/redis/${row.redisId}/final-snapshot`)
        .set('Cookie', cookie);

      expect(preview.status).toBe(200);
      // custom-pico: 1.08 GB writable, at about $0.081 a GB-month.
      expect(preview.body).toEqual({
        cloud: 'gcp',
        name: BACKUP(),
        region: REGION,
        sizeGb: 1.08,
        monthlyUsd: 0.09,
        sentence: `keeps backup ${BACKUP()}, about $0.09 a month, until you delete it in Google Cloud`,
      });
    });
  });
});
