import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  application,
  deployment,
  member,
  server as serverTable,
} from '../../src/db/schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { nvidiaRuntimeAnswer } from '../settings/gpu-runtime.fixture';
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

const card = (id: string) =>
  `{"NamedResourceSpec":{"Kind":"GPU","Value":"${id}"}}`;

/** One `docker service ps --format '{{json .}}'` line. */
const task = (currentState: string, error = '') =>
  JSON.stringify({
    ID: 'x1y2z3',
    Name: 'llama.1',
    Image: 'vllm/vllm-openai:latest',
    Node: '',
    DesiredState: 'Running',
    CurrentState: currentState,
    Error: error,
    Ports: '',
  });

const STARVED = task(
  'Pending 3 minutes ago',
  'no suitable node (insufficient resources on 1 node)',
);
const RUNNING = task('Running 2 hours ago');

/**
 * "Waiting for a GPU" on an Application's Overview: an Application
 * reserving GPUs whose live task Swarm cannot place — after a reboot, or a
 * lost card, outside any deploy — says so, with the run Server's free and
 * total cards.
 *
 * The machine is the `RemoteExecService` double: `docker service ps` answers
 * the Application's tasks, and the node inspect and running-task reads the
 * counts.
 */
describe('Waiting for a GPU (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  /** Per Server id: what it advertises, its running tasks, and the app's tasks. */
  const machines = new Map<
    string,
    { advertised: string; held: string[]; serviceTasks: string[] }
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
        return Promise.resolve(ok(machine.held.join('\n')));
      }
      if (command.startsWith('docker service ps')) {
        return Promise.resolve(ok(machine.serviceTasks.join('\n')));
      }
      // The NVIDIA runtime set up to hand a task its card, so the save of a
      // reservation is admitted.
      const runtime = nvidiaRuntimeAnswer(command);
      if (runtime) return runtime;
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
    const projectId = (project.body as { projectId: string }).projectId;
    const env = await request(httpServer)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name: 'production', projectId });
    const environmentId = (env.body as { environmentId: string }).environmentId;
    return { cookie, organizationId, environmentId };
  }

  /**
   * A Server with three cards, one held by another Service, running an
   * Application that reserves `gpus` whose tasks read `serviceTasks`.
   */
  async function applicationOn(
    gpus: number,
    serviceTasks: string[],
  ): Promise<{
    cookie: string;
    organizationId: string;
    applicationId: string;
    serverId: string;
  }> {
    const { cookie, organizationId, environmentId } = await signUpOwner();
    const [row] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'gpu-1',
        ipAddress: '10.0.0.7',
        port: 22,
        organizationId,
      })
      .returning();
    machines.set(row.serverId, {
      advertised: `[${card('GPU-a')},${card('GPU-b')},${card('GPU-c')}]`,
      held: [`svc-other [${card('GPU-a')}]`, 'svc-web null'],
      serviceTasks,
    });
    const created = await request(httpServer)
      .post('/applications')
      .set('Cookie', cookie)
      .send({ name: 'Llama', environmentId, serverId: row.serverId, gpus });
    expect(created.status).toBe(201);
    return {
      cookie,
      organizationId,
      applicationId: (created.body as { applicationId: string }).applicationId,
      serverId: row.serverId,
    };
  }

  const gpuWait = (cookie: string, applicationId: string) =>
    request(httpServer)
      .get(`/applications/${applicationId}/gpu-wait`)
      .set('Cookie', cookie);

  it('says an Application reserving a GPU whose task no node can take is waiting, with its Server’s free and total cards', async () => {
    const { cookie, applicationId, serverId } = await applicationOn(1, [
      STARVED,
    ]);

    const res = await gpuWait(cookie, applicationId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ waiting: true, free: 2, cards: 3 });
    // The Application's own tasks on its own Server, by its Swarm name.
    const { appName } = (
      await ctx.db
        .select({ appName: application.appName })
        .from(application)
        .where(eq(application.applicationId, applicationId))
    )[0];
    const asked = remoteExec.execAsyncRemote.mock.calls.filter(([, command]) =>
      command.startsWith('docker service ps'),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0][0]).toBe(serverId);
    expect(asked[0][1]).toContain(appName);
  });

  it('says nothing for an Application running normally', async () => {
    const { cookie, applicationId } = await applicationOn(1, [RUNNING]);

    const res = await gpuWait(cookie, applicationId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ waiting: false });
  });

  it('says nothing for a task pending for another reason', async () => {
    const { cookie, applicationId } = await applicationOn(1, [
      task('Pending 3 seconds ago'),
    ]);

    expect((await gpuWait(cookie, applicationId)).body).toEqual({
      waiting: false,
    });
  });

  it('says nothing for an Application reserving no GPU, without reading the machine', async () => {
    const { cookie, applicationId } = await applicationOn(0, [STARVED]);
    remoteExec.execAsyncRemote.mockClear();

    const res = await gpuWait(cookie, applicationId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ waiting: false });
    expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
  });

  it('says nothing when the Server cannot be read', async () => {
    const { cookie, applicationId } = await applicationOn(1, [STARVED]);
    remoteExec.execAsyncRemote.mockImplementationOnce(() =>
      Promise.reject(new Error('ssh: connect to host 10.0.0.7: timed out')),
    );

    const res = await gpuWait(cookie, applicationId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ waiting: false });
  });

  it('answers a base member with access to the Application, who holds no docker action', async () => {
    const { cookie, organizationId, applicationId } = await applicationOn(1, [
      STARVED,
    ]);
    const plain = await signUpMember(httpServer, cookie);
    await ctx.db
      .update(member)
      .set({ accessedServices: [applicationId] })
      .where(
        and(
          eq(member.userId, plain.id),
          eq(member.organizationId, organizationId),
        ),
      );

    const res = await gpuWait(plain.cookie, applicationId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ waiting: true, free: 2, cards: 3 });
  });

  it('refuses a member without access to the Application and another organization, reading nothing', async () => {
    const { cookie, applicationId } = await applicationOn(1, [STARVED]);
    const plain = await signUpMember(httpServer, cookie);
    const mallory = await secondOrganizationOwner(httpServer, ctx.db, cookie);
    remoteExec.execAsyncRemote.mockClear();

    expect((await gpuWait(plain.cookie, applicationId)).status).toBe(403);
    expect((await gpuWait(mallory.cookie, applicationId)).status).toBe(404);
    expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
  });

  it('writes nothing: no Deployment, and the Application row unchanged', async () => {
    const { cookie, applicationId } = await applicationOn(1, [STARVED]);
    const [before] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));

    await gpuWait(cookie, applicationId);

    const [after] = await ctx.db
      .select()
      .from(application)
      .where(eq(application.applicationId, applicationId));
    expect(after).toEqual(before);
    expect(await ctx.db.select().from(deployment)).toEqual([]);
  });
});
