import { RateLimitEpisodeTracker } from '../../src/mcp/rate-limit-episodes';
import type {
  EpisodeClock,
  RateLimitHistory,
} from '../../src/mcp/rate-limit-episodes';
import type { AgentRateLimited } from '../../src/mcp/rate-bucket';

/**
 * The loop signal's "already told" mark: the first 429 of an
 * episode raises the Notification, every 429 inside it stays silent, and the
 * episode closes after an hour with no 429. Driven through the listener port
 * the dispatcher calls, on a clock the test moves by hand; the history (the
 * one audit read after a restart) and the notifier are the two ports it
 * reaches out through.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BOOT = Date.parse('2026-09-21T12:00:00.000Z');

function fakeClock(): EpisodeClock & { advance(ms: number): void } {
  let now = BOOT;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function a429(agentUserId = 'agent-1'): AgentRateLimited {
  return {
    agentUserId,
    organizationId: 'org-1',
    keyId: 'key-1',
    tool: 'list_projects',
    budget: 'read',
    retryAfterSeconds: 1,
  };
}

function setup(previous: Date | null = null) {
  const clock = fakeClock();
  const lastRateLimited = jest
    .fn<ReturnType<RateLimitHistory['lastRateLimited']>, [string, Date, Date]>()
    .mockResolvedValue(previous);
  const history: RateLimitHistory = { lastRateLimited };
  const notified: AgentRateLimited[] = [];
  const notifier = {
    agentRateLimited: jest.fn((event: AgentRateLimited) => {
      notified.push(event);
      return Promise.resolve();
    }),
  };
  const tracker = new RateLimitEpisodeTracker(history, notifier, clock);
  return { clock, lastRateLimited, notified, tracker };
}

describe('RateLimitEpisodeTracker', () => {
  it('raises the Notification at the first 429 of an episode, once', async () => {
    const { clock, notified, tracker } = setup();

    await tracker.rateLimited(a429());
    for (let i = 0; i < 5; i++) {
      clock.advance(10 * MINUTE);
      await tracker.rateLimited(a429());
    }

    expect(notified).toEqual([a429()]);
  });

  it('stays silent while the 429s keep coming, however long the episode runs', async () => {
    const { clock, notified, tracker } = setup();

    await tracker.rateLimited(a429());
    // Three hours of a 429 every 59 minutes: never an hour of quiet.
    for (let i = 0; i < 3; i++) {
      clock.advance(59 * MINUTE);
      await tracker.rateLimited(a429());
    }

    expect(notified).toHaveLength(1);
  });

  it('re-arms after an hour with no 429, counted from the last one', async () => {
    const { clock, notified, tracker } = setup();

    await tracker.rateLimited(a429());
    clock.advance(30 * MINUTE);
    await tracker.rateLimited(a429());
    clock.advance(HOUR - 1);
    await tracker.rateLimited(a429());
    expect(notified).toHaveLength(1);

    clock.advance(HOUR);
    await tracker.rateLimited(a429());
    expect(notified).toHaveLength(2);
  });

  it('keeps one episode per Agent', async () => {
    const { notified, tracker } = setup();

    await tracker.rateLimited(a429('agent-1'));
    await tracker.rateLimited(a429('agent-2'));
    await tracker.rateLimited(a429('agent-1'));

    expect(notified.map((event) => event.agentUserId)).toEqual([
      'agent-1',
      'agent-2',
    ]);
  });

  it('asks the audit trail once per Agent, for a rate-limit refusal from the hour before this process started', async () => {
    const { clock, lastRateLimited, tracker } = setup();
    clock.advance(20 * MINUTE);

    await tracker.rateLimited(a429());
    await tracker.rateLimited(a429());
    clock.advance(2 * HOUR);
    await tracker.rateLimited(a429());

    expect(lastRateLimited).toHaveBeenCalledTimes(1);
    expect(lastRateLimited).toHaveBeenCalledWith(
      'agent-1',
      new Date(BOOT + 20 * MINUTE - HOUR),
      new Date(BOOT),
    );
  });

  it('stays silent after a restart when the episode was already open', async () => {
    const { clock, notified, tracker } = setup(new Date(BOOT - 5 * MINUTE));
    clock.advance(30 * MINUTE);

    await tracker.rateLimited(a429());

    expect(notified).toEqual([]);
  });

  it('raises it after a restart when the last 429 before it is an hour old', async () => {
    const { clock, notified, tracker } = setup(new Date(BOOT - 50 * MINUTE));
    clock.advance(10 * MINUTE);

    await tracker.rateLimited(a429());

    expect(notified).toHaveLength(1);
  });

  it('raises it once when the first two 429s arrive together', async () => {
    const { lastRateLimited, notified, tracker } = setup();

    await Promise.all([
      tracker.rateLimited(a429()),
      tracker.rateLimited(a429()),
    ]);

    expect(notified).toHaveLength(1);
    expect(lastRateLimited).toHaveBeenCalledTimes(1);
  });

  it('asks again on the next 429 when the restart check failed', async () => {
    const { lastRateLimited, notified, tracker } = setup();
    lastRateLimited.mockRejectedValueOnce(new Error('db down'));

    await expect(tracker.rateLimited(a429())).rejects.toThrow('db down');
    await tracker.rateLimited(a429());

    expect(lastRateLimited).toHaveBeenCalledTimes(2);
    expect(notified).toHaveLength(1);
  });
});
