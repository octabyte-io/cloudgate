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

import {
  requiredActions,
  stackVmActionsMissing,
} from '../../src/cloud-accounts/aws/setup-template';
import { cloudAccount, plan as planTable } from '../../src/db/schema';
import type { Plan } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { subscription } from '../../src/cloud/billing/billing.schema';
import { MailService } from '../../src/mail/mail.service';
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

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const DEPLOY_ROLE = `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy`;
const EXECUTION_ROLE = `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution`;

const WEB = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
`;

/** What version 3 adds over version 2: a hosted cloud build's CodeBuild. */
const CODEBUILD_ACTIONS = [
  'codebuild:BatchGetBuilds',
  'codebuild:BatchGetProjects',
  'codebuild:CreateProject',
  'codebuild:DeleteProject',
  'codebuild:ListBuildsForProject',
  'codebuild:StartBuild',
  'codebuild:StopBuild',
  'codebuild:UpdateProject',
];

/**
 * What versions 4 and 5 add, on either instance: a Stack VM's actions
 * (#1366), read from the shipped table, less those version 2 already
 * grants for a cloud `web` (`ec2:CreateTags`, the role actions, the SSM
 * parameter reads), which the standing names as missing no more than the
 * role lacks them.
 */
const STACK_VM_ACTIONS = stackVmActionsMissing(2).filter(
  (action) => !requiredActions(2).includes(action),
);

/** A cloud build's standing pieces, as the network's definition names them. */
const BUILD_PIECES = [
  'aws_codebuild_project.build',
  'aws_s3_bucket.build_source',
  'aws_cloudwatch_log_group.build',
];

/** What `tofu output -json` answers after the network's apply. */
const OUTPUTS = {
  vpc_id: 'vpc-0f00ba11',
  public_subnet_ids: ['subnet-0a11', 'subnet-0b22'],
  private_subnet_ids: ['subnet-0c33', 'subnet-0d44'],
  cluster_arn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/cloudgate-env`,
  alb_arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/cg/50dc6c495c0c9188`,
  alb_dns_name: `cg-1234567890.${REGION}.elb.amazonaws.com`,
  alb_zone_id: 'Z215JYRZR1TBD5',
  alb_security_group_id: 'sg-0a1b',
  https_listener_arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/cg/50dc6c495c0c9188/f2f7dc8efc522ab2`,
  default_certificate_arn: `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/0e4a7d52-2b1c-4f0d-9a43-5b3c1c2d7e11`,
};

interface View {
  cloudAccountId: string;
  policyVersion: number;
  currentPolicyVersion: number;
  permissionsOutOfDate: boolean;
  missingActions: string[];
}

interface Template {
  policyVersion: number;
  cloudFormation: string;
  json: { buildRole?: { name: string } };
}

interface PlanBody {
  planId: string;
  steps: {
    action: string;
    cloudRead?: { status: string; stateId?: string };
  }[];
}

/**
 * A hosted cloud build's build identity and standing pieces (ADR-0047).
 * On the Hosted instance AWS's policy is at version 5 (version 3's
 * CodeBuild and the build identity to pass, and a Stack VM's, #1366): a
 * Cloud account last checked at version 2 is told to re-run setup before
 * its first cloud deploy, its new template makes the build identity, and
 * each Environment network's runs make the CodeBuild project, the source
 * bucket and the log group. A Self-hosted instance, which builds on its
 * platform host, is at version 4, version 2 and a Stack VM's, and makes
 * none of it: its counterparts close the file, with `isHosted` turned off
 * on the same app.
 */
describe("A hosted cloud build's build identity and standing pieces (e2e)", () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-build-'));
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    getJobs: jest.fn().mockResolvedValue([]),
    cancel: jest.fn(),
  };
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;
  const mail = new MailRecorder();

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
    // A customer of the Hosted instance, its email confirmed.
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

    // Connected before this Cloudgate: checked against version 2.
    const [row] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name: 'Production AWS',
        cloud: 'aws',
        cloudId: ACCOUNT,
        accessKeyId: KEY,
        secretAccessKey: SECRET,
        deployRoleArn: DEPLOY_ROLE,
        taskExecutionRoleArn: EXECUTION_ROLE,
        externalId: 'external-id-made-by-cloudgate',
        policyVersion: 2,
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

    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('web', 'web-create');
    ctx.cloud.calls.length = 0;
    ctx.cloud.tofuInputs.length = 0;
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

  /** A new AWS account's setup and connect, through the connect form's two calls. */
  async function connectNew(cloudId: string): Promise<{
    template: Template;
    connected: View;
  }> {
    const setup = await request(http)
      .post('/cloud-accounts/setup')
      .set('Cookie', cookie)
      .send({ cloudId });
    expect(setup.status).toBe(200);
    const body = setup.body as { setupToken: string; template: Template };
    const res = await request(http)
      .post('/cloud-accounts')
      .set('Cookie', cookie)
      .send({
        setupToken: body.setupToken,
        name: 'Second AWS',
        cloudId,
        accessKeyId: KEY,
        secretAccessKey: SECRET,
        deployRoleArn: `arn:aws:iam::${cloudId}:role/cloudgate-deploy`,
        taskExecutionRoleArn: `arn:aws:iam::${cloudId}:role/cloudgate-task-execution`,
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

  /** The open plan of {@link WEB} once AWS is read, with the network's outputs scripted. */
  async function plannedWeb(): Promise<PlanBody> {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: WEB });
    expect(saved.status).toBe(201);
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = await currentPlan();
      if (!found.steps.some((step) => step.cloudRead?.status === 'reading')) {
        expect(found.steps.map((step) => step.action)).toEqual([
          'network-create',
          'create',
        ]);
        ctx.cloud.outputsFor(found.steps[0].cloudRead!.stateId!, OUTPUTS);
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The plan was still reading AWS');
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

  /** The Environment network's definitions `tofu` was handed, plan and apply, as their resources' addresses. */
  function networkRuns(): string[][] {
    return ctx.cloud.tofuInputs
      .map(
        (input) =>
          JSON.parse(input.definition) as {
            resource?: Record<string, Record<string, unknown>>;
          },
      )
      .filter((definition) => definition.resource?.aws_vpc !== undefined)
      .map((definition) =>
        Object.entries(definition.resource ?? {}).flatMap(([type, named]) =>
          Object.keys(named).map((local) => `${type}.${local}`),
        ),
      );
  }

  /** Plans and applies {@link WEB}, which makes the Environment network first. */
  async function madeNetwork(): Promise<string[][]> {
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
    it('tells one checked at version 2 to re-run setup, naming what version 5 adds, before its first cloud deploy', async () => {
      expect(await view()).toMatchObject({
        policyVersion: 2,
        currentPolicyVersion: 5,
        permissionsOutOfDate: true,
      });
      expect((await view()).missingActions.sort()).toEqual(
        [...CODEBUILD_ACTIONS, ...STACK_VM_ACTIONS].sort(),
      );

      const newer = await template();
      expect(newer.policyVersion).toBe(5);
      expect(newer.json.buildRole?.name).toBe(
        `cloudgate-build-${cloudAccountId}`,
      );
      expect(newer.cloudFormation).toContain('CloudgateBuildRole');
      // Read from the version table alone: nothing asked AWS.
      expect(ctx.cloud.calls).toEqual([]);
    });

    it('records version 5 once the role made from the new template passes Check now, passing the build identity only to CodeBuild', async () => {
      const res = await request(http)
        .post(`/cloud-accounts/${cloudAccountId}/check`)
        .set('Cookie', cookie);

      expect(res.body).toMatchObject({
        policyVersion: 5,
        permissionsOutOfDate: false,
        missingActions: [],
        lastCheckResult: 'passed',
      });
      const simulated = ctx.cloud.calls.flatMap((call) =>
        call.method === 'simulatePrincipalPolicy' ? [call] : [],
      );
      expect(simulated.flatMap((call) => call.actions)).toEqual(
        expect.arrayContaining(CODEBUILD_ACTIONS),
      );
      expect(simulated).toContainEqual(
        expect.objectContaining({
          actions: ['iam:PassRole'],
          resourceArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-build-${cloudAccountId}`,
          context: [
            {
              key: 'iam:PassedToService',
              values: ['codebuild.amazonaws.com'],
              type: 'string',
            },
          ],
        }),
      );
    });

    it('connects a new one at version 5, from a template that makes the build identity', async () => {
      const { template: made, connected } = await connectNew('210987654321');
      expect(made.policyVersion).toBe(5);
      expect(made.json.buildRole).toBeDefined();
      expect(connected).toMatchObject({
        policyVersion: 5,
        permissionsOutOfDate: false,
      });
    });
  });

  describe('the Environment network', () => {
    it("plans and makes a cloud build's CodeBuild project, source bucket and log group with it", async () => {
      const runs = await madeNetwork();

      // The plan's read and the Apply's run, each with the pieces.
      expect(runs.length).toBeGreaterThanOrEqual(2);
      for (const addresses of runs) {
        expect(addresses).toEqual(expect.arrayContaining(BUILD_PIECES));
      }
    });
  });

  describe('a Self-hosted instance, which builds on its platform host', () => {
    beforeEach(() => {
      givenSelfHostedInstance();
    });

    it("asks a Cloud account checked at version 2 for a Stack VM's actions only, never CodeBuild, from a template with no build identity", async () => {
      expect(await view()).toMatchObject({
        policyVersion: 2,
        currentPolicyVersion: 4,
        permissionsOutOfDate: true,
      });
      expect((await view()).missingActions.sort()).toEqual(
        [...STACK_VM_ACTIONS].sort(),
      );
      const same = await template();
      expect(same.policyVersion).toBe(4);
      expect(same.json.buildRole).toBeUndefined();
      expect(same.cloudFormation).not.toContain('codebuild');
    });

    it('checks and connects at version 4, simulating no CodeBuild', async () => {
      const res = await request(http)
        .post(`/cloud-accounts/${cloudAccountId}/check`)
        .set('Cookie', cookie);
      expect(res.body).toMatchObject({
        policyVersion: 4,
        permissionsOutOfDate: false,
        lastCheckResult: 'passed',
      });
      expect(JSON.stringify(ctx.cloud.calls)).not.toContain('codebuild');

      const { template: made, connected } = await connectNew('210987654321');
      expect(made.policyVersion).toBe(4);
      expect(made.json.buildRole).toBeUndefined();
      expect(connected.policyVersion).toBe(4);
    });

    it('makes the Environment network with no standing pieces of a cloud build', async () => {
      const runs = await madeNetwork();

      expect(runs.length).toBeGreaterThanOrEqual(2);
      for (const addresses of runs) {
        expect(addresses).toContain('aws_vpc.network');
        expect(addresses.filter((one) => BUILD_PIECES.includes(one))).toEqual(
          [],
        );
      }
    });
  });
});
