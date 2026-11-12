import type { CronRunSettleTimer } from '../../src/cron-services/cron-service.clock';

/**
 * A Cron run's settle timer that never sleeps: each wait moves its
 * clock on by what it asked and ends on the event loop's next turn, so a
 * run on Google Cloud or AWS settles in a few reads rather than 12 s or
 * more of real time. `createTestApp` hands every suite one unless it brings
 * its own; a suite that looks at the settle brings its own to read it.
 */
export class InstantSettleTimer implements CronRunSettleTimer {
  /** Its clock, in ms: the sum of every wait so far. */
  at = 0;
  /** Each wait asked, in order. */
  readonly waits: number[] = [];

  now(): number {
    return this.at;
  }

  wait(ms: number): Promise<void> {
    this.at += ms;
    this.waits.push(ms);
    return new Promise((resolve) => setImmediate(resolve));
  }
}
