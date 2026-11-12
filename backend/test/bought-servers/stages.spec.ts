import { BOUGHT_SERVER_STAGES } from '../../src/bought-servers/bought-server.schema';
import type { BoughtServerStage } from '../../src/bought-servers/bought-server.schema';
import {
  CANCEL_TOO_LATE,
  DELETE_NOT_PAID,
  DELETE_WHILE_CREATING,
  MAX_CREATE_TRIES,
  MAX_SETUP_STARTS,
  MID_STAGE,
  nextStep,
  onDelete,
  onPurchase,
} from '../../src/bought-servers/stages';
import type { StageFacts } from '../../src/bought-servers/stages';

const PAID_AT = new Date('2026-11-10T12:00:00Z');

function facts(overrides: Partial<StageFacts> = {}): StageFacts {
  return {
    stage: 'creating',
    purchasePaidAt: PAID_AT,
    createTries: 0,
    providerServerId: null,
    serverId: null,
    setupStarts: 0,
    linesOnSubscription: 0,
    ...overrides,
  };
}

const PAST_PAYMENT = BOUGHT_SERVER_STAGES.filter(
  (stage) => stage !== 'waiting_for_payment',
);

describe('onPurchase: what a payment does while the Server waits for it', () => {
  it('moves a paid purchase to Creating', () => {
    expect(onPurchase('waiting_for_payment', 'paid')).toEqual({
      kind: 'advance',
      stage: 'creating',
    });
  });

  it.each(['refused', 'dropped', 'cancelled'] as const)(
    'removes the row when the payment is %s',
    (event) => {
      expect(onPurchase('waiting_for_payment', event)).toEqual({
        kind: 'remove',
      });
    },
  );

  it.each(PAST_PAYMENT)(
    'ignores a second "paid" once the Server is %s, so a webhook delivered twice changes nothing',
    (stage) => {
      expect(onPurchase(stage, 'paid')).toEqual({ kind: 'ignore' });
    },
  );

  it.each(PAST_PAYMENT)(
    'never removes a Server that is %s for a late refusal or drop',
    (stage) => {
      expect(onPurchase(stage, 'refused')).toEqual({ kind: 'ignore' });
      expect(onPurchase(stage, 'dropped')).toEqual({ kind: 'ignore' });
    },
  );

  it.each(PAST_PAYMENT)('refuses Cancel once the Server is %s', (stage) => {
    expect(onPurchase(stage, 'cancelled')).toEqual({
      kind: 'refuse',
      message: CANCEL_TOO_LATE,
    });
  });
});

describe('nextStep: Waiting for payment', () => {
  it('waits, whatever else the row holds, so nothing reaches the provider before payment', () => {
    expect(
      nextStep(
        facts({
          stage: 'waiting_for_payment',
          purchasePaidAt: null,
          createTries: 0,
        }),
      ),
    ).toEqual({ kind: 'wait-for-payment' });
  });
});

describe('nextStep: Creating', () => {
  it('creates the machine once the payment is stored', () => {
    expect(nextStep(facts())).toEqual({
      kind: 'create-machine',
      findFirst: false,
    });
  });

  it('waits rather than creating when no payment is stored', () => {
    expect(nextStep(facts({ purchasePaidAt: null }))).toEqual({
      kind: 'wait-for-payment',
    });
  });

  it('looks for the machine by its labels first once a try was already made', () => {
    expect(nextStep(facts({ createTries: 1 }))).toEqual({
      kind: 'create-machine',
      findFirst: true,
    });
  });

  it(`gives up after ${MAX_CREATE_TRIES} tries`, () => {
    expect(nextStep(facts({ createTries: MAX_CREATE_TRIES }))).toEqual({
      kind: 'give-up',
    });
  });

  it('never creates again once the machine id is stored: it records the Server', () => {
    expect(nextStep(facts({ providerServerId: 42, createTries: 1 }))).toEqual({
      kind: 'record-server',
    });
    // Even past the tries: the machine exists, so there is nothing to give up on.
    expect(
      nextStep(facts({ providerServerId: 42, createTries: MAX_CREATE_TRIES })),
    ).toEqual({ kind: 'record-server' });
  });

  it('has nothing left once the server row is written', () => {
    expect(nextStep(facts({ providerServerId: 42, serverId: 'abc' }))).toEqual({
      kind: 'none',
    });
  });
});

describe('nextStep: Setting up', () => {
  const settingUp = (setupStarts: number) =>
    facts({
      stage: 'setting_up',
      providerServerId: 42,
      serverId: 'abc',
      setupStarts,
    });

  it('starts the first Setup run, which Buy pressed for', () => {
    expect(nextStep(settingUp(0))).toEqual({ kind: 'start-setup' });
  });

  it('runs it once more when a restart cut the first one off', () => {
    expect(nextStep(settingUp(1))).toEqual({ kind: 'start-setup' });
  });

  it(`starts nothing more after ${MAX_SETUP_STARTS} starts: the run is given up as failed`, () => {
    expect(nextStep(settingUp(MAX_SETUP_STARTS))).toEqual({
      kind: 'setup-cut-off',
    });
    expect(MAX_SETUP_STARTS).toBe(2);
  });
});

describe('nextStep: past Setting up', () => {
  it('refunds a Failed purchase, whatever else the row holds, until its row is gone', () => {
    expect(
      nextStep(facts({ stage: 'failed', createTries: MAX_CREATE_TRIES })),
    ).toEqual({ kind: 'refund' });
  });

  it.each(['ready', 'deleted'] as BoughtServerStage[])(
    'does nothing by itself once %s',
    (stage) => {
      expect(
        nextStep(facts({ stage, providerServerId: 42, serverId: 'abc' })),
      ).toEqual({ kind: 'none' });
    },
  );
});

describe('MID_STAGE: the stages the hourly job resumes', () => {
  it('holds every stage a restart can leave work in', () => {
    expect([...MID_STAGE].sort()).toEqual(
      ['changing', 'creating', 'deleting', 'failed', 'setting_up'].sort(),
    );
  });

  it('never holds Waiting for payment, which only a payment moves on', () => {
    expect(MID_STAGE).not.toContain('waiting_for_payment');
  });
});

describe('onDelete: what Delete does at each stage', () => {
  it.each(['setting_up', 'ready', 'changing', 'failed'] as BoughtServerStage[])(
    'starts Deleting from %s',
    (stage) => {
      expect(onDelete(stage)).toEqual({ kind: 'start' });
    },
  );

  it.each(['deleting', 'deleted'] as BoughtServerStage[])(
    'only forgets the Server once %s, so a second Delete makes no provider call',
    (stage) => {
      expect(onDelete(stage)).toEqual({ kind: 'forget' });
    },
  );

  it('refuses a purchase not paid for yet: that is Cancel', () => {
    expect(onDelete('waiting_for_payment')).toEqual({
      kind: 'refuse',
      message: DELETE_NOT_PAID,
    });
  });

  it('refuses while the machine is being made, so a create is never raced', () => {
    expect(onDelete('creating')).toEqual({
      kind: 'refuse',
      message: DELETE_WHILE_CREATING,
    });
  });

  it('never names the provider in a refusal', () => {
    for (const stage of BOUGHT_SERVER_STAGES) {
      const outcome = onDelete(stage);
      if (outcome.kind === 'refuse') {
        expect(outcome.message).not.toMatch(/hetzner/i);
      }
    }
  });
});

describe('nextStep: Deleting', () => {
  const deleting = (overrides: Partial<StageFacts> = {}) =>
    facts({
      stage: 'deleting',
      providerServerId: 42,
      serverId: null,
      ...overrides,
    });

  it('takes the lines off the subscription first, so the credit runs from the press', () => {
    expect(nextStep(deleting({ linesOnSubscription: 2 }))).toEqual({
      kind: 'remove-lines',
    });
  });

  it('gives back a change it was in the middle of before its lines leave', () => {
    expect(
      nextStep(
        deleting({
          linesOnSubscription: 2,
          changeTarget: { charged: true, lines: [], backups: true },
          changeInvoiceId: 'in_change',
        }),
      ),
    ).toEqual({ kind: 'abandon-change' });
  });

  it('deletes the machine, its Volume and its Primary IPs once no line is left', () => {
    expect(nextStep(deleting())).toEqual({ kind: 'delete-machine' });
  });

  it('deletes even when the Server row is still there (a record kept for its Services)', () => {
    expect(nextStep(deleting({ serverId: 'abc' }))).toEqual({
      kind: 'delete-machine',
    });
  });

  it('does nothing once Deleted, which is final', () => {
    expect(
      nextStep(facts({ stage: 'deleted', linesOnSubscription: 1 })),
    ).toEqual({ kind: 'none' });
  });
});
