import type Stripe from 'stripe';
import type {
  BoughtServerChangeTarget,
  BoughtServerRestore,
} from '../../src/bought-servers/bought-server.schema';
import {
  backupDateOf,
  safetyCopyDescription,
  safetyCopyPushesOut,
} from '../../src/bought-servers/restore';
import {
  changeUpdateParams,
  restoreUpdateParams,
} from '../../src/bought-servers/purchase-lines';
import type { HeldLine } from '../../src/bought-servers/purchase-lines';
import {
  changeCostsMore,
  MAX_CHANGE_TRIES,
  MAX_SETUP_STARTS,
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

/** A Restore as Restore stores it: its backup, and a safety copy to take first. */
const RESTORE: BoughtServerRestore = {
  backupId: 7001,
  backupTakenAt: '2026-11-03T03:00:00.000Z',
  requestedBy: 'user_1',
  safetyCopy: {
    description: 'Before restore, 2026-11-27 14:05 UTC',
    id: null,
    available: false,
  },
};

function restoring(
  restore: Partial<BoughtServerRestore>,
  overrides: Partial<StageFacts> = {},
): StageFacts {
  return changing({
    changeTarget: {
      charged: false,
      lines: [],
      restore: { ...RESTORE, ...restore },
    },
    changeInvoiceId: null,
    ...overrides,
  });
}

const COPY_TAKEN = {
  ...RESTORE.safetyCopy!,
  id: 9001,
  available: true,
};

describe('nextStep: Changing, a Restore', () => {
  it('takes the safety copy first, never charged, so no payment is waited for', () => {
    expect(nextStep(restoring({}))).toEqual({
      kind: 'take-safety-copy',
      findFirst: false,
    });
  });

  it('looks for the safety copy by its description first once a try was made', () => {
    expect(nextStep(restoring({}, { changeTries: 1 }))).toEqual({
      kind: 'take-safety-copy',
      findFirst: true,
    });
  });

  it('gives up when the safety copy was refused twice', () => {
    expect(nextStep(restoring({}, { changeTries: MAX_CHANGE_TRIES }))).toEqual({
      kind: 'give-up-change',
    });
  });

  it('waits until the safety copy is made before the rebuild', () => {
    expect(
      nextStep(restoring({ safetyCopy: { ...COPY_TAKEN, available: false } })),
    ).toEqual({ kind: 'wait-for-safety-copy' });
  });

  it('rebuilds from the chosen backup once the safety copy is made', () => {
    expect(nextStep(restoring({ safetyCopy: COPY_TAKEN }))).toEqual({
      kind: 'rebuild',
    });
  });

  it('rebuilds at once when it goes without a safety copy', () => {
    expect(nextStep(restoring({ safetyCopy: null }))).toEqual({
      kind: 'rebuild',
    });
  });

  it('waits on a rebuild the provider is making, then gives up after the second refusal', () => {
    expect(
      nextStep(
        restoring(
          { safetyCopy: COPY_TAKEN, rebuildActionId: 5 },
          { changeTries: 1 },
        ),
      ),
    ).toEqual({ kind: 'wait-for-rebuild' });
    expect(
      nextStep(restoring({ safetyCopy: COPY_TAKEN }, { changeTries: 1 })),
    ).toEqual({ kind: 'rebuild' });
    expect(
      nextStep(
        restoring(
          { safetyCopy: COPY_TAKEN },
          { changeTries: MAX_CHANGE_TRIES },
        ),
      ),
    ).toEqual({ kind: 'give-up-change' });
  });

  it('starts the machine once it is rebuilt, until it answers', () => {
    expect(
      nextStep(restoring({ safetyCopy: COPY_TAKEN, rebuilt: true })),
    ).toEqual({ kind: 'start-machine' });
    expect(
      nextStep(
        restoring(
          { safetyCopy: COPY_TAKEN, rebuilt: true },
          { changeTries: MAX_CHANGE_TRIES },
        ),
      ),
    ).toEqual({ kind: 'give-up-change' });
  });

  it('runs Server setup once the machine answers, once more if a restart cut it off', () => {
    const answered = { safetyCopy: COPY_TAKEN, rebuilt: true, running: true };
    expect(nextStep(restoring(answered))).toEqual({ kind: 'restore-setup' });
    expect(nextStep(restoring({ ...answered, setupStarts: 1 }))).toEqual({
      kind: 'restore-setup',
    });
    expect(
      nextStep(restoring({ ...answered, setupStarts: MAX_SETUP_STARTS })),
    ).toEqual({ kind: 'restore-setup-cut-off' });
  });

  it('has only what follows the setup run left once it ended, either way', () => {
    expect(
      nextStep(
        restoring({
          safetyCopy: COPY_TAKEN,
          rebuilt: true,
          running: true,
          setupStarts: 1,
          setup: { ok: false, message: 'exit 1' },
        }),
      ),
    ).toEqual({ kind: 'after-restore-setup' });
  });
});

describe('safetyCopyPushesOut: whether the safety copy would remove the chosen backup', () => {
  const seven = [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    id: day,
    created: `2026-11-0${day}T03:00:00+00:00`,
  }));

  it('is true for the oldest of 7, in whatever order they are listed', () => {
    expect(safetyCopyPushesOut([...seven].reverse(), 1)).toBe(true);
  });

  it('is false for any newer one of 7', () => {
    expect(safetyCopyPushesOut(seven, 2)).toBe(false);
  });

  it('is false for the oldest while a slot is free', () => {
    expect(safetyCopyPushesOut(seven.slice(0, 6), 1)).toBe(false);
  });
});

describe('safetyCopyDescription: what the safety copy is called', () => {
  it('says it is from before a restore, with the minute it was asked for, in UTC', () => {
    expect(safetyCopyDescription(new Date('2026-11-27T14:05:31Z'))).toBe(
      'Before restore, 2026-11-27 14:05 UTC',
    );
  });
});

describe('backupDateOf: when a backup was taken, as an email says it', () => {
  it('names the day and the minute in UTC', () => {
    expect(backupDateOf('2026-11-02T03:00:00.000Z')).toBe(
      'Nov 02, 2026 at 03:00 UTC',
    );
    expect(backupDateOf('2026-12-31T23:59:00+00:00')).toBe(
      'Dec 31, 2026 at 23:59 UTC',
    );
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
