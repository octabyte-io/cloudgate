import { useState } from "react";

import { toast } from "@/components/console/toast";
import { TrialSwitchConfirm } from "@/components/console/trial-switch-confirm";
import { UpgradeConfirm } from "@/components/console/upgrade-confirm";
import { Button } from "@/components/ui/button";
import {
  PLAN_LABELS,
  type BillingPlan,
  type BillingState,
} from "@/lib/api/endpoints/billing";
import {
  useAttachedOrganizations,
  type useKeepBusiness,
} from "@/lib/api/use-billing";

import { DowngradeConfirm } from "./downgrade-confirm";
import { StarterChecklist } from "./starter-checklist";

/**
 * The plan switches beside the picker's main button, each opening its own
 * confirm (ADR-0054):
 *
 * - on an active Starter subscription, "Upgrade to Business" opens
 *   `UpgradeConfirm`, the exact amount charged today first;
 * - on an active Business subscription, "Move to Starter" opens
 *   `DowngradeConfirm`, the move waiting for the end of the paid month
 * and while it waits "Keep Business" takes it back at no charge;
 * - during a free trial, "Switch to Business" or "Switch to Starter" opens
 *   `TrialSwitchConfirm`: at once and "0 USD, still free" either way.
 *
 * While this plan pays for other Organizations, either move to Starter stays
 * clickable but opens `StarterChecklist` first ("Before <Paying> can move to
 * Starter", ADR-0059); its own move hands over to the confirm above once
 * nothing is attached. A list not read yet goes straight to the confirm, and
 * the backend's `ORGANIZATIONS_ATTACHED` refusal says the rest.
 *
 * Plans are switched here, never at Stripe's portal. `keepBusiness` is the
 * picker's, so the whole picker waits while it runs.
 */
export function PlanSwitchActions({
  subscription,
  heldPlan,
  movesOn,
  disabled,
  keepBusiness,
}: {
  subscription: BillingState;
  heldPlan: BillingPlan | null;
  /** The day a waiting downgrade moves to Starter, formatted; null if none. */
  movesOn: string | null;
  disabled: boolean;
  keepBusiness: ReturnType<typeof useKeepBusiness>;
}) {
  const [upgrading, setUpgrading] = useState(false);
  const [downgrading, setDowngrading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [checklist, setChecklist] = useState<"downgrade" | "switch" | null>(
    null,
  );
  const attached = useAttachedOrganizations();
  const anyAttached = (attached.data?.organizations.length ?? 0) > 0;

  const active = subscription.status === "active";
  const canUpgrade = heldPlan === "starter" && active;
  const canDowngrade = heldPlan === "business" && active && !movesOn;
  const trialEndsAt = subscription.trial?.endsAt ?? null;
  const trialSwitchTo: BillingPlan | null =
    heldPlan && trialEndsAt
      ? heldPlan === "starter"
        ? "business"
        : "starter"
      : null;

  /** The move to Starter: the checklist first while anything is attached. */
  function moveToStarter(kind: "downgrade" | "switch") {
    if (anyAttached) setChecklist(kind);
    else if (kind === "downgrade") setDowngrading(true);
    else setSwitching(true);
  }

  return (
    <>
      {canUpgrade ? (
        <Button
          type="button"
          className="ml-2"
          disabled={disabled}
          onClick={() => setUpgrading(true)}
        >
          Upgrade to Business
        </Button>
      ) : null}
      {canDowngrade ? (
        <Button
          type="button"
          className="ml-2"
          disabled={disabled}
          onClick={() => moveToStarter("downgrade")}
        >
          Move to Starter
        </Button>
      ) : null}
      {trialSwitchTo ? (
        <Button
          type="button"
          className="ml-2"
          disabled={disabled}
          onClick={() =>
            trialSwitchTo === "starter"
              ? moveToStarter("switch")
              : setSwitching(true)
          }
        >
          Switch to {PLAN_LABELS[trialSwitchTo]}
        </Button>
      ) : null}
      {movesOn ? (
        <Button
          type="button"
          className="ml-2"
          disabled={disabled}
          aria-busy={keepBusiness.isPending || undefined}
          onClick={async () => {
            try {
              await keepBusiness.mutateAsync();
              toast.done(
                "This Organization stays on Business. Nothing was charged.",
              );
            } catch (error) {
              toast.error(error);
            }
          }}
        >
          Keep Business
        </Button>
      ) : null}
      {canUpgrade ? (
        <UpgradeConfirm open={upgrading} onOpenChange={setUpgrading} />
      ) : null}
      {canDowngrade ? (
        <DowngradeConfirm open={downgrading} onOpenChange={setDowngrading} />
      ) : null}
      {checklist ? (
        <StarterChecklist
          open
          onOpenChange={(open) => {
            if (!open) setChecklist(null);
          }}
          move={
            checklist === "downgrade" ? "Move to Starter" : "Switch to Starter"
          }
          onCleared={() => {
            setChecklist(null);
            if (checklist === "downgrade") setDowngrading(true);
            else setSwitching(true);
          }}
        />
      ) : null}
      {trialSwitchTo && trialEndsAt ? (
        <TrialSwitchConfirm
          to={trialSwitchTo}
          endsAt={trialEndsAt}
          open={switching}
          onOpenChange={setSwitching}
        />
      ) : null}
    </>
  );
}
