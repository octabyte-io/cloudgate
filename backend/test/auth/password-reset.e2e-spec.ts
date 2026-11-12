import request from 'supertest';
import { App } from 'supertest/types';
import { MailService } from '../../src/mail/mail.service';
import type { RenderedEmail } from '../../src/mail/templates';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

// The password-reset flow end to end: better-auth only mints a
// reset token when `emailAndPassword.sendResetPassword` is configured, so this
// pins the whole round trip — request the reset, read the link out of the mail
// the instance actually sent, spend it, sign in with the new password.
//
// MailService is the boundary here: the senders (nodemailer / Resend) talk to
// the outside world, so the service is replaced with a recorder. Everything on
// this side of it — the better-auth hook, the template render — runs for real.

const signUpBody = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'super-secret-password',
};

const NEW_PASSWORD = 'a-brand-new-password';

interface SentMail {
  to: string;
  email: RenderedEmail;
}

/** The path the link should land on, exactly as the /forgot-password screen sends it. */
const REDIRECT_TO = '/reset-password';

describe('Password reset (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let sent: SentMail[];
  const providerBefore = process.env.MAIL_PROVIDER;

  beforeAll(async () => {
    // A configured instance: the recorder below stands in for the sender, but
    // the wiring only hands better-auth a sender when MAIL_PROVIDER is set.
    process.env.MAIL_PROVIDER = 'resend';
    sent = [];
    const mailRecorder = {
      send: (to: string, email: RenderedEmail) => {
        sent.push({ to, email });
        return Promise.resolve();
      },
    };
    ctx = await createTestApp({
      overrideProviders: [{ provide: MailService, useValue: mailRecorder }],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
    if (providerBefore === undefined) delete process.env.MAIL_PROVIDER;
    else process.env.MAIL_PROVIDER = providerBefore;
  });

  beforeEach(async () => {
    await ctx.resetDb();
    sent.length = 0;
  });

  const signUp = () =>
    request(server).post('/api/auth/sign-up/email').send(signUpBody);

  it('emails a reset link that sets a new password the account can sign in with', async () => {
    await signUp();

    const requested = await request(server)
      .post('/api/auth/request-password-reset')
      .send({ email: signUpBody.email, redirectTo: REDIRECT_TO });

    expect(requested.status).toBe(200);

    // One email, to the account's own address, rendered from the template.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ada@example.com');
    expect(sent[0].email.subject).toBe('Reset your password');
    expect(sent[0].email.html).toMatch(/Hello (<!-- -->)?Ada/);

    // The link in the email is the only way to the token: pull it out and
    // follow it the way a recipient's browser would.
    const link =
      /https?:\/\/[^"'\s]*\/reset-password\/[^"'\s?]+\?[^"'\s]*/.exec(
        sent[0].email.html,
      )?.[0];
    expect(link).toBeDefined();

    const callback = await request(server).get(
      new URL(link as string).pathname +
        new URL(link as string).search.replace(/&amp;/g, '&'),
    );

    // better-auth checks the token, then forwards to the screen with `?token=`.
    expect(callback.status).toBe(302);
    const forwarded = new URL(callback.headers.location, 'http://localhost');
    expect(forwarded.pathname).toBe(REDIRECT_TO);
    const token = forwarded.searchParams.get('token');
    expect(token).toBeTruthy();

    const reset = await request(server)
      .post('/api/auth/reset-password')
      .send({ newPassword: NEW_PASSWORD, token });

    expect(reset.status).toBe(200);

    const withNew = await request(server)
      .post('/api/auth/sign-in/email')
      .send({ email: signUpBody.email, password: NEW_PASSWORD });
    expect(withNew.status).toBe(200);

    const withOld = await request(server)
      .post('/api/auth/sign-in/email')
      .send({ email: signUpBody.email, password: signUpBody.password });
    expect(withOld.status).toBe(401);
  });

  it('answers the same for an address with no account, and sends nothing', async () => {
    await signUp();

    const requested = await request(server)
      .post('/api/auth/request-password-reset')
      .send({ email: 'nobody@example.com', redirectTo: REDIRECT_TO });

    expect(requested.status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});
