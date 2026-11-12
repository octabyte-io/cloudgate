"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { NoListing } from "@/components/console/no-listing";
import { PageHeader } from "@/components/console/page-header";
import type { BackupFile } from "@/lib/api/endpoints/backups";
import { cloudDatabaseKind } from "@/lib/api/endpoints/cloud-backups";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";
import { useDestinations } from "@/lib/api/use-destinations";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { BackupFilesCard } from "../backups/backup-files-card";
import { BackupSchedulesCard } from "../backups/backup-schedules-card";
import { CloudBackupsTab } from "../backups/cloud-backups-card";
import { RestoreModal } from "../backups/restore-modal";
import { DatabaseFactsCard } from "../database-facts-card";
import { DatabasePanel } from "../database-panel";
import { DATABASE_KIND } from "../kinds";
import { useRestoreBackup } from "../use-database";

/**
 * Dumps, and getting one back — in three cards, which is the order the questions
 * come in.
 *
 * **The first card is what changed, twice.** The brief asked for schedules against
 * a destination, retention, "Run now", the file list and the restore flow, and four
 * of those five need a `backup` row that nothing handed out: the controller had
 * no list route and no engine's `findOne` loaded a `backups` relation, so a
 * schedule could be created and then never named again. This tab shipped a stated
 * absence in its place. `GET /backups?serviceId=&serviceType=`
 * is that route and
 * gave it a table; `POST /`, `PATCH /:id` and `DELETE /:id` were reachable all
 * along and had no screen until now —
 * `BackupSchedulesCard` is now the whole of a schedule's life, with the one limit
 * it still has stated on the card rather than here.
 *
 * The schedules card takes the destinations this Body already loads rather than
 * reading them again. They are the same Organization-scoped list either way, but
 * one read means the picker in the form and the picker over the bucket cannot
 * disagree about what is connected while a refetch is in flight.
 *
 * The other two always worked, and for a reason worth keeping in view:
 * `GET /backups/files` reads the **bucket** and `POST /backups/restore` takes the
 * service, the database name and an object key. Neither needs a `backup` row, so
 * the destructive half of this feature was complete while the routine half was
 * unreachable — and it is still the bucket, not a row, that answers "did a dump
 * actually land". Both are bounded to the caller's own Services since
 * A Destination's
 * bucket is Organization-wide, so the listing drops the prefixes of Services this
 * Member is not entitled to and the restore refuses a key under one. A prefix no
 * Service claims — one whose Service was destroyed and recreated, a dump uploaded
 * by hand — stays available to both.
 *
 * **Redis has none of it**, and reads the descriptor rather than its own name:
 * `BACKUP_COMMANDS` has five entries and Redis is not one of them.
 */
export default function Panel(props: PanelProps) {
  return (
    <DatabasePanel
      panel={props}
      aside={(row, kind) => <DatabaseFactsCard database={row} kind={kind} />}
      header={(row) => (
        <PageHeader
          title={props.label}
          icon={props.icon}
          lede={
            cloudDatabaseKind(row)
              ? `The backups AWS keeps of ${row.name}, read live.`
              : `Dumps of ${row.name}, and restoring one over it.`
          }
        />
      )}
    >
      {(row, kind) => {
        // A database in a Cloud account keeps its provider's backups.
        const cloud = cloudDatabaseKind(row);
        return cloud ? (
          <CloudBackupsTab row={row} kind={cloud} />
        ) : (
          <Body row={row} kind={kind} />
        );
      }}
    </DatabasePanel>
  );
}

function Body({ row, kind }: { row: Database; kind: DatabaseKind }) {
  const descriptor = DATABASE_KIND[kind];
  const destinations = useDestinations();
  const restore = useRestoreBackup(kind, row.databaseId);

  const [destinationId, setDestinationId] = useState("");
  const [restoring, setRestoring] = useState<BackupFile | null>(null);

  // No dump command, so there is nothing to schedule, list or restore. Said
  // once, as the whole tab.
  if (!descriptor.backup) {
    return (
      <Card>
        <Card.Body flush>
          <NoListing
            icon="hdd"
            title={`Cloudgate cannot back up ${descriptor.label}`}
            footer="Its data volume can still be tarred to a destination from the Server itself, and a Redis used as a cache is usually the one thing in a stack that does not need a backup."
          >
            {/* The five other engines have a dump and restore command; this
                one has neither. It is the platform's shape, not a setting. */}
            {descriptor.label}{" "}
            has no dump or restore command, so there is nothing to schedule or
            restore here.
          </NoListing>
        </Card.Body>
      </Card>
    );
  }

  const rows = destinations.data ?? [];
  const destination = rows.find((item) => item.destinationId === destinationId);

  return (
    <>
      <BackupSchedulesCard
        database={row}
        kind={kind}
        serviceType={descriptor.backup}
        destinations={rows}
        destinationsPending={destinations.isPending}
        noDestination={
          !destinations.isPending && !destinations.error && rows.length === 0
        }
      />

      <BackupFilesCard
        database={row}
        destinations={rows}
        destinationsPending={destinations.isPending}
        destinationsError={destinations.error}
        destinationId={destinationId}
        onDestinationChange={setDestinationId}
        onRestore={setRestoring}
      />

      <RestoreModal
        // Keyed on the file, so every opening mounts fresh — F09's
        // add-a-domain defect, and this dialog holds a typed confirmation that
        // absolutely must not survive a close.
        key={restoring?.Path ?? "none"}
        database={row}
        kind={kind}
        destination={destination}
        file={restoring}
        open={restoring !== null}
        onOpenChange={(next) => {
          if (!next) setRestoring(null);
        }}
        restore={(input) => restore.mutateAsync(input)}
      />
    </>
  );
}
