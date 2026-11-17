// The Hosted instance with both provider tokens. Set before the app module is
// imported: ConfigModule snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();
process.env.HETZNER_EUR_API_TOKEN = 'eur-token-for-the-fake';
process.env.HETZNER_USD_API_TOKEN = 'usd-token-for-the-fake';

import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import request from 'supertest';
import { App } from 'supertest/types';

import { BoughtServerChangeSteps } from '../../src/bought-servers/bought-server-change-steps.service';
import { BoughtServerDeletion } from '../../src/bought-servers/bought-server-deletion.service';
import { BoughtServerNotifications } from '../../src/bought-servers/bought-server-notifications.service';
import { BoughtServerStages } from '../../src/bought-servers/bought-server-stages.service';
import { SETUP_CUT_OFF_MESSAGE } from '../../src/bought-servers/bought-server-stages.service';
import { boughtServer } from '../../src/bought-servers/bought-server.schema';
import { application } from '../../src/applications/application.schema';
import { bucket } from '../../src/buckets/bucket.schema';
import { BucketsService } from '../../src/buckets/buckets.service';
import { BoughtServersConfig } from '../../src/bought-servers/bought-servers.config';
import { BOUGHT_SERVER_NOT_READY_CODE } from '../../src/bought-servers/server-readiness';
import { LapseNotifications } from '../../src/cloud/billing/lapse-notifications.service';
import { BillingConfig } from '../../src/cloud/billing/billing.config';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';
import { MailService } from '../../src/mail/mail.service';
import { PermissionService } from '../../src/rbac/permission.service';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { server } from '../../src/servers/server.schema';
import { serverSetupCommand } from '../../src/servers/server-setup';
import { ServerSetupRuns } from '../../src/servers/server-setup-runs';
import {
  SSH_ANSWERS_PROBE,
  ServersService,
} from '../../src/servers/servers.service';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
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

const RENEWS_AT = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);

/** One Setup run `execAsyncRemote` was asked for, held until a test ends it. */
interface HeldRun {
  serverId: string;
  command: string;
  emit: (chunk: string) => void;
  finish: () => void;
  fail: (error: Error) => void;
}

/** Waits for `check` to hold, as a job or a run finishing in the background does. */
async function eventually<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
) {
  const until = Date.now() + 10_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A Bought Server's first Setup run (#1390, the amendment to ADR-0058):
 * Buy is the confirmed press for it, so once the machine answers the backend
 * starts it with no dial and no press, runs it once more by itself only if a
 * restart cut it off, and moves the stage to Ready when it ends. Until then
 * nothing deploys to the Server. A run that fails leaves it Ready with
 * Setup failed, emails the Operators, and refunds nothing. Either way the
 * Organization's owners and admins are emailed once that it is Ready (#70).
 *
 * The machine is the in-memory provider fake; the run is `execAsyncRemote`,
 * held by the test until it says how the run ends.
 */
describe('A Bought Server is set up by itself (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  const mail = new MailRecorder();

  let carried: string[] = [];
  let priceCount = 0;
  let held: HeldRun[] = [];
  /** SSH attempts the machine still refuses, as a machine still booting does. */
  let booting = 0;

  const subscriptionNow = (): Stripe.Subscription =>
    ({
      id: `sub_${owner.organizationId}`,
      object: 'subscription',
      status: 'active',
      customer: `cus_${owner.organizationId}`,
      metadata: {},
      latest_invoice: 'in_purchase',
      pending_update: null,
      items: {
        data: carried.map((price, i) => ({
          id: `si_${i}`,
          price: { id: price },
          quantity: 1,
          current_period_end: RENEWS_AT,
        })),
      },
    }) as unknown as Stripe.Subscription;

  const updateSubscription = jest.fn(
    (_id: string, params: Stripe.SubscriptionUpdateParams) => {
      carried = [
        ...carried,
        ...(params.items ?? []).map((item) => item.price as string),
      ];
      return Promise.resolve(subscriptionNow());
    },
  );
  const createRefund = jest.fn<
    Promise<Stripe.Refund>,
    Parameters<StripeApi['createRefund']>
  >();
  const stripe = fakeStripe({
    createRefund,
    createProduct: jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('exists'), { code: 'resource_already_exists' }),
      ),
    ),
    createPrice: jest.fn(() =>
      Promise.resolve({ id: `price_bought_${++priceCount}` } as Stripe.Price),
    ),
    retrieveSubscription: jest.fn(() => Promise.resolve(subscriptionNow())),
    updateSubscription,
    retrieveInvoice: jest.fn(() =>
      Promise.resolve({
        id: 'in_purchase',
        object: 'invoice',
        status: 'paid',
        amount_paid: 2500,
        payments: { data: [] },
      } as unknown as Stripe.Invoice),
    ),
    previewInvoice: jest.fn(() =>
      Promise.resolve({ amount_due: 1520, currency: 'usd' } as Stripe.Invoice),
    ),
  });

  const execAsyncRemote = jest.fn(
    (serverId: string, command: string, onData?: (chunk: string) => void) => {
      if (booting > 0) {
        booting -= 1;
        return Promise.reject(
          new ExecError(
            'SSH connection error: Timed out while waiting for handshake',
            { command, serverId, connectionFailed: true },
          ),
        );
      }
      if (command === SSH_ANSWERS_PROBE) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        held.push({
          serverId,
          command,
          emit: (chunk) => onData?.(chunk),
          finish: () => resolve(),
          fail: reject,
        });
      });
    },
  );
  /** The Setup runs asked for, leaving out the probes that wait for SSH. */
  const setupCalls = () =>
    execAsyncRemote.mock.calls.filter(
      ([, command]) => command !== SSH_ANSWERS_PROBE,
    );
  const exec = {
    execAsync: jest.fn(),
    execAsyncRemote,
    // The traefik.yml read-back after a run that finished.
    execRemote: jest.fn(() => Promise.resolve({ stdout: '', stderr: '' })),
  };

  function buy(): Promise<string> {
    return request(http)
      .post('/bought-servers')
      .set('Cookie', owner.cookie)
      .send({
        serverType: 'cpx22',
        location: 'hel1',
        name: 'web-1',
        termsAccepted: true,
        prorationDate: Math.floor(Date.now() / 1000),
      })
      .expect(201)
      .then((res) => (res.body as { id: string }).id);
  }

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
  const toOperators = () => mail.to(HOSTED_STAFF.email);

  /**
   * The backend after a restart: the stages over a fresh, empty map of runs,
   * as the boot builds them. Whatever ran in memory before is gone.
   */
  function restarted(): BoughtServerStages {
    return new BoughtServerStages(
      ctx.db,
      ctx.hetzner.machines,
      ctx.app.get(BoughtServersConfig),
      ctx.app.get(SshKeysService, { strict: false }),
      ctx.app.get(STRIPE_API, { strict: false }),
      ctx.app.get(BoughtServerNotifications, { strict: false }),
      ctx.app.get(BoughtServerChangeSteps, { strict: false }),
      new ServerSetupRuns(ctx.app.get(ServersService, { strict: false })),
      ctx.app.get(LapseNotifications, { strict: false }),
      ctx.app.get(PermissionService, { strict: false }),
      ctx.app.get(BoughtServerDeletion, { strict: false }),
      ctx.app.get(BillingConfig, { strict: false }),
    );
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
    // A run still held is left so: ending it now would write to a database
    // that is going away, and a pending promise keeps nothing alive.
    await ctx?.teardown();
  });

  beforeEach(async () => {
    for (const run of held) run.finish();
    held = [];
    booting = 0;
    await ctx.resetDb();
    jest.clearAllMocks();
    mail.clear();
    priceCount = 0;
    carried = ['price_starter_plan'];
    await openHostedSignUp(ctx.db);
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, 'starter');
    mail.clear();
  });

  describe('once the machine answers', () => {
    it('starts the first Setup run with no dial and no press', async () => {
      const id = await buy();

      await eventually(() => held.length === 1);
      expect(setupCalls()).toHaveLength(1);
      expect(held[0]).toMatchObject({
        serverId: id,
        command: serverSetupCommand(),
      });
      expect((await rowOf(id)).setupStarts).toBe(1);
    });

    it('waits for a machine still booting to accept SSH, then runs setup', async () => {
      booting = 2;
      const id = await buy();

      await eventually(() => held.length === 1);
      expect(held[0]).toMatchObject({
        serverId: id,
        command: serverSetupCommand(),
      });
      expect((await rowOf(id)).stage).toBe('setting_up');
      expect((await rowOf(id)).setupStarts).toBe(1);

      held[0].finish();
      await readyRow(id);
      expect(await serverOf(id)).toMatchObject({
        setupOk: true,
        setupMessage: null,
      });
      expect(toOperators()).toEqual([]);
    });

    it('shows Setting up on the Server until the run ends', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);

      const list = await request(http)
        .get('/servers')
        .set('Cookie', owner.cookie)
        .expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({
          serverId: id,
          boughtServer: {
            stage: 'setting_up',
            poweredOff: null,
            deletesOn: null,
            deletedAt: null,
          },
        }),
      ]);
    });

    it('lets the customer watch its log, as any Setup run', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);
      held[0].emit('1. Installing required packages\n');

      // What `/listen-server-setup` attaches a watch-dial to.
      const seen: string[] = [];
      const detach = ctx.app.get(ServerSetupRuns, { strict: false }).watch(id, {
        send: (chunk) => seen.push(chunk),
        end: (line) => seen.push(line),
      });
      expect(detach).not.toBeNull();
      held[0].emit('2. Installing Docker\n');

      expect(seen).toEqual([
        '1. Installing required packages\n',
        '2. Installing Docker\n',
      ]);
    });

    it('moves the stage to Ready when the run finishes', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);

      held[0].finish();
      await readyRow(id);

      expect(await serverOf(id)).toMatchObject({
        setupOk: true,
        setupMessage: null,
      });
      const one = await request(http)
        .get(`/servers/${id}`)
        .set('Cookie', owner.cookie)
        .expect(200);
      expect(one.body).toMatchObject({ boughtServer: { stage: 'ready' } });
      expect(toOperators()).toEqual([]);
    });
  });

  describe('a run that really fails', () => {
    it('is Ready with Setup failed on the Server, emails the Operators, and refunds nothing', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);

      held[0].fail(new Error('E: Unable to locate package docker-ce'));
      await readyRow(id);

      // The ordinary Setup card reads this: Setup failed, and Run setup.
      expect(await serverOf(id)).toMatchObject({
        setupOk: false,
        setupMessage: 'E: Unable to locate package docker-ce',
      });
      await eventually(() => toOperators().length === 1);
      const [email] = toOperators();
      expect(email.email.subject).toBe(
        "First setup failed on Hopper Labs's Bought Server web-1",
      );
      expect(email.email.html).toContain(
        'E: Unable to locate package docker-ce',
      );
      // The purchase stands: nothing is refunded, and the one update that
      // carries lines is the Buy's own (the others set a first Server's 3D
      // Secure and put it back, #1392).
      expect(createRefund).not.toHaveBeenCalled();
      expect(
        updateSubscription.mock.calls.filter(([, params]) => params.items),
      ).toHaveLength(1);
    });

    it('starts no other run by itself: every later run is a press of Run setup', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);
      held[0].fail(new Error('exit 1'));
      await readyRow(id);

      const stages = ctx.app.get(BoughtServerStages);
      await stages.advance(id);
      await stages.resumeSetups();
      await restarted().resumeSetups();

      expect(setupCalls()).toHaveLength(1);
    });
  });

  describe('the "your Server is ready" email', () => {
    const ADMIN = 'ada@example.com';
    const MEMBER = 'edsger@example.com';
    const READY = 'Your Server web-1 is ready';
    const READY_FAILED =
      'Your Server web-1 is ready, but its first setup failed';

    beforeEach(async () => {
      await signUpMember(http, owner.cookie, {
        email: ADMIN,
        name: 'Ada Lovelace',
        role: 'admin',
      });
      await signUpMember(http, owner.cookie, {
        email: MEMBER,
        name: 'Edsger Dijkstra',
        role: 'member',
      });
      mail.clear();
    });

    const readyEmails = () =>
      mail.sent.filter((sent) =>
        sent.email.subject.startsWith('Your Server web-1 is ready'),
      );
    /** Lets a send that would follow the stage's write land, if one would. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

    it('goes once to every owner and admin when the first setup finishes, naming the Server and linking to it', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);

      held[0].finish();
      await readyRow(id);
      await eventually(() => readyEmails().length === 2);
      await settle();

      expect(
        readyEmails()
          .map((sent) => sent.to)
          .sort(),
      ).toEqual([ADMIN, 'grace@example.com']);
      expect(mail.to(MEMBER)).toEqual([]);
      const [email] = mail.to(ADMIN);
      expect(email.email.subject).toBe(READY);
      expect(email.email.html).toContain('web-1');
      expect(email.email.html).toContain(`/servers/${id}`);
      expect(email.email.html).not.toContain('Run setup');
    });

    it('says the first setup failed and names Run setup, and the Operators still get their own email', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);

      held[0].fail(new Error('E: Unable to locate package docker-ce'));
      await readyRow(id);
      await eventually(() => readyEmails().length === 2);
      await eventually(() => toOperators().length === 1);

      for (const address of ['grace@example.com', ADMIN]) {
        const sent = mail.to(address);
        expect(sent).toHaveLength(1);
        expect(sent[0].email.subject).toBe(READY_FAILED);
        expect(sent[0].email.html).toContain('Run setup');
        expect(sent[0].email.html).toContain(`/servers/${id}`);
        expect(sent[0].email.html).not.toMatch(/hetzner/i);
      }
      expect(toOperators()[0].email.subject).toBe(
        "First setup failed on Hopper Labs's Bought Server web-1",
      );
    });

    it('says the first setup failed when it was cut off twice', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);
      await restarted().resumeSetups();
      await eventually(() => held.length === 2);

      await restarted().resumeSetups();
      await readyRow(id);
      await eventually(() => readyEmails().length === 2);
      await eventually(() => toOperators().length === 1);

      expect(mail.to(ADMIN).map((sent) => sent.email.subject)).toEqual([
        READY_FAILED,
      ]);
      expect(
        mail.to('grace@example.com').map((sent) => sent.email.subject),
      ).toEqual([READY_FAILED]);
    });

    it('sends nothing for a later Run setup, or for the stages resuming', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);
      held[0].fail(new Error('exit 1'));
      await readyRow(id);
      await eventually(() => readyEmails().length === 2);
      mail.clear();

      const pressed = request(http)
        .post(`/servers/${id}/setup`)
        .set('Cookie', owner.cookie)
        .then((res) => res.status);
      await eventually(() => held.length === 2);
      held[1].finish();
      expect(await pressed).toBe(200);
      await ctx.app.get(BoughtServerStages).advance(id);
      await restarted().resumeSetups();
      await settle();

      expect(mail.sent).toEqual([]);
    });

    it('never names the provider', async () => {
      const finished = await buy();
      await eventually(() => held.length === 1);
      held[0].finish();
      await readyRow(finished);
      await eventually(() => readyEmails().length === 2);

      for (const sent of readyEmails()) {
        expect(sent.email.subject).not.toMatch(/hetzner/i);
        expect(sent.email.html).not.toMatch(/hetzner/i);
      }
    });
  });

  describe('deleted while Setting up', () => {
    it('is deleted, and its first run ending afterwards tells no one and moves nothing', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);

      await request(http)
        .delete(`/servers/${id}`)
        .set('Cookie', owner.cookie)
        .expect(200);
      expect((await rowOf(id)).stage).toBe('deleted');

      held[0].fail(new Error('Connection closed'));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect((await rowOf(id)).stage).toBe('deleted');
      expect(toOperators()).toEqual([]);
      expect(ctx.hetzner.machines.servers()).toEqual([]);
    });
  });

  describe('a restart', () => {
    it('never starts a second run beside the one in flight', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);

      const stages = ctx.app.get(BoughtServerStages);
      await stages.advance(id);
      await stages.resumeSetups();

      expect(setupCalls()).toHaveLength(1);
      expect((await rowOf(id)).setupStarts).toBe(1);
    });

    it('that cut the first run off runs it once more by itself, then Ready', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);

      // The run on the machine is cut off with the process; the boot resumes.
      const afterRestart = restarted();
      afterRestart.onApplicationBootstrap();

      await eventually(() => held.length === 2);
      expect(held[1]).toMatchObject({
        serverId: id,
        command: serverSetupCommand(),
      });
      expect((await rowOf(id)).setupStarts).toBe(2);

      held[1].finish();
      await readyRow(id);
      expect(await serverOf(id)).toMatchObject({ setupOk: true });
      expect(toOperators()).toEqual([]);
    });

    it('that cut the run off twice starts no third: Ready with Setup failed, and the Operators told', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);
      await restarted().resumeSetups();
      await eventually(() => held.length === 2);

      await restarted().resumeSetups();

      // No third run, by itself or otherwise.
      expect(setupCalls()).toHaveLength(2);
      await readyRow(id);
      expect(await serverOf(id)).toMatchObject({
        setupOk: false,
        setupMessage: SETUP_CUT_OFF_MESSAGE,
      });
      await eventually(() => toOperators().length === 1);
    });
  });

  describe('deploys before Ready', () => {
    /** An Application on the Bought Server, with an image to deploy. */
    async function applicationOn(serverId: string): Promise<string> {
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
          deployTarget: { kind: 'server', serverId },
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
          serverId,
        })
        .expect(201);
      const { applicationId } = created.body as { applicationId: string };
      await request(http)
        .patch(`/applications/${applicationId}`)
        .set('Cookie', owner.cookie)
        .send({ sourceType: 'docker', dockerImage: 'nginx:1.27' })
        .expect(200);
      return applicationId;
    }

    it('refuses a deploy to a Bought Server that is still Setting up', async () => {
      const id = await buy();
      await eventually(() => held.length === 1);
      const applicationId = await applicationOn(id);

      const res = await request(http)
        .post(`/applications/${applicationId}/deployments`)
        .set('Cookie', owner.cookie)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: BOUGHT_SERVER_NOT_READY_CODE,
        message: 'web-1 is still being set up: deploy to it once it is Ready',
      });
      // Nothing was queued for it.
      const deployments = await request(http)
        .get(`/applications/${applicationId}/deployments`)
        .set('Cookie', owner.cookie);
      expect(deployments.body).toEqual([]);
    });

    it("refuses a bucket's Garage on a Bought Server that is still Setting up", async () => {
      const id = await buy();
      await eventually(() => held.length === 1);
      const applicationId = await applicationOn(id);
      const [{ environmentId }] = await ctx.db
        .select({ environmentId: application.environmentId })
        .from(application)
        .where(eq(application.applicationId, applicationId));
      const [made] = await ctx.db
        .insert(bucket)
        .values({
          name: 'files',
          configName: 'files',
          appName: 'bucket-files',
          bucketName: 'files',
          adminCredential: { rpcSecret: 'rpc', adminToken: 'admin' },
          volumeName: 'bucket-files-data',
          environmentId,
          serverId: id,
        })
        .returning({ bucketId: bucket.bucketId });

      await expect(
        ctx.app.get(BucketsService, { strict: false }).deploy(made.bucketId),
      ).rejects.toMatchObject({
        response: { code: BOUGHT_SERVER_NOT_READY_CODE },
      });
      expect(setupCalls()).toHaveLength(1);
    });
  });
});
