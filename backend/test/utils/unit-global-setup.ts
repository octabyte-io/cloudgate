import { separatePlatformRoot } from './platform-root';
import { armStallWatchdog } from './stall-watchdog';

/**
 * The lock-free lane's name, and the one place it is spelled in code.
 *
 * `package.json`'s `reporters` entry spells it a second time, in JSON, because
 * that is the only channel a jest config has into a reporter — the cost is
 * argued at `Lane` in {@link armStallWatchdog}'s file, and
 * `unit-lane-watchdog.spec.ts` holds the two equal.
 */
export const UNIT_LANE = 'unit';

/**
 * Arms the stall watchdog for `npx jest`, and separates the platform
 * host's root from a Server's. Nothing else.
 *
 * **What broke first.** `package.json`'s `jest` block set no `globalSetup` and
 * no `reporters`, so `armStallWatchdog` was never armed for the config every
 * agent runs most often. A hung unit run — every spec on the lock-free lane,
 * most of them building a Nest module graph — was therefore unbounded and
 * silent, with not even a heartbeat file to inspect from another shell. The
 * file count that used to sit in that clause is deliberately gone: it
 * was written as 205, went stale twice inside one batch, and carried no weight
 * the words do not — `docs/testing.md` is where a *dated*
 * measurement of this lane belongs and says so. `testTimeout` is not the
 * backstop it looks like: it is a timer *inside* the worker, so it bounds a
 * worker that is running and says nothing about one that has stopped being
 * scheduled, which is exactly the argument `DEFAULT_STALL_MS`' docblock makes
 * and exactly the hole the watchdog closed for the Docker configs.
 *
 * **Why this file exists rather than a second `preset` line.** The unit config
 * must stay **lock-free** — no Postgres, no container, no machine-wide lock —
 * because that property is what lets a fix-agent fan-out run `npx jest` while
 * an e2e run holds the lock, and `docs/testing.md` states it as a
 * measured fact. `test/utils/global-setup.ts` cannot be reused for that reason
 * and that reason only: its first statement is `acquireE2eLock()` and its
 * second is `startSharedPostgres()`. What the unit lane needs is the *hook*,
 * which is free; what it must not have is the Postgres the hook happens to
 * start on the other two configs. So the hook is duplicated and the Postgres is
 * not, which is the smallest split that keeps both facts true. Putting the unit
 * config on `test/jest-preset.js` would have inherited the lock — jest has no
 * way to take part of a preset — and is why `backend/README.md` records the
 * five keys that config still spells twice.
 *
 * **Rejected: wrapping the script in `timeout 300 jest`.** `scripts.test` is
 * not how this config is invoked. `docs/testing.md` tells a reader
 * to run `npx jest` and `npx jest --runTestsByPath <path>`, and that is what
 * every agent's wrapper script does, so a deadline on the npm script would have
 * covered almost nobody — the same objection the watchdog ticket raised against putting
 * `--forceExit` in `test:e2e`. A `globalSetup` covers every invocation of the
 * config, which is the unit of coverage that matters.
 *
 * **The root is this lane's for the same reason it is the Docker lanes'.**
 * An audit found suites on this config green only because `CLOUDGATE_DIRECTORY`
 * was unset and the two roots were one string; `platform-root.ts` says why the
 * run sets it, and the call is a single environment assignment, so it costs
 * this lane neither its lock-free property nor its start-up time.
 *
 * Nothing here is `async` and nothing here awaits: the whole body is one
 * environment assignment and arming one `unref`ed timer, so this hook cannot be
 * the reason a run is slow to start.
 */
export default function unitGlobalSetup(globalConfig?: {
  watch?: boolean;
  watchAll?: boolean;
}): void {
  separatePlatformRoot();
  armStallWatchdog({
    lane: UNIT_LANE,
    // This config is the one with a `test:watch` script and a `test:debug`
    // script, so it is the one where a five-minute deadline would have killed a
    // person rather than a hang. `armStallWatchdog` argues both.
    watch: Boolean(globalConfig?.watch || globalConfig?.watchAll),
  });
}
