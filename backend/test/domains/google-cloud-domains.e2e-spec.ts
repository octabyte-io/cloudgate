import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { idKey } from '../../src/cloud-accounts/gcp/definitions/names';
import { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import {
  application,
  cloudAccount,
  deployment,
  domain,
  environment,
  environmentNetwork,
  organization,
  plan as planTable,
  project,
  webServerSettings,
} from '../../src/db/schema';
import type { Deployment, Domain } from '../../src/db/schema';
import { CloudReadWorks } from '../../src/deployment-queue/cloud-read-work';
import { CLOUD_RUN_SETTINGS } from '../../src/deployment-queue/cloud-runs-concurrency.provider';
import { CloudRunsService } from '../../src/deployment-queue/cloud-runs.service';
import { CloudDomainRuns } from '../../src/project-config/applier/cloud-domain-runs.service';
import {
  fakeAuthorizationRecord,
  fakeGoogleCertificateName,
} from '../utils/fake-google-cloud-port';
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
const IP = '34.120.0.7';
const HOST = 'shop.acme.dev';
const MINUTE = 60_000;

/** Google's refusal past a Certificate Manager quota, as the provider prints it. */
const QUOTA_REFUSAL =
  "Error creating Certificate: googleapi: Error 429: Quota exceeded for quota metric 'Certificates' and limit 'Certificates per project' of service 'certificatemanager.googleapis.com' for consumer 'project_number:123456789012'., rateLimitExceeded";

/** A host no DNS can ever answer, and Google's refusal of it at apply. */
const UNKNOWN_TLD = 'walk988.example.invalid';
const TLD_REFUSAL = `Error creating DnsAuthorization: googleapi: Error 400: Invalid argument: domain "${UNKNOWN_TLD}": unrecognized TLD, badRequest`;

type CloudView = {
  status: string;
  failure: string | null;
  servedBy: string | null;
  records: {
    validation: {
      name: string;
      type: string;
      value: string;
      seen: boolean;
    } | null;
    pointing: {
      name: string;
      type: string;
      value: string;
      seen: boolean;
      note: string;
    };
  } | null;
};

/**
 * "Domains" (T16): a Domain on a Cloud Run `web` is
 * a host rule on the Environment network's load balancer plus a
 * Certificate Manager certificate. Each add, edit, remove and Ask again is
 * a short Deployment that is a **Cloud run of the Environment network**,
 * listed on the Service through its "for Service" column (S14), applying
 * only the network's Domain blocks and URL map. The certificate poller
 * copies AWS's cadence over the Google port's certificate read (S5), driven
 * by `poll(now)`, never by timers. Against the Google fake, whose stand-in
 * `tofu` replays an empty plan and answers each Domain's certificate.
 */
describe('Domains on a Cloud Run web (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let cloudAccountId: string;
  let environmentId: string;
  let environmentNetworkId: string;
  let applicationId: string;
  let networkStateId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gdomain-'));
  const saved = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    process.env.CLOUDGATE_DIRECTORY = root;
    // Four runs at once, so what holds a run back is its Environment's rule
    // and never the pool being full.
    ctx = await createTestApp({
      overrideProviders: [
        {
          provide: CLOUD_RUN_SETTINGS,
          useValue: {
            resolveLimit: () => Promise.resolve(4),
            timeLimitMinutes: () => Promise.resolve(60),
          },
        },
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
        ipAddress: IP,
        urlMapName: 'cloudgate-urls',
        certificateMapName: 'cloudgate-certs',
      })
      .returning();
    environmentNetworkId = network.environmentNetworkId;
    const states = ctx.app.get(InfrastructureStatesService);
    networkStateId = (
      await states.create({ environmentNetworkId }, undefined, 'google')
    ).infrastructureStateId;
    applicationId = await serviceWithFirstDeploy('web');

    ctx.google.replayPlanFor('network', null);
    ctx.google.replayOutputsFor('network', null);
  });

  /** A `web` on Cloud Run whose first deploy finished: what Domains route to. */
  async function serviceWithFirstDeploy(name: string): Promise<string> {
    const [app] = await ctx.db
      .insert(application)
      .values({
        name,
        environmentId,
        configName: name,
        configKind: 'web',
        port: 8080,
        cloudAccountId,
        region: REGION,
      })
      .returning();
    await ctx.app
      .get(InfrastructureStatesService)
      .create({ applicationId: app.applicationId }, undefined, 'google');
    await ctx.db.insert(deployment).values({
      applicationId: app.applicationId,
      title: 'Deploy',
      status: 'done',
      logPath: nodePath.join(root, `${name}-first-deploy.log`),
      cloudRun: {
        kind: 'deploy',
        stateKey: `application:${app.applicationId}`,
        environmentId,
        touchesNetwork: false,
      },
    });
    return app.applicationId;
  }

  const addDomain = (body: Record<string, unknown> = {}) =>
    request(http)
      .post('/domains')
      .set('Cookie', cookie)
      .send({ applicationId, host: HOST, ...body });

  async function settled(deploymentId: string): Promise<Deployment> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const row = await deploymentOf(deploymentId);
      if (row && ['done', 'error', 'cancelled'].includes(row.status)) {
        return row;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('The Domain run never ended');
  }

  async function deploymentOf(deploymentId: string): Promise<Deployment> {
    const [row] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId));
    return row;
  }

  async function rowOf(domainId: string): Promise<Domain> {
    const [row] = await ctx.db
      .select()
      .from(domain)
      .where(eq(domain.domainId, domainId));
    return row;
  }

  async function viewOf(domainId: string): Promise<CloudView> {
    const res = await request(http)
      .get(`/applications/${applicationId}/domains`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const found = (res.body as { domainId: string; cloud: CloudView }[]).find(
      (one) => one.domainId === domainId,
    );
    return found!.cloud;
  }

  /** Adds the Domain and waits for its run; answers the row after it. */
  async function added(host = HOST): Promise<Domain> {
    const res = await addDomain({ host });
    expect(res.status).toBe(201);
    const { domainId, deploymentId } = res.body as {
      domainId: string;
      deploymentId: string;
    };
    expect((await settled(deploymentId)).status).toBe('done');
    return rowOf(domainId);
  }

  const applies = () =>
    ctx.google.calls.filter(
      (
        call,
      ): call is Extract<
        FakeGoogleCall,
        { method: 'plan' | 'apply' | 'destroy' }
      > => call.method === 'apply',
    );

  const poller = () => ctx.app.get(CloudDomainRuns);

  describe('refusals', () => {
    it('refuses what Google Cloud’s load balancer does not do, naming the field and the cloud', async () => {
      const off = await addDomain({ https: false });
      expect(off.status).toBe(400);
      expect((off.body as { message: string }).message).toBe(
        'Domains on Google Cloud are always HTTPS',
      );
      const strip = await addDomain({ path: '/api', stripPath: true });
      expect(strip.status).toBe(400);
      expect((strip.body as { message: string }).message).toBe(
        'stripPath: Strip path is not available on a Domain on Google Cloud',
      );
      expect(applies()).toHaveLength(0);
    });

    it('refuses a Domain before the Service has finished its first deploy', async () => {
      await ctx.db
        .delete(deployment)
        .where(eq(deployment.applicationId, applicationId));
      const res = await addDomain();
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        'has not finished its first deploy on Google Cloud',
      );
    });

    it('refuses a second Domain on a host, even by another path: a host is one certificate on Google Cloud', async () => {
      await added();
      const res = await addDomain({ path: '/api' });
      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toContain(
        'On Google Cloud a host is one Domain',
      );
    });
  });

  it('adds a Domain as a Cloud run of the Environment network, listed on the Service and the network, and shows the two records', async () => {
    const res = await addDomain();
    expect(res.status).toBe(201);
    const body = res.body as Domain & { deploymentId: string };
    expect(body).toMatchObject({
      host: HOST,
      https: true,
      cloudCertificateStatus: 'waiting-for-dns',
    });

    const run = await settled(body.deploymentId);
    expect(run).toMatchObject({
      status: 'done',
      title: `Add Domain ${HOST}`,
      applicationId: null,
      environmentNetworkId,
      forServiceId: applicationId,
      cloudRun: {
        kind: 'domain',
        stateKey: `network:${environmentNetworkId}`,
        environmentId,
        touchesNetwork: true,
      },
    });
    expect(await ctx.db.select().from(planTable)).toHaveLength(0);

    // Listed on the Service, and as the network's newest run.
    const history = await request(http)
      .get(`/applications/${applicationId}/deployments`)
      .set('Cookie', cookie);
    expect(history.status).toBe(200);
    expect(
      (history.body as Deployment[]).map((one) => one.deploymentId),
    ).toContain(body.deploymentId);
    const networks = await request(http)
      .get(`/environments/${environmentId}/networks`)
      .set('Cookie', cookie);
    expect(networks.status).toBe(200);
    expect(
      (networks.body as { lastRun: Deployment | null }[])[0].lastRun,
    ).toMatchObject({ deploymentId: body.deploymentId });

    // The network's state, only the Domain blocks and the URL map.
    const certificate = `cloudgate-${idKey(body.domainId)}`;
    expect(applies()).toEqual([
      expect.objectContaining({
        kind: 'network',
        stateId: networkStateId,
        targets: DOMAIN_RUN_TARGETS,
        domains: { [body.domainId]: { host: HOST, certificate } },
      }),
    ]);
    const log = fs.readFileSync(run.logPath, 'utf8');
    expect(log).toContain(`Requested a Google-managed certificate for ${HOST}`);

    const row = await rowOf(body.domainId);
    expect(row).toMatchObject({
      googleCertificateName: fakeGoogleCertificateName(PROJECT, certificate),
      validationRecord: fakeAuthorizationRecord(HOST),
      cloudCertificateStatus: 'waiting-for-dns',
    });
    expect(row.certificateRequestedAt).not.toBeNull();

    // The authorization CNAME and an A record to the fixed IP, unticked.
    const view = await viewOf(body.domainId);
    expect(view).toMatchObject({
      status: 'waiting-for-dns',
      servedBy: 'fixed-ip',
    });
    expect(view.records!.validation).toEqual({
      ...fakeAuthorizationRecord(HOST),
      seen: false,
    });
    expect(view.records!.pointing).toMatchObject({
      name: HOST,
      type: 'A',
      value: IP,
      seen: false,
    });
  });

  it('shows a bare name a plain A record to the fixed IP, with no warning', async () => {
    const row = await added('acme.dev');
    const { pointing } = (await viewOf(row.domainId)).records!;
    expect(pointing).toMatchObject({ type: 'A', value: IP });
    expect(pointing.note).not.toMatch(/ALIAS|bare|never/);
  });

  it('writes every Domain of the Environment in each run, so one Service’s run keeps another’s', async () => {
    const first = await added();
    const other = await serviceWithFirstDeploy('api');
    const res = await request(http)
      .post('/domains')
      .set('Cookie', cookie)
      .send({ applicationId: other, host: 'api.acme.dev', path: '/v1' });
    expect(res.status).toBe(201);
    const { domainId, deploymentId } = res.body as {
      domainId: string;
      deploymentId: string;
    };
    expect(await deploymentOf(deploymentId)).toMatchObject({
      forServiceId: other,
    });
    expect((await settled(deploymentId)).status).toBe('done');
    expect(Object.keys(applies().at(-1)!.domains!).sort()).toEqual(
      [first.domainId, domainId].sort(),
    );
  });

  it('moves the certificate through Waiting for DNS, Checking and Live on what Certificate Manager and DNS answer', async () => {
    const row = await added();
    const requested = Date.parse(row.certificateRequestedAt!);
    const validation = row.validationRecord!;
    ctx.google.calls.length = 0;

    // Nothing in DNS yet: still waiting, and Certificate Manager was asked.
    await poller().poll(new Date(requested + MINUTE));
    expect((await rowOf(row.domainId)).cloudCertificateStatus).toBe(
      'waiting-for-dns',
    );
    expect(ctx.google.calls).toContainEqual({
      method: 'certificate',
      impersonated: true,
      projectId: PROJECT,
      name: row.googleCertificateName,
    });

    // Asked again before a minute has passed: not due.
    ctx.google.calls.length = 0;
    await poller().poll(new Date(requested + MINUTE + 20_000));
    expect(
      ctx.google.calls.filter((call) => call.method === 'certificate'),
    ).toHaveLength(0);

    // The CNAME and the host's A record are in DNS: checking, both ticked.
    ctx.google.dnsAnswers(validation.name, { cnames: [validation.value] });
    ctx.google.dnsAnswers(HOST, { addresses: [IP] });
    await poller().poll(new Date(requested + 3 * MINUTE));
    expect(await viewOf(row.domainId)).toMatchObject({
      status: 'checking',
      records: { validation: { seen: true }, pointing: { seen: true } },
    });

    // Active: live at once, its map entry already serving it; no other run.
    const runs = (await ctx.db.select().from(deployment)).length;
    ctx.google.certificateAnswers(row.googleCertificateName!, {
      state: 'ACTIVE',
      reason: null,
    });
    await poller().poll(new Date(requested + 5 * MINUTE));
    expect((await viewOf(row.domainId)).status).toBe('live');
    expect(await ctx.db.select().from(deployment)).toHaveLength(runs);
  });

  it('fails a certificate still provisioning after 72 hours', async () => {
    const row = await added();
    await poller().poll(
      new Date(Date.parse(row.certificateRequestedAt!) + 72 * 60 * MINUTE),
    );
    const view = await viewOf(row.domainId);
    expect(view.status).toBe('failed');
    expect(view.failure).toContain('72 hours');
  });

  it("fails on Google's refusal, and Ask again makes a new certificate under a new name, keeping the authorization", async () => {
    const row = await added();
    ctx.google.certificateAnswers(row.googleCertificateName!, {
      state: 'FAILED',
      reason: 'CAA',
    });
    await poller().poll(
      new Date(Date.parse(row.certificateRequestedAt!) + MINUTE),
    );
    expect((await viewOf(row.domainId)).failure).toContain('CAA');

    const res = await request(http)
      .post(`/domains/${row.domainId}/ask-again`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const { deploymentId } = res.body as { deploymentId: string };
    expect((await settled(deploymentId)).status).toBe('done');
    const certificate = `cloudgate-${idKey(row.domainId)}-2`;
    expect(await rowOf(row.domainId)).toMatchObject({
      certificateAttempt: 2,
      cloudCertificateStatus: 'waiting-for-dns',
      certificateFailure: null,
      googleCertificateName: fakeGoogleCertificateName(PROJECT, certificate),
      validationRecord: row.validationRecord,
    });
    expect(applies().at(-1)!.domains).toEqual({
      [row.domainId]: { host: HOST, certificate },
    });
  });

  it("refuses a Domain past Google's quota, naming the quota from Google's refusal", async () => {
    ctx.google.failApplyFor('network', QUOTA_REFUSAL);
    const res = await addDomain();
    expect(res.status).toBe(201);
    const { domainId, deploymentId } = res.body as {
      domainId: string;
      deploymentId: string;
    };
    const run = await settled(deploymentId);
    expect(run.status).toBe('error');
    expect(run.description).toContain('"Certificates per project"');
    expect(fs.readFileSync(run.logPath, 'utf8')).toContain(
      '"Certificates per project"',
    );
    const view = await viewOf(domainId);
    expect(view.status).toBe('failed');
    expect(view.failure).toContain('"Certificates per project"');
    expect(view.failure).toContain('Quotas');
  });

  it("fails each Domain the run could not make on any refusal of Google's, in the run's own words, leaving a Domain made before as it is", async () => {
    const made = await added();
    ctx.google.failApplyFor('network', TLD_REFUSAL);
    const res = await addDomain({ host: UNKNOWN_TLD });
    expect(res.status).toBe(201);
    const { domainId, deploymentId } = res.body as {
      domainId: string;
      deploymentId: string;
    };
    const run = await settled(deploymentId);
    expect(run.status).toBe('error');
    expect(run.description).toContain('unrecognized TLD');

    const view = await viewOf(domainId);
    expect(view.status).toBe('failed');
    expect(view.failure).toBe(run.description);
    expect(fs.readFileSync(run.logPath, 'utf8')).toContain(
      `🔐 ${UNKNOWN_TLD}: ${run.description}`,
    );
    expect(await rowOf(made.domainId)).toMatchObject({
      cloudCertificateStatus: 'waiting-for-dns',
      certificateFailure: null,
      googleCertificateName: made.googleCertificateName,
    });

    // The poller never moves a failed Domain on.
    await poller().poll(
      new Date(Date.parse(made.certificateRequestedAt!) + 5 * MINUTE),
    );
    expect((await viewOf(domainId)).status).toBe('failed');
  });

  it('brings a refused Domain back to waiting for DNS on Ask again, on a new host, and on a later run that makes it', async () => {
    /** A Domain added while Google refuses the network's apply. */
    const refused = async (host: string): Promise<string> => {
      ctx.google.failApplyFor('network', TLD_REFUSAL);
      const res = await addDomain({ host });
      const { domainId, deploymentId } = res.body as {
        domainId: string;
        deploymentId: string;
      };
      expect((await settled(deploymentId)).status).toBe('error');
      expect((await viewOf(domainId)).status).toBe('failed');
      ctx.google.passApplyFor('network');
      return domainId;
    };
    const waiting = {
      cloudCertificateStatus: 'waiting-for-dns',
      certificateFailure: null,
      googleCertificateName: expect.any(String) as unknown,
    };

    const asked = await refused('one.acme.dev');
    const again = await request(http)
      .post(`/domains/${asked}/ask-again`)
      .set('Cookie', cookie);
    expect(again.status).toBe(200);
    expect(
      (await settled((again.body as { deploymentId: string }).deploymentId))
        .status,
    ).toBe('done');
    expect(await rowOf(asked)).toMatchObject(waiting);

    const edited = await refused(UNKNOWN_TLD);
    const edit = await request(http)
      .patch(`/domains/${edited}`)
      .set('Cookie', cookie)
      .send({ host: 'two.acme.dev' });
    expect(edit.status).toBe(200);
    expect(
      (await settled((edit.body as { deploymentId: string }).deploymentId))
        .status,
    ).toBe('done');
    expect(await rowOf(edited)).toMatchObject(waiting);

    const later = await refused('three.acme.dev');
    await added('four.acme.dev');
    expect(await rowOf(later)).toMatchObject(waiting);
  });

  it('removes a Domain in a run of the network, naming the records left at the DNS provider', async () => {
    const row = await added();
    const res = await request(http)
      .delete(`/domains/${row.domainId}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      deploymentId: string;
      dnsRecordsLeft: { name: string; type: string; value: string }[];
      message: string;
    };
    expect(body.dnsRecordsLeft).toEqual([
      fakeAuthorizationRecord(HOST),
      { name: HOST, type: 'A', value: IP },
    ]);
    expect(body.message).toContain('Removed from Google Cloud');
    expect(body.message).toContain('never writes DNS');

    expect(await settled(body.deploymentId)).toMatchObject({
      status: 'done',
      environmentNetworkId,
      forServiceId: applicationId,
    });
    expect(await ctx.db.select().from(domain)).toHaveLength(0);
    // The definition holds no Domain, so the targeted blocks destroy it.
    expect(applies().at(-1)).toMatchObject({
      targets: DOMAIN_RUN_TARGETS,
      domains: {},
    });
  });

  it("holds back the Environment's other Cloud runs while it runs", async () => {
    const release = ctx.google.holdSignIn();
    const res = await addDomain();
    expect(res.status).toBe(201);
    const { deploymentId } = res.body as { deploymentId: string };
    for (let attempt = 0; attempt < 400; attempt++) {
      if ((await deploymentOf(deploymentId)).status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await deploymentOf(deploymentId)).status).toBe('running');

    // A read of a Service's own state in the same Environment waits.
    let started = false;
    const stateKey = `application:${applicationId}`;
    ctx.app.get(CloudReadWorks).register(stateKey, () => {
      started = true;
      return Promise.resolve(null);
    });
    const reading = ctx.app
      .get(CloudRunsService)
      .read({ stateKey, environmentId, touchesNetwork: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(started).toBe(false);

    release();
    expect((await settled(deploymentId)).status).toBe('done');
    await reading;
    expect(started).toBe(true);
  });

  it('adds a host another Organization holds on its own Google Cloud web: a host is one Domain inside an Organization, not across the instance', async () => {
    // ADR-0060: the other Domain's certificate and authorization
    // are in that Organization's own project, and DNS decides who serves it.
    const { rows } = await ctx.db.$client.query<{ id: string }>(
      'select id from "user" limit 1',
    );
    const [neighbour] = await ctx.db
      .insert(organization)
      .values({ name: 'Neighbour', ownerId: rows[0].id, createdAt: new Date() })
      .returning({ id: organization.id });
    const key = makeSigningKey();
    const [account] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId: neighbour.id,
        name: 'Their Google',
        cloud: 'gcp',
        cloudId: 'their-project',
        ...GOOGLE_COLUMNS,
        signingKey: key.privateKey,
        signingKeyId: key.keyId,
        signingPublicKey: JSON.stringify(key.publicJwk),
        policyVersion: 1,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    const [theirs] = await ctx.db
      .insert(project)
      .values({ name: 'theirs', organizationId: neighbour.id } as never)
      .returning();
    const [env] = await ctx.db
      .insert(environment)
      .values({
        name: 'production',
        projectId: theirs.projectId,
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: account.cloudAccountId,
          region: REGION,
        } as never,
      })
      .returning();
    const [app] = await ctx.db
      .insert(application)
      .values({
        name: 'their-web',
        environmentId: env.environmentId,
        configName: 'their-web',
        configKind: 'web',
        port: 8080,
        cloudAccountId: account.cloudAccountId,
        region: REGION,
      })
      .returning();
    await ctx.db.insert(domain).values({
      host: HOST,
      applicationId: app.applicationId,
      https: true,
      cloudCertificateStatus: 'waiting-for-dns',
    });

    const row = await added();
    expect(row).toMatchObject({ host: HOST, path: '/' });
    expect(await ctx.db.select().from(domain)).toHaveLength(2);
  });
});
