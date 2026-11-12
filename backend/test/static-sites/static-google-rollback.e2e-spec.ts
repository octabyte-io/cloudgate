import { exec } from 'node:child_process';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { and, eq, ne } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import {
  application,
  cloudAccount,
  deployment,
  environmentNetwork,
  webServerSettings,
} from '../../src/db/schema';
import type { Application, Deployment } from '../../src/db/schema';
import { CloudRunsService } from '../../src/deployment-queue/cloud-runs.service';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { SourceCloneService } from '../../src/git-providers/source-clone.service';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import {
  CUT_OFF_WHILE_COPYING,
  MIXED_LIVE_SITE,
} from '../../src/project-config/applier/google-static-deploys.service';
import { STATIC_SPREAD_CLOCK } from '../../src/project-config/applier/static-spread';
import type { SpreadClock } from '../../src/project-config/applier/static-spread';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
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
const URL_MAP = 'cloudgate-urls';
const DOCS_HOST = 'docs.acme.dev';
const WWW_HOST = 'www.docs.acme.dev';
const MINUTE = 60_000;

const DOCS = `version: 1
services:
  docs:
    kind: static
    source: { git: https://example.com/docs.git }
    build:
      publish: dist
`;

/** Each version's `dist`: a page, a folder's page, a script and, in v1 only, a stylesheet. */
const V1 = {
  'index.html': '<h1>Docs v1</h1>',
  'about/index.html': '<h1>About</h1>',
  'assets/app.js': 'v1()',
  'assets/old.css': 'body{}',
};
const V2 = {
  'index.html': '<h1>Docs v2</h1>',
  'about/index.html': '<h1>About</h1>',
  'assets/app.js': 'v2()',
};

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
 * The static clock, moved by hand: a wait between a copy's tries moves it
 * on at once, and a spec moves it past the 30-minute cap mid-copy.
 */
class HandClock implements SpreadClock {
  at = Date.UTC(2026, 9, 26, 9, 0, 0);
  now(): number {
    return this.at;
  }
  sleep(ms: number): Promise<void> {
    this.at += ms;
    return Promise.resolve();
  }
}

interface Point {
  rollbackId: string;
  deploymentId: string;
  version: number;
  folder: string | null;
}

/**
 * Stories 43–47 ("Deploy and rollback", "Failure and
 * cap"): a static site on Google Cloud rolls back, survives a passing
 * error, and never reads as done when it is not. A Rollback is a
 * Deployment of the Service with its own log, through the same per-Service
 * queue, that uploads nothing and copies a rollback point's kept folder
 * into `live/` in a deploy's order, then clears each Domain's cache. A copy
 * that stops partway is tried again; one that keeps failing, or meets the
 * 30-minute cap (a hand clock), ends the Deployment failed, the cache
 * still cleared and the "files from both versions" warning in its log and
 * on its page. A Deployment queued again after a restart runs the copy
 * again, from what `live/` holds then.
 *
 * Against `ctx.google`, whose Cloud Storage records each object operation
 * in order. Prior art: `static-google.e2e-spec.ts` and
 * `rollbacks/static-aws-rollback.e2e-spec.ts`.
 */
describe('Rolling back, retrying and failing a static site on Google Cloud (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let ownerId: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  let githubId: string;
  let cloudAccountId: string;
  const clock = new HandClock();
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
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: STATIC_SPREAD_CLOCK, useValue: clock },
      ],
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

  interface PlanBody {
    planId: string;
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

  const logOf = async (deploymentId: string) => {
    const res = await request(http)
      .get(`/deployments/${deploymentId}/logs`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.text;
  };

  /**
   * The site, made by its plan and set to build from acme/docs, with
   * rollbacks on or off as the Rollbacks tab's switch saves them.
   */
  async function madeSite({
    rollbacks,
  }: {
    rollbacks: boolean;
  }): Promise<Application> {
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
    const kept = await request(http)
      .patch(`/applications/${site.applicationId}`)
      .set('Cookie', cookie)
      .send({ rollbackActive: rollbacks });
    expect(kept.status).toBe(200);
    ctx.google.calls.length = 0;
    return site;
  }

  /** The made Environment network, as its create's run leaves it. */
  async function madeNetwork(): Promise<void> {
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
  }

  /** Adds a Domain and waits for its network run. */
  async function addedDomain(applicationId: string, host: string) {
    const res = await request(http)
      .post('/domains')
      .set('Cookie', cookie)
      .send({ applicationId, host });
    expect([res.status, res.body]).toEqual([201, expect.anything()]);
    const { deploymentId } = res.body as { deploymentId: string };
    expect((await settledDeployment(deploymentId)).status).toBe('done');
  }

  /** A real-shaped, signed `push` of acme/docs's main, its Deployment once ended. */
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

  /** Pushes v1, then v2; both end done. */
  async function pushedTwice(applicationId: string) {
    files = V1;
    const first = await push(applicationId, 'a'.repeat(40));
    expect(first.status).toBe('done');
    files = V2;
    const second = await push(applicationId, 'b'.repeat(40), [
      first.deploymentId,
    ]);
    expect(second.status).toBe('done');
    return { first, second };
  }

  const pointsOf = async (applicationId: string): Promise<Point[]> => {
    const res = await request(http)
      .get(`/applications/${applicationId}/rollbacks`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as Point[];
  };

  const rollBack = async (rollbackId: string) => {
    const res = await request(http)
      .post(`/rollbacks/${rollbackId}/rollback`)
      .set('Cookie', cookie);
    expect(res.status).toBe(202);
    return (res.body as { deploymentId: string }).deploymentId;
  };

  /** What `live/` holds: each object's name and content's MD5. */
  const liveOf = (bucket: string) =>
    Object.fromEntries(
      ctx.google
        .objectsOf(bucket)
        .filter((name) => name.startsWith('live/'))
        .map((name) => [name, ctx.google.objectOf(bucket, name)?.md5Hash]),
    );

  /** What `live/` holds once `folder`'s files are copied into it. */
  const liveFrom = (bucket: string, folder: string) => {
    const at = (path: string) =>
      ctx.google.objectOf(bucket, `deployments/${folder}/${path}`)?.md5Hash;
    const pages = Object.keys(V1).filter((path) => path.endsWith('.html'));
    const live: Record<string, string | undefined> = {};
    for (const name of ctx.google.objectsOf(bucket)) {
      const prefix = `deployments/${folder}/`;
      if (!name.startsWith(prefix)) continue;
      const path = name.slice(prefix.length);
      live[`live/${path}`] = at(path);
      if (pages.includes(path)) {
        live[`live/${path.slice(0, -'index.html'.length)}`] = at(path);
      }
    }
    return live;
  };

  it('rolls back as a Deployment of its own that uploads nothing, copies the point’s folder into live/ in a deploy’s order, and clears each Domain', async () => {
    const site = await madeSite({ rollbacks: true });
    const bucket = site.cloudBucketName!;
    await madeNetwork();
    await addedDomain(site.applicationId, DOCS_HOST);
    await addedDomain(site.applicationId, WWW_HOST);
    const { first, second } = await pushedTwice(site.applicationId);

    const point = (await pointsOf(site.applicationId)).find(
      (one) => one.deploymentId === first.deploymentId,
    )!;
    expect(point.folder).toBe(first.deploymentId);
    ctx.google.calls.length = 0;
    execMock.execAsync.mockClear();

    const rollbackId = await rollBack(point.rollbackId);
    const run = await settledDeployment(rollbackId);

    expect(run).toMatchObject({
      status: 'done',
      applicationId: site.applicationId,
      title: `Rollback to v${point.version}`,
      cloudRun: expect.objectContaining({
        kind: 'static-rollback',
        stateKey: `application:${site.applicationId}`,
        touchesNetwork: false,
        rollbackFolder: first.deploymentId,
      }) as unknown,
    });
    expect(liveOf(bucket)).toEqual(liveFrom(bucket, first.deploymentId));
    // Nothing uploaded: the changed script and stylesheet first, then the
    // changed page and its `/`-named copy; nothing is deleted from live/,
    // since v2 lacks nothing v1 has.
    const folder = `deployments/${first.deploymentId}/`;
    const operations = ctx.google.objectOperations();
    expect(operations.filter((one) => one.op === 'upload')).toEqual([]);
    expect(operations).toEqual([
      expect.objectContaining({ op: 'copy', from: `${folder}assets/app.js` }),
      expect.objectContaining({ op: 'copy', from: `${folder}assets/old.css` }),
      expect.objectContaining({ op: 'copy', to: 'live/index.html' }),
      expect.objectContaining({ op: 'copy', to: 'live/' }),
    ]);
    expect(ctx.google.cacheClears()).toEqual([
      { urlMap: URL_MAP, host: DOCS_HOST },
      { urlMap: URL_MAP, host: WWW_HOST },
    ]);
    expect(
      ctx.google.calls.findIndex((call) => call.method === 'invalidateCache'),
    ).toBeGreaterThan(
      ctx.google.calls.findLastIndex((call) => call.method === 'copyObject'),
    );
    // No network run, no `tofu`, nothing checked out.
    expect(
      ctx.google.calls.filter((call) =>
        ['plan', 'apply', 'destroy'].includes(call.method),
      ),
    ).toEqual([]);
    const commands = execMock.execAsync.mock.calls.map(([command]) => command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('Initializing deployment');
    // Both points keep their folders, and the Rollback took no point.
    expect(await pointsOf(site.applicationId)).toHaveLength(2);
    expect(
      ctx.google
        .objectsOf(bucket)
        .filter((name) => name.startsWith('deployments/'))
        .map((name) => name.split('/')[1])
        .filter((one, index, all) => all.indexOf(one) === index)
        .sort(),
    ).toEqual([first.deploymentId, second.deploymentId].sort());

    // Its own log.
    const log = await logOf(rollbackId);
    const at = (text: string) => {
      const index = log.indexOf(text);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      at(
        `⏪ [Rollback] Rolling docs back to the files of Deployment ${first.deploymentId} on Cloud Storage + Cloud CDN in Cloud account Production Google (europe-west1)`,
      ),
      at("the backend bucket's settings stay as the Project config says"),
      at(`📁 [Files] This version's files are in gs://${bucket}/${folder}`),
      at('🔁 [Copy] Copying into the live site (4 changed)'),
      at(`🌐 [Clear] Cleared the cache for ${DOCS_HOST}`),
      at(`🌐 [Clear] Cleared the cache for ${WWW_HOST}`),
      at(
        `✅ [Cloud run] docs serves the files of Deployment ${first.deploymentId} again`,
      ),
      at('🏁 [Cloud run] Done after'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(log).not.toContain('[Upload]');
    expect(log).not.toContain('[Build]');
  });

  it('keeps each rollback point’s folder while rollbacks are on', async () => {
    const kept = await madeSite({ rollbacks: true });
    const { first, second } = await pushedTwice(kept.applicationId);
    const folders = (bucket: string) =>
      ctx.google
        .objectsOf(bucket)
        .filter((name) => !name.startsWith('live/'))
        .map((name) => name.split('/').slice(0, 2).join('/'))
        .filter((one, index, all) => all.indexOf(one) === index)
        .sort();
    expect(folders(kept.cloudBucketName!)).toEqual(
      [
        `deployments/${first.deploymentId}`,
        `deployments/${second.deploymentId}`,
      ].sort(),
    );
    expect(
      (await pointsOf(kept.applicationId)).map((point) => point.folder).sort(),
    ).toEqual([first.deploymentId, second.deploymentId].sort());
  });

  it('leaves only live/ after each deploy with rollbacks off', async () => {
    const site = await madeSite({ rollbacks: false });
    const bucket = site.cloudBucketName!;
    const { second } = await pushedTwice(site.applicationId);

    // Each Deployment's own folder went once copied: only live/ is left.
    expect(
      ctx.google.objectsOf(bucket).filter((name) => !name.startsWith('live/')),
    ).toEqual([]);
    expect(Object.keys(liveOf(bucket)).sort()).toEqual([
      'live/',
      'live/about/',
      'live/about/index.html',
      'live/assets/app.js',
      'live/index.html',
    ]);
    expect(await pointsOf(site.applicationId)).toEqual([]);
    expect(await logOf(second.deploymentId)).toContain(
      '🧹 [Files] Removed 1 older folder from the bucket',
    );
  });

  it('tries a copy that fails once again, and the Deployment ends done with every file live', async () => {
    const site = await madeSite({ rollbacks: true });
    const bucket = site.cloudBucketName!;
    files = V1;
    // The first copy into live/ meets a passing error.
    ctx.google.refuseSome('copyObject', '503', 'Backend Error');

    const run = await push(site.applicationId, 'a'.repeat(40));

    expect(run.status).toBe('done');
    expect(liveOf(bucket)).toEqual(liveFrom(bucket, run.deploymentId));
    const log = await logOf(run.deploymentId);
    const tried = log.indexOf(
      '⚠️ [Copy] The copy stopped partway (live/assets/',
    );
    expect(tried).toBeGreaterThanOrEqual(0);
    expect(log.slice(tried)).toContain(
      ': 503: Backend Error); trying again in 5s (try 2 of 3)',
    );
    expect(
      log.indexOf('🔁 [Copy] Copying into the live site', tried),
    ).toBeGreaterThan(tried);
    expect(log).toContain('🏁 [Cloud run] Done after');
    expect(log).not.toContain(MIXED_LIVE_SITE);
    // From its copy on, a restart would have cut it off with the warning.
    expect(run.cloudRun?.cutOff).toBe(CUT_OFF_WHILE_COPYING);
  });

  it('ends a Deployment whose copy keeps failing failed, still clears each Domain’s cache, and warns of files from both versions', async () => {
    const site = await madeSite({ rollbacks: true });
    await madeNetwork();
    await addedDomain(site.applicationId, DOCS_HOST);
    await addedDomain(site.applicationId, WWW_HOST);
    files = V1;
    const first = await push(site.applicationId, 'a'.repeat(40));
    expect(first.status).toBe('done');
    ctx.google.calls.length = 0;

    // v2's script is copied; every copy after it is refused.
    files = V2;
    ctx.google.refuseSome('copyObject', '503', 'Backend Error', {
      after: 1,
      times: 99,
    });
    const run = await push(site.applicationId, 'b'.repeat(40), [
      first.deploymentId,
    ]);

    expect(run.status).toBe('error');
    expect(run.description).toBe(
      `The copy into the live site stopped after 3 tries (live/index.html: 503: Backend Error). ${MIXED_LIVE_SITE}`,
    );
    // Still cleared, once per Domain, after the last try.
    expect(ctx.google.cacheClears()).toEqual([
      { urlMap: URL_MAP, host: DOCS_HOST },
      { urlMap: URL_MAP, host: WWW_HOST },
    ]);
    expect(
      ctx.google.calls.findIndex((call) => call.method === 'invalidateCache'),
    ).toBeGreaterThan(
      ctx.google.calls.findLastIndex((call) => call.method === 'copyObject'),
    );
    // The failed Deployment took no rollback point.
    expect(
      (await pointsOf(site.applicationId)).map((point) => point.deploymentId),
    ).toEqual([first.deploymentId]);

    const log = await logOf(run.deploymentId);
    expect(log.match(/🔁 \[Copy\] Copying into the live site/g)).toHaveLength(
      3,
    );
    expect(log).toContain('(try 2 of 3)');
    expect(log).toContain('(try 3 of 3)');
    expect(log).toContain(
      '🌐 [Clear] The copy did not finish; clearing the cache anyway',
    );
    expect(log).toContain(`🌐 [Clear] Cleared the cache for ${DOCS_HOST}`);
    expect(log).toContain(MIXED_LIVE_SITE);
    expect(log).not.toContain('🏁 [Cloud run] Done after');
    expect(log).not.toContain('serves the files of this Deployment');
  });

  it('ends a Deployment cut off by a restart partway through its copy with the files-from-both-versions warning, and runs the copy again for one queued again, from what the cut-off run left in live/', async () => {
    const site = await madeSite({ rollbacks: true });
    const bucket = site.cloudBucketName!;
    const { second } = await pushedTwice(site.applicationId);
    const point = (await pointsOf(site.applicationId)).find(
      (one) => one.deploymentId === second.deploymentId,
    )!;
    const deployments = ctx.app.get(DeploymentsService);
    const shape = {
      stateKey: `application:${site.applicationId}`,
      environmentId,
      touchesNetwork: false,
    };

    // A push's run was cut off by the restart partway through its copy:
    // its files are uploaded, its script is already in live/, and one file
    // of its own is there that v2 lacks. Its row holds what its copy
    // recorded as it began.
    const cutOff = await deployments.recordApplicationCloudRun({
      applicationId: site.applicationId,
      appName: site.appName,
      title: 'Manual deployment',
      description: 'Deploying',
    });
    await ctx.db
      .update(deployment)
      .set({
        status: 'running',
        cloudRun: {
          kind: 'static-deploy',
          ...shape,
          cutOff: CUT_OFF_WHILE_COPYING,
        },
      })
      .where(eq(deployment.deploymentId, cutOff.deploymentId));
    const v3 = `deployments/${cutOff.deploymentId}/`;
    ctx.google.putObject(bucket, `${v3}assets/app.js`, 'v3()');
    ctx.google.putObject(bucket, `${v3}assets/new.js`, 'new()');
    ctx.google.putObject(bucket, 'live/assets/app.js', 'v3()');
    ctx.google.putObject(bucket, 'live/assets/new.js', 'new()');
    // Queued behind it: a Rollback to v2, not yet begun.
    const queued = await deployments.recordApplicationCloudRun({
      applicationId: site.applicationId,
      appName: site.appName,
      title: `Rollback to v${point.version}`,
      description: 'Rolling back',
    });
    await ctx.db
      .update(deployment)
      .set({
        status: 'pending',
        cloudRun: {
          kind: 'static-rollback',
          ...shape,
          rollbackFolder: second.deploymentId,
        },
      })
      .where(eq(deployment.deploymentId, queued.deploymentId));
    ctx.google.calls.length = 0;

    // Cloudgate starts again.
    await ctx.app.get(CloudRunsService).settleAtStartUp();

    const cut = await settledDeployment(cutOff.deploymentId);
    expect(cut).toMatchObject({
      status: 'error',
      description: `Cut off by a Cloudgate restart while copying into the live site, and not run again. ${MIXED_LIVE_SITE}`,
    });
    expect(await logOf(cutOff.deploymentId)).toContain(CUT_OFF_WHILE_COPYING);
    const resumed = await settledDeployment(queued.deploymentId);
    expect(resumed.status).toBe('done');
    // Its copy listed live/ again: the cut-off run's script is put back to
    // v2's, then its extra file deleted, last.
    expect(liveOf(bucket)).toEqual(liveFrom(bucket, second.deploymentId));
    expect(ctx.google.objectOperations()).toEqual([
      {
        op: 'copy',
        bucket,
        from: `deployments/${second.deploymentId}/assets/app.js`,
        to: 'live/assets/app.js',
      },
      { op: 'delete', bucket, name: 'live/assets/new.js' },
      // The clean-up: the cut-off run's folder is no rollback point.
      { op: 'delete', bucket, name: `${v3}assets/app.js` },
      { op: 'delete', bucket, name: `${v3}assets/new.js` },
    ]);
    const log = await logOf(queued.deploymentId);
    expect(log).toContain('🔁 [Copy] Copying into the live site (1 changed)');
    expect(log).toContain('🧹 [Copy] Removed 1 old file');
    expect(log).toContain(
      `✅ [Cloud run] docs serves the files of Deployment ${second.deploymentId} again`,
    );
  });

  it('ends a Deployment that reaches the 30-minute cap mid-copy failed, never done', async () => {
    const site = await madeSite({ rollbacks: true });
    files = V1;
    // Google takes 31 minutes over the first copy into live/.
    ctx.google.whenCalled('copyObject', (count) => {
      if (count === 1) clock.at += 31 * MINUTE;
    });

    const run = await push(site.applicationId, 'a'.repeat(40));

    expect(run.status).toBe('error');
    expect(run.description).toBe(
      `The Deployment reached its 30-minute cap while copying into the live site. ${MIXED_LIVE_SITE}`,
    );
    const log = await logOf(run.deploymentId);
    expect(log).toContain(MIXED_LIVE_SITE);
    expect(log).not.toContain('trying again');
    expect(log).not.toContain('🏁 [Cloud run] Done after');
    expect(log).not.toContain('still spreading');
    // It took no rollback point.
    expect(await pointsOf(site.applicationId)).toEqual([]);
  });
});
