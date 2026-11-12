import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { aiUsage, member } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TOKEN_SPEND_CLOCK } from '../../src/token-spend/token-spend';
import { TokenSpendRetentionService } from '../../src/token-spend/token-spend-retention.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * **Token spend** totals on the Environment and the Project (spec
 * slice 3, stories 75–78): `GET /environments/:id/token-spend` and
 * `GET /projects/:id/token-spend` sum the AI models the reader can read, and
 * nothing else. Usage rows are written straight to the database, as the
 * Gateway writes them; the totals are observed through the reads.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const MODEL = 'smollm2:135m';
const NOW = new Date('2026-10-16T12:00:00.000Z');
const TODAY = '2026-10-16';

/** `TODAY` moved by `days`. */
const day = (days: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

type ExecOptions = { env?: Record<string, string | undefined> };

const figures = (prompt: number, completion: number, ok: number) => ({
  promptTokens: { reported: prompt, estimated: 0 },
  completionTokens: { reported: completion, estimated: 0 },
  calls: { ok, runtimeError: 0, clientAborted: 0, refused: 0 },
});
const NONE = figures(0, 0, 0);

interface Totals {
  from: string;
  to: string;
  total: unknown;
  days: { day: string }[];
  aiModels?: { applicationId: string; name: string; total: unknown }[];
  environments?: {
    environmentId: string;
    name: string;
    aiModelCount: number;
    total: unknown;
  }[];
}

describe('Token spend totals (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  const machine = (command: string): Promise<ExecResult> =>
    Promise.resolve(isPresenceProbe(command) ? ok('absent') : ok(''));
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string, ExecOptions?]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });
  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        {
          provide: RemoteDockerFactory,
          useValue: { getRemoteDocker: jest.fn().mockResolvedValue(docker) },
        },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
        { provide: TOKEN_SPEND_CLOCK, useValue: () => NOW },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  let ownerCookie: string;
  let organizationId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockImplementation(machine);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId, command) => machine(command));
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    queueMock.add.mockReset().mockResolvedValue(undefined);

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', ownerCookie);
    organizationId = (orgs.body as { id: string }[])[0].id;
  });

  async function createProject(name: string): Promise<string> {
    const res = await request(httpServer)
      .post('/projects')
      .set('Cookie', ownerCookie)
      .send({ name });
    expect(res.status).toBe(201);
    return (res.body as { projectId: string }).projectId;
  }

  async function createEnvironment(
    projectId: string,
    name: string,
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/environments')
      .set('Cookie', ownerCookie)
      .send({ name, projectId });
    expect(res.status).toBe(201);
    return (res.body as { environmentId: string }).environmentId;
  }

  async function createAiModel(
    environmentId: string,
    name: string,
  ): Promise<string> {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', ownerCookie)
      .send({
        environmentId,
        name,
        appName: name,
        aiModel: { runtime: 'ollama', model: MODEL },
      });
    expect(res.status).toBe(201);
    return (res.body as { applicationId: string }).applicationId;
  }

  /** `calls` ok calls on `applicationId` by one Agent, as the Gateway writes. */
  async function record(
    applicationId: string,
    agentName: string,
    calls: { at: string; prompt: number; completion: number }[],
  ): Promise<void> {
    await ctx.db.insert(aiUsage).values(
      calls.map((call) => ({
        applicationId,
        agentUserId: null,
        agentName,
        agentId: `agent-${agentName}`,
        apikeyId: `key-of-${agentName}`,
        model: MODEL,
        endpoint: '/v1/chat/completions',
        streamed: false,
        promptTokens: call.prompt,
        promptTokensEstimated: false,
        completionTokens: call.completion,
        completionTokensEstimated: false,
        startedAt: call.at,
        endedAt: call.at,
        outcome: 'ok' as const,
      })),
    );
  }

  const read = async (
    cookie: string,
    path: string,
    query: Record<string, string> = {},
  ) => {
    const res = await request(httpServer)
      .get(path)
      .query(query)
      .set('Cookie', cookie);
    return { status: res.status, body: res.body as Totals };
  };

  /** A Project with one Environment holding two AI models that spent. */
  async function supportProduction() {
    const projectId = await createProject('support');
    const production = await createEnvironment(projectId, 'production');
    const staging = await createEnvironment(projectId, 'staging');
    const chat = await createAiModel(production, 'chat');
    const embed = await createAiModel(production, 'embed');
    const draft = await createAiModel(staging, 'draft');
    await record(chat, 'support-bot', [
      { at: `${day(-1)}T10:00:00.000Z`, prompt: 100, completion: 10 },
      { at: `${TODAY}T09:00:00.000Z`, prompt: 50, completion: 5 },
    ]);
    await record(embed, 'indexer', [
      { at: `${day(-2)}T10:00:00.000Z`, prompt: 7, completion: 0 },
    ]);
    await record(draft, 'support-bot', [
      { at: `${TODAY}T08:00:00.000Z`, prompt: 3, completion: 1 },
    ]);
    return { projectId, production, staging, chat, embed, draft };
  }

  describe('GET /environments/:id/token-spend', () => {
    it('sums every AI model in the Environment for the owner, with each model’s figure, over the last 30 days', async () => {
      const { production, chat, embed } = await supportProduction();

      const res = await read(
        ownerCookie,
        `/environments/${production}/token-spend`,
      );

      expect(res.status).toBe(200);
      expect(res.body.from).toBe(day(-29));
      expect(res.body.to).toBe(TODAY);
      expect(res.body.days).toHaveLength(30);
      expect(res.body.total).toEqual(figures(157, 15, 3));
      expect(res.body.aiModels).toEqual([
        { applicationId: chat, name: 'chat', total: figures(150, 15, 2) },
        { applicationId: embed, name: 'embed', total: figures(7, 0, 1) },
      ]);
    });

    it('answers the same total after the nightly job has rolled the past days up', async () => {
      const { production } = await supportProduction();
      const before = await read(
        ownerCookie,
        `/environments/${production}/token-spend`,
      );

      await ctx.app.get(TokenSpendRetentionService).run(NOW);

      const after = await read(
        ownerCookie,
        `/environments/${production}/token-spend`,
      );
      expect(after.body).toEqual(before.body);
    });

    it('reads the days asked for', async () => {
      const { production } = await supportProduction();

      const res = await read(
        ownerCookie,
        `/environments/${production}/token-spend`,
        { from: day(-2), to: day(-1) },
      );

      expect(res.body.total).toEqual(figures(107, 10, 2));
      expect(res.body.days.map((entry) => entry.day)).toEqual([
        day(-2),
        day(-1),
      ]);
    });
  });

  describe('GET /projects/:id/token-spend', () => {
    it('sums every AI model in the Project for the owner, broken down by Environment', async () => {
      const { projectId, production, staging } = await supportProduction();

      const res = await read(ownerCookie, `/projects/${projectId}/token-spend`);

      expect(res.status).toBe(200);
      expect(res.body.total).toEqual(figures(160, 16, 4));
      expect(res.body.environments).toEqual([
        {
          environmentId: production,
          name: 'production',
          aiModelCount: 2,
          total: figures(157, 15, 3),
        },
        {
          environmentId: staging,
          name: 'staging',
          aiModelCount: 1,
          total: figures(3, 1, 1),
        },
      ]);
    });

    it('counts an Agent of Project B calling Project A’s AI model in A’s total and not B’s', async () => {
      const a = await supportProduction();
      const projectB = await createProject('billing');
      const bProduction = await createEnvironment(projectB, 'production');
      await createAiModel(bProduction, 'billing-llm');
      // The billing Project's Agent, its key in a Service of B, calls A's model.
      await record(a.chat, 'billing-bot', [
        { at: `${TODAY}T11:00:00.000Z`, prompt: 1000, completion: 100 },
      ]);

      const inA = await read(
        ownerCookie,
        `/projects/${a.projectId}/token-spend`,
      );
      const inB = await read(ownerCookie, `/projects/${projectB}/token-spend`);

      expect(inA.body.total).toEqual(figures(1160, 116, 5));
      expect(inB.body.total).toEqual(NONE);
      expect(inB.body.environments).toEqual([
        {
          environmentId: bProduction,
          name: 'production',
          aiModelCount: 1,
          total: NONE,
        },
      ]);
    });
  });

  describe('a reader’s grant', () => {
    async function memberWith(grant: {
      accessedProjects: string[];
      accessedEnvironments: string[];
      accessedServices: string[];
    }) {
      const plain = await signUpMember(httpServer, ownerCookie);
      await ctx.db
        .update(member)
        .set(grant)
        .where(
          and(
            eq(member.userId, plain.id),
            eq(member.organizationId, organizationId),
          ),
        );
      return plain;
    }

    it('sums only the AI models a member with a partial grant can read', async () => {
      const { projectId, production, staging, chat } =
        await supportProduction();
      const plain = await memberWith({
        accessedProjects: [projectId],
        accessedEnvironments: [production, staging],
        accessedServices: [chat],
      });

      const environment = await read(
        plain.cookie,
        `/environments/${production}/token-spend`,
      );
      const project = await read(
        plain.cookie,
        `/projects/${projectId}/token-spend`,
      );

      expect(environment.status).toBe(200);
      expect(environment.body.total).toEqual(figures(150, 15, 2));
      expect(environment.body.aiModels).toEqual([
        { applicationId: chat, name: 'chat', total: figures(150, 15, 2) },
      ]);
      expect(project.status).toBe(200);
      expect(project.body.total).toEqual(figures(150, 15, 2));
      expect(project.body.environments).toEqual([
        {
          environmentId: production,
          name: 'production',
          aiModelCount: 1,
          total: figures(150, 15, 2),
        },
        {
          environmentId: staging,
          name: 'staging',
          aiModelCount: 0,
          total: NONE,
        },
      ]);
    });

    it('leaves out an Environment the member cannot see, and the AI models in it', async () => {
      const { projectId, production, chat, draft } = await supportProduction();
      const plain = await memberWith({
        accessedProjects: [projectId],
        accessedEnvironments: [production],
        accessedServices: [chat, draft],
      });

      const project = await read(
        plain.cookie,
        `/projects/${projectId}/token-spend`,
      );

      expect(project.body.total).toEqual(figures(150, 15, 2));
      expect(
        project.body.environments?.map((env) => env.environmentId),
      ).toEqual([production]);
    });

    it('refuses a member without the Environment or the Project, and another organization', async () => {
      const { projectId, production } = await supportProduction();
      const plain = await memberWith({
        accessedProjects: [],
        accessedEnvironments: [],
        accessedServices: [],
      });
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        ownerCookie,
      );

      for (const path of [
        `/environments/${production}/token-spend`,
        `/projects/${projectId}/token-spend`,
      ]) {
        expect((await read(plain.cookie, path)).status).toBe(403);
        expect((await read(mallory.cookie, path)).status).toBe(404);
      }
    });
  });
});
