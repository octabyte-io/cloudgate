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
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { registry as registryTable } from '../../src/registries/registry.schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(120_000);

/**
 * Which **root** a patch-repo clone is written, read and removed under
 * (`deployment-engine.paths.ts`' first named item, ADR-0018's rule stated for
 * roots).
 *
 * `patchReposDirectory()` was `localCloudgateDirectory()` — *this process's*
 * root — and every one of the five call sites resolved it for every machine
 * alike, including a build Server whose tree `serverSetupCommand` laid out at
 * `REMOTE_CLOUDGATE_DIRECTORY`. So on an install with `CLOUDGATE_DIRECTORY`
 * set, `ensureRepo` cloned to a root that does not exist on the builder, both
 * read routes `cd`'d and `cat`'d there, and the Delete's `rm -rf` named it —
 * which is the one instance of this defect that was **captured live**: an earlier
 * run produced a delete report whose `unreclaimedArtifacts` entry named
 * `{configuredRoot}/patch-repos/application/web-app` as a directory *on a
 * remote build Server*, a path that cannot be there.
 *
 * **Why nothing broke, and why nothing would have caught it.** With
 * `CLOUDGATE_DIRECTORY` unset the two roots are the *same literal*, so all five
 * sites were self-consistent and every pre-existing assertion about them —
 * `repo-path.spec.ts`, `patch-repo-machines.e2e-spec.ts`,
 * `repo-directories.e2e-spec.ts`, `clean-repos-authority.spec.ts` — passes
 * whichever root is resolved. That is the root change's headline measurement one directory
 * along. So this file sets the variable and every expectation names the
 * *resolved* temp path, because `/etc/cloudgate` exists and is writable on some
 * development hosts and a silent fall back to the default would read as a pass.
 *
 * **And why the conversion had to be the whole set at once.** ADR-0018: whoever
 * creates an artifact and whoever destroys it must answer this the same way.
 * Unlike the source tree, the clone's writer (`ensureRepo`) and its
 * destroyers (`removePatchRepoStep` via `reclaimApplicationPatchRepos`, and
 * `cleanRepos`) are all in `patch/`, so the set is one module — but converting
 * either half alone would have cloned under one root and `rm -rf`'d another,
 * moving the leak rather than closing it. So the decisive assertion below is
 * not any single path's words but *"the removal names the directory the clone
 * wrote"*, taken from `ensureRepo`'s own dispatch rather than from this file's
 * opinion.
 *
 * The **machine** half was settled earlier and is asserted alongside, in
 * `patch-repo-machines.e2e-spec.ts`'s shape, because the two mistakes are
 * independent: a site can ask the right Server under the wrong root, which is
 * precisely the state this ticket found.
 *
 * Doubles are the exec layer and the Traefik writer, both boundaries (§1.7).
 */
describe('The root a patch-repo clone is written and removed under (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;

  const ok = { stdout: '', stderr: '', exitCode: 0 };
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
  });

  /**
   * Every command succeeds, and the clone answers `git ls-tree` on whichever
   * machine is asked — the root is the only thing under test, and a failing
   * `cd` would prove it by accident rather than on purpose
   * (`patch-repo-machines.e2e-spec.ts`'s reasoning).
   */
  const answers = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command)
        ? { ...ok, stdout: 'absent' }
        : command.includes('git ls-tree')
          ? { ...ok, stdout: 'src/index.ts\nREADME.md\n' }
          : ok,
    );

  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
    writeCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };

  /** A real temp directory, so the two roots are genuinely two strings. */
  const configuredRoot = fs.realpathSync(
    fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-repo-root-')),
  );
  const originalRoot = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(async () => {
    // Before `createTestApp`: `localCloudgateDirectory()` reads `process.env`
    // on every call, but `validateEnv` runs once at boot.
    process.env.CLOUDGATE_DIRECTORY = configuredRoot;
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
   * dedicated build Server without one, which is also what makes this
   * configuration reachable rather than hypothetical.
   */
  async function setUp(
    appName = 'blog-app',
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
      name: 'Blog',
      appName,
      environmentId: environment.environmentId,
      serverId: runServerId,
    });
    const application = await applications.update(
      ownerCtx,
      created.applicationId,
      {
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/acme/blog.git',
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

  /** The `{root}/patch-repos` a machine's own clone tree is rooted at. */
  const patchReposRootOn = (serverId: string | null) =>
    serverId
      ? `${REMOTE_CLOUDGATE_DIRECTORY}/patch-repos`
      : `${configuredRoot}/patch-repos`;

  /** Where the clone was dispatched, and into which directory — the expectation
   * every read and removal below is measured against, read off the code that
   * made the artifact rather than restated here. */
  const clones = () =>
    dispatched().filter(({ command }) =>
      command.includes('git -c protocol.file.allow=never clone'),
    );

  const listings = () =>
    dispatched().filter(({ command }) => command.includes('git ls-tree'));

  const fileReads = () =>
    dispatched().filter(({ command }) => command.startsWith('cat '));

  /**
   * Only the clone's removals. A Delete sends three `rm -rf`s per Application —
   * the source tree, the Traefik fragment and this — so a bare `rm -rf` filter
   * would mix them, which is the same problem the response field has and the
   * reason `UnreclaimedArtifact` carries a `kind`.
   */
  const repoRemovals = () =>
    dispatched().filter(
      ({ command, serverId }) =>
        command.startsWith('rm -rf ') &&
        command.includes(`${patchReposRootOn(serverId)}/`),
    );

  const ensureRepo = (cookie: string, id: string) =>
    request(server)
      .post('/patches/repo/ensure')
      .set('Cookie', cookie)
      .send({ id, type: 'application' });

  const readDirectories = (cookie: string, id: string) =>
    request(server)
      .get('/patches/repo/directories')
      .query({ id, type: 'application' })
      .set('Cookie', cookie);

  const readFile = (cookie: string, id: string, filePath: string) =>
    request(server)
      .get('/patches/repo/file')
      .query({ id, type: 'application', filePath, source: 'repo' })
      .set('Cookie', cookie);

  const cleanRepos = (cookie: string, body: { serverId?: string | null }) =>
    request(server)
      .post('/patches/repo/clean')
      .set('Cookie', cookie)
      .send(body);

  describe('the writer', () => {
    it('clones under the build Server’s own root, never under this instance’s', async () => {
      const { session, application, buildServerId } = await setUp();

      const ensured = await ensureRepo(
        session.cookie,
        application.applicationId,
      );

      expect(ensured.status).toBe(200);
      expect(ensured.text).toBe(
        `${patchReposRootOn(buildServerId)}/application/blog-app`,
      );
      expect(clones().map(({ serverId }) => serverId)).toEqual([buildServerId]);
      expect(clones()[0].command).toContain(
        `${patchReposRootOn(buildServerId)}/application/blog-app`,
      );
      expect(clones()[0].command).not.toContain(configuredRoot);
    });

    // The branch that has to keep working: a clone in this process writes where
    // this process can write, which is the whole reason CLOUDGATE_DIRECTORY
    // exists.
    it('clones under this instance’s configured root when the build runs here', async () => {
      const { session, application } = await setUp('local-app', {
        dedicatedBuildServer: false,
      });
      // Straight on the row: `updateApplicationSchema` does not admit
      // `serverId`, and what this test needs is the platform-host shape rather
      // than a route that reaches it.
      await ctx.db
        .update(applicationTable)
        .set({ serverId: null })
        .where(eq(applicationTable.applicationId, application.applicationId));

      const ensured = await ensureRepo(
        session.cookie,
        application.applicationId,
      );

      expect(ensured.status).toBe(200);
      expect(clones().map(({ serverId }) => serverId)).toEqual([null]);
      expect(clones()[0].command).toContain(
        `${configuredRoot}/patch-repos/application/local-app`,
      );
      expect(clones()[0].command).not.toContain(REMOTE_CLOUDGATE_DIRECTORY);
    });
  });

  describe('the readers', () => {
    /**
     * The two read routes are not writers, but they are held to the same root
     * for the reason `resolveRepoPath`'s docblock gives: one expression behind
     * the clone, so none of the call sites can disagree about which directory a
     * patch applies to. A listing under the local root on the builder answers
     * 500 about a repository that exists.
     */
    it('lists and reads the clone at the root the clone was written to', async () => {
      const { session, application, buildServerId } = await setUp();

      await ensureRepo(session.cookie, application.applicationId);
      const cloneDirectory = `${patchReposRootOn(buildServerId)}/application/blog-app`;
      expect(clones()[0].command).toContain(cloneDirectory);

      const listed = await readDirectories(
        session.cookie,
        application.applicationId,
      );
      const read = await readFile(
        session.cookie,
        application.applicationId,
        'README.md',
      );

      expect(listed.status).toBe(200);
      expect(read.status).toBe(200);
      expect(listings()).toEqual([
        {
          serverId: buildServerId,
          command: `cd "${cloneDirectory}" && git ls-tree -r --name-only HEAD`,
        },
      ]);
      expect(fileReads()).toEqual([
        { serverId: buildServerId, command: `cat ${cloneDirectory}/README.md` },
      ]);
    });
  });

  describe('the destroyers', () => {
    /**
     * The decisive assertion of this set: the removal names the directory the
     * clone wrote. The expectation is derived from `ensureRepo`'s own dispatch,
     * so it cannot restate this file's opinion about where the clone is — a
     * root that forks between writer and destroyer fails here whichever of the
     * two is wrong.
     */
    it('removes the clone the writer wrote, on the machine it wrote it on', async () => {
      const { session, ownerCtx, application, buildServerId } = await setUp();
      await ensureRepo(session.cookie, application.applicationId);
      const cloned = clones()[0];
      const cloneDirectory = `${patchReposRootOn(buildServerId)}/application/blog-app`;
      expect(cloned.command).toContain(cloneDirectory);

      await applications.remove(ownerCtx, application.applicationId);

      expect(repoRemovals()).toEqual([
        { serverId: cloned.serverId, command: `rm -rf ${cloneDirectory}` },
      ]);
    });

    it('removes each clone under the build Server’s own root when a Project is deleted', async () => {
      const { ownerCtx, project, buildServerId } = await setUp();

      await projects.remove(ownerCtx, project.projectId);

      // Deleting a Project is one click and deleting eleven Services is
      // eleven, so the bulk path must resolve what the per-Service path does.
      expect(repoRemovals()).toEqual([
        {
          serverId: buildServerId,
          command: `rm -rf ${patchReposRootOn(buildServerId)}/application/blog-app`,
        },
      ]);
    });

    // The platform-host branch of the removal, which is the default install and
    // the one that must keep pointing at this instance's own tree.
    it('removes the clone under this instance’s configured root when the build ran here', async () => {
      const { ownerCtx, application } = await setUp('local-app', {
        dedicatedBuildServer: false,
      });
      await ctx.db
        .update(applicationTable)
        .set({ serverId: null })
        .where(eq(applicationTable.applicationId, application.applicationId));

      await applications.remove(ownerCtx, application.applicationId);

      expect(repoRemovals()).toEqual([
        {
          serverId: null,
          command: `rm -rf ${configuredRoot}/patch-repos/application/local-app`,
        },
      ]);
    });

    /**
     * **The captured instance.** An earlier run produced exactly this report with
     * `path` naming the local temp root as a directory on a remote build
     * Server. `unreclaimedArtifacts` is what an operator is sent to act on, so
     * a `path` under the wrong root sends them to a directory that machine
     * never had.
     */
    it('names the unreclaimed clone at the root it tried to remove it from', async () => {
      const { ownerCtx, application, buildServerId } = await setUp();
      // Only the clone's removal, not every `rm -rf` on that host: the source
      // tree's is the other one and is already converted.
      execMock.execAsyncRemote.mockImplementation(
        (serverId: string, command: string) =>
          serverId === buildServerId &&
          command.startsWith(`rm -rf ${patchReposRootOn(buildServerId)}/`)
            ? Promise.reject(new Error('ssh: connect to host: timed out'))
            : answers(command),
      );

      const removed = await applications.remove(
        ownerCtx,
        application.applicationId,
      );

      expect(removed).toMatchObject({
        unreclaimedArtifacts: [
          {
            kind: 'patch-repo',
            appName: 'blog-app',
            serverId: buildServerId,
            path: `${patchReposRootOn(buildServerId)}/application/blog-app`,
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

    /**
     * `cleanRepos` is the *machine-wide* destroyer and the fifth call site.
     * It globs the tree on a Server an operator names, so it has to resolve
     * that Server's root — under the local one the glob matches nothing on the
     * remote host and the route answers `true` having deleted nothing, because
     * the command ends `|| true`.
     */
    it('globs the named Server’s own tree, not this instance’s', async () => {
      const { session, runServerId } = await setUp();

      const res = await cleanRepos(session.cookie, { serverId: runServerId });

      expect(res.status).toBe(200);
      expect(
        dispatched().filter(({ command }) => command.includes('patch-repos')),
      ).toEqual([
        {
          serverId: runServerId,
          command: `rm -rf "${patchReposRootOn(runServerId)}"/* 2>/dev/null || true`,
        },
      ]);
    });

    // The platform host is this instance's own tree, and instance authority is
    // what admits it (ADR-0013) — the owner of the only organization here
    // holds it.
    it('globs this instance’s own tree for the platform host', async () => {
      const { session } = await setUp();

      const res = await cleanRepos(session.cookie, { serverId: null });

      expect(res.status).toBe(200);
      expect(
        dispatched().filter(({ command }) => command.includes('patch-repos')),
      ).toEqual([
        {
          serverId: null,
          command: `rm -rf "${configuredRoot}/patch-repos"/* 2>/dev/null || true`,
        },
      ]);
    });
  });
});
