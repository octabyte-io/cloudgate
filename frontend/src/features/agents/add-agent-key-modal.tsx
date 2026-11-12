import { useState } from "react";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Picker } from "@/components/console/picker";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_AGENT_KEY_EXPIRY_DAYS,
  type Agent,
  type AgentKeyExpiryDays,
  type CreatedAgent,
} from "@/lib/api/endpoints/agents";
import { errorMessage } from "@/lib/api/error-message";

import { AgentKeyReveal } from "./agent-key-reveal";
import { EXPIRY_OPTIONS } from "./create-agent-modal";
import { useAddAgentKey } from "./use-agents";

/**
 * Add key: choose how long it lives, then read it once.
 *
 * The same three lifetimes as the first key and the same default, and the
 * same reveal — `AgentKeyReveal`, with its `connect` slot, because a new key
 * is as useless as the first until it is pasted into a client. `keepOpen`
 * stops a backdrop click from costing the key, as in the create dialog.
 *
 * Adding a key stops nothing: the old keys keep working until they are
 * revoked, which is what makes Add key then Revoke a rotation rather than an
 * outage.
 */
export function AddAgentKeyModal({
  agent,
  open,
  onOpenChange,
  connect,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The client-configuration panel, handed the Agent and its new key. */
  connect?: (added: CreatedAgent) => React.ReactNode;
}) {
  const add = useAddAgentKey();
  const [expiry, setExpiry] = useState<AgentKeyExpiryDays>(
    DEFAULT_AGENT_KEY_EXPIRY_DAYS,
  );
  const [added, setAdded] = useState<CreatedAgent | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (add.isPending) return;
    setRefusal(null);
    try {
      setAdded(
        await add.mutateAsync({ agentId: agent.id, expiresInDays: expiry }),
      );
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} keepOpen={added !== null}>
      <Modal.Header
        title={added ? `${agent.name}’s new key` : `Add a key to ${agent.name}`}
        description={
          added
            ? "This is the only time it is readable."
            : "Its other keys keep working. Revoke the old one once the client uses this one."
        }
      />

      {added ? (
        <>
          <Modal.Body>
            <AgentKeyReveal
              agentName={agent.name}
              role={agent.role}
              value={added.key}
              connect={connect?.(added)}
            />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Button
              type="button"
              variant="pri"
              onClick={() => onOpenChange(false)}
            >
              I have copied it
            </Button>
          </Modal.Footer>
        </>
      ) : (
        <form method="post" noValidate onSubmit={submit}>
          <Modal.Body>
            <Field
              name="expiry"
              label="Expires"
              hint="Every Agent key expires. Add the next one before this one lapses."
              manual
            >
              <Picker
                value={String(expiry)}
                onValueChange={(value) =>
                  setExpiry(Number(value) as AgentKeyExpiryDays)
                }
                options={EXPIRY_OPTIONS}
              />
            </Field>
            <FormError message={refusal ?? undefined} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <Button
              type="submit"
              variant="pri"
              disabled={add.isPending}
              aria-busy={add.isPending || undefined}
            >
              Add key
            </Button>
          </Modal.Footer>
        </form>
      )}
    </Modal>
  );
}
