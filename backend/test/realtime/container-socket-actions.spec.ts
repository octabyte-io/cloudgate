import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Logger } from '@nestjs/common';
import type { PtyChannelService } from '../../src/realtime/channels/pty-channel.service';
import type { SshChannelService } from '../../src/realtime/channels/ssh-channel.service';
import type { ContainerAccessService } from '../../src/realtime/container-access.service';
import { ContainerLogsGateway } from '../../src/realtime/gateways/container-logs.gateway';
import { ContainerTerminalGateway } from '../../src/realtime/gateways/container-terminal.gateway';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { WsAuthGuard } from '../../src/realtime/ws-auth.guard';
import type { ServersService } from '../../src/servers/servers.service';
import { FakeChannel, waitFor } from './realtime.fixture';

/**
 * **Which Service action each container socket asks for.**
 *
 * A shell writes inside the workload, and it is settled that `service: ['read']`
 * means read only, so `/docker-container-terminal` asks for `service:update`
 * on the Service that owns a managed container — at connect and at every lease
 * renewal, so revoking the action closes an open shell. The log socket stays on
 * `read`: no change to the log and stats sockets is in scope.
 *
 * The behaviour behind the action (a custom role holding `service: ['read']`
 * refused, in the one sentence) is pinned against a real database in
 * `container-access.e2e-spec.ts` and `gateway-leases.e2e-spec.ts`; this pins
 * that each gateway names the action it means.
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
    this.readyState = 3;
    this.emit('close');
  });
}

const request = (pathWithQuery: string): IncomingMessage =>
  ({ url: pathWithQuery, headers: { host: 'localhost' } }) as IncomingMessage;

const auth = {
  user: { id: 'user_1' },
  session: { activeOrganizationId: 'org_1' },
};

/** A renewal fast enough to observe without a fake clock. */
const RENEWAL_MS = 20;

describe('ContainerTerminalGateway and ContainerLogsGateway: the Service action each asks for', () => {
  let ws: FakeWs;
  let warn: jest.SpyInstance;
  let access: {
    authorizeContainer: jest.Mock;
    authorizeAppNames: jest.Mock;
  };
  const wsAuth = {
    authenticate: jest.fn().mockResolvedValue(auth),
    assertStillAuthenticated: jest.fn().mockResolvedValue(undefined),
  } as unknown as WsAuthGuard;
  const servers = {
    findOne: jest.fn().mockResolvedValue({
      serverId: 'srv_1',
      organizationId: 'org_1',
      sshKeyId: 'key_1',
    }),
  } as unknown as ServersService;
  const ssh = {
    open: jest.fn(() => Promise.resolve(new FakeChannel())),
  } as unknown as SshChannelService;
  const pty = {
    spawn: jest.fn(() => new FakeChannel()),
  } as unknown as PtyChannelService;

  beforeEach(() => {
    ws = new FakeWs();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    access = {
      authorizeContainer: jest.fn().mockResolvedValue(['web']),
      authorizeAppNames: jest.fn().mockResolvedValue('service'),
    };
  });

  afterEach(() => {
    ws.close();
    warn.mockRestore();
  });

  describe('/docker-container-terminal', () => {
    const connect = () =>
      new ContainerTerminalGateway(
        wsAuth,
        servers,
        access as unknown as ContainerAccessService,
        ssh,
        pty,
        RENEWAL_MS,
      ).handleConnection(
        ws,
        request('/docker-container-terminal?containerId=abc123'),
      );

    it('asks for service:update at connect', async () => {
      await connect();

      expect(access.authorizeContainer).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ containerId: 'abc123' }),
        'update',
      );
    });

    it('asks for service:update again at every lease renewal', async () => {
      await connect();

      await waitFor(() => access.authorizeAppNames.mock.calls.length > 0);
      expect(access.authorizeAppNames).toHaveBeenCalledWith(
        expect.anything(),
        ['web'],
        null,
        'update',
      );
    });
  });

  describe('/docker-container-logs', () => {
    const connect = () =>
      new ContainerLogsGateway(
        wsAuth,
        servers,
        access as unknown as ContainerAccessService,
        ssh,
        pty,
        { execAsync: jest.fn() } as unknown as RemoteExecService,
        RENEWAL_MS,
      ).handleConnection(
        ws,
        request('/docker-container-logs?containerId=abc123&tail=10'),
      );

    it('stays on service:read, at connect and at renewal', async () => {
      await connect();
      await waitFor(() => access.authorizeAppNames.mock.calls.length > 0);

      expect(access.authorizeContainer).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ containerId: 'abc123' }),
        'read',
      );
      expect(access.authorizeAppNames).toHaveBeenCalledWith(
        expect.anything(),
        ['web'],
        null,
        'read',
      );
    });
  });
});
