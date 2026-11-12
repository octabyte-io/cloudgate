# Running the tests

## The one rule

**Run the files your change touches, not the suite.** If the change is broad
enough to deserve it, finish with one full run, done once by whoever is
coordinating the work and not by every agent.

```bash
cd backend
npx jest --config ./test/jest-e2e.json --runTestsByPath test/mounts/mounts.e2e-spec.ts
```

`--runTestsByPath` takes absolute or repo-relative paths and is unambiguous.
Bare positional args are matched as regexes against the full path, which is why
`test/app.e2e-spec.ts` sometimes selects nothing and sometimes selects a dozen
files.

Do not run several full suites in parallel. The machine-wide lock serialises
them anyway, so a second run only waits.

## The lanes

| lane | command | needs |
|---|---|---|
| unit | `cd backend && npx jest` | nothing: no Docker, no lock |
| database | `cd backend && pnpm test:db` | Docker, takes the lock |
| e2e | `cd backend && pnpm test:e2e` | Docker, takes the lock |
| moto | `cd backend && pnpm test:moto` | Docker, OpenTofu (see below) |
| Google validate | `cd backend && pnpm test:google-validate` | OpenTofu (see below) |

The **unit** config lives in `package.json` (`pnpm test:watch` and
`pnpm test:debug` use it too) and can run while an e2e run holds the lock:
its `globalSetup`, `test/utils/unit-global-setup.ts`, only arms the watchdog
and sets the platform root, and `test/utils/unit-lane-watchdog.spec.ts` keeps
it from inheriting the locking `test/utils/global-setup.ts`. The **database**
lane (`test/jest-db.json`) is the three specs that touch Postgres
(`harness.spec.ts`, `common/trust-proxy.spec.ts`, `db/columns.spec.ts`). It and
**e2e** (`test/jest-e2e.json`, every file boots the whole Nest app) share
`test/jest-preset.js`, which sets `maxWorkers`, `workerIdleMemoryLimit`,
`logHeapUsage`, the reporters and the locking `globalSetup`.

## Rough sizes

All approximate; they move as specs are added.

- **Unit**: a bit over 220 files and 3,000 tests; budget 30 s, more alongside a
  live e2e run (CPU, not the lock).
- **Database**: 3 files, a few seconds. Budget wall clock, not jest's `Time:`.
- **E2e**: over a hundred suites, a couple of thousand tests, about **5
  minutes**, peaking at roughly **5 GB plus the Postgres container**.
- **Per worker**: about 370 MB of heap on its first file, then roughly 75 MB
  more per file (Nest's DI container retains it). `workerIdleMemoryLimit:
  "1.5GB"` recycles a worker past that, about 2.2 GB of RSS.
- **Workers**: the Docker configs cap `maxWorkers` at **2** through the preset;
  the unit config uses `"50%"`. **Do not raise `maxWorkers`**;
  `backend/README.md` says why.
- **The machine-wide lock** (`$TMPDIR/cloudgate-e2e-postgres.lock`): one
  Postgres-backed run at a time. A second run prints

  ```
  [e2e] another run holds …/cloudgate-e2e-postgres.lock; waiting rather than starting a second Postgres.
  ```

  and waits; nothing is lost. A lock left by a killed run is taken over once
  its pid is dead, so do not delete it by hand. The wait times out after 45
  minutes. `CLOUDGATE_E2E_NO_LOCK=1` skips the lock; use it only on a machine
  with real headroom, never to run several suites at once.

## A single red suite is not your regression

A full e2e run goes wrong on one arbitrary suite roughly **two runs in three**,
a different one each time, and each passes in isolation. That is baseline
behaviour, whether it shows as a red suite, an OOM or a wedge (exit 124).

So: **reproduce it in isolation before you believe it.**

```bash
npx jest --config ./test/jest-e2e.json --runTestsByPath <the suite that failed>
```

Green in isolation means you found the pre-existing flake, not a bug. Say so and
move on (`backend/README.md` records where the trail leads). **But green in
isolation is also what an OOM looks like**: check the log for `ran out of
memory` first.

## An OOM is not a red suite, and it passes in isolation too

A full run can print this:

```
● Test suite failed to run
    Jest worker ran out of memory and crashed
```

That suite is not broken: its worker had already run many files and its heap
outgrew what V8 allows. Alone it passes, so isolation cannot tell this from the
flake. **The log can**: grep it for `ran out of memory`. Nothing else says that.

Both Docker configs therefore set `workerIdleMemoryLimit: "1.5GB"`: between
files jest replaces a worker whose heap is past it. That bounds memory and
speeds the run up, but it does not fix the leak and cannot save one file that
allocates too much on its own. `logHeapUsage` puts each worker's `heapUsed` on
every suite line of an e2e log. The unit config sets neither.

## When a run hangs

A run can stop dead: no output, no failure, workers resident at 0% CPU.
`testTimeout` does not help, because it is a timer inside the worker and a
worker that is not being scheduled cannot fire it.

**`test/utils/heartbeat-reporter.js`** writes a heartbeat file per lane,
`$TMPDIR/cloudgate-e2e-heartbeat.json` or `$TMPDIR/cloudgate-unit-heartbeat.json`.
The e2e lane also prints one `[e2e <elapsed>s] …` line per suite boundary; the
unit lane prints only a start and an end line.

```bash
grep '^\[e2e ' <the run's log>               # progress lines only
cat "$TMPDIR/cloudgate-e2e-heartbeat.json"   # what is in flight, right now, from another shell
```

A `PASS` line only says what finished; the heartbeat names what is in flight.
Its `forS` only updates at a suite boundary, so during a wedge add the seconds
since the file's `at`.

**`test/utils/stall-watchdog.ts`**, armed from every config's `globalSetup`
(the unit one included), fails the run with exit **124** on either of two
triggers:

- **nothing has been reported for five minutes**: a worker no longer being
  scheduled, or a stall in `globalTeardown`.
- **one suite has been in flight for five minutes**: a wedge, whose timed-out
  tests keep the heartbeat alive. The slowest healthy suite is under two
  minutes.

It prints the suites in flight, for example

```
[e2e] WEDGED: certificates/certificates.e2e-spec.ts has been in flight for 301s (budget 300s), and the run's last report of any kind was 45s ago.
[e2e] 114/115 suites reported; in flight: certificates/certificates.e2e-spec.ts (301s)
```

then releases the lock and stops the container, since `globalTeardown` will
not run (on the unit lane both are no-ops: it only releases a lock holding its
own pid). Exit 124 is a hang, not a red suite; treat a wedged suite like a red
one and **re-run it alone before you believe it**.

`CLOUDGATE_E2E_STALL_MS` moves **both** budgets and
`CLOUDGATE_E2E_NO_WATCHDOG=1` disarms it, on every lane including `npx jest`.
It does not cover the preamble (Postgres start-up and the 45-minute lock wait
have their own timeouts), and it goes inert, saying so, under
`--watch`/`--watchAll` or an attached inspector (`pnpm test:debug`).
`--forceExit` and `openHandlesTimeout` act only after results exist, so they
cannot end a hang, and `--forceExit` reports a leaked handle as a success.

## Pointing at a Postgres you already have

`TEST_POSTGRES_URL` runs against a server that is already up instead of starting
a container:

```bash
TEST_POSTGRES_URL='postgresql://postgres:postgres@localhost:5432/postgres' \
  npx jest --config ./test/jest-e2e.json
```

Each suite still creates and drops its own database on it, so nothing already on
that server is touched. It is the same speed as the container. The cost is that
the tests then run against whatever major version that server happens to be.

## Every lane runs under a relocated platform root

Every config's `globalSetup` sets `CLOUDGATE_DIRECTORY` to
`/var/lib/cloudgate-test-platform-root` before any worker is forked
(`test/utils/platform-root.ts`), so the platform host's root and a Server's
`/etc/cloudgate` are never the same string and a test that confuses them goes
red. Take such an expectation from `cloudgateDirectoryOn(null)` (platform host)
or `cloudgateDirectoryOn(serverId)` (a Server) plus a literal tail; never
hard-code the relocated value. A root you set yourself is kept unless it is
`/etc/cloudgate`, so this checks an expectation was not hand-set:

```bash
CLOUDGATE_DIRECTORY=/srv/some-other-root npx jest --runTestsByPath <file>
```

`test/utils/platform-root-gate.spec.ts` fails if any lane stops setting the root.

## The moto lane: real `tofu` against moto, and the stored plan files

`test/jest-moto.json` runs the generated AWS definitions through the real
runner, the pinned OpenTofu and AWS provider, a moto container
(`motoserver/moto`, pinned in the spec) and a Postgres for the state: create,
plan "no changes", change by hand and plan the drift, destroy. It re-saves the
stored plan files in `test/cloud-accounts/fixtures/plans/` that the in-memory
cloud port replays in every e2e spec. It is not on the e2e preset: its own
containers, no machine-wide lock, no app.

```bash
eval "$(backend/test/cloud-accounts/moto/install-opentofu.sh /tmp/cloudgate-opentofu)"
export OPENTOFU_BINARY OPENTOFU_PROVIDER_MIRROR
cd backend && pnpm test:moto
```

`install-opentofu.sh` takes the pinned versions and checksums from
`deploy/install.sh` and `deploy/opentofu/.terraform.lock.hcl` (about 215 MB the
first time). Expect roughly half an hour: about 10 minutes for the main lane,
10 for the database lane, 6 each for the bucket and `static` lanes, and seconds
for `test/object-storage/`'s `s3-object-storage.moto-spec.ts` and
`garage.moto-spec.ts` (needs the `docker` CLI).

**Run it, and commit what it re-saves, before merging any change to the pins
(`deploy/install.sh`'s `OPENTOFU_*`, `deploy/opentofu/`) or to the generated
definitions (`backend/src/cloud-accounts/aws/definitions/`).** A stored plan
the definitions no longer produce is an e2e suite proving something `tofu`
would never print. The release workflow's `moto` job (`e2e.yml`) runs it too,
fails when the re-saved files differ from the committed ones, and uploads them.

The tag search after a Delete, AWS-made ENIs, certificate DNS validation,
running containers and routing are left to the walk by hand
(`docs/aws-walk-by-hand.md`), required before a release that changes the pins,
the definitions or the permissions. Field differences between moto and AWS are
listed in `MOTO_GAPS` (`test/cloud-accounts/moto/moto-gaps.ts`) and closed in
every plan; an unlisted one fails "no changes". What moto has no API for is in
`MOTO_MISSING`.

## The Google validate lane: `tofu validate` of the Google definitions

Google has no moto. `test/jest-validate.json` renders the generated Google
definitions as a Google Cloud run lays them out and runs `tofu init
-backend=false` and `tofu validate` with the pinned OpenTofu and Google
provider; a control case expects an unknown attribute refused. No project,
credential, Docker or Postgres; about 10 seconds (about 140 MB to install the
first time).

```bash
eval "$(backend/test/cloud-accounts/moto/install-opentofu.sh /tmp/cloudgate-opentofu google)"
export OPENTOFU_BINARY OPENTOFU_PROVIDER_MIRROR
cd backend && pnpm test:google-validate
```

**Run it before merging any change to the Google definitions
(`backend/src/cloud-accounts/gcp/definitions/`) or the Google pins.** The
release workflow's `google-validate` job (`e2e.yml`) also fails the release
while any stored Google plan or apply output (`test/cloud-accounts/fixtures/`
`plans/google/`, `applies/google/`) carries `"cloudgate_fixture": { "source":
"not yet from a real project" }` or a `cloudgate_fixture.how` that does not name
`hashicorp/google <pin>`. The walk by hand (`docs/gcp-walk-by-hand.md`)
re-records them.

The stored Google plans were made offline with the pinned `tofu` and provider
(placeholder `GOOGLE_OAUTH_ACCESS_TOKEN`, an unreachable proxy,
`-refresh=false`, a local backend; `resource_drift` hand-written). A definitions
change that moves what they plan means re-planning them that way, or by the
walk. `validate` checks the schema only: quotas, organisation policies, taken
names, ordering and running Services are the walk's.
