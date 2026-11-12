import { ForbiddenException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import {
  auditLog,
  deployment,
  mysql,
  plan,
  projectConfigLocation,
} from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import {
  agentOperatorRole,
  agentReaderRole,
} from '../../src/rbac/access-control';
import { PermissionService } from '../../src/rbac/permission.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

/**
 * The Project config tools (spec US70): an Agent reads a Project's
 * config and an Environment's plan, and asks for a plan, through the real
 * `POST /mcp` with a real Agent key — and finds no tool that applies one.
 * Sentences and values are written out here, not imported (§1.7).
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

/** A stored Project secret, long enough to be masked. */
const PROJECT_SECRET = 'whsec-project-91c2d3';
const MASK = '••••••';

/** A config that changes the console-made `shop` and creates `cache`. */
const CHANGES = `version: 1
# The webhook signing secret is ${PROJECT_SECRET}; rotate it quarterly.
services:
  shop:
    kind: web
    port: 8080
    env: [DATABASE_URL]
  cache:
    kind: redis
`;

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe('MCP Project config tools (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;
  let ownerId: string;
  let organizationId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
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
   * A granted Project with a granted Environment holding a console-made
   * Application (Config name `shop`), an ungranted Environment of it, an
   * ungranted Project, and a Project in a second Organization of the owner's.
   */
  async function tree() {
    const projects = ctx.app.get(ProjectsService);
    const environments = ctx.app.get(EnvironmentsService);
    const home = ctxIn(organizationId);

    const granted = await projects.create(home, {
      name: 'storefront',
      env: `STRIPE_WEBHOOK=${PROJECT_SECRET}`,
    });
    const production = await environments.create(home, {
      name: 'production',
      projectId: granted.projectId,
    });
    const staging = await environments.create(home, {
      name: 'staging',
      projectId: granted.projectId,
    });
    const shop = await ctx.app.get(ApplicationsService).create(home, {
      name: 'Shop',
      environmentId: production.environmentId,
    });
    const ungranted = await projects.create(home, { name: 'back-office' });

    const second = await createOrganization(httpServer, ctx.db, ownerCookie, {
      name: 'Elsewhere',
    });
    expect(second.status).toBe(201);
    const foreign = await projects.create(
      ctxIn((second.body as { id: string }).id),
      { name: 'foreign' },
    );

    return { granted, production, staging, shop, ungranted, foreign };
  }

  type Tree = Awaited<ReturnType<typeof tree>>;

  async function createAgent(
    t: Tree,
    role: 'agentReader' | 'agentOperator' = 'agentReader',
  ): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({
        name: `${role}-bot`,
        role,
        grant: {
          accessedProjects: [t.granted.projectId],
          accessedEnvironments: [t.production.environmentId],
          accessedServices: [t.shop.applicationId],
        },
      });
    expect(res.status).toBe(201);
    const body = res.body as { agent: { id: string }; key: string };
    return { id: body.agent.id, key: body.key };
  }

  function post(key: string, body: Record<string, unknown>) {
    return request(httpServer)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${key}`)
      .set('MCP-Protocol-Version', '2025-06-18')
      .send(body);
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

  function resultOf(res: request.Response): ToolResult {
    expect(res.status).toBe(200);
    return (res.body as { result: ToolResult }).result;
  }

  function payloadOf(res: request.Response): Record<string, unknown> {
    const result = resultOf(res);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }

  async function storeConfig(projectId: string, text: string) {
    await ctx.db
      .update(projectConfigLocation)
      .set({ text })
      .where(eq(projectConfigLocation.projectId, projectId));
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
      tool: (JSON.parse(row.metadata ?? '{}') as { tool?: string }).tool,
    }));
  }

  describe('get_project_config', () => {
    it("answers a granted Project's Cloudgate-kept config as its text, with stored secrets masked", async () => {
      const t = await tree();
      await storeConfig(t.granted.projectId, CHANGES);
      const agent = await createAgent(t);

      const answer = payloadOf(
        await callTool(agent.key, 'get_project_config', {
          projectId: t.granted.projectId,
        }),
      );

      expect(answer).toEqual({
        projectId: t.granted.projectId,
        location: {
          kind: 'cloudgate',
          configText: CHANGES.replace(PROJECT_SECRET, MASK),
          textHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown,
          updatedAt: expect.any(String) as unknown,
          // A repository-kept config's fields, which this one lacks.
          providerType: null,
          connectionName: null,
          repository: null,
          path: null,
        },
      });
    });

    it("refuses an ungranted Project, another Organization's and an unknown id alike, and audits each call", async () => {
      const t = await tree();
      const agent = await createAgent(t);

      for (const projectId of [
        t.ungranted.projectId,
        t.foreign.projectId,
        'no-such-project',
      ]) {
        expect(
          resultOf(
            await callTool(agent.key, 'get_project_config', { projectId }),
          ),
        ).toEqual(REFUSED);
      }
      payloadOf(
        await callTool(agent.key, 'get_project_config', {
          projectId: t.granted.projectId,
        }),
      );

      expect(await rowsOf(agent.id)).toEqual([
        ...[t.ungranted.projectId, t.foreign.projectId, 'no-such-project'].map(
          (resourceId) => ({
            resourceType: 'project',
            action: 'read',
            outcome: 'refused',
            resourceId,
            tool: 'get_project_config',
          }),
        ),
        {
          resourceType: 'project',
          action: 'read',
          outcome: 'succeeded',
          resourceId: t.granted.projectId,
          tool: 'get_project_config',
        },
      ]);
    });

    it('answers no location for a Project from before configs existed', async () => {
      const t = await tree();
      await ctx.db
        .delete(projectConfigLocation)
        .where(eq(projectConfigLocation.projectId, t.granted.projectId));
      const agent = await createAgent(t);

      expect(
        payloadOf(
          await callTool(agent.key, 'get_project_config', {
            projectId: t.granted.projectId,
          }),
        ),
      ).toEqual({ projectId: t.granted.projectId, location: null });
    });
  });

  describe('request_plan and get_plan', () => {
    it('plans a granted Environment on environment: read, keeps the plan open, and get_plan answers the same plan', async () => {
      const t = await tree();
      await storeConfig(t.granted.projectId, CHANGES);
      const agent = await createAgent(t);

      expect(
        payloadOf(
          await callTool(agent.key, 'get_plan', {
            environmentId: t.production.environmentId,
          }),
        ),
      ).toEqual({ plan: null });

      const asked = payloadOf(
        await callTool(agent.key, 'request_plan', {
          environmentId: t.production.environmentId,
        }),
      );
      expect(asked).toEqual({
        planId: expect.any(String) as unknown,
        environmentId: t.production.environmentId,
        source: 'request',
        status: 'open',
        textHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown,
        // A Cloudgate-kept config's plan read no commit.
        commitSha: null,
        branch: null,
        createdAt: expect.any(String) as unknown,
        appliedAt: null,
        dismissedAt: null,
        steps: [
          {
            action: 'create',
            configName: 'cache',
            kind: 'redis',
            serviceType: null,
            serviceId: null,
            name: null,
            // A cloud step's place, Google private link and cloud read
            // none here.
            environmentNetworkId: null,
            cloudAccountId: null,
            region: null,
            privateLinks: null,
            placement: {
              kind: 'platform-host',
              serverId: null,
              cloudAccountId: null,
              region: null,
            },
            cloud: null,
            // No Compose stack, so no Stack VM (ADR-0070).
            stackVm: null,
            cloudRead: null,
            fields: [],
          },
          {
            action: 'change',
            configName: 'shop',
            kind: 'web',
            serviceType: 'application',
            serviceId: t.shop.applicationId,
            name: 'Shop',
            environmentNetworkId: null,
            cloudAccountId: null,
            region: null,
            privateLinks: null,
            placement: null,
            cloud: null,
            stackVm: null,
            cloudRead: null,
            fields: [{ field: 'port', from: 3000, to: 8080 }],
          },
        ],
        notes: [
          {
            kind: 'variable-without-value',
            configName: 'shop',
            list: 'env',
            variable: 'DATABASE_URL',
            line: null,
            message: expect.stringContaining('DATABASE_URL') as unknown,
          },
        ],
        heldBuilds: [],
        stoppedDeployment: null,
      });

      const [stored] = await ctx.db
        .select()
        .from(plan)
        .where(eq(plan.planId, asked.planId as string));
      // The Agent is who asked, as a person asking from the console would be.
      expect(stored).toMatchObject({ status: 'open', requestedBy: agent.id });

      expect(
        payloadOf(
          await callTool(agent.key, 'get_plan', {
            environmentId: t.production.environmentId,
          }),
        ),
      ).toEqual({ plan: asked });

      expect(await rowsOf(agent.id)).toEqual([
        {
          resourceType: 'environment',
          action: 'read',
          outcome: 'succeeded',
          resourceId: t.production.environmentId,
          tool: 'get_plan',
        },
        {
          resourceType: 'environment',
          action: 'create',
          outcome: 'succeeded',
          resourceId: t.production.environmentId,
          tool: 'request_plan',
        },
        {
          resourceType: 'environment',
          action: 'read',
          outcome: 'succeeded',
          resourceId: t.production.environmentId,
          tool: 'get_plan',
        },
      ]);
    });

    it('plans a web-private for an Agent, which reads it and has no tool to apply it', async () => {
      const t = await tree();
      await storeConfig(
        t.granted.projectId,
        `version: 1
services:
  shop:
    kind: web
  api:
    kind: web-private
    port: 4000
`,
      );
      const agent = await createAgent(t);

      const asked = payloadOf(
        await callTool(agent.key, 'request_plan', {
          environmentId: t.production.environmentId,
        }),
      );

      expect(asked.status).toBe('open');
      expect(asked.steps).toEqual([
        expect.objectContaining({
          action: 'create',
          configName: 'api',
          kind: 'web-private',
          fields: [{ field: 'port', from: null, to: 4000 }],
        }),
      ]);
      expect(
        payloadOf(
          await callTool(agent.key, 'get_plan', {
            environmentId: t.production.environmentId,
          }),
        ),
      ).toEqual({ plan: asked });
      // The tool list holds nothing that applies a plan (below), and the
      // statements an Apply checks are refused on an Agent's role.
    });

    it('plans a worker for an Agent, which reads the plan and holds no statement that applies it', async () => {
      const t = await tree();
      await storeConfig(
        t.granted.projectId,
        `version: 1
services:
  shop:
    kind: web
  jobs:
    kind: worker
    command: node dist/worker.js
`,
      );
      const agent = await createAgent(t, 'agentOperator');

      const asked = payloadOf(
        await callTool(agent.key, 'request_plan', {
          environmentId: t.production.environmentId,
        }),
      );
      expect(asked.status).toBe('open');
      expect(asked.steps).toEqual([
        expect.objectContaining({
          action: 'create',
          configName: 'jobs',
          kind: 'worker',
        }),
      ]);
      expect(
        payloadOf(
          await callTool(agent.key, 'get_plan', {
            environmentId: t.production.environmentId,
          }),
        ),
      ).toEqual({ plan: asked });

      // An Apply of it would need service: create on the Project, which no
      // Agent role holds; and no Service was made by asking.
      await expect(
        ctx.app.get(PermissionService).checkServiceAccess(
          {
            user: { id: agent.id },
            session: { activeOrganizationId: organizationId },
          },
          t.granted.projectId,
          'create',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const [stored] = await ctx.db
        .select({ status: plan.status })
        .from(plan)
        .where(eq(plan.planId, asked.planId as string));
      expect(stored.status).toBe('open');
    });

    it('plans a Cron service for an Agent, which reads the plan and holds no statement that applies it', async () => {
      const t = await tree();
      await storeConfig(
        t.granted.projectId,
        `version: 1
services:
  shop:
    kind: web
  report:
    kind: cron
    command: node dist/report.js
    schedule: "0 3 * * *"
`,
      );
      const agent = await createAgent(t, 'agentOperator');

      const asked = payloadOf(
        await callTool(agent.key, 'request_plan', {
          environmentId: t.production.environmentId,
        }),
      );
      expect(asked.steps).toEqual([
        expect.objectContaining({
          action: 'create',
          configName: 'report',
          kind: 'cron',
          fields: [
            { field: 'command', from: null, to: 'node dist/report.js' },
            { field: 'schedule', from: null, to: '0 3 * * *' },
          ],
        }),
      ]);
      expect(
        payloadOf(
          await callTool(agent.key, 'get_plan', {
            environmentId: t.production.environmentId,
          }),
        ),
      ).toEqual({ plan: asked });

      // An Apply of it would need service: create on the Project, which no
      // Agent role holds; and no Service was made by asking.
      await expect(
        ctx.app.get(PermissionService).checkServiceAccess(
          {
            user: { id: agent.id },
            session: { activeOrganizationId: organizationId },
          },
          t.granted.projectId,
          'create',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const [stored] = await ctx.db
        .select({ status: plan.status })
        .from(plan)
        .where(eq(plan.planId, asked.planId as string));
      expect(stored.status).toBe('open');
    });

    it('answers the builds a plan holds, by Deployment, Application, Config name and status, and nothing else of them', async () => {
      const t = await tree();
      await storeConfig(t.granted.projectId, CHANGES);
      const agent = await createAgent(t);
      const asked = payloadOf(
        await callTool(agent.key, 'request_plan', {
          environmentId: t.production.environmentId,
        }),
      );
      const [held] = await ctx.db
        .insert(deployment)
        .values({
          applicationId: t.shop.applicationId,
          title: 'feat: listen on 8080',
          description: 'A push held for its plan',
          status: 'held',
          logPath: '/tmp/held.log',
          heldByPlanId: asked.planId as string,
        })
        .returning();

      const read = payloadOf(
        await callTool(agent.key, 'get_plan', {
          environmentId: t.production.environmentId,
        }),
      ) as { plan: { heldBuilds: unknown } };

      expect(read.plan.heldBuilds).toEqual([
        {
          deploymentId: held.deploymentId,
          applicationId: t.shop.applicationId,
          configName: 'shop',
          status: 'held',
        },
      ]);
    });

    it('plans a mysql entry for an Agent like any kind, which it reads but never applies', async () => {
      const t = await tree();
      await storeConfig(
        t.granted.projectId,
        `${CHANGES}  shop-db:\n    kind: mysql\n`,
      );
      for (const role of ['agentReader', 'agentOperator'] as const) {
        const agent = await createAgent(t, role);
        const asked = payloadOf(
          await callTool(agent.key, 'request_plan', {
            environmentId: t.production.environmentId,
          }),
        );
        expect(asked.steps).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              action: 'create',
              configName: 'shop-db',
              kind: 'mysql',
            }),
          ]),
        );
        expect(
          payloadOf(
            await callTool(agent.key, 'get_plan', {
              environmentId: t.production.environmentId,
            }),
          ),
        ).toEqual({ plan: asked });
      }
      // Asking plans only; the "no apply tool" tests hold that nothing applies.
      expect(await ctx.db.select().from(mysql)).toEqual([]);
    });

    it('refuses an ungranted Environment on both tools, and plans nothing there', async () => {
      const t = await tree();
      await storeConfig(t.granted.projectId, CHANGES);
      const agent = await createAgent(t);

      for (const name of ['get_plan', 'request_plan']) {
        for (const environmentId of [
          t.staging.environmentId,
          'no-such-environment',
        ]) {
          expect(
            resultOf(await callTool(agent.key, name, { environmentId })),
          ).toEqual(REFUSED);
        }
      }
      expect(
        await ctx.db
          .select()
          .from(plan)
          .where(eq(plan.environmentId, t.staging.environmentId)),
      ).toEqual([]);
    });

    it('answers a config that cannot be planned, or no config at all, as a failure the operator fixes, leaving the open plan', async () => {
      const t = await tree();
      await storeConfig(t.granted.projectId, CHANGES);
      const agent = await createAgent(t);
      const open = payloadOf(
        await callTool(agent.key, 'request_plan', {
          environmentId: t.production.environmentId,
        }),
      );

      await storeConfig(
        t.granted.projectId,
        'version: 1\nservices:\n  shop:\n    kind: web\n    prot: 80\n',
      );
      const refused = resultOf(
        await callTool(agent.key, 'request_plan', {
          environmentId: t.production.environmentId,
        }),
      );
      expect(refused).toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: "The Project config cannot be planned as it stands. An operator sees where on the Project's Config page; ask them to fix it, then ask for a plan again.",
          },
        ],
      });

      await ctx.db
        .delete(projectConfigLocation)
        .where(eq(projectConfigLocation.projectId, t.granted.projectId));
      expect(
        resultOf(
          await callTool(agent.key, 'request_plan', {
            environmentId: t.production.environmentId,
          }),
        ),
      ).toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: 'This Project has no Project config yet, so there is nothing to plan. An operator gives it one in the console.',
          },
        ],
      });

      expect(
        payloadOf(
          await callTool(agent.key, 'get_plan', {
            environmentId: t.production.environmentId,
          }),
        ),
      ).toEqual({ plan: open });
    });

    it("answers a repository-kept config whose file cannot be read as the operator's to fix, as the console is refused (US71)", async () => {
      const t = await tree();
      // Kept in a repository whose connection is gone: nothing can read it.
      await ctx.db
        .update(projectConfigLocation)
        .set({
          kind: 'repository',
          text: null,
          gitProviderId: null,
          repository: 'acme/shop',
          path: 'cloudgate.yaml',
        })
        .where(eq(projectConfigLocation.projectId, t.granted.projectId));
      const agent = await createAgent(t);

      expect(
        resultOf(
          await callTool(agent.key, 'request_plan', {
            environmentId: t.production.environmentId,
          }),
        ),
      ).toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: "The Project config cannot be read from its repository, so no plan was made. An operator sees which repository and branch on the Project's Config page; ask them to fix the connection or the branch, then ask for a plan again.",
          },
        ],
      });
    });
  });

  describe('no apply tool', () => {
    it('lists the three Project config tools to both agent roles, the plan request as a write, and nothing that applies or dismisses a plan', async () => {
      const t = await tree();
      for (const role of ['agentReader', 'agentOperator'] as const) {
        const agent = await createAgent(t, role);
        const res = await post(agent.key, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
        });
        expect(res.status).toBe(200);
        const tools = (
          res.body as {
            result: {
              tools: Array<{
                name: string;
                annotations: { readOnlyHint: boolean };
              }>;
            };
          }
        ).result.tools;
        const names = tools.map((tool) => tool.name);

        expect(names.slice(-3)).toEqual([
          'get_project_config',
          'get_plan',
          'request_plan',
        ]);
        expect(
          tools.slice(-3).map((tool) => tool.annotations.readOnlyHint),
        ).toEqual([true, true, false]);
        expect(names.filter((name) => /apply|dismiss/.test(name))).toEqual([]);
      }
    });

    it("holds no Service write in either agent role: each statement an Apply checks, and a dismiss's, is refused on the Agent's own grant", async () => {
      expect(agentReaderRole.statements.service).toEqual(['read']);
      expect(agentOperatorRole.statements.service).toEqual(['read']);

      const t = await tree();
      const permissions = ctx.app.get(PermissionService);
      for (const role of ['agentReader', 'agentOperator'] as const) {
        const agent = await createAgent(t, role);
        const as: PermissionCtx = {
          user: { id: agent.id },
          session: { activeOrganizationId: organizationId },
        };
        // Every id is in the grant, so a refusal is the role's, not the grant's.
        const decide = async (check: () => Promise<void>) => {
          try {
            await check();
            return 'allowed';
          } catch (error) {
            expect(error).toBeInstanceOf(ForbiddenException);
            return 'refused';
          }
        };
        expect([
          role,
          await decide(() =>
            permissions.checkServiceAccess(as, t.granted.projectId, 'create'),
          ),
          await decide(() =>
            permissions.checkServiceAccess(as, t.shop.applicationId, 'update'),
          ),
          await decide(() =>
            permissions.checkServiceAccess(as, t.shop.applicationId, 'delete'),
          ),
          await decide(() =>
            permissions.checkEnvironmentAccess(
              as,
              t.production.environmentId,
              'update',
            ),
          ),
          // …while what the three tools need is held.
          await decide(() =>
            permissions.checkEnvironmentAccess(
              as,
              t.production.environmentId,
              'read',
            ),
          ),
        ]).toEqual([
          role,
          'refused',
          'refused',
          'refused',
          'refused',
          'allowed',
        ]);
      }
    });
  });
});
