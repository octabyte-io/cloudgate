import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Agent } from "@/lib/api/endpoints/agents";
import { errorMessage } from "@/lib/api/error-message";

import { useSuspendAgent } from "./use-agents";

/**
 * Suspend an Agent: stop it now, keep everything.
 *
 * A confirmation, because it interrupts a client that may be mid-task — its
 * next call is refused as suspended. What the dialog promises is the other
 * half: keys, role and access all stay, so Resume puts it back exactly as it
 * was and nothing has to be reconfigured. Resume itself needs no dialog; it
 * only gives back what was there.
 */
export function SuspendAgentModal({
  agent,
  open,
  onOpenChange,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const suspend = useSuspendAgent();
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Suspend ${agent.name}?`}
        description="Its next call through the MCP endpoint is refused, and every one after it until you resume it."
      />
      <Modal.Body>
        <p className="text-body text-tx-2">
          Its keys, role and access stay as they are, so Resume puts it back
          without a new key or any change in its client. Anything it already
          started keeps running.
        </p>
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Keep it running</Button>} />
        <Button
          type="button"
          variant="dngr"
          disabled={suspend.isPending}
          aria-busy={suspend.isPending || undefined}
          onClick={async () => {
            setRefusal(null);
            try {
              await suspend.mutateAsync({ agentId: agent.id, suspended: true });
              toast.done(`Suspended ${agent.name}.`);
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            }
          }}
        >
          Suspend Agent
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
