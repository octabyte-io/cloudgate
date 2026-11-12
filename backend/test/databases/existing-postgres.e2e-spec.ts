import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { valueVariable } from '../../src/cloud-accounts/definitions/tofu-json';
import { rdsCaBundle } from '../../src/cloud-accounts/aws/rds-ca';
import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import {
  application,
  cloudAccount,
  deployment,
  environmentNetwork,
  existingDatabase,
  plan as planTable,
  postgres,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { cloudReadOf } from '../../src/project-config/planner/cloud-steps';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { fakeBinShell } from '../utils/fake-bin-shell';
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
/** Where the stored lookup finds `acme-prod`. */
const HOST = 'acme-prod.aaaaaaaaaa.eu-central-1.rds.amazonaws.com';
const ACME_VPC = 'vpc-00000000000000001';
/** The apps' login, typed by the operator: a secret, never returned. */
const LOGIN_PASSWORD = 'apps-login-p@ss/w0rd';

const PG_ONLY = `version: 1
services:
  pg-1:
    kind: postgres
    version: "17"
    size: large
`;

const STACK = `${PG_ONLY}  web:
    kind: web
    size: small
    source: { image: nginx }
    env: [{ DATABASE_URL: pg-1.url }, { PGSSLROOTCERT: pg-1.ca }]
`;

/** What `tofu output -json` answers after the network's apply. */
const NETWORK_OUTPUTS = {
  vpc_id: 'vpc-0e0e0e0e',
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

type Resource = { type: string; values: Record<string, unknown> };

/** The stored lookup, its instance's values (or what it found) changed. */
function lookupShowing(
  change: (resources: Resource[]) => Resource[],
): TofuShow {
  const show = storedPlan('existing-postgres-lookup') as {
    prior_state: { values: { root_module: { resources: Resource[] } } };
  };
  const resources = change(
    structuredClone(show.prior_state.values.root_module.resources),
  );
  return {
    ...show,
    prior_state: { values: { root_module: { resources } } },
  };
}

const instanceOf = (resources: Resource[]) =>
  resources.find((one) => one.type === 'aws_db_instance')!;

/**
 * An Environment's `pg-1` (ADR-0033) uses `acme-prod`, an RDS
 * instance the operator already has. Created from the console with the
 * apps' login, it is looked up at every plan through an OpenTofu `data`
 * source, never created, changed or deleted, hands out the usual Outputs
 * from the typed login and the looked-up address, and its Delete removes
 * only Cloudgate's records. Against the fake cloud port (`ctx.cloud`) and,
 * for a cloud `web`'s deploy, a real shell whose `docker` is the fake above.
 */
describe('An existing database used as an Environment’s postgres (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const shell = fakeBinShell('existing', { docker: FAKE_DOCKER });
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
    ctx.cloud.replayPlanFor('web', 'web-create');
    ctx.cloud.replayPlanFor('existing-postgres', 'existing-postgres-lookup');
  });

  const useExisting = (body: Record<string, unknown> = {}) =>
    request(http)
      .post('/postgres/existing')
      .set('Cookie', cookie)
      .send({
        environmentId,
        configName: 'pg-1',
        identifier: 'acme-prod',
        databaseUser: 'shop_app',
        databasePassword: LOGIN_PASSWORD,
        databaseName: 'shop',
        madeReachable: false,
        ...body,
      });

  async function created(body: Record<string, unknown> = {}) {
    const res = await useExisting(body);
    expect(res.status).toBe(201);
    return (res.body as { postgresId: string }).postgresId;
  }

  /** The Environment network, made, in `acme-prod`'s VPC. */
  async function networkIn(vpcId: string) {
    await ctx.db.insert(environmentNetwork).values({
      environmentId,
      cloudAccountId,
      region: REGION,
      status: 'ready',
      vpcId,
      publicSubnetIds: ['subnet-0a11', 'subnet-0b22'],
      privateSubnetIds: ['subnet-0c33', 'subnet-0d44'],
      clusterArn: NETWORK_OUTPUTS.cluster_arn,
      httpsListenerArn: NETWORK_OUTPUTS.https_listener_arn,
      albSecurityGroupId: 'sg-0a1b',
    });
  }

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

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
        !found.steps.some((step) => cloudReadOf(step)?.status === 'reading')
      ) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading AWS');
  }

  async function lookupOf(text = PG_ONLY) {
    const saved = await save(text);
    expect(saved.status).toBe(201);
    const read = await readPlan();
    const step = read.steps.find(
      (one) => 'configName' in one && one.configName === 'pg-1',
    );
    if (step?.action !== 'change') throw new Error('pg-1 has no change step');
    return { plan: read, step, aws: step.cloudRead! };
  }

  const apply = (planId: string) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

  /** Every `tofu` run and AWS call that writes. */
  const writes = () =>
    ctx.cloud.calls.filter(
      (call) =>
        call.method === 'apply' ||
        call.method === 'destroy' ||
        call.method.startsWith('ecs') ||
        call.method.startsWith('ecr'),
    );

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

  const settled = (deploymentId: string): Promise<Deployment> =>
    until(async () => {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      return row && ['done', 'error', 'cancelled'].includes(row.status)
        ? row
        : undefined;
    }, `Deployment ${deploymentId} to end`);

  describe('Create', () => {
    it('makes a postgres Service under the Config name, its login set and never returned', async () => {
      const callsBefore = ctx.cloud.calls.length;
      const res = await useExisting();

      expect(res.status).toBe(201);
      expect(res.text).not.toContain(LOGIN_PASSWORD);
      expect(res.body).toMatchObject({
        configName: 'pg-1',
        databaseUser: 'shop_app',
        databaseName: 'shop',
        existing: {
          identifier: 'acme-prod',
          cloudAccountId,
          region: REGION,
          madeReachable: false,
          address: null,
          hasDatabasePassword: true,
        },
      });
      const postgresId = (res.body as { postgresId: string }).postgresId;
      const read = await request(http)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', cookie);
      expect(read.status).toBe(200);
      expect(read.text).not.toContain(LOGIN_PASSWORD);
      expect(read.body).not.toHaveProperty('databasePassword');
      // Stored encrypted, the column's own (ADR-0006).
      const [row] = await ctx.db
        .select()
        .from(postgres)
        .where(eq(postgres.postgresId, postgresId));
      expect(row.databasePassword).toBe(LOGIN_PASSWORD);
      // Nothing reached AWS, and no Project config was written.
      expect(ctx.cloud.calls.slice(callsBefore)).toEqual([]);
      const config = await request(http)
        .get(`/projects/${projectId}/config`)
        .set('Cookie', cookie);
      expect(config.text).not.toContain('acme-prod');
    });

    it('edits the login on its page and still never returns it', async () => {
      const postgresId = await created();

      const res = await request(http)
        .patch(`/postgres/${postgresId}/existing`)
        .set('Cookie', cookie)
        .send({ databasePassword: 'a-new-apps-password', madeReachable: true });

      expect(res.status).toBe(200);
      expect(res.text).not.toContain('a-new-apps-password');
      expect(res.body).toMatchObject({
        existing: { madeReachable: true, hasDatabasePassword: true },
      });
    });

    it('refuses an Environment whose Deploy target is not a Cloud account', async () => {
      const env = await request(http)
        .post('/environments')
        .set('Cookie', cookie)
        .send({ projectId, name: 'staging' });
      expect(env.status).toBe(201);

      const res = await useExisting({
        environmentId: (env.body as { environmentId: string }).environmentId,
      });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'EXISTING_DATABASE_NEEDS_CLOUD' });
    });

    it('refuses a Config name the Environment already has', async () => {
      await created();

      expect((await useExisting()).status).toBe(409);
    });

    it("shows the Environment's Services' security groups to let in", async () => {
      await networkIn(ACME_VPC);

      const res = await request(http)
        .get(`/postgres/existing/reach?environmentId=${environmentId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        cloudAccountId,
        cloudAccountName: 'Production AWS',
        region: REGION,
        vpcId: ACME_VPC,
        serviceSubnets: ['10.80.0.0/20', '10.80.16.0/20'],
        port: 5432,
        securityGroups: [],
        // Google's half of the reach: none on AWS.
        google: null,
      });
    });
  });

  describe('Each plan’s lookup', () => {
    it('creates nothing, reads acme-prod through a data source and saves where it answers', async () => {
      const postgresId = await created();
      await networkIn(ACME_VPC);

      const { plan, step, aws } = await lookupOf();

      expect(plan.steps).toHaveLength(1);
      expect(plan.steps.some((one) => one.action === 'create')).toBe(false);
      expect(step).toMatchObject({
        serviceId: postgresId,
        fields: [],
        existing: { identifier: 'acme-prod', version: 'postgres:17' },
      });
      expect(aws).toMatchObject({
        status: 'read',
        summary: [
          `pg-1: existing database acme-prod, PostgreSQL 17.4, at ${HOST}:5432; used as given, Cloudgate changes nothing in it`,
        ],
      });
      // Found as given: nothing to apply, so the plan is unchanged.
      expect(plan.status).toBe('unchanged');
      expect(plan.notes).toContainEqual({
        kind: 'existing-not-applied',
        configName: 'pg-1',
        message:
          "pg-1 uses the existing database acme-prod: the config's database, user, size and version are not applied to it",
      });
      const [saved] = await ctx.db
        .select()
        .from(existingDatabase)
        .where(eq(existingDatabase.postgresId, postgresId));
      expect(saved.address).toEqual({ host: HOST, port: 5432 });
      // Only data sources were planned; the login never reached `tofu`.
      const run = ctx.cloud.tofuInputs.at(-1)!;
      expect(run.definition).toContain('aws_db_instances');
      expect(run.definition).not.toContain('"resource"');
      expect(run.definition).not.toContain(LOGIN_PASSWORD);
      expect(run.variables).toEqual({});
      expect(writes()).toEqual([]);
    });

    it('is never seen open once its last read has landed, so a no-op plan is never offered to Apply', async () => {
      await created();
      await networkIn(ACME_VPC);
      // Widens the moment the plan settles `unchanged`, so a read and its
      // settling written apart would be seen between the two.
      await ctx.db.execute(sql`
        CREATE FUNCTION slow_settle() RETURNS trigger AS $$
        BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER slow_settle BEFORE UPDATE ON plan FOR EACH ROW
          WHEN (OLD.status = 'open' AND NEW.status = 'unchanged')
          EXECUTE FUNCTION slow_settle();
      `);
      try {
        const saved = await save(PG_ONLY);
        expect(saved.status).toBe(201);
        const seen: { status: string; reading: boolean }[] = [];
        for (let attempt = 0; attempt < 400; attempt++) {
          const [found] = await ctx.db
            .select()
            .from(planTable)
            .where(eq(planTable.environmentId, environmentId))
            .orderBy(desc(planTable.createdAt))
            .limit(1);
          seen.push({
            status: found.status,
            reading: found.steps.some(
              (step) => cloudReadOf(step)?.status === 'reading',
            ),
          });
          if (found.status !== 'open') break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        expect(seen.at(-1)?.status).toBe('unchanged');
        expect(seen).not.toContainEqual({ status: 'open', reading: false });
      } finally {
        await ctx.db.execute(sql`
          DROP TRIGGER slow_settle ON plan;
          DROP FUNCTION slow_settle();
        `);
      }
    });

    it('notes a major version other than the config’s, refusing nothing', async () => {
      await created();
      await networkIn(ACME_VPC);
      ctx.cloud.replayShowFor(
        'existing-postgres',
        lookupShowing((resources) => {
          instanceOf(resources).values.engine_version = '16.4';
          return resources;
        }),
      );

      const { aws } = await lookupOf();

      expect(aws.status).toBe('read');
      expect(aws.status === 'read' && aws.summary).toContain(
        "pg-1: acme-prod runs PostgreSQL 16.4, and the config's version is 17; the version is not applied to an existing database",
      );
    });

    it('refuses a database AWS does not have, naming identifier, Cloud account and region', async () => {
      await created();
      ctx.cloud.replayShowFor(
        'existing-postgres',
        lookupShowing((resources) =>
          resources.filter((one) => one.type === 'aws_db_instances'),
        ),
      );

      const { plan, aws } = await lookupOf();

      expect(aws).toEqual({
        status: 'failed',
        reason: `pg-1 uses the existing database acme-prod, but AWS has no RDS instance acme-prod in Cloud account Production AWS (${ACCOUNT}), region ${REGION}. Check the identifier on pg-1's page; it must be in this Environment's Cloud account and region`,
      });
      const refused = await apply(plan.planId);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'PLAN_AWS_NOT_READ' });
      expect((refused.body as { message: string }).message).toContain(
        'AWS has no RDS instance acme-prod',
      );
    });

    it('refuses one that is not PostgreSQL', async () => {
      await created();
      await networkIn(ACME_VPC);
      ctx.cloud.replayShowFor(
        'existing-postgres',
        lookupShowing((resources) => {
          instanceOf(resources).values.engine = 'mysql';
          return resources;
        }),
      );

      const { aws } = await lookupOf();

      expect(aws).toEqual({
        status: 'failed',
        reason:
          'pg-1 uses the existing database acme-prod, but acme-prod runs mysql, not PostgreSQL, so a postgres cannot use it',
      });
    });

    it("refuses one carrying Cloudgate's tags", async () => {
      await created();
      await networkIn(ACME_VPC);
      ctx.cloud.replayShowFor(
        'existing-postgres',
        lookupShowing((resources) => {
          instanceOf(resources).values.tags = {
            'cloudgate:cloud-account': cloudAccountId,
            'cloudgate:environment': 'another-environment',
            'cloudgate:state': 'st-1',
          };
          return resources;
        }),
      );

      const { aws } = await lookupOf();

      expect(aws.status).toBe('failed');
      expect(aws.status === 'failed' && aws.reason).toContain(
        "acme-prod carries Cloudgate's tags (cloudgate:cloud-account, cloudgate:environment, cloudgate:state)",
      );
    });

    it('refuses one in another VPC without the tick', async () => {
      await created();
      await networkIn('vpc-0e0e0e0e');

      const { aws } = await lookupOf();

      expect(aws).toEqual({
        status: 'failed',
        reason: `pg-1 uses the existing database acme-prod, but acme-prod is in VPC ${ACME_VPC}, not this Environment network's VPC vpc-0e0e0e0e. Once you have made it reachable from this Environment, tick "I made it reachable from this Environment" on pg-1's page; Cloudgate cannot check it`,
      });
    });

    it('plans one in another VPC with the tick, saying Cloudgate cannot check it', async () => {
      await created({ madeReachable: true });
      await networkIn('vpc-0e0e0e0e');

      const { aws } = await lookupOf();

      expect(aws.status).toBe('read');
      expect(aws.status === 'read' && aws.summary).toContain(
        `pg-1: acme-prod is in VPC ${ACME_VPC}, not this Environment network's VPC vpc-0e0e0e0e; you ticked that you made it reachable from this Environment, which Cloudgate cannot check`,
      );
    });
  });

  it('applies a linked cloud web with a URL built from the typed login and the looked-up address, creating no instance', async () => {
    const postgresId = await created({ madeReachable: true });

    const saved = await save(STACK);
    expect(saved.status).toBe(201);
    const read = await readPlan();
    expect(
      read.steps.map((step) =>
        'configName' in step
          ? `${step.action}:${step.configName}`
          : step.action,
      ),
    ).toEqual(['network-create', 'change:pg-1', 'create:web']);
    const [networkStep, , webStep] = read.steps;
    if (
      networkStep.action !== 'network-create' ||
      networkStep.cloudRead.status !== 'read' ||
      webStep.action !== 'create' ||
      webStep.cloudRead?.status !== 'read'
    ) {
      throw new Error('the plan was not read');
    }
    ctx.cloud.outputsFor(networkStep.cloudRead.stateId, NETWORK_OUTPUTS);

    const res = await apply(read.planId);
    expect(res.status).toBe(200);
    const applied = await until(async () => {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, read.planId));
      return found?.results &&
        !found.results.some((result) => result.status === 'running')
        ? found
        : undefined;
    }, 'the Apply to end');
    const web = applied.results!.find((one) => one.configName === 'web');
    if (web?.deploy?.status !== 'queued') throw new Error('web queued nothing');
    expect((await settled(web.deploy.deploymentId)).status).toBe('done');

    // Nothing applied but the network's and web's: no instance was made.
    const appliedStates = ctx.cloud.calls.flatMap((call) =>
      call.method === 'apply' ? [call.stateId] : [],
    );
    expect(new Set(appliedStates)).toEqual(
      new Set([networkStep.cloudRead.stateId, webStep.cloudRead.stateId]),
    );

    const webStateId = webStep.cloudRead.stateId;
    const webApply = ctx.cloud.tofuInputs
      .filter((input) => input.stateId === webStateId)
      .at(-1)!;
    expect(webApply.variables[valueVariable('DATABASE_URL')]).toBe(
      `postgresql://shop_app:${encodeURIComponent(LOGIN_PASSWORD)}@${HOST}:5432/shop?sslmode=require`,
    );
    expect(webApply.variables[valueVariable('PGSSLROOTCERT')]).toBe(
      rdsCaBundle(REGION),
    );
    expect(webApply.definition).not.toContain(LOGIN_PASSWORD);

    // Delete is refused while web links to it, and nothing reached AWS.
    const callsBefore = ctx.cloud.calls.length;
    const refused = await request(http)
      .delete(`/postgres/${postgresId}`)
      .set('Cookie', cookie);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'SERVICE_IS_LINKED' });
    expect(ctx.cloud.calls.length).toBe(callsBefore);
    const [still] = await ctx.db
      .select({ id: postgres.postgresId })
      .from(postgres)
      .where(eq(postgres.postgresId, postgresId));
    expect(still).toBeDefined();
    expect(
      await ctx.db.select({ id: application.applicationId }).from(application),
    ).toHaveLength(1);
  });

  describe('Delete', () => {
    it("removes only Cloudgate's records, reaches no AWS write, and says the database was left", async () => {
      const postgresId = await created();
      await networkIn(ACME_VPC);
      await lookupOf();
      const callsBefore = ctx.cloud.calls.length;

      const res = await request(http)
        .delete(`/postgres/${postgresId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.text).not.toContain(LOGIN_PASSWORD);
      const { left } = res.body as {
        left: { identifier: string; message: string };
      };
      expect(left.identifier).toBe('acme-prod');
      expect(left.message).toBe(
        'acme-prod was left as it was; it is yours. Cloudgate removed only its own records of pg-1; if the Project config still lists pg-1, the next plan creates it as a new database.',
      );
      expect(res.body).not.toHaveProperty('databasePassword');
      expect(ctx.cloud.calls.slice(callsBefore)).toEqual([]);
      expect(writes()).toEqual([]);
      expect(await ctx.db.select().from(postgres)).toEqual([]);
      expect(await ctx.db.select().from(existingDatabase)).toEqual([]);
    });
  });

  describe('What Cloudgate never does to it', () => {
    it('refuses a Backup and a volume backup', async () => {
      const postgresId = await created();

      const backup = await request(http)
        .post('/backups')
        .set('Cookie', cookie)
        .send({
          schedule: '0 3 * * *',
          prefix: 'pg-1',
          database: 'shop',
          destinationId: 'any-destination',
          databaseType: 'postgres',
          serviceId: postgresId,
        });
      expect(backup.status).toBe(409);
      expect(backup.body).toMatchObject({
        code: 'EXISTING_DATABASE_NO_BACKUP',
      });
    });

    it.each(['start', 'stop', 'rebuild', 'deploy'])(
      'refuses %s with the sentence',
      async (action) => {
        const postgresId = await created();

        const res = await request(http)
          .post(`/postgres/${postgresId}/${action}`)
          .set('Cookie', cookie);

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          message: "Cloudgate uses this database but doesn't manage it.",
          code: 'EXISTING_DATABASE_NOT_MANAGED',
        });
      },
    );

    it('refuses its login through the ordinary settings write', async () => {
      const postgresId = await created();

      const res = await request(http)
        .patch(`/postgres/${postgresId}`)
        .set('Cookie', cookie)
        .send({ databaseName: 'other' });

      expect(res.status).toBe(400);
    });
  });
});
