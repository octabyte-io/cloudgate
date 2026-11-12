// The Hosted instance with both provider tokens. Set before the app module is
// imported: ConfigModule snapshots the environment on first load.
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
import type { BoughtServerStage } from '../../src/bought-servers/bought-server.schema';
import { LapseClockService } from '../../src/cloud/billing/lapse-clock.service';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';
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

const DAY = 24 * 60 * 60 * 1000;
const OPERATOR_REFUSAL =
  'Only an owner or admin of the Instance organization can use the Operator page';

interface Preview {
  id: string;
  name: string;
  organization: { id: string; name: string };
  stage: string;
  status: string;
  oldMonthlyCents: number;
  newMonthlyCents: number | null;
  startsAt: string | null;
  lines: Array<{
    kind: string;
    oldMonthlyCents: number;
    newMonthlyCents: number;
  }>;
}

interface AuditRow {
  organizationId: string | null;
  userEmail: string | null;
  resourceId: string | null;
  metadata: string | null;
}

/**
 * An Operator's reprice of Bought Servers already sold (#1400, spec #1387):
 * preview, confirm, and the daily job's tick on the start date. The USD
 * list is the in-memory provider's: the cpx22 in Helsinki lists at 19.49
 * plus 0.60 IPv4, so $25 at the default 20% markup and 20% backups $5.
 * Stripe is `fakeStripe`; the job tick is called directly with its time.
 */
describe('Bought Server reprice (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let staffCookie: string;
  let instanceOrganizationId: string;
  let grace: HostedCustomer;
  const mail = new MailRecorder();

  let priceCount = 0;
  const subscriptionNow = (): Stripe.Subscription =>
    ({
      id: `sub_${grace.organizationId}`,
      object: 'subscription',
      status: 'active',
      customer: `cus_${grace.organizationId}`,
      metadata: {},
      items: {
        data: ['si_server', 'si_backups'].map((id) => ({
          id,
          price: { id: `price_of_${id}` },
          quantity: 1,
        })),
      },
    }) as unknown as Stripe.Subscription;
  const createPrice = jest.fn((params: Stripe.PriceCreateParams) =>
    Promise.resolve({
      id: `price_repriced_${++priceCount}`,
      unit_amount: params.unit_amount,
    } as Stripe.Price),
  );
  const updateSubscription = jest.fn(() => Promise.resolve(subscriptionNow()));
  const stripe: StripeApi = fakeStripe({
    createPrice,
    updateSubscription,
    retrieveSubscription: jest.fn(() => Promise.resolve(subscriptionNow())),
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
    await ctx.resetDb();
    jest.clearAllMocks();
    mail.clear();
    priceCount = 0;
    instanceOrganizationId = (await openHostedSignUp(ctx.db)).organizationId;
    staffCookie = await signIn(HOSTED_STAFF.email, HOSTED_STAFF.password);
    grace = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, grace.organizationId, 'starter');
    mail.clear();
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

  /** Arrangement only: a Bought Server of Hopper Labs sold at these prices, its lines on the subscription. */
  async function givenBoughtServer(input: {
    name: string;
    serverCents: number;
    backupsCents?: number;
    stage?: BoughtServerStage;
  }): Promise<string> {
    const [row] = await ctx.db
      .insert(boughtServer)
      .values({
        organizationId: grace.organizationId,
        name: input.name,
        stage: input.stage ?? 'ready',
        serverType: 'cpx22',
        location: 'hel1',
        backups: input.backupsCents !== undefined,
        providerServerId: 4200,
        termsAcceptedBy: grace.id,
        termsAcceptedAt: new Date('2026-10-01T09:00:00Z'),
      })
      .returning({ id: boughtServer.id });
    await ctx.db.insert(boughtServerLine).values({
      boughtServerId: row.id,
      kind: 'server',
      stripePriceId: 'price_of_si_server',
      stripeSubscriptionItemId: 'si_server',
      monthlyCents: input.serverCents,
    });
    if (input.backupsCents !== undefined) {
      await ctx.db.insert(boughtServerLine).values({
        boughtServerId: row.id,
        kind: 'backups',
        stripePriceId: 'price_of_si_backups',
        stripeSubscriptionItemId: 'si_backups',
        monthlyCents: input.backupsCents,
      });
    }
    return row.id;
  }

  async function linesOf(id: string) {
    return ctx.db
      .select()
      .from(boughtServerLine)
      .where(eq(boughtServerLine.boughtServerId, id));
  }

  function preview(ids: string[], cookie = staffCookie) {
    return request(http)
      .post('/operator/bought-servers/reprice/preview')
      .set('Cookie', cookie)
      .send({ ids });
  }

  function apply(
    servers: Array<{ id: string; newMonthlyCents: number | null }>,
    cookie = staffCookie,
  ) {
    return request(http)
      .post('/operator/bought-servers/reprice')
      .set('Cookie', cookie)
      .send({ servers });
  }

  /** Previews, then confirms exactly what the preview showed. */
  async function reprice(ids: string[]): Promise<{
    previewed: Preview[];
    applied: Preview[];
  }> {
    const shown = await preview(ids);
    expect(shown.status).toBe(200);
    const previewed = shown.body as Preview[];
    const done = await apply(
      previewed.map((server) => ({
        id: server.id,
        newMonthlyCents: server.newMonthlyCents,
      })),
    );
    expect(done.status).toBe(200);
    return { previewed, applied: done.body as Preview[] };
  }

  /** The provider's USD list price of the cpx22 in Helsinki. */
  function listCpx22At(usd: string): void {
    const cpx22 = ctx.hetzner.prices.catalogue.serverTypes.find(
      (type) => type.name === 'cpx22',
    )!;
    cpx22.prices.find((price) => price.location === 'hel1')!.monthlyNet = usd;
  }

  const tick = (at: Date) => ctx.app.get(LapseClockService).tick(at);

  describe('a rise', () => {
    it('is previewed as applied, writes the next price 30 days on, and emails the owner without naming the provider', async () => {
      const id = await givenBoughtServer({ name: 'web-1', serverCents: 2200 });
      const before = Date.now();

      const { previewed, applied } = await reprice([id]);

      expect(previewed).toEqual([
        {
          id,
          name: 'web-1',
          organization: { id: grace.organizationId, name: 'Hopper Labs' },
          stage: 'ready',
          status: 'rise',
          oldMonthlyCents: 2200,
          newMonthlyCents: 2500,
          startsAt: expect.any(String) as string,
          lines: [
            { kind: 'server', oldMonthlyCents: 2200, newMonthlyCents: 2500 },
          ],
        },
      ]);
      // What is applied is what was previewed; only the moment moved.
      expect(applied).toEqual(
        previewed.map((server) => ({
          ...server,
          startsAt: expect.any(String) as string,
        })),
      );
      const startsAt = new Date(applied[0].startsAt!);
      expect(startsAt.getTime() - before).toBeGreaterThanOrEqual(30 * DAY);
      expect(startsAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * DAY);

      // Nothing at Stripe yet: the price stays until the start date.
      expect(createPrice).not.toHaveBeenCalled();
      expect(updateSubscription).not.toHaveBeenCalled();
      const [line] = await linesOf(id);
      expect(line).toMatchObject({
        monthlyCents: 2200,
        stripePriceId: 'price_of_si_server',
        nextMonthlyCents: 2500,
        nextPriceFrom: startsAt,
      });

      const sent = mail.to('grace@example.com');
      expect(sent).toHaveLength(1);
      const body = sent[0].email.html.replace(/<!-- -->/g, '');
      expect(body).toContain('web-1: $22.00 a month now, $25.00 a month from');
      expect(body).toContain('with no penalty');
      expect(sent[0].email.subject).toContain('web-1');
      expect(`${sent[0].email.subject} ${body}`).not.toMatch(/hetzner/i);
    });

    it("changes the Stripe price only at the daily job's tick on its start date", async () => {
      const id = await givenBoughtServer({ name: 'web-1', serverCents: 2200 });
      const { applied } = await reprice([id]);
      const startsAt = new Date(applied[0].startsAt!);

      await tick(new Date(startsAt.getTime() - 60_000));
      expect(createPrice).not.toHaveBeenCalled();
      expect(updateSubscription).not.toHaveBeenCalled();

      await tick(startsAt);
      expect(createPrice).toHaveBeenCalledTimes(1);
      expect(createPrice).toHaveBeenCalledWith(
        expect.objectContaining({
          currency: 'usd',
          unit_amount: 2500,
          product: 'cloudgate_bought_server',
          recurring: { interval: 'month' },
        }),
      );
      expect(updateSubscription).toHaveBeenCalledTimes(1);
      expect(updateSubscription).toHaveBeenCalledWith(
        `sub_${grace.organizationId}`,
        {
          items: [{ id: 'si_server', price: 'price_repriced_1', quantity: 1 }],
          proration_behavior: 'none',
        },
      );
      const [line] = await linesOf(id);
      expect(line).toMatchObject({
        monthlyCents: 2500,
        stripePriceId: 'price_repriced_1',
        stripeSubscriptionItemId: 'si_server',
        nextMonthlyCents: null,
        nextPriceFrom: null,
      });

      // A later tick has nothing more to do.
      await tick(new Date(startsAt.getTime() + DAY));
      expect(updateSubscription).toHaveBeenCalledTimes(1);
    });

    it('never charges the new price to a Bought Server deleted before its start date', async () => {
      const id = await givenBoughtServer({ name: 'web-1', serverCents: 2200 });
      const { applied } = await reprice([id]);
      const startsAt = new Date(applied[0].startsAt!);
      // Deleted before the date (the ordinary Delete's end state, #1393).
      for (const stage of ['deleting', 'deleted'] as const) {
        await ctx.db
          .update(boughtServer)
          .set({ stage })
          .where(eq(boughtServer.id, id));

        await tick(new Date(startsAt.getTime() + DAY));

        expect(createPrice).not.toHaveBeenCalled();
        expect(updateSubscription).not.toHaveBeenCalled();
        const [line] = await linesOf(id);
        expect(line.monthlyCents).toBe(2200);
      }
    });
  });

  describe('a fall', () => {
    it('changes the Stripe price at once, credited, and emails the owner the new price from today', async () => {
      const id = await givenBoughtServer({
        name: 'web-1',
        serverCents: 3000,
        backupsCents: 500,
      });

      const { previewed, applied } = await reprice([id]);

      expect(previewed[0]).toMatchObject({
        status: 'fall',
        oldMonthlyCents: 3500,
        newMonthlyCents: 3000,
        // Backups already sell at the list price, so only the Server moves.
        lines: [
          { kind: 'server', oldMonthlyCents: 3000, newMonthlyCents: 2500 },
        ],
      });
      expect(applied[0]).toMatchObject({
        status: 'fall',
        newMonthlyCents: 3000,
      });
      expect(updateSubscription).toHaveBeenCalledTimes(1);
      expect(updateSubscription).toHaveBeenCalledWith(
        `sub_${grace.organizationId}`,
        {
          items: [{ id: 'si_server', price: 'price_repriced_1', quantity: 1 }],
          proration_behavior: 'create_prorations',
        },
      );
      const lines = await linesOf(id);
      expect(lines.find((line) => line.kind === 'server')).toMatchObject({
        monthlyCents: 2500,
        stripePriceId: 'price_repriced_1',
        nextMonthlyCents: null,
      });
      expect(lines.find((line) => line.kind === 'backups')).toMatchObject({
        monthlyCents: 500,
        stripePriceId: 'price_of_si_backups',
      });

      const sent = mail.to('grace@example.com');
      expect(sent).toHaveLength(1);
      const body = sent[0].email.html.replace(/<!-- -->/g, '');
      expect(body).toContain(
        'web-1: $30.00 a month instead of $35.00, from today',
      );
      expect(body).not.toContain('no penalty');
      expect(`${sent[0].email.subject} ${body}`).not.toMatch(/hetzner/i);
    });
  });

  describe('the confirm', () => {
    it('is refused, changing nothing, when the list moved since the preview', async () => {
      const id = await givenBoughtServer({ name: 'web-1', serverCents: 2200 });
      const shown = (await preview([id])).body as Preview[];
      expect(shown[0].newMonthlyCents).toBe(2500);

      // (21.49 + 0.60) × 1.2 = 26.508 → $27.
      listCpx22At('21.4900');
      const res = await apply([{ id, newMonthlyCents: 2500 }]);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'PRICES_CHANGED' });
      const [line] = await linesOf(id);
      expect(line.nextMonthlyCents).toBeNull();
      expect(mail.to('grace@example.com')).toEqual([]);
    });

    it('is refused for a Bought Server that already sells at the list price, or is not sold any more', async () => {
      const unchanged = await givenBoughtServer({
        name: 'web-1',
        serverCents: 2500,
      });
      const deleted = await givenBoughtServer({
        name: 'web-2',
        serverCents: 2200,
        stage: 'deleted',
      });

      const shown = (await preview([unchanged, deleted])).body as Preview[];
      expect(shown.map((server) => server.status)).toEqual([
        'unchanged',
        'not-repriceable',
      ]);
      for (const id of [unchanged, deleted]) {
        const res = await apply([{ id, newMonthlyCents: 2500 }]);
        expect(res.status).toBe(409);
      }
    });

    it("is recorded in the Organization's log and the Instance organization's", async () => {
      const id = await givenBoughtServer({ name: 'web-1', serverCents: 2200 });

      await reprice([id]);

      for (const [cookie, organizationId] of [
        [grace.cookie, grace.organizationId],
        [staffCookie, instanceOrganizationId],
      ]) {
        const res = await request(http)
          .get('/audit-logs')
          .query({ resourceType: 'organization' })
          .set('Cookie', cookie);
        expect(res.status).toBe(200);
        const rows = (res.body as { logs: AuditRow[] }).logs.filter((row) =>
          row.metadata?.includes('repriceBoughtServers'),
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          organizationId,
          userEmail: HOSTED_STAFF.email,
          resourceId: grace.organizationId,
        });
        expect(JSON.parse(rows[0].metadata!)).toMatchObject({
          actedBy: 'Octabyte',
          type: 'repriceBoughtServers',
          servers: [
            {
              id,
              name: 'web-1',
              fromMonthlyCents: 2200,
              toMonthlyCents: 2500,
            },
          ],
        });
      }
    });

    it('refuses a customer, who is not an Operator', async () => {
      const id = await givenBoughtServer({ name: 'web-1', serverCents: 2200 });

      for (const res of [
        await preview([id], grace.cookie),
        await apply([{ id, newMonthlyCents: 2500 }], grace.cookie),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ message: OPERATOR_REFUSAL });
      }
      const [line] = await linesOf(id);
      expect(line.nextMonthlyCents).toBeNull();
    });
  });
});
