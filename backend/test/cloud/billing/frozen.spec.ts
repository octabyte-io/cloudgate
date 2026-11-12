import {
  frozenCausesOf,
  frozenRefusal,
  standingOf,
} from '../../../src/cloud/billing/frozen';
import type { FrozenStanding } from '../../../src/cloud/billing/frozen';

const LAPSED_AT = new Date('2026-11-01T00:00:00.000Z');

function standing(overrides: Partial<FrozenStanding> = {}): FrozenStanding {
  return {
    status: 'active',
    lapsedAt: null,
    suspendedAt: null,
    suspendedReason: null,
    ...overrides,
  };
}

describe('frozenCausesOf', () => {
  it('records nothing for no row, a paid row, or one Stripe is retrying', () => {
    expect(frozenCausesOf(null)).toEqual([]);
    expect(frozenCausesOf(standing())).toEqual([]);
    expect(frozenCausesOf(standing({ status: 'past_due' }))).toEqual([]);
  });

  it('names each recorded cause, suspension first', () => {
    expect(frozenCausesOf(standing({ lapsedAt: LAPSED_AT }))).toEqual([
      'lapsed',
    ]);
    expect(
      frozenCausesOf(standing({ lapsedAt: LAPSED_AT, suspendedAt: LAPSED_AT })),
    ).toEqual(['suspended', 'lapsed']);
  });
});

describe('frozenRefusal', () => {
  it('refuses nothing while unfrozen, past_due included', () => {
    expect(frozenRefusal(standing({ status: 'past_due' }))).toBeNull();
  });

  it('says "Pay to continue" for a lapse', () => {
    expect(frozenRefusal(standing({ lapsedAt: LAPSED_AT }))).toEqual({
      code: 'ORGANIZATION_FROZEN',
      message: 'Pay to continue',
    });
  });

  it('names both causes, suspension first', () => {
    expect(
      frozenRefusal(
        standing({
          lapsedAt: LAPSED_AT,
          suspendedAt: LAPSED_AT,
          suspendedReason: 'Sending spam',
        }),
      ),
    ).toEqual({
      code: 'ORGANIZATION_FROZEN',
      message: 'Suspended. Contact Octabyte. Pay to continue',
    });
  });
});

describe('standingOf', () => {
  it('flags a failed payment without freezing', () => {
    expect(standingOf(standing({ status: 'past_due' }))).toEqual({
      frozen: false,
      causes: [],
      paymentFailed: true,
      lapsedAt: null,
      suspendedReason: null,
      payingOrganization: null,
    });
  });

  it('is frozen once lapsed, and no longer a retried payment', () => {
    expect(
      standingOf(standing({ status: 'canceled', lapsedAt: LAPSED_AT })),
    ).toEqual({
      frozen: true,
      causes: ['lapsed'],
      paymentFailed: false,
      lapsedAt: LAPSED_AT,
      suspendedReason: null,
      payingOrganization: null,
    });
  });
});

/**
 * An Attached Organization (ADR-0059): its own row records its own
 * suspension and its own lapse, and its Paying Organization's lapse is read
 * through the link — never the Paying Organization's suspension.
 */
describe('PayingStanding', () => {
  const attached = (
    payer: Partial<NonNullable<FrozenStanding['payingOrganization']>>,
    own: Partial<FrozenStanding> = {},
  ): FrozenStanding =>
    standing({
      status: null,
      ...own,
      payingOrganization: {
        name: 'Hopper Labs',
        status: 'active',
        lapsedAt: null,
        ...payer,
      },
    });

  it("is frozen by its Paying Organization's lapse", () => {
    const standingNow = attached({ status: 'canceled', lapsedAt: LAPSED_AT });
    expect(frozenCausesOf(standingNow)).toEqual(['lapsed']);
    expect(frozenRefusal(standingNow)).toEqual({
      code: 'ORGANIZATION_FROZEN',
      message: 'Pay to continue',
    });
    expect(standingOf(standingNow)).toMatchObject({
      frozen: true,
      causes: ['lapsed'],
      lapsedAt: LAPSED_AT,
    });
  });

  it('is not frozen while its Paying Organization pays, and its own suspension still freezes it', () => {
    expect(frozenCausesOf(attached({}))).toEqual([]);
    expect(
      frozenCausesOf(
        attached({}, { suspendedAt: LAPSED_AT, suspendedReason: 'Spam' }),
      ),
    ).toEqual(['suspended']);
  });

  it("names the lapse once when both its own and its Paying Organization's are recorded, dated by the earlier", () => {
    const later = new Date('2026-11-05T00:00:00.000Z');
    const both = attached({ lapsedAt: later }, { lapsedAt: LAPSED_AT });
    expect(standingOf(both)).toMatchObject({
      causes: ['lapsed'],
      lapsedAt: LAPSED_AT,
    });
    expect(
      standingOf(attached({ lapsedAt: LAPSED_AT }, { lapsedAt: later }))
        .lapsedAt,
    ).toEqual(LAPSED_AT);
  });

  it("says the Paying Organization's payment is failing without its own banner's failed payment", () => {
    expect(standingOf(attached({ status: 'past_due' }))).toEqual({
      frozen: false,
      causes: [],
      paymentFailed: false,
      lapsedAt: null,
      suspendedReason: null,
      payingOrganization: { name: 'Hopper Labs', paymentFailed: true },
    });
    expect(standingOf(attached({})).payingOrganization).toEqual({
      name: 'Hopper Labs',
      paymentFailed: false,
    });
  });
});
