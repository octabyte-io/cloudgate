import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { existingEndpointName } from '../../src/cloud-accounts/gcp/definitions/existing-cloud-sql-definition';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import type { CloudSqlInstanceRead } from '../../src/cloud-accounts/google-cloud.port';
import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import {
  application,
  cloudAccount,
  deployment,
  environmentNetwork,
  existingDatabase,
  plan as planTable,
  postgres,
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
const CONNECTION = `${PROJECT}:${REGION}:acme-prod`;
const INSTANCE_REF = { projectId: PROJECT, instance: 'acme-prod' };
/** The instance's own name, exactly as Google reports it: with its trailing dot. */
const NAME = '4c583468c161.1idghei1xv0vf.europe-west1.sql.goog.';
const CA =
  '-----BEGIN CERTIFICATE-----\nMIIBexistinginstanceca\n-----END CERTIFICATE-----';
/** The apps' login, typed by the operator: a secret, never returned. */
const LOGIN_PASSWORD = 'apps-login-p@ss/w0rd';
const NOT_MANAGED = "Cloudgate uses this database but doesn't manage it.";

/** An operator's instance as a walk made one. */
const INSTANCE: CloudSqlInstanceRead = {
  region: REGION,
  databaseVersion: 'POSTGRES_17',
  labels: {},
  sslMode: 'ENCRYPTED_ONLY',
  pscEnabled: true,
  publicIp: false,
  privateNetwork: null,
  allowedConsumerProjects: [PROJECT],
  serviceAttachment:
    'projects/z1a2b3c4d5e6f7-tp/regions/europe-west1/serviceAttachments/a-4c583468c161-psc-service-attachment-8a1b',
  dnsNames: [
    {
      name: NAME,
      connectionType: 'PRIVATE_SERVICE_CONNECT',
      recordManager: 'CUSTOMER',
    },
  ],
  serverCa: CA,
};

const PG_ONLY = `version: 1
services:
  pg-1:
    kind: postgres
    version: "17"
`;

const STACK = `${PG_ONLY}  web:
    kind: web
    size: small
    source: { image: nginx }
    env: [{ DATABASE_URL: pg-1.url }, { PGHOST: pg-1.host }, { PGSSLROOTCERT: pg-1.ca }]
`;

/**
 * Existing Cloud SQL and Valkey (ADR-0033 as amended): a Cloud SQL `postgres`
 * made outside Cloudgate, used as an Environment's `postgres` on Google Cloud.
 * Each plan reads the instance through the Google client port (`ctx.google`) and
 * refuses with its fix; Cloudgate makes its own manual endpoint and private DNS zone in
 * the Service's own state, hands out the instance's own `….sql.goog.` name
 * with its trailing dot, and never changes the instance. The stand-in
 * `tofu` replays the stored plan of the endpoint and zone.
 */
describe('An existing Cloud SQL postgres on a Google Cloud Deploy target (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gexpg-'));
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

    // The network is made, with Cloud SQL's private link: its subnet is
    // where the endpoint's address is.
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
        privateLinks: ['cloud-sql'],
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
    ctx.google.replayPlanFor('existing-postgres', 'existing-postgres-create');
    ctx.google.replayOutputsFor('existing-postgres', null);
    ctx.google.cloudSqlInstanceAnswers(INSTANCE_REF, INSTANCE);
  });

  const useExisting = (body: Record<string, unknown> = {}) =>
    request(http)
      .post('/postgres/existing')
      .set('Cookie', cookie)
      .send({
        environmentId,
        configName: 'pg-1',
        identifier: CONNECTION,
        databaseUser: 'shop_app',
        databasePassword: LOGIN_PASSWORD,
        databaseName: 'shop',
        ...body,
      });

  async function created(): Promise<string> {
    const res = await useExisting();
    expect(res.status).toBe(201);
    return (res.body as { postgresId: string }).postgresId;
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

  function pgStep(read: Plan) {
    const step = read.steps.find(
      (one) => 'configName' in one && one.configName === 'pg-1',
    );
    if (step?.action !== 'change') throw new Error('pg-1 has no change step');
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

  /** The endpoint's Cloud run for `postgresId`, once it ended. */
  function endpointRun(postgresId: string) {
    return until('the endpoint run ended', async () => {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.postgresId, postgresId));
      return row && ['done', 'error'].includes(row.status) ? row : null;
    });
  }

  async function existingRow() {
    const [row] = await ctx.db.select().from(existingDatabase);
    return row;
  }

  /**
   * What reached the operator's instance beyond a read: the port has no
   * Cloud SQL write, so only a `tofu` run naming an instance could, and
   * none may.
   */
  const instanceTouched = () =>
    ctx.google.tofuInputs.filter((input) =>
      input.definition.includes('google_sql_database_instance'),
    );

  /** Plan, apply and run the endpoint: the made state of the first Apply. */
  async function madeEndpoint(text = PG_ONLY) {
    const postgresId = await created();
    const read = await planned(text);
    expect((await apply(read.planId)).status).toBe(200);
    await settled(read.planId);
    const run = await endpointRun(postgresId);
    expect(run.status).toBe('done');
    return { postgresId, read };
  }

  describe('Create', () => {
    it('makes the postgres under its Config name, named by its connection name, its login never returned', async () => {
      const res = await useExisting();

      expect(res.status).toBe(201);
      expect(res.text).not.toContain(LOGIN_PASSWORD);
      expect(res.body).toMatchObject({
        configName: 'pg-1',
        existing: {
          identifier: CONNECTION,
          cloudAccountId,
          region: REGION,
          address: null,
          hasDatabasePassword: true,
          notFound: null,
          endpoint: null,
        },
      });
    });

    it('refuses an RDS identifier, which names no instance on Google Cloud', async () => {
      const res = await useExisting({ identifier: 'acme-prod' });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        'connection name on Google Cloud: project:region:instance',
      );
    });

    it("shows the read grant for Cloudgate's service account, for an instance in another project", async () => {
      const res = await request(http)
        .get('/postgres/existing/reach')
        .query({ environmentId })
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        securityGroups: [],
        google: {
          projectId: PROJECT,
          serviceAccount: GOOGLE_COLUMNS.deployServiceAccount,
          readGrant: `gcloud projects add-iam-policy-binding <instance-project> --member=serviceAccount:${GOOGLE_COLUMNS.deployServiceAccount} --role=roles/cloudsql.viewer`,
        },
      });
    });
  });

  describe('Each plan’s lookup', () => {
    it('plans the endpoint at about $7.30/month and the zone at about $0.20/month, saving its name with the trailing dot and its CA', async () => {
      await created();

      const read = await planned(PG_ONLY);
      const step = pgStep(read);

      expect(step.cloudRead?.status).toBe('read');
      const summary =
        step.cloudRead?.status === 'read' ? step.cloudRead.summary : [];
      expect(summary).toEqual([
        `pg-1: existing database ${CONNECTION}, PostgreSQL 17, at ${NAME}:5432 through Cloudgate's own endpoint; used as given, Cloudgate changes nothing in it`,
        expect.stringMatching(
          /^Private Service Connect endpoint `cloudgate-[a-z2-7]{12}-psc`: create, .*about \$7\.30\/month$/,
        ),
        expect.stringMatching(/^Private DNS zone for .*about \$0\.20\/month$/),
      ]);
      expect(await existingRow()).toMatchObject({
        address: { host: NAME, port: 5432 },
        ca: CA,
        serviceAttachment: INSTANCE.serviceAttachment,
        notFoundAt: null,
      });
      // Read, never written: the instance only answered a get.
      expect(
        ctx.google.calls.filter((call) => call.method === 'cloudSqlInstance'),
      ).toEqual([
        expect.objectContaining({ ...INSTANCE_REF, impersonated: true }),
      ]);
      expect(instanceTouched()).toEqual([]);
    });

    it("refuses while this Environment's project is not allowed, with a command that keeps the projects listed", async () => {
      ctx.google.cloudSqlInstanceAnswers(INSTANCE_REF, {
        ...INSTANCE,
        allowedConsumerProjects: ['analytics-prod'],
      });
      await created();

      const step = pgStep(await planned(PG_ONLY));

      expect(step.cloudRead?.status).toBe('failed');
      expect(
        step.cloudRead?.status === 'failed' && step.cloudRead.reason,
      ).toContain(`--allowed-psc-projects=analytics-prod,${PROJECT}`);
    });

    it('notes a major version other than the config’s, refusing nothing', async () => {
      await created();

      const step = pgStep(await planned(PG_ONLY.replace('"17"', '"16"')));

      expect(
        step.cloudRead?.status === 'read' && step.cloudRead.summary,
      ).toContain(
        `pg-1: ${CONNECTION} runs PostgreSQL 17, and the config's version is 16; the version is not applied to an existing database`,
      );
    });
  });

  it("applies the endpoint and zone into pg-1's own state, and a web wired to it gets host with the trailing dot, url with sslmode=require, and the instance's CA", async () => {
    const { postgresId, read } = await madeEndpoint(STACK);

    const step = pgStep(read);
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.postgresId, postgresId));
    expect(state).toMatchObject({
      infrastructureStateId:
        step.cloudRead?.status === 'read' ? step.cloudRead.stateId : '',
      provider: 'google',
    });
    expect(
      ctx.google.calls.flatMap((call) =>
        call.method === 'apply' ? [call.kind] : [],
      ),
    ).toContain('existing-postgres');
    expect(await existingRow()).toMatchObject({
      endpointStatus: 'ACCEPTED',
    });

    const [web] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'web'));
    const env = await wiredEnv(ctx.db, environmentId, web.configLinks);
    expect(env).toEqual({
      DATABASE_URL: `postgresql://shop_app:${encodeURIComponent(LOGIN_PASSWORD)}@${NAME}:5432/shop?sslmode=require`,
      PGHOST: NAME,
      PGSSLROOTCERT: CA,
    });
    expect(instanceTouched()).toEqual([]);
  });

  it('plans nothing more once the endpoint and zone are as written', async () => {
    await madeEndpoint();
    ctx.google.replayPlanFor('existing-postgres', null);

    const read = await planned(
      PG_ONLY.replace(
        'kind: postgres',
        'kind: postgres\n    description: orders',
      ),
    );
    const step = pgStep(read);

    expect(step.cloudRead?.status === 'read' && step.cloudRead.raw).toEqual([]);
  });

  describe('A new address', () => {
    it('saves a changed name and CA at Apply, before the web linking them is redeployed', async () => {
      await madeEndpoint(STACK);
      const moved = '9d0e1f2a3b4c.1idghei1xv0vf.europe-west1.sql.goog.';
      const newCa =
        '-----BEGIN CERTIFICATE-----\nMIIBrotatedca\n-----END CERTIFICATE-----';
      ctx.google.cloudSqlInstanceAnswers(INSTANCE_REF, {
        ...INSTANCE,
        dnsNames: [
          {
            name: moved,
            connectionType: 'PRIVATE_SERVICE_CONNECT',
            recordManager: 'CUSTOMER',
          },
        ],
        serverCa: newCa,
      });
      ctx.google.replayPlanFor('web', null);

      const read = await planned(STACK);

      const step = pgStep(read);
      expect(
        step.cloudRead?.status === 'read' && step.cloudRead.addressMoved,
      ).toEqual({
        from: { host: NAME, port: 5432 },
        to: { host: moved, port: 5432 },
        moved: ['pg-1.url', 'pg-1.host', 'pg-1.ca'],
      });
      // Not saved by the plan: deploys keep the old address until the Apply.
      expect(await existingRow()).toMatchObject({
        address: { host: NAME, port: 5432 },
        ca: CA,
        foundCa: newCa,
      });
      expect(read.steps.at(-1)).toMatchObject({
        action: 'redeploy',
        configName: 'web',
      });

      expect((await apply(read.planId)).status).toBe(200);
      await settled(read.planId);

      expect(await existingRow()).toMatchObject({
        address: { host: moved, port: 5432 },
        ca: newCa,
        foundCa: null,
      });
      const [web] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.configName, 'web'));
      const env = await wiredEnv(ctx.db, environmentId, web.configLinks);
      expect(env.PGHOST).toBe(moved);
      expect(env.PGSSLROOTCERT).toBe(newCa);
    });
  });

  describe('Over time', () => {
    it("says on its page when the endpoint isn't accepted, and a linked web is deployed regardless", async () => {
      const postgresId = await created();
      ctx.google.endpointStatusIs(existingEndpointName(postgresId), 'PENDING');
      const read = await planned(STACK);
      expect((await apply(read.planId)).status).toBe(200);
      const applied = await settled(read.planId);
      await endpointRun(postgresId);

      const page = await request(http)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', cookie);
      expect(page.status).toBe(200);
      expect(page.body).toMatchObject({
        existing: {
          endpoint: {
            status: 'PENDING',
            sentence: `Cloudgate's endpoint to ${CONNECTION} is not accepted (PENDING), so linked Services cannot reach it yet. Check that this Environment's project is on the instance's allowed consumer projects; Check for changes reads it again`,
          },
        },
      });
      const web = applied.results?.find((one) => one.configName === 'web');
      expect(web?.deploy?.status).toBe('queued');
    });

    it('says "Google Cloud cannot find" it on its page once a plan finds it gone', async () => {
      const postgresId = await created();
      ctx.google.cloudSqlInstanceAnswers(INSTANCE_REF, null);

      const step = pgStep(await planned(PG_ONLY));
      expect(step.cloudRead?.status).toBe('failed');

      const page = await request(http)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', cookie);
      expect(page.body).toMatchObject({
        existing: {
          notFound: { sentence: `Google Cloud cannot find ${CONNECTION}` },
        },
      });
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
  });

  describe('Delete', () => {
    it('destroys only the endpoint and zone in its own state, and leaves the instance as it was', async () => {
      const { postgresId, read } = await madeEndpoint();
      const stateId =
        pgStep(read).cloudRead?.status === 'read'
          ? (pgStep(read).cloudRead as { stateId: string }).stateId
          : '';
      ctx.google.calls.length = 0;

      const res = await request(http)
        .delete(`/postgres/${postgresId}`)
        .set('Cookie', cookie);
      expect(res.status).toBeLessThan(300);
      await until('pg-1 deleted', async () => {
        const rows = await ctx.db
          .select()
          .from(postgres)
          .where(eq(postgres.postgresId, postgresId));
        return rows.length === 0 ? true : null;
      });

      // One destroy, of pg-1's own state; nothing else written.
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
          .where(eq(infrastructureState.postgresId, postgresId)),
      ).toEqual([]);
    });
  });

  describe('Switching', () => {
    /** A pg-1 Cloudgate made on Cloud SQL, as an Apply leaves it. */
    async function madeOnCloudSql(): Promise<string> {
      const [pg] = await ctx.db
        .insert(postgres)
        .values({
          name: 'pg-1',
          environmentId,
          configName: 'pg-1',
          appName: 'cloudgate-pg-1',
          dockerImage: 'postgres:17',
          databaseName: 'pg_1',
          databaseUser: 'pg_1',
          databasePassword: 'super-secret-database-password',
          cloudAccountId,
          region: REGION,
          instanceClass: 'db-g1-small',
          applicationStatus: 'done',
        })
        .returning();
      await ctx.app
        .get(InfrastructureStatesService)
        .create({ postgresId: pg.postgresId }, undefined, 'google');
      return pg.postgresId;
    }

    it('plans a Cloudgate-made pg-1 switched to an existing Cloud SQL as a destroy keeping a final backup and an add, saying no data is copied', async () => {
      const postgresId = await madeOnCloudSql();

      const asked = await request(http)
        .post(`/postgres/${postgresId}/switch/to-existing`)
        .set('Cookie', cookie)
        .send({
          identifier: CONNECTION,
          databaseUser: 'shop_app',
          databasePassword: LOGIN_PASSWORD,
          databaseName: 'shop',
        });
      expect(asked.status).toBe(200);
      expect(asked.text).not.toContain(LOGIN_PASSWORD);
      expect(asked.body).toMatchObject({
        switch: { to: 'existing', identifier: CONNECTION },
      });

      const read = await planned(PG_ONLY);

      expect(
        read.steps.map((step) =>
          'configName' in step
            ? `${step.action}:${step.configName}`
            : step.action,
        ),
      ).toEqual(['destroy:pg-1', 'create:pg-1']);
      const [destroy, create] = read.steps;
      expect(destroy).toMatchObject({
        action: 'destroy',
        serviceId: postgresId,
        finalSnapshot: {
          name: expect.stringContaining('pg-1-final-') as string,
        },
      });
      expect(destroy).not.toHaveProperty('existing');
      expect(create).toMatchObject({
        action: 'create',
        existing: { identifier: CONNECTION },
      });
      expect(read.notes).toContainEqual({
        kind: 'data-not-copied',
        configName: 'pg-1',
        message: `pg-1: switches to the existing database ${CONNECTION}, which keeps its own data; no data is copied from the database Cloudgate made`,
      });
      // The Cloudgate-made side keeps its destroy guard.
      const unconfirmed = await apply(read.planId);
      expect(unconfirmed.status).toBe(409);
      expect(unconfirmed.body).toMatchObject({
        code: 'PLAN_DESTROY_NOT_CONFIRMED',
      });
    });

    it('plans an existing pg-1 switched to a Cloudgate-made one as a removal and a create on Cloud SQL, copying no data', async () => {
      const { postgresId } = await madeEndpoint();
      ctx.google.replayPlanFor('postgres', 'postgres-create');
      const switched = await request(http)
        .post(`/postgres/${postgresId}/switch/to-made`)
        .set('Cookie', cookie);
      expect(switched.status).toBeLessThan(300);

      const read = await planned(PG_ONLY);

      expect(
        read.steps.map((step) =>
          'configName' in step
            ? `${step.action}:${step.configName}`
            : step.action,
        ),
      ).toEqual(expect.arrayContaining(['destroy:pg-1', 'create:pg-1']));
      expect(read.notes.map((note) => note.message)).toContain(
        `pg-1: the database Cloudgate makes starts empty; no data is copied from the existing database ${CONNECTION}, which is left as it was`,
      );
    });
  });
});
