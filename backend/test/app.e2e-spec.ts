import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp, TestAppContext } from './utils/test-app';

jest.setTimeout(120_000);

/**
 * Through `createTestApp` like every other e2e file, and not the Nest CLI
 * scaffold this started as. The scaffold imported `AppModule` at the top and
 * compiled it bare, so `ConfigModule` validated whatever `backend/.env` held:
 * a working copy's own `DATABASE_URL`, the developer's database, and on a
 * fresh checkout — the GitHub runner — nothing, which red this file on every
 * run there with "Invalid environment variables".
 */
describe('AppController (e2e)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  it('/ (GET)', () => {
    return request(ctx.app.getHttpServer() as App)
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });
});
