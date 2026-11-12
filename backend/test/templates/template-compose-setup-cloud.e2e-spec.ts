import { eq } from 'drizzle-orm';
import { parse as parseDotenv } from 'dotenv';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  infrastructureState,
  tofuStates,
} from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import {
  cloudAccount,
  compose,
  domain,
  environmentNetwork,
  mount,
  pendingSetup,
  plan as planTable,
} from '../../src/db/schema';
import type { Plan } from '../../src/db/schema';
import { DomainsService } from '../../src/domains/domains.service';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { MountsService } from '../../src/mounts/mounts.service';
import { handFreshStackVmOn } from '../../src/project-config/applier/template-stack-handoff';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import {
  CatalogueHost,
  catalogueFile,
  SQUARE_SVG,
} from './catalogue-host.fixture';
import type { Folder } from './catalogue-host.fixture';

jest.setTimeout(180_000);

const urlBefore = process.env.CLOUDGATE_TEMPLATES_URL;
const oldUrlBefore = process.env.CLOUDGATE_TEMPLATES_BASE_URL;
delete process.env.CLOUDGATE_TEMPLATES_URL;
delete process.env.CLOUDGATE_TEMPLATES_BASE_URL;

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';
const HOST = 'blog.example.com';

const COMPOSE_FILE = `services:
  ghost:
    image: ghost:5.96-alpine
    environment:
      database__connection__password: \${DB_PASSWORD}
      url: \${SITE_URL}
    volumes:
      - ../files/config.production.json:/var/lib/ghost/config.production.json
`;

/** A Template whose compose part names a minimum size, a Domain and a file. */
const GHOST: Folder = {
  id: 'ghost',
  revision: 'abc1234',
  files: {
    'template.yaml': `name: Ghost
description: A publishing platform.
version: "5.96"
tags: [blog]
cloudgate: 0.1.0
compose: app
size: large
inputs:
  DB_PASSWORD: { generate: password }
  SITE_URL: { value: "{{domains.ghost.url}}" }
domains:
  - { service: ghost, port: 2368 }
files:
  - { path: config.production.json }
`,
    'cloudgate.yaml': `version: 1
services:
  app: { kind: compose, managed: console }
`,
    'docker-compose.yml': COMPOSE_FILE,
    'files/config.production.json': '{ "url": "{{domains.ghost.url}}" }',
    'logo.svg': SQUARE_SVG,
  },
};

const ALB_DNS_NAME = `cg-1234567890.${REGION}.elb.amazonaws.com`;

interface FormBody {
  environments: {
    environmentId: string;
    canTake: boolean;
    hosts: Record<string, string> | null;
    cloudDomains: { pointsAt: { dnsName: string; kind: string } | null } | null;
  }[];
}

/**
 * **A Template's compose part set up in a Cloud Environment** (#1379,
 * ADR-0070, ADR-0065 as amended): the setup form asks for each compose
 * Domain's host with no generated one, the Plan shows the stack's create as
 * a Stack VM line at the template's minimum size, and the Apply hands the
 * stack, its `.env` and its file mounts to the Stack VM create, keeping its
 * Domains in the Pending setup for the cloud Domain path once the Stack VM
 * is made. It stops at that hand-off: the Stack VM's own mechanics are
 * #1357's suites'.
 *
 * Against the fake cloud port, which replays stored real plans, and a
 * stubbed catalogue host.
 */
describe('Template compose part setup in a Cloud Environment (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let userId: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  const host = new CatalogueHost();
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
    execRemote: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: FETCH_CLIENT, useValue: host.fetch },
        { provide: RemoteExecService, useValue: execMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (urlBefore !== undefined)
      process.env.CLOUDGATE_TEMPLATES_URL = urlBefore;
    if (oldUrlBefore !== undefined)
      process.env.CLOUDGATE_TEMPLATES_BASE_URL = oldUrlBefore;
  });

  beforeEach(async () => {
    await ctx.resetDb();
    host.reset();
    host.served = { body: catalogueFile(GHOST) };
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    execMock.execRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });

    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    userId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;
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
        // A role that holds a Stack VM's permissions (#1366).
        policyVersion: 4,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'blog' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;
    const env = await request(server)
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
    environmentId = (env.body as { environmentId: string }).environmentId;

    ctx.cloud.replayPlanFor('network', 'network-create');
    ctx.cloud.replayPlanFor('stack-vm', 'stack-vm-create');
    ctx.cloud.passRunFor('stack-vm');

    // Opening the templates screen saves the catalogue copy setup reads.
    expect(
      (await request(server).get('/templates').set('Cookie', cookie)).status,
    ).toBe(200);
  });

  const setUp = (hosts: Record<string, string> = { ghost: HOST }) =>
    request(server).post('/templates/setup').set('Cookie', cookie).send({
      templateId: 'ghost',
      projectId,
      environmentId,
      setupName: 'ghost',
      values: {},
      hosts,
    });

  async function until<T>(
    look: () => Promise<T | undefined>,
    what: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 600; attempt++) {
      const found = await look();
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Waited in vain for ${what}`);
  }

  /** The open plan, once every step has read AWS. */
  const openPlan = (): Promise<Plan> =>
    until(async () => {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.status, 'open'));
      return found &&
        !found.steps.some(
          (step) =>
            (step.action === 'create' || step.action === 'network-create') &&
            step.cloudRead?.status === 'reading',
        )
        ? found
        : undefined;
    }, 'the plan to read AWS');

  /**
   * The Environment network, made, with the way out a Stack VM needs, so
   * the plan is the stack's create alone and its Apply reads AWS no more.
   */
  async function madeNetwork(): Promise<void> {
    const [account] = await ctx.db.select().from(cloudAccount);
    const [network] = await ctx.db
      .insert(environmentNetwork)
      .values({
        environmentId,
        cloudAccountId: account.cloudAccountId,
        region: REGION,
        status: 'ready',
        vpcId: 'vpc-0a1b',
        publicSubnetIds: ['subnet-0aaa', 'subnet-0bbb'],
        privateSubnetIds: ['subnet-0ccc', 'subnet-0ddd'],
        clusterArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/env`,
        httpsListenerArn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/env/1/2`,
        albSecurityGroupId: 'sg-0alb',
        albDnsName: ALB_DNS_NAME,
        privateLinks: ['nat-gateway'],
      })
      .returning();
    const [networkState] = await ctx.db
      .insert(infrastructureState)
      .values({ environmentNetworkId: network.environmentNetworkId })
      .returning();
    await ctx.db.insert(tofuStates).values({
      name: networkState.infrastructureStateId,
      data: 'encrypted-by-opentofu',
    });
  }

  /** Applies the read plan, once it ends. */
  async function apply(read: Plan): Promise<Plan> {
    expect(read.steps.map((step) => step.action)).toEqual(['create']);
    // The hand-off is where this suite stops: the Stack VM's own Cloud run
    // goes no further than its plan.
    ctx.cloud.failRunFor('stack-vm', 'stopped at the hand-off');
    const res = await request(server)
      .post(`/environments/${environmentId}/plan/apply`)
      .set('Cookie', cookie)
      .send({ planId: read.planId });
    expect(res.status).toBe(200);
    return until(async () => {
      const [found] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, read.planId));
      return found?.results &&
        !found.results.some((result) => result.status === 'running')
        ? found
        : undefined;
    }, 'the Apply to end');
  }

  it('asks for each compose Domain’s host, with no generated one, and says the network’s load balancer is still to be made', async () => {
    const res = await request(server)
      .get('/templates/ghost/setup')
      .query({ projectId })
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect((res.body as FormBody).environments).toEqual([
      expect.objectContaining({
        environmentId,
        canTake: true,
        hosts: null,
        cloudDomains: { pointsAt: null },
      }),
    ]);
  });

  it('names the network’s load balancer each typed host points at, once the network is made', async () => {
    await madeNetwork();

    const res = await request(server)
      .get('/templates/ghost/setup')
      .query({ projectId })
      .set('Cookie', cookie);

    expect((res.body as FormBody).environments[0].cloudDomains).toEqual({
      pointsAt: { dnsName: ALB_DNS_NAME, kind: 'load-balancer' },
    });
  });

  it('refuses a setup that types no host, saving nothing', async () => {
    const res = await setUp({});

    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toBe(
      'The Domain of ghost on port 2368 needs a host',
    );
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
  });

  it('plans the stack as a Stack VM at the template’s minimum size, on the typed host', async () => {
    const res = await setUp();

    expect(res.status).toBe(201);
    const read = await openPlan();
    expect(read.steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);
    expect(read.steps[1]).toMatchObject({
      action: 'create',
      configName: 'ghost-app',
      kind: 'compose',
      fields: [],
      stackVm: {
        size: {
          name: 'large',
          from: 'template',
          machineType: 't3.medium',
        },
        region: REGION,
      },
      template: {
        templateName: 'Ghost',
        domains: [{ service: 'ghost', port: 2368, path: '/', host: HOST }],
        files: [{ path: 'config.production.json', mount: null }],
      },
      cloudRead: { status: 'read' },
    });
  });

  it('hands the stack, its .env and its file mounts to the Stack VM create, keeping its Domains for the cloud Domain path', async () => {
    await madeNetwork();
    await setUp();
    const read = await openPlan();

    const applied = await apply(read);

    const result = applied.results!.find(
      (one) => one.configName === 'ghost-app',
    );
    expect(result?.message ?? null).toBeNull();
    expect(result).toMatchObject({
      status: 'applied',
      serviceType: 'compose',
      deploy: { status: 'queued' },
    });
    const [stack] = await ctx.db
      .select()
      .from(compose)
      .where(eq(compose.configName, 'ghost-app'));
    expect(stack).toMatchObject({
      serverId: null,
      region: REGION,
      sourceType: 'raw',
      composeType: 'docker-compose',
      composeFile: COMPOSE_FILE,
      stackVm: {
        machineType: 't3.medium',
        sizeName: 'large',
        // The template's minimum is the stack's console size: no later
        // plan resizes it down to medium.
        console: { sizeName: 'large' },
        made: null,
      },
    });
    const env = parseDotenv(stack.env ?? '');
    expect(env.SITE_URL).toBe(`https://${HOST}`);
    expect(env.DB_PASSWORD).toMatch(/^[A-Za-z0-9]{32}$/);
    // Its state, the one its plan read.
    expect(
      await ctx.db
        .select()
        .from(infrastructureState)
        .where(eq(infrastructureState.composeId, stack.composeId)),
    ).toHaveLength(1);

    // Its config file is a row, written onto the Stack VM once it answers,
    // never on this machine.
    expect(
      await ctx.db
        .select()
        .from(mount)
        .where(eq(mount.composeId, stack.composeId)),
    ).toEqual([
      expect.objectContaining({
        type: 'file',
        filePath: 'config.production.json',
        content: `{ "url": "https://${HOST}" }`,
      }),
    ]);
    for (const [command] of execMock.execAsync.mock.calls as string[][]) {
      expect(command).not.toContain('config.production.json');
    }

    // No Domain yet: the Stack VM it reaches is not made. It waits in the
    // Pending setup on a part naming the stack, its values gone.
    expect(await ctx.db.select().from(domain)).toEqual([]);
    const [kept] = await ctx.db.select().from(pendingSetup);
    expect(kept.parts).toEqual([
      {
        configName: 'ghost-app',
        kind: 'compose',
        made: {},
        domains: [
          { service: 'ghost', port: 2368, path: '/', host: HOST, https: true },
        ],
        stackId: stack.composeId,
      },
    ]);
    expect(kept.body).toMatchObject({ values: {}, composeFile: null });

    // The next plan never creates the stack from the template again. Its
    // Stack VM, whose Cloud run this suite stopped, is offered as any
    // console-managed stack's, at the template's size kept as its console
    // size rather than medium.
    const checked = await request(server)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', cookie);
    expect(checked.status).toBe(201);
    const again = (
      checked.body as {
        steps: {
          action: string;
          configName?: string;
          template?: unknown;
          stackVm?: { consoleStackId?: string; size: unknown };
        }[];
      }
    ).steps.filter((step) => step.configName === 'ghost-app');
    expect(again).toEqual([
      expect.objectContaining({
        action: 'create',
        stackVm: expect.objectContaining({
          consoleStackId: stack.composeId,
          size: expect.objectContaining({
            name: 'large',
            from: 'console',
          }) as unknown,
        }) as unknown,
      }),
    ]);
    expect(again[0].template).toBeUndefined();
  });

  it('adds the waiting Domains through the cloud Domain path once the Stack VM is made, as the member who applied, then empties the Pending setup', async () => {
    await madeNetwork();
    await setUp();
    const applied = await apply(await openPlan());
    const deploymentId = applied.results!.find(
      (one) => one.configName === 'ghost-app',
    )?.deploy;
    if (deploymentId?.status !== 'queued') throw new Error('no Cloud run');
    const [stack] = await ctx.db
      .select()
      .from(compose)
      .where(eq(compose.configName, 'ghost-app'));
    const domains = { createForNewService: jest.fn().mockResolvedValue({}) };
    const mounts = { writeStackVmFiles: jest.fn().mockResolvedValue(1) };
    const log: string[] = [];

    await handFreshStackVmOn(
      {
        db: ctx.db,
        mounts: mounts as unknown as MountsService,
        domains: domains as unknown as DomainsService,
      },
      {
        deploymentId: deploymentId.deploymentId,
        composeId: stack.composeId,
      },
      (line) => {
        log.push(line);
        return Promise.resolve();
      },
    );

    expect(mounts.writeStackVmFiles).toHaveBeenCalledWith(stack.composeId);
    expect(domains.createForNewService).toHaveBeenCalledWith(
      {
        user: { id: userId },
        session: { activeOrganizationId: organizationId },
      },
      {
        host: HOST,
        path: '/',
        port: 2368,
        serviceName: 'ghost',
        composeId: stack.composeId,
        domainType: 'compose',
        https: true,
      },
    );
    expect(log).toContain(
      `Added Domain ${HOST} for ghost on port 2368, from the template's setup`,
    );
    expect(await ctx.db.select().from(pendingSetup)).toEqual([]);
  });
});
