import { api } from "../client";

import type { CertificateType } from "./domains";

/**
 * A forward-auth target's certificate choices: a Domain's, less `stored`
 * which `setForwardAuthSettingsSchema` does not take.
 */
export type AuthCertificateType = Exclude<CertificateType, "stored">;
import type { UnreclaimedArtifact } from "./teardown";

/**
 * `enterprise/forward-auth/forward-auth.controller.ts` — putting an
 * oauth2-proxy in front of an Application's domain, so Traefik makes the
 * request prove who it is before the Application ever sees it.
 *
 * ## Two halves with two different gates, and the split is the design
 *
 * The **server-level** routes (settings, providers, servers, proxy) run
 * `ensureEnterprise`: owner or admin plus a valid licence. The **per-domain**
 * routes (`domains/:domainId`, `enable`, `disable`) deliberately do not — they
 * ride `domain` permission plus row-level service access, so a member with domain
 * rights goes on managing gates after the owner has stood the proxy up.
 *
 * So `LicenseGate` wraps the settings screen and **not** the per-domain switch.
 * The switch is refused for a different reason when there is no proxy, and it is
 * a `412` with a sentence naming what to do:
 *
 * - "Set the authentication domain for this server before deploying the proxy."
 * - "Deploy the authentication proxy for this server in SSO settings first."
 *
 * Those are `PreconditionFailedException`s, and F02's status rules have no
 * sentence for a 412, so the message is what gets shown — which is right, since
 * the backend's own wording names the screen to go to.
 *
 * ## `GET /settings` answers with **no body** when there is nothing
 *
 * `getAuthDomain` returns `null` for a target with no settings row, and Nest
 * sends that as `content-length: 0`. `readJson` yields `undefined` for an empty
 * body and **TanStack refuses a query that resolves to `undefined`** — so the
 * read below normalises to `null` explicitly. Driven: `HTTP/1.1 200 OK` with
 * `content-length: 0`.
 *
 * ## What `GET /servers` is really listing
 *
 * Not the fleet. One entry per **Traefik instance** this Organization could gate:
 * the local one (`serverId: null`, named "Cloudgate Server (local)") plus every
 * `deploy` server with an SSH key. `null` is a real target, not a missing value,
 * which is why every route here takes `serverId` as nullable and the query keys
 * carry it.
 *
 * Its fallbacks are not the column defaults: a target with no
 * settings row reads `https: true, certificateType: 'none'` so the form opens
 * unconfigured rather than pre-picking Let's Encrypt.
 *
 * `status` is a **probe**, capped at four seconds, and `unknown` means the probe
 * failed or timed out — an unreachable server, not a stopped proxy. Three states,
 * three sentences.
 *
 * ## Only OIDC, and only Applications
 *
 * `GET /providers` lists the Organization's SSO providers **that have an
 * `oidcConfig`** — oauth2-proxy speaks OIDC only, so a SAML provider cannot
 * front a gate and is filtered out at the source rather than offered and
 * refused. And `findApplicationDomain` refuses a Compose domain outright ("SSO
 * forward-auth is currently only supported on application domains"), because a
 * Compose router travels as deploy-time labels which carry no middleware.
 */

/** One Traefik instance, as `GET /forward-auth/servers` reports it. */
export interface ForwardAuthTarget {
  /** `null` is the local server, and is a real target. */
  serverId: string | null;
  name: string;
  ipAddress: string | null;
  /**
   * `failing` is a deployed service with no replica running — still a
   * proxy to remove. `unknown` means the probe failed or timed out, not that it
   * is stopped.
   */
  status: "running" | "failing" | "stopped" | "unknown";
  /** The failing proxy's last task error, or why the probe gave up. */
  message: string | null;
  authDomain: string | null;
  https: boolean;
  certificateType: AuthCertificateType;
  customCertResolver: string | null;
  callbackUrl: string | null;
}

/** `GET /forward-auth/settings` — `null` when the target has no row. */
export interface AuthDomainView {
  host: string;
  https: boolean;
  certificateType: AuthCertificateType;
  customCertResolver: string | null;
  callbackUrl: string;
}

export interface SetAuthDomainInput {
  serverId: string | null;
  authDomain: string;
  https: boolean;
  certificateType: AuthCertificateType;
  customCertResolver?: string | null;
}

/** An identity provider a proxy can be deployed for — OIDC ones only. */
export interface ForwardAuthProvider {
  providerId: string;
  issuer: string;
  /** The stored comma-joined column, unsplit — this route does not project. */
  domain: string;
}

export const forwardAuthApi = {
  /**
   * The target's auth domain, or `null`. The `?? null` is load-bearing: an
   * empty 200 body parses to `undefined` and TanStack throws on it.
   */
  settings: (serverId: string | null) =>
    api
      .get<AuthDomainView | undefined>("/forward-auth/settings", {
        query: { serverId },
      })
      .then((view) => view ?? null),

  setSettings: (input: SetAuthDomainInput) =>
    api.put<{ callbackUrl: string }>("/forward-auth/settings", input),

  removeSettings: (serverId: string | null) =>
    api.delete<{ ok: true }>("/forward-auth/settings", { query: { serverId } }),

  providers: () => api.get<ForwardAuthProvider[]>("/forward-auth/providers"),

  targets: () => api.get<ForwardAuthTarget[]>("/forward-auth/servers"),

  deployProxy: (serverId: string | null, providerId: string) =>
    api.post<{ ok: true }>("/forward-auth/proxy", { serverId, providerId }),

  /**
   * `unreclaimedArtifacts` is present only when the proxy's /oauth2 router
   * could not be removed from its machine — the teardown shape, absent
   * rather than empty on a clean removal.
   */
  removeProxy: (serverId: string | null) =>
    api.delete<{ ok: true; unreclaimedArtifacts?: UnreclaimedArtifact[] }>(
      "/forward-auth/proxy",
      { query: { serverId } },
    ),

  /** Per-domain. Not licensed — see the note above. */
  domainStatus: (domainId: string) =>
    api.get<{ enabled: boolean }>(`/forward-auth/domains/${domainId}`),

  enableOnDomain: (domainId: string) =>
    api.post<{ ok: true }>(`/forward-auth/domains/${domainId}/enable`),

  disableOnDomain: (domainId: string) =>
    api.post<{ ok: true }>(`/forward-auth/domains/${domainId}/disable`),
};
