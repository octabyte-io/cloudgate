import { exec } from 'node:child_process';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { and, eq, ne } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { application, cloudAccount, deployment } from '../../src/db/schema';
import type { Deployment } from '../../src/db/schema';
import { staticUploadDirectory } from '../../src/deployment-engine/deployment-engine.paths';
import { SourceCloneService } from '../../src/git-providers/source-clone.service';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import {
  STATIC_SPREAD_CLOCK,
  STILL_SPREADING,
} from '../../src/project-config/applier/static-spread';
import type { SpreadClock } from '../../src/project-config/applier/static-spread';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { fakeDistributionId } from '../utils/fake-cloud-port';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(240_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

const DOCS = `version: 1
services:
  docs:
    kind: static
    source: { git: https://example.com/docs.git }
    build:
      publish: dist
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

/**
 * The wait's clock, moved by hand: a sleep moves it on at once, so a
 * CloudFront held `InProgress` reaches the 30-minute cap without waiting.
 */
class HandClock implements SpreadClock {
  at = Date.UTC(2026, 9, 17, 9, 0, 0);
  now(): number {
    return this.at;
  }
  sleep(ms: number): Promise<void> {
    this.at += ms;
    return Promise.resolve();
  }
}

/**
 * A push to a `static` Service in an AWS Environment queues one
 * Deployment that builds nothing. Its build slot checks the source out on
 * the platform host and copies `publish` aside; its Cloud run uploads it to
 * a folder of its own in the site's bucket (`ctx.objectStorage`), switches
 * the distribution's origin path to it and clears the cache (`ctx.cloud`),
 * and waits until CloudFront has spread both, at most 30 minutes (a hand
 * clock). Then every folder but the live one is removed.
 *
 * The checkout runs in a real shell, so the files uploaded are the ones
 * the clone wrote under `publish`, and the Deployment log is the real file.
 */
describe('Deploying a static site on AWS (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let ownerId: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  let githubId: string;
  const clock = new HandClock();
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-static-'));
  const savedRoot = process.env.CLOUDGATE_DIRECTORY;

  const execMock = withArgvExec({
    execAsync: jest.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) =>
        new Promise((resolve, reject) => {
          exec(
            command,
            { shell: '/bin/bash', env: { ...process.env, ...options?.env } },
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
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: STATIC_SPREAD_CLOCK, useValue: clock },
      ],
    });
    http = ctx.app.getHttpServer() as App;
    // A pushed commit's clone, without GitHub: a built site under `dist`,
    // beside what is not the site's.
    const clones = ctx.app.get<SourceCloneService>(SourceCloneService);
    jest
      .spyOn(clones, 'cloneProgram')
      .mockImplementation((_source, outputPath) => {
        const at = (file: string) => `'${nodePath.join(outputPath, file)}'`;
        return Promise.resolve({
          command: [
            `rm -rf '${outputPath}' && mkdir -p ${at('dist/assets')} ;`,
            `printf '<h1>Docs</h1>' > ${at('dist/index.html')} ;`,
            `printf 'console.log(1)' > ${at('dist/assets/app.js')} ;`,
            `printf 'SECRET=1' > ${at('dist/.env')} ;`,
            `printf '# docs' > ${at('README.md')} ;`,
            'echo "Cloned acme/docs at the pushed commit" ;',
          ].join('\n'),
          env: {},
        });
      });
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (savedRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = savedRoot;
    fs.rmSync(root, { recursive: true, force: true });
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
      .send({ name: 'Shop' });
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
    const github = await ctx.app.get(GithubService).create(
      {
        user: { id: ownerId },
        session: { activeOrganizationId: organizationId },
      },
      connection,
    );
    githubId = github.githubId;

    ctx.cloud.replayPlanFor('static', 'static-create');
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

  interface PlanBody {
    planId: string;
    status: string;
    steps: { cloudRead?: { status: string } }[];
  }

  const readPlan = () =>
    poll(async () => {
      const res = await request(http)
        .get(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie);
      const found = (res.body as { plan: PlanBody | null }).plan;
      return found &&
        !found.steps.some((s) => s.cloudRead?.status === 'reading')
        ? found
        : undefined;
    }, 'the plan to be read');

  /**
   * Plans and applies the site, waits for its Cloud run, and has it build
   * from acme/docs's main, as a push-deployed Service does.
   */
  async function madeSite({ fromGithub = true } = {}) {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: DOCS });
    expect(saved.status).toBe(201);
    const read = await readPlan();
    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(applied.status).toBe(200);
    const made = (
      applied.body as { results: { deploy: { deploymentId: string } }[] }
    ).results[0].deploy.deploymentId;
    expect((await settledDeployment(made)).status).toBe('done');
    const [site] = await ctx.db.select().from(application);
    if (fromGithub) {
      await ctx.db
        .update(application)
        .set({
          sourceType: 'github',
          githubId,
          owner: 'acme',
          repository: 'docs',
          branch: 'main',
        })
        .where(eq(application.applicationId, site.applicationId));
    }
    ctx.cloud.calls.length = 0;
    ctx.objectStorage.calls.length = 0;
    return site;
  }

  /** A real-shaped, signed `push` of acme/docs's main, and its Deployment once ended. */
  async function push(
    applicationId: string,
    after: string,
    seen: readonly string[] = [],
  ): Promise<Deployment> {
    const payload = {
      ref: 'refs/heads/main',
      before: '1111111111111111111111111111111111111111',
      after,
      deleted: false,
      installation: { id: 99887766 },
      repository: {
        name: 'docs',
        full_name: 'acme/docs',
        owner: { name: 'acme', login: 'acme' },
      },
      pusher: { name: 'grace' },
      head_commit: { id: after, message: 'docs: a new page' },
      commits: [
        {
          id: after,
          message: 'docs: a new page',
          added: ['guide.md'],
          modified: [],
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
      const rows = await ctx.db
        .select()
        .from(deployment)
        .where(
          and(
            eq(deployment.applicationId, applicationId),
            ne(deployment.title, 'Create docs on S3 + CloudFront'),
          ),
        );
      return rows.find((row) => !seen.includes(row.deploymentId));
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

  it('builds nothing, uploads publish into its own folder, switches, clears and ends done once CloudFront has spread both', async () => {
    const site = await madeSite();
    // The run that made the site saved its distribution's id.
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.applicationId, site.applicationId));
    const [made] = await ctx.db.select().from(application);
    expect(made.cloudDistributionId).toBe(
      fakeDistributionId(state.infrastructureStateId),
    );
    const bucket = site.cloudBucketName!;
    // CloudFront takes 4 minutes to spread the switch, 1 to clear.
    ctx.cloud.holdDistribution(16);
    ctx.cloud.holdInvalidation(4);

    const run = await push(site.applicationId, 'a'.repeat(40));
    expect(run).toMatchObject({
      status: 'done',
      cloudRun: expect.objectContaining({
        kind: 'static-deploy',
        stateKey: `application:${site.applicationId}`,
      }) as unknown,
    });

    // The files of `publish`, and only them, in the Deployment's own folder.
    const folder = `deployments/${run.deploymentId}/`;
    expect(ctx.objectStorage.entriesOf(bucket).sort()).toEqual([
      `object:${folder}assets/app.js`,
      `object:${folder}index.html`,
    ]);
    const [upload] = ctx.objectStorage.calls.filter(
      (call) => call.call === 'uploadFolder',
    );
    expect(upload.target).toMatchObject({
      endpoint: null,
      region: REGION,
      bucket,
      pathStyle: false,
      // The deploy role's session, on the platform host.
      credential: expect.objectContaining({
        sessionToken: expect.any(String) as unknown,
      }) as unknown,
    });
    // Its copy of `publish` is gone once uploaded.
    expect(
      fs.existsSync(staticUploadDirectory(site.appName, run.deploymentId)),
    ).toBe(false);

    // The switch and the one `/*` clear, through the cloud port, no tofu.
    expect(ctx.cloud.originPathOf(made.cloudDistributionId!)).toBe(
      `/deployments/${run.deploymentId}`,
    );
    expect(
      ctx.cloud.calls.filter((call) =>
        ['cloudFrontSwitchOrigin', 'cloudFrontCreateInvalidation'].includes(
          call.method,
        ),
      ),
    ).toEqual([
      {
        method: 'cloudFrontSwitchOrigin',
        distributionId: made.cloudDistributionId,
        originId: 'site-bucket',
        originPath: `/deployments/${run.deploymentId}`,
      },
      {
        method: 'cloudFrontCreateInvalidation',
        distributionId: made.cloudDistributionId,
        paths: ['/*'],
        callerReference: run.deploymentId,
      },
    ]);
    expect(
      ctx.cloud.calls.filter((call) =>
        ['plan', 'apply', 'destroy'].includes(call.method),
      ),
    ).toEqual([]);
    const [after] = await ctx.db.select().from(application);
    expect(after).toMatchObject({
      cloudLiveFolder: run.deploymentId,
      applicationStatus: 'done',
    });

    // Each step in the log, in order, with its time.
    const log = await logOf(run.deploymentId);
    const at = (text: string) => {
      const index = log.indexOf(text);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      at(
        "🔧 [Build] Checking out on Cloudgate's own host; the site is served from S3 + CloudFront in Cloud account Production AWS (eu-central-1).",
      ),
      at('Cloned acme/docs at the pushed commit'),
      at("📁 [Files] Taking the publish folder 'dist' from the checkout"),
      at("📦 [Push] No image: the files go to the site's own S3 bucket"),
      at('☁️ [Cloud run] Checked out.'),
      at('☁️ [Cloud run] Deploying docs to S3 + CloudFront'),
      at(`📤 [Upload] Uploading the files to s3://${bucket}/${folder}`),
      at('✅ [Upload] Uploaded 2 files'),
      at('🔀 [Switch] Switched to this version, spreading…'),
      at("🧽 [Clear] Clearing CloudFront's cache of /*"),
      at('✅ [Clear] Cache cleared after 1m00s'),
      at('✅ [Spread] Deployed after 4m00s'),
      at('✅ [Cloud run] docs serves the files of this Deployment'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(log).not.toContain('Still spreading');
    // Nothing was built and no image went anywhere.
    expect(log).not.toContain('docker build');
    expect(log).not.toContain('ECR');
  });

  it('ends done with the "still spreading" warning when CloudFront is still InProgress at 30 minutes, keeping the previous folder', async () => {
    const site = await madeSite();
    const bucket = site.cloudBucketName!;
    const first = await push(site.applicationId, 'a'.repeat(40));
    expect(first.status).toBe('done');

    ctx.cloud.holdDistribution();
    const second = await push(site.applicationId, 'b'.repeat(40), [
      first.deploymentId,
    ]);
    expect(second.status).toBe('done');
    const log = await logOf(second.deploymentId);
    expect(log).toContain('✅ [Clear] Cache cleared after 0s');
    expect(log).not.toContain('[Spread] Deployed after');
    expect(log).toContain(STILL_SPREADING);
    expect(log).toContain(
      `📁 [Files] The previous version's folder ${first.deploymentId} is kept while CloudFront spreads`,
    );
    // Visitors CloudFront has not reached yet still get the previous files.
    expect(ctx.objectStorage.foldersOf(bucket)).toEqual(
      [first.deploymentId, second.deploymentId].sort(),
    );
    const [after] = await ctx.db.select().from(application);
    expect(after.cloudLiveFolder).toBe(second.deploymentId);
  });

  it("keeps only the live folder with rollbacks off, removing the previous one and a failed Deployment's stray folder", async () => {
    const site = await madeSite();
    const bucket = site.cloudBucketName!;
    const first = await push(site.applicationId, 'a'.repeat(40));
    expect(first.status).toBe('done');
    // A Deployment that failed partway through its upload left this.
    ctx.objectStorage.put(
      bucket,
      'object',
      'deployments/half-uploaded/index.html',
    );
    expect(ctx.objectStorage.foldersOf(bucket)).toEqual(
      [first.deploymentId, 'half-uploaded'].sort(),
    );

    const second = await push(site.applicationId, 'b'.repeat(40), [
      first.deploymentId,
    ]);
    expect(second.status).toBe('done');
    expect(ctx.objectStorage.foldersOf(bucket)).toEqual([second.deploymentId]);
    expect(await logOf(second.deploymentId)).toContain(
      '🧹 [Files] Removed 2 older folders from the bucket',
    );
  });

  // Spec story 38: a visitor never sees a half-uploaded site. Each step that
  // can fail is made to, through the ports a deploy reaches AWS by.
  describe('when a step fails', () => {
    const switches = () =>
      ctx.cloud.calls.filter(
        (call) => call.method === 'cloudFrontSwitchOrigin',
      );

    it('ends a Deployment whose upload fails failed, never switches to its half-uploaded folder, and the next Deployment removes it', async () => {
      const site = await madeSite();
      const bucket = site.cloudBucketName!;
      const first = await push(site.applicationId, 'a'.repeat(40));
      expect(first.status).toBe('done');
      ctx.cloud.calls.length = 0;

      ctx.objectStorage.failUploadAfter(1, 'Connection reset by peer');
      const failed = await push(site.applicationId, 'b'.repeat(40), [
        first.deploymentId,
      ]);

      expect(failed.status).toBe('error');
      expect(failed.description).toContain(
        `The files could not be uploaded to ${bucket}: Connection reset by peer. The site still serves its previous version`,
      );
      expect(switches()).toEqual([]);
      const [after] = await ctx.db.select().from(application);
      expect(after.cloudLiveFolder).toBe(first.deploymentId);
      expect(ctx.cloud.originPathOf(after.cloudDistributionId!)).toBe(
        `/deployments/${first.deploymentId}`,
      );
      // The half it put is there until a Deployment cleans up.
      expect(ctx.objectStorage.foldersOf(bucket)).toEqual(
        [first.deploymentId, failed.deploymentId].sort(),
      );

      const third = await push(site.applicationId, 'c'.repeat(40), [
        first.deploymentId,
        failed.deploymentId,
      ]);
      expect(third.status).toBe('done');
      expect(ctx.objectStorage.foldersOf(bucket)).toEqual([third.deploymentId]);
    });

    it('ends a Deployment whose switch CloudFront refuses failed, the site still on its previous folder, and the next Deployment removes the folder it uploaded', async () => {
      const site = await madeSite();
      const bucket = site.cloudBucketName!;
      const first = await push(site.applicationId, 'a'.repeat(40));
      expect(first.status).toBe('done');

      ctx.cloud.refuseOriginSwitch(
        'PreconditionFailed',
        'The If-Match version is missing or not valid for the resource.',
      );
      const failed = await push(site.applicationId, 'b'.repeat(40), [
        first.deploymentId,
      ]);

      expect(failed.status).toBe('error');
      expect(failed.description).toContain(
        'CloudFront refused the switch to this version: PreconditionFailed: The If-Match version is missing or not valid for the resource.. The site still serves its previous version',
      );
      const [after] = await ctx.db.select().from(application);
      expect(after.cloudLiveFolder).toBe(first.deploymentId);
      expect(ctx.cloud.originPathOf(after.cloudDistributionId!)).toBe(
        `/deployments/${first.deploymentId}`,
      );
      expect(
        ctx.cloud.calls.filter(
          (call) => call.method === 'cloudFrontCreateInvalidation',
        ),
      ).toHaveLength(1);

      const third = await push(site.applicationId, 'c'.repeat(40), [
        first.deploymentId,
        failed.deploymentId,
      ]);
      expect(third.status).toBe('done');
      expect(ctx.objectStorage.foldersOf(bucket)).toEqual([third.deploymentId]);
    });

    it('reports a cache clear CloudFront refuses, the switch made and said so', async () => {
      const site = await madeSite();
      ctx.cloud.refuseInvalidation(
        'TooManyInvalidationsInProgress',
        'Your request contains too many invalidations.',
      );

      const run = await push(site.applicationId, 'a'.repeat(40));

      expect(run.status).toBe('error');
      expect(run.description).toContain(
        'CloudFront refused to clear its cache: TooManyInvalidationsInProgress: Your request contains too many invalidations.. The switch was made; some visitors may see the previous version until their copies expire',
      );
      const [after] = await ctx.db.select().from(application);
      expect(after.cloudLiveFolder).toBe(run.deploymentId);
      expect(ctx.cloud.originPathOf(after.cloudDistributionId!)).toBe(
        `/deployments/${run.deploymentId}`,
      );
    });
  });

  it('shows no Drift for the origin path its deploys switch on the next plan', async () => {
    // Its source as the config says, deployed from the console.
    const site = await madeSite({ fromGithub: false });
    const deployed = await request(http)
      .post(`/applications/${site.applicationId}/deployments`)
      .set('Cookie', cookie)
      .send({});
    expect(deployed.status).toBe(201);
    const run = await settledDeployment(
      (deployed.body as { deploymentId: string }).deploymentId,
    );
    expect(run.status).toBe('done');
    const [after] = await ctx.db.select().from(application);
    expect(ctx.cloud.originPathOf(after.cloudDistributionId!)).toBe(
      `/deployments/${run.deploymentId}`,
    );

    ctx.cloud.tofuInputs.length = 0;
    ctx.cloud.replayShowFor('static', {
      format_version: '1.2',
      terraform_version: '1.13.1',
      resource_changes: [],
    });
    const checked = await request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(checked.status).toBe(201);
    expect((await readPlan()).status).toBe('unchanged');
    // The definition the check read with writes the origin path from the
    // live folder its deploy switched to, and ignores no part of the origin,
    // so a hand change to its bucket or OAC would be Drift.
    const [input] = ctx.cloud.tofuInputs;
    expect(input.definition).toContain(
      `"origin_path": "/deployments/${run.deploymentId}"`,
    );
    expect(input.definition).not.toContain('ignore_changes');
  });
});
