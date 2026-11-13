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

import { subscription } from '../../src/cloud/billing/billing.schema';
import { readDropArchive } from '../../src/applications/drop-archive';
import {
  buildPieceNames,
  registryPasswordParameterName,
} from '../../src/cloud-accounts/aws/cloud-build-names';
import { ecrRepositoryName } from '../../src/cloud-accounts/aws/definitions/web-definition';
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
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import { AwsCloudBuilds } from '../../src/project-config/applier/aws-cloud-builds.service';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { ADDRESS_RESOLVER } from '../../src/outbound/outbound-address';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const customer = {
  name: 'Grace',
  lastName: 'Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
  organizationName: 'Shop',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

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

/** A `docker` without a daemon: it records each call's words. */
const FAKE_DOCKER = `#!/bin/bash
echo "$*" >> "$FAKE_DOCKER_RECORD"
case "$1" in
  login) cat > /dev/null; echo "Login Succeeded" ;;
  pull) echo "Status: Downloaded newer image for $2" ;;
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
 * On the Hosted instance (ADR-0047) an AWS cloud Service builds in
 * CodeBuild in its Cloud account. The platform host checks the source out
 * as it does for every source type, the Cloud run zips the checkout without
 * its `.git` and uploads it to the Environment's source bucket, and
 * CodeBuild builds and pushes from the pinned builder image; starting,
 * watching and stopping it are cloud port calls. Its log lines are copied
 * into the Deployment log as they come, Cancel stops it, and the time it
 * waits in CodeBuild's queue does not count against the Cloud run time
 * limit. A Self-hosted counterpart closes the file: the same deploy builds
 * on the platform host.
 *
 * Against the fake cloud port (`ctx.cloud`, its CodeBuild scripted per
 * build), the fake object storage (`ctx.objectStorage`, which keeps each
 * uploaded file), and a real shell whose `git` and `docker` are the fakes
 * above, so the checkout, the copy aside and the zip are real files.
 */
describe('Hosted cloud builds in CodeBuild (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let ownerId: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), 'cloudgate-codebuild-'),
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
    ctx.app.get(AwsCloudBuilds).pollIntervalMs = 10;
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

    // Set up at version 3, whose template made the build identity.
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
        policyVersion: 3,
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
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;

    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('web', 'web-create');
  });

  const asOwner = () => ({
    user: { id: ownerId },
    session: { activeOrganizationId: organizationId },
  });

  /**
   * The install-wide Cloud run time limit, which only the Instance
   * organization may set: written to its settings row as its route does.
   */
  async function givenTimeLimitOfFiveMinutes() {
    const [row] = await ctx.db.select().from(webServerSettings).limit(1);
    if (row) {
      await ctx.db
        .update(webServerSettings)
        .set({ cloudRunTimeLimitMinutes: 5 });
    } else {
      await ctx.db
        .insert(webServerSettings)
        .values({ cloudRunTimeLimitMinutes: 5 });
    }
  }

  const givenSelfHostedInstance = () =>
    jest
      .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
      .mockReturnValue(false);

  /** This Environment's standing pieces, by the names they were given. */
  const pieces = () =>
    buildPieceNames({
      accountId: ACCOUNT,
      tagValue: cloudAccountId,
      environmentId,
      region: REGION,
    });

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
    }, 'the plan to read AWS');

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
    const run = await settled(web.deploy.deploymentId);
    return { plan: read, applicationId: web.serviceId!, run };
  }

  /** A redeploy of the Service, its plan image-only. */
  async function redeployed(applicationId: string): Promise<string> {
    ctx.cloud.replayPlanFor('web', 'image-only-no-variables');
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
    ctx.cloud.calls.flatMap((call) =>
      call.method === 'codeBuildStart' ? [call] : [],
    );

  /** The zip the Deployment uploaded, as its entries' paths and contents. */
  function uploadedZip(deploymentId: string) {
    const key = `${pieces().sourceBucketName}/builds/${deploymentId}/source.zip`;
    const body = ctx.objectStorage.bodies.get(key);
    if (!body) throw new Error(`No zip was uploaded to ${key}`);
    const entries = readDropArchive(body);
    return {
      body,
      paths: entries.map((entry) => entry.path).sort(),
      text: (path: string) =>
        entries.find((entry) => entry.path === path)?.content?.toString('utf8'),
    };
  }

  it('builds in CodeBuild from an uploaded zip of the checkout, never on the platform host, in one Deployment', async () => {
    ctx.cloud.scriptBuild({
      lines: ['Step 1/3 : FROM node:22', 'Successfully built 0f1e'],
      image: 'arm64 null',
    });
    const { plan, applicationId, run } = await appliedWeb();
    const webStep = plan.steps[1];
    if (webStep.action !== 'create' || webStep.cloudRead?.status !== 'read') {
      throw new Error('the web was not read');
    }
    expect(run).toMatchObject({ status: 'done', applicationId });
    const { projectName, sourceBucketName } = pieces();
    const prefix = `builds/${run.deploymentId}/`;

    // One build, of this Environment's project, from this Deployment's zip.
    expect(startsOf()).toHaveLength(1);
    const [start] = startsOf();
    expect(start).toMatchObject({
      method: 'codeBuildStart',
      region: REGION,
      projectName,
      sourceLocation: `${sourceBucketName}/${prefix}source.zip`,
      idempotencyToken: run.deploymentId,
    });
    expect(start.buildspec).toContain('bash cloudgate/build.sh');
    expect(start.buildspec).toContain('cloudgate-start-dockerd');
    expect(start.buildspec).toContain('exported-variables');
    const [build] = ctx.cloud.builds;
    expect(
      ctx.cloud.calls.some(
        (call) =>
          call.method === 'codeBuildState' && call.buildId === build.buildId,
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
    expect(zip.text('code/cloned-from.txt')).toBe(
      'https://example.com/shop.git\n',
    );
    const remote = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${ecrRepositoryName(applicationId)}:${run.deploymentId}`;
    const script = zip.text('cloudgate/build.sh') ?? '';
    expect(script).toContain(`docker push ${quote([remote])}`);
    expect(script).toContain('ecr-login');

    // Uploaded, then removed from the bucket and from the platform host.
    const storage = ctx.objectStorage.calls.filter(
      (call) => call.target.bucket === sourceBucketName,
    );
    expect(storage.map((call) => [call.call, call.prefix])).toEqual([
      ['uploadFolder', prefix],
      ['deleteFolder', prefix],
    ]);
    expect(ctx.objectStorage.entriesOf(sourceBucketName)).toEqual([]);
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
    expect(
      ctx.cloud.calls.some((call) => call.method === 'ecrAuthorizationToken'),
    ).toBe(false);
    expect(programs().join('\n')).not.toMatch(
      /nixpacks build|railpack prepare|pack build|docker build/,
    );

    // The repository first (targeted), then the build, then the apply, whose
    // task follows the built image's CPU, as CodeBuild exported it.
    const webState = webStep.cloudRead.stateId;
    const webCalls = ctx.cloud.calls.filter(
      (call) => 'stateId' in call && call.stateId === webState,
    );
    expect(webCalls.at(-1)).toMatchObject({
      method: 'apply',
      cpuArchitecture: 'ARM64',
    });
    expect((await deploymentRow(run.deploymentId)).cloudRun).toMatchObject({
      architecture: 'arm64',
      healthCheck: null,
    });

    const log = await logOf(run.deploymentId);
    const at = (text: string) => {
      const index = log.indexOf(text);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      at(
        `🔧 [Build] Checking out on Cloudgate's own host; the image is built in CodeBuild and the service runs in Cloud account Production AWS (${REGION}).`,
      ),
      at('📁 [Source] Taking the checkout for CodeBuild'),
      at('📦 [Build] The image is built in CodeBuild'),
      at('☁️ [Cloud run] Checked out.'),
      at("📦 [Push] Making the Service's ECR repository first"),
      at(
        `📤 [Build] Uploading the source to s3://${sourceBucketName}/${prefix}source.zip`,
      ),
      at(`🔨 [Build] CodeBuild build ${build.buildId} started`),
      at('Step 1/3 : FROM node:22'),
      at('Successfully built 0f1e'),
      at('✅ [Build] CodeBuild built the image'),
      at('🧹 [Build] Removed the source zip'),
      at('Reading AWS again before applying'),
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
    // Each built in CodeBuild, none on the platform host.
    expect(startsOf()).toHaveLength(1 + sources.length);
    expect(dockerCalls()).toBe('');
  });

  it("copies the build's log lines into the Deployment log while it runs", async () => {
    const { applicationId } = await appliedWeb();
    ctx.cloud.scriptBuild({
      lines: ['#1 [internal] load build definition', '#2 npm ci', '#3 done'],
      held: true,
    });
    const id = await redeployed(applicationId);
    const build = await until(
      () => ctx.cloud.builds.find((one) => one.request.idempotencyToken === id),
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
    expect(live).not.toContain('✅ [Build] CodeBuild built the image');

    ctx.cloud.endBuild(build.buildId);
    expect((await settled(id)).status).toBe('done');
    // Each line once, however often the stream was read.
    expect((await logOf(id)).split('#2 npm ci')).toHaveLength(2);
  });

  it('stops the CodeBuild build when the deploy is cancelled, and removes its zip', async () => {
    const { applicationId } = await appliedWeb();
    ctx.cloud.scriptBuild({ lines: ['#1 building'], held: true });
    const id = await redeployed(applicationId);
    const build = await until(
      () => ctx.cloud.builds.find((one) => one.request.idempotencyToken === id),
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

    expect(ctx.cloud.calls).toContainEqual({
      method: 'codeBuildStop',
      region: REGION,
      buildId: build.buildId,
    });
    expect(build.stopAsked).toBe(true);
    const log = await logOf(id);
    expect(log).toContain('⏹️ [Build] Stopping the CodeBuild build');
    expect(log).toContain('🧹 [Build] Removed the source zip');
    expect(ctx.objectStorage.entriesOf(pieces().sourceBucketName)).toEqual([]);
    // Nothing was applied after the build was stopped.
    const applies = ctx.cloud.calls.filter((call) => call.method === 'apply');
    const before = applies.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      ctx.cloud.calls.filter((call) => call.method === 'apply'),
    ).toHaveLength(before);
  });

  it('does not count time queued in CodeBuild against the time limit: a build queued past it, then quick, succeeds', async () => {
    const { applicationId } = await appliedWeb();
    await givenTimeLimitOfFiveMinutes();

    // Five minutes are 500 ms here; the build waits three times that.
    ctx.cloud.scriptBuild({ queuedMs: 5 * MINUTE_MS * 3, lines: ['#1 quick'] });
    const id = await redeployed(applicationId);
    const run = await settled(id);
    expect(run.status).toBe('done');
    const log = await logOf(id);
    expect(log).toContain(
      '⏳ [Build] Queued in CodeBuild, waiting for capacity in the Cloud account; this wait does not count against the Cloud run time limit',
    );
    expect(log.indexOf('⏳ [Build] Queued in CodeBuild')).toBeLessThan(
      log.indexOf('🔨 [Build] CodeBuild is building the image'),
    );
    expect(log).not.toContain('time limit of 5 minutes');
  });

  it('still ends a build that runs past the time limit, stopping it in CodeBuild', async () => {
    const { applicationId } = await appliedWeb();
    await givenTimeLimitOfFiveMinutes();
    ctx.cloud.scriptBuild({ held: true });
    const id = await redeployed(applicationId);
    const run = await settled(id);
    expect(run.status).toBe('error');
    expect(run.description).toBe(
      'Ended by the Cloud run time limit of 5 minutes. Changes made so far stay in your AWS account; the next deploy picks up from them.',
    );
    expect(ctx.cloud.builds.at(-1)?.stopAsked).toBe(true);
  });

  it('fails the deploy with CodeBuild’s words when the build fails, and still removes the zip', async () => {
    const { applicationId } = await appliedWeb();
    ctx.cloud.scriptBuild({
      lines: ['npm ERR! missing script: build'],
      status: 'FAILED',
      reason:
        'COMMAND_EXECUTION_ERROR: Error while executing command: bash cloudgate/build.sh. Reason: exit status 1',
    });
    const id = await redeployed(applicationId);
    const run = await settled(id);
    expect(run.status).toBe('error');
    const log = await logOf(id);
    expect(log).toContain('npm ERR! missing script: build');
    expect(log).toContain(
      'The CodeBuild build failed: FAILED: COMMAND_EXECUTION_ERROR: Error while executing command: bash cloudgate/build.sh. Reason: exit status 1',
    );
    expect(log).toContain('🧹 [Build] Removed the source zip');
    expect(ctx.objectStorage.entriesOf(pieces().sourceBucketName)).toEqual([]);
  });

  it('refuses a cloud deploy in a Cloud account set up before the build identity, before anything is checked out', async () => {
    const { applicationId } = await appliedWeb();
    await ctx.db
      .update(cloudAccount)
      .set({ policyVersion: 2 })
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    execMock.execAsync.mockClear();
    const starts = startsOf().length;

    const id = await redeployed(applicationId);
    const run = await settled(id);
    expect(run.status).toBe('error');
    const log = await logOf(id);
    expect(log).toContain(
      "Cannot deploy: Cloud account Production AWS was set up at permissions version 2, and a cloud build on this instance needs version 3, whose setup makes the build identity the build runs as. Re-run the Cloud account's setup, then deploy again.",
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

    const parameterOf = (deploymentId: string) =>
      registryPasswordParameterName({ tagValue: cloudAccountId, deploymentId });

    it('is copied by a build in CodeBuild, and nothing is pulled on the platform host', async () => {
      ctx.cloud.scriptBuild({ lines: ['latest: Pulling from library/nginx'] });
      const { applicationId, run } = await appliedWeb(IMAGE_WEB);
      expect(run.status).toBe('done');

      // One build, of this Environment's project, its zip the copy alone.
      expect(startsOf()).toHaveLength(1);
      const [start] = startsOf();
      expect(start).toMatchObject({
        projectName: pieces().projectName,
        sourceLocation: `${pieces().sourceBucketName}/builds/${run.deploymentId}/source.zip`,
        idempotencyToken: run.deploymentId,
      });
      expect(start.parameterVariables).toBeUndefined();
      const zip = uploadedZip(run.deploymentId);
      expect(zip.paths).toEqual(['cloudgate/build.sh']);
      const remote = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${ecrRepositoryName(applicationId)}:${run.deploymentId}`;
      const script = zip.text('cloudgate/build.sh') ?? '';
      expect(script).toContain('docker pull nginx');
      expect(script).toContain(`docker tag nginx ${quote([remote])}`);
      expect(script).toContain(`docker push ${quote([remote])}`);
      expect(script).not.toContain('docker login');

      // Nothing pulled, inspected or pushed here, and no ECR token asked.
      expect(dockerCalls()).toBe('');
      expect(
        ctx.cloud.calls.some(
          (call) =>
            call.method === 'ecrAuthorizationToken' ||
            call.method === 'putBuildParameter',
        ),
      ).toBe(false);
      expect(programs().join('\n')).not.toContain('docker pull');

      const log = await logOf(run.deploymentId);
      const at = (text: string) => {
        const index = log.indexOf(text);
        expect(index).toBeGreaterThanOrEqual(0);
        return index;
      };
      const order = [
        at(
          `🔧 [Build] Nothing is pulled on Cloudgate's own host; the ready-made image is copied in CodeBuild and the service runs in Cloud account Production AWS (${REGION}).`,
        ),
        at('📦 [Build] The ready-made image is copied in CodeBuild'),
        at('☁️ [Cloud run] Waiting for the Cloud run, which copies the image'),
        at(`🔨 [Build] CodeBuild build ${ctx.cloud.builds[0].buildId} started`),
        at('latest: Pulling from library/nginx'),
        at('🧹 [Build] Removed the source zip'),
        at('✅ [Cloud run] web runs the image of this Deployment'),
      ];
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(log).not.toContain('Pulling image nginx');
    });

    it('hands a private registry password to the build through SSM Parameter Store only, and deletes it after success', async () => {
      const { applicationId } = await appliedWeb(IMAGE_WEB);
      await givenPrivateRegistry(applicationId);
      ctx.cloud.scriptBuild({ lines: ['#1 pulling'], held: true });
      const id = await redeployed(applicationId);
      const build = await until(
        () =>
          ctx.cloud.builds.find((one) => one.request.idempotencyToken === id),
        'the copy build to start',
      );

      // Written before the start, as this Deployment's own SecureString.
      const name = parameterOf(id);
      expect(ctx.cloud.parameters.get(`${REGION}:${name}`)).toEqual({
        value: PASSWORD,
        tagValue: cloudAccountId,
      });
      const methods = ctx.cloud.calls.map((call) => call.method);
      expect(methods.indexOf('putBuildParameter')).toBeLessThan(
        methods.lastIndexOf('codeBuildStart'),
      );

      // The start names the parameter, never the value: no build variable
      // carries the password, nor does the buildspec, nor the zip.
      expect(build.request.parameterVariables).toEqual([
        { name: 'CG_SOURCE_REGISTRY_PASSWORD', parameterName: name },
      ]);
      expect(JSON.stringify(build.request)).not.toContain(PASSWORD);
      expect(JSON.stringify(ctx.cloud.calls)).not.toContain(PASSWORD);
      const zip = uploadedZip(id);
      expect(zip.body.toString('latin1')).not.toContain(PASSWORD);
      const script = zip.text('cloudgate/build.sh') ?? '';
      expect(script).toContain(
        `printf %s "$CG_SOURCE_REGISTRY_PASSWORD" | docker login 'registry.example.com' -u 'deployer' --password-stdin`,
      );
      expect(script).toContain(
        `docker pull ${quote(['registry.example.com/acme/shop:1.4'])}`,
      );

      ctx.cloud.endBuild(build.buildId);
      expect((await settled(id)).status).toBe('done');
      // Deleted once the build ended, and not before.
      expect(ctx.cloud.parameters.size).toBe(0);
      const after = ctx.cloud.calls.map((call) => call.method);
      expect(after.lastIndexOf('deleteParameter')).toBeGreaterThan(
        after.lastIndexOf('codeBuildState'),
      );
      expect(ctx.cloud.calls).toContainEqual({
        method: 'deleteParameter',
        region: REGION,
        name,
      });
      const log = await logOf(id);
      expect(log).toContain(
        `🔐 [Copy] Handing the registry password to CodeBuild through SSM Parameter Store, as ${name}`,
      );
      expect(log).toContain(
        `🧹 [Copy] Removed the registry password's parameter ${name}`,
      );
      expect(log).not.toContain(PASSWORD);
      expect(dockerCalls()).toBe('');
    });

    it('deletes the registry password after a failed copy too', async () => {
      const { applicationId } = await appliedWeb(IMAGE_WEB);
      await givenPrivateRegistry(applicationId);
      ctx.cloud.scriptBuild({
        lines: ['Error response from daemon: unauthorized'],
        status: 'FAILED',
        reason:
          'COMMAND_EXECUTION_ERROR: Error while executing command: bash cloudgate/build.sh. Reason: exit status 1',
      });
      const id = await redeployed(applicationId);
      const run = await settled(id);
      expect(run.status).toBe('error');
      expect(
        ctx.cloud.calls.filter((call) => call.method === 'putBuildParameter'),
      ).toHaveLength(1);
      expect(ctx.cloud.parameters.size).toBe(0);
      expect(ctx.cloud.calls).toContainEqual({
        method: 'deleteParameter',
        region: REGION,
        name: parameterOf(id),
      });
      const log = await logOf(id);
      expect(log).toContain('The CodeBuild build failed: FAILED');
      expect(log).toContain(
        `🧹 [Copy] Removed the registry password's parameter ${parameterOf(id)}`,
      );
      expect(dockerCalls()).toBe('');
    });
  });

  describe('on a Self-hosted instance', () => {
    it('pulls a private ready-made image on the platform host as before, with no secret store and no CodeBuild', async () => {
      givenSelfHostedInstance();
      await ctx.db
        .update(cloudAccount)
        .set({ policyVersion: 2 })
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
      expect(dockerCalls()).toContain('pull nginx');
      expect(dockerCalls()).toMatch(/\npush \S+/);
      expect(startsOf()).toEqual([]);
      expect(
        ctx.cloud.calls.some((call) => call.method === 'putBuildParameter'),
      ).toBe(false);
    });

    it('builds a cloud Service on the platform host as before, and starts no CodeBuild build', async () => {
      givenSelfHostedInstance();
      const { run } = await appliedWeb(IMAGE_WEB);
      expect(run.status).toBe('done');
      const log = await logOf(run.deploymentId);
      expect(log).toContain(
        `🔧 [Build] Building on Cloudgate's own host; the service runs in Cloud account Production AWS (${REGION}).`,
      );
      expect(log).toContain('✅ Image Pushed');
      expect(dockerCalls()).toContain('pull nginx');
      expect(dockerCalls()).toMatch(/\npush \S+/);
      expect(
        ctx.cloud.calls.some((call) => call.method === 'ecrAuthorizationToken'),
      ).toBe(true);
      expect(startsOf()).toEqual([]);
      expect(ctx.objectStorage.calls).toEqual([]);
    });

    it('runs a git source’s build program on the platform host, with no zip and no CodeBuild', async () => {
      givenSelfHostedInstance();
      await ctx.db
        .update(cloudAccount)
        .set({ policyVersion: 2 })
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
      expect(run.status).toBe('done');
      expect(dockerCalls()).toMatch(/(^|\n)(buildx )?build /);
      expect(dockerCalls()).toMatch(/\npush \S+/);
      expect(startsOf()).toEqual([]);
      expect(ctx.objectStorage.calls).toEqual([]);
      expect(await logOf(id)).not.toContain('CodeBuild');
    });
  });
});
