import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import type { CloudDeleteRecord } from '../../src/applications/application.schema';
import {
  DELETE_INCOMPLETE_REFUSAL,
  DELETING_REFUSAL,
} from '../../src/applications/cloud-delete-refusal';
import { CLEAN_DELETE_LINE } from '../../src/cloud-accounts/aws/delete-check';
import { tofuStates } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import {
  application,
  auditLog,
  cloudAccount,
  deployment,
  environmentNetwork,
  infrastructureState,
  projectConfigLocation,
} from '../../src/db/schema';
import { CLOUD_RUN_TIMING } from '../../src/deployment-queue/cloud-runs-concurrency.provider';
import { CloudRunsService } from '../../src/deployment-queue/cloud-runs.service';
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

/** A minute of the Cloud run time limit, and the kill grace, made short. */
const MINUTE_MS = 100;
const KILL_GRACE_MS = 150;

/** A `docker` that removes nothing and fails nothing. */
const FAKE_DOCKER = '#!/bin/bash\nexit 0\n';

/**
 * A cloud Service's Delete is a destroy-only Cloud run, recorded as a
 * Deployment of the Service while it reads "Deleting". A clean finish drops
 * the row, its Deployments and its state and audits the Delete; anything
 * the check afterwards finds keeps the row Delete incomplete, with the list,
 * until Retry or Forget (ADR-0038). Deploy and Start are refused meanwhile.
 *
 * Against the fake cloud port (`ctx.cloud`), and a real shell whose
 * `docker` does nothing, so the Deployment log is a real file.
 */
describe('Deleting a cloud Service (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  let cloudAccountId: string;
  let applicationId: string;
  let stateId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-delete-'));
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

    await ctx.db.insert(environmentNetwork).values({
      environmentId,
      cloudAccountId,
      region: REGION,
      status: 'ready',
      vpcId: 'vpc-0f00ba11',
      publicSubnetIds: ['subnet-0a11', 'subnet-0b22'],
      clusterArn: CLUSTER,
      httpsListenerArn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/cg/50dc6c495c0c9188/f2f7dc8efc522ab2`,
      albSecurityGroupId: 'sg-0a1b',
    });
    // A web as its finished deploy leaves it (`cloud-deploy.e2e-spec.ts`
    // makes one for real): its row, its state's row and the state itself.
    const [web] = await ctx.db
      .insert(application)
      .values({
        name: 'web',
        environmentId,
        configName: 'web',
        configKind: 'web',
        sourceType: 'docker',
        dockerImage: 'nginx',
        cloudAccountId,
        region: REGION,
        replicas: 2,
        applicationStatus: 'done',
      })
      .returning();
    applicationId = web.applicationId;
    const [state] = await ctx.db
      .insert(infrastructureState)
      .values({ applicationId })
      .returning();
    stateId = state.infrastructureStateId;
    await ctx.db
      .insert(tofuStates)
      .values({ name: stateId, data: 'encrypted-by-opentofu' });
    ctx.cloud.calls.length = 0;
  });

  async function until(check: () => Promise<boolean>, ms = 20_000) {
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

  const statesLeft = async () => ({
    records: await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.infrastructureStateId, stateId)),
    tofu: await ctx.db
      .select()
      .from(tofuStates)
      .where(eq(tofuStates.name, stateId)),
  });

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

  /** A Delete that leaves the task's security group, a network card AWS made on it, and the task role. */
  function scriptLeftovers() {
    ctx.cloud.leaveTagged(
      REGION,
      `arn:aws:ec2:${REGION}:${ACCOUNT}:security-group/sg-0123abcd`,
      { 'cloudgate:state': stateId },
    );
    ctx.cloud.leaveNetworkInterface(REGION, 'eni-0aa11bb22', 'sg-0123abcd');
    ctx.cloud.leaveIamRole(
      `cloudgate-${applicationId}`,
      `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-${applicationId}`,
    );
  }

  const LEFT = () => [
    {
      type: 'ec2:security-group',
      awsId: `arn:aws:ec2:${REGION}:${ACCOUNT}:security-group/sg-0123abcd`,
      region: REGION,
      tag: `cloudgate:state=${stateId}`,
    },
    {
      type: 'iam:role',
      awsId: `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-${applicationId}`,
      region: 'global',
      tag: `cloudgate:state=${stateId}`,
    },
    {
      type: 'ec2:network-interface',
      awsId: 'eni-0aa11bb22',
      region: REGION,
      tag: null,
    },
  ];

  it.each(['web', 'worker', 'web-private'] as const)(
    'queues a destroy-only Cloud run as a Deployment for a %s, then drops the row, its Deployments and its state, and audits the Delete',
    async (kind) => {
      // A Worker on ECS and a Private web service are
      // deleted as a `web` is: the destroy takes its discovery service too.
      await ctx.db
        .update(application)
        .set({ configKind: kind })
        .where(eq(application.applicationId, applicationId));
      const res = await del();

      expect(res.status).toBe(200);
      const record = (res.body as { cloudDelete: CloudDeleteRecord })
        .cloudDelete;
      expect(record).toMatchObject({ status: 'deleting', left: [], kept: [] });
      const [run] = await deploymentsOf();
      expect(run).toMatchObject({
        deploymentId: record.deploymentId,
        title: 'Delete',
      });
      const log = fs.readFileSync(run.logPath, 'utf8');

      await until(gone);
      const destroys = ctx.cloud.calls.filter(
        (call) => call.method === 'destroy',
      );
      expect(destroys).toEqual([
        expect.objectContaining({ method: 'destroy', stateId }),
      ]);
      // The check afterwards: by the state's tag, and by id for the task role.
      expect(ctx.cloud.calls).toEqual(
        expect.arrayContaining([
          {
            method: 'findTagged',
            region: REGION,
            tags: { 'cloudgate:state': stateId },
          },
          { method: 'findIamRole', roleName: `cloudgate-${applicationId}` },
        ]),
      );
      expect(log).toContain('Initializing deployment');
      expect(await deploymentsOf()).toEqual([]);
      expect(await statesLeft()).toEqual({ records: [], tofu: [] });
      const entries = await auditEntries();
      expect(
        entries.map((entry) => [entry.action, entry.resourceType]),
      ).toEqual(expect.arrayContaining([['delete', 'application']]));
      expect(
        entries.some((entry) =>
          (entry.metadata ?? '').includes('"cloudDelete":"finished"'),
        ),
      ).toBe(true);
    },
  );

  it('says the report in one line when it is clean', async () => {
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
    expect(lines).toContain(CLEAN_DELETE_LINE);
    expect(lines.join('\n')).not.toContain('Left, although');
  });

  it('reads what the tag index keeps of stopped ECS resources as gone, and deletes an INACTIVE task definition', async () => {
    const tag = { 'cloudgate:state': stateId };
    const ecsArn = (resource: string) =>
      `arn:aws:ecs:${REGION}:${ACCOUNT}:${resource}`;
    ctx.cloud.leaveEcsGhost(REGION, ecsArn('task/c/0e08'), tag, 'gone');
    ctx.cloud.leaveEcsGhost(REGION, ecsArn('service/c/api'), tag, 'gone');
    ctx.cloud.leaveEcsGhost(
      REGION,
      ecsArn('task-definition/api:1'),
      tag,
      'inactive',
    );
    // Still ACTIVE: left, as before.
    ctx.cloud.leaveTagged(REGION, ecsArn('service/c/web'), tag);

    expect((await del()).status).toBe(200);
    await until(incomplete);

    expect((await row()).cloudDelete).toMatchObject({
      status: 'incomplete',
      left: [
        {
          type: 'ecs:service',
          awsId: ecsArn('service/c/web'),
          region: REGION,
          tag: `cloudgate:state=${stateId}`,
        },
      ],
    });
    expect(ctx.cloud.calls).toEqual(
      expect.arrayContaining([
        {
          method: 'ecsDeleteTaskDefinitions',
          region: REGION,
          arns: [ecsArn('task-definition/api:1')],
        },
      ]),
    );
  });

  it('finishes clean when everything the tag index still lists is stopped in ECS', async () => {
    const tag = { 'cloudgate:state': stateId };
    ctx.cloud.leaveEcsGhost(
      REGION,
      `arn:aws:ecs:${REGION}:${ACCOUNT}:task/c/0e08`,
      tag,
      'gone',
    );

    expect((await del()).status).toBe(200);
    await until(gone);
  });

  it('keeps the row Delete incomplete with each leftover, and the state, when the check finds something left', async () => {
    scriptLeftovers();

    expect((await del()).status).toBe(200);
    await until(incomplete);

    const kept = await row();
    expect(kept.cloudDelete).toMatchObject({
      status: 'incomplete',
      left: LEFT(),
      kept: [],
      unfinished: null,
    });
    const [run] = await deploymentsOf();
    await until(async () => (await deploymentsOf())[0].status === 'error');
    expect((await deploymentsOf())[0].description).toBe(
      'Delete incomplete: 3 resources are left in AWS. Retry destroys again from the kept state',
    );
    const log = fs.readFileSync(run.logPath, 'utf8');
    expect(log).toContain('Left, although it should have gone:');
    expect(log).toContain('ec2:network-interface eni-0aa11bb22');
    expect(ctx.cloud.calls).toEqual(
      expect.arrayContaining([
        {
          method: 'networkInterfacesOf',
          region: REGION,
          securityGroupIds: ['sg-0123abcd'],
        },
      ]),
    );
    const states = await statesLeft();
    expect(states.records).toHaveLength(1);
    expect(states.tofu).toHaveLength(1);

    // A second Delete is refused: only Retry or Forget end it.
    const again = await del();
    expect(again.status).toBe(409);
  });

  it('retries from the kept state, and finishes clean once nothing is left', async () => {
    scriptLeftovers();
    await del();
    await until(incomplete);

    ctx.cloud.clearLeftovers();
    ctx.cloud.calls.length = 0;
    const retried = await post('delete/retry');

    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({
      cloudDelete: { status: 'deleting', retrying: true },
    });
    expect((await deploymentsOf()).map((one) => one.title).sort()).toEqual([
      'Delete',
      'Retry Delete',
    ]);
    await until(gone);
    expect(ctx.cloud.calls.filter((call) => call.method === 'destroy')).toEqual(
      [expect.objectContaining({ stateId })],
    );
    expect(await statesLeft()).toEqual({ records: [], tofu: [] });
  });

  it('forgets a Delete incomplete, writing what is left into the audit entry', async () => {
    scriptLeftovers();
    await del();
    await until(incomplete);
    await until(async () => (await deploymentsOf())[0].status === 'error');

    const forgotten = await post('delete/forget');

    expect(forgotten.status).toBe(200);
    expect(await row()).toBeUndefined();
    expect(await deploymentsOf()).toEqual([]);
    const entry = (await auditEntries()).find((one) =>
      (one.metadata ?? '').includes('"cloudDelete":"forgotten"'),
    );
    expect(entry).toMatchObject({
      action: 'delete',
      resourceType: 'application',
      resourceName: 'web',
    });
    expect(JSON.parse(entry!.metadata!)).toMatchObject({ left: LEFT() });
  });

  it('refuses Forget on a Delete a restart cut off before it checked what is left, until a Retry lists it', async () => {
    scriptLeftovers();
    await del();
    await until(incomplete);
    await until(async () => (await deploymentsOf())[0].status === 'error');
    // As a restart leaves it: still `deleting`, its run ended, nothing listed.
    const kept = (await row()).cloudDelete!;
    await ctx.db
      .update(application)
      .set({
        cloudDelete: {
          ...kept,
          status: 'deleting',
          left: [],
          unfinished: null,
        },
      })
      .where(eq(application.applicationId, applicationId));

    const forgotten = await post('delete/forget');

    expect(forgotten.status).toBe(409);
    expect((forgotten.body as { message: string }).message).toBe(
      "web's Delete was cut off before it checked what is left in AWS, so Forget would record nothing of it. Retry it first",
    );
    expect(await row()).toBeDefined();

    expect((await post('delete/retry')).status).toBe(200);
    await until(incomplete);
    await until(async () =>
      (await deploymentsOf()).every((one) => one.status !== 'running'),
    );
    expect((await row()).cloudDelete?.left).toEqual(LEFT());
    expect((await post('delete/forget')).status).toBe(200);
  });

  it('refuses Retry and Forget on a Service with no incomplete Delete', async () => {
    const retried = await post('delete/retry');
    expect(retried.status).toBe(409);
    const forgotten = await post('delete/forget');
    expect(forgotten.status).toBe(409);
    expect(await row()).toBeDefined();
  });

  it('refuses Deploy and Start while the Delete is incomplete, and while it runs', async () => {
    scriptLeftovers();
    await del();
    await until(incomplete);

    const deployed = await request(http)
      .post(`/applications/${applicationId}/deployments`)
      .set('Cookie', cookie)
      .send({});
    expect(deployed.status).toBe(409);
    expect((deployed.body as { message: string }).message).toBe(
      DELETE_INCOMPLETE_REFUSAL,
    );
    ctx.cloud.calls.length = 0;
    const started = await post('start');
    expect(started.status).toBe(409);
    expect((started.body as { message: string }).message).toBe(
      DELETE_INCOMPLETE_REFUSAL,
    );
    expect(
      ctx.cloud.calls.filter((call) => call.method.startsWith('ecs')),
    ).toEqual([]);

    // While a Retry runs, "being deleted".
    ctx.cloud.hang(stateId);
    expect((await post('delete/retry')).status).toBe(200);
    const whileDeleting = await post('start');
    expect(whileDeleting.status).toBe(409);
    expect((whileDeleting.body as { message: string }).message).toBe(
      DELETING_REFUSAL,
    );
    const [run] = (await deploymentsOf()).filter(
      (one) => one.title === 'Retry Delete',
    );
    await request(http)
      .post(`/deployments/${run.deploymentId}/stop-run`)
      .set('Cookie', cookie);
    await until(incomplete);
  });

  it('fails and removes nothing when the Cloud account cannot be reached', async () => {
    ctx.cloud.unreachable();

    const res = await del();

    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toBe(
      'AWS could not be reached for Cloud account Production AWS: connect ETIMEDOUT sts.amazonaws.com:443. Check for changes to read it again. Nothing was removed',
    );
    expect((await row()).cloudDelete).toBeNull();
    expect(await deploymentsOf()).toEqual([]);
    expect(
      ctx.cloud.calls.filter((call) =>
        ['plan', 'apply', 'destroy'].includes(call.method),
      ),
    ).toEqual([]);
    expect((await statesLeft()).records).toHaveLength(1);
  });

  it('leaves the row Delete incomplete with Retry when the time limit stops the run', async () => {
    const limited = await request(http)
      .post('/settings/cloud-run-time-limit')
      .set('Cookie', cookie)
      .send({ cloudRunTimeLimitMinutes: 5 });
    expect(limited.status).toBeLessThan(300);
    ctx.cloud.hang(stateId);

    expect((await del()).status).toBe(200);
    await until(incomplete);
    await until(async () => (await deploymentsOf())[0].status === 'error');

    const kept = await row();
    expect(kept.cloudDelete?.unfinished).toMatch(/interrupted/);
    expect((await deploymentsOf())[0].description).toMatch(
      /^Ended by the Cloud run time limit of 5 minutes/,
    );

    ctx.cloud.reset();
    expect((await post('delete/retry')).status).toBe(200);
    await until(gone);
  });

  it('goes through this Delete when a plan destroys the Service, confirmed by name', async () => {
    // The config in effect describes the web, so a config without it
    // destroys it.
    await ctx.db
      .update(projectConfigLocation)
      .set({
        text: 'version: 1\nservices:\n  web:\n    kind: web\n    size: small\n    source: { image: nginx }\n',
      })
      .where(eq(projectConfigLocation.projectId, projectId));
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: 'version: 1\nservices: {}\n' });
    expect(saved.status).toBe(201);
    const open = (
      saved.body as {
        plans: {
          planId: string;
          environmentId: string;
          steps: { action: string; configName: string }[];
        }[];
      }
    ).plans.find((one) => one.environmentId === environmentId)!;
    expect(open.steps).toEqual([
      expect.objectContaining({ action: 'destroy', configName: 'web' }),
    ]);

    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: open.planId, confirmDestroy: ['web'] });

    expect(applied.status).toBe(200);
    const [result] = (
      applied.body as {
        results: {
          action: string;
          status: string;
          deploy: { status: string; deploymentId: string } | null;
        }[];
      }
    ).results;
    expect(result).toMatchObject({
      action: 'destroy',
      status: 'applied',
      deploy: { status: 'queued' },
    });
    await until(gone);
    expect(ctx.cloud.calls.filter((call) => call.method === 'destroy')).toEqual(
      [expect.objectContaining({ stateId })],
    );
  });
});
