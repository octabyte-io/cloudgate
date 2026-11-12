import { ForbiddenException, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { ComposeService } from '../../src/compose/compose.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { licenseKey, member, organizationRole } from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { previewDeployment } from '../../src/preview-deployments/preview-deployment.schema';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionService } from '../../src/rbac/permission.service';
import {
  CONTAINER_DENIAL_MESSAGE,
  ContainerAccessService,
} from '../../src/realtime/container-access.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { ServersService } from '../../src/servers/servers.service';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import {
  secondOrganizationOwner,
  createOrganization,
} from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/** Invites a user into the owner's organization and accepts as them. */
async function inviteUser(
  server: App,
  ownerCookie: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ cookie: string; id: string }> {
  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', ownerCookie)
    .send({ email, role });
  const inviteId = (invite.body as { id: string }).id;

  const su = await request(server)
    .post('/api/auth/sign-up/email')
    .set('x-cloudgate-token', inviteId)
    .send({ name: 'Ida Rhodes', email, password: 'super-secret-password' });
  const cookie = su.headers['set-cookie'];
  const id = (su.body as { user: { id: string } }).user.id;

  const accept = await request(server)
    .post(`/organizations/invitations/${inviteId}/accept`)
    .set('Cookie', cookie);
  expect(accept.status).toBe(201);

  return { cookie, id };
}

/**
 * ADR-0008: a container-addressed socket is authorized against the **Service
 * that owns the container**, resolved from the Docker labels that trace it back
 * to a row in this instance's database. `docker:read` governs only the
 * containers that belong to no Service.
 *
 * This is the seam the three gateways share; each of them only turns what it
 * throws into one close frame.
 */
describe('Container access (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let access: ContainerAccessService;
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
    access = ctx.app.get(ContainerAccessService);
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

  /**
   * What `docker inspect` prints for a container carrying these labels —
   * `<no value>` is what a Go template renders for a key that is not there.
   *
   * The container's own `{{.Name}}` leads, with the leading slash Docker puts on
   * it: it is what tells the platform's own containers from an operator's
   * hand-started one, both of which resolve to no Service.
   */
  const labels = (
    swarmServiceName?: string,
    composeProject?: string,
    stackNamespace?: string,
    name = '/abc123def456',
  ): ExecResult => ({
    stdout: `${name}|${swarmServiceName ?? '<no value>'}|${composeProject ?? '<no value>'}|${stackNamespace ?? '<no value>'}\n`,
    stderr: '',
    exitCode: 0,
  });

  async function setUpApplication() {
    const ownerSession = await signUp(server, owner);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const app = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'web-app',
      environmentId: environment.environmentId,
    });
    return { organizationId, ownerSession, ownerCtx, environment, app };
  }

  describe('a managed container', () => {
    /**
     * The appNames come back as well as the pass: they are what the caller
     * keeps, since a socket renews its authorization against this resolution
     * rather than inspecting the container again (ADR-0012). Asserting them
     * pins *which* Service the container resolved to, which is the whole of
     * ADR-0008 and what a pass alone leaves unsaid.
     */
    it('is reachable by whoever is entitled to the Service that owns it', async () => {
      const { ownerCtx } = await setUpApplication();
      remoteExec.execAsync.mockResolvedValue(labels('web-app'));

      await expect(
        access.authorizeContainer(
          ownerCtx,
          { containerId: 'abc123def456' },
          'read',
        ),
      ).resolves.toEqual(['web-app']);
    });

    /**
     * The hole: entitlement was checked against the machine and
     * never against the workload, so a member whose row-level access excludes a
     * Service could still reach that Service's containers by container id.
     */
    it('is refused to a member the Service is withheld from', async () => {
      const { ownerSession, organizationId } = await setUpApplication();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      remoteExec.execAsync.mockResolvedValue(labels('web-app'));

      await expect(
        access.authorizeContainer(
          permissionCtx(invitee.id, organizationId),
          {
            containerId: 'abc123def456',
          },
          'read',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    /**
     * `docker:read` is deliberately *not* additionally required: `memberRole`
     * grants `docker: []`, so requiring both would deny every base member the
     * logs of their own services — a feature removal inside a security fix.
     */
    it('is reachable by a member holding the Service but no docker access', async () => {
      const { ownerSession, organizationId, app } = await setUpApplication();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);
      await permissions.addNewService(inviteeCtx, app.applicationId);
      remoteExec.execAsync.mockResolvedValue(labels('web-app'));

      await expect(
        access.authorizeContainer(
          inviteeCtx,
          { containerId: 'abc123def456' },
          'read',
        ),
      ).resolves.toEqual(['web-app']);
    });

    it('resolves a compose stack through its project label', async () => {
      const { ownerCtx, environment } = await setUpApplication();
      await composes.create(ownerCtx, {
        name: 'Stack',
        appName: 'my-stack',
        environmentId: environment.environmentId,
      });
      remoteExec.execAsync.mockResolvedValue(labels(undefined, 'my-stack'));

      await expect(
        access.authorizeContainer(
          ownerCtx,
          { containerId: 'abc123def456' },
          'read',
        ),
      ).resolves.toEqual(['my-stack']);
    });

    /**
     * A Swarm stack carries neither of the two labels ADR-0008's prose names:
     * its compose project is unset and its `com.docker.swarm.service.name` is
     * `${appName}_${serviceName}`, which matches no Service row. The stack
     * namespace is the label that does, and `backups/commands/utils.ts` already
     * targets stacks by it. Without it a stack container would read as
     * unmanaged and its own owner would be denied its logs.
     */
    it('resolves a swarm stack through its namespace label', async () => {
      const { ownerCtx, environment } = await setUpApplication();
      await composes.create(ownerCtx, {
        name: 'Stack',
        appName: 'my-stack',
        environmentId: environment.environmentId,
        composeType: 'stack',
      });
      remoteExec.execAsync.mockResolvedValue({
        stdout: '/my-stack_web.1.abc|my-stack_web|<no value>|my-stack\n',
        stderr: '',
        exitCode: 0,
      });

      await expect(
        access.authorizeContainer(
          ownerCtx,
          { containerId: 'abc123def456' },
          'read',
        ),
      ).resolves.toEqual(['my-stack_web', 'my-stack']);
    });

    /**
     * A remote target's labels come back over the remote-execution layer.
     * Reading them locally would authorize one machine's socket against another
     * machine's containers.
     *
     * The same command reads the container's **name**, and the name
     * is what decides whether the target is one of this instance's own — so
     * ADR-0008's "read on the machine being addressed" now covers it too. The
     * mock answers only on `execAsyncRemote`, so a name read locally would be
     * `undefined` rather than quietly wrong.
     */
    it('reads its labels and its name on the machine being addressed', async () => {
      const { ownerCtx } = await setUpApplication();
      const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
      const created = await servers.create(ownerCtx, {
        name: 'worker-1',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      remoteExec.execAsyncRemote.mockResolvedValue(labels('web-app'));

      await access.authorizeContainer(
        ownerCtx,
        {
          containerId: 'abc123def456',
          serverId: created.serverId,
        },
        'read',
      );

      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        created.serverId,
        expect.stringContaining('abc123def456'),
      );
      expect(remoteExec.execAsyncRemote.mock.calls[0][1]).toContain(
        '{{.Name}}',
      );
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });
  });

  describe('an unmanaged container', () => {
    /** Traefik, the platform's own, anything an operator started by hand: no
     * Service to ask about, so machine-level docker access governs instead. */
    it('is reachable by a role holding docker:read', async () => {
      const { ownerCtx } = await setUpApplication();
      remoteExec.execAsync.mockResolvedValue(labels());

      await expect(
        access.authorizeContainer(
          ownerCtx,
          { containerId: 'abc123def456' },
          'read',
        ),
      ).resolves.toEqual([]);
    });

    it('is refused to a base member, whose role grants no docker access', async () => {
      const { ownerSession, organizationId } = await setUpApplication();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      remoteExec.execAsync.mockResolvedValue(labels());

      await expect(
        access.authorizeContainer(
          permissionCtx(invitee.id, organizationId),
          {
            containerId: 'abc123def456',
          },
          'read',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    /** A label naming something this instance's database does not know is not
     * a managed container either. Note the scope: resolution is instance-wide,
     * so this is a name *no* organization claims — another organization's
     * container does resolve, and is refused outright rather than falling to
     * this branch, which is what the cross-organization test below covers. */
    it('is what a label no Service in this instance claims resolves to', async () => {
      const { ownerSession, organizationId } = await setUpApplication();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      remoteExec.execAsync.mockResolvedValue(labels('someone-elses-app'));

      await expect(
        access.authorizeContainer(
          permissionCtx(invitee.id, organizationId),
          {
            containerId: 'abc123def456',
          },
          'read',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    /**
     * The platform-name refusal, and the caller is an **owner** deliberately: a
     * member was already refused this branch for want of `docker:read`, so the
     * regression being pinned is the caller who *was* allowed.
     * `cloudgate-traefik` was in nobody's listing — not even the instance
     * owner's — and every one of the seven container routes handed it over by
     * id.
     */
    it.each([
      ['/cloudgate-traefik'],
      ['/cloudgate-backend'],
      ['/cloudgate-console'],
      // A Trace store, and one whose appName would otherwise have
      // matched the `cloudgate-monitoring` carve-out.
      ['/cloudgate-trace-store-application-web'],
      ['/cloudgate-trace-store-compose-cloudgate-monitoring'],
    ])(
      'refuses %s, one of the containers this instance runs for itself',
      async (name) => {
        const { ownerCtx } = await setUpApplication();
        remoteExec.execAsync.mockResolvedValue(
          labels(undefined, undefined, undefined, name),
        );

        await expect(
          access.authorizeContainer(
            ownerCtx,
            { containerId: '9ba49dc3087c' },
            'read',
          ),
        ).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);
      },
    );

    /**
     * The swarm-addressed half. `traefik-files.service.ts` records that Traefik
     * runs either standalone (`cloudgate-traefik`) or as a swarm task, and
     * `container-logs.gateway.ts` accepts `runType=swarm` — which resolves
     * through `.Spec.Name` and would otherwise stream the platform's ingress
     * log. A fix that only reads a container's `{{.Name}}` leaves this open.
     */
    it("refuses the platform's Traefik addressed as a swarm service", async () => {
      const { ownerCtx } = await setUpApplication();
      remoteExec.execAsync.mockResolvedValue({
        stdout: 'cloudgate-traefik|<no value>\n',
        stderr: '',
        exitCode: 0,
      });

      await expect(
        access.authorizeContainer(
          ownerCtx,
          {
            containerId: 'cloudgate-traefik',
            runType: 'swarm',
          },
          'read',
        ),
      ).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);
    });

    /** The carve-out, asserted rather than assumed: the operator sets
     * `cloudgate-monitoring` up and manages it from the console. */
    it('still reaches cloudgate-monitoring, which the operator manages', async () => {
      const { ownerCtx } = await setUpApplication();
      remoteExec.execAsync.mockResolvedValue(
        labels(undefined, undefined, undefined, '/cloudgate-monitoring'),
      );

      await expect(
        access.authorizeContainer(ownerCtx, { containerId: 'ghi789' }, 'read'),
      ).resolves.toEqual([]);
    });

    /** What says the branch was *narrowed* rather than closed. */
    it('still reaches an unmanaged container an operator started by hand', async () => {
      const { ownerCtx } = await setUpApplication();
      remoteExec.execAsync.mockResolvedValue(
        labels(undefined, undefined, undefined, '/traefik-proxy'),
      );

      await expect(
        access.authorizeContainer(
          ownerCtx,
          { containerId: 'abc123def456' },
          'read',
        ),
      ).resolves.toEqual([]);
    });

    /**
     * The case the *listing's* old test order got wrong, and the reason the
     * name test now sits behind the owner-label parse: an Application a member
     * legitimately called `my-cloudgate-api` carries owner labels, resolves to
     * its Service, and never reaches the name test at all.
     */
    it('does not refuse an Application a member named after the platform', async () => {
      const { ownerCtx, environment } = await setUpApplication();
      await applications.create(ownerCtx, {
        name: 'Cloudgate API',
        appName: 'my-cloudgate-api',
        environmentId: environment.environmentId,
      });
      remoteExec.execAsync.mockResolvedValue(
        labels(
          'my-cloudgate-api',
          undefined,
          undefined,
          '/my-cloudgate-api-abc123',
        ),
      );

      await expect(
        access.authorizeContainer(
          ownerCtx,
          { containerId: 'abc123def456' },
          'read',
        ),
      ).resolves.toEqual(['my-cloudgate-api']);
    });
  });

  /**
   * The half of ADR-0008's machine branch ADR-0013 decides
   * differently: **which machine**.
   *
   * An unmanaged container is reached through machine-level Docker access, and
   * on the platform host that was two organization-level questions and nothing
   * else — the `docker` statement, which owner, admin and any licensed custom
   * role can hold, and `checkServerAccess`, which returns for an absent
   * `serverId` by design (ADR-0008's second consequence). The machine behind
   * that branch is the one every organization's services share, so an owner of
   * *any* organization reached an operator's own sidecar there: the five
   * destructive verbs and `docker cp` over HTTP, and its logs and an
   * interactive `docker exec` shell over the sockets.
   *
   * The instance-authority split used for `PatchRepoService.cleanRepos` is
   * the shape, and ADR-0013 carries the decision. Every case below uses a real
   * second Organization with a real owner row rather than a second `activeOrganizationId`
   * on one account, because the check reads member rows and a single account
   * that owns both would pass it legitimately.
   */
  describe('an unmanaged container on the platform host', () => {
    /**
     * `secondOrganizationOwner` is Mallory: owner of her own Organization,
     * member of nothing else, and — because her owner row is the *later* one —
     * not the instance's authority.
     */
    async function setUpSecondOrganization() {
      const { ownerSession, ownerCtx, organizationId } =
        await setUpApplication();
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
      );
      return {
        ownerSession,
        ownerCtx,
        organizationId,
        mallory,
        malloryCtx: permissionCtx(mallory.id, mallory.organizationId),
      };
    }

    it('is refused to an owner of another organization, who holds docker:read in their own', async () => {
      const { malloryCtx } = await setUpSecondOrganization();
      remoteExec.execAsync.mockResolvedValue(
        labels(undefined, undefined, undefined, '/operator-sidecar'),
      );

      await expect(
        access.authorizeContainer(
          malloryCtx,
          { containerId: 'abc123def456' },
          'read',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    /**
     * The refusal must not become an oracle on the way in.
     * `checkInstanceAuthority`'s own sentence names the platform host, so
     * letting it out would tell this caller *"that id resolved to no Service"*
     * apart from *"that id belongs to a Service you may not reach"* — which is
     * the enumeration ADR-0008's one-close-code bullet forbids, reopened by the
     * fix for it. Asserted against the two messages side by side rather than
     * against a literal, because the property is that they are the same one.
     */
    it('answers it with the one container refusal and never names the platform host', async () => {
      const { malloryCtx } = await setUpSecondOrganization();

      const thrown: Error[] = [];

      remoteExec.execAsync.mockResolvedValue(
        labels(undefined, undefined, undefined, '/operator-sidecar'),
      );
      await access
        .authorizeContainer(malloryCtx, { containerId: 'abc123def456' }, 'read')
        .catch((error: Error) => thrown.push(error));

      // `web-app` is a real Application in the instance organization, so this
      // is the foreign-Service refusal the sentence above must match.
      remoteExec.execAsync.mockResolvedValue(labels('web-app'));
      await access
        .authorizeContainer(malloryCtx, { containerId: 'abc123def456' }, 'read')
        .catch((error: Error) => thrown.push(error));

      expect(thrown).toHaveLength(2);
      const [unmanaged, foreign] = thrown;
      expect(unmanaged.message).toBe(foreign.message);
      expect(unmanaged.message).toBe(CONTAINER_DENIAL_MESSAGE);
      expect(unmanaged.message).not.toContain('instance organization');
    });

    /** The journal keeps what the wire may not (ADR-0008). */
    it('records in the journal that instance authority was what refused it', async () => {
      const { malloryCtx, mallory } = await setUpSecondOrganization();
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        remoteExec.execAsync.mockResolvedValue(
          labels(undefined, undefined, undefined, '/operator-sidecar'),
        );
        await access
          .authorizeContainer(
            malloryCtx,
            { containerId: 'abc123def456' },
            'read',
          )
          .catch(() => undefined);

        const journal = warn.mock.calls.map(([line]) => String(line));
        expect(
          journal.some(
            (line) =>
              line.includes('instance authority') && line.includes(mallory.id),
          ),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    /**
     * The no-op claim ADR-0013 rests on, at this surface: on the
     * single-organization install `deploy/install.sh` produces, the one
     * Organization *is* the instance organization, so nothing an operator does
     * today stops working.
     */
    it('is still reachable by an owner of the instance organization', async () => {
      const { ownerCtx } = await setUpApplication();
      remoteExec.execAsync.mockResolvedValue(
        labels(undefined, undefined, undefined, '/operator-sidecar'),
      );

      await expect(
        access.authorizeContainer(
          ownerCtx,
          { containerId: 'abc123def456' },
          'read',
        ),
      ).resolves.toEqual([]);
    });

    /**
     * And by its admins, which is the delegation an operator really makes —
     * ADR-0013's own argument for `checkInstanceAuthority` admitting both
     * rather than an instance *owner* alone. Docker hygiene on the platform
     * host is a job that gets handed to an admin.
     */
    it('is still reachable by an admin of the instance organization', async () => {
      const { ownerSession, organizationId } = await setUpApplication();
      const admin = await inviteUser(
        server,
        ownerSession.cookie,
        'admin@example.com',
        'admin',
      );
      remoteExec.execAsync.mockResolvedValue(
        labels(undefined, undefined, undefined, '/operator-sidecar'),
      );

      await expect(
        access.authorizeContainer(
          permissionCtx(admin.id, organizationId),
          {
            containerId: 'abc123def456',
          },
          'read',
        ),
      ).resolves.toEqual([]);
    });

    /**
     * `cloudgate-monitoring` is the container the predicate deliberately
     * excludes because the operator sets it up and manages it from the console
     * (CONTEXT.md), which makes it unmanaged on the platform host *by
     * construction* and therefore the one legitimate thing most likely to be
     * broken by this. It is not: the operator who manages it is the instance
     * organization's owner or admin, which is exactly who still passes.
     */
    it('still reaches cloudgate-monitoring for the operator who manages it', async () => {
      const { ownerCtx } = await setUpApplication();
      remoteExec.execAsync.mockResolvedValue(
        labels(undefined, undefined, undefined, '/cloudgate-monitoring'),
      );

      await expect(
        access.authorizeContainer(ownerCtx, { containerId: 'ghi789' }, 'read'),
      ).resolves.toEqual([]);
    });

    /**
     * The other half of the split, and the reason the parameter is a `serverId`
     * rather than a flag: **a named Server keeps organization authority**
     * (ADR-0013's second consequence). Mallory's own Server is a real row in
     * her own Organization — a `serverId` with no row behind it would be a 404
     * from `checkServerAccess` and could not tell a passing check from one that
     * never ran.
     */
    it("leaves an unmanaged container on the caller's own Server on machine Docker access", async () => {
      const { malloryCtx } = await setUpSecondOrganization();
      const key = await sshKeys.create(malloryCtx, { name: 'mallory-key' });
      const own = await servers.create(malloryCtx, {
        name: 'mallory-1',
        ipAddress: '203.0.113.20',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      remoteExec.execAsyncRemote.mockResolvedValue(
        labels(undefined, undefined, undefined, '/operator-sidecar'),
      );

      await expect(
        access.authorizeContainer(
          malloryCtx,
          {
            containerId: 'abc123def456',
            serverId: own.serverId,
          },
          'read',
        ),
      ).resolves.toEqual([]);
      // The inspect really went to her Server rather than to the local daemon,
      // which is what says the branch under test is the one that ran.
      expect(remoteExec.execAsyncRemote).toHaveBeenCalled();
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });
  });

  /**
   * With `runType=swarm` the socket's parameter is a *swarm service* name, not a
   * container id — `docker service logs` takes one, and the frontend sends it
   * for every database and for a compose stack's services. A swarm Service
   * object has no `.Config`, so inspecting it as a container fails outright;
   * resolving it has to ask the service for its own name and stack namespace.
   */
  describe('a swarm-service-addressed target', () => {
    it('resolves through the swarm service name', async () => {
      const { ownerCtx } = await setUpApplication();
      remoteExec.execAsync.mockResolvedValue({
        stdout: 'web-app|<no value>\n',
        stderr: '',
        exitCode: 0,
      });

      await expect(
        access.authorizeContainer(
          ownerCtx,
          {
            containerId: 'web-app',
            runType: 'swarm',
          },
          'read',
        ),
      ).resolves.toEqual(['web-app']);
      expect(remoteExec.execAsync.mock.calls[0][0]).toContain('--type service');
    });

    it('resolves a stack service through its namespace, not its prefixed name', async () => {
      const { ownerCtx, environment } = await setUpApplication();
      await composes.create(ownerCtx, {
        name: 'Stack',
        appName: 'my-stack',
        environmentId: environment.environmentId,
        composeType: 'stack',
      });
      // `.Spec.Name` is `${appName}_${serviceName}`, which matches no row; the
      // namespace label is what names the Service.
      remoteExec.execAsync.mockResolvedValue({
        stdout: 'my-stack_web|my-stack\n',
        stderr: '',
        exitCode: 0,
      });

      await expect(
        access.authorizeContainer(
          ownerCtx,
          {
            containerId: 'my-stack_web',
            runType: 'swarm',
          },
          'read',
        ),
      ).resolves.toEqual(['my-stack_web', 'my-stack']);
    });

    it('is refused to a member the Service is withheld from', async () => {
      const { ownerSession, organizationId } = await setUpApplication();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      remoteExec.execAsync.mockResolvedValue({
        stdout: 'web-app|<no value>\n',
        stderr: '',
        exitCode: 0,
      });

      await expect(
        access.authorizeContainer(
          permissionCtx(invitee.id, organizationId),
          {
            containerId: 'web-app',
            runType: 'swarm',
          },
          'read',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  /**
   * A managed container belongs to a Service in **this instance's** database
   * (CONTEXT.md) — not merely in the caller's organization. Resolving only
   * within the organization would make another organization's container look
   * unmanaged, and the unmanaged branch hands it to anyone holding
   * `docker:read`, which every owner and admin does. That is the original
   * complaint — reachable "regardless of which organization owns it" — surviving
   * inside the fix.
   */
  describe('a container managed by another organization', () => {
    it('is refused outright, not treated as unmanaged', async () => {
      const { ownerSession } = await setUpApplication();

      // A second organization the same user owns, and so holds docker:read in.
      const second = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (second.body as { id: string }).id;

      remoteExec.execAsync.mockResolvedValue(labels('web-app'));

      await expect(
        access.authorizeContainer(
          permissionCtx(ownerSession.id, secondOrgId),
          {
            containerId: 'abc123def456',
          },
          'read',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  /**
   * A label is a claim, and on the platform host it is a claim about a machine
   * the Service may not run on. A customer picks their own `appName`,
   * so anything on the shared box that happens to carry a label naming their
   * Service — a sidecar, an operator's own Compose project — was theirs to
   * shell into, stop, `rm -f` and `docker cp` into, because the gate resolved
   * the label and never asked where that Service runs. Now a Service clears
   * the entitlement branch on the platform host only when its own place is
   * the platform host; anything else takes the machine branch, which there
   * asks for instance authority.
   */
  describe('a platform-host container labelled for a Service placed elsewhere', () => {
    /** Mallory owns her Organization, a Server in it, and an Application on it. */
    async function setUpServiceOnServer() {
      const { ownerSession, ownerCtx } = await setUpApplication();
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
      );
      const malloryCtx = permissionCtx(mallory.id, mallory.organizationId);
      const key = await sshKeys.create(malloryCtx, { name: 'mallory-key' });
      const own = await servers.create(malloryCtx, {
        name: 'mallory-1',
        ipAddress: '203.0.113.30',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      const project = await projects.create(malloryCtx, { name: 'shop' });
      const environment = await environments.create(malloryCtx, {
        name: 'production',
        projectId: project.projectId,
        deployTarget: { kind: 'server', serverId: own.serverId },
      });
      await applications.create(malloryCtx, {
        name: 'Traefik',
        appName: 'traefik',
        environmentId: environment.environmentId,
        serverId: own.serverId,
      });
      return { ownerCtx, malloryCtx, serverId: own.serverId };
    }

    it('is refused to the owner of that Service on every container route', async () => {
      const { malloryCtx } = await setUpServiceOnServer();
      remoteExec.execAsync.mockResolvedValue(
        labels(undefined, 'traefik', undefined, '/operator-proxy'),
      );

      // `read` is the log socket's and the listings' action, `update` the
      // terminal's; the five lifecycle verbs and the upload go through the
      // same `authorizeContainer` on the platform host.
      for (const action of ['read', 'update'] as const) {
        await expect(
          access.authorizeContainer(
            malloryCtx,
            { containerId: 'abc123def456' },
            action,
          ),
        ).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);
      }
    });

    it('is refused on renewal too, which re-runs the gate and not the inspect', async () => {
      const { malloryCtx } = await setUpServiceOnServer();

      await expect(
        access.authorizeAppNames(malloryCtx, ['traefik'], undefined, 'read'),
      ).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('is still her Service on the Server it runs on', async () => {
      const { malloryCtx, serverId } = await setUpServiceOnServer();
      remoteExec.execAsyncRemote.mockResolvedValue(
        labels(undefined, 'traefik', undefined, '/traefik-web-1'),
      );

      await expect(
        access.authorizeContainer(
          malloryCtx,
          { containerId: 'abc123def456', serverId },
          'update',
        ),
      ).resolves.toEqual(['traefik']);
    });

    it('is an unmanaged container to the instance authority, on the platform host', async () => {
      const { ownerCtx, serverId } = await setUpServiceOnServer();

      await expect(
        access.authorizeAppNames(ownerCtx, ['traefik'], undefined, 'read'),
      ).resolves.toBe('machine');
      // And the listing reads it the same way, so it never offers a row the
      // routes would then refuse.
      await expect(
        access.unownedAppNames(['traefik'], undefined),
      ).resolves.toEqual(new Set(['traefik']));
      await expect(
        access.unownedAppNames(['traefik'], serverId),
      ).resolves.toEqual(new Set());
    });
  });

  /**
   * `appName` is `.unique()` per service table but not across them, so a
   * resolution matching more than one Service fails closed rather than picking
   * the first.
   */
  describe('an ambiguous resolution', () => {
    it('is a denial, not a first-match win', async () => {
      const { ownerCtx, environment } = await setUpApplication();
      await postgres.create(ownerCtx, {
        name: 'Main DB',
        appName: 'web-app',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
      });
      remoteExec.execAsync.mockResolvedValue(labels('web-app'));

      await expect(
        access.authorizeContainer(
          ownerCtx,
          { containerId: 'abc123def456' },
          'read',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  /**
   * A preview's `appName` is unique and lives in its own table, not among the
   * eight; entitlement is the parent Application's. Without this the service
   * gate would silently break every preview's logs and terminal.
   */
  describe('a preview deployment', () => {
    it('resolves through its parent Application', async () => {
      const { ownerSession, organizationId, app } = await setUpApplication();
      await ctx.db.insert(previewDeployment).values({
        appName: 'preview-web-app-abc',
        applicationId: app.applicationId,
        branch: 'feature/x',
        pullRequestId: '1',
        pullRequestNumber: '1',
        pullRequestTitle: 'Add a thing',
        pullRequestURL: 'https://example.com/pr/1',
        domain: 'preview-web-app-abc.example.com',
      });
      remoteExec.execAsync.mockResolvedValue(labels('preview-web-app-abc'));

      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        access.authorizeContainer(
          ownerCtx,
          { containerId: 'abc123def456' },
          'read',
        ),
      ).resolves.toEqual(['preview-web-app-abc']);
    });

    it('is refused to a member the parent Application is withheld from', async () => {
      const { ownerSession, organizationId, app } = await setUpApplication();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      await ctx.db.insert(previewDeployment).values({
        appName: 'preview-web-app-abc',
        applicationId: app.applicationId,
        branch: 'feature/x',
        pullRequestId: '1',
        pullRequestNumber: '1',
        pullRequestTitle: 'Add a thing',
        pullRequestURL: 'https://example.com/pr/1',
        domain: 'preview-web-app-abc.example.com',
      });
      remoteExec.execAsync.mockResolvedValue(labels('preview-web-app-abc'));

      await expect(
        access.authorizeContainer(
          permissionCtx(invitee.id, organizationId),
          {
            containerId: 'abc123def456',
          },
          'read',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  /**
   * The stats socket is addressed by `appName` directly rather than by
   * container id, so it resolves without inspecting anything.
   *
   * **On `authorizeAppNames` with one name**, which is what
   * `DockerStatsGateway.resolveAndAuthorize` really calls. The singular
   * `authorizeAppName` spelling these cases used to drive had no caller in
   * `src` from the moment that socket moved off it, and survived only
   * here; the properties below are the socket's and not the spelling's, so they
   * moved rather than went.
   */
  describe('an appName-addressed socket', () => {
    it('is authorized against the Service that appName names', async () => {
      const { ownerSession, organizationId } = await setUpApplication();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );

      await expect(
        access.authorizeAppNames(
          permissionCtx(invitee.id, organizationId),
          ['web-app'],
          undefined,
          'read',
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(remoteExec.execAsync).not.toHaveBeenCalled();

      // The branch comes back rather than nothing, because the stats socket
      // cannot tell a Service's name from a container's without it.
      await expect(
        access.authorizeAppNames(
          permissionCtx(ownerSession.id, organizationId),
          ['web-app'],
          undefined,
          'read',
        ),
      ).resolves.toBe('service');
    });

    it('says the machine gate answered for a name no Service claims', async () => {
      const { ownerCtx } = await setUpApplication();

      await expect(
        access.authorizeAppNames(ownerCtx, ['zzz-nobody'], undefined, 'read'),
      ).resolves.toBe('machine');
    });
  });

  /**
   * The HTTP reads keyed on an `appName` — `GET /docker/containers/search`
   * and its three siblings — take `authorizeAppName`, and the metrics read,
   * which filters rather than refuses, takes `firstReadable`.
   */
  describe('authorizeAppName', () => {
    it("refuses the platform's own name on the machine branch, in the one sentence", async () => {
      const { ownerCtx } = await setUpApplication();

      await expect(
        access.authorizeAppName(ownerCtx, 'cloudgate-traefik', undefined),
      ).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);
      // The same caller clears the machine branch for any other unmanaged
      // name, so it was the platform name that refused and not the branch.
      await expect(
        access.authorizeAppName(ownerCtx, 'operator-sidecar', undefined),
      ).resolves.toBeUndefined();
      await expect(
        access.authorizeAppName(ownerCtx, 'cloudgate-monitoring', undefined),
      ).resolves.toBeUndefined();
      expect(remoteExec.execAsync).not.toHaveBeenCalled();
    });

    it('does not refuse a Service a member named after the platform', async () => {
      const { ownerCtx, environment } = await setUpApplication();
      await applications.create(ownerCtx, {
        name: 'Cloudgate API',
        appName: 'my-cloudgate-api',
        environmentId: environment.environmentId,
      });

      await expect(
        access.authorizeAppName(ownerCtx, 'my-cloudgate-api', undefined),
      ).resolves.toBeUndefined();
    });
  });

  describe('firstReadable', () => {
    it('answers the set an entitled caller may read, and -1 to a refused one', async () => {
      const { ownerSession, organizationId, ownerCtx } =
        await setUpApplication();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );

      await expect(
        access.firstReadable(ownerCtx, [['web-app']], undefined),
      ).resolves.toBe(0);
      await expect(
        access.firstReadable(
          permissionCtx(invitee.id, organizationId),
          [['web-app']],
          undefined,
        ),
      ).resolves.toBe(-1);
    });

    /**
     * The caller chooses how many sets there are — a short metrics substring
     * matches every series on the host — so a caller who may read none of them
     * must not pay one resolution per set.
     */
    it('resolves every name in one read and asks once per distinct owner set', async () => {
      const { ownerSession, organizationId } = await setUpApplication();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const serviceAccess = jest.spyOn(permissions, 'checkServiceAccess');
      const statement = jest.spyOn(permissions, 'checkPermission');
      const sets = Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0 ? ['web-app', `web-app-${i}`] : [`sidecar-${i}`],
      );

      try {
        await expect(
          access.firstReadable(
            permissionCtx(invitee.id, organizationId),
            sets,
            undefined,
          ),
        ).resolves.toBe(-1);
        // Ten sets owned by web-app, one Service: one entitlement check.
        expect(serviceAccess).toHaveBeenCalledTimes(1);
        // Ten unmanaged sets: one machine-branch check. (checkServiceAccess
        // asks its own `service` statement, which is not this one.)
        expect(
          statement.mock.calls.filter(([, asked]) => 'docker' in asked),
        ).toHaveLength(1);
      } finally {
        serviceAccess.mockRestore();
        statement.mockRestore();
      }
    });

    it('rethrows a failure that is not a refusal', async () => {
      const { ownerCtx } = await setUpApplication();
      const failure = new Error('connection pool exhausted');
      const spy = jest
        .spyOn(permissions, 'checkServiceAccess')
        .mockRejectedValue(failure);

      try {
        await expect(
          access.firstReadable(ownerCtx, [['web-app']], undefined),
        ).rejects.toBe(failure);
      } finally {
        spy.mockRestore();
      }
    });
  });

  /**
   * The entitlement branch asks for the action its caller names — `read`
   * for a log, a stats sample or a listing, `update` for a shell — and a
   * read-only custom role is refused the second in the one sentence.
   */
  describe('the action asked of the owning Service', () => {
    /** A licensed custom role holding exactly `permission`, entitled to `app`. */
    async function customRoleOn(
      organizationId: string,
      ownerCookie: string,
      serviceId: string,
      permission: Record<string, string[]>,
    ) {
      const invitee = await inviteUser(
        server,
        ownerCookie,
        'reader@example.com',
        'member',
      );
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
        .set({ role: 'service-reader', accessedServices: [serviceId] })
        .where(
          and(
            eq(member.userId, invitee.id),
            eq(member.organizationId, organizationId),
          ),
        );
      return permissionCtx(invitee.id, organizationId);
    }

    it('clears a built-in member entitled to the Service for update, holding no docker action', async () => {
      const { ownerSession, organizationId, app } = await setUpApplication();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);
      await permissions.addNewService(inviteeCtx, app.applicationId);
      remoteExec.execAsync.mockResolvedValue(labels('web-app'));

      await expect(
        access.authorizeContainer(
          inviteeCtx,
          { containerId: 'abc123def456' },
          'update',
        ),
      ).resolves.toEqual(['web-app']);
    });

    it('reads for a custom role holding service read, and refuses it update in the one sentence', async () => {
      const { ownerSession, organizationId, app } = await setUpApplication();
      const readerCtx = await customRoleOn(
        organizationId,
        ownerSession.cookie,
        app.applicationId,
        { service: ['read'] },
      );
      remoteExec.execAsync.mockResolvedValue(labels('web-app'));

      await expect(
        access.authorizeContainer(
          readerCtx,
          { containerId: 'abc123def456' },
          'read',
        ),
      ).resolves.toEqual(['web-app']);
      await expect(
        access.authorizeContainer(
          readerCtx,
          { containerId: 'abc123def456' },
          'update',
        ),
      ).rejects.toThrow(new ForbiddenException(CONTAINER_DENIAL_MESSAGE));
    });

    it('leaves an unmanaged container on its machine gate whatever the action', async () => {
      const { ownerCtx } = await setUpApplication();

      await expect(
        access.authorizeAppNames(ownerCtx, [], undefined, 'update'),
      ).resolves.toBe('machine');
    });

    describe('authorizeService', () => {
      it('answers where an entitled Service runs and how it is labelled', async () => {
        const { ownerCtx, environment, app } = await setUpApplication();
        const stack = await composes.create(ownerCtx, {
          name: 'Stack',
          appName: 'my-stack',
          environmentId: environment.environmentId,
          composeType: 'stack',
        });

        await expect(
          access.authorizeService(
            ownerCtx,
            { serviceType: 'application', serviceId: app.applicationId },
            'update',
          ),
        ).resolves.toEqual({
          appName: 'web-app',
          serverId: null,
          composeType: null,
          inCloud: false,
        });
        await expect(
          access.authorizeService(
            ownerCtx,
            { serviceType: 'compose', serviceId: stack.composeId },
            'update',
          ),
        ).resolves.toEqual({
          appName: 'my-stack',
          serverId: null,
          composeType: 'stack',
          inCloud: false,
        });
      });

      it('refuses a read-only role, a foreign Service and an id naming nothing in one sentence', async () => {
        const { ownerSession, organizationId, app } = await setUpApplication();
        const readerCtx = await customRoleOn(
          organizationId,
          ownerSession.cookie,
          app.applicationId,
          { service: ['read'] },
        );
        const second = await createOrganization(
          server,
          ctx.db,
          ownerSession.cookie,
          { name: 'Second Org' },
        );
        const secondOrgCtx = permissionCtx(
          ownerSession.id,
          (second.body as { id: string }).id,
        );

        const thrown: Error[] = [];
        for (const [ctxOf, serviceId] of [
          [readerCtx, app.applicationId],
          [secondOrgCtx, app.applicationId],
          [readerCtx, 'never-existed'],
        ] as const) {
          await access
            .authorizeService(
              ctxOf,
              { serviceType: 'application', serviceId },
              'update',
            )
            .catch((error: Error) => thrown.push(error));
        }

        expect(thrown).toHaveLength(3);
        expect(new Set(thrown.map((error) => error.message))).toEqual(
          new Set([CONTAINER_DENIAL_MESSAGE]),
        );
        for (const error of thrown) {
          expect(error).toBeInstanceOf(ForbiddenException);
        }
      });
    });
  });

  /**
   * ADR-0008's one-close-code bullet, one layer above the socket: a
   * caller who can tell "that id is a real Service belonging to someone else"
   * from "that id belongs to nobody" can walk another organization's namespace.
   * The three refusals were three different messages and one of them
   * interpolated the container's own owner labels onto the wire.
   */
  describe('every refusal says the same thing', () => {
    /**
     * Every situation that refuses, each thrown by a caller who exists.
     *
     * **The last two are the newest, and they are what makes this block able to
     * fail.** The three before them are thrown by a caller who *holds* `docker:
     * ['read']`, so none of them ever reached the statement check that sits in
     * front of {@link ContainerAccessService.authorizeAppNames}' machine branch
     * — and that check answers better-auth's own sentence rather than this
     * surface's. `memberRole` grants `docker: []` in both products, so for a
     * base member at this seam an unmanaged container said one thing and a
     * container somebody else's Service owns said another: a fifth
     * distinguishable answer of exactly the class the uniform denial closed
     * four of, arriving from in front of the branch rather than from inside it.
     *
     * **A base member is the cheapest caller to build here and not the one who
     * could reach it over HTTP** — all three routes on `DockerOpsService` ask
     * for a `docker` statement first, so a member is refused before the gate.
     * The caller who really got the two sentences apart is a licensed custom
     * role granted `docker: ['write']` alone, which clears those routes and
     * fails this branch's `docker: ['read']`, and that one is pinned over the
     * wire in `docker-ops.e2e-spec.ts`. This block pins the invariant at the
     * seam, where it is stated.
     *
     * They are **the same caller twice** on purpose. A set taken across
     * different callers cannot say that any one caller could not tell the two
     * apart, which is the property ADR-0008's one-close-code bullet is about.
     */
    async function everyRefusal(): Promise<{
      thrown: Error[];
      memberCtx: ReturnType<typeof permissionCtx>;
    }> {
      const { ownerSession, ownerCtx, environment, organizationId } =
        await setUpApplication();

      // Foreign: a real Application in an organization the caller is not in.
      const second = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (second.body as { id: string }).id,
      );

      // Ambiguous: `appName` is unique per table and not across them, so an
      // Application and a database may both answer to `twin`. A separate name
      // from the foreign case, or the foreign container would resolve to two
      // services and take the ambiguous branch instead.
      await applications.create(ownerCtx, {
        name: 'Twin App',
        appName: 'twin',
        environmentId: environment.environmentId,
      });
      await postgres.create(ownerCtx, {
        name: 'Twin DB',
        appName: 'twin',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
      });

      const thrown: Error[] = [];

      remoteExec.execAsync.mockResolvedValue(labels('web-app'));
      await access
        .authorizeContainer(
          secondOrgCtx,
          { containerId: 'abc123def456' },
          'read',
        )
        .catch((error: Error) => thrown.push(error));

      remoteExec.execAsync.mockResolvedValue(labels('twin'));
      await access
        .authorizeContainer(ownerCtx, { containerId: 'cccccccccccc' }, 'read')
        .catch((error: Error) => thrown.push(error));

      // Unknown: the inspect itself fails, the way the daemon fails.
      remoteExec.execAsync.mockRejectedValue(
        new Error('Error: No such container: deadbeef1234'),
      );
      await access
        .authorizeContainer(ownerCtx, { containerId: 'deadbeef1234' }, 'read')
        .catch((error: Error) => thrown.push(error));

      // Not entitled to the machine at all: a base member of the
      // instance organization, holding `docker: []`, against an unmanaged
      // container and then against the ambiguous resolution above. The
      // ambiguous one is refused before any statement is consulted, so the pair
      // is the statement's answer beside this surface's own.
      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const memberCtx = permissionCtx(member.id, organizationId);

      remoteExec.execAsync.mockResolvedValue(
        labels(undefined, undefined, undefined, '/operator-sidecar'),
      );
      await access
        .authorizeContainer(memberCtx, { containerId: 'abc123def456' }, 'read')
        .catch((error: Error) => thrown.push(error));

      remoteExec.execAsync.mockResolvedValue(labels('twin'));
      await access
        .authorizeContainer(memberCtx, { containerId: 'cccccccccccc' }, 'read')
        .catch((error: Error) => thrown.push(error));

      // Not entitled to the **workload**: the same member again, against
      // a container their own organization owns and their member row does not
      // name. This is the branch *beside* the two above — `checkServiceAccess`
      // rather than the machine gate — and it threw that method's own sentence
      // out of `authorizeAppNames` verbatim until it was fixed, so ADR-0008's
      // *not-entitled*, the first refusal the one-close-code bullet names, was
      // the one this block never covered. `memberRole` holds
      // `service: ['read']`, so the statement clears and the refusal is the
      // member row's; the statement half is pinned over the wire in
      // `docker-ops.e2e-spec.ts`, where the caller who can reach it lives.
      remoteExec.execAsync.mockResolvedValue(labels('web-app'));
      await access
        .authorizeContainer(memberCtx, { containerId: 'dddddddddddd' }, 'read')
        .catch((error: Error) => thrown.push(error));

      expect(thrown).toHaveLength(6);
      return { thrown, memberCtx };
    }

    it('answers a foreign Service, an ambiguous resolution, an unknown container, a caller holding no docker action and one not entitled to the Service with one message', async () => {
      const { thrown } = await everyRefusal();

      // Compared as a set rather than one assertion per situation against a
      // literal: the property is indistinguishability, and a set survives a
      // sixth denial being added without the test having to name it.
      expect(new Set(thrown.map((error) => error.message)).size).toBe(1);
      expect(thrown[0].message).toBe(CONTAINER_DENIAL_MESSAGE);
      for (const error of thrown) {
        expect(error).toBeInstanceOf(ForbiddenException);
      }
    });

    /**
     * Named, because the set assertion above would also go green if every
     * refusal moved to `PermissionService`'s sentence — which is the fix nobody
     * should take: `docker: ['read']` is an organization capability and its own
     * refusal is meaningful on `GET /docker/containers` and the swarm routes,
     * where there is no id to leak. So the sentence is checked against the one
     * `checkPermission` really answers this caller, asked here directly rather
     * than assumed from a literal.
     */
    it('does not answer a caller holding no docker action in the words the statement check uses', async () => {
      const { thrown, memberCtx } = await everyRefusal();
      const [, , , unmanaged, ambiguous] = thrown;

      // **The fixture's own premise, asserted.** A caller with no `member` row
      // in the active organization is refused by `findMember` with a *third*
      // sentence, so a member who never accepted their invitation would make
      // everything below pass while testing nothing — the shape this repo has
      // shipped a real hole behind. This says the row exists and carries the
      // base role, which is the role that grants `docker: []`.
      const record = await permissions.findMember(memberCtx);
      expect(record.role).toBe('member');

      const statementRefusal = await permissions
        .checkPermission(memberCtx, { docker: ['read'] })
        .then(
          () => null,
          (error: Error) => error.message,
        );

      // The statement really did refuse this caller — otherwise the branch
      // under test was never reached and the two assertions below are vacuous.
      expect(statementRefusal).not.toBeNull();
      expect(statementRefusal).not.toBe(CONTAINER_DENIAL_MESSAGE);

      expect(unmanaged.message).toBe(ambiguous.message);
      expect(unmanaged.message).not.toBe(statementRefusal);
    });

    it('never puts an owner label on the wire', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const {
          thrown: [, ambiguous],
        } = await everyRefusal();

        // The ambiguous message used to be `Container labels twin resolve to
        // more than one service` — handing back the container's own owner
        // labels, which is the thing being protected.
        expect(ambiguous.message).not.toContain('twin');
        const journal = warn.mock.calls.map(([line]) => String(line));
        expect(
          journal.some(
            (line) => line.includes('twin') && line.includes('2 services'),
          ),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    it('records which refusal it was in the journal', async () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const { memberCtx } = await everyRefusal();
        const journal = warn.mock.calls.map(([line]) => String(line));

        // ADR-0008 requires the distinction survive somewhere an operator can
        // read it; a test that only checked the wire would let it be deleted.
        expect(
          journal.some((line) => line.includes('belongs to service')),
        ).toBe(true);
        expect(
          journal.some((line) => line.includes('resolve to 2 services')),
        ).toBe(true);
        expect(
          journal.some((line) =>
            line.includes('Could not inspect deadbeef1234'),
          ),
        ).toBe(true);
        // The one the wire deliberately no longer carries: which
        // caller was refused for want of machine Docker access.
        expect(
          journal.some(
            (line) =>
              line.includes('machine-level docker:read') &&
              line.includes(memberCtx.user.id),
          ),
        ).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
