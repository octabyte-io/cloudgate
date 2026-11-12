import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikConfigStatusService } from '../../src/traefik/config-status.service';
import { createTraefikConfig } from '../../src/traefik/config/application';
import type { FileConfig } from '../../src/traefik/config/file-types';
import { buildRouterSubjectIndex } from '../../src/traefik/config/names';
import type { TraefikDomain } from '../../src/traefik/config/types';
import type { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';

/**
 * The exec seam is the only collaborator, and it is a system boundary
 * (§1.7) — `withArgvExec` funnels the argv `docker logs` calls into the same
 * `execAsync` mock the `docker ps` pipeline reaches, so one implementation
 * answers both and a test says what Traefik's log contained rather than which
 * of two seams was asked.
 */
const execAsync = jest.fn();
const execAsyncRemote = jest.fn();
const remoteExec = withArgvExec({
  execAsync,
  execAsyncRemote,
}) as unknown as RemoteExecService;

/**
 * The console's own two watched files, which the check reads on the platform
 * host to recognise a router with no Application behind it (H-61). Empty
 * here: this file is about an Application's routers, and an empty console
 * config still seeds the two generated names, so nothing an Application writes
 * can be mistaken for one.
 */
const writer = {
  loadOrCreateConfig: jest.fn(() =>
    Promise.resolve({ http: { routers: {}, services: {} } }),
  ),
} as unknown as TraefikWriterService;

const CONTAINER_ID = '9f2c1ab4d7e0';
const ANCHOR = '2026-08-28T17:33:30.000000000Z';

/** Traefik's console format, verbatim from `traefik:v3.6.7`, minus the ANSI. */
const rejection = (at: string, routerName: string, message: string) =>
  `${at} 2026-08-28T17:33:38Z ERR error="${message}" entryPointName=web routerName=${routerName}@file`;

const BAD_REGEX =
  'error parsing regexp: invalid or unsupported Perl syntax: `(?=`';

/** The three tables `regenerate` reads, for one Application with one Domain. */
const rows = () => ({
  domains: [
    { domainId: 'dom_web', host: 'shop.example.com', uniqueConfigKey: 1 },
  ],
  redirects: [{ redirectId: 'red_www', uniqueConfigKey: 7 }],
  security: [{ securityId: 'sec_ops' }, { securityId: 'sec_dev' }],
});

/**
 * The config the generators actually emit for those rows, so the router names
 * under test are the ones a real regeneration writes rather than strings this
 * file invented (§1.7 — the expectation comes from an independent source, which
 * here is `src`'s own generator rather than a literal).
 */
const emitted = (): FileConfig => {
  const domains: TraefikDomain[] = [
    { host: 'shop.example.com', https: false, uniqueConfigKey: 1 },
  ];
  return createTraefikConfig(
    {
      appName: 'shop',
      redirects: [{ uniqueConfigKey: 7 }],
      security: [{ username: 'ops' }],
    },
    domains,
  );
};

const input = (
  overrides: Partial<Parameters<TraefikConfigStatusService['verify']>[0]> = {},
) => ({
  applicationId: 'app_shop',
  appName: 'shop',
  serverId: null,
  routers: buildRouterSubjectIndex('shop', emitted(), rows()),
  ...overrides,
});

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

describe('TraefikConfigStatusService', () => {
  let status: TraefikConfigStatusService;

  beforeEach(() => {
    jest.clearAllMocks();
    status = new TraefikConfigStatusService(remoteExec, writer);
  });

  describe('a configuration Traefik refused', () => {
    it('reports the Domain that stopped routing and every row in its chain', async () => {
      traefikLog(
        rejection('2026-08-28T17:33:38.162947548Z', 'shop-router-1', BAD_REGEX),
      );

      const result = await status.verify(input(), ANCHOR, 0);

      expect(result.state).toBe('checked');
      expect(result.rejections).toHaveLength(1);
      const [reported] = result.rejections;
      expect(reported.domain).toEqual({
        domainId: 'dom_web',
        host: 'shop.example.com',
      });
      expect(reported.message).toBe(BAD_REGEX);
      expect(reported.subjects).toEqual([
        { kind: 'domain', domainId: 'dom_web', host: 'shop.example.com' },
        { kind: 'redirect', redirectId: 'red_www' },
        { kind: 'security', securityId: 'sec_ops' },
        { kind: 'security', securityId: 'sec_dev' },
      ]);
    });

    it('is readable afterwards without asking Traefik again', async () => {
      traefikLog(
        rejection('2026-08-28T17:33:38.162947548Z', 'shop-router-1', BAD_REGEX),
      );

      await status.verify(input(), ANCHOR, 0);

      expect(status.lastStatus('app_shop')?.rejections[0].routerName).toBe(
        'shop-router-1',
      );
    });

    it('cuts an htpasswd entry Cloudgate emitted out of the message', async () => {
      const secret = 'ops:$2y$10$K3sBqrNn3s2hEXAMPLEhashvalue';
      traefikLog(
        rejection(
          '2026-08-28T17:33:38.162947548Z',
          'shop-router-1',
          `error parsing BasicUser: ${secret}`,
        ),
      );

      const result = await status.verify(
        input({ secrets: [secret] }),
        ANCHOR,
        0,
      );

      // A basic-auth password never leaves the server (`SecurityService`), and
      // the hash Traefik quotes back is derived from it.
      expect(result.rejections[0].message).toBe(
        'error parsing BasicUser: [redacted]',
      );
      expect(result.rejections[0].message).not.toContain('$2y$');
    });
  });

  describe('a configuration Traefik accepted', () => {
    it('reports no rejection when the reload logged nothing', async () => {
      // Traefik is silent on a reload it accepted — this is the whole log.
      traefikLog(
        '2026-08-28T17:33:38.100000000Z 2026-08-28T17:33:38Z INF Starting provider *file.Provider',
      );

      const result = await status.verify(input(), ANCHOR, 0);

      expect(result.state).toBe('checked');
      expect(result.rejections).toEqual([]);
    });
  });

  describe('the watcher race', () => {
    it('reports no rejection when the reload has not happened yet', async () => {
      // Nothing newer than the anchor exists: the file provider has not fired.
      traefikLog('');

      const result = await status.verify(input(), ANCHOR, 0);

      expect(result.rejections).toEqual([]);
    });

    it('ignores an error Traefik logged before the write', async () => {
      // `docker logs --since <ts>` is inclusive, so the anchor line itself
      // comes back; it describes the configuration this write replaced.
      traefikLog(rejection(ANCHOR, 'shop-router-1', BAD_REGEX));

      const result = await status.verify(input(), ANCHOR, 0);

      expect(result.rejections).toEqual([]);
    });

    it('reads the whole burst when several routers were refused at once', async () => {
      traefikLog(
        [
          rejection(
            '2026-08-28T17:33:38.162947548Z',
            'shop-router-1',
            BAD_REGEX,
          ),
          rejection(
            '2026-08-28T17:33:38.162947600Z',
            'other-router-4',
            BAD_REGEX,
          ),
        ].join('\n'),
      );

      const result = await status.verify(input(), ANCHOR, 0);

      // The second line names a router this Application did not write, so it
      // belongs to whoever holds those rows — guessing at it from the string is
      // what the name index exists to avoid.
      expect(result.rejections.map((one) => one.routerName)).toEqual([
        'shop-router-1',
      ]);
    });

    it('reports one rejection when two reloads re-emitted the same error', async () => {
      traefikLog(
        [
          rejection(
            '2026-08-28T17:33:38.162947548Z',
            'shop-router-1',
            BAD_REGEX,
          ),
          rejection(
            '2026-08-28T17:33:40.250249007Z',
            'shop-router-1',
            BAD_REGEX,
          ),
        ].join('\n'),
      );

      const result = await status.verify(input(), ANCHOR, 0);

      expect(result.rejections).toHaveLength(1);
    });
  });

  describe('a Traefik that cannot be asked', () => {
    it('reports unavailable rather than health when no container is running', async () => {
      traefikLog('', '');

      const result = await status.verify(input(), ANCHOR, 0);

      expect(result.state).toBe('unavailable');
      expect(result.reason).toContain('cloudgate-traefik');
      expect(result.rejections).toEqual([]);
      // Nothing was read, so nothing was claimed about the configuration.
    });

    it('produces no anchor when Traefik is not there, and does not throw', async () => {
      traefikLog('', '');

      await expect(status.anchor(null)).resolves.toBeNull();
    });
  });

  describe('the window the check reads', () => {
    it('anchors on the timestamp of the last line already in the log', async () => {
      traefikLog(
        rejection('2026-08-28T17:33:38.162947548Z', 'shop-router-1', BAD_REGEX),
      );

      await expect(status.anchor(null)).resolves.toBe(
        '2026-08-28T17:33:38.162947548Z',
      );
    });

    it('asks the Server rather than this host when the application has one', async () => {
      traefikLog(
        rejection('2026-08-28T17:33:38.162947548Z', 'shop-router-1', BAD_REGEX),
      );

      await status.verify(input({ serverId: 'srv_1' }), ANCHOR, 0);

      // Both the container lookup and the log read went over SSH; nothing
      // asked this host's daemon about a Server's Traefik.
      expect(execAsyncRemote).toHaveBeenCalled();
      expect(execAsync).not.toHaveBeenCalled();
    });
  });

  describe('running behind the write', () => {
    it('settles without the caller having awaited it', async () => {
      traefikLog(
        rejection('2026-08-28T17:33:38.162947548Z', 'shop-router-1', BAD_REGEX),
      );

      status.verifyInBackground(input(), ANCHOR, 0);
      await status.settled('app_shop');

      expect(status.lastStatus('app_shop')?.rejections).toHaveLength(1);
    });

    it('records unavailable instead of rejecting when the daemon errors', async () => {
      execAsync.mockRejectedValue(new Error('docker daemon is not running'));

      status.verifyInBackground(input(), ANCHOR, 0);
      await expect(status.settled('app_shop')).resolves.toBeUndefined();

      expect(status.lastStatus('app_shop')?.state).toBe('unavailable');
    });
  });
});
