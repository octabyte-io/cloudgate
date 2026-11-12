import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Agent } from "@/lib/api/endpoints/agents";
import type { AgentRole } from "@/lib/api/endpoints/roles";
import { errorMessage } from "@/lib/api/error-message";
import { useUpdateMemberRole } from "@/lib/api/use-member-grants";

import { AGENT_ROLE_CHOICES, AGENT_ROLE_COPY } from "./agent-roles";

/**
 * Change an Agent's role — Reader or Operator, and nothing else.
 *
 * **Not the Members dialog's picker.** `roleOptions` offers Member, Admin and
 * the Organization's custom roles, every one of which the single `member.role`
 * writer refuses for an Agent (`writeMemberRole`). So the choice is the
 * create dialog's two cards, with each role's one line under it, and the
 * write is the Members route's own `PATCH /organizations/members/:id` against
 * the Agent's member row — the one writer, not a second path to it.
 */
export function ChangeAgentRoleModal({
  agent,
  open,
  onOpenChange,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateMemberRole();
  const [role, setRole] = useState<AgentRole>(agent.role);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (update.isPending || role === agent.role) return;
    setRefusal(null);
    try {
      await update.mutateAsync({ memberId: agent.memberId, role });
      toast.done(`${agent.name} is now ${AGENT_ROLE_COPY[role].label}.`);
      onOpenChange(false);
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Change ${agent.name}’s role`}
        description="It takes effect on its next call. Its keys and access stay as they are."
      />
      <form method="post" noValidate onSubmit={submit}>
        <Modal.Body>
          <PickGrid label="Role">
            {AGENT_ROLE_CHOICES.map((choice) => (
              <PickCard
                key={choice}
                title={AGENT_ROLE_COPY[choice].label}
                description={AGENT_ROLE_COPY[choice].choice}
                selected={role === choice}
                onClick={() => setRole(choice)}
              />
            ))}
          </PickGrid>
          <FormError message={refusal ?? undefined} />
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            type="submit"
            variant="pri"
            disabled={role === agent.role || update.isPending}
            aria-busy={update.isPending || undefined}
          >
            Change role
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
