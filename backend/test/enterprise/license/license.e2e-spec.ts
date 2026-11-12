import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulingService } from '../../../src/scheduling/scheduling.service';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { licenseKey, member, webServerSettings } from '../../../src/db/schema';
import { BUILDS_CONCURRENCY } from '../../../src/deployment-queue/concurrency';
import { LOCAL_PARTITION } from '../../../src/deployment-queue/job-types';
import { CustomRolesService } from '../../../src/enterprise/custom-roles/custom-roles.service';
import {
  LICENSE_LAPSE_JOB_ID,
  LicenseLapseService,
} from '../../../src/enterprise/license/license-lapse.service';
import { LICENSE_API } from '../../../src/enterprise/license/license-api';
import {
  LICENSE_RECHECK_JOB_ID,
  LicenseRecheckService,
} from '../../../src/enterprise/license/license-recheck.service';
import { STOPPED_BY_LAPSE } from '../../../src/enterprise/license/paid-features';
import { CLOUD_RUN_SETTINGS } from '../../../src/deployment-queue/cloud-runs-concurrency.provider';
import type { CloudRunSettings } from '../../../src/deployment-queue/cloud-runs-concurrency.provider';
import type {
  LicenseActivation,
  LicenseApi,
} from '../../../src/enterprise/license/license-api';
import { LicenseService } from '../../../src/enterprise/license/license.service';
import { FETCH_CLIENT } from '../../../src/git-providers/fetch.provider';
import { MailService } from '../../../src/mail/mail.service';
import type { RenderedEmail } from '../../../src/mail/templates';
import { NotificationsService } from '../../../src/notifications/notifications.service';
import { PermissionService } from '../../../src/rbac/permission.service';
import type { PermissionCtx } from '../../../src/rbac/permission.service';
import { createTestApp, TestAppContext } from '../../utils/test-app';
import { createOrganization as postOrganization } from '../../utils/test-auth';

jest.setTimeout(120_000);

// The remote license server, mocked at its port for every test in this file.
// Each call is a standalone const so assertions never reference an unbound
// method.
const activateRemote = jest.fn<Promise<LicenseActivation>, [string]>();
const validateRemote = jest.fn<Promise<boolean>, [string]>();
const deactivateRemote = jest.fn<Promise<void>, [string]>();

// Instance mail, mocked so the owner email of the license-expiring warnings
// is observable; whether it is sent at all follows MAIL_PROVIDER.
const mailSend = jest.fn<Promise<void>, [string, RenderedEmail]>();

const api: LicenseApi = {
  activate: activateRemote,
  validate: validateRemote,
  deactivate: deactivateRemote,
};

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

const ctxFor = (userId: string, organizationId: string): PermissionCtx => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

describe('License keys (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let license: LicenseService;
  let lapses: LicenseLapseService;

  // Every notification channel's HTTP delivery goes through the shared fetch
  // client (the lapse fan-out included).
  const fetchMock = jest.fn();

  /** An organization with its owner signed up, and that owner's ctx. */
  async function setUpOwner() {
    const session = await signUp(server, owner);
    const organizationId = await activeOrganizationId(server, session.cookie);
    return {
      organizationId,
      session,
      ctx: ctxFor(session.id, organizationId),
    };
  }

  /** An owner whose organization has already opted into enterprise features. */
  async function setUpOptedInOwner() {
    const owned = await setUpOwner();
    await license.updateEnterpriseSettings(owned.ctx, {
      enableEnterpriseFeatures: true,
    });
    return owned;
  }

  /**
   * The same, plus one other user who actually accepted an invitation —
   * signing up with a token alone creates no member row.
   */
  async function setUpOrgWithMember() {
    const owned = await setUpOptedInOwner();

    const invite = await request(server)
      .post('/organizations/invitations')
      .set('Cookie', owned.session.cookie)
      .send({ email: 'invitee@example.com', role: 'member' });
    const inviteId = (invite.body as { id: string }).id;

    const su = await request(server)
      .post('/api/auth/sign-up/email')
      .set('x-cloudgate-token', inviteId)
      .send({
        name: 'Ida Rhodes',
        email: 'invitee@example.com',
        password: 'super-secret-password',
      });
    const inviteeCookie = su.headers['set-cookie'];
    const inviteeId = (su.body as { user: { id: string } }).user.id;

    const accept = await request(server)
      .post(`/organizations/invitations/${inviteId}/accept`)
      .set('Cookie', inviteeCookie);
    expect(accept.status).toBe(201);

    return { ...owned, invitee: { cookie: inviteeCookie, id: inviteeId } };
  }

  /** Arrangement only — role assignment itself is the organizations surface. */
  const assignRole = (userId: string, role: string) =>
    ctx.db.update(member).set({ role }).where(eq(member.userId, userId));

  /**
   * What the row itself says, read off the column rather than through
   * `isEnterpriseEnabled`.
   *
   * The derived answer folds four conditions together, so it cannot tell "the
   * status was rewritten" from "the status was left alone and something else
   * changed". The two cases below are about the write specifically.
   */
  const storedStatus = async (
    organizationId: string,
  ): Promise<string | undefined> => {
    const [row] = await ctx.db
      .select({ status: licenseKey.status })
      .from(licenseKey)
      .where(eq(licenseKey.organizationId, organizationId));
    return row?.status;
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: LICENSE_API, useValue: api },
        // Notification delivery is a system boundary: the lapse warning fans
        // out to the organization's channels, and a webhook on this mock is the
        // only proof an operator was actually told.
        { provide: FETCH_CLIENT, useValue: fetchMock },
        { provide: MailService, useValue: { send: mailSend } },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    license = ctx.app.get(LicenseService);
    lapses = ctx.app.get(LicenseLapseService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.resetAllMocks();
    // resetAllMocks strips the implementation too, so the shared fetch client
    // has to be handed back its ok response every test.
    fetchMock.mockResolvedValue({ ok: true, statusText: 'OK' });
  });

  describe('enterprise features opt-in', () => {
    it('is off until the owner turns it on, and reports no stored key', async () => {
      const { ctx: ownerCtx } = await setUpOwner();

      await expect(license.getEnterpriseSettings(ownerCtx)).resolves.toEqual({
        enableEnterpriseFeatures: false,
        licenseKey: '',
      });

      await expect(
        license.updateEnterpriseSettings(ownerCtx, {
          enableEnterpriseFeatures: true,
        }),
      ).resolves.toBe(true);

      await expect(license.getEnterpriseSettings(ownerCtx)).resolves.toEqual({
        enableEnterpriseFeatures: true,
        licenseKey: '',
      });
    });
  });

  describe('activate', () => {
    it('enables enterprise features for a key the license server accepts', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({
        validUntil: '2030-06-01T00:00:00.000Z',
        features: ['sso', 'audit-logs'],
      });

      await expect(license.activate(ownerCtx, 'CG-TEST-KEY')).resolves.toEqual({
        success: true,
      });

      expect(activateRemote).toHaveBeenCalledWith('CG-TEST-KEY');
      await expect(license.isEnterpriseEnabled(organizationId)).resolves.toBe(
        true,
      );
      await expect(license.getEnterpriseSettings(ownerCtx)).resolves.toEqual({
        enableEnterpriseFeatures: true,
        licenseKey: 'CG-TEST-KEY',
      });
    });

    it('refuses to activate before enterprise features are opted into', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpOwner();

      await expect(license.activate(ownerCtx, 'CG-TEST-KEY')).rejects.toThrow(
        'Please activate enterprise features to activate license key',
      );

      expect(activateRemote).not.toHaveBeenCalled();
      await expect(license.isEnterpriseEnabled(organizationId)).resolves.toBe(
        false,
      );
    });

    it('leaves the license disabled when the license server refuses the key', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
      activateRemote.mockRejectedValue(new Error('License key not found'));

      await expect(license.activate(ownerCtx, 'CG-BOGUS-KEY')).rejects.toThrow(
        'License key not found',
      );

      await expect(license.isEnterpriseEnabled(organizationId)).resolves.toBe(
        false,
      );
      await expect(license.getEnterpriseSettings(ownerCtx)).resolves.toEqual({
        enableEnterpriseFeatures: true,
        licenseKey: '',
      });
    });
  });

  describe('validate', () => {
    it('re-checks the stored key and keeps a license the server still accepts', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({});
      await license.activate(ownerCtx, 'CG-TEST-KEY');
      validateRemote.mockResolvedValue(true);

      await expect(license.validate(ownerCtx)).resolves.toBe(true);

      expect(validateRemote).toHaveBeenCalledWith('CG-TEST-KEY');
      await expect(license.isEnterpriseEnabled(organizationId)).resolves.toBe(
        true,
      );
    });

    /**
     * The license server has two ways to say no, and Cloudgate honours exactly
     * one of them. Both are here side by side because the asymmetry is the
     * finding, and neither case states it on its own.
     *
     * `validate` runs its `update` **after** `callRemote` returns, so a
     * resolved `false` is recorded and a rejection is not — whatever the
     * rejection was. That ordering is the fail-safe behind
     * an activation failure seen on one build: the license
     * server's paths answer **404** with an HTML body on that build, which
     * `LicenseApiClient` surfaces as a rejection, and if a rejection reached the
     * `update` then a *correct* key would lose custom roles, single sign-on,
     * SCIM and forward auth because nginx was misconfigured.
     *
     * It is an ordering accident between two statements, invisible as a
     * decision, and nothing else asserts it. Moving the `update` above the
     * `await`, or wrapping `callRemote` in a try/catch that swallows, breaks it
     * with every other test in this file green.
     */
    describe('the two shapes of a "no"', () => {
      it('disables a license the server no longer accepts', async () => {
        const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
        activateRemote.mockResolvedValue({});
        await license.activate(ownerCtx, 'CG-TEST-KEY');
        validateRemote.mockResolvedValue(false);

        await expect(license.validate(ownerCtx)).resolves.toBe(false);

        // The answer was recorded: this is the half that revokes.
        await expect(storedStatus(organizationId)).resolves.toBe('invalid');
        await expect(license.isEnterpriseEnabled(organizationId)).resolves.toBe(
          false,
        );
      });

      it('leaves the stored status untouched when the check is rejected instead', async () => {
        const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
        activateRemote.mockResolvedValue({});
        await license.activate(ownerCtx, 'CG-TEST-KEY');
        await expect(storedStatus(organizationId)).resolves.toBe('active');

        // The refusal class `LicenseApiClient` builds for a non-ok body
        // carrying the server's own message. It is the most adversarial of the
        // three — the server really did say no — and it still must not be
        // recorded, because the call did not complete. The other two classes
        // take the identical path: `callRemote` wraps all of them.
        validateRemote.mockRejectedValue(
          new Error(
            'The license server refused this license key: Invalid license key',
          ),
        );

        await expect(license.validate(ownerCtx)).rejects.toThrow(
          'The license server refused this license key',
        );

        // Nothing was written. The row reads exactly what it did before.
        await expect(storedStatus(organizationId)).resolves.toBe('active');
        await expect(license.isEnterpriseEnabled(organizationId)).resolves.toBe(
          true,
        );
      });
    });

    it('refuses to validate when no key is stored', async () => {
      const { ctx: ownerCtx } = await setUpOptedInOwner();

      await expect(license.validate(ownerCtx)).rejects.toThrow(
        'No license key found',
      );

      expect(validateRemote).not.toHaveBeenCalled();
    });

    it('refuses to validate before enterprise features are opted into', async () => {
      const { ctx: ownerCtx } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({});
      await license.activate(ownerCtx, 'CG-TEST-KEY');
      await license.updateEnterpriseSettings(ownerCtx, {
        enableEnterpriseFeatures: false,
      });

      await expect(license.validate(ownerCtx)).rejects.toThrow(
        'Please activate enterprise features to validate license key',
      );

      expect(validateRemote).not.toHaveBeenCalled();
    });
  });

  describe('deactivate', () => {
    it('releases the key remotely and disables the license, keeping the opt-in', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({ features: ['sso'] });
      await license.activate(ownerCtx, 'CG-TEST-KEY');
      deactivateRemote.mockResolvedValue(undefined);

      await expect(license.deactivate(ownerCtx)).resolves.toEqual({
        success: true,
      });

      expect(deactivateRemote).toHaveBeenCalledWith('CG-TEST-KEY');
      await expect(license.isEnterpriseEnabled(organizationId)).resolves.toBe(
        false,
      );
      await expect(license.hasFeature(organizationId, 'sso')).resolves.toBe(
        false,
      );
      // Deactivate clears the key but leaves the opt-in alone, so the
      // owner can activate a replacement without turning it back on.
      await expect(license.getEnterpriseSettings(ownerCtx)).resolves.toEqual({
        enableEnterpriseFeatures: true,
        licenseKey: '',
      });
    });

    it('still deactivates locally when the license server cannot be reached', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({});
      await license.activate(ownerCtx, 'CG-TEST-KEY');
      deactivateRemote.mockRejectedValue(
        new Error(
          'Could not reach the license server. Check your connection or try again later.',
        ),
      );

      await expect(license.deactivate(ownerCtx)).resolves.toEqual({
        success: true,
      });

      await expect(license.isEnterpriseEnabled(organizationId)).resolves.toBe(
        false,
      );
    });

    it('refuses to deactivate when no key is stored', async () => {
      const { ctx: ownerCtx } = await setUpOptedInOwner();

      await expect(license.deactivate(ownerCtx)).rejects.toThrow(
        'No license key found',
      );

      expect(deactivateRemote).not.toHaveBeenCalled();
    });

    it('lets the owner activate a replacement key afterwards', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({});
      await license.activate(ownerCtx, 'CG-FIRST-KEY');
      deactivateRemote.mockResolvedValue(undefined);
      await license.deactivate(ownerCtx);

      await license.activate(ownerCtx, 'CG-SECOND-KEY');

      await expect(license.isEnterpriseEnabled(organizationId)).resolves.toBe(
        true,
      );
      await expect(license.getEnterpriseSettings(ownerCtx)).resolves.toEqual({
        enableEnterpriseFeatures: true,
        licenseKey: 'CG-SECOND-KEY',
      });
    });
  });

  describe('feature checks', () => {
    it('grants exactly the features the key enumerates', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({ features: ['sso', 'scim'] });
      await license.activate(ownerCtx, 'CG-TEST-KEY');

      await expect(license.hasFeature(organizationId, 'sso')).resolves.toBe(
        true,
      );
      await expect(license.hasFeature(organizationId, 'scim')).resolves.toBe(
        true,
      );
      await expect(
        license.hasFeature(organizationId, 'whitelabeling'),
      ).resolves.toBe(false);
    });

    it('grants no named feature once the license stops being valid', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({ features: ['sso'] });
      await license.activate(ownerCtx, 'CG-TEST-KEY');
      validateRemote.mockResolvedValue(false);
      await license.validate(ownerCtx);

      await expect(license.hasFeature(organizationId, 'sso')).resolves.toBe(
        false,
      );
    });
  });

  describe('expiry', () => {
    it('is disabled once validUntil has passed', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({
        validUntil: '2020-01-01T00:00:00.000Z',
        features: ['sso'],
      });

      await license.activate(ownerCtx, 'CG-EXPIRED-KEY');

      await expect(license.isEnterpriseEnabled(organizationId)).resolves.toBe(
        false,
      );
      await expect(license.hasFeature(organizationId, 'sso')).resolves.toBe(
        false,
      );
    });

    it('is enabled indefinitely when the server names no expiry', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({ validUntil: null });

      await license.activate(ownerCtx, 'CG-PERPETUAL-KEY');

      await expect(license.isEnterpriseEnabled(organizationId)).resolves.toBe(
        true,
      );
    });
  });

  describe('authorization', () => {
    // Every license operation is gated on the owner role, so an
    // organization admin is refused just like a plain member.
    for (const role of ['admin', 'member'] as const) {
      it(`refuses every license operation to an organization ${role}`, async () => {
        const { ctx: ownerCtx, session, invitee } = await setUpOrgWithMember();
        activateRemote.mockResolvedValue({});
        await license.activate(ownerCtx, 'CG-TEST-KEY');
        await assignRole(invitee.id, role);
        const theirCtx = ctxFor(
          invitee.id,
          ownerCtx.session.activeOrganizationId,
        );

        await expect(
          license.activate(theirCtx, 'CG-OTHER-KEY'),
        ).rejects.toThrow('You are not authorized to activate a license key');
        await expect(license.validate(theirCtx)).rejects.toThrow(
          'You are not authorized to validate a license key',
        );
        await expect(license.deactivate(theirCtx)).rejects.toThrow(
          'You are not authorized to deactivate a license key',
        );
        await expect(license.checkNow(theirCtx)).rejects.toThrow(
          'You are not authorized to check a license key',
        );
        await expect(license.getEnterpriseSettings(theirCtx)).rejects.toThrow(
          'You are not authorized to get enterprise settings',
        );
        await expect(
          license.updateEnterpriseSettings(theirCtx, {
            enableEnterpriseFeatures: false,
          }),
        ).rejects.toThrow(
          'You are not authorized to update enterprise settings',
        );

        // Nothing they attempted touched the license.
        await expect(
          license.isEnterpriseEnabled(ownerCtx.session.activeOrganizationId),
        ).resolves.toBe(true);
        await expect(license.getEnterpriseSettings(ownerCtx)).resolves.toEqual({
          enableEnterpriseFeatures: true,
          licenseKey: 'CG-TEST-KEY',
        });
        expect(session.cookie).toBeDefined();
      });
    }

    it('stores the key encrypted at rest', async () => {
      const { ctx: ownerCtx } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({});
      await license.activate(ownerCtx, 'CG-SECRET-KEY');

      const raw = await ctx.db.execute<{ key: string }>(
        sql`select key from license_key`,
      );
      expect(raw.rows).toHaveLength(1);
      expect(raw.rows[0].key).not.toContain('CG-SECRET-KEY');
      // ...and still reads back as itself through the service.
      await expect(license.getEnterpriseSettings(ownerCtx)).resolves.toEqual({
        enableEnterpriseFeatures: true,
        licenseKey: 'CG-SECRET-KEY',
      });
    });
  });

  // The stubs phases 06/22/48 injected until this phase landed. These prove the
  // real service is what they now consult — nothing here mocks LicenseService.
  describe('gates that were stubbed out until now', () => {
    it('opens custom roles for an organization once its license is activated', async () => {
      const {
        ctx: ownerCtx,
        invitee,
        organizationId,
      } = await setUpOrgWithMember();
      const customRoles = ctx.app.get(CustomRolesService);
      const permissions = ctx.app.get(PermissionService);

      await expect(
        customRoles.create(ownerCtx, {
          roleName: 'deployer',
          permissions: { project: ['create'] },
        }),
      ).rejects.toThrow('Valid enterprise license required');

      activateRemote.mockResolvedValue({});
      await license.activate(ownerCtx, 'CG-TEST-KEY');

      await customRoles.create(ownerCtx, {
        roleName: 'deployer',
        permissions: { project: ['create'] },
      });
      await assignRole(invitee.id, 'deployer');
      const theirCtx = ctxFor(invitee.id, organizationId);

      await expect(
        permissions.checkPermission(theirCtx, { project: ['create'] }),
      ).resolves.toBeUndefined();

      // ...and the role stops resolving the moment the license lapses, saying
      // that the license is what went rather than the role.
      deactivateRemote.mockResolvedValue(undefined);
      await license.deactivate(ownerCtx);
      await expect(
        permissions.checkPermission(theirCtx, { project: ['create'] }),
      ).rejects.toThrow(/"deployer".*valid enterprise license/);
    });

    it('unlocks the deployment queue’s parallel builds once licensed', async () => {
      const { ctx: ownerCtx } = await setUpOptedInOwner();
      const resolveConcurrency =
        ctx.app.get<(partition: string) => Promise<number>>(BUILDS_CONCURRENCY);
      await ctx.db
        .insert(webServerSettings)
        .values({ buildsConcurrency: 4, serverIp: '203.0.113.7' });

      await expect(resolveConcurrency(LOCAL_PARTITION)).resolves.toBe(1);

      activateRemote.mockResolvedValue({});
      await license.activate(ownerCtx, 'CG-TEST-KEY');

      await expect(resolveConcurrency(LOCAL_PARTITION)).resolves.toBe(4);
    });
  });

  describe('status report', () => {
    it('reports what the license grants, not just that there is one', async () => {
      const { session } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({
        validUntil: '2030-06-01T00:00:00.000Z',
        features: ['sso', 'audit-logs'],
      });
      const activated = await request(server)
        .post('/license/activate')
        .set('Cookie', session.cookie)
        .send({ licenseKey: 'CG-HTTP-KEY' });
      expect(activated.status).toBe(200);

      const res = await request(server)
        .get('/license/status')
        .set('Cookie', session.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        licensed: true,
        status: 'active',
        validUntil: '2030-06-01T00:00:00.000Z',
        features: ['sso', 'audit-logs'],
        enableEnterpriseFeatures: true,
      });
    });

    // Expiry is derived, so nothing rewrites the row when a license lapses:
    // the column still says 'active' while the license no longer licenses
    // anything. Both halves are reported honestly.
    it('reports a lapsed license as unlicensed while its stored status still reads active', async () => {
      const { session } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({
        validUntil: '2020-01-01T00:00:00.000Z',
        features: ['sso'],
      });
      await request(server)
        .post('/license/activate')
        .set('Cookie', session.cookie)
        .send({ licenseKey: 'CG-EXPIRED-KEY' });
      // Nothing writes to the row when a license lapses, so the column is
      // still what activate left there.
      const stored = await ctx.db.execute<{ status: string }>(
        sql`select status from license_key`,
      );
      expect(stored.rows[0].status).toBe('active');

      const res = await request(server)
        .get('/license/status')
        .set('Cookie', session.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        licensed: false,
        status: 'active',
        validUntil: '2020-01-01T00:00:00.000Z',
        features: ['sso'],
        enableEnterpriseFeatures: true,
      });
    });

    it('tells a license the server refused apart from having none at all', async () => {
      const { session } = await setUpOptedInOwner();

      const none = await request(server)
        .get('/license/status')
        .set('Cookie', session.cookie);
      expect(none.body).toEqual({
        licensed: false,
        status: 'inactive',
        validUntil: null,
        features: [],
        enableEnterpriseFeatures: true,
      });

      activateRemote.mockResolvedValue({ features: ['sso'] });
      await request(server)
        .post('/license/activate')
        .set('Cookie', session.cookie)
        .send({ licenseKey: 'CG-REVOKED-KEY' });
      validateRemote.mockResolvedValue(false);
      await request(server)
        .post('/license/validate')
        .set('Cookie', session.cookie);

      const refused = await request(server)
        .get('/license/status')
        .set('Cookie', session.cookie);
      expect(refused.body).toEqual({
        licensed: false,
        status: 'invalid',
        validUntil: null,
        features: ['sso'],
        enableEnterpriseFeatures: true,
      });
    });

    // The opt-in leaves the row alone, so `status` and `validUntil` still read
    // as an active license: only this field tells the console's renewal bar
    // that Enterprise features are off and there is nothing to renew.
    it('reports Enterprise features turned off while the stored license still reads active', async () => {
      const { session, ctx: ownerCtx } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({
        validUntil: '2030-06-01T00:00:00.000Z',
        features: ['sso'],
      });
      await license.activate(ownerCtx, 'CG-HTTP-KEY');
      await license.updateEnterpriseSettings(ownerCtx, {
        enableEnterpriseFeatures: false,
      });

      const res = await request(server)
        .get('/license/status')
        .set('Cookie', session.cookie);

      expect(res.body).toEqual({
        licensed: false,
        status: 'active',
        validUntil: '2030-06-01T00:00:00.000Z',
        features: ['sso'],
        enableEnterpriseFeatures: false,
      });
    });
  });

  /**
   * A lapse has no event of its own — `isValid` derives expiry at read
   * time — so the transition is noticed by a periodic check rather than
   * announced. What the check has to get right is *once per lapse*: a warning
   * that repeats every tick for a license that went last month is noise
   * operators learn to ignore.
   */
  describe('reporting a lapse', () => {
    /** A licensed organization with its one non-owner member on a custom role. */
    async function setUpCustomRoleHolder() {
      const owned = await setUpOrgWithMember();
      activateRemote.mockResolvedValue({
        validUntil: '2030-06-01T00:00:00.000Z',
      });
      await license.activate(owned.ctx, 'CG-TEST-KEY');
      await ctx.app.get(CustomRolesService).create(owned.ctx, {
        roleName: 'read-only',
        permissions: { certificate: ['read'] },
      });
      await assignRole(owned.invitee.id, 'read-only');
      return owned;
    }

    /**
     * Move the stored expiry into the past. Nothing else changes — which is
     * exactly how a license lapses in production: the row is untouched and
     * `status` still reads 'active'.
     */
    const expireLicense = (
      organizationId: string,
      validUntil = new Date('2026-08-01T00:00:00.000Z'),
    ) =>
      ctx.db
        .update(licenseKey)
        .set({ validUntil })
        .where(eq(licenseKey.organizationId, organizationId));

    it('reports a lapse once, naming exactly the members it locks out', async () => {
      const { organizationId, invitee } = await setUpCustomRoleHolder();
      await expireLicense(organizationId);
      const warn = jest.spyOn(Logger.prototype, 'warn');

      const reported = await lapses.reportNewLapses();

      expect(reported).toHaveLength(1);
      expect(reported[0].organizationId).toBe(organizationId);
      expect(reported[0].validUntil.toISOString()).toBe(
        '2026-08-01T00:00:00.000Z',
      );
      // The owner holds a static role and is fine, so naming them would send an
      // operator after the wrong person.
      const [theirMembership] = await ctx.db
        .select({ id: member.id })
        .from(member)
        .where(eq(member.userId, invitee.id));
      expect(reported[0].strandedMembers).toEqual([
        {
          id: theirMembership.id,
          userId: invitee.id,
          email: 'invitee@example.com',
          // better-auth maps its single `name` field onto firstName.
          firstName: 'Ida Rhodes',
          lastName: '',
          role: 'read-only',
        },
      ]);

      // The report is not just a return value — it is said out loud, once.
      const warnings = warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('lapsed on'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('invitee@example.com');
      expect(warnings[0]).not.toContain(owner.email);
      for (const line of STOPPED_BY_LAPSE) {
        expect(warnings[0]).toContain(line);
      }

      // Once per lapse, not once per check.
      await expect(lapses.reportNewLapses()).resolves.toEqual([]);
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes('lapsed on'),
        ),
      ).toHaveLength(1);
      warn.mockRestore();
    });

    // The mark is the expiry, not a flag, so renewing re-arms the check by
    // itself. A boolean "already warned" column would go quiet forever after
    // the first lapse — which is the failure mode that matters, because a
    // renewed license lapsing again strands the same people again.
    it('reports the next lapse after the license is renewed', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpCustomRoleHolder();
      await expireLicense(organizationId);
      expect(await lapses.reportNewLapses()).toHaveLength(1);

      activateRemote.mockResolvedValue({
        validUntil: '2030-06-01T00:00:00.000Z',
      });
      await license.activate(ownerCtx, 'CG-RENEWED-KEY');
      await expect(lapses.reportNewLapses()).resolves.toEqual([]);

      await expireLicense(organizationId, new Date('2026-08-09T00:00:00.000Z'));

      const second = await lapses.reportNewLapses();
      expect(second).toHaveLength(1);
      expect(second[0].validUntil.toISOString()).toBe(
        '2026-08-09T00:00:00.000Z',
      );
    });

    /**
     * A slack channel in the organization, opted into the lapse event and
     * nothing else. The webhook is the seam: an unformatted event is silently
     * skipped, so "the dispatcher was called" is not evidence anybody was told
     * — only a payload on the wire is.
     */
    async function optInToLapseNotifications(ownerCtx: PermissionCtx) {
      await ctx.app.get(NotificationsService).createSlack(ownerCtx, {
        name: 'ops-slack',
        webhookUrl: 'https://hooks.slack.com/services/T/B/LAPSE',
        channel: '#ops',
        appDeploy: false,
        appBuildError: false,
        databaseBackup: false,
        volumeBackup: false,
        instanceBackup: false,
        instanceRestart: false,
        dockerCleanup: false,
        serverThreshold: false,
        licenseLapse: true,
        licenseExpiring: false,
        agentRateLimited: false,
        previewTeardownStuck: false,
        serviceIncident: false,
        aiModelNotAnswering: false,
      });
    }

    /** The slack attachment fields posted by the given fetch call. */
    const postedFields = (call = 0) => {
      const [, init] = fetchMock.mock.calls[call] as [string, { body: string }];
      const body = JSON.parse(init.body) as {
        attachments: {
          pretext: string;
          fields: { title: string; value: string }[];
        }[];
      };
      return body.attachments[0];
    };

    it('notifies the organization channels once, naming exactly the stranded members', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpCustomRoleHolder();
      await optInToLapseNotifications(ownerCtx);
      await expireLicense(organizationId);

      const reported = await lapses.reportNewLapses();

      expect(reported).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string, unknown];
      expect(url).toBe('https://hooks.slack.com/services/T/B/LAPSE');

      const attachment = postedFields();
      expect(attachment.pretext).toBe(':warning: *Enterprise License Lapsed*');
      const values = attachment.fields.map((field) => field.value).join('\n');
      // The one custom-role holder, and not the owner, who is on a static role
      // and is fine — naming them would send an operator after the wrong person.
      expect(values).toContain('Ida Rhodes (invitee@example.com) — read-only');
      expect(values).not.toContain(owner.email);
      // The decision travels with the alarm, not just to the log: the design rejected
      // the `member` fallback because it *widens* a narrow custom role.
      expect(values).toContain('widen their access');
      expect(
        attachment.fields.some((field) => field.title === 'Locked Out (1)'),
      ).toBe(true);
      // What stopped, all of it, not only the custom roles.
      expect(
        attachment.fields.find((field) => field.title === 'Stopped')?.value,
      ).toBe(STOPPED_BY_LAPSE.join('\n'));

      // Once per lapse, not once per check — the same guarantee the log line
      // has, and it has to hold for the delivery too or the channel becomes
      // hourly noise until somebody mutes it.
      await expect(lapses.reportNewLapses()).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still warns in the log when no channel has opted in', async () => {
      const { organizationId } = await setUpCustomRoleHolder();
      await expireLicense(organizationId);
      const warn = jest.spyOn(Logger.prototype, 'warn');

      await expect(lapses.reportNewLapses()).resolves.toHaveLength(1);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes('lapsed on'),
        ),
      ).toHaveLength(1);
      warn.mockRestore();
    });

    it('says nothing while the license is still valid', async () => {
      await setUpCustomRoleHolder();

      await expect(lapses.reportNewLapses()).resolves.toEqual([]);
    });

    // Only custom-role holders are stranded, but an organization on the
    // static roles still loses SSO sign-in, SCIM adds and the rest, and that is
    // worth saying once. It says so without a "Locked Out" part.
    it('reports a lapse that strands nobody, once, listing what stopped', async () => {
      const owned = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({
        validUntil: '2030-06-01T00:00:00.000Z',
      });
      await license.activate(owned.ctx, 'CG-TEST-KEY');
      await optInToLapseNotifications(owned.ctx);
      await expireLicense(owned.organizationId);
      const warn = jest.spyOn(Logger.prototype, 'warn');

      const reported = await lapses.reportNewLapses();

      expect(reported).toHaveLength(1);
      expect(reported[0].strandedMembers).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const attachment = postedFields();
      expect(
        attachment.fields.find((field) => field.title === 'Stopped')?.value,
      ).toBe(STOPPED_BY_LAPSE.join('\n'));
      expect(
        attachment.fields.some((field) => field.title.startsWith('Locked Out')),
      ).toBe(false);
      const warnings = warn.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('lapsed on'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('nobody is locked out');

      // Marked like any other lapse: once, not once per check.
      await expect(lapses.reportNewLapses()).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    // The instance-wide features a lapse stops keep what they had: the
    // saved branding is still what every page is served, it just cannot be
    // edited, and both pools drop back to one at a time.
    it('keeps the saved white-labelling read-only and runs one build and one Cloud run at a time', async () => {
      const owned = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({
        validUntil: '2030-06-01T00:00:00.000Z',
      });
      await license.activate(owned.ctx, 'CG-TEST-KEY');
      await ctx.db.insert(webServerSettings).values({
        buildsConcurrency: 4,
        cloudRunsConcurrency: 3,
        serverIp: '203.0.113.7',
      });
      await request(server)
        .patch('/settings/whitelabeling')
        .set('Cookie', owned.session.cookie)
        .send({ appName: 'Acme Cloud' })
        .expect(200);
      const builds =
        ctx.app.get<(partition: string) => Promise<number>>(BUILDS_CONCURRENCY);
      const cloudRuns = ctx.app.get<CloudRunSettings>(CLOUD_RUN_SETTINGS);
      await expect(builds(LOCAL_PARTITION)).resolves.toBe(4);
      await expect(cloudRuns.resolveLimit()).resolves.toBe(3);

      await expireLicense(owned.organizationId);

      const served = await request(server)
        .get('/settings/whitelabeling')
        .expect(200);
      expect(served.body).toMatchObject({ appName: 'Acme Cloud' });
      const edit = await request(server)
        .patch('/settings/whitelabeling')
        .set('Cookie', owned.session.cookie)
        .send({ appName: 'Someone Else' });
      expect(edit.status).toBe(403);
      await expect(builds(LOCAL_PARTITION)).resolves.toBe(1);
      await expect(cloudRuns.resolveLimit()).resolves.toBe(1);
    });

    // A key the license server refused (`status: 'invalid'`) and a key that
    // expired are different states wanting different words, and only the second
    // one happens with nobody doing anything. This check owns the second.
    it('does not treat a refused key as a lapse', async () => {
      const { ctx: ownerCtx } = await setUpCustomRoleHolder();
      validateRemote.mockResolvedValue(false);
      await license.validate(ownerCtx);

      await expect(lapses.reportNewLapses()).resolves.toEqual([]);
    });

    // Nothing calls `reportNewLapses` on a request path, so if this job is not
    // registered the whole feature is dead code.
    it('is what the boot hook schedules, so something actually runs it', () => {
      const scheduling = ctx.app.get(SchedulingService);

      expect(scheduling.has(LICENSE_LAPSE_JOB_ID)).toBe(true);
    });
  });

  describe('HTTP surface', () => {
    it('walks the whole lifecycle over HTTP', async () => {
      const { session } = await setUpOwner();
      const cookie = session.cookie;
      activateRemote.mockResolvedValue({ features: ['sso'] });
      validateRemote.mockResolvedValue(true);
      deactivateRemote.mockResolvedValue(undefined);

      const before = await request(server)
        .get('/license/settings')
        .set('Cookie', cookie);
      expect(before.status).toBe(200);
      expect(before.body).toEqual({
        enableEnterpriseFeatures: false,
        licenseKey: '',
      });

      const optIn = await request(server)
        .patch('/license/settings')
        .set('Cookie', cookie)
        .send({ enableEnterpriseFeatures: true });
      expect(optIn.status).toBe(200);
      expect(optIn.text).toBe('true');

      const activated = await request(server)
        .post('/license/activate')
        .set('Cookie', cookie)
        .send({ licenseKey: 'CG-HTTP-KEY' });
      expect(activated.status).toBe(200);
      expect(activated.body).toEqual({ success: true });

      const status = await request(server)
        .get('/license/status')
        .set('Cookie', cookie);
      expect(status.status).toBe(200);
      expect(status.body).toEqual({
        licensed: true,
        status: 'active',
        validUntil: null,
        features: ['sso'],
        enableEnterpriseFeatures: true,
      });

      const validated = await request(server)
        .post('/license/validate')
        .set('Cookie', cookie);
      expect(validated.status).toBe(200);
      expect(validated.text).toBe('true');

      const deactivated = await request(server)
        .post('/license/deactivate')
        .set('Cookie', cookie);
      expect(deactivated.status).toBe(200);
      expect(deactivated.body).toEqual({ success: true });

      const after = await request(server)
        .get('/license/status')
        .set('Cookie', cookie);
      expect(after.body).toEqual({
        licensed: false,
        status: 'inactive',
        validUntil: null,
        features: [],
        enableEnterpriseFeatures: true,
      });
    });

    it('reports an activation the license server refused as a bad request', async () => {
      const { session } = await setUpOptedInOwner();
      activateRemote.mockRejectedValue(new Error('License key not found'));

      const res = await request(server)
        .post('/license/activate')
        .set('Cookie', session.cookie)
        .send({ licenseKey: 'CG-BOGUS-KEY' });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'License key not found',
      );
    });

    it('reports the enterprise-features precondition as a bad request', async () => {
      const { session } = await setUpOwner();

      const res = await request(server)
        .post('/license/activate')
        .set('Cookie', session.cookie)
        .send({ licenseKey: 'CG-HTTP-KEY' });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'Please activate enterprise features to activate license key',
      );
    });

    it('rejects malformed payloads', async () => {
      const { session } = await setUpOptedInOwner();

      const emptyKey = await request(server)
        .post('/license/activate')
        .set('Cookie', session.cookie)
        .send({ licenseKey: '' });
      expect(emptyKey.status).toBe(400);

      const noToggle = await request(server)
        .patch('/license/settings')
        .set('Cookie', session.cookie)
        .send({});
      expect(noToggle.status).toBe(400);

      const notABoolean = await request(server)
        .patch('/license/settings')
        .set('Cookie', session.cookie)
        .send({ enableEnterpriseFeatures: 'yes' });
      expect(notABoolean.status).toBe(400);

      expect(activateRemote).not.toHaveBeenCalled();
    });

    it('lets any member read the license status but only the owner manage it', async () => {
      const { invitee, ctx: ownerCtx } = await setUpOrgWithMember();
      activateRemote.mockResolvedValue({});
      await license.activate(ownerCtx, 'CG-HTTP-KEY');

      // The whole report, not just the boolean: every member of the
      // organization is affected when the license lapses, and none of these
      // four fields is a secret. The key itself stays owner-only, below.
      const status = await request(server)
        .get('/license/status')
        .set('Cookie', invitee.cookie);
      expect(status.status).toBe(200);
      expect(status.body).toEqual({
        licensed: true,
        status: 'active',
        validUntil: null,
        features: [],
        enableEnterpriseFeatures: true,
      });

      const asMember = [
        () =>
          request(server)
            .post('/license/activate')
            .set('Cookie', invitee.cookie)
            .send({ licenseKey: 'CG-OTHER-KEY' }),
        () =>
          request(server)
            .post('/license/validate')
            .set('Cookie', invitee.cookie),
        () =>
          request(server)
            .post('/license/deactivate')
            .set('Cookie', invitee.cookie),
        () =>
          request(server)
            .post('/license/check-now')
            .set('Cookie', invitee.cookie),
        () =>
          request(server)
            .patch('/license/settings')
            .set('Cookie', invitee.cookie)
            .send({ enableEnterpriseFeatures: false }),
      ];
      for (const call of asMember) {
        const res = await call();
        expect(res.status).toBe(403);
      }

      const settings = await request(server)
        .get('/license/settings')
        .set('Cookie', invitee.cookie);
      expect(settings.status).toBe(403);
    });

    it('requires authentication', async () => {
      const anonymous = [
        () => request(server).get('/license/settings'),
        () => request(server).get('/license/status'),
        () =>
          request(server)
            .post('/license/activate')
            .send({ licenseKey: 'CG-HTTP-KEY' }),
        () => request(server).post('/license/validate'),
        () => request(server).post('/license/deactivate'),
        () => request(server).post('/license/check-now'),
        () =>
          request(server)
            .patch('/license/settings')
            .send({ enableEnterpriseFeatures: true }),
      ];
      for (const call of anonymous) {
        const res = await call();
        expect(res.status).toBe(401);
      }
    });
  });

  describe('scope', () => {
    it('licenses one organization at a time, not the whole instance', async () => {
      const { ctx: ownerCtx, session } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({ features: ['sso'] });
      await license.activate(ownerCtx, 'CG-TEST-KEY');

      const other = await createOrganization(
        server,
        ctx.db,
        session.cookie,
        'Other',
      );

      await expect(license.isEnterpriseEnabled(other)).resolves.toBe(false);
      await expect(license.hasFeature(other, 'sso')).resolves.toBe(false);
      await expect(
        license.getEnterpriseSettings(ctxFor(session.id, other)),
      ).resolves.toEqual({ enableEnterpriseFeatures: false, licenseKey: '' });
    });

    it('unlocks parallel builds instance-wide while any organization is licensed', async () => {
      const { ctx: ownerCtx } = await setUpOptedInOwner();

      await expect(license.hasAnyValidLicense()).resolves.toBe(false);

      activateRemote.mockResolvedValue({});
      await license.activate(ownerCtx, 'CG-TEST-KEY');

      await expect(license.hasAnyValidLicense()).resolves.toBe(true);
    });
  });

  // "I've renewed, check now": the owner re-runs activate with the
  // stored key, and the license server's current validUntil is what is stored.
  describe('checking a renewal now', () => {
    const DAY = 24 * 60 * 60 * 1000;

    const setValidUntil = (organizationId: string, validUntil: Date) =>
      ctx.db
        .update(licenseKey)
        .set({ validUntil })
        .where(eq(licenseKey.organizationId, organizationId));

    it('picks up a later validUntil from the license server', async () => {
      const { ctx: ownerCtx } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({
        validUntil: '2030-06-01T00:00:00.000Z',
        features: ['sso'],
      });
      await license.activate(ownerCtx, 'CG-TEST-KEY');
      activateRemote.mockReset();
      activateRemote.mockResolvedValue({
        validUntil: '2031-06-01T00:00:00.000Z',
        features: ['sso', 'audit-logs'],
      });

      await expect(license.checkNow(ownerCtx)).resolves.toEqual({
        licensed: true,
        status: 'active',
        validUntil: '2031-06-01T00:00:00.000Z',
        features: ['sso', 'audit-logs'],
        enableEnterpriseFeatures: true,
      });
      expect(activateRemote).toHaveBeenCalledWith('CG-TEST-KEY');
    });

    it('brings a lapsed license back once it was renewed', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({
        validUntil: '2030-06-01T00:00:00.000Z',
      });
      await license.activate(ownerCtx, 'CG-TEST-KEY');
      await setValidUntil(organizationId, new Date(Date.now() - DAY));
      await expect(license.isEnterpriseEnabled(organizationId)).resolves.toBe(
        false,
      );

      await license.checkNow(ownerCtx);

      await expect(license.isEnterpriseEnabled(organizationId)).resolves.toBe(
        true,
      );
    });

    // The spec's "re-runs activate": a refusal writes nothing, as activate's
    // does, so a check made before the renewal went through costs nothing.
    it('leaves the stored license alone when the license server refuses', async () => {
      const { ctx: ownerCtx, organizationId } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({
        validUntil: '2030-06-01T00:00:00.000Z',
      });
      await license.activate(ownerCtx, 'CG-TEST-KEY');
      activateRemote.mockRejectedValue(new Error('License key not found'));

      await expect(license.checkNow(ownerCtx)).rejects.toThrow(
        'License key not found',
      );
      await expect(license.getStatus(organizationId)).resolves.toMatchObject({
        licensed: true,
        status: 'active',
        validUntil: '2030-06-01T00:00:00.000Z',
      });
    });

    it('refuses with no key stored, or before the opt-in', async () => {
      const { ctx: ownerCtx } = await setUpOptedInOwner();
      await expect(license.checkNow(ownerCtx)).rejects.toThrow(
        'No license key found',
      );

      activateRemote.mockResolvedValue({});
      await license.activate(ownerCtx, 'CG-TEST-KEY');
      await license.updateEnterpriseSettings(ownerCtx, {
        enableEnterpriseFeatures: false,
      });
      activateRemote.mockClear();

      await expect(license.checkNow(ownerCtx)).rejects.toThrow(
        'Please activate enterprise features to check the license key',
      );
      expect(activateRemote).not.toHaveBeenCalled();
    });

    it('answers over HTTP with the status that results', async () => {
      const { ctx: ownerCtx, session } = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({});
      await license.activate(ownerCtx, 'CG-HTTP-KEY');
      activateRemote.mockResolvedValue({
        validUntil: '2031-06-01T00:00:00.000Z',
      });

      const res = await request(server)
        .post('/license/check-now')
        .set('Cookie', session.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        licensed: true,
        status: 'active',
        validUntil: '2031-06-01T00:00:00.000Z',
        features: [],
        enableEnterpriseFeatures: true,
      });
    });
  });

  // The daily re-check: the same re-activate, made by the instance in
  // the last 14 days before validUntil and while lapsed, and only then.
  describe('the daily re-check', () => {
    const DAY = 24 * 60 * 60 * 1000;
    let recheck: LicenseRecheckService;

    beforeAll(() => {
      recheck = ctx.app.get(LicenseRecheckService);
    });

    /** A license activated with the license server, expiring at `validUntil`. */
    async function setUpLicense(validUntil: Date) {
      const owned = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({
        validUntil: validUntil.toISOString(),
      });
      await license.activate(owned.ctx, 'CG-TEST-KEY');
      activateRemote.mockReset();
      return owned;
    }

    it('calls the license server only inside the 14-day window', async () => {
      const now = new Date();
      const validUntil = new Date(now.getTime() + 20 * DAY);
      const renewedTo = new Date(now.getTime() + 385 * DAY);
      const { organizationId } = await setUpLicense(validUntil);
      activateRemote.mockResolvedValue({ validUntil: renewedTo.toISOString() });

      // 20 days before: the stored answer stands.
      await expect(recheck.tick(now)).resolves.toEqual({
        rechecked: [],
        failed: [],
      });
      // 15 days before: still outside.
      await recheck.tick(new Date(now.getTime() + 5 * DAY));
      expect(activateRemote).not.toHaveBeenCalled();

      // 14 days before: re-activated, and the renewal is stored.
      await expect(
        recheck.tick(new Date(now.getTime() + 6 * DAY)),
      ).resolves.toEqual({ rechecked: [organizationId], failed: [] });
      expect(activateRemote).toHaveBeenCalledWith('CG-TEST-KEY');
      await expect(license.getStatus(organizationId)).resolves.toMatchObject({
        licensed: true,
        validUntil: renewedTo.toISOString(),
      });
    });

    it('makes a lapsed license whose key was renewed valid again', async () => {
      const { organizationId } = await setUpLicense(
        new Date(Date.now() - 3 * DAY),
      );
      await expect(license.getStatus(organizationId)).resolves.toMatchObject({
        licensed: false,
      });
      activateRemote.mockResolvedValue({
        validUntil: '2030-06-01T00:00:00.000Z',
      });

      await expect(recheck.tick()).resolves.toEqual({
        rechecked: [organizationId],
        failed: [],
      });

      await expect(license.getStatus(organizationId)).resolves.toMatchObject({
        licensed: true,
        status: 'active',
        validUntil: '2030-06-01T00:00:00.000Z',
      });
    });

    it('keeps a lapsed license as it was while the key is not renewed', async () => {
      const lapsedOn = new Date(Date.now() - 3 * DAY);
      const { organizationId } = await setUpLicense(lapsedOn);
      activateRemote.mockRejectedValue(new Error('License key expired'));

      await expect(recheck.tick()).resolves.toEqual({
        rechecked: [],
        failed: [organizationId],
      });

      await expect(license.getStatus(organizationId)).resolves.toMatchObject({
        licensed: false,
        status: 'active',
        validUntil: lapsedOn.toISOString(),
      });
    });

    it('leaves alone a license with no expiry, a refused key and an opted-out one', async () => {
      const perpetual = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({ validUntil: null });
      await license.activate(perpetual.ctx, 'CG-PERPETUAL-KEY');

      const refused = await createOrganization(
        server,
        ctx.db,
        perpetual.session.cookie,
        'Refused',
      );
      const optedOut = await createOrganization(
        server,
        ctx.db,
        perpetual.session.cookie,
        'Opted out',
      );
      const lapsed = new Date(Date.now() - DAY);
      await ctx.db.insert(licenseKey).values([
        {
          organizationId: refused,
          enableEnterpriseFeatures: true,
          key: 'CG-REFUSED-KEY',
          status: 'invalid',
          validUntil: lapsed,
        },
        {
          organizationId: optedOut,
          enableEnterpriseFeatures: false,
          key: 'CG-OPTED-OUT-KEY',
          status: 'active',
          validUntil: lapsed,
        },
      ]);
      activateRemote.mockReset();

      await expect(recheck.tick()).resolves.toEqual({
        rechecked: [],
        failed: [],
      });
      expect(activateRemote).not.toHaveBeenCalled();
    });

    // Nothing calls `tick` on a request path, so if this job is not registered
    // the renewal never reaches an instance on its own.
    it('is what the boot hook schedules, so something actually runs it', () => {
      expect(ctx.app.get(SchedulingService).has(LICENSE_RECHECK_JOB_ID)).toBe(
        true,
      );
    });
  });

  // The 14- and 3-day `license-expiring` warnings, sent by the daily
  // re-check's pass after its re-activations, to the channels that ticked the
  // event and, when the instance can send mail, to every owner.
  describe('the license-expiring warnings', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const EXPIRING_HOOK = 'https://hooks.slack.com/services/T/B/EXPIRING';
    const LAPSE_HOOK = 'https://hooks.slack.com/services/T/B/LAPSE-ONLY';
    let recheck: LicenseRecheckService;
    let mailProvider: jest.SpyInstance | undefined;

    beforeAll(() => {
      recheck = ctx.app.get(LicenseRecheckService);
    });

    afterEach(() => {
      mailProvider?.mockRestore();
      mailProvider = undefined;
    });

    /** `MAIL_PROVIDER` as the running app reads it, set for one test. */
    function withMailConfigured() {
      const config = ctx.app.get(ConfigService);
      const original = config.get.bind(config) as (key: string) => unknown;
      mailProvider = jest
        .spyOn(config, 'get')
        .mockImplementation((key: string) =>
          key === 'MAIL_PROVIDER' ? 'resend' : original(key),
        );
    }

    /**
     * A license expiring at `validUntil`, a slack channel opted into
     * `license-expiring` only and one opted into `license-lapse` only. The
     * license server answers every re-check with the same date: not renewed.
     */
    async function setUpExpiringLicense(validUntil: Date) {
      const owned = await setUpOptedInOwner();
      activateRemote.mockResolvedValue({
        validUntil: validUntil.toISOString(),
      });
      await license.activate(owned.ctx, 'CG-TEST-KEY');
      const notifications = ctx.app.get(NotificationsService);
      const flags = {
        appDeploy: false,
        appBuildError: false,
        databaseBackup: false,
        volumeBackup: false,
        instanceBackup: false,
        instanceRestart: false,
        dockerCleanup: false,
        serverThreshold: false,
        licenseLapse: false,
        licenseExpiring: false,
        agentRateLimited: false,
        previewTeardownStuck: false,
        serviceIncident: false,
        aiModelNotAnswering: false,
      };
      await notifications.createSlack(owned.ctx, {
        ...flags,
        name: 'renewals',
        webhookUrl: EXPIRING_HOOK,
        licenseExpiring: true,
      });
      await notifications.createSlack(owned.ctx, {
        ...flags,
        name: 'lapses',
        webhookUrl: LAPSE_HOOK,
        licenseLapse: true,
      });
      return owned;
    }

    /** The slack attachments posted, in order. */
    const posted = () =>
      fetchMock.mock.calls.map(([url, init]) => {
        const body = JSON.parse((init as { body: string }).body) as {
          attachments: {
            pretext: string;
            fields: { title: string; value: string }[];
          }[];
        };
        return { url: url as string, attachment: body.attachments[0] };
      });
    const daysLeftOf = (attachment: {
      fields: { title: string; value: string }[];
    }) => attachment.fields.find((field) => field.title === 'Days Left')?.value;

    it('fires once at 14 days and once at 3, only to channels that opted in', async () => {
      const now = new Date();
      const validUntil = new Date(now.getTime() + 20 * DAY);
      await setUpExpiringLicense(validUntil);
      const at = (daysBefore: number) =>
        new Date(validUntil.getTime() - daysBefore * DAY);

      await recheck.tick(at(15));
      expect(fetchMock).not.toHaveBeenCalled();

      await recheck.tick(at(14));
      await recheck.tick(at(13));
      await recheck.tick(at(4));
      expect(posted()).toHaveLength(1);
      expect(posted()[0].url).toBe(EXPIRING_HOOK);
      expect(posted()[0].attachment.pretext).toBe(
        ':hourglass: *Enterprise License Expiring*',
      );
      expect(daysLeftOf(posted()[0].attachment)).toBe('14');

      await recheck.tick(at(3));
      await recheck.tick(at(2));
      await recheck.tick(at(0.5));
      expect(posted()).toHaveLength(2);
      expect(posted()[1].url).toBe(EXPIRING_HOOK);
      expect(daysLeftOf(posted()[1].attachment)).toBe('3');
    });

    it('emails every owner at both points when mail is configured', async () => {
      const validUntil = new Date(Date.now() + 20 * DAY);
      await setUpExpiringLicense(validUntil);
      withMailConfigured();

      await recheck.tick(new Date(validUntil.getTime() - 14 * DAY));
      await recheck.tick(new Date(validUntil.getTime() - 3 * DAY));

      expect(mailSend).toHaveBeenCalledTimes(2);
      for (const [to, email] of mailSend.mock.calls) {
        expect(to).toBe(owner.email);
        expect(email.subject).toContain('expires on');
        // The date on the key, and not the 14 days inside it (ADR-0054).
        expect(email.html).toContain(validUntil.toISOString().slice(0, 10));
      }
    });

    it('sends no email when mail is not configured', async () => {
      const validUntil = new Date(Date.now() + 20 * DAY);
      await setUpExpiringLicense(validUntil);

      await recheck.tick(new Date(validUntil.getTime() - 14 * DAY));

      expect(posted()).toHaveLength(1);
      expect(mailSend).not.toHaveBeenCalled();
    });

    it('is re-armed by a renewal', async () => {
      const validUntil = new Date(Date.now() + 20 * DAY);
      await setUpExpiringLicense(validUntil);
      await recheck.tick(new Date(validUntil.getTime() - 14 * DAY));
      await recheck.tick(new Date(validUntil.getTime() - 3 * DAY));
      expect(posted()).toHaveLength(2);

      // Renewed with Octabyte: the next re-check stores the later date.
      const renewedTo = new Date(validUntil.getTime() + 365 * DAY);
      activateRemote.mockResolvedValue({ validUntil: renewedTo.toISOString() });
      await recheck.tick(new Date(validUntil.getTime() - 2 * DAY));
      expect(posted()).toHaveLength(2);

      await recheck.tick(new Date(renewedTo.getTime() - 14 * DAY));
      expect(posted()).toHaveLength(3);
      expect(daysLeftOf(posted()[2].attachment)).toBe('14');
    });

    it('says nothing about a license that has lapsed', async () => {
      const validUntil = new Date(Date.now() + 20 * DAY);
      await setUpExpiringLicense(validUntil);

      await recheck.tick(new Date(validUntil.getTime() + DAY));

      expect(posted().filter((call) => call.url === EXPIRING_HOOK)).toEqual([]);
    });
  });
});
