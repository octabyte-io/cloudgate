import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Agent } from "@/lib/api/endpoints/agents";
import { errorMessage } from "@/lib/api/error-message";
import { counted } from "@/lib/format/plural";

import { useDeleteAgent } from "./use-agents";

/**
 * Delete an Agent: its user, its member row and every key, for good.
 *
 * A plain confirmation rather than a typed one — the loss is bounded and
 * stated: nothing it deployed goes with it, and its audit rows stay. What the
 * dialog does say is the two things "delete" leaves unclear: every key stops
 * working at once, and there is no undo short of creating a new Agent and
 * reconfiguring its client.
 */
export function DeleteAgentModal({
  agent,
  open,
  onOpenChange,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteAgent();
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Delete ${agent.name}?`}
        description="The Agent, its access and all its keys go. Its audit trail stays."
      />
      <Modal.Body>
        <p className="text-body text-tx-2">
          {agent.keys.length === 0
            ? "It has no keys."
            : `${counted(agent.keys.length, "key stops", "keys stop")} working on the next call.`}{" "}
          Anything it deployed stays where it is. This cannot be undone: a new
          Agent needs a new key in its client.
        </p>
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Keep it</Button>} />
        <Button
          type="button"
          variant="dngr"
          disabled={remove.isPending}
          aria-busy={remove.isPending || undefined}
          onClick={async () => {
            setRefusal(null);
            try {
              await remove.mutateAsync(agent.id);
              toast.done(`Deleted ${agent.name}.`);
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            }
          }}
        >
          Delete Agent
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
