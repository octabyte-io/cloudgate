import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { postgres, server as serverTable } from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { mount } from '../../src/mounts/mount.schema';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner } from '../utils/test-auth';
import { isPresenceProbe } from '../utils/workload-presence-probe';
import { seededConfigName } from '../utils/seeded-config-name';

jest.setTimeout(120_000);

/**
 * `DELETE /applications/:id?deleteVolumes=true`: the named volumes of
 * the Application's own `volume` mounts are removed on its own Server once the
 * Swarm service is confirmed gone, and every one kept is named with its reason
 * in `unreclaimedArtifacts`.
 *
 * The exec layer is the boundary (§1.7): each volume's removal is one shell
 * program sent to the run Server, recognised here by the `docker volume rm`
 * it ends in, and answered as the fixture's Server would.
 */
describe('Application Delete with deleteVolumes (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  /** What the Server answers a `docker volume rm` of this volume with, when
   * it does not simply succeed. */
  let volumeRmAnswers: Record<string, Error> = {};
  let presence = 'absent';

  const answer = (command: string) => {
    if (isPresenceProbe(command)) {
      return Promise.resolve({ ...ok, stdout: presence });
    }
    const removal = /docker volume rm --force (\S+)\s*$/m.exec(command);
    const refusal = removal && volumeRmAnswers[removal[1]];
    return refusal ? Promise.reject(refusal) : Promise.resolve(ok);
  };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
  });
  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
    writeCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    volumeRmAnswers = {};
    presence = 'absent';
    execMock.execAsync.mockReset().mockImplementation(answer);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        answer(command),
      );
  });

  /** An owner, two Servers, and on the first an Application with two volume
   * mounts and a bind mount, beside a second Application. */
  async function setUp() {
    const signUp = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers['set-cookie'] as unknown as string[];
    const userId = (signUp.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };

    const [runner, other] = await ctx.db
      .insert(serverTable)
      .values([
        { name: 'runner', ipAddress: '198.51.100.4', port: 22, organizationId },
        { name: 'other', ipAddress: '203.0.113.7', port: 22, organizationId },
      ])
      .returning();
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
      deployTarget: { kind: 'platform-host' },
    });
    const app = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'web-app',
      environmentId: environment.environmentId,
      serverId: runner.serverId,
    });
    const neighbour = await applications.create(ownerCtx, {
      name: 'Worker',
      appName: 'worker',
      environmentId: environment.environmentId,
      serverId: runner.serverId,
    });
    const elsewhere = await applications.create(ownerCtx, {
      name: 'Far Away',
      appName: 'far-away',
      environmentId: environment.environmentId,
      serverId: other.serverId,
    });
    await ctx.db.insert(mount).values([
      {
        type: 'volume',
        volumeName: 'web-uploads',
        mountPath: '/uploads',
        applicationId: app.applicationId,
      },
      {
        type: 'volume',
        volumeName: 'web-cache',
        mountPath: '/cache',
        applicationId: app.applicationId,
      },
      {
        type: 'bind',
        hostPath: '/srv/web-host',
        mountPath: '/host',
        applicationId: app.applicationId,
      },
      // The same name on another Server is another volume, and claims nothing.
      {
        type: 'volume',
        volumeName: 'web-cache',
        mountPath: '/cache',
        applicationId: elsewhere.applicationId,
      },
    ]);
    return { cookie, ownerCtx, app, neighbour, runner, other, environment };
  }

  /** The volumes each Server was asked to `docker volume rm`. */
  const volumeRemovals = () =>
    execMock.execAsyncRemote.mock.calls.flatMap(([serverId, command]) => {
      const removal = /docker volume rm --force (\S+)\s*$/m.exec(command);
      return removal ? [{ serverId, volume: removal[1] }] : [];
    });

  const volumeReport = (body: unknown) =>
    (
      (
        body as {
          unreclaimedArtifacts?: {
            kind: string;
            path: string;
            serverId: string | null;
            reason?: string;
          }[];
        }
      ).unreclaimedArtifacts ?? []
    ).filter((artifact) => artifact.kind === 'volume');

  it('removes both named volumes on the Application’s own Server and leaves the host path alone', async () => {
    const { cookie, app, runner } = await setUp();

    const res = await request(server)
      .delete(`/applications/${app.applicationId}?deleteVolumes=true`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(volumeRemovals()).toStrictEqual([
      { serverId: runner.serverId, volume: 'web-uploads' },
      { serverId: runner.serverId, volume: 'web-cache' },
    ]);
    const everything = [
      ...execMock.execAsync.mock.calls.map(([c]) => c),
      ...execMock.execAsyncRemote.mock.calls.map(([, c]) => c),
    ];
    expect(everything.filter((c) => c.includes('/srv/web-host'))).toStrictEqual(
      [],
    );
    // Taken under each volume's lock.
    const [first] = execMock.execAsyncRemote.mock.calls
      .map(([, c]) => c)
      .filter((c) => c.includes('docker volume rm'));
    expect(first).toContain('Volume lock acquired: web-uploads');
    expect(volumeReport(res.body)).toStrictEqual([]);
  });

  it.each([
    ['absent', ''],
    ['false', '?deleteVolumes=false'],
    ['anything but true', '?deleteVolumes=1'],
  ])('removes no volume when deleteVolumes is %s', async (_label, query) => {
    const { cookie, app } = await setUp();

    const res = await request(server)
      .delete(`/applications/${app.applicationId}${query}`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(volumeRemovals()).toStrictEqual([]);
    expect(volumeReport(res.body)).toStrictEqual([]);
  });

  it('keeps a volume another Service on the same Server mounts, and names that Service', async () => {
    const { cookie, app, neighbour, runner } = await setUp();
    await ctx.db.insert(mount).values({
      type: 'volume',
      volumeName: 'web-uploads',
      mountPath: '/shared',
      applicationId: neighbour.applicationId,
    });

    const res = await request(server)
      .delete(`/applications/${app.applicationId}?deleteVolumes=true`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(volumeRemovals()).toStrictEqual([
      { serverId: runner.serverId, volume: 'web-cache' },
    ]);
    const [kept] = volumeReport(res.body) as {
      path: string;
      serverId: string;
      reason: string;
    }[];
    expect(kept).toMatchObject({
      path: 'web-uploads',
      serverId: runner.serverId,
    });
    expect(kept.reason).toContain("'Worker'");
    expect(kept.reason).toContain('worker');
  });

  it('keeps a volume another Organization’s Service on the platform host mounts, without naming it', async () => {
    // The platform host is every Organization's, so a shared name there can
    // be anyone's: the volume is kept, and whose it is is not the caller's to
    // learn by deleting something.
    const { cookie, ownerCtx, environment } = await setUp();
    const mine = await applications.create(ownerCtx, {
      name: 'Local',
      appName: 'local-app',
      environmentId: environment.environmentId,
      serverId: null,
    });
    const stranger = await secondOrganizationOwner(
      server,
      ctx.db,
      cookie as unknown as string,
    );
    const strangerCtx = {
      user: { id: stranger.id },
      session: { activeOrganizationId: stranger.organizationId },
    };
    const theirProject = await projects.create(strangerCtx, { name: 'secret' });
    const theirEnvironment = await environments.create(strangerCtx, {
      name: 'production',
      projectId: theirProject.projectId,
      deployTarget: { kind: 'platform-host' },
    });
    const theirs = await applications.create(strangerCtx, {
      name: 'Top Secret Ledger',
      appName: 'ledger',
      environmentId: theirEnvironment.environmentId,
      serverId: null,
    });
    await ctx.db.insert(mount).values([
      {
        type: 'volume',
        volumeName: 'common-name',
        mountPath: '/data',
        applicationId: mine.applicationId,
      },
      {
        type: 'volume',
        volumeName: 'common-name',
        mountPath: '/data',
        applicationId: theirs.applicationId,
      },
    ]);

    const res = await request(server)
      .delete(`/applications/${mine.applicationId}?deleteVolumes=true`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    const localRemovals = execMock.execAsync.mock.calls.filter(([c]) =>
      c.includes('docker volume rm'),
    );
    expect(localRemovals).toStrictEqual([]);
    const [kept] = volumeReport(res.body);
    expect(kept).toMatchObject({ path: 'common-name', serverId: null });
    expect(kept.reason).toContain('another Service');
    expect(JSON.stringify(res.body)).not.toContain('Top Secret Ledger');
    expect(JSON.stringify(res.body)).not.toContain('ledger');
  });

  it('keeps a volume that is a managed database’s own data volume on the same Server', async () => {
    // No mount row names it — a database's `<appName>-data` is derived at
    // deploy time — and a stopped database holds no container on it, so
    // Docker would remove it without a word.
    const { cookie, app, runner, environment } = await setUp();
    await ctx.db.insert(postgres).values({
      name: 'orders',
      appName: 'orders-db',
      environmentId: environment.environmentId,
      configName: seededConfigName(),
      serverId: runner.serverId,
      databaseName: 'orders',
      databaseUser: 'orders',
      databasePassword: 'super-secret-database-password',
    });
    await ctx.db.insert(mount).values({
      type: 'volume',
      volumeName: 'orders-db-data',
      mountPath: '/orders',
      applicationId: app.applicationId,
    });

    const res = await request(server)
      .delete(`/applications/${app.applicationId}?deleteVolumes=true`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(volumeRemovals().map((r) => r.volume)).not.toContain(
      'orders-db-data',
    );
    expect(volumeReport(res.body)).toStrictEqual([
      expect.objectContaining({
        path: 'orders-db-data',
        reason: expect.stringContaining("'orders'") as unknown,
      }),
    ]);
  });

  it('keeps a volume whose Volume lock is held and still removes the others', async () => {
    const { cookie, app, runner } = await setUp();
    volumeRmAnswers['web-uploads'] = Object.assign(
      new Error('Command failed with exit code 75'),
      { exitCode: 75, stdout: 'Volume lock busy: web-uploads\n', stderr: '' },
    );

    const res = await request(server)
      .delete(`/applications/${app.applicationId}?deleteVolumes=true`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(volumeRemovals()).toContainEqual({
      serverId: runner.serverId,
      volume: 'web-cache',
    });
    expect(volumeReport(res.body)).toStrictEqual([
      expect.objectContaining({
        path: 'web-uploads',
        reason: expect.stringContaining('Volume lock is held') as unknown,
      }),
    ]);
  });

  it('keeps a volume Docker refuses to remove, with Docker’s reason', async () => {
    const { cookie, app } = await setUp();
    volumeRmAnswers['web-cache'] = Object.assign(
      new Error('Command failed with exit code 1'),
      {
        exitCode: 1,
        stdout: 'Volume lock acquired: web-cache\n',
        stderr:
          'Error response from daemon: remove web-cache: volume is in use - [0123456789ab]\n',
      },
    );

    const res = await request(server)
      .delete(`/applications/${app.applicationId}?deleteVolumes=true`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(volumeReport(res.body)).toStrictEqual([
      expect.objectContaining({
        path: 'web-cache',
        reason: expect.stringContaining(
          'remove web-cache: volume is in use',
        ) as unknown,
      }),
    ]);
  });

  it('touches no volume on a forced Delete whose service could not be confirmed gone, and says so', async () => {
    const { cookie, app } = await setUp();
    presence = 'present';

    const res = await request(server)
      .delete(
        `/applications/${app.applicationId}?force=true&deleteVolumes=true`,
      )
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(volumeRemovals()).toStrictEqual([]);
    expect(volumeReport(res.body).map((a) => a.path)).toStrictEqual([
      'web-uploads',
      'web-cache',
    ]);
  });
});
