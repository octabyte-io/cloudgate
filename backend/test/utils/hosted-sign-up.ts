import request from 'supertest';
import { App } from 'supertest/types';

import { createInstanceOrganization } from '../../src/auth/instance-organization';
import type { InstanceOrganizationCreated } from '../../src/auth/instance-organization';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { RenderedEmail } from '../../src/mail/templates';
import { PASSING_TURNSTILE } from './fake-turnstile';

/** One email the instance sent, as {@link MailRecorder} caught it. */
export interface SentMail {
  to: string;
  email: RenderedEmail;
}

/**
 * Stands in for `MailService` (the mail port), so a Hosted e2e can read what
 * the instance sent: pass it as `{ provide: MailService, useValue: recorder }`
 * in `createTestApp`'s `overrideProviders`, and `clear()` it in `beforeEach`.
 *
 * A Hosted suite needs one as soon as anybody signs up through the web: every
 * Hosted sign-up sends a confirmation email, and the real sender would
 * try to reach Resend with the fake key `useHostedMode` sets.
 */
export class MailRecorder {
  readonly sent: SentMail[] = [];

  send(to: string, email: RenderedEmail): Promise<void> {
    this.sent.push({ to, email });
    return Promise.resolve();
  }

  clear(): void {
    this.sent.length = 0;
  }

  /** Every email sent to `address`, oldest first. */
  to(address: string): SentMail[] {
    return this.sent.filter((mail) => mail.to === address.toLowerCase());
  }

  /**
   * The path and query of the newest confirmation link sent to `address` —
   * better-auth's `/api/auth/verify-email?token=…&callbackURL=…`, ready to
   * `GET` on the test server the way a recipient's browser would.
   */
  confirmationLink(address: string): string {
    const mail = this.to(address).at(-1);
    if (!mail) throw new Error(`No email was sent to ${address}`);
    const link = /https?:\/\/[^"'\s<]*\/verify-email\?[^"'\s<]+/.exec(
      mail.email.html,
    )?.[0];
    if (!link) throw new Error(`The email to ${address} carries no link`);
    const url = new URL(link.replace(/&amp;/g, '&'));
    return url.pathname + url.search;
  }
}

/** The staff account `openHostedSignUp` makes. */
export const HOSTED_STAFF = {
  email: 'ops@octabyte.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  password: 'staff-only-password',
  organizationName: 'Octabyte',
};

/**
 * Opens web sign-up on the Hosted instance the way it is opened for real: by
 * running `create-instance-organization`'s core, which makes the staff account
 * and the Instance organization. Until this has run every web sign-up
 * is refused with SIGN_UP_NOT_OPEN_YET.
 */
export function openHostedSignUp(
  db: DrizzleDB,
): Promise<InstanceOrganizationCreated> {
  return createInstanceOrganization(db, HOSTED_STAFF);
}

export interface HostedCustomer {
  /** The session cookie, as one `Cookie` header value. */
  cookie: string;
  /** The `user.id` better-auth minted. */
  id: string;
  /** The Organization the sign-up made, which the session is active in. */
  organizationId: string;
}

/** A Set-Cookie list folded into one `Cookie` header. */
function cookieHeader(setCookie: string | string[] | undefined): string {
  const entries = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  return entries.map((entry) => entry.split(';')[0]).join('; ');
}

/**
 * A customer of the Hosted instance, signed in: signs up with an
 * Organization name, follows the confirmation link the recorder caught, and
 * signs in — the only way to a session there, since sign-up itself starts
 * none. Sign-up must already be open ({@link openHostedSignUp}).
 */
export async function signUpHostedCustomer(
  http: App,
  mail: MailRecorder,
  body: {
    name: string;
    lastName?: string;
    email: string;
    password: string;
    organizationName: string;
  },
): Promise<HostedCustomer> {
  const signUp = await request(http)
    .post('/api/auth/sign-up/email')
    .set(PASSING_TURNSTILE)
    .send(body);
  if (signUp.status !== 200) {
    throw new Error(
      `Sign-up answered ${signUp.status}: ${JSON.stringify(signUp.body)}`,
    );
  }
  const confirmed = await request(http).get(mail.confirmationLink(body.email));
  if (confirmed.status >= 400) {
    throw new Error(`Confirming answered ${confirmed.status}`);
  }
  const signIn = await request(http)
    .post('/api/auth/sign-in/email')
    .send({ email: body.email, password: body.password });
  if (signIn.status !== 200) {
    throw new Error(
      `Sign-in answered ${signIn.status}: ${JSON.stringify(signIn.body)}`,
    );
  }
  const cookie = cookieHeader(signIn.headers['set-cookie']);
  const active = await request(http)
    .get('/organizations/active')
    .set('Cookie', cookie);
  return {
    cookie,
    id: (signIn.body as { user: { id: string } }).user.id,
    organizationId: (active.body as { id: string }).id,
  };
}
