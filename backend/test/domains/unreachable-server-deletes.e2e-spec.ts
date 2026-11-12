import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { application } from '../../src/applications/application.schema';
import { ApplicationsService } from '../../src/applications/applications.service';
import { ROUTE_REMOVAL_UNREACHABLE_CODE } from '../../src/common/workload-kept-refusal';
import { domain, redirect, security } from '../../src/db/schema';
import { DomainsService } from '../../src/domains/domains.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { RedirectsService } from '../../src/networking/redirects/redirects.service';
import { SecurityService } from '../../src/networking/security/security.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { ServersService } from '../../src/servers/servers.service';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';

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

/**
 * **A delete of a row the Server's Traefik file is written from, when that
 * Server cannot be reached** (#1417).
 *
 * A Domain, a redirect and a basic-auth user each live twice: as a row, and as
 * part of `dynamic/<appName>.yml` on the Server the Application runs on. The
 * three deletes dropped the row and *then* rewrote the file, so on a Server
 * that did not answer the SSH error came out of the writer as a 500, after the
 * row had already gone: the operator was told nothing they could act on, and
 * the file went on routing what the database no longer had.
 *
 * The delete and the file's rewrite are one change (ADR-0068's shape), and a
 * Server that is not reached is answered the way an Application Delete answers
 * one: a 409 that names the Server and keeps the row, to delete again when it
 * answers. With `?force=true` the row goes and the response names the router
 * left in the Server's file (ADR-0018) — the way out for a Server that is gone
 * for good.
 */
describe('Routing deletes on an unreachable Server (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let domains: DomainsService;
  let redirects: RedirectsService;
  let securityUsers: SecurityService;
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
    domains = ctx.app.get(DomainsService);
    redirects = ctx.app.get(RedirectsService);
    securityUsers = ctx.app.get(SecurityService);
    servers = ctx.app.get(ServersService);
    sshKeys = ctx.app.get(SshKeysService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    remoteExec.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    remoteExec.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  /**
   * The owner and `storefront` on `worker-1`, with one Domain, one redirect
   * and one basic-auth user written while the Server still answered.
   */
  async function setUp() {
    const signedUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signedUp.status).toBe(200);
    const cookie = signedUp.headers['set-cookie'];
    const ownerId = (signedUp.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
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

    const created = await domains.create(ownerCtx, {
      host: 'shop.example.com',
      applicationId: app.applicationId,
    });
    const sibling = await domains.create(ownerCtx, {
      host: 'www.example.com',
      applicationId: app.applicationId,
    });
    const rule = await redirects.create(ownerCtx, {
      regex: '^https://old.example.com/(.*)',
      replacement: 'https://shop.example.com/$1',
      applicationId: app.applicationId,
    });
    const user = await securityUsers.create(ownerCtx, {
      username: 'admin',
      password: 'hunter2-strong',
      applicationId: app.applicationId,
    });

    // From here on the Server does not answer.
    remoteExec.execAsyncRemote.mockRejectedValue(
      new ExecError(
        'SSH connection error: connect ECONNREFUSED 203.0.113.10:22',
        { command: 'cat', serverId: worker.serverId },
      ),
    );
    return {
      cookie,
      created,
      sibling,
      rule,
      user,
      serverId: worker.serverId,
    };
  }

  /** A 409 that names the Server, says it was not reached, and offers force. */
  function expectKept(res: request.Response, noun: string) {
    expect(res.status).toBe(409);
    const body = res.body as { code?: string; message?: string };
    expect(body.code).toBe(ROUTE_REMOVAL_UNREACHABLE_CODE);
    expect(body.message).toContain('Server worker-1 could not be reached');
    expect(body.message).toContain(`so the ${noun} was kept`);
    expect(body.message).toContain('?force=true');
  }

  /** The router a forced delete leaves in `worker-1`'s file, at its own path. */
  const routerLeftOn = (serverId: string) => ({
    kind: 'traefik-config',
    appName: 'app-storefront',
    serverId,
    path: '/etc/cloudgate/traefik/dynamic/app-storefront.yml',
  });

  describe('without force', () => {
    it('refuses a Domain delete with a 409 naming the Server, and keeps the Domain', async () => {
      const { cookie, created } = await setUp();

      const res = await request(server)
        .delete(`/domains/${created.domainId}`)
        .set('Cookie', cookie);

      expectKept(res, 'Domain');
      const kept = await ctx.db
        .select()
        .from(domain)
        .where(eq(domain.domainId, created.domainId));
      expect(kept).toHaveLength(1);
    });

    it('refuses the delete of an Application’s last Domain the same way', async () => {
      const { cookie, created, sibling } = await setUp();
      // The file is then removed rather than rewritten.
      await ctx.db.delete(domain).where(eq(domain.domainId, sibling.domainId));

      const res = await request(server)
        .delete(`/domains/${created.domainId}`)
        .set('Cookie', cookie);

      expectKept(res, 'Domain');
      const kept = await ctx.db
        .select()
        .from(domain)
        .where(eq(domain.domainId, created.domainId));
      expect(kept).toHaveLength(1);
    });

    it('refuses a redirect delete with a 409 naming the Server, and keeps the redirect', async () => {
      const { cookie, rule } = await setUp();

      const res = await request(server)
        .delete(`/redirects/${rule.redirectId}`)
        .set('Cookie', cookie);

      expectKept(res, 'redirect');
      const kept = await ctx.db
        .select()
        .from(redirect)
        .where(eq(redirect.redirectId, rule.redirectId));
      expect(kept).toHaveLength(1);
    });

    it('refuses a basic-auth user delete with a 409 naming the Server, and keeps the user', async () => {
      const { cookie, user } = await setUp();

      const res = await request(server)
        .delete(`/security/${user.securityId}`)
        .set('Cookie', cookie);

      expectKept(res, 'basic-auth user');
      const kept = await ctx.db
        .select()
        .from(security)
        .where(eq(security.securityId, user.securityId));
      expect(kept).toHaveLength(1);
    });
  });

  describe('with ?force=true', () => {
    it('deletes the Domain and names the router left in the Server’s file', async () => {
      const { cookie, created, serverId } = await setUp();

      const res = await request(server)
        .delete(`/domains/${created.domainId}?force=true`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      const body = res.body as {
        domainId: string;
        unreclaimedArtifacts: unknown;
      };
      expect(body.domainId).toBe(created.domainId);
      expect(body.unreclaimedArtifacts).toEqual([routerLeftOn(serverId)]);
      const gone = await ctx.db
        .select()
        .from(domain)
        .where(eq(domain.domainId, created.domainId));
      expect(gone).toHaveLength(0);
    });

    it('deletes an Application’s last Domain and names the file it could not remove', async () => {
      const { cookie, created, sibling, serverId } = await setUp();
      await ctx.db.delete(domain).where(eq(domain.domainId, sibling.domainId));

      const res = await request(server)
        .delete(`/domains/${created.domainId}?force=true`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(
        (res.body as { unreclaimedArtifacts: unknown }).unreclaimedArtifacts,
      ).toEqual([routerLeftOn(serverId)]);
      const gone = await ctx.db
        .select()
        .from(domain)
        .where(eq(domain.domainId, created.domainId));
      expect(gone).toHaveLength(0);
    });

    it('deletes the redirect and names the router left in the Server’s file', async () => {
      const { cookie, rule, serverId } = await setUp();

      const res = await request(server)
        .delete(`/redirects/${rule.redirectId}?force=true`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(
        (res.body as { unreclaimedArtifacts: unknown }).unreclaimedArtifacts,
      ).toEqual([routerLeftOn(serverId)]);
      const gone = await ctx.db
        .select()
        .from(redirect)
        .where(eq(redirect.redirectId, rule.redirectId));
      expect(gone).toHaveLength(0);
    });

    it('deletes the basic-auth user, names the file still holding it, and returns no password', async () => {
      const { cookie, user, serverId } = await setUp();

      const res = await request(server)
        .delete(`/security/${user.securityId}?force=true`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect(body.securityId).toBe(user.securityId);
      expect(body).not.toHaveProperty('password');
      expect(body.unreclaimedArtifacts).toEqual([routerLeftOn(serverId)]);
      const gone = await ctx.db
        .select()
        .from(security)
        .where(eq(security.securityId, user.securityId));
      expect(gone).toHaveLength(0);
    });

    it('answers a forced delete on a Server that answers with no report', async () => {
      const { cookie, created } = await setUp();
      remoteExec.execAsyncRemote
        .mockReset()
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const res = await request(server)
        .delete(`/domains/${created.domainId}?force=true`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('unreclaimedArtifacts');
    });
  });
});
