import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';
import {
  CONSOLE_BACKEND_PREFIX,
  GIT_PROVIDERS_CONSOLE_PATH,
  callbackUrlFor,
  consoleReturnUrl,
  providerFacingBaseOf,
  publicOriginOf,
  unprefixedCallbackUrlFor,
} from '../../src/git-providers/oauth-callback.util';

/**
 * A callback URL cannot come from configuration here: the flow has to hand the
 * provider the URL *the browser just reached this backend on*, and the whole
 * point is that no env key names it. So it is derived from the request, and the
 * derivation is the part worth pinning.
 */
describe('publicOriginOf', () => {
  it('is the Host header over http when nothing says otherwise', () => {
    expect(publicOriginOf({ host: 'cloudgate.example.com' })).toBe(
      'http://cloudgate.example.com',
    );
  });

  it('honours the proxy’s x-forwarded-proto, which is how Traefik terminates TLS', () => {
    expect(
      publicOriginOf({
        host: 'cloudgate.example.com',
        'x-forwarded-proto': 'https',
      }),
    ).toBe('https://cloudgate.example.com');
  });

  it('takes the first hop of a comma-joined x-forwarded-proto, not the whole list', () => {
    // Two proxies in front append rather than replace, and "https, http" as a
    // scheme produces a URL no provider will accept.
    expect(
      publicOriginOf({
        host: 'cloudgate.example.com',
        'x-forwarded-proto': 'https, http',
      }),
    ).toBe('https://cloudgate.example.com');
  });

  it('prefers x-forwarded-host, because Host is the proxy’s own name behind one', () => {
    expect(
      publicOriginOf({
        host: 'backend:4000',
        'x-forwarded-host': 'cloudgate.example.com',
        'x-forwarded-proto': 'https',
      }),
    ).toBe('https://cloudgate.example.com');
  });

  it('refuses a scheme that is neither http nor https rather than emitting it', () => {
    expect(() =>
      publicOriginOf({
        host: 'cloudgate.example.com',
        'x-forwarded-proto': 'javascript',
      }),
    ).toThrow(BadRequestException);
  });

  it('refuses a request with no host at all', () => {
    expect(() => publicOriginOf({})).toThrow(BadRequestException);
  });
});

/**
 * **Where a provider is told to send the browser, and its webhooks.**
 *
 * Every such URL used to be `publicOriginOf(headers)` plus a backend path. The
 * console reaches this backend through its own `/backend` rewrite, so the
 * request's host is the *console's* — and the console serves none of those
 * paths without the prefix: GitHub's conversion code landed on the console's
 * 404 page and was never redeemed. The console's origin with the prefix is the
 * one address every install shape publishes for this backend.
 */
describe('providerFacingBaseOf', () => {
  it('is the console’s origin plus the prefix the console proxies to this backend', () => {
    expect(
      providerFacingBaseOf({
        origin: 'http://203.0.113.10:3000',
        host: '127.0.0.1:4000',
        'x-forwarded-host': '203.0.113.10:3000',
        'x-forwarded-proto': 'http',
      }),
    ).toBe('http://203.0.113.10:3000/backend');
  });

  it('takes the scheme from the browser’s Origin behind a TLS-terminating console domain', () => {
    expect(
      providerFacingBaseOf({
        origin: 'https://cloudgate.example.com',
        host: '127.0.0.1:4000',
        'x-forwarded-host': 'cloudgate.example.com',
      }),
    ).toBe('https://cloudgate.example.com/backend');
  });

  it('falls back to the forwarded host the console’s proxy stamps when there is no Origin', () => {
    expect(
      providerFacingBaseOf({
        origin: 'null',
        host: '127.0.0.1:4000',
        'x-forwarded-host': 'localhost:3000',
        'x-forwarded-proto': 'http',
      }),
    ).toBe('http://localhost:3000/backend');
  });

  it('refuses an Origin that is not http or https rather than handing it to a provider', () => {
    expect(() =>
      providerFacingBaseOf({ origin: 'javascript:alert(1)', host: 'x' }),
    ).toThrow(BadRequestException);
  });

  /**
   * The session cookie is `SameSite=Lax`, and a site ignores the port: a page
   * on any other port of the console's host — an Application this very
   * instance deploys, say — is same-site, so its form POST to
   * `/backend/git-providers/oauth/…` carries the operator's cookie and its own
   * `Origin`, and nothing on a REST route checks that header. Honoured, it
   * would name where GitHub sends the conversion code (the App's private key)
   * and the callback a GitLab or Gitea connection *stores*. So `Origin` is
   * believed only when it names the host the request actually arrived on.
   */
  it('ignores an Origin that is not the host the request arrived on, and uses that host instead', () => {
    expect(
      providerFacingBaseOf({
        origin: 'http://203.0.113.10:8080',
        host: '127.0.0.1:4000',
        'x-forwarded-host': '203.0.113.10:3000',
        'x-forwarded-proto': 'http',
      }),
    ).toBe('http://203.0.113.10:3000/backend');
    expect(
      providerFacingBaseOf({
        origin: 'https://evil.example.net',
        host: 'console.example.com',
      }),
    ).toBe('http://console.example.com/backend');
  });

  it('matches the host the way a browser writes it, whatever its case', () => {
    expect(
      providerFacingBaseOf({
        origin: 'https://cloudgate.example.com',
        'x-forwarded-host': 'CloudGate.Example.com',
      }),
    ).toBe('https://cloudgate.example.com/backend');
  });
});

describe('callbackUrlFor', () => {
  it('is the provider’s callback route under the provider-facing base', () => {
    expect(
      callbackUrlFor('https://console.example.com/backend', 'gitlab'),
    ).toBe(
      'https://console.example.com/backend/git-providers/oauth/gitlab/callback',
    );
  });
});

describe('unprefixedCallbackUrlFor', () => {
  it('is the value an earlier install stored: the same callback on the console’s origin without its prefix', () => {
    expect(
      unprefixedCallbackUrlFor('https://console.example.com/backend', 'gitea'),
    ).toBe('https://console.example.com/git-providers/oauth/gitea/callback');
  });
});

/**
 * The half of the prefix gate that lives in the console: the prefix is only a
 * route this install serves if the console really rewrites it to this backend,
 * stripped, and lets it past the sign-in guard. Read from the console's own
 * source, because a rename there would otherwise break every provider handshake
 * with nothing red on this side.
 */
describe('CONSOLE_BACKEND_PREFIX', () => {
  const frontend = join(__dirname, '..', '..', '..', 'frontend');
  const read = (...path: string[]) =>
    readFileSync(join(frontend, ...path), 'utf8');

  it('is the console’s API_PREFIX, which the console serves', () => {
    expect(read('src', 'lib', 'config.ts')).toContain(
      `export const API_PREFIX = "${CONSOLE_BACKEND_PREFIX}";`,
    );
  });

  it('is rewritten to this backend with the prefix stripped', () => {
    const nextConfig = read('next.config.ts');
    expect(nextConfig).toMatch(
      /source: `\$\{API_PREFIX\}\/:path\*`,\s*destination: `\$\{BACKEND_INTERNAL_ORIGIN\}\/:path\*`/,
    );
  });

  it('is kept out of the console’s sign-in guard, so a provider’s unauthenticated redirect reaches it', () => {
    const literal = /matcher: \[\s*("[^"]+")/.exec(
      read('src', 'proxy.ts'),
    )?.[1];
    expect(literal).toBeDefined();
    // The source text is a string literal; JSON reads its escapes the same way.
    const guarded = new RegExp(`^${JSON.parse(literal as string) as string}$`);
    const prefix = CONSOLE_BACKEND_PREFIX;
    expect(guarded.test(`${prefix}/git-providers/oauth/github/setup`)).toBe(
      false,
    );
    expect(guarded.test(`${prefix}/github/webhook`)).toBe(false);
    // …and the matcher is live: the bare path is guarded, which is the prefix bug.
    expect(guarded.test('/git-providers/oauth/github/setup')).toBe(true);
  });
});

/**
 * Where the browser is sent when the handshake finishes. It is taken from the
 * console's own Origin header rather than from a query parameter, because a
 * caller-supplied redirect target on a public callback route is an open
 * redirect.
 */
describe('consoleReturnUrl', () => {
  it('is the git-providers screen on the console that started the flow', () => {
    expect(
      consoleReturnUrl({
        origin: 'https://console.example.com',
        'x-forwarded-host': 'console.example.com',
      }),
    ).toBe(`https://console.example.com${GIT_PROVIDERS_CONSOLE_PATH}`);
  });

  it('falls back to a relative path when the browser sent no Origin', () => {
    // The callback that sends it is served on the console's origin, so the
    // browser resolves it there.
    expect(consoleReturnUrl({ host: 'console.example.com' })).toBe(
      GIT_PROVIDERS_CONSOLE_PATH,
    );
    expect(
      consoleReturnUrl({ origin: 'null', host: 'console.example.com' }),
    ).toBe(GIT_PROVIDERS_CONSOLE_PATH);
  });

  it('does not return the browser to an Origin the request did not arrive on', () => {
    expect(
      consoleReturnUrl({
        origin: 'http://203.0.113.10:8080',
        'x-forwarded-host': '203.0.113.10:3000',
      }),
    ).toBe(GIT_PROVIDERS_CONSOLE_PATH);
  });

  it('refuses an Origin that is not http or https', () => {
    // The value ends up in a Location header, so a javascript: origin would be
    // an open redirect into script execution.
    expect(() =>
      consoleReturnUrl({ origin: 'javascript:alert(1)', host: 'x' }),
    ).toThrow(BadRequestException);
    expect(() => consoleReturnUrl({ origin: 'not a url', host: 'x' })).toThrow(
      BadRequestException,
    );
  });

  it('keeps only the origin of an Origin header that carries a path', () => {
    expect(
      consoleReturnUrl({
        origin: 'https://console.example.com/somewhere',
        host: 'console.example.com',
      }),
    ).toBe(`https://console.example.com${GIT_PROVIDERS_CONSOLE_PATH}`);
  });
});
