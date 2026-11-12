// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../../utils/hosted-mode';
const hosted = useHostedMode();

import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';
import { eq } from 'drizzle-orm';
import { subscription } from '../../../src/cloud/billing/billing.schema';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { MailService } from '../../../src/mail/mail.service';
import { fakeStripe, fakeSubscriptionSchedules } from '../../utils/fake-stripe';
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

// Stripe, mocked at its port; its subscription schedules are the shared
// fake's model.
const retrieveSubscription = jest.fn<Promise<Stripe.Subscription>, [string]>();
const updateSubscription = jest.fn<
  Promise<Stripe.Subscription>,
  [string, Stripe.SubscriptionUpdateParams]
>();
const previewInvoice = jest.fn<
  Promise<Stripe.Invoice>,
  [Stripe.InvoiceCreatePreviewParams]
>();
const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();
const schedules = fakeSubscriptionSchedules();
const stripe = fakeStripe({
  retrieveSubscription,
  updateSubscription,
  previewInvoice,
  constructEvent,
  ...schedules.methods,
});

const recorder = new MailRecorder();

/**
 * Business → Starter at the end of the paid month, and "Keep Business"
 * (ADR-0054).
 *
 * The move is a Stripe subscription schedule made from the subscription: this
 * month as it is, then a Starter phase carrying the Add-on item. Its id is
 * stored, the Organization keeps Business — and the paid features — until the
 * renewal, an Add-on change in the meantime goes to both phases, and "Keep
 * Business" releases it with nothing charged.
 */
describe('Downgrading Business to Starter (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;

  /** The subscription as Stripe holds it now. */
  let atStripe: Stripe.Subscription;

  const periodStart = Math.floor(Date.now() / 1000) - 7 * DAY;
  const periodEnd = periodStart + 30 * DAY;

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
    atStripe = businessAtStripe();
    retrieveSubscription.mockImplementation(() => Promise.resolve(atStripe));
    schedules.reset(() => atStripe);
  });

  /** The subscription at Stripe: the plan's item and `addOns` Add-ons. */
  function businessAtStripe({
    plan = BUSINESS_PRICE,
    addOns = 2,
    status = 'active',
    lines = [] as string[],
    schedule = null as string | null,
  } = {}): Stripe.Subscription {
    const item = (id: string, price: string, quantity: number) => ({
      id,
      price: { id: price },
      quantity,
      current_period_start: periodStart,
      current_period_end: periodEnd,
    });
    return {
      id: 'sub_1',
      customer: 'cus_1',
      status,
      schedule,
      metadata: {},
      items: {
        data: [
          item('si_plan', plan, 1),
          ...(addOns > 0 ? [item('si_add_on', ADD_ON_PRICE, addOns)] : []),
          // A Bought Server's lines: each its own price (ADR-0071).
          ...lines.map((price) => item(`si_${price}`, price, 1)),
        ],
      },
    } as unknown as Stripe.Subscription;
  }

  /** A customer Organization on `plan`, its owner signed in. */
  async function givenOwnerOn(plan: 'starter' | 'business' = 'business') {
    await openHostedSignUp(ctx.db);
    const owner = await signUpHostedCustomer(http, recorder, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, plan, 'active', {
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      addOns: 2,
    });
    return owner;
  }

  /** Someone invited to the owner's Organization as a member, acting in it. */
  async function givenMember(owner: {
    cookie: string;
    organizationId: string;
  }): Promise<string> {
    const email = 'member@example.com';
    const invite = await request(http)
      .post('/organizations/invitations')
      .set('Cookie', owner.cookie)
      .send({ email, role: 'member' });
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

  const downgrade = (cookie: string) =>
    request(http).post('/billing/downgrade').set('Cookie', cookie);

  const keepBusiness = (cookie: string) =>
    request(http).delete('/billing/downgrade').set('Cookie', cookie);

  const setAddOns = (cookie: string, addOns: number) =>
    request(http)
      .post('/billing/add-ons')
      .set('Cookie', cookie)
      .send({ addOns });

  const billing = async (cookie: string) =>
    (await request(http).get('/billing/subscription').set('Cookie', cookie))
      .body as { scheduledPlan: string | null; scheduledAt: string | null };

  const licensed = async (cookie: string) =>
    (
      (await request(http).get('/license/status').set('Cookie', cookie))
        .body as { licensed: boolean }
    ).licensed;

  async function storedRow(organizationId: string) {
    const [row] = await ctx.db
      .select({
        plan: subscription.plan,
        addOns: subscription.addOns,
        stripeScheduleId: subscription.stripeScheduleId,
        downgradeAt: subscription.downgradeAt,
      })
      .from(subscription)
      .where(eq(subscription.organizationId, organizationId));
    return row;
  }

  /** Posts an event Stripe has already verified. */
  function postWebhook(type: string, object: unknown) {
    const event = { type, data: { object } } as unknown as Stripe.Event;
    constructEvent.mockReturnValue(event);
    return request(http)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event));
  }

  /** The renewal: Stripe enters the Starter phase and says so. */
  async function renewal(scheduleId: string) {
    atStripe = schedules.advance(scheduleId);
    const res = await postWebhook('customer.subscription.updated', atStripe);
    expect(res.status).toBe(200);
  }

  it('schedules Starter for the end of the paid month: the schedule id is stored, nothing is charged, and Business still passes the paid-feature check', async () => {
    const owner = await givenOwnerOn('business');

    const res = await downgrade(owner.cookie);

    expect(res.status).toBe(200);
    const scheduledAt = new Date(periodEnd * 1000).toISOString();
    expect(res.body).toEqual({ scheduledPlan: 'starter', scheduledAt });
    expect(schedules.methods.createSubscriptionSchedule).toHaveBeenCalledWith({
      from_subscription: 'sub_1',
    });
    const [scheduleId] = schedules.ids();
    const schedule = schedules.get(scheduleId);
    expect(schedule.end_behavior).toBe('release');
    expect(schedule.phases).toEqual([
      expect.objectContaining({
        start_date: periodStart,
        end_date: periodEnd,
        items: [
          { price: BUSINESS_PRICE, quantity: 1 },
          { price: ADD_ON_PRICE, quantity: 2 },
        ],
      }),
      expect.objectContaining({
        start_date: periodEnd,
        items: [
          { price: STARTER_PRICE, quantity: 1 },
          { price: ADD_ON_PRICE, quantity: 2 },
        ],
      }),
    ]);
    expect(schedules.methods.updateSubscriptionSchedule).toHaveBeenCalledWith(
      scheduleId,
      expect.objectContaining({ proration_behavior: 'none' }),
    );
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(previewInvoice).not.toHaveBeenCalled();

    expect(await storedRow(owner.organizationId)).toEqual({
      plan: 'business',
      addOns: 2,
      stripeScheduleId: scheduleId,
      downgradeAt: new Date(periodEnd * 1000),
    });
    expect(await licensed(owner.cookie)).toBe(true);
    expect(await billing(owner.cookie)).toEqual(
      expect.objectContaining({ scheduledPlan: 'starter', scheduledAt }),
    );
  });

  /**
   * The "Before Hopper Labs can move to Starter" checklist: each
   * Attached Organization is detached ("Stop paying for it") or, for one the
   * reader owns, deleted, and once the list is empty the move goes through.
   */
  it('goes through once each Attached Organization is detached or deleted, the list the checklist reads emptying as it does', async () => {
    const owner = await givenOwnerOn('business');
    const addToPlan = async (name: string) => {
      const made = await request(http)
        .post('/organizations')
        .set('Cookie', owner.cookie)
        .send({ name, paidBy: 'active-organization' });
      expect(made.status).toBe(201);
      return (made.body as { id: string }).id;
    };
    const turing = await addToPlan('Turing Works');
    const babbage = await addToPlan('Babbage Engines');
    const checklist = async () => {
      const res = await request(http)
        .get('/billing/attached-organizations')
        .set('Cookie', owner.cookie);
      expect(res.status).toBe(200);
      return res.body as {
        name: string;
        organizations: Array<{ id: string; ownedByYou: boolean }>;
      };
    };

    expect(await checklist()).toMatchObject({
      name: 'Hopper Labs',
      organizations: [
        { id: turing, ownedByYou: true },
        { id: babbage, ownedByYou: true },
      ],
    });
    const refused = await downgrade(owner.cookie);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'ORGANIZATIONS_ATTACHED' });

    const detached = await request(http)
      .post(`/billing/attached-organizations/${turing}/stop-paying`)
      .set('Cookie', owner.cookie);
    expect(detached.status).toBe(200);
    const deleted = await request(http)
      .delete(`/organizations/${babbage}`)
      .set('Cookie', owner.cookie);
    expect(deleted.status).toBe(200);
    expect((await checklist()).organizations).toEqual([]);

    const moved = await downgrade(owner.cookie);

    expect(moved.status).toBe(200);
    expect(moved.body).toEqual({
      scheduledPlan: 'starter',
      scheduledAt: new Date(periodEnd * 1000).toISOString(),
    });
  });

  it('is on Starter once the schedule reaches its Starter phase, with the schedule released and its id cleared', async () => {
    const owner = await givenOwnerOn('business');
    expect((await downgrade(owner.cookie)).status).toBe(200);
    const [scheduleId] = schedules.ids();

    await renewal(scheduleId);

    expect(await storedRow(owner.organizationId)).toEqual({
      plan: 'starter',
      addOns: 2,
      stripeScheduleId: null,
      downgradeAt: null,
    });
    expect(schedules.methods.releaseSubscriptionSchedule).toHaveBeenCalledWith(
      scheduleId,
    );
    expect(schedules.get(scheduleId).status).toBe('released');
    expect(await licensed(owner.cookie)).toBe(false);
    expect(await billing(owner.cookie)).toEqual(
      expect.objectContaining({ scheduledPlan: null, scheduledAt: null }),
    );

    // The release's own event, arriving after, changes nothing.
    const released = await postWebhook(
      'subscription_schedule.released',
      schedules.get(scheduleId),
    );
    expect(released.status).toBe(200);
    expect(await storedRow(owner.organizationId)).toEqual(
      expect.objectContaining({ plan: 'starter', stripeScheduleId: null }),
    );
  });

  it.each([
    'subscription_schedule.completed',
    'subscription_schedule.released',
    'subscription_schedule.canceled',
    'subscription_schedule.aborted',
  ])(
    'forgets the stored schedule on %s, and leaves one it does not name',
    async (type) => {
      const owner = await givenOwnerOn('business');
      expect((await downgrade(owner.cookie)).status).toBe(200);
      const [scheduleId] = schedules.ids();

      const other = await postWebhook(type, { id: 'sub_sched_other' });
      expect(other.status).toBe(200);
      expect(await storedRow(owner.organizationId)).toEqual(
        expect.objectContaining({ stripeScheduleId: scheduleId }),
      );

      const ended = await postWebhook(type, { id: scheduleId });
      expect(ended.status).toBe(200);
      expect(await storedRow(owner.organizationId)).toEqual(
        expect.objectContaining({
          plan: 'business',
          stripeScheduleId: null,
          downgradeAt: null,
        }),
      );
    },
  );

  it('keeps Business: the schedule is released, nothing is charged, and the Organization stays on Business', async () => {
    const owner = await givenOwnerOn('business');
    expect((await downgrade(owner.cookie)).status).toBe(200);
    const [scheduleId] = schedules.ids();

    const res = await keepBusiness(owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ plan: 'business' });
    expect(schedules.methods.releaseSubscriptionSchedule).toHaveBeenCalledWith(
      scheduleId,
    );
    expect(schedules.get(scheduleId).status).toBe('released');
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(previewInvoice).not.toHaveBeenCalled();
    expect(await storedRow(owner.organizationId)).toEqual({
      plan: 'business',
      addOns: 2,
      stripeScheduleId: null,
      downgradeAt: null,
    });
    expect(await licensed(owner.cookie)).toBe(true);
    expect(await billing(owner.cookie)).toEqual(
      expect.objectContaining({ scheduledPlan: null, scheduledAt: null }),
    );

    const again = await keepBusiness(owner.cookie);
    expect(again.status).toBe(409);
    expect(again.body).toEqual(
      expect.objectContaining({ code: 'NO_DOWNGRADE_WAITING' }),
    );
  });

  it('writes an Add-on change while the move waits to both phases through the schedule, and the count carries across the move', async () => {
    const owner = await givenOwnerOn('business');
    expect((await downgrade(owner.cookie)).status).toBe(200);
    const [scheduleId] = schedules.ids();

    const res = await setAddOns(owner.cookie, 4);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ addOns: 4 });
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(
      schedules.methods.updateSubscriptionSchedule,
    ).toHaveBeenLastCalledWith(
      scheduleId,
      expect.objectContaining({ proration_behavior: 'create_prorations' }),
    );
    expect(
      schedules.get(scheduleId).phases.map((phase) => phase.items),
    ).toEqual([
      [
        { price: BUSINESS_PRICE, quantity: 1 },
        { price: ADD_ON_PRICE, quantity: 4 },
      ],
      [
        { price: STARTER_PRICE, quantity: 1 },
        { price: ADD_ON_PRICE, quantity: 4 },
      ],
    ]);

    await renewal(scheduleId);

    expect(await storedRow(owner.organizationId)).toEqual(
      expect.objectContaining({
        plan: 'starter',
        addOns: 4,
        stripeScheduleId: null,
      }),
    );
  });

  it('refuses Starter already, a move already waiting, and a subscription that is not active', async () => {
    const owner = await givenOwnerOn('starter');
    atStripe = businessAtStripe({ plan: STARTER_PRICE });

    const onStarter = await downgrade(owner.cookie);
    expect(onStarter.status).toBe(409);
    expect(onStarter.body).toEqual(
      expect.objectContaining({ code: 'DOWNGRADE_NOT_AVAILABLE' }),
    );

    await givenPlan(ctx, owner.organizationId, 'business', 'past_due');
    atStripe = businessAtStripe({ status: 'past_due' });
    const pastDue = await downgrade(owner.cookie);
    expect(pastDue.status).toBe(400);
    expect(schedules.methods.createSubscriptionSchedule).not.toHaveBeenCalled();

    await givenPlan(ctx, owner.organizationId, 'business');
    atStripe = businessAtStripe();
    expect((await downgrade(owner.cookie)).status).toBe(200);
    const twice = await downgrade(owner.cookie);
    expect(twice.status).toBe(409);
    expect(twice.body).toEqual(
      expect.objectContaining({ code: 'DOWNGRADE_ALREADY_WAITING' }),
    );
    expect(schedules.ids()).toHaveLength(1);
  });

  it('carries the Bought Server lines into the Starter phase, so they are still on the subscription after the move', async () => {
    const owner = await givenOwnerOn('business');
    atStripe = businessAtStripe({
      lines: ['price_bs_server', 'price_bs_backups'],
    });

    expect((await downgrade(owner.cookie)).status).toBe(200);
    const [scheduleId] = schedules.ids();

    expect(schedules.get(scheduleId).phases[1]?.items).toEqual([
      { price: STARTER_PRICE, quantity: 1 },
      { price: 'price_bs_server', quantity: 1 },
      { price: 'price_bs_backups', quantity: 1 },
      { price: ADD_ON_PRICE, quantity: 2 },
    ]);
    await renewal(scheduleId);
    expect(atStripe.items.data.map((item) => item.price.id)).toEqual(
      expect.arrayContaining([
        STARTER_PRICE,
        'price_bs_server',
        'price_bs_backups',
      ]),
    );
  });

  it('writes a line added, repriced or removed while the move waits onto the Starter phase too, once the subscription says so', async () => {
    const owner = await givenOwnerOn('business');
    atStripe = businessAtStripe({ lines: ['price_bs_server'] });
    expect((await downgrade(owner.cookie)).status).toBe(200);
    const [scheduleId] = schedules.ids();

    // A Bought Server bought, and the first one's price swapped by a
    // reprice: two plain subscription updates while the schedule waits.
    atStripe = businessAtStripe({
      lines: ['price_bs_server_repriced', 'price_bs_second'],
      schedule: scheduleId,
    });
    const updated = await postWebhook(
      'customer.subscription.updated',
      atStripe,
    );
    expect(updated.status).toBe(200);

    const phases = schedules.get(scheduleId).phases;
    expect(phases[0]?.items).toEqual([
      { price: BUSINESS_PRICE, quantity: 1 },
      { price: ADD_ON_PRICE, quantity: 2 },
      { price: 'price_bs_server_repriced', quantity: 1 },
      { price: 'price_bs_second', quantity: 1 },
    ]);
    expect(phases[1]?.items).toEqual([
      { price: STARTER_PRICE, quantity: 1 },
      { price: ADD_ON_PRICE, quantity: 2 },
      { price: 'price_bs_server_repriced', quantity: 1 },
      { price: 'price_bs_second', quantity: 1 },
    ]);
    expect(
      schedules.methods.updateSubscriptionSchedule,
    ).toHaveBeenLastCalledWith(
      scheduleId,
      expect.objectContaining({ proration_behavior: 'none' }),
    );

    // The same event again writes nothing.
    const calls =
      schedules.methods.updateSubscriptionSchedule.mock.calls.length;
    await postWebhook('customer.subscription.updated', atStripe);
    expect(schedules.methods.updateSubscriptionSchedule).toHaveBeenCalledTimes(
      calls,
    );
  });

  it('refuses a member both routes', async () => {
    const owner = await givenOwnerOn('business');
    const member = await givenMember(owner);

    expect((await downgrade(member)).status).toBe(403);
    expect((await keepBusiness(member)).status).toBe(403);
    expect(schedules.methods.createSubscriptionSchedule).not.toHaveBeenCalled();
    expect(
      schedules.methods.releaseSubscriptionSchedule,
    ).not.toHaveBeenCalled();
  });
});
