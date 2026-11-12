import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  application,
  licenseKey,
  member,
  organizationRole,
  server as serverTable,
} from '../../src/db/schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import {
  nvidiaRuntimeAnswer,
  RUNTIME_TOML,
} from '../settings/gpu-runtime.fixture';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ok = (stdout: string): ExecResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
});

const refusal = (res: { body: unknown }): string =>
  (res.body as { message: string }).message;

const card = (id: string) =>
  `{"NamedResourceSpec":{"Kind":"GPU","Value":"${id}"}}`;

/** What `docker node inspect self` answers for each way a machine is set up. */
const ADVERTISED = {
  byCardId: (...ids: string[]) => `[${ids.map(card).join(',')}]`,
  byCount: (n: number) =>
    `[{"DiscreteResourceSpec":{"Kind":"GPU","Value":${n}}}]`,
  notSetUp: 'null',
};

/**
 * How a machine's NVIDIA runtime is configured: as GPU setup leaves it
 * now, as it left it before the fix, or with a `config.toml` that cannot be read.
 */
const RUNTIMES = { ...RUNTIME_TOML, unreadable: null };
type RuntimeToml = keyof typeof RUNTIMES;

/**
 * A GPU reservation on an Application: the counts-only read of a
 * machine's cards, who may read it, and the save that refuses a reservation
 * the run Server could never hold.
 *
 * The machine is the `RemoteExecService` double: each Server answers
 * `docker node inspect self` with what it advertises and the running-task
 * read with what its tasks were assigned, from `machines` below.
 */
describe('GPU reservation on an Application (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  /**
   * Per Server id: what it advertises, its running tasks' lines, and how its
   * NVIDIA runtime is configured.
   */
  const machines = new Map<
    string,
    {
      advertised: string;
      tasks: string[];
      runtime: RuntimeToml;
      /** The Swarm service ID every Application on it runs as. */
      serviceId?: string;
    }
  >();

  const remoteExec = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn((serverId: string, command: string) => {
      const machine = machines.get(serverId);
      if (!machine) return Promise.resolve(ok(''));
      if (command.startsWith('docker node inspect self')) {
        return Promise.resolve(ok(`${machine.advertised}\n`));
      }
      if (command.startsWith('docker node ps self')) {
        return Promise.resolve(ok(machine.tasks.join('\n')));
      }
      const runtime = nvidiaRuntimeAnswer(command, RUNTIMES[machine.runtime]);
      if (runtime) return runtime;
      if (command.startsWith('docker service inspect')) {
        return Promise.resolve(ok(`${machine.serviceId ?? ''}\n`));
      }
      return Promise.resolve(ok(''));
    }),
  });

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: remoteExec }],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    machines.clear();
    remoteExec.execAsync.mockClear();
    remoteExec.execAsyncRemote.mockClear();
  });

  async function signUpOwner() {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'];
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(httpServer)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'models' });
    expect(project.status).toBe(201);
    const projectId = (project.body as { projectId: string }).projectId;
    const env = await request(httpServer)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name: 'production', projectId });
    expect(env.status).toBe(201);
    const environmentId = (env.body as { environmentId: string }).environmentId;
    return { cookie, organizationId, projectId, environmentId };
  }

  async function gpuServer(
    organizationId: string,
    name: string,
    advertised: string,
    tasks: string[] = [],
    runtime: RuntimeToml = 'configured',
  ): Promise<string> {
    const [row] = await ctx.db
      .insert(serverTable)
      .values({ name, ipAddress: '10.0.0.7', port: 22, organizationId })
      .returning();
    machines.set(row.serverId, { advertised, tasks, runtime });
    return row.serverId;
  }

  const counts = (cookie: string, serverId: string) =>
    request(httpServer)
      .get('/settings/gpu/counts')
      .query({ serverId })
      .set('Cookie', cookie);

  async function createApplication(
    cookie: string,
    body: { environmentId: string; serverId: string; gpus?: number },
  ) {
    return request(httpServer)
      .post('/applications')
      .set('Cookie', cookie)
      .send({ name: 'Llama', ...body });
  }

  const gpusOf = async (applicationId: string) =>
    (
      await ctx.db
        .select({ gpus: application.gpus })
        .from(application)
        .where(eq(application.applicationId, applicationId))
    )[0].gpus;

  describe('the counts-only read', () => {
    it("answers a Server's cards advertised by ID and the ones no running task holds", async () => {
      const { cookie, organizationId } = await signUpOwner();
      const serverId = await gpuServer(
        organizationId,
        'gpu-1',
        ADVERTISED.byCardId('GPU-a', 'GPU-b', 'GPU-c'),
        [`svc-llama ${'[' + card('GPU-a') + ']'}`, 'svc-web null'],
      );

      const res = await counts(cookie, serverId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ gpuSetup: 'card-id', cards: 3, free: 2 });
      // The Server's own machine, and nothing on the platform host.
      const asked = remoteExec.execAsyncRemote.mock.calls.map(
        ([on, command]) => [on, command.split(' ').slice(0, 3).join(' ')],
      );
      expect(asked).toEqual([
        [serverId, 'docker node inspect'],
        [serverId, 'docker node ps'],
      ]);
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('answers no cards for a Server not set up or set up the old way, saying which', async () => {
      const { cookie, organizationId } = await signUpOwner();
      const notSetUp = await gpuServer(
        organizationId,
        'cpu-1',
        ADVERTISED.notSetUp,
      );
      const oldWay = await gpuServer(
        organizationId,
        'gpu-old',
        ADVERTISED.byCount(2),
      );

      expect((await counts(cookie, notSetUp)).body).toEqual({
        gpuSetup: 'none',
        cards: 0,
        free: 0,
      });
      expect((await counts(cookie, oldWay)).body).toEqual({
        gpuSetup: 'count',
        cards: 0,
        free: 0,
      });
    });

    it('lets a Member who may create a Service read the counts, and still refuses them the driver/CUDA check', async () => {
      const { cookie, organizationId, projectId } = await signUpOwner();
      const serverId = await gpuServer(
        organizationId,
        'gpu-1',
        ADVERTISED.byCardId('GPU-a', 'GPU-b'),
      );
      const deployer = await signUpMember(httpServer, cookie, {
        email: 'deployer@example.com',
      });
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'deployer',
        permission: { service: ['create', 'read', 'update'] },
      });
      await ctx.db
        .update(member)
        .set({ role: 'deployer', accessedProjects: [projectId] })
        .where(
          and(
            eq(member.userId, deployer.id),
            eq(member.organizationId, organizationId),
          ),
        );

      const read = await counts(deployer.cookie, serverId);
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ gpuSetup: 'card-id', cards: 2, free: 2 });

      const check = await request(httpServer)
        .get('/settings/gpu')
        .query({ serverId })
        .set('Cookie', deployer.cookie);
      expect([check.status, refusal(check)]).toEqual([
        403,
        'Only owners and admins can manage web server settings',
      ]);
    });

    it('refuses a base member, who may not create a Service, and another organization', async () => {
      const { cookie, organizationId } = await signUpOwner();
      const serverId = await gpuServer(
        organizationId,
        'gpu-1',
        ADVERTISED.byCardId('GPU-a'),
      );
      const plain = await signUpMember(httpServer, cookie);
      const mallory = await secondOrganizationOwner(httpServer, ctx.db, cookie);

      expect((await counts(plain.cookie, serverId)).status).toBe(403);
      const foreign = await counts(mallory.cookie, serverId);
      expect([foreign.status, refusal(foreign)]).toEqual([
        404,
        'Server not found',
      ]);
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    });
  });

  describe('saving gpus', () => {
    it('saves a reservation up to the run Server’s card count, even with none free', async () => {
      const { cookie, organizationId, environmentId } = await signUpOwner();
      const serverId = await gpuServer(
        organizationId,
        'gpu-1',
        ADVERTISED.byCardId('GPU-a', 'GPU-b'),
        [`svc-other [${card('GPU-a')},${card('GPU-b')}]`],
      );
      const created = await createApplication(cookie, {
        environmentId,
        serverId,
      });
      expect(created.status).toBe(201);
      const { applicationId, gpus } = created.body as {
        applicationId: string;
        gpus: number;
      };
      expect(gpus).toBe(0);

      const saved = await request(httpServer)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({ gpus: 2 });

      expect(saved.status).toBe(200);
      expect(await gpusOf(applicationId)).toBe(2);
      const read = await request(httpServer)
        .get(`/applications/${applicationId}`)
        .set('Cookie', cookie);
      expect((read.body as { gpus: number }).gpus).toBe(2);
    });

    it('refuses more GPUs per copy than the run Server has, writing nothing', async () => {
      const { cookie, organizationId, environmentId } = await signUpOwner();
      const serverId = await gpuServer(
        organizationId,
        'gpu-1',
        ADVERTISED.byCardId('GPU-a', 'GPU-b'),
      );
      const created = await createApplication(cookie, {
        environmentId,
        serverId,
      });
      const { applicationId } = created.body as { applicationId: string };

      const saved = await request(httpServer)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({ gpus: 3, replicas: 4 });

      expect([saved.status, refusal(saved)]).toEqual([
        400,
        'gpu-1 has 2 GPUs, so it cannot hold 3 per copy',
      ]);
      const [row] = await ctx.db
        .select({ gpus: application.gpus, replicas: application.replicas })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(row).toEqual({ gpus: 0, replicas: 1 });
    });

    it('refuses any GPU on a Server not set up, or set up the old way', async () => {
      const { cookie, organizationId, environmentId } = await signUpOwner();
      const answers: [number, string][] = [];
      for (const [name, advertised] of [
        ['cpu-1', ADVERTISED.notSetUp],
        ['gpu-old', ADVERTISED.byCount(2)],
      ]) {
        const serverId = await gpuServer(organizationId, name, advertised);
        const created = await createApplication(cookie, {
          environmentId,
          serverId,
        });
        const { applicationId } = created.body as { applicationId: string };
        const saved = await request(httpServer)
          .patch(`/applications/${applicationId}`)
          .set('Cookie', cookie)
          .send({ gpus: 1 });
        answers.push([saved.status, refusal(saved)]);
        expect(await gpusOf(applicationId)).toBe(0);
      }

      expect(answers).toEqual([
        [400, 'cpu-1 is not set up for GPUs; run GPU setup on it first'],
        [
          400,
          'gpu-old was set up for GPUs the old way, which cannot reserve a card; run GPU setup on it again',
        ],
      ]);
    });

    it('refuses any GPU on a Server whose cards are advertised by ID but whose runtime cannot hand one over', async () => {
      const { cookie, organizationId, environmentId } = await signUpOwner();
      // Set up before the fix, and one whose config.toml cannot be read: both
      // refused, since a task on either may never get its card (ADR-0039).
      const answers: [number, string][] = [];
      for (const [name, runtime] of [
        ['gpu-981', 'theOldWay'],
        ['gpu-unread', 'unreadable'],
      ] as const) {
        const serverId = await gpuServer(
          organizationId,
          name,
          ADVERTISED.byCardId('GPU-a', 'GPU-b'),
          [],
          runtime,
        );
        const created = await createApplication(cookie, {
          environmentId,
          serverId,
        });
        const { applicationId } = created.body as { applicationId: string };
        const saved = await request(httpServer)
          .patch(`/applications/${applicationId}`)
          .set('Cookie', cookie)
          .send({ gpus: 1 });
        answers.push([saved.status, refusal(saved)]);
        expect(await gpusOf(applicationId)).toBe(0);

        const atCreate = await createApplication(cookie, {
          environmentId,
          serverId,
          gpus: 1,
        });
        answers.push([atCreate.status, refusal(atCreate)]);
      }

      const pointer = (name: string) =>
        `${name} is not set up to hand a reserved card to its container; run GPU setup on it again`;
      expect(answers).toEqual([
        [400, pointer('gpu-981')],
        [400, pointer('gpu-981')],
        [400, pointer('gpu-unread')],
        [400, pointer('gpu-unread')],
      ]);
      expect(await ctx.db.select().from(application)).toHaveLength(2);
    });

    it('checks a reservation made at create against the run Server chosen there', async () => {
      const { cookie, organizationId, environmentId } = await signUpOwner();
      const twoCards = await gpuServer(
        organizationId,
        'gpu-2',
        ADVERTISED.byCardId('GPU-a', 'GPU-b'),
      );
      const oneCard = await gpuServer(
        organizationId,
        'gpu-1',
        ADVERTISED.byCardId('GPU-c'),
      );

      const held = await createApplication(cookie, {
        environmentId,
        serverId: twoCards,
        gpus: 2,
      });
      expect(held.status).toBe(201);
      expect(
        await gpusOf((held.body as { applicationId: string }).applicationId),
      ).toBe(2);

      const refused = await createApplication(cookie, {
        environmentId,
        serverId: oneCard,
        gpus: 2,
      });
      expect([refused.status, refusal(refused)]).toEqual([
        400,
        'gpu-1 has 1 GPU, so it cannot hold 2 per copy',
      ]);
      expect(await ctx.db.select().from(application)).toHaveLength(1);
    });

    it('saves other settings without reading the machine when no GPU is asked for', async () => {
      const { cookie, organizationId, environmentId } = await signUpOwner();
      const serverId = await gpuServer(
        organizationId,
        'cpu-1',
        ADVERTISED.notSetUp,
      );
      const created = await createApplication(cookie, {
        environmentId,
        serverId,
      });
      const { applicationId } = created.body as { applicationId: string };
      remoteExec.execAsyncRemote.mockClear();

      const saved = await request(httpServer)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', cookie)
        .send({ gpus: 0, replicas: 2 });

      expect(saved.status).toBe(200);
      expect(
        remoteExec.execAsyncRemote.mock.calls.filter(([, command]) =>
          command.startsWith('docker node'),
        ),
      ).toEqual([]);
    });
  });

  /**
   * From the GPU change's review: Start and Restart start a new task off the reservation
   * already saved, so they are admitted as a deploy is (ADR-0039) — the
   * machine as it is now, its own task's card counted as free — and refused
   * with a 409 before anything is scaled.
   */
  describe('starting and restarting', () => {
    /** A GPU Application on `serverId`, saved while its runtime was configured. */
    async function gpuApplication(
      cookie: string,
      environmentId: string,
      serverId: string,
    ) {
      const created = await createApplication(cookie, {
        environmentId,
        serverId,
        gpus: 1,
      });
      expect(created.status).toBe(201);
      return (created.body as { applicationId: string }).applicationId;
    }

    const lifecycle = (cookie: string, applicationId: string, verb: string) =>
      request(httpServer)
        .post(`/applications/${applicationId}/${verb}`)
        .set('Cookie', cookie);

    const scales = () =>
      remoteExec.execAsyncRemote.mock.calls
        .map(([, command]) => command)
        .filter((command) => command.startsWith('docker service scale'));

    it('refuses to start or restart on a Server set up again the old way since the save, scaling nothing', async () => {
      const { cookie, organizationId, environmentId } = await signUpOwner();
      const serverId = await gpuServer(
        organizationId,
        'gpu-1',
        ADVERTISED.byCardId('GPU-a'),
      );
      const applicationId = await gpuApplication(
        cookie,
        environmentId,
        serverId,
      );
      machines.get(serverId)!.runtime = 'theOldWay';

      const answers: [number, string][] = [];
      for (const verb of ['start', 'reload']) {
        const res = await lifecycle(cookie, applicationId, verb);
        answers.push([res.status, refusal(res)]);
      }

      const pointer =
        'gpu-1 is not set up to hand a reserved card to its container; run GPU setup on it again';
      expect(answers).toEqual([
        [409, pointer],
        [409, pointer],
      ]);
      expect(scales()).toEqual([]);
    });

    it('refuses to start when another Service took the card while it was stopped, scaling nothing', async () => {
      const { cookie, organizationId, environmentId } = await signUpOwner();
      const serverId = await gpuServer(
        organizationId,
        'gpu-1',
        ADVERTISED.byCardId('GPU-a'),
      );
      const applicationId = await gpuApplication(
        cookie,
        environmentId,
        serverId,
      );
      const machine = machines.get(serverId)!;
      machine.serviceId = 'svc-own';
      machine.tasks = [`svc-other [${card('GPU-a')}]`];

      const res = await lifecycle(cookie, applicationId, 'start');

      expect([res.status, refusal(res)]).toEqual([
        409,
        '1 GPU needed, 0 of 1 free on gpu-1',
      ]);
      expect(scales()).toEqual([]);
    });

    it('starts and restarts a Service whose own running task holds the card', async () => {
      const { cookie, organizationId, environmentId } = await signUpOwner();
      const serverId = await gpuServer(
        organizationId,
        'gpu-1',
        ADVERTISED.byCardId('GPU-a'),
      );
      const applicationId = await gpuApplication(
        cookie,
        environmentId,
        serverId,
      );
      const machine = machines.get(serverId)!;
      machine.serviceId = 'svc-own';
      machine.tasks = [`svc-own [${card('GPU-a')}]`];

      const started = await lifecycle(cookie, applicationId, 'start');
      const restarted = await lifecycle(cookie, applicationId, 'reload');

      expect([started.status, restarted.status]).toEqual([200, 200]);
      expect(scales().map((command) => command.slice(-2))).toEqual([
        '=1',
        '=0',
        '=1',
      ]);
    });
  });
});
