import { DataTable, type Column } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { StatusPill } from "@/components/console/status-pill";
import type { ApplicationStatus } from "@/lib/api/endpoints/applications";
import {
  DATABASE_LABEL,
  type DatabaseKind,
} from "@/lib/api/endpoints/databases";
import { Icon, type IconName } from "@/lib/design/icons";

import { Dash } from "@/components/console/dash";

import { RowLink, RowSub, RowTime } from "./cells";

/**
 * A service, as a table row (e-console.html:2668-2694 — `svcRow` and `svcHead`).
 *
 * An Environment "owns the actual services — applications, databases, compose
 * stacks" (`CONTEXT.md`), and this is the one row shape all three take. The
 * vocabulary rule bans *service* as a synonym for **Application** — one
 * Application is never "a service" — which is a different sentence from naming
 * the mixed set, and the mixed set is what this is for.
 *
 * ## Why this is a view model and not a row type
 *
 * The three kinds have three different rows with three different id columns, three
 * different status columns (`applicationStatus`, `composeStatus`) and three
 * different ideas of where their source comes from. When this was written nothing
 * listed them either, so there was no response to type it against.
 *
 * **There is one now**: `GET /environments/:id` carries a `services` array
 * and
 * `EnvironmentService` in `endpoints/environments.ts` is the type. This stays a
 * view model regardless, because that array is a deliberate *projection* — eight
 * tables narrowed to the columns a summary can safely carry — and this table also
 * renders rows that never came from it: the fixtures in `/dev/rows`, and whatever a
 * screen holding a full service row wants to show that the summary leaves out.
 *
 * So `ServiceRow` is the shape the *table* needs, and F08, F11 and F12 each map
 * their own rows into it. That is what let the endpoint land without the table
 * changing at all. Every field past the first five is
 * optional, because which of them a kind has is exactly what differs — and an
 * absent one renders as "None" rather than as a blank cell.
 */

export type ServiceKind = "application" | DatabaseKind | "compose" | "bucket";

export type ServiceRow = {
  /** The service's own id, whatever its table calls it. */
  id: string;
  kind: ServiceKind;
  name: string;
  /** The Docker service name. Unique across the instance, and worth showing. */
  appName: string;
  /** Every kind's status column is the same `application_status` enum. */
  status: ApplicationStatus;
  /** Where this row goes — the mapper builds it, because only it knows the kind. */
  href: string;
  /** A branch, a tag or an image reference. A database has none. */
  source?: string | null;
  /** The first domain this answers on. A database has none. */
  domain?: string | null;
  replicas?: number | null;
  /** When its last Deployment finished — only the two kinds that have them. */
  lastDeployedAt?: string | null;
};

const KIND: Record<ServiceKind, { label: string; icon: IconName }> = {
  application: { label: "Application", icon: "box" },
  compose: { label: "Compose stack", icon: "layers" },
  postgres: { label: DATABASE_LABEL.postgres, icon: "db" },
  mysql: { label: DATABASE_LABEL.mysql, icon: "db" },
  mariadb: { label: DATABASE_LABEL.mariadb, icon: "db" },
  mongo: { label: DATABASE_LABEL.mongo, icon: "db" },
  redis: { label: DATABASE_LABEL.redis, icon: "db" },
  libsql: { label: DATABASE_LABEL.libsql, icon: "db" },
  // Holds files, runs nothing of its own.
  bucket: { label: "Bucket", icon: "hdd" },
};

/** What a service of this kind is called, for a heading or a sentence. */
export function serviceKindLabel(kind: ServiceKind): string {
  return KIND[kind].label;
}

export function serviceColumns(): Column<ServiceRow>[] {
  return [
    {
      id: "name",
      head: "Name",
      tone: "key",
      // A name is a label people choose, and before the cap nothing limited it:
      // a 300-character Application grew this column to ~2,700px and put
      // Type, Status and Created off-screen. It is capped at 100 now, which
      // still does not fit every row, so the column takes the width the others
      // leave and the name ends in an ellipsis, whole on its `title`.
      truncate: true,
      compare: (a, b) => a.name.localeCompare(b.name),
      cell: (row) => (
        <>
          <RowLink
            href={row.href}
            title={row.name}
            className="inline-block max-w-full truncate align-top"
          >
            {row.name}
          </RowLink>
          <RowSub mono>{row.appName}</RowSub>
        </>
      ),
    },
    {
      id: "kind",
      head: "Type",
      compare: (a, b) => KIND[a.kind].label.localeCompare(KIND[b.kind].label),
      cell: (row) => (
        <span className="flex items-center gap-1.75">
          <Icon name={KIND[row.kind].icon} size={14} className="text-tx-3" />
          {KIND[row.kind].label}
        </span>
      ),
    },
    {
      id: "status",
      head: "Status",
      compare: (a, b) => a.status.localeCompare(b.status),
      cell: (row) => <StatusPill status={row.status} />,
    },
    {
      id: "source",
      head: "Source",
      className: "font-mono",
      cell: (row) => row.source || <Dash />,
    },
    {
      id: "replicas",
      head: "Replicas",
      tone: "num",
      cell: (row) =>
        row.replicas === null || row.replicas === undefined ? (
          <Dash />
        ) : (
          row.replicas
        ),
    },
    {
      id: "domain",
      head: "Domain",
      className: "font-mono",
      cell: (row) => row.domain || <Dash />,
    },
    {
      id: "deployed",
      head: "Last deployment",
      compare: (a, b) =>
        (a.lastDeployedAt ?? "").localeCompare(b.lastDeployedAt ?? ""),
      cell: (row) => <RowTime iso={row.lastDeployedAt} />,
    },
    {
      id: "open",
      head: <span className="sr-only">Actions</span>,
      tone: "num",
      cell: (row) => <RowLink href={row.href}>Open</RowLink>,
    },
  ];
}

export type ServiceTableProps = {
  services: ServiceRow[];
  extraColumns?: Column<ServiceRow>[];
  selectable?: boolean;
  onSelectionChange?: (ids: string[]) => void;
  empty?: React.ReactNode;
  /** Names the table for a screen reader — "Services in production". */
  label?: string;
};

export function ServiceTable({
  services,
  extraColumns = [],
  selectable,
  onSelectionChange,
  empty,
  label = "Services",
}: ServiceTableProps) {
  return (
    <DataTable
      label={label}
      columns={[...serviceColumns(), ...extraColumns]}
      rows={services}
      getRowId={(row) => row.id}
      rowName={(row) => row.name}
      defaultSort={{ id: "name", dir: "asc" }}
      selectable={selectable}
      onSelectionChange={onSelectionChange}
      empty={
        empty ?? (
          <EmptyState icon="box" title="Nothing here yet">
            An Environment holds the things you deploy — Applications, databases
            and Compose stacks. Add the first one to get started.
          </EmptyState>
        )
      }
    />
  );
}
