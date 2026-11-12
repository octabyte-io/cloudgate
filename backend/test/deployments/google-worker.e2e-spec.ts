import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { serviceName } from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import {
  application,
  cloudAccount,
  deployment,
  domain,
  plan as planTable,
  previewDeployment,
  webServerSettings,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
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

/** A Worker, the Environment's first and only cloud Service. */
const WORKER = `version: 1
services:
  jobs:
    kind: worker
    command: node worker.js
    source: { image: acme/jobs }
`;

/** A `docker` that pulls, pushes and logs in without a daemon. */
const FAKE_DOCKER = `#!/bin/bash
case "$1" in
  login) cat > /dev/null; echo "Login Succeeded" ;;
  pull) echo "Status: Downloaded newer image for \${@: -1}" ;;
  push) echo "\${2##*:}: digest: sha256:0f1e size: 1570" ;;
  image) [ "$2" = inspect ] && echo amd64 ;;
esac
exit 0
`;

/**
 * A Worker on Google Cloud (spec "Worker on Google Cloud"): a
 * `kind: worker` entry plans and applies into a Google Cloud Environment as
 * a Cloud Run worker pool. Its plan makes the whole Environment network and
 * shows the repository, service account and worker pool with no
 * load-balancer piece; its deploy builds, pushes, applies, sets the
 * instance count to `replicas` and waits on the worker pool's latest
 * revision, and a revision that fails to start fails the Deployment with
 * Google's condition message.
 *
 * Against the Google fake (`ctx.google`), whose stand-in `tofu` replays the
 * stored `worker-create` plan and apply, and a real shell with a fake
 * `docker`.
 */
describe('A Worker on a Cloud Run worker pool (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gworker-'));
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
    // The Google account's token issuer is the install's own address.
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
    expect([env.status, env.body]).toEqual([201, expect.anything()]);
    environmentId = (env.body as { environmentId: string }).environmentId;

    ctx.google.replayPlanFor('network', 'network-create');
    ctx.google.replayPlanFor('worker', 'worker-create');
    ctx.google.replayOutputsFor('network', 'network-create');
    ctx.google.replayOutputsFor('worker', 'worker-create');
  });

  const savePlan = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  async function openPlan(): Promise<Plan> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.status, 'open'));
      if (
        found &&
        !found.steps.some(
          (step) =>
            (step.action === 'create' || step.action === 'network-create') &&
            step.cloudRead?.status === 'reading',
        )
      ) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading Google Cloud');
  }

  async function settledPlan(planId: string): Promise<Plan> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const [row] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, planId));
      if (
        row.results !== null &&
        !row.results.some((result) => result.status === 'running')
      ) {
        return row;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The Apply never ended');
  }

  async function settledDeployment(deploymentId: string): Promise<Deployment> {
    for (let attempt = 0; attempt < 600; attempt++) {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      if (row && ['done', 'error', 'cancelled'].includes(row.status)) {
        return row;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The Deployment never ended');
  }

  /** Plans the Worker, applies it, and waits for its Deployment. */
  async function appliedWorker(): Promise<{
    plan: Plan;
    applicationId: string;
    run: Deployment;
  }> {
    expect((await savePlan(WORKER)).status).toBe(201);
    const read = await openPlan();
    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    const applied = await settledPlan(read.planId);
    const jobs = applied.results!.find((one) => one.configName === 'jobs')!;
    expect(jobs).toMatchObject({ status: 'applied', domain: null });
    if (jobs.deploy?.status !== 'queued') throw new Error('not queued');
    const run = await settledDeployment(jobs.deploy.deploymentId);
    return { plan: read, applicationId: jobs.serviceId!, run };
  }

  const logOf = async (deploymentId: string) => {
    const res = await request(http)
      .get(`/deployments/${deploymentId}/logs`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.text;
  };

  it('plans the whole Environment network first, and the Worker as its repository, service account and worker pool, with no load-balancer piece', async () => {
    expect((await savePlan(WORKER)).status).toBe(201);
    const read = await openPlan();

    expect(read.steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);
    const [network, jobs] = read.steps;
    if (
      network.action !== 'network-create' ||
      network.cloudRead?.status !== 'read'
    ) {
      throw new Error('the network was not read');
    }
    expect(network.cloudRead.summary).toContain(
      'Environment network: create, $0/month for the network, about $18/month while idle for the load balancer',
    );
    if (jobs.action !== 'create' || jobs.cloudRead?.status !== 'read') {
      throw new Error('the worker was not read');
    }
    expect(jobs.kind).toBe('worker');
    // With no size, a worker pool's floor; a size under it rounds up with a
    // note (`plan-environment-cloud-run.spec.ts`).
    expect(jobs.cloud?.size.pair).toEqual({
      runsOn: 'Cloud Run',
      wording: '1 CPU / 512 MB',
      notes: [
        'a worker pool: CPU always on, billed while its instances run',
        'its replicas are its instance count, with no automatic scaling',
      ],
    });
    expect(jobs.cloudRead.raw.map((line) => line.address)).toEqual([
      'google_artifact_registry_repository.service',
      'google_cloud_run_v2_worker_pool.service',
      'google_service_account.service',
    ]);
    expect(jobs.cloudRead.summary).toContain(
      'Cloud Run worker pool `jobs`: create, 1 CPU / 512 MB, CPU always on, 1 instance, no ingress',
    );
    expect(JSON.stringify(jobs)).not.toMatch(
      /backend_service|network_endpoint_group|No Domain yet/,
    );
    // The search by name covers worker pools as well as services.
    expect(
      ctx.google.calls.some(
        (call) =>
          call.method === 'findByName' &&
          call.resourceType === 'google_cloud_run_v2_worker_pool',
      ),
    ).toBe(true);
    // The definition it planned was a worker pool's, read as one.
    expect(
      ctx.google.calls.some(
        (call) => call.method === 'plan' && call.kind === 'worker',
      ),
    ).toBe(true);
  });

  it('applies the worker pool, sets its instance count to its replicas and waits on its latest revision, never on a Cloud Run service', async () => {
    ctx.google.rolloutTakes(2);
    const { applicationId, run } = await appliedWorker();
    const name = serviceName(applicationId);

    expect(run).toMatchObject({ applicationId, status: 'done' });
    const [created] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));
    expect(created).toMatchObject({
      configKind: 'worker',
      cloudAccountId,
      region: REGION,
      replicas: 1,
      minCopies: null,
      maxCopies: null,
      cloudRunAddress: null,
    });

    const pool = { projectId: PROJECT, region: REGION, name };
    expect(ctx.google.calls).toContainEqual({
      method: 'setWorkerPoolInstances',
      impersonated: true,
      ...pool,
      instances: 1,
    });
    const polls = ctx.google.calls.filter(
      (call) => call.method === 'cloudRunWorkerPool',
    );
    // Past the two polls still rolling out.
    expect(polls).toHaveLength(3);
    expect(
      ctx.google.calls.filter((call) =>
        ['cloudRunService', 'setCloudRunScaling'].includes(call.method),
      ),
    ).toEqual([]);
    expect(
      ctx.google.calls.some(
        (call) => call.method === 'apply' && call.kind === 'worker',
      ),
    ).toBe(true);

    const log = await logOf(run.deploymentId);
    expect(log).toContain(
      "⏳ [Cloud run] Waiting for Cloud Run to call the worker pool's new revision ready and running 1 instance",
    );
    expect(log).toContain(
      '✅ [Cloud run] jobs runs the image of this Deployment',
    );
    expect(log).not.toContain('answers at https://');
  });

  it('refuses a Domain and a preview on the Worker on Google Cloud, as on a Server and AWS', async () => {
    const { applicationId } = await appliedWorker();
    const send = (
      method: 'post' | 'patch',
      path: string,
      body: Record<string, unknown>,
    ) => request(http)[method](path).set('Cookie', cookie).send(body);
    const noPreview = {
      message:
        'A worker has no previews: a preview is reached at its own Domain, and a worker serves no HTTP. To serve HTTP, change its kind to web in the Project config',
      code: 'KIND_TAKES_NO_PREVIEWS',
    };

    const added = await send('post', '/domains', {
      host: 'jobs.example.com',
      applicationId,
      domainType: 'application',
      port: 3000,
    });
    expect([added.status, added.body]).toEqual([
      409,
      expect.objectContaining({
        message:
          'A worker takes no Domain: it serves no HTTP. To serve HTTP, change its kind to web in the Project config',
        code: 'KIND_TAKES_NO_DOMAIN',
      }),
    ]);
    for (const field of [
      'isPreviewDeploymentsActive',
      'requestedPreviewsAllowed',
    ]) {
      const on = await send('patch', `/applications/${applicationId}`, {
        [field]: true,
      });
      expect([on.status, on.body]).toEqual([
        409,
        expect.objectContaining(noPreview),
      ]);
    }
    const requested = await send(
      'post',
      `/applications/${applicationId}/preview-deployments`,
      { branch: 'feature/login' },
    );
    expect([requested.status, requested.body]).toEqual([
      409,
      expect.objectContaining(noPreview),
    ]);
    expect(await ctx.db.select().from(domain)).toEqual([]);
    expect(await ctx.db.select().from(previewDeployment)).toEqual([]);
  });

  it("fails the Deployment with Google's condition message when the revision fails to start, quoting the worker pool's last lines", async () => {
    const reason =
      'The user-provided container failed to start: the command exited with code 1.';
    ctx.google.failRevision(reason, ['Error: QUEUE_URL is not set']);

    const { applicationId, run } = await appliedWorker();
    const name = serviceName(applicationId);

    expect(run.status).toBe('error');
    expect(run.description).toBe(
      `The new revision failed to become ready: ${reason}`,
    );
    const log = await logOf(run.deploymentId);
    expect(log).toContain(
      `❌ [Cloud run] Revision ${name}-00002-new is not ready: ${reason}`,
    );
    expect(log).toContain('  Error: QUEUE_URL is not set');
    expect(ctx.google.calls).toContainEqual(
      expect.objectContaining({
        method: 'listLogEntries',
        filter: `resource.type="cloud_run_worker_pool" AND resource.labels.worker_pool_name="${name}" AND resource.labels.revision_name="${name}-00002-new" AND NOT log_name:"run.googleapis.com%2Frequests"`,
      }),
    );
  });
});
