import type { IncomingHttpHeaders } from 'node:http';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { callAuthApi, toWebHeaders } from '../../auth/auth-api.util';
import type { Auth } from '../../auth/auth.config';
import { AUTH } from '../../auth/auth.constants';
import { user } from '../../auth/auth.schema';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { organization } from '../../organizations/organizations.schema';
import { PermissionService } from '../../rbac/permission.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { webServerSettings } from '../../settings/settings.schema';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { LicenseService } from '../license/license.service';
import { paidFeatureRefusal } from '../license/paid-features';
import { anyBusinessSsoReady } from './proven-domains';
import { oidcProviderUrls, SsoAddressPolicy } from './sso-addresses';
import { ssoProvider } from './sso.schema';
import {
  normalizeDomains,
  normalizeTrustedOrigin,
  parseDomainList,
} from './sso.utils';

/** The OIDC settings of a provider being registered or updated. */
export interface SsoOidcConfigInput {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
  tokenEndpointAuthentication?: 'client_secret_post' | 'client_secret_basic';
  jwksEndpoint?: string;
  discoveryEndpoint?: string;
  skipDiscovery?: boolean;
  scopes?: string[];
  pkce?: boolean;
  mapping?: {
    id: string;
    email: string;
    emailVerified?: string;
    name: string;
    image?: string;
    extraFields?: Record<string, unknown>;
  };
}

/**
 * The body of a register or update call. It carries no `organizationId`: the
 * provider always belongs to the caller's active organization.
 */
export interface RegisterSsoProviderInput {
  providerId: string;
  issuer: string;
  /** Email domains routed to this provider; stored comma-joined. */
  domains: string[];
  oidcConfig?: SsoOidcConfigInput;
  overrideUserInfo?: boolean;
  /**
   * Register even though the issuer's origin is not trusted yet, by adding it
   * to the list as part of the same call. Only registration takes this: an
   * update's issuer change goes through `assertIssuerTrusted`, which is
   * Cloudgate's own gate and says what to do about it.
   */
  trustIssuer?: boolean;
}

/** The provider projection, shared by `listProviders` and `findOne`. */
const providerColumns = {
  id: ssoProvider.id,
  providerId: ssoProvider.providerId,
  issuer: ssoProvider.issuer,
  domain: ssoProvider.domain,
  oidcConfig: ssoProvider.oidcConfig,
  samlConfig: ssoProvider.samlConfig,
  organizationId: ssoProvider.organizationId,
};

type ProviderRow = {
  id: string;
  providerId: string;
  issuer: string;
  domain: string;
  oidcConfig: string | null;
  samlConfig: string | null;
  organizationId: string | null;
};

/**
 * A provider as the API exposes it — the registries `stripPassword` idiom, over
 * a JSON blob rather than a column: `oidcConfig`/`samlConfig` are encrypted at
 * rest but decrypt on read, so the projection has to take the credential out
 * before the row is serialised. The sign-in flow reads the row itself and
 * still sees the real secret.
 */
export type SanitizedSsoProvider = Omit<ProviderRow, 'oidcConfig'> & {
  /**
   * The stored blob minus `clientSecret`, still the **JSON string** the column
   * holds: the plugin writes it serialised and this passes the string on.
   */
  oidcConfig: string | null;
  /**
   * Derived, because the value it stands for is gone: the console needs to know
   * a secret is on file to say so, and `update` keeps it when an edit omits it.
   */
  hasClientSecret: boolean;
};

/** A stored blob, or null when it is absent or not a JSON object. */
function parseBlob(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // A blob written by something other than the plugin. It is not projectable,
    // so it is withheld rather than passed through — it may hold the secret.
    return null;
  }
}

/**
 * The private material of a SAML config — the top-level signing and decryption
 * keys and the ones nested in `spMetadata`/`idpMetadata`. The IdP's `cert` is
 * not among them: a signing certificate is public by definition.
 */
const SAML_PRIVATE_KEYS = new Set([
  'privateKey',
  'privateKeyPass',
  'encPrivateKey',
  'encPrivateKeyPass',
  'decryptionPvk',
]);

/** Drops those keys wherever they sit, since the blob nests them. */
function stripSamlPrivateKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSamlPrivateKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SAML_PRIVATE_KEYS.has(key))
      .map(([key, nested]) => [key, stripSamlPrivateKeys(nested)]),
  );
}

/** The row with the OIDC client secret and the SAML private keys taken out. */
function sanitizeProvider(row: ProviderRow): SanitizedSsoProvider {
  const oidc = parseBlob(row.oidcConfig);
  let oidcConfig: string | null = null;
  let hasClientSecret = false;
  if (oidc) {
    const { clientSecret, ...rest } = oidc;
    hasClientSecret = typeof clientSecret === 'string' && clientSecret !== '';
    oidcConfig = JSON.stringify(rest);
  }

  const saml = parseBlob(row.samlConfig);
  const samlConfig = saml ? JSON.stringify(stripSamlPrivateKeys(saml)) : null;

  return { ...row, oidcConfig, samlConfig, hasClientSecret };
}

/**
 * The refusal `trustIssuer` cures: discovery would fetch an issuer whose
 * origin is not on the trusted-origins list (`discovery_untrusted_origin`).
 *
 * `discovery_private_host` — an endpoint that is not publicly routable — is
 * deliberately not here, though trusting its origin would also get past it
 * (ADR-0076). That refusal is about where the platform host would be sent,
 * not about the list, and curing it in passing is how a customer on the
 * Hosted instance had the box fetch `http://169.254.169.254`. An operator who
 * means to use an internal IdP adds its origin under Trusted origins on
 * purpose, as the plugin's own message says; on the Hosted instance only the
 * Instance organization may.
 */
const TRUST_CURES = new Set(['discovery_untrusted_origin']);

/**
 * The `code` on a refusal better-auth raised, or null. The code is what is
 * matched, never the English: `callAuthApi` carries better-auth's own code
 * across precisely so nothing downstream has to read its wording.
 */
function refusalCode(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const body: unknown = error.getResponse();
  if (!body || typeof body !== 'object') return null;
  const { code } = body as { code?: unknown };
  return typeof code === 'string' ? code : null;
}

/**
 * The origin to allowlist for an issuer. better-auth matches a trusted origin
 * by `pattern === new URL(url).origin`, so an issuer carrying a path — a
 * Keycloak realm, say — is trusted by its origin and not by itself.
 */
function originOf(issuer: string): string {
  try {
    return new URL(issuer).origin;
  } catch {
    return normalizeTrustedOrigin(issuer);
  }
}

/**
 * SSO provider management, the per-organization trusted-origin allowlist and
 * the two public sign-in-screen queries.
 */
@Injectable()
export class SsoService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly permissions: PermissionService,
    private readonly license: LicenseService,
    private readonly instanceMode: InstanceMode,
    private readonly addresses: SsoAddressPolicy,
  ) {}

  /**
   * The gate every read and every removal rides: an owner/admin caller, on any
   * plan (ADR-0054). Below the paid features the providers, the trusted
   * origins and the Proven domains are kept, so the SSO page shows them
   * read-only and lets them be removed, since leaving is always allowed.
   *
   * The role checked is the caller's role in the organization, not the admin
   * plugin's global user role, which on a self-hosted instance is always 'user'
   * (the settings/ai/custom-roles/forward-auth precedent).
   *
   * Public because `ProvenDomainsService` rides the same gates.
   */
  async ensureManager(ctx: PermissionCtx): Promise<void> {
    const memberRecord = await this.permissions.findMember(ctx);
    if (memberRecord.role !== 'owner' && memberRecord.role !== 'admin') {
      throw new ForbiddenException(
        'Only owners and admins can manage SSO providers',
      );
    }
  }

  /**
   * The gate for setting SSO up or changing it: {@link ensureManager} and an
   * organization holding a valid enterprise licence (the license key
   * Self-hosted, Business or Enterprise Hosted).
   */
  async ensureEnterprise(ctx: PermissionCtx): Promise<void> {
    await this.ensureManager(ctx);

    const licensed = await this.license.hasValidLicense(
      ctx.session.activeOrganizationId,
    );
    // The license key self-hosted, Business or Enterprise hosted.
    if (!licensed) throw paidFeatureRefusal(this.instanceMode);
  }

  /**
   * Public: whether the login screen offers an SSO button at all.
   *
   * Licences are kept per organization (phase 49), and the login screen has no
   * organization yet, so the question is whether any organization on this
   * instance holds a valid one.
   *
   * On the Hosted instance the question is narrower (ADR-0051): whether
   * any Organization on Business or Enterprise has SSO set up, meaning a
   * provider with a domain its Organization has proven. One that has not got
   * that far, or is on Starter, offers a button that could sign nobody in:
   * `/sign-in/sso` refuses it.
   */
  showSignInWithSso(): Promise<boolean> {
    if (this.instanceMode.isHosted) return anyBusinessSsoReady(this.db);
    return this.license.hasAnyValidLicense();
  }

  /** Public: the instance's `enforceSSO` flag; SSO is the only way in when set. */
  async enforceSso(): Promise<boolean> {
    const [row] = await this.db
      .select({ enforceSSO: webServerSettings.enforceSSO })
      .from(webServerSettings)
      .limit(1);
    return row?.enforceSSO ?? false;
  }

  /**
   * Registers a provider after checking none of its domains is claimed. The
   * plugin owns the write, so the row is created through its own API rather
   * than inserted here — that is what hydrates and shapes the stored
   * `oidcConfig` blob the callback later reads back.
   *
   * **Registration consults the trusted-origins list too, and that is the
   * plugin's doing rather than Cloudgate's**. Discovery runs inside
   * `registerSSOProvider`, and its first act is to refuse a discovery URL whose
   * origin `isTrustedOrigin` does not match — the same list the Trusted origins
   * card writes, since `auth.config.ts` resolves `trustedOrigins` from
   * `user.trustedOrigins`. On a fresh install that list is empty, so the first
   * provider an operator adds is refused by a check `assertIssuerTrusted` has
   * nothing to do with, in better-auth's wording, naming no move.
   *
   * So the refusal is caught and re-raised in the update path's voice, and
   * `trustIssuer` lets the dialog do the move in the same step: the origin is
   * added and the registration retried once. The write happens only on that
   * path — a provider whose origin is already trusted never touches the list —
   * and only after every Cloudgate check has passed. If the retry then fails on
   * the document itself the origin stays trusted, which is the honest reading:
   * the operator did ask for that host to be trusted, and the list is visible
   * on the same screen.
   */
  async register(
    ctx: PermissionCtx,
    headers: IncomingHttpHeaders,
    input: RegisterSsoProviderInput,
  ): Promise<{ success: true }> {
    await this.ensureEnterprise(ctx);
    const organizationId = ctx.session.activeOrganizationId;
    // Before the plugin fetches anything, and before `trustIssuer` could
    // trust the issuer's origin (ADR-0076).
    await this.addresses.assertPublicFor(
      organizationId,
      oidcProviderUrls(input.issuer, input.oidcConfig),
    );
    const domains = normalizeDomains(input.domains);
    await this.assertDomainsUnclaimed(domains);

    const { trustIssuer, ...body } = input;
    const send = () =>
      callAuthApi(() =>
        this.auth.api.registerSSOProvider({
          body: {
            ...body,
            organizationId: ctx.session.activeOrganizationId,
            domain: domains.join(','),
          },
          headers: toWebHeaders(headers),
        }),
      );

    try {
      await send();
    } catch (error) {
      const code = refusalCode(error);
      if (!code || !TRUST_CURES.has(code)) throw error;
      if (!trustIssuer) {
        throw new BadRequestException(
          `The Issuer URL is not in the organization's trusted origins list. ` +
            `Please add ${originOf(input.issuer)} under Trusted origins before ` +
            `registering, or tick "Trust this issuer" to add it as part of ` +
            `this registration.`,
        );
      }
      await this.addTrustedOrigin(ctx, originOf(input.issuer));
      await send();
    }
    await this.assertStoredEndpointsPublic(input.providerId, organizationId);
    return { success: true };
  }

  /**
   * The endpoints discovery stored, checked as the ones typed in were: a
   * discovery document is the customer's too, and may name a token or JWKS
   * endpoint on any origin the request trusted — this Cloudgate's own
   * included. A provider that fails is removed again, so nothing is left that
   * every sign-in would refuse (`auth.config.ts` asks the same at sign-in).
   */
  private async assertStoredEndpointsPublic(
    providerId: string,
    organizationId: string,
  ): Promise<void> {
    if (!(await this.addresses.mustBePublic(organizationId))) return;
    const [row] = await this.db
      .select({
        issuer: ssoProvider.issuer,
        oidcConfig: ssoProvider.oidcConfig,
      })
      .from(ssoProvider)
      .where(
        and(
          eq(ssoProvider.providerId, providerId),
          eq(ssoProvider.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) return;
    try {
      await this.addresses.assertPublicFor(
        organizationId,
        oidcProviderUrls(row.issuer, parseBlob(row.oidcConfig)),
      );
    } catch (error) {
      await this.db
        .delete(ssoProvider)
        .where(
          and(
            eq(ssoProvider.providerId, providerId),
            eq(ssoProvider.organizationId, organizationId),
          ),
        );
      throw error;
    }
  }

  /**
   * The redirect URI to register at the identity provider, with `{providerId}`
   * where the provider's id goes — the console fills it in as the id is typed,
   * before any provider exists to ask about.
   *
   * Both halves come from better-auth rather than from a string here: the base
   * is its own `baseURL` (`BETTER_AUTH_URL` plus `basePath`), and the path is
   * read off the callback endpoint the plugin serves, so the value cannot drift
   * from the URL the IdP is actually sent back to.
   */
  async getRedirectUri(ctx: PermissionCtx): Promise<{ template: string }> {
    await this.ensureManager(ctx);
    const { baseURL } = await this.auth.$context;
    const path = this.auth.api.callbackSSO.path.replace(
      ':providerId',
      '{providerId}',
    );
    return { template: `${baseURL}${path}` };
  }

  /**
   * The organization's trusted-origin allowlist. It lives on the organization
   * owner's user row rather than per-caller, so an admin edits the same list the
   * owner does.
   */
  async getTrustedOrigins(ctx: PermissionCtx): Promise<string[]> {
    await this.ensureManager(ctx);
    return this.readTrustedOrigins(ctx);
  }

  /** The stored list, without re-running the gate (internal callers). */
  private async readTrustedOrigins(ctx: PermissionCtx): Promise<string[]> {
    const ownerId = await this.organizationOwnerId(
      ctx.session.activeOrganizationId,
    );
    if (!ownerId) return [];
    const [row] = await this.db
      .select({ trustedOrigins: user.trustedOrigins })
      .from(user)
      .where(eq(user.id, ownerId))
      .limit(1);
    return row?.trustedOrigins ?? [];
  }

  /** Adds an origin; one already present (case-insensitively) is a no-op. */
  async addTrustedOrigin(
    ctx: PermissionCtx,
    origin: string,
  ): Promise<{ success: true }> {
    const normalized = normalizeTrustedOrigin(origin);
    return this.writeTrustedOrigins(
      ctx,
      (existing) =>
        existing.some((o) => o.toLowerCase() === normalized.toLowerCase())
          ? existing
          : [...existing, normalized],
      { adding: { origin: normalized } },
    );
  }

  /** Removes an origin, matched case-insensitively. */
  async removeTrustedOrigin(
    ctx: PermissionCtx,
    origin: string,
  ): Promise<{ success: true }> {
    const normalized = normalizeTrustedOrigin(origin);
    // Removing is always allowed, on any plan.
    return this.writeTrustedOrigins(
      ctx,
      (existing) =>
        existing.filter((o) => o.toLowerCase() !== normalized.toLowerCase()),
      { removing: true },
    );
  }

  /** Replaces an origin in place, keeping its position in the list. */
  async updateTrustedOrigin(
    ctx: PermissionCtx,
    oldOrigin: string,
    newOrigin: string,
  ): Promise<{ success: true }> {
    const from = normalizeTrustedOrigin(oldOrigin);
    const to = normalizeTrustedOrigin(newOrigin);
    return this.writeTrustedOrigins(
      ctx,
      (existing) =>
        existing.map((o) => (o.toLowerCase() === from.toLowerCase() ? to : o)),
      { adding: { newOrigin: to } },
    );
  }

  /**
   * The read-modify-write the three trusted-origin mutations share.
   *
   * @param adding the origin an add or a rename writes, keyed by its request
   *   field: on the Hosted instance a customer's must be a public address
   *   (ADR-0076), since the SSO plugin fetches a trusted origin without
   *   asking where it points. Asked after the gate, so a refused caller learns
   *   nothing about the address.
   */
  private async writeTrustedOrigins(
    ctx: PermissionCtx,
    next: (existing: string[]) => string[],
    {
      removing = false,
      adding,
    }: { removing?: boolean; adding?: Record<string, string> } = {},
  ): Promise<{ success: true }> {
    if (removing) await this.ensureManager(ctx);
    else await this.ensureEnterprise(ctx);
    if (adding) {
      await this.addresses.assertPublicFor(
        ctx.session.activeOrganizationId,
        adding,
      );
    }
    const ownerId = await this.organizationOwnerId(
      ctx.session.activeOrganizationId,
    );
    if (!ownerId) {
      throw new InternalServerErrorException('Organization owner not found');
    }
    const [row] = await this.db
      .select({ trustedOrigins: user.trustedOrigins })
      .from(user)
      .where(eq(user.id, ownerId))
      .limit(1);

    await this.db
      .update(user)
      .set({
        trustedOrigins: Array.from(new Set(next(row?.trustedOrigins ?? []))),
      })
      .where(eq(user.id, ownerId));
    return { success: true };
  }

  /** The organization's owner's user id, or null when it is not found. */
  private async organizationOwnerId(
    organizationId: string,
  ): Promise<string | null> {
    const [org] = await this.db
      .select({ ownerId: organization.ownerId })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    return org?.ownerId ?? null;
  }

  /**
   * The issuer-change guard. Moving a provider to a new issuer means the
   * plugin will start fetching that host, so the operator has to have
   * allowlisted it first — an unchanged issuer needs no such proof.
   */
  private async assertIssuerTrusted(
    ctx: PermissionCtx,
    currentIssuer: string,
    nextIssuer: string,
  ): Promise<void> {
    const next = normalizeTrustedOrigin(nextIssuer);
    if (normalizeTrustedOrigin(currentIssuer) === next) return;

    const ownerId = await this.organizationOwnerId(
      ctx.session.activeOrganizationId,
    );
    if (!ownerId) {
      throw new InternalServerErrorException('Organization owner not found');
    }

    const trusted = await this.readTrustedOrigins(ctx);
    if (!trusted.some((o) => o.toLowerCase() === next.toLowerCase())) {
      throw new BadRequestException(
        "The new Issuer URL is not in the organization's trusted origins list. Please add it under Trusted origins before saving.",
      );
    }
  }

  /** The org's provider row, or null — the shared lookup behind every mutation. */
  private async findRow(providerId: string, organizationId: string) {
    const [row] = await this.db
      .select({
        id: ssoProvider.id,
        issuer: ssoProvider.issuer,
        domain: ssoProvider.domain,
        userId: ssoProvider.userId,
      })
      .from(ssoProvider)
      .where(
        and(
          eq(ssoProvider.providerId, providerId),
          eq(ssoProvider.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The domain collision check, shared by register and update. It scans every
   * row rather than the caller's organization, because an email domain resolves
   * to exactly one provider instance-wide, so one another tenant already claims
   * is taken.
   *
   * @param exceptProviderId the provider being updated, which keeps its own
   *   domains.
   */
  private async assertDomainsUnclaimed(
    domains: string[],
    exceptProviderId?: string,
  ): Promise<void> {
    const providers = await this.db
      .select({
        providerId: ssoProvider.providerId,
        domain: ssoProvider.domain,
      })
      .from(ssoProvider);

    for (const provider of providers) {
      if (provider.providerId === exceptProviderId) continue;
      const claimed = parseDomainList(provider.domain);
      for (const domain of domains) {
        if (claimed.includes(domain)) {
          throw new BadRequestException(
            `Domain ${domain} is already registered for another provider`,
          );
        }
      }
    }
  }

  /**
   * Updates a provider's issuer, domains and OIDC config. The plugin owns the
   * write for the same reason register does — it merges the incoming OIDC
   * config over the stored one rather than replacing it wholesale.
   */
  async update(
    ctx: PermissionCtx,
    headers: IncomingHttpHeaders,
    input: RegisterSsoProviderInput,
  ): Promise<{ success: true }> {
    await this.ensureEnterprise(ctx);
    const existing = await this.findRow(
      input.providerId,
      ctx.session.activeOrganizationId,
    );
    if (!existing) {
      throw new NotFoundException(
        'SSO provider not found or you do not have permission to update it',
      );
    }

    const domains = normalizeDomains(input.domains);
    // Scanned globally, as register does: an update scoped to the caller's
    // organization could claim a domain another tenant's provider already
    // holds, which register would have refused.
    await this.assertDomainsUnclaimed(domains, input.providerId);
    await this.assertIssuerTrusted(ctx, existing.issuer, input.issuer);
    await this.addresses.assertPublicFor(
      ctx.session.activeOrganizationId,
      oidcProviderUrls(input.issuer, input.oidcConfig),
    );

    // The row is re-pointed at the current actor before the write, so the
    // plugin's own ownership check resolves against whoever is editing it. That
    // happens only after every check that can fail, so a refused update never
    // reassigns the row (the custom-roles precedent).
    if (existing.userId !== ctx.user.id) {
      await this.db
        .update(ssoProvider)
        .set({ userId: ctx.user.id })
        .where(eq(ssoProvider.id, existing.id));
    }

    await callAuthApi(() =>
      this.auth.api.updateSSOProvider({
        body: {
          providerId: input.providerId,
          issuer: input.issuer,
          domain: domains.join(','),
          ...(input.oidcConfig ? { oidcConfig: input.oidcConfig } : {}),
        },
        headers: toWebHeaders(headers),
      }),
    );
    return { success: true };
  }

  /**
   * Deletes a provider by dropping the row directly rather than going through
   * the plugin, whose own delete-provider endpoint would also cascade the
   * linked `account` rows; this leaves them in place.
   */
  async remove(
    ctx: PermissionCtx,
    providerId: string,
  ): Promise<{ success: true }> {
    await this.ensureManager(ctx);
    const deleted = await this.db
      .delete(ssoProvider)
      .where(
        and(
          eq(ssoProvider.providerId, providerId),
          eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .returning({ id: ssoProvider.id });

    if (deleted.length === 0) {
      throw new NotFoundException(
        'SSO provider not found or you do not have permission to delete it',
      );
    }
    return { success: true };
  }

  /** The organization's providers, oldest first. */
  async listProviders(ctx: PermissionCtx): Promise<SanitizedSsoProvider[]> {
    await this.ensureManager(ctx);
    const rows = await this.db
      .select(providerColumns)
      .from(ssoProvider)
      .where(eq(ssoProvider.organizationId, ctx.session.activeOrganizationId))
      .orderBy(asc(ssoProvider.createdAt));
    return rows.map(sanitizeProvider);
  }

  /** One provider; a provider in another organization reads as absent. */
  async findOne(
    ctx: PermissionCtx,
    providerId: string,
  ): Promise<SanitizedSsoProvider> {
    await this.ensureManager(ctx);
    const [provider] = await this.db
      .select(providerColumns)
      .from(ssoProvider)
      .where(
        and(
          eq(ssoProvider.providerId, providerId),
          eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
        ),
      )
      .limit(1);

    if (!provider) {
      throw new NotFoundException(
        'SSO provider not found or you do not have permission to access it',
      );
    }
    return sanitizeProvider(provider);
  }
}
