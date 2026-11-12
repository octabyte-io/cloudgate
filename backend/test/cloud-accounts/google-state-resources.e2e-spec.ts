import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { serviceName } from '../../src/cloud-accounts/gcp/definitions/names';
import {
  infrastructureState,
  tofuStates,
} from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import {
  cloudAccount,
  deployment,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { GoogleServiceDeploys } from '../../src/project-config/applier/google-service-deploys.service';
import {
  storedGooglePlan,
  storedGoogleState,
} from '../utils/fake-google-cloud-port';
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

const ONE_WEB = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
`;

/** The Service key the stored Google plan and state were written with. */
const FIXTURE_SERVICE = 'cloudgate-plb3nv2t74e6';
/** The mark the stored web plan writes in each `description`. */
const FIXTURE_MARK =
  'Cloudgate cloud-account=cloud_1 environment=env_1 state=state_web_1';

/** Values the stored states hold that a list must never show. */
const STATE_VALUES = [
  'hunter2-very-secret',
  'another-secret-value',
  'OUTPUT-SECRET-VALUE',
  'INGRESS_TRAFFIC_ALL',
  FIXTURE_MARK,
];

interface Read {
  status: 'reading' | 'read' | 'failed';
  reason?: string;
  stateId?: string;
  serviceId?: string;
  adopt?: { address: string; resourceType: string; arn: string }[];
}

interface Step {
  action: string;
  configName?: string;
  serviceId?: string;
  cloudRead?: Read;
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
}

interface GoogleResource {
  type: string;
  googleName: string;
  region: string;
  labels: Record<string, string>;
  labelled: boolean;
}

interface ResourceList {
  cloud: string;
  stateId: string | null;
  readable: boolean;
  failure: string | null;
  resources: GoogleResource[];
  networkCardsUnread: string | null;
}

/**
 * Spec "Drift and the resource list" (T23; as on AWS): a
 * Cloud Run Service's and the Google Environment network's resource list,
 * an unreadable Google state, and Rebuild from the cloud, which re-imports
 * by name what the discarded state held.
 *
 * A web and its network are made by a real Apply against the Google fake
 * (`ctx.google`), whose stand-in `tofu` replays stored plans and, for a
 * read of a state, prints the stored state a spec scripted. No build runs
 * (the queue is a double).
 */
describe('Resource lists, unreadable states and Rebuild from the cloud on Google Cloud (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let environmentId: string;
  let environmentNetworkId: string;
  let networkStateId: string;
  let applicationId: string;
  let webStateId: string;
  const root = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), 'cloudgate-google-state-resources-'),
  );
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    process.env.CLOUDGATE_DIRECTORY = root;
    ctx = await createTestApp({
      overrideProviders: [{ provide: DEPLOYMENT_QUEUE, useValue: queue }],
    });
    http = ctx.app.getHttpServer() as App;
    ctx.app.get(CloudServiceDeploys).pollIntervalMs = 10;
    ctx.app.get(GoogleServiceDeploys).pollIntervalMs = 10;
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    queue.add.mockClear();
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
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
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

    await makeWeb();
    // From here Google Cloud is as Cloudgate made it, unless a spec says otherwise.
    ctx.google.replayPlanFor('network', null);
    ctx.google.replayPlanFor('web', null);
    ctx.google.calls.length = 0;
    queue.add.mockClear();
  });

  /** The web and its network, made by a real Apply, its deploy finished. */
  async function makeWeb(): Promise<void> {
    ctx.google.replayPlanFor('network', 'network-create');
    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.replayOutputsFor('network', 'network-create');
    ctx.google.replayOutputsFor('web', 'web-create');
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: ONE_WEB });
    expect(saved.status).toBe(201);
    const read = await readPlan();
    networkStateId = read.steps[0].cloudRead!.stateId!;
    const applied = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(applied.status).toBe(200);
    const row = await settled(read.planId);
    const step = read.steps.find((one) => one.configName === 'web')!;
    const result = row.results!.find((one) => one.configName === 'web')!;
    expect(result).toMatchObject({ status: 'applied' });
    applicationId = step.cloudRead!.serviceId!;
    webStateId = step.cloudRead!.stateId!;
    environmentNetworkId = row.results!.find(
      (one) => one.action === 'network-create',
    )!.network!.environmentNetworkId;
    await ctx.db
      .update(deployment)
      .set({
        status: 'done',
        cloudRun: {
          kind: 'deploy',
          stateKey: `application:${applicationId}`,
          environmentId,
          touchesNetwork: false,
          architecture: 'amd64',
        },
      })
      .where(
        eq(
          deployment.deploymentId,
          (result.deploy as { deploymentId: string }).deploymentId,
        ),
      );
  }

  async function currentPlan(): Promise<PlanBody> {
    const res = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: PlanBody }).plan;
  }

  /** The Environment's plan once no step is still reading Google Cloud. */
  async function readPlan(): Promise<PlanBody> {
    for (let attempt = 0; attempt < 300; attempt++) {
      const found = await currentPlan();
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading Google Cloud');
  }

  async function settled(planId: string): Promise<Plan> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const [row] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, planId));
      if (
        row.results !== null &&
        !row.results.some((result) => result.status === 'running')
      ) {
        return row;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The Apply never ended');
  }

  /** The Deployment once its Cloud run has ended. */
  async function ended(deploymentId: string): Promise<Deployment> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const [row] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.deploymentId, deploymentId));
      if (row && !['pending', 'running'].includes(row.status)) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The Cloud run never ended');
  }

  async function checked(): Promise<PlanBody> {
    const res = await request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie)
      .send({});
    expect(res.status).toBe(201);
    return readPlan();
  }

  /** A stored Google state or plan with the fixture's Service name made `web`'s. */
  function asWeb<T>(stored: T): T {
    return JSON.parse(
      JSON.stringify(stored).replaceAll(
        FIXTURE_SERVICE,
        serviceName(applicationId),
      ),
    ) as T;
  }

  const serviceList = () =>
    request(http)
      .get(`/applications/${applicationId}/cloud-resources`)
      .set('Cookie', cookie);

  const networkList = () =>
    request(http)
      .get(
        `/environments/${environmentId}/networks/${environmentNetworkId}/resources`,
      )
      .set('Cookie', cookie);

  const rebuildService = (confirmName: string) =>
    request(http)
      .post(`/applications/${applicationId}/state/rebuild`)
      .set('Cookie', cookie)
      .send({ confirmName });

  const rebuildNetwork = (confirmName: string) =>
    request(http)
      .post(
        `/environments/${environmentId}/networks/${environmentNetworkId}/state/rebuild`,
      )
      .set('Cookie', cookie)
      .send({ confirmName });

  async function readableOf(stateId: string): Promise<boolean> {
    const [row] = await ctx.db
      .select({ readable: infrastructureState.readable })
      .from(infrastructureState)
      .where(eq(infrastructureState.infrastructureStateId, stateId));
    return row.readable;
  }

  const tofuRuns = () =>
    ctx.google.calls.filter((call) =>
      ['plan', 'apply', 'destroy'].includes(call.method),
    );

  describe('the resource list', () => {
    it("lists a Cloud Run Service's resources by type, Google name, region and labels, marking what carries none of Cloudgate's, and never a value", async () => {
      ctx.google.stateHolds(
        webStateId,
        asWeb(storedGoogleState('google-web-state')),
      );
      const name = serviceName(applicationId);

      const res = await serviceList();

      expect(res.status).toBe(200);
      const body = res.body as ResourceList;
      expect(body).toMatchObject({
        cloud: 'gcp',
        stateId: webStateId,
        readable: true,
        failure: null,
        networkCardsUnread: null,
      });
      expect(
        body.resources
          .filter((one) => !one.type.startsWith('google_secret_manager'))
          .map(({ type, googleName, region, labelled }) => [
            type,
            googleName,
            region,
            labelled,
          ]),
      ).toEqual([
        ['google_artifact_registry_repository', name, REGION, true],
        ['google_cloud_run_v2_service', name, REGION, true],
        ['google_compute_backend_service', name, 'global', false],
        ['google_compute_region_network_endpoint_group', name, REGION, false],
        ['google_service_account', name, 'global', false],
      ]);
      expect(body.resources[1].labels).toEqual({
        'cloudgate-cloud-account': 'lqinodt54kzk',
        'cloudgate-environment': 'w33lemwkholw',
        'cloudgate-state': '7rhuqxy3gm43',
      });
      for (const resource of body.resources) {
        expect(Object.keys(resource).sort()).toEqual([
          'googleName',
          'labelled',
          'labels',
          'region',
          'type',
        ]);
      }
      for (const value of STATE_VALUES) {
        expect(res.text).not.toContain(value);
      }
      // Read with the state's own id and region, through a run's own
      // credential; nothing planned, applied or destroyed.
      expect(ctx.google.calls).toContainEqual({
        method: 'stateResources',
        stateId: webStateId,
        region: REGION,
      });
      expect(tofuRuns()).toEqual([]);
    });

    it("lists the Environment network's network and subnet as carrying no label, under environment: read", async () => {
      ctx.google.stateHolds(
        networkStateId,
        storedGoogleState('google-network-state'),
      );

      const res = await networkList();

      expect(res.status).toBe(200);
      const body = res.body as ResourceList;
      expect(body).toMatchObject({
        cloud: 'gcp',
        stateId: networkStateId,
        readable: true,
        failure: null,
      });
      const of = (type: string) =>
        body.resources.find((one) => one.type === type);
      expect(of('google_compute_network')).toEqual({
        type: 'google_compute_network',
        googleName: 'cloudgate-w33lemwkholw-net',
        region: 'global',
        labels: {},
        labelled: false,
      });
      expect(of('google_compute_subnetwork')).toMatchObject({
        googleName: 'cloudgate-w33lemwkholw-subnet',
        region: REGION,
        labelled: false,
      });
      expect(of('google_compute_global_address')).toMatchObject({
        labelled: true,
      });
    });

    it('lists nothing for a state no run has written yet', async () => {
      const res = await serviceList();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        cloud: 'gcp',
        stateId: webStateId,
        readable: true,
        failure: null,
        resources: [],
        networkCardsUnread: null,
      });
    });
  });

  describe('an unreadable state', () => {
    it('is marked unreadable when its list cannot read it, naming it, and every later run fails before tofu', async () => {
      ctx.google.stateUnreadable(webStateId);

      const listed = await serviceList();

      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({
        cloud: 'gcp',
        stateId: webStateId,
        readable: false,
        resources: [],
      });
      expect((listed.body as ResourceList).failure).toContain(webStateId);
      expect(await readableOf(webStateId)).toBe(false);

      // Never written over: the next read refuses without running tofu,
      // and says Rebuild adopts by Cloudgate's names.
      ctx.google.calls.length = 0;
      const again = await checked();
      const reason = again.steps.find((one) => one.serviceId === applicationId)!
        .cloudRead!.reason;
      expect(reason).toContain(webStateId);
      expect(reason).toContain(
        "Rebuild from the cloud discards it and adopts what Cloudgate's names find",
      );
      expect(
        ctx.google.calls.filter(
          (call) => 'stateId' in call && call.stateId === webStateId,
        ),
      ).toEqual([]);
    });
  });

  describe('Rebuild from the cloud', () => {
    const repositoryId = () =>
      `projects/${PROJECT}/locations/${REGION}/repositories/${serviceName(applicationId)}`;

    async function lose(stateId: string): Promise<void> {
      await ctx.db
        .insert(tofuStates)
        .values({ name: stateId, data: 'unreadable ciphertext' });
      await ctx.db
        .update(infrastructureState)
        .set({ readable: false, tofuVersion: '1.13.1' })
        .where(eq(infrastructureState.infrastructureStateId, stateId));
    }

    it('refuses a state Cloudgate can read, discarding nothing', async () => {
      const res = await rebuildService('web');

      expect(res.status).toBe(409);
      expect(await readableOf(webStateId)).toBe(true);
    });

    it('discards the state and produces a plan that adopts by name what the state held, which its Apply imports', async () => {
      await lose(webStateId);
      // Against an empty state, the plan makes everything; the search by
      // name finds the repository, Cloudgate's mark in its description.
      ctx.google.replayPlanForState(
        webStateId,
        asWeb(storedGooglePlan('web-create')),
      );
      ctx.google.find({
        resourceType: 'google_artifact_registry_repository',
        name: serviceName(applicationId),
        id: repositoryId(),
        description: FIXTURE_MARK,
      });

      const res = await rebuildService('web');

      expect(res.status).toBe(200);
      expect((res.body as PlanBody).status).toBe('open');
      const [state] = await ctx.db
        .select()
        .from(infrastructureState)
        .where(eq(infrastructureState.infrastructureStateId, webStateId));
      expect(state).toMatchObject({
        provider: 'google',
        readable: true,
        tofuVersion: null,
        providerVersion: null,
      });
      expect(
        await ctx.db
          .select()
          .from(tofuStates)
          .where(eq(tofuStates.name, webStateId)),
      ).toEqual([]);

      const read = await readPlan();
      const step = read.steps.find((one) => one.serviceId === applicationId)!;
      expect(step.cloudRead).toMatchObject({
        status: 'read',
        stateId: webStateId,
      });
      expect(step.cloudRead!.adopt).toEqual([
        expect.objectContaining({
          address: 'google_artifact_registry_repository.service',
          arn: repositoryId(),
        }),
      ]);
      expect(ctx.google.calls).toContainEqual(
        expect.objectContaining({
          method: 'findByName',
          resourceType: 'google_artifact_registry_repository',
          namePrefix: serviceName(applicationId),
        }),
      );

      ctx.google.tofuInputs.length = 0;
      const applied = await request(http)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: read.planId });
      expect(applied.status).toBe(200);
      const run = await ended(
        (applied.body as { results: { deploy: { deploymentId: string } }[] })
          .results[0].deploy.deploymentId,
      );
      expect(run.status).toBe('done');
      const definition = JSON.parse(
        ctx.google.tofuInputs.find(
          (input) => input.method === 'apply' && input.stateId === webStateId,
        )!.definition,
      ) as { import?: { to: string; id: string }[] };
      expect(definition.import).toEqual([
        {
          to: 'google_artifact_registry_repository.service',
          id: repositoryId(),
        },
      ]);
    });

    it("rebuilds an Environment network's state, confirmed by the Environment's name", async () => {
      await lose(networkStateId);

      expect((await rebuildNetwork('web')).status).toBe(400);
      const res = await rebuildNetwork('production');

      expect(res.status).toBe(200);
      expect(await readableOf(networkStateId)).toBe(true);
      const read = await readPlan();
      expect(
        read.steps.find((one) => one.action === 'network-change')!.cloudRead,
      ).toMatchObject({ status: 'read', stateId: networkStateId });
    });
  });
});
