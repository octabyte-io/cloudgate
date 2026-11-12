import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { ComposeService } from '../../src/compose/compose.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import {
  application,
  auditLog,
  compose,
  deployment,
  previewDeployment,
  schedule,
} from '../../src/db/schema';
import { subscription } from '../../src/cloud/billing/billing.schema';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { ProjectsService } from '../../src/projects/projects.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

/**
 * The write tools, driven from outside (spec Testing Decisions §1
 * and §3): a real Agent key against the real `POST /mcp`, asserting on the
 * answer, the rows it leaves, the queue and the commands it ran.
 *
 * Two boundaries are doubled and nothing else (§1.7): the exec layer, which
 * records every command and answers success, and the deployment queue, a
 * plain list of jobs so a test can say what is waiting and what is running
 * without a build ever starting. Sentences and numbers are written out here,
 * not imported.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const FINALITY =
  'This is an access decision, not a failure. Retrying, or trying another tool or id, will not change it. Tell the operator what you needed.';
const NOT_FOUND_OR_NOT_PERMITTED = `Not found or not permitted. ${FINALITY}`;
const REFUSED = {
  content: [{ type: 'text', text: NOT_FOUND_OR_NOT_PERMITTED }],
  structuredContent: {
    code: 'refused',
    reason: 'grant',
    message: NOT_FOUND_OR_NOT_PERMITTED,
  },
  isError: true,
};

const DB_PASSWORD = 'pg-pass-0e1f2a3b4c';
const WRITE_TOOLS = [
  'deploy_service',
  'start_service',
  'stop_service',
  'cancel_deployment',
];

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** The deployment queue as a list: nothing is ever picked up and built. */
class ListQueue implements QueuePort {
  jobs: QueuedJob[] = [];
  private next = 0;

  add(data: DeploymentJob): Promise<QueuedJob> {
    const job: QueuedJob = {
      id: `job-${++this.next}`,
      data,
      state: 'waiting',
    };
    this.jobs.push(job);
    return Promise.resolve({ ...job });
  }

  getJobs(states?: JobState[]): Promise<QueuedJob[]> {
    return Promise.resolve(
      this.jobs
        .filter((job) => !states || states.includes(job.state))
        .map((job) => ({ ...job })),
    );
  }

  cancel(jobId: string): Promise<boolean> {
    const index = this.jobs.findIndex(
      (job) => job.id === jobId && job.state === 'waiting',
    );
    if (index === -1) return Promise.resolve(false);
    this.jobs.splice(index, 1);
    return Promise.resolve(true);
  }

  clearWaiting(): Promise<QueuedJob[]> {
    const dropped = this.jobs.filter((job) => job.state === 'waiting');
    this.jobs = this.jobs.filter((job) => job.state !== 'waiting');
    return Promise.resolve(dropped);
  }
}

describe('MCP write tools (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;
  let ownerId: string;
  let organizationId: string;

  const queue = new ListQueue();
  const ok = { stdout: '', stderr: '', exitCode: 0 };
  /** Every command run, as one string per command. */
  const commands: string[] = [];
  const execMock = {
    execAsync: jest.fn((command: string) => {
      commands.push(command);
      return Promise.resolve(ok);
    }),
    execAsyncRemote: jest.fn((_serverId: string, command: string) => {
      commands.push(command);
      return Promise.resolve(ok);
    }),
    execFileAsync: jest.fn((file: string, args: string[]) => {
      commands.push([file, ...args].join(' '));
      return Promise.resolve(ok);
    }),
    execRemote: jest.fn((_serverId: string, argv: string[]) => {
      commands.push(argv.join(' '));
      return Promise.resolve(ok);
    }),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    queue.jobs = [];
    commands.length = 0;
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    ownerId = (res.body as { user: { id: string } }).user.id;
    const active = await request(httpServer)
      .get('/organizations/active')
      .set('Cookie', ownerCookie);
    organizationId = (active.body as { id: string }).id;
  });

  const ctxIn = (orgId: string): PermissionCtx => ({
    user: { id: ownerId },
    session: { activeOrganizationId: orgId },
  });

  /**
   * One Project and Environment holding a deployable Application (granted), a
   * second deployable Application (never granted), a raw Compose and a
   * Postgres, and a deployable Application in a second Organization.
   */
  async function tree() {
    const projects = ctx.app.get(ProjectsService);
    const environments = ctx.app.get(EnvironmentsService);
    const applications = ctx.app.get(ApplicationsService);
    const home = ctxIn(organizationId);

    const projectA = await projects.create(home, { name: 'storefront' });
    const a1 = await environments.create(home, {
      name: 'production',
      projectId: projectA.projectId,
    });
    const deployable = async (
      at: PermissionCtx,
      environmentId: string,
      name: string,
      appName: string,
    ) => {
      const app = await applications.create(at, {
        name,
        appName,
        environmentId,
      });
      await ctx.db
        .update(application)
        .set({ sourceType: 'docker', dockerImage: 'nginx:1.27' })
        .where(eq(application.applicationId, app.applicationId));
      return app;
    };
    const app = await deployable(home, a1.environmentId, 'Web', 'web-app');
    const worker = await deployable(
      home,
      a1.environmentId,
      'Worker',
      'worker-app',
    );
    const stack = await ctx.app.get(ComposeService).create(home, {
      name: 'Stack',
      appName: 'stack-app',
      environmentId: a1.environmentId,
    });
    await ctx.db
      .update(compose)
      .set({ sourceType: 'raw', composeFile: 'services: {}\n' })
      .where(eq(compose.composeId, stack.composeId));
    const database = await ctx.app.get(PostgresService).create(home, {
      name: 'Orders',
      appName: 'orders-db',
      databaseName: 'orders',
      databaseUser: 'orders',
      databasePassword: DB_PASSWORD,
      environmentId: a1.environmentId,
    });

    const second = await createOrganization(httpServer, ctx.db, ownerCookie, {
      name: 'Elsewhere',
    });
    expect(second.status).toBe(201);
    const elsewhere = ctxIn((second.body as { id: string }).id);
    const foreignProject = await projects.create(elsewhere, {
      name: 'foreign',
    });
    const foreignEnvironment = await environments.create(elsewhere, {
      name: 'production',
      projectId: foreignProject.projectId,
    });
    const foreign = await deployable(
      elsewhere,
      foreignEnvironment.environmentId,
      'Foreign',
      'foreign-app',
    );

    return { projectA, a1, app, worker, stack, database, foreign };
  }

  type Tree = Awaited<ReturnType<typeof tree>>;

  async function createAgent(
    t: Tree,
    role: 'agentOperator' | 'agentReader',
    services: string[] = [
      t.app.applicationId,
      t.stack.composeId,
      t.database.postgresId,
    ],
  ): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({
        name: 'deploy-bot',
        role,
        grant: {
          accessedProjects: [t.projectA.projectId],
          accessedEnvironments: [t.a1.environmentId],
          accessedServices: services,
        },
      });
    expect(res.status).toBe(201);
    // From here on, `commands` holds only what the calls under test ran.
    commands.length = 0;
    const body = res.body as { agent: { id: string }; key: string };
    return { id: body.agent.id, key: body.key };
  }

  function post(key: string, body: unknown) {
    return request(httpServer)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${key}`)
      .set('MCP-Protocol-Version', '2025-06-18')
      .send(body as object);
  }

  function callTool(
    key: string,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    return post(key, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name, arguments: args },
    });
  }

  function resultOf(res: request.Response): ToolResult {
    expect(res.status).toBe(200);
    return (res.body as { result: ToolResult }).result;
  }

  function payloadOf(res: request.Response): Record<string, unknown> {
    const result = resultOf(res);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }

  async function rowsOf(agentId: string) {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, agentId))
      .orderBy(asc(auditLog.createdAt));
    return rows.map((row) => ({
      userName: row.userName,
      userRole: row.userRole,
      resourceType: row.resourceType,
      action: row.action,
      outcome: row.outcome,
      resourceId: row.resourceId,
      metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
    }));
  }

  async function deploymentRow(deploymentId: string) {
    const [row] = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.deploymentId, deploymentId));
    return row;
  }

  const deployWeb = (key: string, t: Tree, mode?: 'deploy' | 'redeploy') =>
    callTool(key, 'deploy_service', {
      serviceType: 'application',
      serviceId: t.app.applicationId,
      ...(mode ? { mode } : {}),
    });

  describe('the PRD acceptance scenario', () => {
    it('an Operator Agent granted one Service redeploys it, is refused a second Service in the same Environment, a project:update route and the platform host, and each outcome is a row naming the Agent', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator', [
        t.app.applicationId,
      ]);

      // 1. Redeploys its one Service.
      const redeployed = payloadOf(await deployWeb(agent.key, t, 'redeploy'));
      expect(redeployed).toMatchObject({
        serviceType: 'application',
        serviceId: t.app.applicationId,
        status: 'pending',
        coalesced: false,
      });
      const deploymentId = redeployed.deploymentId as string;
      expect(await deploymentRow(deploymentId)).toMatchObject({
        applicationId: t.app.applicationId,
        status: 'pending',
        title: 'Rebuild deployment',
      });
      expect(queue.jobs.map((job) => job.data)).toEqual([
        expect.objectContaining({
          applicationType: 'application',
          applicationId: t.app.applicationId,
          type: 'redeploy',
        }),
      ]);

      // 2. Refused the second Service in the same Environment.
      expect(
        resultOf(
          await callTool(agent.key, 'deploy_service', {
            serviceType: 'application',
            serviceId: t.worker.applicationId,
            mode: 'redeploy',
          }),
        ),
      ).toEqual(REFUSED);
      expect(queue.jobs).toHaveLength(1);

      // 3. Refused anything needing project:update — no tool needs it, so
      // the route that does, with the Agent's key.
      const renamed = await request(httpServer)
        .patch(`/projects/${t.projectA.projectId}`)
        .set('x-api-key', agent.key)
        .send({ name: 'renamed-by-the-agent' });
      expect(renamed.status).toBe(403);
      expect(renamed.body).toMatchObject({ code: 'AGENT_NOT_ALLOWED_HERE' });

      // 4. Cannot reach the platform host: no tool maps to it, and the route
      // refuses the key.
      const host = await request(httpServer)
        .post('/settings/traefik/web-server-config')
        .set('x-api-key', agent.key)
        .send({ traefikConfig: 'http: {}\n' });
      expect(host.status).toBe(403);
      expect(host.body).toMatchObject({ code: 'AGENT_NOT_ALLOWED_HERE' });

      const rows = await rowsOf(agent.id);
      expect(rows).toEqual([
        {
          userName: 'deploy-bot',
          userRole: 'agentOperator',
          resourceType: 'application',
          action: 'deploy',
          outcome: 'succeeded',
          resourceId: t.app.applicationId,
          metadata: expect.objectContaining({
            tool: 'deploy_service',
            mode: 'redeploy',
            coalesced: false,
          }) as unknown,
        },
        {
          userName: 'deploy-bot',
          userRole: 'agentOperator',
          resourceType: 'application',
          action: 'deploy',
          outcome: 'refused',
          resourceId: t.worker.applicationId,
          metadata: expect.objectContaining({
            tool: 'deploy_service',
            reason: 'grant',
          }) as unknown,
        },
        {
          userName: 'deploy-bot',
          userRole: 'agentOperator',
          resourceType: 'project',
          action: 'update',
          outcome: 'refused',
          resourceId: t.projectA.projectId,
          metadata: expect.objectContaining({
            route: 'PATCH /projects/:id',
            reason: 'permission',
          }) as unknown,
        },
        {
          userName: 'deploy-bot',
          userRole: 'agentOperator',
          resourceType: 'settings',
          action: 'update',
          outcome: 'refused',
          resourceId: null,
          metadata: expect.objectContaining({
            route: 'POST /settings/traefik/web-server-config',
            reason: 'permission',
          }) as unknown,
        },
      ]);
      // The REST refusal names the key it came with, as a tool call's row does.
      expect(rows[2].metadata.credential).toEqual(rows[0].metadata.credential);
    });
  });

  describe('a Reader', () => {
    it('is refused deploy_service with the exact 403 body and no WWW-Authenticate, and its tools/list omits the write tools an Operator sees', async () => {
      const t = await tree();
      const reader = await createAgent(t, 'agentReader');
      const operator = await createAgent(t, 'agentOperator');

      const refused = await deployWeb(reader.key, t);
      expect(refused.status).toBe(403);
      expect(refused.headers['www-authenticate']).toBeUndefined();
      expect(refused.body).toEqual({
        code: 'refused',
        reason: 'permission',
        tool: 'deploy_service',
        missing: 'deployment:create',
        message: `This Agent's role does not include deployment:create. ${FINALITY}`,
      });
      expect(queue.jobs).toEqual([]);

      const listed = async (key: string) => {
        const res = await post(key, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        });
        expect(res.status).toBe(200);
        return (
          res.body as {
            result: {
              tools: Array<{
                name: string;
                annotations: { readOnlyHint: boolean };
              }>;
            };
          }
        ).result.tools;
      };
      const readerTools = (await listed(reader.key)).map((tool) => tool.name);
      // The seven reads, get_service_health, the two
      // Requested-preview reads, and the three Project config tools
      // whose plan request is a read's statement.
      expect(readerTools).toHaveLength(13);
      for (const name of WRITE_TOOLS) expect(readerTools).not.toContain(name);

      const operatorTools = await listed(operator.key);
      expect(operatorTools.map((tool) => tool.name)).toEqual([
        ...readerTools.slice(0, 8),
        ...WRITE_TOOLS,
        'create_preview',
        'list_previews',
        'get_preview',
        'extend_preview',
        'redeploy_preview',
        'delete_preview',
        ...readerTools.slice(10),
      ]);
      expect(
        operatorTools
          .filter((tool) => WRITE_TOOLS.includes(tool.name))
          .map((tool) => tool.annotations.readOnlyHint),
      ).toEqual([false, false, false, false]);
    });
  });

  describe('deploy_service coalescing', () => {
    it('answers a repeat deploy with the pending id, coalesced, queues nothing, and audits it succeeded with metadata.coalesced', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');

      const first = payloadOf(await deployWeb(agent.key, t));
      expect(first).toMatchObject({ status: 'pending', coalesced: false });
      const id = first.deploymentId as string;

      const again = await deployWeb(agent.key, t);
      expect(payloadOf(again)).toEqual({
        deploymentId: id,
        serviceType: 'application',
        serviceId: t.app.applicationId,
        status: 'pending',
        title: 'Manual deployment',
        createdAt: first.createdAt,
        coalesced: true,
        message: `Deployment \`${id}\` of this Service was already queued; poll \`list_deployments\` for it. Deploying again will not queue another.`,
      });
      expect(queue.jobs).toHaveLength(1);
      expect(
        await ctx.db
          .select()
          .from(deployment)
          .where(eq(deployment.applicationId, t.app.applicationId)),
      ).toHaveLength(1);

      const rows = await rowsOf(agent.id);
      expect(rows.map((row) => [row.outcome, row.metadata.coalesced])).toEqual([
        ['succeeded', false],
        ['succeeded', true],
      ]);
    });

    it('coalesces a Compose deploy the same way', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');
      const args = { serviceType: 'compose', serviceId: t.stack.composeId };

      const first = payloadOf(
        await callTool(agent.key, 'deploy_service', args),
      );
      const again = payloadOf(
        await callTool(agent.key, 'deploy_service', args),
      );
      expect(again).toMatchObject({
        deploymentId: first.deploymentId,
        serviceType: 'compose',
        coalesced: true,
      });
      expect(queue.jobs).toHaveLength(1);
    });

    it('upgrades a pending redeploy to a deploy: the same id, now reading as a deploy', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');

      const queued = payloadOf(await deployWeb(agent.key, t, 'redeploy'));
      expect(queued.title).toBe('Rebuild deployment');
      expect(
        (await deploymentRow(queued.deploymentId as string)).queuedAs,
      ).toEqual({ applicationType: 'application', type: 'redeploy' });

      const upgraded = payloadOf(await deployWeb(agent.key, t, 'deploy'));
      expect(upgraded).toMatchObject({
        deploymentId: queued.deploymentId,
        title: 'Manual deployment',
        coalesced: true,
      });
      expect(await deploymentRow(queued.deploymentId as string)).toMatchObject({
        status: 'pending',
        title: 'Manual deployment',
        // What a restart queues it again as.
        queuedAs: { applicationType: 'application', type: 'deploy' },
      });
      expect(queue.jobs).toHaveLength(1);

      // A redeploy on a pending deploy leaves it a deploy.
      const kept = payloadOf(await deployWeb(agent.key, t, 'redeploy'));
      expect(kept).toMatchObject({
        deploymentId: queued.deploymentId,
        title: 'Manual deployment',
        coalesced: true,
      });
    });

    it('does not coalesce onto a running build: a new Deployment is queued behind it', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');

      const first = payloadOf(await deployWeb(agent.key, t));
      // The build starts: its job is taken and its record claimed.
      queue.jobs[0].state = 'active';
      await ctx.db
        .update(deployment)
        .set({ status: 'running', startedAt: new Date().toISOString() })
        .where(eq(deployment.deploymentId, first.deploymentId as string));

      const second = payloadOf(await deployWeb(agent.key, t));
      expect(second.deploymentId).not.toBe(first.deploymentId);
      expect(second).toMatchObject({ status: 'pending', coalesced: false });
      expect(queue.jobs.map((job) => job.state)).toEqual(['active', 'waiting']);
    });

    it('does not coalesce onto a pending record no queued job will ever build', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');

      const first = payloadOf(await deployWeb(agent.key, t));
      // A restart drops the in-memory queue and leaves the record pending.
      queue.jobs = [];

      const second = payloadOf(await deployWeb(agent.key, t));
      expect(second.deploymentId).not.toBe(first.deploymentId);
      expect(second.coalesced).toBe(false);
      expect(queue.jobs).toHaveLength(1);
    });

    /**
     * `joinQueuedBuild` joins only a waiting production job's own `pending`
     * row. Each case below leaves a `pending` record of the
     * Service and a job waiting in its queue group, so a join by group or by
     * the oldest pending row would coalesce onto it.
     */
    it("does not coalesce onto a preview's pending build: it is the parent's Deployment, but not production's", async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');
      const [preview] = await ctx.db
        .insert(previewDeployment)
        .values({
          applicationId: t.app.applicationId,
          branch: 'feature/health',
          pullRequestId: '990001',
          pullRequestNumber: '42',
          pullRequestTitle: 'Add health endpoint',
          pullRequestURL: 'https://github.com/example-org/shop/pull/42',
          appName: 'preview-web-app-abc123',
          domain: 'preview-web-app-abc123.example.com',
        })
        .returning();
      const previewBuild = await ctx.app
        .get(DeploymentsService)
        .queuePreviewBuild(preview, 'deploy', {
          title: 'Preview Deployment',
          description: 'Pull request #42',
        });

      const deployed = payloadOf(await deployWeb(agent.key, t));
      expect(deployed.deploymentId).not.toBe(previewBuild.deploymentId);
      expect(deployed).toMatchObject({ status: 'pending', coalesced: false });
      expect(queue.jobs).toHaveLength(2);
      expect(await deploymentRow(previewBuild.deploymentId)).toMatchObject({
        status: 'pending',
        previewDeploymentId: preview.previewDeploymentId,
      });
    });

    it('does not coalesce onto a waiting job that names no row, as one read back from the cloud deploy API', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');

      const first = payloadOf(await deployWeb(agent.key, t));
      const data = queue.jobs[0].data;
      if (data.applicationType !== 'application') throw new Error(data.type);
      queue.jobs[0].data = { ...data, deploymentId: null };

      const second = payloadOf(await deployWeb(agent.key, t));
      expect(second.deploymentId).not.toBe(first.deploymentId);
      expect(second).toMatchObject({ status: 'pending', coalesced: false });
      expect(queue.jobs).toHaveLength(2);
    });

    it('does not coalesce onto a waiting job whose own row is no longer pending', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');

      const first = payloadOf(await deployWeb(agent.key, t));
      // The job still waits, but the row it names has settled.
      await ctx.db
        .update(deployment)
        .set({ status: 'cancelled', finishedAt: new Date().toISOString() })
        .where(eq(deployment.deploymentId, first.deploymentId as string));

      const second = payloadOf(await deployWeb(agent.key, t));
      expect(second.deploymentId).not.toBe(first.deploymentId);
      expect(second).toMatchObject({ status: 'pending', coalesced: false });
      expect(queue.jobs.map((job) => job.state)).toEqual([
        'waiting',
        'waiting',
      ]);
      expect(await deploymentRow(first.deploymentId as string)).toMatchObject({
        status: 'cancelled',
      });
    });

    it('answers a Service with no source with declared text and no finality sentence', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');
      await ctx.db
        .update(application)
        .set({ sourceType: 'github', repository: null })
        .where(eq(application.applicationId, t.app.applicationId));

      const text =
        'This Service has no source to deploy from. An operator sets its source in the console; deploy again after that.';
      expect(resultOf(await deployWeb(agent.key, t))).toEqual({
        content: [{ type: 'text', text }],
        structuredContent: { code: 'failed', message: text },
        isError: true,
      });
      expect(queue.jobs).toEqual([]);
    });
  });

  describe('the write budget', () => {
    it('spends the write budget: a sixth write inside a minute is a 429, while a read still answers', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');

      for (let i = 0; i < 5; i += 1) {
        expect(resultOf(await deployWeb(agent.key, t)).isError).toBeFalsy();
      }
      const limited = await deployWeb(agent.key, t);
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.body).toMatchObject({
        code: 'refused',
        reason: 'rate-limit',
        tool: 'deploy_service',
      });

      const read = await callTool(agent.key, 'list_deployments', {
        serviceType: 'application',
        serviceId: t.app.applicationId,
      });
      expect(read.status).toBe(200);
    });
  });

  describe('start_service and stop_service', () => {
    it('stops and starts a database with a detached scale and answers "requested", never the row or its password', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');
      const args = {
        serviceType: 'postgres',
        serviceId: t.database.postgresId,
      };

      const stopped = await callTool(agent.key, 'stop_service', args);
      expect(payloadOf(stopped)).toEqual({
        serviceType: 'postgres',
        serviceId: t.database.postgresId,
        requested: 'stop',
        message:
          "Stop requested. Poll get_environment or get_service for this Service's status.",
      });
      const text = resultOf(stopped).content[0].text;
      expect(text).not.toContain(DB_PASSWORD);
      expect(text).not.toContain('databasePassword');

      const started = await callTool(agent.key, 'start_service', args);
      expect(payloadOf(started)).toMatchObject({ requested: 'start' });
      expect(resultOf(started).content[0].text).not.toContain(DB_PASSWORD);

      expect(commands).toEqual([
        'docker service scale --detach orders-db=0',
        'docker service scale --detach orders-db=1',
      ]);
      expect(
        (await rowsOf(agent.id)).map((row) => [
          row.resourceType,
          row.action,
          row.outcome,
          row.metadata.tool,
        ]),
      ).toEqual([
        ['database', 'stop', 'succeeded', 'stop_service'],
        ['database', 'start', 'succeeded', 'start_service'],
      ]);
    });

    it("scales an Application detached, and leaves the console's own scale attached", async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');

      expect(
        payloadOf(
          await callTool(agent.key, 'stop_service', {
            serviceType: 'application',
            serviceId: t.app.applicationId,
          }),
        ),
      ).toMatchObject({ requested: 'stop' });
      const console = await request(httpServer)
        .post(`/postgres/${t.database.postgresId}/stop`)
        .set('Cookie', ownerCookie);
      expect(console.status).toBeLessThan(300);

      expect(commands).toEqual([
        'docker service scale --detach web-app=0',
        'docker service scale orders-db=0',
      ]);
    });

    it('deploys, stops and starts an AI model as the Application it is, audited as one', async () => {
      const t = await tree();
      const llm = await ctx.app
        .get(ApplicationsService)
        .create(ctxIn(organizationId), {
          name: 'Llama',
          appName: 'llama-app',
          environmentId: t.a1.environmentId,
          aiModel: { runtime: 'ollama', model: 'smollm2:135m' },
        });
      const agent = await createAgent(t, 'agentOperator', [llm.applicationId]);
      const args = { serviceType: 'application', serviceId: llm.applicationId };

      const deployed = payloadOf(
        await callTool(agent.key, 'deploy_service', args),
      );
      expect(deployed).toMatchObject({
        serviceType: 'application',
        serviceId: llm.applicationId,
        status: 'pending',
        coalesced: false,
      });
      expect(queue.jobs.map((job) => job.data)).toEqual([
        expect.objectContaining({ applicationId: llm.applicationId }),
      ]);
      // The deploy's own log setup; from here on, only the scales.
      commands.length = 0;
      expect(
        payloadOf(await callTool(agent.key, 'stop_service', args)),
      ).toMatchObject({ requested: 'stop' });
      expect(
        payloadOf(await callTool(agent.key, 'start_service', args)),
      ).toMatchObject({ requested: 'start' });

      expect(commands).toEqual([
        'docker service scale --detach llama-app=0',
        'docker service scale --detach llama-app=1',
      ]);
      expect(
        (await rowsOf(agent.id)).map((row) => [
          row.resourceType,
          row.action,
          row.outcome,
          row.resourceId,
          row.metadata.tool,
        ]),
      ).toEqual([
        [
          'application',
          'deploy',
          'succeeded',
          llm.applicationId,
          'deploy_service',
        ],
        ['application', 'stop', 'succeeded', llm.applicationId, 'stop_service'],
        [
          'application',
          'start',
          'succeeded',
          llm.applicationId,
          'start_service',
        ],
      ]);
    });

    it('stops a Compose stack, synchronously, with the same answer', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');

      expect(
        payloadOf(
          await callTool(agent.key, 'stop_service', {
            serviceType: 'compose',
            serviceId: t.stack.composeId,
          }),
        ),
      ).toEqual({
        serviceType: 'compose',
        serviceId: t.stack.composeId,
        requested: 'stop',
        message:
          "Stop requested. Poll get_environment or get_service for this Service's status.",
      });
      expect(commands.some((command) => command.includes('stop'))).toBe(true);
    });
  });

  describe('a Frozen Organization (ADR-0052)', () => {
    it('refuses a write tool with the frozen error, runs nothing, and keeps the reads', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');
      // The Hosted instance, where an Organization can be frozen; lapsed as
      // the billing webhook records it.
      jest
        .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
        .mockReturnValue(true);
      await ctx.db.insert(subscription).values({
        organizationId,
        status: 'canceled',
        lapsedAt: new Date(),
      });

      const stopped = await callTool(agent.key, 'stop_service', {
        serviceType: 'postgres',
        serviceId: t.database.postgresId,
      });
      expect(resultOf(stopped)).toEqual({
        content: [{ type: 'text', text: 'Pay to continue' }],
        structuredContent: {
          code: 'refused',
          reason: 'frozen',
          message: 'Pay to continue',
        },
        isError: true,
      });
      expect(commands).toEqual([]);
      const rows = await rowsOf(agent.id);
      expect(rows.at(-1)).toEqual(
        expect.objectContaining({ outcome: 'refused' }),
      );
      expect(rows.at(-1)?.metadata).toEqual(
        expect.objectContaining({ reason: 'frozen' }),
      );

      const read = await callTool(agent.key, 'list_projects');
      expect(resultOf(read).isError).toBeFalsy();
      jest.restoreAllMocks();
    });
  });

  describe('cancel_deployment', () => {
    it('cancels a queued deploy, and answers one already finished with declared text and no finality sentence', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator');
      const queued = payloadOf(await deployWeb(agent.key, t));

      const cancelled = await callTool(agent.key, 'cancel_deployment', {
        deploymentId: queued.deploymentId,
      });
      expect(payloadOf(cancelled)).toMatchObject({
        deploymentId: queued.deploymentId,
        serviceType: 'application',
        serviceId: t.app.applicationId,
        status: 'cancelled',
      });
      expect(queue.jobs).toEqual([]);

      const text =
        'This Deployment cannot be cancelled now: it has already finished, is releasing its image, or is no longer held in the queue. Poll list_deployments for its status.';
      expect(
        resultOf(
          await callTool(agent.key, 'cancel_deployment', {
            deploymentId: queued.deploymentId,
          }),
        ),
      ).toEqual({
        content: [{ type: 'text', text }],
        structuredContent: { code: 'failed', message: text },
        isError: true,
      });
      expect(
        (await rowsOf(agent.id))
          .slice(1)
          .map((row) => [row.resourceType, row.action, row.outcome]),
      ).toEqual([
        ['deployment', 'cancel', 'succeeded'],
        ['deployment', 'cancel', 'failed'],
      ]);
    });
  });

  describe('grant refusals', () => {
    it('answers a nonexistent id, an id in another Organization and an ungranted id with one byte-identical refusal, on every write tool', async () => {
      const t = await tree();
      const run = async (applicationId: string) => {
        const [row] = await ctx.db
          .insert(deployment)
          .values({
            title: 'Manual deployment',
            status: 'pending',
            logPath: '/nowhere.log',
            applicationId,
          })
          .returning();
        return row.deploymentId;
      };
      const [cron] = await ctx.db
        .insert(schedule)
        .values({
          name: 'Nightly',
          cronExpression: '0 3 * * *',
          command: 'npm run nightly',
          scheduleType: 'application',
          applicationId: t.app.applicationId,
        })
        .returning();
      const [scheduleRun] = await ctx.db
        .insert(deployment)
        .values({
          title: 'Nightly',
          status: 'running',
          logPath: '/nowhere.log',
          scheduleId: cron.scheduleId,
        })
        .returning();

      const serviceIds = [
        'no-such-service',
        t.foreign.applicationId,
        t.worker.applicationId,
      ];
      const byService = serviceIds.map((serviceId) => ({
        serviceType: 'application',
        serviceId,
      }));
      const cases: Array<[string, Array<Record<string, unknown>>]> = [
        ['deploy_service', byService],
        ['start_service', byService],
        ['stop_service', byService],
        [
          'cancel_deployment',
          [
            'no-such-deployment',
            await run(t.foreign.applicationId),
            await run(t.worker.applicationId),
            // A schedule's run on a granted Service: not a build.
            scheduleRun.deploymentId,
          ].map((deploymentId) => ({ deploymentId })),
        ],
      ];

      const answers: string[] = [];
      const agents: string[] = [];
      for (const [tool, calls] of cases) {
        // An Agent per tool: four writes fit one write burst.
        const agent = await createAgent(t, 'agentOperator');
        agents.push(agent.id);
        const mine: string[] = [];
        for (const args of calls) {
          mine.push(
            JSON.stringify(resultOf(await callTool(agent.key, tool, args))),
          );
        }
        expect({ tool, distinct: new Set(mine).size }).toEqual({
          tool,
          distinct: 1,
        });
        answers.push(...mine);
      }
      expect(new Set(answers).size).toBe(1);
      expect(JSON.parse(answers[0])).toEqual(REFUSED);

      // Nothing was queued, scaled or cancelled.
      expect(queue.jobs).toEqual([]);
      expect(commands).toEqual([]);
      const rows = (
        await Promise.all(agents.map((agentId) => rowsOf(agentId)))
      ).flat();
      expect(rows).toHaveLength(13);
      expect(
        rows.every(
          (row) => row.outcome === 'refused' && row.metadata.reason === 'grant',
        ),
      ).toBe(true);
    });
  });
});
