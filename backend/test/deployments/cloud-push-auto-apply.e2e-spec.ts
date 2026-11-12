import { createHmac } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import {
  application,
  cloudAccount,
  deployment,
  plan as planTable,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { SourceCloneService } from '../../src/git-providers/source-clone.service';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { fakeBinShell } from '../utils/fake-bin-shell';
import { storedPlan } from '../utils/fake-cloud-port';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(240_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const DIFFERS = 'AWS differs from what Cloudgate made: review the plan';

const WEB = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
`;

const connection = {
  name: 'Team GitHub',
  appName: 'cloudgate-app',
  appId: 12345,
  clientId: 'Iv1.abc123',
  clientSecret: 'github-client-secret',
  installationId: '99887766',
  privateKey:
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----',
  webhookSecret: 'wh-secret',
};

// Signs the payload exactly as GitHub does (github-push-deploy.e2e-spec.ts).
const sign = (secret: string, payload: object) =>
  `sha256=${createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex')}`;

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

/** A `docker` that builds, pulls, pushes and logs in without a daemon. */
const FAKE_DOCKER = `#!/bin/bash
case "$1" in
  login) cat > /dev/null; echo "Login Succeeded" ;;
  pull) echo "Status: Downloaded newer image for $2" ;;
  build|buildx) echo "Successfully built the pushed commit" ;;
  push) echo "\${2##*:}: digest: sha256:0f1e size: 1570" ;;
  image) [ "$2" = inspect ] && echo amd64 ;;
esac
exit 0
`;

interface ResourceChange {
  address: string;
  type: string;
  name: string;
  change: { actions: string[]; before: unknown; after: unknown };
}

/** The image-only plan a deploy reads, with one resource change altered or added. */
function imageOnlyWith(
  alter: (changes: ResourceChange[]) => ResourceChange[],
): TofuShow {
  const show = structuredClone(storedPlan('image-only-no-variables')) as {
    resource_changes: ResourceChange[];
  };
  show.resource_changes = alter(show.resource_changes);
  return show;
}

const securityGroup = (changes: ResourceChange[]) =>
  changes.find((one) => one.address === 'aws_security_group.service')!;

/** A deploy's plan that does more than its new image, by what it does. */
const BEYOND_THE_IMAGE: Array<{
  name: string;
  show: () => TofuShow;
  /** The raw AWS line the stopped deploy's plan step carries for it. */
  line: { address: string; action: string };
}> = [
  {
    name: 'a create',
    show: () =>
      imageOnlyWith((changes) => {
        const group = securityGroup(changes);
        return [
          ...changes,
          {
            ...structuredClone(group),
            address: 'aws_security_group.extra',
            name: 'extra',
            change: {
              ...structuredClone(group.change),
              actions: ['create'],
              before: null,
            },
          },
        ];
      }),
    line: { address: 'aws_security_group.extra', action: 'create' },
  },
  {
    // Its create plan listed it: a push still stops rather than make again
    // what was deleted by hand (spec Story 53).
    name: 'a create of something deleted by hand',
    show: () =>
      imageOnlyWith((changes) =>
        changes.map((one) =>
          one.address === 'aws_cloudwatch_log_group.service'
            ? {
                ...one,
                change: { ...one.change, actions: ['create'], before: null },
              }
            : one,
        ),
      ),
    line: { address: 'aws_cloudwatch_log_group.service', action: 'create' },
  },
  {
    name: 'a destroy',
    show: () =>
      imageOnlyWith((changes) =>
        changes.map((one) =>
          one.address === 'aws_security_group.service'
            ? {
                ...one,
                change: { ...one.change, actions: ['delete'], after: null },
              }
            : one,
        ),
      ),
    line: { address: 'aws_security_group.service', action: 'destroy' },
  },
  {
    name: 'a replace',
    show: () =>
      imageOnlyWith((changes) =>
        changes.map((one) =>
          one.address === 'aws_lb_target_group.service'
            ? {
                ...one,
                change: { ...one.change, actions: ['delete', 'create'] },
              }
            : one,
        ),
      ),
    line: { address: 'aws_lb_target_group.service', action: 'replace' },
  },
  {
    name: 'drift',
    show: () => storedPlan('drift-field'),
    line: { address: 'aws_security_group.service', action: 'change' },
  },
];

/**
 * The auto-apply rule: a deploy of a cloud Service that no
 * Apply queued — a code push, a console Save or an Agent's redeploy — reads
 * AWS in its Cloud run and applies on its own only an image-only plan.
 * Anything else (a create, a destroy, a replace, drift) stops it before any
 * change: the Deployment ends `error` with "AWS differs from what Cloudgate
 * made: review the plan", its whole plan becomes the Environment's open plan
 * with the Service's step carrying what it read, and the two link to each
 * other. Applying that plan approves what the deploy met.
 *
 * Against the fake cloud port replaying stored plan files, a real shell
 * whose `docker` is the fake above, and a clone that writes a Dockerfile
 * instead of reaching GitHub.
 */
describe('A push, Save or Agent redeploy auto-applies only an image-only plan (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let ownerId: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  let githubId: string;
  const shell = fakeBinShell('auto', { docker: FAKE_DOCKER });
  const { execMock } = shell;

  beforeAll(async () => {
    shell.setUp();
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    http = ctx.app.getHttpServer() as App;
    ctx.app.get(CloudServiceDeploys).pollIntervalMs = 10;
    // A pushed commit's clone, without GitHub: a tree with a Dockerfile.
    const clones = ctx.app.get<SourceCloneService>(SourceCloneService);
    const real = clones.cloneProgram.bind(
      clones,
    ) as SourceCloneService['cloneProgram'];
    jest
      .spyOn(clones, 'cloneProgram')
      .mockImplementation((source, outputPath, options) =>
        source.sourceType === 'github'
          ? Promise.resolve({
              command: `mkdir -p '${outputPath}' && printf 'FROM nginx\\n' > '${outputPath}/Dockerfile' && echo "Cloned acme/shop at the pushed commit" ;`,
              env: {},
            })
          : real(source, outputPath, options),
      );
  });

  afterAll(async () => {
    await ctx?.teardown();
    shell.tearDown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockClear();
    const res = await request(http).post('/api/auth/sign-up/email').send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    ownerId = (res.body as { user: { id: string } }).user.id;
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
    const github = await ctx.app
      .get(GithubService)
      .create(ownerCtx(), connection);
    githubId = github.githubId;

    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('web', 'web-create');
  });

  const ownerCtx = () => ({
    user: { id: ownerId },
    session: { activeOrganizationId: organizationId },
  });

  async function poll<T>(
    read: () => Promise<T | undefined>,
    what: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 600; attempt++) {
      const found = await read();
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  const openPlan = () =>
    poll(async () => {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(
          and(
            eq(planTable.environmentId, environmentId),
            eq(planTable.status, 'open'),
          ),
        );
      return found &&
        !found.steps.some(
          (step) =>
            (step.action === 'create' || step.action === 'network-create') &&
            step.cloudRead?.status === 'reading',
        )
        ? found
        : undefined;
    }, 'the open plan to be read');

  const settledPlan = (planId: string) =>
    poll(async () => {
      const [row] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, planId));
      return row.results !== null &&
        !row.results.some((result) => result.status === 'running')
        ? row
        : undefined;
    }, 'the Apply to end');

  const settledDeployment = (deploymentId: string) =>
    poll(async () => {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      return row && ['done', 'error', 'cancelled'].includes(row.status)
        ? row
        : undefined;
    }, 'the Deployment to end');

  /** Plans and applies the config, and waits for the web's first Deployment. */
  async function appliedWeb(): Promise<{
    applicationId: string;
    first: Deployment;
  }> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: WEB });
    expect(saved.status).toBe(201);
    const read = await openPlan();
    const networkStep = read.steps[0];
    if (networkStep.action !== 'network-create') throw new Error('no network');
    if (networkStep.cloudRead.status !== 'read') throw new Error('not read');
    ctx.cloud.outputsFor(networkStep.cloudRead.stateId, OUTPUTS);
    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    const applied = await settledPlan(read.planId);
    const web = applied.results!.find((one) => one.configName === 'web')!;
    if (web.deploy?.status !== 'queued') throw new Error('not queued');
    const first = await settledDeployment(web.deploy.deploymentId);
    expect(first.status).toBe('done');
    return { applicationId: web.serviceId!, first };
  }

  /** The Service now builds from acme/shop's main, as a push-deployed one does. */
  async function builtFromGithub(applicationId: string) {
    await ctx.db
      .update(application)
      .set({
        sourceType: 'github',
        githubId,
        owner: 'acme',
        repository: 'shop',
        branch: 'main',
        buildType: 'dockerfile',
      })
      .where(eq(application.applicationId, applicationId));
  }

  /** A real-shaped, signed `push` of acme/shop's main, changing code only. */
  async function push(
    applicationId: string,
    after: string,
  ): Promise<Deployment> {
    const payload = {
      ref: 'refs/heads/main',
      before: '1111111111111111111111111111111111111111',
      after,
      deleted: false,
      installation: { id: 99887766 },
      repository: {
        name: 'shop',
        full_name: 'acme/shop',
        owner: { name: 'acme', login: 'acme' },
      },
      pusher: { name: 'grace' },
      head_commit: { id: after, message: 'fix: the checkout button' },
      commits: [
        {
          id: after,
          message: 'fix: the checkout button',
          added: [],
          modified: ['src/checkout.ts'],
          removed: [],
        },
      ],
    };
    const res = await request(http)
      .post('/github/webhook')
      .set('x-github-event', 'push')
      .set('x-hub-signature-256', sign('wh-secret', payload))
      .send(payload);
    expect(res.status).toBeLessThan(300);
    const queued = await poll(async () => {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(
          and(
            eq(deployment.applicationId, applicationId),
            ne(deployment.title, 'Plan applied'),
          ),
        );
      return row;
    }, 'the push to record a Deployment');
    return settledDeployment(queued.deploymentId);
  }

  const logOf = async (deploymentId: string) => {
    const res = await request(http)
      .get(`/deployments/${deploymentId}/logs`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.text;
  };

  /** The Environment's plan as the console reads it. */
  const environmentPlan = async () => {
    const res = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: Plan & { stoppedDeployment: unknown } }).plan;
  };

  /** What a stopped deploy leaves: no change, the sentence, the open plan, both links. */
  async function expectStoppedForReview(
    stopped: Deployment,
    applicationId: string,
    line: { address: string; action: string },
    webState: string,
  ): Promise<Plan> {
    expect(stopped.status).toBe('error');
    expect(stopped.description).toBe(DIFFERS);
    const log = await logOf(stopped.deploymentId);
    // Before any change: the apply never ran.
    expect(log).not.toContain('Apply complete!');
    expect(log).toContain('Reading AWS again before applying');
    expect(log).toContain(
      '⛔ [Cloud run] AWS differs from what Cloudgate made, so nothing was applied: it would ',
    );
    expect(log).toContain(line.address);
    expect(log).not.toContain('✅ [Cloud run] web runs the image');

    // Its whole plan is the Environment's open plan, naming the deploy.
    const open = await openPlan();
    expect(open).toMatchObject({ source: 'deploy', requestedBy: null });
    expect(log).toContain(
      `📋 [Cloud run] Its whole plan is the Environment's open plan now (${open.planId})`,
    );
    const step = open.steps.find(
      (one) => one.action === 'change' && one.serviceId === applicationId,
    );
    if (step?.action !== 'change' || step.cloudRead?.status !== 'read') {
      throw new Error('the stopped Service has no step with its AWS lines');
    }
    expect(step.cloudRead).toMatchObject({
      stateId: webState,
      imageOnly: false,
    });
    expect(step.cloudRead.raw).toContainEqual(expect.objectContaining(line));

    // The Deployment links to the plan, and the plan back.
    const [row] = await ctx.db
      .select({ reviewPlanId: deployment.reviewPlanId })
      .from(deployment)
      .where(eq(deployment.deploymentId, stopped.deploymentId));
    expect(row.reviewPlanId).toBe(open.planId);
    const shown = await environmentPlan();
    expect(shown.planId).toBe(open.planId);
    expect(shown.stoppedDeployment).toEqual({
      deploymentId: stopped.deploymentId,
      applicationId,
      configName: 'web',
      title: stopped.title,
      status: 'error',
      createdAt: stopped.createdAt,
    });
    const listed = await request(http)
      .get(`/applications/${applicationId}/deployments`)
      .set('Cookie', cookie);
    expect(listed.status).toBe(200);
    expect(
      (listed.body as Deployment[]).find(
        (one) => one.deploymentId === stopped.deploymentId,
      ),
    ).toMatchObject({ reviewPlanId: open.planId });
    return open;
  }

  /** The Service's Infrastructure state, as its create's plan read it. */
  async function webStateOf(applicationId: string): Promise<string> {
    const [found] = await ctx.db
      .select({ steps: planTable.steps })
      .from(planTable)
      .where(eq(planTable.status, 'applied'));
    const step = found.steps.find(
      (one) => one.action === 'create' && one.configName === 'web',
    );
    if (step?.action !== 'create' || step.cloudRead?.status !== 'read') {
      throw new Error(`${applicationId} was not read`);
    }
    return step.cloudRead.stateId;
  }

  it('applies an image-only push on its own, with build, plan and apply lines in the one Deployment log', async () => {
    const { applicationId } = await appliedWeb();
    await builtFromGithub(applicationId);
    ctx.cloud.replayPlanFor('web', 'image-only-no-variables');

    const run = await push(applicationId, 'a'.repeat(40));

    expect(run.status).toBe('done');
    const log = await logOf(run.deploymentId);
    const at = (text: string) => {
      const index = log.indexOf(text);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      at('Cloned acme/shop at the pushed commit'),
      at('☁️ [Cloud run] Built.'),
      at('📦 [Push] Uploading image to'),
      at('Reading AWS again before applying'),
      at('📋 [Cloud run] '),
      log.lastIndexOf('Apply complete!'),
      at('✅ [Cloud run] web runs the image of this Deployment'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(log).not.toContain(DIFFERS);
    // No plan was opened for it.
    const [stillApplied] = await ctx.db
      .select()
      .from(planTable)
      .where(eq(planTable.status, 'open'));
    expect(stillApplied).toBeUndefined();
    const [row] = await ctx.db
      .select({ reviewPlanId: deployment.reviewPlanId })
      .from(deployment)
      .where(eq(deployment.deploymentId, run.deploymentId));
    expect(row.reviewPlanId).toBeNull();
  });

  it.each(BEYOND_THE_IMAGE)(
    'stops a push that meets $name before any change, opens its plan and links the two',
    async ({ show, line }) => {
      const { applicationId } = await appliedWeb();
      const webState = await webStateOf(applicationId);
      await builtFromGithub(applicationId);
      ctx.cloud.replayShowFor('web', show());

      const stopped = await push(applicationId, 'b'.repeat(40));

      await expectStoppedForReview(stopped, applicationId, line, webState);
    },
  );

  it('opens a plan that adopts by tag what the stopped push would have made again', async () => {
    const { applicationId } = await appliedWeb();
    const webState = await webStateOf(applicationId);
    await builtFromGithub(applicationId);
    const logGroup = BEYOND_THE_IMAGE.find(
      (one) => one.line.address === 'aws_cloudwatch_log_group.service',
    )!;
    // The state lost its record: it is not in the refreshed prior state.
    const show = logGroup.show() as {
      prior_state: {
        values: { root_module: { resources: { address: string }[] } };
      };
    };
    const held = show.prior_state.values.root_module;
    held.resources = held.resources.filter(
      (one) => one.address !== 'aws_cloudwatch_log_group.service',
    );
    ctx.cloud.replayShowFor('web', show);
    // Still in AWS, and marked for this state.
    const arn = `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/cloudgate/web`;
    ctx.cloud.leaveTagged(REGION, arn, {
      'cloudgate:cloud-account': cloudAccountId,
      'cloudgate:environment': environmentId,
      'cloudgate:state': webState,
      'cloudgate:address': 'aws_cloudwatch_log_group.service',
    });

    const stopped = await push(applicationId, 'c'.repeat(40));

    expect(stopped.description).toBe(DIFFERS);
    const open = await openPlan();
    const step = open.steps.find(
      (one) => one.action === 'change' && one.serviceId === applicationId,
    );
    if (step?.action !== 'change' || step.cloudRead?.status !== 'read') {
      throw new Error('the stopped Service has no step with its AWS lines');
    }
    expect(step.cloudRead.adopt).toEqual([
      expect.objectContaining({
        address: 'aws_cloudwatch_log_group.service',
        arn,
      }),
    ]);
  });

  it('stops a console redeploy alike, replacing an older open plan, whose Apply then applies exactly what the deploy met', async () => {
    const { applicationId } = await appliedWeb();
    const webState = await webStateOf(applicationId);
    // An open plan of a config edit, made before the deploy.
    const edited = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: WEB.replace('size: small', 'size: medium') });
    expect(edited.status).toBe(201);
    const older = await openPlan();

    ctx.cloud.replayPlanFor('web', 'drift-field');
    const queued = await ctx.app
      .get(DeploymentsService)
      .redeploy(ownerCtx(), applicationId);
    const stopped = await settledDeployment(queued.deploymentId);
    const open = await expectStoppedForReview(
      stopped,
      applicationId,
      { address: 'aws_security_group.service', action: 'change' },
      webState,
    );
    expect(open.planId).not.toBe(older.planId);
    const [replaced] = await ctx.db
      .select({ status: planTable.status })
      .from(planTable)
      .where(eq(planTable.planId, older.planId));
    expect(replaced.status).toBe('superseded');

    // Applying it approves the drift put back: its Deployment goes on.
    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: open.planId });
    expect(applied.status).toBe(200);
    const settled = await settledPlan(open.planId);
    const web = settled.results!.find((one) => one.configName === 'web')!;
    if (web.deploy?.status !== 'queued') throw new Error('not queued');
    const put = await settledDeployment(web.deploy.deploymentId);
    expect(put.status).toBe('done');
    expect(await logOf(put.deploymentId)).not.toContain(DIFFERS);
  });

  it('holds an Agent redeploy to the same rule', async () => {
    const { applicationId } = await appliedWeb();
    const webState = await webStateOf(applicationId);
    const created = await request(http)
      .post('/agents')
      .set('Cookie', cookie)
      .send({
        name: 'operator-bot',
        role: 'agentOperator',
        grant: {
          accessedProjects: [projectId],
          accessedEnvironments: [environmentId],
          accessedServices: [applicationId],
        },
      });
    expect(created.status).toBe(201);
    const operator = {
      user: { id: (created.body as { agent: { id: string } }).agent.id },
      session: { activeOrganizationId: organizationId },
    };
    const deployments = ctx.app.get(DeploymentsService);

    ctx.cloud.replayPlanFor('web', 'image-only-no-variables');
    const imageOnly = await deployments.redeploy(operator, applicationId);
    expect((await settledDeployment(imageOnly.deploymentId)).status).toBe(
      'done',
    );

    const [replace] = BEYOND_THE_IMAGE.filter(
      (one) => one.name === 'a replace',
    );
    ctx.cloud.replayShowFor('web', replace.show());
    const queued = await deployments.redeploy(operator, applicationId);
    await expectStoppedForReview(
      await settledDeployment(queued.deploymentId),
      applicationId,
      replace.line,
      webState,
    );
  });
});
