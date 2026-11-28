// The Hosted instance with both provider tokens. Set before the app module
// is imported: ConfigModule snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();
process.env.HETZNER_EUR_API_TOKEN = 'eur-token-for-the-fake';
process.env.HETZNER_USD_API_TOKEN = 'usd-token-for-the-fake';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  boughtServer,
  boughtServerLine,
} from '../../src/bought-servers/bought-server.schema';
import type {
  BoughtServerLineKind,
  BoughtServerStage,
} from '../../src/bought-servers/bought-server.schema';
import { MailService } from '../../src/mail/mail.service';
import { server } from '../../src/servers/server.schema';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import type { HostedCustomer } from '../utils/hosted-sign-up';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

/** The cpx22 by what it is: the in-memory provider's, as the Server tab names it. */
const CPX22 = { family: 'amd', vcpus: 3, memoryGb: 4, diskGb: 80 };
const HELSINKI = { city: 'Helsinki', country: 'FI' };

/**
 * `GET /bought-servers`, the **Bought Servers** page's list (#199, spec
 * #196): every Bought Server of the caller's Organization except Deleted and
 * Failed, oldest first, each with its Server id, name, stage, size, Location,
 * backups on or off and monthly price. It asks the provider about no machine,
 * so it holds no last backup time; the size and Location are named from the
 * price list, as the Server tab's are, and left out when that can't be read.
 * A read (`server: ['read']`).
 *
 * The rows are written straight into the database: how a Server reaches each
 * stage is other specs' business.
 */
describe('Bought Servers list (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  const mail = new MailRecorder();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: MailService, useValue: mail }],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    mail.clear();
    ctx.hetzner.prices.calls.length = 0;
    ctx.hetzner.machines.calls.length = 0;
    await openHostedSignUp(ctx.db);
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
  });

  let serverCount = 0;

  /**
   * Arrangement only: a Bought Server in `stage`, its `server` row too when
   * it has one, charged on these lines.
   */
  async function given(input: {
    name: string;
    stage: BoughtServerStage;
    organizationId?: string;
    withServer?: boolean;
    backups?: boolean;
    lines?: Partial<Record<BoughtServerLineKind, number>>;
    createdAt?: string;
  }): Promise<string> {
    const organizationId = input.organizationId ?? owner.organizationId;
    const [row] = await ctx.db
      .insert(boughtServer)
      .values({
        organizationId,
        name: input.name,
        stage: input.stage,
        serverType: 'cpx22',
        location: 'hel1',
        backups: input.backups ?? false,
        termsAcceptedBy: owner.id,
        termsAcceptedAt: new Date('2026-11-01T09:00:00Z'),
        createdAt: new Date(input.createdAt ?? '2026-11-01T09:00:00Z'),
      })
      .returning({ id: boughtServer.id });
    if (input.withServer) {
      await ctx.db.insert(server).values({
        serverId: row.id,
        name: input.name,
        ipAddress: `198.51.100.${++serverCount}`,
        port: 22,
        organizationId,
      });
      await ctx.db
        .update(boughtServer)
        .set({ serverId: row.id })
        .where(eq(boughtServer.id, row.id));
    }
    const lines = Object.entries(input.lines ?? { server: 2500 }) as Array<
      [BoughtServerLineKind, number]
    >;
    for (const [kind, monthlyCents] of lines) {
      await ctx.db.insert(boughtServerLine).values({
        boughtServerId: row.id,
        kind,
        stripePriceId: `price_${kind}_${row.id}`,
        monthlyCents,
      });
    }
    return row.id;
  }

  function list(cookie = owner.cookie) {
    return request(http).get('/bought-servers').set('Cookie', cookie);
  }

  // First in the file on purpose: a good read of the price list is kept for
  // a few minutes, so the refusal has to come before any read succeeds.
  it('still lists them while the price list cannot be read, with no size or Location', async () => {
    const id = await given({ name: 'web-1', stage: 'ready', withServer: true });
    ctx.hetzner.prices.refuse('listServerTypes', 'unavailable');

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id,
        serverId: id,
        name: 'web-1',
        stage: 'ready',
        size: null,
        location: null,
        backups: false,
        monthlyCents: 2500,
      },
    ]);
  });

  it('lists Ready, Changing, Setting up, Creating, Waiting for payment and Deleting, oldest first, and neither Deleted nor Failed', async () => {
    const ready = await given({
      name: 'web-1',
      stage: 'ready',
      withServer: true,
      backups: true,
      lines: { server: 2500, backups: 500, storage: 400 },
      createdAt: '2026-11-01T09:00:00Z',
    });
    const changing = await given({
      name: 'web-2',
      stage: 'changing',
      withServer: true,
      createdAt: '2026-11-02T09:00:00Z',
    });
    const settingUp = await given({
      name: 'web-3',
      stage: 'setting_up',
      withServer: true,
      createdAt: '2026-11-03T09:00:00Z',
    });
    const creating = await given({
      name: 'web-4',
      stage: 'creating',
      createdAt: '2026-11-04T09:00:00Z',
    });
    const waiting = await given({
      name: 'web-5',
      stage: 'waiting_for_payment',
      createdAt: '2026-11-05T09:00:00Z',
    });
    const deleting = await given({
      name: 'web-6',
      stage: 'deleting',
      createdAt: '2026-11-06T09:00:00Z',
    });
    await given({
      name: 'gone',
      stage: 'deleted',
      createdAt: '2026-10-01T09:00:00Z',
    });
    await given({
      name: 'never-made',
      stage: 'failed',
      createdAt: '2026-10-02T09:00:00Z',
    });

    const res = await list();

    expect(res.status).toBe(200);
    const about = { size: CPX22, location: HELSINKI };
    expect(res.body).toEqual([
      {
        id: ready,
        serverId: ready,
        name: 'web-1',
        stage: 'ready',
        ...about,
        backups: true,
        monthlyCents: 3400,
      },
      {
        id: changing,
        serverId: changing,
        name: 'web-2',
        stage: 'changing',
        ...about,
        backups: false,
        monthlyCents: 2500,
      },
      {
        id: settingUp,
        serverId: settingUp,
        name: 'web-3',
        stage: 'setting_up',
        ...about,
        backups: false,
        monthlyCents: 2500,
      },
      {
        id: creating,
        serverId: null,
        name: 'web-4',
        stage: 'creating',
        ...about,
        backups: false,
        monthlyCents: 2500,
      },
      {
        id: waiting,
        serverId: null,
        name: 'web-5',
        stage: 'waiting_for_payment',
        ...about,
        backups: false,
        monthlyCents: 2500,
      },
      {
        id: deleting,
        serverId: null,
        name: 'web-6',
        stage: 'deleting',
        ...about,
        backups: false,
        monthlyCents: 2500,
      },
    ]);
  });

  it('asks the provider about no machine, and names neither the provider nor its codes', async () => {
    await given({ name: 'web-1', stage: 'ready', withServer: true });

    const res = await list();

    expect(res.status).toBe(200);
    expect(ctx.hetzner.machines.calls).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/hetzner|hel1|cpx22/i);
  });

  it("lists none of another Organization's Bought Servers", async () => {
    const own = await given({
      name: 'web-1',
      stage: 'ready',
      withServer: true,
    });
    const other = await signUpHostedCustomer(http, mail, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'super-secret-password',
      organizationName: 'Lovelace Labs',
    });
    const theirs = await given({
      name: 'engine-1',
      stage: 'ready',
      withServer: true,
      organizationId: other.organizationId,
    });

    const mine = await list();
    const lovelace = await list(other.cookie);

    expect((mine.body as Array<{ id: string }>).map((row) => row.id)).toEqual([
      own,
    ]);
    expect(
      (lovelace.body as Array<{ id: string }>).map((row) => row.id),
    ).toEqual([theirs]);
  });

  it('answers an empty list while nothing is bought', async () => {
    const res = await list();

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('lists them to an admin, who may read Servers', async () => {
    await given({ name: 'web-1', stage: 'ready', withServer: true });
    const admin = await signUpMember(http, owner.cookie, {
      email: 'ida@example.com',
      role: 'admin',
    });

    const res = await list(admin.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('is refused to a member, who reads no Server', async () => {
    await given({ name: 'web-1', stage: 'ready', withServer: true });
    const member = await signUpMember(http, owner.cookie, {
      email: 'edsger@example.com',
    });

    const res = await list(member.cookie);

    expect(res.status).toBe(403);
  });
});
