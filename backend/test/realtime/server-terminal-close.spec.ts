import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { ForbiddenException, Logger } from '@nestjs/common';
import type { PermissionService } from '../../src/rbac/permission.service';
import type { SshChannelService } from '../../src/realtime/channels/ssh-channel.service';
import {
  HOST_SHELL_REFUSAL,
  ServerTerminalGateway,
  terminalLine,
} from '../../src/realtime/gateways/server-terminal.gateway';
import type { LocalServerSetupService } from '../../src/realtime/local-server-setup.service';
import {
  DENIED_CLOSE_CODE,
  LEASE_RENEWAL_INTERVAL_MS,
  UNREACHABLE_CLOSE_CODE,
} from '../../src/realtime/socket-access';
import {
  SHELL_OPEN_FRAME,
  TERMINAL_CLOSE,
} from '../../src/realtime/terminal-protocol';
import type { WsAuthGuard } from '../../src/realtime/ws-auth.guard';
import type { ServersService } from '../../src/servers/servers.service';
import { FakeChannel } from './realtime.fixture';

/**
 * How `/terminal` ends.
 *
 * Every socket this gateway gives up on used to end the same way: a bare
 * `ws.close()`, which is `1005` with no reason on the wire and nothing in the
 * journal — indistinguishable, from the browser, from a proxy dropping the
 * connection, and the reason a missing `port` was diagnosed as a cookie problem
 * for an afternoon. Worse, the two paths that *had* something to say — an SSH
 * channel that errored, and a shell that exited — said it and then left the
 * socket open forever, so the console kept a green "running" badge over a shell
 * that would never carry another byte.
 *
 * These drive `handleConnection` directly with doubles. The gateway's authorized
 * paths are covered against a real database in `realtime.e2e-spec.ts`; what is
 * here is the close contract alone, which needs no server row to be true.
 */

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  send = jest.fn<void, [string]>();
  ping = jest.fn();
  // `terminate()` is what the keep-alive drops a peer that stopped answering
  // with, and it emits `'close'` on a real socket — so the double does too, or
  // nothing hung off `'close'` would be torn down in a spec.
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

describe('ServerTerminalGateway close contract', () => {
  let ws: FakeWs;
  let open: jest.Mock;
  let setupSshKey: jest.Mock;
  let getDockerHost: jest.Mock;
  let findOne: jest.Mock;
  let checkInstanceAuthority: jest.Mock;
  let checkPermission: jest.Mock;
  let warn: jest.SpyInstance;
  let gateway: ServerTerminalGateway;

  /** Every line the gateway sent to the journal for this socket. */
  const journal = () => warn.mock.calls.map(([message]) => String(message));

  /** The one close frame the socket ended with. */
  const closedWith = () => ws.close.mock.calls.at(-1);

  beforeEach(() => {
    ws = new FakeWs();
    open = jest.fn();
    setupSshKey = jest.fn().mockResolvedValue('PRIVATE_KEY');
    getDockerHost = jest.fn().mockResolvedValue('127.0.0.1');
    findOne = jest.fn();
    // Unless a test says otherwise the caller carries instance authority and
    // holds every entitlement: these specs are about how the socket *ends*, and
    // the gate that decides whether it may start is asserted on its own below
    // and against a real database in `realtime.e2e-spec.ts`.
    //
    // The double answers `checkInstanceAuthority` rather than a member lookup
    // since H-63, because that is the question the local branch now asks. A
    // double that answers a question the code no longer poses does not fail
    // honestly — the missing method throws a `TypeError` that the connection
    // handler's own `catch` renders as a `4403`, indistinguishable from a real
    // authority refusal, which is why every close-contract case here went red at
    // once and none of them was about authority.
    checkInstanceAuthority = jest.fn().mockResolvedValue(undefined);
    checkPermission = jest.fn().mockResolvedValue(undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    gateway = new ServerTerminalGateway(
      {
        authenticate: jest.fn().mockResolvedValue(auth),
        assertStillAuthenticated: jest.fn().mockResolvedValue(undefined),
      } as unknown as WsAuthGuard,
      { findOne } as unknown as ServersService,
      { open } as unknown as SshChannelService,
      {
        setupSshKey,
        getDockerHost,
      } as unknown as LocalServerSetupService,
      {
        checkInstanceAuthority,
        checkPermission,
      } as unknown as PermissionService,
      LEASE_RENEWAL_INTERVAL_MS,
    );
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('a request that cannot be served', () => {
    it('names the missing serverId in the close frame and the journal', async () => {
      await gateway.handleConnection(ws, request('/terminal'));

      expect(closedWith()).toEqual([
        TERMINAL_CLOSE.badRequest,
        expect.stringContaining('serverId'),
      ]);
      expect(journal()).toContainEqual(expect.stringContaining('serverId'));
      expect(open).not.toHaveBeenCalled();
    });

    it('names port and username when the local terminal is missing them', async () => {
      await gateway.handleConnection(
        ws,
        request('/terminal?serverId=local&port=2222'),
      );

      const [code, reason] = closedWith() ?? [];
      expect(code).toBe(TERMINAL_CLOSE.badRequest);
      expect(reason).toContain('port');
      expect(reason).toContain('username');
      expect(journal()).toContainEqual(expect.stringContaining('username'));
      expect(setupSshKey).not.toHaveBeenCalled();
    });

    /**
     * A port that is *present and wrong*.
     *
     * `Number(...)` then `if (!port)` checked only truthiness, so `99999` was a
     * truthy number and went straight into `connection.port`. ssh2 answered from
     * its own argument validation — `Port should be >= 0 and < 65536. Received
     * type number (99999)` — thrown as an `Error` with no `level`, which the
     * outer catch cannot tell from a dial that failed, so it closed `4500`. A
     * request that was simply wrong was reported as a machine that could not be
     * reached, in a library's internal words.
     */
    it('refuses a port above 65535 as a bad request, without dialling', async () => {
      await gateway.handleConnection(
        ws,
        request('/terminal?serverId=local&port=99999&username=root'),
      );

      expect(closedWith()).toEqual([
        TERMINAL_CLOSE.badRequest,
        'port must be a whole number from 1 to 65535',
      ]);
      // ssh2 was never handed the value, so it has nothing internal to say
      // about it — which is the rule this fix establishes, and it is stronger
      // than sanitising the message would have been.
      expect(open).not.toHaveBeenCalled();
      expect(setupSshKey).not.toHaveBeenCalled();
      expect(closedWith()?.[1]).not.toContain('Received type number');
    });

    it.each(['99999', '0', '-1', '22.5', 'ssh', '65536'])(
      'refuses port=%s the same way, before anything is dialled',
      async (port) => {
        // `0` and `65536` are the boundaries, `22.5` is what `Number.isInteger`
        // is there for, and `ssh` is `NaN`. `0` moves here from the absent-port
        // message on purpose: it is present and invalid, not missing.
        await gateway.handleConnection(
          ws,
          request(`/terminal?serverId=local&port=${port}&username=root`),
        );

        expect(closedWith()).toEqual([
          TERMINAL_CLOSE.badRequest,
          'port must be a whole number from 1 to 65535',
        ]);
        expect(open).not.toHaveBeenCalled();
      },
    );

    it.each(['', undefined])(
      'still refuses an absent port with the message the console quotes',
      async (port) => {
        // The regression guard for the message split: three docblocks and
        // `terminal-session.test.ts` quote this exact string, so an *absent*
        // port keeps it and only an out-of-range one gets the new wording.
        const query =
          port === undefined
            ? '/terminal?serverId=local&username=root'
            : `/terminal?serverId=local&port=${port}&username=root`;

        await gateway.handleConnection(ws, request(query));

        expect(closedWith()).toEqual([
          TERMINAL_CLOSE.badRequest,
          'port and username are required for serverId=local',
        ]);
      },
    );

    it.each([1, 22, 65535])(
      'opens a shell on port %s, which is inside the bound',
      async (port) => {
        // The other side of the bound: the check must not have become a new
        // refusal for a legitimate high port.
        open.mockResolvedValue(new FakeChannel());

        await gateway.handleConnection(
          ws,
          request(`/terminal?serverId=local&port=${port}&username=root`),
        );

        const [target] = (open.mock.calls[0] ?? []) as [
          { connection: { port: number } },
        ];
        expect(target.connection.port).toBe(port);
        expect(closedWith()).toBeUndefined();
      },
    );

    it('says so when this host has no local key to dial with', async () => {
      setupSshKey.mockResolvedValue('');

      await gateway.handleConnection(
        ws,
        request('/terminal?serverId=local&port=22&username=root'),
      );

      expect(closedWith()).toEqual([
        TERMINAL_CLOSE.keyUnavailable,
        expect.any(String),
      ]);
      expect(journal()).not.toHaveLength(0);
      expect(open).not.toHaveBeenCalled();
    });

    it('says so when the key cannot be generated at all', async () => {
      setupSshKey.mockRejectedValue(new Error('Permission denied'));

      await gateway.handleConnection(
        ws,
        request('/terminal?serverId=local&port=22&username=root'),
      );

      // The remediation the operator has to run reaches them first; the close
      // frame is the machine-readable half of the same sentence.
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('grant permission access'),
      );
      expect(closedWith()?.[0]).toBe(TERMINAL_CLOSE.keyUnavailable);
    });

    it('says so when the Server has no SSH key configured', async () => {
      findOne.mockResolvedValue({ serverId: 'srv_1', sshKeyId: null });

      await gateway.handleConnection(ws, request('/terminal?serverId=srv_1'));

      expect(closedWith()?.[0]).toBe(TERMINAL_CLOSE.keyUnavailable);
      expect(open).not.toHaveBeenCalled();
    });

    it('still refuses a Server outside the organization without a word', async () => {
      // Deliberate, and not what this changes: an id that is not the caller's
      // and an id that does not exist have to be byte-identical on the wire, or
      // the socket enumerates another organization's Servers (ADR-0008).
      findOne.mockRejectedValue(new Error('Server not found'));

      await gateway.handleConnection(ws, request('/terminal?serverId=srv_x'));

      expect(ws.close).toHaveBeenCalledWith();
    });

    it('records the refusal it will not put on the wire', async () => {
      // The journal is the only place this exit survives, and once it did
      // not: the branch closed silently *and* logged nothing, while the
      // entitlement exit twenty lines down logged a line — so an operator asked
      // "why did this id not work" could tell the two apart only by absence.
      // The wire promise is pinned by the same test, so a later edit cannot buy
      // the line by making the close specific.
      findOne.mockRejectedValue(new Error('Server not found'));

      await gateway.handleConnection(ws, request('/terminal?serverId=srv_x'));

      expect(
        journal().filter((line) => line.startsWith('Refused socket:')),
      ).toEqual([
        expect.stringMatching(
          /^Refused socket: \/terminal .* for user user_1 in organization org_1$/,
        ),
      ]);
      expect(ws.close).toHaveBeenCalledWith();
      expect(closedWith()).toEqual([]);
    });

    it('says the id did not resolve rather than that it does not exist', async () => {
      // The same catch swallows a database that could not answer, so the line
      // must not claim more than the code knows.
      findOne.mockRejectedValue(new Error('Connection terminated'));

      await gateway.handleConnection(ws, request('/terminal?serverId=srv_x'));

      expect(journal().join('\n')).toContain('serverId did not resolve');
      expect(journal().join('\n')).not.toContain('does not exist');
    });
  });

  /**
   * Who gets a shell on the machine Cloudgate runs on (ADR-0010).
   *
   * `serverId=local` reaches no `server` row — that is the whole reason the
   * branch exists — so `findAuthorizedServer`, which every other addressed
   * socket leans on, has nothing to resolve and the branch ran on
   * authentication alone. What is on the other end is a root shell on the
   * platform host, so the question asked instead is whether the caller
   * administers this instance: owner or admin of their active organization.
   */
  describe('a shell on the platform host', () => {
    const localTerminal = () =>
      gateway.handleConnection(
        ws,
        request('/terminal?serverId=local&port=22&username=root'),
      );

    it('refuses a caller without instance authority, in its own words', async () => {
      // ADR-0013's authority refuses in its own sentence; the gateway answers in
      // *its* sentence, which is the one the console renders against `4403`
      // (H-63).
      checkInstanceAuthority.mockRejectedValue(
        new ForbiddenException(
          'Only an owner or admin of the instance organization can configure the platform host',
        ),
      );

      await localTerminal();

      expect(closedWith()).toEqual([
        TERMINAL_CLOSE.forbidden,
        HOST_SHELL_REFUSAL,
      ]);
      // Nothing on the host was touched on the way to the refusal.
      expect(setupSshKey).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(journal()).toContainEqual(
        expect.stringContaining('user user_1 in organization org_1'),
      );
    });

    it('refuses a caller the instance authority throws on', async () => {
      // `checkInstanceAuthority` fails closed both for a caller with no member
      // row in the instance organization and for an instance with no owner row
      // at all; both arrive here as the same throw, which is the point of its
      // one shared sentence.
      checkInstanceAuthority.mockRejectedValue(
        new ForbiddenException('Permission denied'),
      );

      await localTerminal();

      expect(closedWith()?.[0]).toBe(TERMINAL_CLOSE.forbidden);
      expect(setupSshKey).not.toHaveBeenCalled();
    });

    it('refuses a session carrying no active organization', async () => {
      gateway = new ServerTerminalGateway(
        {
          authenticate: jest
            .fn()
            .mockResolvedValue({ user: { id: 'user_1' }, session: {} }),
        } as unknown as WsAuthGuard,
        { findOne } as unknown as ServersService,
        { open } as unknown as SshChannelService,
        { setupSshKey, getDockerHost } as unknown as LocalServerSetupService,
        {
          checkInstanceAuthority,
          checkPermission,
        } as unknown as PermissionService,
        LEASE_RENEWAL_INTERVAL_MS,
      );

      await localTerminal();

      expect(closedWith()?.[0]).toBe(TERMINAL_CLOSE.forbidden);
      // Refused without asking, rather than authorized unscoped.
      expect(checkInstanceAuthority).not.toHaveBeenCalled();
      expect(setupSshKey).not.toHaveBeenCalled();
    });

    it('opens for a caller carrying instance authority', async () => {
      checkInstanceAuthority.mockResolvedValue(undefined);
      open.mockResolvedValue(new FakeChannel());

      await localTerminal();

      expect(open).toHaveBeenCalled();
    });
  });

  /**
   * The Server branch asks for the entitlement `GET /servers/:id` asks for, and
   * refuses byte-identically to an unknown id: a base member holds no `server`
   * action at all, so telling them "not this one" would confirm the id exists
   * to somebody who cannot list the fleet (ADR-0008).
   */
  describe('a shell on a registered Server', () => {
    it('refuses a caller who may not read Servers, silently', async () => {
      findOne.mockResolvedValue({
        serverId: 'srv_1',
        organizationId: 'org_1',
        sshKeyId: 'key_1',
      });
      checkPermission.mockRejectedValue(
        new ForbiddenException('Permission denied'),
      );

      await gateway.handleConnection(ws, request('/terminal?serverId=srv_1'));

      expect(ws.close).toHaveBeenCalledWith();
      expect(open).not.toHaveBeenCalled();
      // The difference the wire deliberately does not carry survives here.
      expect(journal()).toContainEqual(
        expect.stringContaining('not entitled to Servers'),
      );
    });
  });

  describe('a shell that ends', () => {
    const openLocalTerminal = async (channel: FakeChannel) => {
      open.mockResolvedValue(channel);
      await gateway.handleConnection(
        ws,
        request('/terminal?serverId=local&port=22&username=root'),
      );
    };

    it('closes the socket when the SSH channel errors', async () => {
      const channel = new FakeChannel();
      await openLocalTerminal(channel);

      channel.emitError(new Error('Timed out while waiting for handshake'));

      expect(ws.send).toHaveBeenCalledWith(
        'SSH connection error: Timed out while waiting for handshake ❌ ',
      );
      expect(closedWith()).toEqual([
        TERMINAL_CLOSE.sshFailed,
        expect.stringContaining('Timed out while waiting for handshake'),
      ]);
      expect(ws.readyState).not.toBe(ws.OPEN);
    });

    it('names the user in the line a failed session leaves behind', async () => {
      // The second half: `fail` logged the reason and not the caller, so a
      // run of identical ssh failures could not be read as one member retrying
      // or a Server refusing everybody.
      const channel = new FakeChannel();
      await openLocalTerminal(channel);

      channel.emitError(new Error('Timed out while waiting for handshake'));

      expect(journal()).toContainEqual(
        expect.stringMatching(
          /^Terminal socket failed: .* for user user_1 in organization org_1$/,
        ),
      );
    });

    it('closes the socket when the shell exits normally', async () => {
      const channel = new FakeChannel();
      await openLocalTerminal(channel);

      channel.emitClose(0);

      // A shell, not a container: this frame's noun was copied from the
      // container terminal, where the far end really is one.
      expect(ws.send).toHaveBeenCalledWith(
        '\r\nThe shell exited with code 0.\r\n',
      );
      expect(ws.send).not.toHaveBeenCalledWith(
        expect.stringContaining('Container'),
      );
      expect(closedWith()).toEqual([
        TERMINAL_CLOSE.shellClosed,
        'shell exited with code 0',
      ]);
    });

    it('says the shell ended without a code when the far end was killed', async () => {
      // ssh2 reports no exit code for a shell killed by a signal — the fixture's
      // `emitClose()` takes none, as `stream-channel.ts` types it — and
      // "exited with code null" described something that did not happen.
      const channel = new FakeChannel();
      await openLocalTerminal(channel);

      channel.emitClose();

      const printed = ws.send.mock.calls.map(([frame]) => frame).join('');
      expect(printed).toContain('The shell ended without an exit code.');
      expect(printed).not.toContain('null');
      expect(printed).not.toContain('undefined');
      expect(closedWith()).toEqual([
        TERMINAL_CLOSE.shellClosed,
        expect.not.stringContaining('null'),
      ]);
    });

    it('ends the channel with the socket exactly once', async () => {
      const channel = new FakeChannel();
      await openLocalTerminal(channel);

      channel.emitClose(0);
      channel.emitError(new Error('and then this'));

      // The first close won; a second one would send a frame into a socket that
      // has already gone, which `ws` throws on.
      expect(ws.close).toHaveBeenCalledTimes(1);
      expect(channel.close).toHaveBeenCalledTimes(1);
    });

    it('keeps the close reason inside the 123 bytes a close frame allows', async () => {
      const channel = new FakeChannel();
      await openLocalTerminal(channel);

      channel.emitError(new Error('x'.repeat(400)));

      const reason = closedWith()?.[1] ?? '';
      expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(123);
      expect(reason.length).toBeGreaterThan(20);
    });
  });

  /**
   * A socket that closed while it was still connecting: its `'close'`
   * had already fired by the time the channel opened, so nothing would ever
   * close that channel, and the shell behind it stayed open on the Server.
   */
  describe('a socket that closes before its shell is open', () => {
    it('dials nothing when it closed while being authorized', async () => {
      findOne.mockResolvedValue({
        serverId: 'srv_1',
        organizationId: 'org_1',
        sshKeyId: 'key_1',
      });
      checkPermission.mockImplementation(() => {
        ws.close();
        return Promise.resolve(undefined);
      });

      await gateway.handleConnection(ws, request('/terminal?serverId=srv_1'));

      expect(open).not.toHaveBeenCalled();
    });

    it('closes the channel that was being opened when the socket closed', async () => {
      const channel = new FakeChannel();
      open.mockImplementation(() => {
        ws.close();
        return Promise.resolve(channel);
      });

      await gateway.handleConnection(
        ws,
        request('/terminal?serverId=local&port=22&username=root'),
      );

      expect(channel.close).toHaveBeenCalledTimes(1);
      expect(ws.send).not.toHaveBeenCalledWith(SHELL_OPEN_FRAME);
    });
  });

  describe('a channel that never opens', () => {
    it('closes after reporting a connection failure', async () => {
      open.mockRejectedValue(new Error('connect ETIMEDOUT'));

      await gateway.handleConnection(
        ws,
        request('/terminal?serverId=local&port=22&username=root'),
      );

      expect(ws.send).toHaveBeenCalledWith(
        'SSH connection error: connect ETIMEDOUT ❌ ',
      );
      expect(closedWith()?.[0]).toBe(TERMINAL_CLOSE.sshFailed);
    });

    it('closes after telling a local operator how to install the key', async () => {
      open.mockRejectedValue(
        Object.assign(
          new Error('All configured authentication methods failed'),
          {
            level: 'client-authentication',
          },
        ),
      );

      await gateway.handleConnection(
        ws,
        request('/terminal?serverId=local&port=22&username=root'),
      );

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('authorized_keys'),
      );
      expect(closedWith()?.[0]).toBe(TERMINAL_CLOSE.authFailed);
    });
  });

  describe('the remediation it prints', () => {
    it('names the key under CLOUDGATE_DIRECTORY, not a hardcoded /etc', async () => {
      // The local tree is relocatable, and this text was found still
      // telling an operator to cat a file that is not where their key is.
      process.env.CLOUDGATE_DIRECTORY = '/var/lib/cloudgate';
      open.mockRejectedValue(
        Object.assign(new Error('nope'), { level: 'client-authentication' }),
      );

      try {
        await gateway.handleConnection(
          ws,
          request('/terminal?serverId=local&port=22&username=root'),
        );
      } finally {
        delete process.env.CLOUDGATE_DIRECTORY;
      }

      const printed = ws.send.mock.calls.map(([frame]) => frame).join('');
      expect(printed).toContain(
        '/var/lib/cloudgate/ssh/auto_generated-cloudgate-local.pub',
      );
      expect(printed).not.toContain('/etc/cloudgate/ssh');
    });

    it('names the same directory when telling the operator to fix ownership', async () => {
      process.env.CLOUDGATE_DIRECTORY = '/var/lib/cloudgate';
      setupSshKey.mockRejectedValue(new Error('EACCES: Permission denied'));

      try {
        await gateway.handleConnection(
          ws,
          request('/terminal?serverId=local&port=22&username=root'),
        );
      } finally {
        delete process.env.CLOUDGATE_DIRECTORY;
      }

      const printed = ws.send.mock.calls.map(([frame]) => frame).join('');
      expect(printed).toContain('chown -R $USER:$USER /var/lib/cloudgate/ssh');
    });

    it('ends every line it writes itself with a carriage return', async () => {
      // The emulator runs `convertEol: false` because a pty already sends CRLF,
      // so a bare LF from the gateway drops the cursor without returning the
      // carriage and the eight-line `authorized_keys` block staircased across
      // the screen — unreadable, and unpastable, which is the one thing it is
      // for.
      open.mockRejectedValue(
        Object.assign(new Error('nope'), { level: 'client-authentication' }),
      );

      await gateway.handleConnection(
        ws,
        request('/terminal?serverId=local&port=22&username=root'),
      );

      const printed = ws.send.mock.calls.map(([frame]) => frame).join('');
      expect(printed).toContain('authorized_keys');
      expect(printed).toMatch(/\r\n/);
      // Every LF is preceded by a CR: a lone one is the defect.
      expect(printed).not.toMatch(/(^|[^\r])\n/);
    });
  });

  /**
   * The helper the frames above go through, on its own: the two multi-line
   * command templates are converted without being edited, so what has to hold
   * is that converting is safe to do twice.
   */
  describe('terminalLine', () => {
    it('gives a bare newline its carriage return', () => {
      expect(terminalLine('one\ntwo\n')).toBe('one\r\ntwo\r\n');
    });

    it('leaves text that is already CRLF alone', () => {
      expect(terminalLine('one\r\ntwo\r\n')).toBe('one\r\ntwo\r\n');
      expect(terminalLine(terminalLine('one\ntwo'))).toBe(
        terminalLine('one\ntwo'),
      );
    });

    it('cannot alter text with no newlines in it', () => {
      expect(terminalLine('\x1bc')).toBe('\x1bc');
    });
  });

  /**
   * The console keeps its own copy of these numbers — a browser cannot import
   * from `backend/src`, and `LEASE_CLOSE_CODE` is already duplicated the same
   * way. A copy that drifts is a sentence about the wrong thing, silently, so
   * the copy is pinned from the side that owns the values — the
   * technique `backend/test/servers/server-setup.spec.ts` uses for
   * `deploy/install.sh`, for the same reason: nothing in the other file can pin
   * itself.
   *
   * `shellClosed` is in the mirror: the header's pill reads it to
   * tell a shell that ended from a session that never connected, so it feeds
   * the console now as well as `refusalSentence`'s codes do.
   */
  describe('the console’s copy of the close codes', () => {
    const mirror = fs.readFileSync(
      path.join(__dirname, '../../../frontend/src/lib/realtime/terminals.ts'),
      'utf8',
    );

    it.each(Object.entries(TERMINAL_CLOSE))(
      'names %s with the same number the gateway closes with',
      (name, code) => {
        expect(mirror).toContain(`${name}: ${code},`);
      },
    );

    /**
     * `UNREACHABLE_CLOSE_CODE` joined this list later than the change that
     * minted the value: the mirror did not exist yet, so the assertion would
     * have been red the day it was written, and that change left the console
     * half out on purpose rather than pin a copy that was not there. The list
     * in `terminals.ts`'s own docblock over `TERMINAL_CLOSE` was stale for the
     * same window — it said `/docker-container-terminal` closes only `4000`,
     * `4003`, `4010` and `1005` — and that list is what `refusalSentence` is
     * written against, so a code missing from it is a close frame with no
     * words.
     */
    it('carries the shell-open frame byte for byte', () => {
      // The console writes it as a source literal; the value is this one.
      expect(SHELL_OPEN_FRAME).toBe('\x00{"shell":"open"}');
      expect(mirror).toContain(`SHELL_OPEN_FRAME = '\\x00{"shell":"open"}'`);
    });

    it('names the three codes from socket-access.ts too', () => {
      expect(mirror).toContain('MALFORMED_CLOSE_CODE = 4000');
      expect(mirror).toContain(`DENIED_CLOSE_CODE = ${DENIED_CLOSE_CODE}`);
      expect(mirror).toContain(
        `UNREACHABLE_CLOSE_CODE = ${UNREACHABLE_CLOSE_CODE}`,
      );
    });

    it('lists the container terminal’s codes without leaving one out', () => {
      // The prose half, pinned from the side that owns the values: the sentence
      // enumerates what `/docker-container-terminal` can close with, and it had
      // gone stale by exactly the unreachable code. Asserting the number is in
      // the sentence is what stops the next code being minted without it.
      const listedCodes = /docker exec` through a pty and closes([^*]*)/.exec(
        mirror,
      );
      expect(listedCodes?.[1]).toContain(String(UNREACHABLE_CLOSE_CODE));
      expect(listedCodes?.[1]).toContain(String(DENIED_CLOSE_CODE));
    });
  });
});
