import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { isNull } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DOCKER_STATS_COMMAND } from '../../src/monitoring/collectors/container-stats.collector';
import { SERVER_STATS_COMMAND } from '../../src/monitoring/collectors/server-stats.collector';
import {
  containerMetric,
  serverMetric,
} from '../../src/monitoring/monitoring.schema';
import { MonitoringService } from '../../src/monitoring/monitoring.service';
import { NotificationDispatcherService } from '../../src/notifications/dispatcher.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { webServerSettings } from '../../src/settings/settings.schema';
import { SettingsService } from '../../src/settings/settings.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * `POST /admin/setup-monitoring` stored the web server's
 * metricsConfig and stopped there: `onApplicationBootstrap` only ever
 * registered jobs from the `server` table, and `GET /monitoring/metrics`
 * demanded a `serverId` that resolves against that same table — which the
 * instance's own machine has no row in. So the refresh rate, the retention
 * window, the cleanup cron and both thresholds were writes nothing read, and
 * the web server raised no CPU or memory notification however loaded it got.
 *
 * The web server is now a monitoring target under the `serverId: null`
 * convention the docker and traefik routes already use for "this machine":
 * jobs keyed on it, samples stored against it, and both metric reads
 * answering for it when no serverId is asked for.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ok = (stdout: string): ExecResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
});

// The hand-worked stats output server-stats.parser.spec.ts uses: cpu 25%,
// mem 6/8 GB = 75%, disk 5/9 of 100 GB, net 101/51 MB, uptime 123456.
const STATS_OUTPUT = `===CLOUDGATE_CPU===
cpu  1000 50 300 8000 200 0 50 0 0 0
cpu  1200 60 330 8700 250 0 60 0 0 0
===CLOUDGATE_CPUINFO===
processor\t: 0
vendor_id\t: GenuineIntel
model name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz
cpu MHz\t\t: 2394.454
physical id\t: 0
core id\t: 0
===CLOUDGATE_MEMINFO===
MemTotal:        8388608 kB
MemAvailable:    2097152 kB
===CLOUDGATE_DISK===
Filesystem        1-blocks        Used   Available Capacity Mounted on
/dev/vda1     107374182400 53687091200 42949672960      56% /
===CLOUDGATE_NET===
Inter-|   Receive                                                |  Transmit
    lo: 1048576    1000    0    0    0     0          0         0  1048576    1000    0    0    0     0       0          0
  eth0: 104857600  50000    0    0    0     0          0         0 52428800   30000    0    0    0     0       0          0
===CLOUDGATE_UPTIME===
123456.78 654321.90
===CLOUDGATE_HOST===
5.15.0-91-generic
x86_64
1
===CLOUDGATE_OS===
PRETTY_NAME="Ubuntu 22.04.3 LTS"
`;

const STATS_LINE = JSON.stringify({
  BlockIO: '1.2MB / 3.4MB',
  CPUPerc: '12.34%',
  ID: 'abc123',
  MemPerc: '25.50%',
  MemUsage: '512.5MiB / 2GiB',
  Name: 'cloudgate-x1',
  NetIO: '1.45kB / 656B',
});

/** An apiUpdateWebServerMonitoring-shaped body for POST /admin/setup-monitoring. */
function webMonitoringConfig(
  overrides: {
    token?: string;
    refreshRate?: number;
    cronJob?: string;
    include?: string[];
    thresholds?: { cpu: number; memory: number };
  } = {},
) {
  return {
    server: {
      refreshRate: overrides.refreshRate ?? 60,
      port: 4500,
      token: overrides.token ?? 'web-metrics-token',
      urlCallback: 'http://cloudgate.example.com/api/notifications/receive',
      retentionDays: 2,
      cronJob: overrides.cronJob ?? '0 0 * * *',
      thresholds: overrides.thresholds ?? { cpu: 0, memory: 0 },
    },
    containers: {
      refreshRate: 60,
      services: { include: overrides.include ?? ['cloudgate'], exclude: [] },
    },
  };
}

describe('Web server monitoring (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let monitoring: MonitoringService;
  let settings: SettingsService;
  let registry: SchedulerRegistry;
  let scheduling: SchedulingService;
  let dispatcher: NotificationDispatcherService;

  const remoteExec = {
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: remoteExec }],
    });
    httpServer = ctx.app.getHttpServer() as App;
    monitoring = ctx.app.get(MonitoringService);
    settings = ctx.app.get(SettingsService);
    registry = ctx.app.get(SchedulerRegistry);
    scheduling = ctx.app.get(SchedulingService);
    dispatcher = ctx.app.get(NotificationDispatcherService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    remoteExec.execAsync.mockReset();
    remoteExec.execAsyncRemote.mockReset();
    jest.restoreAllMocks();
    await ctx.resetDb();
  });

  afterEach(() => {
    monitoring.unregisterServer(null);
  });

  async function signUpOwner(): Promise<{ cookie: string; id: string }> {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    const { user } = res.body as { user: { id: string } };
    return { cookie: res.headers['set-cookie'], id: user.id };
  }

  async function setUpWebMonitoring(
    cookie: string,
    overrides?: Parameters<typeof webMonitoringConfig>[0],
  ): Promise<void> {
    const res = await request(httpServer)
      .post('/admin/setup-monitoring')
      .set('Cookie', cookie)
      .send({ metricsConfig: webMonitoringConfig(overrides) });
    expect(res.status).toBe(200);
  }

  async function ownerCtx() {
    const session = await signUpOwner();
    const orgs = await request(httpServer)
      .get('/organizations')
      .set('Cookie', session.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    return {
      session,
      organizationId,
      permissionCtx: {
        user: { id: session.id },
        session: { activeOrganizationId: organizationId },
      },
    };
  }

  describe('the stored config drives collection', () => {
    it('registers the web server jobs from what setup-monitoring stored', async () => {
      const { session } = await ownerCtx();

      await setUpWebMonitoring(session.cookie);

      expect(registry.doesExist('interval', 'monitoring:server:local')).toBe(
        true,
      );
      expect(
        registry.doesExist('interval', 'monitoring:containers:local'),
      ).toBe(true);
      expect(scheduling.has('monitoring:cleanup:local')).toBe(true);
    });

    it('re-registers instead of duplicating when the config is posted again', async () => {
      const { session } = await ownerCtx();

      await setUpWebMonitoring(session.cookie, { refreshRate: 60 });
      const first: unknown = registry.getInterval('monitoring:server:local');

      await setUpWebMonitoring(session.cookie, { refreshRate: 30 });
      const second: unknown = registry.getInterval('monitoring:server:local');

      // One interval under one name, and it is the *new* one — a duplicate
      // would have thrown on the second addInterval.
      expect(second).not.toBe(first);
      expect(
        registry
          .getIntervals()
          .filter((name) => name === 'monitoring:server:local'),
      ).toHaveLength(1);
    });

    it('registers nothing while the web server has never been set up', async () => {
      await settings.getWebServerSettings();

      await monitoring.onApplicationBootstrap();

      expect(registry.doesExist('interval', 'monitoring:server:local')).toBe(
        false,
      );
      expect(scheduling.has('monitoring:cleanup:local')).toBe(false);
    });

    // The host's site: "Stop keeping a history" posts an empty token, and
    // the host's stored samples must still expire rather than outlive their
    // retention with nothing left to prune them.
    it('keeps the retention cleanup once the history is stopped', async () => {
      const { session } = await ownerCtx();
      await setUpWebMonitoring(session.cookie);

      await setUpWebMonitoring(session.cookie, { token: '' });

      expect(registry.doesExist('interval', 'monitoring:server:local')).toBe(
        false,
      );
      expect(scheduling.has('monitoring:cleanup:local')).toBe(true);
    });

    it('re-registers the web server at boot', async () => {
      const { session } = await ownerCtx();
      await setUpWebMonitoring(session.cookie);
      monitoring.unregisterServer(null);

      await monitoring.onApplicationBootstrap();

      expect(registry.doesExist('interval', 'monitoring:server:local')).toBe(
        true,
      );
    });

    it('samples the web server locally, not over SSH, and stores it against no server', async () => {
      const { session } = await ownerCtx();
      await setUpWebMonitoring(session.cookie);
      monitoring.unregisterServer(null);
      remoteExec.execAsync.mockResolvedValue(ok(STATS_OUTPUT));

      await monitoring.collectServerMetrics(null);

      expect(remoteExec.execAsync).toHaveBeenCalledWith(SERVER_STATS_COMMAND);
      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
      const [row] = await ctx.db
        .select()
        .from(serverMetric)
        .where(isNull(serverMetric.serverId));
      expect(row.cpu).toBeCloseTo(25, 10);
      expect(row.memUsed).toBeCloseTo(75, 10);
      expect(row.distro).toBe('Ubuntu 22.04.3 LTS');
    });

    it('samples the web server containers locally', async () => {
      const { session } = await ownerCtx();
      await setUpWebMonitoring(session.cookie);
      monitoring.unregisterServer(null);
      remoteExec.execAsync.mockResolvedValue(ok(STATS_LINE));

      await monitoring.collectContainerMetrics(null);

      expect(remoteExec.execAsync).toHaveBeenCalledWith(DOCKER_STATS_COMMAND);
      const rows = await ctx.db
        .select()
        .from(containerMetric)
        .where(isNull(containerMetric.serverId));
      expect(rows).toHaveLength(1);
      expect(rows[0].containerName).toBe('cloudgate-x1');
    });
  });

  describe('the stored thresholds fire', () => {
    it('raises the CPU threshold notification for the web server, instance-wide', async () => {
      const { session } = await ownerCtx();
      await setUpWebMonitoring(session.cookie, {
        thresholds: { cpu: 20, memory: 0 },
      });
      monitoring.unregisterServer(null);
      remoteExec.execAsync.mockResolvedValue(ok(STATS_OUTPUT));
      const dispatchSpy = jest
        .spyOn(dispatcher, 'dispatch')
        .mockResolvedValue();

      await monitoring.collectServerMetrics(null);

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      // Instance-wide (null), the way the local docker-cleanup run notifies:
      // the web server belongs to the instance, not to one organization.
      expect(dispatchSpy).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          type: 'server-threshold',
          serverName: 'Cloudgate',
          metric: 'CPU',
          value: 25,
          threshold: 20,
          message: 'CPU usage (25.00%) exceeded threshold (20.00%)',
        }),
      );
    });

    it('stores the platform host breach, announces it once, and announces its recovery once', async () => {
      const { session } = await ownerCtx();
      await setUpWebMonitoring(session.cookie, {
        thresholds: { cpu: 20, memory: 0 },
      });
      monitoring.unregisterServer(null);
      remoteExec.execAsync.mockResolvedValue(ok(STATS_OUTPUT));
      const dispatchSpy = jest
        .spyOn(dispatcher, 'dispatch')
        .mockResolvedValue();

      await monitoring.collectServerMetrics(null);
      await monitoring.collectServerMetrics(null);
      await monitoring.collectServerMetrics(null);

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const [opened] = await ctx.db
        .select({ since: webServerSettings.cpuBreachedSince })
        .from(webServerSettings);
      expect(opened.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Raised past the 25 % sample: the next sample closes it.
      await setUpWebMonitoring(session.cookie, {
        thresholds: { cpu: 30, memory: 0 },
      });
      monitoring.unregisterServer(null);
      dispatchSpy.mockClear();
      await monitoring.collectServerMetrics(null);
      await monitoring.collectServerMetrics(null);

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(dispatchSpy).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          type: 'server-threshold',
          serverName: 'Cloudgate',
          metric: 'CPU',
          value: 25,
          threshold: 30,
          close: { reason: 'recovered', breachedSince: opened.since },
        }),
      );
      const [closed] = await ctx.db
        .select({ since: webServerSettings.cpuBreachedSince })
        .from(webServerSettings);
      expect(closed.since).toBeNull();
    });

    it('closes a breached platform host threshold as turned off when setup-monitoring saves it as 0', async () => {
      const { session } = await ownerCtx();
      await setUpWebMonitoring(session.cookie, {
        thresholds: { cpu: 20, memory: 0 },
      });
      monitoring.unregisterServer(null);
      remoteExec.execAsync.mockResolvedValue(ok(STATS_OUTPUT));
      const dispatchSpy = jest
        .spyOn(dispatcher, 'dispatch')
        .mockResolvedValue();
      await monitoring.collectServerMetrics(null);
      const [opened] = await ctx.db
        .select({ since: webServerSettings.cpuBreachedSince })
        .from(webServerSettings);
      expect(opened.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Stop collecting and turn the threshold off in the one save.
      dispatchSpy.mockClear();
      await setUpWebMonitoring(session.cookie, {
        token: '',
        thresholds: { cpu: 0, memory: 0 },
      });

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(dispatchSpy).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          type: 'server-threshold',
          serverName: 'Cloudgate',
          metric: 'CPU',
          value: 25,
          threshold: 0,
          close: { reason: 'turned-off', breachedSince: opened.since },
        }),
      );
      const [closed] = await ctx.db
        .select({ since: webServerSettings.cpuBreachedSince })
        .from(webServerSettings);
      expect(closed.since).toBeNull();

      dispatchSpy.mockClear();
      await monitoring.collectServerMetrics(null);
      expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it('stays silent while the stored thresholds are zero', async () => {
      const { session } = await ownerCtx();
      await setUpWebMonitoring(session.cookie);
      monitoring.unregisterServer(null);
      remoteExec.execAsync.mockResolvedValue(ok(STATS_OUTPUT));
      const dispatchSpy = jest
        .spyOn(dispatcher, 'dispatch')
        .mockResolvedValue();

      await monitoring.collectServerMetrics(null);

      expect(dispatchSpy).not.toHaveBeenCalled();
    });
  });

  describe('the samples are readable', () => {
    it('answers GET /monitoring/metrics for the web server with no serverId', async () => {
      const { session } = await ownerCtx();
      await setUpWebMonitoring(session.cookie);
      monitoring.unregisterServer(null);
      remoteExec.execAsync.mockResolvedValue(ok(STATS_OUTPUT));
      await monitoring.collectServerMetrics(null);

      const res = await request(httpServer)
        .get('/monitoring/metrics')
        .set('Cookie', session.cookie)
        .query({ limit: 'all' });

      expect(res.status).toBe(200);
      const body = res.body as { cpu: string; memUsed: string }[];
      expect(body).toHaveLength(1);
      expect(body[0].cpu).toBe('25.00');
      expect(body[0].memUsed).toBe('75.00');
    });

    it('answers GET /monitoring/metrics/containers for the web server with no serverId', async () => {
      const { session } = await ownerCtx();
      await setUpWebMonitoring(session.cookie);
      monitoring.unregisterServer(null);
      remoteExec.execAsync.mockResolvedValue(ok(STATS_LINE));
      await monitoring.collectContainerMetrics(null);

      const res = await request(httpServer)
        .get('/monitoring/metrics/containers')
        .set('Cookie', session.cookie)
        .query({ appName: 'cloudgate', limit: 'all' });

      expect(res.status).toBe(200);
      const body = res.body as { CPU: number; Name: string }[];
      expect(body).toHaveLength(1);
      expect(body[0].CPU).toBe(12.34);
      expect(body[0].Name).toBe('cloudgate-x1');
    });
  });

  /**
   * The composite stats command ends in `|| true`, so a
   * platform host with no `/proc` answers empty sections with exit 0 and
   * `parseServerStats` returns a well-formed sample of **zeros**. Storing that
   * writes a row claiming the machine Cloudgate runs on has 0% CPU, no memory
   * fitted and no disk — the same lie the console's `isUnmeasured` guard refuses
   * to draw from the stats socket, arriving through the other door. This machine
   * is one of those hosts, so this is the live behaviour rather than a
   * hypothetical.
   */
  describe('a sample with nothing measured in it', () => {
    /** What a host with no /proc answers: the markers, and uname. */
    const NO_PROC_OUTPUT = `===CLOUDGATE_CPU===
===CLOUDGATE_CPUINFO===
===CLOUDGATE_MEMINFO===
===CLOUDGATE_DISK===
===CLOUDGATE_NET===
===CLOUDGATE_UPTIME===
===CLOUDGATE_HOST===
25.5.0
arm64
===CLOUDGATE_OS===
`;

    it('is not stored, and does not become a readable row', async () => {
      const { session } = await ownerCtx();
      await setUpWebMonitoring(session.cookie);
      monitoring.unregisterServer(null);
      remoteExec.execAsync.mockResolvedValue(ok(NO_PROC_OUTPUT));

      await monitoring.collectServerMetrics(null);

      expect(remoteExec.execAsync).toHaveBeenCalledWith(SERVER_STATS_COMMAND);
      const rows = await ctx.db
        .select()
        .from(serverMetric)
        .where(isNull(serverMetric.serverId));
      expect(rows).toEqual([]);

      const res = await request(httpServer)
        .get('/monitoring/metrics')
        .set('Cookie', session.cookie)
        .query({ limit: 'all' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    /* There is deliberately no "raises no threshold notification" case here.
       Every value in a zeros sample is 0, so no threshold above 0 could breach
       and the assertion would pass however the code behaved — a test that is
       true by construction. The collection tick returns before it evaluates
       thresholds all the same, because a sample that is not a reading is not a
       reading for the alerting either. */

    /**
     * The backend log is already a line of `Monitoring job … failed` every few
     * seconds on this host; a suppression that logged per tick would double it.
     * An interval firing every 5 seconds must produce one line, not twelve a
     * minute — so the log is rate-limited per target and counts what it skipped.
     */
    it('is logged once rather than on every tick', async () => {
      const { session } = await ownerCtx();
      await setUpWebMonitoring(session.cookie);
      monitoring.unregisterServer(null);
      remoteExec.execAsync.mockResolvedValue(ok(NO_PROC_OUTPUT));
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

      await monitoring.collectServerMetrics(null);
      await monitoring.collectServerMetrics(null);
      await monitoring.collectServerMetrics(null);

      const lines = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('web server'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('/proc');
    });
  });

  describe('retention', () => {
    it('prunes the web server samples past the stored retention window', async () => {
      const { session } = await ownerCtx();
      await setUpWebMonitoring(session.cookie);
      monitoring.unregisterServer(null);

      const base = {
        cpu: 10,
        cpuModel: 'GenuineIntel Xeon',
        cpuCores: 2,
        cpuPhysicalCores: 1,
        cpuSpeed: 2394.454,
        os: 'Ubuntu 22.04.3 LTS',
        distro: 'Ubuntu 22.04.3 LTS',
        kernel: '5.15.0-91-generic',
        arch: 'x86_64',
        memUsed: 40,
        memUsedGB: 6,
        memTotal: 8,
        uptime: 123456,
        diskUsed: 55.5,
        totalDisk: 100,
        networkIn: 101,
        networkOut: 51,
        serverId: null,
      };
      const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
      const fresh = new Date().toISOString();
      await ctx.db.insert(serverMetric).values([
        { ...base, timestamp: old },
        { ...base, timestamp: fresh },
      ]);

      await monitoring.cleanupMetrics(null, 2);

      const rows = await ctx.db
        .select()
        .from(serverMetric)
        .where(isNull(serverMetric.serverId));
      expect(rows.map((row) => row.timestamp)).toEqual([fresh]);
    });
  });
});
