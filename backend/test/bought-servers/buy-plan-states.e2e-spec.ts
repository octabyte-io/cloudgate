// The Hosted instance with both provider tokens. Set before the app module is
// imported: ConfigModule snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();
process.env.HETZNER_EUR_API_TOKEN = 'eur-token-for-the-fake';
process.env.HETZNER_USD_API_TOKEN = 'usd-token-for-the-fake';

import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  boughtServer,
  boughtServerLine,
} from '../../src/bought-servers/bought-server.schema';
import {
  subscription,
  trialHistory,
} from '../../src/cloud/billing/billing.schema';
import { BoughtServersHourly } from '../../src/bought-servers/bought-servers-hourly.service';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';
import { MailService } from '../../src/mail/mail.service';
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

const DAY = 24 * 60 * 60;
const RENEWS_AT = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);
const CHECKOUT_URL = 'https://checkout.stripe.test/c/pay/cs_buy#fragment';
const TRIAL_PAY_URL = 'https://invoice.stripe.test/in_trial';
const STARTER_CENTS = 1500;
const ADD_ON_CENTS = 500;
/** The cpx22 in Helsinki: $25 a month (buy.e2e-spec works it out). */
const SERVER_CENTS = 2500;

/** How the fake Stripe answers a charge. */
type CardMode = 'paid' | 'needs-3ds';

interface FakeInvoice {
  id: string;
  status: Stripe.Invoice.Status;
  intent: string | null;
  subscription: string | null;
  /** What it charges, by price: only Checkout's first invoice says. */
  lines?: Array<{ price: string; amount: number; quantity: number }>;
}

/**
 * Buying a Server in every plan state (#1392, ADR-0071 and the amendment to
 * ADR-0054): on a plan, in the Free trial, with no plan and the trial
 * available or used, and with the Server count full. Stripe is `fakeStripe`
 * with a small model of one subscription, its items and its invoices; the
 * provider is the in-memory fake.
 */
describe('Buying a Server in each plan state (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  const mail = new MailRecorder();

  let status: Stripe.Subscription.Status = 'active';
  let trialEnd: number | null = null;
  let funding = 'credit';
  let cardMode: CardMode = 'paid';
  let checkoutStatus: Stripe.Checkout.Session.Status = 'open';
  /** The subscription's items: price id and quantity, the plan's first. */
  let carried: Array<{ price: string; quantity: number }> = [];
  let invoices = new Map<string, FakeInvoice>();
  let latestInvoice: string | null = null;
  let priceCount = 0;
  let invoiceCount = 0;

  const subscriptionId = () => `sub_${owner.organizationId}`;

  const subscriptionNow = (): Stripe.Subscription =>
    ({
      id: subscriptionId(),
      object: 'subscription',
      status,
      trial_end: trialEnd,
      customer: `cus_${owner.organizationId}`,
      metadata: { organizationId: owner.organizationId },
      default_payment_method: 'pm_card',
      latest_invoice: latestInvoice,
      pending_update: null,
      items: {
        data: carried.map((item, i) => ({
          id: `si_${item.price}`,
          price: {
            id: item.price,
            unit_amount: i === 0 ? STARTER_CENTS : SERVER_CENTS,
            currency: 'usd',
          },
          quantity: item.quantity,
          current_period_end: RENEWS_AT,
        })),
      },
    }) as unknown as Stripe.Subscription;

  const invoiceView = (invoice: FakeInvoice): Stripe.Invoice =>
    ({
      id: invoice.id,
      object: 'invoice',
      status: invoice.status,
      amount_paid:
        invoice.status === 'paid'
          ? (invoice.lines?.reduce((sum, line) => sum + line.amount, 0) ?? 1234)
          : 0,
      currency: 'usd',
      customer: `cus_${owner.organizationId}`,
      lines: {
        data: (invoice.lines ?? []).map((line) => ({
          amount: line.amount,
          quantity: line.quantity,
          pricing: { price_details: { price: line.price } },
        })),
      },
      hosted_invoice_url: `https://invoice.stripe.test/${invoice.id}`,
      parent: invoice.subscription
        ? { subscription_details: { subscription: invoice.subscription } }
        : null,
      payments: {
        data: invoice.intent
          ? [
              {
                status: invoice.status === 'paid' ? 'paid' : 'open',
                payment: {
                  type: 'payment_intent',
                  payment_intent: { id: 'pi_1', status: invoice.intent },
                },
              },
            ]
          : [],
      },
    }) as unknown as Stripe.Invoice;

  const newInvoice = (subscription: string | null): FakeInvoice => {
    const invoice: FakeInvoice = {
      id: subscription ? `in_sub_${++invoiceCount}` : 'in_trial',
      status: 'open',
      intent: null,
      subscription,
    };
    invoices.set(invoice.id, invoice);
    return invoice;
  };

  const createProduct = jest.fn(() =>
    Promise.reject(
      Object.assign(new Error('exists'), { code: 'resource_already_exists' }),
    ),
  );
  const createPrice = jest.fn(() =>
    Promise.resolve({ id: `price_bought_${++priceCount}` } as Stripe.Price),
  );
  const retrievePrice = jest.fn((id: string) =>
    Promise.resolve({
      id,
      unit_amount: id === 'price_add_on' ? ADD_ON_CENTS : STARTER_CENTS,
    } as Stripe.Price),
  );
  const retrieveSubscription = jest.fn(() =>
    Promise.resolve(subscriptionNow()),
  );
  const retrieveCustomer = jest.fn(() =>
    Promise.resolve({
      id: `cus_${owner.organizationId}`,
      invoice_settings: { default_payment_method: null },
    } as unknown as Stripe.Customer),
  );
  const retrievePaymentMethod = jest.fn(() =>
    Promise.resolve({
      id: 'pm_card',
      card: { funding, fingerprint: 'fp_card' },
    } as unknown as Stripe.PaymentMethod),
  );
  const updateSubscription = jest.fn(
    (_id: string, params: Stripe.SubscriptionUpdateParams) => {
      for (const item of params.items ?? []) {
        if (item.deleted) {
          carried = carried.filter((one) => `si_${one.price}` !== item.id);
        } else if (item.id) {
          const held = carried.find((one) => `si_${one.price}` === item.id);
          if (held) held.quantity = item.quantity ?? held.quantity;
        } else if (item.price) {
          carried = [
            ...carried,
            { price: item.price, quantity: item.quantity ?? 1 },
          ];
        }
      }
      if (params.proration_behavior === 'always_invoice') {
        const invoice = newInvoice(subscriptionId());
        invoice.status = 'paid';
        invoice.intent = 'succeeded';
        latestInvoice = invoice.id;
      }
      return Promise.resolve(subscriptionNow());
    },
  );
  const previewInvoice = jest.fn(() =>
    Promise.resolve({ amount_due: 1520, currency: 'usd' } as Stripe.Invoice),
  );
  const createInvoice = jest.fn(() =>
    Promise.resolve(invoiceView(newInvoice(null))),
  );
  const createInvoiceItem = jest.fn(() =>
    Promise.resolve({ id: 'ii_1' } as Stripe.InvoiceItem),
  );
  const finalizeInvoice = jest.fn((id: string) =>
    Promise.resolve(invoiceView(invoices.get(id)!)),
  );
  const payInvoice = jest.fn((id: string) => {
    const invoice = invoices.get(id)!;
    if (cardMode === 'needs-3ds') {
      invoice.intent = 'requires_action';
      return Promise.reject(
        Object.assign(new Error('This payment requires additional action.'), {
          type: 'StripeCardError',
          code: 'invoice_payment_intent_requires_action',
        }),
      );
    }
    invoice.status = 'paid';
    invoice.intent = 'succeeded';
    return Promise.resolve(invoiceView(invoice));
  });
  const retrieveInvoice = jest.fn((id: string) =>
    Promise.resolve(invoiceView(invoices.get(id)!)),
  );
  const voidInvoice = jest.fn((id: string) => {
    const invoice = invoices.get(id)!;
    invoice.status = 'void';
    return Promise.resolve(invoiceView(invoice));
  });
  const checkoutSession = (): Stripe.Checkout.Session =>
    ({
      id: 'cs_buy',
      object: 'checkout.session',
      status: checkoutStatus,
      url: CHECKOUT_URL,
      customer: `cus_${owner.organizationId}`,
      subscription: checkoutStatus === 'complete' ? subscriptionId() : null,
      invoice: checkoutInvoice,
      metadata: {
        organizationId: owner.organizationId,
        boughtServerId: boughtServerIdOfCheckout,
      },
    }) as unknown as Stripe.Checkout.Session;
  let boughtServerIdOfCheckout = '';
  /** What the last Checkout was asked to start the subscription with. */
  let checkoutLines: Array<{ price: string; quantity: number }> = [];
  /** The first invoice of the subscription Checkout started, once it completed. */
  let checkoutInvoice: string | null = null;

  /**
   * Checkout completes with no Free trial: the subscription starts with what
   * Checkout carried, and its first invoice, charging all of it, is paid.
   */
  const completeCheckout = () => {
    checkoutStatus = 'complete';
    carried = checkoutLines.map((line) => ({ ...line }));
    const invoice = newInvoice(subscriptionId());
    invoice.status = 'paid';
    invoice.intent = 'succeeded';
    invoice.lines = checkoutLines.map((line) => ({
      ...line,
      amount:
        line.quantity *
        (line.price === 'price_starter_plan'
          ? STARTER_CENTS
          : line.price === 'price_add_on'
            ? ADD_ON_CENTS
            : SERVER_CENTS),
    }));
    latestInvoice = invoice.id;
    checkoutInvoice = invoice.id;
  };
  const createCheckoutSession = jest.fn(
    (params: Stripe.Checkout.SessionCreateParams) => {
      boughtServerIdOfCheckout = String(params.metadata?.boughtServerId ?? '');
      checkoutLines = (params.line_items ?? []).map((item) => ({
        price: item.price!,
        quantity: item.quantity ?? 1,
      }));
      return Promise.resolve(checkoutSession());
    },
  );
  const retrieveCheckoutSession = jest.fn(() =>
    Promise.resolve(checkoutSession()),
  );
  const expireCheckoutSession = jest.fn(() => {
    checkoutStatus = 'expired';
    return Promise.resolve(checkoutSession());
  });
  const constructEvent = jest.fn();
  const createRefund = jest.fn(() =>
    Promise.resolve({ id: 're_1' } as Stripe.Refund),
  );
  const stripe: StripeApi = fakeStripe({
    createRefund,
    createProduct,
    createPrice,
    retrievePrice,
    retrieveSubscription,
    retrieveCustomer,
    retrievePaymentMethod,
    updateSubscription,
    previewInvoice,
    createInvoice,
    createInvoiceItem,
    finalizeInvoice,
    payInvoice,
    retrieveInvoice,
    voidInvoice,
    createCheckoutSession,
    retrieveCheckoutSession,
    expireCheckoutSession,
    constructEvent,
  });

  const choice = { serverType: 'cpx22', location: 'hel1' };

  function buy(body: Record<string, unknown> = {}): request.Test {
    return request(http)
      .post('/bought-servers')
      .set('Cookie', owner.cookie)
      .send({
        ...choice,
        name: 'web-1',
        termsAccepted: true,
        prorationDate: Math.floor(Date.now() / 1000),
        ...body,
      });
  }

  function today(): request.Test {
    return request(http)
      .get('/bought-servers/today')
      .query(choice)
      .set('Cookie', owner.cookie);
  }

  function postWebhook(type: string, object: unknown) {
    const event = { type, data: { object } };
    constructEvent.mockReturnValue(event);
    return request(http)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(200);
  }

  /** The subscription changes that add or change items, the 3D Secure settings left out. */
  const itemChanges = () =>
    updateSubscription.mock.calls.filter(([, params]) => params.items);
  const providerCreates = () => ctx.hetzner.machines.callsTo('createServer');
  const rows = () => ctx.db.select().from(boughtServer);
  const lines = () => ctx.db.select().from(boughtServerLine);

  async function fillServerCount(): Promise<void> {
    await ctx.db.insert(server).values(
      ['a', 'b', 'c'].map((name, i) => ({
        name,
        ipAddress: `198.51.100.${i + 1}`,
        port: 22,
        organizationId: owner.organizationId,
      })),
    );
  }

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        { provide: STRIPE_API, useValue: stripe },
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
    mail.clear();
    status = 'active';
    trialEnd = null;
    funding = 'credit';
    cardMode = 'paid';
    checkoutStatus = 'open';
    carried = [{ price: 'price_starter_plan', quantity: 1 }];
    invoices = new Map();
    latestInvoice = null;
    priceCount = 0;
    invoiceCount = 0;
    boughtServerIdOfCheckout = '';
    checkoutLines = [];
    checkoutInvoice = null;
    await openHostedSignUp(ctx.db);
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
  });

  describe('on a plan', () => {
    beforeEach(async () => {
      await givenPlan(ctx, owner.organizationId, 'starter');
    });

    it('asks for 3D Secure on the payment for the first Server, and puts the setting back', async () => {
      const res = await buy();

      expect(res.status).toBe(201);
      const settings = updateSubscription.mock.calls.map(
        ([, params]): string | null => {
          const card = params.payment_settings?.payment_method_options?.card as
            { request_three_d_secure?: string } | undefined;
          return (
            card?.request_three_d_secure ?? (params.items ? 'purchase' : null)
          );
        },
      );
      expect(settings).toEqual(['any', 'purchase', 'automatic']);
      expect(providerCreates()).toHaveLength(1);
    });

    it('does not ask again for a second Server', async () => {
      await buy();
      updateSubscription.mockClear();

      const res = await buy({ name: 'web-2' });

      expect(res.status).toBe(201);
      expect(updateSubscription.mock.calls).toHaveLength(1);
      expect(itemChanges()).toHaveLength(1);
    });

    it('refuses a prepaid card by its funding type, before anything is charged', async () => {
      funding = 'prepaid';

      const res = await buy();

      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({
        code: 'BOUGHT_SERVER_PREPAID_CARD',
        message:
          "A prepaid card can't be used to buy a Server, so nothing was charged and no Server was bought. Change the card under Settings > Billing, then buy again.",
      });
      expect(retrievePaymentMethod).toHaveBeenCalledWith('pm_card');
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(await rows()).toEqual([]);
      expect(ctx.hetzner.machines.calls).toEqual([]);
    });

    describe('with the Server count full', () => {
      beforeEach(async () => {
        await fillServerCount();
      });

      it('adds exactly one Add-on in the same change, charged with the Server', async () => {
        const res = await buy();

        expect(res.status).toBe(201);
        expect(itemChanges()).toHaveLength(1);
        const [[, params]] = itemChanges();
        expect(params).toMatchObject({
          items: [
            { price: 'price_bought_1', quantity: 1 },
            { price: 'price_add_on', quantity: 1 },
          ],
          proration_behavior: 'always_invoice',
          payment_behavior: 'pending_if_incomplete',
        });
        expect(providerCreates()).toHaveLength(1);
      });

      it('raises an Add-on already held by one', async () => {
        carried = [...carried, { price: 'price_add_on', quantity: 1 }];
        await givenPlan(ctx, owner.organizationId, 'starter', 'active', {
          addOns: 1,
        });
        await ctx.db.insert(server).values({
          name: 'd',
          ipAddress: '198.51.100.4',
          port: 22,
          organizationId: owner.organizationId,
        });

        await buy();

        const [[, params]] = itemChanges();
        expect(params.items).toEqual([
          { price: 'price_bought_1', quantity: 1 },
          { id: 'si_price_add_on', quantity: 2 },
        ]);
      });

      it('shows the Add-on in the Today box, previewed in the same change', async () => {
        const res = await today();

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          state: 'plan',
          today: 1520,
          monthly: SERVER_CENTS,
          plan: null,
          addOn: { quantity: 1, monthlyCents: ADD_ON_CENTS },
        });
        const [[preview]] = previewInvoice.mock.calls as unknown as [
          [Stripe.InvoiceCreatePreviewParams],
        ];
        expect(preview.subscription_details?.items).toContainEqual({
          price: 'price_add_on',
          quantity: 1,
        });
      });
    });

    it('shows no Add-on while there is room', async () => {
      const res = await today();

      expect(res.body).toMatchObject({ state: 'plan', addOn: null });
    });
  });

  describe('in the Free trial', () => {
    const now = () => Math.floor(Date.now() / 1000);

    beforeEach(async () => {
      status = 'trialing';
      trialEnd = now() + 10 * DAY;
      await givenPlan(ctx, owner.organizationId, 'starter', 'trialing');
    });

    it('charges the Server on its own invoice, from today to the trial end, and only then makes it', async () => {
      const res = await buy();

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ stage: 'setting_up' });
      expect(createInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: `cus_${owner.organizationId}`,
          collection_method: 'charge_automatically',
          default_payment_method: 'pm_card',
          pending_invoice_items_behavior: 'exclude',
        }),
      );
      const [[item]] = createInvoiceItem.mock.calls as unknown as [
        [Stripe.InvoiceItemCreateParams],
      ];
      expect(item).toMatchObject({
        invoice: 'in_trial',
        price_data: { product: 'cloudgate_bought_server' },
        period: { end: trialEnd },
      });
      // Ten days of a 30-day month.
      expect(item.price_data?.unit_amount).toBeGreaterThanOrEqual(833);
      expect(item.price_data?.unit_amount).toBeLessThanOrEqual(834);
      expect(payInvoice).toHaveBeenCalledWith('in_trial', {});
      expect(itemChanges()).toEqual([]);
      expect(providerCreates()).toHaveLength(1);

      const [row] = await rows();
      expect(row.purchaseInvoiceId).toBe('in_trial');
    });

    it('keeps its lines off the subscription until the trial ends', async () => {
      await buy();

      expect(await lines()).toEqual([
        expect.objectContaining({
          stripePriceId: 'price_bought_1',
          stripeSubscriptionItemId: null,
        }),
      ]);
    });

    it('asks for 3D Secure on the first Server’s invoice', async () => {
      await buy();

      expect(createInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_settings: {
            payment_method_options: {
              card: { request_three_d_secure: 'any' },
            },
          },
        }),
      );
    });

    it('joins the subscription when the trial ends, charged for the new month, once', async () => {
      await buy();

      status = 'active';
      trialEnd = now();
      await postWebhook('customer.subscription.updated', subscriptionNow());

      expect(itemChanges()).toEqual([
        [
          subscriptionId(),
          {
            items: [{ price: 'price_bought_1', quantity: 1 }],
            proration_behavior: 'always_invoice',
          },
        ],
      ]);
      const [line] = await lines();
      expect(line.stripeSubscriptionItemId).toBe('si_price_bought_1');

      // A second delivery adds nothing twice.
      await postWebhook('customer.subscription.updated', subscriptionNow());
      expect(itemChanges()).toHaveLength(1);
    });

    it('does not join while the trial runs', async () => {
      await buy();

      await postWebhook('customer.subscription.updated', subscriptionNow());

      expect(itemChanges()).toEqual([]);
    });

    it('waits for 3D Secure, and makes the machine once the webhook sees the invoice paid', async () => {
      cardMode = 'needs-3ds';

      const res = await buy();

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        stage: 'waiting_for_payment',
        payUrl: TRIAL_PAY_URL,
      });
      expect(ctx.hetzner.machines.calls).toEqual([]);

      const invoice = invoices.get('in_trial')!;
      invoice.status = 'paid';
      invoice.intent = 'succeeded';
      await postWebhook('invoice.payment_succeeded', invoiceView(invoice));

      expect(providerCreates()).toHaveLength(1);
      const [row] = await rows();
      expect(row.stage).toBe('setting_up');
    });

    it('adds one Add-on, free in the trial, once a Server bought with the count full is paid', async () => {
      await fillServerCount();

      await buy();

      expect(itemChanges()).toEqual([
        [
          subscriptionId(),
          {
            items: [{ price: 'price_add_on', quantity: 1 }],
            proration_behavior: 'create_prorations',
          },
        ],
      ]);
    });

    it('shows the trial charge in the Today box, to the trial end', async () => {
      await fillServerCount();

      const res = await today();

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        state: 'trial',
        monthly: SERVER_CENTS,
        to: trialEnd,
        plan: null,
        addOn: { quantity: 1, monthlyCents: ADD_ON_CENTS },
      });
      const body = res.body as { today: number };
      expect(body.today).toBeGreaterThanOrEqual(833);
      expect(body.today).toBeLessThanOrEqual(834);
      expect(previewInvoice).not.toHaveBeenCalled();
    });
  });

  describe('with no plan and the Free trial available', () => {
    it('answers the Checkout that starts the Starter trial, with 3D Secure, and charges nothing yet', async () => {
      const res = await buy();

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        stage: 'waiting_for_payment',
        payUrl: CHECKOUT_URL,
      });
      const [[params]] = createCheckoutSession.mock.calls;
      expect(params).toMatchObject({
        mode: 'subscription',
        line_items: [{ price: 'price_starter_plan', quantity: 1 }],
        subscription_data: { trial_period_days: 30 },
        payment_method_options: { card: { request_three_d_secure: 'any' } },
        success_url: 'https://cloudgate.test/servers',
      });
      expect(params.metadata?.boughtServerId).toBe(
        (res.body as { id: string }).id,
      );
      const [row] = await rows();
      expect(row.purchaseCheckoutSessionId).toBe('cs_buy');
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(ctx.hetzner.machines.calls).toEqual([]);
    });

    it('shows Starter free today and the Server charged for the trial', async () => {
      const res = await today();

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        state: 'start-trial',
        today: SERVER_CENTS,
        monthly: SERVER_CENTS,
        plan: { name: 'Starter', monthlyCents: STARTER_CENTS, todayCents: 0 },
        addOn: null,
      });
    });

    it('charges the Server once Checkout completes, on its own invoice, then makes it', async () => {
      await buy();
      status = 'trialing';
      trialEnd = Math.floor(Date.now() / 1000) + 30 * DAY;
      checkoutStatus = 'complete';

      await postWebhook('checkout.session.completed', checkoutSession());

      expect(createInvoice).toHaveBeenCalledTimes(1);
      // Checkout asked for 3D Secure already.
      const [[params]] = createInvoice.mock.calls as unknown as [
        [Stripe.InvoiceCreateParams],
      ];
      expect(params.payment_settings).toBeUndefined();
      expect(providerCreates()).toHaveLength(1);
      const [row] = await rows();
      expect(row.stage).toBe('setting_up');
    });

    it('charges the Server on the subscription when the card check ends the trial at once', async () => {
      await buy();
      // Another trial had this card: the webhook ends this one now.
      await ctx.db.insert(trialHistory).values({
        kind: 'card',
        value: 'fp_card',
        stripeSubscriptionId: 'sub_other',
      });
      status = 'trialing';
      trialEnd = Math.floor(Date.now() / 1000) + 30 * DAY;
      checkoutStatus = 'complete';
      updateSubscription.mockImplementationOnce(() => {
        status = 'active';
        trialEnd = Math.floor(Date.now() / 1000);
        return Promise.resolve(subscriptionNow());
      });

      await postWebhook('checkout.session.completed', checkoutSession());

      expect(createInvoice).not.toHaveBeenCalled();
      expect(itemChanges()).toEqual([
        [
          subscriptionId(),
          expect.objectContaining({
            items: [{ price: 'price_bought_1', quantity: 1 }],
            proration_behavior: 'always_invoice',
          }),
        ],
      ]);
      expect(providerCreates()).toHaveLength(1);
    });

    it('sends the Checkout back to returnTo on this site, marked paid or cancelled, when one is given', async () => {
      const res = await buy({ returnTo: '/get-started?template=ghost' });

      expect(res.status).toBe(201);
      const [[params]] = createCheckoutSession.mock.calls;
      expect(params).toMatchObject({
        success_url:
          'https://cloudgate.test/get-started?template=ghost&checkout=success',
        cancel_url:
          'https://cloudgate.test/get-started?template=ghost&checkout=cancelled',
      });
    });

    it('refuses a returnTo that names another address, buying nothing', async () => {
      const res = await buy({ returnTo: '//evil.example/servers' });

      expect(res.status).toBe(400);
      // Refused before a row or a Checkout was made.
      expect(await rows()).toEqual([]);
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it('takes a returnTo on Finish paying, refusing one that names another address', async () => {
      const id = ((await buy()).body as { id: string }).id;

      const finish = await request(http)
        .post(`/bought-servers/${id}/finish-paying`)
        .set('Cookie', owner.cookie)
        .send({ returnTo: '/get-started?template=ghost' });
      expect(finish.status).toBe(200);
      expect(finish.body).toEqual({
        id,
        stage: 'waiting_for_payment',
        payUrl: CHECKOUT_URL,
      });

      const refused = await request(http)
        .post(`/bought-servers/${id}/finish-paying`)
        .set('Cookie', owner.cookie)
        .send({ returnTo: 'https://evil.example' });
      expect(refused.status).toBe(400);
    });

    it('answers Finish paying with the Checkout while it is open, and Cancel expires it', async () => {
      const res = await buy();
      const id = (res.body as { id: string }).id;

      const finish = await request(http)
        .post(`/bought-servers/${id}/finish-paying`)
        .set('Cookie', owner.cookie);
      expect(finish.body).toEqual({
        id,
        stage: 'waiting_for_payment',
        payUrl: CHECKOUT_URL,
      });

      const cancel = await request(http)
        .post(`/bought-servers/${id}/cancel`)
        .set('Cookie', owner.cookie);
      expect(cancel.status).toBe(200);
      expect(expireCheckoutSession).toHaveBeenCalledWith('cs_buy');
      expect(await rows()).toEqual([]);
    });

    it('is tidied by the hourly job once its Checkout expired unpaid, and kept while it is open', async () => {
      const res = await buy();
      const id = (res.body as { id: string }).id;
      // Bought two hours ago: well past any press still running.
      await ctx.db.update(boughtServer).set({
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      });
      const hourly = ctx.app.get(BoughtServersHourly);

      await hourly.tick();
      expect((await rows()).map((row) => row.id)).toEqual([id]);

      checkoutStatus = 'expired';
      await hourly.tick();

      expect(await rows()).toEqual([]);
      expect(await lines()).toEqual([]);
      expect(providerCreates()).toEqual([]);
    });

    it('leaves a prepaid card uncharged after Checkout, and Finish paying says why', async () => {
      const res = await buy();
      const id = (res.body as { id: string }).id;
      funding = 'prepaid';
      status = 'trialing';
      trialEnd = Math.floor(Date.now() / 1000) + 30 * DAY;
      checkoutStatus = 'complete';

      await postWebhook('checkout.session.completed', checkoutSession());
      expect(createInvoice).not.toHaveBeenCalled();
      expect(await rows()).toHaveLength(1);

      const finish = await request(http)
        .post(`/bought-servers/${id}/finish-paying`)
        .set('Cookie', owner.cookie);
      expect(finish.status).toBe(402);
      expect((finish.body as { code: string }).code).toBe(
        'BOUGHT_SERVER_PREPAID_CARD',
      );
      expect(await rows()).toEqual([]);
      expect(ctx.hetzner.machines.calls).toEqual([]);
    });
  });

  describe('with no plan and the Free trial used', () => {
    beforeEach(async () => {
      await ctx.db.insert(subscription).values({
        organizationId: owner.organizationId,
        stripeCustomerId: `cus_${owner.organizationId}`,
        firstSubscribedAt: new Date('2026-01-01T00:00:00Z'),
      });
    });

    it('starts Starter through Checkout with no trial, the Server charged in it', async () => {
      const res = await buy();

      expect(res.status).toBe(201);
      const [[params]] = createCheckoutSession.mock.calls;
      expect(params.line_items).toEqual([
        { price: 'price_starter_plan', quantity: 1 },
        { price: 'price_bought_1', quantity: 1 },
      ]);
      expect(params.subscription_data?.trial_period_days).toBeUndefined();
    });

    it('shows Starter and the Server both paid today', async () => {
      const res = await today();

      expect(res.body).toMatchObject({
        state: 'start-plan',
        today: STARTER_CENTS + SERVER_CENTS,
        plan: {
          name: 'Starter',
          monthlyCents: STARTER_CENTS,
          todayCents: STARTER_CENTS,
        },
      });
    });

    it('makes the Server once Checkout completes, charged in it with nothing charged again', async () => {
      await buy();
      completeCheckout();

      await postWebhook('checkout.session.completed', checkoutSession());

      // Checkout charged it: the subscription is not changed again.
      expect(itemChanges()).toEqual([]);
      expect(createInvoice).not.toHaveBeenCalled();
      expect(providerCreates()).toHaveLength(1);
      const [row] = await rows();
      expect(row).toMatchObject({
        stage: 'setting_up',
        purchaseInvoiceId: checkoutInvoice,
      });
      const [line] = await lines();
      expect(line.stripeSubscriptionItemId).toBe('si_price_bought_1');
    });

    it("gives back the Server's share and keeps Starter when a prepaid card paid Checkout", async () => {
      await buy();
      funding = 'prepaid';
      completeCheckout();

      await postWebhook('checkout.session.completed', checkoutSession());

      expect(createRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          payment_intent: 'pi_1',
          amount: SERVER_CENTS,
        }),
        expect.any(String),
      );
      expect(carried).toEqual([{ price: 'price_starter_plan', quantity: 1 }]);
      expect(await rows()).toEqual([]);
      expect(providerCreates()).toEqual([]);
      const [refunded] = mail
        .to('grace@example.com')
        .filter(({ email }) => /prepaid card/.test(email.subject));
      expect(refunded.email.html.replace(/<!-- -->/g, '')).toContain(
        'Its Starter plan is kept.',
      );
    });

    it('takes the Add-on in Checkout when the Servers held already fill the count', async () => {
      await fillServerCount();

      const shown = await today();
      expect(shown.body).toMatchObject({
        state: 'start-plan',
        addOn: { quantity: 1, monthlyCents: ADD_ON_CENTS },
        today: STARTER_CENTS + SERVER_CENTS + ADD_ON_CENTS,
      });

      await buy();
      const [[params]] = createCheckoutSession.mock.calls;
      expect(params.line_items).toEqual([
        { price: 'price_starter_plan', quantity: 1 },
        { price: 'price_add_on', quantity: 1 },
        { price: 'price_bought_1', quantity: 1 },
      ]);
    });
  });

  it('still refuses an Enterprise Organization, billed by agreement', async () => {
    await ctx.db.insert(subscription).values({
      organizationId: owner.organizationId,
      enterprise: true,
      enterpriseServers: 5,
    });

    const res = await buy();

    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('BUY_NOT_AVAILABLE');
    expect(await rows()).toEqual([]);
  });

  it('still refuses while a payment of the plan is overdue', async () => {
    await givenPlan(ctx, owner.organizationId, 'starter', 'past_due');
    status = 'past_due';

    const res = await buy();

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'PAY_OPEN_INVOICE_FIRST',
      message: 'Pay the open invoice first',
    });
    expect(updateSubscription).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });
});
