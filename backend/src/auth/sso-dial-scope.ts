import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { SsoAddressPolicy } from '../enterprise/sso/sso-addresses';
import {
  organizationOfProvider,
  organizationRoutedTo,
} from '../enterprise/sso/sso-sign-in';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { OutboundAddressGuard } from '../outbound/outbound-address-guard';
import { ssoOrganizationOfRequest } from './trusted-origin-scope';
import type { SsoRequestLookups } from './trusted-origin-scope';

/** Where `AuthController` mounts better-auth, which every path here starts with. */
const AUTH_BASE = '/api/auth';

/**
 * The better-auth route of `path` when it is one the SSO plugin may dial from
 * (`/sign-in/sso` and every `/sso/*` route), otherwise `null`.
 */
export function ssoRouteOf(path: string): string | null {
  if (!path.startsWith(`${AUTH_BASE}/`)) return null;
  const route = path.slice(AUTH_BASE.length);
  return route === '/sign-in/sso' || route.startsWith('/sso/') ? route : null;
}

/**
 * Whether an `/api/auth` request's own dials must reach public addresses
 * only: on the Hosted instance, an SSO route acting for any Organization but
 * the Instance organization (ADR-0076). A route whose Organization cannot be
 * told is guarded, since guarding only refuses a non-public address and a
 * customer's public IdP answers either way.
 *
 * A `:providerId` route names its provider as its last path segment (the OIDC
 * callback, the SAML ACS, callback and logout), which is what
 * {@link ssoOrganizationOfRequest} reads it as.
 */
export async function ssoDialsMustBePublic(
  request: { path: string; body: unknown },
  deps: {
    hosted: boolean;
    lookups: SsoRequestLookups;
    mustBePublic: (organizationId: string | null) => Promise<boolean>;
  },
): Promise<boolean> {
  if (!deps.hosted) return false;
  const route = ssoRouteOf(request.path);
  if (route === null) return false;
  const providerId = route.split('/').filter(Boolean).pop();
  const organizationId = await ssoOrganizationOfRequest(
    { path: route, params: { providerId }, body: request.body },
    deps.lookups,
  );
  return deps.mustBePublic(organizationId);
}

/**
 * Runs an `/api/auth` request with the SSO plugin's own fetches guarded when
 * {@link ssoDialsMustBePublic} says so. The plugin takes no fetch of ours, so
 * an address check before it runs leaves the window between that lookup and
 * the plugin's own; inside {@link OutboundAddressGuard.runWithGuardedFetch}
 * its connections dial the address that was checked, and redirects are
 * checked again.
 */
@Injectable()
export class SsoDialScope {
  constructor(
    private readonly instanceMode: InstanceMode,
    private readonly ssoAddresses: SsoAddressPolicy,
    private readonly guard: OutboundAddressGuard,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
  ) {}

  async run<T>(
    request: { path: string; body: unknown },
    work: () => Promise<T>,
  ): Promise<T> {
    const guarded = await ssoDialsMustBePublic(request, {
      hosted: this.instanceMode.isHosted,
      lookups: {
        organizationOfProvider: (providerId) =>
          organizationOfProvider(this.db, providerId),
        organizationRoutedTo: (body) => organizationRoutedTo(this.db, body),
      },
      mustBePublic: (organizationId) =>
        this.ssoAddresses.mustBePublic(organizationId),
    });
    return guarded ? this.guard.runWithGuardedFetch(work) : work();
  }
}
