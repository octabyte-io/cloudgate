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
 * **Back up now** on a Bought Server (#179, spec #177, ADR-0093): one more
 * Server backup at once, in the same 7 slots as the daily ones, so the
 * oldest is pushed out once all 7 are full. It costs nothing, so a deletion
 * date does not refuse it; a Frozen Organization, a Server that is not
 * Ready and one whose backups are off are refused, each with its reason.
 * `server: ['create']`, as the other changes.
 *
 * Stripe is a stub that pays every charge (Buy needs one); the provider is
 * the in-memory fake (`ctx.hetzner.machines`), which a spec seeds with the
 * backups the provider's daily run would have made, and finishes the one it
 * was asked for.
 */
describe('Back up now on a Bought Server (e2e)', () => {
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

  function backUpNow(id: string, cookie = owner.cookie) {
    return request(http)
      .post(`/bought-servers/${id}/backups`)
      .set('Cookie', cookie);
  }

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

  it('takes a backup at once, listed as being made until the provider has made it, then with its size', async () => {
    const id = await readyServer();
    const fake = ctx.hetzner.machines;

    const res = await backUpNow(id);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sizeGb: null, beingMade: true });
    const taken = res.body as { id: number; takenAt: string };
    expect(fake.callsTo('createBackup')).toEqual([
      [machine().id, 'Back up now'],
    ]);
    expect((await listBackups(id)).body).toEqual([
      { id: taken.id, takenAt: taken.takenAt, sizeGb: null, beingMade: true },
    ]);

    fake.finishBackup(taken.id, 2.4);

    expect((await listBackups(id)).body).toEqual([
      { id: taken.id, takenAt: taken.takenAt, sizeGb: 2.4, beingMade: false },
    ]);
  });

  it('pushes out the oldest of 7 backups, which is gone from the list afterwards', async () => {
    const id = await readyServer();
    const fake = ctx.hetzner.machines;
    const seeded = [1, 2, 3, 4, 5, 6, 7].map((day) =>
      fake.addBackup(machine().id, {
        created: `2026-11-0${day}T03:00:00+00:00`,
        imageSizeGb: 2.1,
      }),
    );

    const res = await backUpNow(id);

    expect(res.status).toBe(201);
    const listed = (await listBackups(id)).body as Array<{ id: number }>;
    expect(listed.map((backup) => backup.id)).toEqual([
      (res.body as { id: number }).id,
      seeded[6].id,
      seeded[5].id,
      seeded[4].id,
      seeded[3].id,
      seeded[2].id,
      seeded[1].id,
    ]);
  });

  it('is refused while the Organization is frozen, asking the provider nothing', async () => {
    const id = await readyServer();
    await ctx.db
      .update(subscription)
      .set({ suspendedAt: new Date(), suspendedReason: 'Sending spam' })
      .where(eq(subscription.organizationId, owner.organizationId));

    const res = await backUpNow(id);

    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('ORGANIZATION_FROZEN');
    expect(ctx.hetzner.machines.callsTo('createBackup')).toEqual([]);
  });

  it('is refused until the Server is Ready', async () => {
    const id = await readyServer();
    await ctx.db
      .update(boughtServer)
      .set({ stage: 'changing' })
      .where(eq(boughtServer.id, id));

    const res = await backUpNow(id);

    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toBe(
      "This Server can't be backed up until it is Ready",
    );
    expect(ctx.hetzner.machines.callsTo('createBackup')).toEqual([]);
  });

  it('is refused while backups are off', async () => {
    const id = await readyServer(false);

    const res = await backUpNow(id);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'BACKUPS_OFF',
      message: 'Turn backups on to back up this Server',
    });
    expect(ctx.hetzner.machines.callsTo('createBackup')).toEqual([]);
  });

  it('is not refused by a deletion date, since it costs nothing', async () => {
    const id = await readyServer();
    // A failed payment for Bought Servers, with Stripe's own status still
    // active, so only the deletion date it sets could refuse.
    await ctx.db
      .update(subscription)
      .set({
        boughtServersPaymentFailedAt: new Date(),
        boughtServersFailedInvoiceId: 'in_renewal',
      })
      .where(eq(subscription.organizationId, owner.organizationId));

    const res = await backUpNow(id);

    expect(res.status).toBe(201);
    expect(ctx.hetzner.machines.callsTo('createBackup')).toHaveLength(1);
  });

  it('is refused to a member, who may not change a Server', async () => {
    const id = await readyServer();
    const member = await signUpMember(http, owner.cookie, {
      email: 'edsger@example.com',
    });

    const res = await backUpNow(id, member.cookie);

    expect(res.status).toBe(403);
    expect(ctx.hetzner.machines.callsTo('createBackup')).toEqual([]);
  });

  it('answers 503 in its own words when the provider refuses', async () => {
    const id = await readyServer();
    ctx.hetzner.machines.refuse('createBackup', 'locked');

    const res = await backUpNow(id);

    expect(res.status).toBe(503);
    expect((res.body as { message: string }).message).toBe(
      "This Server can't be backed up right now. Try again later",
    );
    expect(JSON.stringify(res.body)).not.toMatch(/hetzner|locked/i);
  });

  it("answers 404 for another Organization's Server", async () => {
    const id = await readyServer();
    const other = await signUpHostedCustomer(http, mail, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'super-secret-password',
      organizationName: 'Lovelace Labs',
    });

    const res = await backUpNow(id, other.cookie);

    expect(res.status).toBe(404);
    expect(ctx.hetzner.machines.callsTo('createBackup')).toEqual([]);
  });
});
