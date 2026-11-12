import {
  TEARDOWN_STUCK_AFTER_MS,
  TeardownStuckEpisodes,
} from '../../src/preview-deployments/teardown-stuck-episodes';
import type { PendingTeardown } from '../../src/preview-deployments/teardown-stuck-episodes';

/** Every pass is judged at an injected now: the sweep's, never `Date.now`. */
const T0 = new Date('2026-09-23T12:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const pending = (
  previewDeploymentId: string,
  serverId: string | null,
  applicationName = 'Web App',
  organizationId = 'org_1',
): PendingTeardown => ({
  previewDeploymentId,
  serverId,
  organizationId,
  applicationId: `app-${applicationName}`,
  applicationName,
});

describe('TeardownStuckEpisodes', () => {
  it('waits fifteen minutes', () => {
    expect(TEARDOWN_STUCK_AFTER_MS).toBe(15 * 60_000);
  });

  it("opens an episode when a Server's oldest pending teardown has been retried for fifteen minutes, and is silent within it", () => {
    const episodes = new TeardownStuckEpisodes();
    const stuck = [pending('p1', 'srv-a')];

    expect(episodes.observe(stuck, at(0))).toEqual([]);
    expect(episodes.observe(stuck, at(14))).toEqual([]);
    expect(episodes.observe(stuck, at(14.99))).toEqual([]);

    const told = episodes.observe(stuck, at(15));
    expect(told).toEqual([
      {
        serverId: 'srv-a',
        organizationId: 'org_1',
        previews: stuck,
        stuckSince: at(0),
      },
    ]);

    // Within the episode, however long it lasts: nothing.
    for (const minutes of [16, 30, 60, 600]) {
      expect(episodes.observe(stuck, at(minutes))).toEqual([]);
    }
  });

  it('re-arms once the Server has no pending teardowns, and fires again when it sticks again', () => {
    const episodes = new TeardownStuckEpisodes();
    const first = [pending('p1', 'srv-a')];
    episodes.observe(first, at(0));
    expect(episodes.observe(first, at(15))).toHaveLength(1);

    // The Server recovers: a pass with nothing pending on it closes the episode.
    expect(episodes.observe([], at(16))).toEqual([]);

    // It goes away again, with a new leftover; the fifteen minutes start over.
    const second = [pending('p2', 'srv-a')];
    expect(episodes.observe(second, at(20))).toEqual([]);
    expect(episodes.observe(second, at(34))).toEqual([]);
    const again = episodes.observe(second, at(35));
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ serverId: 'srv-a', stuckSince: at(20) });
  });

  it('measures from the oldest teardown still pending, not from one that has gone', () => {
    const episodes = new TeardownStuckEpisodes();
    episodes.observe([pending('old', 'srv-a')], at(0));
    episodes.observe(
      [pending('old', 'srv-a'), pending('new', 'srv-a')],
      at(10),
    );

    // The old one's copy is gone at 12; the new one is five minutes in.
    expect(episodes.observe([pending('new', 'srv-a')], at(12))).toEqual([]);
    expect(episodes.observe([pending('new', 'srv-a')], at(24))).toEqual([]);
    expect(episodes.observe([pending('new', 'srv-a')], at(25))).toHaveLength(1);
  });

  it('names every stuck preview on a Server in one event, two Applications included', () => {
    const episodes = new TeardownStuckEpisodes();
    const stuck = [
      pending('p1', 'srv-a', 'Web App'),
      pending('p2', 'srv-a', 'API'),
      pending('p3', 'srv-a', 'Web App'),
    ];
    episodes.observe(stuck, at(0));

    const told = episodes.observe(stuck, at(15));

    expect(told).toHaveLength(1);
    expect(told[0].previews.map((row) => row.previewDeploymentId)).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
  });

  it('tells two Servers apart: two events, each on its own clock', () => {
    const episodes = new TeardownStuckEpisodes();
    episodes.observe([pending('p1', 'srv-a')], at(0));
    episodes.observe([pending('p1', 'srv-a'), pending('p2', 'srv-b')], at(5));

    const atFifteen = episodes.observe(
      [pending('p1', 'srv-a'), pending('p2', 'srv-b')],
      at(15),
    );
    expect(atFifteen.map((server) => server.serverId)).toEqual(['srv-a']);

    const atTwenty = episodes.observe(
      [pending('p1', 'srv-a'), pending('p2', 'srv-b')],
      at(20),
    );
    expect(atTwenty.map((server) => server.serverId)).toEqual(['srv-b']);
  });

  it('fires two events at once for two Servers stuck together', () => {
    const episodes = new TeardownStuckEpisodes();
    const stuck = [pending('p1', 'srv-a'), pending('p2', 'srv-b')];
    episodes.observe(stuck, at(0));

    expect(
      episodes.observe(stuck, at(15)).map((server) => server.serverId),
    ).toEqual(['srv-a', 'srv-b']);
  });

  it("keeps the platform host apart per Organization, so no Organization hears about another's Applications", () => {
    const episodes = new TeardownStuckEpisodes();
    const stuck = [
      pending('p1', null, 'Web App', 'org_1'),
      pending('p2', null, 'Shop', 'org_2'),
    ];
    episodes.observe(stuck, at(0));

    const told = episodes.observe(stuck, at(15));

    expect(
      told.map((server) => [server.organizationId, server.previews.length]),
    ).toEqual([
      ['org_1', 1],
      ['org_2', 1],
    ]);
  });

  it('re-arms after a restart rather than firing, however long the rows have been pending', () => {
    const stuck = [pending('p1', 'srv-a')];
    const before = new TeardownStuckEpisodes();
    before.observe(stuck, at(0));
    expect(before.observe(stuck, at(15))).toHaveLength(1);

    // A new process: the pending rows are all it has, and they are an hour old.
    const after = new TeardownStuckEpisodes();
    expect(after.observe(stuck, at(60))).toEqual([]);
    expect(after.observe(stuck, at(74))).toEqual([]);
    expect(after.observe(stuck, at(75))).toHaveLength(1);
  });
});
