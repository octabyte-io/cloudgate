import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Rollback } from "@/lib/api/endpoints/rollbacks";
import { errorMessage } from "@/lib/api/error-message";

/**
 * Delete a rollback point.
 *
 * **The one delete on F10's screens that is not a row**, which is why it does not
 * go through `DeleteResourceModal` and its "you can add it back at any time"
 * copy. `rollbacks.service.ts` runs `docker image rm --force` on the
 * Application's Server first and only then drops the row: the snapshot's image
 * is deleted from the host, and the only way to get that version back is to
 * build the commit again — if it is still in the repository.
 *
 * One detail of that order is worth surfacing rather than hiding, because it
 * looks like a bug when it happens: **an image that fails to delete keeps its
 * row.** The service does it that way on purpose, so a snapshot is never listed
 * as available when its image is gone. So a refusal here means nothing was
 * deleted, and the row staying is correct.
 */
export function DeleteRollbackModal({
  rollback,
  open,
  onOpenChange,
  remove,
}: {
  rollback: Rollback | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remove: (rollbackId: string) => Promise<unknown>;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!rollback) return null;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setRefusal(null);
        onOpenChange(next);
      }}
    >
      <Modal.Header
        title={`Delete the v${rollback.version} snapshot?`}
        description="This deletes the image from the Server, not just the row."
      />
      <Modal.Body>
        <p className="text-body text-tx-2">
          <strong className="font-medium text-tx">
            You will not be able to roll back to this version again.
          </strong>{" "}
          The image{" "}
          <span className="font-mono text-meta wrap-anywhere">
            {rollback.image ?? "—"}
          </span>{" "}
          is removed from the Server, and getting that version back would mean
          building its commit a second time.
        </p>
        <p className="text-body text-tx-2">
          Nothing running changes. If this Application is currently on this image,
          it keeps running from the copy Swarm already holds.
        </p>
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Keep it</Button>} />
        <Button
          type="button"
          variant="dngr"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={async () => {
            setRefusal(null);
            setPending(true);
            try {
              await remove(rollback.rollbackId);
              toast.done(`v${rollback.version} deleted.`);
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            } finally {
              setPending(false);
            }
          }}
        >
          Delete the image
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
