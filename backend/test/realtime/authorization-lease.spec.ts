import { EventEmitter } from 'node:events';
import {
  ForbiddenException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  armAuthorizationLease,
  armKeepAlive,
  KEEP_ALIVE_INTERVAL_MS,
  LEASE_CLOSE_CODE,
  LEASE_CLOSE_REASON,
  LEASE_RENEWAL_INTERVAL_MS,
  leaseDurationMs,
} from '../../src/realtime/socket-access';
import type { LeaseCaller } from '../../src/realtime/socket-access';

/**
 * The lifecycle of an authorization lease (ADR-0012).
 *
 * Unit rather than e2e, and with fake timers: the property under test is a
 * *duration* — "no socket sends a frame more than one lease past the last
 * authorization that actually succeeded" — and the only way to assert a
 * two-minute promise without waiting two minutes is to own the clock. What a
 * real socket dialling a real gateway does is `gateway-leases.e2e-spec.ts`;
 * this file is the timer, the two kinds of thrown error, and the arithmetic
 * between them.
 */

/** A ws client double: an EventEmitter for the close wiring, spies for the rest. */
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

/** The caller a lease is held for, as the gateways hand one over. */
const caller: LeaseCaller = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
  credential: { kind: 'session', sessionId: 'session-1' },
};

const interval = 1_000;
const duration = leaseDurationMs(interval);

describe('armAuthorizationLease', () => {
  let ws: FakeWs;
  let logger: Logger;
  let journal: jest.SpyInstance;
  let assertStillAuthenticated: jest.Mock<Promise<void>, [unknown]>;
  let authorize: jest.Mock<Promise<unknown>, []>;

  beforeEach(() => {
    jest.useFakeTimers();
    ws = new FakeWs();
    logger = new Logger('lease-spec');
    journal = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    assertStillAuthenticated = jest.fn<Promise<void>, [unknown]>();
    authorize = jest.fn<Promise<unknown>, []>();
    assertStillAuthenticated.mockResolvedValue(undefined);
    authorize.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    journal.mockRestore();
  });

  function arm() {
    armAuthorizationLease({
      ws,
      logger,
      caller,
      subject: 'deployment dep-1',
      renewalIntervalMs: interval,
      credentials: { assertStillAuthenticated },
      authorize,
    });
  }

  /** The lines a lease writes, which is where the specific cause lives. */
  const lines = () => journal.mock.calls.map(([message]) => String(message));

  it('re-runs the credential read and the authorization on every interval', async () => {
    arm();

    await jest.advanceTimersByTimeAsync(interval * 3);

    expect(assertStillAuthenticated).toHaveBeenCalledTimes(3);
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(assertStillAuthenticated).toHaveBeenLastCalledWith(caller);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('renews nothing before the first interval has passed', async () => {
    arm();

    await jest.advanceTimersByTimeAsync(interval - 1);

    expect(authorize).not.toHaveBeenCalled();
  });

  it('closes 4010 when the authorization is refused', async () => {
    authorize.mockRejectedValue(new ForbiddenException('Permission denied'));
    arm();

    await jest.advanceTimersByTimeAsync(interval);

    expect(ws.close).toHaveBeenCalledWith(LEASE_CLOSE_CODE, LEASE_CLOSE_REASON);
    expect(LEASE_CLOSE_CODE).toBe(4010);
    expect(LEASE_CLOSE_REASON).toBe('No longer authorized');
  });

  it('closes 4010 when the credential the socket holds is gone', async () => {
    assertStillAuthenticated.mockRejectedValue(
      new UnauthorizedException('The session has been revoked'),
    );
    arm();

    await jest.advanceTimersByTimeAsync(interval);

    expect(ws.close).toHaveBeenCalledWith(LEASE_CLOSE_CODE, LEASE_CLOSE_REASON);
    // The credential is read first, so a revoked caller is never asked about
    // entitlement — there is nobody left to be entitled.
    expect(authorize).not.toHaveBeenCalled();
  });

  // Nothing is written into the stream before the close: one sentence fits the
  // close frame, and a server-authored line in a log buffer is indistinguishable
  // from something `tail` printed (ADR-0012).
  it('writes no frame into the stream on the way to refusing it', async () => {
    authorize.mockRejectedValue(new ForbiddenException('Permission denied'));
    arm();

    await jest.advanceTimersByTimeAsync(interval);

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('stops renewing once the lease has ended', async () => {
    authorize.mockRejectedValue(new ForbiddenException('Permission denied'));
    arm();

    await jest.advanceTimersByTimeAsync(interval * 5);

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it('stops renewing once the socket has closed on its own', async () => {
    arm();

    await jest.advanceTimersByTimeAsync(interval);
    ws.close();
    await jest.advanceTimersByTimeAsync(interval * 5);

    expect(authorize).toHaveBeenCalledTimes(1);
  });

  /**
   * The split ADR-0005 already draws: an `HttpException` is the system saying
   * no, and anything else is the system failing to answer. Failing closed on a
   * database blip would drop every terminal in the instance mid-command and buy
   * nothing, because the attacker redials into a `handleConnection` that fails
   * closed against the same broken database.
   */
  describe('a renewal that fails rather than refuses', () => {
    it('leaves the socket open and says so in the journal', async () => {
      authorize.mockRejectedValue(new Error('connection terminated'));
      arm();

      await jest.advanceTimersByTimeAsync(interval);

      expect(ws.close).not.toHaveBeenCalled();
      expect(lines().join('\n')).toContain('connection terminated');
    });

    it('ends the lease once the duration passes with none succeeding', async () => {
      authorize.mockRejectedValue(new Error('connection terminated'));
      arm();

      await jest.advanceTimersByTimeAsync(duration - interval);
      expect(ws.close).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(interval);
      expect(ws.close).toHaveBeenCalledWith(
        LEASE_CLOSE_CODE,
        LEASE_CLOSE_REASON,
      );
    });

    it('is forgotten by a renewal that succeeds after it', async () => {
      authorize.mockRejectedValueOnce(new Error('connection terminated'));
      authorize.mockRejectedValueOnce(new Error('connection terminated'));
      authorize.mockResolvedValueOnce(undefined);
      authorize.mockRejectedValue(new Error('connection terminated'));
      arm();

      // Two failures, one success, then failures again: the lease runs from the
      // success, so it is still standing where an un-reset one would have gone.
      await jest.advanceTimersByTimeAsync(duration + interval);

      expect(ws.close).not.toHaveBeenCalled();
      expect(authorize).toHaveBeenCalledTimes(5);
    });

    it('lets the credential read fail without ending the lease either', async () => {
      assertStillAuthenticated.mockRejectedValue(new Error('pool timeout'));
      arm();

      await jest.advanceTimersByTimeAsync(interval);

      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  /**
   * One renewal at a time. A database slow enough to span a tick would
   * otherwise have a second renewal queued behind the first, and the cost of an
   * outage would be multiplied by how long it lasted.
   */
  it('does not stack a second renewal on a first still in flight', async () => {
    authorize.mockReturnValue(new Promise(() => undefined));
    arm();

    await jest.advanceTimersByTimeAsync(duration - interval);

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(ws.close).not.toHaveBeenCalled();
  });

  /**
   * And the lease still expires behind it. A renewal that never *settles* — a
   * query hung on an exhausted pool with no statement timeout — is the case
   * where holding one attempt at a time could have held the socket open for as
   * long as the hang lasted, which is the connect-only authorization defect
   * again with a hang as the trigger
   * instead of time. The duration is a promise about the last authorization
   * that succeeded, not about attempts made.
   */
  it('expires on time even while a renewal is still hanging', async () => {
    authorize.mockReturnValue(new Promise(() => undefined));
    arm();

    await jest.advanceTimersByTimeAsync(duration);

    expect(authorize).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledWith(LEASE_CLOSE_CODE, LEASE_CLOSE_REASON);
  });

  /**
   * The wire carries one reason for every way a lease can end; the journal
   * carries which one it was, prefixed so an operator can grep an expired lease
   * apart from a refusal at connect (`Refused socket:`).
   */
  describe('the journal', () => {
    it('names the caller, their organization and the specific cause', async () => {
      authorize.mockRejectedValue(
        new ForbiddenException("You don't have access to this service"),
      );
      arm();

      await jest.advanceTimersByTimeAsync(interval);

      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toBe(
        "Lease ended: deployment dep-1: You don't have access to this service" +
          ' for user user-1 in organization org-1',
      );
    });

    it('says an expired lease expired rather than that it was refused', async () => {
      authorize.mockRejectedValue(new Error('connection terminated'));
      arm();

      await jest.advanceTimersByTimeAsync(duration);

      const ended = lines().filter((line) => line.startsWith('Lease ended:'));
      expect(ended).toHaveLength(1);
      expect(ended[0]).toContain(`no renewal has succeeded for ${duration}ms`);
    });

    it('never carries the credential itself, only what it was for', async () => {
      authorize.mockRejectedValue(new ForbiddenException('Permission denied'));
      arm();

      await jest.advanceTimersByTimeAsync(interval);

      expect(lines().join('\n')).not.toContain('session-1');
    });
  });
});

/**
 * Whether the peer is still there.
 *
 * The other timer in `socket-access.ts`, and the reason it exists: nothing in
 * the realtime module could tell a live peer from a vanished one. Neither of the
 * two pings that existed registered a `'pong'` listener, so both were
 * write-only — they held sockets open past the proxy idle timeout that would
 * otherwise have ended them, and a stats socket kept spawning a `docker stats`
 * subprocess every 1300ms for nine minutes after its tab was closed.
 *
 * Fake timers for the same reason the lease uses them: what is under test is a
 * duration.
 */
describe('armKeepAlive', () => {
  let ws: FakeWs;
  let logger: Logger;
  let journal: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    ws = new FakeWs();
    logger = new Logger('keep-alive-spec');
    journal = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    journal.mockRestore();
  });

  /**
   * Armed the way a gateway arms one: the three journal fields are copied off
   * the `armAuthorizationLease` call directly above it in every gateway, so the
   * subject reads the same whichever event mentions the socket.
   */
  const arm = () =>
    armKeepAlive({
      ws,
      logger,
      caller,
      subject: 'appName my-app',
      intervalMs: interval,
    });

  /** Every line this keep-alive wrote. */
  const lines = () => journal.mock.calls.map(([message]) => String(message));

  it('pings the peer once an interval', () => {
    arm();

    for (let round = 0; round < 3; round += 1) {
      jest.advanceTimersByTime(interval);
      ws.emit('pong');
    }

    expect(ws.ping).toHaveBeenCalledTimes(3);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('pings nothing before the first interval has passed', () => {
    arm();

    jest.advanceTimersByTime(interval - 1);

    expect(ws.ping).not.toHaveBeenCalled();
  });

  it('keeps a peer that answers', () => {
    arm();

    for (let round = 0; round < 10; round += 1) {
      jest.advanceTimersByTime(interval);
      ws.emit('pong');
    }

    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(ws.OPEN);
  });

  it('terminates a peer that stops answering', () => {
    arm();

    // One ping goes out and nothing answers it, so the next tick gives up.
    jest.advanceTimersByTime(interval);
    expect(ws.terminate).not.toHaveBeenCalled();

    jest.advanceTimersByTime(interval);

    expect(ws.terminate).toHaveBeenCalledTimes(1);
    // `terminate()`, not `close()`: a peer that cannot answer a ping cannot
    // answer a close handshake either, and waiting for one is the defect.
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('gives a peer that has been answering a whole interval of grace', () => {
    arm();

    jest.advanceTimersByTime(interval);
    ws.emit('pong');
    // The peer goes quiet here. The next tick pings again rather than giving up:
    // a live-but-slow peer killed mid-build is the failure mode to fear, so the
    // grace is a whole interval rather than a fraction of one.
    jest.advanceTimersByTime(interval);
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.ping).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(interval);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it('stops pinging once the peer has been terminated', () => {
    arm();

    jest.advanceTimersByTime(interval * 10);

    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(ws.ping).toHaveBeenCalledTimes(1);
  });

  it('stops pinging once the socket has closed on its own', () => {
    arm();

    ws.close();
    jest.advanceTimersByTime(interval * 10);

    expect(ws.ping).not.toHaveBeenCalled();
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('records the reap in the journal, naming what was being followed and for whom', () => {
    // The reap was the one thing in this module with no operator-visible trace
    // `clearInterval` then `terminate()`, and nothing in the journal at
    // the moment the socket died — so a peer that vanished and a tab that was
    // closed read identically, and the *count* of the first, which is what says
    // a proxy is dropping browser legs, was recorded nowhere.
    arm();

    jest.advanceTimersByTime(interval * 2);

    expect(ws.terminate).toHaveBeenCalledTimes(1);
    // The whole line, not a substring: the shape is the deliverable. `Reaped`
    // rather than `Refused` is what keeps the two greps countable apart, and
    // `intervalMs` rather than the 2× bound is the window that actually passed
    // unanswered.
    expect(lines()).toEqual([
      expect.stringMatching(
        /^Reaped socket: appName my-app: no pong within 1000ms for user user-1 in organization org-1$/,
      ),
    ]);
  });

  it('says nothing when the peer closes cleanly', () => {
    // The other half of the same value: a routine tab close is deliberately
    // silent, or `grep -c 'Reaped socket:'` counts users leaving rather than
    // sockets being dropped underneath them.
    arm();

    ws.close();
    jest.advanceTimersByTime(interval * 10);

    expect(lines()).toEqual([]);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('writes nothing to the wire', () => {
    // The line is the operator's record, not the caller's — the same promise
    // the lease keeps, for the same reason: a server-authored frame in a log
    // buffer is indistinguishable from something the stream itself printed.
    arm();

    jest.advanceTimersByTime(interval * 2);

    expect(ws.send).not.toHaveBeenCalled();
    expect(lines().join('\n')).not.toContain('session-1');
  });
});

/**
 * Neither number is operator configuration (ADR-0012): they are constants, and
 * the interval is what the DI token defaults to. 30 seconds is chosen against
 * the 45-second keep-alive ping that makes an otherwise-dead socket immortal,
 * so a renewal always runs at least once between two pings.
 */
describe('LEASE_RENEWAL_INTERVAL_MS and leaseDurationMs', () => {
  it('renews inside the keep-alive ping interval of 45 seconds', () => {
    expect(LEASE_RENEWAL_INTERVAL_MS).toBe(30_000);
    expect(LEASE_RENEWAL_INTERVAL_MS).toBeLessThan(45_000);
  });

  it('lasts two minutes, which is four consecutive failed renewals', () => {
    expect(leaseDurationMs(LEASE_RENEWAL_INTERVAL_MS)).toBe(120_000);
    expect(leaseDurationMs(LEASE_RENEWAL_INTERVAL_MS)).toBe(
      LEASE_RENEWAL_INTERVAL_MS * 4,
    );
  });

  // The ordering ADR-0012 rests on, now that all six gateways arm the ping and
  // not just `container-logs`. Pinned against the constant rather than
  // against 45_000 written twice, so moving one moves the assertion.
  it('renews below the keep-alive interval the module now shares', () => {
    expect(KEEP_ALIVE_INTERVAL_MS).toBe(45_000);
    expect(LEASE_RENEWAL_INTERVAL_MS).toBeLessThan(KEEP_ALIVE_INTERVAL_MS);
  });
});
