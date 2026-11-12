import { DNS_CHALLENGE_RESOLVER } from '../../settings/dns-challenge.schema';
import { createTraefikConfig } from './application';
import { createRouterConfig } from './domain';
import type { FileConfig, HttpRouter } from './file-types';
import { domainSecureRouterName } from './names';
import type { TraefikApp, TraefikDomain } from './types';

/**
 * The key a preview's router, service and middleware names are suffixed with.
 *
 * A constant rather than a `domain.uniqueConfigKey`, because a preview has no
 * `domain` row to draw one from — Phase 25 stores its host on the
 * `preview_deployment` row, and `domain_exactly_one_parent` would make a row
 * for it hang off the *parent* Application anyway. What makes a name unique is
 * the `appName` in front of it (`domain.schema.ts` says so of the serial
 * itself), and a preview's `appName` is minted fresh per pull request and is
 * `unique` on its table, so one key per preview is all the space there is.
 */
export const PREVIEW_CONFIG_KEY = 1;

/**
 * The one route a preview has: its host, on the port the parent's
 * `previewPort` names, whole-host.
 *
 * `https: false` and not `true`, deliberately, and the secure router is added
 * by {@link createPreviewTraefikConfig} rather than by the generator's `https`
 * arm. That arm makes the `web` router a `redirect-to-https`, and a preview's
 * host has a certificate only if the operator uploaded one for the wildcard or
 * the machine's DNS-01 resolver has issued one — so a redirect would
 * send every reviewer without one from a working `http://` link to a
 * certificate warning. `domainType: 'preview'` is what the generator
 * already reads to keep the parent's redirect middlewares off a preview host.
 */
export const previewRoute = (host: string, port: number): TraefikDomain => ({
  host,
  port,
  https: false,
  uniqueConfigKey: PREVIEW_CONFIG_KEY,
  domainType: 'preview',
  path: '/',
  certificateType: 'none',
});

/**
 * The `tls` of a preview's `websecure` router.
 *
 * **`{}` and no resolver, unless the parent asks for DNS-01.** With `{}`
 * Traefik terminates TLS with the certificate its store holds for the SNI
 * name — a wildcard certificate uploaded through Certificates for the preview
 * wildcard is picked up by name, and without one Traefik answers with its
 * default certificate. Naming `letsencrypt` was the alternative and was
 * rejected: it would request one certificate per pull request from Let's
 * Encrypt's rate-limited issuer for a host that lives as long as the pull
 * request, on an install that may not have an ACME email configured at all.
 *
 * **With `dnsChallengeWildcard`** — the parent's `previewWildcard`, given only
 * while its `previewDnsChallenge` switch is on — the router names the
 * machine's DNS-01 resolver and asks it for that one wildcard in `domains`.
 * The wildcard and not the host, so every preview of the Application shares
 * one certificate and one issuance rather than one per pull request; and the
 * wildcard **alone**, with no apex SAN, because a wildcard plus its apex can
 * fail validation on providers that answer both TXT records from one name
 * (the research note on `research/short-lived-https`). Traefik then serves
 * that certificate by SNI to every host it covers, and until it is issued the
 * router still answers with the default certificate — which is why the
 * printed link waits for issuance rather than for this setting
 * (`preview-deployments/preview-url.ts`).
 */
export const previewRouterTls = (
  dnsChallengeWildcard: string | null,
): NonNullable<HttpRouter['tls']> =>
  dnsChallengeWildcard === null
    ? {}
    : {
        certResolver: DNS_CHALLENGE_RESOLVER,
        domains: [{ main: dnsChallengeWildcard }],
      };

/**
 * A preview's whole dynamic config: the `web` router and service an
 * Application's own Domain gets from {@link createTraefikConfig}, plus a
 * `websecure` router whose `tls` is {@link previewRouterTls}'s.
 *
 * **The same generator, not a parallel one.** The router rule, the backend URL,
 * the service's `passHostHeader` and the basic-auth middleware's place in the
 * chain are all `domain.ts`' — a preview is routed the way a Domain is, under
 * its own `appName`, into its own `dynamic/{appName}.yml` (ADR-0021: a preview
 * owns its Traefik router).
 *
 * `dnsChallengeWildcard` is `null` for every preview whose parent has not
 * turned DNS-01 on, and then the file is byte-for-byte what it was before
 * DNS-01 existed.
 */
export const createPreviewTraefikConfig = (
  app: TraefikApp,
  route: TraefikDomain,
  dnsChallengeWildcard: string | null = null,
): FileConfig => {
  const config = createTraefikConfig(app, [route]);
  if (config.http?.routers) {
    config.http.routers[
      domainSecureRouterName(app.appName, route.uniqueConfigKey)
    ] = {
      ...createRouterConfig(app, route, 'websecure'),
      tls: previewRouterTls(dnsChallengeWildcard),
    };
  }
  return config;
};
