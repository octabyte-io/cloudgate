import { literal } from '../../definitions/tofu-json';

/**
 * An image's `HEALTHCHECK`, as Docker keeps it in the image's config
 * (`docker image inspect`'s `.Config.Healthcheck`): its test, and its
 * durations in nanoseconds. A duration or `retries` left out (or 0) is
 * Docker's default. Only an image that runs a check has one: `HEALTHCHECK
 * NONE` and no `HEALTHCHECK` at all are both `null`.
 */
export interface ImageHealthCheck {
  /** `["CMD", …]` or `["CMD-SHELL", "…"]`, as ECS takes them too. */
  readonly test: readonly string[];
  readonly interval?: number;
  readonly timeout?: number;
  readonly startPeriod?: number;
  readonly retries?: number;
}

const NANOSECONDS = 1_000_000_000;

/** Docker's defaults for what a `HEALTHCHECK` leaves out. */
const DOCKER_DEFAULTS = { interval: 30, timeout: 30, retries: 3 };

/** What ECS takes of each (its `HealthCheck` ranges). */
const ECS_RANGES = {
  interval: [5, 300],
  timeout: [2, 120],
  retries: [1, 10],
  startPeriod: [0, 300],
} as const;

function within(value: number, [low, high]: readonly [number, number]) {
  return Math.min(high, Math.max(low, value));
}

function seconds(nanoseconds: number | undefined): number {
  return nanoseconds ? Math.max(1, Math.round(nanoseconds / NANOSECONDS)) : 0;
}

/**
 * The container definition's `healthCheck` for an image's `HEALTHCHECK`
 * so a task on ECS is judged as Docker judges the container on a
 * Server: what the image leaves out is Docker's default, not ECS's (whose
 * timeout is 5 s, not 30), and a value ECS's range refuses is brought to
 * its nearest end, so the task definition still registers. A start period
 * of none is left out, as ECS's own default.
 */
export function containerHealthCheck(
  check: ImageHealthCheck,
): Record<string, unknown> {
  const startPeriod = within(
    seconds(check.startPeriod),
    ECS_RANGES.startPeriod,
  );
  return {
    command: check.test.map(literal),
    interval: within(
      seconds(check.interval) || DOCKER_DEFAULTS.interval,
      ECS_RANGES.interval,
    ),
    timeout: within(
      seconds(check.timeout) || DOCKER_DEFAULTS.timeout,
      ECS_RANGES.timeout,
    ),
    retries: within(
      check.retries || DOCKER_DEFAULTS.retries,
      ECS_RANGES.retries,
    ),
    ...(startPeriod > 0 ? { startPeriod } : {}),
  };
}
