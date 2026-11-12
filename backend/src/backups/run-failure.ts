import { rcloneFailureMessage } from '../destinations/rclone-exec';
import { BACKUP_RUN_FAILED_STEP, DUMP_FAILED_MARKER } from './commands';

/**
 * What a pressed **Run now** is answered with when the run it started has
 * failed.
 *
 * By the time this is built the run has been recorded as a `deployment` with
 * status `error` and its log holds the whole transcript, so the answer's job is
 * to say *which* step broke, against *which* destination, and where the rest is
 * — not to repeat the log. It used to be a bare 500, which the console
 * rendered as "…so nothing changed" over a failed run it had just recorded.
 *
 * **The reason comes from the script's stderr and nowhere else.** The generated
 * script writes its failure heading and the tool's own words there
 * (`buildBackupScript`), and every other field is worse: on the platform host
 * the exec's `message` is Node's `Command failed: <the whole script>`, and on a
 * Server it is `Remote command failed with exit code 1`. So a stderr with
 * nothing in it gives an answer with no reason, pointing at the log, rather than
 * one built from the script source. What does arrive is already credential-
 * masked (`execRclone`), and bounded here by `rcloneFailureMessage`'s cap and
 * syslog-prefix strip, which exist for exactly this kind of text.
 */
export const backupRunFailureMessage = (
  error: unknown,
  names: { database: string; destination: string },
): string => {
  const { database, destination } = names;
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const lines = (typeof stderr === 'string' ? stderr : '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== DUMP_FAILED_MARKER);

  const heading = lines[0]?.replace(/^❌ Error: /, '');
  const step = (
    Object.keys(
      BACKUP_RUN_FAILED_STEP,
    ) as (keyof typeof BACKUP_RUN_FAILED_STEP)[]
  ).find((key) => BACKUP_RUN_FAILED_STEP[key] === heading);
  const reason = rcloneFailureMessage(
    { stderr: (step ? lines.slice(1) : lines).join('\n') },
    '',
  );

  // No full stop of our own at the end (§2.5): the console's `asSentence`
  // closes a message that ends in a word. Interior sentences keep theirs, as
  // `assertStoredValuesShellSafe` and `OAuthStateService`'s refusal do — this
  // is operator copy with a step, a pointer and a reason, not one fragment. The
  // reason goes last and is left as the tool wrote it.
  const log =
    'The run is listed on Deployments as a failed Database backup, and its log has the full output';
  const withReason = (lead: string, stoppedWith: string) =>
    reason ? `${lead} ${log}. ${stoppedWith}: ${reason}` : `${lead} ${log}`;

  switch (step) {
    case 'upload':
      return withReason(
        `Uploading the dump of ${database} to ${destination} failed.`,
        'The upload stopped with',
      );
    case 'dump':
      return withReason(
        `Dumping ${database} failed before it reached ${destination}.`,
        'The dump stopped with',
      );
    case 'container':
      return withReason(
        `Dumping ${database} to ${destination} did not start: the database has no running container.`,
        'It stopped with',
      );
    default:
      return withReason(
        `The backup of ${database} to ${destination} failed.`,
        'It stopped with',
      );
  }
};
