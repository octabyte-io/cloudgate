// A Self-hosted instance, with provider tokens left over in its environment.
// Set before the app module is imported: ConfigModule snapshots the
// environment on first load.
delete process.env.HOSTED_MODE;
process.env.HETZNER_EUR_API_TOKEN = 'left-over-eur-token';
process.env.HETZNER_USD_API_TOKEN = 'left-over-usd-token';

import request from 'supertest';
import { App } from 'supertest/types';

import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

/**
 * Off hosted mode the feature does not exist (ADR-0071, #1388): both routes
 * answer a bare 404, as the Operator page's do, whatever tokens the
 * environment holds, and the provider is never asked.
 */
describe('Bought Servers on a Self-hosted instance (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    http = ctx.app.getHttpServer() as App;
    await ctx.resetDb();
    const signUp = await request(http).post('/api/auth/sign-up/email').send({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'super-secret-password',
    });
    expect(signUp.status).toBe(200);
    cookie = signUp.headers['set-cookie'];
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it.each(['/bought-servers/offer', '/bought-servers/catalogue'])(
    '%s does not exist',
    async (path) => {
      const res = await request(http).get(path).set('Cookie', cookie);

      expect(res.status).toBe(404);
      expect(ctx.hetzner.prices.calls).toEqual([]);
      expect(ctx.hetzner.machines.calls).toEqual([]);
    },
  );
});
