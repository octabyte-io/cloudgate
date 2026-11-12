import { eq } from 'drizzle-orm';
import { quote } from 'shell-quote';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  DATABASE_VOLUME_RELEASE_CLOCK,
  VOLUME_RELEASE_TIMEOUT_MS,
} from '../../src/databases/common/database-ops';
import { postgres as postgresTable } from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * `BaseDatabaseService.rebuild` is shared by all six engines, and on a
 * real Swarm it could not succeed: `docker service rm` returns before the
 * service's task container has stopped, so the `docker volume rm` straight
 * after it met `volume is in use` and the route answered 500 — with the
 * service already gone. Every retry then failed at its first step, because
 * `docker service rm` of a service that is not there exits 1.
 *
 * Postgres is the engine here on purpose: its shutdown checkpoint is the
 * widest window between the service going and its volume being released.
 *
 * Doubles sit only at the boundaries, injected through DI as the sibling
 * engine suites do: the exec layer, scripted per command; the Docker API the
 * redeploy converges through; and the clock the volume wait polls on, so a
 * minute's wait is spent in microseconds rather than faked around a loop
 * that awaits an exec between every sleep. The row, the permission check and
 * the redeploy are the product's own, over HTTP.
 */
describe('Database rebuild (e2e)', () => {
  const APP = 'main-db';
  const VOLUME = `${APP}-data`;
  const SERVICE_RM = `docker service rm ${APP}`;
  // Worded by `quote()`, as the exec double words argv — which escapes the `=`.
  const HOLDERS = quote([
    'docker',
    'ps',
    '-a',
    '-q',
    '--filter',
    `volume=${VOLUME}`,
  ]);
  const VOLUME_RM = `docker volume rm ${VOLUME} --force`;
  const PULL = quote(['docker', 'pull', 'postgres:18']);

  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;

  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });
  const dockerService = { inspect: jest.fn(), update: jest.fn() };
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
  /** A clock whose sleep is instant and moves `now` on by what was slept. */
  let now = 0;
  const clock = {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };

  const ok = (stdout = '') => ({ stdout, stderr: '' });
  const refused = (command: string, stderr: string) =>
    new ExecError('Command failed with exit code 1', {
      command,
      stderr,
      exitCode: 1,
    });
  /** The exec layer's answer to every command a script does not claim. */
  const byDefault = (command: string) =>
    Promise.resolve(ok(isPresenceProbe(command) ? 'absent' : ''));
  const script = (
    answer: (command: string) => Promise<unknown> | undefined,
  ) => {
    execMock.execAsync.mockImplementation(
      (command: string) => answer(command) ?? byDefault(command),
    );
  };
  const commands = () =>
    execMock.execAsync.mock.calls.map(([command]: [string]) => command);

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
        { provide: DATABASE_VOLUME_RELEASE_CLOCK, useValue: clock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    now = 0;
    execMock.execAsync.mockReset().mockImplementation(byDefault);
    execMock.execAsyncRemote.mockReset();
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.getService.mockClear();
    docker.createService.mockReset().mockResolvedValue(undefined);
    dockerFactoryMock.getRemoteDocker.mockClear();
  });

  /** An owner with one Postgres database, never deployed. */
  async function setUp() {
    const signUp = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    const cookie = signUp.headers['set-cookie'];
    const userId = (signUp.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const created = await request(server)
      .post('/postgres')
      .set('Cookie', cookie)
      .send({
        name: 'Main DB',
        appName: APP,
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
      });
    expect(created.status).toBe(201);
    const { postgresId } = created.body as { postgresId: string };
    execMock.execAsync.mockClear();

    const rebuild = () =>
      request(server)
        .post(`/postgres/${postgresId}/rebuild`)
        .set('Cookie', cookie);
    const status = async () =>
      (
        (
          await request(server)
            .get(`/postgres/${postgresId}`)
            .set('Cookie', cookie)
        ).body as { applicationStatus: string }
      ).applicationStatus;
    return { postgresId, rebuild, status };
  }

  it('waits while the volume is still in use, then deletes it and deploys', async () => {
    const { rebuild, status } = await setUp();
    let volumeRms = 0;
    script((command) =>
      command === VOLUME_RM && volumeRms++ === 0
        ? Promise.reject(
            refused(
              command,
              `Error response from daemon: remove ${VOLUME}: volume is in use - [d4c9e1]`,
            ),
          )
        : undefined,
    );

    const res = await rebuild();

    expect(res.status).toBe(200);
    const sequence = commands();
    expect(sequence.filter((c) => c === VOLUME_RM)).toHaveLength(2);
    // The deploy comes after the volume is gone, never before.
    expect(sequence.indexOf(PULL)).toBeGreaterThan(
      sequence.lastIndexOf(VOLUME_RM),
    );
    expect(docker.createService).toHaveBeenCalledTimes(1);
    expect(await status()).toBe('done');
  });

  it('does not try to delete the volume while a container still holds it', async () => {
    const { rebuild } = await setUp();
    let polls = 0;
    script((command) =>
      command === HOLDERS
        ? Promise.resolve(ok(polls++ < 3 ? 'd4c9e1\n' : ''))
        : undefined,
    );

    const res = await rebuild();

    expect(res.status).toBe(200);
    const sequence = commands();
    expect(sequence.filter((c) => c === HOLDERS)).toHaveLength(4);
    expect(sequence.filter((c) => c === VOLUME_RM)).toHaveLength(1);
    expect(sequence.indexOf(VOLUME_RM)).toBe(sequence.lastIndexOf(HOLDERS) + 1);
    expect(docker.createService).toHaveBeenCalledTimes(1);
  });

  it('treats a service that is already gone as removed, so a retry finishes', async () => {
    const { rebuild, status } = await setUp();
    script((command) =>
      command === SERVICE_RM
        ? Promise.reject(
            refused(
              command,
              `Error response from daemon: service ${APP} not found`,
            ),
          )
        : undefined,
    );

    const res = await rebuild();

    expect(res.status).toBe(200);
    expect(commands()).toContain(VOLUME_RM);
    expect(docker.createService).toHaveBeenCalledTimes(1);
    expect(await status()).toBe('done');
  });

  it('refuses without touching the volume when the service could not be removed and is still there', async () => {
    const { rebuild, status } = await setUp();
    script((command) => {
      if (command === SERVICE_RM) {
        return Promise.reject(
          refused(command, 'Error response from daemon: rpc error: timeout'),
        );
      }
      return isPresenceProbe(command)
        ? Promise.resolve(ok('present'))
        : undefined;
    });

    const res = await rebuild();

    expect(res.status).toBe(409);
    const { message } = res.body as { message: string };
    expect(message).toMatch(/removing the Swarm service/i);
    expect(message).toContain('rpc error: timeout');
    expect(message).toMatch(/nothing was deleted/i);
    expect(commands()).not.toContain(VOLUME_RM);
    expect(docker.createService).not.toHaveBeenCalled();
    // The database is as it was, so its status is left alone.
    expect(await status()).toBe('idle');
  });

  it('gives up on a volume that is never released with an error naming the step and the holder', async () => {
    const { rebuild, status } = await setUp();
    script((command) =>
      command === HOLDERS ? Promise.resolve(ok('d4c9e1\n')) : undefined,
    );

    const res = await rebuild();

    expect(res.status).toBe(409);
    const { message } = res.body as { message: string };
    expect(message).toMatch(/deleting the data volume/i);
    expect(message).toContain(VOLUME);
    expect(message).toContain('d4c9e1');
    expect(message).toContain(`${VOLUME_RELEASE_TIMEOUT_MS / 1000} seconds`);
    // The service is gone by now, so the error must not read as "nothing
    // changed" and the row must not stay as it was.
    expect(message).toMatch(/service was removed/i);
    expect(await status()).toBe('error');
    expect(commands()).not.toContain(VOLUME_RM);
    expect(docker.createService).not.toHaveBeenCalled();
    // It waited the whole window on the clock, not one poll.
    expect(now).toBeGreaterThanOrEqual(VOLUME_RELEASE_TIMEOUT_MS);
  });

  it('names Docker’s own refusal when the volume removal fails for another reason', async () => {
    const { rebuild, status } = await setUp();
    script((command) =>
      command === VOLUME_RM
        ? Promise.reject(
            refused(command, 'Error response from daemon: permission denied'),
          )
        : undefined,
    );

    const res = await rebuild();

    expect(res.status).toBe(409);
    const { message } = res.body as { message: string };
    expect(message).toMatch(/deleting the data volume/i);
    expect(message).toContain('permission denied');
    expect(await status()).toBe('error');
    expect(docker.createService).not.toHaveBeenCalled();
  });

  it('names the redeploy when the volume is gone and the deploy fails', async () => {
    const { rebuild, status } = await setUp();
    script((command) =>
      command === PULL
        ? Promise.reject(
            refused(command, 'Error response from daemon: manifest unknown'),
          )
        : undefined,
    );

    const res = await rebuild();

    expect(res.status).toBe(409);
    const { message } = res.body as { message: string };
    expect(message).toMatch(/deploying the Postgres again/i);
    expect(message).toMatch(/data volume was deleted/i);
    expect(message).toMatch(/offline/i);
    expect(message).toContain('manifest unknown');
    expect(await status()).toBe('error');
  });

  it('names the redeploy when the deploy refuses with a sentence of its own', async () => {
    const { postgresId, rebuild } = await setUp();
    // The row goes while the rebuild is between its steps — a Delete from
    // another tab — so the redeploy answers 404 on its own.
    script((command) => {
      if (command !== VOLUME_RM) return undefined;
      return ctx.db
        .delete(postgresTable)
        .where(eq(postgresTable.postgresId, postgresId))
        .then(() => ok());
    });

    const res = await rebuild();

    expect(res.status).toBe(409);
    const { message } = res.body as { message: string };
    expect(message).toMatch(/deploying the Postgres again/i);
    expect(message).toMatch(/data volume was deleted/i);
    expect(message).toContain('Postgres not found');
  });
});
