import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { serviceName } from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import type { LogEntry } from '../../src/cloud-accounts/google-cloud.port';
import { application, cloudAccount } from '../../src/db/schema';
import { member } from '../../src/organizations/organizations.schema';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const REGION = 'europe-west1';
const COPY_A = '0069f1e2d3c4b5a6aaaa';
const COPY_B = '0069f1e2d3c4b5a6bbbb';

interface RuntimeLogBody {
  lines: {
    id: string;
    at: number;
    task: string;
    revision: string | null;
    source: string;
    message: string;
  }[];
  next: number;
  more: boolean;
  delayed: boolean;
}

/**
 * T17: the log tab of a Cloud Run Service reads
 * the Google project's own `_Default` log store, filtered to the service,
 * with the deploy service account's access token. The app's output and
 * Cloud Run's own messages are marked as such, every copy merged by time,
 * each line naming its copy and revision; per-request entries never show.
 * One reader per Service serves every open tab, within the project's read
 * budget, and a quota refusal makes the tab say the logs are delayed.
 * Against the Google fake (`ctx.google`).
 */
describe('The Runtime log of a Cloud Run Service (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let cloudAccountId: string;
  let applicationId: string;
  let projectSeq = 0;
  /**
   * Each test's own Google project id: the read budget is the install's,
   * per project, and outlives a test's rows.
   */
  let googleProject: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    googleProject = `shop-prod-${++projectSeq}`;
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
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    const projectId = (project.body as { projectId: string }).projectId;
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ projectId, name: 'production' });
    expect(env.status).toBe(201);
    const environmentId = (env.body as { environmentId: string }).environmentId;

    const key = makeSigningKey();
    const [account] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name: 'Production Google',
        cloud: 'gcp',
        cloudId: googleProject,
        ...GOOGLE_COLUMNS,
        signingKey: key.privateKey,
        signingKeyId: key.keyId,
        signingPublicKey: JSON.stringify(key.publicJwk),
        policyVersion: 1,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    cloudAccountId = account.cloudAccountId;

    const created = await request(http)
      .post('/applications')
      .set('Cookie', cookie)
      .send({ environmentId, name: 'web', appName: 'web' });
    expect(created.status).toBe(201);
    applicationId = (created.body as { applicationId: string }).applicationId;
    // Where an Apply puts a Google `web`: a Cloud account and region.
    await ctx.db
      .update(application)
      .set({ serverId: null, cloudAccountId, region: REGION })
      .where(eq(application.applicationId, applicationId));
  });

  const read = (as: string, since?: number) =>
    request(http)
      .get(`/applications/${applicationId}/runtime-log`)
      .query(since === undefined ? {} : { since })
      .set('Cookie', as);

  const reads = () =>
    ctx.google.calls.filter((call) => call.method === 'listLogEntries');

  /** An entry of the project's log store, `ago` ms before now. */
  const entry = (
    log: string,
    ago: number,
    text: string,
    more: Partial<LogEntry> = {},
  ): LogEntry => ({
    insertId: `${log}-${ago}`,
    logName: `projects/${googleProject}/logs/${encodeURIComponent(log)}`,
    timestamp: new Date(Date.now() - ago).toISOString(),
    revision: `${serviceName(applicationId)}-00002-xyz`,
    instance: COPY_A,
    text,
    ...more,
  });

  it("merges every copy by time, marking the app's output and Cloud Run's messages, each line naming its copy and revision", async () => {
    const revision = `${serviceName(applicationId)}-00002-xyz`;
    ctx.google.writeLogEntries(
      entry('run.googleapis.com/stdout', 4_000, 'a: listening on :8080'),
      entry('run.googleapis.com/stdout', 3_000, 'b: listening on :8080', {
        instance: COPY_B,
      }),
      entry('run.googleapis.com/requests', 2_500, 'GET / 200'),
      entry('run.googleapis.com/stderr', 2_000, 'b: slow query', {
        instance: COPY_B,
      }),
      entry(
        'run.googleapis.com/varlog/system',
        1_000,
        'Default STARTUP TCP probe succeeded',
      ),
    );

    const res = await read(cookie);

    expect(res.status).toBe(200);
    const body = res.body as RuntimeLogBody;
    expect(
      body.lines.map((line) => [
        line.task,
        line.revision,
        line.source,
        line.message,
      ]),
    ).toEqual([
      [COPY_A, revision, 'stdout', 'a: listening on :8080'],
      [COPY_B, revision, 'stdout', 'b: listening on :8080'],
      [COPY_B, revision, 'stderr', 'b: slow query'],
      [COPY_A, revision, 'cloud-run', 'Default STARTUP TCP probe succeeded'],
    ]);
    expect(body.delayed).toBe(false);
    // The project's own store, filtered to the service and never its
    // per-request log, oldest first, with the deploy service account's
    // token; nothing of the login comes back.
    expect(reads()).toEqual([
      expect.objectContaining({
        impersonated: true,
        projectId: googleProject,
        oldestFirst: true,
      }),
    ]);
    const [{ filter }] = reads() as { filter: string }[];
    expect(filter).toContain('resource.type="cloud_run_revision"');
    expect(filter).toContain(
      `resource.labels.service_name="${serviceName(applicationId)}"`,
    );
    expect(filter).toContain('NOT log_name:"run.googleapis.com%2Frequests"');
    expect(JSON.stringify(res.body)).not.toContain('fake-impersonated-token');
  });

  it("reads a Worker's entries from its worker pool, through the same reader", async () => {
    await ctx.db
      .update(application)
      .set({ configKind: 'worker', configName: 'web' })
      .where(eq(application.applicationId, applicationId));
    ctx.google.writeLogEntries(
      entry('run.googleapis.com/stdout', 1_000, 'took job 41'),
    );

    const res = await read(cookie);

    expect(res.status).toBe(200);
    expect(
      (res.body as RuntimeLogBody).lines.map((line) => [
        line.source,
        line.message,
      ]),
    ).toEqual([['stdout', 'took job 41']]);
    const [{ filter }] = reads() as { filter: string }[];
    expect(filter).toContain('resource.type="cloud_run_worker_pool"');
    expect(filter).toContain(
      `resource.labels.worker_pool_name="${serviceName(applicationId)}"`,
    );
    expect(filter).not.toContain('cloud_run_revision');
  });

  it('serves every open tab from one reader per Service', async () => {
    ctx.google.writeLogEntries(
      entry('run.googleapis.com/stdout', 1_000, 'hello'),
    );

    const [first, second, third] = await Promise.all([
      read(cookie),
      read(cookie),
      read(cookie),
    ]);

    for (const res of [first, second, third]) {
      expect(res.status).toBe(200);
      expect(
        (res.body as RuntimeLogBody).lines.map((line) => line.message),
      ).toEqual(['hello']);
    }
    expect(reads()).toHaveLength(1);

    // A tab asking again within the Service's share of the minute is
    // answered from what was read, without another read.
    const again = await read(cookie, (first.body as RuntimeLogBody).next);
    expect(again.status).toBe(200);
    expect(reads()).toHaveLength(1);
  });

  it('says the logs are delayed when Google refuses a read over the quota, and backs off', async () => {
    ctx.google.refuse(
      'listLogEntries',
      'RESOURCE_EXHAUSTED',
      "Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute'",
    );

    const res = await read(cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lines: [], delayed: true });
    const [account] = await ctx.db
      .select()
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    expect(account.lastCheckResult).toBe('passed');

    // Backing off: the next ask reads nothing from Google and is still delayed.
    const again = await read(cookie);
    expect(again.status).toBe(200);
    expect((again.body as RuntimeLogBody).delayed).toBe(true);
    expect(reads()).toHaveLength(1);
  });

  it('is gated by service: read', async () => {
    const plain = await signUpMember(http, cookie);
    const refused = await read(plain.cookie);
    expect(refused.status).toBe(403);
    expect(reads()).toEqual([]);

    await ctx.db
      .update(member)
      .set({ accessedServices: [applicationId] })
      .where(eq(member.userId, plain.id));
    const granted = await read(plain.cookie);
    expect(granted.status).toBe(200);
  });

  it("names the Cloud account and Google's words when the read is denied, and records it", async () => {
    ctx.google.permissionDenied(
      'listLogEntries',
      "Permission 'logging.logEntries.list' denied on resource",
    );

    const res = await read(cookie);

    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toBe(
      `Cloud account Production Google could not read the Runtime log of web: Google Cloud answered PERMISSION_DENIED: Permission 'logging.logEntries.list' denied on resource`,
    );
    const [account] = await ctx.db
      .select()
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    expect(account.lastCheckResult).toBe('failed');
    expect(account.lastCheckReason).toContain('PERMISSION_DENIED');
  });

  it('names the Cloud account when it cannot sign in to Google Cloud', async () => {
    ctx.google.permissionDenied('impersonate');

    const res = await read(cookie);

    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toContain(
      'Cloud account Production Google could not sign in to Google Cloud',
    );
    expect(reads()).toEqual([]);
  });
});
