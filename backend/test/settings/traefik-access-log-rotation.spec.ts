import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import { indexPathFor } from '../../src/monitoring/access-log.index';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { ACCESS_LOG_ROTATION_COMMENT } from '../../src/common/config/access-log-note';
import {
  ACCESS_LOG_BACKUPS,
  ACCESS_LOG_MAX_BYTES,
  TRAEFIK_CONTAINER_NAME,
  TraefikFilesService,
} from '../../src/settings/traefik-files.service';

// The first half of the access-log work. Traefik's access log is append-only and
// unbounded, so every read of it is unbounded too — an hour index makes a window
// cheap to *find*, but only a bounded file makes building that index bounded.
let dir: string;
let execAsync: jest.Mock;
let containerId: string;

function traefikFiles(): TraefikFilesService {
  execAsync = jest.fn((command: string) => {
    if (command.includes('docker ps')) {
      return Promise.resolve({ stdout: `${containerId}\n`, stderr: '' });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  });
  // `withArgvExec`: the SIGUSR1 is argv, and the fake words it into
  // the same command string this spec reads out of `execAsync.mock.calls`. The
  // `docker ps … | head -n 1` that finds the container is a pipeline and stays a
  // string, so the mock's routing above is unaffected.
  return new TraefikFilesService(
    withArgvExec({ execAsync }) as unknown as RemoteExecService,
    // A function of the machine. Only the platform-host branch is
    // exercised here — rotation is local by design, see `rotateAccessLog` — so
    // the temp dir answers for it and a Server would be a different file.
    () => dir,
  );
}

const logPath = () => path.join(dir, 'dynamic', 'access.log');

function writeLog(bytes: number): void {
  fs.mkdirSync(path.join(dir, 'dynamic'), { recursive: true });
  fs.writeFileSync(logPath(), 'x'.repeat(bytes));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-traefik-rotate-'));
  containerId = 'abc123';
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// The direction asked for was Traefik's own rotation configuration. Traefik
// 3.6.7 has none for the access log — `traefik --help` offers filePath, format,
// bufferingSize, filters, fields, addInternals and otlp under `accesslog`, and
// maxSize/maxAge/maxBackups/compress only under `log`, the *application* log. So
// the policy lives here, and the config the operator reads has to say so.
describe('the generated Traefik config', () => {
  it('still writes the accessLog block it always did', () => {
    const service = traefikFiles();
    service.writeMainConfig('entryPoints:\n  web:\n    address: ":80"\n');

    return service.toggleRequests(true).then(() => {
      const config = parse(service.readMainConfig() as string) as {
        accessLog?: { filePath: string; format: string; bufferingSize: number };
      };
      // Still a hardcoded location rather than a baseDir-derived
      // path, and an earlier fix established that this is the *only* right answer for it
      // rather than a coincidence: `filePath` is read by Traefik inside its
      // container, where the dynamic directory is mounted at this literal
      // whatever the host tree is rooted at. `rotateAccessLog` takes the
      // baseDir-derived path because it renames the file with `fs` on the host
      // side of that mount — the same file, the other side.
      expect(config.accessLog).toEqual({
        filePath: '/etc/cloudgate/traefik/dynamic/access.log',
        format: 'json',
        bufferingSize: 100,
      });
    });
  });

  it('documents the rotation Cloudgate performs, and why it is not in the block', async () => {
    const service = traefikFiles();
    service.writeMainConfig('entryPoints:\n  web:\n    address: ":80"\n');

    await service.toggleRequests(true);
    const yaml = service.readMainConfig() as string;

    // A comment, immediately above the block it is about.
    const [, comment] = /((?:^#.*\n)+)accessLog:/m.exec(yaml) ?? [];
    expect(comment).toBeDefined();
    // Traefik's limitation, named — an operator who goes looking for
    // accessLog.maxSize has to find out here that there is no such thing.
    expect(comment).toContain('Traefik');
    expect(comment).toMatch(/no accessLog\s+# rotation settings/);
    // Where the policy is, and the one hook it uses. Not the figures
    // themselves any more: the toggle's note used to spell out the MiB
    // limit, the backup count and `access.log.1`, and that is what made its
    // comment differ from the one install.sh writes on every host. The note is
    // now the installer's four lines, so it names the constant instead.
    expect(comment).toContain('ACCESS_LOG_MAX_BYTES');
    expect(comment).toContain('SIGUSR1');
    expect(comment).toBe(`${ACCESS_LOG_ROTATION_COMMENT}\n`);
  });

  it('takes the block, and its comment, away again when logging is switched off', async () => {
    const service = traefikFiles();
    service.writeMainConfig('entryPoints:\n  web:\n    address: ":80"\n');

    await service.toggleRequests(true);
    await service.toggleRequests(false);
    const yaml = service.readMainConfig() as string;

    expect(yaml).not.toContain('accessLog');
    expect(yaml).not.toContain('SIGUSR1');
    expect(await service.haveActivateRequests()).toEqual({
      present: true,
      enabled: false,
    });
  });

  it('keeps comments the operator wrote', async () => {
    const service = traefikFiles();
    service.writeMainConfig(
      '# our TLS notes, do not delete\nentryPoints:\n  web:\n    address: ":80"\n',
    );

    await service.toggleRequests(true);

    expect(service.readMainConfig()).toContain('our TLS notes, do not delete');
  });
});

describe('rotateAccessLog', () => {
  it('leaves a log that has not reached the limit alone', async () => {
    const service = traefikFiles();
    writeLog(1024);

    const result = await service.rotateAccessLog();

    expect(result).toEqual({ rotated: false, bytes: 1024 });
    expect(fs.existsSync(`${logPath()}.1`)).toBe(false);
    // Nothing was signalled: SIGUSR1 makes Traefik drop and reopen its log
    // handle, which is not a thing to do speculatively.
    expect(execAsync).not.toHaveBeenCalled();
  });

  // Rename, *then* signal. Between the two Traefik keeps writing to the renamed
  // file, which is the backup — so the lines in that window are kept, not lost.
  it('renames the log aside and has Traefik reopen it', async () => {
    const service = traefikFiles();
    writeLog(ACCESS_LOG_MAX_BYTES + 1);

    const result = await service.rotateAccessLog();

    expect(result).toEqual({
      rotated: true,
      bytes: ACCESS_LOG_MAX_BYTES + 1,
      backup: `${logPath()}.1`,
      reopened: true,
    });
    expect(fs.existsSync(`${logPath()}.1`)).toBe(true);
    expect(fs.existsSync(logPath())).toBe(false);

    const commands = execAsync.mock.calls.map(([command]) => command as string);
    expect(commands[0]).toContain(`name=${TRAEFIK_CONTAINER_NAME}`);
    expect(commands[1]).toBe(`docker exec ${containerId} kill -USR1 1`);
  });

  it('shifts the backups along and drops the oldest', async () => {
    const service = traefikFiles();
    writeLog(ACCESS_LOG_MAX_BYTES + 1);
    for (let n = 1; n <= ACCESS_LOG_BACKUPS; n += 1) {
      fs.writeFileSync(`${logPath()}.${n}`, `generation ${n}`);
    }

    await service.rotateAccessLog();

    expect(fs.readFileSync(`${logPath()}.2`, 'utf8')).toBe('generation 1');
    expect(fs.readFileSync(`${logPath()}.3`, 'utf8')).toBe('generation 2');
    // Generation 3 was the oldest kept; it is now off the end.
    expect(fs.existsSync(`${logPath()}.${ACCESS_LOG_BACKUPS + 1}`)).toBe(false);
    expect(fs.statSync(`${logPath()}.1`).size).toBe(ACCESS_LOG_MAX_BYTES + 1);
  });

  // The index's offsets are into the file that just moved. It detects that on
  // its own (the fingerprint changes), but leaving a stale index on disk for it
  // to load and throw away is pointless work and a confusing artefact.
  it('takes the hour index away with the log it described', async () => {
    const service = traefikFiles();
    writeLog(ACCESS_LOG_MAX_BYTES + 1);
    fs.writeFileSync(indexPathFor(logPath()), '{"hours":[]}');

    await service.rotateAccessLog();

    expect(fs.existsSync(indexPathFor(logPath()))).toBe(false);
  });

  it('does nothing at all when there is no access log', async () => {
    const service = traefikFiles();

    expect(await service.rotateAccessLog()).toEqual({
      rotated: false,
      bytes: 0,
    });
    expect(execAsync).not.toHaveBeenCalled();
  });

  // A rotation whose signal never lands leaves Traefik writing to the renamed
  // file, so the console would show nothing new until Traefik restarts. Say so.
  it('reports the rotation it did even when Traefik cannot be signalled', async () => {
    const service = traefikFiles();
    containerId = '';
    writeLog(ACCESS_LOG_MAX_BYTES + 1);

    const result = await service.rotateAccessLog();

    expect(result.rotated).toBe(true);
    expect(result.reopened).toBe(false);
  });
});

/**
 * A Server's rotation, against a double of the SSH boundary that runs
 * each program through a real `/bin/sh` on a temp tree — so the shift, the
 * rename and the quoting are the shell's answer, not a string this spec
 * compares against the builder that made it. Only Docker is faked: the
 * container lookup and the signal are recorded, in the order they arrived
 * among the file programs.
 */
describe('TraefikFilesService.rotateAccessLogOn', () => {
  const SERVER = 'srv-1';
  let remoteCalls: string[];
  let execAsyncRemote: jest.Mock;
  /** The PATH the Server's shell runs with; a test may put a stub in front. */
  let serverPath: string | undefined;

  function serverFiles(): TraefikFilesService {
    remoteCalls = [];
    serverPath = process.env.PATH;
    execAsyncRemote = jest.fn((_serverId: string, command: string) => {
      remoteCalls.push(command);
      if (command.includes('docker ps')) {
        return Promise.resolve({ stdout: `${containerId}\n`, stderr: '' });
      }
      if (command.startsWith('docker exec')) {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      try {
        const stdout = execFileSync('/bin/sh', ['-c', command], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PATH: serverPath },
        });
        return Promise.resolve({ stdout, stderr: '' });
      } catch (error) {
        return Promise.reject(error as Error);
      }
    });
    return new TraefikFilesService(
      withArgvExec({ execAsyncRemote }) as unknown as RemoteExecService,
      // The Server's root, which on a real Server is `/etc/cloudgate/traefik`.
      () => dir,
    );
  }

  function writeConfig(accessLogOn: boolean): void {
    fs.writeFileSync(
      path.join(dir, 'traefik.yml'),
      accessLogOn
        ? 'accessLog:\n  filePath: /etc/cloudgate/traefik/dynamic/access.log\n  format: json\n'
        : 'entryPoints:\n  web:\n    address: ":80"\n',
    );
  }

  function step(command: string): string {
    if (command.includes('docker ps')) return 'find traefik';
    if (command.startsWith('docker exec')) return 'signal';
    if (command.includes('mv -f')) return 'shift and rename';
    if (command.includes('wc -c')) return 'measure';
    if (command.includes('traefik.yml')) return 'read config';
    return command;
  }

  it('shifts, renames and then signals the Server’s Traefik, in that order', async () => {
    const service = serverFiles();
    writeConfig(true);
    writeLog(ACCESS_LOG_MAX_BYTES + 1);
    for (let n = 1; n <= ACCESS_LOG_BACKUPS; n += 1) {
      fs.writeFileSync(`${logPath()}.${n}`, `generation ${n}`);
    }

    const result = await service.rotateAccessLogOn(SERVER);

    expect(result).toEqual({
      rotated: true,
      bytes: ACCESS_LOG_MAX_BYTES + 1,
      backup: `${logPath()}.1`,
      reopened: true,
    });
    expect(remoteCalls.map(step)).toEqual([
      'read config',
      'measure',
      'shift and rename',
      'find traefik',
      'signal',
    ]);
    expect(remoteCalls[4]).toBe(`docker exec ${containerId} kill -USR1 1`);
    // Every call went to the Server; none of it ran on the platform host.
    expect(
      execAsyncRemote.mock.calls.every(([serverId]) => serverId === SERVER),
    ).toBe(true);
    expect(fs.existsSync(logPath())).toBe(false);
    expect(fs.statSync(`${logPath()}.1`).size).toBe(ACCESS_LOG_MAX_BYTES + 1);
    expect(fs.readFileSync(`${logPath()}.2`, 'utf8')).toBe('generation 1');
    expect(fs.readFileSync(`${logPath()}.3`, 'utf8')).toBe('generation 2');
    // Generation 3 was the oldest kept; it is now off the end.
    expect(fs.existsSync(`${logPath()}.${ACCESS_LOG_BACKUPS + 1}`)).toBe(false);
  });

  it('measures a log under the limit and neither renames nor signals', async () => {
    const service = serverFiles();
    writeConfig(true);
    writeLog(1024);

    const result = await service.rotateAccessLogOn(SERVER);

    expect(result).toEqual({ rotated: false, bytes: 1024 });
    expect(remoteCalls.map(step)).toEqual(['read config', 'measure']);
    expect(fs.statSync(logPath()).size).toBe(1024);
  });

  it('reads the config of a Server with the log off and issues nothing else', async () => {
    const service = serverFiles();
    writeConfig(false);
    // Big enough to rotate, were the log on: the gate is the config, not size.
    writeLog(ACCESS_LOG_MAX_BYTES + 1);

    expect(await service.rotateAccessLogOn(SERVER)).toEqual({
      rotated: false,
      bytes: 0,
    });
    expect(remoteCalls.map(step)).toEqual(['read config']);
    expect(fs.statSync(logPath()).size).toBe(ACCESS_LOG_MAX_BYTES + 1);
  });

  it('passes over a Server with no traefik.yml after the one read, without failing', async () => {
    const service = serverFiles();
    // A Server added and never set up. A log sits there anyway, to show it is
    // the missing config and not the size that leaves it alone.
    writeLog(ACCESS_LOG_MAX_BYTES + 1);

    expect(await service.rotateAccessLogOn(SERVER)).toEqual({
      rotated: false,
      bytes: 0,
    });
    expect(remoteCalls.map(step)).toEqual(['read config']);
    expect(fs.statSync(logPath()).size).toBe(ACCESS_LOG_MAX_BYTES + 1);
  });

  it('still rejects a Server it cannot reach', async () => {
    const service = serverFiles();
    execAsyncRemote.mockImplementation(() =>
      Promise.reject(new Error('SSH connection error: connect ECONNREFUSED')),
    );

    await expect(service.rotateAccessLogOn(SERVER)).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('still rejects a traefik.yml that is there but cannot be read', async () => {
    const service = serverFiles();
    writeConfig(true);
    writeLog(ACCESS_LOG_MAX_BYTES + 1);
    // A `cat` that is refused, as a mode-000 file refuses it. Not `chmod`:
    // root reads a mode-000 file anyway, so as root the read succeeded and
    // the rotation ran. The stub fails the same way for every user.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'cat'),
      '#!/bin/sh\necho "cat: $1: Permission denied" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    serverPath = `${bin}:${process.env.PATH}`;

    await expect(service.rotateAccessLogOn(SERVER)).rejects.toThrow();
    expect(remoteCalls.map(step)).toEqual(['read config']);
  });

  it('quotes a log path the shell would otherwise expand', async () => {
    const root = dir;
    dir = path.join(root, 'with space $(touch pwned)');
    fs.mkdirSync(dir);
    try {
      const service = serverFiles();
      writeConfig(true);
      writeLog(ACCESS_LOG_MAX_BYTES + 1);

      await service.rotateAccessLogOn(SERVER);

      expect(fs.existsSync(`${logPath()}.1`)).toBe(true);
      expect(fs.existsSync(logPath())).toBe(false);
      // The `$(…)` stayed part of a name; nothing ran it.
      expect(fs.readdirSync(root)).toEqual(['with space $(touch pwned)']);
      expect(fs.existsSync('pwned')).toBe(false);
    } finally {
      dir = root;
    }
  });

  it('reports a rotation it could not signal as not reopened', async () => {
    const service = serverFiles();
    containerId = '';
    writeConfig(true);
    writeLog(ACCESS_LOG_MAX_BYTES + 1);

    const result = await service.rotateAccessLogOn(SERVER);

    expect(result.rotated).toBe(true);
    expect(result.reopened).toBe(false);
    expect(fs.existsSync(`${logPath()}.1`)).toBe(true);
  });
});

// ADR-0057: size alone keeps a quiet Server's visitor IPs for years, so the
// older files also go 30 days after they last changed — never the live one.
describe('TraefikFilesService.deleteAgedAccessLogsOn', () => {
  const SERVER = 'srv-1';
  const DAY_MS = 24 * 60 * 60 * 1000;
  let remoteCalls: string[];

  function serverFiles(): TraefikFilesService {
    remoteCalls = [];
    const execAsyncRemote = jest.fn((_serverId: string, command: string) => {
      remoteCalls.push(command);
      try {
        const stdout = execFileSync('/bin/sh', ['-c', command], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return Promise.resolve({ stdout, stderr: '' });
      } catch (error) {
        return Promise.reject(error as Error);
      }
    });
    return new TraefikFilesService(
      withArgvExec({ execAsyncRemote }) as unknown as RemoteExecService,
      () => dir,
    );
  }

  /** A file at `file`, last changed `days` ago. */
  function writeAged(file: string, days: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'line\n');
    const at = new Date(Date.now() - days * DAY_MS);
    fs.utimesSync(file, at, at);
  }

  it('deletes the older files last changed more than 30 days ago and keeps the rest', async () => {
    writeAged(`${logPath()}.1`, 2);
    writeAged(`${logPath()}.2`, 31);
    writeAged(`${logPath()}.3`, 45);

    const deleted = await serverFiles().deleteAgedAccessLogsOn(SERVER);

    expect(deleted).toEqual([`${logPath()}.2`, `${logPath()}.3`]);
    expect(fs.existsSync(`${logPath()}.1`)).toBe(true);
    expect(fs.existsSync(`${logPath()}.2`)).toBe(false);
    expect(fs.existsSync(`${logPath()}.3`)).toBe(false);
  });

  it('keeps an older file last changed 29 days ago', async () => {
    writeAged(`${logPath()}.1`, 29);

    expect(await serverFiles().deleteAgedAccessLogsOn(SERVER)).toEqual([]);
    expect(fs.existsSync(`${logPath()}.1`)).toBe(true);
  });

  it('never deletes the live file, however long ago it last changed', async () => {
    writeAged(logPath(), 400);
    writeAged(`${logPath()}.1`, 400);

    expect(await serverFiles().deleteAgedAccessLogsOn(SERVER)).toEqual([
      `${logPath()}.1`,
    ]);
    expect(fs.existsSync(logPath())).toBe(true);
  });

  it('answers nothing deleted, in one call, on a Server with no access log at all', async () => {
    expect(await serverFiles().deleteAgedAccessLogsOn(SERVER)).toEqual([]);
    expect(remoteCalls).toHaveLength(1);
  });

  it('quotes a log path the shell would otherwise expand', async () => {
    const root = dir;
    dir = path.join(root, 'with space $(touch pwned)');
    try {
      writeAged(`${logPath()}.1`, 40);

      expect(await serverFiles().deleteAgedAccessLogsOn(SERVER)).toEqual([
        `${logPath()}.1`,
      ]);
      expect(fs.readdirSync(root)).toEqual(['with space $(touch pwned)']);
    } finally {
      dir = root;
    }
  });
});
