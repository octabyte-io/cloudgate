import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { buildZip } from '../utils/zip-archive';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * Where a drop upload lands, and where the build then reads it: the `code` half
 * of the tree on the **build host** (`CONTEXT.md`'s *Build host*, ADR-0018),
 * which for this file's Application — no `serverId`, no `buildServerId` — is
 * the platform host (ADR-0008).
 *
 * So the root is that machine's, taken from it rather than spelled.
 * Written as `/etc/cloudgate` this was a Server's root, green only while
 * CLOUDGATE_DIRECTORY was unset — and the `rm -rf` negative below passed
 * vacuously under any other root. The tail stays a literal rather
 * than `applicationsDirectoryOn`, so the expectation is not rebuilt the way the
 * code builds it (§1.7). A function for `localCloudgateDirectory`'s reason: the
 * root is read when asked, not at import.
 */
const code = () => `${cloudgateDirectoryOn(null)}/applications/drop-app/code`;

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/**
 * End to end: **upload a zip, then deploy it.**
 *
 * `getGitProviderStrategy('drop')` threw and `deploy` had no inline branch, so
 * this whole sequence — the one the console's *Drop* card offers — ended in
 * *"No git-provider strategy registered for source type \"drop\""* with no
 * build attempted. An earlier fix had made the upload write to the right machine; this is
 * the question of whether anything could then deploy what it wrote.
 *
 * Driven through the real HTTP route rather than through `uploadDrop` directly,
 * because the property under test spans the two halves: the *same* path the
 * upload wrote has to be the path the build reads, and it is the pair that was
 * broken (`CONTEXT.md`'s *Build host*, ADR-0018).
 */
describe('Deploying a dropped archive (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let engine: DeploymentEngineService;

  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });

  /**
   * A Swarm with no existing service, and one task already running.
   *
   * The Update phase talks to the Docker API in this process and the
   * convergence poll then reads the tasks, so both have to answer or the
   * deploy fails on the daemon rather than on anything this file is about —
   * against a real socket it is `503 This node is not a swarm manager`. A task
   * that is already `running` is the shortest honest answer: the poll returns
   * without sleeping.
   */
  const dockerService = {
    inspect: jest.fn(),
    update: jest.fn(),
  };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
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
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    primeDoubles();
  });

  const primeDoubles = () => {
    const ok = { stdout: '', stderr: '', exitCode: 0 };
    execMock.execAsync.mockResolvedValue(ok);
    execMock.execAsyncRemote.mockResolvedValue(ok);
    dockerService.inspect.mockRejectedValue(new Error('no such service'));
    dockerService.update.mockResolvedValue(undefined);
    docker.createService.mockResolvedValue(undefined);
    docker.listTasks.mockResolvedValue([
      { Status: { State: 'running', Timestamp: '2026-09-08T00:00:00Z' } },
    ]);
  };

  async function setUpApplication() {
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers['set-cookie'];
    const userId = (signUp.body as { user: { id: string } }).user.id;

    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(userId, organizationId);

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const created = await applications.create(ownerCtx, {
      name: 'Dropped App',
      appName: 'drop-app',
      environmentId: environment.environmentId,
    });

    return { cookie, ownerCtx, created };
  }

  /** Every shell program the mocked exec saw, local and remote. */
  const executedCommands = (): string[] => [
    ...execMock.execAsync.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    ),
    ...execMock.execAsyncRemote.mock.calls.map(
      (call: unknown[]) => call[1] as string,
    ),
  ];

  /**
   * The composed clone-patch-build-push program, found by the step that can
   * only be in it.
   *
   * Not `executedCommands()[0]`: a deploy also runs `initializeLog`'s
   * `mkdir -p …/logs` and the Update phase's two base64 log appends, and the log
   * init comes first. Selecting by the builder's own verb is stable against
   * anything the engine adds around it.
   */
  const deployProgram = (): string => {
    const found = executedCommands().filter((command) =>
      command.includes('nixpacks build'),
    );
    expect(found).toHaveLength(1);
    return found[0];
  };

  it('builds the uploaded archive instead of raising in the clone step', async () => {
    const { cookie, created } = await setUpApplication();

    const uploaded = await request(server)
      .post(`/applications/${created.applicationId}/drop`)
      .set('Cookie', cookie)
      .attach(
        'zip',
        buildZip([{ name: 'index.js', content: 'console.log(1);\n' }]),
        'bundle.zip',
      );
    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toMatchObject({ sourceType: 'drop' });

    // The upload wrote the tree; every command after this belongs to the
    // deploy.
    jest.clearAllMocks();
    primeDoubles();

    await engine.deploy(
      await applications.findDeployable(created.applicationId),
    );

    const program = deployProgram();
    // The build ran, which is the whole point.
    expect(program).toContain(`nixpacks build ${code()} --name drop-app`);
    // …over the tree the upload left, not a fresh one.
    expect(program).not.toContain(`rm -rf ${code()}`);
    expect(program).toContain(`if [ ! -d ${code()} ]; then`);
  });

  it('builds from the dropBuildPath the upload recorded', async () => {
    const { cookie, created } = await setUpApplication();

    const uploaded = await request(server)
      .post(`/applications/${created.applicationId}/drop`)
      .set('Cookie', cookie)
      .field('dropBuildPath', '/frontend')
      .attach(
        'zip',
        buildZip([{ name: 'frontend/app.js', content: 'export {};\n' }]),
        'b.zip',
      );
    expect(uploaded.status).toBe(200);

    jest.clearAllMocks();
    primeDoubles();

    await engine.deploy(
      await applications.findDeployable(created.applicationId),
    );

    // `buildPath` is null on this row, so before the dispatch arm this built
    // the archive root and silently ignored what the operator asked for.
    expect(deployProgram()).toContain(
      `nixpacks build ${code()}/frontend --name drop-app`,
    );
  });

  it('records the deployment done and converges the swarm service', async () => {
    const { cookie, created } = await setUpApplication();

    await request(server)
      .post(`/applications/${created.applicationId}/drop`)
      .set('Cookie', cookie)
      .attach(
        'zip',
        buildZip([{ name: 'index.js', content: 'console.log(1);\n' }]),
        'bundle.zip',
      );

    await engine.deploy(
      await applications.findDeployable(created.applicationId),
    );

    const history = await request(server)
      .get(`/applications/${created.applicationId}/deployments`)
      .set('Cookie', cookie);
    expect(history.status).toBe(200);
    expect((history.body as { status: string }[]).map((r) => r.status)).toEqual(
      ['done'],
    );
  });
});
