// The Hosted instance with both provider tokens and the reverse-DNS domain.
// Set before the app module is imported: ConfigModule snapshots the
// environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();
process.env.HETZNER_EUR_API_TOKEN = 'eur-token-for-the-fake';
process.env.HETZNER_USD_API_TOKEN = 'usd-token-for-the-fake';
process.env.BOUGHT_SERVER_REVERSE_DNS_DOMAIN = 'servers.octabyte.test';

import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  boughtServer,
  boughtServerLine,
} from '../../src/bought-servers/bought-server.schema';
import { subscription } from '../../src/cloud/billing/billing.schema';
import { BoughtServersHourly } from '../../src/bought-servers/bought-servers-hourly.service';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';
import { MailService } from '../../src/mail/mail.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { server } from '../../src/servers/server.schema';
import { sshKey } from '../../src/ssh-keys/ssh-key.schema';
import { fakeStripe } from '../utils/fake-stripe';
import { givenPlan } from '../utils/hosted-plan';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import type { HostedCustomer } from '../utils/hosted-sign-up';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

/**
 * How the fake Stripe answers the purchase's subscription update.
 * `answer-lost`: Stripe charges and applies it, but the answer never comes
 * back (a dropped connection).
 */
type PaymentMode = 'paid' | 'refused-at-press' | 'needs-3ds' | 'answer-lost';

const RENEWS_AT = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);
const INVOICE = 'in_purchase';
const PAY_URL = 'https://invoice.stripe.test/in_purchase';

/**
 * Buying a Server on a plan with room (#1389, ADR-0071): Buy writes the
 * Bought Server in Waiting for payment with who ticked the terms and when,
 * adds its line to the Hosted plan's subscription charged at once, and only
 * a payment seen succeeding lets the provider be asked for the machine. The
 * provider is the in-memory fake (`ctx.hetzner.machines`); Stripe is
 * `fakeStripe` with a small model of one subscription and one invoice.
 */
describe('Buying a Server (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  const mail = new MailRecorder();

  let mode: PaymentMode = 'paid';
  /** The purchase invoice's status and its payment intent's, as Stripe would answer them. */
  let invoiceState: { status: Stripe.Invoice.Status; intent: string | null } = {
    status: 'open',
    intent: 'requires_action',
  };
  let priceCount = 0;
  /** The prices the subscription carries, the plan's first. */
  let carried: string[] = [];
  /** The prices the purchase invoice charges, once Stripe made it. */
  let invoiced: string[] | null = null;

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
      status: invoiceState.status,
      amount_paid: invoiceState.status === 'paid' ? 1234 : 0,
      hosted_invoice_url: PAY_URL,
      parent: {
        subscription_details: { subscription: `sub_${owner.organizationId}` },
      },
      payments: {
        data: invoiceState.intent
          ? [
              {
                payment: {
                  type: 'payment_intent',
                  payment_intent: {
                    id: 'pi_1',
                    status: invoiceState.intent,
                    last_payment_error:
                      invoiceState.intent === 'requires_payment_method'
                        ? { message: 'Your card has insufficient funds.' }
                        : null,
                  },
                },
              },
            ]
          : [],
      },
    }) as unknown as Stripe.Invoice;

  const createProduct = jest.fn(() =>
    Promise.reject(
      Object.assign(new Error('exists'), { code: 'resource_already_exists' }),
    ),
  );
  const createPrice = jest.fn(() =>
    Promise.resolve({ id: `price_bought_${++priceCount}` } as Stripe.Price),
  );
  const retrieveSubscription = jest.fn(() =>
    Promise.resolve(subscriptionNow()),
  );
  const updateSubscription = jest.fn(
    (_id: string, params: Stripe.SubscriptionUpdateParams) => {
      if (mode === 'refused-at-press') {
        return Promise.reject(
          Object.assign(new Error('Your card was declined.'), {
            type: 'StripeCardError',
          }),
        );
      }
      const added = (params.items ?? []).map((item) => item.price as string);
      if (params.items) invoiced = added;
      if (mode === 'paid' || mode === 'answer-lost') {
        carried = [...carried, ...added];
        invoiceState = { status: 'paid', intent: 'succeeded' };
        return mode === 'answer-lost' && params.items
          ? Promise.reject(new Error('socket hang up'))
          : Promise.resolve(subscriptionNow());
      }
      // Waiting for 3D Secure: the lines stay pending, the invoice open.
      return Promise.resolve({
        ...subscriptionNow(),
        pending_update: { expires_at: RENEWS_AT, subscription_items: [] },
      } as unknown as Stripe.Subscription);
    },
  );
  const retrieveInvoice = jest.fn(() => Promise.resolve(invoiceNow()));
  // The customer's invoices, newest first: the purchase's, once made, with
  // a line for each price it charges.
  const listInvoices = jest.fn(() =>
    Promise.resolve(
      invoiced
        ? [
            {
              ...invoiceNow(),
              metadata: {},
              lines: {
                data: invoiced.map((price) => ({
                  pricing: { price_details: { price } },
                })),
              },
            } as unknown as Stripe.Invoice,
          ]
        : [],
    ),
  );
  const voidInvoice = jest.fn(() => {
    invoiceState = { ...invoiceState, status: 'void' };
    return Promise.resolve(invoiceNow());
  });
  const previewInvoice = jest.fn(() =>
    Promise.resolve({ amount_due: 1520, currency: 'usd' } as Stripe.Invoice),
  );
  const constructEvent = jest.fn();
  const stripe: StripeApi = fakeStripe({
    createProduct,
    createPrice,
    retrieveSubscription,
    updateSubscription,
    retrieveInvoice,
    listInvoices,
    voidInvoice,
    previewInvoice,
    constructEvent,
  });

  /** The cpx22 in Helsinki: 19.49 + 0.60 IPv4 = 20.09 × 1.2 = 24.108, so $25. */
  const choice = { serverType: 'cpx22', location: 'hel1' };

  function buy(
    cookie = owner.cookie,
    body: Record<string, unknown> = {},
  ): request.Test {
    return request(http)
      .post('/bought-servers')
      .set('Cookie', cookie)
      .send({
        ...choice,
        name: 'web-1',
        termsAccepted: true,
        prorationDate: Math.floor(Date.now() / 1000),
        ...body,
      });
  }

  function postWebhook(event: unknown) {
    constructEvent.mockReturnValue(event);
    return request(http)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(200);
  }

  // The first Setup run, which starts once the machine answers (#1390), is
  // held and never ends here, so the stage reads Setting up throughout; how
  // it goes on is `first-setup.e2e-spec.ts`'s.
  const exec = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(() => new Promise<void>(() => {})),
    execRemote: jest.fn(),
  };

  const providerCreates = () => ctx.hetzner.machines.callsTo('createServer');
  const rows = () => ctx.db.select().from(boughtServer);

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        { provide: STRIPE_API, useValue: stripe },
        { provide: RemoteExecService, useValue: exec },
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
    mode = 'paid';
    invoiceState = { status: 'open', intent: 'requires_action' };
    priceCount = 0;
    carried = ['price_starter_plan'];
    invoiced = null;
    await openHostedSignUp(ctx.db);
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, 'starter');
  });

  describe('a payment that goes through', () => {
    it('adds the Server line to the subscription, charged at once, and pending until paid', async () => {
      const res = await buy();

      expect(res.status).toBe(201);
      // One change adds lines; the others are the first Server's 3D Secure
      // setting, asked for and put back (buy-plan-states.e2e-spec).
      expect(
        updateSubscription.mock.calls.filter(([, params]) => params.items),
      ).toHaveLength(1);
      expect(updateSubscription).toHaveBeenCalledWith(
        `sub_${owner.organizationId}`,
        expect.objectContaining({
          items: [{ price: 'price_bought_1', quantity: 1 }],
          proration_behavior: 'always_invoice',
          payment_behavior: 'pending_if_incomplete',
        }),
      );
      expect(createPrice).toHaveBeenCalledWith(
        expect.objectContaining({
          currency: 'usd',
          unit_amount: 2500,
          recurring: { interval: 'month' },
          product: 'cloudgate_bought_server',
        }),
      );
    });

    it('creates the machine once paid, and writes the Server with its address', async () => {
      const res = await buy();

      expect(res.status).toBe(201);
      const { id, stage } = res.body as { id: string; stage: string };
      expect(stage).toBe('setting_up');

      const [row] = await rows();
      expect(row.stage).toBe('setting_up');
      expect(row.serverId).toBe(id);
      expect(row.purchaseInvoiceId).toBe(INVOICE);
      expect(row.purchasePaidAt).not.toBeNull();
      expect(row.createTries).toBe(1);

      const [machine] = ctx.hetzner.machines.servers();
      expect(row.providerServerId).toBe(machine.id);
      expect(row.providerPrimaryIpv4Id).toBe(machine.primaryIpv4Id);
      expect(machine.serverType).toBe('cpx22');
      expect(machine.location).toBe('hel1');
      expect(machine.labels).toEqual({
        'cloudgate-organization': owner.organizationId,
        'cloudgate-server': id,
      });

      // Only the Server's public key; its private half stays with Cloudgate.
      const [key] = await ctx.db
        .select()
        .from(sshKey)
        .where(eq(sshKey.sshKeyId, row.sshKeyId!));
      expect(machine.sshPublicKey).toBe(key.publicKey);
      expect(JSON.stringify(ctx.hetzner.machines.calls)).not.toContain(
        'PRIVATE KEY',
      );

      const [written] = await ctx.db
        .select()
        .from(server)
        .where(eq(server.serverId, id));
      expect(written).toMatchObject({
        name: 'web-1',
        ipAddress: machine.ipv4,
        port: 22,
        username: 'root',
        sshKeyId: row.sshKeyId,
        organizationId: owner.organizationId,
      });

      // Reverse DNS names the Server, not the customer or the provider.
      expect(ctx.hetzner.machines.callsTo('setReverseDns')).toEqual([
        [machine.id, machine.ipv4, `${id}.servers.octabyte.test`],
      ]);
      // The EUR account makes it; the USD account is only ever asked for prices.
      expect(ctx.hetzner.prices.callsTo('createServer')).toEqual([]);
    });

    it('records the line with its price and its subscription item', async () => {
      await buy();

      const lines = await ctx.db.select().from(boughtServerLine);
      expect(lines).toEqual([
        expect.objectContaining({
          kind: 'server',
          stripePriceId: 'price_bought_1',
          stripeSubscriptionItemId: 'si_1',
          monthlyCents: 2500,
        }),
      ]);
    });

    it('stores who ticked the terms box, and when', async () => {
      const before = Date.now();
      await buy();

      const [row] = await rows();
      expect(row.termsAcceptedBy).toBe(owner.id);
      expect(row.termsAcceptedAt.getTime()).toBeGreaterThanOrEqual(
        before - 1000,
      );
    });

    it('lists the Server among the Servers once it is made', async () => {
      const res = await buy();
      const list = await request(http)
        .get('/servers')
        .set('Cookie', owner.cookie);

      expect(list.status).toBe(200);
      expect(
        (list.body as Array<{ serverId: string }>).map((s) => s.serverId),
      ).toEqual([(res.body as { id: string }).id]);
    });
  });

  describe('a payment waiting for 3D Secure', () => {
    beforeEach(() => {
      mode = 'needs-3ds';
    });

    it('waits for payment without asking the provider for anything', async () => {
      const res = await buy();

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        stage: 'waiting_for_payment',
        payUrl: PAY_URL,
      });
      expect(ctx.hetzner.machines.calls).toEqual([]);
      expect(await ctx.db.select().from(server)).toEqual([]);
    });

    it('shows among the Servers being bought, and counts against the Server count', async () => {
      // Two Servers already, and the plan holds three.
      await ctx.db.insert(server).values([
        {
          name: 'a',
          ipAddress: '198.51.100.1',
          port: 22,
          organizationId: owner.organizationId,
        },
        {
          name: 'b',
          ipAddress: '198.51.100.2',
          port: 22,
          organizationId: owner.organizationId,
        },
      ]);
      const res = await buy();
      const id = (res.body as { id: string }).id;

      const purchases = await request(http)
        .get('/bought-servers/purchases')
        .set('Cookie', owner.cookie);
      expect(purchases.status).toBe(200);
      expect(purchases.body).toEqual([
        expect.objectContaining({
          id,
          name: 'web-1',
          stage: 'waiting_for_payment',
          monthlyCents: 2500,
        }),
      ]);

      const room = await request(http)
        .get('/billing/can-create-server')
        .set('Cookie', owner.cookie);
      expect(room.body).toMatchObject({
        canCreateMoreServers: false,
        code: 'ALLOWANCE_FULL',
      });
    });

    it('creates the machine only once the webhook sees the invoice paid', async () => {
      const res = await buy();
      const id = (res.body as { id: string }).id;
      expect(providerCreates()).toEqual([]);

      // The customer finishes 3D Secure; Stripe applies the pending lines.
      carried = [...carried, 'price_bought_1'];
      invoiceState = { status: 'paid', intent: 'succeeded' };
      await postWebhook({
        type: 'invoice.payment_succeeded',
        data: { object: invoiceNow() },
      });

      expect(providerCreates()).toHaveLength(1);
      const [row] = await rows();
      expect(row).toMatchObject({ id, stage: 'setting_up', serverId: id });
      const [line] = await ctx.db.select().from(boughtServerLine);
      expect(line.stripeSubscriptionItemId).toBe('si_1');

      // A second delivery of the same event makes no second machine.
      await postWebhook({
        type: 'invoice.payment_succeeded',
        data: { object: invoiceNow() },
      });
      expect(providerCreates()).toHaveLength(1);
    });

    it('answers Finish paying with where to pay while it still waits', async () => {
      const res = await buy();
      const id = (res.body as { id: string }).id;

      const finish = await request(http)
        .post(`/bought-servers/${id}/finish-paying`)
        .set('Cookie', owner.cookie);

      expect(finish.status).toBe(200);
      expect(finish.body).toEqual({
        id,
        stage: 'waiting_for_payment',
        payUrl: PAY_URL,
      });
      expect(ctx.hetzner.machines.calls).toEqual([]);
    });

    it('removes the purchase on Cancel, voiding the invoice, with nothing charged', async () => {
      const res = await buy();
      const id = (res.body as { id: string }).id;

      const cancel = await request(http)
        .post(`/bought-servers/${id}/cancel`)
        .set('Cookie', owner.cookie);

      expect(cancel.status).toBe(200);
      expect(voidInvoice).toHaveBeenCalledWith(INVOICE);
      expect(await rows()).toEqual([]);
      expect(await ctx.db.select().from(boughtServerLine)).toEqual([]);
      expect(ctx.hetzner.machines.calls).toEqual([]);
    });

    it('removes the purchase and says why when Finish paying finds the card refused', async () => {
      const res = await buy();
      const id = (res.body as { id: string }).id;
      invoiceState = { status: 'open', intent: 'requires_payment_method' };

      const finish = await request(http)
        .post(`/bought-servers/${id}/finish-paying`)
        .set('Cookie', owner.cookie);

      expect(finish.status).toBe(402);
      expect(finish.body).toMatchObject({
        code: 'BOUGHT_SERVER_PAYMENT_REFUSED',
        message:
          'The payment was refused, so nothing was charged and no Server was bought. Your card has insufficient funds.',
      });
      expect(voidInvoice).toHaveBeenCalledWith(INVOICE);
      expect(await rows()).toEqual([]);
      expect(ctx.hetzner.machines.calls).toEqual([]);
    });

    it('removes the purchase when its pending update expires unpaid', async () => {
      await buy();

      await postWebhook({
        type: 'customer.subscription.pending_update_expired',
        data: { object: subscriptionNow() },
      });

      expect(await rows()).toEqual([]);
      expect(ctx.hetzner.machines.calls).toEqual([]);
    });
  });

  describe('a payment refused at the press', () => {
    it('answers 402 saying why, and leaves no row and no provider call', async () => {
      mode = 'refused-at-press';

      const res = await buy();

      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({
        code: 'BOUGHT_SERVER_PAYMENT_REFUSED',
        message:
          'The payment was refused, so nothing was charged and no Server was bought. Your card was declined.',
      });
      expect(await rows()).toEqual([]);
      expect(await ctx.db.select().from(boughtServerLine)).toEqual([]);
      expect(ctx.hetzner.machines.calls).toEqual([]);
    });
  });

  describe('who may buy, and when', () => {
    it('refuses a member without the role rule of adding a Server', async () => {
      const member = await signUpMember(http, owner.cookie, {
        email: 'ida@example.com',
      });

      const res = await buy(member.cookie);

      expect(res.status).toBe(403);
      expect(await rows()).toEqual([]);
      expect(updateSubscription).not.toHaveBeenCalled();
    });

    it('lets an admin buy, as an admin may add a Server', async () => {
      const admin = await signUpMember(http, owner.cookie, {
        email: 'admin@example.com',
        role: 'admin',
      });

      const res = await buy(admin.cookie);

      expect(res.status).toBe(201);
    });

    it('refuses while the Organization is frozen', async () => {
      await ctx.db
        .update(subscription)
        .set({ suspendedAt: new Date(), suspendedReason: 'Sending spam' })
        .where(eq(subscription.organizationId, owner.organizationId));

      const res = await buy();

      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe('ORGANIZATION_FROZEN');
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(await rows()).toEqual([]);
    });

    it('refuses unless the terms box is ticked', async () => {
      const res = await buy(owner.cookie, { termsAccepted: false });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain(
        'Tick the box to accept the terms.',
      );
      expect(await rows()).toEqual([]);
    });

    it('refuses a size that cannot be bought there right now', async () => {
      const res = await buy(owner.cookie, {
        serverType: 'cx23',
        location: 'fsn1',
      });

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        "That size can't be bought in Falkenstein right now. Pick another size or location",
      );
      expect(await rows()).toEqual([]);
    });
  });

  describe('a charge cut off before its invoice was stored', () => {
    const HOUR = 60 * 60 * 1000;

    /** A purchase waiting with no invoice stored, bought `ago` milliseconds ago: Buy cut off by a restart. */
    async function cutOff(ago: number): Promise<string> {
      mode = 'needs-3ds';
      const res = await buy();
      const id = (res.body as { id: string }).id;
      await ctx.db
        .update(boughtServer)
        .set({
          purchaseInvoiceId: null,
          createdAt: new Date(Date.now() - ago),
        })
        .where(eq(boughtServer.id, id));
      return id;
    }

    const tick = () => ctx.app.get(BoughtServersHourly).tick();

    it('goes on when the charge went through but its answer was lost: the invoice is found by the line price', async () => {
      mode = 'answer-lost';

      const res = await buy();

      expect(res.status).toBe(201);
      const [row] = await rows();
      expect(row).toMatchObject({
        stage: 'setting_up',
        purchaseInvoiceId: INVOICE,
      });
      expect(providerCreates()).toHaveLength(1);
      expect(voidInvoice).not.toHaveBeenCalled();
    });

    it('is moved on by the hourly job once its invoice turns out paid, the invoice stored', async () => {
      const id = await cutOff(HOUR);
      carried = [...carried, 'price_bought_1'];
      invoiceState = { status: 'paid', intent: 'succeeded' };

      const done = await tick();

      expect(done.charges).toEqual([id]);
      const [row] = await rows();
      expect(row).toMatchObject({
        id,
        stage: 'setting_up',
        purchaseInvoiceId: INVOICE,
      });
      expect(providerCreates()).toHaveLength(1);
    });

    it('is removed by the hourly job when Stripe never made its invoice: nothing was charged', async () => {
      await cutOff(HOUR);
      invoiced = null;

      await tick();

      expect(await rows()).toEqual([]);
      expect(providerCreates()).toEqual([]);
    });

    it('is left alone by the hourly job while it is recent, and dropped with its invoice voided once a day has passed unpaid', async () => {
      mode = 'needs-3ds';
      const recent = await buy();
      expect(recent.status).toBe(201);
      await tick();
      expect(await rows()).toHaveLength(1);
      expect(voidInvoice).not.toHaveBeenCalled();

      await ctx.db
        .update(boughtServer)
        .set({ createdAt: new Date(Date.now() - 25 * HOUR) });
      await tick();

      expect(voidInvoice).toHaveBeenCalledWith(INVOICE);
      expect(await rows()).toEqual([]);
    });

    it('refuses Cancel once the invoice it finds is paid, and moves on instead', async () => {
      const id = await cutOff(0);
      carried = [...carried, 'price_bought_1'];
      invoiceState = { status: 'paid', intent: 'succeeded' };

      const cancel = await request(http)
        .post(`/bought-servers/${id}/cancel`)
        .set('Cookie', owner.cookie);

      expect(cancel.status).toBe(409);
      expect(cancel.body).toMatchObject({ code: 'PURCHASE_ALREADY_PAID' });
      expect(voidInvoice).not.toHaveBeenCalled();
      const [row] = await rows();
      expect(row).toMatchObject({ id, stage: 'setting_up' });
    });
  });

  describe('the Today box', () => {
    it("previews today's charge to the plan's renewal date", async () => {
      const res = await request(http)
        .get('/bought-servers/today')
        .query(choice)
        .set('Cookie', owner.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        today: 1520,
        monthly: 2500,
        currency: 'usd',
        to: RENEWS_AT,
      });
      const body = res.body as { from: number; prorationDate: number };
      expect(body.from).toBe(body.prorationDate);
      const [[params]] = previewInvoice.mock.calls as unknown as [
        [Stripe.InvoiceCreatePreviewParams],
      ];
      expect(params.subscription).toBe(`sub_${owner.organizationId}`);
      expect(params.subscription_details?.proration_behavior).toBe(
        'always_invoice',
      );
      expect(params.subscription_details?.items).toEqual([
        {
          price_data: {
            currency: 'usd',
            product: 'cloudgate_bought_server',
            unit_amount: 2500,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ]);
    });
  });
});
