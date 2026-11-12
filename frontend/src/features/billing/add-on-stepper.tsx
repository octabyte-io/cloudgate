import { Button } from "@/components/ui/button";
import type { PriceView } from "@/lib/api/endpoints/billing";

import { priceText } from "./plan-prices";

/**
 * The one Add-on stepper both plans share, and what the count buys.
 * Its "fewer" button stops at `floor`, what the Organization already uses
 * beyond the plan's base, so nobody buys less than they hold.
 */
export function AddOnStepper({
  addOns,
  floor,
  includes,
  addOn,
  disabled,
  onChange,
}: {
  addOns: number;
  floor: number;
  /** What either plan includes before any Add-on. */
  includes: number;
  addOn: PriceView;
  disabled: boolean;
  onChange: (addOns: number) => void;
}) {
  const total = includes + addOns;
  return (
    <section aria-label="Add-ons" className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-ui font-medium text-tx" id="billing-add-ons">
          Add-ons
        </span>
        <div
          role="group"
          aria-labelledby="billing-add-ons"
          className="flex items-center gap-2"
        >
          <Button
            type="button"
            size="sm"
            aria-label="Fewer Add-ons"
            disabled={addOns <= floor || disabled}
            onClick={() => onChange(Math.max(floor, addOns - 1))}
          >
            −
          </Button>
          <output
            aria-live="polite"
            aria-label="Add-ons chosen"
            className="num w-8 text-center text-body font-semibold text-tx"
          >
            {addOns}
          </output>
          <Button
            type="button"
            size="sm"
            aria-label="More Add-ons"
            disabled={disabled}
            onClick={() => onChange(addOns + 1)}
          >
            +
          </Button>
        </div>
        <span className="text-meta text-tx-2">{priceText(addOn)} each</span>
      </div>
      <p className="text-meta text-tx-2">
        Each Add-on is one more Server and one more Cloud Environment, on either
        plan. With{" "}
        <strong className="num font-semibold text-tx">{addOns}</strong>, this
        Organization may hold{" "}
        <strong className="num font-semibold text-tx">{total}</strong> Servers
        and {total} Cloud Environments.
        {floor > 0
          ? ` It already uses ${floor} beyond the plan's ${includes}, so it cannot have fewer than ${floor}.`
          : null}
      </p>
    </section>
  );
}
