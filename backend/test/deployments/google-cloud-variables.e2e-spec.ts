import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { serviceName } from '../../src/cloud-accounts/gcp/definitions/names';
import {
  application,
  cloudAccount,
  deployment,
  environment,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { GoogleServiceDeploys } from '../../src/project-config/applier/google-service-deploys.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

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
    env: [API_KEY, SESSION_SECRET]
`;

/** A `web` linking a `postgres` the same plan creates (ADR-0031). */
const LINKED = `version: 1
services:
  pg-1:
    kind: postgres
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

/** A `docker` that pulls, logs in and pushes without a daemon. */
const FAKE_DOCKER = `#!/bin/bash
case "$1" in
  login) cat >/dev/null; echo "Login Succeeded" ;;
  pull) echo "Status: Downloaded newer image for \${@: -1}" ;;
  push) echo "\${2##*:}: digest: sha256:0f1e size: 1570" ;;
  image) [ "$2" = inspect ] && echo amd64 ;;
esac
exit 0
`;

/** The values the Service is given: typed, and from its Environment. */
const API_KEY = 'sk-live-0f1e2d3c4b5a-api-key';
const SHARED_SECRET = 'session-0a9b8c7d6e5f-shared';
const NEW_API_KEY = 'sk-live-99887766-rotated';

/** What the stored Google plans carry in clear, as `tofu show -json` prints them. */
const STORED_VALUES = [
  'hunter2-very-secret',
  'another-secret-value',
  'rotated-very-secret-2',
];

const DIFFERS =
  'Google Cloud differs from what Cloudgate made: review the plan';

/**
 * "Variables" (S1; T15): a Cloud Run Service's variables
 * reach it as Secret Manager secrets, one per variable with a value, each
 * read by version number from the revision and by the Service's own
 * service account alone. A value reaches `tofu` only as a `TF_VAR_`, never
 * in the definition, a plan line, a log or a row. A deploy that adds,
 * changes or removes one is not image-only (S19), so it stops with its plan
 * opened, and the Deployment its Apply queues applies it: a changed value is
 * a new version and a new revision, a removed variable's secret goes.
 *
 * Against the Google fake (`ctx.google`), whose stand-in `tofu` replays
 * the stored Google plans.
 */
describe('A Cloud Run Service’s variables (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gvars-'));
  const bin = nodePath.join(root, 'bin');
  const saved = process.env.CLOUDGATE_DIRECTORY;

  const execMock = withArgvExec({
    execAsync: jest.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) =>
        new Promise((resolve, reject) => {
          exec(
            command,
            {
              shell: '/bin/bash',
              env: {
                ...process.env,
                ...options?.env,
                PATH: `${bin}:${process.env.PATH}`,
              },
            },
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
    fs.mkdirSync(bin);
    fs.writeFileSync(nodePath.join(bin, 'docker'), FAKE_DOCKER, {
      mode: 0o755,
    });
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    http = ctx.app.getHttpServer() as App;
    ctx.app.get(GoogleServiceDeploys).pollIntervalMs = 10;
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (saved === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockClear();
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
    organizationId = (orgs.body as { id: string }[])[0].id;
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

    ctx.google.replayPlanFor('network', 'network-create');
    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.replayOutputsFor('network', 'network-create');
    ctx.google.replayOutputsFor('web', 'web-create');
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

  /** Applies `planId` and waits for the web's Deployment it queued. */
  async function applied(planId: string): Promise<Deployment> {
    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });
    expect([res.status, res.body]).toEqual([200, expect.anything()]);
    const settled = await settledPlan(planId);
    const web = settled.results!.find((one) => one.configName === 'web')!;
    if (web.deploy?.status !== 'queued') {
      throw new Error(`not queued: ${JSON.stringify(web)}`);
    }
    return settledDeployment(web.deploy.deploymentId);
  }

  /** Plans the config, applies it, and waits for the web's first Deployment. */
  async function appliedWeb(): Promise<string> {
    const res = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: WEB });
    expect(res.status).toBe(201);
    const read = await openPlan();
    const run = await applied(read.planId);
    expect(run.status).toBe('done');
    return run.applicationId!;
  }

  /** The Service's variables, as a console Save writes them. */
  async function setVariables(applicationId: string, env: string) {
    await ctx.db
      .update(application)
      .set({ env })
      .where(eq(application.applicationId, applicationId));
  }

  async function redeploy(applicationId: string): Promise<Deployment> {
    const res = await request(http)
      .post(`/applications/${applicationId}/redeploy`)
      .set('Cookie', cookie)
      .send({});
    expect([200, 201]).toContain(res.status);
    return settledDeployment(
      (res.body as { deploymentId: string }).deploymentId,
    );
  }

  const logOf = async (deploymentId: string) => {
    const res = await request(http)
      .get(`/deployments/${deploymentId}/logs`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.text;
  };

  /**
   * A redeploy that meets a variable change: it stops before any change,
   * its plan opened with the Service's lines, which the Apply then applies.
   */
  async function deployedThroughItsPlan(applicationId: string): Promise<{
    stopped: Deployment;
    plan: Plan;
    summary: string[];
    run: Deployment;
  }> {
    const stopped = await redeploy(applicationId);
    expect([stopped.status, stopped.description]).toEqual(['error', DIFFERS]);
    expect(await logOf(stopped.deploymentId)).not.toContain('Apply complete!');
    const plan = await openPlan();
    const step = plan.steps.find(
      (one) => one.action === 'change' && one.serviceId === applicationId,
    );
    if (step?.action !== 'change' || step.cloudRead?.status !== 'read') {
      throw new Error('the stopped Service has no step with its Google lines');
    }
    const run = await applied(plan.planId);
    return { stopped, plan, summary: step.cloudRead.summary, run };
  }

  /** The Service's own `tofu` applies, newest last. */
  const appliesOf = (applicationId: string) =>
    ctx.google.tofuInputs.filter(
      (input) =>
        input.method === 'apply' &&
        input.definition.includes(`"${serviceName(applicationId)}"`),
    );

  /** Every place a value could have been left: logs, rows, plans and calls. */
  async function everywhereButGoogle(): Promise<string> {
    const runs = await ctx.db.select().from(deployment);
    return [
      ...(await Promise.all(runs.map((one) => logOf(one.deploymentId)))),
      JSON.stringify(runs),
      JSON.stringify(await ctx.db.select().from(planTable)),
      JSON.stringify(ctx.google.calls),
      ...ctx.google.tofuInputs.map((input) => input.definition),
    ].join('\n');
  }

  it('plans two variables as two secrets, masked, and the deploy its Apply queues applies them as TF_VARs only', async () => {
    const applicationId = await appliedWeb();
    await ctx.db
      .update(environment)
      .set({ env: `SHARED=${SHARED_SECRET}` })
      .where(eq(environment.environmentId, environmentId));
    await setVariables(
      applicationId,
      `API_KEY=${API_KEY}\nSESSION_SECRET=\${{environment.SHARED}}`,
    );
    // The stored plan is the live walk's first variable, so its lines
    // name that one; the definition and TF_VARs below are this test's two.
    ctx.google.replayPlanFor('web', 'variables-add');

    const { summary, run } = await deployedThroughItsPlan(applicationId);

    expect(summary).toEqual([
      expect.stringMatching(
        /^Cloud Run service `[^`]+`: change, .*variables changed, a new revision rolls out$/,
      ) as string,
      'Variable `WALK_GREETING`: added',
    ]);
    expect(run.status).toBe('done');
    const last = appliesOf(applicationId).at(-1)!;
    // Each value went to tofu as its sensitive variable, resolved.
    expect(last.variables).toEqual({
      variable_value_API_KEY: API_KEY,
      variable_value_SESSION_SECRET: SHARED_SECRET,
    });
    const definition = JSON.parse(last.definition) as {
      variable: Record<string, unknown>;
      resource: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(definition.variable).toEqual({
      variable_value_API_KEY: {
        type: 'string',
        sensitive: true,
        nullable: false,
      },
      variable_value_SESSION_SECRET: {
        type: 'string',
        sensitive: true,
        nullable: false,
      },
    });
    const name = serviceName(applicationId);
    expect(
      definition.resource.google_secret_manager_secret.variable.for_each,
    ).toEqual({
      API_KEY: `${name}-API_KEY`,
      SESSION_SECRET: `${name}-SESSION_SECRET`,
    });
    // Readable by the Service's own service account, on each secret only.
    expect(
      definition.resource.google_secret_manager_secret_iam_member.variable,
    ).toMatchObject({
      role: 'roles/secretmanager.secretAccessor',
      member: '${google_service_account.service.member}',
    });
    expect(last.definition).toContain(
      '"version": "${google_secret_manager_secret_version.variable[\\"API_KEY\\"].version}"',
    );
    // The calls name the variables, never their values.
    expect(
      ctx.google.calls.filter((call) => call.method === 'apply').at(-1),
    ).toMatchObject({
      variables: ['variable_value_API_KEY', 'variable_value_SESSION_SECRET'],
    });

    const anywhere = await everywhereButGoogle();
    for (const value of [API_KEY, SHARED_SECRET, ...STORED_VALUES]) {
      expect([value, anywhere.includes(value)]).toEqual([value, false]);
    }
  });

  it('rolls a new revision on a changed value, and removes the secret of a removed variable', async () => {
    const applicationId = await appliedWeb();
    // Both variables made: an image-only plan, applied on its own.
    await setVariables(
      applicationId,
      `API_KEY=${API_KEY}\nSESSION_SECRET=${SHARED_SECRET}`,
    );
    ctx.google.replayPlanFor('web', 'image-only');
    expect((await redeploy(applicationId)).status).toBe('done');

    // A changed value: a new version, which the revision refers to.
    await setVariables(
      applicationId,
      `API_KEY=${NEW_API_KEY}\nSESSION_SECRET=${SHARED_SECRET}`,
    );
    ctx.google.replayPlanFor('web', 'variable-change');
    const changed = await deployedThroughItsPlan(applicationId);
    expect(changed.summary).toEqual([
      expect.stringMatching(
        /variables changed, a new revision rolls out$/,
      ) as string,
      'Variable `API_KEY`: value changed',
    ]);
    expect(changed.run.status).toBe('done');
    expect(appliesOf(applicationId).at(-1)!.variables).toEqual({
      variable_value_API_KEY: NEW_API_KEY,
      variable_value_SESSION_SECRET: SHARED_SECRET,
    });
    expect(await logOf(changed.run.deploymentId)).toContain(
      '📋 [Cloud run] Variable `API_KEY`: value changed',
    );

    // A removed variable: its secret, version and grant go.
    await setVariables(applicationId, `API_KEY=${NEW_API_KEY}`);
    ctx.google.replayPlanFor('web', 'variable-remove');
    const removed = await deployedThroughItsPlan(applicationId);
    expect(removed.summary).toEqual([
      expect.stringMatching(
        /variables changed, a new revision rolls out$/,
      ) as string,
      'Variable `SESSION_SECRET`: removed',
    ]);
    expect(removed.run.status).toBe('done');
    const last = appliesOf(applicationId).at(-1)!;
    expect(last.variables).toEqual({ variable_value_API_KEY: NEW_API_KEY });
    expect(last.definition).not.toContain('SESSION_SECRET');

    const anywhere = await everywhereButGoogle();
    for (const value of [
      API_KEY,
      NEW_API_KEY,
      SHARED_SECRET,
      ...STORED_VALUES,
    ]) {
      expect([value, anywhere.includes(value)]).toEqual([value, false]);
    }
  });

  it("runs the deploy queued by an Apply that drops a postgres the web links under that Apply's approval, not on its results", async () => {
    ctx.google.replayPlanFor('network', 'network-create-private-link');
    ctx.google.replayPlanFor('postgres', 'postgres-create');
    ctx.google.replayOutputsFor('postgres', 'postgres-create');
    const made = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: LINKED });
    expect(made.status).toBe(201);
    const first = await applied((await openPlan()).planId);
    expect(first.status).toBe('done');
    const applicationId = first.applicationId!;

    // pg-1 dropped: its link's secrets, versions and grants go from web.
    ctx.google.replayPlanFor('web', 'variable-remove');
    ctx.google.replayPlanFor('destroy', 'postgres-destroy');
    const dropped = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: WEB_ONLY });
    expect(dropped.status).toBe(201);
    const plan = await poll(async () => {
      const found = await openPlan();
      return found.steps.some(
        (step) => 'cloudRead' in step && step.cloudRead?.status === 'reading',
      )
        ? undefined
        : found;
    }, "web's change read");
    expect(
      plan.steps.map((step) =>
        'configName' in step
          ? `${step.action}:${step.configName}`
          : step.action,
      ),
    ).toEqual(['change:web', 'destroy:pg-1']);
    // The Apply's results are not read back: the race with pg-1's destroy,
    // which writes them only after its own cloud work, is shut on purpose.
    jest
      .spyOn(CloudServiceDeploys.prototype, 'approvedByApply')
      .mockResolvedValue(null);

    try {
      const res = await request(http)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: plan.planId, confirmDestroy: ['pg-1'] });
      expect([res.status, res.body]).toEqual([200, expect.anything()]);
      const settled = await settledPlan(plan.planId);
      const web = settled.results!.find((one) => one.configName === 'web')!;
      if (web.deploy?.status !== 'queued') {
        throw new Error(`not queued: ${JSON.stringify(web)}`);
      }
      expect(settled.results).toContainEqual(
        expect.objectContaining({
          configName: 'pg-1',
          action: 'destroy',
          status: 'applied',
        }),
      );
      const run = await settledDeployment(web.deploy.deploymentId);

      expect([run.status, run.description]).toEqual([
        'done',
        expect.not.stringContaining('review the plan'),
      ]);
      expect(await logOf(run.deploymentId)).not.toContain(DIFFERS);
      const last = appliesOf(applicationId).at(-1)!;
      expect(last.variables).toEqual({});
      // Nothing left for the operator to approve again.
      expect(
        await ctx.db
          .select()
          .from(planTable)
          .where(eq(planTable.status, 'open')),
      ).toEqual([]);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it("plans a create's wired variables as secrets, at stand-in values while their source is not made", async () => {
    const res = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: LINKED });
    expect(res.status).toBe(201);
    const plan = await openPlan();
    const web = plan.steps.find(
      (step) => step.action === 'create' && step.configName === 'web',
    );
    expect(web?.action === 'create' && web.cloudRead?.status).toBe('read');

    const read = ctx.google.tofuInputs.find(
      (input) =>
        input.method === 'plan' &&
        input.definition.includes('google_cloud_run_v2_service'),
    );
    expect(Object.keys(read!.variables)).toEqual([
      'variable_value_DATABASE_URL',
      'variable_value_PGSSLROOTCERT',
    ]);
    // Cloud SQL's CA is the instance's own, so a not-made one's
    // stand-in is the marker, never RDS's bundle (empty for a Google region).
    expect(read!.variables.variable_value_PGSSLROOTCERT).toContain('pg-1-ca');
    expect(read!.definition).toContain('"DATABASE_URL"');
    expect(read!.definition).toContain('"PGSSLROOTCERT"');
    expect(read!.definition).not.toContain(
      read!.variables.variable_value_DATABASE_URL,
    );
  });
});
