import { statSync } from 'node:fs';
import { url as inspectorUrl } from 'node:inspector';
import { recallSharedPostgres, releaseE2eLock } from './test-postgres';

// Required rather than imported: the reporter is CommonJS, loaded by jest's own
// `require` in this same process, and a TS `import` of it would make the
// reporter a compile-time dependency of the harness in one direction only.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { heartbeatPathFor } = require('./heartbeat-reporter') as {
  heartbeatPathFor: (lane?: string) => string;
};

/**
 * How long the run may report nothing before it is called a hang.
 *
 * Measured rather than guessed. Across three full 114-suite runs — 265 s,
 * 292 s and 510 s, the last of them under enough memory pressure to OOM a worker
 * — the longest gap between two reporter events was **28 s**, and a healthy run
 * has an argument for why it cannot go much further: `testTimeout`
 * (60 s) bounds every test *and every hook*, since jest-circus times a hook with
 * `hook.timeout || getState().testTimeout`, so the only uncapped stretch inside
 * a suite is ts-jest compiling a cold file before the first hook runs. Five
 * minutes is about 11x the observed worst gap and several times the worst case
 * anything in the harness can defend, which is the margin that keeps this from
 * firing on a slow machine.
 *
 * The margin is deliberately generous because `testTimeout` is **not** the
 * backstop it looks like. It is a timer inside the worker, so it bounds a worker
 * that is running and says nothing about one that has stopped being scheduled —
 * which is the observed failure, both workers resident at 0.0% CPU. Freezing the
 * workers of a live run with `SIGSTOP` reproduces it exactly: no timeout fires,
 * no output appears, and jest waits indefinitely.
 *
 * It is not a *run* deadline. A run deadline has to be raised every time the
 * suite grows — the count went 79 → 114 between two revisions of
 * `docs/testing.md` — whereas "nothing has happened for five
 * minutes" stays true at any size.
 */
const DEFAULT_STALL_MS = 5 * 60 * 1000;

/** The `timeout(1)` convention, so a wrapper script can tell a hang from a red suite. */
const STALL_EXIT_CODE = 124;

const POLL_MS = 10_000;

const seconds = (ms: number): number => Math.round(ms / 1000);

/**
 * One budget, spent two ways, and `CLOUDGATE_E2E_STALL_MS` moves both.
 *
 * The second predicate below could have taken its own override. It does not,
 * for three reasons, and the middle one is the load-bearing one:
 *
 * - The two predicates answer the same question — *has this run made progress
 *   inside the budget* — and the only honest reason to move either number is a
 *   machine slower than the one they were measured on, which slows both.
 * - A second knob's default would sit at five minutes every time somebody set
 *   the documented one, so **the red-green loop would stop covering the
 *   predicate that matters**. `CLOUDGATE_E2E_STALL_MS=20000` is how both this
 *   file's verification runs were done, and sharing the budget is what makes
 *   that shrink exercise the wedge path as well as the silence path — which is
 *   asserted, in `stall-watchdog.spec.ts`, rather than left as an intention.
 * - The margins differ (~11x the worst observed reporting gap, ~4x the slowest
 *   observed suite — see {@link DEFAULT_STALL_MS} and
 *   {@link suiteWedgedFor}), so the shared number is really constrained by the
 *   per-suite half. That is an argument for splitting the knob **if** a suite
 *   that legitimately needs more than five minutes ever appears; the slowest
 *   one on this tree needs 78 s, so splitting it now would be two knobs to
 *   document and one of them permanently unused.
 */
const stallBudgetMs = (): number => {
  const override = Number(process.env.CLOUDGATE_E2E_STALL_MS);
  return Number.isFinite(override) && override > 0
    ? override
    : DEFAULT_STALL_MS;
};

/**
 * Never poll less often than a quarter of the budget.
 *
 * A fixed 10 s poll makes the watchdog untestable below a 40 s budget: the
 * verification run that first proved it fires used
 * `CLOUDGATE_E2E_STALL_MS=20000`, and with a 10 s poll the first two ticks land
 * before the budget is spent and the third never comes because the run is over.
 * Deriving the poll from the budget means shrinking the budget shortens the
 * feedback loop too, which is what makes a red-green for this file possible at
 * all. The 1 s floor is so a pathological override cannot spin.
 */
const pollMs = (budget: number): number =>
  Math.max(1_000, Math.min(POLL_MS, Math.round(budget / 4)));

/**
 * Which run this watchdog is watching, and why the lane is a parameter.
 *
 * `lane` picks the heartbeat file — `heartbeatPathFor` in
 * `utils/heartbeat-reporter.js` argues why there is more than one, and why the
 * `e2e` default is the one that had to stay byte for byte where it was. Absent,
 * so the two Docker configs' `armStallWatchdog()` call and their bare
 * `reporters` entry both keep meaning the `e2e` lane without saying so.
 *
 * **The lane is spelled twice per config and cannot be derived from one place,
 * which is a cost worth naming.** Jest hands a reporter its options and a
 * `globalSetup` its `globalConfig`, and nothing in `globalConfig` distinguishes
 * the unit config from `jest-db.json` — both root at `backend/` and only the
 * `testRegex` in the *project* config differs. So the reporter is told its lane
 * by `reporters`, the watchdog by its `globalSetup`, and a disagreement makes
 * the watchdog inert with the "no heartbeat of ours" line rather than wrong.
 * `unit-lane-watchdog.spec.ts` holds the two halves equal instead of trusting
 * that; the alternative — a `jest.config.js` that could compute both from one
 * constant — means moving the unit config out of `package.json`, which is a
 * bigger change than the drift it removes.
 *
 * **`CLOUDGATE_E2E_STALL_MS` and `CLOUDGATE_E2E_NO_WATCHDOG` are deliberately
 * not renamed, and they now read wrong.** Both reach every lane — they are read
 * here and in {@link stallBudgetMs}, neither of which knows about lanes — so a
 * unit run is disarmed and re-budgeted by an env var with `E2E` in its name.
 * `CLOUDGATE_TEST_STALL_MS` / `CLOUDGATE_TEST_NO_WATCHDOG` is the honest
 * spelling. Renaming was rejected here rather than done quietly: both names are
 * documented knobs in `docs/testing.md`, both appear in
 * `stall-watchdog.spec.ts`, and a rename is either a break for anyone with the
 * old spelling in a wrapper script or a second alias to document. That change was a
 * hygiene ticket and this is a rename of a public knob; it is proposed there
 * rather than smuggled in here.
 */
interface Lane {
  /** The heartbeat lane; `undefined` means `e2e`. */
  lane?: string;
  /**
   * `globalConfig.watch || globalConfig.watchAll`, as jest hands it to a
   * `globalSetup` — the second argument of `globalModule(globalConfig,
   * projectConfig)` in `runGlobalHook`.
   */
  watch?: boolean;
}

/**
 * Fails a run that has stopped making progress, instead of letting it hang.
 *
 * **What broke first.** A full run served requests normally for ~6 minutes and
 * then went silent for 21 minutes with both workers resident at 0.0% CPU. It
 * did not finish and it did not fail; it was killed by hand at 26:51, and
 * nothing in the output said which suite had been in flight.
 *
 * **Nothing in jest converts that into a failure, and the two options that look
 * like they might do something else.** Both were read in
 * `jest-cli@30.4.2`/`jest-worker@30.4.1` rather than taken from the docs:
 *
 * - `--forceExit` acts in `readResultsAndExit`, which runs **after** `runCLI`
 *   has returned results — i.e. after every suite and after `globalTeardown`.
 *   It cannot end a hang that happens before results exist, which is the
 *   observed one (workers still resident means the worker pool had not been
 *   ended). Where it does act, it exits with the code the results already
 *   carried, so a leak that kept the process alive is reported as **success**.
 *   That is the "masks the bug" outcome the watchdog ticket explicitly did not want.
 * - `openHandlesTimeout` (default 1000 ms) prints *"Jest did not exit one
 *   second after the test run has completed"* on an `unref`ed timer. A warning,
 *   on the same post-results path, and therefore silent on this hang too.
 * - `testTimeout` does bound hooks as well as tests — jest-circus reads
 *   `hook.timeout || getState().testTimeout` — so an `afterAll` that *awaits
 *   something which never resolves* already fails at 60 s with
 *   `Exceeded timeout of 60000 ms for a hook`. But that timer lives in the
 *   worker, so it bounds a worker that is **running**. It does nothing for one
 *   that has stopped being scheduled, which is what "resident at 0.0% CPU"
 *   describes. `SIGSTOP` on the workers of a live run is the whole bug in one
 *   signal: no timeout, no output, no exit. That is the red this file's
 *   verification used.
 * - `jest-worker`'s pool `end()` schedules a `forceExit` 500 ms after asking a
 *   worker to stop (`workerGracefulExitTimeout`), so a hang with workers still
 *   resident is not worker shutdown either — `end()` had not been reached.
 *
 * So the deadline is here, armed from `globalSetup` rather than wrapped around
 * the `jest` process. Arming it here is what makes it apply to `npx jest
 * --config ./test/jest-e2e.json` — how `docs/testing.md` tells you
 * to run a suite, and how every agent's wrapper script actually invokes one —
 * and not only to `npm run test:e2e`, which is where the ticket suggested putting a
 * `--forceExit` and where almost nobody would have been covered. `globalSetup`
 * is transpiled and required *in the jest main process*
 * (`runGlobalHook` → `createScriptTransformer().requireAndTranspileModule`), so
 * a timer armed here is a real node timer in the process that owns the run.
 *
 * **The second predicate, and why one was not enough.** "Nothing has
 * been reported" was armed on two full runs that wedged and it fired on
 * neither, because the reporter touches the heartbeat on every test case result
 * **including a timed-out one** — see {@link suiteWedgedFor} for the arithmetic
 * that makes that fatal. So a suite that has been in flight longer than the
 * budget now fails the run too, and the two are checked in that order: on
 * the frozen-worker shape both are true within one poll of each other, and
 * the per-suite one is the one that names a file.
 *
 * `unref`ed, so the watchdog can never be the reason a healthy run fails to
 * exit — the failure mode it exists to catch.
 *
 * **Three lanes arm this, not one.** `package.json`'s lock-free `jest`
 * block set no `globalSetup` and no `reporters`, so a hung `npx jest` — every
 * spec on the lock-free lane, most of them building a Nest module graph — was
 * unbounded and silent, with not even a heartbeat file to inspect. (The file
 * count this clause used to spell is gone for `unit-global-setup.ts`' reason:
 * it was one of three copies of a number a single command prints, and all three
 * were stale.) It is now armed from
 * `unit-global-setup.ts`, which is a `globalSetup` of its own precisely so that
 * `global-setup.ts`' `acquireE2eLock`/`startSharedPostgres` cannot come with it:
 * the hook is what the unit lane needs, the Postgres is what it must not have.
 * {@link Lane} carries the rest of that argument. The two env knobs are
 * deliberately *not* renamed — see {@link stallBudgetMs} and {@link Lane}.
 *
 * **And two shapes that are a human waiting, not a run stalling**, both of
 * which arrived with the unit lane because that is the config `test:watch` and
 * `test:debug` use. Jest re-runs `globalSetup` on every watch cycle, so an
 * armed watch session would exit 124 five minutes after the last cycle
 * finished; and `node --inspect-brk … --runInBand` parked on a breakpoint looks
 * exactly like the frozen worker. Both go inert rather than fire, and both
 * say so, because {@link armStallWatchdog}'s own rule is that a silently
 * disarmed watchdog is worse than none.
 */
export function armStallWatchdog(options: Lane = {}): void {
  if (process.env.CLOUDGATE_E2E_NO_WATCHDOG === '1') return;

  const heartbeatPath = heartbeatPathFor(options.lane);
  // Every operator-facing line carries its lane, so a `[unit] WEDGED:` cannot
  // be mistaken for the e2e run that may well be holding the lock beside it.
  // `[e2e …]` is unchanged, which is what keeps `grep '^\[e2e '` in
  // `docs/testing.md` true.
  const tag = `[${options.lane ?? 'e2e'}]`;

  if (options.watch) {
    console.log(
      `${tag} watch mode: the stall watchdog is inert. Jest ` +
        `re-runs globalSetup per cycle, and an idle watch session between two ` +
        `cycles is indistinguishable from the frozen-worker hang.`,
    );
    return;
  }

  // `inspector.url()` is undefined unless a debugger is actually listening, so
  // this costs a plain run nothing and is not the same question as
  // `--runInBand`, which the Docker configs use legitimately.
  const attachedAt = inspectorUrl();
  if (attachedAt) {
    console.log(
      `${tag} a debugger is attached at ${attachedAt}; the ` +
        `stall watchdog is inert. A breakpoint is a person thinking, not a stall.`,
    );
    return;
  }

  const budget = stallBudgetMs();
  let warnedMissing = false;
  // The clock is *our* last observed advance, not the file's mtime, because the
  // path is a fixed one in `$TMPDIR` and a second run writing to it would
  // otherwise keep this run's watchdog quiet forever. That is not theoretical:
  // it happened during this file's own verification, when another agent's `jest`
  // took the machine-wide lock off a dead pid and its reporter adopted the same
  // file. `mtime` says "somebody is alive"; only the pid says it is us.
  let lastAdvanceAt = 0;
  let lastSeenMtimeMs = 0;

  const timer = setInterval(() => {
    const now = Date.now();
    let heartbeat: { mtimeMs: number };
    try {
      heartbeat = statSync(heartbeatPath);
    } catch {
      heartbeat = { mtimeMs: 0 };
    }

    const state = readOwnHeartbeat(heartbeatPath);

    if (heartbeat.mtimeMs > lastSeenMtimeMs && state) {
      lastSeenMtimeMs = heartbeat.mtimeMs;
      lastAdvanceAt = now;
    }

    if (lastAdvanceAt === 0) {
      // Nothing of ours has ever been written: the reporter has not started
      // yet, or is not configured at all. Say so once and stay inert rather
      // than failing a run that never had a heartbeat to lose — but say it,
      // because a silently disarmed watchdog is worse than none. The next
      // 26-minute silence would be blamed on it not working.
      if (!warnedMissing) {
        warnedMissing = true;
        console.log(
          `${tag} no heartbeat of ours at ${heartbeatPath}; the stall watchdog ` +
            `is inert until utils/heartbeat-reporter.js reports. Is "reporters" ` +
            `still in this jest config?`,
        );
      }
      return;
    }

    const silentMs = now - lastAdvanceAt;

    // The per-suite predicate first: it is true within a poll of the silence
    // one on a frozen worker, earlier than it on a wedge, and it is the one
    // that can name the file.
    const wedged = state && suiteWedgedFor(state, now, budget);
    if (wedged) {
      clearInterval(timer);
      void failRun(tag, [
        `${tag} WEDGED: ${wedged.suite} has been in flight for ${seconds(wedged.ms)}s ` +
          `(budget ${seconds(budget)}s), and the run's last report of any kind was ` +
          `${seconds(silentMs)}s ago.`,
        `${tag} ${describeInFlight(state, now)}`,
        `${tag} A suite whose tests time out one at a time keeps touching the`,
        `${tag} heartbeat once per jest.setTimeout, so that second figure never`,
        `${tag} grows and the silence budget below never expires — which is how`,
        `${tag} this shape used to hang until somebody killed it.`,
        `${tag} Failing the run instead, exit ${STALL_EXIT_CODE}.`,
      ]);
      return;
    }

    if (silentMs < budget) return;

    clearInterval(timer);
    void failRun(tag, [
      `${tag} STALLED: nothing has been reported for ${seconds(silentMs)}s (budget ${seconds(budget)}s).`,
      `${tag} ${describeInFlight(state, now)}`,
      `${tag} This is the frozen-worker hang, not a slow machine. A worker that is resident`,
      `${tag} at 0% CPU with no hook running is not covered by testTimeout, so`,
      `${tag} jest would wait forever. Failing the run instead, exit ${STALL_EXIT_CODE}.`,
    ]);
  }, pollMs(budget));
  timer.unref();
}

/** The heartbeat as `utils/heartbeat-reporter.js` writes it. */
interface Heartbeat {
  pid?: number;
  /** `Date.now()` at the moment the file was last **written**, not touched. */
  at?: number;
  done?: number;
  total?: number;
  inFlight?: Array<{ suite: string; forS: number }>;
}

/**
 * The heartbeat on disk, if this run is the one that wrote it.
 *
 * The reporter and `globalSetup` are both loaded in the jest **main** process
 * (reporters by `ReporterDispatcher`, `globalSetup` by `runGlobalHook`'s
 * `createScriptTransformer().requireAndTranspileModule`), so the pid the
 * reporter stamps is this process's own.
 *
 * Read back from the file rather than kept in memory: the reporter is the only
 * thing that knows which files are in flight, and the file is the one channel
 * between them that does not depend on jest's module registry handing both
 * halves the same realm.
 */
function readOwnHeartbeat(heartbeatPath: string): Heartbeat | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const state = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as Heartbeat;
    return state.pid === process.pid ? state : undefined;
  } catch {
    // A half-written file — the reporter rewrites it on every suite boundary,
    // and a `stat` can land between `open` and `write`. Not ours *this* tick.
    return undefined;
  }
}

/**
 * How long each in-flight suite has *actually* been in flight.
 *
 * **`forS` cannot be read verbatim, and this is the one thing the wedge fix got wrong
 * when it called the second predicate "a second predicate over the same JSON,
 * no new plumbing".** The reporter rewrites the file on a suite boundary and
 * only `utimesSync`es it between, so `at` and every `forS` beside it freeze at
 * the last boundary — which, during a wedge, is the moment the wedge started.
 * The issue's own evidence says so: the certificates wedge sat at
 * `forS: 256` for the thirteen minutes it was observed, because 256 s is
 * where that suite was when the run's 114th and last file reported. A predicate
 * comparing 256 against a 300 s budget waits forever.
 *
 * So the age is the recorded one plus however long the record has been standing,
 * `forS + (now - at)`. Both halves are already in the file, which is the sense
 * in which the issue was right.
 *
 * **Rejected: making the reporter keep `forS` fresh** by writing the JSON on
 * every test case result instead of touching it. It would cost little — 2184
 * writes of half a kilobyte across a 300 s run — but it fixes nothing here,
 * because the original shape is a worker that produces *no* test case
 * results at all, so a suite's `forS` freezes under any reporter. The
 * derivation is needed either way, and one place deriving it is better than two.
 */
function inFlightAges(
  state: Heartbeat,
  now: number,
): Array<{ suite: string; ms: number }> {
  const at = Number.isFinite(state.at) ? (state.at as number) : now;
  const sinceWritten = Math.max(0, now - at);
  return (state.inFlight ?? []).map(({ suite, forS }) => ({
    suite,
    ms: (Number.isFinite(forS) ? forS * 1000 : 0) + sinceWritten,
  }));
}

/**
 * The suite that has been in flight past the budget, if there is one.
 *
 * **What broke.** Two of the three full runs on 2026-09-07 wedged on a single
 * suite — `certificates/certificates.e2e-spec.ts` at 114 of 115 files, and
 * `notifications/notifications.e2e-spec.ts` at 10 of 115 under
 * `--maxWorkers=1` — and the watchdog was armed through both and fired on
 * neither. Both were killed by hand, at 13 and 9 minutes of a log that was not
 * being written to. The liveness signal is why: `onTestCaseResult` touches the
 * heartbeat's mtime, **a timed-out test is a test case result**, and every e2e
 * file's per-test timeout is under the budget — 107 of the 115 set
 * `jest.setTimeout(120_000)`, three set 180 s and the other five inherit the
 * config's 60 s. So a wedged suite reports liveness on a 120 s period against a
 * 300 s budget, indefinitely, and `certificates` would have taken 20 x 120 s =
 * 40 minutes to report while `notifications`, at 72 tests, would have taken
 * **2.4 hours**.
 *
 * **Raising the budget is not the fix**, which is worth stating because it is
 * the cheaper-looking one: the predicate is wrong rather than the number, and
 * any spec-level `jest.setTimeout` under the budget defeats it again.
 *
 * **The number, measured (2026-09-07).** Across three full runs of this tree —
 * 239 suite completions in total — the slowest suite was
 * `docker-ops/docker-ops.e2e-spec.ts` at **78.1 s**, 72.4 s and 68.7 s. It is
 * the only suite in any of the three to pass 60 s; two passed 30 s, the second
 * slowest being `settings/settings.e2e-spec.ts` at 34 s, and the median suite is
 * **3 s** in each of the two runs that got past ten files. Five
 * minutes is therefore about **3.8x the slowest suite ever observed** and 9x
 * the second slowest — the same shape of margin {@link DEFAULT_STALL_MS}
 * defends, and deliberately the tighter of the two, because a suite is a much
 * better-bounded thing than a run.
 *
 * Nor is the 180 s `jest.setTimeout` in three of the files a threat to that
 * margin, which is the obvious objection: a *test* allowed 180 s does not make
 * a slow suite, and those three files finish in 0.4 s, 3.9 s and 5.9 s.
 *
 * Sharing the budget with the silence predicate is argued at
 * {@link stallBudgetMs}.
 */
function suiteWedgedFor(
  state: Heartbeat,
  now: number,
  budget: number,
): { suite: string; ms: number } | undefined {
  return inFlightAges(state, now)
    .filter((suite) => suite.ms >= budget)
    .sort((left, right) => right.ms - left.ms)[0];
}

/**
 * Takes the state the predicate decided on rather than re-reading it, so the
 * diagnosis cannot name a different tick's suites than the failure did.
 */
function describeInFlight(state: Heartbeat | undefined, now: number): string {
  if (!state) {
    return `the heartbeat could not be read, or does not belong to this run (${process.pid})`;
  }
  const progress = `${state.done ?? '?'}/${state.total ?? '?'} suites reported`;
  const suites = inFlightAges(state, now);
  if (suites.length === 0) {
    return `${progress}; no suite was in flight — the stall is in globalTeardown or in jest's exit`;
  }
  return `${progress}; in flight: ${suites
    .map((suite) => `${suite.suite} (${seconds(suite.ms)}s)`)
    .join(', ')}`;
}

/**
 * The one way out, shared by both predicates: say which one tripped and why,
 * then leave the machine as a `globalTeardown` would have.
 *
 * **Lane-agnostic by construction, which is why the lock-free lane can share
 * it.** `releaseE2eLock` compares the pid *in* the lock file against
 * this process's own and unlinks only on a match, and `recallSharedPostgres`
 * reads a `globalThis` symbol only `global-setup.ts` ever writes. So a `npx
 * jest` watchdog firing while a real e2e run holds the lock releases nothing
 * and stops nothing — the one outcome that would have been unforgivable here,
 * since the unit lane exists to run exactly then.
 */
async function failRun(tag: string, lines: string[]): Promise<void> {
  console.error(
    [
      '',
      ...lines,
      `${tag} Re-run the named suite with --runTestsByPath, and see`,
      `${tag} docs/testing.md ("When a run hangs").`,
      '',
    ].join('\n'),
  );

  // `globalTeardown` will not run after this, so the two things that outlive a
  // killed run have to be dealt with here: the machine-wide lock (a stale one
  // makes the next run wait on a dead pid) and the Postgres container (a leaked
  // one is a container per hang). The lock first and synchronously, because it
  // is the one whose absence blocks somebody else.
  releaseE2eLock();
  try {
    const shared = recallSharedPostgres();
    if (shared?.container) {
      await Promise.race([
        shared.container.stop(),
        new Promise((resolve) => setTimeout(resolve, 15_000)),
      ]);
    }
  } catch {
    // A container we could not stop is a `docker rm` for somebody, not a reason
    // to go back to hanging.
  }
  process.exit(STALL_EXIT_CODE);
}
