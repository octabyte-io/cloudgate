import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import type { SshChannelService } from '../../src/realtime/channels/ssh-channel.service';
import type { ContainerAccessService } from '../../src/realtime/container-access.service';
import {
  CONTAINER_TERMINAL_CLOSE,
  ContainerTerminalGateway,
} from '../../src/realtime/gateways/container-terminal.gateway';
import { LEASE_RENEWAL_INTERVAL_MS } from '../../src/realtime/socket-access';
import { TERMINAL_CLOSE } from '../../src/realtime/terminal-protocol';
import type { WsAuthGuard } from '../../src/realtime/ws-auth.guard';
import type { ServersService } from '../../src/servers/servers.service';
import { FakeChannel } from './realtime.fixture';

/**
 * How a container shell ends.
 *
 * `/terminal` closes its socket when the shell exits. This
 * gateway only printed "Container closed with code: 0" and left the socket
 * open, so the dialog kept a green "running" pill over a shell that was gone
 * and typing went into a socket attached to nothing — on `exit`, and at once on
 * an image with no `sh`, which is the same channel close with a 127 in it. The
 * line was wrong as well: what ended was the `docker exec`, and the container
 * was still up.
 *
 * Both branches, because the platform host's pty had no close handler at all.
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
  ({
    url: pathWithQuery,
    headers: { host: 'localhost' },
  }) as IncomingMessage;

const auth = {
  user: { id: 'user_1' },
  session: { activeOrganizationId: 'org_1' },
};

/** What `docker exec` prints when the image has no such shell, measured on
 *  Docker 29 against `alpine` asked for `zsh`. */
const NO_SH =
  'OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH\r\n';

describe('ContainerTerminalGateway close contract', () => {
  let ws: FakeWs;
  let channels: FakeChannel[];
  let warn: jest.SpyInstance;
  let gateway: ContainerTerminalGateway;

  /** The shell's channel — the first one opened; any later one is a reaper. */
  const shell = () => channels[0];
  const closedWith = () => ws.close.mock.calls.at(-1);
  const printed = () => ws.send.mock.calls.map(([frame]) => frame).join('');

  beforeEach(() => {
    ws = new FakeWs();
    channels = [];
    const channel = () => {
      const made = new FakeChannel();
      channels.push(made);
      return made;
    };
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    gateway = new ContainerTerminalGateway(
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
      LEASE_RENEWAL_INTERVAL_MS,
    );
  });

  afterEach(() => {
    ws.close();
    warn.mockRestore();
  });

  describe.each([
    ['on a Server, over SSH', '&serverId=srv_1'],
    ['on the platform host, through a pty', ''],
  ])('%s', (_branch, serverQuery) => {
    const connect = () =>
      gateway.handleConnection(
        ws,
        request(`/docker-container-terminal?containerId=abc123${serverQuery}`),
      );

    it('closes the socket when the shell exits', async () => {
      await connect();
      shell().emitClose(0);

      expect(closedWith()).toEqual([
        CONTAINER_TERMINAL_CLOSE.shellClosed,
        'shell exited with code 0',
      ]);
    });

    it('says the shell exited, and not that the container closed', async () => {
      await connect();
      shell().emitClose(0);

      expect(printed()).toContain('\r\nThe shell exited with code 0.\r\n');
      expect(printed()).not.toMatch(/container closed/i);
    });

    it('says the shell ended without a code when it was killed', async () => {
      await connect();
      shell().emitClose(undefined);

      expect(printed()).toContain('The shell ended without an exit code.');
      expect(printed()).not.toContain('null');
      expect(closedWith()).toEqual([
        CONTAINER_TERMINAL_CLOSE.shellClosed,
        'shell ended without an exit code',
      ]);
    });

    it('says in words that the image has no shell, under the runtime error', async () => {
      await connect();
      shell().emitData(NO_SH);
      shell().emitClose(127);

      const [code, reason] = closedWith() ?? [];
      expect(code).toBe(CONTAINER_TERMINAL_CLOSE.noShell);
      expect(reason).toBe('This image has no shell to open: sh is not in it');
      // The runtime's own line stays; the plain one follows it.
      expect(printed()).toContain(NO_SH);
      expect(printed()).toContain(
        '\r\nThis image has no shell to open: sh is not in it.\r\n',
      );
    });

    it('does not mistake a shell whose last command was not found for no shell', async () => {
      // `exit` after a typo exits 127 too. The runtime's refusal is what tells
      // the two apart, and a working shell never prints it.
      await connect();
      shell().emitData('/ # nope\r\nsh: nope: not found\r\n/ # exit\r\n');
      shell().emitClose(127);

      expect(closedWith()).toEqual([
        CONTAINER_TERMINAL_CLOSE.shellClosed,
        'shell exited with code 127',
      ]);
    });

    it('closes once, and leaves an already-closed socket alone', async () => {
      await connect();
      ws.close();
      ws.close.mockClear();
      shell().emitClose(0);

      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  it('closes with the same code /terminal uses for a shell that ended', () => {
    expect(CONTAINER_TERMINAL_CLOSE.shellClosed).toBe(
      TERMINAL_CLOSE.shellClosed,
    );
  });

  /**
   * The console reads `noShell` to word the status line. A value that
   * drifted would fall through to the generic sentence, so it is pinned from
   * the side that owns it, the way `server-terminal-close.spec.ts` pins
   * `TERMINAL_CLOSE`.
   */
  it('matches the console’s copy of the no-shell code', () => {
    const mirror = fs.readFileSync(
      path.join(__dirname, '../../../frontend/src/lib/realtime/terminals.ts'),
      'utf8',
    );
    expect(mirror).toContain(
      `NO_SHELL_CLOSE_CODE = ${CONTAINER_TERMINAL_CLOSE.noShell}`,
    );
    const listedCodes = /docker exec` through a pty and closes([^*]*)/.exec(
      mirror,
    );
    expect(listedCodes?.[1]).toContain(
      String(CONTAINER_TERMINAL_CLOSE.noShell),
    );
  });
});
