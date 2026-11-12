import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { application, cloudAccount } from '../../src/db/schema';
import { member } from '../../src/organizations/organizations.schema';
import {
  RUNTIME_LOG_LOOKBACK_MS,
  RUNTIME_LOG_WINDOW_MS,
} from '../../src/project-config/runtime-log/runtime-log';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const TASK_A = '0a0a0a0a0a0a4a0a8a0a0a0a0a0a0a0a';
const TASK_B = '0b0b0b0b0b0b4b0b8b0b0b0b0b0b0b0b';

interface RuntimeLogBody {
  lines: { id: string; at: number; task: string; message: string }[];
  next: number;
  more: boolean;
}

/**
 * The log tab of a cloud Service reads its Runtime log from the log
 * group Cloudgate made for it, through the cloud port with the Cloud
 * account's deploy role. Every task's lines merged by time, each naming its
 * task; gated by `service: read`; a failed read names the Cloud account.
 * Against the fake cloud port (`ctx.cloud`).
 */
describe('The Runtime log of a cloud Service (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let cloudAccountId: string;
  let environmentId: string;
  let applicationId: string;
  let group: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
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
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    const projectId = (project.body as { projectId: string }).projectId;
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ projectId, name: 'production' });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;

    const [account] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name: 'Production AWS',
        cloud: 'aws',
        cloudId: ACCOUNT,
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: SECRET,
        deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy`,
        taskExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution`,
        externalId: 'external-id-made-by-cloudgate',
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
    // Where an Apply puts a cloud `web`: a Cloud account and region.
    await ctx.db
      .update(application)
      .set({ serverId: null, cloudAccountId, region: REGION })
      .where(eq(application.applicationId, applicationId));
    group = `/cloudgate/${environmentId}/${applicationId}`;
  });

  const read = (as: string, since?: number) =>
    request(http)
      .get(`/applications/${applicationId}/runtime-log`)
      .query(since === undefined ? {} : { since })
      .set('Cookie', as);

  const reads = () =>
    ctx.cloud.calls.filter((call) => call.method === 'filterLogStreams');

  it.each(['web', 'worker', 'web-private'] as const)(
    'merges every task of a %s by time, each line naming its task, read with the deploy role',
    async (kind) => {
      // A Worker on ECS writes the same log group a `web` does.
      await ctx.db
        .update(application)
        .set({ configKind: kind })
        .where(eq(application.applicationId, applicationId));
      const now = Date.now();
      ctx.cloud.writeLog(group, TASK_A, [
        { timestamp: now - 4_000, message: 'a: listening on :8080' },
        { timestamp: now - 1_000, message: 'a: GET / 200' },
      ]);
      ctx.cloud.writeLog(group, TASK_B, [
        { timestamp: now - 3_000, message: 'b: listening on :8080' },
        { timestamp: now - 2_000, message: 'b: GET /health 200' },
      ]);

      const res = await read(cookie);

      expect(res.status).toBe(200);
      const body = res.body as RuntimeLogBody;
      expect(body.lines.map((line) => [line.task, line.message])).toEqual([
        [TASK_A, 'a: listening on :8080'],
        [TASK_B, 'b: listening on :8080'],
        [TASK_B, 'b: GET /health 200'],
        [TASK_A, 'a: GET / 200'],
      ]);
      expect(body.more).toBe(false);
      // FilterLogEvents over the Service's stream prefix, with a role session
      // and never the key itself; nothing of the login comes back.
      expect(reads()).toEqual([
        expect.objectContaining({
          region: REGION,
          logGroupName: group,
          logStreamNamePrefix: 'service/service/',
          session: true,
        }),
      ]);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      expect(JSON.stringify(res.body)).not.toContain('AKIA');
    },
  );

  it('opens on the last few minutes, then reads on from where it left off', async () => {
    const now = Date.now();
    ctx.cloud.writeLog(group, TASK_A, [
      { timestamp: now - RUNTIME_LOG_WINDOW_MS - 60_000, message: 'too old' },
      { timestamp: now - 1_000, message: 'recent' },
    ]);

    const first = await read(cookie);
    expect(first.status).toBe(200);
    const opened = first.body as RuntimeLogBody;
    expect(opened.lines.map((line) => line.message)).toEqual(['recent']);

    ctx.cloud.writeLog(group, TASK_B, [
      { timestamp: Date.now(), message: 'after the first read' },
    ]);
    const second = await read(cookie, opened.next);
    expect(second.status).toBe(200);
    const after = second.body as RuntimeLogBody;
    expect(after.lines.map((line) => line.message)).toContain(
      'after the first read',
    );
    expect(after.lines.map((line) => line.message)).not.toContain('too old');
    // The second read starts a few seconds back, for lines CloudWatch takes
    // in late, so it reads `recent` again: with the same id, so the console
    // shows it once.
    const recent = after.lines.find((line) => line.message === 'recent');
    expect(recent?.id).toBe(opened.lines[0].id);
    expect(reads()[1]).toMatchObject({ startTime: opened.next });
  });

  it('reads back an hour, and no further, for since=0: how the Cloudgate CLI asks for more than the last few minutes', async () => {
    const now = Date.now();
    ctx.cloud.writeLog(group, TASK_A, [
      { timestamp: now - RUNTIME_LOG_LOOKBACK_MS - 60_000, message: 'too old' },
      { timestamp: now - RUNTIME_LOG_WINDOW_MS - 60_000, message: 'earlier' },
      { timestamp: now - 1_000, message: 'recent' },
    ]);

    const res = await read(cookie, 0);

    expect(res.status).toBe(200);
    expect(
      (res.body as RuntimeLogBody).lines.map((line) => line.message),
    ).toEqual(['earlier', 'recent']);
  });

  it('is empty before the first deploy has made the log group', async () => {
    const res = await read(cookie);
    expect(res.status).toBe(200);
    expect((res.body as RuntimeLogBody).lines).toEqual([]);
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

  it('names the Cloud account when its deploy role cannot be taken on, and records it', async () => {
    ctx.cloud.refuseRole(
      'User: arn:aws:iam::123456789012:user/cloudgate is not authorized to perform: sts:AssumeRole',
    );

    const res = await read(cookie);

    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toContain(
      'Cloud account Production AWS could not take on its deploy role',
    );
    expect(reads()).toEqual([]);
    const [account] = await ctx.db
      .select()
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    expect(account.lastCheckResult).toBe('failed');
  });

  it('names the Cloud account and AWS words when CloudWatch refuses the read, and records a denial', async () => {
    ctx.cloud.refuseLogs(
      'AccessDeniedException',
      'User is not authorized to perform: logs:FilterLogEvents',
    );

    const res = await read(cookie);

    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toBe(
      'Cloud account Production AWS could not read the Runtime log of web: AWS answered AccessDeniedException: User is not authorized to perform: logs:FilterLogEvents',
    );
    const [account] = await ctx.db
      .select()
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
    expect(account.lastCheckResult).toBe('failed');
    expect(account.lastCheckReason).toContain('AccessDeniedException');
  });

  it('refuses a Service that runs on a Server', async () => {
    await ctx.db
      .update(application)
      .set({ cloudAccountId: null, region: null })
      .where(eq(application.applicationId, applicationId));

    const res = await read(cookie);

    expect(res.status).toBe(400);
    expect(reads()).toEqual([]);
  });
});
