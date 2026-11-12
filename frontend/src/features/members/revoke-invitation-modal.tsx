import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { Invitation } from "@/lib/api/endpoints/organizations";

import { useRemoveInvitation } from "./use-members";

/**
 * Withdraw an invitation, having said what that costs.
 *
 * **Revoke used to run from the row's `onClick`, on one press**, and the row it
 * pressed is deleted rather than closed — `OrganizationsService.removeInvitation`
 * deletes the `invitation` row, so the link an operator copied and sent on
 * (which on this instance is the *only* way an invitation travels: nothing sends
 * email, see `InvitationsCard`) stops working the moment the pointer goes down,
 * with nothing to undo it and no route that re-issues the same id.
 *
 * That is the line `remove-member-modal.tsx` and `team-row.tsx` both draw from
 * the other side: a control runs without asking when **nothing is destroyed**
 * and the way back is the control beside it. Neither is true here, so this asks.
 *
 * **A plain confirmation and not a typed name.** `ConfirmDeleteModal` is for the
 * six things whose loss is unbounded — a Project, an Environment, a Server. What
 * is lost here is one invitation, and re-inviting the same address is the button
 * at the top of the same card; asking somebody to type an email address for that
 * is how people learn to type names without reading them, which is
 * `DangerZone`'s argument and the reason the irreversible confirmations still
 * work.
 *
 * **`live` splits the two controls this dialog serves.** A pending row's
 * **Revoke** takes away a link somebody may be holding. An accepted, expired or
 * cancelled row's **Delete** takes away only the record — the link was already
 * refused by `accept-invitation` — so the dialog says that instead rather than
 * warning about a link that stopped working weeks ago.
 *
 * The refusal stays in the dialog rather than becoming a toast, for the reason
 * `DeleteResourceModal` gives: the dialog is where the decision was made and it
 * is still open.
 */
export function RevokeInvitationModal({
  invitation,
  /** The invitation is still open, so its link is still worth something. */
  live,
  open,
  onOpenChange,
}: {
  invitation: Invitation;
  live: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useRemoveInvitation();
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setRefusal(null);
        onOpenChange(next);
      }}
    >
      <Modal.Header
        title={
          live
            ? `Revoke the invitation for ${invitation.email}?`
            : `Delete the invitation for ${invitation.email}?`
        }
        description={
          live
            ? "The link you passed on stops working."
            : "This removes the record. Nobody's access changes."
        }
      />
      <Modal.Body>
        <p className="text-body wrap-anywhere text-tx-2">
          {live ? (
            <>
              The invitation for{" "}
              <strong className="font-medium text-tx">
                {invitation.email}
              </strong>{" "}
              is deleted, not marked revoked — so the link already handed out
              stops working, and there is no route that reissues it. Inviting
              them again makes a new invitation with a new link to pass on.
            </>
          ) : (
            <>
              The row for{" "}
              <strong className="font-medium text-tx">
                {invitation.email}
              </strong>{" "}
              leaves this list. It is no longer usable either way, so nothing
              changes for them — and if they accepted it, they stay a member of
              this Organization.
            </>
          )}
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
              await remove.mutateAsync(invitation.id);
              toast.done(`The invitation for ${invitation.email} is gone.`);
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            }
          }}
        >
          {live ? "Revoke it" : "Delete it"}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
