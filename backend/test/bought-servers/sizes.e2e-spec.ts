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
import { BoughtServerStages } from '../../src/bought-servers/bought-server-stages.service';
import { subscription } from '../../src/cloud/billing/billing.schema';
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
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const RENEWS_AT = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);

type PaymentMode = 'paid' | 'refused';

interface FakeItem {
  id: string;
  price: string;
}

/**
 * A Bought Server's size, up or down (#1396), through the shared change
 * rule: up is charged before the provider is asked, down is credited once
 * it is made; the machine is powered off for the change and its disk never
 * grown; a refused change is refunded with the machine running at its old
 * size.
 *
 * In Helsinki the fake sells cx23 ($9, backups $2) and cpx22 ($25, backups
 * $5) on x86, and cax11 on Arm.
 */
describe('Changing the size of a Bought Server (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  const mail = new MailRecorder();

  let mode: PaymentMode = 'paid';
  let items: FakeItem[] = [];
  let itemCount = 0;
  let priceCount = 0;
  let invoiceCount = 0;
  /** The provider calls made by the time each charge was made. */
  let providerCallsAtCharge: number[] = [];

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
      amount_paid: 1033,
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
        providerCallsAtCharge.push(
          ctx.hetzner.machines.callsTo('changeServerType').length +
            ctx.hetzner.machines.callsTo('powerOff').length,
        );
        if (mode === 'refused') {
          return Promise.reject(
            Object.assign(new Error('Your card was declined.'), {
              type: 'StripeCardError',
            }),
          );
        }
      }
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
      return Promise.resolve(subscriptionNow(`in_${++invoiceCount}`));
    },
  );
  const retrieveInvoice = jest.fn((id: string) =>
    Promise.resolve(paidInvoice(id)),
  );
  const createRefund = jest.fn<
    Promise<Stripe.Refund>,
    Parameters<StripeApi['createRefund']>
  >(() => Promise.resolve({ id: 're_1' } as Stripe.Refund));
  const stripe: StripeApi = fakeStripe({
    createProduct,
    createPrice,
    retrieveSubscription,
    updateSubscription,
    retrieveInvoice,
    createRefund,
  });

  // The first Setup run, which starts once the machine answers (#1390), is
  // held and never ends here, so a bought Server stays Setting up until
  // readyServer makes it Ready.
  const exec = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(() => new Promise<void>(() => {})),
    execRemote: jest.fn(),
  };

  /** A Bought Server made in Helsinki, its first Setup run held, and made Ready here. */
  async function readyServer(
    serverType: string,
    backups = false,
    location = 'hel1',
    /** The disk it was bought with, when a smaller size's moved up since. */
    diskGb?: number,
  ) {
    const res = await request(http)
      .post('/bought-servers')
      .set('Cookie', owner.cookie)
      .send({
        serverType,
        location,
        backups,
        name: 'web-1',
        termsAccepted: true,
        prorationDate: Math.floor(Date.now() / 1000),
      });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    await ctx.db
      .update(boughtServer)
      .set({ stage: 'ready', ...(diskGb !== undefined ? { diskGb } : {}) })
      .where(eq(boughtServer.id, id));
    jest.clearAllMocks();
    providerCallsAtCharge = [];
    ctx.hetzner.machines.calls.length = 0;
    return id;
  }

  function setSize(id: string, serverType: string) {
    return request(http)
      .put(`/bought-servers/${id}/size`)
      .set('Cookie', owner.cookie)
      .send({ serverType });
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
  const sizeCalls = () =>
    ctx.hetzner.machines.calls
      .map((call) => call.method)
      .filter((method) =>
        ['powerOff', 'changeServerType', 'powerOn'].includes(method),
      );

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
    providerCallsAtCharge = [];
    await openHostedSignUp(ctx.db);
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, 'starter');
  });

  describe('up', () => {
    it('charges at once, before the provider is called, then changes the machine off with the disk not grown', async () => {
      const id = await readyServer('cx23');
      const server = (await lines(id)).find((line) => line.kind === 'server');

      const res = await setSize(id, 'cpx22');

      expect(res.status).toBe(200);
      expect(updateSubscription).toHaveBeenCalledWith(
        `sub_${owner.organizationId}`,
        {
          items: [
            {
              id: server?.stripeSubscriptionItemId,
              price: 'price_server_2',
              quantity: 1,
            },
          ],
          proration_behavior: 'always_invoice',
          payment_behavior: 'pending_if_incomplete',
        },
      );
      expect(providerCallsAtCharge).toEqual([0]);
      expect(sizeCalls()).toEqual(['powerOff', 'changeServerType', 'powerOn']);
      expect(ctx.hetzner.machines.callsTo('changeServerType')).toEqual([
        [machine().id, 'cpx22'],
      ]);
      expect(machine()).toMatchObject({
        serverType: 'cpx22',
        status: 'running',
      });
      expect(await row(id)).toMatchObject({
        stage: 'ready',
        serverType: 'cpx22',
        changeTarget: null,
      });
      expect(res.body).toMatchObject({ stage: 'ready', monthlyCents: 2500 });
      expect(
        (await lines(id)).find((line) => line.kind === 'server'),
      ).toMatchObject({ stripePriceId: 'price_server_2', monthlyCents: 2500 });
    });

    it('moves the backups line to the new size’s price with it', async () => {
      const id = await readyServer('cx23', true);

      const res = await setSize(id, 'cpx22');

      expect(res.status).toBe(200);
      expect(
        (await lines(id)).map((line) => [line.kind, line.monthlyCents]).sort(),
      ).toEqual([
        ['backups', 500],
        ['server', 2500],
      ]);
      expect(res.body).toMatchObject({ monthlyCents: 3000 });
    });

    it('asks the provider for nothing when the card is refused', async () => {
      const id = await readyServer('cx23');
      mode = 'refused';

      const res = await setSize(id, 'cpx22');

      expect(res.status).toBe(402);
      expect(sizeCalls()).toEqual([]);
      expect(await row(id)).toMatchObject({
        stage: 'ready',
        serverType: 'cx23',
      });
    });

    it('is refused while the Organization is frozen', async () => {
      const id = await readyServer('cx23');
      await ctx.db
        .update(subscription)
        .set({ suspendedAt: new Date(), suspendedReason: 'Sending spam' })
        .where(eq(subscription.organizationId, owner.organizationId));

      const res = await setSize(id, 'cpx22');

      expect(res.status).toBe(403);
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(sizeCalls()).toEqual([]);
    });

    it('asks once more after a refusal, powering the machine back on between tries', async () => {
      const id = await readyServer('cx23');
      ctx.hetzner.machines.refuse('changeServerType', 'resource_unavailable');

      const res = await setSize(id, 'cpx22');

      expect(res.status).toBe(200);
      expect(sizeCalls()).toEqual([
        'powerOff',
        'changeServerType',
        'powerOn',
        'powerOff',
        'changeServerType',
        'powerOn',
      ]);
      expect(machine()).toMatchObject({
        serverType: 'cpx22',
        status: 'running',
      });
      expect(createRefund).not.toHaveBeenCalled();
    });

    it('refunds in full and leaves the Server running at its old size when refused twice', async () => {
      const id = await readyServer('cx23');
      const before = await lines(id);
      ctx.hetzner.machines.refuse(
        'changeServerType',
        'resource_unavailable',
        2,
      );
      // The change's charge is the next invoice: how many the purchase made
      // depends on the plan state (#1392).
      const changeInvoice = `in_${invoiceCount + 1}`;

      const res = await setSize(id, 'cpx22');

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'BOUGHT_SERVER_CHANGE_REFUSED',
        message:
          'The change could not be made, so its payment was refunded in full and the Server is as it was',
      });
      expect(createRefund).toHaveBeenCalledWith(
        expect.objectContaining({ payment_intent: `pi_${changeInvoice}` }),
        `bought-server-change-refund-${changeInvoice}`,
      );
      // The Server line back at its old price, with nothing prorated.
      expect(updateSubscription).toHaveBeenLastCalledWith(
        `sub_${owner.organizationId}`,
        {
          items: [
            {
              id: before.find((line) => line.kind === 'server')
                ?.stripeSubscriptionItemId,
              price: before.find((line) => line.kind === 'server')
                ?.stripePriceId,
              quantity: 1,
            },
          ],
          proration_behavior: 'none',
        },
      );
      expect(machine()).toMatchObject({
        serverType: 'cx23',
        status: 'running',
      });
      expect(await row(id)).toMatchObject({
        stage: 'ready',
        serverType: 'cx23',
        changeTarget: null,
      });
      expect(await lines(id)).toEqual(before);

      const sent = mail.to('grace@example.com').at(-1)!;
      expect(sent.email.subject).toBe(
        "We couldn't change the size of web-1, so the payment was refunded",
      );
      expect(sent.email.html).not.toMatch(/hetzner|cpx22|cx23/i);
    });

    it('powers the machine back on when it cannot be powered off, refunding', async () => {
      const id = await readyServer('cx23');
      ctx.hetzner.machines.refuse('powerOff', 'locked', 2);

      const res = await setSize(id, 'cpx22');

      expect(res.status).toBe(409);
      expect(ctx.hetzner.machines.callsTo('changeServerType')).toEqual([]);
      expect(machine()).toMatchObject({
        serverType: 'cx23',
        status: 'running',
      });
      expect(createRefund).toHaveBeenCalledTimes(1);
    });

    it('refuses a size that is sold out there, before anything is charged', async () => {
      // The fake sells cx23 in Falkenstein, sold out there right now. Bought
      // as a cx23 and moved up, so its disk would fit.
      const id = await readyServer('cpx22', false, 'fsn1', 40);

      const res = await setSize(id, 'cx23');

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'SIZE_UNAVAILABLE',
        message:
          'That size is unavailable in Falkenstein right now. Try again later',
      });
      expect(updateSubscription).not.toHaveBeenCalled();
    });
  });

  // Each Server here was bought as a cx23 (a 40 GB disk) and moved up since:
  // its disk was never grown, so it can move back down.
  describe('down', () => {
    it('refuses a size whose disk is smaller than the Server’s, before anything is charged', async () => {
      const id = await readyServer('cpx22');

      const res = await setSize(id, 'cx23');

      expect(res.status).toBe(409);
      expect((res.body as { code: string }).code).toBe('SIZE_DISK_TOO_SMALL');
      expect(sizeCalls()).toEqual([]);
      expect(updateSubscription).not.toHaveBeenCalled();
    });

    it('changes the machine first, then credits the next invoice', async () => {
      const id = await readyServer('cpx22', true, 'hel1', 40);
      const held = await lines(id);

      const res = await setSize(id, 'cx23');

      expect(res.status).toBe(200);
      expect(sizeCalls()).toEqual(['powerOff', 'changeServerType', 'powerOn']);
      expect(updateSubscription).toHaveBeenCalledTimes(1);
      expect(updateSubscription).toHaveBeenCalledWith(
        `sub_${owner.organizationId}`,
        {
          items: [
            {
              id: held.find((line) => line.kind === 'server')
                ?.stripeSubscriptionItemId,
              price: 'price_server_3',
              quantity: 1,
            },
            {
              id: held.find((line) => line.kind === 'backups')
                ?.stripeSubscriptionItemId,
              price: 'price_backups_4',
              quantity: 1,
            },
          ],
          proration_behavior: 'create_prorations',
        },
      );
      expect(machine()).toMatchObject({
        serverType: 'cx23',
        status: 'running',
      });
      expect(res.body).toMatchObject({ stage: 'ready', monthlyCents: 1100 });
    });

    it('stays allowed while the Organization is frozen', async () => {
      const id = await readyServer('cpx22', false, 'hel1', 40);
      await ctx.db
        .update(subscription)
        .set({ suspendedAt: new Date(), suspendedReason: 'Sending spam' })
        .where(eq(subscription.organizationId, owner.organizationId));

      const res = await setSize(id, 'cx23');

      expect(res.status).toBe(200);
      expect(machine().serverType).toBe('cx23');
    });

    it('keeps the Server running at its size and credits nothing when refused twice', async () => {
      const id = await readyServer('cpx22', false, 'hel1', 40);
      ctx.hetzner.machines.refuse('changeServerType', 'locked', 2);

      const res = await setSize(id, 'cx23');

      expect(res.status).toBe(409);
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(createRefund).not.toHaveBeenCalled();
      expect(machine()).toMatchObject({
        serverType: 'cpx22',
        status: 'running',
      });
      expect(await row(id)).toMatchObject({
        stage: 'ready',
        serverType: 'cpx22',
      });
    });
  });

  describe('a restart mid-change', () => {
    it('powers on a machine already on its new size, and finishes', async () => {
      const id = await readyServer('cpx22');
      // Cut off after the type changed, before the machine was powered on.
      await ctx.hetzner.machines.powerOff(machine().id);
      await ctx.hetzner.machines.changeServerType(machine().id, 'cx23');
      await ctx.db
        .update(boughtServer)
        .set({
          stage: 'changing',
          changeTarget: {
            serverType: 'cx23',
            charged: false,
            lines: [
              {
                kind: 'server',
                stripePriceId: 'price_server_cut',
                monthlyCents: 900,
              },
            ],
          },
          changeTries: 1,
        })
        .where(eq(boughtServer.id, id));
      ctx.hetzner.machines.calls.length = 0;

      await ctx.app.get(BoughtServerStages).advance(id);

      expect(sizeCalls()).toEqual(['powerOn']);
      expect(machine()).toMatchObject({
        serverType: 'cx23',
        status: 'running',
      });
      expect(await row(id)).toMatchObject({
        stage: 'ready',
        serverType: 'cx23',
      });
    });
  });

  describe('the sizes it can move to', () => {
    it('lists the sizes sold where it is, on its kind of processor, with their prices', async () => {
      const id = await readyServer('cx23');

      const res = await request(http)
        .get(`/bought-servers/${id}/sizes`)
        .set('Cookie', owner.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        {
          id: 'cx23',
          family: 'shared',
          vcpus: 2,
          memoryGb: 4,
          diskGb: 40,
          monthlyCents: 900,
          backupsMonthlyCents: 200,
          available: true,
          smallerDisk: false,
          current: true,
        },
        {
          id: 'cpx22',
          family: 'amd',
          vcpus: 3,
          memoryGb: 4,
          diskGb: 80,
          monthlyCents: 2500,
          backupsMonthlyCents: 500,
          available: true,
          smallerDisk: false,
          current: false,
        },
      ]);
    });

    it('marks the sizes whose disk is smaller than the Server’s', async () => {
      const id = await readyServer('cpx22');

      const res = await request(http)
        .get(`/bought-servers/${id}/sizes`)
        .set('Cookie', owner.cookie);

      expect(
        (res.body as Array<{ id: string; smallerDisk: boolean }>).map(
          ({ id: size, smallerDisk }) => [size, smallerDisk],
        ),
      ).toEqual([
        ['cx23', true],
        ['cpx22', false],
      ]);
    });

    it('refuses a move to Arm', async () => {
      const id = await readyServer('cx23');

      const res = await setSize(id, 'cax11');

      expect(res.status).toBe(409);
      expect((res.body as { code: string }).code).toBe('SIZE_NOT_SOLD');
      expect(sizeCalls()).toEqual([]);
    });
  });
});
