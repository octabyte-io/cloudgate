// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../../utils/hosted-mode';
const hosted = useHostedMode();

import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';

import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { server as serverTable } from '../../../src/db/schema';
import { organization } from '../../../src/organizations/organizations.schema';
import { MailService } from '../../../src/mail/mail.service';
import { fakeStripe } from '../../utils/fake-stripe';
import { givenPlan } from '../../utils/hosted-plan';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import type { HostedCustomer } from '../../utils/hosted-sign-up';
import { signUpMember } from '../../utils/test-auth';
import type { MemberFixture } from '../../utils/test-auth';
import { createTestApp, TestAppContext } from '../../utils/test-app';

jest.setTimeout(180_000);

const createCheckoutSession = jest.fn<
  Promise<Stripe.Checkout.Session>,
  [Stripe.Checkout.SessionCreateParams]
>();
const retrieveSubscription = jest.fn<Promise<Stripe.Subscription>, [string]>();
const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();

const stripeEvent = (type: string, object: unknown) =>
  ({ type, data: { object } }) as unknown as Stripe.Event;

/**
 * **"Pay for it yourself"** (ADR-0059): an Attached Organization's own
 * owner pays for it through Checkout, with no Free trial, and once the new
 * subscription is `active` the link ends and it pays for itself. Seen from
 * outside: Checkout's answer and what it asks Stripe for, the webhook route,
 * both Billing pages and both audit logs.
 */
describe('Pay for it yourself (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  const mail = new MailRecorder();
  /** Grace owns Hopper Labs, on Business: the Paying Organization. */
  let grace: HostedCustomer;
  let payingId: string;
  /** Alan, an admin of Hopper Labs, made and owns Turing Works on its plan. */
  let alan: MemberFixture;
  let attachedId: string;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        {
          provide: STRIPE_API,
          useValue: fakeStripe({
            createCheckoutSession,
            retrieveSubscription,
            constructEvent,
          }),
        },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await ctx.resetDb();
    mail.clear();
    await openHostedSignUp(ctx.db);
    grace = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    payingId = grace.organizationId;
    await givenPlan(ctx, payingId, 'business');
    alan = await signUpMember(http, grace.cookie, {
      email: 'alan@example.com',
      name: 'Alan Turing',
      role: 'admin',
    });
    await switchTo(alan.cookie, payingId);
    const made = await request(http)
      .post('/organizations')
      .set('Cookie', alan.cookie)
      .send({ name: 'Turing Works', paidBy: 'active-organization' });
    expect(made.status).toBe(201);
    attachedId = (made.body as { id: string }).id;
    await switchTo(alan.cookie, attachedId);
    createCheckoutSession.mockResolvedValue({
      id: 'cs_alan',
      url: 'https://checkout.stripe.com/c/pay/cs_alan#fid',
    } as Stripe.Checkout.Session);
  });

  async function switchTo(cookie: string, organizationId: string) {
    const res = await request(http)
      .post('/api/auth/organization/set-active')
      .set('Cookie', cookie)
      .send({ organizationId });
    expect(res.status).toBe(200);
  }

  const checkout = (cookie: string) =>
    request(http)
      .post('/billing/checkout')
      .set('Cookie', cookie)
      .send({ plan: 'business', addOns: 0 });

  const billing = (cookie: string) =>
    request(http).get('/billing/subscription').set('Cookie', cookie);

  /** Posts an event Stripe has already verified. */
  function postWebhook(event: Stripe.Event) {
    constructEvent.mockReturnValue(event);
    return request(http)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event));
  }

  /** The subscription Alan's Checkout made, as Stripe holds it. */
  const alansSubscription = (
    status: 'incomplete' | 'active',
    metadata: Record<string, string> = {
      organizationId: attachedId,
      link: 'paidForItself',
      ownerId: alan.id,
    },
  ) =>
    ({
      id: 'sub_alan',
      customer: 'cus_alan',
      status,
      metadata,
      items: {
        data: [
          {
            id: 'si_plan',
            price: { id: hosted.BUSINESS_PLAN_PRICE_ID },
            quantity: 1,
          },
        ],
      },
    }) as unknown as Stripe.Subscription;

  /** The link rows of the trail the cookie's active Organization keeps. */
  async function linkRows(cookie: string) {
    const res = await request(http)
      .get('/audit-logs')
      .query({ resourceType: 'organization' })
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (
      res.body as {
        logs: Array<Record<string, unknown> & { metadata: string | null }>;
      }
    ).logs
      .map((row) => ({
        ...row,
        metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
      }))
      .filter((row) => row.metadata.link === 'paidForItself');
  }

  describe('Checkout', () => {
    it('is offered to the owner on the Billing page, and nobody else', async () => {
      expect((await billing(alan.cookie)).body).toMatchObject({
        paidBy: {
          name: 'Hopper Labs',
          payForItYourself: { allowed: true, reason: null, code: null },
        },
      });

      const ida = await signUpMember(http, alan.cookie, {
        email: 'ida@example.com',
        role: 'admin',
      });
      await switchTo(ida.cookie, attachedId);
      expect((await billing(ida.cookie)).body).toMatchObject({
        paidBy: { name: 'Hopper Labs', payForItYourself: null },
      });
    });

    it("lets the owner pay, with no Free trial, marking the subscription with the link and the owner's id", async () => {
      const res = await checkout(alan.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'cs_alan',
        url: 'https://checkout.stripe.com/c/pay/cs_alan#fid',
        addOns: 0,
      });
      const [params] = createCheckoutSession.mock.calls[0];
      expect(params.subscription_data).toEqual({
        metadata: {
          organizationId: attachedId,
          link: 'paidForItself',
          ownerId: alan.id,
        },
      });
      expect(params.subscription_data).not.toHaveProperty('trial_period_days');
    });

    it('buys Add-ons for its own use, not the pool', async () => {
      await givenServers(payingId, 2);
      await givenServers(attachedId, 4);

      const res = await checkout(alan.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ addOns: 1 });
    });

    it('works while its Paying Organization has lapsed and it is frozen', async () => {
      await givenPlan(ctx, payingId, 'business', 'canceled', {
        lapsedAt: new Date(),
      });

      expect((await checkout(alan.cookie)).status).toBe(200);
    });

    it('is refused with ORGANIZATION_LIMIT when the owner already owns an Organization that pays for itself', async () => {
      await ctx.db
        .insert(organization)
        .values({ name: 'Bletchley', ownerId: alan.id, createdAt: new Date() });

      const refused = await checkout(alan.cookie);

      const reason =
        'You already own Bletchley, and a person can own one Organization that pays for itself';
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'ORGANIZATION_LIMIT',
        message: reason,
      });
      expect(createCheckoutSession).not.toHaveBeenCalled();
      expect((await billing(alan.cookie)).body).toMatchObject({
        paidBy: {
          payForItYourself: {
            allowed: false,
            reason,
            code: 'ORGANIZATION_LIMIT',
          },
        },
      });
    });
  });

  describe('the webhook', () => {
    it('keeps it in the pool until the subscription is active, then it pays for itself on its own plan', async () => {
      await postWebhook(
        stripeEvent(
          'customer.subscription.created',
          alansSubscription('incomplete'),
        ),
      ).expect(200);

      expect((await billing(alan.cookie)).body).toMatchObject({
        paidBy: { name: 'Hopper Labs' },
      });

      await postWebhook(
        stripeEvent(
          'customer.subscription.updated',
          alansSubscription('active'),
        ),
      ).expect(200);

      expect((await billing(alan.cookie)).body).toMatchObject({
        plan: 'business',
        status: 'active',
        allowance: { plan: 'business', servers: 3, cloudEnvironments: 3 },
        paidBy: null,
      });
      await switchTo(grace.cookie, payingId);
      expect(
        (
          await request(http)
            .get('/billing/attached-organizations')
            .set('Cookie', grace.cookie)
        ).body,
      ).toMatchObject({ organizations: [] });
    });

    it('writes the link row into both logs as the owner, with no IP address', async () => {
      await postWebhook(
        stripeEvent(
          'customer.subscription.updated',
          alansSubscription('active'),
        ),
      ).expect(200);

      const row = {
        action: 'update',
        resourceType: 'organization',
        resourceId: attachedId,
        resourceName: 'Turing Works',
        userId: alan.id,
        ip: null,
        metadata: {
          link: 'paidForItself',
          payingOrganizationId: payingId,
          payingOrganizationName: 'Hopper Labs',
        },
      };
      expect(await linkRows(alan.cookie)).toEqual([
        expect.objectContaining({ ...row, userRole: 'owner' }),
      ]);
      await switchTo(grace.cookie, payingId);
      expect(await linkRows(grace.cookie)).toEqual([
        expect.objectContaining({ ...row, userRole: 'admin' }),
      ]);
    });

    it('ends the link once, however many events carry the active subscription', async () => {
      const active = alansSubscription('active');
      retrieveSubscription.mockResolvedValue(active);

      await postWebhook(
        stripeEvent('customer.subscription.updated', active),
      ).expect(200);
      await postWebhook(
        stripeEvent('checkout.session.completed', {
          id: 'cs_alan',
          url: 'https://checkout.stripe.com/c/pay/cs_alan#fid',
          customer: 'cus_alan',
          subscription: 'sub_alan',
          metadata: { organizationId: attachedId },
        }),
      ).expect(200);

      expect(await linkRows(alan.cookie)).toHaveLength(1);
    });

    it.each([
      ['is missing from the subscription', undefined],
      ['no longer exists', 'user-who-is-gone'],
    ])(
      "writes both rows as the platform when the owner's id %s",
      async (_case, ownerId) => {
        await postWebhook(
          stripeEvent(
            'customer.subscription.updated',
            alansSubscription('active', {
              organizationId: attachedId,
              link: 'paidForItself',
              ...(ownerId ? { ownerId } : {}),
            }),
          ),
        ).expect(200);

        const platform = {
          userId: null,
          userRole: 'system',
          userName: 'Cloudgate',
        };
        expect(await linkRows(alan.cookie)).toEqual([
          expect.objectContaining(platform),
        ]);
        await switchTo(grace.cookie, payingId);
        expect(await linkRows(grace.cookie)).toEqual([
          expect.objectContaining(platform),
        ]);
      },
    );
  });

  /** Arrangement only: `count` Servers in the Organization. */
  async function givenServers(organizationId: string, count: number) {
    await ctx.db.insert(serverTable).values(
      Array.from({ length: count }, (_, index) => ({
        name: `${organizationId}-server-${index + 1}`,
        ipAddress: `203.0.113.${index + 1}`,
        port: 22,
        organizationId,
      })),
    );
  }
});
