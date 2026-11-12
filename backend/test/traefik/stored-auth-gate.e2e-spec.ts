import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { DomainsService } from '../../src/domains/domains.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

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

interface WrittenConfig {
  http: {
    routers: Record<string, { middlewares?: string[] }>;
    middlewares?: Record<string, { forwardAuth?: { address: string } }>;
  };
}

/**
 * H-23. `forwardAuthSettings.authDomain` is read from storage by
 * `TraefikAppConfigService.findAuthGate` and interpolated raw into
 * ``address: `${scheme}://${authDomain}/oauth2/auth` `` — an address Traefik
 * *dials* and lets the request through on a 2xx. A separator in that value
 * moves which host answers (`/` ends the authority, `#` starts a fragment Go
 * drops before dialling, `@` makes the front userinfo), so unlike the rest of
 * the H-14 family this one forges the authorization decision rather than a
 * router.
 *
 * `setForwardAuthSettings`' DTO has held the *wire* since it was written; what
 * had no rule was the read. So the suite is about the read: a row written
 * around the DTO, and what the emitter does with it.
 */
describe('TraefikAppConfigService, stored auth gate (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let domains: DomainsService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
  };

  beforeAll(async () => {
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
    domains = ctx.app.get(DomainsService);
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
    traefikWriterMock.loadOrCreateConfig
      .mockReset()
      .mockResolvedValue({ http: { routers: {}, services: {} } });
    traefikWriterMock.writeConfig.mockReset().mockResolvedValue(undefined);
    traefikWriterMock.removeConfig.mockReset().mockResolvedValue(undefined);
  });

  /** An Application with one gated Domain, and a stored auth gate for it. */
  async function setUpGatedDomain(authDomain: string) {
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
    const application = await applications.create(ownerCtx, {
      name: 'Blog',
      appName: 'blog-app',
      environmentId: environment.environmentId,
    });
    const domain = await domains.create(ownerCtx, {
      host: 'blog.example.com',
      applicationId: application.applicationId,
    });

    await ctx.db.$client.query(
      'update domain set forward_auth_enabled = true where domain_id = $1',
      [domain.domainId],
    );
    // Written around the DTO, which is the only way such a row exists: the
    // wire rule refuses this and always has.
    await ctx.db.$client.query(
      'insert into forward_auth_settings (forward_auth_settings_id, auth_domain, base_domain, https, certificate_type, server_id, created_at) values ($1, $2, $3, true, $4, null, $5)',
      [
        'fas-stored-1',
        authDomain,
        '.example.com',
        'letsencrypt',
        new Date().toISOString(),
      ],
    );

    traefikWriterMock.writeConfig.mockClear();
    return { ownerCtx, domain };
  }

  const lastWrittenConfig = (): WrittenConfig => {
    const calls = traefikWriterMock.writeConfig.mock.calls as unknown[][];
    return calls[calls.length - 1][1] as WrittenConfig;
  };

  it('writes no forward-auth middleware for a stored auth domain that is not a hostname', async () => {
    const { ownerCtx, domain } = await setUpGatedDomain(
      'evil.example.com/#@auth.example.com',
    );

    await domains.update(ownerCtx, domain.domainId, { port: 3001 });

    const config = lastWrittenConfig();
    const gate = `forward-auth-blog-app-${domain.uniqueConfigKey}`;
    expect(config.http.middlewares?.[gate]).toBeUndefined();
    expect(config.http.middlewares?.[`${gate}-errors`]).toBeUndefined();
    // Nothing was pointed at the injected host: no `address` anywhere in the
    // file names it, which is the assertion the finding is actually about.
    expect(JSON.stringify(config)).not.toContain('evil.example.com');
    // And the gated Domain fails *closed* rather than open — its routers still
    // name a middleware the file no longer defines, and Traefik skips a router
    // whose chain it cannot build.
    expect(
      config.http.routers[`blog-app-router-${domain.uniqueConfigKey}`]
        .middlewares,
    ).toContain(gate);
  });

  it('writes the forward-auth middleware for a stored auth domain that is one', async () => {
    // The control: the guard refuses a value, not the feature. Nothing this
    // rule accepts changed.
    const { ownerCtx, domain } = await setUpGatedDomain('auth.example.com');

    await domains.update(ownerCtx, domain.domainId, { port: 3001 });

    const gate = `forward-auth-blog-app-${domain.uniqueConfigKey}`;
    expect(
      lastWrittenConfig().http.middlewares?.[gate]?.forwardAuth?.address,
    ).toBe('https://auth.example.com/oauth2/auth');
  });
});
