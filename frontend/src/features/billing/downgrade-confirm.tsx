import type { ReactNode } from "react";

import { DowngradeImpactList } from "@/components/console/downgrade-impact";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { formatDay } from "@/lib/api/endpoints/billing";
import { useDowngrade, useDowngradeImpact } from "@/lib/api/use-billing";

/**
 * The confirm before Business → Starter (ADR-0054). Nothing is
 * charged and nothing changes now: the Organization keeps Business to the end
 * of the month it has paid for, then moves to Starter with the same Add-ons.
 *
 * It lists what stops, **against what this Organization uses**
 * (`GET /billing/downgrade-impact`, `DowngradeImpactList`), with the counts
 * and the names: a paid feature it never set up is left out, so an
 * Organization on Business for the Servers alone reads that nothing else
 * changes. One red "Downgrade on <date>" button, with no typed confirm: the
 * move can be taken back with "Keep Business" until the date, and back on
 * Business everything works again.
 */
export function DowngradeConfirm({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title="Move to Starter?"
        description="Business stays until the end of the month you have paid for, then the plan moves to Starter with the same Servers, Cloud Environments and Add-ons. Nothing is charged now."
      />
      {open ? (
        <DowngradeConfirmBody onDone={() => onOpenChange(false)} />
      ) : null}
    </Modal>
  );
}

function DowngradeConfirmBody({ onDone }: { onDone: () => void }) {
  const impact = useDowngradeImpact(true);
  const downgrade = useDowngrade();

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

  const day = impact.data.downgradeAt
    ? formatDay(impact.data.downgradeAt)
    : null;

  return (
    <>
      <Modal.Body>
        <DowngradeImpactList
          impact={impact.data}
          lead={day ? `From ${day}, on Starter:` : "On Starter:"}
        />
      </Modal.Body>
      <Footer>
        <Button
          type="button"
          variant="dngr"
          disabled={downgrade.isPending}
          aria-busy={downgrade.isPending || undefined}
          onClick={async () => {
            try {
              const move = await downgrade.mutateAsync();
              toast.done(
                `This Organization moves to Starter on ${formatDay(move.scheduledAt)}.`,
              );
              onDone();
            } catch (error) {
              toast.error(error);
            }
          }}
        >
          {day ? `Downgrade on ${day}` : "Downgrade"}
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
