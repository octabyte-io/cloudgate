import {
  buildForwardAuthEnv,
  deriveBaseDomain,
  deriveCookieSecret,
  forwardAuthCallbackUrl,
} from '../../../src/enterprise/forward-auth/forward-auth.utils';

describe('deriveBaseDomain', () => {
  it('drops the first label of a subdomain so the cookie covers its siblings', () => {
    expect(deriveBaseDomain('auth.example.com')).toBe('.example.com');
    expect(deriveBaseDomain('sso.internal.example.org')).toBe(
      '.internal.example.org',
    );
  });

  it('keeps both labels of an apex domain', () => {
    expect(deriveBaseDomain('example.com')).toBe('.example.com');
  });

  it('normalizes case and stray whitespace', () => {
    expect(deriveBaseDomain('  AUTH.Example.COM  ')).toBe('.example.com');
  });
});

describe('forwardAuthCallbackUrl', () => {
  it('is the /oauth2/callback path on the auth domain, on either scheme', () => {
    expect(forwardAuthCallbackUrl('auth.example.com', true)).toBe(
      'https://auth.example.com/oauth2/callback',
    );
    expect(forwardAuthCallbackUrl('auth.example.com', false)).toBe(
      'http://auth.example.com/oauth2/callback',
    );
  });
});

describe('deriveCookieSecret', () => {
  const secret = 'test-auth-secret-at-least-32-chars-long';

  it('is 16 bytes of hex, as oauth2-proxy requires', () => {
    const derived = deriveCookieSecret(secret, 'host:.example.com');
    expect(derived).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is stable for a salt and different for another', () => {
    expect(deriveCookieSecret(secret, 'host:.example.com')).toBe(
      deriveCookieSecret(secret, 'host:.example.com'),
    );
    expect(deriveCookieSecret(secret, 'host:.example.com')).not.toBe(
      deriveCookieSecret(secret, 'srv-1:.example.com'),
    );
  });

  it('is different under a different auth secret', () => {
    expect(deriveCookieSecret(secret, 'host:.example.com')).not.toBe(
      deriveCookieSecret(
        'another-auth-secret-thats-32-chars-x',
        'host:.example.com',
      ),
    );
  });
});

describe('buildForwardAuthEnv', () => {
  const options = {
    oidc: {
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      issuer: 'https://idp.example.com',
    },
    cookieSecret: '0123456789abcdef0123456789abcdef',
    authDomain: 'auth.example.com',
    baseDomain: '.example.com',
    authDomainHttps: true,
  };

  it('configures oauth2-proxy as an OIDC gate in front of the auth domain', () => {
    expect(buildForwardAuthEnv(options)).toEqual([
      'OAUTH2_PROXY_PROVIDER=oidc',
      'OAUTH2_PROXY_OIDC_ISSUER_URL=https://idp.example.com',
      'OAUTH2_PROXY_CLIENT_ID=client-abc',
      'OAUTH2_PROXY_CLIENT_SECRET=secret-xyz',
      'OAUTH2_PROXY_COOKIE_SECRET=0123456789abcdef0123456789abcdef',
      'OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:4180',
      'OAUTH2_PROXY_REVERSE_PROXY=true',
      'OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true',
      'OAUTH2_PROXY_SET_XAUTHREQUEST=true',
      'OAUTH2_PROXY_UPSTREAMS=static://202',
      'OAUTH2_PROXY_REDIRECT_URL=https://auth.example.com/oauth2/callback',
      'OAUTH2_PROXY_COOKIE_DOMAINS=.example.com',
      'OAUTH2_PROXY_WHITELIST_DOMAINS=.example.com',
      'OAUTH2_PROXY_COOKIE_SECURE=true',
      'OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true',
      'OAUTH2_PROXY_EMAIL_DOMAINS=*',
      'OAUTH2_PROXY_SCOPE=openid email profile',
    ]);
  });

  it('marks the cookie insecure on a plain-http auth domain', () => {
    const env = buildForwardAuthEnv({ ...options, authDomainHttps: false });

    expect(env).toContain('OAUTH2_PROXY_COOKIE_SECURE=false');
    expect(env).toContain(
      'OAUTH2_PROXY_REDIRECT_URL=http://auth.example.com/oauth2/callback',
    );
  });

  it('takes the provider scopes and email domains when they are given', () => {
    const env = buildForwardAuthEnv({
      ...options,
      oidc: { ...options.oidc, scopes: ['openid', 'groups'] },
      emailDomains: ['example.com', 'example.org'],
    });

    expect(env).toContain('OAUTH2_PROXY_SCOPE=openid groups');
    expect(env).toContain('OAUTH2_PROXY_EMAIL_DOMAINS=example.com,example.org');
  });

  it('skips discovery only when the provider asks it to', () => {
    expect(buildForwardAuthEnv(options)).not.toContain(
      'OAUTH2_PROXY_SKIP_OIDC_DISCOVERY=true',
    );
    expect(
      buildForwardAuthEnv({
        ...options,
        oidc: { ...options.oidc, skipDiscovery: true },
      }),
    ).toContain('OAUTH2_PROXY_SKIP_OIDC_DISCOVERY=true');
  });
});
