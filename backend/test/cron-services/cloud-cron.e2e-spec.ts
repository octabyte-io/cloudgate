import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { CRON_RUN_POLL_MS } from '../../src/cron-services/cron-runs.service';
import { CronRunsService } from '../../src/cron-services/cron-runs.service';
import { CRON_SERVICE_CLOCK } from '../../src/cron-services/cron-service.clock';
import { CronTimetable } from '../../src/cron-services/cron-timetable.service';
import {
  application,
  cloudAccount,
  deployment,
  licenseKey,
  member,
  organizationRole,
  plan as planTable,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { deploymentLogsDirectoryOn } from '../../src/deployment-engine/deployment-engine.paths';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import {
  fakeSecurityGroupId,
  fakeTaskDefinitionArn,
} from '../utils/fake-cloud-port';
import type { FakeCloudPort } from '../utils/fake-cloud-port';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

/** Weekdays at 03:00 UTC, held to 30 minutes. */
const REPORT = `version: 1
services:
  report:
    kind: cron
    size: small
    command: node dist/report.js
    args: [--all]
    schedule: "0 3 * * MON-FRI"
    timeout: 30m
    source: { image: acme/reports:1 }
`;

/** What `tofu output -json` answers after the network's apply. */
const OUTPUTS = {
  vpc_id: 'vpc-0f00ba11',
  public_subnet_ids: ['subnet-0a11', 'subnet-0b22'],
  private_subnet_ids: ['subnet-0c33', 'subnet-0d44'],
  cluster_arn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/cloudgate-env`,
  alb_arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/cg/50dc6c495c0c9188`,
  alb_dns_name: `cg-1234567890.${REGION}.elb.amazonaws.com`,
  alb_zone_id: 'Z215JYRZR1TBD5',
  alb_security_group_id: 'sg-0a1b',
  https_listener_arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/cg/50dc6c495c0c9188/f2f7dc8efc522ab2`,
  default_certificate_arn: `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/0e4a7d52-2b1c-4f0d-9a43-5b3c1c2d7e11`,
};

/** A `docker` that pulls, pushes, logs in and inspects without a daemon. */
const FAKE_DOCKER = `#!/bin/bash
case "$1" in
  login) cat > /dev/null; echo "Login Succeeded" ;;
  pull) echo "Status: Downloaded newer image for $2" ;;
  push) echo "\${2##*:}: digest: sha256:0f1e size: 1570" ;;
  image)
    if [ "$2" = inspect ]; then
      case "$4" in
        *Healthcheck*) echo "amd64 \${FAKE_DOCKER_HEALTHCHECK:-null}" ;;
        *) echo "amd64" ;;
      esac
    fi ;;
esac
exit 0
`;

/** Monday 2026-09-28, an hour before the report's first fire time. */
const MONDAY_0200 = Date.parse('2026-09-28T02:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MONDAY_0300 = MONDAY_0200 + HOUR;

/**
 * **a Cron service on AWS** (stories 25–47; ADR-0034 as
 * amended). Its config plans and applies into a Cloud account as a
 * task definition with no ECS service, and Cloudgate's own timetable fires
 * each run as one `RunTask` of the revision its last successful build
 * wrote. A run is the same Run record as on a Server, its log copied from
 * the task's own CloudWatch stream while it runs, its result its exit code.
 *
 * Driven by the injected Cron service clock, against the faked ECS of the
 * cloud port (`ctx.cloud`) and a real shell whose `docker` is the fake
 * above, so every Deployment log is a real file.
 */
describe('A Cron service on AWS (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  let applicationId: string;
  let stateId: string;
  let built: Deployment;

  let now = MONDAY_0200;
  const clock = { now: () => now };

  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-cron-'));
  const bin = nodePath.join(root, 'bin');
  const saved = { root: process.env.CLOUDGATE_DIRECTORY };

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

  const timetable = () => ctx.app.get(CronTimetable);
  const runs = () => ctx.app.get(CronRunsService);

  beforeAll(async () => {
    process.env.CLOUDGATE_DIRECTORY = root;
    fs.mkdirSync(bin);
    fs.writeFileSync(nodePath.join(bin, 'docker'), FAKE_DOCKER, {
      mode: 0o755,
    });
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: CRON_SERVICE_CLOCK, useValue: clock },
        { provide: CRON_RUN_POLL_MS, useValue: 10 },
      ],
    });
    http = ctx.app.getHttpServer() as App;
    ctx.app.get(CloudServiceDeploys).pollIntervalMs = 10;
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (saved.root === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = saved.root;
    delete process.env.FAKE_DOCKER_HEALTHCHECK;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    delete process.env.FAKE_DOCKER_HEALTHCHECK;
    now = MONDAY_0200;
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

    const [row] = await ctx.db
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
        policyVersion: 2,
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
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;

    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('cron', 'cron-create');
  });

  async function openPlan(): Promise<Plan> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.status, 'open'));
      if (
        found &&
        !found.steps.some(
          (step) =>
            'cloudRead' in step &&
            step.cloudRead !== undefined &&
            step.cloudRead.status === 'reading',
        )
      ) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading AWS');
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

  async function planned(text: string): Promise<Plan> {
    const res = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });
    expect(res.status).toBe(201);
    return openPlan();
  }

  async function apply(read: Plan): Promise<Plan> {
    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    return settledPlan(read.planId);
  }

  /** Plans the report, applies it, and waits for its first deploy. */
  async function appliedCron(text = REPORT): Promise<Plan> {
    const read = await planned(text);
    const networkStep = read.steps[0];
    if (networkStep.action !== 'network-create') throw new Error('no network');
    if (networkStep.cloudRead.status !== 'read') throw new Error('not read');
    ctx.cloud.outputsFor(networkStep.cloudRead.stateId, OUTPUTS);
    const step = read.steps[1];
    if (step.action !== 'create' || step.cloudRead?.status !== 'read') {
      throw new Error('the cron was not read');
    }
    stateId = step.cloudRead.stateId;

    const applied = await apply(read);
    const result = applied.results!.find((one) => one.configName === 'report')!;
    expect(result).toMatchObject({ status: 'applied', domain: null });
    if (result.deploy?.status !== 'queued') throw new Error('not queued');
    built = await settledDeployment(result.deploy.deploymentId);
    applicationId = result.serviceId!;
    return read;
  }

  /** The definition the state's last tofu run was handed. */
  function definitionWritten() {
    const input = ctx.cloud.tofuInputs.filter((one) => one.stateId === stateId);
    return JSON.parse(input.at(-1)!.definition) as {
      resource: Record<string, Record<string, Record<string, unknown>>>;
    };
  }

  async function recordOf(deploymentId: string): Promise<Deployment> {
    const [row] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId));
    return row;
  }

  const logLines = (logPath: string) =>
    fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');

  /** The report's run of Monday 03:00, fired by the timetable. */
  async function firedRun(): Promise<Deployment> {
    now = MONDAY_0300 - 5_000;
    timetable().arm();
    now = MONDAY_0300 + 5_000;
    const [record] = await timetable().tick();
    expect(record).toBeDefined();
    return record;
  }

  const taskOf = async (record: Deployment) => {
    const { cronRun } = await recordOf(record.deploymentId);
    const task = ctx.cloud.tasksStarted.find(
      (one) => one.taskArn === cronRun?.taskArn,
    );
    if (!task) throw new Error('No task for the run');
    return task;
  };

  const stops = () =>
    ctx.cloud.calls.filter((call) => call.method === 'ecsStopTask');

  const logGroup = () => `/cloudgate/${environmentId}/${applicationId}`;

  async function until(done: () => boolean | Promise<boolean>) {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (await done()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('It never happened');
  }

  describe('its plan and Apply', () => {
    it('plans its ECR repository, task definition, task role, SSM parameters, log group and security group, with no ECS service or scheduler', async () => {
      const read = await appliedCron();

      const step = read.steps[1];
      if (step.action !== 'create' || step.cloudRead?.status !== 'read') {
        throw new Error('the cron was not read');
      }
      expect(step).toMatchObject({ kind: 'cron' });
      const addresses = step.cloudRead.raw.map((line) => line.address);
      expect(addresses).toEqual(
        expect.arrayContaining([
          'aws_ecr_repository.service',
          'aws_ecs_task_definition.service',
          'aws_iam_role.task',
          'aws_ssm_parameter.variable["API_KEY"]',
          'aws_cloudwatch_log_group.service',
          'aws_security_group.service',
        ]),
      );
      expect(
        addresses.filter((one) =>
          /aws_ecs_service|aws_scheduler|aws_lb_/.test(one),
        ),
      ).toEqual([]);
      const written = definitionWritten();
      expect(Object.keys(written.resource)).not.toContain('aws_ecs_service');
      expect(written.resource.aws_security_group.service.ingress).toEqual([]);

      const [created] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(created).toMatchObject({
        configKind: 'cron',
        cloudAccountId,
        region: REGION,
        cronSchedule: '0 3 * * MON-FRI',
        cronTimeoutSeconds: 1800,
      });
    });

    it('deploys a task definition with its command and no healthCheck, even when the image has a HEALTHCHECK, and starts no task', async () => {
      process.env.FAKE_DOCKER_HEALTHCHECK = JSON.stringify({
        Test: ['CMD-SHELL', 'test -f /tmp/alive'],
      });
      await appliedCron();

      expect(built.status).toBe('done');
      const [container] = JSON.parse(
        definitionWritten().resource.aws_ecs_task_definition.service
          .container_definitions as string,
      ) as Record<string, unknown>[];
      expect(container).not.toHaveProperty('healthCheck');
      expect(container).toMatchObject({
        entryPoint: ['node', 'dist/report.js'],
        command: ['--all'],
      });
      // Its revision and group, which a run is started with.
      expect(built.cloudRun?.cronTask).toEqual({
        taskDefinitionArn: fakeTaskDefinitionArn(
          REGION,
          `cloudgate-${applicationId}`,
          1,
        ),
        securityGroupId: fakeSecurityGroupId(stateId),
      });
      expect(built.cronImage).toBe(
        `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/cloudgate/${applicationId.toLowerCase()}:${built.deploymentId}`,
      );
      expect(fs.readFileSync(built.logPath, 'utf8')).toContain(
        "✅ [Cloud run] report's runs start from the image of this Deployment; no run was started",
      );
      expect(ctx.cloud.tasksStarted).toEqual([]);
      expect(
        ctx.cloud.calls.filter(
          (call) =>
            call.method === 'ecsSetDesiredCount' ||
            call.method === 'ecsRollout',
        ),
      ).toEqual([]);
    });

    it.each([
      [
        'schedule',
        'schedule: "0 3 * * MON-FRI"',
        'schedule: "0 4 * * *"',
        { cronSchedule: '0 4 * * *' },
      ],
      [
        'timezone',
        'timeout: 30m',
        'timeout: 30m\n    timezone: Europe/Berlin',
        { cronTimezone: 'Europe/Berlin' },
      ],
      ['timeout', 'timeout: 30m', 'timeout: 45m', { cronTimeoutSeconds: 2700 }],
    ])(
      'shows a changed %s as a Cloudgate setting with no AWS line, and applies it with no AWS call',
      async (field, from, to, saved) => {
        await appliedCron();
        const calls = ctx.cloud.calls.length;

        const read = await planned(REPORT.replace(from, to));
        expect(read.steps).toEqual([
          expect.objectContaining({
            action: 'change',
            configName: 'report',
            fields: [expect.objectContaining({ field })],
          }),
        ]);
        expect(read.steps[0]).not.toHaveProperty('cloudRead');
        const applied = await apply(read);

        expect(applied.results).toEqual([
          expect.objectContaining({ configName: 'report', status: 'applied' }),
        ]);
        expect(ctx.cloud.calls.slice(calls)).toEqual([]);
        const [row] = await ctx.db
          .select()
          .from(application)
          .where(eq(application.applicationId, applicationId));
        expect(row).toMatchObject(saved);
        // No deploy either: nothing of it is in AWS.
        const rows = await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.applicationId, applicationId));
        expect(rows).toHaveLength(1);
      },
    );

    it('shows a changed command as an AWS line on the task definition', async () => {
      await appliedCron();
      ctx.cloud.replayPlanFor('cron', 'cron-new-revision');

      const read = await planned(
        REPORT.replace('node dist/report.js', 'node dist/report-v2.js'),
      );

      const [step] = read.steps;
      if (step.action !== 'change' || step.cloudRead?.status !== 'read') {
        throw new Error('the change did not read AWS');
      }
      expect(step.fields).toEqual([
        expect.objectContaining({ field: 'command' }),
      ]);
      expect(step.cloudRead.raw).toEqual([
        expect.objectContaining({
          address: 'aws_ecs_task_definition.service',
          action: 'replace',
        }),
      ]);
      const [container] = JSON.parse(
        definitionWritten().resource.aws_ecs_task_definition.service
          .container_definitions as string,
      ) as Record<string, unknown>[];
      expect(container.entryPoint).toEqual(['node', 'dist/report-v2.js']);
    });
  });

  describe('a run', () => {
    beforeEach(async () => {
      await appliedCron();
    });

    it('is one task a tick starts, of the last build’s revision, in the network’s public subnets with a public IP and its own group; the task ARN on its Run record', async () => {
      const record = await firedRun();

      expect(
        ctx.cloud.calls.filter((call) => call.method === 'ecsRunTask'),
      ).toEqual([
        expect.objectContaining({
          region: REGION,
          cluster: OUTPUTS.cluster_arn,
          taskDefinitionArn: built.cloudRun!.cronTask!.taskDefinitionArn,
          subnets: OUTPUTS.public_subnet_ids,
          securityGroups: [fakeSecurityGroupId(stateId)],
          startedBy: record.cronRun!.job,
        }),
      ]);
      const task = await taskOf(record);
      expect(record.cronRun!.image).toBe(built.cronImage);
      expect((await recordOf(record.deploymentId)).cronRun).toMatchObject({
        taskArn: task.taskArn,
      });
      expect(logLines(record.logPath)[0]).toBe(
        `▶️ [Run] Starting '${built.cronImage}' as a one-off ECS task (${record.cronRun!.job}), started by the timetable`,
      );

      ctx.cloud.endTask(task.taskArn, 0);
      await runs().whenSettled(record.deploymentId);
    });

    it.each([
      [0, 'done'],
      [3, 'error'],
    ])(
      'copies its own stream into its log while it runs, and ends by its exit code: %i is %s',
      async (exitCode, status) => {
        const record = await firedRun();
        const task = await taskOf(record);

        ctx.cloud.printTask(logGroup(), task.taskArn, ['report: started']);
        await until(() =>
          fs.readFileSync(record.logPath, 'utf8').includes('report: started'),
        );
        expect((await recordOf(record.deploymentId)).status).toBe('running');
        ctx.cloud.printTask(logGroup(), task.taskArn, ['report: 42 rows']);
        ctx.cloud.endTask(task.taskArn, exitCode);
        await runs().whenSettled(record.deploymentId);

        const row = await recordOf(record.deploymentId);
        expect(row.status).toBe(status);
        const lines = logLines(row.logPath);
        expect(lines.filter((line) => line === 'report: started')).toHaveLength(
          1,
        );
        expect(lines).toContain('report: 42 rows');
        expect(lines[lines.length - 1]).toBe(`exit code ${exitCode}`);
      },
    );

    it('reads its stream on once its task has stopped, so a last line CloudWatch shows late is in its log', async () => {
      const record = await firedRun();
      const task = await taskOf(record);
      ctx.cloud.printTask(logGroup(), task.taskArn, ['report: started']);
      await until(() =>
        fs.readFileSync(record.logPath, 'utf8').includes('report: started'),
      );
      // `awslogs` sends its last batch as the container closes, and
      // CloudWatch shows it only to the second read after the stop.
      let stopped = false;
      let readsSinceStop = 0;
      const read = ctx.cloud.readLogStream.bind(
        ctx.cloud,
      ) as FakeCloudPort['readLogStream'];
      const spy = jest
        .spyOn(ctx.cloud, 'readLogStream')
        .mockImplementation((session, request) => {
          if (stopped && ++readsSinceStop === 2) {
            ctx.cloud.printTask(logGroup(), task.taskArn, ['report: done']);
          }
          return read(session, request);
        });
      try {
        stopped = true;
        ctx.cloud.endTask(task.taskArn, 0);
        await runs().whenSettled(record.deploymentId);
      } finally {
        spy.mockRestore();
      }

      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('done');
      expect(logLines(row.logPath).slice(-3)).toEqual([
        'report: started',
        'report: done',
        'exit code 0',
      ]);
    });

    it('fails with the reason ECS gave when it starts no task', async () => {
      ctx.cloud.refuseTaskStart('RESOURCE:CPU');

      const res = await request(http)
        .post(`/applications/${applicationId}/run`)
        .set('Cookie', cookie);

      expect(res.status).toBe(201);
      const row = await recordOf((res.body as Deployment).deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toBe(
        '❌ [Run] The job could not be created: ECS did not start it: RESOURCE:CPU',
      );
    });

    it('fails with the reason when its task stops before its container runs', async () => {
      const record = await firedRun();
      const task = await taskOf(record);

      ctx.cloud.stopTaskUnstarted(
        task.taskArn,
        'CannotPullContainerError: pull image manifest has been retried 5 time(s)',
      );
      await runs().whenSettled(record.deploymentId);

      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toBe(
        '❌ [Run] CannotPullContainerError: pull image manifest has been retried 5 time(s)',
      );
    });

    it('fails with the reason when its Cloud account cannot be reached', async () => {
      ctx.cloud.unreachable('connect ETIMEDOUT sts.amazonaws.com:443');

      const res = await request(http)
        .post(`/applications/${applicationId}/run`)
        .set('Cookie', cookie);

      expect(res.status).toBe(201);
      const row = await recordOf((res.body as Deployment).deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toContain(
        'connect ETIMEDOUT sts.amazonaws.com:443',
      );
      expect(ctx.cloud.tasksStarted).toEqual([]);
    });

    it('is stopped with StopTask at its timeout and recorded "timed out after 30m"', async () => {
      const record = await firedRun();
      const task = await taskOf(record);
      ctx.cloud.printTask(logGroup(), task.taskArn, ['report: still going']);

      now += 30 * MINUTE;
      await timetable().tick();
      await runs().whenSettled(record.deploymentId);

      expect(stops()).toEqual([
        expect.objectContaining({ taskArn: task.taskArn }),
      ]);
      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines).toContain('report: still going');
      expect(lines[lines.length - 1]).toBe('timed out after 30m');
    });

    it('keeps its revision while a Deploy writes a new one and starts no task; the next run starts from the new one', async () => {
      const record = await firedRun();
      const first = await taskOf(record);
      ctx.cloud.replayPlanFor('cron', 'cron-new-revision');

      const redeploy = await request(http)
        .post(`/applications/${applicationId}/redeploy`)
        .set('Cookie', cookie)
        .send({});
      expect(redeploy.status).toBeLessThan(300);
      const [latest] = (
        await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.applicationId, applicationId))
      ).filter(
        (row) =>
          row.cronRun === null && row.deploymentId !== built.deploymentId,
      );
      const deployed = await settledDeployment(latest.deploymentId);

      expect(deployed.status).toBe('done');
      const second = fakeTaskDefinitionArn(
        REGION,
        `cloudgate-${applicationId}`,
        2,
      );
      expect(deployed.cloudRun?.cronTask?.taskDefinitionArn).toBe(second);
      // No task was started by the deploy, and the one in flight goes on.
      expect(ctx.cloud.tasksStarted).toHaveLength(1);
      expect(first.lastStatus).toBe('RUNNING');
      expect(first.taskDefinitionArn).toBe(
        built.cloudRun!.cronTask!.taskDefinitionArn,
      );

      const res = await request(http)
        .post(`/applications/${applicationId}/run`)
        .set('Cookie', cookie);
      expect(res.status).toBe(201);
      const next = await taskOf(res.body as Deployment);
      expect(next.taskDefinitionArn).toBe(second);

      for (const task of ctx.cloud.tasksStarted) {
        ctx.cloud.endTask(task.taskArn, 0);
      }
      await runs().whenSettled(record.deploymentId);
      await runs().whenSettled((res.body as Deployment).deploymentId);
    });

    it('appears in both deployment feeds under the Cron service, marked as a run', async () => {
      const record = await firedRun();
      ctx.cloud.endTask((await taskOf(record)).taskArn, 0);
      await runs().whenSettled(record.deploymentId);

      const organization = await request(http)
        .get('/deployments')
        .set('Cookie', cookie);
      expect(organization.status).toBe(200);
      const environmentFeed = await request(http)
        .get(`/environments/${environmentId}/deployments`)
        .set('Cookie', cookie);
      expect(environmentFeed.status).toBe(200);
      type FeedRow = Deployment & {
        owner: { type: string; id: string; name: string };
      };
      for (const rows of [
        (organization.body as { rows: FeedRow[] }).rows,
        environmentFeed.body as FeedRow[],
      ]) {
        expect(
          rows.find((row) => row.deploymentId === record.deploymentId),
        ).toMatchObject({
          owner: { type: 'application', id: applicationId, name: 'report' },
          cronRun: { job: record.cronRun!.job },
        });
      }
    });
  });

  describe('its actions', () => {
    beforeEach(async () => {
      await appliedCron();
    });

    it('cancels one run with StopTask, saying who, and the timetable goes on', async () => {
      const record = await firedRun();
      const task = await taskOf(record);

      const res = await request(http)
        .post(`/deployments/${record.deploymentId}/cancel`)
        .set('Cookie', cookie);

      expect(res.status).toBeLessThan(300);
      expect(stops()).toEqual([
        expect.objectContaining({ taskArn: task.taskArn }),
      ]);
      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('cancelled');
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toBe(
        '⏹️ [Run] Cancelled by Grace Hopper',
      );
      const [cron] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(cron.applicationStatus).not.toBe('stopped');
    });

    it('keeps a run going, recorded running, while ECS refuses to stop its task', async () => {
      const record = await firedRun();
      ctx.cloud.refuseTaskStop('AccessDeniedException', 'not authorized');

      const res = await request(http)
        .post(`/deployments/${record.deploymentId}/cancel`)
        .set('Cookie', cookie);

      expect(res.status).toBe(409);
      expect((await recordOf(record.deploymentId)).status).toBe('running');
    });

    it('pauses on Stop, stopping each run in flight, and fires again on Start', async () => {
      const record = await firedRun();
      const task = await taskOf(record);

      const stopped = await request(http)
        .post(`/applications/${applicationId}/stop`)
        .set('Cookie', cookie);
      expect(stopped.status).toBeLessThan(300);

      expect(stops()).toEqual([
        expect.objectContaining({ taskArn: task.taskArn }),
      ]);
      const row = await recordOf(record.deploymentId);
      expect(row).toMatchObject({
        status: 'cancelled',
        cronRun: expect.objectContaining({ stopped: true }) as unknown,
      });
      // A pause, not an ECS service scaled: there is none.
      expect(
        ctx.cloud.calls.filter((call) => call.method === 'ecsSetDesiredCount'),
      ).toEqual([]);

      now += 24 * HOUR;
      expect(await timetable().tick()).toEqual([]);

      const started = await request(http)
        .post(`/applications/${applicationId}/start`)
        .set('Cookie', cookie);
      expect(started.status).toBeLessThan(300);
      now += 24 * HOUR;
      const [next] = await timetable().tick();
      expect(next).toBeDefined();
      ctx.cloud.endTask((await taskOf(next)).taskArn, 0);
      await runs().whenSettled(next.deploymentId);
    });

    it('refuses Restart: nothing runs between runs', async () => {
      const res = await request(http)
        .post(`/applications/${applicationId}/reload`)
        .set('Cookie', cookie);
      expect(res.status).toBe(409);
    });

    it('stops each run in flight on Delete, then runs the destroy-only Cloud run', async () => {
      const record = await firedRun();
      const task = await taskOf(record);
      ctx.cloud.replayPlanFor('cron', 'cron-create');

      const res = await request(http)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', cookie);
      expect(res.status).toBeLessThan(300);

      await until(() =>
        ctx.cloud.calls.some(
          (call) => call.method === 'destroy' && call.stateId === stateId,
        ),
      );
      const methods = ctx.cloud.calls.map((call) => call.method);
      expect(methods.indexOf('ecsStopTask')).toBeGreaterThanOrEqual(0);
      expect(methods.indexOf('ecsStopTask')).toBeLessThan(
        methods.lastIndexOf('destroy'),
      );
      expect(stops()).toEqual([
        expect.objectContaining({ taskArn: task.taskArn }),
      ]);
    });

    describe('gated by deployment: create and cancel', () => {
      /** A member whose custom role holds `deployment` as given, on this Service. */
      async function memberWith(deployment_: string[]): Promise<string> {
        const fixture = await signUpMember(http, cookie);
        await ctx.db.insert(licenseKey).values({
          organizationId,
          key: 'test-license-key',
          status: 'active',
          enableEnterpriseFeatures: true,
        });
        await ctx.db.insert(organizationRole).values({
          organizationId,
          role: 'runner',
          permission: { service: ['read'], deployment: deployment_ },
        });
        await ctx.db
          .update(member)
          .set({
            role: 'runner',
            accessedProjects: [projectId],
            accessedEnvironments: [environmentId],
            accessedServices: [applicationId],
          })
          .where(
            and(
              eq(member.userId, fixture.id),
              eq(member.organizationId, organizationId),
            ),
          );
        return fixture.cookie;
      }

      it('refuses Run now without deployment: create, starting no task', async () => {
        const as = await memberWith(['read']);

        const res = await request(http)
          .post(`/applications/${applicationId}/run`)
          .set('Cookie', as);

        expect(res.status).toBe(403);
        expect(ctx.cloud.tasksStarted).toEqual([]);
      });

      it('refuses Cancel without deployment: cancel, and the task goes on', async () => {
        const record = await firedRun();
        const as = await memberWith(['read', 'create']);

        const res = await request(http)
          .post(`/deployments/${record.deploymentId}/cancel`)
          .set('Cookie', as);

        expect(res.status).toBe(403);
        expect(stops()).toEqual([]);
        expect((await recordOf(record.deploymentId)).status).toBe('running');
        ctx.cloud.endTask((await taskOf(record)).taskArn, 0);
        await runs().whenSettled(record.deploymentId);
      });
    });
  });

  describe('after a restart', () => {
    beforeEach(async () => {
      await appliedCron();
      now = MONDAY_0300 + 2 * HOUR;
    });

    /**
     * A Run record a restart left `running`, as a run started at `startedAt`
     * leaves it: its task started in ECS, its ARN on the record, and no
     * watch in this process.
     */
    async function leftRunning(startedAt: number): Promise<{
      record: Deployment;
      taskArn: string;
    }> {
      const [app] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId));
      const started = await ctx.cloud.ecsRunTask(
        {
          accessKeyId: 'ASIA',
          secretAccessKey: 's',
          sessionToken: 'fake-session-token',
        },
        {
          region: REGION,
          cluster: OUTPUTS.cluster_arn,
          taskDefinitionArn: built.cloudRun!.cronTask!.taskDefinitionArn,
          subnets: OUTPUTS.public_subnet_ids,
          securityGroups: [fakeSecurityGroupId(stateId)],
          startedBy: `${app.appName}-run-left`,
          tags: {},
        },
      );
      if (!started.ok || !started.value.started) throw new Error('no task');
      const { taskArn } = started.value;
      const directory = deploymentLogsDirectoryOn(null, app.appName);
      fs.mkdirSync(directory, { recursive: true });
      const logPath = `${directory}/left-${startedAt}.log`;
      fs.writeFileSync(
        logPath,
        "▶️ [Run] Starting 'x', started by the timetable\n",
      );
      const [record] = await ctx.db
        .insert(deployment)
        .values({
          applicationId,
          title: 'Timetable run',
          description: 'Run of report, started by the timetable',
          status: 'running',
          logPath,
          startedAt: new Date(startedAt).toISOString(),
          cronRun: {
            job: `${app.appName}-run-left`,
            image: built.cronImage!,
            startedBy: { kind: 'timetable' },
            taskArn,
          },
        })
        .returning();
      return { record, taskArn };
    }

    it('watches again a task still running, and settles it from its exit code', async () => {
      const { record, taskArn } = await leftRunning(now - 10 * MINUTE);
      ctx.cloud.printTask(logGroup(), taskArn, ['report: before the restart']);

      await timetable().recover();
      expect((await recordOf(record.deploymentId)).status).toBe('running');
      ctx.cloud.endTask(taskArn, 0);
      await runs().whenSettled(record.deploymentId);

      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('done');
      const lines = logLines(row.logPath);
      expect(lines).toContain(
        '↻ [Run] Cloudgate restarted; watching the run again',
      );
      expect(lines).toContain('report: before the restart');
      expect(lines[lines.length - 1]).toBe('exit code 0');
    });

    it('stops a task past its limit, counted from its original start', async () => {
      const { record, taskArn } = await leftRunning(now - 40 * MINUTE);

      await timetable().recover();
      await runs().whenSettled(record.deploymentId);

      expect(stops()).toEqual([expect.objectContaining({ taskArn })]);
      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toBe('timed out after 30m');
    });

    it('records "result unknown" for a task ECS no longer describes', async () => {
      const { record, taskArn } = await leftRunning(now - 10 * MINUTE);
      ctx.cloud.forgetTask(taskArn);

      await timetable().recover();

      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toBe(
        'result unknown: Cloudgate was down when it finished',
      );
    });

    it('settles from its exit code a task that stopped while Cloudgate was down', async () => {
      const { record, taskArn } = await leftRunning(now - 10 * MINUTE);
      ctx.cloud.endTask(taskArn, 2);

      await timetable().recover();

      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toBe('exit code 2');
    });
  });
});
