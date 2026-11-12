import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { server as serverTable } from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { registry as registryTable } from '../../src/registries/registry.schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const CLONE = '/etc/cloudgate/patch-repos/application/blog-app';
const TRACKED = ['src/index.ts', 'README.md'];

/**
 * Which **machine** each patch-repo route talks to.
 *
 * A patch repo is a second clone of the entity's source, kept under
 * `{patchReposDirectory()}/{application|compose}/{appName}` so the patch editor
 * can list and read the files a patch will land on. `ensureRepo` clones it on
 * the **build host** and `catRepoFile` `cat`s it there — and
 * `readRepoDirectory` read `parent.serverId`, the Server the *workload* runs
 * on, under a comment calling it a quirk kept on purpose.
 *
 * **That is live on any install with a dedicated build Server**: the `cd` was
 * issued to a machine that had never held the clone, so it failed and the route
 * answered 500 *"Failed to read repository"* about a repository that existed on
 * the other Server. The patch editor is unusable on that install and the error
 * names the wrong cause. It is the same wrong-machine defect an earlier fix fixed for the
 * source tree's `rm -rf`, one module along, and `deployment-engine/build-host.ts`
 * is the one statement of the rule all four call sites now ask.
 *
 * **Every assertion names the host, because nothing else can catch this.**
 * `cd "/etc/cloudgate/patch-repos/application/blog-app" && git ls-tree -r
 * --name-only HEAD` is byte-identical whichever machine it is sent to, and the
 * two ids coincide on the default single-Server install — which is why
 * `repo-directories.e2e-spec.ts`, which asserts the *command* thoroughly, stayed
 * green through the whole life of the defect. So the exec double is bucketed by
 * `serverId`, each expectation is a whole array, and the "where the clone is"
 * half is read off `ensureRepo`'s own dispatch rather than restated here.
 *
 * The exec layer is the only double — SSH is a boundary (§1.7).
 */
describe('Which machine a patch repo lives on (e2e)', () => {
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

  /** The clone answers `git ls-tree` on whichever machine is asked, so a read
   * aimed at the wrong one still succeeds — the host is the only thing under
   * test and a failing `cd` would prove it by accident rather than on purpose. */
  const answers = (command: string) =>
    Promise.resolve(
      command.includes('git ls-tree')
        ? { ...ok, stdout: `${TRACKED.join('\n')}\n` }
        : ok,
    );

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
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
   * An owner, a git-sourced Application that runs on one Server and builds on
   * another, and a Registry — which is here for the same reason
   * `application-delete-machines.e2e-spec.ts` links one: the reachability check refuses a
   * dedicated build Server without one, so the Application could not exist in
   * the shape these tests are about.
   */
  async function setUp(options: { dedicatedBuildServer?: boolean } = {}) {
    const { dedicatedBuildServer = true } = options;
    const session = await signUp({
      name: 'Grace Hopper',
      email: 'grace@example.com',
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
      name: 'Blog',
      appName: 'blog-app',
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
    return { session, application, runServerId, buildServerId };
  }

  /** Every command the exec layer was asked for, with the machine it was asked
   * of — `null` being the platform host (ADR-0008). */
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

  const listings = () =>
    dispatched().filter(({ command }) => command.includes('git ls-tree'));

  const clones = () =>
    dispatched().filter(({ command }) =>
      command.includes('git -c protocol.file.allow=never clone'),
    );

  const fileReads = () =>
    dispatched().filter(({ command }) => command.startsWith('cat '));

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

  it('clones the repo on the build Server, which is where the other routes have to look', async () => {
    const { session, application, buildServerId } = await setUp();

    const ensured = await ensureRepo(session.cookie, application.applicationId);

    // The "where the clone is" half, taken from the route that makes it rather
    // than restated: every expectation below is about this machine.
    expect(ensured.status).toBe(200);
    expect(ensured.text).toBe(CLONE);
    expect(clones()).toEqual([
      expect.objectContaining({ serverId: buildServerId }),
    ]);
    expect(clones()[0].command).toContain(CLONE);
  });

  it('lists the repo on the Server that cloned it, not the Server that runs the workload', async () => {
    const { session, application, runServerId, buildServerId } = await setUp();

    const res = await readDirectories(
      session.cookie,
      application.applicationId,
    );

    expect(res.status).toBe(200);
    // The whole array, so a second listing aimed at the runner fails this too.
    // Pre-fix this was `[{ serverId: runServerId, … }]` and the route 500'd on
    // a real install, while every command-only assertion stayed green.
    expect(listings()).toEqual([
      {
        serverId: buildServerId,
        command: `cd "${CLONE}" && git ls-tree -r --name-only HEAD`,
      },
    ]);
    expect(listings()).not.toContainEqual(
      expect.objectContaining({ serverId: runServerId }),
    );
  });

  it('reads a repo file on the same Server it lists the repo on', async () => {
    const { session, application, buildServerId } = await setUp();

    const listed = await readDirectories(
      session.cookie,
      application.applicationId,
    );
    const read = await readFile(
      session.cookie,
      application.applicationId,
      'README.md',
    );

    // The two reads had two answers to one question before this — `catRepoFile`
    // resolved the build host through `findEntity` and the listing took
    // `parent.serverId` — which is the drift `buildHostServerId` exists to make
    // impossible.
    expect(listed.status).toBe(200);
    expect(read.status).toBe(200);
    expect(fileReads()).toEqual([
      { serverId: buildServerId, command: `cat ${CLONE}/README.md` },
    ]);
    expect(new Set(listings().map(({ serverId }) => serverId))).toEqual(
      new Set(fileReads().map(({ serverId }) => serverId)),
    );
  });

  it('lists the repo on the run Server when the Application has no build Server', async () => {
    const { session, application, runServerId } = await setUp({
      dedicatedBuildServer: false,
    });

    const res = await readDirectories(
      session.cookie,
      application.applicationId,
    );

    // `buildHostServerId`'s fall-through, and the configuration that hid the
    // defect: no dedicated build Server means the clone is wherever the service
    // runs, so the two answers coincide and both the broken and the fixed code
    // ask this machine.
    expect(res.status).toBe(200);
    expect(listings()).toEqual([
      {
        serverId: runServerId,
        command: `cd "${CLONE}" && git ls-tree -r --name-only HEAD`,
      },
    ]);
  });
});
