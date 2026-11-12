import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { AccessLogService } from '../../src/monitoring/access-log.service';
import { DOCKER_STATS_COMMAND } from '../../src/monitoring/collectors/container-stats.collector';
import { SERVER_STATS_COMMAND } from '../../src/monitoring/collectors/server-stats.collector';
import {
  containerMetric,
  serverMetric,
} from '../../src/monitoring/monitoring.schema';
import { MonitoringService } from '../../src/monitoring/monitoring.service';
import { NotificationDispatcherService } from '../../src/notifications/dispatcher.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ExecResult } from '../../src/remote/remote-exec.service';
import { member } from '../../src/db/schema';
import { defaultMetricsConfig, server } from '../../src/servers/server.schema';
import { ServersService } from '../../src/servers/servers.service';
import { webServerSettings } from '../../src/settings/settings.schema';
import { SshKeysService } from '../../src/ssh-keys/ssh-keys.service';
import {
  secondOrganizationOwner as secondOrganizationOwnerOf,
  signUpMember,
  createOrganization,
} from '../utils/test-auth';
import { freezeOrganization } from '../utils/frozen-organization';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

async function signUp(
  httpServer: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(httpServer)
    .post('/api/auth/sign-up/email')
    .send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

async function setUpOwner(httpServer: App) {
  const ownerSession = await signUp(httpServer, owner);
  const orgs = await request(httpServer)
    .get('/organizations')
    .set('Cookie', ownerSession.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;
  return { organizationId, owner: ownerSession };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/** `PermissionService.checkInstanceAuthority`'s refusal, written out. */
const INSTANCE_AUTHORITY_REFUSAL =
  'Only an owner or admin of the instance organization can configure the platform host';

/** The message an `AllExceptionsFilter` response carries. */
const refusal = (res: { body: unknown }): string =>
  (res.body as { message: string }).message;

const ok = (stdout: string): ExecResult => ({
  stdout,
  stderr: '',
  exitCode: 0,
});

// The same hand-worked stats output as server-stats.parser.spec.ts: cpu 25%,
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
  Name: 'testapp-x1',
  NetIO: '1.45kB / 656B',
});

/**
 * The same config with the `token` key **gone** rather than `undefined` — the
 * body `toMetricsConfig` builds for a host whose token the console was not
 * shown, and the one the per-Server schema refused until the fix. Absent and
 * `undefined` are the same thing to `JSON.stringify` and different things to
 * zod, so this deletes the key.
 */
function withoutToken(config: ReturnType<typeof monitoringConfig>) {
  const server: Partial<typeof config.server> = { ...config.server };
  delete server.token;
  return { ...config, server: server as Omit<typeof config.server, 'token'> };
}

/** A full apiUpdateServerMonitoring-shaped metrics config. */
function monitoringConfig(
  overrides: {
    token?: string;
    cronJob?: string;
    include?: string[];
    thresholds?: { cpu: number; memory: number };
  } = {},
) {
  return {
    server: {
      refreshRate: 60,
      port: 4500,
      token: overrides.token ?? 'metrics-token-1',
      urlCallback: 'http://cloudgate.example.com/api/notifications/receive',
      retentionDays: 2,
      cronJob: overrides.cronJob ?? '0 0 * * *',
      thresholds: overrides.thresholds ?? { cpu: 0, memory: 0 },
    },
    containers: {
      refreshRate: 60,
      services: {
        include: overrides.include ?? ['testapp'],
        exclude: [],
      },
    },
  };
}

describe('Monitoring (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let monitoring: MonitoringService;
  let accessLog: AccessLogService;
  let registry: SchedulerRegistry;
  let scheduling: SchedulingService;
  let dispatcher: NotificationDispatcherService;
  let servers: ServersService;
  let sshKeys: SshKeysService;

  const remoteExec = {
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<
      Promise<ExecResult>,
      [string, string, ((d: string) => void)?]
    >(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: remoteExec }],
    });
    httpServer = ctx.app.getHttpServer() as App;
    monitoring = ctx.app.get(MonitoringService);
    accessLog = ctx.app.get(AccessLogService);
    registry = ctx.app.get(SchedulerRegistry);
    scheduling = ctx.app.get(SchedulingService);
    dispatcher = ctx.app.get(NotificationDispatcherService);
    servers = ctx.app.get(ServersService);
    sshKeys = ctx.app.get(SshKeysService);
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

  async function setUpOwnerWithServer() {
    const { organizationId, owner: ownerSession } =
      await setUpOwner(httpServer);
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);
    const key = await sshKeys.create(ownerCtx, { name: 'server-key' });
    const created = await servers.create(ownerCtx, {
      name: 'worker-1',
      ipAddress: '203.0.113.10',
      port: 22,
      username: 'root',
      sshKeyId: key.sshKeyId,
    });
    return {
      organizationId,
      ownerSession,
      ownerCtx,
      serverId: created.serverId,
    };
  }

  describe('setupMonitoring', () => {
    it('stores the config and registers collection, container and cleanup jobs', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();

      await monitoring.setupMonitoring(ownerCtx, serverId, monitoringConfig());

      const [row] = await ctx.db
        .select()
        .from(server)
        .where(eq(server.serverId, serverId));
      expect(row.metricsConfig.server.token).toBe('metrics-token-1');
      expect(row.metricsConfig.server.type).toBe('Remote');
      expect(row.metricsConfig.containers.services.include).toEqual([
        'testapp',
      ]);

      expect(
        registry.doesExist('interval', `monitoring:server:${serverId}`),
      ).toBe(true);
      expect(
        registry.doesExist('interval', `monitoring:containers:${serverId}`),
      ).toBe(true);
      expect(scheduling.has(`monitoring:cleanup:${serverId}`)).toBe(true);

      monitoring.unregisterServer(serverId);
    });

    /**
     * The second half of the token fix. `AdminService.setupMonitoring` has
     * withheld the token it just wrote — *"there is no caller it is safe to echo it
     * to"* — and this method, its exact twin one host over, echoed the raw row.
     *
     * The three write cases are asserted beside the projection on purpose:
     * they are one decision. While `token` was required the echo could only
     * ever repeat what the caller had just sent, and sanitizing it would have
     * been symmetry for its own sake; once omitting the field means *keep what
     * is stored*, the response carries a credential the caller never supplied,
     * to a role (`server: ['create']` with no `read`, which
     * `CustomRolesService.validatePermissions` accepts) that `GET /servers/:id`
     * refuses. And the cases are what the console's shared `toMetricsConfig`
     * already sends: it omits the field for any config carrying `hasToken` and
     * no readable value, which is the shape the token fix gave a `server` row.
     */
    it('answers the sanitized row rather than the token it just wrote', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();

      const answered = await monitoring.setupMonitoring(
        ownerCtx,
        serverId,
        monitoringConfig(),
      );

      // Absent, not `undefined`-valued: `in` is the difference between a
      // projection and a key whose value happens to be empty.
      expect('token' in answered.metricsConfig.server).toBe(false);
      expect(answered.metricsConfig.server.hasToken).toBe(true);
      // Not merely relocated somewhere else in the answer.
      expect(JSON.stringify(answered)).not.toContain('metrics-token-1');
      // …while the row really was written, so the projection is not what a
      // failed write looks like.
      const [row] = await ctx.db
        .select()
        .from(server)
        .where(eq(server.serverId, serverId));
      expect(row.metricsConfig.server.token).toBe('metrics-token-1');

      monitoring.unregisterServer(serverId);
    });

    it('keeps the stored token when the field is omitted, and still re-registers', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      await monitoring.setupMonitoring(ownerCtx, serverId, monitoringConfig());

      // The threshold tweak an operator saves from a console that was never
      // shown the token. Omitted must not rotate it — that invariant is ADR
      // 0019's, and before the fix this route wrote `undefined` over it.
      const base = withoutToken(monitoringConfig());
      await monitoring.setupMonitoring(ownerCtx, serverId, {
        ...base,
        server: { ...base.server, thresholds: { cpu: 90, memory: 80 } },
      });

      const [row] = await ctx.db
        .select()
        .from(server)
        .where(eq(server.serverId, serverId));
      expect(row.metricsConfig.server.token).toBe('metrics-token-1');
      expect(row.metricsConfig.server.thresholds).toEqual({
        cpu: 90,
        memory: 80,
      });
      // Kept means still collecting: an omitted token that had silently
      // cleared the value would have torn the intervals down here.
      expect(
        registry.doesExist('interval', `monitoring:server:${serverId}`),
      ).toBe(true);

      monitoring.unregisterServer(serverId);
    });

    it('rotates on a value and clears on an empty string', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      await monitoring.setupMonitoring(ownerCtx, serverId, monitoringConfig());

      const rotated = await monitoring.setupMonitoring(
        ownerCtx,
        serverId,
        monitoringConfig({ token: 'metrics-token-2' }),
      );
      expect(rotated.metricsConfig.server.hasToken).toBe(true);
      const [afterRotate] = await ctx.db
        .select()
        .from(server)
        .where(eq(server.serverId, serverId));
      expect(afterRotate.metricsConfig.server.token).toBe('metrics-token-2');

      // `''` is the only thing that stops collecting, so it must not fall
      // through to the stored value — which is why the service uses `??` and
      // not `||`.
      const cleared = await monitoring.setupMonitoring(
        ownerCtx,
        serverId,
        monitoringConfig({ token: '' }),
      );
      expect(cleared.metricsConfig.server.hasToken).toBe(false);
      const [afterClear] = await ctx.db
        .select()
        .from(server)
        .where(eq(server.serverId, serverId));
      expect(afterClear.metricsConfig.server.token).toBe('');
      expect(
        registry.doesExist('interval', `monitoring:server:${serverId}`),
      ).toBe(false);
    });

    it('registers no collection when the token is empty', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();

      await monitoring.setupMonitoring(
        ownerCtx,
        serverId,
        monitoringConfig({ token: '' }),
      );

      expect(
        registry.doesExist('interval', `monitoring:server:${serverId}`),
      ).toBe(false);
      expect(
        registry.doesExist('interval', `monitoring:containers:${serverId}`),
      ).toBe(false);

      monitoring.unregisterServer(serverId);
    });

    /**
     * "Stop collecting" is this route with an empty token, and it used to
     * take the retention cron down with the intervals — so the samples a
     * stopped Server had stored were never pruned, and the console's "kept
     * until retention expires" would have been false for ever. Stopping ends
     * the *collection*; what was collected still expires on the schedule the
     * operator chose.
     */
    it('keeps the retention cleanup of a stopped Server, and re-registers it at boot', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      await monitoring.setupMonitoring(ownerCtx, serverId, monitoringConfig());

      await monitoring.setupMonitoring(
        ownerCtx,
        serverId,
        monitoringConfig({ token: '' }),
      );

      expect(
        registry.doesExist('interval', `monitoring:server:${serverId}`),
      ).toBe(false);
      expect(scheduling.has(`monitoring:cleanup:${serverId}`)).toBe(true);

      monitoring.unregisterServer(serverId);
      await monitoring.onApplicationBootstrap();

      expect(
        registry.doesExist('interval', `monitoring:server:${serverId}`),
      ).toBe(false);
      expect(scheduling.has(`monitoring:cleanup:${serverId}`)).toBe(true);

      monitoring.unregisterServer(serverId);
      monitoring.unregisterServer(null);
    });

    it('registers no cleanup for a Server that was never set up', async () => {
      const { serverId } = await setUpOwnerWithServer();

      await monitoring.onApplicationBootstrap();

      expect(scheduling.has(`monitoring:cleanup:${serverId}`)).toBe(false);
    });

    it('skips the container job when the include list is empty', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();

      await monitoring.setupMonitoring(
        ownerCtx,
        serverId,
        monitoringConfig({ include: [] }),
      );

      expect(
        registry.doesExist('interval', `monitoring:server:${serverId}`),
      ).toBe(true);
      expect(
        registry.doesExist('interval', `monitoring:containers:${serverId}`),
      ).toBe(false);

      monitoring.unregisterServer(serverId);
    });

    it('rejects a server outside the caller organization', async () => {
      const { serverId, ownerSession } = await setUpOwnerWithServer();
      const secondOrg = await createOrganization(
        httpServer,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      await expect(
        monitoring.setupMonitoring(
          permissionCtx(ownerSession.id, secondOrgId),
          serverId,
          monitoringConfig(),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('re-registers enabled servers at boot', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      await monitoring.setupMonitoring(ownerCtx, serverId, monitoringConfig());
      monitoring.unregisterServer(serverId);

      await monitoring.onApplicationBootstrap();

      expect(
        registry.doesExist('interval', `monitoring:server:${serverId}`),
      ).toBe(true);
      monitoring.unregisterServer(serverId);
    });
  });

  describe('collectServerMetrics', () => {
    it('runs the stats command over SSH and saves the parsed sample', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      await monitoring.setupMonitoring(ownerCtx, serverId, monitoringConfig());
      monitoring.unregisterServer(serverId);
      remoteExec.execAsyncRemote.mockResolvedValue(ok(STATS_OUTPUT));

      await monitoring.collectServerMetrics(serverId);

      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        serverId,
        SERVER_STATS_COMMAND,
      );
      const [row] = await ctx.db
        .select()
        .from(serverMetric)
        .where(eq(serverMetric.serverId, serverId));
      expect(row.cpu).toBeCloseTo(25, 10);
      expect(row.cpuModel).toBe(
        'GenuineIntel Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz',
      );
      expect(row.memUsed).toBeCloseTo(75, 10);
      expect(row.memUsedGB).toBeCloseTo(6, 10);
      expect(row.distro).toBe('Ubuntu 22.04.3 LTS');
      expect(row.uptime).toBe(123456);
      expect(row.networkIn).toBeCloseTo(101, 10);
      expect(row.networkOut).toBeCloseTo(51, 10);
      expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('fires the server-threshold notification when the sample breaches config', async () => {
      const { ownerCtx, serverId, organizationId } =
        await setUpOwnerWithServer();
      await monitoring.setupMonitoring(
        ownerCtx,
        serverId,
        monitoringConfig({ thresholds: { cpu: 20, memory: 0 } }),
      );
      monitoring.unregisterServer(serverId);
      remoteExec.execAsyncRemote.mockResolvedValue(ok(STATS_OUTPUT));
      const dispatchSpy = jest
        .spyOn(dispatcher, 'dispatch')
        .mockResolvedValue();

      await monitoring.collectServerMetrics(serverId);

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(dispatchSpy).toHaveBeenCalledWith(
        organizationId,
        expect.objectContaining({
          type: 'server-threshold',
          serverName: 'worker-1',
          metric: 'CPU',
          value: 25,
          threshold: 20,
          message: 'CPU usage (25.00%) exceeded threshold (20.00%)',
        }),
      );
    });

    it('stores the breach on the Server row, and a fresh read of it announces nothing more', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      await monitoring.setupMonitoring(
        ownerCtx,
        serverId,
        monitoringConfig({ thresholds: { cpu: 20, memory: 0 } }),
      );
      monitoring.unregisterServer(serverId);
      remoteExec.execAsyncRemote.mockResolvedValue(ok(STATS_OUTPUT));
      const dispatchSpy = jest
        .spyOn(dispatcher, 'dispatch')
        .mockResolvedValue();

      await monitoring.collectServerMetrics(serverId);
      await monitoring.collectServerMetrics(serverId);

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const [row] = await ctx.db
        .select()
        .from(server)
        .where(eq(server.serverId, serverId));
      expect(row.cpuBreachedSince).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(row.memoryBreachedSince).toBeNull();

      // Turned off while breached, with collection stopped in the same save:
      // the save closes it, once, and the next sample finds nothing open.
      dispatchSpy.mockClear();
      await monitoring.setupMonitoring(
        ownerCtx,
        serverId,
        monitoringConfig({ token: '', thresholds: { cpu: 0, memory: 0 } }),
      );

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          metric: 'CPU',
          value: 25,
          threshold: 0,
          close: {
            reason: 'turned-off',
            breachedSince: row.cpuBreachedSince,
          },
        }),
      );
      const [after] = await ctx.db
        .select()
        .from(server)
        .where(eq(server.serverId, serverId));
      expect(after.cpuBreachedSince).toBeNull();

      dispatchSpy.mockClear();
      await monitoring.collectServerMetrics(serverId);
      expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it('unregisters the jobs and skips when the server row is gone', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      await monitoring.setupMonitoring(ownerCtx, serverId, monitoringConfig());
      await ctx.db.delete(server).where(eq(server.serverId, serverId));

      await monitoring.collectServerMetrics(serverId);

      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
      expect(
        registry.doesExist('interval', `monitoring:server:${serverId}`),
      ).toBe(false);
    });

    it("samples nothing and checks no threshold on a Frozen Organization's Server", async () => {
      const { ownerCtx, serverId, organizationId } =
        await setUpOwnerWithServer();
      await monitoring.setupMonitoring(
        ownerCtx,
        serverId,
        monitoringConfig({ thresholds: { cpu: 20, memory: 0 } }),
      );
      monitoring.unregisterServer(serverId);
      remoteExec.execAsyncRemote.mockResolvedValue(ok(STATS_OUTPUT));
      const dispatchSpy = jest
        .spyOn(dispatcher, 'dispatch')
        .mockResolvedValue();
      await freezeOrganization(ctx, organizationId);
      remoteExec.execAsyncRemote.mockClear();

      await monitoring.collectServerMetrics(serverId);
      await monitoring.collectContainerMetrics(serverId);

      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
      expect(dispatchSpy).not.toHaveBeenCalled();
      const [row] = await ctx.db
        .select()
        .from(server)
        .where(eq(server.serverId, serverId));
      expect(row.cpuBreachedSince).toBeNull();
    });
  });

  describe('collectContainerMetrics', () => {
    it('saves one record per monitored service with the agent JSON shape', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      await monitoring.setupMonitoring(ownerCtx, serverId, monitoringConfig());
      monitoring.unregisterServer(serverId);
      const otherLine = STATS_LINE.replace(
        '"Name":"testapp-x1"',
        '"Name":"other-app-1"',
      );
      remoteExec.execAsyncRemote.mockResolvedValue(
        ok(`${STATS_LINE}\n${otherLine}`),
      );

      await monitoring.collectContainerMetrics(serverId);

      expect(remoteExec.execAsyncRemote).toHaveBeenCalledWith(
        serverId,
        DOCKER_STATS_COMMAND,
      );
      const rows = await ctx.db
        .select()
        .from(containerMetric)
        .where(eq(containerMetric.serverId, serverId));
      expect(rows).toHaveLength(1);
      expect(rows[0].containerId).toBe('abc123');
      expect(rows[0].containerName).toBe('testapp-x1');
      expect(rows[0].metrics).toEqual({
        timestamp: rows[0].timestamp,
        CPU: 12.34,
        Memory: {
          percentage: 25.5,
          used: 512.5,
          total: 2,
          usedUnit: 'MB',
          totalUnit: 'GB',
        },
        Network: { input: 1.45, output: 656, inputUnit: 'kB', outputUnit: 'B' },
        BlockIO: { read: 1.2, write: 3.4, readUnit: 'MB', writeUnit: 'MB' },
        Container: 'abc123',
        ID: 'abc123',
        Name: 'testapp-x1',
      });
    });

    /**
     * **The box's measurement, as a test**. Two Applications on one host,
     * both named in the include list, both printed by `docker stats`: this
     * stored one row per tick — 102 ticks, 102 rows — because both Swarm task
     * names reduced to `app` and the dedup dropped whichever the daemon printed
     * second, for ever. `app-zk77rz` was sampled 0 times while `app-cslg4y`
     * reached 79, and including `app-zk77rz` alone started it within 5 s.
     *
     * The task names and the two `appName`s they answer to are written out
     * rather than derived, so this cannot pass by agreeing with whatever
     * `getServiceName` computes (§1.7).
     */
    it('stores a row for every Application in one tick, readable as two series', async () => {
      const { ownerCtx, ownerSession, serverId } = await setUpOwnerWithServer();
      await monitoring.setupMonitoring(
        ownerCtx,
        serverId,
        monitoringConfig({ include: ['app-cslg4y', 'app-zk77rz'] }),
      );
      monitoring.unregisterServer(serverId);
      const first = 'app-cslg4y.1.t6gam9u4jp96f6iecyjqjb6te';
      const second = 'app-zk77rz.1.nm80qhkq0z5v7f2yv4c1x9r3s';
      remoteExec.execAsyncRemote.mockResolvedValue(
        ok(
          [
            STATS_LINE.replace('"Name":"testapp-x1"', `"Name":"${first}"`),
            STATS_LINE.replace(
              '"Name":"testapp-x1"',
              `"Name":"${second}"`,
            ).replace('"ID":"abc123"', '"ID":"def456"'),
          ].join('\n'),
        ),
      );

      await monitoring.collectContainerMetrics(serverId);

      const rows = await ctx.db
        .select()
        .from(containerMetric)
        .where(eq(containerMetric.serverId, serverId));
      expect(rows.map((row) => row.containerName).sort()).toEqual([
        first,
        second,
      ]);

      const drawn: [appName: string, taskName: string][] = [
        ['app-cslg4y', first],
        ['app-zk77rz', second],
      ];
      for (const [appName, taskName] of drawn) {
        const res = await request(httpServer)
          .get('/monitoring/metrics/containers')
          .query({ serverId, appName })
          .set('Cookie', ownerSession.cookie);
        expect(res.status).toBe(200);
        expect((res.body as { Name: string }[]).map((m) => m.Name)).toEqual([
          taskName,
        ]);
      }
    });

    it('skips collection entirely when the include list is empty', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      await monitoring.setupMonitoring(
        ownerCtx,
        serverId,
        monitoringConfig({ include: [] }),
      );
      monitoring.unregisterServer(serverId);

      await monitoring.collectContainerMetrics(serverId);

      expect(remoteExec.execAsyncRemote).not.toHaveBeenCalled();
    });
  });

  describe('metrics queries', () => {
    async function seedServerMetrics(serverId: string) {
      const base = {
        cpuModel: 'GenuineIntel Xeon',
        cpuCores: 2,
        cpuPhysicalCores: 1,
        cpuSpeed: 2394.454,
        os: 'Ubuntu 22.04.3 LTS',
        distro: 'Ubuntu 22.04.3 LTS',
        kernel: '5.15.0-91-generic',
        arch: 'x86_64',
        memUsedGB: 6,
        memTotal: 8,
        uptime: 123456,
        diskUsed: 55.5,
        totalDisk: 100,
        networkIn: 101,
        networkOut: 51,
        serverId,
      };
      await ctx.db.insert(serverMetric).values([
        {
          ...base,
          timestamp: '2026-07-24T10:00:00.000Z',
          cpu: 10.5,
          memUsed: 40,
        },
        {
          ...base,
          timestamp: '2026-07-24T10:01:00.000Z',
          cpu: 20.25,
          memUsed: 50,
        },
        {
          ...base,
          timestamp: '2026-07-24T10:02:00.000Z',
          cpu: 15.686,
          memUsed: 60,
        },
      ]);
    }

    it('returns the last N samples ascending with the agent string formatting', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      await seedServerMetrics(serverId);

      const metrics = await monitoring.getServerMetrics(ownerCtx, {
        serverId,
        limit: '2',
      });

      expect(metrics.map((m) => m.timestamp)).toEqual([
        '2026-07-24T10:01:00.000Z',
        '2026-07-24T10:02:00.000Z',
      ]);
      expect(metrics[1]).toEqual({
        cpu: '15.69',
        cpuModel: 'GenuineIntel Xeon',
        cpuCores: 2,
        cpuPhysicalCores: 1,
        cpuSpeed: 2394.454,
        os: 'Ubuntu 22.04.3 LTS',
        distro: 'Ubuntu 22.04.3 LTS',
        kernel: '5.15.0-91-generic',
        arch: 'x86_64',
        memUsed: '60.00',
        memUsedGB: '6.00',
        memTotal: '8.00',
        uptime: 123456,
        diskUsed: '55.50',
        totalDisk: '100.00',
        networkIn: '101.00',
        networkOut: '51.00',
        timestamp: '2026-07-24T10:02:00.000Z',
      });
    });

    it('returns everything ascending for limit=all and defaults bad limits to 50', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      await seedServerMetrics(serverId);

      const all = await monitoring.getServerMetrics(ownerCtx, {
        serverId,
        limit: 'all',
      });
      expect(all).toHaveLength(3);
      expect(all[0].timestamp).toBe('2026-07-24T10:00:00.000Z');

      const bad = await monitoring.getServerMetrics(ownerCtx, {
        serverId,
        limit: 'bananas',
      });
      expect(bad).toHaveLength(3);
    });

    it('matches container metrics by exact name or swarm task suffix', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      const record = (name: string, timestamp: string) => ({
        timestamp,
        containerId: 'abc123',
        containerName: name,
        metrics: { timestamp, Name: name },
        serverId,
      });
      await ctx.db
        .insert(containerMetric)
        .values([
          record('web', '2026-07-24T10:01:00.000Z'),
          record('web.1.xyz', '2026-07-24T10:00:00.000Z'),
          record('other', '2026-07-24T10:02:00.000Z'),
        ]);

      const metrics = await monitoring.getContainerMetrics(ownerCtx, {
        serverId,
        appName: '/web',
      });
      expect(metrics.map((m) => (m as { Name: string }).Name)).toEqual([
        'web.1.xyz',
        'web',
      ]);

      // An empty appName is a caller who has not said which service,
      // and the service seam refuses it the same way the DTO does over HTTP —
      // including the "/" that the leading-slash strip turns back into one.
      await expect(
        monitoring.getContainerMetrics(ownerCtx, { serverId, appName: '' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        monitoring.getContainerMetrics(ownerCtx, { serverId, appName: '/' }),
      ).rejects.toThrow(/appName is required/);
    });

    it('rejects reads on a server outside the caller organization', async () => {
      const { serverId, ownerSession } = await setUpOwnerWithServer();
      const secondOrg = await createOrganization(
        httpServer,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      await expect(
        monitoring.getServerMetrics(
          permissionCtx(ownerSession.id, secondOrgId),
          { serverId },
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('cleanup', () => {
    it('prunes rows older than the retention window for that server only', async () => {
      const { ownerCtx, serverId } = await setUpOwnerWithServer();
      const key = await sshKeys.create(ownerCtx, { name: 'other-key' });
      const other = await servers.create(ownerCtx, {
        name: 'worker-2',
        ipAddress: '203.0.113.11',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });

      const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
      const fresh = new Date().toISOString();
      const sample = (sid: string, timestamp: string) => ({
        timestamp,
        cpu: 1,
        cpuModel: '',
        cpuCores: 1,
        cpuPhysicalCores: 1,
        cpuSpeed: 0,
        os: '',
        distro: '',
        kernel: '',
        arch: '',
        memUsed: 0,
        memUsedGB: 0,
        memTotal: 0,
        uptime: 0,
        diskUsed: 0,
        totalDisk: 0,
        networkIn: 0,
        networkOut: 0,
        serverId: sid,
      });
      await ctx.db
        .insert(serverMetric)
        .values([
          sample(serverId, old),
          sample(serverId, fresh),
          sample(other.serverId, old),
        ]);
      await ctx.db.insert(containerMetric).values([
        {
          timestamp: old,
          containerId: 'a',
          containerName: 'web',
          metrics: {},
          serverId,
        },
        {
          timestamp: fresh,
          containerId: 'a',
          containerName: 'web',
          metrics: {},
          serverId,
        },
      ]);

      await monitoring.cleanupMetrics(serverId, 2);

      const serverRows = await ctx.db.select().from(serverMetric);
      expect(serverRows.map((r) => [r.serverId, r.timestamp]).sort()).toEqual(
        [
          [serverId, fresh],
          [other.serverId, old],
        ].sort(),
      );
      const containerRows = await ctx.db.select().from(containerMetric);
      expect(containerRows).toHaveLength(1);
      expect(containerRows[0].timestamp).toBe(fresh);
    });
  });

  // Which *end* of the log each mode reads, and the tail-reading that answers
  // both, are covered against real files a chunk at a time in
  // access-log.service.spec.ts — none of it needs a database. What is worth one
  // check here is that the service Nest hands the controller reads a file the
  // same way.
  describe('access log reading', () => {
    const line = (fields: Record<string, unknown>) =>
      JSON.stringify({
        ServiceName: 'web@docker',
        StartUTC: '2024-08-25T04:34:37.306691884Z',
        RequestHost: 'app.example.com',
        DownstreamStatus: 200,
        time: '2024-08-25T04:34:37Z',
        ...fields,
      });

    it('reads only valid non-dashboard lines, in both modes', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-logs-'));
      const logPath = path.join(dir, 'access.log');
      const first = line({ RequestPath: '/one' });
      const last = line({ RequestPath: '/two' });
      fs.writeFileSync(
        logPath,
        [
          first,
          'not json',
          line({ ServiceName: 'cloudgate-service-app@file' }),
          last,
          '',
        ].join('\n'),
      );

      // No range: the newest lines, capped, in file order — never the oldest.
      expect(await accessLog.readAccessLog(undefined, logPath)).toBe(
        `${first}\n${last}\n`,
      );

      // A range: the lines inside it, streamed rather than the whole file read
      // into a string.
      expect(
        await accessLog.readAccessLog(
          { start: '2024-08-01T00:00:00Z', end: '2024-09-01T00:00:00Z' },
          logPath,
        ),
      ).toBe(`${first}\n${last}\n`);
      expect(
        await accessLog.readAccessLog(
          { start: '2025-01-01T00:00:00Z', end: '2025-02-01T00:00:00Z' },
          logPath,
        ),
      ).toBe('');

      expect(
        await accessLog.readAccessLog(undefined, path.join(dir, 'missing.log')),
      ).toBeNull();
    });
  });

  // The route's body is the filter. `search` and `method` have to survive the
  // zod DTO (an unknown key is stripped, not rejected, so a filter missing
  // from the schema silently widens the answer) and reach the parser.
  describe('POST /monitoring/requests/logs', () => {
    const line = (fields: Record<string, unknown>) =>
      JSON.stringify({
        ServiceName: 'shop-web@docker',
        StartUTC: '2024-08-25T04:34:37.306691884Z',
        time: '2024-08-25T04:34:37Z',
        RequestHost: 'shop.example.com',
        RequestPath: '/health',
        RequestMethod: 'GET',
        DownstreamStatus: 200,
        ...fields,
      });

    const accessLogLines = [
      line({ RequestMethod: 'GET', RequestPath: '/api/checkout' }),
      line({
        RequestMethod: 'POST',
        RequestPath: '/api/checkout',
        DownstreamStatus: 500,
      }),
      line({ RequestMethod: 'POST', RequestPath: '/health' }),
      line({ RequestHost: 'api.example.com' }),
    ].join('\n');

    async function readLogs(cookie: string, body: Record<string, unknown>) {
      const res = await request(httpServer)
        .post('/monitoring/requests/logs')
        .set('Cookie', cookie)
        .send({
          dateRange: {
            start: '2024-08-01T00:00:00Z',
            end: '2024-09-01T00:00:00Z',
          },
          ...body,
        });
      expect(res.status).toBe(200);
      return res.body as {
        data: { RequestMethod: string; RequestPath: string }[];
        totalCount: number;
      };
    }

    it('filters by method and searches the path when no host matches', async () => {
      const { ownerSession } = await setUpOwnerWithServer();
      jest.spyOn(accessLog, 'readWindow').mockResolvedValue({
        raw: accessLogLines,
        fromOffset: 0,
        bytesRead: accessLogLines.length,
        bytesIndexed: 0,
      });

      const posts = await readLogs(ownerSession.cookie, { method: ['POST'] });
      expect(posts.totalCount).toBe(2);
      expect(posts.data.map((l) => l.RequestMethod)).toEqual(['POST', 'POST']);

      const onCheckout = await readLogs(ownerSession.cookie, {
        search: '/api/checkout',
        method: ['POST'],
        status: ['server'],
      });
      expect(onCheckout.totalCount).toBe(1);
      expect(onCheckout.data[0].RequestPath).toBe('/api/checkout');
    });

    // Rotation bounds the file, which means a window can name hours the log no
    // longer has. The route has to hand that fact to the screen rather than
    // present the surviving rows as the whole answer.
    it('tells the caller how far back the log still goes, when it does not reach', async () => {
      const { ownerSession } = await setUpOwnerWithServer();
      jest.spyOn(accessLog, 'readWindow').mockResolvedValue({
        raw: '',
        fromOffset: 0,
        bytesRead: 0,
        bytesIndexed: 0,
        retainedFrom: '2024-08-25T04:00:00Z',
      });

      const res = await request(httpServer)
        .post('/monitoring/requests/logs')
        .set('Cookie', ownerSession.cookie)
        .send({
          dateRange: {
            start: '2020-01-01T00:00:00Z',
            end: '2024-09-01T00:00:00Z',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: [],
        totalCount: 0,
        retainedFrom: '2024-08-25T04:00:00Z',
      });
    });

    it('still answers a host term with host rows only', async () => {
      const { ownerSession } = await setUpOwnerWithServer();
      jest.spyOn(accessLog, 'readWindow').mockResolvedValue({
        raw: accessLogLines,
        fromOffset: 0,
        bytesRead: accessLogLines.length,
        bytesIndexed: 0,
      });

      const byHost = await readLogs(ownerSession.cookie, { search: 'api.' });
      expect(byHost.totalCount).toBe(1);
      expect(byHost.data[0].RequestPath).toBe('/health');
    });

    // #1342: this route answers the platform host's rows too, so it hides
    // query values as `GET /monitoring/requests` does; the file is untouched.
    it('hides every query value, keeps the names, and searches the path hidden', async () => {
      const { ownerSession } = await setUpOwnerWithServer();
      const raw = [
        line({ RequestPath: '/reset?token=abc&next=/home' }),
        line({ RequestPath: '/health' }),
      ].join('\n');
      jest.spyOn(accessLog, 'readWindow').mockResolvedValue({
        raw,
        fromOffset: 0,
        bytesRead: raw.length,
        bytesIndexed: 0,
      });

      const all = await readLogs(ownerSession.cookie, {});
      expect(all.data.map((l) => l.RequestPath).sort()).toEqual([
        '/health',
        '/reset?token=***&next=***',
      ]);

      const byValue = await readLogs(ownerSession.cookie, { search: 'abc' });
      expect(byValue.totalCount).toBe(0);
    });
  });

  describe('HTTP surface', () => {
    it('round-trips setup and the metrics endpoints', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();

      const setup = await request(httpServer)
        .post(`/monitoring/servers/${serverId}/setup`)
        .set('Cookie', ownerSession.cookie)
        .send({ metricsConfig: monitoringConfig() });
      expect(setup.status).toBe(200);
      // On the wire as well as out of the method: nothing between the
      // service and the response re-attaches the value.
      expect(JSON.stringify(setup.body)).not.toContain('metrics-token-1');
      expect(
        (setup.body as { metricsConfig: { server: { hasToken: boolean } } })
          .metricsConfig.server.hasToken,
      ).toBe(true);
      monitoring.unregisterServer(serverId);

      await ctx.db.insert(serverMetric).values({
        timestamp: '2026-07-24T10:00:00.000Z',
        cpu: 10.5,
        cpuModel: 'x',
        cpuCores: 1,
        cpuPhysicalCores: 1,
        cpuSpeed: 0,
        os: 'linux',
        distro: 'linux',
        kernel: 'k',
        arch: 'a',
        memUsed: 40,
        memUsedGB: 1,
        memTotal: 2,
        uptime: 1,
        diskUsed: 0,
        totalDisk: 0,
        networkIn: 0,
        networkOut: 0,
        serverId,
      });

      const metrics = await request(httpServer)
        .get('/monitoring/metrics')
        .query({ serverId, limit: 'all' })
        .set('Cookie', ownerSession.cookie);
      expect(metrics.status).toBe(200);
      expect(metrics.body).toHaveLength(1);
      expect((metrics.body as { cpu: string }[])[0].cpu).toBe('10.50');

      // appName is required, so an empty one is refused by validation
      // rather than answered with an empty list and a 200.
      const containers = await request(httpServer)
        .get('/monitoring/metrics/containers')
        .query({ serverId, appName: '' })
        .set('Cookie', ownerSession.cookie);
      expect(containers.status).toBe(400);

      // Validation, and the one refusal the token fix removed. `token` is optional on
      // this schema now, member for member with `admin/dto/admin.dto.ts` — the
      // console declares **one** `MetricsConfigInput` for both routes on that
      // ground, and `toMetricsConfig` omits the field for a config it was not
      // shown the value of. A required `token` refused exactly that body.
      const omittedToken = await request(httpServer)
        .post(`/monitoring/servers/${serverId}/setup`)
        .set('Cookie', ownerSession.cookie)
        .send({ metricsConfig: withoutToken(monitoringConfig()) });
      expect(omittedToken.status).toBe(200);
      monitoring.unregisterServer(serverId);

      const badSetup = await request(httpServer)
        .post(`/monitoring/servers/${serverId}/setup`)
        .set('Cookie', ownerSession.cookie)
        .send({
          metricsConfig: {
            ...monitoringConfig(),
            server: { ...monitoringConfig().server, refreshRate: 1 },
          },
        });
      expect(badSetup.status).toBe(400);
    });
  });

  // Collection includes a container when the include entry is a *substring*
  // of its name, so the include list is normally the service's human name
  // ("redis") while the stored container_name is the swarm task
  // ("redis-12sp3x.1.<task-id>"). The read has to resolve the one back to
  // the other, or the samples are write-only.
  describe('GET /monitoring/metrics/containers', () => {
    async function seedContainerSamples(
      serverId: string,
      samples: [name: string, timestamp: string][],
    ) {
      await ctx.db.insert(containerMetric).values(
        samples.map(([containerName, timestamp]) => ({
          timestamp,
          containerId: containerName.slice(0, 12),
          containerName,
          metrics: { timestamp, Name: containerName },
          serverId,
        })),
      );
    }

    async function readContainerMetrics(
      cookie: string,
      query: { serverId: string; appName?: string; limit?: string },
    ) {
      const res = await request(httpServer)
        .get('/monitoring/metrics/containers')
        .query(query)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      return (res.body as { Name: string; timestamp: string }[]).map((m) => [
        m.Name,
        m.timestamp,
      ]);
    }

    it('returns the swarm task samples collected under a substring include entry', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const task = 'redis-12sp3x.1.kyc0lqth6ncv0zuarpvdcno09';
      await seedContainerSamples(serverId, [
        [task, '2026-07-24T10:00:00.000Z'],
        [task, '2026-07-24T10:00:10.000Z'],
      ]);

      const samples = await readContainerMetrics(ownerSession.cookie, {
        serverId,
        appName: 'redis',
      });

      expect(samples).toEqual([
        [task, '2026-07-24T10:00:00.000Z'],
        [task, '2026-07-24T10:00:10.000Z'],
      ]);
    });

    it('keeps another container that merely contains the name out of the chart', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      // `include: ["redis"]` collects both of these by substring.
      const redis = 'redis-12sp3x.1.kyc0lqth6ncv0zuarpvdcno09';
      const unrelated =
        'session-redis-cache-9kd2la.1.b7qz1vsx4m3pnw0aejtu6ghlk';
      await seedContainerSamples(serverId, [
        [redis, '2026-07-24T10:00:00.000Z'],
        [unrelated, '2026-07-24T10:00:05.000Z'],
        [redis, '2026-07-24T10:00:10.000Z'],
      ]);

      const samples = await readContainerMetrics(ownerSession.cookie, {
        serverId,
        appName: 'redis',
      });

      expect(samples).toEqual([
        [redis, '2026-07-24T10:00:00.000Z'],
        [redis, '2026-07-24T10:00:10.000Z'],
      ]);
    });

    it('draws both replicas of one service as a single series', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      // Collection keeps the first container per service each tick, so which
      // replica gets sampled can flip between ticks; the chart is the service.
      const first = 'redis-12sp3x.1.kyc0lqth6ncv0zuarpvdcno09';
      const second = 'redis-12sp3x.2.p3wnd8fjq1x5t0zveb7ocmi4a';
      await seedContainerSamples(serverId, [
        [first, '2026-07-24T10:00:00.000Z'],
        [second, '2026-07-24T10:00:10.000Z'],
        [first, '2026-07-24T10:00:20.000Z'],
      ]);

      const samples = await readContainerMetrics(ownerSession.cookie, {
        serverId,
        appName: 'redis',
      });

      expect(samples).toEqual([
        [first, '2026-07-24T10:00:00.000Z'],
        [second, '2026-07-24T10:00:10.000Z'],
        [first, '2026-07-24T10:00:20.000Z'],
      ]);
    });

    it('still reads a service by its own generated name', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const task = 'redis-12sp3x.1.kyc0lqth6ncv0zuarpvdcno09';
      await seedContainerSamples(serverId, [
        [task, '2026-07-24T10:00:00.000Z'],
      ]);

      expect(
        await readContainerMetrics(ownerSession.cookie, {
          serverId,
          appName: 'redis-12sp3x',
        }),
      ).toEqual([[task, '2026-07-24T10:00:00.000Z']]);
    });

    /**
     * Three different things used to be one answer — `[]` with a 200:
     * "you did not say which service", "that name is a typo", and "that
     * service has no samples in this window". The first two are refusals now,
     * and each names the thing that is wrong; `[]` is left meaning only the
     * third, which is the one thing it can honestly mean.
     */
    describe('what an empty answer is allowed to mean', () => {
      async function read(cookie: string, query: Record<string, string>) {
        return request(httpServer)
          .get('/monitoring/metrics/containers')
          .query(query)
          .set('Cookie', cookie);
      }

      it('refuses a call with no appName at all, and names the parameter', async () => {
        const { ownerSession, serverId } = await setUpOwnerWithServer();
        await seedContainerSamples(serverId, [
          ['redis-12sp3x.1.kyc0', '2026-07-24T10:00:00.000Z'],
        ]);

        const res = await read(ownerSession.cookie, { serverId });
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toContain('appName');
      });

      it('refuses a name this host has never collected anything under', async () => {
        const { ownerSession, serverId } = await setUpOwnerWithServer();
        await seedContainerSamples(serverId, [
          ['redis-12sp3x.1.kyc0', '2026-07-24T10:00:00.000Z'],
        ]);

        const res = await read(ownerSession.cookie, {
          serverId,
          appName: 'not-a-real-container',
        });
        expect(res.status).toBe(400);
        expect((res.body as { message: string }).message).toContain(
          'not-a-real-container',
        );
      });

      /**
       * The refusal above is right about a typo and was wrong about the
       * other name that resolves to nothing: one the operator put in **both**
       * lists, which collection never samples because an exclusion is checked
       * first and beats an inclusion. `resolveServiceName` cannot tell the two
       * apart — neither has a stored row — so the sentence had to learn to,
       * from the config. `container-metrics-refusal.spec.ts` pins the sentence
       * itself; this pins that the route gets the target's config to it.
       *
       * The config is written straight onto the row rather than through
       * `setupMonitoring`, because what is under test is the read and
       * registering collection jobs is not part of it.
       */
      it('explains an excluded name by the exclusion, not by "nothing matches"', async () => {
        const { ownerSession, serverId } = await setUpOwnerWithServer();
        await seedContainerSamples(serverId, [
          ['redis-12sp3x.1.kyc0', '2026-07-24T10:00:00.000Z'],
        ]);
        await ctx.db
          .update(server)
          .set({
            metricsConfig: {
              ...defaultMetricsConfig,
              containers: {
                refreshRate: 10,
                services: { include: ['app-nk3zbo'], exclude: ['app-nk3zbo'] },
              },
            },
          })
          .where(eq(server.serverId, serverId));

        const res = await read(ownerSession.cookie, {
          serverId,
          appName: 'app-nk3zbo',
        });

        expect(res.status).toBe(400);
        const { message } = res.body as { message: string };
        expect(message).toContain('exclude list');
        expect(message).toContain('an exclusion beats an inclusion');
        // The two causes that are false for this name. The container it names
        // may well be running; nothing here is entitled to say it is not.
        expect(message).not.toContain('nothing running here matches that name');
        expect(message).not.toContain('has not stored its first sample yet');
      });

      it('still answers [] for a service whose samples are all outside the window', async () => {
        const { ownerSession, serverId } = await setUpOwnerWithServer();
        await seedContainerSamples(serverId, [
          ['redis-12sp3x.1.kyc0', '2026-07-24T10:00:00.000Z'],
        ]);

        const res = await read(ownerSession.cookie, {
          serverId,
          appName: 'redis',
          start: '2026-07-25T00:00:00Z',
        });
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
      });
    });

    /**
     * The name lookup is a substring over every series sampled on the
     * host, so the best match could be a Service the caller is not entitled
     * to — or, on the platform host, another organization's. The read now
     * answers from the best series the caller may read (the container gate,
     * ADR-0008), and a series it may not read is treated as absent: the same
     * 400 as a name nothing matched, so the refusal is no probe.
     */
    describe('answers only from series the caller may read', () => {
      /** A Project, an Environment and one Application per `appName`. */
      async function createApplications(
        creator: ReturnType<typeof permissionCtx>,
        appNames: string[],
      ) {
        const project = await ctx.app
          .get(ProjectsService)
          .create(creator, { name: 'shop' });
        const environment = await ctx.app
          .get(EnvironmentsService)
          .create(creator, {
            name: 'production',
            projectId: project.projectId,
            // The organization has a Server, so the target is asked for
            // these series are read whatever it is.
            deployTarget: { kind: 'platform-host' },
          });
        const created: Awaited<ReturnType<ApplicationsService['create']>>[] =
          [];
        for (const appName of appNames) {
          created.push(
            await ctx.app.get(ApplicationsService).create(creator, {
              name: appName,
              appName,
              environmentId: environment.environmentId,
            }),
          );
        }
        return created;
      }

      /** A base member of the owner's organization, entitled to `serviceIds`. */
      async function entitledMember(
        ownerCookie: string,
        organizationId: string,
        serviceIds: string[],
      ) {
        const invitee = await signUpMember(httpServer, ownerCookie);
        await ctx.db
          .update(member)
          .set({ accessedServices: serviceIds })
          .where(
            and(
              eq(member.userId, invitee.id),
              eq(member.organizationId, organizationId),
            ),
          );
        return invitee.cookie;
      }

      async function read(cookie: string, query: Record<string, string>) {
        return request(httpServer)
          .get('/monitoring/metrics/containers')
          .query(query)
          .set('Cookie', cookie);
      }

      const A_TASK = 'a-x1y2z3.1.t';
      const B_TASK = 'x1-b4c5d6.1.t';

      it("skips a better match the member is not entitled to, and reads their own Service's", async () => {
        const { ownerSession, ownerCtx, organizationId, serverId } =
          await setUpOwnerWithServer();
        const [appA] = await createApplications(ownerCtx, [
          'a-x1y2z3',
          'x1-b4c5d6',
        ]);
        const memberCookie = await entitledMember(
          ownerSession.cookie,
          organizationId,
          [appA.applicationId],
        );
        await seedContainerSamples(serverId, [
          [A_TASK, '2026-07-24T10:00:00.000Z'],
          [B_TASK, '2026-07-24T10:00:05.000Z'],
        ]);

        // `x1` ranks B first — it starts `x1-` — and A last, as a substring.
        const byOwner = await read(ownerSession.cookie, {
          serverId,
          appName: 'x1',
        });
        expect((byOwner.body as { Name: string }[]).map((m) => m.Name)).toEqual(
          [B_TASK],
        );

        const byMember = await read(memberCookie, { serverId, appName: 'x1' });
        expect(byMember.status).toBe(200);
        expect(
          (byMember.body as { Name: string }[]).map((m) => m.Name),
        ).toEqual([A_TASK]);
      });

      it('refuses a member a name only another Service matches, exactly as it refuses a name nothing matches', async () => {
        const { ownerSession, ownerCtx, organizationId, serverId } =
          await setUpOwnerWithServer();
        const [appA] = await createApplications(ownerCtx, [
          'a-x1y2z3',
          'x1-b4c5d6',
        ]);
        const memberCookie = await entitledMember(
          ownerSession.cookie,
          organizationId,
          [appA.applicationId],
        );
        await seedContainerSamples(serverId, [
          [A_TASK, '2026-07-24T10:00:00.000Z'],
          [B_TASK, '2026-07-24T10:00:05.000Z'],
        ]);

        const unreadable = await read(memberCookie, {
          serverId,
          appName: 'b4c5',
        });
        const absent = await read(memberCookie, {
          serverId,
          appName: 'q7r8',
        });

        expect(unreadable.status).toBe(400);
        expect(absent.status).toBe(400);
        // The same sentence, less the name each one quotes back.
        expect(
          (unreadable.body as { message: string }).message.replace('b4c5', ''),
        ).toBe(
          (absent.body as { message: string }).message.replace('q7r8', ''),
        );
      });

      it('reads an unmanaged series to an owner and refuses it to a base member', async () => {
        const { ownerSession, organizationId, serverId } =
          await setUpOwnerWithServer();
        const memberCookie = await entitledMember(
          ownerSession.cookie,
          organizationId,
          [],
        );
        const task = 'redis-12sp3x.1.t';
        await seedContainerSamples(serverId, [
          [task, '2026-07-24T10:00:00.000Z'],
        ]);

        // No Service is called `redis-12sp3x` or `redis`, so the series is an
        // unmanaged container's: machine-level Docker access, which a base
        // member (`docker: []`) does not hold.
        const byMember = await read(memberCookie, {
          serverId,
          appName: 'redis',
        });
        expect(byMember.status).toBe(400);

        const byOwner = await read(ownerSession.cookie, {
          serverId,
          appName: 'redis',
        });
        expect(byOwner.status).toBe(200);
        expect((byOwner.body as { Name: string }[]).map((m) => m.Name)).toEqual(
          [task],
        );
      });

      /**
       * The platform host, decided per series rather than per target
       * (ADR-0067, #1336). Its branch used to take instance authority before
       * any series was resolved, so a second Organization's owner was refused
       * their own Service's samples with a 403, and the instance owner was
       * refused that Service by entitlement and told it had "never been
       * sampled". A managed series now takes entitlement to its Service, in
       * its own Organization; an unmanaged or `cloudgate-*` one keeps machine
       * access plus instance authority.
       */
      describe('on the platform host', () => {
        const OWN = 'own-k3m4n5.1.t';
        const RIVAL = 'rival-p6q7r8.1.t';
        const SIDECAR = 'redis-12sp3x.1.t';
        const PLATFORM = 'cloudgate-traefik.1.t';

        /** The instance owner, a second Organization's owner, and one
         * platform-host Application in each; every series on the host. */
        async function twoOrganizationsOnTheHost() {
          const { ownerSession, ownerCtx } = await setUpOwnerWithServer();
          await createApplications(ownerCtx, ['own-k3m4n5']);
          const mallory = await secondOrganizationOwnerOf(
            httpServer,
            ctx.db,
            ownerSession.cookie,
          );
          const [rival] = await createApplications(
            permissionCtx(mallory.id, mallory.organizationId),
            ['rival-p6q7r8'],
          );
          // `null` is the platform host's series (the web server's).
          await ctx.db.insert(containerMetric).values(
            [OWN, RIVAL, SIDECAR, PLATFORM].map((containerName) => ({
              timestamp: '2026-07-24T10:00:00.000Z',
              containerId: containerName.slice(0, 12),
              containerName,
              metrics: { Name: containerName },
              serverId: null,
            })),
          );
          return { ownerSession, mallory, rival };
        }

        const names = (res: { body: unknown }) =>
          (res.body as { Name: string }[]).map((m) => m.Name);

        it("reads a second Organization's owner its own Service's series", async () => {
          const { mallory } = await twoOrganizationsOnTheHost();

          const own = await read(mallory.cookie, { appName: 'rival-p6q7r8' });
          expect(own.status).toBe(200);
          expect(names(own)).toEqual([RIVAL]);
        });

        it("answers the instance owner another Organization's series exactly as a name nothing matches", async () => {
          const { ownerSession } = await twoOrganizationsOnTheHost();

          const foreign = await read(ownerSession.cookie, {
            appName: 'rival-p6q7r8',
          });
          const absent = await read(ownerSession.cookie, {
            appName: 'nobod-y1z2w3',
          });

          expect(foreign.status).toBe(400);
          expect(absent.status).toBe(400);
          expect(refusal(foreign).replace('rival-p6q7r8', '')).toBe(
            refusal(absent).replace('nobod-y1z2w3', ''),
          );
          // The series has a sample; the answer may not say otherwise.
          expect(refusal(foreign)).not.toContain('ever been sampled');
          expect(refusal(foreign)).toContain('No container you can read');

          const own = await read(ownerSession.cookie, {
            appName: 'own-k3m4n5',
          });
          expect(own.status).toBe(200);
          expect(names(own)).toEqual([OWN]);
        });

        it('answers a member without the Service the neutral 400, not a 403', async () => {
          const { mallory } = await twoOrganizationsOnTheHost();
          const eve = await signUpMember(httpServer, mallory.cookie, {
            email: 'eve@example.com',
            name: 'Eve',
          });

          const unread = await read(eve.cookie, { appName: 'rival-p6q7r8' });
          const absent = await read(eve.cookie, { appName: 'nobod-y1z2w3' });

          expect(unread.status).toBe(400);
          expect(absent.status).toBe(400);
          expect(refusal(unread).replace('rival-p6q7r8', '')).toBe(
            refusal(absent).replace('nobod-y1z2w3', ''),
          );
          expect(refusal(unread)).not.toContain('ever been sampled');
        });

        it('reads it to that member once they are entitled to the Service', async () => {
          const { mallory, rival } = await twoOrganizationsOnTheHost();
          const eveCookie = await entitledMember(
            mallory.cookie,
            mallory.organizationId,
            [rival.applicationId],
          );

          const own = await read(eveCookie, { appName: 'rival-p6q7r8' });
          expect(own.status).toBe(200);
          expect(names(own)).toEqual([RIVAL]);
        });

        it('keeps an unmanaged and a cloudgate-* series behind instance authority', async () => {
          const { ownerSession, mallory } = await twoOrganizationsOnTheHost();

          for (const appName of ['redis-12sp3x', 'cloudgate-traefik']) {
            // A second Organization's owner holds `docker` in their own
            // Organization, and that is not enough on the shared machine.
            const refused = await read(mallory.cookie, { appName });
            expect(refused.status).toBe(400);
            expect(refusal(refused)).not.toContain('ever been sampled');
          }

          const sidecar = await read(ownerSession.cookie, {
            appName: 'redis-12sp3x',
          });
          expect(sidecar.status).toBe(200);
          expect(names(sidecar)).toEqual([SIDECAR]);

          const traefik = await read(ownerSession.cookie, {
            appName: 'cloudgate-traefik',
          });
          expect(traefik.status).toBe(200);
          expect(names(traefik)).toEqual([PLATFORM]);
        });

        it("names the platform host's exclude list to instance authority only", async () => {
          const { ownerSession, mallory } = await twoOrganizationsOnTheHost();
          await ctx.db.delete(webServerSettings);
          await ctx.db.insert(webServerSettings).values({
            metricsConfig: {
              ...defaultMetricsConfig,
              containers: {
                refreshRate: 10,
                services: { include: ['shop'], exclude: ['shop-web.1'] },
              },
            },
          });

          const byInstance = await read(ownerSession.cookie, {
            appName: 'shop-web',
          });
          expect(byInstance.status).toBe(400);
          expect(refusal(byInstance)).toContain('"shop-web.1"');

          const byTenant = await read(mallory.cookie, { appName: 'shop-web' });
          expect(byTenant.status).toBe(400);
          expect(refusal(byTenant)).not.toContain('exclude list');
          expect(refusal(byTenant)).not.toContain('shop-web.1');
        });
      });
    });
  });

  // The question an operator actually has is "what did this host do between
  // 02:00 and 03:00 last night", and until the fix the store could only be asked
  // for the last N samples — so the window had to be guessed at from the
  // Server's refresh rate and the surplus discarded in the browser.
  describe('metrics time windows', () => {
    /** Samples every 15 minutes from 01:00 to 04:00 inclusive. */
    const QUARTER_HOURS = [
      '2026-07-24T01:00:00.000Z',
      '2026-07-24T01:15:00.000Z',
      '2026-07-24T01:30:00.000Z',
      '2026-07-24T01:45:00.000Z',
      '2026-07-24T02:00:00.000Z',
      '2026-07-24T02:15:00.000Z',
      '2026-07-24T02:30:00.000Z',
      '2026-07-24T02:45:00.000Z',
      '2026-07-24T03:00:00.000Z',
      '2026-07-24T03:15:00.000Z',
      '2026-07-24T03:30:00.000Z',
      '2026-07-24T03:45:00.000Z',
      '2026-07-24T04:00:00.000Z',
    ];

    async function seedServerSamples(serverId: string, timestamps: string[]) {
      await ctx.db.insert(serverMetric).values(
        timestamps.map((timestamp) => ({
          timestamp,
          cpu: 1,
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
          serverId,
        })),
      );
    }

    async function seedContainerSamples(
      serverId: string,
      containerName: string,
      timestamps: string[],
    ) {
      await ctx.db.insert(containerMetric).values(
        timestamps.map((timestamp) => ({
          timestamp,
          containerId: 'abc123',
          containerName,
          metrics: { timestamp, Name: containerName },
          serverId,
        })),
      );
    }

    async function readServerMetrics(
      cookie: string,
      query: Record<string, string>,
    ) {
      const res = await request(httpServer)
        .get('/monitoring/metrics')
        .query(query)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      return (res.body as { timestamp: string }[]).map((m) => m.timestamp);
    }

    async function readContainerMetrics(
      cookie: string,
      query: Record<string, string>,
    ) {
      const res = await request(httpServer)
        .get('/monitoring/metrics/containers')
        .query(query)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      return (res.body as { timestamp: string }[]).map((m) => m.timestamp);
    }

    it('answers a closed window with exactly the samples inside it', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      await seedServerSamples(serverId, QUARTER_HOURS);

      expect(
        await readServerMetrics(ownerSession.cookie, {
          serverId,
          start: '2026-07-24T02:00:00Z',
          end: '2026-07-24T03:00:00Z',
        }),
      ).toEqual([
        '2026-07-24T02:00:00.000Z',
        '2026-07-24T02:15:00.000Z',
        '2026-07-24T02:30:00.000Z',
        '2026-07-24T02:45:00.000Z',
        '2026-07-24T03:00:00.000Z',
      ]);
    });

    it('leaves the other end open when only one bound is sent', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      await seedServerSamples(serverId, QUARTER_HOURS);

      expect(
        await readServerMetrics(ownerSession.cookie, {
          serverId,
          start: '2026-07-24T03:30:00Z',
        }),
      ).toEqual([
        '2026-07-24T03:30:00.000Z',
        '2026-07-24T03:45:00.000Z',
        '2026-07-24T04:00:00.000Z',
      ]);

      expect(
        await readServerMetrics(ownerSession.cookie, {
          serverId,
          end: '2026-07-24T01:30:00Z',
        }),
      ).toEqual([
        '2026-07-24T01:00:00.000Z',
        '2026-07-24T01:15:00.000Z',
        '2026-07-24T01:30:00.000Z',
      ]);
    });

    it('reads a bound written in another offset on the stored UTC scale', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      await seedServerSamples(serverId, QUARTER_HOURS);

      // 04:00+02:00 is 02:00Z, 05:00+02:00 is 03:00Z — the same window as above.
      expect(
        await readServerMetrics(ownerSession.cookie, {
          serverId,
          start: '2026-07-24T04:00:00+02:00',
          end: '2026-07-24T05:00:00+02:00',
        }),
      ).toEqual([
        '2026-07-24T02:00:00.000Z',
        '2026-07-24T02:15:00.000Z',
        '2026-07-24T02:30:00.000Z',
        '2026-07-24T02:45:00.000Z',
        '2026-07-24T03:00:00.000Z',
      ]);
    });

    it('keeps another Server’s samples out of the window', async () => {
      const { ownerCtx, ownerSession, serverId } = await setUpOwnerWithServer();
      const key = await sshKeys.create(ownerCtx, { name: 'second-key' });
      const other = await servers.create(ownerCtx, {
        name: 'worker-2',
        ipAddress: '203.0.113.11',
        port: 22,
        username: 'root',
        sshKeyId: key.sshKeyId,
      });
      await seedServerSamples(serverId, ['2026-07-24T02:00:00.000Z']);
      await seedServerSamples(other.serverId, ['2026-07-24T02:30:00.000Z']);

      expect(
        await readServerMetrics(ownerSession.cookie, {
          serverId,
          start: '2026-07-24T02:00:00Z',
          end: '2026-07-24T03:00:00Z',
        }),
      ).toEqual(['2026-07-24T02:00:00.000Z']);
    });

    it('does not silently cap a window at 50 samples, and still caps a countless read', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      // A minute apart, 60 of them: more than the ?limit= default.
      const minutes = Array.from({ length: 60 }, (_, i) =>
        new Date(Date.UTC(2026, 6, 24, 2, i)).toISOString(),
      );
      await seedServerSamples(serverId, minutes);

      const windowed = await readServerMetrics(ownerSession.cookie, {
        serverId,
        start: '2026-07-24T02:00:00Z',
        end: '2026-07-24T02:59:00Z',
      });
      expect(windowed).toEqual(minutes);

      // Unchanged for a caller that sends no window: the last 50.
      const countless = await readServerMetrics(ownerSession.cookie, {
        serverId,
      });
      expect(countless).toEqual(minutes.slice(10));
    });

    it('takes the most recent samples when a limit caps the window', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      await seedServerSamples(serverId, QUARTER_HOURS);

      expect(
        await readServerMetrics(ownerSession.cookie, {
          serverId,
          start: '2026-07-24T02:00:00Z',
          end: '2026-07-24T03:00:00Z',
          limit: '2',
        }),
      ).toEqual(['2026-07-24T02:45:00.000Z', '2026-07-24T03:00:00.000Z']);
    });

    it('windows container samples too, without changing which service is charted', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const task = 'redis-12sp3x.1.kyc0lqth6ncv0zuarpvdcno09';
      await seedContainerSamples(serverId, task, QUARTER_HOURS);
      // Collected by the same substring include entry, but never the service
      // "redis" names — and not resurrected by a window that excludes redis.
      await seedContainerSamples(
        serverId,
        'session-redis-cache-9kd2la.1.b7qz1vsx4m3pnw0aejtu6ghlk',
        ['2026-07-24T05:00:00.000Z'],
      );

      expect(
        await readContainerMetrics(ownerSession.cookie, {
          serverId,
          appName: 'redis',
          start: '2026-07-24T02:00:00Z',
          end: '2026-07-24T02:30:00Z',
        }),
      ).toEqual([
        '2026-07-24T02:00:00.000Z',
        '2026-07-24T02:15:00.000Z',
        '2026-07-24T02:30:00.000Z',
      ]);

      expect(
        await readContainerMetrics(ownerSession.cookie, {
          serverId,
          appName: 'redis',
          start: '2026-07-24T04:30:00Z',
        }),
      ).toEqual([]);
    });

    it('refuses a malformed bound instead of answering an empty window', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      await seedServerSamples(serverId, QUARTER_HOURS);

      const res = await request(httpServer)
        .get('/monitoring/metrics')
        .query({ serverId, start: 'last-night' })
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toMatch(
        /start.*last-night/,
      );

      const containers = await request(httpServer)
        .get('/monitoring/metrics/containers')
        .query({ serverId, appName: 'redis', end: '24/07/2026' })
        .set('Cookie', ownerSession.cookie);
      expect(containers.status).toBe(400);
    });

    it('refuses a window that ends before it starts', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      await seedServerSamples(serverId, QUARTER_HOURS);

      const res = await request(httpServer)
        .get('/monitoring/metrics')
        .query({
          serverId,
          start: '2026-07-24T03:00:00Z',
          end: '2026-07-24T02:00:00Z',
        })
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toMatch(
        /end .* before start/,
      );
    });

    it('reads a cross-organization window as absent, not as forbidden', async () => {
      const { ownerSession, serverId } = await setUpOwnerWithServer();
      const secondOrg = await createOrganization(
        httpServer,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      await expect(
        monitoring.getServerMetrics(
          permissionCtx(ownerSession.id, secondOrgId),
          {
            serverId,
            start: '2026-07-24T02:00:00Z',
            end: '2026-07-24T03:00:00Z',
          },
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * H-64. Three reads on this controller answer for the **platform host** — the
   * one machine every organization on the instance shares — and none of them
   * asked who the caller administers.
   *
   * `POST /monitoring/requests/logs` took no `@CurrentUser` at all and handed
   * back the platform Traefik's access log: every organization's request
   * hostnames, paths, service names and timings, from one file. The two metric
   * reads carry `@RequirePermission('monitoring', 'read')`, which the **static
   * member role holds** (`memberRole` grants `monitoring: ['read']`), and
   * `findReadableTarget` answered an absent `serverId` with the web-server
   * target before asking anything else — so a plain member read the host's CPU
   * and memory and, through `metrics/containers`, the container names of every
   * organization deployed on it.
   *
   * The decisive caller for all three is a plain member. `requests/stats`, the
   * sibling that *was* gated, is asserted alongside them: it reads the same
   * instance-wide file behind the caller's role in their *own* organization, so
   * a second organization's owner passed it, and the pair now takes one
   * boundary instead of two.
   *
   * ADR-0067 later moved `metrics/containers` off the target: its series are
   * decided one by one (see "answers only from series the caller may read"),
   * so what this block pins for it is that the platform's own series stays
   * out of a plain member's reach, answered as a name nothing matches.
   */
  describe('the platform host as a target', () => {
    /**
     * An owner of a second Organization who is not a Member of the first —
     * `test/settings/settings.e2e-spec.ts`'s fixture, which this reuses rather
     * than invents.
     *
     * The invitation is issued while the instance owner is acting *in the second
     * organization*, which is what keeps Mallory out of the first. `role:
     * 'owner'` is written directly afterwards because `updateMemberRole` refuses
     * to hand the owner role out at all. A second `/api/auth/sign-up/email` is
     * not an option: sign-up closes once the instance has an owner.
     */
    async function secondOrganizationOwner(
      ownerCookie: string,
    ): Promise<{ cookie: string }> {
      const home = await request(httpServer)
        .get('/organizations/active')
        .set('Cookie', ownerCookie);
      expect(home.status).toBe(200);
      const instanceOrganizationId = (home.body as { id: string }).id;

      const created = await createOrganization(
        httpServer,
        ctx.db,
        ownerCookie,
        { name: 'Second Org' },
      );
      expect(created.status).toBe(201);
      const organizationId = (created.body as { id: string }).id;

      const activated = await request(httpServer)
        .post('/api/auth/organization/set-active')
        .set('Cookie', ownerCookie)
        .send({ organizationId });
      expect(activated.status).toBe(200);

      const mallory = await signUpMember(httpServer, ownerCookie, {
        email: 'mallory@example.com',
        name: 'Mallory',
        role: 'admin',
      });
      await ctx.db
        .update(member)
        .set({ role: 'owner' })
        .where(eq(member.userId, mallory.id));

      const restored = await request(httpServer)
        .post('/api/auth/organization/set-active')
        .set('Cookie', ownerCookie)
        .send({ organizationId: instanceOrganizationId });
      expect(restored.status).toBe(200);

      return { cookie: mallory.cookie };
    }

    /** One access-log line per organization, so a leak is visible as a row. */
    const accessLogLines = [
      JSON.stringify({
        ServiceName: 'shop-web@docker',
        StartUTC: '2024-08-25T04:34:37.306691884Z',
        time: '2024-08-25T04:34:37Z',
        RequestHost: 'shop.tenant-a.example.com',
        RequestPath: '/checkout',
        RequestMethod: 'GET',
        DownstreamStatus: 200,
      }),
      JSON.stringify({
        ServiceName: 'billing@docker',
        StartUTC: '2024-08-25T04:35:37.306691884Z',
        time: '2024-08-25T04:35:37Z',
        RequestHost: 'billing.tenant-b.example.com',
        RequestPath: '/invoices',
        RequestMethod: 'GET',
        DownstreamStatus: 200,
      }),
    ].join('\n');

    function stubAccessLog(): void {
      jest.spyOn(accessLog, 'readWindow').mockResolvedValue({
        raw: accessLogLines,
        fromOffset: 0,
        bytesRead: accessLogLines.length,
        bytesIndexed: 0,
      });
    }

    it("refuses a plain member the platform host's request log", async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);
      const memberSession = await signUpMember(httpServer, ownerSession.cookie);
      stubAccessLog();

      const denied = await request(httpServer)
        .post('/monitoring/requests/logs')
        .set('Cookie', memberSession.cookie)
        .send({});

      expect(denied.status).toBe(403);
      expect(refusal(denied)).toBe(INSTANCE_AUTHORITY_REFUSAL);
      // Not one hostname crossed the boundary on the way to the refusal.
      expect(JSON.stringify(denied.body)).not.toContain('tenant-b');
    });

    it("refuses another organization's owner the request log and its stats", async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);
      const mallory = await secondOrganizationOwner(ownerSession.cookie);
      stubAccessLog();

      const logs = await request(httpServer)
        .post('/monitoring/requests/logs')
        .set('Cookie', mallory.cookie)
        .send({});
      expect(logs.status).toBe(403);
      expect(refusal(logs)).toBe(INSTANCE_AUTHORITY_REFUSAL);

      const stats = await request(httpServer)
        .post('/monitoring/requests/stats')
        .set('Cookie', mallory.cookie)
        .send({});
      expect(stats.status).toBe(403);
      expect(refusal(stats)).toBe(INSTANCE_AUTHORITY_REFUSAL);
    });

    it("refuses a plain member the host's own metrics", async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);
      const memberSession = await signUpMember(httpServer, ownerSession.cookie);

      const metrics = await request(httpServer)
        .get('/monitoring/metrics')
        .set('Cookie', memberSession.cookie)
        .query({ limit: 'all' });
      expect(metrics.status).toBe(403);
      expect(refusal(metrics)).toBe(INSTANCE_AUTHORITY_REFUSAL);

      // Container series are decided per series now (ADR-0067): the
      // platform's own is still behind instance authority, but the answer is
      // the neutral 400 a name nothing matches gets, not a 403 — a 403 here
      // and a 400 for an unknown name would be the oracle (ADR-0008).
      await ctx.db.insert(containerMetric).values({
        timestamp: '2026-07-24T10:00:00.000Z',
        containerId: 'cloudgate-tr',
        containerName: 'cloudgate-traefik.1.t',
        metrics: { Name: 'cloudgate-traefik.1.t' },
        serverId: null,
      });
      const containers = await request(httpServer)
        .get('/monitoring/metrics/containers')
        .set('Cookie', memberSession.cookie)
        .query({ appName: 'cloudgate', limit: 'all' });
      const absent = await request(httpServer)
        .get('/monitoring/metrics/containers')
        .set('Cookie', memberSession.cookie)
        .query({ appName: 'nobod-y1z2w3', limit: 'all' });
      expect(containers.status).toBe(400);
      expect(absent.status).toBe(400);
      expect(refusal(containers).replace('cloudgate', '')).toBe(
        refusal(absent).replace('nobod-y1z2w3', ''),
      );
      expect(JSON.stringify(containers.body)).not.toContain('traefik');
    });

    it("refuses another organization's owner the host's own metrics", async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);
      const mallory = await secondOrganizationOwner(ownerSession.cookie);

      const metrics = await request(httpServer)
        .get('/monitoring/metrics')
        .set('Cookie', mallory.cookie)
        .query({ limit: 'all' });
      expect(metrics.status).toBe(403);
      expect(refusal(metrics)).toBe(INSTANCE_AUTHORITY_REFUSAL);
    });

    /**
     * The no-op claim, asserted rather than assumed: on the single-organization
     * install `deploy/install.sh` produces, the owner and the admins keep every
     * one of these reads. A plain member is the only caller who loses one, and
     * losing it is the finding.
     */
    it("leaves the single-organization install's owner and admin exactly as they were", async () => {
      const { owner: ownerSession } = await setUpOwner(httpServer);
      const admin = await signUpMember(httpServer, ownerSession.cookie, {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        role: 'admin',
      });
      stubAccessLog();

      const byOwner = await request(httpServer)
        .post('/monitoring/requests/logs')
        .set('Cookie', ownerSession.cookie)
        .send({});
      expect(byOwner.status).toBe(200);
      expect((byOwner.body as { totalCount: number }).totalCount).toBe(2);

      const byAdmin = await request(httpServer)
        .post('/monitoring/requests/logs')
        .set('Cookie', admin.cookie)
        .send({});
      expect(byAdmin.status).toBe(200);
      expect((byAdmin.body as { totalCount: number }).totalCount).toBe(2);

      const stats = await request(httpServer)
        .post('/monitoring/requests/stats')
        .set('Cookie', admin.cookie)
        .send({});
      expect(stats.status).toBe(200);

      const metrics = await request(httpServer)
        .get('/monitoring/metrics')
        .set('Cookie', admin.cookie)
        .query({ limit: 'all' });
      expect(metrics.status).toBe(200);
      expect(metrics.body).toEqual([]);
    });
  });
});
