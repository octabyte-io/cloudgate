import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { CLEAN_NETWORK_REMOVAL_LINE } from '../../src/cloud-accounts/aws/delete-check';
import { tofuStates } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import {
  application,
  auditLog,
  cloudAccount,
  deployment,
  domain,
  environment,
  environmentNetwork,
  infrastructureState,
} from '../../src/db/schema';
import { CLOUD_RUN_TIMING } from '../../src/deployment-queue/cloud-runs-concurrency.provider';
import { CloudRunsService } from '../../src/deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const CLUSTER = `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/cloudgate-env`;
const ALB_DNS = 'cg-env-1234.eu-central-1.elb.amazonaws.com';
const NETWORK = `Environment network (${REGION})`;

const MINUTE_MS = 100;
const KILL_GRACE_MS = 150;

/** A `docker` that removes nothing and fails nothing. */
const FAKE_DOCKER = '#!/bin/bash\nexit 0\n';

/**
 * An Environment's Delete in a Cloud account destroys its cloud
 * Services first, each through its own Delete, then its Environment
 * network in a destroy-only Cloud run recorded as a Deployment of the
 * network, then the rest. Anything left keeps the Environment Delete
 * incomplete, with Retry and Forget (ADR-0038). A plan that finds neither
 * a Service nor the Deploy target where a network is removes it.
 *
 * Against the fake cloud port (`ctx.cloud`), and a real shell whose
 * `docker` does nothing, so Deployment logs are real files.
 */
describe('Deleting an Environment in a Cloud account (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;
  let cloudAccountId: string;
  let networkId: string;
  let networkState: string;
  let webState: string;
  let apiState: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-envdel-'));
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
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        {
          provide: CLOUD_RUN_TIMING,
          useValue: {
            minuteMs: MINUTE_MS,
            killGraceMs: KILL_GRACE_MS,
            shutdownGraceMs: KILL_GRACE_MS,
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

  async function stateFor(
    owner: { applicationId: string } | { environmentNetworkId: string },
  ) {
    const [state] = await ctx.db
      .insert(infrastructureState)
      .values(owner)
      .returning();
    await ctx.db.insert(tofuStates).values({
      name: state.infrastructureStateId,
      data: 'encrypted-by-opentofu',
    });
    return state.infrastructureStateId;
  }

  async function cloudWeb(name: string) {
    const [row] = await ctx.db
      .insert(application)
      .values({
        name,
        environmentId,
        configName: name,
        configKind: 'web',
        sourceType: 'docker',
        dockerImage: 'nginx',
        cloudAccountId,
        region: REGION,
        replicas: 1,
        applicationStatus: 'done',
      })
      .returning();
    return row.applicationId;
  }

  beforeEach(async () => {
    await ctx.resetDb();
    ctx.cloud.reset();
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

    const [network] = await ctx.db
      .insert(environmentNetwork)
      .values({
        environmentId,
        cloudAccountId,
        region: REGION,
        status: 'ready',
        vpcId: 'vpc-0f00ba11',
        publicSubnetIds: ['subnet-0a11', 'subnet-0b22'],
        clusterArn: CLUSTER,
        albDnsName: ALB_DNS,
        albSecurityGroupId: 'sg-0a1b',
      })
      .returning();
    networkId = network.environmentNetworkId;
    networkState = await stateFor({ environmentNetworkId: networkId });

    const web = await cloudWeb('web');
    webState = await stateFor({ applicationId: web });
    const api = await cloudWeb('api');
    apiState = await stateFor({ applicationId: api });
    await ctx.db.insert(domain).values({
      host: 'shop.example.com',
      applicationId: web,
      https: true,
      cloudCertificateStatus: 'live',
      validationRecord: {
        name: '_a1.shop.example.com.',
        type: 'CNAME',
        value: '_b2.acm-validations.aws.',
      },
    });
    ctx.cloud.calls.length = 0;
  });

  async function until(check: () => Promise<boolean>, ms = 30_000) {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function envRow() {
    const [found] = await ctx.db
      .select()
      .from(environment)
      .where(eq(environment.environmentId, environmentId));
    return found;
  }
  const gone = async () => (await envRow()) === undefined;
  const incomplete = async () =>
    (await envRow())?.cloudDelete?.status === 'incomplete';
  const networkRow = async () =>
    (
      await ctx.db
        .select()
        .from(environmentNetwork)
        .where(eq(environmentNetwork.environmentNetworkId, networkId))
    )[0];
  const destroyed = () =>
    ctx.cloud.calls
      .filter((call) => call.method === 'destroy')
      .map((call) => (call as { stateId: string }).stateId);
  /** This test's states still held (the state store outlives `resetDb`). */
  const statesLeft = async () =>
    (await ctx.db.select().from(tofuStates))
      .flatMap((one) =>
        one.name !== null &&
        [networkState, webState, apiState].includes(one.name)
          ? [one.name]
          : [],
      )
      .sort();
  const auditEntries = () =>
    ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resourceId, environmentId));

  const del = () =>
    request(http)
      .delete(`/environments/${environmentId}`)
      .set('Cookie', cookie);
  const post = (action: string) =>
    request(http)
      .post(`/environments/${environmentId}/${action}`)
      .set('Cookie', cookie);

  /** The network's removal leaves its load balancer and a card AWS made on its group. */
  function networkLeftovers() {
    ctx.cloud.leaveTagged(
      REGION,
      `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/cg/50dc`,
      { 'cloudgate:state': networkState },
    );
    ctx.cloud.leaveNetworkInterface(REGION, 'eni-0cc33dd44', 'sg-0a1b');
  }

  const NETWORK_LEFT = () => [
    {
      type: 'elasticloadbalancing:loadbalancer',
      awsId: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/cg/50dc`,
      region: REGION,
      tag: `cloudgate:state=${networkState}`,
      of: NETWORK,
    },
    {
      type: 'ec2:network-interface',
      awsId: 'eni-0cc33dd44',
      region: REGION,
      tag: null,
      of: NETWORK,
    },
  ];

  it("deletes the cloud Services first, then the network as a Deployment of the network, and names the Domains' DNS records", async () => {
    const deployments: DeploymentsService = ctx.app.get(DeploymentsService);
    const recorded = jest.spyOn(deployments, 'recordEnvironmentNetworkRun');
    const lines: string[] = [];
    const runs = ctx.app.get(CloudRunsService);
    const spy = jest
      .spyOn(runs, 'appendLog')
      .mockImplementation((_path: string, line: string) => {
        lines.push(line);
        return Promise.resolve();
      });
    try {
      const res = await del();

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        environmentId,
        cloudDelete: { status: 'deleting', left: [] },
        dnsRecordsLeft: [
          {
            name: '_a1.shop.example.com.',
            type: 'CNAME',
            value: '_b2.acm-validations.aws.',
          },
          { name: 'shop.example.com', type: 'CNAME', value: ALB_DNS },
        ],
      });
      await until(gone);
    } finally {
      spy.mockRestore();
    }

    // The Services' states first, in either order; the network's last.
    const order = destroyed();
    expect(order).toHaveLength(3);
    expect(order.slice(0, 2).sort()).toEqual([apiState, webState].sort());
    expect(order[2]).toBe(networkState);
    expect(recorded).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentNetworkId: networkId,
        title: `Remove the ${NETWORK}`,
      }),
    );
    recorded.mockRestore();
    // The check afterwards: the state's tag, and the cards AWS made on the
    // load balancer's group.
    expect(ctx.cloud.calls).toEqual(
      expect.arrayContaining([
        {
          method: 'findTagged',
          region: REGION,
          tags: { 'cloudgate:state': networkState },
        },
        {
          method: 'networkInterfacesOf',
          region: REGION,
          securityGroupIds: ['sg-0a1b'],
        },
      ]),
    );
    expect(lines).toContain(CLEAN_NETWORK_REMOVAL_LINE);
    expect(lines).toContain('  CNAME shop.example.com → ' + ALB_DNS);

    expect(await networkRow()).toBeUndefined();
    expect(await statesLeft()).toEqual([]);
    expect(
      await ctx.db
        .select()
        .from(application)
        .where(eq(application.environmentId, environmentId)),
    ).toEqual([]);
    expect(
      await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.environmentNetworkId, networkId)),
    ).toEqual([]);
    // The Delete's audit row is written after the Environment's row goes.
    const finishedEntry = async () =>
      (await auditEntries()).find((one) =>
        (one.metadata ?? '').includes('"cloudDelete":"finished"'),
      );
    await until(async () => (await finishedEntry()) !== undefined);
    const finished = await finishedEntry();
    expect(finished).toMatchObject({
      action: 'delete',
      resourceType: 'environment',
    });
  });

  it('keeps the Environment, the network and its state Delete incomplete with each leftover', async () => {
    networkLeftovers();

    expect((await del()).status).toBe(200);
    await until(incomplete);

    expect((await envRow()).cloudDelete).toMatchObject({
      status: 'incomplete',
      left: NETWORK_LEFT(),
      unfinished: null,
    });
    const kept = await networkRow();
    expect(kept).toMatchObject({ status: 'delete-incomplete' });
    expect(kept.leftovers).toHaveLength(2);
    expect(await statesLeft()).toEqual([networkState]);
    // The Services went; their Deletes were clean.
    expect(
      await ctx.db
        .select()
        .from(application)
        .where(eq(application.environmentId, environmentId)),
    ).toEqual([]);

    // A second Delete is refused: only Retry or Forget end it.
    expect((await del()).status).toBe(409);
  });

  it('finishes the network’s removal when the tag index still lists subnets EC2 has deleted', async () => {
    // What the live walk found minutes after a clean destroy.
    const subnets = [
      'subnet-0dd6ce384f2683b9f',
      'subnet-0f3e40b8c7bc11ea5',
    ].map((id) => `arn:aws:ec2:${REGION}:${ACCOUNT}:subnet/${id}`);
    for (const arn of subnets) {
      ctx.cloud.leaveEc2Ghost(REGION, arn, { 'cloudgate:state': networkState });
    }

    expect((await del()).status).toBe(200);
    await until(gone);

    expect(ctx.cloud.calls).toContainEqual({
      method: 'ec2Standing',
      region: REGION,
      arns: subnets,
    });
    expect(await networkRow()).toBeUndefined();
    expect(await statesLeft()).toEqual([]);
  });

  it('stops before the network while a Service is left, so the network is never destroyed under it', async () => {
    ctx.cloud.leaveTagged(
      REGION,
      `arn:aws:ec2:${REGION}:${ACCOUNT}:security-group/sg-0123abcd`,
      { 'cloudgate:state': webState },
    );

    expect((await del()).status).toBe(200);
    await until(incomplete);

    expect(destroyed()).not.toContain(networkState);
    expect((await envRow()).cloudDelete?.left).toEqual([
      expect.objectContaining({
        type: 'ec2:security-group',
        of: 'Service web',
      }),
    ]);
    expect(await networkRow()).toMatchObject({ status: 'ready' });
  });

  it('retries from the kept states, and finishes once nothing is left', async () => {
    networkLeftovers();
    await del();
    await until(incomplete);

    ctx.cloud.clearLeftovers();
    ctx.cloud.calls.length = 0;
    const retried = await post('delete/retry');

    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      cloudDelete: { status: 'deleting', retrying: true },
    });
    await until(gone);
    expect(destroyed()).toEqual([networkState]);
    expect(await networkRow()).toBeUndefined();
    expect(await statesLeft()).toEqual([]);
  });

  it('forgets a Delete incomplete, dropping every row and writing what is left into the audit entry', async () => {
    networkLeftovers();
    await del();
    await until(incomplete);

    const forgotten = await post('delete/forget');

    expect(forgotten.status).toBe(200);
    expect(forgotten.body).toMatchObject({ forgotten: NETWORK_LEFT() });
    expect(await envRow()).toBeUndefined();
    expect(await networkRow()).toBeUndefined();
    expect(await statesLeft()).toEqual([]);
    const entry = (await auditEntries()).find((one) =>
      (one.metadata ?? '').includes('"cloudDelete":"forgotten"'),
    );
    expect(entry).toMatchObject({
      action: 'delete',
      resourceType: 'environment',
      resourceName: 'production',
    });
    expect(JSON.parse(entry!.metadata!)).toMatchObject({
      left: NETWORK_LEFT(),
    });
  });

  it('refuses Retry and Forget on an Environment with no incomplete Delete', async () => {
    expect((await post('delete/retry')).status).toBe(409);
    expect((await post('delete/forget')).status).toBe(409);
    expect(await envRow()).toBeDefined();
  });

  it('fails and removes nothing when the Cloud account cannot be reached', async () => {
    ctx.cloud.unreachable();

    const res = await del();

    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toMatch(
      /Nothing was removed$/,
    );
    expect((await envRow()).cloudDelete).toBeNull();
    expect(destroyed()).toEqual([]);
  });

  it('deletes a Project through its cloud Environment’s Delete first', async () => {
    const res = await request(http)
      .delete(`/projects/${projectId}`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      projectId,
      deletingEnvironments: ['production'],
    });
    await until(async () => {
      const left = await request(http)
        .get(`/projects/${projectId}`)
        .set('Cookie', cookie);
      return left.status === 404;
    });
    expect(destroyed()).toHaveLength(3);
    expect(await statesLeft()).toEqual([]);
  });

  describe('a network a Deploy target switch left with nothing in it', () => {
    beforeEach(async () => {
      // Its Services are gone; the Environment now deploys on the platform host.
      await ctx.db
        .delete(application)
        .where(eq(application.environmentId, environmentId));
      await ctx.db
        .update(environmentNetwork)
        .set({
          dnsRecordsLeft: [
            { name: 'shop.example.com', type: 'CNAME', value: ALB_DNS },
          ],
        })
        .where(eq(environmentNetwork.environmentNetworkId, networkId));
      const switched = await request(http)
        .patch(`/environments/${environmentId}`)
        .set('Cookie', cookie)
        .send({ deployTarget: { kind: 'platform-host' } });
      expect(switched.status).toBe(200);
    });

    async function plannedRemoval() {
      const saved = await request(http)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({ text: 'version: 1\nservices: {}\n' });
      expect(saved.status).toBe(201);
      return (
        saved.body as {
          plans: {
            planId: string;
            environmentId: string;
            steps: Record<string, unknown>[];
          }[];
        }
      ).plans.find((one) => one.environmentId === environmentId)!;
    }

    it('plans its removal as its own step, and refuses an Apply that does not confirm it', async () => {
      const open = await plannedRemoval();

      expect(open.steps).toEqual([
        {
          action: 'network-remove',
          environmentNetworkId: networkId,
          cloudAccountId,
          region: REGION,
          confirmName: `network-${REGION}`,
          dnsRecordsLeft: [
            { name: 'shop.example.com', type: 'CNAME', value: ALB_DNS },
          ],
        },
      ]);
      const refused = await request(http)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: open.planId, confirmDestroy: [] });
      expect(refused.status).toBe(409);
      expect(await networkRow()).toMatchObject({ status: 'ready' });
    });

    it('offers no removal while a Service whose Delete is incomplete still holds it', async () => {
      const [held] = await ctx.db
        .insert(application)
        .values({
          name: 'old',
          environmentId,
          configName: 'old',
          configKind: 'web',
          sourceType: 'docker',
          dockerImage: 'nginx',
          cloudAccountId,
          region: REGION,
          cloudDelete: {
            status: 'incomplete',
            deploymentId: 'dep-gone',
            retrying: false,
            requestedBy: null,
            kept: [],
            left: [],
            unfinished: 'It ended',
          },
        })
        .returning();
      expect(held).toBeDefined();

      const open = await plannedRemoval();

      expect(open.steps).toEqual([]);
    });

    it("applies it as the network's destroy-only Cloud run, naming the DNS records left", async () => {
      const open = await plannedRemoval();

      const applied = await request(http)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: open.planId, confirmDestroy: [`network-${REGION}`] });

      expect(applied.status).toBe(200);
      expect(
        (applied.body as { results: Record<string, unknown>[] }).results,
      ).toEqual([
        expect.objectContaining({
          action: 'network-remove',
          configName: NETWORK,
          status: 'applied',
          deploy: expect.objectContaining({ status: 'queued' }) as unknown,
          dnsRecordsLeft: [
            { name: 'shop.example.com', type: 'CNAME', value: ALB_DNS },
          ],
        }),
      ]);
      await until(async () => (await networkRow()) === undefined);
      expect(destroyed()).toEqual([networkState]);
      expect(await statesLeft()).not.toContain(networkState);
      expect(await envRow()).toBeDefined();
    });
  });
});
