import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DeploymentsService } from '../../src/deployments/deployments.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';

/**
 * H-19: `initLogFile` builds `mkdir -p ${directory}; echo "…" >> ${logPath};`
 * and hands the string to `RemoteExecService` — `execAsync` on the platform
 * host, `execAsyncRemote` over SSH to a build Server. Both words were bare,
 * which is the shape that reopened the earlier shell-safety fix at
 * `docker/docker.utils.ts` (H-12).
 *
 * The payloads below carry a `;`, a space and a `$(…)`, and `APP_NAME_REGEX`
 * would refuse all three at the mint — deliberately. That regex lives two
 * modules and a table away from this word, so what it proves is that *today's*
 * callers are clean, not that the builder is; the builder has to be safe on
 * the value it is handed, which is what these assert.
 * `builders/build-strategy.ts` states the rule.
 *
 * **The proof is the shell's, not this file's.** Three of these run the
 * emitted command under `sh` in a temporary directory and assert on what is on
 * disk afterwards — the precedent is `test/deployment-engine/volume-lock.spec.ts`
 * and `test/backups/backup-script.spec.ts`, both of which execute what they
 * pin. A string assertion can only restate the builder; `sh` is the thing the
 * builder is wrong or right about, and the payload is written to leave a file
 * behind if it ever stops being one word.
 *
 * `initLogFile` is private and there is no public seam onto it that does not
 * need a database — `initializeLog` and every caller above it read the
 * application row first. So it is reached by name, with the one collaborator
 * this path touches supplied and the rest left unbuilt: anything it reached
 * beyond `remoteExec` would fail loudly rather than pass quietly.
 */
describe('DeploymentsService.initLogFile', () => {
  const initLogFileOn = async (
    serverId: string | null,
    logPath: string,
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

    const service = new DeploymentsService(
      null as never,
      null as never,
      remoteExec,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    await service['initLogFile'](serverId, logPath);
    return emitted;
  };

  it('builds the bootstrap for a legitimate log path', async () => {
    // A path with nothing shell-special in it needs no quotes and gets none.
    // The `chmod` is the owner-only fix's; the rest is byte-identical to before H-19.
    expect(
      await initLogFileOn(null, '/etc/cloudgate/logs/blog-app/dep-1.log'),
    ).toBe(
      'mkdir -p /etc/cloudgate/logs/blog-app && ' +
        'chmod 700 /etc/cloudgate/logs/blog-app; ' +
        'echo "Initializing deployment" >> ' +
        '/etc/cloudgate/logs/blog-app/dep-1.log;',
    );
  });

  /**
   * A build log is whatever the build printed, and it was `0644` under
   * `0755` directories the console's `cloudgate` user could walk. Run under
   * `sh` like the cases below, with the directory pre-made `0755` the way an
   * earlier version left it, so the assertion is that the bootstrap *corrects*
   * one rather than only creating a new one right.
   */
  it('leaves the log directory readable by its owner alone', async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-log-mode-')),
    );
    try {
      fs.mkdirSync(`${root}/blog-app`, { mode: 0o755 });
      fs.chmodSync(`${root}/blog-app`, 0o755);
      const command = await initLogFileOn(null, `${root}/blog-app/dep-1.log`);

      expect(spawnSync('sh', ['-c', command]).status).toBe(0);
      expect(fs.statSync(`${root}/blog-app`).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  describe('a metacharacter no charset in front of this word carries', () => {
    let root: string;

    /** Runs the emitted command with the temporary directory as its cwd, so a
     * payload that escapes its word lands somewhere this test can see. */
    const runIn = (command: string) =>
      spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8' });

    beforeEach(() => {
      root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-log-init-')),
      );
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('keeps a statement separator and a space inside one word', async () => {
      // `;` ends a command in a bare word and is an ordinary filename
      // character inside quotes; a space splits one word into two. Nothing
      // between this builder and an `appName` column would stop either.
      const command = await initLogFileOn(
        'srv-1',
        `${root}/x;touch pwned #/dep-1.log`,
      );

      expect(runIn(command).status).toBe(0);
      // The whole payload is one directory name, not a second command.
      expect(fs.readdirSync(root)).toEqual(['x;touch pwned #']);
      expect(fs.readFileSync(`${root}/x;touch pwned #/dep-1.log`, 'utf8')).toBe(
        'Initializing deployment\n',
      );
    });

    it('keeps a command substitution inside one word', async () => {
      // The characters H-12's refusal *does* carry, asserted here because this
      // sink has no refusal in front of it at all — so `quote()` is the whole
      // of the defence, and the double quotes H-12 could afford would have
      // substituted this one anyway.
      const command = await initLogFileOn(
        null,
        `${root}/a$(touch pwned)/dep-1.log`,
      );

      expect(runIn(command).status).toBe(0);
      expect(fs.readdirSync(root)).toEqual(['a$(touch pwned)']);
    });

    it('keeps a backtick substitution inside one word', async () => {
      const command = await initLogFileOn(
        null,
        `${root}/a\`touch pwned\`/dep-1.log`,
      );

      expect(runIn(command).status).toBe(0);
      expect(fs.readdirSync(root)).toEqual(['a`touch pwned`']);
    });
  });
});
