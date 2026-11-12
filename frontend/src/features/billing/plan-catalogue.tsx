import { useState } from "react";

import { Card } from "@/components/console/card";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import {
  BILLING_PLANS,
  formatDay,
  type BillingPlan,
  type BillingState,
  type Catalogue as CatalogueView,
} from "@/lib/api/endpoints/billing";
import {
  useCheckout,
  useKeepBusiness,
  useSetAddOns,
} from "@/lib/api/use-billing";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { counted } from "@/lib/format/plural";

import { AddOnStepper } from "./add-on-stepper";
import { PlanPickGrid } from "./plan-pick-grid";
import { monthlyTotal } from "./plan-prices";
import { PlanSwitchActions } from "./plan-switch-actions";
import { TRIAL_DAYS, TrialTerms } from "./trial-terms";

/**
 * The two Hosted plans, Starter and Business, side by side, with one Add-on
 * picker both share (ADR-0054), once the catalogue has answered. Split
 * out of `plans-card.tsx`, which owns the states around it — waiting, refused,
 * and this. Its parts are their own files: the cards (`PlanPickGrid`), the
 * Add-on stepper (`AddOnStepper`), the trial's terms (`TrialTerms`) and the
 * plan switches (`PlanSwitchActions`); this holds the order they make and the
 * button that sends it.
 *
 * ## One order: the picked card plus the Add-ons
 *
 * With no plan, the owner picks a card (Business to start with), sets the
 * Add-ons, reads "Today, then every month: <total>", and one "Subscribe"
 * button sends that order to Stripe Checkout. The total is the picked plan's
 * price plus the Add-ons', from the prices Stripe answered with; it is left
 * out when a price is not a plain monthly amount, rather than guessed.
 *
 * ## The picker cannot go below what the Organization uses
 *
 * `minimumAddOns` is the backend's count of what the Organization already
 * holds beyond the plan's base 3. The picker starts at the larger of it and the
 * current Add-ons, and its "fewer" button stops there, so nobody buys less than
 * they hold. The backend raises a lower quantity to the same floor anyway; the
 * picker says so before the button rather than after.
 *
 * ## The free trial
 *
 * When `trialAvailable` (the Organization and the reader are both eligible),
 * the same order starts the 30-day free trial instead: the total reads
 * "Free for 30 days, then from <date>: <total> per month", with the
 * one-trial-per-person-and-card rule and the cancel line under it, and the
 * button says "Start 30-day free trial". Not eligible, it is "Subscribe" and
 * nothing mentions a trial.
 *
 * ## The Add-on change for a plan already held
 *
 * With a plan the cards only say which one is held, and the button sets the
 * Add-on quantity on the subscription the Organization already has, and Stripe
 * prorates. Offering checkout there would be offering a second subscription,
 * which the backend refuses. The Add-ons can still change while a downgrade
 * waits; the count carries across the move.
 *
 * ## Switching plans
 *
 * Upgrade, downgrade, "Keep Business" and the switch during a free trial sit
 * beside the button, in `PlanSwitchActions`, each with its own confirm.
 */
export function Catalogue({
  catalogue,
  subscription,
}: {
  catalogue: CatalogueView;
  subscription: BillingState;
}) {
  const checkout = useCheckout();
  const setAddOns = useSetAddOns();
  const keepBusiness = useKeepBusiness();
  // BillingService admits an owner or admin, who both hold this.
  const canManage = usePermission({ organization: ["update"] });

  const held = subscription.allowance.plan !== null;
  const heldPlan = held ? subscription.plan : null;
  const floor = subscription.minimumAddOns;
  const [picked, setPicked] = useState<BillingPlan>(pickedFromUrl);
  const movesOn =
    subscription.scheduledPlan === "starter" && subscription.scheduledAt
      ? formatDay(subscription.scheduledAt)
      : null;
  const [wanted, setWanted] = useState(
    Math.max(held ? subscription.addOns : 0, floor),
  );
  const addOns = Math.max(wanted, floor);
  const pending =
    checkout.isPending || setAddOns.isPending || keepBusiness.isPending;
  const unchanged = held && addOns === subscription.addOns;
  const plan = held ? heldPlan : picked;
  const monthly = plan
    ? monthlyTotal(catalogue.plans[plan], catalogue.addOn, addOns)
    : null;
  const trial = !held && subscription.trialAvailable;

  return (
    <Card>
      <Card.Header
        title="Plans"
        sub={
          held
            ? "Changing the Add-ons updates the subscription you already have, and Stripe prorates the difference."
            : "Choosing a plan takes you to Stripe to pay. Nothing changes here until the payment goes through."
        }
        headingLevel={2}
      />
      <Card.Body className="grid gap-4">
        <PlanPickGrid
          catalogue={catalogue}
          heldPlan={heldPlan}
          picked={picked}
          movesOn={movesOn}
          inert={held || pending}
          onPick={setPicked}
        />

        <AddOnStepper
          addOns={addOns}
          floor={floor}
          includes={catalogue.includes}
          addOn={catalogue.addOn}
          disabled={pending}
          onChange={setWanted}
        />

        {trial ? (
          <TrialTerms today={new Date()} monthly={monthly} />
        ) : monthly ? (
          <p
            aria-label="Total"
            className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-3 text-ui text-tx"
          >
            <span>{held ? "Every month" : "Today, then every month"}</span>
            <strong className="num font-semibold">{monthly}</strong>
          </p>
        ) : null}

        <div>
          <Button
            type="button"
            variant="pri"
            disabled={!canManage.allowed || pending || unchanged}
            title={canManage.allowed ? undefined : ORDER_REFUSAL}
            aria-busy={pending || undefined}
            onClick={async () => {
              try {
                if (held) {
                  const result = await setAddOns.mutateAsync({ addOns });
                  toast.done(
                    `The subscription now has ${counted(result.addOns, "Add-on", "Add-ons")}. Stripe will prorate the difference.`,
                  );
                } else {
                  const { url } = await checkout.mutateAsync({
                    plan: picked,
                    addOns,
                  });
                  window.location.href = url;
                }
              } catch (error) {
                toast.error(error);
              }
            }}
          >
            {held
              ? "Update Add-ons"
              : trial
                ? `Start ${TRIAL_DAYS}-day free trial`
                : "Subscribe"}
          </Button>
          <PlanSwitchActions
            subscription={subscription}
            heldPlan={heldPlan}
            movesOn={movesOn}
            disabled={pending}
            keepBusiness={keepBusiness}
          />
        </div>
      </Card.Body>
    </Card>
  );
}

/**
 * The plan `?plan=` names, else Business. A paid-feature page with no plan
 * links here with `?plan=business`, so the picker opens on the plan
 * that page is about.
 */
function pickedFromUrl(): BillingPlan {
  if (typeof window === "undefined") return "business";
  const named = new URLSearchParams(window.location.search).get("plan");
  return BILLING_PLANS.find((plan) => plan === named) ?? "business";
}

const ORDER_REFUSAL = roleRefusal("change this Organization's plan");
