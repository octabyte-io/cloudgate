/**
 * The seam the per-Agent token bucket plugs into.
 *
 * The dispatcher asks the bucket once per `tools/call`, after authentication
 * and suspension (a suspended Agent never spends a token, and so never earns a
 * 429 or a rate-limit Notification) and before the permission check. A
 * refusal becomes HTTP 429 with `Retry-After`, the rate-limit sentence, no
 * finality sentence, and a `refused`/`rate-limit` audit row — the dispatcher
 * owns that answer; the bucket only counts.
 *
 * The provider is {@link InMemoryAgentRateBucket}: counted in this process,
 * refilled by elapsed time, behind an injectable {@link RateBucketClock}. A
 * multi-replica backend would bind shared storage to the same port. The bucket
 * is per Agent, never per key — every key of one Agent spends one budget.
 */

/**
 * Which budget a call spends. A tool declares it as `ToolDefinition.kind`
 * (`'read'` also annotates it `readOnlyHint` in `tools/list`), so a write tool
 * spends the write budget by saying `kind: 'write'` and nothing else.
 */
export type BucketBudget = 'read' | 'write';

export type BucketVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface AgentRateBucket {
  take(
    agentUserId: string,
    budget: BucketBudget,
  ): BucketVerdict | Promise<BucketVerdict>;
  /**
   * Gives back one token `take` allowed, for a call that then never ran — a
   * batch refused on a later call. Never fills a budget past its burst.
   */
  refund(agentUserId: string, budget: BucketBudget): void | Promise<void>;
}

/** The injection token for the bucket. */
export const MCP_RATE_BUCKET = 'MCP_RATE_BUCKET';

/** The injection token for the bucket's clock, which a test replaces. */
export const MCP_RATE_BUCKET_CLOCK = 'MCP_RATE_BUCKET_CLOCK';

/**
 * One 429, as the dispatcher answered it: the Agent, the key it came in on,
 * the tool and budget, and the `Retry-After` it was given. The audit row for
 * it is already written when a listener hears it.
 */
export interface AgentRateLimited {
  readonly agentUserId: string;
  readonly organizationId: string;
  readonly keyId: string;
  readonly tool: string;
  readonly budget: BucketBudget;
  readonly retryAfterSeconds: number;
}

/**
 * Told of every 429 the dispatcher answers — the seam the episode tracker
 * (`RateLimitEpisodeTracker`) binds to, deciding which 429 opens an episode
 * and raises the "Agent rate limited" Notification. Called once per 429 and not awaited: the 429 goes out
 * whatever the listener does, and a throw or rejection is logged, never
 * answered.
 */
export interface AgentRateLimitListener {
  rateLimited(event: AgentRateLimited): void | Promise<void>;
}

/** The injection token for the listener. */
export const MCP_RATE_LIMIT_LISTENER = 'MCP_RATE_LIMIT_LISTENER';

/** One budget: tokens added per minute, and the most the bucket holds. */
export interface RateBudget {
  readonly perMinute: number;
  readonly burst: number;
}

/**
 * Reads: 120 a minute with a burst of 60. A constant with no operator
 * setting; the docs-numbers spec reads it from here.
 */
export const READ_BUDGET: RateBudget = { perMinute: 120, burst: 60 };

/**
 * Writes: 10 a minute with a burst of 5. A constant with no operator
 * setting; the docs-numbers spec reads it from here.
 */
export const WRITE_BUDGET: RateBudget = { perMinute: 10, burst: 5 };

/** Every budget, by the `kind` a tool declares. */
export const AGENT_RATE_BUDGETS: Readonly<Record<BucketBudget, RateBudget>> = {
  read: READ_BUDGET,
  write: WRITE_BUDGET,
};

/** Milliseconds from any fixed origin. Only differences are read. */
export interface RateBucketClock {
  now(): number;
}

/** Monotonic, so a wall-clock step never mints or burns tokens. */
export const systemRateBucketClock: RateBucketClock = {
  now: () => performance.now(),
};

/**
 * A level in *token-milliseconds*: one token is 60 000 units and every
 * millisecond adds `perMinute` units, so refill and `Retry-After` are exact
 * integer arithmetic on an integer clock rather than float fractions of a token.
 */
const TOKEN = 60_000;

interface Level {
  units: number;
  at: number;
}

/**
 * The token bucket, in memory: one level per Agent per budget, refilled
 * continuously at `perMinute` tokens a minute up to `burst`, and spent one
 * token per allowed call (a refused call spends nothing). A refusal names the
 * whole seconds until the next token, at least 1, which `Retry-After` carries.
 */
export class InMemoryAgentRateBucket implements AgentRateBucket {
  private readonly levels = new Map<string, Level>();

  constructor(
    private readonly clock: RateBucketClock = systemRateBucketClock,
    private readonly budgets: Readonly<
      Record<BucketBudget, RateBudget>
    > = AGENT_RATE_BUDGETS,
  ) {}

  take(agentUserId: string, budget: BucketBudget): BucketVerdict {
    const { perMinute } = this.budgets[budget];
    const level = this.levelNow(agentUserId, budget);
    if (level.units >= TOKEN) {
      level.units -= TOKEN;
      return { allowed: true };
    }
    const waitMs = (TOKEN - level.units) / perMinute;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1_000)),
    };
  }

  refund(agentUserId: string, budget: BucketBudget): void {
    const level = this.levelNow(agentUserId, budget);
    level.units = Math.min(
      this.budgets[budget].burst * TOKEN,
      level.units + TOKEN,
    );
  }

  /** The Agent's level in this budget, refilled up to now. */
  private levelNow(agentUserId: string, budget: BucketBudget): Level {
    const { perMinute, burst } = this.budgets[budget];
    const now = this.clock.now();
    const id = `${budget}:${agentUserId}`;
    const level = this.levels.get(id) ?? { units: burst * TOKEN, at: now };
    const elapsed = Math.max(0, now - level.at);
    level.units = Math.min(burst * TOKEN, level.units + elapsed * perMinute);
    level.at = now;
    this.levels.set(id, level);
    return level;
  }
}
