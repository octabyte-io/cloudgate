import { BadRequestException } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import type { InstanceMode } from '../../../src/instance-mode/instance-mode.service';
import { OUTBOUND_ADDRESS_REFUSED_CODE } from '../../../src/outbound/outbound-address-guard';
import type { AddressResolver } from '../../../src/outbound/outbound-address';
import type { PermissionService } from '../../../src/rbac/permission.service';
import {
  oidcProviderUrls,
  refuseNonPublicOidcProvider,
  SsoAddressPolicy,
} from '../../../src/enterprise/sso/sso-addresses';

const INSTANCE_ORG = 'org-instance';
const CUSTOMER_ORG = 'org-customer';

/** A resolver over a fixed table; any other name does not resolve. */
const resolverOf =
  (table: Record<string, string[]>): AddressResolver =>
  (host) =>
    host in table
      ? Promise.resolve(table[host])
      : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));

const resolve = resolverOf({
  'idp.acme.example': ['93.184.215.14'],
  'rebound.acme.example': ['10.0.0.5'],
  'metadata.acme.example': ['169.254.169.254'],
});

function policy(hosted: boolean): SsoAddressPolicy {
  return new SsoAddressPolicy(
    resolve,
    { isHosted: hosted } as InstanceMode,
    {
      instanceOrganizationId: () => Promise.resolve(INSTANCE_ORG),
    } as unknown as PermissionService,
  );
}

/** The refusal body, or null when `promise` resolved. */
async function refusalOf(
  promise: Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (!(error instanceof BadRequestException)) throw error;
    return error.getResponse() as Record<string, unknown>;
  }
}

describe('SsoAddressPolicy', () => {
  describe('for a customer Organization on the Hosted instance', () => {
    const hosted = policy(true);

    it.each([
      ['the cloud metadata address', 'http://169.254.169.254'],
      ['loopback with a port', 'http://127.0.0.1:4000'],
      ['a private range', 'https://10.1.2.3/realms/acme'],
      ['an IPv6 loopback', 'http://[::1]:8080'],
      [
        'a name that resolves to a private range',
        'https://rebound.acme.example',
      ],
      ['a name that resolves to metadata', 'http://metadata.acme.example'],
      ['a name that does not resolve', 'https://nowhere.acme.example'],
      ['a wildcard origin', 'https://*.acme.example'],
      ['something that is not a URL', 'idp.acme.example'],
    ])('refuses an issuer at %s', async (_case, issuer) => {
      expect(
        await refusalOf(hosted.assertPublicFor(CUSTOMER_ORG, { issuer })),
      ).toMatchObject({ code: OUTBOUND_ADDRESS_REFUSED_CODE, field: 'issuer' });
    });

    it('names the first endpoint that is not public', async () => {
      const urls = oidcProviderUrls('https://idp.acme.example', {
        tokenEndpoint: 'https://idp.acme.example/token',
        jwksEndpoint: 'http://169.254.169.254/latest/meta-data/',
      });

      expect(
        await refusalOf(hosted.assertPublicFor(CUSTOMER_ORG, urls)),
      ).toMatchObject({ field: 'oidcConfig.jwksEndpoint' });
    });

    it('lets an IdP on the internet through', async () => {
      const urls = oidcProviderUrls('https://idp.acme.example', {
        tokenEndpoint: 'https://idp.acme.example/token',
        userInfoEndpoint: 'https://93.184.215.14/userinfo',
      });

      await expect(
        hosted.assertPublicFor(CUSTOMER_ORG, urls),
      ).resolves.toBeUndefined();
    });

    it('refuses a provider that belongs to no Organization', async () => {
      expect(await hosted.mustBePublic(null)).toBe(true);
    });
  });

  it('lets the Instance organization point SSO at an internal IdP on the Hosted instance', async () => {
    await expect(
      policy(true).assertPublicFor(INSTANCE_ORG, {
        issuer: 'http://127.0.0.1:4000',
      }),
    ).resolves.toBeUndefined();
  });

  it('leaves every Organization on a Self-hosted instance as it was', async () => {
    const selfHosted = policy(false);

    expect(await selfHosted.mustBePublic(CUSTOMER_ORG)).toBe(false);
    await expect(
      selfHosted.assertPublicFor(CUSTOMER_ORG, {
        issuer: 'http://169.254.169.254',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('oidcProviderUrls', () => {
  it('keys the issuer and every endpoint present by its request field', () => {
    expect(
      oidcProviderUrls('https://idp.example', {
        clientId: 'not-a-url',
        tokenEndpoint: 'https://idp.example/token',
        userInfoEndpoint: '',
      }),
    ).toEqual({
      issuer: 'https://idp.example',
      'oidcConfig.tokenEndpoint': 'https://idp.example/token',
    });
  });
});

describe('refuseNonPublicOidcProvider', () => {
  const hosted = policy(true);

  /** The better-auth refusal, or null when nothing was refused. */
  async function apiRefusalOf(
    promise: Promise<unknown>,
  ): Promise<APIError | null> {
    try {
      await promise;
      return null;
    } catch (error) {
      if (!(error instanceof APIError)) throw error;
      return error;
    }
  }

  it('refuses at sign-in a stored token endpoint that now resolves to a private range', async () => {
    const refused = await apiRefusalOf(
      refuseNonPublicOidcProvider(hosted, {
        organizationId: CUSTOMER_ORG,
        issuer: 'https://idp.acme.example',
        oidcConfig: JSON.stringify({
          tokenEndpoint: 'https://rebound.acme.example/token',
        }),
      }),
    );

    expect(refused?.statusCode).toBe(400);
    expect(refused?.body).toMatchObject({
      code: OUTBOUND_ADDRESS_REFUSED_CODE,
      message: expect.stringContaining('oidcConfig.tokenEndpoint') as unknown,
    });
  });

  it('passes the Instance organization, a SAML provider and a body that routes nowhere', async () => {
    const internal = {
      issuer: 'http://127.0.0.1:4000',
      oidcConfig: JSON.stringify({ tokenEndpoint: 'http://127.0.0.1:4000/t' }),
    };

    await expect(
      refuseNonPublicOidcProvider(hosted, {
        ...internal,
        organizationId: INSTANCE_ORG,
      }),
    ).resolves.toBeUndefined();
    await expect(
      refuseNonPublicOidcProvider(hosted, {
        organizationId: CUSTOMER_ORG,
        issuer: 'urn:acme:saml',
        oidcConfig: null,
      }),
    ).resolves.toBeUndefined();
    await expect(
      refuseNonPublicOidcProvider(hosted, undefined),
    ).resolves.toBeUndefined();
  });
});
