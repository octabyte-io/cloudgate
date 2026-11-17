import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { Card } from "@/components/console/card";
import { LinkButton } from "@/components/console/link-button";
import { SegmentedProgress } from "@/components/console/segmented-progress";
import { SubmitButton } from "@/components/console/submit-button";
import {
  boughtServersApi,
  type BoughtServerStage,
} from "@/lib/api/endpoints/bought-servers";
import type { TemplateSummary } from "@/lib/api/endpoints/templates";
import { errorMessage } from "@/lib/api/error-message";
import { useInvalidate } from "@/lib/api/use-invalidate";

import { useCancelPurchase } from "../server/buy/use-bought-servers";
import { BUY_STAGES, buyStageStates } from "./wizard-model";
import { StepNote } from "./wizard-parts";
import { wizardHref } from "./wizard-state";

/** What the strip's first line says the Server is doing, after its name. */
const DOING: Partial<Record<BoughtServerStage, string>> = {
  waiting_for_payment: "waiting for your payment",
  creating: "being created",
  setting_up: "setting it up",
  ready: "ready to use",
};

/**
 * A Bought Server's progress, as a strip above step two's details: something
 * happening on its own, not a step to take (spec #106). The app starts by itself once the Server is Ready, because
 * Cloudgate applies the wizard's setup then (ADR-0073); nothing here presses
 * anything for it.
 *
 * Rejected: a progress card with a "Set up <app> now" button under it. It
 * read as a step the person had to take before anything else could happen.
 */
export function ServerProgress({
  template,
  id,
  name,
  stage,
  leftPayment = false,
}: {
  template: TemplateSummary;
  id: string;
  name: string;
  stage: BoughtServerStage;
  /** Back from a cancelled Checkout, with the payment still to finish. */
  leftPayment?: boolean;
}) {
  // Only the four stages a buyer follows; a later one (Changing) is the
  // Server's own page's to show.
  const doing = DOING[stage];
  if (!doing) return null;
  const steps = buyStageStates(stage).map((entry, at) => ({
    id: BUY_STAGES[at].stage,
    ...entry,
  }));
  const now = steps.findIndex((step) => step.state === "now");
  const ready = now === -1;

  return (
    // A live region, so a stage moving on is announced without moving focus.
    <Card aria-label="Your server" aria-live="polite" className="animate-fade">
      <Card.Body className="grid gap-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 text-body font-medium wrap-anywhere text-tx">
            {`${name}: ${doing}`}
          </p>
          {ready ? null : (
            <p className="text-meta text-tx-3">
              Step {now + 1} of {steps.length} · usually a few minutes
            </p>
          )}
        </div>
        <SegmentedProgress label="Your server" steps={steps} />
        {ready ? null : (
          <p className="text-meta wrap-anywhere text-tx-2">
            {template.name} starts on its own once the server is ready. After
            you press Deploy, you can leave this page.
          </p>
        )}
        {stage === "waiting_for_payment" ? (
          <FinishPaying template={template} id={id} left={leftPayment} />
        ) : null}
      </Card.Body>
    </Card>
  );
}

/**
 * A purchase whose payment is not finished: back to the payment page, or
 * cancel it, which charges nothing and goes back to choosing one.
 */
function FinishPaying({
  template,
  id,
  left,
}: {
  template: TemplateSummary;
  id: string;
  /** The person left the payment page before paying (`checkout=cancelled`). */
  left: boolean;
}) {
  const router = useRouter();
  const invalidate = useInvalidate();
  const buyAgain = wizardHref({ templateId: template.id, path: "buy" });
  const finish = useMutation({
    mutationFn: () => boughtServersApi.finishPaying(id, { returnTo: buyAgain }),
    onSettled: () => invalidate.boughtServers(),
    onSuccess: (result) => {
      if (result.payUrl) window.location.href = result.payUrl;
    },
  });
  const cancel = useCancelPurchase();
  const error = finish.error ?? cancel.error;

  return (
    <div className="grid gap-3 border-t border-line pt-3">
      {left ? (
        <StepNote tone="info">
          You left the payment page before paying: finish paying to get the
          server, or cancel it and nothing is charged.
        </StepNote>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {/* `SubmitButton` for its pending state, as `check-inbox` does: the
            label stays and a turning mark says the press was taken. */}
        <SubmitButton
          type="button"
          pending={finish.isPending}
          onClick={() => finish.mutate()}
        >
          Finish paying
        </SubmitButton>
        <SubmitButton
          type="button"
          variant="qt"
          pending={cancel.isPending}
          onClick={() =>
            cancel.mutate(id, { onSuccess: () => router.replace(buyAgain) })
          }
        >
          Cancel this server
        </SubmitButton>
      </div>
      {error ? (
        <p role="alert" className="text-meta text-bad">
          {errorMessage(error)}
        </p>
      ) : null}
    </div>
  );
}

/** A Bought Server that failed to be made or is going: choose another. */
export function ServerGone({
  template,
  stage,
}: {
  template: TemplateSummary;
  stage: BoughtServerStage;
}) {
  return (
    <Card className="animate-fade">
      <Card.Body className="grid justify-items-start gap-3">
        <p className="text-body text-tx">
          {stage === "failed"
            ? "We couldn't create this server, so your payment is being refunded."
            : "This server is being deleted, so it can't be used."}
        </p>
        <LinkButton
          variant="pri"
          href={wizardHref({ templateId: template.id })}
        >
          Choose a server again
        </LinkButton>
      </Card.Body>
    </Card>
  );
}
