import Link from "next/link";

import { Card } from "@/components/console/card";
import { Skeleton } from "@/components/console/skeleton";
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
import { OwnConnect } from "./own-connect";
import { OwnServerForm } from "./own-server-form";
import { useWizardServerRoom } from "./use-get-started";
import { AskAdmin, StepNote } from "./wizard-parts";
import { wizardHref, type WizardState } from "./wizard-state";

/**
 * The own-server path: a plan first where the Hosted instance needs one
 * (ADR-0054: no plan allows no Server), then the Server's address and key,
 * then its setup, started by the person's "Connect my server" (ADR-0058).
 */
export function OwnFlow({
  template,
  state,
}: {
  template: TemplateSummary;
  state: WizardState;
}) {
  const canAdd = usePermission({ server: ["create"] });
  const room = useWizardServerRoom(state.checkout === "success");

  if (!canAdd.allowed) {
    return (
      <Card>
        <Card.Body>
          <AskAdmin>
            Only an owner or an admin can add a server to this organization.
            Once there is one, come back to this page to deploy {template.name}.
          </AskAdmin>
        </Card.Body>
      </Card>
    );
  }

  if (state.serverId) {
    return <OwnConnect template={template} serverId={state.serverId} />;
  }

  if (room.isPending) {
    return (
      <Card aria-busy="true">
        <Card.Body className="grid gap-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-40" />
        </Card.Body>
      </Card>
    );
  }

  // A failed read is not a refusal: Server create checks the plan itself.
  const code = room.data?.code ?? null;
  if (code === "PLAN_REQUIRED") {
    return <PlanStep template={template} checkout={state.checkout} />;
  }
  if (code === "ALLOWANCE_FULL") {
    return (
      <Card>
        <Card.Body className="grid gap-2">
          <p className="text-body text-tx">
            Your plan already has all the servers it allows.
          </p>
          <p className="text-ui text-tx-2">
            An owner or admin can add room for one more on the{" "}
            <Link
              href="/settings/billing"
              className="text-brand-tx underline underline-offset-2"
            >
              Billing page
            </Link>
            , or you can use one of your servers that is already set up.
          </p>
        </Card.Body>
      </Card>
    );
  }

  return <OwnServerForm template={template} />;
}

/**
 * No plan yet: the Free trial, said plainly, and the way to Checkout. Back
 * from a paid Checkout the plan may not be granted yet, so the step says it
 * is confirming and asks again until it is.
 */
function PlanStep({
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

  if (checkout === "success") {
    return (
      <Card aria-busy="true">
        <Card.Body className="grid gap-2">
          <p role="status" className="text-body text-tx">
            Thanks. Confirming your plan with the payment provider&hellip;
          </p>
          <p className="text-ui text-tx-2">
            This takes a few seconds. The next step opens by itself.
          </p>
        </Card.Body>
      </Card>
    );
  }

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
        <p className="text-body text-tx-2">
          {trial
            ? `Starter is free for 30 days, then ${monthly} a month. It includes up to 3 servers. A card is needed to start, and you can cancel any time before the trial ends.`
            : `Starter is ${monthly} a month and includes up to 3 servers. Your organization has already had its free trial, so it starts today.`}
        </p>
        {trial ? <TrialTerms today={new Date()} monthly={monthly} /> : null}
        <div className="grid justify-items-start gap-1.5">
          <SubmitButton
            type="button"
            pending={start.isPending}
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
            <p className="text-meta text-tx-3">
              You&rsquo;ll enter your card on Stripe&rsquo;s secure page, then
              come back here.
            </p>
          )}
        </div>
      </Card.Body>
    </Card>
  );
}
