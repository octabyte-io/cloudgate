import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import { parse } from 'yaml';
import request from 'supertest';
import { App } from 'supertest/types';

import { STACK_VM_DOMAIN_ADDRESSES } from '../../src/cloud-accounts/aws/definitions/stack-vm-definition';
import { tofuStates } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import { ComposeService } from '../../src/compose/compose.service';
import {
  cloudAccount,
  compose,
  deployment,
  domain,
  environmentNetwork,
} from '../../src/db/schema';
import type { Deployment, Domain } from '../../src/db/schema';
import { stackVmPinsOn } from '../../src/cloud-accounts/definitions/stack-vm-pins';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { fakeCertificateArn } from '../utils/fake-cloud-port';
import type { FakeCloudCall } from '../utils/fake-cloud-port';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const ALB = `cg-1234567890.${REGION}.elb.amazonaws.com`;
const HOST = 'shop.example.com';

const COMPOSE_FILE = `services:\n  web:\n    image: ghost:5\n  admin:\n    image: adminer\n`;

/**
 * **A Domain on a compose service on its Stack VM** (ADR-0070, #1371), on
 * AWS: the same Domain row and rules as a cloud `web`'s, its run a short
 * Cloud run of the stack that applies only the Stack VM's Domain blocks
 * (certificate, host rule, the port's target group with the Stack VM in
 * it, and the security group's rule from the load balancer). Against the
 * fake cloud port.
 *
 * Written with #1371; not run in that change (the e2e lanes were left to
 * the merge).
 */
describe('Domains on a Stack VM (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let composeId: string;
  let environmentId: string;
  let stateId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-svm-'));
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
    const res = await request(http).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const userId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };
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
        policyVersion: 4,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    const project = await ctx.app
      .get(ProjectsService)
      .create(ownerCtx, { name: 'Shop' });
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId: project.projectId,
        name: 'production',
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: account.cloudAccountId,
          region: REGION,
        },
      });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;
    await ctx.db.insert(environmentNetwork).values({
      environmentId,
      cloudAccountId: account.cloudAccountId,
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

    const composeService = ctx.app.get(ComposeService);
    const created = await composeService.create(
      ownerCtx,
      { name: 'shop', environmentId, serverId: null },
      {
        configName: 'shop',
        cloud: {
          composeId: 'StackVmShop1',
          cloudAccountId: account.cloudAccountId,
          region: REGION,
          stackVm: {
            machineType: 't3.small',
            sizeName: 'medium',
            dataDiskGb: 20,
            snapshotDays: 7,
            made: null,
          },
        },
      },
    );
    composeId = created.composeId;
    await composeService.update(ownerCtx, composeId, {
      sourceType: 'raw',
      composeFile: COMPOSE_FILE,
    });
    stateId = (
      await ctx.app.get(InfrastructureStatesService).create({ composeId })
    ).infrastructureStateId;
  });

  /** The Stack VM its create's Cloud run made. */
  async function stackVmMade(): Promise<void> {
    const [row] = await ctx.db
      .select()
      .from(compose)
      .where(eq(compose.composeId, composeId));
    await ctx.db
      .update(compose)
      .set({
        stackVm: {
          ...row.stackVm!,
          made: {
            imageId: 'ami-0ubuntu2404',
            // Made at Cloudgate's pins, so no plan replaces it.
            pins: stackVmPinsOn('aws'),
            instanceId: 'i-0stackvm1234567',
            privateIp: '10.80.128.5',
            dataVolumeId: 'vol-0data',
          },
        },
      })
      .where(eq(compose.composeId, composeId));
  }

  const addDomain = (body: Record<string, unknown>) =>
    request(http)
      .post('/domains')
      .set('Cookie', cookie)
      .send({ composeId, host: HOST, serviceName: 'web', port: 2368, ...body });

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

  const applies = () =>
    ctx.cloud.calls.filter(
      (call): call is Extract<FakeCloudCall, { method: 'apply' }> =>
        call.method === 'apply',
    );

  /** The open plan once no step is still reading AWS. */
  async function readPlan(): Promise<{
    planId: string;
    steps: {
      action: string;
      configName?: string;
      cloudRead?: { status: string } | null;
    }[];
  }> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const res = await request(http)
        .get(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie);
      const found = (
        res.body as {
          plan: Awaited<ReturnType<typeof readPlan>>;
        }
      ).plan;
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading AWS');
  }

  it('refuses a Domain before the Stack VM is made, saying so', async () => {
    const res = await addDomain({});
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toContain(
      "shop's Stack VM is not made yet",
    );
    expect(await ctx.db.select().from(domain)).toHaveLength(0);
  });

  it.each([
    [{ forwardAuthEnabled: true }, 'forwardAuthEnabled'],
    [{ middlewares: ['redirect-to-https@file'] }, 'middlewares'],
    [{ path: '/api', stripPath: true }, 'stripPath'],
    [{ https: true, certificateType: 'letsencrypt' }, 'certificateType'],
  ])(
    'refuses a field only Traefik can honour, %j, naming it',
    async (body, named) => {
      await stackVmMade();
      const res = await addDomain(body);
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(named);
      expect(applies()).toHaveLength(0);
    },
  );

  it('refuses a Domain naming no compose service', async () => {
    await stackVmMade();
    const res = await addDomain({ serviceName: undefined });
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toContain('serviceName');
  });

  it('adds the Domain as a run of the stack: its certificate, its rule and its port on the Stack VM, waiting for DNS', async () => {
    await stackVmMade();
    const res = await addDomain({});
    expect(res.status).toBe(201);
    const { domainId, deploymentId } = res.body as {
      domainId: string;
      deploymentId: string;
    };
    const run = await settled(deploymentId);
    expect(run.status).toBe('done');
    expect(run.composeId).toBe(composeId);

    const row = await rowOf(domainId);
    expect(row).toMatchObject({
      composeId,
      applicationId: null,
      serviceName: 'web',
      port: 2368,
      https: true,
      cloudCertificateStatus: 'waiting-for-dns',
      acmCertificateArn: fakeCertificateArn(REGION, ACCOUNT, `${domainId}-1`),
    });
    const [apply] = applies();
    expect(apply).toMatchObject({
      targets: [...STACK_VM_DOMAIN_ADDRESSES],
      domainCertificates: [`${domainId}-1`],
    });
  });

  it("shows the two DNS records, the host's pointing at the network's load balancer", async () => {
    await stackVmMade();
    const res = await addDomain({});
    await settled((res.body as { deploymentId: string }).deploymentId);
    const listed = await request(http)
      .get(`/compose/${composeId}/domains`)
      .set('Cookie', cookie);
    expect(listed.status).toBe(200);
    const [one] = listed.body as {
      cloud: {
        status: string;
        loadBalancer: string;
        records: { pointing: { value: string } };
      };
    }[];
    expect(one.cloud.status).toBe('waiting-for-dns');
    expect(one.cloud.loadBalancer).toBe(ALB);
    expect(one.cloud.records.pointing.value).toBe(ALB);
  });

  it('shows the Domain’s port published on the Stack VM in the converted file, with no Traefik label', async () => {
    await stackVmMade();
    const res = await addDomain({});
    await settled((res.body as { deploymentId: string }).deploymentId);

    const converted = await request(http)
      .get(`/compose/${composeId}/converted`)
      .set('Cookie', cookie);

    expect(converted.status).toBe(200);
    const services = (
      parse(converted.text) as {
        services: Record<string, { ports?: unknown[]; labels?: unknown }>;
      }
    ).services;
    expect(JSON.stringify(services.web.ports)).toContain('2368');
    expect(converted.text).not.toContain('traefik.http');
  });

  it("refuses a second service's Domain on a port the Stack VM already publishes for another", async () => {
    await stackVmMade();
    const first = await addDomain({});
    await settled((first.body as { deploymentId: string }).deploymentId);
    const res = await addDomain({
      host: 'db.example.com',
      serviceName: 'admin',
    });
    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toContain('port');
  });

  /**
   * A resize writes the whole Stack VM definition again (#1368), so its
   * Domain pieces have to be in it, or the change's plan reads them as
   * destroyed and its Cloud run destroys them: the Domain stops serving.
   */
  it("keeps the stack's Domain on the load balancer through a resize: its plan read and its Cloud run write the Domain's pieces", async () => {
    await stackVmMade();
    const added = await addDomain({});
    expect(added.status).toBe(201);
    const { domainId, deploymentId } = added.body as {
      domainId: string;
      deploymentId: string;
    };
    expect((await settled(deploymentId)).status).toBe('done');
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;
    // Check for changes reads the made network for Drift too: it has its
    // state, and its read finds nothing to do.
    const [network] = await ctx.db.select().from(environmentNetwork);
    const networkState = await ctx.app
      .get(InfrastructureStatesService)
      .create({ environmentNetworkId: network.environmentNetworkId });
    await ctx.db.insert(tofuStates).values({
      name: networkState.infrastructureStateId,
      data: 'encrypted-by-opentofu',
    });

    const sized = await request(http)
      .patch(`/compose/${composeId}/stack-vm`)
      .set('Cookie', cookie)
      .send({ size: 'large' });
    expect(sized.status).toBe(200);
    const asked = await request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(asked.status).toBe(201);
    const plan = await readPlan();
    const step = plan.steps.find((one) => one.configName === 'shop');
    expect(step).toMatchObject({ action: 'change' });
    expect(step?.cloudRead?.status).toBe('read');

    const certificate = `${domainId}-1`;
    const runs = () =>
      ctx.cloud.calls.filter(
        (
          call,
        ): call is Extract<
          FakeCloudCall,
          { method: 'plan' | 'apply' | 'destroy' }
        > =>
          (call.method === 'plan' || call.method === 'apply') &&
          call.stateId === stateId,
      );
    expect(runs()).toEqual([
      expect.objectContaining({
        method: 'plan',
        domainCertificates: [certificate],
      }),
    ]);

    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: plan.planId });
    expect(applied.status).toBe(200);
    for (let attempt = 0; attempt < 200; attempt++) {
      if (runs().some((call) => call.method === 'apply')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(runs().find((call) => call.method === 'apply')).toMatchObject({
      domainCertificates: [certificate],
    });
    // The whole definition, never only the Domain's blocks.
    expect(
      runs().find((call) => call.method === 'apply')?.targets,
    ).toBeUndefined();
  });

  it('refuses a generated host for the stack, saying a Stack VM has none', async () => {
    const res = await request(http)
      .post('/domains/generate')
      .set('Cookie', cookie)
      .send({ appName: 'shop', composeId });
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toContain(
      'A Stack VM has no generated host',
    );
  });
});
