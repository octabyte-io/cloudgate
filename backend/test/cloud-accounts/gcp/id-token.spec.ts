import { createPublicKey, verify } from 'node:crypto';

import {
  CHECK_TOKEN_SECONDS,
  RUN_TOKEN_SECONDS,
  jwksOf,
  makeSigningKey,
  signIdToken,
  signingKeyOf,
  tokenIssuer,
  tokenSubject,
} from '../../../src/cloud-accounts/gcp/id-token';

/** A JWT's three parts, decoded. */
function decode(token: string) {
  const [header, payload, signature] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<
      string,
      unknown
    >,
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >,
    signed: `${header}.${payload}`,
    signature: Buffer.from(signature, 'base64url'),
  };
}

const PROVIDER =
  'projects/123456789012/locations/global/workloadIdentityPools/cloudgate-abc/providers/cloudgate-abc';

describe('signIdToken (spec S16)', () => {
  const key = makeSigningKey();

  it('is RS256, carries the agreed claims and verifies against the JWKS the operator uploads', () => {
    const token = signIdToken(key, {
      issuer: 'https://cloudgate.example.com/ca_1',
      subject: tokenSubject('ca_1'),
      workloadIdentityProvider: PROVIDER,
      lifetimeSeconds: CHECK_TOKEN_SECONDS,
      now: new Date('2026-10-20T12:00:00Z'),
    });

    const { header, payload, signed, signature } = decode(token);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: key.keyId });
    expect(payload).toEqual({
      iss: 'https://cloudgate.example.com/ca_1',
      sub: 'cloudgate:ca_1',
      aud: `//iam.googleapis.com/${PROVIDER}`,
      iat: 1_792_497_600,
      exp: 1_792_497_600 + 300,
    });

    const [jwk] = jwksOf([key.publicJwk]).keys;
    expect(jwk).toMatchObject({
      kty: 'RSA',
      alg: 'RS256',
      use: 'sig',
      kid: key.keyId,
    });
    expect(jwk).not.toHaveProperty('d');
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    expect(
      verify('RSA-SHA256', Buffer.from(signed), publicKey, signature),
    ).toBe(true);
  });

  it('lives 5 minutes for a check and 2 hours for a Cloud run', () => {
    expect(CHECK_TOKEN_SECONDS).toBe(5 * 60);
    expect(RUN_TOKEN_SECONDS).toBe(2 * 60 * 60);
  });

  it('gives each key its own id, and the JWKS every key it is handed', () => {
    const other = makeSigningKey();
    expect(other.keyId).not.toBe(key.keyId);
    expect(
      jwksOf([key.publicJwk, other.publicJwk]).keys.map((jwk) => jwk.kid),
    ).toEqual([key.keyId, other.keyId]);
  });

  it('reads a stored private half back into the same key, id and public half', () => {
    // A key change keeps only the new private half until it is checked.
    expect(signingKeyOf(key.privateKey)).toEqual(key);
  });

  it('is issued by the install, at https, followed by the Cloud account id', () => {
    expect(tokenIssuer('http://203.0.113.7:3000', 'ca_1')).toBe(
      'https://203.0.113.7:3000/ca_1',
    );
    expect(tokenIssuer('https://cloudgate.example.com/', 'ca_1')).toBe(
      'https://cloudgate.example.com/ca_1',
    );
  });
});
