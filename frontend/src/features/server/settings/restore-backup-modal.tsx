import { useId, useState } from "react";

import { ConfirmDeleteModal } from "@/components/console/confirm-delete-modal";
import { toast } from "@/components/console/toast";
import { Checkbox } from "@/components/ui/checkbox";
import type {
  BoughtServerView,
  ServerBackup,
} from "@/lib/api/endpoints/bought-servers";

import { useRestoreBackup } from "../buy/use-bought-servers";

/**
 * When a backup was taken, in the reader's own zone: "Nov 2, 2026, 3:00 AM".
 * Made per call, so it reads the zone as it is then.
 */
export function takenOn(iso: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

/**
 * **Restore** a Bought Server from one of its Server backups (ADR-0093),
 * confirmed by typing the Server's name, as Delete is: it loses everything
 * written since the backup, and nothing brings that back but the safety copy.
 *
 * Built on `ConfirmDeleteModal` for its machinery (the name cleared on close,
 * the refusal in the footer, Return submits), though nothing is deleted: the
 * weight of the confirmation is the same as a Delete's, so the dialog is too.
 *
 * The body says what the operator needs before pressing: the date it goes
 * back to, that the Server is offline meanwhile, that the extra storage (when
 * it has some) is not in a backup and keeps what it holds, and the safety
 * copy. When the backup is the oldest of 7, its safety copy would push it
 * out, so none can be taken: the dialog says so and asks for that on its own
 * checkbox, which the API's `withoutSafetyCopy` carries. The provider is
 * never named (ADR-0071).
 */
export function RestoreBackupModal({
  view,
  backup,
  noSafetyCopy,
  onOpenChange,
}: {
  view: BoughtServerView;
  /** The backup chosen; the dialog is open while there is one. */
  backup: ServerBackup | null;
  /** It is the oldest of 7: no safety copy can be taken. */
  noSafetyCopy: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const restore = useRestoreBackup(view.id);
  const [goAhead, setGoAhead] = useState(false);
  const checkboxId = useId();
  const date = backup ? takenOn(backup.takenAt) : "";

  return (
    <ConfirmDeleteModal
      open={backup !== null}
      onOpenChange={(open) => {
        setGoAhead(false);
        onOpenChange(open);
      }}
      title={`Restore ${view.name} to ${date}?`}
      description="Everything written to its disk since then is lost."
      confirmWord={view.name}
      mismatch="That does not match the Server's name."
      button="Restore this Server"
      alsoConfirmed={!noSafetyCopy || goAhead}
      onConfirm={async () => {
        await restore.mutateAsync({
          backupId: backup!.id,
          withoutSafetyCopy: noSafetyCopy,
        });
        toast.done(`${view.name} is being restored.`, {
          description: "It is Changing until Server setup has run on it again.",
        });
        setGoAhead(false);
        onOpenChange(false);
      }}
    >
      <p className="text-body text-tx">
        {view.name} is put back as it was on{" "}
        <strong className="font-medium">{date}</strong>. It is offline while it
        is restored, usually for a few minutes, then Server setup runs on it
        again.
      </p>
      {view.storageGb !== null ? (
        <p className="text-body text-tx">
          Extra storage at <code className="font-mono">/mnt/storage</code> is
          not in a backup, so it is not restored and keeps what it holds now.
        </p>
      ) : null}
      {noSafetyCopy ? (
        <div className="flex flex-col gap-2 rounded-lg border border-bad-line bg-bad-tint p-3">
          <p className="text-body text-tx">
            This is the oldest of the 7 backups kept, so a safety copy would
            remove it. None can be taken, and this restore cannot be undone.
          </p>
          <div className="flex items-start gap-2.5">
            <Checkbox
              id={checkboxId}
              checked={goAhead}
              onCheckedChange={(next) => setGoAhead(next === true)}
            />
            <label htmlFor={checkboxId} className="text-meta text-tx">
              Restore without a safety copy
            </label>
          </div>
        </div>
      ) : (
        <p className="text-body text-tx-2">
          First, a safety copy of the disk as it is now is kept as one more
          backup, so you can undo this by restoring that copy.
        </p>
      )}
    </ConfirmDeleteModal>
  );
}
