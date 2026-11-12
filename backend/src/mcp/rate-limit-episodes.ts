import type { AgentRateLimited, AgentRateLimitListener } from './rate-bucket';

/**
 * The loop signal: an owner or admin hears about a looping Agent
 * once per episode, not once per 429.
 *
 * An **episode** opens at an Agent's first 429 and closes after an hour in
 * which it earned none. The first 429 of an episode raises the "Agent rate
 * limited" Notification; every other 429 is already in the audit trail, which
 * the Agent's row counts ("Rate-limited N times in the last hour").
 *
 * The "already told" mark is kept in memory — the last 429 this process saw
 * for each Agent — because it is cheap to lose: after a restart, the first
 * 429 of each Agent asks the audit trail once, through {@link
 * RateLimitHistory}, whether a rate-limit refusal from before this process
 * started falls inside the hour. That read is bounded above by the boot time
 * on purpose: every refusal after boot is one this process heard itself, and
 * the 429 being decided has already written its own row, which must not count
 * as evidence that an episode was open before it.
 */

/** The episode closes after this long with no 429. */
export const EPISODE_QUIET_MS = 60 * 60_000;

/**
 * Wall-clock milliseconds since the epoch — not the rate bucket's monotonic
 * clock, because the restart check compares it with audit rows' `created_at`.
 */
export interface EpisodeClock {
  now(): number;
}

export const systemEpisodeClock: EpisodeClock = { now: () => Date.now() };

/** The one audit read the tracker makes after a restart. */
export interface RateLimitHistory {
  /**
   * The latest `refused`/`rate-limit` row of this Agent written in
   * `[since, before)`, or `null` when there is none.
   */
  lastRateLimited(
    agentUserId: string,
    since: Date,
    before: Date,
  ): Promise<Date | null>;
}

/** Raises the "Agent rate limited" Notification for an episode's first 429. */
export interface AgentRateLimitNotifier {
  agentRateLimited(event: AgentRateLimited): Promise<void>;
}

/** The injection token for the tracker's clock, which a test replaces. */
export const EPISODE_CLOCK = 'EPISODE_CLOCK';

export class RateLimitEpisodeTracker implements AgentRateLimitListener {
  private readonly bootedAt: number;
  /** The last 429 heard for each Agent, in {@link EpisodeClock} time. */
  private readonly lastSeen = new Map<string, number>();
  /**
   * Each Agent's decisions, one after another: two 429s arriving together
   * would otherwise both run the restart check and both find no episode.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly history: RateLimitHistory,
    private readonly notifier: AgentRateLimitNotifier,
    private readonly clock: EpisodeClock = systemEpisodeClock,
  ) {
    this.bootedAt = clock.now();
  }

  rateLimited(event: AgentRateLimited): Promise<void> {
    const id = event.agentUserId;
    const decided = (this.queues.get(id) ?? Promise.resolve()).then(() =>
      this.decide(event),
    );
    this.queues.set(
      id,
      decided.catch(() => undefined),
    );
    return decided;
  }

  private async decide(event: AgentRateLimited): Promise<void> {
    const id = event.agentUserId;
    const now = this.clock.now();
    const previous = this.lastSeen.has(id)
      ? this.lastSeen.get(id)!
      : await this.previousFromTrail(id, now);
    this.lastSeen.set(id, now);

    if (previous !== null && now - previous < EPISODE_QUIET_MS) return;
    await this.notifier.agentRateLimited(event);
  }

  private async previousFromTrail(
    agentUserId: string,
    now: number,
  ): Promise<number | null> {
    const last = await this.history.lastRateLimited(
      agentUserId,
      new Date(now - EPISODE_QUIET_MS),
      new Date(this.bootedAt),
    );
    return last?.getTime() ?? null;
  }
}
