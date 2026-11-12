import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { PendingIcon } from "@/components/console/submit-button";
import { errorMessage } from "@/lib/api/error-message";

import type { ResourceSpec } from "./resource-spec";

/**
 * Remove one row.
 *
 * **No typed confirmation on any of these**, and the reason is the same one
 * `delete-domain-modal.tsx` gives: every row on F10's four lists is
 * recoverable in seconds from the dialog beside it, and nothing already
 * deployed is destroyed by removing one. Requiring a typed name for a
 * reversible action is how people learn to type names without reading them —
 * which is exactly the habit that makes the irreversible confirmations (a
 * Project, an Environment, a volume restore) stop working.
 *
 * What it does carry is `deleteNote`, because the *timing* is the thing people
 * get wrong: a mount that disappears from this table is still mounted in the
 * running container until the next Deployment.
 *
 * The refusal stays **in the dialog** rather than becoming a toast. The dialog
 * is where the decision was made and it is still open; a corner notification
 * about a box you are looking at is a notification you have to go and find.
 *
 * **What the delete answered is handed back through `onRemoved`**, because a
 * row's delete can leave something on a machine — a schedule's or a backup's
 * run logs — and
 * this dialog closes as soon as it resolves. The list that owns it shows the
 * report, the way the Service deletes do.
 */
export function DeleteResourceModal<Row, Values extends Record<string, unknown>>({
  spec,
  row,
  open,
  onOpenChange,
  onRemoved,
}: {
  spec: ResourceSpec<Row, Values>;
  row: Row | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The delete's answer, once it has succeeded, with the row's name. */
  onRemoved?: (answer: unknown, name: string) => void;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!row) return null;
  const name = spec.rowName(row);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setRefusal(null);
        onOpenChange(next);
      }}
    >
      <Modal.Header
        title={`Remove ${name}?`}
        description={
          spec.deleteDescription ??
          `This removes the ${spec.noun} and nothing else.`
        }
      />
      <Modal.Body>
        <p className="text-body wrap-anywhere text-tx-2">
          {/* The default names no owner. F10's four lists all pass a
              `deleteNote`, and the sentence this replaces said "removed from
              this Application" — which is F11's `emptyBody` defect waiting to
              happen the moment a shared component is used by a list that
              belongs to an Organization instead. */}
          {spec.deleteNote?.(row) ?? (
            <>
              <strong className="font-medium text-tx">{name}</strong> is removed.
              You can add it back at any time.
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
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={async () => {
            setRefusal(null);
            setPending(true);
            try {
              const answer = await spec.remove(row);
              toast.done(`${name} removed.`);
              onOpenChange(false);
              onRemoved?.(answer, name);
            } catch (error) {
              setRefusal(errorMessage(error));
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? <PendingIcon /> : null}
          Remove {spec.noun}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
