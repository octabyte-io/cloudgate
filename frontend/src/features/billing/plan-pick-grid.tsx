import { Chip } from "@/components/console/chip";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import {
  BILLING_PLANS,
  PLAN_LABELS,
  type BillingPlan,
  type Catalogue,
  type PriceView,
} from "@/lib/api/endpoints/billing";

import { priceText } from "./plan-prices";

/** What Business adds over Starter (ADR-0054), as the Business card lists it. */
export const BUSINESS_FEATURES = [
  "SSO sign-in",
  "SCIM: people added and removed from your identity provider",
  "Custom roles",
  "Forward auth for your apps",
] as const;

/**
 * Starter and Business side by side: each card's price, counts and,
 * for Business, the four paid features. With no plan the reader picks one;
 * with a plan the cards only say which is held, and a waiting downgrade
 * reads "Moves to Starter on <date>" on Business and "From <date>" on
 * Starter.
 */
export function PlanPickGrid({
  catalogue,
  heldPlan,
  picked,
  movesOn,
  inert,
  onPick,
}: {
  catalogue: Catalogue;
  /** The plan held, or null with none. */
  heldPlan: BillingPlan | null;
  picked: BillingPlan;
  /** The day a waiting downgrade moves to Starter, formatted; null if none. */
  movesOn: string | null;
  inert: boolean;
  onPick: (plan: BillingPlan) => void;
}) {
  const held = heldPlan !== null;
  return (
    <PickGrid label="Plans">
      {BILLING_PLANS.map((name) => (
        <PickCard
          key={name}
          aria-label={PLAN_LABELS[name]}
          title={
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              {catalogue.plans[name].name ?? PLAN_LABELS[name]}
              {heldPlan === name ? (
                <Chip variant="brand">Your plan</Chip>
              ) : null}
              {movesOn && heldPlan === name && name === "business" ? (
                <Chip>Moves to Starter on {movesOn}</Chip>
              ) : null}
              {movesOn && name === "starter" ? (
                <Chip>From {movesOn}</Chip>
              ) : null}
            </span>
          }
          description={
            <span className="num text-ui font-medium text-tx">
              {priceText(catalogue.plans[name])}
            </span>
          }
          footer={
            <PlanIncludes
              plan={name}
              includes={catalogue.includes}
              addOn={catalogue.addOn}
            />
          }
          selected={held ? heldPlan === name : picked === name}
          inert={inert}
          onClick={inert ? undefined : () => onPick(name)}
        />
      ))}
    </PickGrid>
  );
}

/** What a plan's card lists: the counts, the Add-on, and Business's four. */
function PlanIncludes({
  plan,
  includes,
  addOn,
}: {
  plan: BillingPlan;
  includes: number;
  addOn: PriceView;
}) {
  return (
    <ul className="grid list-disc gap-0.5 pl-4 text-meta text-tx-2">
      <li>
        {includes} Servers and {includes} Cloud Environments
      </li>
      <li>More with Add-ons, {priceText(addOn)} each</li>
      {plan === "business" ? (
        BUSINESS_FEATURES.map((feature) => <li key={feature}>{feature}</li>)
      ) : (
        <li className="text-tx-3">
          No SSO, SCIM, custom roles or forward auth
        </li>
      )}
    </ul>
  );
}
