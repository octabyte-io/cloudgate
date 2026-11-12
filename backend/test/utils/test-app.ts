import { INestApplication, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { applyTrustProxy } from '../../src/common/config/trust-proxy';
import { applyGatewayBodyParser } from '../../src/gateway/gateway-body';
import { DRIZZLE } from '../../src/db/drizzle.module';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { AWS_CLOUD_PORT } from '../../src/cloud-accounts/cloud.port';
import { STACK_VM_TUNNEL } from '../../src/remote/stack-vm-remote';
import { GOOGLE_CLOUD_PORT } from '../../src/cloud-accounts/google-cloud.port';
import { CONFIG_READER } from '../../src/project-config/reader/config-reader.port';
import { GARAGE_REACH } from '../../src/buckets/garage-reach';
import { OBJECT_STORAGE } from '../../src/object-storage/object-storage.port';
import { GOOGLE_LEFTOVER_RECHECK } from '../../src/applications/google-leftover-recheck';
import { CRON_RUN_SETTLE_TIMER } from '../../src/cron-services/cron-service.clock';
import {
  HETZNER_MACHINES,
  HETZNER_PRICES,
} from '../../src/bought-servers/hetzner/hetzner-cloud.port';
import { DayRates } from '../../src/bought-servers/exchange-rate/day-rates.service';
import { EXCHANGE_RATE } from '../../src/bought-servers/exchange-rate/exchange-rate.port';
import { STRIPE_API } from '../../src/cloud/billing/stripe-api';
import { FakeCloudPort } from './fake-cloud-port';
import { InstantSettleTimer } from './instant-settle-timer';
import { FakeConfigReader } from './fake-config-reader';
import { FakeExchangeRate } from './fake-exchange-rate';
import { FakeGoogleCloudPort } from './fake-google-cloud-port';
import { FakeHetznerCloud } from './fake-hetzner-cloud';
import { FakeObjectStorage } from './fake-object-storage';
import { fakeStripe } from './fake-stripe';
// Type-only: the modules behind it load better-auth, which reads NODE_ENV once
// at load (`isTest()` → `skipOriginCheck`). Imported at the top they would load
// it before a spec could set NODE_ENV — trusted-origins.e2e-spec.ts turns the
// origin check on that way — so they are required in createTestApp instead.
import type { FakeTurnstile } from './fake-turnstile';
import { startTestDb, TestDb } from './test-db';

export interface TestAppContext {
  app: INestApplication;
  db: DrizzleDB;
  /**
   * The config reader port's in-memory fake, registered for every
   * suite so no e2e reaches a provider's API for a Project config; `resetDb`
   * empties it. A suite that overrides `CONFIG_READER` itself gets a fresh
   * one here that the app never calls.
   */
  configReader: FakeConfigReader;
  /**
   * The cloud port's in-memory fake, registered for every suite so no
   * e2e reaches AWS; `resetDb` resets it to "AWS says yes". A suite that
   * overrides `AWS_CLOUD_PORT` itself gets a fresh one here that the app never
   * calls.
   */
  cloud: FakeCloudPort;
  /**
   * The Google client port's in-memory fake, registered for every
   * suite so no e2e reaches Google; `resetDb` resets it to "Google says yes".
   * A suite that overrides `GOOGLE_CLOUD_PORT` itself gets a fresh one here
   * that the app never calls.
   */
  google: FakeGoogleCloudPort;
  /**
   * The object-storage port's in-memory fake, with its fake reach to
   * a Garage, registered for every suite so no e2e reaches Garage or S3;
   * `resetDb` empties it.
   */
  objectStorage: FakeObjectStorage;
  /**
   * The Hetzner Cloud port's two in-memory fakes, registered for every
   * suite so no e2e reaches the provider that makes Bought Servers (ADR-0071):
   * `machines` is the EUR account every machine is made in, `prices` the
   * empty USD account the prices are read from. `resetDb` resets both to an
   * empty account with the seeded catalogue. A suite that overrides either
   * token itself gets a fresh one here that the app never calls.
   */
  hetzner: { machines: FakeHetznerCloud; prices: FakeHetznerCloud };
  /**
   * The day's exchange rate the Operator page's margins use, in memory for
   * every suite so no e2e reaches the ECB. `resetDb` puts back the seeded
   * rate and forgets the day's read.
   */
  exchangeRate: FakeExchangeRate;
  /**
   * Cloudflare's Turnstile siteverify, faked on localhost for every suite
   * a Hosted public sign-up passes with `PASSING_TURNSTILE` set and
   * is refused without it. `resetDb` clears what it was asked.
   */
  turnstile: FakeTurnstile;
  /**
   * Moves on the clock the one-confirmation-email-per-address limit reads
   * so a suite can step past its window without sleeping. `resetDb`
   * moves it a day on, so no test inherits another's last email.
   */
  advanceConfirmationClock(ms: number): void;
  resetDb(): Promise<void>;
  teardown(): Promise<void>;
}

export interface TestAppOptions {
  /** Extra controllers registered only in the test app (e.g. guard probes). */
  controllers?: Type[];
  /** Providers replaced with test doubles (e.g. a mocked RemoteExecService). */
  overrideProviders?: Array<{
    provide: Type | string | symbol;
    useValue: unknown;
  }>;
  /**
   * Runs after the app is created and before `init()`, where main.ts does its
   * own pre-listen wiring. Anything registering raw Express middleware or
   * routes has to happen here: `init()` mounts Nest's router, and a handler
   * added afterwards sits behind it and never matches (as `/docs` once did).
   */
  beforeInit?: (app: INestApplication) => void;
}

/**
 * An app wired the way `main.ts` wires one, on a throwaway Postgres.
 *
 * **What this function reproduces of `main.ts` is a security claim, not a
 * convenience** (H-28). Every e2e in the tree asserts against whatever this
 * builds, so a piece of bootstrap that is missing here does not make an e2e
 * fail — it makes the e2e *mean something else*, silently, for as long as
 * nobody compares the two files. `trust proxy` was missing for exactly that
 * long: `session-address.e2e-spec.ts` declared `loopback,10.0.0.0/8` and
 * asserted a proxied topology on an app that trusted nothing, and passed,
 * because the half it asserted on (better-auth's `trustedProxies`, wired in
 * `AuthModule` off the same key) was the half that was there.
 *
 * So the divergences are listed rather than left to a later diff:
 *
 * - **`rawBody`** — reproduced. The billing webhook verifies Stripe's signature
 *   over the exact request bytes.
 * - **`trust proxy`** — reproduced, through the same `applyTrustProxy` `main.ts`
 *   calls, so a change to one is a change to both.
 * - **The Gateway's body reader** — reproduced, through the same
 *   `applyGatewayBodyParser` `main.ts` calls.
 * - **The `ws` adapter** — reproduced. The realtime gateways bind on `init()`.
 * - **`enableCors(corsOptions(…))` — reachable, and reached, but still not on
 *   by default.** Pass `applyCors` (`src/common/config/cors.ts`) as
 *   `beforeInit`, which is the same function `main.ts` calls and carries the
 *   key, the default and the `enableCors` with it, so the two cannot drift the
 *   way `trust proxy` did. `test/common/cors-policy.e2e-spec.ts` is the suite
 *   that does, and it is why the row moved (H-42): until it landed,
 *   `CORS_ALLOWED_ORIGINS` had no integration coverage at all — `cors.spec.ts`
 *   asserts the options object over a probe controller and no request in the
 *   tree had ever met the policy, so the first assertion of a cross-origin
 *   refusal to be written would have passed against an app with no policy at
 *   all, which answers every origin and refuses none.
 *
 *   Still not wired here by default, for the reason it never was: turning CORS
 *   on for all 89 e2e files changes what a credentialed request with no
 *   `Origin` does, which is nearly all of them. Opt in per suite.
 * - **`mountOpenApiDocument`** — not reproduced by default, and deliberately:
 *   `test/openapi/docs-route.e2e-spec.ts` passes it as `beforeInit`, which is
 *   what that option is for, and the other 88 files have no `/docs` to serve.
 * - **`useLogger(nestjs-pino)` and the instance-restart notification** — not
 *   reproduced. Neither is on a request path; the notification fires after
 *   `listen`, which a test app never calls.
 * - **The Service-health ticks** (`ProbeScheduler`'s every
 *   `PROBE_TICK_MS`, `RequestMetricsCollector`'s every `COLLECTION_TICK_MS`) —
 *   armed by `onApplicationBootstrap` as in production, then unarmed here.
 *   Suites drive `tick()` directly on the Service-health clock and never wait
 *   in real time, so a real-time tick only adds nondeterminism —
 *   and it deadlocked `resetDb`: the tick's multi-table reads and row locks
 *   ran every 5 s in every e2e app, and `truncate … cascade` takes ACCESS
 *   EXCLUSIVE on every table in whatever order `pg_tables` answers, so the two
 *   met in opposite orders (SQLSTATE 40P01; 23 of 300 resets with both ticks
 *   hammering). The prune crons stay registered; they fire hourly.
 * - **The Cron service timetable's tick** (`CronTimetable`'s every
 *   `TIMETABLE_TICK_MS`) — unarmed with them, for the same two
 *   reasons: suites tick it directly on `CRON_SERVICE_CLOCK`, and its reads
 *   would meet `resetDb`'s truncate the same way.
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestAppContext> {
  const testDb: TestDb = await startTestDb();
  process.env.DATABASE_URL = testDb.connectionString;
  process.env.APP_ENCRYPTION_SECRET ??=
    'test-encryption-secret-at-least-32-chars';
  process.env.BETTER_AUTH_SECRET ??= 'test-auth-secret-at-least-32-chars-long';

  // AppModule is required lazily: ConfigModule.forRoot({ validate }) snapshots
  // the environment when app.module is first imported, and that snapshot wins
  // over later process.env changes. Importing it at the top of this file would
  // freeze backend/.env's DATABASE_URL before the container URL is set.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } = require('../../src/app.module') as {
    AppModule: new () => unknown;
  };

  const builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  });
  for (const override of options.overrideProviders ?? []) {
    builder.overrideProvider(override.provide).useValue(override.useValue);
  }
  // Seam 2: a repository-kept config is read through the port, and
  // every suite reads it from memory unless it brings its own double.
  const configReader = new FakeConfigReader();
  if (
    !(options.overrideProviders ?? []).some(
      (override) => override.provide === CONFIG_READER,
    )
  ) {
    builder.overrideProvider(CONFIG_READER).useValue(configReader);
  }
  // Seam 2: everything that reaches AWS goes through the cloud port,
  // and every suite answers it from memory unless it brings its own double.
  const cloud = new FakeCloudPort();
  if (
    !(options.overrideProviders ?? []).some(
      (override) => override.provide === AWS_CLOUD_PORT,
    )
  ) {
    builder.overrideProvider(AWS_CLOUD_PORT).useValue(cloud);
  }
  // And everything that reaches Google goes through its own port.
  const google = new FakeGoogleCloudPort();
  if (
    !(options.overrideProviders ?? []).some(
      (override) => override.provide === GOOGLE_CLOUD_PORT,
    )
  ) {
    builder.overrideProvider(GOOGLE_CLOUD_PORT).useValue(google);
  }
  // And everything that reaches the provider of Bought Servers goes through
  // its port, once per account.
  const hetzner = {
    machines: new FakeHetznerCloud('EUR'),
    prices: new FakeHetznerCloud('USD'),
  };
  for (const [token, fake] of [
    [HETZNER_MACHINES, hetzner.machines],
    [HETZNER_PRICES, hetzner.prices],
  ] as const) {
    if (
      !(options.overrideProviders ?? []).some(
        (override) => override.provide === token,
      )
    ) {
      builder.overrideProvider(token).useValue(fake);
    }
  }
  const exchangeRate = new FakeExchangeRate();
  if (
    !(options.overrideProviders ?? []).some(
      (override) => override.provide === EXCHANGE_RATE,
    )
  ) {
    builder.overrideProvider(EXCHANGE_RATE).useValue(exchangeRate);
  }
  // A Stack VM is reached through its cloud's tunnel (ADR-0070), which in a
  // suite never spawns the real Session Manager plugin: one that wants a
  // Stack VM hands a tunnel to a local stand-in SSH server.
  if (
    !(options.overrideProviders ?? []).some(
      (override) => override.provide === STACK_VM_TUNNEL,
    )
  ) {
    builder.overrideProvider(STACK_VM_TUNNEL).useValue({
      open: () => Promise.reject(new Error('No Stack VM tunnel in this suite')),
    });
  }
  // Seam 4: a bucket's files are read and emptied through the
  // object-storage port at a Garage the reach opens; every suite answers
  // both from memory, and the real adapter runs in the release lane only.
  const objectStorage = new FakeObjectStorage();
  builder.overrideProvider(OBJECT_STORAGE).useValue(objectStorage);
  builder.overrideProvider(GARAGE_REACH).useValue(objectStorage.reach);
  // A Cron run on Google Cloud or AWS reads its log on for 12 s or more
  // once it ends; every suite moves that time on without sleeping
  // unless it brings its own timer to look at.
  if (
    !(options.overrideProviders ?? []).some(
      (override) => override.provide === CRON_RUN_SETTLE_TIMER,
    )
  ) {
    builder
      .overrideProvider(CRON_RUN_SETTLE_TIMER)
      .useValue(new InstantSettleTimer());
  }
  // A Google Service Delete's leftover search looks again 10 s after it
  // finds anything; every suite takes that look at once unless it
  // brings its own timer.
  if (
    !(options.overrideProviders ?? []).some(
      (override) => override.provide === GOOGLE_LEFTOVER_RECHECK,
    )
  ) {
    builder
      .overrideProvider(GOOGLE_LEFTOVER_RECHECK)
      .useValue({ wait: () => Promise.resolve() });
  }
  // Stripe, for every suite that brings no double of its own: the Hosted
  // instance reads its webhook endpoints on start (#1414), and no e2e
  // reaches Stripe.
  if (
    !(options.overrideProviders ?? []).some(
      (override) => override.provide === STRIPE_API,
    )
  ) {
    builder.overrideProvider(STRIPE_API).useValue(fakeStripe());
  }
  // Cloudflare's Turnstile verification, and the clock of the
  // per-address confirmation-email limit beside it. Required here, not at the
  // top, for the reason AppModule is (better-auth reads NODE_ENV at load).
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { FakeTurnstile: FakeTurnstileServer } =
    require('./fake-turnstile') as typeof import('./fake-turnstile');
  const { CONFIRMATION_EMAIL_CLOCK } =
    require('../../src/auth/confirmation-email-limit') as typeof import('../../src/auth/confirmation-email-limit');
  const { TURNSTILE_SITEVERIFY_URL } =
    require('../../src/auth/turnstile') as typeof import('../../src/auth/turnstile');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const turnstile = await FakeTurnstileServer.start();
  builder.overrideProvider(TURNSTILE_SITEVERIFY_URL).useValue(turnstile.url);
  let confirmationClockOffset = 0;
  if (
    !(options.overrideProviders ?? []).some(
      (override) => override.provide === CONFIRMATION_EMAIL_CLOCK,
    )
  ) {
    builder
      .overrideProvider(CONFIRMATION_EMAIL_CLOCK)
      .useValue(() => Date.now() + confirmationClockOffset);
  }
  const moduleRef = await builder.compile();

  // rawBody matches main.ts: the billing webhook verifies Stripe's signature
  // over the exact request bytes.
  //
  // Typed as the Express application for the reason main.ts gives: `trust
  // proxy` is an Express setting and `INestApplication` has no `set`.
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  // The realtime gateways bind on init; without the ws adapter Nest would
  // try to load the (uninstalled) socket.io platform.
  app.useWebSocketAdapter(new WsAdapter(app));
  // The same call main.ts makes, out of the same function, off the same key
  // (H-28). Until this landed, `TRUST_PROXY` reached better-auth through
  // `AuthModule` on every e2e and reached Express on none of them — so an e2e
  // that set the key configured one half of a two-half decision, and
  // `session-address.e2e-spec.ts` asserted a proxied topology on an app that
  // trusted nothing. Since H-07 the gap is in product code too:
  // `AuthController`'s `declaredProxy` asks Express for the compiled matcher
  // and stays silent when there is none, so every e2e took a branch no
  // deployment takes.
  //
  // Before `init()` for the reason `TestAppOptions.beforeInit` gives and one
  // more:
  // `req.ip` is read on the first request, and a setting applied afterwards
  // would make the app's behaviour depend on when a test made its first call.
  applyTrustProxy(app, app.get(ConfigService).get<string>('TRUST_PROXY'));
  // The same call main.ts makes: the Gateway's body reader, ahead of
  // Nest's own parser.
  applyGatewayBodyParser(app);
  options.beforeInit?.(app);
  await app.init();
  // Lazily, for the reason AppModule is.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { PROBE_TICK_JOB } =
    require('../../src/service-health/probe-scheduler.service') as {
      PROBE_TICK_JOB: string;
    };
  const { COLLECTION_TICK_JOB } =
    require('../../src/service-health/request-metrics-collector.service') as {
      COLLECTION_TICK_JOB: string;
    };
  const { TIMETABLE_TICK_JOB } =
    require('../../src/cron-services/cron-timetable.service') as {
      TIMETABLE_TICK_JOB: string;
    };
  /* eslint-enable @typescript-eslint/no-require-imports */
  const registry = app.get(SchedulerRegistry);
  for (const job of [PROBE_TICK_JOB, COLLECTION_TICK_JOB, TIMETABLE_TICK_JOB]) {
    registry.deleteInterval(job);
  }
  // The ACM poller of cloud Domains, every minute: suites drive
  // `CloudDomainRuns.poll(now)` themselves, for the same reason.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { CLOUD_CERTIFICATE_POLL_JOB } =
    require('../../src/project-config/applier/cloud-domain-runs.service') as {
      CLOUD_CERTIFICATE_POLL_JOB: string;
    };
  const { SchedulingService } =
    require('../../src/scheduling/scheduling.service') as typeof import('../../src/scheduling/scheduling.service');
  /* eslint-enable @typescript-eslint/no-require-imports */
  app.get(SchedulingService).unregister(CLOUD_CERTIFICATE_POLL_JOB);

  const db = app.get<DrizzleDB>(DRIZZLE);

  return {
    app,
    db,
    configReader,
    cloud,
    google,
    objectStorage,
    hetzner,
    exchangeRate,
    turnstile,
    advanceConfirmationClock: (ms) => {
      confirmationClockOffset += ms;
    },
    resetDb: () => {
      turnstile.clear();
      confirmationClockOffset += 24 * 60 * 60_000;
      configReader.reset();
      cloud.reset();
      google.reset();
      objectStorage.reset();
      hetzner.machines.reset();
      hetzner.prices.reset();
      exchangeRate.reset();
      app.get(DayRates).forget();
      return resetDb(db);
    },
    /**
     * `app.close()` **before** `db.$client.end()`, so Nest's destroy and
     * shutdown hooks run against a pool that is still open.
     *
     * The order used to be the other way round, and a ticket was filed on the
     * theory that it was leaking: hooks that fail leave whatever they were
     * meant to release, and `@nestjs/schedule`'s `SchedulerOrchestrator`
     * clears every registered cron, interval and timeout from
     * `beforeApplicationShutdown` — `monitoring.service.ts` and
     * `scheduling.service.ts` both register there — so a `close()` that threw
     * would strand process-wide timers in a worker that runs a dozen more
     * files.
     *
     * **Measured, and it is not where the memory goes.** Twenty-four e2e files
     * through one worker retain 64.7 MB per file with the old order and
     * 63.6 MB with this one — the same number. The ordering is kept because it
     * is the correct one, not because it bought anything: a hook that wants the
     * database during shutdown can now have it, which the old order made
     * impossible to write.
     *
     * **What does retain is the DI container, and it is not this function.**
     * Twelve generated files through one worker with no idle limit, each doing
     * only one thing:
     *
     * | per file | heap retained |
     * |---|---|
     * | nothing | 2.8 MB |
     * | `startTestDb()` + `stop()`, no Nest | 4.2 MB |
     * | `require('../../src/app.module')`, never wired | 9.6 MB |
     * | `Test.createTestingModule({imports:[AppModule]}).compile()` + `close()` | **61.6 MB** |
     * | all of the above plus `createNestApplication`, `init()` and this `teardown()` | 65.2 MB |
     *
     * So instantiating every provider in `AppModule` through Nest's injector
     * retains ~62 MB that `close()` does not give back, while *requiring* the
     * very same module graph into a fresh jest registry retains 9.6 MB — which
     * rules out jest's per-file module registry, the pool, the HTTP server and
     * this teardown alike. Everything this function adds on top of `compile()`
     * is the last 3.6 MB of the 65. `docs/testing.md`
     * ("Where the retention actually lives") carries the arithmetic and the
     * reason `workerIdleMemoryLimit` is the setting that pays for it.
     */
    teardown: async () => {
      await app.close();
      await turnstile.close();
      google.dispose();
      await db.$client.end();
      await testDb.stop();
    },
  };
}

async function resetDb(db: DrizzleDB): Promise<void> {
  const result = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const tables = result.rows.map((row) => `"public"."${row.tablename}"`);
  if (tables.length === 0) return;
  // Retried on a deadlock (40P01): the truncate locks every table in
  // `pg_tables` order, so any background statement still running — a
  // monitoring interval a suite set up — that holds one table while waiting on
  // another can deadlock it. The Service-health ticks are unarmed above.
  for (let attempt = 1; ; attempt++) {
    try {
      await db.execute(
        sql.raw(`truncate table ${tables.join(', ')} restart identity cascade`),
      );
      return;
    } catch (error) {
      if (attempt >= 3 || !isDeadlock(error)) throw error;
    }
  }
}

/** SQLSTATE 40P01, on the pg error or on the Drizzle error wrapping it. */
function isDeadlock(error: unknown): boolean {
  const codeOf = (e: unknown) => (e as { code?: unknown } | null)?.code;
  return (
    codeOf(error) === '40P01' ||
    codeOf((error as { cause?: unknown } | null)?.cause) === '40P01'
  );
}
