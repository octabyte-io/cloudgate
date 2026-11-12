import { BACKUP_RUN_FAILED_STEP } from '../../src/backups/commands';
import { backupRunFailureMessage } from '../../src/backups/run-failure';
import { ExecError } from '../../src/remote/exec-error';

/**
 * What a pressed Run now is answered with when the run it recorded
 * failed. The step and the destination are named, the Deployments entry is
 * pointed at, and the reason is the tool's own words from the script's stderr —
 * never the exec's `message`, which on the platform host is Node's
 * `Command failed: <the whole script>`.
 */
describe('backupRunFailureMessage', () => {
  const names = { database: 'shop', destination: 'prod-backups' };
  // No trailing full stop of its own (§2.5); the console's `asSentence` adds
  // one to a message that ends in a word.
  const LOG =
    'The run is listed on Deployments as a failed Database backup, and its log has the full output';

  /** The rejection the exec seam hands back when the generated script fails. */
  const failed = (stderr: string) =>
    new ExecError(
      'Command execution failed: Command failed: set -eo pipefail; echo …',
      { command: 'set -eo pipefail; echo …', stdout: '', stderr, exitCode: 1 },
    );

  it('names the upload and the destination, and ends with what the destination said', () => {
    expect(
      backupRunFailureMessage(
        failed(
          `❌ Error: ${BACKUP_RUN_FAILED_STEP.upload}\nFailed to rcat: SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided.\n`,
        ),
        names,
      ),
    ).toBe(
      `Uploading the dump of shop to prod-backups failed. ${LOG}. The upload stopped with: Failed to rcat: SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided.`,
    );
  });

  it('names the dump, and leaves the script’s own marker line out of the reason', () => {
    expect(
      backupRunFailureMessage(
        failed(
          `❌ Error: ${BACKUP_RUN_FAILED_STEP.dump}\npg_dump: error: connection refused\nThe dump exited non-zero, so anything that reached S3 is a truncated stream\n`,
        ),
        names,
      ),
    ).toBe(
      `Dumping shop failed before it reached prod-backups. ${LOG}. The dump stopped with: pg_dump: error: connection refused`,
    );
  });

  it('says the dump never started when there was no container', () => {
    expect(
      backupRunFailureMessage(
        failed(`❌ Error: ${BACKUP_RUN_FAILED_STEP.container}\n`),
        names,
      ),
    ).toBe(
      `Dumping shop to prod-backups did not start: the database has no running container. ${LOG}`,
    );
  });

  it('never answers with the exec message, which can be the whole script', () => {
    const message = backupRunFailureMessage(failed(''), names);
    expect(message).toBe(`The backup of shop to prod-backups failed. ${LOG}`);
    expect(message).not.toContain('set -eo pipefail');
  });

  it('keeps an unmarked stderr as the reason', () => {
    expect(
      backupRunFailureMessage(
        failed('Cannot connect to the Docker daemon\n'),
        names,
      ),
    ).toBe(
      `The backup of shop to prod-backups failed. ${LOG}. It stopped with: Cannot connect to the Docker daemon`,
    );
  });

  it('bounds a reason a stalling endpoint narrated for minutes', () => {
    const message = backupRunFailureMessage(
      failed(
        `❌ Error: ${BACKUP_RUN_FAILED_STEP.upload}\n` +
          'ERROR : low level retry 1/10: connection reset\n'.repeat(1500) +
          'Failed to rcat: connection refused',
      ),
      names,
    );
    expect(message.length).toBeLessThanOrEqual(9 * 1024);
    expect(message).toContain('connection refused');
  });

  it('is never "nothing changed"', () => {
    expect(backupRunFailureMessage(new Error('boom'), names)).not.toMatch(
      /nothing changed/i,
    );
  });
});
