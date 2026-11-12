import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { ConflictException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import { ComposeService } from '../../src/compose/compose.service';
import { COMPOSE_SETTLE_CLOCK } from '../../src/compose/compose.utils';
import type { SettleClock } from '../../src/compose/compose.utils';
import { server as serverTable } from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { MountsService } from '../../src/mounts/mounts.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * Which **root** a compose stack's project tree is written, read and destroyed
 * under (`deployment-engine.paths.ts`' third named item, ADR-0018's rule
 * stated for roots).
 *
 * `composeDirectory()` was `localCloudgateDirectory()` — *this process's* root
 * — and every one of its nine call sites resolved it for every machine alike,
 * while all nine are interpolated into commands sent to `compose.serverId`. So
 * on an install with `CLOUDGATE_DIRECTORY` set, a stack deployed to a Server
 * cloned into a root `serverSetupCommand` never laid out there, the
 * `docker compose -f` that followed named a file under it, `MountsService`
 * wrote the operator's config files beside it, and the Delete's `rm -rf` named
 * it too.
 *
 * **Why nothing broke, and why nothing would have caught it.** With
 * `CLOUDGATE_DIRECTORY` unset the two roots are the *same literal*, so all nine
 * sites were self-consistent and every pre-existing assertion about them —
 * `compose-commands.spec.ts`, `compose.e2e-spec.ts`, `mounts.e2e-spec.ts`,
 * `service-cascade.spec.ts` — passes whichever root is resolved. That is the
 * paths audit's headline measurement one directory along. So this file sets the
 * variable and every expectation names the *resolved* temp path, because
 * `/etc/cloudgate` exists and is writable on some development hosts and a
 * silent fall back to the default would read as a pass.
 *
 * **A stack has one machine, which is what makes this set simpler than the
 * Application's and is worth stating rather than assuming.**
 * `ComposeService.findCompose` hard-codes `buildServerId: null`, so
 * `buildHostServerId` falls through and `compose.serverId` is both the run
 * Server and the build host. That is also why the mount-source question which
 * defers `applicationsDirectory()` does not arise here: the daemon that
 * resolves `{...}/files/...` as the operator's own `volumes:` source is the
 * daemon on the machine `MountsService` wrote the file to.
 *
 * **And why the conversion had to be the whole set at once.** ADR-0018: whoever
 * creates an artifact and whoever destroys it must answer this the same way.
 * The writers are `DeploymentEngineService.deployCompose`'s clone and
 * `MountsService`'s `baseFilesPath`; the destroyers are
 * `reclaimComposeDirectory`'s `rm -rf` (the teardown program's closing
 * statement until the delete took it as its own step) and
 * `MountsService.remove`'s. So the decisive assertions below are not any single
 * path's words but *"the teardown names the directory the clone wrote"*, taken
 * from `deployCompose`'s own dispatch rather than from this file's opinion.
 *
 * The exec layer is the only double, and it is a boundary (§1.7).
 */
describe('The root a compose stack’s project tree lives under (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let composeService: ComposeService;
  let mounts: MountsService;
  let engine: DeploymentEngineService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
  });

  /**
   * Every command succeeds, the presence read says the stack's workload is
   * gone so a Delete is not refused, and a `cat` of the on-disk compose
   * file answers with something claimable — `start` reads it back and hands it
   * to `composeStartCommand`. The root is the only thing under test, so nothing
   * here may fail for a second reason.
   */
  const COMPOSE_FILE = 'services:\n  web:\n    image: nginx:alpine\n';
  const answers = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command)
        ? { ...ok, stdout: 'absent' }
        : command.startsWith('cat ') || command.includes(' cat ')
          ? { ...ok, stdout: COMPOSE_FILE }
          : ok,
    );

  /**
   * The per-Compose Delete's settle clock, advancing only by its own sleeps, so
   * a refused Delete exhausts its fifteen-second wait in microseconds. The
   * cascade takes the system clock (`CascadeDeps.settleClock`), so its refused
   * test below waits the real window.
   */
  let settleElapsedMs = 0;
  const settleClock: SettleClock = {
    now: () => settleElapsedMs,
    sleep: (ms) => {
      settleElapsedMs += ms;
      return Promise.resolve();
    },
  };

  /** A real temp directory, so the two roots are genuinely two strings. */
  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-compose-tree-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    // Before `createTestApp`: `localCloudgateDirectory()` reads `process.env`
    // on every call, but `validateEnv` runs once at boot.
    process.env.CLOUDGATE_DIRECTORY = configuredRoot;
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: COMPOSE_SETTLE_CLOCK, useValue: settleClock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    composeService = ctx.app.get(ComposeService);
    mounts = ctx.app.get(MountsService);
    engine = ctx.app.get(DeploymentEngineService);
  });

  afterAll(async () => {
    await ctx.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(configuredRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockImplementation(answers);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        answers(command),
      );
  });

  const permissionCtx = (userId: string, organizationId: string) => ({
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
  });

  async function signUp(email: string) {
    const res = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email,
      password: 'super-secret-password',
    });
    expect(res.status).toBe(200);
    return {
      cookie: res.headers['set-cookie'],
      id: (res.body as { user: { id: string } }).user.id,
    };
  }

  /** A raw `docker-compose` stack, on a named Server or on the platform host. */
  async function setUp(appName = 'shop-stack', { onServer = true } = {}) {
    const session = await signUp(`grace+${appName}@example.com`);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', session.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(session.id, organizationId);

    const stackServerId = onServer
      ? (
          await ctx.db
            .insert(serverTable)
            .values({
              name: 'runner-us',
              ipAddress: '198.51.100.4',
              port: 22,
              organizationId,
            })
            .returning()
        )[0].serverId
      : null;

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
      deployTarget: { kind: 'platform-host' },
    });
    const created = await composeService.create(ownerCtx, {
      name: 'Shop',
      appName,
      environmentId: environment.environmentId,
      serverId: stackServerId,
    });
    // `raw`, so the "clone" is the `raw` strategy's own destructive write of
    // the converted file into the code directory rather than a `git clone` —
    // which is the writer under test and needs no provider row. `sourceType`
    // is an update-only column (`createComposeSchema` takes composeType,
    // serverId and composeFile only).
    const stack = await composeService.update(ownerCtx, created.composeId, {
      sourceType: 'raw',
      composeFile: COMPOSE_FILE,
    });

    return {
      session,
      organizationId,
      ownerCtx,
      project,
      environment,
      stack,
      stackServerId,
    };
  }

  /** Every command the exec layer was asked for, with the machine it was asked
   * of — `null` being the platform host (ADR-0008). */
  const dispatched = () => [
    ...execMock.execAsync.mock.calls.map(([command]) => ({
      serverId: null as string | null,
      command,
    })),
    ...execMock.execAsyncRemote.mock.calls.map(([serverId, command]) => ({
      serverId,
      command,
    })),
  ];

  /** The `{root}/compose` a machine's own project tree is rooted at. */
  const composeRootOn = (serverId: string | null) =>
    serverId
      ? `${REMOTE_CLOUDGATE_DIRECTORY}/compose`
      : `${configuredRoot}/compose`;

  const deploy = async (composeId: string) =>
    engine.deployCompose(await composeService.findDeployable(composeId));

  /** Every dispatch whose command names `needle`, with the machine it went to
   * — the expectation every reader and destroyer below is measured against is
   * read off the code that made the artifact rather than restated here. */
  const commandsMatching = (needle: string) =>
    dispatched().filter(({ command }) => command.includes(needle));

  /** Every machine asked to `rm -rf` exactly this project tree — the delete's
   * own step, rather than the teardown program's last statement. */
  const treeRemovals = (projectDirectory: string) =>
    dispatched().filter(
      ({ command }) => command === `rm -rf ${projectDirectory}`,
    );

  describe('the writers', () => {
    /**
     * The clone, which is the tree's first writer. A raw stack's "clone" is the
     * `raw` strategy's `rm -rf` + base64 write of the converted file, which is
     * exactly the destructive write an earlier fix re-ordered — and it names
     * the code directory `deployCompose` computed.
     */
    it('writes the project tree under the stack’s own Server’s root', async () => {
      const { stack, stackServerId } = await setUp();

      await deploy(stack.composeId);

      const tree = `${composeRootOn(stackServerId)}/shop-stack/code`;
      const onServer = dispatched();
      expect(onServer.length).toBeGreaterThan(0);
      // One machine, not two: `findCompose` hard-codes `buildServerId: null`.
      expect(new Set(onServer.map(({ serverId }) => serverId))).toEqual(
        new Set([stackServerId]),
      );
      expect(commandsMatching(tree).length).toBeGreaterThan(0);
      // Not one word of this instance's own layout reaches a machine that has
      // never heard of it.
      for (const { command } of onServer) {
        expect(command).not.toContain(configuredRoot);
      }
    });

    /**
     * The tree's *second* writer, and the one that is also half of a question
     * this ticket deliberately left alone. `MountsService.baseFilesPath` roots a
     * compose file mount here and an Application's under
     * `applicationsDirectory()` — the local spelling — because an Application's
     * `files` directory is a Swarm bind-mount **source** resolved by the run
     * Server's daemon, a third machine answer neither helper gives. A stack's is
     * not: the daemon that resolves it is the daemon on the machine the file was
     * written to, so the write and the mount agree by construction.
     */
    it('writes a stack’s file mount under the same Server’s root', async () => {
      const { ownerCtx, stack, stackServerId } = await setUp();

      await mounts.create(ownerCtx, {
        serviceType: 'compose',
        serviceId: stack.composeId,
        type: 'file',
        filePath: 'nginx.conf',
        content: 'worker_processes 1;\n',
      });

      const writes = commandsMatching(
        `${composeRootOn(stackServerId)}/shop-stack/files`,
      );
      expect(writes.map(({ serverId }) => serverId)).toEqual([stackServerId]);
      expect(
        dispatched().every(({ command }) => !command.includes(configuredRoot)),
      ).toBe(true);
    });
  });

  describe('the readers', () => {
    /**
     * `start` is the whole of the reading half in one route: `composeStartCommand`
     * `cd`s into the code directory and `getComposeFilePath` names the file it
     * may rewrite. A `cd` under the local root on a Server fails, and `up -d`
     * then reports a stack that was never brought back.
     */
    it('starts the stack from the directory the deploy wrote', async () => {
      const { ownerCtx, stack, stackServerId } = await setUp();
      await deploy(stack.composeId);
      const tree = `${composeRootOn(stackServerId)}/shop-stack/code`;
      expect(commandsMatching(tree).length).toBeGreaterThan(0);

      execMock.execAsyncRemote.mockClear();
      await composeService.start(ownerCtx, stack.composeId);

      const ups = commandsMatching('up -d');
      expect(ups.map(({ serverId }) => serverId)).toEqual([stackServerId]);
      expect(ups[0].command).toContain(`cd ${tree}`);
      expect(ups[0].command).not.toContain(configuredRoot);
    });

    it('stops the stack in the project directory on its own Server', async () => {
      const { ownerCtx, stack, stackServerId } = await setUp();

      await composeService.stop(ownerCtx, stack.composeId);

      const stops = commandsMatching('docker compose -p shop-stack stop');
      expect(stops.map(({ serverId }) => serverId)).toEqual([stackServerId]);
      expect(stops[0].command).toContain(
        `cd ${composeRootOn(stackServerId)}/shop-stack `,
      );
      expect(stops[0].command).not.toContain(configuredRoot);
    });

    /**
     * Remove containers is the one reader that also carries a **lock** path and
     * the two are rooted by two helpers — so a stack whose project directory
     * resolved on the machine while its lock resolved here would take a lock
     * nothing else takes. With no turn-off backup rows there is no preamble at
     * all, which is the volume lock's own promise, so this asserts the project
     * directory and `volume-lock.spec.ts` asserts the lock.
     */
    it('removes containers from the project directory on its own Server', async () => {
      const { ownerCtx, stack, stackServerId } = await setUp();

      await composeService.removeContainers(ownerCtx, stack.composeId);

      const removals = commandsMatching('rm --stop --force');
      expect(removals.map(({ serverId }) => serverId)).toEqual([stackServerId]);
      expect(removals[0].command).toContain(
        `cd ${composeRootOn(stackServerId)}/shop-stack `,
      );
      expect(removals[0].command).not.toContain(configuredRoot);
    });
  });

  describe('the destroyers', () => {
    /**
     * **The decisive assertion of this set**: the teardown's `rm -rf` names the
     * directory the deploy wrote. The expectation is derived from
     * `deployCompose`'s own dispatch, so it cannot restate this file's opinion
     * about where the tree is — a root that forks between writer and destroyer
     * fails here whichever of the two is wrong.
     */
    it('destroys the project tree the deploy wrote, on the machine it wrote it on', async () => {
      const { ownerCtx, stack, stackServerId } = await setUp();
      await deploy(stack.composeId);
      const projectDirectory = `${composeRootOn(stackServerId)}/shop-stack`;
      expect(
        commandsMatching(`${projectDirectory}/code`).length,
      ).toBeGreaterThan(0);

      execMock.execAsyncRemote.mockClear();
      await composeService.remove(ownerCtx, stack.composeId);

      expect(treeRemovals(projectDirectory)).toEqual([
        { serverId: stackServerId, command: `rm -rf ${projectDirectory}` },
      ]);
      expect(commandsMatching(`rm -rf ${configuredRoot}`)).toEqual([]);
    });

    // Deleting a Project is one click and deleting eleven Services is
    // eleven, so the bulk path must resolve what the per-Service path does.
    it('destroys each stack’s tree under its own Server’s root when a Project is deleted', async () => {
      const { ownerCtx, project, stackServerId } = await setUp();

      await projects.remove(ownerCtx, project.projectId);

      const projectDirectory = `${composeRootOn(stackServerId)}/shop-stack`;
      expect(treeRemovals(projectDirectory)).toEqual([
        { serverId: stackServerId, command: `rm -rf ${projectDirectory}` },
      ]);
      expect(commandsMatching(`rm -rf ${configuredRoot}`)).toEqual([]);
    });

    /**
     * A 409 leaves the project tree intact. The tree holds the stack's
     * file mounts and its Trace store's data beside its clone, and the
     * teardown program used to end by `rm -rf`ing it *ahead of* the presence
     * refusal — so a Delete answering *"the Compose was kept"* had already
     * erased both.
     */
    describe('when the delete is refused', () => {
      /** The stack survives its teardown, so every presence read answers
       * `present` and the delete 409s. */
      const workloadSurvives = () =>
        execMock.execAsyncRemote.mockImplementation(
          (_serverId: string, command: string) =>
            isPresenceProbe(command)
              ? Promise.resolve({ ...ok, stdout: 'present' })
              : answers(command),
        );

      it('leaves the Compose’s project tree, its files and its traces intact', async () => {
        const { ownerCtx, stack, stackServerId } = await setUp();
        workloadSurvives();

        await expect(
          composeService.remove(ownerCtx, stack.composeId, false, false),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(commandsMatching('rm -rf')).toEqual([]);
        // The stack was still taken down, which is what the 409 is about.
        expect(commandsMatching('docker stack rm')).toEqual([
          expect.objectContaining({ serverId: stackServerId }),
        ]);
      });

      it('leaves a compose child’s tree intact when a Project delete is refused', async () => {
        const { ownerCtx, project } = await setUp();
        workloadSurvives();

        await expect(
          projects.remove(ownerCtx, project.projectId),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(commandsMatching('rm -rf')).toEqual([]);
      });

      it('still removes the tree when the delete is forced', async () => {
        const { ownerCtx, stack, stackServerId } = await setUp();
        workloadSurvives();

        await composeService.remove(ownerCtx, stack.composeId, false, true);

        const projectDirectory = `${composeRootOn(stackServerId)}/shop-stack`;
        expect(treeRemovals(projectDirectory)).toEqual([
          { serverId: stackServerId, command: `rm -rf ${projectDirectory}` },
        ]);
      });

      it('names the tree it could not remove', async () => {
        const { ownerCtx, stack, stackServerId } = await setUp();
        const projectDirectory = `${composeRootOn(stackServerId)}/shop-stack`;
        execMock.execAsyncRemote.mockImplementation(
          (_serverId: string, command: string) =>
            command === `rm -rf ${projectDirectory}`
              ? Promise.reject(new Error('ssh: connect: no route to host'))
              : answers(command),
        );

        const removed = await composeService.remove(ownerCtx, stack.composeId);

        expect(removed.unreclaimedArtifacts).toEqual([
          {
            kind: 'compose-directory',
            appName: 'shop-stack',
            serverId: stackServerId,
            path: projectDirectory,
          },
        ]);
      });
    });

    it('removes a file mount under the root it was written to', async () => {
      const { ownerCtx, stack, stackServerId } = await setUp();
      const created = await mounts.create(ownerCtx, {
        serviceType: 'compose',
        serviceId: stack.composeId,
        type: 'file',
        filePath: 'nginx.conf',
        content: 'worker_processes 1;\n',
      });
      const filesDirectory = `${composeRootOn(stackServerId)}/shop-stack/files`;
      expect(commandsMatching(filesDirectory).length).toBeGreaterThan(0);

      execMock.execAsyncRemote.mockClear();
      await mounts.remove(ownerCtx, created.mountId);

      expect(commandsMatching(`${filesDirectory}/nginx.conf`)).toEqual([
        {
          serverId: stackServerId,
          command: `rm -rf ${filesDirectory}/nginx.conf`,
        },
      ]);
    });
  });

  /**
   * The branch that has to keep working, and the whole reason
   * `CLOUDGATE_DIRECTORY` exists: a stack on the platform host is deployed
   * and destroyed where *this process* can write — *"the alternative is a
   * backend that only runs where its own user can write to /etc"*.
   */
  describe('the platform host', () => {
    it('writes and destroys a platform-host stack under this instance’s configured root', async () => {
      const { ownerCtx, stack } = await setUp('local-stack', {
        onServer: false,
      });

      await deploy(stack.composeId);
      const projectDirectory = `${configuredRoot}/compose/local-stack`;
      expect(
        commandsMatching(`${projectDirectory}/code`).map(
          ({ serverId }) => serverId,
        ),
      ).not.toHaveLength(0);

      await composeService.remove(ownerCtx, stack.composeId);

      expect(treeRemovals(projectDirectory)).toEqual([
        { serverId: null, command: `rm -rf ${projectDirectory}` },
      ]);
      expect(
        commandsMatching(`rm -rf ${REMOTE_CLOUDGATE_DIRECTORY}/compose`),
      ).toEqual([]);
    });
  });
});
