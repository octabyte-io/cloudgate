import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CredentialHandle } from '../auth/auth.service';
import { CONSOLE_BACKEND_PREFIX } from '../git-providers/oauth-callback.util';
import { traceStoreProxyPath } from './trace-store';

/**
 * The **frame token**: how a viewer's Trace store frame is authorized once it
 * no longer carries the session (ADR-0075).
 *
 * The store runs on the Service's own Server, which on the Hosted instance is
 * the customer's, root included, so whatever the store serves is untrusted.
 * The proxy serves it sandboxed, in an opaque origin
 * (`traceStoreContentSecurityPolicy`'s `sandbox`), so its scripts can never
 * act with the viewer's session. An opaque origin's requests are cross-site,
 * and the session cookie is `SameSite=Lax`, so they carry no session either:
 * the frame's own requests are authorized by this token in their path instead.
 *
 * - **Minted only for a caller who may read the Service now**, by
 *   `TracesService.frame`, under the route's own check.
 * - **Bound** to the Service, the Member, the Organization they were acting
 *   in, and the credential they were recognised by (a session or a Personal
 *   key, by id). Every request re-reads that credential and re-runs the
 *   Service read check, ADR-0012's rule for anything that outlives a request,
 *   so a revoked session, a removed Member or a withdrawn entitlement ends the
 *   frame at its next request rather than at the token's expiry.
 * - **Short-lived**: {@link TRACE_STORE_FRAME_TTL_MS}.
 * - **HMAC-SHA256 under a key derived from `BETTER_AUTH_SECRET`**, the way
 *   `deriveCookieSecret` derives forward-auth's: no new secret to configure,
 *   and a label of its own so the key signs nothing else.
 *
 * The token is readable by whatever the store serves, since it is in the
 * frame's own URL. That grants nothing the store does not already have: it is
 * accepted only for that Service's own store, read only.
 */

/** How long a frame token is accepted after it is minted. */
export const TRACE_STORE_FRAME_TTL_MS = 15 * 60_000;

/** The path segment the token follows, under the store's proxy path. */
const TOKEN_SEGMENT = 't';

/** What a frame token says, as signed. */
export interface TraceStoreFrameClaims {
  serviceId: string;
  userId: string;
  organizationId: string;
  credential: CredentialHandle;
  /** Milliseconds since the epoch after which the token is refused. */
  expiresAt: number;
}

const frameKey = (secret: string): Buffer =>
  createHmac('sha256', secret)
    .update('cloudgate:trace-store-frame:v1')
    .digest();

const sign = (secret: string, payload: string): string =>
  createHmac('sha256', frameKey(secret)).update(payload).digest('base64url');

/** A token for these claims: `<payload>.<signature>`, both base64url. */
export function mintTraceStoreFrameToken(
  secret: string,
  claims: TraceStoreFrameClaims,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      s: claims.serviceId,
      u: claims.userId,
      o: claims.organizationId,
      c: claims.credential,
      e: claims.expiresAt,
    }),
  ).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

function isCredential(value: unknown): value is CredentialHandle {
  if (typeof value !== 'object' || value === null) return false;
  const handle = value as Record<string, unknown>;
  if (handle.kind === 'session') return typeof handle.sessionId === 'string';
  if (handle.kind === 'apiKey') {
    return (
      typeof handle.apiKeyId === 'string' &&
      (handle.namedOrganizationId === undefined ||
        typeof handle.namedOrganizationId === 'string')
    );
  }
  return false;
}

/**
 * The claims of a token signed under `secret`, for this Service, and not yet
 * expired; null for anything else — a forged or altered token, another
 * Service's, an expired one, or one that is not a token at all. One answer
 * for every refusal, so a caller learns nothing about which it was.
 */
export function verifyTraceStoreFrameToken(
  secret: string,
  token: string,
  serviceId: string,
  now: number = Date.now(),
): TraceStoreFrameClaims | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = Buffer.from(sign(secret, payload));
  const received = Buffer.from(signature);
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { s, u, o, c, e } = parsed as Record<string, unknown>;
  if (
    typeof s !== 'string' ||
    typeof u !== 'string' ||
    typeof o !== 'string' ||
    typeof e !== 'number' ||
    !isCredential(c)
  ) {
    return null;
  }
  if (s !== serviceId || e <= now) return null;
  return {
    serviceId: s,
    userId: u,
    organizationId: o,
    credential: c,
    expiresAt: e,
  };
}

/**
 * The path a token's requests are served at, as the backend receives them:
 * the store's proxy path, then `t/<token>`. `TracesController`'s frame route
 * is this path's template.
 */
export const traceStoreFramePath = (serviceId: string, token: string): string =>
  `${traceStoreProxyPath(serviceId)}/${TOKEN_SEGMENT}/${token}`;

/**
 * {@link traceStoreFramePath} as the browser requests it, behind the
 * console's `/backend` rewrite: the base the frame's every URL is under.
 */
export const traceStoreFrameBasePath = (
  serviceId: string,
  token: string,
): string =>
  `${CONSOLE_BACKEND_PREFIX}${traceStoreFramePath(serviceId, token)}`;

/**
 * Whether a request path, as the backend receives it, is a frame token's: the
 * only paths answered to an opaque (`null`) origin, without credentials
 * (`applyCors`).
 */
export const isTraceStoreFramePath = (url: string): boolean =>
  /^\/traces\/[^/?#]+\/ui\/t\/[^/?#]+(?:[/?#]|$)/.test(url);
