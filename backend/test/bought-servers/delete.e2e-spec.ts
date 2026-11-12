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

import { BoughtServerStages } from '../../src/bought-servers/bought-server-stages.service';
import {
  boughtServer,
  boughtServerLine,
} from '../../src/bought-servers/bought-server.schema';
import type { BoughtServerStage } from '../../src/bought-servers/bought-server.schema';
import { certificate } from '../../src/certificates/certificate.schema';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';
import { DeploymentLogRetentionService } from '../../src/deployments/log-retention.service';
import { MailService } from '../../src/mail/mail.service';
import { MonitoringService } from '../../src/monitoring/monitoring.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { RETIRED_SERVER_MESSAGE } from '../../src/servers/server-connection.provider';
import { ServerConnectionProvider } from '../../src/servers/server-connection.provider';
import { server } from '../../src/servers/server.schema';
import { CleanupService } from '../../src/settings/cleanup.service';
import { DockerCleanupService } from '../../src/settings/docker-cleanup.service';
import { ServerAccessLogUpkeepService } from '../../src/settings/server-access-log-upkeep.service';
import { TraefikFilesService } from '../../src/settings/traefik-files.service';
import { sshKey } from '../../src/ssh-keys/ssh-key.schema';
import { fakeStripe } from '../utils/fake-stripe';
import { givenPlan } from '../utils/hosted-plan';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import type { HostedCustomer } from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

/**
 * Deleting a Bought Server (#1393, ADR-0071): the ordinary Server delete,
 * with the Services rule unchanged, moves it to Deleting, takes its lines
 * off the subscription with a proration credit, deletes the machine with
 * its backups, its Volume and its Primary IPs, and keeps the `bought_server`
 * row marked Deleted. From Deleting on, nothing connects to it and every
 * loop over the Servers skips it. The provider is the in-memory fake
 * (`ctx.hetzner.machines`); Stripe is `fakeStripe` with one subscription.
 */
describe('Deleting a Bought Server (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  const mail = new MailRecorder();

  /** The subscription items Stripe carries now. */
  let carried: string[] = [];

  const subscriptionNow = (): Stripe.Subscription =>
    ({
      id: `sub_${owner.organizationId}`,
      object: 'subscription',
      status: 'active',
      customer: `cus_${owner.organizationId}`,
      items: {
        data: carried.map((id) => ({ id, price: { id: `price_${id}` } })),
      },
    }) as unknown as Stripe.Subscription;

  const retrieveSubscription = jest.fn(() =>
    Promise.resolve(subscriptionNow()),
  );
  const updateSubscription = jest.fn(
    (_id: string, params: Stripe.SubscriptionUpdateParams) => {
      const gone = (params.items ?? [])
        .filter((item) => item.deleted)
        .map((item) => item.id);
      carried = carried.filter((id) => !gone.includes(id));
      return Promise.resolve(subscriptionNow());
    },
  );
  /**
   * The Free trial's own invoice a Server bought during it was paid on: $20
   * for 30 days, of which 10 are used.
   */
  const DAY_S = 24 * 60 * 60;
  const trialInvoice = (): Stripe.Invoice => {
    const now = Math.floor(Date.now() / 1000);
    return {
      id: 'in_trial',
      object: 'invoice',
      status: 'paid',
      currency: 'usd',
      customer: `cus_${owner.organizationId}`,
      parent: null,
      lines: {
        data: [
          {
            amount: 2000,
            period: { start: now - 10 * DAY_S, end: now + 20 * DAY_S },
          },
        ],
      },
    } as unknown as Stripe.Invoice;
  };
  const retrieveInvoice = jest.fn(() => Promise.resolve(trialInvoice()));
  const createBalanceTransaction = jest.fn(() =>
    Promise.resolve({ id: 'cbtxn_1' } as Stripe.CustomerBalanceTransaction),
  );
  const stripe: StripeApi = fakeStripe({
    retrieveSubscription,
    updateSubscription,
    retrieveInvoice,
    createBalanceTransaction,
  });

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
    jest.restoreAllMocks();
    mail.clear();
    carried = ['si_plan', 'si_server', 'si_storage'];
    await openHostedSignUp(ctx.db);
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, 'starter');
  });

  /**
   * A Bought Server as Buy and the stages leave it: a machine at the fake
   * provider with an attached Volume, its `server` row, and its two lines
   * on the subscription.
   */
  async function givenBoughtServer(
    stage: BoughtServerStage = 'ready',
    id = 'bought0000000001',
  ): Promise<{ id: string }> {
    const machines = ctx.hetzner.machines;
    const labels = {
      'cloudgate-organization': owner.organizationId,
      'cloudgate-server': id,
    };
    const created = await machines.createServer({
      name: `cloudgate-${id}`,
      serverType: 'cpx22',
      location: 'hel1',
      image: 'ubuntu-24.04',
      sshPublicKey: 'ssh-ed25519 AAAA bought',
      labels,
    });
    if (!created.ok) throw new Error(created.message);
    const machine = created.value.server;
    const volume = await machines.createVolume({
      name: `cloudgate-${id}`,
      sizeGb: 20,
      location: 'hel1',
      labels,
    });
    if (!volume.ok) throw new Error(volume.message);
    await machines.attachVolume(volume.value.volume.id, machine.id);

    const [key] = await ctx.db
      .insert(sshKey)
      .values({
        name: 'web-1 (bought)',
        publicKey: 'ssh-ed25519 AAAA bought',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
        organizationId: owner.organizationId,
      })
      .returning();
    await ctx.db.insert(server).values({
      serverId: id,
      name: 'web-1',
      ipAddress: machine.ipv4!,
      port: 22,
      username: 'root',
      sshKeyId: key.sshKeyId,
      organizationId: owner.organizationId,
    });
    await ctx.db.insert(boughtServer).values({
      id,
      organizationId: owner.organizationId,
      serverId: id,
      name: 'web-1',
      stage,
      serverType: 'cpx22',
      location: 'hel1',
      storageGb: 20,
      sshKeyId: key.sshKeyId,
      providerServerId: machine.id,
      providerVolumeId: volume.value.volume.id,
      providerPrimaryIpv4Id: machine.primaryIpv4Id,
      providerPrimaryIpv6Id: machine.primaryIpv6Id,
      createTries: 1,
      purchasePaidAt: new Date(),
      termsAcceptedBy: owner.id,
      termsAcceptedAt: new Date(),
    });
    await ctx.db.insert(boughtServerLine).values([
      {
        boughtServerId: id,
        kind: 'server',
        stripePriceId: 'price_si_server',
        stripeSubscriptionItemId: 'si_server',
        monthlyCents: 2500,
      },
      {
        boughtServerId: id,
        kind: 'storage',
        stripePriceId: 'price_si_storage',
        stripeSubscriptionItemId: 'si_storage',
        monthlyCents: 200,
      },
    ]);
    ctx.hetzner.machines.calls.length = 0;
    return { id };
  }

  const remove = (id: string) =>
    request(http).delete(`/servers/${id}`).set('Cookie', owner.cookie);

  async function rowOf(id: string) {
    const [row] = await ctx.db
      .select()
      .from(boughtServer)
      .where(eq(boughtServer.id, id));
    return row;
  }

  const providerHolds = () => ({
    machines: ctx.hetzner.machines.servers().length,
    volumes: ctx.hetzner.machines.volumes().length,
    primaryIps: ctx.hetzner.machines.primaryIps().length,
  });

  describe('Delete', () => {
    it('deletes the machine, its Volume and its Primary IPs at the provider', async () => {
      const { id } = await givenBoughtServer();
      expect(providerHolds()).toEqual({
        machines: 1,
        volumes: 1,
        primaryIps: 2,
      });

      const res = await remove(id);

      expect(res.status).toBe(200);
      expect(providerHolds()).toEqual({
        machines: 0,
        volumes: 0,
        primaryIps: 0,
      });
    });

    it('takes its lines off the subscription with a proration credit, and keeps the plan', async () => {
      const { id } = await givenBoughtServer();

      await remove(id).expect(200);

      expect(updateSubscription).toHaveBeenCalledTimes(1);
      expect(updateSubscription).toHaveBeenCalledWith(
        `sub_${owner.organizationId}`,
        {
          items: [
            { id: 'si_server', deleted: true },
            { id: 'si_storage', deleted: true },
          ],
          proration_behavior: 'create_prorations',
        },
      );
      expect(carried).toEqual(['si_plan']);
      const lines = await ctx.db
        .select()
        .from(boughtServerLine)
        .where(eq(boughtServerLine.boughtServerId, id));
      expect(lines.map((line) => line.stripeSubscriptionItemId)).toEqual([
        null,
        null,
      ]);
    });

    describe('of a Server bought during the Free trial', () => {
      /** Paid on the trial's own invoice; its lines on no subscription yet. */
      async function boughtInTrial(): Promise<string> {
        const { id } = await givenBoughtServer();
        await ctx.db
          .update(boughtServer)
          .set({ purchaseInvoiceId: 'in_trial' })
          .where(eq(boughtServer.id, id));
        await ctx.db
          .update(boughtServerLine)
          .set({ stripeSubscriptionItemId: null })
          .where(eq(boughtServerLine.boughtServerId, id));
        carried = ['si_plan'];
        return id;
      }

      it("credits the unused part of the trial invoice to the customer's balance", async () => {
        const id = await boughtInTrial();

        await remove(id).expect(200);

        expect(createBalanceTransaction).toHaveBeenCalledTimes(1);
        const [[customer, params, key]] = createBalanceTransaction.mock
          .calls as unknown as [
          [string, Stripe.CustomerCreateBalanceTransactionParams, string],
        ];
        expect(customer).toBe(`cus_${owner.organizationId}`);
        // 20 of its 30 days are left: two thirds of $20, as a credit.
        expect(params.amount).toBeGreaterThanOrEqual(-1334);
        expect(params.amount).toBeLessThanOrEqual(-1332);
        expect(key).toBe(`bought-server-trial-credit-${id}`);
        expect(updateSubscription).not.toHaveBeenCalled();
        expect((await rowOf(id)).stage).toBe('deleted');
      });

      it('credits nothing when the clock deletes it', async () => {
        const id = await boughtInTrial();
        await ctx.db
          .update(boughtServer)
          .set({
            stage: 'deleting',
            deletingAt: new Date(),
            deletionCredited: false,
          })
          .where(eq(boughtServer.id, id));

        await ctx.app.get(BoughtServerStages).advance(id);

        expect(createBalanceTransaction).not.toHaveBeenCalled();
        expect((await rowOf(id)).stage).toBe('deleted');
      });
    });

    it('removes the server row and keeps the Bought Server marked Deleted, with its provider ids and dates', async () => {
      const { id } = await givenBoughtServer();
      const before = await rowOf(id);

      await remove(id).expect(200);

      expect(
        await ctx.db.select().from(server).where(eq(server.serverId, id)),
      ).toEqual([]);
      const after = await rowOf(id);
      expect(after).toMatchObject({
        stage: 'deleted',
        serverId: null,
        providerServerId: before.providerServerId,
        providerVolumeId: before.providerVolumeId,
        providerPrimaryIpv4Id: before.providerPrimaryIpv4Id,
        providerPrimaryIpv6Id: before.providerPrimaryIpv6Id,
        createdAt: before.createdAt,
      });
      expect(after.deletingAt).toBeInstanceOf(Date);
      expect(after.deletedAt).toBeInstanceOf(Date);
      expect(after.deletedAt!.getTime()).toBeGreaterThanOrEqual(
        after.deletingAt!.getTime(),
      );
    });

    it('keeps the Services rule: a Server still carrying something is refused, and nothing is deleted', async () => {
      const { id } = await givenBoughtServer();
      await ctx.db.insert(certificate).values({
        name: 'wildcard.example.com',
        certificateData: '-----BEGIN CERTIFICATE-----',
        privateKey: '-----BEGIN PRIVATE KEY-----',
        organizationId: owner.organizationId,
        serverId: id,
      });

      const res = await remove(id);

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toMatch(
        /^Server "web-1" still carries 1 configuration entry/,
      );
      expect((await rowOf(id)).stage).toBe('ready');
      expect(ctx.hetzner.machines.calls).toEqual([]);
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(providerHolds()).toEqual({
        machines: 1,
        volumes: 1,
        primaryIps: 2,
      });
    });

    it('stays Deleting through a refusal, refuses every connect meanwhile, and finishes when resumed', async () => {
      const { id } = await givenBoughtServer();
      ctx.hetzner.machines.refuse('deleteVolume', 'locked');

      await remove(id).expect(200);

      expect((await rowOf(id)).stage).toBe('deleting');
      // The lines were taken off first: the credit runs from the press.
      expect(carried).toEqual(['si_plan']);
      expect(providerHolds()).toEqual({
        machines: 0,
        volumes: 1,
        primaryIps: 2,
      });

      await ctx.app.get(BoughtServerStages).advance(id);

      expect((await rowOf(id)).stage).toBe('deleted');
      expect(providerHolds()).toEqual({
        machines: 0,
        volumes: 0,
        primaryIps: 0,
      });
      // The lines were not removed twice.
      expect(updateSubscription).toHaveBeenCalledTimes(1);
    });

    it('only forgets a Deleted record, with no provider call and nothing at Stripe', async () => {
      const { id } = await givenBoughtServer('deleted');

      await remove(id).expect(200);

      expect(
        await ctx.db.select().from(server).where(eq(server.serverId, id)),
      ).toEqual([]);
      expect((await rowOf(id)).stage).toBe('deleted');
      expect(ctx.hetzner.machines.calls).toEqual([]);
      expect(retrieveSubscription).not.toHaveBeenCalled();
      expect(updateSubscription).not.toHaveBeenCalled();
    });

    it('shows the stage on the Server, so the console can word what Delete does', async () => {
      const { id } = await givenBoughtServer();

      const one = await request(http)
        .get(`/servers/${id}`)
        .set('Cookie', owner.cookie)
        .expect(200);
      const all = await request(http)
        .get('/servers')
        .set('Cookie', owner.cookie)
        .expect(200);

      expect((one.body as { boughtServer: unknown }).boughtServer).toEqual({
        stage: 'ready',
        poweredOff: null,
        deletesOn: null,
        deletedAt: null,
      });
      expect(all.body).toEqual([
        expect.objectContaining({
          serverId: id,
          boughtServer: {
            stage: 'ready',
            poweredOff: null,
            deletesOn: null,
            deletedAt: null,
          },
        }),
      ]);
    });
  });

  describe.each(['deleting', 'deleted'] as BoughtServerStage[])(
    'a %s Bought Server whose record is kept',
    (stage) => {
      let id: string;
      let exec: jest.SpyInstance<
        ReturnType<RemoteExecService['execAsyncRemote']>,
        Parameters<RemoteExecService['execAsyncRemote']>
      >;

      beforeEach(async () => {
        ({ id } = await givenBoughtServer(stage));
        const remoteExec = ctx.app.get(RemoteExecService);
        exec = jest
          .spyOn(remoteExec, 'execAsyncRemote')
          .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
        // The platform host's turn in the log sweep stays off this machine.
        jest
          .spyOn(remoteExec, 'execAsync')
          .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      });

      it('is refused by the connection seam', async () => {
        await expect(
          ctx.app.get(ServerConnectionProvider).getConnection(id),
        ).rejects.toThrow(RETIRED_SERVER_MESSAGE);
      });

      it('is not sampled by monitoring, so its thresholds are never checked', async () => {
        await ctx.app.get(MonitoringService).collectServerMetrics(id);
        await ctx.app.get(MonitoringService).collectContainerMetrics(id);

        expect(exec).not.toHaveBeenCalled();
      });

      it('is skipped by the access-log upkeep', async () => {
        const rotate = jest
          .spyOn(ctx.app.get(TraefikFilesService), 'rotateAccessLogOn')
          .mockResolvedValue({ rotated: false } as never);

        expect(await ctx.app.get(ServerAccessLogUpkeepService).tick()).toEqual(
          [],
        );
        expect(rotate).not.toHaveBeenCalled();
      });

      it('is skipped by Docker cleanup and the deployment-log sweep', async () => {
        const cleanup = jest.spyOn(ctx.app.get(CleanupService), 'cleanupAll');

        await ctx.app.get(DockerCleanupService).runServerCleanup(id);
        await ctx.app.get(DeploymentLogRetentionService).sweep();

        expect(cleanup).not.toHaveBeenCalled();
        expect(exec.mock.calls.map(([serverId]) => serverId)).not.toContain(id);
      });
    },
  );
});
