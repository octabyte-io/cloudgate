import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Logger } from '@nestjs/common';
import { quote } from 'shell-quote';
import type { SshChannelService } from '../../src/realtime/channels/ssh-channel.service';
import type { ContainerAccessService } from '../../src/realtime/container-access.service';
import {
  ContainerTerminalGateway,
  reapScript,
  TERMINAL_SESSION_VARIABLE,
} from '../../src/realtime/gateways/container-terminal.gateway';
import { LEASE_RENEWAL_INTERVAL_MS } from '../../src/realtime/socket-access';
import type { WsAuthGuard } from '../../src/realtime/ws-auth.guard';
import type { ServersService } from '../../src/servers/servers.service';
import { FakeChannel } from './realtime.fixture';

/**
 * Closing a container shell ends what it started inside the container.
 *
 * The dialog says "Closing this window ends the session", and it closed the
 * socket and the channel — which hangs up the **`docker exec` client** and
 * nothing else. Docker does not pass that hangup on: the shell it started stays
 * attached to a pty dockerd holds open, with anything left running in it, one
 * more per open, until the container restarts. Measured on a real `alpine` and
 * a real `debian` container, both branches' argv, before and after.
 *
 * So each shell is started with a variable naming its session, which every
 * process started from it inherits, and a close runs a second `docker exec`
 * that hangs up — then kills — every process in the container carrying that
 * session's value, and no other. These drive `handleConnection` with doubles
 * and pin that pairing; what the reaper script does to a real container is in
 * the ticket's comment and the gateway's docstring.
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

const SERVER_ID = 'srv_1';
const CONTAINER_ID = 'abc123';

/**
 * The value the shell's command gave its session variable. The `\\?` is
 * `quote()`'s escape of the `=`, which the SSH branch's string carries and the
 * pty branch's argv does not.
 */
const sessionIn = (argv: string): string => {
  const match = new RegExp(
    `-e ${TERMINAL_SESSION_VARIABLE}\\\\?=([0-9a-f]+) `,
  ).exec(argv);
  if (!match) throw new Error(`no session variable in: ${argv}`);
  return match[1];
};

type OpenArgs = [unknown, { command: string; pty?: boolean }];
type SpawnArgs = [string, string[]];

/** Let the reaper's promise chain run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('reapScript', () => {
  const session = '0123456789abcdef0123456789abcdef';

  /**
   * The script has to parse, which none of the argv assertions below can see:
   * its first draft lacked the `;` after `m=…`, so every shell read `for` as an
   * argument and refused the line — and every gateway case still passed.
   * `sh -n` parses without running, so this needs no container and no `/proc`.
   */
  it('parses as POSIX sh, alone and as the SSH branch quotes it', () => {
    const script = reapScript(session);
    expect(() =>
      execFileSync('sh', ['-n', '-c', script], { stdio: 'pipe' }),
    ).not.toThrow();
    expect(() =>
      execFileSync(
        'sh',
        ['-n', '-c', quote(['docker', 'exec', 'abc123', 'sh', '-c', script])],
        { stdio: 'pipe' },
      ),
    ).not.toThrow();
  });

  it("hangs up, then kills, the processes carrying this session's value", () => {
    const script = reapScript(session);
    expect(script).toContain(`${TERMINAL_SESSION_VARIABLE}=${session}`);
    expect(script).toContain('for s in HUP KILL');
  });
});

describe('ContainerTerminalGateway ends the shell it started', () => {
  let ws: FakeWs;
  let open: jest.Mock<Promise<FakeChannel>, OpenArgs>;
  let spawn: jest.Mock<FakeChannel, SpawnArgs>;
  let warn: jest.SpyInstance;
  let authorizeContainer: jest.Mock<Promise<string[]>, unknown[]>;
  let gateway: ContainerTerminalGateway;

  beforeEach(() => {
    ws = new FakeWs();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    open = jest.fn<Promise<FakeChannel>, OpenArgs>(() =>
      Promise.resolve(new FakeChannel()),
    );
    spawn = jest.fn<FakeChannel, SpawnArgs>(() => new FakeChannel());
    authorizeContainer = jest
      .fn<Promise<string[]>, unknown[]>()
      .mockResolvedValue(['web']);
    gateway = new ContainerTerminalGateway(
      {
        authenticate: jest.fn().mockResolvedValue(auth),
        assertStillAuthenticated: jest.fn().mockResolvedValue(undefined),
      } as unknown as WsAuthGuard,
      {
        findOne: jest.fn().mockResolvedValue({
          serverId: SERVER_ID,
          organizationId: 'org_1',
          sshKeyId: 'key_1',
        }),
      } as unknown as ServersService,
      {
        authorizeContainer,
        authorizeAppNames: jest.fn().mockResolvedValue(undefined),
      } as unknown as ContainerAccessService,
      { open } as unknown as SshChannelService,
      { spawn },
      LEASE_RENEWAL_INTERVAL_MS,
    );
  });

  afterEach(() => {
    ws.close();
    warn.mockRestore();
  });

  describe('on a Server, over SSH', () => {
    const connect = () =>
      gateway.handleConnection(
        ws,
        request(
          `/docker-container-terminal?containerId=${CONTAINER_ID}&serverId=${SERVER_ID}`,
        ),
      );

    it('kills the processes of this session, and only after the socket closes', async () => {
      await connect();

      expect(open).toHaveBeenCalledTimes(1);
      const [target, options] = open.mock.calls[0];
      expect(target).toEqual({ serverId: SERVER_ID });
      expect(options.pty).toBe(true);
      const session = sessionIn(options.command);
      expect(session).toMatch(/^[0-9a-f]{32}$/);
      expect(options.command).toBe(
        quote([
          'docker',
          'exec',
          '-it',
          '-e',
          `${TERMINAL_SESSION_VARIABLE}=${session}`,
          '-w',
          '/',
          CONTAINER_ID,
          'sh',
        ]),
      );

      ws.close();
      await settle();

      expect(open).toHaveBeenCalledTimes(2);
      const [reapTarget, reapOptions] = open.mock.calls[1];
      expect(reapTarget).toEqual({ serverId: SERVER_ID });
      // One-shot, no terminal, in the same container with the same shell.
      expect(reapOptions.pty).toBeFalsy();
      expect(reapOptions.command).toBe(
        quote([
          'docker',
          'exec',
          CONTAINER_ID,
          'sh',
          '-c',
          reapScript(session),
        ]),
      );
    });

    it('gives every shell its own session, so one close cannot end another', async () => {
      await connect();
      const other = new FakeWs();
      await gateway.handleConnection(
        other,
        request(
          `/docker-container-terminal?containerId=${CONTAINER_ID}&serverId=${SERVER_ID}`,
        ),
      );
      const first = sessionIn(open.mock.calls[0][1].command);
      const second = sessionIn(open.mock.calls[1][1].command);
      expect(first).not.toBe(second);
      other.close();
    });

    it('journals a reaper that could not run rather than throwing', async () => {
      await connect();
      open.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      ws.close();
      await settle();

      expect(
        warn.mock.calls.some(([line]) => String(line).includes('ECONNREFUSED')),
      ).toBe(true);
    });
  });

  describe('on the platform host, through a pty', () => {
    it('kills the processes of this session, and only after the socket closes', async () => {
      await gateway.handleConnection(
        ws,
        request(
          `/docker-container-terminal?containerId=${CONTAINER_ID}&activeWay=bash`,
        ),
      );

      expect(spawn).toHaveBeenCalledTimes(1);
      const [file, argv] = spawn.mock.calls[0];
      expect(file).toBe('docker');
      expect(argv.slice(0, 3)).toEqual(['exec', '-it', '-e']);
      expect(argv.slice(4)).toEqual(['-w', '/', CONTAINER_ID, 'bash']);
      const session = sessionIn(`-e ${argv[3]} `);

      ws.close();
      await settle();

      expect(spawn).toHaveBeenCalledTimes(2);
      const [reapFile, reapArgv] = spawn.mock.calls[1];
      expect(reapFile).toBe('docker');
      expect(reapArgv.slice(0, 4)).toEqual([
        'exec',
        CONTAINER_ID,
        'bash',
        '-c',
      ]);
      expect(reapArgv).toHaveLength(5);
      expect(reapArgv[4]).toContain(`${TERMINAL_SESSION_VARIABLE}=${session}`);
    });
  });

  /**
   * A socket that closed while it was still connecting. Its `'close'`
   * had already fired by the time the shell would have been started, so a
   * reaper hung off it never ran and the shell stayed in the container for good
   * — one per Shell-tab visit under React StrictMode, which opens a socket and
   * closes it straight away, and one per picker change or navigation inside the
   * connect window in production.
   */
  describe('a socket that closes before its shell is open', () => {
    const closeWhileAuthorizing = () =>
      authorizeContainer.mockImplementation(() => {
        ws.close();
        return Promise.resolve(['web']);
      });

    it('starts no shell over SSH', async () => {
      closeWhileAuthorizing();

      await gateway.handleConnection(
        ws,
        request(
          `/docker-container-terminal?containerId=${CONTAINER_ID}&serverId=${SERVER_ID}`,
        ),
      );
      await settle();

      expect(open).not.toHaveBeenCalled();
    });

    it('starts no shell through a pty', async () => {
      closeWhileAuthorizing();

      await gateway.handleConnection(
        ws,
        request(`/docker-container-terminal?containerId=${CONTAINER_ID}`),
      );
      await settle();

      expect(spawn).not.toHaveBeenCalled();
    });

    it('ends the shell that was being opened over SSH when the socket closed', async () => {
      const shell = new FakeChannel();
      open.mockImplementationOnce(() => {
        ws.close();
        return Promise.resolve(shell);
      });

      await gateway.handleConnection(
        ws,
        request(
          `/docker-container-terminal?containerId=${CONTAINER_ID}&serverId=${SERVER_ID}`,
        ),
      );
      await settle();

      expect(shell.close).toHaveBeenCalledTimes(1);
      // And whatever the half-open `docker exec` started is reaped, by its own
      // session, exactly as a close of an open shell would.
      expect(open).toHaveBeenCalledTimes(2);
      const session = sessionIn(open.mock.calls[0][1].command);
      expect(open.mock.calls[1][1].command).toBe(
        quote([
          'docker',
          'exec',
          CONTAINER_ID,
          'sh',
          '-c',
          reapScript(session),
        ]),
      );
      expect(ws.send).not.toHaveBeenCalled();
    });
  });
});
