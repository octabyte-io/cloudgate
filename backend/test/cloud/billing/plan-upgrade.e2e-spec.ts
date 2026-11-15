// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../../utils/hosted-mode';
const hosted = useHostedMode();

import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';
import { eq } from 'drizzle-orm';
import { subscription } from '../../../src/cloud/billing/billing.schema';
import { PRORATION_DATE_MAX_AGE_SECONDS } from '../../../src/cloud/billing/plan-upgrade';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { MailService } from '../../../src/mail/mail.service';
import { fakeStripe } from '../../utils/fake-stripe';
import { givenPlan } from '../../utils/hosted-plan';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../../utils/test-app';

jest.setTimeout(120_000);

const STARTER_PRICE = hosted.STARTER_PLAN_PRICE_ID;
const BUSINESS_PRICE = hosted.BUSINESS_PLAN_PRICE_ID;
const ADD_ON_PRICE = hosted.ADD_ON_PRICE_ID;

const DAY = 24 * 60 * 60;

// Stripe, mocked at its port.
const retrieveSubscription = jest.fn<Promise<Stripe.Subscription>, [string]>();
const updateSubscription = jest.fn<
  Promise<Stripe.Subscription>,
  [string, Stripe.SubscriptionUpdateParams]
>();
const previewInvoice = jest.fn<
  Promise<Stripe.Invoice>,
  [Stripe.InvoiceCreatePreviewParams]
>();
const retrievePrice = jest.fn<Promise<Stripe.Price>, [string]>();
const retrieveInvoice = jest.fn<Promise<Stripe.Invoice>, [string]>();
const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();
const stripe = fakeStripe({
  retrieveSubscription,
  updateSubscription,
  previewInvoice,
  retrievePrice,
  retrieveInvoice,
  constructEvent,
});

const recorder = new MailRecorder();

/**
 * Starter → Business at once, charged today (ADR-0054).
 *
 * The confirm's amount is Stripe's invoice preview of the swap, at a proration
 * time the upgrade sends back, so the charge is the amount shown; the upgrade
 * swaps the price on the existing plan item, and the Organization passes the
 * paid-feature check straight away, before the webhook says so. Owners and
 * admins only, as on every billing write.
 */
describe('Upgrading Starter to Business (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: STRIPE_API, useValue: stripe },
        { provide: MailService, useValue: recorder },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.resetAllMocks();
    recorder.clear();
  });

  /** The subscription at Stripe: Starter's item and `addOns` Add-ons. */
  function starterAtStripe({
    status = 'active',
    plan = STARTER_PRICE,
    addOns = 2,
    periodEnd = Math.floor(Date.now() / 1000) + 23 * DAY - 60,
  } = {}): Stripe.Subscription {
    return {
      id: 'sub_1',
      customer: 'cus_1',
      status,
      pending_update: null,
      items: {
        data: [
          {
            id: 'si_plan',
            price: { id: plan },
            quantity: 1,
            current_period_end: periodEnd,
          },
          {
            id: 'si_add_on',
            price: { id: ADD_ON_PRICE },
            quantity: addOns,
            current_period_end: periodEnd,
          },
        ],
      },
    } as unknown as Stripe.Subscription;
  }

  /** Stripe's two previews: today's prorations, and the month after. */
  function givenPreviews(today: number, monthlyAfter: number): void {
    previewInvoice.mockImplementation((params) =>
      Promise.resolve({
        amount_due:
          params.subscription_details?.proration_behavior === 'always_invoice'
            ? today
            : monthlyAfter,
        total:
          params.subscription_details?.proration_behavior === 'always_invoice'
            ? today
            : monthlyAfter,
        currency: 'usd',
      } as unknown as Stripe.Invoice),
    );
  }

  /** A customer Organization on Starter, its owner signed in. */
  async function givenStarterOwner() {
    await openHostedSignUp(ctx.db);
    const owner = await signUpHostedCustomer(http, recorder, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, 'starter', 'active', {
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      addOns: 2,
    });
    return owner;
  }

  /** Someone invited to the owner's Organization as `role`, acting in it. */
  async function givenInvitee(
    owner: { cookie: string; organizationId: string },
    role: 'admin' | 'member',
  ): Promise<string> {
    const email = `${role}@example.com`;
    const invite = await request(http)
      .post('/organizations/invitations')
      .set('Cookie', owner.cookie)
      .send({ email, role });
    expect(invite.status).toBe(201);
    const inviteId = (invite.body as { id: string }).id;

    const signUp = await request(http)
      .post('/api/auth/sign-up/email')
      .set('x-cloudgate-token', inviteId)
      .send({ name: 'Ida Rhodes', email, password: 'super-secret-password' });
    const cookie = signUp.headers['set-cookie'];
    const accept = await request(http)
      .post(`/organizations/invitations/${inviteId}/accept`)
      .set('Cookie', cookie);
    expect(accept.status).toBe(201);
    const active = await request(http)
      .post('/api/auth/organization/set-active')
      .set('Cookie', cookie)
      .send({ organizationId: owner.organizationId });
    expect(active.status).toBe(200);
    return cookie;
  }

  const preview = (cookie: string) =>
    request(http).get('/billing/upgrade-preview').set('Cookie', cookie);

  const upgrade = (cookie: string, prorationDate: number) =>
    request(http)
      .post('/billing/upgrade')
      .set('Cookie', cookie)
      .send({ prorationDate });

  const licensed = async (cookie: string) =>
    (
      (await request(http).get('/license/status').set('Cookie', cookie))
        .body as { licensed: boolean }
    ).licensed;

  it('previews today’s prorated amount and the monthly amount after, from Stripe’s invoice preview', async () => {
    const owner = await givenStarterOwner();
    const periodEnd = Math.floor(Date.now() / 1000) + 23 * DAY - 60;
    retrieveSubscription.mockResolvedValue(starterAtStripe({ periodEnd }));
    givenPreviews(1533, 4500);

    const before = Math.floor(Date.now() / 1000);
    const res = await preview(owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      today: 1533,
      monthlyAfter: 4500,
      currency: 'usd',
      daysLeft: 23,
      renewsAt: periodEnd,
      prorationDate: expect.any(Number) as number,
    });
    const { prorationDate } = res.body as { prorationDate: number };
    expect(prorationDate).toBeGreaterThanOrEqual(before);

    const items = [{ id: 'si_plan', price: BUSINESS_PRICE }];
    expect(previewInvoice).toHaveBeenCalledWith({
      customer: 'cus_1',
      subscription: 'sub_1',
      subscription_details: {
        items,
        proration_behavior: 'always_invoice',
        proration_date: prorationDate,
      },
    });
    expect(previewInvoice).toHaveBeenCalledWith({
      customer: 'cus_1',
      subscription: 'sub_1',
      subscription_details: { items, proration_behavior: 'none' },
    });
  });

  it('swaps the plan item’s price at once, charged now as previewed, and the Organization passes the paid-feature check immediately', async () => {
    const owner = await givenStarterOwner();
    retrieveSubscription.mockResolvedValue(starterAtStripe());
    updateSubscription.mockResolvedValue(
      starterAtStripe({ plan: BUSINESS_PRICE }),
    );
    expect(await licensed(owner.cookie)).toBe(false);

    const prorationDate = Math.floor(Date.now() / 1000);
    const res = await upgrade(owner.cookie, prorationDate);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ plan: 'business' });
    expect(updateSubscription).toHaveBeenCalledTimes(1);
    expect(updateSubscription).toHaveBeenCalledWith('sub_1', {
      items: [{ id: 'si_plan', price: BUSINESS_PRICE }],
      proration_behavior: 'always_invoice',
      proration_date: prorationDate,
      payment_behavior: 'pending_if_incomplete',
    });
    // No webhook has been delivered: the upgrade wrote the plan itself.
    expect(await licensed(owner.cookie)).toBe(true);
    const [row] = await ctx.db
      .select({ plan: subscription.plan, addOns: subscription.addOns })
      .from(subscription)
      .where(eq(subscription.organizationId, owner.organizationId));
    expect(row).toEqual({ plan: 'business', addOns: 2 });
  });

  it('keeps Starter when the charge does not go through', async () => {
    const owner = await givenStarterOwner();
    retrieveSubscription.mockResolvedValue(starterAtStripe());
    updateSubscription.mockResolvedValue({
      ...starterAtStripe(),
      pending_update: { subscription_items: [] },
    } as unknown as Stripe.Subscription);

    const res = await upgrade(owner.cookie, Math.floor(Date.now() / 1000));

    expect(res.status).toBe(402);
    expect(res.body).toEqual(
      expect.objectContaining({ code: 'UPGRADE_PAYMENT_FAILED' }),
    );
    expect(await licensed(owner.cookie)).toBe(false);
  });

  it('refuses a preview too old to charge what it showed', async () => {
    const owner = await givenStarterOwner();
    retrieveSubscription.mockResolvedValue(starterAtStripe());

    const stale =
      Math.floor(Date.now() / 1000) - PRORATION_DATE_MAX_AGE_SECONDS - 60;
    const res = await upgrade(owner.cookie, stale);

    expect(res.status).toBe(409);
    expect(res.body).toEqual(
      expect.objectContaining({ code: 'UPGRADE_PREVIEW_STALE' }),
    );
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it('refuses Business already held, and a subscription that is not active', async () => {
    const owner = await givenStarterOwner();

    retrieveSubscription.mockResolvedValue(
      starterAtStripe({ plan: BUSINESS_PRICE }),
    );
    const held = await preview(owner.cookie);
    expect(held.status).toBe(409);
    expect(held.body).toEqual(
      expect.objectContaining({ code: 'PLAN_ALREADY_HELD' }),
    );

    retrieveSubscription.mockResolvedValue(
      starterAtStripe({ status: 'past_due' }),
    );
    const pastDue = await upgrade(owner.cookie, Math.floor(Date.now() / 1000));
    expect(pastDue.status).toBe(400);
    expect(pastDue.body).toEqual(
      expect.objectContaining({ message: 'Subscription is not active' }),
    );
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(previewInvoice).not.toHaveBeenCalled();
  });

  it('lets an admin upgrade, and refuses a member both routes', async () => {
    const owner = await givenStarterOwner();
    const member = await givenInvitee(owner, 'member');
    const admin = await givenInvitee(owner, 'admin');
    retrieveSubscription.mockResolvedValue(starterAtStripe());
    updateSubscription.mockResolvedValue(
      starterAtStripe({ plan: BUSINESS_PRICE }),
    );
    givenPreviews(1533, 4500);
    const now = Math.floor(Date.now() / 1000);

    expect((await preview(member)).status).toBe(403);
    expect((await upgrade(member, now)).status).toBe(403);
    expect(previewInvoice).not.toHaveBeenCalled();
    expect(updateSubscription).not.toHaveBeenCalled();

    expect((await preview(admin)).status).toBe(200);
    expect((await upgrade(admin, now)).status).toBe(200);
    expect(await licensed(admin)).toBe(true);
  });

  it('rejects an upgrade with no proration time', async () => {
    const owner = await givenStarterOwner();

    for (const body of [{}, { prorationDate: 'now' }, { prorationDate: 1.5 }]) {
      const res = await request(http)
        .post('/billing/upgrade')
        .set('Cookie', owner.cookie)
        .send(body);
      expect(res.status).toBe(400);
    }
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  describe('the "your plan changed" email', () => {
    /** The catalogue as Stripe prices it: 15, 35 and 5 USD a month. */
    function givenCatalogue() {
      const amounts: Record<string, number> = {
        [STARTER_PRICE]: 1500,
        [BUSINESS_PRICE]: 3500,
        [ADD_ON_PRICE]: 500,
      };
      retrievePrice.mockImplementation((id) =>
        Promise.resolve({
          id,
          unit_amount: amounts[id],
          currency: 'usd',
        } as unknown as Stripe.Price),
      );
    }

    /** Posts an event Stripe has already verified. */
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

    const planChanged = (address: string) =>
      recorder
        .to(address)
        .filter((sent) => sent.email.subject.startsWith('Your plan changed'))
        .map((sent) => ({
          subject: sent.email.subject,
          html: sent.email.html.replace(/<!-- -->/g, ''),
        }));

    /** A day as the emails print it, worked out apart from the code. */
    const printed = (seconds: number) =>
      new Date(seconds * 1000).toLocaleDateString('en-US', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
      });

    it('an upgrade emails every owner and admin once, with the amount charged today and the monthly amount from the renewal', async () => {
      const owner = await givenStarterOwner();
      await givenInvitee(owner, 'admin');
      await givenInvitee(owner, 'member');
      givenCatalogue();
      const periodEnd = Math.floor(Date.now() / 1000) + 23 * DAY - 60;
      retrieveSubscription.mockResolvedValue(starterAtStripe({ periodEnd }));
      const onBusiness = {
        ...starterAtStripe({ plan: BUSINESS_PRICE, periodEnd }),
        latest_invoice: 'in_upgrade',
      } as Stripe.Subscription;
      updateSubscription.mockResolvedValue(onBusiness);
      retrieveInvoice.mockResolvedValue({
        id: 'in_upgrade',
        amount_paid: 1533,
        currency: 'usd',
      } as Stripe.Invoice);

      const res = await upgrade(owner.cookie, Math.floor(Date.now() / 1000));
      expect(res.status).toBe(200);
      // Stripe's own events for the change, delivered twice, send nothing more.
      await postWebhook('customer.subscription.updated', onBusiness);
      await postWebhook('customer.subscription.updated', onBusiness);

      for (const address of ['grace@example.com', 'admin@example.com']) {
        const sent = planChanged(address);
        expect(sent).toHaveLength(1);
        expect(sent[0].subject).toBe(
          'Your plan changed: Hopper Labs is now on Business',
        );
        expect(sent[0].html).toContain(
          'Charged today: $15.33, for the rest of this month on Business',
        );
        expect(sent[0].html).toContain(
          'Plan: Business with 2 Add-ons, for 5 Servers and 5 Cloud Environments.',
        );
        expect(sent[0].html).toContain(
          `Charged: $45.00 per month, from ${printed(periodEnd)}.`,
        );
      }
      expect(planChanged('member@example.com')).toEqual([]);
    });

    it('is sent once by the webhook when its sync records Business before the upgrade does', async () => {
      const owner = await givenStarterOwner();
      givenCatalogue();
      retrieveSubscription.mockResolvedValue(starterAtStripe());
      const onBusiness = {
        ...starterAtStripe({ plan: BUSINESS_PRICE }),
        latest_invoice: {
          id: 'in_upgrade',
          amount_paid: 1533,
          currency: 'usd',
        },
      } as unknown as Stripe.Subscription;
      // Stripe's event reaches the webhook while the upgrade still waits on
      // Stripe's answer.
      updateSubscription.mockImplementation(async () => {
        await postWebhook('customer.subscription.updated', onBusiness);
        return onBusiness;
      });

      const res = await upgrade(owner.cookie, Math.floor(Date.now() / 1000));

      expect(res.status).toBe(200);
      const sent = planChanged('grace@example.com');
      expect(sent).toHaveLength(1);
      expect(sent[0].html).toContain('Charged today: $15.33');
    });

    it('sends nothing when the charge does not go through', async () => {
      const owner = await givenStarterOwner();
      givenCatalogue();
      retrieveSubscription.mockResolvedValue(starterAtStripe());
      updateSubscription.mockResolvedValue({
        ...starterAtStripe(),
        pending_update: { subscription_items: [] },
      } as unknown as Stripe.Subscription);

      expect(
        (await upgrade(owner.cookie, Math.floor(Date.now() / 1000))).status,
      ).toBe(402);
      await postWebhook('customer.subscription.updated', starterAtStripe());

      expect(planChanged('grace@example.com')).toEqual([]);
    });
  });
});
