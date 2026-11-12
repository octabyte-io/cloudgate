import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { serviceName } from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import {
  application,
  cloudAccount,
  webServerSettings,
} from '../../src/db/schema';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';

/**
 * T18: a `web` on Cloud Run is stopped, started and reloaded,
 * and its copy range set, by direct calls through the Google client port,
 * never a Cloud run (S9, S10). Stop switches
 * the service to manual scaling at no copies, Start puts back automatic
 * scaling in the Service's copy range, and Reload sets the revision label
 * `cloudgate-reload` to the time of the call, refused while stopped. There
 * is no Remove containers.
 *
 * The Service is written as a finished deploy leaves it
 * (`google-cloud-deploy.e2e-spec.ts` makes one for real), against the
 * Google fake (`ctx.google`).
 */
describe('Stop, Start, Reload and the copy range of a Cloud Run Service (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  let cloudAccountId: string;
  let applicationId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    // The Google account's token issuer is the install's own address.
    await ctx.db
      .insert(webServerSettings)
      .values({ host: 'cloudgate.example.com', https: true });
    const res = await request(http).post('/api/auth/sign-up/email').send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;

    const key = makeSigningKey();
    const [account] = await ctx.db
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
        policyVersion: 1,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    cloudAccountId = account.cloudAccountId;
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

    const [web] = await ctx.db
      .insert(application)
      .values({
        name: 'web',
        environmentId,
        configName: 'web',
        configKind: 'web',
        sourceType: 'docker',
        dockerImage: 'nginx',
        cloudAccountId,
        region: REGION,
        minCopies: 0,
        maxCopies: 10,
        applicationStatus: 'done',
      })
      .returning();
    applicationId = web.applicationId;
    ctx.google.calls.length = 0;
  });

  const cloudRun = () => ({
    projectId: PROJECT,
    region: REGION,
    name: serviceName(applicationId),
  });

  /** What the Google port was asked of Cloud Run's settings, in order. */
  const settingCalls = () =>
    ctx.google.calls.filter((call) =>
      ['setCloudRunScaling', 'setCloudRunCopies', 'setRevisionLabel'].includes(
        call.method,
      ),
    );

  const rowOf = async () => {
    const [row] = await ctx.db
      .select({
        status: application.applicationStatus,
        minCopies: application.minCopies,
        maxCopies: application.maxCopies,
      })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    return row;
  };

  const post = (action: string) =>
    request(http)
      .post(`/applications/${applicationId}/${action}`)
      .set('Cookie', cookie);

  const putRange = (body: object) =>
    request(http)
      .put(`/applications/${applicationId}/copy-range`)
      .set('Cookie', cookie)
      .send(body);

  /** An Agent of `role`, granted the Project, Environment and Service. */
  async function agent(role: 'agentOperator' | 'agentReader') {
    const created = await request(http)
      .post('/agents')
      .set('Cookie', cookie)
      .send({
        name: `${role}-bot`,
        role,
        grant: {
          accessedProjects: [projectId],
          accessedEnvironments: [environmentId],
          accessedServices: [applicationId],
        },
      });
    expect(created.status).toBe(201);
    const id = (created.body as { agent: { id: string } }).agent.id;
    return { user: { id }, session: { activeOrganizationId: organizationId } };
  }

  it('stops by switching to manual scaling at no copies, and starts by putting back automatic scaling in its copy range', async () => {
    const stopped = await post('stop');
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ applicationStatus: 'stopped' });
    expect(settingCalls()).toEqual([
      {
        method: 'setCloudRunScaling',
        impersonated: true,
        ...cloudRun(),
        scaling: { mode: 'stopped' },
      },
    ]);
    // Signed in as the deploy service account, as every call outside tofu is.
    expect(ctx.google.calls[0]).toMatchObject({ method: 'exchangeToken' });

    ctx.google.calls.length = 0;
    const started = await post('start');
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ applicationStatus: 'done' });
    expect(settingCalls()).toEqual([
      {
        method: 'setCloudRunScaling',
        impersonated: true,
        ...cloudRun(),
        scaling: { mode: 'automatic', copies: { min: 0, max: 10 } },
      },
    ]);
    // Nothing is a Cloud run.
    expect(
      ctx.google.calls.filter((call) =>
        ['plan', 'apply'].includes(call.method),
      ),
    ).toEqual([]);
  });

  it('reloads by setting the cloudgate-reload revision label to the time of the call, and refuses it while stopped, saying why', async () => {
    const before = Math.floor(Date.now() / 1000);
    const reloaded = await post('reload');
    const after = Math.floor(Date.now() / 1000);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body).toMatchObject({ applicationStatus: 'done' });
    const calls = settingCalls();
    const [call] = calls;
    if (calls.length !== 1 || call.method !== 'setRevisionLabel') {
      throw new Error(`Reload made ${JSON.stringify(calls)}`);
    }
    expect(call).toEqual({
      method: 'setRevisionLabel',
      impersonated: true,
      ...cloudRun(),
      label: { key: 'cloudgate-reload', value: call.label.value },
    });
    // Whole seconds, the time of the call.
    expect(call.label.value).toMatch(/^\d+$/);
    const at = Number(call.label.value);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);

    expect((await post('stop')).status).toBe(200);
    ctx.google.calls.length = 0;
    const refused = await post('reload');
    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toBe(
      'This Service is stopped, so it has no running copy to replace. Start it first',
    );
    expect(ctx.google.calls).toEqual([]);
    expect((await rowOf()).status).toBe('stopped');
  });

  it('offers no Remove containers on a Cloud Run Service', async () => {
    const res = await post('remove-containers');
    expect(res.status).toBe(404);
    expect(ctx.google.calls).toEqual([]);
  });

  it('sets the copy range by a direct call and saves it, and Start uses it', async () => {
    const res = await putRange({ minCopies: 1, maxCopies: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ minCopies: 1, maxCopies: 3 });
    expect(settingCalls()).toEqual([
      {
        method: 'setCloudRunCopies',
        impersonated: true,
        ...cloudRun(),
        copies: { min: 1, max: 3 },
      },
    ]);
    expect(await rowOf()).toMatchObject({ minCopies: 1, maxCopies: 3 });

    expect((await post('stop')).status).toBe(200);
    ctx.google.calls.length = 0;
    expect((await post('start')).status).toBe(200);
    expect(settingCalls()).toEqual([
      expect.objectContaining({
        method: 'setCloudRunScaling',
        scaling: { mode: 'automatic', copies: { min: 1, max: 3 } },
      }),
    ]);
  });

  it('refuses a copy range Cloud Run would not run, before any call', async () => {
    for (const body of [
      { minCopies: 4, maxCopies: 3 },
      { minCopies: 0, maxCopies: 0 },
      { minCopies: -1, maxCopies: 3 },
      { minCopies: 1.5, maxCopies: 3 },
      { minCopies: 0, maxCopies: 1001 },
    ]) {
      const res = await putRange(body);
      expect([body, res.status]).toEqual([body, 400]);
    }
    expect(
      JSON.stringify((await putRange({ minCopies: 4, maxCopies: 3 })).body),
    ).toContain('The fewest copies cannot be more than the most copies');
    expect(ctx.google.calls).toEqual([]);
    expect(await rowOf()).toMatchObject({ minCopies: 0, maxCopies: 10 });
  });

  it("keeps the copy range as it was when Google refuses it, in Google's words", async () => {
    ctx.google.refuse(
      'setCloudRunCopies',
      'INVALID_ARGUMENT',
      'max_instance_count exceeds the quota of 5 for this region',
    );

    const res = await putRange({ minCopies: 1, maxCopies: 8 });

    expect(res.status).toBe(409);
    expect((res.body as { message: string; code: string }).message).toBe(
      'Google Cloud refused the copy range of web: INVALID_ARGUMENT: max_instance_count exceeds the quota of 5 for this region',
    );
    expect(await rowOf()).toMatchObject({ minCopies: 0, maxCopies: 10 });
  });

  it('saves the copy range alone while no deploy has made the Cloud Run service yet, for its first deploy to make it so', async () => {
    ctx.google.notFound('setCloudRunCopies');

    const res = await putRange({ minCopies: 2, maxCopies: 4 });

    expect(res.status).toBe(200);
    expect(await rowOf()).toMatchObject({ minCopies: 2, maxCopies: 4 });
  });

  it('refuses Stop with the reason when no deploy has made the Cloud Run service yet', async () => {
    ctx.google.notFound('setCloudRunScaling');

    const res = await post('stop');

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      message:
        'web has nothing running in Cloud account Production Google yet: no deploy has made its Cloud Run service. Deploy it first',
      code: 'CLOUD_LIFECYCLE_REFUSED',
    });
    expect((await rowOf()).status).toBe('done');
  });

  it('names an API turned off and the setup step that turns it on', async () => {
    ctx.google.refuse(
      'setCloudRunScaling',
      'PERMISSION_DENIED',
      'Cloud Run Admin API has not been used in project 123456789012 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/run.googleapis.com/overview?project=123456789012',
    );

    const res = await post('stop');

    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toBe(
      'Google Cloud refused to stop web: The Cloud Run Admin API (run.googleapis.com) is off in Google Cloud project shop-prod. Cloudgate never turns on an API: turn it on as step 1 of the setup script does (gcloud services enable run.googleapis.com), then Check for changes',
    );
    expect((await rowOf()).status).toBe('done');
  });

  it('refuses a copy range on a Service that is not on Cloud Run', async () => {
    const [plain] = await ctx.db
      .insert(application)
      .values({
        name: 'other',
        configName: 'other',
        environmentId,
        sourceType: 'docker',
        dockerImage: 'nginx',
      })
      .returning();

    const res = await request(http)
      .put(`/applications/${plain.applicationId}/copy-range`)
      .set('Cookie', cookie)
      .send({ minCopies: 1, maxCopies: 3 });

    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toBe(
      'Only a Service on Cloud Run has a copy range; other has replicas',
    );
    expect(ctx.google.calls).toEqual([]);
  });

  it('lets agentOperator stop, start and reload a Cloud Run Service, and not agentReader, nor set its copy range', async () => {
    const applications = ctx.app.get(ApplicationsService);
    const operator = await agent('agentOperator');

    await applications.stop(operator, applicationId);
    expect((await rowOf()).status).toBe('stopped');
    await applications.start(operator, applicationId);
    expect((await rowOf()).status).toBe('done');
    await applications.reload(operator, applicationId);
    expect(settingCalls().map((call) => call.method)).toEqual([
      'setCloudRunScaling',
      'setCloudRunScaling',
      'setRevisionLabel',
    ]);

    ctx.google.calls.length = 0;
    const reader = await agent('agentReader');
    for (const act of [
      () => applications.stop(reader, applicationId),
      () => applications.start(reader, applicationId),
      () => applications.reload(reader, applicationId),
      () =>
        applications.setCopyRange(reader, applicationId, {
          minCopies: 1,
          maxCopies: 3,
        }),
    ]) {
      await expect(act()).rejects.toMatchObject({ status: 403 });
    }
    expect(settingCalls()).toEqual([]);
  });

  /**
   * A Worker's Cloud Run worker pool: Stop sets its instance count
   * to 0, Start back to `replicas`, Reload its revision label, each a direct
   * call; it has no copy range.
   */
  describe('a Worker on a Cloud Run worker pool', () => {
    let workerId: string;

    beforeEach(async () => {
      const [worker] = await ctx.db
        .insert(application)
        .values({
          name: 'jobs',
          environmentId,
          configName: 'jobs',
          configKind: 'worker',
          sourceType: 'docker',
          dockerImage: 'acme/jobs',
          cloudAccountId,
          region: REGION,
          replicas: 2,
          applicationStatus: 'done',
        })
        .returning();
      workerId = worker.applicationId;
      ctx.google.calls.length = 0;
    });

    const pool = () => ({
      projectId: PROJECT,
      region: REGION,
      name: serviceName(workerId),
    });
    const poolCalls = () =>
      ctx.google.calls.filter((call) =>
        [
          'setWorkerPoolInstances',
          'setWorkerPoolRevisionLabel',
          'setCloudRunScaling',
          'setCloudRunCopies',
          'setRevisionLabel',
        ].includes(call.method),
      );
    const postTo = (action: string) =>
      request(http)
        .post(`/applications/${workerId}/${action}`)
        .set('Cookie', cookie);

    it('stops at 0 instances and starts at its replicas, by direct calls, never a Cloud run', async () => {
      const stopped = await postTo('stop');
      expect(stopped.status).toBe(200);
      expect(stopped.body).toMatchObject({ applicationStatus: 'stopped' });

      const started = await postTo('start');
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({ applicationStatus: 'done' });

      expect(poolCalls()).toEqual([
        {
          method: 'setWorkerPoolInstances',
          impersonated: true,
          ...pool(),
          instances: 0,
        },
        {
          method: 'setWorkerPoolInstances',
          impersonated: true,
          ...pool(),
          instances: 2,
        },
      ]);
      expect(
        ctx.google.calls.filter((call) =>
          ['plan', 'apply'].includes(call.method),
        ),
      ).toEqual([]);
    });

    it("reloads by setting its worker pool's cloudgate-reload label", async () => {
      const reloaded = await postTo('reload');
      expect(reloaded.status).toBe(200);
      expect(poolCalls()).toEqual([
        expect.objectContaining({
          method: 'setWorkerPoolRevisionLabel',
          ...pool(),
          label: expect.objectContaining({ key: 'cloudgate-reload' }) as object,
        }),
      ]);
    });

    it('refuses a copy range, its replicas being its instance count, and calls nothing', async () => {
      const refused = await request(http)
        .put(`/applications/${workerId}/copy-range`)
        .set('Cookie', cookie)
        .send({ minCopies: 1, maxCopies: 3 });

      expect(refused.status).toBe(409);
      expect(JSON.stringify(refused.body)).toContain(
        "jobs is a Worker, whose replicas are its worker pool's instance count",
      );
      expect(poolCalls()).toEqual([]);
    });

    it('says no deploy has made its worker pool when Google has none', async () => {
      ctx.google.notFound('setWorkerPoolInstances');

      const refused = await postTo('stop');

      expect(refused.status).toBe(409);
      expect(JSON.stringify(refused.body)).toContain(
        'no deploy has made its Cloud Run worker pool. Deploy it first',
      );
    });
  });
});
