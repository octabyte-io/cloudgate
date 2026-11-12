import path from 'node:path';
import { quote } from 'shell-quote';
import type { ComposeType } from '../compose/compose.schema';
import { volumeBackupsDirectoryOn } from '../deployment-engine/deployment-engine.paths';
import { withVolumeLock } from '../deployment-engine/volume-lock';
import type { VolumeLockMode } from '../deployment-engine/volume-lock';
import {
  bulkDownloadCommand,
  reachabilityProbeCommand,
} from '../destinations/rclone-exec';

/**
 * The image every throwaway `tar` container in this file runs, **pinned** — one
 * constant, not three string literals (H-129, §1.4).
 *
 * It was `ubuntu`, i.e. `ubuntu:latest`, in all three places: the backup's `tar
 * cvf`, the restore's validating `tar -tf` and the restore's extracting
 * `tar xvf`. Those agreed only because they resolve the same tag *within one
 * run*, and H-119's whole gate is the claim that the tar which passes an archive
 * is the tar which extracts it — a tag that moves between one restore and a
 * later one silently changes the tar doing the deciding, and a tag that moves
 * between the backup and the restore changes the writer as well.
 *
 * `24.04` because that is the platform `docs/deploy.md` documents, so the tar
 * doing the deciding is the tar of the distribution this product is tested on.
 * The unpinned pull was also a live cost rather than a theoretical one:
 * `ubuntu:latest` is not on a fresh host, so the first restore anywhere pulls it
 * *inside* the restore — which is exactly the failure `downloadStep`'s
 * 125/126/127 branch exists to report (H-121).
 *
 * Not pre-pulled by `deploy/install.sh`: that script runs on a fresh machine
 * where a Docker Hub rate limit would then fail the install rather than one
 * restore, and the 125/126/127 branch already answers the pull failure with
 * docker's own line.
 */
const VOLUME_TAR_IMAGE = 'ubuntu:24.04';

// Pure script builders: the service resolves the rows and passes plain values
// in. `test/volume-backups/pinned-volume-scripts.ts` pins the generated scripts
// byte for byte, tabs, spacing and the collapsed `\`-continuations included.
// The rclone lines carry no `--s3-*` credential flags, because these
// scripts are echoed into a log file; the credentials travel in the execution's
// environment.
//
// The volume lock changed two things. The lock preamble is
// `deployment-engine/volume-lock.ts`, keyed by volume and wrapped round every
// path both builders emit; that file carries the reasoning and it is not
// restated here. And the `docker-compose` turn-off branch looks its container
// up again after the tar rather than reusing the id it captured before the
// stop.
//
// H-96 changed a third, and it is the largest change to the statement order in
// this file: the three turn-off arms no longer stop, tar and restart as three
// statements of one shell. The stop and the tar are a subshell carrying
// `trap restore_workload EXIT`, and the restart is that function — because
// `set -e` is in force from the lock preamble's first line, so anything that
// failed inside the tar left the workload stopped and never reached the
// restart. `stopThenBackUp` carries the reasoning, including why the trap has
// to be in a subshell and why the `|| true` this file uses elsewhere is wrong
// here.

/** The service a turn-off backup stops while the tar runs: the application's
 * or the bucket's swarm service, or one service inside a compose project /
 * swarm stack. */
export type VolumeBackupStopTarget =
  | { serviceType: 'application'; appName: string }
  | { serviceType: 'bucket'; appName: string }
  | {
      serviceType: 'compose';
      appName: string;
      serviceName: string;
      composeType: ComposeType;
    };

export interface VolumeBackupScriptOptions {
  /**
   * The machine this script will be dispatched to — the Service's own Server,
   * `null` for the platform host (ADR-0008).
   *
   * It roots nothing in this builder directly: `volumeBackupPath` arrives
   * already resolved, because the service also has to name it in the cleanup
   * that runs after this script has exited. What it roots is the lock, through
   * `withVolumeLock` — and a lock whose path a caller could resolve differently
   * from the restore's is the one thing the volume lock cannot survive, which is
   * why it is a required field here rather than defaulted.
   */
  serverId: string | null;
  volumeName: string;
  /** `{volumeName}-{timestamp}.tar` — the staged tarball's file name. */
  backupFileName: string;
  /** Staging dir on that Server: `{volumeBackupsDirectoryOn(serverId)}/{row.appName}`. */
  volumeBackupPath: string;
  /** `:s3:{bucket}/{s3AppName}/{prefix}/{backupFileName}`. */
  rcloneDestination: string;
  /** Stop the service while the tar runs. */
  turnOff: boolean;
  /** What to stop — required when turnOff is set. */
  target?: VolumeBackupStopTarget;
  /**
   * How this run behaves when the volume's lock is already held.
   *
   * Required, not defaulted. `runManual` and `runScheduled` share one run core,
   * so nothing reachable from inside this builder can tell which one asked —
   * and a default would quietly hand the HTTP caller the blocking form, which
   * is the one thing a synchronous caller must not get.
   */
  lockMode: VolumeLockMode;
}

/** Tars the volume from a throwaway ubuntu container into the staging dir,
 * uploads it via rclone copyto, and cleans up the local file.
 *
 * No credential parameter, by construction: this script is echoed into
 * the run's log file line by line, so interpolated `--s3-*` flags would put the
 * destination's secret in a file the console then serves back. The service
 * passes `getS3CredentialsEnv` to the execution instead.
 *
 * **Every word carrying a value goes through `quote()` (H-21).** They used to
 * be spliced bare or inside `"…"`, and neither is a defence for what arrives
 * here: `volumeName` and the `prefix` inside `rcloneDestination` were
 * `z.string().min(1)` until H-19, so `-v ${volumeName}:/volume_data` took a `;`
 * and every `"…"` here took a `$(…)` — double quotes end a word, they do not
 * stop a substitution. The script goes to `execAsyncRemote`, so that ran on the
 * Server as the account that drives Docker.
 *
 * `quote()` per word, `builders/build-strategy.ts`'s rule, and it is the
 * defence: the DTO charset and `VolumeBackupsService.assertStoredValuesShellSafe`
 * stand behind it, not in place of it. **A `quote()` of a word that needs no
 * quoting emits it unchanged**, so for ordinary values the generated script is
 * the bytes it was before H-21; the fixture module's header
 * (`test/volume-backups/pinned-volume-scripts.ts`) lists its deliberate
 * properties.
 *
 * `bash -c` takes the whole program as one quoted argument rather than an
 * interpolated `"…"`, which is the same treatment `compose.utils.ts` gives its
 * own — the string is a program for a *second* shell, so leaving it in double
 * quotes hands the first one a substitution to perform on the way past. */
export const buildVolumeBackupScript = ({
  serverId,
  volumeName,
  backupFileName,
  volumeBackupPath,
  rcloneDestination,
  turnOff,
  target,
  lockMode,
}: VolumeBackupScriptOptions): string => {
  const stagedTarball = `${volumeBackupPath}/${backupFileName}`;
  const rcloneCommand = `rclone copyto ${quote([stagedTarball])} ${quote([rcloneDestination])}`;

  const backupCommand = `
	set -e
	echo ${quote([`Volume name: ${volumeName}`])}
	echo ${quote([`Backup file name: ${backupFileName}`])}
	echo "Turning off volume backup: ${turnOff ? 'Yes' : 'No'}"
	echo "Starting volume backup"
	echo ${quote([`Dir: ${volumeBackupPath}`])}
    docker run --rm \
  -v ${quote([`${volumeName}:/volume_data`])} \
  -v ${quote([`${volumeBackupPath}:/backup`])} \
  ${VOLUME_TAR_IMAGE} \
  bash -c ${quote([`cd /volume_data && tar cvf /backup/${backupFileName} .`])}
  echo "Volume backup done ✅"
  `;

  const uploadCommand = `
  echo "Starting upload to S3..."
  ${rcloneCommand}
  echo "Upload to S3 done ✅"
  echo "Cleaning up local backup file..."
  rm ${quote([stagedTarball])}
  echo "Local backup file cleaned up ✅"
  `;

  // Every path holds the volume's lock, not just the turn-off ones. A
  // lock on the turn-off branch alone would leave uncovered the one pairing the
  // restore's in-use guard cannot see: a backup of a volume no container
  // currently mounts has nothing for `docker ps -a --filter volume=` to find,
  // so a restore of that volume tars away underneath it.
  const underLock = (body: string) =>
    withVolumeLock(
      { serverId, volumeNames: [volumeName], mode: lockMode },
      body,
    );

  // This path stops nothing, so H-96's trap has nothing to restore and this
  // return is deliberately untouched by it.
  if (!turnOff || !target) {
    return underLock(`
		${backupCommand}
		${uploadCommand}
		`);
  }

  /**
   * The stop and the tar, with the restart armed as a `trap … EXIT` that cannot
   * be skipped (H-96).
   *
   * **What this replaces.** The three turn-off arms all read
   * `<stop>; <backupCommand>; <startCommand>; <uploadCommand>` as four
   * statements of one shell, and `set -e` is in force from the lock preamble's
   * first line — so *any* failure inside `backupCommand` ended the script with
   * the workload stopped and the restart never executed. A tenant's application
   * sat at 0 replicas, a compose service sat exited, with no recovery and no
   * notification, and the trigger is a **scheduled** backup, so it fires
   * unattended. Reproduced under a real `/bin/sh` with a stub `docker`: the
   * emitted script issued `--replicas=0`, the tar exited 2, and
   * `--replicas=$ACTUAL_REPLICAS` was never issued.
   *
   * A `docker restart` during a long tar, a full disk, an OOM kill of the
   * `ubuntu` container are all ordinary operational events, and none of them
   * needs an unusual state to reach this — which is what made it worth the
   * restructuring rather than a comment.
   *
   * **The restart lives only in the trap.** Not "in the trap as well as in the
   * tail", which would restart twice on the happy path and put the question of
   * whether that is harmless into the reader's lap. One registration, one
   * caller, and the happy path's ordering is unchanged: the subshell closes
   * after the tar, the trap restarts, and `uploadCommand` — which stays
   * *outside* — runs afterwards exactly as it always did. So an upload failure
   * still finds the workload already back up; that is the ordering answer, not
   * an assumption.
   *
   * **It has to be a subshell, and that is not stylistic.** `trap` sets, it does
   * not append, so a second `trap … EXIT` in the same shell *replaces* the
   * first — and `volume-lock.ts`'s `mkdir` fallback, taken on any host without
   * `flock`, registers `trap 'rm -rf "$LOCK_DIR"' EXIT` around this whole body.
   * Registering here in the same shell would leave the lock directory behind on
   * every single turn-off backup, so every later scheduled backup of the volume
   * would block on it forever and every later restore would answer 409. Traps
   * set in a subshell are the subshell's own (POSIX 2.12), so both fire. This is
   * the same reason `checkThenRestoreCommand` puts the tarball trap in a
   * subshell; that reasoning is now load-bearing in two functions.
   *
   * **The `|| true` remedy this file uses at the compose restart is wrong here**
   * and was rejected rather than overlooked. It would let a failed restart pass
   * silently and the run report success over a stopped workload — a guard whose
   * failure mode is "allow". The restart failing is the one thing that must not
   * be skippable, so `restore_workload` ends in `exit 1` with a line naming the
   * outage.
   *
   * Verified against both shells these scripts meet — `dash`, which is
   * `/bin/sh` on the Debian and Ubuntu hosts, and bash in POSIX mode — on all
   * four pairings: happy path (trap fires once, status 0 preserved, upload
   * runs), abort in the tar (trap fires, status non-zero, upload skipped), and
   * a failing restart on either of those (diagnosis printed, status forced
   * non-zero).
   */
  const stopThenBackUp = (stop: string) => `(
			trap restore_workload EXIT
			${stop}
			${backupCommand}
		)`;

  /**
   * Refuse the backup when the replica count did not read as a number, *before*
   * anything is stopped (H-96).
   *
   * `set -e` already covers the capture, so a daemon that refuses the connection
   * aborts at the `docker service inspect` and nothing is stopped. What it does
   * not cover is the substitution that succeeds and says nothing: `docker service
   * inspect` on a service that exists and is not replicated-mode exits **0** with
   * an empty `{{.Spec.Mode.Replicated.Replicas}}`, and the script then emitted
   * `docker service update --replicas= --with-registry-auth …`, which docker
   * refuses on its own flag (`invalid argument "" for "--replicas" flag`, exit
   * 125) — after the stop. Cloudgate creates no such service today, so this is a
   * latent shape rather than a live one; it is guarded anyway, because the value
   * this decides is whether a workload can be brought back and the cost of
   * asking is one `case`.
   *
   * Refusing rather than defaulting to 1: the count is the only record of what
   * the service was running, and a backup that scales a 4-replica service back
   * to 1 has caused an outage of its own while reporting success.
   *
   * Digits-only rather than non-empty, so the word interpolated into
   * `--replicas=` is proven numeric rather than merely present — and it is
   * `"$ACTUAL_REPLICAS"` at the use site regardless. The guard runs in the outer
   * shell and the use runs inside the trap's subshell, so the quoting is what
   * survives someone later moving one of the two; the DTO-behind-`quote()`
   * ordering this file states three times over, one level in.
   */
  const requireReplicaCount = (subject: string) => `case "$ACTUAL_REPLICAS" in
			''|*[!0-9]*)
				echo "❌ Volume backup aborted - the replica count could not be read, so nothing was stopped"
				echo ${quote([`   'docker service inspect' did not answer a replica count for ${subject}, so this backup stopped before scaling anything down and the workload is untouched.`])}
				echo "   What it answered instead: '$ACTUAL_REPLICAS'"
				exit 1
				;;
		esac`;

  // A bucket's Garage is one Swarm service named after its appName, exactly
  // as an Application is, so it takes this arm with its own noun.
  if (target.serviceType === 'application' || target.serviceType === 'bucket') {
    const service = quote([target.appName]);
    const noun = target.serviceType;
    const Noun = noun === 'bucket' ? 'Bucket' : 'Application';
    const startIt =
      noun === 'bucket'
        ? 'scale it back up by hand'
        : 'start it from Cloudgate or scale it by hand';
    return underLock(`
		echo "Stopping ${noun} to 0 replicas"
		ACTUAL_REPLICAS=$(docker service inspect ${service} --format "{{.Spec.Mode.Replicated.Replicas}}")
		echo "Actual replicas: $ACTUAL_REPLICAS"
		${requireReplicaCount(`${noun} '${target.appName}'`)}
		restore_workload() {
			echo "Starting ${noun} to $ACTUAL_REPLICAS replicas"
			if docker service update --replicas="$ACTUAL_REPLICAS" --with-registry-auth ${service}; then
				return 0
			fi
			echo "❌ Volume backup failed - the ${noun} was scaled to 0 for the backup and would not scale back up"
			echo ${quote([`   ${Noun} '${target.appName}' is DOWN at 0 replicas. Read the 'docker service update' error above, then ${startIt}.`])}
			echo "   The replica count it was running before this backup: $ACTUAL_REPLICAS"
			exit 1
		}
		${stopThenBackUp(`docker service update --replicas=0 ${service}`)}
		${uploadCommand}
  `);
  }

  // `preStop` is everything that has to be settled while the workload is still
  // up — the capture, its guard, and the definition of `restore_workload`;
  // `stop` is the one statement the trap has to be armed in front of (H-96).
  let preStop = '';
  let stop = '';

  // The stack's swarm service name and the compose project/service labels are
  // built once and `quote()`d once, so the four places that name each of them
  // cannot drift apart on the question (H-21). `serviceName` took a charset
  // later — Compose's own, which admits no character a shell reads
  // specially — so the quoting is no longer the only thing standing here. It
  // is still the defence rather than the belt: `builders/build-strategy.ts`
  // carries why a charset is only ever correct for the context it was written
  // for, and this one was written for a compose file.
  const stackService = quote([`${target.appName}_${target.serviceName}`]);

  if (target.composeType === 'stack') {
    // Byte-equivalent to the application arm above, and H-96 was the fourth
    // time this file documented a failure mode in one function and left a
    // sibling instance of it standing. The two arms are therefore kept
    // statement-for-statement parallel, sharing `stopThenBackUp` and
    // `requireReplicaCount`, so the next reader who fixes one is looking at the
    // other.
    preStop = `
			echo "Stopping compose to 0 replicas"
			echo ${quote([`Service name: ${target.appName}_${target.serviceName}`])}
            ACTUAL_REPLICAS=$(docker service inspect ${stackService} --format "{{.Spec.Mode.Replicated.Replicas}}")
            echo "Actual replicas: $ACTUAL_REPLICAS"
		${requireReplicaCount(`compose service '${target.appName}_${target.serviceName}'`)}
			restore_workload() {
				echo "Starting compose to $ACTUAL_REPLICAS replicas"
				if docker service update --replicas="$ACTUAL_REPLICAS" --with-registry-auth ${stackService}; then
					return 0
				fi
				echo "❌ Volume backup failed - the compose service was scaled to 0 for the backup and would not scale back up"
				echo ${quote([`   Service '${target.appName}_${target.serviceName}' is DOWN at 0 replicas. Read the 'docker service update' error above, then start the stack from Cloudgate or scale the service by hand.`])}
				echo "   The replica count it was running before this backup: $ACTUAL_REPLICAS"
				exit 1
			}`;

    stop = `docker service update --replicas=0 ${stackService}`;
  } else {
    const containerFilter = `--filter ${quote([`label=com.docker.compose.project=${target.appName}`])} --filter ${quote([`label=com.docker.compose.service=${target.serviceName}`])}`;

    // The container is looked up again after the tar instead of the `$ID`
    // captured before the stop. Remove containers (ADR-0011) and Delete
    // both take the container away while the backup holds it stopped, and under
    // `set -e` a `docker start` of an id that no longer resolves aborted the
    // script *before* the upload: the tar had run and the bucket gained
    // nothing. Two details carry that:
    //
    // - `-aq`, not `-q`. The container this is looking for is the one this
    //   script exited, and `docker ps -q` lists only running ones.
    // - `|| true`, because `set -e` kills the script on a failing command
    //   substitution, and finding no container is a legitimate outcome here —
    //   the operator asked for the containers to be gone. Nothing is aborted;
    //   the upload runs and the run reports success, because the tarball is
    //   valid whatever became of the containers. **That `|| true` is on the
    //   *lookup*, not on the `docker start`** (H-96/H-74): "there is no
    //   container" is a legitimate answer, "the container would not start" is
    //   not, and a `|| true` over the latter is a guard whose failure mode is
    //   allow.
    //
    // The "Starting compose container" line is inside the branch that starts
    // one, not above the lookup: this is echoed into a log an operator reads
    // back, and announcing the restart before knowing there is anything to
    // restart made the log say it had done something the next line took back.
    //
    // H-96: this restart is a `trap … EXIT` for the same reason the two swarm
    // arms' are. It is the arm that arrived at the shape from the other
    // direction — the volume lock fixed the *`docker start` of a vanished id*
    // half of it and left the *tar that never reaches the `docker start`* half
    // standing, which is the same one-instance-short pattern the finding is
    // about.
    //
    // H-97, decided at X10, is the fourth: **an empty `$ID` means the volume is
    // already free, so the backup proceeds.** The reason a turn-off backup stops
    // the container at all is that nothing may be writing to the volume while
    // `tar` reads it, and a container that is already stopped satisfies that
    // exactly — so the stop is guarded the way the restart three lines below
    // already is, and "there is nothing running to stop" is a legitimate outcome
    // that goes on to tar. It read `docker stop $ID` with no guard, which made
    // `docker stop` run with no argument, exit non-zero and end the script under
    // `set -e`; because the caller is usually `runScheduled`, every scheduled
    // backup of a compose service an operator had stopped failed indefinitely,
    // and the state where a backup is most obviously wanted was the state that
    // guaranteed there was none. The refusal also said nothing an operator could
    // read: the whole diagnosis was `docker`'s usage text on stderr.
    //
    // **The restart is gated on `STOPPED_BY_THIS_RUN`, and that flag is the
    // load-bearing half** (H-118). `restore_workload` re-looks-up with
    // `docker ps -aq`, deliberately, so it can find a container this script
    // exited — which means it cannot tell "I stopped this" from "this was
    // already down". Guarding only the stop would therefore hand H-96's trap a
    // container it never touched and *start* it: on a real container, `created`
    // → `running`, a backup that starts a workload the operator had stopped. The
    // flag is initialised in the outer shell and set inside the trap's subshell,
    // so the trap sees it.
    //
    // It is set **in front of** the `docker stop` rather than after it, and that
    // is H-96's requirement rather than a preference: `$ID` can name more than
    // one container, so a `docker stop` that stops one and fails on the next
    // exits non-zero with something already stopped. Setting the flag after it
    // would skip the restart on exactly the failure the trap exists for. The
    // flag therefore means "this run set out to stop something", which is the
    // question the restart has to answer, and the case H-97 is about never
    // reaches the branch at all.
    //
    // No `|| true` on this lookup, unlike the restart's. `docker ps -q` matching
    // nothing already exits 0 with empty output, so the `|| true` would buy
    // nothing for the case above and would instead turn a daemon that refuses
    // the connection into "the volume is already free" — the reading
    // `requireReplicaCount` refuses for the swarm arms (H-96), one line before
    // the tar rather than after it.
    preStop = `
			STOPPED_BY_THIS_RUN=0
            ID=$(docker ps -q ${containerFilter})
			restore_workload() {
				if [ "$STOPPED_BY_THIS_RUN" != 1 ]; then
					echo "Nothing was stopped by this backup, so there is nothing to restart"
					return 0
				fi
				echo "Looking for the compose container to restart"
				ID=$(docker ps -aq ${containerFilter} || true)
				if [ -z "$ID" ]; then
					echo "No compose container found to restart — the compose service was left with none and the upload continues"
					return 0
				fi
				echo "Starting compose container"
				if docker start $ID; then
					echo "Compose container started"
					return 0
				fi
				echo "❌ Volume backup failed - the compose container was stopped for the backup and would not start again"
				echo ${quote([`   The container for service '${target.serviceName}' of compose project '${target.appName}' is DOWN. Read the 'docker start' error above, then start the stack from Cloudgate.`])}
				exit 1
			}`;

    stop = `if [ -n "$ID" ]; then
				echo "Stopping compose container"
				STOPPED_BY_THIS_RUN=1
				docker stop $ID
			else
				echo "No running compose container to stop — the volume is already free, and this backup continues without stopping anything"
			fi`;
  }

  return underLock(`
        ${preStop}
		${stopThenBackUp(stop)}
		${uploadCommand}
  `);
};

/** The service a restore's log header names — the volume itself is looked up
 * by name, so the target styles the log banner — and, for a bucket, the
 * Garage Swarm service the restore stops itself. */
export type VolumeRestoreTarget =
  | { serviceType: 'application'; appName: string }
  | { serviceType: 'bucket'; appName: string }
  | { serviceType: 'compose'; appName: string; composeType: ComposeType };

/**
 * What a restore knows about the target that owns the volume, per service type:
 * the one step that frees the volume, which label names a container as
 * the target's own, and whether the restore may sweep that target's Swarm task
 * history itself. One cascade, so the refusal's wording and the rule
 * that decides what it refuses on cannot drift apart.
 *
 * **The owner label is matched exactly.** An Application's Swarm service is
 * named after its `appName`, so `com.docker.swarm.service.name`; a swarm
 * stack's containers carry their stack in `com.docker.stack.namespace`; a
 * `docker-compose` project's carry `com.docker.compose.project`. A prefix match
 * on service names (`<appName>_*`) was the first draft and is wrong: `appName`
 * may contain `_`, so stack `shop` would claim `shop_api_db` of stack
 * `shop_api` and remove its exited containers.
 *
 * **The step.** *
 * The sentence this replaces — "Stop all containers/services using this volume"
 * — was true for every target but one, and that one is the target whose
 * operator this refusal sent to a host shell. Of the stop paths a restore can
 * be blocked on, an application scales its swarm service to zero and a swarm
 * stack runs `docker stack rm`; both keep being told to press Stop, because for
 * them Stop is the right answer.
 *
 * **It is not the whole answer, and this block used to say it was.** It
 * said both Stops "leave nothing holding the volume". Swarm keeps the exited
 * task containers of each slot after a scale to zero — up to
 * `TaskHistoryRetentionLimit`, 5 by default — and every one of them still
 * references the volume, so on a live host the refusal survived the very Stop
 * it prescribed, listing only `exited` containers. What frees the volume after
 * Stop is the restore itself: `checkThenRestoreCommand` sorts exited task
 * containers of the target's own service, while that service runs no replica,
 * out of the refusal, and `replaceVolumeCommand` removes them in front of the
 * `docker volume rm`. So the sentence says Stop, and says the rest is the
 * restore's.
 *
 * A compose project of the `docker-compose` type runs `docker compose stop`, which
 * leaves its containers `Exited` — and an exited container holds a volume just
 * as firmly as a running one — so it is told about Remove containers instead,
 * the rung added for exactly this (ADR-0011). Fixing the mechanism and leaving
 * this sentence alone would have kept the trap.
 */
const volumeOwnerOf = (
  target: VolumeRestoreTarget,
): { ownerLabel: string; sweepsTaskHistory: boolean; freeStep: string } => {
  if (target.serviceType === 'bucket') {
    // The restore scales the bucket's Garage to 0 itself, so its own
    // task history is swept; one of its containers still running means the
    // scale-down did not take, and the restore is simply run again.
    return {
      ownerLabel: 'com.docker.swarm.service.name',
      sweepsTaskHistory: true,
      freeStep: `Run the restore again — it scales the bucket '${target.appName}' to zero replicas itself, and one of its containers was still running when it looked`,
    };
  }
  if (target.serviceType === 'application') {
    return {
      ownerLabel: 'com.docker.swarm.service.name',
      sweepsTaskHistory: true,
      freeStep: `Stop the application '${target.appName}' in Cloudgate — that scales it to zero replicas. The exited task containers Swarm keeps from its earlier runs still reference this volume, and the restore removes those itself once the application runs no replica`,
    };
  }
  if (target.composeType === 'docker-compose') {
    // No Swarm service, so no task history: its exited containers stay the
    // operator's to take away with Remove containers (ADR-0011).
    return {
      ownerLabel: 'com.docker.compose.project',
      sweepsTaskHistory: false,
      freeStep: `Use Remove containers on the compose stack '${target.appName}' in Cloudgate — Stop leaves its containers exited and still holding this volume, while Remove containers takes them away and leaves the volumes, the project directory and the stack itself standing. Start brings the stack back afterwards`,
    };
  }
  return {
    ownerLabel: 'com.docker.stack.namespace',
    sweepsTaskHistory: true,
    freeStep: `Stop the compose stack '${target.appName}' in Cloudgate — that removes the swarm stack. Any exited task containers of its services left behind still reference this volume, and the restore removes those itself`,
  };
};

export interface VolumeRestoreScriptOptions {
  /** The machine this script will be dispatched to — the Service's own Server,
   * `null` for the platform host (ADR-0008). It roots both the staging tree the
   * tarball is downloaded into and, through `withVolumeLock`, the lock file the
   * preamble opens. */
  serverId: string | null;
  volumeName: string;
  /** Full S3 object key of the tarball to restore. */
  backupFileName: string;
  bucket: string;
  target: VolumeRestoreTarget;
}

/** Downloads the tarball from S3 and untars it into the (re-created) volume —
 * refusing to touch a volume any container still uses, with the offending
 * containers listed in the log.
 *
 * What each change did, in the order they landed. The first two restore a
 * symmetry the backup path already has, the third is the refusal learning to
 * name a control that exists, and the last three are all one theme: replacing a
 * volume is destructive, so nothing may be replaced until the replacement is in
 * hand:
 *
 * - The downloaded tarball is removed once it has been untarred, the way
 *   `buildVolumeBackupScript`'s upload ends `rm "…/${backupFileName}"`. It used
 *   to be left, so every restore permanently cost the volume's own size on the
 *   platform host — and on the *local* path even when the restore ran on a
 *   Server. `backupFileName` is the full S3 key, so the download nests the
 *   key's directories under the volume name and the emptied ones go with it.
 * - The volume is re-created *explicitly*, carrying back the labels it
 *   had. The restore used to remove it and let
 *   `docker run -v <name>:/volume_data` create it again implicitly, which
 *   creates it unlabelled — so a restored compose volume stopped answering to
 *   `com.docker.compose.project`, and anything that finds volumes by label
 *   (`docker compose down --volumes`, a label-filtered prune, Cloudgate's own
 *   cleanup routes) stopped finding it.
 * - The in-use refusal names the control that frees the volume for the
 *   target it is refusing, rather than one sentence for all of them. See
 *   `volumeOwnerOf`.
 * - The whole script — the in-use guard included, since the guard's
 *   answer goes stale the moment it is read — runs while holding the volume's
 *   lock. The restore used to take no lock at all, so a restore could
 *   `docker volume rm` and re-create the volume under a backup mid-`tar` and
 *   the tarball that reached the bucket was a backup of a half-replaced volume
 *   with nothing marking it suspect. Always fail-fast: a restore is one
 *   synchronous HTTP request, and the alternative is holding it open for as
 *   long as somebody else's tar takes.
 * - The tarball is downloaded and *proved* before anything touches the
 *   volume, so the download is emitted once, ahead of the removal, instead of
 *   once inside each branch behind it. See `downloadCommand`, whose comment
 *   carries the `rclone copyto` quirk this turns on.
 * - That download is bounded, like every other rclone call made in front
 *   of a waiting HTTP caller — and bounded on the wall clock as well as on idle
 *   time, because the idle bound turned out not to bound the request at all.
 *   See `boundedRcloneFlags` and `downloadCommand`.
 * - H-120: that wall clock is the **process**, not `--max-duration`, which is
 *   accepted and inert on the rclone `deploy/install.sh` installs — so until
 *   this the request bound existed only in the comment. See
 *   `bulkDownloadCommand`, and `downloadStep` for the refusal 124 gets.
 * - The `wc -l` that answers "does this volume exist" has its padding
 *   stripped at the capture. The raw output used to be compared against the
 *   string `"0"`, which is only ever true on a GNU `wc` — a BSD one answers
 *   `"       0"`, so on such a host a restore of a volume that does not exist
 *   yet took the "exists" branch and died at `docker volume inspect`, one line
 *   under a log line claiming the volume was there. Normalized once at the
 *   capture rather than at each comparison, so the two string comparisons stay
 *   string comparisons and a third added later inherits the fix. `tr` over a
 *   numeric `test -eq`, because these scripts run under POSIX `sh`, which
 *   promises nothing about `-eq` on a padded operand — and because the echo
 *   beside the capture prints the value at an operator.
 * - The removal of the tarball is a `trap … EXIT` in a subshell rather
 *   than a statement after the untar, so the failure that leaves the most
 *   behind is covered rather than the only one that is not. See `downloadStep`,
 *   which carries the reasoning, and `checkThenRestoreCommand` for the
 *   subshell.
 * - The downloaded file's headers are read before the volume is touched,
 *   because "there are bytes" and "these bytes are a tar" are different
 *   questions and only the first was being asked. See `downloadStep`.
 * - The one failure that happens *after* the volume is gone says so.
 *   See `replaceVolumeCommand`.
 * - H-119, and H-121 with it: that header read asks the question the *removal*
 *   depends on — not "is this a readable tar" but "can the extraction's `.`
 *   selector match a member of it" — and it picks its message from a captured
 *   status rather than from an `if !` condition, where `set -e` is suspended and
 *   a docker that cannot run at all reported the archive as corrupt. See
 *   `downloadStep`.
 * - H-116: that sentence describes the partial extraction the volume actually
 *   holds instead of claiming it is empty. See `replaceVolumeCommand`.
 * - H-19, then H-32: **every word carrying a value goes through `quote()`**,
 *   the prose `echo`s included. H-19 quoted `downloadStep`'s `mkdir -p` because
 *   that was the one reproduced live — `volumeName` was `z.string().min(1)` on
 *   `restoreVolumeBackupSchema`, so `{"volumeName":"x;touch …"}` on
 *   `POST /volume-backups/restore` ran as the account that drives Docker. This
 *   is the rest of the same function: `docker volume rm`, `docker volume
 *   create`, both `-v` mounts, both `tar`s inside their `bash -c`, the three
 *   `--filter` words, `rclone copyto`, the `-s` test, the `trap` and every
 *   `echo` that names the volume, the key or the bucket.
 *
 *   The `echo`s are not decoration in this: they are the largest group of
 *   sinks here, and `"…"` never stopped a `$(…)` or a backtick, so quoting
 *   only the "command" words would have left the injection reachable through
 *   the line that reports it. `builders/build-strategy.ts` states the rule and
 *   its "an `echo` quotes its whole message" clause is what this follows.
 *
 *   The DTO charsets added with H-19 stand *behind* this, not in place of it —
 *   the third rediscovery of that ordering is what `build-strategy.ts`'s
 *   paragraph now opens with. One sink is deliberately still outside:
 *   `reachabilityProbeCommand` (`destinations/rclone-exec.ts`) double-quotes
 *   the object path it is given, and belongs to another module.
 * - The refusal stops counting what Swarm leaves after Stop. The exited
 *   task containers of the target's own service, once it runs no replica, are
 *   removed by the restore in front of `docker volume rm` rather than listed as
 *   a blocker the console had no control for. Nothing else is ever removed: a
 *   container of another service, a `docker-compose` project's or one
 *   Cloudgate does not own still refuses, and the refusal says whose it is. See
 *   `volumeOwnerOf` and `taskHistoryCheck`.
 */
export const buildVolumeRestoreScript = ({
  serverId,
  volumeName,
  backupFileName,
  bucket,
  target,
}: VolumeRestoreScriptOptions): string => {
  const volumeBackupPath = path.join(
    volumeBackupsDirectoryOn(serverId),
    volumeName,
  );
  const bucketPath = `:s3:${bucket}`;
  const backupPath = `${bucketPath}/${backupFileName}`;

  const localTarball = `${volumeBackupPath}/${backupFileName}`;

  // Command to download backup file from S3
  //
  // No credentials in the line: they travel in the environment. Bounded,
  // because a restore is one synchronous HTTP request against somebody else's
  // endpoint and rclone's defaults are built for an unattended transfer — 3
  // retries × 10 low-level retries with backoff held one restore open for 5 min
  // 55 s against a stopped MinIO, and the volume lock with it.
  //
  // **Deliberately not the listing's flags**, which is the mistake this line was
  // shipped with and that was named in advance: this is the one bulk data
  // transfer in front of an HTTP caller. `--timeout 60s` is idle rather than
  // total, because a slow-but-alive multi-GB download to a small host can stall
  // for tens of seconds under memory pressure and aborting a real restore at 30
  // s of idle would be a worse bug than the hang being fixed. `--contimeout 10s`
  // because a restore can legitimately reach a cross-region TLS endpoint a
  // same-host probe never does, and it is still six times under rclone's 1 m
  // default.
  //
  // **And no flag on this line bounds the request** (reopened, then H-120).
  // The four above bound an attempt: `--timeout` is IO idle *per connection* and
  // a download opens a fresh set per retry, so an endpoint that dribbles rather
  // than refuses is never idle and never done. G-39 measured 18 min 03 s here,
  // with `withVolumeLock` held the whole time — every other operation on the
  // volume answering 409 for eighteen minutes because one link was degraded.
  //
  // `--max-duration` was given that job and **cannot do it on the rclone this
  // product installs**: `--max-duration 1ms` against a healthy endpoint
  // transferred all 157 286 400 bytes, rc=0, in 1 s on `rclone v1.60.1-DEV`,
  // which is what apt has on the documented platform and therefore what
  // `deploy/install.sh` puts on the host. So the bound is the **process** —
  // `bulkDownloadCommand`'s `timeout`, probed for with `command -v` because these
  // scripts also run on a Server over SSH. That function carries the whole
  // argument; the flag stays as the belt for a host on rclone ≥ 1.64.
  //
  // 30m is above every slow success this repo has measured, so it cuts nothing
  // that is still moving; `09b6ff1` exists because the first bounding of this
  // line was tight enough to abandon a real transfer, and a cap under a measured
  // legitimate slow success would repeat that. What now reaches it is only the
  // residual tail — a link that answers the probe above and then dies without
  // ever going idle. Lowering it is a call about how long a person and a volume
  // lock may be held; do not lower it without one.
  //
  // **`--retries 1 --low-level-retries 10`, and swapping those two round is what
  // G-39 actually measured.** `--retries` restarts the object at byte zero and
  // discards the partial download; `--low-level-retries` resumes at the offset
  // already on disk. The shipped `2 × 3` was therefore the worst of both — the
  // staged file was watched climbing to 79 MB and 119 MB and being reset until
  // the attempts ran out — and rclone's defaults beat it not by being more
  // generous but by never discarding. Paired against the same stalling proxy:
  // 1083 s and 0 B at `2 × 3`, 901 s and every byte at rclone's defaults, 181 s
  // and every byte here. A restart from zero is never what a synchronous restore
  // wants, which is why the top-level retry is spent rather than tuned.
  //
  // The flags, the verb and the wall clock all come from `bulkDownloadCommand`
  // rather than being written out here, because the database restore's mongo
  // download is the same operation and these values have already been wrong
  // twice: they have to move together or the next measurement is of whichever
  // copy was forgotten (§1.4).
  const downloadCommand = bulkDownloadCommand({
    verb: 'copyto',
    args: `${quote([backupPath])} ${quote([localTarball])}`,
    indent: '\t',
  });

  /**
   * The download, and the proof that it arrived — everything before the volume
   * is touched at all.
   *
   * **`rclone copyto` of an object that does not exist exits 0.** That is the
   * trap: `set -e` catches an unreachable bucket and catches bad credentials,
   * but a mistyped key is not an error to rclone, so the script printed
   * `Download completed ✅` and carried on to `docker volume create` and a
   * `tar xvf` of a file that was never downloaded. With the removal in front of
   * it, that emptied the volume — and when the bucket was unreachable instead,
   * `set -e` aborted *after* the removal and the volume was never re-created at
   * all. So the local file is tested rather than the exit status: `-s`, not
   * `-f`, because the quirk's other shape is a zero-byte file where a tar
   * should be, and `tar cvf` of even an empty volume writes 10 KiB.
   *
   * A `rclone lsjson` probe of the key first was the alternative, and is
   * rejected *as this test's replacement*: it is a second round trip to the same
   * endpoint that can go stale between the answer and the copy, and it proves
   * the object exists rather than the thing the untar actually needs, which is
   * bytes on this disk. The download bound has since put a probe at the top of
   * this script and that rejection is untouched by it — the probe there answers
   * whether the *endpoint* replied, a key that is absent passes it with `[]` and
   * exit 0, and this test is still the only thing that decides there is a
   * tarball.
   *
   * **The download's status is read, and 124 is the one value that gets its own
   * sentence (H-120).** `bulkDownloadCommand` runs the transfer under `timeout`,
   * because `--max-duration` does nothing on the rclone this product installs,
   * and the operator on the other end of a request that has just spent thirty
   * minutes inside `withVolumeLock` needs to be told which bound ended it —
   * every other failure in this script names its cause, and a silent kill would
   * have been the only one that did not. Every status other than 124 exits with
   * itself, so an unreachable bucket answers exactly what it answered before:
   * this adds a branch, not a behaviour. It is a captured status rather than an
   * `if !` for H-121's reason — `set -e` is suspended for the condition of an
   * `if` — and it needs no cleanup of its own, because the partial the transfer
   * had already written is the tarball trap's to remove.
   *
   * **`-s` answers "are there bytes", not "are these bytes an archive".**
   * That is the neighbouring door, and it was driven: a 200 000-byte object of
   * `/dev/urandom` uploaded under a `.tar` name is neither absent nor empty, so
   * it passed this guard, `replaceVolumeCommand` removed the volume, and the
   * `tar xvf` failed into an emptied one — the same total loss the
   * download-first change was for, reached one door over. So the archive's
   * headers are read before the volume is at risk. `tar -tf` on a seekable
   * uncompressed file — and these are uncompressed, `buildVolumeBackupScript`
   * writes them with `tar cvf` — seeks past each entry's data blocks and reads
   * only headers, so it costs the number of entries rather than the size of the
   * volume, which is what makes it affordable in front of a multi-GB restore.
   *
   * **And "is this a readable tar" is still not the question the removal
   * depends on (H-119).** `replaceVolumeCommand` extracts with
   * `tar xvf /backup/<file> .`, where the trailing `.` is a *member selector*
   * rather than a destination — the archives this application writes carry `./`
   * and `./…` entries because `buildVolumeBackupScript` tars from *inside* the
   * volume. An ordinary `tar cf archive.tar mydir/` is a perfectly readable tar
   * whose members are `mydir/…`, so it passed the header read, the volume was
   * removed and re-created, and the extraction then found no `.` member: total
   * loss, with a message blaming `tar`. Measured on a real `ubuntu` — a
   * 150 MB `tar -cf big.tar -C dir bigfile` listed at exit 0 and extracted at
   * exit 2, `tar: .: Not found in archive`, and the byte-identical archive
   * written the way this application writes them restored.
   * `backupFileName` is picked out of `GET /destinations/:id/objects`, which
   * lists every object in the bucket, so any hand-made tar an operator ever put
   * there is one click away.
   *
   * So the gate asks with **the extraction's own selector** — `tar -tf <file> .`
   * — rather than by matching `./` against the listing in the shell. tar's
   * member matching is tar's (anchoring, trailing slashes, `./x` versus `x`),
   * and a `grep '^\./'` here would be a second implementation of it that can
   * disagree with the one that does the extracting; the `wc -l` padding is what
   * one such divergence already cost this file. Dropping the `.` from `tar xvf`
   * was the other way to close it and is rejected: it extracts foreign archives
   * into the volume root and changes the layout of every restore, to fix a case
   * that should be refused rather than accommodated.
   *
   * Three decisions in that block:
   *
   * - **The failure branches are chosen on a captured status, not on `if !`
   *   (H-121).** `set -e` is suspended for the condition of an `if`, so a
   *   `docker run` that cannot run *at all* took the false branch and the
   *   operator was told their backup was corrupt when the cause was the daemon
   *   or a Docker Hub rate limit. That is not hypothetical:
   *   `VOLUME_TAR_IMAGE` is not on a fresh host — the first restore on one
   *   pulls it *inside* the restore — and the header check is what moved the
   *   first `docker run` to a place whose failure text is about the archive.
   *   `docker run` answers 125 when the daemon or the image is the problem,
   *   126/127 when the container's command cannot be run, and the container's
   *   own status otherwise, where GNU tar uses 2; so the three causes get three
   *   messages. The volume was never at risk on any of them and is not now — the
   *   sentence this replaces drew the right conclusion from the wrong mechanism,
   *   and what makes it true is the `exit 1` in each branch rather than an abort
   *   `set -e` does not perform. The rare window left is docker dying *between*
   *   the two reads, which lands in the archive message — with its own `docker`
   *   line echoed under the banner, which is why the captured stderr is printed
   *   rather than discarded.
   * - **The second read only happens on a failure**, so the healthy restore
   *   still costs one container. It is what separates "the headers are
   *   unreadable" from "the headers read and hold nothing the extraction can
   *   select", and running it up front would double the wait on the one path
   *   where the wait is already the complaint — a pull that is being rate
   *   limited.
   * - **The same containerised `tar` that will do the extraction judges the
   *   archive**, not the host's. The host's may be a different implementation —
   *   busybox on a minimal box, BSD tar on a developer's machine — and this tree
   *   has already been bitten by exactly that class of divergence: the `wc -l` fix exists
   *   because a BSD `wc` pads where GNU's does not, and it made a restore fail
   *   one line under a log line claiming the opposite. Running it in
   *   `VOLUME_TAR_IMAGE` means validation and extraction agree by construction
   *   and adds no host binary this script did not already need — and the
   *   agreement is only "by construction" because that image is *pinned*
   *   (H-129); on a floating tag the two agreed within one run and could differ
   *   between a backup and the restore that reads it back.
   *
   * - **It mounts the staging directory only.** The volume is deliberately not
   *   visible to a step whose whole purpose is to run while the volume is still
   *   safe, and mounting it would create a reference where the script has just
   *   finished proving there need be none.
   *
   * Restoring into a fresh volume and swapping was rejected again rather than
   * re-argued: the disk-and-lock reasoning is unchanged — Docker has no atomic
   * volume rename, so a "swap" is still `rm` + `create` + a second full copy, and
   * on a small host that means the tarball plus two copies of the volume's
   * contents at once, for minutes, inside the volume lock. Reading headers costs
   * neither.
   *
   * **The `trap` is the one thing that removes the tarball.** It used to
   * be a plain `rm` after the untar plus a hand-rolled copy in the abort above,
   * and `set -e` meant a failing `docker run … tar xvf` never reached the first
   * of them — so the failure mode that leaves the *most* on the host was the one
   * path with no cleanup, and what stayed was the size of the whole volume.
   * Registered here rather than at the top of the script, and specifically
   * after the `mkdir -p`, so it cannot fire for a run that never staged
   * anything.
   *
   * Three decisions inside it, each with a rejected alternative:
   *
   * - **It removes the one file, and does not prune the directory.** The
   *   `find "${volumeBackupPath}" -type d -empty -delete` it replaces was safe
   *   as a tail statement and is not safe in a trap: `${volumeBackupPath}` is
   *   per *volume*, not per run, so a failing run gets a way to rmdir a
   *   directory a concurrent healthy run is downloading into — the shape a
   *   triage raised against exactly this change. The cost, taken
   *   deliberately, is that the directories the S3 key nests the tarball in are
   *   left behind empty, which walks back half of the tarball-removal promise;
   *   empty directories are bounded by the number of distinct key prefixes and
   *   cost bytes, where the tarball costs the volume.
   * - **`mktemp -d` per run was the other way to make the prune safe**, and is
   *   rejected twice over: its default root is `TMPDIR`, which on a small host
   *   is a tmpfs that a multi-GB volume tarball must not land on, and pointing
   *   it back at the volume-backups tree turns every path this builder
   *   interpolates into a runtime variable for no gain the acceptance criteria
   *   can see.
   * - **It is registered inside a subshell** — see `checkThenRestoreCommand`.
   *   `trap` sets, it does not append, so a second `trap … EXIT` in the same
   *   shell *replaces* the first. The volume lock's `mkdir` fallback registers
   *   `trap 'rm -rf "$LOCK_DIR"' EXIT` on any host without `flock`, and
   *   clobbering that would leave the lock directory behind on every restore:
   *   every later scheduled backup of the volume would then block on it
   *   forever, and every later restore would answer 409. A subshell's traps are
   *   its own, so both cleanups run.
   *
   * **The `mkdir -p` word is `quote()`d, and that is the defence (H-19).** It
   * was bare, which is the shape that reopened H-12 at
   * `docker/docker.utils.ts` — a `;` in the word ends the command and
   * what follows is a second one this host runs as itself. Unlike that sink
   * and unlike its two H-19 siblings, nothing stood behind it: the word is
   * `{volumeBackupsDirectoryOn(serverId)}/{volumeName}`, and `volumeName` arrives from
   * `restoreVolumeBackupSchema` — it is not an `appName` and never saw
   * `APP_NAME_REGEX`. That made this the one live one of the three, so the
   * word is quoted here and `volumeName` is refused at its DTOs behind it;
   * `dto/volume-backup.dto.ts` carries that half and the reasoning for the
   * pairing.
   */
  const downloadStep = `
	set -e
	echo ${quote([`Volume name: ${volumeName}`])}
	echo ${quote([`Backup file name: ${backupFileName}`])}
	echo ${quote([`Volume backup path: ${volumeBackupPath}`])}
	echo "Downloading backup from S3..."
	mkdir -p ${quote([volumeBackupPath])}
	# The staged tarball is removed however this subshell leaves, because the
	# way it leaves that mattered was an abort. One file, not the
	# directory: this path is shared by every run of this volume.
	trap ${quote([`rm -f ${quote([localTarball])}; echo "Local backup file cleaned up ✅"`])} EXIT
	# The download's status is captured rather than left to \`set -e\`, because
	# 124 has a cause worth naming and every other status has not (H-120). The
	# capture is the shape H-121 settled on for the same reason an \`if !\`
	# condition is not: \`set -e\` is suspended inside one.
	DOWNLOAD_STATUS=0
	${downloadCommand} || DOWNLOAD_STATUS=$?
	if [ "$DOWNLOAD_STATUS" = 124 ]; then
		echo "❌ Volume restore aborted - the download did not finish inside its 30-minute limit"
		echo ${quote([`   '${backupFileName}' was still downloading from bucket '${bucket}' after 30 minutes, so the restore stopped rather than holding volume '${volumeName}' any longer. A link that keeps dribbling bytes is never idle, so the per-connection timeouts cannot end it; this is the bound that does.`])}
		echo ${quote([`   Volume '${volumeName}' has not been touched and still holds the data it held before this restore. Check the destination's throughput to this host, then restore again.`])}
		exit 1
	fi
	if [ "$DOWNLOAD_STATUS" != 0 ]; then
		exit "$DOWNLOAD_STATUS"
	fi
	if [ ! -s ${quote([localTarball])} ]; then
		echo "❌ Volume restore aborted - the backup file did not download"
		echo ${quote([`   Nothing was written to '${localTarball}', so there is nothing to restore from. 'rclone copyto' reports success for a key that does not exist, so check '${backupFileName}' is really in bucket '${bucket}'.`])}
		echo ${quote([`   Volume '${volumeName}' has not been touched and still holds the data it held before this restore.`])}
		exit 1
	fi
	echo "Verifying the downloaded archive..."
	VERIFY_STATUS=0
	VERIFY_ERROR=$(docker run --rm \
		-v ${quote([`${volumeBackupPath}:/backup`])} \
		${VOLUME_TAR_IMAGE} \
		tar -tf ${quote([`/backup/${backupFileName}`])} . 2>&1 >/dev/null) || VERIFY_STATUS=$?
	case "$VERIFY_STATUS" in
		0) ;;
		125|126|127)
			echo "❌ Volume restore aborted - the archive could not be checked because 'docker run' would not run"
			echo "$VERIFY_ERROR"
			echo "   The status it exited with: $VERIFY_STATUS"
			echo ${quote([`   'docker run --rm ${VOLUME_TAR_IMAGE} tar -tf' never read '${backupFileName}', so nothing is known about it either way. That status is docker's own — an unreachable daemon, or the '${VOLUME_TAR_IMAGE}' image this host cannot pull — and not a verdict on the object in bucket '${bucket}'. Read docker's line above, then try the restore again.`])}
			echo ${quote([`   Volume '${volumeName}' has not been touched and still holds the data it held before this restore.`])}
			exit 1
			;;
		*)
			# The second read, without the selector, is the one that separates
			# an unreadable archive from a readable one this application did not
			# write (H-119). Only on a failure, so a healthy restore still costs
			# one container.
			HEADERS_STATUS=0
			HEADERS_ERROR=$(docker run --rm \
				-v ${quote([`${volumeBackupPath}:/backup`])} \
				${VOLUME_TAR_IMAGE} \
				tar -tf ${quote([`/backup/${backupFileName}`])} 2>&1 >/dev/null) || HEADERS_STATUS=$?
			if [ "$HEADERS_STATUS" = 0 ]; then
				echo "❌ Volume restore aborted - the archive is a tar this application did not write"
				echo ${quote([`   'tar' reads the headers of '${localTarball}', but the archive holds no './' entry, so the extraction's 'tar xvf … .' would match no member: volume '${volumeName}' would be removed, re-created and left empty. A volume backup written by this application is tarred from inside the volume, so its members are './' and './…'; an archive made with 'tar cf archive.tar somedir' is not one, however readable it is.`])}
				echo ${quote([`   Check that '${backupFileName}' in bucket '${bucket}' is a volume backup this application wrote rather than another object that happens to be a tar.`])}
			else
				echo "❌ Volume restore aborted - the downloaded file is not a readable tar archive"
				echo "$HEADERS_ERROR"
				echo ${quote([`   '${localTarball}' downloaded and is not empty, but 'tar' cannot read its headers, so extracting it would empty volume '${volumeName}' and put nothing back. Check that '${backupFileName}' in bucket '${bucket}' is a volume backup written by this application and not a truncated or unrelated object.`])}
			fi
			echo ${quote([`   Volume '${volumeName}' has not been touched and still holds the data it held before this restore.`])}
			exit 1
			;;
	esac
	echo "Download completed ✅"
	`;

  /**
   * The destructive half: replace the volume with the tarball that is now
   * known to be on disk.
   *
   * `docker volume rm` is here, in front of the `create`, rather than in the
   * branch that read the labels off. It is guarded by `$VOLUME_EXISTS`
   * instead of by being inside that branch, so there is exactly one removal in
   * the script and nothing can reach it without passing `downloadStep` first —
   * which is the property the ordering test pins.
   *
   * It no longer ends by removing the tarball — `downloadStep`'s trap
   * does that, on this path and on the two aborts alike, because this phase's
   * `tar xvf` is precisely the failure `set -e` used to abort on before a tail
   * statement could run.
   *
   * **This is the only phase that can fail after the volume is gone, so it is
   * the only one that has to describe the damage rather than deny it.**
   * `downloadStep`'s two aborts get to say "has not been touched" because they
   * are on the other side of the removal; this one cannot, and once it
   * said nothing at all — `set -e` ended the subshell at the failing `tar` and
   * the last thing on stdout was `Creating new volume and restoring data...`,
   * which reads as progress. What the operator was left with is a correctly
   * labelled volume holding nothing it should, and no sentence connecting it to
   * `tar`'s complaint.
   *
   * The branch is `if ! …; then … exit 1; fi` rather than a trap or a `||`:
   * `set -e` leaves no room to print a diagnosis between the failure and the
   * exit, and a second `trap … EXIT` would *replace* the tarball cleanup
   * — `trap` sets, it does not append — putting a volume-sized file back on the
   * host. `exit 1` and not a new code, because 1 is what the caller turns into a
   * 400; 75 is the volume lock's and answers 409, and this is a failed request
   * rather than a retry-later.
   *
   * The wording matters more than a log line's would, because this text reaches
   * the caller: `❌` is in `FAILURE_ON_STDOUT`, so `failureReportedOn` selects
   * from that line to the end of stdout and `rcloneFailureMessage` answers the
   * 400 with it rather than with `tar`'s line on stderr. It does not offer the
   * staged tarball — it was once imagined it would, and the tarball trap has
   * since removed it on the way out — so the third line says the retry
   * re-downloads instead.
   *
   * The `tar -tf` check in `downloadStep` is what stops the common way of
   * arriving here — an object that is not an archive at all. What is left for
   * this branch is the residue that check cannot see: a full disk, a permissions
   * error, a truncated data block behind an intact header.
   *
   * **Which is why this no longer says the volume is EMPTY (H-116).** It said so
   * until X10 read it against a real run: the abort fires *during* an
   * extraction, so what the volume holds is the members that landed before
   * `tar` stopped — measured, one `real.txt` from an archive with a bad hard
   * link in it. And it is not the unusual case but the only one left, because
   * every truncation that loses a data block is now caught in front of the
   * removal. An operator told EMPTY who looks and finds files has to decide
   * which of the two to believe, and a partially extracted volume is the worse
   * outcome of the two to start a container on: a database engine will open half
   * its files rather than refuse.
   *
   * **A task container that is already gone counts as removed (#1412).** Stop
   * scales the service to zero and Swarm destroys the stopped task's container
   * itself about a second after Stop returns, so a restore called straight
   * after Stop lists a container in phase 1 that `docker rm` then answers
   * `No such container` for. Gone is what the removal was for, so that line is
   * not a refusal; every other line `docker rm` prints that is not the ID it
   * removed is one, and so is a failure that printed nothing — the guard fails
   * closed. Its output is captured rather than left on stderr because the
   * answer the caller reads starts at the `❌` line (`failureReportedOn`): the
   * reason has to be printed under it, not "above" it.
   */
  const replaceVolumeCommand = `
	if [ -n "$TASK_HISTORY" ]; then
		echo "Removing the exited task containers that still reference the volume: $TASK_HISTORY"
		RM_STATUS=0
		RM_OUTPUT=$(docker rm $TASK_HISTORY 2>&1) || RM_STATUS=$?
		RM_REFUSAL=""
		if [ "$RM_STATUS" != 0 ]; then
			RM_REFUSAL=$(printf '%s\\n' "$RM_OUTPUT" | while IFS= read -r rm_line; do
				case "$rm_line" in
					(""|*"No such container"*|*"no such container"*) continue ;;
				esac
				case " $TASK_HISTORY " in
					(*" $rm_line "*) continue ;;
				esac
				printf '   %s\\n' "$rm_line"
			done)
			if [ -z "$RM_REFUSAL" ] && ! printf '%s\\n' "$RM_OUTPUT" | grep -qi 'no such container'; then
				RM_REFUSAL="   'docker rm' exited $RM_STATUS without saying why."
			fi
		fi
		if [ -n "$RM_REFUSAL" ]; then
			echo "❌ Volume restore aborted - the exited task containers holding the volume could not be removed"
			printf '%s\\n' "$RM_REFUSAL"
			echo ${quote([`   If one of them is running again, '${target.appName}' was started while this restore ran: Stop it and run the restore again.`])}
			echo ${quote([`   Volume '${volumeName}' has not been touched and still holds the data it held before this restore.`])}
			exit 1
		fi
		echo "Exited task containers removed"
	fi
	if [ "$VOLUME_EXISTS" != "0" ]; then
		echo "Removing existing volume and proceeding with restore"
		docker volume rm ${quote([volumeName])} --force
	fi
	echo "Creating new volume and restoring data..."
	docker volume create $VOLUME_LABELS ${quote([volumeName])}
	if ! docker run --rm \
		-v ${quote([`${volumeName}:/volume_data`])} \
		-v ${quote([`${volumeBackupPath}:/backup`])} \
		${VOLUME_TAR_IMAGE} \
		bash -c ${quote([`cd /volume_data && tar xvf /backup/${backupFileName} .`])}; then
		echo "❌ Volume restore aborted - the archive would not extract"
		echo ${quote([`   Volume '${volumeName}' has already been removed and re-created, with its labels, and what it holds now is whatever the archive managed to extract before it failed — not the data it held before this restore, which is gone. Read the 'tar' errors above for why.`])}
		echo ${quote([`   The downloaded copy of '${backupFileName}' has been removed from '${volumeBackupPath}' as this run exited, so restoring again re-downloads it from bucket '${bucket}'.`])}
		exit 1
	fi
	echo "Volume restore completed ✅"
	`;

  const owner = volumeOwnerOf(target);

  /**
   * An exited task container of the target is Swarm's task history only while
   * its service runs no replica, or is gone — a crash-looping replica
   * can be exited at the check and running a second later, mounting the volume
   * mid-restore. **Only an answer that the service is not there counts as
   * gone.** Any other failure of `docker service inspect` — a daemon that is
   * not answering, a node that is not a manager — says nothing about the
   * service, so the container is `unread`: it refuses, and the refusal says
   * why it was not removed.
   */
  const taskHistoryCheck = owner.sweepsTaskHistory
    ? `
					case "$container_state" in
						(exited|dead|created)
							SERVICE_STATUS=0
							SERVICE_REPLICAS=$(docker service inspect --format '{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{else}}not-replicated{{end}}' "$container_service" 2>&1) || SERVICE_STATUS=$?
							if [ "$SERVICE_STATUS" != 0 ]; then
								case "$SERVICE_REPLICAS" in
									(*"No such service"*|*"no such service"*|*"service "*" not found"*) SERVICE_REPLICAS=gone ;;
									(*) SERVICE_REPLICAS=unread ;;
								esac
							fi
							case "$SERVICE_REPLICAS" in
								(0|gone) VERDICT=history ;;
								(unread) VERDICT=unread ;;
							esac
							;;
					esac`
    : '';

  /**
   * The restore itself, in the one order that is safe: three phases in
   * sequence, never interleaved.
   *
   * 1. Decide. Does the volume exist, is anything using it, and what labels
   *    does it carry. Nothing here writes anything, and the in-use refusal
   *    still exits before a single byte is transferred.
   * 2. Fetch, and prove the fetch. `downloadStep`.
   * 3. Replace. `replaceVolumeCommand`, the only phase that touches the volume
   *    — and the only one that removes anything else: the exited Swarm task
   *    containers phase 1 found holding it, removed only once the
   *    tarball is proved, so a failed download leaves them where they were.
   *
   * The download used to be emitted *inside* each of the two proceeding
   * branches, behind the removal in one of them. The cost of hoisting it is
   * that `$VOLUME_EXISTS` and `$VOLUME_LABELS` now travel from phase 1 to
   * phase 3 as variables rather than as control flow, which is the trade: two
   * variables read once each, against a branch order in which a failed download
   * had already emptied the volume.
   *
   * Phases 2 and 3 run inside a **subshell**, which exists for one reason:
   * it is where `downloadStep`'s `trap … EXIT` can live without
   * replacing the volume lock's own. `trap` sets rather than appends, and the
   * lock's `mkdir` fallback — taken on any host without `flock` — registers
   * `trap 'rm -rf "$LOCK_DIR"' EXIT` around this whole body, so a second
   * registration in the same shell would leave the lock directory behind on
   * every single restore and wedge the volume for every later backup of it.
   * Traps set in a subshell are the subshell's own (POSIX 2.12), so both fire.
   *
   * Nothing else changes: phase 1's `$VOLUME_EXISTS` and `$VOLUME_LABELS` are
   * inherited by the subshell, an `exit 1` inside it still ends the run because
   * `set -e` carries the subshell's status out, and the in-use refusal stays
   * outside it — it aborts before anything has been staged to clean up.
   */
  const checkThenRestoreCommand = `
	# Check if volume exists. The 'tr' is not formatting: a BSD 'wc' pads
	# its answer, and both comparisons of $VOLUME_EXISTS below are string
	# comparisons against "0", so "       0" read the wrong way in both — which
	# made the doesn't-exist branch unreachable and aborted the restore at the
	# 'docker volume inspect' in the branch it fell into instead.
	VOLUME_EXISTS=$(docker volume ls -q --filter ${quote([`name=^${volumeName}$`])} | wc -l | tr -d '[:space:]')
	echo "Volume exists: $VOLUME_EXISTS"

	# The --label arguments that put the replacement volume back where the old
	# one was. Empty when there is no volume to read them off yet. Built
	# by docker's own template rather than parsed out of '{{json .Labels}}',
	# because that needs no jq on the host running the restore.
	VOLUME_LABELS=""

	# The exited task containers phase 3 removes in front of the volume.
	# Empty unless the in-use check below sorts every container into it.
	TASK_HISTORY=""

	if [ "$VOLUME_EXISTS" = "0" ]; then
		echo "Volume doesn't exist, proceeding with direct restore"
	else
		echo "Volume exists, checking for containers using it (including stopped ones)..."
		
		# Every container referencing this volume, running or not — Docker's
		# refcount counts exited ones too, so 'docker volume rm' would.
		CONTAINERS_USING_VOLUME=$(docker ps -a --filter ${quote([`volume=${volumeName}`])} --format '{{.ID}}|{{.Names}}|{{.State}}|{{.Label "${owner.ownerLabel}"}}|{{.Label "com.docker.swarm.service.name"}}|{{.Labels}}')

		# Sorted by the owner label, matched exactly. 'history' is an
		# exited task container of this target while its Swarm service runs no
		# replica — what Swarm keeps after Stop, and what the restore removes
		# itself. 'unread' is one whose service Docker would not answer for;
		# 'own' is any other container of this target, 'foreign' anything else.
		# All three refuse the restore and none is ever removed by it.
		CLASSIFIED=""
		if [ -n "$CONTAINERS_USING_VOLUME" ]; then
			CLASSIFIED=$(printf '%s\\n' "$CONTAINERS_USING_VOLUME" | while IFS='|' read container_id container_name container_state container_owner container_service labels; do
				if [ -z "$container_id" ]; then continue; fi
				VERDICT=foreign
				if [ "$container_owner" = ${quote([target.appName])} ]; then
					VERDICT=own${taskHistoryCheck}
				fi
				echo "$VERDICT|$container_id|$container_name|$container_state|$labels"
			done)
		fi
		TASK_HISTORY=$(printf '%s\\n' "$CLASSIFIED" | grep '^history|' | cut -d'|' -f2 | tr '\\n' ' ')
		BLOCKING=$(printf '%s\\n' "$CLASSIFIED" | grep -v '^history|' | grep '|' || true)

		if [ -z "$BLOCKING" ]; then
			if [ -n "$TASK_HISTORY" ]; then
				echo ${quote([`Volume exists and is referenced only by exited task containers Swarm kept for '${target.appName}', which runs no replica — they are removed just before the volume is replaced:`])} "$TASK_HISTORY"
			else
				echo "Volume exists but no containers are using it"
			fi
			VOLUME_LABELS=$(docker volume inspect ${quote([volumeName])} --format '{{range $k, $v := .Labels}}--label {{$k}}={{$v}} {{end}}')
			echo "Volume labels carried over: $VOLUME_LABELS"
		else
			echo ""
			echo "⚠️  WARNING: Cannot restore volume as it is currently in use!"
			echo ""
			echo ${quote([`📋 The following containers are using volume '${volumeName}':`])}
			echo ""
			
			printf '%s\\n' "$BLOCKING" | while IFS='|' read verdict container_id container_name container_state labels; do
				echo "   🐳 Container: $container_name ($container_id)"
				echo "      Status: $container_state"
				
				# Determine container type
				if echo "$labels" | grep -q "com.docker.swarm.service.name="; then
					SERVICE_NAME=$(echo "$labels" | grep -o "com.docker.swarm.service.name=[^,]*" | cut -d'=' -f2)
					echo "      Type: Docker Swarm Service ($SERVICE_NAME)"
				elif echo "$labels" | grep -q "com.docker.compose.project="; then
					PROJECT_NAME=$(echo "$labels" | grep -o "com.docker.compose.project=[^,]*" | cut -d'=' -f2)
					echo "      Type: Docker Compose ($PROJECT_NAME)"
				else
					echo "      Type: Regular Container"
				fi
				if [ "$verdict" = unread ]; then
					echo "      Not removed: 'docker service inspect' did not say whether this container's service still runs a replica, so it is not known to be task history"
				fi
				echo ""
			done
			
			echo ""
			echo "🔧 To restore this volume, please:"
			# Which step 1 is true depends on whose containers are listed:
			# Stop only reaches the target's own.
			if printf '%s\\n' "$BLOCKING" | grep -qE '^(own|unread)\\|'; then
				echo ${quote([`   1. ${owner.freeStep}`])}
				if printf '%s\\n' "$BLOCKING" | grep -q '^foreign|'; then
					echo ${quote([`      The containers listed above that are not part of '${target.appName}' hold this volume as well, and nothing done to '${target.appName}' reaches them: stop and remove them wherever they are managed`])}
				fi
			else
				echo ${quote([`   1. Stop and remove the containers listed above wherever they are managed — none of them is part of '${target.appName}', so no control on '${target.appName}' in Cloudgate frees this volume`])}
			fi
			echo "   2. Run the restore operation again"
			echo ""
			echo "   Removing the volume by hand is not a step: once nothing references it, the restore removes and re-creates it itself, labels and all."
			echo ${quote([`   It is not possible before step 1 either — Docker counts exited containers in a volume's refcount, so 'docker volume rm ${volumeName}' refuses while any container still references it, --force included.`])}
			echo ""
			echo "❌ Volume restore aborted - volume is in use"
			
			exit 1
		fi
	fi
	(
	${downloadStep}
	${replaceVolumeCommand}
	)
	`;

  /**
   * Is the destination answering at all — asked first, and **outside the volume
   * lock** (reopened).
   *
   * `downloadCommand` cannot answer this cheaply and should not try. Its retry
   * budget exists to survive a link that is degraded but moving, and the same
   * counter governs a connect that never completes, so the flags that took a
   * stalling endpoint from 1083 s-and-nothing to 181 s-and-every-byte take an
   * absent one from 242 s to 641 s. The probe is what closes that: the listing
   * profile refuses the same dead socket in 40 s and answers through the
   * stalling proxy in 0 s, so what is unreachable is refused here and what is
   * merely slow reaches the transfer built for it. See
   * `reachabilityProbeCommand`, which also states why a key that is *absent*
   * passes this and is still caught by the `-s` test below.
   *
   * Outside the lock is the second half, and the reason G-39's eighteen minutes
   * were worse than a slow request: `withVolumeLock` is held for the whole
   * script, so every backup, restore and Remove containers on the volume answers
   * 409 for as long as the download runs. A destination that is not there now
   * costs the volume no lock at all rather than four minutes of one — which is
   * also what makes this safe to put in front: it takes nothing and touches
   * nothing, so a false refusal here leaves exactly the state a refusal one line
   * later would.
   *
   * The probe's own stderr is echoed into the abort rather than left on the
   * script's stderr, because `❌` puts this block on the path
   * `rcloneFailureMessage` prefers and rclone's line — a refused
   * connection, a 403, an endpoint that does not resolve — is the half of the
   * answer this builder cannot write in advance.
   */
  const reachabilityPreflight = `
		echo "Checking the backup destination is reachable..."
		if ! PROBE_ERROR=$(${reachabilityProbeCommand(backupPath)} 2>&1 >/dev/null); then
			echo "❌ Volume restore aborted - the backup destination did not answer"
			echo "$PROBE_ERROR"
			echo ${quote([`   Bucket '${bucket}' did not respond to a listing of '${backupFileName}', so the restore stopped before downloading anything.`])}
			echo ${quote([`   Volume '${volumeName}' has not been touched, and its lock was never taken — nothing else waiting on '${volumeName}' was held up by this.`])}
			exit 1
		fi
		`;

  /** The probe, then the lock round everything else — and that order is the
   * point, so the two are composed here rather than at each `return`. */
  const probeThenLock = (body: string) =>
    `${reachabilityPreflight}${withVolumeLock(
      { serverId, volumeNames: [volumeName], mode: 'fail-fast' },
      body,
    )}`;

  /**
   * A bucket's Garage is stopped by the restore itself, as the backup's
   * stop option stops it: its replica count read and proved a number before
   * anything is stopped, the scale to 0 and the whole check-then-restore in a
   * subshell whose `trap restore_workload EXIT` scales it back to that count
   * on every exit — a refusal, a failed download or untar, or the success.
   * `buildVolumeBackupScript`'s `stopThenBackUp` carries why it is a subshell
   * (the lock's own trap) and why a failed scale-up is `exit 1`, never
   * `|| true`. The scale to 0 waits for the tasks to stop, so what holds the
   * volume afterwards is the service's exited task history, which
   * `checkThenRestoreCommand` sweeps while it runs no replica.
   */
  if (target.serviceType === 'bucket') {
    const service = quote([target.appName]);
    return probeThenLock(`
		echo "=== VOLUME RESTORE FOR BUCKET ==="
		echo ${quote([`Bucket: ${target.appName}`])}
		ACTUAL_REPLICAS=$(docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' ${service})
		echo "Actual replicas: $ACTUAL_REPLICAS"
		case "$ACTUAL_REPLICAS" in
			''|*[!0-9]*)
				echo "❌ Volume restore aborted - the replica count could not be read, so nothing was stopped"
				echo ${quote([`   'docker service inspect' did not answer a replica count for bucket '${target.appName}', so this restore stopped before scaling anything down; the bucket and volume '${volumeName}' are untouched.`])}
				echo "   What it answered instead: '$ACTUAL_REPLICAS'"
				exit 1
				;;
		esac
		restore_workload() {
			echo "Starting bucket to $ACTUAL_REPLICAS replicas"
			if docker service update --replicas="$ACTUAL_REPLICAS" --with-registry-auth ${service}; then
				return 0
			fi
			echo "❌ Volume restore failed - the bucket was scaled to 0 for the restore and would not scale back up"
			echo ${quote([`   Bucket '${target.appName}' is DOWN at 0 replicas. Read the 'docker service update' error above, then scale it back up by hand.`])}
			echo "   The replica count it was running before this restore: $ACTUAL_REPLICAS"
			exit 1
		}
		(
			trap restore_workload EXIT
			echo "Stopping bucket to 0 replicas"
			docker service update --replicas=0 ${service}
			${checkThenRestoreCommand}
		)
		`);
  }

  if (target.serviceType === 'application') {
    return probeThenLock(`
		echo "=== VOLUME RESTORE FOR APPLICATION ==="
		echo ${quote([`Application: ${target.appName}`])}
		${checkThenRestoreCommand}
		`);
  }

  return probeThenLock(`
		echo "=== VOLUME RESTORE FOR COMPOSE ==="
		echo ${quote([`Compose: ${target.appName}`])}
		echo ${quote([`Compose Type: ${target.composeType}`])}
		${checkThenRestoreCommand}
		`);
};
