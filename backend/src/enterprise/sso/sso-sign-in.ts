import { eq } from 'drizzle-orm';
import { organization } from '../../organizations/organizations.schema';
import type { DrizzleDB } from '../../db/drizzle.module';
import { ssoProvider } from './sso.schema';
import { parseDomainList } from './sso.utils';

/**
 * SSO sign-in stops below Business (ADR-0054): a provider signs nobody
 * in while its Organization fails the paid-feature check
 * (`LicenseService.hasValidLicense`: Business or Enterprise on the Hosted
 * instance, a valid license key Self-hosted). Plain functions over the rows,
 * like `proven-domains.ts`, because `auth.config.ts` asks them from
 * better-auth's hooks, where there is no Nest container.
 *
 * Nothing is wiped: the provider, its domains and the Proven domains stay as
 * they were, so the same sign-in works again the moment the Organization is
 * back on Business. Nobody is locked out either: a person who has only ever
 * signed in through SSO sets a first password with "Forgot password", which
 * better-auth's reset does by creating the credential account they lack.
 * `enforceSSO` is deliberately not part of this check, and the sign-in
 * screen shows the password form whenever it offers no SSO button.
 */

/** The paid-feature check, as `createAuth` is handed it. */
export interface PaidFeatureCheck {
  hasValidLicense(organizationId: string): Promise<boolean>;
}

export const SSO_SIGN_IN_OFF_CODE = 'SSO_SIGN_IN_OFF';

/** What a person refused at the SSO button is told, by instance mode. */
export function ssoSignInOffMessage(hosted: boolean): string {
  const why = hosted
    ? 'is not on the Business plan'
    : 'has no valid enterprise license';
  return `SSO sign-in is off for this Organization because it ${why}. Sign in with your email and password instead; if you have never set one, use "Forgot password"`;
}

/** The Organization a provider belongs to, or null for an unknown provider. */
export async function organizationOfProvider(
  db: DrizzleDB,
  providerId: string | undefined,
): Promise<string | null> {
  if (!providerId) return null;
  const [row] = await db
    .select({ organizationId: ssoProvider.organizationId })
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, providerId))
    .limit(1);
  return row?.organizationId ?? null;
}

/** A domain, or one of its subdomains, listed on a provider: the plugin's own match. */
function listsDomain(domainList: string, domain: string): boolean {
  return parseDomainList(domainList).some(
    (listed) => domain === listed || domain.endsWith(`.${listed}`),
  );
}

/** What the sign-in hooks read of a provider: whose it is and where it points. */
export interface RoutedSsoProvider {
  providerId: string;
  organizationId: string | null;
  issuer: string;
  /** The stored OIDC blob, decrypted; null for a SAML provider. */
  oidcConfig: string | null;
}

const routedProviderColumns = {
  providerId: ssoProvider.providerId,
  organizationId: ssoProvider.organizationId,
  issuer: ssoProvider.issuer,
  oidcConfig: ssoProvider.oidcConfig,
};

/** The provider called `providerId`, or null for an unknown one. */
export async function providerNamed(
  db: DrizzleDB,
  providerId: string | undefined,
): Promise<RoutedSsoProvider | null> {
  if (!providerId) return null;
  const [row] = await db
    .select(routedProviderColumns)
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, providerId))
    .limit(1);
  return row ?? null;
}

/**
 * The provider `POST /sign-in/sso` would send this body to, found the way the
 * plugin finds it: by `providerId`, else by `organizationSlug`, else by the
 * domain of `domain` or `email`. `undefined` when the body names no provider
 * the plugin would find, which the plugin then refuses itself.
 */
export async function providerRoutedTo(
  db: DrizzleDB,
  body: unknown,
): Promise<RoutedSsoProvider | undefined> {
  const { email, domain, providerId, organizationSlug } = (body ?? {}) as {
    email?: unknown;
    domain?: unknown;
    providerId?: unknown;
    organizationSlug?: unknown;
  };
  const providers = await db
    .select({ ...routedProviderColumns, domain: ssoProvider.domain })
    .from(ssoProvider);
  const routed = (
    provider: (typeof providers)[number] | undefined,
  ): RoutedSsoProvider | undefined => {
    if (!provider) return undefined;
    const { providerId, organizationId, issuer, oidcConfig } = provider;
    return { providerId, organizationId, issuer, oidcConfig };
  };

  if (typeof providerId === 'string' && providerId) {
    return routed(providers.find((p) => p.providerId === providerId));
  }
  if (typeof organizationSlug === 'string' && organizationSlug) {
    const [org] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, organizationSlug))
      .limit(1);
    if (org) {
      return routed(providers.find((p) => p.organizationId === org.id));
    }
  }
  const routedDomain =
    typeof domain === 'string' && domain
      ? domain
      : typeof email === 'string'
        ? email.split('@')[1]
        : undefined;
  const search = routedDomain?.trim().toLowerCase();
  if (!search) return undefined;
  return routed(
    providers.find((p) => p.domain === routedDomain) ??
      providers.find((p) => listsDomain(p.domain, search)),
  );
}

/**
 * The Organization whose provider `POST /sign-in/sso` would send this body to
 * ({@link providerRoutedTo}). `undefined` when the body names no provider the
 * plugin would find.
 */
export async function organizationRoutedTo(
  db: DrizzleDB,
  body: unknown,
): Promise<string | null | undefined> {
  return (await providerRoutedTo(db, body))?.organizationId;
}
