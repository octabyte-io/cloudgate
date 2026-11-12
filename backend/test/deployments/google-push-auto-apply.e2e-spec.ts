import { createHmac } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import { RELOAD_LABEL } from '../../src/cloud-accounts/gcp/definitions/cloud-run-definition';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import {
  application,
  cloudAccount,
  deployment,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { SourceCloneService } from '../../src/git-providers/source-clone.service';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { GoogleServiceDeploys } from '../../src/project-config/applier/google-service-deploys.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { fakeBinShell } from '../utils/fake-bin-shell';
import { storedGooglePlan } from '../utils/fake-google-cloud-port';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(240_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';
const DIFFERS =
  'Google Cloud differs from what Cloudgate made: review the plan';
const CLOUD_RUN = 'google_cloud_run_v2_service.service';

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

/** A `docker` that builds, pulls, pushes and logs in without a daemon. */
const FAKE_DOCKER = `#!/bin/bash
case "$1" in
  login) cat > /dev/null; echo "Login Succeeded" ;;
  pull) echo "Status: Downloaded newer image for \${@: -1}" ;;
  build|buildx) echo "Successfully built the pushed commit" ;;
  push) echo "\${2##*:}: digest: sha256:0f1e size: 1570" ;;
  image) [ "$2" = inspect ] && echo amd64 ;;
esac
exit 0
`;

interface ResourceChange {
  address: string;
  change: { actions: string[]; after: Record<string, unknown> };
}

interface CloudRunTemplate {
  labels: Record<string, string>;
  scaling: { min_instance_count: number; max_instance_count: number }[];
  containers: { resources: { limits: Record<string, string> }[] }[];
}

/** The stored image-only plan, its Cloud Run update's planned template altered. */
function imageOnlyWith(alter: (template: CloudRunTemplate) => void): TofuShow {
  const show = structuredClone(storedGooglePlan('image-only')) as {
    resource_changes: ResourceChange[];
  };
  const service = show.resource_changes.find(
    (one) => one.address === CLOUD_RUN,
  )!;
  alter((service.change.after.template as CloudRunTemplate[])[0]);
  return show;
}

/** A deploy's plan that does more than its new image, by what it does. */
const BEYOND_THE_IMAGE: Array<{
  name: string;
  show: () => TofuShow;
  /** The raw Google line the stopped deploy's plan step carries for it. */
  line: { address: string; action: string };
}> = [
  {
    // A variable added, changed or removed is not image-only (S19).
    name: 'a changed secret',
    show: () => storedGooglePlan('variable-change'),
    line: {
      address: 'google_secret_manager_secret_version.variable["API_KEY"]',
      action: 'replace',
    },
  },
  {
    name: 'a changed setting beside the image',
    show: () =>
      imageOnlyWith((template) => {
        template.containers[0].resources[0].limits.memory = '2Gi';
      }),
    line: { address: CLOUD_RUN, action: 'change' },
  },
  {
    name: 'drift',
    show: () => storedGooglePlan('drift-field'),
    line: { address: CLOUD_RUN, action: 'change' },
  },
];

/**
 * Auto-apply (S19): the auto-apply rule on
 * Google Cloud. A deploy of a Cloud Run Service that no Apply queued — a
 * code push, a console Save or an Agent's redeploy — applies on its own only
 * an image-only plan: one update of the Cloud Run service whose only changed
 * attribute is a container's image. Stop's copy range and Reload's label
 * never count. Anything else (a secret, a setting, drift) stops it before
 * any change: the Deployment ends `error` with "Google Cloud differs from
 * what Cloudgate made: review the plan", its whole plan becomes the
 * Environment's open plan with the Service's step carrying what it read,
 * and the two link to each other.
 *
 * Against the Google fake (`ctx.google`), whose stand-in `tofu` replays the
 * stored Google plans, a real shell whose `docker` is the fake above, and a
 * clone that writes a Dockerfile instead of reaching GitHub.
 */
describe('A push, Save or Agent redeploy applies to Google on its own only an image-only plan (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let ownerId: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  let githubId: string;
  const shell = fakeBinShell('gauto', { docker: FAKE_DOCKER });
  const { execMock } = shell;

  beforeAll(async () => {
    shell.setUp();
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    http = ctx.app.getHttpServer() as App;
    ctx.app.get(GoogleServiceDeploys).pollIntervalMs = 10;
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
    await ctx.db
      .insert(webServerSettings)
      .values({ host: 'cloudgate.example.com', https: true });
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
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId,
        name: 'production',
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: row.cloudAccountId,
          region: REGION,
        },
      });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;
    const github = await ctx.app
      .get(GithubService)
      .create(ownerCtx(), connection);
    githubId = github.githubId;

    ctx.google.replayPlanFor('network', 'network-create');
    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.replayOutputsFor('network', 'network-create');
    ctx.google.replayOutputsFor('web', 'web-create');
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

  /** Applies `planId` and waits for the web's Deployment it queued. */
  async function applied(planId: string): Promise<Deployment> {
    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });
    expect(res.status).toBe(200);
    const settled = await settledPlan(planId);
    const web = settled.results!.find((one) => one.configName === 'web')!;
    if (web.deploy?.status !== 'queued') {
      throw new Error(`not queued: ${JSON.stringify(web)}`);
    }
    return settledDeployment(web.deploy.deploymentId);
  }

  /** Plans and applies the config, and waits for the web's first Deployment. */
  async function appliedWeb(): Promise<string> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: WEB });
    expect(saved.status).toBe(201);
    const first = await applied((await openPlan()).planId);
    expect(first.status).toBe('done');
    return first.applicationId!;
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
  ): Promise<Plan> {
    expect([stopped.status, stopped.description]).toEqual(['error', DIFFERS]);
    const log = await logOf(stopped.deploymentId);
    // Before any change: the apply never ran.
    expect(log).not.toContain('Apply complete!');
    expect(log).toContain('Reading Google Cloud again before applying');
    expect(log).toContain(
      '⛔ [Cloud run] Google Cloud differs from what Cloudgate made, so nothing was applied: it would ',
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
      throw new Error('the stopped Service has no step with its Google lines');
    }
    expect(step.cloudRead.imageOnly).toBe(false);
    expect(step.cloudRead.raw).toContainEqual(expect.objectContaining(line));

    // The Deployment links to the plan, and the plan back.
    const [row] = await ctx.db
      .select({ reviewPlanId: deployment.reviewPlanId })
      .from(deployment)
      .where(eq(deployment.deploymentId, stopped.deploymentId));
    expect(row.reviewPlanId).toBe(open.planId);
    const shown = await environmentPlan();
    expect(shown.planId).toBe(open.planId);
    expect(shown.stoppedDeployment).toMatchObject({
      deploymentId: stopped.deploymentId,
      applicationId,
      configName: 'web',
      status: 'error',
    });
    return open;
  }

  it('applies an image-only push on its own, with build, plan and apply lines in the one Deployment log', async () => {
    const applicationId = await appliedWeb();
    await builtFromGithub(applicationId);
    ctx.google.replayPlanFor('web', 'image-only');

    const run = await push(applicationId, 'a'.repeat(40));

    expect([run.status, run.description]).toEqual(['done', expect.anything()]);
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
      at('Reading Google Cloud again before applying'),
      at('📋 [Cloud run] '),
      log.lastIndexOf('Apply complete!'),
      at('✅ [Cloud run] web runs the image of this Deployment'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(log).not.toContain(DIFFERS);
    // No plan was opened for it.
    const [open] = await ctx.db
      .select()
      .from(planTable)
      .where(eq(planTable.status, 'open'));
    expect(open).toBeUndefined();
    const [row] = await ctx.db
      .select({ reviewPlanId: deployment.reviewPlanId })
      .from(deployment)
      .where(eq(deployment.deploymentId, run.deploymentId));
    expect(row.reviewPlanId).toBeNull();
  });

  it("still applies on its own when the image moves beside Stop's copy range and Reload's label", async () => {
    const applicationId = await appliedWeb();
    await builtFromGithub(applicationId);
    ctx.google.replayShowFor(
      'web',
      imageOnlyWith((template) => {
        template.scaling[0].min_instance_count = 0;
        template.scaling[0].max_instance_count = 0;
        template.labels = {
          ...template.labels,
          [RELOAD_LABEL]: '1760000000',
        };
      }),
    );

    const run = await push(applicationId, 'd'.repeat(40));

    expect(run.status).toBe('done');
    expect(await logOf(run.deploymentId)).not.toContain(DIFFERS);
  });

  it.each(BEYOND_THE_IMAGE)(
    'stops a push that meets $name before any change, opens its plan and links the two',
    async ({ show, line }) => {
      const applicationId = await appliedWeb();
      await builtFromGithub(applicationId);
      ctx.google.replayShowFor('web', show());

      const stopped = await push(applicationId, 'b'.repeat(40));

      await expectStoppedForReview(stopped, applicationId, line);
    },
  );

  it('stops a console redeploy alike, whose Apply then applies exactly what the deploy met', async () => {
    const applicationId = await appliedWeb();
    ctx.google.replayPlanFor('web', 'variable-change');

    const queued = await ctx.app
      .get(DeploymentsService)
      .redeploy(ownerCtx(), applicationId);
    const open = await expectStoppedForReview(
      await settledDeployment(queued.deploymentId),
      applicationId,
      BEYOND_THE_IMAGE[0].line,
    );

    // Applying it approves the secret's change: its Deployment goes on.
    const run = await applied(open.planId);
    expect(run.status).toBe('done');
    expect(await logOf(run.deploymentId)).not.toContain(DIFFERS);
  });

  it('holds an Agent redeploy to the same rule', async () => {
    const applicationId = await appliedWeb();
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

    ctx.google.replayPlanFor('web', 'image-only');
    const imageOnly = await deployments.redeploy(operator, applicationId);
    expect((await settledDeployment(imageOnly.deploymentId)).status).toBe(
      'done',
    );

    const setting = BEYOND_THE_IMAGE[1];
    ctx.google.replayShowFor('web', setting.show());
    const queued = await deployments.redeploy(operator, applicationId);
    await expectStoppedForReview(
      await settledDeployment(queued.deploymentId),
      applicationId,
      setting.line,
    );
  });
});
