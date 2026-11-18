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
import { FirstSetupRun } from "./first-setup-run";
import { useSecondsWaited } from "./use-get-started";
import { BUY_STAGES, buyStageStates } from "./wizard-model";
import { StepNote } from "./wizard-parts";
import { wizardHref } from "./wizard-state";

/**
 * The strip's first line, a sentence about the Server at each stage. The
 * segmented bar under it keeps #111's stage labels (Payment, Creating your
 * server, Setting it up, Ready to use); this line says the same in words
 * that read after the Server's name.
 */
const DOING: Partial<Record<BoughtServerStage, string>> = {
  waiting_for_payment: "is waiting for your payment",
  creating: "is being created",
  setting_up: "is being set up",
  ready: "is ready to use",
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
  paid = false,
}: {
  template: TemplateSummary;
  id: string;
  name: string;
  stage: BoughtServerStage;
  /** Back from a cancelled Checkout, with the payment still to finish. */
  leftPayment?: boolean;
  /** Back from a paid Checkout, with Stripe's word on it still to come. */
  paid?: boolean;
}) {
  // Only the four stages a buyer follows; a later one (Changing) is the
  // Server's own page's to show.
  // Back from a paid Checkout the payment is made, only not confirmed yet.
  const doing =
    paid && stage === "waiting_for_payment"
      ? "is waiting for Stripe to confirm your payment"
      : DOING[stage];
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
            {`${name} ${doing}`}
          </p>
          {ready ? null : (
            <p className="text-meta text-tx-3">
              Step {now + 1} of {steps.length} · usually a few minutes
            </p>
          )}
        </div>
        <SegmentedProgress label="Your server" steps={steps} />
        {stage === "creating" ? (
          <p className="text-meta text-tx-2">
            A new machine is being started for you. This usually takes a minute
            or two.
          </p>
        ) : null}
        {stage === "setting_up" ? (
          <div className="grid gap-2 rounded-md border border-line bg-panel-2 p-3">
            <FirstSetupRun serverId={id} name={name} />
          </div>
        ) : null}
        {ready ? null : (
          <p className="text-meta wrap-anywhere text-tx-2">
            {`${template.name} starts on its own once the server is ready, so you can leave after Deploy.`}
          </p>
        )}
        {stage === "waiting_for_payment" ? (
          paid ? (
            <ConfirmingPayment template={template} id={id} />
          ) : (
            <FinishPaying
              template={template}
              id={id}
              note={
                leftPayment ? (
                  <StepNote tone="info">
                    You left the payment page before paying: finish paying to
                    get the server, or cancel it and nothing is charged.
                  </StepNote>
                ) : null
              }
            />
          )
        ) : null}
      </Card.Body>
    </Card>
  );
}

/** How long a payment made is waited for before the way to pay again shows. */
const CONFIRM_PATIENCE_S = 45;

/**
 * Back from a paid Checkout, the purchase waits for Stripe's word, which
 * comes a few seconds after the browser does. Until then the strip says the
 * payment is being confirmed rather than offering to pay a second time;
 * a wait that runs long offers it after all, since a bank's check can
 * still have stopped the payment.
 */
function ConfirmingPayment({
  template,
  id,
}: {
  template: TemplateSummary;
  id: string;
}) {
  const waited = useSecondsWaited();
  if (waited >= CONFIRM_PATIENCE_S) {
    return (
      <FinishPaying
        template={template}
        id={id}
        note={
          <StepNote tone="warn">
            Stripe hasn&rsquo;t confirmed your payment yet. If you were asked to
            approve it with your bank and didn&rsquo;t, finish paying below;
            otherwise give it a minute more.
          </StepNote>
        }
      />
    );
  }
  return (
    <p
      role="status"
      className="flex items-center gap-2 border-t border-line pt-3 text-ui text-tx-2"
    >
      <span
        aria-hidden="true"
        className="size-2 flex-none rounded-pill bg-warn motion-safe:animate-pulse"
      />
      Payment made. Confirming it with Stripe, which usually takes a few
      seconds.
    </p>
  );
}

/**
 * A purchase whose payment is not finished: back to the payment page, or
 * cancel it, which charges nothing and goes back to choosing one.
 */
function FinishPaying({
  template,
  id,
  note,
}: {
  template: TemplateSummary;
  id: string;
  /** Why paying is offered: the payment page was left, or a payment is slow to confirm. */
  note?: React.ReactNode;
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
      {note}
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
