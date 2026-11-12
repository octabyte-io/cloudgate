import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Agent, AgentKey } from "@/lib/api/endpoints/agents";
import { errorMessage } from "@/lib/api/error-message";

import { keyExpiry } from "./agent-facts";
import { useRemoveAgentKey } from "./use-agents";

/**
 * Revoke one of an Agent's keys, or Remove an expired one.
 *
 * One DELETE either way; the words differ because the consequence does. A
 * live key's holder is refused on its next call — "This key is not valid." —
 * so the dialog says which client that will be, as far as the console can
 * tell. An expired key already authenticates nothing, so removing it is only
 * a tidier list.
 */
export function RemoveAgentKeyModal({
  agent,
  agentKey,
  open,
  onOpenChange,
}: {
  agent: Agent;
  agentKey: AgentKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useRemoveAgentKey();
  const [refusal, setRefusal] = useState<string | null>(null);
  const expired = keyExpiry(agentKey) === "expired";
  const named = agentKey.start ? `${agentKey.start}…` : "this key";
  const liveLeft = agent.keys.filter(
    (each) => each.id !== agentKey.id && !each.expired,
  ).length;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={expired ? `Remove ${named}?` : `Revoke ${named}?`}
        description={
          expired
            ? `It expired and can no longer authenticate ${agent.name}.`
            : `Whatever uses it is refused on its next call, as ${agent.name}.`
        }
      />
      <Modal.Body>
        {expired ? null : (
          <p className="text-body text-tx-2">
            {liveLeft === 0
              ? `${agent.name} has no other valid key, so it stops working until you add one.`
              : `${agent.name}’s other keys keep working.`}{" "}
            This cannot be undone.
          </p>
        )}
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
              await remove.mutateAsync({
                agentId: agent.id,
                keyId: agentKey.id,
              });
              toast.done(
                expired ? `Removed ${named}.` : `Revoked ${named}.`,
              );
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            }
          }}
        >
          {expired ? "Remove key" : "Revoke key"}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
