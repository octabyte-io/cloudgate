import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import {
  cloudAccount,
  deployment as deploymentTable,
  environmentNetwork,
} from '../../src/db/schema';
import type { CloudRunEnding } from '../../src/deployment-queue/cloud-run-job.types';
import { CLOUD_RUN_TIMING } from '../../src/deployment-queue/cloud-runs-concurrency.provider';
import {
  CANCEL_REFUSED_WHILE_APPLYING,
  CLOUD_RUN_EXECUTOR,
  CloudRunsService,
  CUT_OFF_BY_RESTART,
} from '../../src/deployment-queue/cloud-runs.service';
import type { CloudRunShape } from '../../src/deployments/deployment.schema';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { LicenseService } from '../../src/enterprise/license/license.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { FakeCloudRunner } from '../utils/fake-cloud-runner';
import { freezeOrganization } from '../utils/frozen-organization';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';

jest.setTimeout(60_000);

/** A minute of time limit, and the 5-minute kill grace, made short. */
const MINUTE_MS = 100;
const KILL_GRACE_MS = 150;

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ctxOf = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/**
 * The Cloud run pool end to end (spec seam 1): the pool limit and
 * its licence rule, per-Service and per-Environment ordering, reads joining,
 * Cancel before apply and refused during it, Stop the run and the time limit
 * (with a run that hangs), start-up settling of `pending` and `running` cloud
 * rows, and the two settings.
 *
 * Real here: `CloudRunsService`, its pool, its settings read off the settings
 * row, `DeploymentsService` and both routes. Faked: the run's work
 * (`FakeCloudRunner` at `CLOUD_RUN_EXECUTOR`, until the real one is
 * bound) and the clock lengths (`CLOUD_RUN_TIMING`), so a "5-minute" kill grace
 * is a fraction of a second rather than fake timers under Testcontainers.
 */
describe('Cloud run lifecycle (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cloudRuns: CloudRunsService;
  let deployments: DeploymentsService;
  let license: LicenseService;
  const runner = new FakeCloudRunner();
  const logs = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloud-run-logs-'));
  /** Every run this test submitted, awaited after it so none outlives it. */
  let submitted: Promise<CloudRunEnding>[] = [];

  const execMock = {
    execAsync: jest.fn(() =>
      Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    ),
    execAsyncRemote: jest.fn(() =>
      Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    ),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: CLOUD_RUN_EXECUTOR, useValue: runner.executor },
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
    server = ctx.app.getHttpServer() as App;
    cloudRuns = ctx.app.get(CloudRunsService);
    deployments = ctx.app.get(DeploymentsService);
    license = ctx.app.get(LicenseService);
  });

  afterAll(async () => {
    await ctx.teardown();
    fs.rmSync(logs, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  afterEach(async () => {
    runner.reset();
    await Promise.all(submitted);
    submitted = [];
    jest.restoreAllMocks();
  });

  async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** An owner, a project, an Environment and `count` Applications in it. */
  async function setUp(count = 1) {
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    const cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const userId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = ctxOf(userId, organizationId);
    const project = await ctx.app
      .get(ProjectsService)
      .create(ownerCtx, { name: 'cloudgate' });
    const environment = await ctx.app
      .get(EnvironmentsService)
      .create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
    const applicationIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const created = await ctx.app.get(ApplicationsService).create(ownerCtx, {
        name: `Web ${i}`,
        appName: `web-${i}`,
        environmentId: environment.environmentId,
      });
      applicationIds.push(created.applicationId);
    }
    return {
      cookie,
      organizationId,
      ownerCtx,
      environmentId: environment.environmentId,
      applicationIds,
    };
  }

  /** A Deployment of the Application, recorded for a Cloud run. */
  async function row(applicationId: string, title = 'Cloud deploy') {
    const [inserted] = await ctx.db
      .insert(deploymentTable)
      .values({
        applicationId,
        title,
        status: 'running',
        logPath: nodePath.join(logs, `${title}-${Date.now()}.log`),
      })
      .returning();
    return inserted.deploymentId;
  }

  const deployShape = (
    applicationId: string,
    environmentId: string,
  ): CloudRunShape => ({
    kind: 'deploy',
    stateKey: `application:${applicationId}`,
    environmentId,
    touchesNetwork: false,
  });

  function submit(deploymentId: string, shape: CloudRunShape) {
    const ended = cloudRuns.submit(deploymentId, shape);
    submitted.push(ended);
    return ended;
  }

  /** Submit, and wait until the run is in the pool (its row is written first). */
  async function queue(deploymentId: string, shape: CloudRunShape) {
    void submit(deploymentId, shape);
    await until(() => cloudRuns.phaseOf(deploymentId) !== null);
  }

  async function statusOf(deploymentId: string) {
    const [found] = await ctx.db
      .select()
      .from(deploymentTable)
      .where(eq(deploymentTable.deploymentId, deploymentId));
    return found;
  }

  const licensed = () =>
    jest.spyOn(license, 'hasAnyValidLicense').mockResolvedValue(true);

  describe('the pool limit', () => {
    it('runs one Cloud run at a time unlicensed, whatever is set, and the configured number with a licence', async () => {
      const { cookie, environmentId, applicationIds } = await setUp(3);
      const saved = await request(server)
        .post('/settings/cloud-runs-concurrency')
        .set('Cookie', cookie)
        .send({ cloudRunsConcurrency: 2 });
      expect(saved.status).toBe(200);

      const [a, b, c] = await Promise.all(applicationIds.map((id) => row(id)));
      await queue(a, deployShape(applicationIds[0], environmentId));
      await queue(b, deployShape(applicationIds[1], environmentId));
      await until(() => runner.eventsOf(a).includes('plan'));
      expect((await statusOf(a)).status).toBe('running');
      expect((await statusOf(b)).status).toBe('pending');
      expect(cloudRuns.phaseOf(b)).toBe('waiting');

      licensed();
      await queue(c, deployShape(applicationIds[2], environmentId));
      await until(() => runner.eventsOf(b).includes('plan'));
      // Two now run; the third waits for one of them.
      expect(cloudRuns.phaseOf(c)).toBe('waiting');

      runner.finishPlan(a);
      runner.finishApply(a);
      await until(() => runner.eventsOf(c).includes('plan'));
      expect((await statusOf(a)).status).toBe('done');
    });
  });

  describe('ordering', () => {
    it('never overlaps two runs of one Service, and a network run holds back its Environment', async () => {
      licensed();
      const { cookie, environmentId, applicationIds } = await setUp(2);
      await request(server)
        .post('/settings/cloud-runs-concurrency')
        .set('Cookie', cookie)
        .send({ cloudRunsConcurrency: 5 });
      const [x, y] = applicationIds;

      const first = await row(x, 'first');
      const second = await row(x, 'second');
      const net = await row(y, 'network');
      const after = await row(y, 'after-network');
      await queue(first, deployShape(x, environmentId));
      await queue(second, deployShape(x, environmentId));
      await queue(net, {
        kind: 'network',
        stateKey: `network:${environmentId}`,
        environmentId,
        touchesNetwork: true,
      });
      await queue(after, deployShape(y, environmentId));
      await until(() => runner.eventsOf(first).includes('plan'));

      // The second run of x waits for the first, the network run waits for
      // every run of the Environment, and the run after it waits for it.
      expect(cloudRuns.phaseOf(second)).toBe('waiting');
      expect(cloudRuns.phaseOf(net)).toBe('waiting');
      expect(cloudRuns.phaseOf(after)).toBe('waiting');

      runner.finishPlan(first);
      runner.finishApply(first);
      await until(() => runner.eventsOf(second).includes('plan'));
      expect(cloudRuns.phaseOf(net)).toBe('waiting');

      runner.finishPlan(second);
      runner.finishApply(second);
      await until(() => runner.eventsOf(net).includes('plan'));
      expect(cloudRuns.phaseOf(after)).toBe('waiting');

      runner.finishPlan(net);
      runner.finishApply(net);
      await until(() => runner.eventsOf(after).includes('plan'));
    });
  });

  describe('plan-only reads', () => {
    it('lets a waiting deploy go first, and joins a second request for the same state', async () => {
      const { environmentId, applicationIds } = await setUp(2);
      const [busy, deploy] = await Promise.all([
        row(applicationIds[0], 'busy'),
        row(applicationIds[1], 'deploy'),
      ]);
      await queue(busy, deployShape(applicationIds[0], environmentId));
      await until(() => runner.eventsOf(busy).includes('plan'));

      const stateKey = `application:${applicationIds[0]}`;
      const read = cloudRuns.read({
        stateKey,
        environmentId,
        touchesNetwork: false,
      });
      await queue(deploy, deployShape(applicationIds[1], environmentId));
      const joined = cloudRuns.read({
        stateKey,
        environmentId,
        touchesNetwork: false,
      });
      submitted.push(read, joined);

      runner.finishPlan(busy);
      runner.finishApply(busy);
      await until(() => runner.eventsOf(deploy).includes('plan'));
      expect(runner.eventsOf(`read:${stateKey}`)).toEqual([]);

      runner.finishPlan(deploy);
      runner.finishApply(deploy);
      await until(() => runner.eventsOf(`read:${stateKey}`).includes('plan'));
      runner.finishPlan(`read:${stateKey}`);
      expect(await read).toEqual(await joined);
      expect(await read).toEqual({
        kind: 'finished',
        value: `read:${stateKey}`,
      });
    });
  });

  describe('Cancel', () => {
    it('takes a waiting run out of the pool, and interrupts a planning one — both end cancelled', async () => {
      const { cookie, environmentId, applicationIds } = await setUp(2);
      const [planning, waiting] = await Promise.all([
        row(applicationIds[0], 'planning'),
        row(applicationIds[1], 'waiting'),
      ]);
      await queue(planning, deployShape(applicationIds[0], environmentId));
      await queue(waiting, deployShape(applicationIds[1], environmentId));
      await until(() => runner.eventsOf(planning).includes('plan'));

      const dequeued = await request(server)
        .post(`/deployments/${waiting}/cancel`)
        .set('Cookie', cookie);
      expect(dequeued.status).toBe(200);
      expect(dequeued.body).toMatchObject({ status: 'cancelled' });

      const interrupted = await request(server)
        .post(`/deployments/${planning}/cancel`)
        .set('Cookie', cookie);
      expect(interrupted.status).toBe(200);
      expect(interrupted.body).toMatchObject({ status: 'cancelled' });
      await until(() => runner.eventsOf(planning).includes('end'));
      expect(runner.eventsOf(planning)).toEqual(['plan', 'interrupt', 'end']);
      expect(runner.eventsOf(waiting)).toEqual([]);
      expect((await statusOf(planning)).status).toBe('cancelled');
    });

    it('is refused once the apply has begun, with the sentence, and the run goes on', async () => {
      const { cookie, environmentId, applicationIds } = await setUp();
      const id = await row(applicationIds[0]);
      await queue(id, deployShape(applicationIds[0], environmentId));
      await until(() => runner.eventsOf(id).includes('plan'));
      runner.finishPlan(id);
      await until(() => runner.eventsOf(id).includes('apply'));

      const refused = await request(server)
        .post(`/deployments/${id}/cancel`)
        .set('Cookie', cookie);
      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        CANCEL_REFUSED_WHILE_APPLYING,
      );
      expect(runner.eventsOf(id)).not.toContain('interrupt');
      expect((await statusOf(id)).status).toBe('running');
    });
  });

  describe('Stop the run', () => {
    it('interrupts, kills a run that hangs 5 minutes later, and ends the row error naming who', async () => {
      const { cookie, environmentId, applicationIds } = await setUp();
      const id = await row(applicationIds[0]);
      runner.hang(id);
      const ended = submit(id, deployShape(applicationIds[0], environmentId));
      await until(() => runner.eventsOf(id).includes('plan'));
      runner.finishPlan(id);
      await until(() => runner.eventsOf(id).includes('apply'));

      const stopping = await request(server)
        .post(`/deployments/${id}/stop-run`)
        .set('Cookie', cookie);
      expect(stopping.status).toBe(200);
      expect(stopping.body).toMatchObject({ status: 'running' });
      expect(runner.eventsOf(id)).toEqual(['plan', 'apply', 'interrupt']);

      expect(await ended).toEqual({ kind: 'stopped', by: 'Grace Hopper' });
      expect(runner.eventsOf(id)).toEqual([
        'plan',
        'apply',
        'interrupt',
        'kill',
        'end',
      ]);
      const settled = await statusOf(id);
      expect(settled.status).toBe('error');
      expect(settled.description).toBe(
        'Stopped by Grace Hopper. Changes made so far stay in your AWS account; the next deploy picks up from them.',
      );
      expect(fs.readFileSync(settled.logPath, 'utf8')).toContain(
        'Stopped by Grace Hopper.',
      );
    });

    it('refuses a run still waiting (Cancel’s) and a deployment that is no Cloud run', async () => {
      const { cookie, environmentId, applicationIds } = await setUp(2);
      const [running, waiting] = await Promise.all([
        row(applicationIds[0], 'running'),
        row(applicationIds[1], 'waiting'),
      ]);
      const build = await row(applicationIds[0], 'a build');
      await queue(running, deployShape(applicationIds[0], environmentId));
      await queue(waiting, deployShape(applicationIds[1], environmentId));
      await until(() => runner.eventsOf(running).includes('plan'));

      const early = await request(server)
        .post(`/deployments/${waiting}/stop-run`)
        .set('Cookie', cookie);
      expect(early.status).toBe(409);
      const notCloud = await request(server)
        .post(`/deployments/${build}/stop-run`)
        .set('Cookie', cookie);
      expect(notCloud.status).toBe(409);
      // Taken out, so it does not start once the test lets the first go.
      cloudRuns.cancel(waiting);
    });

    it('is open to an agentOperator and closed to an agentReader, like Cancel', async () => {
      const { cookie, organizationId, environmentId, applicationIds } =
        await setUp();
      const agent = async (role: 'agentReader' | 'agentOperator') => {
        const res = await request(server)
          .post('/agents')
          .set('Cookie', cookie)
          .send({
            name: `${role}-bot`,
            role,
            grant: { accessedServices: applicationIds },
          });
        expect(res.status).toBe(201);
        return (res.body as { agent: { id: string } }).agent.id;
      };
      const reader = await agent('agentReader');
      const operator = await agent('agentOperator');
      const id = await row(applicationIds[0]);
      await queue(id, deployShape(applicationIds[0], environmentId));
      await until(() => runner.eventsOf(id).includes('plan'));

      await expect(
        deployments.stopRun(ctxOf(reader, organizationId), id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        deployments.stopRun(ctxOf(operator, organizationId), id),
      ).resolves.toMatchObject({ deploymentId: id });
    });
  });

  describe('the time limit', () => {
    it('ends a hung run with one interrupt, then a kill, as an error that names the limit', async () => {
      const { cookie, environmentId, applicationIds } = await setUp();
      const saved = await request(server)
        .post('/settings/cloud-run-time-limit')
        .set('Cookie', cookie)
        .send({ cloudRunTimeLimitMinutes: 5 });
      expect(saved.status).toBe(200);

      const id = await row(applicationIds[0]);
      runner.hang(id);
      const ended = await submit(
        id,
        deployShape(applicationIds[0], environmentId),
      );

      expect(ended).toEqual({ kind: 'timed-out', minutes: 5 });
      expect(runner.eventsOf(id)).toEqual(['plan', 'interrupt', 'kill', 'end']);
      const settled = await statusOf(id);
      expect(settled.status).toBe('error');
      expect(settled.description).toBe(
        'Ended by the Cloud run time limit of 5 minutes. Changes made so far stay in your AWS account; the next deploy picks up from them.',
      );
    });
  });

  describe('start-up', () => {
    it('settles a cloud row still running as cut off, and queues a cloud row still pending again', async () => {
      const { environmentId, applicationIds } = await setUp();
      const shape = deployShape(applicationIds[0], environmentId);
      const cutOff = await row(applicationIds[0], 'cut-off');
      const queued = await row(applicationIds[0], 'queued');
      const build = await row(applicationIds[0], 'plain build');
      await ctx.db
        .update(deploymentTable)
        .set({ cloudRun: shape, status: 'running' })
        .where(eq(deploymentTable.deploymentId, cutOff));
      await ctx.db
        .update(deploymentTable)
        .set({ cloudRun: shape, status: 'pending' })
        .where(eq(deploymentTable.deploymentId, queued));

      await cloudRuns.settleAtStartUp();

      const settled = await statusOf(cutOff);
      expect(settled.status).toBe('error');
      expect(settled.description).toBe(CUT_OFF_BY_RESTART);
      expect(runner.eventsOf(cutOff)).toEqual([]);
      await until(() => runner.eventsOf(queued).includes('plan'));
      expect((await statusOf(queued)).status).toBe('running');
      // A build's row is not a cloud row, and is left as it was.
      expect((await statusOf(build)).status).toBe('running');

      runner.finishPlan(queued);
      runner.finishApply(queued);
      await until(async () => (await statusOf(queued)).status === 'done');
    });
  });

  // A real AWS walk's Delete: the network's removal was cut off by a
  // restart, its row ended error, and the network stayed `deleting`, so
  // Retry was refused for good as "being removed. Wait until its Deployment
  // ends". The network now reads as a run that failed would leave it.
  describe('start-up, a network run cut off', () => {
    it.each([
      ['deleting', 'delete-incomplete'],
      ['creating', 'create-failed'],
    ] as const)('settles a network left %s as %s', async (left, settledAs) => {
      const { environmentId, organizationId, applicationIds } = await setUp();
      const [account] = await ctx.db
        .insert(cloudAccount)
        .values({
          organizationId,
          name: 'AWS',
          cloud: 'aws',
          cloudId: '123456789012',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
          taskExecutionRoleArn:
            'arn:aws:iam::123456789012:role/cloudgate-task-execution',
          externalId: 'external-id',
          policyVersion: 1,
          lastCheckedAt: new Date().toISOString(),
          lastCheckResult: 'passed',
        })
        .returning();
      const [network] = await ctx.db
        .insert(environmentNetwork)
        .values({
          environmentId,
          cloudAccountId: account.cloudAccountId,
          region: 'us-east-1',
          status: left,
        })
        .returning();
      const run = await row(applicationIds[0], 'network run');
      await ctx.db
        .update(deploymentTable)
        .set({
          applicationId: null,
          environmentNetworkId: network.environmentNetworkId,
          cloudRun: {
            kind: 'network',
            stateKey: `network:${network.environmentNetworkId}`,
            environmentId,
            touchesNetwork: true,
          },
          status: 'running',
        })
        .where(eq(deploymentTable.deploymentId, run));

      await cloudRuns.settleAtStartUp();

      expect((await statusOf(run)).status).toBe('error');
      const [after] = await ctx.db
        .select()
        .from(environmentNetwork)
        .where(
          eq(
            environmentNetwork.environmentNetworkId,
            network.environmentNetworkId,
          ),
        );
      expect(after.status).toBe(settledAs);
    });
  });

  describe('settings', () => {
    it('validates the pool limit and time limit, and holds them to instance authority', async () => {
      const { cookie } = await setUp();
      const tooMany = await request(server)
        .post('/settings/cloud-runs-concurrency')
        .set('Cookie', cookie)
        .send({ cloudRunsConcurrency: 21 });
      expect(tooMany.status).toBe(400);
      const tooShort = await request(server)
        .post('/settings/cloud-run-time-limit')
        .set('Cookie', cookie)
        .send({ cloudRunTimeLimitMinutes: 4 });
      expect(tooShort.status).toBe(400);

      const member = await signUpMember(server, cookie);
      for (const [route, body] of [
        ['cloud-runs-concurrency', { cloudRunsConcurrency: 2 }],
        ['cloud-run-time-limit', { cloudRunTimeLimitMinutes: 30 }],
      ] as const) {
        const denied = await request(server)
          .post(`/settings/${route}`)
          .set('Cookie', member.cookie)
          .send(body);
        expect([route, denied.status]).toEqual([route, 403]);
      }

      const settings = await request(server)
        .get('/settings/web-server')
        .set('Cookie', cookie);
      expect(settings.body).toMatchObject({
        cloudRunsConcurrency: 1,
        cloudRunTimeLimitMinutes: 60,
      });
    });
  });

  describe('of a Frozen Organization', () => {
    /** Lets the run's plan and apply finish as soon as it reaches them. */
    const goes = (id: string) => {
      runner.finishPlan(id);
      runner.finishApply(id);
    };

    it('refuses a deploy, network, plan read or Domain run before it waits, its row ending with the refusal', async () => {
      const { organizationId, environmentId, applicationIds } = await setUp();
      const [applicationId] = applicationIds;
      await freezeOrganization(ctx, organizationId);

      for (const kind of ['deploy', 'network', 'domain', 'database'] as const) {
        const id = await row(applicationId, `Refused ${kind}`);
        goes(id);
        const ending = await submit(id, {
          ...deployShape(applicationId, environmentId),
          kind,
        });
        expect(ending).toEqual({ kind: 'failed', message: 'Pay to continue' });
        expect(runner.eventsOf(id)).toEqual([]);
        expect(await statusOf(id)).toMatchObject({
          status: 'error',
          description: 'Pay to continue',
        });
        expect(fs.readFileSync((await statusOf(id)).logPath, 'utf8')).toBe(
          'Pay to continue\n',
        );
      }

      const read = await cloudRuns.read({
        stateKey: `application:${applicationId}`,
        environmentId,
        touchesNetwork: false,
      });
      expect(read).toEqual({ kind: 'failed', message: 'Pay to continue' });
      expect(runner.runs.size).toBe(0);
    });

    it('still runs a Delete and a network removal, which take things out of the cloud', async () => {
      const { organizationId, environmentId, applicationIds } = await setUp();
      const [applicationId] = applicationIds;
      await freezeOrganization(ctx, organizationId);

      for (const kind of ['destroy', 'network-destroy'] as const) {
        const id = await row(applicationId, `Removal ${kind}`);
        goes(id);
        const ending = await submit(id, {
          ...deployShape(applicationId, environmentId),
          kind,
        });
        expect(ending.kind).toBe('finished');
        expect(runner.eventsOf(id)).toEqual(['plan', 'apply', 'end']);
      }
    });

    it('lets the Cloud run of a deploy whose build already ran go on to its end', async () => {
      const { organizationId, environmentId, applicationIds } = await setUp();
      const [applicationId] = applicationIds;
      const id = await row(applicationId, 'Built before the freeze');
      await freezeOrganization(ctx, organizationId);

      goes(id);
      await cloudRuns.handOff(id, deployShape(applicationId, environmentId));

      await until(async () => (await statusOf(id)).status === 'done');
      expect(runner.eventsOf(id)).toEqual(['plan', 'apply', 'end']);
    });

    it('refuses a run that was waiting in the pool when the Organization froze', async () => {
      const { organizationId, environmentId, applicationIds } = await setUp(2);
      const ahead = await row(applicationIds[0], 'Ahead in the pool');
      const waiting = await row(applicationIds[1], 'Waiting in the pool');
      await queue(ahead, deployShape(applicationIds[0], environmentId));
      await until(() => runner.eventsOf(ahead).includes('plan'));
      const ended = submit(
        waiting,
        deployShape(applicationIds[1], environmentId),
      );
      await until(() => cloudRuns.phaseOf(waiting) !== null);

      await freezeOrganization(ctx, organizationId);
      goes(ahead);
      goes(waiting);

      expect(await ended).toEqual({
        kind: 'failed',
        message: 'Pay to continue',
      });
      expect(runner.eventsOf(waiting)).toEqual([]);
      expect(await statusOf(waiting)).toMatchObject({
        status: 'error',
        description: 'Pay to continue',
      });
    });

    it('refuses a pending run start-up queues again, and still re-queues a removal and a handed-off deploy', async () => {
      const { organizationId, environmentId, applicationIds } = await setUp(3);
      const pending = async (
        applicationId: string,
        title: string,
        shape: CloudRunShape,
      ) => {
        const id = await row(applicationId, title);
        await ctx.db
          .update(deploymentTable)
          .set({ cloudRun: shape, status: 'pending' })
          .where(eq(deploymentTable.deploymentId, id));
        goes(id);
        return id;
      };
      const deploy = await pending(
        applicationIds[0],
        'Queued deploy',
        deployShape(applicationIds[0], environmentId),
      );
      const removal = await pending(applicationIds[1], 'Queued removal', {
        ...deployShape(applicationIds[1], environmentId),
        kind: 'destroy',
      });
      const handedOff = await pending(applicationIds[2], 'Built, then queued', {
        ...deployShape(applicationIds[2], environmentId),
        afterBuild: true,
      });
      await freezeOrganization(ctx, organizationId);

      await cloudRuns.settleAtStartUp();

      await until(async () => (await statusOf(deploy)).status === 'error');
      expect((await statusOf(deploy)).description).toBe('Pay to continue');
      expect(runner.eventsOf(deploy)).toEqual([]);
      await until(async () => (await statusOf(removal)).status === 'done');
      await until(async () => (await statusOf(handedOff)).status === 'done');
      expect(runner.eventsOf(handedOff)).toEqual(['plan', 'apply', 'end']);
    });

    it('re-queues the same pending run at start-up on a Self-hosted instance, where nothing is frozen', async () => {
      const { organizationId, environmentId, applicationIds } = await setUp();
      const id = await row(applicationIds[0], 'Queued deploy');
      await ctx.db
        .update(deploymentTable)
        .set({
          cloudRun: deployShape(applicationIds[0], environmentId),
          status: 'pending',
        })
        .where(eq(deploymentTable.deploymentId, id));
      await freezeOrganization(ctx, organizationId);
      jest
        .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
        .mockReturnValue(false);
      goes(id);

      await cloudRuns.settleAtStartUp();

      await until(async () => (await statusOf(id)).status === 'done');
      expect(runner.eventsOf(id)).toEqual(['plan', 'apply', 'end']);
    });
  });
});
