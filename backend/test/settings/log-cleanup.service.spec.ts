import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Logger } from '@nestjs/common';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { LogCleanupService } from '../../src/settings/log-cleanup.service';
import type { SchedulingService } from '../../src/scheduling/scheduling.service';
import type { SettingsService } from '../../src/settings/settings.service';
import {
  ACCESS_LOG_MAX_BYTES,
  TraefikFilesService,
} from '../../src/settings/traefik-files.service';
import { withArgvExec } from '../utils/exec-double';

// `logCleanupCron` and the Maintenance switch belong to the Instance
// organization, so the cron they govern rotates the platform host's log and
// reaches no Server; a Server's disk is `ServerAccessLogUpkeepService`'s
// (ADR-0057).
//
// The real TraefikFilesService behind a double of the two boundaries it could
// reach: the platform host's shell (`execAsync`) and SSH (`execAsyncRemote`).

let hostDir: string;
let execAsync: jest.Mock;
let execAsyncRemote: jest.Mock;
let loggedErrors: string[];

function cleanup() {
  execAsync = jest.fn((command: string) =>
    Promise.resolve({
      stdout: command.includes('docker ps') ? 'host-traefik\n' : '',
      stderr: '',
    }),
  );
  execAsyncRemote = jest.fn();
  const remoteExec = withArgvExec({
    execAsync,
    execAsyncRemote,
  }) as unknown as RemoteExecService;
  const traefikFiles = new TraefikFilesService(remoteExec, () => hostDir);
  return new LogCleanupService(
    {} as SchedulingService,
    {} as SettingsService,
    traefikFiles,
  );
}

beforeEach(() => {
  hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-1279-host-'));
  fs.mkdirSync(path.join(hostDir, 'dynamic'));
  fs.writeFileSync(
    path.join(hostDir, 'dynamic', 'access.log'),
    'x'.repeat(ACCESS_LOG_MAX_BYTES + 1),
  );
  loggedErrors = [];
  jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation((message: unknown) => {
      loggedErrors.push(String(message));
    });
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(hostDir, { recursive: true, force: true });
});

describe('LogCleanupService', () => {
  it('rotates the platform host’s log and reaches no Server', async () => {
    await cleanup().runCleanup();

    expect(fs.existsSync(path.join(hostDir, 'dynamic', 'access.log.1'))).toBe(
      true,
    );
    expect(execAsync).toHaveBeenCalledWith(
      'docker exec host-traefik kill -USR1 1',
    );
    expect(execAsyncRemote).not.toHaveBeenCalled();
    expect(loggedErrors).toEqual([]);
  });

  it('logs a platform host rotation that throws rather than rejecting', async () => {
    jest
      .spyOn(TraefikFilesService.prototype, 'rotateAccessLog')
      .mockRejectedValue(new Error('EACCES'));

    await expect(cleanup().runCleanup()).resolves.toBeUndefined();

    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]).toContain('EACCES');
  });
});
