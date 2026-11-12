// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
const hosted = useHostedMode();

import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';

import { subscription } from '../../src/cloud/billing/billing.schema';
import { LapseClockService } from '../../src/cloud/billing/lapse-clock.service';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import { fakeStripe } from '../utils/fake-stripe';
import { member, organization } from '../../src/db/schema';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { MailService } from '../../src/mail/mail.service';
import {
  HOSTED_STAFF,
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import type { HostedCustomer } from '../utils/hosted-sign-up';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const DAY = 24 * 60 * 60 * 1000;
const PLAN_PRICE = hosted.STARTER_PLAN_PRICE_ID;
const SUSPENDED = 'Suspended. Contact Octabyte';
const REASON = 'Crypto mining on a shared runner, against the terms';
const OPERATOR_REFUSAL =
  'Only an owner or admin of the Instance organization can use the Operator page';

const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();
const stripe = fakeStripe({
  constructEvent,
});

const stripeSubscription = (status: string) =>
  ({
    id: 'sub_1',
    customer: 'cus_1',
    status,
    items: {
      data: [{ id: 'si_plan', price: { id: PLAN_PRICE }, quantity: 1 }],
    },
    cancellation_details: { reason: 'cancellation_requested' },
  }) as unknown as Stripe.Subscription;

const stripeEvent = (type: string, object: unknown) =>
  ({ type, data: { object } }) as unknown as Stripe.Event;

const ADMIN = 'alan@example.com';

interface AuditRow {
  organizationId: string | null;
  userId: string | null;
  userEmail: string | null;
  userRole: string;
  userName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  resourceName: string | null;
  metadata: string | null;
}

/**
 * The Operator's suspend and lift (ADR-0050, ADR-0052): the second
 * Frozen cause, set and cleared only by an Operator, never by a payment; it
 * stops the 30-day deletion clock, emails the owners, and leaves a row in the
 * customer's own audit log and a copy in the Instance organization's.
 */
describe('The Operator suspends and lifts an Organization (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let staffCookie: string;
  let instanceOrganizationId: string;
  let grace: HostedCustomer;
  let clock: LapseClockService;
  const mail = new MailRecorder();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: STRIPE_API, useValue: stripe },
        { provide: MailService, useValue: mail },
      ],
    });
    http = ctx.app.getHttpServer() as App;
    clock = ctx.app.get(LapseClockService);
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await ctx.resetDb();
    instanceOrganizationId = (await openHostedSignUp(ctx.db)).organizationId;
    staffCookie = await signIn(HOSTED_STAFF.email, HOSTED_STAFF.password);
    grace = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    const alan = await signUpHostedCustomer(http, mail, {
      name: 'Alan Turing',
      email: ADMIN,
      password: 'super-secret-password',
      organizationName: 'Turing Works',
    });
    await ctx.db.insert(member).values({
      organizationId: grace.organizationId,
      userId: alan.id,
      role: 'admin',
      createdAt: new Date(),
    });
    await givenPlan();
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

  /** Arrangement only: Hopper Labs on the Hosted plan, paid. */
  async function givenPlan(): Promise<void> {
    await ctx.db.insert(subscription).values({
      organizationId: grace.organizationId,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      plan: 'starter',
      status: 'active',
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

  const planEnds = () =>
    postWebhook(
      stripeEvent(
        'customer.subscription.deleted',
        stripeSubscription('canceled'),
      ),
    );

  const pays = () =>
    postWebhook(
      stripeEvent(
        'customer.subscription.updated',
        stripeSubscription('active'),
      ),
    );

  const suspend = (
    organizationId = grace.organizationId,
    cookie = staffCookie,
    reason: unknown = REASON,
  ) =>
    request(http)
      .post(`/operator/organizations/${organizationId}/suspension`)
      .set('Cookie', cookie)
      .send({ reason });

  const lift = (organizationId = grace.organizationId, cookie = staffCookie) =>
    request(http)
      .delete(`/operator/organizations/${organizationId}/suspension`)
      .set('Cookie', cookie);

  async function standing() {
    const res = await request(http)
      .get('/billing/standing')
      .set('Cookie', grace.cookie);
    expect(res.status).toBe(200);
    return res.body as {
      frozen: boolean;
      causes: string[];
      suspendedReason: string | null;
    };
  }

  const createProject = () =>
    request(http)
      .post('/projects')
      .set('Cookie', grace.cookie)
      .send({ name: 'shop' });

  async function marks() {
    const [row] = await ctx.db
      .select()
      .from(subscription)
      .where(eq(subscription.organizationId, grace.organizationId));
    return row;
  }

  async function organizationExists(): Promise<boolean> {
    const rows = await ctx.db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, grace.organizationId));
    return rows.length > 0;
  }

  const after = (from: Date, days: number) =>
    new Date(from.getTime() + days * DAY);

  const subjects = (address: string) =>
    mail.to(address).map((sent) => sent.email.subject);

  async function trail(cookie: string): Promise<AuditRow[]> {
    const res = await request(http)
      .get('/audit-logs')
      .query({ resourceType: 'organization' })
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { logs: AuditRow[] }).logs;
  }

  it('freezes the Organization with "Suspended. Contact Octabyte" and the reason; lifting clears it', async () => {
    const res = await suspend();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reason: REASON });
    expect(await standing()).toMatchObject({
      frozen: true,
      causes: ['suspended'],
      suspendedReason: REASON,
    });
    const refused = await createProject();
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      code: 'ORGANIZATION_FROZEN',
      message: SUSPENDED,
    });
    const listed = await request(http)
      .get('/operator/organizations')
      .set('Cookie', staffCookie);
    expect(
      (listed.body as { id: string; suspension: unknown }[]).find(
        (row) => row.id === grace.organizationId,
      )?.suspension,
    ).toEqual({ reason: REASON, suspendedAt: expect.any(String) as string });

    expect((await lift()).status).toBe(204);

    expect(await standing()).toMatchObject({
      frozen: false,
      causes: [],
      suspendedReason: null,
    });
    expect((await createProject()).status).toBe(201);
  });

  it('lifting clears only the suspension: a lapsed Organization stays frozen with "Pay to continue"', async () => {
    await planEnds();
    await suspend();
    expect((await standing()).causes.sort()).toEqual(['lapsed', 'suspended']);

    await lift();

    expect(await standing()).toMatchObject({
      frozen: true,
      causes: ['lapsed'],
    });
    expect((await createProject()).body).toMatchObject({
      code: 'ORGANIZATION_FROZEN',
      message: 'Pay to continue',
    });
  });

  it('paying while suspended does not lift the suspension', async () => {
    await planEnds();
    await suspend();

    await pays();

    expect(await standing()).toMatchObject({
      frozen: true,
      causes: ['suspended'],
      suspendedReason: REASON,
    });
    expect((await createProject()).body).toMatchObject({ message: SUSPENDED });
  });

  it('suspends an Enterprise Organization too', async () => {
    await ctx.db
      .update(subscription)
      .set({ enterprise: true, enterpriseServers: 5 })
      .where(eq(subscription.organizationId, grace.organizationId));

    expect((await suspend()).status).toBe(200);
    expect(await standing()).toMatchObject({ causes: ['suspended'] });
  });

  it('a suspended lapsed Organization is not deleted on day 30; after lifting, deletion comes 7 days after a fresh warning', async () => {
    await planEnds();
    const lapsedAt = (await marks()).lapsedAt!;
    // The 7-day warning has gone out before the Operator steps in.
    await clock.tick(after(lapsedAt, 23));
    expect((await marks()).deletionWarnedAt).not.toBeNull();
    await suspend();

    await clock.tick(after(lapsedAt, 30));
    await clock.tick(after(lapsedAt, 60));
    expect(await organizationExists()).toBe(true);

    await lift();
    expect((await marks()).deletionWarnedAt).toBeNull();
    mail.clear();

    const warned = await clock.tick(after(lapsedAt, 61));
    expect(warned.deletionWarned).toEqual([grace.organizationId]);
    expect(subjects('grace@example.com')).toEqual([
      expect.stringMatching(/^Hopper Labs will be deleted from Cloudgate on /),
    ]);
    await clock.tick(after(lapsedAt, 67.9));
    expect(await organizationExists()).toBe(true);
    await clock.tick(after(lapsedAt, 68));
    expect(await organizationExists()).toBe(false);
  });

  it('emails the owners on suspend and on lift', async () => {
    await suspend();

    expect(subjects('grace@example.com')).toEqual([
      'Hopper Labs has been suspended on Cloudgate',
    ]);
    expect(mail.to('grace@example.com')[0].email.html).toContain(REASON);
    // Owners, not admins.
    expect(mail.to(ADMIN)).toEqual([]);
    mail.clear();

    await lift();

    expect(subjects('grace@example.com')).toEqual([
      'The suspension of Hopper Labs on Cloudgate has been lifted',
    ]);
    expect(mail.to(ADMIN)).toEqual([]);
  });

  it("writes each in the Organization's own log, naming the Operator and marked as Octabyte, with a copy in the Instance organization's", async () => {
    await suspend();
    await lift();

    const operatorRow = (type: string, organizationId: string) =>
      expect.objectContaining({
        organizationId,
        userEmail: HOSTED_STAFF.email,
        userName: `${HOSTED_STAFF.firstName} ${HOSTED_STAFF.lastName}`,
        action: 'update',
        resourceType: 'organization',
        resourceId: grace.organizationId,
        resourceName: 'Hopper Labs',
        metadata: expect.stringContaining(`"type":"${type}"`) as string,
      }) as AuditRow;

    const customers = await trail(grace.cookie);
    expect(customers).toEqual(
      expect.arrayContaining([
        operatorRow('suspendOrganization', grace.organizationId),
        operatorRow('liftSuspension', grace.organizationId),
      ]),
    );
    const byOperator = customers.filter(
      (r) => r.userEmail === HOSTED_STAFF.email,
    );
    expect(byOperator).toHaveLength(2);
    for (const row of byOperator) {
      expect(row.userRole).toBe('operator');
      expect(JSON.parse(row.metadata!)).toMatchObject({ actedBy: 'Octabyte' });
    }
    expect(
      JSON.parse(
        customers.find((r) => r.metadata?.includes('suspendOrganization'))!
          .metadata!,
      ),
    ).toMatchObject({ reason: REASON });

    const instance = await trail(staffCookie);
    expect(instance).toEqual(
      expect.arrayContaining([
        operatorRow('suspendOrganization', instanceOrganizationId),
        operatorRow('liftSuspension', instanceOrganizationId),
      ]),
    );
  });

  describe('refusals', () => {
    it('refuses anybody but an Operator, and writes nothing', async () => {
      const member = await signUpMember(http, staffCookie, {
        email: 'ops-member@octabyte.test',
        role: 'member',
      });

      for (const cookie of [grace.cookie, member.cookie]) {
        const res = await suspend(grace.organizationId, cookie);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ message: OPERATOR_REFUSAL });
        expect((await lift(grace.organizationId, cookie)).status).toBe(403);
      }
      expect((await marks()).suspendedAt).toBeNull();
      expect(mail.sent).toEqual([]);
    });

    it('lets an admin of the Instance organization suspend', async () => {
      const admin = await signUpMember(http, staffCookie, {
        email: 'ops-admin@octabyte.test',
        role: 'admin',
      });

      expect((await suspend(grace.organizationId, admin.cookie)).status).toBe(
        200,
      );
      expect((await marks()).suspendedBy).toBe(admin.id);
    });

    it('asks for a reason', async () => {
      const res = await suspend(grace.organizationId, staffCookie, '   ');

      expect(res.status).toBe(400);
      expect((await marks()).suspendedAt).toBeNull();
    });

    it('refuses a second suspend, a lift of nothing, an unknown Organization and the Instance organization', async () => {
      expect((await lift()).status).toBe(409);
      expect((await suspend()).status).toBe(200);
      const again = await suspend(grace.organizationId, staffCookie, 'Other');
      expect(again.status).toBe(409);
      expect((await marks()).suspendedReason).toBe(REASON);

      expect((await suspend('no-such-organization')).status).toBe(404);
      const instance = await suspend(instanceOrganizationId);
      expect(instance.status).toBe(409);
      expect(instance.body).toMatchObject({
        message: 'The Instance organization cannot be suspended',
      });
    });

    it('does not exist on a Self-hosted instance', async () => {
      jest
        .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
        .mockReturnValue(false);

      expect((await suspend()).status).toBe(404);
      expect((await lift()).status).toBe(404);
    });
  });
});
