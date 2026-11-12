import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  ONE_DOMAIN_REFUSAL,
  STATIC_DOMAIN_ADDRESSES,
} from '../../src/cloud-accounts/aws/definitions/static-definition';
import { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import {
  application,
  certificateDeletion,
  cloudAccount,
  deployment,
  domain,
  plan as planTable,
} from '../../src/db/schema';
import type { Deployment, Domain } from '../../src/db/schema';
import { CloudRunsService } from '../../src/deployment-queue/cloud-runs.service';
import { CloudDomainRuns } from '../../src/project-config/applier/cloud-domain-runs.service';
import {
  DOMAIN_STILL_SPREADING,
  STATIC_SPREAD_CLOCK,
} from '../../src/project-config/applier/static-spread';
import type { SpreadClock } from '../../src/project-config/applier/static-spread';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import {
  fakeCertificateArn,
  fakeValidationRecord,
} from '../utils/fake-cloud-port';
import type { FakeCloudCall } from '../utils/fake-cloud-port';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const DISTRIBUTION_ID = 'E2QWRUHAPOMQZL';
const DISTRIBUTION = 'd111111abcdef8.cloudfront.net';
const HOST = 'docs.example.com';
const MINUTE = 60_000;

/** CloudFront's refusal of the distribution's update, as the provider prints it. */
const CLOUDFRONT_REFUSAL =
  "updating CloudFront Distribution (E2QWRUHAPOMQZL): operation error CloudFront: UpdateDistribution, https response error StatusCode: 400, RequestID: 9d1e4b7a, InvalidViewerCertificate: The specified SSL certificate doesn't exist, isn't in us-east-1 region, isn't valid, or doesn't include a valid certificate chain.";

type CloudView = {
  status: string;
  servedBy: string | null;
  loadBalancer: string | null;
  records: {
    validation: { name: string; value: string; seen: boolean } | null;
    pointing: {
      name: string;
      type: string;
      value: string;
      seen: boolean;
      note: string;
    };
  } | null;
};

/** The wait's clock, moved by hand: a sleep moves it on at once. */
class HandClock implements SpreadClock {
  at = Date.UTC(2026, 9, 17, 9, 0, 0);
  now(): number {
    return this.at;
  }
  sleep(ms: number): Promise<void> {
    this.at += ms;
    return Promise.resolve();
  }
}

/**
 * A Domain on a `static` site on AWS follows a cloud `web`'s rules
 * on the site's CloudFront distribution instead of a load balancer:
 * its ACM certificate is requested in `us-east-1` whatever the Environment's
 * region, and once issued a queued Domain Deployment adds the host as the
 * distribution's alternate domain name and waits for CloudFront to read
 * `Deployed`, at most 30 minutes (a hand clock). Against the fake cloud
 * port; the poller is driven by `poll(now)`, never by timers.
 */
describe('Domains on a static site on AWS (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let applicationId: string;
  let stateId: string;
  const clock = new HandClock();
  const root = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), 'cloudgate-static-domain-'),
  );
  const saved = process.env.CLOUDGATE_DIRECTORY;

  const execMock = withArgvExec({
    execAsync: jest.fn(
      (command: string) =>
        new Promise((resolve, reject) => {
          exec(command, { shell: '/bin/bash' }, (error, stdout, stderr) =>
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
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: STATIC_SPREAD_CLOCK, useValue: clock },
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
      .send({ name: 'docs' });
    const projectId = (project.body as { projectId: string }).projectId;

    const [account] = await ctx.db
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
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId,
        name: 'production',
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: account.cloudAccountId,
          region: REGION,
        },
      });
    expect(env.status).toBe(201);
    const environmentId = (env.body as { environmentId: string }).environmentId;

    // A site its create's Cloud run has made: no Environment network.
    const [app] = await ctx.db
      .insert(application)
      .values({
        name: 'docs',
        environmentId,
        configName: 'docs',
        configKind: 'static',
        buildType: 'static',
        cloudAccountId: account.cloudAccountId,
        region: REGION,
        cloudBucketName: `docs-p4x8m2rt-${ACCOUNT}-${REGION}-an`,
        cloudDistributionId: DISTRIBUTION_ID,
        cloudDistributionDomain: DISTRIBUTION,
      })
      .returning();
    applicationId = app.applicationId;
    stateId = (
      await ctx.app
        .get(InfrastructureStatesService)
        .create({ applicationId: app.applicationId })
    ).infrastructureStateId;
  });

  const addDomain = (body: Record<string, unknown> = {}) =>
    request(http)
      .post('/domains')
      .set('Cookie', cookie)
      .send({ applicationId, host: HOST, ...body });

  async function settled(deploymentId: string): Promise<Deployment> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      if (row && ['done', 'error', 'cancelled'].includes(row.status)) {
        return row;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('The Domain run never ended');
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

  /** Has ACM issue the certificate, and answers the run that attaches it. */
  async function issued(row: Domain): Promise<Deployment> {
    ctx.cloud.acmAnswers(row.acmCertificateArn!, { status: 'ISSUED' });
    await poller().poll(
      new Date(Date.parse(row.certificateRequestedAt!) + 5 * MINUTE),
    );
    const [attach] = await ctx.db
      .select()
      .from(deployment)
      .where(
        and(
          eq(deployment.applicationId, applicationId),
          eq(deployment.title, `Attach the certificate of ${row.host}`),
        ),
      );
    return settled(attach.deploymentId);
  }

  const applies = () =>
    ctx.cloud.calls.filter(
      (call): call is Extract<FakeCloudCall, { method: 'apply' }> =>
        call.method === 'apply',
    );

  const poller = () => ctx.app.get(CloudDomainRuns);

  describe('refusals', () => {
    it.each([
      [{ forwardAuthEnabled: true }, 'forwardAuthEnabled'],
      [{ middlewares: ['redirect-to-https@file'] }, 'middlewares'],
      [{ customEntrypoint: 'websecure' }, 'customEntrypoint'],
      [{ internalPath: '/v1' }, 'internalPath'],
      [{ https: true, certificateType: 'letsencrypt' }, "Let's Encrypt"],
      [{ https: false }, 'Domains on AWS are always HTTPS'],
      [{ path: '/guide' }, 'CloudFront has no rule by path'],
    ])('refuses %j, naming it', async (body, named) => {
      const res = await addDomain(body);
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(named);
      expect(await ctx.db.select().from(domain)).toHaveLength(0);
      expect(applies()).toHaveLength(0);
    });

    it('refuses a second Domain: CloudFront serves one certificate per distribution', async () => {
      await added();
      const res = await addDomain({ host: 'www.example.com' });
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        ONE_DOMAIN_REFUSAL,
      );
      expect(await ctx.db.select().from(domain)).toHaveLength(1);
    });

    it('refuses a Domain before its distribution is made', async () => {
      await ctx.db
        .update(application)
        .set({ cloudDistributionId: null, cloudDistributionDomain: null })
        .where(eq(application.applicationId, applicationId));
      const res = await addDomain();
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        'CloudFront distribution is not made yet',
      );
    });
  });

  it('adds a Domain in a short Deployment of its own, its certificate requested in us-east-1', async () => {
    const res = await addDomain();
    expect(res.status).toBe(201);
    const body = res.body as Domain & { deploymentId: string };
    expect(body).toMatchObject({
      host: HOST,
      https: true,
      certificateType: 'none',
      cloudCertificateStatus: 'waiting-for-dns',
    });

    const run = await settled(body.deploymentId);
    expect(run).toMatchObject({
      status: 'done',
      applicationId,
      title: `Add Domain ${HOST}`,
      cloudRun: expect.objectContaining({ kind: 'domain' }) as unknown,
    });
    expect(await ctx.db.select().from(planTable)).toHaveLength(0);

    // The certificate and the distribution only, in the site's own state;
    // the host is not on the distribution until its certificate is issued.
    const key = `${body.domainId}-1`;
    expect(applies()).toEqual([
      expect.objectContaining({
        stateId,
        targets: [...STATIC_DOMAIN_ADDRESSES],
        domainCertificates: [key],
        distributionAliases: [],
      }),
    ]);
    const row = await rowOf(body.domainId);
    expect(row).toMatchObject({
      acmCertificateArn: fakeCertificateArn('us-east-1', ACCOUNT, key),
      validationRecord: fakeValidationRecord(key, HOST),
      cloudCertificateStatus: 'waiting-for-dns',
    });
    const log = fs.readFileSync(run.logPath, 'utf8');
    expect(log).toContain(`Requested an ACM certificate for ${HOST}`);
    expect(log).toContain('its certificate in us-east-1');

    // The records to copy point the host at the distribution.
    const view = await viewOf(body.domainId);
    expect(view).toMatchObject({
      status: 'waiting-for-dns',
      servedBy: 'cloudfront',
      loadBalancer: DISTRIBUTION,
    });
    expect(view.records!.pointing).toMatchObject({
      name: HOST,
      type: 'CNAME',
      value: DISTRIBUTION,
      seen: false,
    });
    expect(view.records!.pointing.note).toContain(
      'the CloudFront distribution',
    );
  });

  it('moves the certificate through waiting for DNS, checking and live, asking ACM in us-east-1', async () => {
    const row = await added();
    const requested = Date.parse(row.certificateRequestedAt!);
    const validation = row.validationRecord!;
    ctx.cloud.calls.length = 0;

    await poller().poll(new Date(requested + MINUTE));
    expect((await rowOf(row.domainId)).cloudCertificateStatus).toBe(
      'waiting-for-dns',
    );
    expect(ctx.cloud.calls).toContainEqual({
      method: 'acmDescribeCertificate',
      region: 'us-east-1',
      certificateArn: row.acmCertificateArn,
    });

    ctx.cloud.dnsAnswers(validation.name, { cnames: [validation.value] });
    ctx.cloud.dnsAnswers(HOST, { cnames: [`${DISTRIBUTION}.`] });
    await poller().poll(new Date(requested + 3 * MINUTE));
    expect(await viewOf(row.domainId)).toMatchObject({
      status: 'checking',
      records: { validation: { seen: true }, pointing: { seen: true } },
    });

    // Issued: a queued Domain Deployment puts the host on the distribution
    // with its certificate, and waits for CloudFront to spread it.
    ctx.cloud.calls.length = 0;
    const attach = await issued(row);
    expect(attach.status).toBe('done');
    expect(applies()).toEqual([
      expect.objectContaining({
        targets: [...STATIC_DOMAIN_ADDRESSES],
        domainCertificates: [`${row.domainId}-1`],
        distributionAliases: [HOST],
      }),
    ]);
    const methods = ctx.cloud.calls.map((call) => call.method);
    expect(methods.lastIndexOf('cloudFrontDistributionStatus')).toBeGreaterThan(
      methods.indexOf('apply'),
    );
    const log = fs.readFileSync(attach.logPath, 'utf8');
    expect(log).toContain('[Spread] Deployed after');
    expect(log).toContain(`The certificate of ${HOST} is on CloudFront: live`);
    expect((await viewOf(row.domainId)).status).toBe('live');
  });

  describe('an attach CloudFront refuses while the host points at another distribution', () => {
    const REFUSED =
      'updating CloudFront Distribution (E2QWRUHAPOMQZL): operation error CloudFront: UpdateDistribution, https response error StatusCode: 409, RequestID: 5c2e035a, CNAMEAlreadyExists: One or more aliases specified for the distribution includes an incorrectly configured DNS record that points to another CloudFront distribution.';

    const attachRuns = () =>
      ctx.db
        .select()
        .from(deployment)
        .where(
          and(
            eq(deployment.applicationId, applicationId),
            eq(deployment.title, `Attach the certificate of ${HOST}`),
          ),
        )
        .orderBy(deployment.createdAt);

    it('ends saying which record to point where, and attaches again by itself once the host points at the distribution', async () => {
      const row = await added();
      // The host still names the distribution of an earlier site.
      ctx.cloud.dnsAnswers(HOST, {
        cnames: ['d999999oldsite.cloudfront.net.'],
      });
      ctx.cloud.failRunFor('static', REFUSED);
      const refused = await issued(row);
      expect(refused.status).toBe('error');
      expect(refused.description).toContain(
        `${HOST} still points at another CloudFront distribution. Point its CNAME at ${DISTRIBUTION}; Cloudgate attaches the certificate again once it does`,
      );
      expect((await rowOf(row.domainId)).cloudCertificateStatus).toBe(
        'checking',
      );
      ctx.cloud.passRunFor('static');
      const requested = Date.parse(row.certificateRequestedAt!);

      // Still pointing elsewhere: nothing is queued.
      await poller().poll(new Date(requested + 10 * MINUTE));
      expect(await attachRuns()).toHaveLength(1);

      // The operator fixed the record: the next tick queues the attach.
      ctx.cloud.dnsAnswers(HOST, { cnames: [`${DISTRIBUTION}.`] });
      await poller().poll(new Date(requested + 12 * MINUTE));
      const runs = await attachRuns();
      expect(runs).toHaveLength(2);
      expect((await settled(runs[1].deploymentId)).status).toBe('done');
      expect(applies().at(-1)).toMatchObject({ distributionAliases: [HOST] });
      expect((await rowOf(row.domainId)).cloudCertificateStatus).toBe('live');
    });

    it('queues the attach again once per change of the record, not every tick', async () => {
      const row = await added();
      ctx.cloud.dnsAnswers(HOST, {
        cnames: ['d999999oldsite.cloudfront.net.'],
      });
      ctx.cloud.failRunFor('static', REFUSED);
      await issued(row);
      const requested = Date.parse(row.certificateRequestedAt!);
      await poller().poll(new Date(requested + 10 * MINUTE));

      // Pointed at the distribution, but CloudFront still refuses.
      ctx.cloud.dnsAnswers(HOST, { cnames: [`${DISTRIBUTION}.`] });
      await poller().poll(new Date(requested + 12 * MINUTE));
      const runs = await attachRuns();
      expect(runs).toHaveLength(2);
      expect((await settled(runs[1].deploymentId)).status).toBe('error');
      await poller().poll(new Date(requested + 14 * MINUTE));
      await poller().poll(new Date(requested + 16 * MINUTE));
      expect(await attachRuns()).toHaveLength(2);
    });

    it('queues nothing while a Domain run of the site is still to run', async () => {
      const row = await added();
      ctx.cloud.dnsAnswers(HOST, {
        cnames: ['d999999oldsite.cloudfront.net.'],
      });
      ctx.cloud.failRunFor('static', REFUSED);
      await issued(row);
      const requested = Date.parse(row.certificateRequestedAt!);
      await poller().poll(new Date(requested + 10 * MINUTE));
      ctx.cloud.passRunFor('static');
      // The operator edited the Domain at once: its run will attach it.
      ctx.cloud.hangFor('static');
      const edit = await request(http)
        .patch(`/domains/${row.domainId}`)
        .set('Cookie', cookie)
        .send({ host: HOST });
      expect(edit.status).toBe(200);
      ctx.cloud.dnsAnswers(HOST, { cnames: [`${DISTRIBUTION}.`] });
      await poller().poll(new Date(requested + 12 * MINUTE));
      expect(await attachRuns()).toHaveLength(1);
      ctx.app
        .get(CloudRunsService)
        .cancel((edit.body as { deploymentId: string }).deploymentId);
      await settled((edit.body as { deploymentId: string }).deploymentId);
      ctx.cloud.passRunFor('static');
    });
  });

  it("fails a Domain whose certificate the run could not make on CloudFront's refusal, in the run's own words", async () => {
    ctx.cloud.failRunFor('static', CLOUDFRONT_REFUSAL);
    const res = await addDomain();
    expect(res.status).toBe(201);
    const { domainId, deploymentId } = res.body as {
      domainId: string;
      deploymentId: string;
    };
    const run = await settled(deploymentId);
    expect(run.status).toBe('error');
    expect(run.description).toContain('InvalidViewerCertificate');

    const failed = await rowOf(domainId);
    expect(failed).toMatchObject({
      cloudCertificateStatus: 'failed',
      certificateFailure: run.description,
      acmCertificateArn: null,
    });
    expect((await viewOf(domainId)).status).toBe('failed');
    expect(fs.readFileSync(run.logPath, 'utf8')).toContain(
      `🔐 ${HOST}: ${run.description}`,
    );
    // Not a Domain run left unfinished: a site's Apply queues nothing for it.
    expect(await poller().afterSiteApplied(applicationId)).toBeNull();

    ctx.cloud.passRunFor('static');
    const again = await request(http)
      .post(`/domains/${domainId}/ask-again`)
      .set('Cookie', cookie);
    expect(again.status).toBe(200);
    expect(
      (await settled((again.body as { deploymentId: string }).deploymentId))
        .status,
    ).toBe('done');
    expect(await rowOf(domainId)).toMatchObject({
      cloudCertificateStatus: 'waiting-for-dns',
      certificateFailure: null,
      acmCertificateArn: fakeCertificateArn(
        'us-east-1',
        ACCOUNT,
        `${domainId}-2`,
      ),
    });
  });

  it('ends a Domain Deployment CloudFront has not spread in 30 minutes done, saying it is still spreading', async () => {
    const row = await added();
    ctx.cloud.holdDistribution(Infinity);
    const attach = await issued(row);
    expect(attach.status).toBe('done');
    const log = fs.readFileSync(attach.logPath, 'utf8');
    expect(log).toContain(DOMAIN_STILL_SPREADING);
    expect(log).not.toContain('[Spread] Deployed after');
    expect((await viewOf(row.domainId)).status).toBe('live');
  });

  it('removes a Domain in its own run, naming the DNS records left behind', async () => {
    const row = await added();
    await issued(row);
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
      row.validationRecord,
      { name: HOST, type: 'CNAME', value: DISTRIBUTION },
    ]);
    expect(body.message).toContain('never writes DNS');

    const run = await settled(body.deploymentId);
    expect(run.status).toBe('done');
    expect(await ctx.db.select().from(domain)).toHaveLength(0);
    // The host comes off the distribution; the certificate leaves the
    // state first, so the run never waits on ACM, and goes from ACM
    // once CloudFront no longer serves it.
    expect(applies().at(-1)).toMatchObject({
      targets: [...STATIC_DOMAIN_ADDRESSES],
      domainCertificates: [],
      distributionAliases: [],
      forgotten: [`aws_acm_certificate.domain["${row.domainId}-1"]`],
    });
    expect(ctx.cloud.acmDeleted.has(row.acmCertificateArn!)).toBe(true);
    expect(await ctx.db.select().from(certificateDeletion)).toEqual([]);
    expect(fs.readFileSync(run.logPath, 'utf8')).toContain(
      `The certificate of ${HOST} is deleted from ACM`,
    );
  });

  it('ends a removal done while ACM still calls the certificate in use, and deletes it once ACM lets go', async () => {
    const row = await added();
    await issued(row);
    const arn = row.acmCertificateArn!;
    // CloudFront dropped it; ACM's in-use record trails by 20–40 minutes.
    ctx.cloud.acmInUseFor(arn, 2);
    const res = await request(http)
      .delete(`/domains/${row.domainId}`)
      .set('Cookie', cookie);
    const run = await settled(
      (res.body as { deploymentId: string }).deploymentId,
    );

    expect(run.status).toBe('done');
    expect(fs.readFileSync(run.logPath, 'utf8')).toContain(
      `ACM still calls the certificate of ${HOST} in use`,
    );
    expect(ctx.cloud.acmDeleted.has(arn)).toBe(false);
    expect(await ctx.db.select().from(certificateDeletion)).toEqual([
      expect.objectContaining({
        certificateArn: arn,
        region: 'us-east-1',
        stateId,
        host: HOST,
      }),
    ]);

    // The poller asks ACM again about once a minute, outside the queue.
    const now = Date.now();
    await poller().poll(new Date(now + MINUTE));
    expect(ctx.cloud.acmDeleted.has(arn)).toBe(false);
    await poller().poll(new Date(now + 30_000 + MINUTE));
    expect(ctx.cloud.acmDeleted.has(arn)).toBe(false);
    await poller().poll(new Date(now + 2 * MINUTE + 1000));
    expect(ctx.cloud.acmDeleted.has(arn)).toBe(true);
    expect(await ctx.db.select().from(certificateDeletion)).toEqual([]);
    const deletes = ctx.cloud.calls.filter(
      (call) => call.method === 'acmDeleteCertificate',
    );
    expect(deletes).toEqual([
      {
        method: 'acmDeleteCertificate',
        region: 'us-east-1',
        certificateArn: arn,
      },
      {
        method: 'acmDeleteCertificate',
        region: 'us-east-1',
        certificateArn: arn,
      },
      {
        method: 'acmDeleteCertificate',
        region: 'us-east-1',
        certificateArn: arn,
      },
    ]);
  });

  describe('a hand change on the distribution', () => {
    const NO_CHANGE = { format_version: '1.2', resource_changes: [] };

    it('refuses a Domain run whose plan would put back a hand change, naming it, and changes nothing', async () => {
      // The OAC taken off the origin by hand.
      ctx.cloud.replayPlanFor('static', 'static-oac-drift');
      const res = await addDomain();
      const { domainId, deploymentId } = res.body as {
        domainId: string;
        deploymentId: string;
      };
      const run = await settled(deploymentId);

      expect(run.status).toBe('error');
      expect(run.description).toContain(
        'aws_cloudfront_distribution.site was changed in AWS by hand (origin.0.origin_access_control_id)',
      );
      expect(run.description).toContain('Check for changes');
      const log = fs.readFileSync(run.logPath, 'utf8');
      expect(log).not.toContain('Apply complete');
      // The run's own stop, not CloudFront's refusal: the Domain still waits.
      expect(await rowOf(domainId)).toMatchObject({
        acmCertificateArn: null,
        cloudCertificateStatus: 'waiting-for-dns',
        certificateFailure: null,
      });
    });

    it("sets the distribution's aliases and certificate as the Domain says, though a failed run left the state ahead of AWS", async () => {
      const row = await added();
      // CloudFront refused the attach (CNAMEAlreadyExists) after the state
      // had taken the alias: the refresh moves it back, the plan sets it.
      const distribution = (aliases: string[]) => ({
        aliases,
        viewer_certificate: [
          aliases.length > 0
            ? { acm_certificate_arn: row.acmCertificateArn }
            : { cloudfront_default_certificate: true },
        ],
      });
      const change = (before: unknown, after: unknown) => ({
        address: 'aws_cloudfront_distribution.site',
        mode: 'managed',
        type: 'aws_cloudfront_distribution',
        name: 'site',
        change: {
          actions: ['update'],
          before,
          after,
          after_unknown: {},
          before_sensitive: {},
          after_sensitive: {},
        },
      });
      ctx.cloud.replayShowFor('static', {
        format_version: '1.2',
        resource_drift: [change(distribution([HOST]), distribution([]))],
        resource_changes: [change(distribution([]), distribution([HOST]))],
      });
      expect((await issued(row)).status).toBe('done');
      expect((await rowOf(row.domainId)).cloudCertificateStatus).toBe('live');
    });

    it("queues the Domain's run again once the site's Apply has put the hand change back", async () => {
      ctx.cloud.replayPlanFor('static', 'static-oac-drift');
      const res = await addDomain();
      const { domainId, deploymentId } = res.body as {
        domainId: string;
        deploymentId: string;
      };
      expect((await settled(deploymentId)).status).toBe('error');

      // The Apply put the OAC back: the site's next plan has no drift.
      ctx.cloud.replayShowFor('static', NO_CHANGE);
      const again = await poller().afterSiteApplied(applicationId);
      expect(again).not.toBeNull();
      const run = await settled(again!);
      expect(run).toMatchObject({
        status: 'done',
        title: `Finish the Domain ${HOST}`,
      });
      expect(await rowOf(domainId)).toMatchObject({
        cloudCertificateStatus: 'waiting-for-dns',
        acmCertificateArn: fakeCertificateArn(
          'us-east-1',
          ACCOUNT,
          `${domainId}-1`,
        ),
      });
    });

    it('queues nothing after an Apply when the Domain is where its runs left it', async () => {
      const row = await added();
      expect(await poller().afterSiteApplied(applicationId)).toBeNull();
      await issued(row);
      expect(await poller().afterSiteApplied(applicationId)).toBeNull();
    });

    it("queues the attach again when the Apply came between ACM's issue and the attach", async () => {
      const row = await added();
      ctx.cloud.replayPlanFor('static', 'static-oac-drift');
      expect((await issued(row)).status).toBe('error');
      ctx.cloud.replayShowFor('static', NO_CHANGE);
      const again = await poller().afterSiteApplied(applicationId);
      expect((await settled(again!)).status).toBe('done');
      expect(applies().at(-1)).toMatchObject({
        distributionAliases: [HOST],
      });
      expect((await rowOf(row.domainId)).cloudCertificateStatus).toBe('live');
    });
  });

  it('edits the Domain to a new host with a new certificate, the old host off the distribution until it is issued', async () => {
    const row = await added();
    await issued(row);
    const res = await request(http)
      .patch(`/domains/${row.domainId}`)
      .set('Cookie', cookie)
      .send({ host: 'guide.example.com' });
    expect(res.status).toBe(200);
    const { deploymentId } = res.body as { deploymentId: string };
    expect((await settled(deploymentId)).status).toBe('done');
    expect(await rowOf(row.domainId)).toMatchObject({
      host: 'guide.example.com',
      certificateAttempt: 2,
      cloudCertificateStatus: 'waiting-for-dns',
      acmCertificateArn: fakeCertificateArn(
        'us-east-1',
        ACCOUNT,
        `${row.domainId}-2`,
      ),
    });
    expect(applies().at(-1)).toMatchObject({
      domainCertificates: [`${row.domainId}-2`],
      distributionAliases: [],
      forgotten: [`aws_acm_certificate.domain["${row.domainId}-1"]`],
    });
    expect(ctx.cloud.acmDeleted.has(row.acmCertificateArn!)).toBe(true);
  });
});
