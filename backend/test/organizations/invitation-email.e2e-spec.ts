import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { invitation } from '../../src/db/schema';
import { MailService } from '../../src/mail/mail.service';
import type { RenderedEmail } from '../../src/mail/templates';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

// The invitation email: the organization plugin was registered with
// no `sendInvitationEmail`, so `POST /organizations/invitations` created a real,
// working row and nothing ever reached the invitee — the password-reset shape a
// second time.
//
// MailService is the boundary, as in test/auth/password-reset.e2e-spec.ts: the
// senders (nodemailer / Resend) talk to the outside world, so the service is
// replaced with a recorder. Everything on this side of it — the better-auth
// hook, the link, the template render — runs for real.
//
// Lives in its own file rather than in organizations.e2e-spec.ts because the
// wiring only hands better-auth a sender when MAIL_PROVIDER is set, and
// ConfigModule snapshots the environment when app.module is first imported.

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const INVITEE = 'invitee@example.com';

/** The origin better-auth mails out — what BETTER_AUTH_URL is for. */
const BASE_URL = 'http://console.cloudgate.test';

interface SentMail {
  to: string;
  email: RenderedEmail;
}

describe('Invitation email (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let sent: SentMail[];
  /** Every address the sender was asked for, whether or not the send worked. */
  let attempted: string[];
  /** Set for one test to prove a failed send does not cost the invitation. */
  let sendFails: boolean;
  const providerBefore = process.env.MAIL_PROVIDER;
  const baseUrlBefore = process.env.BETTER_AUTH_URL;

  beforeAll(async () => {
    // A configured instance: the recorder below stands in for the sender, but
    // the wiring only hands better-auth a sender when MAIL_PROVIDER is set.
    process.env.MAIL_PROVIDER = 'resend';
    process.env.BETTER_AUTH_URL = BASE_URL;
    sent = [];
    attempted = [];
    sendFails = false;
    const mailRecorder = {
      send: (to: string, email: RenderedEmail) => {
        attempted.push(to);
        if (sendFails) return Promise.reject(new Error('smtp is down'));
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
    if (baseUrlBefore === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = baseUrlBefore;
  });

  beforeEach(async () => {
    await ctx.resetDb();
    sent.length = 0;
    attempted.length = 0;
    sendFails = false;
  });

  const signUpOwner = async (): Promise<string> => {
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    return res.headers['set-cookie'];
  };

  const invite = (cookie: string, role = 'member') =>
    request(server)
      .post('/organizations/invitations')
      .set('Cookie', cookie)
      .send({ email: INVITEE, role });

  it('emails the invitee the accept link for the invitation just created', async () => {
    const cookie = await signUpOwner();

    const created = await invite(cookie, 'admin');
    expect(created.status).toBe(201);
    const inviteId = (created.body as { id: string }).id;

    // Exactly one email, to the person invited — not to the inviter.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(INVITEE);
    expect(sent[0].email.subject).toBe(
      'You are invited to join My Organization on Cloudgate',
    );

    // The link is the whole point of the email: the `/accept-invitation/<id>`
    // path that already works, on the origin BETTER_AUTH_URL names.
    expect(sent[0].email.html).toContain(
      `${BASE_URL}/accept-invitation/${inviteId}`,
    );
    // ...and it is the real row's id, not a token invented for the mail.
    const [row] = await ctx.db
      .select()
      .from(invitation)
      .where(eq(invitation.id, inviteId));
    expect(row.email).toBe(INVITEE);

    // Who invited them, and as what.
    expect(sent[0].email.html).toContain('Grace Hopper');
    expect(sent[0].email.html).toContain('admin');
  });

  it('keeps the invitation when the send fails, and still answers with it', async () => {
    const cookie = await signUpOwner();
    sendFails = true;

    const created = await invite(cookie);

    // The row is written before the send is attempted, so a dead mail server
    // must not cost the invitation — the console's Copy link is still a way
    // through, and re-inviting the same address would be refused as already
    // invited if the row had been rolled back.
    expect(created.status).toBe(201);
    const inviteId = (created.body as { id: string }).id;
    expect(inviteId).toBeTruthy();
    // The send was attempted against the invitee and threw; nothing went out.
    expect(attempted).toEqual([INVITEE]);
    expect(sent).toHaveLength(0);

    const list = await request(server)
      .get('/organizations/invitations')
      .set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body as { id: string }[]).toHaveLength(1);
    expect((list.body as { id: string }[])[0].id).toBe(inviteId);
    expect((list.body as { status: string }[])[0].status).toBe('pending');
  });
});
