import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { GOOGLE_LEFTOVER_RECHECK } from '../../src/applications/google-leftover-recheck';
import type { ServiceCloudDeleteRecord } from '../../src/applications/application.schema';
import {
  domainName,
  idKey,
  serviceName,
} from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import { tofuStates } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import {
  application,
  auditLog,
  cloudAccount,
  deployment,
  domain,
  environmentNetwork,
  infrastructureState,
  webServerSettings,
} from '../../src/db/schema';
import { CloudRunsService } from '../../src/deployment-queue/cloud-runs.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import type { FakeGoogleCall } from '../utils/fake-google-cloud-port';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

/** What a Domain's own network run targets: its three blocks and the URL map. */
const DOMAIN_RUN_TARGETS = [
  'google_certificate_manager_dns_authorization.domain',
  'google_certificate_manager_certificate.domain',
  'google_certificate_manager_certificate_map_entry.domain',
  'google_compute_url_map.network',
];

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';
const HOST = 'shop.acme.dev';
const URL_MAP = 'cloudgate-urls';
const CERTIFICATE_MAP = 'cloudgate-certs';

/** A `docker` that removes nothing and fails nothing. */
const FAKE_DOCKER = '#!/bin/bash\nexit 0\n';

/** Google's words for an API turned off, as its list calls answer them. */
const COMPUTE_OFF =
  'Compute Engine API has not been used in project 123456789012 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/compute.googleapis.com/overview?project=123456789012 then retry.';

/**
 * A Cloud Run Service's Delete (ADR-0038) is one destroy-only Cloud run that
 * first takes the Service's Domains off the Environment network (a network step), then
 * destroys the Service's state, then searches Google Cloud by name for
 * anything left. A network step that fails stops before the Service is
 * touched; anything left keeps the row Delete incomplete with Retry
 * (always from the network step) and Forget (leftovers into the audit
 * entry). Against the Google fake, whose stand-in `tofu` replays empty
 * plans, and whose list calls find what a spec scripts.
 */
describe('Deleting a Cloud Run Service on Google Cloud (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let cloudAccountId: string;
  let environmentId: string;
  let applicationId: string;
  let stateId: string;
  let domainId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gdelete-'));
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

  /**
   * The leftover search's second look, taken at once: it keeps
   * each wait asked, and runs `catchUp` first, which a test sets to show
   * Google's lists catching up with the destroy.
   */
  const recheck = {
    waits: [] as number[],
    catchUp: null as (() => void) | null,
    wait(ms: number): Promise<void> {
      recheck.waits.push(ms);
      recheck.catchUp?.();
      return Promise.resolve();
    },
  };

  beforeAll(async () => {
    process.env.CLOUDGATE_DIRECTORY = root;
    fs.mkdirSync(bin);
    fs.writeFileSync(nodePath.join(bin, 'docker'), FAKE_DOCKER, {
      mode: 0o755,
    });
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: GOOGLE_LEFTOVER_RECHECK, useValue: recheck },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (saved === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    recheck.waits.length = 0;
    recheck.catchUp = null;
    await ctx.resetDb();
    // The Google Deploy target's region check signs a proof under this host.
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
    const projectId = (project.body as { projectId: string }).projectId;

    const key = makeSigningKey();
    const [account] = await ctx.db
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
    cloudAccountId = account.cloudAccountId;
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

    const [network] = await ctx.db
      .insert(environmentNetwork)
      .values({
        environmentId,
        cloudAccountId,
        region: REGION,
        status: 'ready',
        networkName: 'cloudgate-net',
        subnetName: 'cloudgate-subnet',
        ipAddress: '34.120.0.7',
        urlMapName: URL_MAP,
        certificateMapName: CERTIFICATE_MAP,
      })
      .returning();
    const states = ctx.app.get(InfrastructureStatesService);
    await states.create(
      { environmentNetworkId: network.environmentNetworkId },
      undefined,
      'google',
    );

    // A web as its finished deploy leaves it, with one Domain on the
    // network's load balancer.
    const [web] = await ctx.db
      .insert(application)
      .values({
        name: 'web',
        environmentId,
        configName: 'web',
        configKind: 'web',
        sourceType: 'docker',
        dockerImage: 'nginx',
        port: 8080,
        cloudAccountId,
        region: REGION,
        applicationStatus: 'done',
      })
      .returning();
    applicationId = web.applicationId;
    stateId = (await states.create({ applicationId }, undefined, 'google'))
      .infrastructureStateId;
    await ctx.db
      .insert(tofuStates)
      .values({ name: stateId, data: 'encrypted-by-opentofu' });
    const [one] = await ctx.db
      .insert(domain)
      .values({
        host: HOST,
        applicationId,
        cloudCertificateStatus: 'live',
        googleCertificateName: `projects/${PROJECT}/locations/global/certificates/x`,
      })
      .returning();
    domainId = one.domainId;
    ctx.google.reset();
  });

  async function until(check: () => Promise<boolean>, ms = 30_000) {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function row() {
    const [found] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));
    return found;
  }

  const gone = async () => (await row()) === undefined;
  const incomplete = async () =>
    (await row())?.cloudDelete?.status === 'incomplete';
  const deploymentsOf = () =>
    ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.applicationId, applicationId));
  const settledRuns = async () =>
    (await deploymentsOf()).every(
      (one) => one.status !== 'running' && one.status !== 'pending',
    );
  const auditEntries = () =>
    ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resourceId, applicationId));

  const del = () =>
    request(http)
      .delete(`/applications/${applicationId}`)
      .set('Cookie', cookie);
  const post = (action: string) =>
    request(http)
      .post(`/applications/${applicationId}/${action}`)
      .set('Cookie', cookie);

  /** The `tofu` runs and list calls the fake answered, in order. */
  const steps = () =>
    ctx.google.calls.flatMap((call: FakeGoogleCall) =>
      call.method === 'apply' || call.method === 'destroy'
        ? [`${call.method}:${call.kind}`]
        : call.method === 'findByName'
          ? ['search']
          : [],
    );
  const firstOfEach = (list: string[]) =>
    list.filter((step, index) => list.indexOf(step) === index);

  /** A Cloud Run service and a secret of the Service that a Delete left. */
  function scriptLeftovers() {
    ctx.google.find(
      {
        resourceType: 'google_cloud_run_v2_service',
        name: serviceName(applicationId),
        id: `projects/${PROJECT}/locations/${REGION}/services/${serviceName(applicationId)}`,
        labels: { 'cloudgate-state': idKey(stateId) },
      },
      {
        resourceType: 'google_service_account',
        name: serviceName(applicationId),
        id: `projects/${PROJECT}/serviceAccounts/${serviceName(applicationId)}@${PROJECT}.iam.gserviceaccount.com`,
      },
    );
  }

  const LEFT = () => [
    {
      type: 'run.googleapis.com/Service',
      googleName: serviceName(applicationId),
      region: REGION,
      label: `cloudgate-state=${idKey(stateId)}`,
    },
    {
      type: 'iam.googleapis.com/ServiceAccount',
      googleName: serviceName(applicationId),
      region: 'global',
      label: null,
    },
  ];

  it('runs the network step, then the destroy, then the search, and removes the row, its state and its Domain', async () => {
    const res = await del();

    expect(res.status).toBe(200);
    const record = (res.body as { cloudDelete: ServiceCloudDeleteRecord })
      .cloudDelete;
    expect(record).toMatchObject({ status: 'deleting', left: [] });
    const [run] = await deploymentsOf();
    expect(run).toMatchObject({ title: 'Delete' });
    expect(run.description).toMatch(
      /^Removes its Domains from the Environment network, then destroys/,
    );
    expect(run.cloudRun).toMatchObject({
      kind: 'destroy',
      touchesNetwork: true,
    });

    await until(gone);
    expect(firstOfEach(steps())).toEqual([
      'apply:network',
      'destroy:destroy',
      'search',
    ]);
    // The network's Domain run, with the Service's Domain left out.
    const networkRun = ctx.google.calls.find(
      (call) => call.method === 'apply' && call.kind === 'network',
    );
    expect(networkRun).toMatchObject({
      targets: DOMAIN_RUN_TARGETS,
      domains: {},
    });
    expect(
      ctx.google.calls.filter((call) => call.method === 'destroy'),
    ).toEqual([expect.objectContaining({ stateId })]);
    // The search: each kind the Service made by its name, and each of its
    // Domain's pieces by the Domain's.
    const searched = ctx.google.calls.flatMap((call) =>
      call.method === 'findByName'
        ? [[call.resourceType, call.namePrefix, call.parent ?? null]]
        : [],
    );
    expect(searched).toEqual([
      ['google_compute_backend_service', serviceName(applicationId), null],
      [
        'google_compute_region_network_endpoint_group',
        serviceName(applicationId),
        null,
      ],
      ['google_cloud_run_v2_service', serviceName(applicationId), null],
      // A Worker's worker pool, by the same fixed name.
      ['google_cloud_run_v2_worker_pool', serviceName(applicationId), null],
      // A Cron service's job, by the same fixed name.
      ['google_cloud_run_v2_job', serviceName(applicationId), null],
      ['google_artifact_registry_repository', serviceName(applicationId), null],
      ['google_secret_manager_secret', serviceName(applicationId), null],
      ['google_service_account', serviceName(applicationId), null],
      [
        'google_certificate_manager_certificate_map_entry',
        domainName(domainId),
        CERTIFICATE_MAP,
      ],
      [
        'google_certificate_manager_certificate',
        domainName(domainId),
        CERTIFICATE_MAP,
      ],
      [
        'google_certificate_manager_dns_authorization',
        domainName(domainId),
        CERTIFICATE_MAP,
      ],
    ]);
    expect(await deploymentsOf()).toEqual([]);
    expect(
      await ctx.db
        .select()
        .from(infrastructureState)
        .where(eq(infrastructureState.infrastructureStateId, stateId)),
    ).toEqual([]);
    expect(
      await ctx.db.select().from(domain).where(eq(domain.domainId, domainId)),
    ).toEqual([]);
    expect(
      (await auditEntries()).some((entry) =>
        (entry.metadata ?? '').includes('"cloudDelete":"finished"'),
      ),
    ).toBe(true);
  });

  it('says the clean report in one line', async () => {
    const lines: string[] = [];
    const runs = ctx.app.get(CloudRunsService);
    const spy = jest
      .spyOn(runs, 'appendLog')
      .mockImplementation((_path: string, line: string) => {
        lines.push(line);
        return Promise.resolve();
      });
    try {
      expect((await del()).status).toBe(200);
      await until(gone);
    } finally {
      spy.mockRestore();
    }
    expect(lines).toContain(
      'Nothing was left in your Google Cloud project: every resource of this Service is gone.',
    );
  });

  it("keeps every other Service's Domains on the network", async () => {
    const [api] = await ctx.db
      .insert(application)
      .values({
        name: 'api',
        environmentId,
        configName: 'api',
        configKind: 'web',
        port: 8080,
        cloudAccountId,
        region: REGION,
      })
      .returning();
    const [other] = await ctx.db
      .insert(domain)
      .values({
        host: 'api.acme.dev',
        applicationId: api.applicationId,
        cloudCertificateStatus: 'live',
      })
      .returning();

    expect((await del()).status).toBe(200);
    await until(gone);

    const networkRun = ctx.google.calls.find(
      (call) => call.method === 'apply' && call.kind === 'network',
    );
    expect(networkRun?.method === 'apply' ? networkRun.domains : null).toEqual({
      [other.domainId]: {
        host: 'api.acme.dev',
        certificate: domainName(other.domainId),
      },
    });
  });

  it('skips the network step for a Service with no Domain', async () => {
    await ctx.db.delete(domain).where(eq(domain.domainId, domainId));

    expect((await del()).status).toBe(200);
    await until(gone);

    expect(firstOfEach(steps())).toEqual(['destroy:destroy', 'search']);
  });

  it('stops before touching the Service when the network step fails, listing its host rule and what is still there, and Retry starts again from the network step', async () => {
    scriptLeftovers();
    ctx.google.failRunFor(
      'network',
      'Error 403: Permission compute.urlMaps.update denied',
    );

    expect((await del()).status).toBe(200);
    await until(incomplete);
    await until(settledRuns);

    expect(steps()).not.toContain('destroy:destroy');
    const kept = (await row()).cloudDelete!;
    expect(kept.left).toEqual([
      {
        type: 'compute.googleapis.com/UrlMap host rule',
        googleName: `${URL_MAP} ${HOST}`,
        region: 'global',
        label: null,
      },
      ...LEFT(),
    ]);
    expect(kept.unfinished).toMatch(
      /^The network step failed before web was touched: .*compute\.urlMaps\.update denied/,
    );
    expect(
      await ctx.db
        .select()
        .from(infrastructureState)
        .where(eq(infrastructureState.infrastructureStateId, stateId)),
    ).toHaveLength(1);

    ctx.google.reset();
    expect((await post('delete/retry')).status).toBe(200);
    await until(gone);
    expect(firstOfEach(steps())).toEqual([
      'apply:network',
      'destroy:destroy',
      'search',
    ]);
  });

  it('names each leftover with its type, Google name, region and label, and Forget writes them into the audit entry', async () => {
    scriptLeftovers();

    expect((await del()).status).toBe(200);
    await until(incomplete);
    await until(settledRuns);

    expect((await row()).cloudDelete).toMatchObject({
      status: 'incomplete',
      left: LEFT(),
      unfinished: null,
    });
    expect((await deploymentsOf())[0].description).toBe(
      'Delete incomplete: 2 resources are left in Google Cloud. Retry starts again from the network step',
    );
    // A second Delete is refused: only Retry or Forget end it.
    expect((await del()).status).toBe(409);

    const forgotten = await post('delete/forget');

    expect(forgotten.status).toBe(200);
    expect(await row()).toBeUndefined();
    const entry = (await auditEntries()).find((one) =>
      (one.metadata ?? '').includes('"cloudDelete":"forgotten"'),
    );
    expect(JSON.parse(entry!.metadata!)).toMatchObject({ left: LEFT() });
  });

  it("finds a leftover Cloud Run worker pool by the Service's fixed name, as it finds a service", async () => {
    ctx.google.find({
      resourceType: 'google_cloud_run_v2_worker_pool',
      name: serviceName(applicationId),
      id: `projects/${PROJECT}/locations/${REGION}/workerPools/${serviceName(applicationId)}`,
      labels: { 'cloudgate-state': idKey(stateId) },
    });

    expect((await del()).status).toBe(200);
    await until(incomplete);
    await until(settledRuns);

    expect((await row()).cloudDelete).toMatchObject({
      status: 'incomplete',
      left: [
        {
          type: 'run.googleapis.com/WorkerPool',
          googleName: serviceName(applicationId),
          region: REGION,
          label: `cloudgate-state=${idKey(stateId)}`,
        },
      ],
    });
    expect(
      ctx.google.calls.filter(
        (call) =>
          call.method === 'findByName' &&
          call.resourceType === 'google_cloud_run_v2_worker_pool',
      ),
    ).toEqual([
      expect.objectContaining({
        region: REGION,
        namePrefix: serviceName(applicationId),
      }),
      // The second look, 10 s on.
      expect.objectContaining({
        region: REGION,
        namePrefix: serviceName(applicationId),
      }),
    ]);
  });

  it('looks again 10 s after the search finds anything, and only that look says what is left: a service account the destroy just removed is not left', async () => {
    // The first look lists the account the destroy deleted a second
    // earlier; by the second, Google's list has caught up.
    scriptLeftovers();
    recheck.catchUp = () => ctx.google.findNothing();

    expect((await del()).status).toBe(200);
    await until(gone);

    expect(recheck.waits).toEqual([10_000]);
    expect(
      ctx.google.calls.filter(
        (call) =>
          call.method === 'findByName' &&
          call.resourceType === 'google_service_account',
      ),
    ).toHaveLength(2);
  });

  it('does not look again after a clean search', async () => {
    expect((await del()).status).toBe(200);
    await until(gone);

    expect(recheck.waits).toEqual([]);
  });

  it('retries from the network step and finishes clean once nothing is left', async () => {
    scriptLeftovers();
    await del();
    await until(incomplete);
    await until(settledRuns);

    ctx.google.findNothing();
    ctx.google.calls.length = 0;
    const retried = await post('delete/retry');

    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      cloudDelete: { status: 'deleting', retrying: true },
    });
    await until(gone);
    expect(firstOfEach(steps())).toEqual([
      'apply:network',
      'destroy:destroy',
      'search',
    ]);
  });

  it('names an API turned off, and the setup step that turns it on, when the search cannot read a kind', async () => {
    ctx.google.refuse('findByName', 'PERMISSION_DENIED', COMPUTE_OFF);

    expect((await del()).status).toBe(200);
    await until(incomplete);

    const kept = (await row()).cloudDelete!;
    expect(kept.left).toEqual([]);
    expect(kept.unfinished).toBe(
      `What is left could not be checked: Google refused the search for compute.googleapis.com/BackendService: The Compute Engine API (compute.googleapis.com) is off in Google Cloud project ${PROJECT}. Cloudgate never turns on an API: turn it on as step 1 of the setup script does (gcloud services enable compute.googleapis.com), then Check for changes`,
    );
  });

  it('fails and removes nothing when the Google Cloud project cannot be reached', async () => {
    ctx.google.refuse(
      'exchangeToken',
      'invalid_grant',
      'The audience in ID Token does not match the expected audience.',
    );

    const res = await del();

    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toMatch(
      /Nothing was removed$/,
    );
    expect((await row()).cloudDelete).toBeNull();
    expect(await deploymentsOf()).toEqual([]);
    expect(steps()).toEqual([]);
  });
});
