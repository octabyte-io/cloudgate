import type Stripe from 'stripe';
import type { StripeApi } from '../../src/cloud/billing/stripe-api';

/**
 * The one fake Stripe the e2e specs share: the whole `StripeApi` port,
 * every method a `jest.fn()` that answers nothing, except
 * `listBillingPortalConfigurations`, which answers an empty list (a plain
 * function, so `jest.resetAllMocks()` leaves it answering) and so the portal
 * route makes its own configuration, and `listWebhookEndpoints`, which
 * answers an empty list the same way for the Hosted start-up check.
 *
 * A spec passes the methods its tests drive — usually its own `jest.fn()`s, so
 * it can assert on and re-arm them — and keeps the defaults for the rest. A
 * method added to the port is added here once, rather than in every spec.
 *
 *   const stripe = fakeStripe({ retrieveSubscription, constructEvent });
 *   createTestApp({
 *     overrideProviders: [{ provide: STRIPE_API, useValue: stripe }],
 *   });
 *
 * Subscription schedules have a model of their own, `fakeSubscriptionSchedules`
 * below, whose methods a spec passes in the same way.
 */
export function fakeStripe(overrides: Partial<StripeApi> = {}): StripeApi {
  const defaults: StripeApi = {
    retrievePrice: jest.fn(),
    retrieveSubscription: jest.fn(),
    retrieveCustomer: jest.fn(),
    createCheckoutSession: jest.fn(),
    createBillingPortalSession: jest.fn(),
    listBillingPortalConfigurations: () => Promise.resolve([]),
    createBillingPortalConfiguration: jest.fn(),
    updateSubscription: jest.fn(),
    listInvoices: jest.fn(),
    previewInvoice: jest.fn(),
    createSubscriptionSchedule: jest.fn(),
    retrieveSubscriptionSchedule: jest.fn(),
    updateSubscriptionSchedule: jest.fn(),
    releaseSubscriptionSchedule: jest.fn(),
    retrievePaymentMethod: jest.fn(),
    createProduct: jest.fn(),
    createPrice: jest.fn(),
    retrieveInvoice: jest.fn(),
    voidInvoice: jest.fn(),
    createRefund: jest.fn(),
    createBalanceTransaction: jest.fn(),
    createInvoice: jest.fn(),
    createInvoiceItem: jest.fn(),
    finalizeInvoice: jest.fn(),
    payInvoice: jest.fn(),
    retrieveCheckoutSession: jest.fn(),
    expireCheckoutSession: jest.fn(),
    retrieveCharge: jest.fn(),
    listWebhookEndpoints: () => Promise.resolve([]),
    constructEvent: jest.fn(),
  };
  return { ...defaults, ...overrides };
}

type ScheduleMethods = Pick<
  StripeApi,
  | 'createSubscriptionSchedule'
  | 'retrieveSubscriptionSchedule'
  | 'updateSubscriptionSchedule'
  | 'releaseSubscriptionSchedule'
>;

/** A phase as the model keeps it: its dates and its items' prices. */
interface FakePhase {
  start_date: number;
  end_date: number;
  items: Array<{ price: string; quantity?: number }>;
  proration_behavior: Stripe.SubscriptionSchedule.Phase.ProrationBehavior;
}

interface FakeSchedule {
  id: string;
  subscription: Stripe.Subscription;
  status: Stripe.SubscriptionSchedule.Status;
  end_behavior: Stripe.SubscriptionSchedule.EndBehavior;
  phases: FakePhase[];
  /** The phase the subscription is in, by index. */
  current: number;
}

/** A month, as the model counts a `duration: { interval: 'month' }`. */
const MONTH_SECONDS = 30 * 24 * 60 * 60;

const INTERVAL_SECONDS: Record<string, number> = {
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  month: MONTH_SECONDS,
  year: 365 * 24 * 60 * 60,
};

/**
 * Stripe's subscription schedules, as a small in-memory model, so a
 * spec drives a downgrade end to end rather than scripting every answer:
 *
 *   * `createSubscriptionSchedule({ from_subscription })` takes over the
 *     subscription `reset` was given: one phase, its current items, from its
 *     items' `current_period_start` to `current_period_end`;
 *   * `updateSubscriptionSchedule` rewrites the phases as Stripe does — the
 *     first sent phase keeps its `start_date`, each later one starts where the
 *     one before ends and lasts its `end_date` or `duration` — and refuses a
 *     schedule that no longer manages its subscription;
 *   * `releaseSubscriptionSchedule` lets it go (`released`);
 *   * `advance(id)` is the renewal: the subscription enters the next phase,
 *     and the answer is the subscription as `customer.subscription.updated`
 *     would carry it. Past the last phase the schedule ends by its
 *     `end_behavior`, `completed` for anything but a release.
 *
 * The four methods are `jest.fn()`s, so a spec asserts on them; `reset` forgets
 * every schedule and re-arms them, and goes after `jest.resetAllMocks()`.
 */
export function fakeSubscriptionSchedules() {
  let schedules = new Map<string, FakeSchedule>();
  let subscriptionOf: (id: string) => Stripe.Subscription = () => {
    throw new Error('fakeSubscriptionSchedules: reset() was not called');
  };
  let next = 0;

  const methods = {
    createSubscriptionSchedule: jest.fn<
      Promise<Stripe.SubscriptionSchedule>,
      [Stripe.SubscriptionScheduleCreateParams]
    >(),
    retrieveSubscriptionSchedule: jest.fn<
      Promise<Stripe.SubscriptionSchedule>,
      [string]
    >(),
    updateSubscriptionSchedule: jest.fn<
      Promise<Stripe.SubscriptionSchedule>,
      [string, Stripe.SubscriptionScheduleUpdateParams]
    >(),
    releaseSubscriptionSchedule: jest.fn<
      Promise<Stripe.SubscriptionSchedule>,
      [string]
    >(),
  } satisfies ScheduleMethods;

  const find = (id: string): FakeSchedule => {
    const schedule = schedules.get(id);
    if (!schedule) throw new Error(`No such subscription schedule: ${id}`);
    return schedule;
  };

  const managing = (id: string): FakeSchedule => {
    const schedule = find(id);
    if (schedule.status !== 'active' && schedule.status !== 'not_started') {
      throw new Error(
        `You cannot update a subscription schedule that is ${schedule.status}`,
      );
    }
    return schedule;
  };

  const view = (schedule: FakeSchedule): Stripe.SubscriptionSchedule => {
    const active = schedule.status === 'active';
    const phase = schedule.phases[schedule.current];
    return {
      id: schedule.id,
      object: 'subscription_schedule',
      status: schedule.status,
      end_behavior: schedule.end_behavior,
      customer: schedule.subscription.customer,
      subscription: active ? schedule.subscription.id : null,
      released_subscription:
        schedule.status === 'released' ? schedule.subscription.id : null,
      current_phase:
        active && phase
          ? { start_date: phase.start_date, end_date: phase.end_date }
          : null,
      phases: schedule.phases.map((one) => ({
        ...one,
        items: one.items.map((item) => ({ ...item })),
      })),
    } as unknown as Stripe.SubscriptionSchedule;
  };

  /** The subscription as it is while in `schedule`'s current phase. */
  const subscriptionIn = (schedule: FakeSchedule): Stripe.Subscription => {
    const phase = schedule.phases[schedule.current];
    if (!phase) return schedule.subscription;
    const active = schedule.status === 'active';
    return {
      ...schedule.subscription,
      schedule: active ? schedule.id : null,
      items: {
        ...schedule.subscription.items,
        data: phase.items.map((item) => ({
          id:
            schedule.subscription.items.data.find(
              (held) => held.price.id === item.price,
            )?.id ?? `si_${item.price}`,
          price: { id: item.price },
          quantity: item.quantity ?? 1,
          current_period_start: phase.start_date,
          current_period_end: phase.end_date,
        })),
      },
    } as unknown as Stripe.Subscription;
  };

  function arm(): void {
    methods.createSubscriptionSchedule.mockImplementation((params) => {
      if (!params.from_subscription) {
        throw new Error('The model makes schedules from a subscription only');
      }
      const subscription = subscriptionOf(params.from_subscription);
      if (subscription.schedule) {
        throw new Error(
          `Subscription ${subscription.id} is already managed by a schedule`,
        );
      }
      const [first] = subscription.items.data;
      const schedule: FakeSchedule = {
        id: `sub_sched_${++next}`,
        subscription,
        status: 'active',
        end_behavior: 'release',
        current: 0,
        phases: [
          {
            start_date: first?.current_period_start ?? 0,
            end_date: first?.current_period_end ?? 0,
            items: subscription.items.data.map((item) => ({
              price: item.price.id,
              quantity: item.quantity ?? 1,
            })),
            proration_behavior: 'create_prorations',
          },
        ],
      };
      schedules.set(schedule.id, schedule);
      return Promise.resolve(view(schedule));
    });

    methods.retrieveSubscriptionSchedule.mockImplementation((id) =>
      Promise.resolve(view(find(id))),
    );

    methods.updateSubscriptionSchedule.mockImplementation((id, params) => {
      const schedule = managing(id);
      if (params.end_behavior) schedule.end_behavior = params.end_behavior;
      if (params.phases) {
        const phases: FakePhase[] = [];
        for (const sent of params.phases) {
          const previous = phases[phases.length - 1];
          const start =
            typeof sent.start_date === 'number'
              ? sent.start_date
              : (previous?.end_date ?? schedule.phases[0]?.start_date ?? 0);
          const end =
            typeof sent.end_date === 'number'
              ? sent.end_date
              : start +
                (INTERVAL_SECONDS[sent.duration?.interval ?? 'month'] ??
                  MONTH_SECONDS) *
                  (sent.duration?.interval_count ?? 1);
          phases.push({
            start_date: start,
            end_date: end,
            items: (sent.items ?? []).map((item) => ({
              price: item.price as string,
              ...(item.quantity === undefined
                ? {}
                : { quantity: item.quantity }),
            })),
            proration_behavior: sent.proration_behavior ?? 'create_prorations',
          });
        }
        // Past phases may be left out of an update; Stripe keeps them.
        const firstStart = phases[0]?.start_date ?? Infinity;
        const past = schedule.phases.filter(
          (phase) => phase.end_date <= firstStart,
        );
        schedule.phases = [...past, ...phases];
        schedule.current = past.length;
      }
      return Promise.resolve(view(schedule));
    });

    methods.releaseSubscriptionSchedule.mockImplementation((id) => {
      const schedule = managing(id);
      schedule.status = 'released';
      schedule.subscription = subscriptionIn(schedule);
      return Promise.resolve(view(schedule));
    });
  }

  return {
    methods,
    /**
     * Forgets every schedule and re-arms the methods. `subscription` answers
     * what `from_subscription` names, as Stripe holds it now.
     */
    reset(subscription: (id: string) => Stripe.Subscription): void {
      schedules = new Map();
      subscriptionOf = subscription;
      next = 0;
      arm();
    },
    /** The schedule as Stripe would answer it. */
    get(id: string): Stripe.SubscriptionSchedule {
      return view(find(id));
    },
    /** The ids of the schedules made, oldest first. */
    ids(): string[] {
      return [...schedules.keys()];
    },
    /**
     * The renewal: the subscription enters the schedule's next phase. Past
     * the last one, the schedule ends by its `end_behavior`. Answers the
     * subscription as it now is.
     */
    advance(id: string): Stripe.Subscription {
      const schedule = managing(id);
      if (schedule.current + 1 < schedule.phases.length) {
        schedule.current += 1;
        schedule.subscription = subscriptionIn(schedule);
        return schedule.subscription;
      }
      schedule.status =
        schedule.end_behavior === 'release' ? 'released' : 'completed';
      schedule.subscription = subscriptionIn(schedule);
      return schedule.subscription;
    },
  };
}

export type FakeSubscriptionSchedules = ReturnType<
  typeof fakeSubscriptionSchedules
>;
