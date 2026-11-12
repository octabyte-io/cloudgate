import { DayRates } from '../../src/bought-servers/exchange-rate/day-rates.service';
import { dayRateOf } from '../../src/bought-servers/exchange-rate/ecb-exchange-rate.adapter';
import { FakeExchangeRate } from '../utils/fake-exchange-rate';

/** The ECB's daily document, trimmed to the shape it is published in. */
const ECB_DAILY = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-11-10'>
      <Cube currency='USD' rate='1.1562'/>
      <Cube currency='JPY' rate='173.21'/>
      <Cube currency='GBP' rate='0.87765'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe('dayRateOf', () => {
  it('gives the US dollars for one euro and the day they are for', () => {
    expect(dayRateOf(ECB_DAILY)).toEqual({
      usdPerEur: 1.1562,
      on: '2026-11-10',
    });
  });

  it('refuses a document with no USD rate rather than answer a wrong one', () => {
    expect(() =>
      dayRateOf(ECB_DAILY.replace(/<Cube currency='USD'[^>]*>/, '')),
    ).toThrow('no USD rate');
  });
});

describe('DayRates', () => {
  const AT = new Date('2026-11-10T09:00:00Z');

  it('reads the rate once a day, whatever the number of views', async () => {
    const source = new FakeExchangeRate();
    const rates = new DayRates(source);

    await rates.today(AT);
    await rates.today(new Date('2026-11-10T23:59:00Z'));

    expect(source.reads).toBe(1);
  });

  it('reads again on the next day', async () => {
    const source = new FakeExchangeRate();
    const rates = new DayRates(source);

    await rates.today(AT);
    source.rate = { usdPerEur: 1.2, on: '2026-11-11' };

    expect(await rates.today(new Date('2026-11-11T09:00:00Z'))).toEqual({
      usdPerEur: 1.2,
      on: '2026-11-11',
    });
  });

  it('answers null when the rate cannot be read, and asks again next time', async () => {
    const source = new FakeExchangeRate();
    source.unreachable = true;
    const rates = new DayRates(source);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await rates.today(AT)).toBeNull();
    source.unreachable = false;
    expect(await rates.today(AT)).toEqual(source.rate);
    expect(source.reads).toBe(2);
  });
});
