// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import { MailService } from '../../src/mail/mail.service';
import {
  member,
  organization,
} from '../../src/organizations/organizations.schema';
import { fakeStripe } from '../utils/fake-stripe';
import { givenPlan } from '../utils/hosted-plan';
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

const LIMIT = 'ORGANIZATION_LIMIT';
const ALREADY_OWNS =
  'You already own Hopper Labs, and a person can own one Organization that pays for itself';
const UPSELL = 'On Business, Hopper Labs can pay for more Organizations';

/**
 * **"New organization" on the Hosted instance** (ADR-0059): a person
 * owns at most one Organization that pays for itself. `POST /organizations`
 * (paid for by itself, the default) refuses a second with 403
 * `ORGANIZATION_LIMIT` and the reason, and `GET /organizations/creation` says
 * the same before anyone clicks, with how many they own and, to the open
 * Organization's owners and admins, the upsell and where to go. Only creating
 * is limited: Attached Organizations they own and the Instance organization do
 * not count.
 */
describe('The one-Organization limit on the Hosted instance (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  const mail = new MailRecorder();
  /** Grace owns Hopper Labs, which pays for itself. */
  let grace: HostedCustomer;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        { provide: STRIPE_API, useValue: fakeStripe() },
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
  });

  const create = (cookie: string, body: Record<string, unknown> = {}) =>
    request(http)
      .post('/organizations')
      .set('Cookie', cookie)
      .send({ name: 'Second Shop', ...body });

  const creation = (cookie: string) =>
    request(http).get('/organizations/creation').set('Cookie', cookie);

  async function switchTo(cookie: string, organizationId: string) {
    const res = await request(http)
      .post('/api/auth/organization/set-active')
      .set('Cookie', cookie)
      .send({ organizationId });
    expect(res.status).toBe(200);
  }

  async function signIn(email: string, password: string): Promise<string> {
    const res = await request(http)
      .post('/api/auth/sign-in/email')
      .send({ email, password });
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
  }

  async function ownedNames(userId: string): Promise<string[]> {
    const rows = await ctx.db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.ownerId, userId))
      .orderBy(organization.createdAt);
    return rows.map((row) => row.name);
  }

  describe('a Starter owner', () => {
    beforeEach(async () => {
      await givenPlan(ctx, grace.organizationId, 'starter');
    });

    it('is refused a second Organization with ORGANIZATION_LIMIT, the reason and the upsell', async () => {
      const res = await create(grace.cookie);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: LIMIT,
        message: `${ALREADY_OWNS}. ${UPSELL}`,
      });
      await expect(ownedNames(grace.id)).resolves.toEqual(['Hopper Labs']);
    });

    it('is told the same before clicking, with the count and "See plans"', async () => {
      const res = await creation(grace.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        allowed: false,
        reason: `${ALREADY_OWNS}. ${UPSELL}`,
        code: LIMIT,
        licenseHint: false,
        overLimit: null,
        ownedPayingForThemselves: { count: 1, of: 1 },
        planHint: { kind: 'see-plans' },
      });
    });

    it('refuses the same with paidBy itself named', async () => {
      const res = await create(grace.cookie, { paidBy: 'itself' });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: LIMIT });
    });
  });

  it('refuses an owner with no plan too: a lapsed or unpaid Organization still counts', async () => {
    const res = await create(grace.cookie);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: LIMIT,
      message: `${ALREADY_OWNS}. ${UPSELL}`,
    });
  });

  describe('a Business owner', () => {
    beforeEach(async () => {
      await givenPlan(ctx, grace.organizationId, 'business');
    });

    it('is refused, and pointed at "Add an Organization to Hopper Labs\'s plan"', async () => {
      const refused = await create(grace.cookie);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: LIMIT,
        message: `${ALREADY_OWNS}. Hopper Labs can pay for more Organizations on its plan`,
      });

      const res = await creation(grace.cookie);
      expect(res.body).toMatchObject({
        allowed: false,
        code: LIMIT,
        reason: `${ALREADY_OWNS}. Hopper Labs can pay for more Organizations on its plan`,
        planHint: { kind: 'add-to-plan', organizationName: 'Hopper Labs' },
      });
    });

    it('still makes one its plan pays for: that create is not limited', async () => {
      const res = await create(grace.cookie, { paidBy: 'active-organization' });

      expect(res.status).toBe(201);
    });
  });

  describe('someone who is not an owner or admin of the open Organization', () => {
    it('gets the reason without the upsell or a pointer', async () => {
      // Ida owns Rhodes Ltd, and is a plain member of Hopper Labs, open now.
      const ida = await signUpMember(http, grace.cookie, {
        email: 'ida@example.com',
        role: 'member',
      });
      const [rhodes] = await ctx.db
        .insert(organization)
        .values({ name: 'Rhodes Ltd', ownerId: ida.id, createdAt: new Date() })
        .returning({ id: organization.id });
      await ctx.db.insert(member).values({
        organizationId: rhodes.id,
        userId: ida.id,
        role: 'owner',
        createdAt: new Date(),
      });
      await switchTo(ida.cookie, grace.organizationId);

      const refused = await create(ida.cookie);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: LIMIT,
        message:
          'You already own Rhodes Ltd, and a person can own one Organization that pays for itself',
      });

      const res = await creation(ida.cookie);
      expect(res.body).toMatchObject({
        allowed: false,
        reason:
          'You already own Rhodes Ltd, and a person can own one Organization that pays for itself',
        code: LIMIT,
        planHint: null,
        ownedPayingForThemselves: { count: 1, of: 1 },
      });
    });

    it('may still create their first one, as any confirmed person may', async () => {
      const ida = await signUpMember(http, grace.cookie, {
        email: 'ida@example.com',
        role: 'member',
      });
      await switchTo(ida.cookie, grace.organizationId);

      expect((await creation(ida.cookie)).body).toMatchObject({
        allowed: true,
        reason: null,
        code: null,
        planHint: null,
        ownedPayingForThemselves: { count: 0, of: 1 },
      });
      const made = await create(ida.cookie);
      expect(made.status).toBe(201);
      expect(made.body).toMatchObject({ ownerId: ida.id });
    });
  });

  it('does not count an Attached Organization someone owns', async () => {
    // Ida, an admin of Hopper Labs on Business, makes one it pays for, and
    // owns it. She owns nothing that pays for itself.
    await givenPlan(ctx, grace.organizationId, 'business');
    const ida = await signUpMember(http, grace.cookie, {
      email: 'ida@example.com',
      role: 'admin',
    });
    await switchTo(ida.cookie, grace.organizationId);
    const attached = await create(ida.cookie, {
      name: 'Turing Works',
      paidBy: 'active-organization',
    });
    expect(attached.status).toBe(201);

    expect((await creation(ida.cookie)).body).toMatchObject({
      allowed: true,
      ownedPayingForThemselves: { count: 0, of: 1 },
    });
    const own = await create(ida.cookie, { name: 'Lovelace Labs' });
    expect(own.status).toBe(201);
    await expect(ownedNames(ida.id)).resolves.toEqual([
      'Turing Works',
      'Lovelace Labs',
    ]);
  });

  it('does not count the Instance organization', async () => {
    const staff = await signIn(HOSTED_STAFF.email, HOSTED_STAFF.password);

    expect((await creation(staff)).body).toMatchObject({
      allowed: true,
      ownedPayingForThemselves: { count: 0, of: 1 },
    });
    const made = await create(staff, { name: 'Octabyte Demo' });
    expect(made.status).toBe(201);

    const second = await create(staff, { name: 'Octabyte Demo 2' });
    expect(second.status).toBe(403);
    expect(second.body).toMatchObject({ code: LIMIT });
  });
});
