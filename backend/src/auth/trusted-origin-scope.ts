/**
 * Whose runtime trusted origins count on one `/api/auth` request.
 *
 * The runtime list lives on each Organization owner's user row and was merged
 * for every Organization on every request, because the SSO plugin asks one
 * context-wide `isTrustedOrigin` before it fetches a provider (ADR-0076 has
 * the history). That one list is also what better-auth checks every request's
 * `Origin` and every `callbackURL` against, so on the Hosted instance one
 * customer's origin was trusted on every other customer's sign-in.
 *
 * On a Self-hosted instance one operator owns every Organization, so the list
 * stays merged and nothing changes. On the Hosted instance the list holds the
 * Instance organization's origins on every request (the operator's: a console
 * domain, an internal IdP of Octabyte's), and one customer's origins only on
 * a request that is that customer's own SSO: registering or editing its
 * provider, `POST /sign-in/sso` routed to it, and its callbacks.
 */

/** Every Organization's list, or the lists of these Organizations only. */
export type TrustedOriginOwners = 'every' | string[];

/** Whose lists count; see the module comment. */
export function trustedOriginOwners(input: {
  hosted: boolean;
  instanceOrganizationId: string | null;
  ssoOrganizationId: string | null | undefined;
}): TrustedOriginOwners {
  if (!input.hosted) return 'every';
  const owners = [input.instanceOrganizationId, input.ssoOrganizationId].filter(
    (id): id is string => typeof id === 'string' && id !== '',
  );
  return [...new Set(owners)];
}

/** What {@link ssoOrganizationOfRequest} reads, as plain lookups. */
export interface SsoRequestLookups {
  organizationOfProvider(providerId: string): Promise<string | null>;
  organizationRoutedTo(body: unknown): Promise<string | null | undefined>;
}

/** The parts of a better-auth endpoint context this reads. */
export interface AuthRequestShape {
  path?: string;
  params?: unknown;
  body?: unknown;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field !== '' ? field : undefined;
}

/**
 * The Organization whose SSO this request is, or null when it is no
 * Organization's SSO.
 *
 * - `/sso/register`: the body's `organizationId`, which `SsoService` sets to
 *   the caller's active Organization (the route itself is closed to HTTP);
 * - `/sso/update-provider`: the provider the body names;
 * - `/sign-in/sso`: the provider the plugin would route the body to;
 * - any other `/sso/*` route with a `:providerId` (the OIDC callback, the
 *   SAML ACS, callback and logout): that provider.
 */
export async function ssoOrganizationOfRequest(
  request: AuthRequestShape,
  lookups: SsoRequestLookups,
): Promise<string | null> {
  const { path, params, body } = request;
  if (!path) return null;
  if (path === '/sso/register') {
    return stringField(body, 'organizationId') ?? null;
  }
  if (path === '/sign-in/sso') {
    return (await lookups.organizationRoutedTo(body)) ?? null;
  }
  const providerId =
    path === '/sso/update-provider'
      ? stringField(body, 'providerId')
      : path.startsWith('/sso/')
        ? stringField(params, 'providerId')
        : undefined;
  if (!providerId) return null;
  return lookups.organizationOfProvider(providerId);
}
