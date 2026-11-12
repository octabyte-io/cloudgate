import type { DayRate, ExchangeRatePort } from './exchange-rate.port';

/** The ECB's daily euro reference rates: one small XML document, no key. */
const DAILY_RATES =
  'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

const CALL_TIMEOUT_MS = 10_000;

/**
 * The day's euro reference rate for the US dollar from the European Central
 * Bank (`exchange-rate.port.ts`): the only file that reads it.
 */
export class EcbExchangeRate implements ExchangeRatePort {
  async latestUsdPerEur(): Promise<DayRate> {
    const response = await fetch(DAILY_RATES, {
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `The ECB's daily rates answered ${response.status} ${response.statusText}`,
      );
    }
    return dayRateOf(await response.text());
  }
}

/**
 * The USD rate and its day out of the ECB's document, which reads
 * `<Cube time='2026-11-10'> … <Cube currency='USD' rate='1.1562'/>`.
 */
export function dayRateOf(xml: string): DayRate {
  const on = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  const rate = /currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/.exec(xml)?.[1];
  const usdPerEur = Number(rate);
  if (!on || !rate || !Number.isFinite(usdPerEur) || usdPerEur <= 0) {
    throw new Error("The ECB's daily rates carry no USD rate");
  }
  return { usdPerEur, on };
}
