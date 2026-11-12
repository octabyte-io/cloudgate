import { and, eq } from 'drizzle-orm';
import { quote } from 'shell-quote';
import request from 'supertest';
import { App } from 'supertest/types';
import { application } from '../../src/applications/application.schema';
import { ApplicationsService } from '../../src/applications/applications.service';
import { ComposeService } from '../../src/compose/compose.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { licenseKey, member, organizationRole } from '../../src/db/schema';
import { HOST_UNREACHABLE_CODE } from '../../src/docker-ops/host-reachability';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionService } from '../../src/rbac/permission.service';
import { CONTAINER_DENIAL_MESSAGE } from '../../src/realtime/container-access.service';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { ServersService } from '../../src/servers/servers.service';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';

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

const ok = (stdout: string): ExecResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
});

/** The `docker ps` the listing runs, as the argv double quotes it. */
const psCommand = (label: string) =>
  quote([
    'docker',
    'ps',
    '--filter',
    'status=running',
    '--filter',
    `label=${label}`,
    '--format',
    '{{.ID}}|{{.Names}}|{{.State}}|{{.Label "com.docker.compose.service"}}|{{.Label "com.docker.swarm.service.name"}}',
  ]);

/**
 * **The Shell tab's listing: a Service's running containers, found by
 * the Service.**
 *
 * `GET /docker/services/:serviceType/:serviceId/containers` is the one route
 * that hands a container id to a caller holding no `docker` action, so it is
 * gated on entitlement to the Service — on `service:update`, the action the
 * terminal socket asks for (whatever the listing offers, the socket
 * accepts) — and every refusal is the one container sentence (ADR-0008).
 */
describe('A Service’s running containers (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let composes: ComposeService;
  let postgres: PostgresService;
  let permissions: PermissionService;
  let servers: ServersService;
  let sshKeys: SshKeysService;

  const remoteExec = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: remoteExec }],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    composes = ctx.app.get(ComposeService);
    postgres = ctx.app.get(PostgresService);
    permissions = ctx.app.get(PermissionService);
    servers = ctx.app.get(ServersService);
    sshKeys = ctx.app.get(SshKeysService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    remoteExec.execAsync.mockReset();
    remoteExec.execAsyncRemote.mockReset();
    await ctx.resetDb();
  });

  /** The owner, an Environment, and `storefront` on the platform host. */
  async function setUp() {
    const signedUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signedUp.status).toBe(200);
    const ownerCookie = signedUp.headers['set-cookie'];
    const ownerId = (signedUp.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerCookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(ownerId, organizationId);

    const project = await projects.create(ownerCtx, { name: 'Demo Shop' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const app = await applications.create(ownerCtx, {
      name: 'storefront',
      appName: 'app-storefront',
      environmentId: environment.environmentId,
    });
    return { ownerCookie, ownerCtx, organizationId, environment, app };
  }

  const list = (cookie: string, serviceType: string, serviceId: string) =>
    request(server)
      .get(`/docker/services/${serviceType}/${serviceId}/containers`)
      .set('Cookie', cookie);

  describe('for an owner', () => {
    it("lists an Application's running replicas on the platform host", async () => {
      const { ownerCookie, app } = await setUp();
      remoteExec.execAsync.mockResolvedValue(
        ok(
          [
            'aaa111|app-storefront.1.x1|running||app-storefront',
            'bbb222|app-storefront.2.x2|running||app-storefront',
            '',
          ].join('\n'),
        ),
      );

      const res = await list(ownerCookie, 'application', app.applicationId);

      expect(res.status).toBe(200);
      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        psCommand('com.docker.swarm.service.name=app-storefront'),
      );
      expect(res.body).toEqual([
        {
          containerId: 'aaa111',
          name: 'app-storefront.1.x1',
          state: 'running',
        },
        {
          containerId: 'bbb222',
          name: 'app-storefront.2.x2',
          state: 'running',
        },
      ]);
    });

    it('asks the Server the Service runs on, and no other machine', async () => {
      const { ownerCookie, ownerCtx, app } = await setUp();
      const key = await sshKeys.create(ownerCtx, { name: 'k' });
      const worker = await servers.create(ownerCtx, {
        name: 'worker-1',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      await ctx.db
        .update(application)
        .set({ serverId: worker.serverId })
        .where(eq(application.applicationId, app.applicationId));
      remoteExec.execAsyncRemote.mockResolvedValue(
        ok('aaa111|app-storefront.1.x1|running||app-storefront\n'),
      );

      const res = await list(ownerCookie, 'application', app.applicationId);

      expect(res.status).toBe(200);
      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        worker.serverId,
        psCommand('com.docker.swarm.service.name=app-storefront'),
      );
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('names each docker-compose container by its compose service', async () => {
      const { ownerCookie, ownerCtx, environment } = await setUp();
      const stack = await composes.create(ownerCtx, {
        name: 'Shop stack',
        appName: 'shop-stack',
        environmentId: environment.environmentId,
      });
      remoteExec.execAsync.mockResolvedValue(
        ok(
          [
            'aaa111|shop-stack-web-1|running|web|',
            'bbb222|shop-stack-worker-1|running|worker|',
          ].join('\n'),
        ),
      );

      const res = await list(ownerCookie, 'compose', stack.composeId);

      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        psCommand('com.docker.compose.project=shop-stack'),
      );
      expect(res.body).toEqual([
        {
          containerId: 'aaa111',
          name: 'shop-stack-web-1',
          state: 'running',
          composeService: 'web',
        },
        {
          containerId: 'bbb222',
          name: 'shop-stack-worker-1',
          state: 'running',
          composeService: 'worker',
        },
      ]);
    });

    it("names a stack's container by its service, less the stack's prefix", async () => {
      const { ownerCookie, ownerCtx, environment } = await setUp();
      const stack = await composes.create(ownerCtx, {
        name: 'Shop stack',
        appName: 'shop-stack',
        environmentId: environment.environmentId,
        composeType: 'stack',
      });
      remoteExec.execAsync.mockResolvedValue(
        ok('aaa111|shop-stack_web.1.x1|running||shop-stack_web\n'),
      );

      const res = await list(ownerCookie, 'compose', stack.composeId);

      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        psCommand('com.docker.stack.namespace=shop-stack'),
      );
      expect(res.body).toEqual([
        {
          containerId: 'aaa111',
          name: 'shop-stack_web.1.x1',
          state: 'running',
          composeService: 'web',
        },
      ]);
    });

    it("lists a database's container by its swarm service", async () => {
      const { ownerCookie, ownerCtx, environment } = await setUp();
      const db = await postgres.create(ownerCtx, {
        name: 'shop-db',
        appName: 'shop-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
      });
      remoteExec.execAsync.mockResolvedValue(
        ok('aaa111|shop-db.1.x1|running||shop-db\n'),
      );

      const res = await list(ownerCookie, 'postgres', db.postgresId);

      expect(res.status).toBe(200);
      expect(remoteExec.execAsync).toHaveBeenCalledWith(
        psCommand('com.docker.swarm.service.name=shop-db'),
      );
      expect(res.body).toHaveLength(1);
    });

    it('answers an empty list for a Service with nothing running', async () => {
      const { ownerCookie, app } = await setUp();
      remoteExec.execAsync.mockResolvedValue(ok(''));

      const res = await list(ownerCookie, 'application', app.applicationId);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('is a 503 naming the Server, not an empty list, when it was not reached', async () => {
      const { ownerCookie, ownerCtx, app } = await setUp();
      const key = await sshKeys.create(ownerCtx, { name: 'k' });
      const worker = await servers.create(ownerCtx, {
        name: 'worker-1',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      await ctx.db
        .update(application)
        .set({ serverId: worker.serverId })
        .where(eq(application.applicationId, app.applicationId));
      remoteExec.execAsyncRemote.mockRejectedValue(
        new ExecError(
          'SSH connection error: connect ECONNREFUSED 203.0.113.10:22',
          { command: 'docker ps', serverId: worker.serverId },
        ),
      );

      const res = await list(ownerCookie, 'application', app.applicationId);

      expect(res.status).toBe(503);
      expect((res.body as { code?: string }).code).toBe(HOST_UNREACHABLE_CODE);
    });
  });

  /**
   * The headline caller: a built-in member entitled to the Service,
   * holding `docker: []`, who had no route that would find its container.
   */
  it('lists for a built-in member entitled to the Service, who holds no docker action', async () => {
    const { ownerCookie, organizationId, app } = await setUp();
    const memberFixture = await signUpMember(server, ownerCookie);
    const memberCtx = permissionCtx(memberFixture.id, organizationId);
    await permissions.addNewService(memberCtx, app.applicationId);
    remoteExec.execAsync.mockResolvedValue(
      ok('aaa111|app-storefront.1.x1|running||app-storefront\n'),
    );

    const res = await list(
      memberFixture.cookie,
      'application',
      app.applicationId,
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  describe('every refusal says the same thing', () => {
    /**
     * A licensed custom role holding exactly `permission`, in the owner's
     * organization — written directly, as `docker-ops.e2e-spec.ts` does: the
     * fixture is about what the role grants, not how it was made.
     */
    async function customRole(
      organizationId: string,
      ownerCookie: string,
      permission: Record<string, string[]>,
    ) {
      const invitee = await signUpMember(server, ownerCookie);
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db
        .insert(organizationRole)
        .values({ organizationId, role: 'service-reader', permission });
      await ctx.db
        .update(member)
        .set({ role: 'service-reader', accessedServices: [] })
        .where(
          and(
            eq(member.userId, invitee.id),
            eq(member.organizationId, organizationId),
          ),
        );
      return invitee;
    }

    /**
     * The read-only custom role the ticket names: `service: ['read']` and no
     * `update`, entitled to `storefront` by its member row. It is refused its
     * own Service's containers, a foreign Service's, and an id naming nothing,
     * and cannot tell the three apart.
     */
    it('refuses a read-only custom role its own Service, a foreign one and a missing one in one sentence', async () => {
      const { ownerCookie, organizationId, app } = await setUp();
      const reader = await customRole(organizationId, ownerCookie, {
        service: ['read'],
      });
      await ctx.db
        .update(member)
        .set({ accessedServices: [app.applicationId] })
        .where(eq(member.userId, reader.id));

      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerCookie,
      );
      const malloryCtx = permissionCtx(mallory.id, mallory.organizationId);
      const theirProject = await projects.create(malloryCtx, {
        name: 'Theirs',
      });
      const theirEnvironment = await environments.create(malloryCtx, {
        name: 'production',
        projectId: theirProject.projectId,
      });
      const foreign = await applications.create(malloryCtx, {
        name: 'theirs',
        appName: 'app-theirs',
        environmentId: theirEnvironment.environmentId,
      });

      const answers = await Promise.all([
        list(reader.cookie, 'application', app.applicationId),
        list(reader.cookie, 'application', foreign.applicationId),
        list(reader.cookie, 'application', 'never-existed'),
      ]);

      for (const res of answers) {
        expect(res.status).toBe(403);
        expect((res.body as { message: string }).message).toBe(
          CONTAINER_DENIAL_MESSAGE,
        );
      }
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('refuses a foreign Service to its own organization’s owner, as it refuses a missing one', async () => {
      const { ownerCookie } = await setUp();
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerCookie,
      );
      const malloryCtx = permissionCtx(mallory.id, mallory.organizationId);
      const theirProject = await projects.create(malloryCtx, {
        name: 'Theirs',
      });
      const theirEnvironment = await environments.create(malloryCtx, {
        name: 'production',
        projectId: theirProject.projectId,
      });
      const foreign = await applications.create(malloryCtx, {
        name: 'theirs',
        appName: 'app-theirs',
        environmentId: theirEnvironment.environmentId,
      });

      const [theirs, missing] = await Promise.all([
        list(ownerCookie, 'application', foreign.applicationId),
        list(ownerCookie, 'compose', 'never-existed'),
      ]);

      expect(theirs.status).toBe(403);
      expect(missing.status).toBe(403);
      expect((theirs.body as { message: string }).message).toBe(
        (missing.body as { message: string }).message,
      );
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('refuses a base member a Service their row does not name, in the same sentence', async () => {
      const { ownerCookie, app } = await setUp();
      const memberFixture = await signUpMember(server, ownerCookie);

      const res = await list(
        memberFixture.cookie,
        'application',
        app.applicationId,
      );

      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toBe(
        CONTAINER_DENIAL_MESSAGE,
      );
    });
  });
});
