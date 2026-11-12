import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The profile a fake IdP hands back from its userinfo endpoint. */
export interface FakeIdpProfile {
  sub: string;
  email: string;
  name: string;
  /** Whether the IdP vouches for the address; drives account linking. */
  email_verified?: boolean;
  [claim: string]: unknown;
}

export interface FakeIdp {
  /** e.g. `http://127.0.0.1:54321` — allowlist this as a trusted origin. */
  origin: string;
  /** Authorization codes the token endpoint will accept. */
  profile: FakeIdpProfile;
  /** Bodies the token endpoint received, in order. */
  tokenRequests: string[];
  /**
   * `Authorization` headers the token endpoint received, in order — with
   * `client_secret_basic` the client credentials arrive here rather than in the
   * body, so this is where the secret the server actually holds shows up.
   */
  tokenAuthorizations: string[];
  close(): Promise<void>;
}

/**
 * A stand-in identity provider on loopback. The IdP is the one boundary the SSO
 * flow crosses, so it is faked as a real server rather than by stubbing
 * anything inside better-auth: the plugin performs its genuine code exchange
 * and userinfo fetch against this.
 *
 * With a `userInfoEndpoint` configured the plugin reads the profile from there
 * and never verifies an `id_token`, so no signing keys are needed.
 *
 * **It also serves `/.well-known/openid-configuration`**, which is what a
 * registration that leaves the endpoint fields empty reaches — the path the
 * console calls the normal one and the only path on which the trusted-origins
 * gate fires.
 * `providerAtIdp` still sends the endpoints explicitly; `discoveredAtIdp` is
 * the body that does not.
 */
export async function startFakeIdp(profile: FakeIdpProfile): Promise<FakeIdp> {
  const tokenRequests: string[] = [];
  const tokenAuthorizations: string[] = [];
  let origin = '';

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

    if (path === '/.well-known/openid-configuration') {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          userinfo_endpoint: `${origin}/userinfo`,
          jwks_uri: `${origin}/jwks`,
          scopes_supported: ['openid', 'email', 'profile'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        }),
      );
      return;
    }

    if (path === '/token' && req.method === 'POST') {
      tokenAuthorizations.push(req.headers.authorization ?? '');
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        tokenRequests.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'fake-idp-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'openid email profile',
          }),
        );
      });
      return;
    }

    // Never reached while a userinfo endpoint is configured, but a provider
    // without a jwks endpoint sends the plugin to OIDC discovery on every
    // sign-in, so a complete config declares one.
    if (path === '/jwks') {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [] }));
      return;
    }

    if (path === '/userinfo') {
      req.resume();
      if (req.headers.authorization !== 'Bearer fake-idp-access-token') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(profile));
      return;
    }

    req.resume();
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // The document has to name the issuer the plugin was configured with, and the
  // port is only known now — so the handler reads it rather than closing over a
  // value that does not exist yet.
  origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    profile,
    tokenRequests,
    tokenAuthorizations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A registration that names no endpoints, so the plugin discovers them. This is
 * the shape the Add dialog sends when the four endpoint fields are left empty,
 * and the one the trusted-origins gate refuses on an empty list.
 */
export const discoveredAtIdp = (
  idp: FakeIdp,
  overrides: { providerId?: string; domains?: string[] } = {},
) => ({
  providerId: overrides.providerId ?? 'discovered-oidc',
  issuer: idp.origin,
  domains: overrides.domains ?? ['discovered.example.com'],
  oidcConfig: {
    clientId: 'discovered-client',
    clientSecret: 'discovered-secret',
  },
});

/** A registration payload pointing at a running fake IdP. */
export const providerAtIdp = (
  idp: FakeIdp,
  overrides: { providerId?: string; domains?: string[] } = {},
) => ({
  providerId: overrides.providerId ?? 'acme-oidc',
  issuer: idp.origin,
  domains: overrides.domains ?? ['acme.example.com'],
  oidcConfig: {
    clientId: 'acme-client',
    clientSecret: 'acme-secret',
    authorizationEndpoint: `${idp.origin}/authorize`,
    tokenEndpoint: `${idp.origin}/token`,
    userInfoEndpoint: `${idp.origin}/userinfo`,
    jwksEndpoint: `${idp.origin}/jwks`,
    skipDiscovery: true,
    pkce: false,
  },
});
