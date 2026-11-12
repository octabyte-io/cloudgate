import { ConflictException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { server as serverTable } from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { previewDeployment } from '../../src/preview-deployments/preview-deployment.schema';
import { ProjectsService } from '../../src/projects/projects.service';
import { registry as registryTable } from '../../src/registries/registry.schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  dynamicTraefikConfigPath,
  TraefikWriterService,
} from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * Which **machine** a Delete aims each teardown at, and which artifacts it aims
 * at all.
 *
 * ADR-0016 settled that the delete which destroys a row is the only place where
 * the artifact, the machine that holds it and the entitlement to that machine
 * are all known at once. It named two things it deliberately did not reclaim
 * and left as their own tickets: *"the source tree under `applicationsDirectory()`
 * when the build ran on a different machine from the removal"*, and it said
 * nothing at all about preview deployments. Both are this file.
 *
 * Three defects, one mechanism — **work aimed at the wrong Server, or not aimed
 * at all**:
 *
 * 1. `DeploymentEngineService` clones into
 *    `{applicationsDirectory()}/{appName}/code` on `buildServerId || serverId`,
 *    while `ApplicationsService.remove` and `common/service-cascade.ts` ran
 *    their `rm -rf` on `serverId`. On a build-Server install the removal ran on
 *    a machine that never had the directory, exited non-zero, and was swallowed
 *    by the best-effort `catch` — so the build tree survived every delete.
 * 2. Neither delete path named a preview's `appName` at all, so
 *    `preview_deployment` rows cascaded in the database while each preview's
 *    Swarm service kept running. Per ADR-0008 a container that resolves to no
 *    Service is *unmanaged* and is reachable through machine-level
 *    `docker:read`, which is the cascade finding, and the same in bulk.
 * 3. `PreviewDeploymentsService.teardown` took one `serverId` — the run Server
 *    — for both of its steps, while `deployPreview` spreads the parent's
 *    `buildServerId` into `engine.deploy`. Same mechanism as (1), one table
 *    along — but **latent**, not live: see the note on the preview block below.
 *
 * And one omission of a different kind, which was found while settling the
 * first three: the `rm -rf` is a teardown step the presence read cannot see, so
 * a failure of it was caught, discarded and reported nowhere, and the delete
 * answered a clean 200 having leaked a directory it knew about. *"a source tree
 * the delete could not remove"* below is that.
 *
 * This closes the two artifacts left behind earlier: the **Traefik dynamic
 * config**, which has the identical unreported-failure shape and whose failure
 * leaves a public hostname advertised at a backend that is gone; and the
 * **patch-repo clone**, which was aimed at the wrong machine by one route and
 * reclaimed by no delete at all. The last two blocks here are those.
 *
 * **Every assertion here names the host.** A wrong-machine defect is invisible
 * to a test that asserts only the words of the command: both the broken and the
 * fixed code issue `rm -rf /etc/cloudgate/applications/web-app`, and they differ
 * only in who is asked. So the exec double is bucketed by `serverId` and each
 * test states which bucket the command belongs in *and* that the other bucket
 * is empty — a mutation reverting either call site to `current.serverId` reds
 * these.
 *
 * The "created here" half is taken from the engine rather than restated: the
 * source-tree tests deploy for real through `DeploymentEngineService` and read
 * the clone's own dispatch, so the expectation for where the tree *is* comes
 * from the code that made it and not from this file's opinion.
 *
 * Doubles are the exec layer, the Docker daemon and the Traefik writer, all
 * boundaries (§1.7).
 */
describe('Which machine an Application delete reclaims from (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let engine: DeploymentEngineService;
  let deployments: DeploymentsService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
  });

  /**
   * `absent` for a presence probe and `ok` for everything else — an empty
   * stdout reads as `'unknown'` and would 409, which is
   * `preserved-image-reclamation.e2e-spec.ts`'s note one directory over.
   */
  const teardownSucceeds = (command: string) =>
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
    Status: { State: 'running', Timestamp: `2026-09-07T00:00:0${n}Z` },
  }));
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };

  beforeAll(async () => {
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
    engine = ctx.app.get(DeploymentEngineService);
    deployments = ctx.app.get(DeploymentsService);
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

  async function signUp(body: {
    name: string;
    email: string;
    password: string;
  }) {
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(body);
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
   * An owner, a Project, an Environment, two Servers and a git-sourced
   * Application that runs on one and builds on the other.
   *
   * A Registry is linked because `assertBuiltImageReachesRunServer` refuses a
   * dedicated build Server without one before the first shell step, so
   * without it no clone would be dispatched and the "created here" half of
   * every source-tree test would have nothing to read.
   *
   * `sourceType: 'git'` rather than `'docker'`: a docker-sourced Application
   * builds nothing and `dockerStrategy.clone` ignores the code directory
   * entirely, so it never creates a source tree on any machine.
   */
  async function setUp(
    appName = 'web-app',
    options: { dedicatedBuildServer?: boolean } = {},
  ) {
    const { dedicatedBuildServer = true } = options;
    const session = await signUp({
      name: 'Grace Hopper',
      email: `grace+${appName}@example.com`,
      password: 'super-secret-password',
    });
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
      session,
      organizationId,
      ownerCtx,
      project,
      environment,
      application,
      runServerId,
      buildServerId,
    };
  }

  /** Deploys through the real engine, as the queue processor would. */
  async function deploy(applicationId: string) {
    await engine.deploy(await applications.findDeployable(applicationId));
  }

  /** Every command the exec layer was asked for, with the machine it was
   * asked of — `null` being the platform host (ADR-0008). */
  function dispatched(): { serverId: string | null; command: string }[] {
    return [
      ...execMock.execAsync.mock.calls.map(([command]) => ({
        serverId: null,
        command,
      })),
      ...execMock.execAsyncRemote.mock.calls.map(([serverId, command]) => ({
        serverId,
        command,
      })),
    ];
  }

  /** Which machines were asked to `rm -rf` which directory. */
  const directoryRemovals = () =>
    dispatched().filter(({ command }) => command.startsWith('rm -rf '));

  /**
   * The trees a delete removes, split by root, because a delete now removes
   * three per Application and each is asserted as a whole array.
   *
   * Two of them are `rm -rf` on the build host under `{CLOUDGATE_DIRECTORY}/…`,
   * so a single "which directories were removed" list cannot say which artifact
   * an entry is — which is the same problem the response field has and the
   * reason `UnreclaimedArtifact` carries a `kind`.
   *
   * The source tree's filter excludes the `/files` leaf explicitly, and that
   * exclusion is the split an earlier fix forced: `{root}/applications/{appName}` and
   * `{root}/applications/{appName}/files` share a prefix and are two artifacts
   * on two machines, so a filter matching the prefix alone would have folded
   * the second into the first's whole-array expectations and hidden exactly the
   * defect this block is about.
   */
  const sourceTreeRemovals = () =>
    directoryRemovals().filter(
      ({ command }) =>
        command.startsWith('rm -rf /etc/cloudgate/applications/') &&
        !command.endsWith('/files'),
    );

  /** Which machines were asked to drop which Service's file-mounts tree. */
  const fileMountRemovals = () =>
    directoryRemovals().filter(({ command }) => command.endsWith('/files'));

  /** Which machines were asked to drop which owner's deployment logs. */
  const logRemovals = () =>
    directoryRemovals().filter(({ command }) =>
      command.startsWith('rm -rf /etc/cloudgate/logs/'),
    );

  /** Which machines were asked to drop which patch-repo clone. */
  const patchRepoRemovals = () =>
    directoryRemovals().filter(({ command }) =>
      command.startsWith('rm -rf /etc/cloudgate/patch-repos/'),
    );

  /** Which machines were asked to drop which Swarm service. */
  const serviceRemovals = () =>
    dispatched().filter(({ command }) =>
      command.startsWith('docker service rm '),
    );

  /** Which machine was asked to clone the source, and where to. */
  const clones = () =>
    dispatched().filter(({ command }) => command.includes('/code'));

  /**
   * Which machines were asked to drop which image tag, read as **argv on a
   * machine**.
   *
   * Off `execRemote`/`execFileAsync` rather than the string mocks the rest of
   * this file reads, because `quote()` escapes the tag's `:` — a `dispatched()`
   * entry says `docker image rm web-app\:latest --force` — and an expectation
   * spelling that out would be asserting `shell-quote` rather than asserting
   * which image was named to which host.
   */
  const imageRemovals = () =>
    [
      ...execMock.execFileAsync.mock.calls.map(
        ([program, args]: [string, string[]]) => ({
          serverId: null as string | null,
          argv: [program, ...args],
        }),
      ),
      ...execMock.execRemote.mock.calls.map(
        ([serverId, argv]: [string, string[]]) => ({ serverId, argv }),
      ),
    ].filter(({ argv }) => argv.slice(0, 3).join(' ') === 'docker image rm');

  /**
   * The image `DeploymentEngineService.builtImageName` named, read off the
   * deploy's **own** Push step rather than restated here.
   *
   * `built-image.ts`'s `builtImageTag` is a second expression of that dispatch —
   * a plain function, deliberately, so `applications` and `common` stay off
   * `DeploymentEngineModule` — and its docblock promised the two could not
   * drift. They could: each was pinned against its own literal and nothing tied
   * them together, which is the same defect as a docblock naming a suite that
   * cannot see the site (§1.2). So one expectation is taken from the other, the
   * way `source-tree-roots.e2e-spec.ts` takes the removal's from the clone's.
   *
   * `docker tag` is where the writing side reaches the wire: `uploadImageCommands`
   * emits `docker tag <builtImageName> <registryTag>`, and this file's `setUp`
   * links a Registry, so a deploy always composes one. The `\:` is `quote()`'s,
   * which is the transport's business rather than this assertion's — hence the
   * unescape, the same argument `imageRemovals` makes for reading argv.
   */
  const imageTheDeployNamed = () => {
    const tagged = dispatched()
      .map(({ command }) => /docker tag (\S+) /.exec(command)?.[1])
      .filter((word): word is string => word !== undefined);
    expect(tagged).toHaveLength(1);
    return tagged[0].replace(/\\(.)/g, '$1');
  };

  async function addPreview(applicationId: string, appName: string) {
    const [row] = await ctx.db
      .insert(previewDeployment)
      .values({
        applicationId,
        appName,
        branch: 'feature/thing',
        pullRequestId: `pr-${appName}`,
        pullRequestNumber: '7',
        pullRequestTitle: 'A thing',
        pullRequestURL: 'https://git.example.com/acme/web/pull/7',
        domain: `${appName}.sslip.io`,
      })
      .returning();
    return row;
  }

  /**
   * The image a build leaves behind, which no path in the product removed.
   *
   * `grep 'docker image rm\|docker rmi'` across `src` hit one file —
   * `rollbacks.service.ts` — so `${appName}:latest` accumulated one image per
   * Application on the machine chosen precisely because builds fill a disk, and
   * the only sweep was a machine-wide `docker image prune --all` an operator has
   * to think to run. Unlike the preserved rollback tag ADR-0016 is about, this
   * one has no naming row at all, so the delete is the only moment it can be
   * named.
   *
   * Every assertion here names the host, for this file's stated reason: the
   * removal is byte-identical whichever machine it goes to.
   */
  describe('the built image', () => {
    it('drops the built tag on the Server that built it, not the Server that runs it', async () => {
      const { ownerCtx, application, runServerId, buildServerId } =
        await setUp();
      await deploy(application.applicationId);

      await applications.remove(ownerCtx, application.applicationId);

      expect(imageRemovals()).toEqual([
        {
          serverId: buildServerId,
          argv: ['docker', 'image', 'rm', 'web-app:latest', '--force'],
        },
      ]);
      // And the run Server, which the workload half has always been aimed at,
      // is asked for no image it may never have held.
      expect(
        imageRemovals().filter(({ serverId }) => serverId === runServerId),
      ).toEqual([]);
    });

    it('drops the built tag on the run Server when the Application has no build Server', async () => {
      const { ownerCtx, application, runServerId } = await setUp('solo-app', {
        dedicatedBuildServer: false,
      });
      await deploy(application.applicationId);

      await applications.remove(ownerCtx, application.applicationId);

      expect(imageRemovals()).toEqual([
        {
          serverId: runServerId,
          argv: ['docker', 'image', 'rm', 'solo-app:latest', '--force'],
        },
      ]);
    });

    /**
     * The assertion the whole arm exists for.
     * `DeploymentEngineService.builtImageName` answers the operator's own
     * `dockerImage` column verbatim for a docker source, so a reclamation that
     * did not fork here would `docker image rm postgres:17` off a machine on one
     * Application's delete — an image the platform pulled rather than produced,
     * and one every other Application on that host may be running.
     */
    it('removes no image for a docker-sourced Application, whose image it never built', async () => {
      const { ownerCtx, application } = await setUp('pulled-app');
      await applications.update(ownerCtx, application.applicationId, {
        sourceType: 'docker',
        dockerImage: 'postgres:17',
      });

      await applications.remove(ownerCtx, application.applicationId);

      expect(imageRemovals()).toEqual([]);
    });

    /**
     * The two dispatches held to each other rather than to two literals
     * — see {@link imageTheDeployNamed} for why a pair of independent
     * pins was not the property `built-image.ts`' docblock claimed.
     *
     * **Measured, because a cross-assertion that nothing can red is worse than
     * the claim it replaces.** With `builtImageName`'s built arm changed to
     * `${appName}:build`, this is the **only** red in the file — the other 28
     * pass, because every one of their expectations is a `web-app:latest`
     * literal about `builtImageTag` — and `built-image.spec.ts` stays 9/9. That
     * is precisely the drift nothing caught: the engine's dispatch moving while
     * the reclamation's stays, leaving a delete naming an image the build no
     * longer produces.
     */
    it('reclaims the image the deploy itself named, not a second spelling of it', async () => {
      const { ownerCtx, application, buildServerId } = await setUp();
      await deploy(application.applicationId);

      await applications.remove(ownerCtx, application.applicationId);

      expect(imageRemovals()).toEqual([
        {
          serverId: buildServerId,
          argv: ['docker', 'image', 'rm', imageTheDeployNamed(), '--force'],
        },
      ]);
    });

    it('drops each built tag on its own build Server when a Project is deleted', async () => {
      const { ownerCtx, project, application, buildServerId } = await setUp();
      await deploy(application.applicationId);

      await projects.remove(ownerCtx, project.projectId);

      // Deleting a Project is one click and deleting eleven Services is
      // eleven, so the bulk path must aim where the per-Service path aims.
      expect(imageRemovals()).toEqual([
        {
          serverId: buildServerId,
          argv: ['docker', 'image', 'rm', 'web-app:latest', '--force'],
        },
      ]);
    });

    it('drops each built tag on its own build Server when an Environment is deleted', async () => {
      const { ownerCtx, environment, buildServerId } = await setUp();

      await environments.remove(ownerCtx, environment.environmentId);

      expect(imageRemovals()).toEqual([
        {
          serverId: buildServerId,
          argv: ['docker', 'image', 'rm', 'web-app:latest', '--force'],
        },
      ]);
    });

    /**
     * ADR-0016's ordering rule, at its sharpest artifact. This tag is the image
     * the Swarm service is *running*, so untagging it ahead of a refusal would
     * leave a live Application whose next scheduled task cannot pull its own
     * image — a recoverable 409 turned into silent breakage.
     */
    it('leaves the built image alone when the delete is refused', async () => {
      const { ownerCtx, application } = await setUp();
      await deploy(application.applicationId);
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          Promise.resolve(
            isPresenceProbe(command) ? { ...ok, stdout: 'present' } : ok,
          ),
      );

      await expect(
        applications.remove(ownerCtx, application.applicationId),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(imageRemovals()).toEqual([]);
    });

    it('names the tag it could not remove, on the build host that still holds it', async () => {
      const { ownerCtx, application, buildServerId } = await setUp();
      await deploy(application.applicationId);
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          command.includes('docker image rm')
            ? Promise.reject(
                Object.assign(new Error('Remote command failed'), {
                  stderr: 'ssh: connect to host 203.0.113.7 port 22: timed out',
                  exitCode: 255,
                }),
              )
            : teardownSucceeds(command),
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      // The Application is gone — *forget this Application* stays completable
      // on a machine that is down — and the answer says what is left and
      // where, in the same field the preserved tags use.
      expect(removed).toMatchObject({
        unreclaimedImages: [
          { serverId: buildServerId, images: ['web-app:latest'] },
        ],
      });
    });

    /**
     * #1415, through the whole delete. `docker service rm` returns while the
     * service's task container is still stopping, so the tag removal's
     * `--force` only untags: the image itself stays, dangling, until the
     * nightly prune. The daemon double answers the way Docker does then — the
     * removal prints `Untagged:` and no `Deleted:`, and the image is still
     * there under its id with no tag left — so the delete has to follow the
     * tag to the image it named and remove that too, on the same machine.
     */
    it('removes the built image itself, not only its tag, when a stopping task still held it', async () => {
      const { ownerCtx, application, buildServerId } = await setUp();
      await deploy(application.applicationId);
      const imageId = 'sha256:9f2c1e5ab7d3';
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) => {
          if (command.startsWith('docker image inspect --format ')) {
            return Promise.resolve({
              ...ok,
              stdout: command.includes('RepoTags') ? '0\n' : `${imageId}\n`,
            });
          }
          if (command.startsWith('docker image rm ')) {
            return Promise.resolve({
              ...ok,
              stdout: command.endsWith('--force')
                ? 'Untagged: web-app:latest\n'
                : `Deleted: ${imageId}\n`,
            });
          }
          return teardownSucceeds(command);
        },
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      expect(imageRemovals()).toEqual([
        {
          serverId: buildServerId,
          argv: ['docker', 'image', 'rm', 'web-app:latest', '--force'],
        },
        { serverId: buildServerId, argv: ['docker', 'image', 'rm', imageId] },
      ]);
      expect(removed).not.toHaveProperty('unreclaimedImages');
    });

    /**
     * The other side of #1415. A forced Delete past a service its presence
     * read still found running leaves that service's container running the
     * image, so a removal by id could only be refused, and waiting for it
     * would hold the Delete for the whole budget. So the tag goes and nothing
     * follows it: no id read, no removal by id, no wait.
     */
    it('only untags the built image when a forced delete leaves its service running', async () => {
      const { ownerCtx, application, runServerId } = await setUp('solo-app', {
        dedicatedBuildServer: false,
      });
      await deploy(application.applicationId);
      const imageId = 'sha256:9f2c1e5ab7d3';
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) => {
          if (isPresenceProbe(command)) {
            return Promise.resolve({ ...ok, stdout: 'present' });
          }
          if (command.startsWith('docker image inspect --format ')) {
            return Promise.resolve({
              ...ok,
              stdout: command.includes('RepoTags') ? '0\n' : `${imageId}\n`,
            });
          }
          if (
            command.startsWith('docker image rm ') &&
            !command.endsWith('--force')
          ) {
            return Promise.reject(
              Object.assign(new Error('Remote command failed'), {
                stderr: `Error response from daemon: conflict: unable to delete ${imageId} (cannot be forced) - image is being used by running container 4b1c2d`,
                exitCode: 1,
              }),
            );
          }
          if (command.startsWith('docker image rm ')) {
            return Promise.resolve({
              ...ok,
              stdout: 'Untagged: solo-app:latest\n',
            });
          }
          return Promise.resolve(ok);
        },
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
        true,
      );

      expect(imageRemovals()).toEqual([
        {
          serverId: runServerId,
          argv: ['docker', 'image', 'rm', 'solo-app:latest', '--force'],
        },
      ]);
      expect(
        dispatched().filter(({ command }) =>
          command.startsWith('docker image inspect'),
        ),
      ).toEqual([]);
      expect(removed).not.toHaveProperty('unreclaimedImages');
    });

    // A healthy delete reports nothing, and an Application that never deployed
    // is healthy: `docker image rm` exits non-zero for a tag the daemon does
    // not have, so without `imageAlreadyGone` every such Application would be
    // named as a leak by every delete.
    it('says nothing about an Application that never built an image', async () => {
      const { ownerCtx, application } = await setUp();
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          command.includes('docker image rm')
            ? Promise.reject(
                Object.assign(new Error('Remote command failed'), {
                  stderr:
                    'Error response from daemon: No such image: web-app:latest',
                  exitCode: 1,
                }),
              )
            : teardownSucceeds(command),
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      expect(removed).not.toHaveProperty('unreclaimedImages');
      expect(imageRemovals()).toHaveLength(1);
    });
  });

  describe('the source tree', () => {
    it('removes the source tree from the Server that built it, not the Server that runs it', async () => {
      const { ownerCtx, application, runServerId, buildServerId } =
        await setUp();
      await deploy(application.applicationId);
      // Where the tree is, taken from the engine that made it rather than
      // restated here.
      expect(clones()).toEqual([
        expect.objectContaining({ serverId: buildServerId }),
      ]);
      expect(clones()[0].command).toContain(
        '/etc/cloudgate/applications/web-app/code',
      );

      await applications.remove(ownerCtx, application.applicationId);

      expect(sourceTreeRemovals()).toEqual([
        {
          serverId: buildServerId,
          command: 'rm -rf /etc/cloudgate/applications/web-app',
        },
      ]);
      // The run Server is still asked for the workload — that half was never
      // wrong — and is asked for no directory it has never held.
      expect(serviceRemovals()).toEqual([
        {
          serverId: runServerId,
          command: 'docker service rm web-app',
        },
      ]);
    });

    it('removes the source tree from the run Server when the Application has no build Server', async () => {
      const { ownerCtx, application, runServerId } = await setUp('solo-app', {
        dedicatedBuildServer: false,
      });
      await deploy(application.applicationId);
      expect(clones()).toEqual([
        expect.objectContaining({ serverId: runServerId }),
      ]);

      await applications.remove(ownerCtx, application.applicationId);

      // `buildServerId` of `null` means *no dedicated build Server*, so the
      // build ran where the service runs and the fall through is the answer.
      expect(sourceTreeRemovals()).toEqual([
        {
          serverId: runServerId,
          command: 'rm -rf /etc/cloudgate/applications/solo-app',
        },
      ]);
    });

    it('removes each source tree from its own build Server when a Project is deleted', async () => {
      const { ownerCtx, project, application, runServerId, buildServerId } =
        await setUp();
      await deploy(application.applicationId);

      await projects.remove(ownerCtx, project.projectId);

      // Deleting a Project is one click and deleting eleven Services is
      // eleven, so the bulk path must aim where the per-Service path aims.
      expect(sourceTreeRemovals()).toEqual([
        {
          serverId: buildServerId,
          command: 'rm -rf /etc/cloudgate/applications/web-app',
        },
      ]);
      expect(serviceRemovals()).toEqual([
        { serverId: runServerId, command: 'docker service rm web-app' },
      ]);
    });

    it('removes each source tree from its own build Server when an Environment is deleted', async () => {
      const { ownerCtx, environment, buildServerId } = await setUp();

      await environments.remove(ownerCtx, environment.environmentId);

      expect(sourceTreeRemovals()).toEqual([
        {
          serverId: buildServerId,
          command: 'rm -rf /etc/cloudgate/applications/web-app',
        },
      ]);
    });

    /**
     * A 409 leaves the Service's whole tree. On a single-Server install
     * the build host is the run Server, so `{applications}/{appName}` holds the
     * `files` and `traces` halves as well as the clone, and an `rm -rf` ahead
     * of the refusal took the file mounts and the traces of an Application the
     * caller was then told still exists. Nothing irreversible runs before the
     * refusal, so the tree is not carved into a removable `code` and a kept
     * rest either.
     */
    describe('when the delete is refused', () => {
      /** The workload survives its teardown, so every presence read answers
       * `present` and the delete 409s. */
      const workloadSurvives = () =>
        execMock.execAsyncRemote.mockImplementation(
          (_serverId: string, command: string) =>
            Promise.resolve(
              isPresenceProbe(command) ? { ...ok, stdout: 'present' } : ok,
            ),
        );
      /** Every `rm -rf` under this Application's tree, on any machine. */
      const treeRemovals = () =>
        directoryRemovals().filter(({ command }) =>
          command.startsWith('rm -rf /etc/cloudgate/applications/solo-app'),
        );

      it('leaves the Application’s tree, its files and its traces intact', async () => {
        const { ownerCtx, application } = await setUp('solo-app', {
          dedicatedBuildServer: false,
        });
        workloadSurvives();

        await expect(
          applications.remove(ownerCtx, application.applicationId),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(treeRemovals()).toEqual([]);
      });

      it('leaves every child’s tree intact when a Project delete is refused', async () => {
        const { ownerCtx, project } = await setUp('solo-app', {
          dedicatedBuildServer: false,
        });
        workloadSurvives();

        await expect(
          projects.remove(ownerCtx, project.projectId),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(treeRemovals()).toEqual([]);
      });

      it('still removes the tree when the delete is forced', async () => {
        const { ownerCtx, application, runServerId } = await setUp('solo-app', {
          dedicatedBuildServer: false,
        });
        workloadSurvives();

        await applications.remove(ownerCtx, application.applicationId, true);

        expect(sourceTreeRemovals()).toEqual([
          {
            serverId: runServerId,
            command: 'rm -rf /etc/cloudgate/applications/solo-app',
          },
        ]);
      });
    });
  });

  /**
   * The other half of the same tree, on the other machine.
   *
   * `{root}/applications/{appName}` spans two hosts — the `code`
   * half written and reclaimed on the build host, the `files` half written and
   * bind-mounted on the **run** Server — and all three `rm -rf`s in the product
   * named the *parent* directory on the builder. `MountsService.writeFileMount`
   * dispatches to `parent.serverId`. So where the two ids differ, the removal
   * landed on a machine that had never held the `files` half and the operator's
   * own config files survived every delete; `mount.applicationId` is
   * `onDelete: 'cascade'`, and a cascade runs no commands, so the row went and
   * the file did not.
   *
   * The whole defect is *which machine*, so every assertion here names one and
   * states that the other bucket is empty — the file's own rule, and the only
   * thing that can see a mutation aiming this at `buildHostServerId(current)`,
   * since `rm -rf /etc/cloudgate/applications/web-app/files` is byte-identical
   * whichever host it reaches. Where the *root* half is held is
   * `test/mounts/file-mount-source-roots.e2e-spec.ts`, which sets
   * `CLOUDGATE_DIRECTORY` and takes the removal's expectation from the write's
   * own dispatch.
   */
  describe('the file-mounts tree', () => {
    it('removes the file-mounts tree from the Server that runs it, not the Server that built it', async () => {
      const { ownerCtx, application, runServerId, buildServerId } =
        await setUp();
      await deploy(application.applicationId);

      await applications.remove(ownerCtx, application.applicationId);

      expect(fileMountRemovals()).toEqual([
        {
          serverId: runServerId,
          command: 'rm -rf /etc/cloudgate/applications/web-app/files',
        },
      ]);
      // And the builder — which holds the `code` half and is where every one of
      // these removals used to go — is asked for nothing under `/files`.
      expect(
        fileMountRemovals().filter(
          ({ serverId }) => serverId === buildServerId,
        ),
      ).toEqual([]);
      // The `code` half still goes to the builder: this is a second removal on
      // a second machine, not the first one re-aimed.
      expect(sourceTreeRemovals()).toEqual([
        {
          serverId: buildServerId,
          command: 'rm -rf /etc/cloudgate/applications/web-app',
        },
      ]);
    });

    it('removes it on the run Server when the Application has no build Server', async () => {
      const { ownerCtx, application, runServerId } = await setUp('solo-app', {
        dedicatedBuildServer: false,
      });

      await applications.remove(ownerCtx, application.applicationId);

      // The two ids coincide here, which is the configuration that kept this
      // defect invisible — the removal is issued unconditionally so that the
      // common install exercises the step rather than a branch nothing runs.
      expect(fileMountRemovals()).toEqual([
        {
          serverId: runServerId,
          command: 'rm -rf /etc/cloudgate/applications/solo-app/files',
        },
      ]);
    });

    it('removes each file-mounts tree from its own run Server when a Project is deleted', async () => {
      const { ownerCtx, project, runServerId, buildServerId } = await setUp();

      await projects.remove(ownerCtx, project.projectId);

      // Deleting a Project is one click and deleting eleven Services is
      // eleven, so the bulk path must aim where the per-Service path aims.
      expect(fileMountRemovals()).toEqual([
        {
          serverId: runServerId,
          command: 'rm -rf /etc/cloudgate/applications/web-app/files',
        },
      ]);
      expect(
        fileMountRemovals().filter(
          ({ serverId }) => serverId === buildServerId,
        ),
      ).toEqual([]);
    });

    it('removes each file-mounts tree from its own run Server when an Environment is deleted', async () => {
      const { ownerCtx, environment, runServerId } = await setUp();

      await environments.remove(ownerCtx, environment.environmentId);

      expect(fileMountRemovals()).toEqual([
        {
          serverId: runServerId,
          command: 'rm -rf /etc/cloudgate/applications/web-app/files',
        },
      ]);
    });

    /**
     * ADR-0016's ordering rule, at the artifact where it bites hardest.
     *
     * Nothing in the product re-materializes a file mount — `writeFileMount`'s
     * only callers are `MountsService.create` and `.update`, so a deploy does
     * not — while the source tree beside it is rewritten by the next clone. So
     * this removal ahead of the refusal would leave a live Application, one the
     * caller is being told still exists, with its config files gone and no path
     * back to them short of the operator re-saving every mount by hand. That is
     * why it is a reclamation in the post-refusal slot rather than a fourth
     * entry in the teardown array beside the `rm -rf` above it.
     */
    it('leaves the file mounts alone when the delete is refused', async () => {
      const { ownerCtx, application } = await setUp();
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          Promise.resolve(
            isPresenceProbe(command) ? { ...ok, stdout: 'present' } : ok,
          ),
      );

      await expect(
        applications.remove(ownerCtx, application.applicationId),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(fileMountRemovals()).toEqual([]);
      // Nor the tree around them: on a single-Server install its
      // `rm -rf` names the parent of this very directory.
      expect(sourceTreeRemovals()).toEqual([]);
    });

    it('names the tree it could not remove, on the run Server that still holds it', async () => {
      const { ownerCtx, application, runServerId } = await setUp();
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          command.endsWith('/files')
            ? Promise.reject(new Error('ssh: connect: no route to host'))
            : teardownSucceeds(command),
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      // The Application is gone — a directory never blocks a delete — and the
      // answer names the machine and the path, which is the last moment either
      // exists: `mount.applicationId` has just cascaded.
      expect(removed).toMatchObject({
        unreclaimedArtifacts: [
          {
            kind: 'file-mounts',
            appName: 'web-app',
            serverId: runServerId,
            path: '/etc/cloudgate/applications/web-app/files',
          },
        ],
      });
    });

    it('names each tree a Project delete could not remove', async () => {
      const { ownerCtx, project, runServerId } = await setUp();
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          command.endsWith('/files')
            ? Promise.reject(new Error('permission denied'))
            : teardownSucceeds(command),
      );

      const removed = await projects.remove(ownerCtx, project.projectId);

      expect(removed).toMatchObject({
        unreclaimedArtifacts: [
          {
            kind: 'file-mounts',
            appName: 'web-app',
            serverId: runServerId,
            path: '/etc/cloudgate/applications/web-app/files',
          },
        ],
      });
    });

    it('says nothing when the tree came away', async () => {
      const { ownerCtx, application } = await setUp();

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      // `rm -rf` exits 0 for a path that is not there, so an Application that
      // never had a file mount is a healthy delete with nothing to report —
      // which is what keeps the field meaning "these were left behind".
      expect(fileMountRemovals()).toHaveLength(1);
      expect(removed).not.toHaveProperty('unreclaimedArtifacts');
    });

    /**
     * A preview gets none, and that is established rather than assumed.
     *
     * `MountsService` addresses its write by the *parent* Service's row —
     * `findParentService` resolves one of the eight service tables and a
     * preview has no row in any of them — so the only tree it ever writes is
     * `{parent.appName}/files` and there is nothing under `{preview.appName}`
     * to reclaim. `deployPreview` spreading the parent's mounts over the
     * preview's `appName` makes `mechanize.ts` name a bind *source* no writer
     * created, which is a preview whose file mounts are wrong rather than a
     * preview whose files are leaked, and is a separate fix.
     */
    it('removes no file-mounts tree for a preview, which never had one written', async () => {
      const { ownerCtx, application } = await setUp();
      const preview = await addPreview(
        application.applicationId,
        'preview-web-app-abc',
      );

      await applications.remove(ownerCtx, application.applicationId);

      expect(
        fileMountRemovals().filter(({ command }) =>
          command.includes(preview.appName),
        ),
      ).toEqual([]);
    });
  });

  /**
   * **These rows are hand-inserted, and that is load-bearing rather than a
   * shortcut.** `addPreview` writes a `previewDeployment` row directly and the
   * tests below then assert a *build-Server* placement for its source tree —
   * which is a placement `deployPreview` would refuse to create: it forces
   * `registry: null` and `buildRegistry: null`, previews exist only for
   * `sourceType: 'github'`, and `assertBuiltImageReachesRunServer`
   * therefore throws before the clone for every preview whose `buildServerId`
   * differs from its `serverId`.
   *
   * So finding 3 is **latent**: the wrong machine was never actually asked
   * about a preview's directory in production, and this block pins the
   * consistency rule rather than reproducing a live leak. Finding 2 — that no
   * delete path named a preview at all, leaving its Swarm service running on
   * the run Server — *is* live, on the default single-Server install, and is
   * what the first two tests here are about.
   */
  /**
   * The deployment logs, `{logs}/{appName}` on the machine that wrote them.
   * `DeploymentsService.initializeLog` writes on `buildHostServerId`'s
   * answer, so the removal must go there too — the file-mounts tree above is
   * the reminder that one `appName` spans two machines, and aiming this at the
   * run Server would be green on every install without a dedicated builder.
   * The writer is the product's own here, so the expectation is read off the
   * machine its bootstrap was sent to rather than restated.
   */
  describe('the deployment logs', () => {
    /** Records a Deployment through the product's writer and answers the
     * machine its log directory was created on. */
    async function writeLog(applicationId: string) {
      execMock.execAsyncRemote.mockClear();
      await deployments.create({
        kind: 'application',
        applicationId,
        title: 'Manual deployment',
        description: '',
      });
      const bootstraps = dispatched().filter(({ command }) =>
        command.startsWith('mkdir -p /etc/cloudgate/logs/'),
      );
      expect(bootstraps).toHaveLength(1);
      execMock.execAsyncRemote.mockClear();
      return bootstraps[0].serverId;
    }

    it('removes the logs from the Server that wrote them, which is the one that built, not the one that runs', async () => {
      const { ownerCtx, application, buildServerId } = await setUp();
      const writtenOn = await writeLog(application.applicationId);
      expect(writtenOn).toBe(buildServerId);

      await applications.remove(ownerCtx, application.applicationId);

      expect(logRemovals()).toEqual([
        { serverId: writtenOn, command: 'rm -rf /etc/cloudgate/logs/web-app' },
      ]);
    });

    it('removes them from the run Server when the Application has no build Server', async () => {
      const { ownerCtx, application, runServerId } = await setUp('solo-app', {
        dedicatedBuildServer: false,
      });
      const writtenOn = await writeLog(application.applicationId);
      expect(writtenOn).toBe(runServerId);

      await applications.remove(ownerCtx, application.applicationId);

      expect(logRemovals()).toEqual([
        { serverId: writtenOn, command: 'rm -rf /etc/cloudgate/logs/solo-app' },
      ]);
    });

    it('removes each Application’s logs from its own build Server when a Project is deleted', async () => {
      const { ownerCtx, project, buildServerId } = await setUp();

      await projects.remove(ownerCtx, project.projectId);

      expect(logRemovals()).toEqual([
        {
          serverId: buildServerId,
          command: 'rm -rf /etc/cloudgate/logs/web-app',
        },
      ]);
    });

    /** ADR-0016's slot: nothing regenerates a log, so a refused delete must
     * leave the build history of the Application it kept. */
    it('leaves the logs alone when the delete is refused', async () => {
      const { ownerCtx, application } = await setUp();
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          Promise.resolve(
            isPresenceProbe(command) ? { ...ok, stdout: 'present' } : ok,
          ),
      );

      await expect(
        applications.remove(ownerCtx, application.applicationId),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(logRemovals()).toEqual([]);
    });

    it('names the logs it could not remove, on the build host that still holds them', async () => {
      const { ownerCtx, application, buildServerId } = await setUp();
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          command.startsWith('rm -rf /etc/cloudgate/logs/')
            ? Promise.reject(new Error('ssh: connect: no route to host'))
            : teardownSucceeds(command),
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      expect(removed).toMatchObject({
        unreclaimedArtifacts: [
          {
            kind: 'deployment-logs',
            appName: 'web-app',
            serverId: buildServerId,
            path: '/etc/cloudgate/logs/web-app',
          },
        ],
      });
    });
  });

  describe('preview deployments', () => {
    it('drops a preview Swarm service on the run Server and its source tree on the build Server', async () => {
      const { ownerCtx, application, runServerId, buildServerId } =
        await setUp();
      const preview = await addPreview(
        application.applicationId,
        'preview-web-app-abc',
      );

      await applications.remove(ownerCtx, application.applicationId);

      // The preview's own workload and its own tree, each on the machine that
      // holds it — the parent's `appName` never named either.
      expect(serviceRemovals()).toEqual(
        expect.arrayContaining([
          {
            serverId: runServerId,
            command: `docker service rm ${preview.appName}`,
          },
        ]),
      );
      expect(directoryRemovals()).toEqual(
        expect.arrayContaining([
          {
            serverId: buildServerId,
            command: `rm -rf /etc/cloudgate/applications/${preview.appName}`,
          },
        ]),
      );
      // And nothing was asked of the run Server about a directory it never had.
      expect(directoryRemovals()).not.toContainEqual({
        serverId: runServerId,
        command: `rm -rf /etc/cloudgate/applications/${preview.appName}`,
      });
    });

    it('tears down the previews of every Application under a deleted Project', async () => {
      const { ownerCtx, project, application, runServerId } = await setUp();
      const preview = await addPreview(
        application.applicationId,
        'preview-web-app-abc',
      );

      await projects.remove(ownerCtx, project.projectId);

      expect(serviceRemovals()).toEqual(
        expect.arrayContaining([
          {
            serverId: runServerId,
            command: `docker service rm ${preview.appName}`,
          },
        ]),
      );
    });

    it('leaves the previews running when the delete is refused', async () => {
      const { ownerCtx, application } = await setUp();
      const preview = await addPreview(
        application.applicationId,
        'preview-web-app-abc',
      );
      // The Application's own workload survived its teardown, so the row is
      // kept — and tearing the previews down ahead of that refusal would have
      // destroyed the live preview environments of an Application the caller
      // was told still exists.
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          Promise.resolve(
            isPresenceProbe(command) ? { ...ok, stdout: 'present' } : ok,
          ),
      );

      await expect(
        applications.remove(ownerCtx, application.applicationId),
      ).rejects.toBeInstanceOf(ConflictException);

      // The parent's own three teardown steps ran and are meant to: they
      // precede the refusal, and a Delete that is going to be refused has
      // already tried to stop the workload it is refusing over. What must not
      // have happened is anything aimed at a *preview*.
      expect(serviceRemovals()).not.toContainEqual(
        expect.objectContaining({
          command: `docker service rm ${preview.appName}`,
        }),
      );
      expect(directoryRemovals()).not.toContainEqual(
        expect.objectContaining({
          command: `rm -rf /etc/cloudgate/applications/${preview.appName}`,
        }),
      );
    });

    it('names a preview workload it could not confirm gone rather than answering a bare 200', async () => {
      const { ownerCtx, application, runServerId } = await setUp();
      const preview = await addPreview(
        application.applicationId,
        'preview-web-app-abc',
      );
      // The parent's probe answers absent so the delete proceeds; the
      // preview's answers present, which is ADR-0008's unmanaged container
      // and the cascade rule's "say what you leave behind".
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          Promise.resolve(
            isPresenceProbe(command)
              ? {
                  ...ok,
                  stdout: command.includes(preview.appName)
                    ? 'present'
                    : 'absent',
                }
              : ok,
          ),
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      // The Application is gone — "forget this Application" must always be
      // completable — and the answer says what is still running where.
      expect(removed).toMatchObject({
        orphanedPreviews: [
          {
            appName: preview.appName,
            serverId: runServerId,
            reason: 'present',
          },
        ],
      });
    });

    it('omits the preview report entirely when every preview was confirmed gone', async () => {
      const { ownerCtx, application } = await setUp();
      await addPreview(application.applicationId, 'preview-web-app-abc');

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      // Absent rather than empty, on `cascadeDelete`'s rule for `orphaned`: a
      // bare `[]` on every healthy delete would make the field mean "this
      // route can orphan previews" instead of "these were left behind".
      expect(removed).not.toHaveProperty('orphanedPreviews');
      expect(removed).not.toHaveProperty('unreclaimedArtifacts');
    });
  });

  /**
   * The other half of "every row it destroys is asked what it left behind"
   * (ADR-0018), and the half that was not true.
   *
   * The `rm -rf` is the only step of a teardown that the presence read cannot
   * see: that read asks the **run** Server about a Swarm service, so on the
   * commonest failure here — an unreachable build Server — it answers `absent`
   * about the workload perfectly correctly and the delete proceeds. The removal
   * failed into an empty `catch`, appeared in no field of the response, and the
   * route answered a clean 200 having leaked a directory it knew it had not
   * removed, which is exactly what the cascade rule's "say what you leave behind" forbids.
   *
   * It reports rather than refuses, on `reclaimPreservedImages`' reasoning: a
   * leftover directory is disk and not ADR-0008's unmanaged container, and
   * *forget this Application* has to stay completable while a machine is down.
   */
  describe('a source tree the delete could not remove', () => {
    /** Every `rm -rf` fails — the source trees and the clone alike; everything
     * else, the presence probe included, answers as it does on a healthy
     * delete. */
    const directoryRemovalFails = () =>
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          command.startsWith('rm -rf ')
            ? Promise.reject(new Error('ssh: connect: no route to host'))
            : teardownSucceeds(command),
      );

    it('names the Application’s own tree and each preview’s, on the build host that still holds them', async () => {
      const { ownerCtx, application, runServerId, buildServerId } =
        await setUp();
      const preview = await addPreview(
        application.applicationId,
        'preview-web-app-abc',
      );
      directoryRemovalFails();

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      // The Application is gone — a directory never blocks a delete — and the
      // answer names both trees, the machine, and the path, which is the last
      // moment any of the three exists: `preview.appName` is the only name
      // either artifact had and the rows have just been destroyed.
      //
      // In the order they were attempted: the Application's own tree after its
      // file mounts, since it was moved behind the refusal.
      expect(removed).toMatchObject({
        unreclaimedArtifacts: [
          {
            kind: 'source-tree',
            appName: preview.appName,
            serverId: buildServerId,
            path: `/etc/cloudgate/applications/${preview.appName}`,
          },
          // The clone is on the same builder and is named the same way, which
          // is what the `kind` is for: two trees under two roots, and only the
          // discriminant says which of them an operator is looking at.
          {
            kind: 'patch-repo',
            appName: 'web-app',
            serverId: buildServerId,
            path: '/etc/cloudgate/patch-repos/application/web-app',
          },
          // And the `files` half of the *same* tree as the first entry, on the
          // other machine — the case that makes the `kind` load-bearing
          // rather than merely tidy: same `appName`, two Servers, and the two
          // paths differ only by a `/files` leaf an operator would otherwise
          // have to parse.
          {
            kind: 'file-mounts',
            appName: 'web-app',
            serverId: runServerId,
            path: '/etc/cloudgate/applications/web-app/files',
          },
          {
            kind: 'source-tree',
            appName: 'web-app',
            serverId: buildServerId,
            path: '/etc/cloudgate/applications/web-app',
          },
          // And the deployment logs, on the builder that wrote them.
          {
            kind: 'deployment-logs',
            appName: 'web-app',
            serverId: buildServerId,
            path: '/etc/cloudgate/logs/web-app',
          },
        ],
      });
      // And the workload half is silent, because the workload really did go.
      expect(removed).not.toHaveProperty('orphaned');
      expect(removed).not.toHaveProperty('orphanedPreviews');
    });

    it('names each tree a Project delete could not remove', async () => {
      const { ownerCtx, project, application, runServerId, buildServerId } =
        await setUp();
      await addPreview(application.applicationId, 'preview-web-app-abc');
      directoryRemovalFails();

      const removed = await projects.remove(ownerCtx, project.projectId);

      // The bulk path answers the same way the per-Service one does, which
      // is the whole reason `common/service-cascade.ts` exists.
      expect(removed).toMatchObject({
        unreclaimedArtifacts: [
          {
            kind: 'source-tree',
            appName: 'preview-web-app-abc',
            serverId: buildServerId,
            path: '/etc/cloudgate/applications/preview-web-app-abc',
          },
          {
            kind: 'patch-repo',
            appName: 'web-app',
            serverId: buildServerId,
            path: '/etc/cloudgate/patch-repos/application/web-app',
          },
          {
            kind: 'file-mounts',
            appName: 'web-app',
            serverId: runServerId,
            path: '/etc/cloudgate/applications/web-app/files',
          },
          {
            kind: 'source-tree',
            appName: 'web-app',
            serverId: buildServerId,
            path: '/etc/cloudgate/applications/web-app',
          },
          {
            kind: 'deployment-logs',
            appName: 'web-app',
            serverId: buildServerId,
            path: '/etc/cloudgate/logs/web-app',
          },
        ],
      });
    });

    it('says nothing when every tree came away', async () => {
      const { ownerCtx, project } = await setUp();

      const removed = await projects.remove(ownerCtx, project.projectId);

      // `rm -rf` exits 0 for a path that is not there, so a healthy delete has
      // nothing to report and needs no second question asked of the machine.
      expect(removed).not.toHaveProperty('unreclaimedArtifacts');
    });
  });

  /**
   * The third of a delete's three machine steps, and the one filed rather
   * than folded in (ADR-0018's open item).
   *
   * It has the source tree's exact shape — an idempotent removal that is the
   * only thing in the product removing that artifact, covered by no presence
   * read — and it differs in what a failure *costs*. A tree left on a builder
   * is disk. This is a live router fragment on the run Server: `domain.applicationId`
   * cascades, so every domain row goes with the Application while the
   * `{appName}.yml` they generated stays, and Traefik keeps advertising a
   * public hostname at a backend that no longer exists. That is the one entry
   * in the report an operator has to act on now, and the reason the field
   * carries a `kind` at all.
   *
   * The writer is a double here, as it is for every other test in this file, so
   * the failure is driven at the boundary rather than through a `rm -f` — and
   * the path the report names is read off `dynamicTraefikConfigPath`, the
   * writer's own expression, so a report claiming a file the removal never
   * attempted would fail rather than agree with itself.
   */
  describe('the Traefik dynamic config the delete could not remove', () => {
    it('names it on the run Server that still serves it, and nothing else', async () => {
      const { ownerCtx, application, runServerId } = await setUp();
      traefikWriterMock.removeConfig.mockRejectedValue(
        new Error('ssh: connect: no route to host'),
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      // The Application is gone — a file never blocks a delete, on the same two
      // reasons a directory does not — and the answer names the machine and the
      // path, which is the last moment either exists.
      expect(removed).toMatchObject({
        unreclaimedArtifacts: [
          {
            kind: 'traefik-config',
            appName: 'web-app',
            serverId: runServerId,
            path: dynamicTraefikConfigPath('web-app', runServerId),
          },
        ],
      });
      // The **run** Server, not the builder: Traefik's file provider watches the
      // machine the workload runs on, which is the one thing about this
      // artifact that was never in doubt and is asserted so a step that
      // followed the source tree onto the build host would red.
      expect(traefikWriterMock.removeConfig).toHaveBeenCalledWith(
        'web-app',
        runServerId,
      );
      // Nothing was forced and no workload survived: this is precisely the
      // clean 200 the route used to answer while leaving a hostname routed at
      // nothing.
      expect(removed).not.toHaveProperty('orphaned');
    });

    it('names it when a Project delete leaves it behind', async () => {
      const { ownerCtx, project, runServerId } = await setUp();
      traefikWriterMock.removeConfig.mockRejectedValue(
        new Error('permission denied'),
      );

      const removed = await projects.remove(ownerCtx, project.projectId);

      // The bulk path is where this matters most: one click, and every
      // hostname under the Project can be left advertised at nothing.
      expect(removed).toMatchObject({
        unreclaimedArtifacts: [
          {
            kind: 'traefik-config',
            appName: 'web-app',
            serverId: runServerId,
            path: dynamicTraefikConfigPath('web-app', runServerId),
          },
        ],
      });
    });

    it('says nothing when the config came away', async () => {
      const { ownerCtx, application } = await setUp();

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      // `rm -f` exits 0 for a file that is not there, so a healthy delete asks
      // no second question and reports nothing — which is what keeps the field
      // meaning "these were left behind".
      expect(traefikWriterMock.removeConfig).toHaveBeenCalledTimes(1);
      expect(removed).not.toHaveProperty('unreclaimedArtifacts');
    });
  });

  /**
   * The patch-repo clone (ADR-0018's non-goal list).
   *
   * `PatchRepoService.ensureRepo` clones the entity's source a second time,
   * into `{patchReposDirectory()}/application/{appName}` on the **build host**,
   * so the patch editor can list and read the files a patch will land on. It is
   * the same source as the tree next door — a private repository's contents
   * included — and **nothing reclaimed it.** The only removal in the product is
   * `cleanRepos`, which globs the whole tree on a Server an operator has to
   * name and think to run; that route's own docblock recorded the gap as a
   * reason it may not be scoped per organization: *"nothing removes a clone
   * when its Application or Compose row goes away"*. So every clone outlived
   * every delete, under an `appName` no row named any more.
   *
   * The assertions name the host for the reason the whole file exists: `rm -rf
   * /etc/cloudgate/patch-repos/application/web-app` is byte-identical whichever
   * machine it is sent to, and `ensureRepo` sends its clone to the builder.
   */
  describe('the patch-repo clone', () => {
    it('removes the clone from the build host, and asks the run Server for no clone it never held', async () => {
      const { ownerCtx, application, runServerId, buildServerId } =
        await setUp();

      await applications.remove(ownerCtx, application.applicationId);

      expect(patchRepoRemovals()).toEqual([
        {
          serverId: buildServerId,
          command: 'rm -rf /etc/cloudgate/patch-repos/application/web-app',
        },
      ]);
      expect(patchRepoRemovals()).not.toContainEqual(
        expect.objectContaining({ serverId: runServerId }),
      );
    });

    it('removes the clone from the run Server when the Application has no build Server', async () => {
      const { ownerCtx, application, runServerId } = await setUp('solo-app', {
        dedicatedBuildServer: false,
      });

      await applications.remove(ownerCtx, application.applicationId);

      // `buildHostServerId`'s fall-through: no dedicated build Server means the
      // clone was made wherever the service runs.
      expect(patchRepoRemovals()).toEqual([
        {
          serverId: runServerId,
          command: 'rm -rf /etc/cloudgate/patch-repos/application/solo-app',
        },
      ]);
    });

    it('removes each clone from its own build host when a Project is deleted', async () => {
      const { ownerCtx, project, buildServerId } = await setUp();

      await projects.remove(ownerCtx, project.projectId);

      expect(patchRepoRemovals()).toEqual([
        {
          serverId: buildServerId,
          command: 'rm -rf /etc/cloudgate/patch-repos/application/web-app',
        },
      ]);
    });

    it('leaves the clone alone when the delete is refused', async () => {
      const { ownerCtx, application } = await setUp();
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          Promise.resolve(
            isPresenceProbe(command) ? { ...ok, stdout: 'present' } : ok,
          ),
      );

      await expect(
        applications.remove(ownerCtx, application.applicationId),
      ).rejects.toBeInstanceOf(ConflictException);

      // It sits after the presence refusal on purpose: the clone is
      // `ensureRepo`'s cache, and destroying it here would take the patch
      // editor away from an Application the caller has just been told still
      // exists.
      expect(patchRepoRemovals()).toEqual([]);
    });

    it('names the clone it could not remove, on the build host that still holds it', async () => {
      const { ownerCtx, application, buildServerId } = await setUp();
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          command.startsWith('rm -rf /etc/cloudgate/patch-repos/')
            ? Promise.reject(new Error('ssh: connect: no route to host'))
            : teardownSucceeds(command),
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      // Only the clone's removal failed, so only the clone is named — the
      // source tree beside it came away and is absent from the answer, which is
      // the `kind` doing the work a second `unreclaimedDirectories` entry could
      // not.
      expect(removed).toMatchObject({
        unreclaimedArtifacts: [
          {
            kind: 'patch-repo',
            appName: 'web-app',
            serverId: buildServerId,
            path: '/etc/cloudgate/patch-repos/application/web-app',
          },
        ],
      });
    });
  });
});
