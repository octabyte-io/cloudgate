import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { aiUsage, aiUsageDaily, member } from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { AiUsageOutcome } from '../../src/gateway/ai-usage.schema';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  TOKEN_SPEND_CLOCK,
  USAGE_RAW_RETENTION_DAYS,
} from '../../src/token-spend/token-spend';
import { TokenSpendRetentionService } from '../../src/token-spend/token-spend-retention.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * **Token spend** kept and read (spec slice 3): the nightly job
 * that rolls the Gateway's raw usage rows up by day and prunes them at 90
 * days, driven through its own service method at a chosen "now" as
 * `log-retention` is; and `GET /applications/:id/token-spend`, read at the
 * same injected clock. Usage rows are written straight to the database, as
 * the Gateway writes them (its own suite proves that); everything after is
 * observed as an operator observes it, through the read.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const MODEL = 'smollm2:135m';
const NOW = new Date('2026-10-16T12:00:00.000Z');
const TODAY = '2026-10-16';
const YESTERDAY = '2026-10-15';

/** `TODAY` moved by `days`. */
const day = (days: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

type ExecOptions = { env?: Record<string, string | undefined> };

interface Caller {
  id: string | null;
  name: string;
  keyId: string;
}

interface Call {
  at: string;
  model?: string;
  prompt?: number;
  promptEstimated?: boolean;
  completion?: number;
  completionEstimated?: boolean;
  outcome?: AiUsageOutcome;
}

const figures = (
  prompt: [number, number],
  completion: [number, number],
  calls: Partial<
    Record<'ok' | 'runtimeError' | 'clientAborted' | 'refused', number>
  > = {},
) => ({
  promptTokens: { reported: prompt[0], estimated: prompt[1] },
  completionTokens: { reported: completion[0], estimated: completion[1] },
  calls: { ok: 0, runtimeError: 0, clientAborted: 0, refused: 0, ...calls },
});
const NONE = figures([0, 0], [0, 0]);

describe('Token spend (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let now = NOW;

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
        { provide: TOKEN_SPEND_CLOCK, useValue: () => now },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  let ownerCookie: string;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;

  beforeEach(async () => {
    await ctx.resetDb();
    now = NOW;
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
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', ownerCookie)
      .send({ name: 'support' });
    projectId = (project.body as { projectId: string }).projectId;
    const created = await request(httpServer)
      .post('/environments')
      .set('Cookie', ownerCookie)
      .send({ name: 'production', projectId });
    expect(created.status).toBe(201);
    environmentId = (created.body as { environmentId: string }).environmentId;
  });

  async function createAiModel(appName = 'llm'): Promise<string> {
    const res = await request(httpServer)
      .post('/applications')
      .set('Cookie', ownerCookie)
      .send({
        environmentId,
        name: appName,
        appName,
        aiModel: { runtime: 'ollama', model: MODEL },
      });
    expect(res.status).toBe(201);
    return (res.body as { applicationId: string }).applicationId;
  }

  async function createAgent(
    name: string,
    applicationId: string,
  ): Promise<Caller> {
    const res = await request(httpServer)
      .post('/agents')
      .set('Cookie', ownerCookie)
      .send({
        name,
        role: 'agentCaller',
        grant: { accessedServices: [applicationId] },
      });
    expect(res.status).toBe(201);
    const { agent } = res.body as { agent: { id: string } };
    return { id: agent.id, name, keyId: `key-of-${name}` };
  }

  /** Usage rows as the Gateway writes them, one per call. */
  async function record(
    applicationId: string,
    caller: Caller,
    calls: Call[],
  ): Promise<void> {
    await ctx.db.insert(aiUsage).values(
      calls.map((call) => ({
        applicationId,
        agentUserId: caller.id,
        agentName: caller.name,
        agentId: caller.id ?? `agent-${caller.name}`,
        apikeyId: caller.keyId,
        model: call.model ?? MODEL,
        endpoint: '/v1/chat/completions',
        streamed: false,
        promptTokens: call.prompt ?? 0,
        promptTokensEstimated: call.promptEstimated ?? false,
        completionTokens: call.completion ?? 0,
        completionTokensEstimated: call.completionEstimated ?? false,
        startedAt: call.at,
        endedAt: call.at,
        outcome: call.outcome ?? 'ok',
      })),
    );
  }

  const spend = (
    cookie: string,
    applicationId: string,
    query: Record<string, string> = {},
  ) =>
    request(httpServer)
      .get(`/applications/${applicationId}/token-spend`)
      .query(query)
      .set('Cookie', cookie);

  const job = () => ctx.app.get(TokenSpendRetentionService);
  const rawDays = async () =>
    (await ctx.db.select({ at: aiUsage.startedAt }).from(aiUsage))
      .map((row) => row.at.slice(0, 10))
      .sort();
  const rollups = () => ctx.db.select().from(aiUsageDaily);

  describe('the nightly job', () => {
    it(`prunes raw rows older than ${USAGE_RAW_RETENTION_DAYS} days, and the read still answers their days from the rollups`, async () => {
      const applicationId = await createAiModel();
      const bot = await createAgent('support-bot', applicationId);
      await record(applicationId, bot, [
        { at: `${day(-120)}T08:00:00.000Z`, prompt: 100, completion: 10 },
        { at: `${day(-91)}T23:59:59.000Z`, prompt: 50, completion: 5 },
        { at: `${day(-90)}T00:00:00.000Z`, prompt: 20, completion: 2 },
        { at: `${YESTERDAY}T10:00:00.000Z`, prompt: 7, completion: 3 },
        { at: `${TODAY}T09:00:00.000Z`, prompt: 1, completion: 1 },
      ]);
      const before = await spend(ownerCookie, applicationId, {
        from: day(-120),
      });

      await job().run(NOW);

      expect(await rawDays()).toEqual([day(-90), YESTERDAY, TODAY]);
      const after = await spend(ownerCookie, applicationId, {
        from: day(-120),
      });
      expect(after.status).toBe(200);
      expect(after.body).toEqual(before.body);
      const body = after.body as {
        total: unknown;
        days: { day: string }[];
      };
      expect(body.total).toEqual(figures([178, 0], [21, 0], { ok: 5 }));
      expect(body.days).toHaveLength(121);
      expect(body.days.find((entry) => entry.day === day(-120))).toEqual({
        day: day(-120),
        ...figures([100, 0], [10, 0], { ok: 1 }),
      });
    });

    it('never prunes a rollup, however old, and running it again changes nothing', async () => {
      const applicationId = await createAiModel();
      const bot = await createAgent('support-bot', applicationId);
      await record(applicationId, bot, [
        { at: `${day(-100)}T08:00:00.000Z`, prompt: 100, completion: 10 },
      ]);
      await job().run(NOW);
      const kept = await rollups();

      now = new Date('2031-01-01T12:00:00.000Z');
      await job().run(now);
      await job().run(now);

      expect(await rollups()).toEqual(kept);
      expect(await rawDays()).toEqual([]);
    });

    it('reads a call that settled after its day was rolled up before the next night', async () => {
      const applicationId = await createAiModel();
      const bot = await createAgent('support-bot', applicationId);
      await record(applicationId, bot, [
        { at: `${YESTERDAY}T10:00:00.000Z`, prompt: 7, completion: 3 },
      ]);
      await job().run(NOW);
      await record(applicationId, bot, [
        { at: `${YESTERDAY}T23:50:00.000Z`, prompt: 5, completion: 4 },
      ]);

      const res = await spend(ownerCookie, applicationId, {
        from: YESTERDAY,
        to: YESTERDAY,
      });
      expect((res.body as { total: unknown }).total).toEqual(
        figures([12, 0], [7, 0], { ok: 2 }),
      );
    });

    it('counts a call that settled after its day was rolled up, once', async () => {
      const applicationId = await createAiModel();
      const bot = await createAgent('support-bot', applicationId);
      await record(applicationId, bot, [
        { at: `${YESTERDAY}T10:00:00.000Z`, prompt: 7, completion: 3 },
      ]);
      await job().run(NOW);
      // A long stream that started yesterday, written when it settled today.
      await record(applicationId, bot, [
        { at: `${YESTERDAY}T23:50:00.000Z`, prompt: 5, completion: 4 },
      ]);

      await job().run(new Date(`${TODAY}T23:00:00.000Z`));
      await job().run(new Date(`${TODAY}T23:30:00.000Z`));

      const res = await spend(ownerCookie, applicationId, {
        from: YESTERDAY,
        to: YESTERDAY,
      });
      expect((res.body as { total: unknown }).total).toEqual(
        figures([12, 0], [7, 0], { ok: 2 }),
      );
    });

    it("keeps a removed Agent's spend under its name", async () => {
      const applicationId = await createAiModel();
      const bot = await createAgent('support-bot', applicationId);
      await record(applicationId, bot, [
        { at: `${day(-100)}T08:00:00.000Z`, prompt: 100, completion: 10 },
        { at: `${TODAY}T08:00:00.000Z`, prompt: 1, completion: 1 },
      ]);
      await job().run(NOW);

      const removed = await request(httpServer)
        .delete(`/agents/${bot.id}`)
        .set('Cookie', ownerCookie);
      expect(removed.status).toBe(200);
      await job().run(NOW);

      const res = await spend(ownerCookie, applicationId, { from: day(-100) });
      expect((res.body as { breakdown: unknown }).breakdown).toEqual([
        {
          agentId: bot.id,
          agentUserId: null,
          agentName: 'support-bot',
          model: MODEL,
          ...figures([101, 0], [11, 0], { ok: 2 }),
        },
      ]);
    });

    it('keeps two removed Agents that shared a name as two lines', async () => {
      const applicationId = await createAiModel();
      const first = await createAgent('support-bot', applicationId);
      const second = await createAgent('support-bot', applicationId);
      await record(applicationId, first, [
        { at: `${day(-100)}T08:00:00.000Z`, prompt: 100, completion: 10 },
      ]);
      await record(applicationId, { ...second, keyId: 'key-of-second' }, [
        { at: `${day(-100)}T09:00:00.000Z`, prompt: 5, completion: 1 },
      ]);
      await job().run(NOW);
      for (const bot of [first, second]) {
        const removed = await request(httpServer)
          .delete(`/agents/${bot.id}`)
          .set('Cookie', ownerCookie);
        expect(removed.status).toBe(200);
      }
      await job().run(NOW);

      const res = await spend(ownerCookie, applicationId, { from: day(-100) });
      const breakdown = (res.body as { breakdown: { agentId: string }[] })
        .breakdown;
      expect(breakdown.map((line) => line.agentId).sort()).toEqual(
        [first.id, second.id].sort(),
      );
    });

    async function rolledUpModel(): Promise<string> {
      const applicationId = await createAiModel();
      const bot = await createAgent('support-bot', applicationId);
      await record(applicationId, bot, [
        { at: `${day(-100)}T08:00:00.000Z`, prompt: 100, completion: 10 },
      ]);
      await job().run(NOW);
      expect(await rollups()).toHaveLength(1);
      return applicationId;
    }

    it('leaves the rollups to go with the AI model', async () => {
      const applicationId = await rolledUpModel();

      const deleted = await request(httpServer)
        .delete(`/applications/${applicationId}`)
        .set('Cookie', ownerCookie);

      expect(deleted.status).toBe(200);
      expect(await rollups()).toEqual([]);
    });

    it("leaves the rollups to go with the AI model's Environment", async () => {
      await rolledUpModel();

      const deleted = await request(httpServer)
        .delete(`/environments/${environmentId}`)
        .set('Cookie', ownerCookie);

      expect(deleted.status).toBe(200);
      expect(await rollups()).toEqual([]);
    });

    it("leaves the rollups to go with the AI model's Project", async () => {
      await rolledUpModel();

      const deleted = await request(httpServer)
        .delete(`/projects/${projectId}`)
        .set('Cookie', ownerCookie);

      expect(deleted.status).toBe(200);
      expect(await rollups()).toEqual([]);
    });
  });

  describe('GET /applications/:id/token-spend', () => {
    it("answers each day of from..to, today's raw rows included, split reported and estimated, and by Agent × model with calls per outcome", async () => {
      const applicationId = await createAiModel();
      const bot = await createAgent('support-bot', applicationId);
      const ci = await createAgent('ci-runner', applicationId);
      await record(applicationId, bot, [
        { at: `${day(-3)}T08:00:00.000Z`, prompt: 999, completion: 999 },
        { at: `${day(-2)}T08:00:00.000Z`, prompt: 10, completion: 4 },
        {
          at: `${day(-2)}T09:00:00.000Z`,
          prompt: 6,
          completion: 30,
          completionEstimated: true,
          outcome: 'client-aborted',
        },
        { at: `${day(-2)}T10:00:00.000Z`, outcome: 'refused' },
        { at: `${TODAY}T08:00:00.000Z`, prompt: 3, completion: 2 },
      ]);
      await record(applicationId, ci, [
        {
          at: `${day(-2)}T11:00:00.000Z`,
          model: 'llama3.2:1b',
          prompt: 40,
          promptEstimated: true,
          completion: 0,
          outcome: 'runtime-error',
        },
        { at: `${TODAY}T07:00:00.000Z`, prompt: 5, completion: 5 },
      ]);
      await job().run(NOW);
      // Today, after the night's run: only the raw rows know about it.
      await record(applicationId, ci, [
        { at: `${TODAY}T11:00:00.000Z`, prompt: 1, completion: 1 },
      ]);

      const res = await spend(ownerCookie, applicationId, {
        from: day(-2),
        to: TODAY,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        from: day(-2),
        to: TODAY,
        total: figures([25, 40], [12, 30], {
          ok: 4,
          clientAborted: 1,
          refused: 1,
          runtimeError: 1,
        }),
        days: [
          {
            day: day(-2),
            ...figures([16, 40], [4, 30], {
              ok: 1,
              clientAborted: 1,
              refused: 1,
              runtimeError: 1,
            }),
          },
          { day: day(-1), ...NONE },
          { day: TODAY, ...figures([9, 0], [8, 0], { ok: 3 }) },
        ],
        breakdown: [
          {
            agentId: ci.id,
            agentUserId: ci.id,
            agentName: 'ci-runner',
            model: 'llama3.2:1b',
            ...figures([0, 40], [0, 0], { runtimeError: 1 }),
          },
          {
            agentId: ci.id,
            agentUserId: ci.id,
            agentName: 'ci-runner',
            model: MODEL,
            ...figures([6, 0], [6, 0], { ok: 2 }),
          },
          {
            agentId: bot.id,
            agentUserId: bot.id,
            agentName: 'support-bot',
            model: MODEL,
            ...figures([19, 0], [6, 30], {
              ok: 2,
              clientAborted: 1,
              refused: 1,
            }),
          },
        ],
      });
    });

    it('reads a day the job has not reached yet from its raw rows', async () => {
      const applicationId = await createAiModel();
      const bot = await createAgent('support-bot', applicationId);
      await record(applicationId, bot, [
        { at: `${YESTERDAY}T10:00:00.000Z`, prompt: 7, completion: 3 },
      ]);

      const res = await spend(ownerCookie, applicationId, {
        from: YESTERDAY,
        to: YESTERDAY,
      });

      expect(res.body).toEqual({
        from: YESTERDAY,
        to: YESTERDAY,
        total: figures([7, 0], [3, 0], { ok: 1 }),
        days: [{ day: YESTERDAY, ...figures([7, 0], [3, 0], { ok: 1 }) }],
        breakdown: [
          {
            agentId: bot.id,
            agentUserId: bot.id,
            agentName: 'support-bot',
            model: MODEL,
            ...figures([7, 0], [3, 0], { ok: 1 }),
          },
        ],
      });
    });

    it('defaults to the days from the AI model’s creation through today', async () => {
      const applicationId = await createAiModel();

      const res = await spend(ownerCookie, applicationId);

      expect(res.status).toBe(200);
      const created = new Date().toISOString().slice(0, 10);
      const from = created < TODAY ? created : TODAY;
      expect(res.body).toMatchObject({ from, to: TODAY, total: NONE });
    });

    it('refuses a window that ends before it starts, or a day that is not one', async () => {
      const applicationId = await createAiModel();

      const backwards = await spend(ownerCookie, applicationId, {
        from: TODAY,
        to: YESTERDAY,
      });
      const notADay = await spend(ownerCookie, applicationId, {
        from: '2026-02-30',
      });

      expect(backwards.status).toBe(400);
      expect((backwards.body as { message: string }).message).toBe(
        'From must not be after to',
      );
      expect(notADay.status).toBe(400);
    });

    it('answers 404 for a plain Application', async () => {
      const plain = await request(httpServer)
        .post('/applications')
        .set('Cookie', ownerCookie)
        .send({ environmentId, name: 'web', appName: 'web' });
      const { applicationId } = plain.body as { applicationId: string };

      const res = await spend(ownerCookie, applicationId);

      expect(res.status).toBe(404);
    });

    it('answers a member whose only grant is read access to the AI model', async () => {
      const applicationId = await createAiModel();
      const plain = await signUpMember(httpServer, ownerCookie);
      await ctx.db
        .update(member)
        .set({ accessedServices: [applicationId] })
        .where(
          and(
            eq(member.userId, plain.id),
            eq(member.organizationId, organizationId),
          ),
        );

      const res = await spend(plain.cookie, applicationId);

      expect(res.status).toBe(200);
    });

    it('refuses a member without access to the AI model, and another organization', async () => {
      const applicationId = await createAiModel();
      const plain = await signUpMember(httpServer, ownerCookie);
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        ownerCookie,
      );

      expect((await spend(plain.cookie, applicationId)).status).toBe(403);
      expect((await spend(mallory.cookie, applicationId)).status).toBe(404);
    });
  });
});
