import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
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
  postgres,
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

const WEB = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
`;

/** Slice 4's sample: a web given pg-1's URL and CA through its links. */
const WEB_AND_PG = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
    env: [{ DATABASE_URL: pg-1.url }, { PGSSLROOTCERT: pg-1.ca }]
  pg-1:
    kind: postgres
    size: small
`;

const PG_ONLY = (names: string[]) =>
  `version: 1\nservices:\n${names.map((name) => `  ${name}:\n    kind: postgres\n    size: small\n`).join('')}`;

/** The instance's address in its Cloud SQL definition. */
const CLOUD_SQL_INSTANCE = 'google_sql_database_instance.database';

const LINK_LINE =
  "Private link: lets this Environment's databases get a private address; made once, kept until the Environment is deleted";

/** What the stored Cloud SQL apply answers, each output's value. */
const PG_OUTPUTS = Object.fromEntries(
  Object.entries(storedGoogleOutputs('postgres-create')).map(
    ([name, output]) => [name, (output as { value: string }).value],
  ),
) as { dns_name: string; ca: string };

interface Step {
  action: string;
  configName?: string;
  privateLinks?: string[];
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
 * Spec "Postgres on Cloud SQL" and "The private link": on a
 * Google Cloud Deploy target a `postgres` becomes a Cloud SQL instance, and
 * the first plan that creates one adds Cloud SQL's private link to the
 * Environment network, under the network, at $0/month. One Apply makes the
 * link and the instance; the linked `web` gets the instance's PSC DNS name
 * and its own CA at deploy; a database's Delete removes only its instance.
 * Against `ctx.google`, whose stand-in `tofu` replays the stored Google
 * plans and apply outputs.
 */
describe('A postgres on a Google Cloud Deploy target becomes a Cloud SQL instance on the private link (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gsql-'));
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

    ctx.google.replayPlanFor('network', 'network-create-private-link');
    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.replayPlanFor('postgres', 'postgres-create');
    ctx.google.replayOutputsFor('network', 'network-create');
    ctx.google.replayOutputsFor('postgres', 'postgres-create');
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

  /**
   * The postgres's row once its Cloud run saved where the instance answers and
   * finished: the run saves the address before it marks itself done.
   */
  function made(configName: string) {
    return until(`${configName} made on Cloud SQL`, async () => {
      const [row] = await ctx.db
        .select()
        .from(postgres)
        .where(eq(postgres.configName, configName));
      return row?.cloudSqlEndpoint && row.applicationStatus === 'done'
        ? row
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

  /** The `backup_configuration` the last `tofu apply` of the instance wrote. */
  function appliedBackups(): unknown {
    const [input] = ctx.google.tofuInputs
      .filter(
        (one) =>
          one.method === 'apply' &&
          one.definition.includes('google_sql_database_instance'),
      )
      .slice(-1);
    const parsed = JSON.parse(input.definition) as {
      resource: {
        google_sql_database_instance: {
          database: { settings: { backup_configuration?: unknown } };
        };
      };
    };
    return parsed.resource.google_sql_database_instance.database.settings
      .backup_configuration;
  }

  /** A made Google network in the Environment, with its state, as its Apply leaves it. */
  async function madeNetwork(privateLinks: 'cloud-sql'[]) {
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

  it("shows Cloud SQL's private link under a new network at $0/month, the instance with its machine and own address, and one Apply makes them all; the web gets the PSC DNS name and the instance's CA at deploy", async () => {
    const read = await planned(WEB_AND_PG);

    expect(read.steps.map((step) => [step.action, step.configName])).toEqual([
      ['network-create', undefined],
      ['create', 'pg-1'],
      ['create', 'web'],
    ]);
    const [network, pg] = read.steps;
    expect(network.privateLinks).toEqual(['cloud-sql']);
    expect(network.cloudRead?.status).toBe('read');
    expect(network.cloudRead?.summary).toEqual(
      expect.arrayContaining([
        'Private link subnet `cloudgate-w33lemwkholw-psc` (10.64.16.0/24): create, $0/month',
        expect.stringMatching(
          /^Private link for Cloud SQL \(service connection policy `cloudgate-w33lemwkholw-psc-sql`\): create, \$0\/month/,
        ),
        LINK_LINE,
      ]),
    );
    // Backed up from create, with no restart mark.
    expect(pg.cloudSql?.lines).toEqual([
      'pg-1 small → db-g1-small (shared CPU, 1.7 GB, no SLA: for testing)',
      'pg-1 backups: 7 days, point-in-time recovery on',
    ]);
    // What the instance is made with, as the plan's read shows it.
    expect(pg.cloudRead?.status).toBe('read');
    expect(pg.cloudRead?.summary).toEqual([
      'Cloud SQL instance `pg-1`: create, db-f1-micro, POSTGRES_17, Enterprise edition, encrypted connections only, its own CA, no public IP, a private DNS name through the private link',
      '`pg-1` private address: create, made by Google with the instance on the private link subnet (10.64.16.0/24), about $7.30/month',
    ]);
    ctx.google.calls.length = 0;

    const res = await apply(read.planId);
    expect(res.status).toBe(200);
    const row = await settled(read.planId);
    expect(row.status).toBe('applied');
    const pgRow = await made('pg-1');

    // The network and its link first, then the instance, each a Cloud run.
    const runs = tofuRuns();
    expect(runs.indexOf('apply network')).toBeGreaterThanOrEqual(0);
    expect(runs.indexOf('apply postgres')).toBeGreaterThan(
      runs.indexOf('apply network'),
    );
    const [networkRow] = await ctx.db.select().from(environmentNetwork);
    expect(networkRow.privateLinks).toEqual(['cloud-sql']);
    expect(pgRow).toMatchObject({
      postgresId: pg.cloudRead?.serviceId,
      cloudAccountId,
      region: REGION,
      instanceClass: 'db-g1-small',
      applicationStatus: 'done',
      // PostgreSQL reserves pg_1 as a role, so the default user is app_ it.
      databaseName: 'pg_1',
      databaseUser: 'app_pg_1',
      cloudSqlEndpoint: {
        host: PG_OUTPUTS.dns_name,
        port: 5432,
        ca: PG_OUTPUTS.ca,
      },
      // Backed up from create: its Backups tab's retention, as made.
      backupRetentionDays: 7,
      cloudSqlApplied: { backupRetentionDays: 7, pointInTimeRecovery: true },
    });
    expect(appliedBackups()).toEqual({
      enabled: true,
      point_in_time_recovery_enabled: true,
      transaction_log_retention_days: 7,
      backup_retention_settings: {
        retained_backups: 7,
        retention_unit: 'COUNT',
      },
    });
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.postgresId, pgRow.postgresId));
    expect(state).toMatchObject({
      infrastructureStateId: pg.cloudRead?.stateId,
      provider: 'google',
    });
    const [run] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.postgresId, pgRow.postgresId));
    expect(run).toMatchObject({
      title: 'Create pg-1 on Cloud SQL',
      status: 'done',
    });

    // At deploy the web's variables are built from what the run saved.
    const [web] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.configName, 'web'));
    const env = await wiredEnv(ctx.db, environmentId, web.configLinks);
    expect(env).toEqual({
      DATABASE_URL: `postgresql://app_pg_1:${encodeURIComponent(pgRow.databasePassword)}@${PG_OUTPUTS.dns_name}:5432/pg_1?sslmode=require`,
      PGSSLROOTCERT: PG_OUTPUTS.ca,
    });
    // Never saved on the web's row.
    expect(JSON.stringify(web)).not.toContain(PG_OUTPUTS.dns_name);
    expect(JSON.stringify(web)).not.toContain('PLACEHOLDER-CLOUD-SQL');
  });

  it('refuses a user: pg_admin, which PostgreSQL reserves, before any Google call', async () => {
    ctx.google.calls.length = 0;
    const refused = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({
        text: 'version: 1\nservices:\n  pg-1:\n    kind: postgres\n    user: pg_admin\n',
      });

    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toContain(
      'pg-1.user: PostgreSQL reserves role names starting with pg_; choose another user:',
    );
    expect(ctx.google.calls).toEqual([]);
    expect(await ctx.db.select().from(postgres)).toHaveLength(0);
  });

  it('gives a web-only Environment no link piece', async () => {
    ctx.google.replayPlanFor('network', 'network-create');

    const read = await planned(WEB);

    expect(read.steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);
    expect(read.steps[0].privateLinks).toBeUndefined();
    expect(read.steps[0].cloudRead?.summary).not.toContain(LINK_LINE);
  });

  it('adds no second policy or subnet for another postgres once the network has them', async () => {
    await madeNetwork(['cloud-sql']);

    const read = await planned(PG_ONLY(['pg-2']));

    expect(read.steps.map((step) => [step.action, step.configName])).toEqual([
      ['create', 'pg-2'],
    ]);
  });

  it('adds the link to a made network as its own network run, before the instance', async () => {
    const network = await madeNetwork([]);
    ctx.google.replayPlanFor('network', 'private-link-create');

    const read = await planned(PG_ONLY(['pg-1']));

    expect(read.steps.map((step) => step.action)).toEqual([
      'network-change',
      'create',
    ]);
    expect(read.steps[0]).toMatchObject({
      privateLinks: ['cloud-sql'],
      cloudRead: {
        status: 'read',
        summary: [
          'Private link subnet `cloudgate-w33lemwkholw-psc` (10.64.16.0/24): create, $0/month',
          expect.stringContaining('Private link for Cloud SQL'),
          LINK_LINE,
        ],
      },
    });
    ctx.google.calls.length = 0;

    expect((await apply(read.planId)).status).toBe(200);
    await made('pg-1');
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
      return row.privateLinks.length > 0 ? row : null;
    });

    expect(linked.privateLinks).toEqual(['cloud-sql']);
    const runs = tofuRuns();
    expect(runs.indexOf('apply postgres')).toBeGreaterThan(
      runs.indexOf('apply network'),
    );
    const titles = (
      await ctx.db
        .select({ title: deployment.title })
        .from(deployment)
        .where(
          eq(deployment.environmentNetworkId, network.environmentNetworkId),
        )
    ).map((one) => one.title);
    expect(titles).toEqual([
      `Add the private link to the Environment network (${REGION})`,
    ]);
  });

  it('plans a backup retention edited on its Backups tab as an in-place change with no restart mark, and its Apply makes it', async () => {
    await madeNetwork(['cloud-sql']);
    const first = await planned(PG_ONLY(['pg-1']));
    expect((await apply(first.planId)).status).toBe(200);
    const pgRow = await made('pg-1');
    ctx.google.replayPlanFor('postgres', 'postgres-change');

    const saved = await request(http)
      .patch(`/postgres/${pgRow.postgresId}/cloud-sql-settings`)
      .set('Cookie', cookie)
      .send({ backupRetentionDays: 14 });
    expect(saved.status).toBe(200);
    const read = await planned(PG_ONLY(['pg-1']));

    expect(read.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'pg-1',
        cloudSql: {
          tier: null,
          version: null,
          backupRetentionDays: { from: 7, to: 14 },
          lines: ['pg-1 backups: 7 days → 14 days'],
        },
      }),
    ]);
    expect(JSON.stringify(read.steps[0].cloudSql)).not.toContain('restarts');
    expect((await apply(read.planId)).status).toBe(200);
    const runs = await until('the change ran', async () => {
      const rows = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.postgresId, pgRow.postgresId));
      return rows.length === 2 &&
        rows.every(
          (one) => one.status !== 'pending' && one.status !== 'running',
        )
        ? rows
        : null;
    });
    expect(runs.map((one) => one.status)).toEqual(['done', 'done']);
    const [after] = await ctx.db
      .select()
      .from(postgres)
      .where(eq(postgres.postgresId, pgRow.postgresId));
    expect(after.cloudSqlApplied).toEqual({
      backupRetentionDays: 14,
      pointInTimeRecovery: true,
    });
    expect(appliedBackups()).toMatchObject({
      backup_retention_settings: { retained_backups: 14 },
      point_in_time_recovery_enabled: true,
    });
    // Made: the next plan has nothing to do.
    ctx.google.replayPlanFor('postgres', null);
    expect((await planned(PG_ONLY(['pg-1']))).steps).toEqual([]);
  });

  it('catches a postgres made before backups up: backups and deletion protection with no mark, point-in-time recovery marked as two restarts, approved with no typed name', async () => {
    await madeNetwork(['cloud-sql']);
    const first = await planned(PG_ONLY(['pg-1']));
    expect((await apply(first.planId)).status).toBe(200);
    const pgRow = await made('pg-1');
    // Its stored state as an instance made before backups left it.
    await ctx.db
      .update(postgres)
      .set({ cloudSqlApplied: null })
      .where(eq(postgres.postgresId, pgRow.postgresId));
    ctx.google.replayPlanFor('postgres', 'postgres-change');

    const read = await planned(PG_ONLY(['pg-1']));

    expect(read.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'pg-1',
        fields: [],
        cloudSql: {
          tier: null,
          version: null,
          catchUp: { backupRetentionDays: 7 },
          pointInTimeRecovery: { from: false, to: true },
          lines: [
            'pg-1 backups: off → 7 days, deletion protection: off → on',
            'pg-1 point-in-time recovery: off → on',
            'restarts pg-1 twice: about 15 s offline',
          ],
        },
      }),
    ]);
    // The mark is approved with the plan: no name is typed for it.
    expect(read.steps[0]).not.toHaveProperty('majorUpgrade');
    expect((await apply(read.planId)).status).toBe(200);
    const runs = await until('the catch-up ran', async () => {
      const rows = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.postgresId, pgRow.postgresId));
      return rows.length === 2 &&
        rows.every(
          (one) => one.status !== 'pending' && one.status !== 'running',
        )
        ? rows
        : null;
    });
    expect(runs.map((one) => one.status)).toEqual(['done', 'done']);
    const [after] = await ctx.db
      .select()
      .from(postgres)
      .where(eq(postgres.postgresId, pgRow.postgresId));
    expect(after.cloudSqlApplied).toEqual({
      backupRetentionDays: 7,
      pointInTimeRecovery: true,
    });
    expect(appliedBackups()).toMatchObject({
      enabled: true,
      backup_retention_settings: { retained_backups: 7 },
      point_in_time_recovery_enabled: true,
    });
    // Caught up: the next plan has nothing to do.
    ctx.google.replayPlanFor('postgres', null);
    expect((await planned(PG_ONLY(['pg-1']))).steps).toEqual([]);
  });

  /**
   * ADR-0044 rule 12: a tier the config's `native.gcp` sets wins
   * over its size on Google Cloud and is applied, the RDS settings route
   * refuses to change it, or any RDS setting of a Cloud SQL row (an RDS
   * class would be written as its tier unplanned), naming where its
   * machine and retention are, and taking it out with a size falls back to
   * the size's tier, as the restart it is.
   */
  it("applies a native tier over the size, refuses the RDS settings of a Cloud SQL row, and falls back to the size's once taken out", async () => {
    await madeNetwork(['cloud-sql']);
    const TIER = 'db-perf-optimized-N-4';
    const NATIVE = `${PG_ONLY(['pg-1'])}    native:
      gcp:
        "${CLOUD_SQL_INSTANCE}":
          settings:
            tier: ${TIER}
`;
    /** The tier the last `tofu apply` of the instance wrote. */
    const appliedTier = () => {
      const [input] = ctx.google.tofuInputs
        .filter(
          (one) =>
            one.method === 'apply' &&
            one.definition.includes('google_sql_database_instance'),
        )
        .slice(-1);
      const parsed = JSON.parse(input.definition) as {
        resource: {
          google_sql_database_instance: {
            database: { settings: { tier: string } };
          };
        };
      };
      return parsed.resource.google_sql_database_instance.database.settings
        .tier;
    };

    const created = await planned(NATIVE);
    const create = created.steps.find((step) => step.configName === 'pg-1');
    expect(create).toMatchObject({
      action: 'create',
      cloudSql: {
        size: {
          name: 'small',
          tier: TIER,
          machine: '4 vCPU, 32 GB',
          smallest: false,
          native: true,
        },
        lines: expect.arrayContaining([
          `pg-1 small → ${TIER} (4 vCPU, 32 GB), set by native`,
        ]) as string[],
      },
    });
    expect((await apply(created.planId)).status).toBe(200);
    const pgRow = await made('pg-1');
    expect(appliedTier()).toBe(TIER);
    expect(pgRow).toMatchObject({
      instanceClass: TIER,
      nativeGcp: { [CLOUD_SQL_INSTANCE]: { settings: { tier: TIER } } },
    });

    for (const edit of [
      { instanceClass: 'db-custom-2-7680' },
      { instanceClass: 'db.t4g.medium' },
      { storageGb: 50, multiAz: true },
      { backupRetentionDays: 14 },
    ]) {
      const refused = await request(http)
        .patch(`/postgres/${pgRow.postgresId}/rds-settings`)
        .set('Cookie', cookie)
        .send(edit);
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(
        "pg-1 runs on Cloud SQL, not RDS, so it has no RDS settings: its machine is its size's, or its native.gcp settings.tier's, in the Project config, and its backup retention is its Backups tab's",
      );
    }
    const [untouched] = await ctx.db
      .select()
      .from(postgres)
      .where(eq(postgres.postgresId, pgRow.postgresId));
    expect(untouched).toMatchObject({
      instanceClass: TIER,
      storageGb: pgRow.storageGb,
      multiAz: pgRow.multiAz,
      backupRetentionDays: pgRow.backupRetentionDays,
    });

    // Taken out with a size: back to the size's tier, never kept.
    ctx.google.replayPlanFor('postgres', 'postgres-change');
    const removed = await planned(PG_ONLY(['pg-1']));
    expect(removed.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'pg-1',
        fields: [
          {
            field: `native.gcp."${CLOUD_SQL_INSTANCE}".settings.tier`,
            from: TIER,
            to: 'db-g1-small',
            native: true,
            toSize: true,
          },
        ],
        cloudSql: expect.objectContaining({
          tier: {
            from: TIER,
            to: 'db-g1-small',
            machine: 'shared CPU, 1.7 GB, no SLA',
            sizeName: 'small',
          },
          native: null,
        }) as object,
      }),
    ]);
    expect((await apply(removed.planId)).status).toBe(200);
    await until('the change ran', async () => {
      const rows = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.postgresId, pgRow.postgresId));
      return rows.length === 2 && rows.every((one) => one.status === 'done')
        ? rows
        : null;
    });
    expect(appliedTier()).toBe('db-g1-small');
    const [fellBack] = await ctx.db
      .select()
      .from(postgres)
      .where(eq(postgres.postgresId, pgRow.postgresId));
    expect(fellBack).toMatchObject({
      instanceClass: 'db-g1-small',
      nativeGcp: null,
    });
  });

  /**
   * A Cloud SQL `postgres` is protected from deletion, Google's flag
   * and the provider's, and its Delete lifts both first, then takes one
   * on-demand backup described `<project>-<environment>-<service>-final-<date>`
   * (or, asked to delete its data, stops keeping backups on delete instead),
   * then destroys, naming the backup once as kept.
   */
  describe('Delete', () => {
    const today = () => new Date().toISOString().slice(0, 10);
    const BACKUP = () => `shop-production-pg-1-final-${today()}`;
    /** What reached Google before and at the destroy, in order. */
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

    async function madePg1() {
      const network = await madeNetwork(['cloud-sql']);
      const read = await planned(PG_ONLY(['pg-1']));
      expect((await apply(read.planId)).status).toBe(200);
      const pgRow = await made('pg-1');
      ctx.google.replayPlanFor('destroy', 'postgres-destroy');
      // The apply before the destroy changes only what the state holds.
      ctx.google.replayPlanFor('postgres', null);
      ctx.google.calls.length = 0;
      ctx.google.tofuInputs.length = 0;
      return { network, read, pgRow };
    }

    const gone = (postgresId: string) =>
      until('pg-1 deleted', async () => {
        const rows = await ctx.db
          .select()
          .from(postgres)
          .where(eq(postgres.postgresId, postgresId));
        return rows.length === 0 ? true : null;
      });

    async function report(postgresId: string) {
      const entry = (
        await ctx.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.resourceId, postgresId))
      ).find((one) =>
        (one.metadata ?? '').includes('"cloudDelete":"finished"'),
      );
      return JSON.parse(entry!.metadata!) as {
        kept: unknown[];
        dataDeleted: boolean;
      };
    }

    it("lifts both deletion protections, takes the backup, destroys only the instance and its own address, and lists the backup once as kept; the link stays in the network's state", async () => {
      const { network, read, pgRow } = await madePg1();

      const res = await request(http)
        .delete(`/postgres/${pgRow.postgresId}`)
        .set('Cookie', cookie);
      expect(res.status).toBeLessThan(300);
      expect(res.body).toMatchObject({
        cloudDelete: { status: 'deleting', finalSnapshot: BACKUP() },
      });
      await gone(pgRow.postgresId);

      expect(steps()).toEqual([
        'protection off',
        'apply postgres',
        `backup ${BACKUP()}`,
        'destroy destroy',
      ]);
      const instance = {
        projectId: PROJECT,
        name: serviceName(pgRow.postgresId),
      };
      expect(ctx.google.calls).toContainEqual(
        expect.objectContaining({
          method: 'liftCloudSqlDeletionProtection',
          ...instance,
        }),
      );
      expect(ctx.google.calls).toContainEqual(
        expect.objectContaining({
          method: 'takeCloudSqlBackup',
          ...instance,
          description: BACKUP(),
        }),
      );
      // The provider's flag, which only the state holds, off by an apply of
      // the instance alone.
      const stateId = read.steps[0].cloudRead?.stateId;
      expect(
        ctx.google.calls.find((call) => call.method === 'apply'),
      ).toMatchObject({ stateId, targets: [CLOUD_SQL_INSTANCE] });
      const lifted = ctx.google.tofuInputs.find(
        (input) => input.method === 'apply',
      )!.definition;
      expect(lifted).toContain('"deletion_protection": false');
      expect(lifted).toContain('"deletion_protection_enabled": false');
      expect(lifted).not.toContain('final_backup_config');

      expect(await report(pgRow.postgresId)).toMatchObject({
        dataDeleted: false,
        kept: [
          {
            type: 'cloud-sql:backup',
            awsId: BACKUP(),
            region: 'us',
            size: '2 GiB',
            cost: 'about $0.16 a month until you delete it in Google Cloud',
          },
        ],
      });

      // The network's state is untouched.
      const states = await ctx.db.select().from(infrastructureState);
      expect(
        states.map((one) => one.environmentNetworkId ?? one.postgresId),
      ).toEqual([network.environmentNetworkId]);
      const [after] = await ctx.db.select().from(environmentNetwork);
      expect(after.privateLinks).toEqual(['cloud-sql']);
    });

    it('asked to delete its data, stops keeping backups on delete instead of taking one, and lists nothing kept', async () => {
      const { pgRow } = await madePg1();

      const res = await request(http)
        .delete(`/postgres/${pgRow.postgresId}?deleteData=true`)
        .set('Cookie', cookie);
      expect(res.status).toBeLessThan(300);
      expect(res.body).toMatchObject({
        cloudDelete: { status: 'deleting', finalSnapshot: null },
      });
      await gone(pgRow.postgresId);

      expect(steps()).toEqual([
        'protection off',
        'apply postgres',
        'retained backups off',
        'destroy destroy',
      ]);
      expect(await report(pgRow.postgresId)).toMatchObject({
        dataDeleted: true,
        kept: [],
      });
    });

    it('refuses the Delete of a stopped instance that would keep a backup, changing nothing on Google; asked to delete its data, deletes it with no backup', async () => {
      const { pgRow } = await madePg1();
      // Stopped, as its Stop leaves it: Google takes no backup of it.
      await ctx.db
        .update(postgres)
        .set({ applicationStatus: 'stopped' })
        .where(eq(postgres.postgresId, pgRow.postgresId));

      const refused = await request(http)
        .delete(`/postgres/${pgRow.postgresId}`)
        .set('Cookie', cookie);
      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        'pg-1 is stopped. Start it first, then delete it.',
      );
      expect(steps()).toEqual([]);
      const [kept] = await ctx.db
        .select()
        .from(postgres)
        .where(eq(postgres.postgresId, pgRow.postgresId));
      expect(kept.cloudDelete).toBeNull();

      const res = await request(http)
        .delete(`/postgres/${pgRow.postgresId}?deleteData=true`)
        .set('Cookie', cookie);
      expect(res.status).toBeLessThan(300);
      await gone(pgRow.postgresId);
      expect(steps()).toEqual([
        'protection off',
        'apply postgres',
        'retained backups off',
        'destroy destroy',
      ]);
    });

    it('a failed destroy leaves the Delete incomplete, saying the protection is now off; a Retry takes no second backup', async () => {
      const { read, pgRow } = await madePg1();
      const stateId = read.steps[0].cloudRead!.stateId!;
      ctx.google.failDestroyOf(
        stateId,
        'Error, failed to delete instance: the instance is busy',
      );

      await request(http)
        .delete(`/postgres/${pgRow.postgresId}`)
        .set('Cookie', cookie);
      const incomplete = await until('pg-1 Delete incomplete', async () => {
        const [row] = await ctx.db
          .select()
          .from(postgres)
          .where(eq(postgres.postgresId, pgRow.postgresId));
        return row?.cloudDelete?.status === 'incomplete' ? row : null;
      });
      expect(incomplete.cloudDelete?.unfinished).toContain(
        "pg-1's deletion protection is now off.",
      );
      expect(steps()).toEqual([
        'protection off',
        'apply postgres',
        `backup ${BACKUP()}`,
        'destroy destroy',
      ]);

      ctx.google.failDestroyOf(stateId, null);
      ctx.google.calls.length = 0;
      expect(
        (
          await request(http)
            .post(`/postgres/${pgRow.postgresId}/delete/retry`)
            .set('Cookie', cookie)
        ).status,
      ).toBe(200);
      await gone(pgRow.postgresId);
      expect(steps()).toEqual([
        'protection off',
        'apply postgres',
        'destroy destroy',
      ]);
      expect((await report(pgRow.postgresId)).kept).toEqual([
        expect.objectContaining({ awsId: BACKUP() }),
      ]);
    });

    it("names the backup and about what it costs a month in the Delete dialog's preview and on the plan's destroy line", async () => {
      const { pgRow } = await madePg1();

      const preview = await request(http)
        .get(`/postgres/${pgRow.postgresId}/final-snapshot`)
        .set('Cookie', cookie);
      expect(preview.status).toBe(200);
      // Estimated from the instance's disk, Google's 10 GiB.
      expect(preview.body).toEqual({
        cloud: 'gcp',
        name: BACKUP(),
        region: 'eu',
        sizeGb: 10,
        monthlyUsd: 0.8,
        sentence: `keeps backup ${BACKUP()}, about $0.80 a month, until you delete it in Google Cloud`,
      });

      const dropped = await planned(WEB);
      expect(dropped.steps).toContainEqual(
        expect.objectContaining({
          action: 'destroy',
          configName: 'pg-1',
          finalSnapshot: { cloud: 'gcp', name: BACKUP(), monthlyUsd: 0.8 },
        }),
      );
    });
  });
});
