// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../../utils/hosted-mode';
useHostedMode();

import request from 'supertest';
import { App } from 'supertest/types';

import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { server as serverTable } from '../../../src/db/schema';
import { MailService } from '../../../src/mail/mail.service';
import { fakeStripe } from '../../utils/fake-stripe';
import { givenPlan } from '../../utils/hosted-plan';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import type { HostedCustomer } from '../../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../../utils/test-app';

jest.setTimeout(180_000);

/**
 * **The shared meters** (ADR-0059): on the Paying Organization's
 * Billing read, `GET /billing/subscription` carries the pool — every
 * Organization on the plan's use added up, and how many Organizations that is
 * — beside the Organization's own `usage`. An Organization with nothing
 * attached, and an Attached Organization, carry no pool: the first looks as it
 * always did, and the second is told nothing about the other Organizations.
 */
describe('Shared meters on the Billing read (e2e)', () => {
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
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
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

  /** "Add an Organization to this plan", from Grace's active Organization. */
  async function addToPlan(name: string): Promise<string> {
    const res = await request(http)
      .post('/organizations')
      .set('Cookie', grace.cookie)
      .send({ name, paidBy: 'active-organization' });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
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

  const billingRead = () =>
    request(http).get('/billing/subscription').set('Cookie', grace.cookie);

  it("gives a Paying Organization with two Attached Organizations the pool's total use and the count of Organizations, beside its own", async () => {
    await givenPlan(ctx, payingId, 'business', 'active', { addOns: 2 });
    await givenServers(payingId, 1);
    const first = await addToPlan('Turing Works');
    const second = await addToPlan('Lovelace Co');
    await givenServers(first, 2);
    await givenServers(second, 1);

    const read = await billingRead();

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      allowance: { plan: 'business', servers: 5, cloudEnvironments: 5 },
      usage: { servers: 1, cloudEnvironments: 0 },
      pool: {
        usage: { servers: 4, cloudEnvironments: 0 },
        organizations: 3,
      },
      // The catalogue's Add-on floor covers the whole pool, as Checkout's does.
      minimumAddOns: 1,
      paidBy: null,
    });
  });

  it('carries no pool for an Organization with nothing attached', async () => {
    await givenPlan(ctx, payingId, 'business');
    await givenServers(payingId, 2);

    const read = await billingRead();

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      usage: { servers: 2, cloudEnvironments: 0 },
      pool: null,
      minimumAddOns: 0,
    });
  });

  it('carries no pool for an Attached Organization, which sees only its own use', async () => {
    await givenPlan(ctx, payingId, 'business');
    await givenServers(payingId, 2);
    const attachedId = await addToPlan('Turing Works');
    await givenServers(attachedId, 1);
    const switched = await request(http)
      .post('/api/auth/organization/set-active')
      .set('Cookie', grace.cookie)
      .send({ organizationId: attachedId });
    expect(switched.status).toBe(200);

    const read = await billingRead();

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      usage: { servers: 1, cloudEnvironments: 0 },
      pool: null,
      paidBy: { name: 'Hopper Labs' },
    });
  });
});
