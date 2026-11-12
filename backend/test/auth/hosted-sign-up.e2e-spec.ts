// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();
// The origin better-auth builds its links on, as every install sets it
// (`deploy/install.sh`). A link minted in-process — the change-of-email one,
// from `PATCH /users/me` — has no request to infer it from.
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';

import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  UNCONFIRMED_ACCOUNTS_JOB_ID,
  UnconfirmedAccountsService,
} from '../../src/auth/unconfirmed-accounts.service';
import { CONFIRMATION_EMAIL_WINDOW_MS } from '../../src/auth/confirmation-email-limit';
import { member, organization, user } from '../../src/db/schema';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { MailService } from '../../src/mail/mail.service';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import {
  HOSTED_STAFF,
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { PASSING_TURNSTILE } from '../utils/fake-turnstile';

jest.setTimeout(120_000);

const grace = {
  name: 'Grace',
  lastName: 'Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
  organizationName: 'Hopper Labs',
  // Where the link lands once followed, as the console's form sends it.
  callbackURL: '/sign-in',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sign-up on the Hosted instance once it is open (ADR-0051): anyone
 * signs up with an email, a password and an Organization name; that makes the
 * account and an Organization with that name and sends one confirmation
 * email; the account cannot sign in until the link in it is followed. A change
 * of email is confirmed at the new address before it applies, and a daily job
 * deletes accounts never confirmed within 7 days, with their empty
 * Organizations.
 *
 * Mail is faked at `MailService`; everything this side of it — better-auth's
 * hooks, the template, `/verify-email` — runs for real. The Self-hosted
 * counterparts are at the end, with `InstanceMode.isHosted` turned off.
 */
describe('Sign-up on the Hosted instance (e2e)', () => {
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
  });

  const signUp = (body: object = grace) =>
    request(http)
      .post('/api/auth/sign-up/email')
      .set(PASSING_TURNSTILE)
      .send(body);

  const signIn = (email: string, password = grace.password) =>
    request(http).post('/api/auth/sign-in/email').send({ email, password });

  const userRow = async (email: string) =>
    (await ctx.db.select().from(user).where(eq(user.email, email)))[0];

  /** Ages an account by moving its creation back `days`. */
  const age = (email: string, days: number) =>
    ctx.db
      .update(user)
      .set({ createdAt: new Date(Date.now() - days * DAY_MS) })
      .where(eq(user.email, email));

  describe('once sign-up is open', () => {
    beforeEach(async () => {
      await openHostedSignUp(ctx.db);
    });

    it('creates the account and an Organization named from the form, and sends one confirmation email', async () => {
      const res = await signUp();

      expect(res.status).toBe(200);
      // No session until the address is confirmed.
      expect(res.body).toMatchObject({ token: null });
      expect(res.headers['set-cookie']).toBeUndefined();

      const account = await userRow(grace.email);
      expect(account).toMatchObject({ emailVerified: false });
      const owned = await ctx.db
        .select({ name: organization.name, role: member.role })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(eq(member.userId, account.id));
      expect(owned).toEqual([{ name: 'Hopper Labs', role: 'owner' }]);

      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0].to).toBe(grace.email);
      expect(mail.sent[0].email.subject).toBe('Verify your email');
      expect(mail.confirmationLink(grace.email)).toMatch(
        /^\/api\/auth\/verify-email\?token=/,
      );
    });

    it('leaves instance authority with the Instance organization', async () => {
      await signUp();

      const owners = await ctx.db
        .select({ email: user.email, organization: organization.name })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(eq(member.role, 'owner'))
        .orderBy(member.createdAt);
      // The earliest owner row is the staff's (ADR-0013).
      expect(owners).toEqual([
        { email: HOSTED_STAFF.email, organization: 'Octabyte' },
        { email: grace.email, organization: 'Hopper Labs' },
      ]);
    });

    it('answers a taken address as it answers a new one, and makes nothing', async () => {
      await signUp();
      mail.clear();

      const again = await signUp({ ...grace, organizationName: 'Second' });

      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ token: null });
      expect(await ctx.db.select().from(organization)).toHaveLength(2);
      expect(mail.sent).toEqual([]);
    });

    it('refuses sign-in before the link is followed, and lets it in after', async () => {
      await signUp();

      const before = await signIn(grace.email);
      expect(before.status).toBe(403);
      expect(before.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });

      const followed = await request(http).get(
        mail.confirmationLink(grace.email),
      );
      expect(followed.status).toBe(302);
      expect(followed.headers.location).toBe('/sign-in');
      expect(await userRow(grace.email)).toMatchObject({
        emailVerified: true,
      });

      const after = await signIn(grace.email);
      expect(after.status).toBe(200);
      const active = await request(http)
        .get('/organizations/active')
        .set('Cookie', after.headers['set-cookie']);
      expect(active.body).toMatchObject({ name: 'Hopper Labs' });
    });

    it('signs the person in on following the link, and lands on the path the sign-up carried', async () => {
      await signUp({ ...grace, callbackURL: '/get-started?template=ghost' });

      const followed = await request(http).get(
        mail.confirmationLink(grace.email),
      );

      expect(followed.status).toBe(302);
      expect(followed.headers.location).toBe('/get-started?template=ghost');
      const cookie = followed.headers['set-cookie'];
      expect(cookie).toBeDefined();
      const active = await request(http)
        .get('/organizations/active')
        .set('Cookie', cookie);
      expect(active.status).toBe(200);
      expect(active.body).toMatchObject({ name: 'Hopper Labs' });
    });

    it('signs nobody in on a link followed again after the address is confirmed', async () => {
      await signUp();
      const link = mail.confirmationLink(grace.email);
      expect((await request(http).get(link)).status).toBe(302);

      const again = await request(http).get(link);

      expect(again.status).toBe(302);
      // Only the first, unconfirmed follow starts a session.
      expect(again.headers['set-cookie']).toBeUndefined();
    });

    it.each(['https://evil.example/get-started', '//evil.example/get-started'])(
      'refuses a sign-up whose confirmation would land on another site (%s)',
      async (callbackURL) => {
        const res = await signUp({ ...grace, callbackURL });

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'INVALID_CALLBACK_URL' });
        // Nothing was sent on the way to being refused.
        expect(mail.sent).toEqual([]);
      },
    );

    it('sends a new confirmation email on resend, whose link works', async () => {
      await signUp();
      // Past the one-email-per-address window.
      ctx.advanceConfirmationClock(CONFIRMATION_EMAIL_WINDOW_MS);

      const resent = await request(http)
        .post('/api/auth/send-verification-email')
        .send({ email: grace.email, callbackURL: '/sign-in' });

      expect(resent.status).toBe(200);
      expect(mail.to(grace.email)).toHaveLength(2);
      expect(
        (await request(http).get(mail.confirmationLink(grace.email))).status,
      ).toBe(302);
      expect((await signIn(grace.email)).status).toBe(200);
    });

    it('sends nothing on resend for a confirmed address', async () => {
      await signUpHostedCustomer(http, mail, grace);
      mail.clear();

      const resent = await request(http)
        .post('/api/auth/send-verification-email')
        .send({ email: grace.email, callbackURL: '/sign-in' });

      expect(resent.status).toBe(200);
      expect(mail.sent).toEqual([]);
    });

    describe('changing the email', () => {
      const NEW_EMAIL = 'amazing.grace@example.com';

      it('confirms the new address first, and only then signs in with it', async () => {
        const customer = await signUpHostedCustomer(http, mail, grace);
        mail.clear();

        const res = await request(http)
          .patch('/users/me')
          .set('Cookie', customer.cookie)
          .send({ email: NEW_EMAIL, currentPassword: grace.password });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          email: grace.email,
          pendingEmail: NEW_EMAIL,
        });
        // Nothing has moved yet: the old address still signs in.
        expect(await userRow(grace.email)).toBeDefined();
        expect((await signIn(grace.email)).status).toBe(200);
        expect(mail.sent).toHaveLength(1);
        expect(mail.sent[0].to).toBe(NEW_EMAIL);
        expect(mail.sent[0].email.subject).toBe(
          'Confirm your new email address',
        );

        const followed = await request(http).get(
          mail.confirmationLink(NEW_EMAIL),
        );
        expect(followed.status).toBe(302);
        expect(followed.headers.location).toBe('/settings/account');

        expect(await userRow(grace.email)).toBeUndefined();
        expect(await userRow(NEW_EMAIL)).toMatchObject({
          id: customer.id,
          emailVerified: true,
        });
        expect((await signIn(NEW_EMAIL)).status).toBe(200);
        expect((await signIn(grace.email)).status).toBe(401);
      });

      it('still asks for the current password, and sends nothing without it', async () => {
        const customer = await signUpHostedCustomer(http, mail, grace);
        mail.clear();

        const res = await request(http)
          .patch('/users/me')
          .set('Cookie', customer.cookie)
          .send({ email: NEW_EMAIL });

        expect(res.status).toBe(400);
        expect(mail.sent).toEqual([]);
      });

      it('is not reachable through better-auth’s own route', async () => {
        const customer = await signUpHostedCustomer(http, mail, grace);
        mail.clear();

        const res = await request(http)
          .post('/api/auth/change-email')
          .set('Cookie', customer.cookie)
          .send({ newEmail: NEW_EMAIL });

        expect(res.status).toBe(404);
        expect(mail.sent).toEqual([]);
      });
    });

    describe('the daily job', () => {
      const runJob = () =>
        ctx.app.get(SchedulingService).runNow(UNCONFIRMED_ACCOUNTS_JOB_ID);

      it('deletes accounts unconfirmed for 7 days with their empty Organizations, and leaves the rest', async () => {
        // Abandoned: unconfirmed for 8 days.
        await signUp();
        await age(grace.email, 8);
        // Still has time: unconfirmed for 6 days.
        await signUp({
          ...grace,
          email: 'fresh@example.com',
          organizationName: 'Fresh Co',
        });
        await age('fresh@example.com', 6);
        // Confirmed long ago.
        await signUpHostedCustomer(http, mail, {
          ...grace,
          email: 'kept@example.com',
          organizationName: 'Kept Co',
        });
        await age('kept@example.com', 30);

        await runJob();

        expect(await userRow(grace.email)).toBeUndefined();
        expect(await userRow('fresh@example.com')).toBeDefined();
        expect(await userRow('kept@example.com')).toBeDefined();
        expect(await userRow(HOSTED_STAFF.email)).toBeDefined();
        const names = (
          await ctx.db.select({ name: organization.name }).from(organization)
        )
          .map((row) => row.name)
          .sort();
        expect(names).toEqual(['Fresh Co', 'Kept Co', 'Octabyte']);
      });

      it('leaves an unconfirmed account that is in an Organization with someone else', async () => {
        await signUp();
        await age(grace.email, 8);
        const account = await userRow(grace.email);
        const [staffOrg] = await ctx.db
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.name, 'Octabyte'));
        await ctx.db.insert(member).values({
          organizationId: staffOrg.id,
          userId: account.id,
          role: 'member',
          createdAt: new Date(),
        });

        await runJob();

        expect(await userRow(grace.email)).toBeDefined();
        const [still] = await ctx.db
          .select({ id: member.id })
          .from(member)
          .where(
            and(
              eq(member.userId, account.id),
              eq(member.organizationId, staffOrg.id),
            ),
          );
        expect(still).toBeDefined();
      });
    });
  });

  describe('on a Self-hosted instance (counterpart)', () => {
    const givenSelfHostedInstance = () =>
      jest
        .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
        .mockReturnValue(false);

    it('signs the first account in at once, sends no email and needs no confirmation', async () => {
      givenSelfHostedInstance();

      const res = await signUp();

      expect(res.status).toBe(200);
      expect(typeof (res.body as { token: unknown }).token).toBe('string');
      expect(mail.sent).toEqual([]);
      expect(await userRow(grace.email)).toMatchObject({
        emailVerified: false,
      });
      expect((await signIn(grace.email)).status).toBe(200);
    });

    it('has no resend: the route refuses as it always has', async () => {
      givenSelfHostedInstance();
      await signUp();

      const resent = await request(http)
        .post('/api/auth/send-verification-email')
        .send({ email: grace.email });

      expect(resent.status).toBe(400);
      expect(resent.body).toMatchObject({
        code: 'VERIFICATION_EMAIL_NOT_ENABLED',
      });
      expect(mail.sent).toEqual([]);
    });

    it('changes the email at once, with nothing sent', async () => {
      givenSelfHostedInstance();
      const res = await signUp();
      const cookie = res.headers['set-cookie'];

      const changed = await request(http)
        .patch('/users/me')
        .set('Cookie', cookie)
        .send({
          email: 'amazing.grace@example.com',
          currentPassword: grace.password,
        });

      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({
        email: 'amazing.grace@example.com',
      });
      expect(changed.body).not.toHaveProperty('pendingEmail');
      expect(mail.sent).toEqual([]);
    });

    it('never deletes an unconfirmed account', async () => {
      givenSelfHostedInstance();
      await signUp();
      await age(grace.email, 30);

      const swept = await ctx.app.get(UnconfirmedAccountsService).sweep();

      expect(swept).toEqual({ userIds: [], organizationIds: [] });
      expect(await userRow(grace.email)).toBeDefined();
    });
  });
});
