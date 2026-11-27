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

import { boughtServer } from '../../src/bought-servers/bought-server.schema';
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
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const RENEWS_AT = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);

/**
 * A Bought Server's **Server backups**, listed (#178, spec #177): while its
 * backups are on, each one the provider keeps, newest first, with when it
 * was taken, its size, and whether it is still being made. Off, there are
 * none to list, and the provider is not asked. A read (`server: ['read']`),
 * so a frozen Organization still sees them, and so does an admin.
 *
 * Stripe is a stub that pays every charge (Buy needs one); the provider is
 * the in-memory fake (`ctx.hetzner.machines`), which a spec seeds with the
 * backups the provider's daily run would have made.
 */
describe('Server backups of a Bought Server (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  const mail = new MailRecorder();

  let items: Array<{ id: string; price: string }> = [];
  let itemCount = 0;
  let priceCount = 0;
  let invoiceCount = 0;

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

  const stripe: StripeApi = fakeStripe({
    createProduct: jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('exists'), { code: 'resource_already_exists' }),
      ),
    ),
    createPrice: jest.fn((params: Stripe.PriceCreateParams) =>
      Promise.resolve({
        id: `price_${params.metadata?.kind as string}_${++priceCount}`,
      } as Stripe.Price),
    ),
    retrieveSubscription: jest.fn(() => Promise.resolve(subscriptionNow())),
    updateSubscription: jest.fn(
      (_id: string, params: Stripe.SubscriptionUpdateParams) => {
        for (const item of params.items ?? []) {
          if (item.deleted) {
            items = items.filter((held) => held.id !== item.id);
          } else if (!item.id) {
            items = [...items, { id: `si_${++itemCount}`, price: item.price! }];
          }
        }
        return Promise.resolve(subscriptionNow(`in_${++invoiceCount}`));
      },
    ),
    retrieveInvoice: jest.fn((id: string) => Promise.resolve(paidInvoice(id))),
    listInvoices: jest.fn(() => Promise.resolve([])),
  });

  /** A Bought Server made with backups on (or off), and Ready. */
  async function readyServer(backups = true) {
    const res = await request(http)
      .post('/bought-servers')
      .set('Cookie', owner.cookie)
      .send({
        serverType: 'cpx22',
        location: 'hel1',
        name: 'web-1',
        termsAccepted: true,
        prorationDate: Math.floor(Date.now() / 1000),
        backups,
      });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    await ctx.db
      .update(boughtServer)
      .set({ stage: 'ready' })
      .where(eq(boughtServer.id, id));
    ctx.hetzner.machines.calls.length = 0;
    return id;
  }

  const machine = () => ctx.hetzner.machines.servers()[0];

  function listBackups(id: string, cookie = owner.cookie) {
    return request(http)
      .get(`/bought-servers/${id}/backups`)
      .set('Cookie', cookie);
  }

  // The first Setup run is held and never ends here (as in backups.e2e-spec).
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
    items = [{ id: 'si_plan', price: 'price_starter_plan' }];
    itemCount = 0;
    priceCount = 0;
    invoiceCount = 0;
    await openHostedSignUp(ctx.db);
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, 'starter');
  });

  it('lists each backup newest first, with when it was taken, its size, and whether it is still being made', async () => {
    const id = await readyServer();
    const fake = ctx.hetzner.machines;
    const middle = fake.addBackup(machine().id, {
      created: '2026-11-26T03:10:00+00:00',
      imageSizeGb: 2.31,
    });
    const oldest = fake.addBackup(machine().id, {
      created: '2026-11-25T03:12:00+00:00',
      imageSizeGb: 2.1,
    });
    const newest = fake.addBackup(machine().id, {
      created: '2026-11-27T03:09:00+00:00',
      imageSizeGb: null,
      status: 'creating',
    });

    const res = await listBackups(id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: newest.id,
        takenAt: '2026-11-27T03:09:00.000Z',
        sizeGb: null,
        beingMade: true,
      },
      {
        id: middle.id,
        takenAt: '2026-11-26T03:10:00.000Z',
        sizeGb: 2.31,
        beingMade: false,
      },
      {
        id: oldest.id,
        takenAt: '2026-11-25T03:12:00.000Z',
        sizeGb: 2.1,
        beingMade: false,
      },
    ]);
    expect(fake.callsTo('listBackups')).toEqual([[machine().id]]);
  });

  it('answers an empty list while backups are on and none is taken yet', async () => {
    const id = await readyServer();

    const res = await listBackups(id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('answers an empty list while backups are off, asking the provider nothing', async () => {
    const id = await readyServer(false);

    const res = await listBackups(id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(ctx.hetzner.machines.callsTo('listBackups')).toEqual([]);
  });

  it('still lists them while the Organization is frozen', async () => {
    const id = await readyServer();
    ctx.hetzner.machines.addBackup(machine().id, {
      created: '2026-11-26T03:10:00+00:00',
      imageSizeGb: 2.31,
    });
    await ctx.db
      .update(subscription)
      .set({ suspendedAt: new Date(), suspendedReason: 'Sending spam' })
      .where(eq(subscription.organizationId, owner.organizationId));

    const res = await listBackups(id);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('lists them to an admin, who may read Servers', async () => {
    const id = await readyServer();
    ctx.hetzner.machines.addBackup(machine().id, {
      created: '2026-11-26T03:10:00+00:00',
      imageSizeGb: 2.31,
    });
    const admin = await signUpMember(http, owner.cookie, {
      email: 'ida@example.com',
      role: 'admin',
    });

    const res = await listBackups(id, admin.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('is refused to a member, who reads no Server', async () => {
    const id = await readyServer();
    const member = await signUpMember(http, owner.cookie, {
      email: 'edsger@example.com',
    });

    const res = await listBackups(id, member.cookie);

    expect(res.status).toBe(403);
    expect(ctx.hetzner.machines.callsTo('listBackups')).toEqual([]);
  });

  it('never names the provider, even in its own description of a backup', async () => {
    const id = await readyServer();
    ctx.hetzner.machines.addBackup(machine().id, {
      created: '2026-11-26T03:10:00+00:00',
      imageSizeGb: 2.31,
      description: 'Hetzner Cloud backup of web-1',
    });

    const res = await listBackups(id);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/hetzner|hcloud/i);
  });

  it('answers 503 in its own words when the provider refuses the read', async () => {
    const id = await readyServer();
    ctx.hetzner.machines.refuse('listBackups', 'rate_limit_exceeded');

    const res = await listBackups(id);

    expect(res.status).toBe(503);
    expect((res.body as { message: string }).message).toBe(
      "This Server's backups can't be read right now",
    );
    expect(JSON.stringify(res.body)).not.toMatch(/hetzner|rate_limit/i);
  });

  it("answers 404 for another Organization's Server", async () => {
    const id = await readyServer();
    const other = await signUpHostedCustomer(http, mail, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'super-secret-password',
      organizationName: 'Lovelace Labs',
    });

    const res = await listBackups(id, other.cookie);

    expect(res.status).toBe(404);
    expect(ctx.hetzner.machines.callsTo('listBackups')).toEqual([]);
  });
});
