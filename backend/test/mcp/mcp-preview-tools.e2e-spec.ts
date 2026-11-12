import { and, asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { application, auditLog, previewDeployment } from '../../src/db/schema';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * The six Requested-preview tools (, ADR-0026), driven from
 * outside: real Agent keys against the real `POST /mcp`, asserting on the
 * answers, the rows they leave and the queue. The exec layer and the
 * deployment queue are doubled and nothing else; no build ever runs.
 * Sentences are written out here, not imported.
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
const failed = (text: string) => ({
  content: [{ type: 'text', text }],
  structuredContent: { code: 'failed', message: text },
  isError: true,
});

const SWITCH_REFUSAL = 'Requested previews are not allowed on this Application';
const CAP_REFUSAL =
  "This Application already holds as many requested previews as its limit allows. Deleting one with delete_preview expires it now; a slot frees once an expired preview's teardown finishes, whether it was deleted or ran out its time, and list_previews shows each one's expiresAt. This Application's operator sets the limit.";
const NO_ADDRESS_REFUSAL =
  "This Application sets no preview wildcard and no IP is recorded for the machine its previews run on, so a preview would have no host that resolves. Its operator can set a preview wildcard on the Application, or record the machine's public IP.";
const NO_ADDRESS_HTTP =
  'A preview host carries an IP in its name when its Application sets no preview wildcard, and no IP is recorded for this Cloudgate host: set its public address in Settings → Instance, or set a preview wildcard on the Application, then ask again';
const EXPIRED_REFUSAL =
  'This preview has expired and is being torn down; ask for a new one with create_preview.';

/** A stored env value the mask and the projection must both keep out. */
const ENV_SECRET = 'STRIPE_KEY=sk_live_4f5e6d7c8b9a';

const READ_TOOLS = [
  'list_projects',
  'list_environments',
  'get_environment',
  'get_service',
  'list_deployments',
  'read_deployment_log',
  'list_domains',
  'get_service_health',
];
const WRITE_TOOLS = [
  'deploy_service',
  'start_service',
  'stop_service',
  'cancel_deployment',
];
const PREVIEW_TOOLS = [
  'create_preview',
  'list_previews',
  'get_preview',
  'extend_preview',
  'redeploy_preview',
  'delete_preview',
];
/** The Project config tools, on statements both roles hold. */
const PROJECT_CONFIG_TOOLS = ['get_project_config', 'get_plan', 'request_plan'];

/** What one preview answers: its fields, and nothing else. */
const PREVIEW_KEYS = [
  'applicationId',
  'branch',
  'createdAt',
  'expired',
  'expiresAt',
  'latestDeploymentId',
  'previewDeploymentId',
  'requestedByYou',
  'status',
  'url',
  'urlNote',
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
    const job: QueuedJob = { id: `job-${++this.next}`, data, state: 'waiting' };
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

describe('MCP Requested-preview tools (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;
  let ownerId: string;
  let organizationId: string;

  const queue = new ListQueue();
  const ok = { stdout: '', stderr: '', exitCode: 0 };
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

  const ownerCtx = (): PermissionCtx => ({
    user: { id: ownerId },
    session: { activeOrganizationId: organizationId },
  });

  /**
   * A git-sourced Application allowing requested previews, carrying a stored
   * env secret, a second one nobody is granted, and a pull-request preview
   * of the first.
   */
  async function tree() {
    const home = ownerCtx();
    const project = await ctx.app
      .get(ProjectsService)
      .create(home, { name: 'storefront' });
    const environment = await ctx.app.get(EnvironmentsService).create(home, {
      name: 'production',
      projectId: project.projectId,
    });
    const applications = ctx.app.get(ApplicationsService);
    const gitApp = async (name: string, appName: string) => {
      const app = await applications.create(home, {
        name,
        appName,
        environmentId: environment.environmentId,
      });
      await ctx.db
        .update(application)
        .set({
          sourceType: 'git',
          customGitUrl: 'https://git.example.com/acme/web.git',
          customGitBranch: 'main',
          previewWildcard: '*.preview.example.com',
          requestedPreviewsAllowed: true,
          env: ENV_SECRET,
        })
        .where(eq(application.applicationId, app.applicationId));
      return app;
    };
    const app = await gitApp('Web', 'web-app');
    const other = await gitApp('Other', 'other-app');
    const [pullRequest] = await ctx.db
      .insert(previewDeployment)
      .values({
        applicationId: app.applicationId,
        trigger: 'pullRequest',
        branch: 'feature/pr',
        pullRequestId: '1',
        pullRequestNumber: '1',
        pullRequestTitle: 'One',
        pullRequestURL: 'https://github.com/acme/web/pull/1',
        appName: 'preview-web-app-pr1',
        domain: 'preview-web-app-pr1.preview.example.com',
      })
      .returning();
    return { project, environment, app, other, pullRequest };
  }

  type Tree = Awaited<ReturnType<typeof tree>>;

  async function createAgent(
    t: Tree,
    role: 'agentOperator' | 'agentReader',
    name: string,
    services: string[] = [t.app.applicationId],
  ): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({
        name,
        role,
        grant: {
          accessedProjects: [t.project.projectId],
          accessedEnvironments: [t.environment.environmentId],
          accessedServices: services,
        },
      });
    expect(res.status).toBe(201);
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

  const callTool = (
    key: string,
    name: string,
    args: Record<string, unknown> = {},
  ) =>
    post(key, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name, arguments: args },
    });

  async function resultOf(
    pending: ReturnType<typeof callTool>,
  ): Promise<ToolResult> {
    const res = await pending;
    expect(res.status).toBe(200);
    return (res.body as { result: ToolResult }).result;
  }

  async function payloadOf<T = Record<string, unknown>>(
    pending: ReturnType<typeof callTool>,
  ): Promise<T> {
    const result = await resultOf(pending);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text) as T;
  }

  async function listed(key: string): Promise<string[]> {
    const res = await post(key, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(res.status).toBe(200);
    return (
      res.body as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((tool) => tool.name);
  }

  async function rowsOf(agentId: string) {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, agentId))
      .orderBy(asc(auditLog.createdAt));
    return rows.map((row) => ({
      resourceType: row.resourceType,
      action: row.action,
      outcome: row.outcome,
      resourceId: row.resourceId,
      metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
    }));
  }

  const create = (key: string, t: Tree, extra: object = {}) =>
    callTool(key, 'create_preview', {
      applicationId: t.app.applicationId,
      branch: 'feature/login',
      ...extra,
    });

  describe('visibility', () => {
    it("adds exactly two tools to a Reader's list and six to an Operator's, whatever the Application", async () => {
      const t = await tree();
      const reader = await createAgent(t, 'agentReader', 'read-bot');
      const operator = await createAgent(t, 'agentOperator', 'op-bot');

      expect(await listed(reader.key)).toEqual([
        ...READ_TOOLS,
        'list_previews',
        'get_preview',
        ...PROJECT_CONFIG_TOOLS,
      ]);
      expect(await listed(operator.key)).toEqual([
        ...READ_TOOLS,
        ...WRITE_TOOLS,
        ...PREVIEW_TOOLS,
        ...PROJECT_CONFIG_TOOLS,
      ]);
    });
  });

  describe('create_preview', () => {
    it('answers the preview, its url and the queued Deployment, and read_deployment_log reads that Deployment unchanged', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator', 'op-bot');

      const result = await resultOf(create(agent.key, t, { ttlMinutes: 30 }));
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      const created = JSON.parse(text) as Record<string, unknown>;
      const [row] = await ctx.db
        .select()
        .from(previewDeployment)
        .where(eq(previewDeployment.trigger, 'requested'));
      const deploymentId = created.deploymentId as string;

      expect(Object.keys(created).sort()).toEqual(
        [...PREVIEW_KEYS, 'deploymentId', 'message'].sort(),
      );
      expect(created).toEqual({
        previewDeploymentId: row.previewDeploymentId,
        applicationId: t.app.applicationId,
        branch: 'feature/login',
        url: `http://${row.domain}`,
        urlNote: expect.any(String) as unknown,
        status: 'idle',
        expired: false,
        expiresAt: row.expiresAt,
        latestDeploymentId: deploymentId,
        requestedByYou: true,
        createdAt: row.createdAt,
        deploymentId: expect.any(String) as unknown,
        message: `Deployment \`${deploymentId}\` of this preview is queued; poll \`get_preview\` or \`list_deployments\` for its status, then call \`read_deployment_log\` with its deploymentId.`,
      });
      expect(
        Date.parse(row.expiresAt!) - Date.parse(row.createdAt),
      ).toBeGreaterThan(29 * 60_000);
      // Never the requester's id, the pull-request fields or an env value.
      expect(text).not.toContain(agent.id);
      expect(text).not.toMatch(/requesterId|pullRequest|sk_live/);
      expect(queue.jobs).toHaveLength(1);

      const log = await payloadOf(
        callTool(agent.key, 'read_deployment_log', { deploymentId }),
      );
      expect(log).toMatchObject({
        deploymentId,
        serviceType: 'application',
        serviceId: t.app.applicationId,
      });
    });

    it('leaves the create row its HTTP twin leaves, beside the call row', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator', 'op-bot');

      const created = await payloadOf(create(agent.key, t));

      const rows = await rowsOf(agent.id);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          {
            resourceType: 'previewDeployment',
            action: 'create',
            outcome: 'succeeded',
            resourceId: created.previewDeploymentId,
            metadata: {
              trigger: 'requested',
              requesterId: agent.id,
              applicationId: t.app.applicationId,
              branch: 'feature/login',
              expiresAt: created.expiresAt,
              deploymentId: created.deploymentId,
            },
          },
          {
            resourceType: 'previewDeployment',
            action: 'create',
            outcome: 'succeeded',
            resourceId: t.app.applicationId,
            metadata: expect.objectContaining({
              tool: 'create_preview',
              previewDeploymentId: created.previewDeploymentId,
              deploymentId: created.deploymentId,
            }) as unknown,
          },
        ]),
      );
    });

    it('answers the switch refusal with the HTTP sentence, and the cap refusal with no finality sentence and the HTTP row', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator', 'op-bot');

      await ctx.db
        .update(application)
        .set({ requestedPreviewsAllowed: false })
        .where(eq(application.applicationId, t.app.applicationId));
      expect(await resultOf(create(agent.key, t))).toEqual(
        failed(SWITCH_REFUSAL),
      );
      // The HTTP twin says the same sentence.
      const http = await request(httpServer)
        .post(`/applications/${t.app.applicationId}/preview-deployments`)
        .set('Cookie', ownerCookie)
        .send({ branch: 'feature/login' });
      expect(http.status).toBe(409);
      expect((http.body as { message: string }).message).toBe(SWITCH_REFUSAL);

      await ctx.db
        .update(application)
        .set({ requestedPreviewsAllowed: true, requestedPreviewLimit: 1 })
        .where(eq(application.applicationId, t.app.applicationId));
      await payloadOf(create(agent.key, t));
      const capped = await resultOf(create(agent.key, t));
      expect(capped).toEqual(failed(CAP_REFUSAL));
      expect(capped.content[0].text).not.toContain(FINALITY);

      const refusals = (await rowsOf(agent.id)).filter(
        (row) => row.outcome === 'failed',
      );
      expect(refusals).toEqual(
        expect.arrayContaining([
          // The service's, as over HTTP.
          {
            resourceType: 'previewDeployment',
            action: 'create',
            outcome: 'failed',
            resourceId: null,
            metadata: {
              reason: 'preview-limit',
              trigger: 'requested',
              applicationId: t.app.applicationId,
              branch: 'feature/login',
              requestedPreviewLimit: 1,
              held: 1,
            },
          },
          // The call's.
          expect.objectContaining({
            resourceType: 'previewDeployment',
            action: 'create',
            outcome: 'failed',
            resourceId: t.app.applicationId,
            metadata: expect.objectContaining({
              tool: 'create_preview',
            }) as unknown,
          }),
        ]),
      );
      // One switch call row, and the cap's two.
      expect(refusals).toHaveLength(3);
    });

    it('refuses as its HTTP twin does and writes no preview when no address is recorded for the machine', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator', 'op-bot');
      // No wildcard, the platform host, and no settings row: no IP anywhere.
      await ctx.db
        .update(application)
        .set({ previewWildcard: null })
        .where(eq(application.applicationId, t.app.applicationId));

      expect(await resultOf(create(agent.key, t))).toEqual(
        failed(NO_ADDRESS_REFUSAL),
      );
      const http = await request(httpServer)
        .post(`/applications/${t.app.applicationId}/preview-deployments`)
        .set('Cookie', ownerCookie)
        .send({ branch: 'feature/login' });
      expect(http.status).toBe(400);
      expect(http.body).toMatchObject({
        message: NO_ADDRESS_HTTP,
        code: 'NO_PREVIEW_ADDRESS',
      });
      const requested = await ctx.db
        .select()
        .from(previewDeployment)
        .where(eq(previewDeployment.trigger, 'requested'));
      expect(requested).toEqual([]);
    });
  });

  describe('reading', () => {
    it('lists requested previews only, and tells the requesting Agent from another Operator', async () => {
      const t = await tree();
      const asker = await createAgent(t, 'agentOperator', 'asker-bot');
      const other = await createAgent(t, 'agentOperator', 'other-bot');
      const created = await payloadOf(create(asker.key, t));
      const id = created.previewDeploymentId as string;

      const mine = await payloadOf(
        callTool(asker.key, 'get_preview', { previewDeploymentId: id }),
      );
      const theirs = await payloadOf(
        callTool(other.key, 'get_preview', { previewDeploymentId: id }),
      );
      expect(Object.keys(mine).sort()).toEqual(PREVIEW_KEYS);
      expect(mine.requestedByYou).toBe(true);
      expect(theirs).toEqual({ ...mine, requestedByYou: false });
      expect(mine.latestDeploymentId).toBe(created.deploymentId);

      const list = await payloadOf<Array<Record<string, unknown>>>(
        callTool(other.key, 'list_previews', {
          applicationId: t.app.applicationId,
        }),
      );
      expect(list).toEqual([theirs]);
    });

    it('carries the latest build on the HTTP read answers too', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator', 'op-bot');
      const created = await payloadOf(create(agent.key, t));

      const one = await request(httpServer)
        .get(`/preview-deployments/${created.previewDeploymentId as string}`)
        .set('Cookie', ownerCookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        latestDeploymentId: created.deploymentId,
      });
      const list = await request(httpServer)
        .get(`/applications/${t.app.applicationId}/preview-deployments`)
        .set('Cookie', ownerCookie);
      expect(
        (list.body as Array<{ trigger: string; latestDeploymentId: unknown }>)
          .map((preview) => [preview.trigger, preview.latestDeploymentId])
          .sort(),
      ).toEqual([
        ['pullRequest', null],
        ['requested', created.deploymentId],
      ]);
    });
  });

  describe('a pull-request preview', () => {
    it('answers not-found on every tool that takes its id, is not listed, and is left as it was', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator', 'op-bot');
      const args = { previewDeploymentId: t.pullRequest.previewDeploymentId };

      for (const name of [
        'get_preview',
        'extend_preview',
        'redeploy_preview',
        'delete_preview',
      ]) {
        expect(await resultOf(callTool(agent.key, name, args))).toEqual(
          REFUSED,
        );
      }
      expect(
        await payloadOf(
          callTool(agent.key, 'list_previews', {
            applicationId: t.app.applicationId,
          }),
        ),
      ).toEqual([]);

      const [row] = await ctx.db
        .select()
        .from(previewDeployment)
        .where(
          eq(
            previewDeployment.previewDeploymentId,
            t.pullRequest.previewDeploymentId,
          ),
        );
      expect(row).toEqual(t.pullRequest);
      expect(queue.jobs).toEqual([]);
      expect(commands).toEqual([]);
    });
  });

  describe('the grant', () => {
    it('refuses an Agent granted another Application byte-identically on all six tools', async () => {
      const t = await tree();
      const asker = await createAgent(t, 'agentOperator', 'asker-bot');
      const created = await payloadOf(create(asker.key, t));
      const outsider = await createAgent(t, 'agentOperator', 'outsider-bot', [
        t.other.applicationId,
      ]);
      const byId = { previewDeploymentId: created.previewDeploymentId };
      const byApp = { applicationId: t.app.applicationId };

      const answers = [
        await resultOf(create(outsider.key, t)),
        await resultOf(callTool(outsider.key, 'list_previews', byApp)),
        await resultOf(callTool(outsider.key, 'get_preview', byId)),
        await resultOf(callTool(outsider.key, 'extend_preview', byId)),
        await resultOf(callTool(outsider.key, 'redeploy_preview', byId)),
        await resultOf(callTool(outsider.key, 'delete_preview', byId)),
        // And an id that never existed.
        await resultOf(
          callTool(outsider.key, 'get_preview', {
            previewDeploymentId: 'no-such-preview',
          }),
        ),
      ];
      for (const answer of answers) expect(answer).toEqual(REFUSED);
      expect(queue.jobs).toHaveLength(1);
    });
  });

  describe('extend_preview and redeploy_preview', () => {
    it('extends from now and leaves the HTTP row, and redeploy answers the waiting build it joined', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator', 'op-bot');
      const created = await payloadOf(create(agent.key, t, { ttlMinutes: 5 }));
      const byId = { previewDeploymentId: created.previewDeploymentId };

      const extended = await payloadOf(
        callTool(agent.key, 'extend_preview', { ...byId, ttlMinutes: 120 }),
      );
      expect(
        Date.parse(extended.expiresAt as string) - Date.now(),
      ).toBeGreaterThan(119 * 60_000);
      const updates = (await rowsOf(agent.id)).filter(
        (row) => row.action === 'update',
      );
      expect(updates).toEqual(
        expect.arrayContaining([
          {
            resourceType: 'previewDeployment',
            action: 'update',
            outcome: 'succeeded',
            resourceId: created.previewDeploymentId,
            metadata: {
              type: 'extend',
              applicationId: t.app.applicationId,
              branch: 'feature/login',
              ttlMinutes: 120,
              expiresAt: extended.expiresAt,
            },
          },
          expect.objectContaining({
            resourceId: created.previewDeploymentId,
            metadata: expect.objectContaining({
              tool: 'extend_preview',
            }) as unknown,
          }),
        ]),
      );
      expect(updates).toHaveLength(2);

      // The create's build is still waiting, so the redeploy joins it.
      const redeployed = await payloadOf(
        callTool(agent.key, 'redeploy_preview', byId),
      );
      expect(redeployed).toMatchObject({
        previewDeploymentId: created.previewDeploymentId,
        deploymentId: created.deploymentId,
        latestDeploymentId: created.deploymentId,
        expiresAt: extended.expiresAt,
      });
      expect(queue.jobs).toHaveLength(1);
    });
  });

  describe('delete_preview', () => {
    it('answers expired at once with no Server round trip, again unchanged, leaves the HTTP row, and then refuses extend and redeploy', async () => {
      const t = await tree();
      const agent = await createAgent(t, 'agentOperator', 'op-bot');
      const created = await payloadOf(create(agent.key, t));
      const byId = { previewDeploymentId: created.previewDeploymentId };
      commands.length = 0;

      const deleted = await payloadOf(
        callTool(agent.key, 'delete_preview', byId),
      );
      expect(deleted).toMatchObject({
        previewDeploymentId: created.previewDeploymentId,
        expired: true,
        latestDeploymentId: created.deploymentId,
      });
      expect(commands).toEqual([]);
      expect(
        await payloadOf(callTool(agent.key, 'delete_preview', byId)),
      ).toEqual(deleted);

      const deletes = (await rowsOf(agent.id)).filter(
        (row) => row.action === 'delete',
      );
      expect(deletes).toEqual([
        expect.objectContaining({
          resourceType: 'previewDeployment',
          outcome: 'succeeded',
          resourceId: created.previewDeploymentId,
          metadata: expect.objectContaining({
            tool: 'delete_preview',
          }) as unknown,
        }),
        expect.objectContaining({ outcome: 'succeeded' }),
      ]);

      expect(
        await resultOf(callTool(agent.key, 'extend_preview', byId)),
      ).toEqual(failed(EXPIRED_REFUSAL));
      expect(
        await resultOf(callTool(agent.key, 'redeploy_preview', byId)),
      ).toEqual(failed(EXPIRED_REFUSAL));
      // Still read, expired, until the sweep sees its copy gone.
      expect(await payloadOf(callTool(agent.key, 'get_preview', byId))).toEqual(
        deleted,
      );
      const [row] = await ctx.db
        .select()
        .from(previewDeployment)
        .where(
          and(
            eq(
              previewDeployment.previewDeploymentId,
              created.previewDeploymentId as string,
            ),
            eq(previewDeployment.expiryCause, 'delete'),
          ),
        );
      expect(row).toBeDefined();
    });
  });
});
