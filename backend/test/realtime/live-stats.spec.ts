import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Docker from 'dockerode';
import type { ContainerAccessService } from '../../src/realtime/container-access.service';
import { DockerStatsGateway } from '../../src/realtime/gateways/docker-stats.gateway';
import type { HostStatsService } from '../../src/realtime/host-stats.service';
import { liveStatsFrame } from '../../src/realtime/live-stats';
import type { WsAuthGuard } from '../../src/realtime/ws-auth.guard';
import type { WsClient } from '../../src/realtime/ws-client';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';

const STAT = {
  BlockIO: '1MB / 2MB',
  CPUPerc: '3.5%',
  Container: 'abc',
  ID: 'abc',
  MemPerc: '4%',
  MemUsage: '10MiB / 100MiB',
  Name: 'web',
  NetIO: '5kB / 6kB',
};
const DISK = {
  diskTotal: 78,
  diskUsedPercentage: 31,
  diskUsage: 24,
  diskFree: 54,
};

const FS_WRITERS = [
  'writeFile',
  'appendFile',
  'mkdir',
  'rename',
  'copyFile',
] as const;

/**
 * Every `fs.promises` call that could land bytes on disk, spied and counted —
 * the shape the per-tick rewrite took. (The sync namespace's properties cannot
 * be redefined under this transform; the empty-directory assertions beside
 * each count are what cover a sync writer.)
 */
function spyOnWrites(): () => number {
  const spies = FS_WRITERS.map((name) => jest.spyOn(fs.promises, name));
  return () => spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
}

function makeGateway() {
  // The platform root the test lanes point CLOUDGATE_DIRECTORY at: a writer
  // coming back would land its series here.
  const statsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-i528-'));
  process.env.CLOUDGATE_DIRECTORY = statsDir;
  const docker = {
    listContainers: jest
      .fn()
      .mockResolvedValue([{ Id: 'abc', State: 'running', Labels: {} }]),
  };
  const remoteExec = {
    execFileAsync: jest
      .fn()
      .mockResolvedValue({ stdout: JSON.stringify(STAT), stderr: '' }),
  };
  const hostStats = {
    collect: jest.fn().mockResolvedValue({ stat: STAT, disk: DISK }),
  };
  const gateway = new DockerStatsGateway(
    {} as WsAuthGuard,
    {} as ContainerAccessService,
    docker as unknown as Docker,
    remoteExec as unknown as RemoteExecService,
    hostStats as unknown as HostStatsService,
    60_000,
  );
  return { gateway, statsDir };
}

function openSocket() {
  const sent: string[] = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (data: string) => sent.push(data),
    close: jest.fn(),
  };
  return { ws: ws as unknown as WsClient, sent };
}

/**
 * The live card's tick read, appended, capped and rewrote five whole JSON
 * series under `monitoring/` every 1300 ms — ~127 KB per tick — for a history
 * nothing read, and left a directory per Swarm task watched. The frame is built
 * from the sample the tick just took, so a tick writes nothing at all.
 */
describe('DockerStatsGateway', () => {
  const configured = process.env.CLOUDGATE_DIRECTORY;
  afterEach(() => {
    jest.restoreAllMocks();
    if (configured === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = configured;
  });

  it('pushes the host tick it just sampled without writing a byte', async () => {
    const { gateway, statsDir } = makeGateway();
    const { ws, sent } = openSocket();
    const writes = spyOnWrites();

    await gateway.collectAndSend(ws, 'cloudgate', 'application', 'container');
    await gateway.collectAndSend(ws, 'cloudgate', 'application', 'container');

    expect(writes()).toBe(0);
    expect(fs.readdirSync(statsDir)).toEqual([]);
    expect(sent).toHaveLength(2);
    const { data } = JSON.parse(sent[1]) as {
      data: Record<string, { value: unknown } | null>;
    };
    expect(data.cpu?.value).toBe('3.5%');
    expect(data.disk?.value).toEqual(DISK);
  });

  it('pushes a container tick without leaving a directory for its task name', async () => {
    const { gateway, statsDir } = makeGateway();
    const { ws, sent } = openSocket();
    const writes = spyOnWrites();

    await gateway.collectAndSend(
      ws,
      'app-t64tnx.1.ihmnf9wytekqp9q8g6dor0a60',
      'stack',
      'container',
    );

    expect(writes()).toBe(0);
    expect(fs.readdirSync(statsDir)).toEqual([]);
    const { data } = JSON.parse(sent[0]) as {
      data: Record<string, { value: unknown } | null>;
    };
    expect(data).toEqual({
      cpu: { value: '3.5%', time: expect.any(String) as string },
      memory: {
        value: { used: '10MiB', total: '100MiB' },
        time: expect.any(String) as string,
      },
      disk: null,
      network: {
        value: { inputMb: '5kB', outputMb: '6kB' },
        time: expect.any(String) as string,
      },
      block: {
        value: { readMb: '1MB', writeMb: '2MB' },
        time: expect.any(String) as string,
      },
    });
  });
});

describe('liveStatsFrame', () => {
  it('stamps every reading of one sample with the same time', () => {
    const frame = liveStatsFrame(STAT, DISK);

    expect(frame.memory.time).toBe(frame.cpu.time);
    expect(frame.disk).toEqual({ value: DISK, time: frame.cpu.time });
    expect(frame.block.time).toBe(frame.cpu.time);
  });

  it('carries no disk reading for a container', () => {
    expect(liveStatsFrame(STAT).disk).toBeNull();
  });
});
