import { useState } from "react";

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
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import { counted } from "@/lib/format/plural";
import { timeExact } from "@/lib/format/time";

import { useBackUpNow, useServerBackups } from "../buy/use-bought-servers";

/** Said while backups are on and the provider has made none yet: it makes one a day. */
export const FIRST_BACKUP_WITHIN_A_DAY =
  "The first backup is taken within a day.";

/** Said on Back up now to a role that may not change the Server. */
export const BACK_UP_NOW_REFUSAL =
  "Your role in this Organization cannot back up this Server. Ask an owner or an admin.";

/** Said on Back up now while the Server is busy or not made yet. */
export const BACK_UP_NOW_WAITS_FOR_READY =
  "This Server can be backed up once it is Ready.";

/** The provider keeps this many; one more pushes out the oldest (ADR-0093). */
const SLOTS = 7;

// The day and the minute in the reader's own zone. Not `timeAgo`: a backup is
// picked by which day it is of, and "3 days ago" makes the reader count.
const TAKEN = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

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

const COLUMNS: Column<ServerBackup>[] = [
  {
    id: "taken",
    head: "Taken",
    tone: "key",
    cell: (backup) => (
      <time dateTime={backup.takenAt} title={timeExact(backup.takenAt)}>
        {TAKEN.format(new Date(backup.takenAt))}
      </time>
    ),
  },
  {
    id: "size",
    head: "Size",
    tone: "num",
    // A size is not known until the copy is whole, so the word stands in for it.
    cell: (backup) =>
      backup.beingMade || backup.sizeGb === null ? (
        <span className="text-tx-3">Being made</span>
      ) : (
        sizeOf(backup.sizeGb)
      ),
  },
];

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
 */
export function ServerBackupList({ view }: { view: BoughtServerView }) {
  const backups = useServerBackups(view.id, view.backups);
  const backUpNow = useBackUpNow(view.id);
  const canChange = usePermission({ server: ["create"] });
  const [asking, setAsking] = useState(false);
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
  const why = !canChange.allowed
    ? BACK_UP_NOW_REFUSAL
    : view.stage !== "ready"
      ? BACK_UP_NOW_WAITS_FOR_READY
      : null;

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
          {rows.length > 0 ? (
            <>
              <strong>
                {counted(rows.length, "Server backup", "Server backups")}
              </strong>
              , newest first. The last 7 are kept.
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
          onClick={() => setAsking(true)}
        >
          Back up now
        </Button>
      </MetaStrip>
      {rows.length > 0 ? (
        <Card.Body flush>
          <DataTable
            label={`Server backups of ${view.name}`}
            columns={COLUMNS}
            rows={rows}
            getRowId={(backup) => String(backup.id)}
          />
        </Card.Body>
      ) : null}

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
          <Button type="button" variant="pri" onClick={() => void confirm()}>
            Back up now
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
