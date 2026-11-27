import { Card } from "@/components/console/card";
import { DataTable, type Column } from "@/components/console/data-table";
import { MetaStrip } from "@/components/console/meta-strip";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import type {
  BoughtServerView,
  ServerBackup,
} from "@/lib/api/endpoints/bought-servers";
import { Icon } from "@/lib/design/icons";
import { counted } from "@/lib/format/plural";
import { timeExact } from "@/lib/format/time";

import { useServerBackups } from "../buy/use-bought-servers";

/** Said while backups are on and the provider has made none yet: it makes one a day. */
export const FIRST_BACKUP_WITHIN_A_DAY =
  "The first backup is taken within a day.";

// The day and the minute in the reader's own zone. Not `timeAgo`: a backup is
// picked by which day it is of, and "3 days ago" makes the reader count.
const TAKEN = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

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
 */
export function ServerBackupList({ view }: { view: BoughtServerView }) {
  const backups = useServerBackups(view.id, view.backups);
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
  return (
    <>
      <MetaStrip className="border-t">
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
    </>
  );
}
