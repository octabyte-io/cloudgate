import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Logger } from '@nestjs/common';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { SchedulingService } from '../../src/scheduling/scheduling.service';
import { ServerAccessLogUpkeepService } from '../../src/settings/server-access-log-upkeep.service';
import {
  ACCESS_LOG_MAX_BYTES,
  TraefikFilesService,
} from '../../src/settings/traefik-files.service';
import { withArgvExec } from '../utils/exec-double';

// One Server failing must cost nothing but its own turn (moved here from the
// platform host's `LogCleanupService`, ADR-0057).
//
// The real TraefikFilesService behind a double of SSH (`execAsyncRemote`).
// Each Server's "machine" is a temp tree: every file program runs for real in
// /bin/sh against it, and only Docker is answered by the double.

const ON =
  'accessLog:\n  filePath: /etc/cloudgate/traefik/dynamic/access.log\n';

let serverDirs: Record<string, string>;
let unreachable: Set<string>;
let traefikStopped: Set<string>;
let execAsync: jest.Mock;
let execAsyncRemote: jest.Mock;
let loggedErrors: string[];

function machine(name: string, bytes: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cloudgate-1279-${name}-`));
  fs.mkdirSync(path.join(dir, 'dynamic'));
  fs.writeFileSync(path.join(dir, 'traefik.yml'), ON);
  fs.writeFileSync(path.join(dir, 'dynamic', 'access.log'), 'x'.repeat(bytes));
  return dir;
}

function upkeep(servers: { serverId: string; name: string }[]) {
  execAsync = jest.fn();
  execAsyncRemote = jest.fn((serverId: string, command: string) => {
    if (unreachable.has(serverId)) {
      return Promise.reject(new Error('connect ECONNREFUSED'));
    }
    if (command.includes('docker ps')) {
      const found = traefikStopped.has(serverId) ? '' : `${serverId}-traefik\n`;
      return Promise.resolve({ stdout: found, stderr: '' });
    }
    if (command.startsWith('docker exec')) {
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    return Promise.resolve({
      stdout: execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }),
      stderr: '',
    });
  });
  const remoteExec = withArgvExec({
    execAsync,
    execAsyncRemote,
  }) as unknown as RemoteExecService;
  const traefikFiles = new TraefikFilesService(
    remoteExec,
    (serverId) => serverDirs[serverId ?? ''],
  );
  // Every Server read is still reached: the filter for a Deleting or
  // Deleted Bought Server is the e2e's (`bought-servers/delete.e2e-spec.ts`).
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(servers) }) }),
  } as unknown as DrizzleDB;
  return new ServerAccessLogUpkeepService(
    db,
    {} as SchedulingService,
    traefikFiles,
  );
}

beforeEach(() => {
  serverDirs = {
    'srv-a': machine('a', ACCESS_LOG_MAX_BYTES + 1),
    'srv-b': machine('b', ACCESS_LOG_MAX_BYTES + 1),
  };
  unreachable = new Set();
  traefikStopped = new Set();
  loggedErrors = [];
  jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation((message: unknown) => {
      loggedErrors.push(String(message));
    });
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const dir of Object.values(serverDirs)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const rotated = (dir: string) =>
  fs.existsSync(path.join(dir, 'dynamic', 'access.log.1'));

describe('ServerAccessLogUpkeepService', () => {
  it('rotates every Server with the log on and signals each one’s own Traefik', async () => {
    const service = upkeep([
      { serverId: 'srv-a', name: 'alpha' },
      { serverId: 'srv-b', name: 'bravo' },
    ]);

    await service.tick();

    expect(rotated(serverDirs['srv-a'])).toBe(true);
    expect(rotated(serverDirs['srv-b'])).toBe(true);
    const signals = execAsyncRemote.mock.calls
      .map(([serverId, command]) => [serverId, command] as [string, string])
      .filter(([, command]) => command.startsWith('docker exec'));
    expect(signals).toEqual([
      ['srv-a', 'docker exec srv-a-traefik kill -USR1 1'],
      ['srv-b', 'docker exec srv-b-traefik kill -USR1 1'],
    ]);
    // Nothing ran on the platform host.
    expect(execAsync).not.toHaveBeenCalled();
    expect(loggedErrors).toEqual([]);
  });

  it('skips a Server it cannot reach, by name, and still keeps the next', async () => {
    unreachable.add('srv-a');
    const service = upkeep([
      { serverId: 'srv-a', name: 'alpha' },
      { serverId: 'srv-b', name: 'bravo' },
    ]);

    const done = await service.tick();

    expect(rotated(serverDirs['srv-a'])).toBe(false);
    expect(rotated(serverDirs['srv-b'])).toBe(true);
    expect(done.map((d) => d.serverId)).toEqual(['srv-b']);
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]).toContain('Server alpha');
    expect(loggedErrors[0]).toContain('ECONNREFUSED');
  });

  it('passes over a Server with no traefik.yml without logging it', async () => {
    fs.rmSync(path.join(serverDirs['srv-a'], 'traefik.yml'));
    const service = upkeep([{ serverId: 'srv-a', name: 'alpha' }]);

    expect(await service.tick()).toEqual([
      { serverId: 'srv-a', rotated: false, deleted: [] },
    ]);
    expect(rotated(serverDirs['srv-a'])).toBe(false);
    expect(loggedErrors).toEqual([]);
  });

  it('names the Server whose log it moved but whose Traefik it could not signal', async () => {
    traefikStopped.add('srv-a');
    const service = upkeep([{ serverId: 'srv-a', name: 'alpha' }]);

    await service.tick();

    expect(rotated(serverDirs['srv-a'])).toBe(true);
    expect(loggedErrors).toEqual([expect.stringContaining('on Server alpha')]);
    expect(loggedErrors[0]).toContain('could not signal Traefik');
  });
});
