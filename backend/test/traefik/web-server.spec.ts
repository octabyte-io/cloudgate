import {
  DEFAULT_CONSOLE_PORT,
  createWebServerConfig,
  resolveConsoleUpstream,
  resolveGatewayUpstream,
} from '../../src/traefik/config/web-server';
import type { FileConfig } from '../../src/traefik/config/file-types';

describe('createWebServerConfig', () => {
  it('builds web + secure routers and the service for the cloudgate UI', () => {
    const config = createWebServerConfig(
      { http: { routers: {}, services: {} } },
      {
        host: 'panel.example.com',
        https: true,
        certificateType: 'letsencrypt',
        consoleUrl: 'http://203.0.113.10:3000',
      },
    );

    expect(config).toEqual({
      http: {
        routers: {
          'cloudgate-router-app': {
            rule: 'Host(`panel.example.com`)',
            service: 'cloudgate-service-app',
            entryPoints: ['web'],
            middlewares: ['redirect-to-https'],
          },
          'cloudgate-router-app-secure': {
            rule: 'Host(`panel.example.com`)',
            service: 'cloudgate-service-app',
            entryPoints: ['websecure'],
            tls: { certResolver: 'letsencrypt' },
          },
        },
        services: {
          'cloudgate-service-app': {
            loadBalancer: {
              servers: [{ url: 'http://203.0.113.10:3000' }],
              passHostHeader: true,
            },
          },
        },
      },
    });
  });

  it('drops the secure router and redirect middleware when https is off', () => {
    const existing: FileConfig = {
      http: {
        routers: {
          'cloudgate-router-app': {
            rule: 'Host(`old.example.com`)',
            service: 'cloudgate-service-app',
            entryPoints: ['web'],
            middlewares: ['redirect-to-https'],
          },
          'cloudgate-router-app-secure': {
            rule: 'Host(`old.example.com`)',
            service: 'cloudgate-service-app',
            entryPoints: ['websecure'],
            tls: { certResolver: 'letsencrypt' },
          },
        },
        services: {},
      },
    };

    const config = createWebServerConfig(existing, {
      host: 'panel.example.com',
      https: false,
      consoleUrl: 'http://203.0.113.10:3000',
    });

    expect(config.http?.routers?.['cloudgate-router-app']).toEqual({
      rule: 'Host(`panel.example.com`)',
      service: 'cloudgate-service-app',
      entryPoints: ['web'],
      middlewares: [],
    });
    expect(
      config.http?.routers?.['cloudgate-router-app-secure'],
    ).toBeUndefined();
  });
});

/**
 * The generated service used to point at `http://cloudgate:<PORT>` — a
 * container that only exists in a containerised deployment, on the *API* port
 * rather than the console's. On the native install this project ships
 * (`deploy/install.sh`) nothing answers there and the router 502s.
 */
describe('resolveConsoleUpstream', () => {
  it('never names the `cloudgate` container by default', () => {
    expect(resolveConsoleUpstream({})).not.toContain('//cloudgate:');
  });

  it("uses the install contract's public host and console port", () => {
    expect(
      resolveConsoleUpstream({
        CLOUDGATE_PUBLIC_HOST: '203.0.113.10',
        CONSOLE_PORT: 3000,
      }),
    ).toBe('http://203.0.113.10:3000');
  });

  it('defaults the console port when only the public host is set', () => {
    expect(
      resolveConsoleUpstream({ CLOUDGATE_PUBLIC_HOST: 'console.example.com' }),
    ).toBe(`http://console.example.com:${DEFAULT_CONSOLE_PORT}`);
  });

  it("falls back to BETTER_AUTH_URL, which the install sets to the console's origin", () => {
    expect(
      resolveConsoleUpstream({ BETTER_AUTH_URL: 'http://203.0.113.10:3000' }),
    ).toBe('http://203.0.113.10:3000');
    expect(
      resolveConsoleUpstream({
        BETTER_AUTH_URL: 'https://console.example.com',
      }),
    ).toBe('https://console.example.com:443');
  });

  it('prefers the explicit public host over BETTER_AUTH_URL', () => {
    expect(
      resolveConsoleUpstream({
        CLOUDGATE_PUBLIC_HOST: '10.0.0.5',
        BETTER_AUTH_URL: 'http://203.0.113.10:3000',
      }),
    ).toBe('http://10.0.0.5:3000');
  });

  it('lets CLOUDGATE_CONSOLE_URL name any upstream, container shapes included', () => {
    expect(
      resolveConsoleUpstream({
        CLOUDGATE_CONSOLE_URL: 'http://cloudgate:3000/',
        CLOUDGATE_PUBLIC_HOST: '203.0.113.10',
      }),
    ).toBe('http://cloudgate:3000');
  });

  it('brackets a bare IPv6 literal so the URL is well formed', () => {
    expect(
      resolveConsoleUpstream({
        CLOUDGATE_PUBLIC_HOST: '2001:db8::1',
        CONSOLE_PORT: 3000,
      }),
    ).toBe('http://[2001:db8::1]:3000');
  });

  it('ignores an unparseable BETTER_AUTH_URL rather than throwing', () => {
    expect(resolveConsoleUpstream({ BETTER_AUTH_URL: 'not a url' })).toBe(
      `http://127.0.0.1:${DEFAULT_CONSOLE_PORT}`,
    );
  });
});

/**
 * The Gateway's own routers on the console's host: its paths go
 * straight to the backend, not through the console's Next rewrite, which cuts
 * a request after 240 s of silence.
 */
describe("createWebServerConfig's Gateway routers", () => {
  const rule = 'Host(`panel.example.com`) && PathPrefix(`/ai/`)';

  it('routes the gateway path to the backend on web and websecure', () => {
    const config = createWebServerConfig(
      { http: { routers: {}, services: {} } },
      {
        host: 'panel.example.com',
        https: true,
        certificateType: 'letsencrypt',
        consoleUrl: 'http://203.0.113.10:3000',
        gatewayUrl: 'http://203.0.113.10:4000',
      },
    );

    expect(config.http?.routers?.['cloudgate-router-gateway']).toEqual({
      rule,
      service: 'cloudgate-service-gateway',
      entryPoints: ['web'],
      middlewares: ['redirect-to-https'],
    });
    expect(config.http?.routers?.['cloudgate-router-gateway-secure']).toEqual({
      rule,
      service: 'cloudgate-service-gateway',
      entryPoints: ['websecure'],
      tls: { certResolver: 'letsencrypt' },
    });
    expect(config.http?.services?.['cloudgate-service-gateway']).toEqual({
      loadBalancer: { servers: [{ url: 'http://203.0.113.10:4000' }] },
    });
  });

  it('drops the secure gateway router when https is off', () => {
    const config = createWebServerConfig(
      {
        http: {
          routers: {
            'cloudgate-router-gateway-secure': {
              rule,
              service: 'cloudgate-service-gateway',
              entryPoints: ['websecure'],
            },
          },
          services: {},
        },
      },
      {
        host: 'panel.example.com',
        https: false,
        consoleUrl: 'http://203.0.113.10:3000',
        gatewayUrl: 'http://203.0.113.10:4000',
      },
    );

    expect(config.http?.routers?.['cloudgate-router-gateway']).toEqual({
      rule,
      service: 'cloudgate-service-gateway',
      entryPoints: ['web'],
      middlewares: [],
    });
    expect(
      config.http?.routers?.['cloudgate-router-gateway-secure'],
    ).toBeUndefined();
  });

  it("resolves the backend at the console upstream's host on the backend's port", () => {
    expect(
      resolveGatewayUpstream('https://console.example.com:443', 4000),
    ).toBe('http://console.example.com:4000');
    expect(resolveGatewayUpstream('http://[2001:db8::1]:3000', 4000)).toBe(
      'http://[2001:db8::1]:4000',
    );
  });
});
