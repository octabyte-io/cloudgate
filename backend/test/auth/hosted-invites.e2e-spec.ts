// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { subscription } from '../../src/cloud/billing/billing.schema';
import { member, organization, user } from '../../src/db/schema';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { MailService } from '../../src/mail/mail.service';
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
};

const ida = {
  name: 'Ida',
  lastName: 'Rhodes',
  email: 'ida@example.com',
  password: 'another-secret-password',
};

/** A Set-Cookie list folded into one `Cookie` header. */
const cookieHeader = (setCookie: string | string[] | undefined): string =>
  (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((entry) => entry.split(';')[0])
    .join('; ');

/**
 * Invites and a second Organization on the Hosted instance (ADR-0051):
 * signing up from an invite link joins only the inviting Organization, makes
 * no Organization of its own and counts as a confirmed email — no
 * confirmation mail, and a session at once. Any confirmed person can make
 * another Organization and becomes its owner; it starts with no plan.
 *
 * The Self-hosted counterparts are at the end, with `InstanceMode.isHosted`
 * turned off: an invited sign-up there was always signed in at once, and only
 * an owner or admin may make an Organization.
 */
describe('Invites and a second Organization on the Hosted instance (e2e)', () => {
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

  const invite = async (cookie: string, email: string, role = 'member') => {
    const res = await request(http)
      .post('/organizations/invitations')
      .set('Cookie', cookie)
      .send({ email, role });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };

  const signUpInvited = (invitationId: string, body: object = ida) =>
    request(http)
      .post('/api/auth/sign-up/email')
      .set('x-cloudgate-token', invitationId)
      .send(body);

  const accept = (cookie: string, invitationId: string) =>
    request(http)
      .post(`/organizations/invitations/${invitationId}/accept`)
      .set('Cookie', cookie);

  const membershipsOf = async (email: string) =>
    ctx.db
      .select({ organization: organization.name, role: member.role })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(user.email, email))
      .orderBy(member.createdAt);

  const createOrganization = (cookie: string, name: string) =>
    request(http).post('/organizations').set('Cookie', cookie).send({ name });

  describe('once sign-up is open', () => {
    beforeEach(async () => {
      await openHostedSignUp(ctx.db);
    });

    /** Grace's Organization, with Ida invited into it and signed up. */
    async function givenInvitedMember() {
      const owner = await signUpHostedCustomer(http, mail, grace);
      const invitationId = await invite(owner.cookie, ida.email);
      mail.clear();
      const signUp = await signUpInvited(invitationId);
      return { owner, invitationId, signUp };
    }

    it('signs an invited sign-up in at once, confirmed, sending no confirmation email', async () => {
      const { signUp } = await givenInvitedMember();

      expect(signUp.status).toBe(200);
      expect(typeof (signUp.body as { token: unknown }).token).toBe('string');
      expect(signUp.headers['set-cookie']).toBeDefined();
      const session = await request(http)
        .get('/api/auth/get-session')
        .set('Cookie', cookieHeader(signUp.headers['set-cookie']));
      expect(session.body).toMatchObject({ user: { email: ida.email } });

      const [account] = await ctx.db
        .select()
        .from(user)
        .where(eq(user.email, ida.email));
      expect(account).toMatchObject({ emailVerified: true });
      expect(mail.sent).toEqual([]);

      // A password sign-in works too, with nothing to confirm first.
      const signIn = await request(http)
        .post('/api/auth/sign-in/email')
        .send({ email: ida.email, password: ida.password });
      expect(signIn.status).toBe(200);
    });

    it('joins only the inviting Organization and makes none of its own', async () => {
      const { invitationId, signUp } = await givenInvitedMember();

      // Not even an Organization named on the form.
      await expect(membershipsOf(ida.email)).resolves.toEqual([]);

      const accepted = await accept(
        cookieHeader(signUp.headers['set-cookie']),
        invitationId,
      );
      expect(accepted.status).toBe(201);
      await expect(membershipsOf(ida.email)).resolves.toEqual([
        { organization: 'Hopper Labs', role: 'member' },
      ]);
    });

    it('makes no Organization from a name sent with an invited sign-up', async () => {
      const owner = await signUpHostedCustomer(http, mail, grace);
      const invitationId = await invite(owner.cookie, ida.email);

      const signUp = await signUpInvited(invitationId, {
        ...ida,
        organizationName: 'Rhodes Ltd',
      });

      expect(signUp.status).toBe(200);
      await expect(membershipsOf(ida.email)).resolves.toEqual([]);
    });

    it('still answers an invited sign-up for a taken address with no session', async () => {
      const owner = await signUpHostedCustomer(http, mail, grace);
      // The staff account's address: taken, but not in Grace's Organization.
      const invitationId = await invite(owner.cookie, HOSTED_STAFF.email);

      const signUp = await signUpInvited(invitationId, {
        ...ida,
        email: HOSTED_STAFF.email,
      });

      expect(signUp.status).toBe(200);
      expect(signUp.body).toMatchObject({ token: null });
      expect(signUp.headers['set-cookie']).toBeUndefined();
    });

    it('lets a plain member create an Organization, which they own and which has no plan', async () => {
      const { invitationId, signUp } = await givenInvitedMember();
      const cookie = cookieHeader(signUp.headers['set-cookie']);
      expect((await accept(cookie, invitationId)).status).toBe(201);

      const created = await createOrganization(cookie, 'Rhodes Ltd');

      expect(created.status).toBe(201);
      const organizationId = (created.body as { id: string }).id;
      await expect(membershipsOf(ida.email)).resolves.toEqual([
        { organization: 'Hopper Labs', role: 'member' },
        { organization: 'Rhodes Ltd', role: 'owner' },
      ]);
      await expect(
        ctx.db
          .select()
          .from(subscription)
          .where(eq(subscription.organizationId, organizationId)),
      ).resolves.toEqual([]);

      const switched = await request(http)
        .post('/api/auth/organization/set-active')
        .set('Cookie', cookie)
        .send({ organizationId });
      expect(switched.status).toBe(200);
      const billing = await request(http)
        .get('/billing/subscription')
        .set('Cookie', cookie);
      expect(billing.status).toBe(200);
      expect(billing.body).toMatchObject({ plan: null, status: null });
    });
  });

  describe('on a Self-hosted instance (counterpart)', () => {
    beforeEach(() => {
      jest
        .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
        .mockReturnValue(false);
    });

    /** The first account, which owns the instance's Organization, and Ida invited into it. */
    async function givenInvitedMember() {
      const first = await request(http)
        .post('/api/auth/sign-up/email')
        .set(PASSING_TURNSTILE)
        .send(grace);
      expect(first.status).toBe(200);
      const ownerCookie = cookieHeader(first.headers['set-cookie']);
      const invitationId = await invite(ownerCookie, ida.email);
      mail.clear();
      const signUp = await signUpInvited(invitationId);
      return { invitationId, signUp };
    }

    it('signs an invited sign-up in at once and makes no Organization, as it always has', async () => {
      const { signUp } = await givenInvitedMember();

      expect(signUp.status).toBe(200);
      expect(signUp.headers['set-cookie']).toBeDefined();
      expect(mail.sent).toEqual([]);
      await expect(membershipsOf(ida.email)).resolves.toEqual([]);
    });

    it('refuses a plain member creating an Organization: only owners and admins may', async () => {
      const { invitationId, signUp } = await givenInvitedMember();
      const cookie = cookieHeader(signUp.headers['set-cookie']);
      expect((await accept(cookie, invitationId)).status).toBe(201);

      const created = await createOrganization(cookie, 'Rhodes Ltd');

      expect(created.status).toBe(403);
      await expect(membershipsOf(ida.email)).resolves.toEqual([
        { organization: 'Hopper Labs', role: 'member' },
      ]);
    });
  });
});
