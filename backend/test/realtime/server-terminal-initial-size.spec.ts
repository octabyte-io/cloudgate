import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { WebSocket, WebSocketServer } from 'ws';
import type { SshChannelService } from '../../src/realtime/channels/ssh-channel.service';
import { ServerTerminalGateway } from '../../src/realtime/gateways/server-terminal.gateway';
import type { LocalServerSetupService } from '../../src/realtime/local-server-setup.service';
import type { PermissionService } from '../../src/rbac/permission.service';
import { LEASE_RENEWAL_INTERVAL_MS } from '../../src/realtime/socket-access';
import {
  DEFAULT_TERMINAL_SIZE,
  SHELL_OPEN_FRAME,
} from '../../src/realtime/terminal-protocol';
import type { TerminalSize } from '../../src/realtime/terminal-protocol';
import type { WsAuthGuard } from '../../src/realtime/ws-auth.guard';
import type { ServersService } from '../../src/servers/servers.service';
import { FakeChannel } from './realtime.fixture';

/**
 * A fresh `/terminal` session starts at the size of the browser's frame.
 *
 * The console sends `\x00{"cols":…,"rows":…}` the moment the socket opens, and
 * `captureInitialSize` is installed before the gateway's first `await` to catch
 * it. That was never the gap. The gap was the *other* end of the window: this
 * gateway's checks are a few quick lookups, so it reaches `sshChannels.open`
 * — and reads the capture — before the browser has even seen the upgrade
 * answered. The frame then lands in the capture while the SSH handshake runs,
 * and `stop()` threw it away, so the pty opened at 80 × 24 and stayed there
 * until the operator happened to resize the window. `/docker-container-terminal`
 * inspects the container over SSH before it dials, which is slow enough that
 * its frame always arrived in time; that is the whole difference the ticket
 * saw between the two.
 *
 * Measured, not inferred: this gateway over a real socket against a real
 * OpenSSH in a container answered `stty size` with `24 80` for a client that
 * sent `115 × 20` on open, while ssh2 alone asked for `115 × 20` answered
 * `20 115`.
 *
 * A real `ws` server and client, so the frame travels the way a browser's does
 * and arrives when it really would; only the SSH dial is a double, one that
 * takes a moment the way a handshake does.
 */

const auth = {
  user: { id: 'user_1' },
  session: { activeOrganizationId: 'org_1' },
};

const SIZE: TerminalSize = { cols: 115, rows: 20 };

type OpenOptions = { cols?: number; rows?: number };

describe('ServerTerminalGateway initial size', () => {
  let http: Server;
  let wss: WebSocketServer;
  let port: number;
  let open: jest.Mock<Promise<FakeChannel>, [unknown, OpenOptions]>;
  let channel: FakeChannel;
  let authenticate: jest.Mock;
  let warn: jest.SpyInstance;
  let client: WebSocket | undefined;

  beforeEach(async () => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    channel = new FakeChannel();
    // An SSH handshake is several round trips; the double takes one beat.
    open = jest.fn<Promise<FakeChannel>, [unknown, OpenOptions]>(
      () =>
        new Promise<FakeChannel>((resolve) =>
          setTimeout(() => resolve(channel), 50),
        ),
    );
    authenticate = jest.fn().mockResolvedValue(auth);
    const gateway = new ServerTerminalGateway(
      {
        authenticate,
        assertStillAuthenticated: jest.fn().mockResolvedValue(undefined),
      } as unknown as WsAuthGuard,
      {
        findOne: jest
          .fn()
          .mockResolvedValue({ serverId: 'srv_1', sshKeyId: 'key_1' }),
      } as unknown as ServersService,
      { open } as unknown as SshChannelService,
      {
        setupSshKey: jest.fn().mockResolvedValue('PRIVATE_KEY'),
        getDockerHost: jest.fn().mockResolvedValue('127.0.0.1'),
      } as unknown as LocalServerSetupService,
      {
        checkInstanceAuthority: jest.fn().mockResolvedValue(undefined),
        checkPermission: jest.fn().mockResolvedValue(undefined),
      } as unknown as PermissionService,
      LEASE_RENEWAL_INTERVAL_MS,
    );

    http = createServer();
    wss = new WebSocketServer({ server: http });
    wss.on(
      'connection',
      (socket, req) => void gateway.handleConnection(socket, req),
    );
    await new Promise<void>((resolve) => http.listen(0, resolve));
    port = (http.address() as AddressInfo).port;
  });

  afterEach(async () => {
    client?.close();
    client = undefined;
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => http.close(resolve));
    warn.mockRestore();
  });

  /** Opens a session the way the console does: size first, on `open`. */
  function connect(query: string): void {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/terminal?${query}`);
    socket.on('open', () => socket.send(`\x00${JSON.stringify(SIZE)}`));
    client = socket;
  }

  /**
   * The window the pty ends up with before anything is typed: the last resize
   * the channel was given, or else the one it was opened at, or else ssh2's
   * default. Either route is a pty of the right size — what is not is a frame
   * that went nowhere.
   */
  function ptySize(): TerminalSize {
    const resized = channel.resize.mock.calls.at(-1);
    if (resized) return { cols: resized[0], rows: resized[1] };
    const [, options] = open.mock.calls[0];
    return {
      cols: options.cols ?? DEFAULT_TERMINAL_SIZE.cols,
      rows: options.rows ?? DEFAULT_TERMINAL_SIZE.rows,
    };
  }

  /**
   * Until the gateway has bridged the channel. It clears the screen the moment
   * the channel opens, and everything from there to the bridge is synchronous,
   * so the reset reaching the client means the handover has happened.
   */
  const bridged = () =>
    new Promise<void>((resolve) =>
      client?.on('message', (data) => {
        if ((data as Buffer).toString().includes('\x1bc')) resolve();
      }),
    );

  it.each([
    ['a registered Server', 'serverId=srv_1'],
    ['the platform host', 'serverId=local&port=22&username=root'],
  ])(
    'gives %s the size the browser sent on open, though the dial had already begun',
    async (_name, query) => {
      connect(query);
      await bridged();

      expect(open).toHaveBeenCalledTimes(1);
      expect(ptySize()).toEqual(SIZE);
      // Not typed: the frame is the protocol's, never the shell's.
      expect(channel.write).not.toHaveBeenCalled();
    },
  );

  it('says the shell is open once, before any of the channel’s bytes', async () => {
    const frames: string[] = [];
    connect('serverId=srv_1');
    client?.on('message', (data) => frames.push((data as Buffer).toString()));
    await bridged();

    const opened = frames.indexOf(SHELL_OPEN_FRAME);
    // Not on upgrade: "Connecting..." goes out first, while the dial is on.
    expect(frames.slice(0, opened).join('')).toContain('Connecting');
    expect(opened).toBeGreaterThan(-1);
    expect(frames.filter((frame) => frame === SHELL_OPEN_FRAME)).toHaveLength(
      1,
    );
    // Before the reset, which is the first thing after the channel exists.
    expect(
      frames.findIndex((frame) => frame.includes('\x1bc')),
    ).toBeGreaterThan(opened);
  });

  it('opens the pty at that size when the frame arrives before the dial', async () => {
    // The ordering the capture was written for, and the one the container
    // terminal always had: something slow stands between upgrade and dial.
    authenticate.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(auth), 100)),
    );
    connect('serverId=srv_1');
    await bridged();

    expect(open.mock.calls[0][1]).toEqual(expect.objectContaining(SIZE));
    // And nothing to catch up on afterwards.
    expect(channel.resize).not.toHaveBeenCalled();
  });
});
