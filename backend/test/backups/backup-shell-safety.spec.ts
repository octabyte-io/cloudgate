import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BACKUP_COMMANDS,
  buildBackupScript,
  buildPruneCommand,
  buildRestoreScript,
  getComposeContainerCommand,
  getServiceContainerCommand,
} from '../../src/backups/commands';

/**
 * H-33, H-35, H-36 and H-37: everything this module interpolates into a shell
 * is `quote()`d, and these prove it by running the emitted commands.
 *
 * The values are the ones an operator supplies. `metadata`'s credentials are
 * the ones nothing constrains and nothing will — a password's characters are
 * exactly the ones a charset would refuse — and `logPath` carries an `appName`
 * held to `APP_NAME_REGEX` three modules away. `serviceName` took Compose's own
 * charset first, and `prefix` and `database` took theirs in a later
 * follow-up; the payloads below are asserted against all three all the same,
 * because what is under test is the builder's quoting, which has to hold for a
 * value no schema ever saw — a stored row, or the next caller.
 * Every one of them was either bare or inside `"…"`, where a `$(…)`
 * substitutes exactly as it does in a bare word, and every one of
 * these commands goes to `RemoteExecService` on the host that runs the dump.
 *
 * The proof is `sh`'s, not a string comparison: `PATH` is a stub directory
 * with no `touch` on it, the payload tries to create a file, and the assertion
 * is that the file is not there. A string assertion would only restate the
 * builder — `test/deployment-engine/volume-lock.spec.ts` and
 * `test/backups/backup-script.spec.ts`'s own executed block are the precedent.
 */
describe('buildBackupScript', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-backup-safety-')),
  );
  const binDir = path.join(root, 'bin');
  const argsLog = path.join(root, 'args.log');

  /** Records every argument it is given, one per line, and succeeds. */
  const RECORDING_STUB = `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >> "$STUB_LOG"; done
exit 0
`;

  beforeAll(() => {
    fs.mkdirSync(binDir);
    for (const name of ['rm', 'cat', 'date']) {
      const resolved = spawnSync('/bin/sh', ['-c', `command -v ${name}`], {
        encoding: 'utf8',
      }).stdout.trim();
      if (!resolved) throw new Error(`the executed shell needs ${name}`);
      fs.symlinkSync(resolved, path.join(binDir, name));
    }
    for (const name of ['docker', 'rclone']) {
      fs.writeFileSync(path.join(binDir, name), RECORDING_STUB, {
        mode: 0o755,
      });
    }
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(argsLog, { force: true });
    fs.rmSync(path.join(root, 'pwned'), { force: true });
  });

  /** Runs a command with only the stubs on `PATH`, and answers the arguments
   * they were handed. `bash` is deliberately absent, so a `bash -c` never runs
   * a second shell — what is under test is the first one's word splitting.
   *
   * `shell` is the one the product hands the command to, and it is not always
   * `sh`. `buildBackupScript` opens with `set -eo pipefail` and
   * `BackupsService` dispatches it with `shell: '/bin/bash'`; the prune goes
   * out under the default. This used to run everything under `/bin/sh`, which
   * is bash on macOS and **dash** on Ubuntu — so the backup script's six tests
   * had only ever been green on macOS, and on the first Linux run of this lane
   * (for CI) dash refused `pipefail` at line one and all six went red. */
  const run = (command: string, shell = '/bin/sh'): string[] => {
    spawnSync(shell, ['-c', command], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: binDir, STUB_LOG: argsLog },
    });
    return fs.existsSync(argsLog)
      ? fs.readFileSync(argsLog, 'utf8').split('\n').filter(Boolean)
      : [];
  };

  const pwned = () => fs.existsSync(path.join(root, 'pwned'));

  const PAYLOADS = [
    ['a command substitution', 'a$(touch pwned)'],
    ['a backtick substitution', 'a`touch pwned`'],
    ['a statement separator', 'x;touch pwned #'],
  ] as const;

  describe('the run log path (H-33)', () => {
    // Sixteen `>> ${logPath}` redirects took the path bare. It is
    // `{logsDirectoryOn}/{appName}/{deploymentId}.log`, so the whole of what
    // stood between them and the run host was `APP_NAME_REGEX`, at its mint,
    // in another module — the arrangement H-12 and H-19 were both about.
    for (const [what, payload] of PAYLOADS) {
      it(`redirects into one file when the path carries ${what}`, () => {
        const script = buildBackupScript({
          containerSearch: 'echo cid',
          dumpCommand: 'echo dump',
          rcloneCommand: 'rclone rcat dest',
          logPath: `${root}/${payload}.log`,
          uploadTarget: ':s3:bucket/key',
        });

        run(script, '/bin/bash');
        expect(pwned()).toBe(false);
        expect(fs.existsSync(`${root}/${payload}.log`)).toBe(true);
      });
    }
  });

  describe('the S3 object the failed run cleans up (H-36)', () => {
    // `uploadTarget` is `:s3:{bucket}/{appName}/{prefix}/{file}` and `prefix`
    // is `z.string().min(1)`. It reaches `rclone lsf`, `rclone deletefile` and
    // an `echo`, all of which were double-quoted — which stops a space and not
    // a substitution.
    for (const [what, payload] of PAYLOADS) {
      it(`names the object as one argument when the key carries ${what}`, () => {
        const target = `:s3:bucket/${payload}/dump.sql.gz`;
        const script = buildBackupScript({
          // A failing dump, so the cleanup branch is the one that runs.
          containerSearch: 'echo cid',
          dumpCommand: 'false',
          rcloneCommand: 'rclone rcat dest',
          logPath: `${root}/run.log`,
          uploadTarget: target,
        });

        const args = run(script, '/bin/bash');
        expect(pwned()).toBe(false);
        expect(args).toContain(target);
      });
    }
  });

  describe('the prune listing and delete (H-36)', () => {
    // `backupFilesPath` was **bare**, and it ends in the same unconstrained
    // `prefix`. `include` was double-quoted.
    for (const [what, payload] of PAYLOADS) {
      it(`lists and deletes under one path when the prefix carries ${what}`, () => {
        const command = buildPruneCommand({
          backupFilesPath: `:s3:bucket/main-db/${payload}/`,
          include: '*.{sql.gz,bson.gz}',
          keepLatestCount: 3,
        });

        const args = run(command);
        expect(pwned()).toBe(false);
        expect(args).toContain(`:s3:bucket/main-db/${payload}/`);
        expect(args).toContain('*.{sql.gz,bson.gz}');
      });
    }
  });

  describe('the container search (H-35)', () => {
    // `serviceName` is `z.string().optional()` on both create DTOs — no
    // charset, no mint, nothing between the request body and this word. It is
    // the compose-side twin of the `volumeName` H-19 found reaching `mkdir`.
    for (const [what, payload] of PAYLOADS) {
      it(`filters on one label when the service name carries ${what}`, () => {
        const args = run(
          getComposeContainerCommand('shop-stack', payload, 'docker-compose'),
        );

        expect(pwned()).toBe(false);
        expect(args).toContain(`label=com.docker.compose.service=${payload}`);
      });

      it(`filters on one label when the app name carries ${what}`, () => {
        const args = run(getServiceContainerCommand(payload));

        expect(pwned()).toBe(false);
        expect(args).toContain(
          `label=com.docker.swarm.service.name=${payload}`,
        );
      });
    }
  });

  describe('the engine dump and restore pipelines (H-37)', () => {
    // Two shells, and the program has to survive both: in a `"…"` on the
    // host shell, the `'…'` inside it is stripped of any meaning before
    // `docker` is reached. `database` is
    // `z.string().min(1)` and a compose backup's credentials are plain
    // `z.string()` on the DTO's `metadata`.
    for (const [what, payload] of PAYLOADS) {
      it(`hands docker one program when the database name carries ${what}`, () => {
        const args = run(
          BACKUP_COMMANDS.postgres.dump({
            database: payload,
            databaseUser: 'shop_user',
          }).command,
        );

        expect(pwned()).toBe(false);
        // `-c` and its program are two arguments of the *host* shell, and the
        // payload is inside the second rather than a command of its own. It is
        // still quoted in there, for the shell `docker` will start — the two
        // levels are quoted separately and this asserts both at once.
        const program = args[args.length - 1];
        expect(args[args.length - 2]).toBe('-c');
        expect(program).toContain(`--no-password '${payload}' | gzip`);
      });

      it(`hands docker one program when a credential carries ${what}`, () => {
        const secret = `${payload}-p4ssw0rd`;
        const { command, env } = BACKUP_COMMANDS.mongo.restore({
          database: 'shop',
          databaseUser: payload,
          databasePassword: secret,
        });
        const args = run(command);

        expect(pwned()).toBe(false);
        const program = args[args.length - 1];
        expect(args[args.length - 2]).toBe('-c');
        expect(program).toContain(`--username '${payload}' --password`);
        // The **password** is no longer one of the words this program quotes at
        // all: it travels in `env` and the program names the variable.
        // Its own quoting proof moved with it — the value now crosses the exec
        // environment and `docker exec -e`, and is expanded inside `"…"` by the
        // container's shell, which `backup-credential-never-carried.spec.ts`
        // re-runs these payloads through. `databaseUser` carries the payload
        // here instead, because it is still interpolated and is the credential
        // field H-37's claim now rests on.
        expect(program).not.toContain(secret);
        expect(env).toEqual({ CLOUDGATE_DB_PASSWORD: secret });
      });
    }

    it('keeps the mongo restore archive name one word', () => {
      // `backupFile` is `restoreBackupSchema`'s, `z.string().min(1)`, and its
      // last segment lands in `gunzip -f …` and the `< …` redirect.
      const script = buildRestoreScript({
        containerSearch: 'echo cid',
        restoreCommand: 'cat',
        rcloneCommand: 'rclone copy src',
        reachabilityProbe: 'true',
        databaseType: 'mongo',
        backupFile: 'daily/a$(touch pwned).bson.gz',
      });

      expect(script).toContain("gunzip -f 'a$(touch pwned).bson.gz'");
      expect(script).toContain("cat < 'a$(touch pwned).bson'");
    });
  });
});
