import * as path from 'node:path';

import { REMOTE_CLOUDGATE_DIRECTORY } from '../../src/common/config/cloudgate-directory';

/**
 * The platform host's root every test lane runs under.
 *
 * **What it is for.** The platform tree has two roots — this process's
 * `CLOUDGATE_DIRECTORY` and the `/etc/cloudgate` literal on every Server
 * (`common/config/cloudgate-directory.ts`) — and with the variable unset they
 * are the same string. So a test that wrote `/etc/cloudgate` where it meant
 * the platform host's root read exactly like one that meant a Server's, and
 * nothing could tell the two apart. An audit measured what that hid: under a
 * relocated root, **13 e2e suites and 12 unit suites** went red, every failure
 * a test spelling the literal where the product had correctly produced the
 * configured root. Once the two roots differ, that confusion reds by
 * construction.
 *
 * **A fixed path nothing creates, rather than a temp directory.** Neither this
 * nor `/etc/cloudgate` exists on a developer's machine, and an unprivileged
 * runner can write to neither, so a suite that reaches the real filesystem
 * under the local root fails or succeeds exactly as it did under the default.
 * A writable temp directory would have changed that, and the change would have
 * been a second, unmeasured one riding on this. The suites that genuinely need
 * a writable local root (`*-roots.e2e-spec.ts`) already make their own and put
 * this value back afterwards.
 */
export const TEST_PLATFORM_ROOT = '/var/lib/cloudgate-test-platform-root';

/**
 * Makes the platform host's root differ from a Server's for the rest of the
 * run, and returns the root it settled on.
 *
 * **A value already set that differs from the Server's root is kept.** That is
 * what lets that reproduction run under a root of its own choosing, and what
 * lets a second value catch an expectation that was hand-set to this one
 * rather than taken from the machine. **A value equal to the Server's root is
 * replaced**: it is the coincidence this exists to remove, and it matters just
 * as much when someone set it deliberately.
 *
 * Called from every lane's `globalSetup`, which runs in jest's main process
 * before any worker is forked — the same channel `global-setup.ts` uses to hand
 * the workers the shared Postgres.
 */
export function separatePlatformRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.CLOUDGATE_DIRECTORY?.trim();
  if (!configured || path.resolve(configured) === REMOTE_CLOUDGATE_DIRECTORY) {
    env.CLOUDGATE_DIRECTORY = TEST_PLATFORM_ROOT;
    return TEST_PLATFORM_ROOT;
  }
  return configured;
}
