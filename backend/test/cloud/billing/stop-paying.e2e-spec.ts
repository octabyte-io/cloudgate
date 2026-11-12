// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../../utils/hosted-mode';
const hosted = useHostedMode();

import { asc, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';

import { LapseClockService } from '../../../src/cloud/billing/lapse-clock.service';
import { organizationsPayingForThemselvesOwnedBy } from '../../../src/cloud/billing/paying-organization';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { organization, server as serverTable } from '../../../src/db/schema';
import { auditLog } from '../../../src/enterprise/audit-logs/audit-log.schema';
import { MailService } from '../../../src/mail/mail.service';
import { PermissionService } from '../../../src/rbac/permission.service';
import { fakeStripe } from '../../utils/fake-stripe';
import { givenPlan } from '../../utils/hosted-plan';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import type { HostedCustomer } from '../../utils/hosted-sign-up';
import { signUpMember } from '../../utils/test-auth';
import type { MemberFixture } from '../../utils/test-auth';
import { createTestApp, TestAppContext } from '../../utils/test-app';

jest.setTimeout(180_000);

const DAY = 24 * 60 * 60 * 1000;

const createCheckoutSession = jest.fn<
  Promise<Stripe.Checkout.Session>,
  [Stripe.Checkout.SessionCreateParams]
>();
const retrieveSubscription = jest.fn<Promise<Stripe.Subscription>, [string]>();
const constructEvent = jest.fn<Stripe.Event, [Buffer | string, string]>();
const stripe = fakeStripe({
  createCheckoutSession,
  retrieveSubscription,
  constructEvent,
});

const FROZEN_LAPSED = {
  code: 'ORGANIZATION_FROZEN',
  message: 'Pay to continue',
};

/**
 * **"Stop paying for it"** (ADR-0059). Hopper Labs, Grace's, is on
 * Business. Ida, one of its admins, adds Rhodes Analytics to its plan and so
 * owns it; Donald is a plain member of Hopper Labs. Grace then stops paying
 * for Rhodes Analytics: in one step it is detached and lapses on its own row.
 *
 * Everything is seen from outside: the route's answer, the "Organizations on
 * this plan" card and its pool, Rhodes Analytics' own standing and refusals,
 * the mail sent, the daily job's tick, Checkout and the Stripe webhook. The
 * Attached Organization's own audit log is read off the table: once detached
 * it has no plan, and its trail is a Business read.
 */
describe('Stop paying for it (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let clock: LapseClockService;
  const mail = new MailRecorder();
  /** Owns Hopper Labs, the Paying Organization. */
  let grace: HostedCustomer;
  /** An admin of Hopper Labs, and the owner of Rhodes Analytics. */
  let ida: MemberFixture;
  /** A member of Hopper Labs. */
  let donald: MemberFixture;
  let payingId: string;
  let attachedId: string;

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
    jest.clearAllMocks();
    await ctx.resetDb();
    mail.clear();
    await openHostedSignUp(ctx.db);
    grace = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    payingId = grace.organizationId;
    await givenPlan(ctx, payingId, 'business');
    ida = await signUpMember(http, grace.cookie, {
      email: 'ida@example.com',
      name: 'Ida Rhodes',
      role: 'admin',
    });
    donald = await signUpMember(http, grace.cookie, {
      email: 'donald@example.com',
      name: 'Donald Knuth',
      role: 'member',
    });
    await switchTo(ida.cookie, payingId);
    await switchTo(donald.cookie, payingId);

    const made = await request(http)
      .post('/organizations')
      .set('Cookie', ida.cookie)
      .send({ name: 'Rhodes Analytics', paidBy: 'active-organization' });
    expect(made.status).toBe(201);
    attachedId = (made.body as { id: string }).id;
    await givenServers(attachedId, 2);
    mail.clear();
  });

  /** Points the cookie's session at another of its Organizations. */
  async function switchTo(cookie: string, organizationId: string) {
    const res = await request(http)
      .post('/api/auth/organization/set-active')
      .set('Cookie', cookie)
      .send({ organizationId });
    expect(res.status).toBe(200);
  }

  /** Arrangement only: `count` Servers in the Organization. */
  async function givenServers(organizationId: string, count: number) {
    await ctx.db.insert(serverTable).values(
      Array.from({ length: count }, (_, index) => ({
        name: `${organizationId}-server-${index + 1}`,
        ipAddress: `203.0.113.${index + 1}`,
        port: 22,
        organizationId,
      })),
    );
  }

  /** "Stop paying for it", from the cookie's active Organization. */
  const stopPaying = (cookie: string, organizationId = attachedId) =>
    request(http)
      .post(`/billing/attached-organizations/${organizationId}/stop-paying`)
      .set('Cookie', cookie);

  /** The "Organizations on this plan" card's read. */
  async function onThisPlan(cookie: string) {
    const res = await request(http)
      .get('/billing/attached-organizations')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as {
      free: { servers: number; cloudEnvironments: number };
      organizations: Array<{ id: string; name: string }>;
    };
  }

  async function standing(cookie: string) {
    const res = await request(http)
      .get('/billing/standing')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as {
      frozen: boolean;
      causes: string[];
      lapsedAt: string | null;
      payingOrganization: unknown;
    };
  }

  /** The link rows an Organization's audit log keeps, oldest first. */
  async function linkRowsOf(organizationId: string) {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.organizationId, organizationId))
      .orderBy(asc(auditLog.createdAt));
    return rows
      .map((row) => ({
        ...row,
        metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
      }))
      .filter((row) => 'link' in row.metadata);
  }

  const subjects = (address: string) =>
    mail.to(address).map((sent) => sent.email.subject);

  const after = (from: Date, days: number) =>
    new Date(from.getTime() + days * DAY);

  describe('after "Stop paying for it"', () => {
    it('answers when it lapsed and the day it is deleted, 30 days on', async () => {
      const before = Date.now();

      const res = await stopPaying(grace.cookie);

      expect(res.status).toBe(200);
      const body = res.body as {
        organizationId: string;
        lapsedAt: string;
        deletesOn: string;
      };
      expect(body.organizationId).toBe(attachedId);
      const lapsedAt = new Date(body.lapsedAt).getTime();
      expect(lapsedAt).toBeGreaterThanOrEqual(before - 1000);
      expect(new Date(body.deletesOn).getTime() - lapsedAt).toBe(30 * DAY);
    });

    it('takes it off the plan, and its Servers out of the pool', async () => {
      const before = await onThisPlan(grace.cookie);
      expect(before.organizations.map((one) => one.name)).toEqual([
        'Rhodes Analytics',
      ]);

      await stopPaying(grace.cookie).expect(200);

      const now = await onThisPlan(grace.cookie);
      expect(now.organizations).toEqual([]);
      expect(now.free.servers - before.free.servers).toBe(2);
    });

    it('freezes it at once, on its own lapse rather than through a link', async () => {
      await stopPaying(grace.cookie).expect(200);
      await switchTo(ida.cookie, attachedId);

      expect(await standing(ida.cookie)).toMatchObject({
        frozen: true,
        causes: ['lapsed'],
        payingOrganization: null,
      });
      const refused = await request(http)
        .post('/projects')
        .set('Cookie', ida.cookie)
        .send({ name: 'shop' });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject(FROZEN_LAPSED);

      // Hopper Labs itself is untouched.
      expect(await standing(grace.cookie)).toMatchObject({ frozen: false });
    });

    it('emails its owner only, saying it is frozen, has left the plan and when it is deleted', async () => {
      const res = await stopPaying(grace.cookie).expect(200);
      const { deletesOn } = res.body as { deletesOn: string };

      expect(subjects('ida@example.com')).toEqual([
        'Rhodes Analytics is frozen: Hopper Labs has stopped paying for it',
      ]);
      const day = new Date(deletesOn).toLocaleDateString('en-US', {
        month: 'short',
        day: '2-digit',
        year: 'numeric',
      });
      expect(mail.to('ida@example.com')[0].email.html).toContain(day);
      expect(subjects('grace@example.com')).toEqual([]);
      expect(subjects('donald@example.com')).toEqual([]);
    });

    it('records stoppedPaying in both logs as the person who did it, naming where they acted from where they are no member', async () => {
      await stopPaying(grace.cookie).expect(200);

      const link = {
        link: 'stoppedPaying',
        payingOrganizationId: payingId,
        payingOrganizationName: 'Hopper Labs',
      };
      const row = {
        action: 'update',
        resourceType: 'organization',
        resourceId: attachedId,
        resourceName: 'Rhodes Analytics',
        userId: grace.id,
        userEmail: 'grace@example.com',
        userRole: 'owner',
      };
      const attachedRow: unknown = expect.objectContaining({
        metadata: expect.objectContaining({ link: 'attached' }) as unknown,
      });
      expect(await linkRowsOf(payingId)).toEqual([
        attachedRow,
        expect.objectContaining({ ...row, metadata: link }),
      ]);
      expect(await linkRowsOf(attachedId)).toEqual([
        attachedRow,
        expect.objectContaining({
          ...row,
          metadata: {
            ...link,
            actedFromOrganizationId: payingId,
            actedFromOrganizationName: 'Hopper Labs',
          },
        }),
      ]);
    });

    it('counts it as an Organization its owner pays for themselves', async () => {
      const ownedBy = async (userId: string) =>
        (
          await organizationsPayingForThemselvesOwnedBy(
            ctx.db,
            userId,
            await ctx.app.get(PermissionService).instanceOrganizationId(),
          )
        ).map((one) => one.name);
      expect(await ownedBy(ida.id)).toEqual([]);

      await stopPaying(grace.cookie).expect(200);

      expect(await ownedBy(ida.id)).toEqual(['Rhodes Analytics']);
    });
  });

  describe('its own 30-day clock', () => {
    it('warns its owner and deletes it on day 30, leaving the Paying Organization', async () => {
      const res = await stopPaying(grace.cookie).expect(200);
      const lapsedAt = new Date((res.body as { lapsedAt: string }).lapsedAt);
      mail.clear();

      await clock.tick(after(lapsedAt, 23));
      expect(subjects('ida@example.com')).toEqual([
        expect.stringContaining(
          'Rhodes Analytics will be deleted from Cloudgate on',
        ),
      ]);

      await expect(clock.tick(after(lapsedAt, 30))).resolves.toMatchObject({
        deleted: [attachedId],
      });
      const left = await ctx.db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, payingId));
      expect(left).toHaveLength(1);
      expect(subjects('ida@example.com')).toContain(
        'Rhodes Analytics has been deleted from Cloudgate',
      );
      expect(subjects('grace@example.com')).toEqual([]);
    });
  });

  describe('its owner paying for it', () => {
    it('goes through Checkout with no Free trial, and the new subscription lifts the lapse', async () => {
      await stopPaying(grace.cookie).expect(200);
      await switchTo(ida.cookie, attachedId);
      createCheckoutSession.mockResolvedValue({
        id: 'cs_rhodes',
        url: 'https://checkout.stripe.com/c/pay/cs_rhodes#fid',
      } as Stripe.Checkout.Session);

      const checkout = await request(http)
        .post('/billing/checkout')
        .set('Cookie', ida.cookie)
        .send({ plan: 'business', addOns: 0 });

      expect(checkout.status).toBe(200);
      const params = createCheckoutSession.mock.calls.at(-1)?.[0] as {
        metadata: Record<string, string>;
        subscription_data: { trial_period_days?: number };
      };
      expect(params.metadata).toMatchObject({ organizationId: attachedId });
      expect(params.subscription_data.trial_period_days).toBeUndefined();

      retrieveSubscription.mockResolvedValue({
        id: 'sub_rhodes',
        customer: 'cus_rhodes',
        status: 'active',
        items: {
          data: [
            {
              id: 'si_plan',
              price: { id: hosted.BUSINESS_PLAN_PRICE_ID },
              quantity: 1,
            },
          ],
        },
      } as unknown as Stripe.Subscription);
      const event = {
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: { organizationId: attachedId },
            customer: 'cus_rhodes',
            subscription: 'sub_rhodes',
          },
        },
      } as unknown as Stripe.Event;
      constructEvent.mockReturnValue(event);
      await request(http)
        .post('/billing/webhook')
        .set('stripe-signature', 't=1,v1=valid')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event))
        .expect(200);

      expect(await standing(ida.cookie)).toMatchObject({
        frozen: false,
        causes: [],
      });
    });

    it('is refused with ORGANIZATION_LIMIT when its owner already owns another Organization that pays for itself', async () => {
      await ctx.db
        .insert(organization)
        .values({ name: 'Bletchley', ownerId: ida.id, createdAt: new Date() });
      await stopPaying(grace.cookie).expect(200);
      await switchTo(ida.cookie, attachedId);

      const refused = await request(http)
        .post('/billing/checkout')
        .set('Cookie', ida.cookie)
        .send({ plan: 'business', addOns: 0 });

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'ORGANIZATION_LIMIT',
        message:
          'You already own Bletchley, and a person can own one Organization that pays for itself',
      });
      // Nothing reached Stripe.
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it('is refused to one of its admins too while its owner owns another, naming no other Organization', async () => {
      await switchTo(ida.cookie, attachedId);
      const alan = await signUpMember(http, ida.cookie, {
        email: 'alan@example.com',
        name: 'Alan Turing',
        role: 'admin',
      });
      await switchTo(alan.cookie, attachedId);
      await ctx.db
        .insert(organization)
        .values({ name: 'Bletchley', ownerId: ida.id, createdAt: new Date() });
      await stopPaying(grace.cookie).expect(200);

      const refused = await request(http)
        .post('/billing/checkout')
        .set('Cookie', alan.cookie)
        .send({ plan: 'business', addOns: 0 });

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'ORGANIZATION_LIMIT',
        message:
          "Rhodes Analytics's owner already owns another Organization that pays for itself, and a person can own one",
      });
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });
  });

  describe('who can do it', () => {
    it('lets the owner of a frozen Paying Organization do it, while its other writes stay refused', async () => {
      await givenPlan(ctx, payingId, 'business', 'canceled', {
        lapsedAt: new Date(),
      });
      expect(await standing(grace.cookie)).toMatchObject({ frozen: true });
      const project = await request(http)
        .post('/projects')
        .set('Cookie', grace.cookie)
        .send({ name: 'shop' });
      expect(project.status).toBe(403);
      expect(project.body).toMatchObject(FROZEN_LAPSED);

      await stopPaying(grace.cookie).expect(200);

      expect((await onThisPlan(grace.cookie)).organizations).toEqual([]);
    });

    it('refuses a member of the Paying Organization, before saying anything about the plan', async () => {
      const refused = await stopPaying(donald.cookie);

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        message: 'Only owners and admins can stop paying for an Organization',
      });
      expect(await onThisPlan(grace.cookie)).toMatchObject({
        organizations: [expect.objectContaining({ id: attachedId })],
      });
    });

    it('lets an admin of the Paying Organization do it', async () => {
      await switchTo(ida.cookie, payingId);

      await stopPaying(ida.cookie).expect(200);

      expect((await onThisPlan(grace.cookie)).organizations).toEqual([]);
    });

    it('refuses an Organization that is not on this plan: a second click, or one it never paid for', async () => {
      await stopPaying(grace.cookie).expect(200);

      const again = await stopPaying(grace.cookie);
      expect(again.status).toBe(404);
      expect(again.body).toMatchObject({
        message: 'This Organization is not on this plan',
      });

      const never = await stopPaying(grace.cookie, payingId);
      expect(never.status).toBe(404);
      // Nothing was sent or recorded twice.
      expect(subjects('ida@example.com')).toHaveLength(1);
      expect(
        (await linkRowsOf(payingId)).filter(
          (row) => row.metadata.link === 'stoppedPaying',
        ),
      ).toHaveLength(1);
    });

    it("refuses the Attached Organization's own owner from inside it: only the payer stops paying", async () => {
      await switchTo(ida.cookie, attachedId);

      const refused = await stopPaying(ida.cookie);

      expect(refused.status).toBe(404);
      expect((await onThisPlan(grace.cookie)).organizations).toHaveLength(1);
    });
  });
});
