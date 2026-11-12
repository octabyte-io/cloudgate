// The Hosted instance with both provider tokens. Set before the app module
// is imported: ConfigModule snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
const hosted = useHostedMode();
process.env.HETZNER_EUR_API_TOKEN = 'eur-token-for-the-fake';
process.env.HETZNER_USD_API_TOKEN = 'usd-token-for-the-fake';

import { format as formatDate } from 'date-fns';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { PAY_OPEN_INVOICE_FIRST_CODE } from '../../src/bought-servers/buy-plan-state';
import { App } from 'supertest/types';

import {
  boughtServer,
  boughtServerLine,
} from '../../src/bought-servers/bought-server.schema';
import { subscription } from '../../src/cloud/billing/billing.schema';
import { LapseClockService } from '../../src/cloud/billing/lapse-clock.service';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';
import { MailService } from '../../src/mail/mail.service';
import { organization } from '../../src/organizations/organizations.schema';
import { server } from '../../src/servers/server.schema';
import { sshKey } from '../../src/ssh-keys/ssh-key.schema';
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

/**
 * Bought Servers deleted on a suspension or a lapse (#1398, ADR-0071): an
 * Operator's suspension deletes the Organization's own Bought Servers 7
 * days later unless it is lifted, and paying never lifts it; the Paying
 * Organization's suspension never reaches an Attached Organization. Every
 * lapse deletes them at the moment it is recorded, and a cancel's known
 * date is warned of 7 days before. The provider is the in-memory fake;
 * Stripe is `fakeStripe`, its webhook driven through `constructEvent`.
 */
describe('Bought Servers deleted on a suspension or a lapse (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  let staffCookie: string;
  let clock: LapseClockService;
  const mail = new MailRecorder();

  /** What Stripe says each subscription's status is now. */
  let status: Stripe.Subscription.Status = 'active';
  /** The subscription items Stripe carries now. */
  let carried: string[] = [];

  const subscriptionNow = (organizationId: string): Stripe.Subscription =>
    ({
      id: `sub_${organizationId}`,
      object: 'subscription',
      status,
      customer: `cus_${organizationId}`,
      metadata: {},
      pending_update: null,
      cancellation_details: { reason: 'cancellation_requested' },
      items: {
        data: [
          {
            id: 'si_plan',
            price: { id: hosted.BUSINESS_PLAN_PRICE_ID },
            quantity: 1,
          },
          ...carried
            .filter((id) => id !== 'si_plan')
            .map((id) => ({ id, price: { id: `price_${id}` }, quantity: 1 })),
        ],
      },
    }) as unknown as Stripe.Subscription;

  const retrieveSubscription = jest.fn((id: string) =>
    Promise.resolve(subscriptionNow(id.replace(/^sub_/, ''))),
  );
  const updateSubscription = jest.fn(
    (id: string, params: Stripe.SubscriptionUpdateParams) => {
      const gone = (params.items ?? [])
        .filter((item) => item.deleted)
        .map((item) => item.id);
      carried = carried.filter((item) => !gone.includes(item));
      return Promise.resolve(subscriptionNow(id.replace(/^sub_/, '')));
    },
  );
  const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();
  const stripe: StripeApi = fakeStripe({
    retrieveSubscription,
    updateSubscription,
    constructEvent,
  });

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        { provide: STRIPE_API, useValue: stripe },
      ],
    });
    http = ctx.app.getHttpServer() as App;
    clock = ctx.app.get(LapseClockService);
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    mail.clear();
    status = 'active';
    carried = ['si_plan'];
    await openHostedSignUp(ctx.db);
    staffCookie = await signIn(HOSTED_STAFF.email, HOSTED_STAFF.password);
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, 'business');
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

  /** Ada's Organization, attached to Hopper Labs (ADR-0059). */
  async function givenAttached(): Promise<HostedCustomer> {
    const ada = await signUpHostedCustomer(http, mail, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'super-secret-password',
      organizationName: 'Lovelace Ltd',
    });
    await ctx.db
      .update(organization)
      .set({ paidByOrganizationId: owner.organizationId })
      .where(eq(organization.id, ada.organizationId));
    return ada;
  }

  /**
   * A Ready Bought Server as Buy and the stages leave it: its machine at the
   * fake provider, its `server` row, and its line on the Paying
   * Organization's subscription.
   */
  async function givenBoughtServer(
    organizationId: string,
    id: string,
    name: string,
  ): Promise<void> {
    const created = await ctx.hetzner.machines.createServer({
      name: `cloudgate-${id}`,
      serverType: 'cpx22',
      location: 'hel1',
      image: 'ubuntu-24.04',
      sshPublicKey: 'ssh-ed25519 AAAA bought',
      labels: {
        'cloudgate-organization': organizationId,
        'cloudgate-server': id,
      },
    });
    if (!created.ok) throw new Error(created.message);
    const machine = created.value.server;
    const [key] = await ctx.db
      .insert(sshKey)
      .values({
        name: `${name} (bought)`,
        publicKey: 'ssh-ed25519 AAAA bought',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
        organizationId,
      })
      .returning();
    await ctx.db.insert(server).values({
      serverId: id,
      name,
      ipAddress: machine.ipv4!,
      port: 22,
      username: 'root',
      sshKeyId: key.sshKeyId,
      organizationId,
    });
    await ctx.db.insert(boughtServer).values({
      id,
      organizationId,
      serverId: id,
      name,
      stage: 'ready',
      serverType: 'cpx22',
      location: 'hel1',
      backups: false,
      sshKeyId: key.sshKeyId,
      providerServerId: machine.id,
      providerPrimaryIpv4Id: machine.primaryIpv4Id,
      providerPrimaryIpv6Id: machine.primaryIpv6Id,
      createTries: 1,
      purchasePaidAt: new Date(),
      termsAcceptedBy: owner.id,
      termsAcceptedAt: new Date(),
    });
    await ctx.db.insert(boughtServerLine).values({
      boughtServerId: id,
      kind: 'server',
      stripePriceId: `price_si_${id}`,
      stripeSubscriptionItemId: `si_${id}`,
      monthlyCents: 2500,
    });
    carried.push(`si_${id}`);
  }

  function postWebhook(type: string, object: unknown) {
    const event = { type, data: { object } } as unknown as Stripe.Event;
    constructEvent.mockReturnValue(event);
    return request(http)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(200);
  }

  const suspend = (organizationId = owner.organizationId) =>
    request(http)
      .post(`/operator/organizations/${organizationId}/suspension`)
      .set('Cookie', staffCookie)
      .send({ reason: 'Abuse report left unanswered' })
      .expect(200);

  const lift = (organizationId = owner.organizationId) =>
    request(http)
      .delete(`/operator/organizations/${organizationId}/suspension`)
      .set('Cookie', staffCookie)
      .expect(204);

  async function marksOf(organizationId: string) {
    const [row] = await ctx.db
      .select()
      .from(subscription)
      .where(eq(subscription.organizationId, organizationId));
    return row;
  }

  async function stageOf(id: string) {
    const [row] = await ctx.db
      .select({ stage: boughtServer.stage })
      .from(boughtServer)
      .where(eq(boughtServer.id, id));
    return row?.stage;
  }

  const after = (from: Date, days: number) =>
    new Date(from.getTime() + days * DAY);

  const subjects = (address: string) =>
    mail.to(address).map((sent) => sent.email.subject);

  const bodyOf = (address: string, subject: RegExp) => {
    const sent = mail
      .to(address)
      .find((one) => subject.test(one.email.subject));
    return (
      sent?.email.html.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'") ?? ''
    );
  };

  const deletesOnListed = async (cookie = owner.cookie) => {
    const res = await request(http)
      .get('/servers')
      .set('Cookie', cookie)
      .expect(200);
    return (
      res.body as Array<{ boughtServer: { deletesOn: string | null } | null }>
    ).map((one) => one.boughtServer?.deletesOn ?? null);
  };

  describe('a suspension', () => {
    it('emails the date, reminds a day before, then deletes 7 days on; paying never lifts it', async () => {
      await givenBoughtServer(
        owner.organizationId,
        'bought0000000001',
        'web-1',
      );

      await suspend();
      const suspendedAt = (await marksOf(owner.organizationId)).suspendedAt!;
      const deletesOn = after(suspendedAt, 7);

      expect(subjects('grace@example.com')).toContain(
        `Your Servers for Hopper Labs will be deleted on ${format(deletesOn)} unless the suspension is lifted`,
      );
      expect(
        bodyOf('grace@example.com', /unless the suspension is lifted/),
      ).toContain('web-1');
      expect(await deletesOnListed()).toEqual([deletesOn.toISOString()]);

      // Paying again (the plan active at Stripe) never lifts it.
      await postWebhook('customer.subscription.updated', {
        ...subscriptionNow(owner.organizationId),
        status: 'active',
      });
      expect((await marksOf(owner.organizationId)).suspendedAt).not.toBeNull();

      mail.clear();
      expect(await clock.tick(after(suspendedAt, 5.9))).toMatchObject({
        boughtServersReminded: [],
        boughtServersDeleted: [],
      });
      expect(await clock.tick(after(suspendedAt, 6))).toMatchObject({
        boughtServersReminded: [owner.organizationId],
      });
      expect(bodyOf('grace@example.com', /in a day/)).toContain(
        'Hopper Labs is still suspended',
      );

      mail.clear();
      expect(await clock.tick(after(suspendedAt, 7))).toMatchObject({
        boughtServersDeleted: [owner.organizationId],
      });
      expect(await stageOf('bought0000000001')).toBe('deleted');
      expect(ctx.hetzner.machines.servers()).toEqual([]);
      expect(bodyOf('grace@example.com', /were deleted/)).toContain(
        'Hopper Labs stayed suspended',
      );
    });

    it('stops when the suspension is lifted', async () => {
      await givenBoughtServer(
        owner.organizationId,
        'bought0000000001',
        'web-1',
      );
      await suspend();
      const suspendedAt = (await marksOf(owner.organizationId)).suspendedAt!;

      await lift();

      expect(await deletesOnListed()).toEqual([null]);
      expect(await clock.tick(after(suspendedAt, 6))).toMatchObject({
        boughtServersReminded: [],
      });
      expect(await clock.tick(after(suspendedAt, 7))).toMatchObject({
        boughtServersDeleted: [],
      });
      expect(await stageOf('bought0000000001')).toBe('ready');
      expect(ctx.hetzner.machines.servers()).toHaveLength(1);
    });

    it("never reaches an Attached Organization: only its Paying Organization's own are deleted", async () => {
      const ada = await givenAttached();
      await givenBoughtServer(
        owner.organizationId,
        'bought0000000001',
        'web-1',
      );
      await givenBoughtServer(ada.organizationId, 'bought0000000002', 'ada-1');
      mail.clear();

      await suspend(owner.organizationId);
      const suspendedAt = (await marksOf(owner.organizationId)).suspendedAt!;

      expect(subjects('ada@example.com')).toEqual([]);
      expect(await deletesOnListed(ada.cookie)).toEqual([null]);

      await clock.tick(after(suspendedAt, 6));
      const ticked = await clock.tick(after(suspendedAt, 7));
      expect(ticked.boughtServersDeleted).toEqual([owner.organizationId]);
      expect(await stageOf('bought0000000001')).toBe('deleted');
      expect(await stageOf('bought0000000002')).toBe('ready');
      expect(subjects('ada@example.com')).toEqual([]);
    });

    it('of an Attached Organization starts its own clock', async () => {
      const ada = await givenAttached();
      await givenBoughtServer(ada.organizationId, 'bought0000000002', 'ada-1');

      await suspend(ada.organizationId);
      const suspendedAt = (await marksOf(ada.organizationId)).suspendedAt!;

      expect(await deletesOnListed(ada.cookie)).toEqual([
        after(suspendedAt, 7).toISOString(),
      ]);
      await clock.tick(after(suspendedAt, 6));
      await clock.tick(after(suspendedAt, 7));
      expect(await stageOf('bought0000000002')).toBe('deleted');
    });
  });

  describe('a lapse', () => {
    it.each([
      [
        'a cancel reaching its date',
        () =>
          postWebhook('customer.subscription.deleted', {
            ...subscriptionNow(owner.organizationId),
            status: 'canceled',
          }),
      ],
      [
        'Stripe giving up on a payment',
        () =>
          postWebhook('customer.subscription.deleted', {
            ...subscriptionNow(owner.organizationId),
            status: 'canceled',
            cancellation_details: { reason: 'payment_failed' },
          }),
      ],
      [
        'the Stripe customer deleted',
        () =>
          postWebhook('customer.deleted', {
            id: `cus_${owner.organizationId}`,
            object: 'customer',
          }),
      ],
    ])(
      "deletes them at once on %s, its Attached Organizations' too",
      async (_cause, lapses) => {
        const ada = await givenAttached();
        await givenBoughtServer(
          owner.organizationId,
          'bought0000000001',
          'web-1',
        );
        await givenBoughtServer(
          ada.organizationId,
          'bought0000000002',
          'ada-1',
        );
        mail.clear();
        status = 'canceled';

        await lapses();

        expect((await marksOf(owner.organizationId)).lapsedAt).not.toBeNull();
        expect(await stageOf('bought0000000001')).toBe('deleted');
        expect(await stageOf('bought0000000002')).toBe('deleted');
        expect(ctx.hetzner.machines.servers()).toEqual([]);
        expect(bodyOf('grace@example.com', /were deleted/)).toContain(
          "Hopper Labs's plan ended",
        );
        expect(bodyOf('ada@example.com', /were deleted/)).toContain('ada-1');

        // The daily tick finds nothing left to do.
        mail.clear();
        const ticked = await clock.tick(new Date());
        expect(ticked.boughtServersDeleted).toEqual([]);
        expect(
          subjects('grace@example.com').filter((one) => /Servers/.test(one)),
        ).toEqual([]);
      },
    );

    it('deletes them at once when an Operator switches Enterprise off', async () => {
      await ctx.db
        .update(subscription)
        .set({
          enterprise: true,
          enterpriseServers: 5,
          enterpriseCloudEnvironments: 5,
          plan: null,
          stripeSubscriptionId: null,
          status: null,
        })
        .where(eq(subscription.organizationId, owner.organizationId));
      await givenBoughtServer(
        owner.organizationId,
        'bought0000000001',
        'web-1',
      );

      await request(http)
        .put(`/operator/organizations/${owner.organizationId}/enterprise`)
        .set('Cookie', staffCookie)
        .send({ enterprise: false })
        .expect(200);

      expect(await stageOf('bought0000000001')).toBe('deleted');
      expect(subjects('grace@example.com')).toContain(
        'Your Servers for Hopper Labs were deleted',
      );
    });

    it("deletes an Attached Organization's at once when its Paying Organization stops paying, taking their lines off the payer's subscription", async () => {
      const ada = await givenAttached();
      await givenBoughtServer(ada.organizationId, 'bought0000000002', 'ada-1');

      const card = await request(http)
        .get('/billing/attached-organizations')
        .set('Cookie', owner.cookie)
        .expect(200);
      expect(
        (card.body as { organizations: Array<{ boughtServers: number }> })
          .organizations,
      ).toEqual([expect.objectContaining({ boughtServers: 1 })]);

      mail.clear();
      await request(http)
        .post(
          `/billing/attached-organizations/${ada.organizationId}/stop-paying`,
        )
        .set('Cookie', owner.cookie)
        .expect(200);

      expect(await stageOf('bought0000000002')).toBe('deleted');
      expect(updateSubscription).toHaveBeenCalledWith(
        `sub_${owner.organizationId}`,
        expect.objectContaining({
          items: [{ id: 'si_bought0000000002', deleted: true }],
        }),
      );
      expect(carried).toEqual(['si_plan']);
      expect(bodyOf('ada@example.com', /were deleted/)).toContain(
        "Lovelace Ltd's plan ended",
      );
    });
  });

  describe('a cancel', () => {
    it('warns 7 days before its date, once', async () => {
      await givenBoughtServer(
        owner.organizationId,
        'bought0000000001',
        'web-1',
      );
      const cancelAt = after(new Date(), 30);
      await ctx.db
        .update(subscription)
        .set({ cancelAt })
        .where(eq(subscription.organizationId, owner.organizationId));

      expect(await clock.tick(after(cancelAt, -7.1))).toMatchObject({
        boughtServersCancelWarned: [],
      });
      expect(await clock.tick(after(cancelAt, -7))).toMatchObject({
        boughtServersCancelWarned: [owner.organizationId],
      });
      expect(subjects('grace@example.com')).toEqual([
        `Your Servers for Hopper Labs will be deleted on ${format(cancelAt)}`,
      ]);
      expect(await clock.tick(after(cancelAt, -6))).toMatchObject({
        boughtServersCancelWarned: [],
      });
      expect(await stageOf('bought0000000001')).toBe('ready');
    });

    it('shows its date as the deletion date, and refuses anything that costs more, from the moment it is set', async () => {
      await givenBoughtServer(
        owner.organizationId,
        'bought0000000001',
        'web-1',
      );
      const cancelAt = after(new Date(), 30);
      await ctx.db
        .update(subscription)
        .set({ cancelAt })
        .where(eq(subscription.organizationId, owner.organizationId));

      expect(await deletesOnListed()).toEqual([cancelAt.toISOString()]);
      const bought = await request(http)
        .post('/bought-servers')
        .set('Cookie', owner.cookie)
        .send({
          serverType: 'cpx22',
          location: 'hel1',
          name: 'web-2',
          termsAccepted: true,
          prorationDate: Math.floor(Date.now() / 1000),
        });
      expect(bought.status).toBe(409);
      expect((bought.body as { code: string }).code).toBe(
        PAY_OPEN_INVOICE_FIRST_CODE,
      );
    });
  });
});

/** The emails' date format. */
const format = (at: Date) => formatDate(at, 'MMM dd, yyyy');
