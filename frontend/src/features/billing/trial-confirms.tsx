import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import {
  formatDay,
  PLAN_LABELS,
  type BillingPlan,
} from "@/lib/api/endpoints/billing";
import { useCancelTrial } from "@/lib/api/use-billing";

/**
 * The confirm before "Cancel trial": the plan is held to the trial's
 * last day, then there is no plan and nothing is charged. "Keep <plan>" takes
 * it back until then.
 */
export function CancelTrialConfirm({
  plan,
  endsAt,
  open,
  onOpenChange,
}: {
  plan: BillingPlan;
  endsAt: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const cancel = useCancelTrial();
  const ends = formatDay(endsAt);
  const label = PLAN_LABELS[plan];

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title="Cancel the free trial?"
        description={`${label} stays until ${ends}. Then: No plan. Nothing is charged.`}
      />
      <Modal.Body>
        <p className="text-meta text-tx-2">
          Until {ends}, Keep {label} takes it back.
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Back</Button>} />
        <Button
          type="button"
          variant="pri"
          disabled={cancel.isPending}
          aria-busy={cancel.isPending || undefined}
          onClick={async () => {
            try {
              await cancel.mutateAsync();
              toast.done(
                `The trial is cancelled. Nothing is charged; ${label} stays until ${ends}.`,
              );
              onOpenChange(false);
            } catch (error) {
              toast.error(error);
            }
          }}
        >
          Cancel trial
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
