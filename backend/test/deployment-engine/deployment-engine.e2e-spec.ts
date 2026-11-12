import request from 'supertest';
import { App } from 'supertest/types';
import { ComposeService } from '../../src/compose/compose.service';
import { withArgvExec } from '../utils/exec-double';
import { SHELL_PAYLOAD, expectQuotedInCommand } from '../utils/shell-safety';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { deployHostsLogLine } from '../../src/deployment-engine/deploy-hosts';
import * as schema from '../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { DomainsService } from '../../src/domains/domains.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const WORDPRESS_COMPOSE = `services:
  wordpress:
    image: wordpress:6
    ports:
      - "8080:80"
  db:
    image: mariadb:11
`;

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/**
 * `composeStatus = 'error'` is the platform saying "this stack is in a
 * state nobody knows", and a deploy refused before its first write knows
 * better — an earlier fix moved every refusal domain injection can make in front of the
 * clone, so the target is provably untouched. The pair below is the whole
 * point: the refusal must leave the status alone and the after-first-write
 * failure must still set it. Getting the flag one line late (after the exec
 * instead of before it) stops reporting a half-written target, so both cases
 * have to be green together or the guard is inverted.
 */
describe('Deployment engine (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let compose: ComposeService;
  let domains: DomainsService;
  let engine: DeploymentEngineService;

  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });
  const queueMock = {
    add: jest.fn(),
    getJobs: jest.fn(),
    cancel: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    compose = ctx.app.get(ComposeService);
    domains = ctx.app.get(DomainsService);
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
    queueMock.add.mockReset().mockResolvedValue({ id: 'job-1' });
  });

  /** Every shell command the mocked exec saw, local and remote. */
  const executedCommands = (): string[] => [
    ...execMock.execAsync.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    ),
    ...execMock.execAsyncRemote.mock.calls.map(
      (call: unknown[]) => call[1] as string,
    ),
  ];

  /** A raw-source compose stack, its owner session and a service-seam ctx. */
  async function setUpRawCompose() {
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
    const created = await compose.create(ownerCtx, {
      name: 'Wordpress',
      appName: 'wp-stack',
      environmentId: environment.environmentId,
      composeFile: WORDPRESS_COMPOSE,
    });
    await compose.update(ownerCtx, created.composeId, { sourceType: 'raw' });

    return { cookie, ownerCtx, created };
  }

  const deploy = async (composeId: string) =>
    engine.deployCompose(await compose.findDeployable(composeId), {
      title: 'Manual deployment',
      description: '',
    });

  const statusOf = async (
    ownerCtx: ReturnType<typeof permissionCtx>,
    composeId: string,
  ) => (await compose.findOne(ownerCtx, composeId)).composeStatus;

  const deploymentStatuses = async (
    cookie: string,
    composeId: string,
  ): Promise<string[]> => {
    const history = await request(server)
      .get(`/compose/${composeId}/deployments`)
      .set('Cookie', cookie);
    expect(history.status).toBe(200);
    return (history.body as { status: string }[]).map((row) => row.status);
  };

  describe('deployCompose refusals', () => {
    it('leaves the serving stack at done when domain injection refuses the deploy, and still records the failed attempt', async () => {
      const { cookie, ownerCtx, created } = await setUpRawCompose();

      // Deploy cleanly first so the status under test is `done`. A fresh stack
      // starts at `idle`, and asserting "unchanged" from `idle` would pass just
      // as well with the guard inverted — there is nothing for `error` to
      // overwrite that `idle` does not already look like.
      await deploy(created.composeId);
      expect(await statusOf(ownerCtx, created.composeId)).toBe('done');

      await domains.create(ownerCtx, {
        host: 'nope.example.com',
        composeId: created.composeId,
        serviceName: 'ghost',
        domainType: 'compose',
      });
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();

      await expect(deploy(created.composeId)).rejects.toThrow(
        'Domain "nope.example.com" is attached to service "ghost" which does not exist in the compose file',
      );

      // The screen in the report: a red `error` pill beside "2 of 2 running".
      // The containers are still the ones the last successful deploy started,
      // so the stack is still `done`.
      expect(await statusOf(ownerCtx, created.composeId)).toBe('done');

      // The Deployment is the record of an *attempt*, and this attempt failed.
      const statuses = await deploymentStatuses(cookie, created.composeId);
      expect(statuses).toHaveLength(2);
      expect(statuses).toContain('error');
      expect(statuses).toContain('done');

      // Nothing was written on the way to being refused.
      const commands = executedCommands();
      expect(commands.some((c) => c.includes('rm -rf'))).toBe(false);
      expect(commands.some((c) => c.includes('docker-compose.yml'))).toBe(
        false,
      );
      expect(commands.some((c) => c.includes('Error occurred'))).toBe(true);
    });

    it('paints the stack error when the build fails after the clone has written the target', async () => {
      const { cookie, ownerCtx, created } = await setUpRawCompose();

      await deploy(created.composeId);
      expect(await statusOf(ownerCtx, created.composeId)).toBe('done');

      execMock.execAsync.mockImplementation((command: string) =>
        command.includes('up -d --build')
          ? Promise.reject(new Error('docker daemon exploded'))
          : Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      );

      await expect(deploy(created.composeId)).rejects.toThrow(
        'docker daemon exploded',
      );

      // The clone ran, so the file on the target may be half-written: this is
      // the state nobody knows, and the only thing `error` is for.
      expect(await statusOf(ownerCtx, created.composeId)).toBe('error');
      expect(await deploymentStatuses(cookie, created.composeId)).toContain(
        'error',
      );
    });
  });
  /**
   * `readComposeContent` cats the stack's compose file off the build server on
   * every non-raw deploy, and the path is built from `composePath` — a
   * `z.string().min(1)` column set through `PATCH /compose/:id`. An earlier fix quoted
   * the identical `cat` in `ComposeService.readComposeFile` and missed this
   * one, so the column was still a shell word here.
   *
   * Through the service seam rather than the builder, because the point is
   * that a fix at one call site does not cover the other.
   */
  describe('deployCompose shell safety', () => {
    it('quotes the compose path it cats off the build server', async () => {
      const { ownerCtx, created } = await setUpRawCompose();
      await compose.update(ownerCtx, created.composeId, {
        sourceType: 'git',
        customGitUrl: 'https://example.invalid/stack.git',
        customGitBranch: 'main',
        composePath: `./${SHELL_PAYLOAD}/docker-compose.yml`,
      });

      await deploy(created.composeId).catch(() => undefined);

      const cat = executedCommands().find((command) =>
        command.startsWith('cat '),
      );
      expectQuotedInCommand(cat ?? null);
    });
  });

  /**
   * Against a real `server` table: the unit spec's double answers every
   * query with every row, so only here is it proven that the line reads the
   * two rows it names — and not some other Server's — by id.
   */
  describe('deployHostsLogLine', () => {
    it('names the build and run Servers from their own rows', async () => {
      const { ownerCtx } = await setUpRawCompose();
      const organizationId = ownerCtx.session.activeOrganizationId;
      const [decoy, builder, runner] = await ctx.db
        .insert(schema.server)
        .values([
          {
            name: 'decoy',
            ipAddress: '198.51.100.1',
            port: 22,
            organizationId,
          },
          {
            name: 'ui-self',
            ipAddress: '203.0.113.42',
            port: 22,
            organizationId,
          },
          {
            name: 'runner',
            ipAddress: '198.51.100.9',
            port: 22,
            organizationId,
          },
        ])
        .returning();
      expect(decoy.serverId).toBeDefined();

      await expect(
        deployHostsLogLine(ctx.db, builder.serverId, runner.serverId),
      ).resolves.toBe(
        "🔧 [Build] Building on build Server 'ui-self' (203.0.113.42); the service runs on Server 'runner' (198.51.100.9).",
      );
      await expect(
        deployHostsLogLine(ctx.db, runner.serverId, runner.serverId),
      ).resolves.toBe(
        "🔧 [Build] Building and running on Server 'runner' (198.51.100.9).",
      );
      await expect(deployHostsLogLine(ctx.db, null, null)).resolves.toBe(
        "🔧 [Build] Building and running on Cloudgate's own host.",
      );
    });

    it("opens a platform-host stack's log through the real engine", async () => {
      const { created } = await setUpRawCompose();

      await deploy(created.composeId);

      // The first command is the recorder's own `Initializing deployment`
      // write; the host line is the first thing after it.
      const commands = executedCommands();
      expect(commands[0]).toContain('Initializing deployment');
      const clone = commands[1];
      expect(clone.startsWith('(set -e;\necho ')).toBe(true);
      expect(clone).toContain('🔧 [Build] Building and running on Cloudgate');
    });
  });
});
