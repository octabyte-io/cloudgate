import { boughtServersOffer } from '../../src/bought-servers/bought-servers.config';

/**
 * Whether *Buy a Server* exists and is offered (ADR-0071): the whole
 * feature is absent off hosted mode, and on the Hosted instance it is offered
 * only with both provider tokens. The e2e specs in this folder drive the
 * hosted halves through the routes.
 */
describe('boughtServersOffer', () => {
  it('is absent on a Self-hosted instance, even with left-over tokens', () => {
    expect(boughtServersOffer(false, { eur: 'eur', usd: 'usd' })).toBe(
      'absent',
    );
    expect(boughtServersOffer(false, { eur: undefined, usd: undefined })).toBe(
      'absent',
    );
  });

  it('is not offered on the Hosted instance while either token is missing or blank', () => {
    expect(boughtServersOffer(true, { eur: undefined, usd: undefined })).toBe(
      'not-offered',
    );
    expect(boughtServersOffer(true, { eur: 'eur', usd: undefined })).toBe(
      'not-offered',
    );
    expect(boughtServersOffer(true, { eur: undefined, usd: 'usd' })).toBe(
      'not-offered',
    );
    expect(boughtServersOffer(true, { eur: 'eur', usd: '  ' })).toBe(
      'not-offered',
    );
  });

  it('is offered on the Hosted instance with both tokens', () => {
    expect(boughtServersOffer(true, { eur: 'eur', usd: 'usd' })).toBe(
      'offered',
    );
  });
});
