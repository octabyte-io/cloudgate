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

import { boughtServer } from '../../src/bought-servers/bought-server.schema';
import type { BoughtServerRestore } from '../../src/bought-servers/bought-server.schema';
import { RESTORE_GAVE_UP_SETUP_MESSAGE } from '../../src/bought-servers/bought-server-restore-steps.service';
import { BoughtServerStages } from '../../src/bought-servers/bought-server-stages.service';
import { BOUGHT_SERVER_NOT_READY_CODE } from '../../src/bought-servers/server-readiness';
import { subscription } from '../../src/cloud/billing/billing.schema';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';
import { MailService } from '../../src/mail/mail.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { server } from '../../src/servers/server.schema';
import { ServerSetupRuns } from '../../src/servers/server-setup-runs';
import { SSH_ANSWERS_PROBE } from '../../src/servers/servers.service';
import { fakeStripe } from '../utils/fake-stripe';
import { givenPlan } from '../utils/hosted-plan';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import type { HostedCustomer } from '../utils/hosted-sign-up';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

const RENEWS_AT = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);

/** One Server setup run `execAsyncRemote` was asked for, held until a test ends it. */
interface HeldRun {
  serverId: string;
  finish: () => void;
  fail: (error: Error) => void;
}

/** Waits for `check` to hold, as a restore going on in the background does. */
async function eventually<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
) {
  const until = Date.now() + 20_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * **Restore** on a Bought Server (#180, spec #177, ADR-0093): the disk put
 * back as it was at a Server backup. A new kind of change on the Changing
 * stage, never charged: a safety copy first (unless that would push out the
 * very backup chosen, which then needs its own go-ahead), the rebuild from
 * the chosen backup, the machine running again, then a Server setup run;
 * Ready again, and the owners and admins emailed once. A refused rebuild is
 * asked once more and then given up, leaving the Server Ready as it was.
 *
 * Stripe is a stub that pays every charge (Buy needs one) and counts every
 * call after it; the provider is the in-memory fake (`ctx.hetzner.machines`),
 * which a spec seeds with the backups its daily run would have made, and
 * whose backups asked for are being made until the spec finishes them. The
 * setup run is `execAsyncRemote`, held until the spec ends it.
 */
describe('Restore a Bought Server from a Server backup (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  const mail = new MailRecorder();

  let items: Array<{ id: string; price: string }> = [];
  let itemCount = 0;
  let priceCount = 0;
  let invoiceCount = 0;
  let held: HeldRun[] = [];
  /**
   * The Server the test is about. A run a test before left going can still
   * be asked for after it, so runs and calls are told apart by Server.
   */
  let current = '';

  const subscriptionNow = (latest = 'in_0'): Stripe.Subscription =>
    ({
      id: `sub_${owner.organizationId}`,
      object: 'subscription',
      status: 'active',
      customer: `cus_${owner.organizationId}`,
      metadata: {},
      latest_invoice: latest,
      pending_update: null,
      items: {
        data: items.map((item) => ({
          id: item.id,
          price: { id: item.price },
          quantity: 1,
          current_period_end: RENEWS_AT,
        })),
      },
    }) as unknown as Stripe.Subscription;

  const paidInvoice = (id: string): Stripe.Invoice =>
    ({
      id,
      object: 'invoice',
      status: 'paid',
      amount_paid: 3000,
      currency: 'usd',
      parent: {
        subscription_details: { subscription: `sub_${owner.organizationId}` },
      },
      payments: {
        data: [
          {
            status: 'paid',
            payment: {
              type: 'payment_intent',
              payment_intent: { id: `pi_${id}`, status: 'succeeded' },
            },
          },
        ],
      },
    }) as unknown as Stripe.Invoice;

  const createPrice = jest.fn((params: Stripe.PriceCreateParams) =>
    Promise.resolve({
      id: `price_${params.metadata?.kind as string}_${++priceCount}`,
    } as Stripe.Price),
  );
  const updateSubscription = jest.fn(
    (_id: string, params: Stripe.SubscriptionUpdateParams) => {
      for (const item of params.items ?? []) {
        if (item.deleted) {
          items = items.filter((one) => one.id !== item.id);
        } else if (!item.id) {
          items = [...items, { id: `si_${++itemCount}`, price: item.price! }];
        }
      }
      return Promise.resolve(subscriptionNow(`in_${++invoiceCount}`));
    },
  );
  const createRefund = jest.fn<
    Promise<Stripe.Refund>,
    Parameters<StripeApi['createRefund']>
  >(() => Promise.resolve({ id: 're_1' } as Stripe.Refund));
  const stripe: StripeApi = fakeStripe({
    createProduct: jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('exists'), { code: 'resource_already_exists' }),
      ),
    ),
    createPrice,
    retrieveSubscription: jest.fn(() => Promise.resolve(subscriptionNow())),
    updateSubscription,
    retrieveInvoice: jest.fn((id: string) => Promise.resolve(paidInvoice(id))),
    listInvoices: jest.fn(() => Promise.resolve([])),
    createRefund,
  });

  const execAsyncRemote = jest.fn((serverId: string, command: string) => {
    if (command === SSH_ANSWERS_PROBE) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      held.push({ serverId, finish: () => resolve(), fail: reject });
    });
  });
  /** The Server setup runs asked for on it, leaving out the probes that wait for SSH. */
  const setupCalls = () =>
    execAsyncRemote.mock.calls.filter(
      ([serverId, command]) =>
        serverId === current && command !== SSH_ANSWERS_PROBE,
    );
  /** Its setup run, once it is asked for. */
  const setupRun = () =>
    eventually(() => held.find((run) => run.serverId === current));
  const exec = {
    execAsync: jest.fn(),
    execAsyncRemote,
    execRemote: jest.fn(() => Promise.resolve({ stdout: '', stderr: '' })),
  };

  const fake = () => ctx.hetzner.machines;
  const machine = () => fake().servers()[0];
  const rowOf = async (id: string) =>
    (
      await ctx.db.select().from(boughtServer).where(eq(boughtServer.id, id))
    )[0];
  const serverOf = async (id: string) =>
    (await ctx.db.select().from(server).where(eq(server.serverId, id)))[0];
  const readyRow = (id: string) =>
    eventually(async () => {
      const row = await rowOf(id);
      return row.stage === 'ready' && row;
    });
  /**
   * Every one of `addresses` has been sent `subject`. Ready is written before
   * the email is sent, so a spec that reads the mail waits for it rather than
   * for Ready: beside other suites, the send can land after the read.
   */
  const told = (subject: string, ...addresses: string[]) =>
    eventually(() =>
      addresses.every((address) =>
        mail.to(address).some((one) => one.email.subject === subject),
      ),
    );
  const RESTORED = 'Your Server web-1 was restored from a backup';
  const providerCalls = () =>
    fake()
      .calls.map((call) => call.method)
      .filter((method) =>
        ['createBackup', 'rebuild', 'powerOn', 'powerOff'].includes(method),
      );

  /**
   * A Bought Server made with backups on, its first Setup run over, and
   * Ready, holding three daily backups: Nov 1, 2 and 3 at 03:00 UTC.
   */
  async function readyServer(backups = true) {
    const res = await request(http)
      .post('/bought-servers')
      .set('Cookie', owner.cookie)
      .send({
        serverType: 'cpx22',
        location: 'hel1',
        name: 'web-1',
        termsAccepted: true,
        prorationDate: Math.floor(Date.now() / 1000),
        backups,
      });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    current = id;
    (await setupRun()).finish();
    await readyRow(id);
    // Its Ready email too, so it is not left to land in the spec's own mail.
    await told('Your Server web-1 is ready', 'grace@example.com');
    held = [];
    const daily = backups
      ? [1, 2, 3].map((day) =>
          fake().addBackup(machine().id, {
            created: `2026-11-0${day}T03:00:00+00:00`,
            imageSizeGb: 2.1,
          }),
        )
      : [];
    jest.clearAllMocks();
    mail.clear();
    fake().calls.length = 0;
    return { id, daily };
  }

  function restore(
    id: string,
    backupId: number,
    body: Record<string, unknown> = {},
    cookie = owner.cookie,
  ) {
    return request(http)
      .post(`/bought-servers/${id}/backups/${backupId}/restore`)
      .set('Cookie', cookie)
      .send(body);
  }

  function listBackups(id: string) {
    return request(http)
      .get(`/bought-servers/${id}/backups`)
      .set('Cookie', owner.cookie);
  }

  /** The safety copy being made, once the restore has asked for it. */
  const safetyCopy = () =>
    eventually(async () => {
      const backups = await fake().listBackups(machine().id);
      return (
        backups.ok &&
        backups.value.find(
          (one) =>
            one.description.startsWith('Before restore') &&
            one.status === 'creating',
        )
      );
    });

  /** The restore asked for, its safety copy made, and its setup run ended. */
  async function restoredFully(id: string, backupId: number) {
    expect((await restore(id, backupId)).status).toBe(202);
    const copy = await safetyCopy();
    fake().finishBackup(copy.id, 2.2);
    (await setupRun()).finish();
    held = [];
    await readyRow(id);
    // Its last step, the email, is over too: nothing of it lands in the next.
    await told(RESTORED, 'grace@example.com');
    return copy;
  }

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        { provide: STRIPE_API, useValue: stripe },
        { provide: RemoteExecService, useValue: exec },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    for (const run of held) run.finish();
    held = [];
    await ctx.resetDb();
    jest.clearAllMocks();
    mail.clear();
    items = [{ id: 'si_plan', price: 'price_starter_plan' }];
    itemCount = 0;
    priceCount = 0;
    invoiceCount = 0;
    await openHostedSignUp(ctx.db);
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, 'starter');
  });

  describe('the steps', () => {
    it('takes the safety copy first and waits until it is made before the rebuild', async () => {
      const { id, daily } = await readyServer();

      const res = await restore(id, daily[1].id);

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        stage: 'changing',
        change: { restore: { backupTakenAt: '2026-11-02T03:00:00.000Z' } },
      });
      const copy = await safetyCopy();
      expect(fake().callsTo('createBackup')).toEqual([
        [
          machine().id,
          expect.stringMatching(
            /^Before restore, \d{4}-\d\d-\d\d \d\d:\d\d UTC$/,
          ),
        ],
      ]);
      // Still being made: nothing is rebuilt yet.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(providerCalls()).toEqual(['createBackup']);

      fake().finishBackup(copy.id, 2.2);

      await eventually(() => fake().callsTo('rebuild').length === 1);
      expect(fake().callsTo('rebuild')).toEqual([[machine().id, daily[1].id]]);
      expect((await rowOf(id)).stage).toBe('changing');
    });

    it('rebuilds the disk from the chosen backup, keeping the machine, then runs Server setup and is Ready', async () => {
      const { id, daily } = await readyServer();
      const before = machine();

      await restoredFully(id, daily[1].id);

      expect(providerCalls()).toEqual(['createBackup', 'rebuild']);
      expect(machine()).toMatchObject({
        id: before.id,
        ipv4: before.ipv4,
        ipv6: before.ipv6,
        labels: before.labels,
        volumeIds: before.volumeIds,
        status: 'running',
        rebuiltFrom: daily[1].id,
      });
      // The setup run waited for SSH, then ran.
      expect(execAsyncRemote.mock.calls[0][1]).toBe(SSH_ANSWERS_PROBE);
      expect(setupCalls()).toHaveLength(1);
      expect(await rowOf(id)).toMatchObject({
        stage: 'ready',
        changeTarget: null,
        changeTries: 0,
      });
      expect(await serverOf(id)).toMatchObject({ setupOk: true });
    });

    it('lists the safety copy afterwards, and restoring it is an ordinary restore', async () => {
      const { id, daily } = await readyServer();
      const copy = await restoredFully(id, daily[1].id);

      const listed = (await listBackups(id)).body as Array<{
        id: number;
        beingMade: boolean;
      }>;
      expect(listed.map((backup) => backup.id)).toEqual([
        copy.id,
        daily[2].id,
        daily[1].id,
        daily[0].id,
      ]);
      fake().calls.length = 0;
      held = [];

      await restoredFully(id, copy.id);

      expect(providerCalls()).toEqual(['createBackup', 'rebuild']);
      expect(fake().callsTo('rebuild')).toEqual([[machine().id, copy.id]]);
      expect(machine().rebuiltFrom).toBe(copy.id);
    });

    it('powers the machine on when it is off once rebuilt', async () => {
      const { id, daily } = await readyServer();
      await fake().powerOff(machine().id);
      fake().calls.length = 0;

      await restoredFully(id, daily[2].id);

      expect(providerCalls()).toEqual(['createBackup', 'rebuild', 'powerOn']);
      expect(machine().status).toBe('running');
    });

    it('is Ready with Setup failed when the setup run after it fails', async () => {
      const { id, daily } = await readyServer();
      expect((await restore(id, daily[1].id)).status).toBe(202);
      const copy = await safetyCopy();
      fake().finishBackup(copy.id, 2.2);
      const run = await setupRun();

      run.fail(new Error('E: Unable to locate package docker-ce'));

      await readyRow(id);
      await told(RESTORED, 'grace@example.com');
      expect(await serverOf(id)).toMatchObject({ setupOk: false });
    });
  });

  describe('the oldest of 7 backups', () => {
    async function sevenBackups() {
      const { id } = await readyServer(true);
      const more = [4, 5, 6, 7].map((day) =>
        fake().addBackup(machine().id, {
          created: `2026-11-0${day}T03:00:00+00:00`,
          imageSizeGb: 2.1,
        }),
      );
      const listed = (await listBackups(id)).body as Array<{ id: number }>;
      fake().calls.length = 0;
      return { id, oldest: listed.at(-1)!.id, newest: more.at(-1)!.id };
    }

    it('is refused unless the request says to go ahead without a safety copy, asking the provider nothing', async () => {
      const { id, oldest } = await sevenBackups();

      const res = await restore(id, oldest);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'NO_SAFETY_COPY',
        message:
          'This is the oldest of 7 backups, so a safety copy would remove it. Confirm restoring without one, or pick a newer backup',
      });
      expect(providerCalls()).toEqual([]);
      expect((await rowOf(id)).stage).toBe('ready');
    });

    it('rebuilds at once with no safety copy once the go-ahead is given', async () => {
      const { id, oldest } = await sevenBackups();

      const res = await restore(id, oldest, { withoutSafetyCopy: true });

      expect(res.status).toBe(202);
      const run = await setupRun();
      expect(providerCalls()).toEqual(['rebuild']);
      expect(fake().callsTo('rebuild')).toEqual([[machine().id, oldest]]);
      run.finish();
      await readyRow(id);
      await told(RESTORED, 'grace@example.com');
    });

    it('still takes a safety copy of a newer one, pushing out the oldest', async () => {
      const { id, newest } = await sevenBackups();

      expect((await restore(id, newest)).status).toBe(202);

      await safetyCopy();
      expect(fake().callsTo('createBackup')).toHaveLength(1);
    });
  });

  describe('a restart at any step', () => {
    /** The restore as a restart left it, with no step running here. */
    async function cutOff(
      id: string,
      restore: Partial<BoughtServerRestore>,
      changeTries = 0,
    ) {
      const backups = await fake().listBackups(machine().id);
      const chosen = backups.ok ? backups.value[1] : null;
      await ctx.db
        .update(boughtServer)
        .set({
          stage: 'changing',
          changeTarget: {
            charged: false,
            lines: [],
            restore: {
              backupId: chosen!.id,
              backupTakenAt: new Date(chosen!.created).toISOString(),
              requestedBy: owner.id,
              safetyCopy: {
                description: 'Before restore, 2026-11-27 14:05 UTC',
                id: null,
                available: false,
              },
              ...restore,
            },
          },
          changeTries,
        })
        .where(eq(boughtServer.id, id));
      fake().calls.length = 0;
      return chosen!;
    }

    const resume = (id: string) => ctx.app.get(BoughtServerStages).advance(id);

    it('finds a safety copy a restart cut off by its description, and takes no second one', async () => {
      const { id } = await readyServer();
      const taken = fake().addBackup(machine().id, {
        created: new Date().toISOString(),
        imageSizeGb: 2.2,
        description: 'Before restore, 2026-11-27 14:05 UTC',
      });
      const chosen = await cutOff(id, {}, 1);

      await resume(id);

      expect(fake().callsTo('createBackup')).toEqual([]);
      expect(fake().callsTo('rebuild')).toEqual([[machine().id, chosen.id]]);
      expect((await rowOf(id)).changeTarget?.restore?.safetyCopy).toEqual({
        description: 'Before restore, 2026-11-27 14:05 UTC',
        id: taken.id,
        available: true,
      });
    });

    it('waits for a safety copy still being made, then rebuilds', async () => {
      const { id } = await readyServer();
      const copy = fake().addBackup(machine().id, {
        created: new Date().toISOString(),
        imageSizeGb: null,
        status: 'creating',
        description: 'Before restore, 2026-11-27 14:05 UTC',
      });
      await cutOff(id, {
        safetyCopy: {
          description: 'Before restore, 2026-11-27 14:05 UTC',
          id: copy.id,
          available: false,
        },
      });

      await resume(id);
      expect(fake().callsTo('rebuild')).toEqual([]);

      fake().finishBackup(copy.id, 2.2);
      await resume(id);

      expect(fake().callsTo('rebuild')).toHaveLength(1);
    });

    it('rebuilds again when cut off after the safety copy was made', async () => {
      const { id } = await readyServer();
      const chosen = await cutOff(id, { safetyCopy: null });

      await resume(id);

      expect(fake().callsTo('createBackup')).toEqual([]);
      expect(fake().callsTo('rebuild')).toEqual([[machine().id, chosen.id]]);
      await setupRun();
    });

    it('reads a rebuild the provider was making, and asks for no second one', async () => {
      const { id } = await readyServer();
      const chosen = await cutOff(id, { safetyCopy: null });
      const made = await fake().rebuild(machine().id, chosen.id);
      fake().calls.length = 0;
      await cutOff(
        id,
        {
          safetyCopy: null,
          rebuildActionId: made.ok ? made.value.id : -1,
        },
        1,
      );

      await resume(id);

      expect(fake().callsTo('rebuild')).toEqual([]);
      expect((await rowOf(id)).changeTarget?.restore).toMatchObject({
        rebuilt: true,
        running: true,
      });
      await setupRun();
    });

    it('powers on a machine a restart left off after the rebuild', async () => {
      const { id } = await readyServer();
      await fake().powerOff(machine().id);
      await cutOff(id, { safetyCopy: null, rebuilt: true });

      await resume(id);

      expect(providerCalls()).toEqual(['powerOn']);
      await setupRun();
    });

    it('runs Server setup once more when a restart cut the run off', async () => {
      const { id } = await readyServer();
      await cutOff(id, {
        safetyCopy: null,
        rebuilt: true,
        running: true,
        setupStarts: 1,
      });

      await resume(id);

      const run = await setupRun();
      expect(providerCalls()).toEqual([]);
      expect((await rowOf(id)).changeTarget?.restore?.setupStarts).toBe(2);
      run.finish();
      await readyRow(id);
      await told(RESTORED, 'grace@example.com');
    });

    it('starts no third setup run: Ready with Setup failed, and the owners told once', async () => {
      const { id } = await readyServer();
      await cutOff(id, {
        safetyCopy: null,
        rebuilt: true,
        running: true,
        setupStarts: 2,
      });

      await resume(id);

      expect(setupCalls()).toEqual([]);
      await readyRow(id);
      await told(RESTORED, 'grace@example.com');
      expect(await serverOf(id)).toMatchObject({ setupOk: false });
      expect(
        mail.to('grace@example.com').map((one) => one.email.subject),
      ).toEqual(['Your Server web-1 was restored from a backup']);
    });

    it('waits for a rebuild the provider is still making after a restart cut its answer off, and asks for no second one', async () => {
      const { id } = await readyServer();
      await cutOff(id, { safetyCopy: null }, 1);
      fake().setStatus(machine().id, 'rebuilding');

      await resume(id);

      expect(fake().callsTo('rebuild')).toEqual([]);
      expect(await rowOf(id)).toMatchObject({
        stage: 'changing',
        changeTries: 1,
      });
    });

    it('never says the Server is as it was when a rebuild a restart cut off may have been made, and marks its setup failed', async () => {
      const { id } = await readyServer();
      await cutOff(id, { safetyCopy: null }, 1);
      fake().refuse('rebuild', 'locked');

      await resume(id);

      await readyRow(id);
      expect(fake().callsTo('rebuild')).toHaveLength(1);
      expect(await serverOf(id)).toMatchObject({
        setupOk: false,
        setupMessage: RESTORE_GAVE_UP_SETUP_MESSAGE,
      });
      const [sent] = mail.to('grace@example.com');
      const html = sent.email.html.replace(/<!-- -->/g, '');
      expect(html).toContain('could not tell whether its disk was restored');
      expect(html).not.toContain('as it was');
    });

    it('gives up without touching the disk when a newer backup means the safety copy would now remove the one chosen', async () => {
      const { id } = await readyServer();
      // Nov 2 is chosen; five more days push Nov 1 out, and Nov 2 is the oldest of 7.
      const chosen = await cutOff(id, {});
      for (const day of [4, 5, 6, 7, 8]) {
        fake().addBackup(machine().id, {
          created: `2026-11-0${day}T03:00:00+00:00`,
          imageSizeGb: 2.1,
        });
      }
      fake().calls.length = 0;

      await resume(id);

      expect(providerCalls()).toEqual([]);
      expect(await rowOf(id)).toMatchObject({
        stage: 'ready',
        changeTarget: null,
        changeTries: 0,
      });
      expect(machine().rebuiltFrom).toBeNull();
      const backups = await fake().listBackups(machine().id);
      expect(backups.ok && backups.value.map((one) => one.id)).toContain(
        chosen.id,
      );
      expect(await serverOf(id)).toMatchObject({ setupOk: true });
      expect(createRefund).not.toHaveBeenCalled();
      expect(updateSubscription).not.toHaveBeenCalled();
      const sent = mail.to('grace@example.com');
      expect(sent.map((one) => one.email.subject)).toEqual([
        "We couldn't restore web-1 from its backup",
      ]);
      expect(sent[0].email.html.replace(/<!-- -->/g, '')).toContain(
        'its safety copy would now remove that backup',
      );
    });

    it('waits for a setup run already going on the Server, then runs its own once that one ends', async () => {
      const { id } = await readyServer();
      await cutOff(id, { safetyCopy: null, rebuilt: true, running: true });
      void ctx.app.get(ServerSetupRuns).start(
        id,
        {
          user: { id: owner.id },
          session: { activeOrganizationId: owner.organizationId },
        },
        {},
      );
      const pressed = await setupRun();
      held = [];

      await resume(id);
      expect(setupCalls()).toHaveLength(1);

      pressed.finish();

      const own = await setupRun();
      expect(setupCalls()).toHaveLength(2);
      expect((await rowOf(id)).changeTarget?.restore?.setupStarts).toBe(1);
      own.finish();
      await readyRow(id);
      await told(RESTORED, 'grace@example.com');
    });

    it('finishes when the setup run ended before a restart could say so', async () => {
      const { id } = await readyServer();
      await cutOff(id, {
        safetyCopy: null,
        rebuilt: true,
        running: true,
        setupStarts: 1,
        setup: { ok: true, message: null },
      });

      await resume(id);

      expect(setupCalls()).toEqual([]);
      expect((await rowOf(id)).stage).toBe('ready');
    });
  });

  describe('while it runs', () => {
    it('refuses a deploy to the Server while it is Changing', async () => {
      const { id, daily } = await readyServer();
      const project = await request(http)
        .post('/projects')
        .set('Cookie', owner.cookie)
        .send({ name: 'shop' })
        .expect(201);
      const environment = await request(http)
        .post('/environments')
        .set('Cookie', owner.cookie)
        .send({
          name: 'production',
          projectId: (project.body as { projectId: string }).projectId,
          deployTarget: { kind: 'server', serverId: id },
        })
        .expect(201);
      const created = await request(http)
        .post('/applications')
        .set('Cookie', owner.cookie)
        .send({
          name: 'web',
          appName: 'web',
          environmentId: (environment.body as { environmentId: string })
            .environmentId,
          serverId: id,
        })
        .expect(201);
      const { applicationId } = created.body as { applicationId: string };
      await request(http)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', owner.cookie)
        .send({ sourceType: 'docker', dockerImage: 'nginx:1.27' })
        .expect(200);
      expect((await restore(id, daily[1].id)).status).toBe(202);
      await safetyCopy();

      const res = await request(http)
        .post(`/applications/${applicationId}/deployments`)
        .set('Cookie', owner.cookie)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: BOUGHT_SERVER_NOT_READY_CODE });
    });

    it('refuses a second restore while the first one runs', async () => {
      const { id, daily } = await readyServer();
      expect((await restore(id, daily[1].id)).status).toBe(202);

      const res = await restore(id, daily[2].id);

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        'A change is already running on this Server. Wait for it to finish',
      );
    });
  });

  describe('what it costs and who is told', () => {
    it('charges nothing and emails the owners and admins once, naming the backup', async () => {
      const { id, daily } = await readyServer();
      await signUpMember(http, owner.cookie, {
        email: 'ada@example.com',
        role: 'admin',
      });
      mail.clear();

      await restoredFully(id, daily[1].id);
      await told(RESTORED, 'grace@example.com', 'ada@example.com');

      expect(createPrice).not.toHaveBeenCalled();
      expect(updateSubscription).not.toHaveBeenCalled();
      expect(createRefund).not.toHaveBeenCalled();
      for (const address of ['grace@example.com', 'ada@example.com']) {
        const sent = mail.to(address);
        expect(sent.map((one) => one.email.subject)).toEqual([
          'Your Server web-1 was restored from a backup',
        ]);
        const html = sent[0].email.html.replace(/<!-- -->/g, '');
        expect(html).toContain('Nov 02, 2026 at 03:00 UTC');
        expect(html).not.toMatch(/hetzner|cpx22/i);
      }
    });

    it('sends nothing more when a resume reaches the finished restore again', async () => {
      const { id, daily } = await readyServer();
      await restoredFully(id, daily[1].id);
      mail.clear();

      await ctx.app.get(BoughtServerStages).advance(id);

      expect(mail.sent).toEqual([]);
    });
  });

  describe('a refused rebuild', () => {
    it('is asked once more after a refusal', async () => {
      const { id, daily } = await readyServer();
      fake().refuse('rebuild', 'locked');

      expect((await restore(id, daily[1].id)).status).toBe(202);
      fake().finishBackup((await safetyCopy()).id, 2.2);

      await setupRun();
      expect(fake().callsTo('rebuild')).toHaveLength(2);
      expect(machine().rebuiltFrom).toBe(daily[1].id);
    });

    it('gives up after the second refusal, leaving the Server Ready as it was and the owners told', async () => {
      const { id, daily } = await readyServer();
      fake().refuse('rebuild', 'locked', 2);

      expect((await restore(id, daily[1].id)).status).toBe(202);
      fake().finishBackup((await safetyCopy()).id, 2.2);

      const row = await readyRow(id);
      await told(
        "We couldn't restore web-1 from its backup",
        'grace@example.com',
      );
      expect(row).toMatchObject({ changeTarget: null, changeTries: 0 });
      expect(fake().callsTo('rebuild')).toHaveLength(2);
      expect(machine()).toMatchObject({ rebuiltFrom: null, status: 'running' });
      expect(setupCalls()).toEqual([]);
      expect(createRefund).not.toHaveBeenCalled();
      const sent = mail.to('grace@example.com');
      expect(sent.map((one) => one.email.subject)).toEqual([
        "We couldn't restore web-1 from its backup",
      ]);
      const html = sent[0].email.html.replace(/<!-- -->/g, '');
      expect(html).toContain('web-1 is as it was');
      expect(html).not.toMatch(/hetzner|locked/i);
    });
  });

  describe('given up once its disk was restored', () => {
    it('marks its setup failed, so Run setup is offered, and the email says the disk was restored and what is left', async () => {
      const { id, daily } = await readyServer();
      await fake().powerOff(machine().id);
      fake().refuse('powerOn', 'locked', 2);

      expect((await restore(id, daily[1].id)).status).toBe(202);
      fake().finishBackup((await safetyCopy()).id, 2.2);

      await readyRow(id);
      await told(
        "We couldn't restore web-1 from its backup",
        'grace@example.com',
      );
      expect(machine().rebuiltFrom).toBe(daily[1].id);
      expect(setupCalls()).toEqual([]);
      expect(await serverOf(id)).toMatchObject({
        setupOk: false,
        setupMessage: RESTORE_GAVE_UP_SETUP_MESSAGE,
      });
      const html = mail
        .to('grace@example.com')[0]
        .email.html.replace(/<!-- -->/g, '');
      expect(html).toContain('We restored the disk of web-1');
      expect(html).toContain('press Run setup on its Setup card');
      expect(html).not.toContain('as it was');
    });
  });

  describe('refusals', () => {
    it('is refused while the Organization is frozen, asking the provider nothing', async () => {
      const { id, daily } = await readyServer();
      await ctx.db
        .update(subscription)
        .set({ suspendedAt: new Date(), suspendedReason: 'Sending spam' })
        .where(eq(subscription.organizationId, owner.organizationId));

      const res = await restore(id, daily[1].id);

      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe('ORGANIZATION_FROZEN');
      expect(providerCalls()).toEqual([]);
    });

    it('is refused until the Server is Ready', async () => {
      const { id, daily } = await readyServer();
      await ctx.db
        .update(boughtServer)
        .set({ stage: 'setting_up' })
        .where(eq(boughtServer.id, id));

      const res = await restore(id, daily[1].id);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'BOUGHT_SERVER_NOT_CHANGEABLE',
        message: "This Server can't be changed until it is Ready",
      });
      expect(providerCalls()).toEqual([]);
    });

    it('is refused for a Server an operator powered off', async () => {
      const { id, daily } = await readyServer();
      await ctx.db
        .update(boughtServer)
        .set({ poweredOffAt: new Date(), poweredOffReason: 'Abuse report' })
        .where(eq(boughtServer.id, id));

      const res = await restore(id, daily[1].id);

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        "This Server was powered off by an operator, so it can't be changed",
      );
      expect(providerCalls()).toEqual([]);
    });

    it('is refused while the Server is in maintenance, asking the provider nothing', async () => {
      const { id, daily } = await readyServer();
      await ctx.db
        .update(server)
        .set({ maintenanceSince: new Date().toISOString() })
        .where(eq(server.serverId, id));

      const res = await restore(id, daily[1].id);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'SERVER_IN_MAINTENANCE',
        message: 'web-1 is in maintenance',
      });
      expect(providerCalls()).toEqual([]);
      expect((await rowOf(id)).stage).toBe('ready');
    });

    it.each<[string, (id: string) => Promise<unknown>]>([
      [
        'an operator powers it off',
        (id: string) =>
          ctx.db
            .update(boughtServer)
            .set({ poweredOffAt: new Date(), poweredOffReason: 'Abuse report' })
            .where(eq(boughtServer.id, id)),
      ],
      [
        'maintenance begins',
        (id: string) =>
          ctx.db
            .update(server)
            .set({ maintenanceSince: new Date().toISOString() })
            .where(eq(server.serverId, id)),
      ],
    ])(
      'is refused when %s while the press is checked, and claims nothing',
      async (_, meanwhile) => {
        const { id, daily } = await readyServer();
        // Between the checks and the claim: the provider is asked for the
        // list. The call inside is the spy's own, past its one replacement.
        const machines = fake();
        jest
          .spyOn(machines, 'listBackups')
          .mockImplementationOnce(async (machineId) => {
            await meanwhile(id);
            return machines.listBackups(machineId);
          });

        const res = await restore(id, daily[1].id);

        expect(res.status).toBe(409);
        expect(await rowOf(id)).toMatchObject({
          stage: 'ready',
          changeTarget: null,
        });
        expect(providerCalls()).toEqual([]);
      },
    );

    it('is refused while backups are off', async () => {
      const { id } = await readyServer(false);

      const res = await restore(id, 1234);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'BACKUPS_OFF',
        message: 'Turn backups on to restore this Server',
      });
    });

    it('is refused for a backup that is not one of the Server’s', async () => {
      const { id } = await readyServer();

      const res = await restore(id, 999_999);

      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        'That backup is not one of this Server’s',
      );
      expect(providerCalls()).toEqual([]);
    });

    it('is refused for a backup still being made', async () => {
      const { id } = await readyServer();
      const making = fake().addBackup(machine().id, {
        created: new Date().toISOString(),
        imageSizeGb: null,
        status: 'creating',
      });
      fake().calls.length = 0;

      const res = await restore(id, making.id);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'BACKUP_BEING_MADE',
        message: 'That backup is still being made. Restore it once it is made',
      });
      expect(providerCalls()).toEqual([]);
    });

    it('is refused to a member, who may not change a Server', async () => {
      const { id, daily } = await readyServer();
      const member = await signUpMember(http, owner.cookie, {
        email: 'edsger@example.com',
      });

      const res = await restore(id, daily[1].id, {}, member.cookie);

      expect(res.status).toBe(403);
      expect(providerCalls()).toEqual([]);
    });

    it("answers 404 for another Organization's Server", async () => {
      const { id, daily } = await readyServer();
      const other = await signUpHostedCustomer(http, mail, {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'super-secret-password',
        organizationName: 'Lovelace Labs',
      });

      const res = await restore(id, daily[1].id, {}, other.cookie);

      expect(res.status).toBe(404);
      expect(providerCalls()).toEqual([]);
    });
  });
});
