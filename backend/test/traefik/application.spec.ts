import { createTraefikConfig } from '../../src/traefik/config/application';

describe('createTraefikConfig', () => {
  it('builds web + websecure routers and the service for an https domain', () => {
    const config = createTraefikConfig(
      { appName: 'api', redirects: [], security: [] },
      [
        {
          host: 'api.example.com',
          port: 8080,
          https: true,
          uniqueConfigKey: 1,
          certificateType: 'letsencrypt',
        },
      ],
    );

    expect(config).toEqual({
      http: {
        routers: {
          'api-router-1': {
            rule: 'Host(`api.example.com`)',
            service: 'api-service-1',
            middlewares: ['redirect-to-https'],
            entryPoints: ['web'],
          },
          'api-router-websecure-1': {
            rule: 'Host(`api.example.com`)',
            service: 'api-service-1',
            middlewares: [],
            entryPoints: ['websecure'],
            tls: { certResolver: 'letsencrypt' },
          },
        },
        services: {
          'api-service-1': {
            loadBalancer: {
              servers: [{ url: 'http://api:8080' }],
              passHostHeader: true,
            },
          },
        },
      },
    });
  });
});
