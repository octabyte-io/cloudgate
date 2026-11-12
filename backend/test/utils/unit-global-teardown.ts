import { unlinkSync } from 'node:fs';
import { UNIT_LANE } from './unit-global-setup';

// Required rather than imported, for the reason `stall-watchdog.ts` gives: the
// reporter is CommonJS loaded by jest's own `require` in this same process.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { heartbeatPathFor } = require('./heartbeat-reporter') as {
  heartbeatPathFor: (lane?: string) => string;
};

/**
 * Removes the lock-free lane's heartbeat, and that is the whole of it.
 *
 * This exists because `global-teardown.ts` does the same thing for the `e2e`
 * lane and for the same reason: *"the heartbeat is only interesting while a run
 * is in flight, and a stale one left in `$TMPDIR` would make the next reader's
 * `stat` describe the previous run"*. Without it every `npx jest` would leave a
 * `cloudgate-unit-heartbeat.json` behind, and `docs/testing.md`
 * tells a reader to `cat` that file when a run looks stuck — so a stale one is
 * not litter, it is a wrong answer to the one question the file answers.
 *
 * **A hang deliberately keeps its heartbeat**, here as there: `armStallWatchdog`
 * exits the process from its own timer, jest runs no `globalTeardown` after
 * that, and the file is then the only record of what was in flight.
 *
 * It shares nothing with `global-teardown.ts` on purpose. That one drops the
 * template database, stops the container and releases the machine-wide lock —
 * the three things this lane must never do, which is `unit-global-setup.ts`'
 * argument in the other direction.
 */
export default function unitGlobalTeardown(): void {
  try {
    unlinkSync(heartbeatPathFor(UNIT_LANE));
  } catch {
    // Never written (a run with no reporters), or already gone.
  }
}
