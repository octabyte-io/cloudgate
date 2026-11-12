import { createBasicAuthMiddleware } from '../../src/traefik/config/security';

describe('createBasicAuthMiddleware', () => {
  it('builds the auth middleware from pre-hashed users, stripping the header', () => {
    const fragment = createBasicAuthMiddleware('api', [
      'admin:$2b$10$hashedhashedhashedhashed',
      'viewer:$2b$10$otherhashotherhashother',
    ]);

    expect(fragment).toEqual({
      'auth-api': {
        basicAuth: {
          removeHeader: true,
          users: [
            'admin:$2b$10$hashedhashedhashedhashed',
            'viewer:$2b$10$otherhashotherhashother',
          ],
        },
      },
    });
  });
});
