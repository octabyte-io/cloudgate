import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import type { TofuResourceChange } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';
import type { TofuShow } from '../../src/cloud-accounts/cloud.port';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import {
  networkName,
  networkNamePrefix,
  serviceName,
} from '../../src/cloud-accounts/gcp/definitions/names';
import {
  cloudAccount,
  deployment,
  domain,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import type { Deployment, Plan } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { CloudServiceDeploys } from '../../src/project-config/applier/cloud-service-deploys.service';
import { GoogleServiceDeploys } from '../../src/project-config/applier/google-service-deploys.service';
import { storedGooglePlan } from '../utils/fake-google-cloud-port';
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

const TWO_WEBS = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
  api:
    kind: web
    size: small
    source: { image: nginx }
`;

/** The Service key and network prefix the stored Google plans were written with. */
const FIXTURE_SERVICE = 'cloudgate-plb3nv2t74e6';
const FIXTURE_NETWORK = 'cloudgate-w33lemwkholw-';
/** The mark the stored web plan writes in each `description`. */
const FIXTURE_MARK =
  'Cloudgate cloud-account=cloud_1 environment=env_1 state=state_web_1';

/** Every variable value the stored plans carry, in clear. */
const SECRET_VALUES = ['hunter2-very-secret', 'another-secret-value'];

interface Read {
  status: 'reading' | 'read' | 'failed';
  reason?: string;
  summary?: string[];
  raw?: { address: string; action: string; drift: boolean }[];
  counts?: Record<string, number>;
  drift?: {
    address: string;
    line: string;
    deleted: boolean;
    replaceForcing: boolean;
    fields: { field: string; hand: string; cloudgate: string }[];
  }[];
  adopt?: {
    address: string;
    resourceType: string;
    arn: string;
    line: string;
  }[];
  noState?: { arn: string; address: string | null; line: string }[];
  stateId?: string;
  serviceId?: string;
  liveImage?: string | null;
}

interface Step {
  action: string;
  configName?: string;
  serviceId?: string;
  environmentNetworkId?: string;
  fields?: unknown[];
  cloudRead?: Read;
}

interface Result {
  configName: string;
  action: string;
  status: string;
  message: string | null;
  deploy: { status: string; deploymentId?: string; message?: string } | null;
  network?: { environmentNetworkId: string; deploymentId: string };
}

interface PlanBody {
  planId: string;
  status: string;
  steps: Step[];
  results: Result[] | null;
}

/** What one made Cloud Run Service is, as the Apply that made it left it. */
interface Made {
  applicationId: string;
  stateId: string;
  /** Its live image: the tag of its finished deploy. */
  liveImage: string;
}

/** A stored plan with the Service names and mark it was written with made `web`'s. */
function planOf(name: string, made: Made): TofuShow {
  return JSON.parse(
    JSON.stringify(storedGooglePlan(name)).replaceAll(
      FIXTURE_SERVICE,
      serviceName(made.applicationId),
    ),
  ) as TofuShow;
}

/** One change of a stored plan, by address. */
function changeAt(show: TofuShow, address: string): TofuResourceChange {
  const changes = show.resource_changes as TofuResourceChange[];
  return changes.find((change) => change.address === address)!;
}

/**
 * Spec "Drift" (T21, copying AWS): a plan reads what exists in a Google Cloud
 * project for Drift, and Apply puts back Cloudgate's version.
 *
 * Two Cloud Run webs and their Environment network are made through a
 * real Apply, each web's deploy then marked finished on its image.
 * "Check for changes" reads every Google step — each web against its own
 * state on its live image, and the network with its own — and finds
 * nothing to do when Google Cloud is as Cloudgate made it, Stop and Reload
 * included. A hand change shows "will be put back" field by field, a hand
 * deletion "will be made again", and "Apply: put Google Cloud back" queues
 * a Deployment on the live image per drifted web, or a network run, which
 * applies exactly what was read. A thing its state lost is found by its
 * fixed name: adopted, and imported by the Apply, only when its
 * `description` carries the same mark; otherwise shown and never adopted.
 *
 * Against the Google fake (`ctx.google`), whose stand-in `tofu` replays the
 * stored Google plans; no build runs (the queue is a double).
 */
describe('Drift on Google Cloud, adopt by name and what Check for changes reads (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  let environmentNetworkId: string;
  let networkStateId: string;
  let web: Made;
  let api: Made;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gdrift-'));
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    // Every Cloud run's Deployment log is written on the platform host.
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
    cloudAccountId = row.cloudAccountId;
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

    await makeTwoWebs();
    // From here Google Cloud is as Cloudgate made it, unless a spec says otherwise.
    ctx.google.replayPlanFor('network', null);
    ctx.google.replayPlanFor('web', null);
    ctx.google.calls.length = 0;
    ctx.google.tofuInputs.length = 0;
    queue.add.mockClear();
  });

  /**
   * The two webs and their network, made by a real Apply, and each web's
   * deploy marked finished as a Cloud run would leave it: its live image.
   */
  async function makeTwoWebs(): Promise<void> {
    ctx.google.replayPlanFor('network', 'network-create');
    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.replayOutputsFor('network', 'network-create');
    ctx.google.replayOutputsFor('web', 'web-create');
    const saved = await save(TWO_WEBS);
    expect(saved.status).toBe(201);
    const read = await readPlan();
    networkStateId = read.steps[0].cloudRead!.stateId!;
    expect((await apply(read.planId)).status).toBe(200);
    const row = await settled(read.planId);
    const made = (name: string): Made => {
      const step = read.steps.find((one) => one.configName === name)!;
      const result = row.results!.find((one) => one.configName === name)!;
      expect(result).toMatchObject({ status: 'applied' });
      return {
        applicationId: step.cloudRead!.serviceId!,
        stateId: step.cloudRead!.stateId!,
        liveImage: (result.deploy as { deploymentId: string }).deploymentId,
      };
    };
    web = made('web');
    api = made('api');
    environmentNetworkId = row.results!.find(
      (one) => one.action === 'network-create',
    )!.network!.environmentNetworkId;
    for (const one of [web, api]) {
      await ctx.db
        .update(deployment)
        .set({
          status: 'done',
          cloudRun: {
            kind: 'deploy',
            stateKey: `application:${one.applicationId}`,
            environmentId,
            touchesNetwork: false,
            architecture: 'amd64',
          },
        })
        .where(eq(deployment.deploymentId, one.liveImage));
    }
  }

  const save = (text: string) =>
    request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text });

  const checkForChanges = () =>
    request(http)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie)
      .send({});

  const apply = (planId: string) =>
    request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId });

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

  /** "Check for changes", read: the plan it stores once Google Cloud is read. */
  async function checked(): Promise<PlanBody> {
    const res = await checkForChanges();
    expect(res.status).toBe(201);
    return readPlan();
  }

  /** The plan's row once no result says `running`: the Apply is over. */
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

  const stepOf = (found: PlanBody, name: string) =>
    found.steps.find((step) => step.configName === name)!;

  /** The states each `tofu plan` since the calls were cleared ran against. */
  const plannedStates = () =>
    ctx.google.calls
      .flatMap((call) => (call.method === 'plan' ? [call.stateId] : []))
      .sort();

  /** What the run of a state applied: its definition as `tofu` was handed it. */
  const appliedDefinition = (stateId: string) =>
    JSON.parse(
      ctx.google.tofuInputs.find(
        (input) => input.method === 'apply' && input.stateId === stateId,
      )!.definition,
    ) as { import?: { to: string; id: string }[] };

  describe('what Check for changes reads', () => {
    it('reads every Google step: the network and each web, against its own state, on its live image', async () => {
      const res = await checkForChanges();
      expect(res.status).toBe(201);
      const stored = res.body as PlanBody;

      expect(stored.steps[0]).toEqual({
        action: 'network-change',
        environmentNetworkId,
        cloudAccountId,
        region: REGION,
        cloudRead: { status: 'reading' },
      });
      expect(stored.steps.slice(1)).toEqual(
        expect.arrayContaining(
          [web, api].map((one): unknown =>
            expect.objectContaining({
              action: 'change',
              serviceId: one.applicationId,
              fields: [],
              cloudRead: { status: 'reading' },
            }),
          ),
        ),
      );
      expect(stored.steps).toHaveLength(3);

      const read = await readPlan();
      expect(read.steps.map((step) => step.cloudRead?.status)).toEqual([
        'read',
        'read',
        'read',
      ]);
      expect(plannedStates()).toEqual(
        [networkStateId, web.stateId, api.stateId].sort(),
      );
      // Written with the live image, as its next deploy would.
      for (const one of [web, api]) {
        const input = ctx.google.tofuInputs.find(
          (found) => found.stateId === one.stateId,
        )!;
        expect(input.definition).toContain(`:${one.liveImage}"`);
      }
    });

    it('reads the network with every Domain on it, as its run writes them, so no Domain reads as one to take off', async () => {
      const [added] = await ctx.db
        .insert(domain)
        .values({
          host: 'shop.example.com',
          applicationId: web.applicationId,
          https: true,
          cloudCertificateStatus: 'live',
        })
        .returning();

      await checked();

      expect(ctx.google.calls).toContainEqual(
        expect.objectContaining({
          method: 'plan',
          stateId: networkStateId,
          domains: {
            [added.domainId]: expect.objectContaining({
              host: 'shop.example.com',
            }) as unknown,
          },
        }),
      );
    });

    it("is unchanged once every read finds Google Cloud as Cloudgate made it, Stop's scaling, the copy range and Reload's label included", async () => {
      // `stopped-reloaded.json` read on the live image: the refresh saw
      // Stop, a copy range edit and Reload, which the definition ignores.
      const show = planOf('stopped-reloaded', web);
      const service = changeAt(show, 'google_cloud_run_v2_service.service');
      const before = service.change.before as {
        template: { containers: { image: string }[] }[];
      };
      const after = service.change.after as typeof before;
      after.template[0].containers[0].image =
        before.template[0].containers[0].image;
      ctx.google.replayPlanForState(web.stateId, show);

      const read = await checked();

      expect(read.status).toBe('unchanged');
      expect(
        read.steps.every((step) => step.cloudRead?.raw?.length === 0),
      ).toBe(true);
      expect(stepOf(read, 'web').cloudRead).toMatchObject({
        drift: [],
        liveImage: web.liveImage,
      });
    });
  });

  describe('Drift', () => {
    it("lists each drifted field's hand value and Cloudgate's, never a variable's value, and keeps a drift-only plan open", async () => {
      ctx.google.replayPlanForState(web.stateId, planOf('drift-field', web));

      const read = await checked();
      const drift = stepOf(read, 'web').cloudRead!;

      expect(read.status).toBe('open');
      expect(drift.counts).toMatchObject({ drift: 1, change: 0, create: 0 });
      expect(drift.drift).toEqual([
        expect.objectContaining({
          address: 'google_cloud_run_v2_service.service',
          line: 'Cloud Run service `web`: changed outside Cloudgate, will be put back',
          deleted: false,
          fields: [
            expect.objectContaining({ field: 'template.0.containers.0.env' }),
            expect.objectContaining({
              field: 'template.0.containers.0.image',
              hand: expect.stringContaining(':hand-fix') as string,
            }),
          ],
        }),
      ]);
      // Only the drifted web is anything but quiet.
      expect(stepOf(read, 'api').cloudRead?.raw).toEqual([]);
      const answered = JSON.stringify(read);
      for (const secret of SECRET_VALUES) {
        expect(answered).not.toContain(secret);
      }
    });

    it('marks what was deleted by hand on the network as will be made again', async () => {
      const stored = storedGooglePlan('network-create');
      const rule = changeAt(
        stored,
        'google_compute_global_forwarding_rule.http',
      );
      ctx.google.replayShowFor('network', {
        ...stored,
        resource_changes: [rule],
        resource_drift: [
          {
            ...rule,
            change: {
              actions: ['delete'],
              before: rule.change.after,
              after: null,
            },
          },
        ],
      });

      const read = await checked();

      expect(read.status).toBe('open');
      expect(read.steps[0].cloudRead?.drift).toEqual([
        expect.objectContaining({
          address: 'google_compute_global_forwarding_rule.http',
          line: 'Forwarding rule `cloudgate-w33lemwkholw-http` (port 80): will be made again',
          deleted: true,
        }),
      ]);
    });
  });

  describe('Apply: put Google Cloud back', () => {
    it('queues a Deployment on the live image for each drifted web, which applies the approved put-back, pushes nothing and starts nothing', async () => {
      ctx.google.replayPlanForState(web.stateId, planOf('drift-field', web));
      const read = await checked();
      ctx.google.calls.length = 0;
      ctx.google.tofuInputs.length = 0;

      const res = await apply(read.planId);

      expect(res.status).toBe(200);
      const answered = res.body as PlanBody;
      expect(answered.status).toBe('applied');
      // The quiet network and api have nothing to put back, so no result.
      expect(answered.results).toEqual([
        expect.objectContaining({
          configName: 'web',
          action: 'change',
          status: 'applied',
          deploy: {
            status: 'queued',
            deploymentId: expect.any(String) as string,
          },
        }),
      ]);
      const row = await ended(answered.results![0].deploy!.deploymentId!);

      expect(row).toMatchObject({
        applicationId: web.applicationId,
        title: 'Put Google Cloud back',
        status: 'done',
        cloudRun: {
          kind: 'deploy',
          stateKey: `application:${web.applicationId}`,
          liveImage: web.liveImage,
        },
      });
      expect(queue.add).not.toHaveBeenCalled();
      const applied = ctx.google.tofuInputs.find(
        (input) => input.method === 'apply' && input.stateId === web.stateId,
      )!;
      expect(applied.definition).toContain(`:${web.liveImage}"`);
      const methods = ctx.google.calls.map((call) => call.method);
      // A put-back writes no setting: a stopped Service stays stopped.
      expect(methods).not.toContain('setCloudRunScaling');
      expect(ctx.google.calls).toContainEqual(
        expect.objectContaining({
          method: 'deleteImageVersionsExcept',
          keepTag: web.liveImage,
        }),
      );
      expect(fs.readFileSync(row.logPath, 'utf8')).toContain(
        "Putting Google Cloud back to Cloudgate's version, on the live image",
      );
    });

    it('queues a network run when the network drifted, which applies what was read', async () => {
      const stored = storedGooglePlan('network-create');
      const rule = changeAt(
        stored,
        'google_compute_global_forwarding_rule.http',
      );
      ctx.google.replayShowFor('network', {
        ...stored,
        resource_changes: [rule],
        resource_drift: [
          {
            ...rule,
            change: {
              actions: ['delete'],
              before: rule.change.after,
              after: null,
            },
          },
        ],
      });
      const read = await checked();

      const res = await apply(read.planId);

      expect(res.status).toBe(200);
      const [result] = (res.body as PlanBody).results!;
      expect(result).toMatchObject({
        configName: `Environment network (${REGION})`,
        action: 'network-change',
        status: 'applied',
        network: { environmentNetworkId },
      });
      const row = await ended(result.network!.deploymentId);
      expect(row).toMatchObject({
        environmentNetworkId,
        title: `Put the Environment network (${REGION}) back`,
        description: expect.stringContaining(
          'put back in Google Cloud',
        ) as string,
        status: 'done',
        cloudRun: { kind: 'network', touchesNetwork: true },
      });
      expect(ctx.google.calls).toContainEqual(
        expect.objectContaining({ method: 'apply', stateId: networkStateId }),
      );
    });

    it('refuses a put-back whose Google Cloud moved since the plan was read, changing nothing', async () => {
      ctx.google.replayPlanForState(web.stateId, planOf('drift-field', web));
      const read = await checked();
      ctx.google.replayPlanForState(web.stateId, planOf('web-create', web));

      const res = await apply(read.planId);
      const row = await ended(
        (res.body as PlanBody).results![0].deploy!.deploymentId!,
      );

      expect(row.status).toBe('error');
      expect(row.description).toContain(
        'Google Cloud no longer matches the plan that was applied',
      );
    });
  });

  describe('Adopt by name', () => {
    const repositoryId = () =>
      `projects/${PROJECT}/locations/${REGION}/repositories/${serviceName(web.applicationId)}`;

    it("adopts what a state lost its record of when its name and description are Cloudgate's, and its Apply imports it", async () => {
      // The state's record is gone (an older backup): its plan makes it all.
      ctx.google.replayPlanForState(web.stateId, planOf('web-create', web));
      ctx.google.find({
        resourceType: 'google_artifact_registry_repository',
        name: serviceName(web.applicationId),
        id: repositoryId(),
        description: FIXTURE_MARK,
      });

      const read = await checked();
      const google = stepOf(read, 'web').cloudRead!;

      expect(google.adopt).toEqual([
        {
          address: 'google_artifact_registry_repository.service',
          resourceType: 'google_artifact_registry_repository',
          arn: repositoryId(),
          line: `Artifact Registry repository \`${serviceName(web.applicationId)}\`: found in Google Cloud, taken back into Cloudgate's record`,
        },
      ]);
      expect(google.raw).toContainEqual(
        expect.objectContaining({
          address: 'google_artifact_registry_repository.service',
          action: 'adopt',
        }),
      );
      // Searched by the Service's fixed name, one list per kind it creates.
      expect(ctx.google.calls).toContainEqual(
        expect.objectContaining({
          method: 'findByName',
          resourceType: 'google_artifact_registry_repository',
          namePrefix: serviceName(web.applicationId),
        }),
      );
      ctx.google.tofuInputs.length = 0;

      const res = await apply(read.planId);
      const row = await ended(
        (res.body as PlanBody).results![0].deploy!.deploymentId!,
      );

      expect(row.status).toBe('done');
      expect(appliedDefinition(web.stateId).import).toEqual([
        {
          to: 'google_artifact_registry_repository.service',
          id: repositoryId(),
        },
      ]);
    });

    it("shows a thing of Cloudgate's name with another description, and never adopts it", async () => {
      ctx.google.replayPlanForState(web.stateId, planOf('web-create', web));
      ctx.google.find({
        resourceType: 'google_artifact_registry_repository',
        name: serviceName(web.applicationId),
        id: repositoryId(),
        description: 'Made by someone else',
      });

      const read = await checked();
      const google = stepOf(read, 'web').cloudRead!;

      expect(google.adopt).toEqual([]);
      expect(google.noState).toEqual([
        {
          arn: repositoryId(),
          address: 'google_artifact_registry_repository.service',
          line: `Artifact Registry repository \`${serviceName(web.applicationId)}\`: found in Google Cloud, not Cloudgate's: \`${serviceName(web.applicationId)}\` carries another mark, so it is not adopted; remove it by hand`,
        },
      ]);
      ctx.google.tofuInputs.length = 0;

      const res = await apply(read.planId);
      await ended((res.body as PlanBody).results![0].deploy!.deploymentId!);

      expect(appliedDefinition(web.stateId).import).toBeUndefined();
    });

    it("notes a thing of the state's name no create wants as found in Google Cloud, in no state", async () => {
      ctx.google.replayPlanForState(web.stateId, planOf('web-create', web));
      const stray = `projects/${PROJECT}/locations/${REGION}/services/${serviceName(web.applicationId)}-old`;
      ctx.google.find({
        resourceType: 'google_cloud_run_v2_service',
        name: `${serviceName(web.applicationId)}-old`,
        id: stray,
        description: FIXTURE_MARK,
      });

      const read = await checked();

      expect(stepOf(read, 'web').cloudRead?.noState).toEqual([
        {
          arn: stray,
          address: null,
          line: `found in Google Cloud, in no state: ${stray}`,
        },
      ]);
    });

    it("adopts the network's default certificate map entry by name, and the network's run imports it", async () => {
      // The network's state lost its record: its plan makes it all again.
      const prefix = networkNamePrefix(environmentId);
      ctx.google.replayShowFor(
        'network',
        JSON.parse(
          JSON.stringify(storedGooglePlan('network-create')).replaceAll(
            FIXTURE_NETWORK,
            prefix,
          ),
        ) as TofuShow,
      );
      const entry = changeAt(
        storedGooglePlan('network-create'),
        'google_certificate_manager_certificate_map_entry.default',
      );
      const entryId = `projects/${PROJECT}/locations/global/certificateMaps/${networkName(environmentId, 'certs')}/certificateMapEntries/${networkName(environmentId, 'default')}`;
      ctx.google.find({
        resourceType: 'google_certificate_manager_certificate_map_entry',
        name: networkName(environmentId, 'default'),
        id: entryId,
        description: (entry.change.after as { description: string })
          .description,
      });

      const read = await checked();

      expect(read.steps[0].cloudRead?.adopt).toEqual([
        expect.objectContaining({
          address: 'google_certificate_manager_certificate_map_entry.default',
          arn: entryId,
        }),
      ]);
      ctx.google.tofuInputs.length = 0;

      const res = await apply(read.planId);
      const [result] = (res.body as PlanBody).results!;
      const row = await ended(result.network!.deploymentId);

      expect(row.status).toBe('done');
      expect(appliedDefinition(networkStateId).import).toEqual([
        {
          to: 'google_certificate_manager_certificate_map_entry.default',
          id: entryId,
        },
      ]);
    });
  });
});
