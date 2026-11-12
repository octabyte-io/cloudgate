import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  cloudAccount,
  deployment,
  environment,
  plan as planTable,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { fakeBinShell } from '../utils/fake-bin-shell';
import { storedPlan } from '../utils/fake-cloud-port';
import { createTestApp, TestAppContext } from '../utils/test-app';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import type { TofuShow } from '../../src/cloud-accounts/cloud.port';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

const WEB = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
    env: [API_KEY, DEBUG]
`;

/** What `tofu output -json` answers after the network's apply. */
const OUTPUTS = {
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

/** A `docker` that pulls and pushes without a daemon (as `cloud-deploy.e2e-spec.ts`'). */
const FAKE_DOCKER = `#!/bin/bash
case "$1" in
  login) cat >/dev/null; echo "Login Succeeded" ;;
  pull) echo "Status: Downloaded newer image for $2" ;;
  push) echo "\${2##*:}: digest: sha256:0f1e size: 1570" ;;
  image) [ "$2" = inspect ] && echo amd64 ;;
esac
exit 0
`;

/** The value the Environment holds, which the Service's API_KEY refers to. */
const SECRET_VALUE = 'sk-live-0f1e2d3c4b5a-very-secret';

/**
 * The `image-only` stored plan (a new task definition revision, the service
 * update to it with a new `triggers` digest, and `API_KEY`'s parameter
 * changed), with the parameter's tier as the spec needs it.
 */
function imageOnlyPlan(tier: 'Standard' | 'Advanced'): TofuShow {
  const show = storedPlan('image-only') as TofuShowJson & TofuShow;
  for (const change of show.resource_changes ?? []) {
    if (change.type !== 'aws_ssm_parameter') continue;
    (change.change.after as Record<string, unknown>).tier = tier;
  }
  return show;
}

/**
 * Every variable of a cloud Service reaches its task as an SSM
 * `SecureString`. Its value is written to AWS by a deploy's Cloud run
 * alone, handed to `tofu` as a sensitive variable and never in the
 * definition, the log, a plan or a row; the plan names it and prices an
 * Advanced parameter; a value over 8 KB stops the deploy naming it; and a
 * changed value rolls the tasks through the digest in the ECS service's
 * `triggers`.
 *
 * Against the fake cloud port (`ctx.cloud`), replaying stored plans.
 */
describe('A cloud Service’s variables (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const shell = fakeBinShell('vars', { docker: FAKE_DOCKER });
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
    await ctx.resetDb();
    execMock.execAsync.mockClear();
    const res = await request(http).post('/api/auth/sign-up/email').send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;
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
  });

  async function poll<T>(
    read: () => Promise<T | undefined>,
    what: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 600; attempt++) {
      const found = await read();
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${what} never happened`);
  }

  const openPlan = () =>
    poll(async () => {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.status, 'open'));
      const reading = found?.steps.some(
        (step) =>
          (step.action === 'create' || step.action === 'network-create') &&
          step.cloudRead?.status === 'reading',
      );
      return found && !reading ? found : undefined;
    }, 'The plan read');

  const settledPlan = (planId: string) =>
    poll(async () => {
      const [row] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, planId));
      return row.results !== null &&
        !row.results.some((result) => result.status === 'running')
        ? row
        : undefined;
    }, 'The Apply');

  const settledDeployment = (deploymentId: string) =>
    poll(async () => {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      return row && ['done', 'error', 'cancelled'].includes(row.status)
        ? row
        : undefined;
    }, 'The Deployment');

  /** Plans the config, applies it, and waits for the web's first Deployment. */
  async function appliedWeb(): Promise<{
    plan: Plan;
    applicationId: string;
    run: Deployment;
  }> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: WEB });
    expect(saved.status).toBe(201);
    const read = await openPlan();
    const networkStep = read.steps[0];
    if (networkStep.action !== 'network-create') throw new Error('no network');
    if (networkStep.cloudRead.status !== 'read') throw new Error('not read');
    ctx.cloud.outputsFor(networkStep.cloudRead.stateId, OUTPUTS);

    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    const applied = await settledPlan(read.planId);
    const web = applied.results!.find((one) => one.configName === 'web')!;
    if (web.deploy?.status !== 'queued') throw new Error('not queued');
    const run = await settledDeployment(web.deploy.deploymentId);
    expect(run.status).toBe('done');
    return { plan: read, applicationId: web.serviceId!, run };
  }

  /** The Service's variables, as a console Save writes them. */
  async function setVariables(applicationId: string, env: string) {
    await ctx.db
      .update(application)
      .set({ env })
      .where(eq(application.applicationId, applicationId));
  }

  async function redeploy(applicationId: string): Promise<Deployment> {
    const queued = await ctx.app.get(DeploymentsService).redeploy(
      {
        user: { id: await ownerId() },
        session: { activeOrganizationId: organizationId },
      },
      applicationId,
    );
    return settledDeployment(queued.deploymentId);
  }

  const logOf = async (deploymentId: string) => {
    const res = await request(http)
      .get(`/deployments/${deploymentId}/logs`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.text;
  };

  /** Every place a value could have been left: log, rows and plans. */
  async function everywhereButAws(deploymentId: string): Promise<string> {
    return [
      await logOf(deploymentId),
      JSON.stringify(await ctx.db.select().from(deployment)),
      JSON.stringify(await ctx.db.select().from(planTable)),
      JSON.stringify(ctx.cloud.calls),
      ...ctx.cloud.tofuInputs.map((input) => input.definition),
    ].join('\n');
  }

  it('creates a web that lists variables, and its first deploy writes no parameter until a value is set', async () => {
    const { plan, applicationId } = await appliedWeb();
    expect(plan.steps[1]).toMatchObject({
      action: 'create',
      configName: 'web',
      cloudRead: { status: 'read' },
    });
    // No value yet: only the digest goes to tofu, and no parameter.
    const first = ctx.cloud.tofuInputs.filter((input) =>
      input.definition.includes('aws_ecs_service'),
    );
    expect(first.length).toBeGreaterThan(0);
    for (const input of first) {
      expect(Object.keys(input.variables)).toEqual(['variables_digest']);
      expect(input.definition).not.toContain('aws_ssm_parameter');
      expect(input.definition).toContain('"force_new_deployment": true');
      expect(input.definition).toContain(
        '"variables": "${var.variables_digest}"',
      );
    }
    const [row] = await ctx.db
      .select({ status: application.applicationStatus })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    expect(row.status).toBe('done');
  });

  it('deploys a variable as an SSM SecureString: the value reaches tofu only as a variable, and the plan and log name it only', async () => {
    const { applicationId } = await appliedWeb();
    await ctx.db
      .update(environment)
      .set({ env: `SHARED_KEY=${SECRET_VALUE}` })
      .where(eq(environment.environmentId, environmentId));
    await setVariables(applicationId, 'API_KEY=${{environment.SHARED_KEY}}');
    ctx.cloud.replayShowFor('web', imageOnlyPlan('Standard'));
    ctx.cloud.tofuInputs.length = 0;

    const run = await redeploy(applicationId);

    expect(run.status).toBe('done');
    // The value went to tofu as its sensitive variable, resolved from the
    // Environment, and nowhere in the definition.
    const applied = ctx.cloud.tofuInputs.at(-1)!;
    expect(applied.variables).toEqual({
      variable_value_API_KEY: SECRET_VALUE,
      variables_digest: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    expect(applied.definition).toContain(
      `"name": "/cloudgate/${environmentId}/${applicationId}/\${each.key}"`,
    );
    expect(applied.definition).toContain('"type": "SecureString"');
    expect(applied.definition).toContain(
      `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/cloudgate/${environmentId}/${applicationId}/API_KEY`,
    );
    // The calls name the variables, never their values.
    expect(
      ctx.cloud.calls.filter((call) => call.method === 'apply').at(-1),
    ).toMatchObject({
      variables: ['variable_value_API_KEY', 'variables_digest'],
    });

    const log = await logOf(run.deploymentId);
    expect(log).toContain('📋 [Cloud run] Variable `API_KEY`: value changed');
    expect(log).toContain(
      '📋 [Cloud run] variables changed, tasks will be replaced',
    );
    const anywhere = await everywhereButAws(run.deploymentId);
    expect(anywhere).not.toContain(SECRET_VALUE);
    expect(anywhere).not.toContain(applied.variables.variables_digest);
    // The stored plan's own values never surface either.
    expect(anywhere).not.toContain('rotated-secret-value-2');
    expect(anywhere).not.toContain('hunter2-very-secret');
  });

  it('rolls the tasks on a changed value: a new digest in the triggers, which the plan says', async () => {
    const { applicationId } = await appliedWeb();
    ctx.cloud.replayShowFor('web', imageOnlyPlan('Standard'));

    await setVariables(applicationId, 'API_KEY=first-value-1234\nDEBUG=');
    const first = await redeploy(applicationId);
    const firstDigest = ctx.cloud.tofuInputs.at(-1)!.variables.variables_digest;
    // The empty one is a plain environment entry, with no parameter.
    expect(ctx.cloud.tofuInputs.at(-1)!.variables).not.toHaveProperty(
      'variable_value_DEBUG',
    );
    expect(ctx.cloud.tofuInputs.at(-1)!.definition).toContain(
      '\\"environment\\":[{\\"name\\":\\"DEBUG\\",\\"value\\":\\"\\"}]',
    );

    await setVariables(applicationId, 'API_KEY=second-value-5678\nDEBUG=');
    const second = await redeploy(applicationId);
    const secondDigest =
      ctx.cloud.tofuInputs.at(-1)!.variables.variables_digest;

    expect([first.status, second.status]).toEqual(['done', 'done']);
    expect(secondDigest).not.toBe(firstDigest);
    expect(await logOf(second.deploymentId)).toContain(
      'variables changed, tasks will be replaced',
    );
  });

  it('shows a value of 4–8 KB as an Advanced parameter with its $0.05/month cost', async () => {
    const { applicationId } = await appliedWeb();
    const certificate = 'C'.repeat(5000);
    await setVariables(applicationId, `API_KEY=${certificate}`);
    ctx.cloud.replayShowFor('web', imageOnlyPlan('Advanced'));

    const run = await redeploy(applicationId);

    expect(run.status).toBe('done');
    expect(ctx.cloud.tofuInputs.at(-1)!.definition).toContain(
      '"API_KEY": "Advanced"',
    );
    const log = await logOf(run.deploymentId);
    expect(log).toContain(
      '📋 [Cloud run] Variable `API_KEY`: value changed (Advanced parameter, $0.05/month)',
    );
    expect(await everywhereButAws(run.deploymentId)).not.toContain(
      'CCCCCCCCCCCC',
    );
  });

  it('refuses a value over 8 KB, naming the variable, before anything is applied', async () => {
    const { applicationId } = await appliedWeb();
    await setVariables(applicationId, `API_KEY=${'C'.repeat(8193)}`);
    ctx.cloud.calls.length = 0;

    const run = await redeploy(applicationId);

    expect(run.status).toBe('error');
    expect(run.description).toBe(
      "web's variable API_KEY is 8193 bytes, and SSM holds at most 8192 (8 KB). Shorten it, or keep it elsewhere and pass its location",
    );
    expect(
      ctx.cloud.calls.filter((call) =>
        ['plan', 'apply', 'ecrAuthorizationToken'].includes(call.method),
      ),
    ).toEqual([]);
    expect(await everywhereButAws(run.deploymentId)).not.toContain(
      'CCCCCCCCCCCC',
    );
  });

  it('applies a parameter change only for a variable this deploy has: any other is not image-only', async () => {
    const { applicationId } = await appliedWeb();
    // The plan changes API_KEY's parameter, which this Service does not have.
    await setVariables(applicationId, 'OTHER=some-value-1234');
    ctx.cloud.replayShowFor('web', imageOnlyPlan('Standard'));

    const run = await redeploy(applicationId);

    expect(run.status).toBe('error');
    expect(run.description).toBe(
      'AWS differs from what Cloudgate made: review the plan',
    );
    expect(await logOf(run.deploymentId)).toMatch(
      /⛔ \[Cloud run\] AWS differs from what Cloudgate made, so nothing was applied: .*aws_ssm_parameter\.variable\["API_KEY"\]/,
    );
  });

  async function ownerId(): Promise<string> {
    const res = await request(http)
      .get('/api/auth/get-session')
      .set('Cookie', cookie);
    return (res.body as { user: { id: string } }).user.id;
  }
});
