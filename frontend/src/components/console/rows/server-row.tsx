import { DataTable, type Column } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { StatusPill } from "@/components/console/status-pill";
import type { Server } from "@/lib/api/endpoints/servers";
import { serverMark } from "@/lib/design/server-mark";

import { RowLink, RowSub, RowTime } from "./cells";

/**
 * A Server, as a table row (e-console.html:2630-2666 — `srvRow` and `srvHead`).
 *
 * **The head and the row are one declaration**, which is the one change from the
 * reference worth making: `srvRow` and `srvHead` are two functions with the same
 * column order written twice, and F04's `DataTable` takes columns instead. Insert
 * a column in one place and the header cannot end up over the wrong cell.
 *
 * Five of the reference's columns are **absent, not empty**: Origin, Region, Size
 * and Cost belong to the Terraform provisioning work, which has no backend at all
 * (`00-INDEX.md`, locked decision 1), and Services would need what runs on a
 * Server. Nothing answers that: an Environment names its own services and each one
 * carries a `serverId`,
 * but the question runs the other way, so filling this column means reading every
 * Environment in the Organization and grouping the result — for one column, on a
 * table of every Server. CPU needs the metrics gateway and arrives with F14. A
 * column of em dashes is not a column.
 *
 * Two things F13 may want and F07 deliberately leaves out: the reference's
 * **star** column (stars are read back by the rail's and the home page's
 * Starred lists, and the header is where a star is made; a second
 * toggle per row is its own decision, not a gap), and bulk selection, which
 * is `selectable` here and worth turning on only once there is an action to
 * apply to a selection.
 */

/** What each of the two `serverType` values is called in a table. */
const ROLE: Record<Server["serverType"], string> = {
  deploy: "Deploy",
  build: "Build",
};

export function serverColumns(): Column<Server>[] {
  return [
    {
      id: "name",
      head: "Server",
      tone: "key",
      compare: (a, b) => a.name.localeCompare(b.name),
      cell: (row) => (
        <>
          <RowLink href={`/servers/${row.serverId}`} className="wrap-anywhere">
            {row.name}
          </RowLink>
          {/* Capped at the reference's 260px (e-console.html:2641). Without it one
              Server's two-sentence description sets the width of the whole column
              and squeezes every other one — a table column is sized by its widest
              cell, and a description is the one cell with no natural limit. */}
          {row.description ? (
            <RowSub className="max-w-65">{row.description}</RowSub>
          ) : null}
        </>
      ),
    },
    {
      id: "status",
      head: "Status",
      // The last reach attempt, not the billing flag drawn as health.
      compare: (a, b) =>
        serverMark(a).label.localeCompare(serverMark(b).label),
      cell: (row) => <StatusPill mark={serverMark(row)} />,
    },
    {
      id: "address",
      head: "Address",
      className: "font-mono",
      // The SSH endpoint, which is the address an operator actually uses. The
      // port is part of it: a Server on 2222 is a different thing to reach.
      cell: (row) => `${row.ipAddress}:${row.port}`,
    },
    {
      id: "role",
      head: "Role",
      cell: (row) => ROLE[row.serverType],
    },
    {
      id: "user",
      head: "SSH user",
      className: "font-mono",
      cell: (row) => row.username,
    },
    {
      id: "added",
      head: "Added",
      compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
      cell: (row) => <RowTime iso={row.createdAt} />,
    },
    {
      id: "open",
      head: <span className="sr-only">Actions</span>,
      tone: "num",
      cell: (row) => <RowLink href={`/servers/${row.serverId}`}>Open</RowLink>,
    },
  ];
}

export type ServerTableProps = {
  servers: Server[];
  /** Appended after the shared columns — an owning screen's own actions. */
  extraColumns?: Column<Server>[];
  selectable?: boolean;
  onSelectionChange?: (ids: string[]) => void;
  /** Replaces the default invitation. Pass one with the "Add a Server" action. */
  empty?: React.ReactNode;
};

export function ServerTable({
  servers,
  extraColumns = [],
  selectable,
  onSelectionChange,
  empty,
}: ServerTableProps) {
  return (
    <DataTable
      label="Servers"
      columns={[...serverColumns(), ...extraColumns]}
      rows={servers}
      getRowId={(row) => row.serverId}
      rowName={(row) => row.name}
      defaultSort={{ id: "name", dir: "asc" }}
      selectable={selectable}
      onSelectionChange={onSelectionChange}
      empty={
        empty ?? (
          <EmptyState icon="hdd" title="No Servers yet">
            A Server is a machine Cloudgate deploys onto, reached over SSH. Add
            one and everything below it becomes deployable.
          </EmptyState>
        )
      }
    />
  );
}
