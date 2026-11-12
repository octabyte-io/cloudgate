import type { FetchClient } from './fetch.provider';

export interface OAuthRefreshGrant {
  accessToken: string;
  /** Providers may rotate the refresh token; null when they keep the old one. */
  refreshToken: string | null;
  /** Lifetime in seconds; null when the provider does not report one. */
  expiresIn: number | null;
}

export type OAuthRefreshResult =
  { ok: true; grant: OAuthRefreshGrant } | { ok: false; statusText: string };

/**
 * The two OAuth grants the OAuth-backed providers (GitLab, Gitea) run against
 * their token endpoint: `refresh_token`, which every API call goes through, and
 * `authorization_code`, which the callback routes run once to turn
 * a `?code=` into the first token pair.
 *
 * Both POST a form-encoded body and read back the same three fields, so the
 * request is shared. Policy — what counts as fatal, which expiry buffer to
 * apply, where to persist — stays with each service.
 */
async function requestOAuthGrant(
  fetch: FetchClient,
  tokenUrl: string,
  form: Record<string, string>,
): Promise<OAuthRefreshResult> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(form),
  });
  if (!response.ok) {
    return { ok: false, statusText: response.statusText };
  }
  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  // Gitea answers 200 with an `error` body for a code that has been used, so a
  // successful status is not on its own a successful grant.
  if (!data.access_token) {
    return { ok: false, statusText: 'no access token in the grant response' };
  }
  return {
    ok: true,
    grant: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresIn: data.expires_in ?? null,
    },
  };
}

/** The refresh-token grant: trades a refresh token for a fresh pair. */
export function requestOAuthTokenRefresh(
  fetch: FetchClient,
  tokenUrl: string,
  credentials: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  },
): Promise<OAuthRefreshResult> {
  return requestOAuthGrant(fetch, tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });
}

/**
 * The authorization-code grant: trades the `?code=` a callback just
 * received for the connection's first token pair — and, crucially, for the
 * `expires_in` that nothing else records.
 *
 * `redirectUri` must be byte-identical to the one the authorize request carried;
 * providers compare it and reject a good code sent with a different value.
 */
export function requestOAuthCodeExchange(
  fetch: FetchClient,
  tokenUrl: string,
  credentials: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
): Promise<OAuthRefreshResult> {
  return requestOAuthGrant(fetch, tokenUrl, {
    grant_type: 'authorization_code',
    code: credentials.code,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: credentials.redirectUri,
  });
}
