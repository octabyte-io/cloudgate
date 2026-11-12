# Cloudgate backend

The whole server side in **one** NestJS process: the REST API, the deployment queue, the cron scheduler, the metrics collector and six WebSocket gateways, folded in as modules rather than run as separate services. That is [ADR 0003](../docs/adr/0003-single-nest-app.md) — one process is a deliberate simplification that stays reversible, because a module can be split out behind its own bootstrap without moving any boundary.

Requirements, environment and the commands table live in the [root README](../README.md). This file is about working *inside* this workspace.

## Layout

```
src/
  main.ts              bootstrap: CORS, the OpenAPI mount, the ws adapter, the boot notification
  app.module.ts        every feature module, and the global ZodValidationPipe
  common/              the global exception filter, encryption, logging, pagination, config
  db/                  drizzle.module.ts (the DRIZZLE token), columns.ts, schema.ts
  projects/            the layout every feature copies: schema, dto/, controller, module,
                       service — and it says so in projects.module.ts's own docblock
  remote/              RemoteExecService — the only way to run a command on a Server
  docker/              the Docker client, and the factory for a remote daemon
  realtime/gateways/   the six sockets: deployment logs, container logs, both terminals,
                       docker stats, server setup
  …                    one directory per feature — 46 directories in src/ all told
drizzle/               65 committed migrations (through 0064), plus meta/_journal.json
test/                  *.spec.ts and *.e2e-spec.ts side by side, mirroring src/
openapi.json           generated from the DTOs, checked in, asserted current by CI
```

## Conventions

These are why adding a feature here is boring, which is the point. The code holds to them.

1. **One `*.schema.ts` per feature** — the Drizzle table, its relations and its `$inferSelect` row type — re-exported from `src/db/schema.ts`. That file is nothing but re-exports, so drizzle-kit sees every table without anyone maintaining a list. Request shapes are not in here: they are hand-written Zod objects in the feature's `dto/` directory (convention 2). `drizzle-zod` is deliberately not a dependency, so there is no `createInsertSchema` anywhere in the tree.
2. **DTOs are Zod, through `nestjs-zod`'s `createZodDto`**, validated by one `ZodValidationPipe` registered globally as `APP_PIPE` in `app.module.ts`. A controller never validates by hand.
3. **Services reach the database through `@Inject(DRIZZLE)`** — the symbol from `db/drizzle.module.ts`. There is no repository layer and no second driver: `pg` with a `Pool`, per [ADR 0004](../docs/adr/0004-pg-driver.md).
4. **Errors are Nest `HttpException`s**, and one `AllExceptionsFilter` registered as `APP_FILTER` in `common/common.module.ts` renders all of them into a single JSON shape. Per [ADR 0005](../docs/adr/0005-domain-exceptions.md): no per-module error formats, no catch-and-respond in a controller.
5. **Secrets use the `encryptedText` column type** from `db/columns.ts` — never `EncryptionService` by hand in schema code. AES-256-GCM under `APP_ENCRYPTION_SECRET`, wire format `enc:v1:…`, per [ADR 0006](../docs/adr/0006-encryption-at-rest.md).
6. **Anything that touches a Server goes through `RemoteExecService.execAsyncRemote`**, and anything that touches a daemon goes through `docker/`'s remote client factory. A feature module never opens its own SSH connection.

`common/service-parent.ts` and `common/pagination/` exist to be reused before you write the same thing again.

## Tests

Two Jest configurations, because the two kinds of test have different costs:

| | Config | Matches | Needs Docker |
|---|---|---|---|
| Unit | the `jest` block in `package.json` | `test/**/*.spec.ts` | no |
| Integration | `test/jest-e2e.json` | `test/**/*.e2e-spec.ts` | yes |

Three, counting `test/jest-db.json` — the handful of `*.spec.ts` files that do
touch the shared Postgres, which is why the unit config stays lock-free
(`docs/testing.md`). Where this section says *both configs* below,
the setting is spelled once in `test/jest-preset.js`, which both of the Docker
ones now consist of plus a `rootDir` and a `testRegex`.

**The unit config is not on that preset, and the duplication it therefore keeps
is not solved.** It must not inherit `globalSetup`, so it cannot inherit
anything — jest has no way to take part of a preset — and the price is that
`moduleFileExtensions`, `testEnvironment`, `testTimeout`, `transform` and
`transformIgnorePatterns` are still spelled a second time in `package.json`,
byte for byte as the preset spells them, with a `resolver` naming the same
`test/octokit-resolver.js` by a different path. So the exact failure the preset
was written to prevent — *a transform, a `transformIgnorePatterns` entry or a
`moduleFileExtensions` addition made in one place and missed in the other* —
still stands between the preset and the unit config; it is only the two Docker
configs that can no longer drift from each other. A dependency added to the
`transformIgnorePatterns` allow-list has to be added twice, and the second
place is `package.json`. What is *not* duplication is the pair the preset
carries and the unit config deliberately omits (`logHeapUsage`,
`workerIdleMemoryLimit`) or the ones they set to different values on purpose:
`maxWorkers` is sized to the machine on the integration side (up to 4, for the reasons below), and `"50%"`
on the lock-free unit side, which runs no Postgres and no Nest app — and, since
it became lock-free, `globalSetup`/`globalTeardown`/`reporters`, which the unit config carries
in its own spelling rather than omitting. It arms the same stall watchdog
through the same `test/utils/heartbeat-reporter.js`, because a hung `npx jest`
was otherwise unbounded and silent; what it must not inherit is this preset's
hooks, whose job *is* the shared Postgres and the machine-wide lock. So it names
`test/utils/unit-global-setup.ts`, which arms the watchdog and sets the platform
root every lane runs under (`test/utils/platform-root.ts`), and
passes the reporter `{ lane: 'unit' }` so a unit run and an e2e run cannot write
one another's heartbeat. `test/utils/unit-lane-watchdog.spec.ts`
holds all three of those facts.

The integration suites go through a **real** Postgres, not a mock of the Drizzle layer — [ADR 0002](../docs/adr/0002-testcontainers.md), because migration SQL, constraints and Postgres-specific behaviour are part of what is being verified. `test/utils/` holds the harness: `global-setup.ts` starts **one** `postgres:17-alpine` for the whole run and replays the committed migrations into a template database, `test-db.ts` gives each suite its own database off that template with `create database … template …`, `test-app.ts` builds the Nest app, and tables are truncated between tests so suites are order-independent. `testTimeout` is 60s to cover the server boot.

A suite gets a database, not a server. That is what keeps the run inside a laptop's memory: it used to be a container *per suite*, so 100 e2e files meant 100 containers and 100 replays of `drizzle/`, `maxWorkers` of them alive at once, competing with `maxWorkers` copies of the Nest app for the same RAM. Both configs therefore also cap `maxWorkers` — the worker side, not the container side, is now the run's memory floor.

That floor is **not** the number this file used to give. "Roughly half a gigabyte per worker" is a worker's *first* file: **~368 MB of heap**, and it is the same number whether that file holds 161 tests or 3. A worker's heap then climbs about **76 MB per file** and does not come back down, so with the recycle disabled one worker peaked at **4.4 GB of RSS** and the two workers plus the jest main peaked at **5.4 GB** — against V8's 4288 MB default heap ceiling, which one worker reached and crashed on at suite 109 of 114. Both configs therefore set `workerIdleMemoryLimit: "1.5GB"`, which recycles a worker between files instead of letting it run into that ceiling, and `logHeapUsage: true`, so every suite line in the log carries the very number the threshold is compared against. That setting removed the crash and, unexpectedly, took the run from 510 s to 292 s — a worker near V8's ceiling spends its time in GC, and eight cheap forks cost less. As configured, a full run is **115 suites, 2184 tests, 298 s**, with a worker peaking at 2.2 GB of RSS and every jest process together at 3.7 GB; budget ~5 GB, because the pair only peaks when both workers happen to be near the threshold at once and the same settings gave 4.8 GB a day earlier. `docs/testing.md` has the full arithmetic (re-measured 2026-09-07).

**What retains it is Nest's DI container, and not this harness.** Twelve generated files through one worker, each doing one thing: requiring the whole `AppModule` graph into a fresh jest module registry retains **9.6 MB per file**, so jest reclaims the registry; `Test.createTestingModule({ imports: [AppModule] }).compile()` followed by `close()` retains **61.6 MB**; and the full `createTestApp()` + `teardown()` that every e2e file calls retains **65.2 MB**, i.e. 3.6 MB more than the injector alone. The real suites agree — regressing per-file retention on a file's test count over 35 within-worker steps gives `63.7 MB + 0.74 x tests` with an **r² of 0.013**, so the cost is flat per file and there are no worst-offender suites to bisect for. `teardown()`'s ordering was corrected in the same pass (`app.close()` before `db.$client.end()`, so a shutdown hook can still reach the database) and moved the retention from 64.7 to 63.6 MB per file, which is to say not at all.

The integration cap is **sized to the machine, up to 4** (`test/utils/worker-budget.js`). It was 2, the number `ci.yml` once recorded these suites as requiring, and this paragraph used to say that one shared server made 4 affordable but nothing yet argued for raising it. The suite tripling did: a full run of 380 suites took about 70 minutes at 2 workers and 24 at 4 on a 4-core, 16 GB machine (2026-11-12), peaking at 8.6 GB for the whole machine, with no OOM and no `instanceof` starvation. A worker is mostly waiting on Postgres, so the cores, not the CPU each worker uses, are the limit. The budget allows 2.5 GB per worker after 2 GB for Postgres and jest, so a smaller machine gets fewer.

What the cap does **not** buy is a green run. A full run reds one arbitrary suite roughly two times in three: a different suite each time, every one of them passing in isolation, usually a suite-level lifecycle-hook error with no individual test failure. That predates this harness — three runs of the container-per-suite code at the same cap reded 2 of 3 (`realtime`, `certificates`) against 3 of 5 here — so it is neither the shared server nor the worker count, and a single red suite is not evidence against whatever change is in the tree. The failures cluster where `afterAll` does work before restoring process-wide state: `session-address.e2e-spec.ts`, `session-address-untrusted.e2e-spec.ts` and `trusted-origins.e2e-spec.ts` all set `process.env.NODE_ENV` at module load and restore it *after* `await ctx.teardown()`, and `process.env` outlives a test file inside a worker — so a teardown that throws strands the mutation on every suite that worker runs next. That is where a real fix starts.

Two of the three full runs on 2026-09-07 drew that bad card, and both times it came up as a **wedge** rather than a red suite: one suite stopped answering and its remaining tests timed out one by one, at 120 s each. Both had to be killed by hand, because the stall watchdog of that day read a timed-out test as a sign of life; it now fails such a run at five minutes with the suite named. So the two-in-three rate holds; the shape it takes is not fixed, and neither the red suite nor the wedge is evidence against whatever is in your tree — both passed in isolation.

That trail explains the **red suite**. It does not explain the run that hangs, and an earlier investigation assumed that it did. An `afterAll` is bounded: jest-circus times a hook with `hook.timeout || getState().testTimeout`, so one that never returns fails at 60s with `Exceeded timeout of 60000 ms for a hook` — loudly, and as a test result. Nor is worker shutdown the answer: `jest-worker`'s pool `end()` schedules a `forceExit` 500 ms after asking a worker to stop. What is genuinely unbounded is a worker that stops being scheduled at all, because `testTimeout` is a timer *inside* that worker; freeze one with `SIGSTOP` and jest waits forever with no output. `test/utils/stall-watchdog.ts` is what fails such a run, and it took **two** predicates to cover the shape that actually shows up. "Nothing has been reported for five minutes" misses a wedge entirely: the reporter touches the heartbeat on every test case result including a timed-out one, and every e2e file's per-test timeout is under the budget — 107 of the 115 set `jest.setTimeout(120_000)`, three set 180 s, five inherit 60 s — so a wedged suite reports liveness forever. The second predicate is per suite: one file in flight for five minutes fails the run with that file named, at ~3.8x the slowest suite three full runs have (`docker-ops.e2e-spec.ts`, **78.1 s**, the only one of 239 suite completions past 60 s). Both exit **124**. `test/utils/heartbeat-reporter.js` is what names the file, and its `forS` is as of the file's own `at` rather than now — the watchdog adds the difference, and so should you when you read it by hand.

A worker budget per machine. `globalSetup` bounds a *run* — one server, however many suites — and
nothing in jest bounds a *machine*, so a fan-out of agents each invoking `jest` is back to a server and
a full set of workers apiece. The suite therefore holds slots before it starts anything: the machine has
one per worker it has room for, and a run takes one per worker it can use, so a full run takes every
slot while an agent's run of one file takes one. Several agents' small runs go at once; a full run waits
for them and they for it. Slot 0 is `$TMPDIR/cloudgate-e2e-postgres.lock`, the others carry `.1` to `.3`,
and `test-postgres.ts` says how one waiter at a time claims them so a big run is not starved. A run killed
between setup and teardown leaves stale files, and the next run takes them once it sees the pid is dead.
`CLOUDGATE_E2E_NO_LOCK=1` opts out, and should not be used to make a fan-out faster.

Set `TEST_POSTGRES_URL` to run against a server that is already up (`postgresql://postgres:postgres@localhost:5432/postgres` for a local dev container) instead of starting one. Each suite still creates and drops its own database on it, so nothing already on that server is touched — but the tests then run against whatever major version it is.

Three things about running them:

- **Never give the integration run jest's default worker count.** At that count it does not just slow down, it fails — starved suites die with `Right-hand side of 'instanceof' is not an object` and pass again in isolation. The preset sizes it (up to 4); to choose, set `CLOUDGATE_E2E_WORKERS`, or pass the flag to jest directly, since `pnpm run … --` puts it behind a literal `--` where jest reads it as a path pattern:
  ```bash
  pnpm exec jest --config ./test/jest-e2e.json --maxWorkers=2
  ```
- **A suite that timed out in a full run is worth re-running alone** before believing it. Contention, not the assertion, is usually what broke.
- **better-auth answers `127.0.0.1` for the client address under `NODE_ENV=test`**, which makes any test that asserts an address pass against a completely broken implementation. `@better-auth/core`'s `dist/utils/ip.mjs:215` ends `if (isTest() || isDevelopment()) return LOCALHOST_IP`, so `getIp` never returns null in either config and a session written by an app that resolves no address at all still stores the same value a working one does. The client-IP fix shipped behind a unit test on `AuthController.toWebRequest` for exactly this reason. When the assertion has to be end-to-end, set `process.env.NODE_ENV = 'production'` at the top of the spec — before `createTestApp` requires `AppModule`, since `@better-auth/core` snapshots `NODE_ENV` on first import — and restore it in `afterAll`. `test/auth/session-address.e2e-spec.ts` and `test/auth/trusted-origins.e2e-spec.ts` both do this; the latter for `skipOriginCheck`, which defaults to `isTest()` the same way. What carries between files and what does not is worth being exact about, because this paragraph used to say *"jest gives each spec its own worker process"* and that is not true — a worker runs many specs, which is the premise of the ~63 MB/file retention above. What is per-spec is the **module registry**: jest gives each test file a fresh one, so `@better-auth/core` re-snapshots `NODE_ENV` on the next file's first import and the assignment cannot leak through the module graph. `process.env` itself is **process-wide** and is shared with every later spec in that worker, which is exactly why the `afterAll` restore matters and why a teardown that throws before reaching it strands the mutation on every suite the worker runs next — the trail this file records above.
- **`ts-jest` does not fail a run on a type error**, which is how 83 type errors once accumulated in this tree unnoticed. `pnpm typecheck` covers `src/` **and** `test/`, and CI runs it for exactly that reason — a green test run says nothing about types.

Both configs carry a `transformIgnorePatterns` allowlist and a custom `resolver` (`test/octokit-resolver.js`). Those are load-bearing: several dependencies ship ESM that has to be transformed rather than skipped, and octokit needs resolution help. A new dependency that explodes on import inside a test usually belongs in that allowlist.

## Migrations

`db:generate` writes one from a schema change; `db:migrate` applies what is committed in `drizzle/`. **Do not reach for `db:push`** on a database you intend to keep — it writes the column and no journal row, and the next `db:migrate` then dies on an `ALTER TABLE` that has already happened, reporting it by exiting 1 with nothing on stdout or stderr.

## The OpenAPI document

`openapi.json` is checked in so a contract change shows up as a diff in review, and `test/openapi/` asserts it still matches what the DTOs generate — CI runs it with the rest of the unit lane. Regenerate with `openapi:generate`; no database is needed, because the document is reflected off decorator metadata. The same document is served at `/docs` to signed-in callers.

A DTO that cannot be expressed as JSON Schema makes the mount throw — a bare `z.date()` will do it. `main.ts` treats that as a documentation fault rather than a reason to refuse to serve the API: it logs and steps over, and the test is what stops it reaching a release.
