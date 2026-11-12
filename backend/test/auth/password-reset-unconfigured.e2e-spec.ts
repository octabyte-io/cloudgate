import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

// The other half of the password-reset fix: an instance with no mail sender
// configured still has nowhere to send a reset link, so better-auth is handed no
// `sendResetPassword` at all and keeps refusing with RESET_PASSWORD_DISABLED.
// /forgot-password renders that code as its own "this instance cannot send
// email yet" state, which is the honest answer — accepting the request and
// failing on the send would not be.
//
// Lives in its own file because ConfigModule snapshots the environment when
// app.module is first imported, so MAIL_PROVIDER cannot vary within one suite.

describe('Password reset without a mail sender (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  const providerBefore = process.env.MAIL_PROVIDER;

  beforeAll(async () => {
    delete process.env.MAIL_PROVIDER;
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
    if (providerBefore !== undefined)
      process.env.MAIL_PROVIDER = providerBefore;
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  it('refuses a reset request with RESET_PASSWORD_DISABLED', async () => {
    await request(server).post('/api/auth/sign-up/email').send({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'super-secret-password',
    });

    const requested = await request(server)
      .post('/api/auth/request-password-reset')
      .send({ email: 'ada@example.com', redirectTo: '/reset-password' });

    expect(requested.status).toBe(400);
    expect(requested.body).toMatchObject({ code: 'RESET_PASSWORD_DISABLED' });
  });
});
