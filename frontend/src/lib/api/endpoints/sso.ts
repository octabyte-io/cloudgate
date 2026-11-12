import { api } from "../client";

/**
 * `enterprise/sso/sso.controller.ts` — the identity providers this Organization
 * signs in through, whether password sign-in is still allowed, and the origins
 * an issuer may be moved to.
 *
 * **Two of these routes are public and the rest are licensed.** F06 opened this
 * module with the two `@Public()` reads the sign-in screen makes before anyone
 * has a session, and they are unchanged below. **F18 fills in the rest**, all of
 * which runs `ensureEnterprise`: owner or admin **and** a valid licence, so on
 * an unlicensed instance the provider list is a
 * `403 Valid enterprise license required` and not an empty array. That is what
 * `LicenseGate` exists to keep off the screen.
 *
 * `PATCH /sso/enforce` is the odd one: it is on this controller but delegates to
 * `SettingsService.updateEnforceSso`, which is **owner-or-admin with no licence
 * check**. So enforcement can be turned on without a licence, and there would
 * then be no provider to sign in with. The screen refuses to offer it in that
 * state, and says why.
 *
 * ## The client secret is deleted here, not merely undeclared
 *
 * `GET /sso/providers` returns the decrypted `oidcConfig` blob whole, client
 * secret included.
 * Declaring a narrower type would not help: TanStack caches whatever the
 * response parsed to, so the secret would sit in the query cache and in every
 * devtools panel over it. `parseOidcConfig` therefore **drops the field at the
 * client boundary** and hands on `hasClientSecret` — F16's answer to
 * the same leak.
 * `samlConfig` goes the same way and is not surfaced at all: nothing in this
 * console edits SAML, and the blob is signing material.
 *
 * A consequence the edit form has to state: **`oidcConfig` is all-or-nothing on
 * the way back in.** `ssoProviderBodySchema` types `clientSecret` as required
 * *within* `oidcConfig`, and `oidcConfig` itself as optional — so an update can
 * either omit the OIDC block entirely (keeping every stored value) or resend it
 * complete. There is no way to change the client id without also retyping the
 * secret.
 *
 * ## Two things the plugin does to what you send
 *
 * Driven against a real registration: `skipDiscovery: true` **is dropped** — the
 * stored blob has no such key and carries a `discoveryEndpoint` derived from the
 * issuer instead. And `domains` is stored **comma-joined into one `domain`
 * column**, so it comes back as a string and is split here.
 *
 * ## The redirect URI is the backend's to say
 *
 * `GET /sso/redirect-uri` answers with a template holding `{providerId}`, built
 * from better-auth's own base URL (`BETTER_AUTH_URL` plus its base path) and the
 * path of the callback endpoint the SSO plugin serves. Neither half is knowable
 * here: an install reached through a domain would get a different answer out of
 * `window.location` than the one the identity provider is actually sent back to.
 */

/** What `oidcConfig` holds, minus the secret this client refuses to carry. */
export interface SsoOidcConfigView {
  clientId: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
  tokenEndpointAuthentication?: "client_secret_post" | "client_secret_basic";
  jwksEndpoint?: string;
  discoveryEndpoint?: string;
  scopes?: string[];
  pkce?: boolean;
}

/** A provider as the console holds it — never with a secret in it. */
export interface SsoProvider {
  id: string;
  providerId: string;
  issuer: string;
  /** Split from the stored comma-joined `domain` column. */
  domains: string[];
  organizationId: string | null;
  oidcConfig: SsoOidcConfigView | null;
  /** Derived. The value itself is dropped before this object exists. */
  hasClientSecret: boolean;
  /** Whether a SAML blob is stored. Its contents are never read. */
  hasSamlConfig: boolean;
}

/** `ssoProviderBodySchema.oidcConfig` — what a save has to send. */
export interface SsoOidcConfigInput {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
  tokenEndpointAuthentication?: "client_secret_post" | "client_secret_basic";
  jwksEndpoint?: string;
  discoveryEndpoint?: string;
  scopes?: string[];
  pkce?: boolean;
}

export interface SsoProviderInput {
  providerId: string;
  issuer: string;
  domains: string[];
  oidcConfig?: SsoOidcConfigInput;
  /**
   * Registration only. Adds the issuer's origin to the Organization's trusted
   * origins when the plugin refuses to reach it without that
   * — an update's
   * issuer change is gated separately and takes no such flag.
   */
  trustIssuer?: boolean;
}

/** The raw row, before the secret is taken out of it. Not exported. */
interface RawSsoProvider {
  id: string;
  providerId: string;
  issuer: string;
  domain: string;
  oidcConfig: string | null;
  samlConfig: string | null;
  organizationId: string | null;
  /** Sent by the server, which projects `clientSecret` out of the blob. */
  hasClientSecret?: boolean;
}

/**
 * Take the row apart and leave the secret behind.
 *
 * The blob is a **JSON string**, so a provider written by something other than
 * the plugin could hold anything; a parse failure yields no config rather than
 * throwing, because one malformed row must not take the provider list with it.
 */
function toProvider(row: RawSsoProvider): SsoProvider {
  let parsed: Record<string, unknown> | null = null;
  if (row.oidcConfig) {
    try {
      const value: unknown = JSON.parse(row.oidcConfig);
      if (value && typeof value === "object") {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
  }

  // The server strips `clientSecret` from the blob and reports it separately
  // so the flag is read from the row. Deriving it from the blob is the
  // fallback for a backend that predates that fix.
  const hasClientSecret =
    typeof row.hasClientSecret === "boolean"
      ? row.hasClientSecret
      : typeof parsed?.clientSecret === "string" &&
        parsed.clientSecret.length > 0;

  const oidcConfig: SsoOidcConfigView | null = parsed
    ? {
        clientId: typeof parsed.clientId === "string" ? parsed.clientId : "",
        authorizationEndpoint: asString(parsed.authorizationEndpoint),
        tokenEndpoint: asString(parsed.tokenEndpoint),
        userInfoEndpoint: asString(parsed.userInfoEndpoint),
        tokenEndpointAuthentication:
          parsed.tokenEndpointAuthentication === "client_secret_post" ||
          parsed.tokenEndpointAuthentication === "client_secret_basic"
            ? parsed.tokenEndpointAuthentication
            : undefined,
        jwksEndpoint: asString(parsed.jwksEndpoint),
        discoveryEndpoint: asString(parsed.discoveryEndpoint),
        scopes: Array.isArray(parsed.scopes)
          ? parsed.scopes.filter(
              (scope): scope is string => typeof scope === "string",
            )
          : undefined,
        pkce: typeof parsed.pkce === "boolean" ? parsed.pkce : undefined,
      }
    : null;

  return {
    id: row.id,
    providerId: row.providerId,
    issuer: row.issuer,
    domains: row.domain
      .split(",")
      .map((domain) => domain.trim())
      .filter(Boolean),
    organizationId: row.organizationId,
    oidcConfig,
    hasClientSecret,
    hasSamlConfig: !!row.samlConfig,
  };
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * The redirect URI for one provider id. The substitution is the console's only
 * share of this value — the URI itself, base path and callback path both, comes
 * from the backend.
 */
export const redirectUriFor = (template: string, providerId: string): string =>
  template.replace("{providerId}", providerId);

/**
 * Whether the sign-in screen offers SSO. **F06's, unchanged.**
 *
 * A Self-hosted backend answers this from `hasAnyValidLicense()`, not from
 * whether a provider is configured — so an unlicensed instance returns `false`
 * and the button never appears. The Hosted instance answers whether any
 * Enterprise Organization has SSO set up: a provider with a Proven domain
 * (ADR-0051). Either way the console only follows the flag: it is
 * correct behaviour and not a bug to route around, since `POST /sign-in/sso`
 * would refuse anyway.
 */
export function showSsoSignIn(signal?: AbortSignal) {
  return api.get<{ enabled: boolean }>("/sso/show-sign-in", { signal });
}

/**
 * Whether SSO is the **only** way in. **F06's, unchanged.**
 *
 * When true the password form is not rendered — not disabled, not hidden behind a
 * toggle. An organization that has turned this on has decided passwords are not
 * an option here, and a form that is present but refused is an invitation to
 * doubt your own password.
 */
export function enforceSso(signal?: AbortSignal) {
  return api.get<{ enforced: boolean }>("/sso/enforce", { signal });
}

/**
 * A Proven domain (ADR-0051), Hosted only: an email domain this
 * Organization shows it owns by publishing `record` in its DNS. Until it is
 * proven, no SSO provider of this Organization routes or accepts a sign-in for
 * an address in it.
 */
export interface ProvenDomain {
  domain: string;
  proven: boolean;
  provenAt: string | null;
  createdAt: string;
  record: { type: "TXT"; name: string; value: string };
}

export const ssoApi = {
  /**
   * `PATCH /sso/enforce`. Owner-or-admin, **no licence check** — see above.
   */
  setEnforce: (enforceSSO: boolean) =>
    api.patch<unknown>("/sso/enforce", { enforceSSO }),

  list: () =>
    api
      .get<RawSsoProvider[]>("/sso/providers")
      .then((rows) => rows.map(toProvider)),

  register: (input: SsoProviderInput) =>
    api.post<{ success: true }>("/sso/providers", input),

  /** `PUT /sso/providers/:providerId`. The id in the path cannot change. */
  update: (providerId: string, input: SsoProviderInput) =>
    api.put<{ success: true }>(
      `/sso/providers/${encodeURIComponent(providerId)}`,
      input,
    ),

  remove: (providerId: string) =>
    api.delete<{ success: true }>(
      `/sso/providers/${encodeURIComponent(providerId)}`,
    ),

  /** `GET /sso/redirect-uri`. The template, `{providerId}` and all. */
  redirectUri: () =>
    api.get<{ template: string }>("/sso/redirect-uri").then((r) => r.template),

  trustedOrigins: () => api.get<string[]>("/sso/trusted-origins"),

  addTrustedOrigin: (origin: string) =>
    api.post<{ success: true }>("/sso/trusted-origins", { origin }),

  updateTrustedOrigin: (oldOrigin: string, newOrigin: string) =>
    api.put<{ success: true }>("/sso/trusted-origins", {
      oldOrigin,
      newOrigin,
    }),

  /**
   * `DELETE /sso/trusted-origins` takes a **body**, which no other delete in
   * this app does — `api.delete` has no body parameter, so this one goes
   * through `request` directly.
   */
  removeTrustedOrigin: (origin: string) =>
    api.deleteWithBody<{ success: true }>("/sso/trusted-origins", { origin }),

  /** `GET /sso/proven-domains`. Hosted only; 404 on a Self-hosted instance. */
  provenDomains: () => api.get<ProvenDomain[]>("/sso/proven-domains"),

  /** Issues the TXT challenge; adding one already listed returns it as is. */
  addProvenDomain: (domain: string) =>
    api.post<ProvenDomain>("/sso/proven-domains", { domain }),

  /** Looks the record up now. Not finding it is an answer, not an error. */
  checkProvenDomain: (domain: string) =>
    api.post<ProvenDomain>(
      `/sso/proven-domains/${encodeURIComponent(domain)}/check`,
    ),

  removeProvenDomain: (domain: string) =>
    api.delete<{ success: true }>(
      `/sso/proven-domains/${encodeURIComponent(domain)}`,
    ),
};
