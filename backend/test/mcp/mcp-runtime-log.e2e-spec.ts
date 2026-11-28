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
  cloudAccount,
  compose,
  member,
  server,
} from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { stackVmRemoteId } from '../../src/remote/stack-vm-remote';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

/**
 * `read_runtime_log` driven from outside, as `mcp-service-reads.e2e-spec.ts`
 * drives the other Service reads: a real Agent key against the real
 * `POST /mcp`, asserting on the answer and the audit rows (ADR-0095).
 *
 * Two boundaries are doubled and nothing else (§1.7): the exec layer, which
 * answers each machine's `docker` as that machine would and records what was
 * run where, and the cloud port (`ctx.cloud`), which holds a CloudWatch log
 * group. Sentences and numbers are written out here, not imported.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const FINALITY =
  'This is an access decision, not a failure. Retrying, or trying another tool or id, will not change it. Tell the operator what you needed.';
const NOT_FOUND_OR_NOT_PERMITTED = `Not found or not permitted. ${FINALITY}`;
const SWITCH_OFF = `This Agent's Can read runtime logs switch is off, so it reads no Runtime log. An operator can turn it on from the Agent's row in the console. ${FINALITY}`;
const GATEWAY_ONLY = `This Agent's role only calls AI models through the Gateway and holds no tool here. ${FINALITY}`;

/** A stored variable the app prints, long enough to be masked. */
const APP_SECRET = 'sk-live-4f9a8b7c6d5e';
const MASK = '••••••';
const PLATFORM_HOST = 'platform host';
const TOO_LARGE =
  'This part of the Runtime log is larger than 1 MiB. Ask for fewer lines.';
const GIVE_A_LATER_SINCE =
  'More of this Runtime log was written in the time asked for than one call reads, so its last lines could not be reached. Give a later since.';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface Window {
  serviceType: string;
  serviceId: string;
  lines: number;
  since: string | null;
  log: string;
}

/** What `docker … logs --timestamps` prints of a line at `at`. */
const stamped = (at: string, rest: string) => `${at} ${rest}`;

describe('MCP read_runtime_log (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;
  let ownerId: string;
  let organizationId: string;

  /**
   * Each machine's answers, by the place the command ran: a Server's id, a
   * Stack VM's remote id, or {@link PLATFORM_HOST}. The first pattern a
   * command matches answers its stdout; anything else answers nothing.
   */
  const machines = new Map<string, Array<[RegExp, string]>>();
  /** Every command run, with where. */
  const ran: Array<{ at: string; command: string }> = [];
  const answer = (at: string, command: string) => {
    ran.push({ at, command });
    const found = (machines.get(at) ?? []).find(([pattern]) =>
      pattern.test(command),
    );
    return Promise.resolve({
      stdout: found ? found[1] : '',
      stderr: '',
      exitCode: 0,
    });
  };
  const execMock = {
    execAsync: jest.fn((command: string) => answer(PLATFORM_HOST, command)),
    execAsyncRemote: jest.fn((serverId: string, command: string) =>
      answer(serverId, command),
    ),
    execFileAsync: jest.fn((file: string, args: string[]) =>
      answer(PLATFORM_HOST, [file, ...args].join(' ')),
    ),
    execRemote: jest.fn((serverId: string, argv: string[]) =>
      answer(serverId, argv.join(' ')),
    ),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    machines.clear();
    ran.length = 0;
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
   * One Environment holding a granted Application (with a stored secret),
   * Compose and Postgres and an ungranted Application, and an Application in
   * a second Organization of the owner's.
   */
  async function tree() {
    const home = ctxIn(organizationId);
    const projects = ctx.app.get(ProjectsService);
    const environments = ctx.app.get(EnvironmentsService);
    const applications = ctx.app.get(ApplicationsService);
    const project = await projects.create(home, { name: 'storefront' });
    const environment = await environments.create(home, {
      name: 'production',
      projectId: project.projectId,
    });
    const app = await applications.create(home, {
      name: 'Web',
      appName: 'web-app',
      environmentId: environment.environmentId,
    });
    await ctx.db
      .update(application)
      .set({ env: `API_TOKEN=${APP_SECRET}` })
      .where(eq(application.applicationId, app.applicationId));
    const worker = await applications.create(home, {
      name: 'Worker',
      appName: 'worker-app',
      environmentId: environment.environmentId,
    });
    const stack = await ctx.app.get(ComposeService).create(home, {
      name: 'Stack',
      appName: 'stack-app',
      environmentId: environment.environmentId,
    });
    const database = await ctx.app.get(PostgresService).create(home, {
      name: 'Orders',
      appName: 'orders-db',
      databaseName: 'orders',
      databaseUser: 'orders_user',
      databasePassword: 'pg-pass-0e1f2a3b4c',
      environmentId: environment.environmentId,
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
    return { project, environment, app, worker, stack, database, foreign };
  }

  type Tree = Awaited<ReturnType<typeof tree>>;

  async function agentFor(
    t: Tree,
    options: { role?: string; canReadRuntimeLogs?: boolean } = {},
  ): Promise<{ id: string; key: string }> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({
        name: 'crash-reader',
        role: options.role ?? 'agentReader',
        canReadRuntimeLogs: options.canReadRuntimeLogs ?? true,
        grant: {
          accessedProjects: [t.project.projectId],
          accessedEnvironments: [t.environment.environmentId],
          accessedServices: [
            t.app.applicationId,
            t.stack.composeId,
            t.database.postgresId,
          ],
        },
      });
    expect(res.status).toBe(201);
    const body = res.body as { agent: { id: string }; key: string };
    return { id: body.agent.id, key: body.key };
  }

  function callTool(key: string, args: Record<string, unknown>) {
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
        params: { name: 'read_runtime_log', arguments: args },
      });
  }

  function resultOf(res: request.Response): ToolResult {
    expect(res.status).toBe(200);
    return (res.body as { result: ToolResult }).result;
  }

  function windowOf(res: request.Response): Window {
    const result = resultOf(res);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text) as Window;
  }

  async function rowsOf(agentId: string) {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.userId, agentId))
      .orderBy(asc(auditLog.createdAt));
    return rows.map((row) => {
      const metadata = JSON.parse(row.metadata ?? '{}') as Record<
        string,
        unknown
      >;
      return [
        row.resourceType,
        row.outcome,
        row.resourceId,
        metadata.tool,
        metadata.reason ?? null,
      ];
    });
  }

  /** An Application's Swarm service on `at`, two copies printing `lines`. */
  function swarmService(at: string, name: string, lines: string[]) {
    machines.set(at, [
      [new RegExp(`^docker service ls --filter name=${name} `), `${name}\n`],
      [new RegExp(`docker service logs .*${name}$`), `${lines.join('\n')}\n`],
    ]);
  }

  /** Puts Web in an AWS Cloud account; answers its CloudWatch log group. */
  async function webInCloud(t: Tree): Promise<string> {
    const [account] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name: 'Production AWS',
        cloud: 'aws',
        cloudId: '123456789012',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
        taskExecutionRoleArn:
          'arn:aws:iam::123456789012:role/cloudgate-task-execution',
        externalId: 'external-id-made-by-cloudgate',
        policyVersion: 1,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    await ctx.db
      .update(application)
      .set({
        serverId: null,
        cloudAccountId: account.cloudAccountId,
        region: 'eu-central-1',
      })
      .where(eq(application.applicationId, t.app.applicationId));
    return `/cloudgate/${t.environment.environmentId}/${t.app.applicationId}`;
  }

  /** Two copies of web-app, interleaved by time, as Docker hands them over. */
  const WEB_COPIES = [
    // Docker reads each copy's tail on its own, so copy 1's come first.
    stamped(
      '2026-11-28T10:00:01.000000001Z',
      'web-app.1@node-1    | listening on :3000',
    ),
    stamped(
      '2026-11-28T10:00:04.250000000Z',
      `web-app.1@node-1    | boot with token ${APP_SECRET}`,
    ),
    stamped(
      '2026-11-28T10:00:02.500000000Z',
      'web-app.2@node-1    | listening on :3000',
    ),
    stamped(
      '2026-11-28T10:00:05.000000000Z',
      'web-app.2@node-1    | Error: out of memory',
    ),
  ];

  describe('with the switch on', () => {
    it("reads an Application's last lines on the platform host, every copy merged by time and naming its copy, with a stored secret masked", async () => {
      const t = await tree();
      swarmService(PLATFORM_HOST, 'web-app', WEB_COPIES);
      const agent = await agentFor(t);

      const res = await callTool(agent.key, {
        serviceType: 'application',
        serviceId: t.app.applicationId,
      });

      expect(windowOf(res)).toEqual({
        serviceType: 'application',
        serviceId: t.app.applicationId,
        lines: 100,
        since: null,
        log: [
          '2026-11-28T10:00:01.000Z [web-app.1] listening on :3000',
          '2026-11-28T10:00:02.500Z [web-app.2] listening on :3000',
          `2026-11-28T10:00:04.250Z [web-app.1] boot with token ${MASK}`,
          '2026-11-28T10:00:05.000Z [web-app.2] Error: out of memory',
          '',
        ].join('\n'),
      });
      expect(JSON.stringify(res.body)).not.toContain(APP_SECRET);
      // The container-logs socket's command with follow=false: no --follow.
      expect(
        ran
          .filter(({ command }) => command.includes('logs'))
          .map(({ at, command }) => [at, command.replace(/\s+/g, ' ')]),
      ).toEqual([
        [
          PLATFORM_HOST,
          'docker service logs --timestamps --no-task-ids --tail 100 web-app',
        ],
      ]);
      expect(await rowsOf(agent.id)).toEqual([
        [
          'application',
          'succeeded',
          t.app.applicationId,
          'read_runtime_log',
          null,
        ],
      ]);
    });

    it('honours lines and since, answering at most 500 lines however many are asked', async () => {
      const t = await tree();
      swarmService(PLATFORM_HOST, 'web-app', WEB_COPIES);
      const agent = await agentFor(t);

      const last = windowOf(
        await callTool(agent.key, {
          serviceType: 'application',
          serviceId: t.app.applicationId,
          lines: 2,
        }),
      );
      expect(last.lines).toBe(2);
      expect(last.log.split('\n').filter(Boolean)).toEqual([
        `2026-11-28T10:00:04.250Z [web-app.1] boot with token ${MASK}`,
        '2026-11-28T10:00:05.000Z [web-app.2] Error: out of memory',
      ]);

      const after = windowOf(
        await callTool(agent.key, {
          serviceType: 'application',
          serviceId: t.app.applicationId,
          since: '2026-11-28T10:00:02.500Z',
        }),
      );
      expect(after.since).toBe('2026-11-28T10:00:02.500Z');
      expect(after.log.split('\n').filter(Boolean)).toEqual([
        '2026-11-28T10:00:02.500Z [web-app.2] listening on :3000',
        `2026-11-28T10:00:04.250Z [web-app.1] boot with token ${MASK}`,
        '2026-11-28T10:00:05.000Z [web-app.2] Error: out of memory',
      ]);

      const capped = windowOf(
        await callTool(agent.key, {
          serviceType: 'application',
          serviceId: t.app.applicationId,
          lines: 5000,
        }),
      );
      expect(capped.lines).toBe(500);

      const commands = ran
        .filter(({ command }) => command.includes('service logs'))
        .map(({ command }) => command.replace(/\s+/g, ' '));
      expect(commands).toEqual([
        'docker service logs --timestamps --no-task-ids --tail 2 web-app',
        // Docker is asked from the second `since` falls in, as epoch seconds.
        'docker service logs --timestamps --no-task-ids --tail 100 --since 1795860002 web-app',
        'docker service logs --timestamps --no-task-ids --tail 500 web-app',
      ]);
    });

    it("reads an Application on a Server over that Server's exec", async () => {
      const t = await tree();
      const [remote] = await ctx.db
        .insert(server)
        .values({
          name: 'worker-1',
          ipAddress: '203.0.113.20',
          port: 22,
          organizationId,
        })
        .returning();
      await ctx.db
        .update(application)
        .set({ serverId: remote.serverId })
        .where(eq(application.applicationId, t.app.applicationId));
      swarmService(remote.serverId, 'web-app', WEB_COPIES.slice(3));
      const agent = await agentFor(t);

      const window = windowOf(
        await callTool(agent.key, {
          serviceType: 'application',
          serviceId: t.app.applicationId,
        }),
      );

      expect(window.log).toBe(
        '2026-11-28T10:00:05.000Z [web-app.2] Error: out of memory\n',
      );
      expect(ran.every(({ at }) => at === remote.serverId)).toBe(true);
    });

    it("reads a Compose's containers, crashed ones included, each line naming its container", async () => {
      const t = await tree();
      machines.set(PLATFORM_HOST, [
        [
          /^docker ps -a --filter label=com\.docker\.compose\.project=stack-app /,
          'c0ffee01|stack-app-api-1\nc0ffee02|stack-app-worker-1\n',
        ],
        [
          /container logs .*c0ffee01$/,
          stamped('2026-11-28T10:00:03.000000000Z', 'GET /orders 500\n'),
        ],
        [
          /container logs .*c0ffee02$/,
          stamped('2026-11-28T10:00:01.000000000Z', 'worker exited 137\n'),
        ],
      ]);
      const agent = await agentFor(t);

      const window = windowOf(
        await callTool(agent.key, {
          serviceType: 'compose',
          serviceId: t.stack.composeId,
        }),
      );

      expect(window).toMatchObject({
        serviceType: 'compose',
        serviceId: t.stack.composeId,
        log: [
          '2026-11-28T10:00:01.000Z [stack-app-worker-1] worker exited 137',
          '2026-11-28T10:00:03.000Z [stack-app-api-1] GET /orders 500',
          '',
        ].join('\n'),
      });
      // The row names the Service by its kind, as get_service's does.
      expect(await rowsOf(agent.id)).toEqual([
        ['compose', 'succeeded', t.stack.composeId, 'read_runtime_log', null],
      ]);
    });

    it("reads a Compose on its own Stack VM through the cloud's tunnel", async () => {
      const t = await tree();
      const [account] = await ctx.db
        .insert(cloudAccount)
        .values({
          organizationId,
          name: 'Production AWS',
          cloud: 'aws',
          cloudId: '123456789012',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
          taskExecutionRoleArn:
            'arn:aws:iam::123456789012:role/cloudgate-task-execution',
          externalId: 'external-id-made-by-cloudgate',
          policyVersion: 1,
          lastCheckedAt: new Date().toISOString(),
          lastCheckResult: 'passed',
        })
        .returning();
      await ctx.db
        .update(compose)
        .set({ cloudAccountId: account.cloudAccountId, region: 'eu-central-1' })
        .where(eq(compose.composeId, t.stack.composeId));
      const stackVm = stackVmRemoteId(t.stack.composeId);
      machines.set(stackVm, [
        [/^docker ps -a /, 'beef01|stack-app-api-1\n'],
        [
          /container logs .*beef01$/,
          stamped('2026-11-28T10:00:03.000000000Z', 'on the Stack VM\n'),
        ],
      ]);
      const agent = await agentFor(t);

      const window = windowOf(
        await callTool(agent.key, {
          serviceType: 'compose',
          serviceId: t.stack.composeId,
        }),
      );

      expect(window.log).toBe(
        '2026-11-28T10:00:03.000Z [stack-app-api-1] on the Stack VM\n',
      );
      expect(ran.map(({ at }) => at)).toEqual([stackVm, stackVm]);
    });

    it('reads an Application in a Cloud account from its CloudWatch log group, with a stored secret masked', async () => {
      const t = await tree();
      const [account] = await ctx.db
        .insert(cloudAccount)
        .values({
          organizationId,
          name: 'Production AWS',
          cloud: 'aws',
          cloudId: '123456789012',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
          taskExecutionRoleArn:
            'arn:aws:iam::123456789012:role/cloudgate-task-execution',
          externalId: 'external-id-made-by-cloudgate',
          policyVersion: 1,
          lastCheckedAt: new Date().toISOString(),
          lastCheckResult: 'passed',
        })
        .returning();
      await ctx.db
        .update(application)
        .set({
          serverId: null,
          cloudAccountId: account.cloudAccountId,
          region: 'eu-central-1',
        })
        .where(eq(application.applicationId, t.app.applicationId));
      const now = Date.now();
      const group = `/cloudgate/${t.environment.environmentId}/${t.app.applicationId}`;
      ctx.cloud.writeLog(group, 'task-a', [
        { timestamp: now - 3_000, message: 'a: listening on :8080\n' },
        { timestamp: now - 1_000, message: `a: token ${APP_SECRET}\n` },
      ]);
      ctx.cloud.writeLog(group, 'task-b', [
        { timestamp: now - 2_000, message: 'b: listening on :8080\n' },
      ]);
      const agent = await agentFor(t);

      const all = windowOf(
        await callTool(agent.key, {
          serviceType: 'application',
          serviceId: t.app.applicationId,
        }),
      );
      expect(all.log).toBe(
        [
          `${new Date(now - 3_000).toISOString()} [task-a] a: listening on :8080`,
          `${new Date(now - 2_000).toISOString()} [task-b] b: listening on :8080`,
          `${new Date(now - 1_000).toISOString()} [task-a] a: token ${MASK}`,
          '',
        ].join('\n'),
      );

      const after = windowOf(
        await callTool(agent.key, {
          serviceType: 'application',
          serviceId: t.app.applicationId,
          lines: 1,
          since: new Date(now - 2_500).toISOString(),
        }),
      );
      expect(after.log).toBe(
        `${new Date(now - 1_000).toISOString()} [task-a] a: token ${MASK}\n`,
      );
      // Never the machine path: a cloud Service has no container here.
      expect(ran).toEqual([]);
    });

    it("reads a stack Compose's Swarm services, each line naming its task", async () => {
      const t = await tree();
      await ctx.db
        .update(compose)
        .set({ composeType: 'stack' })
        .where(eq(compose.composeId, t.stack.composeId));
      machines.set(PLATFORM_HOST, [
        [
          /^docker service ls --filter label=com\.docker\.stack\.namespace=stack-app /,
          'stack-app_api\nstack-app_worker\n',
        ],
        [
          /service logs .*stack-app_api$/,
          stamped(
            '2026-11-28T10:00:03.000000000Z',
            'stack-app_api.1@node-1    | GET /orders 500\n',
          ),
        ],
        [
          /service logs .*stack-app_worker$/,
          stamped(
            '2026-11-28T10:00:01.000000000Z',
            'stack-app_worker.1@node-1    | worker exited 137\n',
          ),
        ],
      ]);
      const agent = await agentFor(t);

      const window = windowOf(
        await callTool(agent.key, {
          serviceType: 'compose',
          serviceId: t.stack.composeId,
        }),
      );

      expect(window.log).toBe(
        [
          '2026-11-28T10:00:01.000Z [stack-app_worker.1] worker exited 137',
          '2026-11-28T10:00:03.000Z [stack-app_api.1] GET /orders 500',
          '',
        ].join('\n'),
      );
      expect(
        ran
          .filter(({ command }) => command.includes('logs'))
          .map(({ command }) => command.replace(/\s+/g, ' ')),
      ).toEqual([
        'docker service logs --timestamps --no-task-ids --tail 100 stack-app_api',
        'docker service logs --timestamps --no-task-ids --tail 100 stack-app_worker',
      ]);
    });

    it("reads an AI model's Runtime log as the Application it is", async () => {
      const t = await tree();
      const llm = await ctx.app
        .get(ApplicationsService)
        .create(ctxIn(organizationId), {
          name: 'Llama',
          appName: 'llama-app',
          environmentId: t.environment.environmentId,
        });
      await ctx.db
        .update(application)
        .set({ gpus: 1 })
        .where(eq(application.applicationId, llm.applicationId));
      await ctx.db.insert(aiModelFacet).values({
        applicationId: llm.applicationId,
        runtime: 'ollama',
        model: 'smollm2:135m',
        upstreamSecret: 'upstream-secret-9d8c7b6a',
      });
      swarmService(PLATFORM_HOST, 'llama-app', [
        stamped(
          '2026-11-28T10:00:02.000000000Z',
          'llama-app.1@node-1    | CUDA error: out of memory',
        ),
      ]);
      const res = await request(httpServer)
        .post('/agents')
        .set('Cookie', ownerCookie)
        .send({
          name: 'model-reader',
          role: 'agentReader',
          canReadRuntimeLogs: true,
          grant: {
            accessedProjects: [t.project.projectId],
            accessedEnvironments: [t.environment.environmentId],
            accessedServices: [llm.applicationId],
          },
        });
      expect(res.status).toBe(201);
      const { key } = res.body as { key: string };

      expect(
        windowOf(
          await callTool(key, {
            serviceType: 'application',
            serviceId: llm.applicationId,
          }),
        ),
      ).toEqual({
        serviceType: 'application',
        serviceId: llm.applicationId,
        lines: 100,
        since: null,
        log: '2026-11-28T10:00:02.000Z [llama-app.1] CUDA error: out of memory\n',
      });
    });

    it('refuses a window larger than 1 MiB once its copies are merged, asking for fewer lines', async () => {
      const t = await tree();
      // Each copy is under the 1 MiB one read may carry; the two are not.
      swarmService(PLATFORM_HOST, 'web-app', [
        stamped(
          '2026-11-28T10:00:01.000000000Z',
          `web-app.1@node-1    | ${'a'.repeat(600_000)}`,
        ),
        stamped(
          '2026-11-28T10:00:02.000000000Z',
          `web-app.2@node-1    | ${'b'.repeat(600_000)}`,
        ),
      ]);
      const agent = await agentFor(t);

      const result = resultOf(
        await callTool(agent.key, {
          serviceType: 'application',
          serviceId: t.app.applicationId,
        }),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(TOO_LARGE);
    });

    it("keeps a Cloud account's newest lines when the hour before holds more than one call reads", async () => {
      const t = await tree();
      const group = await webInCloud(t);
      const now = Date.now();
      // 6000 lines between 50 and 40 minutes ago: more than five pages.
      ctx.cloud.writeLog(
        group,
        'task-a',
        Array.from({ length: 6000 }, (_, i) => ({
          timestamp: now - 50 * 60_000 + i * 100,
          message: `old line ${i}\n`,
        })),
      );
      ctx.cloud.writeLog(group, 'task-b', [
        { timestamp: now - 3_000, message: 'b: listening on :8080\n' },
        { timestamp: now - 1_000, message: 'b: Error: out of memory\n' },
      ]);
      const agent = await agentFor(t);

      const window = windowOf(
        await callTool(agent.key, {
          serviceType: 'application',
          serviceId: t.app.applicationId,
        }),
      );

      expect(window.log).toBe(
        [
          `${new Date(now - 3_000).toISOString()} [task-b] b: listening on :8080`,
          `${new Date(now - 1_000).toISOString()} [task-b] b: Error: out of memory`,
          '',
        ].join('\n'),
      );
    });

    it('asks for a later since when the Cloud account says more is left on every page', async () => {
      const t = await tree();
      const group = await webInCloud(t);
      const now = Date.now();
      ctx.cloud.writeLog(group, 'task-a', [
        { timestamp: now - 2_000, message: 'a: listening on :8080\n' },
        { timestamp: now - 1_000, message: 'a: Error: out of memory\n' },
      ]);
      const filterLogStreams = ctx.cloud.filterLogStreams.bind(ctx.cloud);
      const always = jest
        .spyOn(ctx.cloud, 'filterLogStreams')
        .mockImplementation(async (session, query) => {
          const answer = await filterLogStreams(session, query);
          return answer.ok
            ? { ok: true, value: { ...answer.value, more: true } }
            : answer;
        });
      const agent = await agentFor(t);

      try {
        for (const since of [undefined, new Date(now - 2_500).toISOString()]) {
          const result = resultOf(
            await callTool(agent.key, {
              serviceType: 'application',
              serviceId: t.app.applicationId,
              ...(since === undefined ? {} : { since }),
            }),
          );
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toBe(GIVE_A_LATER_SINCE);
        }
        // Each call stops at its five pages.
        expect(always).toHaveBeenCalledTimes(10);
      } finally {
        always.mockRestore();
      }
    });

    it('answers an empty log for a Service with nothing deployed yet', async () => {
      const t = await tree();
      const agent = await agentFor(t);

      expect(
        windowOf(
          await callTool(agent.key, {
            serviceType: 'application',
            serviceId: t.app.applicationId,
          }),
        ).log,
      ).toBe('');
    });
  });

  describe('refusals', () => {
    it('refuses an Agent whose switch is off, naming the switch, and runs nothing', async () => {
      const t = await tree();
      swarmService(PLATFORM_HOST, 'web-app', WEB_COPIES);
      const agent = await agentFor(t, { canReadRuntimeLogs: false });

      const res = await callTool(agent.key, {
        serviceType: 'application',
        serviceId: t.app.applicationId,
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        code: 'refused',
        reason: 'permission',
        tool: 'read_runtime_log',
        switch: 'canReadRuntimeLogs',
        message: SWITCH_OFF,
      });
      expect(ran).toEqual([]);
      expect(await rowsOf(agent.id)).toEqual([
        [
          'application',
          'refused',
          t.app.applicationId,
          'read_runtime_log',
          'permission',
        ],
      ]);

      // The switch is read at the call: turned on, the next call reads.
      await ctx.db
        .update(member)
        .set({ canReadRuntimeLogs: true })
        .where(eq(member.userId, agent.id));
      expect(
        windowOf(
          await callTool(agent.key, {
            serviceType: 'application',
            serviceId: t.app.applicationId,
          }),
        ).serviceId,
      ).toBe(t.app.applicationId);
    });

    it('refuses a Caller Agent as at every other tool', async () => {
      const t = await tree();
      const caller = await agentFor(t, {
        role: 'agentCaller',
        canReadRuntimeLogs: false,
      });

      const res = await callTool(caller.key, {
        serviceType: 'application',
        serviceId: t.app.applicationId,
      });

      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toBe(GATEWAY_ONLY);
      expect(ran).toEqual([]);
    });

    it("answers a database, an ungranted Service, another Organization's and an unknown id with the one not-found", async () => {
      const t = await tree();
      const agent = await agentFor(t);

      for (const serviceId of [
        t.database.postgresId,
        t.worker.applicationId,
        t.foreign.applicationId,
        // A Compose's id under the other kind is no Application.
        t.stack.composeId,
        'no-such-service',
      ]) {
        expect(
          resultOf(
            await callTool(agent.key, {
              serviceType: 'application',
              serviceId,
            }),
          ),
        ).toEqual({
          content: [{ type: 'text', text: NOT_FOUND_OR_NOT_PERMITTED }],
          structuredContent: {
            code: 'refused',
            reason: 'grant',
            message: NOT_FOUND_OR_NOT_PERMITTED,
          },
          isError: true,
        });
      }
      expect(ran).toEqual([]);
      expect((await rowsOf(agent.id)).map((row) => row.slice(1, 5))).toEqual([
        ['refused', t.database.postgresId, 'read_runtime_log', 'grant'],
        ['refused', t.worker.applicationId, 'read_runtime_log', 'grant'],
        ['refused', t.foreign.applicationId, 'read_runtime_log', 'grant'],
        ['refused', t.stack.composeId, 'read_runtime_log', 'grant'],
        ['refused', 'no-such-service', 'read_runtime_log', 'grant'],
      ]);
    });
  });

  describe('GET /applications/:id/runtime-log', () => {
    it('answers a Server Service for a person: its lines from since, merged by time, each naming its copy', async () => {
      const t = await tree();
      swarmService(PLATFORM_HOST, 'web-app', WEB_COPIES);
      const since = Date.parse('2026-11-28T10:00:02.000Z');

      const res = await request(httpServer)
        .get(`/applications/${t.app.applicationId}/runtime-log`)
        .query({ since })
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(200);
      const body = res.body as {
        lines: { at: number; task: string; message: string }[];
        next: number;
        more: boolean;
      };
      expect(body.lines.map((line) => [line.task, line.message])).toEqual([
        ['web-app.2', 'listening on :3000'],
        ['web-app.1', `boot with token ${APP_SECRET}`],
        ['web-app.2', 'Error: out of memory'],
      ]);
      expect(body.next).toBe(Date.parse('2026-11-28T10:00:05.000Z'));
      expect(body.more).toBe(false);
    });

    it('answers more when a read fills its 1000 lines', async () => {
      const t = await tree();
      const since = Date.parse('2026-11-28T10:00:00.000Z');
      swarmService(
        PLATFORM_HOST,
        'web-app',
        Array.from({ length: 1000 }, (_, i) =>
          stamped(
            new Date(since + i * 1000).toISOString(),
            `web-app.1@node-1    | line ${i}`,
          ),
        ),
      );

      const res = await request(httpServer)
        .get(`/applications/${t.app.applicationId}/runtime-log`)
        .query({ since })
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(200);
      const body = res.body as {
        lines: unknown[];
        next: number;
        more: boolean;
      };
      expect(body.lines).toHaveLength(1000);
      expect(body.next).toBe(since + 999_000);
      expect(body.more).toBe(true);
    });
  });
});
