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
import type { BoughtServerRestoreRedeploys } from '../../src/bought-servers/bought-server.schema';
import { BoughtServersHourly } from '../../src/bought-servers/bought-servers-hourly.service';
import { BoughtServerStages } from '../../src/bought-servers/bought-server-stages.service';
import { bucket } from '../../src/buckets/bucket.schema';
import { BucketsService } from '../../src/buckets/buckets.service';
import { subscription } from '../../src/cloud/billing/billing.schema';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';
import { postgres } from '../../src/databases/postgres/postgres.schema';
import { deployment } from '../../src/deployments/deployment.schema';
import type { DeploymentJob } from '../../src/deployment-queue/job-types';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import type {
  JobState,
  QueuedJob,
  QueuePort,
} from '../../src/deployment-queue/queue.port';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { MailService } from '../../src/mail/mail.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { server } from '../../src/servers/server.schema';
import { serverSetupCommand } from '../../src/servers/server-setup';
import { SSH_ANSWERS_PROBE } from '../../src/servers/servers.service';
import { withArgvExec } from '../utils/exec-double';
import { fakeStripe } from '../utils/fake-stripe';
import { givenPlan } from '../utils/hosted-plan';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import type { HostedCustomer } from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { isPresenceProbe } from '../utils/workload-presence-probe';

jest.setTimeout(180_000);

const RENEWS_AT = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);

/** The restored backup is the one of Nov 2, 03:00 UTC: these are either side of it. */
const BEFORE_THE_BACKUP = '2026-11-01T12:00:00.000Z';
const AFTER_THE_BACKUP = '2026-11-02T09:00:00.000Z';

/** One Server setup run, held until a test ends it. */
interface HeldRun {
  serverId: string;
  finish: () => void;
}

/** The deployment queue as a list: a queued job is asserted, never run. */
class ListQueue implements QueuePort {
  jobs: QueuedJob[] = [];
  private next = 0;

  add(data: DeploymentJob): Promise<QueuedJob> {
    const job: QueuedJob = { id: `job-${++this.next}`, data, state: 'waiting' };
    this.jobs.push(job);
    return Promise.resolve({ ...job });
  }

  getJobs(states?: JobState[]): Promise<QueuedJob[]> {
    return Promise.resolve(
      this.jobs.filter((job) => !states || states.includes(job.state)),
    );
  }

  cancel(): Promise<boolean> {
    return Promise.resolve(false);
  }

  clearWaiting(): Promise<QueuedJob[]> {
    return Promise.resolve([]);
  }
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
 * **The redeploys after a Restore** (#181, spec #177, ADR-0093): once the
 * Server setup run after it ended, every Service on the Bought Server whose
 * current Deployment finished after the restored backup was taken is
 * redeployed, so its data is the backup's and its code the current version;
 * one deployed before the backup is left as the backup has it. Each of the
 * deploy paths the Bought Server readiness rule guards is covered: an
 * Application and a Compose stack (a Deployment queued), a Database on the
 * Server and a Bucket (their own deploy). A redeploy that fails shows on its
 * Service and fails nothing else; the one email names each Service.
 *
 * The provider is the in-memory fake, Stripe a stub, the Server's shell and
 * Docker daemon doubles, and the queue a list. The setup run is held until
 * the spec ends it. A Service's past Deployments are written as rows, at
 * times either side of the backup.
 */
describe('Restore a Bought Server redeploys what is newer (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  const mail = new MailRecorder();
  const queue = new ListQueue();

  let held: HeldRun[] = [];
  let current = '';
  let environmentId = '';

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
        data: [
          {
            id: 'si_plan',
            price: { id: 'price_starter_plan' },
            quantity: 1,
            current_period_end: RENEWS_AT,
          },
        ],
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

  let invoiceCount = 0;
  let priceCount = 0;
  const stripe: StripeApi = fakeStripe({
    createProduct: jest.fn(() =>
      Promise.reject(
        Object.assign(new Error('exists'), { code: 'resource_already_exists' }),
      ),
    ),
    createPrice: jest.fn((params: Stripe.PriceCreateParams) =>
      Promise.resolve({
        id: `price_${params.metadata?.kind as string}_${++priceCount}`,
      } as Stripe.Price),
    ),
    retrieveSubscription: jest.fn(() => Promise.resolve(subscriptionNow())),
    updateSubscription: jest.fn(() =>
      Promise.resolve(subscriptionNow(`in_${++invoiceCount}`)),
    ),
    retrieveInvoice: jest.fn((id: string) => Promise.resolve(paidInvoice(id))),
    listInvoices: jest.fn(() => Promise.resolve([])),
    createRefund: jest.fn(() =>
      Promise.resolve({ id: 're_1' } as Stripe.Refund),
    ),
  });

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
  /** The Server's shell: setup runs are held, anything else answers at once. */
  const shell = (serverId: string, command: string) => {
    if (command === serverSetupCommand()) {
      return new Promise<ExecResult>((resolve) => {
        held.push({ serverId, finish: () => resolve(ok()) });
      });
    }
    if (command === SSH_ANSWERS_PROBE) return Promise.resolve(ok());
    if (isPresenceProbe(command)) return Promise.resolve(ok('absent'));
    if (command.includes('garage key create')) {
      return Promise.resolve(
        ok(
          'CLOUDGATE_KEY_ID=GK0a0a0a0a0a0a0a0a0a0a0a01\nCLOUDGATE_SECRET_KEY=' +
            'a1'.repeat(32) +
            '\n',
        ),
      );
    }
    return Promise.resolve(ok());
  };
  const exec = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string, unknown?]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });
  const dockerService = { inspect: jest.fn(), update: jest.fn() };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    listTasks: jest.fn(),
    getSecret: jest.fn(() => ({
      inspect: jest.fn().mockRejectedValue(new Error('no such secret')),
    })),
    createSecret: jest.fn(),
  };
  /** The Swarm services a deploy created, by name. */
  const created = () =>
    docker.createService.mock.calls.map(
      (args: unknown[]) => (args[args.length - 1] as { Name: string }).Name,
    );

  const fake = () => ctx.hetzner.machines;
  const machine = () => fake().servers()[0];
  const rowOf = async (id: string) =>
    (
      await ctx.db.select().from(boughtServer).where(eq(boughtServer.id, id))
    )[0];
  const readyRow = (id: string) =>
    eventually(async () => {
      const row = await rowOf(id);
      return row.stage === 'ready' && row;
    });
  const setupRun = () =>
    eventually(() => held.find((run) => run.serverId === current));

  /**
   * A Bought Server made with backups on, Ready, holding the daily backups
   * of Nov 1, 2 and 3 at 03:00 UTC, and an Environment deploying to it.
   */
  async function readyServer() {
    const res = await request(http)
      .post('/bought-servers')
      .set('Cookie', owner.cookie)
      .send({
        serverType: 'cpx22',
        location: 'hel1',
        name: 'web-1',
        termsAccepted: true,
        prorationDate: Math.floor(Date.now() / 1000),
        backups: true,
      });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    current = id;
    (await setupRun()).finish();
    await readyRow(id);
    // Its Ready email too, so it does not land among the restore's.
    await eventually(() =>
      mail
        .to('grace@example.com')
        .some((one) => one.email.subject === 'Your Server web-1 is ready'),
    );
    held = [];
    const daily = [1, 2, 3].map((day) =>
      fake().addBackup(machine().id, {
        created: `2026-11-0${day}T03:00:00+00:00`,
        imageSizeGb: 2.1,
      }),
    );
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
    environmentId = (environment.body as { environmentId: string })
      .environmentId;
    return { id, chosen: daily[1] };
  }

  /** A Deployment of the Service that finished at `finishedAt`. */
  async function deployedAt(
    parent: { applicationId: string } | { composeId: string },
    finishedAt: string,
    status: 'done' | 'error' = 'done',
  ) {
    await ctx.db.insert(deployment).values({
      ...parent,
      title: 'Deploy',
      status,
      logPath: '/etc/cloudgate/logs/past.log',
      startedAt: finishedAt,
      finishedAt,
    });
  }

  /** An Application on the Server, with an image to deploy. */
  async function applicationOn(serverId: string, name: string) {
    const res = await request(http)
      .post('/applications')
      .set('Cookie', owner.cookie)
      .send({ name, appName: name, environmentId, serverId })
      .expect(201);
    const { applicationId } = res.body as { applicationId: string };
    await request(http)
      .patch(`/applications/${applicationId}`)
      .set('Cookie', owner.cookie)
      .send({ sourceType: 'docker', dockerImage: 'nginx:1.27' })
      .expect(200);
    return applicationId;
  }

  /** A Compose stack on the Server, its file written in the console. */
  async function composeOn(serverId: string, name: string) {
    const res = await request(http)
      .post('/compose')
      .set('Cookie', owner.cookie)
      .send({
        name,
        appName: name,
        environmentId,
        serverId,
        composeType: 'docker-compose',
        composeFile: 'services:\n  web:\n    image: nginx:1.27\n',
      })
      .expect(201);
    const { composeId } = res.body as { composeId: string };
    await request(http)
      .patch(`/compose/${composeId}`)
      .set('Cookie', owner.cookie)
      .send({ sourceType: 'raw' })
      .expect(200);
    return composeId;
  }

  /** A Postgres on the Server, deployed now through its Deploy. */
  async function postgresOn(serverId: string, name: string) {
    const res = await request(http)
      .post('/postgres')
      .set('Cookie', owner.cookie)
      .send({
        name,
        appName: name,
        environmentId,
        serverId,
        databaseName: 'orders',
        databaseUser: 'shop',
      })
      .expect(201);
    const { postgresId } = res.body as { postgresId: string };
    const deployed = await request(http)
      .post(`/postgres/${postgresId}/deploy`)
      .set('Cookie', owner.cookie);
    expect(deployed.status).toBe(200);
    expect(deployed.body).toMatchObject({ applicationStatus: 'done' });
    return postgresId;
  }

  /** A Bucket on the Server, its Garage deployed now. */
  async function bucketOn(serverId: string, name: string) {
    const [made] = await ctx.db
      .insert(bucket)
      .values({
        name,
        configName: name,
        appName: `bucket-${name}`,
        bucketName: name,
        adminCredential: { rpcSecret: 'rpc', adminToken: 'admin' },
        volumeName: `bucket-${name}-data`,
        environmentId,
        serverId,
      })
      .returning({ bucketId: bucket.bucketId });
    await ctx.app.get(BucketsService, { strict: false }).deploy(made.bucketId);
    const [row] = await ctx.db
      .select()
      .from(bucket)
      .where(eq(bucket.bucketId, made.bucketId));
    expect(row.applicationStatus).toBe('done');
    return made.bucketId;
  }

  /** The Applications and Compose stacks a Deployment was queued for since the restore. */
  const queuedFor = () =>
    queue.jobs.map((job) => {
      const data = job.data as { applicationId?: string; composeId?: string };
      return data.applicationId ?? data.composeId;
    });

  /**
   * Restores the backup of Nov 2, and ends the setup run after it, having
   * done `meanwhile` while it ran.
   */
  async function restored(
    id: string,
    backupId: number,
    meanwhile: () => Promise<unknown> = () => Promise.resolve(),
  ) {
    queue.jobs = [];
    docker.createService.mockClear();
    mail.clear();
    const res = await request(http)
      .post(`/bought-servers/${id}/backups/${backupId}/restore`)
      .set('Cookie', owner.cookie)
      .send({});
    expect(res.status).toBe(202);
    const copy = await eventually(async () => {
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
    fake().finishBackup(copy.id, 2.2);
    const run = await setupRun();
    await meanwhile();
    run.finish();
    held = [];
    await readyRow(id);
    await eventually(() => mail.sent.length > 0);
  }

  /** The Server Ready again, a finished Restore's redeploys still stored as a restart left them. */
  async function leftToStart(
    id: string,
    left: Partial<BoughtServerRestoreRedeploys>,
  ) {
    await ctx.db
      .update(boughtServer)
      .set({
        stage: 'ready',
        changeTarget: null,
        changeTries: 0,
        restoreRedeploys: {
          backupTakenAt: '2026-11-02T03:00:00.000Z',
          setupOk: true,
          toStart: [],
          starting: null,
          started: [],
          notStarted: [],
          ...left,
        },
      })
      .where(eq(boughtServer.id, id));
    queue.jobs = [];
    mail.clear();
  }

  /** The subjects and the text of every email to the owner. */
  const toldOwner = () =>
    mail.to('grace@example.com').map((one) => ({
      subject: one.email.subject,
      html: one.email.html.replace(/<!-- -->/g, ''),
    }));

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        { provide: STRIPE_API, useValue: stripe },
        { provide: RemoteExecService, useValue: exec },
        { provide: DEPLOYMENT_QUEUE, useValue: queue },
        {
          provide: RemoteDockerFactory,
          useValue: { getRemoteDocker: jest.fn().mockResolvedValue(docker) },
        },
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
    queue.jobs = [];
    mail.clear();
    invoiceCount = 0;
    priceCount = 0;
    exec.execAsync.mockReset().mockImplementation(() => Promise.resolve(ok()));
    exec.execAsyncRemote.mockReset().mockImplementation(shell);
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.createService.mockReset().mockResolvedValue(undefined);
    docker.createSecret.mockReset().mockResolvedValue({ id: 'secret-1' });
    docker.listTasks
      .mockReset()
      .mockResolvedValue([
        { Status: { State: 'running', Timestamp: '2026-10-17T00:00:00Z' } },
      ]);
    await openHostedSignUp(ctx.db);
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    await givenPlan(ctx, owner.organizationId, 'starter');
  });

  it('redeploys an Application whose current Deployment finished after the backup, and not one deployed before it', async () => {
    const { id, chosen } = await readyServer();
    const web = await applicationOn(id, 'web');
    const api = await applicationOn(id, 'api');
    await deployedAt({ applicationId: web }, BEFORE_THE_BACKUP);
    await deployedAt({ applicationId: web }, AFTER_THE_BACKUP);
    await deployedAt({ applicationId: api }, BEFORE_THE_BACKUP);
    // A later try that failed is not what runs.
    await deployedAt({ applicationId: api }, AFTER_THE_BACKUP, 'error');

    await restored(id, chosen.id);

    expect(queuedFor()).toEqual([web]);
    const rows = await ctx.db
      .select()
      .from(deployment)
      .where(eq(deployment.applicationId, web));
    expect(rows.filter((row) => row.status === 'pending')).toEqual([
      expect.objectContaining({
        title: 'Redeploy after restoring web-1',
        queuedAs: { applicationType: 'application', type: 'redeploy' },
      }),
    ]);
  });

  it('redeploys a Compose stack whose current Deployment finished after the backup, and not one deployed before it', async () => {
    const { id, chosen } = await readyServer();
    const shop = await composeOn(id, 'shop');
    const tools = await composeOn(id, 'tools');
    await deployedAt({ composeId: shop }, AFTER_THE_BACKUP);
    await deployedAt({ composeId: tools }, BEFORE_THE_BACKUP);

    await restored(id, chosen.id);

    expect(queuedFor()).toEqual([shop]);
  });

  it('redeploys a Database whose last deploy finished after the backup, and not one deployed before it', async () => {
    const { id, chosen } = await readyServer();
    const orders = await postgresOn(id, 'orders');
    const legacy = await postgresOn(id, 'legacy');
    await ctx.db
      .update(postgres)
      .set({ deployedAt: BEFORE_THE_BACKUP })
      .where(eq(postgres.postgresId, legacy));
    const deployedAtOf = async (postgresId: string) =>
      (
        await ctx.db
          .select({ at: postgres.deployedAt })
          .from(postgres)
          .where(eq(postgres.postgresId, postgresId))
      )[0].at;
    const before = await deployedAtOf(orders);

    await restored(id, chosen.id);

    await eventually(async () => (await deployedAtOf(orders)) !== before);
    expect(created()).toEqual(['orders']);
    expect(await deployedAtOf(legacy)).toBe(BEFORE_THE_BACKUP);
  });

  it('redeploys a Bucket whose last deploy finished after the backup, and not one deployed before it', async () => {
    const { id, chosen } = await readyServer();
    const files = await bucketOn(id, 'files');
    const archive = await bucketOn(id, 'archive');
    await ctx.db
      .update(bucket)
      .set({ deployedAt: BEFORE_THE_BACKUP })
      .where(eq(bucket.bucketId, archive));
    const deployedAtOf = async (bucketId: string) =>
      (
        await ctx.db
          .select({ at: bucket.deployedAt })
          .from(bucket)
          .where(eq(bucket.bucketId, bucketId))
      )[0].at;
    const before = await deployedAtOf(files);

    await restored(id, chosen.id);

    await eventually(async () => (await deployedAtOf(files)) !== before);
    expect(created()).toEqual(['bucket-files']);
    expect(await deployedAtOf(archive)).toBe(BEFORE_THE_BACKUP);
  });

  it('shows a redeploy that failed on its Service, as a failed deploy, and the restore still ends Ready', async () => {
    const { id, chosen } = await readyServer();
    const orders = await postgresOn(id, 'orders');
    docker.createService.mockRejectedValue(
      new Error('no space left on device'),
    );

    await restored(id, chosen.id);

    await eventually(async () => {
      const [row] = await ctx.db
        .select({ status: postgres.applicationStatus })
        .from(postgres)
        .where(eq(postgres.postgresId, orders));
      return row.status === 'error';
    });
    expect(await rowOf(id)).toMatchObject({
      stage: 'ready',
      changeTarget: null,
    });
    expect(
      mail.to('grace@example.com').map((one) => one.email.subject),
    ).toEqual(['Your Server web-1 was restored from a backup']);
  });

  it('names each Service it redeployed in the email', async () => {
    const { id, chosen } = await readyServer();
    const web = await applicationOn(id, 'web');
    const api = await applicationOn(id, 'api');
    await deployedAt({ applicationId: web }, AFTER_THE_BACKUP);
    await deployedAt({ applicationId: api }, BEFORE_THE_BACKUP);
    const shop = await composeOn(id, 'shop');
    await deployedAt({ composeId: shop }, AFTER_THE_BACKUP);
    await postgresOn(id, 'orders');

    await restored(id, chosen.id);

    const [sent] = mail.to('grace@example.com');
    const html = sent.email.html.replace(/<!-- -->/g, '');
    expect(html).toContain(
      'Cloudgate redeployed orders, shop and web, which were deployed after that backup, so they run their current version again. How each redeploy went shows on its Service.',
    );
    expect(html).not.toContain('api');
  });

  it('says so when no Service was deployed after the backup', async () => {
    const { id, chosen } = await readyServer();
    const api = await applicationOn(id, 'api');
    await deployedAt({ applicationId: api }, BEFORE_THE_BACKUP);

    await restored(id, chosen.id);

    expect(queuedFor()).toEqual([]);
    const [sent] = mail.to('grace@example.com');
    expect(sent.email.html.replace(/<!-- -->/g, '')).toContain(
      'No Service on it was deployed after that backup, so none was redeployed.',
    );
  });

  it('redeploys nothing again when a resume reaches the finished restore', async () => {
    const { id, chosen } = await readyServer();
    const web = await applicationOn(id, 'web');
    await deployedAt({ applicationId: web }, AFTER_THE_BACKUP);
    await restored(id, chosen.id);
    mail.clear();

    await ctx.app.get(BoughtServerStages).advance(id);

    expect(queuedFor()).toEqual([web]);
    expect(mail.sent).toEqual([]);
  });

  it('redeploys once when a restart read the setup run ended, however many times it resumes', async () => {
    const { id, chosen } = await readyServer();
    const web = await applicationOn(id, 'web');
    await deployedAt({ applicationId: web }, AFTER_THE_BACKUP);
    queue.jobs = [];
    await ctx.db
      .update(boughtServer)
      .set({
        stage: 'changing',
        changeTarget: {
          charged: false,
          lines: [],
          restore: {
            backupId: chosen.id,
            backupTakenAt: '2026-11-02T03:00:00.000Z',
            requestedBy: owner.id,
            safetyCopy: null,
            rebuilt: true,
            running: true,
            setupStarts: 1,
            setup: { ok: true, message: null },
          },
        },
        changeTries: 0,
      })
      .where(eq(boughtServer.id, id));
    const stages = ctx.app.get(BoughtServerStages);

    await Promise.all([stages.advance(id), stages.advance(id)]);
    await stages.advance(id);

    expect((await rowOf(id)).stage).toBe('ready');
    expect(queuedFor()).toEqual([web]);
  });

  describe('a restart between Ready and the redeploys', () => {
    it('starts each redeploy left to start once, however many callers reach it, then sends the one email naming them', async () => {
      const { id } = await readyServer();
      const web = await applicationOn(id, 'web');
      const shop = await composeOn(id, 'shop');
      await leftToStart(id, {
        toStart: [
          { kind: 'application', id: web, name: 'web' },
          { kind: 'compose', id: shop, name: 'shop' },
        ],
      });
      const stages = ctx.app.get(BoughtServerStages);

      await Promise.all([stages.advance(id), stages.advance(id)]);
      await stages.advance(id);

      expect(queuedFor()).toEqual([web, shop]);
      expect((await rowOf(id)).restoreRedeploys).toBeNull();
      const told = toldOwner();
      expect(told.map((one) => one.subject)).toEqual([
        'Your Server web-1 was restored from a backup',
      ]);
      expect(told[0].html).toContain('Cloudgate redeployed shop and web');
    });

    it('starts again one a restart cut off between its claim and its record, rather than lose it', async () => {
      const { id } = await readyServer();
      const web = await applicationOn(id, 'web');
      await leftToStart(id, {
        starting: { kind: 'application', id: web, name: 'web' },
      });

      await ctx.app.get(BoughtServerStages).advance(id);

      expect(queuedFor()).toEqual([web]);
      expect(toldOwner()).toHaveLength(1);
    });

    it('is carried on by the hourly resume, though the Server is Ready', async () => {
      const { id } = await readyServer();
      const web = await applicationOn(id, 'web');
      await leftToStart(id, {
        toStart: [{ kind: 'application', id: web, name: 'web' }],
      });

      await ctx.app.get(BoughtServersHourly).tick();

      expect(queuedFor()).toEqual([web]);
      expect((await rowOf(id)).restoreRedeploys).toBeNull();
      expect(toldOwner()).toHaveLength(1);
    });
  });

  describe('a redeploy refused before it starts', () => {
    it('shows on its Service as a failed deploy, and the email lists it apart, with why, never as redeployed', async () => {
      const { id, chosen } = await readyServer();
      const web = await applicationOn(id, 'web');
      await deployedAt({ applicationId: web }, AFTER_THE_BACKUP);
      const orders = await postgresOn(id, 'orders');
      docker.createService.mockClear();

      await restored(id, chosen.id, () =>
        ctx.db
          .update(server)
          .set({ maintenanceSince: new Date().toISOString() })
          .where(eq(server.serverId, id)),
      );

      expect(queuedFor()).toEqual([]);
      expect(created()).toEqual([]);
      const [failed] = await ctx.db
        .select()
        .from(deployment)
        .where(eq(deployment.applicationId, web))
        .orderBy(deployment.createdAt)
        .then((rows) => rows.filter((row) => row.status === 'error'));
      expect(failed).toMatchObject({
        title: 'Redeploy after restoring web-1',
        description: 'web-1 is in maintenance',
      });
      expect(failed.finishedAt).not.toBeNull();
      const [database] = await ctx.db
        .select({ status: postgres.applicationStatus })
        .from(postgres)
        .where(eq(postgres.postgresId, orders));
      expect(database.status).toBe('error');
      const [told] = toldOwner();
      expect(told.html).toContain(
        'Cloudgate could not redeploy orders and web, which were deployed after that backup: web-1 is in maintenance.',
      );
      expect(told.html).not.toContain('Cloudgate redeployed');
    });

    it('starts none for a frozen Organization, and the email says why', async () => {
      const { id, chosen } = await readyServer();
      const web = await applicationOn(id, 'web');
      await deployedAt({ applicationId: web }, AFTER_THE_BACKUP);
      await postgresOn(id, 'orders');
      docker.createService.mockClear();

      await restored(id, chosen.id, () =>
        ctx.db
          .update(subscription)
          .set({ suspendedAt: new Date(), suspendedReason: 'Sending spam' })
          .where(eq(subscription.organizationId, owner.organizationId)),
      );

      expect(queuedFor()).toEqual([]);
      expect(created()).toEqual([]);
      const [told] = toldOwner();
      expect(told.html).toContain(
        'Cloudgate could not redeploy orders and web, which were deployed after that backup: its Organization is frozen (Suspended. Contact Octabyte), so no deploy starts.',
      );
      expect(told.html).not.toContain('Cloudgate redeployed');
    });
  });
});
