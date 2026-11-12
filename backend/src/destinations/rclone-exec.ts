import { Logger } from '@nestjs/common';
import { quote } from 'shell-quote';
import type { InstanceMode } from '../instance-mode/instance-mode.service';
import { ExecError } from '../remote/exec-error';
import type {
  ExecResult,
  RemoteExecService,
} from '../remote/remote-exec.service';
import {
  getS3CredentialsEnv,
  redactS3CredentialsInError,
  MIN_MASKED_CREDENTIAL_LENGTH,
  RCLONE_INVOCATION_ENV,
} from './s3-credentials';
import type { S3Credentials } from './s3-credentials';

export interface RcloneExecOptions {
  /** Whose bucket the command reads or writes, and whose credentials it needs. */
  destination: S3Credentials;
  /** The Server the command runs on; null runs it on this instance's host. */
  serverId: string | null;
  /**
   * The instance-mode rule a `null` {@link serverId} is held to: on the
   * Hosted instance the platform host runs no customer's rclone (ADR-0053).
   * Required, so no caller can leave the backstop out; `InstanceMode` in the
   * app.
   */
  platformHost: Pick<InstanceMode, 'refusePlatformHost'>;
  /**
   * The shell the command needs, when POSIX `sh` is not enough — the database
   * backup script opens with `set -eo pipefail`. Left unset otherwise, so each
   * side picks its own default.
   */
  shell?: string;
  /**
   * Variables the *command* needs, as against the ones rclone needs — a
   * database password the dump tool reads from its environment rather than from
   * its argv (`backups/commands/utils.ts`'s `DATABASE_PASSWORD_ENV`).
   *
   * Here rather than at the call sites' own exec, because the credentials and
   * the command already travel together through this one door and the whole
   * argument was that the forgettable half must not be a call site's decision.
   * Merged *under* the S3 credentials for a reason — a name collision can
   * never blank one — and refused by {@link assertCredentialFreeCommand} if the
   * same value also appears in the command, which is the regression this
   * parameter exists to make unshippable rather than conventional.
   */
  env?: Record<string, string>;
}

/**
 * Retry and timeout flags for any rclone call made in front of a waiting HTTP
 * caller.
 *
 * rclone's defaults are built for an unattended transfer that should survive a
 * blip — 3 retries, 10 low-level retries, a 1m connect timeout — so a
 * destination whose endpoint is simply *not there* keeps the request open for
 * minutes and answers nothing. Every caller has someone looking at a screen, so
 * a fast refusal carrying rclone's own diagnosis beats a long wait carrying the
 * same one.
 *
 * `idle` is the IO idle timeout: 10s is right for the one-object probe, longer
 * for a listing, which legitimately takes a while on a large bucket.
 *
 * Here rather than in `destinations.service.ts`, where it was written: it
 * bounds every rclone invocation, this file is the one door every rclone
 * invocation goes through, and the alternative made `volume-backup-commands.ts`
 * — a pure script builder — import a Nest service module for one constant
 * (§1.4).
 *
 * Exported for the two calls found unbounded — the backup-file browser's
 * `rclone lsjson` and the volume restore's `rclone copyto` download, which took
 * 95 s and 5 min 55 s against a stopped MinIO while this one answered in 0.0 s.
 * A second copy of the same four flags was the alternative and is the thing
 * §1.4 exists to refuse: the numbers have to move together or the next
 * measurement is of whichever copy was forgotten.
 *
 * **The retry knobs are parameters because a listing and a bulk download want
 * different answers, and the defaults are the listing's.** A listing that gets
 * nothing for its idle window is not going to get anything, so one attempt is
 * right. A multi-GB restore in front of an HTTP caller is the opposite case: it
 * can legitimately stall for tens of seconds on a small host under memory
 * pressure, and cutting a real restore short would be a worse bug than the hang
 * this was written for — so it takes a longer idle and a longer connect timeout
 * for a cross-region endpoint a same-host probe never reaches. Callers state
 * those; they are not derivable from the idle value.
 *
 * **`retries` and `lowLevelRetries` are not two sizes of the same thing, and
 * that mistake is the whole reason this was reopened.** `--retries` is the *sync's*: it
 * starts the object again at byte zero and throws away everything the failed
 * attempt fetched. `--low-level-retries` is the *operation's*: it re-issues the
 * ranged GET at the offset already on disk, so the bytes in hand cost nothing.
 * G-39 read as "the bound is too tight" and was in fact the first knob doing
 * exactly what it says — against a proxy forwarding 40 MB per connection and
 * then holding the socket open, the staged file was watched reaching 79 MB and
 * 119 MB and being reset, until `--retries 2` ran out with nothing. rclone's own
 * defaults completed the same object over the same link, and not because they
 * are more generous overall: because `--low-level-retries 10` never discards.
 *
 * So every call here takes **`--retries 1`** — restarting a multi-GB object from
 * zero is never the answer for something a person is waiting on, and on the
 * piped restores it is worse than useless, since the engine downstream has
 * already been fed the head of the dump. A download **to a file** then takes
 * rclone's own **`--low-level-retries 10`**, which is what lets a
 * degraded-but-moving link assemble. Measured, same 150 MB object through the
 * same stalling proxy, arms paired with the proxy restarted between them:
 *
 *     --retries 2 --low-level-retries 3   1083 s   rc=5   0 B          (shipped)
 *     rclone's own defaults                901 s   rc=0   157 289 472 B
 *     --retries 1 --low-level-retries 10   181 s   rc=0   157 289 472 B
 *
 * **`rclone cat` is the exception, and it is measured rather than assumed.** A
 * stream already written to stdout cannot be rewound, so rclone does not retry
 * it at all: the same object through the same proxy stopped at 60 s with
 * 39 997 344 bytes and rc=5 at *both* 1 and 10 low-level retries. The two piped
 * restores therefore keep the default 1 — raising it for symmetry would buy
 * nothing and is not free: against a socket that swallows packets the same
 * `rclone cat` answered in 80 s at 1 and 626 s at 10. That also means those two
 * have no defence against an endpoint that stalls mid-stream, by rclone's
 * construction rather than by anything chosen here; what is bounded is how long
 * they wait to find out.
 *
 * **What raising it costs, and who pays it.** The same counter governs a connect
 * that never completes, so the case this was originally written for gets longer,
 * not shorter: against a socket that swallows packets the restore's `copyto`
 * answered in 242 s under `--retries 2 --low-level-retries 3` and in 641 s under
 * the row above. That is what `reachabilityProbeCommand` is for — the same dead
 * socket refuses the probe in 40 s and a stalling-but-alive endpoint answers it
 * in 0 s, so an endpoint that is not there is refused before a transfer budget
 * is ever spent, and one that is merely degraded is waved straight through to
 * it. The two numbers this issue said had to be traded against each other are
 * not on the same axis at all; each is now bounded by the thing that can see it.
 *
 * **None of these five bounds the request, and `maxDuration` is the one that
 * looks like it does (H-120).** `--timeout` is IO idle and
 * applies per connection, `--contimeout` is one connect, and the retry counts
 * multiply them — so an endpoint that neither refuses nor finishes is idle by
 * nobody's definition and the product of the four is not a bound at all. G-39
 * measured 18 min 03 s on the volume restore with `withVolumeLock` held
 * throughout, which is every other operation on that volume answering 409 for
 * eighteen minutes because one endpoint was degraded. That reasoning was right
 * and the flag it was spent on was the wrong mechanism.
 *
 * **`--max-duration` is accepted and inert below rclone 1.64.** Measured three
 * ways, ending with the arm that removes all doubt: `--max-duration 1ms` against
 * a *healthy* endpoint transferred all 157 286 400 bytes, rc=0, in 1 s. On
 * `rclone v1.60.1-DEV` — whose own `--cutoff-mode` help reads "Mode to stop
 * transfers when reaching the **max transfer** limit" — the cutoff mode governs
 * `--max-transfer` and not `--max-duration`, which it reaches at 1.64. This is
 * not an environment quirk: `deploy/install.sh` installs rclone from apt, and
 * apt's rclone on the platform `docs/deploy.md` documents *is* 1.60.1, so the
 * version the flag does not work on is the version this product ships itself.
 *
 * So **the request bound is a process bound and it lives in
 * `bulkDownloadCommand`**, which no rclone version can ignore. `maxDuration`
 * stays because it costs nothing and is a second bound on a host whose rclone is
 * new enough; it is not what makes the request finite, and a reader who reaches
 * for it as if it were is the rediscovery this paragraph exists to stop.
 *
 * `30m` on the two bulk downloads, which is above every slow success this repo
 * has measured (the worst is the 901 s row above) and therefore never cuts a
 * transfer that is still moving. It is the residual tail — a link that answers
 * the probe and then dies without ever going idle — and nothing else now reaches
 * it: with the probe in front, an endpoint that is simply absent no longer pays
 * this cap or the retry budget under it. The process bound carries the same
 * number for the same reason.
 *
 * Optional, and **emitted only when a caller states it**, for two reasons. The
 * listings do not need it — an idle bound of a few seconds already terminates
 * them — and adding a flag to their string would change what the two call sites
 * emit, which their tests pin byte for byte. And the
 * value is not derivable from anything else here: it is a judgement about how
 * long a person and a lock may be held, weighed against cutting a real transfer
 * short, and the bulk downloads are the only calls where that judgement has to
 * be made.
 */
export const boundedRcloneFlags = ({
  idle,
  contimeout = '5s',
  retries = 1,
  lowLevelRetries = 1,
  maxDuration,
}: {
  /** The **IO idle** bound, not a total. A transfer still moving is not idle. */
  idle: string;
  contimeout?: string;
  /** Attempts at the **whole object**, each starting again at byte zero. 1. */
  retries?: number;
  /** Attempts at the **current offset**, which keep what is already on disk. */
  lowLevelRetries?: number;
  /**
   * The wall-clock bound rclone applies to the whole transfer, retries
   * included — **on rclone ≥ 1.64 only** (H-120). Unset for a call the idle
   * bound already terminates; stated for the bulk downloads, whose real bound is
   * `bulkDownloadCommand`'s process timeout.
   */
  maxDuration?: string;
}) =>
  [
    `--retries ${retries}`,
    `--low-level-retries ${lowLevelRetries}`,
    `--timeout ${idle}`,
    `--contimeout ${contimeout}`,
    ...(maxDuration ? [`--max-duration ${maxDuration}`] : []),
  ].join(' ');

/**
 * The one profile every **bulk download in front of an HTTP caller** runs on:
 * the volume restore's `rclone copyto` and the database restore's mongo
 * `rclone copy`.
 *
 * One constant rather than the same five fields written out twice, for the
 * reason `boundedRcloneFlags` itself exists (§1.4): these numbers were arrived
 * at by measurement, they have already been wrong twice, and the next
 * measurement has to move both call sites or it is a measurement of whichever
 * copy was forgotten. The two are not coincidentally equal — they are the same
 * operation, a several-hundred-megabyte object landing on a local disk while
 * somebody waits — so an argument for changing one is an argument for changing
 * the other.
 *
 * `boundedRcloneFlags` carries every value's reasoning. What is *not* here is
 * the `rclone cat` shapes, which look like the same thing and are not: a stream
 * already written to stdout cannot be rewound, so `--low-level-retries` is inert
 * on them, and a wall clock over one of those would bound the *engine's* import
 * rather than the transfer.
 *
 * **These are the flags only. The bound that actually applies to the request is
 * `bulkDownloadCommand`'s** — `--max-duration` here does nothing below rclone
 * 1.64 (H-120), so a call site that takes this constant and not that function
 * has an unbounded download.
 */
export const bulkDownloadRcloneFlags = boundedRcloneFlags({
  idle: '60s',
  contimeout: '10s',
  retries: 1,
  lowLevelRetries: 10,
  maxDuration: '30m',
});

/**
 * The wall-clock bound on a bulk download, expressed in seconds because that is
 * the only form every `timeout` accepts.
 *
 * 1800 rather than a fresh judgement: it is `maxDuration`'s `30m`, and the two
 * are the same decision about how long a person and a volume lock may be held.
 * `boundedRcloneFlags` carries why that number and not a smaller one — `09b6ff1`
 * exists because the first bounding of this download was tight enough to abandon
 * a real transfer.
 */
const BULK_DOWNLOAD_WALL_CLOCK_SECONDS = 1800;

/**
 * The whole bulk-download command — the flags **and** the wall clock that
 * actually bounds it (H-120).
 *
 * `bulkDownloadRcloneFlags`' `--max-duration` is accepted and does nothing on
 * the rclone this product installs: `--max-duration 1ms` against a healthy
 * endpoint transferred all 157 286 400 bytes, rc=0, in 1 s on
 * `rclone v1.60.1-DEV`, which is what apt has on the platform `docs/deploy.md`
 * documents and therefore what `deploy/install.sh` puts on the host. The flag
 * reaches `--max-duration` at rclone ≥ 1.64, which apt does not offer, so the
 * request bound cannot be a flag at all.
 *
 * **`timeout` bounds the process, which no rclone version can ignore.** What it
 * buys is *termination*: G-39's 18 min 03 s was the volume restore's download
 * running inside `withVolumeLock`, so every backup, restore and
 * Remove-containers on that volume answered 409 for eighteen minutes, and a link
 * delivering 1 KB/s to a 5 GB volume is never idle, never finished and — until
 * this — bounded by nothing.
 *
 * **`command -v` rather than an assumption.** `timeout` is coreutils and is on
 * every host this product installs itself onto, but these scripts also run on a
 * Server over SSH, and this tree already paid once for assuming a host
 * binary behaves one way (a BSD `wc` pads, which made a whole restore branch
 * unreachable). A host without it downloads unwrapped, which is where it was
 * before this function existed — a fallback that is exactly the status quo
 * rather than a new failure. `1800` and not `30m` for the same reason: busybox's
 * `timeout` takes no suffix.
 *
 * **The bound is here rather than a `timeout` word at each call site**, for the
 * reason `bulkDownloadRcloneFlags` itself exists (§1.4): the volume restore's
 * `copyto` and the mongo restore's `copy` are the same operation, these numbers
 * have already been wrong twice, and the next measurement has to move both or it
 * is a measurement of whichever copy was forgotten. The verb is a parameter
 * because it is the only thing that differs; a caller that assembled its own
 * `rclone …` string could forget the flags or the wrapper, and both have been
 * forgotten once each.
 *
 * The returned string is two lines and **ends on the invocation**, so a caller
 * can append its own words: `buildRestoreScript` appends mongo's temp directory,
 * and `buildVolumeRestoreScript` appends `|| DOWNLOAD_STATUS=$?` because it
 * reads 124 back and names the bound in its refusal. `indent` is the caller's
 * script's own leading whitespace, since the first line inherits the template's
 * and the second does not.
 */
export const bulkDownloadCommand = ({
  verb,
  args,
  indent = '',
}: {
  /** `copyto` on the volume restore, `copy` on the mongo one. */
  verb: 'copyto' | 'copy';
  /** Everything after the flags: the object path, and a local path if the
   * caller does not append one itself. */
  args: string;
  indent?: string;
}): string =>
  [
    `if command -v timeout >/dev/null 2>&1; then RCLONE_WALL_CLOCK='timeout ${BULK_DOWNLOAD_WALL_CLOCK_SECONDS}'; else RCLONE_WALL_CLOCK=''; fi`,
    // Unquoted on purpose: the expansion is either two words or none, and an
    // empty `"$RCLONE_WALL_CLOCK"` would be a command named the empty string.
    `$RCLONE_WALL_CLOCK rclone ${verb} ${bulkDownloadRcloneFlags} ${args}`,
  ].join(`\n${indent}`);

/**
 * "Is this endpoint answering at all", asked of the key a restore is about to
 * download, before the download's own retry budget can be spent on the answer
 * (reopened).
 *
 * The restores need two incompatible things from one set of retries. A transfer
 * that is moving needs a generous `--low-level-retries` or a degraded link never
 * assembles — see `boundedRcloneFlags`, where a stalling endpoint went from
 * 1083 s and nothing to 181 s and every byte. An endpoint that is simply *not
 * there* needs the opposite, because the same counter governs a connect that
 * never completes: the download that answers in 242 s at three low-level
 * retries takes 641 s at ten. Neither number can serve both, so the question is
 * asked once, cheaply, by something whose whole job is to fail fast.
 *
 * The listing profile, unchanged and unparameterised, because that is the
 * measured sibling rather than a fourth invented number (§1.4): it is what
 * `GET /destinations/:id/objects` has been running in production, and against
 * the same dead socket that costs the download 641 s it refuses in **40 s**. The
 * other half is what it does *not* refuse — the stalling proxy that defeats
 * every idle bound answers a one-key `lsjson` in **0 s**, because the response
 * is bytes rather than megabytes, so a degraded-but-alive link is waved straight
 * through to the transfer that is built to survive it.
 *
 * **`lsjson` of the key, and deliberately not as an existence check.** A key
 * that is not there exits **0** with `[]` — measured, on MinIO — so this probe
 * cannot and does not answer "is the object there": that stays with
 * `buildVolumeRestoreScript`'s `-s` test on the downloaded file, which asks the
 * only question the untar cares about, which is whether there are bytes on this
 * disk. A probe was rejected as a *substitute* for that test and the rejection
 * still holds; this is not one. What a nonzero exit here means is narrower and
 * is the whole point — the endpoint did not answer.
 *
 * **What this buys is the common case, and it is worth saying which case it does
 * not.** An endpoint that dies in the window *between* the probe answering and
 * the transfer starting is not caught, and on that path the restore now costs
 * 641 s where the shipped flags cost 242 — the race is the price of the 181 s
 * row. It is a deliberate trade rather than an oversight: "the endpoint is
 * already down" is the shape G-39 was filed about and it goes
 * 242 s → 40 s, "the endpoint dies in the next few milliseconds" is not, and the
 * loser is still bounded — by `bulkDownloadCommand`'s process wall clock, which
 * is what that job turned out to need (H-120). Closing it properly means a
 * transfer that can tell a failed connect from a stalled read, which rclone does
 * not expose.
 *
 * Emitting the path a second time is the other cost, and the alternative —
 * bounding the download tightly enough to fail fast by itself — is precisely the
 * shape G-39 measured turning a slow success into a total failure.
 *
 * **Not a new permission**, which is the question `lsjson` should raise: it needs
 * `s3:ListBucket` where a `copyto` needs only `GetObject`. Every destination this
 * product can restore *from* already answers a listing — `GET /backups/files` is
 * how the caller picked the file, and `buildPruneCommand`'s `rclone lsf` runs on
 * every scheduled backup — so a bucket that fails this probe has been failing
 * those first.
 */
export const reachabilityProbeCommand = (objectPath: string): string =>
  // `quote()`d, not double-quoted (H-38). This is the last unquoted value word
  // reachable from `backups/**` and `volume-backups/**`: `objectPath` is
  // `:s3:{bucket}/{backupFile}` on the database restore and
  // `:s3:{bucket}/{backupFileName}` on the volume restore, and both keys come
  // off the wire — `restoreBackupSchema.backupFile` is `z.string().min(1)` and
  // `restoreVolumeBackupSchema.backupFileName` is held only to the charset
  // H-19 added. Double quotes stop a space and not a `$(…)`, and the probe
  // runs inside `$( … )` in a script `RemoteExecService` executes.
  `rclone lsjson ${boundedRcloneFlags({ idle: '30s' })} ${quote([objectPath])}`;

/**
 * The shortest credential value the guard will *refuse* a command over —
 * deliberately longer than `MIN_MASKED_CREDENTIAL_LENGTH`, which is the floor
 * for *masking*.
 *
 * The two floors answer different questions and so they are different numbers.
 * The mask asks "could this string be a secret", and six is right: masking a
 * six-character value that turns out to be innocent costs six characters of a
 * message nobody was reading. The guard asks "is this occurrence an interpolated
 * credential rather than a bucket name that happens to contain one", and a
 * refusal costs the operator their backup — so it may only fire where the answer
 * cannot be a coincidence.
 *
 * 20 is every real cloud credential and no plausible collision: an AWS access
 * key id is exactly 20 characters, R2 and B2 ids are 32 or more, and every
 * provider's secret is 40+. What falls below the line is the short key a
 * self-hosted deployment uses — MinIO's default `minioadmin` is ten — and that
 * is precisely the value a bucket called `minioadmin-backups` contains by
 * accident. Refusing every rclone call for such a destination is a worse bug
 * than the future call site this branch exists to catch, which the flag-name
 * branch and the command-content tests catch anyway.
 */
const MIN_REFUSED_CREDENTIAL_LENGTH = 20;

/**
 * The one line the guard writes rather than throws, on
 * `docker-client.provider.ts`'s precedent for a `Logger` in a module that is not
 * `@Injectable()`. This file is a plain-function module by deliberate choice
 * (see `execRclone`), and a module-level `Logger` does not change that — it needs
 * no injection and holds no state.
 */
const guardLogger = new Logger('execRclone');

/** Every way a command line can *name* a credential rclone would rather read
 * from its environment. Both spellings of both keys: the `--s3-*` flags
 * already deleted, and the environment variables that replaced them, which are safe in
 * an `env` map and a leak in an inline `VAR=… rclone …`. */
const CREDENTIAL_NAMED_IN_COMMAND =
  /--s3-(?:secret-access-key|access-key-id)\b|RCLONE_S3_(?:SECRET_ACCESS_KEY|ACCESS_KEY_ID)=/;

/**
 * Refuse a command that carries a credential, before anything runs it.
 *
 * F-41's finding was that the mask behind `execRclone` cannot fire on any live
 * route, because no path is left that puts a credential in an error — so the
 * only thing between a future call site and a leak was that nobody interpolates
 * one *today*. This is that "nobody" made structural: a call site that builds
 * the secret into an argv or a command string now fails on its first run instead
 * of shipping, and it fails here, at the one door, rather than in whichever of
 * the nine call sites went wrong.
 *
 * A type would have been the tighter answer — a command string that cannot be
 * built from a credential — and it was rejected: every command in this tree is
 * assembled by string template from a bucket, a path and a builder's script, and
 * branding that would mean a branded type on `buildBackupScript`,
 * `buildPruneCommand`, `buildRestoreScript`, both volume builders and three
 * inline assemblies, to catch a mistake nobody has made yet. A runtime refusal
 * at the door costs one substring scan per invocation and cannot be bypassed by
 * a cast.
 *
 * **It also covers the secrets the *caller* declares
 * environment-borne**, which is a strictly cheaper question than the two above:
 * `RcloneExecOptions.env` is the caller saying "this value travels in the
 * environment", so the same value appearing in the command it accompanies is a
 * contradiction rather than a guess. That is what keeps the database password's
 * never-carry property structural — a sixth engine builder that puts the
 * password back into `mysqldump --password=…` fails on its first run instead of
 * shipping green, because no test in a backups suite matches on a value the
 * command is not supposed to contain.
 *
 * The message names the *spelling*, never the value. **There are two floors, and
 * they are different numbers on purpose.** `MIN_MASKED_CREDENTIAL_LENGTH`
 * is where the mask starts hiding a value; `MIN_REFUSED_CREDENTIAL_LENGTH` is
 * where this starts refusing a command over one. The guard used to refuse on the
 * mask's floor — "exactly what the mask would have hidden" — and that is the
 * wrong pairing: a value long enough to be worth hiding is not thereby a value
 * whose presence in a command line can only be an interpolation. MinIO's default
 * `minioadmin` clears six characters, and a bucket named `minioadmin-backups`
 * then makes `command.includes(value)` true of a perfectly good listing, so
 * every backup, prune, restore and listing for that destination was refused.
 *
 * What is given up, stated rather than discovered later: a credential of 6 to 19
 * characters that a *future call site* interpolates is masked on its way out but
 * no longer refused on its way in. Covering it are the flag-name branch, which
 * is a hard refusal at every length, the command-content tests, and — in that
 * band alone — a warn line here, which is the only signal left and is why the
 * band does not simply go silent.
 *
 * **The refusal names the Server the run was for, and that is a
 * behaviour change with its own argument.** It was filed as a minor and left
 * alone as *"a behaviour change wanting its own argument rather than a line in
 * a credential fix"*; the argument is that a refusal which cannot name its host
 * is not diagnosable. This is the one `ExecError` in the tree built by hand
 * rather than by `RemoteExecService`, and it was therefore the only one with no
 * `serverId` — while `execAsyncRemote` passes it on every one of its five
 * constructions, and `ExecError`'s `elideEveryString` is documented to leave
 * the field alone precisely so a redacted failure still says which host. A
 * refused backup pointed at a call site and left the operator to guess which of
 * their Servers had been asked, on an instance where the same Destination is
 * reachable from several. `null` travels as `null` rather than being dropped, because
 * `null` is the platform host and not "unknown" (ADR-0008) — the same reading
 * {@link execRclone}'s own dispatch gives it one line down.
 *
 * The `serverId` is the routing input and not a value, so it changes nothing
 * about the masking contract this function is otherwise all about:
 * {@link maskEnvValues} still elides the caller's environment-borne secrets out
 * of the command, `redactS3CredentialsInError` still takes the Destination's two
 * values out of everything, and neither reads or writes this field.
 */
const assertCredentialFreeCommand = (
  command: string,
  destination: S3Credentials,
  commandEnv: Record<string, string> = {},
  serverId: string | null = null,
): void => {
  const named = CREDENTIAL_NAMED_IN_COMMAND.exec(command)?.[0];
  const spellings = [
    ["the destination's secret access key", destination.secretAccessKey],
    ["the destination's access key id", destination.accessKey],
    // Every value the caller said travels in the environment, held to the same
    // two floors. The question is the same one the two above ask — "is
    // this occurrence an interpolation or a coincidence" — and the answer here
    // is if anything less ambiguous, because the caller has just declared this
    // value environment-borne, so its presence in the command it accompanies is
    // a contradiction. It still gets the same floors rather than a third rule: a
    // six-character database password equal to a bucket or a database name is
    // the same false positive, and refusing over one costs the same backup.
    ...Object.entries(commandEnv).map(
      ([name, value]) => [`the value of $${name}`, value] as const,
    ),
  ] as const;
  const carriedAtLength = (min: number, max = Infinity) =>
    spellings.find(
      ([, value]) =>
        value &&
        value.length >= min &&
        value.length < max &&
        command.includes(value),
    );

  const carried = carriedAtLength(MIN_REFUSED_CREDENTIAL_LENGTH);
  if (!named && !carried) {
    // Between the two floors the guard cannot tell an interpolated credential
    // from a bucket or key that legitimately contains a short one, so it says so
    // and runs the command. One line per invocation for such a
    // destination is the accepted cost of not refusing its backups; silence
    // would throw away the only signal left in this band.
    const short = carriedAtLength(
      MIN_MASKED_CREDENTIAL_LENGTH,
      MIN_REFUSED_CREDENTIAL_LENGTH,
    );
    if (short) {
      guardLogger.warn(
        `An rclone command contains ${short[0]}, which is ` +
          `too short (${short[1].length} characters) to tell an interpolated ` +
          `credential from a bucket or key that contains it. Running it. If a ` +
          `call site built the credential into this command line, move it into ` +
          `the environment — see execRclone.`,
      );
    }
    return;
  }

  throw new ExecError(
    `Refusing to run an rclone command that carries a credential in its ` +
      `command line: it ${
        named ? `names ${named}` : `contains ${carried?.[0] ?? 'a credential'}`
      }. Credentials travel in the environment — pass the Destination to ` +
      `execRclone, hand it any other secret as \`env\`, and leave both out of ` +
      `the command.`,
    // The offending command, so the refusal says which call site is wrong. The
    // destination's own credentials are masked by the catch in `execRclone`,
    // which is the mask's one reachable path; a value from `commandEnv` is not
    // one that mask knows, so it goes here — and it goes by *value* because the
    // whole finding is that a command carried one.
    { command: maskEnvValues(command, commandEnv), serverId },
  );
};

/**
 * Take a caller-declared environment value back out of the command the guard is
 * about to refuse over.
 *
 * `redactS3CredentialsInError` cannot: it searches for the *destination's* two
 * values and this is a third party's secret. Without this the refusal would be
 * the one `ExecError` in the tree that journals a database password — the exact
 * leak already closed, reintroduced by the guard that exists to stop it.
 *
 * `MIN_MASKED_CREDENTIAL_LENGTH` and not the refusal floor, on `redactS3Credentials`'
 * reasoning: masking is cheap and refusing is not, so the mask covers the whole
 * band the guard warns in as well as the band it throws in.
 */
const maskEnvValues = (
  command: string,
  commandEnv: Record<string, string>,
): string => {
  let out = command;
  for (const value of Object.values(commandEnv)) {
    if (!value || value.length < MIN_MASKED_CREDENTIAL_LENGTH) continue;
    out = out.split(value).join('[credential elided]');
  }
  return out;
};

/**
 * The one door every rclone invocation against a Destination goes through:
 * backup run, prune, restore, backup-file listing, both volume-backup paths and
 * the two destination probes.
 *
 * One door rather than the same branch at each call site, because the old leak
 * was what happens when there are nine of them — the two probes passed the credentials in
 * rclone's environment and masked the refusal, and the seven that moved the data
 * interpolated the secret access key into argv, where the host's process table
 * and then the exception filter's journal entry picked it up. The forgettable
 * half is now not a call site's decision: a caller names the Destination and the
 * Server, and cannot express the unsafe version — and cannot smuggle
 * it in through the command string either, because
 * `assertCredentialFreeCommand` refuses one before anything runs.
 *
 * A plain function taking the injected `RemoteExecService`, on
 * `common/service-parent.ts`'s precedent — a `@Injectable()` would need wiring
 * in three modules to hold no state.
 */
export const execRclone = async (
  remoteExec: RemoteExecService,
  command: string,
  {
    destination,
    serverId,
    platformHost,
    shell,
    env: commandEnv = {},
  }: RcloneExecOptions,
): Promise<ExecResult> => {
  // The fail-closed backstop of ADR-0053: whatever its caller forgot to
  // refuse first — a Service in a Cloud account has `serverId: null` too —
  // the Hosted instance's own host never runs rclone against a customer's
  // endpoint with the customer's keys. Before anything is built, so the
  // refusal carries no credential.
  if (!serverId) platformHost.refusePlatformHost('services');
  // Credentials spread last, so a name collision can never blank one.
  const env = {
    ...RCLONE_INVOCATION_ENV,
    ...commandEnv,
    ...getS3CredentialsEnv(destination),
  };
  try {
    // Inside the try on purpose: the refusal carries the command it refused, so
    // it is the one ExecError in this tree that holds a credential by
    // construction, and the catch below is what masks it.
    assertCredentialFreeCommand(command, destination, commandEnv, serverId);
    // Both sides carry the environment the same way (§2.9): remotely it travels
    // as a script on stdin, locally as the child's env, and in neither does it
    // reach an argv.
    return serverId
      ? await remoteExec.execAsyncRemote(serverId, command, undefined, {
          env,
          shell,
        })
      : await remoteExec.execAsync(command, {
          shell,
          env: { ...process.env, ...env },
        });
  } catch (error) {
    // The second layer, on every route rather than only the two that never had
    // anything to mask: whatever echoed the command back — a shell repeating the
    // line it could not run, rclone quoting its own resolved configuration —
    // must not repeat the credentials with it.
    throw redactS3CredentialsInError(error, destination);
  }
};

/**
 * What a line on stdout looks like when it is reporting a failure rather than
 * narrating progress.
 *
 * Two kinds, and the second is why this is not just the emoji. A script in this
 * tree marks its own refusals: `buildVolumeRestoreScript`'s `⚠️  WARNING: Cannot
 * restore volume` header, its closing `❌ Volume restore aborted`,
 * `buildBackupScript`'s `❌ Error: Container not found`. But the database restore
 * is not a narrated script at all — it is `rclone cat … | psql`, and its whole
 * diagnosis is the engine's own unmarked line, `pg_restore: error: could not
 * open input file`. Emoji-only was tried and rejected precisely there: it threw
 * that line away and answered with `child_process`'s 4.6 KB of script source
 * instead (`test/backups` pins it).
 *
 * So the vocabulary is the small set of words a tool uses when it is refusing —
 * rclone's `ERROR :`, tar's `Cannot open:`, psql's `ERROR:`, mongorestore's
 * `Failed:` — and none of it appears in any narration these builders print;
 * `busyVolumeNameFrom` reads the lock refusal out of stdout by marker for the
 * same reason.
 *
 * A word only counts at the start of a line or after a space, which keeps a
 * failed `lsjson` from calling its own half-written JSON a diagnosis because a
 * key is named `"error-log.txt"`. `⚠` is matched without its variation selector
 * (the scripts write `⚠️`, U+26A0 U+FE0F, and a channel may or may not carry the
 * selector through).
 */
const FAILURE_ON_STDOUT =
  /❌|⚠|(?:^|\s)(?:ERROR|[Ee]rror|FAILED|[Ff]ail(?:ed|ing|ure|s)?|[Cc]annot|[Cc]an't|[Ff]atal|[Dd]enied|[Rr]efused|[Aa]borted|[Nn]o such)\b/;

/**
 * The failure a script reported on its way out, if it reported one — not the
 * last thing it happened to say.
 *
 * From the first failing line to the end, because a refusal is a block: the
 * volume-in-use one is the `⚠️` header, then every container holding the volume
 * with its state and type, then the three numbered steps for freeing it.
 * Everything above that line is the transcript of what worked, which is not what
 * the caller asked.
 */
const failureReportedOn = (stdout: string): string | undefined => {
  const lines = stdout.split('\n');
  const reported = lines.findIndex((line) => FAILURE_ON_STDOUT.test(line));
  return reported === -1 ? undefined : lines.slice(reported).join('\n').trim();
};

/**
 * A syslog priority prefix on a line rclone wrote.
 *
 * Belt to the environment's braces, and not redundant: `RCLONE_INVOCATION_ENV`
 * stops rclone framing its output this way in the first place, on every path
 * including the run log this function never sees — but the framing is decided by
 * rclone's own version-specific detection, and a host or a version that reaches
 * it some other way should not be able to put `<3>` at the front of what a
 * person reads. Anchored per line and limited to one digit 0-7, which is the
 * whole of syslog's range, so `<5>` at the start of a line goes and `<html>`,
 * `<AWSAccessKeyId>` and a `<` anywhere but a line's first column stay.
 */
const SYSLOG_PRIORITY_PREFIX = /^<[0-7]>/gm;

/**
 * The most of a failure a message answered to an HTTP caller may carry.
 *
 * Two of the three candidates below are unbounded. `stderr` is rclone's, and a
 * stalling endpoint narrates one `ERROR :` line per low-level retry for as long
 * as it keeps the connection alive — the restore's flags bound *idle* time, not
 * total, so 18 minutes of retry narration is a measured shape, not a
 * hypothetical. `message` on the local path is `child_process`'s
 * `Command failed: <the whole script>`, 4.6 KB of source. The exception filter
 * renders whichever wins into a body a person reads and a journal line pino
 * writes.
 *
 * **Both ends, not the last 8 KB**, which is what was first asked for and is wrong
 * for one of the three branches. A stdout refusal is a block whose *header* is
 * the diagnosis — `⚠️  WARNING: Cannot restore volume`, then the containers,
 * then the numbered steps — and cutting the head off it is the stdout bug arriving
 * by another door. rclone's stderr is the opposite: retry 1 first, the fatal
 * `Failed to copy:` summary last. And `message` carries `Command failed:` at the
 * head and the folded stderr at the tail with the script source between. In all
 * three the middle is the part with nothing in it.
 */
const MAX_FAILURE_MESSAGE_LENGTH = 8 * 1024;

const isHighSurrogate = (unit: number): boolean =>
  unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean =>
  unit >= 0xdc00 && unit <= 0xdfff;

/**
 * UTF-16 code units rather than bytes, and for the *bound* the difference does
 * not matter: 8 KB is a bound on what a person is asked to read, not on a
 * buffer, and these strings are full of `✅`, `⚠️` and `❌` that a byte slice
 * would cut in half.
 *
 * For the *boundaries* it does matter, which is what the two steps below are
 * for. Those three glyphs are one code unit each, but this tree's own refusals
 * write emoji above the BMP — the volume in-use block writes `📋` (U+1F4CB),
 * `🔧` (U+1F527) and `🐳` (U+1F433) **once per container holding the volume**,
 * and that block is the one product-authored candidate above that grows without
 * bound, so it is the input this cap most often fires on. An S3 provider's
 * `<Message>` arrives on `stderr` as a tool's own words and can be anything at
 * all. `String.prototype.slice` is indexed in code units, so a boundary landing
 * between the high and the low half of a surrogate pair splits one character and
 * leaves a **lone surrogate** on each side of the marker — not well-formed
 * Unicode, so `JSON.parse` in a browser yields U+FFFD and a log pipeline that
 * re-encodes the body cannot round-trip what it was given. Each end therefore
 * steps *back* off a pair it would otherwise split — inwards, never outwards, so
 * the answer stays inside the cap. A lone surrogate the input already carried is
 * left where it is: this function has no partner to invent for it.
 *
 * The marker's number is `message.length - MAX_FAILURE_MESSAGE_LENGTH`: how far
 * over the cap the input was, in code units, which is close to but not exactly
 * how much the two slices dropped — the marker's own length, the floored halving
 * and a step off a pair account for about thirty units more. It says the answer
 * is not the whole of what the tool wrote; it is not an exact figure, and it says
 * "characters" because that is the word a person reading a failure has for it.
 *
 * Safe to apply last, after masking: everything reaching here has been through
 * `redactS3CredentialsInError` in `execRclone`, so a credential is already
 * `••••••` and the elision cannot split one into two unmasked halves.
 */
const capFailureMessage = (message: string): string => {
  if (message.length <= MAX_FAILURE_MESSAGE_LENGTH) return message;
  const elided = message.length - MAX_FAILURE_MESSAGE_LENGTH;
  const marker = `\n… ${elided} characters elided …\n`;
  const half = Math.floor((MAX_FAILURE_MESSAGE_LENGTH - marker.length) / 2);

  const headEnd =
    isHighSurrogate(message.charCodeAt(half - 1)) &&
    isLowSurrogate(message.charCodeAt(half))
      ? half - 1
      : half;
  const tailStart = message.length - half;
  const tailFrom =
    isLowSurrogate(message.charCodeAt(tailStart)) &&
    isHighSurrogate(message.charCodeAt(tailStart - 1))
      ? tailStart + 1
      : tailStart;

  return `${message.slice(0, headEnd)}${marker}${message.slice(tailFrom)}`;
};

/**
 * The sentence a failed rclone run should answer its caller with (fixed
 * for the narrating case too).
 *
 * The first fix read stdout first, and that half is right: these routes execute
 * *scripts*, `buildVolumeRestoreScript` refuses a volume that is still in use by
 * listing every container holding it and printing three numbered steps for
 * freeing it, all of it on **stdout** — while `ExecError.message` is either
 * `child_process`'s `Command failed: <the whole script>`, 4.6 KB of source with
 * the diagnosis nowhere in it, or over SSH the flat `Remote command failed with
 * exit code 1`.
 *
 * What it missed is that **a script's stdout is a transcript, not a
 * diagnosis**, and a transcript is never empty by the time anything fails.
 * F-44 drove three failures and two answered with narration: an
 * unreachable bucket answered *"Downloading backup from S3..."* and never said
 * the connection was refused; a missing key answered *"Creating new volume and
 * restoring data..."*; and `GET /backups/files` answered the literal `[`,
 * rclone's first byte of `lsjson` output. Where the reason actually was, in all
 * three, is **stderr** — rclone, docker and tar all complain there, and only
 * `GET /destinations/:id/objects` looked good because `boundedRcloneFlags` makes
 * rclone fail before printing anything, leaving `message` to win by default.
 *
 * So the precedence is by *kind*, not by stream: whatever on stdout is reporting
 * a failure rather than narrating progress (see `FAILURE_ON_STDOUT`), then the
 * tool's own complaint on stderr, then the message, which is worth reading
 * exactly when nothing ran at all — an SSH connection error, an unresolvable
 * server, a bounded rclone that failed before it printed.
 *
 * Rejected, in order of how tempting they were:
 * - **Swapping stdout and stderr.** Loses the stdout fix outright. The volume-in-use
 *   refusal is on stdout, and on that same failure stderr carries whatever
 *   `docker ps` muttered — the refusal the script went to such trouble to write
 *   would go back to surviving only in the journal.
 * - **Reading stdout only for this tree's own `❌`/`⚠️` markers.** Tried, and it
 *   broke the database restore, which is not a narrated script but
 *   `rclone cat | psql`: its diagnosis is the engine's unmarked
 *   `pg_restore: error: could not open input file`, and dropping it answered
 *   with 4.6 KB of script source instead. Hence the failure vocabulary rather
 *   than two glyphs.
 * - **Joining all three.** Puts 4.6 KB of script source, or the echoed command
 *   line, in front of the one sentence the caller needs; the stdout fix removed
 *   exactly that.
 * - **The last non-empty line of stdout.** That *is* F-44's bad answer:
 *   "Downloading backup from S3..." is the last line, and the last line of a
 *   transcript says how far it got, not what went wrong.
 * - **Keeping unmarked stdout unless it fails to parse as prose** (`[`, a bare
 *   volume name). A guess about shape where a failure word is a statement, and
 *   it would still have answered "Downloading backup from S3...".
 *
 * The cost of a vocabulary is two-sided and both sides are survivable: a failure
 * line phrased in words nobody listed falls through to stderr, which is where a
 * tool's reason is anyway, and a narration line that happens to say "failed"
 * would be answered with — still the run's own words, never a bare transcript
 * position.
 *
 * Every one of these fields comes out of `execRclone` already masked: the
 * `REDACTED_ERROR_FIELDS` list covers stdout and stderr alongside message
 * so what this builds carries no credential no matter which one wins.
 *
 * The answer is *bounded*, and neither stream reaches a caller whole: the
 * syslog framing rclone adds when it thinks it is writing to the journal is
 * stripped (`SYSLOG_PRIORITY_PREFIX`), and what is left is capped at
 * `MAX_FAILURE_MESSAGE_LENGTH` keeping both ends (`capFailureMessage`).
 * The strip runs first on purpose — a prefix per line is bytes, and bytes spent
 * on `<3>` are bytes the preserved head does not spend on the diagnosis.
 *
 * Without this, all three failures — volume in use, bucket unreachable, tarball
 * not there — reach the console as the same `500 Internal server error`, and
 * two of the three that do reach it say only how far the script got.
 */
export const rcloneFailureMessage = (
  error: unknown,
  fallback: string,
): string => {
  const { stdout, stderr, message } = (error ?? {}) as Record<string, unknown>;
  const refusal =
    typeof stdout === 'string' ? failureReportedOn(stdout) : undefined;
  for (const candidate of [refusal, stderr, message]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return capFailureMessage(
        candidate.replace(SYSLOG_PRIORITY_PREFIX, '').trim(),
      );
    }
  }
  // Left uncapped: every `fallback` in this tree is a short literal the call
  // site supplied, not something a tool wrote.
  return fallback;
};
