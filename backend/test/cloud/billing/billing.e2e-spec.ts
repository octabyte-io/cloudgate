import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';
import { BillingConfig } from '../../../src/cloud/billing/billing.config';
import { PLAN_NAMES } from '../../../src/cloud/billing/billing.plans';
import type {
  PlanName,
  StripePriceCatalogue,
} from '../../../src/cloud/billing/billing.plans';
import { BillingService } from '../../../src/cloud/billing/billing.service';
import { subscription } from '../../../src/cloud/billing/billing.schema';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { FETCH_CLIENT } from '../../../src/git-providers/fetch.provider';
import { InstanceMode } from '../../../src/instance-mode/instance-mode.service';
import { MailService } from '../../../src/mail/mail.service';
import type { PermissionCtx } from '../../../src/rbac/permission.service';
import { server as serverTable } from '../../../src/servers/server.schema';
import { ServersService } from '../../../src/servers/servers.service';
import { SshKeysService } from '../../../src/ssh-keys/ssh-keys.service';
import type { DrizzleDB } from '../../../src/db/drizzle.module';
import { fakeStripe } from '../../utils/fake-stripe';
import { useHostedMode } from '../../utils/hosted-mode';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../../utils/test-app';

jest.setTimeout(120_000);

// Set before AppModule is imported, because ConfigModule.forRoot({ validate })
// snapshots the environment on first import. The Hosted instance's three
// prices are useHostedMode's: STARTER_PLAN_PRICE_ID=price_starter_plan,
// BUSINESS_PLAN_PRICE_ID=price_business_plan and ADD_ON_PRICE_ID=price_add_on.
process.env.SITE_URL = 'https://cloud.cloudgate.test';
const hosted = useHostedMode();
const STARTER_PRICE = hosted.STARTER_PLAN_PRICE_ID;
const BUSINESS_PRICE = hosted.BUSINESS_PLAN_PRICE_ID;
const ADD_ON_PRICE = hosted.ADD_ON_PRICE_ID;
const PLAN_PRICES: Record<PlanName, string> = {
  starter: STARTER_PRICE,
  business: BUSINESS_PRICE,
};

// Stripe, mocked at its port for every test in this file. Each call is a
// standalone const so assertions never reference an unbound method.
const retrievePrice = jest.fn<Promise<Stripe.Price>, [string]>();
const retrieveSubscription = jest.fn<Promise<Stripe.Subscription>, [string]>();
const retrieveCustomer = jest.fn<
  Promise<Stripe.Customer | Stripe.DeletedCustomer>,
  [string]
>();
const createCheckoutSession = jest.fn<
  Promise<Stripe.Checkout.Session>,
  [Stripe.Checkout.SessionCreateParams]
>();
const createBillingPortalSession = jest.fn<
  Promise<Stripe.BillingPortal.Session>,
  [Stripe.BillingPortal.SessionCreateParams]
>();
const listBillingPortalConfigurations = jest.fn<
  Promise<Stripe.BillingPortal.Configuration[]>,
  []
>();
const createBillingPortalConfiguration = jest.fn<
  Promise<Stripe.BillingPortal.Configuration>,
  [Stripe.BillingPortal.ConfigurationCreateParams]
>();
const updateSubscription = jest.fn<
  Promise<Stripe.Subscription>,
  [string, Stripe.SubscriptionUpdateParams]
>();
const listInvoices = jest.fn<Promise<Stripe.Invoice[]>, [string]>();
const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();

// Transactional mail and the PDF download are the other two boundaries this
// slice crosses.
const sendMail = jest.fn<
  Promise<void>,
  [string, { subject: string; html: string }, unknown?]
>();
const fetchClient = jest.fn<Promise<Response>, [unknown]>();

const stripe = fakeStripe({
  retrievePrice,
  retrieveSubscription,
  retrieveCustomer,
  createCheckoutSession,
  createBillingPortalSession,
  listBillingPortalConfigurations,
  createBillingPortalConfiguration,
  updateSubscription,
  listInvoices,
  constructEvent,
});

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const CHOOSE_A_PLAN =
  'Choose a plan to add a Server. Starter and Business each include 3 Servers and 3 Cloud Environments; choose one under Settings > Billing.';

const allowanceFull = (servers: number) =>
  `This Organization has ${servers} Servers, all its plan allows. Buy an Add-on for one more Server and one more Cloud Environment under Settings > Billing.`;

/**
 * A customer of the Hosted instance, signed in: sign-up opens once the
 * Instance organization exists, and a sign-up signs in only once its
 * email is confirmed. The confirmation goes through `sendMail` like
 * any other email, so it is caught here and forgotten before the test runs.
 */
async function signUp(
  server: App,
  db: DrizzleDB,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  await openHostedSignUp(db);
  const recorder = new MailRecorder();
  sendMail.mockImplementation((to, email) => recorder.send(to, email));
  const customer = await signUpHostedCustomer(server, recorder, {
    ...body,
    organizationName: 'Hopper Labs',
  });
  sendMail.mockReset();
  return { cookie: customer.cookie, id: customer.id };
}

async function activeOrganizationId(
  server: App,
  cookie: string,
): Promise<string> {
  const res = await request(server)
    .get('/organizations/active')
    .set('Cookie', cookie);
  expect(res.status).toBe(200);
  return (res.body as { id: string }).id;
}

const ctxFor = (userId: string, organizationId: string): PermissionCtx => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/** A Stripe checkout session, of which only the id is ever read. */
const checkoutUrl = (id: string) =>
  `https://checkout.stripe.com/c/pay/${id}#fidkdWxOYHwnPyd1blpxYHZxWjA0`;

const checkoutSession = (id: string) =>
  ({ id, url: checkoutUrl(id) }) as unknown as Stripe.Checkout.Session;

const stripeSubscription = ({
  id = 'sub_1',
  customer = 'cus_1',
  status = 'active',
  items,
}: {
  id?: string;
  customer?: string;
  status?: string;
  items: Array<{ id?: string; price: string; quantity: number }>;
}) =>
  ({
    id,
    customer,
    status,
    items: {
      data: items.map(({ id: itemId, price, quantity }) => ({
        id: itemId,
        price: { id: price },
        quantity,
      })),
    },
  }) as unknown as Stripe.Subscription;

/** A plan, Starter unless named, with `addOns` Add-ons, as Stripe sends it. */
const planSubscription = (
  addOns: number,
  status = 'active',
  plan: PlanName = 'starter',
) =>
  stripeSubscription({
    status,
    items: [
      { id: 'si_plan', price: PLAN_PRICES[plan], quantity: 1 },
      ...(addOns > 0
        ? [{ id: 'si_add_on', price: ADD_ON_PRICE, quantity: addOns }]
        : []),
    ],
  });

/**
 * A paid invoice for `sub_1`. The subscription reference sits under `parent`,
 * where Stripe's current API puts it.
 */
const paidInvoice = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'in_1',
    number: 'INV-77',
    customer: 'cus_1',
    currency: 'usd',
    amount_paid: 1500,
    amount_due: 1500,
    created: 1_767_225_600,
    hosted_invoice_url: 'https://invoice.stripe.test/INV-77',
    invoice_pdf: 'https://invoice.stripe.test/INV-77.pdf',
    parent: { subscription_details: { subscription: 'sub_1' } },
    ...overrides,
  }) as unknown as Stripe.Invoice;

/** What fetching `invoice_pdf` returns. */
const pdfResponse = (body: string) =>
  ({
    ok: true,
    arrayBuffer: () => Promise.resolve(Buffer.from(body)),
  }) as unknown as Response;

const stripePrice = (id: string, name: string, unitAmount: number) =>
  ({
    id,
    unit_amount: unitAmount,
    currency: 'usd',
    recurring: { interval: 'month' },
    product: { id: `prod_${id}`, name },
  }) as unknown as Stripe.Price;

const stripeEvent = (type: string, object: unknown) =>
  ({ type, data: { object } }) as unknown as Stripe.Event;

const liveCustomer = (id: string) =>
  ({ id, deleted: undefined }) as unknown as Stripe.Customer;

const deletedCustomer = (id: string) =>
  ({ id, deleted: true }) as unknown as Stripe.DeletedCustomer;

describe('Stripe billing: the Hosted plan and Add-ons (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  /** An organization with its owner signed up, and that owner's ctx. */
  async function setUpOwner() {
    const session = await signUp(server, ctx.db, owner);
    const organizationId = await activeOrganizationId(server, session.cookie);
    return {
      organizationId,
      session,
      ctx: ctxFor(session.id, organizationId),
    };
  }

  /**
   * The same, plus one other user who actually accepted an invitation —
   * signing up with a token alone creates no member row.
   */
  async function setUpOrgWithMember() {
    const owned = await setUpOwner();

    const invite = await request(server)
      .post('/organizations/invitations')
      .set('Cookie', owned.session.cookie)
      .send({ email: 'invitee@example.com', role: 'member' });
    expect(invite.status).toBe(201);
    const inviteId = (invite.body as { id: string }).id;

    const su = await request(server)
      .post('/api/auth/sign-up/email')
      .set('x-cloudgate-token', inviteId)
      .send({
        name: 'Ida Rhodes',
        email: 'invitee@example.com',
        password: 'super-secret-password',
      });
    const inviteeCookie = su.headers['set-cookie'];
    const inviteeId = (su.body as { user: { id: string } }).user.id;

    const accept = await request(server)
      .post(`/organizations/invitations/${inviteId}/accept`)
      .set('Cookie', inviteeCookie);
    expect(accept.status).toBe(201);

    return { ...owned, invitee: { cookie: inviteeCookie, id: inviteeId } };
  }

  /**
   * Arrangement only: a subscription row in a given state. The rows themselves
   * are written by the webhook, which is a separate seam.
   */
  async function givenSubscriptionRow(
    organizationId: string,
    values: Partial<typeof subscription.$inferInsert> = {},
  ) {
    await ctx.db
      .insert(subscription)
      .values({ organizationId, ...values })
      .onConflictDoUpdate({
        target: subscription.organizationId,
        set: values,
      });
  }

  /** Arrangement only: a paid plan, Starter unless named, with `addOns` Add-ons. */
  function givenPlan(
    organizationId: string,
    addOns: number,
    status = 'active',
    plan: PlanName = 'starter',
  ) {
    return givenSubscriptionRow(organizationId, {
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      plan,
      status,
      addOns,
    });
  }

  /** Arrangement only: `count` active Servers, inserted directly. */
  async function givenServers(organizationId: string, count: number) {
    await ctx.db.insert(serverTable).values(
      Array.from({ length: count }, (_, index) => ({
        name: `server-${index + 1}`,
        ipAddress: `203.0.113.${index + 1}`,
        port: 22,
        organizationId,
        createdAt: `2026-01-0${(index % 9) + 1}T00:00:00.000Z`,
      })),
    );
  }

  /** Every Server's status, read back through the servers interface. */
  async function serverStatuses(ownerCtx: PermissionCtx): Promise<string[]> {
    const servers = await ctx.app.get(ServersService).list(ownerCtx);
    return servers.map((row) => row.serverStatus);
  }

  /** POST /servers, as the console sends it, with a fresh SSH key. */
  async function addServer(ownerCtx: PermissionCtx, cookie: string) {
    const key = await ctx.app
      .get(SshKeysService)
      .create(ownerCtx, { name: `key-${Date.now()}-${Math.random()}` });
    return request(server).post('/servers').set('Cookie', cookie).send({
      name: 'new-server',
      ipAddress: '203.0.113.200',
      port: 22,
      username: 'root',
      sshKeyId: key.sshKeyId,
    });
  }

  /**
   * The account's active portal configurations; a new one Cloudgate makes is
   * `bpc_cloudgate`. The configuration is memoised per process, so it is
   * forgotten first.
   */
  function givenPortalConfigurations(
    existing: Array<{ id: string; metadata: Record<string, string> }>,
  ): void {
    const billing: { portalConfiguration?: Promise<string> } =
      ctx.app.get(BillingService);
    billing.portalConfiguration = undefined;
    listBillingPortalConfigurations.mockResolvedValue(
      existing as unknown as Stripe.BillingPortal.Configuration[],
    );
    createBillingPortalConfiguration.mockResolvedValue({
      id: 'bpc_cloudgate',
    } as unknown as Stripe.BillingPortal.Configuration);
  }

  function getBilling(cookie: string) {
    return request(server).get('/billing/subscription').set('Cookie', cookie);
  }

  /**
   * Posts an event Stripe has already verified. The signature check is a
   * separate case; here the port is told what the bytes decoded to.
   */
  function postWebhook(event: Stripe.Event) {
    constructEvent.mockReturnValue(event);
    return request(server)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event));
  }

  function checkout(cookie: string, body: object) {
    return request(server)
      .post('/billing/checkout')
      .set('Cookie', cookie)
      .send(body);
  }

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: STRIPE_API, useValue: stripe },
        { provide: MailService, useValue: { send: sendMail } },
        { provide: FETCH_CLIENT, useValue: fetchClient },
      ],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  /**
   * Turns the instance under test self-hosted for the rest of the test.
   * ConfigModule snapshotted the environment when AppModule was imported, so
   * the answer is flipped on the module the app consults. Restored by the
   * `restoreAllMocks` in beforeEach.
   */
  function givenSelfHostedInstance(): void {
    jest
      .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
      .mockReturnValue(false);
  }

  /**
   * An instance with some of its three prices unset (one left undefined, the
   * rest blank). The hosted boot check refuses to start that way, so only the
   * setting the app reads is changed.
   */
  function givenUnsetPrices(...which: Array<keyof StripePriceCatalogue>): void {
    const unset = (key: keyof StripePriceCatalogue, price: string) =>
      which.includes(key) ? (key === 'starterPriceId' ? undefined : '') : price;
    jest.spyOn(ctx.app.get(BillingConfig), 'prices', 'get').mockReturnValue({
      starterPriceId: unset('starterPriceId', STARTER_PRICE),
      businessPriceId: unset('businessPriceId', BUSINESS_PRICE),
      addOnPriceId: unset('addOnPriceId', ADD_ON_PRICE),
    });
  }

  beforeEach(async () => {
    await ctx.resetDb();
    jest.restoreAllMocks();
    jest.resetAllMocks();
  });

  describe('checkout', () => {
    it('creates a session with the Starter price and the Add-on quantity, and a fresh Organization’s free trial', async () => {
      const { session, organizationId } = await setUpOwner();
      createCheckoutSession.mockResolvedValue(checkoutSession('cs_test_123'));

      const res = await checkout(session.cookie, {
        plan: 'starter',
        addOns: 2,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'cs_test_123',
        url: checkoutUrl('cs_test_123'),
        addOns: 2,
      });
      expect(createCheckoutSession).toHaveBeenCalledTimes(1);
      expect(createCheckoutSession).toHaveBeenCalledWith({
        mode: 'subscription',
        line_items: [
          { price: STARTER_PRICE, quantity: 1 },
          { price: ADD_ON_PRICE, quantity: 2 },
        ],
        // No Stripe customer stored yet, so checkout collects one against the
        // organization owner's address.
        customer_email: owner.email,
        metadata: { organizationId },
        // A new Organization, and a person who has never had one: the 30-day
        // free trial, carrying their email key, never the address.
        subscription_data: {
          trial_period_days: 30,
          trial_settings: {
            end_behavior: { missing_payment_method: 'cancel' },
          },
          metadata: {
            organizationId,
            trialEmailKey: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
          },
        },
        payment_method_collection: 'always',
        billing_address_collection: 'required',
        tax_id_collection: { enabled: true },
        allow_promotion_codes: true,
        success_url:
          'https://cloud.cloudgate.test/settings/billing?checkout=success',
        cancel_url: 'https://cloud.cloudgate.test/settings/billing',
      });
    });

    it('creates a session with the Business price and the Add-on quantity', async () => {
      const { session } = await setUpOwner();
      createCheckoutSession.mockResolvedValue(checkoutSession('cs_business'));

      const res = await checkout(session.cookie, {
        plan: 'business',
        addOns: 1,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'cs_business',
        url: checkoutUrl('cs_business'),
        addOns: 1,
      });
      expect(createCheckoutSession.mock.calls[0]?.[0].line_items).toEqual([
        { price: BUSINESS_PRICE, quantity: 1 },
        { price: ADD_ON_PRICE, quantity: 1 },
      ]);
    });

    it('returns to the returnTo path on this site, marked paid or cancelled, when one is given', async () => {
      const { session } = await setUpOwner();
      createCheckoutSession.mockResolvedValue(checkoutSession('cs_wizard'));

      const res = await checkout(session.cookie, {
        plan: 'starter',
        addOns: 0,
        returnTo: '/get-started?template=ghost#server',
      });

      expect(res.status).toBe(200);
      expect(createCheckoutSession.mock.calls[0]?.[0]).toMatchObject({
        success_url:
          'https://cloud.cloudgate.test/get-started?template=ghost&checkout=success#server',
        cancel_url:
          'https://cloud.cloudgate.test/get-started?template=ghost&checkout=cancelled#server',
      });
    });

    it.each([
      ['an absolute address', 'https://evil.example/get-started'],
      ['a protocol-relative address', '//evil.example/get-started'],
      ['a backslash host', '/\\evil.example'],
      ['a path with no leading slash', 'get-started'],
      ['a path with a space', '/get started'],
    ])(
      'refuses %s as returnTo, with no session made',
      async (_what, returnTo) => {
        const { session } = await setUpOwner();

        const res = await checkout(session.cookie, {
          plan: 'starter',
          addOns: 0,
          returnTo,
        });

        expect(res.status).toBe(400);
        // Nothing reached Stripe on the way to being refused.
        expect(createCheckoutSession).not.toHaveBeenCalled();
      },
    );

    it('bills the plan alone with no Add-ons', async () => {
      const { session } = await setUpOwner();
      createCheckoutSession.mockResolvedValue(checkoutSession('cs_plan'));

      const res = await checkout(session.cookie, {
        plan: 'starter',
        addOns: 0,
      });

      expect(res.status).toBe(200);
      expect(createCheckoutSession.mock.calls[0]?.[0].line_items).toEqual([
        { price: STARTER_PRICE, quantity: 1 },
      ]);
    });

    it('buys at least enough Add-ons to cover the Servers already held beyond the base 3', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenServers(organizationId, 5);
      createCheckoutSession.mockResolvedValue(checkoutSession('cs_cover'));

      const res = await checkout(session.cookie, {
        plan: 'starter',
        addOns: 0,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'cs_cover',
        url: checkoutUrl('cs_cover'),
        addOns: 2,
      });
      expect(createCheckoutSession.mock.calls[0]?.[0].line_items).toEqual([
        { price: STARTER_PRICE, quantity: 1 },
        { price: ADD_ON_PRICE, quantity: 2 },
      ]);
    });

    it.each([
      ['starterPriceId', 'STARTER_PLAN_PRICE_ID'],
      ['businessPriceId', 'BUSINESS_PLAN_PRICE_ID'],
      ['addOnPriceId', 'ADD_ON_PRICE_ID'],
    ] as const)(
      'refuses with a clear message when %s is unset, and asks Stripe nothing',
      async (which, setting) => {
        const { session } = await setUpOwner();
        givenUnsetPrices(which);

        // Whichever plan is chosen: an unset price refuses every checkout.
        for (const plan of PLAN_NAMES) {
          const res = await checkout(session.cookie, { plan, addOns: 1 });

          expect(res.status).toBe(503);
          expect(res.body).toEqual(
            expect.objectContaining({
              code: 'CHECKOUT_NOT_CONFIGURED',
              message: `Checkout is not set up on this Cloudgate: ${setting} is not set. The person running it needs to set it`,
            }),
          );
        }
        expect(createCheckoutSession).not.toHaveBeenCalled();
      },
    );

    it('names every unset price setting', async () => {
      const { session } = await setUpOwner();
      givenUnsetPrices('starterPriceId', 'businessPriceId', 'addOnPriceId');

      const res = await checkout(session.cookie, {
        plan: 'business',
        addOns: 0,
      });

      expect(res.status).toBe(503);
      expect(res.body).toEqual(
        expect.objectContaining({
          code: 'CHECKOUT_NOT_CONFIGURED',
          message:
            'Checkout is not set up on this Cloudgate: STARTER_PLAN_PRICE_ID, BUSINESS_PLAN_PRICE_ID and ADD_ON_PRICE_ID are not set. The person running it needs to set them',
        }),
      );
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it('refuses an Organization that already holds a plan, either plan', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenPlan(organizationId, 1, 'active', 'starter');

      for (const plan of PLAN_NAMES) {
        const res = await checkout(session.cookie, { plan, addOns: 1 });

        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'PLAN_ALREADY_HELD',
          message:
            'This Organization already has the Starter plan. Change its Add-ons instead of checking out again',
        });
      }
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it('reuses the organization’s stored Stripe customer', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, {
        stripeCustomerId: 'cus_existing',
      });
      retrieveCustomer.mockResolvedValue(liveCustomer('cus_existing'));
      createCheckoutSession.mockResolvedValue(checkoutSession('cs_test_456'));

      const res = await checkout(session.cookie, {
        plan: 'starter',
        addOns: 0,
      });

      expect(res.status).toBe(200);
      expect(createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_existing',
          customer_update: { name: 'auto', address: 'auto' },
        }),
      );
      expect(createCheckoutSession.mock.calls[0]?.[0]).not.toHaveProperty(
        'customer_email',
      );
    });

    it('drops a customer Stripe reports deleted and collects a new one', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, {
        stripeCustomerId: 'cus_gone',
      });
      retrieveCustomer.mockResolvedValue(deletedCustomer('cus_gone'));
      createCheckoutSession.mockResolvedValue(checkoutSession('cs_test_789'));

      await checkout(session.cookie, { plan: 'starter', addOns: 0 });
      expect(createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ customer_email: owner.email }),
      );

      // The stale id is cleared, so the next checkout does not ask Stripe about
      // it again.
      retrieveCustomer.mockClear();
      await checkout(session.cookie, { plan: 'starter', addOns: 0 });
      expect(retrieveCustomer).not.toHaveBeenCalled();
    });

    it('refuses on a self-hosted instance, where nothing is sold', async () => {
      const { session } = await setUpOwner();
      givenSelfHostedInstance();

      const res = await checkout(session.cookie, {
        plan: 'starter',
        addOns: 0,
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          message: 'This feature is only available in Cloudgate Cloud',
        }),
      );
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });
  });

  describe('the allowance', () => {
    it('refuses a Server with "choose a plan" when the Organization has no plan', async () => {
      const { session, ctx: ownerCtx } = await setUpOwner();

      const room = await request(server)
        .get('/billing/can-create-server')
        .set('Cookie', session.cookie);
      expect(room.body).toEqual({
        canCreateMoreServers: false,
        code: 'PLAN_REQUIRED',
        message: CHOOSE_A_PLAN,
      });

      const res = await addServer(ownerCtx, session.cookie);

      expect(res.status).toBe(403);
      expect(res.body).toEqual(
        expect.objectContaining({
          code: 'PLAN_REQUIRED',
          message: CHOOSE_A_PLAN,
        }),
      );
      await expect(serverStatuses(ownerCtx)).resolves.toEqual([]);
    });

    it('allows Projects, members, Git connections and Cloud account setup with no plan', async () => {
      // setUpOrgWithMember invites and accepts a member.
      const { session } = await setUpOrgWithMember();
      const cookie = session.cookie;

      const project = await request(server)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'shop' });
      expect(project.status).toBe(201);

      const gitea = await request(server)
        .post('/gitea')
        .set('Cookie', cookie)
        .send({
          name: 'Team Gitea',
          redirectUri: 'https://cloudgate.example.com/callback',
          clientId: 'gitea-client-id',
          clientSecret: 'gitea-client-secret',
        });
      expect(gitea.status).toBe(201);

      const cloudSetup = await request(server)
        .post('/cloud-accounts/setup')
        .set('Cookie', cookie)
        .send({ cloudId: '123456789012' });
      expect(cloudSetup.status).toBe(200);
    });

    it('allows 3 + N Servers with N Add-ons and refuses the next one, pointing at the Add-on', async () => {
      const { session, ctx: ownerCtx, organizationId } = await setUpOwner();
      await givenPlan(organizationId, 1);
      await givenServers(organizationId, 3);

      // The fourth fits: 3 + 1 Add-on.
      const fourth = await addServer(ownerCtx, session.cookie);
      expect(fourth.status).toBe(201);

      const fifth = await addServer(ownerCtx, session.cookie);
      expect(fifth.status).toBe(403);
      expect(fifth.body).toEqual(
        expect.objectContaining({
          code: 'ALLOWANCE_FULL',
          message: allowanceFull(4),
        }),
      );
      await expect(serverStatuses(ownerCtx)).resolves.toHaveLength(4);

      const room = await request(server)
        .get('/billing/can-create-server')
        .set('Cookie', session.cookie);
      expect(room.body).toEqual({
        canCreateMoreServers: false,
        code: 'ALLOWANCE_FULL',
        message: allowanceFull(4),
      });
    });

    it('keeps the allowance while a payment is past due', async () => {
      const { session, ctx: ownerCtx, organizationId } = await setUpOwner();
      await givenPlan(organizationId, 0, 'past_due');

      const res = await addServer(ownerCtx, session.cookie);

      expect(res.status).toBe(201);
    });

    it('says what the Organization holds against what it may hold', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenPlan(organizationId, 2);
      await givenServers(organizationId, 6);

      const res = await getBilling(session.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        plan: 'starter',
        status: 'active',
        addOns: 2,
        allowance: { plan: 'starter', servers: 5, cloudEnvironments: 5 },
        usage: { servers: 6, cloudEnvironments: 0 },
        minimumAddOns: 3,
        sendInvoiceNotifications: false,
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        trialAvailable: false,
        trialEndsAt: null,
        scheduledPlan: null,
        scheduledAt: null,
        trial: null,
        paidBy: null,
        pool: null,
      });
    });

    it('meters nothing on a self-hosted instance', async () => {
      const { session, ctx: ownerCtx } = await setUpOwner();
      givenSelfHostedInstance();

      const res = await addServer(ownerCtx, session.cookie);

      expect(res.status).toBe(201);
      const room = await request(server)
        .get('/billing/can-create-server')
        .set('Cookie', session.cookie);
      expect(room.body).toEqual({
        canCreateMoreServers: true,
        code: null,
        message: null,
      });
    });

    it('leaves every Server running when one is deleted over the allowance', async () => {
      const { session, ctx: ownerCtx, organizationId } = await setUpOwner();
      await givenPlan(organizationId, 0);
      await givenServers(organizationId, 5);
      const [first] = await ctx.app.get(ServersService).list(ownerCtx);
      if (!first) throw new Error('no Server listed');

      const res = await request(server)
        .delete(`/servers/${first.serverId}`)
        .set('Cookie', session.cookie);

      expect(res.status).toBe(200);
      await expect(serverStatuses(ownerCtx)).resolves.toEqual([
        'active',
        'active',
        'active',
        'active',
      ]);
    });
  });

  describe('HTTP surface', () => {
    it('requires a session on every billing route', async () => {
      const routes: Array<[string, string]> = [
        ['get', '/billing/subscription'],
        ['get', '/billing/plan'],
        ['get', '/billing/products'],
        ['get', '/billing/invoices'],
        ['get', '/billing/can-create-server'],
        ['post', '/billing/checkout'],
        ['post', '/billing/portal'],
        ['post', '/billing/add-ons'],
        ['get', '/billing/upgrade-preview'],
        ['post', '/billing/upgrade'],
        ['post', '/billing/downgrade'],
        ['delete', '/billing/downgrade'],
        ['patch', '/billing/invoice-notifications'],
      ];

      for (const [method, path] of routes) {
        const res = await request(server)[method as 'get'](path);
        expect([401, 403]).toContain(res.status);
      }
    });

    it('serves the plan to any member, and billing only to an owner or admin', async () => {
      const { organizationId, invitee } = await setUpOrgWithMember();
      await givenPlan(organizationId, 0);

      const plan = await request(server)
        .get('/billing/plan')
        .set('Cookie', invitee.cookie);
      expect(plan.status).toBe(200);
      expect(plan.body).toEqual({ plan: 'starter', scheduledAt: null });

      const state = await getBilling(invitee.cookie);
      expect(state.status).toBe(403);

      const buy = await checkout(invitee.cookie, {
        plan: 'starter',
        addOns: 0,
      });
      expect(buy.status).toBe(403);
    });

    it('reports no plan once the subscription no longer grants it', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenPlan(organizationId, 2, 'canceled');

      const plan = await request(server)
        .get('/billing/plan')
        .set('Cookie', session.cookie);
      expect(plan.body).toEqual({ plan: null, scheduledAt: null });

      const state = await getBilling(session.cookie);
      expect(state.body).toEqual(
        expect.objectContaining({
          allowance: { plan: null, servers: 0, cloudEnvironments: 0 },
        }),
      );
    });

    it('rejects malformed checkout and Add-on bodies', async () => {
      const { session } = await setUpOwner();
      const post = (path: string, body: object) =>
        request(server).post(path).set('Cookie', session.cookie).send(body);

      for (const body of [
        {},
        { addOns: -1 },
        { addOns: 1.5 },
        // The retired tiers are not a body any more.
        { tier: 'startup', productId: 'prod_x', serverQuantity: 3 },
      ]) {
        await expect(
          post('/billing/checkout', body).then((res) => res.status),
        ).resolves.toBe(400);
        await expect(
          post('/billing/add-ons', body).then((res) => res.status),
        ).resolves.toBe(400);
      }
      // Checkout names its plan: none, or one this instance does not sell, is
      // refused — the retired single Hosted plan among them.
      for (const body of [
        { addOns: 1 },
        { plan: 'hosted', addOns: 1 },
        { plan: 'enterprise', addOns: 1 },
        { plan: 'business', addOns: -1 },
      ]) {
        await expect(
          post('/billing/checkout', body).then((res) => res.status),
        ).resolves.toBe(400);
      }
      expect(createCheckoutSession).not.toHaveBeenCalled();

      const patch = await request(server)
        .patch('/billing/invoice-notifications')
        .set('Cookie', session.cookie)
        .send({});
      expect(patch.status).toBe(400);
    });
  });

  describe('the catalogue', () => {
    it('answers both plans and the Add-on as Stripe prices them', async () => {
      const { session } = await setUpOwner();
      const prices = {
        [STARTER_PRICE]: stripePrice(STARTER_PRICE, 'Starter', 1500),
        [BUSINESS_PRICE]: stripePrice(BUSINESS_PRICE, 'Business', 3500),
        [ADD_ON_PRICE]: stripePrice(ADD_ON_PRICE, 'Add-on', 500),
      };
      retrievePrice.mockImplementation((id: string) =>
        Promise.resolve(prices[id]),
      );

      const res = await request(server)
        .get('/billing/products')
        .set('Cookie', session.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        includes: 3,
        plans: {
          starter: {
            id: STARTER_PRICE,
            name: 'Starter',
            unitAmount: 1500,
            currency: 'usd',
            interval: 'month',
          },
          business: {
            id: BUSINESS_PRICE,
            name: 'Business',
            unitAmount: 3500,
            currency: 'usd',
            interval: 'month',
          },
        },
        addOn: {
          id: ADD_ON_PRICE,
          name: 'Add-on',
          unitAmount: 500,
          currency: 'usd',
          interval: 'month',
        },
      });
    });

    it('refuses the catalogue with a sentence on a self-hosted instance', async () => {
      const { session } = await setUpOwner();
      givenSelfHostedInstance();

      const res = await request(server)
        .get('/billing/products')
        .set('Cookie', session.cookie);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          message: 'This feature is only available in Cloudgate Cloud',
        }),
      );
      expect(retrievePrice).not.toHaveBeenCalled();
    });
  });

  describe('changing the Add-ons', () => {
    function setAddOns(cookie: string, addOns: number) {
      return request(server)
        .post('/billing/add-ons')
        .set('Cookie', cookie)
        .send({ addOns });
    }

    it('sets the Add-on item’s quantity and leaves the plan item alone', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenPlan(organizationId, 1);
      retrieveSubscription.mockResolvedValue(planSubscription(1));
      updateSubscription.mockResolvedValue(planSubscription(3));

      const res = await setAddOns(session.cookie, 3);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ addOns: 3 });
      expect(updateSubscription).toHaveBeenCalledWith('sub_1', {
        items: [{ id: 'si_add_on', quantity: 3 }],
        proration_behavior: 'create_prorations',
      });
    });

    it('adds the Add-on item to a plan bought without one, and removes it at zero', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenPlan(organizationId, 0);
      retrieveSubscription.mockResolvedValue(planSubscription(0));

      await setAddOns(session.cookie, 2);
      expect(updateSubscription).toHaveBeenLastCalledWith('sub_1', {
        items: [{ price: ADD_ON_PRICE, quantity: 2 }],
        proration_behavior: 'create_prorations',
      });

      retrieveSubscription.mockResolvedValue(planSubscription(2));
      await setAddOns(session.cookie, 0);
      expect(updateSubscription).toHaveBeenLastCalledWith('sub_1', {
        items: [{ id: 'si_add_on', deleted: true }],
        proration_behavior: 'create_prorations',
      });
    });

    it('never goes below what the Organization already uses', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenPlan(organizationId, 3);
      await givenServers(organizationId, 5);
      retrieveSubscription.mockResolvedValue(planSubscription(3));

      const res = await setAddOns(session.cookie, 0);

      expect(res.body).toEqual({ addOns: 2 });
      expect(updateSubscription).toHaveBeenCalledWith('sub_1', {
        items: [{ id: 'si_add_on', quantity: 2 }],
        proration_behavior: 'create_prorations',
      });
    });

    it('refuses with no subscription, or one that is not active at Stripe', async () => {
      const { session, organizationId } = await setUpOwner();

      const none = await setAddOns(session.cookie, 1);
      expect(none.status).toBe(400);
      expect(none.body).toEqual(
        expect.objectContaining({ message: 'No active subscription found' }),
      );

      await givenPlan(organizationId, 0);
      retrieveSubscription.mockResolvedValue(planSubscription(0, 'past_due'));
      const lapsed = await setAddOns(session.cookie, 1);
      expect(lapsed.status).toBe(400);
      expect(lapsed.body).toEqual(
        expect.objectContaining({ message: 'Subscription is not active' }),
      );
      expect(updateSubscription).not.toHaveBeenCalled();
    });
  });

  describe('the customer portal', () => {
    it('returns the portal URL for a subscribed organization', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, { stripeCustomerId: 'cus_1' });
      givenPortalConfigurations([]);
      createBillingPortalSession.mockResolvedValue({
        url: 'https://billing.stripe.test/session',
      } as unknown as Stripe.BillingPortal.Session);

      const res = await request(server)
        .post('/billing/portal')
        .set('Cookie', session.cookie);

      expect(res.body).toEqual({ url: 'https://billing.stripe.test/session' });
      expect(createBillingPortalSession).toHaveBeenCalledWith({
        customer: 'cus_1',
        return_url: 'https://cloud.cloudgate.test/settings/billing',
        configuration: 'bpc_cloudgate',
      });
    });

    it('makes the portal cancel at the end of the paid month, with no plan change', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, { stripeCustomerId: 'cus_1' });
      givenPortalConfigurations([]);
      createBillingPortalSession.mockResolvedValue({
        url: 'https://billing.stripe.test/session',
      } as unknown as Stripe.BillingPortal.Session);

      await request(server)
        .post('/billing/portal')
        .set('Cookie', session.cookie);

      expect(createBillingPortalConfiguration).toHaveBeenCalledTimes(1);
      const [params] = createBillingPortalConfiguration.mock.calls[0] ?? [];
      expect(params?.features.subscription_cancel).toEqual({
        enabled: true,
        mode: 'at_period_end',
        proration_behavior: 'none',
      });
      expect(params?.features.subscription_update).toEqual({ enabled: false });
    });

    it('reuses the portal configuration Cloudgate already made', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, { stripeCustomerId: 'cus_1' });
      givenPortalConfigurations([
        { id: 'bpc_other', metadata: {} },
        { id: 'bpc_existing', metadata: { cloudgate_portal: '1' } },
      ]);
      createBillingPortalSession.mockResolvedValue({
        url: 'https://billing.stripe.test/session',
      } as unknown as Stripe.BillingPortal.Session);

      await request(server)
        .post('/billing/portal')
        .set('Cookie', session.cookie);

      expect(createBillingPortalConfiguration).not.toHaveBeenCalled();
      expect(createBillingPortalSession).toHaveBeenCalledWith(
        expect.objectContaining({ configuration: 'bpc_existing' }),
      );
    });

    it('refuses an organization with no Stripe customer', async () => {
      const { session } = await setUpOwner();

      const res = await request(server)
        .post('/billing/portal')
        .set('Cookie', session.cookie);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({ message: 'Stripe Customer ID not found' }),
      );
      expect(createBillingPortalSession).not.toHaveBeenCalled();
    });

    it('answers with an empty URL when Stripe refuses the portal', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, { stripeCustomerId: 'cus_1' });
      givenPortalConfigurations([]);
      createBillingPortalSession.mockRejectedValue(
        new Error('No configuration provided'),
      );

      const res = await request(server)
        .post('/billing/portal')
        .set('Cookie', session.cookie);

      expect(res.body).toEqual({ url: '' });
    });
  });

  describe('invoices', () => {
    it('projects the customer’s invoices', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, { stripeCustomerId: 'cus_1' });
      listInvoices.mockResolvedValue([paidInvoice()]);

      const res = await request(server)
        .get('/billing/invoices')
        .set('Cookie', session.cookie);

      expect(res.body).toEqual([
        {
          id: 'in_1',
          number: 'INV-77',
          status: null,
          amountDue: 1500,
          amountPaid: 1500,
          currency: 'usd',
          created: 1_767_225_600,
          dueDate: null,
          hostedInvoiceUrl: 'https://invoice.stripe.test/INV-77',
          invoicePdf: 'https://invoice.stripe.test/INV-77.pdf',
        },
      ]);
    });

    it('returns nothing with no customer, or when Stripe fails', async () => {
      const { session, organizationId } = await setUpOwner();

      const none = await request(server)
        .get('/billing/invoices')
        .set('Cookie', session.cookie);
      expect(none.body).toEqual([]);
      expect(listInvoices).not.toHaveBeenCalled();

      await givenSubscriptionRow(organizationId, { stripeCustomerId: 'cus_1' });
      listInvoices.mockRejectedValue(new Error('Stripe is down'));
      const failed = await request(server)
        .get('/billing/invoices')
        .set('Cookie', session.cookie);
      expect(failed.body).toEqual([]);
    });
  });

  describe('invoice notifications', () => {
    it('records the owner’s choice before any subscription exists, and keeps the rest of the row', async () => {
      const { session, organizationId } = await setUpOwner();
      const toggle = (enabled: boolean) =>
        request(server)
          .patch('/billing/invoice-notifications')
          .set('Cookie', session.cookie)
          .send({ enabled });

      await expect(
        toggle(true).then((res) => res.body as unknown),
      ).resolves.toEqual({
        ok: true,
      });
      await expect(
        getBilling(session.cookie).then((res) => res.body as unknown),
      ).resolves.toEqual(
        expect.objectContaining({ sendInvoiceNotifications: true }),
      );

      await givenPlan(organizationId, 2);
      await toggle(false);
      await expect(
        getBilling(session.cookie).then((res) => res.body as unknown),
      ).resolves.toEqual(
        expect.objectContaining({
          plan: 'starter',
          addOns: 2,
          sendInvoiceNotifications: false,
        }),
      );
    });
  });

  describe('webhook', () => {
    it('verifies the signature over the exact bytes Stripe sent', async () => {
      // Key order and spacing that no re-serialization would reproduce: Stripe
      // signs the raw request body, so anything but these bytes fails upstream.
      const rawBody = '{"type":"customer.deleted",  "id":"evt_1"}';
      constructEvent.mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature');
      });

      const res = await request(server)
        .post('/billing/webhook')
        .set('stripe-signature', 't=1,v1=deadbeef')
        .set('Content-Type', 'application/json')
        .send(rawBody);

      expect(res.status).toBe(400);
      expect(constructEvent).toHaveBeenCalledTimes(1);
      const [payload, signature] = constructEvent.mock.calls[0] ?? [];
      expect(
        Buffer.isBuffer(payload) ? payload.toString('utf8') : payload,
      ).toBe(rawBody);
      expect(signature).toBe('t=1,v1=deadbeef');
    });

    it('refuses a webhook with no signature header', async () => {
      const res = await request(server)
        .post('/billing/webhook')
        .set('Content-Type', 'application/json')
        .send('{"type":"customer.deleted"}');

      expect(res.status).toBe(400);
      expect(constructEvent).not.toHaveBeenCalled();
    });

    it('records the customer, subscription, plan and Add-ons on checkout completion', async () => {
      const { session, organizationId } = await setUpOwner();
      retrieveSubscription.mockResolvedValue(planSubscription(2));

      const res = await postWebhook(
        stripeEvent('checkout.session.completed', {
          id: 'cs_1',
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { organizationId },
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(retrieveSubscription).toHaveBeenCalledWith('sub_1');
      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(
        expect.objectContaining({
          plan: 'starter',
          status: 'active',
          addOns: 2,
          allowance: { plan: 'starter', servers: 5, cloudEnvironments: 5 },
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
        }),
      );
    });

    it('records Business when the subscription carries the Business price', async () => {
      const { session, organizationId } = await setUpOwner();
      retrieveSubscription.mockResolvedValue(
        planSubscription(1, 'active', 'business'),
      );

      await postWebhook(
        stripeEvent('checkout.session.completed', {
          id: 'cs_1',
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { organizationId },
        }),
      );

      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(
        expect.objectContaining({
          plan: 'business',
          addOns: 1,
          allowance: { plan: 'business', servers: 4, cloudEnvironments: 4 },
        }),
      );
    });

    it('records no plan for a subscription to a price this instance does not sell', async () => {
      const { session, organizationId } = await setUpOwner();
      retrieveSubscription.mockResolvedValue(
        stripeSubscription({
          items: [{ price: 'price_legacy_monthly', quantity: 5 }],
        }),
      );

      await postWebhook(
        stripeEvent('checkout.session.completed', {
          id: 'cs_1',
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { organizationId },
        }),
      );

      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(
        expect.objectContaining({
          plan: null,
          addOns: 0,
          allowance: { plan: null, servers: 0, cloudEnvironments: 0 },
        }),
      );
    });

    it('lowers the Add-ons without touching any Server, and refuses only the next one', async () => {
      const { session, ctx: ownerCtx, organizationId } = await setUpOwner();
      await givenPlan(organizationId, 3);
      await givenServers(organizationId, 6);

      const res = await postWebhook(
        stripeEvent('customer.subscription.updated', planSubscription(1)),
      );

      expect(res.status).toBe(200);
      // The event carries its own items, so Stripe is not asked again.
      expect(retrieveSubscription).not.toHaveBeenCalled();
      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(
        expect.objectContaining({
          addOns: 1,
          allowance: { plan: 'starter', servers: 4, cloudEnvironments: 4 },
          usage: { servers: 6, cloudEnvironments: 0 },
        }),
      );
      // Six Servers over an allowance of four: all six keep running...
      await expect(serverStatuses(ownerCtx)).resolves.toEqual(
        Array(6).fill('active'),
      );
      // ...and only a seventh is refused.
      const seventh = await addServer(ownerCtx, session.cookie);
      expect(seventh.status).toBe(403);
      expect(seventh.body).toEqual(
        expect.objectContaining({
          code: 'ALLOWANCE_FULL',
          message: allowanceFull(6),
        }),
      );
    });

    it('stores a past-due status and changes no Server', async () => {
      const { session, ctx: ownerCtx, organizationId } = await setUpOwner();
      await givenPlan(organizationId, 0);
      await givenServers(organizationId, 3);

      const res = await postWebhook(
        stripeEvent(
          'customer.subscription.updated',
          planSubscription(0, 'past_due'),
        ),
      );

      expect(res.status).toBe(200);
      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(
        expect.objectContaining({
          status: 'past_due',
          allowance: { plan: 'starter', servers: 3, cloudEnvironments: 3 },
        }),
      );
      await expect(serverStatuses(ownerCtx)).resolves.toEqual(
        Array(3).fill('active'),
      );
    });

    it('drops the plan on a cancellation without touching any Server, and keeps the customer', async () => {
      const { session, ctx: ownerCtx, organizationId } = await setUpOwner();
      await givenPlan(organizationId, 1);
      await givenServers(organizationId, 4);

      const res = await postWebhook(
        stripeEvent(
          'customer.subscription.deleted',
          planSubscription(1, 'canceled'),
        ),
      );

      expect(res.status).toBe(200);
      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(
        expect.objectContaining({
          // The customer survives a cancellation — they can subscribe again
          // without becoming a second Stripe customer.
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: null,
          plan: null,
          addOns: 0,
          allowance: { plan: null, servers: 0, cloudEnvironments: 0 },
        }),
      );
      await expect(serverStatuses(ownerCtx)).resolves.toEqual(
        Array(4).fill('active'),
      );
      // The cancellation lapsed the Organization (ADR-0052), so the
      // next write is refused as frozen before the allowance is asked.
      const next = await addServer(ownerCtx, session.cookie);
      expect(next.body).toEqual(
        expect.objectContaining({
          code: 'ORGANIZATION_FROZEN',
          message: 'Pay to continue',
        }),
      );
    });

    it('clears billing when the customer is deleted, and changes no Server', async () => {
      const { session, ctx: ownerCtx, organizationId } = await setUpOwner();
      await givenPlan(organizationId, 0);
      await givenServers(organizationId, 2);

      const res = await postWebhook(
        stripeEvent('customer.deleted', { id: 'cus_1', deleted: true }),
      );

      expect(res.status).toBe(200);
      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(
        expect.objectContaining({
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          plan: null,
          addOns: 0,
        }),
      );
      await expect(serverStatuses(ownerCtx)).resolves.toEqual([
        'active',
        'active',
      ]);
    });

    it('records a newly created subscription against the stored customer', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, { stripeCustomerId: 'cus_1' });

      const res = await postWebhook(
        stripeEvent('customer.subscription.created', planSubscription(0)),
      );

      expect(res.status).toBe(200);
      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(
        expect.objectContaining({
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
        }),
      );
    });

    it('leaves an organization billed outside Stripe untouched', async () => {
      const { session, ctx: ownerCtx, organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, {
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_manual',
        plan: 'starter',
        status: 'active',
        addOns: 7,
        enterprise: true,
      });
      await givenServers(organizationId, 2);

      const res = await postWebhook(
        stripeEvent(
          'customer.subscription.deleted',
          planSubscription(0, 'canceled'),
        ),
      );

      expect(res.status).toBe(200);
      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(
        expect.objectContaining({
          stripeSubscriptionId: 'sub_manual',
          plan: 'starter',
          addOns: 7,
        }),
      );
      await expect(serverStatuses(ownerCtx)).resolves.toEqual([
        'active',
        'active',
      ]);
    });

    it('re-syncs the Add-ons and mails the invoice when payment succeeds', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, {
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        plan: 'starter',
        status: 'active',
        addOns: 0,
        sendInvoiceNotifications: true,
      });
      retrieveSubscription.mockResolvedValue(planSubscription(2));
      fetchClient.mockResolvedValue(pdfResponse('%PDF-1.4 invoice'));

      const res = await postWebhook(
        stripeEvent('invoice.payment_succeeded', paidInvoice()),
      );

      expect(res.status).toBe(200);
      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(expect.objectContaining({ addOns: 2 }));

      expect(sendMail).toHaveBeenCalledTimes(1);
      const [to, email, attachments] = sendMail.mock.calls[0] ?? [];
      expect(to).toBe(owner.email);
      // 1500 cents of usd, formatted the way a customer reads it.
      expect(email?.subject).toBe('Cloudgate Invoice INV-77 - $15.00');
      expect(email?.html).toContain('INV-77');
      expect(email?.html).toContain('https://invoice.stripe.test/INV-77');
      expect(attachments).toEqual([
        {
          filename: 'cloudgate-invoice-INV-77.pdf',
          content: Buffer.from('%PDF-1.4 invoice'),
        },
      ]);
    });

    it('mails the failure and stores the status when payment fails on a subscription that is no longer active, and changes no Server', async () => {
      const { session, ctx: ownerCtx, organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, {
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        plan: 'starter',
        status: 'active',
        addOns: 0,
        sendInvoiceNotifications: true,
      });
      await givenServers(organizationId, 2);
      retrieveSubscription.mockResolvedValue(planSubscription(0, 'past_due'));

      const res = await postWebhook(
        stripeEvent('invoice.payment_failed', paidInvoice({ amount_paid: 0 })),
      );

      expect(res.status).toBe(200);
      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(expect.objectContaining({ status: 'past_due' }));
      await expect(serverStatuses(ownerCtx)).resolves.toEqual([
        'active',
        'active',
      ]);

      expect(sendMail).toHaveBeenCalledTimes(1);
      const [to, email, attachments] = sendMail.mock.calls[0] ?? [];
      expect(to).toBe(owner.email);
      expect(email?.subject).toBe(
        'Action required: Cloudgate payment failed - $15.00',
      );
      // Only the paid invoice carries a PDF attachment.
      expect(attachments).toBeUndefined();
      expect(fetchClient).not.toHaveBeenCalled();
    });

    it('leaves a still-active subscription alone when an invoice fails', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, {
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        plan: 'starter',
        status: 'active',
        sendInvoiceNotifications: true,
      });
      // Stripe retries; the subscription has not lapsed yet.
      retrieveSubscription.mockResolvedValue(planSubscription(0));

      const res = await postWebhook(
        stripeEvent('invoice.payment_failed', paidInvoice()),
      );

      expect(res.status).toBe(200);
      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(expect.objectContaining({ status: 'active' }));
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('sends no mail when the organization has not asked for invoice notifications', async () => {
      const { organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, {
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        status: 'active',
        sendInvoiceNotifications: false,
      });
      retrieveSubscription.mockResolvedValue(planSubscription(0));

      const res = await postWebhook(
        stripeEvent('invoice.payment_succeeded', paidInvoice()),
      );

      expect(res.status).toBe(200);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('sends no mail for a 0 USD invoice, though invoice emails were asked for', async () => {
      const { organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, {
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        plan: 'starter',
        status: 'active',
        sendInvoiceNotifications: true,
      });
      retrieveSubscription.mockResolvedValue(planSubscription(0));

      const res = await postWebhook(
        stripeEvent(
          'invoice.payment_succeeded',
          paidInvoice({ amount_paid: 0, amount_due: 0 }),
        ),
      );

      expect(res.status).toBe(200);
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('the first charge after a free trial says the trial has ended, and the next invoice does not', async () => {
      const { organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, {
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        plan: 'starter',
        status: 'trialing',
        sendInvoiceNotifications: true,
      });
      const afterTrial = {
        ...planSubscription(0),
        trial_end: 1_767_225_600,
      } as Stripe.Subscription;
      retrieveSubscription.mockResolvedValue(afterTrial);
      fetchClient.mockResolvedValue(pdfResponse('%PDF-1.4 invoice'));

      await postWebhook(
        stripeEvent('invoice.payment_succeeded', paidInvoice()),
      );
      await postWebhook(
        stripeEvent(
          'invoice.payment_succeeded',
          paidInvoice({ id: 'in_2', number: 'INV-78' }),
        ),
      );

      expect(sendMail).toHaveBeenCalledTimes(2);
      const [first, second] = sendMail.mock.calls.map(([, email]) => email);
      expect(first?.html).toContain('Your free trial has ended');
      expect(second?.subject).toBe('Cloudgate Invoice INV-78 - $15.00');
      expect(second?.html).not.toContain('Your free trial has ended');
    });

    it('ignores a paid invoice for a subscription that is no longer active', async () => {
      const { session, organizationId } = await setUpOwner();
      await givenSubscriptionRow(organizationId, {
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        status: 'canceled',
        sendInvoiceNotifications: true,
      });
      retrieveSubscription.mockResolvedValue(planSubscription(2, 'canceled'));

      const res = await postWebhook(
        stripeEvent('invoice.payment_succeeded', paidInvoice()),
      );

      expect(res.status).toBe(200);
      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(
        expect.objectContaining({ plan: null, status: 'canceled', addOns: 0 }),
      );
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('acknowledges, and records nothing for, a subscription event for an unknown Stripe customer', async () => {
      const { session } = await setUpOwner();

      const res = await postWebhook(
        stripeEvent('customer.subscription.updated', planSubscription(0)),
      );

      // A 2xx, so Stripe neither retries what no retry can resolve nor counts
      // it toward disabling the endpoint.
      expect(res.status).toBe(200);
      await expect(
        getBilling(session.cookie).then((r) => r.body as unknown),
      ).resolves.toEqual(
        expect.objectContaining({ plan: null, stripeCustomerId: null }),
      );
    });

    it('refuses a checkout completion for an unknown organization', async () => {
      retrieveSubscription.mockResolvedValue(planSubscription(0));

      const res = await postWebhook(
        stripeEvent('checkout.session.completed', {
          id: 'cs_1',
          customer: 'cus_1',
          subscription: 'sub_1',
          metadata: { organizationId: 'org_does_not_exist' },
        }),
      );

      expect(res.status).toBe(400);
      expect(res.text).toContain('Organization not found');
    });

    it('refuses an event type it does not handle', async () => {
      constructEvent.mockReturnValue({
        type: 'customer.created',
        data: { object: {} },
      } as unknown as Stripe.Event);

      const res = await request(server)
        .post('/billing/webhook')
        .set('stripe-signature', 't=1,v1=valid')
        .set('Content-Type', 'application/json')
        .send('{"type":"customer.created"}');

      expect(res.status).toBe(400);
      expect(res.text).toContain('Invalid Event Type');
    });
  });
});
