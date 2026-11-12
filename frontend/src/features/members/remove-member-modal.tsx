import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { MemberWithUser } from "@/lib/api/endpoints/organizations";
import { personName } from "@/lib/format/person";

import { useRemoveMember } from "./use-members";

/**
 * Take somebody out of this Organization.
 *
 * No typed confirmation, and the reason is that **nothing is destroyed**: the
 * membership row goes, the account does not, and re-inviting them restores
 * exactly what they had. `delete-resource-modal.tsx`'s rule — a typed name for a
 * reversible action is how people learn to type names without reading them.
 *
 * What the dialog does say is the part that is not obvious from "remove": their
 * **sessions are not ended**. better-auth's `removeMember` deletes the `member`
 * row and touches nothing in `session`, so a browser holding a session whose
 * `activeOrganizationId` is this one keeps that cookie until it expires — and
 * every request it makes then fails the permission check with a 403, because
 * `findMember` finds nothing. That is the correct outcome and it is not
 * *immediate* in the way people assume "remove" is, so it is stated rather than
 * discovered.
 */
export function RemoveMemberModal({
  member,
  open,
  onOpenChange,
}: {
  member: MemberWithUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useRemoveMember();
  const [refusal, setRefusal] = useState<string | null>(null);

  const name = personName(member.user);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Remove ${name}?`}
        description="Their account stays; their membership of this Organization goes."
      />
      <Modal.Body>
        <p className="text-body wrap-anywhere text-tx-2">
          <strong className="font-medium text-tx">{member.user.email}</strong>{" "}
          loses access to every Project, Environment and Server in this
          Organization. Anything they created stays exactly where it is — a
          Deployment does not record who ran it, and nothing is reassigned.
        </p>
        <p className="mt-2.5 text-body text-tx-2">
          A session they already have open is not signed out. It stops being
          allowed to do anything here on its next request, which is not quite the
          same thing.
        </p>
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Keep them</Button>} />
        <Button
          type="button"
          variant="dngr"
          disabled={remove.isPending}
          aria-busy={remove.isPending || undefined}
          onClick={async () => {
            setRefusal(null);
            try {
              await remove.mutateAsync(member.id);
              toast.done(`${name} is no longer a member.`);
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            }
          }}
        >
          Remove member
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
