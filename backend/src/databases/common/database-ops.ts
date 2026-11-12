import { quote } from 'shell-quote';
import {
  presenceProbeCommand,
  readWorkloadPresence,
} from '../../common/workload-presence';
import type { WorkloadPresence } from '../../common/workload-presence';
import { systemSettleClock } from '../../compose/compose.utils';
import type { SettleClock } from '../../compose/compose.utils';
import { execOnServerStdout } from '../../remote/exec-dispatch';
import type { RemoteExecService } from '../../remote/remote-exec.service';

// Swarm-level operations on a managed database's service, issued over the
// exec layer on whichever server hosts the database.
//
// The single commands below pass argv, so the exec layer words them and this
// file quotes nothing. The guards that used to be the only thing
// making the bare interpolations safe are still true and still worth knowing —
// `appName` is held to `APP_NAME_REGEX` at its mint (`db/columns.ts`'s
// `cleanAppName`), `volumeName` is derived rather than supplied
// (`database-service.ts` passes `${appName}-data`; no route offers one), and
// `replicas` is the literal union `0 | 1` — but they are no longer what stands
// between a stored value and the shell. The presence probe stays a string
// because it is a shell program (see below), and a shell program's
// interpolations are its builder's to `quote()` — so its `appName` is now
// quoted *as well as* guarded (§2.9, H-92). It was guarded only, which took the
// probe out of `APP_NAME_REGEX`'s defence-in-depth and made the charset the one
// thing standing there; that bet has been wrong three times in this tree
// (H-12, and H-21 live).
//
// Everything here runs on the database's server: remote over SSH, local
// otherwise. The `serverId` decides the machine for every command, the presence
// read included — reading one machine's daemon to authorize an operation on
// another is what ADR-0008's "labels are read on the machine being addressed"
// bullet forbids. `execOnServerStdout` (`remote/exec-dispatch.ts`) is that
// dispatch and the `.stdout` projection both, shared rather than re-kept here.

/**
 * How a scale returns. Attached — the CLI's default, and every console
 * route's — `docker service scale` waits for the tasks to converge before it
 * exits. `detach` returns as soon as Swarm has the new replica count, which is
 * what the MCP `start_service`/`stop_service` tools ask for: a tool answers
 * inside the dispatcher's deadline and the agent polls the status instead.
 */
export interface ScaleOptions {
  readonly detach?: boolean;
}

/** `docker service scale` to 1 (start) or 0 (stop). */
export const scaleDatabaseService = async (
  remoteExec: RemoteExecService,
  serverId: string | null,
  appName: string,
  replicas: 0 | 1,
  { detach = false }: ScaleOptions = {},
): Promise<void> => {
  await execOnServerStdout(remoteExec, serverId, [
    'docker',
    'service',
    'scale',
    ...(detach ? ['--detach'] : []),
    `${appName}=${replicas}`,
  ]);
};

/** Drops the swarm service; its volumes survive unless removed explicitly. */
export const removeDatabaseService = async (
  remoteExec: RemoteExecService,
  serverId: string | null,
  appName: string,
): Promise<void> => {
  await execOnServerStdout(remoteExec, serverId, [
    'docker',
    'service',
    'rm',
    appName,
  ]);
};

/** Drops a data volume, once — a rebuild goes through
 * {@link removeDatabaseVolumeWhenReleased}, which waits for it to be free. */
const removeDatabaseVolume = async (
  remoteExec: RemoteExecService,
  serverId: string | null,
  volumeName: string,
): Promise<void> => {
  await execOnServerStdout(remoteExec, serverId, [
    'docker',
    'volume',
    'rm',
    volumeName,
    '--force',
  ]);
};

/** How long a rebuild waits for a removed service's task to let go of its
 * volume. Swarm's default stop grace is 10 s before it kills a task, and the
 * measured release on a live host was about 13 s, so a minute is room
 * for a slow checkpoint without leaving a request hanging indefinitely. */
export const VOLUME_RELEASE_TIMEOUT_MS = 60_000;
/** How often the holders are read while waiting. */
export const VOLUME_RELEASE_POLL_MS = 1_000;

/**
 * The injection token each engine module binds to the system clock, for
 * {@link removeDatabaseVolumeWhenReleased}'s wait.
 *
 * A provider only so a suite can exhaust the whole minute in microseconds —
 * `compose.utils.ts`'s `COMPOSE_SETTLE_CLOCK` is the same seam for the same
 * reason, and its `SettleClock` shape is reused rather than restated. The
 * product has exactly one clock and no route chooses it.
 */
export const DATABASE_VOLUME_RELEASE_CLOCK = 'DATABASE_VOLUME_RELEASE_CLOCK';

/** {@link DATABASE_VOLUME_RELEASE_CLOCK} bound to the system clock, as each of
 * the six engine modules provides it. */
export const volumeReleaseClockProvider = {
  provide: DATABASE_VOLUME_RELEASE_CLOCK,
  useValue: systemSettleClock,
};

/** The volume was still held when {@link removeDatabaseVolumeWhenReleased}
 * stopped waiting. `holders` are the container ids that held it last. */
export class VolumeStillInUseError extends Error {
  /** The clause both this error's message and the rebuild's 409 are built
   * on, so the two cannot word the same fact differently. */
  readonly reason: string;

  constructor(
    readonly volumeName: string,
    readonly holders: string[],
  ) {
    const reason = `still in use by ${holders.join(', ') || 'a container'} after ${VOLUME_RELEASE_TIMEOUT_MS / 1000} seconds`;
    super(`${volumeName} was ${reason}`);
    this.name = 'VolumeStillInUseError';
    this.reason = reason;
  }
}

/** Docker's refusal to remove a volume a container still mounts. */
const VOLUME_IN_USE_REFUSAL = /volume is in use/i;

/**
 * The containers, running or stopped, that still mount `volumeName`.
 *
 * `-a` because a stopped container holds its volumes too — measured: `docker
 * volume rm --force` refuses `volume is in use` for an exited container until
 * it is removed. The `volume=` filter matches a volume by its exact name (and
 * by a mount destination, which only a value starting with `/` can be).
 */
const volumeHolders = async (
  remoteExec: RemoteExecService,
  serverId: string | null,
  volumeName: string,
): Promise<string[]> =>
  (
    await execOnServerStdout(remoteExec, serverId, [
      'docker',
      'ps',
      '-a',
      '-q',
      '--filter',
      `volume=${volumeName}`,
    ])
  )
    .split(/\s+/)
    .filter(Boolean);

/**
 * Drops a data volume once nothing holds it — the rebuild's destructive step.
 *
 * `docker service rm` returns as soon as the service is deleted, while its
 * task container is still stopping — for Postgres, through a shutdown
 * checkpoint — so a `docker volume rm` straight after it meets `volume is in
 * use`, and `--force` does not override that. So this polls
 * {@link volumeHolders} until it is empty, then removes, and treats an `in use`
 * refusal from the removal itself as one more reason to wait rather than as
 * the answer. Any other refusal is Docker's answer and is rethrown; a deadline
 * turns the wait into a {@link VolumeStillInUseError}.
 *
 * A volume that is already gone is fine: `docker volume rm --force` exits 0
 * for one, which is what lets a retry finish a half-done rebuild.
 */
export const removeDatabaseVolumeWhenReleased = async (
  remoteExec: RemoteExecService,
  serverId: string | null,
  volumeName: string,
  clock: SettleClock,
): Promise<void> => {
  const deadline = clock.now() + VOLUME_RELEASE_TIMEOUT_MS;
  for (;;) {
    let holders = await volumeHolders(remoteExec, serverId, volumeName);
    if (holders.length === 0) {
      try {
        await removeDatabaseVolume(remoteExec, serverId, volumeName);
        return;
      } catch (error) {
        const stderr = (error as { stderr?: string }).stderr ?? '';
        if (!VOLUME_IN_USE_REFUSAL.test(stderr)) throw error;
        holders = [...stderr.matchAll(/\[([^\]]+)\]/g)].flatMap(([, ids]) =>
          ids.split(/[\s,]+/).filter(Boolean),
        );
      }
    }
    if (clock.now() >= deadline) {
      throw new VolumeStillInUseError(volumeName, holders);
    }
    await clock.sleep(VOLUME_RELEASE_POLL_MS);
  }
};

/**
 * The twin of `applications/application-ops.ts`'s `applicationServicePresence`,
 * kept apart for the reason this file's header already gives: an Application
 * must not depend on the databases module to be startable. Only the
 * three-valued type is shared, and only as a `import type` — it carries no
 * runtime coupling, and two copies of one union would drift.
 *
 * `RemoteExecService` rejects on a non-zero exit, so a plain try/catch cannot
 * separate "no such service" from "cannot reach the daemon". All three answers
 * are therefore decided **in the shell**, by {@link presenceProbeCommand}, which
 * owns the shape and the reason for it — not here, because the sentence this
 * docblock used to carry ("only a genuinely unreachable daemon can make the exec
 * itself reject") was false in exactly the way that costs a row: `||` swallows
 * `Cannot connect to the Docker daemon` like any other non-zero exit, so a
 * stopped or wedged daemon printed `absent` at exit 0 (H-95). The probe now
 * asks the daemon whether it is there first. Do not collapse its three branches
 * into two.
 */
export const databaseServicePresence = (
  remoteExec: RemoteExecService,
  serverId: string | null,
  appName: string,
): Promise<WorkloadPresence> =>
  readWorkloadPresence(() =>
    execOnServerStdout(
      remoteExec,
      serverId,
      presenceProbeCommand({
        workloadPresent: `docker service inspect ${quote([appName])} >/dev/null 2>&1`,
      }),
    ),
  );

/**
 * Whether a deleted database's data volume is still on its Server:
 * `true` when it is, `false` only when the Server positively says it is not,
 * `null` when that cannot be known.
 *
 * The volume is created by the first deploy and Delete deliberately keeps it,
 * so a database that was never deployed has none — and the console used to
 * tell its operator to `docker volume rm` a volume that was never there. The
 * row cannot answer this: a database writes no Deployment rows, and `stopped`
 * separates a stop from a never-deployed `idle` but says nothing about
 * a row that was deployed, stopped and then deployed again. The Server can.
 *
 * **A volume is node-local**, and a database's task can run on any manager,
 * or on a worker under a `placementSwarm` override — so `docker volume inspect`
 * on the addressed Server speaks for the whole swarm only when the swarm is
 * that one node. That condition is folded into the reachability question, so
 * a multi-node swarm answers `unknown` (here `null`) rather than an `absent`
 * that could tell an operator their data is gone when it is on another node.
 * The cost is that a volume present on a multi-node manager also reads `null`;
 * `null` is the honest direction to err in.
 *
 * Read through {@link presenceProbeCommand} for the reason that builder
 * exists: the docker CLI exits 1 for "no such volume" and for "cannot connect
 * to the daemon" alike, so the answer is decided in the shell.
 */
export const databaseVolumeLeftBehind = async (
  remoteExec: RemoteExecService,
  serverId: string | null,
  volumeName: string,
): Promise<boolean | null> => {
  const presence = await readWorkloadPresence(() =>
    execOnServerStdout(
      remoteExec,
      serverId,
      presenceProbeCommand({
        // Grouped: the builder writes `if ! <this>`, and a bare `!` negates
        // only the first command of an `&&` list — measured, that read a
        // multi-node swarm and a dead daemon as `absent`.
        daemonReachable: `{ docker version >/dev/null 2>&1 && [ "$(docker info --format '{{.Swarm.Nodes}}' 2>/dev/null)" = 1 ]; }`,
        workloadPresent: `docker volume inspect ${quote([volumeName])} >/dev/null 2>&1`,
      }),
    ),
  );
  return presence === 'unknown' ? null : presence === 'present';
};
