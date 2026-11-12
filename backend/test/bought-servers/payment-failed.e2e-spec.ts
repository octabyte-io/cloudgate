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

import { application } from '../../src/applications/application.schema';
import {
  boughtServer,
  boughtServerLine,
} from '../../src/bought-servers/bought-server.schema';
import { subscription } from '../../src/cloud/billing/billing.schema';
import { LapseClockService } from '../../src/cloud/billing/lapse-clock.service';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';
import { environment } from '../../src/environments/environment.schema';
import { MailService } from '../../src/mail/mail.service';
import { organization } from '../../src/organizations/organizations.schema';
import { project } from '../../src/projects/project.schema';
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
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const DAY = 24 * 60 * 60 * 1000;
const PAY_OPEN_INVOICE_FIRST = 'Pay the open invoice first';

/**
 * Bought Servers deleted 7 days after a failed payment (#1397, ADR-0071):
 * the webhook starts the clock and emails the date, the daily lapse job
 * reminds a day before and then deletes, keeping each `server` row as the
 * Deleted record with its Services listed, and paying the invoice first
 * cancels it. While a date is set, anything costlier is refused. The
 * provider is the in-memory fake; Stripe is `fakeStripe`, its webhook
 * driven through `constructEvent`.
 */
describe('Bought Servers deleted after a failed payment (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  let clock: LapseClockService;
  const mail = new MailRecorder();

  /** What Stripe says the subscription's status is now. */
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
      items: {
        data: carried.map((id) => ({ id, price: { id: `price_${id}` } })),
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
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, 'business');
    mail.clear();
  });

  /**
   * A Ready Bought Server as Buy and the stages leave it: its machine at the
   * fake provider, its `server` row, and its lines on the Paying
   * Organization's subscription.
   */
  async function givenBoughtServer(
    organizationId: string,
    id: string,
    name: string,
    options: { backups?: boolean } = {},
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
      backups: options.backups ?? false,
      sshKeyId: key.sshKeyId,
      providerServerId: machine.id,
      providerPrimaryIpv4Id: machine.primaryIpv4Id,
      providerPrimaryIpv6Id: machine.primaryIpv6Id,
      createTries: 1,
      purchasePaidAt: new Date(),
      termsAcceptedBy: owner.id,
      termsAcceptedAt: new Date(),
    });
    const lines = [
      { kind: 'server' as const, item: `si_${id}`, cents: 2500 },
      ...(options.backups
        ? [{ kind: 'backups' as const, item: `si_${id}_backups`, cents: 500 }]
        : []),
    ];
    await ctx.db.insert(boughtServerLine).values(
      lines.map((line) => ({
        boughtServerId: id,
        kind: line.kind,
        stripePriceId: `price_${line.item}`,
        stripeSubscriptionItemId: line.item,
        monthlyCents: line.cents,
      })),
    );
    carried.push(...lines.map((line) => line.item));
  }

  /** An application on the Server: a Service its Deleted record still lists. */
  async function givenService(
    organizationId: string,
    serverId: string,
  ): Promise<string> {
    const [made] = await ctx.db
      .insert(project)
      .values({ name: 'Shop', organizationId })
      .returning();
    const [env] = await ctx.db
      .insert(environment)
      .values({ name: 'production', projectId: made.projectId })
      .returning();
    const [app] = await ctx.db
      .insert(application)
      .values({
        name: 'Web App',
        configName: 'web-app',
        environmentId: env.environmentId,
        serverId,
      })
      .returning();
    return app.applicationId;
  }

  /** An invoice of the Paying Organization's subscription, charging these prices. */
  const invoiceOf = (
    payingOrganizationId: string,
    prices: string[],
    id = 'in_renewal',
  ) => ({
    id,
    object: 'invoice',
    number: 'INV-7',
    customer: `cus_${payingOrganizationId}`,
    parent: {
      subscription_details: { subscription: `sub_${payingOrganizationId}` },
    },
    amount_due: 3000,
    amount_paid: 0,
    currency: 'usd',
    created: 1_767_225_600,
    hosted_invoice_url: 'https://invoice.stripe.test/INV-7',
    invoice_pdf: null,
    lines: {
      data: prices.map((price) => ({
        pricing: { type: 'price_details', price_details: { price } },
      })),
    },
  });

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

  /** A renewal with these prices fails, and Stripe retries it. */
  async function renewalFails(payingOrganizationId: string, prices: string[]) {
    status = 'past_due';
    await postWebhook(
      'invoice.payment_failed',
      invoiceOf(payingOrganizationId, prices),
    );
  }

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

  /** The subjects an address received, oldest first. */
  const subjects = (address: string) =>
    mail.to(address).map((sent) => sent.email.subject);

  const bodyOf = (address: string, subject: RegExp) => {
    const sent = mail
      .to(address)
      .find((one) => subject.test(one.email.subject));
    return sent?.email.html.replace(/<!-- -->/g, '') ?? '';
  };

  /** `GET /servers` as the console reads it. */
  interface ListedServer {
    serverId: string;
    boughtServer: {
      stage: string;
      deletesOn: string | null;
      deletedAt: string | null;
    } | null;
  }

  const listServers = async (cookie = owner.cookie) => {
    const res = await request(http)
      .get('/servers')
      .set('Cookie', cookie)
      .expect(200);
    return { body: res.body as ListedServer[] };
  };

  describe('the clock', () => {
    it('emails the date, reminds a day before, then deletes and keeps the Deleted record with its Services', async () => {
      await givenBoughtServer(
        owner.organizationId,
        'bought0000000001',
        'web-1',
      );
      const applicationId = await givenService(
        owner.organizationId,
        'bought0000000001',
      );

      await renewalFails(owner.organizationId, [
        'price_si_plan',
        'price_si_bought0000000001',
      ]);
      // Stripe's retry fails again: the first moment stands, and no second email.
      await renewalFails(owner.organizationId, ['price_si_bought0000000001']);

      const marks = await marksOf(owner.organizationId);
      const failedAt = marks.boughtServersPaymentFailedAt!;
      expect(failedAt).toBeInstanceOf(Date);
      expect(marks.boughtServersFailedInvoiceId).toBe('in_renewal');
      const deletesOn = after(failedAt, 7);
      const started = subjects('grace@example.com').filter((one) =>
        /unless you pay/.test(one),
      );
      expect(started).toHaveLength(1);
      const startBody = bodyOf('grace@example.com', /unless you pay/);
      expect(startBody).toContain('web-1');
      expect(startBody).toMatch(/its data and its backups go with it/);

      // The Server page's red bar, while it keeps working.
      const listed = await listServers();
      expect(
        listed.body.map((one) => [one.serverId, one.boughtServer]),
      ).toEqual([
        [
          'bought0000000001',
          {
            stage: 'ready',
            poweredOff: null,
            deletesOn: deletesOn.toISOString(),
            deletedAt: null,
          },
        ],
      ]);

      mail.clear();
      expect(await clock.tick(after(failedAt, 5.9))).toMatchObject({
        boughtServersReminded: [],
        boughtServersDeleted: [],
      });
      expect(await clock.tick(after(failedAt, 6))).toMatchObject({
        boughtServersReminded: [owner.organizationId],
        boughtServersDeleted: [],
      });
      expect(subjects('grace@example.com')).toEqual([
        'Your Servers for Hopper Labs will be deleted in a day',
      ]);
      expect(await stageOf('bought0000000001')).toBe('ready');

      mail.clear();
      expect(await clock.tick(after(failedAt, 7))).toMatchObject({
        boughtServersReminded: [],
        boughtServersDeleted: [owner.organizationId],
      });
      expect(await stageOf('bought0000000001')).toBe('deleted');
      expect(ctx.hetzner.machines.servers()).toEqual([]);
      // Deleted for not paying: its line leaves with no credit for the month.
      expect(updateSubscription).toHaveBeenCalledWith(
        `sub_${owner.organizationId}`,
        {
          items: [{ id: 'si_bought0000000001', deleted: true }],
          proration_behavior: 'none',
        },
      );
      expect(subjects('grace@example.com')).toEqual([
        'Your Servers for Hopper Labs were deleted',
      ]);
      expect(bodyOf('grace@example.com', /were deleted/)).toContain('web-1');

      // A later tick deletes and emails nothing more.
      mail.clear();
      expect(await clock.tick(after(failedAt, 8))).toMatchObject({
        boughtServersReminded: [],
        boughtServersDeleted: [],
      });
      expect(mail.sent).toEqual([]);

      // The record stays, marked Deleted, with its Service still on it.
      const kept = await listServers();
      expect(kept.body.map((one) => one.serverId)).toEqual([
        'bought0000000001',
      ]);
      expect(kept.body[0].boughtServer).toMatchObject({
        stage: 'deleted',
        deletesOn: null,
      });
      expect(typeof kept.body[0].boughtServer?.deletedAt).toBe('string');
      const [still] = await ctx.db
        .select({ serverId: application.serverId })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      expect(still.serverId).toBe('bought0000000001');

      // Deleting the record afterwards keeps the Services rule, and calls no provider.
      ctx.hetzner.machines.calls.length = 0;
      await request(http)
        .delete('/servers/bought0000000001')
        .set('Cookie', owner.cookie)
        .expect(409);
      await ctx.db
        .delete(application)
        .where(eq(application.applicationId, applicationId));
      await request(http)
        .delete('/servers/bought0000000001')
        .set('Cookie', owner.cookie)
        .expect(200);
      expect(ctx.hetzner.machines.calls).toEqual([]);
      expect((await listServers()).body).toEqual([]);
    });

    it('is cancelled by paying the invoice before the date', async () => {
      await givenBoughtServer(
        owner.organizationId,
        'bought0000000001',
        'web-1',
      );
      await renewalFails(owner.organizationId, ['price_si_bought0000000001']);
      const failedAt = (await marksOf(owner.organizationId))
        .boughtServersPaymentFailedAt!;

      await clock.tick(after(failedAt, 6));
      status = 'active';
      await postWebhook('invoice.payment_succeeded', {
        ...invoiceOf(owner.organizationId, ['price_si_bought0000000001']),
        status: 'paid',
        amount_paid: 3000,
      });

      expect(await marksOf(owner.organizationId)).toMatchObject({
        boughtServersPaymentFailedAt: null,
        boughtServersFailedInvoiceId: null,
      });
      mail.clear();
      expect(await clock.tick(after(failedAt, 7))).toMatchObject({
        boughtServersDeleted: [],
      });
      expect(await clock.tick(after(failedAt, 30))).toMatchObject({
        boughtServersReminded: [],
        boughtServersDeleted: [],
      });
      expect(await stageOf('bought0000000001')).toBe('ready');
      expect(ctx.hetzner.machines.servers()).toHaveLength(1);
      expect(mail.sent).toEqual([]);
      const listed = await listServers();
      expect(listed.body[0].boughtServer).toMatchObject({ deletesOn: null });
    });

    it('is not started by an invoice with no Bought Server line, nor by a failed payment the subscription stays active through', async () => {
      await givenBoughtServer(
        owner.organizationId,
        'bought0000000001',
        'web-1',
      );

      await renewalFails(owner.organizationId, ['price_si_plan']);
      status = 'active';
      await postWebhook(
        'invoice.payment_failed',
        invoiceOf(owner.organizationId, ['price_si_bought0000000001'], 'in_x'),
      );

      expect(
        (await marksOf(owner.organizationId)).boughtServersPaymentFailedAt,
      ).toBeNull();
      expect(
        subjects('grace@example.com').filter((one) =>
          /unless you pay/.test(one),
        ),
      ).toEqual([]);
    });
  });

  describe('while a deletion date is set', () => {
    beforeEach(async () => {
      await givenBoughtServer(
        owner.organizationId,
        'bought0000000001',
        'web-1',
        { backups: true },
      );
      await givenBoughtServer(owner.organizationId, 'bought0000000002', 'db-1');
      // The open invoice's failure, with Stripe's own status back to active,
      // so only the deletion date can refuse.
      await ctx.db
        .update(subscription)
        .set({
          boughtServersPaymentFailedAt: new Date(),
          boughtServersFailedInvoiceId: 'in_renewal',
        })
        .where(eq(subscription.organizationId, owner.organizationId));
    });

    it('refuses buying another Server', async () => {
      const res = await request(http)
        .post('/bought-servers')
        .set('Cookie', owner.cookie)
        .send({
          serverType: 'cpx22',
          location: 'hel1',
          name: 'web-2',
          termsAccepted: true,
          prorationDate: Math.floor(Date.now() / 1000),
        });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'PAY_OPEN_INVOICE_FIRST',
        message: PAY_OPEN_INVOICE_FIRST,
      });
    });

    it('refuses turning backups on, and charges nothing', async () => {
      const res = await request(http)
        .put('/bought-servers/bought0000000002/backups')
        .set('Cookie', owner.cookie)
        .send({ enabled: true });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'PAY_OPEN_INVOICE_FIRST',
        message: PAY_OPEN_INVOICE_FIRST,
      });
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(await stageOf('bought0000000002')).toBe('ready');
    });

    it('still allows turning backups off', async () => {
      const res = await request(http)
        .put('/bought-servers/bought0000000001/backups')
        .set('Cookie', owner.cookie)
        .send({ enabled: false });

      expect(res.status).toBe(200);
      const [row] = await ctx.db
        .select({ backups: boughtServer.backups })
        .from(boughtServer)
        .where(eq(boughtServer.id, 'bought0000000001'));
      expect(row.backups).toBe(false);
    });
  });

  describe('an Attached Organization', () => {
    it("is on its Paying Organization's clock, and its Bought Servers are deleted too", async () => {
      const attached = await signUpHostedCustomer(http, mail, {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'super-secret-password',
        organizationName: 'Lovelace Ltd',
      });
      await ctx.db
        .update(organization)
        .set({ paidByOrganizationId: owner.organizationId })
        .where(eq(organization.id, attached.organizationId));
      await givenBoughtServer(
        owner.organizationId,
        'bought0000000001',
        'web-1',
      );
      await givenBoughtServer(
        attached.organizationId,
        'bought0000000002',
        'ada-1',
      );
      mail.clear();

      await renewalFails(owner.organizationId, ['price_si_bought0000000002']);
      const failedAt = (await marksOf(owner.organizationId))
        .boughtServersPaymentFailedAt!;

      expect(bodyOf('ada@example.com', /unless you pay/)).toContain('ada-1');
      expect(bodyOf('grace@example.com', /unless you pay/)).toContain('web-1');
      const listed = await listServers(attached.cookie);
      expect(listed.body[0].boughtServer).toMatchObject({
        stage: 'ready',
        deletesOn: after(failedAt, 7).toISOString(),
      });

      await clock.tick(after(failedAt, 6));
      const ticked = await clock.tick(after(failedAt, 7));
      expect([...ticked.boughtServersDeleted].sort()).toEqual(
        [owner.organizationId, attached.organizationId].sort(),
      );
      expect(await stageOf('bought0000000001')).toBe('deleted');
      expect(await stageOf('bought0000000002')).toBe('deleted');
      expect(subjects('ada@example.com')).toContain(
        'Your Servers for Lovelace Ltd were deleted',
      );
    });
  });
});
