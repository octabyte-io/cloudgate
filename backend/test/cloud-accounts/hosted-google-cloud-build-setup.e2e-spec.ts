// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { subscription } from '../../src/cloud/billing/billing.schema';
import { buildPieceNames } from '../../src/cloud-accounts/gcp/cloud-build-names';
import { stackVmPermissionsMissing } from '../../src/cloud-accounts/gcp/deploy-role';
import { idKey } from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import {
  cloudAccount,
  plan as planTable,
  webServerSettings,
} from '../../src/db/schema';
import type { Plan } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { MailService } from '../../src/mail/mail.service';
import { FAKE_PROJECT_NUMBER } from '../utils/fake-google-cloud-port';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const customer = {
  name: 'Grace',
  lastName: 'Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
  organizationName: 'Shop',
};

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';

const WEB = `version: 1
services:
  api:
    kind: web
    size: small
    source: { image: nginx }
`;

/** What version 6 adds over version 5: a hosted cloud build's Cloud Build. */
const CLOUD_BUILD_PERMISSIONS = [
  'cloudbuild.builds.create',
  'cloudbuild.builds.get',
  'cloudbuild.builds.list',
  'cloudbuild.builds.update',
];

const CLOUD_BUILD_API = 'cloudbuild.googleapis.com';

/**
 * What versions 7 and 8 add, on either instance: a Stack VM's
 * permissions (#1366), read from the shipped table.
 */
const STACK_VM_PERMISSIONS = stackVmPermissionsMissing(5);

/** A cloud build's standing piece, as the network's definition names it. */
const BUILD_SOURCE = 'google_storage_bucket.build_source';

interface View {
  cloudAccountId: string;
  policyVersion: number;
  currentPolicyVersion: number;
  permissionsOutOfDate: boolean;
  missingActions: string[];
  lastCheckResult: string | null;
  lastCheckReason: string | null;
}

interface Template {
  policyVersion: number;
  script: string;
  roleDefinition: string;
  buildRoleDefinition?: string;
  names: {
    pool: string;
    provider: string;
    serviceAccountEmail: string;
    build?: {
      serviceAccount: string;
      serviceAccountEmail: string;
      role: string;
    };
  };
}

interface PlanBody {
  planId: string;
  steps: {
    action: string;
    cloudRead?: { status: string; stateId?: string };
  }[];
}

/**
 * A hosted cloud build's build identity and standing piece on Google Cloud
 * (ADR-0047). On the Hosted instance Google's role is at version 8
 * (version 6's four `cloudbuild.builds` permissions and the Cloud Build
 * API, and a Stack VM's, #1366): a Cloud account last checked at version 5
 * is told to re-run setup before its first cloud deploy, its new script
 * makes the build identity, and each Environment network's runs make the
 * source bucket. A Self-hosted instance, which builds on its platform host,
 * is at version 7, version 5 and a Stack VM's, and makes none of it: its
 * counterparts close the file, with `isHosted` turned off on the same app.
 * Against the fake Google cloud port.
 */
describe("A hosted cloud build's build identity and source bucket on Google Cloud (e2e)", () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const mail = new MailRecorder();
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-gbuild-'));
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    // The network's Deployment log is written on the platform host.
    process.env.CLOUDGATE_DIRECTORY = root;
    // The Service's Deployment is queued and never built here.
    ctx = await createTestApp({
      overrideProviders: [
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        { provide: MailService, useValue: mail },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    mail.clear();
    await ctx.resetDb();
    // The install's own address, which the tokens' issuer is made from.
    await ctx.db
      .insert(webServerSettings)
      .values({ host: 'cloudgate.example.com', https: true });
    await openHostedSignUp(ctx.db);
    ({ cookie, organizationId } = await signUpHostedCustomer(
      http,
      mail,
      customer,
    ));
    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;

    // Connected before this Cloudgate: checked against version 5.
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
        policyVersion: 5,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    cloudAccountId = row.cloudAccountId;
    // A cloud Deploy target is a Cloud Environment on the Hosted plan.
    await ctx.db.insert(subscription).values({
      organizationId,
      plan: 'starter',
      status: 'active',
    });

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

    ctx.google.replayPlanFor('network', 'network-create');
    ctx.google.replayPlanFor('web', 'web-create');
    ctx.google.replayOutputsFor('network', 'network-create');
    ctx.google.calls.length = 0;
    ctx.google.tofuInputs.length = 0;
  });

  const givenSelfHostedInstance = () =>
    jest
      .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
      .mockReturnValue(false);

  async function view(): Promise<View> {
    const res = await request(http)
      .get(`/cloud-accounts/${cloudAccountId}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as View;
  }

  async function template(): Promise<Template> {
    const res = await request(http)
      .get(`/cloud-accounts/${cloudAccountId}/template`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as Template;
  }

  const check = () =>
    request(http)
      .post(`/cloud-accounts/${cloudAccountId}/check`)
      .set('Cookie', cookie);

  /** A new Google Cloud project's setup and connect, through the connect form's two calls. */
  async function connectNew(cloudId: string): Promise<{
    template: Template;
    connected: View;
  }> {
    const setup = await request(http)
      .post('/cloud-accounts/setup')
      .set('Cookie', cookie)
      .send({ cloud: 'gcp', cloudId });
    expect(setup.status).toBe(200);
    const body = setup.body as { setupToken: string; template: Template };
    const names = body.template.names;
    const res = await request(http)
      .post('/cloud-accounts')
      .set('Cookie', cookie)
      .send({
        cloud: 'gcp',
        setupToken: body.setupToken,
        name: 'Second Google',
        cloudId,
        workloadIdentityProvider: `projects/${FAKE_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${names.pool}/providers/${names.provider}`,
        deployServiceAccount: names.serviceAccountEmail,
      });
    expect(res.status).toBe(201);
    return { template: body.template, connected: res.body as View };
  }

  async function currentPlan(): Promise<PlanBody> {
    const res = await request(http)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { plan: PlanBody }).plan;
  }

  /** The open plan of {@link WEB} once Google is read. */
  async function plannedWeb(): Promise<PlanBody> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: WEB });
    expect(saved.status).toBe(201);
    for (let attempt = 0; attempt < 400; attempt++) {
      const found = await currentPlan();
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        expect(found.steps.map((step) => step.action)).toEqual([
          'network-create',
          'create',
        ]);
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading Google Cloud');
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

  /** The Environment network's definitions `tofu` was handed, plan and apply, each with its methods and resources. */
  function networkRuns(): {
    method: string;
    resource: Record<string, Record<string, Record<string, unknown>>>;
  }[] {
    return ctx.google.tofuInputs
      .map((input) => ({
        method: input.method,
        resource:
          (
            JSON.parse(input.definition) as {
              resource?: Record<
                string,
                Record<string, Record<string, unknown>>
              >;
            }
          ).resource ?? {},
      }))
      .filter((run) => run.resource.google_compute_network !== undefined);
  }

  const addressesOf = (resource: Record<string, Record<string, unknown>>) =>
    Object.entries(resource).flatMap(([type, named]) =>
      Object.keys(named).map((local) => `${type}.${local}`),
    );

  /** Plans and applies {@link WEB}, which makes the Environment network first. */
  async function madeNetwork() {
    const read = await plannedWeb();
    const res = await request(http)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    const row = await settled(read.planId);
    expect(row.results?.[0]).toMatchObject({
      action: 'network-create',
      status: 'applied',
    });
    return networkRuns();
  }

  describe('the Cloud account', () => {
    it('tells one checked at version 5 to re-run setup, naming what version 8 adds, before its first cloud deploy', async () => {
      expect(await view()).toMatchObject({
        policyVersion: 5,
        currentPolicyVersion: 8,
        permissionsOutOfDate: true,
      });
      expect((await view()).missingActions.sort()).toEqual(
        [...CLOUD_BUILD_PERMISSIONS, ...STACK_VM_PERMISSIONS].sort(),
      );

      const newer = await template();
      expect(newer.policyVersion).toBe(8);
      expect(newer.roleDefinition).toContain(
        'description: Cloudgate deploy role, version 8',
      );
      const key = idKey(cloudAccountId);
      expect(newer.names.build).toEqual({
        serviceAccount: `cloudgate-build-${key}`,
        serviceAccountEmail: `cloudgate-build-${key}@${PROJECT}.iam.gserviceaccount.com`,
        role: `cloudgate_build_${key}`,
      });
      expect(newer.script).toContain(CLOUD_BUILD_API);
      expect(newer.script).toContain(newer.buildRoleDefinition!.trimEnd());
      expect(newer.script).toContain(
        '--role=roles/logging.logWriter --condition=None',
      );
      // Read from the version table alone: nothing asked Google.
      expect(ctx.google.calls).toEqual([]);
    });

    it('records version 8 once the role made from the new script passes Check now, testing the Cloud Build permissions and API', async () => {
      const res = await check();

      expect(res.body).toMatchObject({
        policyVersion: 8,
        currentPolicyVersion: 8,
        permissionsOutOfDate: false,
        missingActions: [],
        lastCheckResult: 'passed',
      });
      const tested = ctx.google.calls.flatMap((call) =>
        call.method === 'testIamPermissions' ? call.permissions : [],
      );
      expect(tested).toEqual(expect.arrayContaining(CLOUD_BUILD_PERMISSIONS));
      expect(
        ctx.google.calls.some((call) => call.method === 'enabledApis'),
      ).toBe(true);
    });

    it('fails Check now while the Cloud Build API is off, naming it and the setup step', async () => {
      ctx.google.turnOff(CLOUD_BUILD_API);

      const res = await check();

      expect(res.body).toMatchObject({
        policyVersion: 5,
        lastCheckResult: 'failed',
        lastCheckReason: `1 API Cloudgate needs is off in project ${PROJECT}: ${CLOUD_BUILD_API}. Turn it on, as the setup script does`,
      });
    });

    it('connects a new one at version 8, from a script that makes the build identity', async () => {
      const { template: made, connected } = await connectNew('shop-staging');
      expect(made.policyVersion).toBe(8);
      expect(made.names.build).toBeDefined();
      expect(connected).toMatchObject({
        policyVersion: 8,
        permissionsOutOfDate: false,
      });
    });
  });

  describe('the Environment network', () => {
    it("plans and makes a cloud build's source bucket with it, named for the build identity", async () => {
      const runs = await madeNetwork();

      // The plan's read and the Apply's run, each with the bucket.
      expect(runs.map((run) => run.method)).toEqual(
        expect.arrayContaining(['plan', 'apply']),
      );
      for (const run of runs) {
        expect(addressesOf(run.resource)).toContain(BUILD_SOURCE);
        expect(run.resource.google_storage_bucket.build_source).toMatchObject({
          name: buildPieceNames({
            projectId: PROJECT,
            cloudAccountId,
            environmentId,
          }).sourceBucketName,
          location: REGION.toUpperCase(),
          force_destroy: true,
          public_access_prevention: 'enforced',
        });
      }
    });
  });

  describe('a Self-hosted instance, which builds on its platform host', () => {
    beforeEach(() => {
      givenSelfHostedInstance();
    });

    it("asks a Cloud account checked at version 5 for a Stack VM's permissions only, never Cloud Build, from a script with no build identity", async () => {
      expect(await view()).toMatchObject({
        policyVersion: 5,
        currentPolicyVersion: 7,
        permissionsOutOfDate: true,
      });
      expect((await view()).missingActions.sort()).toEqual(
        [...STACK_VM_PERMISSIONS].sort(),
      );
      const same = await template();
      expect(same.policyVersion).toBe(7);
      expect(same.names.build).toBeUndefined();
      expect(same.buildRoleDefinition).toBeUndefined();
      expect(same.script).not.toContain('cloudbuild');
      expect(same.script).not.toContain('BUILD_SERVICE_ACCOUNT');
    });

    it('checks and connects at version 7, testing no Cloud Build permission or API', async () => {
      ctx.google.turnOff(CLOUD_BUILD_API);
      const res = await check();
      expect(res.body).toMatchObject({
        policyVersion: 7,
        permissionsOutOfDate: false,
        lastCheckResult: 'passed',
      });
      expect(JSON.stringify(ctx.google.calls)).not.toContain('cloudbuild');

      const { template: made, connected } = await connectNew('shop-staging');
      expect(made.policyVersion).toBe(7);
      expect(made.names.build).toBeUndefined();
      expect(connected.policyVersion).toBe(7);
    });

    it('makes the Environment network with no source bucket', async () => {
      const runs = await madeNetwork();

      expect(runs.map((run) => run.method)).toEqual(
        expect.arrayContaining(['plan', 'apply']),
      );
      for (const run of runs) {
        const addresses = addressesOf(run.resource);
        expect(addresses).toContain('google_compute_network.network');
        expect(addresses).not.toContain(BUILD_SOURCE);
      }
    });
  });
});
