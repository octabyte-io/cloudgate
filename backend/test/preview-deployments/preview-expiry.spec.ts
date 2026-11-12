import {
  expiredBuildDescription,
  planExpiry,
  tearDownPerServer,
} from '../../src/preview-deployments/preview-expiry';

/** The instant every case is judged at: the injected clock, never `Date.now`. */
const NOW = new Date('2026-09-23T12:00:00.000Z');

const row = (
  previewDeploymentId: string,
  expiresAt: string,
  expiredAt: string | null = null,
) => ({ previewDeploymentId, expiresAt, expiredAt });

describe('planExpiry', () => {
  it('marks exactly the unmarked rows whose expiry has passed at the injected now', () => {
    const plan = planExpiry(
      [
        row('past', '2026-09-23T11:59:59.999Z'),
        row('future', '2026-09-23T12:00:00.001Z'),
        row('long-past', '2026-09-22T00:00:00.000Z'),
      ],
      NOW,
    );
    expect(plan.mark).toEqual(['past', 'long-past']);
  });

  it('marks a row whose expiry is exactly now', () => {
    expect(
      planExpiry([row('now', '2026-09-23T12:00:00.000Z')], NOW).mark,
    ).toEqual(['now']);
  });

  it('never marks a row twice, and tears down every marked row, newly marked or not', () => {
    const plan = planExpiry(
      [
        row('pending', '2026-09-23T11:00:00.000Z', '2026-09-23T11:01:00.000Z'),
        row('fresh', '2026-09-23T11:30:00.000Z'),
        row('alive', '2026-09-23T13:00:00.000Z'),
      ],
      NOW,
    );
    expect(plan.mark).toEqual(['fresh']);
    expect(plan.tearDown).toEqual(['pending', 'fresh']);
  });

  it('keeps tearing down a row a delete marked even when its expiry is later than now', () => {
    // A delete sets the expiry to its own now; a clock a little behind that
    // must not leave the marked row alone.
    const plan = planExpiry(
      [row('killed', '2026-09-23T12:00:05.000Z', '2026-09-23T12:00:05.000Z')],
      NOW,
    );
    expect(plan).toEqual({ mark: [], tearDown: ['killed'] });
  });

  it('moves with the clock: the same rows a minute later expire the one that was still alive', () => {
    const rows = [row('a', '2026-09-23T12:00:30.000Z')];
    expect(planExpiry(rows, NOW).mark).toEqual([]);
    expect(planExpiry(rows, new Date('2026-09-23T12:01:00.000Z')).mark).toEqual(
      ['a'],
    );
  });
});

describe('expiredBuildDescription', () => {
  it('says the build was cancelled because its preview expired, naming the branch', () => {
    expect(expiredBuildDescription('feature/login', 'expiry')).toBe(
      'Requested preview of feature/login, cancelled: the preview expired',
    );
  });

  it('says a delete expired it when a caller deleted the preview', () => {
    expect(expiredBuildDescription('feature/login', 'delete')).toBe(
      'Requested preview of feature/login, cancelled: the preview expired when it was deleted',
    );
  });
});

/**
 * "Each attempt is bounded by the connect timeout so other rows go
 * ahead." One unreachable Server's rows each cost several connect timeouts,
 * so a pass that took every row in turn held every other Server's teardowns
 * behind them.
 */
describe('tearDownPerServer', () => {
  /** A teardown the test finishes by hand, and the order things happened. */
  function held() {
    const events: string[] = [];
    const release = new Map<string, () => void>();
    const work = (row: { id: string; serverId: string | null }) => {
      events.push(`start ${row.id}`);
      return new Promise<void>((resolve) => {
        release.set(row.id, () => {
          events.push(`end ${row.id}`);
          resolve();
        });
      });
    };
    return { events, release, work };
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("starts every Server's first row at once, so one unreachable Server delays no other", async () => {
    const { events, release, work } = held();
    const rows = [
      { id: 'dead-1', serverId: 'dead' },
      { id: 'dead-2', serverId: 'dead' },
      { id: 'live-1', serverId: 'live' },
      { id: 'host-1', serverId: null },
    ];

    const pass = tearDownPerServer(rows, (row) => row.serverId, work);
    await flush();

    expect(events).toEqual(['start dead-1', 'start live-1', 'start host-1']);
    release.get('live-1')?.();
    release.get('host-1')?.();
    await flush();
    // The others are done while the dead Server is still on its first row.
    expect(events).toContain('end live-1');
    expect(events).toContain('end host-1');
    expect(events).not.toContain('start dead-2');

    release.get('dead-1')?.();
    await flush();
    release.get('dead-2')?.();
    await pass;
  });

  it("takes one Server's rows one at a time, in the order they were read", async () => {
    const { events, release, work } = held();
    const rows = [
      { id: 'a-1', serverId: 'a' },
      { id: 'a-2', serverId: 'a' },
    ];

    const pass = tearDownPerServer(rows, (row) => row.serverId, work);
    await flush();
    expect(events).toEqual(['start a-1']);
    release.get('a-1')?.();
    await flush();
    release.get('a-2')?.();
    await pass;

    expect(events).toEqual(['start a-1', 'end a-1', 'start a-2', 'end a-2']);
  });

  it("goes on to a Server's next row when one throws", async () => {
    const seen: string[] = [];
    await tearDownPerServer(
      [
        { id: 'a-1', serverId: 'a' },
        { id: 'a-2', serverId: 'a' },
      ],
      (row) => row.serverId,
      (row) => {
        seen.push(row.id);
        return row.id === 'a-1'
          ? Promise.reject(new Error('unreachable'))
          : Promise.resolve();
      },
    );

    expect(seen).toEqual(['a-1', 'a-2']);
  });
});
