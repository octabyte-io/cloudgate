/**
 * The retention ceiling Cloudgate puts on every container it creates.
 *
 * Nothing in the tree set `HostConfig.LogConfig` or a Swarm `LogDriver`, and
 * nothing configured a daemon default, so every container Cloudgate started ran
 * on Docker's stock `json-file` driver with no `max-size` and no `max-file` —
 * i.e. unbounded. That cost nothing while Traefik was silent; now
 * Traefik's own log is on at INFO, and an ACME retry loop against a misconfigured
 * domain is exactly the shape that writes continuously. The failure mode is a
 * full disk on the platform host, which takes down every workload on it rather
 * than only the noisy one.
 *
 * **Per container, not `/etc/docker/daemon.json`.** The daemon file is the
 * operator's; an installer that rewrites it is intrusive and cannot be undone
 * without knowing what was there before. A `LogConfig` travels with the thing
 * Cloudgate actually owns. Reversing this was considered — a daemon default
 * would have caught the compose containers it found uncapped — and rejected it
 * on the same grounds, then closed the gap by injection instead. Do not
 * re-litigate it.
 *
 * **`json-file` and not `local`.** `local` compresses and would hold more
 * history per byte, but `docker logs` is the interface the acceptance command
 * assumes and every operator reaches for; `json-file` is what a stock daemon
 * reads, so keeping the driver stock is what keeps that interface working.
 *
 * 10m × 3 is 30 MB per container: enough to hold a meaningful window of an ACME
 * loop, small enough that a hundred containers cannot fill a modest host. The
 * cost is that an old failure can age out of `docker logs` before anyone looks,
 * which is the trade the size is chosen to make unlikely.
 *
 * Functions rather than constants, and `deploy/install.sh` carries the same two
 * defaults as `${CONTAINER_LOG_MAX_SIZE:-10m}`-style knobs and writes them into
 * the backend's env file: §2.8's rule is that a value computed at import time
 * silently misses a `.env` entry, and these are read on every container create.
 *
 * **The grep is not the list, and reading it as one is how the cap lost a whole
 * category of container for a wave**. `grep -rn
 * 'createService\|createContainer' backend/src` names only the sites that
 * create a container **through the Docker API**, and there are three kinds of
 * create site, not one:
 *
 *   1. **Through the Docker API — seven sites**, all reading `containerLogConfig`
 *      or `serviceLogDriver`: `settings/traefik-setup.service.ts` twice (a plain
 *      container and a Swarm service — the two shapes are why both helpers
 *      exist, and it is two of the seven even though it is one file),
 *      `deployment-engine/mechanize.ts` for an Application,
 *      `cron-services/swarm-cron-run-place.ts` for a Cron service's run job, whose
 *      settings `buildRunJobSettings` takes from `buildServiceSettings`,
 *      `databases/common/database-spec.ts` for all six database engines, and
 *      `enterprise/forward-auth/forward-auth-proxy.service.ts`.
 *   2. **Through a provisioning shell script — two**, `serverSetupCommand` and
 *      `deploy/install.sh`, both through `containerLogRunFlags`.
 *   3. **Through an Organization's own compose file** — every container
 *      `docker compose up` or `docker stack deploy` creates from a compose
 *      stack. These are invisible to the grep by construction, and they ran on
 *      Docker's stock unbounded driver until they were capped by the
 *      `logging:` block `compose/compose-file.ts`'s `applyComposeDefaults`
 *      injects into the **converted** compose file, for both compose types.
 *      That injection accepts one residual deliberately — a service that
 *      declares its own `logging:` keeps it whole, an unbounded one included,
 *      because presence of the key is the author's statement and a merged block
 *      would half-override a driver they chose on purpose.
 *
 *      **"Every container" means every command that creates one from that file,
 *      and there are two of them** (H-98). A deploy writes the converted file
 *      and runs `up`/`stack deploy` over it (`getBuildComposeCommand`), and
 *      `POST /compose/:id/start` runs `docker compose up -d` over the copy
 *      already on disk (`composeStartCommand`) — which for every stack deployed
 *      before the cap was a file carrying neither key, so Start created uncapped,
 *      unrestarted containers from it for a whole wave. Start therefore
 *      re-applies the defaults to that file first. A third command that brings a
 *      compose stack up has to do the same; the grep above cannot see any of
 *      them, and `test/common/container-logs.spec.ts` asserts the *set* of
 *      `up`/`stack deploy` sites for that reason.
 *
 * A fourth kind is out of reach of all three: anything an Organization's own container
 * starts by talking to the Docker socket itself.
 *
 * Adding an API create site without one of these helpers puts an unbounded log
 * driver back on the platform host, and nothing catches it — the specs that
 * assert this cap are all per-call-site, so a *missing* site is asserted by no
 * one. `backend/test/common/container-logs.spec.ts` is the meta-test that reads
 * `backend/src` off disk and closes that hole.
 */

/** Docker's default driver, and the only one `docker logs` reads directly. */
export const CONTAINER_LOG_DRIVER = 'json-file';

/** Bytes per log file before Docker rotates it. */
export const DEFAULT_CONTAINER_LOG_MAX_SIZE = '10m';

/** How many rotated files Docker keeps, the current one included. */
export const DEFAULT_CONTAINER_LOG_MAX_FILE = '3';

/** The `json-file` driver's two options, as Docker spells them. */
export function containerLogOptions(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    'max-size':
      env.CONTAINER_LOG_MAX_SIZE?.trim() || DEFAULT_CONTAINER_LOG_MAX_SIZE,
    'max-file':
      env.CONTAINER_LOG_MAX_FILE?.trim() || DEFAULT_CONTAINER_LOG_MAX_FILE,
  };
}

/** Dockerode's `HostConfig.LogConfig`, for a plain container. */
export function containerLogConfig(env: NodeJS.ProcessEnv = process.env): {
  Type: string;
  Config: Record<string, string>;
} {
  return { Type: CONTAINER_LOG_DRIVER, Config: containerLogOptions(env) };
}

/**
 * Dockerode's `TaskTemplate.LogDriver`, for a Swarm service.
 *
 * The same values under different keys — Swarm's spec says `Name`/`Options`
 * where a container's says `Type`/`Config` — which is why both shapes are
 * derived from one `containerLogOptions()` rather than written out twice.
 */
export function serviceLogDriver(env: NodeJS.ProcessEnv = process.env): {
  Name: string;
  Options: Record<string, string>;
} {
  return { Name: CONTAINER_LOG_DRIVER, Options: containerLogOptions(env) };
}

/**
 * The same cap as `docker run` flags, for the two provisioning shell scripts
 * (`serverSetupCommand` here, `deploy/install.sh` on the platform host). Emitted
 * rather than hardcoded in the script so the three writers of the Traefik
 * container cannot disagree about the ceiling the way they once disagreed about
 * its version.
 */
export function containerLogRunFlags(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const options = containerLogOptions(env);
  return [
    `--log-driver ${CONTAINER_LOG_DRIVER}`,
    ...Object.entries(options).map(
      ([name, value]) => `--log-opt ${name}=${value}`,
    ),
  ];
}
