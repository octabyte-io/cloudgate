import * as fs from 'node:fs';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { CLEAN_DELETE_LINE } from '../../src/cloud-accounts/aws/delete-check';
import { STATIC_SERVING_ADDRESSES } from '../../src/cloud-accounts/aws/definitions/static-definition';
import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { deploymentLogsDirectoryOn } from '../../src/deployment-engine/deployment-engine.paths';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import {
  application,
  auditLog,
  certificateDeletion,
  cloudAccount,
  deployment,
  environment,
} from '../../src/db/schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { fakeBinShell } from '../utils/fake-bin-shell';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

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

const TWO_SITES = `${DOCS}  blog:
    kind: static
    source: { git: https://example.com/blog.git }
    build:
      publish: public
`;

const NO_SERVICES = 'version: 1\nservices: {}\n';

interface Step {
  action: string;
  configName?: string;
  kind?: string;
  cloudRead?: { status: 'reading' | 'read' | 'failed' };
}

interface PlanBody {
  planId: string;
  steps: Step[];
}

interface Applied {
  results: { deploy: { deploymentId: string } | null }[];
}

/**
 * The platform host's `rm`, which keeps a copy of a Deployment log directory
 * it removes: a finished Delete reclaims its Service's logs, and the spec
 * reads what the Delete's own run wrote there afterwards.
 */
const KEEPING_RM = `#!/bin/bash
for arg in "$@"; do
  case "$arg" in
    */logs/*) mkdir -p "$CLOUDGATE_DIRECTORY/kept-logs" && cp -r "$arg" "$CLOUDGATE_DIRECTORY/kept-logs/" ;;
  esac
done
exec /bin/rm "$@"
`;

interface LeftBody {
  type: string;
  awsId: string;
  region: string;
  tag: string | null;
  because?: string;
}

/**
 * A `static` site's own bucket on AWS is a rebuildable copy of its
 * build, so its Delete never keeps it (rule 3). The site's Service
 * Delete, a Plan destroy, or an Environment Delete runs the destroy-only
 * Cloud run, which first empties the bucket through the object-storage port
 * (old versions and delete markers included), then destroys everything in
 * the site's state. There is no "also delete its files" box. An emptying
 * that stops partway still finishes: what serves the site goes, and the
 * bucket is *Left*, "partly emptied", so the Delete is incomplete.
 */
describe('Deleting a static site on AWS (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };
  const shell = fakeBinShell('static-aws-delete', { rm: KEEPING_RM });

  beforeAll(async () => {
    shell.setUp();
    ctx = await createTestApp({
      overrideProviders: [
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        { provide: RemoteExecService, useValue: shell.execMock },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
    shell.tearDown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    const res = await request(http).post('/api/auth/sign-up/email').send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
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

    ctx.cloud.replayPlanFor('static', 'static-create');
  });

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  const apply = (
    planId: string,
    body: { confirmDestroy?: string[]; deleteFilesOf?: string[] } = {},
  ) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId, ...body });

  /** The open plan once no step is still reading AWS. */
  async function readPlan(): Promise<PlanBody> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const res = await request(http)
        .get(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      const found = (res.body as { plan: PlanBody }).plan;
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading AWS');
  }

  async function until(done: () => Promise<boolean>, what: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await done()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${what} did not happen`);
  }

  /** A Deployment once its Cloud run has ended. */
  async function ended(deploymentId: string) {
    let row: typeof deployment.$inferSelect | undefined;
    await until(async () => {
      [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      return !row || (row.status !== 'pending' && row.status !== 'running');
    }, 'The Cloud run ending');
    return row ?? null;
  }

  const rowOf = async (applicationId: string) =>
    (
      await ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, applicationId))
    )[0];

  /** Until its row is gone, or its Delete is incomplete. */
  async function settled(applicationId: string) {
    await until(async () => {
      const row = await rowOf(applicationId);
      return !row || row.cloudDelete?.status === 'incomplete';
    }, "The site's Delete ending");
    return (await rowOf(applicationId)) ?? null;
  }

  const stateOf = async (applicationId: string) =>
    (
      await ctx.db
        .select()
        .from(infrastructureState)
        .where(eq(infrastructureState.applicationId, applicationId))
    )[0] ?? null;

  const destroys = () =>
    ctx.cloud.calls.filter((call) => call.method === 'destroy');

  /** Plans and applies the sites' creates, and waits for their Cloud runs. */
  async function made(text = DOCS) {
    expect((await save(text)).status).toBe(201);
    const read = await readPlan();
    const applied = await apply(read.planId);
    expect(applied.status).toBe(200);
    for (const result of (applied.body as Applied).results) {
      expect((await ended(result.deploy!.deploymentId))?.status).toBe('done');
    }
    const rows = await ctx.db.select().from(application);
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;
    ctx.objectStorage.calls.length = 0;
    const byName = (configName: string) =>
      rows.find((row) => row.configName === configName)!;
    return { docs: byName('docs'), byName };
  }

  /** A site's bucket holding a deploy's files, its old versions and a delete marker. */
  function filled(bucketName: string) {
    ctx.objectStorage.put(
      bucketName,
      'object',
      'releases/r1/index.html',
      'releases/r1/app.js',
    );
    ctx.objectStorage.put(bucketName, 'version', 'releases/r0/index.html');
    ctx.objectStorage.put(bucketName, 'delete-marker', 'releases/r0/old.js');
  }

  /**
   * The lines a Delete's Cloud run wrote to its Deployment log on the
   * platform host, read where the run wrote them, or where {@link KEEPING_RM}
   * kept them once the finished Delete reclaimed its Service's logs.
   */
  function logLines(appName: string, deploymentId: string): string[] {
    const written = `${deploymentLogsDirectoryOn(null, appName)}/${deploymentId}.log`;
    const kept = `${shell.root}/kept-logs/${appName}/${deploymentId}.log`;
    const path = fs.existsSync(written) ? written : kept;
    return fs.readFileSync(path, 'utf8').split('\n');
  }

  describe("the site's Service Delete", () => {
    it('empties its bucket through the port, old versions and delete markers included, then destroys everything in its state, and the report is clean', async () => {
      const { docs } = await made();
      const bucketName = docs.cloudBucketName!;
      const state = await stateOf(docs.applicationId);
      filled(bucketName);

      let deploymentId = '';
      // No files box to tick: a deleteFiles it is sent is not read.
      const res = await request(http)
        .delete(`/applications/${docs.applicationId}?deleteFiles=false`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ cloudDelete: { status: 'deleting' } });
      deploymentId = (res.body as { cloudDelete: { deploymentId: string } })
        .cloudDelete.deploymentId;
      expect(await settled(docs.applicationId)).toBeNull();
      const lines = logLines(docs.appName, deploymentId);

      // Emptied through the port against S3: AWS's own endpoint, the deploy
      // role's session, virtual-hosted addressing.
      expect(ctx.objectStorage.calls.map((one) => one.call)).toEqual(['empty']);
      const [{ target }] = ctx.objectStorage.calls;
      expect(target).toMatchObject({
        endpoint: null,
        region: REGION,
        bucket: bucketName,
        pathStyle: false,
      });
      expect(target.credential.sessionToken).toEqual(expect.any(String));
      expect(ctx.objectStorage.entriesOf(bucketName)).toEqual([]);
      // Then everything in its state: bucket, OAC, policy, function, distribution.
      expect(destroys()).toEqual([
        expect.objectContaining({ stateId: state.infrastructureStateId }),
      ]);
      expect(destroys()[0]).not.toHaveProperty('targets');
      expect(ctx.cloud.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'findTagged',
            tags: { 'cloudgate:state': state.infrastructureStateId },
          }),
        ]),
      );
      expect(lines).toContain(CLEAN_DELETE_LINE);
      expect(lines.join('\n')).not.toMatch(/Kept on purpose|Left, although/);
      expect(
        lines.some((line) => line.includes(`Emptying ${bucketName}`)),
      ).toBe(true);
      expect(await stateOf(docs.applicationId)).toBeNull();
      expect(
        await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.deploymentId, deploymentId)),
      ).toEqual([]);
      const audited = await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resourceId, docs.applicationId));
      expect(
        audited.some((entry) =>
          (entry.metadata ?? '').includes('"cloudDelete":"finished"'),
        ),
      ).toBe(true);
    });

    it.each([
      ['lets go once the distribution is gone', 0],
      ['still calls it in use', 1],
    ])(
      "never calls a removed Domain's certificate left: ACM %s",
      async (_case, inUse) => {
        const { docs } = await made();
        const state = await stateOf(docs.applicationId);
        const stateId = state.infrastructureStateId;
        // A removed Domain's certificate, out of the state and waiting for
        // ACM; the tag search still finds it by the state's tag.
        const arn = `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/removed-1`;
        await ctx.db.insert(certificateDeletion).values({
          certificateArn: arn,
          cloudAccountId: docs.cloudAccountId!,
          region: 'us-east-1',
          stateId,
          host: 'docs.example.com',
        });
        ctx.cloud.leaveTagged(REGION, arn, { 'cloudgate:state': stateId });
        ctx.cloud.acmInUseFor(arn, inUse);

        const res = await request(http)
          .delete(`/applications/${docs.applicationId}?deleteFiles=false`)
          .set('Cookie', cookie);
        expect(res.status).toBe(200);
        const { deploymentId } = (
          res.body as { cloudDelete: { deploymentId: string } }
        ).cloudDelete;
        expect(await settled(docs.applicationId)).toBeNull();

        const lines = logLines(docs.appName, deploymentId).join('\n');
        const methods = ctx.cloud.calls.map((call) => call.method);
        expect(methods.indexOf('acmDeleteCertificate')).toBeGreaterThan(
          methods.indexOf('destroy'),
        );
        expect(lines).not.toMatch(/Left, although/);
        if (inUse === 0) {
          expect(ctx.cloud.acmDeleted.has(arn)).toBe(true);
          expect(lines).toContain(
            'The certificate of docs.example.com is deleted from ACM',
          );
          expect(await ctx.db.select().from(certificateDeletion)).toEqual([]);
        } else {
          expect(ctx.cloud.acmDeleted.has(arn)).toBe(false);
          expect(lines).toContain(
            'ACM still calls the certificate of docs.example.com in use',
          );
          // The Domain poller deletes it later, the Service long gone.
          expect(await ctx.db.select().from(certificateDeletion)).toEqual([
            expect.objectContaining({ certificateArn: arn }),
          ]);
        }
      },
    );

    it('records its Deployment as emptying the bucket before destroying', async () => {
      const { docs } = await made();
      const res = await request(http)
        .delete(`/applications/${docs.applicationId}`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      const runs = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.applicationId, docs.applicationId));
      expect(runs.find((one) => one.title === 'Delete')).toMatchObject({
        description: `Empties its S3 bucket ${docs.cloudBucketName}, then destroys everything in the Service's Infrastructure state in ${REGION}`,
      });
      expect(await settled(docs.applicationId)).toBeNull();
    });

    it('an emptying that stops partway still destroys what serves the site, names the bucket Left "partly emptied", and Retry empties it again and finishes', async () => {
      const { docs } = await made();
      const bucketName = docs.cloudBucketName!;
      const state = await stateOf(docs.applicationId);
      ctx.objectStorage.put(bucketName, 'object', 'a.html', 'b.html', 'c.js');
      ctx.objectStorage.failEmptyAfter(bucketName, 1);

      let deploymentId = '';
      const res = await request(http)
        .delete(`/applications/${docs.applicationId}`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      deploymentId = (res.body as { cloudDelete: { deploymentId: string } })
        .cloudDelete.deploymentId;
      const row = await settled(docs.applicationId);
      expect(row?.cloudDelete).toMatchObject({
        status: 'incomplete',
        unfinished: null,
        left: [
          {
            type: 's3',
            awsId: `arn:aws:s3:::${bucketName}`,
            region: REGION,
            tag: `cloudgate:state=${state.infrastructureStateId}`,
            because: 'partly-emptied',
          },
        ],
      });
      expect((await ended(deploymentId))?.status).toBe('error');
      const lines = logLines(docs.appName, deploymentId);
      // The distribution, OAC, function and bucket policy went; the bucket,
      // with its settings and what is left of its files, stays in the state.
      expect(destroys()).toEqual([
        expect.objectContaining({
          stateId: state.infrastructureStateId,
          targets: [...STATIC_SERVING_ADDRESSES],
        }),
      ]);
      expect(ctx.objectStorage.entriesOf(bucketName)).toEqual([
        'object:b.html',
        'object:c.js',
      ]);
      expect(lines.join('\n')).toContain(
        `arn:aws:s3:::${bucketName} (${REGION}, cloudgate:state=${state.infrastructureStateId}): partly emptied, it still holds files`,
      );
      expect(await stateOf(docs.applicationId)).not.toBeNull();

      // Its page reads Delete incomplete, with the bucket left.
      const page = await request(http)
        .get(`/applications/${docs.applicationId}`)
        .set('Cookie', cookie);
      expect(page.body).toMatchObject({
        cloudDelete: {
          status: 'incomplete',
          left: [expect.objectContaining({ because: 'partly-emptied' })],
        },
      });
      // A second Delete is refused: only Retry or Forget end it.
      expect(
        (
          await request(http)
            .delete(`/applications/${docs.applicationId}`)
            .set('Cookie', cookie)
        ).status,
      ).toBe(409);

      // Retry empties it again — now it empties — and destroys the rest.
      ctx.objectStorage.reset();
      ctx.objectStorage.put(bucketName, 'object', 'c.js');
      ctx.cloud.calls.length = 0;
      const retried = await request(http)
        .post(`/applications/${docs.applicationId}/delete/retry`)
        .set('Cookie', cookie);
      expect(retried.status).toBe(200);
      expect(await settled(docs.applicationId)).toBeNull();
      expect(ctx.objectStorage.calls.map((one) => one.call)).toEqual(['empty']);
      expect(ctx.objectStorage.entriesOf(bucketName)).toEqual([]);
      expect(destroys()).toHaveLength(1);
      expect(destroys()[0]).not.toHaveProperty('targets');
      expect(await stateOf(docs.applicationId)).toBeNull();
    });

    it('Forget of a partly emptied site writes the bucket left into the audit entry', async () => {
      const { docs } = await made();
      const bucketName = docs.cloudBucketName!;
      ctx.objectStorage.put(bucketName, 'object', 'a.html', 'b.html');
      ctx.objectStorage.failEmptyAfter(bucketName, 1);
      expect(
        (
          await request(http)
            .delete(`/applications/${docs.applicationId}`)
            .set('Cookie', cookie)
        ).status,
      ).toBe(200);
      expect((await settled(docs.applicationId))?.cloudDelete?.status).toBe(
        'incomplete',
      );

      const forgotten = await request(http)
        .post(`/applications/${docs.applicationId}/delete/forget`)
        .set('Cookie', cookie);
      expect(forgotten.status).toBe(200);
      expect((forgotten.body as { forgotten: LeftBody[] }).forgotten).toEqual([
        expect.objectContaining({
          awsId: `arn:aws:s3:::${bucketName}`,
          because: 'partly-emptied',
        }),
      ]);
      expect(await rowOf(docs.applicationId)).toBeUndefined();
      expect(await stateOf(docs.applicationId)).toBeNull();
    });
  });

  describe('a Plan destroy', () => {
    it('empties and destroys a static entry the config drops, with no files box', async () => {
      const { docs } = await made();
      const bucketName = docs.cloudBucketName!;
      const state = await stateOf(docs.applicationId);
      filled(bucketName);

      expect((await save(NO_SERVICES)).status).toBe(201);
      const read = await readPlan();
      expect(read.steps).toEqual([
        expect.objectContaining({
          action: 'destroy',
          configName: 'docs',
          kind: 'static',
        }),
      ]);
      // "Also delete its files" is a bucket entry's box only.
      const ticked = await apply(read.planId, {
        confirmDestroy: ['docs'],
        deleteFilesOf: ['docs'],
      });
      expect(ticked.status).toBe(409);
      expect(destroys()).toEqual([]);

      const applied = await apply(read.planId, { confirmDestroy: ['docs'] });
      expect(applied.status).toBe(200);
      const [result] = (applied.body as Applied).results;
      expect(result.deploy).toMatchObject({ status: 'queued' });

      expect(await settled(docs.applicationId)).toBeNull();
      expect(ctx.objectStorage.calls.map((one) => one.call)).toEqual(['empty']);
      expect(ctx.objectStorage.entriesOf(bucketName)).toEqual([]);
      expect(destroys()).toEqual([
        expect.objectContaining({ stateId: state.infrastructureStateId }),
      ]);
      expect(destroys()[0]).not.toHaveProperty('targets');
      expect(await stateOf(docs.applicationId)).toBeNull();
    });
  });

  describe("an Environment's Delete", () => {
    it("empties and destroys every static site's bucket and distribution", async () => {
      const { byName } = await made(TWO_SITES);
      const docs = byName('docs');
      const blog = byName('blog');
      filled(docs.cloudBucketName!);
      filled(blog.cloudBucketName!);
      const states = [
        (await stateOf(docs.applicationId)).infrastructureStateId,
        (await stateOf(blog.applicationId)).infrastructureStateId,
      ];

      const res = await request(http)
        .delete(`/environments/${environmentId}`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);

      await until(
        async () =>
          (
            await ctx.db
              .select()
              .from(environment)
              .where(eq(environment.environmentId, environmentId))
          ).length === 0,
        "The Environment's Delete",
      );
      expect(ctx.objectStorage.entriesOf(docs.cloudBucketName!)).toEqual([]);
      expect(ctx.objectStorage.entriesOf(blog.cloudBucketName!)).toEqual([]);
      expect(
        ctx.objectStorage.calls
          .filter((one) => one.call === 'empty')
          .map((one) => one.target.bucket)
          .sort(),
      ).toEqual([docs.cloudBucketName, blog.cloudBucketName].sort());
      expect(
        destroys()
          .map((call) => (call as { stateId: string }).stateId)
          .sort(),
      ).toEqual([...states].sort());
      expect(await ctx.db.select().from(application)).toEqual([]);
      expect(await ctx.db.select().from(infrastructureState)).toEqual([]);
    });
  });
});
