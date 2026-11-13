// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();

import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import { quote } from 'shell-quote';
import request from 'supertest';
import { App } from 'supertest/types';

import { readDropArchive } from '../../src/applications/drop-archive';
import { subscription } from '../../src/cloud/billing/billing.schema';
import { CLOUD_BUILDER_IMAGE } from '../../src/builders/cloud-builder-image';
import {
  buildPieceNames,
  registryPasswordSecretId,
} from '../../src/cloud-accounts/gcp/cloud-build-names';
import { serviceName } from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import {
  application,
  cloudAccount,
  deployment,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { CLOUD_RUN_TIMING } from '../../src/deployment-queue/cloud-runs-concurrency.provider';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { BitbucketService } from '../../src/git-providers/strategies/bitbucket/bitbucket.service';
import { GiteaService } from '../../src/git-providers/strategies/gitea/gitea.service';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { GitlabService } from '../../src/git-providers/strategies/gitlab/gitlab.service';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { MailService } from '../../src/mail/mail.service';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { GoogleCloudBuilds } from '../../src/project-config/applier/google-cloud-builds.service';
import { GoogleServiceDeploys } from '../../src/project-config/applier/google-service-deploys.service';
import { ADDRESS_RESOLVER } from '../../src/outbound/outbound-address';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const customer = {
  name: 'Grace',
  lastName: 'Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
  organizationName: 'Shop',
};

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';

/** A minute of the Cloud run time limit, made short. */
const MINUTE_MS = 100;

const GIT_WEB = `version: 1
services:
  web:
    kind: web
    size: small
    source: { git: https://example.com/shop.git }
`;

const IMAGE_WEB = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
`;

/** A `docker` without a daemon: it records each call's words. */
const FAKE_DOCKER = `#!/bin/bash
echo "$*" >> "$FAKE_DOCKER_RECORD"
case "$1" in
  login) cat > /dev/null; echo "Login Succeeded" ;;
  pull) echo "Status: Downloaded newer image for \${@: -1}" ;;
  image) [ "$2" = inspect ] && echo "amd64 null" ;;
esac
exit 0
`;

/**
 * A \`git\` whose clone writes a small checkout: the repository's files, a
 * line naming where it came from (credentials cut out), and a \`.git\`
 * holding the clone URL as git keeps it, token and all. It reads past git's
 * own \`-c name=value\` options, which the clone line passes ahead of \`clone\`.
 */
const FAKE_GIT = `#!/bin/bash
while [ "$1" = -c ]; do shift 2; done
if [ "$1" = clone ]; then
  url="\${@: -2:1}"
  dir="\${@: -1}"
  mkdir -p "$dir/.git" "$dir/src"
  printf '[remote "origin"]\\n  url = %s\\n' "$url" > "$dir/.git/config"
  printf '%s\\n' "$url" | sed -E 's#//[^@/]*@#//#' > "$dir/cloned-from.txt"
  printf '{"name":"shop"}\\n' > "$dir/package.json"
  printf 'console.log(1)\\n' > "$dir/src/index.js"
  echo "Cloning into '$dir'..."
  exit 0
fi
exit 0
`;

/**
 * On the Hosted instance (ADR-0047) a Google Cloud Service builds in
 * Cloud Build in its Cloud account's project, the way an AWS
 * one builds in CodeBuild. The platform host checks the source out for every
 * source type, the Cloud run zips the checkout without its `.git` and
 * uploads it to the Environment's source bucket, and Cloud Build
 * builds and pushes from the pinned builder image as the Cloud account's
 * build identity, logging to Cloud Logging only; starting, watching and
 * cancelling it are Google port calls. Its log lines are copied into the
 * Deployment log as they come, Cancel cancels it, and the time it waits
 * in Cloud Build's queue does not count against the Cloud run time limit.
 * A Self-hosted counterpart closes the file: the same deploy builds on the
 * platform host.
 *
 * Against the Google fake (`ctx.google`, its Cloud Build scripted per build,
 * its Cloud Storage keeping each uploaded file's bytes), and a real shell
 * whose `git` and `docker` are the fakes above, so the checkout, the copy
 * aside and the zip are real files.
 */
describe('Hosted cloud builds in Cloud Build (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let ownerId: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), 'cloudgate-cloudbuild-'),
  );
  const bin = nodePath.join(root, 'bin');
  const record = nodePath.join(root, 'docker-calls');
  const mail = new MailRecorder();
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
    fs.writeFileSync(nodePath.join(bin, 'git'), FAKE_GIT, { mode: 0o755 });
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        // Every clone here runs on the platform host, where its host is
        // resolved and checked; the made-up `*.example.com` providers
        // answer with a public documentation address instead of real DNS.
        {
          provide: ADDRESS_RESOLVER,
          // The Instance's own `SITE_URL` host gets an address of its own:
          // on Hosted the outbound guard refuses the box's own addresses.
          useValue: (host: string) =>
            Promise.resolve(
              host === 'cloudgate.test' ? ['198.51.100.10'] : ['203.0.113.7'],
            ),
        },
        { provide: MailService, useValue: mail },
        {
          provide: CLOUD_RUN_TIMING,
          useValue: {
            minuteMs: MINUTE_MS,
            killGraceMs: 2_000,
            shutdownGraceMs: 2_000,
          },
        },
      ],
    });
    http = ctx.app.getHttpServer() as App;
    ctx.app.get(CloudServiceDeploys).pollIntervalMs = 10;
    ctx.app.get(GoogleServiceDeploys).pollIntervalMs = 10;
    const builds = ctx.app.get(GoogleCloudBuilds);
    builds.pollIntervalMs = 10;
    builds.logSettle = { everyMs: 10, quietAfterMs: 50, capMs: 500 };
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
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    mail.clear();
    await ctx.resetDb();
    fs.rmSync(record, { force: true });
    execMock.execAsync.mockClear();
    await ctx.db
      .insert(webServerSettings)
      .values({ host: 'cloudgate.example.com', https: true });
    // A customer of the Hosted instance, its email confirmed.
    await openHostedSignUp(ctx.db);
    ({
      cookie,
      id: ownerId,
      organizationId,
    } = await signUpHostedCustomer(http, mail, customer));
    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;

    // Set up at role version 6, whose script made the build identity.
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
        policyVersion: 6,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    cloudAccountId = row.cloudAccountId;
    // A cloud Deploy target is a Cloud Environment on the Hosted plan.
    await ctx.db.insert(subscription).values({
      organizationId,
      plan: 'starter',
      status: 'active',
    });
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId,
        name: 'production',
        deployTarget: { kind: 'cloud', cloudAccountId, region: REGION },
      });
    expect([env.status, env.body]).toEqual([201, expect.anything()]);
    environmentId = (env.body as { environmentId: string }).environmentId;

    ctx.google.replayPlanFor('network', 'network-create');
    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.replayOutputsFor('network', 'network-create');
    ctx.google.replayOutputsFor('web', 'web-create');
  });

  const asOwner = () => ({
    user: { id: ownerId },
    session: { activeOrganizationId: organizationId },
  });

  /** The install-wide Cloud run time limit, written to its settings row. */
  async function givenTimeLimitOfFiveMinutes() {
    await ctx.db.update(webServerSettings).set({ cloudRunTimeLimitMinutes: 5 });
  }

  const givenSelfHostedInstance = () =>
    jest
      .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
      .mockReturnValue(false);

  /** This Environment's standing piece and build identity, by their names. */
  const pieces = () =>
    buildPieceNames({ projectId: PROJECT, cloudAccountId, environmentId });

  async function until<T>(
    read: () =>
      Promise<T | undefined | null | false> | T | undefined | null | false,
    what: string,
    attempts = 800,
  ): Promise<T> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const found = await read();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  const openPlan = () =>
    until(async () => {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.status, 'open'));
      return found &&
        !found.steps.some(
          (step) =>
            (step.action === 'create' || step.action === 'network-create') &&
            step.cloudRead?.status === 'reading',
        )
        ? found
        : undefined;
    }, 'the plan to read Google Cloud');

  const settledPlan = (planId: string) =>
    until(async () => {
      const [row] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, planId));
      return row.results !== null &&
        !row.results.some((result) => result.status === 'running')
        ? row
        : undefined;
    }, 'the Apply to end');

  const deploymentRow = async (deploymentId: string) => {
    const [row] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId));
    return row;
  };

  const settled = (deploymentId: string): Promise<Deployment> =>
    until(async () => {
      const row = await deploymentRow(deploymentId);
      return row && ['done', 'error', 'cancelled'].includes(row.status)
        ? row
        : undefined;
    }, 'the Deployment to end');

  /** Plans the config, applies it, and waits for the web's Deployment. */
  async function appliedWeb(text = GIT_WEB): Promise<{
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
    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    const applied = await settledPlan(read.planId);
    const web = applied.results!.find((one) => one.configName === 'web')!;
    if (web.deploy?.status !== 'queued') {
      throw new Error(`not queued: ${JSON.stringify(applied.results)}`);
    }
    const run = await settled(web.deploy.deploymentId);
    return { plan: read, applicationId: web.serviceId!, run };
  }

  /** A redeploy of the Service, its plan image-only. */
  async function redeployed(applicationId: string): Promise<string> {
    ctx.google.replayPlanFor('web', 'image-only');
    const queued = await ctx.app
      .get(DeploymentsService)
      .redeploy(asOwner(), applicationId);
    return queued.deploymentId;
  }

  const appNameOf = async (applicationId: string) => {
    const [found] = await ctx.db
      .select({ appName: application.appName })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    return found.appName;
  };

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

  const startsOf = () =>
    ctx.google.calls.flatMap((call) =>
      call.method === 'startCloudBuild' ? [call] : [],
    );

  /** What reached the source bucket, in order. */
  const sourceCalls = () =>
    ctx.google.calls.flatMap((call) =>
      (call.method === 'uploadObject' || call.method === 'deleteObject') &&
      call.bucket === pieces().sourceBucketName
        ? [[call.method, call.name]]
        : [],
    );

  /** The zip the Deployment uploaded, as its entries' paths and contents. */
  function uploadedZip(deploymentId: string) {
    const key = `${pieces().sourceBucketName}/builds/${deploymentId}/source.zip`;
    const body = ctx.google.bodies.get(key);
    if (!body) throw new Error(`No zip was uploaded to ${key}`);
    const entries = readDropArchive(body);
    return {
      body,
      paths: entries.map((entry) => entry.path).sort(),
      text: (path: string) =>
        entries.find((entry) => entry.path === path)?.content?.toString('utf8'),
    };
  }

  it('builds in Cloud Build from an uploaded zip of the checkout, as the build identity, never on the platform host, in one Deployment', async () => {
    ctx.google.scriptCloudBuild({
      lines: ['Step 1/3 : FROM node:22', 'Successfully built 0f1e'],
      image: 'amd64 {"Test":["CMD","true"],"Interval":30000000000}',
    });
    const { applicationId, run } = await appliedWeb();
    expect(run).toMatchObject({ status: 'done', applicationId });
    const { sourceBucketName, buildServiceAccountEmail } = pieces();
    const object = `builds/${run.deploymentId}/source.zip`;

    // One build, in the Service's region, from this Deployment's zip, as
    // the build identity, its log in Cloud Logging only.
    expect(startsOf()).toEqual([
      {
        method: 'startCloudBuild',
        impersonated: true,
        projectId: PROJECT,
        region: REGION,
        build: {
          source: { storageSource: { bucket: sourceBucketName, object } },
          steps: [
            {
              name: CLOUD_BUILDER_IMAGE,
              entrypoint: 'bash',
              args: ['cloudgate/build.sh'],
            },
          ],
          serviceAccount: `projects/${PROJECT}/serviceAccounts/${buildServiceAccountEmail}`,
          options: { logging: 'CLOUD_LOGGING_ONLY' },
          tags: ['cloudgate', `cloudgate-deployment-${run.deploymentId}`],
        },
      },
    ]);
    const [build] = ctx.google.builds;
    expect(
      ctx.google.calls.some(
        (call) =>
          call.method === 'cloudBuild' && call.buildId === build.buildId,
      ),
    ).toBe(true);

    // The zip: the checkout under code/, the build program, never a .git.
    const zip = uploadedZip(run.deploymentId);
    expect(zip.paths).toEqual(
      expect.arrayContaining([
        'code/cloned-from.txt',
        'code/package.json',
        'code/src/index.js',
        'cloudgate/build.sh',
      ]),
    );
    expect(zip.paths.some((path) => path.split('/').includes('.git'))).toBe(
      false,
    );
    const remote = `${REGION}-docker.pkg.dev/${PROJECT}/${serviceName(applicationId)}/service:${run.deploymentId}`;
    const script = zip.text('cloudgate/build.sh') ?? '';
    expect(script).toContain(`docker push ${quote([remote])}`);
    expect(script).toContain('oauth2accesstoken');
    expect(script).toContain('$BUILDER_OUTPUT/output');
    // Cloud Run's CPU is checked before anything is pushed.
    expect(script.indexOf('amd64) ;;')).toBeLessThan(
      script.indexOf('docker push'),
    );

    // Uploaded, then removed from the bucket and from the platform host.
    expect(sourceCalls()).toEqual([
      ['uploadObject', object],
      ['deleteObject', object],
    ]);
    expect(ctx.google.objectsOf(sourceBucketName)).toEqual([]);
    const appName = await appNameOf(applicationId);
    expect(
      fs.existsSync(
        nodePath.join(
          root,
          'applications',
          appName,
          'cloud-builds',
          run.deploymentId,
        ),
      ),
    ).toBe(false);

    // Nothing was built, pulled or pushed on the platform host.
    expect(dockerCalls()).toBe('');
    expect(programs().join('\n')).not.toMatch(
      /nixpacks build|railpack prepare|pack build|docker build/,
    );

    // The image's facts, as its step wrote them, on the row.
    const { cloudRun } = await deploymentRow(run.deploymentId);
    expect(cloudRun?.architecture).toBe('amd64');
    expect(cloudRun?.healthCheck?.test).toEqual(['CMD', 'true']);

    const log = await logOf(run.deploymentId);
    const at = (text: string) => {
      const index = log.indexOf(text);
      expect([text, index >= 0]).toEqual([text, true]);
      return index;
    };
    const order = [
      at(
        `🔧 [Build] Checking out on Cloudgate's own host; the image is built in Cloud Build and the service runs in Cloud account Production Google (${REGION}).`,
      ),
      at('📁 [Source] Taking the checkout for Cloud Build'),
      at('📦 [Build] The image is built in Cloud Build'),
      at('☁️ [Cloud run] Checked out.'),
      at("📦 [Push] Making the Service's Artifact Registry repository first"),
      at(
        `📤 [Build] Uploading the source to gs://${sourceBucketName}/${object}`,
      ),
      at(`🔨 [Build] Cloud Build build ${build.buildId} started`),
      at('Step 1/3 : FROM node:22'),
      at('Successfully built 0f1e'),
      at('✅ [Build] Cloud Build built the image'),
      at('🧹 [Build] Removed the source zip'),
      at('Reading Google Cloud again before applying'),
      at('✅ [Cloud run] web runs the image of this Deployment'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(log).not.toContain('Building on Cloudgate');
  });

  it('uploads a zip of the checkout for every source type, with no git token in it', async () => {
    const { applicationId } = await appliedWeb();
    const as = asOwner();
    jest
      .spyOn(ctx.app.get(GithubService), 'getGithubToken')
      .mockResolvedValue('ghs_github_secret');
    const github = await ctx.app.get(GithubService).create(as, {
      name: 'Team GitHub',
      appName: 'cloudgate-app',
      appId: 12345,
      clientId: 'Iv1.abc123',
      clientSecret: 'github-client-secret',
      installationId: '99887766',
      privateKey:
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----',
      webhookSecret: 'wh-secret',
    });
    const gitlab = await ctx.app.get(GitlabService).create(as, {
      name: 'Team GitLab',
      gitlabUrl: 'https://gitlab.example.com',
      applicationId: 'app',
      secret: 'secret',
      accessToken: 'glpat_gitlab_secret',
      refreshToken: 'glrt',
      groupName: 'acme',
      expiresAt: 2_000_000_000,
    });
    const gitea = await ctx.app.get(GiteaService).create(as, {
      name: 'Team Gitea',
      giteaUrl: 'https://gitea.example.com',
      accessToken: 'gta_gitea_secret',
      expiresAt: 2_000_000_000,
    });
    const bitbucket = await ctx.app.get(BitbucketService).create(as, {
      name: 'Team Bitbucket',
      bitbucketEmail: 'grace@example.com',
      apiToken: 'bb_bitbucket_secret',
      bitbucketWorkspaceName: 'acme',
    });
    // An upload's files, as `POST /applications/:id/drop` leaves them.
    const appName = await appNameOf(applicationId);
    const writeDrop = () => {
      const code = nodePath.join(root, 'applications', appName, 'code');
      fs.rmSync(code, { recursive: true, force: true });
      fs.mkdirSync(nodePath.join(code, 'src'), { recursive: true });
      fs.writeFileSync(nodePath.join(code, 'cloned-from.txt'), 'an upload\n');
      fs.writeFileSync(nodePath.join(code, 'src/index.js'), 'console.log(2)\n');
    };

    const sources = [
      {
        type: 'git',
        set: {
          sourceType: 'git',
          customGitUrl: 'https://example.com/shop.git',
          customGitBranch: 'main',
        },
        from: 'https://example.com/shop.git',
      },
      {
        type: 'github',
        set: {
          sourceType: 'github',
          githubId: github.githubId,
          owner: 'acme',
          repository: 'shop',
          branch: 'main',
        },
        from: 'https://github.com/acme/shop.git',
      },
      {
        type: 'gitlab',
        set: {
          sourceType: 'gitlab',
          gitlabId: gitlab.gitlabId,
          gitlabOwner: 'acme',
          gitlabRepository: 'shop',
          gitlabPathNamespace: 'acme/shop',
          gitlabBranch: 'main',
        },
        from: 'gitlab.example.com/acme/shop',
      },
      {
        type: 'gitea',
        set: {
          sourceType: 'gitea',
          giteaId: gitea.giteaId,
          giteaOwner: 'acme',
          giteaRepository: 'shop',
          giteaBranch: 'main',
        },
        from: 'gitea.example.com/acme/shop',
      },
      {
        type: 'bitbucket',
        set: {
          sourceType: 'bitbucket',
          bitbucketId: bitbucket.bitbucketId,
          bitbucketOwner: 'acme',
          bitbucketRepository: 'shop',
          bitbucketBranch: 'main',
        },
        from: 'bitbucket.org/acme/shop',
      },
      {
        type: 'drop',
        set: { sourceType: 'drop', dropBuildPath: '/', dropUploaded: true },
        from: 'an upload',
      },
    ] as const;

    for (const source of sources) {
      await ctx.db
        .update(application)
        .set(source.set)
        .where(eq(application.applicationId, applicationId));
      if (source.type === 'drop') writeDrop();
      const id = await redeployed(applicationId);
      const run = await settled(id);
      expect([source.type, run.status, run.description]).toEqual([
        source.type,
        'done',
        expect.anything(),
      ]);
      const zip = uploadedZip(id);
      expect([source.type, zip.text('code/cloned-from.txt')]).toEqual([
        source.type,
        expect.stringContaining(source.from),
      ]);
      expect(zip.paths.some((path) => path.split('/').includes('.git'))).toBe(
        false,
      );
      const bytes = zip.body.toString('latin1');
      for (const secret of [
        'ghs_github_secret',
        'glpat_gitlab_secret',
        'gta_gitea_secret',
        'bb_bitbucket_secret',
      ]) {
        expect([source.type, bytes.includes(secret)]).toEqual([
          source.type,
          false,
        ]);
      }
    }
    // Each built in Cloud Build, none on the platform host.
    expect(startsOf()).toHaveLength(1 + sources.length);
    expect(dockerCalls()).toBe('');
  });

  it("copies the build's log lines into the Deployment log while it runs, and the lines Cloud Logging shows late", async () => {
    const { applicationId } = await appliedWeb();
    ctx.google.scriptCloudBuild({
      lines: ['#1 [internal] load build definition', '#2 npm ci', '#3 done'],
      lateLines: { lines: ['#4 pushed, the last line'], reads: 2 },
      held: true,
    });
    const id = await redeployed(applicationId);
    const build = await until(
      () =>
        ctx.google.builds.find((one) =>
          one.request.build.tags.includes(`cloudgate-deployment-${id}`),
        ),
      'the build to start',
    );
    // Every line is in the log while the build still runs.
    await until(
      async () => (await logOf(id)).includes('#3 done'),
      'the build lines in the log',
    );
    expect(build.ended).toBeNull();
    expect((await deploymentRow(id)).status).toBe('running');
    const live = await logOf(id);
    expect(live.indexOf('#1 [internal] load build definition')).toBeLessThan(
      live.indexOf('#2 npm ci'),
    );
    expect(live).not.toContain('✅ [Build] Cloud Build built the image');

    ctx.google.endCloudBuild(build.buildId);
    expect((await settled(id)).status).toBe('done');
    const log = await logOf(id);
    // Each line once, however often the log was read; the late one before
    // the build is called done.
    expect(log.split('#2 npm ci')).toHaveLength(2);
    expect(log.indexOf('#4 pushed, the last line')).toBeGreaterThan(
      log.indexOf('#3 done'),
    );
    expect(log.indexOf('#4 pushed, the last line')).toBeLessThan(
      log.indexOf('✅ [Build] Cloud Build built the image'),
    );
    // Read from Cloud Logging, the build's own entries.
    expect(
      ctx.google.calls.some(
        (call) =>
          call.method === 'cloudBuildLogEntries' &&
          call.buildId === build.buildId &&
          call.projectId === PROJECT,
      ),
    ).toBe(true);
  });

  it('cancels the Cloud Build build when the deploy is cancelled, and removes its zip', async () => {
    const { applicationId } = await appliedWeb();
    ctx.google.scriptCloudBuild({ lines: ['#1 building'], held: true });
    const id = await redeployed(applicationId);
    const build = await until(
      () =>
        ctx.google.builds.find((one) =>
          one.request.build.tags.includes(`cloudgate-deployment-${id}`),
        ),
      'the build to start',
    );
    await until(
      async () => (await logOf(id)).includes('#1 building'),
      'a line',
    );

    const cancelled = await request(http)
      .post(`/deployments/${id}/cancel`)
      .set('Cookie', cookie);
    expect(cancelled.status).toBe(200);
    const row = await settled(id);
    expect(row.status).toBe('cancelled');
    // The run asks Cloud Build to cancel once it sees the interrupt.
    await until(() => build.cancelAsked, 'the cancel to reach Cloud Build');

    expect(ctx.google.calls).toContainEqual({
      method: 'cancelCloudBuild',
      impersonated: true,
      projectId: PROJECT,
      region: REGION,
      buildId: build.buildId,
    });
    const log = await until(async () => {
      const text = await logOf(id);
      return text.includes('🧹 [Build] Removed the source zip') && text;
    }, 'the zip to be removed');
    expect(log).toContain('⏹️ [Build] Stopping the Cloud Build build');
    expect(ctx.google.objectsOf(pieces().sourceBucketName)).toEqual([]);
    // Nothing was applied after the build was cancelled.
    const applies = () =>
      ctx.google.calls.filter((call) => call.method === 'apply').length;
    const before = applies();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(applies()).toBe(before);
  });

  it('does not count time queued in Cloud Build against the time limit: a build queued past it, then quick, succeeds', async () => {
    const { applicationId } = await appliedWeb();
    await givenTimeLimitOfFiveMinutes();
    // Five minutes are 500 ms here; the build waits three times that.
    ctx.google.scriptCloudBuild({
      queuedMs: 5 * MINUTE_MS * 3,
      lines: ['#1 quick'],
    });
    const id = await redeployed(applicationId);
    const run = await settled(id);
    expect([run.status, run.description]).toEqual(['done', expect.anything()]);
    const log = await logOf(id);
    expect(log).toContain(
      '⏳ [Build] Queued in Cloud Build, waiting for capacity in the Cloud account; this wait does not count against the Cloud run time limit',
    );
    expect(log).not.toContain('time limit of 5 minutes');
  });

  it('fails the deploy with Cloud Build’s words when the build fails, and still removes the zip', async () => {
    const { applicationId } = await appliedWeb();
    ctx.google.scriptCloudBuild({
      lines: ['npm ERR! missing script: build'],
      status: 'FAILURE',
      reason:
        'Build step 0 "ghcr.io/octabyte-io/cloudgate-builder" failed: step exited with non-zero status: 1',
    });
    const id = await redeployed(applicationId);
    const run = await settled(id);
    expect(run.status).toBe('error');
    const log = await logOf(id);
    expect(log).toContain('npm ERR! missing script: build');
    expect(log).toContain(
      'The Cloud Build build failed: FAILURE: Build step 0 "ghcr.io/octabyte-io/cloudgate-builder" failed: step exited with non-zero status: 1',
    );
    expect(log).toContain('🧹 [Build] Removed the source zip');
    expect(ctx.google.objectsOf(pieces().sourceBucketName)).toEqual([]);
  });

  it('refuses a cloud deploy in a Cloud account set up before the build identity, before anything is checked out', async () => {
    const { applicationId } = await appliedWeb();
    await ctx.db
      .update(cloudAccount)
      .set({ policyVersion: 5 })
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    execMock.execAsync.mockClear();
    const starts = startsOf().length;

    const id = await redeployed(applicationId);
    const run = await settled(id);
    expect(run.status).toBe('error');
    expect(await logOf(id)).toContain(
      "Cannot deploy: Cloud account Production Google was set up at permissions version 5, and a cloud build on this instance needs version 6, whose setup makes the build identity the build runs as. Re-run the Cloud account's setup, then deploy again.",
    );
    expect(programs().join('\n')).not.toContain('Cloning repo');
    expect(startsOf()).toHaveLength(starts);
  });

  describe('a ready-made image', () => {
    const PASSWORD = 'registry-pa$$word-do-not-leak';

    /** The Service's image made private: its registry and credentials. */
    async function givenPrivateRegistry(applicationId: string) {
      await ctx.db
        .update(application)
        .set({
          dockerImage: 'registry.example.com/acme/shop:1.4',
          registryUrl: 'registry.example.com',
          username: 'deployer',
          password: PASSWORD,
        })
        .where(eq(application.applicationId, applicationId));
    }

    const secretOf = (deploymentId: string) =>
      registryPasswordSecretId({ cloudAccountId, deploymentId });

    it('is copied by a build in Cloud Build, as the build identity, and nothing is pulled on the platform host', async () => {
      ctx.google.scriptCloudBuild({
        lines: ['latest: Pulling from library/nginx'],
      });
      const { applicationId, run } = await appliedWeb(IMAGE_WEB);
      expect(run.status).toBe('done');

      const { sourceBucketName, buildServiceAccountEmail } = pieces();
      const object = `builds/${run.deploymentId}/source.zip`;
      expect(startsOf()).toEqual([
        {
          method: 'startCloudBuild',
          impersonated: true,
          projectId: PROJECT,
          region: REGION,
          build: {
            source: { storageSource: { bucket: sourceBucketName, object } },
            steps: [
              {
                name: CLOUD_BUILDER_IMAGE,
                entrypoint: 'bash',
                args: ['cloudgate/build.sh'],
              },
            ],
            serviceAccount: `projects/${PROJECT}/serviceAccounts/${buildServiceAccountEmail}`,
            options: { logging: 'CLOUD_LOGGING_ONLY' },
            tags: ['cloudgate', `cloudgate-deployment-${run.deploymentId}`],
          },
        },
      ]);
      const zip = uploadedZip(run.deploymentId);
      expect(zip.paths).toEqual(['cloudgate/build.sh']);
      const remote = `${REGION}-docker.pkg.dev/${PROJECT}/${serviceName(applicationId)}/service:${run.deploymentId}`;
      const script = zip.text('cloudgate/build.sh') ?? '';
      // Pulled for Cloud Run's CPU, checked, then pushed.
      expect(script).toContain('docker pull --platform linux/amd64 nginx');
      expect(script.indexOf('docker pull')).toBeLessThan(
        script.indexOf('amd64) ;;'),
      );
      expect(script.indexOf('amd64) ;;')).toBeLessThan(
        script.indexOf(`docker push ${quote([remote])}`),
      );
      expect(script).not.toContain('CG_SOURCE_REGISTRY_PASSWORD');
      expect(sourceCalls()).toEqual([
        ['uploadObject', object],
        ['deleteObject', object],
      ]);

      // Nothing pulled, inspected or pushed here, and no secret made.
      expect(dockerCalls()).toBe('');
      expect(programs().join('\n')).not.toContain('docker pull');
      expect(
        ctx.google.calls.some((call) => call.method === 'putBuildSecret'),
      ).toBe(false);

      const log = await logOf(run.deploymentId);
      const at = (text: string) => {
        const index = log.indexOf(text);
        expect([text, index >= 0]).toEqual([text, true]);
        return index;
      };
      const order = [
        at(
          `🔧 [Build] Nothing is pulled on Cloudgate's own host; the ready-made image is copied in Cloud Build and the service runs in Cloud account Production Google (${REGION}).`,
        ),
        at('📦 [Build] The ready-made image is copied in Cloud Build'),
        at('☁️ [Cloud run] Waiting for the Cloud run, which copies the image'),
        at('latest: Pulling from library/nginx'),
        at('🧹 [Build] Removed the source zip'),
        at('✅ [Cloud run] web runs the image of this Deployment'),
      ];
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('hands a private registry password to the build through Secret Manager only, readable by the build identity, and deletes it after success', async () => {
      const { applicationId } = await appliedWeb(IMAGE_WEB);
      await givenPrivateRegistry(applicationId);
      ctx.google.scriptCloudBuild({ lines: ['#1 pulling'], held: true });
      const id = await redeployed(applicationId);
      const build = await until(
        () =>
          ctx.google.builds.find((one) =>
            one.request.build.tags.includes(`cloudgate-deployment-${id}`),
          ),
        'the copy build to start',
      );

      // Written before the start, this Deployment's own, one reader.
      const secretId = secretOf(id);
      const held = ctx.google.secrets.get(`${PROJECT}/${secretId}`);
      expect(held).toMatchObject({
        value: PASSWORD,
        reader: pieces().buildServiceAccountEmail,
      });
      const methods = ctx.google.calls.map((call) => call.method);
      expect(methods.indexOf('putBuildSecret')).toBeLessThan(
        methods.lastIndexOf('startCloudBuild'),
      );
      expect(
        ctx.google.calls.find((call) => call.method === 'putBuildSecret'),
      ).toMatchObject({ impersonated: true, projectId: PROJECT, secretId });

      // The build names the version, never the value: no step env carries
      // the password, nor does the zip.
      expect(build.request.build.availableSecrets).toEqual({
        secretManager: [
          {
            versionName: held?.versionName,
            env: 'CG_SOURCE_REGISTRY_PASSWORD',
          },
        ],
      });
      expect(build.request.build.steps[0].secretEnv).toEqual([
        'CG_SOURCE_REGISTRY_PASSWORD',
      ]);
      expect(build.request.build.steps[0]).not.toHaveProperty('env');
      expect(JSON.stringify(build.request)).not.toContain(PASSWORD);
      expect(JSON.stringify(ctx.google.calls)).not.toContain(PASSWORD);
      const zip = uploadedZip(id);
      expect(zip.body.toString('latin1')).not.toContain(PASSWORD);
      expect(zip.text('cloudgate/build.sh')).toContain(
        `printf %s "$CG_SOURCE_REGISTRY_PASSWORD" | docker login 'registry.example.com' -u 'deployer' --password-stdin`,
      );

      ctx.google.endCloudBuild(build.buildId);
      expect((await settled(id)).status).toBe('done');
      expect(ctx.google.secrets.size).toBe(0);
      const after = ctx.google.calls.map((call) => call.method);
      expect(after.lastIndexOf('deleteSecret')).toBeGreaterThan(
        after.lastIndexOf('cloudBuild'),
      );
      const log = await logOf(id);
      expect(log).toContain(
        `🔐 [Copy] Handing the registry password to Cloud Build through Secret Manager, as ${secretId}`,
      );
      expect(log).toContain(
        `🧹 [Copy] Removed the registry password's secret ${secretId}`,
      );
      expect(log).not.toContain(PASSWORD);
      expect(dockerCalls()).toBe('');
    });

    it('deletes the registry password after a failed copy too', async () => {
      const { applicationId } = await appliedWeb(IMAGE_WEB);
      await givenPrivateRegistry(applicationId);
      ctx.google.scriptCloudBuild({
        lines: ['Error response from daemon: unauthorized'],
        status: 'FAILURE',
        reason:
          'Build step 0 "ghcr.io/octabyte-io/cloudgate-builder" failed: step exited with non-zero status: 1',
      });
      const id = await redeployed(applicationId);
      const run = await settled(id);
      expect(run.status).toBe('error');
      expect(
        ctx.google.calls.filter((call) => call.method === 'putBuildSecret'),
      ).toHaveLength(1);
      expect(ctx.google.secrets.size).toBe(0);
      expect(ctx.google.calls).toContainEqual({
        method: 'deleteSecret',
        impersonated: true,
        projectId: PROJECT,
        secretId: secretOf(id),
      });
      expect(await logOf(id)).toContain(
        'The Cloud Build build failed: FAILURE',
      );
      expect(dockerCalls()).toBe('');
    });
  });

  describe('on a Self-hosted instance', () => {
    it('pulls a private ready-made image on the platform host as before, with no secret store and no Cloud Build', async () => {
      givenSelfHostedInstance();
      await ctx.db
        .update(cloudAccount)
        .set({ policyVersion: 5 })
        .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
      const { applicationId } = await appliedWeb(IMAGE_WEB);
      await ctx.db
        .update(application)
        .set({
          registryUrl: 'registry.example.com',
          username: 'deployer',
          password: 'registry-password',
        })
        .where(eq(application.applicationId, applicationId));
      fs.rmSync(record, { force: true });
      const id = await redeployed(applicationId);
      expect((await settled(id)).status).toBe('done');
      expect(dockerCalls()).toContain('login registry.example.com -u deployer');
      expect(dockerCalls()).toContain('pull --platform linux/amd64 nginx');
      expect(dockerCalls()).toMatch(/\npush \S+/);
      expect(startsOf()).toEqual([]);
      expect(
        ctx.google.calls.some((call) => call.method === 'putBuildSecret'),
      ).toBe(false);
    });

    it('builds a cloud Service on the platform host as before, and starts no Cloud Build build', async () => {
      givenSelfHostedInstance();
      const { run } = await appliedWeb(IMAGE_WEB);
      expect(run.status).toBe('done');
      const log = await logOf(run.deploymentId);
      expect(log).toContain(
        `🔧 [Build] Building on Cloudgate's own host; the service runs in Cloud account Production Google (${REGION}).`,
      );
      expect(log).toContain('✅ Image Pushed');
      expect(dockerCalls()).toContain('pull --platform linux/amd64 nginx');
      expect(dockerCalls()).toMatch(/\npush \S+/);
      expect(startsOf()).toEqual([]);
      expect(sourceCalls()).toEqual([]);
    });

    it('runs a git source’s build program on the platform host, with no zip and no Cloud Build', async () => {
      givenSelfHostedInstance();
      await ctx.db
        .update(cloudAccount)
        .set({ policyVersion: 5 })
        .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
      const { applicationId } = await appliedWeb(IMAGE_WEB);
      await ctx.db
        .update(application)
        .set({
          sourceType: 'git',
          customGitUrl: 'https://example.com/shop.git',
          customGitBranch: 'main',
          buildType: 'dockerfile',
        })
        .where(eq(application.applicationId, applicationId));
      fs.rmSync(record, { force: true });
      const id = await redeployed(applicationId);
      const run = await settled(id);
      expect([run.status, run.description]).toEqual([
        'done',
        expect.anything(),
      ]);
      expect(dockerCalls()).toMatch(/(^|\n)(buildx )?build /);
      expect(dockerCalls()).toMatch(/\npush \S+/);
      expect(startsOf()).toEqual([]);
      expect(sourceCalls()).toEqual([]);
      expect(await logOf(id)).not.toContain('Cloud Build');
    });
  });
});
