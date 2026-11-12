import { formatDay } from "@/lib/api/endpoints/billing";

/** How long the free trial lasts (ADR-0054). */
export const TRIAL_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The free trial's terms, in place of the picker's total: free now,
 * the monthly total from the day it ends (left out when the prices cannot be
 * added), the card rule (a card that has had a trial before ends this one), and the
 * cancel line. The end is 30 days from `today`, as Stripe counts it from the
 * Checkout.
 */
export function TrialTerms({
  today,
  monthly,
}: {
  today: Date;
  monthly: string | null;
}) {
  const ends = formatDay(new Date(today.getTime() + TRIAL_DAYS * DAY_MS));
  return (
    <div className="grid gap-1 border-t border-line pt-3">
      <p aria-label="Total" className="text-ui text-tx">
        Free for {TRIAL_DAYS} days
        {monthly ? (
          <>
            , then from {ends}:{" "}
            <strong className="num font-semibold">{monthly}</strong> per month
          </>
        ) : null}
      </p>
      <p className="text-meta text-tx-2">
        One free trial per person and per card. If this card has had one,
        you&rsquo;ll be charged today.
      </p>
      <p className="text-meta text-tx-2">
        You can cancel any time before {ends} and pay nothing.
      </p>
    </div>
  );
}
