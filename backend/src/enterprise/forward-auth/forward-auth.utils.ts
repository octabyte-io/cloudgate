import { createHmac } from 'node:crypto';
import { FORWARD_AUTH_PORT } from '../../traefik/config/forward-auth';

/**
 * Pure derivations for the forward-auth oauth2-proxy. The container spec they
 * feed lives in ForwardAuthProxyService.
 */

/** The oauth2-proxy image and the service/port the Traefik generators expect. */
export const FORWARD_AUTH_IMAGE = 'quay.io/oauth2-proxy/oauth2-proxy:v7.6.0';

/** The OIDC provider fields oauth2-proxy is configured from. */
export interface ForwardAuthOidcConfig {
  clientId: string;
  clientSecret: string;
  issuer: string;
  scopes?: string[];
  skipDiscovery?: boolean;
}

export interface ForwardAuthEnvOptions {
  oidc: ForwardAuthOidcConfig;
  cookieSecret: string;
  authDomain: string;
  baseDomain: string;
  authDomainHttps?: boolean;
  emailDomains?: string[];
}

/**
 * The cookie/whitelist domain oauth2-proxy is configured with: the auth domain
 * minus its first label once it has more than two, leading dot included, so a
 * session set on `auth.example.com` is sent to every app under `.example.com`.
 */
export const deriveBaseDomain = (authDomain: string): string => {
  const labels = authDomain.trim().toLowerCase().split('.').filter(Boolean);
  const base = labels.length > 2 ? labels.slice(1) : labels;
  return `.${base.join('.')}`;
};

/** The redirect URI the identity provider must have registered. */
export const forwardAuthCallbackUrl = (
  authDomain: string,
  https: boolean,
): string => `${https ? 'https' : 'http'}://${authDomain}/oauth2/callback`;

/**
 * The proxy's cookie-signing key, derived from the instance's auth secret so it
 * survives a redeploy without being stored. oauth2-proxy requires exactly 16,
 * 24 or 32 bytes, so the first 32 hex chars (= 16 bytes) are taken.
 *
 * The secret is a parameter so the derivation stays pure; the caller pulls
 * BETTER_AUTH_SECRET off ConfigService.
 */
export const deriveCookieSecret = (secret: string, salt: string): string =>
  createHmac('sha256', secret)
    .update(`forward-auth:${salt}`)
    .digest('hex')
    .slice(0, 32);

/**
 * The oauth2-proxy container's environment: an OIDC provider on the forward-auth
 * port, redirecting to the auth domain's /oauth2/callback, with cookies and
 * post-login redirects scoped to the base domain. Every email domain is
 * admitted unless `emailDomains` narrows it; scopes default to
 * `openid email profile`.
 */
export const buildForwardAuthEnv = (
  options: ForwardAuthEnvOptions,
): string[] => {
  const { oidc, cookieSecret, authDomain, baseDomain, authDomainHttps } =
    options;
  const scheme = authDomainHttps ? 'https' : 'http';
  const emailDomains =
    options.emailDomains && options.emailDomains.length > 0
      ? options.emailDomains
      : ['*'];

  const env: string[] = [
    'OAUTH2_PROXY_PROVIDER=oidc',
    `OAUTH2_PROXY_OIDC_ISSUER_URL=${oidc.issuer}`,
    `OAUTH2_PROXY_CLIENT_ID=${oidc.clientId}`,
    `OAUTH2_PROXY_CLIENT_SECRET=${oidc.clientSecret}`,
    `OAUTH2_PROXY_COOKIE_SECRET=${cookieSecret}`,
    `OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:${FORWARD_AUTH_PORT}`,
    'OAUTH2_PROXY_REVERSE_PROXY=true',
    'OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true',
    'OAUTH2_PROXY_SET_XAUTHREQUEST=true',
    // The proxy answers the auth check itself; nothing sits behind it.
    'OAUTH2_PROXY_UPSTREAMS=static://202',
    `OAUTH2_PROXY_REDIRECT_URL=${scheme}://${authDomain}/oauth2/callback`,
    `OAUTH2_PROXY_COOKIE_DOMAINS=${baseDomain}`,
    `OAUTH2_PROXY_WHITELIST_DOMAINS=${baseDomain}`,
    `OAUTH2_PROXY_COOKIE_SECURE=${authDomainHttps ? 'true' : 'false'}`,
    'OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true',
    `OAUTH2_PROXY_EMAIL_DOMAINS=${emailDomains.join(',')}`,
  ];

  const scopes = oidc.scopes?.length
    ? oidc.scopes
    : ['openid', 'email', 'profile'];
  env.push(`OAUTH2_PROXY_SCOPE=${scopes.join(' ')}`);

  if (oidc.skipDiscovery) {
    env.push('OAUTH2_PROXY_SKIP_OIDC_DISCOVERY=true');
  }

  return env;
};
