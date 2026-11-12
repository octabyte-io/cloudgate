import { hostedLimitReason } from '../../src/organizations/organization-limit';

const OWNS =
  'You already own Northwind, and a person can own one Organization that pays for itself';

describe('hostedLimitReason', () => {
  it('tells an owner or admin on Starter, or with no plan, what Business does', () => {
    expect(hostedLimitReason('Northwind', 'on-business')).toBe(
      `${OWNS}. On Business, Northwind can pay for more Organizations`,
    );
  });

  it('tells an owner or admin whose Organization already can pay for more', () => {
    expect(hostedLimitReason('Northwind', 'on-its-plan')).toBe(
      `${OWNS}. Northwind can pay for more Organizations on its plan`,
    );
  });

  it('gives everyone else the reason without the upsell', () => {
    expect(hostedLimitReason('Northwind', null)).toBe(OWNS);
  });
});
