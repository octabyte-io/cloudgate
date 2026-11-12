// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first import.
import { useHostedMode } from '../../utils/hosted-mode';
const hosted = useHostedMode();

import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';
import { subscription } from '../../../src/cloud/billing/billing.schema';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { fakeStripe } from '../../utils/fake-stripe';
import {
  application,
  cloudAccount,
  environment,
  server as serverTable,
} from '../../../src/db/schema';
import { InstanceMode } from '../../../src/instance-mode/instance-mode.service';
import { MailService } from '../../../src/mail/mail.service';
import { RemoteExecService } from '../../../src/remote/remote-exec.service';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import {
  member,
  organization,
} from '../../../src/organizations/organizations.schema';
import { signUpMember } from '../../utils/test-auth';
import { createTestApp, TestAppContext } from '../../utils/test-app';
import { isPresenceProbe } from '../../utils/workload-presence-probe';

jest.setTimeout(180_000);

const PLAN_PRICE = hosted.STARTER_PLAN_PRICE_ID;
const ADD_ON_PRICE = hosted.ADD_ON_PRICE_ID;

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
const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();

const stripe = fakeStripe({
  retrieveSubscription,
  retrieveCustomer,
  createCheckoutSession,
  createBillingPortalSession,
  listBillingPortalConfigurations: () =>
    Promise.resolve([
      {
        id: 'bpc_cloudgate',
        metadata: { cloudgate_portal: '1' },
      } as unknown as Stripe.BillingPortal.Configuration,
    ]),
  constructEvent,
});

const stripeSubscription = (
  status: string,
  { id = 'sub_1', addOns = 0 }: { id?: string; addOns?: number } = {},
) =>
  ({
    id,
    customer: 'cus_1',
    status,
    items: {
      data: [
        { id: 'si_plan', price: { id: PLAN_PRICE }, quantity: 1 },
        ...(addOns > 0
          ? [{ id: 'si_add_on', price: { id: ADD_ON_PRICE }, quantity: addOns }]
          : []),
      ],
    },
  }) as unknown as Stripe.Subscription;

const stripeEvent = (type: string, object: unknown) =>
  ({ type, data: { object } }) as unknown as Stripe.Event;

const FROZEN_LAPSED = {
  statusCode: 403,
  code: 'ORGANIZATION_FROZEN',
  message: 'Pay to continue',
};

describe('Frozen Organization: the lapse and the writes it refuses (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let ownerId: string;
  const mail = new MailRecorder();

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  const succeeds = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command)
        ? { stdout: 'absent', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
    );

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: STRIPE_API, useValue: stripe },
        { provide: MailService, useValue: mail },
        { provide: RemoteExecService, useValue: execMock },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mail.clear();
    execMock.execAsync.mockImplementation(succeeds);
    execMock.execAsyncRemote.mockImplementation((_id: string, cmd: string) =>
      succeeds(cmd),
    );
    await openHostedSignUp(ctx.db);
    const customer = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    cookie = customer.cookie;
    organizationId = customer.organizationId;
    ownerId = customer.id;
  });

  /** Arrangement only: the Hosted plan, paid, against `cus_1` / `sub_1`. */
  async function givenPlan(status = 'active'): Promise<void> {
    await ctx.db
      .insert(subscription)
      .values({
        organizationId,
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        plan: 'starter',
        status,
        addOns: 0,
      })
      .onConflictDoUpdate({
        target: subscription.organizationId,
        set: { plan: 'starter', status, stripeSubscriptionId: 'sub_1' },
      });
  }

  /** Arrangement only: lapsed, as the webhook records it. */
  async function givenLapsed(): Promise<void> {
    await givenPlan();
    const res = await postWebhook(
      stripeEvent(
        'customer.subscription.deleted',
        stripeSubscription('canceled'),
      ),
    );
    expect(res.status).toBe(200);
  }

  async function givenServers(count: number): Promise<string[]> {
    const rows = await ctx.db
      .insert(serverTable)
      .values(
        Array.from({ length: count }, (_, index) => ({
          name: `server-${index + 1}`,
          ipAddress: `203.0.113.${index + 1}`,
          port: 22,
          organizationId,
        })),
      )
      .returning();
    return rows.map((row) => row.serverId);
  }

  async function serverStatuses(): Promise<string[]> {
    const rows = await ctx.db
      .select({ status: serverTable.serverStatus })
      .from(serverTable)
      .where(eq(serverTable.organizationId, organizationId));
    return rows.map((row) => row.status);
  }

  function postWebhook(event: Stripe.Event) {
    constructEvent.mockReturnValue(event);
    return request(http)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event));
  }

  async function standing() {
    const res = await request(http)
      .get('/billing/standing')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as {
      frozen: boolean;
      causes: string[];
      paymentFailed: boolean;
      lapsedAt: string | null;
    };
  }

  async function project(name = 'shop'): Promise<string> {
    const res = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name });
    expect(res.status).toBe(201);
    return (res.body as { projectId: string }).projectId;
  }

  /** A pre-hosted Environment, straight to its row (the API refuses one with no target). */
  async function environmentRow(projectId: string): Promise<string> {
    const [row] = await ctx.db
      .insert(environment)
      .values({
        name: 'staging',
        projectId,
        deployTarget: { kind: 'platform-host' } as never,
      })
      .returning();
    return row.environmentId;
  }

  describe('the lapse', () => {
    it('is recorded when the subscription is deleted, and touches no Server', async () => {
      await givenPlan();
      await givenServers(2);

      const res = await postWebhook(
        stripeEvent(
          'customer.subscription.deleted',
          stripeSubscription('canceled'),
        ),
      );

      expect(res.status).toBe(200);
      const after = await standing();
      expect(after).toEqual(
        expect.objectContaining({
          frozen: true,
          causes: ['lapsed'],
          paymentFailed: false,
        }),
      );
      expect(after.lapsedAt).not.toBeNull();
      await expect(serverStatuses()).resolves.toEqual(['active', 'active']);
    });

    it('is recorded when the Stripe customer is deleted', async () => {
      await givenPlan();

      await postWebhook(
        stripeEvent('customer.deleted', { id: 'cus_1', deleted: true }),
      );

      await expect(standing()).resolves.toEqual(
        expect.objectContaining({ frozen: true, causes: ['lapsed'] }),
      );
    });

    it('keeps the first moment when the customer is deleted after the subscription', async () => {
      await givenLapsed();
      const first = (await standing()).lapsedAt;

      await postWebhook(
        stripeEvent('customer.deleted', { id: 'cus_1', deleted: true }),
      );

      expect((await standing()).lapsedAt).toBe(first);
    });

    it('records nothing for past_due, which shows the banner and freezes nothing', async () => {
      await givenPlan();

      await postWebhook(
        stripeEvent(
          'customer.subscription.updated',
          stripeSubscription('past_due'),
        ),
      );

      await expect(standing()).resolves.toEqual({
        frozen: false,
        causes: [],
        paymentFailed: true,
        lapsedAt: null,
        suspendedReason: null,
        payingOrganization: null,
      });
      const created = await request(http)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'still-working' });
      expect(created.status).toBe(201);
    });

    it('is not recorded for a subscription the Organization no longer holds', async () => {
      await givenPlan();

      await postWebhook(
        stripeEvent(
          'customer.subscription.deleted',
          stripeSubscription('canceled', { id: 'sub_old' }),
        ),
      );

      await expect(standing()).resolves.toEqual(
        expect.objectContaining({ frozen: false, causes: [] }),
      );
    });

    it('is not recorded for a first checkout that never paid', async () => {
      await ctx.db.insert(subscription).values({
        organizationId,
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        plan: 'starter',
        status: 'incomplete',
      });

      await postWebhook(
        stripeEvent(
          'customer.subscription.deleted',
          stripeSubscription('incomplete_expired'),
        ),
      );

      await expect(standing()).resolves.toEqual(
        expect.objectContaining({ frozen: false }),
      );
    });

    it('is never recorded for an Enterprise Organization', async () => {
      await givenPlan();
      await ctx.db
        .update(subscription)
        .set({ enterprise: true })
        .where(eq(subscription.organizationId, organizationId));

      await postWebhook(
        stripeEvent(
          'customer.subscription.deleted',
          stripeSubscription('canceled'),
        ),
      );

      await expect(standing()).resolves.toEqual(
        expect.objectContaining({ frozen: false }),
      );
    });
  });

  describe('while frozen', () => {
    it('refuses a representative set of writes with "Pay to continue"', async () => {
      const projectId = await project();
      await givenLapsed();

      const writes = [
        request(http)
          .post('/projects')
          .set('Cookie', cookie)
          .send({ name: 'another' }),
        request(http)
          .patch(`/projects/${projectId}`)
          .set('Cookie', cookie)
          .send({ name: 'renamed' }),
        request(http)
          .patch(`/organizations/${organizationId}`)
          .set('Cookie', cookie)
          .send({ name: 'Renamed Labs' }),
        request(http)
          .post('/ssh-keys')
          .set('Cookie', cookie)
          .send({ name: 'deploy-key' }),
        request(http).post('/servers').set('Cookie', cookie).send({
          name: 'new-server',
          ipAddress: '203.0.113.200',
          port: 22,
          username: 'root',
          sshKeyId: 'none',
        }),
        request(http)
          .post('/organizations/invitations')
          .set('Cookie', cookie)
          .send({ email: 'invitee@example.com', role: 'member' }),
        request(http)
          .patch('/billing/invoice-notifications')
          .set('Cookie', cookie)
          .send({ enabled: true }),
      ];

      for (const res of await Promise.all(writes)) {
        expect(res.status).toBe(403);
        expect(res.body).toEqual(expect.objectContaining(FROZEN_LAPSED));
      }
    });

    it('keeps every read working', async () => {
      const projectId = await project();
      await givenLapsed();

      for (const path of [
        '/projects',
        `/projects/${projectId}`,
        '/servers',
        '/billing/subscription',
        '/organizations/active',
      ]) {
        const res = await request(http).get(path).set('Cookie', cookie);
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
      }
    });

    it('lets the members pay', async () => {
      await givenLapsed();
      retrieveCustomer.mockResolvedValue({
        id: 'cus_1',
      } as unknown as Stripe.Customer);
      createCheckoutSession.mockResolvedValue({
        id: 'cs_return',
        url: 'https://checkout.stripe.com/c/pay/cs_return#fid',
      } as unknown as Stripe.Checkout.Session);
      createBillingPortalSession.mockResolvedValue({
        url: 'https://billing.stripe.test/session',
      } as unknown as Stripe.BillingPortal.Session);

      const checkout = await request(http)
        .post('/billing/checkout')
        .set('Cookie', cookie)
        .send({ plan: 'starter', addOns: 0 });
      const portal = await request(http)
        .post('/billing/portal')
        .set('Cookie', cookie);

      expect(checkout.status).toBe(200);
      expect(portal.status).toBe(200);
      expect(portal.body).toEqual({
        url: 'https://billing.stripe.test/session',
      });
    });

    it('lets the members Delete a Service, an Environment, a Project and a Server', async () => {
      const projectId = await project();
      const environmentId = await environmentRow(projectId);
      const [app] = await ctx.db
        .insert(application)
        .values({
          name: 'web',
          environmentId,
          sourceType: 'docker',
          dockerImage: 'acme/web:1',
          configName: 'web',
        })
        .returning();
      const [serverId] = await givenServers(1);
      await givenLapsed();

      const service = await request(http)
        .delete(`/applications/${app.applicationId}`)
        .set('Cookie', cookie);
      expect(service.status).toBe(200);
      const env = await request(http)
        .delete(`/environments/${environmentId}`)
        .set('Cookie', cookie);
      expect(env.status).toBe(200);
      const proj = await request(http)
        .delete(`/projects/${projectId}`)
        .set('Cookie', cookie);
      expect(proj.status).toBe(200);
      const srv = await request(http)
        .delete(`/servers/${serverId}`)
        .set('Cookie', cookie);
      expect(srv.status).toBe(200);
    });

    it('lets the members disconnect a Cloud account', async () => {
      const [account] = await ctx.db
        .insert(cloudAccount)
        .values({
          organizationId,
          name: 'Production AWS',
          cloud: 'aws',
          cloudId: '123456789012',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
          taskExecutionRoleArn:
            'arn:aws:iam::123456789012:role/cloudgate-task-execution',
          externalId: 'external-id-made-by-cloudgate',
          policyVersion: 1,
          lastCheckedAt: new Date().toISOString(),
          lastCheckResult: 'passed',
        })
        .returning();
      await givenLapsed();

      const res = await request(http)
        .delete(`/cloud-accounts/${account.cloudAccountId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
    });

    it('lets a member write to their own account and leave for another Organization', async () => {
      // Ida, a plain member who owns nothing yet: the owner already owns the
      // one Organization that pays for itself a person may (ADR-0059).
      const ida = await signUpMember(http, cookie, {
        email: 'ida@example.com',
        role: 'member',
      });
      const switched = await request(http)
        .post('/api/auth/organization/set-active')
        .set('Cookie', ida.cookie)
        .send({ organizationId });
      expect(switched.status).toBe(200);
      await givenLapsed();

      const profile = await request(http)
        .patch('/users/me')
        .set('Cookie', ida.cookie)
        .send({ firstName: 'Amazing' });
      expect(profile.status).toBe(200);
      const created = await request(http)
        .post('/organizations')
        .set('Cookie', ida.cookie)
        .send({ name: 'Fresh Start' });
      expect(created.status).toBe(201);
    });

    it('lets the owner delete the Organization', async () => {
      // Arrangement only: another Organization the owner owns, which deleting
      // the last one asks for. Written directly, since "New organization"
      // refuses a second that pays for itself (ADR-0059).
      const [other] = await ctx.db
        .insert(organization)
        .values({
          name: 'Fresh Start',
          ownerId,
          createdAt: new Date(),
        })
        .returning({ id: organization.id });
      await ctx.db.insert(member).values({
        organizationId: other.id,
        userId: ownerId,
        role: 'owner',
        createdAt: new Date(),
      });
      await givenLapsed();

      const res = await request(http)
        .delete(`/organizations/${organizationId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
    });

    it('refuses nothing on a Self-hosted instance', async () => {
      await givenLapsed();
      jest
        .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
        .mockReturnValue(false);

      const res = await request(http)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'self-hosted' });

      expect(res.status).toBe(201);
    });
  });

  describe('paying again', () => {
    it('clears the lapse on a new active subscription', async () => {
      await givenLapsed();
      retrieveSubscription.mockResolvedValue(
        stripeSubscription('active', { id: 'sub_2' }),
      );

      const res = await postWebhook(
        stripeEvent('checkout.session.completed', {
          metadata: { organizationId },
          customer: 'cus_1',
          subscription: 'sub_2',
        }),
      );

      expect(res.status).toBe(200);
      await expect(standing()).resolves.toEqual(
        expect.objectContaining({ frozen: false, causes: [], lapsedAt: null }),
      );
      const created = await request(http)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'back-again' });
      expect(created.status).toBe(201);
    });

    it('clears only the lapse, never a suspension', async () => {
      await givenLapsed();
      await ctx.db
        .update(subscription)
        .set({ suspendedAt: new Date(), suspendedReason: 'Sending spam' })
        .where(eq(subscription.organizationId, organizationId));
      retrieveSubscription.mockResolvedValue(
        stripeSubscription('active', { id: 'sub_2' }),
      );

      await postWebhook(
        stripeEvent('checkout.session.completed', {
          metadata: { organizationId },
          customer: 'cus_1',
          subscription: 'sub_2',
        }),
      );

      await expect(standing()).resolves.toEqual(
        expect.objectContaining({
          frozen: true,
          causes: ['suspended'],
          suspendedReason: 'Sending spam',
        }),
      );
      const refused = await request(http)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'still-suspended' });
      expect(refused.body).toEqual(
        expect.objectContaining({
          code: 'ORGANIZATION_FROZEN',
          message: 'Suspended. Contact Octabyte',
        }),
      );
    });

    it('checks out on return with enough Add-ons for the Servers still held', async () => {
      await givenServers(5);
      await givenLapsed();
      retrieveCustomer.mockResolvedValue({
        id: 'cus_1',
      } as unknown as Stripe.Customer);
      createCheckoutSession.mockResolvedValue({
        id: 'cs_return',
        url: 'https://checkout.stripe.com/c/pay/cs_return#fid',
      } as unknown as Stripe.Checkout.Session);

      const res = await request(http)
        .post('/billing/checkout')
        .set('Cookie', cookie)
        .send({ plan: 'starter', addOns: 0 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: 'cs_return',
        url: 'https://checkout.stripe.com/c/pay/cs_return#fid',
        addOns: 2,
      });
      expect(createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_1',
          line_items: [
            { price: PLAN_PRICE, quantity: 1 },
            { price: ADD_ON_PRICE, quantity: 2 },
          ],
        }),
      );
    });
  });
});
