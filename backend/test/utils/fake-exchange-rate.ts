import type {
  DayRate,
  ExchangeRatePort,
} from '../../src/bought-servers/exchange-rate/exchange-rate.port';

/** The rate the fake answers until a spec sets another. */
export const SEEDED_DAY_RATE: DayRate = { usdPerEur: 1.16, on: '2026-11-10' };

/**
 * The day's exchange rate, in memory, registered for every e2e in place of
 * the ECB adapter (`ctx.exchangeRate`), and reset with the database. The
 * service in front of it keeps one read a day, so a spec that changes the
 * rate also calls `DayRates.forget()`.
 */
export class FakeExchangeRate implements ExchangeRatePort {
  rate: DayRate = { ...SEEDED_DAY_RATE };
  /** While true, every read fails, as an unreachable source would. */
  unreachable = false;
  reads = 0;

  latestUsdPerEur(): Promise<DayRate> {
    this.reads += 1;
    if (this.unreachable) {
      return Promise.reject(new Error('the fake rate source is unreachable'));
    }
    return Promise.resolve({ ...this.rate });
  }

  reset(): void {
    this.rate = { ...SEEDED_DAY_RATE };
    this.unreachable = false;
    this.reads = 0;
  }
}
