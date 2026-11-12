import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import {
  cloudAccount,
  deployment,
  environmentNetwork,
  postgres,
} from '../../src/db/schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';

const PG = `version: 1
services:
  pg-1:
    kind: postgres
    version: "17"
    size: small
`;

interface Step {
  action: string;
  configName?: string;
  database?: Record<string, unknown>;
  fields?: { field: string; from: unknown; to: unknown }[];
  cloudRead?: {
    status: 'reading' | 'read' | 'failed';
    reason?: string;
    summary?: string[];
    raw?: { address: string; action: string }[];
    stateId?: string;
    serviceId?: string;
  };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
  notes: { kind: string; configName: string; message: string }[];
}

/**
 * An Environment whose Deploy target is an AWS Cloud account plans a
 * `postgres` as an RDS for PostgreSQL instance. The plan names the class
 * its size lands on, with its CPU and memory, and on create its storage,
 * backup retention and version, read from a stored real plan (`ctx.cloud`
 * replays `postgres-create.json`); RDS's refusals refuse the plan before
 * anything is stored; and Apply records the postgres in its cloud place and
 * makes its instance through a Cloud run, in its own Infrastructure state.
 */
describe('Plans that make a postgres on RDS (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
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
    cloudAccountId = row.cloudAccountId;

    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId,
        name: 'production',
        deployTarget: { kind: 'cloud', cloudAccountId, region: 'eu-central-1' },
      });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;

    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('postgres', 'postgres-create');
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;
  });

  /** The Environment network already made here, its ids saved. */
  async function readyNetwork() {
    await ctx.db.insert(environmentNetwork).values({
      environmentId,
      cloudAccountId,
      region: 'eu-central-1',
      status: 'ready',
      vpcId: 'vpc-0a1b',
      publicSubnetIds: ['subnet-0aaa', 'subnet-0bbb'],
      privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'],
      clusterArn: `arn:aws:ecs:eu-central-1:${ACCOUNT}:cluster/env`,
      httpsListenerArn: `arn:aws:elasticloadbalancing:eu-central-1:${ACCOUNT}:listener/app/env/1/2`,
      albSecurityGroupId: 'sg-0alb',
    });
  }

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  async function currentPlan(): Promise<PlanBody> {
    const res = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: PlanBody }).plan;
  }

  /** The open plan once no step is still reading AWS. */
  async function readPlan(): Promise<PlanBody> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = await currentPlan();
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        return found;
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

  const apply = (planId: string) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

  it('plans a create with its class line, storage, retention and version, and Apply makes it through a Cloud run', async () => {
    await readyNetwork();
    const saved = await save(PG);
    expect(saved.status).toBe(201);

    const read = await readPlan();
    expect(read.steps).toEqual([
      expect.objectContaining({
        action: 'create',
        configName: 'pg-1',
        database: expect.objectContaining({
          size: {
            name: 'small',
            instanceClass: 'db.t4g.micro',
            machine: '2 vCPU, 1 GB',
            smallest: false,
          },
        }) as object,
      }),
    ]);
    const [step] = read.steps;
    expect(step.cloudRead?.status).toBe('read');
    expect(step.cloudRead?.summary).toEqual([
      'pg-1 small → db.t4g.micro (2 vCPU, 1 GB)',
      'pg-1 storage: 20 GB gp3, grows to 200 GB',
      'pg-1 backups: kept 7 days',
      "pg-1 version: PostgreSQL 17, RDS's default minor, minor upgrades automatic",
    ]);
    // The read wrote the RDS definition in the network's private subnets,
    // never public, with the password a variable only.
    const [readInput] = ctx.cloud.tofuInputs;
    expect(readInput.definition).toContain('"publicly_accessible": false');
    expect(readInput.definition).toContain('"subnet-0ccc"');
    expect(Object.keys(readInput.variables)).toEqual(['master_password']);
    expect(readInput.definition).not.toContain(
      readInput.variables.master_password,
    );
    // A read is a plan-only Cloud run: it records no Deployment.
    expect(await ctx.db.select().from(deployment)).toEqual([]);

    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      results: [
        {
          configName: 'pg-1',
          action: 'create',
          status: 'applied',
          serviceType: 'postgres',
          serviceId: step.cloudRead!.serviceId,
          deploy: { status: 'queued' },
        },
      ],
    });

    const [created] = await ctx.db.select().from(postgres);
    expect(created).toMatchObject({
      postgresId: step.cloudRead!.serviceId,
      configName: 'pg-1',
      cloudAccountId,
      region: 'eu-central-1',
      serverId: null,
      dockerImage: 'postgres:17',
      databaseName: 'pg_1',
      // PostgreSQL reserves pg_1 as a role, so the default user is app_ it.
      databaseUser: 'app_pg_1',
      instanceClass: null,
      storageGb: 20,
      maxStorageGb: 200,
      multiAz: false,
      backupRetentionDays: 7,
    });
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.postgresId, created.postgresId));
    expect(state.infrastructureStateId).toBe(step.cloudRead!.stateId);

    // Its Cloud run is a Deployment of the postgres, which ends done.
    const { deploymentId } = (
      applied.body as { results: { deploy: { deploymentId: string } }[] }
    ).results[0].deploy;
    const run = await ended(deploymentId);
    expect(run).toMatchObject({
      postgresId: created.postgresId,
      applicationId: null,
      status: 'done',
      cloudRun: expect.objectContaining({ kind: 'database' }) as object,
    });
    const applies = ctx.cloud.calls.filter((call) => call.method === 'apply');
    expect(applies).toEqual([
      expect.objectContaining({
        stateId: state.infrastructureStateId,
        variables: ['master_password'],
      }),
    ]);
    const applyInput = ctx.cloud.tofuInputs.at(-1)!;
    expect(applyInput.variables.master_password).toBe(created.databasePassword);
    expect(applyInput.definition).not.toContain(created.databasePassword);
    expect(applyInput.definition).toContain('"deletion_protection": true');
    expect(applyInput.definition).toContain(
      `"final_snapshot_identifier": "shop-production-pg-1-final-${created.createdAt.slice(0, 10)}"`,
    );
    const [after] = await ctx.db
      .select({ status: postgres.applicationStatus })
      .from(postgres);
    expect(after.status).toBe('done');
    // A postgres on RDS is never started as a container.
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('makes the Environment network first where there is none, then the instance in its private subnets', async () => {
    const saved = await save(PG);
    expect(saved.status).toBe(201);
    const read = await readPlan();
    expect(read.steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);
    expect(read.steps[1].cloudRead?.status).toBe('read');
    // Written with stand-ins for the network's ids, never shown as such.
    expect(ctx.cloud.tofuInputs.at(-1)!.definition).toContain(
      'cloudgate-stand-in',
    );
    ctx.cloud.outputsFor(read.steps[0].cloudRead!.stateId!, {
      vpc_id: 'vpc-0f00ba11',
      public_subnet_ids: ['subnet-0a11', 'subnet-0b22'],
      private_subnet_ids: ['subnet-0c33', 'subnet-0d44'],
      cluster_arn: `arn:aws:ecs:eu-central-1:${ACCOUNT}:cluster/cloudgate-env`,
      alb_arn: `arn:aws:elasticloadbalancing:eu-central-1:${ACCOUNT}:loadbalancer/app/cg/1`,
      alb_dns_name: 'cg-1.eu-central-1.elb.amazonaws.com',
      alb_zone_id: 'Z215JYRZR1TBD5',
      alb_security_group_id: 'sg-0a1b',
      https_listener_arn: `arn:aws:elasticloadbalancing:eu-central-1:${ACCOUNT}:listener/app/cg/1/2`,
      default_certificate_arn: `arn:aws:acm:eu-central-1:${ACCOUNT}:certificate/1`,
    });

    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);

    // The row is written before its Deployment is recorded, so both are
    // waited for.
    let created: typeof postgres.$inferSelect | undefined;
    let run: typeof deployment.$inferSelect | undefined;
    for (let attempt = 0; attempt < 400 && !run; attempt++) {
      [created] = await ctx.db.select().from(postgres);
      if (created) {
        [run] = await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.postgresId, created.postgresId));
      }
      if (!run) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(created?.postgresId).toBe(read.steps[1].cloudRead!.serviceId);
    expect((await ended(run!.deploymentId)).status).toBe('done');
    // Its definition was written again with the network's private subnets.
    const applyInput = ctx.cloud.tofuInputs.at(-1)!;
    expect(applyInput.definition).toContain('"subnet-0c33"');
    expect(applyInput.definition).not.toContain('cloudgate-stand-in');
  });

  it('says "(smallest)" for an entry with no size', async () => {
    await readyNetwork();
    await save('version: 1\nservices:\n  pg-1:\n    kind: postgres\n');

    const read = await readPlan();

    expect(read.steps[0].cloudRead?.summary?.[0]).toBe(
      'pg-1 no size → db.t4g.micro (2 vCPU, 1 GB) (smallest)',
    );
  });

  it('refuses a user RDS refuses, naming the field, and stores no plan', async () => {
    const refused = await save(
      'version: 1\nservices:\n  pg-1:\n    kind: postgres\n    user: rdsadmin\n',
    );

    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toContain(
      'pg-1.user: RDS refuses rdsadmin',
    );
    expect(ctx.cloud.calls).toEqual([]);
  });

  it('refuses a user: pg_admin, which PostgreSQL reserves, before any cloud call', async () => {
    const refused = await save(
      'version: 1\nservices:\n  pg-1:\n    kind: postgres\n    user: pg_admin\n',
    );

    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toContain(
      'pg-1.user: PostgreSQL reserves role names starting with pg_; choose another user:',
    );
    expect(ctx.cloud.calls).toEqual([]);
    expect(await ctx.db.select().from(postgres)).toHaveLength(0);
  });

  it('refuses a version RDS does not offer, naming it', async () => {
    const refused = await save(
      'version: 1\nservices:\n  pg-1:\n    kind: postgres\n    version: "12"\n',
    );

    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toContain(
      'pg-1.version: PostgreSQL 12 is not offered by RDS',
    );
  });

  it('plans "no change on AWS" for a size landing on the class it runs on, and Apply starts no container', async () => {
    await readyNetwork();
    await save(PG);
    const read = await readPlan();
    const applied = await apply(read.planId);
    const { deploymentId } = (
      applied.body as { results: { deploy: { deploymentId: string } }[] }
    ).results[0].deploy;
    await ended(deploymentId);

    const changed = await save(PG.replace('size: small', 'size: xsmall'));
    expect(changed.status).toBe(201);
    const plan = await currentPlan();

    expect(plan.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'pg-1',
        fields: [{ field: 'size', from: 'small', to: 'xsmall' }],
      }),
    ]);
    expect(plan.notes).toContainEqual({
      kind: 'cloud-same-class',
      configName: 'pg-1',
      message:
        'pg-1.size: small → xsmall runs on db.t4g.micro either way: no change on AWS',
    });

    const again = await apply(plan.planId);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      results: [{ configName: 'pg-1', status: 'applied', deploy: null }],
    });
  });

  /** pg-1 made on RDS by an Apply, its run ended; the fake reset after. */
  async function madePg1() {
    await readyNetwork();
    await save(PG);
    const read = await readPlan();
    const applied = await apply(read.planId);
    const { deploymentId } = (
      applied.body as { results: { deploy: { deploymentId: string } }[] }
    ).results[0].deploy;
    await ended(deploymentId);
    const [created] = await ctx.db.select().from(postgres);
    ctx.cloud.reset();
    return created;
  }

  it("names a destroy's final snapshot on its row, and a rename says the new one starts empty", async () => {
    await madePg1();

    expect((await save(PG.replace('pg-1', 'pg-2'))).status).toBe(201);
    const read = await readPlan();

    const today = new Date().toISOString().slice(0, 10);
    expect(read.steps).toContainEqual(
      expect.objectContaining({
        action: 'destroy',
        configName: 'pg-1',
        finalSnapshot: {
          cloud: 'aws',
          name: `shop-production-pg-1-final-${today}`,
          monthlyUsd: 1.9,
        },
      }),
    );
    expect(read.notes).toContainEqual({
      kind: 'data-not-copied',
      configName: 'pg-2',
      message: "pg-2: the new pg-2 starts empty; pg-1's data is not copied",
    });
  });

  it('takes "also delete its data" per destroy row, and refuses it on anything else', async () => {
    const created = await madePg1();
    expect((await save('version: 1\nservices: {}\n')).status).toBe(201);
    const read = await readPlan();
    expect(read.steps).toEqual([
      expect.objectContaining({ action: 'destroy', configName: 'pg-1' }),
    ]);

    const wrong = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({
        planId: read.planId,
        confirmDestroy: ['pg-1'],
        deleteDataOf: ['web'],
      });
    expect(wrong.status).toBe(409);

    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({
        planId: read.planId,
        confirmDestroy: ['pg-1'],
        deleteDataOf: ['pg-1'],
      });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      results: [
        {
          configName: 'pg-1',
          action: 'destroy',
          status: 'applied',
          deploy: { status: 'queued' },
        },
      ],
    });
    // A clean finish drops the row, and its Deployments with it.
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await ctx.db.select().from(postgres)).length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(await ctx.db.select().from(postgres)).toEqual([]);
    expect(ctx.cloud.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining(['rdsLiftDeletionProtection', 'apply', 'destroy']),
    );
    expect(ctx.cloud.tofuInputs[0].definition).toContain(
      '"skip_final_snapshot": true',
    );
    expect(created.postgresId).toBeDefined();
  });
});
