import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEPLOYMENT_LOG_RETENTION_DAYS,
  isPastLogRetention,
  logPresenceProbeCommand,
  logRetentionSweepCommand,
  readLogFileAbsence,
  reapedLogNotice,
} from '../../src/deployments/log-retention';

/**
 * The retention that bounds a deployment log's life on the machine that wrote
 * it (ADR-0020).
 *
 * Nothing in the product had ever deleted a `deployment.logPath`: there is no
 * `delete(deployment)` anywhere in the tree and the only log cron rotates
 * Traefik's access log, so every build log every Application ever wrote was
 * still on its build host. That is not the cascade's shape — the cascade is not what
 * strands these, they are stranded from birth — so the answer is a retention
 * decision rather than a teardown step, and it is age on the **file** rather
 * than status on the row precisely so that it also reaches the logs whose rows
 * the cascade has already destroyed. ADR-0020 carries the argument, including
 * why the window is one constant rather than two.
 *
 * **The proof is the shell's, not this file's.** The sweep is a shell program,
 * so the tests below run it under `sh` against a real tree with real mtimes and
 * assert what is left — `deployment-log-init.spec.ts`' and
 * `deployment-engine/volume-lock.spec.ts`' precedent. A string assertion can
 * only restate the builder; `sh` is the thing the builder is wrong or right
 * about.
 */
const daysAgo = (days: number) => {
  const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return at;
};

/** A log file at `{root}/{appName}/{deploymentId}.log`, aged by its mtime. */
const writeLog = (
  root: string,
  appName: string,
  deploymentId: string,
  ageDays: number,
) => {
  const directory = path.join(root, appName);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${deploymentId}.log`);
  fs.writeFileSync(file, 'Initializing deployment\n');
  const at = daysAgo(ageDays);
  fs.utimesSync(file, at, at);
  return file;
};

/** Every file left under the root, as `{appName}/{file}` paths. */
const survivors = (root: string): string[] => {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found.sort();
};

const runSweep = (root: string) => {
  const result = spawnSync('sh', ['-c', logRetentionSweepCommand(root)], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return result;
};

describe('logRetentionSweepCommand', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-logs-')),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reaps a log past the retention window and keeps one inside it', () => {
    writeLog(root, 'web-app', 'old-one', DEPLOYMENT_LOG_RETENTION_DAYS + 5);
    writeLog(root, 'web-app', 'recent-one', 3);

    runSweep(root);

    expect(survivors(root)).toEqual([path.join('web-app', 'recent-one.log')]);
  });

  /**
   * The half a row-driven sweep structurally cannot reach, and the reason this
   * one is an age predicate over the tree instead: a log whose Deployment row
   * went with its Application is exactly the population the root audit is about, and
   * after the cascade nothing in the database names it.
   */
  it('reaps a log no row names any more, because it asks the tree and not the rows', () => {
    writeLog(root, 'deleted-app', 'orphan', DEPLOYMENT_LOG_RETENTION_DAYS + 40);

    runSweep(root);

    expect(survivors(root)).toEqual([]);
  });

  // A deploy in flight has an mtime of *now*, so the window never selects it —
  // which is what makes a daily sweep safe to run against a live build host
  // with no lock and no coordination.
  it('cannot select the log of a build that is still writing', () => {
    writeLog(root, 'web-app', 'in-flight', 0);

    runSweep(root);

    expect(survivors(root)).toEqual([path.join('web-app', 'in-flight.log')]);
  });

  /**
   * The tree is the platform's, but it is not the platform's alone to assume:
   * the sweep names `*.log` under the logs root and nothing else, so an
   * operator's own file in there — and, more importantly, any future subtree
   * the platform grows under `CLOUDGATE_DIRECTORY` — survives it.
   */
  it('touches nothing that is not a .log file', () => {
    const directory = path.join(root, 'web-app');
    fs.mkdirSync(directory, { recursive: true });
    const keep = path.join(directory, 'notes.txt');
    fs.writeFileSync(keep, 'operator notes');
    const at = daysAgo(DEPLOYMENT_LOG_RETENTION_DAYS + 100);
    fs.utimesSync(keep, at, at);

    runSweep(root);

    expect(survivors(root)).toEqual([path.join('web-app', 'notes.txt')]);
  });

  it('clears the per-Application directory it has emptied', () => {
    writeLog(root, 'gone-app', 'old-one', DEPLOYMENT_LOG_RETENTION_DAYS + 5);
    writeLog(root, 'live-app', 'recent-one', 1);

    runSweep(root);

    expect(fs.existsSync(path.join(root, 'gone-app'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'live-app'))).toBe(true);
  });

  it('names every file it reaped, so a run can be counted rather than guessed', () => {
    writeLog(root, 'web-app', 'old-one', DEPLOYMENT_LOG_RETENTION_DAYS + 5);
    writeLog(root, 'api', 'old-two', DEPLOYMENT_LOG_RETENTION_DAYS + 9);

    const { stdout } = runSweep(root);

    expect(stdout.trim().split('\n').sort()).toEqual([
      path.join(root, 'api', 'old-two.log'),
      path.join(root, 'web-app', 'old-one.log'),
    ]);
  });

  // A host that has never run a build has no logs root at all, and a `find` on
  // a missing directory exits non-zero: without the guard every such Server
  // would journal a failed sweep every night for ever.
  it('succeeds quietly on a host that has never written a log', () => {
    fs.rmSync(root, { recursive: true, force: true });

    const result = spawnSync('sh', ['-c', logRetentionSweepCommand(root)], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  /**
   * `quote()`d like every other interpolation into a shell program (§2.9). The
   * root is `logsDirectoryOn`'s answer — either the `/etc/cloudgate` literal or
   * `CLOUDGATE_DIRECTORY`, which `isValidCloudgateDirectory` holds to an
   * absolute path with no `..` — so this is a charset at a distance, which is
   * exactly the shape that failed twice at `getCreateFileCommand`.
   */
  it('leaves nothing outside the root when the root is not one word', () => {
    const outside = path.join(root, 'outside.log');
    fs.writeFileSync(outside, 'not a deployment log');
    const at = daysAgo(DEPLOYMENT_LOG_RETENTION_DAYS + 100);
    fs.utimesSync(outside, at, at);
    const hostile = path.join(root, 'logs; rm -rf ' + root);
    fs.mkdirSync(hostile, { recursive: true });

    const result = spawnSync('sh', ['-c', logRetentionSweepCommand(hostile)], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe('isPastLogRetention', () => {
  const now = new Date('2026-09-08T12:00:00.000Z');

  it('says a deployment older than the window has had its log reaped', () => {
    expect(isPastLogRetention('2026-01-01T00:00:00.000Z', now)).toBe(true);
  });

  it('says nothing of the kind about a deployment inside the window', () => {
    expect(isPastLogRetention('2026-09-01T00:00:00.000Z', now)).toBe(false);
  });

  // Not dead code: `deployment.createdAt` is `isoTimestamp`, so a row written
  // by a migration or a fixture can carry a value `Date` cannot parse, and a
  // `NaN` comparison is `false` in both directions. An unreadable stamp must
  // read as *inside* the window, because the alternative is telling an operator
  // their log was reaped when the truth is that this route cannot tell.
  it('reads an unusable timestamp as inside the window', () => {
    expect(isPastLogRetention('not a date', now)).toBe(false);
    expect(isPastLogRetention(null, now)).toBe(false);
  });
});

describe('reapedLogNotice', () => {
  it('says what happened and names the window, rather than answering nothing', () => {
    expect(reapedLogNotice()).toContain(
      `${DEPLOYMENT_LOG_RETENTION_DAYS} days`,
    );
    expect(reapedLogNotice()).toMatch(/no longer/i);
  });
});

/**
 * The third question retention asks of a machine, and the one that closes
 * the earlier inversion.
 *
 * An earlier fix made the socket answer the same thing `GET /deployments/:id/logs`
 * answers, and left the two predicates *different*: `readLogs` asks absence
 * **and** age, the gateway asked age alone. So a Deployment past the window
 * whose log file is still there — a Server the sweep could not reach at 04:20,
 * or any of the up-to-a-day `-mtime +N` keeps — had HTTP streaming its log
 * while the socket closed `4013` saying it had been reaped. Age is a *proxy*
 * for absence; this is the question itself, and it is asked only after the
 * proxy says yes.
 *
 * As with the sweep, the proof is the shell's: these run the program under
 * `sh`, `dash` and `bash` against a real file and a real absence, because a
 * string assertion can only restate the builder.
 */
describe('logPresenceProbeCommand', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-probe-')),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const probe = (logPath: string, shell = 'sh') =>
    spawnSync(shell, ['-c', logPresenceProbeCommand(logPath)], {
      encoding: 'utf8',
    });

  it('says present for a log that is still there', () => {
    const file = writeLog(root, 'web-app', 'still-here', 200);

    const result = probe(file);

    expect(result.stdout.trim()).toBe('present');
    expect(result.status).toBe(0);
  });

  /**
   * **Exit 0 on both answers is the whole reason this is a program rather than
   * `test -f` over the argv transport** (H-95, `presenceProbeCommand`).
   * `RemoteExecService` rejects on a non-zero exit, so an exit-code probe would
   * deliver *"the file is gone"* and *"no route to the host"* as the same
   * rejection — and one of those two must close the socket while the other must
   * not. The answer is on stdout so one exec separates them.
   */
  it('says absent at exit 0 for a log that is not there, so a rejection can mean something else', () => {
    const result = probe(path.join(root, 'web-app', 'reaped.log'));

    expect(result.stdout.trim()).toBe('absent');
    expect(result.status).toBe(0);
  });

  // `-f` and not `-e`: the socket's next act is `tail -n +1 -f` on this path,
  // and a directory there is not a log the tail could follow either.
  it('says absent for a directory standing where the log should be', () => {
    const directory = path.join(root, 'web-app', 'not-a-log.log');
    fs.mkdirSync(directory, { recursive: true });

    expect(probe(directory).stdout.trim()).toBe('absent');
  });

  /**
   * `quote()`d like every interpolation into a shell program (§2.9). `logPath`
   * is the stored `deployment.logPath` column — `readLogs` quotes it for the
   * same reason and H-38 is why it is not double-quoted: a `$(…)` in a stored
   * path substitutes inside `"…"` exactly as it would bare.
   */
  it('reads a path that is not one word as one path, and runs nothing in it', () => {
    const bystander = path.join(root, 'bystander');
    fs.writeFileSync(bystander, 'still here');
    const hostile = path.join(root, `x.log; rm -f ${bystander}`);

    const result = probe(hostile);

    expect(result.stdout.trim()).toBe('absent');
    expect(fs.existsSync(bystander)).toBe(true);
  });

  /**
   * The transport rules `RemoteExecService` documents, held here rather than
   * discovered on a Server. It has to be POSIX because a remote command
   * carrying an environment is read by `sh -s` rather than by the account's
   * login shell, and it must not read stdin because with an environment the
   * program *is* on the shell's own stdin — under bash a stdin-reading command
   * eats the rest of the script and exits 0, which is the failure that reports
   * success.
   */
  it('is POSIX and reads nothing from stdin', () => {
    const file = writeLog(root, 'web-app', 'still-here', 200);
    const program = logPresenceProbeCommand(file);

    for (const shell of ['dash', 'sh', 'bash']) {
      const parsed = spawnSync(shell, ['-n'], {
        input: program,
        encoding: 'utf8',
      });
      // A shell this machine does not have is not a failing assertion about the
      // program: `dash` is absent on macOS by default and present on every
      // Server this deploys to.
      if (parsed.error) continue;
      expect(parsed.status).toBe(0);
      expect(probe(file, shell).stdout.trim()).toBe('present');
    }

    // The shape the remote branch actually sends when a command carries an
    // environment: the program on the shell's own stdin, with more of the
    // script after it.
    const onStdin = spawnSync('bash', ['-s'], {
      input: `${program}\necho reached\n`,
      encoding: 'utf8',
    });

    expect(onStdin.stdout).toBe('present\nreached\n');
  });
});

/**
 * The reader of {@link logPresenceProbeCommand}'s answer — the other half of
 * one contract, in `readWorkloadPresence`'s shape and for its reason.
 *
 * It takes a thunk rather than a string because **a rejection is part of the
 * answer**: the transport can fail before any shell runs, and that outcome has
 * to be told apart from the shell saying `absent`.
 */
describe('readLogFileAbsence', () => {
  it('is true only when the machine positively said the file is gone', async () => {
    expect(await readLogFileAbsence(() => Promise.resolve('absent\n'))).toBe(
      true,
    );
    expect(await readLogFileAbsence(() => Promise.resolve('present\n'))).toBe(
      false,
    );
  });

  /**
   * `isPastLogRetention`'s own bias, one artifact along: an unreadable
   * `createdAt` reads as *inside* the window because telling an operator their
   * log was reaped when the truth is that nothing could tell is worse than
   * saying nothing. A machine that cannot be reached is the same ignorance, so
   * the socket falls through to the tail, which reports the transport failure
   * itself.
   */
  it('is false when the probe never ran, because that is not an answer', async () => {
    expect(
      await readLogFileAbsence(() =>
        Promise.reject(new Error('no route to host')),
      ),
    ).toBe(false);
  });

  // Anything else is a shell that never ran the command — a login banner, an
  // empty answer, an sshd `motd`. `readWorkloadPresence`'s rule: that is no
  // more *gone* than a rejection is.
  it('is false for an answer that is not one of the two tokens', async () => {
    expect(await readLogFileAbsence(() => Promise.resolve(''))).toBe(false);
    expect(
      await readLogFileAbsence(() => Promise.resolve('Welcome to Ubuntu\n')),
    ).toBe(false);
  });
});
