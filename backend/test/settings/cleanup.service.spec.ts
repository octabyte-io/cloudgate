import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException, Logger } from '@nestjs/common';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { ExecError } from '../../src/remote/exec-error';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  CleanupService,
  dockerSafeExec,
} from '../../src/settings/cleanup.service';

/**
 * Every Docker prune waited, with no deadline, until no `docker …` CLI
 * process was left on the host — and a `docker service logs --follow` that a
 * log view had left behind kept the nightly prune looping "Docker is busy" for
 * over thirteen hours.
 *
 * The emitted script is run for real rather than string-matched: under dash
 * where the host has it (Ubuntu's `/bin/sh` is dash, and so is macOS's
 * `/bin/dash`), with a stub `ps` that prints a scripted process table and a
 * stub `sleep` that returns at once and records how long it was asked to wait.
 * The shipped deadline is what is measured, not a shortened one.
 */
const SHELL = existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** Total seconds the script asked `sleep` for. */
  slept: number;
  /** How many times `ps` was read. */
  checks: number;
}

/**
 * Run `dockerSafeExec(exec)` with `ps` answering `tables[i]` on its i-th call
 * (the last one repeating), and `sleep` a no-op that logs its argument.
 */
const runScript = (tables: string[][], exec = 'echo PRUNED'): Promise<Run> => {
  const dir = mkdtempSync(join(tmpdir(), 'i509-'));
  tables.forEach((rows, i) =>
    writeFileSync(join(dir, `ps.${i}`), rows.map((r) => `${r}\n`).join('')),
  );
  writeFileSync(join(dir, 'ps.last'), String(tables.length - 1));
  writeFileSync(
    join(dir, 'ps'),
    [
      '#!/bin/sh',
      // Whatever it is asked, a ps answers with the table: the script's choice
      // of columns is what is under test, and a stub that refused the wrong
      // ones would read as an idle host.
      `n=$(cat "${dir}/ps.calls" 2>/dev/null || echo 0)`,
      `echo $((n + 1)) > "${dir}/ps.calls"`,
      `last=$(cat "${dir}/ps.last")`,
      '[ "$n" -gt "$last" ] && n=$last',
      `cat "${dir}/ps.$n"`,
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, 'sleep'),
    `#!/bin/sh\necho "$1" >> "${dir}/sleeps"\n`,
    { mode: 0o755 },
  );

  return new Promise((resolve) => {
    execFile(
      SHELL,
      ['-c', dockerSafeExec(exec)],
      // A script that never gives up is killed rather than hanging the suite:
      // with `sleep` stubbed, even the shipped ten minutes take well under this.
      { env: { PATH: `${dir}:${process.env.PATH ?? ''}` }, timeout: 10_000 },
      (error, stdout, stderr) => {
        const read = (name: string) =>
          existsSync(join(dir, name))
            ? readFileSync(join(dir, name), 'utf8')
            : '';
        const slept = read('sleeps')
          .split('\n')
          .filter(Boolean)
          .reduce((sum, s) => sum + Number(s), 0);
        const checks = Number(read('ps.calls') || 0);
        rmSync(dir, { recursive: true, force: true });
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          stdout,
          stderr,
          slept,
          checks,
        });
      },
    );
  });
};

/** What is on every Docker host whether or not anything is using the CLI. */
const DAEMON = [
  '/sbin/init',
  '/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock',
  '/usr/bin/containerd',
  '/usr/bin/docker-proxy -proto tcp -host-ip 0.0.0.0 -host-port 443',
];

describe('dockerSafeExec', () => {
  it('parses under dash', async () => {
    const run = await new Promise<number>((resolve) => {
      execFile(SHELL, ['-n', '-c', dockerSafeExec('true')], (error) =>
        resolve(typeof error?.code === 'number' ? error.code : 0),
      );
    });
    expect(run).toBe(0);
  });

  it('runs at once while a leaked docker service logs --follow is on the host', async () => {
    const run = await runScript([
      [
        ...DAEMON,
        'docker service logs --timestamps --raw --tail 200 --follow mariadb-j2gzpc',
      ],
    ]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('PRUNED');
    expect(run.stdout).not.toContain('Docker is busy');
    expect(run.slept).toBe(0);
  });

  it('is not held by any long-lived read-only docker command', async () => {
    const run = await runScript([
      [
        ...DAEMON,
        'docker logs -f 9d1070a140d6',
        'docker container logs --timestamps --tail 200 --follow 9d1070a140d6',
        '/usr/bin/docker service logs -f web',
        'docker -H unix:///var/run/docker.sock service logs --follow web',
        'docker --context prod logs --follow web',
        'docker stats --no-stream',
        'docker container stats',
        'docker stats',
        'docker events --format {{json .}}',
        'docker system events',
        'docker compose logs -f',
        'docker compose -p shop -f docker-compose.yml logs --follow',
      ],
    ]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('PRUNED');
    expect(run.slept).toBe(0);
  });

  it('is not held by its own shell or by another prune still waiting its turn', async () => {
    // The script's own `sh -c` carries the prune it will run in its argv; so
    // does every sibling a Clean all started beside it. Neither is the CLI.
    const run = await runScript([
      [
        ...DAEMON,
        `/bin/sh -c ${dockerSafeExec('docker image prune --all --force').replace(/\n/g, '?')}`,
        'awk { docker build }',
        'grep docker run',
      ],
    ]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('PRUNED');
    expect(run.slept).toBe(0);
  });

  it('waits for a docker command that writes, and runs once it is gone', async () => {
    const busy = [...DAEMON, 'docker build -t shop:latest .'];
    const run = await runScript([busy, busy, DAEMON]);

    expect(run.code).toBe(0);
    expect(run.stdout.match(/Docker is busy/g)).toHaveLength(2);
    expect(run.stdout).toContain('PRUNED');
    expect(run.slept).toBe(20);
    expect(run.checks).toBe(3);
  });

  it('gives up after ten minutes of waiting and does not run the prune', async () => {
    const run = await runScript([
      [...DAEMON, 'docker build -t shop:latest .', 'docker exec -it db sh'],
    ]);

    expect(run.code).toBe(75);
    expect(run.stdout).not.toContain('PRUNED');
    expect(run.stdout).not.toContain('Execution completed');
    // Bounded: ten minutes of sleep in all, then one last look.
    expect(run.slept).toBe(600);
    expect(run.checks).toBe(61);
    expect(run.stderr).toMatch(/CLOUDGATE_DOCKER_BUSY: .*docker build/);
    expect(run.stderr).toMatch(/CLOUDGATE_DOCKER_BUSY: .*docker exec/);
  });

  it('names what held it by its subcommand, never by its arguments', async () => {
    const run = await runScript([
      [
        ...DAEMON,
        'docker login -u deploy -p hunter2 registry.example.com',
        'docker run -e DB_PASSWORD=hunter2 postgres',
        'docker image push registry.example.com/shop:hunter2',
      ],
    ]);

    expect(run.code).toBe(75);
    expect(run.stderr).toContain('docker login');
    expect(run.stderr).toContain('docker run');
    expect(run.stderr).toContain('docker image push');
    expect(run.stderr).not.toContain('hunter2');
    expect(run.stdout).not.toContain('hunter2');
  });
});

describe('CleanupService', () => {
  const busy = (serverId?: string) =>
    new ExecError('Command failed with exit code 75', {
      command: 'x',
      stdout: 'Docker is busy. Will check again in 10 seconds...\n',
      stderr: 'CLOUDGATE_DOCKER_BUSY: docker build, docker exec\n',
      exitCode: 75,
      serverId,
    });

  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  const service = (remoteExec: Partial<RemoteExecService>) =>
    new CleanupService(
      null as unknown as DrizzleDB,
      remoteExec as RemoteExecService,
    );

  it('refuses a manual prune with 409 naming what kept Docker busy, and logs it', async () => {
    const execAsync = jest.fn().mockRejectedValue(busy());

    const refused = service({ execAsync }).cleanupImages();

    await expect(refused).rejects.toBeInstanceOf(ConflictException);
    await expect(refused).rejects.toThrow(
      'Docker stayed busy for 10 minutes, so the prune did not run: docker build, docker exec',
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('docker image prune --all --force'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('docker build'));
  });

  it('records a cleanupAll that Docker kept busy as skipped, in the log, and stops', async () => {
    const execAsyncRemote = jest.fn().mockRejectedValue(busy('srv-1'));

    const outcome = await service({ execAsyncRemote }).cleanupAll('srv-1');

    expect(outcome).toEqual({
      skipped:
        'Docker stayed busy for 10 minutes, so the prune did not run: docker build, docker exec',
    });
    // One wait, not four back to back.
    expect(execAsyncRemote).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Docker cleanup on Server srv-1 skipped .*: .*docker build, docker exec$/,
      ),
    );
  });

  it('logs a failed prune in cleanupAll and runs the rest', async () => {
    const execAsync = jest
      .fn()
      .mockRejectedValueOnce(
        new ExecError('Command failed with exit code 1', {
          command: 'x',
          exitCode: 1,
        }),
      )
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    const outcome = await service({ execAsync }).cleanupAll();

    expect(outcome).toEqual({ skipped: null });
    expect(execAsync).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('the platform host'),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
