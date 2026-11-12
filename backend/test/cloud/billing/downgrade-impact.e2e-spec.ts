// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first import.
import { useHostedMode } from '../../utils/hosted-mode';
useHostedMode();

import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../../src/applications/applications.service';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import {
  account,
  domain,
  member,
  organizationRole,
  scimProvider,
  server,
  ssoProvider,
  user,
} from '../../../src/db/schema';
import { EnvironmentsService } from '../../../src/environments/environments.service';
import { MailService } from '../../../src/mail/mail.service';
import { ProjectsService } from '../../../src/projects/projects.service';
import type { PermissionCtx } from '../../../src/rbac/permission.service';
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

jest.setTimeout(120_000);

/** The end of the month Hopper Labs has paid for, at Stripe. */
const PERIOD_END = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);
const retrieveSubscription = jest.fn<Promise<Stripe.Subscription>, [string]>();

/**
 * What moving to Starter stops, against what the Organization uses
 * (ADR-0054): `GET /billing/downgrade-impact` serves the facts the
 * downgrade confirm lists, each zero or empty for a paid feature never set up.
 * Everything is arranged straight in the tables, as the paid features would
 * have left them on Business.
 */
describe('BillingService.getDowngradeImpact (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let grace: HostedCustomer;
  const mail = new MailRecorder();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        {
          provide: STRIPE_API,
          useValue: fakeStripe({ retrieveSubscription }),
        },
        { provide: MailService, useValue: mail },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    retrieveSubscription.mockReset();
    retrieveSubscription.mockResolvedValue({
      id: 'sub_1',
      status: 'active',
      items: {
        data: [{ id: 'si_plan', current_period_end: PERIOD_END }],
      },
    } as unknown as Stripe.Subscription);
    await openHostedSignUp(ctx.db);
    grace = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, grace.organizationId, 'business');
  });

  const impact = (cookie: string) =>
    request(http).get('/billing/downgrade-impact').set('Cookie', cookie);

  const graceCtx = (): PermissionCtx => ({
    user: { id: grace.id },
    session: { activeOrganizationId: grace.organizationId },
  });

  async function givenSsoProvider(providerId = 'okta'): Promise<void> {
    await ctx.db.insert(ssoProvider).values({
      providerId,
      issuer: 'https://idp.example.com',
      domain: 'example.com',
      organizationId: grace.organizationId,
      oidcConfig: JSON.stringify({ clientId: 'client', clientSecret: 'x' }),
    });
  }

  /** A member whose only account is at `providerId`: SSO, no password. */
  async function givenSsoOnlyMember(
    email: string,
    providerId = 'okta',
  ): Promise<string> {
    const [person] = await ctx.db
      .insert(user)
      .values({ firstName: email, email, updatedAt: new Date() })
      .returning();
    await ctx.db.insert(member).values({
      organizationId: grace.organizationId,
      userId: person.id,
      role: 'member',
      createdAt: new Date(),
    });
    await givenAccount(person.id, providerId);
    return person.id;
  }

  async function givenAccount(userId: string, providerId: string) {
    const now = new Date();
    await ctx.db.insert(account).values({
      userId,
      providerId,
      accountId: `${providerId}-${userId}`,
      createdAt: now,
      updatedAt: now,
    });
  }

  async function givenScimConnection(): Promise<void> {
    await ctx.db.insert(scimProvider).values({
      providerId: 'okta-scim',
      scimToken: 'scim-token',
      organizationId: grace.organizationId,
    });
  }

  /** `userId` holds the custom role `deployer`. */
  async function givenCustomRole(userId: string): Promise<void> {
    await ctx.db.insert(organizationRole).values({
      organizationId: grace.organizationId,
      role: 'deployer',
      permission: { project: ['create'] },
    });
    await ctx.db
      .update(member)
      .set({ role: 'deployer' })
      .where(
        and(
          eq(member.organizationId, grace.organizationId),
          eq(member.userId, userId),
        ),
      );
  }

  /**
   * Hopper Labs' own Server, inserted straight so it is not counted against
   * the plan: the platform host is not a deploy target on the Hosted instance
   * so an Environment there is refused.
   */
  async function givenServer(): Promise<string> {
    const [row] = await ctx.db
      .insert(server)
      .values({
        name: 'eu-west-1',
        ipAddress: '203.0.113.10',
        port: 22,
        organizationId: grace.organizationId,
      })
      .returning({ serverId: server.serverId });
    return row.serverId;
  }

  /** An application of Hopper Labs with `gated` of `hosts` behind forward auth. */
  async function givenApplication(
    serverId: string,
    name: string,
    hosts: [string, boolean][],
  ) {
    const projects = ctx.app.get(ProjectsService);
    const environments = ctx.app.get(EnvironmentsService);
    const applications = ctx.app.get(ApplicationsService);
    const project = await projects.create(graceCtx(), { name });
    const environment = await environments.create(graceCtx(), {
      name: 'production',
      projectId: project.projectId,
      deployTarget: { kind: 'server', serverId },
    });
    const application = await applications.create(graceCtx(), {
      name,
      appName: `${name}-app`,
      environmentId: environment.environmentId,
      serverId,
    });
    for (const [host, gated] of hosts) {
      await ctx.db.insert(domain).values({
        host,
        applicationId: application.applicationId,
        forwardAuthEnabled: gated,
      });
    }
  }

  it('reports nothing for an Organization that set up no paid feature', async () => {
    const res = await impact(grace.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ssoProviders: 0,
      ssoOnlyPeople: 0,
      scimProviders: 0,
      customRoleHolders: [],
      protectedApps: 0,
      downgradeAt: new Date(PERIOD_END * 1000).toISOString(),
    });
  });

  it('counts the people who sign in only with SSO, not those with a password too', async () => {
    await givenSsoProvider();
    await givenSsoOnlyMember('ida@example.com');
    await givenSsoOnlyMember('edsger@example.com');
    const both = await givenSsoOnlyMember('ada@example.com');
    await givenAccount(both, 'credential');
    // An account at a provider of another Organization is not this one's SSO.
    await givenSsoOnlyMember('alan@example.com', 'someone-elses-idp');

    const res = await impact(grace.cookie);

    expect(res.body).toEqual(
      expect.objectContaining({ ssoProviders: 1, ssoOnlyPeople: 2 }),
    );
  });

  it('says whether SCIM is set up', async () => {
    await givenScimConnection();

    expect((await impact(grace.cookie)).body).toEqual(
      expect.objectContaining({ scimProviders: 1 }),
    );
  });

  it('names everyone holding a custom role, with the role', async () => {
    const ida = await signUpMember(http, grace.cookie, {
      email: 'ida@example.com',
      name: 'Ida Rhodes',
    });
    await signUpMember(http, grace.cookie, {
      email: 'edsger@example.com',
      name: 'Edsger Dijkstra',
    });
    await givenCustomRole(ida.id);

    expect((await impact(grace.cookie)).body).toEqual(
      expect.objectContaining({
        customRoleHolders: [{ name: 'Ida Rhodes', role: 'deployer' }],
      }),
    );
  });

  it('counts each application behind forward auth once, however many of its domains are', async () => {
    const serverId = await givenServer();
    await givenApplication(serverId, 'blog', [
      ['blog.example.com', true],
      ['www.blog.example.com', true],
    ]);
    await givenApplication(serverId, 'wiki', [['wiki.example.com', true]]);
    await givenApplication(serverId, 'site', [['site.example.com', false]]);

    expect((await impact(grace.cookie)).body).toEqual(
      expect.objectContaining({ protectedApps: 2 }),
    );
  });

  it('is an owner or admin read', async () => {
    const ida = await signUpMember(http, grace.cookie, {
      email: 'ida@example.com',
      name: 'Ida Rhodes',
      role: 'member',
    });

    const res = await impact(ida.cookie);

    expect(res.status).toBe(403);
  });

  it('serves the date of a waiting move to any member on GET /billing/plan', async () => {
    const at = new Date('2026-12-01T00:00:00.000Z');
    await givenPlan(ctx, grace.organizationId, 'business', 'active', {
      stripeScheduleId: 'sub_sched_1',
      downgradeAt: at,
    });
    const ida = await signUpMember(http, grace.cookie, {
      email: 'ida@example.com',
      name: 'Ida Rhodes',
      role: 'member',
    });

    const res = await request(http)
      .get('/billing/plan')
      .set('Cookie', ida.cookie);

    expect(res.body).toEqual({
      plan: 'business',
      scheduledAt: at.toISOString(),
    });
  });
});
