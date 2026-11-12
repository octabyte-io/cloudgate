import { useId, useState } from "react";

import { ConfirmDeleteModal } from "@/components/console/confirm-delete-modal";
import { KVList, KVRow } from "@/components/console/kv-list";
import {
  TeardownReportModal,
  useTeardownReport,
} from "@/components/console/teardown-report-modal";
import { toast } from "@/components/console/toast";
import { Checkbox } from "@/components/ui/checkbox";
import type {
  Database,
  DatabaseDeleteReport,
  DatabaseKind,
  VolumePresence,
} from "@/lib/api/endpoints/databases";

import { existingPlaceOf } from "@/lib/api/endpoints/existing-redis";

import { DeleteExistingModal } from "../existing/delete-existing-modal";
import { DATABASE_KIND } from "../kinds";
import { useDataVolume } from "../use-database";
import { CloudDeleteDatabaseModal } from "./cloud-delete-database-modal";

/**
 * Delete the database, and be exact about the one thing that survives.
 *
 * **The volume is not deleted unless asked, and that is worth a line rather
 * than a footnote.** `remove` drops the Swarm service and the row and keeps
 * the volume unless the box below is ticked
 * (`BaseDatabaseService.remove`). So deleting leaves `<appName>-data` on the
 * Server: the data is not lost, and it is also not reachable from this console
 * ever again, because nothing else will ever be called `<appName>`. Both halves
 * of that matter — one to somebody who wanted the data gone, the other to
 * somebody who wanted the disk back.
 *
 * A dead Server does not make deletion impossible, but it is no longer silent:
 * a service that cannot be confirmed gone keeps the row, and
 * `ConfirmDeleteModal` then offers "Remove from Cloudgate anyway", the forced
 * Delete, which drops it and names what may still be running. A
 * database never deployed is the same case on an unreachable Server: nothing
 * can be confirmed, so the force is what removes its row.
 *
 * **And now says what was actually left, rather than only that it could
 * happen**. The
 * response carries the file-mounts tree the teardown could not reclaim
 * — a directory
 * holding the last copy in existence of the operator\'s own mounted file
 * bodies, in plaintext. The row is gone by then, so this response is the only
 * record of that path anywhere; on a clean delete it carries nothing and this
 * behaves exactly as it did.
 *
 * **The volume is claimed only for a database known to have been deployed**
 * The volume is
 * created by the first deploy, so a database created and never deployed has
 * none — and this dialog used to tell its operator to `docker volume rm` a
 * volume that was never there.
 *
 * So the dialog asks the Server as it opens (`GET /:kind/:id/volume`,
 * `useDataVolume`): `present: true` is a volume left behind, named with how to
 * remove it; `false` is nothing to leave, said plainly and with no advice.
 * `null` — a multi-node swarm, where the volume may be on another node, or a
 * Server that did not answer — and a read still in flight fall back to the
 * row's status, and only `done` settles it: a completed deploy and a start
 * both write it, and both leave the volume on the Server. `idle` is **both**
 * a database never deployed and one deployed and then stopped;
 * `running` is written before the deploy pulls the image, and `error` by a
 * deploy that may have failed before or after the service existed. For those
 * the dialog cannot claim a volume and must not deny one — a stopped
 * database's data is exactly what the advice is for — so it says which case
 * leaves what.
 *
 * The toast takes the DELETE's own `volumeLeftBehind`, read after the
 * teardown, and falls back to the dialog's read and then the status the same
 * way — unless the box was ticked, when the DELETE's report decides it.
 *
 * **"Also delete its data volume"** is the on-request half of the glossary's
 * Delete (#1413): ticked, the DELETE carries `deleteData`, and the Server
 * removes `<appName>-data` once the service is gone. It is offered unless the
 * Server positively has no volume. A volume the removal had to keep (its
 * Volume lock held, another Service on the Server mounting it, Docker
 * refusing) comes back as a `volume` line in the teardown report, so the toast
 * never claims it is gone; and a clean answer is the volume gone, so the toast
 * never says it is still there.
 */
export function DeleteDatabaseModal({
  database,
  kind,
  open,
  onOpenChange,
  remove,
  onDeleted,
}: {
  database: Database;
  kind: DatabaseKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * `deleteData`: "also delete its data" — no final snapshot in a Cloud
   * account, the data volume removed on a Server. `force`:
   * a Server database's forced Delete; never sent to a cloud one.
   */
  remove: (
    deleteData?: boolean,
    force?: boolean,
  ) => Promise<DatabaseDeleteReport>;
  /** Where to go afterwards. This screen cannot stay — its row is gone. */
  onDeleted: () => void;
}) {
  // A postgres on RDS or a redis on ElastiCache: its Delete is a
  // Cloud run that keeps a final snapshot, and its row stays until it ends.
  if (database.cloudAccountId) {
    return (
      <CloudDeleteDatabaseModal
        database={database}
        kind={kind}
        open={open}
        onOpenChange={onOpenChange}
        remove={remove}
      />
    );
  }
  return (
    <ServerDeleteDatabaseModal
      database={database}
      kind={kind}
      open={open}
      onOpenChange={onOpenChange}
      remove={remove}
      onDeleted={onDeleted}
    />
  );
}

function ServerDeleteDatabaseModal({
  database,
  kind,
  open,
  onOpenChange,
  remove,
  onDeleted,
}: {
  database: Database;
  kind: DatabaseKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remove: (
    deleteData?: boolean,
    force?: boolean,
  ) => Promise<DatabaseDeleteReport>;
  onDeleted: () => void;
}) {
  const descriptor = DATABASE_KIND[kind];
  const teardown = useTeardownReport();
  const [deleteData, setDeleteData] = useState(false);
  const boxId = useId();
  const volume = `${database.appName}-data`;
  const existing = existingPlaceOf(database);
  // An Existing database has no volume of Cloudgate's to ask about.
  const read = useDataVolume(kind, database.databaseId, open && !existing);
  /**
   * The Server's answer where there is one, else what the status can claim:
   * `true` for `done` and for `stopped`, `null` for the rest.
   *
   * `stopped` joined `done`, and on the same reasoning: it is written
   * only by a Stop, a Stop only reaches a service that exists, and the volume
   * is created by the deploy that created it. Before that value existed a
   * stopped database wore `idle` and this fell through to `null`, so the dialog
   * could not say the data volume would survive the delete.
   */
  const known = (answer: VolumePresence | undefined): VolumePresence =>
    answer ??
    (database.applicationStatus === "done" ||
    database.applicationStatus === "stopped"
      ? true
      : null);
  const present = known(read.data?.present);

  if (existing) {
    return (
      <DeleteExistingModal
        database={database}
        identifier={existing.identifier}
        open={open}
        onOpenChange={onOpenChange}
        remove={() => remove()}
        onDeleted={onDeleted}
      />
    );
  }

  async function finish(force: boolean) {
    // What the dialog knew of the volume when the Delete was confirmed.
    const hadVolume = present;
    let answered: DatabaseDeleteReport | undefined;
    const clean = await teardown.runDelete(async () => {
      answered = await remove(deleteData, force);
      return answered;
    });
    onOpenChange(false);
    if (!clean || !answered) {
      // The report modal is open now, and it holds the only copy of the
      // paths. Navigating would unmount it — `onDismissed` goes instead.
      return;
    }
    toast.done(`${database.name} deleted.`, {
      description: deletedSentence(answered, hadVolume),
    });
    onDeleted();
  }

  /**
   * The toast's sentence about the volume, from the Delete's own answer.
   *
   * Asked to delete the data, the answer says whether it was kept: a removal
   * that kept the volume is a `volume` line in `unreclaimedArtifacts`, and
   * nothing there means it is gone — the after-read cannot overrule that by
   * saying `null` (a multi-node swarm), and the read taken as the dialog
   * opened is stale by then. Whether there was a volume to delete is still the
   * dialog's knowledge, so a database that may never have been deployed is not
   * told its volume was deleted.
   */
  function deletedSentence(
    answer: DatabaseDeleteReport,
    hadVolume: VolumePresence,
  ): string {
    const keptVolume =
      answer.volumeLeftBehind === true ||
      (answer.unreclaimedArtifacts ?? []).some(
        (artifact) => artifact.kind === "volume" && artifact.path === volume,
      );
    if (deleteData && !keptVolume) {
      return hadVolume === true
        ? `Its data volume ${volume} was deleted, so nothing is left on the Server.`
        : hadVolume === false
          ? "It had no data volume, so nothing is left on the Server."
          : `Nothing is left on the Server: its data volume ${volume}, if it was ever deployed, was deleted.`;
    }
    const said = known(answer.volumeLeftBehind ?? read.data?.present);
    return said === false
      ? "It had no data volume, so nothing is left on the Server."
      : said === true
        ? `Its data volume ${volume} is still on the Server.`
        : `If it was ever deployed, its data volume ${volume} remains on the Server. If it was never deployed, nothing is left behind.`;
  }

  return (
    <>
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
        onConfirm={() => finish(false)}
        forceRemove={{
          onConfirm: () => finish(true),
          leftBehind: (
            <>
              Removing it anyway deletes this row, its credentials and its
              variables now, without confirming anything on the Server.
              Whatever is still there stays: the service{" "}
              <code className="font-mono">{database.appName}</code> may keep
              running with nothing in Cloudgate to stop it, and its data volume
              may remain. Cloudgate then lists what it could not confirm, for
              you to remove on the Server.
            </>
          ),
        }}
      >
        <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
          The {descriptor.label} service will be stopped and removed, and this
          row will go with it — along with its credentials, its variables and
          its published port. Anything connecting to{" "}
          <strong className="font-medium">{database.appName}</strong> stops
          being able to.
        </p>

        <KVList>
          <KVRow
            label="Will remove service"
            value={database.appName}
            title={database.appName}
            mono
          />
          {present === true ? (
            <KVRow
              label={deleteData ? "Will delete volume" : "Volume left behind"}
              value={volume}
              title={volume}
              mono
            />
          ) : null}
        </KVList>

        {present === false ? (
          <p className="text-meta text-tx-2">
            There is no data volume on the Server, so nothing is left behind.
          </p>
        ) : deleteData ? (
          <p className="text-meta text-tx-2">
            <strong className="font-medium text-tx-2">
              Its data is deleted for good.
            </strong>{" "}
            Once the service is gone, Cloudgate deletes{" "}
            <code className="font-mono">{volume}</code> from the Server, so
            nothing of it can be restored. If Cloudgate has to keep it, the
            report afterwards says why.
          </p>
        ) : present === true ? (
          <p className="text-meta text-tx-2">
            <strong className="font-medium text-tx-2">
              The data volume is not deleted.
            </strong>{" "}
            Cloudgate removes the service and keeps the disk, so the contents
            are still on the Server — and out of reach of this console, since
            nothing will be given this service name again. Tick the box below
            to delete it too, or remove it there later with{" "}
            <code className="font-mono">docker volume rm {volume}</code>.
          </p>
        ) : (
          <p className="text-meta text-tx-2">
            <strong className="font-medium text-tx-2">
              A data volume is left behind only if this database was ever
              deployed.
            </strong>{" "}
            The first deploy creates <code className="font-mono">{volume}</code>{" "}
            and deleting does not remove it, so a database that was deployed and
            then stopped still has its contents on the Server — out of reach of
            this console afterwards. Tick the box below to delete it too, or
            remove it there later with{" "}
            <code className="font-mono">docker volume rm {volume}</code>. If it
            never was, there is no volume and nothing is left behind.
          </p>
        )}

        {present !== false ? (
          <div className="flex items-start gap-2.5">
            <Checkbox
              id={boxId}
              checked={deleteData}
              onCheckedChange={(next) => setDeleteData(next === true)}
            />
            <label htmlFor={boxId} className="text-body text-tx">
              Also delete its data volume
            </label>
          </div>
        ) : null}
      </ConfirmDeleteModal>

      <TeardownReportModal
        report={teardown.report}
        serviceName={database.name}
        open={teardown.open}
        onOpenChange={teardown.setOpen}
        onDismissed={onDeleted}
      />
    </>
  );
}
