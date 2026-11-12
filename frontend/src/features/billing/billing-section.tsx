"use client";

import { Card } from "@/components/console/card";
import { useAttachedPlan, useSubscription } from "@/lib/api/use-billing";
import { useInstanceMode } from "@/lib/api/use-instance-mode";
import { Icon } from "@/lib/design/icons";
import { useArrival } from "@/components/console/use-arrival";
import { cn } from "@/lib/utils";

import { SectionFailed, SectionPending } from "../settings/section-states";
import { AttachedPlanCard } from "./attached-plan-card";
import { InvoicesCard } from "./invoices-card";
import { OrganizationsOnPlanCard } from "./organizations-on-plan-card";
import { PlanCard } from "./plan-card";
import { PlansCard } from "./plans-card";

/**
 * Billing: the plan, the allowance it buys, the catalogue, and the invoices.
 *
 * ## Not behind `LicenseGate`, and the difference is worth being clear about
 *
 * The Enterprise sections are gated by a **licence**, which an Organization can
 * buy. This one is gated by whether the *instance* is the Hosted instance,
 * which nobody can change from a screen. So a `LicenseGate` here would say the
 * wrong thing twice: it would name a licence that has nothing to do with
 * billing, and it would offer a way to get one.
 *
 * ## A self-hosted instance says so, once, and asks Stripe nothing
 *
 * The instance mode comes off the public `GET /settings/about`
 * (ADR-0049); `GET /billing/subscription` no longer carries `isCloud`.
 * Self-hosted, the page used to render all three cards anyway: a plan of None, an allowance
 * of None (Servers are not metered there, so "None allowed" was false), a
 * catalogue read that failed with "could not read the plan catalogue" and a
 * console error on every visit, and an invoice-email switch whose only answer
 * was a 400. Now the one sentence that is true replaces all of it, and the
 * catalogue and invoices are never requested.
 *
 * ## An Attached Organization's page is every member's
 *
 * Who pays for an Attached Organization, its own use and the room left are
 * what any of its members needs to know (stories 23–25), so the page asks
 * `GET /billing/attached-plan` — any member's read — first, and draws
 * `AttachedPlanCard` from it whatever the reader's role. The owner's and
 * admin's `GET /billing/subscription` is then asked only by someone it can
 * answer something for: on an Organization that pays for itself, and on an
 * Attached one only for its own owner, whose "Pay for it yourself" opens the
 * plans it feeds. A plain member of an Attached Organization never asks it.
 *
 * ## Otherwise owner or admin, and a member is told rather than shown an empty page
 *
 * `assertAdmin` guards everything except `getCurrentPlan`, `serverRoom`,
 * `getStanding` and `attachedPlan`. A member of an Organization that pays for
 * itself therefore gets a 403 here — and still gets the one thing they need,
 * because `can-create-server` is read where a Server is created rather than on
 * this page.
 */
export function BillingSection() {
  const mode = useInstanceMode();
  // Asked while the mode is still in flight, as the subscription always was;
  // only a known Self-hosted instance asks nothing.
  const billed = mode.data !== "self-hosted";
  const attachedPlan = useAttachedPlan({ enabled: billed });
  const paidBy = attachedPlan.data?.paidBy ?? null;
  // Settled either way: a failed member read falls back to the admin's one,
  // which answers for itself.
  const settled = attachedPlan.isSuccess || attachedPlan.isError;
  const subscription = useSubscription({
    enabled:
      billed && settled && (paidBy === null || paidBy.payForItYourself !== null),
  });

  const arrival = useArrival(
    mode.isPending || !settled || subscription.isPending,
  );

  if (mode.data === "self-hosted") return <NotBilledHere />;

  if (mode.isPending || !settled) {
    return <SectionPending title="Current plan" rows={4} />;
  }

  // An Attached Organization's plan is its Paying Organization's: who pays,
  // its own use and the room left, and nothing to buy here (ADR-0059). No
  // "Organizations on this plan" card either: the plan is not its own, and a
  // card by that name here would read as the payer's other customers. Its own
  // owner may open the plans to pay for it themselves; its own row
  // holds no plan, so the catalogue offers Checkout, never a trial.
  if (paidBy && attachedPlan.data?.usage) {
    return (
      <AttachedPlanCard
        paidBy={paidBy}
        usage={attachedPlan.data.usage}
        catalogue={
          subscription.data ? (
            <PlansCard subscription={subscription.data} />
          ) : null
        }
      />
    );
  }

  if (subscription.isPending) {
    return <SectionPending title="Current plan" rows={4} />;
  }

  if (subscription.error) {
    return (
      <SectionFailed title="Current plan" error={subscription.error}>
        Reading billing needs an owner or admin role in this Organization.
        Whether you can add another Server is checked where you add one, not
        here, so that still works.
      </SectionFailed>
    );
  }

  if (mode.error) {
    return (
      <SectionFailed title="Current plan" error={mode.error}>
        Whether this instance sells plans at all could not be read.
      </SectionFailed>
    );
  }

  return (
    <div className={cn("grid gap-5.5", arrival)}>
      <PlanCard subscription={subscription.data} />
      {/* Enterprise is billed by agreement: no plan to choose. */}
      {subscription.data.allowance.plan === "enterprise" ? null : (
        <PlansCard subscription={subscription.data} />
      )}
      <OrganizationsOnPlanCard />
      <InvoicesCard subscription={subscription.data} />
    </div>
  );
}

/** The whole Billing page on a self-hosted instance. */
function NotBilledHere() {
  return (
    <Card>
      <Card.Header title="Billing" headingLevel={2} />
      <Card.Body>
        <div className="flex gap-3">
          <span className="mt-0.5 flex size-7 flex-none items-center justify-center rounded-md border border-info-line bg-info-tint text-info">
            <Icon name="info" size={15} />
          </span>
          <div className="min-w-0">
            <p className="text-body text-tx">
              Billing is not used on this instance.
            </p>
            <p className="mt-1.5 text-meta text-tx-2">
              It is self-hosted: there are no plans to choose, Servers are not
              metered, and no invoices are issued or emailed. Subscriptions exist
              only on the Hosted instance.
            </p>
          </div>
        </div>
      </Card.Body>
    </Card>
  );
}
