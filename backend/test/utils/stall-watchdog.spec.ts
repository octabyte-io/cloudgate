import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `armStallWatchdog` was armed on two full runs that wedged and stayed
 * quiet through both, and the reason is in here rather than in the timer: its
 * only liveness signal was *"the heartbeat's mtime advanced"*, and the reporter
 * touches that mtime on **every test case result, including a timed-out one**.
 * 107 of the 115 e2e files set `jest.setTimeout(120_000)`, three set 180 s and
 * the remaining five inherit the config's 60 s — every one of them under the
 * 300 s budget — so a suite whose tests all time out reports liveness forever.
 *
 * **What makes this file possible is that the wedge is a shape, not a hang.**
 * The observed failure needs no frozen worker and no Postgres: it is a reporter
 * that touches the heartbeat every 120 s while one suite never finishes. That
 * is a dozen calls on the real reporter and a fake clock, so both predicates
 * are provable in milliseconds against the real modules.
 *
 * **A unit spec rather than an e2e one, deliberately**, on
 * `backend/test/utils/migrations-up-to.ts`' terms: nothing here starts a
 * container, so it belongs in the lock-free `npx jest` config and stays
 * runnable while a real e2e run holds the machine-wide lock — which is exactly
 * when somebody debugging this file wants to run it.
 *
 * **The one double, and why it is `os.tmpdir`.** Both the reporter and
 * `test-postgres` derive their paths from `os.tmpdir()` at module load, so
 * redirecting that one function around an `isolateModules` require moves the
 * heartbeat *and* the machine-wide lock into a throwaway directory while
 * everything under test stays the shipped code — §1.7 allows a `jest.mock` of a
 * node library, and this is the whole of it.
 *
 * Setting `process.env.TMPDIR` instead was tried first and does **not** work:
 * jest-environment-node hands the test a copied `process`, and `os.tmpdir()`
 * reads the real environment block through `safeGetenv`, so the assignment is
 * invisible to it. The copy is silent, which is why the check below exists.
 *
 * That redirection is a safety property and not a convenience: writing the real
 * `$TMPDIR/cloudgate-e2e-heartbeat.json` from a unit run would corrupt the
 * state of any e2e run in flight on this machine, and this spec is meant to be
 * runnable exactly then. {@link loadHarnessIn} refuses to hand back a harness
 * still pointed at the real path.
 */

/** The subset of jest's reporter interface this spec drives. */
interface Reporter {
  onRunStart(
    aggregated: { numTotalTestSuites: number },
    options: { estimatedTime?: number },
  ): void;
  onTestFileStart(test: { path: string }): void;
  onTestCaseResult(): void;
  onTestFileResult(
    test: { path: string },
    result: { numFailingTests: number },
  ): void;
  onRunComplete(): void;
}

interface Harness {
  readonly arm: () => void;
  readonly Reporter: new () => Reporter;
  readonly heartbeatPath: string;
  readonly lockPath: string;
}

interface Heartbeat {
  pid: number;
  at: number;
  done: number;
  total: number;
  inFlight: { suite: string; forS: number }[];
}

const SHARED_POSTGRES = Symbol.for('cloudgate.test.postgres');

/** Paths as jest hands them to the reporter, which slices at `/backend/test/`. */
const suitePath = (relative: string) => join('/repo/backend/test', relative);

const DOCKER_OPS = suitePath('docker-ops/docker-ops.e2e-spec.ts');
const CERTIFICATES = suitePath('certificates/certificates.e2e-spec.ts');
const SETTINGS = suitePath('settings/settings.e2e-spec.ts');

const loadHarnessIn = (dir: string): Harness => {
  let harness: Harness | undefined;
  try {
    jest.isolateModules(() => {
      const os = jest.requireActual<typeof import('node:os')>('node:os');
      jest.doMock('node:os', () => ({ ...os, tmpdir: () => dir }));
      /* eslint-disable @typescript-eslint/no-require-imports */
      const reporter =
        require('./heartbeat-reporter') as (new () => Reporter) & {
          HEARTBEAT_PATH: string;
        };
      const watchdog = require('./stall-watchdog') as {
        armStallWatchdog: () => void;
      };
      /* eslint-enable @typescript-eslint/no-require-imports */
      harness = {
        arm: watchdog.armStallWatchdog,
        Reporter: reporter,
        heartbeatPath: reporter.HEARTBEAT_PATH,
        lockPath: join(dir, 'cloudgate-e2e-postgres.lock'),
      };
    });
  } finally {
    jest.dontMock('node:os');
  }
  if (!harness || !harness.heartbeatPath.startsWith(dir)) {
    // Not dead code: without this the spec silently drives the machine's real
    // heartbeat and can corrupt a live e2e run's view of itself.
    throw new Error(
      `the heartbeat is still at ${harness?.heartbeatPath ?? '?'}, not under ${dir}`,
    );
  }
  return harness;
};

describe('backend/test/utils/stall-watchdog.ts', () => {
  let dir: string;
  let harness: Harness;
  let exit: jest.SpyInstance;
  let errors: string[];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloudgate-watchdog-spec-'));
    harness = loadHarnessIn(dir);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // `useFakeTimers` reinstalls the clock, so intervals armed by a previous
    // arm are discarded with it. Every budget on this page is spent in fake
    // time; the real ones are five minutes.
    jest.useFakeTimers();
    rmSync(harness.heartbeatPath, { force: true });
    rmSync(harness.lockPath, { force: true });
    errors = [];
    jest
      .spyOn(console, 'error')
      .mockImplementation(
        (...args: unknown[]) => void errors.push(String(args[0])),
      );
    jest.spyOn(console, 'log').mockImplementation(() => {});
    // The reporter's own `[e2e <elapsed>s] …` lines go to stderr, and eight
    // simulated runs' worth of them buries the assertion that failed.
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exit = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.CLOUDGATE_E2E_STALL_MS;
    delete process.env.CLOUDGATE_E2E_NO_WATCHDOG;
    delete (globalThis as Record<symbol, unknown>)[SHARED_POSTGRES];
  });

  const heartbeat = (): Heartbeat =>
    JSON.parse(readFileSync(harness.heartbeatPath, 'utf8')) as Heartbeat;

  /** Runs every poll due in the window, and flushes what a fired watchdog awaits. */
  const advance = async (ms: number) => {
    await jest.advanceTimersByTimeAsync(ms);
  };

  /**
   * The two of three full runs on 2026-09-07 that had to be killed by hand,
   * reduced to their reporter traffic: one suite starts, the run keeps
   * finishing nothing, and each of that suite's tests times out at 120 s and
   * touches the heartbeat on the way past.
   */
  const driveTheWedge = async (reporter: Reporter, timeouts: number) => {
    reporter.onRunStart({ numTotalTestSuites: 115 }, {});
    reporter.onTestFileStart({ path: SETTINGS });
    reporter.onTestFileStart({ path: CERTIFICATES });
    // `settings` reports normally and then finishes, which is the last write
    // the heartbeat gets — and therefore the last time `forS` is recomputed.
    for (let elapsed = 0; elapsed < 100_000; elapsed += 10_000) {
      await advance(10_000);
      reporter.onTestCaseResult();
    }
    reporter.onTestFileResult({ path: SETTINGS }, { numFailingTests: 0 });
    for (let timeout = 0; timeout < timeouts; timeout++) {
      await advance(120_000);
      reporter.onTestCaseResult();
    }
  };

  it('fails a run whose one remaining suite has been in flight past the budget, though its tests keep timing out', async () => {
    const reporter = new harness.Reporter();
    harness.arm();

    await driveTheWedge(reporter, 3);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(124);
    expect(errors.join('\n')).toContain(
      'certificates/certificates.e2e-spec.ts',
    );
    // The fact the fix turns on: `forS` on disk is whatever the last suite
    // boundary computed — 100 s — because `#touch()` moves the mtime and
    // nothing else. A predicate that read it verbatim would never fire.
    expect(heartbeat().inFlight).toEqual([
      { suite: 'certificates/certificates.e2e-spec.ts', forS: 100 },
    ]);
  });

  it('names the suite and the age it reached rather than the age the heartbeat records', async () => {
    const reporter = new harness.Reporter();
    harness.arm();

    await driveTheWedge(reporter, 3);

    // 100 s of it under `settings`, then 200 s of timing out alone.
    expect(errors.join('\n')).toContain(
      'certificates/certificates.e2e-spec.ts (300s)',
    );
  });

  it('fails a run that stops reporting with nothing in flight at all, which is the frozen-worker hang', async () => {
    const reporter = new harness.Reporter();
    harness.arm();
    reporter.onRunStart({ numTotalTestSuites: 1 }, {});
    reporter.onTestFileStart({ path: DOCKER_OPS });
    await advance(10_000);
    reporter.onTestFileResult({ path: DOCKER_OPS }, { numFailingTests: 0 });
    reporter.onRunComplete();

    await advance(6 * 60 * 1000);

    expect(exit).toHaveBeenCalledWith(124);
    expect(errors.join('\n')).toContain('nothing has been reported');
    expect(errors.join('\n')).toContain('no suite was in flight');
  });

  it('leaves a healthy run alone through a suite slower than every real one, and past the budget in total', async () => {
    const reporter = new harness.Reporter();
    harness.arm();
    reporter.onRunStart({ numTotalTestSuites: 40 }, {});

    // `docker-ops.e2e-spec.ts` is the slowest suite three full runs have —
    // 78.1 s, 72.4 s and 68.7 s — and the second slowest is 34 s.
    reporter.onTestFileStart({ path: DOCKER_OPS });
    for (let elapsed = 0; elapsed < 80_000; elapsed += 5_000) {
      await advance(5_000);
      reporter.onTestCaseResult();
    }
    reporter.onTestFileResult({ path: DOCKER_OPS }, { numFailingTests: 0 });

    // Then 39 median-length suites, so the *run* runs well past the budget
    // while no single suite does.
    for (let suite = 0; suite < 39; suite++) {
      const path = suitePath(`generated/suite-${suite}.e2e-spec.ts`);
      reporter.onTestFileStart({ path });
      await advance(3_000);
      reporter.onTestCaseResult();
      await advance(3_000);
      reporter.onTestFileResult({ path }, { numFailingTests: 0 });
    }

    expect(exit).not.toHaveBeenCalled();
  });

  it('leaves a suite alone that is in flight for one poll short of the budget', async () => {
    const reporter = new harness.Reporter();
    harness.arm();
    reporter.onRunStart({ numTotalTestSuites: 2 }, {});
    reporter.onTestFileStart({ path: CERTIFICATES });
    for (let elapsed = 0; elapsed < 290_000; elapsed += 10_000) {
      await advance(10_000);
      reporter.onTestCaseResult();
    }

    expect(exit).not.toHaveBeenCalled();

    reporter.onTestFileResult({ path: CERTIFICATES }, { numFailingTests: 0 });
    await advance(20_000);

    expect(exit).not.toHaveBeenCalled();
  });

  it('spends CLOUDGATE_E2E_STALL_MS on the in-flight suite as well as on the silence', async () => {
    process.env.CLOUDGATE_E2E_STALL_MS = '20000';
    const reporter = new harness.Reporter();
    harness.arm();
    reporter.onRunStart({ numTotalTestSuites: 2 }, {});
    reporter.onTestFileStart({ path: CERTIFICATES });
    // Under the shrunk budget an 8 s report period is what a 120 s one is
    // under the real one: liveness with no progress.
    for (let timeout = 0; timeout < 4; timeout++) {
      await advance(8_000);
      reporter.onTestCaseResult();
    }

    expect(exit).toHaveBeenCalledWith(124);
    expect(errors.join('\n')).toContain('budget 20s');
  });

  it('stays inert on the same wedge when CLOUDGATE_E2E_NO_WATCHDOG is set', async () => {
    process.env.CLOUDGATE_E2E_NO_WATCHDOG = '1';
    const reporter = new harness.Reporter();
    harness.arm();

    await driveTheWedge(reporter, 5);

    expect(exit).not.toHaveBeenCalled();
  });

  it('releases the machine-wide lock and stops the shared container on the way out', async () => {
    const stop = jest.fn().mockResolvedValue(undefined);
    (globalThis as Record<symbol, unknown>)[SHARED_POSTGRES] = {
      adminUrl: 'postgresql://unused',
      container: { stop },
    };
    // The lock as `acquireE2eLock` leaves it: this pid, no newline.
    writeFileSync(harness.lockPath, String(process.pid));

    const reporter = new harness.Reporter();
    harness.arm();

    await driveTheWedge(reporter, 3);

    expect(exit).toHaveBeenCalledWith(124);
    expect(existsSync(harness.lockPath)).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
