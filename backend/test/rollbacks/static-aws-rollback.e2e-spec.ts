import { exec } from 'node:child_process';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { and, eq, ne } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { application, cloudAccount, deployment } from '../../src/db/schema';
import type { Deployment } from '../../src/db/schema';
import { SourceCloneService } from '../../src/git-providers/source-clone.service';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
import {
  STATIC_SPREAD_CLOCK,
  STILL_SPREADING,
} from '../../src/project-config/applier/static-spread';
import type { SpreadClock } from '../../src/project-config/applier/static-spread';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
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
 * While `held`, a sleep waits for {@link release} instead, which is how a
 * push's run is kept in its wait while a Rollback is asked for.
 */
class HandClock implements SpreadClock {
  at = Date.UTC(2026, 9, 17, 9, 0, 0);
  held = false;
  sleeping = 0;
  private waiters: (() => void)[] = [];
  now(): number {
    return this.at;
  }
  sleep(ms: number): Promise<void> {
    this.at += ms;
    if (!this.held) return Promise.resolve();
    this.sleeping += 1;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    this.held = false;
    for (const wake of this.waiters.splice(0)) wake();
  }
}

interface Point {
  rollbackId: string;
  deploymentId: string;
  version: number;
  image: string | null;
  fullContext: unknown;
  folder: string | null;
}

/**
 * With rollbacks on, every push to a `static` site on AWS leaves a
 * rollback point naming its own folder of the site's bucket. Rolling back
 * to one queues a Deployment of the Service that builds and uploads
 * nothing: it switches the distribution's origin back to that folder,
 * makes one `/*` invalidation and waits as a deploy does, 30-minute cap
 * included (a hand clock), with its own log. It runs under the Service's
 * Cloud run state, so it never runs beside a push's run. A point's folder
 * survives every later clean-up until the point is removed, which deletes
 * it.
 *
 * Prior art: `rollbacks.e2e-spec.ts` (a Server's rollback, unchanged) and
 * `static-sites/static-aws-deploy.e2e-spec.ts` (the push this rolls back).
 */
describe('Rolling a static site on AWS back (e2e)', () => {
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
    const clones = ctx.app.get<SourceCloneService>(SourceCloneService);
    jest
      .spyOn(clones, 'cloneProgram')
      .mockImplementation((_source, outputPath) => {
        const at = (file: string) => `'${nodePath.join(outputPath, file)}'`;
        return Promise.resolve({
          command: [
            `rm -rf '${outputPath}' && mkdir -p ${at('dist')} ;`,
            `printf '<h1>Docs</h1>' > ${at('dist/index.html')} ;`,
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
    clock.release();
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

  const rowOf = async (deploymentId: string) => {
    const [row] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId));
    return row;
  };

  const settledDeployment = (deploymentId: string) =>
    poll(async () => {
      const row = await rowOf(deploymentId);
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

  /** The site, made by its plan, push-deployed from acme/docs, rollbacks on. */
  async function madeSite() {
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
    // Keep rollback points, as the Rollbacks tab's switch saves it.
    const kept = await request(http)
      .patch(`/applications/${site.applicationId}`)
      .set('Cookie', cookie)
      .send({ rollbackActive: true });
    expect(kept.status).toBe(200);
    ctx.cloud.calls.length = 0;
    ctx.objectStorage.calls.length = 0;
    return site;
  }

  /** A signed `push` of acme/docs's main; its Deployment once recorded. */
  async function startPush(
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
    return poll(async () => {
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
  }

  async function push(
    applicationId: string,
    after: string,
    seen: readonly string[] = [],
  ): Promise<Deployment> {
    const queued = await startPush(applicationId, after, seen);
    const ended = await settledDeployment(queued.deploymentId);
    expect(ended.status).toBe('done');
    return ended;
  }

  const pointsOf = async (applicationId: string): Promise<Point[]> => {
    const res = await request(http)
      .get(`/applications/${applicationId}/rollbacks`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as Point[];
  };

  const pointFor = async (applicationId: string, deploymentId: string) => {
    const found = (await pointsOf(applicationId)).find(
      (point) => point.deploymentId === deploymentId,
    );
    if (!found) throw new Error(`No rollback point for ${deploymentId}`);
    return found;
  };

  const rollBack = async (rollbackId: string) => {
    const res = await request(http)
      .post(`/rollbacks/${rollbackId}/rollback`)
      .set('Cookie', cookie);
    expect(res.status).toBe(202);
    return (res.body as { deploymentId: string }).deploymentId;
  };

  const logOf = async (deploymentId: string) => {
    const res = await request(http)
      .get(`/deployments/${deploymentId}/logs`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.text;
  };

  const switches = () =>
    ctx.cloud.calls.flatMap((call) =>
      call.method === 'cloudFrontSwitchOrigin' ? [call.originPath] : [],
    );

  it('queues a Deployment that builds nothing, switches back to the earlier folder, clears and ends done once CloudFront has spread', async () => {
    const site = await madeSite();
    const bucket = site.cloudBucketName!;
    const first = await push(site.applicationId, 'a'.repeat(40));
    const second = await push(site.applicationId, 'b'.repeat(40), [
      first.deploymentId,
    ]);

    // Each push left a point naming its own folder, with no image.
    const points = await pointsOf(site.applicationId);
    expect(points).toEqual([
      expect.objectContaining({
        deploymentId: second.deploymentId,
        folder: second.deploymentId,
        image: null,
        fullContext: null,
      }),
      expect.objectContaining({
        deploymentId: first.deploymentId,
        folder: first.deploymentId,
        image: null,
        fullContext: null,
      }),
    ]);
    // The second push's clean-up spared the first's folder.
    expect(ctx.objectStorage.foldersOf(bucket)).toEqual(
      [first.deploymentId, second.deploymentId].sort(),
    );

    ctx.cloud.calls.length = 0;
    ctx.objectStorage.calls.length = 0;
    execMock.execAsync.mockClear();
    // CloudFront takes 2 minutes to spread the switch back, 1 to clear.
    ctx.cloud.holdDistribution(8);
    ctx.cloud.holdInvalidation(4);
    const point = points[1];
    const rollbackId = await rollBack(point.rollbackId);
    const run = await settledDeployment(rollbackId);
    expect(run).toMatchObject({
      status: 'done',
      applicationId: site.applicationId,
      title: `Rollback to v${point.version}`,
      cloudRun: expect.objectContaining({
        kind: 'static-rollback',
        stateKey: `application:${site.applicationId}`,
        rollbackFolder: first.deploymentId,
      }) as unknown,
    });

    // Back on the first push's files: one switch, one `/*`, no tofu.
    const [after] = await ctx.db.select().from(application);
    expect(ctx.cloud.originPathOf(after.cloudDistributionId!)).toBe(
      `/deployments/${first.deploymentId}`,
    );
    expect(after.cloudLiveFolder).toBe(first.deploymentId);
    expect(
      ctx.cloud.calls.filter((call) =>
        ['cloudFrontSwitchOrigin', 'cloudFrontCreateInvalidation'].includes(
          call.method,
        ),
      ),
    ).toEqual([
      {
        method: 'cloudFrontSwitchOrigin',
        distributionId: after.cloudDistributionId,
        originId: 'site-bucket',
        originPath: `/deployments/${first.deploymentId}`,
      },
      {
        method: 'cloudFrontCreateInvalidation',
        distributionId: after.cloudDistributionId,
        paths: ['/*'],
        callerReference: rollbackId,
      },
    ]);
    expect(
      ctx.cloud.calls.filter((call) =>
        ['plan', 'apply', 'destroy'].includes(call.method),
      ),
    ).toEqual([]);
    // Nothing built, checked out or uploaded.
    // (The one command is its log file being made.)
    const commands = execMock.execAsync.mock.calls.map(([command]) => command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('Initializing deployment');
    expect(
      ctx.objectStorage.calls.filter((call) => call.call === 'uploadFolder'),
    ).toEqual([]);
    // Both folders are still rollback points, and no new point was taken.
    expect(ctx.objectStorage.foldersOf(bucket)).toEqual(
      [first.deploymentId, second.deploymentId].sort(),
    );
    expect(await pointsOf(site.applicationId)).toHaveLength(2);

    // Its own log, each step with its time.
    const log = await logOf(rollbackId);
    const at = (text: string) => {
      const index = log.indexOf(text);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      at(
        `⏪ [Rollback] Rolling docs back to the files of Deployment ${first.deploymentId}`,
      ),
      at("the distribution's settings stay as the Project config says"),
      at('🔀 [Switch] Switched to this version, spreading…'),
      at("🧽 [Clear] Clearing CloudFront's cache of /*"),
      at('✅ [Clear] Cache cleared after 1m00s'),
      at('✅ [Spread] Deployed after 2m00s'),
      at(
        `✅ [Cloud run] docs serves the files of Deployment ${first.deploymentId} again`,
      ),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(log).not.toContain('[Upload]');
    expect(log).not.toContain('[Build]');
  });

  it('ends a Rollback done with the "still spreading" warning at 30 minutes, as a deploy', async () => {
    const site = await madeSite();
    const first = await push(site.applicationId, 'a'.repeat(40));
    await push(site.applicationId, 'b'.repeat(40), [first.deploymentId]);

    ctx.cloud.holdDistribution();
    const rollbackId = await rollBack(
      (await pointFor(site.applicationId, first.deploymentId)).rollbackId,
    );
    const run = await settledDeployment(rollbackId);
    expect(run.status).toBe('done');
    const log = await logOf(rollbackId);
    expect(log).toContain(STILL_SPREADING);
    expect(log).not.toContain('[Spread] Deployed after');
  });

  it('never runs a Rollback beside a push of the same Service: it waits for the push to end', async () => {
    const site = await madeSite();
    const first = await push(site.applicationId, 'a'.repeat(40));
    const point = await pointFor(site.applicationId, first.deploymentId);
    ctx.cloud.calls.length = 0;

    // The next push's run is held in its wait for CloudFront.
    clock.held = true;
    clock.sleeping = 0;
    ctx.cloud.holdDistribution();
    const second = await startPush(site.applicationId, 'b'.repeat(40), [
      first.deploymentId,
    ]);
    await poll(
      () => Promise.resolve(clock.sleeping > 0 ? true : undefined),
      'the push to wait for CloudFront',
    );
    expect(switches()).toEqual([`/deployments/${second.deploymentId}`]);

    const rollbackId = await rollBack(point.rollbackId);
    // It waits behind the push: queued, nothing switched.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await rowOf(rollbackId)).status).toBe('pending');
    expect((await rowOf(second.deploymentId)).status).toBe('running');
    expect(switches()).toEqual([`/deployments/${second.deploymentId}`]);

    // CloudFront spreads; the push ends, then the Rollback runs.
    ctx.cloud.holdDistribution(0);
    clock.release();
    const pushed = await settledDeployment(second.deploymentId);
    const rolled = await settledDeployment(rollbackId);
    expect(pushed.status).toBe('done');
    expect(rolled.status).toBe('done');
    expect(Date.parse(rolled.startedAt!)).toBeGreaterThanOrEqual(
      Date.parse(pushed.finishedAt!),
    );
    expect(switches()).toEqual([
      `/deployments/${second.deploymentId}`,
      `/deployments/${first.deploymentId}`,
    ]);
    const [after] = await ctx.db.select().from(application);
    expect(after.cloudLiveFolder).toBe(first.deploymentId);
  });

  it("keeps each point's folder through later clean-ups and deletes it with its point", async () => {
    const site = await madeSite();
    const bucket = site.cloudBucketName!;
    const first = await push(site.applicationId, 'a'.repeat(40));
    const second = await push(site.applicationId, 'b'.repeat(40), [
      first.deploymentId,
    ]);
    // A Deployment that failed partway through its upload left this.
    ctx.objectStorage.put(
      bucket,
      'object',
      'deployments/half-uploaded/index.html',
    );
    const third = await push(site.applicationId, 'c'.repeat(40), [
      first.deploymentId,
      second.deploymentId,
    ]);
    // Every point's folder is spared; only the stray one went.
    expect(ctx.objectStorage.foldersOf(bucket)).toEqual(
      [first.deploymentId, second.deploymentId, third.deploymentId].sort(),
    );

    // Removing a point removes its folder.
    const removed = await request(http)
      .delete(
        `/rollbacks/${(await pointFor(site.applicationId, first.deploymentId)).rollbackId}`,
      )
      .set('Cookie', cookie);
    expect(removed.status).toBe(200);
    expect(ctx.objectStorage.foldersOf(bucket)).toEqual(
      [second.deploymentId, third.deploymentId].sort(),
    );

    // A point whose folder cannot be deleted is kept, and says why.
    ctx.objectStorage.makeUnreadable(bucket);
    const secondPoint = await pointFor(site.applicationId, second.deploymentId);
    const refused = await request(http)
      .delete(`/rollbacks/${secondPoint.rollbackId}`)
      .set('Cookie', cookie);
    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toContain(
      `deployments/${second.deploymentId}/`,
    );
    expect(await pointsOf(site.applicationId)).toHaveLength(2);
  });

  it('keeps the live folder when its point is removed, until a later Deployment switches away', async () => {
    const site = await madeSite();
    const bucket = site.cloudBucketName!;
    const first = await push(site.applicationId, 'a'.repeat(40));
    const removed = await request(http)
      .delete(
        `/rollbacks/${(await pointFor(site.applicationId, first.deploymentId)).rollbackId}`,
      )
      .set('Cookie', cookie);
    expect(removed.status).toBe(200);
    // The site serves it, so it stays.
    expect(ctx.objectStorage.foldersOf(bucket)).toEqual([first.deploymentId]);
    expect(await pointsOf(site.applicationId)).toEqual([]);

    const second = await push(site.applicationId, 'b'.repeat(40), [
      first.deploymentId,
    ]);
    expect(ctx.objectStorage.foldersOf(bucket)).toEqual([second.deploymentId]);
  });

  it('fails a Rollback whose files are gone without switching, so the site keeps serving what it serves', async () => {
    const site = await madeSite();
    const first = await push(site.applicationId, 'a'.repeat(40));
    const second = await push(site.applicationId, 'b'.repeat(40), [
      first.deploymentId,
    ]);
    const point = await pointFor(site.applicationId, first.deploymentId);
    // Removed by hand in the AWS console.
    await ctx.objectStorage.deleteFolder(
      {
        endpoint: null,
        region: REGION,
        bucket: site.cloudBucketName!,
        credential: {
          accessKeyId: 'x',
          secretAccessKey: 'x',
          sessionToken: 'x',
        },
        pathStyle: false,
      },
      `deployments/${first.deploymentId}/`,
    );
    ctx.cloud.calls.length = 0;

    const run = await settledDeployment(await rollBack(point.rollbackId));
    expect(run.status).toBe('error');
    expect(run.description).toContain("This version's files are no longer in");
    expect(switches()).toEqual([]);
    const [after] = await ctx.db.select().from(application);
    expect(after.cloudLiveFolder).toBe(second.deploymentId);
  });
});
