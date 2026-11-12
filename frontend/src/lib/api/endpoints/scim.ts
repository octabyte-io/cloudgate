import { api } from "../client";

/**
 * `enterprise/scim/scim.controller.ts` — the identity providers allowed to
 * create, rename and deactivate members of this Organization for you.
 *
 * Three routes, all owner or admin. Only creating a provider also asks for the
 * paid features (a valid licence, or Business on the Hosted instance); listing
 * and removing stay open below them, so the SSO page shows what is
 * kept read-only.
 *
 * ## The token is handed over once and never again
 *
 * `POST /scim/providers` answers `{ scimToken, providerId }` and **that is the
 * only time the value exists in a readable form**. `listProviders` projects to
 * `{ id, providerId, organizationId }` — the token column is deliberately
 * absent, and it is `encryptedText` besides. Nothing regenerates one: the only
 * way to replace a token is to delete the provider and create it again, which
 * revokes the old one.
 *
 * So the create dialog owes the same treatment F16 gave an API key and an
 * invitation link: the token is the dialog's **second state**, with copy, and
 * the screen says plainly that closing it loses the value.
 *
 * ## What the identity provider needs, and where it comes from
 *
 * The IdP-facing half of SCIM is **not on this controller**. It is better-auth's
 * own `/api/auth/scim/v2/*` surface, authenticated by the bearer token rather
 * than by a session (`auth.config.ts`). `SCIM_BASE_PATH` below is that path, and
 * the screen builds the absolute URL from `window.location.origin` rather than
 * from a configured value: this app's origin *is* `BETTER_AUTH_URL` (see
 * `lib/config.ts`), so the URL a browser is looking at is the URL the plugin
 * serves on.
 *
 * ## `providerId` is not cosmetic
 *
 * `providerIdSchema` is `^[a-z0-9][a-z0-9-]*$`, max 64. The value is packed into
 * the bearer token between colon separators — which is why a colon is refused
 * outright — and becomes the `account.providerId` every provisioned user is
 * linked by. Renaming it later is not possible; there is no update route.
 *
 * The uniqueness check is **instance-wide**, not per Organization: `generateToken`
 * scans every row before calling the plugin, because the plugin's own
 * generate-token *replaces* a colliding row and would silently revoke a token an
 * identity provider is already provisioning with. So "A SCIM provider with this
 * ID already exists" can be about somebody else's Organization, and the dialog
 * says the id has to be unique across the instance rather than blaming the
 * reader's own list.
 */

/** The path better-auth's SCIM plugin serves the identity provider on. */
export const SCIM_BASE_PATH = "/api/auth/scim/v2";

/** A provider as `GET /scim/providers` lists it. No token, by projection. */
export interface ScimProvider {
  id: string;
  providerId: string;
  organizationId: string | null;
  /**
   * The last create or reactivation this provider pushed that was refused
   * because the Organization was below the paid features: when, as an
   * ISO time, and for which address. Both null when none was.
   */
  lastRefusedAddAt: string | null;
  lastRefusedAddEmail: string | null;
}

/** The one moment the token is readable. */
export interface ScimTokenIssued {
  scimToken: string;
  providerId: string;
}

export const scimApi = {
  list: () => api.get<ScimProvider[]>("/scim/providers"),

  create: (providerId: string) =>
    api.post<ScimTokenIssued>("/scim/providers", { providerId }),

  remove: (providerId: string) =>
    api.delete<{ success: true }>(
      `/scim/providers/${encodeURIComponent(providerId)}`,
    ),
};
