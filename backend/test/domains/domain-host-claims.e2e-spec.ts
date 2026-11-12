import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { ComposeService } from '../../src/compose/compose.service';
import { DomainsService } from '../../src/domains/domains.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { application, cloudAccount, domain } from '../../src/db/schema';
import { webServerSettings } from '../../src/settings/settings.schema';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

/**
 * A Domain's host was validated for shape and never for ownership: the
 * only uniqueness rule was the exact `(host, path)` pair, so
 * `(victim.example.com, /)` being taken still left `(victim.example.com, /api)`
 * free — on the same Traefik, to a caller in a different organization. And the
 * console's own router is not a Domain row at all (it is written from
 * `webServerSettings.host` into the file provider as `cloudgate-router-app`), so
 * the pair check could not see it and a member could claim it.
 *
 * These live in their own file rather than in `domains.e2e-spec.ts` because they
 * need two organizations, two Servers and a seeded `webServerSettings` row —
 * fixtures nothing else in that file wants.
 *
 * **The layer pinned is the service, through the route.** The rule is
 * authorization over a *value*, not a rule about its shape, so it is not in the
 * DTOs (§2.4) — every request below is well-formed and a DTO-only change cannot
 * pass any of them.
 *
 * A Template's compose Domains are created at Apply by calling
 * `DomainsService.create`, so they inherit this check; a taken host is also
 * refused before anything is written (`test/templates/
 * template-compose-setup.e2e-spec.ts`).
 */

const CONSOLE_HOST = 'console.example.com';

/** The first user on the instance — the organization the operator belongs to. */
const operator = {
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

describe('Domain host claims (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let composeService: ComposeService;
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
    composeService = ctx.app.get(ComposeService);
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

  interface OrganizationFixture {
    organizationId: string;
    organizationName: string;
    session: { cookie: string; id: string };
    ctx: ReturnType<typeof permissionCtx>;
    environmentId: string;
  }

  /**
   * The first organization on the instance — the one the operator belongs to —
   * with a project and an environment to hang services off.
   */
  async function setUpOperator(): Promise<OrganizationFixture> {
    const session = await signUp(server, operator);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', session.cookie);
    const [organization] = orgs.body as { id: string; name: string }[];
    return withProject(session, organization);
  }

  /**
   * A second organization, so a hostname can be held by somebody else.
   *
   * It is created by the operator's own session rather than by a second signup,
   * because sign-up closes once an owner exists and only an invited user gets in
   * (`auth/auth.config.ts:39`) — and an invitation would put that user in *this*
   * organization, which is the opposite of what these tests need.
   * `test/deployments/organization-feed.e2e-spec.ts:222` is the established
   * shape: one session, two organizations, `set-active` between them. It costs
   * nothing here, because the rule under test compares the write's
   * `activeOrganizationId` against the holder's `project.organizationId` and
   * never asks which human is behind either.
   */
  async function setUpNeighbour(session: {
    cookie: string;
    id: string;
  }): Promise<OrganizationFixture> {
    const created = await createOrganization(server, ctx.db, session.cookie, {
      name: 'Neighbour',
      slug: `neighbour-${Date.now()}`,
    });
    expect(created.status).toBe(201);
    return withProject(session, created.body as { id: string; name: string });
  }

  async function withProject(
    session: { cookie: string; id: string },
    organization: { id: string; name: string },
  ): Promise<OrganizationFixture> {
    const organizationCtx = permissionCtx(session.id, organization.id);
    const project = await projects.create(organizationCtx, {
      name: organization.name,
    });
    const environment = await environments.create(organizationCtx, {
      name: 'production',
      projectId: project.projectId,
    });

    return {
      organizationId: organization.id,
      organizationName: organization.name,
      session,
      ctx: organizationCtx,
      environmentId: environment.environmentId,
    };
  }

  /**
   * Points the shared session at this organization and hands back the
   * cookie to send — every HTTP request below goes through this, so no request
   * can silently run in whichever organization was activated last.
   */
  async function actingAs(org: OrganizationFixture): Promise<string> {
    const activated = await request(server)
      .post('/api/auth/organization/set-active')
      .set('Cookie', org.session.cookie)
      .send({ organizationId: org.organizationId });
    expect(activated.status).toBe(200);
    return org.session.cookie;
  }

  /**
   * A `server` row in this organization, so a service can sit somewhere other
   * than the platform host.
   *
   * A Server belongs to exactly one organization and `checkServerAccess`
   * refuses a `serverId` outside the caller's, so **two organizations can only
   * ever share the platform host** (`serverId: null`, ADR-0008). That is why the
   * same-Traefik collisions below are all on the platform host: it is the one
   * scope the API lets two organizations both reach.
   */
  async function addServer(
    org: OrganizationFixture,
    name: string,
  ): Promise<string> {
    const inserted = await ctx.db.$client.query<{ server_id: string }>(
      `insert into server (server_id, name, ip_address, port, created_at, organization_id)
       values ($1, $2, '192.168.1.10', 22, $3, $4) returning server_id`,
      [name, name, new Date().toISOString(), org.organizationId],
    );
    return inserted.rows[0].server_id;
  }

  /** An Application in this organization's environment, on `serverId` or the platform host. */
  async function addApplication(
    org: OrganizationFixture,
    appName: string,
    serverId?: string,
  ) {
    return applications.create(org.ctx, {
      name: appName,
      appName,
      environmentId: org.environmentId,
      ...(serverId ? { serverId } : {}),
    });
  }

  /**
   * Whatever `webServerSettings.host` the console's router is written from.
   *
   * The existing rows go first: the singleton is resolved by oldest `createdAt`
   * (`SettingsService.getWebServerSettings`), so appending a row would leave the
   * reservation reading a different one from the console writer.
   */
  async function setConsoleHost(host: string | null): Promise<void> {
    await ctx.db.$client.query('delete from web_server_settings');
    await ctx.db.insert(webServerSettings).values({ host });
  }

  /** Every Domain row in the instance, host and path. */
  const domainRows = async () =>
    (
      await ctx.db.$client.query<{ host: string; path: string }>(
        'select host, path from domain order by host, path',
      )
    ).rows;

  describe('a host another organization already holds', () => {
    it('refuses a host another organization holds on the same Server, on a path nobody has taken', async () => {
      const held = await setUpOperator();
      const claimant = await setUpNeighbour(held.session);
      const heldApp = await addApplication(held, 'held-app');
      const claimantApp = await addApplication(claimant, 'claimant-app');
      await domains.create(held.ctx, {
        host: 'victim.example.com',
        applicationId: heldApp.applicationId,
      });

      const refused = await request(server)
        .post('/domains')
        .set('Cookie', await actingAs(claimant))
        .send({
          host: 'victim.example.com',
          path: '/api',
          applicationId: claimantApp.applicationId,
        });

      expect(refused.status).toBe(409);
      const { message } = refused.body as { message: string };
      expect(message).toBe('This hostname is already in use');
      // The refusal names no holder anywhere in the response, `details`
      // included: a body carrying the holder's name or id would confirm another
      // organization's existence, and its hostnames, to any member holding
      // `domain:['create']` — which `memberRole` does. Asserted over the whole
      // body rather than the message alone because the filter renders `details`
      // too. (No slug: a bootstrap organization has none.)
      expect(JSON.stringify(refused.body)).not.toContain(held.organizationName);
      expect(JSON.stringify(refused.body)).not.toContain(held.organizationId);
      // No Domain row was written on the way to being refused.
      expect(await domainRows()).toEqual([
        { host: 'victim.example.com', path: '/' },
      ]);
    });

    it('refuses a host another organization holds on a compose stack on the same Server', async () => {
      // The reverse join runs over both parent kinds; a stack's host claims the
      // hostname exactly as an Application's does.
      const held = await setUpOperator();
      const claimant = await setUpNeighbour(held.session);
      const stack = await composeService.create(held.ctx, {
        name: 'Wordpress',
        appName: 'held-stack',
        environmentId: held.environmentId,
      });
      await domains.create(held.ctx, {
        host: 'shop.example.com',
        composeId: stack.composeId,
        serviceName: 'wordpress',
        domainType: 'compose',
      });
      const application = await addApplication(claimant, 'claimant-app');

      const refused = await request(server)
        .post('/domains')
        .set('Cookie', await actingAs(claimant))
        .send({
          host: 'shop.example.com',
          path: '/api',
          applicationId: application.applicationId,
        });

      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        'This hostname is already in use',
      );
      expect(await domainRows()).toEqual([
        { host: 'shop.example.com', path: '/' },
      ]);
    });

    it('allows the same host when the two parents sit on different Servers', async () => {
      // Each Server runs its own Traefik, so this is not a collision. The path
      // still differs because the `(host, path)` pair check stays global — the
      // issue's third accepted residual, deliberately not loosened here.
      const held = await setUpOperator();
      const claimant = await setUpNeighbour(held.session);
      await domains.create(held.ctx, {
        host: 'victim.example.com',
        applicationId: (await addApplication(held, 'held-app')).applicationId,
      });
      const elsewhere = await addServer(claimant, 'claimant-box');
      const application = await addApplication(
        claimant,
        'claimant-app',
        elsewhere,
      );

      const created = await request(server)
        .post('/domains')
        .set('Cookie', await actingAs(claimant))
        .send({
          host: 'victim.example.com',
          path: '/api',
          applicationId: application.applicationId,
        });

      expect(created.status).toBe(201);
      expect(await domainRows()).toEqual([
        { host: 'victim.example.com', path: '/' },
        { host: 'victim.example.com', path: '/api' },
      ]);
    });
  });

  describe('a host another organization holds on a cloud Service', () => {
    /**
     * A cloud Service has no Server either, but its Domain reaches no
     * Traefik: it is a rule on its Organization's own load balancer, and a
     * cloud Domain's host is unique per Organization (ADR-0060). So it
     * holds nothing on the platform host, where the API lets two
     * organizations meet.
     */
    async function heldOnCloud(
      org: OrganizationFixture,
      host: string,
    ): Promise<void> {
      const [account] = await ctx.db
        .insert(cloudAccount)
        .values({
          organizationId: org.organizationId,
          name: 'Production AWS',
          cloud: 'aws',
          cloudId: '123456789012',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
          taskExecutionRoleArn:
            'arn:aws:iam::123456789012:role/cloudgate-task-execution',
          externalId: 'external-id-made-by-cloudgate',
          policyVersion: 1,
          lastCheckedAt: new Date().toISOString(),
          lastCheckResult: 'passed',
        })
        .returning();
      const [web] = await ctx.db
        .insert(application)
        .values({
          name: 'cloud-web',
          environmentId: org.environmentId,
          configName: 'cloud-web',
          configKind: 'web',
          port: 8080,
          cloudAccountId: account.cloudAccountId,
          region: 'eu-central-1',
        })
        .returning();
      await ctx.db.insert(domain).values({
        host,
        applicationId: web.applicationId,
        https: true,
        cloudCertificateStatus: 'waiting-for-dns',
      });
    }

    it('allows the host, at the same path, on the platform host', async () => {
      const held = await setUpOperator();
      const claimant = await setUpNeighbour(held.session);
      await heldOnCloud(held, 'victim.example.com');
      const application = await addApplication(claimant, 'claimant-app');

      const created = await request(server)
        .post('/domains')
        .set('Cookie', await actingAs(claimant))
        .send({
          host: 'victim.example.com',
          applicationId: application.applicationId,
        });

      expect(created.status).toBe(201);
      expect(await domainRows()).toEqual([
        { host: 'victim.example.com', path: '/' },
        { host: 'victim.example.com', path: '/' },
      ]);
    });

    it('still refuses the same host and path inside the organization that holds it', async () => {
      const org = await setUpOperator();
      await heldOnCloud(org, 'victim.example.com');
      const application = await addApplication(org, 'server-app');

      const refused = await request(server)
        .post('/domains')
        .set('Cookie', await actingAs(org))
        .send({
          host: 'victim.example.com',
          applicationId: application.applicationId,
        });

      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        'Domain with this host and path already exists',
      );
    });
  });

  describe('the console hostname', () => {
    it('refuses the console host on the platform host at the root path', async () => {
      await setConsoleHost(CONSOLE_HOST);
      const held = await setUpOperator();
      const claimant = await setUpNeighbour(held.session);
      const application = await addApplication(claimant, 'claimant-app');

      const refused = await request(server)
        .post('/domains')
        .set('Cookie', await actingAs(claimant))
        .send({ host: CONSOLE_HOST, applicationId: application.applicationId });

      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        'This hostname is already in use',
      );
      // No Domain row was written on the way to being refused.
      expect(await domainRows()).toEqual([]);
    });

    it('refuses the console host on a deeper path under it', async () => {
      // The interception the host-claim finding raised severity for: Traefik
      // ranks routers by rule length, so ``Host(`console`) &&
      // PathPrefix(`/api/auth`)`` outranks the console's own bare
      // ``Host(`console`)`` and takes the auth routes.
      await setConsoleHost(CONSOLE_HOST);
      const held = await setUpOperator();
      const claimant = await setUpNeighbour(held.session);
      const application = await addApplication(claimant, 'claimant-app');

      const refused = await request(server)
        .post('/domains')
        .set('Cookie', await actingAs(claimant))
        .send({
          host: CONSOLE_HOST,
          path: '/api/auth',
          applicationId: application.applicationId,
        });

      expect(refused.status).toBe(409);
      expect(await domainRows()).toEqual([]);
    });

    it('refuses the console host to the organization the operator belongs to', async () => {
      // The console is nobody's resource to claim, the first organization
      // on the instance included.
      await setConsoleHost(CONSOLE_HOST);
      const operatorOrg = await setUpOperator();
      const application = await addApplication(operatorOrg, 'operator-app');

      const refused = await request(server)
        .post('/domains')
        .set('Cookie', await actingAs(operatorOrg))
        .send({ host: CONSOLE_HOST, applicationId: application.applicationId });

      expect(refused.status).toBe(409);
      expect(await domainRows()).toEqual([]);
    });

    it('refuses the console host whatever case it is written in', async () => {
      // DNS and Traefik's `Host` matcher are both case-blind, so an exact
      // comparison would leave the reservation one `.toUpperCase()` away from a
      // bypass. `hostSchema` admits uppercase labels, so this is a real request.
      await setConsoleHost(CONSOLE_HOST);
      const operatorOrg = await setUpOperator();
      const application = await addApplication(operatorOrg, 'operator-app');

      const refused = await request(server)
        .post('/domains')
        .set('Cookie', await actingAs(operatorOrg))
        .send({
          host: 'CONSOLE.Example.COM',
          applicationId: application.applicationId,
        });

      expect(refused.status).toBe(409);
      expect(await domainRows()).toEqual([]);
    });

    it('allows the console host on a Server the console does not run on', async () => {
      // The reservation is scoped to the platform host, where the console router
      // and every platform-host Application share one file-provider directory.
      // A remote Server runs its own Traefik and the console is not on it.
      await setConsoleHost(CONSOLE_HOST);
      const operatorOrg = await setUpOperator();
      const elsewhere = await addServer(operatorOrg, 'operator-box');
      const application = await addApplication(
        operatorOrg,
        'operator-app',
        elsewhere,
      );

      const created = await request(server)
        .post('/domains')
        .set('Cookie', await actingAs(operatorOrg))
        .send({ host: CONSOLE_HOST, applicationId: application.applicationId });

      expect(created.status).toBe(201);
      expect(await domainRows()).toEqual([{ host: CONSOLE_HOST, path: '/' }]);
    });

    it('an unset console host reserves nothing', async () => {
      // A fresh instance has no `host` column value and therefore no console
      // router to outrank; reserving `''` would refuse every hostname. Two
      // independent things hold this — the reservation's own empty-host clause,
      // and `hostSchema` making the requested host non-empty — so this pins the
      // behaviour rather than either clause.
      await setConsoleHost(null);
      const operatorOrg = await setUpOperator();
      const application = await addApplication(operatorOrg, 'operator-app');

      const created = await request(server)
        .post('/domains')
        .set('Cookie', await actingAs(operatorOrg))
        .send({ host: CONSOLE_HOST, applicationId: application.applicationId });

      expect(created.status).toBe(201);
      expect(await domainRows()).toEqual([{ host: CONSOLE_HOST, path: '/' }]);
    });
  });

  describe('path-based routing inside one organization', () => {
    it('allows the same host on a different path inside one organization', async () => {
      // The feature the pair check exists for, and what the claim rule must not
      // break: one organization splitting a hostname across two services.
      const org = await setUpOperator();
      const first = await addApplication(org, 'first-app');
      const second = await addApplication(org, 'second-app');
      await domains.create(org.ctx, {
        host: 'blog.example.com',
        applicationId: first.applicationId,
      });

      const created = await request(server)
        .post('/domains')
        .set('Cookie', await actingAs(org))
        .send({
          host: 'blog.example.com',
          path: '/api',
          applicationId: second.applicationId,
        });

      expect(created.status).toBe(201);
      expect(await domainRows()).toEqual([
        { host: 'blog.example.com', path: '/' },
        { host: 'blog.example.com', path: '/api' },
      ]);
    });
  });

  describe('PATCH /domains/:id', () => {
    it('refuses a move onto a host another organization holds on the same Server', async () => {
      const held = await setUpOperator();
      const claimant = await setUpNeighbour(held.session);
      await domains.create(held.ctx, {
        host: 'victim.example.com',
        applicationId: (await addApplication(held, 'held-app')).applicationId,
      });
      const own = await domains.create(claimant.ctx, {
        host: 'mine.example.com',
        applicationId: (await addApplication(claimant, 'claimant-app'))
          .applicationId,
      });

      const refused = await request(server)
        .patch(`/domains/${own.domainId}`)
        .set('Cookie', await actingAs(claimant))
        .send({ host: 'victim.example.com', path: '/api' });

      expect(refused.status).toBe(409);
      const { message } = refused.body as { message: string };
      expect(message).toBe('This hostname is already in use');
      expect(JSON.stringify(refused.body)).not.toContain(held.organizationName);
      expect(JSON.stringify(refused.body)).not.toContain(held.organizationId);
      // The row was not moved on the way to being refused.
      expect(await domainRows()).toEqual([
        { host: 'mine.example.com', path: '/' },
        { host: 'victim.example.com', path: '/' },
      ]);
    });

    it('refuses a move onto the console host', async () => {
      await setConsoleHost(CONSOLE_HOST);
      const held = await setUpOperator();
      const claimant = await setUpNeighbour(held.session);
      const own = await domains.create(claimant.ctx, {
        host: 'mine.example.com',
        applicationId: (await addApplication(claimant, 'claimant-app'))
          .applicationId,
      });

      const refused = await request(server)
        .patch(`/domains/${own.domainId}`)
        .set('Cookie', await actingAs(claimant))
        .send({ host: CONSOLE_HOST, path: '/api/auth' });

      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        'This hostname is already in use',
      );
      // The row was not moved on the way to being refused.
      expect(await domainRows()).toEqual([
        { host: 'mine.example.com', path: '/' },
      ]);
    });

    it('allows a move onto another path under a host its own organization already holds', async () => {
      // A row is not its own competitor, and its organization's other rows are
      // not either.
      const org = await setUpOperator();
      const first = await addApplication(org, 'first-app');
      const second = await addApplication(org, 'second-app');
      await domains.create(org.ctx, {
        host: 'blog.example.com',
        applicationId: first.applicationId,
      });
      const own = await domains.create(org.ctx, {
        host: 'other.example.com',
        applicationId: second.applicationId,
      });

      const moved = await request(server)
        .patch(`/domains/${own.domainId}`)
        .set('Cookie', await actingAs(org))
        .send({ host: 'blog.example.com', path: '/api' });

      expect(moved.status).toBe(200);
      expect(await domainRows()).toEqual([
        { host: 'blog.example.com', path: '/' },
        { host: 'blog.example.com', path: '/api' },
      ]);
    });
  });
});
