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
  boughtServer,
  boughtServerLine,
} from '../../src/bought-servers/bought-server.schema';
import { subscription } from '../../src/cloud/billing/billing.schema';
import { BoughtServersHourly } from '../../src/bought-servers/bought-servers-hourly.service';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';
import { MailService } from '../../src/mail/mail.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
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

const RENEWS_AT = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);

/**
 * How the fake Stripe answers a charge: paid at once, the card refused, or
 * paid with the answer lost on the way back (a dropped connection).
 */
type PaymentMode = 'paid' | 'refused' | 'answer-lost';

interface FakeItem {
  id: string;
  price: string;
}

/**
 * Backups on a Bought Server (#1394), and the shared rule for any paid
 * change: chosen at Buy, they are their own line and on once the machine is
 * made; on a Ready Server, turning them on is charged before the provider is
 * asked, turning them off is credited once it is done, and a change the
 * provider refuses twice is refunded in full with the Server kept as it was.
 *
 * Stripe is a small model of one subscription's items and its invoices; the
 * provider is the in-memory fake (`ctx.hetzner.machines`).
 */
describe('Backups on a Bought Server (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  const mail = new MailRecorder();

  let mode: PaymentMode = 'paid';
  let items: FakeItem[] = [];
  let itemCount = 0;
  let priceCount = 0;
  let invoiceCount = 0;
  /** How many times the provider had been asked to turn backups on when each charge was made. */
  let enableCallsAtCharge: number[] = [];
  /** The invoices charges made, newest first, with the prices each charges. */
  let charges: Array<{ id: string; prices: string[] }> = [];

  const subscriptionNow = (latest = 'in_0'): Stripe.Subscription =>
    ({
      id: `sub_${owner.organizationId}`,
      object: 'subscription',
      status: 'active',
      customer: `cus_${owner.organizationId}`,
      metadata: {},
      latest_invoice: latest,
      pending_update: null,
      items: {
        data: items.map((item) => ({
          id: item.id,
          price: { id: item.price },
          quantity: 1,
          current_period_end: RENEWS_AT,
        })),
      },
    }) as unknown as Stripe.Subscription;

  const paidInvoice = (id: string): Stripe.Invoice =>
    ({
      id,
      object: 'invoice',
      status: 'paid',
      amount_paid: 412,
      currency: 'usd',
      parent: {
        subscription_details: { subscription: `sub_${owner.organizationId}` },
      },
      payments: {
        data: [
          {
            status: 'paid',
            payment: {
              type: 'payment_intent',
              payment_intent: { id: `pi_${id}`, status: 'succeeded' },
            },
          },
        ],
      },
    }) as unknown as Stripe.Invoice;

  const createProduct = jest.fn(() =>
    Promise.reject(
      Object.assign(new Error('exists'), { code: 'resource_already_exists' }),
    ),
  );
  const createPrice = jest.fn((params: Stripe.PriceCreateParams) =>
    Promise.resolve({
      id: `price_${params.metadata?.kind as string}_${++priceCount}`,
    } as Stripe.Price),
  );
  const retrieveSubscription = jest.fn(() =>
    Promise.resolve(subscriptionNow()),
  );
  const updateSubscription = jest.fn(
    (_id: string, params: Stripe.SubscriptionUpdateParams) => {
      if (params.proration_behavior === 'always_invoice') {
        enableCallsAtCharge.push(
          ctx.hetzner.machines.callsTo('enableBackup').length,
        );
        if (mode === 'refused') {
          return Promise.reject(
            Object.assign(new Error('Your card was declined.'), {
              type: 'StripeCardError',
            }),
          );
        }
      }
      const charged = params.proration_behavior === 'always_invoice';
      for (const item of params.items ?? []) {
        if (item.deleted) {
          items = items.filter((held) => held.id !== item.id);
        } else if (item.id) {
          items = items.map((held) =>
            held.id === item.id ? { ...held, price: item.price! } : held,
          );
        } else {
          items = [...items, { id: `si_${++itemCount}`, price: item.price! }];
        }
      }
      const invoice = `in_${++invoiceCount}`;
      if (charged) {
        charges = [
          {
            id: invoice,
            prices: (params.items ?? []).flatMap((item) =>
              item.price ? [item.price] : [],
            ),
          },
          ...charges,
        ];
      }
      return charged && mode === 'answer-lost'
        ? Promise.reject(new Error('socket hang up'))
        : Promise.resolve(subscriptionNow(invoice));
    },
  );
  const listInvoices = jest.fn(() =>
    Promise.resolve(
      charges.map(
        (charge) =>
          ({
            ...paidInvoice(charge.id),
            metadata: {},
            lines: {
              data: charge.prices.map((price) => ({
                pricing: { price_details: { price } },
              })),
            },
          }) as unknown as Stripe.Invoice,
      ),
    ),
  );
  const retrieveInvoice = jest.fn((id: string) =>
    Promise.resolve(paidInvoice(id)),
  );
  const createRefund = jest.fn<
    Promise<Stripe.Refund>,
    Parameters<StripeApi['createRefund']>
  >(() => Promise.resolve({ id: 're_1' } as Stripe.Refund));
  const previewInvoice = jest.fn(() =>
    Promise.resolve({ amount_due: 1800, currency: 'usd' } as Stripe.Invoice),
  );
  const stripe: StripeApi = fakeStripe({
    createProduct,
    createPrice,
    retrieveSubscription,
    updateSubscription,
    retrieveInvoice,
    listInvoices,
    createRefund,
    previewInvoice,
  });

  /** The cpx22 in Helsinki: $25 a month, and backups 19.49 × 20% × 1.2 = 4.68, so $5. */
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

  /** A Bought Server made and set up: Ready (setting up is #1390's, so the stage is set here). */
  async function readyServer(body: Record<string, unknown> = {}) {
    const res = await buy(body);
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    await ctx.db
      .update(boughtServer)
      .set({ stage: 'ready' })
      .where(eq(boughtServer.id, id));
    jest.clearAllMocks();
    enableCallsAtCharge = [];
    ctx.hetzner.machines.calls.length = 0;
    return id;
  }

  function setBackups(id: string, enabled: boolean, cookie = owner.cookie) {
    return request(http)
      .put(`/bought-servers/${id}/backups`)
      .set('Cookie', cookie)
      .send({ enabled });
  }

  const row = async (id: string) =>
    (
      await ctx.db.select().from(boughtServer).where(eq(boughtServer.id, id))
    )[0];
  const lines = (id: string) =>
    ctx.db
      .select()
      .from(boughtServerLine)
      .where(eq(boughtServerLine.boughtServerId, id));
  const machine = () => ctx.hetzner.machines.servers()[0];

  // The first Setup run, which starts once the machine answers (#1390), is
  // held and never ends here, so a bought Server stays Setting up until a
  // test makes it Ready.
  const exec = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(() => new Promise<void>(() => {})),
    execRemote: jest.fn(),
  };

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
    items = [{ id: 'si_plan', price: 'price_starter_plan' }];
    itemCount = 0;
    priceCount = 0;
    invoiceCount = 0;
    enableCallsAtCharge = [];
    charges = [];
    await openHostedSignUp(ctx.db);
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, 'starter');
  });

  describe('chosen at Buy', () => {
    it('adds a backups line beside the Server line, charged with it', async () => {
      const res = await buy({ backups: true });

      expect(res.status).toBe(201);
      expect(createPrice).toHaveBeenCalledWith(
        expect.objectContaining({
          unit_amount: 500,
          product: 'cloudgate_bought_server_backups',
          recurring: { interval: 'month' },
        }),
      );
      expect(updateSubscription).toHaveBeenCalledWith(
        `sub_${owner.organizationId}`,
        expect.objectContaining({
          items: [
            { price: 'price_server_1', quantity: 1 },
            { price: 'price_backups_2', quantity: 1 },
          ],
          proration_behavior: 'always_invoice',
          payment_behavior: 'pending_if_incomplete',
        }),
      );
      const id = (res.body as { id: string }).id;
      expect(
        (await lines(id)).map((line) => [line.kind, line.monthlyCents]),
      ).toEqual(
        expect.arrayContaining([
          ['server', 2500],
          ['backups', 500],
        ]),
      );
    });

    it('turns backups on once the machine is made, before the Server is written', async () => {
      const res = await buy({ backups: true });

      const id = (res.body as { id: string }).id;
      expect(machine().backups).toBe(true);
      expect(ctx.hetzner.machines.callsTo('enableBackup')).toEqual([
        [machine().id],
      ]);
      expect(await row(id)).toMatchObject({
        backups: true,
        stage: 'setting_up',
        serverId: id,
      });
    });

    it('leaves backups off when they are not chosen', async () => {
      await buy();

      expect(machine().backups).toBe(false);
      expect(ctx.hetzner.machines.callsTo('enableBackup')).toEqual([]);
    });

    it("previews today's charge with the backups line", async () => {
      const res = await request(http)
        .get('/bought-servers/today')
        .query({ ...choice, backups: 'true' })
        .set('Cookie', owner.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ today: 1800, monthly: 3000 });
      const [[params]] = previewInvoice.mock.calls as unknown as [
        [Stripe.InvoiceCreatePreviewParams],
      ];
      expect(
        params.subscription_details?.items?.map(
          (item) => item.price_data?.product,
        ),
      ).toEqual(['cloudgate_bought_server', 'cloudgate_bought_server_backups']);
    });
  });

  describe('turned on on a Ready Server', () => {
    it('charges at once for the rest of the month, before the provider is called', async () => {
      const id = await readyServer();

      const res = await setBackups(id, true);

      expect(res.status).toBe(200);
      expect(updateSubscription).toHaveBeenCalledWith(
        `sub_${owner.organizationId}`,
        {
          items: [{ price: 'price_backups_2', quantity: 1 }],
          proration_behavior: 'always_invoice',
          payment_behavior: 'pending_if_incomplete',
        },
      );
      // The provider had not been asked when the charge was made.
      expect(enableCallsAtCharge).toEqual([0]);
      expect(ctx.hetzner.machines.callsTo('enableBackup')).toEqual([
        [machine().id],
      ]);
      expect(machine().backups).toBe(true);
    });

    it('is Ready again with backups on and their line on the subscription', async () => {
      const id = await readyServer();

      const res = await setBackups(id, true);

      expect(res.body).toMatchObject({
        id,
        stage: 'ready',
        backups: true,
        monthlyCents: 3000,
        change: null,
      });
      expect(await row(id)).toMatchObject({
        stage: 'ready',
        backups: true,
        changeTarget: null,
        changeTries: 0,
      });
      const backups = (await lines(id)).find((line) => line.kind === 'backups');
      expect(backups).toMatchObject({
        stripePriceId: 'price_backups_2',
        monthlyCents: 500,
      });
      expect(items.map((item) => item.price)).toContain('price_backups_2');
      expect(backups?.stripeSubscriptionItemId).toBe(
        items.find((item) => item.price === 'price_backups_2')?.id,
      );
    });

    it('goes on when the charge went through but its answer was lost: the invoice is found by the backups price', async () => {
      const id = await readyServer();
      mode = 'answer-lost';

      const res = await setBackups(id, true);

      expect(res.status).toBe(200);
      expect(machine().backups).toBe(true);
      expect(await row(id)).toMatchObject({ stage: 'ready', backups: true });
      expect(createRefund).not.toHaveBeenCalled();
    });

    describe('cut off by a restart before its payment was stored', () => {
      const HOUR = 60 * 60 * 1000;

      /** The row as the claim left it, `ago` milliseconds back, the backups price made. */
      async function cutOff(id: string, ago: number): Promise<void> {
        await ctx.db
          .update(boughtServer)
          .set({
            stage: 'changing',
            changeTarget: {
              backups: true,
              charged: true,
              lines: [
                {
                  kind: 'backups',
                  stripePriceId: 'price_backups_9',
                  monthlyCents: 500,
                },
              ],
              startedAt: new Date(Date.now() - ago).toISOString(),
            },
          })
          .where(eq(boughtServer.id, id));
      }
      const tick = () => ctx.app.get(BoughtServersHourly).tick();

      it('carries on once the hourly job finds the charge paid', async () => {
        const id = await readyServer();
        await cutOff(id, HOUR);
        items = [...items, { id: 'si_backups', price: 'price_backups_9' }];
        charges = [{ id: 'in_lost', prices: ['price_backups_9'] }];

        await tick();

        expect(await row(id)).toMatchObject({
          stage: 'ready',
          backups: true,
          changeTarget: null,
        });
        expect(machine().backups).toBe(true);
      });

      it('is Ready again as it was when Stripe made no charge, asking the provider for nothing', async () => {
        const id = await readyServer();
        await cutOff(id, HOUR);

        await tick();

        expect(await row(id)).toMatchObject({
          stage: 'ready',
          backups: false,
          changeTarget: null,
        });
        expect(ctx.hetzner.machines.callsTo('enableBackup')).toEqual([]);
      });

      it('is left alone while the press may still be running', async () => {
        const id = await readyServer();
        await cutOff(id, 60 * 1000);

        await tick();

        expect(await row(id)).toMatchObject({ stage: 'changing' });
      });
    });

    it('asks once more after a refusal, and charges only once', async () => {
      const id = await readyServer();
      ctx.hetzner.machines.refuse('enableBackup', 'locked', 1);

      const res = await setBackups(id, true);

      expect(res.status).toBe(200);
      expect(ctx.hetzner.machines.callsTo('enableBackup')).toHaveLength(2);
      expect(machine().backups).toBe(true);
      expect(createRefund).not.toHaveBeenCalled();
      expect(enableCallsAtCharge).toEqual([0]);
    });

    it('refunds in full, keeps the Server as it was and emails the owner when refused twice', async () => {
      const id = await readyServer();
      const before = await lines(id);
      ctx.hetzner.machines.refuse('enableBackup', 'locked', 2);
      // The change's charge is the next invoice: how many the purchase made
      // depends on the plan state (a first Server's 3D Secure is set and put
      // back around it, #1392).
      const changeInvoice = `in_${invoiceCount + 1}`;

      const res = await setBackups(id, true);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'BOUGHT_SERVER_CHANGE_REFUSED',
        message:
          'The change could not be made, so its payment was refunded in full and the Server is as it was',
      });
      expect(ctx.hetzner.machines.callsTo('enableBackup')).toHaveLength(2);
      expect(createRefund).toHaveBeenCalledWith(
        expect.objectContaining({ payment_intent: `pi_${changeInvoice}` }),
        expect.stringMatching(/^bought-server-change-refund-/),
      );
      // The line taken back off, with nothing prorated: the refund gave it all back.
      expect(updateSubscription).toHaveBeenLastCalledWith(
        `sub_${owner.organizationId}`,
        {
          items: [{ id: 'si_2', deleted: true }],
          proration_behavior: 'none',
        },
      );
      expect(items.map((item) => item.price)).not.toContain('price_backups_2');
      expect(machine().backups).toBe(false);
      expect(await row(id)).toMatchObject({
        stage: 'ready',
        backups: false,
        changeTarget: null,
      });
      expect(await lines(id)).toEqual(before);

      const sent = mail.to('grace@example.com').at(-1)!;
      expect(sent.email.subject).toBe(
        "We couldn't turn on backups for web-1, so the payment was refunded",
      );
      expect(sent.email.html).toContain('$4.12');
      expect(sent.email.html).toContain('refunded in full');
      expect(sent.email.html).not.toMatch(/hetzner/i);
    });

    it('asks the provider for nothing when the card is refused', async () => {
      const id = await readyServer();
      mode = 'refused';

      const res = await setBackups(id, true);

      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({
        code: 'BOUGHT_SERVER_CHANGE_PAYMENT_REFUSED',
        message:
          'The payment was refused, so nothing was charged and nothing changed. Your card was declined.',
      });
      expect(ctx.hetzner.machines.callsTo('enableBackup')).toEqual([]);
      expect(await row(id)).toMatchObject({ stage: 'ready', backups: false });
    });

    it('is refused while the Organization is frozen, before anything is charged', async () => {
      const id = await readyServer();
      await ctx.db
        .update(subscription)
        .set({ suspendedAt: new Date(), suspendedReason: 'Sending spam' })
        .where(eq(subscription.organizationId, owner.organizationId));

      const res = await setBackups(id, true);

      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe('ORGANIZATION_FROZEN');
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(ctx.hetzner.machines.calls).toEqual([]);
    });

    it('is refused until the Server is Ready', async () => {
      const res = await buy();
      const id = (res.body as { id: string }).id;

      const change = await setBackups(id, true);

      expect(change.status).toBe(409);
      expect((change.body as { message: string }).message).toBe(
        "This Server can't be changed until it is Ready",
      );
      expect(ctx.hetzner.machines.callsTo('enableBackup')).toEqual([]);
    });

    it('is refused to a member without the role rule of buying', async () => {
      const id = await readyServer();
      const member = await signUpMember(http, owner.cookie, {
        email: 'ida@example.com',
      });

      const res = await setBackups(id, true, member.cookie);

      expect(res.status).toBe(403);
      expect(updateSubscription).not.toHaveBeenCalled();
    });
  });

  describe('a Server deleted while backups are being turned on', () => {
    it('refunds the paid change and takes its line back off with no proration, before the lines leave', async () => {
      const id = await readyServer();
      await ctx.db
        .update(boughtServer)
        .set({
          stage: 'changing',
          changeTarget: {
            backups: true,
            charged: true,
            lines: [
              {
                kind: 'backups',
                stripePriceId: 'price_backups_9',
                monthlyCents: 500,
              },
            ],
            startedAt: new Date().toISOString(),
          },
          changeInvoiceId: 'in_change',
          changeTries: 1,
        })
        .where(eq(boughtServer.id, id));
      items = [...items, { id: 'si_backups', price: 'price_backups_9' }];

      await request(http)
        .delete(`/servers/${id}`)
        .set('Cookie', owner.cookie)
        .expect(200);

      expect(createRefund).toHaveBeenCalledWith(
        expect.objectContaining({ payment_intent: 'pi_in_change' }),
        'bought-server-change-refund-in_change',
      );
      const changes = updateSubscription.mock.calls.map(([, params]) => params);
      expect(changes[0]).toEqual({
        items: [{ id: 'si_backups', deleted: true }],
        proration_behavior: 'none',
      });
      expect(changes[1]).toMatchObject({
        proration_behavior: 'create_prorations',
      });
      expect(items.map((item) => item.price)).toEqual(['price_starter_plan']);
      expect(await row(id)).toMatchObject({
        stage: 'deleted',
        changeTarget: null,
        changeInvoiceId: null,
      });
      // The customer deleted it: no "your change could not be made" email.
      expect(
        mail
          .to('grace@example.com')
          .filter(({ email }) => /refunded/.test(email.subject)),
      ).toEqual([]);
    });
  });

  describe('turned off', () => {
    it('turns them off first, then credits the line on the next invoice and removes it', async () => {
      const id = await readyServer({ backups: true });
      const held = (await lines(id)).find((line) => line.kind === 'backups');

      const res = await setBackups(id, false);

      expect(res.status).toBe(200);
      expect(ctx.hetzner.machines.callsTo('disableBackup')).toEqual([
        [machine().id],
      ]);
      expect(machine().backups).toBe(false);
      expect(updateSubscription).toHaveBeenCalledTimes(1);
      expect(updateSubscription).toHaveBeenCalledWith(
        `sub_${owner.organizationId}`,
        {
          items: [{ id: held?.stripeSubscriptionItemId, deleted: true }],
          proration_behavior: 'create_prorations',
        },
      );
      expect(createPrice).not.toHaveBeenCalled();
      expect((await lines(id)).map((line) => line.kind)).toEqual(['server']);
      expect(res.body).toMatchObject({
        stage: 'ready',
        backups: false,
        monthlyCents: 2500,
        backupsOfferCents: 500,
      });
    });

    it('stays allowed while the Organization is frozen', async () => {
      const id = await readyServer({ backups: true });
      await ctx.db
        .update(subscription)
        .set({ suspendedAt: new Date(), suspendedReason: 'Sending spam' })
        .where(eq(subscription.organizationId, owner.organizationId));

      const res = await setBackups(id, false);

      expect(res.status).toBe(200);
      expect(machine().backups).toBe(false);
    });

    it('keeps backups and credits nothing when the provider refuses twice', async () => {
      const id = await readyServer({ backups: true });
      ctx.hetzner.machines.refuse('disableBackup', 'locked', 2);

      const res = await setBackups(id, false);

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        'The change could not be made, so the Server is as it was. Try again later',
      );
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(createRefund).not.toHaveBeenCalled();
      expect(machine().backups).toBe(true);
      expect(await row(id)).toMatchObject({ stage: 'ready', backups: true });
      expect((await lines(id)).map((line) => line.kind).sort()).toEqual([
        'backups',
        'server',
      ]);
    });
  });

  describe('the Server page', () => {
    it('shows the stage, the lines and what backups would cost', async () => {
      const id = await readyServer();

      const res = await request(http)
        .get(`/bought-servers/${id}`)
        .set('Cookie', owner.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id,
        name: 'web-1',
        stage: 'ready',
        backups: false,
        storageGb: null,
        lines: [{ kind: 'server', monthlyCents: 2500 }],
        monthlyCents: 2500,
        backupsOfferCents: 500,
        change: null,
      });
    });

    it('shows Changing while a change runs', async () => {
      const id = await readyServer();
      await ctx.db
        .update(boughtServer)
        .set({
          stage: 'changing',
          changeTarget: { backups: true, charged: true, lines: [] },
        })
        .where(eq(boughtServer.id, id));

      const res = await request(http)
        .get(`/bought-servers/${id}`)
        .set('Cookie', owner.cookie);

      expect(res.body).toMatchObject({
        stage: 'changing',
        change: { backups: true },
      });
      const again = await setBackups(id, true);
      expect(again.status).toBe(409);
      expect((again.body as { message: string }).message).toBe(
        'A change is already running on this Server. Wait for it to finish',
      );
    });

    it("answers 404 for another Organization's Server", async () => {
      const id = await readyServer();
      const other = await signUpHostedCustomer(http, mail, {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'super-secret-password',
        organizationName: 'Lovelace Labs',
      });

      const res = await request(http)
        .get(`/bought-servers/${id}`)
        .set('Cookie', other.cookie);

      expect(res.status).toBe(404);
    });
  });
});
