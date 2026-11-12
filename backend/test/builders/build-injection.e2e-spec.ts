import { BadRequestException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { applicationsDirectoryOn } from '../../src/deployment-engine/deployment-engine.paths';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/**
 * The build-column injection fix at the route rather than at the builder.
 *
 * The build and clone strategies have their own unit tests for the quoting, and
 * they would all stay green for a fix that patched the strategies while the
 * deploy path went on composing its own words — which is what this spec is for:
 * the columns are written through `PATCH /applications/:id`, the deploy runs
 * against a mocked `RemoteExecService`, and the assertion is made on the string
 * the mock was handed. That is the last thing before `execAsync` runs it on the
 * build server, so nothing between the DTO and the shell is taken on trust.
 *
 * The payload is `a$(id)` and the assertion is a `shell-quote` parse rather than
 * a literal, so it pins the outcome and not the scheme (`test/utils/shell-safety.ts`).
 */
describe('Build command injection through PATCH /applications/:id (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let engine: DeploymentEngineService;

  type ExecResult = { stdout: string; stderr: string; exitCode: number };
  type LocalOptions = { env?: NodeJS.ProcessEnv } | undefined;
  const execMock = {
    execAsync: jest.fn<Promise<ExecResult>, [string, LocalOptions?]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  };

  /** A Swarm with no existing service, converged on its first read. */
  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
  };
  const convergedTasks = [1, 2, 3].map((n) => ({
    Status: { State: 'running', Timestamp: `2026-08-24T00:00:0${n}Z` },
  }));
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
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.getService.mockClear();
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.listTasks.mockReset().mockResolvedValue(convergedTasks);
    dockerFactoryMock.getRemoteDocker.mockClear();
  });

  /** An owner session plus a project, an environment and an application. */
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
    const application = await applications.create(ownerCtx, {
      name: 'Shop API',
      appName: 'shop-api',
      environmentId: environment.environmentId,
    });
    return { cookie, application };
  }

  /** The columns under test, written the way a caller writes them. */
  const patch = async (
    cookie: string,
    applicationId: string,
    body: Record<string, unknown>,
  ) => {
    const res = await request(server)
      .patch(`/applications/${applicationId}`)
      .set('Cookie', cookie)
      .send(body);
    expect(res.status).toBe(200);
  };

  const deploy = async (applicationId: string) =>
    engine.deploy(await applications.findDeployable(applicationId));

  /**
   * The one command the deploy piped its clone and build into — found by its
   * clone rather than by call index, because the deployment record writes its
   * log file through the same mock first.
   */
  const builtCommand = (): string => {
    const command = execMock.execAsync.mock.calls
      .map((call) => call[0])
      .find((c) => c.includes('git -c protocol.file.allow=never clone'));
    expect(command).toBeDefined();
    return command as string;
  };

  /** The options that same command was executed with. */
  const builtOptions = (): LocalOptions =>
    execMock.execAsync.mock.calls.find((call) =>
      call[0].includes('git -c protocol.file.allow=never clone'),
    )?.[1];

  /**
   * The deploy wraps its steps in `( … ) >> <logPath> 2>&1`, so one
   * subshell `(` is expected in every command below and is not the payload's.
   */
  const WRAPPING_SUBSHELL = 1;

  /**
   * Every git clone opens `cg_clone=$(mktemp -d)` — the scratch
   * directory that carries git's output and exit status out of the `tee`
   * pipeline so a credentials prompt can be named. A substitution this tree
   * wrote over nothing operator-controlled; each test below asserts the line
   * itself, so the count still notices any other.
   */
  const CLONE_SCRATCH = 1;

  /**
   * `dockerfile` is absent from this case, and the reason is a seam rather than
   * an omission — see `refuses a deploy whose dockerfile column carries a
   * metacharacter` below, which is where that column is covered.
   *
   * What broke: the four columns are all quoted, but `dockerfile` has a
   * second destination. With `createEnvFile` set — the schema default — the
   * dockerfile strategy hands its directory to `getCreateFileCommand`, which
   * an earlier fix made *refuse* a `SHELL_UNSAFE` path instead of quoting it. So a payload
   * in this one column never reaches a build command at all, and asserting the
   * quoting on it here would pin the opposite of what the code does.
   *
   * Rejected: adding `dockerfile` to the patch below and loosening the
   * assertion to "quoted **or** refused". That passes whichever way a later
   * change to either layer goes, which is the one thing a test on a seam must
   * not do.
   */
  it('quotes a dockerfile build whose context path and build stage came from the route', async () => {
    const { cookie, application } = await setUpApplication();

    await patch(cookie, application.applicationId, {
      sourceType: 'git',
      customGitUrl: `https://git.example.com/acme/${SHELL_PAYLOAD}.git`,
      customGitBranch: SHELL_PAYLOAD,
      buildType: 'dockerfile',
      dockerContextPath: `/apps/${SHELL_PAYLOAD}`,
      dockerBuildStage: SHELL_PAYLOAD,
    });

    await deploy(application.applicationId);

    const command = builtCommand();
    expectQuotedInCommand(
      command,
      SHELL_PAYLOAD,
      WRAPPING_SUBSHELL + CLONE_SCRATCH,
    );
    expect(command).toContain('cg_clone=$(mktemp -d);');
    // The clone and the build are both in this one string, and both carry the
    // payload — a fix in one strategy alone would not get this far.
    expect(command).toContain(
      'git -c protocol.file.allow=never clone --branch',
    );
    expect(command).toContain('docker build -t');
    expect(command).toContain('--target');
  });

  it('quotes a nixpacks publish directory written through the route', async () => {
    const { cookie, application } = await setUpApplication();

    await patch(cookie, application.applicationId, {
      sourceType: 'git',
      customGitUrl: 'https://git.example.com/acme/shop.git',
      customGitBranch: 'main',
      buildType: 'nixpacks',
      publishDirectory: SHELL_PAYLOAD,
    });

    await deploy(application.applicationId);

    const command = builtCommand();
    // Two, not `WRAPPING_SUBSHELL`,: a `publishDirectory` build
    // opens with `leftoverNixpacksContainerReclamation`, whose enumeration is
    // `for cg_leftover in $(docker ps -a --format …)` — the second case
    // `expectQuotedInCommand`'s `substitutions` exists for, beside
    // `buildScheduleCommandScript`'s `CONTAINER_ID=$(…)`. Raising the count
    // costs this assertion the ability to notice a *third*, so the line below
    // names the one that was added: a substitution this tree wrote, over a
    // format string with nothing operator-controlled in it, in the one branch
    // that has it.
    expectQuotedInCommand(
      command,
      SHELL_PAYLOAD,
      WRAPPING_SUBSHELL + CLONE_SCRATCH + 1,
    );
    expect(command).toContain('cg_clone=$(mktemp -d);');
    expect(command).toContain("docker ps -a --format '{{.Names}}'");
    expect(command).toContain('docker cp');
    expect(command).toContain('mkdir -p');
  });

  /**
   * The route, and the other kind of answer for the same column.
   *
   * Quoting settles what may be *interpolated*; it says nothing about where the
   * copy-out may *point*. `publishDirectory` is joined onto the build directory
   * with a `path.join` that normalises, so `../../..` walked the `mkdir -p` and
   * the `docker cp` destination out of the application's tree — as the account
   * that drives Docker on the build server, with the payload perfectly quoted
   * the whole way. The refusal is on `updateApplicationSchema`
   * (`nixpacks.strategy.spec.ts` proves the escape is a write the builder really
   * performs); this pins that the global pipe answers it before the column is
   * written, and that the deploy behind it still copies out the value that was
   * accepted rather than nothing at all.
   */
  it('refuses a publishDirectory that walks out of the build directory, and copies out the accepted one instead', async () => {
    const { cookie, application } = await setUpApplication();

    await patch(cookie, application.applicationId, {
      sourceType: 'git',
      customGitUrl: 'https://git.example.com/acme/shop.git',
      customGitBranch: 'main',
      buildType: 'nixpacks',
      publishDirectory: 'dist',
    });

    const refused = await request(server)
      .patch(`/applications/${application.applicationId}`)
      .set('Cookie', cookie)
      .send({ publishDirectory: '../../../traefik/dynamic' });
    expect(refused.status).toBe(400);

    await deploy(application.applicationId);

    const command = builtCommand();
    const buildAppDirectory = `${applicationsDirectoryOn(null)}/shop-api/code`;
    expect(command).toContain(`mkdir -p ${buildAppDirectory}/dist`);
    // The escaped destination reached no command at all — not even a quoted one.
    expect(command).not.toContain('traefik');
  });

  /**
   * The never-carry change at the route, which is the only place the whole path is real.
   *
   * The strategies have unit tests for the never-carry shape and the engine has
   * one for the seam, and both would stay green for a fix that stopped at the
   * builder while the deploy went on composing its own words — the same failure
   * mode the rest of this file exists for. So: the environment is written
   * through `PATCH /applications/:id`, the deploy runs against the mocked
   * `RemoteExecService`, and the assertions are made on the last thing before
   * the build server runs it.
   *
   * Both halves, because either alone passes a broken fix: the value is not in
   * the command, **and** it is in the environment the command was executed
   * with. A build that cannot see its own environment is not a fix.
   */
  it('keeps an operator environment out of the build command and in the environment it runs with', async () => {
    const { cookie, application } = await setUpApplication();
    const secret = 'sk_live_91b3d0c6f2a84e57';

    await patch(cookie, application.applicationId, {
      sourceType: 'git',
      customGitUrl: 'https://git.example.com/acme/shop.git',
      customGitBranch: 'main',
      buildType: 'nixpacks',
      env: `NODE_ENV=production\nSTRIPE_KEY=${secret}`,
    });

    await deploy(application.applicationId);

    const command = builtCommand();
    expect(command).not.toContain(secret);
    expect(command).not.toContain(
      Buffer.from(secret, 'utf-8').toString('base64'),
    );
    expect(command).toContain('--env STRIPE_KEY"=$CG_BUILD_ENV_1"');

    const options = builtOptions();
    expect(options?.env?.CG_BUILD_ENV_1).toBe(secret);
    // Extended, not replaced: `ExecOptions.env` replaces, so a build handed a
    // two-variable environment would run with the shell's fallback `PATH`.
    expect(options?.env?.PATH).toBe(process.env.PATH);
  });

  /**
   * The other side of the refuse-versus-quote seam, at the route.
   *
   * `dockerfile.strategy.spec.ts` pins the refusal on the builder; this pins
   * that the refusal is what a caller who writes the column through
   * `PATCH /applications/:id` actually gets, and that it lands *before* the one
   * `execAsync` the deploy's shell steps ride. A fix that quoted the path in the
   * strategy while the engine went on composing its own words would show up
   * here as a build command that ran.
   *
   * Written as a positive assertion about the executed commands rather than a
   * call count: the deploy record's error handler appends the failure to the log
   * file through the same mock, so `not.toHaveBeenCalled()` would be false for a
   * reason that has nothing to do with the build.
   */
  it('refuses a deploy whose dockerfile column carries a metacharacter, running no build', async () => {
    const { cookie, application } = await setUpApplication();

    // `createEnvFile` is not sent: it defaults to true on the column, which is
    // the configuration a real application arrives in and the one that routes
    // this path into `getCreateFileCommand`.
    await patch(cookie, application.applicationId, {
      sourceType: 'git',
      customGitUrl: 'https://git.example.com/acme/shop.git',
      customGitBranch: 'main',
      buildType: 'dockerfile',
      dockerfile: `docker/${SHELL_PAYLOAD}/Dockerfile`,
    });

    await expect(deploy(application.applicationId)).rejects.toThrow(
      new BadRequestException('Invalid path'),
    );

    // Nothing was built or cloned on the way to being refused, and the payload
    // reached no command at all — not even a quoted one.
    const commands = execMock.execAsync.mock.calls.map((call) => call[0]);
    // Asserted before the loop so the loop cannot pass on an empty list: the
    // failure *is* written to the deployment log, which is the one thing that
    // did run.
    expect(commands).not.toHaveLength(0);
    for (const command of commands) {
      expect(command).not.toContain('git -c protocol.file.allow=never clone');
      expect(command).not.toContain('docker build');
      expect(command).not.toContain(SHELL_PAYLOAD);
    }
    expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    // The deploy is recorded as failed rather than silently dropped.
    const deployments = await ctx.db.$client.query<{ status: string }>(
      'select status from deployment where application_id = $1',
      [application.applicationId],
    );
    expect(deployments.rows.map((row) => row.status)).toEqual(['error']);
  });
});
