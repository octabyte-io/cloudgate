import {
  buildAuthDomainRouter,
  createForwardAuthMiddlewares,
} from '../../src/traefik/config/forward-auth';

describe('createForwardAuthMiddlewares', () => {
  it('builds the forwardAuth middleware and its 401→302 errors companion', () => {
    const fragment = createForwardAuthMiddlewares('crm', 1, {
      authDomain: 'auth.example.com',
      https: true,
    });

    expect(fragment).toEqual({
      'forward-auth-crm-1': {
        forwardAuth: {
          address: 'https://auth.example.com/oauth2/auth',
          trustForwardHeader: true,
          authResponseHeaders: [
            'X-Auth-Request-User',
            'X-Auth-Request-Email',
            'X-Auth-Request-Preferred-Username',
            'Authorization',
          ],
        },
      },
      'forward-auth-crm-1-errors': {
        errors: {
          status: ['401-403'],
          service: 'forward-auth-proxy',
          query: '/oauth2/sign_in?rd={url}',
          statusRewrites: { '401': 302 },
        },
      },
    });
  });
});

describe('buildAuthDomainRouter', () => {
  it('routes /oauth2/ on the auth domain to the proxy with letsencrypt tls', () => {
    const config = buildAuthDomainRouter({
      authDomain: 'auth.example.com',
      https: true,
      certificateType: 'letsencrypt',
    });

    expect(config).toEqual({
      http: {
        routers: {
          'forward-auth-oauth': {
            rule: 'Host(`auth.example.com`) && PathPrefix(`/oauth2/`)',
            service: 'forward-auth-proxy',
            entryPoints: ['websecure'],
            priority: 1000,
            tls: { certResolver: 'letsencrypt' },
          },
        },
        services: {
          'forward-auth-proxy': {
            loadBalancer: {
              servers: [{ url: 'http://cloudgate-forward-auth:4180' }],
              passHostHeader: true,
            },
          },
        },
      },
    });
  });
});
