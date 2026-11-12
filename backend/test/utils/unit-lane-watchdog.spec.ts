import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The half of the lane change that is a property rather than a config edit.
 *
 * `package.json`'s `jest` block set no `globalSetup` and no `reporters`, so
 * `armStallWatchdog` never armed for `npx jest` and no heartbeat was ever
 * written: a hung unit run was unbounded and silent. The fix is **three** edits
 * that only work together — a `globalSetup` of the lane's own, the heartbeat
 * reporter in `reporters`, and the same lane named in both — and each of the
 * three fails in a way nothing would otherwise notice:
 *
 * - **`globalSetup` dropped, or pointed at `test/utils/global-setup.ts`.** The
 *   first disarms the watchdog silently. The second arms it *and* takes the
 *   machine-wide lock, which destroys the property the lock-free config exists
 *   for — a fix-agent fan-out running `npx jest` while an e2e run holds the
 *   lock. Both are one word in a JSON file.
 * - **`reporters` dropped.** The watchdog then polls a file nobody writes,
 *   prints its "no heartbeat of ours" line once, and stays inert forever. That
 *   line is the only symptom, and it is one line in a 27-second run.
 * - **The two lanes disagreeing.** The reporter is told its lane by
 *   `reporters`; the watchdog is told its lane by its `globalSetup`; nothing in
 *   jest's `globalConfig` can derive one from the other (`Lane` in
 *   `stall-watchdog.ts` says why). A disagreement is the inert case again.
 *
 * **Read off `package.json` rather than off jest's resolved config, and that is
 * the one difference from `harness-js-is-linted.spec.ts`**, which deliberately
 * asks ESLint what it resolved. Here the config *is* the artefact: there is no
 * second layer between the JSON and jest, `--showConfig` would hand back the
 * same three keys re-serialized, and a `globalSetup` that jest has already
 * resolved is a path — not the lane the module inside it arms. So the module is
 * required and **called**, with its two dangerous dependencies doubled, which
 * is the only way to observe the lane it passes and the lock it does not take.
 *
 * **The one double, and why it is the harness's own modules.** `./stall-watchdog`
 * is replaced so the lane argument can be read instead of a real five-minute
 * timer being armed inside a test worker, and `./test-postgres` is replaced so
 * that a `globalSetup` which *did* reach for the lock is caught here rather
 * than by actually taking the machine-wide lock from a unit run — which is the
 * hazard this file is about. §1.7 allows a `jest.mock` of a test util; these
 * are two of them, and the code under test is the shipped `package.json`.
 */

const backendRoot = join(__dirname, '..', '..');

/** The unit config, as jest reads it: `package.json`'s own `jest` key. */
interface UnitJestConfig {
  globalSetup?: string;
  globalTeardown?: string;
  reporters?: (string | [string, Record<string, unknown>])[];
}

function unitConfig(): UnitJestConfig {
  const parsed = JSON.parse(
    readFileSync(join(backendRoot, 'package.json'), 'utf8'),
  ) as { jest: UnitJestConfig };
  return parsed.jest;
}

/** `<rootDir>` is `backend/` for this config — its `rootDir` is `"."`. */
const resolveFromRoot = (value: string): string =>
  join(backendRoot, value.replace('<rootDir>/', ''));

/** The `[path, options]` entry for the heartbeat reporter, whatever its path. */
function heartbeatReporterEntry(): [string, Record<string, unknown>] {
  const entries: [string, Record<string, unknown>][] = (
    unitConfig().reporters ?? []
  ).map((entry) => (typeof entry === 'string' ? [entry, {}] : entry));
  const found = entries.find(([path]) =>
    path.endsWith('heartbeat-reporter.js'),
  );
  if (!found) {
    throw new Error(
      `no heartbeat reporter in package.json's jest.reporters: ${JSON.stringify(
        unitConfig().reporters,
      )}`,
    );
  }
  return found;
}

interface Armed {
  lane?: string;
  watch?: boolean;
}

interface Reached {
  /** Every `armStallWatchdog` call the configured `globalSetup` made. */
  armed: Armed[];
  /** Every `test-postgres` entry point it reached, in order. */
  postgres: string[];
}

/**
 * Run the `globalSetup` the unit config actually names, and report what it
 * reached.
 *
 * The two entry points doubled here are the ones that cost a *machine* rather
 * than a process: `acquireE2eLock` serializes every jest run on the box and
 * `startSharedPostgres` starts a container. Everything else in `test-postgres`
 * is passed through, so a `globalSetup` reaching for something not listed here
 * still runs it and still shows up as an unexpected `armed` shape.
 */
async function runConfiguredGlobalSetup(): Promise<Reached> {
  const reached: Reached = { armed: [], postgres: [] };
  const configured = unitConfig().globalSetup;
  if (!configured) {
    throw new Error("package.json's jest block sets no globalSetup");
  }

  let hook: ((globalConfig?: unknown) => unknown) | undefined;
  try {
    jest.isolateModules(() => {
      jest.doMock('./stall-watchdog', () => ({
        armStallWatchdog: (options: Armed = {}) => reached.armed.push(options),
      }));
      jest.doMock('./test-postgres', () => ({
        ...jest.requireActual<Record<string, unknown>>('./test-postgres'),
        acquireE2eLock: jest.fn(() => {
          reached.postgres.push('acquireE2eLock');
          return Promise.resolve();
        }),
        startSharedPostgres: jest.fn(() => {
          reached.postgres.push('startSharedPostgres');
          return Promise.resolve({ adminUrl: 'postgresql://unused' });
        }),
        createTemplateDatabase: jest.fn(() => {
          reached.postgres.push('createTemplateDatabase');
          return Promise.resolve();
        }),
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const module = require(resolveFromRoot(configured)) as {
        default: (globalConfig?: unknown) => unknown;
      };
      hook = module.default;
    });
  } finally {
    jest.dontMock('./stall-watchdog');
    jest.dontMock('./test-postgres');
  }

  // Called outside `isolateModules`, which takes a synchronous callback: an
  // `await` inside it would resolve after the isolated registry had been torn
  // down.
  await hook?.({});
  return reached;
}

describe("backend/package.json — the lock-free lane's stall watchdog", () => {
  /**
   * The regression: `globalSetup` gone, so nothing bounds a hung `npx jest`.
   * Asserted on the lane the module *passes*, not on the path the config names,
   * because a path is not evidence that anything was armed.
   */
  it('arms the watchdog on the unit lane, once', async () => {
    const { armed } = await runConfiguredGlobalSetup();

    expect(armed).toEqual([{ lane: 'unit', watch: false }]);
  });

  /**
   * The regression that matters more, because it is silent and expensive: the
   * unit config pointed at `test/utils/global-setup.ts`, which arms the same
   * watchdog and also takes the machine-wide lock and starts a container. The
   * lock-free claim in `docs/testing.md` is what a fix-agent
   * fan-out relies on, and nothing else in the tree observes it.
   */
  it('takes no machine-wide lock and starts no Postgres on the way', async () => {
    const { postgres } = await runConfiguredGlobalSetup();

    expect(postgres).toEqual([]);
  });

  /** A watch cycle is a person waiting; five minutes of it is not a stall. */
  it('goes inert under --watch and --watchAll rather than deadlining them', () => {
    const armed: Armed[] = [];
    jest.isolateModules(() => {
      jest.doMock('./stall-watchdog', () => ({
        armStallWatchdog: (options: Armed = {}) => armed.push(options),
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { default: hook } = require('./unit-global-setup') as {
        default: (globalConfig?: unknown) => void;
      };
      hook({ watch: true });
      hook({ watchAll: true });
    });
    jest.dontMock('./stall-watchdog');

    expect(armed.map((call) => call.watch)).toEqual([true, true]);
  });

  /**
   * The reporter is the other half: the watchdog polls a file only the reporter
   * writes, so a config that arms one without listing the other is inert.
   * `default` is asserted beside it because `reporters` *replaces* jest's list
   * rather than adding to it — dropping it would silence every `PASS` line in
   * the run.
   */
  it('lists the heartbeat reporter beside jest’s own default', () => {
    const { reporters } = unitConfig();

    expect(reporters?.[0]).toBe('default');
    expect(heartbeatReporterEntry()[0]).toBe(
      '<rootDir>/test/utils/heartbeat-reporter.js',
    );
  });

  /**
   * And the third edit: the lane the reporter writes and the lane the watchdog
   * reads are two independent spellings, and a disagreement is the inert case
   * with no symptom but one log line.
   */
  it('tells the reporter the same lane the globalSetup arms', async () => {
    const [, options] = heartbeatReporterEntry();
    const { armed } = await runConfiguredGlobalSetup();

    expect(options.lane).toBe(armed[0]?.lane);
  });

  /**
   * Why the lane exists at all. Both reporters key on `os.tmpdir()`, so one
   * shared filename would have a unit run overwrite a live e2e run's heartbeat
   * with its own pid — and the e2e watchdog, seeing a pid that is not its own,
   * would stop advancing its clock and fail the **healthy** run at five
   * minutes.
   */
  it('writes its heartbeat somewhere the e2e lane’s cannot be clobbered', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reporter = require('./heartbeat-reporter') as {
      HEARTBEAT_PATH: string;
      heartbeatPathFor: (lane?: string) => string;
      DEFAULT_LANE: string;
    };
    const [, options] = heartbeatReporterEntry();

    expect(reporter.heartbeatPathFor(options.lane as string)).not.toBe(
      reporter.HEARTBEAT_PATH,
    );
    expect(reporter.HEARTBEAT_PATH).toBe(
      reporter.heartbeatPathFor(reporter.DEFAULT_LANE),
    );
  });

  /**
   * The teardown is not symmetry for its own sake: `docs/testing.md`
   * tells a reader to `cat` the heartbeat when a run looks stuck, so a stale one
   * left behind by the previous run is a wrong answer rather than litter.
   */
  it('removes its own heartbeat when the run ends', () => {
    const { globalTeardown } = unitConfig();
    expect(globalTeardown).toBe('<rootDir>/test/utils/unit-global-teardown.ts');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { heartbeatPathFor } = require('./heartbeat-reporter') as {
      heartbeatPathFor: (lane?: string) => string;
    };
    const unlinked: string[] = [];
    jest.isolateModules(() => {
      jest.doMock('node:fs', () => ({
        ...jest.requireActual<typeof import('node:fs')>('node:fs'),
        unlinkSync: (path: string) => unlinked.push(path),
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { default: hook } = require(
        resolveFromRoot(globalTeardown as string),
      ) as { default: () => void };
      hook();
    });
    jest.dontMock('node:fs');

    expect(unlinked).toEqual([heartbeatPathFor('unit')]);
  });
});
