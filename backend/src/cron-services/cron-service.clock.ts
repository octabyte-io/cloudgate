/**
 * The clock a Cron service's timetable reads: what "now" is when it
 * looks for the fire times it has crossed, and where it is armed from at
 * boot.
 *
 * A provider only so a suite can stand time still and move it across fire
 * times between direct calls to `CronTimetable.tick`, rather than waiting in
 * real time — `SERVICE_HEALTH_CLOCK`'s shape. The product has exactly one
 * clock and no route chooses it.
 */
export interface CronServiceClock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const CRON_SERVICE_CLOCK = 'CRON_SERVICE_CLOCK';

export const systemCronServiceClock: CronServiceClock = {
  now: () => Date.now(),
};

/**
 * The clock and the wait of a run's settle read: how long it is
 * since the run's job ended, and the pause between two reads of its output
 * (`CronRunLogSettle`).
 *
 * Not {@link CRON_SERVICE_CLOCK}: suites stand that one still while a run
 * goes, and a settle read on it would never see its window pass. A provider
 * only so a suite can move time on with each wait rather than sleep through
 * it, as `CRON_RUN_POLL_MS` shortens the watch; the product has exactly one.
 */
export interface CronRunSettleTimer {
  /** Milliseconds, counted from any fixed point. */
  now(): number;
  /** Resolves once `ms` have passed on {@link now}. */
  wait(ms: number): Promise<void>;
}

export const CRON_RUN_SETTLE_TIMER = 'CRON_RUN_SETTLE_TIMER';

export const systemCronRunSettleTimer: CronRunSettleTimer = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
