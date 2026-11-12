import {
  ssoOrganizationOfRequest,
  trustedOriginOwners,
} from '../../src/auth/trusted-origin-scope';
import type { SsoRequestLookups } from '../../src/auth/trusted-origin-scope';

const INSTANCE_ORG = 'org-instance';
const ACME = 'org-acme';
const GLOBEX = 'org-globex';

describe('trustedOriginOwners', () => {
  it("counts every Organization's list on a Self-hosted instance, as before", () => {
    expect(
      trustedOriginOwners({
        hosted: false,
        instanceOrganizationId: INSTANCE_ORG,
        ssoOrganizationId: ACME,
      }),
    ).toBe('every');
  });

  it("counts no customer's list on the Hosted instance outside SSO", () => {
    expect(
      trustedOriginOwners({
        hosted: true,
        instanceOrganizationId: INSTANCE_ORG,
        ssoOrganizationId: null,
      }),
    ).toEqual([INSTANCE_ORG]);
  });

  it("counts one customer's list on that customer's own SSO, beside the Instance organization's", () => {
    expect(
      trustedOriginOwners({
        hosted: true,
        instanceOrganizationId: INSTANCE_ORG,
        ssoOrganizationId: ACME,
      }),
    ).toEqual([INSTANCE_ORG, ACME]);
  });

  it('counts nobody before the Instance organization exists', () => {
    expect(
      trustedOriginOwners({
        hosted: true,
        instanceOrganizationId: null,
        ssoOrganizationId: undefined,
      }),
    ).toEqual([]);
  });
});

describe('ssoOrganizationOfRequest', () => {
  const providers: Record<string, string> = {
    'acme-oidc': ACME,
    'globex-saml': GLOBEX,
  };
  const lookups: SsoRequestLookups = {
    organizationOfProvider: (providerId) =>
      Promise.resolve(providers[providerId] ?? null),
    organizationRoutedTo: (body) =>
      Promise.resolve(
        (body as { email?: string }).email?.endsWith('@acme.example')
          ? ACME
          : undefined,
      ),
  };

  it.each<[string, Parameters<typeof ssoOrganizationOfRequest>[0], string]>([
    [
      'a registration, by the Organization SsoService registers for',
      { path: '/sso/register', body: { organizationId: ACME } },
      ACME,
    ],
    [
      'a provider edit, by the provider it names',
      { path: '/sso/update-provider', body: { providerId: 'acme-oidc' } },
      ACME,
    ],
    [
      'a sign-in, by the provider the plugin would route it to',
      { path: '/sign-in/sso', body: { email: 'sam@acme.example' } },
      ACME,
    ],
    [
      'the OIDC callback, by its path',
      {
        path: '/sso/callback/:providerId',
        params: { providerId: 'acme-oidc' },
      },
      ACME,
    ],
    [
      'the SAML ACS, by its path',
      {
        path: '/sso/saml2/sp/acs/:providerId',
        params: { providerId: 'globex-saml' },
      },
      GLOBEX,
    ],
  ])('finds the Organization of %s', async (_case, request, expected) => {
    expect(await ssoOrganizationOfRequest(request, lookups)).toBe(expected);
  });

  it.each<[string, Parameters<typeof ssoOrganizationOfRequest>[0]]>([
    [
      'a password sign-in naming a provider',
      { path: '/sign-in/email', body: { providerId: 'acme-oidc' } },
    ],
    ['a session read', { path: '/get-session' }],
    [
      'a sign-in that routes to no provider',
      { path: '/sign-in/sso', body: { email: 'sam@unknown.example' } },
    ],
    [
      'a callback for an unknown provider',
      { path: '/sso/callback/:providerId', params: { providerId: 'gone' } },
    ],
  ])('finds none for %s', async (_case, request) => {
    expect(await ssoOrganizationOfRequest(request, lookups)).toBeNull();
  });
});
