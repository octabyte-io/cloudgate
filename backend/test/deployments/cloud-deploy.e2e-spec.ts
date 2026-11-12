import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { ecrRepositoryName } from '../../src/cloud-accounts/aws/definitions/web-definition';
import {
  application,
  cloudAccount,
  deployment,
  environmentNetwork,
  plan as planTable,
  registry,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { DEPLOYMENT_NOTIFIER } from '../../src/deployment-engine/ports/deployment-notifier';
import type { DeploymentNotifier } from '../../src/deployment-engine/ports/deployment-notifier';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { environmentNetworkName } from '../../src/deployments/service-scope';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { ProjectConfigService } from '../../src/project-config/project-config.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import { FAILED_TASK_ID, storedPlan } from '../utils/fake-cloud-port';
import { makeGoogleCloudAccount } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

const WEB = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
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

/**
 * A `docker` that pulls, pushes and logs in without a daemon: it records
 * each call's words (never stdin), and that a login read its password from
 * stdin against a throwaway `DOCKER_CONFIG`.
 */
const FAKE_DOCKER = `#!/bin/bash
echo "$*" >> "$FAKE_DOCKER_RECORD"
case "$1" in
  login)
    password="$(cat)"
    if [ -n "$password" ] && [ -n "$DOCKER_CONFIG" ]; then
      echo "login read a password from stdin, DOCKER_CONFIG set" >> "$FAKE_DOCKER_RECORD"
    fi
    echo "Login Succeeded" ;;
  pull) echo "Status: Downloaded newer image for $2" ;;
  push) echo "The push refers to repository [\${2%:*}]"; echo "\${2##*:}: digest: sha256:0f1e size: 1570" ;;
  image)
    if [ "$2" = inspect ]; then
      case "$4" in
        *Healthcheck*) echo "\${FAKE_DOCKER_ARCH:-amd64} \${FAKE_DOCKER_HEALTHCHECK:-null}" ;;
        *) echo "\${FAKE_DOCKER_ARCH:-amd64}" ;;
      esac
    fi ;;
esac
exit 0
`;

/**
 * The tracer bullet: Apply of a plan that creates a `web` in a Cloud
 * account makes the Environment network, creates the Service in its cloud
 * place, and queues one ordinary Deployment. That Deployment builds (here,
 * pulls) on the platform host in the build slot, then runs a Cloud run: its
 * ECR repository first, a push with a fresh token, AWS read again, the
 * apply, the running count, the wait for steady and the ECR clean-up. One
 * row and one log, with build, then plan, then apply lines.
 *
 * Against the fake cloud port (`ctx.cloud`) and a real shell whose `docker`
 * is the fake above, so the Deployment log is the real file.
 */
describe('Deploying a cloud web (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-deploy-'));
  const bin = nodePath.join(root, 'bin');
  const record = nodePath.join(root, 'docker-calls');
  const saved = {
    root: process.env.CLOUDGATE_DIRECTORY,
    record: process.env.FAKE_DOCKER_RECORD,
  };

  /** Every shell program run on the platform host, through a real bash. */
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
    process.env.FAKE_DOCKER_RECORD = record;
    fs.mkdirSync(bin);
    fs.writeFileSync(nodePath.join(bin, 'docker'), FAKE_DOCKER, {
      mode: 0o755,
    });
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    http = ctx.app.getHttpServer() as App;
    ctx.app.get(CloudServiceDeploys).pollIntervalMs = 10;
  });

  afterAll(async () => {
    await ctx?.teardown();
    for (const [name, value] of [
      ['CLOUDGATE_DIRECTORY', saved.root],
      ['FAKE_DOCKER_RECORD', saved.record],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete process.env.FAKE_DOCKER_ARCH;
    delete process.env.FAKE_DOCKER_HEALTHCHECK;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    fs.rmSync(record, { force: true });
    delete process.env.FAKE_DOCKER_ARCH;
    delete process.env.FAKE_DOCKER_HEALTHCHECK;
    execMock.execAsync.mockClear();
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

    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('web', 'web-create');
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
            (step.action === 'create' || step.action === 'network-create') &&
            step.cloudRead?.status === 'reading',
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

  /** Plans the config, applies it, and waits for the web's Deployment. */
  async function appliedWeb(
    text = WEB,
    name = 'web',
    outputs: Record<string, unknown> = OUTPUTS,
  ): Promise<{
    plan: Plan;
    applicationId: string;
    run: Deployment;
  }> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });
    expect(saved.status).toBe(201);
    const read = await openPlan();
    const networkStep = read.steps[0];
    if (networkStep.action !== 'network-create') throw new Error('no network');
    if (networkStep.cloudRead.status !== 'read') throw new Error('not read');
    ctx.cloud.outputsFor(networkStep.cloudRead.stateId, outputs);

    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    const applied = await settledPlan(read.planId);
    const web = applied.results!.find((one) => one.configName === name)!;
    expect(web).toMatchObject({ status: 'applied', domain: null });
    if (web.deploy?.status !== 'queued') throw new Error('not queued');
    const run = await settledDeployment(web.deploy.deploymentId);
    return { plan: read, applicationId: web.serviceId!, run };
  }

  const logOf = async (deploymentId: string) => {
    const res = await request(http)
      .get(`/deployments/${deploymentId}/logs`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.text;
  };

  const dockerCalls = () =>
    fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : '';

  /** Every shell program the platform host ran, as its words. */
  const programs = () =>
    execMock.execAsync.mock.calls.map((call: unknown[]) => String(call[0]));

  /** An Agent of `role`, granted the Project, Environment and Service. */
  async function agent(role: 'agentOperator', applicationId: string | null) {
    const created = await request(http)
      .post('/agents')
      .set('Cookie', cookie)
      .send({
        name: `${role}-bot`,
        role,
        grant: {
          accessedProjects: [projectId],
          accessedEnvironments: [environmentId],
          accessedServices: applicationId ? [applicationId] : [],
        },
      });
    expect(created.status).toBe(201);
    const id = (created.body as { agent: { id: string } }).agent.id;
    return { user: { id }, session: { activeOrganizationId: organizationId } };
  }

  /** The Organization's notification channels, as the engine reaches them. */
  const notifier = () =>
    ctx.app.get<DeploymentNotifier>(DEPLOYMENT_NOTIFIER, { strict: false });

  it('builds, pushes with a fresh token, reads AWS again and applies, all in one Deployment, then cleans ECR', async () => {
    process.env.FAKE_DOCKER_ARCH = 'arm64';
    const announced = jest.spyOn(notifier(), 'buildSuccess');
    const { plan, applicationId, run } = await appliedWeb();
    // Announced once, when its Cloud run is done, as a Server's build is.
    expect(announced).toHaveBeenCalledTimes(1);
    expect(announced).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: applicationId,
        applicationName: 'web',
      }),
    );
    announced.mockRestore();
    const webStep = plan.steps[1];
    if (webStep.action !== 'create' || webStep.cloudRead?.status !== 'read') {
      throw new Error('the web was not read');
    }

    // The Service: its cloud place, under the ids its plan was read with.
    const [created] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));
    expect(created).toMatchObject({
      applicationId: webStep.cloudRead.serviceId,
      cloudAccountId,
      region: REGION,
      serverId: null,
      applicationStatus: 'done',
    });

    // One ordinary Deployment of the Service, a `deploy` Cloud run.
    expect(run).toMatchObject({
      applicationId,
      status: 'done',
      title: 'Plan applied',
      cloudRun: {
        kind: 'deploy',
        stateKey: `application:${applicationId}`,
        environmentId,
        touchesNetwork: false,
      },
    });
    const rows = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.applicationId, applicationId));
    expect(rows).toHaveLength(1);

    // Build lines, then plan lines, then apply lines, in one log.
    const log = await logOf(run.deploymentId);
    const at = (text: string) => {
      const index = log.indexOf(text);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      at(
        `🔧 [Build] Building on Cloudgate's own host; the service runs in Cloud account Production AWS (${REGION}).`,
      ),
      at('Status: Downloaded newer image for nginx'),
      at('☁️ [Cloud run] Built.'),
      at(`☁️ [Cloud run] Deploying web to Cloud account Production AWS`),
      at('Reading AWS again before anything changes'),
      at("📦 [Push] Making the Service's ECR repository first"),
      at('📦 [Push] Uploading image to'),
      at('✅ Image Pushed'),
      at('Reading AWS again before applying'),
      log.lastIndexOf('Apply complete!'),
      at('⏳ [Cloud run] Waiting for ECS'),
      at('🧹 [Push] Removed 1 older image from ECR'),
      at('✅ [Cloud run] web runs the image of this Deployment'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // The repository first (targeted), then the push, then the whole state.
    const repository = ecrRepositoryName(applicationId);
    const registryHost = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com`;
    const remote = `${registryHost}/${repository}:${run.deploymentId}`;
    const webState = webStep.cloudRead.stateId;
    const webCalls = ctx.cloud.calls.filter(
      (call) => 'stateId' in call && call.stateId === webState,
    );
    expect(
      webCalls.map((call) => [
        call.method,
        'targets' in call ? call.targets : undefined,
      ]),
    ).toEqual([
      ['plan', undefined], // the plan read
      ['plan', undefined], // the Apply's read again with the network's ids
      ['plan', undefined], // the run's read before anything changes
      [
        'apply',
        ['aws_ecr_repository.service', 'aws_ecr_lifecycle_policy.service'],
      ],
      ['apply', undefined],
    ]);
    // The task follows the pushed image's CPU.
    expect(webCalls.at(-1)).toMatchObject({ cpuArchitecture: 'ARM64' });

    // One fresh token, for a role session; one login, its password on stdin.
    expect(
      ctx.cloud.calls.filter((call) => call.method === 'ecrAuthorizationToken'),
    ).toEqual([
      { method: 'ecrAuthorizationToken', region: REGION, session: true },
    ]);
    expect(dockerCalls()).toContain(
      'login read a password from stdin, DOCKER_CONFIG set',
    );
    expect(dockerCalls()).toContain(`tag nginx ${remote}`);
    expect(dockerCalls()).toContain(`push ${remote}`);
    // The push removes only its remote tag: `nginx` is the operator's own
    // image reference, which another Service may share, so it stays on the
    // platform host.
    const dockerLines = dockerCalls().split('\n');
    expect(dockerLines).toContain(`image rm ${remote}`);
    expect(
      dockerLines.filter(
        (line) =>
          line.startsWith('image rm') && line.split(' ').includes('nginx'),
      ),
    ).toEqual([]);
    // The password was in no command, no log line and no row.
    const [password] = ctx.cloud.ecrPasswords;
    expect(programs().join('\n')).not.toContain(password);
    expect(dockerCalls()).not.toContain(password);
    expect(log).not.toContain(password);
    expect(
      JSON.stringify(await ctx.db.select().from(deployment)),
    ).not.toContain(password);

    // `replicas` is the running count; steady; every other image removed.
    expect(ctx.cloud.calls).toContainEqual({
      method: 'ecsSetDesiredCount',
      region: REGION,
      cluster: OUTPUTS.cluster_arn,
      service: `web-${applicationId}`,
      desiredCount: 1,
    });
    expect(ctx.cloud.calls).toContainEqual({
      method: 'ecrDeleteImagesExcept',
      region: REGION,
      repositoryName: repository,
      keepTag: run.deploymentId,
    });
    // Nothing of the app's is quoted when the deploy works.
    expect(
      ctx.cloud.calls.some((call) => call.method === 'filterLogEvents'),
    ).toBe(false);

    // Reading the Service shows its Cloud account and region.
    const read = await request(http)
      .get(`/applications/${applicationId}`)
      .set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect((read.body as { cloudPlace: unknown }).cloudPlace).toEqual({
      cloudAccountId,
      cloudAccountName: 'Production AWS',
      cloud: 'aws',
      region: REGION,
    });

    // Deleting the Cloud account is refused while the Service runs in it.
    const removed = await request(http)
      .delete(`/cloud-accounts/${cloudAccountId}`)
      .set('Cookie', cookie);
    expect(removed.status).toBe(409);
    expect((removed.body as { message: string }).message).toContain(
      `1 Service (shop / production / web in ${REGION})`,
    );
  });

  /** The container of the task definition the state's last run wrote. */
  function containerWritten(stateId: string): Record<string, unknown> {
    const input = ctx.cloud.tofuInputs.filter((one) => one.stateId === stateId);
    const definition = JSON.parse(input.at(-1)!.definition) as {
      resource: {
        aws_ecs_task_definition: {
          service: { container_definitions: string };
        };
      };
    };
    const [container] = JSON.parse(
      definition.resource.aws_ecs_task_definition.service.container_definitions,
    ) as Record<string, unknown>[];
    return container;
  }

  it("registers the image's HEALTHCHECK in the task definition, recorded so a plan of the Service writes it too, and none for HEALTHCHECK NONE", async () => {
    process.env.FAKE_DOCKER_HEALTHCHECK = JSON.stringify({
      Test: ['CMD-SHELL', 'wget -qO- http://localhost:80/ || exit 1'],
      Interval: 15_000_000_000,
      Timeout: 4_000_000_000,
      StartPeriod: 10_000_000_000,
      Retries: 4,
    });
    const { plan, applicationId, run } = await appliedWeb();
    expect(run.status).toBe('done');
    const webStep = plan.steps[1];
    if (webStep.action !== 'create' || webStep.cloudRead?.status !== 'read') {
      throw new Error('the web was not read');
    }
    const webState = webStep.cloudRead.stateId;
    const check = {
      command: ['CMD-SHELL', 'wget -qO- http://localhost:80/ || exit 1'],
      interval: 15,
      timeout: 4,
      retries: 4,
      startPeriod: 10,
    };
    // Applied with the check, beside the target group's own.
    expect(containerWritten(webState).healthCheck).toEqual(check);
    const [recorded] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, run.deploymentId));
    expect(recorded.cloudRun).toMatchObject({
      healthCheck: {
        test: check.command,
        interval: 15_000_000_000,
        timeout: 4_000_000_000,
        startPeriod: 10_000_000_000,
        retries: 4,
      },
    });

    // Check for changes writes the task definition as deployed: no change.
    const reads = () =>
      ctx.cloud.calls.filter(
        (call) => call.method === 'plan' && call.stateId === webState,
      ).length;
    const before = reads();
    const checked = await request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie)
      .send({});
    expect(checked.status).toBeLessThan(300);
    for (let attempt = 0; reads() === before; attempt++) {
      if (attempt > 400) throw new Error('The Service was never read again');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(containerWritten(webState).healthCheck).toEqual(check);

    // An image built with HEALTHCHECK NONE registers no check.
    process.env.FAKE_DOCKER_HEALTHCHECK = JSON.stringify({ Test: ['NONE'] });
    ctx.cloud.replayPlanFor('web', 'image-only-no-variables');
    const operator = await agent('agentOperator', applicationId);
    const queued = await ctx.app
      .get(DeploymentsService)
      .redeploy(operator, applicationId);
    const redeployed = await settledDeployment(queued.deploymentId);
    expect(redeployed.status).toBe('done');
    expect(containerWritten(webState)).not.toHaveProperty('healthCheck');
    expect(redeployed.cloudRun).toMatchObject({ healthCheck: null });
  });

  it('ends the Deployment error when a new task fails to start, quoting its stoppedReason and its last 50 log lines', async () => {
    const printed = Array.from(
      { length: 60 },
      (_, n) => `line ${n + 1} of the app`,
    );
    ctx.cloud.failTaskStart(
      'Essential container in task exited (its container exited with code 1)',
      printed,
    );

    const failed = jest.spyOn(notifier(), 'buildError');
    const { applicationId, run } = await appliedWeb();

    expect(run.status).toBe('error');
    expect(run.description).toBe(
      'A new task failed to start: Essential container in task exited (its container exited with code 1)',
    );
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: applicationId,
        errorMessage:
          'A new task failed to start: Essential container in task exited (its container exited with code 1)',
      }),
    );
    failed.mockRestore();
    const log = await logOf(run.deploymentId);
    expect(log).toContain(
      `❌ [Cloud run] Task ${FAILED_TASK_ID} stopped: Essential container in task exited (its container exited with code 1)`,
    );
    expect(log).toContain('Its last 50 log lines:');
    expect(log).toContain('  line 11 of the app');
    expect(log).toContain('  line 60 of the app');
    expect(log).not.toContain('line 10 of the app');
    expect(ctx.cloud.calls).toContainEqual({
      method: 'filterLogEvents',
      region: REGION,
      logGroupName: `/cloudgate/${environmentId}/${applicationId}`,
      logStreamNames: [`service/service/${FAILED_TASK_ID}`],
      limit: 50,
    });
    // Not steady: no image is removed from ECR.
    expect(
      ctx.cloud.calls.some((call) => call.method === 'ecrDeleteImagesExcept'),
    ).toBe(false);
    const [row] = await ctx.db
      .select({ status: application.applicationStatus })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    expect(row.status).toBe('error');
  });

  describe('a Worker on ECS', () => {
    const WORKER = `version: 1
services:
  jobs:
    kind: worker
    size: small
    command: node
    args: [worker.js]
    source: { image: acme/jobs:1 }
`;

    /** The definition the state's last tofu run was handed. */
    function definitionWritten(stateId: string) {
      const input = ctx.cloud.tofuInputs.filter(
        (one) => one.stateId === stateId,
      );
      return JSON.parse(input.at(-1)!.definition) as {
        resource: Record<string, Record<string, Record<string, unknown>>>;
        output: Record<string, unknown>;
      };
    }

    beforeEach(() => {
      ctx.cloud.replayPlanFor('worker', 'worker-create');
    });

    it("plans only its real resources with the whole Environment network, and deploys it with no load balancer and the image's HEALTHCHECK, recorded as a worker with no Domain", async () => {
      process.env.FAKE_DOCKER_HEALTHCHECK = JSON.stringify({
        Test: ['CMD-SHELL', 'test -f /tmp/alive'],
      });
      const { plan, applicationId, run } = await appliedWeb(WORKER, 'jobs');

      // The first cloud Service makes the whole network, its load balancer
      // included, even when it is a Worker.
      expect(plan.steps.map((step) => step.action)).toEqual([
        'network-create',
        'create',
      ]);
      const step = plan.steps[1];
      if (step.action !== 'create' || step.cloudRead?.status !== 'read') {
        throw new Error('the worker was not read');
      }
      expect(step).toMatchObject({ kind: 'worker' });
      const { stateId } = step.cloudRead;
      const addresses = step.cloudRead.raw.map((line) => line.address);
      expect(addresses).toEqual(
        expect.arrayContaining([
          'aws_ecs_service.service',
          'aws_ecs_task_definition.service',
          'aws_security_group.service',
        ]),
      );
      expect(addresses.filter((one) => one.includes('aws_lb_'))).toEqual([]);
      expect(
        step.cloudRead.summary.filter((line) =>
          /target group|listener rule|domain/i.test(line),
        ),
      ).toEqual([]);
      expect(
        (plan as Plan & { notes: { kind: string }[] }).notes.map(
          (note) => note.kind,
        ),
      ).not.toContain('cloud-no-domain');

      // Deployed: an ECS service with no load_balancer, a task definition
      // with the image's own check, a security group that lets nothing in,
      // and ECS's rollout waited on.
      expect(run.status).toBe('done');
      const written = definitionWritten(stateId);
      expect(Object.keys(written.resource)).not.toContain(
        'aws_lb_target_group',
      );
      expect(Object.keys(written.resource)).not.toContain(
        'aws_lb_listener_rule',
      );
      expect(written.resource.aws_ecs_service.service).not.toHaveProperty(
        'load_balancer',
      );
      expect(written.resource.aws_security_group.service.ingress).toEqual([]);
      expect(containerWritten(stateId)).toMatchObject({
        healthCheck: { command: ['CMD-SHELL', 'test -f /tmp/alive'] },
      });
      expect(containerWritten(stateId)).not.toHaveProperty('portMappings');
      expect(ctx.cloud.calls).toContainEqual(
        expect.objectContaining({
          method: 'ecsRollout',
          service: `jobs-${applicationId}`,
        }),
      );
      const [created] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(created).toMatchObject({
        configKind: 'worker',
        cloudAccountId,
        region: REGION,
      });

      // Check for changes reads it as a Worker again: no load balancer.
      const reads = () =>
        ctx.cloud.calls.filter(
          (call) => call.method === 'plan' && call.stateId === stateId,
        ).length;
      const before = reads();
      const checked = await request(http)
        .post(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie)
        .send({});
      expect(checked.status).toBeLessThan(300);
      for (let attempt = 0; reads() === before; attempt++) {
        if (attempt > 400) throw new Error('The Worker was never read again');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(Object.keys(definitionWritten(stateId).resource)).not.toContain(
        'aws_lb_target_group',
      );

      // A Domain on it is refused, as on a Server.
      const refused = await request(http)
        .post('/domains')
        .set('Cookie', cookie)
        .send({
          host: 'jobs.example.com',
          applicationId,
          domainType: 'application',
          port: 3000,
        });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'KIND_TAKES_NO_DOMAIN' });
    });

    it("fails its deploy when its command exits at once, quoting the stopped task's reason in the Deployment log", async () => {
      ctx.cloud.failTaskStart(
        'Essential container in task exited (its container exited with code 1)',
        ['Error: QUEUE_URL is not set'],
      );

      const { run } = await appliedWeb(WORKER, 'jobs');

      expect(run.status).toBe('error');
      expect(run.description).toBe(
        'A new task failed to start: Essential container in task exited (its container exited with code 1)',
      );
      const log = await logOf(run.deploymentId);
      expect(log).toContain(
        `❌ [Cloud run] Task ${FAILED_TASK_ID} stopped: Essential container in task exited (its container exited with code 1)`,
      );
      expect(log).toContain('  Error: QUEUE_URL is not set');
    });

    it('switches a web there to a worker as a destroy and a create, confirmed by name', async () => {
      await appliedWeb();

      const saved = await request(http)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({ text: WORKER.replace('  jobs:', '  web:') });
      expect(saved.status).toBe(201);
      const open = (
        saved.body as {
          plans: {
            planId: string;
            steps: { action: string; configName: string; kind?: string }[];
          }[];
        }
      ).plans[0];
      expect(open.steps).toEqual([
        expect.objectContaining({ action: 'destroy', configName: 'web' }),
        expect.objectContaining({
          action: 'create',
          configName: 'web',
          kind: 'worker',
        }),
      ]);

      const unconfirmed = await request(http)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: open.planId });
      expect(unconfirmed.status).toBe(409);
      expect(unconfirmed.body).toMatchObject({
        code: 'PLAN_DESTROY_NOT_CONFIRMED',
      });
    });
  });

  describe('a Private web service on ECS', () => {
    const INTERNAL = `version: 1
services:
  inside:
    kind: web-private
    size: small
    port: 4000
    source: { image: acme/inside:1 }
`;
    const NAMESPACE = 'ns-0f00ba11private';
    /** The network's outputs once it holds the private DNS namespace. */
    const WITH_DNS = { ...OUTPUTS, private_dns_namespace_id: NAMESPACE };

    /** The definition the state's last tofu run was handed. */
    function definitionWritten(stateId: string) {
      const input = ctx.cloud.tofuInputs.filter(
        (one) => one.stateId === stateId,
      );
      return JSON.parse(input.at(-1)!.definition) as {
        resource: Record<string, Record<string, Record<string, unknown>>>;
        output: Record<string, unknown>;
      };
    }

    beforeEach(() => {
      ctx.cloud.replayPlanFor('network', 'network-create-private-dns');
      ctx.cloud.replayPlanFor('web-private', 'web-private-create');
    });

    it('plans the namespace on the network step with its price, and deploys an ECS service registered in private DNS with no load balancer, reached only from the VPC', async () => {
      const { plan, applicationId, run } = await appliedWeb(
        INTERNAL,
        'inside',
        WITH_DNS,
      );

      // The first web-private's plan: the network made with its namespace,
      // priced on the network step's own lines.
      const [network, step] = plan.steps;
      expect(network).toMatchObject({
        action: 'network-create',
        privateLinks: ['private-dns'],
      });
      if (network.action !== 'network-create') throw new Error('no network');
      if (network.cloudRead.status !== 'read') throw new Error('not read');
      expect(network.cloudRead.summary).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^Private DNS namespace `cloudgate\.internal`: create, .*about \$0\.50\/month/,
          ),
        ]),
      );
      if (step.action !== 'create' || step.cloudRead?.status !== 'read') {
        throw new Error('the web-private was not read');
      }
      expect(step).toMatchObject({ kind: 'web-private' });
      const addresses = step.cloudRead.raw.map((line) => line.address);
      expect(addresses).toEqual(
        expect.arrayContaining([
          'aws_ecs_service.service',
          'aws_service_discovery_service.service',
        ]),
      );
      expect(addresses.filter((one) => one.includes('aws_lb_'))).toEqual([]);

      // The network's row keeps its namespace from now on.
      const [row] = await ctx.db
        .select()
        .from(environmentNetwork)
        .where(eq(environmentNetwork.environmentId, environmentId));
      expect(row).toMatchObject({
        privateLinks: ['private-dns'],
        privateDnsNamespaceId: NAMESPACE,
      });

      // Deployed: registered through service_registries in the network's
      // namespace, no load balancer, its port in from the VPC only.
      expect(run.status).toBe('done');
      const { stateId } = step.cloudRead;
      const written = definitionWritten(stateId);
      expect(
        written.resource.aws_service_discovery_service.service,
      ).toMatchObject({
        name: 'inside',
        dns_config: { namespace_id: NAMESPACE, routing_policy: 'MULTIVALUE' },
      });
      expect(written.resource.aws_ecs_service.service).toMatchObject({
        service_registries: {
          registry_arn: '${aws_service_discovery_service.service.arn}',
        },
      });
      expect(written.resource.aws_ecs_service.service).not.toHaveProperty(
        'load_balancer',
      );
      expect(Object.keys(written.resource)).not.toContain(
        'aws_lb_target_group',
      );
      expect(written.resource.aws_security_group.service.ingress).toEqual([
        expect.objectContaining({
          from_port: 4000,
          to_port: 4000,
          protocol: 'tcp',
          cidr_blocks: ['10.80.0.0/16'],
        }),
      ]);

      // Recorded as a web-private, its address the one settled earlier.
      const [created] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(created).toMatchObject({ configKind: 'web-private', port: 4000 });
      const read = await request(http)
        .get(`/applications/${applicationId}`)
        .set('Cookie', cookie);
      expect(read.body).toMatchObject({
        internalAddress: 'http://inside.cloudgate.internal:4000',
      });

      // A Domain, a published port and previews are refused, as on a Server.
      const domain = await request(http)
        .post('/domains')
        .set('Cookie', cookie)
        .send({
          host: 'inside.example.com',
          applicationId,
          domainType: 'application',
          port: 4000,
        });
      expect(domain.status).toBe(409);
      expect(domain.body).toMatchObject({ code: 'KIND_TAKES_NO_DOMAIN' });
      const previews = await request(http)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({ isPreviewDeploymentsActive: true });
      expect(previews.status).toBe(409);
      expect(previews.body).toMatchObject({ code: 'KIND_TAKES_NO_PREVIEWS' });

      // A second web-private in the network adds no namespace again.
      const second = await request(http)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({
          text: `${INTERNAL}  other:\n    kind: web-private\n    port: 5000\n    source: { image: acme/other:1 }\n`,
        });
      expect(second.status).toBe(201);
      const again = await openPlan();
      expect(again.steps.map((one) => `${one.action}`)).not.toContain(
        'network-create',
      );
      expect(
        again.steps.filter(
          (one) =>
            one.action === 'network-change' && (one.privateLinks ?? []).length,
        ),
      ).toEqual([]);
      expect(again.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'create',
            configName: 'other',
            kind: 'web-private',
          }),
        ]),
      );
    });

    it('switches a web there to a web-private as a destroy and a create, confirmed by name', async () => {
      await appliedWeb();

      const saved = await request(http)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({ text: INTERNAL.replace('  inside:', '  web:') });
      expect(saved.status).toBe(201);
      const open = (
        saved.body as {
          plans: {
            planId: string;
            steps: { action: string; configName?: string; kind?: string }[];
          }[];
        }
      ).plans[0];
      expect(open.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'destroy', configName: 'web' }),
          expect.objectContaining({
            action: 'create',
            configName: 'web',
            kind: 'web-private',
          }),
        ]),
      );

      const unconfirmed = await request(http)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: open.planId });
      expect(unconfirmed.status).toBe(409);
      expect(unconfirmed.body).toMatchObject({
        code: 'PLAN_DESTROY_NOT_CONFIRMED',
      });
    });
  });

  describe('native.aws on ECS', () => {
    const NATIVE_WEB = `${WEB}    native:
      aws:
        "aws_ecs_service.service":
          health_check_grace_period_seconds: 60
          enable_execute_command: true
          deployment_maximum_percent: 150
          deployment_minimum_healthy_percent: 50
          deployment_circuit_breaker: { enable: true, rollback: true }
        "aws_lb_target_group.service":
          health_check: { path: /healthz }
        "aws_ecs_task_definition.service":
          container_definitions:
            stopTimeout: 90
`;
    const NATIVE = {
      'aws_ecs_service.service': {
        health_check_grace_period_seconds: 60,
        enable_execute_command: true,
        deployment_maximum_percent: 150,
        deployment_minimum_healthy_percent: 50,
        deployment_circuit_breaker: { enable: true, rollback: true },
      },
      'aws_lb_target_group.service': { health_check: { path: '/healthz' } },
      'aws_ecs_task_definition.service': {
        container_definitions: { stopTimeout: 90 },
      },
    };

    /** The `resource` object the last `tofu` run of a state was written with. */
    function resourcesWritten(
      stateId: string,
    ): Record<string, Record<string, Record<string, unknown>>> {
      const input = ctx.cloud.tofuInputs.filter(
        (one) => one.stateId === stateId,
      );
      return (
        JSON.parse(input.at(-1)!.definition) as {
          resource: Record<string, Record<string, Record<string, unknown>>>;
        }
      ).resource;
    }

    it('plans its values as native lines, applies them through the deploy over Cloudgate’s definition, holds them with the Service, and reads them back as no change', async () => {
      const { plan, applicationId, run } = await appliedWeb(NATIVE_WEB);
      expect(run.status).toBe('done');
      const webStep = plan.steps[1];
      if (webStep.action !== 'create' || webStep.cloudRead?.status !== 'read') {
        throw new Error('the web was not read');
      }
      const service = 'native.aws."aws_ecs_service.service"';
      expect(
        webStep.fields
          .filter((field) => 'native' in field && field.native)
          .map((field) => field.field),
      ).toEqual([
        `${service}.health_check_grace_period_seconds`,
        `${service}.enable_execute_command`,
        `${service}.deployment_maximum_percent`,
        `${service}.deployment_minimum_healthy_percent`,
        `${service}.deployment_circuit_breaker.enable`,
        `${service}.deployment_circuit_breaker.rollback`,
        'native.aws."aws_lb_target_group.service".health_check.path',
        'native.aws."aws_ecs_task_definition.service".container_definitions.stopTimeout',
      ]);

      // Held with the Service's saved settings, as written.
      const [row] = await ctx.db
        .select({ nativeAws: application.nativeAws })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(row.nativeAws).toEqual(NATIVE);

      // The deploy's apply laid it over Cloudgate's definition.
      const webState = webStep.cloudRead.stateId;
      const written = resourcesWritten(webState);
      expect(written.aws_ecs_service.service).toMatchObject(
        NATIVE['aws_ecs_service.service'],
      );
      expect(written.aws_lb_target_group.service.health_check).toMatchObject({
        path: '/healthz',
        matcher: '200-399',
      });
      expect(containerWritten(webState)).toMatchObject({
        stopTimeout: 90,
        image: expect.stringContaining(`:${run.deploymentId}`) as string,
      });

      // Check for changes lays the applied block, so its cloud lines show
      // the native values and Drift compares against the merged definition;
      // the config is what was applied, so the step changes no field.
      const reads = () =>
        ctx.cloud.calls.filter(
          (call) => call.method === 'plan' && call.stateId === webState,
        ).length;
      const before = reads();
      const checked = await request(http)
        .post(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie)
        .send({});
      expect(checked.status).toBeLessThan(300);
      const step = (
        checked.body as { steps: { configName?: string; fields?: unknown[] }[] }
      ).steps.find((one) => one.configName === 'web');
      expect(step?.fields).toEqual([]);
      for (let attempt = 0; reads() === before; attempt++) {
        if (attempt > 400) throw new Error('The Service was never read again');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(resourcesWritten(webState).aws_ecs_service.service).toMatchObject(
        NATIVE['aws_ecs_service.service'],
      );
      expect(containerWritten(webState).stopTimeout).toBe(90);
    });

    // Acceptance: a hand change to an open setting native sets is
    // Drift against the merged definition, put back to the native value.
    it('shows a hand change to an open setting native sets as Drift, put back to the native value', async () => {
      const { plan } = await appliedWeb(NATIVE_WEB);
      const webStep = plan.steps[1];
      if (webStep.action !== 'create' || webStep.cloudRead?.status !== 'read') {
        throw new Error('the web was not read');
      }
      const webState = webStep.cloudRead.stateId;

      // The refresh saw the grace period moved by hand from native's 60 to
      // 0, and the plan of the merged definition moves it back to 60.
      const stored = storedPlan('drift-field') as unknown as TofuShowJson;
      const ecs = stored.resource_changes!.find(
        (one) => one.address === 'aws_ecs_service.service',
      )!;
      const made = ecs.change.before as Record<string, unknown>;
      const drifted: TofuShowJson = {
        ...stored,
        resource_drift: [
          {
            ...ecs,
            change: {
              ...ecs.change,
              actions: ['update'],
              before: { ...made, health_check_grace_period_seconds: 60 },
              after: { ...made, health_check_grace_period_seconds: 0 },
            },
          },
        ],
        resource_changes: stored.resource_changes!.map((one) =>
          one === ecs
            ? {
                ...one,
                change: {
                  ...one.change,
                  actions: ['update'],
                  before: { ...made, health_check_grace_period_seconds: 0 },
                  after: { ...made, health_check_grace_period_seconds: 60 },
                },
              }
            : {
                ...one,
                change: {
                  ...one.change,
                  actions: ['no-op'],
                  after: one.change.before,
                  after_unknown: {},
                },
              },
        ),
      };
      ctx.cloud.replayShowFor('web', drifted as unknown as TofuShow);

      const checked = await request(http)
        .post(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie)
        .send({});
      expect(checked.status).toBeLessThan(300);
      let read: Plan | undefined;
      for (let attempt = 0; attempt < 400; attempt++) {
        const [found] = await ctx.db
          .select()
          .from(planTable)
          .where(eq(planTable.status, 'open'));
        if (
          found &&
          !found.steps.some(
            (step) =>
              'cloudRead' in step && step.cloudRead?.status === 'reading',
          )
        ) {
          read = found;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const step = read?.steps.find(
        (one) => 'configName' in one && one.configName === 'web',
      );
      if (
        !step ||
        !('cloudRead' in step) ||
        step.cloudRead?.status !== 'read'
      ) {
        throw new Error('the web was not read again');
      }
      expect(step.cloudRead.drift).toEqual([
        expect.objectContaining({
          address: 'aws_ecs_service.service',
          deleted: false,
          fields: [
            {
              field: 'health_check_grace_period_seconds',
              hand: '0',
              cloudgate: '60',
            },
          ],
        }),
      ]);
      // Read against the definition with native laid over Cloudgate's.
      expect(
        resourcesWritten(webState).aws_ecs_service.service
          .health_check_grace_period_seconds,
      ).toBe(60);
    });

    // Stories 24 and 43: native wins at deploy, so the console may
    // not change a cap it sets, as the Database page may not a class.
    it('refuses a console edit of a cap native sets, naming the path, and saves the rest', async () => {
      const { applicationId } = await appliedWeb();
      await ctx.db
        .update(application)
        .set({
          nativeAws: { 'aws_ecs_task_definition.service': { cpu: '1024' } },
        })
        .where(eq(application.applicationId, applicationId));
      const [before] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId));

      const refused = await request(http)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({ cpuLimit: String(2e9) });
      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        'cpuLimit is set by web.native.aws."aws_ecs_task_definition.service".cpu in the Project config, which owns it while it sets it; change it there, or take the key out to hand it back to this page',
      );

      const saved = await request(http)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({
          cpuLimit: before.cpuLimit,
          memoryLimit: String(4 * 1024 * 1024 * 1024),
        });
      expect(saved.status).toBe(200);
      const [after] = await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(after).toMatchObject({
        cpuLimit: before.cpuLimit,
        memoryLimit: String(4 * 1024 * 1024 * 1024),
      });
    });

    it('fails the deploy of a stored row holding a value now locked, naming it, before anything changes', async () => {
      const { applicationId } = await appliedWeb();
      await ctx.db
        .update(application)
        .set({
          nativeAws: {
            'aws_ecs_service.service': { desired_count: 4 },
          },
        })
        .where(eq(application.applicationId, applicationId));
      const applies = () =>
        ctx.cloud.calls.filter((call) => call.method === 'apply').length;
      const before = applies();

      ctx.cloud.replayPlanFor('web', 'image-only-no-variables');
      const operator = await agent('agentOperator', applicationId);
      const queued = await ctx.app
        .get(DeploymentsService)
        .redeploy(operator, applicationId);
      const run = await settledDeployment(queued.deploymentId);

      expect(run.status).toBe('error');
      expect(run.description).toContain(
        'web.native.aws."aws_ecs_service.service".desired_count: refused',
      );
      expect(applies()).toBe(before);
    });
  });

  it('refuses a linked Registry on the cloud Service, naming it', async () => {
    const { applicationId } = await appliedWeb();
    const [linked] = await ctx.db
      .insert(registry)
      .values({
        organizationId,
        name: 'company-registry',
        username: 'deployer',
        password: 'registry-password',
        url: 'registry.example.com',
      })
      .returning();

    for (const field of ['registryId', 'buildRegistryId']) {
      const res = await request(http)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({ [field]: linked.registryId });
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        'Registry company-registry cannot be linked',
      );
    }
    const [row] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));
    expect(row.registryId).toBeNull();
    expect(row.buildRegistryId).toBeNull();
  });

  it('lets agentOperator redeploy (an image-only plan, a fresh token) and cancel a cloud Service', async () => {
    const { applicationId } = await appliedWeb();
    const operator = await agent('agentOperator', applicationId);
    const deployments = ctx.app.get(DeploymentsService);

    // A redeploy reads AWS again and applies only an image-only plan.
    ctx.cloud.replayPlanFor('web', 'image-only-no-variables');
    const queued = await deployments.redeploy(operator, applicationId);
    const redeployed = await settledDeployment(queued.deploymentId);
    expect(redeployed.status).toBe('done');
    const passwords = ctx.cloud.ecrPasswords;
    expect(passwords).toHaveLength(2);
    expect(passwords[0]).not.toBe(passwords[1]);
    // The repository was there: no second targeted apply.
    expect(
      ctx.cloud.calls.filter(
        (call) => call.method === 'apply' && 'targets' in call && call.targets,
      ),
    ).toHaveLength(1);

    // A plan that does more than the image stops the redeploy, unapplied.
    ctx.cloud.replayPlanFor('web', 'drift-field');
    const drifted = await deployments.redeploy(operator, applicationId);
    const stopped = await settledDeployment(drifted.deploymentId);
    expect(stopped.status).toBe('error');
    expect(stopped.description).toBe(
      'AWS differs from what Cloudgate made: review the plan',
    );

    // Cancel, while its Cloud run is planning: nothing has been applied.
    ctx.cloud.hangFor('web');
    const planning = await deployments.redeploy(operator, applicationId);
    for (let attempt = 0; ; attempt++) {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, planning.deploymentId));
      if (row.cloudRun && row.status === 'running') break;
      if (attempt > 400) throw new Error('The Cloud run never started');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const cancelled = await deployments.cancel(operator, planning.deploymentId);
    expect(cancelled.status).toBe('cancelled');
  });

  it('starts a stopped Service with a Deploy, which writes replicas back', async () => {
    const { applicationId } = await appliedWeb();
    const stopped = await request(http)
      .post(`/applications/${applicationId}/stop`)
      .set('Cookie', cookie);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ applicationStatus: 'stopped' });
    ctx.cloud.calls.length = 0;

    ctx.cloud.replayPlanFor('web', 'image-only-no-variables');
    const queued = await ctx.app.get(DeploymentsService).redeploy(
      {
        user: { id: await ownerId() },
        session: { activeOrganizationId: organizationId },
      },
      applicationId,
    );
    expect((await settledDeployment(queued.deploymentId)).status).toBe('done');

    expect(
      ctx.cloud.calls.filter((call) => call.method === 'ecsSetDesiredCount'),
    ).toEqual([
      {
        method: 'ecsSetDesiredCount',
        region: REGION,
        cluster: OUTPUTS.cluster_arn,
        service: `web-${applicationId}`,
        desiredCount: 1,
      },
    ]);
    const [row] = await ctx.db
      .select({ status: application.applicationStatus })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    expect(row.status).toBe('done');
  });

  it('never lets agentOperator Apply the plan that would create the cloud Service', async () => {
    const operator = await agent('agentOperator', null);
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: WEB });
    expect(saved.status).toBe(201);
    const read = await openPlan();

    await expect(
      ctx.app
        .get(ProjectConfigService)
        .applyPlan(operator, environmentId, read.planId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const [row] = await ctx.db
      .select({ status: planTable.status })
      .from(planTable)
      .where(eq(planTable.planId, read.planId));
    expect(row.status).toBe('open');
    expect(await ctx.db.select().from(application)).toEqual([]);
  });

  it('fails a deploy whose Cloud account credential stopped working before any change, naming it, and records it on the Cloud account', async () => {
    const { applicationId } = await appliedWeb();
    ctx.cloud.calls.length = 0;
    ctx.cloud.refuseRole(
      'User: arn:aws:iam::123456789012:user/cloudgate is not authorized to perform: sts:AssumeRole',
    );

    const queued = await ctx.app.get(DeploymentsService).redeploy(
      {
        user: { id: await ownerId() },
        session: { activeOrganizationId: organizationId },
      },
      applicationId,
    );
    const run = await settledDeployment(queued.deploymentId);

    expect(run.status).toBe('error');
    expect(run.description).toBe(
      'Cloud account Production AWS could not take on its deploy role: AWS answered AccessDenied: User: arn:aws:iam::123456789012:user/cloudgate is not authorized to perform: sts:AssumeRole. Fix its credential or role in Organization settings, then Check for changes',
    );
    expect(
      ctx.cloud.calls.filter((call) =>
        ['apply', 'ecrAuthorizationToken'].includes(call.method),
      ),
    ).toEqual([]);
    const [account] = await ctx.db
      .select()
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    expect(account.lastCheckResult).toBe('failed');
    expect(account.lastCheckReason).toContain('AccessDenied');
  });

  it("runs a deploy in a Cloud account that became a Google Cloud one as Google's, which finds no Google network and changes nothing (slice 6, S12)", async () => {
    const { applicationId } = await appliedWeb();
    await makeGoogleCloudAccount(ctx.db, cloudAccountId);
    ctx.cloud.calls.length = 0;

    const queued = await ctx.app.get(DeploymentsService).redeploy(
      {
        user: { id: await ownerId() },
        session: { activeOrganizationId: organizationId },
      },
      applicationId,
    );
    const run = await settledDeployment(queued.deploymentId);

    expect(run.status).toBe('error');
    expect(run.description).toBe(
      `The ${environmentNetworkName(REGION)} is not made, so there is nowhere to run this Service. Check for changes, then apply the plan`,
    );
    expect(ctx.cloud.calls).toEqual([]);
    expect(ctx.google.calls.filter((call) => call.method === 'apply')).toEqual(
      [],
    );
  });

  it('shows the Service its cloud place to an Agent that holds no cloudAccount statement', async () => {
    const { applicationId } = await appliedWeb();
    const operator = await agent('agentOperator', applicationId);

    const found = await ctx.app
      .get(ApplicationsService)
      .findOne(operator, applicationId);

    expect(found.cloudPlace).toEqual({
      cloudAccountId,
      cloudAccountName: 'Production AWS',
      cloud: 'aws',
      region: REGION,
    });
  });

  async function ownerId(): Promise<string> {
    const res = await request(http)
      .get('/api/auth/get-session')
      .set('Cookie', cookie);
    return (res.body as { user: { id: string } }).user.id;
  }
});
