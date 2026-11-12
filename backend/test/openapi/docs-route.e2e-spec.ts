import request from 'supertest';
import { App } from 'supertest/types';
import { mountOpenApiDocument } from '../../src/openapi';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<string> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  return res.headers['set-cookie'];
}

/**
 * `/docs` is behind the session.
 *
 * Swagger registers straight onto Express, so the app-wide `AuthGuard` never
 * runs for these paths — nothing else in the suite would notice them being
 * public. The two document paths are siblings of `/docs` rather than children,
 * so each is asserted by name: a prefix-mounted guard passes the first case
 * below and leaks the other two, which is the mistake this file exists to
 * catch.
 */
describe('the OpenAPI document is served to signed-in callers only', () => {
  let ctx: TestAppContext;
  let server: App;

  beforeAll(async () => {
    // Mounted through beforeInit for the same reason main.ts mounts before
    // listen: init() puts Nest's router in place, and Express middleware added
    // after it never runs.
    ctx = await createTestApp({ beforeInit: mountOpenApiDocument });
    server = ctx.app.getHttpServer() as App;
  }, 120_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  describe('without a session', () => {
    it.each([['/docs'], ['/docs-json'], ['/docs-yaml']])(
      'refuses %s',
      async (path) => {
        const res = await request(server).get(path);
        expect(res.status).toBe(401);
      },
    );

    it('does not leak the surface in the refusal', async () => {
      const res = await request(server).get('/docs-json');
      expect(res.status).toBe(401);
      expect(res.text).not.toContain('/organizations');
      expect(res.text).not.toContain('paths');
    });
  });

  describe('with a session', () => {
    let cookie: string;

    beforeAll(async () => {
      cookie = await signUp(server, owner);
    });

    it('serves the document', async () => {
      const res = await request(server)
        .get('/docs-json')
        .set('Cookie', cookie)
        .expect(200);

      const doc = res.body as {
        openapi: string;
        paths: Record<string, object>;
      };
      expect(doc.openapi).toMatch(/^3\./);
      // A real document, not an empty shell that would pass the status check.
      expect(Object.keys(doc.paths).length).toBeGreaterThan(100);
    });

    it('serves the UI', async () => {
      const res = await request(server)
        .get('/docs')
        .set('Cookie', cookie)
        .expect(200);

      expect(res.text).toContain('swagger');
    });
  });

  it('leaves the rest of the API alone', async () => {
    // The middleware runs on every request; a path that merely starts with the
    // same letters is not the document and must reach its own handler, which
    // answers with the app-wide guard's 401 rather than the middleware's.
    await request(server).get('/organizations').expect(401);
  });
});
