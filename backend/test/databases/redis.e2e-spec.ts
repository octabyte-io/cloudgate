import { Logger, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DATABASE_CONVERGENCE_CLOCK } from '../../src/databases/common/database-convergence';
import { RedisService } from '../../src/databases/redis/redis.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { expectQuotedInCommand } from '../utils/shell-safety';
import { createTestApp, TestAppContext } from '../utils/test-app';
/**
 * Whether a command is the presence probe Delete issues. Matched by its
 * three-branch shell shape rather than by the question inside it, and both ends
 * are checked: a `startsWith('docker service inspect ')` discriminator was what
 * H-104 was, because H-95 moved the question behind an `if ! docker version`
 * reachability branch and this file's copy of the discriminator was not
 * updated, so it matched nothing, the probe answered `''`,
 * `readWorkloadPresence` read that as `'unknown'` and the happy-path delete
 * 409'd.
 *
 * Hand-written rather than imported from `database-ops.ts`, and now one copy
 * for the whole test tree rather than this file's own: importing the
 * product's builder would make the test agree with whatever the builder says,
 * and the shell trick this probe turns on — exit 0 either way, the answer on
 * stdout — is exactly what a "simplification" would quietly drop, while ten
 * copies of it bought nothing but nine ways to go stale. The set-level guard
 * that catches the remaining copy going stale is in
 * `test/common/workload-presence.spec.ts`.
 */
import { isPresenceProbe } from '../utils/workload-presence-probe';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/**
 * The exec layer as Delete sees it: every command succeeds and the presence
 * read says the swarm service is gone, which is the happy path. A plain
 * `mockResolvedValue({ stdout: '', … })` would leave the probe answering an
 * empty stdout — `'unknown'`, deliberately, because a shell that never ran the
 * command is no more "gone" than a rejection is — and every delete would 409.
 */
const teardownSucceeds = (command: string) =>
  Promise.resolve(
    isPresenceProbe(command)
      ? { stdout: 'absent', stderr: '' }
      : { stdout: '', stderr: '' },
  );

describe('Redis (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let redisService: RedisService;

  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });

  /** A Swarm with no existing service: inspect rejects, so a deploy
   * converges by creating the service. */
  const dockerService = {
    inspect: jest.fn(),
    update: jest.fn(),
  };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    // `docker service ps`: the deploy waits for a running task before it
    // writes `done`, and a created service has one at once here.
    listTasks: jest.fn().mockResolvedValue([{ Status: { State: 'running' } }]),
  };
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };

  /**
   * The deploy's clock: the system one unless a test makes its sleeps
   * instant, which is how a deploy outlives the request's wait in no time.
   */
  let instantSleeps = false;
  let fakeNow = 0;
  const convergenceClock = {
    now: () => (instantSleeps ? fakeNow : Date.now()),
    sleep: (ms: number) =>
      instantSleeps
        ? Promise.resolve().then(() => {
            fakeNow += ms;
          })
        : new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
        { provide: DATABASE_CONVERGENCE_CLOCK, useValue: convergenceClock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    redisService = ctx.app.get(RedisService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    // Delete verifies the swarm service is really gone before it drops the row
    // so the presence read has to answer. Everything else is unchanged.
    execMock.execAsync.mockReset().mockImplementation(teardownSucceeds);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        teardownSucceeds(command),
      );
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.getService.mockClear();
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.listTasks
      .mockReset()
      .mockResolvedValue([{ Status: { State: 'running' } }]);
    instantSleeps = false;
    dockerFactoryMock.getRemoteDocker.mockClear();
  });

  /** An owner session with a production environment to hang databases off. */
  async function setUpEnvironment() {
    const ownerSession = await signUp(server, owner);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    return {
      organizationId,
      ownerSession,
      ownerCtx,
      environmentId: environment.environmentId,
    };
  }

  /** Creates a database over HTTP as the owner and returns its row. */
  async function createDatabase(
    cookie: string,
    environmentId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const created = await request(server)
      .post('/redis')
      .set('Cookie', cookie)
      .send({
        name: 'Main Cache',
        appName: 'main-cache',
        databasePassword: 'sup3rS3cret',
        environmentId,
        ...overrides,
      });
    expect(created.status).toBe(201);
    return created.body as { redisId: string; appName: string };
  }

  describe('create', () => {
    it('creates a redis retrievable with its connection info — no database name or user', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const created = await request(server)
        .post('/redis')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main Cache',
          appName: 'main-cache',
          databasePassword: 'sup3rS3cret',
          environmentId,
        });
      expect(created.status).toBe(201);
      const { redisId } = created.body as { redisId: string };
      expect(redisId).toEqual(expect.any(String));

      const found = await request(server)
        .get(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      // Redis has no per-database identity: the password is the whole
      // connection info.
      expect(found.body).toMatchObject({
        redisId,
        name: 'Main Cache',
        appName: 'main-cache',
        databasePassword: 'sup3rS3cret',
        dockerImage: 'redis:8',
        applicationStatus: 'idle',
        externalPort: null,
        environmentId,
      });
      expect(found.body).not.toHaveProperty('databaseName');
      expect(found.body).not.toHaveProperty('databaseUser');
    });

    it('generates a password when none is supplied and stores it encrypted', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const created = await request(server)
        .post('/redis')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main Cache',
          environmentId,
        });
      expect(created.status).toBe(201);
      const { databasePassword } = created.body as {
        databasePassword: string;
      };
      expect(databasePassword).toMatch(/^[a-z0-9]{16}$/);

      // Read the raw column, bypassing the decrypting column type.
      const raw = await ctx.db.execute<{ database_password: string }>(
        sql`select database_password from redis`,
      );
      expect(raw.rows).toHaveLength(1);
      expect(raw.rows[0].database_password).not.toContain(databasePassword);
    });

    it('rejects passwords with shell-dangerous characters', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      // The password lands inside `redis-server --requirepass <password>`:
      // shell metacharacters are rejected at the door.
      const badPassword = await request(server)
        .post('/redis')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main Cache',
          databasePassword: 'un$afe pa$$word!',
          environmentId,
        });
      expect(badPassword.status).toBe(400);
    });
  });

  describe('deploy', () => {
    it('pulls the image and creates the service with a requirepass entrypoint, REDIS_PASSWORD env and data volume', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const deployed = await request(server)
        .post(`/redis/${redisId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      expect(deployed.status).toBe(200);

      // The image is pulled onto the target server before converging. The
      // `dockerImage` column is quoted on its way into `docker pull`, so
      // the assertion is a `shell-quote` parse of the word the shell would hand
      // the command rather than a substring match on the emitted string.
      const commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      const pull = commands.find((command) =>
        command.startsWith('docker pull'),
      );
      expectQuotedInCommand(pull ?? null, 'redis:8');

      expect(docker.createService).toHaveBeenCalledTimes(1);
      const [settings] = docker.createService.mock.lastCall as [
        {
          Name: string;
          TaskTemplate: {
            ContainerSpec: {
              Image: string;
              Env: string[];
              Mounts: { Type: string; Source: string; Target: string }[];
              Command?: string[];
              Args?: string[];
            };
          };
          EndpointSpec: { Mode: string; Ports: unknown[] };
        },
      ];
      expect(settings.Name).toBe('main-cache');
      expect(settings.TaskTemplate.ContainerSpec.Image).toBe('redis:8');
      expect(settings.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining([
          'REDIS_PASSWORD=sup3rS3cret',
          'CG_REDIS_REQUIREPASS=sup3rS3cret',
        ]),
      );
      // The stock image starts unauthenticated: the default entrypoint
      // enforces the password.
      //
      // **The password is a reference and not a word.** `Args`
      // and `Env` sit in the same `ContainerSpec` and `docker service inspect`
      // returns both in clear, so moving the value between them buys nothing
      // *there* — what it buys is the Server's own process table, which needs
      // no Docker socket at all: `/proc/<pid>/cmdline` is world-readable and
      // `/proc/<pid>/environ` is `0600`, and the wrapper shell this spec pins
      // is a live process for as long as the container is. Measured against
      // Docker 29.3.1 with `--pid=host`; `redis.service.ts` carries the
      // numbers.
      expect(settings.TaskTemplate.ContainerSpec.Command).toEqual(['/bin/sh']);
      expect(settings.TaskTemplate.ContainerSpec.Args).toEqual([
        '-c',
        'exec redis-server --requirepass "$CG_REDIS_REQUIREPASS"',
      ]);
      expect(settings.TaskTemplate.ContainerSpec.Args?.join(' ')).not.toContain(
        'sup3rS3cret',
      );
      expect(settings.TaskTemplate.ContainerSpec.Mounts).toEqual([
        {
          Type: 'volume',
          Source: 'main-cache-data',
          Target: '/data',
        },
      ]);
      // No external port yet: nothing published.
      expect(settings.EndpointSpec).toEqual({ Mode: 'dnsrr', Ports: [] });

      const found = await request(server)
        .get(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });
    });

    it('a user-supplied command replaces the requirepass entrypoint', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .patch(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ command: 'redis-server /etc/redis/redis.conf' });

      await request(server)
        .post(`/redis/${redisId}/deploy`)
        .set('Cookie', ownerSession.cookie);

      const [settings] = docker.createService.mock.lastCall as [
        { TaskTemplate: { ContainerSpec: { Command?: string[] } } },
      ];
      expect(settings.TaskTemplate.ContainerSpec.Command).toEqual([
        'redis-server',
        '/etc/redis/redis.conf',
      ]);
    });

    it('a failed deploy leaves the database in error status', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      execMock.execAsync.mockRejectedValue(new Error('pull failed'));

      const deployed = await request(server)
        .post(`/redis/${redisId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      // A Docker failure is a 409 naming what Docker said, not a bare 500.
      expect(deployed.status).toBe(409);
      expect((deployed.body as { message: string }).message).toContain(
        'pull failed',
      );

      const found = await request(server)
        .get(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'error' });
      expect(docker.createService).not.toHaveBeenCalled();
    });
  });

  /**
   * A deploy is `done` once Swarm runs it, not once Docker accepts the
   * spec. The double is a Swarm whose service and task list a test rewrites
   * as it goes; `update()` moves the spec version as the daemon would.
   */
  describe('a deploy Swarm does not run', () => {
    const startedAt = '2026-09-18T18:57:10Z';
    let service: {
      Version: { Index: number };
      Spec: {
        TaskTemplate: { ForceUpdate: number; ContainerSpec: { Image: string } };
      };
      UpdateStatus: { State: string; StartedAt: string };
    };
    type Task = {
      CreatedAt: string;
      DesiredState: string;
      Spec: { ForceUpdate: number };
      Status: { State: string; Err?: string; Timestamp: string };
    };
    let tasks: Task[];

    const servingTask = (forceUpdate: number): Task => ({
      CreatedAt: '2026-09-18T18:50:00Z',
      DesiredState: 'running',
      Spec: { ForceUpdate: forceUpdate },
      Status: { State: 'running', Timestamp: '2026-09-18T18:57:18Z' },
    });
    const rejectedTask = (forceUpdate: number): Task => ({
      CreatedAt: '2026-09-18T18:57:11Z',
      DesiredState: 'shutdown',
      Spec: { ForceUpdate: forceUpdate },
      Status: {
        State: 'failed',
        Err: 'task: non-zero exit (1)',
        Timestamp: '2026-09-18T18:57:12Z',
      },
    });
    /** The ticket's Redis site: `redis:7` refused the RDB file `redis:8`
     * wrote, and Swarm put `redis:8` back. */
    const rolledBack = () => {
      service.Spec.TaskTemplate.ForceUpdate = 3;
      service.Spec.TaskTemplate.ContainerSpec.Image = 'redis:8@sha256:0123abcd';
      service.UpdateStatus = {
        State: 'rollback_completed',
        StartedAt: startedAt,
      };
      tasks = [servingTask(3), rejectedTask(4)];
    };

    /** A task read that answers when the test says so. */
    const heldTaskRead = () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      docker.listTasks.mockImplementationOnce(async () => {
        await held;
        return [];
      });
      return release;
    };

    const statusOf = async (cookie: string, redisId: string) =>
      (
        (await request(server).get(`/redis/${redisId}`).set('Cookie', cookie))
          .body as { applicationStatus: string }
      ).applicationStatus;

    const eventually = async (check: () => Promise<boolean> | boolean) => {
      for (let attempt = 0; attempt < 250; attempt++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('never happened');
    };

    let warn: jest.SpyInstance;

    beforeEach(() => {
      service = {
        Version: { Index: 41 },
        Spec: {
          TaskTemplate: { ForceUpdate: 3, ContainerSpec: { Image: 'redis:8' } },
        },
        UpdateStatus: { State: 'completed', StartedAt: '2026-09-18T18:00:00Z' },
      };
      tasks = [servingTask(3)];
      dockerService.inspect
        .mockReset()
        .mockImplementation(() => Promise.resolve(structuredClone(service)));
      dockerService.update.mockImplementation(
        (spec: { TaskTemplate: { ForceUpdate: number } }) => {
          service.Spec.TaskTemplate.ForceUpdate = spec.TaskTemplate.ForceUpdate;
          service.UpdateStatus = { State: 'updating', StartedAt: startedAt };
          return Promise.resolve(undefined);
        },
      );
      docker.listTasks.mockImplementation(({ filters }: { filters: string }) =>
        Promise.resolve(
          filters.includes('desired-state')
            ? tasks.filter((task) => task.DesiredState === 'running')
            : tasks,
        ),
      );
      warn = jest.spyOn(Logger.prototype, 'warn');
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it('a new image Swarm rolls back ends error with the rejected task’s reason, not done', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .patch(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ dockerImage: 'redis:7' })
        .expect(200);
      dockerService.update.mockImplementationOnce(() => {
        rolledBack();
        return Promise.resolve(undefined);
      });

      const deployed = await request(server)
        .post(`/redis/${redisId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      expect(deployed.status).toBe(409);
      const message = (deployed.body as { message: string }).message;
      expect(message).toContain('task: non-zero exit (1)');
      expect(message).toContain('still running redis:8');
      expect(message).not.toMatch(/\.$/);
      expect(dockerService.update).toHaveBeenCalledTimes(1);
      // The reason reaches the backend log, not only the response.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('task: non-zero exit (1)'),
      );

      expect(await statusOf(ownerSession.cookie, redisId)).toBe('error');
    });

    it('answers running when Swarm has not decided within the request, and the verdict writes the row when it lands', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      instantSleeps = true;
      const answer = heldTaskRead();

      const deployed = await request(server)
        .post(`/redis/${redisId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      expect(deployed.status).toBe(200);
      expect(deployed.body).toMatchObject({ applicationStatus: 'running' });

      rolledBack();
      answer();

      await eventually(
        async () => (await statusOf(ownerSession.cookie, redisId)) === 'error',
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('task: non-zero exit (1)'),
      );
    });

    it('an older deploy’s verdict does not write over a newer deploy’s', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      instantSleeps = true;

      const answerFirst = heldTaskRead();
      await request(server)
        .post(`/redis/${redisId}/deploy`)
        .set('Cookie', ownerSession.cookie)
        .expect(200);
      const answerSecond = heldTaskRead();
      await request(server)
        .post(`/redis/${redisId}/deploy`)
        .set('Cookie', ownerSession.cookie)
        .expect(200);
      expect(service.Spec.TaskTemplate.ForceUpdate).toBe(5);

      // The first deploy is rolled back while the second is still deciding:
      // its failure is logged, and the row stays the second deploy's.
      rolledBack();
      answerFirst();
      await eventually(() =>
        warn.mock.calls.some(([line]) =>
          String(line).includes('task: non-zero exit (1)'),
        ),
      );
      expect(await statusOf(ownerSession.cookie, redisId)).toBe('running');

      // Then the second one runs.
      service.Spec.TaskTemplate.ForceUpdate = 5;
      service.UpdateStatus = { State: 'completed', StartedAt: startedAt };
      tasks = [{ ...servingTask(5), CreatedAt: '2026-09-18T18:57:30Z' }];
      answerSecond();
      await eventually(
        async () => (await statusOf(ownerSession.cookie, redisId)) === 'done',
      );
    });
  });

  describe('status change', () => {
    it('start scales the service up and stop scales it to zero', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const started = await request(server)
        .post(`/redis/${redisId}/start`)
        .set('Cookie', ownerSession.cookie);
      expect(started.status).toBe(200);
      let commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      // `shell-quote` escapes the `=` in the scaled word (`main-cache\\=1`),
      // which the shell strips before `docker` sees it — so this parses the
      // command the argv worded to rather than matching its spelling.
      expectQuotedInCommand(
        commands.find((command) =>
          command.startsWith('docker service scale'),
        ) ?? null,
        'main-cache=1',
      );
      let found = await request(server)
        .get(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });

      execMock.execAsync.mockClear();
      const stopped = await request(server)
        .post(`/redis/${redisId}/stop`)
        .set('Cookie', ownerSession.cookie);
      expect(stopped.status).toBe(200);
      commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      // `shell-quote` escapes the `=` in the scaled word (`main-cache\\=0`),
      // which the shell strips before `docker` sees it — so this parses the
      // command the argv worded to rather than matching its spelling.
      expectQuotedInCommand(
        commands.find((command) =>
          command.startsWith('docker service scale'),
        ) ?? null,
        'main-cache=0',
      );
      found = await request(server)
        .get(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'stopped' });
    });

    it('changeStatus sets the status directly', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const changed = await request(server)
        .post(`/redis/${redisId}/status`)
        .set('Cookie', ownerSession.cookie)
        .send({ applicationStatus: 'error' });
      expect(changed.status).toBe(200);

      const found = await request(server)
        .get(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'error' });
    });
  });

  describe('external port', () => {
    it('saving an external port redeploys publishing it against 6379', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const saved = await request(server)
        .post(`/redis/${redisId}/external-port`)
        .set('Cookie', ownerSession.cookie)
        .send({ externalPort: 6380 });
      expect(saved.status).toBe(200);

      // The save itself converges the service with the published port.
      expect(docker.createService).toHaveBeenCalledTimes(1);
      const [settings] = docker.createService.mock.lastCall as [
        { EndpointSpec: { Mode: string; Ports: unknown[] } },
      ];
      expect(settings.EndpointSpec).toEqual({
        Mode: 'dnsrr',
        Ports: [
          {
            Protocol: 'tcp',
            TargetPort: 6379,
            PublishedPort: 6380,
            PublishMode: 'host',
          },
        ],
      });

      const found = await request(server)
        .get(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ externalPort: 6380 });
    });
  });

  describe('rebuild', () => {
    it('removes the service and its data volume, then re-creates the service', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .post(`/redis/${redisId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      docker.createService.mockClear();
      execMock.execAsync.mockClear();

      const rebuilt = await request(server)
        .post(`/redis/${redisId}/rebuild`)
        .set('Cookie', ownerSession.cookie);
      expect(rebuilt.status).toBe(200);

      const commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      expect(
        commands.some((command) =>
          command.includes('docker service rm main-cache'),
        ),
      ).toBe(true);
      expect(
        commands.some((command) =>
          command.includes('docker volume rm main-cache-data --force'),
        ),
      ).toBe(true);

      // A fresh deploy re-created the service afterwards.
      expect(docker.createService).toHaveBeenCalledTimes(1);
      const found = await request(server)
        .get(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });
    });
  });

  describe('update and environment', () => {
    it('updates config and saves env vars that feed the next deploy', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const updated = await request(server)
        .patch(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'Renamed Cache', memoryLimit: '268435456' });
      expect(updated.status).toBe(200);

      const savedEnv = await request(server)
        .patch(`/redis/${redisId}/environment`)
        .set('Cookie', ownerSession.cookie)
        .send({ env: 'REDIS_MAXMEMORY_POLICY=allkeys-lru' });
      expect(savedEnv.status).toBe(200);

      await request(server)
        .post(`/redis/${redisId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      const [settings] = docker.createService.mock.lastCall as [
        {
          TaskTemplate: {
            ContainerSpec: { Env: string[] };
            Resources: { Limits: { MemoryBytes?: number } };
          };
        },
      ];
      expect(settings.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining([
          'REDIS_PASSWORD=sup3rS3cret',
          'REDIS_MAXMEMORY_POLICY=allkeys-lru',
        ]),
      );
      expect(settings.TaskTemplate.Resources.Limits.MemoryBytes).toBe(
        268435456,
      );

      const found = await request(server)
        .get(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ name: 'Renamed Cache' });
    });

    it('answers its password and takes a new one, as a redis on a cloud does not', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const updated = await request(server)
        .patch(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ databasePassword: 'n3wS3cret' });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ databasePassword: 'n3wS3cret' });

      const found = await request(server)
        .get(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ databasePassword: 'n3wS3cret' });
    });

    it('refuses an env that assigns the requirepass holder, and leaves the stored one alone', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      // `deployInternal` appends the row's own `env` *after* `defaultEnv`, and
      // dotenv lets the later assignment win — so this body used to change the
      // password `--requirepass "$CG_REDIS_REQUIREPASS"` made the server
      // enforce, while `redis.databasePassword` (what the console shows and
      // what every connection string is built from) stayed `sup3rS3cret`.
      // Nothing failed and nothing was logged. `reserved-env.ts` argues why
      // this is refused at the write rather than shadowed at the deploy or
      // documented as operator error; this test is the wiring, from the route
      // through the global `ZodValidationPipe` to the shared schema.
      const refused = await request(server)
        .patch(`/redis/${redisId}/environment`)
        .set('Cookie', ownerSession.cookie)
        .send({ env: 'CG_REDIS_REQUIREPASS=hunter2' });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain('CG_REDIS_REQUIREPASS');

      const ordinary = await request(server)
        .patch(`/redis/${redisId}/environment`)
        .set('Cookie', ownerSession.cookie)
        .send({ env: 'REDIS_MAXMEMORY_POLICY=allkeys-lru' });
      expect(ordinary.status).toBe(200);

      await request(server)
        .post(`/redis/${redisId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      const [settings] = docker.createService.mock.lastCall as [
        { TaskTemplate: { ContainerSpec: { Env: string[] } } },
      ];
      // The refusal is what keeps this pair in agreement.
      expect(settings.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining([
          'CG_REDIS_REQUIREPASS=sup3rS3cret',
          'REDIS_MAXMEMORY_POLICY=allkeys-lru',
        ]),
      );
      expect(
        settings.TaskTemplate.ContainerSpec.Env.filter((pair) =>
          pair.startsWith('CG_REDIS_REQUIREPASS='),
        ),
      ).toEqual(['CG_REDIS_REQUIREPASS=sup3rS3cret']);
    });
  });

  describe('remove', () => {
    it('removes the swarm service and the row', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .post(`/redis/${redisId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      execMock.execAsync.mockClear();

      const removed = await request(server)
        .delete(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);

      const commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      expect(
        commands.some((command) =>
          command.includes('docker service rm main-cache'),
        ),
      ).toBe(true);

      const found = await request(server)
        .get(`/redis/${redisId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(404);
    });
  });

  describe('row-level access', () => {
    it('databases are invisible outside their own organization', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { redisId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;
      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);

      // Same user, but acting in the second organization: the database from
      // the first organization must not resolve, even for its creator.
      await expect(redisService.findOne(secondOrgCtx, redisId)).rejects.toThrow(
        NotFoundException,
      );
      await expect(redisService.deploy(secondOrgCtx, redisId)).rejects.toThrow(
        NotFoundException,
      );
      expect(docker.createService).not.toHaveBeenCalled();
    });
  });
});
