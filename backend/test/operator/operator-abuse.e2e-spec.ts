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

import { abuseReport } from '../../src/bought-servers/abuse-report.schema';
import {
  boughtServer,
  boughtServerLine,
} from '../../src/bought-servers/bought-server.schema';
import type { BoughtServerStage } from '../../src/bought-servers/bought-server.schema';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';
import { member } from '../../src/db/schema';
import { MailService } from '../../src/mail/mail.service';
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

const HOUR = 60 * 60 * 1000;
const OPERATOR_REFUSAL =
  'Only an owner or admin of the Instance organization can use the Operator page';
const ADMIN = 'alan@example.com';
const MEMBER = 'ada@example.com';
const REPORT =
  'We have received a report of a port scan from 203.0.113.7.\nPlease stop it within 24 hours.';
const REASON = 'Port scan against other networks, still going on';

interface AuditRow {
  organizationId: string | null;
  userEmail: string | null;
  userRole: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: string | null;
}

interface OpenReport {
  id: string;
  organization: { id: string; name: string };
  report: string;
  forwardedAt: string;
  deadlineAt: string;
  forwardedBy: string | null;
}

/**
 * The Operator's abuse actions (#1401, spec #1387): forwarding an abuse
 * report to an Organization's owners and admins with a 24-hour deadline,
 * open on the Operator page until closed; powering a Bought Server off at
 * once with a reason its owners see, and only an Operator powering it back
 * on; and a disputed payment of an Organization with Bought Servers
 * emailing the Operators. None of it gives an Operator any access to the
 * machine. The provider is the in-memory fake (`ctx.hetzner.machines`).
 */
describe('The Operator acts on abuse (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let staffCookie: string;
  let instanceOrganizationId: string;
  let grace: HostedCustomer;
  const mail = new MailRecorder();
  const constructEvent = jest.fn();
  const retrieveCharge = jest.fn();
  const stripe: StripeApi = fakeStripe({ constructEvent, retrieveCharge });

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        { provide: STRIPE_API, useValue: stripe },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    instanceOrganizationId = (await openHostedSignUp(ctx.db)).organizationId;
    staffCookie = await signIn(HOSTED_STAFF.email, HOSTED_STAFF.password);
    grace = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    for (const [email, name, role] of [
      [ADMIN, 'Alan Turing', 'admin'],
      [MEMBER, 'Ada Lovelace', 'member'],
    ] as const) {
      const person = await signUpHostedCustomer(http, mail, {
        name,
        email,
        password: 'super-secret-password',
        organizationName: `${name}'s own`,
      });
      await ctx.db.insert(member).values({
        organizationId: grace.organizationId,
        userId: person.id,
        role,
        createdAt: new Date(),
      });
    }
    await givenPlan(ctx, grace.organizationId, 'starter');
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

  async function trail(cookie: string): Promise<AuditRow[]> {
    const res = await request(http)
      .get('/audit-logs')
      .query({ resourceType: 'organization' })
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { logs: AuditRow[] }).logs;
  }

  /** The Operator's row of `type`, in the log of `organizationId`. */
  const operatorRow = (type: string, organizationId: string) =>
    expect.objectContaining({
      organizationId,
      userEmail: HOSTED_STAFF.email,
      action: 'update',
      resourceType: 'organization',
      resourceId: grace.organizationId,
      metadata: expect.stringContaining(`"type":"${type}"`) as string,
    }) as AuditRow;

  /**
   * A Bought Server of Hopper Labs as Buy and the stages leave it: a running
   * machine at the fake provider, its `server` row and its line.
   */
  async function givenBoughtServer(
    stage: BoughtServerStage = 'ready',
    id = 'bought0000000001',
  ): Promise<{ id: string; providerServerId: number; ip: string }> {
    const created = await ctx.hetzner.machines.createServer({
      name: `cloudgate-${id}`,
      serverType: 'cpx22',
      location: 'hel1',
      image: 'ubuntu-24.04',
      sshPublicKey: 'ssh-ed25519 AAAA bought',
      labels: {
        'cloudgate-organization': grace.organizationId,
        'cloudgate-server': id,
      },
    });
    if (!created.ok) throw new Error(created.message);
    const machine = created.value.server;
    const [key] = await ctx.db
      .insert(sshKey)
      .values({
        name: 'web-1 (bought)',
        publicKey: 'ssh-ed25519 AAAA bought',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
        organizationId: grace.organizationId,
      })
      .returning();
    await ctx.db.insert(server).values({
      serverId: id,
      name: 'web-1',
      ipAddress: machine.ipv4!,
      port: 22,
      username: 'root',
      sshKeyId: key.sshKeyId,
      organizationId: grace.organizationId,
    });
    await ctx.db.insert(boughtServer).values({
      id,
      organizationId: grace.organizationId,
      serverId: id,
      name: 'web-1',
      stage,
      serverType: 'cpx22',
      location: 'hel1',
      backups: true,
      sshKeyId: key.sshKeyId,
      providerServerId: machine.id,
      providerPrimaryIpv4Id: machine.primaryIpv4Id,
      providerPrimaryIpv6Id: machine.primaryIpv6Id,
      createTries: 1,
      purchasePaidAt: new Date(),
      termsAcceptedBy: grace.id,
      termsAcceptedAt: new Date(),
    });
    await ctx.db.insert(boughtServerLine).values({
      boughtServerId: id,
      kind: 'server',
      stripePriceId: 'price_si_server',
      stripeSubscriptionItemId: 'si_server',
      monthlyCents: 2500,
    });
    ctx.hetzner.machines.calls.length = 0;
    return { id, providerServerId: machine.id, ip: machine.ipv4! };
  }

  const machineStatus = (providerServerId: number) =>
    ctx.hetzner.machines.servers().find((m) => m.id === providerServerId)
      ?.status;

  describe('Forward abuse report', () => {
    function forward(cookie = staffCookie, report = REPORT) {
      return request(http)
        .post(`/operator/organizations/${grace.organizationId}/abuse-reports`)
        .set('Cookie', cookie)
        .send({ report });
    }

    async function openReports(): Promise<OpenReport[]> {
      const res = await request(http)
        .get('/operator/abuse-reports')
        .set('Cookie', staffCookie);
      expect(res.status).toBe(200);
      return res.body as OpenReport[];
    }

    it('emails the report to the owners and admins with a 24-hour deadline, and not to a member', async () => {
      const before = Date.now();
      const res = await forward();

      expect(res.status).toBe(201);
      const deadline = Date.parse((res.body as OpenReport).deadlineAt);
      const forwardedAt = Date.parse((res.body as OpenReport).forwardedAt);
      expect(forwardedAt).toBeGreaterThanOrEqual(before - 1000);
      expect(deadline - forwardedAt).toBe(24 * HOUR);

      for (const address of ['grace@example.com', ADMIN]) {
        const sent = mail.to(address);
        expect(sent).toHaveLength(1);
        expect(sent[0].email.subject).toMatch(
          /^Abuse report about Hopper Labs: please answer by .+ UTC$/,
        );
        expect(sent[0].email.html).toContain(
          'We have received a report of a port scan from 203.0.113.7.',
        );
        expect(sent[0].email.html).toContain('Please stop it within 24 hours.');
        expect(sent[0].email.html).toContain('Reply to this email');
      }
      expect(mail.to(MEMBER)).toEqual([]);
    });

    it('stores the deadline and lists the report open on the Operator page until it is closed', async () => {
      const forwarded = (await forward()).body as OpenReport;

      const [stored] = await ctx.db
        .select()
        .from(abuseReport)
        .where(eq(abuseReport.id, forwarded.id));
      expect(stored).toMatchObject({
        organizationId: grace.organizationId,
        report: REPORT,
        closedAt: null,
      });
      expect(stored.deadlineAt.getTime() - stored.forwardedAt.getTime()).toBe(
        24 * HOUR,
      );

      expect(await openReports()).toEqual([
        {
          id: forwarded.id,
          organization: { id: grace.organizationId, name: 'Hopper Labs' },
          report: REPORT,
          forwardedAt: forwarded.forwardedAt,
          deadlineAt: forwarded.deadlineAt,
          forwardedBy: HOSTED_STAFF.email,
        },
      ]);

      const closed = await request(http)
        .post(`/operator/abuse-reports/${forwarded.id}/close`)
        .set('Cookie', staffCookie);
      expect(closed.status).toBe(204);
      expect(await openReports()).toEqual([]);

      const again = await request(http)
        .post(`/operator/abuse-reports/${forwarded.id}/close`)
        .set('Cookie', staffCookie);
      expect(again.status).toBe(409);
    });

    it("writes the report and its deadline in the Organization's audit log, with a copy in the Instance organization's", async () => {
      const forwarded = (await forward()).body as OpenReport;

      const customers = await trail(grace.cookie);
      expect(customers).toEqual(
        expect.arrayContaining([
          operatorRow('forwardAbuseReport', grace.organizationId),
        ]),
      );
      const row = customers.find((r) =>
        r.metadata?.includes('forwardAbuseReport'),
      )!;
      expect(row.userRole).toBe('operator');
      expect(JSON.parse(row.metadata!)).toMatchObject({
        actedBy: 'Octabyte',
        abuseReportId: forwarded.id,
        deadlineAt: forwarded.deadlineAt,
        report: REPORT,
      });

      expect(await trail(staffCookie)).toEqual(
        expect.arrayContaining([
          operatorRow('forwardAbuseReport', instanceOrganizationId),
        ]),
      );
    });

    it('refuses anybody but an Operator, and stores and sends nothing', async () => {
      const res = await forward(grace.cookie);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: OPERATOR_REFUSAL });
      expect(await ctx.db.select().from(abuseReport)).toEqual([]);
      expect(mail.sent).toEqual([]);
      expect(
        (
          await request(http)
            .get('/operator/abuse-reports')
            .set('Cookie', grace.cookie)
        ).status,
      ).toBe(403);
    });

    it('refuses an empty report', async () => {
      expect((await forward(staffCookie, '   ')).status).toBe(400);
      expect(mail.sent).toEqual([]);
    });
  });

  describe('Power off', () => {
    function powerOff(id: string, cookie = staffCookie, reason = REASON) {
      return request(http)
        .post(`/operator/bought-servers/${id}/power-off`)
        .set('Cookie', cookie)
        .send({ reason });
    }

    function powerOn(id: string, cookie = staffCookie) {
      return request(http)
        .post(`/operator/bought-servers/${id}/power-on`)
        .set('Cookie', cookie);
    }

    async function customersServer(id: string) {
      const res = await request(http)
        .get(`/servers/${id}`)
        .set('Cookie', grace.cookie);
      expect(res.status).toBe(200);
      return res.body as {
        boughtServer: {
          stage: string;
          poweredOff: { at: string; reason: string } | null;
        } | null;
      };
    }

    it("powers the machine off at once and the customer's Server says why", async () => {
      const bought = await givenBoughtServer();

      const res = await powerOff(bought.id);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ reason: REASON });
      expect(ctx.hetzner.machines.callsTo('powerOff')).toEqual([
        [bought.providerServerId],
      ]);
      expect(machineStatus(bought.providerServerId)).toBe('off');
      expect((await customersServer(bought.id)).boughtServer).toMatchObject({
        stage: 'ready',
        poweredOff: { reason: REASON },
      });

      const list = await request(http)
        .get('/servers')
        .set('Cookie', grace.cookie);
      expect(
        (list.body as Array<{ serverId: string; boughtServer: unknown }>).find(
          (row) => row.serverId === bought.id,
        )?.boughtServer,
      ).toMatchObject({ poweredOff: { reason: REASON } });
    });

    it('is audited on both sides', async () => {
      const bought = await givenBoughtServer();
      await powerOff(bought.id);

      const customers = await trail(grace.cookie);
      expect(customers).toEqual(
        expect.arrayContaining([
          operatorRow('powerOffBoughtServer', grace.organizationId),
        ]),
      );
      const row = customers.find((r) =>
        r.metadata?.includes('powerOffBoughtServer'),
      )!;
      expect(JSON.parse(row.metadata!)).toMatchObject({
        actedBy: 'Octabyte',
        serverId: bought.id,
        serverName: 'web-1',
        reason: REASON,
      });
      expect(await trail(staffCookie)).toEqual(
        expect.arrayContaining([
          operatorRow('powerOffBoughtServer', instanceOrganizationId),
        ]),
      );
    });

    it('leaves the customer no way to power it on: the Operator route refuses them, and a change is refused', async () => {
      const bought = await givenBoughtServer();
      await powerOff(bought.id);

      const byCustomer = await powerOn(bought.id, grace.cookie);
      expect(byCustomer.status).toBe(403);
      expect(byCustomer.body).toMatchObject({ message: OPERATOR_REFUSAL });

      const change = await request(http)
        .put(`/bought-servers/${bought.id}/backups`)
        .set('Cookie', grace.cookie)
        .send({ enabled: false });
      expect(change.status).toBe(409);
      expect(change.body).toMatchObject({
        message:
          "This Server was powered off by Cloudgate, so it can't be changed",
      });

      expect(ctx.hetzner.machines.callsTo('powerOn')).toEqual([]);
      expect(machineStatus(bought.providerServerId)).toBe('off');
    });

    it('is powered back on only by an Operator, which clears the notice and is audited', async () => {
      const bought = await givenBoughtServer();
      await powerOff(bought.id);

      const res = await powerOn(bought.id);

      expect(res.status).toBe(204);
      expect(ctx.hetzner.machines.callsTo('powerOn')).toEqual([
        [bought.providerServerId],
      ]);
      expect(machineStatus(bought.providerServerId)).toBe('running');
      expect((await customersServer(bought.id)).boughtServer).toMatchObject({
        poweredOff: null,
      });
      expect(await trail(grace.cookie)).toEqual(
        expect.arrayContaining([
          operatorRow('powerOnBoughtServer', grace.organizationId),
        ]),
      );
      expect((await powerOn(bought.id)).status).toBe(409);
    });

    it('marks nothing when the provider refuses, and says so to the Operator', async () => {
      const bought = await givenBoughtServer();
      ctx.hetzner.machines.refuse('powerOff', 'locked');

      const res = await powerOff(bought.id);

      expect(res.status).toBe(502);
      expect((await customersServer(bought.id)).boughtServer).toMatchObject({
        poweredOff: null,
      });
      expect(
        (await trail(grace.cookie)).filter((r) =>
          r.metadata?.includes('powerOffBoughtServer'),
        ),
      ).toEqual([]);
    });

    it('refuses a second power-off, a Server with no machine, a missing reason and a non-Operator', async () => {
      const bought = await givenBoughtServer();
      expect((await powerOff(bought.id)).status).toBe(200);
      expect((await powerOff(bought.id)).status).toBe(409);
      expect(ctx.hetzner.machines.callsTo('powerOff')).toHaveLength(1);

      const deleting = await givenBoughtServer('deleting', 'bought0000000002');
      expect((await powerOff(deleting.id)).status).toBe(409);
      expect((await powerOff(deleting.id, staffCookie, '')).status).toBe(400);
      expect((await powerOff(deleting.id, grace.cookie)).status).toBe(403);
      expect((await powerOff('nothing0000000000')).status).toBe(404);
      expect(ctx.hetzner.machines.callsTo('powerOff')).toEqual([]);
    });
  });

  describe('No access to the machine', () => {
    it("gives the Operator neither the machine's address nor its key, nor the customer's Server", async () => {
      const bought = await givenBoughtServer();
      await request(http)
        .post(`/operator/bought-servers/${bought.id}/power-off`)
        .set('Cookie', staffCookie)
        .send({ reason: REASON });

      const listing = await request(http)
        .get('/operator/bought-servers')
        .set('Cookie', staffCookie);
      expect(listing.status).toBe(200);
      const text = JSON.stringify(listing.body);
      expect(text).not.toContain(bought.ip);
      expect(text).not.toMatch(/ssh|privateKey|ipAddress/i);
      expect(listing.body).toMatchObject({
        servers: [{ id: bought.id, poweredOff: { reason: REASON } }],
      });

      for (const path of [
        `/servers/${bought.id}`,
        `/servers/${bought.id}/validate`,
      ]) {
        const res = await request(http).get(path).set('Cookie', staffCookie);
        expect(res.status).toBe(404);
      }
    });
  });

  describe('A disputed payment', () => {
    function postWebhook(event: Stripe.Event) {
      constructEvent.mockReturnValue(event);
      return request(http)
        .post('/billing/webhook')
        .set('stripe-signature', 't=1,v1=valid')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(event))
        .expect(200);
    }

    function disputeEvent(): Stripe.Event {
      return {
        id: 'evt_dispute',
        type: 'charge.dispute.created',
        data: {
          object: {
            id: 'dp_1',
            object: 'dispute',
            amount: 2500,
            currency: 'usd',
            charge: 'ch_1',
            reason: 'fraudulent',
            status: 'needs_response',
          },
        },
      } as unknown as Stripe.Event;
    }

    beforeEach(() => {
      retrieveCharge.mockResolvedValue({
        id: 'ch_1',
        object: 'charge',
        customer: `cus_${grace.organizationId}`,
      });
    });

    it('emails the Operators when the Organization has Bought Servers', async () => {
      await givenBoughtServer();

      await postWebhook(disputeEvent());

      expect(retrieveCharge).toHaveBeenCalledWith('ch_1');
      const sent = mail.to(HOSTED_STAFF.email);
      expect(sent).toHaveLength(1);
      expect(sent[0].email.subject).toBe(
        'A payment by Hopper Labs, which has Bought Servers, was disputed',
      );
      expect(sent[0].email.html).toContain('$25.00');
      expect(sent[0].email.html).toContain('fraudulent');
      expect(sent[0].email.html).toContain('web-1');
      expect(sent[0].email.html).not.toMatch(/hetzner/i);
      expect(mail.to('grace@example.com')).toEqual([]);
    });

    it('sends nothing for an Organization with no Bought Server, or only a deleted one', async () => {
      await postWebhook(disputeEvent());
      await givenBoughtServer('deleted');
      await postWebhook(disputeEvent());

      expect(mail.sent).toEqual([]);
    });
  });
});
