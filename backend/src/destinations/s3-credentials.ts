import { REDACTED_ERROR_FIELDS } from '../common/logging/error-payloads';
import type { Destination } from '../db/schema';

/** The credential fields an rclone invocation against a destination needs. */
export type S3Credentials = Pick<
  Destination,
  'accessKey' | 'secretAccessKey' | 'region' | 'endpoint' | 'provider'
>;

/**
 * The S3 backend's credentials and options, expressed as rclone's own
 * environment variables rather than as its `--s3-*` flags (rclone reads
 * `RCLONE_S3_ACCESS_KEY_ID` for `--s3-access-key-id`, and so on).
 *
 * The **only** way credentials reach rclone here, for every route: the backup
 * run, the prune, the restore, the listings and the destination probes. The
 * flag-building form was deleted rather than left for a caller to
 * reach for — a command string is echoed back in a failure message, written to
 * the journal by the exception filter, and readable out of the host's process
 * table by any other user on the machine while it runs, so there was no call
 * site where interpolating the secret was the right answer.
 *
 * **Not only credentials, and it never was**: `RCLONE_S3_NO_CHECK_BUCKET` and
 * `RCLONE_S3_FORCE_PATH_STYLE` are backend *options*, and `RCLONE_S3_ENCODING`
 * joins them for the reason below. What keeps this function's own
 * subject clear is the split at {@link RCLONE_INVOCATION_ENV}: everything here
 * configures rclone's **S3 backend** for one Destination, everything there is
 * spawn hygiene about what rclone writes on stderr.
 */
export const getS3CredentialsEnv = (
  destination: S3Credentials,
): Record<string, string> => {
  const { accessKey, secretAccessKey, region, endpoint, provider } =
    destination;
  const env: Record<string, string> = {
    RCLONE_S3_ACCESS_KEY_ID: accessKey,
    RCLONE_S3_SECRET_ACCESS_KEY: secretAccessKey,
    RCLONE_S3_REGION: region,
    RCLONE_S3_ENDPOINT: endpoint,
    RCLONE_S3_NO_CHECK_BUCKET: 'true',
    RCLONE_S3_FORCE_PATH_STYLE: 'true',
    // **This is rclone's current default written down, not a change of
    // behaviour** — `--s3-encoding`'s help line reads
    // `(default Slash,InvalidUtf8,Dot)` and it was checked for `AWS`,
    // `Cloudflare`, `Minio`, `DigitalOcean` and `Wasabi` alike. Nothing this
    // product does behaves differently the day this line lands.
    //
    // What changes is whose fact it is. The prefix rules rest on a `.` or
    // `..` segment in an S3 object key being *inert*, and half of that argument
    // is the encoder: rclone's S3 backend rewrites such a segment to fullwidth
    // full stops rather than resolving it. Measured against rclone v1.75.0 with
    // a request-logging endpoint and this product's own invocation form —
    // inline `:s3:` remote, `RCLONE_S3_*` in the environment,
    // `RCLONE_CONFIG=/dev/null`:
    //
    //   default                              PUT /b/storefront/daily/%EF%BC%8E%EF%BC%8E/ledger/x.tar
    //   RCLONE_S3_ENCODING=Slash,InvalidUtf8 PUT /b/storefront/daily/../ledger/x.tar
    //
    // `%EF%BC%8E` is U+FF0E. `execRclone` spawns the local branch with
    // `{ ...process.env, ...env }`, so before this line an
    // `RCLONE_S3_ENCODING` in the *backend's own* environment — a systemd
    // unit's `Environment=`, a Docker `-e`, a `.env` an operator edited —
    // reached every rclone this product runs and silently moved it to the
    // second line. The prefix bounds already landed are authorization
    // checks and were never affected; the claim that a stored traversing
    // `prefix` needs no migration was, and that is the whole reason it is
    // written down here.
    //
    // **Why this variable and not a wall of rclone's defaults.** The three
    // numbers this product genuinely depends on — `--retries`,
    // `--low-level-retries`, `--timeout` — travel as flags from
    // `boundedRcloneFlags`, and an rclone flag beats its environment:
    // `RCLONE_RETRIES=5` alone gives `Attempt 5/5`, and with `--retries 1`
    // beside it gives `Attempt 1/1` (measured, same rclone). So those are
    // already asserted, and the encoder was the one property a *documented
    // security argument* rested on with nothing but a default behind it.
    // Copying rclone's remaining two hundred defaults in here would be a second
    // copy of them that goes stale at the next upgrade, and it would make this
    // map a place a reader has to diff rather than read.
    RCLONE_S3_ENCODING: 'Slash,InvalidUtf8,Dot',
  };

  // Conditional, and it is the one key in this map an inherited environment can
  // still fill: a Destination whose `provider` column is null leaves
  // `RCLONE_S3_PROVIDER` unset, so `{ ...process.env, ...env }` hands rclone
  // whatever the backend's own environment holds instead of letting rclone use
  // its `AWS` default. Left conditional deliberately — the alternative is
  // writing a provider name onto every Destination that deliberately has none,
  // which *is* a change of behaviour on live rows and so is not what a
  // write-the-default-down commit may do. Filed rather than folded in.
  if (provider) {
    env.RCLONE_S3_PROVIDER = provider;
  }

  return env;
};

/**
 * The rest of the environment an rclone invocation runs with: nothing to do with
 * credentials, everything to do with what rclone writes on stderr — because that
 * stderr is what `rcloneFailureMessage` answers an HTTP caller with, and it is
 * what the run log records.
 *
 * Separate from `getS3CredentialsEnv` on purpose: that function is the
 * credential set and its docblock is about where secrets travel. This is spawn
 * hygiene, and merging the two would make the next reader of either believe the
 * other's reasoning applies.
 */
export const RCLONE_INVOCATION_ENV: Record<string, string> = {
  // The backend is a systemd unit, so systemd puts `JOURNAL_STREAM=<dev>:<ino>`
  // in its environment and `{ ...process.env, ...env }` hands it to every rclone
  // it spawns. rclone reads it, concludes it is logging to the journal, and
  // switches to journal framing — every line then carries a syslog priority
  // prefix, `<5>NOTICE: …`, `<3>ERROR : …`. The child's stderr is a pipe this
  // process reads, not the journal, so the framing is decoration on a string a
  // person is about to read in a 400.
  //
  // Blanked rather than reasoned about: the exact rule rclone uses is not
  // settled — it may compare stderr's device and inode against the value, or
  // simply require the variable and a non-tty stderr — and it does not need to
  // be, because every candidate rule reads this variable and an empty value
  // satisfies none of them.
  JOURNAL_STREAM: '',
  // The documented lever for the same behaviour, set explicitly so a future
  // rclone that stops consulting JOURNAL_STREAM is still covered.
  RCLONE_LOG_SYSTEMD: 'false',
  // `Config file "/root/.config/rclone/rclone.conf" not found - using defaults`
  // on every single invocation, and it is not a diagnosis: every command these
  // modules build addresses its remote as the inline `:s3:` form, so there is no
  // named remote and no config file is wanted. An empty file that exists is the
  // smallest way to stop rclone looking for one, and unlike a log-level change
  // it silences nothing else.
  RCLONE_CONFIG: '/dev/null',
};

const MASK = '••••••';

/** An rclone credential handed over as a flag or an environment assignment. */
const CREDENTIAL_ASSIGNMENT =
  /((?:RCLONE_S3_(?:SECRET_ACCESS_KEY|ACCESS_KEY_ID)|--s3-(?:secret-access-key|access-key-id))=)("[^"]*"|'(?:[^']|'\\'')*'|\S*)/g;

/**
 * The shortest credential value worth masking on its own.
 *
 * Six, because a value shorter than that would redact unrelated words: a
 * four-character region name — `auto` is one — is not a secret, and masking it
 * would take the word out of every message that says it.
 *
 * Exported for `rclone-exec.ts`'s argv guard, but **not as the value that
 * guard refuses on** — that pairing was a bug, since fixed. The guard has a
 * higher floor of its own, `MIN_REFUSED_CREDENTIAL_LENGTH`, and reads this one
 * as the *lower* bound of the band where it warns and runs the command anyway.
 * The two answer different questions: masking a six-character value that turns
 * out to be innocent costs six characters of a message nobody was reading, while
 * refusing over one costs the operator their backup — MinIO's default key
 * `minioadmin` is ten characters, and a bucket named `minioadmin-backups`
 * contains it by accident. So a credential of 6 to 19 characters is still hidden
 * by this file wherever it appears and is no longer grounds for refusing the
 * command it appeared in.
 */
export const MIN_MASKED_CREDENTIAL_LENGTH = 6;

/**
 * Take the credentials back out of a message we are about to show someone.
 *
 * Belt and braces behind `getS3CredentialsEnv`: whatever tool echoed the
 * command — a shell that repeats the line it failed to run, rclone quoting its
 * own configuration — must not repeat the credentials with it. The diagnosis is
 * the whole reason the message is shown, so only the credential values go: two
 * passes, one over the places a credential is *named*, one over the literal
 * values we know we sent. Values under six characters are left alone; they
 * would redact unrelated words, and a secret that short is not a secret.
 *
 * Not dead code: F-41 found this mask 0 times in 6 918 journal lines of
 * three driven failures, and that is the fix working, not the mask rotting —
 * every credential is out of argv, so nothing in the tree echoes one
 * today. It stays because the *next* thing that echoes one is not in the tree
 * yet, and three paths reach here the moment something is: `execRclone`'s argv
 * guard throws an `ExecError` carrying the command it refused, so the first call
 * site that interpolates a secret is masked on a live route rather than
 * journalled in clear; the credentials now travel as `buildEnvScript`'s
 * `export RCLONE_S3_SECRET_ACCESS_KEY=…` lines on `sh -s`'s stdin, and a shell
 * echoes the offending line back on a syntax error and every line under
 * `set -x`; and rclone prints its own resolved configuration under `--dump` and
 * `-vv`. Delete this and all three become a journal entry in clear.
 */
export const redactS3Credentials = (
  message: string,
  credentials: Pick<S3Credentials, 'accessKey' | 'secretAccessKey'>,
): string => {
  let out = message.replace(CREDENTIAL_ASSIGNMENT, `$1${MASK}`);
  for (const value of [credentials.secretAccessKey, credentials.accessKey]) {
    if (!value || value.length < MIN_MASKED_CREDENTIAL_LENGTH) continue;
    out = out.split(value).join(MASK);
  }
  return out;
};

/**
 * The string fields of a failed exec that outlive the failure — the list this
 * file's mask walks, and it lives in `common/logging/error-payloads.ts` now.
 *
 * It moved because a **second** mask walks it: `elidePayloadsInError` takes an
 * encoded *file body* out of the same six fields of the same errors, so one
 * list means the next field added is covered by both rather than by whichever
 * of the two the author happened to have open. The reasoning for each entry,
 * and the measurement behind it, went with it.
 *
 * Still re-exported from here, because the argument for exporting it at all
 * is about *this* mask: the array is `redactS3Credentials`' guarantee, and
 * `test/destinations/s3-credentials.spec.ts` enumerating it is the only place
 * the whole list can be driven — no route produces an error carrying a
 * credential in six fields at once, so the array has to be reachable from the
 * test or the check drifts silently the next time a field is added without
 * being masked. F-41 concluded a live route cannot exercise the mask at all,
 * and that is no longer true: two route-level tests drive one field —
 * `stderr` — end to end, through an endpoint holding pasted credentials, which
 * rclone echoes back as the URL it could not reach. What they cannot do is
 * enumerate the list, which is why both kinds of test exist.
 */
export { REDACTED_ERROR_FIELDS };

/**
 * `redactS3Credentials` applied to an error on its way back out of an rclone
 * invocation — the second layer on every backup, restore, prune and listing,
 * the way the destination probes already have it on their refusal message.
 *
 * Not dead code — see `redactS3Credentials` above for why F-41 counted
 * zero masks in the journal and why that is the first layer working rather than
 * this one being unused. `execRclone`'s argv guard rejects *through* here, so the
 * one error shape that carries a credential by construction is masked before the
 * exception filter ever sees it.
 *
 * In place, and returning the same error, rather than building a fresh
 * exception: what these routes throw *is* the status code they answer with, and
 * that status code is a different question, not this one — rebuilding the error here
 * would answer it by accident. Mutating a caught error is otherwise not the
 * house style, so it is confined to this helper.
 *
 * `originalError` is followed one level down because that is where the raw
 * child_process error sits, carrying its own copy of the command; deeper than
 * that nothing in this tree nests, and a cycle would not terminate. The depth is
 * fixed rather than a parameter: no caller has a second opinion about it, and an
 * exported knob nothing turns is one a reader has to account for.
 */
export const redactS3CredentialsInError = <T>(
  error: T,
  credentials: Pick<S3Credentials, 'accessKey' | 'secretAccessKey'>,
): T => {
  redactInPlace(error, credentials, 1);
  return error;
};

const redactInPlace = (
  error: unknown,
  credentials: Pick<S3Credentials, 'accessKey' | 'secretAccessKey'>,
  depth: number,
): void => {
  if (!error || typeof error !== 'object') return;
  const fields = error as Record<string, unknown>;
  for (const field of REDACTED_ERROR_FIELDS) {
    const value = fields[field];
    if (typeof value === 'string') {
      fields[field] = redactS3Credentials(value, credentials);
    }
  }
  if (depth > 0) redactInPlace(fields.originalError, credentials, depth - 1);
};
