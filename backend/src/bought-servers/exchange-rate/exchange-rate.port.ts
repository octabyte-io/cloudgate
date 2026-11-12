/**
 * Where the Operator page's day rate comes from (spec #1387, #1399): the
 * **European Central Bank's euro reference rate** for the US dollar,
 * published once each working day. Chosen because it is the public, free,
 * keyless reference for "the day's rate", one figure the whole page uses;
 * Stripe offers no rate API to ask, and the rate it converts one payment at
 * is known only once that payment settles.
 *
 * It is only ever read for the Operator's margin: no customer price is made
 * from it (ADR-0071 rejected converting EUR prices at a market rate).
 *
 * Its only implementation is `EcbExchangeRate`
 * (`./ecb-exchange-rate.adapter.ts`); every e2e gets
 * `test/utils/fake-exchange-rate.ts` in its place.
 */
export const EXCHANGE_RATE = Symbol('EXCHANGE_RATE');

/** One day's rate. */
export interface DayRate {
  /** US dollars for one euro. */
  usdPerEur: number;
  /** The day the rate is for, `2026-11-10`: the last working day published. */
  on: string;
}

export interface ExchangeRatePort {
  /** The latest published rate. Throws when it cannot be read. */
  latestUsdPerEur(): Promise<DayRate>;
}
