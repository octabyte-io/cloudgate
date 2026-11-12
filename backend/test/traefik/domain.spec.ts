import {
  addDomainToConfig,
  createRouterConfig,
  removeDomainFromConfig,
} from '../../src/traefik/config/domain';
import type { FileConfig } from '../../src/traefik/config/file-types';
import { createPathMiddlewares } from '../../src/traefik/config/middleware';

describe('createRouterConfig', () => {
  it('adds a path rule and strip/addprefix middlewares for a pathed domain', () => {
    const router = createRouterConfig(
      { appName: 'shop', redirects: [], security: [] },
      {
        host: 'shop.example.com',
        https: false,
        uniqueConfigKey: 2,
        path: '/store',
        stripPath: true,
        internalPath: '/internal',
      },
      'web',
    );

    expect(router).toEqual({
      rule: 'Host(`shop.example.com`) && (PathPrefix(`/store/`) || Path(`/store`))',
      service: 'shop-service-2',
      middlewares: ['stripprefix-shop-2', 'addprefix-shop-2'],
      entryPoints: ['web'],
    });
  });

  it('orders redirect, auth, forward-auth (errors first) and custom middlewares', () => {
    const router = createRouterConfig(
      {
        appName: 'crm',
        redirects: [{ uniqueConfigKey: 1 }, { uniqueConfigKey: 3 }],
        security: [{ username: 'admin' }],
      },
      {
        host: 'crm.example.com',
        https: true,
        uniqueConfigKey: 1,
        certificateType: 'letsencrypt',
        forwardAuthEnabled: true,
        middlewares: ['my-custom-mw'],
      },
      'websecure',
    );

    expect(router.middlewares).toEqual([
      'redirect-crm-1',
      'redirect-crm-3',
      'auth-crm',
      'forward-auth-crm-1-errors',
      'forward-auth-crm-1',
      'my-custom-mw',
    ]);
  });

  it('punycodes IDN hosts and applies a custom cert resolver on a custom entrypoint', () => {
    const router = createRouterConfig(
      { appName: 'blog', redirects: [], security: [] },
      {
        host: 'тест.рф',
        https: true,
        uniqueConfigKey: 5,
        certificateType: 'custom',
        customCertResolver: 'my-resolver',
        customEntrypoint: 'intranet',
      },
      'intranet',
    );

    expect(router).toEqual({
      rule: 'Host(`xn--e1aybc.xn--p1ai`)',
      service: 'blog-service-5',
      middlewares: [],
      entryPoints: ['intranet'],
      tls: { certResolver: 'my-resolver' },
    });
  });
});

/**
 * The `tls` block each Certificate choice puts on the websecure router.
 *
 * `stored` is the one that emits `tls: {}` — TLS on, no resolver — so Traefik
 * serves the certificate from Settings → Certificates whose names cover the host
 * (the file provider's `tls.certificates`, matched by SNI). `none` emits no block
 * at all, which is why the console refuses HTTPS with it.
 */
describe('createRouterConfig — the tls block for each certificate choice', () => {
  const app = { appName: 'shop', redirects: [], security: [] };
  const tlsOf = (
    certificateType: 'none' | 'letsencrypt' | 'custom' | 'stored',
    entryPoint = 'websecure',
    customEntrypoint: string | null = null,
  ) =>
    createRouterConfig(
      app,
      {
        host: 'shop.example.com',
        https: true,
        uniqueConfigKey: 1,
        certificateType,
        customCertResolver: certificateType === 'custom' ? 'myresolver' : null,
        customEntrypoint,
      },
      entryPoint,
    ).tls;

  it.each([
    ['letsencrypt', { certResolver: 'letsencrypt' }],
    ['custom', { certResolver: 'myresolver' }],
    ['stored', {}],
    ['none', undefined],
  ] as const)('%s → %j on the websecure router', (certificateType, tls) => {
    expect(tlsOf(certificateType)).toEqual(tls);
  });

  it('emits the same empty block for a stored certificate on a custom entrypoint', () => {
    expect(tlsOf('stored', 'intranet', 'intranet')).toEqual({});
  });

  it('puts no tls block on the web router, which only redirects', () => {
    expect(tlsOf('stored', 'web')).toBeUndefined();
  });
});

/**
 * A Domain's `path` matches on a segment boundary: `/api` is `/api` and
 * everything below `/api/`, never `/apix`. Traefik's own `PathPrefix` is a
 * plain string prefix, so the rule the builder emits has to say so itself.
 */
describe('createRouterConfig — the path matches on a segment boundary', () => {
  const app = { appName: 'web', redirects: [], security: [] };
  const route = (path: string | null, stripPath = false) =>
    createRouterConfig(
      app,
      {
        host: 'whoami.example.com',
        https: false,
        uniqueConfigKey: 2,
        path,
        stripPath,
      },
      'web',
    );

  it('routes /api and everything under /api/, and not /apix', () => {
    expect(route('/api').rule).toBe(
      'Host(`whoami.example.com`) && (PathPrefix(`/api/`) || Path(`/api`))',
    );
  });

  it('keeps a path that already ends in / as a plain prefix of its own', () => {
    expect(route('/api/').rule).toBe(
      'Host(`whoami.example.com`) && PathPrefix(`/api/`)',
    );
  });

  it('adds no path clause for / or no path — the whole host', () => {
    expect(route('/').rule).toBe('Host(`whoami.example.com`)');
    expect(route(null).rule).toBe('Host(`whoami.example.com`)');
  });

  it('still strips the path as the operator wrote it, so /api arrives as /', () => {
    const config: FileConfig = {};
    addDomainToConfig(config, app, {
      host: 'whoami.example.com',
      https: false,
      uniqueConfigKey: 2,
      path: '/api',
      stripPath: true,
    });
    expect(config.http?.routers?.['web-router-2']?.middlewares).toEqual([
      'stripprefix-web-2',
    ]);
    // Not `/api/`: stripping `/api/` would leave a request for exactly `/api`
    // untouched, and `/api/x` would arrive as `x` for Traefik to re-slash.
    expect(
      createPathMiddlewares('web', {
        host: 'whoami.example.com',
        https: false,
        uniqueConfigKey: 2,
        path: '/api',
        stripPath: true,
      }),
    ).toEqual({ 'stripprefix-web-2': { stripPrefix: { prefixes: ['/api'] } } });
  });

  // No domain router sets `priority`, so Traefik ranks them by rule length.
  // The boundary clause must not upset the order a longer path wins by.
  it('ranks a deeper path above a shallower one, and both above the whole host', () => {
    const rules = ['/', '/api', '/api/v2'].map((p) => route(p).rule);
    expect(rules.map((r) => r.length)).toEqual(
      [...rules.map((r) => r.length)].sort((a, b) => a - b),
    );
    expect(new Set(rules.map((r) => r.length)).size).toBe(3);
    expect(route('/api').priority).toBeUndefined();
  });
});

describe('addDomainToConfig', () => {
  it('merges a domain without clobbering routers of other domains', () => {
    const existing: FileConfig = {
      http: {
        routers: {
          'api-router-1': {
            rule: 'Host(`old.example.com`)',
            service: 'api-service-1',
            entryPoints: ['web'],
          },
          'api-router-websecure-2': {
            rule: 'Host(`two.example.com`)',
            service: 'api-service-2',
            entryPoints: ['websecure'],
          },
        },
        services: {
          'api-service-1': {
            loadBalancer: {
              servers: [{ url: 'http://api:80' }],
              passHostHeader: true,
            },
          },
        },
      },
    };

    addDomainToConfig(
      existing,
      { appName: 'api', redirects: [], security: [] },
      { host: 'two.example.com', https: false, uniqueConfigKey: 2, port: 3000 },
    );

    // untouched sibling domain survives
    expect(existing.http?.routers?.['api-router-1']?.rule).toBe(
      'Host(`old.example.com`)',
    );
    // the domain's own routers are (re)written; stale websecure is dropped
    expect(existing.http?.routers?.['api-router-2']).toEqual({
      rule: 'Host(`two.example.com`)',
      service: 'api-service-2',
      middlewares: [],
      entryPoints: ['web'],
    });
    expect(existing.http?.routers?.['api-router-websecure-2']).toBeUndefined();
    expect(existing.http?.services?.['api-service-2']).toEqual({
      loadBalancer: {
        servers: [{ url: 'http://api:3000' }],
        passHostHeader: true,
      },
    });
  });
});

describe('removeDomainFromConfig', () => {
  it('removes only the domain’s routers and service, leaving siblings intact', () => {
    const config: FileConfig = { http: { routers: {}, services: {} } };
    const app = { appName: 'api', redirects: [], security: [] };
    addDomainToConfig(config, app, {
      host: 'one.example.com',
      https: true,
      uniqueConfigKey: 1,
      certificateType: 'letsencrypt',
    });
    addDomainToConfig(config, app, {
      host: 'two.example.com',
      https: false,
      uniqueConfigKey: 2,
    });

    removeDomainFromConfig(config, 'api', 1);

    expect(Object.keys(config.http?.routers ?? {})).toEqual(['api-router-2']);
    expect(Object.keys(config.http?.services ?? {})).toEqual(['api-service-2']);
  });
});
