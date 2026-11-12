import { ConflictException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { ComposeService } from '../../src/compose/compose.service';
import { COMPOSE_SETTLE_CLOCK } from '../../src/compose/compose.utils';
import type { SettleClock } from '../../src/compose/compose.utils';
import { server as serverTable } from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { traceStore } from '../../src/traces/trace-store.schema';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * A Delete on a Server it cannot reach dials that Server once.
 *
 * Measured on an earlier walk with a Server row pointed at SSH port 1: an
 * unforced `DELETE /applications/:id` answered its 409 after 80 s and a forced
 * one its 200 after ~200 s, because every best-effort step — the workload, the
 * Traefik config, the presence read, then each reclamation — dialled SSH on its
 * own. The console's proxy gives up at 240 s. So each Delete now carries one
 * `ReachabilityMemo`: the first *connection* failure marks the Server, and every
 * later step aimed at it fails at once with that same error — which still
 * lands its artifact in the report, and still reads as the presence read's
 * `'unknown'`.
 *
 * "One dial" is counted at the exec double, which is the whole transport: the
 * real `TraefikWriterService` is kept so its `rm -f` is a dial like any other,
 * and `withArgvExec` forwards the argv half to the string mock, so
 * `execAsyncRemote`'s calls for a Server are every connection opened to it.
 *
 * The rejection is an `ExecError` marked `connectionFailed` — what
 * `RemoteExecService` raises when ssh2's client errors before a session exists
 * — because that, and not any error at all, is what marks a Server.
 */
describe('A Delete on a Server it cannot reach (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let composeService: ComposeService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
  });

  /** Advances only by its own sleeps (H-105), so nothing here waits. */
  let settleElapsedMs = 0;
  const settleClock: SettleClock = {
    now: () => settleElapsedMs,
    sleep: (ms) => {
      settleElapsedMs += ms;
      return Promise.resolve();
    },
  };

  const healthy = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command) ? { ...ok, stdout: 'absent' } : ok,
    );

  /** ssh2's refused connection, as `RemoteExecService` reports it. */
  const refused = (serverId: string, command: string) =>
    new ExecError('SSH connection error: connect ECONNREFUSED 203.0.113.7:1', {
      command,
      serverId,
      connectionFailed: true,
    });

  /** Every Server in `unreachable` refuses every connection; the rest are
   * healthy. */
  const unreachable = (...serverIds: string[]) =>
    execMock.execAsyncRemote.mockImplementation(
      (serverId: string, command: string) =>
        serverIds.includes(serverId)
          ? Promise.reject(refused(serverId, command))
          : healthy(command),
    );

  /** How many connections were opened to `serverId`. */
  const dials = (serverId: string) =>
    execMock.execAsyncRemote.mock.calls.filter(([id]) => id === serverId)
      .length;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: COMPOSE_SETTLE_CLOCK, useValue: settleClock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    composeService = ctx.app.get(ComposeService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockImplementation(healthy);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        healthy(command),
      );
  });

  const permissionCtx = (userId: string, organizationId: string) => ({
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
  });

  async function addServer(organizationId: string, name: string) {
    const [row] = await ctx.db
      .insert(serverTable)
      .values({ name, ipAddress: '203.0.113.7', port: 1, organizationId })
      .returning();
    return row.serverId;
  }

  /**
   * An owner, a Project with one Environment, and a traced git-sourced
   * Application on a Server — that walk's shape, whose forced Delete named
   * seven artifacts.
   */
  async function setUp() {
    const res = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'];
    const userId = (res.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(userId, organizationId);

    const serverId = await addServer(organizationId, 'hetzner-vps');
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
      deployTarget: { kind: 'platform-host' },
    });
    const created = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'web-app',
      environmentId: environment.environmentId,
      serverId,
    });
    const application = await applications.update(
      ownerCtx,
      created.applicationId,
      {
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/acme/web.git',
        customGitBranch: 'main',
      },
    );
    await ctx.db.insert(traceStore).values({
      serviceType: 'application',
      applicationId: application.applicationId,
      enabled: true,
      credential: 'ingest-credential',
      queryCredential: 'query-credential',
    });
    return {
      organizationId,
      ownerCtx,
      serverId,
      project,
      environment,
      application,
    };
  }

  describe('an Application', () => {
    it('answers the could-not-reach-Docker 409 after one dial', async () => {
      const { ownerCtx, serverId, application } = await setUp();
      unreachable(serverId);

      const refusal = applications.remove(ownerCtx, application.applicationId);

      await expect(refusal).rejects.toBeInstanceOf(ConflictException);
      await expect(refusal).rejects.toThrow(
        'Cloudgate could not reach Docker to confirm swarm service web-app is gone',
      );
      expect(dials(serverId)).toBe(1);
    });

    it('forces the Delete after one dial, and still names every artifact it left', async () => {
      const { ownerCtx, serverId, application } = await setUp();
      unreachable(serverId);

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
        true,
      );

      expect(dials(serverId)).toBe(1);
      expect(removed).toMatchObject({
        orphaned: { appName: 'web-app', serverId, reason: 'unknown' },
      });
      expect(
        removed.unreclaimedArtifacts?.map(({ kind, serverId: on }) => [
          kind,
          on,
        ]),
      ).toEqual([
        ['traefik-config', serverId],
        ['patch-repo', serverId],
        ['file-mounts', serverId],
        ['trace-store', serverId],
        ['trace-store', serverId],
        ['source-tree', serverId],
        ['deployment-logs', serverId],
      ]);
      expect(removed.unreclaimedImages).toEqual([
        { serverId, images: ['web-app:latest'] },
      ]);
    });

    /**
     * Only failing to *connect* marks a Server. A command that ran and exited
     * non-zero — a busy mount, a permission the SSH user lacks — says the
     * Server answered, so every step after it is still dialled and only the
     * one artifact is reported.
     */
    it('keeps dialling a Server after a step on it exits non-zero', async () => {
      const { ownerCtx, serverId, application } = await setUp();
      execMock.execAsyncRemote.mockImplementation(
        (on: string, command: string) =>
          command.endsWith('/web-app/files')
            ? Promise.reject(
                new ExecError('Remote command failed with exit code 1', {
                  command,
                  serverId: on,
                  exitCode: 1,
                }),
              )
            : healthy(command),
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      expect(removed.unreclaimedArtifacts).toEqual([
        expect.objectContaining({ kind: 'file-mounts', serverId }),
      ]);
      // The Trace store, the directory and the logs all come after the file
      // mounts, and all three were still asked for.
      const commands = execMock.execAsyncRemote.mock.calls.map(
        ([, command]) => command,
      );
      const failedAt = commands.findIndex((command) =>
        command.endsWith('/web-app/files'),
      );
      expect(
        commands
          .slice(failedAt + 1)
          .filter((command) => command.startsWith('rm -rf ')),
      ).toHaveLength(3);
    });

    it('dials the Server again on the next Delete, since the memo is that Delete’s alone', async () => {
      const { ownerCtx, serverId, application } = await setUp();
      unreachable(serverId);
      await expect(
        applications.remove(ownerCtx, application.applicationId),
      ).rejects.toBeInstanceOf(ConflictException);

      await expect(
        applications.remove(ownerCtx, application.applicationId),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(dials(serverId)).toBe(2);
    });
  });

  describe('a Compose', () => {
    async function addCompose(
      ownerCtx: ReturnType<typeof permissionCtx>,
      environmentId: string,
      serverId: string,
    ) {
      const created = await composeService.create(ownerCtx, {
        name: 'Shop',
        appName: 'shop-stack',
        environmentId,
        serverId,
      });
      return composeService.update(ownerCtx, created.composeId, {
        sourceType: 'raw',
        composeFile: 'services:\n  web:\n    image: nginx:alpine\n',
      });
    }

    it('answers the could-not-reach-Docker 409 after one dial', async () => {
      const { ownerCtx, serverId, environment } = await setUp();
      const stack = await addCompose(
        ownerCtx,
        environment.environmentId,
        serverId,
      );
      unreachable(serverId);

      const refusal = composeService.remove(ownerCtx, stack.composeId);

      await expect(refusal).rejects.toThrow(
        'Cloudgate could not reach Docker to confirm compose stack shop-stack is gone',
      );
      expect(dials(serverId)).toBe(1);
    });

    it('forces the Delete after one dial, and still names what it left', async () => {
      const { ownerCtx, serverId, environment } = await setUp();
      const stack = await addCompose(
        ownerCtx,
        environment.environmentId,
        serverId,
      );
      unreachable(serverId);

      const removed = await composeService.remove(
        ownerCtx,
        stack.composeId,
        false,
        true,
      );

      expect(dials(serverId)).toBe(1);
      expect(removed.unreclaimedArtifacts?.map(({ kind }) => kind)).toEqual([
        'network',
        'compose-directory',
        'deployment-logs',
      ]);
    });
  });

  describe('a Project', () => {
    it('refuses after one dial per unreachable Server, and dials a reachable one as usual', async () => {
      const { ownerCtx, organizationId, serverId, project, environment } =
        await setUp();
      const otherServerId = await addServer(organizationId, 'edge-2');
      await applications.create(ownerCtx, {
        name: 'Api',
        appName: 'api-app',
        environmentId: environment.environmentId,
        serverId: otherServerId,
      });
      unreachable(serverId);

      await expect(
        projects.remove(ownerCtx, project.projectId),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(dials(serverId)).toBe(1);
      // The reachable Server's three, unchanged: its workload, its Traefik
      // config and its presence read.
      expect(dials(otherServerId)).toBe(3);
    });

    it('forces the Delete after one dial, and still names every artifact it left', async () => {
      const { ownerCtx, serverId, project } = await setUp();
      unreachable(serverId);

      const removed = await projects.remove(ownerCtx, project.projectId, true);

      expect(dials(serverId)).toBe(1);
      expect(removed.unreclaimedArtifacts?.map(({ kind }) => kind)).toEqual([
        'traefik-config',
        'patch-repo',
        'file-mounts',
        'trace-store',
        'trace-store',
        'source-tree',
        'deployment-logs',
      ]);
    });
  });
});
