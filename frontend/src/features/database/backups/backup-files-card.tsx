import Link from "next/link";
import { useState } from "react";

import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { Field } from "@/components/console/field";
import { Picker } from "@/components/console/picker";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import type { BackupFile } from "@/lib/api/endpoints/backups";
import type { Destination } from "@/lib/api/endpoints/destinations";
import type { Database } from "@/lib/api/endpoints/databases";
import { errorMessage } from "@/lib/api/error-message";

import { useBackupFiles } from "../use-database";
import { backupFileColumns } from "./backup-file-columns";
import { BucketPathField } from "./bucket-path-field";

/**
 * What is actually in the bucket.
 *
 * **This is the one half of backups that works**, and it is worth saying why it
 * is here at all when the schedules beside it are not: `GET /backups/files`
 * shells out to `rclone lsjson` against the destination, so it answers "what
 * dumps exist" without needing a `backup` row. The schedule that wrote them
 * cannot be listed; the files themselves can.
 *
 * It is also what makes the restore flow honest: a database restore picks a real
 * file that is really there. F10's volume restore had to ask for an object key
 * to be **typed** until
 * `GET /destinations/:id/objects` existed; both flows pick from a listing now.
 *
 * The search box is not a filter over the rows on screen. Everything up to the
 * **last slash** narrows the listing server-side and the rest matches the name,
 * so it is a path box that happens to filter — and the default is this
 * database's own prefix, which is where its dumps go
 * (`<appName>/<prefix>/<timestamp>`).
 */
export function BackupFilesCard({
  database,
  destinations,
  destinationsPending,
  destinationsError,
  destinationId,
  onDestinationChange,
  /** Offered per row when the restore flow can take it from here. */
  onRestore,
}: {
  database: Database;
  destinations: Destination[];
  destinationsPending: boolean;
  destinationsError: unknown;
  destinationId: string;
  onDestinationChange: (value: string) => void;
  onRestore?: (file: BackupFile) => void;
}) {
  const [search, setSearch] = useState(`${database.appName}/`);

  const files = useBackupFiles({
    destinationId,
    search,
    serverId: database.serverId,
    enabled: destinationId !== "",
  });

  /**
   * **Directories are rows, not noise.** Found by pointing this at a real
   * bucket: `rclone lsjson` is **not recursive**, so listing `<appName>/` when
   * the dumps live at `<appName>/<prefix>/<file>` returns one *directory* and
   * no files. Filtering directories out — which is what this did first — turned
   * a folder full of dumps into "Nothing here yet", which is the exact lie this
   * codebase keeps warning about: a confident claim about the bucket made
   * because of how the route happens to page.
   *
   * So a directory is a row you can open, and the search box is the path. That
   * also matches the route's own shape rather than fighting it.
   */
  const rows = [...(files.data ?? [])].sort((a, b) =>
    a.IsDir === b.IsDir ? 0 : a.IsDir ? -1 : 1,
  );

  /** Descend into a directory. Its `Path` is already relative to the bucket. */
  const open = (file: BackupFile) =>
    setSearch(file.Path.endsWith("/") ? file.Path : `${file.Path}/`);

  return (
    <Card>
      <Card.Header
        title="Dumps in the destination"
        sub="Read straight from the bucket, so this is what a restore can use."
        headingLevel={2}
        actions={
          destinationId !== "" ? (
            <Button
              size="xs"
              onClick={() => void files.refetch()}
              aria-busy={files.isFetching || undefined}
            >
              Refresh
            </Button>
          ) : null
        }
      />

      <Card.Body className="grid gap-3.5">
        <Field
          name="destinationId"
          label="Destination"
          manual
          hint="Destinations are managed for the whole Organization."
        >
          <Picker
            options={destinations.map((item) => ({
              value: item.destinationId,
              label: item.name,
              detail: item.bucket,
            }))}
            pending={destinationsPending}
            placeholder="Choose a destination"
            value={destinationId}
            onValueChange={onDestinationChange}
          />
        </Field>

        {/*
          A refusal and an empty list say different things, and conflating them
          is the easiest lie on this screen — F09 told it twice. A 403 on
          `GET /destinations` must never render "no destinations are connected",
          which is a claim about the Organization's setup made because a request
          failed.
        */}
        {destinationsError ? (
          <p className="text-body text-tx-2">
            {errorMessage(destinationsError)}
          </p>
        ) : !destinationsPending && destinations.length === 0 ? (
          <p className="text-body text-tx-2">
            <Link
              href="/settings/destinations"
              className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
            >
              Connect a destination
            </Link>{" "}
            — an S3-compatible bucket — before anything can be dumped to it or
            restored from it.
          </p>
        ) : destinationId === "" ? (
          <p className="text-body text-tx-2">
            Choose a destination to see what has been written to it.
          </p>
        ) : (
          <BucketPathField
            value={search}
            onChange={setSearch}
            appName={database.appName}
          />
        )}
      </Card.Body>

      {destinationId !== "" && !destinationsError ? (
        files.error ? (
          <Card.Body>
            <p className="text-body text-tx-2">{errorMessage(files.error)}</p>
          </Card.Body>
        ) : files.isPending ? (
          <Card.Body>
            <div className="grid gap-2.5" aria-busy="true">
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
            </div>
          </Card.Body>
        ) : (
          <Card.Body flush>
            <DataTable
              label={`Dumps under ${search} in the destination`}
              rows={rows}
              getRowId={(row) => row.Path}
              defaultSort={{ id: "name", dir: "desc" }}
              columns={backupFileColumns({ onOpen: open, onRestore })}
              empty={
                // Nothing under the path: nothing dumped there yet, a wrong
                // path, or a service this person cannot reach. The next move
                // is the same for all three.
                <EmptyState icon="hdd" title="Nothing here yet">
                  Clear the path to list every prefix in the bucket you can
                  reach. Nothing is under{" "}
                  <span className="font-mono wrap-anywhere">
                    {search || "the bucket root"}
                  </span>
                  .
                </EmptyState>
              }
            />
          </Card.Body>
        )
      ) : null}
    </Card>
  );
}
