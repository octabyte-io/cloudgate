import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import type { SshChannelService } from '../../src/realtime/channels/ssh-channel.service';
import type { ContainerAccessService } from '../../src/realtime/container-access.service';
import {
  CONTAINER_LOGS_CLOSE,
  outputEndedReason,
  SERVICE_PRESENCE_INTERVAL_MS,
  SERVICE_REMOVED_REASON,
  ContainerLogsGateway,
} from '../../src/realtime/gateways/container-logs.gateway';
import {
  CLOSE_REASON_BYTE_LIMIT,
  LEASE_RENEWAL_INTERVAL_MS,
} from '../../src/realtime/socket-access';
import type { WsAuthGuard } from '../../src/realtime/ws-auth.guard';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ServersService } from '../../src/servers/servers.service';
import { FakeChannel } from './realtime.fixture';

/**
 * How a container's live output ends.
 *
 * `docker logs --follow` exits when the container it follows stops — a
 * restart included, measured on Docker 29 against `traefik/whoami` (exit 0,
 * no line). The SSH branch closed its socket when its channel did; the
 * platform host's pty wired `ws.on('close')` and nothing in the other
 * direction, so the socket stayed open, the 45 s keep-alive kept answering
 * for it, and the console said "Following …" over a follower that was gone.
 *
 * The Swarm shape is the other half: `docker service logs --follow` on a
 * service that `docker stack rm` removed does **not** exit (U09, pid alive
 * after `Nothing found in stack`), so there is no process event to hang the
 * close on and the gateway has to ask whether the service is still there.
 */

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  send = jest.fn<void, [string]>();
  ping = jest.fn();
  terminate = jest.fn(() => {
    this.readyState = 3;
    this.emit('close');
  });
  close = jest.fn<void, [number?, string?]>(() => {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  });
}

const request = (pathWithQuery: string): IncomingMessage =>
  ({
    url: pathWithQuery,
    headers: { host: 'localhost' },
  }) as IncomingMessage;

const auth = {
  user: { id: 'user_1' },
  session: { activeOrganizationId: 'org_1' },
};

/** What `docker service ls --format '{{.Name}}'` prints for the filter. */
const listed = (...names: string[]) =>
  Promise.resolve({
    stdout: names.map((name) => `${name}\n`).join(''),
    stderr: '',
  });

describe('ContainerLogsGateway close contract', () => {
  let ws: FakeWs;
  let channels: FakeChannel[];
  let warn: jest.SpyInstance;
  let remoteExec: { execFileAsync: jest.Mock; execRemote: jest.Mock };
  let gateway: ContainerLogsGateway;

  const follower = () => channels[0];
  const closedWith = () => ws.close.mock.calls.at(-1);

  beforeEach(() => {
    ws = new FakeWs();
    channels = [];
    const channel = () => {
      const made = new FakeChannel();
      channels.push(made);
      return made;
    };
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    remoteExec = {
      execFileAsync: jest.fn(() => listed('compose-4yyg7c_cache')),
      execRemote: jest.fn(() => listed('compose-4yyg7c_cache')),
    };
    gateway = new ContainerLogsGateway(
      {
        authenticate: jest.fn().mockResolvedValue(auth),
        assertStillAuthenticated: jest.fn().mockResolvedValue(undefined),
      } as unknown as WsAuthGuard,
      {
        findOne: jest.fn().mockResolvedValue({
          serverId: 'srv_1',
          organizationId: 'org_1',
          sshKeyId: 'key_1',
        }),
      } as unknown as ServersService,
      {
        authorizeContainer: jest.fn().mockResolvedValue(['web']),
        authorizeAppNames: jest.fn().mockResolvedValue(undefined),
      } as unknown as ContainerAccessService,
      {
        open: jest.fn(() => Promise.resolve(channel())),
      } as unknown as SshChannelService,
      { spawn: jest.fn(channel) },
      remoteExec as unknown as RemoteExecService,
      LEASE_RENEWAL_INTERVAL_MS,
    );
  });

  afterEach(() => {
    ws.close();
    warn.mockRestore();
    jest.useRealTimers();
  });

  describe.each([
    ['on a Server, over SSH', '&serverId=srv_1'],
    ['on the platform host, through a pty', ''],
  ])('%s', (_branch, serverQuery) => {
    const connect = (query = 'containerId=abc123') =>
      gateway.handleConnection(
        ws,
        request(`/docker-container-logs?${query}${serverQuery}`),
      );

    it('closes the socket saying the output ended when the follower exits', async () => {
      await connect();
      follower().emitData('Starting up on port 80\n');
      follower().emitClose(0);

      expect(closedWith()).toEqual([
        CONTAINER_LOGS_CLOSE.outputEnded,
        outputEndedReason('native'),
      ]);
    });

    it('names the service rather than a container when it followed one', async () => {
      await connect('containerId=compose-4yyg7c_cache&runType=swarm');
      follower().emitClose(1);

      expect(closedWith()).toEqual([
        CONTAINER_LOGS_CLOSE.outputEnded,
        outputEndedReason('swarm'),
      ]);
    });

    it('kills the follower when the viewer leaves, and says nothing more', async () => {
      await connect();
      ws.close();
      follower().emitClose(undefined);

      expect(follower().close).toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledTimes(1);
      expect(closedWith()).toEqual([]);
    });
  });

  describe('a Swarm service that is removed while it is followed', () => {
    const connect = (serverQuery = '') =>
      gateway.handleConnection(
        ws,
        request(
          `/docker-container-logs?containerId=compose-4yyg7c_cache&runType=swarm${serverQuery}`,
        ),
      );

    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('closes the socket and kills the follower once the service is gone', async () => {
      await connect();
      remoteExec.execFileAsync.mockImplementation(() => listed());
      await jest.advanceTimersByTimeAsync(SERVICE_PRESENCE_INTERVAL_MS);

      expect(closedWith()).toEqual([
        CONTAINER_LOGS_CLOSE.outputEnded,
        SERVICE_REMOVED_REASON,
      ]);
      expect(follower().close).toHaveBeenCalled();
    });

    it('asks the Server the follower runs on, not the platform host', async () => {
      await connect('&serverId=srv_1');
      remoteExec.execRemote.mockImplementation(() => listed());
      await jest.advanceTimersByTimeAsync(SERVICE_PRESENCE_INTERVAL_MS);

      expect(remoteExec.execRemote).toHaveBeenCalledWith(
        'srv_1',
        expect.arrayContaining(['docker', 'service', 'ls']),
      );
      expect(remoteExec.execFileAsync).not.toHaveBeenCalled();
      expect(closedWith()?.[0]).toBe(CONTAINER_LOGS_CLOSE.outputEnded);
    });

    it('stays open while the service is listed', async () => {
      await connect();
      await jest.advanceTimersByTimeAsync(SERVICE_PRESENCE_INTERVAL_MS * 3);

      expect(remoteExec.execFileAsync).toHaveBeenCalledTimes(3);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('does not take a service the name only prefixes for the one followed', async () => {
      // `--filter name=` matches on a prefix, so the gone service's longer
      // sibling comes back from the same query.
      await connect();
      remoteExec.execFileAsync.mockImplementation(() =>
        listed('compose-4yyg7c_cache-replica'),
      );
      await jest.advanceTimersByTimeAsync(SERVICE_PRESENCE_INTERVAL_MS);

      expect(closedWith()).toEqual([
        CONTAINER_LOGS_CLOSE.outputEnded,
        SERVICE_REMOVED_REASON,
      ]);
    });

    it('keeps streaming when the question could not be asked', async () => {
      // A daemon or Server that did not answer is not an answer (ADR-0005's
      // split, which ADR-0012 applies to sockets): it must not end a stream.
      await connect();
      remoteExec.execFileAsync.mockImplementation(() =>
        Promise.reject(new Error('Cannot connect to the Docker daemon')),
      );
      await jest.advanceTimersByTimeAsync(SERVICE_PRESENCE_INTERVAL_MS);

      expect(ws.close).not.toHaveBeenCalled();
    });

    it('stops asking once the socket has closed', async () => {
      await connect();
      ws.close();
      await jest.advanceTimersByTimeAsync(SERVICE_PRESENCE_INTERVAL_MS * 3);

      expect(remoteExec.execFileAsync).not.toHaveBeenCalled();
    });

    it('never asks about a container, whose follower exits on its own', async () => {
      await gateway.handleConnection(
        ws,
        request('/docker-container-logs?containerId=abc123'),
      );
      await jest.advanceTimersByTimeAsync(SERVICE_PRESENCE_INTERVAL_MS * 3);

      expect(remoteExec.execFileAsync).not.toHaveBeenCalled();
    });
  });

  it('carries reasons that fit a close frame', () => {
    for (const reason of [
      outputEndedReason('native'),
      outputEndedReason('swarm'),
      SERVICE_REMOVED_REASON,
    ]) {
      expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(
        CLOSE_REASON_BYTE_LIMIT,
      );
    }
  });

  /**
   * The console words this close as an ending rather than a refusal. A
   * value that drifted would fall through to "The gateway closed the
   * connection.", so it is pinned from the side that owns it, the way
   * `container-terminal-close.spec.ts` pins `NO_SHELL_CLOSE_CODE`.
   */
  it('matches the console’s copy of the output-ended code', () => {
    const mirror = fs.readFileSync(
      path.join(__dirname, '../../../frontend/src/lib/realtime/gateways.ts'),
      'utf8',
    );
    expect(mirror).toContain(
      `OUTPUT_ENDED_CLOSE_CODE = ${CONTAINER_LOGS_CLOSE.outputEnded}`,
    );
  });
});
