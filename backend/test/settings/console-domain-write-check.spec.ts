import { ConfigService } from '@nestjs/config';
import type { Env } from '../../src/common/config/env.schema';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { LicenseService } from '../../src/enterprise/license/license.service';
import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import { PermissionService } from '../../src/rbac/permission.service';
import type { ConsoleOriginService } from '../../src/settings/console-origin.service';
import type { InstanceUrlService } from '../../src/settings/instance-url.service';
import { SettingsService } from '../../src/settings/settings.service';
import {
  defaultWebServerMetricsConfig,
  defaultWhitelabelingConfig,
} from '../../src/settings/settings.schema';
import type { WebServerSettingsRow } from '../../src/settings/settings.schema';
import type { TraefikFilesService } from '../../src/settings/traefik-files.service';
import { TraefikConfigStatusService } from '../../src/traefik/config-status.service';
import type { FileConfig } from '../../src/traefik/config/file-types';
import type { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';

/**
 * Saving the console domain takes Traefik's verdict on the file it just wrote.
 *
 * `TraefikConfigStatusService.aroundConsoleWrite` — "Anchor, write, then look",
 * written for exactly this save — had **no caller anywhere in `src`**, so the
 * Console routing card under the Console domain form reported whatever an
 * unrelated Application's regeneration last saw. On the reported box that was an
 * observation 55 minutes old, dated and captioned as the answer for a save three
 * minutes earlier, and a full reload did not help because the staleness was in
 * this process rather than in the query cache.
 *
 * **The real status service, not a double** (§1.7): what is under test is that
 * the save reaches the protocol and that the protocol's verdict is there by the
 * time the save answers — a double satisfying the first would prove neither. Its
 * two boundaries are replaced instead, the exec seam standing in for Traefik's
 * log and the writer double for the two watched files, exactly as
 * `test/traefik/console-config-status.spec.ts` drives them.
 *
 * The collaborators of `SettingsService` that this save does not consult are
 * stubbed to the shape it reads and nothing more; the singleton lives in the
 * fake below rather than in Postgres, because the row is an input to the write
 * and not the thing being asserted.
 */
const execAsync = jest.fn();
const execAsyncRemote = jest.fn();
const remoteExec = withArgvExec({
  execAsync,
  execAsyncRemote,
}) as unknown as RemoteExecService;

const CONTAINER_ID = '9f2c1ab4d7e0';
const ANCHOR = '2026-09-16T17:11:00.887000000Z';
const AT = '2026-09-16T18:02:04.310000000Z';

const BAD_MIDDLEWARE =
  'middleware "redirect-to-https@file" does not exist for entrypoint "web"';

/** Traefik's console format, verbatim from `traefik:v3.6.7`, minus the ANSI. */
const rejection = (at: string, routerName: string, message: string) =>
  `${at} 2026-09-16T18:02:04Z ERR error="${message.replace(/"/g, '\\"')}" entryPointName=web routerName=${routerName}@file`;

/**
 * `docker ps` finds Traefik, the `--tail 1` anchor read dates the log before the
 * save, and the burst after it carries the refused console router.
 */
function traefikLog(): void {
  const answer = (command: string) => {
    if (command.startsWith('docker ps')) {
      return Promise.resolve({
        stdout: CONTAINER_ID,
        stderr: '',
        exitCode: 0,
      });
    }
    if (command.includes('--tail 1')) {
      return Promise.resolve({
        stdout: `${ANCHOR} 2026-09-16T17:11:00Z INF Configuration loaded`,
        stderr: '',
        exitCode: 0,
      });
    }
    return Promise.resolve({
      stdout: rejection(AT, 'cloudgate-router-app', BAD_MIDDLEWARE),
      stderr: '',
      exitCode: 0,
    });
  };
  execAsync.mockImplementation(answer);
  execAsyncRemote.mockImplementation((_serverId: string, command: string) =>
    answer(command),
  );
}

const emptyConfig = (): FileConfig => ({ http: { routers: {}, services: {} } });

/** The `web_server_settings` singleton, as this save reads and rewrites it. */
const singleton = (): WebServerSettingsRow =>
  ({
    id: 'ws_1',
    host: null,
    letsEncryptEmail: null,
    certificateType: 'none',
    https: false,
    serverIp: null,
    buildsConcurrency: 1,
    metricsConfig: defaultWebServerMetricsConfig,
    whitelabelingConfig: defaultWhitelabelingConfig,
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  }) as unknown as WebServerSettingsRow;

/**
 * The singleton's read and write, in the four calls `updateWebServerSettings`
 * makes of them. Not a Postgres — this spec is in the unit lane and the row is
 * an input to the Traefik write rather than the subject of any assertion.
 */
function fakeDb(row: WebServerSettingsRow) {
  let stored = row;
  return {
    query: {
      webServerSettings: { findFirst: () => Promise.resolve(stored) },
    },
    update: () => ({
      set: (patch: Partial<WebServerSettingsRow>) => ({
        where: () => ({
          returning: () => {
            stored = { ...stored, ...patch };
            return Promise.resolve([stored]);
          },
        }),
      }),
    }),
  } as unknown as DrizzleDB;
}

const ctx: PermissionCtx = {
  user: { id: 'user_1' },
  session: { activeOrganizationId: 'org_1' },
};

describe('SettingsService.assignDomain, and the console router check', () => {
  let status: TraefikConfigStatusService;
  let settings: SettingsService;
  let writeConfig: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    traefikLog();

    // The watched files, as the file provider would find them: what the save
    // writes is what the check then reads back, so the router names and the
    // middleware chain under test come from `createWebServerConfig` rather than
    // from literals here.
    const onDisk = new Map<string, FileConfig>();
    const writer = {
      loadOrCreateConfig: jest.fn((name: string) =>
        Promise.resolve(onDisk.get(name) ?? emptyConfig()),
      ),
      writeConfig: jest.fn((name: string, config: FileConfig) => {
        onDisk.set(name, config);
        return Promise.resolve();
      }),
      removeConfig: jest.fn((name: string) => {
        onDisk.delete(name);
        return Promise.resolve();
      }),
    };
    writeConfig = writer.writeConfig;
    status = new TraefikConfigStatusService(
      remoteExec,
      writer as unknown as TraefikWriterService,
    );

    settings = new SettingsService(
      fakeDb(singleton()),
      {
        checkInstanceAuthority: jest.fn(() => Promise.resolve()),
      } as unknown as PermissionService,
      {} as unknown as InstanceUrlService,
      writer as unknown as TraefikWriterService,
      status,
      {
        updateLetsEncryptEmail: jest.fn(),
        platformCarriesRequestMetrics: jest.fn().mockReturnValue(true),
      } as unknown as TraefikFilesService,
      new ConfigService<Env, true>({
        CLOUDGATE_PUBLIC_HOST: '198.51.100.7',
        CONSOLE_PORT: 3000,
      }),
      {} as unknown as LicenseService,
      // Whether the new domain's origin is trusted is another check's, and
      // `console-origin.e2e-spec.ts` drives it against the real gate.
      {
        trustOf: jest.fn(() => Promise.resolve(null)),
      } as unknown as ConsoleOriginService,
      { isHosted: false } as unknown as InstanceMode,
    );
  });

  const save = () =>
    settings.assignDomain(ctx, {
      host: 'console.testgc.octabyte.app',
      https: true,
      certificateType: 'letsencrypt',
      letsEncryptEmail: 'ops@example.com',
    });

  it('reports what Traefik said about the routers this save wrote, not an older look', async () => {
    const before = Date.now();

    await save();

    const observed = status.consoleStatus();
    // The save wrote the file it is being asked about — without this the
    // assertion below could pass on a check of somebody else's write.
    expect(writeConfig).toHaveBeenCalledWith(
      'cloudgate',
      expect.anything(),
      null,
      { platformOwned: true },
    );
    expect(observed).toBeDefined();
    expect(Date.parse(observed!.checkedAt)).toBeGreaterThanOrEqual(before);
    expect(observed!.state).toBe('checked');
    expect(observed!.rejections).toEqual([
      {
        routerName: 'cloudgate-router-app',
        message: BAD_MIDDLEWARE,
        source: 'console-domain',
        middlewares: ['redirect-to-https'],
        observedAt: AT,
      },
    ]);
  });

  it('reads the anchor before it writes, so an older refusal is not read as this save', async () => {
    // The anchor is the last line already in Traefik's log. `--since` is
    // inclusive, so a line at exactly the anchor is another write's business and
    // is dropped — which is the whole reason the order is fixed.
    execAsync.mockImplementation((command: string) =>
      Promise.resolve(
        command.startsWith('docker ps')
          ? { stdout: CONTAINER_ID, stderr: '', exitCode: 0 }
          : command.includes('--tail 1')
            ? {
                stdout: `${ANCHOR} 2026-09-16T17:11:00Z INF Configuration loaded`,
                stderr: '',
                exitCode: 0,
              }
            : {
                stdout: rejection(
                  ANCHOR,
                  'cloudgate-router-app',
                  BAD_MIDDLEWARE,
                ),
                stderr: '',
                exitCode: 0,
              },
      ),
    );

    await save();

    expect(status.consoleStatus()?.rejections).toEqual([]);
    // Still a fresh look, though: "nothing in the window" is an observation of
    // this write and not a reason to keep reporting the previous one.
    expect(status.consoleStatus()?.state).toBe('checked');
  });

  it('answers the save even when Traefik cannot be asked at all', async () => {
    // Nothing this check does may fail a write: the console domain is saved,
    // `dynamic/cloudgate.yml` is written, and the card says nothing is known.
    execAsync.mockRejectedValue(new Error('docker daemon is not running'));

    await expect(save()).resolves.toMatchObject({
      host: 'console.testgc.octabyte.app',
    });

    expect(writeConfig).toHaveBeenCalledWith(
      'cloudgate',
      expect.anything(),
      null,
      { platformOwned: true },
    );
    expect(status.consoleStatus()?.state).toBe('unavailable');
  });
});
