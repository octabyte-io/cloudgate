// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first import.
import { useHostedMode } from '../../utils/hosted-mode';
const hosted = useHostedMode();

import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';
import { subscription } from '../../../src/cloud/billing/billing.schema';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { member, organizationRole } from '../../../src/db/schema';
import { MailService } from '../../../src/mail/mail.service';
import { fakeStripe } from '../../utils/fake-stripe';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import type { HostedCustomer } from '../../utils/hosted-sign-up';
import { signUpMember } from '../../utils/test-auth';
import { createTestApp, TestAppContext } from '../../utils/test-app';

// Custom roles below Business (ADR-0054): they keep failing closed —
// the role grants nothing and nobody is moved — and when an Organization stops
// having Business (a move to Starter, a lapse), its owner and every admin get
// one email naming who is left on a custom role. Stripe is faked at
// STRIPE_API and mail at MailService; the webhook is driven as Stripe would.

jest.setTimeout(180_000);

const retrieveSubscription = jest.fn<Promise<Stripe.Subscription>, [string]>();
const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();
const stripe = fakeStripe({ retrieveSubscription, constructEvent });

const OWNER = 'grace@example.com';
const ADMIN = 'ada@example.com';
const HOLDER = 'ida@example.com';
const PLAIN_MEMBER = 'edsger@example.com';

const ONE_HOLDER_SUBJECT =
  '1 member of Hopper Labs is on a custom role that no longer works';

/** Hopper Labs' subscription on `price`, as Stripe hands it to the webhook. */
const subscriptionOn = (price: string, status = 'active') =>
  ({
    id: 'sub_1',
    customer: 'cus_1',
    status,
    items: { data: [{ id: 'si_plan', price: { id: price }, quantity: 1 }] },
  }) as unknown as Stripe.Subscription;

describe('Custom roles when an Organization leaves Business (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let grace: HostedCustomer;
  let ida: { cookie: string; id: string };
  const mail = new MailRecorder();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: STRIPE_API, useValue: stripe },
        { provide: MailService, useValue: mail },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    await openHostedSignUp(ctx.db);
    grace = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: OWNER,
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await ctx.db.insert(subscription).values({
      organizationId: grace.organizationId,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      plan: 'business',
      status: 'active',
      addOns: 0,
    });
    await signUpMember(http, grace.cookie, {
      email: ADMIN,
      name: 'Ada Lovelace',
      role: 'admin',
    });
    await signUpMember(http, grace.cookie, {
      email: PLAIN_MEMBER,
      name: 'Edsger Dijkstra',
      role: 'member',
    });
    ida = await signUpMember(http, grace.cookie, {
      email: HOLDER,
      name: 'Ida Rhodes',
      role: 'member',
    });
    mail.clear();
  });

  /** Arrangement only: Ida holds the custom role `deployer`. */
  async function idaOnACustomRole(): Promise<void> {
    await ctx.db.insert(organizationRole).values({
      organizationId: grace.organizationId,
      role: 'deployer',
      permission: { project: ['create'] },
    });
    await ctx.db
      .update(member)
      .set({ role: 'deployer' })
      .where(
        and(
          eq(member.organizationId, grace.organizationId),
          eq(member.userId, ida.id),
        ),
      );
  }

  function postWebhook(type: string, object: unknown) {
    const event = { type, data: { object } } as unknown as Stripe.Event;
    constructEvent.mockReturnValue(event);
    return request(http)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(200);
  }

  const movesTo = (price: string) =>
    postWebhook('customer.subscription.updated', subscriptionOn(price));

  /** What `address` was sent about custom roles, as subject and text. */
  const customRoleEmails = (address: string) =>
    mail
      .to(address)
      .filter((sent) => /custom role/.test(sent.email.subject))
      .map((sent) => ({
        subject: sent.email.subject,
        html: sent.email.html.replace(/<!-- -->/g, ''),
      }));

  const createProject = (name: string) =>
    request(http).post('/projects').set('Cookie', ida.cookie).send({ name });

  it('moving to Starter emails the owner and every admin, once, naming who holds a custom role', async () => {
    await idaOnACustomRole();

    await movesTo(hosted.STARTER_PLAN_PRICE_ID);
    // A later event for the same Starter subscription sends nothing again.
    await movesTo(hosted.STARTER_PLAN_PRICE_ID);

    for (const address of [OWNER, ADMIN]) {
      const sent = customRoleEmails(address);
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toBe(ONE_HOLDER_SUBJECT);
      expect(sent[0].html).toContain(
        'Hopper Labs has moved from the Business plan to Starter.',
      );
      expect(sent[0].html).toContain(
        'Ida Rhodes (ida@example.com), role &quot;deployer&quot;',
      );
      expect(sent[0].html).toContain('Change their role');
      expect(sent[0].html).toContain('/settings/members');
      expect(sent[0].html).not.toContain('Edsger');
    }
    expect(mail.to(HOLDER)).toEqual([]);
    expect(mail.to(PLAIN_MEMBER)).toEqual([]);
  });

  it('a lapse of the Business plan sends the same email', async () => {
    await idaOnACustomRole();

    await postWebhook(
      'customer.subscription.deleted',
      subscriptionOn(hosted.BUSINESS_PLAN_PRICE_ID, 'canceled'),
    );
    // The customer going too is the same lapse: nothing again.
    await postWebhook('customer.deleted', { id: 'cus_1', deleted: true });

    for (const address of [OWNER, ADMIN]) {
      const sent = customRoleEmails(address);
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toBe(ONE_HOLDER_SUBJECT);
      expect(sent[0].html).toContain(
        'Hopper Labs is no longer on the Business plan.',
      );
      expect(sent[0].html).toContain('Ida Rhodes (ida@example.com)');
    }
  });

  it('sends nothing when nobody holds a custom role', async () => {
    await movesTo(hosted.STARTER_PLAN_PRICE_ID);
    await postWebhook(
      'customer.subscription.deleted',
      subscriptionOn(hosted.STARTER_PLAN_PRICE_ID, 'canceled'),
    );

    for (const address of [OWNER, ADMIN]) {
      expect(customRoleEmails(address)).toEqual([]);
    }
  });

  it('sends nothing when a Starter plan lapses: its custom roles had already stopped', async () => {
    await ctx.db
      .update(subscription)
      .set({ plan: 'starter' })
      .where(eq(subscription.organizationId, grace.organizationId));
    await idaOnACustomRole();

    await postWebhook(
      'customer.subscription.deleted',
      subscriptionOn(hosted.STARTER_PLAN_PRICE_ID, 'canceled'),
    );

    expect(customRoleEmails(OWNER)).toEqual([]);
  });

  it('refuses a custom-role holder on Starter with the reason, and Business makes the role work again', async () => {
    await idaOnACustomRole();
    expect((await createProject('on-business')).status).toBe(201);

    await movesTo(hosted.STARTER_PLAN_PRICE_ID);

    // She still signs in: the session answers, only the action is refused.
    const session = await request(http)
      .get('/api/auth/get-session')
      .set('Cookie', ida.cookie);
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ user: { email: HOLDER } });
    const refused = await createProject('on-starter');
    expect(refused.status).toBe(403);
    const body = refused.body as { code: string; message: string };
    expect(body.code).toBe('BUSINESS_REQUIRED');
    expect(body.message).toContain(
      'Your role "deployer" is a custom role, which comes with the Business plan.',
    );

    await movesTo(hosted.BUSINESS_PLAN_PRICE_ID);

    expect((await createProject('business-again')).status).toBe(201);
  });
});
