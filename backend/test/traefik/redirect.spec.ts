import { createRedirectMiddleware } from '../../src/traefik/config/redirect';

describe('createRedirectMiddleware', () => {
  it('builds a redirectRegex middleware keyed by app and unique key', () => {
    const fragment = createRedirectMiddleware('api', {
      uniqueConfigKey: 2,
      regex: '^https?://www\\.(.+)',
      replacement: 'https://${1}',
      permanent: true,
    });

    expect(fragment).toEqual({
      'redirect-api-2': {
        redirectRegex: {
          regex: '^https?://www\\.(.+)',
          replacement: 'https://${1}',
          permanent: true,
        },
      },
    });
  });
});
