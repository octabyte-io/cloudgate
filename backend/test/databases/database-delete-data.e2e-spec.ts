import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import type { EngineType } from '../../src/mcp/tools/service-kinds';
import { mount } from '../../src/mounts/mount.schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import {
  isPresenceProbe,
  servicePresenceProbe,
  volumePresenceProbe,
} from '../utils/workload-presence-probe';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * What creating each engine takes beyond the shared fields. Typed against the
 * backend's own `EngineType` union, so a seventh engine fails to compile here
 * until it is listed — and then runs every case below (#1413).
 */
const ENGINES = {
  postgres: { databaseName: 'shop', databaseUser: 'shop_user' },
  mysql: { databaseName: 'shop', databaseUser: 'shop_user' },
  mariadb: { databaseName: 'shop', databaseUser: 'shop_user' },
  mongo: { databaseUser: 'mongo_user' },
  redis: {},
  libsql: { databaseUser: 'libsql_user' },
} as const satisfies Record<EngineType, object>;

/** The removal the Delete issues for `main-db-data`, as the operator would type it. */
const VOLUME_RM = 'docker volume rm --force main-db-data';

/**
 * A database on a Server: its Delete keeps `<appName>-data` unless asked to
 * delete its data too, on every engine (#1413). Glossary, **Delete**:
 * "its volumes destroyed only on request".
 */
describe('A database Delete with its data, on a Server (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let environmentId: string;
  let ownerCtx: {
    user: { id: string };
    session: { activeOrganizationId: string };
  };

  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });

  /** Every command succeeds and every presence read says gone. */
  const teardownSucceeds = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command)
        ? { stdout: 'absent\n', stderr: '' }
        : { stdout: '', stderr: '' },
    );

  const commands = () =>
    execMock.execAsync.mock.calls.map(([command]: [string]) => command);

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockImplementation(teardownSucceeds);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        teardownSucceeds(command),
      );
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const userId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    ownerCtx = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };
    const project = await ctx.app
      .get(ProjectsService)
      .create(ownerCtx, { name: 'cloudgate' });
    const environment = await ctx.app
      .get(EnvironmentsService)
      .create(ownerCtx, { name: 'production', projectId: project.projectId });
    environmentId = environment.environmentId;
  });

  async function create(kind: EngineType): Promise<string> {
    const created = await request(server)
      .post(`/${kind}`)
      .set('Cookie', cookie)
      .send({
        name: 'Main DB',
        appName: 'main-db',
        databasePassword: 'sup3rS3cret',
        environmentId,
        ...ENGINES[kind],
      });
    expect(created.status).toBe(201);
    return (created.body as Record<string, string>)[`${kind}Id`];
  }

  describe.each(Object.keys(ENGINES) as EngineType[])('%s', (kind) => {
    it('removes its data volume once the service is gone when asked to delete its data', async () => {
      const id = await create(kind);
      execMock.execAsync.mockClear();

      const removed = await request(server)
        .delete(`/${kind}/${id}?deleteData=true`)
        .set('Cookie', cookie);

      expect(removed.status).toBe(200);
      expect(removed.body).toMatchObject({ volumeLeftBehind: false });
      expect(removed.body).not.toHaveProperty('unreclaimedArtifacts');
      const issued = commands();
      const rm = issued.findIndex((command) => command.includes(VOLUME_RM));
      expect(rm).toBeGreaterThan(-1);
      // After the service is confirmed gone, never ahead of it.
      expect(issued.indexOf(servicePresenceProbe('main-db'))).toBeLessThan(rm);
      // The row is gone.
      expect(
        (await request(server).get(`/${kind}/${id}`).set('Cookie', cookie))
          .status,
      ).toBe(404);
    });

    it('keeps its data volume when the Delete does not ask', async () => {
      const id = await create(kind);
      execMock.execAsync.mockImplementation((command: string) =>
        command === volumePresenceProbe('main-db-data')
          ? Promise.resolve({ stdout: 'present\n', stderr: '' })
          : teardownSucceeds(command),
      );
      execMock.execAsync.mockClear();

      const removed = await request(server)
        .delete(`/${kind}/${id}`)
        .set('Cookie', cookie);

      expect(removed.status).toBe(200);
      expect(removed.body).toMatchObject({ volumeLeftBehind: true });
      expect(commands().some((c) => c.includes('docker volume rm'))).toBe(
        false,
      );
    });
  });

  it('touches no volume on a forced Delete whose service was not confirmed gone, and names it kept', async () => {
    const id = await create('postgres');
    execMock.execAsync.mockImplementation((command: string) =>
      command === servicePresenceProbe('main-db')
        ? Promise.resolve({ stdout: 'unknown\n', stderr: '' })
        : command === volumePresenceProbe('main-db-data')
          ? Promise.resolve({ stdout: 'present\n', stderr: '' })
          : teardownSucceeds(command),
    );
    execMock.execAsync.mockClear();

    const removed = await request(server)
      .delete(`/postgres/${id}?deleteData=true&force=true`)
      .set('Cookie', cookie);

    expect(removed.status).toBe(200);
    expect(commands().some((c) => c.includes('docker volume rm'))).toBe(false);
    expect(removed.body).toMatchObject({
      volumeLeftBehind: true,
      unreclaimedArtifacts: [
        expect.objectContaining({
          kind: 'volume',
          appName: 'main-db',
          path: 'main-db-data',
        }),
      ],
    });
  });

  it('keeps its data volume when another Service on the same Server mounts it, and names that Service', async () => {
    // A stopped Application holds no container on the volume, so
    // `docker volume rm` would succeed and destroy its data without a word
    // from Docker: the claim is read first, as the Application Delete's is.
    const id = await create('postgres');
    const neighbour = await ctx.app.get(ApplicationsService).create(ownerCtx, {
      name: 'Reporting',
      appName: 'reporting',
      environmentId,
      serverId: null,
    });
    await ctx.db.insert(mount).values({
      type: 'volume',
      volumeName: 'main-db-data',
      mountPath: '/var/lib/reporting',
      applicationId: neighbour.applicationId,
    });
    execMock.execAsync.mockImplementation((command: string) =>
      command === volumePresenceProbe('main-db-data')
        ? Promise.resolve({ stdout: 'present\n', stderr: '' })
        : teardownSucceeds(command),
    );
    execMock.execAsync.mockClear();

    const removed = await request(server)
      .delete(`/postgres/${id}?deleteData=true`)
      .set('Cookie', cookie);

    expect(removed.status).toBe(200);
    expect(commands().some((c) => c.includes('docker volume rm'))).toBe(false);
    expect(removed.body).toMatchObject({
      volumeLeftBehind: true,
      unreclaimedArtifacts: [
        expect.objectContaining({
          kind: 'volume',
          appName: 'main-db',
          path: 'main-db-data',
          reason: expect.stringContaining("'Reporting' (reporting)") as string,
        }),
      ],
    });
    expect(
      (await request(server).get(`/postgres/${id}`).set('Cookie', cookie))
        .status,
    ).toBe(404);
  });

  it('deletes the row and names the volume kept when its Volume lock is held', async () => {
    const id = await create('postgres');
    execMock.execAsync.mockImplementation((command: string) => {
      if (command.includes(VOLUME_RM)) {
        return Promise.reject(
          Object.assign(new Error('busy'), {
            exitCode: 75,
            stdout: 'Volume lock busy: main-db-data\n',
            stderr: '',
          }),
        );
      }
      return command === volumePresenceProbe('main-db-data')
        ? Promise.resolve({ stdout: 'present\n', stderr: '' })
        : teardownSucceeds(command);
    });

    const removed = await request(server)
      .delete(`/postgres/${id}?deleteData=true`)
      .set('Cookie', cookie);

    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({
      volumeLeftBehind: true,
      unreclaimedArtifacts: [
        expect.objectContaining({
          kind: 'volume',
          path: 'main-db-data',
          reason: expect.stringContaining('Volume lock') as string,
        }),
      ],
    });
    expect(
      (await request(server).get(`/postgres/${id}`).set('Cookie', cookie))
        .status,
    ).toBe(404);
  });
});
