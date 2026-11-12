import type { ReactNode } from "react";

import { DowngradeImpactList } from "@/components/console/downgrade-impact";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import {
  formatDay,
  PLAN_LABELS,
  type BillingPlan,
} from "@/lib/api/endpoints/billing";
import { useDowngradeImpact, useTrialSwitch } from "@/lib/api/use-billing";

/**
 * The confirm before switching plans during a free trial (ADR-0054).
 * Both ways it takes effect at once and charges nothing — "0 USD, still
 * free" — and the trial still ends on the same day; the first bill is for the
 * plan held then. Never a wait for the month's end: a trial has no paid month.
 *
 * To Starter, the paid features stop now, so the confirm lists what stops
 * against what this Organization uses, as the paid month's downgrade does
 * (`DowngradeImpactList`, story 31), and offers the switch once that
 * list has been read.
 *
 * Shared by the Billing page's picker and the paid-feature pages'
 * "Upgrade to Business" during a trial, so it reads what it needs
 * itself: the caller passes the plan to switch to and the trial's end.
 */
export function TrialSwitchConfirm({
  to,
  endsAt,
  open,
  onOpenChange,
}: {
  to: BillingPlan;
  endsAt: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const label = PLAN_LABELS[to];
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Switch to ${label}?`}
        description={
          to === "business"
            ? "Business adds SSO sign-in, SCIM, custom roles and forward auth. It starts now, with the same Servers, Cloud Environments and Add-ons."
            : "Starter starts now, with the same Servers, Cloud Environments and Add-ons."
        }
      />
      {open ? (
        to === "starter" ? (
          <ToStarterBody endsAt={endsAt} onDone={() => onOpenChange(false)} />
        ) : (
          <SwitchBody
            to={to}
            endsAt={endsAt}
            onDone={() => onOpenChange(false)}
          />
        )
      ) : null}
    </Modal>
  );
}

/** To Starter: what stops first, then the free switch. */
function ToStarterBody({
  endsAt,
  onDone,
}: {
  endsAt: string;
  onDone: () => void;
}) {
  const impact = useDowngradeImpact(true);

  if (impact.isPending) {
    return (
      <>
        <Modal.Body>
          <p className="text-body text-tx-2">
            Reading what this Organization uses…
          </p>
        </Modal.Body>
        <Footer />
      </>
    );
  }

  if (impact.error) {
    return (
      <>
        <Modal.Body>
          <p role="alert" className="text-body text-tx">
            {errorMessage(impact.error)}
          </p>
        </Modal.Body>
        <Footer />
      </>
    );
  }

  return (
    <SwitchBody to="starter" endsAt={endsAt} onDone={onDone}>
      <DowngradeImpactList impact={impact.data} lead="From now, on Starter:" />
    </SwitchBody>
  );
}

function SwitchBody({
  to,
  endsAt,
  onDone,
  children,
}: {
  to: BillingPlan;
  endsAt: string;
  onDone: () => void;
  /** What the switch stops, listed above the price. */
  children?: ReactNode;
}) {
  const change = useTrialSwitch();
  const label = PLAN_LABELS[to];
  const ends = formatDay(endsAt);

  return (
    <>
      <Modal.Body>
        {children}
        <p
          aria-label="Today"
          className="flex flex-wrap items-baseline justify-between gap-2 text-ui text-tx"
        >
          <span>Today</span>
          <strong className="num font-semibold">0 USD, still free</strong>
        </p>
        <p className="text-meta text-tx-2">
          The free trial still ends on {ends}. The first charge, on that day, is
          for the plan and Add-ons held then.
        </p>
      </Modal.Body>
      <Footer>
        <Button
          type="button"
          variant="pri"
          disabled={change.isPending}
          aria-busy={change.isPending || undefined}
          onClick={async () => {
            try {
              await change.mutateAsync(to);
              toast.done(
                `This Organization is on ${label}. Nothing was charged; the trial still ends on ${ends}.`,
              );
              onDone();
            } catch (error) {
              toast.error(error);
            }
          }}
        >
          Switch to {label}
        </Button>
      </Footer>
    </>
  );
}

function Footer({ children }: { children?: ReactNode }) {
  return (
    <Modal.Footer>
      <Modal.Gap />
      <Modal.Close render={<Button type="button">Cancel</Button>} />
      {children}
    </Modal.Footer>
  );
}
