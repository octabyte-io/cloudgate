import type Stripe from 'stripe';
import {
  downgradeDateOf,
  downgradeScheduleUpdate,
  scheduledAddOnsUpdate,
  scheduledMoveOf,
  scheduleFollowingSubscription,
} from '../../../src/cloud/billing/plan-downgrade';

// Business → Starter at the end of the paid month (ADR-0054): the
// schedule's phases, and an Add-on change while the move waits.

const DAY = 24 * 60 * 60;
const START = 1_780_000_000;
const END = START + 30 * DAY;

const PRICES = {
  starterPriceId: 'price_starter_plan',
  businessPriceId: 'price_business_plan',
  addOnPriceId: 'price_add_on',
};

/** A schedule as `from_subscription` makes it: this month, as it is. */
const madeFromSubscription = (
  addOns: number,
  lines: Array<{ price: string; quantity: number }> = [],
) =>
  ({
    id: 'sub_sched_1',
    phases: [
      {
        start_date: START,
        end_date: END,
        items: [
          { price: { id: 'price_business_plan' }, quantity: 1 },
          ...(addOns > 0 ? [{ price: 'price_add_on', quantity: addOns }] : []),
          ...lines,
        ],
      },
    ],
  }) as unknown as Stripe.SubscriptionSchedule;

describe('downgradeScheduleUpdate', () => {
  it('keeps this month as it is to its end, then Starter with the same Add-ons, prorating nothing', () => {
    expect(downgradeScheduleUpdate(madeFromSubscription(2), PRICES, 2)).toEqual(
      {
        end_behavior: 'release',
        proration_behavior: 'none',
        phases: [
          {
            items: [
              { price: 'price_business_plan', quantity: 1 },
              { price: 'price_add_on', quantity: 2 },
            ],
            start_date: START,
            end_date: END,
          },
          {
            items: [
              { price: 'price_starter_plan', quantity: 1 },
              { price: 'price_add_on', quantity: 2 },
            ],
            duration: { interval: 'month', interval_count: 1 },
            proration_behavior: 'none',
          },
        ],
      },
    );
  });

  it('carries every Bought Server line into the Starter phase, so the move drops none of them', () => {
    const lines = [
      { price: 'price_bs_server', quantity: 1 },
      { price: 'price_bs_backups', quantity: 1 },
    ];
    const update = downgradeScheduleUpdate(
      madeFromSubscription(1, lines),
      PRICES,
      1,
    );
    expect(update.phases?.[1]?.items).toEqual([
      { price: 'price_starter_plan', quantity: 1 },
      ...lines,
      { price: 'price_add_on', quantity: 1 },
    ]);
  });

  it('leaves the Add-on item out of the Starter phase when there are none', () => {
    const update = downgradeScheduleUpdate(madeFromSubscription(0), PRICES, 0);
    expect(update.phases?.[1]?.items).toEqual([
      { price: 'price_starter_plan', quantity: 1 },
    ]);
  });

  it('refuses a schedule with no phases', () => {
    expect(() =>
      downgradeScheduleUpdate(
        {
          id: 'sub_sched_1',
          phases: [],
        } as unknown as Stripe.SubscriptionSchedule,
        PRICES,
        0,
      ),
    ).toThrow('sub_sched_1');
  });
});

describe('scheduledAddOnsUpdate', () => {
  /** The schedule once the downgrade has written its two phases. */
  const waiting = (addOns: number) =>
    ({
      id: 'sub_sched_1',
      phases: [
        {
          start_date: START,
          end_date: END,
          proration_behavior: 'create_prorations',
          items: [
            { price: 'price_business_plan', quantity: 1 },
            { price: 'price_add_on', quantity: addOns },
          ],
        },
        {
          start_date: END,
          end_date: END + 30 * DAY,
          proration_behavior: 'none',
          items: [
            { price: 'price_starter_plan', quantity: 1 },
            { price: 'price_add_on', quantity: addOns },
          ],
        },
      ],
    }) as unknown as Stripe.SubscriptionSchedule;

  it('writes the new count to both phases, each keeping its dates, prorating this month', () => {
    expect(
      scheduledAddOnsUpdate(waiting(2), 'price_add_on', 5, START + DAY),
    ).toEqual({
      proration_behavior: 'create_prorations',
      phases: [
        {
          items: [
            { price: 'price_business_plan', quantity: 1 },
            { price: 'price_add_on', quantity: 5 },
          ],
          start_date: START,
          end_date: END,
          proration_behavior: 'create_prorations',
        },
        {
          items: [
            { price: 'price_starter_plan', quantity: 1 },
            { price: 'price_add_on', quantity: 5 },
          ],
          end_date: END + 30 * DAY,
          proration_behavior: 'none',
        },
      ],
    });
  });

  it('drops the Add-on item from both phases at 0', () => {
    const update = scheduledAddOnsUpdate(
      waiting(2),
      'price_add_on',
      0,
      START + DAY,
    );
    expect(update.phases?.map((phase) => phase.items)).toEqual([
      [{ price: 'price_business_plan', quantity: 1 }],
      [{ price: 'price_starter_plan', quantity: 1 }],
    ]);
  });

  it('leaves out a phase that has ended', () => {
    const update = scheduledAddOnsUpdate(
      waiting(2),
      'price_add_on',
      3,
      END + DAY,
    );
    expect(update.phases).toHaveLength(1);
    expect(update.phases?.[0]).toEqual(
      expect.objectContaining({ start_date: END }),
    );
  });
});

describe('scheduleFollowingSubscription', () => {
  /** The schedule once the downgrade has written its two phases. */
  const waiting = (lines: Array<{ price: string; quantity: number }>) =>
    ({
      id: 'sub_sched_1',
      phases: [
        {
          start_date: START,
          end_date: END,
          proration_behavior: 'create_prorations',
          items: [
            { price: 'price_business_plan', quantity: 1 },
            { price: 'price_add_on', quantity: 1 },
            ...lines,
          ],
        },
        {
          start_date: END,
          end_date: END + 30 * DAY,
          proration_behavior: 'none',
          items: [
            { price: 'price_starter_plan', quantity: 1 },
            { price: 'price_add_on', quantity: 1 },
            ...lines,
          ],
        },
      ],
    }) as unknown as Stripe.SubscriptionSchedule;

  const held = (...lines: string[]) => [
    { priceId: 'price_business_plan', quantity: 1 },
    { priceId: 'price_add_on', quantity: 1 },
    ...lines.map((priceId) => ({ priceId, quantity: 1 })),
  ];

  it('writes a line the subscription gained to every phase, this one as the subscription holds it, prorating nothing more', () => {
    expect(
      scheduleFollowingSubscription(
        waiting([]),
        held('price_bs_server'),
        PRICES,
        START + DAY,
      ),
    ).toEqual({
      proration_behavior: 'none',
      phases: [
        {
          items: [
            { price: 'price_business_plan', quantity: 1 },
            { price: 'price_add_on', quantity: 1 },
            { price: 'price_bs_server', quantity: 1 },
          ],
          start_date: START,
          end_date: END,
          proration_behavior: 'create_prorations',
        },
        {
          items: [
            { price: 'price_starter_plan', quantity: 1 },
            { price: 'price_add_on', quantity: 1 },
            { price: 'price_bs_server', quantity: 1 },
          ],
          end_date: END + 30 * DAY,
          proration_behavior: 'none',
        },
      ],
    });
  });

  it('takes a line the subscription dropped, or swapped for a new price, off the Starter phase too', () => {
    const update = scheduleFollowingSubscription(
      waiting([
        { price: 'price_bs_server', quantity: 1 },
        { price: 'price_bs_backups', quantity: 1 },
      ]),
      held('price_bs_server_repriced'),
      PRICES,
      START + DAY,
    );
    expect(update?.phases?.[1]?.items).toEqual([
      { price: 'price_starter_plan', quantity: 1 },
      { price: 'price_add_on', quantity: 1 },
      { price: 'price_bs_server_repriced', quantity: 1 },
    ]);
  });

  it("is nothing when every phase already carries the subscription's lines", () => {
    expect(
      scheduleFollowingSubscription(
        waiting([{ price: 'price_bs_server', quantity: 1 }]),
        held('price_bs_server'),
        PRICES,
        START + DAY,
      ),
    ).toBeNull();
  });
});

describe('downgradeDateOf', () => {
  it('is the end of the first phase, the end of the paid month', () => {
    expect(downgradeDateOf(madeFromSubscription(0))).toEqual(
      new Date(END * 1000),
    );
  });
});

describe('scheduledMoveOf', () => {
  it('is Starter at the stored date while a schedule is stored, and nothing otherwise', () => {
    const at = new Date(END * 1000);
    expect(
      scheduledMoveOf({ stripeScheduleId: 'sub_sched_1', downgradeAt: at }),
    ).toEqual({ scheduledPlan: 'starter', scheduledAt: at });
    expect(scheduledMoveOf({ stripeScheduleId: null, downgradeAt: null })).toBe(
      null,
    );
    expect(scheduledMoveOf(null)).toBe(null);
  });
});
