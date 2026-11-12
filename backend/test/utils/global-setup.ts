import {
  acquireE2eLock,
  releaseE2eLock,
  ADMIN_URL_ENV,
  TEMPLATE_ENV,
  TEMPLATE_DB,
  createTemplateDatabase,
  rememberSharedPostgres,
  startSharedPostgres,
} from './test-postgres';
import { separatePlatformRoot } from './platform-root';
import { armStallWatchdog } from './stall-watchdog';

/**
 * One Postgres server for the whole `jest` invocation, built once here.
 *
 * Before this existed, `startTestDb` started a container per suite: 100 e2e
 * files meant 100 `postgres:17-alpine` containers and 100 replays of `drizzle/`,
 * `maxWorkers` of them alive at a time. On a 16 GB machine whose Docker VM
 * holds 8 GB of that, the container side and the worker side competed for the
 * same RAM and the run went to swap.
 *
 * The env vars are the channel to the workers: `globalSetup` runs in the main
 * process before any worker is forked, so what it puts on `process.env` is
 * inherited by every one of them.
 */
export default async function globalSetup(globalConfig?: {
  watch?: boolean;
  watchAll?: boolean;
}): Promise<void> {
  // The platform host's root and a Server's are two values in every run, so a
  // suite that confuses them reds instead of passing on the coincidence.
  // Through the same `process.env` channel as the Postgres URL below.
  separatePlatformRoot();

  // Before the container, not after: the lock exists to stop a second server
  // being started at all, so taking it late would be taking it too late.
  await acquireE2eLock();
  try {
    const shared = await startSharedPostgres();
    rememberSharedPostgres(shared);
    await createTemplateDatabase(shared.adminUrl);

    process.env[ADMIN_URL_ENV] = shared.adminUrl;
    process.env[TEMPLATE_ENV] = TEMPLATE_DB;

    // After the server, so a hang while *starting* Postgres is still the
    // container's own timeout to report, and before any worker is forked, which
    // is the only moment this process is guaranteed to reach. See
    // `armStallWatchdog` for why the deadline lives here rather than in the
    // `test:e2e` script.
    //
    // No `lane`: these two configs are the `e2e` lane, which is the default and
    // is what keeps their heartbeat path where `docs/testing.md`
    // says it is. The `watch` flag is jest's own — passed for the same reason
    // the unit lane passes it, even though neither Docker config has a watch
    // script, because `--watch` is a flag and not a script.
    armStallWatchdog({
      watch: Boolean(globalConfig?.watch || globalConfig?.watchAll),
    });
  } catch (error) {
    // jest runs no `globalTeardown` for a `globalSetup` that threw, so the
    // release has to happen here or the lock outlives the failure and wedges
    // the next run on this machine.
    releaseE2eLock();
    throw error;
  }
}
