import { Inject, Injectable, Logger } from '@nestjs/common';
import { EXCHANGE_RATE } from './exchange-rate.port';
import type { DayRate, ExchangeRatePort } from './exchange-rate.port';

/**
 * The day's exchange rate for the Operator page: one rate for the whole
 * page, read at most once a (UTC) day, since the source publishes once a
 * working day. A failed read is not kept, so the next view asks again, and
 * it answers null rather than throw: the page still lists every Bought
 * Server, with its margin unknown.
 */
@Injectable()
export class DayRates {
  private readonly logger = new Logger(DayRates.name);
  private cached: { day: string; rate: DayRate } | null = null;

  constructor(
    @Inject(EXCHANGE_RATE) private readonly source: ExchangeRatePort,
  ) {}

  async today(now: Date = new Date()): Promise<DayRate | null> {
    const day = now.toISOString().slice(0, 10);
    if (this.cached?.day === day) return this.cached.rate;
    try {
      const rate = await this.source.latestUsdPerEur();
      this.cached = { day, rate };
      return rate;
    } catch (error) {
      this.logger.error(
        `The day's exchange rate could not be read: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /** Forgets the day's read; for tests that change the rate within a day. */
  forget(): void {
    this.cached = null;
  }
}
