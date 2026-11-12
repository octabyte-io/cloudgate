import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { serviceName } from '../../src/cloud-accounts/gcp/definitions/names';
import {
  application,
  cloudAccount,
  deployment,
  plan as planTable,
  registry,
  webServerSettings,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { GoogleServiceDeploys } from '../../src/project-config/applier/google-service-deploys.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { storedGooglePlan } from '../utils/fake-google-cloud-port';
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

/** Slice 3's sample `web` config, unchanged. */
const WEB = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
`;

/** The same `web`, built from git. */
const GIT_WEB = `version: 1
services:
  web:
    kind: web
    size: small
    source: { git: https://example.com/shop.git }
`;

/** The impersonated deploy service account's access token the fake hands out. */
const ACCESS_TOKEN = 'fake-impersonated-token';

/** The `run.app` host the stored web apply answers. */
const RUN_APP = 'cloudgate-plb3nv2t74e6-6qzq3k7vqa-ew.a.run.app';

/**
 * A `docker` that pulls, pushes and logs in without a daemon: it records
 * each call's words (never stdin), and that a login read its password from
 * stdin against a throwaway `DOCKER_CONFIG`.
 */
const FAKE_DOCKER = `#!/bin/bash
echo "$*" >> "$FAKE_DOCKER_RECORD"
case "$1" in
  login)
    password="$(cat)"
    if [ "$password" = "${ACCESS_TOKEN}" ] && [ -n "$DOCKER_CONFIG" ]; then
      echo "login read the access token from stdin, DOCKER_CONFIG set" >> "$FAKE_DOCKER_RECORD"
    fi
    echo "Login Succeeded" ;;
  pull) echo "Status: Downloaded newer image for \${@: -1}" ;;
  push) echo "The push refers to repository [\${2%:*}]"; echo "\${2##*:}: digest: sha256:0f1e size: 1570" ;;
  image) [ "$2" = inspect ] && echo "\${FAKE_DOCKER_ARCH:-amd64} \${FAKE_DOCKER_HEALTHCHECK:-null}" ;;
esac
exit 0
`;

/** A `uname` that says the host is ARM. */
const ARM_UNAME = `#!/bin/sh
echo aarch64
`;

/**
 * "A `web` deploy" (T14), the tracer bullet: slice 3's
 * sample `web`, applied to a Google Cloud Environment, ends running on
 * Cloud Run. Apply makes the Environment network, creates the Service in
 * its Google place with its copy range, and queues one ordinary
 * Deployment, which pulls on the platform host as `linux/amd64`, then runs
 * a Cloud run: the Artifact Registry repository first, a push as
 * `oauth2accesstoken` with a fresh access token, Google read again, the
 * apply, the wait for the new revision, and the clean-up of every other
 * image version.
 *
 * Against the Google fake (`ctx.google`), whose stand-in `tofu` replays the
 * stored Google plans and applies, and a real shell whose `docker` is the
 * fake above, so the Deployment log is the real file.
 */
describe('Deploying a web to Cloud Run (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gdeploy-'));
  const bin = nodePath.join(root, 'bin');
  const record = nodePath.join(root, 'docker-calls');
  const saved = {
    root: process.env.CLOUDGATE_DIRECTORY,
    record: process.env.FAKE_DOCKER_RECORD,
  };

  /** Every shell program run on the platform host, through a real bash. */
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
    process.env.FAKE_DOCKER_RECORD = record;
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
    for (const [name, value] of [
      ['CLOUDGATE_DIRECTORY', saved.root],
      ['FAKE_DOCKER_RECORD', saved.record],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete process.env.FAKE_DOCKER_ARCH;
    delete process.env.FAKE_DOCKER_HEALTHCHECK;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    fs.rmSync(record, { force: true });
    fs.rmSync(nodePath.join(bin, 'uname'), { force: true });
    delete process.env.FAKE_DOCKER_ARCH;
    delete process.env.FAKE_DOCKER_HEALTHCHECK;
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
    expect([env.status, env.body]).toEqual([201, expect.anything()]);
    environmentId = (env.body as { environmentId: string }).environmentId;

    ctx.google.replayPlanFor('network', 'network-create');
    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.replayOutputsFor('network', 'network-create');
    ctx.google.replayOutputsFor('web', 'web-create');
  });

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

  /** Plans the config, applies it, and waits for the web's Deployment. */
  async function appliedWeb(text = WEB): Promise<{
    plan: Plan;
    applicationId: string;
    run: Deployment;
  }> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });
    expect(saved.status).toBe(201);
    const read = await openPlan();
    expect(read.steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);

    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    const applied = await settledPlan(read.planId);
    const web = applied.results!.find((one) => one.configName === 'web')!;
    expect(web).toMatchObject({ status: 'applied', domain: null });
    if (web.deploy?.status !== 'queued') throw new Error('not queued');
    const run = await settledDeployment(web.deploy.deploymentId);
    return { plan: read, applicationId: web.serviceId!, run };
  }

  const logOf = async (deploymentId: string) => {
    const res = await request(http)
      .get(`/deployments/${deploymentId}/logs`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.text;
  };

  const dockerCalls = () =>
    fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : '';

  /** Every shell program the platform host ran, as its words. */
  const programs = () =>
    execMock.execAsync.mock.calls.map((call: unknown[]) => String(call[0]));

  /** The `tofu` runs of a state, as method and targets. */
  const runsOf = (stateId: string) =>
    ctx.google.calls.flatMap((call) =>
      (call.method === 'plan' || call.method === 'apply') &&
      call.stateId === stateId
        ? [[call.method, call.targets]]
        : [],
    );

  it('pulls as amd64, makes the repository, pushes with a fresh token, applies, waits for the revision and keeps only the live image, all in one Deployment', async () => {
    // The Service's id is minted by its plan: every repository is held alike.
    ctx.google.rolloutTakes(2);
    const { plan, applicationId, run } = await appliedWeb();
    const webStep = plan.steps[1];
    if (webStep.action !== 'create' || webStep.cloudRead?.status !== 'read') {
      throw new Error('the web was not read');
    }
    const name = serviceName(applicationId);

    // The Service: its Google place, its copy range, its run.app address.
    const [created] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));
    expect(created).toMatchObject({
      applicationId: webStep.cloudRead.serviceId,
      cloudAccountId,
      region: REGION,
      serverId: null,
      applicationStatus: 'done',
      minCopies: 0,
      maxCopies: 10,
      cloudRunAddress: RUN_APP,
    });
    expect(run).toMatchObject({
      applicationId,
      status: 'done',
      cloudRun: { kind: 'deploy', stateKey: `application:${applicationId}` },
    });

    // The log reads as on AWS, in Google's words.
    const log = await logOf(run.deploymentId);
    const at = (text: string) => {
      const index = log.indexOf(text);
      expect([text, index >= 0]).toEqual([text, true]);
      return index;
    };
    const order = [
      at(
        `🔧 [Build] Building on Cloudgate's own host; the service runs in Cloud account Production Google (${REGION}).`,
      ),
      at('Status: Downloaded newer image for nginx'),
      at(
        "📦 [Push] The image goes to the Service's own repository in its Cloud account, in its Cloud run, next.",
      ),
      at('☁️ [Cloud run] Built.'),
      at('☁️ [Cloud run] Deploying web to Cloud account Production Google'),
      at('Reading Google Cloud again before anything changes'),
      at("📦 [Push] Making the Service's Artifact Registry repository first"),
      at('📦 [Push] Uploading image to'),
      at('✅ Image Pushed'),
      at('Reading Google Cloud again before applying'),
      log.lastIndexOf('Apply complete!'),
      at(`🌐 [Cloud run] web answers at https://${RUN_APP}`),
      at('⏳ [Cloud run] Waiting for Cloud Run'),
      at('🧹 [Push] Removed 0 older images from Artifact Registry'),
      at('✅ [Cloud run] web runs the image of this Deployment'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(log).not.toMatch(/\bECR\b/);

    // Pulled for Cloud Run's CPU, on any host.
    expect(dockerCalls()).toContain('pull --platform linux/amd64 nginx');

    // The repository first (targeted), then the push, then the whole state.
    expect(runsOf(webStep.cloudRead.stateId)).toEqual([
      ['plan', undefined], // the plan read
      ['plan', undefined], // the Apply's read again with the network's names
      ['plan', undefined], // the run's read before anything changes
      ['apply', ['google_artifact_registry_repository.service']],
      ['apply', undefined],
    ]);

    // One login as oauth2accesstoken, its token on stdin; one push.
    const remote = `${REGION}-docker.pkg.dev/${PROJECT}/${name}/service:${run.deploymentId}`;
    expect(dockerCalls()).toContain(
      `login ${REGION}-docker.pkg.dev -u oauth2accesstoken --password-stdin`,
    );
    expect(dockerCalls()).toContain(
      'login read the access token from stdin, DOCKER_CONFIG set',
    );
    expect(dockerCalls()).toContain(`tag nginx ${remote}`);
    expect(dockerCalls()).toContain(`push ${remote}`);
    // The token was in no command, no log line and no row.
    expect(programs().join('\n')).not.toContain(ACCESS_TOKEN);
    expect(dockerCalls()).not.toContain(`login ${ACCESS_TOKEN}`);
    expect(log).not.toContain(ACCESS_TOKEN);
    expect(
      JSON.stringify(await ctx.db.select().from(deployment)),
    ).not.toContain(ACCESS_TOKEN);

    // Waited past the two polls still rolling out; nothing of the app's quoted.
    const polls = ctx.google.calls.filter(
      (call) => call.method === 'cloudRunService',
    );
    expect(polls).toHaveLength(3);
    expect(polls[0]).toMatchObject({
      projectId: PROJECT,
      region: REGION,
      name,
      impersonated: true,
    });
    expect(
      ctx.google.calls.some((call) => call.method === 'listLogEntries'),
    ).toBe(false);
    expect(ctx.google.calls).toContainEqual({
      method: 'deleteImageVersionsExcept',
      impersonated: true,
      projectId: PROJECT,
      region: REGION,
      repository: name,
      image: 'service',
      keepTag: run.deploymentId,
    });

    // The run.app address is its generated Domain, read with the Service.
    const read = await request(http)
      .get(`/applications/${applicationId}`)
      .set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      cloudRunAddress: RUN_APP,
      cloudPlace: {
        cloudAccountId,
        cloudAccountName: 'Production Google',
        cloud: 'gcp',
        region: REGION,
      },
    });
  });

  it('asks Cloud Run again when the wait meets a passing error', async () => {
    ctx.google.refuseSome(
      'cloudRunService',
      'UNAVAILABLE',
      'The service is currently unavailable.',
      { times: 2 },
    );
    const { run } = await appliedWeb();

    expect(run).toMatchObject({ status: 'done' });
    const log = await logOf(run.deploymentId);
    expect(
      log.split('\n').filter((line) => line.includes('; asking again')),
    ).toEqual([
      'Cloud Run could not be asked about the new revision: UNAVAILABLE: The service is currently unavailable.; asking again',
      'Cloud Run could not be asked about the new revision: UNAVAILABLE: The service is currently unavailable.; asking again',
    ]);
  });

  it('fails the wait after 5 passing errors in a row', async () => {
    ctx.google.refuseSome(
      'cloudRunService',
      'UNAVAILABLE',
      'The service is currently unavailable.',
      { times: 5 },
    );
    const { run } = await appliedWeb();

    expect(run).toMatchObject({ status: 'error' });
    const log = await logOf(run.deploymentId);
    expect(log.match(/; asking again/g)).toHaveLength(4);
    expect(log).toContain(
      'Cloud Run could not be asked about the new revision: UNAVAILABLE: The service is currently unavailable.',
    );
  });

  it('fails the wait at once on a refusal that is not passing', async () => {
    ctx.google.refuseSome(
      'cloudRunService',
      'PERMISSION_DENIED',
      'Permission denied on run.services.get',
      { times: 1 },
    );
    const { run } = await appliedWeb();

    expect(run).toMatchObject({ status: 'error' });
    const log = await logOf(run.deploymentId);
    expect(log).toContain(
      'Cloud Run could not be asked about the new revision: PERMISSION_DENIED: Permission denied on run.services.get',
    );
    expect(log).not.toContain('; asking again');
  });

  it('keeps only the live image version after a deploy', async () => {
    const { applicationId, run } = await appliedWeb();
    const name = serviceName(applicationId);
    ctx.google.holdImageVersions(name, 'older-1', 'older-2');

    // A redeploy reads Google again and applies only an image-only plan;
    // the first deploy's own image is one of the older ones now.
    ctx.google.replayPlanFor('web', 'image-only');
    const res = await request(http)
      .post(`/applications/${applicationId}/redeploy`)
      .set('Cookie', cookie)
      .send({});
    expect([200, 201]).toContain(res.status);
    const queued = (res.body as { deploymentId: string }).deploymentId;
    const redeployed = await settledDeployment(queued);

    expect(redeployed.status).toBe('done');
    expect(redeployed.deploymentId).not.toBe(run.deploymentId);
    expect(ctx.google.imageVersions(name)).toEqual([queued]);
    expect(await logOf(queued)).toContain(
      '🧹 [Push] Removed 3 older images from Artifact Registry; only the live one is kept',
    );
    // The repository was there: no second targeted apply.
    expect(
      ctx.google.calls.filter(
        (call) => call.method === 'apply' && call.targets !== undefined,
      ),
    ).toHaveLength(1);
  });

  /**
   * "Check for changes" once Google Cloud is read as Cloudgate made it: the
   * `healthcheck-not-run` notes of the plan it stores.
   */
  async function checked(): Promise<
    { kind: string; configName: string; message: string }[]
  > {
    ctx.google.replayPlanFor('web', null);
    ctx.google.replayPlanFor('network', null);
    const res = await request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie)
      .send({});
    expect(res.status).toBe(201);
    for (let attempt = 0; attempt < 300; attempt++) {
      const current = await request(http)
        .get(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie);
      expect(current.status).toBe(200);
      const found = (
        current.body as {
          plan: {
            steps: { cloudRead?: { status: string } }[];
            notes: { kind: string; configName: string; message: string }[];
          };
        }
      ).plan;
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        return found.notes.filter(
          (note) => note.kind === 'healthcheck-not-run',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading Google Cloud');
  }

  it("records the image's HEALTHCHECK, writes no probe from it, and notes once on each plan that Google Cloud cannot run it; HEALTHCHECK NONE notes nothing", async () => {
    process.env.FAKE_DOCKER_HEALTHCHECK = JSON.stringify({
      Test: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'],
      Interval: 30_000_000_000,
      Retries: 3,
    });
    const { applicationId, run } = await appliedWeb();
    expect(run.status).toBe('done');
    expect(run.cloudRun).toMatchObject({
      healthCheck: {
        test: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'],
        interval: 30_000_000_000,
        retries: 3,
      },
    });

    // One note, naming the Service, however many lines its plan has.
    expect(await checked()).toEqual([
      {
        kind: 'healthcheck-not-run',
        configName: 'web',
        message:
          "web: its image's HEALTHCHECK is not run on Google Cloud, whose health checks are HTTP, TCP or gRPC only and cannot run a command",
      },
    ]);
    // No Cloud Run definition, the deploy's or the check's, has a probe.
    const definitions = ctx.google.tofuInputs.map((one) => one.definition);
    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
      expect(definition).not.toMatch(/probe/i);
      expect(definition).not.toContain('curl -f');
    }

    // An image built with HEALTHCHECK NONE: the next plan notes nothing.
    process.env.FAKE_DOCKER_HEALTHCHECK = JSON.stringify({ Test: ['NONE'] });
    ctx.google.replayPlanFor('web', 'image-only');
    const res = await request(http)
      .post(`/applications/${applicationId}/redeploy`)
      .set('Cookie', cookie)
      .send({});
    expect([200, 201]).toContain(res.status);
    const redeployed = await settledDeployment(
      (res.body as { deploymentId: string }).deploymentId,
    );
    expect(redeployed.status).toBe('done');
    expect(redeployed.cloudRun).toMatchObject({ healthCheck: null });
    expect(await checked()).toEqual([]);
  });

  it('notes nothing for an image with no HEALTHCHECK', async () => {
    const { run } = await appliedWeb();
    expect(run.cloudRun).toMatchObject({ healthCheck: null });
    expect(await checked()).toEqual([]);
  });

  it('starts a stopped Service: its plan after Reload, a copy range edit and Stop changes only the image, and automatic scaling comes back in its copy range before the wait', async () => {
    const { applicationId } = await appliedWeb();
    const name = serviceName(applicationId);
    const act = (method: 'post' | 'put', path: string, body?: object) =>
      request(http)
        [method](`/applications/${applicationId}/${path}`)
        .set('Cookie', cookie)
        .send(body);
    expect((await act('post', 'reload')).status).toBe(200);
    expect(
      (await act('put', 'copy-range', { minCopies: 1, maxCopies: 3 })).status,
    ).toBe(200);
    expect((await act('post', 'stop')).status).toBe(200);
    ctx.google.calls.length = 0;

    // Google, read again, holds all three; the definition ignores them (S9).
    ctx.google.replayPlanFor('web', 'stopped-reloaded');
    const res = await act('post', 'redeploy', {});
    expect([200, 201]).toContain(res.status);
    const queued = (res.body as { deploymentId: string }).deploymentId;
    const redeployed = await settledDeployment(queued);

    // Applied by itself: nothing but the image changed, and no drift.
    expect(redeployed.status).toBe('done');
    const log = await logOf(queued);
    expect(
      log.split('\n').filter((line) => line.startsWith('📋 [Cloud run]')),
    ).toEqual([
      expect.stringMatching(
        /^📋 \[Cloud run\] Cloud Run service `[^`]+`: change, image `[^`]+`$/,
      ),
    ]);
    expect(log).not.toMatch(/changed outside Cloudgate/);
    const order = ctx.google.calls.map((call) => call.method);
    const started = order.indexOf('setCloudRunScaling');
    expect(started).toBeGreaterThan(order.lastIndexOf('apply'));
    expect(started).toBeLessThan(order.indexOf('cloudRunService'));
    expect(ctx.google.calls[started]).toEqual({
      method: 'setCloudRunScaling',
      impersonated: true,
      projectId: PROJECT,
      region: REGION,
      name,
      scaling: { mode: 'automatic', copies: { min: 1, max: 3 } },
    });
    const [row] = await ctx.db
      .select({ status: application.applicationStatus })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    expect(row.status).toBe('done');
  });

  it("ends the Deployment error when the new revision never gets ready, quoting Google's reason and its last 50 lines, and keeps the image still running", async () => {
    const printed = Array.from(
      { length: 60 },
      (_, n) => `line ${n + 1} of the app`,
    );
    const reason =
      "Revision 'x-00002-new' is not ready and cannot serve traffic. The user-provided container failed to start and listen on the port defined provided by the PORT=80 environment variable.";
    ctx.google.failRevision(reason, printed);

    const { applicationId, run } = await appliedWeb();
    const name = serviceName(applicationId);

    expect(run.status).toBe('error');
    expect(run.description).toBe(
      `The new revision failed to become ready: ${reason}`,
    );
    const log = await logOf(run.deploymentId);
    expect(log).toContain(
      `❌ [Cloud run] Revision ${name}-00002-new is not ready: ${reason}`,
    );
    expect(log).toContain('Its last 50 log lines:');
    expect(log).toContain('  line 11 of the app');
    expect(log).toContain('  line 60 of the app');
    expect(log).not.toContain('line 10 of the app');
    expect(log.indexOf('  line 11 of')).toBeLessThan(
      log.indexOf('  line 60 of'),
    );
    expect(ctx.google.calls).toContainEqual({
      method: 'listLogEntries',
      impersonated: true,
      projectId: PROJECT,
      filter: `resource.type="cloud_run_revision" AND resource.labels.service_name="${name}" AND resource.labels.revision_name="${name}-00002-new" AND NOT log_name:"run.googleapis.com%2Frequests"`,
      limit: 50,
    });
    // Not serving: no image version is removed.
    expect(
      ctx.google.calls.some(
        (call) => call.method === 'deleteImageVersionsExcept',
      ),
    ).toBe(false);
    const [row] = await ctx.db
      .select({ status: application.applicationStatus })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    expect(row.status).toBe('error');
  });

  it("quotes the revision's reason too when the apply itself fails waiting for it", async () => {
    const { applicationId } = await appliedWeb();
    ctx.google.replayPlanFor('web', 'image-only');
    ctx.google.failRevision('The container exited with code 1', [
      'Error: missing DATABASE_URL',
    ]);
    ctx.google.failApplyFor(
      'web',
      'Error waiting to update Service: resource is in failed state "Ready:False"',
    );

    const res = await request(http)
      .post(`/applications/${applicationId}/redeploy`)
      .set('Cookie', cookie)
      .send({});
    expect([200, 201]).toContain(res.status);
    const run = await settledDeployment(
      (res.body as { deploymentId: string }).deploymentId,
    );

    expect(run.status).toBe('error');
    expect(run.description).toBe(
      'The new revision failed to become ready: The container exited with code 1',
    );
    const log = await logOf(run.deploymentId);
    expect(log).toContain('Its last 1 log lines:');
    expect(log).toContain('  Error: missing DATABASE_URL');
  });

  it('refuses an image that is not amd64 before any push or apply', async () => {
    process.env.FAKE_DOCKER_ARCH = 'arm64';

    const { plan, run } = await appliedWeb();
    const webStep = plan.steps[1];
    if (webStep.action !== 'create' || webStep.cloudRead?.status !== 'read') {
      throw new Error('the web was not read');
    }

    expect(run.status).toBe('error');
    expect(run.description).toBe(
      'The image is built for arm64; Cloud Run runs x86 (amd64) images only, so nothing was pushed. Deploy an x86 image',
    );
    expect(dockerCalls()).not.toContain('push ');
    expect(dockerCalls()).not.toContain('login ');
    expect(
      runsOf(webStep.cloudRead.stateId).filter(
        ([method]) => method === 'apply',
      ),
    ).toEqual([]);
  });

  it('stops a git build on an ARM platform host before it builds, pointing to a ready-made x86 image', async () => {
    fs.writeFileSync(nodePath.join(bin, 'uname'), ARM_UNAME, { mode: 0o755 });

    const { run } = await appliedWeb(GIT_WEB);

    expect(run.status).toBe('error');
    const log = await logOf(run.deploymentId);
    expect(log).toContain(
      "❌ [Build] Cloud Run runs x86 (amd64) images only, and Cloudgate's own host is not x86, so this Service cannot be built here",
    );
    expect(log).toContain('deploy it as a ready-made image');
    expect(log).not.toContain('Built. Waiting for the Cloud run');
    expect(dockerCalls()).toBe('');
  });

  describe('native.gcp on Cloud Run', () => {
    const RUN = 'google_cloud_run_v2_service.service';
    const NATIVE_WEB = `${WEB}    native:
      gcp:
        "google_cloud_run_v2_service.service":
          ingress: INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER
          template:
            max_instance_request_concurrency: 20
            containers:
              liveness_probe: { http_get: { path: /healthz } }
        "google_compute_backend_service.service":
          timeout_sec: 60
`;
    const NATIVE = {
      [RUN]: {
        ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
        template: {
          max_instance_request_concurrency: 20,
          containers: { liveness_probe: { http_get: { path: '/healthz' } } },
        },
      },
      'google_compute_backend_service.service': { timeout_sec: 60 },
    };

    /** The `resource` object the last `tofu` run of a state was written with. */
    function resourcesWritten(
      stateId: string,
    ): Record<string, Record<string, Record<string, unknown>>> {
      const input = ctx.google.tofuInputs.filter(
        (one) => one.stateId === stateId,
      );
      return (
        JSON.parse(input.at(-1)!.definition) as {
          resource: Record<string, Record<string, Record<string, unknown>>>;
        }
      ).resource;
    }

    const runWritten = (stateId: string) =>
      resourcesWritten(stateId).google_cloud_run_v2_service.service as {
        ingress: string;
        template: {
          max_instance_request_concurrency?: number;
          containers: Record<string, unknown>[];
        };
      };

    it('plans its values as native lines, notes closing run.app, applies them over Cloudgate’s definition, holds them with the Service, says no run.app address, and reads them back as no change', async () => {
      const { plan, applicationId, run } = await appliedWeb(NATIVE_WEB);
      expect(run.status).toBe('done');
      const webStep = plan.steps[1];
      if (webStep.action !== 'create' || webStep.cloudRead?.status !== 'read') {
        throw new Error('the web was not read');
      }
      const at = `native.gcp."${RUN}"`;
      expect(
        webStep.fields
          .filter((field) => 'native' in field && field.native)
          .map((field) => field.field),
      ).toEqual([
        `${at}.ingress`,
        `${at}.template.max_instance_request_concurrency`,
        `${at}.template.containers.liveness_probe.http_get.path`,
        'native.gcp."google_compute_backend_service.service".timeout_sec',
      ]);
      expect(
        plan.notes
          .filter((note) => note.kind.startsWith('run-app'))
          .map((note) => note.message),
      ).toEqual([
        'web: run.app address closes: only Domains and this Environment reach it',
        expect.stringContaining('web: has no Domain') as string,
      ]);

      // Held with the Service's saved settings, as written.
      const [row] = await ctx.db
        .select({
          nativeGcp: application.nativeGcp,
          cloudRunAddress: application.cloudRunAddress,
        })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(row).toEqual({ nativeGcp: NATIVE, cloudRunAddress: null });

      // The deploy's apply laid it over Cloudgate's definition, its one
      // container keeping its image and port.
      const webState = webStep.cloudRead.stateId;
      const written = runWritten(webState);
      expect(written.ingress).toBe('INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER');
      expect(written.template.max_instance_request_concurrency).toBe(20);
      expect(written.template.containers).toHaveLength(1);
      expect(written.template.containers[0]).toMatchObject({
        liveness_probe: { http_get: { path: '/healthz' } },
        image: expect.stringContaining(`:${run.deploymentId}`) as string,
        ports: { container_port: expect.any(Number) as number },
      });
      expect(
        resourcesWritten(webState).google_compute_backend_service.service,
      ).toMatchObject({ timeout_sec: 60, protocol: 'HTTPS' });

      // The Deployment log no longer says it answers at its run.app address.
      const log = await logOf(run.deploymentId);
      expect(log).not.toContain('answers at https://');
      expect(log).toContain(
        "🔒 [Cloud run] web's run.app address is closed: only its Domains and this Environment reach it",
      );

      // Check for changes lays the applied block, so its cloud lines show
      // the native values and Drift compares against the merged definition;
      // the config is what was applied, so the step changes no field.
      const reads = () =>
        ctx.google.calls.filter(
          (call) => call.method === 'plan' && call.stateId === webState,
        ).length;
      const before = reads();
      ctx.google.replayPlanFor('web', null);
      ctx.google.replayPlanFor('network', null);
      const checkedPlan = await request(http)
        .post(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie)
        .send({});
      expect(checkedPlan.status).toBeLessThan(300);
      const step = (
        checkedPlan.body as {
          steps: { configName?: string; fields?: unknown[] }[];
        }
      ).steps.find((one) => one.configName === 'web');
      expect(step?.fields).toEqual([]);
      for (let attempt = 0; reads() === before; attempt++) {
        if (attempt > 400) throw new Error('The Service was never read again');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(
        runWritten(webState).template.max_instance_request_concurrency,
      ).toBe(20);
    });

    // Acceptance: a hand change to an open setting native sets is
    // Drift against the merged definition, put back to the native value.
    it('shows a hand change to an open setting native sets as Drift, put back to the native value', async () => {
      const { plan } = await appliedWeb(NATIVE_WEB);
      const webStep = plan.steps[1];
      if (webStep.action !== 'create' || webStep.cloudRead?.status !== 'read') {
        throw new Error('the web was not read');
      }
      const webState = webStep.cloudRead.stateId;

      // The refresh saw the concurrency moved by hand from native's 20 to
      // 80, and the plan of the merged definition moves it back to 20.
      const stored = storedGooglePlan('drift-field') as unknown as TofuShowJson;
      const run = stored.resource_changes!.find((one) => one.address === RUN)!;
      const made = run.change.before as { template: Record<string, unknown>[] };
      const withConcurrency = (value: number) => ({
        ...made,
        template: [
          { ...made.template[0], max_instance_request_concurrency: value },
        ],
      });
      const drifted: TofuShowJson = {
        ...stored,
        resource_drift: [
          {
            ...run,
            change: {
              ...run.change,
              actions: ['update'],
              before: withConcurrency(20),
              after: withConcurrency(80),
            },
          },
        ],
        resource_changes: stored.resource_changes!.map((one) =>
          one === run
            ? {
                ...one,
                change: {
                  ...one.change,
                  actions: ['update'],
                  before: withConcurrency(80),
                  after: withConcurrency(20),
                },
              }
            : {
                ...one,
                change: {
                  ...one.change,
                  actions: ['no-op'],
                  after: one.change.before,
                  after_unknown: {},
                },
              },
        ),
      };
      ctx.google.replayShowFor('web', drifted as unknown as TofuShow);
      ctx.google.replayPlanFor('network', null);

      const checkedPlan = await request(http)
        .post(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie)
        .send({});
      expect(checkedPlan.status).toBeLessThan(300);
      type Read = {
        configName?: string;
        cloudRead?: {
          status: string;
          drift?: { address: string; fields: unknown[] }[];
        };
      };
      let step: Read | undefined;
      for (let attempt = 0; attempt < 300; attempt++) {
        const current = await request(http)
          .get(`/environments/${environmentId}/plan`)
          .set('Cookie', cookie);
        const steps = (current.body as { plan: { steps: Read[] } }).plan.steps;
        if (!steps.some((one) => one.cloudRead?.status === 'reading')) {
          step = steps.find((one) => one.configName === 'web');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(step?.cloudRead?.drift).toEqual([
        expect.objectContaining({
          address: RUN,
          fields: [
            {
              field: expect.stringContaining(
                'max_instance_request_concurrency',
              ) as string,
              hand: '80',
              cloudgate: '20',
            },
          ],
        }),
      ]);
      // Read against the definition with native laid over Cloudgate's.
      expect(
        runWritten(webState).template.max_instance_request_concurrency,
      ).toBe(20);
    });

    // Stories 24 and 43: native wins at deploy, so the console may
    // not change a limit it sets, as the Database page may not a tier.
    it('refuses a console edit of a cap native sets, naming the path, and saves the rest', async () => {
      const { applicationId } = await appliedWeb();
      await ctx.db
        .update(application)
        .set({
          nativeGcp: {
            [RUN]: {
              template: {
                containers: { resources: { limits: { memory: '2Gi' } } },
              },
            },
          },
        })
        .where(eq(application.applicationId, applicationId));
      const [before] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId));

      const refused = await request(http)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({ memoryLimit: String(4 * 1024 * 1024 * 1024) });
      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        `memoryLimit is set by web.native.gcp."${RUN}".template.containers.resources.limits.memory in the Project config, which owns it while it sets it; change it there, or take the key out to hand it back to this page`,
      );

      const saved = await request(http)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({ memoryLimit: before.memoryLimit, cpuLimit: String(2e9) });
      expect(saved.status).toBe(200);
      const [after] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(after).toMatchObject({
        memoryLimit: before.memoryLimit,
        cpuLimit: String(2e9),
      });
    });

    it('fails the deploy of a stored row holding a value now locked, naming it, before anything changes', async () => {
      const { applicationId } = await appliedWeb();
      await ctx.db
        .update(application)
        .set({
          nativeGcp: { [RUN]: { ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY' } },
        })
        .where(eq(application.applicationId, applicationId));
      const applies = () =>
        ctx.google.calls.filter((call) => call.method === 'apply').length;
      const before = applies();

      ctx.google.replayPlanFor('web', 'image-only');
      const res = await request(http)
        .post(`/applications/${applicationId}/redeploy`)
        .set('Cookie', cookie)
        .send({});
      expect([200, 201]).toContain(res.status);
      const run = await settledDeployment(
        (res.body as { deploymentId: string }).deploymentId,
      );

      expect(run.status).toBe('error');
      expect(run.description).toContain(
        `web.native.gcp."${RUN}".ingress: refused`,
      );
      expect(applies()).toBe(before);
    });
  });

  it('refuses a linked Registry or build Registry on the Service, naming it', async () => {
    const { applicationId } = await appliedWeb();
    const [linked] = await ctx.db
      .insert(registry)
      .values({
        organizationId,
        name: 'company-registry',
        username: 'deployer',
        password: 'registry-password',
        url: 'registry.example.com',
      })
      .returning();

    for (const field of ['registryId', 'buildRegistryId']) {
      const res = await request(http)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({ [field]: linked.registryId });
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        'Registry company-registry cannot be linked as the',
      );
      expect((res.body as { message: string }).message).toContain(
        "its image always goes to the Service's own repository in its Cloud account",
      );
    }
  });
});
