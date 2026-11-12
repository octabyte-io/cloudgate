import type Stripe from 'stripe';
import type { BoughtServerChangeTarget } from '../../src/bought-servers/bought-server.schema';
import {
  changeUpdateParams,
  restoreUpdateParams,
} from '../../src/bought-servers/purchase-lines';
import type { HeldLine } from '../../src/bought-servers/purchase-lines';
import {
  changeCostsMore,
  MAX_CHANGE_TRIES,
  nextStep,
} from '../../src/bought-servers/stages';
import type { StageFacts } from '../../src/bought-servers/stages';

const BACKUPS_ON: BoughtServerChangeTarget = {
  backups: true,
  charged: true,
  lines: [{ kind: 'backups', stripePriceId: 'price_b', monthlyCents: 500 }],
};

const BACKUPS_OFF: BoughtServerChangeTarget = {
  backups: false,
  charged: false,
  lines: [{ kind: 'backups', stripePriceId: null, monthlyCents: null }],
};

function changing(overrides: Partial<StageFacts> = {}): StageFacts {
  return {
    stage: 'changing',
    purchasePaidAt: new Date('2026-11-10T12:00:00Z'),
    createTries: 1,
    providerServerId: 42,
    serverId: 'abc',
    changeTarget: BACKUPS_ON,
    changeTries: 0,
    changeInvoiceId: 'in_change',
    setupStarts: 1,
    linesOnSubscription: 1,
    ...overrides,
  };
}

const SERVER: HeldLine = {
  kind: 'server',
  stripePriceId: 'price_s',
  stripeSubscriptionItemId: 'si_s',
};
const BACKUPS: HeldLine = {
  kind: 'backups',
  stripePriceId: 'price_b_old',
  stripeSubscriptionItemId: 'si_b',
};

function subscriptionWith(
  items: Array<{ id: string; price: string }>,
): Stripe.Subscription {
  return {
    id: 'sub_1',
    items: {
      data: items.map((item) => ({ id: item.id, price: { id: item.price } })),
    },
  } as unknown as Stripe.Subscription;
}

describe('nextStep: Changing, the shared rule for any change', () => {
  it('asks the provider only once a charged change is paid', () => {
    expect(nextStep(changing({ changeInvoiceId: null }))).toEqual({
      kind: 'wait-for-payment',
    });
    expect(nextStep(changing())).toEqual({ kind: 'apply-change' });
  });

  it('asks the provider at once for a change that is credited', () => {
    expect(
      nextStep(changing({ changeTarget: BACKUPS_OFF, changeInvoiceId: null })),
    ).toEqual({ kind: 'apply-change' });
  });

  it('asks once more after a refusal, then gives up', () => {
    expect(nextStep(changing({ changeTries: 1 }))).toEqual({
      kind: 'apply-change',
    });
    expect(nextStep(changing({ changeTries: MAX_CHANGE_TRIES }))).toEqual({
      kind: 'give-up-change',
    });
    expect(MAX_CHANGE_TRIES).toBe(2);
  });

  it('does nothing with no change stored', () => {
    expect(nextStep(changing({ changeTarget: null }))).toEqual({
      kind: 'none',
    });
  });
});

describe('changeCostsMore: charged at once, or credited', () => {
  const held = [
    { kind: 'server', monthlyCents: 2500 },
    { kind: 'backups', monthlyCents: 500 },
  ];

  it('charges a line added', () => {
    expect(
      changeCostsMore([held[0]], [{ kind: 'backups', monthlyCents: 500 }]),
    ).toBe(true);
  });

  it('credits a line ended', () => {
    expect(
      changeCostsMore(held, [{ kind: 'backups', monthlyCents: null }]),
    ).toBe(false);
  });

  it('charges a line moved up, and credits one moved down', () => {
    expect(
      changeCostsMore(held, [{ kind: 'server', monthlyCents: 4000 }]),
    ).toBe(true);
    expect(
      changeCostsMore(held, [{ kind: 'server', monthlyCents: 1500 }]),
    ).toBe(false);
  });

  it('weighs every line the change moves together', () => {
    expect(
      changeCostsMore(held, [
        { kind: 'server', monthlyCents: 4000 },
        { kind: 'backups', monthlyCents: 800 },
      ]),
    ).toBe(true);
  });
});

describe('changeUpdateParams: the change on the subscription', () => {
  it('adds a new line charged at once, applied only once paid', () => {
    expect(changeUpdateParams([SERVER], BACKUPS_ON.lines, true)).toEqual({
      items: [{ price: 'price_b', quantity: 1 }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'pending_if_incomplete',
    });
  });

  it('deletes an ended line with a credit on the next invoice', () => {
    expect(
      changeUpdateParams([SERVER, BACKUPS], BACKUPS_OFF.lines, false),
    ).toEqual({
      items: [{ id: 'si_b', deleted: true }],
      proration_behavior: 'create_prorations',
    });
  });

  it('moves a line held to its new price on the same item', () => {
    expect(
      changeUpdateParams(
        [SERVER],
        [{ kind: 'server', stripePriceId: 'price_s2', monthlyCents: 4000 }],
        true,
      ).items,
    ).toEqual([{ id: 'si_s', price: 'price_s2', quantity: 1 }]);
  });
});

describe('restoreUpdateParams: the subscription as it was, after a refund', () => {
  it('takes an added line back off, with nothing prorated', () => {
    expect(
      restoreUpdateParams(
        [SERVER],
        BACKUPS_ON.lines,
        subscriptionWith([
          { id: 'si_s', price: 'price_s' },
          { id: 'si_new', price: 'price_b' },
        ]),
      ),
    ).toEqual({
      items: [{ id: 'si_new', deleted: true }],
      proration_behavior: 'none',
    });
  });

  it('puts a moved line back on its old price', () => {
    expect(
      restoreUpdateParams(
        [SERVER],
        [{ kind: 'server', stripePriceId: 'price_s2', monthlyCents: 4000 }],
        subscriptionWith([{ id: 'si_s', price: 'price_s2' }]),
      ).items,
    ).toEqual([{ id: 'si_s', price: 'price_s', quantity: 1 }]);
  });

  it('changes nothing the subscription no longer shows', () => {
    expect(
      restoreUpdateParams(
        [SERVER],
        BACKUPS_ON.lines,
        subscriptionWith([{ id: 'si_s', price: 'price_s' }]),
      ).items,
    ).toEqual([]);
  });
});
