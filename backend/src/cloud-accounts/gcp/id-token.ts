import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

/**
 * The tokens Cloudgate signs for a Google Cloud account (the Google Cloud spec,
 * "Connecting"; S16). Federation only: each Cloud account has a key pair of
 * its own, the operator uploads its public half to an OIDC provider in a
 * workload identity pool, and Cloudgate trades a token signed with the
 * private half at STS. Google never fetches anything from Cloudgate — the
 * uploaded JWKS is all it reads — so the issuer needs no public
 * address; it is only a string the provider matches.
 *
 * Pure: no Google call, no database. The private half is PEM, which the
 * Cloud account row keeps encrypted (ADR-0006) and no response carries
 * (ADR-0019).
 */

/** A connect check's token lives 5 minutes (S16). */
export const CHECK_TOKEN_SECONDS = 5 * 60;

/** A Cloud run's token lives 2 hours; the provider renews its access from it (S16). */
export const RUN_TOKEN_SECONDS = 2 * 60 * 60;

/** A public half as the provider takes it in a JWKS. */
export interface PublicJwk extends JsonWebKey {
  kty: 'RSA';
  n: string;
  e: string;
  kid: string;
  alg: 'RS256';
  use: 'sig';
}

/** A Cloud account's key pair. */
export interface SigningKey {
  /** The private half, PKCS#8 PEM. */
  privateKey: string;
  /** Its tokens' `kid`: the public half's RFC 7638 thumbprint. */
  keyId: string;
  publicJwk: PublicJwk;
}

/** A new RSA 2048 key pair: RS256 is what Google accepts most widely (S16). */
export function makeSigningKey(): SigningKey {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return signingKeyOf(
    privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  );
}

/**
 * The whole key from its private half, which is all a Cloud account keeps of
 * a pending one: the public half and its id follow from it, so they cannot
 * drift from the key that signs.
 */
export function signingKeyOf(privatePem: string): SigningKey {
  const { n, e } = createPublicKey(privatePem).export({ format: 'jwk' }) as {
    n: string;
    e: string;
  };
  const keyId = createHash('sha256')
    .update(JSON.stringify({ e, kty: 'RSA', n }))
    .digest('base64url');
  return {
    privateKey: privatePem,
    keyId,
    publicJwk: { kty: 'RSA', n, e, kid: keyId, alg: 'RS256', use: 'sig' },
  };
}

/** The JWKS the operator uploads: every public half handed in, in order. */
export function jwksOf(keys: readonly PublicJwk[]): { keys: PublicJwk[] } {
  return { keys: [...keys] };
}

/**
 * The issuer of a Cloud account's tokens: the install's own address followed
 * by the Cloud account's id (S16). Always `https`, whatever the install
 * answers on: Google requires an `https` issuer on an OIDC provider, and
 * never fetches it when the JWKS is uploaded.
 */
export function tokenIssuer(
  installUrl: string,
  cloudAccountId: string,
): string {
  return `https://${new URL(installUrl).host}/${cloudAccountId}`;
}

/** The subject the provider's condition holds a token to (S16). */
export function tokenSubject(cloudAccountId: string): string {
  return `cloudgate:${cloudAccountId}`;
}

/** The audience of a token: the OIDC provider's full resource name. */
export function tokenAudience(workloadIdentityProvider: string): string {
  return `//iam.googleapis.com/${workloadIdentityProvider}`;
}

export interface IdTokenClaims {
  issuer: string;
  subject: string;
  /** The provider's resource name, `projects/<number>/locations/global/…`. */
  workloadIdentityProvider: string;
  lifetimeSeconds: number;
  now?: Date;
}

/** A signed ID token, RS256, `kid` naming the key (S16). */
export function signIdToken(
  key: Pick<SigningKey, 'privateKey' | 'keyId'>,
  claims: IdTokenClaims,
): string {
  const iat = Math.floor((claims.now ?? new Date()).getTime() / 1000);
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: key.keyId });
  const payload = encode({
    iss: claims.issuer,
    sub: claims.subject,
    aud: tokenAudience(claims.workloadIdentityProvider),
    iat,
    exp: iat + claims.lifetimeSeconds,
  });
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    key.privateKey,
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
