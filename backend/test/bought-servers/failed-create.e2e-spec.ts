// The Hosted instance with both provider tokens. Set before the app module
// is imported: ConfigModule snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();
process.env.HETZNER_EUR_API_TOKEN = 'eur-token-for-the-fake';
process.env.HETZNER_USD_API_TOKEN = 'usd-token-for-the-fake';

import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  BOUGHT_SERVERS_HOURLY_CRON,
  BOUGHT_SERVERS_HOURLY_JOB_ID,
  BoughtServersHourly,
} from '../../src/bought-servers/bought-servers-hourly.service';
import {
  labelsOf,
  machineNameOf,
  refundKeyOf,
} from '../../src/bought-servers/bought-server-stages.service';
import {
  boughtServer,
  boughtServerLine,
} from '../../src/bought-servers/bought-server.schema';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';
import { MailService } from '../../src/mail/mail.service';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { server } from '../../src/servers/server.schema';
import { fakeStripe } from '../utils/fake-stripe';
import { givenPlan } from '../utils/hosted-plan';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import type { HostedCustomer } from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const RENEWS_AT = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);
const INVOICE = 'in_purchase';
const OWNER_EMAIL = 'grace@example.com';

/**
 * A paid-for Bought Server the provider would not make, and a restart in
 * the middle of a stage (#1391, ADR-0071). Refused twice, the payment is
 * refunded in full, the lines come off the subscription, the row goes and
 * the owner is emailed. The hourly job carries on every Bought Server a
 * restart left mid-stage from what is stored, finding a machine already
 * made by its stored id or its labels, so there is never a second one. The
 * provider is the in-memory fake (`ctx.hetzner.machines`), Stripe a small
 * model of one subscription and one invoice, and the job's tick is called
 * directly.
 */
/** A made Bought Server's stage: its first Setup run may already have finished by the time it is read. */
const madeStage = expect.stringMatching(/^(setting_up|ready)$/) as unknown;

describe('A failed create, and a restart mid-stage (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  let hourly: BoughtServersHourly;
  const mail = new MailRecorder();

  /** Whether the purchase is paid at the press, or waits for 3D Secure. */
  let paysAtOnce = true;
  let paid = false;
  let priceCount = 0;
  /** The prices the subscription carries, the plan's first. */
  let carried: string[] = [];
  /** The prices the purchase invoice charges. */
  let charged: string[] = [];
  /** Whether the purchase was paid from the customer's credit balance rather than the card. */
  let fromBalance = false;

  const subscriptionNow = (): Stripe.Subscription =>
    ({
      id: `sub_${owner.organizationId}`,
      object: 'subscription',
      status: 'active',
      customer: `cus_${owner.organizationId}`,
      metadata: {},
      latest_invoice: INVOICE,
      pending_update: null,
      items: {
        data: carried.map((price, i) => ({
          id: `si_${i}`,
          price: { id: price },
          quantity: 1,
          current_period_end: RENEWS_AT,
        })),
      },
    }) as unknown as Stripe.Subscription;

  const invoiceNow = (): Stripe.Invoice =>
    ({
      id: INVOICE,
      object: 'invoice',
      status: paid ? 'paid' : 'open',
      amount_paid: paid && !fromBalance ? 1234 : 0,
      currency: 'usd',
      customer: `cus_${owner.organizationId}`,
      // A credit of $50 on the account; paid from it, $12.34 of it is used.
      starting_balance: fromBalance ? -5000 : 0,
      ending_balance: fromBalance && paid ? -3766 : 0,
      lines: {
        data: charged.map((price) => ({
          pricing: { price_details: { price } },
        })),
      },
      hosted_invoice_url: 'https://invoice.stripe.test/in_purchase',
      parent: {
        subscription_details: { subscription: `sub_${owner.organizationId}` },
      },
      payments: {
        data: fromBalance
          ? []
          : [
              {
                status: paid ? 'paid' : 'open',
                payment: {
                  type: 'payment_intent',
                  payment_intent: {
                    id: 'pi_purchase',
                    status: paid ? 'succeeded' : 'requires_action',
                    last_payment_error: null,
                  },
                },
              },
            ],
      },
    }) as unknown as Stripe.Invoice;

  const createPrice = jest.fn(() =>
    Promise.resolve({ id: `price_bought_${++priceCount}` } as Stripe.Price),
  );
  const updateSubscription = jest.fn(
    (_id: string, params: Stripe.SubscriptionUpdateParams) => {
      const items = params.items ?? [];
      const removed = items
        .filter((item) => item.deleted)
        .map((item) => item.id);
      if (removed.length > 0) {
        carried = carried.filter((_, i) => !removed.includes(`si_${i}`));
        return Promise.resolve(subscriptionNow());
      }
      const added = items.map((item) =>
        item.price ? item.price : 'price_add_on',
      );
      if (added.length > 0) charged = added;
      if (paysAtOnce) {
        carried = [...carried, ...added];
        paid = true;
        return Promise.resolve(subscriptionNow());
      }
      return Promise.resolve({
        ...subscriptionNow(),
        pending_update: { expires_at: RENEWS_AT, subscription_items: [] },
      } as unknown as Stripe.Subscription);
    },
  );
  const createRefund = jest.fn<
    Promise<Stripe.Refund>,
    Parameters<StripeApi['createRefund']>
  >(() =>
    Promise.resolve({ id: 're_1', status: 'succeeded' } as Stripe.Refund),
  );
  const createBalanceTransaction = jest.fn<
    Promise<Stripe.CustomerBalanceTransaction>,
    Parameters<StripeApi['createBalanceTransaction']>
  >(() =>
    Promise.resolve({ id: 'cbtxn_1' } as Stripe.CustomerBalanceTransaction),
  );
  const stripe: StripeApi = fakeStripe({
    createProduct: jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('exists'), { code: 'resource_already_exists' }),
      ),
    ),
    createPrice,
    retrieveSubscription: jest.fn(() => Promise.resolve(subscriptionNow())),
    updateSubscription,
    retrieveInvoice: jest.fn(() => Promise.resolve(invoiceNow())),
    createRefund,
    createBalanceTransaction,
  });

  function buy(): request.Test {
    return request(http)
      .post('/bought-servers')
      .set('Cookie', owner.cookie)
      .send({
        serverType: 'cpx22',
        location: 'hel1',
        name: 'web-1',
        termsAccepted: true,
        prorationDate: Math.floor(Date.now() / 1000),
      });
  }

  /**
   * A purchase whose payment was stored, with the backend gone before it
   * asked the provider for anything: what `markPaid` writes, and no more.
   */
  async function paidThenRestarted(
    stored: { createTries?: number } = {},
  ): Promise<string> {
    paysAtOnce = false;
    const res = await buy();
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    carried = [...carried, 'price_bought_1'];
    paid = true;
    await ctx.db
      .update(boughtServer)
      .set({
        stage: 'creating',
        purchasePaidAt: new Date(),
        createTries: stored.createTries ?? 0,
      })
      .where(eq(boughtServer.id, id));
    await ctx.db
      .update(boughtServerLine)
      .set({ stripeSubscriptionItemId: 'si_1' })
      .where(eq(boughtServerLine.boughtServerId, id));
    return id;
  }

  /** The machine a create made before the backend stopped, its id never stored. */
  async function madeButNotStored(id: string): Promise<number> {
    const made = await ctx.hetzner.machines.createServer({
      name: machineNameOf(id),
      serverType: 'cpx22',
      location: 'hel1',
      image: 'ubuntu-24.04',
      sshPublicKey: 'ssh-ed25519 AAAA',
      labels: labelsOf({ id, organizationId: owner.organizationId }),
    });
    if (!made.ok) throw new Error(made.message);
    return made.value.server.id;
  }

  const rows = () => ctx.db.select().from(boughtServer);
  const serverRows = () => ctx.db.select().from(server);
  const machines = () => ctx.hetzner.machines.servers();
  const refundEmails = () =>
    mail.sent.filter((sent) => /refunded/.test(sent.email.subject));

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        { provide: STRIPE_API, useValue: stripe },
      ],
    });
    http = ctx.app.getHttpServer() as App;
    hourly = ctx.app.get(BoughtServersHourly);
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    mail.clear();
    paysAtOnce = true;
    paid = false;
    priceCount = 0;
    carried = ['price_starter_plan'];
    charged = [];
    fromBalance = false;
    await openHostedSignUp(ctx.db);
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: OWNER_EMAIL,
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, 'starter');
    mail.clear();
  });

  describe('a create the provider refuses twice', () => {
    beforeEach(() => {
      ctx.hetzner.machines.refuse('createServer', 'resource_unavailable', 2);
    });

    it('tries once more, then refunds the payment in full', async () => {
      const res = await buy();

      expect(res.status).toBe(201);
      const id = (res.body as { id: string }).id;
      expect(res.body).toMatchObject({ stage: 'failed' });
      expect(ctx.hetzner.machines.callsTo('createServer')).toHaveLength(2);
      expect(createRefund).toHaveBeenCalledTimes(1);
      expect(createRefund).toHaveBeenCalledWith(
        expect.objectContaining({ payment_intent: 'pi_purchase' }),
        refundKeyOf(id),
      );
      // In full: no amount, so Stripe gives back the whole payment.
      expect(createRefund.mock.calls[0]).not.toHaveProperty('0.amount');
    });

    it('takes its line off the subscription with no proration, and removes the row and its lines', async () => {
      await buy();

      expect(updateSubscription).toHaveBeenLastCalledWith(
        `sub_${owner.organizationId}`,
        {
          items: [{ id: 'si_1', deleted: true }],
          proration_behavior: 'none',
        },
      );
      expect(carried).toEqual(['price_starter_plan']);
      expect(await rows()).toEqual([]);
      expect(await ctx.db.select().from(boughtServerLine)).toEqual([]);
      expect(await serverRows()).toEqual([]);
      expect(machines()).toEqual([]);
    });

    it('emails the owner that the payment was refunded, without naming the provider', async () => {
      await buy();

      const sent = mail.to(OWNER_EMAIL);
      expect(sent).toHaveLength(1);
      const [{ email }] = sent;
      expect(email.subject).toBe(
        'Your Server web-1 could not be created, so your payment was refunded',
      );
      const body = email.html.replace(/<!-- -->/g, '');
      expect(body).toContain(
        'Your payment of $12.34 was refunded in full to the card it was charged to.',
      );
      expect(`${email.subject} ${email.html}`).not.toMatch(/hetzner/i);
    });

    it('takes the Add-on its full Server count added back off with its line', async () => {
      await ctx.db.insert(server).values(
        ['a', 'b', 'c'].map((name, i) => ({
          name,
          ipAddress: `198.51.100.${i + 1}`,
          port: 22,
          organizationId: owner.organizationId,
        })),
      );

      const res = await buy();

      expect(res.body).toMatchObject({ stage: 'failed' });
      expect(charged).toEqual(['price_bought_1', 'price_add_on']);
      expect(updateSubscription).toHaveBeenLastCalledWith(
        `sub_${owner.organizationId}`,
        {
          items: [
            { id: 'si_1', deleted: true },
            { id: 'si_2', deleted: true },
          ],
          proration_behavior: 'none',
        },
      );
      expect(carried).toEqual(['price_starter_plan']);
    });

    it("credits a payment made from the account's credit back to it, and says so", async () => {
      fromBalance = true;

      await buy();

      expect(createRefund).not.toHaveBeenCalled();
      expect(createBalanceTransaction).toHaveBeenCalledWith(
        `cus_${owner.organizationId}`,
        expect.objectContaining({ amount: -1234, currency: 'usd' }),
        expect.stringContaining('-balance'),
      );
      const [{ email }] = mail.to(OWNER_EMAIL);
      expect(email.html.replace(/<!-- -->/g, '')).toContain(
        'Your payment of $12.34 came from your account&#x27;s credit, so it was credited back to that credit in full',
      );
    });

    it('frees the Server count it held', async () => {
      await buy();

      const purchases = await request(http)
        .get('/bought-servers/purchases')
        .set('Cookie', owner.cookie);
      expect(purchases.body).toEqual([]);
    });
  });

  describe('a refund a restart cut off', () => {
    it('is finished by the hourly tick, refunded once and emailed once', async () => {
      ctx.hetzner.machines.refuse('createServer', 'resource_unavailable', 2);
      createRefund.mockImplementationOnce(() =>
        Promise.reject(new Error('connection reset')),
      );

      const res = await buy();
      const id = (res.body as { id: string }).id;
      const [stuck] = await rows();
      expect(stuck).toMatchObject({ id, stage: 'failed' });
      expect(refundEmails()).toEqual([]);

      const tick = await hourly.tick();

      expect(tick.resumed).toEqual([id]);
      expect(createRefund).toHaveBeenCalledTimes(2);
      expect(createRefund.mock.calls.map((call) => call[1])).toEqual([
        refundKeyOf(id),
        refundKeyOf(id),
      ]);
      expect(await rows()).toEqual([]);
      expect(refundEmails()).toHaveLength(1);
    });

    it('takes a payment Stripe says is already refunded as refunded', async () => {
      ctx.hetzner.machines.refuse('createServer', 'resource_unavailable', 2);
      createRefund.mockImplementationOnce(() =>
        Promise.reject(
          Object.assign(new Error('Charge has already been refunded.'), {
            code: 'charge_already_refunded',
          }),
        ),
      );

      await buy();

      expect(await rows()).toEqual([]);
      expect(refundEmails()).toHaveLength(1);
    });
  });

  describe('a restart between the payment and the create', () => {
    it('ends with one machine and one server row after the hourly tick', async () => {
      const id = await paidThenRestarted();
      expect(machines()).toEqual([]);

      const tick = await hourly.tick();

      expect(tick.resumed).toEqual([id]);
      expect(machines()).toHaveLength(1);
      const [row] = await rows();
      // The first Setup run may already have finished: past the create either way.
      expect(row).toMatchObject({ id, stage: madeStage, serverId: id });
      expect(await serverRows()).toHaveLength(1);

      // A second tick finds nothing to make.
      await hourly.tick();
      expect(machines()).toHaveLength(1);
      expect(await serverRows()).toHaveLength(1);
    });

    it('finds a machine made before its id was stored by its labels, rather than making a second', async () => {
      const id = await paidThenRestarted({ createTries: 1 });
      const machineId = await madeButNotStored(id);

      await hourly.tick();

      expect(machines()).toHaveLength(1);
      const [row] = await rows();
      expect(row).toMatchObject({
        stage: madeStage,
        providerServerId: machineId,
        serverId: id,
      });
      const [written] = await serverRows();
      expect(written.ipAddress).toBe(machines()[0].ipv4);
      expect(createRefund).not.toHaveBeenCalled();
    });

    it('finds the machine the last try made before giving up, and never refunds it', async () => {
      const id = await paidThenRestarted({ createTries: 2 });
      await madeButNotStored(id);

      await hourly.tick();

      expect(machines()).toHaveLength(1);
      expect(createRefund).not.toHaveBeenCalled();
      expect((await rows())[0]).toMatchObject({ stage: 'setting_up' });
      expect(await serverRows()).toHaveLength(1);
    });
  });

  describe('a restart between the create and the server row', () => {
    it('ends with one machine and one server row after the hourly tick', async () => {
      // The machine is made and its id stored; reading it back fails, as a
      // restart there would leave it.
      ctx.hetzner.machines.refuse('getServer', 'unavailable');
      const res = await buy();
      const id = (res.body as { id: string }).id;
      const [stuck] = await rows();
      expect(stuck.stage).toBe('creating');
      expect(stuck.providerServerId).not.toBeNull();
      expect(await serverRows()).toEqual([]);

      await hourly.tick();

      expect(machines()).toHaveLength(1);
      expect(ctx.hetzner.machines.callsTo('createServer')).toHaveLength(1);
      const [row] = await rows();
      // The first Setup run may already have finished: past the create either way.
      expect(row).toMatchObject({ id, stage: madeStage, serverId: id });
      const [written] = await serverRows();
      expect(written).toMatchObject({
        serverId: id,
        ipAddress: machines()[0].ipv4,
      });
    });
  });

  describe('the hourly job', () => {
    it('leaves a purchase still waiting for payment alone', async () => {
      paysAtOnce = false;
      await buy();

      const tick = await hourly.tick();

      expect(tick.resumed).toEqual([]);
      // Only the orphan check's list (#1402): nothing is made for it.
      expect(ctx.hetzner.machines.calls.map((call) => call.method)).toEqual([
        'listServers',
      ]);
    });

    it('runs hourly under its scheduled id', () => {
      const scheduling = ctx.app.get(SchedulingService);

      expect(scheduling.has(BOUGHT_SERVERS_HOURLY_JOB_ID)).toBe(true);
      expect(BOUGHT_SERVERS_HOURLY_CRON).toMatch(/^\d+ \* \* \* \*$/);
    });
  });
});
