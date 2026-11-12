import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Logger } from '@nestjs/common';
import type { PermissionService } from '../../src/rbac/permission.service';
import {
  SETUP_CLOSE,
  ServerSetupGateway,
} from '../../src/realtime/gateways/server-setup.gateway';
import { LEASE_RENEWAL_INTERVAL_MS } from '../../src/realtime/socket-access';
import type { WsAuthGuard } from '../../src/realtime/ws-auth.guard';
import { ServerSetupRuns } from '../../src/servers/server-setup-runs';
import type { ServersService } from '../../src/servers/servers.service';

/**
 * Who may start a Setup run (ADR-0058).
 *
 * `/listen-server-setup` used to start a run on any connection that found none
 * in flight, and every log socket redials on its own after a transport drop — so
 * a drop in a run's last seconds, or a backend restart mid-run, provisioned the
 * host again with nobody pressing anything. A connection now says whether it
 * *starts* (`start=true`, sent only by the dial right after a confirmed press)
 * or *watches* (everything else, including a client that sends no flag at all).
 *
 * Driven with doubles: what is asserted is which dial reaches `servers.setup`,
 * which needs no server row. The authorized paths against a real database are
 * `server-setup-gateway.e2e-spec.ts`.
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

  output(): string {
    return this.send.mock.calls.map(([chunk]) => chunk).join('');
  }
}

const auth = {
  user: { id: 'user_1' },
  session: { activeOrganizationId: 'org_1' },
};

const dial = (query: string): IncomingMessage =>
  ({
    url: `/listen-server-setup?serverId=srv_1${query}`,
    headers: { host: 'localhost' },
  }) as IncomingMessage;

const START = '&start=true';

describe('ServerSetupGateway', () => {
  let setup: jest.Mock;
  let gateway: ServerSetupGateway;
  let sockets: FakeWs[];
  /** The `onData` and settle of the run `servers.setup` was last asked for. */
  let held: {
    emit: (chunk: string) => void;
    succeed: () => void;
  } | null;

  const connect = async (query: string) => {
    const ws = new FakeWs();
    sockets.push(ws);
    await gateway.handleConnection(ws, dial(query));
    return ws;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    sockets = [];
    held = null;
    setup = jest.fn(
      (_ctx: unknown, _serverId: string, onData: (chunk: string) => void) =>
        new Promise<void>((resolve) => {
          held = { emit: onData, succeed: resolve };
        }),
    );
    const findOne = jest
      .fn()
      .mockResolvedValue({ serverId: 'srv_1', organizationId: 'org_1' });
    const servers = { findOne, setup } as unknown as ServersService;

    gateway = new ServerSetupGateway(
      {
        authenticate: jest.fn().mockResolvedValue(auth),
        assertStillAuthenticated: jest.fn().mockResolvedValue(undefined),
      } as unknown as WsAuthGuard,
      servers,
      {
        checkPermission: jest.fn().mockResolvedValue(undefined),
      } as unknown as PermissionService,
      new ServerSetupRuns(servers),
      LEASE_RENEWAL_INTERVAL_MS,
    );
  });

  afterEach(() => {
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.close();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('a dial that only watches', () => {
    it('starts nothing when no run is in flight, and says so with its own code', async () => {
      const ws = await connect('');

      expect(setup).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(
        SETUP_CLOSE.notRunning,
        expect.any(String),
      );
      // Not the clean close a finished run ends with, and not a refusal code the
      // client would read as "you may not".
      expect(SETUP_CLOSE.notRunning).not.toBe(1000);
      expect(
        Object.values(SETUP_CLOSE).filter(
          (code) => code === SETUP_CLOSE.notRunning,
        ),
      ).toHaveLength(1);
    });

    it.each(['&start=false', '&start=1', '&start='])(
      'treats %s as a watch: only the exact flag starts a run',
      async (query) => {
        const ws = await connect(query);

        expect(setup).not.toHaveBeenCalled();
        expect(ws.close).toHaveBeenCalledWith(
          SETUP_CLOSE.notRunning,
          expect.any(String),
        );
      },
    );

    it('attaches to a run in flight and has what it missed replayed', async () => {
      await connect(START);
      held!.emit('1. Installing required packages\n');

      const watcher = await connect('');

      expect(setup).toHaveBeenCalledTimes(1);
      expect(watcher.close).not.toHaveBeenCalled();
      expect(watcher.output()).toBe('1. Installing required packages\n');

      held!.emit('2. Installing Docker\n');
      expect(watcher.output()).toContain('2. Installing Docker\n');
    });

    it('starts nothing once the run it would have watched has ended', async () => {
      const starter = await connect(START);
      held!.succeed();
      await jest.advanceTimersByTimeAsync(0);
      expect(starter.close).toHaveBeenCalledWith(1000, 'Setup finished');

      // The redial after a drop that lost the `✅` frame.
      const redial = await connect('');

      expect(setup).toHaveBeenCalledTimes(1);
      expect(redial.close).toHaveBeenCalledWith(
        SETUP_CLOSE.notRunning,
        expect.any(String),
      );
    });
  });

  describe('a dial that starts', () => {
    it('starts a run when none is in flight', async () => {
      const ws = await connect(START);

      expect(setup).toHaveBeenCalledTimes(1);
      expect(ws.close).not.toHaveBeenCalled();
    });

    it('attaches to a run in flight rather than provisioning the host twice', async () => {
      await connect(START);
      held!.emit('Swarm initialized ✅\n');

      const second = await connect(START);

      expect(setup).toHaveBeenCalledTimes(1);
      expect(second.output()).toBe('Swarm initialized ✅\n');
    });
  });
});
