import { useId, useState } from "react";

import { ConfirmDeleteModal } from "@/components/console/confirm-delete-modal";
import { toast } from "@/components/console/toast";
import { Checkbox } from "@/components/ui/checkbox";
import type {
  Database,
  DatabaseKind,
  FinalSnapshotPreview,
} from "@/lib/api/endpoints/databases";

import { keptCopy } from "@/features/project/plan-final-snapshot";

import { useFinalSnapshot } from "../use-cloud-delete";

/** What a Delete keeps, as the confirmation says it before it is pressed. */
export function keepsLine(snapshot: FinalSnapshotPreview): string {
  return `Deleting ${snapshot.sentence}.`;
}

/**
 * A postgres on RDS's or a redis on ElastiCache's Delete
 * a Cloud run
 * that never loses data by accident. Before it is pressed the dialog reads the
 * final snapshot it keeps (`GET /:kind/:id/final-snapshot`) and says "keeps
 * snapshot <name>, about $X a month, until you delete it in AWS". The one box,
 * "Also delete its data (no final snapshot)", needs nothing beyond the
 * Delete's own `service: delete`; ticked, the dialog says the data is deleted
 * for good. The row stays, Deleting, until the run ends, so the screen stays.
 */
export function CloudDeleteDatabaseModal({
  database,
  kind,
  open,
  onOpenChange,
  remove,
}: {
  database: Database;
  kind: DatabaseKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remove: (deleteData: boolean) => Promise<unknown>;
}) {
  const [deleteData, setDeleteData] = useState(false);
  const snapshot = useFinalSnapshot(kind, database.databaseId, open);
  const boxId = useId();
  // A Google database answers its Cloud SQL or Memorystore endpoint, even
  // `null` before it is made.
  const onGoogle =
    "cloudSqlEndpoint" in database || "memorystoreEndpoint" in database;
  const { copy, where } = keptCopy(onGoogle ? "gcp" : "aws");
  const engine = onGoogle
    ? kind === "redis"
      ? "Memorystore instance"
      : "Cloud SQL instance"
    : kind === "redis"
      ? "ElastiCache cache"
      : "RDS instance";

  return (
    <ConfirmDeleteModal
      open={open}
      onOpenChange={(next) => {
        // The box is part of the decision, so it resets with the typed name.
        if (!next) setDeleteData(false);
        onOpenChange(next);
      }}
      title={`Delete ${database.name}`}
      confirmWord={database.name}
      mismatch="That does not match the database's name."
      button="Delete database"
      onConfirm={async () => {
        await remove(deleteData);
        onOpenChange(false);
        toast.done(`Deleting ${database.name}.`, {
          description: deleteData
            ? `A Cloud run destroys it in ${where}, with no final ${copy}.`
            : `A Cloud run destroys it in ${where} and keeps its final ${copy}.`,
        });
      }}
    >
      <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
        {kind === "redis" && onGoogle
          ? "A Cloud run destroys the "
          : "A Cloud run lifts its deletion protection, then destroys the "}
        {engine} and everything Cloudgate made for it
        {database.region ? ` in ${database.region}` : ""}. Anything connecting
        to it stops being able to.
      </p>

      <p aria-label="What the Delete keeps" className="text-body text-tx">
        {deleteData
          ? `Its data is deleted for good: no final ${copy} is taken, so nothing of it can be restored.`
          : snapshot.data
            ? keepsLine(snapshot.data)
            : `Deleting keeps a final ${copy} of it until you delete it in ${where}.`}
      </p>

      <div className="flex items-start gap-2.5">
        <Checkbox
          id={boxId}
          checked={deleteData}
          onCheckedChange={(next) => setDeleteData(next === true)}
        />
        <label htmlFor={boxId} className="text-body text-tx">
          Also delete its data (no final {copy})
        </label>
      </div>
    </ConfirmDeleteModal>
  );
}
