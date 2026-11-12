import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { DOMAIN_ADDRESSES } from '../../src/cloud-accounts/aws/definitions/web-definition';
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
} from '../../src/db/schema';
import type { Deployment, Domain } from '../../src/db/schema';
import { CloudRunsService } from '../../src/deployment-queue/cloud-runs.service';
import { CloudDomainRuns } from '../../src/project-config/applier/cloud-domain-runs.service';
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
const ALB = `cg-1234567890.${REGION}.elb.amazonaws.com`;
const HOST = 'shop.example.com';
const MINUTE = 60_000;

/** The load balancer's refusal of a Domain's listener rule, as the provider prints it. */
const LB_REFUSAL =
  "creating ELBv2 Listener Rule: operation error Elastic Load Balancing v2: CreateRule, https response error StatusCode: 400, RequestID: 7f3a2c1e, api error ValidationError: Condition value 'store.example.com' is not valid";

type CloudView = {
  status: string;
  failure: string | null;
  deadline: string | null;
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
 * A Domain on a cloud `web`. Each add, edit, remove and Ask again is
 * its own short Deployment of the Service (a `domain` Cloud run, no plan)
 * that applies only the Service's Domain blocks; the ACM poller moves a
 * certificate from waiting for DNS to live on scripted ACM and DNS answers
 * (driven by `poll(now)`, never by timers). Against the fake cloud port.
 */
describe('Domains on a cloud web (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let cloudAccountId: string;
  let environmentId: string;
  let applicationId: string;
  let stateId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-domain-'));
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
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
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
    organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
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
    cloudAccountId = account.cloudAccountId;
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

    await ctx.db.insert(environmentNetwork).values({
      environmentId,
      cloudAccountId,
      region: REGION,
      status: 'ready',
      vpcId: 'vpc-0a1b2c3d',
      publicSubnetIds: ['subnet-0aaa', 'subnet-0bbb'],
      privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'],
      clusterArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/env`,
      albArn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/cg/1`,
      albDnsName: ALB,
      albZoneId: 'Z215JYRZR1TBD5',
      httpsListenerArn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/cg/1/2`,
      albSecurityGroupId: 'sg-0alb',
      defaultCertificateArn: `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/default`,
    });
    const [app] = await ctx.db
      .insert(application)
      .values({
        name: 'web',
        environmentId,
        configName: 'web',
        configKind: 'web',
        port: 8080,
        cloudAccountId,
        region: REGION,
      })
      .returning();
    applicationId = app.applicationId;
    stateId = (
      await ctx.app
        .get(InfrastructureStatesService)
        .create({ applicationId: app.applicationId })
    ).infrastructureStateId;
    await firstDeployDone();
  });

  /** The Service's first deploy, finished: what its Domains forward to. */
  async function firstDeployDone(): Promise<void> {
    await ctx.db.insert(deployment).values({
      applicationId,
      title: 'Deploy',
      status: 'done',
      logPath: nodePath.join(root, 'first-deploy.log'),
      cloudRun: {
        kind: 'deploy',
        stateKey: `application:${applicationId}`,
        environmentId,
        touchesNetwork: false,
      },
    });
  }

  const addDomain = (body: Record<string, unknown>) =>
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
      [{ path: '/api', stripPath: true }, 'stripPath'],
      [{ internalPath: '/v1' }, 'internalPath'],
      [{ https: true, certificateType: 'letsencrypt' }, "Let's Encrypt"],
      [
        { https: true, certificateType: 'custom', customCertResolver: 'mine' },
        'custom',
      ],
      [{ https: true, certificateType: 'stored' }, 'stored'],
    ])('refuses %j, naming the field', async (body, named) => {
      const res = await addDomain(body);
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(named);
      expect(await ctx.db.select().from(domain)).toHaveLength(0);
      expect(applies()).toHaveLength(0);
    });

    it('refuses HTTPS off: Domains on AWS are always HTTPS', async () => {
      const res = await addDomain({ https: false });
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'Domains on AWS are always HTTPS',
      );
    });

    it('refuses basic auth on the Service, naming it', async () => {
      const res = await request(http)
        .post('/security')
        .set('Cookie', cookie)
        .send({ applicationId, username: 'admin', password: 'secret-pass' });
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain('basicAuth');
    });

    it('refuses a Domain before the Service has finished its first deploy', async () => {
      await ctx.db
        .delete(deployment)
        .where(eq(deployment.applicationId, applicationId));
      const res = await addDomain({});
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        'has not finished its first deploy',
      );
    });

    it("refuses one Domain past AWS's certificates-per-load-balancer quota, naming it and how to raise it", async () => {
      await ctx.db.insert(domain).values(
        Array.from({ length: 25 }, (_, index) => ({
          host: `site-${index}.example.com`,
          applicationId,
          https: true,
          cloudCertificateStatus: 'waiting-for-dns' as const,
        })),
      );
      const res = await addDomain({});
      expect(res.status).toBe(400);
      const { message } = res.body as { message: string };
      expect(message).toContain('Certificates per Application Load Balancer');
      expect(message).toContain('Service Quotas');
      expect(applies()).toHaveLength(0);
    });
  });

  it('adds a Domain in a short Deployment of its own: the certificate and the rule, no plan, no wait', async () => {
    const res = await addDomain({});
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

    // Only the Domain blocks, in the Service's own state, nothing attached.
    const key = `${body.domainId}-1`;
    expect(applies()).toEqual([
      expect.objectContaining({
        stateId,
        targets: [...DOMAIN_ADDRESSES],
        domainCertificates: [key],
        attachedCertificates: [],
      }),
    ]);
    const log = fs.readFileSync(run.logPath, 'utf8');
    expect(log).toContain(`Requested an ACM certificate for ${HOST}`);

    const row = await rowOf(body.domainId);
    expect(row).toMatchObject({
      acmCertificateArn: fakeCertificateArn(REGION, ACCOUNT, key),
      validationRecord: fakeValidationRecord(key, HOST),
      cloudCertificateStatus: 'waiting-for-dns',
    });
    expect(row.certificateRequestedAt).not.toBeNull();

    // Both records to copy, unticked, and the 72 hours left.
    const view = await viewOf(body.domainId);
    expect(view.status).toBe('waiting-for-dns');
    expect(view.records!.validation).toEqual({
      ...fakeValidationRecord(key, HOST),
      seen: false,
    });
    expect(view.records!.pointing).toMatchObject({
      name: HOST,
      type: 'CNAME',
      value: ALB,
      seen: false,
    });
    expect(Date.parse(view.deadline!)).toBe(
      Date.parse(row.certificateRequestedAt!) + 72 * 60 * MINUTE,
    );
  });

  it('shows a bare name an ALIAS to the load balancer, never an A record', async () => {
    const row = await added('example.com');
    const { pointing } = (await viewOf(row.domainId)).records!;
    expect(pointing.type).toBe('ALIAS');
    expect(pointing.note).toContain('ALIAS, ANAME or flattened CNAME');
    expect(pointing.note).toContain('never an A record');
  });

  it('moves the certificate through waiting for DNS, checking and live on what ACM and DNS answer', async () => {
    const row = await added();
    const requested = Date.parse(row.certificateRequestedAt!);
    const validation = row.validationRecord!;
    ctx.cloud.calls.length = 0;

    // Nothing in DNS yet: still waiting, and ACM was asked.
    await poller().poll(new Date(requested + MINUTE));
    expect((await rowOf(row.domainId)).cloudCertificateStatus).toBe(
      'waiting-for-dns',
    );
    expect(ctx.cloud.calls).toContainEqual({
      method: 'acmDescribeCertificate',
      region: REGION,
      certificateArn: row.acmCertificateArn,
    });

    // Asked again before a minute has passed: not due.
    ctx.cloud.calls.length = 0;
    await poller().poll(new Date(requested + MINUTE + 20_000));
    expect(
      ctx.cloud.calls.filter(
        (call) => call.method === 'acmDescribeCertificate',
      ),
    ).toHaveLength(0);

    // The validation record and the host's CNAME are in DNS: checking, both ticked.
    ctx.cloud.dnsAnswers(validation.name, { cnames: [validation.value] });
    ctx.cloud.dnsAnswers(HOST, { cnames: [`${ALB}.`] });
    await poller().poll(new Date(requested + 3 * MINUTE));
    expect(await viewOf(row.domainId)).toMatchObject({
      status: 'checking',
      records: { validation: { seen: true }, pointing: { seen: true } },
    });

    // ACM issued it: a run attaches it, and then it is live.
    ctx.cloud.acmAnswers(row.acmCertificateArn!, { status: 'ISSUED' });
    await poller().poll(new Date(requested + 5 * MINUTE));
    const [attach] = await ctx.db
      .select()
      .from(deployment)
      .where(
        and(
          eq(deployment.applicationId, applicationId),
          eq(deployment.title, `Attach the certificate of ${HOST}`),
        ),
      );
    expect((await settled(attach.deploymentId)).status).toBe('done');
    expect(applies().at(-1)).toMatchObject({
      targets: [...DOMAIN_ADDRESSES],
      attachedCertificates: [`${row.domainId}-1`],
    });
    expect((await viewOf(row.domainId)).status).toBe('live');
  });

  it("fails on ACM's refusal, and Ask again requests a new certificate", async () => {
    const row = await added();
    ctx.cloud.acmAnswers(row.acmCertificateArn!, {
      status: 'FAILED',
      reason: 'CAA_ERROR',
    });
    await poller().poll(
      new Date(Date.parse(row.certificateRequestedAt!) + MINUTE),
    );
    const failed = await viewOf(row.domainId);
    expect(failed.status).toBe('failed');
    expect(failed.failure).toContain('CAA_ERROR');

    const res = await request(http)
      .post(`/domains/${row.domainId}/ask-again`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const { deploymentId } = res.body as { deploymentId: string };
    expect((await settled(deploymentId)).status).toBe('done');
    const again = await rowOf(row.domainId);
    expect(again).toMatchObject({
      certificateAttempt: 2,
      cloudCertificateStatus: 'waiting-for-dns',
      certificateFailure: null,
      acmCertificateArn: fakeCertificateArn(
        REGION,
        ACCOUNT,
        `${row.domainId}-2`,
      ),
    });
    expect(applies().at(-1)).toMatchObject({
      domainCertificates: [`${row.domainId}-2`],
    });
  });

  it("fails each Domain the run could not make on the load balancer's refusal, in the run's own words, leaving a Domain made before as it is; Ask again brings it back", async () => {
    const made = await added();
    ctx.cloud.failRunFor('web', LB_REFUSAL);
    const res = await addDomain({ host: 'store.example.com' });
    expect(res.status).toBe(201);
    const { domainId, deploymentId } = res.body as {
      domainId: string;
      deploymentId: string;
    };
    const run = await settled(deploymentId);
    expect(run.status).toBe('error');
    expect(run.description).toContain('ValidationError');

    const view = await viewOf(domainId);
    expect(view.status).toBe('failed');
    expect(view.failure).toBe(run.description);
    expect(fs.readFileSync(run.logPath, 'utf8')).toContain(
      `🔐 store.example.com: ${run.description}`,
    );
    expect(await rowOf(made.domainId)).toMatchObject({
      cloudCertificateStatus: 'waiting-for-dns',
      certificateFailure: null,
      acmCertificateArn: made.acmCertificateArn,
    });

    // The poller never moves a failed Domain on.
    await poller().poll(
      new Date(Date.parse(made.certificateRequestedAt!) + 5 * MINUTE),
    );
    expect((await viewOf(domainId)).status).toBe('failed');

    ctx.cloud.passRunFor('web');
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
      acmCertificateArn: fakeCertificateArn(REGION, ACCOUNT, `${domainId}-2`),
    });
  });

  describe("a run that stops on its own, not on AWS's refusal, leaves its Domain waiting for DNS", () => {
    const waitingStill = async (domainId: string) =>
      expect(await rowOf(domainId)).toMatchObject({
        cloudCertificateStatus: 'waiting-for-dns',
        certificateFailure: null,
      });

    it('leaves the Domain waiting for DNS when another run holds the lock', async () => {
      ctx.cloud.lockHeld();
      const res = await addDomain({});
      const { domainId, deploymentId } = res.body as {
        domainId: string;
        deploymentId: string;
      };
      expect((await settled(deploymentId)).status).toBe('error');
      await waitingStill(domainId);
    });

    it('leaves the Domain waiting for DNS when its run is cancelled', async () => {
      ctx.cloud.hangFor('web');
      const res = await addDomain({});
      const { domainId, deploymentId } = res.body as {
        domainId: string;
        deploymentId: string;
      };
      for (let attempt = 0; attempt < 400; attempt++) {
        const [row] = await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.deploymentId, deploymentId));
        if (row.status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      ctx.app.get(CloudRunsService).cancel(deploymentId);
      expect((await settled(deploymentId)).status).toBe('cancelled');
      ctx.cloud.passRunFor('web');
      await waitingStill(domainId);
    });
  });

  it('refuses Ask again on a certificate that has not failed', async () => {
    const row = await added();
    const res = await request(http)
      .post(`/domains/${row.domainId}/ask-again`)
      .set('Cookie', cookie);
    expect(res.status).toBe(400);
    // It serves Google Cloud's Domains too, so it names no one cloud.
    expect((res.body as { message: string }).message).toBe(
      'Ask again is for a cloud Domain whose certificate failed',
    );
  });

  it('fails a certificate whose record never came within 72 hours', async () => {
    const row = await added();
    await poller().poll(
      new Date(Date.parse(row.certificateRequestedAt!) + 72 * 60 * MINUTE),
    );
    const view = await viewOf(row.domainId);
    expect(view.status).toBe('failed');
    expect(view.failure).toContain('72 hours');
  });

  it('removes a Domain in its own run, naming the two DNS records left behind', async () => {
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
      row.validationRecord,
      { name: HOST, type: 'CNAME', value: ALB },
    ]);
    expect(body.message).toContain('never writes DNS');
    expect(body.message).toContain(row.validationRecord!.name);

    expect((await settled(body.deploymentId)).status).toBe('done');
    expect(await ctx.db.select().from(domain)).toHaveLength(0);
    // The run's definition holds no certificate: the targeted blocks
    // destroy the removed Domain's rule and listener certificate, and its
    // certificate leaves the state first, deleted once the load balancer
    // lets go, so the run never waits on ACM.
    expect(applies().at(-1)).toMatchObject({
      targets: [...DOMAIN_ADDRESSES],
      domainCertificates: [],
      forgotten: [`aws_acm_certificate.domain["${row.domainId}-1"]`],
    });
    expect(ctx.cloud.acmDeleted.has(row.acmCertificateArn!)).toBe(true);
  });

  it("puts back a change on the Domain's own blocks: they are the Domain run's, not Drift to stop on", async () => {
    const row = await added();
    // A change on a Domain block, as tofu's refresh and plan show it.
    ctx.cloud.replayShowFor('web', {
      format_version: '1.2',
      resource_drift: [
        {
          address: `aws_lb_listener_rule.domain["${row.domainId}"]`,
          mode: 'managed',
          type: 'aws_lb_listener_rule',
          change: {
            actions: ['update'],
            before: { priority: 100 },
            after: { priority: 7 },
            after_unknown: {},
            before_sensitive: {},
            after_sensitive: {},
          },
        },
      ],
      resource_changes: [
        {
          address: `aws_lb_listener_rule.domain["${row.domainId}"]`,
          mode: 'managed',
          type: 'aws_lb_listener_rule',
          change: {
            actions: ['update'],
            before: { priority: 7 },
            after: { priority: 100 },
            after_unknown: {},
            before_sensitive: {},
            after_sensitive: {},
          },
        },
      ],
    });
    const res = await request(http)
      .delete(`/domains/${row.domainId}`)
      .set('Cookie', cookie);
    const run = await settled(
      (res.body as { deploymentId: string }).deploymentId,
    );
    // A failed run can leave the state ahead of AWS on these blocks, so
    // the next run must set them as the Domain says.
    expect(run.status).toBe('done');
  });

  it('edits a Domain to a new host with a new certificate, in its own run', async () => {
    const row = await added();
    const res = await request(http)
      .patch(`/domains/${row.domainId}`)
      .set('Cookie', cookie)
      .send({ host: 'store.example.com' });
    expect(res.status).toBe(200);
    const { deploymentId } = res.body as { deploymentId: string };
    expect((await settled(deploymentId)).status).toBe('done');
    expect(await rowOf(row.domainId)).toMatchObject({
      host: 'store.example.com',
      certificateAttempt: 2,
      cloudCertificateStatus: 'waiting-for-dns',
    });

    const refused = await request(http)
      .patch(`/domains/${row.domainId}`)
      .set('Cookie', cookie)
      .send({ https: false });
    expect(refused.status).toBe(400);
  });

  /**
   * A cloud Domain's host is unique per Organization, not across the
   * instance (ADR-0060): nothing proves who owns a hostname, so a
   * shared scope let one customer add another's host first and block them
   * from it. DNS and the cloud's own certificate decide who serves it.
   */
  describe('a host another Organization holds', () => {
    /**
     * Another Organization, made in the database alone, holding `host` on a
     * `web` of its own: on its own AWS account, or on the platform host.
     */
    async function anotherOrganizationHolds(
      host: string,
      on: 'cloud' | 'platform host',
    ): Promise<void> {
      const { rows } = await ctx.db.$client.query<{ id: string }>(
        'select id from "user" limit 1',
      );
      const [neighbour] = await ctx.db
        .insert(organization)
        .values({
          name: 'Neighbour',
          ownerId: rows[0].id,
          createdAt: new Date(),
        })
        .returning({ id: organization.id });
      const [account] = await ctx.db
        .insert(cloudAccount)
        .values({
          organizationId: neighbour.id,
          name: 'Their AWS',
          cloud: 'aws',
          cloudId: '210987654321',
          accessKeyId: 'AKIAIOSFODNN7NEIGHBOR',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYNEIGHBOUR',
          deployRoleArn: 'arn:aws:iam::210987654321:role/cloudgate-deploy',
          taskExecutionRoleArn:
            'arn:aws:iam::210987654321:role/cloudgate-task-execution',
          externalId: 'their-external-id',
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
          deployTarget:
            on === 'cloud'
              ? ({
                  kind: 'cloud',
                  cloudAccountId: account.cloudAccountId,
                  region: REGION,
                } as never)
              : undefined,
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
          ...(on === 'cloud'
            ? { cloudAccountId: account.cloudAccountId, region: REGION }
            : {}),
        })
        .returning();
      await ctx.db.insert(domain).values({
        host,
        applicationId: app.applicationId,
        https: true,
        ...(on === 'cloud'
          ? { cloudCertificateStatus: 'waiting-for-dns' as const }
          : {}),
      });
    }

    it('adds a host another Organization holds on its own cloud web, at the same path: DNS and the certificate decide who serves it', async () => {
      await anotherOrganizationHolds(HOST, 'cloud');
      const row = await added();
      expect(row).toMatchObject({
        host: HOST,
        path: '/',
        cloudCertificateStatus: 'waiting-for-dns',
      });
      expect(await ctx.db.select().from(domain)).toHaveLength(2);
    });

    it('adds a host another Organization routes on the platform host: a cloud Domain reaches no Traefik', async () => {
      await anotherOrganizationHolds(HOST, 'platform host');
      const row = await added();
      expect(row.host).toBe(HOST);
    });

    it('still refuses a host and path its own Organization already holds', async () => {
      const [sibling] = await ctx.db
        .insert(application)
        .values({
          name: 'admin',
          environmentId,
          configName: 'admin',
          configKind: 'web',
          port: 8080,
          cloudAccountId,
          region: REGION,
        })
        .returning();
      await ctx.db.insert(domain).values({
        host: HOST,
        applicationId: sibling.applicationId,
        https: true,
        cloudCertificateStatus: 'waiting-for-dns',
      });
      const res = await addDomain({});
      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        'Domain with this host and path already exists',
      );
      expect(applies()).toHaveLength(0);
    });
  });
});
