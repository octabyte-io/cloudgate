import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { rdsCaBundle } from '../../src/cloud-accounts/aws/rds-ca';
import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import {
  cloudAccount,
  deployment,
  environmentNetwork,
  mysql,
  plan as planTable,
} from '../../src/db/schema';
import type { Plan } from '../../src/db/schema';
import { wiredEnv } from '../../src/project-config/outputs/wired-env';
import { snapshotDate } from '../../src/project-config/rds-postgres-places';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
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
const ENDPOINT = 'cloudgate-db1.c9akciq32.eu-central-1.rds.amazonaws.com';

const DB = `version: 1
services:
  db-1:
    kind: mysql
    size: small
`;

type Resource = { type: string; values: Record<string, unknown> };

/** The stored lookup of an Existing database, its instance's engine changed. */
function lookupRunning(engine: string): TofuShow {
  const show = storedPlan('existing-postgres-lookup') as {
    prior_state: { values: { root_module: { resources: Resource[] } } };
  };
  const resources = structuredClone(
    show.prior_state.values.root_module.resources,
  );
  const instance = resources.find((one) => one.type === 'aws_db_instance')!;
  instance.values.engine = engine;
  instance.values.engine_version = engine === 'mysql' ? '8.4.6' : '17.4';
  instance.values.port = engine === 'mysql' ? 3306 : 5432;
  return { ...show, prior_state: { values: { root_module: { resources } } } };
}

/** The VPC the stored lookup's instance sits in. */
function lookupVpc(): string {
  const show = storedPlan('existing-postgres-lookup') as {
    prior_state: { values: { root_module: { resources: Resource[] } } };
  };
  return show.prior_state.values.root_module.resources.find(
    (one) => one.type === 'aws_db_subnet_group',
  )!.values.vpc_id as string;
}

/**
 * A `mysql` on an AWS Deploy target is an RDS for MySQL instance,
 * made, read, stopped, started, used as an Existing database and deleted
 * exactly as a postgres on RDS is, through the same code with MySQL's
 * parameters. Against the fake cloud port (`ctx.cloud`), which replays the
 * stored `mysql-create.json`, and a real shell for the Deployment logs.
 */
describe('A mysql on RDS (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-mysql-'));
  const savedDirectory = process.env.CLOUDGATE_DIRECTORY;

  const execMock = withArgvExec({
    execAsync: jest.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) =>
        new Promise((resolve, reject) => {
          exec(
            command,
            { shell: '/bin/bash', env: { ...process.env, ...options?.env } },
            (error, stdout, stderr) =>
              error
                ? reject(Object.assign(error, { stdout, stderr }))
                : resolve({ stdout, stderr, exitCode: 0 }),
          );
        }),
    ),
    execAsyncRemote: jest.fn(),
  });

  beforeAll(async () => {
    process.env.CLOUDGATE_DIRECTORY = root;
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (savedDirectory === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = savedDirectory;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    ctx.cloud.reset();
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
    ctx.cloud.replayPlanFor('mysql', 'mysql-create');
    ctx.cloud.replayPlanFor('existing-postgres', 'existing-postgres-lookup');
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;
  });

  async function readyNetwork(vpcId = 'vpc-0a1b') {
    await ctx.db.insert(environmentNetwork).values({
      environmentId,
      cloudAccountId,
      region: REGION,
      status: 'ready',
      vpcId,
      publicSubnetIds: ['subnet-0aaa', 'subnet-0bbb'],
      privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'],
      clusterArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/env`,
      httpsListenerArn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/env/1/2`,
      albSecurityGroupId: 'sg-0alb',
    });
  }

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  type Read = {
    status: string;
    summary?: string[];
    reason?: string;
    stateId?: string;
    serviceId?: string;
  };
  const readOf = (step: Plan['steps'][number]): Read | undefined =>
    'cloudRead' in step ? step.cloudRead : undefined;

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
        !found.steps.some((step) => readOf(step)?.status === 'reading')
      ) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading AWS');
  }

  async function until<T>(look: () => Promise<T | undefined>, what: string) {
    for (let attempt = 0; attempt < 600; attempt++) {
      const found = await look();
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Waited in vain for ${what}`);
  }

  const apply = (planId: string, body: Record<string, unknown> = {}) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId, ...body });

  const mysqlRows = () => ctx.db.select().from(mysql);

  /** db-1 made on RDS by an Apply, its Cloud run ended done. */
  async function madeDb1() {
    await readyNetwork();
    expect((await save(DB)).status).toBe(201);
    const read = await readPlan();
    const [step] = read.steps;
    const stateId = readOf(step)!.stateId!;
    ctx.cloud.outputsFor(stateId, {
      endpoint_address: ENDPOINT,
      endpoint_port: 3306,
      instance_identifier: 'cloudgate-db1',
    });
    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    const { deploymentId } = (
      applied.body as { results: { deploy: { deploymentId: string } }[] }
    ).results[0].deploy;
    const run = await until(async () => {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      return row && !['pending', 'running'].includes(row.status)
        ? row
        : undefined;
    }, 'the Cloud run to end');
    const [made] = await mysqlRows();
    return { read, step, stateId, run, made };
  }

  it('plans an RDS for MySQL instance with its class, 3306 and db_name, and Apply makes it through a Cloud run', async () => {
    const { step, stateId, run, made } = await madeDb1();

    expect(step).toMatchObject({
      action: 'create',
      kind: 'mysql',
      database: {
        size: { name: 'small', instanceClass: 'db.t4g.micro' },
        version: { written: '8.4', engineVersion: '8.4' },
        login: { user: 'db_1', database: 'db_1' },
      },
    });
    expect(readOf(step)?.summary).toEqual(
      expect.arrayContaining([
        "db-1 version: MySQL 8.4, RDS's default minor, minor upgrades automatic",
      ]),
    );
    const [readInput] = ctx.cloud.tofuInputs;
    expect(readInput.definition).toContain('"engine": "mysql"');
    expect(readInput.definition).toContain('"engine_version": "8.4"');
    expect(readInput.definition).toContain('"db_name": "db_1"');
    expect(readInput.definition).toContain('"from_port": 3306');
    expect(readInput.definition).not.toContain('5432');

    expect(made).toMatchObject({
      mysqlId: readOf(step)!.serviceId,
      configName: 'db-1',
      cloudAccountId,
      region: REGION,
      serverId: null,
      databaseName: 'db_1',
      databaseUser: 'db_1',
      storageGb: 20,
      backupRetentionDays: 7,
      applicationStatus: 'done',
      rdsEndpoint: { host: ENDPOINT, port: 3306 },
    });
    expect(run).toMatchObject({ mysqlId: made.mysqlId, status: 'done' });
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.mysqlId, made.mysqlId));
    expect(state.infrastructureStateId).toBe(stateId);
    const applyInput = ctx.cloud.tofuInputs.at(-1)!;
    expect(applyInput.variables.master_password).toBe(made.databasePassword);
    expect(applyInput.definition).not.toContain(made.databasePassword);
  });

  it.each([
    ['    version: "8.0"\n', 'db-1.version: MySQL 8.0'],
    ['    version: "9.1"\n', 'db-1.version: MySQL 9.1'],
    ['    user: root\n', 'db-1.user: RDS refuses root'],
    [`    user: ${'a'.repeat(33)}\n`, '32'],
    [`    user: ${'a'.repeat(17)}\n`, '1 to 16'],
  ])('refuses %j by name before anything reaches AWS', async (lines, said) => {
    const refused = await save(`${DB}${lines}`);

    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toContain(said);
    expect(ctx.cloud.calls).toEqual([]);
  });

  it('hands a web the documented url, and the RDS bundle as ca', async () => {
    const { made } = await madeDb1();

    const values = await wiredEnv(ctx.db, environmentId, {
      DATABASE_URL: { source: 'db-1', output: 'url' },
      MYSQL_CA: { source: 'db-1', output: 'ca' },
    });

    expect(values).toEqual({
      DATABASE_URL: `mysql://db_1:${encodeURIComponent(made.databasePassword)}@${ENDPOINT}:3306/db_1`,
      MYSQL_CA: rdsCaBundle(REGION),
    });
  });

  it('stops and starts by RDS calls, with the 7-day warning', async () => {
    const { made } = await madeDb1();
    ctx.cloud.calls.length = 0;

    const stopped = await request(http)
      .post(`/mysql/${made.mysqlId}/stop`)
      .set('Cookie', cookie);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({
      applicationStatus: 'stopped',
      rdsStop: { state: 'stopped' },
    });
    expect(
      (stopped.body as { rdsStop: { warning: string } }).rdsStop.warning,
    ).toContain('AWS starts it again on');
    const started = await request(http)
      .post(`/mysql/${made.mysqlId}/start`)
      .set('Cookie', cookie);
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      applicationStatus: 'done',
      rdsStop: null,
    });
    expect(
      ctx.cloud.calls
        .filter((call) => call.method.startsWith('rds'))
        .map((call) => call.method),
    ).toEqual(['rdsStopInstance', 'rdsStartInstance']);
  });

  it.each([
    [false, `"skip_final_snapshot": false`],
    [true, `"skip_final_snapshot": true`],
  ])(
    'deletes it with protection lifted, its final snapshot kept unless its data is to go (%s)',
    async (deleteData, skip) => {
      const { made } = await madeDb1();
      ctx.cloud.calls.length = 0;
      ctx.cloud.tofuInputs.length = 0;

      const res = await request(http)
        .delete(`/mysql/${made.mysqlId}${deleteData ? '?deleteData=true' : ''}`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        mysqlId: made.mysqlId,
        cloudDelete: {
          status: 'deleting',
          finalSnapshot: deleteData
            ? null
            : `shop-production-db-1-final-${snapshotDate(new Date())}`,
        },
      });
      await until(
        async () => ((await mysqlRows()).length === 0 ? true : undefined),
        'the mysql to go',
      );

      expect(ctx.cloud.calls.map((call) => call.method)).toEqual(
        expect.arrayContaining(['rdsLiftDeletionProtection', 'destroy']),
      );
      expect(ctx.cloud.tofuInputs[0].definition).toContain(skip);
    },
  );

  describe('as an Existing database', () => {
    const useExisting = () =>
      request(http).post('/mysql/existing').set('Cookie', cookie).send({
        environmentId,
        configName: 'db-1',
        identifier: 'acme-prod',
        databaseUser: 'shop_app',
        databasePassword: 'existing-login-password',
        databaseName: 'shop',
        madeReachable: false,
      });

    async function lookup(engine: string) {
      await readyNetwork(lookupVpc());
      const created = await useExisting();
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        configName: 'db-1',
        existing: { identifier: 'acme-prod', hasDatabasePassword: true },
      });
      ctx.cloud.replayShowFor('existing-postgres', lookupRunning(engine));
      expect((await save(DB)).status).toBe(201);
      const read = await readPlan();
      const step = read.steps.find(
        (one) => 'configName' in one && one.configName === 'db-1',
      )!;
      return readOf(step)!;
    }

    it('accepts a MySQL instance', async () => {
      const read = await lookup('mysql');

      expect(read.status).toBe('read');
      expect(read.summary?.[0]).toContain(
        'db-1: existing database acme-prod, MySQL 8.4.6',
      );
    });

    it('refuses a PostgreSQL instance named as a mysql', async () => {
      const read = await lookup('postgres');

      expect(read).toEqual({
        status: 'failed',
        reason:
          'db-1 uses the existing database acme-prod, but acme-prod runs postgres, not MySQL, so a mysql cannot use it',
      });
    });
  });
});
