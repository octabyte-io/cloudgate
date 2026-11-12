import { BadRequestException } from '@nestjs/common';
import type { GitProviderType } from './git-provider.schema';

/**
 * The routes that *produce* an OAuth grant, and how they name themselves.
 *
 * Every URL in this flow has to be told to the provider before the provider
 * uses it, and no environment key names this instance's public origin — so all
 * of it is derived from the request the console just made.
 *
 * **That request is the console's, not the browser's.** The browser
 * never dials this backend for REST: it calls the console's own origin under
 * {@link CONSOLE_BACKEND_PREFIX}, and the console rewrites that server-side to
 * here with the prefix stripped (`frontend/next.config.ts`). So the host this
 * process sees is the console's, and the console serves none of this module's
 * paths *without* the prefix — which is how a manifest built from the bare
 * host sent GitHub's one-time conversion code to the console's 404 page.
 *
 * The console's origin plus the prefix is also the only address every install
 * shape publishes for this backend: `deploy/install.sh` opens the console's
 * port, a console domain on /settings/instance routes Traefik to the console
 * alone, and in development it is `localhost:3000`. The API's own port is
 * reachable on a default install too, but not behind a console domain, and
 * nothing guarantees it outside that one shape.
 */
export const OAUTH_CALLBACK_PATH = 'git-providers/oauth';

/**
 * The console's same-origin prefix for this backend — its `API_PREFIX`
 * (`frontend/src/lib/config.ts`). A second spelling of a value owned by
 * another package, held to it by `oauth-callback.util.spec.ts`, which reads
 * the console's config, rewrite and sign-in guard.
 */
export const CONSOLE_BACKEND_PREFIX = '/backend';

/** The console screen these flows start and end on. */
export const GIT_PROVIDERS_CONSOLE_PATH = '/settings/git-providers';

/** Just the headers this derivation reads, so a test need not build a Request. */
export interface OriginHeaders {
  host?: string;
  'x-forwarded-host'?: string;
  'x-forwarded-proto'?: string;
}

/** …plus the browser's own `Origin`, which the console's proxy passes on. */
export type ConsoleRequestHeaders = OriginHeaders & { origin?: string };

/**
 * The origin the request reached this process on, as the headers name it. A
 * proxy chain appends to `x-forwarded-proto` rather than replacing it, so only
 * the first hop is the scheme the client used. Through the console's rewrite
 * that is the *console's* origin: Next stamps `x-forwarded-host` with the host
 * the browser used.
 */
export function publicOriginOf(headers: OriginHeaders): string {
  const host = headers['x-forwarded-host'] || headers.host;
  if (!host) {
    throw new BadRequestException(
      'Cannot determine this instance’s public URL: the request carries no Host header',
    );
  }
  const forwarded = headers['x-forwarded-proto']?.split(',')[0]?.trim();
  const protocol = forwarded || 'http';
  if (protocol !== 'http' && protocol !== 'https') {
    throw new BadRequestException(
      `Refusing to build a callback URL for the scheme "${protocol}"`,
    );
  }
  return `${protocol}://${host.split(',')[0].trim()}`;
}

/**
 * The browser's `Origin`, **only when it names the host the request arrived
 * on** — else null, as for an absent or opaque one.
 *
 * Why not believe it outright: the session cookie is `SameSite=Lax`, and a
 * site ignores the port, so a page on any other port of the console's host —
 * an Application this instance deploys, for one — is same-site. Its form POST
 * to a start route carries the operator's cookie and *its own* `Origin`, and no
 * REST route checks that header (better-auth's `trustedOrigins` guards
 * `/api/auth` alone). Believed, it would choose where GitHub sends the
 * conversion code that becomes the App's private key, and the callback URL a
 * GitLab or Gitea connection stores for every later authorize.
 *
 * The host it has to match is the one the console's rewrite stamps into
 * `x-forwarded-host` — the host the browser used, so a genuine console request
 * always matches and nothing needs configuring. A second console on another
 * trusted origin is no exception: it proxies through its own host too. What
 * the match still takes from `Origin` is the scheme, which Next's proxy does
 * not always forward.
 */
function verifiedBrowserOriginOf(
  headers: ConsoleRequestHeaders,
): string | null {
  const { origin } = headers;
  // Browsers send the literal string "null" for an opaque origin.
  if (!origin || origin === 'null') return null;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new BadRequestException(`Not a valid Origin: ${origin}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException(`Not a valid Origin: ${origin}`);
  }
  const arrivedOn = (headers['x-forwarded-host'] || headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return parsed.host === arrivedOn ? parsed.origin : null;
}

/**
 * The base every URL handed to a provider hangs off: the console's
 * origin plus {@link CONSOLE_BACKEND_PREFIX}.
 *
 * The console's origin is the browser's `Origin` when it matches the host the
 * request arrived on (see {@link verifiedBrowserOriginOf}) — the page the
 * operator is on, scheme included — and otherwise that host itself, which
 * through the console's proxy is the console's.
 */
export function providerFacingBaseOf(headers: ConsoleRequestHeaders): string {
  const consoleOrigin =
    verifiedBrowserOriginOf(headers) ?? publicOriginOf(headers);
  return `${consoleOrigin}${CONSOLE_BACKEND_PREFIX}`;
}

/** Where a provider hands back its `?code=`, for one provider kind. */
export function callbackUrlFor(base: string, kind: GitProviderType): string {
  return `${base.replace(/\/+$/, '')}/${OAUTH_CALLBACK_PATH}/${kind}/callback`;
}

/**
 * The callback URL this module derived before the `/backend` prefix: {@link
 * callbackUrlFor} on the console's origin *without* {@link
 * CONSOLE_BACKEND_PREFIX}, which the console answers with its sign-in redirect
 * or its 404 page. Named so a connection still storing it can be recognised and
 * re-derived.
 */
export function unprefixedCallbackUrlFor(
  base: string,
  kind: GitProviderType,
): string {
  const trimmed = base.replace(/\/+$/, '');
  const consoleOrigin = trimmed.endsWith(CONSOLE_BACKEND_PREFIX)
    ? trimmed.slice(0, -CONSOLE_BACKEND_PREFIX.length)
    : trimmed;
  return callbackUrlFor(consoleOrigin, kind);
}

/**
 * Where the browser is sent once the handshake finishes, taken from the
 * console's own `Origin` header when it names the host the request arrived on.
 * Deliberately not a request parameter: a caller-supplied redirect target
 * reachable from an unauthenticated callback route is an open redirect, and
 * this one ends up verbatim in a `Location`.
 */
export function consoleReturnUrl(headers: ConsoleRequestHeaders): string {
  const consoleOrigin = verifiedBrowserOriginOf(headers);
  // Relative is still right: the callback that sends it is itself served on
  // the console's origin, so the browser resolves it there.
  if (!consoleOrigin) return GIT_PROVIDERS_CONSOLE_PATH;
  return `${consoleOrigin}${GIT_PROVIDERS_CONSOLE_PATH}`;
}
