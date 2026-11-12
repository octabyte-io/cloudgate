/**
 * The clock every service-health judgement reads (the spec's fourth test
 * double): when a check is due, what time a Probe and an Incident record, and
 * where the seven-day Probe retention starts.
 *
 * A provider only so a suite can stand time still and move it by a check's
 * interval between direct calls to `ProbeScheduler.tick`, rather than waiting
 * in real time — `MCP_RATE_BUCKET_CLOCK`'s shape. The product has exactly one
 * clock and no route chooses it. The Error rate's collection tick reads this
 * one too.
 */
export interface ServiceHealthClock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const SERVICE_HEALTH_CLOCK = 'SERVICE_HEALTH_CLOCK';

export const systemServiceHealthClock: ServiceHealthClock = {
  now: () => Date.now(),
};
