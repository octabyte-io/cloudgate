import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { LicenseService } from '../../src/enterprise/license/license.service';
import { defaultWebServerMetricsConfig } from '../../src/settings/settings.schema';
import { SettingsService } from '../../src/settings/settings.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';

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

/** `PermissionService.checkInstanceAuthority`'s refusal, written out. */
const INSTANCE_AUTHORITY_REFUSAL =
  'Only an owner or admin of the instance organization can configure the platform host';

/** `SettingsService.requireInstanceLicense`'s refusal, written out. */
const LICENSE_REFUSAL = 'Valid enterprise license required';

/** The message an `AllExceptionsFilter` response carries. */
const refusal = (res: { body: unknown }): string =>
  (res.body as { message: string }).message;

/** The unbranded instance: every field null, nothing overridden. */
const unbranded = {
  appName: null,
  logoUrl: null,
  faviconUrl: null,
  primaryColor: null,
  accentColor: null,
  customCss: null,
  errorPages: {
    notFoundMessage: null,
    serverErrorMessage: null,
    supportUrl: null,
  },
};

describe('White-labeling (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;

  const license = {
    hasValidLicense: jest.fn<Promise<boolean>, [string]>(),
    hasAnyValidLicense: jest.fn<Promise<boolean>, []>(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: LicenseService, useValue: license }],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    license.hasValidLicense.mockResolvedValue(true);
    license.hasAnyValidLicense.mockResolvedValue(true);
    ownerCookie = (await signUp(httpServer, owner)).cookie;
  });

  /** A plain 'member' of the owner's organization who accepted the invite. */
  async function inviteMember(): Promise<string> {
    const invite = await request(httpServer)
      .post('/organizations/invitations')
      .set('Cookie', ownerCookie)
      .send({ email: 'member@example.com', role: 'member' });
    expect(invite.status).toBe(201);

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .set('x-cloudgate-token', (invite.body as { id: string }).id)
      .send({
        name: 'Ida Rhodes',
        email: 'member@example.com',
        password: 'super-secret-password',
      });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'];

    // Signing up with the token alone creates no member row — the invitation
    // has to be accepted for the session to have an organization at all.
    const accept = await request(httpServer)
      .post(
        `/organizations/invitations/${(invite.body as { id: string }).id}/accept`,
      )
      .set('Cookie', cookie);
    expect(accept.status).toBe(201);
    return cookie;
  }

  describe('the public read', () => {
    it('answers an unbranded instance with the default, with no session', async () => {
      const res = await request(httpServer).get('/settings/whitelabeling');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(unbranded);
    });
  });

  describe('the enterprise-gated write', () => {
    it('brands the instance for a licensed owner, and the public read says so', async () => {
      const patch = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({
          appName: 'Acme Cloud',
          logoUrl: 'https://cdn.acme.example.com/logo.svg',
          primaryColor: '#ff6600',
        });

      expect(patch.status).toBe(200);
      expect(patch.body).toEqual({
        ...unbranded,
        appName: 'Acme Cloud',
        logoUrl: 'https://cdn.acme.example.com/logo.svg',
        primaryColor: '#ff6600',
      });

      const read = await request(httpServer).get('/settings/whitelabeling');
      expect(read.status).toBe(200);
      expect(read.body).toEqual(patch.body);
    });

    it('merges a partial write instead of replacing the whole blob', async () => {
      await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({
          appName: 'Acme Cloud',
          customCss: ':root { --radius: 0 }',
          errorPages: { supportUrl: 'https://acme.example.com/help' },
        });

      const second = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({
          accentColor: '#0055ff',
          errorPages: { notFoundMessage: 'Nothing here.' },
        });

      expect(second.status).toBe(200);
      expect(second.body).toEqual({
        ...unbranded,
        appName: 'Acme Cloud',
        accentColor: '#0055ff',
        customCss: ':root { --radius: 0 }',
        errorPages: {
          notFoundMessage: 'Nothing here.',
          serverErrorMessage: null,
          supportUrl: 'https://acme.example.com/help',
        },
      });
    });

    it('clears a field written earlier when it is sent as null', async () => {
      await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({ appName: 'Acme Cloud', primaryColor: '#ff6600' });

      const cleared = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({ primaryColor: null });

      expect(cleared.status).toBe(200);
      expect(cleared.body).toEqual({
        ...unbranded,
        appName: 'Acme Cloud',
        primaryColor: null,
      });
    });

    it('refuses an owner on an instance with no enterprise licence', async () => {
      license.hasValidLicense.mockResolvedValue(false);

      const res = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({ appName: 'Acme Cloud' });

      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toBe(
        'Valid enterprise license required',
      );

      const read = await request(httpServer).get('/settings/whitelabeling');
      expect(read.body).toEqual(unbranded);
    });

    it('refuses a plain member even on a licensed instance', async () => {
      const memberCookie = await inviteMember();

      const res = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', memberCookie)
        .send({ appName: 'Acme Cloud' });

      expect(res.status).toBe(403);
      expect(refusal(res)).toBe(INSTANCE_AUTHORITY_REFUSAL);
    });

    it('refuses an unauthenticated write outright', async () => {
      const res = await request(httpServer)
        .patch('/settings/whitelabeling')
        .send({ appName: 'Acme Cloud' });

      expect(res.status).toBe(401);
    });
  });

  /**
   * `whitelabelingConfig` is one `jsonb` column on the
   * `web_server_settings` **singleton** — one row, whole instance — so the
   * caller's role in the Organization they happen to be acting in was never the
   * question. Fourteen tests stood above this block and every one of them acted
   * as the instance organization's own owner or as a plain member of it, which
   * is why an owner of a *second* licensed Organization writing the app name,
   * logo, favicon, colours, CSS and error-page copy that every other
   * Organization's members and every anonymous visitor to the sign-in page
   * render was green for as long as the route existed.
   *
   * Both halves of the gate moved and they are asserted apart, because they are
   * different answers: `SettingsService.requireInstanceAuthority` refuses with
   * `PermissionService.checkInstanceAuthority`'s one sentence, and
   * `SettingsService.requireInstanceLicense` refuses with the licence sentence.
   */
  describe('the instance-wide boundary', () => {
    it("refuses a second Organization's licensed owner the instance branding", async () => {
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        ownerCookie,
      );

      const denied = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', mallory.cookie)
        .send({ appName: 'Mallory Cloud' });

      expect(denied.status).toBe(403);
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);

      // What the rest of the instance renders was never touched.
      const read = await request(httpServer).get('/settings/whitelabeling');
      expect(read.body).toEqual(unbranded);
    });

    /**
     * The licence subject, pinned. The licence half used to be asked of
     * `ctx.session.activeOrganizationId`, so a caller who legitimately holds
     * instance authority could still unlock an instance-wide feature with a
     * licence belonging to some *other* Organization they happen to be acting
     * in — the same defect one level up. The subject is the instance
     * organization, and the caller here is the instance organization's own
     * owner, switched into the second Organization they created: authority
     * passes, and the answer turns entirely on which Organization's licence is
     * read.
     */
    it("asks the licence of the instance organization, not the caller's", async () => {
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        ownerCookie,
      );
      license.hasValidLicense.mockImplementation((organizationId) =>
        Promise.resolve(organizationId === mallory.organizationId),
      );

      const activated = await request(httpServer)
        .post('/api/auth/organization/set-active')
        .set('Cookie', ownerCookie)
        .send({ organizationId: mallory.organizationId });
      expect(activated.status).toBe(200);

      const denied = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({ appName: 'Second Org Cloud' });

      expect(denied.status).toBe(403);
      expect(refusal(denied)).toBe(LICENSE_REFUSAL);
      expect(license.hasValidLicense).toHaveBeenCalledWith(
        mallory.instanceOrganizationId,
      );
      expect(license.hasValidLicense).not.toHaveBeenCalledWith(
        mallory.organizationId,
      );
    });

    it("accepts the instance organization's licence while acting elsewhere", async () => {
      const mallory = await secondOrganizationOwner(
        httpServer,
        ctx.db,
        ownerCookie,
      );
      license.hasValidLicense.mockImplementation((organizationId) =>
        Promise.resolve(organizationId === mallory.instanceOrganizationId),
      );

      await request(httpServer)
        .post('/api/auth/organization/set-active')
        .set('Cookie', ownerCookie)
        .send({ organizationId: mallory.organizationId })
        .expect(200);

      const written = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({ appName: 'Acme Cloud' });

      expect(written.status).toBe(200);
      expect((written.body as { appName: string }).appName).toBe('Acme Cloud');
    });

    /**
     * ADR-0013's no-op claim, on this surface: the install `deploy/install.sh`
     * produces has one Organization, it *is* the instance organization, and its
     * owner and the admin they invite keep the route they held before.
     */
    it("leaves a single-organization install's owner and admin as they were", async () => {
      const admin = await signUpMember(httpServer, ownerCookie, {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        role: 'admin',
      });

      const byAdmin = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', admin.cookie)
        .send({ appName: 'Acme Cloud' });
      expect(byAdmin.status).toBe(200);

      const byOwner = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({ primaryColor: '#ff6600' });
      expect(byOwner.status).toBe(200);
      expect(byOwner.body).toEqual({
        ...unbranded,
        appName: 'Acme Cloud',
        primaryColor: '#ff6600',
      });
    });
  });

  describe('what the public read must not carry', () => {
    it('serves branding set by a licensed owner even after the licence lapses', async () => {
      await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({ appName: 'Acme Cloud' });

      // The licence is the gate on rebranding, not on rendering: an instance
      // whose licence lapsed keeps the logo it already has.
      license.hasValidLicense.mockResolvedValue(false);
      license.hasAnyValidLicense.mockResolvedValue(false);

      const read = await request(httpServer).get('/settings/whitelabeling');
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ ...unbranded, appName: 'Acme Cloud' });
    });

    it('answers with branding only — nothing else off the settings row', async () => {
      const settings = ctx.app.get(SettingsService);
      await settings.updateWebServerSettings({
        // The row's one secret since an earlier change dropped the instance SSH key.
        metricsConfig: {
          ...defaultWebServerMetricsConfig,
          server: {
            ...defaultWebServerMetricsConfig.server,
            token: 'METRICS-TOKEN-MATERIAL',
          },
        },
        serverIp: '203.0.113.7',
        host: 'panel.example.com',
        letsEncryptEmail: 'ops@example.com',
        enforceSSO: true,
      });

      const res = await request(httpServer).get('/settings/whitelabeling');

      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object).sort()).toEqual(
        Object.keys(unbranded).sort(),
      );
      expect(JSON.stringify(res.body)).not.toContain('METRICS-TOKEN-MATERIAL');
      expect(JSON.stringify(res.body)).not.toContain('203.0.113.7');
      expect(JSON.stringify(res.body)).not.toContain('ops@example.com');
    });

    it('does not create the settings row for an anonymous reader', async () => {
      await request(httpServer).get('/settings/whitelabeling').expect(200);

      const rows = await ctx.db.execute<{ count: string }>(
        sql`select count(*)::text as count from web_server_settings`,
      );
      expect(rows.rows[0].count).toBe('0');
    });
  });

  describe('what a branding write will not accept', () => {
    it('rejects a javascript: logo URL', async () => {
      const res = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({ logoUrl: 'javascript:alert(1)' });

      expect(res.status).toBe(400);
    });

    it('rejects custom CSS that could close the style block', async () => {
      const res = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({ customCss: 'body{}</style><script>alert(1)</script>' });

      expect(res.status).toBe(400);
    });

    it('rejects a colour that is not a hex colour', async () => {
      const res = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({ primaryColor: 'rebeccapurple' });

      expect(res.status).toBe(400);
    });

    it('accepts a root-relative asset path', async () => {
      const res = await request(httpServer)
        .patch('/settings/whitelabeling')
        .set('Cookie', ownerCookie)
        .send({ logoUrl: '/branding/logo.svg' });

      expect(res.status).toBe(200);
      expect((res.body as { logoUrl: string }).logoUrl).toBe(
        '/branding/logo.svg',
      );
    });
  });
});
