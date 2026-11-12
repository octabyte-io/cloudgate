import type {
  BoughtServerChangeTarget,
  BoughtServerStage,
} from './bought-server.schema';

/**
 * A **Bought Server**'s stages (spec #1387, from #1383), pure: what a
 * purchase's payment does to the stage, and what to do next from the stored
 * row alone, so a backend restart resumes where it stopped and never repeats
 * a create.
 *
 * ```
 * Waiting for payment --paid--> Creating --machine answers--> Setting up --setup ok--> Ready
 * Waiting for payment --refused/dropped/cancel--> (row removed)
 * Creating --machine or Volume refused twice--> Failed (refund, machine deleted, owner emailed)
 * Setting up --setup fails--> Ready-with-Setup-failed
 * Ready --paid change--> Changing --done--> Ready
 * Changing --refused twice--> Ready (as before; refund; owner emailed)
 * Ready/any --Delete--> Deleting --> Deleted
 * ```
 *
 * This module holds Waiting for payment, Creating, Setting up, Changing and
 * Deleting; the later tickets add their stages' steps here, beside these.
 */

/** How many times the provider is asked to create a paid-for machine before the refund. */
export const MAX_CREATE_TRIES = 2;

/**
 * The stages a restart can leave work in, which the hourly job resumes
 * (#1391). Waiting for payment is not one: only a payment moves it on.
 * Ready and Deleted have nothing left to do by themselves.
 */
export const MID_STAGE: readonly BoughtServerStage[] = [
  'creating',
  'setting_up',
  'changing',
  'deleting',
  'failed',
];

/**
 * How many times the provider is asked to make a change before it is given
 * up: a paid change is then refunded in full, and the Server kept as it was.
 */
export const MAX_CHANGE_TRIES = 2;

/**
 * How long a charge (a purchase, or a costlier change) may go unsettled
 * before the hourly job reads it again from Stripe: longer than any press,
 * Finish paying or webhook takes, so it never races one still running.
 */
export const PAYMENT_RESUME_AFTER_MS = 15 * 60 * 1000;

/**
 * How long a payment may wait for 3D Secure: Stripe lets a pending update
 * expire after 23 hours, so one still open after a day is never paid.
 */
export const PAYMENT_ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How many times the backend starts a Bought Server's first Setup run by
 * itself: once for Buy, and once more if a backend restart cut that one off
 * (the amendment to ADR-0058). Every later run starts only from *Run setup*.
 */
export const MAX_SETUP_STARTS = 2;

/** What happened to a purchase's payment. */
export type PurchaseEvent =
  /** The payment went through: only now may the provider be asked for anything. */
  | 'paid'
  /** The card was refused. */
  | 'refused'
  /** The payment was abandoned: its invoice voided, or the update it held expired. */
  | 'dropped'
  /** The customer pressed *Cancel*. */
  | 'cancelled';

/** What a purchase's payment does to the row. */
export type PurchaseOutcome =
  | { kind: 'advance'; stage: 'creating' }
  /** The row and its lines go, with nothing charged. */
  | { kind: 'remove' }
  /** Already past it: a webhook delivered twice, or a payment seen by both the press and the webhook. */
  | { kind: 'ignore' }
  /** Not allowed from here, with the reason the customer is shown. */
  | { kind: 'refuse'; message: string };

export const CANCEL_TOO_LATE =
  'This Server is already paid for, so its purchase cannot be cancelled. Delete the Server instead';

/** What a purchase's payment means at this stage. */
export function onPurchase(
  stage: BoughtServerStage,
  event: PurchaseEvent,
): PurchaseOutcome {
  if (stage !== 'waiting_for_payment') {
    return event === 'cancelled'
      ? { kind: 'refuse', message: CANCEL_TOO_LATE }
      : { kind: 'ignore' };
  }
  return event === 'paid'
    ? { kind: 'advance', stage: 'creating' }
    : { kind: 'remove' };
}

/** The stored facts the next step is decided from. */
export interface StageFacts {
  stage: BoughtServerStage;
  /** When the purchase's payment was seen paid; null until then. */
  purchasePaidAt: Date | null;
  createTries: number;
  /** The machine's id, stored as soon as the create answers. */
  providerServerId: number | null;
  /** The `server` row, once written. */
  serverId: string | null;
  /** The change in progress, while the stage is Changing. */
  changeTarget?: BoughtServerChangeTarget | null;
  changeTries?: number;
  /** The invoice that paid for a charged change; stored only once it is paid. */
  changeInvoiceId?: string | null;
  /** How many times the first Setup run was started by the backend. */
  setupStarts: number;
  /**
   * How many of its lines the subscription still carries (a stored
   * subscription item): Deleting takes them off before anything else.
   */
  linesOnSubscription: number;
}

/** The one thing to do next for a Bought Server. */
export type NextStep =
  /** Nothing until the payment is seen: no provider call, ever, before it. */
  | { kind: 'wait-for-payment' }
  /**
   * Ask the provider for the machine. `findFirst` once a try has been made
   * already, so a restart that cut a create off looks for the machine by its
   * labels before making a second one.
   */
  | { kind: 'create-machine'; findFirst: boolean }
  /**
   * Refused {@link MAX_CREATE_TRIES} times: the stage becomes Failed, after
   * one last look by labels, since the last try may have made a machine a
   * restart cut off before its id was stored.
   */
  | { kind: 'give-up' }
  /**
   * Failed: the payment refunded in full, the lines taken off the
   * subscription, the row and its lines removed and the owner emailed. Each
   * step may be taken again, so a restart part-way finishes it.
   */
  | { kind: 'refund' }
  /**
   * The machine is made and its id stored: name its address (reverse DNS)
   * and write the `server` row, with the address, in one write.
   */
  | { kind: 'record-server' }
  /**
   * The first Setup run, which Buy already pressed for (the ADR-0058
   * amendment): started once the machine answers, and once more when a
   * restart cut it off. A run already in flight in this process is not
   * started again; the caller checks.
   */
  | { kind: 'start-setup' }
  /**
   * Ask the provider for the change, or finish it if the machine already
   * shows it (a restart after the provider answered): the lines are written,
   * a cheaper change is credited, and the stage is Ready again.
   */
  | { kind: 'apply-change' }
  /**
   * Refused {@link MAX_CHANGE_TRIES} times: a paid change is refunded in
   * full, its lines restored and the owner emailed; the Server is Ready
   * again, as it was.
   */
  | { kind: 'give-up-change' }
  /**
   * Started {@link MAX_SETUP_STARTS} times and cut off each time: Ready with
   * Setup failed, as a run that failed on the machine, and only *Run setup*
   * starts another.
   */
  | { kind: 'setup-cut-off' }
  /**
   * Deleting a Server that was Changing: a paid change is given back as a
   * change given up is (refunded in full, its lines put back as they were),
   * so the lines then leave at what was paid for them before it. The
   * change is then dropped from the row.
   */
  | { kind: 'abandon-change' }
  /**
   * Deleting: its lines off the subscription, with the unused part of the
   * month credited on the next invoice (ADR-0071: a credit, never cash).
   */
  | { kind: 'remove-lines' }
  /**
   * Deleting, once no line is charged: the machine with its backups, then
   * its Volume and its Primary IPs, which the provider would otherwise keep
   * billing. Then Deleted.
   */
  | { kind: 'delete-machine' }
  /** Nothing for the stages to do by themselves. */
  | { kind: 'none' };

/** What to do next, decided from the stored row alone. */
export function nextStep(facts: StageFacts): NextStep {
  switch (facts.stage) {
    case 'waiting_for_payment':
      return { kind: 'wait-for-payment' };
    case 'creating':
      // Never before the payment, whatever else the row says.
      if (facts.purchasePaidAt === null) return { kind: 'wait-for-payment' };
      if (facts.providerServerId !== null) {
        return facts.serverId === null
          ? { kind: 'record-server' }
          : { kind: 'none' };
      }
      if (facts.createTries >= MAX_CREATE_TRIES) return { kind: 'give-up' };
      return { kind: 'create-machine', findFirst: facts.createTries > 0 };
    case 'setting_up':
      return facts.setupStarts < MAX_SETUP_STARTS
        ? { kind: 'start-setup' }
        : { kind: 'setup-cut-off' };
    case 'failed':
      return { kind: 'refund' };
    case 'changing':
      return changeStep(facts);
    case 'deleting':
      // A change it was in the middle of first, then the lines: the
      // customer stops paying from the press, whatever the provider then
      // takes to answer.
      if (facts.changeTarget) return { kind: 'abandon-change' };
      return facts.linesOnSubscription > 0
        ? { kind: 'remove-lines' }
        : { kind: 'delete-machine' };
    default:
      return { kind: 'none' };
  }
}

/**
 * The next step of a change. A charged change never reaches the provider
 * before its payment is stored, as a purchase never does.
 */
function changeStep(facts: StageFacts): NextStep {
  const target = facts.changeTarget;
  if (!target) return { kind: 'none' };
  if (target.charged && !facts.changeInvoiceId) {
    return { kind: 'wait-for-payment' };
  }
  return (facts.changeTries ?? 0) >= MAX_CHANGE_TRIES
    ? { kind: 'give-up-change' }
    : { kind: 'apply-change' };
}

/** Whether a change costs more a month than the lines it replaces: then it is charged at once. */
export function changeCostsMore(
  current: ReadonlyArray<{ kind: string; monthlyCents: number }>,
  lines: ReadonlyArray<{ kind: string; monthlyCents: number | null }>,
): boolean {
  const before = lines.reduce(
    (sum, line) =>
      sum +
      (current.find((held) => held.kind === line.kind)?.monthlyCents ?? 0),
    0,
  );
  const after = lines.reduce((sum, line) => sum + (line.monthlyCents ?? 0), 0);
  return after > before;
}

/** What Delete does to a Bought Server. */
export type DeleteOutcome =
  /** To Deleting: its lines, its machine and everything billed with it go. */
  | { kind: 'start' }
  /**
   * Already Deleting or Deleted: only the `server` row goes, with no
   * provider call, so deleting a Deleted record afterwards is plain cleanup.
   */
  | { kind: 'forget' }
  /** Not from here, with the reason the customer is shown. */
  | { kind: 'refuse'; message: string };

export const DELETE_NOT_PAID =
  'This Server is not paid for yet. Cancel its purchase instead';
export const DELETE_WHILE_CREATING =
  'This Server is still being created. Delete it once it is set up';

/**
 * What Delete means at this stage. Deleting and Deleted are reached only
 * through it, and Deleted is final. A purchase still waiting for payment
 * has its own way out (*Cancel*), and one being created is refused rather
 * than raced: the create may answer after the delete.
 */
export function onDelete(stage: BoughtServerStage): DeleteOutcome {
  switch (stage) {
    case 'waiting_for_payment':
      return { kind: 'refuse', message: DELETE_NOT_PAID };
    case 'creating':
      return { kind: 'refuse', message: DELETE_WHILE_CREATING };
    case 'deleting':
    case 'deleted':
      return { kind: 'forget' };
    default:
      return { kind: 'start' };
  }
}
