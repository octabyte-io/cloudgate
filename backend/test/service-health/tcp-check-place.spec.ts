import net from 'node:net';
import type { ConfigService } from '@nestjs/config';
import type { AddressInfo } from 'node:net';
import { SERVICE_TABLES } from '../../src/common/service-parent';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { server, webServerSettings } from '../../src/db/schema';
import { port as portTable } from '../../src/networking/ports/port.schema';
import type { AddressResolver } from '../../src/outbound/outbound-address';
import { OwnAddresses } from '../../src/outbound/own-addresses';
import { ServerAddressGuard } from '../../src/servers/server-address-guard';
import {
  DOMAIN_HOST_REFUSED,
  ProbeScheduler,
} from '../../src/service-health/probe-scheduler.service';
import type { ProbeTarget } from '../../src/service-health/probe-target.port';
import {
  CLOUD_SERVICE_TCP_REASON,
  NO_SERVER_ADDRESS_TCP_REASON,
  PLATFORM_HOST_FALLBACK_ADDRESS,
  PLATFORM_HOST_TCP_REASON,
  publishedPortsOf,
} from '../../src/service-health/published-ports';
import type { UptimeCheck } from '../../src/service-health/service-health.schema';
import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';

/**
 * Where a TCP Uptime check dials, for a Service with no Server.
 *
 * A `null` `serverId` used to read as the platform host everywhere, so a
 * customer's TCP check on a Service in a Cloud account, or on the Hosted
 * instance any Service without a Server, dialled a port of the customer's
 * choosing on the box Cloudgate runs on — Postgres, the backend, Docker — and
 * recorded up/down, latency and refused/timeout for it. `tcpPlaceOf` now
 * answers "nowhere" for those, which `publishedPortsOf` carries as its
 * `unavailableReason` (so the picker, the create and the turn-on refuse with
 * it) and the probe tick turns the check off with instead of dialling.
 * Self-hosted, a Service on the platform host keeps being dialled there.
 *
 * Unit level: `publishedPortsOf` and the tick's probe step take a database
 * handle, which a table-keyed double answers, and nothing here needs Postgres.
 */

const HOSTED = { isHosted: true } as InstanceMode;
const SELF_HOSTED = { isHosted: false } as InstanceMode;
const PLATFORM_IP = '198.51.100.4';
const PUBLISHED = 5432;

/** A database double: every select answers the rows given for its table. */
function dbWith(rows: Map<unknown, unknown[]>): DrizzleDB {
  const chain = (table: unknown) => {
    const answer = () => Promise.resolve(rows.get(table) ?? []);
    const link: Record<string, unknown> = {
      where: () => link,
      limit: () => link,
      orderBy: () => link,
      then: (
        onFulfilled: (value: unknown[]) => unknown,
        onRejected: (reason: unknown) => unknown,
      ) => answer().then(onFulfilled, onRejected),
    };
    return link;
  };
  return {
    select: () => ({ from: (table: unknown) => chain(table) }),
  } as unknown as DrizzleDB;
}

/** An Application placed as given, publishing {@link PUBLISHED}, on an instance whose `server_ip` is {@link PLATFORM_IP}. */
function applicationDb(place: {
  serverId: string | null;
  cloudAccountId: string | null;
  serverIp?: string;
}): DrizzleDB {
  return dbWith(
    new Map<unknown, unknown[]>([
      [SERVICE_TABLES.application.table, [place]],
      [server, [{ ipAddress: place.serverIp ?? '' }]],
      [webServerSettings, [{ serverIp: PLATFORM_IP }]],
      [portTable, [{ published: PUBLISHED, target: 5432 }]],
    ]),
  );
}

describe('publishedPortsOf, on a Service with no Server', () => {
  it('self-hosted: a Service on the platform host is dialled on its server_ip, unchanged', async () => {
    const answer = await publishedPortsOf(
      applicationDb({ serverId: null, cloudAccountId: null }),
      'application',
      'app-1',
      SELF_HOSTED,
    );

    expect(answer).toEqual({
      host: PLATFORM_IP,
      ports: [{ port: PUBLISHED, label: 'Container port 5432' }],
      unavailableReason: null,
    });
  });

  it('self-hosted: an instance with no server_ip still dials loopback, unchanged', async () => {
    const db = dbWith(
      new Map<unknown, unknown[]>([
        [SERVICE_TABLES.application.table, [{ serverId: null }]],
        [portTable, [{ published: PUBLISHED, target: 5432 }]],
      ]),
    );

    const answer = await publishedPortsOf(db, 'application', 'a', SELF_HOSTED);

    expect(answer.host).toBe(PLATFORM_HOST_FALLBACK_ADDRESS);
    expect(answer.unavailableReason).toBeNull();
  });

  it('hosted: refuses with the reason and offers no port and no host', async () => {
    const answer = await publishedPortsOf(
      applicationDb({ serverId: null, cloudAccountId: null }),
      'application',
      'app-1',
      HOSTED,
    );

    expect(answer).toEqual({
      host: null,
      ports: [],
      unavailableReason: PLATFORM_HOST_TCP_REASON,
    });
  });

  it.each([
    ['hosted', HOSTED],
    ['self-hosted', SELF_HOSTED],
  ])(
    '%s: a Service in a Cloud account has no Server to dial',
    async (_mode, mode) => {
      const answer = await publishedPortsOf(
        applicationDb({ serverId: null, cloudAccountId: 'cloud-1' }),
        'application',
        'app-1',
        mode,
      );

      expect(answer).toEqual({
        host: null,
        ports: [],
        unavailableReason: CLOUD_SERVICE_TCP_REASON,
      });
    },
  );

  it('hosted: a Compose stack on its Stack VM, whose ports its file sets, is refused too', async () => {
    const db = dbWith(
      new Map<unknown, unknown[]>([
        [
          SERVICE_TABLES.compose.table,
          [
            {
              serverId: null,
              cloudAccountId: 'cloud-1',
              sourceType: 'raw',
              composeFile: 'services:\n  db:\n    ports: ["5432:5432"]\n',
              deployedPublishedPorts: null,
            },
          ],
        ],
        [webServerSettings, [{ serverIp: PLATFORM_IP }]],
      ]),
    );

    const answer = await publishedPortsOf(db, 'compose', 'c-1', HOSTED);

    expect(answer.host).toBeNull();
    expect(answer.unavailableReason).toBe(CLOUD_SERVICE_TCP_REASON);
  });

  it('hosted: a Service on a Server is dialled on that Server’s address', async () => {
    const answer = await publishedPortsOf(
      applicationDb({
        serverId: 'srv-1',
        cloudAccountId: null,
        serverIp: '203.0.113.20',
      }),
      'application',
      'app-1',
      HOSTED,
    );

    expect(answer.host).toBe('203.0.113.20');
    expect(answer.ports).toHaveLength(1);
  });

  it('a Server with no address recorded is not answered with loopback', async () => {
    const answer = await publishedPortsOf(
      applicationDb({ serverId: 'srv-1', cloudAccountId: null, serverIp: '' }),
      'application',
      'app-1',
      SELF_HOSTED,
    );

    expect(answer.host).toBeNull();
    expect(answer.unavailableReason).toBe(NO_SERVER_ADDRESS_TCP_REASON);
  });
});

describe('ProbeScheduler, on a TCP check whose Service has no Server', () => {
  let listener: net.Server;
  let listening: number;

  beforeAll(async () => {
    listener = net.createServer((socket) => socket.end());
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
    listening = (listener.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((done) => listener.close(done));
  });

  const check = {
    uptimeCheckId: 'check-1',
    serviceType: 'application',
    applicationId: 'app-1',
    kind: 'tcp',
    port: PUBLISHED,
    timeoutSeconds: 2,
  } as unknown as UptimeCheck;

  function schedulerWith(
    db: DrizzleDB,
    mode: InstanceMode,
    serverAddresses: Pick<ServerAddressGuard, 'addressToDial'> = {
      addressToDial: (host: string) => Promise.resolve(host),
    },
  ) {
    const incidents = {
      turnOffForNoServer: jest.fn(() => Promise.resolve()),
      turnOffForUnpublishedPort: jest.fn(() => Promise.resolve()),
      recordProbe: jest.fn(() => Promise.resolve()),
    };
    // Every dial lands on the suite's listener, and is recorded.
    const tcp = jest.fn<{ host: string; port: number }, [string, number]>(
      () => ({ host: '127.0.0.1', port: listening }),
    );
    const target: ProbeTarget = { http: (url) => url, tcp };
    const absent = {} as never;
    const scheduler = new ProbeScheduler(
      db,
      incidents as never,
      absent,
      absent,
      target,
      { now: () => 0 },
      absent,
      absent,
      mode,
      serverAddresses as ServerAddressGuard,
    );
    // The tick's probe step for one due check, private on the class.
    const probing = scheduler as unknown as {
      probe(due: unknown, now: number): Promise<void>;
    };
    const probe = (due: unknown, now: number): Promise<void> =>
      probing.probe(due, now);
    return { probe, incidents, tcp };
  }

  const due = { kind: 'tcp', check, port: PUBLISHED };

  it('hosted: never dials the platform host; turns the check off with the reason', async () => {
    const { probe, incidents, tcp } = schedulerWith(
      applicationDb({ serverId: null, cloudAccountId: null }),
      HOSTED,
    );

    await probe(due, 0);

    expect(tcp).not.toHaveBeenCalled();
    expect(incidents.recordProbe).not.toHaveBeenCalled();
    expect(incidents.turnOffForNoServer).toHaveBeenCalledWith(
      'check-1',
      PUBLISHED,
      PLATFORM_HOST_TCP_REASON,
    );
  });

  it('self-hosted: a Service in a Cloud account is turned off, not dialled on the box', async () => {
    const { probe, incidents, tcp } = schedulerWith(
      applicationDb({ serverId: null, cloudAccountId: 'cloud-1' }),
      SELF_HOSTED,
    );

    await probe(due, 0);

    expect(tcp).not.toHaveBeenCalled();
    expect(incidents.turnOffForNoServer).toHaveBeenCalledWith(
      'check-1',
      PUBLISHED,
      CLOUD_SERVICE_TCP_REASON,
    );
  });

  it('self-hosted: a Service on the platform host is still probed there, unchanged', async () => {
    const { probe, incidents, tcp } = schedulerWith(
      applicationDb({ serverId: null, cloudAccountId: null }),
      SELF_HOSTED,
    );

    await probe(due, 0);

    expect(tcp).toHaveBeenCalledWith(PLATFORM_IP, PUBLISHED);
    expect(incidents.turnOffForNoServer).not.toHaveBeenCalled();
    expect(incidents.recordProbe).toHaveBeenCalledWith(
      'check-1',
      expect.objectContaining({ verdict: 'up' }),
      expect.any(Date),
    );
  });

  it('hosted: a Server name that now resolves onto the box is down, never dialled', async () => {
    const resolve = ((host: string) =>
      host === 'srv.example.com'
        ? Promise.resolve(['127.0.0.1'])
        : Promise.reject(new Error('nope'))) as AddressResolver;
    const db = applicationDb({
      serverId: 'srv-1',
      cloudAccountId: null,
      serverIp: 'srv.example.com',
    });
    const { probe, incidents, tcp } = schedulerWith(
      db,
      HOSTED,
      new ServerAddressGuard(
        HOSTED,
        resolve,
        new OwnAddresses(
          resolve,
          db,
          { get: () => undefined } as unknown as ConfigService,
          HOSTED,
        ),
      ),
    );

    await probe(due, 0);

    expect(tcp).not.toHaveBeenCalled();
    expect(incidents.recordProbe).toHaveBeenCalledWith(
      'check-1',
      { verdict: 'down', latencyMs: null, errorClass: DOMAIN_HOST_REFUSED },
      expect.any(Date),
    );
  });
});
