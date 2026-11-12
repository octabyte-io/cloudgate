import { quote } from 'shell-quote';

/**
 * How long a deployment log survives on the machine that wrote it, and the
 * sweep that enforces it (ADR-0020).
 *
 * **What was wrong.** `deployment.logPath` is created on the build host by
 * `DeploymentsService.initializeLog` and **nothing in the product had ever
 * deleted one, on any path, on any Server.** There is no `delete(deployment)`
 * anywhere in the tree, the only log cron rotates Traefik's access log
 * (`settings/log-cleanup.service.ts`), and `CleanupService`'s Maintenance
 * sweeps are all `docker` prunes that never touch the platform's own tree. So
 * every deployment log every Application ever wrote is still on its build host —
 * `{logsDirectoryOn}/{appName}/{deploymentId}.log`, one file per deployment,
 * for the life of the install.
 *
 * **Why this is retention and not a teardown step, which is the whole shape of
 * the answer.** Structurally it looks like the preserved-images case: the row cascades,
 * and the file on the machine becomes unnameable. But the cascade is not what strands
 * these
 * — they are stranded *from birth*, because no path has ever deleted a log
 * file, and a delete-time reclamation would leave the question *"how far back
 * can I look?"* answered *"as far back as your oldest surviving
 * Application"*. Worse, it would leave every log already on disk under an
 * Application that has since been deleted there for ever, which is the larger
 * half of the leak. So the predicate is **age on the file** rather than
 * anything on the row, and that choice is what lets one sweep reach both
 * populations: the logs whose Deployment rows are still there and the logs
 * whose rows the cascade destroyed years ago. ADR-0020 carries the argument in
 * full, including why the window is one constant rather than one per status.
 * The delete of an owner *also* removes that owner's directory
 * (`common/teardown-steps.ts`' `reclaimDeploymentLogs`); this sweep remains
 * the answer for everything a delete cannot reach.
 *
 * **A `find` over the tree rather than a query over the rows, and rather than
 * `fs`.** `CleanupService.cleanMonitoring` recreates its directory through
 * `node:fs`, which is available to it because the monitoring store is only ever
 * on the platform host. Deployment logs are not: an Application that builds on
 * a Server wrote its log there, so the sweep has to reach every Server, and
 * `execOnServer` already dispatches one command shape to both. Two mechanisms
 * — `fs` locally and a shell remotely — would be two behaviours to keep in
 * agreement for no gain, and the local branch of `execOnServer` runs the same
 * program.
 */

/**
 * How many days a deployment log is kept, everywhere, for every status.
 *
 * **One window, chosen as if every log were a failed one.** The obvious design
 * is two — a short window for a Deployment that succeeded and a long one for
 * one that failed, because a failed build's log is the one an operator comes
 * back to. That asymmetry is *intended* here and delivered by the size of this
 * number rather than by a second mechanism, and the reason is that status lives
 * only on the row while this sweep deliberately asks the tree:
 *
 * - A row-driven pass cannot see the logs whose rows are already gone, which is
 *   the population this ticket is mostly about, so it could not replace this
 *   sweep — only sit beside it as a second one.
 * - Implementing it as a second `find` would mean excluding the failed
 *   deployments' filenames from the shorter window, and that exclusion list is
 *   unbounded in the number of failed deployments in the gap between the two
 *   windows — a command-length failure on exactly the install that has the most
 *   logs.
 * - Resolving each row's machine instead would mean a second copy of
 *   `DeploymentsService.resolveLogServer`'s five-parent fan-out with no
 *   `PermissionCtx` to scope it, which is a rule this codebase has twice been
 *   bitten by keeping two copies of (`buildHostServerId`, `preservedImageServerId`).
 *
 * **90 days.** A quarter is the longest span over which an operator plausibly
 * asks *"what did that build do?"*, and it is the answer for the *failed* log
 * by the reasoning above; a successful build's log would justify 30. The cost
 * of applying the longer number to both is disk on the build host, and it is
 * small: a deployment log is the build's whole stdout, order 0.5 MB, so an
 * Application deploying three times a day holds ~140 MB at 90 days and a
 * ten-Application install ~1.4 GB — against an unbounded tree today.
 *
 * **A constant rather than a setting, and the two candidate homes are why.**
 * `web_server_settings.logCleanupCron` is about *when* the Traefik rotation
 * fires rather than how long anything is kept, and it is instance-wide while
 * these files sit on many Servers; `server.metricsConfig.retentionDays` is
 * per-Server but is monitoring's own contract, about metric samples the agent
 * collects, and borrowing it would make a deployment-log window mean something
 * to `MonitoringService`. Neither is nearly free, so the alternative is a new
 * column and a migration for a number nobody has asked to change. If one ever
 * does, `web_server_settings` is where it goes, beside `logCleanupCron`.
 */
export const DEPLOYMENT_LOG_RETENTION_DAYS = 90;

/**
 * The nightly sweep, as one shell program per machine.
 *
 * `root` is `logsDirectoryOn`'s answer for the machine this is being sent to —
 * this instance's own tree for the platform host, `/etc/cloudgate/logs` on a
 * Server — and the caller is where that is decided, so a wrong-root sweep
 * cannot be produced here.
 *
 * Every clause is load-bearing:
 *
 * - **`-name '*.log'`**, so the sweep names the files this platform writes and
 *   nothing else. The logs root is the platform's own tree, but "the platform's
 *   tree" is not a licence to delete whatever is in it: an operator's file and
 *   any subtree the platform grows there later both survive this.
 * - **`-mtime +N` and not a stored timestamp.** The mtime *is* the moment the
 *   deployment stopped writing, which is the fact retention is about, and it is
 *   the only such fact available on a Server that holds no database. It also
 *   makes an in-flight build structurally unselectable — its log's mtime is now
 *   — which is why this needs no lock and no coordination with the queue. Note
 *   `-mtime +N` is *strictly more than* N 24-hour periods, so the window errs
 *   by keeping a log up to a day longer than the constant says, which is the
 *   safe direction.
 * - **`-print` before `-delete`**, so the caller can journal what a run reaped
 *   rather than guessing. `-delete` implies `-depth`; the print has to precede
 *   it to name a file that is about to go.
 * - **The `[ -d … ] || exit 0` guard.** `find` on a missing directory exits
 *   non-zero, and a host that has never run a build has no logs root — without
 *   this, every such Server would journal a failed sweep every night for ever.
 * - **The empty-directory pass is `|| true`.** `{appName}` directories left
 *   behind by a fully reaped Application are cosmetic, and `-empty` is the one
 *   predicate here that is not in every `find`; a host whose `find` lacks it
 *   must still get the reaping.
 *
 * `quote()`d, like every interpolation into a shell program (§2.9,
 * `builders/build-strategy.ts`). The root is either the `/etc/cloudgate`
 * literal or `CLOUDGATE_DIRECTORY`, which `isValidCloudgateDirectory` holds to
 * an absolute path with no `..` segment — a charset at a distance, which is
 * exactly the shape that failed twice at `getCreateFileCommand` (H-12, H-34),
 * and the quoting is the defence rather than the validation behind it.
 */
export function logRetentionSweepCommand(root: string): string {
  const quoted = quote([root]);
  return [
    `[ -d ${quoted} ] || exit 0`,
    `find ${quoted} -type f -name '*.log' -mtime +${DEPLOYMENT_LOG_RETENTION_DAYS} -print -delete`,
    `find ${quoted} -mindepth 1 -type d -empty -delete || true`,
  ].join('\n');
}

/**
 * Whether this Deployment is old enough that {@link logRetentionSweepCommand}
 * has been past its log — the half of ADR-0020 that answers a *read* rather
 * than doing a removal.
 *
 * **The row and the file are two lifetimes, and this is how the read tells
 * them apart.** `DeploymentsService.readLogs` ends its command
 * `2>/dev/null || echo ""`, so a log that is not there and one that is empty
 * are the same answer: the empty string. That was already true before
 * retention existed and meant *"this build has not written anything yet"*,
 * which is the right thing to say about a queued deployment. It is the wrong
 * thing to say about a deployment whose log this platform deleted on purpose,
 * and ADR-0007 makes the read answer *for the Deployment* — so the row's own
 * age is what separates the two, at no extra round trip and with no change to
 * the command.
 *
 * A `404` was rejected: the Deployment exists, `ownerOf` resolves it, and this
 * route already spends `404` on *"no such deployment"* — including the
 * parentless row `run-history.e2e-spec.ts` inserts by hand. Answering `404` for
 * a row the caller can see in its own history list would make the status code
 * mean two different things on one route.
 *
 * An unreadable `createdAt` reads as *inside* the window, deliberately:
 * `isoTimestamp` is a `text` column, so a row written by a migration or a
 * fixture can carry a value `Date` cannot parse, and the alternative is telling
 * an operator their log was reaped when the truth is that this route cannot
 * tell.
 */
export function isPastLogRetention(
  createdAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!createdAt) return false;
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) return false;
  const cutoff =
    now.getTime() - DEPLOYMENT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return at < cutoff;
}

/**
 * Whether the log file is still on the machine that wrote it, as a shell
 * *program* — the question {@link isPastLogRetention} is only a proxy for.
 *
 * **What broke.** An earlier fix gave `DeploymentLogsGateway` the same answer
 * `GET /deployments/:id/logs` gives and left the two *predicates* different:
 * `DeploymentsService.readLogs` asks absence **and** age
 * (`!stdout.trim() && isPastLogRetention(createdAt)`) while the socket asked
 * age alone. So for a Deployment past the window whose log file is still there,
 * HTTP streamed the log and the socket closed `4013` saying it had been reaped
 * — the same disagreement that fix set out to close, pointing the other way, and
 * against the gateway's own stated contract that *"the socket answers the same
 * thing `GET /deployments/:id/logs` answers"*. That state is not hypothetical:
 * {@link logRetentionSweepCommand} runs on a nightly cron, its `-mtime +N` is
 * strictly more than N periods so it keeps a log up to a day longer, and
 * `DeploymentLogRetentionService` is best-effort per machine — a Server
 * unreachable at 04:20 is skipped entirely and its logs survive indefinitely
 * while every row on it ages past the window.
 *
 * **Why a probe at all, when age was meant to be the answer.** For the *read*
 * it is: `readLogs` already holds the file's contents, so absence is free and
 * age is the only thing it needs to add. The socket holds nothing — `tail -n +1
 * -f` on a missing file follows nothing for ever rather than answering — so
 * absence has to be asked for. It is asked **only after** the age test says
 * yes, which is what keeps the common case at exactly the round trips it had:
 * one probe on the rare past-retention path, none at all inside the window.
 *
 * **Why a program with an answer on stdout rather than `test -f` over the argv
 * transport, which is the shape that first suggests itself.**
 * `RemoteExecService` rejects on a non-zero exit, so an exit-code probe
 * delivers *"the file is gone"* and *"no route to the host"* as the same
 * rejection — and those two must do opposite things here, one closing the
 * socket and the other not. That is `common/workload-presence.ts`'s H-95
 * exactly, and the answer is the same one: every outcome the caller can act on
 * exits 0 and names itself on stdout. {@link readLogFileAbsence} is the other
 * half of the contract.
 *
 * **Rejected: folding the test into the tail program** — `[ -f … ] || exit 66`
 * ahead of `tail`, with the handler mapping the exit code to the close. It is
 * more honest about the file's actual state and it would cover a file missing
 * for reasons other than age, and it still cannot be used, for two independent
 * reasons. The close has to happen **before** the lease and the keep-alive are
 * armed — `DeploymentLogsGateway` records why — and a folded test answers only
 * once the channel is open and its exit arrives, which is after both. And the
 * local branch spawns `tail` as argv through `LocalProcessChannelService`,
 * where no `/bin/sh -c` sees the words at all; folding the test in would
 * mean putting a stored path back through a shell on the one branch that has
 * escaped it, to learn something one extra round trip answers.
 *
 * **The transport rules this program is held to** (`RemoteExecService`): POSIX,
 * because a remote command carrying an environment is read by `sh -s` rather
 * than by the account's login shell; no `read` loop and no other stdin
 * consumer, because with an environment the program *is* on that shell's stdin
 * and under bash a stdin-reading command eats the rest of the script and exits
 * 0; and `quote()`d, like every interpolation into a shell program (§2.9).
 * `logPath` is the stored `deployment.logPath` column and `readLogs` quotes it
 * for the same reason — H-38: a `$(…)` in a stored path substitutes inside
 * `"…"` exactly as it would bare.
 *
 * `-f` and not `-e`, because the socket's next act is `tail -n +1 -f` on this
 * path and a directory standing there is not a log either.
 */
export function logPresenceProbeCommand(logPath: string): string {
  return `if [ -f ${quote([logPath])} ]; then echo present; else echo absent; fi`;
}

/**
 * {@link logPresenceProbeCommand}'s answer, read the way
 * `common/workload-presence.ts`' `readWorkloadPresence` reads its own.
 *
 * **A thunk rather than a string, because a rejection is part of the answer.**
 * The transport can fail before any shell runs, and that outcome has to be told
 * apart from the shell saying `absent` — so the call happens in here.
 *
 * **Only a positive `absent` is an absence.** A rejection, an empty answer and
 * an sshd login banner are all *this could not be established*, and they read
 * as present for {@link isPastLogRetention}'s own reason one artifact along: an
 * unreadable `createdAt` reads as inside the window because telling an operator
 * their log was reaped when the truth is that nothing could tell is worse than
 * saying nothing. The socket then falls through to the tail, which reports the
 * transport failure itself — the answer it gave before this gateway knew about
 * retention at all.
 */
export async function readLogFileAbsence(
  probe: () => Promise<string>,
): Promise<boolean> {
  try {
    return (await probe()).trim() === 'absent';
  } catch {
    return false;
  }
}

/**
 * What `GET /deployments/:id/logs` answers for a log retention has reaped.
 *
 * A sentence rather than an empty body, because the two are not the same claim
 * and the operator's next move differs: nothing to read yet is a build to wait
 * for, and a reaped log is a build whose output is gone for good. It names the
 * window so the answer carries its own explanation — the number is not
 * discoverable from any route.
 *
 * `text/plain`, because that is what this route answers with (its controller
 * says why), so it composes with a log tail rather than needing a second
 * response shape.
 */
export function reapedLogNotice(): string {
  return `This deployment's log is no longer on the machine that wrote it: Cloudgate keeps deployment logs for ${DEPLOYMENT_LOG_RETENTION_DAYS} days and this deployment is older than that.\n`;
}
