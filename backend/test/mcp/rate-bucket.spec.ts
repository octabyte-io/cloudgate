import { InMemoryAgentRateBucket } from '../../src/mcp/rate-bucket';
import type { RateBucketClock } from '../../src/mcp/rate-bucket';

/**
 * The per-Agent token bucket, driven through its port with a
 * clock the test moves by hand. The numbers are the spec's, written out here
 * rather than read from the constants: reads 120 a minute with a burst of 60,
 * writes 10 a minute with a burst of 5.
 */

function fakeClock(start = 1_000_000): RateBucketClock & {
  advance(ms: number): void;
} {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

function takeTimes(
  bucket: InMemoryAgentRateBucket,
  agent: string,
  budget: 'read' | 'write',
  times: number,
) {
  return Array.from({ length: times }, () => bucket.take(agent, budget));
}

describe('InMemoryAgentRateBucket', () => {
  describe('the read budget', () => {
    it('allows a burst of 60 reads at one instant and refuses the 61st', () => {
      const bucket = new InMemoryAgentRateBucket(fakeClock());

      const burst = takeTimes(bucket, 'agent-1', 'read', 60);

      expect(burst.every((verdict) => verdict.allowed)).toBe(true);
      expect(bucket.take('agent-1', 'read')).toEqual({
        allowed: false,
        retryAfterSeconds: 1,
      });
    });

    it('refills by elapsed time at two reads a second, never past the burst', () => {
      const clock = fakeClock();
      const bucket = new InMemoryAgentRateBucket(clock);
      takeTimes(bucket, 'agent-1', 'read', 60);

      clock.advance(1_000);
      expect(takeTimes(bucket, 'agent-1', 'read', 2)).toEqual([
        { allowed: true },
        { allowed: true },
      ]);
      expect(bucket.take('agent-1', 'read').allowed).toBe(false);

      clock.advance(10 * 60_000);
      const refilled = takeTimes(bucket, 'agent-1', 'read', 61);
      expect(refilled.filter((verdict) => verdict.allowed)).toHaveLength(60);
      expect(refilled[60].allowed).toBe(false);
    });
  });

  describe('the write budget', () => {
    it('allows a burst of 5 writes, then refuses with the six seconds one write takes to refill', () => {
      const bucket = new InMemoryAgentRateBucket(fakeClock());

      expect(
        takeTimes(bucket, 'agent-1', 'write', 5).every((v) => v.allowed),
      ).toBe(true);
      expect(bucket.take('agent-1', 'write')).toEqual({
        allowed: false,
        retryAfterSeconds: 6,
      });
    });

    it('is spent separately from the read budget, both ways', () => {
      const bucket = new InMemoryAgentRateBucket(fakeClock());

      takeTimes(bucket, 'agent-1', 'write', 5);
      expect(bucket.take('agent-1', 'write').allowed).toBe(false);
      expect(
        takeTimes(bucket, 'agent-1', 'read', 60).every((v) => v.allowed),
      ).toBe(true);
      expect(bucket.take('agent-1', 'read').allowed).toBe(false);

      const other = new InMemoryAgentRateBucket(fakeClock());
      takeTimes(other, 'agent-1', 'read', 60);
      expect(other.take('agent-1', 'read').allowed).toBe(false);
      expect(other.take('agent-1', 'write').allowed).toBe(true);
    });
  });

  describe('Retry-After', () => {
    it('counts the whole seconds to the next token from what has already refilled', () => {
      const clock = fakeClock();
      const bucket = new InMemoryAgentRateBucket(clock);
      takeTimes(bucket, 'agent-1', 'write', 5);

      clock.advance(4_000);
      expect(bucket.take('agent-1', 'write')).toEqual({
        allowed: false,
        retryAfterSeconds: 2,
      });
      clock.advance(1_001);
      expect(bucket.take('agent-1', 'write')).toEqual({
        allowed: false,
        retryAfterSeconds: 1,
      });
      clock.advance(999);
      expect(bucket.take('agent-1', 'write')).toEqual({ allowed: true });
    });

    it('does not charge a refused call a token', () => {
      const clock = fakeClock();
      const bucket = new InMemoryAgentRateBucket(clock);
      takeTimes(bucket, 'agent-1', 'write', 5);

      takeTimes(bucket, 'agent-1', 'write', 20);
      clock.advance(6_000);
      expect(bucket.take('agent-1', 'write')).toEqual({ allowed: true });
    });
  });

  describe('keying', () => {
    it('keeps one bucket per Agent, so one Agent running dry leaves another untouched', () => {
      const bucket = new InMemoryAgentRateBucket(fakeClock());

      takeTimes(bucket, 'agent-1', 'read', 60);
      expect(bucket.take('agent-1', 'read').allowed).toBe(false);
      expect(bucket.take('agent-2', 'read').allowed).toBe(true);
    });
  });

  describe('refund', () => {
    it('gives back a token taken for a call that never ran', () => {
      const bucket = new InMemoryAgentRateBucket(fakeClock());
      takeTimes(bucket, 'agent-1', 'write', 5);

      bucket.refund('agent-1', 'write');

      expect(bucket.take('agent-1', 'write')).toEqual({ allowed: true });
      expect(bucket.take('agent-1', 'write').allowed).toBe(false);
    });

    it('never fills a budget past its burst', () => {
      const bucket = new InMemoryAgentRateBucket(fakeClock());

      bucket.refund('agent-1', 'write');
      bucket.refund('agent-1', 'write');

      expect(
        takeTimes(bucket, 'agent-1', 'write', 6).map((v) => v.allowed),
      ).toEqual([true, true, true, true, true, false]);
    });
  });

  it('never mints tokens when the clock steps backwards', () => {
    const clock = fakeClock();
    const bucket = new InMemoryAgentRateBucket(clock);
    takeTimes(bucket, 'agent-1', 'write', 5);

    clock.advance(-60_000);
    expect(bucket.take('agent-1', 'write').allowed).toBe(false);
  });
});
