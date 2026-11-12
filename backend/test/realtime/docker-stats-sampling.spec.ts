import type Docker from 'dockerode';
import type { ContainerAccessService } from '../../src/realtime/container-access.service';
import {
  DockerStatsGateway,
  STATS_CLOSE,
} from '../../src/realtime/gateways/docker-stats.gateway';
import type { HostStatsService } from '../../src/realtime/host-stats.service';
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
  Name: 'traefik',
  NetIO: '5kB / 6kB',
};

/**
 * The daemon answers what Docker's own `name` filter answers: a **substring**
 * match, so asking for `traefik` hands back the platform's `cloudgate-traefik`.
 */
function makeGateway(running: Partial<Docker.ContainerInfo>[]) {
  const docker = { listContainers: jest.fn().mockResolvedValue(running) };
  const remoteExec = {
    execFileAsync: jest
      .fn()
      .mockResolvedValue({ stdout: JSON.stringify(STAT), stderr: '' }),
  };
  const gateway = new DockerStatsGateway(
    {} as WsAuthGuard,
    {} as ContainerAccessService,
    docker as unknown as Docker,
    remoteExec as unknown as RemoteExecService,
    {} as HostStatsService,
    60_000,
  );
  return { gateway, docker, remoteExec };
}

function openSocket() {
  const sent: string[] = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (data: string) => sent.push(data),
    close: jest.fn(),
  };
  return { ws: ws as unknown as WsClient, sent, close: ws.close };
}

const platformTraefik = {
  Id: 'platform1',
  Names: ['/cloudgate-traefik'],
  State: 'running',
  Labels: {},
};

/**
 * A customer's Compose called `traefik` streamed `cloudgate-traefik`'s CPU,
 * memory and network, because a tick sampled the host daemon with Docker's
 * substring `name` filter. A tick now samples exactly what the socket
 * was authorized for: the Service's own containers by their owner label, or one
 * container by its exact name.
 */
describe('DockerStatsGateway.collectAndSend', () => {
  it('samples a Compose by its exact project label, never by a name filter', async () => {
    const { gateway, docker } = makeGateway([]);
    const { ws } = openSocket();

    await gateway.collectAndSend(ws, 'traefik', 'docker-compose', 'service');

    expect(docker.listContainers).toHaveBeenCalledWith({
      filters: JSON.stringify({
        status: ['running'],
        label: ['com.docker.compose.project=traefik'],
      }),
    });
  });

  it('samples nothing on the platform host when a container name only contains the one asked for', async () => {
    const { gateway, remoteExec } = makeGateway([platformTraefik]);
    const { ws, sent, close } = openSocket();

    await gateway.collectAndSend(ws, 'traefik', 'docker-compose', 'container');

    expect(remoteExec.execFileAsync).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(close).toHaveBeenCalledWith(
      STATS_CLOSE.workloadGone,
      STATS_CLOSE.workloadGoneReason,
    );
  });

  it('samples the container whose name is exactly the one asked for', async () => {
    const { gateway, remoteExec } = makeGateway([
      platformTraefik,
      { Id: 'mine1', Names: ['/traefik'], State: 'running', Labels: {} },
    ]);
    const { ws, sent } = openSocket();

    await gateway.collectAndSend(ws, 'traefik', 'docker-compose', 'container');

    expect(remoteExec.execFileAsync).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['mine1']),
    );
    expect(sent).toHaveLength(1);
  });
});
