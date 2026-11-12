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
import { storageCommand } from '../../src/bought-servers/storage';
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

interface FakeItem {
  id: string;
  price: string;
}

/**
 * Extra storage on a Bought Server (#1395): chosen at Buy, it is its own
 * line, a Volume in the Server's Location made and attached once the machine
 * is, and mounted once setup finishes. Grown later, it is charged first,
 * then the Volume and the filesystem are grown; it never shrinks, and a grow
 * the provider refuses twice is refunded as any paid change is.
 *
 * Stripe is a small model of one subscription's items; the provider is the
 * in-memory fake (`ctx.hetzner.machines`); the machine's shell is a mock.
 */
describe('Extra storage on a Bought Server (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  const mail = new MailRecorder();

  let items: FakeItem[] = [];
  let itemCount = 0;
  let priceCount = 0;
  let invoiceCount = 0;
  /** How many times the provider had been asked to grow a Volume when each charge was made. */
  let resizeCallsAtCharge: number[] = [];

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
      amount_paid: 1307,
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
        resizeCallsAtCharge.push(
          ctx.hetzner.machines.callsTo('resizeVolume').length,
        );
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
  const previewInvoice = jest.fn(() =>
    Promise.resolve({ amount_due: 2100, currency: 'usd' } as Stripe.Invoice),
  );
  const stripe: StripeApi = fakeStripe({
    createProduct,
    createPrice,
    retrieveSubscription,
    updateSubscription,
    retrieveInvoice,
    createRefund,
    previewInvoice,
  });

  const execAsyncRemote = jest.fn<
    Promise<{ stdout: string; stderr: string }>,
    [string, string, ((chunk: string) => void)?]
  >();
  // The first Setup run, which starts once the machine answers (#1390), is
  // held and never ends here, so a bought Server stays Setting up until a
  // test makes it Ready; after that the shell answers at once.
  const holdSetup = () =>
    execAsyncRemote.mockImplementation(() => new Promise(() => {}));
  const answerAtOnce = () =>
    execAsyncRemote.mockImplementation(() =>
      Promise.resolve({ stdout: '', stderr: '' }),
    );
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote,
    execRemote: jest.fn(() => Promise.resolve({ stdout: '', stderr: '' })),
  };

  /**
   * The cpx22 in Helsinki: $25 a month. Extra storage is 0.0767 a GB × 1.2
   * = 0.09204: 100 GB is 9.20, so $10; 250 GB is 23.01, so $24.
   */
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
    answerAtOnce();
    resizeCallsAtCharge = [];
    ctx.hetzner.machines.calls.length = 0;
    return id;
  }

  function grow(id: string, sizeGb: number) {
    return request(http)
      .put(`/bought-servers/${id}/storage`)
      .set('Cookie', owner.cookie)
      .send({ sizeGb });
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
  const volume = () => ctx.hetzner.machines.volumes()[0];

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        { provide: STRIPE_API, useValue: stripe },
        { provide: RemoteExecService, useValue: execMock },
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
    holdSetup();
    mail.clear();
    items = [{ id: 'si_plan', price: 'price_starter_plan' }];
    itemCount = 0;
    priceCount = 0;
    invoiceCount = 0;
    resizeCallsAtCharge = [];
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
    it('adds a storage line beside the Server line, charged with it', async () => {
      const res = await buy({ storageGb: 100 });

      expect(res.status).toBe(201);
      expect(createPrice).toHaveBeenCalledWith(
        expect.objectContaining({
          unit_amount: 1000,
          product: 'cloudgate_bought_server_storage',
          recurring: { interval: 'month' },
        }),
      );
      expect(updateSubscription).toHaveBeenCalledWith(
        `sub_${owner.organizationId}`,
        expect.objectContaining({
          items: [
            { price: 'price_server_1', quantity: 1 },
            { price: 'price_storage_2', quantity: 1 },
          ],
          proration_behavior: 'always_invoice',
        }),
      );
      const id = (res.body as { id: string }).id;
      expect(
        (await lines(id)).map((line) => [line.kind, line.monthlyCents]),
      ).toEqual(
        expect.arrayContaining([
          ['server', 2500],
          ['storage', 1000],
        ]),
      );
    });

    it("previews today's charge with the storage line", async () => {
      const res = await request(http)
        .get('/bought-servers/today')
        .query({ ...choice, storageGb: '100' })
        .set('Cookie', owner.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ monthly: 3500 });
      const [[params]] = previewInvoice.mock.calls as unknown as [
        [Stripe.InvoiceCreatePreviewParams],
      ];
      expect(
        params.subscription_details?.items?.map((item) => [
          item.price_data?.product,
          item.price_data?.unit_amount,
        ]),
      ).toEqual([
        ['cloudgate_bought_server', 2500],
        ['cloudgate_bought_server_storage', 1000],
      ]);
    });

    it('refuses less than 10 GB or more than 10 TB', async () => {
      expect((await buy({ storageGb: 5 })).status).toBe(400);
      expect((await buy({ storageGb: 10241 })).status).toBe(400);
      expect(updateSubscription).not.toHaveBeenCalled();
    });

    it("makes a Volume in the Server's Location and attaches it before the Server is written", async () => {
      const res = await buy({ storageGb: 100 });

      const id = (res.body as { id: string }).id;
      expect(volume()).toMatchObject({
        sizeGb: 100,
        location: 'hel1',
        serverId: machine().id,
        labels: {
          'cloudgate-organization': owner.organizationId,
          'cloudgate-server': id,
        },
      });
      expect(await row(id)).toMatchObject({
        storageGb: 100,
        providerVolumeId: volume().id,
        stage: 'setting_up',
        serverId: id,
      });
    });

    it('is mounted by the first Setup run, once the setup command finishes', async () => {
      answerAtOnce();

      const id = ((await buy({ storageGb: 100 })).body as { id: string }).id;

      // The run is detached from Buy: wait for it to make the Server Ready.
      for (let i = 0; i < 50 && (await row(id)).stage !== 'ready'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await row(id)).toMatchObject({ stage: 'ready' });
      const calls = execAsyncRemote.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[1].slice(0, 2)).toEqual([
        id,
        storageCommand(volume().id, 100),
      ]);
    });

    it('makes no Volume when none is chosen', async () => {
      await buy();

      expect(ctx.hetzner.machines.volumes()).toEqual([]);
      expect(ctx.hetzner.machines.callsTo('createVolume')).toEqual([]);
    });

    it('asks for the Volume once more when the provider refuses it', async () => {
      ctx.hetzner.machines.refuse('createVolume', 'resource_unavailable', 1);

      const id = ((await buy({ storageGb: 100 })).body as { id: string }).id;

      expect(ctx.hetzner.machines.callsTo('createVolume')).toHaveLength(2);
      expect(ctx.hetzner.machines.volumes()).toHaveLength(1);
      expect(await row(id)).toMatchObject({
        stage: 'setting_up',
        storageTries: 2,
        providerVolumeId: volume().id,
      });
      expect(createRefund).not.toHaveBeenCalled();
    });

    it('refunds in full and deletes the machine made when the Volume is refused twice', async () => {
      ctx.hetzner.machines.refuse('createVolume', 'resource_unavailable', 2);

      const id = ((await buy({ storageGb: 100 })).body as { id: string }).id;

      expect(ctx.hetzner.machines.callsTo('createVolume')).toHaveLength(2);
      expect(createRefund).toHaveBeenCalledTimes(1);
      // Nothing the provider bills is left behind.
      expect(ctx.hetzner.machines.servers()).toEqual([]);
      expect(ctx.hetzner.machines.volumes()).toEqual([]);
      expect(ctx.hetzner.machines.primaryIps()).toEqual([]);
      expect(await row(id)).toBeUndefined();
      expect(await lines(id)).toEqual([]);
      expect(items.map((item) => item.price)).toEqual(['price_starter_plan']);
      expect(
        mail
          .to('grace@example.com')
          .filter(({ email }) => /refunded/i.test(email.subject)),
      ).toHaveLength(1);
    });

    it('finds a Volume a restart cut off by its labels, rather than making a second', async () => {
      ctx.hetzner.machines.refuse('attachVolume', 'locked', 1);
      const res = await buy({ storageGb: 100 });
      const id = (res.body as { id: string }).id;
      expect(await row(id)).toMatchObject({ stage: 'creating' });
      // As if the restart came before its id was stored.
      await ctx.db
        .update(boughtServer)
        .set({ providerVolumeId: null })
        .where(eq(boughtServer.id, id));

      await ctx.app.get(BoughtServerStages).advance(id);

      expect(ctx.hetzner.machines.callsTo('createVolume')).toHaveLength(1);
      expect(ctx.hetzner.machines.volumes()).toHaveLength(1);
      expect(volume().serverId).toBe(machine().id);
      expect(await row(id)).toMatchObject({
        stage: 'setting_up',
        providerVolumeId: volume().id,
      });
    });

    it('mounts it once setup finishes', async () => {
      const id = await readyServer({ storageGb: 100 });

      const res = await request(http)
        .post(`/servers/${id}/setup`)
        .set('Cookie', owner.cookie);

      expect(res.status).toBe(200);
      const commands = execAsyncRemote.mock.calls.map(
        (call) => (call as unknown as [string, string])[1],
      );
      expect(commands).toHaveLength(2);
      expect(commands[1]).toBe(storageCommand(volume().id, 100));
    });

    it('runs only the setup on a Server with no extra storage', async () => {
      const id = await readyServer();

      await request(http)
        .post(`/servers/${id}/setup`)
        .set('Cookie', owner.cookie);

      expect(execAsyncRemote).toHaveBeenCalledTimes(1);
    });
  });

  describe('grown on a Ready Server', () => {
    it('charges first, then grows the Volume and the filesystem', async () => {
      const id = await readyServer({ storageGb: 100 });

      const res = await grow(id, 250);

      expect(res.status).toBe(200);
      expect(createPrice).toHaveBeenCalledWith(
        expect.objectContaining({
          unit_amount: 2400,
          product: 'cloudgate_bought_server_storage',
        }),
      );
      expect(updateSubscription).toHaveBeenCalledWith(
        `sub_${owner.organizationId}`,
        {
          items: [{ id: 'si_2', price: 'price_storage_3', quantity: 1 }],
          proration_behavior: 'always_invoice',
          payment_behavior: 'pending_if_incomplete',
        },
      );
      // The provider had not been asked when the charge was made.
      expect(resizeCallsAtCharge).toEqual([0]);
      expect(ctx.hetzner.machines.callsTo('resizeVolume')).toEqual([
        [volume().id, 250],
      ]);
      expect(volume().sizeGb).toBe(250);
      expect(execAsyncRemote).toHaveBeenCalledWith(
        id,
        storageCommand(volume().id, 250),
      );
      expect(res.body).toMatchObject({
        stage: 'ready',
        storageGb: 250,
        monthlyCents: 4900,
        change: null,
      });
      expect(await row(id)).toMatchObject({
        stage: 'ready',
        storageGb: 250,
        changeTarget: null,
      });
      expect(
        (await lines(id)).find((line) => line.kind === 'storage'),
      ).toMatchObject({
        stripePriceId: 'price_storage_3',
        stripeSubscriptionItemId: 'si_2',
        monthlyCents: 2400,
      });
    });

    it('refuses a smaller size, or the same, before anything is charged', async () => {
      const id = await readyServer({ storageGb: 100 });

      for (const sizeGb of [50, 100]) {
        const res = await grow(id, sizeGb);
        if (sizeGb === 100) {
          // The same size again is the change already made: nothing to do.
          expect(res.status).toBe(200);
          continue;
        }
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'STORAGE_ONLY_GROWS',
          message: 'Extra storage can only grow. Choose more than 100 GB',
        });
      }
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(ctx.hetzner.machines.callsTo('resizeVolume')).toEqual([]);
      expect(await row(id)).toMatchObject({ stage: 'ready', storageGb: 100 });
    });

    it('is refused on a Server bought without extra storage', async () => {
      const id = await readyServer();

      const res = await grow(id, 50);

      expect(res.status).toBe(409);
      expect((res.body as { code: string }).code).toBe('NO_EXTRA_STORAGE');
      expect(updateSubscription).not.toHaveBeenCalled();
    });

    it('refunds in full and keeps the storage as it was when the provider refuses twice', async () => {
      const id = await readyServer({ storageGb: 100 });
      const before = await lines(id);
      ctx.hetzner.machines.refuse('resizeVolume', 'locked', 2);
      // The change's charge is the next invoice: how many the purchase made
      // depends on the plan state (#1392).
      const changeInvoice = `in_${invoiceCount + 1}`;

      const res = await grow(id, 250);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'BOUGHT_SERVER_CHANGE_REFUSED',
        message:
          'The change could not be made, so its payment was refunded in full and the Server is as it was',
      });
      expect(ctx.hetzner.machines.callsTo('resizeVolume')).toHaveLength(2);
      expect(createRefund).toHaveBeenCalledWith(
        expect.objectContaining({ payment_intent: `pi_${changeInvoice}` }),
        expect.stringMatching(/^bought-server-change-refund-/),
      );
      // The line back on its old price, with nothing prorated.
      expect(updateSubscription).toHaveBeenLastCalledWith(
        `sub_${owner.organizationId}`,
        {
          items: [{ id: 'si_2', price: 'price_storage_2', quantity: 1 }],
          proration_behavior: 'none',
        },
      );
      expect(volume().sizeGb).toBe(100);
      expect(execAsyncRemote).not.toHaveBeenCalled();
      expect(await row(id)).toMatchObject({
        stage: 'ready',
        storageGb: 100,
        changeTarget: null,
      });
      expect(await lines(id)).toEqual(before);

      const sent = mail.to('grace@example.com').at(-1)!;
      expect(sent.email.subject).toBe(
        "We couldn't grow the extra storage of web-1 to 250 GB, so the payment was refunded",
      );
      expect(sent.email.html).not.toMatch(/hetzner/i);
    });

    it('is Ready with the storage grown when the machine cannot be reached, for the next setup to grow', async () => {
      const id = await readyServer({ storageGb: 100 });
      execAsyncRemote.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));

      const res = await grow(id, 250);

      expect(res.status).toBe(200);
      expect(volume().sizeGb).toBe(250);
      expect(await row(id)).toMatchObject({ stage: 'ready', storageGb: 250 });
    });
  });
});
