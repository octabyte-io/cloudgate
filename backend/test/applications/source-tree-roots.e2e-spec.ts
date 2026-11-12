import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';
import {
  application as applicationTable,
  server as serverTable,
} from '../../src/db/schema';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { previewDeployment } from '../../src/preview-deployments/preview-deployment.schema';
import { ProjectsService } from '../../src/projects/projects.service';
import { registry as registryTable } from '../../src/registries/registry.schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * Which **root** each of the five call sites the root change converted resolves — the
 * clone and the three destroyers here, `uploadDrop` next door in
 * `applications-drop.e2e-spec.ts` for the reason given below — and why this
 * file has to set `CLOUDGATE_DIRECTORY` to prove anything at all (the
 * root audit's item 3, whose atomic half this is). There is a sixth call site, and
 * this file cannot see it; that is stated at the end rather than left implied.
 *
 * `applicationsDirectory()` is `localCloudgateDirectory()`, i.e. *this
 * process's* root, and all five sites resolved it for every machine alike —
 * including a Server the build was dispatched to, whose tree
 * `serverSetupCommand` laid out at `REMOTE_CLOUDGATE_DIRECTORY`.
 * `cloudgate-directory.ts` states the rule the other way round in as many
 * words: *"every path baked into a command sent over SSH … has to be that
 * literal, whatever this instance's own layout is"*. So on an install with
 * `CLOUDGATE_DIRECTORY` set, a dispatched build wrote to a root that did not
 * exist on the builder.
 *
 * **Why nothing broke, and why nothing would have caught it.** With the
 * variable unset the two roots are the *same literal*, so every one of these
 * sites was self-consistent and every assertion in this file would pass however
 * the roots were resolved. The root audit's sharpest single measurement is the template:
 * aiming the log-retention sweep at the local root for every machine reds one
 * e2e test with the variable set and **zero** with it unset. So the variable is
 * set here, and every expectation names the *resolved* temp path, because
 * `/etc/cloudgate` exists and is writable on some development hosts and a
 * silent fall back to the default would otherwise read as a pass.
 *
 * **And why the conversion had to be all five at once.** ADR-0018's rule is
 * that whoever creates an artifact and whoever destroys it must answer *which
 * machine* the same way; stated for roots it is the same rule. Converting the
 * Deletes while `DeploymentEngineService`'s `codeDirectory` stayed local would
 * have written the tree under one root and `rm -rf`'d it from the other —
 * moving the leak rather than closing it, which is exactly what ADR-0018
 * records `uploadDrop` doing for the machine half of the same question. So the
 * decisive test here is not any single path's words but *"the removal names the
 * directory the clone wrote"*, taken from the engine's own dispatch rather than
 * from this file's opinion.
 *
 * The machine half was settled earlier and is asserted alongside, because
 * the two mistakes are independent: a site can ask the right Server under the
 * wrong root, which is precisely the state this ticket found.
 *
 * **What this file cannot see, said here because `deployment-engine.paths.ts`
 * claimed the opposite**. Its docblock read *"a sixth call site
 * resolving the root differently fails there"*, meaning here; a later fix then found
 * the sixth — `PatchService.generateApplyPatchesCommand`'s application arm, a
 * second **writer** into this tree that no Delete names — and measured this
 * suite **8/8 green with it reverted**. The limit is structural rather than an
 * oversight: what a test can read is what the programs it drives put on the
 * exec double, this one drives a deploy and a delete, and a site reached only
 * by some other program emits nothing at all. So this file holds the five it
 * was written for and does not close the class; the census that does is
 * `test/coding-standards/platform-root-call-sites.spec.ts`, which enumerates
 * every expression in `src/` resolving the root *without* a machine and makes
 * each say why — because the root change's enumeration was built from the paths a Delete
 * names, and the writer it missed is exactly what that misses.
 *
 * Doubles are the exec layer, the Docker daemon and the Traefik writer, all
 * boundaries (§1.7).
 */
describe('The root an Application source tree is written and removed under (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let engine: DeploymentEngineService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
  });

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
    Status: { State: 'running', Timestamp: `2026-09-08T00:00:0${n}Z` },
  }));
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };
  const queueMock = { add: jest.fn(), getJobs: jest.fn(), cancel: jest.fn() };

  /** A real temp directory, so the two roots are genuinely two strings. */
  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-tree-root-')),
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
   * A git-sourced Application that runs on one Server and builds on another.
   *
   * A Registry is linked because `assertBuiltImageReachesRunServer` refuses a
   * dedicated build Server without one before the first shell step, so
   * without it no clone would be dispatched at all — which is also what makes
   * this configuration reachable rather than hypothetical.
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

  async function deploy(applicationId: string) {
    await engine.deploy(await applications.findDeployable(applicationId));
  }

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

  /** The `{root}/applications` a machine's own tree is rooted at. */
  const applicationsRootOn = (serverId: string | null) =>
    serverId
      ? `${REMOTE_CLOUDGATE_DIRECTORY}/applications`
      : `${configuredRoot}/applications`;

  /** Where the clone was dispatched, and to which directory — the expectation
   * every removal below is measured against, read off the code that made the
   * artifact rather than restated here. */
  const clones = () =>
    dispatched().filter(({ command }) => command.includes('/code'));

  /**
   * Only the source trees. A delete now sends three `rm -rf`s per Application —
   * the source tree, the patch-repo clone and the file-mounts tree — so a bare
   * `rm -rf` filter would mix them, which is the same problem the response
   * field has and the reason `UnreclaimedArtifact` carries a `kind`.
   *
   * The third one is the reason the root alone is no longer enough to tell them
   * apart: `{root}/applications/{appName}/files` sits under the very
   * root this filter matches, on the **run** Server rather than the build host,
   * so the `/files` leaf is excluded explicitly. Which machine that one goes to
   * is `test/applications/application-delete-machines.e2e-spec.ts`; this file
   * answers only for roots.
   */
  const sourceTreeRemovals = () =>
    dispatched().filter(
      ({ command, serverId }) =>
        command.startsWith('rm -rf ') &&
        command.includes(`${applicationsRootOn(serverId)}/`) &&
        !command.endsWith('/files'),
    );

  describe('the writer', () => {
    it('clones under the build Server’s own root, never under this instance’s', async () => {
      const { application, buildServerId } = await setUp();

      await deploy(application.applicationId);

      expect(clones().map(({ serverId }) => serverId)).toEqual([buildServerId]);
      expect(clones()[0].command).toContain(
        `${applicationsRootOn(buildServerId)}/web-app/code`,
      );
      expect(clones()[0].command).not.toContain(configuredRoot);
    });

    /**
     * `uploadDrop` is the **second writer** — it unpacks the operator's archive
     * into the same `{appName}/code` the clone writes, so it has to answer both
     * questions the same way, and ADR-0018 records this exact call site getting
     * the *machine* half wrong for the same reason. Its root is asserted in
     * `applications-drop.e2e-spec.ts` instead of here, because that file already
     * owns the byte-level zip writer a drop upload needs and a third copy of it
     * would be worse than the split (§1.4).
     */

    // The branch that has to keep working: a build in this process writes where
    // this process can write, which is the whole reason CLOUDGATE_DIRECTORY
    // exists.
    it('clones under this instance’s configured root when the build runs here', async () => {
      const { application } = await setUp('local-app', {
        dedicatedBuildServer: false,
      });
      // Straight on the row: `updateApplicationSchema` does not admit
      // `serverId`, and what this test needs is the platform-host shape rather
      // than a route that reaches it.
      await ctx.db
        .update(applicationTable)
        .set({ serverId: null })
        .where(eq(applicationTable.applicationId, application.applicationId));

      await deploy(application.applicationId);

      expect(clones().map(({ serverId }) => serverId)).toEqual([null]);
      expect(clones()[0].command).toContain(
        `${configuredRoot}/applications/local-app/code`,
      );
      expect(clones()[0].command).not.toContain(
        `${REMOTE_CLOUDGATE_DIRECTORY}/applications`,
      );
    });
  });

  describe('the removals', () => {
    /**
     * The decisive assertion of the whole ticket: the removal names the
     * directory the clone wrote. The expectation is derived from the engine's
     * own dispatch, so it cannot restate this file's opinion about where the
     * tree is — a root that forks between writer and destroyer fails here
     * whichever of the two is wrong.
     */
    it('removes the tree the clone wrote, on the machine the clone wrote it on', async () => {
      const { ownerCtx, application, buildServerId } = await setUp();
      await deploy(application.applicationId);
      const cloned = clones()[0];
      const codeDirectory = `${applicationsRootOn(buildServerId)}/web-app/code`;
      expect(cloned.command).toContain(codeDirectory);

      await applications.remove(ownerCtx, application.applicationId);

      expect(sourceTreeRemovals()).toEqual([
        {
          serverId: cloned.serverId,
          // The parent of the `code` tree, which is what a Delete removes.
          command: `rm -rf ${codeDirectory.replace(/\/code$/, '')}`,
        },
      ]);
    });

    it('removes each tree under the build Server’s own root when a Project is deleted', async () => {
      const { ownerCtx, project, application, buildServerId } = await setUp();
      await deploy(application.applicationId);

      await projects.remove(ownerCtx, project.projectId);

      // Deleting a Project is one click and deleting eleven Services is
      // eleven, so the bulk path must resolve what the per-Service path does.
      expect(sourceTreeRemovals()).toEqual([
        {
          serverId: buildServerId,
          command: `rm -rf ${applicationsRootOn(buildServerId)}/web-app`,
        },
      ]);
    });

    it('removes each tree under the build Server’s own root when an Environment is deleted', async () => {
      const { ownerCtx, environment, buildServerId } = await setUp();

      await environments.remove(ownerCtx, environment.environmentId);

      expect(sourceTreeRemovals()).toEqual([
        {
          serverId: buildServerId,
          command: `rm -rf ${applicationsRootOn(buildServerId)}/web-app`,
        },
      ]);
    });

    /**
     * A preview's tree sits beside its parent's under the same root on the same
     * machine (`preview-teardown.ts`'s `previewCodeDirectory`), so the fifth
     * call site answers both questions with the parent's pair.
     */
    it('removes a preview’s tree under the build Server’s own root', async () => {
      const { ownerCtx, application, buildServerId } = await setUp();
      await addPreview(application.applicationId, 'preview-web-app-abc');

      await applications.remove(ownerCtx, application.applicationId);

      expect(sourceTreeRemovals()).toEqual(
        expect.arrayContaining([
          {
            serverId: buildServerId,
            command: `rm -rf ${applicationsRootOn(buildServerId)}/preview-web-app-abc`,
          },
        ]),
      );
      for (const { command } of sourceTreeRemovals()) {
        expect(command).not.toContain(configuredRoot);
      }
    });

    // The platform-host branch of the removals, which is the default install
    // and the one that must keep pointing at this instance's own tree.
    it('removes the tree under this instance’s configured root when the build ran here', async () => {
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

      await applications.remove(ownerCtx, application.applicationId);

      expect(sourceTreeRemovals()).toEqual([
        {
          serverId: null,
          command: `rm -rf ${configuredRoot}/applications/local-app`,
        },
      ]);
    });

    /**
     * What the report says when the build host could not be reached — the
     * `path` has to be the root the removal actually named, or an operator is
     * sent to a directory on a machine that never had one.
     */
    it('names the unreclaimed tree at the root it tried to remove it from', async () => {
      const { ownerCtx, application, buildServerId } = await setUp();
      // Only the source tree's removal, not every `rm -rf` on that host: the
      // patch-repo clone's is the other one, and its own root is a sibling
      // defect filed separately rather than this ticket's to assert.
      execMock.execAsyncRemote.mockImplementation(
        (serverId: string, command: string) =>
          serverId === buildServerId &&
          command.startsWith(`rm -rf ${applicationsRootOn(buildServerId)}/`)
            ? Promise.reject(new Error('ssh: connect to host: timed out'))
            : teardownSucceeds(command),
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      expect(removed).toMatchObject({
        unreclaimedArtifacts: [
          {
            kind: 'source-tree',
            appName: 'web-app',
            serverId: buildServerId,
            path: `${applicationsRootOn(buildServerId)}/web-app`,
          },
        ],
      });
      // And the path an operator is sent to is on the machine that was asked,
      // never this instance's own layout.
      expect(
        JSON.stringify(
          (removed as { unreclaimedArtifacts: unknown[] })
            .unreclaimedArtifacts[0],
        ),
      ).not.toContain(configuredRoot);
    });
  });
});
