import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { ForbiddenException, Logger } from '@nestjs/common';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { SshChannelService } from '../../src/realtime/channels/ssh-channel.service';
import {
  CONTAINER_DENIAL_MESSAGE,
  ContainerAccessService,
} from '../../src/realtime/container-access.service';
import { ContainerLogsGateway } from '../../src/realtime/gateways/container-logs.gateway';
import { ContainerTerminalGateway } from '../../src/realtime/gateways/container-terminal.gateway';
import {
  authorizedOrDeny,
  DENIED_CLOSE_CODE,
  DENIED_CLOSE_REASON,
  LEASE_RENEWAL_INTERVAL_MS,
  UNREACHABLE_CLOSE_CODE,
} from '../../src/realtime/socket-access';
import type { WsAuthGuard } from '../../src/realtime/ws-auth.guard';
import type { PermissionService } from '../../src/rbac/permission.service';
import { ExecError } from '../../src/remote/exec-error';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ServersService } from '../../src/servers/servers.service';
import { FakeChannel } from './realtime.fixture';

/**
 * How a container socket ends when the machine was never reached.
 *
 * The socket half of the fix, and the half the issue body does not cover: a
 * `503` does not reach a WebSocket client, and both container gateways wrap
 * `authorizeContainer` in a **blanket catch** that answered
 * `4003 Not found or not permitted` — so an unreachable Server's containers
 * were refused with an *authorization* claim about a machine nothing spoke to,
 * which is the defect this issue names, on the two sharpest of the three
 * sockets.
 *
 * Unit rather than e2e, the shape `server-terminal-close.spec.ts` established
 * for the same kind of question: what is under test is the **close contract**,
 * which needs no server row and no database to be true. The one thing that is
 * *not* doubled is the gate itself — `ContainerAccessService` is the real class
 * over a rejecting exec boundary, so these cases exercise
 * `resolveTarget` → `rethrowIfHostUnreachable` → the gateway's catch end to
 * end. A hand-built `ServiceUnavailableException` would have asserted this
 * file's idea of what the gate throws (§1.7); `db` and `permissions` are `{}`
 * because the resolution fails before either is touched, and a case that
 * reached them would fail loudly rather than quietly pass.
 *
 * The two arms are asserted **beside each other** throughout, because the
 * pairing is the security property: a Server that answered still refuses
 * byte-identically (ADR-0008), and only a Server that never answered gets
 * the new frame.
 */

/** A ws client double: an EventEmitter for the close wiring, spies for the rest. */
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

const SERVER_ID = 'srv_unreachable';
const CONTAINER_ID = 'abc123';

/**
 * What `execRemote` rejects with off the `ssh2` client's `'error'` event: the
 * command never reached a shell, so there is no exit code to carry. A Server
 * pointed at a closed port produces exactly this, in milliseconds.
 */
const sshRefused = () =>
  new ExecError('SSH connection error: connect ECONNREFUSED 203.0.113.10:22', {
    command: 'docker inspect',
    serverId: SERVER_ID,
  });

/** What it rejects with when `docker` ran and answered: the status is on it. */
const dockerSaidNo = () =>
  new ExecError('Remote command failed with exit code 1', {
    command: 'docker inspect',
    serverId: SERVER_ID,
    exitCode: 1,
    stderr: 'Error: No such container: abc123',
  });

/** The real gate, over an exec boundary that rejects with `error`. */
const gateRejecting = (error: unknown): ContainerAccessService => {
  const reject = jest.fn().mockRejectedValue(error);
  return new ContainerAccessService({} as DrizzleDB, {} as PermissionService, {
    execAsync: reject,
    execAsyncRemote: reject,
    execFileAsync: reject,
    execRemote: reject,
  });
};

/** A gate that refuses the way an ownership or entitlement failure refuses. */
const gateRefusing = (): ContainerAccessService =>
  ({
    authorizeContainer: jest
      .fn()
      .mockRejectedValue(new ForbiddenException(CONTAINER_DENIAL_MESSAGE)),
  }) as unknown as ContainerAccessService;

describe('closeIfHostUnreachable, through the sockets that call it', () => {
  let ws: FakeWs;
  let warn: jest.SpyInstance;
  let open: jest.Mock;
  let spawn: jest.Mock;
  let findOne: jest.Mock;

  /** Every line this socket left in the journal. */
  const journal = () => warn.mock.calls.map(([line]) => String(line));

  /** The one close frame the socket ended with. */
  const closedWith = () => ws.close.mock.calls.at(-1);

  beforeEach(() => {
    ws = new FakeWs();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    open = jest.fn().mockResolvedValue(new FakeChannel());
    spawn = jest.fn().mockReturnValue(new FakeChannel());
    // A Server the caller may reach: the machine check passes and the socket
    // gets as far as inspecting the container, which is where these cases are.
    findOne = jest.fn().mockResolvedValue({
      serverId: SERVER_ID,
      organizationId: 'org_1',
      sshKeyId: 'key_1',
    });
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const wsAuth = () =>
    ({
      authenticate: jest.fn().mockResolvedValue(auth),
      assertStillAuthenticated: jest.fn().mockResolvedValue(undefined),
    }) as unknown as WsAuthGuard;

  const logsGateway = (containerAccess: ContainerAccessService) =>
    new ContainerLogsGateway(
      wsAuth(),
      { findOne } as unknown as ServersService,
      containerAccess,
      { open } as unknown as SshChannelService,
      { spawn },
      {} as RemoteExecService,
      LEASE_RENEWAL_INTERVAL_MS,
    );

  const terminalGateway = (containerAccess: ContainerAccessService) =>
    new ContainerTerminalGateway(
      wsAuth(),
      { findOne } as unknown as ServersService,
      containerAccess,
      { open } as unknown as SshChannelService,
      { spawn },
      LEASE_RENEWAL_INTERVAL_MS,
    );

  /** The two container-addressed sockets, dialled at one Server's container. */
  const sockets: [
    string,
    (access: ContainerAccessService) => Promise<void>,
    (access: ContainerAccessService) => Promise<void>,
  ][] = [
    [
      'logs',
      (access) =>
        logsGateway(access).handleConnection(
          ws,
          request(
            `/docker-container-logs?containerId=${CONTAINER_ID}&serverId=${SERVER_ID}`,
          ),
        ),
      (access) =>
        logsGateway(access).handleConnection(
          ws,
          request(`/docker-container-logs?containerId=${CONTAINER_ID}`),
        ),
    ],
    [
      'terminal',
      (access) =>
        terminalGateway(access).handleConnection(
          ws,
          request(
            `/docker-container-terminal?containerId=${CONTAINER_ID}&serverId=${SERVER_ID}`,
          ),
        ),
      (access) =>
        terminalGateway(access).handleConnection(
          ws,
          request(`/docker-container-terminal?containerId=${CONTAINER_ID}`),
        ),
    ],
  ];

  describe.each(sockets)('the %s socket', (_name, dialAtServer, dialAtHost) => {
    it('closes with the unreachable code and the host’s own sentence', async () => {
      await dialAtServer(gateRejecting(sshRefused()));

      expect(closedWith()).toEqual([
        UNREACHABLE_CLOSE_CODE,
        'This Server could not be reached',
      ]);
      // Nothing was started on any machine, exactly as for a denial: this is a
      // different answer, not a laxer gate.
      expect(open).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    /**
     * **This case is the whole of what the platform host's own code cost the
     * socket half, and it caught it.** That change gave the platform host a
     * code of its own so the console could stop saying the Server sentence
     * about it — and `closeIfHostUnreachable` reaches the same exception
     * through `isHostUnreachable`, which asked for `HOST_UNREACHABLE` by name.
     * So the moment the second code existed this frame went back to `[4003,
     * "Not found or not permitted"]`: an authorization claim about a machine
     * nothing spoke to, on a container the platform host runs, which is exactly
     * the defect the unreachable code removed. The guard reads either arm now,
     * through `isUnreachableCode`.
     *
     * The *reason* needed nothing, and that is an earlier decision paying off:
     * the wire reason is the exception's own message rather than a constant
     * here, so it followed the split for free and still cannot drift from what
     * the routes say.
     */
    it('names the platform host when the target is on it', async () => {
      await dialAtHost(gateRejecting(sshRefused()));

      expect(closedWith()).toEqual([
        UNREACHABLE_CLOSE_CODE,
        'The platform host could not be reached',
      ]);
      // Named rather than merely not-4003, so a later edit cannot satisfy this
      // by inventing a third frame.
      expect(closedWith()).not.toEqual([
        DENIED_CLOSE_CODE,
        DENIED_CLOSE_REASON,
      ]);
      expect(open).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('still refuses byte-identically when the Server answered', async () => {
      // The pairing is the security property: an ownership or
      // entitlement failure on a *reachable* machine is unchanged, and the two
      // are asserted in one file so a widening cannot be introduced without
      // one of them going red.
      await dialAtServer(gateRefusing());

      expect(closedWith()).toEqual([DENIED_CLOSE_CODE, DENIED_CLOSE_REASON]);
      expect(open).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('still refuses when docker ran and said no such container', async () => {
      // The case that catches a fix written as "any exec rejection is a
      // transport failure": `docker` was reached, ran, and exited nonzero, so
      // the resolution *happened* and its outcome is a denial.
      await dialAtServer(gateRejecting(dockerSaidNo()));

      expect(closedWith()).toEqual([DENIED_CLOSE_CODE, DENIED_CLOSE_REASON]);
    });

    it('still refuses a rejection that did not come from the exec layer', async () => {
      // `isTransportFailure` reads a non-`ExecError` as "not a transport
      // failure" deliberately — it says nothing about the transport — and this
      // is the shape the existing e2e pins reject with.
      await dialAtServer(gateRejecting(new Error('no such container')));

      expect(closedWith()).toEqual([DENIED_CLOSE_CODE, DENIED_CLOSE_REASON]);
    });

    it('keeps the reason inside the 123 bytes a close frame allows', async () => {
      await dialAtServer(gateRejecting(sshRefused()));

      const reason = closedWith()?.[1] ?? '';
      expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(123);
    });

    it('attributes the socket without repeating the host’s words, and denies nobody', async () => {
      await dialAtServer(gateRejecting(sshRefused()));

      // Two lines, one failure, and neither is the other's copy: the gate wrote
      // the host's own words (an SSH error, which §2.5 keeps off the wire) and
      // the socket wrote which caller was on it. `Refused socket:` stays the
      // count of callers who were denied something, and this caller was not.
      expect(
        journal().filter((line) => line.startsWith('Unreachable socket:')),
      ).toEqual([
        `Unreachable socket: container ${CONTAINER_ID} for user user_1 in organization org_1`,
      ]);
      expect(
        journal().filter((line) => line.startsWith('Refused socket:')),
      ).toEqual([]);
      expect(journal().join('\n')).toContain('ECONNREFUSED');
      // And the gate's own reachable-arm line is not also written for it.
      expect(journal().join('\n')).not.toContain('Could not inspect');
    });

    it('writes the denial line and no unreachable line when the Server answered', async () => {
      await dialAtServer(gateRefusing());

      expect(
        journal().filter((line) => line.startsWith('Refused socket:')),
      ).toEqual([
        expect.stringContaining(`container ${CONTAINER_ID}`) as unknown as
          string | undefined,
      ]);
      expect(journal().join('\n')).not.toContain('Unreachable socket:');
    });
  });

  /**
   * The third container socket reaches its gate through `authorizedOrDeny`
   * rather than a catch of its own, so the guard lives in that helper too — see
   * its docblock for why it is there today rather than the day
   * `/listen-docker-stats-monitoring` grows a `serverId`. Asserted directly
   * because the helper, not a gateway, is what owns the branch.
   */
  describe('authorizedOrDeny', () => {
    const logger = new Logger('unreachable-spec');

    it('closes unreachable rather than refusing, and reports not-authorized', async () => {
      const allowed = await authorizedOrDeny(
        ws,
        logger,
        auth,
        'appName my-app',
        () => gateRejecting(sshRefused()).resolveTarget({ containerId: 'x' }),
      );

      expect(allowed).toBe(false);
      expect(closedWith()).toEqual([
        UNREACHABLE_CLOSE_CODE,
        'The platform host could not be reached',
      ]);
    });

    it('still turns a denial into the one refusal frame', async () => {
      const allowed = await authorizedOrDeny(
        ws,
        logger,
        auth,
        'appName x',
        () => Promise.reject(new ForbiddenException(CONTAINER_DENIAL_MESSAGE)),
      );

      expect(allowed).toBe(false);
      expect(closedWith()).toEqual([DENIED_CLOSE_CODE, DENIED_CLOSE_REASON]);
    });
  });
});
