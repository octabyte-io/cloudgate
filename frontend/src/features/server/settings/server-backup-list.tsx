import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { DataTable, type Column } from "@/components/console/data-table";
import { MetaStrip } from "@/components/console/meta-strip";
import { Modal } from "@/components/console/modal";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type {
  BoughtServerView,
  ServerBackup,
} from "@/lib/api/endpoints/bought-servers";
import type { Server } from "@/lib/api/endpoints/servers";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import { counted } from "@/lib/format/plural";
import { timeExact } from "@/lib/format/time";

import { useBackUpNow, useServerBackups } from "../buy/use-bought-servers";
import { CHANGE_WAITS_FOR_READY } from "./bought-server-reasons";
import { RestoreBackupModal, takenOn } from "./restore-backup-modal";

/** Said while backups are on and the provider has made none yet: it makes one a day. */
export const FIRST_BACKUP_WITHIN_A_DAY =
  "The first backup is taken within a day.";

/** Said on Back up now and Restore to a role that may not change the Server. */
export const BACKUPS_REFUSAL =
  "Your role in this Organization cannot back up or restore this Server. Ask an owner or an admin.";

/**
 * Said on Restore while the Server is in maintenance, which refuses it as it
 * does any change that starts work: a Restore runs Server setup and
 * redeploys. Back up now starts nothing on it, so it stays live.
 */
export const RESTORE_WAITS_FOR_MAINTENANCE =
  "This Server can be restored once its maintenance is ended.";

/** Said on Restore for a backup the provider is still making. */
export const RESTORE_WAITS_FOR_BACKUP =
  "This backup can be restored once it is made.";

/** The provider keeps this many; one more pushes out the oldest (ADR-0093). */
const SLOTS = 7;

/**
 * The backup a confirmation names, "Tuesday 03:00": the 7 slots span a week
 * at most, so the weekday picks it out. Made per call, so it reads the
 * reader's zone as it is then.
 */
function weekdayAndTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((each) => each.type === type)?.value ?? "";
  return `${part("weekday")} ${part("hour")}:${part("minute")}`;
}

/**
 * GB as the provider counts them (decimal), to one place; under one, in MB.
 * Not `readBytes`, which counts in 1024s and would call 0.42 GB 430 MB.
 */
function sizeOf(gb: number): string {
  if (gb < 1) return `${Math.max(1, Math.round(gb * 1000))} MB`;
  const rounded = Math.round(gb * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} GB`;
}

const TAKEN: Column<ServerBackup> = {
  id: "taken",
  head: "Taken",
  tone: "key",
  cell: (backup) => (
    <time dateTime={backup.takenAt} title={timeExact(backup.takenAt)}>
      {/* The day and the minute in the reader's own zone. Not `timeAgo`:
            a backup is picked by which day it is of, and "3 days ago" makes
            the reader count. */}
      {takenOn(backup.takenAt)}
    </time>
  ),
};

/**
 * A size is not known until the copy is whole, so "Being made" stands in for
 * it; its cell is made per list, since that word is also why the row's
 * Restore waits, and carries an id it is described by.
 */
const SIZE: Pick<Column<ServerBackup>, "id" | "head" | "tone"> = {
  id: "size",
  head: "Size",
  tone: "num",
};

/**
 * A Bought Server's **Server backups** (ADR-0093), newest first, under its
 * Backups switch: shown only while backups are on, since turning them off
 * deletes every one. The order is the API's.
 *
 * **Back up now** takes one more at once, in the same 7 slots and at no
 * cost. It asks first and, once all 7 are full, names the oldest it will
 * push out; the list is read again until the new one is made. It waits,
 * with its reason, for a Ready Server and a role that may change it
 * (`server: ['create']`); a frozen Organization's refusal comes back from
 * the API as a toast, as the other changes' do.
 *
 * **Restore** on each row puts the disk back as it was then
 * (`RestoreBackupModal`), waiting with its reason for the same two, for a
 * Server out of maintenance and for a backup that is whole. While one runs,
 * the strip says which backup; as it ends, the list is read again, so the
 * safety copy shows.
 *
 * A control that waits says why on screen as well as in its `title`, and
 * points `aria-describedby` at that sentence (design-system.md, "Off, and
 * looking off"): the card's own note while the Server is not Ready
 * (`readyNoteId`, so the sentence is not said twice), a note under the strip
 * for the role and for maintenance, and a backup's "Being made".
 */
export function ServerBackupList({
  view,
  server,
  readyNoteId,
}: {
  view: BoughtServerView;
  server: Server;
  /** The card's note saying {@link CHANGE_WAITS_FOR_READY}, while it shows. */
  readyNoteId: string;
}) {
  const backups = useServerBackups(
    view.id,
    view.backups,
    view.stage === "changing",
  );
  const backUpNow = useBackUpNow(view.id);
  const canChange = usePermission({ server: ["create"] });
  const [asking, setAsking] = useState(false);
  const [restoring, setRestoring] = useState<ServerBackup | null>(null);
  const noteId = useId();
  const rowId = useId();
  if (!view.backups) return null;

  if (backups.error) {
    return (
      <Card.Body className="border-t border-line">
        <p role="alert" className="flex gap-2 text-meta wrap-anywhere text-tx">
          <Icon name="alert" className="mt-0.5 flex-none text-bad" />
          {errorMessage(backups.error)}
        </p>
      </Card.Body>
    );
  }
  if (backups.isPending) {
    return (
      <Card.Body className="border-t border-line">
        <Skeleton className="h-4 w-48" />
      </Card.Body>
    );
  }
  const rows = backups.data;
  const pushedOut = rows.length >= SLOTS ? rows[rows.length - 1] : null;
  const ready = view.stage === "ready";
  const inMaintenance = server.maintenanceSince !== null;
  const why = !canChange.allowed
    ? BACKUPS_REFUSAL
    : !ready
      ? CHANGE_WAITS_FOR_READY
      : null;
  const restoreWhy =
    why ?? (inMaintenance ? RESTORE_WAITS_FOR_MAINTENANCE : null);
  // Where each reason is said on screen: the card's note says Ready's.
  const whyId = why === CHANGE_WAITS_FOR_READY ? readyNoteId : noteId;
  const restoreWhyId =
    restoreWhy === CHANGE_WAITS_FOR_READY ? readyNoteId : noteId;
  const note = restoreWhy === CHANGE_WAITS_FOR_READY ? null : restoreWhy;
  const beingMadeId = (backup: ServerBackup) => `${rowId}-${backup.id}`;

  const columns: Column<ServerBackup>[] = [
    TAKEN,
    {
      ...SIZE,
      cell: (backup) =>
        backup.beingMade || backup.sizeGb === null ? (
          <span id={beingMadeId(backup)} className="text-tx-3">
            Being made
          </span>
        ) : (
          sizeOf(backup.sizeGb)
        ),
    },
    {
      id: "actions",
      head: <span className="sr-only">Actions</span>,
      cell: (backup) => {
        const held =
          restoreWhy ?? (backup.beingMade ? RESTORE_WAITS_FOR_BACKUP : null);
        return (
          <Button
            type="button"
            size="xs"
            disabled={held !== null}
            title={held ?? undefined}
            aria-describedby={
              restoreWhy !== null
                ? restoreWhyId
                : held !== null
                  ? beingMadeId(backup)
                  : undefined
            }
            onClick={() => setRestoring(backup)}
          >
            Restore
          </Button>
        );
      },
    },
  ];
  const restoringFrom = view.change?.restore?.backupTakenAt;

  async function confirm() {
    setAsking(false);
    try {
      await backUpNow.mutateAsync();
      toast.done(`A backup of ${view.name} is being made.`);
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <>
      <MetaStrip className="flex items-center justify-between gap-3 border-t">
        <span>
          {restoringFrom ? (
            <>
              Restoring the backup of <strong>{takenOn(restoringFrom)}</strong>.
            </>
          ) : rows.length > 0 ? (
            <>
              <strong>
                {counted(rows.length, "Server backup", "Server backups")}
              </strong>{" "}
              kept, at most 7.
            </>
          ) : (
            FIRST_BACKUP_WITHIN_A_DAY
          )}
        </span>
        <Button
          type="button"
          size="xs"
          disabled={why !== null || backUpNow.isPending}
          title={why ?? undefined}
          aria-describedby={why !== null ? whyId : undefined}
          onClick={() => setAsking(true)}
        >
          Back up now
        </Button>
      </MetaStrip>
      {note ? (
        <p
          id={noteId}
          className="border-b border-line px-4 py-2 text-meta text-tx-2"
        >
          {note}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <Card.Body flush>
          <DataTable
            label={`Server backups of ${view.name}`}
            columns={columns}
            rows={rows}
            getRowId={(backup) => String(backup.id)}
          />
        </Card.Body>
      ) : null}

      <RestoreBackupModal
        view={view}
        backup={restoring}
        // The oldest of 7: its safety copy would push it out.
        noSafetyCopy={
          restoring !== null &&
          rows.length >= SLOTS &&
          rows[rows.length - 1].id === restoring.id
        }
        onOpenChange={(open) => !open && setRestoring(null)}
      />

      <Modal open={asking} onOpenChange={(open) => !open && setAsking(false)}>
        <Modal.Header
          title={`Back up ${view.name} now?`}
          description="A copy of the Server's own disk, kept with the daily ones in the same 7 slots, at no extra cost."
        />
        {pushedOut ? (
          <Modal.Body>
            <p className="text-body text-tx-2">
              All 7 slots are full, so{" "}
              <strong className="text-tx">
                {weekdayAndTime(pushedOut.takenAt)}
              </strong>{" "}
              will be removed.
            </p>
          </Modal.Body>
        ) : null}
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            type="button"
            variant="pri"
            disabled={why !== null}
            onClick={() => void confirm()}
          >
            Back up now
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
