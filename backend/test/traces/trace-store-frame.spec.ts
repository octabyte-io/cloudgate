import { createHmac } from 'node:crypto';
import {
  isTraceStoreFramePath,
  mintTraceStoreFrameToken,
  TRACE_STORE_FRAME_TTL_MS,
  traceStoreFrameBasePath,
  verifyTraceStoreFrameToken,
} from '../../src/traces/trace-store-frame';
import type { TraceStoreFrameClaims } from '../../src/traces/trace-store-frame';

/**
 * The frame token a sandboxed Trace store frame's requests are authorized by
 * (ADR-0075): accepted only for the Service, Member and credential it was
 * minted for, signed by this instance, and only until it expires.
 */

const SECRET = 'test-auth-secret-at-least-32-chars-long';
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

const claims = (
  overrides: Partial<TraceStoreFrameClaims> = {},
): TraceStoreFrameClaims => ({
  serviceId: 'app-1',
  userId: 'user-1',
  organizationId: 'org-1',
  credential: { kind: 'session', sessionId: 'session-1' },
  expiresAt: NOW + TRACE_STORE_FRAME_TTL_MS,
  ...overrides,
});

/** A token's payload re-signed with `secret`, as a forger holding it would. */
function resigned(payload: object, secret: string): string {
  const key = createHmac('sha256', secret)
    .update('cloudgate:trace-store-frame:v1')
    .digest();
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${createHmac('sha256', key).update(encoded).digest('base64url')}`;
}

const payloadOf = (token: string): Record<string, unknown> =>
  JSON.parse(
    Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
  ) as Record<string, unknown>;

describe('verifyTraceStoreFrameToken', () => {
  it('lasts fifteen minutes', () => {
    expect(TRACE_STORE_FRAME_TTL_MS).toBe(15 * 60 * 1000);
  });

  it('is accepted for the Service it was minted for, and says whom for', () => {
    const token = mintTraceStoreFrameToken(SECRET, claims());

    expect(verifyTraceStoreFrameToken(SECRET, token, 'app-1', NOW)).toEqual(
      claims(),
    );
  });

  it('carries a Personal key credential as minted', () => {
    const credential = {
      kind: 'apiKey' as const,
      apiKeyId: 'key-1',
      namedOrganizationId: 'org-1',
    };
    const token = mintTraceStoreFrameToken(SECRET, claims({ credential }));

    expect(
      verifyTraceStoreFrameToken(SECRET, token, 'app-1', NOW)?.credential,
    ).toEqual(credential);
  });

  it('is refused once it has expired, at the instant it expires', () => {
    const token = mintTraceStoreFrameToken(SECRET, claims());

    expect(
      verifyTraceStoreFrameToken(
        SECRET,
        token,
        'app-1',
        NOW + TRACE_STORE_FRAME_TTL_MS - 1,
      ),
    ).not.toBeNull();
    expect(
      verifyTraceStoreFrameToken(
        SECRET,
        token,
        'app-1',
        NOW + TRACE_STORE_FRAME_TTL_MS,
      ),
    ).toBeNull();
  });

  it('is refused for another Service', () => {
    const token = mintTraceStoreFrameToken(SECRET, claims());

    expect(verifyTraceStoreFrameToken(SECRET, token, 'app-2', NOW)).toBeNull();
  });

  it('is refused when its payload is altered to name another Member, Service or expiry', () => {
    const token = mintTraceStoreFrameToken(SECRET, claims());
    const [, signature] = token.split('.');
    const original = payloadOf(token);

    for (const altered of <Record<string, unknown>[]>[
      { ...original, u: 'user-2' },
      { ...original, o: 'org-2' },
      { ...original, s: 'app-2' },
      { ...original, e: NOW + 24 * 60 * 60_000 },
      { ...original, c: { kind: 'session', sessionId: 'session-2' } },
    ]) {
      const forged = `${Buffer.from(JSON.stringify(altered)).toString('base64url')}.${signature}`;
      expect(
        verifyTraceStoreFrameToken(SECRET, forged, String(altered.s), NOW),
      ).toBeNull();
    }
  });

  it('is refused when signed with any other secret', () => {
    const forged = resigned(
      payloadOf(mintTraceStoreFrameToken(SECRET, claims())),
      'another-secret-at-least-32-characters',
    );

    expect(verifyTraceStoreFrameToken(SECRET, forged, 'app-1', NOW)).toBeNull();
  });

  it('is not signed with the auth secret itself, but a key derived for frames alone', () => {
    const token = mintTraceStoreFrameToken(SECRET, claims());
    const [payload, signature] = token.split('.');

    expect(signature).not.toBe(
      createHmac('sha256', SECRET).update(payload).digest('base64url'),
    );
  });

  it.each([
    ['nothing', ''],
    ['no signature', 'abc'],
    ['three parts', 'a.b.c'],
    ['a signature of the wrong length', 'abc.def'],
  ])('refuses %s', (_label, token) => {
    expect(verifyTraceStoreFrameToken(SECRET, token, 'app-1', NOW)).toBeNull();
  });

  it('refuses a correctly signed payload of the wrong shape', () => {
    for (const payload of [
      { s: 'app-1', u: 'user-1', o: 'org-1', e: NOW + 1000 },
      {
        s: 'app-1',
        u: 'user-1',
        o: 'org-1',
        c: { kind: 'cookie', id: 'x' },
        e: NOW + 1000,
      },
      {
        s: 'app-1',
        u: 'user-1',
        o: 'org-1',
        c: { kind: 'session', sessionId: 's' },
        e: String(NOW + 1000),
      },
    ]) {
      expect(
        verifyTraceStoreFrameToken(
          SECRET,
          resigned(payload, SECRET),
          'app-1',
          NOW,
        ),
      ).toBeNull();
    }
  });
});

describe('traceStoreFrameBasePath', () => {
  it('puts the token under the proxy path, behind the console rewrite', () => {
    expect(traceStoreFrameBasePath('app-1', 'tok.sig')).toBe(
      '/backend/traces/app-1/ui/t/tok.sig',
    );
  });
});

describe('isTraceStoreFramePath', () => {
  it.each([
    ['/traces/app-1/ui/t/tok.sig', true],
    ['/traces/app-1/ui/t/tok.sig/', true],
    ['/traces/app-1/ui/t/tok.sig/api/services?limit=5', true],
    ['/traces/app-1/ui/t/tok.sig?x=1', true],
    ['/traces/app-1/ui', false],
    ['/traces/app-1/ui/search', false],
    ['/traces/app-1/ui/t/', false],
    ['/traces/app-1', false],
    ['/traces/app-1/frame', false],
    ['/backend/traces/app-1/ui/t/tok.sig', false],
    ['/applications/x/ui/t/tok', false],
  ])('reads %s as a frame path: %s', (url, expected) => {
    expect(isTraceStoreFramePath(url)).toBe(expected);
  });
});
