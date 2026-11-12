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
  environmentNetwork,
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

/** A Private web service, the Environment's first and only cloud Service. */
const INSIDE = `version: 1
services:
  inside:
    kind: web-private
    port: 4000
    source: { image: acme/inside }
`;

/** The same, and a second Private web service beside it. */
const TWO = `${INSIDE}  other:
    kind: web-private
    port: 5000
    source: { image: acme/other }
`;

/** The plan line of the network's run.app zone, with its price. */
const ZONE_LINE =
  "Private DNS zone `run.app`: create, for this Environment's Private web services, about $0.20/month";

/** The address the stored apply hands over: its `urls`' project-number form. */
const URL = 'https://cloudgate-tfeyly54xiuh-123456789012.europe-west1.run.app';

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
 * A Private web service on Google Cloud (spec "Private web
 * service on Google Cloud"): a `kind: web-private` entry plans and applies
 * into a Google Cloud Environment as an internal-only Cloud Run service. The
 * first one in an Environment network adds the network's private `run.app`
 * zone on the network step, with its price; a second does not, and the
 * last one's removal keeps it. Its deploy is a `web`'s, but it is handed
 * over at its own `run.app` URL as its internal address, never a Domain,
 * and a Domain, a published port and previews are refused on it.
 *
 * Against the Google fake (`ctx.google`), whose stand-in `tofu` replays the
 * stored `network-create-run-app-zone` and `web-private-create` plans and
 * applies, and a real shell with a fake `docker`.
 */
describe('A Private web service on Cloud Run (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), 'cloudgate-gprivate-'),
  );
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

    ctx.google.replayPlanFor('network', 'network-create-run-app-zone');
    ctx.google.replayPlanFor('web-private', 'web-private-create');
    ctx.google.replayOutputsFor('network', 'network-create');
    ctx.google.replayOutputsFor('web-private', 'web-private-create');
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

  /** Plans `text`, applies it, and waits for `name`'s Deployment. */
  async function applied(
    text: string = INSIDE,
    name = 'inside',
  ): Promise<{ plan: Plan; applicationId: string; run: Deployment }> {
    expect((await savePlan(text)).status).toBe(201);
    const read = await openPlan();
    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    const done = await settledPlan(read.planId);
    const result = done.results!.find((one) => one.configName === name)!;
    expect(result).toMatchObject({ status: 'applied', domain: null });
    if (result.deploy?.status !== 'queued') throw new Error('not queued');
    const run = await settledDeployment(result.deploy.deploymentId);
    return { plan: read, applicationId: result.serviceId!, run };
  }

  /** The open plan's steps, once Google Cloud is read, closing it after. */
  async function plannedSteps(text: string): Promise<Plan['steps']> {
    expect((await savePlan(text)).status).toBe(201);
    const read = await openPlan();
    await ctx.db.delete(planTable).where(eq(planTable.planId, read.planId));
    return read.steps;
  }

  const logOf = async (deploymentId: string) => {
    const res = await request(http)
      .get(`/deployments/${deploymentId}/logs`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.text;
  };

  it("plans the network first with its run.app zone and the zone's price, and the Private web service as an internal-only Cloud Run service with no load-balancer piece", async () => {
    expect((await savePlan(INSIDE)).status).toBe(201);
    const read = await openPlan();

    expect(read.steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);
    const [network, inside] = read.steps;
    if (
      network.action !== 'network-create' ||
      network.cloudRead?.status !== 'read'
    ) {
      throw new Error('the network was not read');
    }
    expect(network.privateLinks).toEqual(['run-app-zone']);
    expect(network.cloudRead.summary).toEqual(
      expect.arrayContaining([
        'Environment network: create, $0/month for the network, about $18/month while idle for the load balancer',
        ZONE_LINE,
      ]),
    );
    // No Cloud NAT, no router, no egress change: the subnet's Private
    // Google Access and every Service's private-ranges-only egress carry it.
    expect(JSON.stringify(network.cloudRead)).not.toMatch(
      /router|_nat|ALL_TRAFFIC/,
    );
    if (inside.action !== 'create' || inside.cloudRead?.status !== 'read') {
      throw new Error('the web-private was not read');
    }
    expect(inside.kind).toBe('web-private');
    expect(inside.cloudRead.raw.map((line) => line.address)).toEqual([
      'google_artifact_registry_repository.service',
      'google_cloud_run_v2_service.service',
      'google_service_account.service',
    ]);
    expect(inside.cloudRead.summary).toContain(
      'Cloud Run service `inside`: create, 1 CPU / 512 MB, CPU only during requests, 0–10 copies, reached only from this Environment',
    );
    expect(JSON.stringify(inside)).not.toMatch(
      /backend_service|network_endpoint_group|No Domain yet|PRIVATE_RANGES_ONLY.*ALL_TRAFFIC/,
    );
    // The definition it planned was internal-only, read as a web-private.
    expect(
      ctx.google.calls.some(
        (call) => call.method === 'plan' && call.kind === 'web-private',
      ),
    ).toBe(true);
  });

  it('applies the network with its zone, then the Cloud Run service, handing over its run.app URL as its internal address and no Domain', async () => {
    const { applicationId, run } = await applied();

    expect(run).toMatchObject({ applicationId, status: 'done' });
    const [network] = await ctx.db.select().from(environmentNetwork);
    expect(network.privateLinks).toEqual(['run-app-zone']);
    const [created] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));
    expect(created).toMatchObject({
      configKind: 'web-private',
      cloudAccountId,
      region: REGION,
      minCopies: 0,
      maxCopies: 10,
      cloudRunAddress: URL.replace('https://', ''),
    });
    expect(await ctx.db.select().from(domain)).toEqual([]);

    const read = await request(http)
      .get(`/applications/${applicationId}`)
      .set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ internalAddress: URL });

    // A web's deploy: automatic scaling in its copy range, the wait on its
    // new revision, never a worker pool.
    const service = {
      projectId: PROJECT,
      region: REGION,
      name: serviceName(applicationId),
    };
    expect(ctx.google.calls).toContainEqual(
      expect.objectContaining({
        method: 'setCloudRunScaling',
        ...service,
        scaling: { mode: 'automatic', copies: { min: 0, max: 10 } },
      }),
    );
    expect(
      ctx.google.calls.some((call) => call.method === 'cloudRunService'),
    ).toBe(true);
    expect(
      ctx.google.calls.filter((call) =>
        ['cloudRunWorkerPool', 'setWorkerPoolInstances'].includes(call.method),
      ),
    ).toEqual([]);
    expect(
      ctx.google.calls.some(
        (call) => call.method === 'apply' && call.kind === 'web-private',
      ),
    ).toBe(true);

    const log = await logOf(run.deploymentId);
    expect(log).toContain(
      `🔒 [Cloud run] ${created.name} answers only inside this Environment, at ${URL}; a new one can answer 404 there for about 1.5 to 3.5 minutes while Google sets it up`,
    );
    expect(log).not.toContain('answers at https://');
  });

  it('does not add the zone again for a second web-private, and keeps it when the last one goes', async () => {
    await applied();

    const second = await plannedSteps(TWO);
    expect(second.map((step) => step.action)).not.toContain('network-change');
    expect(second.map((step) => step.action)).not.toContain('network-create');
    expect(JSON.stringify(second)).not.toContain('Private DNS zone `run.app`');

    const removed = await plannedSteps(
      'version: 1\nservices:\n  api:\n    kind: web\n    source: { image: nginx }\n',
    );
    expect(
      removed
        .filter((step) => 'configName' in step)
        .map(
          (step) =>
            `${step.action} ${(step as { configName: string }).configName}`,
        ),
    ).toEqual(expect.arrayContaining(['destroy inside', 'create api']));
    expect(removed.filter((step) => step.action.startsWith('network'))).toEqual(
      [],
    );
    const [network] = await ctx.db.select().from(environmentNetwork);
    expect(network.privateLinks).toEqual(['run-app-zone']);
  });

  it('refuses a Domain, a published port and a preview on it, as on a Server and AWS', async () => {
    const { applicationId } = await applied();
    const send = (
      method: 'post' | 'patch',
      path: string,
      body: Record<string, unknown>,
    ) => request(http)[method](path).set('Cookie', cookie).send(body);
    const noPreview = {
      message:
        'A Private web service has no previews: a preview is reached at its own Domain, and a Private web service takes none. To preview it, change its kind to web in the Project config',
      code: 'KIND_TAKES_NO_PREVIEWS',
    };

    const added = await send('post', '/domains', {
      host: 'inside.example.com',
      applicationId,
      domainType: 'application',
      port: 4000,
    });
    expect([added.status, added.body]).toEqual([
      409,
      expect.objectContaining({
        message:
          'A Private web service takes no Domain: only other Services reach it, at its internal address. To serve it outside, change its kind to web in the Project config',
        code: 'KIND_TAKES_NO_DOMAIN',
      }),
    ]);
    const port = await send('post', '/ports', {
      applicationId,
      publishedPort: 8080,
      targetPort: 4000,
    });
    expect([port.status, port.body]).toEqual([
      409,
      expect.objectContaining({ code: 'KIND_PUBLISHES_NO_PORT' }),
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

  it('stops and starts as a web on Cloud Run does: manual scaling at no copies, then automatic in its copy range', async () => {
    const { applicationId } = await applied();
    ctx.google.calls.length = 0;
    const post = (action: string) =>
      request(http)
        .post(`/applications/${applicationId}/${action}`)
        .set('Cookie', cookie);
    const service = {
      projectId: PROJECT,
      region: REGION,
      name: serviceName(applicationId),
    };

    expect((await post('stop')).status).toBe(200);
    expect((await post('start')).status).toBe(200);
    expect(
      ctx.google.calls
        .filter((call) => call.method === 'setCloudRunScaling')
        .map((call) => (call as { scaling: unknown }).scaling),
    ).toEqual([
      { mode: 'stopped' },
      { mode: 'automatic', copies: { min: 0, max: 10 } },
    ]);
    expect(
      ctx.google.calls.filter(
        (call) => call.method === 'setCloudRunScaling',
      )[0],
    ).toMatchObject(service);
  });

  it('switches it to a web or a worker as a destroy and a create confirmed by name', async () => {
    await applied();

    for (const text of [
      'version: 1\nservices:\n  inside:\n    kind: web\n    port: 4000\n    source: { image: acme/inside }\n',
      'version: 1\nservices:\n  inside:\n    kind: worker\n    command: node worker.js\n    source: { image: acme/inside }\n',
    ]) {
      expect((await savePlan(text)).status).toBe(201);
      const open = await openPlan();
      expect(open.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'destroy', configName: 'inside' }),
          expect.objectContaining({ action: 'create', configName: 'inside' }),
        ]),
      );
      const unconfirmed = await request(http)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: open.planId });
      expect(unconfirmed.status).toBe(409);
      expect(unconfirmed.body).toMatchObject({
        code: 'PLAN_DESTROY_NOT_CONFIRMED',
      });
      await ctx.db.delete(planTable).where(eq(planTable.planId, open.planId));
    }
  });
});
