import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { infrastructureState } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import {
  cloudAccount,
  compose,
  deployment,
  domain,
  environmentNetwork,
} from '../../src/db/schema';
import type { FakeGoogleCall } from '../utils/fake-google-cloud-port';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const VOLUME = 'vol-0data';
const GOOGLE_PROJECT = 'shop-prod';

/**
 * Deleting a Compose stack that runs on its own Stack VM on AWS (ADR-0070
 * "Delete", #1367): the Delete is a destroy-only Cloud run that takes a
 * named final snapshot of the data disk unless asked not to, destroys
 * everything in the stack's Infrastructure state, deletes Data Lifecycle
 * Manager's daily snapshots, and drops the row and the state only once the
 * state is empty. One that cannot finish keeps the row, says why, and is
 * retried by the next Delete without a second snapshot (ADR-0038).
 *
 * No teardown runs on any machine Cloudgate reaches: the whole VM goes.
 */
describe('Deleting a stack on a Stack VM (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let composeId: string;
  let stateId: string;
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: DEPLOYMENT_QUEUE, useValue: queue }],
    });
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
      .send({ name: 'Shop' });
    expect(project.status).toBe(201);
    const projectId = (project.body as { projectId: string }).projectId;

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
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId,
        name: 'production',
        deployTarget: {
          kind: 'cloud',
          cloudAccountId: account.cloudAccountId,
          region: REGION,
        },
      });
    expect(env.status).toBe(201);
    const environmentId = (env.body as { environmentId: string }).environmentId;

    // A stack whose Apply made its Stack VM, as `CloudStackVmRuns` leaves it.
    const [stack] = await ctx.db
      .insert(compose)
      .values({
        name: 'analytics',
        configName: 'analytics',
        environmentId,
        sourceType: 'raw',
        composeFile: 'services:\n  app:\n    image: nginx:1.27\n',
        cloudAccountId: account.cloudAccountId,
        region: REGION,
        stackVm: {
          machineType: 't3.small',
          sizeName: 'medium',
          dataDiskGb: 20,
          snapshotDays: 7,
          made: {
            imageId: 'ami-0ubuntu',
            pins: { dockerEngine: '28.5.1', composePlugin: '2.40.0' },
            instanceId: 'i-0stackvm',
            privateIp: '10.80.128.10',
            dataVolumeId: VOLUME,
          },
        },
      } as typeof compose.$inferInsert)
      .returning();
    composeId = stack.composeId;
    const [state] = await ctx.db
      .insert(infrastructureState)
      .values({ composeId })
      .returning();
    stateId = state.infrastructureStateId;

    ctx.cloud.calls.length = 0;
    ctx.cloud.volumeSnapshots.clear();
    ctx.cloud.dailySnapshots.clear();
    ctx.cloud.dailySnapshots.set(VOLUME, ['snap-daily-1', 'snap-daily-2']);
  });

  const remove = (query = '') =>
    request(http).delete(`/compose/${composeId}${query}`).set('Cookie', cookie);

  async function stackRow() {
    const [row] = await ctx.db
      .select()
      .from(compose)
      .where(eq(compose.composeId, composeId));
    return row;
  }

  /** The stack's row once its Delete's Cloud run has ended: `undefined` once dropped. */
  async function settled() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const row = await stackRow();
      if (!row || row.cloudDelete?.status !== 'deleting') return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("The stack's Delete did not end");
  }

  it('keeps a named final snapshot, destroys the state, deletes the daily snapshots, then drops the row and the state', async () => {
    const res = await remove();
    expect(res.status).toBe(200);
    const body = res.body as {
      composeId: string;
      stackVmDelete?: { deploymentId: string };
    };
    expect(body.composeId).toBe(composeId);
    expect(typeof body.stackVmDelete?.deploymentId).toBe('string');

    expect(await settled()).toBeUndefined();
    const today = new Date().toISOString().slice(0, 10);
    const methods = ctx.cloud.calls.map((call) => call.method);
    expect(methods).toEqual(
      expect.arrayContaining([
        'ec2TakeSnapshot',
        'destroy',
        'ec2DailySnapshots',
        'stateResources',
      ]),
    );
    // The snapshot is taken before anything is destroyed.
    expect(methods.indexOf('ec2TakeSnapshot')).toBeLessThan(
      methods.indexOf('destroy'),
    );
    expect(ctx.cloud.calls).toContainEqual(
      expect.objectContaining({
        method: 'ec2TakeSnapshot',
        volumeId: VOLUME,
        name: `shop-production-analytics-final-${today}`,
      }),
    );
    expect(ctx.cloud.dailySnapshots.get(VOLUME)).toEqual([]);
    expect([...ctx.cloud.volumeSnapshots.keys()]).toEqual(['snap-1']);
    expect(await ctx.db.select().from(infrastructureState)).toEqual([]);
  });

  it('takes no final snapshot when asked for the data to go', async () => {
    expect((await remove('?deleteVolumes=true')).status).toBe(200);

    expect(await settled()).toBeUndefined();
    expect(ctx.cloud.calls.map((call) => call.method)).not.toContain(
      'ec2TakeSnapshot',
    );
    expect(ctx.cloud.volumeSnapshots.size).toBe(0);
  });

  it('keeps the row and its state when the destroy fails, says why, and a second Delete retries without a second snapshot', async () => {
    ctx.cloud.failRun('AccessDenied: not authorized to terminate i-0stackvm');
    expect((await remove()).status).toBe(200);

    const kept = await settled();
    expect(kept?.cloudDelete).toMatchObject({
      status: 'incomplete',
      snapshotTaken: { id: 'snap-1', sizeGb: 20 },
    });
    expect(kept?.cloudDelete?.unfinished).toContain('AccessDenied');
    expect(
      await ctx.db
        .select()
        .from(infrastructureState)
        .where(eq(infrastructureState.infrastructureStateId, stateId)),
    ).toHaveLength(1);
    const [run] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.composeId, composeId));
    expect(run.status).toBe('error');

    ctx.cloud.calls.length = 0;
    ctx.cloud.passRun();
    expect((await remove()).status).toBe(200);

    expect(await settled()).toBeUndefined();
    expect(ctx.cloud.calls.map((call) => call.method)).not.toContain(
      'ec2TakeSnapshot',
    );
    expect(ctx.cloud.volumeSnapshots.size).toBe(1);
  });

  /**
   * On Google Cloud a stack's Domains are host rules on the Environment
   * network's one URL map, each naming a backend service in the stack's own
   * state (#1371). Google refuses to delete a backend service a URL map
   * still names, so the Delete first runs the network's Domains without
   * the stack's, as a cloud Service's Delete does, and only then destroys
   * the stack's state.
   */
  it("on Google Cloud, takes the stack's Domains off the network's URL map before it destroys their backends", async () => {
    const [stack] = await ctx.db
      .select()
      .from(compose)
      .where(eq(compose.composeId, composeId));
    const key = makeSigningKey();
    await ctx.db
      .update(cloudAccount)
      .set({
        cloud: 'gcp',
        cloudId: GOOGLE_PROJECT,
        accessKeyId: null,
        secretAccessKey: null,
        deployRoleArn: null,
        taskExecutionRoleArn: null,
        externalId: null,
        ...GOOGLE_COLUMNS,
        signingKey: key.privateKey,
        signingKeyId: key.keyId,
        signingPublicKey: JSON.stringify(key.publicJwk),
      })
      .where(eq(cloudAccount.cloudAccountId, stack.cloudAccountId!));
    await ctx.db
      .update(compose)
      .set({
        stackVm: {
          ...stack.stackVm!,
          machineType: 'e2-small',
          made: {
            ...stack.stackVm!.made!,
            instanceId: 'cg-analytics',
            dataVolumeId: 'cg-analytics-data',
            zone: `${REGION}-b`,
          },
          routedPorts: [2368],
        },
      })
      .where(eq(compose.composeId, composeId));
    const [network] = await ctx.db
      .insert(environmentNetwork)
      .values({
        environmentId: stack.environmentId,
        cloudAccountId: stack.cloudAccountId!,
        region: REGION,
        status: 'ready',
        networkName: 'cloudgate-net',
        subnetName: 'cloudgate-subnet',
        ipAddress: '203.0.113.20',
        urlMapName: 'cloudgate-urls',
        certificateMapName: 'cloudgate-certs',
      })
      .returning();
    await ctx.db
      .update(infrastructureState)
      .set({ provider: 'google' })
      .where(eq(infrastructureState.infrastructureStateId, stateId));
    const states = ctx.app.get(InfrastructureStatesService);
    const networkStateId = (
      await states.create(
        { environmentNetworkId: network.environmentNetworkId },
        undefined,
        'google',
      )
    ).infrastructureStateId;
    const [routed] = await ctx.db
      .insert(domain)
      .values({
        composeId,
        host: 'shop.example.com',
        serviceName: 'web',
        port: 2368,
        https: true,
        cloudCertificateStatus: 'live',
      } as typeof domain.$inferInsert)
      .returning();
    ctx.google.replayPlanFor('network', null);
    ctx.google.replayOutputsFor('network', null);
    ctx.google.calls.length = 0;

    expect((await remove('?deleteVolumes=true')).status).toBe(200);
    expect(await settled()).toBeUndefined();

    const runs = ctx.google.calls.filter(
      (
        call,
      ): call is Extract<
        FakeGoogleCall,
        { method: 'plan' | 'apply' | 'destroy' }
      > => call.method === 'apply' || call.method === 'destroy',
    );
    const onNetwork = runs.findIndex(
      (call) => call.method === 'apply' && call.stateId === networkStateId,
    );
    const destroyed = runs.findIndex(
      (call) => call.method === 'destroy' && call.stateId === stateId,
    );
    expect(onNetwork).toBeGreaterThanOrEqual(0);
    expect(destroyed).toBeGreaterThan(onNetwork);
    // The URL map written without the stack's Domain.
    expect(Object.keys(runs[onNetwork].domains ?? {})).not.toContain(
      routed.domainId,
    );
  });

  it('refuses a second Delete while one runs', async () => {
    ctx.cloud.hang(stateId);
    expect((await remove()).status).toBe(200);

    const again = await remove();
    expect(again.status).toBe(409);
    expect((again.body as { message: string }).message).toBe(
      'analytics is already being deleted',
    );
  });
});
