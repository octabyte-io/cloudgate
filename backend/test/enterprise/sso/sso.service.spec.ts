import { BadRequestException, HttpException } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import type { Auth } from '../../../src/auth/auth.config';
import type { DrizzleDB } from '../../../src/db/drizzle.module';
import { SsoAddressPolicy } from '../../../src/enterprise/sso/sso-addresses';
import { SsoService } from '../../../src/enterprise/sso/sso.service';
import type { RegisterSsoProviderInput } from '../../../src/enterprise/sso/sso.service';
import type { LicenseService } from '../../../src/enterprise/license/license.service';
import type { InstanceMode } from '../../../src/instance-mode/instance-mode.service';
import { OUTBOUND_ADDRESS_REFUSED_CODE } from '../../../src/outbound/outbound-address-guard';
import type { PermissionService } from '../../../src/rbac/permission.service';

const INSTANCE_ORG = 'org-instance';
const CUSTOMER_ORG = 'org-customer';

/**
 * A drizzle stand-in: every `select` chain resolves to the next queued rows
 * (none once the queue is empty); `update` and `delete` are recorded.
 */
function fakeDb(selects: unknown[][] = []) {
  const queue = [...selects];
  const chain = (result: () => unknown): unknown => {
    const node: Record<string | symbol, unknown> = {};
    return new Proxy(node, {
      get(_target, key) {
        if (key === 'then') {
          return (
            onFulfilled: (value: unknown) => unknown,
            onRejected: (reason: unknown) => unknown,
          ) => Promise.resolve(result()).then(onFulfilled, onRejected);
        }
        return () => chain(result);
      },
    });
  };
  const db = {
    select: jest.fn(() => {
      const rows = queue.shift() ?? [];
      return chain(() => rows);
    }),
    update: jest.fn(() => chain(() => undefined)),
    delete: jest.fn(() => chain(() => [])),
  };
  return db;
}

function harness({
  hosted,
  organizationId,
  selects,
  register = jest.fn(() => Promise.resolve({})),
}: {
  hosted: boolean;
  organizationId: string;
  selects?: unknown[][];
  register?: jest.Mock;
}) {
  const db = fakeDb(selects);
  const instanceMode = { isHosted: hosted } as InstanceMode;
  const permissions = {
    findMember: () => Promise.resolve({ role: 'owner' }),
    instanceOrganizationId: () => Promise.resolve(INSTANCE_ORG),
  } as unknown as PermissionService;
  const addresses = new SsoAddressPolicy(
    (host) =>
      host === 'idp.acme.example'
        ? Promise.resolve(['93.184.215.14'])
        : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`)),
    instanceMode,
    permissions,
  );
  const auth = {
    api: { registerSSOProvider: register },
  } as unknown as Auth;
  const service = new SsoService(
    db as unknown as DrizzleDB,
    auth,
    permissions,
    {
      hasValidLicense: () => Promise.resolve(true),
    } as unknown as LicenseService,
    instanceMode,
    addresses,
  );
  const ctx = {
    user: { id: 'user-1' },
    session: { activeOrganizationId: organizationId },
  };
  return { db, service, ctx, register };
}

const provider = (
  issuer: string,
  extra: Partial<RegisterSsoProviderInput> = {},
): RegisterSsoProviderInput => ({
  providerId: 'acme-oidc',
  issuer,
  domains: ['acme.example'],
  oidcConfig: { clientId: 'client', clientSecret: 'secret' },
  ...extra,
});

/** The plugin's refusal, as `registerSSOProvider` raises it. */
const pluginRefusal = (code: string) =>
  new APIError('BAD_REQUEST', { code, message: `refused: ${code}` });

/** The `code` of a Nest refusal, or null when `promise` resolved. */
async function refusalCodeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return (error.getResponse() as { code?: unknown }).code;
  }
}

describe('SsoService', () => {
  describe('registering a provider on the Hosted instance', () => {
    it.each(['http://169.254.169.254', 'http://127.0.0.1:4000'])(
      'refuses a customer an issuer at %s, before the plugin fetches it or anything is trusted',
      async (issuer) => {
        const { service, ctx, register } = harness({
          hosted: true,
          organizationId: CUSTOMER_ORG,
        });
        const trust = jest.spyOn(service, 'addTrustedOrigin');

        expect(
          await refusalCodeOf(
            service.register(ctx, {}, provider(issuer, { trustIssuer: true })),
          ),
        ).toBe(OUTBOUND_ADDRESS_REFUSED_CODE);
        expect(register).not.toHaveBeenCalled();
        expect(trust).not.toHaveBeenCalled();
      },
    );

    it('refuses a customer an internal token endpoint behind a public issuer', async () => {
      const { service, ctx, register } = harness({
        hosted: true,
        organizationId: CUSTOMER_ORG,
      });

      await expect(
        service.register(
          ctx,
          {},
          provider('https://idp.acme.example', {
            oidcConfig: {
              clientId: 'client',
              clientSecret: 'secret',
              tokenEndpoint: 'http://10.0.0.5/token',
              skipDiscovery: true,
            },
          }),
        ),
      ).rejects.toMatchObject({
        response: { field: 'oidcConfig.tokenEndpoint' },
      });
      expect(register).not.toHaveBeenCalled();
    });

    it('removes a provider whose discovery document named an internal endpoint', async () => {
      const { service, ctx, db } = harness({
        hosted: true,
        organizationId: CUSTOMER_ORG,
        selects: [
          [], // the domain collision scan
          [
            {
              issuer: 'https://idp.acme.example',
              oidcConfig: JSON.stringify({
                tokenEndpoint: 'http://127.0.0.1:3000/api/auth/token',
              }),
            },
          ],
        ],
      });

      expect(
        await refusalCodeOf(
          service.register(ctx, {}, provider('https://idp.acme.example')),
        ),
      ).toBe(OUTBOUND_ADDRESS_REFUSED_CODE);
      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it('lets the Instance organization register an internal IdP', async () => {
      const { service, ctx, register } = harness({
        hosted: true,
        organizationId: INSTANCE_ORG,
      });

      await expect(
        service.register(ctx, {}, provider('http://127.0.0.1:4000')),
      ).resolves.toEqual({ success: true });
      expect(register).toHaveBeenCalledTimes(1);
    });
  });

  describe('curing a refusal with "Trust this issuer"', () => {
    it('never trusts the origin of an endpoint the plugin found not publicly routable', async () => {
      const register = jest.fn(() =>
        Promise.reject(pluginRefusal('discovery_private_host')),
      );
      const { service, ctx } = harness({
        hosted: false,
        organizationId: CUSTOMER_ORG,
        register,
      });
      const trust = jest.spyOn(service, 'addTrustedOrigin');

      expect(
        await refusalCodeOf(
          service.register(
            ctx,
            {},
            provider('http://192.168.1.20', { trustIssuer: true }),
          ),
        ),
      ).toBe('discovery_private_host');
      expect(trust).not.toHaveBeenCalled();
      expect(register).toHaveBeenCalledTimes(1);
    });

    it('still trusts an issuer discovery refused only for not being on the list', async () => {
      const register = jest
        .fn()
        .mockRejectedValueOnce(pluginRefusal('discovery_untrusted_origin'))
        .mockResolvedValueOnce({});
      const { service, ctx } = harness({
        hosted: false,
        organizationId: CUSTOMER_ORG,
        register,
      });
      const trust = jest
        .spyOn(service, 'addTrustedOrigin')
        .mockResolvedValue({ success: true });

      await service.register(
        ctx,
        {},
        provider('https://idp.acme.example/realms/acme', { trustIssuer: true }),
      );

      expect(trust).toHaveBeenCalledWith(ctx, 'https://idp.acme.example');
      expect(register).toHaveBeenCalledTimes(2);
    });
  });

  describe('adding a trusted origin', () => {
    it.each([
      ['the metadata address', 'http://169.254.169.254'],
      ['loopback', 'http://127.0.0.1:4000'],
      ['a wildcard', 'https://*.acme.example'],
    ])(
      'refuses a customer on the Hosted instance %s, writing nothing',
      async (_case, origin) => {
        const { service, ctx, db } = harness({
          hosted: true,
          organizationId: CUSTOMER_ORG,
        });

        await expect(
          service.addTrustedOrigin(ctx, origin),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(db.update).not.toHaveBeenCalled();
      },
    );

    it('refuses the new origin of a rename the same way', async () => {
      const { service, ctx, db } = harness({
        hosted: true,
        organizationId: CUSTOMER_ORG,
      });

      await expect(
        service.updateTrustedOrigin(
          ctx,
          'https://idp.acme.example',
          'http://169.254.169.254',
        ),
      ).rejects.toMatchObject({ response: { field: 'newOrigin' } });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('lets the Instance organization trust an internal origin', async () => {
      const { service, ctx, db } = harness({
        hosted: true,
        organizationId: INSTANCE_ORG,
        selects: [[{ ownerId: 'user-1' }], [{ trustedOrigins: [] }]],
      });

      await service.addTrustedOrigin(ctx, 'http://127.0.0.1:4000');

      expect(db.update).toHaveBeenCalledTimes(1);
    });
  });
});
