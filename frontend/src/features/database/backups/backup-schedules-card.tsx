import Link from "next/link";

import { MetaStrip } from "@/components/console/meta-strip";
import { ResourceList } from "@/components/console/resource-list";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { BackupDatabaseType } from "@/lib/api/endpoints/backups";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";
import type { Destination } from "@/lib/api/endpoints/destinations";

import { DATABASE_KIND } from "../kinds";
import { useBackupActions, useBackups } from "../use-database";
import { backupScheduleSpec } from "./backup-schedule-spec";
import { useBackupScheduleMutations } from "./use-backup-schedules";

/**
 * The dump schedules pointed at this database, and the form for one.
 *
 * **This card came in two steps.** `GET /backups?serviceId=&serviceType=` is
 * the read: before it a schedule could be created over the API and then never
 * named again, so the first step shipped the table and the two controls a row
 * needs no form for. What it could not do was add, change or remove one — a
 * cron expression, a destination, a prefix, a database name and a retention
 * count are a form with real decisions in it — and remove was left out *with*
 * create rather than shipped alone, on the rule that a screen should not offer
 * to destroy what it cannot recreate. The second step is both halves, so the
 * rule is kept by satisfying it rather than by declining.
 *
 * The list is a `ResourceList` configuration (`backup-schedule-spec.tsx`), the
 * same as the Application's volume backups: the two are one screen with a
 * different noun, and Edit and Remove now sit in the same place on both.
 *
 * What this file owns is the pair of controls that are **not** create-read-
 * update-delete, and the one thing this tab still cannot answer:
 *
 * 1. **Run now**, and stopping or resuming the cron. Both are one call on a row
 *    that has an id, and both stay on the row — pausing a schedule should not
 *    cost a dialog.
 * 2. **No "Last run" column.** A run is written as a `deployment` row keyed by
 *    `backupId`, and there is no per-schedule run-history route for database
 *    backups, so this card cannot put a verdict on a row. A column of dashes
 *    would read as *never ran*, which is a different and much more alarming
 *    claim. The verdict *is* readable, though: the Organization's Deployments
 *    feed lists every run as a "Database backup" with its status and log, so the
 *    note sends the operator there — it used to say the outcome was unreadable
 *    and link the tracker instead.
 */
export function BackupSchedulesCard({
  database,
  kind,
  serviceType,
  destinations,
  destinationsPending,
  noDestination,
}: {
  database: Database;
  kind: DatabaseKind;
  /**
   * The engine's own dump type — `DATABASE_KIND[kind].backup`, never null here.
   *
   * It is both halves of the pair `GET /backups` wants: for a database backup the
   * table the org scope resolves through and the dump tool that runs are the same
   * engine. Only a **compose** backup separates them, and this card is not one.
   */
  serviceType: BackupDatabaseType;
  destinations: Destination[];
  destinationsPending: boolean;
  /** No destination is connected, read and not refused. */
  noDestination: boolean;
}) {
  const descriptor = DATABASE_KIND[kind];
  const backups = useBackups(kind, database.databaseId, serviceType);
  const actions = useBackupActions(kind, database.databaseId);
  const mutations = useBackupScheduleMutations(kind, database.databaseId);

  const spec = backupScheduleSpec({
    databaseId: database.databaseId,
    databaseName: database.name,
    appName: database.appName,
    databaseType: serviceType,
    suggestedDatabase: database.databaseName ?? "",
    databaseHint:
      descriptor.backupDatabaseHint?.schedule ??
      "The database inside this server that gets dumped.",
    destinations,
    destinationsPending,
    noDestination,
    create: (input) => mutations.create.mutateAsync(input),
    update: (backupId, input) =>
      mutations.update.mutateAsync({ backupId, input }),
    remove: (backupId) => mutations.remove.mutateAsync(backupId),
  });

  return (
    <ResourceList
      spec={{
        ...spec,
        rowExtras: (row) => (
          <>
            <Button
              size="xs"
              disabled={actions.run.isPending}
              onClick={async () => {
                try {
                  await actions.run.mutateAsync(row.backupId);
                  toast.done(`Dumping ${row.database} now.`, {
                    description:
                      "The dump was handed to the engine. Whether it finished, and its log, is on Deployments as a Database backup; the file lands in the destination below.",
                  });
                } catch (error) {
                  toast.error(error);
                }
              }}
            >
              Run now
            </Button>
            <Button
              size="xs"
              disabled={actions.setEnabled.isPending}
              onClick={async () => {
                const next = !row.enabled;
                try {
                  await actions.setEnabled.mutateAsync({ row, enabled: next });
                  toast.done(
                    next
                      ? `Resumed the ${row.database} dump on ${row.schedule}.`
                      : `Paused the ${row.database} dump.`,
                  );
                } catch (error) {
                  toast.error(error);
                }
              }}
            >
              {/* **"Pause", not "Stop the cron"** (the first word), for two reasons
                  found on the screen. A database already has Stop and Start on
                  its Overview, and those stop the *engine* — the same verb on a
                  row in its Backups tab is the one place that ambiguity would be
                  expensive. And Edit and Remove joined this row later: at
                  "Stop the cron" the four controls came to 928px inside an 825px
                  card, which put Remove behind a scrollbar. */}
              {row.enabled ? "Pause" : "Resume"}
            </Button>
          </>
        ),
      }}
      query={backups}
      note={
        <MetaStrip>
          {/* Explicit, because this compiler drops the space between an inline
              element and the text after it — measured in the DOM, where
              `</em>is` came back with no gap. */}
          Every run of these schedules, Run now included, is listed on{" "}
          <Link
            href="/deployments"
            className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
          >
            Deployments
          </Link>{" "}
          as a Database backup, with whether it succeeded and its log. The dumps
          below are what a run left in the destination.
        </MetaStrip>
      }
    />
  );
}
