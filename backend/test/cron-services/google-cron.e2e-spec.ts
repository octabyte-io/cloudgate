import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { serviceName } from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { CRON_RUN_POLL_MS } from '../../src/cron-services/cron-runs.service';
import { CronRunsService } from '../../src/cron-services/cron-runs.service';
import {
  CRON_RUN_SETTLE_TIMER,
  CRON_SERVICE_CLOCK,
} from '../../src/cron-services/cron-service.clock';
import { BackupRunRecorderService } from '../../src/backups/run-recorder.service';
import { CronTimetable } from '../../src/cron-services/cron-timetable.service';
import {
  application,
  cloudAccount,
  deployment,
  licenseKey,
  member,
  organizationRole,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { deploymentLogsDirectoryOn } from '../../src/deployment-engine/deployment-engine.paths';
import { GoogleServiceDeploys } from '../../src/project-config/applier/google-service-deploys.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import type {
  FakeExecution,
  FakeGoogleCloudPort,
} from '../utils/fake-google-cloud-port';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { InstantSettleTimer } from '../utils/instant-settle-timer';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';

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

/** A `docker` that pulls, pushes, logs in and inspects without a daemon. */
const FAKE_DOCKER = `#!/bin/bash
case "$1" in
  login) cat > /dev/null; echo "Login Succeeded" ;;
  pull) echo "Status: Downloaded newer image for \${@: -1}" ;;
  push) echo "\${2##*:}: digest: sha256:0f1e size: 1570" ;;
  image) [ "$2" = inspect ] && echo amd64 ;;
esac
exit 0
`;

/** Monday 2026-09-28, an hour before the report's first fire time. */
const MONDAY_0200 = Date.parse('2026-09-28T02:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MONDAY_0300 = MONDAY_0200 + HOUR;

/**
 * **a Cron service on Google Cloud** (stories 32–55; ADR-0034 as
 * amended). Its config
 * plans and applies into a Google Cloud Environment as a Cloud Run job, and
 * Cloudgate's own timetable fires each run as one execution of it; there is
 * no Cloud Scheduler. A run is the same Run record as on a Server and on
 * AWS, its log copied from Cloud Logging by its execution's name while it
 * runs, its result how its execution ended.
 *
 * Driven by the injected Cron service clock, against the faked Google cloud
 * port (`ctx.google`), whose stand-in `tofu` replays the stored `cron-*`
 * plans, and a real shell whose `docker` is the fake above, so every
 * Deployment log is a real file.
 */
describe('A Cron service on Google Cloud (e2e)', () => {
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
  /** A run's settle read once its execution ends, with no sleep. */
  const settleTimer = new InstantSettleTimer();

  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gcron-'));
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
        { provide: CRON_RUN_SETTLE_TIMER, useValue: settleTimer },
      ],
    });
    http = ctx.app.getHttpServer() as App;
    ctx.app.get(GoogleServiceDeploys).pollIntervalMs = 10;
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (saved.root === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = saved.root;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    now = MONDAY_0200;
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
    organizationId = (orgs.body as { id: string }[])[0].id;
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
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;

    ctx.google.replayPlanFor('network', 'network-create');
    ctx.google.replayPlanFor('cron', 'cron-create');
    ctx.google.replayOutputsFor('network', 'network-create');
    ctx.google.replayOutputsFor('cron', 'cron-create');
  });

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
            'cloudRead' in step &&
            step.cloudRead !== undefined &&
            step.cloudRead.status === 'reading',
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
    const step = read.steps[1];
    if (step.action !== 'create' || step.cloudRead?.status !== 'read') {
      throw new Error(`the cron was not read: ${JSON.stringify(step)}`);
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
    const input = ctx.google.tofuInputs.filter(
      (one) => one.stateId === stateId,
    );
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

  const executionOf = async (record: Deployment): Promise<FakeExecution> => {
    const { cronRun } = await recordOf(record.deploymentId);
    const found = ctx.google.executions.find(
      (one) => one.execution === cronRun?.execution,
    );
    if (!found) throw new Error('No execution for the run');
    return found;
  };

  const cancels = () =>
    ctx.google.calls.filter(
      (call) => call.method === 'cancelCloudRunExecution',
    );

  const jobName = () => serviceName(applicationId);

  async function until(done: () => boolean | Promise<boolean>) {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (await done()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('It never happened');
  }

  describe('its plan and Apply', () => {
    it('plans its repository, service account and job, with no Cloud Scheduler or Cloud Run service', async () => {
      const read = await appliedCron();

      expect(read.steps.map((step) => step.action)).toEqual([
        'network-create',
        'create',
      ]);
      const step = read.steps[1];
      if (step.action !== 'create' || step.cloudRead?.status !== 'read') {
        throw new Error('the cron was not read');
      }
      expect(step).toMatchObject({ kind: 'cron' });
      expect(step.cloudRead.raw.map((line) => line.address)).toEqual([
        'google_artifact_registry_repository.service',
        'google_cloud_run_v2_job.service',
        'google_service_account.service',
      ]);
      expect(step.cloudRead.summary).toContain(
        "Cloud Run job `report`: create, `small` → 1 CPU / 512 MB, one task, no retries, each run an execution Cloudgate's timetable starts",
      );
      expect(JSON.stringify(read.steps)).not.toMatch(
        /cloud_scheduler|google_cloud_run_v2_service|backend_service/,
      );

      const written = definitionWritten();
      expect(Object.keys(written.resource)).not.toContain(
        'google_cloud_run_v2_service',
      );
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

    it('deploys a job with its command, one task, no retries and a 24h task timeout, and starts no execution', async () => {
      await appliedCron();

      expect(built.status).toBe('done');
      const job = definitionWritten().resource.google_cloud_run_v2_job
        .service as {
        template: {
          task_count: number;
          parallelism: number;
          template: Record<string, unknown> & {
            containers: Record<string, unknown>[];
          };
        };
      };
      expect(job.template).toMatchObject({
        task_count: 1,
        parallelism: 1,
        template: { max_retries: 0, timeout: '86400s' },
      });
      expect(job.template.template.containers[0]).toMatchObject({
        command: ['node', 'dist/report.js'],
        args: ['--all'],
      });
      expect(job.template.template.containers[0]).not.toHaveProperty(
        'startup_probe',
      );
      expect(built.cronImage).toBe(
        `europe-west1-docker.pkg.dev/example-project-123/cloudgate-gx53zr4oagxf/service:${built.deploymentId}`,
      );
      expect(fs.readFileSync(built.logPath, 'utf8')).toContain(
        "✅ [Cloud run] report's runs start from the image of this Deployment; no run was started",
      );
      expect(ctx.google.executions).toEqual([]);
      expect(
        ctx.google.calls.filter((call) =>
          [
            'runCloudRunJob',
            'cloudRunService',
            'setCloudRunScaling',
            'cloudRunWorkerPool',
          ].includes(call.method),
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
      'shows a changed %s as a Cloudgate setting with no Google line, and applies it with no Cloud run',
      async (field, from, to, savedColumns) => {
        await appliedCron();
        const calls = ctx.google.calls.length;

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
        expect(ctx.google.calls.slice(calls)).toEqual([]);
        const [row] = await ctx.db
          .select()
          .from(application)
          .where(eq(application.applicationId, applicationId));
        expect(row).toMatchObject(savedColumns);
        // No deploy either: nothing of it is in Google Cloud.
        const rows = await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.applicationId, applicationId));
        expect(rows).toHaveLength(1);
      },
    );

    it('shows a changed command as a Google line on the job', async () => {
      await appliedCron();
      ctx.google.replayPlanFor('cron', 'cron-command-change');

      const read = await planned(
        REPORT.replace('node dist/report.js', 'node dist/report-v2.js'),
      );

      const [step] = read.steps;
      if (step.action !== 'change' || step.cloudRead?.status !== 'read') {
        throw new Error('the change did not read Google Cloud');
      }
      expect(step.fields).toEqual([
        expect.objectContaining({ field: 'command' }),
      ]);
      expect(step.cloudRead.raw).toEqual([
        expect.objectContaining({
          address: 'google_cloud_run_v2_job.service',
          action: 'change',
        }),
      ]);
      const job = definitionWritten().resource.google_cloud_run_v2_job
        .service as {
        template: { template: { containers: Record<string, unknown>[] } };
      };
      expect(job.template.template.containers[0].command).toEqual([
        'node',
        'dist/report-v2.js',
      ]);
    });
  });

  describe('a run', () => {
    beforeEach(async () => {
      await appliedCron();
    });

    it('is one execution of its job a tick starts; the execution’s name on its Run record', async () => {
      const record = await firedRun();

      expect(
        ctx.google.calls.filter((call) => call.method === 'runCloudRunJob'),
      ).toEqual([
        expect.objectContaining({
          projectId: PROJECT,
          region: REGION,
          name: jobName(),
        }),
      ]);
      const execution = await executionOf(record);
      expect(record.cronRun!.image).toBe(built.cronImage);
      expect((await recordOf(record.deploymentId)).cronRun).toMatchObject({
        execution: execution.execution,
      });
      expect(logLines(record.logPath)[0]).toBe(
        `▶️ [Run] Starting '${built.cronImage}' as an execution of its Cloud Run job (${record.cronRun!.job}), started by the timetable`,
      );

      ctx.google.endExecution(execution.execution, 0);
      await runs().whenSettled(record.deploymentId);
    });

    it.each([
      [0, 'done'],
      [3, 'error'],
    ])(
      'copies its own log while it runs, and ends by its exit code: %i is %s',
      async (exitCode, status) => {
        const record = await firedRun();
        const { execution } = await executionOf(record);

        ctx.google.printExecution(execution, ['report: started']);
        await until(() =>
          fs.readFileSync(record.logPath, 'utf8').includes('report: started'),
        );
        expect((await recordOf(record.deploymentId)).status).toBe('running');
        ctx.google.printExecution(execution, ['report: 42 rows']);
        ctx.google.endExecution(execution, exitCode);
        await runs().whenSettled(record.deploymentId);

        const row = await recordOf(record.deploymentId);
        expect(row.status).toBe(status);
        const lines = logLines(row.logPath);
        expect(lines.filter((line) => line === 'report: started')).toHaveLength(
          1,
        );
        expect(lines).toContain('report: 42 rows');
        expect(lines[lines.length - 1]).toBe(`exit code ${exitCode}`);
        expect(row.cronRun?.logFrom).toBeDefined();
      },
    );

    it('keeps two overlapping runs’ logs apart: each tick is its own execution', async () => {
      const first = await firedRun();
      const res = await request(http)
        .post(`/applications/${applicationId}/run`)
        .set('Cookie', cookie);
      expect(res.status).toBe(201);
      const second = res.body as Deployment;
      const [one, two] = [await executionOf(first), await executionOf(second)];
      expect(one.execution).not.toBe(two.execution);
      expect(one.state).toBe('running');

      ctx.google.printExecution(one.execution, ['first: line']);
      ctx.google.printExecution(two.execution, ['second: line']);
      ctx.google.endExecution(one.execution, 0);
      ctx.google.endExecution(two.execution, 0);
      await runs().whenSettled(first.deploymentId);
      await runs().whenSettled(second.deploymentId);

      const firstLines = logLines((await recordOf(first.deploymentId)).logPath);
      const secondLines = logLines(
        (await recordOf(second.deploymentId)).logPath,
      );
      expect(firstLines).toContain('first: line');
      expect(firstLines).not.toContain('second: line');
      expect(secondLines).toContain('second: line');
      expect(secondLines).not.toContain('first: line');
    });

    describe('once its execution has ended', () => {
      /**
       * Each read of the run's log, and each settle of its record, in order;
       * `beforeRead` runs ahead of each read.
       */
      function watchSettles(
        deploymentId: string,
        beforeRead: () => void = () => undefined,
      ): string[] {
        const order: string[] = [];
        const read = ctx.google.executionLogEntries.bind(
          ctx.google,
        ) as FakeGoogleCloudPort['executionLogEntries'];
        jest
          .spyOn(ctx.google, 'executionLogEntries')
          .mockImplementation((token, request) => {
            beforeRead();
            order.push('read');
            return read(token, request);
          });
        const recorder = ctx.app.get(BackupRunRecorderService);
        const settle = recorder.settle.bind(
          recorder,
        ) as BackupRunRecorderService['settle'];
        jest.spyOn(recorder, 'settle').mockImplementation((id, ...rest) => {
          if (id === deploymentId) order.push('settle');
          return settle(id, ...rest);
        });
        return order;
      }

      afterEach(() => jest.restoreAllMocks());

      it('settles the run once, then reads its log on until it settles, so the last lines Cloud Logging shows late are above its exit code', async () => {
        const record = await firedRun();
        const { execution } = await executionOf(record);
        ctx.google.printExecution(execution, ['inside: localhost']);
        await until(() =>
          fs.readFileSync(record.logPath, 'utf8').includes('inside: localhost'),
        );
        const order = watchSettles(record.deploymentId);

        // Written in the run's final second, not shown to the
        // read made just after the end, nor to the one 3 s on.
        ctx.google.printExecutionLate(
          execution,
          ['web: 200', 'nightly ran'],
          2,
        );
        const waited = settleTimer.waits.length;
        ctx.google.endExecution(execution, 0);
        await runs().whenSettled(record.deploymentId);

        // Shown from the read at 6 s; the reads at 9 and 12 s find nothing.
        expect(settleTimer.waits.slice(waited)).toEqual([
          3_000, 3_000, 3_000, 3_000,
        ]);

        const row = await recordOf(record.deploymentId);
        expect(row.status).toBe('done');
        expect(logLines(row.logPath).slice(-4)).toEqual([
          'inside: localhost',
          'web: 200',
          'nightly ran',
          'exit code 0',
        ]);
        // The record first, then the reads at 0, 3, 6, 9 and 12 s.
        expect(order.filter((one) => one === 'settle')).toHaveLength(1);
        expect(order.slice(-6)).toEqual([
          'settle',
          'read',
          'read',
          'read',
          'read',
          'read',
        ]);
      });

      it('keeps a finished run done when it is cancelled while its log is still read', async () => {
        const record = await firedRun();
        const { execution } = await executionOf(record);
        // A Cancel sent at the first read after the record is settled.
        const sent: { cancel?: Promise<request.Response> } = {};
        const order: string[] = watchSettles(record.deploymentId, () => {
          if (sent.cancel || !order.includes('settle')) return;
          sent.cancel = request(http)
            .post(`/deployments/${record.deploymentId}/cancel`)
            .set('Cookie', cookie)
            .then((res) => res);
        });
        // The reads go on only once it has been answered, so it lands
        // inside the window.
        const wait = settleTimer.wait.bind(
          settleTimer,
        ) as InstantSettleTimer['wait'];
        jest
          .spyOn(settleTimer, 'wait')
          .mockImplementationOnce(async (ms: number) => {
            await sent.cancel;
            return wait(ms);
          });

        ctx.google.printExecutionLate(execution, ['report: done'], 2);
        ctx.google.endExecution(execution, 0);
        await runs().whenSettled(record.deploymentId);
        expect(sent.cancel).toBeDefined();
        await sent.cancel;

        const row = await recordOf(record.deploymentId);
        expect(row.status).toBe('done');
        expect(cancels()).toEqual([]);
        expect(logLines(row.logPath).slice(-2)).toEqual([
          'report: done',
          'exit code 0',
        ]);
      });

      it('settles a run that wrote nothing at the first quiet read 10 s after its end, not at the 30 s cap', async () => {
        const record = await firedRun();
        const { execution } = await executionOf(record);
        await until(() =>
          ctx.google.calls.some(
            (call) => call.method === 'executionLogEntries',
          ),
        );
        const order = watchSettles(record.deploymentId);
        const waited = settleTimer.waits.length;

        ctx.google.endExecution(execution, 0);
        await runs().whenSettled(record.deploymentId);

        // Reads at 0, 3, 6, 9 and 12 s after the end: 12 s is the first
        // read past the quiet mark, and it finds nothing.
        expect(settleTimer.waits.slice(waited)).toEqual([
          3_000, 3_000, 3_000, 3_000,
        ]);
        expect(order.slice(-6)).toEqual([
          'settle',
          'read',
          'read',
          'read',
          'read',
          'read',
        ]);
        const row = await recordOf(record.deploymentId);
        expect(row.status).toBe('done');
        expect(logLines(row.logPath).slice(1)).toEqual(['exit code 0']);
      });

      it('stops reading 30 s after its end while its log still grows, its run settled once, first', async () => {
        const record = await firedRun();
        const { execution } = await executionOf(record);
        await until(() =>
          ctx.google.calls.some(
            (call) => call.method === 'executionLogEntries',
          ),
        );
        let printed = 0;
        const order = watchSettles(record.deploymentId, () =>
          ctx.google.printExecution(execution, [`late ${++printed}`]),
        );
        const waited = settleTimer.waits.length;

        ctx.google.endExecution(execution, 0);
        await runs().whenSettled(record.deploymentId);

        // One read at the end and one every 3 s to the cap, each finding a
        // line; none after it.
        expect(settleTimer.waits.slice(waited)).toEqual(
          Array.from({ length: 10 }, () => 3_000),
        );
        expect(order.filter((one) => one === 'settle')).toHaveLength(1);
        expect(order.slice(-12)).toEqual([
          'settle',
          ...Array.from({ length: 11 }, () => 'read'),
        ]);
        const lines = logLines((await recordOf(record.deploymentId)).logPath);
        expect(lines.slice(-2)).toEqual([`late ${printed}`, 'exit code 0']);
      });
    });

    it('is not taken for one whose execution is gone by a tick that comes while it is being started', async () => {
      const run = ctx.google.runCloudRunJob.bind(
        ctx.google,
      ) as FakeGoogleCloudPort['runCloudRunJob'];
      const spy = jest
        .spyOn(ctx.google, 'runCloudRunJob')
        .mockImplementation(async (token, job) => {
          // The live walk's tick: the record written, no execution on it yet.
          await runs().holdRuns(clock.now());
          return run(token, job);
        });
      let record: Deployment;
      try {
        const res = await request(http)
          .post(`/applications/${applicationId}/run`)
          .set('Cookie', cookie);
        expect(res.status).toBe(201);
        record = res.body as Deployment;
      } finally {
        spy.mockRestore();
      }
      expect((await recordOf(record.deploymentId)).status).toBe('running');

      ctx.google.endExecution((await executionOf(record)).execution, 0);
      await runs().whenSettled(record.deploymentId);
      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('done');
      expect(logLines(row.logPath).at(-1)).toBe('exit code 0');
    });

    it('fails with Google’s condition when its container never ran', async () => {
      const record = await firedRun();
      const { execution } = await executionOf(record);

      ctx.google.failExecutionUnstarted(
        execution,
        'Image not found: the image of the job could not be pulled',
      );
      await runs().whenSettled(record.deploymentId);

      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toBe(
        '❌ [Run] Image not found: the image of the job could not be pulled',
      );
    });

    it('fails with the reason when Google starts no execution', async () => {
      ctx.google.refuse(
        'runCloudRunJob',
        'RESOURCE_EXHAUSTED',
        'Quota exceeded for job executions',
      );

      const res = await request(http)
        .post(`/applications/${applicationId}/run`)
        .set('Cookie', cookie);

      expect(res.status).toBe(201);
      const row = await recordOf((res.body as Deployment).deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toBe(
        '❌ [Run] The job could not be created: Cloud Run refused to start it: RESOURCE_EXHAUSTED: Quota exceeded for job executions',
      );
      expect(ctx.google.executions).toEqual([]);
    });

    it('fails with the reason when its Cloud account cannot be reached', async () => {
      ctx.google.refuse(
        'impersonate',
        'UNAVAILABLE',
        'connect ETIMEDOUT iamcredentials.googleapis.com:443',
      );

      const res = await request(http)
        .post(`/applications/${applicationId}/run`)
        .set('Cookie', cookie);

      expect(res.status).toBe(201);
      const row = await recordOf((res.body as Deployment).deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toMatch(
        /^❌ \[Run\] The job could not be created: .+/,
      );
      expect(ctx.google.executions).toEqual([]);
    });

    it('is cancelled with executions.cancel at its timeout and recorded "timed out after 30m"', async () => {
      const record = await firedRun();
      const { execution } = await executionOf(record);
      ctx.google.printExecution(execution, ['report: still going']);

      now += 30 * MINUTE;
      await timetable().tick();
      await runs().whenSettled(record.deploymentId);

      expect(cancels()).toEqual([expect.objectContaining({ execution })]);
      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines).toContain('report: still going');
      expect(lines[lines.length - 1]).toBe('timed out after 30m');
    });

    it('keeps its image while a Deploy updates the job’s and starts no execution; the next run starts from the new one', async () => {
      const record = await firedRun();
      const first = await executionOf(record);
      ctx.google.replayPlanFor('cron', 'cron-image-only');

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

      expect([deployed.status, logLines(deployed.logPath).at(-1)]).toEqual([
        'done',
        "✅ [Cloud run] report's runs start from the image of this Deployment; no run was started",
      ]);
      expect(deployed.cronImage).toContain(`:${deployed.deploymentId}`);
      // No execution was started by the deploy, and the one in flight
      // keeps the image it began with.
      expect(ctx.google.executions).toHaveLength(1);
      expect(first.state).toBe('running');
      expect(first.image).toContain(`:${built.deploymentId}`);

      const res = await request(http)
        .post(`/applications/${applicationId}/run`)
        .set('Cookie', cookie);
      expect(res.status).toBe(201);
      const next = await executionOf(res.body as Deployment);
      expect(next.image).toContain(`:${deployed.deploymentId}`);
      expect((res.body as Deployment).cronRun?.image).toBe(deployed.cronImage);

      for (const one of ctx.google.executions) {
        ctx.google.endExecution(one.execution, 0);
      }
      await runs().whenSettled(record.deploymentId);
      await runs().whenSettled((res.body as Deployment).deploymentId);
    });

    it('appears in both deployment feeds under the Cron service, marked as a run', async () => {
      const record = await firedRun();
      ctx.google.endExecution((await executionOf(record)).execution, 0);
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

    it('cancels one run with executions.cancel, saying who, and the timetable goes on', async () => {
      const record = await firedRun();
      const { execution } = await executionOf(record);

      const res = await request(http)
        .post(`/deployments/${record.deploymentId}/cancel`)
        .set('Cookie', cookie);

      expect(res.status).toBeLessThan(300);
      expect(cancels()).toEqual([expect.objectContaining({ execution })]);
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

    it('keeps a run going, recorded running, while Google refuses to cancel its execution', async () => {
      const record = await firedRun();
      ctx.google.refuse(
        'cancelCloudRunExecution',
        'PERMISSION_DENIED',
        "Permission 'run.executions.cancel' denied",
      );

      const res = await request(http)
        .post(`/deployments/${record.deploymentId}/cancel`)
        .set('Cookie', cookie);

      expect(res.status).toBe(409);
      expect((await recordOf(record.deploymentId)).status).toBe('running');
    });

    it('pauses on Stop, cancelling each run in flight, and fires again on Start', async () => {
      const record = await firedRun();
      const { execution } = await executionOf(record);

      const stopped = await request(http)
        .post(`/applications/${applicationId}/stop`)
        .set('Cookie', cookie);
      expect(stopped.status).toBeLessThan(300);

      expect(cancels()).toEqual([expect.objectContaining({ execution })]);
      const row = await recordOf(record.deploymentId);
      expect(row).toMatchObject({
        status: 'cancelled',
        cronRun: expect.objectContaining({ stopped: true }) as unknown,
      });

      now += 24 * HOUR;
      expect(await timetable().tick()).toEqual([]);

      const started = await request(http)
        .post(`/applications/${applicationId}/start`)
        .set('Cookie', cookie);
      expect(started.status).toBeLessThan(300);
      now += 24 * HOUR;
      const [next] = await timetable().tick();
      expect(next).toBeDefined();
      ctx.google.endExecution((await executionOf(next)).execution, 0);
      await runs().whenSettled(next.deploymentId);
    });

    it('refuses Reload and Remove containers: nothing runs between runs', async () => {
      const reload = await request(http)
        .post(`/applications/${applicationId}/reload`)
        .set('Cookie', cookie);
      expect(reload.status).toBe(409);
    });

    it('cancels each run in flight on Delete, then runs the destroy-only Cloud run, and searches for a job left behind', async () => {
      const record = await firedRun();
      const { execution } = await executionOf(record);

      const res = await request(http)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', cookie);
      expect(res.status).toBeLessThan(300);

      await until(() =>
        ctx.google.calls.some(
          (call) => call.method === 'destroy' && call.stateId === stateId,
        ),
      );
      // The leftover search after it covers Cloud Run jobs.
      await until(() =>
        ctx.google.calls.some(
          (call) =>
            call.method === 'findByName' &&
            call.resourceType === 'google_cloud_run_v2_job',
        ),
      );
      const methods = ctx.google.calls.map((call) => call.method);
      expect(methods.indexOf('cancelCloudRunExecution')).toBeGreaterThanOrEqual(
        0,
      );
      expect(methods.indexOf('cancelCloudRunExecution')).toBeLessThan(
        methods.lastIndexOf('destroy'),
      );
      expect(cancels()).toEqual([expect.objectContaining({ execution })]);
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

      it('refuses Run now without deployment: create, starting no execution', async () => {
        const as = await memberWith(['read']);

        const res = await request(http)
          .post(`/applications/${applicationId}/run`)
          .set('Cookie', as);

        expect(res.status).toBe(403);
        expect(ctx.google.executions).toEqual([]);
      });

      it('refuses Cancel without deployment: cancel, and the execution goes on', async () => {
        const record = await firedRun();
        const as = await memberWith(['read', 'create']);

        const res = await request(http)
          .post(`/deployments/${record.deploymentId}/cancel`)
          .set('Cookie', as);

        expect(res.status).toBe(403);
        expect(cancels()).toEqual([]);
        expect((await recordOf(record.deploymentId)).status).toBe('running');
        ctx.google.endExecution((await executionOf(record)).execution, 0);
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
     * leaves it: its execution started in Google Cloud, its name on the
     * record, and no watch in this process.
     */
    async function leftRunning(startedAt: number): Promise<{
      record: Deployment;
      execution: string;
    }> {
      const [app] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId));
      const started = await ctx.google.runCloudRunJob(
        { accessToken: 'fake-impersonated-token' },
        { projectId: PROJECT, region: REGION, name: jobName() },
      );
      if (!started.ok) throw new Error('no execution');
      const { execution } = started.value;
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
            execution,
          },
        })
        .returning();
      return { record, execution };
    }

    it('watches again an execution still running, and settles it from its exit code', async () => {
      const { record, execution } = await leftRunning(now - 10 * MINUTE);
      ctx.google.printExecution(execution, ['report: before the restart']);

      await timetable().recover();
      expect((await recordOf(record.deploymentId)).status).toBe('running');
      ctx.google.endExecution(execution, 0);
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

    it('cancels an execution past its limit, counted from its original start', async () => {
      const { record, execution } = await leftRunning(now - 40 * MINUTE);

      await timetable().recover();
      await runs().whenSettled(record.deploymentId);

      expect(cancels()).toEqual([expect.objectContaining({ execution })]);
      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toBe('timed out after 30m');
    });

    it('records "result unknown" for an execution Google no longer has', async () => {
      const { record, execution } = await leftRunning(now - 10 * MINUTE);
      ctx.google.forgetExecution(execution);

      await timetable().recover();

      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toBe(
        'result unknown: Cloudgate was down when it finished',
      );
    });

    it('settles from its exit code an execution that ended while Cloudgate was down', async () => {
      const { record, execution } = await leftRunning(now - 10 * MINUTE);
      ctx.google.endExecution(execution, 2);

      await timetable().recover();

      const row = await recordOf(record.deploymentId);
      expect(row.status).toBe('error');
      const lines = logLines(row.logPath);
      expect(lines[lines.length - 1]).toBe('exit code 2');
    });
  });
});
