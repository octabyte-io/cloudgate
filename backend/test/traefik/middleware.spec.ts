import {
  addMiddleware,
  createPathMiddlewares,
  deleteMiddleware,
} from '../../src/traefik/config/middleware';
import type { FileConfig } from '../../src/traefik/config/file-types';

describe('createPathMiddlewares', () => {
  it('builds stripprefix and addprefix middlewares for a pathed domain', () => {
    const fragment = createPathMiddlewares('shop', {
      host: 'shop.example.com',
      https: false,
      uniqueConfigKey: 2,
      path: '/store',
      stripPath: true,
      internalPath: '/internal',
    });

    expect(fragment).toEqual({
      'addprefix-shop-2': { addPrefix: { prefix: '/internal' } },
      'stripprefix-shop-2': { stripPrefix: { prefixes: ['/store'] } },
    });
  });

  it('returns an empty fragment when the domain needs no path rewriting', () => {
    const fragment = createPathMiddlewares('shop', {
      host: 'shop.example.com',
      https: false,
      uniqueConfigKey: 3,
      path: '/',
    });

    expect(fragment).toEqual({});
  });
});

describe('addMiddleware / deleteMiddleware', () => {
  const makeConfig = (): FileConfig => ({
    http: {
      routers: {
        'api-router-1': {
          rule: 'Host(`a.example.com`)',
          service: 'api-service-1',
          middlewares: ['auth-api'],
        },
        'api-router-2': {
          rule: 'Host(`b.example.com`)',
          service: 'api-service-2',
        },
      },
    },
  });

  it('attaches the middleware to every router exactly once', () => {
    const config = makeConfig();

    addMiddleware(config, 'auth-api');

    expect(config.http?.routers?.['api-router-1']?.middlewares).toEqual([
      'auth-api',
    ]);
    expect(config.http?.routers?.['api-router-2']?.middlewares).toEqual([
      'auth-api',
    ]);
  });

  it('detaches the middleware from every router', () => {
    const config = makeConfig();

    deleteMiddleware(config, 'auth-api');

    expect(config.http?.routers?.['api-router-1']?.middlewares).toEqual([]);
    expect(config.http?.routers?.['api-router-2']?.middlewares).toBeUndefined();
  });
});
