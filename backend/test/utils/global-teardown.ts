import { unlinkSync } from 'node:fs';
import {
  dropTemplateDatabase,
  recallSharedPostgres,
  releaseE2eLock,
} from './test-postgres';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { HEARTBEAT_PATH } = require('./heartbeat-reporter') as {
  HEARTBEAT_PATH: string;
};

/**
 * Stop the shared server, or — when the run borrowed one via
 * `TEST_POSTGRES_URL` — leave it running and take only the template back off
 * it, since that server was not ours to stop.
 */
export default async function globalTeardown(): Promise<void> {
  try {
    const shared = recallSharedPostgres();
    if (!shared) return;

    if (shared.container) {
      await shared.container.stop();
      return;
    }
    await dropTemplateDatabase(shared.adminUrl);
  } finally {
    // In a `finally` because a teardown that throws while holding the lock
    // would leave every later run on this machine waiting on a dead pid.
    releaseE2eLock();
    // The heartbeat is only interesting while a run is in flight, and a stale
    // one left in `$TMPDIR` would make the next reader's `stat` describe the
    // previous run. A hang deliberately leaves it behind: that is the
    // one case where somebody wants to read it afterwards.
    try {
      unlinkSync(HEARTBEAT_PATH);
    } catch {
      // Never written (a run with no reporters), or already gone.
    }
  }
}
