import { exec } from 'node:child_process';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { idKey } from '../../src/cloud-accounts/gcp/definitions/names';
import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import {
  application,
  cloudAccount,
  deployment,
  environment,
  environmentNetwork,
  webServerSettings,
} from '../../src/db/schema';
import type { Deployment } from '../../src/db/schema';
import { CloudRunsService } from '../../src/deployment-queue/cloud-runs.service';
import { SourceCloneService } from '../../src/git-providers/source-clone.service';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import type { FakeGoogleCall } from '../utils/fake-google-cloud-port';
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

const DOCS = `version: 1
services:
  docs:
    kind: static
    size: small
    env: [API_URL]
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

interface Step {
  action: string;
  configName?: string;
  kind?: string;
  fields?: { field: string }[];
  site?: { spa: boolean };
  bucket?: { name: string; serviceId?: string };
  cloudRead?: {
    status: 'reading' | 'read' | 'failed';
    reason?: string;
    summary?: string[];
    stateId?: string;
    serviceId?: string;
  };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
  notes: { kind: string; configName: string; message: string }[];
}

/**
 * Static site on Cloud Storage and Cloud CDN: on a
 * Google Cloud Deploy target a `kind: static` entry becomes a private Cloud
 * Storage bucket behind a Cloud CDN backend bucket, in its own
 * Infrastructure state, made by a Cloud run that builds nothing. Its plan
 * says what it costs and that it answers nowhere until a Domain is added. A
 * push deploys it as a Deployment of the Service: the files go to its own
 * folder, then are copied on Google's side into the fixed `live/` folder,
 * every other file before the pages, then what the new version lacks
 * deleted. No network run, no wait. Against `ctx.google`, whose stand-in
 * `tofu` replays the stored plan and whose Cloud Storage records each
 * object operation in order.
 */
describe('A static site on Google Cloud (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let ownerId: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  let githubId: string;
  let cloudAccountId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gstatic-'));
  const savedRoot = process.env.CLOUDGATE_DIRECTORY;
  /** What the next push's clone writes under `dist`. */
  let files: Record<string, string> = {};

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
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    http = ctx.app.getHttpServer() as App;
    // A pushed commit's clone, without GitHub: the files of `dist`.
    const clones = ctx.app.get<SourceCloneService>(SourceCloneService);
    jest
      .spyOn(clones, 'cloneProgram')
      .mockImplementation((_source, outputPath) => {
        const at = (file: string) => `'${nodePath.join(outputPath, file)}'`;
        const writes = Object.entries(files).map(
          ([path, body]) =>
            `mkdir -p "$(dirname ${at(`dist/${path}`)})" && printf '%s' '${body}' > ${at(`dist/${path}`)} ;`,
        );
        return Promise.resolve({
          command: [
            `rm -rf '${outputPath}' && mkdir -p ${at('dist')} ;`,
            ...writes,
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
    // The install's own address, which a Google provider names as its
    // issuer: a Google Environment is refused without it.
    await ctx.db
      .insert(webServerSettings)
      .values({ host: 'cloudgate.example.com', https: true });
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
        policyVersion: 2,
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
          cloudAccountId: (cloudAccountId = row.cloudAccountId),
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

    ctx.google.replayPlanFor('static', 'static-create');
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

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  const apply = (planId: string) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

  const logOf = async (deploymentId: string) => {
    const res = await request(http)
      .get(`/deployments/${deploymentId}/logs`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.text;
  };

  /** Plans and applies the site, waits for its Cloud run, and has it build from acme/docs. */
  async function madeSite() {
    expect((await save(DOCS)).status).toBe(201);
    const read = await readPlan();
    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    const made = (
      applied.body as { results: { deploy: { deploymentId: string } }[] }
    ).results[0].deploy.deploymentId;
    expect((await settledDeployment(made)).status).toBe('done');
    const [site] = await ctx.db.select().from(application);
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
    ctx.google.calls.length = 0;
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
            ne(deployment.title, 'Create docs on Cloud Storage + Cloud CDN'),
          ),
        );
      return rows.find((row) => !seen.includes(row.deploymentId));
    }, 'the push to record a Deployment');
    return settledDeployment(queued.deploymentId);
  }

  const URL_MAP = 'cloudgate-urls';
  const DOCS_HOST = 'docs.acme.dev';
  const WWW_HOST = 'www.docs.acme.dev';

  interface UrlMap {
    host_rule: { hosts: string[]; path_matcher: string }[];
    path_matcher: {
      name: string;
      default_service?: string;
      default_route_action?: unknown;
      default_custom_error_response_policy?: unknown;
    }[];
  }

  /** The made Environment network, as its create's run leaves it. */
  async function madeNetwork(): Promise<string> {
    const [network] = await ctx.db
      .insert(environmentNetwork)
      .values({
        environmentId,
        cloudAccountId,
        region: REGION,
        status: 'ready',
        networkName: 'cloudgate-net',
        subnetName: 'cloudgate-subnet',
        ipAddress: '34.120.0.7',
        urlMapName: URL_MAP,
        certificateMapName: 'cloudgate-certs',
      })
      .returning();
    await ctx.app
      .get(InfrastructureStatesService)
      .create(
        { environmentNetworkId: network.environmentNetworkId },
        undefined,
        'google',
      );
    ctx.google.replayPlanFor('network', null);
    ctx.google.replayOutputsFor('network', null);
    return network.environmentNetworkId;
  }

  /** Plans and applies the site as the config says, and waits for its Cloud run. */
  async function appliedSite(text: string) {
    expect((await save(text)).status).toBe(201);
    const read = await readPlan();
    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    const made = (
      applied.body as { results: { deploy: { deploymentId: string } }[] }
    ).results[0].deploy.deploymentId;
    expect((await settledDeployment(made)).status).toBe('done');
    const [site] = await ctx.db.select().from(application);
    return site;
  }

  /** Adds a Domain and waits for its network run; answers its id and run. */
  async function addedDomain(applicationId: string, host: string) {
    const res = await request(http)
      .post('/domains')
      .set('Cookie', cookie)
      .send({ applicationId, host });
    expect([res.status, res.body]).toEqual([201, expect.anything()]);
    const { domainId, deploymentId } = res.body as {
      domainId: string;
      deploymentId: string;
    };
    const run = await settledDeployment(deploymentId);
    expect(run.status).toBe('done');
    return { domainId, run };
  }

  /** The URL map the network's last apply wrote. */
  function lastUrlMap(): UrlMap {
    const input = [...ctx.google.tofuInputs]
      .reverse()
      .find(
        (one) =>
          one.method === 'apply' &&
          one.definition.includes('"google_compute_network"'),
      );
    expect(input).toBeDefined();
    return (
      JSON.parse(input!.definition) as {
        resource: { google_compute_url_map: { network: UrlMap } };
      }
    ).resource.google_compute_url_map.network;
  }

  const backendBucket = (serviceId: string) =>
    `projects/${PROJECT}/global/backendBuckets/cloudgate-${idKey(serviceId)}`;

  it('plans the bucket and backend bucket at $0/month with the by-use, no-Domain and ignored-fields notes, and Apply makes them through a Cloud run', async () => {
    expect((await save(DOCS)).status).toBe(201);

    const read = await readPlan();
    // Cloud Storage and Cloud CDN need no Environment network yet.
    expect(read.steps.map((step) => step.action)).toEqual(['create']);
    const [step] = read.steps;
    expect(step).toMatchObject({
      configName: 'docs',
      kind: 'static',
      site: { spa: false },
    });
    // Named by the Service's own key, which the read and Apply keep.
    const serviceId = step.bucket?.serviceId ?? '';
    expect(step.bucket?.name).toMatch(
      new RegExp(`^cloudgate-${idKey(serviceId)}-[a-z0-9]{8}$`),
    );
    expect(step.cloudRead?.status).toBe('read');
    expect(step.cloudRead?.serviceId).toBe(serviceId);
    expect(step.cloudRead?.summary).toEqual([
      'Cloud CDN backend bucket `cloudgate-bw7upcvsg6j2`: create, $0/month fixed, every file cached at the edge, browsers check back every time, negative caching off',
      'Cloud Storage bucket `cloudgate-bw7upcvsg6j2-p4x8m2rt`: create, $0/month fixed, private (public access prevention enforced), soft delete off',
      "Load balancer's read access to the bucket: create, only Google's load balancer reads its files",
    ]);
    expect(read.notes.map((note) => note.kind)).toEqual([
      'ignored-on-cloud-cdn',
      'static-by-use',
      'static-no-domain',
    ]);
    expect(read.notes[0].message).toBe(
      'docs: `size`, `env` have no meaning on Cloud Storage + Cloud CDN, so they are ignored',
    );
    expect(read.notes[1].message).toContain('$0/month fixed');
    expect(read.notes[1].message).toContain('charged by use');
    expect(read.notes[2].message).toContain(
      'answers nowhere until a Domain is added',
    );
    // The read wrote the definition under the name the plan shows.
    const [readInput] = ctx.google.tofuInputs;
    expect(readInput.definition).toContain(`"name": "${step.bucket!.name}"`);
    expect(readInput.definition).toContain('google_compute_backend_bucket');

    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      results: [
        {
          configName: 'docs',
          action: 'create',
          status: 'applied',
          serviceType: 'application',
          serviceId,
          deploy: { status: 'queued' },
        },
      ],
    });
    const [created] = await ctx.db.select().from(application);
    expect(created).toMatchObject({
      applicationId: serviceId,
      configKind: 'static',
      cloudBucketName: step.bucket!.name,
      serverId: null,
    });
    const [state] = await ctx.db
      .select()
      .from(infrastructureState)
      .where(eq(infrastructureState.applicationId, serviceId));
    expect(state).toMatchObject({
      infrastructureStateId: step.cloudRead!.stateId,
      provider: 'google',
    });
    const deploymentId = (
      applied.body as { results: { deploy: { deploymentId: string } }[] }
    ).results[0].deploy.deploymentId;
    const run = await settledDeployment(deploymentId);
    expect(run).toMatchObject({
      title: 'Create docs on Cloud Storage + Cloud CDN',
      status: 'done',
    });
    expect(ctx.google.calls.filter((call) => call.method === 'apply')).toEqual([
      expect.objectContaining({
        stateId: state.infrastructureStateId,
        kind: 'static',
      }),
    ]);
    expect(await logOf(deploymentId)).toContain(
      'docs is made on Cloud CDN; it answers nowhere until a Domain is added',
    );
  });

  it('deploys into its own folder, then copies non-HTML files, then pages with their folder objects, then deletes what the new version lacks, skipping unchanged files', async () => {
    const site = await madeSite();
    const bucket = site.cloudBucketName!;

    files = {
      'index.html': '<h1>Docs</h1>',
      'about/index.html': '<h1>About</h1>',
      'assets/app.js': 'v1',
      'old.css': 'body{}',
    };
    const first = await push(site.applicationId, 'a'.repeat(40));
    expect(first.status).toBe('done');
    ctx.google.calls.length = 0;

    files = {
      'index.html': '<h1>Docs, new</h1>',
      'about/index.html': '<h1>About</h1>',
      'assets/app.js': 'v2',
    };
    const run = await push(site.applicationId, 'b'.repeat(40), [
      first.deploymentId,
    ]);
    expect(run).toMatchObject({
      status: 'done',
      cloudRun: expect.objectContaining({
        kind: 'static-deploy',
        touchesNetwork: false,
      }) as unknown,
    });

    const folder = `deployments/${run.deploymentId}/`;
    const operations = ctx.google.objectOperations();
    const uploads = operations.filter((one) => one.op === 'upload');
    expect(
      uploads.map((one) => (one.op === 'upload' ? one.name : '')).sort(),
    ).toEqual([
      `${folder}about/index.html`,
      `${folder}assets/app.js`,
      `${folder}index.html`,
    ]);
    // After the upload: the changed script, then the changed page and its
    // folder object, then the file the new version lacks. The unchanged
    // about page is not copied again.
    const afterUpload = operations.filter((one) => one.op !== 'upload');
    expect(afterUpload.slice(0, 4)).toEqual([
      {
        op: 'copy',
        bucket,
        from: `${folder}assets/app.js`,
        to: 'live/assets/app.js',
      },
      expect.objectContaining({ op: 'copy', to: 'live/index.html' }),
      expect.objectContaining({ op: 'copy', to: 'live/' }),
      { op: 'delete', bucket, name: 'live/old.css' },
    ]);
    // Then only the folder clean-up, never `live/`.
    for (const one of afterUpload.slice(4)) {
      expect(one).toMatchObject({
        op: 'delete',
        name: expect.stringMatching(/^deployments\//) as unknown,
      });
    }
    expect(
      ctx.google.objectsOf(bucket).filter((one) => one.startsWith('live/')),
    ).toEqual([
      'live/',
      'live/about/',
      'live/about/index.html',
      'live/assets/app.js',
      'live/index.html',
    ]);
    // A deploy needs no network run and no `tofu`.
    expect(
      ctx.google.calls.filter((call) =>
        ['plan', 'apply', 'destroy'].includes(call.method),
      ),
    ).toEqual([]);
    const network = await ctx.db
      .select()
      .from(deployment)
      .where(isNotNull(deployment.environmentNetworkId));
    expect(network).toEqual([]);

    const log = await logOf(run.deploymentId);
    const at = (text: string) => {
      const index = log.indexOf(text);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      at(
        "🔧 [Build] Checking out on Cloudgate's own host; the site is served from Cloud Storage + Cloud CDN in Cloud account Production Google (europe-west1).",
      ),
      at(
        "📦 [Push] No image: the files go to the site's own Cloud Storage bucket",
      ),
      at('☁️ [Cloud run] Deploying docs to Cloud Storage + Cloud CDN'),
      at(`📤 [Upload] Uploading the files to gs://${bucket}/${folder}`),
      at('✅ [Upload] Uploaded 3 files'),
      at('🔁 [Copy] Copying into the live site (3 changed)'),
      at('🧹 [Copy] Removed 1 old file'),
      at('🌐 [Clear] No Domain yet, so there is no cache to clear'),
      at('✅ [Cloud run] docs serves the files of this Deployment'),
      at('🏁 [Cloud run] Done after'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(log).not.toContain('CloudFront');
    expect(log).not.toContain('S3');
  });

  /**
   * Stories 37, 41, 42, 49, 51: the site's host rules,
   * its one `/` → `/live/` rewrite and, under `spa`, its error policy are
   * the Environment network's. Each Domain is added or removed by a run of
   * the network; a deploy clears the cache once per Domain after its copy;
   * a `spa` change is a network run that ends with the same clears.
   */
  describe('Domains, cache clears and spa', () => {
    it('adds each Domain by a run of the network whose host rule goes to the backend bucket, and removes only the removed one’s', async () => {
      const site = await appliedSite(DOCS);
      const networkId = await madeNetwork();
      ctx.google.calls.length = 0;

      const docs = await addedDomain(site.applicationId, DOCS_HOST);
      expect(docs.run).toMatchObject({
        environmentNetworkId: networkId,
        forServiceId: site.applicationId,
      });
      const www = await addedDomain(site.applicationId, WWW_HOST);
      expect(www.run.environmentNetworkId).toBe(networkId);

      const both = lastUrlMap();
      expect(both.host_rule.map((rule) => rule.hosts[0]).sort()).toEqual([
        DOCS_HOST,
        WWW_HOST,
      ]);
      for (const matcher of both.path_matcher) {
        expect(matcher).toEqual({
          name: matcher.name,
          default_service: backendBucket(site.applicationId),
          default_route_action: {
            url_rewrite: { path_prefix_rewrite: '/live' },
          },
        });
      }
      // The first Domain's run only adds the host rule: no file moves in
      // live/, nothing is cleared, and the site's own state is untouched.
      expect(ctx.google.objectOperations()).toEqual([]);
      expect(ctx.google.cacheClears()).toEqual([]);
      expect(
        ctx.google.calls
          .filter((call) => call.method === 'apply')
          .map((call) => (call.method === 'apply' ? call.kind : null)),
      ).toEqual(['network', 'network']);

      const removed = await request(http)
        .delete(`/domains/${www.domainId}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);
      const { deploymentId } = removed.body as { deploymentId: string };
      expect((await settledDeployment(deploymentId)).status).toBe('done');
      expect(lastUrlMap().host_rule.map((rule) => rule.hosts)).toEqual([
        [DOCS_HOST],
      ]);
    });

    it('refuses a path on a static site’s Domain: its rule is the whole host', async () => {
      const site = await appliedSite(DOCS);
      await madeNetwork();

      const res = await request(http)
        .post('/domains')
        .set('Cookie', cookie)
        .send({
          applicationId: site.applicationId,
          host: DOCS_HOST,
          path: '/guide',
        });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        'a Domain on a static site on Google Cloud is its whole host',
      );
    });

    it('clears the cache once per Domain after the copy into live/, naming each in the log', async () => {
      const site = await madeSite();
      await madeNetwork();
      await addedDomain(site.applicationId, DOCS_HOST);
      await addedDomain(site.applicationId, WWW_HOST);
      ctx.google.calls.length = 0;

      files = { 'index.html': '<h1>Docs</h1>', 'app.js': 'go()' };
      const run = await push(site.applicationId, 'c'.repeat(40));
      expect(run.status).toBe('done');

      expect(ctx.google.cacheClears()).toEqual([
        { urlMap: URL_MAP, host: DOCS_HOST },
        { urlMap: URL_MAP, host: WWW_HOST },
      ]);
      const lastLiveWrite = ctx.google.calls.findLastIndex(
        (call) =>
          (call.method === 'copyObject' && call.to.startsWith('live/')) ||
          (call.method === 'deleteObject' && call.name.startsWith('live/')),
      );
      const firstClear = ctx.google.calls.findIndex(
        (call) => call.method === 'invalidateCache',
      );
      expect(lastLiveWrite).toBeGreaterThanOrEqual(0);
      expect(firstClear).toBeGreaterThan(lastLiveWrite);
      // Still no network run for a deploy.
      expect(
        ctx.google.calls.filter((call) =>
          ['plan', 'apply', 'destroy'].includes(call.method),
        ),
      ).toEqual([]);

      const log = await logOf(run.deploymentId);
      const copied = log.indexOf('🔁 [Copy] Copying into the live site');
      const docsCleared = log.indexOf(`Cleared the cache for ${DOCS_HOST}`);
      const wwwCleared = log.indexOf(`Cleared the cache for ${WWW_HOST}`);
      expect(copied).toBeGreaterThanOrEqual(0);
      expect(docsCleared).toBeGreaterThan(copied);
      expect(wwwCleared).toBeGreaterThan(docsCleared);
      expect(log).not.toContain('No Domain yet');
    });

    it('turns spa on by a network run with its plan note and the 404 → /live/index.html policy, ending with a clear per Domain; off removes it and clears again', async () => {
      const site = await appliedSite(DOCS);
      const networkId = await madeNetwork();
      await addedDomain(site.applicationId, DOCS_HOST);
      await addedDomain(site.applicationId, WWW_HOST);

      const toggle = async (text: string) => {
        ctx.google.calls.length = 0;
        expect((await save(text)).status).toBe(201);
        const read = await readPlan();
        expect(read.steps).toEqual([
          expect.objectContaining({
            action: 'change',
            configName: 'docs',
            fields: [expect.objectContaining({ field: 'build.spa' })],
          }),
        ]);
        // It reads nothing of the site: its own state never holds spa.
        expect(read.steps[0].cloudRead).toBeUndefined();
        expect(read.notes).toContainEqual(
          expect.objectContaining({
            kind: 'static-spa-change',
            message: expect.stringContaining(
              'Some visitors may see the old behaviour for missing pages for a few minutes',
            ) as unknown,
          }),
        );
        expect(
          read.notes.find((note) => note.kind === 'static-spa-change')?.message,
        ).toContain(
          'a missing page cached with the shell can last up to a day',
        );
        const applied = await apply(read.planId);
        expect(applied.status).toBe(200);
        const { deploymentId } = (
          applied.body as { results: { deploy: { deploymentId: string } }[] }
        ).results[0].deploy;
        const run = await settledDeployment(deploymentId);
        expect(run).toMatchObject({
          status: 'done',
          environmentNetworkId: networkId,
          forServiceId: site.applicationId,
        });
        // The run ends with a clear per Domain, after the network's apply.
        expect(ctx.google.cacheClears()).toEqual([
          { urlMap: URL_MAP, host: DOCS_HOST },
          { urlMap: URL_MAP, host: WWW_HOST },
        ]);
        expect(
          ctx.google.calls.findIndex(
            (call) => call.method === 'invalidateCache',
          ),
        ).toBeGreaterThan(
          ctx.google.calls.findIndex((call) => call.method === 'apply'),
        );
        expect(ctx.google.objectOperations()).toEqual([]);
        const log = await logOf(deploymentId);
        expect(log).toContain(`Cleared the cache for ${DOCS_HOST}`);
        expect(log).toContain(`Cleared the cache for ${WWW_HOST}`);
        return run;
      };

      const on = await toggle(
        DOCS.replace('publish: dist', 'publish: dist\n      spa: true'),
      );
      expect(on.title).toBe('Turn spa on for docs');
      const spa = lastUrlMap();
      expect(spa.path_matcher).toHaveLength(2);
      for (const matcher of spa.path_matcher) {
        expect(matcher.default_custom_error_response_policy).toEqual({
          error_response_rule: [
            {
              match_response_codes: ['404'],
              path: '/live/index.html',
              override_response_code: 200,
            },
          ],
          error_service: backendBucket(site.applicationId),
        });
      }

      const off = await toggle(DOCS);
      expect(off.title).toBe('Turn spa off for docs');
      for (const matcher of lastUrlMap().path_matcher) {
        expect(matcher).not.toHaveProperty(
          'default_custom_error_response_policy',
        );
      }
    });
  });

  /**
   * Static site Delete (story 53): the site's host
   * rules, and under `spa` its error policy, come off the Environment
   * network first by a network run, and the Delete stops there if that
   * fails. Then its bucket is always emptied through the Google client port
   * and destroyed with its backend bucket and the load balancer's grant; an
   * emptying that stops partway leaves the bucket named *Left*, "partly
   * emptied", and still destroys the backend bucket.
   */
  describe('Delete', () => {
    /** A site with a Domain on a made network, its bucket holding a deploy's files. */
    async function siteWithDomain() {
      const site = await appliedSite(
        DOCS.replace('publish: dist', 'publish: dist\n      spa: true'),
      );
      await madeNetwork();
      await addedDomain(site.applicationId, DOCS_HOST);
      const bucket = site.cloudBucketName!;
      ctx.google.holdObjects(
        bucket,
        'deployments/d1/index.html',
        'live/',
        'live/app.js',
        'live/index.html',
      );
      const [state] = await ctx.db
        .select()
        .from(infrastructureState)
        .where(eq(infrastructureState.applicationId, site.applicationId));
      ctx.google.calls.length = 0;
      return { site, bucket, stateId: state.infrastructureStateId };
    }

    const siteRow = async (applicationId: string) =>
      (
        await ctx.db
          .select()
          .from(application)
          .where(eq(application.applicationId, applicationId))
      )[0];
    const gone = (applicationId: string) =>
      poll(
        async () => ((await siteRow(applicationId)) ? undefined : true),
        'the site to go',
      );
    const incomplete = async (applicationId: string) => {
      const row = await poll(async () => {
        const found = await siteRow(applicationId);
        return found?.cloudDelete?.status === 'incomplete' ? found : undefined;
      }, 'the Delete to end incomplete');
      // Its run ended too, so nothing still writes to the row.
      await poll(async () => {
        const runs = await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.applicationId, applicationId));
        return runs.every((one) => !['pending', 'running'].includes(one.status))
          ? true
          : undefined;
      }, 'its run to end');
      return row.cloudDelete!;
    };
    const del = (applicationId: string) =>
      request(http)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', cookie);

    /** The steps the fake answered, in order: `tofu` runs, emptyings and searches. */
    const steps = () =>
      ctx.google.calls.flatMap((call: FakeGoogleCall) =>
        call.method === 'apply' || call.method === 'destroy'
          ? [`${call.method}:${call.kind}`]
          : call.method === 'emptyBucket'
            ? [`empty:${call.bucket}`]
            : call.method === 'findByName'
              ? ['search']
              : [],
      );
    const firstOfEach = (list: string[]) =>
      list.filter((step, index) => list.indexOf(step) === index);

    /** Every line the Delete's run logs, which goes with its row on a clean finish. */
    function capturedLog() {
      const lines: string[] = [];
      const spy = jest
        .spyOn(ctx.app.get(CloudRunsService), 'appendLog')
        .mockImplementation((_path: string, line: string) => {
          lines.push(line);
          return Promise.resolve();
        });
      return { lines, restore: () => spy.mockRestore() };
    }

    it('takes its host rule and error policy off the network first, then empties and destroys its bucket and backend bucket, and lists nothing left', async () => {
      const { site, bucket, stateId } = await siteWithDomain();
      const log = capturedLog();
      try {
        const res = await del(site.applicationId);
        expect(res.status).toBe(200);
        const [run] = await ctx.db
          .select()
          .from(deployment)
          .where(
            and(
              eq(deployment.applicationId, site.applicationId),
              eq(deployment.title, 'Delete'),
            ),
          );
        expect(run.description).toBe(
          `Removes its Domains from the Environment network, then empties its Cloud Storage bucket ${bucket}, then destroys everything in the Service's Infrastructure state in ${REGION}, then searches Google Cloud for anything left`,
        );
        expect(run.cloudRun).toMatchObject({
          kind: 'destroy',
          touchesNetwork: true,
        });
        await gone(site.applicationId);
      } finally {
        log.restore();
      }

      expect(firstOfEach(steps())).toEqual([
        'apply:network',
        `empty:${bucket}`,
        'destroy:destroy',
        'search',
      ]);
      // The network's run wrote the URL map without the site's host rule,
      // so its error policy went with it.
      expect(lastUrlMap().host_rule).toEqual([]);
      expect(lastUrlMap().path_matcher).toEqual([]);
      // One destroy of the whole state: bucket, backend bucket and grant.
      const destroys = ctx.google.calls.filter(
        (call) => call.method === 'destroy',
      );
      expect(destroys).toEqual([expect.objectContaining({ stateId })]);
      expect(destroys[0]).not.toHaveProperty('targets');
      expect(ctx.google.objectsOf(bucket)).toEqual([]);
      // The search looks for the backend bucket and the bucket by name.
      const searched = ctx.google.calls.flatMap((call) =>
        call.method === 'findByName'
          ? [[call.resourceType, call.namePrefix]]
          : [],
      );
      expect(searched).toEqual(
        expect.arrayContaining([
          [
            'google_compute_backend_bucket',
            `cloudgate-${idKey(site.applicationId)}`,
          ],
          ['google_storage_bucket', bucket],
        ]),
      );
      expect(log.lines).toContain(
        `🧹 [Cloud run] Emptying ${bucket}, the site's own bucket: every object`,
      );
      expect(log.lines).toContain(
        'Nothing was left in your Google Cloud project: every resource of this Service is gone.',
      );
      expect(
        await ctx.db
          .select()
          .from(infrastructureState)
          .where(eq(infrastructureState.infrastructureStateId, stateId)),
      ).toEqual([]);
    });

    it('stops with the network run’s reason when it fails, its bucket untouched', async () => {
      const { site, bucket } = await siteWithDomain();
      ctx.google.failRunFor(
        'network',
        'Error 403: Permission compute.urlMaps.update denied',
      );

      expect((await del(site.applicationId)).status).toBe(200);
      const record = await incomplete(site.applicationId);

      expect(record.unfinished).toMatch(
        /^The network step failed before docs was touched: .*compute\.urlMaps\.update denied/,
      );
      expect(record.left).toEqual([
        {
          type: 'compute.googleapis.com/UrlMap host rule',
          googleName: `${URL_MAP} ${DOCS_HOST}`,
          region: 'global',
          label: null,
        },
      ]);
      expect(steps()).not.toContain(`empty:${bucket}`);
      expect(steps()).not.toContain('destroy:destroy');
      expect(ctx.google.objectOperations()).toEqual([]);
      expect(ctx.google.objectsOf(bucket)).toEqual([
        'deployments/d1/index.html',
        'live/',
        'live/app.js',
        'live/index.html',
      ]);
    });

    it('names the bucket left, partly emptied, when emptying stops partway, still destroying the backend bucket; Retry empties it again and destroys it', async () => {
      const { site, bucket, stateId } = await siteWithDomain();
      ctx.google.stopEmptyingOf(bucket, {
        after: 1,
        code: '403',
        message: 'Permission storage.objects.delete denied',
      });
      // What the search then finds: the bucket, still holding files.
      ctx.google.find({
        resourceType: 'google_storage_bucket',
        name: bucket,
        id: bucket,
        labels: { 'cloudgate-state': idKey(stateId) },
      });

      expect((await del(site.applicationId)).status).toBe(200);
      const record = await incomplete(site.applicationId);

      expect(record.left).toEqual([
        {
          type: 'storage.googleapis.com/Bucket',
          googleName: bucket,
          region: REGION,
          label: `cloudgate-state=${idKey(stateId)}`,
          because: 'partly-emptied',
        },
      ]);
      expect(record.unfinished).toBeNull();
      // Only what serves the site went: its backend bucket and the grant.
      expect(
        ctx.google.calls.filter((call) => call.method === 'destroy'),
      ).toEqual([
        expect.objectContaining({
          stateId,
          targets: [
            'google_compute_backend_bucket.site',
            'google_storage_bucket_iam_member.load_balancer',
          ],
        }),
      ]);
      expect(ctx.google.objectsOf(bucket)).toHaveLength(3);
      // Its state is kept: it still describes the bucket.
      expect(
        await ctx.db
          .select()
          .from(infrastructureState)
          .where(eq(infrastructureState.infrastructureStateId, stateId)),
      ).toHaveLength(1);

      ctx.google.stopEmptyingOf(bucket, null);
      ctx.google.findNothing();
      ctx.google.calls.length = 0;
      const retried = await request(http)
        .post(`/applications/${site.applicationId}/delete/retry`)
        .set('Cookie', cookie);
      expect(retried.status).toBe(200);
      await gone(site.applicationId);

      expect(steps()).toContain(`empty:${bucket}`);
      const destroys = ctx.google.calls.filter(
        (call) => call.method === 'destroy',
      );
      expect(destroys).toEqual([expect.objectContaining({ stateId })]);
      expect(destroys[0]).not.toHaveProperty('targets');
      expect(ctx.google.objectsOf(bucket)).toEqual([]);
    });

    it('goes with its Environment’s Delete: its Domain off the network first, then its bucket emptied and its state destroyed, then the network; nothing of it is left', async () => {
      const { site, bucket, stateId } = await siteWithDomain();

      const res = await request(http)
        .delete(`/environments/${environmentId}`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      await poll(async () => {
        const [row] = await ctx.db
          .select()
          .from(environment)
          .where(eq(environment.environmentId, environmentId));
        return row ? undefined : true;
      }, 'the Environment to go');

      // Every Domain off the network, then the site's bucket emptied and
      // its state destroyed, then the network's own destroy.
      const index = (match: (call: FakeGoogleCall) => boolean) => {
        const found = ctx.google.calls.findIndex(match);
        expect(found).toBeGreaterThanOrEqual(0);
        return found;
      };
      const domainsOff = index(
        (call) => call.method === 'apply' && call.kind === 'network',
      );
      const emptied = index(
        (call) => call.method === 'emptyBucket' && call.bucket === bucket,
      );
      const siteDestroyed = index(
        (call) => call.method === 'destroy' && call.stateId === stateId,
      );
      const networkDestroyed = index(
        (call) => call.method === 'destroy' && call.stateId !== stateId,
      );
      expect(domainsOff).toBeLessThan(emptied);
      expect(emptied).toBeLessThan(siteDestroyed);
      expect(siteDestroyed).toBeLessThan(networkDestroyed);

      expect(ctx.google.objectsOf(bucket)).toEqual([]);
      expect(await siteRow(site.applicationId)).toBeUndefined();
      expect(
        await ctx.db
          .select()
          .from(infrastructureState)
          .where(eq(infrastructureState.infrastructureStateId, stateId)),
      ).toEqual([]);
    });
  });
});
