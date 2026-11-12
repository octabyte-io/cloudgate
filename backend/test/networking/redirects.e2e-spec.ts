import { ForbiddenException, NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { DomainsService } from '../../src/domains/domains.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { RedirectsService } from '../../src/networking/redirects/redirects.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
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

describe('Redirects (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let domains: DomainsService;
  let redirects: RedirectsService;

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
    redirects = ctx.app.get(RedirectsService);
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

  /** An owner ctx plus a project + environment + application to attach redirects to. */
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
    it('creates a redirect retrievable with its defaults', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const created = await redirects.create(ownerCtx, {
        regex: 'https://old.example.com/(.*)',
        replacement: 'https://new.example.com/$1',
        applicationId: application.applicationId,
      });

      expect(created.redirectId).toEqual(expect.any(String));
      expect(created.permanent).toBe(false);
      expect(created.uniqueConfigKey).toEqual(expect.any(Number));

      const found = await redirects.findOne(ownerCtx, created.redirectId);
      expect(found).toMatchObject({
        redirectId: created.redirectId,
        regex: 'https://old.example.com/(.*)',
        replacement: 'https://new.example.com/$1',
        applicationId: application.applicationId,
      });
    });
  });

  describe('listByApplication', () => {
    it('lists the redirects of one application only', async () => {
      const { ownerCtx, application, environment } = await setUpApplication();
      const other = await applications.create(ownerCtx, {
        name: 'Shop',
        appName: 'shop-app',
        environmentId: environment.environmentId,
      });
      await redirects.create(ownerCtx, {
        regex: 'https://old.example.com/(.*)',
        replacement: 'https://new.example.com/$1',
        applicationId: application.applicationId,
      });
      await redirects.create(ownerCtx, {
        regex: '^/legacy/(.*)',
        replacement: '/$1',
        permanent: true,
        applicationId: application.applicationId,
      });
      await redirects.create(ownerCtx, {
        regex: '^/shop/(.*)',
        replacement: '/store/$1',
        applicationId: other.applicationId,
      });

      const listed = await redirects.listByApplication(ownerCtx, {
        applicationId: application.applicationId,
      });
      expect(listed.map((row) => row.regex).sort()).toEqual([
        '^/legacy/(.*)',
        'https://old.example.com/(.*)',
      ]);
    });

    it('lists nothing for an application with no redirects', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await expect(
        redirects.listByApplication(ownerCtx, {
          applicationId: application.applicationId,
        }),
      ).resolves.toEqual([]);
    });
  });

  describe('Traefik config regeneration', () => {
    it('regenerates the app config with the redirect middleware attached to its routers', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const domain = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      traefikWriterMock.writeConfig.mockClear();

      const created = await redirects.create(ownerCtx, {
        regex: 'https://old.example.com/(.*)',
        replacement: 'https://new.example.com/$1',
        permanent: true,
        applicationId: application.applicationId,
      });

      expect(traefikWriterMock.writeConfig).toHaveBeenCalledTimes(1);
      const [appName, config, serverId] = traefikWriterMock.writeConfig.mock
        .calls[0] as [
        string,
        {
          http: {
            routers: Record<string, { middlewares: string[] }>;
            middlewares: Record<string, unknown>;
          };
        },
        string | null,
      ];

      expect(appName).toBe('blog-app');
      expect(serverId).toBeNull();
      const middlewareName = `redirect-blog-app-${created.uniqueConfigKey}`;
      expect(config.http.middlewares[middlewareName]).toEqual({
        redirectRegex: {
          regex: 'https://old.example.com/(.*)',
          replacement: 'https://new.example.com/$1',
          permanent: true,
        },
      });
      expect(
        config.http.routers[`blog-app-router-${domain.uniqueConfigKey}`]
          .middlewares,
      ).toContain(middlewareName);
    });

    it('regenerates the middleware with updated values on update', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      const created = await redirects.create(ownerCtx, {
        regex: 'https://old.example.com/(.*)',
        replacement: 'https://new.example.com/$1',
        applicationId: application.applicationId,
      });
      traefikWriterMock.writeConfig.mockClear();

      const updated = await redirects.update(ownerCtx, created.redirectId, {
        replacement: 'https://newer.example.com/$1',
      });
      expect(updated.replacement).toBe('https://newer.example.com/$1');

      expect(traefikWriterMock.writeConfig).toHaveBeenCalledTimes(1);
      const [, config] = traefikWriterMock.writeConfig.mock.calls[0] as [
        string,
        { http: { middlewares: Record<string, unknown> } },
      ];
      expect(
        config.http.middlewares[`redirect-blog-app-${created.uniqueConfigKey}`],
      ).toEqual({
        redirectRegex: {
          regex: 'https://old.example.com/(.*)',
          replacement: 'https://newer.example.com/$1',
          permanent: false,
        },
      });
    });

    it('drops the middleware and its router references on remove', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const domain = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      const created = await redirects.create(ownerCtx, {
        regex: 'https://old.example.com/(.*)',
        replacement: 'https://new.example.com/$1',
        applicationId: application.applicationId,
      });
      traefikWriterMock.writeConfig.mockClear();

      await redirects.remove(ownerCtx, created.redirectId);

      expect(traefikWriterMock.writeConfig).toHaveBeenCalledTimes(1);
      const [, config] = traefikWriterMock.writeConfig.mock.calls[0] as [
        string,
        {
          http: {
            routers: Record<string, { middlewares: string[] }>;
            middlewares?: Record<string, unknown>;
          };
        },
      ];
      const middlewareName = `redirect-blog-app-${created.uniqueConfigKey}`;
      expect(config.http.middlewares?.[middlewareName]).toBeUndefined();
      expect(
        config.http.routers[`blog-app-router-${domain.uniqueConfigKey}`]
          .middlewares,
      ).not.toContain(middlewareName);

      await expect(
        redirects.findOne(ownerCtx, created.redirectId),
      ).rejects.toThrow(NotFoundException);
    });

    /**
     * H-24. The bounds on `regex`/`replacement` are hygiene — the YAML writer
     * cannot be escaped, which `redirect.dto.spec.ts` proves against the writer
     * itself — but a bound that only new writes reach is not a bound.
     * `updateRedirectSchema` is `.partial()`, so a `permanent`-only PATCH never
     * shows the stored rule to any schema, and the emitter rewrites the whole
     * file from stored rows. That is the mechanism X05-1 filed against
     * `path`, and the reason a hygiene rule still gets an emitter guard.
     */
    it('refuses to regenerate an app whose stored redirect is outside the rule', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      const created = await redirects.create(ownerCtx, {
        regex: 'https://old.example.com/(.*)',
        replacement: 'https://new.example.com/$1',
        applicationId: application.applicationId,
      });
      // The row as a pre-rule write would have left it: the DTO refuses this
      // on the way in now, so the only way to have one is to have had one.
      await ctx.db.$client.query(
        'update redirect set regex = $1 where redirect_id = $2',
        ['a'.repeat(2000), created.redirectId],
      );
      traefikWriterMock.writeConfig.mockClear();

      await expect(
        redirects.update(ownerCtx, created.redirectId, { permanent: true }),
      ).rejects.toThrow(
        `Redirect ${created.redirectId} has a stored value Traefik cannot be given`,
      );

      // Nothing was written on the way to being refused.
      expect(traefikWriterMock.writeConfig).not.toHaveBeenCalled();
    });
  });

  describe('row-level access', () => {
    it('denies a member without row access to the parent application', async () => {
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
        redirects.create(memberCtx, {
          regex: 'https://old.example.com/(.*)',
          replacement: 'https://new.example.com/$1',
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(ForbiddenException);

      const created = await redirects.create(ownerCtx, {
        regex: 'https://old.example.com/(.*)',
        replacement: 'https://new.example.com/$1',
        applicationId: application.applicationId,
      });
      await expect(
        redirects.findOne(memberCtx, created.redirectId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        redirects.remove(memberCtx, created.redirectId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        redirects.listByApplication(memberCtx, {
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('hides redirects and parents from other organizations', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const created = await redirects.create(ownerCtx, {
        regex: 'https://old.example.com/(.*)',
        replacement: 'https://new.example.com/$1',
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

      await expect(
        redirects.findOne(secondOrgCtx, created.redirectId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        redirects.create(secondOrgCtx, {
          regex: 'https://evil.example.com/(.*)',
          replacement: 'https://new.example.com/$1',
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(NotFoundException);
      // Another organization's application reads as absent, not forbidden.
      await expect(
        redirects.listByApplication(secondOrgCtx, {
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('HTTP surface', () => {
    it('creates, lists, updates and deletes a redirect through the controller', async () => {
      const { ownerSession, application } = await setUpApplication();

      const invalid = await request(server)
        .post('/redirects')
        .set('Cookie', ownerSession.cookie)
        .send({ applicationId: application.applicationId });
      expect(invalid.status).toBe(400);

      const created = await request(server)
        .post('/redirects')
        .set('Cookie', ownerSession.cookie)
        .send({
          regex: 'https://old.example.com/(.*)',
          replacement: 'https://new.example.com/$1',
          applicationId: application.applicationId,
        });
      expect(created.status).toBe(201);
      const { redirectId } = created.body as { redirectId: string };

      const listed = await request(server)
        .get('/redirects')
        .query({ applicationId: application.applicationId })
        .set('Cookie', ownerSession.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect((listed.body as { redirectId: string }[])[0].redirectId).toBe(
        redirectId,
      );

      const unscoped = await request(server)
        .get('/redirects')
        .set('Cookie', ownerSession.cookie);
      expect(unscoped.status).toBe(400);

      const found = await request(server)
        .get(`/redirects/${redirectId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({
        regex: 'https://old.example.com/(.*)',
      });

      const updated = await request(server)
        .patch(`/redirects/${redirectId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ permanent: true });
      expect(updated.status).toBe(200);
      expect((updated.body as { permanent: boolean }).permanent).toBe(true);

      const removed = await request(server)
        .delete(`/redirects/${redirectId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/redirects/${redirectId}`)
        .set('Cookie', ownerSession.cookie);
      expect(gone.status).toBe(404);

      const emptied = await request(server)
        .get('/redirects')
        .query({ applicationId: application.applicationId })
        .set('Cookie', ownerSession.cookie);
      expect(emptied.status).toBe(200);
      expect(emptied.body).toEqual([]);
    });

    it('reads another organization application as absent', async () => {
      const { ownerSession, application } = await setUpApplication();

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const switched = await request(server)
        .post('/api/auth/organization/set-active')
        .set('Cookie', ownerSession.cookie)
        .send({ organizationId: (secondOrg.body as { id: string }).id });
      expect(switched.status).toBe(200);

      const listed = await request(server)
        .get('/redirects')
        .query({ applicationId: application.applicationId })
        .set('Cookie', ownerSession.cookie);
      expect(listed.status).toBe(404);
    });
  });
});
