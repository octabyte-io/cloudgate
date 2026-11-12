import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { valueVariable } from '../../src/cloud-accounts/definitions/tofu-json';
import { rdsCaBundle } from '../../src/cloud-accounts/aws/rds-ca';
import type {
  TofuApplyOutcome,
  TofuApplyRequest,
  TofuShow,
} from '../../src/cloud-accounts/cloud.port';
import {
  application,
  cloudAccount,
  deployment,
  plan as planTable,
  postgres,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { LicenseService } from '../../src/enterprise/license/license.service';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { fakeBinShell } from '../utils/fake-bin-shell';
import { FakeCloudPort, storedPlan } from '../utils/fake-cloud-port';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const ENDPOINT =
  'shop-production-pg-1.c9akciq32.eu-central-1.rds.amazonaws.com';

const STACK = `version: 1
services:
  pg-1:
    kind: postgres
    version: "17"
    size: small
  web:
    kind: web
    size: small
    source: { image: nginx }
    env: [{ DATABASE_URL: pg-1.url }, { PGSSLROOTCERT: pg-1.ca }]
`;

/** The same `web` once `pg-1` is dropped from the config, and its links with it. */
const WEB_ONLY = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
`;

const DIFFERS = 'AWS differs from what Cloudgate made: review the plan';

/** What `tofu output -json` answers after the network's apply. */
const NETWORK_OUTPUTS = {
  vpc_id: 'vpc-0f00ba11',
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

/**
 * `web` and `pg-1` both on AWS, `web` linking `pg-1`'s `url` and
 * `ca`, deploy in one Apply. `pg-1`'s Cloud run (the RDS create) goes
 * first; `web`'s waits for it in the Cloud run pool, then writes each wired
 * value as one more SSM SecureString — `DATABASE_URL` in its
 * `sslmode=require` form, `PGSSLROOTCERT` Amazon's RDS roots for the
 * region — never in the task definition, a saved row or an API answer. A
 * link between a cloud and a Server refuses the plan.
 *
 * Against the fake cloud port (`ctx.cloud`) and a real shell whose `docker`
 * is the fake above, through the real deployment queue.
 */
describe('Wired variables from a postgres on RDS to a cloud web (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const shell = fakeBinShell('wired', { docker: FAKE_DOCKER });
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
    ctx.cloud.replayPlanFor('postgres', 'postgres-create');
    ctx.cloud.replayPlanFor('web', 'web-create');
  });

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  async function openPlan(): Promise<Plan> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.status, 'open'));
      if (
        found &&
        !found.steps.some(
          (step) => 'cloudRead' in step && step.cloudRead?.status === 'reading',
        )
      ) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading AWS');
  }

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

  const deploymentRow = async (deploymentId: string) =>
    (
      await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId))
    )[0];

  const settled = (deploymentId: string): Promise<Deployment> =>
    until(async () => {
      const row = await deploymentRow(deploymentId);
      return row && ['done', 'error', 'cancelled'].includes(row.status)
        ? row
        : undefined;
    }, `Deployment ${deploymentId} to end`);

  /** Each Service's Deployment, once the Apply of `planId` has queued them. */
  async function appliedRuns(
    planId: string,
  ): Promise<(configName: string) => string> {
    const row = await until(async () => {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, planId));
      return found?.results &&
        !found.results.some((result) => result.status === 'running')
        ? found
        : undefined;
    }, 'the Apply to end');
    return (configName) => {
      const result = row.results!.find((one) => one.configName === configName);
      if (result?.deploy?.status !== 'queued') {
        throw new Error(`${configName} queued no Cloud run`);
      }
      return result.deploy.deploymentId;
    };
  }

  /**
   * Holds each RDS apply until released, as RDS's 10–15 minute create
   * holds its Cloud run.
   */
  function holdRdsApplies() {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = ctx.cloud;
    const real = (input: TofuApplyRequest) =>
      FakeCloudPort.prototype.apply.call(
        fake,
        input,
      ) as Promise<TofuApplyOutcome>;
    jest
      .spyOn(ctx.cloud, 'apply')
      .mockImplementation(async (input: TofuApplyRequest) => {
        const resources: object = input.definition.resource ?? {};
        if ('aws_db_instance' in resources) await released;
        return real(input);
      });
    return release;
  }

  /** Plans the stack, applies it with pg-1's create held; answers both runs. */
  async function applyHeld() {
    const saved = await save(STACK);
    expect(saved.status).toBe(201);
    const read = await openPlan();
    expect(
      read.steps.map((step) =>
        'configName' in step ? step.configName : step.action,
      ),
    ).toEqual(['network-create', 'pg-1', 'web']);
    const [networkStep, pgStep, webStep] = read.steps;
    if (
      networkStep.action !== 'network-create' ||
      networkStep.cloudRead.status !== 'read' ||
      pgStep.action !== 'create' ||
      pgStep.cloudRead?.status !== 'read' ||
      webStep.action !== 'create' ||
      webStep.cloudRead?.status !== 'read'
    ) {
      throw new Error('the plan was not read');
    }
    ctx.cloud.outputsFor(networkStep.cloudRead.stateId, NETWORK_OUTPUTS);
    ctx.cloud.outputsFor(pgStep.cloudRead.stateId, {
      endpoint_address: ENDPOINT,
      endpoint_port: 5432,
      instance_identifier: 'shop-production-pg-1',
    });
    const release = holdRdsApplies();

    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    const runOf = await appliedRuns(read.planId);
    return {
      read,
      webStateId: webStep.cloudRead.stateId,
      pgRun: runOf('pg-1'),
      webRun: runOf('web'),
      webId: webStep.cloudRead.serviceId!,
      release,
    };
  }

  it("runs pg-1's Cloud run first, holds web's until it ends, then writes DATABASE_URL and the RDS CA as SSM SecureStrings", async () => {
    // Slots to spare: web waits for pg-1, not for a free slot.
    jest
      .spyOn(ctx.app.get(LicenseService), 'hasAnyValidLicense')
      .mockResolvedValue(true);
    const limit = await request(http)
      .post('/settings/cloud-runs-concurrency')
      .set('Cookie', cookie)
      .send({ cloudRunsConcurrency: 4 });
    expect(limit.status).toBe(200);
    const { read, webStateId, pgRun, webRun, webId, release } =
      await applyHeld();

    // The plan read already wrote web's two parameters, at stand-ins.
    const webRead = ctx.cloud.tofuInputs.find(
      (input) => input.stateId === webStateId,
    )!;
    expect(Object.keys(webRead.variables)).toEqual(
      expect.arrayContaining([
        valueVariable('DATABASE_URL'),
        valueVariable('PGSSLROOTCERT'),
      ]),
    );
    expect(read.steps[2]).toMatchObject({
      fields: expect.arrayContaining([
        { field: 'env.DATABASE_URL', from: null, to: 'pg-1.url' },
      ]) as unknown[],
    });

    // web is built, then waits in the Cloud run pool behind pg-1's run,
    // which is still making the instance.
    const waiting = await until(async () => {
      const row = await deploymentRow(webRun);
      return row?.cloudRun ? row : undefined;
    }, "web's build to hand its row to the Cloud run pool");
    const [pg] = await ctx.db.select().from(postgres);
    expect(waiting).toMatchObject({
      status: 'pending',
      cloudRun: expect.objectContaining({
        kind: 'deploy',
        after: [`postgres:${pg.postgresId}`],
      }) as object,
    });
    expect((await deploymentRow(pgRun)).status).toBe('running');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await deploymentRow(webRun)).status).toBe('pending');
    expect(
      ctx.cloud.calls.filter(
        (call) => 'stateId' in call && call.stateId === webStateId,
      ),
    ).toHaveLength(2); // the plan read, and the Apply's read again

    release();
    expect((await settled(pgRun)).status).toBe('done');
    const webDone = await settled(webRun);
    expect(webDone.status).toBe('done');

    // pg-1's apply came before every call of web's run.
    const order = ctx.cloud.calls.map((call) =>
      'stateId' in call ? `${call.method}:${call.stateId}` : call.method,
    );
    const pgState =
      read.steps[1].action === 'create' && read.steps[1].cloudRead;
    const pgApply = order.indexOf(
      `apply:${pgState && pgState.status === 'read' ? pgState.stateId : ''}`,
    );
    const webApplies = order
      .map((entry, index) => (entry === `apply:${webStateId}` ? index : -1))
      .filter((index) => index >= 0);
    expect(pgApply).toBeGreaterThanOrEqual(0);
    expect(webApplies.length).toBeGreaterThan(0);
    expect(Math.min(...webApplies)).toBeGreaterThan(pgApply);

    // The address saved from pg-1's outputs, never a value of it.
    const [made] = await ctx.db
      .select()
      .from(postgres)
      .where(eq(postgres.postgresId, pg.postgresId));
    expect(made.rdsEndpoint).toEqual({ host: ENDPOINT, port: 5432 });

    // web's apply: each wired value one sensitive variable, its parameter
    // a SecureString the task reads as a secret.
    const webApply = ctx.cloud.tofuInputs
      .filter((input) => input.stateId === webStateId)
      .at(-1)!;
    const url = webApply.variables[valueVariable('DATABASE_URL')];
    const ca = webApply.variables[valueVariable('PGSSLROOTCERT')];
    expect(url).toBe(
      `postgresql://app_pg_1:${encodeURIComponent(made.databasePassword)}@${ENDPOINT}:5432/pg_1?sslmode=require`,
    );
    expect(ca).toBe(rdsCaBundle(REGION));
    expect(ca).toContain('-----BEGIN CERTIFICATE-----');
    expect(webApply.definition).toContain(
      `/cloudgate/${environmentId}/${webId}/DATABASE_URL`,
    );
    expect(webApply.definition).toContain(
      `/cloudgate/${environmentId}/${webId}/PGSSLROOTCERT`,
    );
    expect(webApply.definition).toContain('SecureString');

    // No wired value in the task definition, a saved row or an API answer.
    const secrets = [made.databasePassword, ENDPOINT, 'BEGIN CERTIFICATE'];
    for (const secret of secrets) {
      expect(webApply.definition).not.toContain(secret);
    }
    const rows = JSON.stringify([
      await ctx.db.select().from(application),
      await ctx.db.select().from(deployment),
      await ctx.db.select().from(planTable),
    ]);
    expect(rows).not.toContain(made.databasePassword);
    expect(rows).not.toContain('sslmode=require');
    expect(rows).not.toContain('BEGIN CERTIFICATE');
    const answers = [
      await request(http).get(`/applications/${webId}`).set('Cookie', cookie),
      await request(http)
        .get(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie),
      await request(http)
        .get(`/deployments/${webRun}/logs`)
        .set('Cookie', cookie),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(answer.text).not.toContain(made.databasePassword);
      expect(answer.text).not.toContain('sslmode=require');
      expect(answer.text).not.toContain('BEGIN CERTIFICATE');
    }
  });

  it("fails web's run with a sentence when pg-1's Cloud run failed", async () => {
    const saved = await save(STACK);
    expect(saved.status).toBe(201);
    const read = await openPlan();
    const networkStep = read.steps[0];
    if (
      networkStep.action !== 'network-create' ||
      networkStep.cloudRead.status !== 'read'
    ) {
      throw new Error('the plan was not read');
    }
    ctx.cloud.outputsFor(networkStep.cloudRead.stateId, NETWORK_OUTPUTS);
    const fake = ctx.cloud;
    const real = (input: TofuApplyRequest) =>
      FakeCloudPort.prototype.apply.call(
        fake,
        input,
      ) as Promise<TofuApplyOutcome>;
    jest
      .spyOn(ctx.cloud, 'apply')
      .mockImplementation((input: TofuApplyRequest) => {
        const resources: object = input.definition.resource ?? {};
        if ('aws_db_instance' in resources) {
          return Promise.resolve({
            ok: false,
            reason: 'failed',
            message: 'RDS refused the instance',
          });
        }
        return real(input);
      });

    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    const runOf = await appliedRuns(read.planId);

    expect((await settled(runOf('pg-1'))).status).toBe('error');
    const web = await settled(runOf('web'));
    expect(web.status).toBe('error');
    expect(web.description).toBe(
      'DATABASE_URL links to pg-1.url, but pg-1 is not made on RDS: its Cloud run failed before the instance was made. Its Deployment log says why; apply the plan again, then deploy this Service.',
    );
    // Nothing of web's was applied.
    const [webStep] = read.steps.filter(
      (step) => step.action === 'create' && step.configName === 'web',
    );
    const webState =
      webStep.action === 'create' && webStep.cloudRead?.status === 'read'
        ? webStep.cloudRead.stateId
        : '';
    expect(
      ctx.cloud.calls.some(
        (call) => call.method === 'apply' && call.stateId === webState,
      ),
    ).toBe(false);
  });

  /**
   * web's plan once pg-1 is dropped: its image, and DATABASE_URL's
   * parameter destroyed, which alone is still image-only; and its
   * security group moved in the same change, which is not.
   */
  function databaseUrlRemoved(): TofuShow {
    type Changes = {
      resource_changes: {
        address: string;
        index?: string;
        change: { actions: string[]; after: unknown };
      }[];
    };
    const show = storedPlan('image-only') as unknown as Changes;
    const securityGroup = (
      storedPlan('drift-field') as unknown as Changes
    ).resource_changes.find(
      (one) => one.address === 'aws_security_group.service',
    )!;
    show.resource_changes = [
      ...show.resource_changes.map((one) =>
        one.address === 'aws_ssm_parameter.variable["API_KEY"]'
          ? {
              ...one,
              address: 'aws_ssm_parameter.variable["DATABASE_URL"]',
              index: 'DATABASE_URL',
              change: { ...one.change, actions: ['delete'], after: null },
            }
          : one,
      ),
      securityGroup,
    ];
    return show;
  }

  /** The stack made, both Cloud runs done; then pg-1 dropped from the config and planned. */
  async function droppedDatabase() {
    const made = await applyHeld();
    made.release();
    expect((await settled(made.pgRun)).status).toBe('done');
    expect((await settled(made.webRun)).status).toBe('done');
    ctx.cloud.replayShowFor('web', databaseUrlRemoved());
    expect((await save(WEB_ONLY)).status).toBe(201);
    const dropped = await openPlan();
    expect(
      dropped.steps.map((step) =>
        'configName' in step
          ? `${step.action}:${step.configName}`
          : step.action,
      ),
    ).toEqual(['change:web', 'destroy:pg-1']);
    const webStep = dropped.steps[0];
    if (webStep.action !== 'change' || webStep.cloudRead?.status !== 'read') {
      throw new Error("web's change was not read");
    }
    expect(webStep.cloudRead.imageOnly).toBe(false);
    return { ...made, dropped };
  }

  const applyDropped = async (planId: string) => {
    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId, confirmDestroy: ['pg-1'] });
    expect([res.status, res.body]).toEqual([200, expect.anything()]);
    return appliedRuns(planId);
  };

  const logOf = async (deploymentId: string) => {
    const res = await request(http)
      .get(`/deployments/${deploymentId}/logs`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.text;
  };

  describe('an Apply that drops pg-1 while web links it', () => {
    it("runs web's deploy under that Apply's approval, without its results, and web's apply no longer carries DATABASE_URL", async () => {
      const { dropped, webStateId } = await droppedDatabase();
      // The Apply's results are not read back: the race with the destroy is
      // shut on purpose, not by timing.
      jest
        .spyOn(CloudServiceDeploys.prototype, 'approvedByApply')
        .mockResolvedValue(null);

      const runOf = await applyDropped(dropped.planId);

      const web = await settled(runOf('web'));
      expect([web.status, web.description]).toEqual([
        'done',
        expect.not.stringContaining('review the plan'),
      ]);
      expect(await logOf(web.deploymentId)).not.toContain(DIFFERS);
      const last = ctx.cloud.tofuInputs
        .filter((input) => input.stateId === webStateId)
        .at(-1)!;
      expect(Object.keys(last.variables)).not.toContain(
        valueVariable('DATABASE_URL'),
      );
      // No review plan was opened over what the Apply approved.
      expect(
        await ctx.db
          .select()
          .from(planTable)
          .where(eq(planTable.status, 'open')),
      ).toEqual([]);
      // pg-1's destroy went ahead as its own run.
      const [row] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, dropped.planId));
      expect(row.results).toContainEqual(
        expect.objectContaining({
          configName: 'pg-1',
          action: 'destroy',
          status: 'applied',
        }),
      );
    });

    it('still stops it as stale, applying nothing, when AWS moved after the Apply read it', async () => {
      const { dropped, webStateId } = await droppedDatabase();
      jest
        .spyOn(CloudServiceDeploys.prototype, 'approvedByApply')
        .mockResolvedValue(null);
      // AWS moves between the Apply and web's run: its run reads a plan that
      // would also make a role policy the Apply never approved.
      const fake = ctx.cloud;
      const real = (input: TofuApplyRequest) =>
        FakeCloudPort.prototype.apply.call(
          fake,
          input,
        ) as Promise<TofuApplyOutcome>;
      jest
        .spyOn(ctx.cloud, 'apply')
        .mockImplementation((input: TofuApplyRequest) => {
          if (input.stateId === webStateId) {
            fake.replayPlanFor('web', 'web-bucket-access');
          }
          return real(input);
        });

      const runOf = await applyDropped(dropped.planId);

      const web = await settled(runOf('web'));
      expect(web.status).toBe('error');
      expect(web.description).toContain(
        'AWS no longer matches the plan that was applied',
      );
      const log = await logOf(web.deploymentId);
      expect(log).not.toContain('Apply complete!');
      expect(log).not.toContain(DIFFERS);
    });
  });

  /**
   * One config change drops pg-1 and web, which links to it. web's
   * step only asks for its Delete, a destroy-only Cloud run that is still
   * queued when pg-1's step runs, so web's row and its link are still
   * there; a link held by a Service being deleted does not refuse pg-1's.
   */
  it('applies a plan dropping pg-1 and web together while web’s Cloud delete is still queued, both steps applied', async () => {
    const made = await applyHeld();
    made.release();
    expect((await settled(made.pgRun)).status).toBe('done');
    expect((await settled(made.webRun)).status).toBe('done');
    // web's destroy held until released, as a Cloud run takes minutes.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = ctx.cloud;
    jest
      .spyOn(ctx.cloud, 'destroy')
      .mockImplementation(async (input: TofuApplyRequest) => {
        if (input.stateId === made.webStateId) await released;
        return FakeCloudPort.prototype.destroy.call(
          fake,
          input,
        ) as Promise<TofuApplyOutcome>;
      });

    expect((await save('version: 1\nservices: {}\n')).status).toBe(201);
    const dropped = await openPlan();
    expect(
      dropped.steps.map((step) =>
        'configName' in step
          ? `${step.action}:${step.configName}`
          : step.action,
      ),
    ).toEqual(['destroy:web', 'destroy:pg-1']);
    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: dropped.planId, confirmDestroy: ['web', 'pg-1'] });
    expect(res.status).toBe(200);
    const runOf = await appliedRuns(dropped.planId);

    const [row] = await ctx.db
      .select()
      .from(planTable)
      .where(eq(planTable.planId, dropped.planId));
    expect(
      row.results!.map((result) => [result.configName, result.status]),
    ).toEqual([
      ['web', 'applied'],
      ['pg-1', 'applied'],
    ]);
    // The Apply ended with web's Delete still under way, its link kept.
    expect((await deploymentRow(runOf('web'))).status).not.toBe('done');
    const [web] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.applicationId, made.webId));
    expect(web.cloudDelete?.status).toBe('deleting');
    expect(web.configLinks).toMatchObject({
      DATABASE_URL: { source: 'pg-1', output: 'url' },
    });

    // Each Delete ends clean, and its row goes with its Deployments.
    release();
    await until(
      async () =>
        (await ctx.db.select().from(application)).length === 0 &&
        (await ctx.db.select().from(postgres)).length === 0
          ? true
          : undefined,
      'web and pg-1 to be gone',
    );
    const pgState =
      made.read.steps[1].action === 'create' &&
      made.read.steps[1].cloudRead?.status === 'read'
        ? made.read.steps[1].cloudRead.stateId
        : '';
    expect(
      ctx.cloud.calls
        .filter((call) => call.method === 'destroy')
        .map((call) => ('stateId' in call ? call.stateId : '')),
    ).toEqual(expect.arrayContaining([made.webStateId, pgState]));
  });

  it('refuses a cloud web linking a postgres on the platform host, naming the Service and variable', async () => {
    await ctx.db.insert(postgres).values({
      name: 'pg-1',
      environmentId,
      configName: 'pg-1',
      dockerImage: 'postgres:17',
      databaseName: 'pg_1',
      databaseUser: 'pg_1',
      databasePassword: 'super-secret-database-password',
    });

    const refused = await save(STACK);

    expect(refused.status).toBe(409);
    const { message } = refused.body as { message: string };
    expect(message).toContain('web.env.DATABASE_URL links to pg-1.url');
    expect(message).toContain('cannot reach it');
    expect(
      await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.environmentId, environmentId)),
    ).toEqual([]);
  });
});
