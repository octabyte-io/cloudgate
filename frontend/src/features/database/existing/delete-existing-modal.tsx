import { ConfirmDeleteModal } from "@/components/console/confirm-delete-modal";
import { toast } from "@/components/console/toast";
import type {
  Database,
  DatabaseDeleteReport,
} from "@/lib/api/endpoints/databases";

/**
 * An Existing database's Delete (ADR-0033): it removes only
 * Cloudgate's records of it — the Service, its saved login — and never
 * touches the database, so there is no snapshot, no "also delete its data"
 * box and no volume. The API refuses it while a Service links to it, and
 * the toast repeats what the API says was left.
 */
export function DeleteExistingModal({
  database,
  identifier,
  open,
  onOpenChange,
  remove,
  onDeleted,
}: {
  database: Database;
  identifier: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remove: () => Promise<DatabaseDeleteReport>;
  onDeleted: () => void;
}) {
  return (
    <ConfirmDeleteModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${database.name}`}
      confirmWord={database.name}
      mismatch="That does not match the database's name."
      button="Delete from Cloudgate"
      onConfirm={async () => {
        const answer = await remove();
        onOpenChange(false);
        toast.done(`${database.name} deleted.`, {
          description:
            answer.left?.message ??
            `${identifier} was left as it was; it is yours.`,
        });
        onDeleted();
      }}
    >
      <p className="rounded-lg border border-line bg-panel-2 px-3.5 py-3 text-body text-tx">
        Only Cloudgate&apos;s records go: this Service and the{" "}
        {database.kind === "redis" ? "AUTH token" : "login"} it keeps.{" "}
        <strong className="font-medium">{identifier}</strong> is left as it was
        — no snapshot, nothing deleted in it, nothing changed in AWS.
      </p>
      <p className="text-meta text-tx-2">
        If the Project config still lists {database.name}, the next plan creates
        it as a new database.
      </p>
    </ConfirmDeleteModal>
  );
}
