import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { z } from 'zod';
import { ApplicationsService } from '../../src/applications/applications.service';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import {
  application as applicationTable,
  previewDeployment as previewDeploymentTable,
  server as serverTable,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { createMountSchema } from '../../src/mounts/dto/mount.dto';
import { MountsService } from '../../src/mounts/mounts.service';
import { PreviewDeploymentsService } from '../../src/preview-deployments/preview-deployments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { registry as registryTable } from '../../src/registries/registry.schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * Which **root** a file mount's bind *source* is resolved under, on both sides
 * of the pair that has to agree: the write that materializes the file, and the
 * Swarm spec whose `Mounts[].Source` a daemon then resolves (the third
 * and last machine answer `deployment-engine.paths.ts` was asked for, after
 * the source tree and the four trees before it).
 *
 * **The question this file answers, because the ticket deferred it as a third
 * one.** `deployment-engine.paths.ts` kept `applicationsDirectory()` — the
 * *local* root, for every machine alike — as "the mount source spelling", on
 * the argument that a bind source is resolved by neither this process nor the
 * build host and therefore by neither answer `cloudgateDirectoryOn` gives. The
 * first half is right and the conclusion is wrong. A bind **source** is a path
 * in a *host* filesystem, so the machine that answers it is the machine whose
 * daemon resolves it — the **run** Server, `application.serverId`, which is one
 * of `cloudgateDirectoryOn`'s two answers reached with a different id, not a
 * third root. What genuinely does not fork is the bind **target**, and an earlier fix
 * settled that half one directory over: Traefik reads `accessLog.filePath`
 * *inside* its container, so it is a fixed literal on every machine. Source and
 * target are the two halves of one pair and they answer differently.
 *
 * **Why nothing was broken, which is why this file sets the variable.** The
 * writer (`MountsService.baseFilesPath`'s application arm) and the two
 * consumers (`mechanize.ts`'s `buildServiceSettings` and
 * `databases/common/database-spec.ts`, both through `generateFileMounts`) all
 * spelled the *same* local root, so they agreed — and with
 * `CLOUDGATE_DIRECTORY` unset the two roots are the same literal, so every
 * assertion in `test/mounts/mounts.e2e-spec.ts` passes whichever root resolves.
 * That is the invisibility measured at 59 pre-existing tests, then at 262
 * and 256, and at 448. So the variable is set here and every expectation
 * names the *resolved* temp path: `/etc/cloudgate` exists and is writable on
 * some development hosts, so a silent fall back to the default would read as a
 * pass.
 *
 * **What the wrong root cost, and why it was a leak rather than a failure.**
 * `getCreateFileCommand` opens with `mkdir -p`, and a bind source Docker cannot
 * find it *creates* — as a directory. So with `CLOUDGATE_DIRECTORY` set, a file
 * mount on a Service running on a Server wrote its config file into a tree
 * under a root nothing on that machine owns, the daemon resolved the same
 * string and mounted it, and the container came up correct. Nothing reclaims
 * that tree: `ApplicationsService.remove`'s `rm -rf` names
 * `{applicationsDirectoryOn(buildHostServerId)}/{appName}` on the **build
 * host**. The `unreclaimedArtifacts` shape ADR-0018 is about, one root over.
 *
 * **And why the writer and the consumers convert in one commit.** ADR-0018's
 * rule stated for roots: they agree today only because all three spell the same
 * wrong thing, so converting any one of them alone breaks a pair that currently
 * works. The decisive assertions below are therefore not any single path's
 * words but *"the spec's `Source` is the file the write created"*, taken from
 * the write's own dispatch rather than from this file's opinion — a root that
 * forks between the two reds it whichever of the two is wrong.
 *
 * The machine half is asserted alongside the root half, because the two
 * mistakes are independent (an earlier lesson, and the state the root change found): a site
 * can name the right machine under the wrong root, and a mount source is the
 * one path on this page where naming the *build host* would be the natural
 * mistake, since the tree it sits in is the build host's everywhere else.
 *
 * **Two falsifications, measured rather than argued.** Reverting only the
 * consumer half — `mechanize.ts` resolving the local root while the writer
 * resolves the run Server's — reds exactly the one test that holds the pair
 * together and nothing else, which is what that test is for. And reverting the
 * consumer to `buildServerId` instead reds **nothing**, because
 * `cloudgateDirectoryOn` reads its argument for truthiness: every Server's tree
 * is at the same literal, so two *Servers* are one root and no assertion about
 * a path can tell them apart. That mistake is only reachable at all in the one
 * configuration where exactly one of the two machines is the platform host — a
 * dedicated build Server under an Application that runs here — and what catches
 * it is the dispatch assertions below rather than any path, which is why they
 * are here and not left to `source-tree-roots`.
 *
 * Doubles are the exec layer, the Docker daemon, the Traefik writer and the
 * deployment queue, all boundaries (§1.7).
 */
describe('The root a file mount is written and bind-mounted under (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let postgres: PostgresService;
  let mounts: MountsService;
  let engine: DeploymentEngineService;
  let previews: PreviewDeploymentsService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
  });

  const succeeds = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command) ? { ...ok, stdout: 'absent' } : ok,
    );

  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
    writeCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };
  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };
  const convergedTasks = [1, 2, 3].map((n) => ({
    Status: { State: 'running', Timestamp: `2026-09-09T00:00:0${n}Z` },
  }));
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };

  /** A real temp directory, so the two roots are genuinely two strings. */
  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-mount-root-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    // Before `createTestApp`: `localCloudgateDirectory()` reads `process.env`
    // on every call, but `validateEnv` runs once at boot.
    process.env.CLOUDGATE_DIRECTORY = configuredRoot;
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    postgres = ctx.app.get(PostgresService);
    mounts = ctx.app.get(MountsService);
    engine = ctx.app.get(DeploymentEngineService);
    previews = ctx.app.get(PreviewDeploymentsService);
  });

  afterAll(async () => {
    await ctx.teardown();
    if (originalRoot === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = originalRoot;
    fs.rmSync(configuredRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset().mockImplementation(succeeds);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        succeeds(command),
      );
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.getService.mockClear();
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.listTasks.mockReset().mockResolvedValue(convergedTasks);
    dockerFactoryMock.getRemoteDocker.mockClear();
    queueMock.add.mockReset().mockResolvedValue({ id: 'job-1' });
    queueMock.getJobs.mockReset().mockResolvedValue([]);
    queueMock.cancel.mockReset().mockResolvedValue(false);
    Object.values(traefikWriterMock).forEach((mock) => mock.mockReset());
  });

  const permissionCtx = (userId: string, organizationId: string) => ({
    user: { id: userId },
    session: { activeOrganizationId: organizationId },
  });

  /** A mount from a request-shaped fixture, through the schema the pipe runs. */
  const createMount = (
    permCtx: ReturnType<typeof permissionCtx>,
    data: z.input<typeof createMountSchema>,
  ) => mounts.create(permCtx, createMountSchema.parse(data));

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

  async function addServer(organizationId: string, name: string, ip: string) {
    const [row] = await ctx.db
      .insert(serverTable)
      .values({ name, ipAddress: ip, port: 22, organizationId })
      .returning();
    return row.serverId;
  }

  /**
   * A git-sourced Application that **runs** on one Server and **builds** on
   * another — the configuration in which the two answers are two machines, and
   * the only one in which a mount source resolved for the build host would be
   * visibly wrong rather than merely mis-derived.
   *
   * A Registry is linked because `assertBuiltImageReachesRunServer` refuses a
   * dedicated build Server without one before the first shell step.
   */
  async function setUp(
    appName = 'web-app',
    options: { dedicatedBuildServer?: boolean } = {},
  ) {
    const { dedicatedBuildServer = true } = options;
    const session = await signUp(`grace+${appName}@example.com`);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', session.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(session.id, organizationId);

    const runServerId = await addServer(
      organizationId,
      'runner-us',
      '198.51.100.4',
    );
    const buildServerId = dedicatedBuildServer
      ? await addServer(organizationId, 'builder-eu', '203.0.113.7')
      : null;
    const [registryRow] = await ctx.db
      .insert(registryTable)
      .values({
        name: 'acme',
        username: 'acme',
        password: 'hunter2',
        url: 'registry.example.com',
        registryType: 'selfHosted',
        organizationId,
      })
      .returning();

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
      deployTarget: { kind: 'platform-host' },
    });
    const created = await applications.create(ownerCtx, {
      name: 'Web App',
      appName,
      environmentId: environment.environmentId,
      serverId: runServerId,
    });
    const application = await applications.update(
      ownerCtx,
      created.applicationId,
      {
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/acme/web.git',
        customGitBranch: 'main',
        registryId: registryRow.registryId,
        buildServerId,
      },
    );
    return {
      ownerCtx,
      organizationId,
      environment,
      application,
      runServerId,
      buildServerId,
    };
  }

  const deploy = async (applicationId: string) =>
    engine.deploy(await applications.findDeployable(applicationId));

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

  /**
   * Where a file-mount write actually put its file, read off the redirect
   * target of the program `getCreateFileCommand` emitted rather than restated
   * here. This is the expectation every mount source below is measured
   * against.
   */
  const writes = () =>
    dispatched()
      .filter(({ command }) => command.includes('base64 -d > "'))
      .map(({ serverId, command }) => ({
        serverId,
        path: /base64 -d > "([^"]+)"/.exec(command)?.[1],
      }));

  /**
   * The bind sources in the spec the daemon was handed. Only file mounts are
   * created below, so every bind in it is one.
   *
   * The **last** argument rather than the first: `mechanizeDockerContainer`
   * calls `createService(authconfig, settings)` for an Application with a
   * registry and `createService(settings)` for one without, and a managed
   * database never has one.
   */
  const releasedSpec = () => {
    const call = docker.createService.mock.lastCall as unknown[];
    return call[call.length - 1] as {
      Name: string;
      TaskTemplate: {
        ContainerSpec: {
          Mounts: { Type: string; Source: string; Target: string }[];
        };
      };
    };
  };

  const mountedSources = () =>
    releasedSpec().TaskTemplate.ContainerSpec.Mounts.filter(
      ({ Type }) => Type === 'bind',
    );

  describe('an Application whose run Server is not its build host', () => {
    it('writes the file under the run Server’s own root, never under this instance’s', async () => {
      const { ownerCtx, application, runServerId } = await setUp();

      await createMount(ownerCtx, {
        type: 'file',
        filePath: 'config.json',
        content: '{"debug":false}',
        mountPath: '/app/config.json',
        serviceId: application.applicationId,
      });

      expect(writes()).toEqual([
        {
          serverId: runServerId,
          path: `${REMOTE_CLOUDGATE_DIRECTORY}/applications/web-app/files/config.json`,
        },
      ]);
      expect(writes()[0].path).not.toContain(configuredRoot);
    });

    /**
     * The decisive assertion of the ticket: the bind source the daemon is
     * handed is the file the write created. The expectation is derived from the
     * write's own dispatch, so it cannot restate this file's opinion about
     * where the file is — a root that forks between the writer and the mount
     * fails here whichever of the two is wrong.
     */
    it('bind-mounts the file the write created, on the machine the write created it on', async () => {
      const { ownerCtx, application, runServerId, buildServerId } =
        await setUp();
      await createMount(ownerCtx, {
        type: 'file',
        filePath: 'config.json',
        content: '{"debug":false}',
        mountPath: '/app/config.json',
        serviceId: application.applicationId,
      });
      const [written] = writes();

      await deploy(application.applicationId);

      expect(mountedSources()).toEqual([
        { Type: 'bind', Source: written.path, Target: '/app/config.json' },
      ]);
      // The machine half, asserted beside the root half because the two
      // mistakes are independent: the spec goes to the daemon of the machine
      // the file was written to, and that machine is not the builder.
      expect(dockerFactoryMock.getRemoteDocker).toHaveBeenCalledWith(
        runServerId,
      );
      expect(written.serverId).toBe(runServerId);
      expect(written.serverId).not.toBe(buildServerId);
    });

    /**
     * ADR-0018's rule for this artifact, and the reason `MountsService` asks
     * one expression for the write and the removal: a file mount written under
     * one root and `rm -rf`'d from another is a leak moved rather than closed.
     */
    it('removes the file it wrote, from the machine it wrote it on', async () => {
      const { ownerCtx, application } = await setUp();
      const created = await createMount(ownerCtx, {
        type: 'file',
        filePath: 'config.json',
        content: '{"debug":false}',
        mountPath: '/app/config.json',
        serviceId: application.applicationId,
      });
      const [written] = writes();
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();

      await mounts.remove(ownerCtx, created.mountId);

      expect(
        dispatched().filter(({ command }) => command.startsWith('rm -rf ')),
      ).toEqual([
        { serverId: written.serverId, command: `rm -rf ${written.path}` },
      ]);
    });

    /**
     * The same rule for the *tree* rather than for one file, and the half the earlier fix
     * left open.
     *
     * `MountsService.remove` above is reached only by a caller deleting that
     * row by hand. `mount.applicationId` is `onDelete: 'cascade'`, so the
     * Application's own Delete destroys every mount row in one statement and
     * runs no command for any of them — and the only `rm -rf` it did run named
     * `{applicationsDirectoryOn(buildHostServerId)}/{appName}`, the parent of
     * both halves **on the build host**. The `files` half is on the run Server.
     * So on this configuration the operator's own config files outlived the
     * delete.
     *
     * The expectation is the *directory the write put its file in*, derived
     * from the write's own dispatch rather than restated, so a removal
     * resolving a different root reds here whichever of the two is wrong — the
     * property this file holds for the writer and the two consumers, extended
     * to the destroyer.
     */
    it('removes the tree it wrote into when the Application is deleted', async () => {
      const { ownerCtx, application } = await setUp();
      await createMount(ownerCtx, {
        type: 'file',
        filePath: 'config.json',
        content: '{"debug":false}',
        mountPath: '/app/config.json',
        serviceId: application.applicationId,
      });
      const [written] = writes();
      const writtenInto = nodePath.posix.dirname(written.path ?? '');
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();

      await applications.remove(ownerCtx, application.applicationId);

      expect(
        dispatched().filter(
          ({ command }) => command === `rm -rf ${writtenInto}`,
        ),
      ).toEqual([
        { serverId: written.serverId, command: `rm -rf ${writtenInto}` },
      ]);
      // And it is the *run* Server's root, not this instance's: the two are
      // genuinely two strings here, which is what `configuredRoot` is for.
      expect(writtenInto).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/applications/web-app/files`,
      );
      expect(writtenInto).not.toContain(configuredRoot);
    });
  });

  /**
   * The branch that has to keep working, and the one the whole
   * `CLOUDGATE_DIRECTORY` knob exists for: a workload running in this
   * process's own machine resolves this process's own root, because that is the
   * filesystem its daemon reads. A mount source that followed
   * `REMOTE_CLOUDGATE_DIRECTORY` here would name a directory a relocated
   * install does not have.
   */
  describe('an Application on the platform host', () => {
    it('writes and bind-mounts under this instance’s configured root', async () => {
      const { ownerCtx, application } = await setUp('local-app', {
        dedicatedBuildServer: false,
      });
      // Straight on the row: `updateApplicationSchema` does not admit
      // `serverId`, and what this test needs is the platform-host shape rather
      // than a route that reaches it.
      await ctx.db
        .update(applicationTable)
        .set({ serverId: null })
        .where(eq(applicationTable.applicationId, application.applicationId));
      await createMount(ownerCtx, {
        type: 'file',
        filePath: 'config.json',
        content: '{"debug":false}',
        mountPath: '/app/config.json',
        serviceId: application.applicationId,
      });

      await deploy(application.applicationId);

      const [written] = writes();
      expect(written).toEqual({
        serverId: null,
        path: `${configuredRoot}/applications/local-app/files/config.json`,
      });
      expect(mountedSources()).toEqual([
        { Type: 'bind', Source: written.path, Target: '/app/config.json' },
      ]);
      expect(written.path).not.toContain(REMOTE_CLOUDGATE_DIRECTORY);
    });
  });

  /**
   * The fourth consumer of the same string, and the one whose `appName` is not
   * the mount rows' owner.
   *
   * **What broke.** `PreviewDeploymentsService.deployPreview` spreads the
   * parent Application's row — its `mounts` included — over
   * `{ appName: preview.appName }`, and `mechanize.ts` resolved the bind source
   * as `fileMountsDirectoryOnRunServer(serverId, appName)` off that same
   * overridden column. `MountsService.writeFileMount` addresses its write by
   * `findParentService`'s row, and a preview has no row in any of the eight
   * service tables — so the spec's `Source` named
   * `.../{preview.appName}/files/config.json` while the only file on the
   * machine was under `{parent.appName}`. Docker mints a missing bind source as
   * a **directory**, so nothing failed: the preview came up with an empty
   * directory where its config file belongs.
   *
   * **Why the parent's file rather than a copy of it** (ADR-0021): the two
   * mount kinds beside this one already resolve the parent's storage verbatim —
   * `generateVolumeMounts` names `mount.volumeName` and `generateBindMounts`
   * names `mount.hostPath`, neither of which carries an `appName` — so a
   * preview has always shared them. A `file` mount is the one kind whose
   * location is *composed* out of an `appName`, which is the whole of why it
   * looked like a preview's own.
   *
   * The two assertions are the ticket's own falsifiable claim from both ends:
   * the `Source` is the file the parent's write created, taken from that
   * write's dispatch rather than restated here, and **no command in the whole
   * deploy names `{preview.appName}/files`** — which is what says the preview
   * has no file tree to leak, and keeps `previewTeardownSteps`' three steps
   * three.
   *
   * A single-Server Application, deliberately: `deployPreview` forces
   * `registry: null` and `buildRegistry: null`, so
   * `assertBuiltImageReachesRunServer` refuses a preview whose build host
   * differs from its run Server before the clone. The root halves still fork —
   * `CLOUDGATE_DIRECTORY` is set for this whole file and the Server resolves
   * `REMOTE_CLOUDGATE_DIRECTORY` — so the resolved path is named, not implied.
   */
  describe('a preview deployment of an Application that has a file mount', () => {
    it('bind-mounts the parent’s own file, under the parent’s name and not its own', async () => {
      const { ownerCtx, application, runServerId } = await setUp('web-app', {
        dedicatedBuildServer: false,
      });
      await createMount(ownerCtx, {
        type: 'file',
        filePath: 'config.json',
        content: '{"debug":false}',
        mountPath: '/app/config.json',
        serviceId: application.applicationId,
      });
      const [written] = writes();
      const [preview] = await ctx.db
        .insert(previewDeploymentTable)
        .values({
          applicationId: application.applicationId,
          branch: 'feature/health',
          pullRequestId: '990001',
          pullRequestNumber: '42',
          pullRequestTitle: 'Add health endpoint',
          pullRequestURL: 'https://github.com/example-org/shop/pull/42',
          appName: 'preview-web-app-9f3c2a',
          domain: 'preview-web-app-9f3c2a.sslip.io',
        })
        .returning();
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();

      await previews.deployPreview(preview.previewDeploymentId);

      expect(mountedSources()).toEqual([
        { Type: 'bind', Source: written.path, Target: '/app/config.json' },
      ]);
      expect(written).toEqual({
        serverId: runServerId,
        path: `${REMOTE_CLOUDGATE_DIRECTORY}/applications/web-app/files/config.json`,
      });
      // Everything the preview *does* own is still its own — the Swarm service
      // it releases is named for the preview, which is what says this is a
      // narrowing of one column's blast radius rather than a preview deploying
      // under its parent's name.
      expect(releasedSpec().Name).toBe(preview.appName);
    });

    it('dispatches no command naming a file tree of its own', async () => {
      const { ownerCtx, application } = await setUp('web-app', {
        dedicatedBuildServer: false,
      });
      await createMount(ownerCtx, {
        type: 'file',
        filePath: 'config.json',
        content: '{"debug":false}',
        mountPath: '/app/config.json',
        serviceId: application.applicationId,
      });
      const [preview] = await ctx.db
        .insert(previewDeploymentTable)
        .values({
          applicationId: application.applicationId,
          branch: 'feature/health',
          pullRequestId: '990001',
          pullRequestNumber: '42',
          pullRequestTitle: 'Add health endpoint',
          pullRequestURL: 'https://github.com/example-org/shop/pull/42',
          appName: 'preview-web-app-9f3c2a',
          domain: 'preview-web-app-9f3c2a.sslip.io',
        })
        .returning();
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();

      await previews.deployPreview(preview.previewDeploymentId);

      expect(
        dispatched().filter(({ command }) =>
          command.includes(`/${preview.appName}/files`),
        ),
      ).toEqual([]);
      expect(
        mountedSources().filter(({ Source }) =>
          Source.includes(preview.appName),
        ),
      ).toEqual([]);
    });
  });

  /**
   * The third of the triple, and the reason this ticket reaches the databases
   * module: `databases/common/database-spec.ts` names the same string for a
   * managed database, whose only machine is its run Server — a database builds
   * nothing, so there is no second answer to confuse it with.
   */
  describe('a managed database on a Server', () => {
    it('bind-mounts the init file the write created, under that Server’s root', async () => {
      const { ownerCtx, environment, runServerId } = await setUp('db-owner');
      const database = await postgres.create(ownerCtx, {
        name: 'Main DB',
        appName: 'main-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
        serverId: runServerId,
      });
      await createMount(ownerCtx, {
        type: 'file',
        filePath: 'init.sql',
        content: 'CREATE TABLE shop_items ();',
        mountPath: '/docker-entrypoint-initdb.d/init.sql',
        serviceType: 'postgres',
        serviceId: database.postgresId,
      });
      const [written] = writes();

      await postgres.deploy(ownerCtx, database.postgresId);

      expect(written).toEqual({
        serverId: runServerId,
        path: `${REMOTE_CLOUDGATE_DIRECTORY}/applications/main-db/files/init.sql`,
      });
      expect(mountedSources()).toEqual([
        {
          Type: 'bind',
          Source: written.path,
          Target: '/docker-entrypoint-initdb.d/init.sql',
        },
      ]);
    });

    /**
     * The destroyer half for a managed database, and the leak this is about
     * (an earlier fix closed the same one for an Application and deliberately left this).
     *
     * It is strictly worse than the Application's: that one needed a dedicated
     * build Server to be reachable, and this one leaks on **every** install.
     * Every database teardown in the product is `removeDatabaseService` —
     * `docker service rm` and nothing else — so there was no `rm -rf` on any
     * database delete path to be aimed at the wrong machine; the row cascaded
     * and the file stayed. What stays is `mount.content` in plaintext, which
     * ADR-0015 encrypts at rest precisely because a file body is where an
     * operator puts a credential, and once the rows are gone the leftover file
     * is the last copy in existence.
     *
     * The expectation is the directory the write put its file in, derived from
     * the write's own dispatch rather than restated — the property this file
     * holds for the writer and the two consumers, extended to the destroyer.
     */
    it('removes the tree it wrote into when the database is deleted', async () => {
      const { ownerCtx, environment, runServerId } = await setUp('db-delete');
      const database = await postgres.create(ownerCtx, {
        name: 'Main DB',
        appName: 'delete-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
        serverId: runServerId,
      });
      await createMount(ownerCtx, {
        type: 'file',
        filePath: 'init.sql',
        content: 'CREATE TABLE shop_items ();',
        mountPath: '/docker-entrypoint-initdb.d/init.sql',
        serviceType: 'postgres',
        serviceId: database.postgresId,
      });
      const [written] = writes();
      const writtenInto = nodePath.posix.dirname(written.path ?? '');
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();

      await postgres.remove(ownerCtx, database.postgresId);

      expect(
        dispatched().filter(
          ({ command }) => command === `rm -rf ${writtenInto}`,
        ),
      ).toEqual([
        { serverId: written.serverId, command: `rm -rf ${writtenInto}` },
      ]);
      // The run Server's root, not this instance's. A database has one machine
      // and no build-host fork at all, so the mistake available here is the
      // root rather than the id — which is what `configuredRoot` separates.
      expect(writtenInto).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/applications/delete-db/files`,
      );
      expect(writtenInto).not.toContain(configuredRoot);
      expect(written.serverId).toBe(runServerId);
    });

    /**
     * And the same removal on the Project cascade, in the same change, which is
     * the whole point of the fix rather than a second case of it: a rule that
     * reclaimed a database's file mounts when its **Project** was deleted and
     * not when the **database itself** was is where a rule drifts, which is
     * ADR-0018's standing argument.
     *
     * `projects.remove` reaches `cascadeDelete`, whose `fileMountOwnersOf`
     * projection is the site that had to widen; `BaseDatabaseService.remove`
     * above is the other half, and the two tests fail together or not at all.
     */
    it('removes the tree it wrote into when the Project is deleted', async () => {
      const { ownerCtx, environment, runServerId } = await setUp('db-cascade');
      const database = await postgres.create(ownerCtx, {
        name: 'Main DB',
        appName: 'cascade-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
        serverId: runServerId,
      });
      await createMount(ownerCtx, {
        type: 'file',
        filePath: 'init.sql',
        content: 'CREATE TABLE shop_items ();',
        mountPath: '/docker-entrypoint-initdb.d/init.sql',
        serviceType: 'postgres',
        serviceId: database.postgresId,
      });
      const [written] = writes();
      const writtenInto = nodePath.posix.dirname(written.path ?? '');
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();

      await projects.remove(ownerCtx, environment.projectId);

      expect(
        dispatched().filter(
          ({ command }) => command === `rm -rf ${writtenInto}`,
        ),
      ).toEqual([
        { serverId: written.serverId, command: `rm -rf ${writtenInto}` },
      ]);
      expect(writtenInto).toBe(
        `${REMOTE_CLOUDGATE_DIRECTORY}/applications/cascade-db/files`,
      );
    });
  });
});
