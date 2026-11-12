// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../../utils/hosted-mode';
useHostedMode();

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { subscription } from '../../../src/cloud/billing/billing.schema';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { server as serverTable } from '../../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../../src/deployment-queue/queue.port';
import { MailService } from '../../../src/mail/mail.service';
import { SshKeysService } from '../../../src/ssh-keys/ssh-keys.service';
import { fakeStripe } from '../../utils/fake-stripe';
import { givenPlan } from '../../utils/hosted-plan';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import type { HostedCustomer } from '../../utils/hosted-sign-up';
import { signUpMember } from '../../utils/test-auth';
import { createTestApp, TestAppContext } from '../../utils/test-app';

jest.setTimeout(180_000);

/**
 * **"Add an Organization to this plan"** (ADR-0059): an owner or admin
 * of an Organization on Business or Enterprise, Free trial included, that is
 * not attached itself, makes a new Organization that Organization pays for —
 * `POST /organizations` with `paidBy: 'active-organization'`. Everything is
 * seen from outside: the routes' answers, the Billing reads, the pool's
 * refusals and both audit logs.
 */
describe('Add an Organization to this plan (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  const mail = new MailRecorder();
  /** Grace owns Hopper Labs, the Organization that pays. */
  let grace: HostedCustomer;
  let payingId: string;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        { provide: STRIPE_API, useValue: fakeStripe() },
        {
          provide: DEPLOYMENT_QUEUE,
          useValue: {
            add: jest.fn().mockResolvedValue({ id: 'job-1' }),
            getJobs: jest.fn().mockResolvedValue([]),
            cancel: jest.fn(),
          },
        },
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
    mail.clear();
    await openHostedSignUp(ctx.db);
    grace = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    payingId = grace.organizationId;
  });

  /** "Add an Organization to this plan", from the cookie's active Organization. */
  const addToPlan = (cookie: string, name = 'Turing Works') =>
    request(http)
      .post('/organizations')
      .set('Cookie', cookie)
      .send({ name, paidBy: 'active-organization' });

  /** The "Organizations on this plan" card's read. */
  const onThisPlan = (cookie: string) =>
    request(http).get('/billing/attached-organizations').set('Cookie', cookie);

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

  /** POST /servers as Grace, in her active Organization, with a fresh SSH key. */
  async function addServer(organizationId: string, host: number) {
    const key = await ctx.app.get(SshKeysService).create(
      {
        user: { id: grace.id },
        session: { activeOrganizationId: organizationId },
      },
      { name: `key-${Date.now()}-${Math.random()}` },
    );
    return request(http)
      .post('/servers')
      .set('Cookie', grace.cookie)
      .send({
        name: `new-server-${host}`,
        ipAddress: `198.51.100.${host}`,
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
  }

  /** The link rows of the trail the cookie's active Organization keeps. */
  async function linkRows(cookie: string) {
    const res = await request(http)
      .get('/audit-logs')
      .query({ resourceType: 'organization' })
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (
      res.body as {
        logs: Array<Record<string, unknown> & { metadata: string | null }>;
      }
    ).logs
      .map((row) => ({
        ...row,
        metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
      }))
      .filter((row) => 'link' in row.metadata);
  }

  describe('making one', () => {
    it("makes an Organization its creator owns, with its own members, listed on the Paying Organization's Billing page", async () => {
      await givenPlan(ctx, payingId, 'business');

      const made = await addToPlan(grace.cookie);

      expect(made.status).toBe(201);
      const attached = made.body as {
        id: string;
        name: string;
        ownerId: string;
      };
      expect(attached).toMatchObject({
        name: 'Turing Works',
        ownerId: grace.id,
      });

      const card = await onThisPlan(grace.cookie);
      expect(card.status).toBe(200);
      expect(card.body).toMatchObject({
        name: 'Hopper Labs',
        allowed: true,
        reason: null,
        organizations: [
          {
            id: attached.id,
            name: 'Turing Works',
            owner: { name: 'Grace Hopper', email: 'grace@example.com' },
            ownedByYou: true,
            servers: 0,
            cloudEnvironments: 0,
            boughtServers: 0,
          },
        ],
      });

      await switchTo(grace.cookie, attached.id);
      const members = await request(http)
        .get('/organizations/members')
        .set('Cookie', grace.cookie);
      expect(
        (members.body as { members: Array<{ userId: string; role: string }> })
          .members,
      ).toEqual([expect.objectContaining({ userId: grace.id, role: 'owner' })]);
    });

    it('gives the new Organization its own billing row with no plan and the "first attached at" mark', async () => {
      await givenPlan(ctx, payingId, 'business');

      const made = await addToPlan(grace.cookie);

      const [row] = await ctx.db
        .select()
        .from(subscription)
        .where(
          eq(subscription.organizationId, (made.body as { id: string }).id),
        );
      expect(row).toMatchObject({ plan: null, status: null, addOns: 0 });
      expect(row.firstAttachedAt).toBeInstanceOf(Date);
    });

    it('counts its Servers against the shared pool', async () => {
      await givenPlan(ctx, payingId, 'business');
      await givenServers(payingId, 2);
      const attachedId = (
        (await addToPlan(grace.cookie)).body as { id: string }
      ).id;
      await switchTo(grace.cookie, attachedId);

      const third = await addServer(attachedId, 1);
      expect(third.status).toBe(201);
      const fourth = await addServer(attachedId, 2);
      expect(fourth.status).toBe(403);
      expect(fourth.body).toMatchObject({ code: 'ALLOWANCE_FULL' });

      await switchTo(grace.cookie, payingId);
      const card = await onThisPlan(grace.cookie);
      expect(card.body).toMatchObject({
        free: { servers: 0, cloudEnvironments: 3 },
        organizations: [{ id: attachedId, servers: 1 }],
      });
    });

    it('is offered during a Business Free trial', async () => {
      await givenPlan(ctx, payingId, 'business', 'trialing');

      expect((await onThisPlan(grace.cookie)).body).toMatchObject({
        allowed: true,
      });
      expect((await addToPlan(grace.cookie)).status).toBe(201);
    });

    it('is offered to an admin of the Paying Organization, who owns what they make', async () => {
      await givenPlan(ctx, payingId, 'business');
      const ida = await signUpMember(http, grace.cookie, {
        email: 'ida@example.com',
        role: 'admin',
      });
      await switchTo(ida.cookie, payingId);

      const made = await addToPlan(ida.cookie);

      expect(made.status).toBe(201);
      expect(made.body).toMatchObject({ ownerId: ida.id });
    });

    it('says which of them the reader owns, the one the move-to-Starter checklist offers Delete for', async () => {
      await givenPlan(ctx, payingId, 'business');
      const ida = await signUpMember(http, grace.cookie, {
        email: 'ida@example.com',
        role: 'admin',
      });
      await switchTo(ida.cookie, payingId);
      const idas = (
        (await addToPlan(ida.cookie, 'Rhodes Analytics')).body as {
          id: string;
        }
      ).id;
      const graces = ((await addToPlan(grace.cookie)).body as { id: string })
        .id;

      const ownership = async (cookie: string) =>
        (
          (await onThisPlan(cookie)).body as {
            organizations: Array<{ id: string; ownedByYou: boolean }>;
          }
        ).organizations.map(({ id, ownedByYou }) => ({ id, ownedByYou }));

      expect(await ownership(grace.cookie)).toEqual([
        { id: idas, ownedByYou: false },
        { id: graces, ownedByYou: true },
      ]);
      expect(await ownership(ida.cookie)).toEqual([
        { id: idas, ownedByYou: true },
        { id: graces, ownedByYou: false },
      ]);
    });

    it('says how much of the shared pool is free', async () => {
      await givenPlan(ctx, payingId, 'business', 'active', { addOns: 2 });
      await givenServers(payingId, 1);

      expect((await onThisPlan(grace.cookie)).body).toMatchObject({
        free: { servers: 4, cloudEnvironments: 5 },
      });
    });
  });

  describe('refusals', () => {
    const LIMIT = 'ORGANIZATION_LIMIT';

    it.each<[string, () => Promise<void>, string]>([
      [
        'on Starter',
        () => givenPlan(ctx, payingId, 'starter'),
        'Hopper Labs is on Starter, which pays for one Organization. On Business, Hopper Labs can pay for more Organizations',
      ],
      [
        'with no plan',
        async () => {},
        'Hopper Labs has no plan. On Business, Hopper Labs can pay for more Organizations',
      ],
      [
        'after its plan lapsed',
        () =>
          givenPlan(ctx, payingId, 'business', 'canceled', {
            lapsedAt: new Date(),
          }),
        'Hopper Labs has no plan. On Business, Hopper Labs can pay for more Organizations',
      ],
      [
        'while its move to Starter waits for the end of the paid month',
        () =>
          givenPlan(ctx, payingId, 'business', 'active', {
            stripeScheduleId: 'sub_sched_1',
            downgradeAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
          }),
        'Hopper Labs moves to Starter at the end of its paid month. Keep Business to add an Organization to its plan',
      ],
    ])(
      'refuses %s with ORGANIZATION_LIMIT and its reason',
      async (_case, arrange, reason) => {
        await arrange();

        const refused = await addToPlan(grace.cookie);

        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({ code: LIMIT, message: reason });
        expect((await onThisPlan(grace.cookie)).body).toMatchObject({
          allowed: false,
          reason,
          code: LIMIT,
        });
        const mine = await request(http)
          .get('/organizations')
          .set('Cookie', grace.cookie);
        expect((mine.body as unknown[]).length).toBe(1);
      },
    );

    it('refuses from an Attached Organization, naming who pays for it', async () => {
      await givenPlan(ctx, payingId, 'business');
      const attachedId = (
        (await addToPlan(grace.cookie)).body as { id: string }
      ).id;
      await switchTo(grace.cookie, attachedId);

      const refused = await addToPlan(grace.cookie, 'Babbage Engines');

      const reason =
        'Turing Works is paid for by Hopper Labs, and an Organization that is paid for cannot pay for others';
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: LIMIT, message: reason });
      expect((await onThisPlan(grace.cookie)).body).toMatchObject({
        allowed: false,
        reason,
        organizations: [],
      });
    });

    it('refuses a member who is not an owner or admin first, with the role refusal and nothing about the plan', async () => {
      await givenPlan(ctx, payingId, 'starter');
      const ida = await signUpMember(http, grace.cookie, {
        email: 'ida@example.com',
        role: 'member',
      });
      await switchTo(ida.cookie, payingId);

      const refused = await addToPlan(ida.cookie);

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        message: 'Only owners and admins can add an Organization to this plan',
      });
      expect((refused.body as { code?: string }).code).toBeUndefined();
      expect((await onThisPlan(ida.cookie)).status).toBe(403);
    });
  });

  describe('both audit logs', () => {
    it('record the attach, each naming the other Organization', async () => {
      await givenPlan(ctx, payingId, 'business');
      const attachedId = (
        (await addToPlan(grace.cookie)).body as { id: string }
      ).id;

      const row = {
        action: 'create',
        resourceType: 'organization',
        resourceId: attachedId,
        resourceName: 'Turing Works',
        userId: grace.id,
        userRole: 'owner',
        metadata: {
          link: 'attached',
          payingOrganizationId: payingId,
          payingOrganizationName: 'Hopper Labs',
        },
      };
      expect(await linkRows(grace.cookie)).toEqual([
        expect.objectContaining(row),
      ]);
      await switchTo(grace.cookie, attachedId);
      expect(await linkRows(grace.cookie)).toEqual([
        expect.objectContaining(row),
      ]);
    });
  });

  describe("the Attached Organization's Billing read", () => {
    it('names its Paying Organization, with its own use and the room left on the plan, and no figure for the others', async () => {
      await givenPlan(ctx, payingId, 'business', 'active', { addOns: 1 });
      await givenServers(payingId, 2);
      const attachedId = (
        (await addToPlan(grace.cookie)).body as { id: string }
      ).id;
      await givenServers(attachedId, 1);
      await switchTo(grace.cookie, attachedId);

      const read = await request(http)
        .get('/billing/subscription')
        .set('Cookie', grace.cookie);

      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        plan: null,
        addOns: 0,
        usage: { servers: 1, cloudEnvironments: 0 },
        trialAvailable: false,
        paidBy: {
          name: 'Hopper Labs',
          allowance: { plan: 'business', servers: 4, cloudEnvironments: 4 },
          roomLeft: { servers: 1, cloudEnvironments: 4 },
        },
      });
    });

    it('is null for an Organization that pays for itself', async () => {
      await givenPlan(ctx, payingId, 'business');

      const read = await request(http)
        .get('/billing/subscription')
        .set('Cookie', grace.cookie);

      expect(read.body).toMatchObject({ paidBy: null });
    });
  });

  /**
   * Stories 23–25 and 29: a plain member of an Attached Organization sees its
   * Billing page — who pays, its own use and the room left, and the payer's
   * failing payment — through `GET /billing/attached-plan`, while the owner's
   * and admin's reads stay closed to them.
   */
  describe("a plain member's read of an Attached Organization's Billing page", () => {
    async function givenAttachedWithMember() {
      await givenPlan(ctx, payingId, 'business', 'active', { addOns: 1 });
      await givenServers(payingId, 2);
      const attachedId = (
        (await addToPlan(grace.cookie)).body as { id: string }
      ).id;
      await givenServers(attachedId, 1);
      await switchTo(grace.cookie, attachedId);
      const ida = await signUpMember(http, grace.cookie, {
        email: 'ida@example.com',
        role: 'member',
      });
      await switchTo(ida.cookie, attachedId);
      return { attachedId, ida };
    }

    const attachedPlan = (cookie: string) =>
      request(http).get('/billing/attached-plan').set('Cookie', cookie);

    it('names who pays, with its own use and the room left, and nothing else', async () => {
      const { ida } = await givenAttachedWithMember();

      const read = await attachedPlan(ida.cookie);

      expect(read.status).toBe(200);
      expect(read.body).toEqual({
        paidBy: {
          name: 'Hopper Labs',
          roomLeft: { servers: 1, cloudEnvironments: 4 },
          payForItYourself: null,
        },
        usage: { servers: 1, cloudEnvironments: 0 },
      });
      // No Stripe id, and not the plan's size: with the room left and its own
      // use, that would say what the other Organizations hold.
      expect(read.text).not.toContain('cus_');
      expect(read.text).not.toContain('allowance');
    });

    it("keeps the owner's and admin's reads closed to them", async () => {
      const { ida } = await givenAttachedWithMember();

      for (const path of [
        '/billing/subscription',
        '/billing/invoices',
        '/billing/attached-organizations',
      ]) {
        const read = await request(http).get(path).set('Cookie', ida.cookie);
        expect(read.status).toBe(403);
      }
    });

    it("tells them the payer's payment is failing, through the standing every member reads", async () => {
      const { ida } = await givenAttachedWithMember();
      await givenPlan(ctx, payingId, 'business', 'past_due', { addOns: 1 });

      const standing = await request(http)
        .get('/billing/standing')
        .set('Cookie', ida.cookie);

      expect(standing.status).toBe(200);
      expect(standing.body).toMatchObject({
        payingOrganization: { name: 'Hopper Labs', paymentFailed: true },
      });
    });

    it('offers its own owner "Pay for it yourself" in the same read', async () => {
      await givenAttachedWithMember();

      const read = await attachedPlan(grace.cookie);

      // Grace already owns Hopper Labs, which pays for itself.
      expect(read.body).toMatchObject({
        paidBy: {
          payForItYourself: {
            allowed: false,
            reason:
              'You already own Hopper Labs, and a person can own one Organization that pays for itself',
            code: 'ORGANIZATION_LIMIT',
          },
        },
      });
    });

    it('is empty for an Organization that pays for itself, to a plain member too', async () => {
      await givenPlan(ctx, payingId, 'business');
      const donald = await signUpMember(http, grace.cookie, {
        email: 'donald@example.com',
        role: 'member',
      });
      await switchTo(donald.cookie, payingId);

      const read = await attachedPlan(donald.cookie);

      expect(read.status).toBe(200);
      expect(read.body).toEqual({ paidBy: null, usage: null });
    });
  });

  /**
   * The switcher's list: `GET /organizations` says, for each of the
   * caller's Organizations, whether another pays for it — and which one only
   * when the caller is a member of that payer too, so the console can nest it
   * under the payer. Someone who belongs to the Attached Organization alone is
   * told only that another Organization pays, never which.
   */
  describe("the switcher's list", () => {
    type Listed = {
      id: string;
      name: string;
      paidBy: { organizationId: string | null } | null;
    };
    const myOrganizations = async (cookie: string) => {
      const res = await request(http)
        .get('/organizations')
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      return res;
    };

    it('says nobody else pays for an Organization with nothing attached', async () => {
      const res = await myOrganizations(grace.cookie);

      expect(res.body as Listed[]).toEqual([
        expect.objectContaining({
          id: payingId,
          name: 'Hopper Labs',
          paidBy: null,
        }),
      ]);
    });

    it('names the Paying Organization to a member of both', async () => {
      await givenPlan(ctx, payingId, 'business');
      const attachedId = (
        (await addToPlan(grace.cookie)).body as { id: string }
      ).id;

      const listed = (await myOrganizations(grace.cookie)).body as Listed[];

      expect(listed).toHaveLength(2);
      expect(listed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: payingId, paidBy: null }),
          expect.objectContaining({
            id: attachedId,
            name: 'Turing Works',
            paidBy: { organizationId: payingId },
          }),
        ]),
      );
    });

    it("tells a member of only the Attached Organization that another pays, without the payer's name or id", async () => {
      await givenPlan(ctx, payingId, 'business');
      const attachedId = (
        (await addToPlan(grace.cookie)).body as { id: string }
      ).id;
      await switchTo(grace.cookie, attachedId);
      const ida = await signUpMember(http, grace.cookie, {
        email: 'ida@example.com',
      });

      const res = await myOrganizations(ida.cookie);

      expect(
        (res.body as Listed[]).find((each) => each.id === attachedId),
      ).toMatchObject({
        name: 'Turing Works',
        paidBy: { organizationId: null },
      });
      expect((res.body as Listed[]).map((each) => each.id)).not.toContain(
        payingId,
      );
      expect(res.text).not.toContain('Hopper Labs');
      expect(res.text).not.toContain(payingId);
    });
  });
});
