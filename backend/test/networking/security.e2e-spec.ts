import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { compare } from 'bcryptjs';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { DomainsService } from '../../src/domains/domains.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { SecurityService } from '../../src/networking/security/security.service';
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

describe('Security (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let domains: DomainsService;
  let security: SecurityService;

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
    security = ctx.app.get(SecurityService);
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

  /** An owner ctx plus a project + environment + application to secure. */
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
    it('creates a basic-auth user with the password encrypted at rest', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const created = await security.create(ownerCtx, {
        username: 'admin',
        password: 'hunter2-strong',
        applicationId: application.applicationId,
      });
      expect(created.securityId).toEqual(expect.any(String));

      const found = await security.findOneWithPassword(
        ownerCtx,
        created.securityId,
      );
      expect(found).toMatchObject({
        securityId: created.securityId,
        username: 'admin',
        password: 'hunter2-strong',
        applicationId: application.applicationId,
      });

      // Encrypted at rest: the raw column must not contain the plaintext.
      const raw = await ctx.db.$client.query<{ password: string }>(
        'select password from security where security_id = $1',
        [created.securityId],
      );
      expect(raw.rows[0].password).not.toContain('hunter2-strong');
    });

    it('rejects a duplicate username on the same application', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await security.create(ownerCtx, {
        username: 'admin',
        password: 'hunter2-strong',
        applicationId: application.applicationId,
      });

      await expect(
        security.create(ownerCtx, {
          username: 'admin',
          password: 'other-password',
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('listByApplication', () => {
    it('lists the basic-auth users of one application only', async () => {
      const { ownerCtx, application, environment } = await setUpApplication();
      const other = await applications.create(ownerCtx, {
        name: 'Shop',
        appName: 'shop-app',
        environmentId: environment.environmentId,
      });
      await security.create(ownerCtx, {
        username: 'admin',
        password: 'hunter2-strong',
        applicationId: application.applicationId,
      });
      await security.create(ownerCtx, {
        username: 'editor',
        password: 'other-password',
        applicationId: application.applicationId,
      });
      await security.create(ownerCtx, {
        username: 'shopkeeper',
        password: 'third-password',
        applicationId: other.applicationId,
      });

      const listed = await security.listByApplication(ownerCtx, {
        applicationId: application.applicationId,
      });
      expect(listed.map((row) => row.username).sort()).toEqual([
        'admin',
        'editor',
      ]);
    });

    it('lists nothing for an application with no basic-auth users', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await expect(
        security.listByApplication(ownerCtx, {
          applicationId: application.applicationId,
        }),
      ).resolves.toEqual([]);
    });

    it('never projects the password into a listed row', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await security.create(ownerCtx, {
        username: 'admin',
        password: 'hunter2-strong',
        applicationId: application.applicationId,
      });

      const listed = await security.listByApplication(ownerCtx, {
        applicationId: application.applicationId,
      });
      expect(listed).toHaveLength(1);
      expect(listed[0]).not.toHaveProperty('password');
      expect(JSON.stringify(listed)).not.toContain('hunter2-strong');
    });
  });

  describe('Traefik config regeneration', () => {
    type MiddlewareConfig = {
      http: {
        routers: Record<string, { middlewares: string[] }>;
        middlewares: Record<
          string,
          { basicAuth: { removeHeader: boolean; users: string[] } }
        >;
      };
    };

    const lastWrittenConfig = (): MiddlewareConfig => {
      const calls = traefikWriterMock.writeConfig.mock.calls as unknown[][];
      return calls[calls.length - 1][1] as MiddlewareConfig;
    };

    it('regenerates the auth middleware with a bcrypt-hashed user', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const domain = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      traefikWriterMock.writeConfig.mockClear();

      await security.create(ownerCtx, {
        username: 'admin',
        password: 'hunter2-strong',
        applicationId: application.applicationId,
      });

      expect(traefikWriterMock.writeConfig).toHaveBeenCalledTimes(1);
      const config = lastWrittenConfig();
      const middleware = config.http.middlewares['auth-blog-app'];
      expect(middleware.basicAuth.removeHeader).toBe(true);
      expect(middleware.basicAuth.users).toHaveLength(1);

      const [user, hash] = middleware.basicAuth.users[0].split(/:(.+)/);
      expect(user).toBe('admin');
      await expect(compare('hunter2-strong', hash)).resolves.toBe(true);

      expect(
        config.http.routers[`blog-app-router-${domain.uniqueConfigKey}`]
          .middlewares,
      ).toContain('auth-blog-app');
    });

    it('accumulates every basic-auth user into the shared middleware', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      await security.create(ownerCtx, {
        username: 'admin',
        password: 'hunter2-strong',
        applicationId: application.applicationId,
      });
      await security.create(ownerCtx, {
        username: 'editor',
        password: 'other-password',
        applicationId: application.applicationId,
      });

      const users =
        lastWrittenConfig().http.middlewares['auth-blog-app'].basicAuth.users;
      expect(users.map((user) => user.split(':')[0]).sort()).toEqual([
        'admin',
        'editor',
      ]);
    });

    it('drops the middleware and its router references when the last user is removed', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const domain = await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      const created = await security.create(ownerCtx, {
        username: 'admin',
        password: 'hunter2-strong',
        applicationId: application.applicationId,
      });
      traefikWriterMock.writeConfig.mockClear();

      await security.remove(ownerCtx, created.securityId);

      expect(traefikWriterMock.writeConfig).toHaveBeenCalledTimes(1);
      const config = lastWrittenConfig();
      expect(config.http.middlewares?.['auth-blog-app']).toBeUndefined();
      expect(
        config.http.routers[`blog-app-router-${domain.uniqueConfigKey}`]
          .middlewares,
      ).not.toContain('auth-blog-app');

      await expect(
        security.findOne(ownerCtx, created.securityId),
      ).rejects.toThrow(NotFoundException);
    });

    it('rehashes the middleware user on update', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      const created = await security.create(ownerCtx, {
        username: 'admin',
        password: 'hunter2-strong',
        applicationId: application.applicationId,
      });

      const updated = await security.update(ownerCtx, created.securityId, {
        password: 'rotated-password',
      });
      expect(updated).not.toHaveProperty('password');
      await expect(
        security.findOneWithPassword(ownerCtx, created.securityId),
      ).resolves.toMatchObject({ password: 'rotated-password' });

      const users =
        lastWrittenConfig().http.middlewares['auth-blog-app'].basicAuth.users;
      const [, hash] = users[0].split(/:(.+)/);
      await expect(compare('rotated-password', hash)).resolves.toBe(true);
    });

    /**
     * H-22. A `:` in the username makes `${username}:${hash}` three parts, and
     * Traefik's `basicUserParser` refuses anything that is not two — which
     * fails the middleware constructor, which makes `router.go` skip every
     * router naming it, which takes the whole Application dark behind a 404.
     *
     * The rule is on the DTO now (`security.dto.spec.ts`), but
     * `updateSecuritySchema` is `.partial()` and `RedirectsService` and
     * `DomainsService` reach the emitter without naming a `security` row at
     * all — so a username stored before the rule is re-emitted rather than
     * left alone. This asserts the seam that stops it, and asserts it through
     * a request that does *not* carry the offending field, because a request
     * that carries it was never the problem.
     */
    it('refuses to regenerate an app whose stored basic-auth username carries the htpasswd separator', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await domains.create(ownerCtx, {
        host: 'blog.example.com',
        applicationId: application.applicationId,
      });
      const created = await security.create(ownerCtx, {
        username: 'admin',
        password: 'hunter2-strong',
        applicationId: application.applicationId,
      });
      // The row as a pre-rule write would have left it.
      await ctx.db.$client.query(
        'update security set username = $1 where security_id = $2',
        ['admin:$2b$10$forged', created.securityId],
      );
      traefikWriterMock.writeConfig.mockClear();

      await expect(
        security.update(ownerCtx, created.securityId, {
          password: 'rotated-password',
        }),
      ).rejects.toThrow(
        `Basic-auth user ${created.securityId} has a stored value Traefik cannot be given`,
      );

      // Nothing was written on the way to being refused — in particular no
      // `users` entry that Traefik would have refused to parse.
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
        security.create(memberCtx, {
          username: 'admin',
          password: 'hunter2-strong',
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(ForbiddenException);

      const created = await security.create(ownerCtx, {
        username: 'admin',
        password: 'hunter2-strong',
        applicationId: application.applicationId,
      });
      await expect(
        security.findOne(memberCtx, created.securityId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        security.remove(memberCtx, created.securityId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        security.listByApplication(memberCtx, {
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('hides basic-auth users and parents from other organizations', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const created = await security.create(ownerCtx, {
        username: 'admin',
        password: 'hunter2-strong',
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
        security.findOne(secondOrgCtx, created.securityId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        security.create(secondOrgCtx, {
          username: 'intruder',
          password: 'other-password',
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(NotFoundException);
      // Another organization's application reads as absent, not forbidden.
      await expect(
        security.listByApplication(secondOrgCtx, {
          applicationId: application.applicationId,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('HTTP surface', () => {
    it('creates, lists, updates and deletes a basic-auth user through the controller', async () => {
      const { ownerSession, application } = await setUpApplication();

      const invalid = await request(server)
        .post('/security')
        .set('Cookie', ownerSession.cookie)
        .send({ applicationId: application.applicationId, username: 'admin' });
      expect(invalid.status).toBe(400);

      const created = await request(server)
        .post('/security')
        .set('Cookie', ownerSession.cookie)
        .send({
          username: 'admin',
          password: 'hunter2-strong',
          applicationId: application.applicationId,
        });
      expect(created.status).toBe(201);
      const { securityId } = created.body as { securityId: string };

      const listed = await request(server)
        .get('/security')
        .query({ applicationId: application.applicationId })
        .set('Cookie', ownerSession.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect((listed.body as { securityId: string }[])[0].securityId).toBe(
        securityId,
      );

      const unscoped = await request(server)
        .get('/security')
        .set('Cookie', ownerSession.cookie);
      expect(unscoped.status).toBe(400);

      const found = await request(server)
        .get(`/security/${securityId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ username: 'admin' });

      const updated = await request(server)
        .patch(`/security/${securityId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ username: 'root' });
      expect(updated.status).toBe(200);
      expect((updated.body as { username: string }).username).toBe('root');

      const removed = await request(server)
        .delete(`/security/${securityId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/security/${securityId}`)
        .set('Cookie', ownerSession.cookie);
      expect(gone.status).toBe(404);

      const emptied = await request(server)
        .get('/security')
        .query({ applicationId: application.applicationId })
        .set('Cookie', ownerSession.cookie);
      expect(emptied.status).toBe(200);
      expect(emptied.body).toEqual([]);
    });

    it('never sends the basic-auth password over the wire', async () => {
      const { ownerSession, application } = await setUpApplication();

      const created = await request(server)
        .post('/security')
        .set('Cookie', ownerSession.cookie)
        .send({
          username: 'admin',
          password: 'hunter2-strong',
          applicationId: application.applicationId,
        });
      expect(created.status).toBe(201);
      expect(created.text).not.toContain('hunter2-strong');
      const { securityId } = created.body as { securityId: string };

      const listed = await request(server)
        .get('/security')
        .query({ applicationId: application.applicationId })
        .set('Cookie', ownerSession.cookie);
      expect(listed.text).not.toContain('hunter2-strong');
      expect((listed.body as Record<string, unknown>[])[0]).not.toHaveProperty(
        'password',
      );

      const found = await request(server)
        .get(`/security/${securityId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).not.toHaveProperty('password');
      expect(found.text).not.toContain('hunter2-strong');

      // Renaming the user must not echo back the credential it did not send.
      const updated = await request(server)
        .patch(`/security/${securityId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ username: 'root' });
      expect(updated.body).not.toHaveProperty('password');
      expect(updated.text).not.toContain('hunter2-strong');

      const removed = await request(server)
        .delete(`/security/${securityId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.body).not.toHaveProperty('password');
      expect(removed.text).not.toContain('hunter2-strong');
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
        .get('/security')
        .query({ applicationId: application.applicationId })
        .set('Cookie', ownerSession.cookie);
      expect(listed.status).toBe(404);
    });
  });
});
