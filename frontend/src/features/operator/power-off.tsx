import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Chip } from "@/components/console/chip";
import type { Column } from "@/components/console/data-table";
import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { OperatorBoughtServer } from "@/lib/api/endpoints/operator";
import { errorMessage } from "@/lib/api/error-message";

import { usePowerOff, usePowerOn } from "./use-operator-abuse";

/** Which power action the Operator opened, on which Bought Server. */
export type Powering = {
  kind: "off" | "on";
  server: OperatorBoughtServer;
};

/** The stages in which a Bought Server has a running machine to power off. */
const POWERED_STAGES = new Set(["setting_up", "ready"]);

/**
 * The Bought Servers table's **Power** column (#1401): "Powered off" with
 * the reason and *Power on* for one an Operator powered off, else *Power
 * off* while it has a running machine. Nothing here reaches inside the
 * machine (ADR-0050): these are the provider's own power buttons.
 */
export function powerColumn(
  open: (powering: Powering) => void,
): Column<OperatorBoughtServer> {
  return {
    id: "power",
    head: "Power",
    cell: (row) =>
      row.poweredOff ? (
        <span
          className="inline-flex items-center gap-1.5"
          title={row.poweredOff.reason}
        >
          <Chip variant="warn">Powered off</Chip>
          <Button
            type="button"
            size="xs"
            onClick={() => open({ kind: "on", server: row })}
          >
            Power on
          </Button>
        </span>
      ) : POWERED_STAGES.has(row.stage) && row.providerServerId !== null ? (
        <Button
          type="button"
          size="xs"
          variant="dngr"
          onClick={() => open({ kind: "off", server: row })}
        >
          Power off
        </Button>
      ) : (
        "—"
      ),
  };
}

/** The opened power modal, or nothing. */
export function PowerModal({
  powering,
  onClose,
}: {
  powering: Powering | null;
  onClose: () => void;
}) {
  if (!powering) return null;
  const onOpenChange = (open: boolean) => !open && onClose();
  return powering.kind === "off" ? (
    <PowerOffModal server={powering.server} onOpenChange={onOpenChange} />
  ) : (
    <PowerOnModal server={powering.server} onOpenChange={onOpenChange} />
  );
}

/** The backend's own bounds on a reason (`powerOffBoughtServerSchema`). */
const powerOffSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Give the reason the customer will see")
    .max(500, "A reason is at most 500 characters"),
});
type PowerOffValues = z.infer<typeof powerOffSchema>;

/**
 * Power a Bought Server off at once, for an attack still going on. The
 * reason is required: the customer's Server shows "Powered off by
 * Cloudgate: <reason>". Recorded in both audit logs.
 */
function PowerOffModal({
  server,
  onOpenChange,
}: {
  server: OperatorBoughtServer;
  onOpenChange: (open: boolean) => void;
}) {
  const powerOff = usePowerOff();
  const form = useApiForm<PowerOffValues>({
    schema: powerOffSchema,
    defaultValues: { reason: "" },
    labelOf: (name) => (name === "reason" ? "Reason" : undefined),
    onSubmit: async ({ reason }) => {
      await powerOff.mutateAsync({
        boughtServerId: server.id,
        reason: reason.trim(),
      });
      toast.done(`Powered off ${server.name}.`);
      onOpenChange(false);
    },
  });

  return (
    <Modal open onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Power off ${server.name} of ${server.organization.name}?`}
        description="The machine stops at once, as if unplugged. Only an Operator can power it back on; the customer cannot."
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <Field
              name="reason"
              label="Reason"
              hint="Shown on the customer's Server as “Powered off by Cloudgate: …”."
            >
              <Textarea rows={3} />
            </Field>
            <FormError message={form.rootError} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton variant="dngr" pending={form.formState.isSubmitting}>
              Power off
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}

function PowerOnModal({
  server,
  onOpenChange,
}: {
  server: OperatorBoughtServer;
  onOpenChange: (open: boolean) => void;
}) {
  const powerOn = usePowerOn();
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <Modal open onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Power ${server.name} back on?`}
        description="The machine starts again and the notice on the customer's Server goes."
      />
      <Modal.Body>
        {server.poweredOff ? (
          <p className="text-body text-tx-2">
            Powered off for: {server.poweredOff.reason}
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
          disabled={powerOn.isPending}
          aria-busy={powerOn.isPending || undefined}
          onClick={async () => {
            setRefusal(null);
            try {
              await powerOn.mutateAsync(server.id);
              toast.done(`Powered ${server.name} back on.`);
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            }
          }}
        >
          Power on
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
