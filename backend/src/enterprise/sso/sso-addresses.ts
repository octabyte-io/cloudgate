import { Inject, Injectable } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import {
  OUTBOUND_ADDRESS_REFUSED_CODE,
  outboundAddressRefused,
} from '../../outbound/outbound-address-guard';
import {
  ADDRESS_RESOLVER,
  publicAddressOf,
} from '../../outbound/outbound-address';
import type { AddressResolver } from '../../outbound/outbound-address';
import { PermissionService } from '../../rbac/permission.service';

/**
 * Where the SSO plugin may have the platform host dial, on the Hosted
 * instance (ADR-0076).
 *
 * `@better-auth/sso` fetches an OIDC provider's discovery document at
 * registration, and its token, userinfo and JWKS endpoints at every sign-in,
 * from the platform host. Its own check refuses a non-public endpoint *unless
 * the endpoint's origin is trusted*, and a trusted origin is something an
 * Organization owner adds. So on the Hosted instance, where every customer is
 * a stranger, a customer who trusted `http://169.254.169.254` had the box
 * fetch its metadata service and read the answer back through the plugin's
 * distinct discovery error codes.
 *
 * The plugin takes no fetch of its own (1.6.33: `betterFetch`, `fetch` and
 * jose's `createRemoteJWKSet`, each called directly), so these fetches cannot
 * ride `OutboundAddressGuard.fetchFor`. What closes it instead, using the same
 * address rule (`publicAddressOf`) and the same exemption as that guard:
 *
 * - an issuer, an endpoint or a trusted origin that is not a public address is
 *   refused when it is saved, and a `discovery_private_host` refusal is never
 *   cured by trusting the origin (`SsoService`);
 * - the provider's stored URLs are checked again at `POST /sign-in/sso` and at
 *   the callback, before the plugin fetches them, so a name whose records
 *   changed after it was saved is refused too (`auth.config.ts`).
 *
 * Every one of the plugin's server-side fetches refuses redirects, so a public
 * endpoint cannot bounce the box inward. What is left is the moment between
 * this check's lookup and the plugin's own, which a name with a very short TTL
 * could use; closing that needs the plugin to accept a fetch.
 */

/** The OIDC settings whose URLs the platform host may fetch, plus the browser one. */
const OIDC_URL_FIELDS = [
  'discoveryEndpoint',
  'authorizationEndpoint',
  'tokenEndpoint',
  'userInfoEndpoint',
  'jwksEndpoint',
] as const;

/**
 * Every URL of an OIDC provider, keyed by the request field it is set in:
 * the issuer (discovery is fetched from it) and each endpoint present.
 * `authorizationEndpoint` is a browser redirect, not a fetch, and is in the
 * list anyway: an identity provider a stranger may use is on the internet.
 */
export function oidcProviderUrls(
  issuer: string,
  oidcConfig: object | null | undefined,
): Record<string, string> {
  const urls: Record<string, string> = { issuer };
  for (const field of OIDC_URL_FIELDS) {
    const value = (oidcConfig as Record<string, unknown> | null | undefined)?.[
      field
    ];
    if (typeof value === 'string' && value !== '') {
      urls[`oidcConfig.${field}`] = value;
    }
  }
  return urls;
}

/**
 * The address half of the rule, as `auth.config.ts`'s hooks are handed it:
 * they run outside the Nest container, so they take this slice.
 */
export interface SsoAddressCheck {
  /** The Instance organization's id (ADR-0013), or null with no owner yet. */
  instanceOrganizationId(): Promise<string | null>;
  /** Whether `organizationId`'s SSO URLs and trusted origins must be public. */
  mustBePublic(organizationId: string | null | undefined): Promise<boolean>;
  /** The field of the first URL that is not a public address, or null. */
  firstNonPublic(urls: Record<string, string>): Promise<string | null>;
}

@Injectable()
export class SsoAddressPolicy implements SsoAddressCheck {
  constructor(
    @Inject(ADDRESS_RESOLVER) private readonly resolve: AddressResolver,
    private readonly instanceMode: InstanceMode,
    private readonly permissions: PermissionService,
  ) {}

  instanceOrganizationId(): Promise<string | null> {
    return this.permissions.instanceOrganizationId();
  }

  /**
   * On the Hosted instance, every Organization but the Instance organization —
   * `OutboundAddressGuard`'s exemption (ADR-0013): Octabyte's own staff
   * already have a shell on the box. A Self-hosted instance is unchanged: one
   * operator owns every Organization there, and pointing SSO at an internal
   * IdP is the reason the plugin's allowlist exists. No Organization at all is
   * nobody's, and nobody is exempt.
   */
  async mustBePublic(
    organizationId: string | null | undefined,
  ): Promise<boolean> {
    if (!this.instanceMode.isHosted) return false;
    if (!organizationId) return true;
    return organizationId !== (await this.instanceOrganizationId());
  }

  /**
   * Fails closed: a value that does not parse as a URL, or whose name does not
   * resolve, is one this cannot vouch for. A trusted origin may carry a
   * wildcard, which does not resolve and so is refused too.
   */
  async firstNonPublic(urls: Record<string, string>): Promise<string | null> {
    for (const [field, value] of Object.entries(urls)) {
      let hostname: string;
      try {
        hostname = new URL(value).hostname;
      } catch {
        return field;
      }
      if (!hostname) return field;
      if ((await publicAddressOf(hostname, this.resolve)) === null) {
        return field;
      }
    }
    return null;
  }

  /**
   * Throws `outboundAddressRefused` naming the first non-public URL's field,
   * when `organizationId`'s URLs must be public.
   */
  async assertPublicFor(
    organizationId: string | null | undefined,
    urls: Record<string, string>,
  ): Promise<void> {
    if (!(await this.mustBePublic(organizationId))) return;
    const field = await this.firstNonPublic(urls);
    if (field !== null) throw outboundAddressRefused(field);
  }
}

/** A stored OIDC blob, or null when it is absent or not a JSON object. */
function parseOidcConfig(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The check again at sign-in, from better-auth's `before` hook, on the
 * provider `POST /sign-in/sso` routes to or the callback names, before the
 * plugin fetches anything of it: discovery, token, userinfo, JWKS. It reads
 * the stored row, so a URL saved before this rule existed, an endpoint a
 * discovery document handed over, and a name whose records changed since are
 * all refused here. A SAML provider, and a body that routes to no provider,
 * have nothing fetched and pass.
 *
 * Better-auth's `APIError` with `OutboundAddressGuard`'s code and sentence,
 * since the refusal is the same one.
 */
export async function refuseNonPublicOidcProvider(
  check: SsoAddressCheck,
  provider:
    | {
        organizationId: string | null;
        issuer: string;
        oidcConfig: string | null;
      }
    | null
    | undefined,
): Promise<void> {
  if (!provider?.oidcConfig) return;
  if (!(await check.mustBePublic(provider.organizationId))) return;
  const field = await check.firstNonPublic(
    oidcProviderUrls(provider.issuer, parseOidcConfig(provider.oidcConfig)),
  );
  if (field === null) return;
  const { message } = outboundAddressRefused(field).getResponse() as {
    message: string;
  };
  throw new APIError('BAD_REQUEST', {
    code: OUTBOUND_ADDRESS_REFUSED_CODE,
    message,
  });
}
