import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { invitation } from '../../src/db/schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const invitee = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'super-secret-password',
};

/** The invitation token header `assertSignUpAllowed` reads (x-cloudgate-token). */
const INVITATION_TOKEN_HEADER = 'x-cloudgate-token';

describe('Whether sign-up is open (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  it('says sign-up is open on an instance nobody owns yet, with no session at all', async () => {
    const res = await request(server).get('/auth/sign-up-open');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ open: true, state: 'unclaimed' });
  });

  it('says sign-up is closed once the first account owns the instance', async () => {
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signUp.status).toBe(200);

    const res = await request(server).get('/auth/sign-up-open');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ open: false, state: 'closed' });
  });

  /**
   * The Self-hosted counterpart of `instance-organization.e2e-spec.ts`:
   * with hosted mode off nothing waits for a command — the first web sign-up
   * still makes the Organization whose owner holds instance authority.
   */
  it('lets the first sign-up own a Self-hosted instance, instance authority and all', async () => {
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signUp.status).toBe(200);

    const hostRead = await request(server)
      .get('/traefik/config-status/console')
      .set('Cookie', signUp.headers['set-cookie']);

    expect(hostRead.status).toBe(200);
  });

  describe('the refusals it saves someone from reaching', () => {
    /** Signs up the owner and returns their session cookie. */
    async function claimInstance(): Promise<string> {
      const res = await request(server)
        .post('/api/auth/sign-up/email')
        .send(owner);
      expect(res.status).toBe(200);
      return res.headers['set-cookie'];
    }

    /** Invites `invitee` as a member and returns the invitation's id/token. */
    async function invite(cookie: string): Promise<string> {
      const res = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', cookie)
        .send({ email: invitee.email, role: 'member' });
      expect(res.status).toBe(201);
      return (res.body as { id: string }).id;
    }

    function signUpAs(
      body: { name: string; email: string; password: string },
      token?: string,
    ) {
      const req = request(server).post('/api/auth/sign-up/email');
      if (token) req.set(INVITATION_TOKEN_HEADER, token);
      return req.send(body);
    }

    it('refuses an uninvited sign-up on a claimed instance with SIGN_UP_CLOSED', async () => {
      await claimInstance();

      const res = await signUpAs(invitee);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'SIGN_UP_CLOSED',
        message: 'Admin is already created',
      });
    });

    it('refuses an invitation token that matches nothing with INVITATION_INVALID', async () => {
      await claimInstance();

      const res = await signUpAs(invitee, 'not-an-invitation-id');

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'INVITATION_INVALID',
        message: 'Invalid invitation token',
      });
    });

    it('refuses an invitation whose expiry has passed with INVITATION_EXPIRED', async () => {
      const inviteId = await invite(await claimInstance());
      await ctx.db
        .update(invitation)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(invitation.id, inviteId));

      const res = await signUpAs(invitee, inviteId);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'INVITATION_EXPIRED',
        message: 'Invitation has expired',
      });
    });

    it('refuses an invitation that is no longer pending with INVITATION_ALREADY_USED', async () => {
      const inviteId = await invite(await claimInstance());
      await ctx.db
        .update(invitation)
        .set({ status: 'accepted' })
        .where(eq(invitation.id, inviteId));

      const res = await signUpAs(invitee, inviteId);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'INVITATION_ALREADY_USED',
        message: 'Invitation has already been used',
      });
    });

    it('refuses an invitation used from another address with INVITATION_EMAIL_MISMATCH', async () => {
      const inviteId = await invite(await claimInstance());

      const res = await signUpAs(
        { ...invitee, email: 'someone.else@example.com' },
        inviteId,
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'INVITATION_EMAIL_MISMATCH',
        message: 'Email does not match invitation',
      });
    });

    it('still lets the invited person through, and sign-up stays closed to everyone else', async () => {
      const inviteId = await invite(await claimInstance());

      const accepted = await signUpAs(invitee, inviteId);
      expect(accepted.status).toBe(200);

      // The public read answers about *uninvited* sign-up, so it is still
      // closed — the token is what authorised the account above.
      const open = await request(server).get('/auth/sign-up-open');
      expect(open.body).toEqual({ open: false, state: 'closed' });
    });
  });
});
