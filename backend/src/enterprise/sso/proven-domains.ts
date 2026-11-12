import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { subscription } from '../../cloud/billing/billing.schema';
import { businessHeld } from '../../cloud/billing/enterprise';
import { payingOrganizationIdSql } from '../../cloud/billing/paying-organization';
import type { DrizzleDB } from '../../db/drizzle.module';
import { organization } from '../../organizations/organizations.schema';
import { provenDomain } from './proven-domain.schema';
import { ssoProvider } from './sso.schema';
import { parseDomainList } from './sso.utils';

/**
 * What a Proven domain lets an SSO provider do on the Hosted instance
 * (ADR-0051), as plain functions over the rows: `auth.config.ts` asks
 * them from better-auth's hooks, where there is no Nest container, and
 * `SsoService` asks them for the sign-in screen.
 *
 * A provider acts for an address only when the address's domain is one of the
 * provider's own domains **and** the provider's Organization has proven it. A
 * domain merely listed on a provider proves nothing, so a squatted claim routes
 * nobody and its identity provider can sign in nobody. Self-hosted never asks.
 */

/** Where the challenge goes: a TXT record at this name. */
export const challengeRecordName = (domain: string): string =>
  `_cloudgate-challenge.${domain}`;

/** What the TXT record has to say. */
export const challengeRecordValue = (challenge: string): string =>
  `cloudgate-domain-verification=${challenge}`;

export const SSO_DOMAIN_NOT_PROVEN_CODE = 'SSO_DOMAIN_NOT_PROVEN';

export const SSO_DOMAIN_NOT_PROVEN_MESSAGE =
  "This email address is not in a domain the SSO provider's Organization has proven, so it cannot sign in through that provider.";

/** The lowercased domain of an address, or null when it has none. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain || null;
}

/** Whether this Organization has proven this (normalized) domain. */
async function isProven(
  db: DrizzleDB,
  organizationId: string,
  domain: string,
): Promise<boolean> {
  const [row] = await db
    .select({ provenDomainId: provenDomain.provenDomainId })
    .from(provenDomain)
    .where(
      and(
        eq(provenDomain.organizationId, organizationId),
        eq(provenDomain.domain, domain),
        isNotNull(provenDomain.provenAt),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Whether the provider may route or accept a sign-in for this domain: it lists
 * the domain, and its Organization has proven it.
 */
async function providerActsForDomain(
  db: DrizzleDB,
  provider: { organizationId: string | null; domain: string },
  domain: string,
): Promise<boolean> {
  if (!provider.organizationId) return false;
  if (!parseDomainList(provider.domain).includes(domain)) return false;
  return isProven(db, provider.organizationId, domain);
}

/**
 * The acceptance check, at the callback: may provider `providerId` sign in
 * `email`? Unknown provider or an address with no domain is a no.
 */
export async function providerActsFor(
  db: DrizzleDB,
  providerId: string | undefined,
  email: string,
): Promise<boolean> {
  const domain = emailDomain(email);
  if (!providerId || !domain) return false;
  const [provider] = await db
    .select({
      organizationId: ssoProvider.organizationId,
      domain: ssoProvider.domain,
    })
    .from(ssoProvider)
    .where(eq(ssoProvider.providerId, providerId))
    .limit(1);
  return provider ? providerActsForDomain(db, provider, domain) : false;
}

/**
 * The routing check, at `POST /sign-in/sso`, for the provider a domain is
 * claimed by. `'unclaimed'` leaves the plugin to answer as it always has; a
 * claim the claimant has not proven is refused before the browser is sent to
 * its identity provider.
 */
export async function routingFor(
  db: DrizzleDB,
  request: { domain: string; providerId?: string },
): Promise<'unclaimed' | 'proven' | 'unproven'> {
  const providers = await db
    .select({
      providerId: ssoProvider.providerId,
      organizationId: ssoProvider.organizationId,
      domain: ssoProvider.domain,
    })
    .from(ssoProvider);
  const provider = request.providerId
    ? providers.find((p) => p.providerId === request.providerId)
    : providers.find((p) => parseDomainList(p.domain).includes(request.domain));
  if (!provider) return 'unclaimed';
  return (await providerActsForDomain(db, provider, request.domain))
    ? 'proven'
    : 'unproven';
}

/**
 * The sign-in screen's question on the Hosted instance: does at least one
 * Organization on Business or Enterprise have SSO set up — a provider with a
 * domain its Organization has proven, which is the least that can sign anybody
 * in. A Starter Organization's provider signs nobody in, so it
 * offers no button either. The plan is the provider's Organization's Paying
 * Organization's, so an Attached Organization of a Business payer offers it
 * (ADR-0059).
 */
export async function anyBusinessSsoReady(db: DrizzleDB): Promise<boolean> {
  const providers = await db
    .select({
      organizationId: ssoProvider.organizationId,
      domain: ssoProvider.domain,
    })
    .from(ssoProvider)
    .innerJoin(organization, eq(organization.id, ssoProvider.organizationId))
    .innerJoin(
      subscription,
      eq(subscription.organizationId, payingOrganizationIdSql),
    )
    .where(businessHeld());
  if (providers.length === 0) return false;

  const organizationIds = [
    ...new Set(providers.map((p) => p.organizationId).filter((id) => !!id)),
  ] as string[];
  const proven = await db
    .select({
      organizationId: provenDomain.organizationId,
      domain: provenDomain.domain,
    })
    .from(provenDomain)
    .where(
      and(
        inArray(provenDomain.organizationId, organizationIds),
        isNotNull(provenDomain.provenAt),
      ),
    );
  const provenKeys = new Set(
    proven.map((row) => `${row.organizationId} ${row.domain}`),
  );
  return providers.some((provider) =>
    parseDomainList(provider.domain).some((domain) =>
      provenKeys.has(`${provider.organizationId} ${domain}`),
    ),
  );
}
