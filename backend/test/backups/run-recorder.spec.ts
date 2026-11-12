import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { BackupRunRecorderService } from '../../src/backups/run-recorder.service';
import type { BackupRunStartOptions } from '../../src/backups/run-recorder.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';

/**
 * H-19: `start` builds `mkdir -p ${directory}; echo "${initMessage}" >> ${logPath};`
 * and hands the string to `RemoteExecService`, which runs it on whichever host
 * the backup runs on. All three interpolations were bare or bare-inside-quotes,
 * which is the shape that reopened the earlier shell-safety fix at
 * `docker/docker.utils.ts` (H-12).
 *
 * `appName` is the caller-influenced part, and every value that reaches it
 * today is either `generateAppName`'s output or a name held to
 * `APP_NAME_REGEX` — so the payloads below could not arrive through the API as
 * it stands. That is the point: the regex is three modules and a table away
 * from this word and proves something about the *callers*, and this asserts
 * the property the builder owes on its own.
 *
 * The proof is `sh`'s. The command is executed against a temporary
 * CLOUDGATE_DIRECTORY and the assertion is on what the run host is left
 * holding — `test/deployment-engine/volume-lock.spec.ts` is the precedent, and
 * it exists there for the same reason: a string assertion restates the
 * builder, and the builder is the thing in question.
 */
describe('BackupRunRecorderService.start', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-run-recorder-')),
  );
  const original = process.env.CLOUDGATE_DIRECTORY;

  beforeAll(() => {
    process.env.CLOUDGATE_DIRECTORY = root;
  });

  afterAll(() => {
    if (original === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = original;
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(`${root}/logs`, { recursive: true, force: true });
  });

  /** The run recorder with the two collaborators `start` touches: the exec
   * service whose command is under test, and a database that answers the
   * insert without one. */
  const startWith = async (
    overrides: Partial<Omit<BackupRunStartOptions, 'parent' | 'cronRun'>> = {},
  ): Promise<string> => {
    let emitted = '';
    const remoteExec = {
      execAsync: (command: string) => {
        emitted = command;
        return Promise.resolve({ stdout: '', stderr: '' });
      },
      execAsyncRemote: (_serverId: string, command: string) => {
        emitted = command;
        return Promise.resolve({ stdout: '', stderr: '' });
      },
    } as unknown as RemoteExecService;

    const db = {
      insert: () => ({
        values: (row: { deploymentId: string; logPath: string }) => ({
          returning: () => Promise.resolve([row]),
        }),
      }),
    } as unknown as DrizzleDB;

    await new BackupRunRecorderService(db, remoteExec).start({
      appName: 'volume-backup-abc123',
      serverId: null,
      title: 'Volume Backup',
      description: 'Volume Backup',
      initMessage: 'Initializing volume backup',
      parent: { kind: 'volumeBackup', volumeBackupId: 'vb-1' },
      ...overrides,
    });
    return emitted;
  };

  /** Runs the emitted command with the temporary root as its cwd, so a payload
   * that escapes its word lands somewhere this test can see. */
  const runIn = (command: string) =>
    spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8' });

  it('creates the run-log directory and writes the first line into it', async () => {
    const command = await startWith();

    expect(runIn(command).status).toBe(0);
    const directory = `${root}/logs/volume-backup-abc123`;
    const [logFile] = fs.readdirSync(directory);
    expect(fs.readFileSync(`${directory}/${logFile}`, 'utf8')).toBe(
      'Initializing volume backup\n',
    );
  });

  describe('a metacharacter no charset in front of these words carries', () => {
    it('keeps a statement separator and a space inside one word', async () => {
      // `;` ends a command in a bare word and names a file inside quotes; a
      // space splits one word into two. Nothing between this builder and the
      // `app_name` column it reads would stop either.
      const command = await startWith({ appName: 'x;touch pwned #' });

      expect(runIn(command).status).toBe(0);
      expect(fs.readdirSync(`${root}/logs`)).toEqual(['x;touch pwned #']);
      expect(fs.existsSync(`${root}/pwned`)).toBe(false);
    });

    it('keeps a command substitution inside one word', async () => {
      // Double quotes would not have been enough here: `$(…)` substitutes
      // inside them, which is why all three words are `quote()`d rather than
      // wrapped the way H-12's sink could afford to wrap its own.
      const command = await startWith({ appName: 'a$(touch pwned)' });

      expect(runIn(command).status).toBe(0);
      expect(fs.readdirSync(`${root}/logs`)).toEqual(['a$(touch pwned)']);
      expect(fs.existsSync(`${root}/pwned`)).toBe(false);
    });

    it('keeps a substitution in the log line inside one word', async () => {
      // `initMessage` is a literal at all three call sites and is quoted
      // anyway: a word that happens to be safe and a word that is made safe
      // read identically at the next edit, and that is how the two previous
      // failures were introduced.
      const command = await startWith({
        initMessage: 'Initializing $(touch pwned)',
      });

      expect(runIn(command).status).toBe(0);
      expect(fs.existsSync(`${root}/pwned`)).toBe(false);
      const directory = `${root}/logs/volume-backup-abc123`;
      const [logFile] = fs.readdirSync(directory);
      expect(fs.readFileSync(`${directory}/${logFile}`, 'utf8')).toBe(
        'Initializing $(touch pwned)\n',
      );
    });
  });
});
