import Link from "next/link";

import { Card } from "@/components/console/card";
import { SubmitButton } from "@/components/console/submit-button";
import { formatMoney } from "@/lib/api/endpoints/billing";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { errorMessage } from "@/lib/api/error-message";
import {
  useCheckout,
  useProducts,
  useSubscription,
} from "@/lib/api/use-billing";
import { useInstanceMode } from "@/lib/api/use-instance-mode";
import { usePermission } from "@/lib/auth/use-permission";

import { TrialTerms } from "../billing/trial-terms";
import { useSecondsWaited } from "./use-get-started";
import { AskAdmin, StageList, StepNote } from "./wizard-parts";
import { wizardHref, type WizardState } from "./wizard-state";

/**
 * No plan yet, on the own-server path (ADR-0054: no plan allows no Server):
 * the plan in one box, what it costs today and after, the trial's terms,
 * and the way to Checkout. Back from a paid Checkout the plan may not be
 * granted yet, so the step says it is confirming, shows how long it has
 * waited, and asks again until it is.
 *
 * Rejected: a paragraph of the trial's terms above `TrialTerms`, which said
 * the same dates and the same cancel rule a second time.
 */
export function PlanStep({
  template,
  checkout,
}: {
  template: TemplateSummary;
  checkout: WizardState["checkout"];
}) {
  const hosted = useInstanceMode().data === "hosted";
  const subscription = useSubscription({ enabled: hosted });
  const products = useProducts();
  const start = useCheckout();
  // `BillingService.assertAdmin`: an owner or an admin starts a plan.
  const canPay = usePermission({ organization: ["update"] });
  const starter = products.data?.plans.starter;
  const monthly =
    starter?.unitAmount != null
      ? formatMoney(starter.unitAmount, starter.currency)
      : "$15";
  // Unknown reads as available: Checkout leaves the trial out by itself.
  const trial = subscription.data?.trialAvailable ?? true;
  // The browser is on its way to Stripe once Checkout answers: the button
  // stays busy until the page is gone, so it is not pressed twice.
  const leaving = start.isPending || start.isSuccess;

  if (checkout === "success") return <ConfirmingPlan />;

  return (
    <Card className="animate-fade">
      <Card.Header
        title={trial ? "Start your 30-day free trial" : "Choose a plan"}
        sub={`Cloudgate looks after your server and keeps ${template.name} running. That needs a plan.`}
        headingLevel={2}
      />
      <Card.Body className="grid gap-4">
        {canPay.allowed ? null : (
          <AskAdmin>
            Only an owner or an admin can start a plan for this organization.
          </AskAdmin>
        )}
        {checkout === "cancelled" ? (
          <StepNote tone="info">
            You left the payment page before finishing, so nothing was charged.
          </StepNote>
        ) : null}

        <div className="grid gap-3 rounded-lg border border-line bg-panel-2 p-4">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="grid min-w-0 gap-0.5">
              <p className="text-body font-semibold text-tx">Starter</p>
              <p className="text-ui text-tx-2">
                Up to 3 servers, each one set up and looked after by Cloudgate.
              </p>
            </div>
            <div className="grid justify-items-end gap-0.5 text-right">
              <p className="num text-sect text-tx">
                {trial ? "$0 today" : monthly}
              </p>
              <p className="text-meta text-tx-2">
                {trial ? `then ${monthly} a month` : "a month, from today"}
              </p>
            </div>
          </div>
          {trial ? (
            <TrialTerms today={new Date()} monthly={monthly} />
          ) : (
            <p className="border-t border-line pt-3 text-meta text-tx-2">
              Your organization has already had its free trial, so the plan
              starts today.
            </p>
          )}
        </div>

        <div className="grid justify-items-start gap-1.5">
          <SubmitButton
            type="button"
            pending={leaving}
            disabled={!canPay.allowed}
            onClick={() =>
              start.mutate(
                {
                  plan: "starter",
                  addOns: 0,
                  returnTo: wizardHref({
                    templateId: template.id,
                    path: "own",
                  }),
                },
                {
                  onSuccess: ({ url }) => {
                    window.location.href = url;
                  },
                },
              )
            }
          >
            {trial ? "Start free trial" : "Choose Starter"}
          </SubmitButton>
          {start.error ? (
            <p role="alert" className="text-meta text-bad">
              {errorMessage(start.error)}
            </p>
          ) : (
            <p role="status" className="text-meta text-tx-3">
              {leaving
                ? "Opening Stripe’s secure payment page…"
                : `You’ll enter your card on Stripe’s secure page, then come back here to add your server.`}
            </p>
          )}
        </div>
      </Card.Body>
    </Card>
  );
}

/** How long the plan is waited for before the step says it is taking long. */
const PLAN_PATIENCE_S = 30;

/**
 * Back from a paid Checkout: Stripe's webhook, not the browser's return, is
 * what grants the plan, and it can land a few seconds later. The step
 * follows it as stages, and a wait that runs long says what to do rather
 * than turning on for ever.
 */
function ConfirmingPlan() {
  const waited = useSecondsWaited();
  return (
    <Card aria-busy="true" className="animate-fade">
      <Card.Header
        title="Thanks. Starting your plan"
        sub="The next step opens by itself once your plan is confirmed."
        headingLevel={2}
      />
      <Card.Body className="grid gap-4">
        <StageList
          label="Starting your plan"
          stages={[
            { label: "Checkout finished on Stripe", state: "done" },
            { label: "Confirming your plan", state: "now" },
            { label: "Add your server", state: "todo" },
          ]}
          detail={
            <p className="num text-meta text-tx-2">
              {waited < PLAN_PATIENCE_S
                ? `Usually a few seconds. Waiting ${waited}s.`
                : `Still waiting after ${waited}s.`}
            </p>
          }
        />
        {waited >= PLAN_PATIENCE_S ? (
          <StepNote tone="warn">
            Stripe is taking longer than usual to confirm the plan. You
            don&rsquo;t need to pay again: this page keeps checking. If it
            hasn&rsquo;t moved on in a few minutes, see the{" "}
            <Link
              href="/settings/billing"
              className="text-brand-tx underline underline-offset-2"
            >
              Billing page
            </Link>
            .
          </StepNote>
        ) : null}
      </Card.Body>
    </Card>
  );
}
