import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { existingValkeyEndpointName } from '../../src/cloud-accounts/gcp/definitions/existing-valkey-definition';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import type { MemorystoreInstanceRead } from '../../src/cloud-accounts/google-cloud.port';
import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import {
  application,
  cloudAccount,
  deployment,
  environmentNetwork,
  existingDatabase,
  plan as planTable,
  redis,
  webServerSettings,
} from '../../src/db/schema';
import type { Plan } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { wiredEnv } from '../../src/project-config/outputs';
import { cloudReadOf } from '../../src/project-config/planner/cloud-steps';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(240_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';
const IDENTIFIER = `${PROJECT}/${REGION}/orders-cache`;
const INSTANCE_REF = {
  projectId: PROJECT,
  region: REGION,
  instance: 'orders-cache',
};
const CA =
  '-----BEGIN CERTIFICATE-----\nMIIBexistingvalkeyca\n-----END CERTIFICATE-----';
const PRIMARY =
  'projects/y1a2b3c4d5e6f7-tp/regions/europe-west1/serviceAttachments/gcp-memorystore-auto-a1b2-psc-sa';
const READER =
  'projects/y1a2b3c4d5e6f7-tp/regions/europe-west1/serviceAttachments/gcp-memorystore-auto-a1b2-psc-sa-2';
/** The primary endpoint's address, as the stored apply answers it. */
const PRIMARY_ADDRESS = '10.64.16.20';
const NOT_MANAGED = "Cloudgate uses this database but doesn't manage it.";

/** An operator's instance as a walk made one: cluster mode off, no login, TLS on. */
const INSTANCE: MemorystoreInstanceRead = {
  product: 'valkey',
  engineVersion: 'VALKEY_8_0',
  mode: 'CLUSTER_DISABLED',
  authorizationMode: 'AUTH_DISABLED',
  transitEncryptionMode: 'SERVER_AUTHENTICATION',
  maintenanceVersion: 'MEMORYSTORE_20261008_00_00',
  labels: {},
  serviceAttachments: [
    { serviceAttachment: PRIMARY, connectionType: 'CONNECTION_TYPE_PRIMARY' },
    { serviceAttachment: READER, connectionType: 'CONNECTION_TYPE_READER' },
  ],
  registeredForwardingRules: [],
  ca: CA,
};

const CACHE_ONLY = `version: 1
services:
  cache:
    kind: redis
`;

const STACK = `${CACHE_ONLY}  web:
    kind: web
    size: small
    source: { image: nginx }
    env: [{ REDIS_URL: cache.url }, { REDIS_CA: cache.ca }, { REDIS_PASSWORD: cache.password }]
`;

/**
 * Existing Cloud SQL and Valkey (ADR-0033 as amended
 * on ADR-0042): a Memorystore for Valkey instance made outside
 * Cloudgate, used as an Environment's `redis` on Google Cloud. Each plan
 * reads the instance through the Google client port (`ctx.google`) and
 * refuses with its fix; Cloudgate makes its own two manual endpoints in the
 * Service's own state, hands out `rediss://` with the instance's CA and no
 * password, shows the `--add-endpoints` command until a read finds both
 * registered, and never changes the instance. The stand-in `tofu` replays
 * the stored plan and apply of the two endpoints.
 */
describe('An existing Valkey redis on a Google Cloud Deploy target (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gexvk-'));
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    process.env.CLOUDGATE_DIRECTORY = root;
    // A web's own Deployment is queued and never built here.
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
    // A Google Environment needs the install address its provider names.
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
        policyVersion: 3,
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

    // The network is made, with Memorystore's private link: its subnet is
    // where the endpoints' addresses are, and it opens Redis's ports.
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
        privateLinks: ['memorystore'],
      })
      .returning();
    await ctx.app
      .get(InfrastructureStatesService)
      .create(
        { environmentNetworkId: network.environmentNetworkId },
        'state_net_1',
        'google',
      );

    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.replayPlanFor('existing-redis', 'existing-redis-create');
    ctx.google.replayOutputsFor('existing-redis', 'existing-redis-create');
    ctx.google.memorystoreInstanceAnswers(INSTANCE_REF, INSTANCE);
  });

  const useExisting = (body: Record<string, unknown> = {}) =>
    request(http)
      .post('/redis/existing')
      .set('Cookie', cookie)
      .send({
        environmentId,
        configName: 'cache',
        identifier: IDENTIFIER,
        ...body,
      });

  async function created(): Promise<string> {
    const res = await useExisting();
    expect(res.status).toBe(201);
    return (res.body as { redisId: string }).redisId;
  }

  /** The Environment's latest plan, once every Google read of it has landed. */
  async function planned(text: string): Promise<Plan> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });
    expect(saved.status).toBe(201);
    for (let attempt = 0; attempt < 400; attempt++) {
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
    throw new Error('The plan was still reading Google Cloud');
  }

  function cacheStep(read: Plan) {
    const step = read.steps.find(
      (one) => 'configName' in one && one.configName === 'cache',
    );
    if (step?.action !== 'change') throw new Error('cache has no change step');
    return step;
  }

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

  const apply = (planId: string) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

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

  /** The endpoints' Cloud run for `redisId`, once it ended. */
  function endpointsRun(redisId: string) {
    return until('the endpoints run ended', async () => {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.redisId, redisId));
      return row && ['done', 'error'].includes(row.status) ? row : null;
    });
  }

  async function existingRow() {
    const [row] = await ctx.db.select().from(existingDatabase);
    return row;
  }

  const page = (redisId: string) =>
    request(http).get(`/redis/${redisId}`).set('Cookie', cookie);

  /**
   * What reached the operator's instance beyond a read: only a `tofu` run
   * naming a Memorystore instance, or a port call on one other than its
   * read, could, and none may.
   */
  const instanceTouched = () => [
    ...ctx.google.tofuInputs.filter((input) =>
      input.definition.includes('google_memorystore_instance'),
    ),
    ...ctx.google.calls.filter(
      (call) =>
        /memorystore|backup/i.test(call.method) &&
        call.method !== 'memorystoreInstance',
    ),
  ];

  /** Plan, apply and run the endpoints: the made state of the first Apply. */
  async function madeEndpoints(text = CACHE_ONLY) {
    const redisId = await created();
    const read = await planned(text);
    expect((await apply(read.planId)).status).toBe(200);
    const applied = await settled(read.planId);
    const run = await endpointsRun(redisId);
    expect(run.status).toBe('done');
    return { redisId, read, applied };
  }

  describe('Create', () => {
    it('makes the redis under its Config name, named project/region/instance', async () => {
      const res = await useExisting();

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        configName: 'cache',
        existing: {
          identifier: IDENTIFIER,
          cloudAccountId,
          region: REGION,
          address: null,
          notFound: null,
          registration: null,
        },
      });
    });

    it('refuses an ElastiCache id, which names no instance on Google Cloud', async () => {
      const res = await useExisting({ identifier: 'acme-cache' });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        'project/region/instance',
      );
    });

    it('refuses an AUTH token: Cloudgate reaches only a Valkey with authorization off', async () => {
      const res = await useExisting({ authToken: 'a-sixteen-char-token' });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        'AUTH_DISABLED',
      );
    });

    it("shows the Memorystore read grant for Cloudgate's service account, for an instance in another project", async () => {
      const res = await request(http)
        .get('/redis/existing/reach')
        .query({ environmentId })
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        google: {
          projectId: PROJECT,
          readGrant: `gcloud projects add-iam-policy-binding <instance-project> --member=serviceAccount:${GOOGLE_COLUMNS.deployServiceAccount} --role=roles/memorystore.viewer`,
        },
      });
    });
  });

  describe('Each plan’s lookup', () => {
    it("plans Cloudgate's two endpoints at about $14.60/month together, reading TLS and the CA from the instance", async () => {
      await created();

      const step = cacheStep(await planned(CACHE_ONLY));

      expect(step.cloudRead?.status).toBe('read');
      const summary =
        step.cloudRead?.status === 'read' ? step.cloudRead.summary : [];
      expect(summary).toEqual([
        `cache: existing cache ${IDENTIFIER}, Valkey 8.0, TLS on (rediss://), through Cloudgate's own two endpoints; used as given, Cloudgate changes nothing in it`,
        expect.stringContaining(
          "cache: Cloudgate's two endpoints to shop-prod/europe-west1/orders-cache, its primary's and its reader's, about $14.60/month together",
        ),
        expect.stringMatching(
          /^Private Service Connect endpoint `cloudgate-[a-z2-7]{12}-psc-0`: create, .*about \$7\.30\/month$/,
        ),
        expect.stringMatching(
          /^Private Service Connect endpoint `cloudgate-[a-z2-7]{12}-psc-1`: create, .*about \$7\.30\/month$/,
        ),
      ]);
      expect(await existingRow()).toMatchObject({
        tls: true,
        ca: CA,
        serviceAttachments: { primary: PRIMARY, reader: READER },
        address: null,
        notFoundAt: null,
      });
      // Read, never written.
      expect(
        ctx.google.calls.filter(
          (call) => call.method === 'memorystoreInstance',
        ),
      ).toEqual([
        expect.objectContaining({ ...INSTANCE_REF, impersonated: true }),
      ]);
      expect(instanceTouched()).toEqual([]);
    });

    it.each([
      ['Memorystore for Redis', { product: 'redis' as const }, 'use Valkey'],
      ['cluster mode on', { mode: 'CLUSTER' }, 'cluster mode'],
      ['a login mode', { authorizationMode: 'IAM_AUTH' }, 'AUTH_DISABLED'],
      [
        'an old maintenance version',
        { maintenanceVersion: 'MEMORYSTORE_20250901_00_00' },
        '--maintenance-version=MEMORYSTORE_20251210_02_00',
      ],
      [
        "Cloudgate's labels",
        { labels: { 'cloudgate-state': 'abc' } },
        "Cloudgate's labels",
      ],
    ])('refuses %s, naming its fix', async (_what, change, fix) => {
      ctx.google.memorystoreInstanceAnswers(INSTANCE_REF, {
        ...INSTANCE,
        ...change,
      });
      await created();

      const step = cacheStep(await planned(CACHE_ONLY));

      expect(step.cloudRead?.status).toBe('failed');
      expect(
        step.cloudRead?.status === 'failed' && step.cloudRead.reason,
      ).toContain(fix);
    });
  });

  it("applies the endpoints into the cache's own state, and a web wired to it gets a rediss:// URL at the primary endpoint and the instance's CA, with no password", async () => {
    const { redisId, read } = await madeEndpoints(STACK);

    const step = cacheStep(read);
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.redisId, redisId));
    expect(state).toMatchObject({
      infrastructureStateId:
        step.cloudRead?.status === 'read' ? step.cloudRead.stateId : '',
      provider: 'google',
    });
    expect(
      ctx.google.calls.flatMap((call) =>
        call.method === 'apply' ? [call.kind] : [],
      ),
    ).toContain('existing-redis');
    expect(await existingRow()).toMatchObject({
      address: { host: PRIMARY_ADDRESS, port: 6379 },
      endpoints: [
        expect.objectContaining({
          endpoint: 'primary',
          name: existingValkeyEndpointName(redisId, 'primary'),
          address: PRIMARY_ADDRESS,
          serviceAttachment: PRIMARY,
        }),
        expect.objectContaining({
          endpoint: 'reader',
          name: existingValkeyEndpointName(redisId, 'reader'),
          address: '10.64.16.21',
          serviceAttachment: READER,
        }),
      ],
    });

    const [web] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'web'));
    const env = await wiredEnv(ctx.db, environmentId, web.configLinks);
    expect(env).toEqual({
      REDIS_URL: `rediss://${PRIMARY_ADDRESS}:6379`,
      REDIS_CA: CA,
    });
    expect(env).not.toHaveProperty('REDIS_PASSWORD');
    expect(instanceTouched()).toEqual([]);
  });

  describe('Registration', () => {
    it('shows the --add-endpoints command and "waiting for registration" until a read finds both registered, a linked web deployed meanwhile', async () => {
      const { redisId, applied } = await madeEndpoints(STACK);

      const waiting = await page(redisId);
      expect(waiting.status).toBe(200);
      const registration = (
        waiting.body as {
          existing: {
            registration: {
              status: string;
              sentence: string | null;
              command: string | null;
            };
          };
        }
      ).existing.registration;
      expect(registration.status).toBe('waiting');
      expect(registration.sentence).toContain('waiting for registration');
      const primaryRule = `projects/${PROJECT}/regions/${REGION}/forwardingRules/${existingValkeyEndpointName(redisId, 'primary')}`;
      const readerRule = `projects/${PROJECT}/regions/${REGION}/forwardingRules/${existingValkeyEndpointName(redisId, 'reader')}`;
      expect(registration.command).toContain(
        `gcloud memorystore instances update orders-cache --location=${REGION} --project=${PROJECT} --add-endpoints='`,
      );
      expect(registration.command).toContain(
        `"forwardingRule":"${primaryRule}"`,
      );
      expect(registration.command).toContain(
        `"forwardingRule":"${readerRule}"`,
      );
      expect(registration.command).toContain(
        `"ipAddress":"${PRIMARY_ADDRESS}"`,
      );
      // Linked Services never wait for the operator's step.
      const web = applied.results?.find((one) => one.configName === 'web');
      expect(web?.deploy?.status).toBe('queued');

      // The operator registers both; the next plan's read finds them.
      ctx.google.memorystoreInstanceAnswers(INSTANCE_REF, {
        ...INSTANCE,
        registeredForwardingRules: [
          primaryRule,
          `https://www.googleapis.com/compute/v1/${readerRule}`,
        ],
      });
      ctx.google.replayPlanFor('existing-redis', null);
      ctx.google.replayPlanFor('web', null);
      await planned(STACK);

      const registered = await page(redisId);
      expect(registered.body).toMatchObject({
        existing: {
          registration: { status: 'registered', sentence: null, command: null },
        },
      });
    });
  });

  describe('Over time', () => {
    it('says "Google Cloud cannot find" it on its page once a plan finds it gone', async () => {
      const redisId = await created();
      ctx.google.memorystoreInstanceAnswers(INSTANCE_REF, null);

      const step = cacheStep(await planned(CACHE_ONLY));
      expect(step.cloudRead?.status).toBe('failed');

      expect((await page(redisId)).body).toMatchObject({
        existing: {
          notFound: { sentence: `Google Cloud cannot find ${IDENTIFIER}` },
        },
      });
    });

    it('saves a new CA at Apply, before the web linking it is redeployed', async () => {
      await madeEndpoints(STACK);
      const newCa =
        '-----BEGIN CERTIFICATE-----\nMIIBrotatedvalkeyca\n-----END CERTIFICATE-----';
      ctx.google.memorystoreInstanceAnswers(INSTANCE_REF, {
        ...INSTANCE,
        ca: newCa,
      });
      ctx.google.replayPlanFor('existing-redis', null);
      ctx.google.replayPlanFor('web', null);

      const read = await planned(STACK);

      expect(
        cacheStep(read).cloudRead?.status === 'read' &&
          cacheStep(read).cloudRead,
      ).toMatchObject({
        addressMoved: {
          from: { host: PRIMARY_ADDRESS, port: 6379 },
          to: { host: PRIMARY_ADDRESS, port: 6379 },
          moved: ['cache.ca'],
        },
      });
      expect(await existingRow()).toMatchObject({ ca: CA, foundCa: newCa });
      expect(read.steps.at(-1)).toMatchObject({
        action: 'redeploy',
        configName: 'web',
      });

      expect((await apply(read.planId)).status).toBe(200);
      await settled(read.planId);

      expect(await existingRow()).toMatchObject({ ca: newCa, foundCa: null });
    });
  });

  describe('Lifecycle', () => {
    it.each(['start', 'stop', 'rebuild'])(
      'refuses %s with the exact sentence',
      async (action) => {
        const redisId = await created();

        const res = await request(http)
          .post(`/redis/${redisId}/${action}`)
          .set('Cookie', cookie);

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          message: NOT_MANAGED,
          code: 'EXISTING_DATABASE_NOT_MANAGED',
        });
      },
    );
  });

  /**
   * A switch between a Cloudgate-made and an existing redis is a removal
   * and an add, copying no data, as on AWS (as above).
   */
  describe('Switching', () => {
    const shape = (read: Plan) =>
      read.steps.map((step) =>
        'configName' in step
          ? `${step.action}:${step.configName}`
          : step.action,
      );

    /** A cache Cloudgate made on Memorystore, as an Apply leaves it. */
    async function madeOnMemorystore(): Promise<string> {
      const [cache] = await ctx.db
        .insert(redis)
        .values({
          name: 'cache',
          environmentId,
          configName: 'cache',
          appName: 'cloudgate-cache',
          databasePassword: 'unused-on-memorystore',
          dockerImage: 'redis:8',
          nodeType: 'CUSTOM_PICO',
          cloudAccountId,
          region: REGION,
          applicationStatus: 'done',
          memorystoreEngineVersion: 'VALKEY_8_0',
          memorystoreApplied: {
            highAvailability: false,
            backupRetentionDays: 1,
          },
        })
        .returning();
      await ctx.app
        .get(InfrastructureStatesService)
        .create({ redisId: cache.redisId }, undefined, 'google');
      return cache.redisId;
    }

    it('plans a Cloudgate-made cache switched to an existing Valkey as a destroy and an add, copying no data', async () => {
      const redisId = await madeOnMemorystore();

      const asked = await request(http)
        .post(`/redis/${redisId}/switch/to-existing`)
        .set('Cookie', cookie)
        .send({ identifier: IDENTIFIER });
      expect(asked.status).toBe(200);
      expect(asked.body).toMatchObject({
        switch: { to: 'existing', identifier: IDENTIFIER },
      });

      const read = await planned(CACHE_ONLY);

      expect(shape(read)).toEqual(['destroy:cache', 'create:cache']);
      const [destroy, create] = read.steps;
      expect(destroy).toMatchObject({ action: 'destroy', serviceId: redisId });
      expect(destroy).not.toHaveProperty('existing');
      expect(create).toMatchObject({
        action: 'create',
        kind: 'redis',
        existing: { identifier: IDENTIFIER },
      });
      expect(read.notes).toContainEqual(
        expect.objectContaining({
          kind: 'data-not-copied',
          configName: 'cache',
        }),
      );
      expect(instanceTouched()).toEqual([]);
    });

    it('plans an existing Valkey switched to a Cloudgate-made cache as a removal and a create on Memorystore, copying no data and leaving the instance as it was', async () => {
      const { redisId } = await madeEndpoints();
      ctx.google.replayPlanFor('redis', 'memorystore-create');
      ctx.google.tofuInputs.length = 0;
      ctx.google.calls.length = 0;

      const switched = await request(http)
        .post(`/redis/${redisId}/switch/to-made`)
        .set('Cookie', cookie);
      expect(switched.status).toBe(200);
      expect(switched.body).toMatchObject({ switch: { to: 'made' } });

      const read = await planned(CACHE_ONLY);

      expect(shape(read)).toEqual(
        expect.arrayContaining(['destroy:cache', 'create:cache']),
      );
      expect(read.notes).toContainEqual(
        expect.objectContaining({
          kind: 'data-not-copied',
          configName: 'cache',
        }),
      );
      // The operator's instance is only read.
      expect(
        ctx.google.calls.filter(
          (call) =>
            /memorystore|backup/i.test(call.method) &&
            call.method !== 'memorystoreInstance',
        ),
      ).toEqual([]);
    });
  });

  describe('Delete', () => {
    it('destroys only the two endpoints in its own state, and leaves the instance as it was', async () => {
      const { redisId, read } = await madeEndpoints();
      const stateId =
        cacheStep(read).cloudRead?.status === 'read'
          ? (cacheStep(read).cloudRead as { stateId: string }).stateId
          : '';
      ctx.google.calls.length = 0;

      const res = await request(http)
        .delete(`/redis/${redisId}`)
        .set('Cookie', cookie);
      expect(res.status).toBeLessThan(300);
      await until('cache deleted', async () => {
        const rows = await ctx.db
          .select()
          .from(redis)
          .where(eq(redis.redisId, redisId));
        return rows.length === 0 ? true : null;
      });

      // One destroy, of the cache's own state; nothing else written, no backup.
      expect(
        ctx.google.calls.flatMap((call) =>
          call.method === 'plan' ||
          call.method === 'apply' ||
          call.method === 'destroy'
            ? [[call.method, call.stateId]]
            : [],
        ),
      ).toEqual([['destroy', stateId]]);
      expect(instanceTouched()).toEqual([]);
      expect(await ctx.db.select().from(existingDatabase)).toEqual([]);
      expect(
        await ctx.db
          .select()
          .from(infrastructureState)
          .where(eq(infrastructureState.redisId, redisId)),
      ).toEqual([]);
    });

    it('removes only its records when no endpoint was made yet', async () => {
      const redisId = await created();

      const res = await request(http)
        .delete(`/redis/${redisId}`)
        .set('Cookie', cookie);

      expect(res.status).toBeLessThan(300);
      expect(
        ctx.google.calls.filter((call) => call.method === 'destroy'),
      ).toEqual([]);
      expect(
        await ctx.db.select().from(redis).where(eq(redis.redisId, redisId)),
      ).toEqual([]);
    });
  });
});
