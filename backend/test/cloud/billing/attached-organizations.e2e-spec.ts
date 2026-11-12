// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../../utils/hosted-mode';
useHostedMode();

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { subscription } from '../../../src/cloud/billing/billing.schema';
import { STRIPE_API } from '../../../src/cloud/billing/stripe-api';
import { organizationsPayingForThemselvesOwnedBy } from '../../../src/cloud/billing/paying-organization';
import {
  cloudAccount,
  environment,
  server as serverTable,
} from '../../../src/db/schema';
import { DEPLOYMENT_QUEUE } from '../../../src/deployment-queue/queue.port';
import {
  AuditLogService,
  PLATFORM_ACTOR,
} from '../../../src/enterprise/audit-logs/audit-log.service';
import type { DeployTarget } from '../../../src/environments/deploy-target';
import { MailService } from '../../../src/mail/mail.service';
import {
  member,
  organization,
} from '../../../src/organizations/organizations.schema';
import { PermissionService } from '../../../src/rbac/permission.service';
import { SshKeysService } from '../../../src/ssh-keys/ssh-keys.service';
import { fakeStripe } from '../../utils/fake-stripe';
import { givenPlan } from '../../utils/hosted-plan';
import {
  HOSTED_STAFF,
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../../utils/hosted-sign-up';
import type { HostedCustomer } from '../../utils/hosted-sign-up';
import { signUpMember } from '../../utils/test-auth';
import { ADDRESS_RESOLVER } from '../../../src/outbound/outbound-address';
import { createTestApp, TestAppContext } from '../../utils/test-app';

jest.setTimeout(180_000);

const ACCOUNT = '123456789012';

const BUSINESS_REQUIRED = {
  code: 'BUSINESS_REQUIRED',
  message:
    'SSO, SCIM, custom roles and forward auth come with the Business plan. Choose Business under Settings > Billing',
};

/**
 * The groundwork for **Attached Organizations** on the Hosted instance
 * (ADR-0059). Nothing makes one yet, so each test links the rows
 * directly — Hopper Labs, Grace's, pays for Turing Works, Alan's — and then
 * goes through the same HTTP seams as any Organization: what the Paying
 * Organization's plan grants is what an Attached Organization gets, its counts
 * are measured against the whole pool, and its own plan is never read.
 */
describe('Attached Organizations (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  const mail = new MailRecorder();
  let grace: HostedCustomer;
  let alan: HostedCustomer;
  /** Grace's Organization: the Paying Organization once anything is attached. */
  let payingId: string;
  /** Alan's Organization: attached to Grace's by `givenAttached`. */
  let attachedId: string;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        // A customer's trusted origin must resolve to a public address on the
        // Hosted instance (ADR-0076); this keeps the check off real DNS.
        {
          provide: ADDRESS_RESOLVER,
          useValue: () => Promise.resolve(['93.184.215.14']),
        },
        // Every refusal here comes before Stripe is asked anything.
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
    alan = await signUpHostedCustomer(http, mail, {
      name: 'Alan Turing',
      email: 'alan@example.com',
      password: 'super-secret-password',
      organizationName: 'Turing Works',
    });
    payingId = grace.organizationId;
    attachedId = alan.organizationId;
  });

  /**
   * Arrangement only: what "Add an Organization to this plan" will write —
   * the link, and the Attached Organization's own row with no plan and its
   * never-cleared mark.
   */
  async function givenAttached(
    organizationId = attachedId,
    paidBy = payingId,
  ): Promise<void> {
    await ctx.db
      .update(organization)
      .set({ paidByOrganizationId: paidBy })
      .where(eq(organization.id, organizationId));
    const values = { firstAttachedAt: new Date('2026-11-01T00:00:00Z') };
    await ctx.db
      .insert(subscription)
      .values({ organizationId, ...values })
      .onConflictDoUpdate({ target: subscription.organizationId, set: values });
  }

  /** Arrangement only: the link cleared, as "Stop paying for it" will. */
  async function givenDetached(organizationId = attachedId): Promise<void> {
    await ctx.db
      .update(organization)
      .set({ paidByOrganizationId: null })
      .where(eq(organization.id, organizationId));
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

  /** POST /servers, as the console sends it, with a fresh SSH key. */
  async function addServer(customer: HostedCustomer) {
    const key = await ctx.app.get(SshKeysService).create(
      {
        user: { id: customer.id },
        session: { activeOrganizationId: customer.organizationId },
      },
      { name: `key-${Date.now()}-${Math.random()}` },
    );
    return request(http).post('/servers').set('Cookie', customer.cookie).send({
      name: 'new-server',
      ipAddress: '203.0.113.200',
      port: 22,
      username: 'root',
      sshKeyId: key.sshKeyId,
    });
  }

  const allowanceFull = (count: number, kind: string) =>
    `This Organization has ${count} ${kind}, all its plan allows. Buy an Add-on for one more Server and one more Cloud Environment under Settings > Billing.`;

  describe('the shared pool', () => {
    it('refuses the next Server in either Organization once the pool is full, and an Add-on on the Paying Organization makes room for both', async () => {
      await givenPlan(ctx, payingId, 'starter');
      await givenAttached();
      await givenServers(payingId, 2);
      await givenServers(attachedId, 1);

      for (const customer of [alan, grace]) {
        const refused = await addServer(customer);
        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({
          code: 'ALLOWANCE_FULL',
          message: allowanceFull(3, 'Servers'),
        });
      }
      const room = await request(http)
        .get('/billing/can-create-server')
        .set('Cookie', alan.cookie);
      expect(room.body).toMatchObject({
        canCreateMoreServers: false,
        code: 'ALLOWANCE_FULL',
      });

      await givenPlan(ctx, payingId, 'starter', 'active', { addOns: 1 });
      expect((await addServer(alan)).status).toBe(201);
      expect((await addServer(grace)).status).toBe(403);
    });

    it("never reads the Attached Organization's own plan for its counts", async () => {
      await givenAttached();
      await givenPlan(ctx, attachedId, 'business', 'active', { addOns: 5 });

      const refused = await addServer(alan);

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'PLAN_REQUIRED' });
    });

    it("measures the pool against the Paying Organization's Enterprise counts", async () => {
      const enterprise = {
        enterprise: true,
        enterpriseServers: 4,
        enterpriseCloudEnvironments: 0,
      };
      await ctx.db
        .insert(subscription)
        .values({ organizationId: payingId, ...enterprise })
        .onConflictDoUpdate({
          target: subscription.organizationId,
          set: enterprise,
        });
      await givenAttached();
      await givenServers(payingId, 2);
      await givenServers(attachedId, 1);

      expect((await addServer(alan)).status).toBe(201);
      const refused = await addServer(alan);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'ALLOWANCE_FULL' });
    });

    it('stops sharing once the link is gone: a detached Organization is measured alone', async () => {
      await givenPlan(ctx, payingId, 'starter');
      await givenAttached();
      await givenServers(attachedId, 3);
      expect((await addServer(grace)).status).toBe(403);

      await givenDetached();

      expect((await addServer(grace)).status).toBe(201);
    });

    it('refuses the next Cloud Environment in either Organization once the pool is full', async () => {
      await givenPlan(ctx, payingId, 'starter');
      await givenAttached();
      const projects: Record<string, string> = {};
      const accounts: Record<string, string> = {};
      for (const customer of [grace, alan]) {
        const project = await request(http)
          .post('/projects')
          .set('Cookie', customer.cookie)
          .send({ name: 'shop' });
        expect(project.status).toBe(201);
        projects[customer.id] = (
          project.body as { projectId: string }
        ).projectId;
        const [account] = await ctx.db
          .insert(cloudAccount)
          .values({
            organizationId: customer.organizationId,
            name: 'Production AWS',
            cloud: 'aws',
            cloudId: ACCOUNT,
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
            deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy`,
            taskExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution`,
            externalId: `external-id-${customer.id}`,
            policyVersion: 3,
            lastCheckedAt: new Date().toISOString(),
            lastCheckResult: 'passed',
          })
          .returning();
        accounts[customer.id] = account.cloudAccountId;
      }
      const inCloud = (customer: HostedCustomer): DeployTarget => ({
        kind: 'cloud',
        cloudAccountId: accounts[customer.id],
        region: 'eu-central-1',
      });
      // Two of the pool's three in Grace's Organization, one in Alan's.
      for (const [customer, name] of [
        [grace, 'production'],
        [grace, 'staging'],
        [alan, 'production'],
      ] as const) {
        await ctx.db.insert(environment).values({
          name,
          projectId: projects[customer.id],
          deployTarget: inCloud(customer),
        });
      }

      for (const customer of [alan, grace]) {
        const refused = await request(http)
          .post('/environments')
          .set('Cookie', customer.cookie)
          .send({
            projectId: projects[customer.id],
            name: 'preview',
            deployTarget: inCloud(customer),
          });
        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({
          code: 'ALLOWANCE_FULL',
          message: allowanceFull(3, 'Cloud Environments'),
        });
      }
    });
  });

  describe('the paid features', () => {
    const addTrustedOrigin = (customer: HostedCustomer) =>
      request(http)
        .post('/sso/trusted-origins')
        .set('Cookie', customer.cookie)
        .send({ origin: 'https://idp.example.com' });

    it('come with a Business Paying Organization', async () => {
      await givenPlan(ctx, payingId, 'business');
      await givenAttached();

      expect((await addTrustedOrigin(alan)).status).toBe(200);
      const plan = await request(http)
        .get('/billing/plan')
        .set('Cookie', alan.cookie);
      expect(plan.body).toMatchObject({ plan: 'business' });
    });

    it.each<[string, () => Promise<void>]>([
      [
        'a Starter Paying Organization',
        () => givenPlan(ctx, payingId, 'starter'),
      ],
      [
        'a Business Paying Organization whose subscription has ended',
        () => givenPlan(ctx, payingId, 'business', 'canceled'),
      ],
    ])(
      'are refused under %s, whatever the Attached Organization holds itself',
      async (_case, arrange) => {
        await arrange();
        await givenAttached();
        await givenPlan(ctx, attachedId, 'business');

        const res = await addTrustedOrigin(alan);

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject(BUSINESS_REQUIRED);
      },
    );
  });

  describe('the Free trial', () => {
    const trialAvailable = async () => {
      const res = await request(http)
        .get('/billing/subscription')
        .set('Cookie', alan.cookie);
      expect(res.status).toBe(200);
      return (res.body as { trialAvailable: boolean }).trialAvailable;
    };

    it('is used up once the Organization has been attached, and stays used after it is detached', async () => {
      expect(await trialAvailable()).toBe(true);

      await givenAttached();
      expect(await trialAvailable()).toBe(false);

      await givenDetached();
      expect(await trialAvailable()).toBe(false);
    });
  });

  describe('the link', () => {
    async function deleting(organizationId: string): Promise<unknown> {
      try {
        await ctx.db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        return null;
      } catch (err) {
        return err;
      }
    }

    it('refuses to delete a Paying Organization while any Organization is attached, and allows it once none is', async () => {
      await givenAttached();

      const refused = (await deleting(payingId)) as {
        code?: string;
        cause?: { code?: string };
      } | null;
      expect(refused?.cause?.code ?? refused?.code).toBe('23503');
      const [still] = await ctx.db
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.id, payingId));
      expect(still).toBeDefined();

      expect(await deleting(attachedId)).toBeNull();
      expect(await deleting(payingId)).toBeNull();
    });
  });

  describe('owning an Organization that pays for itself', () => {
    const ownedBy = async (userId: string) =>
      (
        await organizationsPayingForThemselvesOwnedBy(
          ctx.db,
          userId,
          await ctx.app.get(PermissionService).instanceOrganizationId(),
        )
      ).map((one) => one.name);

    it('counts the Organizations a person owns that are not attached, with no plan or lapsed, and never the Instance organization', async () => {
      // Hopper Labs has no plan at all, and still counts.
      expect(await ownedBy(grace.id)).toEqual(['Hopper Labs']);
      expect(await ownedBy(alan.id)).toEqual(['Turing Works']);

      await givenAttached();
      expect(await ownedBy(alan.id)).toEqual([]);

      // A detached, lapsed Organization counts again.
      await givenDetached();
      await ctx.db
        .update(subscription)
        .set({ lapsedAt: new Date('2026-11-05T00:00:00Z') })
        .where(eq(subscription.organizationId, attachedId));
      expect(await ownedBy(alan.id)).toEqual(['Turing Works']);

      const [staff] = await ctx.db
        .select({ ownerId: organization.ownerId })
        .from(organization)
        .where(
          eq(
            organization.id,
            (await ctx.app.get(PermissionService).instanceOrganizationId())!,
          ),
        );
      expect(await ownedBy(staff.ownerId)).toEqual([]);
    });
  });

  describe('a link event in both audit logs', () => {
    interface Row {
      action: string;
      resourceType: string;
      resourceId: string;
      resourceName: string;
      userId: string | null;
      userEmail: string | null;
      userRole: string;
      metadata: Record<string, unknown>;
    }

    /** The link rows of the trail the customer's active Organization keeps. */
    async function linkRows(customer: HostedCustomer): Promise<Row[]> {
      const res = await request(http)
        .get('/audit-logs')
        .query({ resourceType: 'organization' })
        .set('Cookie', customer.cookie);
      expect(res.status).toBe(200);
      return (
        res.body as {
          logs: Array<Omit<Row, 'metadata'> & { metadata: string }>;
        }
      ).logs
        .map((row) => ({
          ...row,
          metadata: JSON.parse(row.metadata ?? '{}') as Record<string, unknown>,
        }))
        .filter((row) => 'link' in row.metadata);
    }

    const linkOf = (event: string) => ({
      link: event,
      payingOrganizationId: payingId,
      payingOrganizationName: 'Hopper Labs',
    });

    const shape = (action: string) => ({
      action,
      resourceType: 'organization',
      resourceId: attachedId,
      resourceName: 'Turing Works',
    });

    it('records a member of both by their real role in each', async () => {
      await givenAttached();
      await ctx.db.insert(member).values({
        organizationId: attachedId,
        userId: grace.id,
        role: 'admin',
        createdAt: new Date(),
      });

      await ctx.app.get(AuditLogService).recordLinkEvent(
        { userId: grace.id, actedFromOrganizationId: payingId },
        {
          event: 'attached',
          attachedOrganizationId: attachedId,
          payingOrganizationId: payingId,
        },
      );

      expect(await linkRows(grace)).toEqual([
        expect.objectContaining({
          ...shape('create'),
          userId: grace.id,
          userEmail: 'grace@example.com',
          userRole: 'owner',
          metadata: linkOf('attached'),
        }),
      ]);
      expect(await linkRows(alan)).toEqual([
        expect.objectContaining({
          ...shape('create'),
          userId: grace.id,
          userRole: 'admin',
          metadata: linkOf('attached'),
        }),
      ]);
    });

    it('records a non-member by their role where they acted from, and says which Organization that was', async () => {
      await givenAttached();

      await ctx.app.get(AuditLogService).recordLinkEvent(
        { userId: grace.id, actedFromOrganizationId: payingId },
        {
          event: 'stoppedPaying',
          attachedOrganizationId: attachedId,
          payingOrganizationId: payingId,
        },
      );

      expect(await linkRows(grace)).toEqual([
        expect.objectContaining({
          ...shape('update'),
          userRole: 'owner',
          metadata: linkOf('stoppedPaying'),
        }),
      ]);
      expect(await linkRows(alan)).toEqual([
        expect.objectContaining({
          ...shape('update'),
          userId: grace.id,
          userEmail: 'grace@example.com',
          userRole: 'owner',
          metadata: {
            ...linkOf('stoppedPaying'),
            actedFromOrganizationId: payingId,
            actedFromOrganizationName: 'Hopper Labs',
          },
        }),
      ]);
    });

    it.each<[string, () => Parameters<AuditLogService['recordLinkEvent']>[0]]>([
      ['the platform', () => PLATFORM_ACTOR],
      [
        'a person who no longer exists, as the platform',
        () => ({
          userId: 'no-such-user',
          actedFromOrganizationId: attachedId,
        }),
      ],
    ])('records %s in both logs', async (_case, actor) => {
      await givenAttached();

      await ctx.app.get(AuditLogService).recordLinkEvent(actor(), {
        event: 'deleted',
        attachedOrganizationId: attachedId,
        payingOrganizationId: payingId,
      });

      for (const customer of [grace, alan]) {
        expect(await linkRows(customer)).toEqual([
          expect.objectContaining({
            ...shape('delete'),
            userId: null,
            userEmail: null,
            userRole: 'system',
            metadata: linkOf('deleted'),
          }),
        ]);
      }
    });
  });

  /**
   * The refusals while Organizations are attached: a Paying
   * Organization cannot be deleted or moved to Starter while it pays for
   * others, and an Attached Organization's plan is its Paying Organization's
   * to change.
   */
  describe('the refusals while Organizations are attached', () => {
    /**
     * Arrangement only: another Organization `ownerId` owns, made after the
     * two signed up, so it is the newest.
     */
    async function givenOrganization(
      name: string,
      ownerId: string,
    ): Promise<string> {
      const [made] = await ctx.db
        .insert(organization)
        .values({ name, ownerId, createdAt: new Date() })
        .returning({ id: organization.id });
      await ctx.db.insert(member).values({
        organizationId: made.id,
        userId: ownerId,
        role: 'owner',
        createdAt: new Date(),
      });
      return made.id;
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

    const deleteOrganization = (customer: HostedCustomer, id: string) =>
      request(http)
        .delete(`/organizations/${id}`)
        .set('Cookie', customer.cookie);

    const BOTH_ATTACHED =
      'Hopper Labs pays for Turing Works and Babbage Engines. Delete them, or stop paying for them,';

    describe('deleting the Paying Organization', () => {
      it.each<[string, () => Promise<void>]>([
        [
          'while its owner owns another Organization',
          async () => {
            await givenPlan(ctx, payingId, 'business');
            await givenOrganization('Hopper Annex', grace.id);
          },
        ],
        [
          'even when it is frozen',
          () =>
            givenPlan(ctx, payingId, 'business', 'canceled', {
              lapsedAt: new Date(),
            }),
        ],
      ])(
        'is refused %s, naming each Attached Organization, until none is attached',
        async (_case, arrange) => {
          await arrange();
          await givenAttached();
          const babbage = await givenOrganization('Babbage Engines', alan.id);
          await givenAttached(babbage);

          const refused = await deleteOrganization(grace, payingId);

          expect(refused.status).toBe(409);
          expect(refused.body).toMatchObject({
            code: 'ORGANIZATIONS_ATTACHED',
            message: `${BOTH_ATTACHED} before deleting Hopper Labs`,
          });

          await givenDetached();
          await givenDetached(babbage);
          expect((await deleteOrganization(grace, payingId)).status).toBe(200);
        },
      );
    });

    describe('deleting an Attached Organization', () => {
      it('still needs its owner to own another Organization, and an Attached Organization they own counts as one', async () => {
        await givenAttached();

        const refused = await deleteOrganization(alan, attachedId);
        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({
          message:
            'You must maintain at least one organization where you are the owner',
        });

        // Alan now pays for Turing Works himself and owns Babbage Engines,
        // which Hopper Labs pays for: it counts, so Turing Works can go.
        await givenDetached();
        await givenAttached(
          await givenOrganization('Babbage Engines', alan.id),
        );
        expect((await deleteOrganization(alan, attachedId)).status).toBe(200);
      });

      it("returns its Servers to the pool at once and writes the deleted link row in both Organizations' logs", async () => {
        await givenPlan(ctx, payingId, 'starter');
        await givenAttached();
        await givenServers(attachedId, 3);
        await givenOrganization('Babbage Engines', alan.id);
        expect((await addServer(grace)).status).toBe(403);

        expect((await deleteOrganization(alan, attachedId)).status).toBe(200);

        expect((await addServer(grace)).status).toBe(201);

        const deleted = {
          action: 'delete',
          resourceType: 'organization',
          resourceId: attachedId,
          resourceName: 'Turing Works',
          userEmail: 'alan@example.com',
          userRole: 'owner',
        };
        const link = {
          link: 'deleted',
          payingOrganizationId: payingId,
          payingOrganizationName: 'Hopper Labs',
        };
        // Hopper Labs' own log: Alan is not a member there, so the row says
        // where he acted from.
        expect(
          await organizationRows(grace.cookie, { resourceId: attachedId }),
        ).toEqual([
          expect.objectContaining({
            ...deleted,
            metadata: {
              ...link,
              actedFromOrganizationId: attachedId,
              actedFromOrganizationName: 'Turing Works',
            },
          }),
        ]);
        // Turing Works' own log outlives it, in the deleted-organizations
        // trail, holding the link row and no second, plain delete row.
        const staff = await signIn(HOSTED_STAFF.email, HOSTED_STAFF.password);
        expect(
          await organizationRows(staff, {
            scope: 'deleted-organizations',
            resourceId: attachedId,
          }),
        ).toEqual([
          expect.objectContaining({
            ...deleted,
            organizationId: null,
            metadata: link,
          }),
        ]);
      });

      /**
       * The `delete` rows about one Organization in a trail, with their
       * metadata parsed.
       */
      async function organizationRows(
        cookie: string,
        { resourceId, ...query }: { resourceId: string; scope?: string },
      ) {
        const res = await request(http)
          .get('/audit-logs')
          .query({ ...query, resourceType: 'organization' })
          .set('Cookie', cookie);
        expect(res.status).toBe(200);
        return (
          res.body as {
            logs: Array<{
              action: string;
              resourceId: string;
              metadata: string | null;
            }>;
          }
        ).logs
          .filter(
            (row) => row.resourceId === resourceId && row.action === 'delete',
          )
          .map((row) => ({
            ...row,
            metadata: JSON.parse(row.metadata ?? '{}') as unknown,
          }));
      }
    });

    describe('moving the Paying Organization to Starter', () => {
      it.each([
        ['the switch during its Business Free trial', 'trialing'],
        ['a downgrade at the end of the paid month', 'active'],
      ])(
        'is refused for %s, naming each Attached Organization',
        async (_case, status) => {
          await givenPlan(ctx, payingId, 'business', status);
          await givenAttached();
          await givenAttached(
            await givenOrganization('Babbage Engines', alan.id),
          );

          const refused = await request(http)
            .post('/billing/downgrade')
            .set('Cookie', grace.cookie);

          expect(refused.status).toBe(409);
          expect(refused.body).toMatchObject({
            code: 'ORGANIZATIONS_ATTACHED',
            message: `${BOTH_ATTACHED} before moving Hopper Labs to Starter`,
          });
          const plan = await request(http)
            .get('/billing/subscription')
            .set('Cookie', grace.cookie);
          expect(plan.body).toMatchObject({
            plan: 'business',
            scheduledPlan: null,
          });
        },
      );
    });

    describe("an Attached Organization's own billing", () => {
      const PAID_BY_HOPPER = {
        code: 'PAID_BY_ANOTHER_ORGANIZATION',
        message:
          'Turing Works is paid by Hopper Labs. Only the owners and admins of Hopper Labs change its plan or Add-ons',
      };

      beforeEach(async () => {
        await givenPlan(ctx, payingId, 'business');
        await givenAttached();
      });

      /** Someone Alan invites into Turing Works as `role`, acting in it. */
      async function givenMemberOfAttached(
        role: 'admin' | 'member',
      ): Promise<string> {
        const ida = await signUpMember(http, alan.cookie, {
          email: 'ida@example.com',
          role,
        });
        const active = await request(http)
          .post('/api/auth/organization/set-active')
          .set('Cookie', ida.cookie)
          .send({ organizationId: attachedId });
        expect(active.status).toBe(200);
        return ida.cookie;
      }

      it.each<[string, (cookie: string) => request.Test]>([
        [
          'Add-ons',
          (cookie) =>
            request(http)
              .post('/billing/add-ons')
              .set('Cookie', cookie)
              .send({ addOns: 2 }),
        ],
        [
          'the upgrade preview',
          (cookie) =>
            request(http).get('/billing/upgrade-preview').set('Cookie', cookie),
        ],
        [
          'an upgrade',
          (cookie) =>
            request(http)
              .post('/billing/upgrade')
              .set('Cookie', cookie)
              .send({ prorationDate: Math.floor(Date.now() / 1000) }),
        ],
        [
          'a move to Starter',
          (cookie) =>
            request(http).post('/billing/downgrade').set('Cookie', cookie),
        ],
        [
          'Keep Business',
          (cookie) =>
            request(http).delete('/billing/downgrade').set('Cookie', cookie),
        ],
        [
          'Cancel trial',
          (cookie) =>
            request(http).post('/billing/cancel-trial').set('Cookie', cookie),
        ],
      ])('refuses %s to its owner', async (_case, send) => {
        const refused = await send(alan.cookie);

        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject(PAID_BY_HOPPER);
      });

      it('refuses Checkout to an admin who is not its owner', async () => {
        const cookie = await givenMemberOfAttached('admin');

        const refused = await request(http)
          .post('/billing/checkout')
          .set('Cookie', cookie)
          .send({ plan: 'business', addOns: 0 });

        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject(PAID_BY_HOPPER);
      });

      it('still refuses a member who is not an owner or admin first, as before', async () => {
        const cookie = await givenMemberOfAttached('member');

        const refused = await request(http)
          .post('/billing/add-ons')
          .set('Cookie', cookie)
          .send({ addOns: 2 });

        expect(refused.status).toBe(403);
        expect(refused.body).not.toHaveProperty('code');
      });
    });

    describe('an Operator turning Enterprise on', () => {
      const enterpriseOn = async (organizationId: string) =>
        request(http)
          .put(`/operator/organizations/${organizationId}/enterprise`)
          .set(
            'Cookie',
            await signIn(HOSTED_STAFF.email, HOSTED_STAFF.password),
          )
          .send({ enterprise: true, servers: 10, cloudEnvironments: 10 });

      it("is refused for an Attached Organization, in the PRD's words, and allowed for its Paying Organization", async () => {
        await givenAttached();

        const refused = await enterpriseOn(attachedId);

        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({
          code: 'PAID_BY_ANOTHER_ORGANIZATION',
          message:
            "Turing Works is paid by Hopper Labs. Turn Enterprise on for Hopper Labs, or Turing Works's owner first pays for it themselves",
        });
        const plan = await request(http)
          .get('/billing/plan')
          .set('Cookie', alan.cookie);
        expect(plan.body).toMatchObject({ plan: null });

        expect((await enterpriseOn(payingId)).status).toBe(200);
      });
    });
  });
});
