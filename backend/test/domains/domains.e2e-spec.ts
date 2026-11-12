import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { ComposeService } from '../../src/compose/compose.service';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { domain as domainRow } from '../../src/db/schema';
import { DomainsService } from '../../src/domains/domains.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { webServerSettings } from '../../src/settings/settings.schema';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

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

/** The owner's bootstrap organization plus a service-seam permission ctx. */
async function setUpOwner(server: App) {
  const ownerSession = await signUp(server, owner);

  const orgs = await request(server)
    .get('/organizations')
    .set('Cookie', ownerSession.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;

  return { organizationId, owner: ownerSession };
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

const WORDPRESS_COMPOSE = `services:
  wordpress:
    image: wordpress:6
    ports:
      - "8080:80"
  db:
    image: mariadb:11
`;

describe('Domains (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let composeService: ComposeService;
  let domains: DomainsService;
  let engine: DeploymentEngineService;

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
    traefikWriterMock.loadOrCreateConfig
      .mockReset()
      .mockResolvedValue({ http: { routers: {}, services: {} } });
    traefikWriterMock.writeConfig.mockReset().mockResolvedValue(undefined);
    traefikWriterMock.removeConfig.mockReset().mockResolvedValue(undefined);
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

  /** An owner ctx plus a project + environment + application to attach domains to. */
  async function setUpApplication() {
    const { organizationId, owner: ownerSession } = await setUpOwner(server);
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
    return {
      organizationId,
      ownerSession,
      ownerCtx,
      project,
      environment,
      application,
    };
  }

  describe('create → findOne', () => {
    it('creates a domain for an application retrievable with its defaults', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });

      expect(created.domainId).toEqual(expect.any(String));
      expect(created.host).toBe('blog.example.com');
      expect(created.https).toBe(false);
      expect(created.path).toBe('/');
      expect(created.port).toBe(3000);
      expect(created.certificateType).toBe('none');
      expect(created.domainType).toBe('application');
      expect(created.uniqueConfigKey).toEqual(expect.any(Number));

      const found = await domains.findOne(ownerCtx, created.domainId);
      expect(found).toMatchObject({
        domainId: created.domainId,
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
    });
  });

  describe('host validation', () => {
    it('rejects an invalid host through the HTTP surface', async () => {
      const { ownerSession, application } = await setUpApplication();

      const res = await request(server)
        .post('/domains')
        .set('Cookie', ownerSession.cookie)
        .send({
          host: 'under_score.example.com',
          applicationId: application.applicationId,
        });

      expect(res.status).toBe(400);
    });

    it('rejects a host with leading or trailing spaces', async () => {
      const { ownerSession, application } = await setUpApplication();

      const res = await request(server)
        .post('/domains')
        .set('Cookie', ownerSession.cookie)
        .send({
          host: ' blog.example.com',
          applicationId: application.applicationId,
        });

      expect(res.status).toBe(400);
    });

    it('requires a certificateType when https is enabled', async () => {
      const { ownerSession, application } = await setUpApplication();

      const res = await request(server)
        .post('/domains')
        .set('Cookie', ownerSession.cookie)
        .send({
          host: 'blog.example.com',
          https: true,
          applicationId: application.applicationId,
        });

      expect(res.status).toBe(400);
    });

    it('rejects a host already registered for the same path', async () => {
      const { ownerCtx, application } = await setUpApplication();

      await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });

      await expect(
        domains.create(ownerCtx, {
          host: 'blog.example.com',
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects updating a domain onto an already-taken host and path', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      const second = await domains.create(ownerCtx, {
        host: 'www.example.com',
        applicationId: application.applicationId,
      });

      await expect(
        domains.update(ownerCtx, second.domainId, {
          host: 'blog.example.com',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('allows the same host on a different path', async () => {
      const { ownerCtx, application } = await setUpApplication();

      await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });

      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        path: '/api',
        applicationId: application.applicationId,
      });
      expect(created.path).toBe('/api');
    });
  });

  /**
   * Every field-level refusal the exception filter rendered for one field.
   *
   * The `details` array, not the bare 400: a charset rule is read by a person
   * filling in a form, so the assertion that matters is *which box is wrong*.
   */
  const refusalsFor = (body: unknown, field: string): string[] =>
    ((body as { details?: { path: string; message: string }[] }).details ?? [])
      .filter((detail) => detail.path === field)
      .map((detail) => detail.message);

  /**
   * `path` and `internalPath` reach Traefik raw through three sinks —
   * ``PathPrefix(`<path>`)`` in the Docker-provider router label
   * (`compose.utils.ts:81-83`) and again in the file provider
   * (`traefik/config/domain.ts:42-45`, where `host` goes through `toPunycode()`
   * and `path` goes through nothing), plus
   * `stripprefix.prefixes=<path>` (`compose.utils.ts:100-104`), a Traefik slice
   * a comma appends to. `pathSchema` is the one place that charset is stated,
   * and these pin it on both routes and both fields.
   *
   * The layer pinned is the **DTO, through the route**: a plain member holding
   * only *read* on one service can reach `POST /domains`, so the refusal has to
   * be at the seam the request comes through.
   */
  describe('path validation', () => {
    /**
     * A backtick closes the ``PathPrefix(`` argument, a comma appends to the
     * `prefixes` slice, whitespace is neither, and `api` is the one Traefik
     * v3 accepts from us and then drops as an invalid rule. A leading space is
     * refused rather than trimmed away, the refusal `hostSchema` already made.
     */
    const BAD_PATHS = ['/a`b', '/a,b', '/a b', 'api', ' /api'];

    it('refuses a path carrying a backtick, a comma, whitespace or no leading slash', async () => {
      const { ownerSession, application } = await setUpApplication();

      for (const field of ['path', 'internalPath']) {
        for (const value of BAD_PATHS) {
          const res = await request(server)
            .post('/domains')
            .set('Cookie', ownerSession.cookie)
            .send({
              host: 'blog.example.com',
              [field]: value,
              applicationId: application.applicationId,
            });

          expect(res.status).toBe(400);
          expect(refusalsFor(res.body, field).length).toBeGreaterThan(0);
        }
      }
      // Nothing reached the router generator on the way to being refused.
      expect(traefikWriterMock.writeConfig).not.toHaveBeenCalled();
    });

    it('names the leading slash when a path has none, on the field that has none', async () => {
      const { ownerSession, application } = await setUpApplication();

      const res = await request(server)
        .post('/domains')
        .set('Cookie', ownerSession.cookie)
        .send({
          host: 'blog.example.com',
          internalPath: 'v2',
          applicationId: application.applicationId,
        });

      expect(res.status).toBe(400);
      // The message the retired `refineDomainRules` arm used to produce, now
      // `pathSchema`'s and still on `internalPath` (§2.4).
      expect(refusalsFor(res.body, 'internalPath')).toContain(
        'A path starts with /',
      );
      expect(refusalsFor(res.body, 'path')).toEqual([]);
    });

    it('refuses the same paths when a domain is updated', async () => {
      const { ownerCtx, ownerSession, application } = await setUpApplication();
      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });

      for (const field of ['path', 'internalPath']) {
        for (const value of BAD_PATHS) {
          const res = await request(server)
            .patch(`/domains/${created.domainId}`)
            .set('Cookie', ownerSession.cookie)
            .send({ [field]: value });

          expect(res.status).toBe(400);
          expect(refusalsFor(res.body, field).length).toBeGreaterThan(0);
        }
      }

      const found = await domains.findOne(ownerCtx, created.domainId);
      // Nothing was stored on the way to being refused.
      expect(found.path).toBe('/');
      expect(found.internalPath).toBe('/');
    });

    it('takes a path a person would actually write', async () => {
      const { ownerSession, application } = await setUpApplication();

      const res = await request(server)
        .post('/domains')
        .set('Cookie', ownerSession.cookie)
        .send({
          host: 'blog.example.com',
          path: '/api/v1-2_3.4~x',
          internalPath: '/v2',
          applicationId: application.applicationId,
        });

      expect(res.status).toBe(201);
      expect((res.body as { path: string }).path).toBe('/api/v1-2_3.4~x');
    });
  });

  /**
   * `customEntrypoint` lands in the Traefik label **key** —
   * `routerName = ${appName}-${uniqueConfigKey}-${entrypoint}`
   * (`compose.utils.ts:79`, `:185-190`) — and Docker splits a label on its
   * first `=`, so an `=` truncates the key and the caller picks which label key
   * gets written for their own container. `customCertResolver` is a label
   * value, and `middlewares` is joined into one with `,`, which Traefik reads
   * as a slice. All three were bare `z.string()`.
   *
   * A `.` is refused on purpose: it is Traefik's label-key separator. The
   * accepted residual is an operator who hand-edited `traefik.yml` to name an
   * entrypoint `web.alt` and has to rename it.
   */
  describe('Traefik name validation', () => {
    const BAD_NAMES = ['web=x', 'web,x', 'web.alt', 'web x', ''];

    it('refuses an entrypoint, a resolver or a middleware outside the name charset', async () => {
      const { ownerSession, application } = await setUpApplication();

      for (const field of ['customEntrypoint', 'customCertResolver']) {
        for (const value of BAD_NAMES) {
          const res = await request(server)
            .post('/domains')
            .set('Cookie', ownerSession.cookie)
            .send({
              host: 'blog.example.com',
              [field]: value,
              applicationId: application.applicationId,
            });

          expect(res.status).toBe(400);
          expect(refusalsFor(res.body, field).length).toBeGreaterThan(0);
        }
      }

      for (const value of BAD_NAMES) {
        const res = await request(server)
          .post('/domains')
          .set('Cookie', ownerSession.cookie)
          .send({
            host: 'blog.example.com',
            // The refusal lands on the element, not on the array: a list of
            // middlewares is refused by the one name that is wrong.
            middlewares: ['auth-app', value],
            applicationId: application.applicationId,
          });

        expect(res.status).toBe(400);
        expect(refusalsFor(res.body, 'middlewares.1').length).toBeGreaterThan(
          0,
        );
        expect(refusalsFor(res.body, 'middlewares.0')).toEqual([]);
      }
    });

    it('refuses the same names when a domain is updated', async () => {
      const { ownerCtx, ownerSession, application } = await setUpApplication();
      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });

      for (const value of BAD_NAMES) {
        for (const body of [
          { customEntrypoint: value },
          { customCertResolver: value },
          { middlewares: [value] },
        ]) {
          const res = await request(server)
            .patch(`/domains/${created.domainId}`)
            .set('Cookie', ownerSession.cookie)
            .send(body);

          expect(res.status).toBe(400);
        }
      }

      const found = await domains.findOne(ownerCtx, created.domainId);
      expect(found.customEntrypoint).toBeNull();
      expect(found.customCertResolver).toBeNull();
    });

    it('still takes a null resolver, a null entrypoint and a provider-suffixed middleware', async () => {
      const { ownerSession, application } = await setUpApplication();

      const res = await request(server)
        .post('/domains')
        .set('Cookie', ownerSession.cookie)
        .send({
          host: 'blog.example.com',
          // `null` is what the console sends for "no custom resolver", and
          // `refineDomainRules` — not the charset — is what requires one when
          // `certificateType` is custom.
          customCertResolver: null,
          customEntrypoint: null,
          middlewares: ['redirect-to-https@file', 'auth_app-1'],
          applicationId: application.applicationId,
        });

      expect(res.status).toBe(201);
      expect(res.body as { middlewares: string[] }).toMatchObject({
        middlewares: ['redirect-to-https@file', 'auth_app-1'],
      });
    });

    it('takes the two entrypoint names Cloudgate generates', async () => {
      const { ownerSession, application } = await setUpApplication();

      for (const entrypoint of ['web', 'websecure']) {
        const res = await request(server)
          .post('/domains')
          .set('Cookie', ownerSession.cookie)
          .send({
            host: `${entrypoint}.example.com`,
            customEntrypoint: entrypoint,
            customCertResolver: 'letsencrypt',
            applicationId: application.applicationId,
          });

        expect(res.status).toBe(201);
      }
    });
  });

  describe('Traefik config regeneration', () => {
    it('includes path-rewrite middlewares for stripPath/internalPath domains', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        path: '/api',
        stripPath: true,
        internalPath: '/v2',
        applicationId: application.applicationId,
      });

      const key = created.uniqueConfigKey;
      const [, config] = traefikWriterMock.writeConfig.mock.calls[0] as [
        string,
        {
          http: {
            routers: Record<string, { rule: string; middlewares: string[] }>;
            middlewares: Record<string, unknown>;
          };
        },
      ];

      expect(config.http.routers[`blog-app-router-${key}`]).toMatchObject({
        rule: 'Host(`blog.example.com`) && (PathPrefix(`/api/`) || Path(`/api`))',
        middlewares: [
          `stripprefix-blog-app-${key}`,
          `addprefix-blog-app-${key}`,
        ],
      });
      expect(config.http.middlewares).toEqual({
        [`stripprefix-blog-app-${key}`]: {
          stripPrefix: { prefixes: ['/api'] },
        },
        [`addprefix-blog-app-${key}`]: { addPrefix: { prefix: '/v2' } },
      });
    });

    // A stack's Swarm services carry `deploy.labels` on the service,
    // which the `docker` provider never reads, so its Domains are routed by the
    // file provider at the same three points an Application's are.
    it('writes, rewrites and removes a stack Compose Domain’s file-provider config', async () => {
      const { ownerCtx, environment } = await setUpApplication();
      const stack = await composeService.create(ownerCtx, {
        name: 'Wordpress',
        appName: 'wordpress-stack',
        environmentId: environment.environmentId,
        composeType: 'stack',
      });

      const created = await domains.create(ownerCtx, {
        host: 'shop.example.com',
        composeId: stack.composeId,
        serviceName: 'wordpress',
        port: 8080,
        https: true,
        certificateType: 'letsencrypt',
        domainType: 'compose',
      });
      const key = created.uniqueConfigKey;

      expect(traefikWriterMock.writeConfig).toHaveBeenCalledTimes(1);
      const [name, config, serverId] = traefikWriterMock.writeConfig.mock
        .calls[0] as [
        string,
        {
          http: {
            routers: Record<string, unknown>;
            services: Record<string, unknown>;
          };
        },
        string | null,
      ];
      // Its own file, which no Application's appName can name.
      expect(name).toBe('compose+wordpress-stack');
      expect(serverId).toBeNull();
      expect(config.http.routers).toEqual({
        [`wordpress-stack-router-${key}`]: {
          rule: 'Host(`shop.example.com`)',
          service: `wordpress-stack-service-${key}`,
          middlewares: ['redirect-to-https'],
          entryPoints: ['web'],
        },
        [`wordpress-stack-router-websecure-${key}`]: {
          rule: 'Host(`shop.example.com`)',
          service: `wordpress-stack-service-${key}`,
          middlewares: [],
          entryPoints: ['websecure'],
          tls: { certResolver: 'letsencrypt' },
        },
      });
      // The Swarm service `docker stack deploy` names, on the Domain's port.
      expect(config.http.services).toEqual({
        [`wordpress-stack-service-${key}`]: {
          loadBalancer: {
            servers: [{ url: 'http://wordpress-stack_wordpress:8080' }],
            passHostHeader: true,
          },
        },
      });

      traefikWriterMock.writeConfig.mockClear();
      await domains.update(ownerCtx, created.domainId, { port: 9090 });
      const [, rewritten] = traefikWriterMock.writeConfig.mock.calls[0] as [
        string,
        { http: { services: Record<string, unknown> } },
      ];
      expect(rewritten.http.services).toEqual({
        [`wordpress-stack-service-${key}`]: {
          loadBalancer: {
            servers: [{ url: 'http://wordpress-stack_wordpress:9090' }],
            passHostHeader: true,
          },
        },
      });

      traefikWriterMock.writeConfig.mockClear();
      await domains.remove(ownerCtx, created.domainId);
      expect(traefikWriterMock.writeConfig).not.toHaveBeenCalled();
      expect(traefikWriterMock.removeConfig).toHaveBeenCalledWith(
        'compose+wordpress-stack',
        null,
      );
    });

    it('does not write file-provider config for docker-compose domains', async () => {
      const { ownerCtx, environment } = await setUpApplication();
      const stack = await composeService.create(ownerCtx, {
        name: 'Wordpress',
        appName: 'wordpress-stack',
        environmentId: environment.environmentId,
      });

      await domains.create(ownerCtx, {
        host: 'shop.example.com',
        composeId: stack.composeId,
        serviceName: 'wordpress',
        domainType: 'compose',
      });

      expect(traefikWriterMock.writeConfig).not.toHaveBeenCalled();
      expect(traefikWriterMock.removeConfig).not.toHaveBeenCalled();
    });

    it('regenerates the router when a domain is updated', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      traefikWriterMock.writeConfig.mockClear();

      await domains.update(ownerCtx, created.domainId, {
        host: 'www.example.com',
      });

      expect(traefikWriterMock.writeConfig).toHaveBeenCalledTimes(1);
      const [, config] = traefikWriterMock.writeConfig.mock.calls[0] as [
        string,
        { http: { routers: Record<string, { rule: string }> } },
      ];
      expect(
        config.http.routers[`blog-app-router-${created.uniqueConfigKey}`].rule,
      ).toBe('Host(`www.example.com`)');
    });

    it('rewrites the config without the removed router while other domains remain', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const first = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      const second = await domains.create(ownerCtx, {
        host: 'www.example.com',
        applicationId: application.applicationId,
      });
      traefikWriterMock.writeConfig.mockClear();

      await domains.remove(ownerCtx, first.domainId);

      expect(traefikWriterMock.removeConfig).not.toHaveBeenCalled();
      expect(traefikWriterMock.writeConfig).toHaveBeenCalledTimes(1);
      const [, config] = traefikWriterMock.writeConfig.mock.calls[0] as [
        string,
        { http: { routers: Record<string, unknown> } },
      ];
      expect(Object.keys(config.http.routers)).toEqual([
        `blog-app-router-${second.uniqueConfigKey}`,
      ]);
    });

    it('removes the config file when the last domain is removed', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      traefikWriterMock.writeConfig.mockClear();

      await domains.remove(ownerCtx, created.domainId);

      expect(traefikWriterMock.writeConfig).not.toHaveBeenCalled();
      expect(traefikWriterMock.removeConfig).toHaveBeenCalledWith(
        'blog-app',
        null,
      );

      await expect(domains.findOne(ownerCtx, created.domainId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  /**
   * X05-1. Three earlier fixes each put their charset on the DTO, and
   * the DTO holds: a PATCH re-sending a violating row's *own* stored value is a
   * 400. What did not hold is **which writes the rule is reached by**.
   * `updateDomainSchema` is `.partial()`, so a body naming nothing but `port`
   * never showed the stored `path` to any schema — X05 sent
   * `{"port":3001}`, got a 200, and watched the emitter write the injected
   * ``PathPrefix`` alternation back into the live file provider, where it went
   * on answering for a hostname the row never claimed.
   *
   * These plant rows the only way a pre-wave row can now exist — straight into
   * the table, past the DTO — and pin the two properties that have to hold
   * together: **an injection is never emitted again**, and **the write that
   * remediates it is never refused**.
   */
  describe('stored rows that predate the charset rules', () => {
    // X05's planted payload verbatim. The backtick closes `PathPrefix(` and the
    // alternation after it matches any hostname at all.
    const INJECTED_PATH = '/marker`) || PathPrefix(`/pwned-x05-1';
    // The same mechanism on `host`, which an earlier fix closed on the wire. `toPunycode`
    // is `new URL('http://' + host).hostname` inside a `try` whose `catch`
    // returns the original string, so this reaches the rule verbatim.
    const INJECTED_HOST = 'x.com`) || Host(`still-not-mine.example.com';

    /** Writes a value the DTO refuses — the only way a pre-wave row exists. */
    const poison = (
      domainId: string,
      values: { path?: string; host?: string; middlewares?: string[] },
    ) =>
      ctx.db
        .update(domainRow)
        .set(values)
        .where(eq(domainRow.domainId, domainId));

    /** Every router rule this run handed the file-provider writer. */
    const emittedRules = (): string[] =>
      traefikWriterMock.writeConfig.mock.calls.flatMap((call: unknown[]) =>
        Object.values(
          (call[1] as { http?: { routers?: Record<string, { rule: string }> } })
            .http?.routers ?? {},
        ).map((router) => router.rule),
      );

    it('refuses a PATCH that names an unrelated field, on a domain whose stored path was poisoned', async () => {
      const { ownerCtx, ownerSession, application } = await setUpApplication();
      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      await poison(created.domainId, { path: INJECTED_PATH });
      traefikWriterMock.writeConfig.mockClear();

      const res = await request(server)
        .patch(`/domains/${created.domainId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ port: 3001 });

      expect(res.status).toBe(400);
      const { message } = res.body as { message: string };
      // The stored field and the row are named: an operator learns the row is
      // poisoned, rather than only that their port change failed.
      expect(message).toContain('path');
      expect(message).toContain(created.domainId);
      // The payload itself is not echoed back into the error body.
      expect(message).not.toContain('pwned-x05-1');
      // Nothing was re-emitted, which is the whole finding.
      expect(traefikWriterMock.writeConfig).not.toHaveBeenCalled();
      // Nothing was stored either — the refusal is in front of the write.
      const found = await domains.findOne(ownerCtx, created.domainId);
      expect(found.port).toBe(3000);
    });

    it('refuses a PATCH on a domain whose stored host closes its own Host argument', async () => {
      const { ownerCtx, ownerSession, application } = await setUpApplication();
      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      await poison(created.domainId, { host: INJECTED_HOST });
      traefikWriterMock.writeConfig.mockClear();

      const res = await request(server)
        .patch(`/domains/${created.domainId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ port: 3001 });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain('host');
      expect(traefikWriterMock.writeConfig).not.toHaveBeenCalled();
    });

    it('emits nothing when a clean domain is removed and a poisoned sibling remains', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const poisoned = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      const clean = await domains.create(ownerCtx, {
        host: 'www.example.com',
        applicationId: application.applicationId,
      });
      await poison(poisoned.domainId, { path: INJECTED_PATH });
      traefikWriterMock.writeConfig.mockClear();

      // The emitter, not `update`, is the choke point: this write never names
      // the poisoned row, and the file it would rewrite carries every domain of
      // the application in one document.
      await expect(domains.remove(ownerCtx, clean.domainId)).rejects.toThrow(
        BadRequestException,
      );

      expect(traefikWriterMock.writeConfig).not.toHaveBeenCalled();
      expect(traefikWriterMock.removeConfig).not.toHaveBeenCalled();
    });

    it('takes the removal of a poisoned domain and rewrites the file without it', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const poisoned = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      const clean = await domains.create(ownerCtx, {
        host: 'www.example.com',
        applicationId: application.applicationId,
      });
      await poison(poisoned.domainId, { path: INJECTED_PATH });
      traefikWriterMock.writeConfig.mockClear();

      // Deleting the row is the remediation the guard is built around: `remove`
      // deletes before it regenerates, so the poisoned row is already out of the
      // set the guard reads.
      await domains.remove(ownerCtx, poisoned.domainId);

      expect(emittedRules()).toEqual([`Host(\`www.example.com\`)`]);
      // The clean sibling kept its router; the injection left with its row.
      expect(await domains.findOne(ownerCtx, clean.domainId)).toMatchObject({
        host: 'www.example.com',
      });
    });

    it('takes a PATCH that corrects the poisoned field, and re-emits the corrected rule', async () => {
      const { ownerCtx, ownerSession, application } = await setUpApplication();
      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      await poison(created.domainId, { path: INJECTED_PATH });
      traefikWriterMock.writeConfig.mockClear();

      const res = await request(server)
        .patch(`/domains/${created.domainId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ path: '/api' });

      // Nothing in the guard may refuse the write that fixes what it refuses.
      expect(res.status).toBe(200);
      expect(emittedRules()).toEqual([
        'Host(`blog.example.com`) && (PathPrefix(`/api/`) || Path(`/api`))',
      ]);
    });

    it('refuses to hand a poisoned compose domain to the label builder', async () => {
      const { ownerCtx, environment } = await setUpApplication();
      const stack = await composeService.create(ownerCtx, {
        name: 'Wordpress',
        appName: 'wordpress-stack',
        environmentId: environment.environmentId,
      });
      const created = await domains.create(ownerCtx, {
        host: 'shop.example.com',
        composeId: stack.composeId,
        serviceName: 'wordpress',
        domainType: 'compose',
      });
      await poison(created.domainId, { path: INJECTED_PATH });

      // The second sink: compose domains get no file-provider config, so
      // `regenerateTraefikConfig` never touches them — their rule is
      // interpolated into a Docker-provider label at deploy time instead, and
      // this is the one seam both consumers of that list pass through.
      await expect(domains.findComposeDomains(stack.composeId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  /**
   * X05-2. Four fields took `''` before the wave and refuse it now, and
   * `dto/domain.dto.ts` recorded one of the four — so a reader of that one
   * careful paragraph concluded only `internalPath` had moved. These pin all
   * four beside the two `null` controls that make them `.min(1)`-shaped
   * narrowings rather than a nullability regression, so the record and the
   * behaviour cannot drift apart again.
   *
   * `path` is deliberately absent: it was `z.string().min(1)` before the wave
   * too, so nothing about its empty string moved.
   */
  describe('the empty string, on the four fields that used to take it', () => {
    it('refuses an empty internalPath, entrypoint, resolver and middleware reference', async () => {
      const { ownerSession, application } = await setUpApplication();

      for (const [body, field] of [
        [{ internalPath: '' }, 'internalPath'],
        [{ customEntrypoint: '' }, 'customEntrypoint'],
        [{ customCertResolver: '' }, 'customCertResolver'],
        [{ middlewares: [''] }, 'middlewares.0'],
      ] as [Record<string, unknown>, string][]) {
        const res = await request(server)
          .post('/domains')
          .set('Cookie', ownerSession.cookie)
          .send({
            host: 'blog.example.com',
            ...body,
            applicationId: application.applicationId,
          });

        expect(res.status).toBe(400);
        expect(refusalsFor(res.body, field).length).toBeGreaterThan(0);
      }
      // Nothing reached the router generator on the way to being refused.
      expect(traefikWriterMock.writeConfig).not.toHaveBeenCalled();
    });

    it('refuses the same four empty strings when a domain is updated', async () => {
      const { ownerCtx, ownerSession, application } = await setUpApplication();
      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });

      for (const [body, field] of [
        [{ internalPath: '' }, 'internalPath'],
        [{ customEntrypoint: '' }, 'customEntrypoint'],
        [{ customCertResolver: '' }, 'customCertResolver'],
        [{ middlewares: [''] }, 'middlewares.0'],
      ] as [Record<string, unknown>, string][]) {
        const res = await request(server)
          .patch(`/domains/${created.domainId}`)
          .set('Cookie', ownerSession.cookie)
          .send(body);

        expect(res.status).toBe(400);
        expect(refusalsFor(res.body, field).length).toBeGreaterThan(0);
      }

      const found = await domains.findOne(ownerCtx, created.domainId);
      // Nothing was stored on the way to being refused.
      expect(found).toMatchObject({
        internalPath: '/',
        customEntrypoint: null,
        customCertResolver: null,
      });
    });

    it('still takes a null entrypoint and a null resolver, which is what says only the empty string moved', async () => {
      const { ownerSession, application } = await setUpApplication();

      const res = await request(server)
        .post('/domains')
        .set('Cookie', ownerSession.cookie)
        .send({
          host: 'blog.example.com',
          customEntrypoint: null,
          customCertResolver: null,
          applicationId: application.applicationId,
        });

      expect(res.status).toBe(201);
      expect(
        res.body as { customEntrypoint: null; customCertResolver: null },
      ).toMatchObject({
        customEntrypoint: null,
        customCertResolver: null,
      });
    });
  });

  describe('free domain generation', () => {
    /**
     * The instance's own public address — Settings → Instance, the singleton
     * the platform-host branch writes into the name.
     *
     * Set per test rather than once in a hook, because the refusal case *is*
     * its absence. `delete` first on `domain-host-claims.e2e-spec.ts`' terms:
     * `getWebServerSettings` creates the row lazily, so a test that wants a
     * known one replaces whatever an earlier request left behind.
     */
    const recordInstanceAddress = async (serverIp: string | null) => {
      await ctx.db.$client.query('delete from web_server_settings');
      if (serverIp !== null) {
        await ctx.db.insert(webServerSettings).values({ serverIp });
      }
    };

    it('generates a fresh sslip.io host carrying this instance address', async () => {
      const { ownerCtx } = await setUpApplication();
      await recordInstanceAddress('203.0.113.10');

      const first = await domains.generateDomain(ownerCtx, 'blog-app');
      const second = await domains.generateDomain(ownerCtx, 'blog-app');

      // Before the fix both answers were `blog-app-<hash>.sslip.io`: a name with
      // no address in it, which sslip.io answers with nothing.
      expect(first).toMatch(/^blog-app-[0-9a-f]{6}-203-0-113-10\.sslip\.io$/);
      expect(second).toMatch(/^blog-app-[0-9a-f]{6}-203-0-113-10\.sslip\.io$/);
      expect(first).not.toBe(second);
    });

    it('refuses to generate one when this instance has no address recorded', async () => {
      const { ownerCtx } = await setUpApplication();
      await recordInstanceAddress(null);

      await expect(
        domains.generateDomain(ownerCtx, 'blog-app'),
      ).rejects.toThrow(BadRequestException);
    });

    it('embeds the server IP when a serverId is given', async () => {
      const { ownerCtx, organizationId } = await setUpApplication();
      const inserted = await ctx.db.$client.query<{ server_id: string }>(
        `insert into server (server_id, name, ip_address, port, created_at, organization_id)
         values ('srv-1', 'build box', '192.168.1.10', 22, $1, $2) returning server_id`,
        [new Date().toISOString(), organizationId],
      );

      const host = await domains.generateDomain(
        ownerCtx,
        'blog-app',
        inserted.rows[0].server_id,
      );

      expect(host).toMatch(/^blog-app-[0-9a-f]{6}-192-168-1-10\.sslip\.io$/);
    });

    /**
     * The pin that makes the helper swap safe. This route's hand-rolled
     * `serverId = ? AND organizationId = ?` select is the shape the earlier fix cites as
     * *expected* on the nine create routes, and it has now been collapsed into
     * `checkServerAccess` — the sixth open-coded copy of the select an earlier fix
     * consolidated. Nothing here may change, so the two refusals it already
     * made are stated rather than assumed.
     */
    it('refuses an unknown serverId with 404 Server not found', async () => {
      const { ownerSession } = await setUpApplication();

      const res = await request(server)
        .post('/domains/generate')
        .set('Cookie', ownerSession.cookie)
        .send({ appName: 'blog-app', serverId: 'w03nonexistentid00000' });

      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        'Server not found',
      );
    });

    it('refuses a serverId in another organization with the same 404', async () => {
      const { ownerSession } = await setUpApplication();

      // A real `server` row in a second organization, not an id nothing owns:
      // one lookup raises the same NotFound whichever predicate misses, so a
      // dangling id proves nothing about the organization predicate.
      const other = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'other-tenant', slug: `other-${Date.now()}` },
      );
      const inserted = await ctx.db.$client.query<{ server_id: string }>(
        `insert into server (server_id, name, ip_address, port, created_at, organization_id)
         values ('srv-theirs', 'not yours', '203.0.113.31', 22, $1, $2) returning server_id`,
        [new Date().toISOString(), (other.body as { id: string }).id],
      );

      const res = await request(server)
        .post('/domains/generate')
        .set('Cookie', ownerSession.cookie)
        .send({ appName: 'blog-app', serverId: inserted.rows[0].server_id });

      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        'Server not found',
      );
      // Not a host built on their IP address, which is what an existence-only
      // check would have produced.
      expect(res.text).not.toContain('203-0-113-31');
    });

    /**
     * The three ways a client can name the platform host on this route, driven
     * through the HTTP surface rather than the service seam, because the thing
     * that broke was the zod pipe and not `generateDomain`.
     *
     * An Application on Cloudgate's own host carries `serverId: null` on its
     * row, so `null` is what a client reads off the resource and sends back —
     * and `.optional()` answered `400 "expected string, received null"` to it
     * while accepting the omitted key. ADR-0008 makes "no server row" *be* the
     * platform host, and `checkServerAccess` collapses `null` and `undefined`
     * onto that one branch, so validation was the only layer that disagreed.
     */
    describe('the platform host, named three ways', () => {
      const generate = (cookie: string, body: Record<string, unknown>) =>
        request(server)
          .post('/domains/generate')
          .set('Cookie', cookie)
          .send(body);

      it('generates a platform-host domain for an explicit null serverId', async () => {
        const { ownerSession } = await setUpApplication();
        await recordInstanceAddress('203.0.113.10');

        const res = await generate(ownerSession.cookie, {
          appName: 'blog-app',
          serverId: null,
        });

        expect(res.status).toBe(200);
        expect(res.text).toMatch(
          /^blog-app-[0-9a-f]{6}-203-0-113-10\.sslip\.io$/,
        );
      });

      it('answers the same shape for a null serverId as for an omitted one', async () => {
        const { ownerSession } = await setUpApplication();
        await recordInstanceAddress('203.0.113.10');

        const explicit = await generate(ownerSession.cookie, {
          appName: 'blog-app',
          serverId: null,
        });
        const omitted = await generate(ownerSession.cookie, {
          appName: 'blog-app',
        });

        expect(explicit.status).toBe(omitted.status);
        // Only the random hash differs: both answers carry the instance's own
        // address, which is what "no server row is the platform host" looks
        // like here.
        expect(explicit.text.replace(/-[0-9a-f]{6}-/, '-')).toBe(
          omitted.text.replace(/-[0-9a-f]{6}-/, '-'),
        );
        expect(explicit.text).not.toBe(omitted.text);
      });

      it('embeds the server IP when a real serverId travels over HTTP', async () => {
        const { ownerSession, organizationId } = await setUpApplication();
        await ctx.db.$client.query(
          `insert into server (server_id, name, ip_address, port, created_at, organization_id)
           values ('srv-http', 'build box', '192.168.1.10', 22, $1, $2)`,
          [new Date().toISOString(), organizationId],
        );

        const res = await generate(ownerSession.cookie, {
          appName: 'blog-app',
          serverId: 'srv-http',
        });

        expect(res.status).toBe(200);
        expect(res.text).toMatch(
          /^blog-app-[0-9a-f]{6}-192-168-1-10\.sslip\.io$/,
        );
      });

      it('refuses a serverId that is neither a string nor null', async () => {
        const { ownerSession } = await setUpApplication();

        for (const serverId of [7, {}, [], true]) {
          const res = await generate(ownerSession.cookie, {
            appName: 'blog-app',
            serverId,
          });
          expect(res.status).toBe(400);
        }
      });

      it('still looks up a serverId it cannot resolve', async () => {
        const { ownerSession } = await setUpApplication();

        const res = await generate(ownerSession.cookie, {
          appName: 'blog-app',
          serverId: 'srv-nobody',
        });

        // Widening validation must not widen resolution: a truthy string is
        // still looked up in the caller's own organization and still refused,
        // which is the half of the branch `null` deliberately skips.
        expect(res.status).toBe(404);
      });
    });
  });

  describe('row-level access', () => {
    it('denies a member without row access to the parent service', async () => {
      const { organizationId, ownerSession, ownerCtx, application } =
        await setUpApplication();
      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );
      const memberCtx = permissionCtx(member.id, organizationId);

      await expect(
        domains.create(memberCtx, {
          host: 'blog.example.com',
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(ForbiddenException);

      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      await expect(
        domains.findOne(memberCtx, created.domainId),
      ).rejects.toThrow(ForbiddenException);
      await expect(domains.remove(memberCtx, created.domainId)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('hides domains and parents from other organizations', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      // Same user, but acting in the second organization: the domain and
      // its parent application must not resolve, even for their creator.
      await expect(
        domains.findOne(secondOrgCtx, created.domainId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        domains.create(secondOrgCtx, {
          host: 'evil.example.com',
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('listing', () => {
    it('lists domains by application and by compose', async () => {
      const { ownerCtx, environment, application } = await setUpApplication();
      const stack = await composeService.create(ownerCtx, {
        name: 'Wordpress',
        appName: 'wordpress-stack',
        environmentId: environment.environmentId,
        composeFile: WORDPRESS_COMPOSE,
      });

      await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      await domains.create(ownerCtx, {
        host: 'www.example.com',
        applicationId: application.applicationId,
      });
      await domains.create(ownerCtx, {
        host: 'shop.example.com',
        composeId: stack.composeId,
        serviceName: 'wordpress',
        domainType: 'compose',
      });

      const byApp = await domains.byApplicationId(
        ownerCtx,
        application.applicationId,
      );
      expect(byApp.map((d) => d.host).sort()).toEqual([
        'blog.example.com',
        'www.example.com',
      ]);

      const byCompose = await domains.byComposeId(ownerCtx, stack.composeId);
      expect(byCompose.map((d) => d.host)).toEqual(['shop.example.com']);
    });
  });

  // `addDomainsToComposeSpec` only ever appended Traefik labels to the
  // list form; the map form was skipped silently while the rest of that function
  // joined the service to the routed network and declared the network external
  // at the root. So the operator got a 201, a Converted tab showing wiring that
  // reads as configured, and no router. `POST /domains` refuses it now — for a
  // `raw` stack, which is the only source type whose file a domain write can
  // read. The git-source half is pinned in
  // `test/compose/compose-converted.e2e-spec.ts`, where the refusal lands on the
  // Converted tab instead.
  describe('a compose service whose labels are a map', () => {
    const MAP_LABELLED_COMPOSE = `services:
  wordpress:
    image: wordpress:6
    labels:
      com.example.owner: platform
  db:
    image: mariadb:11
    labels:
      - com.example.owner=platform
`;

    const REFUSAL =
      'Domain "shop.example.com" is attached to service "wordpress", which declares "labels" as a map — Cloudgate adds Traefik routing labels only to the list form. Rewrite that service\'s labels as a list of "key=value" entries, or attach this domain to a service that already uses one';

    /** A raw-source stack whose file lives in the `composeFile` column. */
    async function setUpRawStack(composeFile = MAP_LABELLED_COMPOSE) {
      const env = await setUpApplication();
      const stack = await composeService.create(env.ownerCtx, {
        name: 'Wordpress',
        appName: 'wordpress-stack',
        environmentId: env.environment.environmentId,
        composeFile,
      });
      await composeService.update(env.ownerCtx, stack.composeId, {
        sourceType: 'raw',
      });
      return { ...env, stack };
    }

    it('refuses the domain at the moment it is attached, naming the service and the block', async () => {
      const { ownerSession, stack } = await setUpRawStack();

      const res = await request(server)
        .post('/domains')
        .set('Cookie', ownerSession.cookie)
        .send({
          host: 'shop.example.com',
          composeId: stack.composeId,
          domainType: 'compose',
          serviceName: 'wordpress',
          port: 8080,
        });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ message: REFUSAL });
      // Nothing was written on the way to being refused — the operator is not
      // left with a row the platform will never route.
      const rows = await ctx.db
        .select()
        .from(domainRow)
        .where(eq(domainRow.composeId, stack.composeId));
      expect(rows).toEqual([]);
    });

    it('takes the sibling service in the same file that uses the list form', async () => {
      const { ownerSession, stack } = await setUpRawStack();

      const res = await request(server)
        .post('/domains')
        .set('Cookie', ownerSession.cookie)
        .send({
          host: 'shop.example.com',
          composeId: stack.composeId,
          domainType: 'compose',
          serviceName: 'db',
          port: 8080,
        });

      expect(res.status).toBe(201);
    });

    it('refuses a PATCH that moves an attached domain onto the map-labelled service', async () => {
      const { ownerSession, ownerCtx, stack } = await setUpRawStack();
      const created = await domains.create(ownerCtx, {
        host: 'shop.example.com',
        composeId: stack.composeId,
        serviceName: 'db',
        domainType: 'compose',
      });

      const res = await request(server)
        .patch(`/domains/${created.domainId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ serviceName: 'wordpress' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ message: REFUSAL });
      const [stored] = await ctx.db
        .select()
        .from(domainRow)
        .where(eq(domainRow.domainId, created.domainId));
      expect(stored.serviceName).toBe('db');
    });

    it('names a row attached before the labels became a map on the next edit, and still takes its removal', async () => {
      // The state the routability check says a refusal at attach time cannot
      // reach: the file was a list when the domain was attached, and `PATCH
      // /compose/:id` — which knows nothing about Domain rows — turned it into a
      // map afterwards.
      const { ownerSession, ownerCtx, stack } = await setUpRawStack(`services:
  wordpress:
    image: wordpress:6
    labels:
      - com.example.owner=platform
`);
      const created = await domains.create(ownerCtx, {
        host: 'shop.example.com',
        composeId: stack.composeId,
        serviceName: 'wordpress',
        domainType: 'compose',
      });
      // Seeded past the guard rather than through `ComposeService.update`,
      // which now refuses exactly this edit — the state under test is a
      // row poisoned *before* that seam existed, or by a direct write, and
      // there is no longer an API call that produces it. Same idiom as
      // `compose-label-claims.e2e-spec.ts`'s stale-claim seed.
      await ctx.db.$client.query(
        'update compose set compose_file = $1 where compose_id = $2',
        [MAP_LABELLED_COMPOSE, stack.composeId],
      );

      // The merged row is what `update` checks, so the next edit of this domain
      // says so — the only thing at a write surface that reaches a row already
      // in this state.
      const patched = await request(server)
        .patch(`/domains/${created.domainId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ port: 3001 });
      expect(patched.status).toBe(400);
      expect(patched.body).toMatchObject({ message: REFUSAL });

      // …and deleting the domain, which *is* the remediation, is never refused.
      const removed = await request(server)
        .delete(`/domains/${created.domainId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);
      const rows = await ctx.db
        .select()
        .from(domainRow)
        .where(eq(domainRow.composeId, stack.composeId));
      expect(rows).toEqual([]);
    });

    it('takes the attach for a git source, whose compose file no domain write can read', async () => {
      // The named gap, pinned so it stays a decision. A git stack's file lives
      // in the repository: `POST /domains` never clones, and the copy on the
      // build server does not exist until the first deploy — the same wall
      // H-83's ownership check hit. The refusal for this stack lands at
      // `GET /compose/:id/converted` and at the deploy instead.
      const env = await setUpApplication();
      const stack = await composeService.create(env.ownerCtx, {
        name: 'Wordpress',
        appName: 'wordpress-stack',
        environmentId: env.environment.environmentId,
      });
      expect(stack.sourceType).toBe('github');

      const res = await request(server)
        .post('/domains')
        .set('Cookie', env.ownerSession.cookie)
        .send({
          host: 'shop.example.com',
          composeId: stack.composeId,
          domainType: 'compose',
          serviceName: 'wordpress',
          port: 8080,
        });

      expect(res.status).toBe(201);
      // Nothing was read off the Server to decide it: a domain write does not
      // depend on the build server being reachable, which is the reason an SSH
      // `cat` here was rejected rather than the reason it was forgotten.
      expect(
        executedCommands().filter((command) =>
          String(command).includes('docker-compose.yml'),
        ),
      ).toEqual([]);
    });

    it('takes a domain on an Application, which has no compose file at all', async () => {
      const { ownerSession, application } = await setUpApplication();

      const res = await request(server)
        .post('/domains')
        .set('Cookie', ownerSession.cookie)
        .send({
          host: 'shop.example.com',
          applicationId: application.applicationId,
        });

      expect(res.status).toBe(201);
    });
  });

  describe('compose deploy integration', () => {
    it('injects domain router labels into the compose file written at deploy', async () => {
      const { ownerCtx, environment } = await setUpApplication();
      const stack = await composeService.create(ownerCtx, {
        name: 'Wordpress',
        appName: 'wordpress-stack',
        environmentId: environment.environmentId,
        composeFile: WORDPRESS_COMPOSE,
      });
      await composeService.update(ownerCtx, stack.composeId, {
        sourceType: 'raw',
      });
      const created = await domains.create(ownerCtx, {
        host: 'shop.example.com',
        composeId: stack.composeId,
        serviceName: 'wordpress',
        domainType: 'compose',
      });

      // As the queue processor would, once the job reaches the worker.
      const deployable = await composeService.findDeployable(stack.composeId);
      await engine.deployCompose(deployable, {
        title: 'Manual deployment',
        description: '',
      });

      // The build step rewrites the compose file over base64 with the
      // domain's router labels injected into the routed service.
      const decodedWrites = executedCommands().flatMap((command) =>
        [...command.matchAll(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/g)].map(
          (match) => Buffer.from(match[1], 'base64').toString('utf-8'),
        ),
      );
      const withLabels = decodedWrites.find((decoded) =>
        decoded.includes('traefik.enable=true'),
      );
      expect(withLabels).toBeDefined();
      expect(withLabels).toContain(
        `traefik.http.routers.wordpress-stack-${created.uniqueConfigKey}-web.rule=Host(\`shop.example.com\`)`,
      );
    });

    it('writes the regenerated router config when an application domain is created', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const created = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        https: true,
        certificateType: 'letsencrypt',
        port: 8080,
        applicationId: application.applicationId,
      });

      expect(traefikWriterMock.writeConfig).toHaveBeenCalledTimes(1);
      const [appName, config, serverId] = traefikWriterMock.writeConfig.mock
        .calls[0] as [string, unknown, string | null];
      const key = created.uniqueConfigKey;

      expect(appName).toBe('blog-app');
      expect(serverId).toBeNull();
      expect(config).toEqual({
        http: {
          routers: {
            [`blog-app-router-${key}`]: {
              rule: 'Host(`blog.example.com`)',
              service: `blog-app-service-${key}`,
              middlewares: ['redirect-to-https'],
              entryPoints: ['web'],
            },
            [`blog-app-router-websecure-${key}`]: {
              rule: 'Host(`blog.example.com`)',
              service: `blog-app-service-${key}`,
              middlewares: [],
              entryPoints: ['websecure'],
              tls: { certResolver: 'letsencrypt' },
            },
          },
          services: {
            [`blog-app-service-${key}`]: {
              loadBalancer: {
                servers: [{ url: 'http://blog-app:8080' }],
                passHostHeader: true,
              },
            },
          },
        },
      });
    });
  });
});
