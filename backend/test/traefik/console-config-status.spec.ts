import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikConfigStatusService } from '../../src/traefik/config-status.service';
import type { FileConfig } from '../../src/traefik/config/file-types';
import { buildConsoleRouterIndex } from '../../src/traefik/config/names';
import { createWebServerConfig } from '../../src/traefik/config/web-server';
import type { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';

/**
 * The console's own routers, which H-38 deliberately left alone (H-61).
 *
 * `buildRouterSubjectIndex` indexes one Application's routers and
 * `config-status.service.ts` ignores a rejection naming anything else, so a
 * refused `dynamic/cloudgate.yml` — the file that puts *this console* on a
 * hostname — was reported nowhere. It is the one failure an operator cannot
 * diagnose from the console, because the console is what goes dark.
 *
 * Two seams, both boundaries (§1.7): the exec double stands in for Traefik's
 * log, and the writer double for the two files on disk. The router names under
 * test come from `createWebServerConfig` itself rather than from literals here,
 * so a rename in the generator fails this file instead of silently un-indexing
 * the console.
 */
const execAsync = jest.fn();
const execAsyncRemote = jest.fn();
const remoteExec = withArgvExec({
  execAsync,
  execAsyncRemote,
}) as unknown as RemoteExecService;

const loadOrCreateConfig = jest.fn();
const writer = {
  loadOrCreateConfig,
} as unknown as TraefikWriterService;

const CONTAINER_ID = '9f2c1ab4d7e0';
const ANCHOR = '2026-08-28T17:33:30.000000000Z';
const AT = '2026-08-28T17:33:38.162947548Z';

const BAD_MIDDLEWARE =
  'middleware "redirect-to-https@file" does not exist for entrypoint "web"';

/**
 * Traefik's console format, verbatim from `traefik:v3.6.7`, minus the ANSI.
 *
 * The message is `%q`-escaped on the way in, because zerolog's console writer
 * escapes it and this particular sentence is the one that carries quotes —
 * a fixture that did not escape them would end the field early and the parser
 * would be held to output Traefik never produces.
 */
const rejection = (at: string, routerName: string, message: string) =>
  `${at} 2026-08-28T17:33:38Z ERR error="${message.replace(/"/g, '\\"')}" entryPointName=web routerName=${routerName}@file`;

/** What `updateServerTraefik` writes for a console on HTTPS. */
const consoleConfig = (): FileConfig =>
  createWebServerConfig(
    { http: { routers: {}, services: {} } },
    {
      host: 'console.example.com',
      https: true,
      certificateType: 'letsencrypt',
      consoleUrl: 'http://198.51.100.7:3000',
    },
  );

/** `docker ps` finds Traefik; `docker logs` returns whatever a test set. */
const traefikLog = (stdout: string, containerId = CONTAINER_ID) => {
  const answer = (command: string) =>
    Promise.resolve(
      command.startsWith('docker ps')
        ? { stdout: containerId, stderr: '', exitCode: 0 }
        : { stdout, stderr: '', exitCode: 0 },
    );
  execAsync.mockImplementation(answer);
  execAsyncRemote.mockImplementation((_serverId: string, command: string) =>
    answer(command),
  );
};

/** What the two watched files hold, by the name the writer addresses them by. */
const filesOnDisk = (files: Record<string, FileConfig>) => {
  loadOrCreateConfig.mockImplementation((name: string) =>
    Promise.resolve(files[name] ?? { http: { routers: {}, services: {} } }),
  );
};

describe('buildConsoleRouterIndex', () => {
  it('recognises the two routers the console domain form mints', () => {
    const index = buildConsoleRouterIndex(consoleConfig(), null);

    expect([...index.keys()]).toEqual(
      expect.arrayContaining([
        'cloudgate-router-app',
        'cloudgate-router-app-secure',
      ]),
    );
    expect(index.get('cloudgate-router-app')).toEqual({
      source: 'console-domain',
      middlewares: ['redirect-to-https'],
    });
  });

  it('recognises them even when neither file could be read', () => {
    // The instance most likely to have an unreadable Traefik directory is the
    // one something is wrong with, so the two generated names are seeded.
    const index = buildConsoleRouterIndex(null, null);

    expect(index.get('cloudgate-router-app-secure')).toEqual({
      source: 'console-domain',
      middlewares: [],
    });
  });

  it('recognises a router an operator hand-wrote into the middlewares file', () => {
    const index = buildConsoleRouterIndex(null, {
      http: {
        routers: {
          'ops-dashboard': {
            rule: 'Host(`ops.example.com`)',
            service: 'ops',
            middlewares: ['ops-auth'],
          },
        },
      },
    });

    expect(index.get('ops-dashboard')).toEqual({
      source: 'operator-middlewares',
      middlewares: ['ops-auth'],
    });
  });

  it('leaves an Application router unrecognised', () => {
    // Nothing about an app belongs here: it has rows and a Domain of its own,
    // and `buildRouterSubjectIndex` is what answers for it.
    const index = buildConsoleRouterIndex(consoleConfig(), null);

    expect(index.has('shop-router-1')).toBe(false);
  });
});

describe('TraefikConfigStatusService.verifyConsole', () => {
  let status: TraefikConfigStatusService;

  beforeEach(() => {
    jest.clearAllMocks();
    status = new TraefikConfigStatusService(remoteExec, writer);
  });

  describe('a console router Traefik refused', () => {
    it('reports the console router and the middlewares it names', async () => {
      filesOnDisk({ cloudgate: consoleConfig() });
      traefikLog(rejection(AT, 'cloudgate-router-app', BAD_MIDDLEWARE));

      const result = await status.verifyConsole(ANCHOR, 0);

      expect(result.state).toBe('checked');
      expect(result.rejections).toEqual([
        {
          routerName: 'cloudgate-router-app',
          message: BAD_MIDDLEWARE,
          source: 'console-domain',
          middlewares: ['redirect-to-https'],
          observedAt: AT,
        },
      ]);
    });

    it('is readable afterwards without asking Traefik again', async () => {
      filesOnDisk({ cloudgate: consoleConfig() });
      traefikLog(rejection(AT, 'cloudgate-router-app', BAD_MIDDLEWARE));

      await status.verifyConsole(ANCHOR, 0);

      expect(status.consoleStatus()?.rejections).toHaveLength(1);
    });

    it('ignores a line Traefik logged before the write', async () => {
      filesOnDisk({ cloudgate: consoleConfig() });
      traefikLog(rejection(ANCHOR, 'cloudgate-router-app', BAD_MIDDLEWARE));

      const result = await status.verifyConsole(ANCHOR, 0);

      expect(result.rejections).toEqual([]);
    });
  });

  describe('a console Traefik said nothing about', () => {
    it('reports no rejection rather than health', async () => {
      filesOnDisk({ cloudgate: consoleConfig() });
      traefikLog(
        '2026-08-28T17:33:38.100000000Z 2026-08-28T17:33:38Z INF Starting provider *file.Provider',
      );

      const result = await status.verifyConsole(ANCHOR, 0);

      // `checked` is "this is what the log said". Traefik logs nothing on a
      // reload it accepted, so an empty list is not a claim about the config.
      expect(result.state).toBe('checked');
      expect(result.rejections).toEqual([]);
    });
  });

  describe('a Traefik that cannot be asked', () => {
    it('reports unavailable rather than health when no container is running', async () => {
      filesOnDisk({ cloudgate: consoleConfig() });
      traefikLog('', '');

      const result = await status.verifyConsole(ANCHOR, 0);

      expect(result.state).toBe('unavailable');
      expect(result.reason).toContain('cloudgate-traefik');
      expect(result.rejections).toEqual([]);
    });

    it('records unavailable instead of rejecting when the daemon errors', async () => {
      filesOnDisk({ cloudgate: consoleConfig() });
      execAsync.mockRejectedValue(new Error('docker daemon is not running'));

      status.verifyConsoleInBackground(ANCHOR, 0);
      await expect(status.consoleSettled()).resolves.toBeUndefined();

      expect(status.consoleStatus()?.state).toBe('unavailable');
    });
  });

  /**
   * The protocol packaged for the console's own writers, which live in
   * `src/settings`. Held here because the *order* is the design: an anchor taken
   * after the write cannot tell an error this write fixed from one it caused.
   *
   * **The check is awaited**, and this file used to assert the
   * opposite in its name. The saving was two seconds on a console-domain save;
   * the cost was that the console's own card, refreshed by that same save,
   * refetched while the check was still in flight and answered with the previous
   * observation — an unrelated Application's write, dated and captioned as the
   * verdict on this one. `test/settings/console-domain-write-check.spec.ts`
   * drives the save end to end; what stays here is the order and the
   * pass-through.
   */
  describe('aroundConsoleWrite', () => {
    it('reads the anchor before the write and has the verdict before it answers', async () => {
      filesOnDisk({ cloudgate: consoleConfig() });
      traefikLog(rejection(AT, 'cloudgate-router-app', BAD_MIDDLEWARE));
      const order: string[] = [];
      execAsync.mockImplementation((command: string) => {
        if (command.startsWith('docker ps')) {
          return Promise.resolve({
            stdout: CONTAINER_ID,
            stderr: '',
            exitCode: 0,
          });
        }
        // The anchor read is `--tail 1` and dates the log *before* the write;
        // the burst that follows is only believed because it is newer than it.
        if (command.includes('--tail 1')) {
          order.push('anchor');
          return Promise.resolve({
            stdout: `${ANCHOR} 2026-08-28T17:33:30Z INF Configuration loaded`,
            stderr: '',
            exitCode: 0,
          });
        }
        return Promise.resolve({
          stdout: rejection(AT, 'cloudgate-router-app', BAD_MIDDLEWARE),
          stderr: '',
          exitCode: 0,
        });
      });

      const written = await status.aroundConsoleWrite(() => {
        order.push('write');
        return Promise.resolve('done');
      }, 0);

      // The write's own value passes through: this observes a write and is
      // never a gate on one.
      expect(written).toBe('done');
      expect(order).toEqual(['anchor', 'write']);
      // And the verdict is already recorded, with no `consoleSettled()` of the
      // caller's own — that is what makes the card correct for the reader the
      // write answers to.
      expect(status.consoleStatus()?.rejections).toHaveLength(1);
    });
  });

  /**
   * The file provider re-reads the **whole** watched directory on any event and
   * re-emits the complete current error set (the experiment H-38's docblock
   * rests on), so an Application's own regeneration on the platform host puts
   * `dynamic/cloudgate.yml`'s errors into the same anchored window. Reading
   * them there costs no second log read and no second reload wait — and it is
   * the only thing that notices a console router nobody has rewritten since it
   * broke.
   */
  describe('riding on an Application check', () => {
    const appInput = (serverId: string | null = null) => ({
      applicationId: 'app_shop',
      appName: 'shop',
      serverId,
      routers: new Map(),
    });

    it('records the console rejection an Application check saw in its window', async () => {
      filesOnDisk({ cloudgate: consoleConfig() });
      traefikLog(rejection(AT, 'cloudgate-router-app', BAD_MIDDLEWARE));

      const result = await status.verify(appInput(), ANCHOR, 0);

      // The Application's own answer is untouched: the console's router is not
      // one of its routers and does not belong in its list.
      expect(result.rejections).toEqual([]);
      expect(status.consoleStatus()?.rejections).toHaveLength(1);
    });

    it('does not ask a Server for a file only the platform host has', async () => {
      filesOnDisk({ cloudgate: consoleConfig() });
      traefikLog(rejection(AT, 'cloudgate-router-app', BAD_MIDDLEWARE));

      await status.verify(appInput('srv_1'), ANCHOR, 0);

      // `updateServerTraefik` writes `dynamic/cloudgate.yml` on the platform
      // host only, and `/settings/traefik/middlewares-config` takes no
      // serverId — so a Server has no console router to be asked about, and a
      // check there would be an SSH round trip for a file that is never there.
      expect(loadOrCreateConfig).not.toHaveBeenCalled();
      expect(status.consoleStatus()).toBeUndefined();
    });
  });
});
