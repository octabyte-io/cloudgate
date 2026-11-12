import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { certificate } from '../../src/db/schema';
import type { CertificateType } from '../../src/domains/domain.schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import {
  SHOP_EXAMPLE_COM_PEM,
  WILDCARD_EXAMPLE_COM_PEM,
} from './fixtures/stored-certificates';

jest.setTimeout(120_000);

/**
 * A Domain served by a certificate from Settings → Certificates, over
 * HTTP: `stored` is refused for a host no stored certificate covers, emits
 * `tls: {}` when one does, and the Domains listing names the certificate
 * Traefik serves — for a `stored` row and for a `letsencrypt` row alike,
 * because a stored certificate wins over the resolver. The Environment's
 * Domains feed carries the same field, by the same rule.
 */
describe('Domain stored certificates (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        {
          provide: RemoteExecService,
          useValue: { execAsync: jest.fn(), execAsyncRemote: jest.fn() },
        },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    traefikWriterMock.loadOrCreateConfig
      .mockReset()
      .mockResolvedValue({ http: { routers: {}, services: {} } });
    traefikWriterMock.writeConfig.mockReset().mockResolvedValue(undefined);
    traefikWriterMock.removeConfig.mockReset().mockResolvedValue(undefined);
  });

  /** An owner, an Application on the platform host, and a Server row. */
  async function setUp() {
    const signUp = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    const cookie = signUp.headers['set-cookie'];
    const userId = (signUp.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const permission = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };

    const project = await ctx.app
      .get(ProjectsService)
      .create(permission, { name: 'cloudgate' });
    const environment = await ctx.app
      .get(EnvironmentsService)
      .create(permission, { name: 'production', projectId: project.projectId });
    const application = await ctx.app
      .get(ApplicationsService)
      .create(permission, {
        name: 'Shop',
        appName: 'shop-app',
        environmentId: environment.environmentId,
      });
    const inserted = await ctx.db.$client.query<{ server_id: string }>(
      `insert into server (server_id, name, ip_address, port, created_at, organization_id)
       values ('srv-1', 'edge', '192.168.1.10', 22, $1, $2) returning server_id`,
      [new Date().toISOString(), organizationId],
    );

    return {
      cookie,
      organizationId,
      applicationId: application.applicationId,
      environmentId: environment.environmentId,
      serverId: inserted.rows[0].server_id,
    };
  }

  const addCertificate = (
    organizationId: string,
    name: string,
    certificateData: string,
    serverId: string | null = null,
  ) =>
    ctx.db.insert(certificate).values({
      name,
      certificateData,
      privateKey: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
      organizationId,
      serverId,
    });

  const addDomain = (
    cookie: string,
    applicationId: string,
    host: string,
    certificateType: CertificateType,
  ) =>
    request(server).post('/domains').set('Cookie', cookie).send({
      host,
      https: true,
      certificateType,
      applicationId,
    });

  const listed = async (cookie: string, applicationId: string) =>
    (
      await request(server)
        .get(`/applications/${applicationId}/domains`)
        .set('Cookie', cookie)
    ).body as {
      host: string;
      storedCertificate: { certificateId: string; name: string } | null;
    }[];

  it('refuses stored for a host no stored certificate covers, and stores nothing', async () => {
    const { cookie, organizationId, applicationId, serverId } = await setUp();
    // Covers the host, but on another machine's Traefik.
    await addCertificate(
      organizationId,
      'edge only',
      SHOP_EXAMPLE_COM_PEM,
      serverId,
    );

    const res = await addDomain(
      cookie,
      applicationId,
      'shop.example.com',
      'stored',
    );

    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toBe(
      'No certificate in Settings → Certificates covers shop.example.com on this platform host. Add one whose names include it, or choose another certificate',
    );
    expect(await listed(cookie, applicationId)).toEqual([]);
    expect(traefikWriterMock.writeConfig).not.toHaveBeenCalled();
  });

  it('takes stored for a covered host, emits tls {} and names the certificate', async () => {
    const { cookie, organizationId, applicationId } = await setUp();
    await addCertificate(organizationId, 'shop cert', SHOP_EXAMPLE_COM_PEM);

    const res = await addDomain(
      cookie,
      applicationId,
      'shop.example.com',
      'stored',
    );

    expect(res.status).toBe(201);
    const key = (res.body as { uniqueConfigKey: number }).uniqueConfigKey;
    const [, config] = traefikWriterMock.writeConfig.mock.calls[0] as [
      string,
      { http: { routers: Record<string, { tls?: unknown }> } },
    ];
    expect(config.http.routers[`shop-app-router-websecure-${key}`].tls).toEqual(
      {},
    );
    expect(await listed(cookie, applicationId)).toEqual([
      expect.objectContaining({
        host: 'shop.example.com',
        storedCertificate: {
          certificateId: expect.any(String) as string,
          name: 'shop cert',
        },
      }),
    ]);
  });

  it("names a wildcard covering a Let's Encrypt host, which Traefik serves instead", async () => {
    const { cookie, organizationId, applicationId } = await setUp();
    await addCertificate(
      organizationId,
      'com wildcard',
      WILDCARD_EXAMPLE_COM_PEM,
    );

    expect(
      (
        await addDomain(
          cookie,
          applicationId,
          'blog.example.com',
          'letsencrypt',
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await addDomain(
          cookie,
          applicationId,
          'blog.example.net',
          'letsencrypt',
        )
      ).status,
    ).toBe(201);

    const byHost = Object.fromEntries(
      (await listed(cookie, applicationId)).map((row) => [
        row.host,
        row.storedCertificate?.name ?? null,
      ]),
    );
    expect(byHost).toEqual({
      'blog.example.com': 'com wildcard',
      'blog.example.net': null,
    });
  });

  it('refuses an edit that moves a stored domain onto a host its certificate does not cover', async () => {
    const { cookie, organizationId, applicationId } = await setUp();
    await addCertificate(organizationId, 'shop cert', SHOP_EXAMPLE_COM_PEM);
    const created = await addDomain(
      cookie,
      applicationId,
      'shop.example.com',
      'stored',
    );
    const domainId = (created.body as { domainId: string }).domainId;

    const moved = await request(server)
      .patch(`/domains/${domainId}`)
      .set('Cookie', cookie)
      .send({ host: 'www.example.com' });
    expect(moved.status).toBe(400);

    // Choosing another certificate is the way out, and it always passes.
    const switched = await request(server)
      .patch(`/domains/${domainId}`)
      .set('Cookie', cookie)
      .send({ host: 'www.example.com', certificateType: 'letsencrypt' });
    expect(switched.status).toBe(200);
  });

  it("carries the same storedCertificate on the Environment's Domains feed", async () => {
    const { cookie, organizationId, applicationId, environmentId } =
      await setUp();
    await addCertificate(
      organizationId,
      'com wildcard',
      WILDCARD_EXAMPLE_COM_PEM,
    );
    await addCertificate(organizationId, 'shop cert', SHOP_EXAMPLE_COM_PEM);
    await addDomain(cookie, applicationId, 'shop.example.com', 'stored');
    await addDomain(cookie, applicationId, 'blog.example.com', 'letsencrypt');
    await addDomain(cookie, applicationId, 'blog.example.net', 'letsencrypt');

    const feed = await request(server)
      .get(`/environments/${environmentId}/domains`)
      .set('Cookie', cookie);

    expect(feed.status).toBe(200);
    expect(
      Object.fromEntries(
        (
          feed.body as {
            host: string;
            storedCertificate: { name: string } | null;
          }[]
        ).map((row) => [row.host, row.storedCertificate?.name ?? null]),
      ),
    ).toEqual({
      'blog.example.com': 'com wildcard',
      'blog.example.net': null,
      'shop.example.com': 'shop cert',
    });
  });
});
