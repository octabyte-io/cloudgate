import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { OperatorOrganization } from "@/lib/api/endpoints/operator";
import { errorMessage } from "@/lib/api/error-message";

import { useLiftSuspension, useSuspendOrganization } from "./use-operator";

type ModalProps = {
  organization: OperatorOrganization;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** The backend's own bounds on a reason (`suspendOrganizationSchema`). */
const suspendSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Give the reason the customer will see")
    .max(500, "A reason is at most 500 characters"),
});
type SuspendValues = z.infer<typeof suspendSchema>;

/**
 * Suspend an Organization (ADR-0050): a reason is required, because
 * its members see it on the frozen banner and its owners get it by email.
 * What runs on their Servers and clouds keeps running; Cloudgate starts
 * nothing new for them until an Operator lifts it — a payment never does.
 *
 * Suspension stays on one Organization (ADR-0059): a Paying Organization's
 * Attached Organizations keep running, and the box says how many.
 */
export function SuspendOrganizationModal({
  organization,
  open,
  onOpenChange,
}: ModalProps) {
  const suspend = useSuspendOrganization();
  const form = useApiForm<SuspendValues>({
    schema: suspendSchema,
    defaultValues: { reason: "" },
    labelOf: (name) => (name === "reason" ? "Reason" : undefined),
    onSubmit: async ({ reason }) => {
      await suspend.mutateAsync({
        organizationId: organization.id,
        reason: reason.trim(),
      });
      toast.done(`Suspended ${organization.name}.`);
      onOpenChange(false);
    },
  });

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Suspend ${organization.name}?`}
        description="It is frozen with “Suspended. Contact Octabyte” until an Operator lifts it. A payment does not lift it."
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            {organization.attached.length > 0 ? (
              <p className="text-body text-tx-2">
                {attachedNotSuspended(organization.attached.length)}
              </p>
            ) : null}
            <Field
              name="reason"
              label="Reason"
              hint="Shown to its members and emailed to its owners."
            >
              <Textarea rows={3} />
            </Field>
            <FormError message={form.rootError} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton variant="dngr" pending={form.formState.isSubmitting}>
              Suspend Organization
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}

/** "Its N Attached Organizations are not suspended." */
function attachedNotSuspended(count: number): string {
  return count === 1
    ? "Its 1 Attached Organization is not suspended."
    : `Its ${count} Attached Organizations are not suspended.`;
}

/**
 * Lift a suspension. Only that cause clears: an Organization whose
 * plan has also lapsed stays frozen until it pays, and is warned again at
 * least 7 days before it is deleted.
 */
export function LiftSuspensionModal({
  organization,
  open,
  onOpenChange,
}: ModalProps) {
  const lift = useLiftSuspension();
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Lift the suspension of ${organization.name}?`}
        description="Its owners are emailed. If its plan has lapsed it stays frozen until it pays."
      />
      <Modal.Body>
        {organization.suspension ? (
          <p className="text-body text-tx-2">
            Suspended for: {organization.suspension.reason}
          </p>
        ) : null}
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Cancel</Button>} />
        <Button
          type="button"
          variant="pri"
          disabled={lift.isPending}
          aria-busy={lift.isPending || undefined}
          onClick={async () => {
            setRefusal(null);
            try {
              await lift.mutateAsync(organization.id);
              toast.done(`Lifted the suspension of ${organization.name}.`);
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            }
          }}
        >
          Lift suspension
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
