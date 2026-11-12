import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { DomainsService } from '../../src/domains/domains.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { RedirectsService } from '../../src/networking/redirects/redirects.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikConfigStatusService } from '../../src/traefik/config-status.service';
import { domainRouterName } from '../../src/traefik/config/names';
import { CONSOLE_ROUTER } from '../../src/traefik/config/web-server';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember, createOrganization } from '../utils/test-auth';

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

async function setUpOwner(
  server: App,
  who: { name: string; email: string; password: string },
) {
  const session = await signUp(server, who);
  const orgs = await request(server)
    .get('/organizations')
    .set('Cookie', session.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;
  return { organizationId, session };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

const CONTAINER_ID = '9f2c1ab4d7e0';
const ANCHOR = '2026-08-28T17:33:30.000000000Z';
const BAD_REGEX =
  'error parsing regexp: invalid or unsupported Perl syntax: `(?=`';

/** Traefik's console format, as `docker logs --timestamps` hands it over. */
const rejectionLine = (at: string, routerName: string, message: string) =>
  `${at} 2026-08-28T17:33:38Z ERR error="${message}" entryPointName=web routerName=${routerName}@file`;

/**
 * H-38 end to end: a value Traefik refuses is stored through a 2xx, and the
 * Application's own screens can now say so.
 *
 * The exec seam is the double, and it stands in for Traefik's log rather than
 * for Traefik — the parser is held to real `traefik:v3.6.7` output in
 * `traefik-log.spec.ts`, and what this file adds is everything around it: that
 * the write still succeeds, that the router name Cloudgate emitted resolves to
 * the rows a person can act on, and that the answer is org-scoped like every
 * other read about a service.
 */
describe('Traefik config status (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let domains: DomainsService;
  let redirects: RedirectsService;
  let status: TraefikConfigStatusService;

  const execAsync = jest.fn();
  const execAsyncRemote = jest.fn();
  const execMock = withArgvExec({ execAsync, execAsyncRemote });
  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
  };

  /**
   * What `docker ps` and the two `docker logs` reads answer for one test.
   *
   * The anchor read is `--tail 1` and is answered separately, because it is the
   * whole point of the protocol: it dates the log *before* the write, and the
   * burst is only believed if it is newer than that.
   */
  const traefikSays = (logs: string, containerId = CONTAINER_ID) => {
    execAsync.mockImplementation((command: string) =>
      Promise.resolve(
        command.startsWith('docker ps')
          ? { stdout: containerId, stderr: '', exitCode: 0 }
          : command.includes('--tail 1')
            ? {
                stdout: `${ANCHOR} 2026-08-28T17:33:30Z INF Configuration loaded`,
                stderr: '',
                exitCode: 0,
              }
            : { stdout: logs, stderr: '', exitCode: 0 },
      ),
    );
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
    redirects = ctx.app.get(RedirectsService);
    status = ctx.app.get(TraefikConfigStatusService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execAsync.mockReset();
    execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    traefikWriterMock.loadOrCreateConfig
      .mockReset()
      .mockResolvedValue({ http: { routers: {}, services: {} } });
    traefikWriterMock.writeConfig.mockReset().mockResolvedValue(undefined);
    traefikWriterMock.removeConfig.mockReset().mockResolvedValue(undefined);
    traefikSays('');
  });

  /** A project, environment, application and one Domain to route it. */
  async function setUpRoutedApplication() {
    const { organizationId, session } = await setUpOwner(server, owner);
    const ownerCtx = permissionCtx(session.id, organizationId);
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
      domainType: 'application',
    });
    await status.settled(application.applicationId);
    return { ownerCtx, session, application, domain };
  }

  it('stores a redirect Traefik refuses, and reports it against that Redirect and the Domain it darkened', async () => {
    const { ownerCtx, session, application, domain } =
      await setUpRoutedApplication();

    // The line Traefik logs for the router this application emits. `(?=…)` is
    // valid to V8 and refused by RE2, which is exactly why the DTO cannot hold
    // this class — see `config-status.service.ts`.
    traefikSays(
      rejectionLine(
        '2026-08-28T17:33:38.162947548Z',
        domainRouterName(application.appName, domain.uniqueConfigKey),
        BAD_REGEX,
      ),
    );

    const created = await redirects.create(ownerCtx, {
      regex: '(?=lookahead)',
      replacement: 'https://blog.example.com/$1',
      applicationId: application.applicationId,
    });

    // The write was not blocked. It must not be: Traefik is asked *after* the
    // file exists, and a surface that refused writes would be a validator.
    expect(created.redirectId).toEqual(expect.any(String));

    await status.settled(application.applicationId);

    const response = await request(server)
      .get('/traefik/config-status')
      .query({ applicationId: application.applicationId })
      .set('Cookie', session.cookie);

    expect(response.status).toBe(200);
    const body = response.body as {
      state: string;
      rejections: {
        message: string;
        domain: { domainId: string; host: string };
        subjects: { kind: string; redirectId?: string }[];
      }[];
    };
    expect(body.state).toBe('checked');
    expect(body.rejections).toHaveLength(1);
    expect(body.rejections[0].message).toBe(BAD_REGEX);
    expect(body.rejections[0].domain).toEqual({
      domainId: domain.domainId,
      host: 'blog.example.com',
    });
    expect(body.rejections[0].subjects).toContainEqual({
      kind: 'redirect',
      redirectId: created.redirectId,
    });
  });

  it('reports no rejection for a configuration Traefik accepted', async () => {
    const { ownerCtx, session, application } = await setUpRoutedApplication();

    // A reload Traefik accepted writes nothing at all — this is the whole log.
    traefikSays(
      '2026-08-28T17:33:38.100000000Z 2026-08-28T17:33:38Z INF Starting provider *file.Provider',
    );

    await redirects.create(ownerCtx, {
      regex: 'https://old.example.com/(.*)',
      replacement: 'https://blog.example.com/$1',
      applicationId: application.applicationId,
    });
    await status.settled(application.applicationId);

    const response = await request(server)
      .get('/traefik/config-status')
      .query({ applicationId: application.applicationId })
      .set('Cookie', session.cookie);

    expect(response.status).toBe(200);
    expect((response.body as { rejections: unknown[] }).rejections).toEqual([]);
  });

  it('reports no rejection when the file provider has not reloaded yet', async () => {
    const { ownerCtx, session, application, domain } =
      await setUpRoutedApplication();

    // The only error in the log predates the write, and `docker logs --since`
    // is inclusive of the anchor line. A watcher that has not fired is not a
    // reason to accuse the row that was just saved.
    traefikSays(
      rejectionLine(
        ANCHOR,
        domainRouterName(application.appName, domain.uniqueConfigKey),
        BAD_REGEX,
      ),
    );

    await redirects.create(ownerCtx, {
      regex: 'https://old.example.com/(.*)',
      replacement: 'https://blog.example.com/$1',
      applicationId: application.applicationId,
    });
    await status.settled(application.applicationId);

    const response = await request(server)
      .get('/traefik/config-status')
      .query({ applicationId: application.applicationId })
      .set('Cookie', session.cookie);

    expect((response.body as { rejections: unknown[] }).rejections).toEqual([]);
  });

  it('says nobody has looked rather than claiming health for an application never written', async () => {
    const { session, application } = await setUpRoutedApplication();
    // Reaching in is how "this instance has no observation" is produced; a
    // fresh process is the real path there, and an e2e cannot restart one.
    (status as unknown as { latest: Map<string, unknown> }).latest.delete(
      application.applicationId,
    );

    const response = await request(server)
      .get('/traefik/config-status')
      .query({ applicationId: application.applicationId })
      .set('Cookie', session.cookie);

    expect(response.status).toBe(200);
    const body = response.body as { state: string; rejections: unknown[] };
    expect(body.state).toBe('unavailable');
    expect(body.rejections).toEqual([]);
  });

  /**
   * H-61: the same log, read a second time against the routers that put *this
   * console* on a hostname. There is no Application to hang them on, so they
   * are answered on their own route behind instance authority — see
   * `config-status.service.ts`'s `verifyConsole`.
   */
  describe('the console’s own routers', () => {
    /**
     * `CONSOLE_ROUTER`, not the literal: the index is seeded from
     * `createWebServerConfig`'s own constant, and a spec that spelled the name
     * again would keep passing through a rename that un-indexed the console.
     */
    const consoleRouter = CONSOLE_ROUTER;
    const BAD_MIDDLEWARE =
      'middleware \\"redirect-to-https@file\\" does not exist for entrypoint \\"web\\"';

    it('reports a refused console router against the settings that wrote it', async () => {
      const { ownerCtx, session, application } = await setUpRoutedApplication();

      traefikSays(
        rejectionLine(
          '2026-08-28T17:33:38.162947548Z',
          consoleRouter,
          BAD_MIDDLEWARE,
        ),
      );

      // Nothing here touches the console's settings. An Application's own
      // regeneration is what makes the file provider re-emit the *whole*
      // current error set, which is how a console router nobody has rewritten
      // since it broke gets noticed at all.
      await redirects.create(ownerCtx, {
        regex: 'https://old.example.com/(.*)',
        replacement: 'https://blog.example.com/$1',
        applicationId: application.applicationId,
      });
      await status.settled(application.applicationId);

      const app = await request(server)
        .get('/traefik/config-status')
        .query({ applicationId: application.applicationId })
        .set('Cookie', session.cookie);
      // The console's router is not one of the Application's, so it is not in
      // the Application's list — attributing it there would blame whichever
      // Application happened to be saved last.
      expect((app.body as { rejections: unknown[] }).rejections).toEqual([]);

      const response = await request(server)
        .get('/traefik/config-status/console')
        .set('Cookie', session.cookie);

      expect(response.status).toBe(200);
      const body = response.body as {
        state: string;
        rejections: { routerName: string; source: string; message: string }[];
      };
      expect(body.state).toBe('checked');
      expect(body.rejections).toHaveLength(1);
      expect(body.rejections[0].routerName).toBe(consoleRouter);
      expect(body.rejections[0].source).toBe('console-domain');
      expect(body.rejections[0].message).toContain('redirect-to-https@file');
    });

    it('says nobody has looked rather than claiming the console is served', async () => {
      const { session } = await setUpRoutedApplication();
      (status as unknown as { latestConsole: unknown }).latestConsole =
        undefined;

      const response = await request(server)
        .get('/traefik/config-status/console')
        .set('Cookie', session.cookie);

      expect(response.status).toBe(200);
      const body = response.body as { state: string; rejections: unknown[] };
      expect(body.state).toBe('unavailable');
      expect(body.rejections).toEqual([]);
    });

    it('refuses a member who is not an operator of this instance', async () => {
      const { session } = await setUpRoutedApplication();
      const member = await signUpMember(server, session.cookie);

      const response = await request(server)
        .get('/traefik/config-status/console')
        .set('Cookie', member.cookie);

      expect(response.status).toBe(403);
      // The message is asserted because a 403 here could equally be `toCtx`'s
      // 'No active organization'; this sentence occurs once in `src/`.
      expect((response.body as { message: string }).message).toBe(
        'Only an owner or admin of the instance organization can configure the platform host',
      );
    });

    it('denies the console route with 401 when no credentials are sent', async () => {
      await request(server).get('/traefik/config-status/console').expect(401);
    });
  });

  describe('cross-org isolation', () => {
    it("another organization's application reads as absent", async () => {
      const { session, application } = await setUpRoutedApplication();

      // One session, two organizations: sign-up closes once an owner exists
      // (`auth/auth.config.ts`), and the rule under test compares the read's
      // `activeOrganizationId` against the project's, never which human asked.
      const neighbour = await createOrganization(
        server,
        ctx.db,
        session.cookie,
        { name: 'Neighbour', slug: `neighbour-${Date.now()}` },
      );
      expect(neighbour.status).toBe(201);
      const activated = await request(server)
        .post('/api/auth/organization/set-active')
        .set('Cookie', session.cookie)
        .send({ organizationId: (neighbour.body as { id: string }).id });
      expect(activated.status).toBe(200);

      const response = await request(server)
        .get('/traefik/config-status')
        .query({ applicationId: application.applicationId })
        .set('Cookie', session.cookie);

      expect(response.status).toBe(404);
      // Not 403: the row is invisible, not forbidden.
      expect((response.body as { message: string }).message).toBe(
        'Application not found',
      );
    });

    it('denies the route with 401 when no credentials are sent', async () => {
      const { application } = await setUpRoutedApplication();

      await request(server)
        .get('/traefik/config-status')
        .query({ applicationId: application.applicationId })
        .expect(401);
    });
  });
});
