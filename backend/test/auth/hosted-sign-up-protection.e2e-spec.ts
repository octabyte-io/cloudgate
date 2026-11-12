// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
const hosted = useHostedMode();
// The origin better-auth builds its links on, as every install sets it; the
// change-of-email link is minted in-process with no request to infer it from.
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { CONFIRMATION_EMAIL_WINDOW_MS } from '../../src/auth/confirmation-email-limit';
import { user } from '../../src/db/schema';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { MailService } from '../../src/mail/mail.service';
import { PASSING_TURNSTILE } from '../utils/fake-turnstile';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const grace = {
  name: 'Grace',
  lastName: 'Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
  organizationName: 'Hopper Labs',
  callbackURL: '/sign-in',
};

/**
 * Hosted sign-up against bots (spec story 20): a Cloudflare
 * Turnstile check on the public sign-up form, and at most one confirmation
 * email per address every few minutes on top of better-auth's per-IP limit.
 *
 * Turnstile is faked at its siteverify (`ctx.turnstile`, which `createTestApp`
 * registers for every suite) and mail at `MailService`; better-auth's captcha
 * plugin and the confirmation hooks run for real. The Self-hosted counterparts
 * are at the end, with `InstanceMode.isHosted` turned off.
 */
describe('Sign-up protection on the Hosted instance (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  const mail = new MailRecorder();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: MailService, useValue: mail }],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await ctx.resetDb();
    mail.clear();
    await openHostedSignUp(ctx.db);
  });

  const signUp = (headers: Record<string, string> = {}, body: object = grace) =>
    request(http).post('/api/auth/sign-up/email').set(headers).send(body);

  const resend = (email = grace.email) =>
    request(http)
      .post('/api/auth/send-verification-email')
      .send({ email, callbackURL: '/sign-in' });

  const accounts = async (email = grace.email) =>
    ctx.db.select().from(user).where(eq(user.email, email));

  describe('Turnstile on the sign-up form', () => {
    it('hands the console the site key to render the widget with', async () => {
      const res = await request(http).get('/auth/sign-up-open');

      expect(res.body).toEqual({
        open: true,
        state: 'open',
        turnstileSiteKey: hosted.TURNSTILE_SITE_KEY,
      });
    });

    it('refuses a sign-up with no Turnstile token, and makes and sends nothing', async () => {
      const res = await signUp();

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'MISSING_RESPONSE' });
      expect(await accounts()).toEqual([]);
      expect(mail.sent).toEqual([]);
      expect(ctx.turnstile.verifications).toEqual([]);
    });

    it('refuses a sign-up whose token Cloudflare does not accept', async () => {
      const res = await signUp({ 'x-captcha-response': 'made-up-by-a-bot' });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'VERIFICATION_FAILED' });
      expect(await accounts()).toEqual([]);
      expect(mail.sent).toEqual([]);
      expect(ctx.turnstile.verifications).toEqual([
        expect.objectContaining({
          secret: hosted.TURNSTILE_SECRET_KEY,
          response: 'made-up-by-a-bot',
        }),
      ]);
    });

    it('accepts a sign-up whose token Cloudflare accepts', async () => {
      const res = await signUp(PASSING_TURNSTILE);

      expect(res.status).toBe(200);
      expect(await accounts()).toHaveLength(1);
      expect(mail.to(grace.email)).toHaveLength(1);
      expect(ctx.turnstile.verifications).toHaveLength(1);
    });

    it('does not check a made-up invitation, which is refused before anything is made', async () => {
      const res = await signUp({ 'x-cloudgate-token': 'not-an-invitation' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVITATION_INVALID' });
      expect(await accounts()).toEqual([]);
      expect(mail.sent).toEqual([]);
    });
  });

  describe('one confirmation email per address every few minutes', () => {
    it('refuses a second email to the same address within the window, and sends nothing', async () => {
      await signUp(PASSING_TURNSTILE);
      mail.clear();

      const res = await resend();

      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ code: 'CONFIRMATION_EMAIL_LIMITED' });
      expect((res.body as { message: string }).message).toMatch(
        /^A confirmation email was sent to grace@example\.com a moment ago\. Wait 5 minutes/,
      );
      expect(mail.sent).toEqual([]);
    });

    it('counts the address however it is spelled', async () => {
      await signUp(PASSING_TURNSTILE);
      mail.clear();

      const res = await resend('GRACE@example.com');

      expect(res.status).toBe(429);
      expect(mail.sent).toEqual([]);
    });

    it('sends again once the window has passed', async () => {
      await signUp(PASSING_TURNSTILE);
      ctx.advanceConfirmationClock(CONFIRMATION_EMAIL_WINDOW_MS - 1_000);
      expect((await resend()).status).toBe(429);

      ctx.advanceConfirmationClock(1_000);
      const res = await resend();

      expect(res.status).toBe(200);
      expect(mail.to(grace.email)).toHaveLength(2);
    });

    it('keeps each address to itself', async () => {
      await signUp(PASSING_TURNSTILE);
      const other = { ...grace, email: 'ada@example.com', name: 'Ada' };

      const res = await signUp(PASSING_TURNSTILE, other);

      expect(res.status).toBe(200);
      expect(mail.to(other.email)).toHaveLength(1);
    });

    // better-auth sends on sign-up and on a change of email as a background
    // task and logs, rather than answers, its failure: the request succeeds
    // and the limit shows only as the email that is not sent.
    it('holds a change of email to the same limit at the new address', async () => {
      const customer = await signUpHostedCustomer(http, mail, grace);
      const change = () =>
        request(http).patch('/users/me').set('Cookie', customer.cookie).send({
          email: 'amazing.grace@example.com',
          currentPassword: grace.password,
        });
      expect((await change()).status).toBe(200);
      mail.clear();

      const again = await change();

      expect(again.status).toBe(200);
      expect(mail.sent).toEqual([]);

      ctx.advanceConfirmationClock(CONFIRMATION_EMAIL_WINDOW_MS);
      expect((await change()).status).toBe(200);
      expect(mail.to('amazing.grace@example.com')).toHaveLength(1);
    });
  });

  describe('on a Self-hosted instance (counterpart)', () => {
    const givenSelfHostedInstance = () =>
      jest
        .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
        .mockReturnValue(false);

    beforeEach(async () => {
      // A Self-hosted instance's first sign-up owns it: no staff yet.
      await ctx.resetDb();
    });

    it('sends no site key and asks for no Turnstile token', async () => {
      givenSelfHostedInstance();

      const open = await request(http).get('/auth/sign-up-open');
      const res = await signUp();

      expect(open.body).toEqual({ open: true, state: 'unclaimed' });
      expect(res.status).toBe(200);
      expect(ctx.turnstile.verifications).toEqual([]);
    });
  });
});
