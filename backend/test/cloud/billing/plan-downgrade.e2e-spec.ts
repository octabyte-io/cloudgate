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
import { signUpMember } from '../../utils/test-auth';
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
const retrievePrice = jest.fn<Promise<Stripe.Price>, [string]>();
const schedules = fakeSubscriptionSchedules();
const stripe = fakeStripe({
  retrieveSubscription,
  updateSubscription,
  previewInvoice,
  constructEvent,
  retrievePrice,
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
    recorder.clear();
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

  // The confirmation emails' cast and catalogue (spec #69).
  const OWNER = 'grace@example.com';
  const ADMIN = 'ada@example.com';
  const MEMBER = 'edsger@example.com';

  /** Hopper Labs on Business, with an admin and a member; the catalogue at 15, 35 and 5 USD. */
  async function givenBusinessWithAdmin() {
    const owner = await givenOwnerOn('business');
    await signUpMember(http, owner.cookie, {
      email: ADMIN,
      name: 'Ada Lovelace',
      role: 'admin',
    });
    await signUpMember(http, owner.cookie, {
      email: MEMBER,
      name: 'Edsger Dijkstra',
      role: 'member',
    });
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
    recorder.clear();
    return owner;
  }

  /** The end of the paid month as the emails print it, worked out apart from the code. */
  const monthEnd = new Date(periodEnd * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });

  describe('the "your plan changed" email', () => {
    const planChanged = (address: string) =>
      recorder
        .to(address)
        .filter((sent) => sent.email.subject.startsWith('Your plan changed'))
        .map((sent) => ({
          subject: sent.email.subject,
          html: sent.email.html.replace(/<!-- -->/g, ''),
        }));

    it('scheduling the move to Starter emails every owner and admin its date, and the move taking effect emails them again, once', async () => {
      const owner = await givenBusinessWithAdmin();

      expect((await downgrade(owner.cookie)).status).toBe(200);

      for (const address of [OWNER, ADMIN]) {
        const sent = planChanged(address);
        expect(sent).toHaveLength(1);
        expect(sent[0].subject).toBe(
          `Your plan changed: Hopper Labs moves to Starter on ${monthEnd}`,
        );
        expect(sent[0].html).toContain(
          'Plan: Starter with 2 Add-ons, for 5 Servers and 5 Cloud Environments.',
        );
        expect(sent[0].html).toContain(
          `Charged: $25.00 per month, from ${monthEnd}.`,
        );
      }

      const [scheduleId] = schedules.ids();
      await renewal(scheduleId);
      // Stripe delivers the renewal again, and the release's own event
      // twice: nothing more, and never "stays on Business".
      expect(
        (await postWebhook('customer.subscription.updated', atStripe)).status,
      ).toBe(200);
      for (let i = 0; i < 2; i++) {
        expect(
          (
            await postWebhook(
              'subscription_schedule.released',
              schedules.get(scheduleId),
            )
          ).status,
        ).toBe(200);
      }

      for (const address of [OWNER, ADMIN]) {
        const sent = planChanged(address);
        expect(sent).toHaveLength(2);
        expect(sent[1].subject).toBe(
          'Your plan changed: Hopper Labs is now on Starter',
        );
        expect(sent[1].html).toContain(
          'Hopper Labs moved from Business to Starter today.',
        );
        expect(sent[1].html).toContain(
          `Charged: $25.00 per month, from ${monthEnd}.`,
        );
      }
      expect(planChanged(MEMBER)).toEqual([]);
    });

    it('Keep Business emails every owner and admin that it stays on Business, and the schedule’s release sends nothing more', async () => {
      const owner = await givenBusinessWithAdmin();
      expect((await downgrade(owner.cookie)).status).toBe(200);
      const [scheduleId] = schedules.ids();
      recorder.clear();

      expect((await keepBusiness(owner.cookie)).status).toBe(200);
      // The release's own event, after Keep Business forgot the schedule,
      // and delivered again.
      for (let i = 0; i < 2; i++) {
        expect(
          (
            await postWebhook(
              'subscription_schedule.released',
              schedules.get(scheduleId),
            )
          ).status,
        ).toBe(200);
      }

      for (const address of [OWNER, ADMIN]) {
        const sent = planChanged(address);
        expect(sent).toHaveLength(1);
        expect(sent[0].subject).toBe(
          'Your plan changed: Hopper Labs stays on Business',
        );
        expect(sent[0].html).toContain(
          'Plan: Business with 2 Add-ons, for 5 Servers and 5 Cloud Environments.',
        );
        expect(sent[0].html).toContain(
          `Charged: $45.00 per month, from ${monthEnd}.`,
        );
      }
      expect(planChanged(MEMBER)).toEqual([]);
    });

    it('Keep Business emails "stays on Business" once when subscription_schedule.released gets there before Keep Business forgets the schedule', async () => {
      const owner = await givenBusinessWithAdmin();
      expect((await downgrade(owner.cookie)).status).toBe(200);
      const [scheduleId] = schedules.ids();
      // Stripe delivers `subscription_schedule.released` before its answer
      // to the release reaches Keep Business.
      const release = schedules.methods.releaseSubscriptionSchedule;
      const released = release.getMockImplementation()!;
      release.mockImplementation(async (id) => {
        const schedule = await released(id);
        expect(
          (await postWebhook('subscription_schedule.released', schedule))
            .status,
        ).toBe(200);
        return schedule;
      });
      recorder.clear();

      expect((await keepBusiness(owner.cookie)).status).toBe(200);
      // Delivered again.
      expect(
        (
          await postWebhook(
            'subscription_schedule.released',
            schedules.get(scheduleId),
          )
        ).status,
      ).toBe(200);

      for (const address of [OWNER, ADMIN]) {
        expect(planChanged(address).map((one) => one.subject)).toEqual([
          'Your plan changed: Hopper Labs stays on Business',
        ]);
      }
      expect(await storedRow(owner.organizationId)).toEqual(
        expect.objectContaining({
          plan: 'business',
          stripeScheduleId: null,
          downgradeAt: null,
        }),
      );
    });

    it('Keep Business that Stripe refuses leaves the move waiting and sends nothing', async () => {
      const owner = await givenBusinessWithAdmin();
      expect((await downgrade(owner.cookie)).status).toBe(200);
      const [scheduleId] = schedules.ids();
      schedules.methods.releaseSubscriptionSchedule.mockRejectedValueOnce(
        new Error('Stripe is down'),
      );
      recorder.clear();

      expect((await keepBusiness(owner.cookie)).status).toBe(500);

      expect(await storedRow(owner.organizationId)).toEqual(
        expect.objectContaining({ stripeScheduleId: scheduleId }),
      );
      expect(planChanged(OWNER)).toEqual([]);
    });

    it('a schedule released after its move to Starter took effect at Stripe never sends "stays on Business", even before the move’s own event', async () => {
      const owner = await givenBusinessWithAdmin();
      expect((await downgrade(owner.cookie)).status).toBe(200);
      const [scheduleId] = schedules.ids();
      recorder.clear();

      // Stripe is in the Starter phase, and lets the schedule go, before
      // `customer.subscription.updated` for the move arrives.
      atStripe = schedules.advance(scheduleId);
      await schedules.methods.releaseSubscriptionSchedule(scheduleId);
      expect(
        (
          await postWebhook(
            'subscription_schedule.released',
            schedules.get(scheduleId),
          )
        ).status,
      ).toBe(200);
      expect(
        (await postWebhook('customer.subscription.updated', atStripe)).status,
      ).toBe(200);

      for (const address of [OWNER, ADMIN]) {
        expect(planChanged(address).map((one) => one.subject)).toEqual([
          'Your plan changed: Hopper Labs is now on Starter',
        ]);
      }
    });

    it('sends nothing for a move refused while one already waits', async () => {
      const owner = await givenBusinessWithAdmin();
      expect((await downgrade(owner.cookie)).status).toBe(200);

      expect((await downgrade(owner.cookie)).status).toBe(409);

      expect(planChanged(OWNER)).toHaveLength(1);
    });
  });

  describe('the "your Add-ons changed" email', () => {
    const addOnsChanged = (address: string) =>
      recorder
        .to(address)
        .filter((sent) => sent.email.subject.startsWith('Your Add-ons changed'))
        .map((sent) => ({
          subject: sent.email.subject,
          html: sent.email.html.replace(/<!-- -->/g, ''),
        }));

    it('changing the count emails every owner and admin once, with the new count and monthly amount, and the webhook carrying it twice sends nothing more', async () => {
      const owner = await givenBusinessWithAdmin();

      expect((await setAddOns(owner.cookie, 4)).status).toBe(200);
      expect(updateSubscription).toHaveBeenCalledTimes(1);
      atStripe = businessAtStripe({ addOns: 4 });
      for (let delivery = 0; delivery < 2; delivery++) {
        expect(
          (await postWebhook('customer.subscription.updated', atStripe)).status,
        ).toBe(200);
      }

      for (const address of [OWNER, ADMIN]) {
        const sent = addOnsChanged(address);
        expect(sent).toHaveLength(1);
        expect(sent[0].subject).toBe(
          'Your Add-ons changed: Hopper Labs now has 4 Add-ons',
        );
        expect(sent[0].html).toContain(
          'Hopper Labs went from 2 Add-ons to 4 Add-ons today.',
        );
        expect(sent[0].html).toContain(
          'Plan: Business with 4 Add-ons, for 7 Servers and 7 Cloud Environments.',
        );
        expect(sent[0].html).toContain(
          `Charged: $55.00 per month, from ${monthEnd}.`,
        );
      }
      expect(addOnsChanged(MEMBER)).toEqual([]);
    });

    it('a change while the move to Starter waits emails once, with Starter’s monthly amount from the move, and the move sends no more of it', async () => {
      const owner = await givenBusinessWithAdmin();
      expect((await downgrade(owner.cookie)).status).toBe(200);
      const [scheduleId] = schedules.ids();

      expect((await setAddOns(owner.cookie, 4)).status).toBe(200);
      await renewal(scheduleId);

      for (const address of [OWNER, ADMIN]) {
        const sent = addOnsChanged(address);
        expect(sent).toHaveLength(1);
        expect(sent[0].subject).toBe(
          'Your Add-ons changed: Hopper Labs now has 4 Add-ons',
        );
        expect(sent[0].html).toContain(
          `Hopper Labs keeps Business until ${monthEnd}, then moves to Starter with 4 Add-ons.`,
        );
        expect(sent[0].html).toContain(
          'Plan: Starter with 4 Add-ons, for 7 Servers and 7 Cloud Environments.',
        );
        expect(sent[0].html).toContain(
          `Charged: $35.00 per month, from ${monthEnd}.`,
        );
      }
      expect(addOnsChanged(MEMBER)).toEqual([]);
    });

    it('setting the same count sends nothing', async () => {
      const owner = await givenBusinessWithAdmin();

      const res = await setAddOns(owner.cookie, 2);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ addOns: 2 });
      expect(addOnsChanged(OWNER)).toEqual([]);
      expect(addOnsChanged(ADMIN)).toEqual([]);
    });
  });
});
