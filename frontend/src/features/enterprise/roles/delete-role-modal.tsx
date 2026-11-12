import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { CustomRole } from "@/lib/api/endpoints/roles";

import { countGrants } from "./use-custom-roles";

/**
 * Delete a role nobody holds.
 *
 * **A plain confirmation, and deliberately not a typed name.** `DangerZone`'s
 * second rule from the other side: asking for a typed name for something
 * recoverable is how people learn to type names without reading them. The
 * backend refuses while anyone holds the role, so this only ever deletes a
 * definition nothing is using — and what is lost is the choice of grants, which
 * the dialog counts.
 *
 * Not `DeleteResourceModal` either: that one is `ResourceSpec`-driven and this
 * is not a `ResourceList` row.
 */
export function DeleteRoleModal({
  role,
  pending,
  onClose,
  onConfirm,
}: {
  role: CustomRole;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Modal open onOpenChange={(next) => !next && onClose()}>
      <Modal.Header
        title={`Delete ${role.role}?`}
        description="Nobody holds it, so nothing changes for any member."
      />
      <Modal.Body>
        <p className="text-body text-tx-2">
          The role and its {countGrants(role.permissions)} grants are removed.
          Creating it again means picking the grants again — nothing keeps a
          copy.
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="dngr"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={async () => {
            try {
              await onConfirm();
            } catch (error) {
              toast.error(error);
            }
          }}
        >
          Delete the role
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
