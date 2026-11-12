import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { serviceName } from '../../src/cloud-accounts/gcp/definitions/names';
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
  mysql,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import type { Plan } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { wiredEnv } from '../../src/project-config/outputs';
import { storedGoogleOutputs } from '../utils/fake-google-cloud-port';
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

/** A web given my-1's URL and CA through its links. */
const WEB_AND_MYSQL = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
    env: [{ DATABASE_URL: my-1.url }, { MYSQL_CA: my-1.ca }, { MYSQL_HOST: my-1.host }]
  my-1:
    kind: mysql
    size: small
`;

const MYSQL_ONLY = `version: 1
services:
  my-1:
    kind: mysql
    size: small
`;

/** What a made Cloud SQL for MySQL instance's apply answers (as walked). */
const OUTPUTS = Object.fromEntries(
  Object.entries(storedGoogleOutputs('mysql-create')).map(([name, output]) => [
    name,
    (output as { value: string }).value,
  ]),
) as { dns_name: string; ca: string };

const CONNECTION = `${PROJECT}:${REGION}:acme-mysql`;
const INSTANCE_REF = { projectId: PROJECT, instance: 'acme-mysql' };
/** The instance's own name, exactly as Google reports it: with its trailing dot. */
const NAME = '4c583468c161.1idghei1xv0vf.europe-west1.sql.goog.';
const CA =
  '-----BEGIN CERTIFICATE-----\nMIIBexistingmysqlca\n-----END CERTIFICATE-----';
const LOGIN_PASSWORD = 'apps-login-p@ss/w0rd';

/** An operator's MySQL instance, as a walk made one. */
const INSTANCE: CloudSqlInstanceRead = {
  region: REGION,
  databaseVersion: 'MYSQL_8_4',
  labels: {},
  sslMode: 'ALLOW_UNENCRYPTED_AND_ENCRYPTED',
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

interface Step {
  action: string;
  configName?: string;
  cloudSql?: { lines: string[] };
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
 * `mysql` on Cloud SQL: on a Google Cloud Deploy
 * target a `mysql` becomes a Cloud SQL for MySQL instance, by `postgres` on
 * Cloud SQL's definition, runs, Backups tab, Stop and Start, Delete and
 * Existing database, with MySQL's parameters: its version, TLS offered and
 * not required, port 3306 and a password for its `root`. Against
 * `ctx.google`, whose stand-in `tofu` replays the stored Google plans.
 */
describe('A mysql on a Google Cloud Deploy target is a Cloud SQL for MySQL instance (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gmy-'));
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    process.env.CLOUDGATE_DIRECTORY = root;
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

    // The network is made, with Cloud SQL's private link.
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
    ctx.google.replayPlanFor('mysql', 'mysql-create');
    ctx.google.replayOutputsFor('mysql', 'mysql-create');
    // An existing instance's endpoint and zone are engine-blind.
    ctx.google.replayPlanFor('existing-postgres', 'existing-mysql-create');
    ctx.google.replayOutputsFor('existing-postgres', null);
    ctx.google.cloudSqlInstanceAnswers(INSTANCE_REF, INSTANCE);
  });

  async function currentPlan(): Promise<PlanBody> {
    const res = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: PlanBody }).plan;
  }

  async function planned(text: string): Promise<PlanBody> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });
    expect(saved.status).toBe(201);
    for (let attempt = 0; attempt < 400; attempt++) {
      const found = await currentPlan();
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading Google Cloud');
  }

  const apply = (planId: string) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

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

  /** my-1's row once its Cloud run saved where it answers and finished. */
  function made() {
    return until('my-1 made on Cloud SQL', async () => {
      const [row] = await ctx.db
        .select()
        .from(mysql)
        .where(eq(mysql.configName, 'my-1'));
      return row?.cloudSqlEndpoint && row.applicationStatus === 'done'
        ? row
        : null;
    });
  }

  /** The last `tofu apply` input of the Cloud SQL instance. */
  function appliedInstance() {
    const [input] = ctx.google.tofuInputs
      .filter(
        (one) =>
          one.method === 'apply' &&
          one.definition.includes('google_sql_database_instance'),
      )
      .slice(-1);
    return input;
  }

  async function madeMy1(text = MYSQL_ONLY) {
    const read = await planned(text);
    expect((await apply(read.planId)).status).toBe(200);
    expect((await settled(read.planId)).status).toBe('applied');
    return { read, row: await made() };
  }

  it('plans a Cloud SQL for MySQL instance on its size’s machine, and one Apply makes it; the web gets the url with no TLS parameter, the PSC DNS name and the instance’s CA', async () => {
    const read = await planned(WEB_AND_MYSQL);

    const my = read.steps.find((step) => step.configName === 'my-1');
    expect(my?.action).toBe('create');
    expect(my?.cloudSql?.lines).toEqual([
      'my-1 small → db-g1-small (shared CPU, 1.7 GB, no SLA: for testing)',
      'my-1 backups: 7 days, point-in-time recovery on',
    ]);
    expect(my?.cloudRead?.status).toBe('read');
    expect(my?.cloudRead?.summary?.[0]).toBe(
      'Cloud SQL instance `my-1`: create, db-g1-small, MYSQL_8_4, Enterprise edition, TLS offered, not required, its own CA, no public IP, a private DNS name through the private link',
    );

    ctx.google.tofuInputs.length = 0;
    expect((await apply(read.planId)).status).toBe(200);
    expect((await settled(read.planId)).status).toBe('applied');
    const row = await made();

    expect(row).toMatchObject({
      mysqlId: my?.cloudRead?.serviceId,
      cloudAccountId,
      region: REGION,
      instanceClass: 'db-g1-small',
      databaseName: 'my_1',
      databaseUser: 'my_1',
      cloudSqlEndpoint: { host: OUTPUTS.dns_name, port: 3306, ca: OUTPUTS.ca },
      backupRetentionDays: 7,
      cloudSqlApplied: { backupRetentionDays: 7, pointInTimeRecovery: true },
    });
    // Written as MySQL's: its version, TLS offered, its binary log for
    // point-in-time recovery, and root's password as a variable only.
    const input = appliedInstance();
    const definition = JSON.parse(input.definition) as {
      resource: {
        google_sql_database_instance: {
          database: {
            database_version: string;
            root_password: string;
            settings: {
              ip_configuration: { ssl_mode: string; ipv4_enabled: boolean };
              backup_configuration: Record<string, unknown>;
              edition: string;
            };
          };
        };
      };
    };
    const instance = definition.resource.google_sql_database_instance.database;
    expect(instance.database_version).toBe('MYSQL_8_4');
    expect(instance.settings.edition).toBe('ENTERPRISE');
    expect(instance.settings.ip_configuration).toMatchObject({
      ssl_mode: 'ALLOW_UNENCRYPTED_AND_ENCRYPTED',
      ipv4_enabled: false,
    });
    expect(instance.settings.backup_configuration).toMatchObject({
      binary_log_enabled: true,
    });
    expect(instance.root_password).toBe('${var.root_password}');
    expect(input.definition).not.toContain(row.databaseRootPassword);
    expect(input.definition).not.toContain(row.databasePassword);

    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.mysqlId, row.mysqlId));
    expect(state).toMatchObject({
      infrastructureStateId: my?.cloudRead?.stateId,
      provider: 'google',
    });
    const [run] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.mysqlId, row.mysqlId));
    expect(run).toMatchObject({
      title: 'Create my-1 on Cloud SQL',
      status: 'done',
    });

    const [web] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'web'));
    expect(await wiredEnv(ctx.db, environmentId, web.configLinks)).toEqual({
      DATABASE_URL: `mysql://my_1:${encodeURIComponent(row.databasePassword)}@${OUTPUTS.dns_name}:3306/my_1`,
      MYSQL_CA: OUTPUTS.ca,
      MYSQL_HOST: OUTPUTS.dns_name,
    });
  });

  it.each(['9.7', '8.0', '8.4.6'])(
    'refuses version "%s" by name before any Google call, suggesting "8.4"',
    async (version) => {
      ctx.google.calls.length = 0;
      const refused = await request(http)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({ text: `${MYSQL_ONLY}    version: "${version}"\n` });

      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toContain(
        'write "8.4"',
      );
      expect(ctx.google.calls).toEqual([]);
    },
  );

  it('refuses user: root before any Google call', async () => {
    ctx.google.calls.length = 0;
    const refused = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: `${MYSQL_ONLY}    user: root\n` });

    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toContain(
      'my-1.user: Cloud SQL refuses root as a MySQL app user',
    );
    expect(ctx.google.calls).toEqual([]);
  });

  it('stops and starts by its activation policy, reading "Stopped" with no date', async () => {
    const { row } = await madeMy1();
    ctx.google.calls.length = 0;

    const stopped = await request(http)
      .post(`/mysql/${row.mysqlId}/stop`)
      .set('Cookie', cookie);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({
      cloudSqlStop: { state: 'stopped', sentence: 'Stopped' },
    });
    expect(stopped.body).not.toHaveProperty('rdsStop');

    const started = await request(http)
      .post(`/mysql/${row.mysqlId}/start`)
      .set('Cookie', cookie);
    expect(started.status).toBe(200);
    expect(
      ctx.google.calls.flatMap((call) =>
        call.method === 'setCloudSqlActivationPolicy'
          ? [[call.name, call.policy]]
          : [],
      ),
    ).toEqual([
      [serviceName(row.mysqlId), 'NEVER'],
      [serviceName(row.mysqlId), 'ALWAYS'],
    ]);
  });

  it('answers its Backups tab from Cloud SQL, and stores a retention edited there, which the next plan applies with no restart mark', async () => {
    const { row } = await madeMy1();
    ctx.google.cloudSqlHolds(serviceName(row.mysqlId), {
      retentionDays: 7,
      earliestRestorableTime: '2026-10-19T03:00:00.000Z',
      latestRestorableTime: '2026-10-26T11:05:00.000Z',
      backups: [],
    });

    const tab = await request(http)
      .get(`/mysql/${row.mysqlId}/cloud-backups`)
      .set('Cookie', cookie);
    expect(tab.status).toBe(200);
    expect(tab.body).toMatchObject({
      engine: 'cloud-sql',
      identifier: serviceName(row.mysqlId),
      retentionDays: 7,
    });

    const saved = await request(http)
      .patch(`/mysql/${row.mysqlId}/cloud-sql-settings`)
      .set('Cookie', cookie)
      .send({ backupRetentionDays: 14 });
    expect(saved.status).toBe(200);
    const read = await planned(MYSQL_ONLY);
    expect(read.steps.map((step) => step.cloudSql?.lines)).toEqual([
      ['my-1 backups: 7 days → 14 days'],
    ]);
  });

  describe('Delete', () => {
    const today = () => new Date().toISOString().slice(0, 10);
    const BACKUP = () => `shop-production-my-1-final-${today()}`;
    const steps = () =>
      ctx.google.calls.flatMap((call) =>
        call.method === 'liftCloudSqlDeletionProtection'
          ? ['protection off']
          : call.method === 'apply'
            ? [`apply ${call.kind}`]
            : call.method === 'stopRetainingCloudSqlBackups'
              ? ['retained backups off']
              : call.method === 'takeCloudSqlBackup'
                ? [`backup ${call.description}`]
                : call.method === 'destroy'
                  ? [`destroy ${call.kind}`]
                  : [],
      );

    async function ready() {
      const made = await madeMy1();
      ctx.google.replayPlanFor('destroy', 'postgres-destroy');
      ctx.google.replayPlanFor('mysql', null);
      ctx.google.calls.length = 0;
      return made.row;
    }

    const gone = (mysqlId: string) =>
      until('my-1 deleted', async () => {
        const rows = await ctx.db
          .select()
          .from(mysql)
          .where(eq(mysql.mysqlId, mysqlId));
        return rows.length === 0 ? true : null;
      });

    it('lifts both deletion protections, takes its hand-made backup, then destroys', async () => {
      const row = await ready();

      const res = await request(http)
        .delete(`/mysql/${row.mysqlId}`)
        .set('Cookie', cookie);
      expect(res.status).toBeLessThan(300);
      await gone(row.mysqlId);

      expect(steps()).toEqual([
        'protection off',
        'apply mysql',
        `backup ${BACKUP()}`,
        'destroy destroy',
      ]);
    });

    it('asked to delete its data, stops keeping backups on delete instead of taking one', async () => {
      const row = await ready();

      const res = await request(http)
        .delete(`/mysql/${row.mysqlId}?deleteData=true`)
        .set('Cookie', cookie);
      expect(res.status).toBeLessThan(300);
      await gone(row.mysqlId);

      expect(steps()).toEqual([
        'protection off',
        'apply mysql',
        'retained backups off',
        'destroy destroy',
      ]);
    });
  });

  describe('an Existing database (the existing-instance path)', () => {
    async function useExisting() {
      const res = await request(http)
        .post('/mysql/existing')
        .set('Cookie', cookie)
        .send({
          environmentId,
          configName: 'my-1',
          identifier: CONNECTION,
          databaseUser: 'shop_app',
          databasePassword: LOGIN_PASSWORD,
          databaseName: 'shop',
        });
      expect(res.status).toBe(201);
      return (res.body as { mysqlId: string }).mysqlId;
    }

    it('refuses a PostgreSQL instance named as a mysql', async () => {
      ctx.google.cloudSqlInstanceAnswers(INSTANCE_REF, {
        ...INSTANCE,
        databaseVersion: 'POSTGRES_17',
      });
      await useExisting();

      const read = await planned(MYSQL_ONLY);
      const step = read.steps.find((one) => one.configName === 'my-1');

      expect(step?.cloudRead).toMatchObject({
        status: 'failed',
        reason: `my-1 uses the existing database ${CONNECTION}, but it runs POSTGRES_17, not MySQL, so a mysql cannot use it`,
      });
    });

    it('reaches a MySQL one through its manual endpoint and private zone, and a web wired to it gets the ….sql.goog. name with its dot and the instance’s CA', async () => {
      const mysqlId = await useExisting();

      const read = await planned(WEB_AND_MYSQL);
      const step = read.steps.find((one) => one.configName === 'my-1');
      expect(step?.cloudRead?.summary?.[0]).toBe(
        `my-1: existing database ${CONNECTION}, MySQL 8.4, at ${NAME}:3306 through Cloudgate's own endpoint; used as given, Cloudgate changes nothing in it`,
      );
      expect((await apply(read.planId)).status).toBe(200);
      await settled(read.planId);
      const run = await until('the endpoint run ended', async () => {
        const [row] = await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.mysqlId, mysqlId));
        return row && ['done', 'error'].includes(row.status) ? row : null;
      });
      expect(run.status).toBe('done');

      const [state] = await ctx.db
        .select()
        .from(infrastructureState)
        .where(eq(infrastructureState.mysqlId, mysqlId));
      expect(state?.provider).toBe('google');
      const [existing] = await ctx.db.select().from(existingDatabase);
      expect(existing).toMatchObject({
        address: { host: NAME, port: 3306 },
        ca: CA,
      });
      // The instance itself is never in a definition.
      expect(
        ctx.google.tofuInputs.filter((input) =>
          input.definition.includes('google_sql_database_instance'),
        ),
      ).toEqual([]);

      const [web] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.configName, 'web'));
      expect(await wiredEnv(ctx.db, environmentId, web.configLinks)).toEqual({
        DATABASE_URL: `mysql://shop_app:${encodeURIComponent(LOGIN_PASSWORD)}@${NAME}:3306/shop`,
        MYSQL_CA: CA,
        MYSQL_HOST: NAME,
      });
    });
  });
});
