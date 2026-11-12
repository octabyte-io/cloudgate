import { App } from 'supertest/types';
import request from 'supertest';
import { ApplicationsService } from '../../../src/applications/applications.service';
import { ComposeService } from '../../../src/compose/compose.service';
import {
  forwardAuthSettings,
  member,
  ssoProvider,
  user,
} from '../../../src/db/schema';
import { DomainsService } from '../../../src/domains/domains.service';
import { EnvironmentsService } from '../../../src/environments/environments.service';
import { ProjectsService } from '../../../src/projects/projects.service';
import { ServersService } from '../../../src/servers/servers.service';
import { SshKeysService } from '../../../src/ssh-keys/ssh-keys.service';
import { RemoteDockerFactory } from '../../../src/docker/remote-docker.factory';
import { AuditLogService } from '../../../src/enterprise/audit-logs/audit-log.service';
import { ForwardAuthService } from '../../../src/enterprise/forward-auth/forward-auth.service';
import { LicenseService } from '../../../src/enterprise/license/license.service';
import type { PermissionCtx } from '../../../src/rbac/permission.service';
import type { FileConfig } from '../../../src/traefik/config/file-types';
import {
  dynamicTraefikConfigPath,
  TraefikWriterService,
} from '../../../src/traefik/traefik-writer.service';
import { createTestApp, TestAppContext } from '../../utils/test-app';
import { createOrganization as postOrganization } from '../../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ctxFor = (userId: string, organizationId: string): PermissionCtx => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

async function activeOrganizationId(
  server: App,
  cookie: string,
): Promise<string> {
  const res = await request(server)
    .get('/organizations/active')
    .set('Cookie', cookie);
  expect(res.status).toBe(200);
  return (res.body as { id: string }).id;
}

async function createOrganization(
  server: App,
  db: TestAppContext['db'],
  cookie: string,
  name: string,
): Promise<string> {
  const res = await postOrganization(server, db, cookie, { name });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

/** The pieces of the dockerode CreateServiceOptions the assertions read. */
interface ProxyServiceSpec {
  Name: string;
  TaskTemplate: { ContainerSpec: { Image: string; Env: string[] } };
}

describe('Forward auth (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let forwardAuth: ForwardAuthService;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let domains: DomainsService;
  let composeService: ComposeService;
  let servers: ServersService;
  let sshKeys: SshKeysService;
  let auditLogs: AuditLogService;

  let ownerCtx: PermissionCtx;
  let ownerCookie: string;

  const license = { hasValidLicense: jest.fn<Promise<boolean>, [string]>() };

  const traefikWriter = {
    loadOrCreateConfig: jest.fn<Promise<FileConfig>, [string]>(),
    writeConfig: jest.fn<Promise<void>, [string, FileConfig, string?]>(),
    removeConfig: jest.fn<Promise<void>, [string, string?]>(),
    writeCertificate: jest.fn<Promise<void>, [unknown]>(),
    removeCertificate: jest.fn<Promise<void>, [string]>(),
  };

  const dockerFactory = {
    getRemoteDocker: jest.fn<Promise<unknown>, [string | undefined | null]>(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: LicenseService, useValue: license },
        { provide: TraefikWriterService, useValue: traefikWriter },
        { provide: RemoteDockerFactory, useValue: dockerFactory },
      ],
    });
    httpServer = ctx.app.getHttpServer() as App;
    forwardAuth = ctx.app.get(ForwardAuthService);
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    domains = ctx.app.get(DomainsService);
    composeService = ctx.app.get(ComposeService);
    servers = ctx.app.get(ServersService);
    sshKeys = ctx.app.get(SshKeysService);
    auditLogs = ctx.app.get(AuditLogService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    license.hasValidLicense.mockResolvedValue(true);
    traefikWriter.loadOrCreateConfig.mockResolvedValue({});
    traefikWriter.writeConfig.mockResolvedValue(undefined);
    traefikWriter.removeConfig.mockResolvedValue(undefined);

    const session = await signUp(httpServer, owner);
    const organizationId = await activeOrganizationId(
      httpServer,
      session.cookie,
    );
    ownerCtx = ctxFor(session.id, organizationId);
    ownerCookie = session.cookie;
  });

  /** An OIDC provider on the caller's organization (phase 51 owns its CRUD). */
  async function seedProvider(
    providerId: string,
    overrides: {
      organizationId?: string;
      issuer?: string;
      oidcConfig?: string | null;
      samlConfig?: string | null;
    } = {},
  ): Promise<void> {
    await ctx.db.insert(ssoProvider).values({
      providerId,
      issuer: overrides.issuer ?? 'https://idp.example.com',
      domain: 'example.com',
      organizationId:
        overrides.organizationId ?? ownerCtx.session.activeOrganizationId,
      oidcConfig:
        overrides.oidcConfig === undefined
          ? JSON.stringify({
              clientId: 'client-abc',
              clientSecret: 'secret-xyz',
            })
          : overrides.oidcConfig,
      samlConfig: overrides.samlConfig ?? null,
    });
  }

  /**
   * A member who actually accepted the invitation — signing up with a token
   * alone creates no member row.
   */
  async function inviteMember(): Promise<PermissionCtx> {
    const { ctx: memberCtx } = await invite();
    return memberCtx;
  }

  async function inviteMemberCookie(): Promise<string> {
    const { cookie } = await invite();
    return cookie;
  }

  async function invite(): Promise<{ ctx: PermissionCtx; cookie: string }> {
    const invite = await request(httpServer)
      .post('/organizations/invitations')
      .set('Cookie', ownerCookie)
      .send({ email: 'invitee@example.com', role: 'member' });
    const inviteId = (invite.body as { id: string }).id;

    const su = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .set('x-cloudgate-token', inviteId)
      .send({
        name: 'Ida Rhodes',
        email: 'invitee@example.com',
        password: 'super-secret-password',
      });
    const inviteeCookie = su.headers['set-cookie'];
    const inviteeId = (su.body as { user: { id: string } }).user.id;

    const accept = await request(httpServer)
      .post(`/organizations/invitations/${inviteId}/accept`)
      .set('Cookie', inviteeCookie);
    expect(accept.status).toBe(201);

    return {
      ctx: ctxFor(inviteeId, ownerCtx.session.activeOrganizationId),
      cookie: inviteeCookie,
    };
  }

  /**
   * A docker daemon whose proxy is genuinely up: the service object exists and
   * the replica it asks for is a task in state 'running'.
   */
  function runningService() {
    const docker = {
      getService: jest.fn(() => ({
        inspect: jest.fn(() =>
          Promise.resolve({
            Version: { Index: '1' },
            Spec: {
              TaskTemplate: { ForceUpdate: 0 },
              Mode: { Replicated: { Replicas: 1 } },
            },
          }),
        ),
        update: jest.fn(),
        remove: jest.fn(),
      })),
      createService: jest.fn<Promise<unknown>, [unknown]>(),
      listTasks: jest.fn(() =>
        Promise.resolve([{ Status: { State: 'running' } }]),
      ),
    };
    dockerFactory.getRemoteDocker.mockResolvedValue(docker);
    return docker;
  }

  /**
   * The daemon the forward-auth bug was driven on: `docker service create` returned, so the
   * service object inspects fine, but every task oauth2-proxy starts exits 1 —
   * a bad client secret, an unreachable issuer, a wrong cookie domain. The
   * failure shows nowhere but the tasks, and `Status.Err` carries it verbatim.
   */
  function crashLoopingService(err = 'task: non-zero exit (1)') {
    const docker = {
      getService: jest.fn(() => ({
        inspect: jest.fn(() =>
          Promise.resolve({
            Version: { Index: '1' },
            Spec: {
              TaskTemplate: { ForceUpdate: 0 },
              Mode: { Replicated: { Replicas: 1 } },
            },
          }),
        ),
        update: jest.fn(),
        remove: jest.fn(),
      })),
      createService: jest.fn<Promise<unknown>, [unknown]>(),
      listTasks: jest.fn(() =>
        Promise.resolve([
          { Status: { State: 'failed', Err: err } },
          { Status: { State: 'failed', Err: err } },
        ]),
      ),
    };
    dockerFactory.getRemoteDocker.mockResolvedValue(docker);
    return docker;
  }

  /**
   * An application with one domain on the local server, an auth domain, and a
   * deployed proxy — everything `enableOnDomain` insists on.
   */
  async function setUpUngatedDomain() {
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const application = await applications.create(ownerCtx, {
      name: 'Blog',
      appName: 'blog-app',
      environmentId: environment.environmentId,
    });
    const domain = await domains.create(ownerCtx, {
      host: 'blog.example.com',
      applicationId: application.applicationId,
    });
    return { application, domain };
  }

  async function setUpGatedDomain() {
    const { application, domain } = await setUpUngatedDomain();

    await forwardAuth.setAuthDomain(ownerCtx, {
      serverId: null,
      authDomain: 'auth.example.com',
      https: true,
      certificateType: 'letsencrypt',
    });
    await seedProvider('okta');
    absentService();
    await forwardAuth.deployOnServer(ownerCtx, {
      serverId: null,
      providerId: 'okta',
    });
    runningService();

    return { application, domain };
  }

  /** An auth domain on the platform host with a proxy deployed behind it. */
  async function setUpDeployedProxy() {
    await forwardAuth.setAuthDomain(ownerCtx, {
      serverId: null,
      authDomain: 'auth.example.com',
      https: true,
      certificateType: 'letsencrypt',
    });
    await seedProvider('okta');
    absentService();
    await forwardAuth.deployOnServer(ownerCtx, {
      serverId: null,
      providerId: 'okta',
    });
  }

  /** Every write of the auth domain's /oauth2 router, in order. */
  function authDomainWrites() {
    return traefikWriter.writeConfig.mock.calls.filter(
      ([name]) => name === 'forward-auth-domain',
    );
  }

  /** The app config the writer was last handed (Traefik's per-app file). */
  function lastAppConfig(): FileConfig {
    const calls = traefikWriter.writeConfig.mock.calls.filter(
      ([name]) => name !== 'forward-auth-domain',
    );
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][1];
  }

  /** A docker daemon with no proxy service yet — `inspect` is how it is probed. */
  function absentService() {
    const docker = {
      getService: jest.fn(() => ({
        inspect: jest.fn(() => Promise.reject(new Error('no such service'))),
        update: jest.fn(),
        remove: jest.fn(),
      })),
      createService: jest.fn<Promise<unknown>, [unknown]>(),
      listTasks: jest.fn(() => Promise.resolve([])),
    };
    dockerFactory.getRemoteDocker.mockResolvedValue(docker);
    return docker;
  }

  describe('auth domain settings', () => {
    it('stores the auth domain with its derived base domain and answers the callback url', async () => {
      const result = await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });

      expect(result).toEqual({
        callbackUrl: 'https://auth.example.com/oauth2/callback',
      });

      await expect(forwardAuth.getAuthDomain(ownerCtx, null)).resolves.toEqual({
        host: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
        customCertResolver: null,
        callbackUrl: 'https://auth.example.com/oauth2/callback',
      });
    });

    it('routes /oauth2/* on the auth domain to the proxy at high priority', async () => {
      runningService();
      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });

      expect(traefikWriter.writeConfig).toHaveBeenCalledWith(
        'forward-auth-domain',
        {
          http: {
            routers: {
              'forward-auth-oauth': {
                rule: 'Host(`auth.example.com`) && PathPrefix(`/oauth2/`)',
                service: 'forward-auth-proxy',
                entryPoints: ['websecure'],
                priority: 1000,
                tls: { certResolver: 'letsencrypt' },
              },
            },
            services: {
              'forward-auth-proxy': {
                loadBalancer: {
                  servers: [{ url: 'http://cloudgate-forward-auth:4180' }],
                  passHostHeader: true,
                },
              },
            },
          },
        },
        null,
        { platformOwned: true },
      );
    });

    it('drops the settings and the /oauth2 router when the auth domain is removed', async () => {
      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });

      await expect(
        forwardAuth.removeAuthDomain(ownerCtx, null),
      ).resolves.toEqual({ ok: true });

      expect(traefikWriter.removeConfig).toHaveBeenCalledWith(
        'forward-auth-domain',
        null,
        { platformOwned: true },
      );
      await expect(
        forwardAuth.getAuthDomain(ownerCtx, null),
      ).resolves.toBeNull();
    });

    it('leaves the /oauth2 router alone when there was nothing to remove', async () => {
      await expect(
        forwardAuth.removeAuthDomain(ownerCtx, null),
      ).resolves.toEqual({ ok: true });

      expect(traefikWriter.removeConfig).not.toHaveBeenCalled();
    });

    it('re-derives the base domain and rewrites the router when the domain changes', async () => {
      runningService();
      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });

      const result = await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'sso.internal.example.org',
        https: false,
        certificateType: 'none',
      });

      expect(result).toEqual({
        callbackUrl: 'http://sso.internal.example.org/oauth2/callback',
      });

      const rows = await ctx.db.select().from(forwardAuthSettings);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        authDomain: 'sso.internal.example.org',
        baseDomain: '.internal.example.org',
        https: false,
        certificateType: 'none',
      });

      // http drops the tls block and lands the router on the web entrypoint.
      expect(traefikWriter.writeConfig).toHaveBeenLastCalledWith(
        'forward-auth-domain',
        {
          http: {
            routers: {
              'forward-auth-oauth': {
                rule: 'Host(`sso.internal.example.org`) && PathPrefix(`/oauth2/`)',
                service: 'forward-auth-proxy',
                entryPoints: ['web'],
                priority: 1000,
              },
            },
            services: {
              'forward-auth-proxy': {
                loadBalancer: {
                  servers: [{ url: 'http://cloudgate-forward-auth:4180' }],
                  passHostHeader: true,
                },
              },
            },
          },
        },
        null,
        { platformOwned: true },
      );
    });

    /**
     * Both saves read "no row" before either writes, which is the race a read
     * and then an insert lost (§2.3). The platform host is the case worth
     * pinning: its row is unique only through the partial index, which held
     * nothing until `0084_forward-auth-local-unique.sql` made it
     * `NULLS NOT DISTINCT`.
     */
    it('keeps one platform-host row when two first saves race', async () => {
      runningService();

      const answers = await Promise.all([
        forwardAuth.setAuthDomain(ownerCtx, {
          serverId: null,
          authDomain: 'auth.example.com',
          https: true,
          certificateType: 'letsencrypt',
        }),
        forwardAuth.setAuthDomain(ownerCtx, {
          serverId: null,
          authDomain: 'sso.example.org',
          https: true,
          certificateType: 'letsencrypt',
        }),
      ]);

      expect(answers).toEqual([
        { callbackUrl: 'https://auth.example.com/oauth2/callback' },
        { callbackUrl: 'https://sso.example.org/oauth2/callback' },
      ]);
      const rows = await ctx.db.select().from(forwardAuthSettings);
      expect(rows).toHaveLength(1);
      expect(rows[0].serverId).toBeNull();
      expect(['auth.example.com', 'sso.example.org']).toContain(
        rows[0].authDomain,
      );
    });

    it('keeps one row on a Server when two first saves race, and neither fails', async () => {
      runningService();
      const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
      const { serverId } = await servers.create(ownerCtx, {
        name: 'deploy-1',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      const input = {
        serverId,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt' as const,
      };

      await Promise.all([
        forwardAuth.setAuthDomain(ownerCtx, input),
        forwardAuth.setAuthDomain(ownerCtx, input),
      ]);

      const rows = await ctx.db.select().from(forwardAuthSettings);
      expect(rows).toHaveLength(1);
      expect(rows[0].serverId).toBe(serverId);
    });
  });

  /**
   * H-39. `setAuthDomain` and `deployOnServer` are the writers of
   * `forward-auth-domain.yml` and both build the router from a checked host
   * (the DTO's, or `hostSchema` over the row), so every *write* is safe and
   * a domain stored before `domainRegex` is never shown to a rule again. The
   * injected ``Host(`…`)`` sits in the file provider at priority 1000, unread
   * and unrewritten — H-25 one file over, and it needs the same
   * mechanism, because an emitter guard cannot see a value no emitter reads.
   *
   * What is asserted is the sweep itself rather than `onApplicationBootstrap`:
   * the harness boots the app before a test can plant a row, and the hook is
   * three lines of try/catch over this.
   */
  describe('sweepAuthDomain', () => {
    /** Stores a domain directly, the way a pre-`domainRegex` write left one. */
    const storeAuthDomain = async (
      authDomain: string,
      serverId: string | null = null,
    ) => {
      await ctx.db.insert(forwardAuthSettings).values({
        authDomain,
        baseDomain: '.example.com',
        serverId,
      });
    };

    it('takes a poisoned auth domain out of the file provider', async () => {
      await storeAuthDomain('auth.example.com`) || Host(`victim.example.com');

      await forwardAuth.sweepAuthDomain();

      expect(traefikWriter.removeConfig).toHaveBeenCalledWith(
        'forward-auth-domain',
        null,
        { platformOwned: true },
      );
      // Not repaired, and not re-emitted: the injected half is attacker-chosen
      // and a salvaged router is a router nobody decided on.
      expect(traefikWriter.writeConfig).not.toHaveBeenCalled();
    });

    it('leaves the row where the operator can read it and correct it', async () => {
      // Unlike `sweepConsoleHost`, which clears its column: `authDomain` is NOT
      // NULL with no unset state, the columns beside it are not poisoned, and
      // the settings screen's callbackUrl is the only place an operator can see
      // what to fix.
      await storeAuthDomain('auth.example.com`) || Host(`victim.example.com');

      await forwardAuth.sweepAuthDomain();

      const [row] = await ctx.db.select().from(forwardAuthSettings);
      expect(row.authDomain).toBe(
        'auth.example.com`) || Host(`victim.example.com',
      );
    });

    it('leaves an ordinary auth domain alone', async () => {
      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });
      jest.clearAllMocks();

      await forwardAuth.sweepAuthDomain();

      expect(traefikWriter.removeConfig).not.toHaveBeenCalled();
    });

    it('sweeps every Traefik instance, and one unreachable Server does not stop the rest', async () => {
      const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
      const { serverId } = await servers.create(ownerCtx, {
        name: 'deploy-1',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      await storeAuthDomain(
        'auth.example.com`) || Host(`evil.example.com',
        serverId,
      );
      await storeAuthDomain(
        'sso.example.com`) || Host(`evil.example.com',
        null,
      );
      traefikWriter.removeConfig.mockImplementation((_name, target) =>
        target === serverId
          ? Promise.reject(new Error('ssh: connect: no route to host'))
          : Promise.resolve(undefined),
      );

      await expect(forwardAuth.sweepAuthDomain()).resolves.toBeUndefined();

      expect(traefikWriter.removeConfig).toHaveBeenCalledWith(
        'forward-auth-domain',
        serverId,
        { platformOwned: true },
      );
      expect(traefikWriter.removeConfig).toHaveBeenCalledWith(
        'forward-auth-domain',
        null,
        { platformOwned: true },
      );
    });
  });

  describe('the authentication proxy', () => {
    it('deploys oauth2-proxy for the provider and records it on the settings', async () => {
      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });
      await seedProvider('okta');
      const docker = absentService();

      await expect(
        forwardAuth.deployOnServer(ownerCtx, {
          serverId: null,
          providerId: 'okta',
        }),
      ).resolves.toEqual({ ok: true });

      expect(docker.createService).toHaveBeenCalledTimes(1);
      const spec = docker.createService.mock.calls[0][0] as ProxyServiceSpec;
      expect(spec).toMatchObject({
        Name: 'cloudgate-forward-auth',
        TaskTemplate: {
          ContainerSpec: {
            Image: 'quay.io/oauth2-proxy/oauth2-proxy:v7.6.0',
          },
          Networks: [{ Target: 'cloudgate-network' }],
          Placement: { Constraints: ['node.role==manager'] },
        },
        Mode: { Replicated: { Replicas: 1 } },
      });

      const env = spec.TaskTemplate.ContainerSpec.Env;
      expect(env).toEqual(
        expect.arrayContaining([
          'OAUTH2_PROXY_OIDC_ISSUER_URL=https://idp.example.com',
          'OAUTH2_PROXY_CLIENT_ID=client-abc',
          'OAUTH2_PROXY_CLIENT_SECRET=secret-xyz',
          'OAUTH2_PROXY_REDIRECT_URL=https://auth.example.com/oauth2/callback',
          'OAUTH2_PROXY_COOKIE_DOMAINS=.example.com',
        ]),
      );
      expect(env).toContainEqual(
        expect.stringMatching(/^OAUTH2_PROXY_COOKIE_SECRET=[0-9a-f]{32}$/),
      );

      const [row] = await ctx.db.select().from(forwardAuthSettings);
      expect(row.providerId).toBe('okta');
    });

    it('force-updates a proxy that is already running instead of creating a second one', async () => {
      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });
      await seedProvider('okta');

      const update = jest.fn<Promise<void>, [Record<string, unknown>]>();
      const docker = {
        getService: jest.fn(() => ({
          inspect: jest.fn(() =>
            Promise.resolve({
              Version: { Index: '42' },
              Spec: { TaskTemplate: { ForceUpdate: 3 } },
            }),
          ),
          update,
          remove: jest.fn(),
        })),
        createService: jest.fn<Promise<unknown>, [unknown]>(),
      };
      dockerFactory.getRemoteDocker.mockResolvedValue(docker);

      await forwardAuth.deployOnServer(ownerCtx, {
        serverId: null,
        providerId: 'okta',
      });

      expect(docker.createService).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][0]).toMatchObject({
        version: 42,
        Name: 'cloudgate-forward-auth',
        TaskTemplate: { ForceUpdate: 4 },
      });
    });

    /**
     * H-40. `buildForwardAuthEnv` sets three oauth2-proxy variables from the
     * stored row and nothing re-validated it on the way out.
     *
     * Not a shell — dockerode takes an `Env` array — so this is scope, not
     * command injection, and `OAUTH2_PROXY_WHITELIST_DOMAINS` is the sharp end:
     * `--whitelist-domain` is *"allowed domains for redirection after
     * authentication"*, its environment form is a comma-separated list, and
     * `deriveBaseDomain` splits on `.` alone, so a comma in the stored value
     * survives as a second whitelisted domain. The leading dot the derivation
     * always adds makes it a whole subtree rather than one host.
     */
    describe('a stored auth domain the DTO would not have accepted', () => {
      /** Plants a row the way a pre-`domainRegex` write left one. */
      const storeSettings = async (authDomain: string, baseDomain: string) => {
        await ctx.db.insert(forwardAuthSettings).values({
          authDomain,
          baseDomain,
          serverId: null,
        });
      };

      it('refuses to configure the proxy from an auth domain that is not a hostname', async () => {
        await storeSettings(
          'evil.example.com/#@auth.example.com',
          '.example.com',
        );
        await seedProvider('okta');
        const docker = absentService();

        await expect(
          forwardAuth.deployOnServer(ownerCtx, {
            serverId: null,
            providerId: 'okta',
          }),
        ).rejects.toThrow(
          'The authentication domain stored for this server is not a hostname',
        );

        // Nothing was stood up on the way to being refused.
        expect(docker.createService).not.toHaveBeenCalled();
      });

      it('derives the cookie and whitelist domains rather than trusting the stored column', async () => {
        // `baseDomain` is its own column, so anything writing the table around
        // `setAuthDomain` can poison it while `authDomain` stays well-formed —
        // and a second whitelisted domain leaves the legitimate one in place,
        // so nothing looks broken while an authenticated redirect can leave
        // the instance for anywhere under attacker.tld.
        await storeSettings('auth.example.com', '.example.com,.attacker.tld');
        await seedProvider('okta');
        const docker = absentService();

        await forwardAuth.deployOnServer(ownerCtx, {
          serverId: null,
          providerId: 'okta',
        });

        const spec = docker.createService.mock.calls[0][0] as ProxyServiceSpec;
        const env = spec.TaskTemplate.ContainerSpec.Env;
        expect(env).toEqual(
          expect.arrayContaining([
            'OAUTH2_PROXY_WHITELIST_DOMAINS=.example.com',
            'OAUTH2_PROXY_COOKIE_DOMAINS=.example.com',
            'OAUTH2_PROXY_REDIRECT_URL=https://auth.example.com/oauth2/callback',
          ]),
        );
        expect(env).not.toContainEqual(
          expect.stringContaining('.attacker.tld'),
        );
      });
    });

    it('refuses to deploy before an auth domain is set', async () => {
      await seedProvider('okta');
      const docker = absentService();

      await expect(
        forwardAuth.deployOnServer(ownerCtx, {
          serverId: null,
          providerId: 'okta',
        }),
      ).rejects.toThrow(
        'Set the authentication domain for this server before deploying the proxy.',
      );

      expect(docker.createService).not.toHaveBeenCalled();
    });

    it('cannot deploy with another organization’s provider', async () => {
      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });
      await seedProvider('foreign-okta', {
        organizationId: await createOrganization(
          httpServer,
          ctx.db,
          ownerCookie,
          'Second Org',
        ),
      });
      const docker = absentService();

      await expect(
        forwardAuth.deployOnServer(ownerCtx, {
          serverId: null,
          providerId: 'foreign-okta',
        }),
      ).rejects.toThrow('SSO provider not found');

      expect(docker.createService).not.toHaveBeenCalled();
      const [row] = await ctx.db.select().from(forwardAuthSettings);
      expect(row.providerId).toBeNull();
    });

    it('refuses a SAML-only provider, which oauth2-proxy cannot front', async () => {
      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });
      await seedProvider('saml-idp', {
        oidcConfig: null,
        samlConfig: JSON.stringify({ entryPoint: 'https://idp/saml' }),
      });
      const docker = absentService();

      await expect(
        forwardAuth.deployOnServer(ownerCtx, {
          serverId: null,
          providerId: 'saml-idp',
        }),
      ).rejects.toThrow(
        'Forward-auth requires an OIDC provider — SAML is not supported.',
      );

      expect(docker.createService).not.toHaveBeenCalled();
    });

    it('refuses an OIDC provider missing its client credentials', async () => {
      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });
      await seedProvider('half-configured', {
        oidcConfig: JSON.stringify({ clientId: 'client-abc' }),
      });
      absentService();

      await expect(
        forwardAuth.deployOnServer(ownerCtx, {
          serverId: null,
          providerId: 'half-configured',
        }),
      ).rejects.toThrow(
        'SSO provider OIDC config is missing clientId/clientSecret',
      );
    });

    it('removes the proxy and forgets its provider', async () => {
      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });
      await seedProvider('okta');
      absentService();
      await forwardAuth.deployOnServer(ownerCtx, {
        serverId: null,
        providerId: 'okta',
      });

      const remove = jest.fn<Promise<void>, []>();
      const docker = {
        getService: jest.fn(() => ({
          inspect: jest.fn(),
          update: jest.fn(),
          remove,
        })),
        createService: jest.fn<Promise<unknown>, [unknown]>(),
      };
      dockerFactory.getRemoteDocker.mockResolvedValue(docker);

      await expect(forwardAuth.removeOnServer(ownerCtx, null)).resolves.toEqual(
        { ok: true },
      );

      expect(docker.getService).toHaveBeenCalledWith('cloudgate-forward-auth');
      expect(remove).toHaveBeenCalledTimes(1);

      // The auth domain survives; only the provider it authenticated against goes.
      const [row] = await ctx.db.select().from(forwardAuthSettings);
      expect(row).toMatchObject({
        authDomain: 'auth.example.com',
        providerId: null,
      });
    });

    /**
     * The router went on naming `cloudgate-forward-auth:4180` after the
     * service was gone, so `auth.<domain>/oauth2/*` answered 502 while the card
     * read "No proxy".
     */
    it('takes the /oauth2 router with the proxy, so the auth host stops matching', async () => {
      await setUpDeployedProxy();
      traefikWriter.removeConfig.mockClear();
      absentService();

      await expect(forwardAuth.removeOnServer(ownerCtx, null)).resolves.toEqual(
        { ok: true },
      );

      expect(traefikWriter.removeConfig).toHaveBeenCalledWith(
        'forward-auth-domain',
        null,
        { platformOwned: true },
      );
    });

    it('puts the router back when the proxy is deployed again on the kept domain', async () => {
      await setUpDeployedProxy();
      absentService();
      await forwardAuth.removeOnServer(ownerCtx, null);
      traefikWriter.writeConfig.mockClear();

      await forwardAuth.deployOnServer(ownerCtx, {
        serverId: null,
        providerId: 'okta',
      });

      const writes = authDomainWrites();
      expect(writes).toHaveLength(1);
      const [, config, serverId] = writes[0];
      expect(serverId).toBeNull();
      expect(config.http?.routers?.['forward-auth-oauth']).toMatchObject({
        rule: 'Host(`auth.example.com`) && PathPrefix(`/oauth2/`)',
        tls: { certResolver: 'letsencrypt' },
      });
    });

    it('says so when the router cannot be removed, and still forgets the proxy', async () => {
      await setUpDeployedProxy();
      absentService();
      traefikWriter.removeConfig.mockRejectedValueOnce(
        new Error(
          'ssh: connect to host 203.0.113.9 port 22: Connection refused',
        ),
      );

      await expect(forwardAuth.removeOnServer(ownerCtx, null)).resolves.toEqual(
        {
          ok: true,
          unreclaimedArtifacts: [
            {
              kind: 'traefik-config',
              appName: 'forward-auth-domain',
              serverId: null,
              path: dynamicTraefikConfigPath('forward-auth-domain', null),
            },
          ],
        },
      );

      const [row] = await ctx.db.select().from(forwardAuthSettings);
      expect(row.providerId).toBeNull();
    });

    /**
     * The other door back to the 502: the router follows the service on
     * Change the domain too, so a domain changed with no proxy behind it
     * leaves nothing on disk naming `cloudgate-forward-auth:4180`.
     */
    it('writes no router when the domain changes after the proxy was removed', async () => {
      await setUpDeployedProxy();
      absentService();
      await forwardAuth.removeOnServer(ownerCtx, null);
      traefikWriter.writeConfig.mockClear();
      traefikWriter.removeConfig.mockClear();

      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'sso.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });

      expect(authDomainWrites()).toHaveLength(0);
      // And a file an earlier version left is taken, not trusted to be absent.
      expect(traefikWriter.removeConfig).toHaveBeenCalledWith(
        'forward-auth-domain',
        null,
        { platformOwned: true },
      );
    });

    it('rewrites the router when the domain changes under a running proxy', async () => {
      await setUpDeployedProxy();
      runningService();
      traefikWriter.writeConfig.mockClear();

      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'sso.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });

      const writes = authDomainWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0][1].http?.routers?.['forward-auth-oauth']).toMatchObject({
        rule: 'Host(`sso.example.com`) && PathPrefix(`/oauth2/`)',
      });
    });

    it('rewrites the router under a proxy that is deployed but failing', async () => {
      await setUpDeployedProxy();
      crashLoopingService();
      traefikWriter.writeConfig.mockClear();

      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'sso.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });

      expect(authDomainWrites()).toHaveLength(1);
    });

    /**
     * The signal is the service, not the row: clearing the domain deletes the
     * row and its provider, yet the proxy it configured is still running.
     */
    it('rewrites the router when the domain is set again after being cleared under a running proxy', async () => {
      await setUpDeployedProxy();
      runningService();
      await forwardAuth.removeAuthDomain(ownerCtx, null);
      traefikWriter.writeConfig.mockClear();

      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });

      const writes = authDomainWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0][2]).toBeNull();
    });
  });

  describe('gating an application domain', () => {
    it('puts the domain behind the proxy and rewrites its Traefik config', async () => {
      const { domain } = await setUpGatedDomain();

      await expect(
        forwardAuth.enableOnDomain(ownerCtx, domain.domainId),
      ).resolves.toEqual({ ok: true });

      await expect(
        forwardAuth.getDomainStatus(ownerCtx, domain.domainId),
      ).resolves.toEqual({ enabled: true });

      const config = lastAppConfig();
      expect(config.http?.middlewares?.['forward-auth-blog-app-1']).toEqual({
        forwardAuth: {
          address: 'https://auth.example.com/oauth2/auth',
          trustForwardHeader: true,
          authResponseHeaders: [
            'X-Auth-Request-User',
            'X-Auth-Request-Email',
            'X-Auth-Request-Preferred-Username',
            'Authorization',
          ],
        },
      });
      expect(
        config.http?.middlewares?.['forward-auth-blog-app-1-errors'],
      ).toEqual({
        errors: {
          status: ['401-403'],
          service: 'forward-auth-proxy',
          query: '/oauth2/sign_in?rd={url}',
          statusRewrites: { '401': 302 },
        },
      });
      // -errors must precede the gate so the proxy's 401 becomes a login redirect.
      expect(config.http?.routers?.['blog-app-router-1']?.middlewares).toEqual([
        'forward-auth-blog-app-1-errors',
        'forward-auth-blog-app-1',
      ]);
    });

    it('takes the gate back off the router when the domain is ungated', async () => {
      const { domain } = await setUpGatedDomain();
      await forwardAuth.enableOnDomain(ownerCtx, domain.domainId);

      await expect(
        forwardAuth.disableOnDomain(ownerCtx, domain.domainId),
      ).resolves.toEqual({ ok: true });

      await expect(
        forwardAuth.getDomainStatus(ownerCtx, domain.domainId),
      ).resolves.toEqual({ enabled: false });

      const config = lastAppConfig();
      expect(
        config.http?.middlewares?.['forward-auth-blog-app-1'],
      ).toBeUndefined();
      expect(
        config.http?.middlewares?.['forward-auth-blog-app-1-errors'],
      ).toBeUndefined();
      expect(config.http?.routers?.['blog-app-router-1']?.middlewares).toEqual(
        [],
      );
    });

    it('refuses to gate a domain before the proxy has been deployed', async () => {
      const { domain } = await setUpUngatedDomain();
      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: null,
        authDomain: 'auth.example.com',
        https: true,
        certificateType: 'letsencrypt',
      });
      runningService();

      await expect(
        forwardAuth.enableOnDomain(ownerCtx, domain.domainId),
      ).rejects.toThrow(
        'Deploy the authentication proxy for this server in SSO settings first.',
      );

      await expect(
        forwardAuth.getDomainStatus(ownerCtx, domain.domainId),
      ).resolves.toEqual({ enabled: false });
    });

    it('refuses to gate a domain while the deployed proxy is down', async () => {
      const { domain } = await setUpGatedDomain();
      absentService();

      await expect(
        forwardAuth.enableOnDomain(ownerCtx, domain.domainId),
      ).rejects.toThrow(
        'The authentication proxy is not deployed on this server. Deploy it in SSO settings first.',
      );

      await expect(
        forwardAuth.getDomainStatus(ownerCtx, domain.domainId),
      ).resolves.toEqual({ enabled: false });
    });

    it('refuses to gate a domain whose proxy is deployed but has no replica running', async () => {
      const { domain } = await setUpGatedDomain();
      crashLoopingService(
        'task: non-zero exit (1): failed to discover OIDC configuration',
      );

      await expect(
        forwardAuth.enableOnDomain(ownerCtx, domain.domainId),
      ).rejects.toThrow(
        'The authentication proxy on this server is deployed but no replica is running: task: non-zero exit (1): failed to discover OIDC configuration',
      );

      await expect(
        forwardAuth.getDomainStatus(ownerCtx, domain.domainId),
      ).resolves.toEqual({ enabled: false });
    });

    it('refuses a compose domain, whose routers carry no middleware', async () => {
      const project = await projects.create(ownerCtx, { name: 'cloudgate' });
      const environment = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const stack = await composeService.create(ownerCtx, {
        name: 'Stack',
        appName: 'blog-stack',
        environmentId: environment.environmentId,
      });
      const composeDomain = await domains.create(ownerCtx, {
        host: 'stack.example.com',
        composeId: stack.composeId,
        serviceName: 'web',
        domainType: 'compose',
      });

      await expect(
        forwardAuth.enableOnDomain(ownerCtx, composeDomain.domainId),
      ).rejects.toThrow(
        'SSO forward-auth is currently only supported on application domains',
      );
    });

    it('cannot see a domain in another organization', async () => {
      const { domain } = await setUpGatedDomain();
      const foreignCtx = ctxFor(
        ownerCtx.user.id,
        await createOrganization(httpServer, ctx.db, ownerCookie, 'Second Org'),
      );

      await expect(
        forwardAuth.getDomainStatus(foreignCtx, domain.domainId),
      ).rejects.toThrow('Domain not found');
      await expect(
        forwardAuth.enableOnDomain(foreignCtx, domain.domainId),
      ).rejects.toThrow('Domain not found');
    });
  });

  describe('what the SSO settings screen reads', () => {
    it('reports every target this organization can gate, newest server first', async () => {
      const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
      const older = await servers.create(ownerCtx, {
        name: 'older',
        ipAddress: '203.0.113.10',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const newer = await servers.create(ownerCtx, {
        name: 'newer',
        ipAddress: '203.0.113.11',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      await forwardAuth.setAuthDomain(ownerCtx, {
        serverId: older.serverId,
        authDomain: 'auth.example.com',
        https: false,
        certificateType: 'custom',
        customCertResolver: 'internal-ca',
      });
      runningService();

      const status = await forwardAuth.serverStatus(ownerCtx);

      expect(status).toEqual([
        {
          serverId: null,
          name: 'Cloudgate Server (local)',
          ipAddress: null,
          status: 'running',
          message: null,
          authDomain: null,
          https: true,
          certificateType: 'none',
          customCertResolver: null,
          callbackUrl: null,
        },
        {
          serverId: newer.serverId,
          name: 'newer',
          ipAddress: '203.0.113.11',
          status: 'running',
          message: null,
          authDomain: null,
          https: true,
          certificateType: 'none',
          customCertResolver: null,
          callbackUrl: null,
        },
        {
          serverId: older.serverId,
          name: 'older',
          ipAddress: '203.0.113.10',
          status: 'running',
          message: null,
          authDomain: 'auth.example.com',
          https: false,
          certificateType: 'custom',
          customCertResolver: 'internal-ca',
          callbackUrl: 'http://auth.example.com/oauth2/callback',
        },
      ]);
    });

    it('reports a target whose proxy is absent as stopped', async () => {
      absentService();

      const [local] = await forwardAuth.serverStatus(ownerCtx);

      expect(local).toMatchObject({
        serverId: null,
        status: 'stopped',
        message: null,
      });
    });

    it('separates a proxy that is failing to start from one that is running, and says why', async () => {
      crashLoopingService('task: non-zero exit (1)');

      const [local] = await forwardAuth.serverStatus(ownerCtx);

      expect(local).toMatchObject({
        serverId: null,
        status: 'failing',
        message: '0/1 replicas running: task: non-zero exit (1)',
      });
    });

    it('lists only this organization’s OIDC providers, oldest first', async () => {
      await seedProvider('okta');
      await seedProvider('entra');
      await seedProvider('saml-only', { oidcConfig: null });
      await seedProvider('foreign-okta', {
        organizationId: await createOrganization(
          httpServer,
          ctx.db,
          ownerCookie,
          'Second Org',
        ),
      });

      await expect(forwardAuth.listProviders(ownerCtx)).resolves.toEqual([
        {
          providerId: 'okta',
          issuer: 'https://idp.example.com',
          domain: 'example.com',
        },
        {
          providerId: 'entra',
          issuer: 'https://idp.example.com',
          domain: 'example.com',
        },
      ]);
    });
  });

  describe('the enterprise gate', () => {
    // ADR-0054: below the paid features forward auth refuses adding and
    // editing, and always allows removing.
    it('refuses setting forward auth up without a valid license', async () => {
      license.hasValidLicense.mockResolvedValue(false);
      await seedProvider('okta');
      const docker = absentService();

      const refusals = [
        forwardAuth.setAuthDomain(ownerCtx, {
          serverId: null,
          authDomain: 'auth.example.com',
          https: true,
          certificateType: 'letsencrypt',
        }),
        forwardAuth.deployOnServer(ownerCtx, {
          serverId: null,
          providerId: 'okta',
        }),
      ];
      for (const refusal of refusals) {
        await expect(refusal).rejects.toThrow(
          'Valid enterprise license required',
        );
      }

      // Nothing was configured, written or deployed on the way to those refusals.
      await expect(ctx.db.select().from(forwardAuthSettings)).resolves.toEqual(
        [],
      );
      expect(traefikWriter.writeConfig).not.toHaveBeenCalled();
      expect(docker.createService).not.toHaveBeenCalled();
    });

    it('refuses editing a kept setup without a valid license, changing nothing', async () => {
      await setUpDeployedProxy();
      license.hasValidLicense.mockResolvedValue(false);
      const before = await ctx.db.select().from(forwardAuthSettings);
      traefikWriter.writeConfig.mockClear();
      const docker = runningService();

      await expect(
        forwardAuth.setAuthDomain(ownerCtx, {
          serverId: null,
          authDomain: 'login.example.com',
          https: true,
          certificateType: 'letsencrypt',
        }),
      ).rejects.toThrow('Valid enterprise license required');
      await expect(
        forwardAuth.deployOnServer(ownerCtx, {
          serverId: null,
          providerId: 'okta',
        }),
      ).rejects.toThrow('Valid enterprise license required');

      await expect(ctx.db.select().from(forwardAuthSettings)).resolves.toEqual(
        before,
      );
      expect(traefikWriter.writeConfig).not.toHaveBeenCalled();
      expect(docker.createService).not.toHaveBeenCalled();
    });

    it('refuses gating another domain without a valid license, through either route', async () => {
      const { domain, application } = await setUpGatedDomain();
      license.hasValidLicense.mockResolvedValue(false);

      await expect(
        forwardAuth.enableOnDomain(ownerCtx, domain.domainId),
      ).rejects.toThrow('Valid enterprise license required');
      await expect(
        domains.update(ownerCtx, domain.domainId, { forwardAuthEnabled: true }),
      ).rejects.toThrow('Valid enterprise license required');
      await expect(
        domains.create(ownerCtx, {
          host: 'docs.example.com',
          applicationId: application.applicationId,
          forwardAuthEnabled: true,
        }),
      ).rejects.toThrow('Valid enterprise license required');

      await expect(
        forwardAuth.getDomainStatus(ownerCtx, domain.domainId),
      ).resolves.toEqual({ enabled: false });
    });

    it('keeps reads and removal open without a valid license', async () => {
      await setUpDeployedProxy();
      license.hasValidLicense.mockResolvedValue(false);

      await expect(forwardAuth.getAuthDomain(ownerCtx, null)).resolves.toEqual(
        expect.objectContaining({ host: 'auth.example.com' }),
      );
      await expect(forwardAuth.listProviders(ownerCtx)).resolves.toEqual([
        expect.objectContaining({ providerId: 'okta' }),
      ]);
      await expect(forwardAuth.serverStatus(ownerCtx)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ serverId: null })]),
      );

      await expect(
        forwardAuth.removeOnServer(ownerCtx, null),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        forwardAuth.removeAuthDomain(ownerCtx, null),
      ).resolves.toEqual({ ok: true });
      await expect(ctx.db.select().from(forwardAuthSettings)).resolves.toEqual(
        [],
      );
    });

    it('works again once the license is back', async () => {
      const { domain } = await setUpGatedDomain();
      license.hasValidLicense.mockResolvedValue(false);
      await expect(
        forwardAuth.enableOnDomain(ownerCtx, domain.domainId),
      ).rejects.toThrow('Valid enterprise license required');

      license.hasValidLicense.mockResolvedValue(true);
      await expect(
        forwardAuth.enableOnDomain(ownerCtx, domain.domainId),
      ).resolves.toEqual({ ok: true });
    });

    it('closes the server surface to a member of the organization', async () => {
      const memberCtx = await inviteMember();
      await seedProvider('okta');
      absentService();

      await expect(forwardAuth.serverStatus(memberCtx)).rejects.toThrow(
        'Only owners and admins can manage forward-auth',
      );
      await expect(
        forwardAuth.setAuthDomain(memberCtx, {
          serverId: null,
          authDomain: 'auth.example.com',
          https: true,
          certificateType: 'letsencrypt',
        }),
      ).rejects.toThrow('Only owners and admins can manage forward-auth');
      await expect(
        forwardAuth.deployOnServer(memberCtx, {
          serverId: null,
          providerId: 'okta',
        }),
      ).rejects.toThrow('Only owners and admins can manage forward-auth');

      await expect(ctx.db.select().from(forwardAuthSettings)).resolves.toEqual(
        [],
      );
    });

    it('leaves an already-gated domain gated when the license lapses', async () => {
      const { domain } = await setUpGatedDomain();
      await forwardAuth.enableOnDomain(ownerCtx, domain.domainId);

      license.hasValidLicense.mockResolvedValue(false);

      // A lapsed license stops forward auth being set up, never the protection
      // already in place: a billing event must not make an app public.
      await expect(
        forwardAuth.getDomainStatus(ownerCtx, domain.domainId),
      ).resolves.toEqual({ enabled: true });

      // Editing the Domain otherwise rebuilds its router with the gate on it…
      await domains.update(ownerCtx, domain.domainId, { port: 8080 });
      expect(config()['blog-app-router-1']?.middlewares).toEqual([
        'forward-auth-blog-app-1-errors',
        'forward-auth-blog-app-1',
      ]);
      // …and the boot sweep leaves the /oauth2 router where it was.
      traefikWriter.removeConfig.mockClear();
      await forwardAuth.sweepAuthDomain();
      expect(traefikWriter.removeConfig).not.toHaveBeenCalled();

      // Ungating is removal, which is always allowed.
      await expect(
        forwardAuth.disableOnDomain(ownerCtx, domain.domainId),
      ).resolves.toEqual({ ok: true });

      function config() {
        return lastAppConfig().http?.routers ?? {};
      }
    });

    it('cannot configure a server belonging to another organization', async () => {
      const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
      const foreignCtx = ctxFor(
        ownerCtx.user.id,
        await createOrganization(httpServer, ctx.db, ownerCookie, 'Second Org'),
      );
      const foreignServer = await servers.create(foreignCtx, {
        name: 'theirs',
        ipAddress: '203.0.113.20',
        port: 22,
        username: 'root',
        sshKeyId: (await sshKeys.create(foreignCtx, { name: 'their-key' }))
          .sshKeyId,
      });
      expect(key.sshKeyId).toEqual(expect.any(String));

      await expect(
        forwardAuth.setAuthDomain(ownerCtx, {
          serverId: foreignServer.serverId,
          authDomain: 'auth.example.com',
          https: true,
          certificateType: 'letsencrypt',
        }),
      ).rejects.toThrow('Server not found');
      await expect(
        forwardAuth.getAuthDomain(ownerCtx, foreignServer.serverId),
      ).rejects.toThrow('Server not found');

      await expect(ctx.db.select().from(forwardAuthSettings)).resolves.toEqual(
        [],
      );
    });
  });

  /**
   * H-51. `serverId: null` is the **platform host** — one Traefik, one
   * `dynamic/forward-auth-domain.yml`, one oauth2-proxy that every
   * organization's gated Domain dials. `assertTargetAuthority` returned
   * immediately for it, so `ensureEnterprise` was the whole gate, and it reads
   * the caller's role in the caller's *own* organization: an owner of any
   * licensed organization on the instance could point the instance-wide proxy
   * at their own `sso_provider`, and `OAUTH2_PROXY_EMAIL_DOMAINS=*` admits
   * whatever that issuer mints.
   *
   * The suite already had *'cannot configure a server belonging to another
   * organization'*, which passes a foreign **non-null** id. That is the case
   * that was covered, and the reason the null one was not.
   */
  describe('the platform host as a target', () => {
    /**
     * An owner of a second Organization who is not a Member of the first.
     *
     * The user is inserted rather than signed up: a second
     * `/api/auth/sign-up/email` on a claimed instance is `SIGN_UP_CLOSED`, and
     * an invited one would join the *inviter's* organization, which is the
     * instance organization and would make the caller pass. `role: 'owner'` is
     * likewise written directly — `updateMemberRole` refuses to hand the owner
     * role out ("The owner role is nontransferable"), which is one of the
     * reasons the instance organization's owner row is a safe thing to gate on.
     */
    async function ownerOfSecondOrganization(): Promise<PermissionCtx> {
      const organizationId = await createOrganization(
        httpServer,
        ctx.db,
        ownerCookie,
        'Second Org',
      );
      const [mallory] = await ctx.db
        .insert(user)
        .values({
          firstName: 'Mallory',
          email: 'mallory@example.com',
          updatedAt: new Date(),
        })
        .returning();
      await ctx.db.insert(member).values({
        organizationId,
        userId: mallory.id,
        role: 'owner',
        createdAt: new Date(),
      });
      return ctxFor(mallory.id, organizationId);
    }

    const hostSettings = {
      serverId: null,
      authDomain: 'auth.attacker.tld',
      https: true,
      certificateType: 'letsencrypt' as const,
    };

    const REFUSAL =
      'Only an owner or admin of the instance organization can configure the platform host';

    it("refuses another organization's owner the platform host's auth domain", async () => {
      const mallory = await ownerOfSecondOrganization();

      await expect(
        forwardAuth.setAuthDomain(mallory, hostSettings),
      ).rejects.toThrow(REFUSAL);

      // Nothing was written on the way to being refused.
      await expect(ctx.db.select().from(forwardAuthSettings)).resolves.toEqual(
        [],
      );
      expect(traefikWriter.writeConfig).not.toHaveBeenCalled();
    });

    it("refuses another organization's owner the platform host's proxy", async () => {
      const mallory = await ownerOfSecondOrganization();
      // The host is already configured by the operator who may configure it,
      // so the refusal below is the authority check rather than the missing
      // settings row.
      await forwardAuth.setAuthDomain(ownerCtx, hostSettings);
      await ctx.db.insert(ssoProvider).values({
        providerId: 'attacker-idp',
        issuer: 'https://idp.attacker.tld',
        domain: 'attacker.tld',
        oidcConfig: JSON.stringify({
          clientId: 'id',
          clientSecret: 'secret',
        }),
        organizationId: mallory.session.activeOrganizationId,
        userId: mallory.user.id,
      });

      await expect(
        forwardAuth.deployOnServer(mallory, {
          serverId: null,
          providerId: 'attacker-idp',
        }),
      ).rejects.toThrow(REFUSAL);
    });

    it("refuses another organization's owner the platform host's settings read", async () => {
      const mallory = await ownerOfSecondOrganization();

      await expect(forwardAuth.getAuthDomain(mallory, null)).rejects.toThrow(
        REFUSAL,
      );
      await expect(forwardAuth.removeAuthDomain(mallory, null)).rejects.toThrow(
        REFUSAL,
      );
      await expect(forwardAuth.removeOnServer(mallory, null)).rejects.toThrow(
        REFUSAL,
      );
    });

    it('lets the instance owner configure the platform host', async () => {
      await expect(
        forwardAuth.setAuthDomain(ownerCtx, hostSettings),
      ).resolves.toEqual({
        callbackUrl: 'https://auth.attacker.tld/oauth2/callback',
      });
      await expect(forwardAuth.getAuthDomain(ownerCtx, null)).resolves.toEqual(
        expect.objectContaining({ host: 'auth.attacker.tld' }),
      );
    });

    it("leaves a Server to its own organization's owner", async () => {
      const mallory = await ownerOfSecondOrganization();
      const theirServer = await servers.create(mallory, {
        name: 'theirs',
        ipAddress: '203.0.113.30',
        port: 22,
        username: 'root',
        sshKeyId: (await sshKeys.create(mallory, { name: 'their-key' }))
          .sshKeyId,
      });

      await expect(
        forwardAuth.setAuthDomain(mallory, {
          ...hostSettings,
          serverId: theirServer.serverId,
        }),
      ).resolves.toEqual({
        callbackUrl: 'https://auth.attacker.tld/oauth2/callback',
      });
    });
  });

  describe('the audit trail', () => {
    it('records the auth-domain and proxy lifecycle against the server', async () => {
      await seedProvider('okta');
      absentService();

      await forwardAuth.setAuthDomain(
        ownerCtx,
        {
          serverId: null,
          authDomain: 'auth.example.com',
          https: true,
          certificateType: 'letsencrypt',
        },
        '198.51.100.7',
      );
      await forwardAuth.deployOnServer(
        ownerCtx,
        { serverId: null, providerId: 'okta' },
        '198.51.100.7',
      );
      await forwardAuth.removeOnServer(ownerCtx, null, '198.51.100.7');
      await forwardAuth.removeAuthDomain(ownerCtx, null, '198.51.100.7');

      const { logs } = await auditLogs.findAll(
        ownerCtx.session.activeOrganizationId,
        {},
      );
      expect(
        logs
          .map((log) => ({
            action: log.action,
            resourceType: log.resourceType,
            resourceId: log.resourceId,
            resourceName: log.resourceName,
            userEmail: log.userEmail,
            userRole: log.userRole,
            ip: log.ip,
          }))
          .filter((log) => log.resourceType === 'server'),
      ).toEqual([
        {
          action: 'delete',
          resourceType: 'server',
          resourceId: 'local',
          resourceName: 'forward-auth-domain',
          userEmail: owner.email,
          userRole: 'owner',
          ip: '198.51.100.7',
        },
        {
          action: 'delete',
          resourceType: 'server',
          resourceId: 'local',
          resourceName: 'forward-auth',
          userEmail: owner.email,
          userRole: 'owner',
          ip: '198.51.100.7',
        },
        {
          action: 'create',
          resourceType: 'server',
          resourceId: 'local',
          resourceName: 'forward-auth',
          userEmail: owner.email,
          userRole: 'owner',
          ip: '198.51.100.7',
        },
        {
          action: 'update',
          resourceType: 'server',
          resourceId: 'local',
          resourceName: 'forward-auth-domain',
          userEmail: owner.email,
          userRole: 'owner',
          ip: '198.51.100.7',
        },
      ]);
    });

    it('records a gate going up and coming down against the domain', async () => {
      const { domain } = await setUpGatedDomain();

      await forwardAuth.enableOnDomain(
        ownerCtx,
        domain.domainId,
        '198.51.100.7',
      );
      await forwardAuth.disableOnDomain(
        ownerCtx,
        domain.domainId,
        '198.51.100.7',
      );

      const { logs } = await auditLogs.findAll(
        ownerCtx.session.activeOrganizationId,
        { resourceType: 'domain' },
      );
      expect(
        logs.map((log) => ({
          action: log.action,
          resourceId: log.resourceId,
          resourceName: log.resourceName,
          ip: log.ip,
        })),
      ).toEqual([
        {
          action: 'update',
          resourceId: domain.domainId,
          resourceName: 'blog.example.com',
          ip: '198.51.100.7',
        },
        {
          action: 'update',
          resourceId: domain.domainId,
          resourceName: 'blog.example.com',
          ip: '198.51.100.7',
        },
      ]);
    });
  });

  describe('over HTTP', () => {
    it('carries the whole surface', async () => {
      await seedProvider('okta');
      absentService();

      const set = await request(httpServer)
        .put('/forward-auth/settings')
        .set('Cookie', ownerCookie)
        .send({
          serverId: null,
          authDomain: 'AUTH.Example.com ',
          https: true,
          certificateType: 'letsencrypt',
        });
      expect(set.status).toBe(200);
      expect(set.body).toEqual({
        callbackUrl: 'https://auth.example.com/oauth2/callback',
      });

      const read = await request(httpServer)
        .get('/forward-auth/settings')
        .set('Cookie', ownerCookie);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ host: 'auth.example.com' });

      const providers = await request(httpServer)
        .get('/forward-auth/providers')
        .set('Cookie', ownerCookie);
      expect(providers.status).toBe(200);
      expect(providers.body).toEqual([
        {
          providerId: 'okta',
          issuer: 'https://idp.example.com',
          domain: 'example.com',
        },
      ]);

      const targets = await request(httpServer)
        .get('/forward-auth/servers')
        .set('Cookie', ownerCookie);
      expect(targets.status).toBe(200);
      expect(targets.body).toHaveLength(1);

      const deploy = await request(httpServer)
        .post('/forward-auth/proxy')
        .set('Cookie', ownerCookie)
        .send({ serverId: null, providerId: 'okta' });
      expect(deploy.status).toBe(200);
      expect(deploy.body).toEqual({ ok: true });

      const { domain } = await setUpUngatedDomain();
      runningService();

      const enable = await request(httpServer)
        .post(`/forward-auth/domains/${domain.domainId}/enable`)
        .set('Cookie', ownerCookie);
      expect(enable.status).toBe(200);

      const status = await request(httpServer)
        .get(`/forward-auth/domains/${domain.domainId}`)
        .set('Cookie', ownerCookie);
      expect(status.status).toBe(200);
      expect(status.body).toEqual({ enabled: true });

      const disable = await request(httpServer)
        .post(`/forward-auth/domains/${domain.domainId}/disable`)
        .set('Cookie', ownerCookie);
      expect(disable.status).toBe(200);

      const removeProxy = await request(httpServer)
        .delete('/forward-auth/proxy')
        .set('Cookie', ownerCookie);
      expect(removeProxy.status).toBe(200);

      const removeSettings = await request(httpServer)
        .delete('/forward-auth/settings')
        .set('Cookie', ownerCookie);
      expect(removeSettings.status).toBe(200);
      expect(removeSettings.body).toEqual({ ok: true });
    });

    it('rejects an auth domain that is not a domain', async () => {
      for (const authDomain of [
        'not a domain',
        'http://auth.example.com',
        '',
      ]) {
        const res = await request(httpServer)
          .put('/forward-auth/settings')
          .set('Cookie', ownerCookie)
          .send({ serverId: null, authDomain });
        expect(res.status).toBe(400);
      }
    });

    it('rejects deploying without a provider', async () => {
      const res = await request(httpServer)
        .post('/forward-auth/proxy')
        .set('Cookie', ownerCookie)
        .send({ serverId: null, providerId: '' });
      expect(res.status).toBe(400);
    });

    it('answers 403 to a member and 401 to an anonymous caller', async () => {
      const memberCookie = await inviteMemberCookie();

      const memberRead = await request(httpServer)
        .get('/forward-auth/servers')
        .set('Cookie', memberCookie);
      expect(memberRead.status).toBe(403);

      const memberWrite = await request(httpServer)
        .put('/forward-auth/settings')
        .set('Cookie', memberCookie)
        .send({ serverId: null, authDomain: 'auth.example.com' });
      expect(memberWrite.status).toBe(403);

      const anonymous = await request(httpServer).get('/forward-auth/servers');
      expect(anonymous.status).toBe(401);
    });

    it('answers 403 to a setup when the organization holds no valid license, and still serves the reads', async () => {
      license.hasValidLicense.mockResolvedValue(false);

      const res = await request(httpServer)
        .put('/forward-auth/settings')
        .set('Cookie', ownerCookie)
        .send({ serverId: null, authDomain: 'auth.example.com' });
      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toBe(
        'Valid enterprise license required',
      );

      const read = await request(httpServer)
        .get('/forward-auth/servers')
        .set('Cookie', ownerCookie);
      expect(read.status).toBe(200);
    });
  });
});
