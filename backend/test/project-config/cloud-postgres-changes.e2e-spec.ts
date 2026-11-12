import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import {
  cloudAccount,
  deployment,
  environmentNetwork,
  infrastructureState,
  postgres,
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
  fields?: { field: string; from: unknown; to: unknown }[];
  database?: Record<string, unknown>;
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
 * Once `pg-1` runs on RDS, every change the operator makes is
 * planned honestly. A class change is marked as a restart; storage,
 * Multi-AZ and retention carry no mark; a major upgrade is shown apart and
 * confirmed at Apply by the Service's name, and only that run carries
 * `allow_major_version_upgrade`; a downgrade refuses, naming the version it
 * runs. The console's RDS settings are Cloudgate's per Service, checked at
 * the API, and shown in the next plan. `ctx.cloud` replays stored real
 * change plans (`postgres-*-change.json`, `postgres-major-upgrade.json`).
 */
describe('Changes to a postgres on RDS (e2e)', () => {
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

    const [network] = await ctx.db
      .insert(environmentNetwork)
      .values({
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
    ctx.cloud.replayPlanFor('postgres', 'postgres-create');
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

  const rdsSettings = (postgresId: string, body: Record<string, unknown>) =>
    request(http)
      .patch(`/postgres/${postgresId}/rds-settings`)
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
    expect((await ended(deploy.deploymentId)).status).toBe('done');
    return deploy.deploymentId;
  }

  /** `pg-1` made on RDS from `PG`, then the change plan `fixture` replayed. */
  async function madeOnRds(fixture: string, text = PG) {
    expect((await save(text)).status).toBe(201);
    await applyAndRun((await readPlan()).planId);
    ctx.cloud.replayPlanFor('postgres', fixture);
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;
    const [made] = await ctx.db.select().from(postgres);
    return made;
  }

  /** The instance's arguments in a tofu run's definition. */
  function instanceOf(definition: string): Record<string, unknown> {
    const parsed = JSON.parse(definition) as {
      resource: { aws_db_instance: { database: Record<string, unknown> } };
    };
    return parsed.resource.aws_db_instance.database;
  }

  it('plans a new size as a class change marked as a restart, and Apply moves the instance through a Cloud run', async () => {
    await madeOnRds('postgres-class-change');

    expect((await save(PG.replace('size: small', 'size: large'))).status).toBe(
      201,
    );
    const plan = await readPlan();

    expect(plan.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'pg-1',
        fields: [{ field: 'size', from: 'small', to: 'large' }],
        database: {
          instanceClass: {
            from: 'db.t4g.micro',
            to: 'db.t4g.medium',
            machine: '2 vCPU, 4 GB',
            sizeName: 'large',
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
      'pg-1 large → db.t4g.medium (2 vCPU, 4 GB), from db.t4g.micro',
      'restarts pg-1: a few minutes offline',
    ]);
    expect(step.cloudRead?.outages).toEqual([
      {
        kind: 'restart',
        serviceName: 'pg-1',
        line: 'restarts pg-1: a few minutes offline',
      },
    ]);
    // The read planned the instance's own state with the new class.
    const [read] = ctx.cloud.tofuInputs;
    expect(instanceOf(read.definition)).toMatchObject({
      instance_class: 'db.t4g.medium',
      apply_immediately: true,
    });

    await applyAndRun(plan.planId);

    const run = ctx.cloud.tofuInputs.at(-1)!;
    expect(instanceOf(run.definition)).toMatchObject({
      instance_class: 'db.t4g.medium',
      allow_major_version_upgrade: false,
    });
    expect(run.definition).not.toContain(run.variables.master_password);
    // Never started as a container.
    expect(queue.add).not.toHaveBeenCalled();
    // Applied, the next plan has nothing left to do.
    const again = await checkForChanges();
    expect(again.status).toBe(201);
    // Unchanged once the network's Drift read finds nothing either.
    expect((await readPlan()).status).toBe('unchanged');
  });

  it("plans the console's storage, Multi-AZ and retention with no warning, stored per Service and applied by the next Cloud run", async () => {
    const made = await madeOnRds('postgres-settings-change');

    const saved = await rdsSettings(made.postgresId, {
      storageGb: 50,
      maxStorageGb: 400,
      multiAz: true,
      backupRetentionDays: 14,
    });
    expect(saved.status).toBe(200);
    const [row] = await ctx.db.select().from(postgres);
    expect(row).toMatchObject({
      storageGb: 50,
      maxStorageGb: 400,
      multiAz: true,
      backupRetentionDays: 14,
    });

    const checked = await checkForChanges();
    expect(checked.status).toBe(201);
    const plan = await readPlan();
    expect(plan.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'pg-1',
        fields: [],
        database: {
          instanceClass: null,
          version: null,
          settings: [
            { setting: 'storageGb', from: 20, to: 50 },
            { setting: 'maxStorageGb', from: 200, to: 400 },
            { setting: 'backupRetentionDays', from: 7, to: 14 },
            { setting: 'multiAz', from: false, to: true },
          ],
        },
      }),
    ]);
    const [step] = plan.steps;
    expect(step.cloudRead?.summary).toEqual([
      'pg-1 storage: 20 GB → 50 GB',
      'pg-1 storage grows to: 200 GB → 400 GB',
      'pg-1 Multi-AZ: off → on, a standby in a second zone',
      'pg-1 backups: kept 7 days → 14 days',
    ]);
    expect(step.cloudRead?.outages).toBeUndefined();

    await applyAndRun(plan.planId);

    expect(instanceOf(ctx.cloud.tofuInputs.at(-1)!.definition)).toMatchObject({
      allocated_storage: 50,
      max_allocated_storage: 400,
      multi_az: true,
      backup_retention_period: 14,
    });
    expect((await checkForChanges()).status).toBe(201);
    // Unchanged once the network's Drift read finds nothing either.
    expect((await readPlan()).status).toBe('unchanged');
  });

  it('makes a plan made before a console edit stale', async () => {
    const made = await madeOnRds('postgres-class-change');
    await save(PG.replace('size: small', 'size: large'));
    const plan = await readPlan();

    await rdsSettings(made.postgresId, { backupRetentionDays: 10 });

    const refused = await apply(plan.planId);
    expect(refused.status).toBe(409);
    expect((refused.body as { code: string }).code).toBe('PLAN_STALE');
  });

  it.each([
    [{ backupRetentionDays: 0 }, 'backupRetentionDays must be 1 to 35'],
    [{ backupRetentionDays: 36 }, 'backupRetentionDays must be 1 to 35'],
    [{ storageGb: 10 }, 'storageGb must be at least 20'],
    [{ storageGb: 100, maxStorageGb: 50 }, 'maxStorageGb must be at least'],
    [{ instanceClass: 'db.t4g.small' }, "pg-1's class comes from its size"],
  ])('refuses %j through the API, naming why', async (body, message) => {
    const made = await madeOnRds('postgres-settings-change');

    const refused = await rdsSettings(made.postgresId, body);

    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(message);
    const [row] = await ctx.db.select().from(postgres);
    expect(row.backupRetentionDays).toBe(7);
    expect(row.storageGb).toBe(20);
  });

  it('refuses shrinking storage RDS has already grown to', async () => {
    const made = await madeOnRds('postgres-settings-change');
    await rdsSettings(made.postgresId, { storageGb: 50 });
    await checkForChanges();
    await applyAndRun((await readPlan()).planId);

    const refused = await rdsSettings(made.postgresId, { storageGb: 40 });

    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(
      'RDS cannot shrink an instance',
    );
  });

  it('takes the console class for an entry with no size, and plans it as a restart', async () => {
    const made = await madeOnRds(
      'postgres-class-change',
      'version: 1\nservices:\n  pg-1:\n    kind: postgres\n    version: "17"\n',
    );
    expect(made.instanceClass).toBe('db.t4g.micro');

    const unknown = await rdsSettings(made.postgresId, {
      instanceClass: 'db.r7g.large',
    });
    expect(unknown.status).toBe(400);
    const saved = await rdsSettings(made.postgresId, {
      instanceClass: 'db.t4g.medium',
    });
    expect(saved.status).toBe(200);

    await checkForChanges();
    const plan = await readPlan();

    expect(plan.steps[0]).toMatchObject({
      action: 'change',
      database: {
        instanceClass: {
          from: 'db.t4g.micro',
          to: 'db.t4g.medium',
          sizeName: null,
        },
      },
    });
    expect(
      plan.steps[0].cloudRead?.outages?.map((outage) => outage.kind),
    ).toEqual(['restart']);
  });

  it('shows a major upgrade apart and refuses its Apply until the Service is named; named, only that run allows it', async () => {
    await madeOnRds('postgres-major-upgrade');

    expect(
      (await save(PG.replace('version: "17"', 'version: "18"'))).status,
    ).toBe(201);
    const plan = await readPlan();

    const [step] = plan.steps;
    expect(step).toMatchObject({
      action: 'change',
      configName: 'pg-1',
      majorUpgrade: { from: '17', to: '18' },
    });
    expect(step.cloudRead?.outages).toEqual([
      {
        kind: 'major-upgrade',
        serviceName: 'pg-1',
        line: 'pg-1 major upgrade: PostgreSQL 17 → 18, offline during the upgrade, cannot be undone',
      },
    ]);

    const unconfirmed = await apply(plan.planId);
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body).toMatchObject({
      code: 'PLAN_UPGRADE_NOT_CONFIRMED',
    });
    expect((unconfirmed.body as { message: string }).message).toContain(
      'it upgrades to a new major version pg-1, which the Apply does not confirm',
    );
    const wrong = await apply(plan.planId, { confirmUpgrade: ['pg-2'] });
    expect(wrong.status).toBe(409);
    // A confirmation in the destroy list does not stand in for one.
    const misplaced = await apply(plan.planId, { confirmDestroy: ['pg-1'] });
    expect(misplaced.status).toBe(409);
    expect(ctx.cloud.calls.filter((call) => call.method === 'apply')).toEqual(
      [],
    );

    await applyAndRun(plan.planId, { confirmUpgrade: ['pg-1'] });

    const run = ctx.cloud.tofuInputs.at(-1)!;
    expect(instanceOf(run.definition)).toMatchObject({
      engine_version: '18',
      allow_major_version_upgrade: true,
    });
    const [row] = await ctx.db.select().from(postgres);
    expect(row.dockerImage).toBe('postgres:18');
  });

  it('refuses a major downgrade, naming the version pg-1 runs', async () => {
    await madeOnRds(
      'postgres-major-upgrade',
      PG.replace('version: "17"', 'version: "18"'),
    );

    const refused = await save(PG);

    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toContain(
      'pg-1.version: "17" is older than PostgreSQL 18, which pg-1 runs on RDS, and RDS cannot move an instance back to an older major version',
    );
  });

  /**
   * ADR-0044 rule 10: a console-owned setting the config's
   * `native.aws` sets wins, the Database page refuses to change it and
   * says why, and taking the key out leaves the value where it is and
   * hands it back to the page.
   */
  it('lets native storage win, refuses it on the Database page while native sets it, and hands it back where it is once taken out', async () => {
    const NATIVE = `${PG}    native:
      aws:
        "aws_db_instance.database":
          allocated_storage: 50
`;
    expect((await save(NATIVE)).status).toBe(201);
    const created = await readPlan();
    expect(created.steps[0].fields).toContainEqual(
      expect.objectContaining({
        field: 'native.aws."aws_db_instance.database".allocated_storage',
        to: 50,
        native: true,
      }),
    );
    await applyAndRun(created.planId);
    expect(instanceOf(ctx.cloud.tofuInputs.at(-1)!.definition)).toMatchObject({
      allocated_storage: 50,
    });
    const [made] = await ctx.db.select().from(postgres);
    expect(made).toMatchObject({
      storageGb: 50,
      nativeAws: { 'aws_db_instance.database': { allocated_storage: 50 } },
    });

    const refused = await rdsSettings(made.postgresId, { storageGb: 60 });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain(
      'storageGb is set by pg-1.native.aws.\\"aws_db_instance.database\\".allocated_storage in the Project config',
    );
    const [kept] = await ctx.db.select().from(postgres);
    expect(kept.storageGb).toBe(50);

    // Taken out: handed back to the console at 50, never reset to 20.
    ctx.cloud.replayPlanFor('postgres', 'postgres-settings-change');
    ctx.cloud.tofuInputs.length = 0;
    expect((await save(PG)).status).toBe(201);
    const removed = await readPlan();
    expect(removed.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'pg-1',
        fields: [
          {
            field: 'native.aws."aws_db_instance.database".allocated_storage',
            from: 50,
            to: 50,
            native: true,
            toConsole: true,
          },
        ],
      }),
    ]);
    await applyAndRun(removed.planId);
    expect(instanceOf(ctx.cloud.tofuInputs.at(-1)!.definition)).toMatchObject({
      allocated_storage: 50,
    });
    const [handedBack] = await ctx.db.select().from(postgres);
    expect(handedBack).toMatchObject({ storageGb: 50, nativeAws: null });

    expect((await rdsSettings(made.postgresId, { storageGb: 60 })).status).toBe(
      200,
    );
  });

  /**
   * ADR-0044 rule 12: a class the config's `native.aws` sets wins
   * over its size on AWS and is applied, the Database page refuses to
   * change it and says why, and taking it out with a size falls back to
   * the size's class.
   */
  it("applies a native class over the size, refuses it on the Database page while native sets it, and falls back to the size's once taken out", async () => {
    const NATIVE = `${PG}    native:
      aws:
        "aws_db_instance.database":
          instance_class: db.r7g.xlarge
`;
    expect((await save(NATIVE)).status).toBe(201);
    const created = await readPlan();
    expect(created.steps[0]).toMatchObject({
      action: 'create',
      database: {
        size: {
          name: 'small',
          instanceClass: 'db.r7g.xlarge',
          machine: '4 vCPU, 32 GB',
          native: true,
        },
      },
    });
    await applyAndRun(created.planId);
    expect(instanceOf(ctx.cloud.tofuInputs.at(-1)!.definition)).toMatchObject({
      instance_class: 'db.r7g.xlarge',
    });
    const [made] = await ctx.db.select().from(postgres);
    expect(made).toMatchObject({
      instanceClass: 'db.r7g.xlarge',
      nativeAws: {
        'aws_db_instance.database': { instance_class: 'db.r7g.xlarge' },
      },
    });

    const refused = await rdsSettings(made.postgresId, {
      instanceClass: 'db.t4g.medium',
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain(
      'instanceClass is set by pg-1.native.aws.\\"aws_db_instance.database\\".instance_class in the Project config',
    );

    // Taken out with a size: back to the size's class, never kept.
    ctx.cloud.replayPlanFor('postgres', 'postgres-class-change');
    ctx.cloud.tofuInputs.length = 0;
    expect((await save(PG)).status).toBe(201);
    const removed = await readPlan();
    expect(removed.steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'pg-1',
        fields: [
          {
            field: 'native.aws."aws_db_instance.database".instance_class',
            from: 'db.r7g.xlarge',
            to: 'db.t4g.micro',
            native: true,
            toSize: true,
          },
        ],
        database: expect.objectContaining({
          instanceClass: {
            from: 'db.r7g.xlarge',
            to: 'db.t4g.micro',
            machine: '2 vCPU, 1 GB',
            sizeName: 'small',
          },
          native: null,
        }) as object,
      }),
    ]);
    await applyAndRun(removed.planId);
    expect(instanceOf(ctx.cloud.tofuInputs.at(-1)!.definition)).toMatchObject({
      instance_class: 'db.t4g.micro',
    });
    const [fellBack] = await ctx.db.select().from(postgres);
    expect(fellBack).toMatchObject({ instanceClass: null, nativeAws: null });
  });
});
