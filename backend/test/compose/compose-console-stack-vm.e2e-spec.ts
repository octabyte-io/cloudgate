import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  STACK_VM_RUNS_NO_SWARM,
  STACK_VM_TAKES_NO_SERVER,
} from '../../src/compose/compose.service';
import {
  cloudAccount,
  compose,
  deployment,
  server as serverTable,
  stackVmKey,
} from '../../src/db/schema';
import { ProjectsService } from '../../src/projects/projects.service';
import { readSavedServices } from '../../src/project-config/saved-settings';
import { cookieHeader } from '../realtime/realtime.fixture';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

/**
 * **A console-made Compose stack in a Cloud Environment** (#1372,
 * ADR-0070): `POST /compose` asks for no Server there. The stack's place
 * is the Deploy target's Cloud account and region, on its own Stack VM
 * that the Environment's plan makes; no Server row is made for it, and the
 * stack page's setting sizes it.
 */
describe('A console-made Compose stack in a Cloud Environment (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;

  beforeAll(async () => {
    ctx = await createTestApp();
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  async function setUp() {
    const res = await request(http).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(res.status).toBe(200);
    const cookie = cookieHeader(res.headers['set-cookie']);
    const userId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const [account] = await ctx.db
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
    const project = await ctx.app.get(ProjectsService).create(
      {
        user: { id: userId },
        session: { activeOrganizationId: organizationId },
      },
      { name: 'Shop' },
    );
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId: project.projectId,
        name: 'production',
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: account.cloudAccountId,
          region: REGION,
        },
      });
    expect(env.status).toBe(201);
    const environmentId = (env.body as { environmentId: string }).environmentId;
    return { cookie, account, environmentId };
  }

  it('places a stack with no Server on its own Stack VM, at medium, with nothing made', async () => {
    const { cookie, account, environmentId } = await setUp();
    const res = await request(http)
      .post('/compose')
      .set('Cookie', cookie)
      .send({ name: 'wiki', environmentId, sourceType: 'raw' });
    expect(res.status).toBe(201);
    const composeId = (res.body as { composeId: string }).composeId;

    const [row] = await ctx.db
      .select()
      .from(compose)
      .where(eq(compose.composeId, composeId));
    expect(row).toMatchObject({
      serverId: null,
      cloudAccountId: account.cloudAccountId,
      region: REGION,
      stackVm: {
        machineType: 't3.small',
        sizeName: 'medium',
        dataDiskGb: 20,
        snapshotDays: 7,
        made: null,
      },
    });
    // Its own SSH key, which its Stack VM's first boot installs.
    const keys = await ctx.db
      .select()
      .from(stackVmKey)
      .where(eq(stackVmKey.composeId, composeId));
    expect(keys).toHaveLength(1);
    // A Stack VM is never a Server.
    expect(await ctx.db.select().from(serverTable)).toEqual([]);
    const servers = await request(http).get('/servers').set('Cookie', cookie);
    expect(servers.body).toEqual([]);

    // Its plan reads it as a Stack VM still to be made.
    const saved = await readSavedServices(ctx.db, environmentId);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      configName: 'wiki',
      stackVm: { made: false, cloud: 'aws' },
    });
  });

  it('refuses a Server named in a Cloud Environment, the platform host included', async () => {
    const { cookie, environmentId } = await setUp();
    for (const serverId of [null, 'srv-1']) {
      const res = await request(http)
        .post('/compose')
        .set('Cookie', cookie)
        .send({ name: 'wiki', environmentId, serverId });
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        STACK_VM_TAKES_NO_SERVER,
      );
    }
  });

  it('refuses a Swarm stack there', async () => {
    const { cookie, environmentId } = await setUp();
    const res = await request(http)
      .post('/compose')
      .set('Cookie', cookie)
      .send({ name: 'wiki', environmentId, composeType: 'stack' });
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toBe(
      STACK_VM_RUNS_NO_SWARM,
    );
  });

  it("shows its Stack VM's facts, and sizes it from the stack page; the disk only grows", async () => {
    const { cookie, environmentId } = await setUp();
    const created = await request(http)
      .post('/compose')
      .set('Cookie', cookie)
      .send({ name: 'wiki', environmentId });
    const composeId = (created.body as { composeId: string }).composeId;

    const page = await request(http)
      .get(`/compose/${composeId}`)
      .set('Cookie', cookie);
    expect(page.body).toMatchObject({
      stackVmFacts: {
        cloud: 'aws',
        region: REGION,
        made: false,
        machineType: 't3.small',
        machine: '2 vCPU, 2 GB',
        dataDiskGb: 20,
        console: { sizeName: null, dataDiskGb: null },
      },
    });

    const sized = await request(http)
      .patch(`/compose/${composeId}/stack-vm`)
      .set('Cookie', cookie)
      .send({ size: 'large', dataDiskGb: 40 });
    expect(sized.status).toBe(200);
    expect(sized.body).toMatchObject({
      console: { sizeName: 'large', dataDiskGb: 40 },
    });

    const shrunk = await request(http)
      .patch(`/compose/${composeId}/stack-vm`)
      .set('Cookie', cookie)
      .send({ dataDiskGb: 10 });
    expect(shrunk.status).toBe(400);
  });

  it('refuses a Deployment, Stop, Start and Restart up front while its Stack VM is not made, saying the plan makes it', async () => {
    const { cookie, environmentId } = await setUp();
    const created = await request(http)
      .post('/compose')
      .set('Cookie', cookie)
      .send({ name: 'wiki', environmentId, sourceType: 'raw' });
    const composeId = (created.body as { composeId: string }).composeId;

    for (const path of ['deployments', 'stop', 'start', 'restart']) {
      const res = await request(http)
        .post(`/compose/${composeId}/${path}`)
        .set('Cookie', cookie)
        .send({});
      expect({ path, status: res.status }).toEqual({ path, status: 409 });
      expect((res.body as { message: string }).message).toBe(
        "wiki's Stack VM is not made yet: the Environment's next plan makes it once applied, and nothing runs on it until then",
      );
    }

    // Nothing was queued to fail at the tunnel, and the stack reads as it did.
    expect(await ctx.db.select().from(deployment)).toEqual([]);
    const [row] = await ctx.db
      .select({ composeStatus: compose.composeStatus })
      .from(compose)
      .where(eq(compose.composeId, composeId));
    expect(row.composeStatus).toBe('idle');
  });
});
