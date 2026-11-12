import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { ComposeService } from '../../src/compose/compose.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import {
  aiModelFacet,
  application,
  auditLog,
  backup,
  cloudAccount,
  deployment,
  destination,
  domain,
  previewDeployment,
  redis,
  schedule,
  security,
  webServerSettings,
} from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

/**
 * The read tools for one Service, driven from outside (spec
 * Testing Decisions §1): a real Agent key against the real `POST /mcp`,
 * asserting on the answer and the audit rows.
 *
 * The only thing standing in for the product is a Deployment's log, which is a
 * real file in a temp directory named by a hand-inserted Deployment row: the
 * real `tail` reads it through the real exec, so the window and the
 * `maxBuffer` are the program's, not a double's. Sentences and numbers are
 * written out here, not imported (§1.7).
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

/** Values long enough to be masked, stored as secrets below. */
const APP_SECRET = 'sk-live-4f9a8b7c6d5e';
const PROJECT_SECRET = 'whsec-project-91c2d3';
const BUILD_SECRET = 'npm-token-7a6b5c4d3e';
const DB_PASSWORD = 'pg-pass-0e1f2a3b4c';
const BASIC_AUTH_PASSWORD = 'basic-auth-5d6e7f8a';
const DB_USER = 'orders_db_user';
const DB_NAME = 'orders_db_name';
/** An AI model's upstream secret, as the platform stores it. */
const UPSTREAM_SECRET = 'upstream-9d8c7b6a5f4e3d2c1b0a';
const HF_TOKEN = 'hf_gatedWeightsToken0123456789';
const MASK = '••••••';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe('MCP Service read tools (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;
  let ownerId: string;
  let organizationId: string;
  const logs = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-mcp-logs-')),
  );

  beforeAll(async () => {
    ctx = await createTestApp();
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
    fs.rmSync(logs, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
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
   * One Project and Environment holding a granted Application, Compose and
   * Postgres and an ungranted Application, and an Application in a second
   * Organization of the owner's.
   */
  async function tree() {
    const projects = ctx.app.get(ProjectsService);
    const environments = ctx.app.get(EnvironmentsService);
    const applications = ctx.app.get(ApplicationsService);
    const home = ctxIn(organizationId);

    const projectA = await projects.create(home, {
      name: 'storefront',
      env: `STRIPE_WEBHOOK=${PROJECT_SECRET}`,
    });
    const a1 = await environments.create(home, {
      name: 'production',
      projectId: projectA.projectId,
    });
    const app = await applications.create(home, {
      name: 'Web',
      appName: 'web-app',
      environmentId: a1.environmentId,
    });
    await ctx.db
      .update(application)
      .set({
        env: `API_TOKEN=${APP_SECRET}\nPORT=3000`,
        buildArgs: `BUILD_FLAVOR=release-candidate`,
        buildSecrets: `NPM_TOKEN=${BUILD_SECRET}`,
      })
      .where(eq(application.applicationId, app.applicationId));
    const worker = await applications.create(home, {
      name: 'Worker',
      appName: 'worker-app',
      environmentId: a1.environmentId,
    });
    const stack = await ctx.app.get(ComposeService).create(home, {
      name: 'Stack',
      appName: 'stack-app',
      environmentId: a1.environmentId,
    });
    const database = await ctx.app.get(PostgresService).create(home, {
      name: 'Orders',
      appName: 'orders-db',
      databaseName: DB_NAME,
      databaseUser: DB_USER,
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
    const foreign = await applications.create(elsewhere, {
      name: 'Foreign',
      appName: 'foreign-app',
      environmentId: foreignEnvironment.environmentId,
    });

    return { projectA, a1, app, worker, stack, database, foreign };
  }

  type Tree = Awaited<ReturnType<typeof tree>>;

  async function grantedAgent(
    t: Tree,
    extraServices: string[] = [],
  ): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({
        name: 'deploy-bot',
        role: 'agentReader',
        grant: {
          accessedProjects: [t.projectA.projectId],
          accessedEnvironments: [t.a1.environmentId],
          accessedServices: [
            t.app.applicationId,
            t.stack.composeId,
            t.database.postgresId,
            ...extraServices,
          ],
        },
      });
    expect(res.status).toBe(201);
    const body = res.body as { agent: { id: string }; key: string };
    return { id: body.agent.id, key: body.key };
  }

  function callTool(
    key: string,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    return request(httpServer)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${key}`)
      .set('MCP-Protocol-Version', '2025-06-18')
      .send({
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

  function payloadOf(res: request.Response): unknown {
    const result = resultOf(res);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text) as unknown;
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

  /** A Deployment row whose log is a real file holding `lines`. */
  async function deploymentWithLog(
    owner: Partial<typeof deployment.$inferInsert>,
    lines: readonly string[] | null,
    extra: Partial<typeof deployment.$inferInsert> = {},
  ) {
    const logPath = nodePath.join(logs, `${Math.random()}.log`);
    if (lines) fs.writeFileSync(logPath, `${lines.join('\n')}\n`);
    const [row] = await ctx.db
      .insert(deployment)
      .values({
        title: 'Manual deployment',
        status: 'done',
        logPath,
        ...owner,
        ...extra,
      })
      .returning();
    return row;
  }

  const numbered = (count: number) =>
    Array.from({ length: count }, (_, i) => `line ${i + 1}`);

  describe('get_service', () => {
    it("reads each kind's identity and status, a secret only as a presence flag, and writes its twin's audit kind", async () => {
      const t = await tree();
      const agent = await grantedAgent(t);

      const web = await callTool(agent.key, 'get_service', {
        serviceType: 'application',
        serviceId: t.app.applicationId,
      });
      expect(payloadOf(web)).toEqual({
        serviceType: 'application',
        serviceId: t.app.applicationId,
        name: 'Web',
        appName: 'web-app',
        configName: 'web',
        description: null,
        status: 'idle',
        createdAt: t.app.createdAt,
        hasEnv: true,
        hasBuildArgs: true,
        hasBuildSecrets: true,
        hasDatabasePassword: false,
        environment: { id: t.a1.environmentId, name: 'production' },
        project: { id: t.projectA.projectId, name: 'storefront' },
        openIncidents: [],
        aiModel: null,
        internalAddress: null,
        // On a Server's Service, no cloud place.
        cloudPlace: null,
        // A bucket's real name and key, on a bucket only.
        bucketName: null,
        hasKey: null,
      });

      const stack = await callTool(agent.key, 'get_service', {
        serviceType: 'compose',
        serviceId: t.stack.composeId,
      });
      expect(payloadOf(stack)).toMatchObject({
        serviceType: 'compose',
        serviceId: t.stack.composeId,
        name: 'Stack',
        status: 'idle',
        hasEnv: false,
        hasDatabasePassword: false,
        aiModel: null,
      });

      const orders = await callTool(agent.key, 'get_service', {
        serviceType: 'postgres',
        serviceId: t.database.postgresId,
      });
      expect(payloadOf(orders)).toEqual({
        serviceType: 'postgres',
        serviceId: t.database.postgresId,
        name: 'Orders',
        appName: 'orders-db',
        configName: 'orders',
        description: null,
        status: 'idle',
        createdAt: t.database.createdAt,
        hasEnv: false,
        hasBuildArgs: false,
        hasBuildSecrets: false,
        hasDatabasePassword: true,
        environment: { id: t.a1.environmentId, name: 'production' },
        project: { id: t.projectA.projectId, name: 'storefront' },
        openIncidents: [],
        aiModel: null,
        internalAddress: null,
        cloudPlace: null,
        bucketName: null,
        hasKey: null,
      });

      // Never a value, a key list or the connection's other half.
      for (const res of [web, stack, orders]) {
        const text = resultOf(res).content[0].text;
        for (const leak of [
          APP_SECRET,
          BUILD_SECRET,
          PROJECT_SECRET,
          DB_PASSWORD,
          DB_USER,
          DB_NAME,
          'API_TOKEN',
          'NPM_TOKEN',
          'BUILD_FLAVOR',
          'databaseUser',
          'databaseName',
        ]) {
          expect(text).not.toContain(leak);
        }
      }

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
          'read',
          'succeeded',
          t.app.applicationId,
          'get_service',
        ],
        ['compose', 'read', 'succeeded', t.stack.composeId, 'get_service'],
        ['database', 'read', 'succeeded', t.database.postgresId, 'get_service'],
      ]);
    });

    /**
     * An AI model as the platform leaves it: an Application with a facet row holding
     * the runtime, the model and the upstream secret, its GPUs on the
     * Application. Written here rather than through create, whose network
     * join would run on this machine's Docker.
     */
    async function aiModel(t: Tree) {
      const llm = await ctx.app
        .get(ApplicationsService)
        .create(ctxIn(organizationId), {
          name: 'Llama',
          appName: 'llama-app',
          environmentId: t.a1.environmentId,
        });
      await ctx.db
        .update(application)
        .set({ gpus: 1 })
        .where(eq(application.applicationId, llm.applicationId));
      await ctx.db.insert(aiModelFacet).values({
        applicationId: llm.applicationId,
        runtime: 'ollama',
        model: 'smollm2:135m',
        upstreamSecret: UPSTREAM_SECRET,
      });
      return llm;
    }

    it("carries an AI model's runtime, model, GPUs and gateway endpoint as aiModel, and never its upstream secret", async () => {
      const t = await tree();
      const llm = await aiModel(t);
      await ctx.db
        .insert(webServerSettings)
        .values({ host: 'cloud.example.com', https: true });
      const agent = await grantedAgent(t, [llm.applicationId]);

      const res = await callTool(agent.key, 'get_service', {
        serviceType: 'application',
        serviceId: llm.applicationId,
      });
      expect(payloadOf(res)).toMatchObject({
        serviceType: 'application',
        serviceId: llm.applicationId,
        name: 'Llama',
        aiModel: {
          runtime: 'ollama',
          model: 'smollm2:135m',
          gpus: 1,
          endpoint: `https://cloud.example.com/ai/${llm.applicationId}/v1`,
        },
      });
      expect(
        Object.keys((payloadOf(res) as { aiModel: object }).aiModel).sort(),
      ).toEqual(['endpoint', 'gpus', 'hasHfToken', 'model', 'runtime']);

      // Neither the value nor that there is one.
      const text = resultOf(res).content[0].text;
      for (const leak of [UPSTREAM_SECRET, 'upstreamSecret', 'hasUpstream']) {
        expect(text).not.toContain(leak);
      }
      expect(JSON.stringify(res.body)).not.toContain(UPSTREAM_SECRET);
    });

    it("says only that a vLLM AI model's Hugging Face token is set, at the facet's depth, and never the token", async () => {
      const t = await tree();
      const llm = await aiModel(t);
      await ctx.db
        .update(aiModelFacet)
        .set({ runtime: 'vllm', model: 'Qwen/Qwen2.5-0.5B', hfToken: HF_TOKEN })
        .where(eq(aiModelFacet.applicationId, llm.applicationId));
      const agent = await grantedAgent(t, [llm.applicationId]);

      const res = await callTool(agent.key, 'get_service', {
        serviceType: 'application',
        serviceId: llm.applicationId,
      });

      expect(payloadOf(res)).toMatchObject({
        aiModel: { runtime: 'vllm', hasHfToken: true },
      });
      expect(payloadOf(res)).not.toHaveProperty('hasHfToken');
      expect(JSON.stringify(res.body)).not.toContain(HF_TOKEN);
      expect(resultOf(res).content[0].text).not.toContain('"hfToken"');
    });

    it("reads an AI model's endpoint as null while the platform host URL is not configured", async () => {
      const t = await tree();
      const llm = await aiModel(t);
      const agent = await grantedAgent(t, [llm.applicationId]);

      const res = await callTool(agent.key, 'get_service', {
        serviceType: 'application',
        serviceId: llm.applicationId,
      });
      expect(payloadOf(res)).toMatchObject({
        aiModel: {
          runtime: 'ollama',
          model: 'smollm2:135m',
          gpus: 1,
          endpoint: null,
        },
      });
    });

    it('reads a redis on a cloud as having no password, since none reaches it, and a redis on a Server as having one', async () => {
      const t = await tree();
      const [account] = await ctx.db
        .insert(cloudAccount)
        .values({
          organizationId,
          name: 'Production Google',
          cloud: 'gcp',
          cloudId: 'shop-prod',
          ...GOOGLE_COLUMNS,
          policyVersion: 2,
          lastCheckedAt: new Date().toISOString(),
          lastCheckResult: 'passed',
        })
        .returning();
      const [cloudCache, serverCache] = await ctx.db
        .insert(redis)
        .values([
          {
            name: 'cache',
            configName: 'cache',
            databasePassword: 'never-used-password',
            environmentId: t.a1.environmentId,
            cloudAccountId: account.cloudAccountId,
            region: 'europe-west1',
          },
          {
            name: 'queue',
            configName: 'queue',
            databasePassword: 'server-password',
            environmentId: t.a1.environmentId,
          },
        ])
        .returning();
      const agent = await grantedAgent(t, [
        cloudCache.redisId,
        serverCache.redisId,
      ]);

      const cloud = await callTool(agent.key, 'get_service', {
        serviceType: 'redis',
        serviceId: cloudCache.redisId,
      });
      expect(payloadOf(cloud)).toMatchObject({
        serviceType: 'redis',
        name: 'cache',
        hasDatabasePassword: false,
      });
      const server = await callTool(agent.key, 'get_service', {
        serviceType: 'redis',
        serviceId: serverCache.redisId,
      });
      expect(payloadOf(server)).toMatchObject({
        serviceType: 'redis',
        name: 'queue',
        hasDatabasePassword: true,
      });
    });
  });

  describe('list_deployments', () => {
    it("lists a Service's Deployments newest first with status, startedAt, finishedAt and the preview a build built, and no log path", async () => {
      const t = await tree();
      const agent = await grantedAgent(t);
      // The newer one is a preview's build, a Deployment of this
      // Application naming the preview; the older one is production's.
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
      const older = await deploymentWithLog(
        { applicationId: t.app.applicationId },
        null,
        {
          status: 'error',
          createdAt: '2026-09-01T10:00:00.000Z',
          startedAt: '2026-09-01T10:00:01.000Z',
          finishedAt: '2026-09-01T10:02:00.000Z',
        },
      );
      const newer = await deploymentWithLog(
        { applicationId: t.app.applicationId },
        null,
        {
          status: 'running',
          title: 'Rebuild',
          createdAt: '2026-09-02T10:00:00.000Z',
          startedAt: '2026-09-02T10:00:01.000Z',
          previewDeploymentId: preview.previewDeploymentId,
        },
      );
      await deploymentWithLog({ composeId: t.stack.composeId }, null);

      const res = await callTool(agent.key, 'list_deployments', {
        serviceType: 'application',
        serviceId: t.app.applicationId,
      });
      expect(payloadOf(res)).toEqual([
        {
          deploymentId: newer.deploymentId,
          title: 'Rebuild',
          description: null,
          status: 'running',
          createdAt: '2026-09-02T10:00:00.000Z',
          startedAt: '2026-09-02T10:00:01.000Z',
          finishedAt: null,
          previewDeploymentId: preview.previewDeploymentId,
        },
        {
          deploymentId: older.deploymentId,
          title: 'Manual deployment',
          description: null,
          status: 'error',
          createdAt: '2026-09-01T10:00:00.000Z',
          startedAt: '2026-09-01T10:00:01.000Z',
          finishedAt: '2026-09-01T10:02:00.000Z',
          previewDeploymentId: null,
        },
      ]);
      expect(resultOf(res).content[0].text).not.toContain(logs);

      expect(
        payloadOf(
          await callTool(agent.key, 'list_deployments', {
            serviceType: 'compose',
            serviceId: t.stack.composeId,
          }),
        ),
      ).toHaveLength(1);
    });
  });

  describe('read_deployment_log', () => {
    it("masks a stored secret the build echoed into its log: the Service's, its Project's, and a child row's", async () => {
      const t = await tree();
      const agent = await grantedAgent(t);
      // A basic-auth credential hangs *below* the Service, so only a mask
      // walked from the Service itself — not up from the Deployment — has it.
      await ctx.db.insert(security).values({
        username: 'admin',
        password: BASIC_AUTH_PASSWORD,
        applicationId: t.app.applicationId,
      });
      const build = await deploymentWithLog(
        { applicationId: t.app.applicationId },
        [
          'Step 1/4 : FROM node:24',
          `export API_TOKEN=${APP_SECRET}`,
          `curl -H "X-Webhook: ${PROJECT_SECRET}" https://hooks.example.com`,
          `htpasswd -b admin ${BASIC_AUTH_PASSWORD}`,
          'Build finished',
        ],
      );

      const res = await callTool(agent.key, 'read_deployment_log', {
        deploymentId: build.deploymentId,
      });
      expect(payloadOf(res)).toEqual({
        deploymentId: build.deploymentId,
        serviceType: 'application',
        serviceId: t.app.applicationId,
        lines: 100,
        log: [
          'Step 1/4 : FROM node:24',
          `export API_TOKEN=${MASK}`,
          `curl -H "X-Webhook: ${MASK}" https://hooks.example.com`,
          `htpasswd -b admin ${MASK}`,
          'Build finished',
          '',
        ].join('\n'),
      });
      for (const secret of [APP_SECRET, PROJECT_SECRET, BASIC_AUTH_PASSWORD]) {
        expect(resultOf(res).content[0].text).not.toContain(secret);
      }
    });

    it('answers the last 100 lines by default, the lines asked for, and at most 500 however many are asked for', async () => {
      const t = await tree();
      const agent = await grantedAgent(t);
      const build = await deploymentWithLog(
        { composeId: t.stack.composeId },
        numbered(600),
      );
      const windowOf = async (args: Record<string, unknown>) => {
        const found = payloadOf(
          await callTool(agent.key, 'read_deployment_log', {
            deploymentId: build.deploymentId,
            ...args,
          }),
        ) as { lines: number; log: string };
        const lines = found.log.split('\n').filter(Boolean);
        return { lines: found.lines, count: lines.length, first: lines[0] };
      };

      expect(await windowOf({})).toEqual({
        lines: 100,
        count: 100,
        first: 'line 501',
      });
      expect(await windowOf({ lines: 7 })).toEqual({
        lines: 7,
        count: 7,
        first: 'line 594',
      });
      expect(await windowOf({ lines: 500 })).toEqual({
        lines: 500,
        count: 500,
        first: 'line 101',
      });
      expect(await windowOf({ lines: 10_000 })).toEqual({
        lines: 500,
        count: 500,
        first: 'line 101',
      });
    });

    it('answers a window larger than 1 MiB with a failure asking for fewer lines, not a refusal', async () => {
      const t = await tree();
      const agent = await grantedAgent(t);
      const wide = 'x'.repeat(600 * 1024);
      const build = await deploymentWithLog(
        { applicationId: t.app.applicationId },
        [wide, wide, wide],
      );

      const res = await callTool(agent.key, 'read_deployment_log', {
        deploymentId: build.deploymentId,
        lines: 3,
      });
      expect(resultOf(res)).toEqual({
        content: [
          {
            type: 'text',
            text: 'This part of the log is larger than 1 MiB. Ask for fewer lines.',
          },
        ],
        structuredContent: {
          code: 'failed',
          message:
            'This part of the log is larger than 1 MiB. Ask for fewer lines.',
        },
        isError: true,
      });

      // One line of it fits.
      const one = payloadOf(
        await callTool(agent.key, 'read_deployment_log', {
          deploymentId: build.deploymentId,
          lines: 1,
        }),
      ) as { log: string };
      expect(one.log).toBe(`${wide}\n`);
    });

    it('answers a reaped log with the retention notice, as a success', async () => {
      const t = await tree();
      const agent = await grantedAgent(t);
      const ancient = await deploymentWithLog(
        { applicationId: t.app.applicationId },
        null,
        { createdAt: '2020-01-01T00:00:00.000Z' },
      );

      expect(
        payloadOf(
          await callTool(agent.key, 'read_deployment_log', {
            deploymentId: ancient.deploymentId,
          }),
        ),
      ).toMatchObject({
        log: "This deployment's log is no longer on the machine that wrote it: Cloudgate keeps deployment logs for 90 days and this deployment is older than that.\n",
      });
    });

    it("answers a schedule's or a backup's run on a granted Service exactly as an unknown id", async () => {
      const t = await tree();
      const agent = await grantedAgent(t);
      // Both on Services the Agent is granted, and both logs on disk: without
      // the tool's narrowing, `readLogs` would answer them.
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
      const scheduleRun = await deploymentWithLog(
        { scheduleId: cron.scheduleId },
        [`echo ${APP_SECRET}`, 'schedule output'],
      );
      const [bucket] = await ctx.db
        .insert(destination)
        .values({
          name: 'Backups',
          accessKey: 'AKIAEXAMPLE',
          secretAccessKey: 'a-destination-secret-key',
          bucket: 'backups',
          region: 'us-east-1',
          endpoint: 'https://s3.example.com',
          organizationId,
        })
        .returning();
      const [dump] = await ctx.db
        .insert(backup)
        .values({
          schedule: '0 4 * * *',
          database: DB_NAME,
          prefix: '/',
          destinationId: bucket.destinationId,
          backupType: 'database',
          databaseType: 'postgres',
          postgresId: t.database.postgresId,
        })
        .returning();
      const backupRun = await deploymentWithLog({ backupId: dump.backupId }, [
        'pg_dump output',
      ]);

      const answers: string[] = [];
      for (const deploymentId of [
        'no-such-deployment',
        scheduleRun.deploymentId,
        backupRun.deploymentId,
      ]) {
        answers.push(
          JSON.stringify(
            resultOf(
              await callTool(agent.key, 'read_deployment_log', {
                deploymentId,
              }),
            ),
          ),
        );
      }
      expect(new Set(answers).size).toBe(1);
      expect(JSON.parse(answers[0])).toEqual(REFUSED);
      expect(
        (await rowsOf(agent.id)).map((row) => [
          row.outcome,
          row.metadata.reason,
          row.resourceId,
        ]),
      ).toEqual([
        ['refused', 'grant', 'no-such-deployment'],
        ['refused', 'grant', scheduleRun.deploymentId],
        ['refused', 'grant', backupRun.deploymentId],
      ]);
    });
  });

  describe('list_domains', () => {
    it('lists where a Service is served: host, path, https and port', async () => {
      const t = await tree();
      const agent = await grantedAgent(t);
      const [served] = await ctx.db
        .insert(domain)
        .values({
          host: 'shop.example.com',
          https: true,
          port: 3000,
          path: '/',
          applicationId: t.app.applicationId,
        })
        .returning();
      await ctx.db.insert(domain).values({
        host: 'stack.example.com',
        composeId: t.stack.composeId,
        serviceName: 'web',
      });

      expect(
        payloadOf(
          await callTool(agent.key, 'list_domains', {
            serviceType: 'application',
            serviceId: t.app.applicationId,
          }),
        ),
      ).toEqual([
        {
          domainId: served.domainId,
          host: 'shop.example.com',
          path: '/',
          https: true,
          port: 3000,
        },
      ]);
      expect(
        payloadOf(
          await callTool(agent.key, 'list_domains', {
            serviceType: 'compose',
            serviceId: t.stack.composeId,
          }),
        ),
      ).toMatchObject([{ host: 'stack.example.com' }]);
    });
  });

  describe('grant refusals', () => {
    it('answers a nonexistent id, an id in another Organization and an ungranted id with one byte-identical refusal, on every tool', async () => {
      const t = await tree();
      const agent = await grantedAgent(t);
      const foreignRun = await deploymentWithLog(
        { applicationId: t.foreign.applicationId },
        ['foreign build output'],
      );
      const ungrantedRun = await deploymentWithLog(
        { applicationId: t.worker.applicationId },
        ['worker build output'],
      );

      const serviceIds = [
        'no-such-service',
        t.foreign.applicationId,
        t.worker.applicationId,
      ];
      const cases: Array<[string, Array<Record<string, unknown>>]> = [
        [
          'get_service',
          serviceIds.map((serviceId) => ({
            serviceType: 'application',
            serviceId,
          })),
        ],
        [
          'list_deployments',
          serviceIds.map((serviceId) => ({
            serviceType: 'application',
            serviceId,
          })),
        ],
        [
          'get_service_health',
          serviceIds.map((serviceId) => ({
            serviceType: 'application',
            serviceId,
          })),
        ],
        [
          'list_domains',
          serviceIds.map((serviceId) => ({
            serviceType: 'application',
            serviceId,
          })),
        ],
        [
          'read_deployment_log',
          [
            'no-such-deployment',
            foreignRun.deploymentId,
            ungrantedRun.deploymentId,
          ].map((deploymentId) => ({ deploymentId })),
        ],
      ];

      const answers: string[] = [];
      for (const [tool, calls] of cases) {
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
      // And one answer across the five tools.
      expect(new Set(answers).size).toBe(1);
      expect(JSON.parse(answers[0])).toEqual(REFUSED);

      const rows = await rowsOf(agent.id);
      expect(rows).toHaveLength(15);
      expect(
        rows.every(
          (row) => row.outcome === 'refused' && row.metadata.reason === 'grant',
        ),
      ).toBe(true);
    });
  });
});
