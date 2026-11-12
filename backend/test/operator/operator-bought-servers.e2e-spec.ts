// The Hosted instance with both provider tokens and no reverse-DNS domain.
// Set before the app module is imported: ConfigModule snapshots the
// environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();
process.env.HETZNER_EUR_API_TOKEN = 'eur-token-for-the-fake';
process.env.HETZNER_USD_API_TOKEN = 'usd-token-for-the-fake';
delete process.env.BOUGHT_SERVER_REVERSE_DNS_DOMAIN;

import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  boughtServer,
  boughtServerLine,
} from '../../src/bought-servers/bought-server.schema';
import type { BoughtServerStage } from '../../src/bought-servers/bought-server.schema';
import { DayRates } from '../../src/bought-servers/exchange-rate/day-rates.service';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { MailService } from '../../src/mail/mail.service';
import { fakeStripe } from '../utils/fake-stripe';
import { givenPlan } from '../utils/hosted-plan';
import {
  HOSTED_STAFF,
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import type { HostedCustomer } from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const OPERATOR_REFUSAL =
  'Only an owner or admin of the Instance organization can use the Operator page';
const RENEWS_AT = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);

interface AuditRow {
  organizationId: string | null;
  userEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: string | null;
}

interface ListedServer {
  id: string;
  name: string;
  organization: { id: string; name: string };
  serverType: string;
  location: string;
  stage: string;
  monthlyCents: number;
  providerServerId: number | null;
  margin: {
    costCents: number;
    marginCents: number;
    marginPercent: number;
  } | null;
  belowFloor: boolean;
}

interface Listing {
  exchangeRate: { usdPerEur: number; on: string } | null;
  costsRead: boolean;
  marginFloorPercent: number;
  servers: ListedServer[];
}

/**
 * The Operator page's Bought Servers section (#1399, spec #1387): every
 * Bought Server with its real margin at the day's rate (the fake's 1.16 USD
 * per EUR), flagged under the margin floor, and the Server markup and floor,
 * each change audited in the Instance organization. A markup change prices
 * the next purchase only. The provider is the in-memory fake: its EUR
 * account prices the cpx22 in Helsinki at 16.49 + 0.50 IPv4.
 */
describe('The Operator sees Bought Servers and sets the Server markup (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let staffCookie: string;
  let instanceOrganizationId: string;
  let grace: HostedCustomer;
  const mail = new MailRecorder();

  // A small model of one subscription whose purchases are paid at once.
  let priceCount = 0;
  let carried: string[] = [];
  const subscriptionNow = (): Stripe.Subscription =>
    ({
      id: `sub_${grace.organizationId}`,
      object: 'subscription',
      status: 'active',
      customer: `cus_${grace.organizationId}`,
      metadata: {},
      latest_invoice: 'in_purchase',
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
  const createPrice = jest.fn(() =>
    Promise.resolve({ id: `price_bought_${++priceCount}` } as Stripe.Price),
  );
  const stripe: StripeApi = fakeStripe({
    createProduct: jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('exists'), { code: 'resource_already_exists' }),
      ),
    ),
    createPrice,
    retrieveSubscription: jest.fn(() => Promise.resolve(subscriptionNow())),
    updateSubscription: jest.fn(
      (_id: string, params: Stripe.SubscriptionUpdateParams) => {
        carried = [
          ...carried,
          ...(params.items ?? []).map((item) => item.price as string),
        ];
        return Promise.resolve(subscriptionNow());
      },
    ),
    retrieveInvoice: jest.fn(() =>
      Promise.resolve({
        id: 'in_purchase',
        object: 'invoice',
        status: 'paid',
        amount_paid: 2500,
        parent: {
          subscription_details: {
            subscription: `sub_${grace.organizationId}`,
          },
        },
        payments: { data: [] },
      } as unknown as Stripe.Invoice),
    ),
  });

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
    jest.restoreAllMocks();
    await ctx.resetDb();
    jest.clearAllMocks();
    mail.clear();
    priceCount = 0;
    carried = ['price_starter_plan'];
    instanceOrganizationId = (await openHostedSignUp(ctx.db)).organizationId;
    staffCookie = await signIn(HOSTED_STAFF.email, HOSTED_STAFF.password);
    grace = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, grace.organizationId, 'starter');
  });

  async function signIn(email: string, password: string): Promise<string> {
    const res = await request(http)
      .post('/api/auth/sign-in/email')
      .send({ email, password });
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
  }

  /** Arrangement only: a Bought Server of Hopper Labs, sold at `cents`. */
  async function givenBoughtServer(input: {
    name: string;
    cents: number;
    stage?: BoughtServerStage;
    backups?: boolean;
    storageGb?: number;
    createdAt: Date;
  }): Promise<string> {
    const [row] = await ctx.db
      .insert(boughtServer)
      .values({
        organizationId: grace.organizationId,
        name: input.name,
        stage: input.stage ?? 'ready',
        serverType: 'cpx22',
        location: 'hel1',
        backups: input.backups ?? false,
        storageGb: input.storageGb ?? null,
        providerServerId: 4200 + priceCount,
        termsAcceptedBy: grace.id,
        termsAcceptedAt: input.createdAt,
        createdAt: input.createdAt,
      })
      .returning({ id: boughtServer.id });
    await ctx.db.insert(boughtServerLine).values({
      boughtServerId: row.id,
      kind: 'server',
      stripePriceId: `price_given_${++priceCount}`,
      monthlyCents: input.cents,
    });
    return row.id;
  }

  async function listing(cookie = staffCookie): Promise<Listing> {
    const res = await request(http)
      .get('/operator/bought-servers')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as Listing;
  }

  function setSettings(body: Record<string, unknown>, cookie = staffCookie) {
    return request(http)
      .put('/operator/bought-servers/settings')
      .set('Cookie', cookie)
      .send(body);
  }

  function buy(): request.Test {
    return request(http)
      .post('/bought-servers')
      .set('Cookie', grace.cookie)
      .send({
        serverType: 'cpx22',
        location: 'hel1',
        name: 'web-1',
        termsAccepted: true,
        prorationDate: Math.floor(Date.now() / 1000),
      });
  }

  async function instanceTrail(): Promise<AuditRow[]> {
    const res = await request(http)
      .get('/audit-logs')
      .query({ resourceType: 'organization' })
      .set('Cookie', staffCookie);
    expect(res.status).toBe(200);
    return (res.body as { logs: AuditRow[] }).logs;
  }

  describe('the list', () => {
    it("lists every Bought Server's account facts with its real margin at the day's rate", async () => {
      const id = await givenBoughtServer({
        name: 'web-1',
        cents: 2500,
        createdAt: new Date('2026-11-01T09:00:00Z'),
      });

      const page = await listing();

      expect(page.exchangeRate).toEqual({ usdPerEur: 1.16, on: '2026-11-10' });
      expect(page.costsRead).toBe(true);
      expect(page.marginFloorPercent).toBe(10);
      // (16.49 + 0.50) EUR × 1.16 = 19.7084 → $19.71; $25 − $19.71 = $5.29, 21.2%.
      expect(page.servers).toEqual([
        {
          id,
          name: 'web-1',
          organization: { id: grace.organizationId, name: 'Hopper Labs' },
          serverType: 'cpx22',
          location: 'hel1',
          stage: 'ready',
          monthlyCents: 2500,
          providerServerId: expect.any(Number) as number,
          margin: { costCents: 1971, marginCents: 529, marginPercent: 21.2 },
          belowFloor: false,
          poweredOff: null,
          createdAt: '2026-11-01T09:00:00.000Z',
        },
      ]);
    });

    it('flags a Bought Server whose margin is under the floor, and moves with the rate', async () => {
      await givenBoughtServer({
        name: 'web-1',
        cents: 2500,
        createdAt: new Date('2026-11-01T09:00:00Z'),
      });
      // Backups and 100 GB: 16.49 + 0.50 + 3.298 + 5.72 = 26.008 EUR, $30.17 at 1.16.
      await givenBoughtServer({
        name: 'db-1',
        cents: 3200,
        backups: true,
        storageGb: 100,
        createdAt: new Date('2026-11-02T09:00:00Z'),
      });

      const flagged = (page: Listing) =>
        Object.fromEntries(page.servers.map((s) => [s.name, s.belowFloor]));
      expect(flagged(await listing())).toEqual({
        'db-1': true,
        'web-1': false,
      });

      // A stronger euro, with no price changed: web-1 falls under the floor.
      ctx.exchangeRate.rate = { usdPerEur: 1.35, on: '2026-11-11' };
      ctx.app.get(DayRates).forget();
      const page = await listing();
      expect(page.exchangeRate).toEqual({ usdPerEur: 1.35, on: '2026-11-11' });
      expect(flagged(page)).toEqual({ 'db-1': true, 'web-1': true });
    });

    it('reads the rate once for the whole page', async () => {
      for (const name of ['a', 'b', 'c']) {
        await givenBoughtServer({
          name,
          cents: 2500,
          createdAt: new Date('2026-11-01T09:00:00Z'),
        });
      }

      await listing();
      await listing();

      expect(ctx.exchangeRate.reads).toBe(1);
    });

    it('still lists every Bought Server while the rate cannot be read, with no margin', async () => {
      await givenBoughtServer({
        name: 'web-1',
        cents: 2500,
        createdAt: new Date('2026-11-01T09:00:00Z'),
      });
      ctx.exchangeRate.unreachable = true;

      const page = await listing();

      expect(page.exchangeRate).toBeNull();
      expect(page.servers).toEqual([
        expect.objectContaining({
          name: 'web-1',
          margin: null,
          belowFloor: false,
        }),
      ]);
    });

    it('shows no margin for a Bought Server the provider no longer bills', async () => {
      await givenBoughtServer({
        name: 'gone',
        cents: 2500,
        stage: 'deleted',
        createdAt: new Date('2026-11-01T09:00:00Z'),
      });

      const page = await listing();

      expect(page.servers).toEqual([
        expect.objectContaining({
          name: 'gone',
          margin: null,
          belowFloor: false,
        }),
      ]);
    });
  });

  describe('the settings', () => {
    it('start at a 20% markup and a 10% floor, and say the reverse-DNS domain is unset', async () => {
      const res = await request(http)
        .get('/operator/bought-servers/settings')
        .set('Cookie', staffCookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        markupPercent: 20,
        marginFloorPercent: 10,
        reverseDnsDomain: null,
      });
    });

    it('records each change in the Instance organization, with the old and new value', async () => {
      const res = await setSettings({
        markupPercent: 25,
        marginFloorPercent: 12,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        markupPercent: 25,
        marginFloorPercent: 12,
        reverseDnsDomain: null,
      });

      const rows = (await instanceTrail()).filter((row) =>
        row.metadata?.includes('"actedBy":"Octabyte"'),
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({
          organizationId: instanceOrganizationId,
          userEmail: HOSTED_STAFF.email,
          action: 'update',
          resourceType: 'organization',
          resourceId: instanceOrganizationId,
        });
      }
      expect(rows.map((row) => JSON.parse(row.metadata!) as object)).toEqual(
        expect.arrayContaining([
          { actedBy: 'Octabyte', type: 'setServerMarkup', from: 20, to: 25 },
          { actedBy: 'Octabyte', type: 'setMarginFloor', from: 10, to: 12 },
        ]),
      );
    });

    it('records nothing for a value that did not change', async () => {
      const res = await setSettings({ markupPercent: 20 });

      expect(res.status).toBe(200);
      expect(
        (await instanceTrail()).filter((row) =>
          row.metadata?.includes('setServerMarkup'),
        ),
      ).toEqual([]);
    });

    it('refuses a markup or floor out of range, or no setting at all', async () => {
      for (const body of [
        {},
        { markupPercent: -1 },
        { markupPercent: 2.5 },
        { marginFloorPercent: 101 },
      ]) {
        const res = await setSettings(body);
        expect(res.status).toBe(400);
      }
    });

    it('flags against the new floor', async () => {
      await givenBoughtServer({
        name: 'web-1',
        cents: 2500,
        createdAt: new Date('2026-11-01T09:00:00Z'),
      });

      await setSettings({ marginFloorPercent: 25 }).expect(200);

      const page = await listing();
      expect(page.marginFloorPercent).toBe(25);
      expect(page.servers[0].belowFloor).toBe(true);
    });
  });

  describe('a markup change', () => {
    it('leaves lines already sold at their price and prices the next purchase with the new markup', async () => {
      // 19.49 + 0.60 IPv4 = 20.09 USD × 1.20 = 24.108 → $25.
      const first = await buy();
      expect(first.status).toBe(201);
      expect(createPrice).toHaveBeenLastCalledWith(
        expect.objectContaining({ unit_amount: 2500 }),
      );

      await setSettings({ markupPercent: 50 }).expect(200);

      // 20.09 × 1.50 = 30.135 → $31.
      const catalogue = await request(http)
        .get('/bought-servers/catalogue')
        .set('Cookie', grace.cookie);
      const cpx22 = (
        catalogue.body as {
          sizes: Array<{
            id: string;
            offers: Array<{ locationId: string; monthly: number }>;
          }>;
        }
      ).sizes.find((size) => size.id === 'cpx22');
      expect(cpx22?.offers.find((o) => o.locationId === 'hel1')?.monthly).toBe(
        31,
      );

      const second = await buy();
      expect(second.status).toBe(201);
      expect(createPrice).toHaveBeenLastCalledWith(
        expect.objectContaining({ unit_amount: 3100 }),
      );

      // The first Server's line keeps the price it was sold at.
      const lines = await ctx.db.select().from(boughtServerLine);
      expect(lines.map((line) => line.monthlyCents).sort()).toEqual([
        2500, 3100,
      ]);
    });
  });

  describe('for anybody else', () => {
    it('refuses a customer, who is not an Operator', async () => {
      for (const attempt of [
        () => request(http).get('/operator/bought-servers'),
        () => request(http).get('/operator/bought-servers/settings'),
        () =>
          request(http)
            .put('/operator/bought-servers/settings')
            .send({ markupPercent: 0 }),
      ]) {
        const res = await attempt().set('Cookie', grace.cookie);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ message: OPERATOR_REFUSAL });
      }
      const settings = await request(http)
        .get('/operator/bought-servers/settings')
        .set('Cookie', staffCookie);
      expect(settings.body).toMatchObject({ markupPercent: 20 });
    });

    it('does not exist on a Self-hosted instance, even for the Instance organization owner', async () => {
      jest
        .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
        .mockReturnValue(false);

      for (const attempt of [
        () => request(http).get('/operator/bought-servers'),
        () => request(http).get('/operator/bought-servers/settings'),
        () =>
          request(http)
            .put('/operator/bought-servers/settings')
            .send({ markupPercent: 0 }),
      ]) {
        const res = await attempt().set('Cookie', staffCookie);
        expect(res.status).toBe(404);
      }
    });
  });
});
