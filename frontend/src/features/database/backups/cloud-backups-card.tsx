import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/console/card";
import { DataTable, type Column } from "@/components/console/data-table";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Skeleton } from "@/components/console/skeleton";
import { LinkButton } from "@/components/console/link-button";
import {
  cloudBackupsApi,
  onGoogleCloud,
  type CloudBackups,
  type CloudDatabaseKind,
  type CloudSnapshot,
} from "@/lib/api/endpoints/cloud-backups";
import type { Database } from "@/lib/api/endpoints/databases";
import { errorMessage } from "@/lib/api/error-message";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { Icon } from "@/lib/design/icons";
import { timeAgo, timeExact } from "@/lib/format/time";

import { CloudRetentionCard } from "./cloud-retention-card";

/** The sentence the tab carries, and the backend's refusal of a dump Backup. */
export const SERVER_ONLY_DUMPS =
  "Dump backups to a Destination are Server-only for now.";

/** What RDS, ElastiCache, Cloud SQL or Memorystore holds, read live when the tab is shown. */
export function useCloudBackups(kind: CloudDatabaseKind, databaseId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.databases.cloudBackups(organizationId, kind, databaseId),
    queryFn: () => cloudBackupsApi.read(kind, databaseId),
    enabled: organizationId !== null && databaseId !== "",
    retry: false,
  });
}

/**
 * The Backups tab of a database in a Cloud account: its backups are the
 * provider's own, so the tab shows what AWS holds, read live — RDS's retention,
 * the window point-in-time restore reaches and its automatic and kept
 * snapshots; ElastiCache's snapshot retention and snapshots — and edits the
 * retention. A restore is made in the RDS console, which the tab links to:
 * there is no Restore button, because a restore makes a new instance rather
 * than writing over this one.
 *
 * On Google Cloud
 * the tab is the same: Cloud SQL's retention, point-in-time recovery's
 * window and its backups; Memorystore's retention and backups; each linked
 * to the Google Cloud console, with no Restore button.
 *
 * Dump backups to a Destination are Server-only for now, and the API
 * refuses one for a cloud database.
 */
export function CloudBackupsTab({
  row,
  kind,
}: {
  row: Database;
  kind: CloudDatabaseKind;
}) {
  const live = useCloudBackups(kind, row.databaseId);
  const data = live.data;
  const engine = data ? ENGINE_WORDS[data.engine] : null;

  return (
    <>
      <Card>
        <Card.Header
          title={engine ? `In ${engine.product}` : "Backups"}
          sub={`Read from ${engine?.cloud ?? "the cloud"} just now. ${SERVER_ONLY_DUMPS}`}
          headingLevel={2}
        />
        <Card.Body className="flex flex-col gap-4">
          {live.error ? (
            <p className="text-body text-tx-2">{errorMessage(live.error)}</p>
          ) : !data ? (
            <div className="grid gap-2.5" aria-busy="true">
              <Skeleton className="h-row" />
              <Skeleton className="h-row" />
            </div>
          ) : (
            <LiveBackups data={data} name={row.name} />
          )}
        </Card.Body>
      </Card>

      {data ? (
        <CloudRetentionCard
          // Remounted on a new saved value, so the form starts from it.
          key={data.retentionDays}
          row={row}
          kind={kind}
          engine={data.engine}
          retentionDays={data.retentionDays}
        />
      ) : null}
    </>
  );
}

/** How the tab names each engine, its cloud and its console. */
const ENGINE_WORDS: Record<
  CloudBackups["engine"],
  { product: string; cloud: string; console: string; items: string }
> = {
  rds: {
    product: "RDS",
    cloud: "AWS",
    console: "the RDS console",
    items: "Snapshots",
  },
  elasticache: {
    product: "ElastiCache",
    cloud: "AWS",
    console: "the ElastiCache console",
    items: "Snapshots",
  },
  "cloud-sql": {
    product: "Cloud SQL",
    cloud: "Google Cloud",
    console: "the Google Cloud console",
    items: "Backups",
  },
  memorystore: {
    product: "Memorystore",
    cloud: "Google Cloud",
    console: "the Google Cloud console",
    items: "Backups",
  },
};

function LiveBackups({ data, name }: { data: CloudBackups; name: string }) {
  const words = ENGINE_WORDS[data.engine];
  if (!data.made) {
    return (
      <p className="text-body text-tx-2">
        {words.cloud} has nothing to list yet: {name} is made by its first Cloud
        run.
      </p>
    );
  }
  const window = data.restorableWindow;
  const pending =
    data.liveRetentionDays !== null &&
    data.liveRetentionDays !== data.retentionDays;
  return (
    <>
      <KVList>
        <KVRow
          label="Retention"
          value={`${days(data.liveRetentionDays ?? 0)}${pending ? ` (${days(data.retentionDays)} after the next Cloud run)` : ""}`}
          title={`${days(data.liveRetentionDays ?? 0)}${pending ? ` (${days(data.retentionDays)} after the next Cloud run)` : ""}`}
        />
        {window ? (
          <>
            <KVRow
              label="Earliest restorable"
              value={timeAgo(window.earliest) ?? "No backup yet"}
              title={timeExact(window.earliest)}
            />
            <KVRow
              label="Latest restorable"
              value={timeAgo(window.latest) ?? "No backup yet"}
              title={timeExact(window.latest)}
            />
          </>
        ) : null}
        <KVRow
          label={`Name in ${words.cloud}`}
          value={data.identifier}
          title={data.identifier}
          mono
        />
        <KVRow label="Region" value={data.region} mono />
      </KVList>

      <DataTable
        label={`${words.items} of ${name}`}
        columns={SNAPSHOT_COLUMNS}
        rows={data.snapshots}
        getRowId={(snapshot) => snapshot.id}
        empty={
          <p className="text-body text-tx-2">
            {onGoogleCloud(data.engine)
              ? "No backups yet. Google Cloud takes the first in its daily backup window."
              : "No snapshots yet. AWS takes the first in its daily backup window."}
          </p>
        }
      />

      {data.consoleUrl ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-meta text-tx-2">
            A restore makes a new instance, in {words.console}.
          </p>
          <LinkButton
            href={data.consoleUrl}
            reload
            target="_blank"
            rel="noreferrer"
          >
            Open in {words.console}
            <Icon name="ext" size={13} className="text-tx-3" />
          </LinkButton>
        </div>
      ) : null}
    </>
  );
}

function days(count: number): string {
  if (count === 0) return "Off";
  return count === 1 ? "1 day" : `${count} days`;
}

const SNAPSHOT_COLUMNS: Column<CloudSnapshot>[] = [
  {
    id: "id",
    head: "Snapshot",
    cell: (snapshot) => <span title={snapshot.id}>{snapshot.id}</span>,
    tone: "key",
    truncate: true,
  },
  {
    id: "type",
    head: "Kind",
    cell: (snapshot) => (snapshot.type === "automated" ? "Automatic" : "Kept"),
  },
  {
    id: "createdAt",
    head: "Taken",
    cell: (snapshot) => (
      <span title={timeExact(snapshot.createdAt)}>
        {timeAgo(snapshot.createdAt) ?? "Being taken"}
      </span>
    ),
    tone: "muted",
  },
  {
    id: "status",
    head: "Status",
    cell: (snapshot) => snapshot.status,
    tone: "muted",
  },
  {
    id: "size",
    head: "Size",
    cell: (snapshot) => snapshot.size ?? "—",
    tone: "num",
  },
];
