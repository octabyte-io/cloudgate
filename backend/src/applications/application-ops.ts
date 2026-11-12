import path from 'node:path';

import { quote } from 'shell-quote';

import { runTeardownSteps } from '../common/teardown-steps';
import type {
  TeardownStep,
  UnreclaimedArtifact,
} from '../common/teardown-steps';
import {
  presenceProbeCommand,
  readWorkloadPresence,
} from '../common/workload-presence';
import type { WorkloadPresence } from '../common/workload-presence';
import { buildHostServerId } from '../deployment-engine/build-host';
import { applicationsDirectoryOn } from '../deployment-engine/deployment-engine.paths';
import { execOnServerStdout } from '../remote/exec-dispatch';
import type { ReachabilityMemo } from '../remote/reachability-memo';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { dynamicTraefikConfigPath } from '../traefik/traefik-writer.service';
import type { TraefikWriterService } from '../traefik/traefik-writer.service';

// Swarm-level operations on an Application's service, issued over the exec
// layer on whichever server runs the Application.
// `databases/common/database-ops.ts` is the same three commands for managed
// databases — kept apart rather than shared because an Application must not
// depend on the databases module to be startable.
//
// Everything here runs on the Application's server: remote over SSH, local
// otherwise. The `serverId` decides the machine for every command, including the
// presence read — reading one machine's daemon to authorize an operation on
// another is what ADR-0008's "labels are read on the machine being addressed"
// bullet forbids. `execOnServerStdout` (`remote/exec-dispatch.ts`) is that
// dispatch and the `.stdout` projection both, shared rather than re-kept here.
//
// Argv (`string[]`) for the three single commands, so `appName` and `directory`
// arrive as one word each without this file quoting them; a `string` for
// the presence probe, which is a shell program rather than a command — and a
// shell program's interpolations are its builder's to `quote()`, which is why
// the probe below does (§2.9, H-92). `APP_NAME_REGEX` stands behind that
// quoting, not in place of it: a charset enforced in another module is what
// H-12, an earlier fix and H-21 each got wrong, the last of them live.

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
export const scaleApplicationService = async (
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

/**
 * The Swarm service ID the Application runs as now, or none when there is no
 * service to read: whose running tasks' cards a Start or Restart
 * counts as its own. A read that fails is answered as none, which counts no
 * card as its own — the stricter answer, never a looser one.
 */
export const applicationServiceId = async (
  remoteExec: RemoteExecService,
  serverId: string | null,
  appName: string,
): Promise<string | null> => {
  try {
    const id = await execOnServerStdout(remoteExec, serverId, [
      'docker',
      'service',
      'inspect',
      '--format',
      '{{.ID}}',
      appName,
    ]);
    return id.trim() || null;
  } catch {
    return null;
  }
};

/** Drops the Application's swarm service. Its volumes survive. */
export const removeApplicationService = async (
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

/**
 * Drops the Application's directory — its cloned source and build tree — on
 * whichever host built it. Docker volumes are not in it and survive, which is
 * `CONTEXT.md`'s **Delete**: the record, the containers, the network and the
 * project directory, volumes only on request.
 */
export const removeApplicationDirectory = async (
  remoteExec: RemoteExecService,
  serverId: string | null,
  directory: string,
): Promise<void> => {
  await execOnServerStdout(remoteExec, serverId, ['rm', '-rf', directory]);
};

/**
 * {@link removeApplicationDirectory} as the teardown step a delete can report
 * on.
 *
 * All three deletes that remove a source tree — `ApplicationsService.remove`,
 * `common/service-cascade.ts`'s cascade and `preview-teardown.ts` — build the
 * identical step: this command on the build host, and this directory named if
 * it fails. `common/teardown-steps.ts` carries the argument for why *this* step
 * is the one with a `leftBehindOnFailure` and the other two have none.
 *
 * `serverId` here is the **build host** ({@link buildHostServerId}), not the
 * Application's run Server, and the three callers are where that is decided;
 * this only makes sure the machine that was asked is the machine the report
 * names, so a wrong-machine call cannot answer with the right one.
 */
export const removeApplicationDirectoryStep = (
  remoteExec: RemoteExecService,
  serverId: string | null,
  appName: string,
  directory: string,
): TeardownStep => ({
  run: () => removeApplicationDirectory(remoteExec, serverId, directory),
  leftBehindOnFailure: {
    kind: 'source-tree',
    appName,
    serverId,
    path: directory,
  },
});

/**
 * Drops an Application's own directory, `{applicationsDirectoryOn(buildHost)}/
 * {appName}`, and answers with it if it could not —
 * `compose/compose-directory.ts`'s `reclaimComposeDirectory` for an
 * Application.
 *
 * One helper for the two deletes that run it after the refusal,
 * `ApplicationsService.remove` and `common/service-cascade.ts`'s
 * `reclaimServiceDirectories`, so the two cannot drift on which host it goes
 * to. That is the build host ({@link buildHostServerId}), which roots the
 * path as well as receiving the command: the engine clones there, and a
 * removal aimed at the run Server on a dedicated-build-Server install exits
 * non-zero and leaves the tree.
 */
export const reclaimApplicationDirectory = (
  remoteExec: RemoteExecService,
  row: {
    appName: string;
    serverId: string | null;
    buildServerId?: string | null;
  },
): Promise<UnreclaimedArtifact[]> => {
  const buildHost = buildHostServerId(row);
  return runTeardownSteps([
    removeApplicationDirectoryStep(
      remoteExec,
      buildHost,
      row.appName,
      path.posix.join(applicationsDirectoryOn(buildHost), row.appName),
    ),
  ]);
};

/**
 * Removing the Traefik dynamic config that routes at this Application, as the
 * teardown step a delete can report on.
 *
 * Beside {@link removeApplicationDirectoryStep} because both Application
 * deletes — `ApplicationsService.remove` and `common/service-cascade.ts`'s
 * cascade — build the identical *pair*, and because two step builders that
 * carry a `leftBehindOnFailure` sitting next to each other is what stops the
 * third being written twice again: an earlier change collapsed three copies of the
 * best-effort loop for that reason and left this artifact behind, whereupon the
 * two call sites kept two copies of the comment explaining an empty `catch`
 * that was wrong about it.
 *
 * **`serverId` is the run Server, and unlike the directory's that was never in
 * doubt.** Traefik's file provider watches the machine the workload runs on
 * (`application-ops.ts`'s own head, and `buildHostServerId`'s note that a
 * build-host rule *"deliberately does not decide where the workload runs"*), so
 * this step and the `docker service rm` above it take the same id and the
 * `rm -rf` does not. The report names whichever machine was asked, from the
 * writer's own path expression, so it cannot claim a file on a host the
 * removal never reached.
 *
 * **Why it reports at all** — the presence read is
 * {@link applicationServicePresence} on that same run Server, which asks the
 * daemon about one Swarm service. It says nothing about a file, so a transport
 * failure, a permission the SSH user does not have or a read-only mount was
 * caught by the best-effort `catch`, discarded, and named nowhere: the delete
 * answered a clean 200 leaving a router fragment that keeps a public hostname
 * advertised at a backend that no longer exists. `common/teardown-steps.ts`
 * carries the rest of the argument, including why an idempotent `rm -f` needs
 * no probe to know that a failure means *may still exist*.
 *
 * **`reachability` is the Delete's memo**. An injected writer dials
 * through its own `RemoteExecService`, so without it this would be the one
 * step that dialled an already-unreachable Server again; guarded, it fails at
 * once with the error that marked the Server, and still reports the file.
 * `preview-teardown.ts` passes none because its writer is built on the exec
 * layer it was handed, which is already the memo when a Delete called it.
 */
export const removeTraefikConfigStep = (
  traefikWriter: TraefikWriterService,
  serverId: string | null,
  appName: string,
  reachability?: Pick<ReachabilityMemo, 'guard'>,
): TeardownStep => ({
  run: () => {
    const remove = () => traefikWriter.removeConfig(appName, serverId);
    return reachability ? reachability.guard(serverId, remove) : remove();
  },
  leftBehindOnFailure: {
    kind: 'traefik-config',
    appName,
    serverId,
    path: dynamicTraefikConfigPath(appName, serverId),
  },
});

/**
 * The three-valued presence answer and the orphan it reports now live in
 * `common/workload-presence.ts`, because Application, database and Compose all
 * decide it the same way from different probes. Re-exported here so the
 * existing call sites and their tests keep one import.
 */
export type {
  OrphanedWorkload,
  WorkloadPresence,
} from '../common/workload-presence';

/**
 * Whether this Application's swarm service is still there.
 *
 * The probe asks the daemon whether it is *there* before asking it about the
 * service, because `docker service inspect … && echo present || echo absent`
 * answered `absent` for a stopped, wedged or restarting daemon on a perfectly
 * reachable Server — see {@link presenceProbeCommand}, which owns that shape and
 * the evidence (H-95).
 */
export const applicationServicePresence = (
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
