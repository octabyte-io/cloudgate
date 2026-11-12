// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first import.
import { useHostedMode } from '../../utils/hosted-mode';
const hosted = useHostedMode();

import { eq, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';
import { subscription } from '../../../src/cloud/billing/billing.schema';
import {
  LAPSE_CLOCK_JOB_ID,
  LapseClockService,
} from '../../../src/cloud/billing/lapse-clock.service';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { fakeStripe } from '../../utils/fake-stripe';
import {
  application,
  auditLog,
  cloudAccount,
  environment,
  member,
  organization,
  project,
  registry,
  server as serverTable,
  sshKey,
  user,
} from '../../../src/db/schema';
import { MailService } from '../../../src/mail/mail.service';
import { RemoteExecService } from '../../../src/remote/remote-exec.service';
import { SchedulingService } from '../../../src/scheduling/scheduling.service';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../../utils/test-app';

// Frozen Organization, the second half (ADR-0052): the five emails to
// the owner and every admin, the daily job's 3-day and 7-day warnings, and the
// deletion on day 30 — driven through the Stripe webhook and the job's own
// tick with a controlled clock, faking Stripe at STRIPE_API, mail at
// MailService, SSH at RemoteExecService and the clouds at the test app's
// fake cloud ports.

jest.setTimeout(180_000);

const DAY = 24 * 60 * 60 * 1000;
const PLAN_PRICE = hosted.STARTER_PLAN_PRICE_ID;

const retrieveSubscription = jest.fn<Promise<Stripe.Subscription>, [string]>();
const retrieveCustomer = jest.fn<
  Promise<Stripe.Customer | Stripe.DeletedCustomer>,
  [string]
>();
const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();

const stripe = fakeStripe({
  retrieveSubscription,
  retrieveCustomer,
  constructEvent,
});

const stripeSubscription = (
  status: string,
  extra: Partial<Stripe.Subscription> = {},
) =>
  ({
    id: 'sub_1',
    customer: 'cus_1',
    status,
    items: {
      data: [{ id: 'si_plan', price: { id: PLAN_PRICE }, quantity: 1 }],
    },
    ...extra,
  }) as unknown as Stripe.Subscription;

const failedInvoice = {
  id: 'in_1',
  number: 'INV-9',
  customer: 'cus_1',
  subscription: 'sub_1',
  amount_due: 1500,
  amount_paid: 0,
  currency: 'usd',
  created: 1_767_225_600,
  hosted_invoice_url: 'https://invoice.stripe.test/INV-9',
  invoice_pdf: null,
};

const stripeEvent = (type: string, object: unknown) =>
  ({ type, data: { object } }) as unknown as Stripe.Event;

const OWNER = 'grace@example.com';
const ADMIN = 'alan@example.com';
const MEMBER = 'edsger@example.com';

describe('Frozen Organization: lapse emails and the 30-day deletion (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let clock: LapseClockService;
  const mail = new MailRecorder();
  const execMock = { execAsync: jest.fn(), execAsyncRemote: jest.fn() };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: STRIPE_API, useValue: stripe },
        { provide: MailService, useValue: mail },
        { provide: RemoteExecService, useValue: execMock },
      ],
    });
    http = ctx.app.getHttpServer() as App;
    clock = ctx.app.get(LapseClockService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    execMock.execAsync.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
    execMock.execAsyncRemote.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
    await openHostedSignUp(ctx.db);
    const owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: OWNER,
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    cookie = owner.cookie;
    organizationId = owner.organizationId;
    await joins(ADMIN, 'Alan Turing', 'admin');
    await joins(MEMBER, 'Edsger Dijkstra', 'member');
    await givenPlan();
    mail.clear();
    ctx.cloud.calls.length = 0;
    ctx.google.calls.length = 0;
  });

  /** Arrangement only: a confirmed person, in Hopper Labs with `role`. */
  async function joins(email: string, name: string, role: string) {
    const person = await signUpHostedCustomer(http, mail, {
      name,
      email,
      password: 'super-secret-password',
      organizationName: `${name}'s own`,
    });
    await ctx.db.insert(member).values({
      organizationId,
      userId: person.id,
      role,
      createdAt: new Date(),
    });
  }

  /** Arrangement only: the Hosted plan, paid, against `cus_1` / `sub_1`. */
  async function givenPlan(): Promise<void> {
    await ctx.db.insert(subscription).values({
      organizationId,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      plan: 'starter',
      status: 'active',
      addOns: 0,
    });
  }

  function postWebhook(event: Stripe.Event) {
    constructEvent.mockReturnValue(event);
    return request(http)
      .post('/billing/webhook')
      .set('stripe-signature', 't=1,v1=valid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(200);
  }

  async function paymentFails() {
    retrieveSubscription.mockResolvedValue(stripeSubscription('past_due'));
    await postWebhook(stripeEvent('invoice.payment_failed', failedInvoice));
  }

  async function subscriptionEnds(reason: string) {
    await postWebhook(
      stripeEvent(
        'customer.subscription.deleted',
        stripeSubscription('canceled', {
          cancellation_details: { reason } as never,
        }),
      ),
    );
  }

  async function marks() {
    const [row] = await ctx.db
      .select()
      .from(subscription)
      .where(eq(subscription.organizationId, organizationId));
    return row;
  }

  /** The subjects each address received, oldest first. */
  const subjects = (address: string) =>
    mail.to(address).map((sent) => sent.email.subject);

  const after = (from: Date, days: number) =>
    new Date(from.getTime() + days * DAY);

  async function organizationExists(): Promise<boolean> {
    const rows = await ctx.db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId));
    return rows.length > 0;
  }

  it('a payment failure sends all five emails to the owner and admin, each once and on its day', async () => {
    await paymentFails();
    // Stripe's retries fail again: no second email.
    await paymentFails();
    const failedAt = (await marks()).paymentFailedAt!;

    await clock.tick(after(failedAt, 10.9));
    await clock.tick(after(failedAt, 11));
    await clock.tick(after(failedAt, 12));

    await subscriptionEnds('payment_failed');
    const lapsedAt = (await marks()).lapsedAt!;
    const deletesOn = after(lapsedAt, 30);

    await clock.tick(after(lapsedAt, 22.9));
    await clock.tick(after(lapsedAt, 23));
    await clock.tick(after(lapsedAt, 29.9));
    expect(await organizationExists()).toBe(true);
    await clock.tick(after(lapsedAt, 30));
    expect(await organizationExists()).toBe(false);

    const day = (at: Date) =>
      at.toLocaleDateString('en-US', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
      });
    for (const address of [OWNER, ADMIN]) {
      expect(subjects(address)).toEqual([
        'Action required: Cloudgate payment failed - $15.00',
        '3 days left to pay for Hopper Labs on Cloudgate',
        'Hopper Labs is frozen: your Cloudgate payment failed',
        `Hopper Labs will be deleted from Cloudgate on ${day(deletesOn)}`,
        'Hopper Labs has been deleted from Cloudgate',
      ]);
    }
    expect(mail.to(MEMBER)).toEqual([]);
  });

  it('a payment failure is mailed whether or not invoice emails were asked for', async () => {
    expect((await marks()).sendInvoiceNotifications).toBe(false);
    await paymentFails();
    expect(subjects(OWNER)).toEqual([
      'Action required: Cloudgate payment failed - $15.00',
    ]);
    expect(subjects(ADMIN)).toHaveLength(1);
  });

  it('a lapse email goes once, though the customer is deleted after the subscription', async () => {
    await subscriptionEnds('payment_failed');
    await postWebhook(
      stripeEvent('customer.deleted', { id: 'cus_1', deleted: true }),
    );
    expect(subjects(OWNER)).toEqual([
      'Hopper Labs is frozen: your Cloudgate payment failed',
    ]);
  });

  it('a cancel sends only "your plan has ended", the 7-day warning and the deleted email', async () => {
    // The cancel is scheduled for the end of the paid month: nothing yet.
    await postWebhook(
      stripeEvent(
        'customer.subscription.updated',
        stripeSubscription('active', { cancel_at_period_end: true }),
      ),
    );
    expect(mail.sent).toEqual([]);

    await subscriptionEnds('cancellation_requested');
    const lapsedAt = (await marks()).lapsedAt!;
    for (let day = 1; day <= 30; day += 1) {
      await clock.tick(after(lapsedAt, day));
    }

    for (const address of [OWNER, ADMIN]) {
      expect(subjects(address)).toEqual([
        'Your Cloudgate plan for Hopper Labs has ended',
        expect.stringMatching(
          /^Hopper Labs will be deleted from Cloudgate on /,
        ),
        'Hopper Labs has been deleted from Cloudgate',
      ]);
    }
    expect(await organizationExists()).toBe(false);
  });

  it('the daily job runs the same tick under its scheduled id', async () => {
    const scheduling = ctx.app.get(SchedulingService);
    await expect(
      scheduling.runNow(LAPSE_CLOCK_JOB_ID),
    ).resolves.toBeUndefined();
  });

  it('never deletes without the 7-day warning: a late first tick warns, and deletes 7 days on', async () => {
    await subscriptionEnds('cancellation_requested');
    const lapsedAt = (await marks()).lapsedAt!;

    await expect(clock.tick(after(lapsedAt, 40))).resolves.toEqual(
      expect.objectContaining({
        deletionWarned: [organizationId],
        deleted: [],
      }),
    );
    await clock.tick(after(lapsedAt, 46.9));
    expect(await organizationExists()).toBe(true);
    await clock.tick(after(lapsedAt, 47));
    expect(await organizationExists()).toBe(false);
  });

  it('a suspension stops the clock', async () => {
    await subscriptionEnds('cancellation_requested');
    const lapsedAt = (await marks()).lapsedAt!;
    await ctx.db
      .update(subscription)
      .set({ suspendedAt: after(lapsedAt, 5), suspendedReason: 'Abuse' })
      .where(eq(subscription.organizationId, organizationId));
    mail.clear();

    await clock.tick(after(lapsedAt, 23));
    await clock.tick(after(lapsedAt, 60));

    expect(await organizationExists()).toBe(true);
    expect(mail.sent).toEqual([]);
  });

  it('paying again stops the clock', async () => {
    await subscriptionEnds('cancellation_requested');
    const lapsedAt = (await marks()).lapsedAt!;
    await clock.tick(after(lapsedAt, 23));
    await postWebhook(
      stripeEvent(
        'customer.subscription.updated',
        stripeSubscription('active'),
      ),
    );
    mail.clear();

    await clock.tick(after(lapsedAt, 31));
    await clock.tick(after(lapsedAt, 60));

    expect(await organizationExists()).toBe(true);
    expect(mail.sent).toEqual([]);
    expect(await marks()).toEqual(
      expect.objectContaining({
        lapsedAt: null,
        deletionWarnedAt: null,
        paymentFailedAt: null,
      }),
    );
  });

  it('deletion removes the stored data and sends no command to its Servers or clouds', async () => {
    const [key] = await ctx.db
      .insert(sshKey)
      .values({
        name: 'deploy',
        publicKey: 'ssh-ed25519 AAAA test',
        privateKey: 'PRIVATE KEY',
        organizationId,
      })
      .returning();
    const [server] = await ctx.db
      .insert(serverTable)
      .values({
        name: 'web-1',
        ipAddress: '203.0.113.7',
        port: 22,
        organizationId,
        sshKeyId: key.sshKeyId,
      })
      .returning();
    await ctx.db.insert(cloudAccount).values({
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
    });
    await ctx.db.insert(registry).values({
      organizationId,
      name: 'ghcr',
      username: 'grace',
      password: 'registry-secret',
    } as never);
    const [shop] = await ctx.db
      .insert(project)
      .values({ name: 'shop', organizationId } as never)
      .returning();
    const [staging] = await ctx.db
      .insert(environment)
      .values({
        name: 'staging',
        projectId: shop.projectId,
        deployTarget: { kind: 'server', serverId: server.serverId } as never,
      })
      .returning();
    const [web] = await ctx.db
      .insert(application)
      .values({
        name: 'web',
        environmentId: staging.environmentId,
        sourceType: 'docker',
        dockerImage: 'acme/web:1',
        configName: 'web',
        env: 'DATABASE_PASSWORD=hunter2',
      })
      .returning();

    await subscriptionEnds('cancellation_requested');
    const lapsedAt = (await marks()).lapsedAt!;
    await clock.tick(after(lapsedAt, 23));
    await clock.tick(after(lapsedAt, 30));

    // Every table under the Organization, by its own organization_id.
    const rowsLeft: Record<string, number> = {};
    for (const table of [
      'ssh_key',
      'server',
      'cloud_account',
      'registry',
      'project',
      'subscription',
      'member',
    ]) {
      const result = await ctx.db.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(table)} where organization_id = ${organizationId}`,
      );
      rowsLeft[table] = result.rows[0].n;
    }
    expect(rowsLeft).toEqual({
      ssh_key: 0,
      server: 0,
      cloud_account: 0,
      registry: 0,
      project: 0,
      subscription: 0,
      member: 0,
    });
    await expect(
      ctx.db
        .select()
        .from(application)
        .where(eq(application.applicationId, web.applicationId)),
    ).resolves.toEqual([]);
    expect(await organizationExists()).toBe(false);

    // Nothing reached its Server or its clouds.
    expect(execMock.execAsync).not.toHaveBeenCalled();
    expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    expect(ctx.cloud.calls).toEqual([]);
    expect(ctx.google.calls).toEqual([]);

    // The people stay: only the Organization went.
    const people = await ctx.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.email, OWNER));
    expect(people).toHaveLength(1);

    // The platform recorded the delete, as an ordinary delete is recorded.
    const trail = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resourceId, organizationId));
    expect(trail).toEqual([
      expect.objectContaining({
        action: 'delete',
        resourceType: 'organization',
        userRole: 'system',
        userId: null,
      }),
    ]);
  });

  describe('the free trial', () => {
    const TRIAL_END = new Date('2026-12-05T12:00:00Z');
    const trialEndSeconds = TRIAL_END.getTime() / 1000;
    const BUSINESS_PRICE = hosted.BUSINESS_PLAN_PRICE_ID;
    const ADD_ON_PRICE = hosted.ADD_ON_PRICE_ID;

    /** A trialing `sub_1` on `plan` with `addOns`, priced as Stripe sends it. */
    const trialing = (
      plan: 'starter' | 'business' = 'starter',
      addOns = 0,
      extra: Partial<Stripe.Subscription> = {},
    ) =>
      stripeSubscription('trialing', {
        trial_end: trialEndSeconds,
        items: {
          data: [
            {
              id: 'si_plan',
              price: {
                id: plan === 'business' ? BUSINESS_PRICE : PLAN_PRICE,
                unit_amount: plan === 'business' ? 4900 : 1500,
                currency: 'usd',
              },
              quantity: 1,
            },
            ...(addOns > 0
              ? [
                  {
                    id: 'si_add_on',
                    price: {
                      id: ADD_ON_PRICE,
                      unit_amount: 500,
                      currency: 'usd',
                    },
                    quantity: addOns,
                  },
                ]
              : []),
          ],
        } as never,
        ...extra,
      });

    /** Arrangement only: Hopper Labs is in its trial, its start already mailed. */
    async function givenTrial(): Promise<void> {
      await ctx.db
        .update(subscription)
        .set({
          status: 'trialing',
          trialEndsAt: TRIAL_END,
          trialStartedSentAt: new Date(),
        })
        .where(eq(subscription.organizationId, organizationId));
    }

    const htmlTo = (address: string) =>
      mail.to(address).map((sent) => sent.email.html);

    it('starting a trial sends "trial started" to the owner and admin, once', async () => {
      // The customer is stored; the subscription is not yet, as at a first
      // Checkout whose `created` event comes before the others.
      await ctx.db
        .update(subscription)
        .set({ stripeSubscriptionId: null, plan: null, status: null })
        .where(eq(subscription.organizationId, organizationId));

      await postWebhook(
        stripeEvent('customer.subscription.created', trialing('starter', 2)),
      );
      await postWebhook(
        stripeEvent('customer.subscription.updated', trialing('starter', 2)),
      );

      for (const address of [OWNER, ADMIN]) {
        expect(subjects(address)).toEqual([
          'Your 30-day Cloudgate free trial for Hopper Labs has started',
        ]);
        const [html] = htmlTo(address);
        expect(html).toContain('Dec 05, 2026');
        expect(html).toContain('$25.00 per month for Starter with 2 Add-ons');
        expect(html).toContain('Cancel trial');
        expect(html).not.toContain('Manage billing at Stripe');
      }
      expect(mail.to(MEMBER)).toEqual([]);
    });

    /** The trial's card, as Stripe names it on the subscription. */
    const withCard = { default_payment_method: 'pm_card' } as const;

    it('the daily job sends the 7-day reminder once, and not again after a switch', async () => {
      await givenTrial();
      retrieveSubscription.mockResolvedValue(trialing('starter', 1, withCard));

      await clock.tick(after(TRIAL_END, -7.1));
      expect(mail.sent).toEqual([]);

      await expect(clock.tick(after(TRIAL_END, -7))).resolves.toEqual(
        expect.objectContaining({ trialReminded: [organizationId] }),
      );
      await clock.tick(after(TRIAL_END, -6.5));

      // A switch to Business with more Add-ons after the reminder.
      retrieveSubscription.mockResolvedValue(trialing('business', 3, withCard));
      await postWebhook(
        stripeEvent('customer.subscription.updated', trialing('business', 3)),
      );
      await clock.tick(after(TRIAL_END, -6));
      await clock.tick(after(TRIAL_END, -1));

      for (const address of [OWNER, ADMIN]) {
        expect(subjects(address)).toEqual([
          'Your Cloudgate free trial for Hopper Labs ends in 7 days',
        ]);
        const [html] = htmlTo(address);
        expect(html).toContain('Dec 05, 2026');
        expect(html).toContain('$20.00');
        expect(html).toContain('Starter with 1 Add-on');
        expect(html).toContain('https://cloudgate.test/settings/billing');
      }
      expect(mail.to(MEMBER)).toEqual([]);
    });

    it('a cancelled trial gets no 7-day reminder, since it will charge nothing', async () => {
      await givenTrial();
      retrieveSubscription.mockResolvedValue(
        trialing('starter', 1, { ...withCard, cancel_at_period_end: true }),
      );

      await expect(clock.tick(after(TRIAL_END, -7))).resolves.toEqual(
        expect.objectContaining({ trialReminded: [] }),
      );
      expect(mail.sent).toEqual([]);
    });

    it('a trial with no card on file gets no 7-day reminder, and gets it once a card is added', async () => {
      await givenTrial();
      retrieveSubscription.mockResolvedValue(trialing('starter', 1));
      retrieveCustomer.mockResolvedValue({
        id: 'cus_1',
        invoice_settings: { default_payment_method: null },
      } as unknown as Stripe.Customer);

      await expect(clock.tick(after(TRIAL_END, -7))).resolves.toEqual(
        expect.objectContaining({ trialReminded: [] }),
      );
      expect(mail.sent).toEqual([]);

      // "Add a card at Stripe": the customer's default is set.
      retrieveCustomer.mockResolvedValue({
        id: 'cus_1',
        invoice_settings: { default_payment_method: 'pm_card' },
      } as unknown as Stripe.Customer);
      await expect(clock.tick(after(TRIAL_END, -6))).resolves.toEqual(
        expect.objectContaining({ trialReminded: [organizationId] }),
      );
      expect(subjects(OWNER)).toEqual([
        'Your Cloudgate free trial for Hopper Labs ends in 7 days',
      ]);
    });

    it('a cancelled trial sends the trial-worded "your plan has ended", not "lapsed"', async () => {
      await givenTrial();
      await subscriptionEnds('cancellation_requested');

      for (const address of [OWNER, ADMIN]) {
        expect(subjects(address)).toEqual([
          'Your Cloudgate free trial for Hopper Labs has ended',
        ]);
        expect(htmlTo(address)[0]).toContain('you were not charged');
      }
      expect((await marks()).lapsedAt).not.toBeNull();
    });

    it('Stripe\'s missing-card cancel at the trial\'s end sends the same, not "lapsed"', async () => {
      await givenTrial();
      await postWebhook(
        stripeEvent(
          'customer.subscription.deleted',
          stripeSubscription('canceled', {
            trial_end: trialEndSeconds,
            ended_at: trialEndSeconds,
            cancellation_details: { reason: null } as never,
          }),
        ),
      );

      for (const address of [OWNER, ADMIN]) {
        expect(subjects(address)).toEqual([
          'Your Cloudgate free trial for Hopper Labs has ended',
        ]);
        expect(htmlTo(address)[0]).toContain('you were not charged');
      }
      const lapsedAt = (await marks()).lapsedAt!;
      // Then the ordinary ADR-0052 emails follow.
      await clock.tick(after(lapsedAt, 23));
      expect(subjects(OWNER)).toEqual([
        'Your Cloudgate free trial for Hopper Labs has ended',
        expect.stringMatching(
          /^Hopper Labs will be deleted from Cloudgate on /,
        ),
      ]);
    });

    it('a failed first charge keeps the payment-failed path', async () => {
      await givenTrial();
      await paymentFails();
      expect(subjects(OWNER)).toEqual([
        'Action required: Cloudgate payment failed - $15.00',
      ]);
    });
  });

  describe('the owner deleting it', () => {
    it('may delete a Frozen Organization that is their only one', async () => {
      await subscriptionEnds('cancellation_requested');

      const res = await request(http)
        .delete(`/organizations/${organizationId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(await organizationExists()).toBe(false);
    });

    it('may not delete their only Organization while it is not frozen', async () => {
      const res = await request(http)
        .delete(`/organizations/${organizationId}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(403);
      expect(await organizationExists()).toBe(true);
    });
  });
});
